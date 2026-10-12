"""How much an agent may spend without asking the person.

The person sets these in Settings > Preferences:

- ``runCostConfirmUsd``: the per-run threshold. Their own Run button asks
  them at or over it, and agents are held to it too.
- ``agentSpend.sessionUsd``: what one agent chat session may spend in total.
- ``agentSpend.models[<definitionId>]``: per-model limits, ``perRunUsd`` (it
  replaces the general per-run threshold for that model) and ``sessionUsd``.

Agents can't be asked, so the backend refuses an agent's run that would break
a limit and points it at a proposal, which the person accepts on the canvas.
These limits never stop the person's own runs; the canvas asks them itself.

Rules, with any limit set:

- A paid node without a list price needs a proposal, since its cost can't be
  checked.
- Per run: the estimate's upper bound at or over the limit needs a proposal,
  the same comparison the canvas makes (``shouldConfirmRunCost`` in
  frontend/src/lib/runScope.ts). Nodes with their own per-run limit are judged
  by it; the rest by the general threshold.
- Per session: a run that would take the session's total over a budget needs a
  proposal. A run is counted when it starts, at its upper bound, and the
  person's runs (including accepted proposals) aren't counted.

Runs billed to a signed-in Krea plan (``plan``) aren't per-call charges and
are neither limited nor counted, as on the canvas.

Nodes without a key for their provider aren't counted or limited either:
they fail before any provider call, so they can't cost anything
(``node_readiness.can_bill``).

Estimates cover every node the run includes, the same set the canvas prices.
Nodes whose outputs are cached may not run again, so this is an upper bound;
the cache can't be predicted before the run, because its keys depend on
upstream outputs, and it is lost on restart.
"""
from __future__ import annotations

import json
import math
import os
import threading
import time
from dataclasses import dataclass, field
from pathlib import Path
from typing import Any, Mapping

from services import model_pricing, node_readiness

SETTING_KEY = "runCostConfirmUsd"
CAPS_KEY = "agentSpend"
DEFAULT_THRESHOLD_USD = 1.0
MAX_SESSIONS = 500


# -- settings ----------------------------------------------------------------------

def validate_threshold(value: Any) -> float | None:
    """A positive finite number of USD, or None for no limit."""
    if value is None:
        return None
    if isinstance(value, bool) or not isinstance(value, (int, float)):
        raise ValueError("a spending limit must be a positive number of USD or null")
    amount = float(value)
    if not math.isfinite(amount) or amount <= 0:
        raise ValueError("a spending limit must be a positive number of USD or null")
    return amount


def threshold_from_settings(settings: Mapping[str, Any]) -> float | None:
    """The per-run threshold; None means never ask. A missing or unreadable
    value falls back to the default, like the canvas does."""
    if SETTING_KEY not in settings:
        return DEFAULT_THRESHOLD_USD
    try:
        return validate_threshold(settings.get(SETTING_KEY))
    except ValueError:
        return DEFAULT_THRESHOLD_USD


def validate_caps(value: Any, known_definitions: Mapping[str, Any]) -> dict[str, Any]:
    """Normalize ``agentSpend`` from a request; raise ValueError when it's malformed."""
    if not isinstance(value, dict):
        raise ValueError(f"{CAPS_KEY} must be an object")
    unknown = set(value) - {"sessionUsd", "models"}
    if unknown:
        raise ValueError(f"{CAPS_KEY} has unknown fields: {', '.join(sorted(unknown))}")
    models_in = value.get("models", {})
    if models_in is None:
        models_in = {}
    if not isinstance(models_in, dict):
        raise ValueError(f"{CAPS_KEY}.models must be an object keyed by node id")
    models: dict[str, dict[str, float | None]] = {}
    for definition_id, limits in models_in.items():
        if definition_id not in known_definitions:
            raise ValueError(f"{CAPS_KEY}.models names an unknown node: {str(definition_id)[:60]}")
        if not isinstance(limits, dict) or set(limits) - {"perRunUsd", "sessionUsd"}:
            raise ValueError(f"{CAPS_KEY}.models.{definition_id} takes perRunUsd and sessionUsd")
        entry = {key: validate_threshold(limits.get(key)) for key in ("perRunUsd", "sessionUsd")}
        if entry["perRunUsd"] is not None or entry["sessionUsd"] is not None:
            models[definition_id] = entry
    return {"sessionUsd": validate_threshold(value.get("sessionUsd")), "models": models}


def caps_from_settings(settings: Mapping[str, Any]) -> dict[str, Any]:
    """The saved agent limits; anything unreadable counts as unset."""
    raw = settings.get(CAPS_KEY)
    empty: dict[str, Any] = {"sessionUsd": None, "models": {}}
    if not isinstance(raw, dict):
        return empty
    try:
        session = validate_threshold(raw.get("sessionUsd"))
    except ValueError:
        session = None
    models: dict[str, dict[str, float | None]] = {}
    for definition_id, limits in (raw.get("models") or {}).items() if isinstance(raw.get("models"), dict) else []:
        if not isinstance(limits, dict):
            continue
        entry: dict[str, float | None] = {}
        for key in ("perRunUsd", "sessionUsd"):
            try:
                entry[key] = validate_threshold(limits.get(key))
            except ValueError:
                entry[key] = None
        if entry["perRunUsd"] is not None or entry["sessionUsd"] is not None:
            models[str(definition_id)] = entry
    return {"sessionUsd": session, "models": models}


# -- what a session has spent ------------------------------------------------------

@dataclass
class Spent:
    total: float = 0.0
    models: dict[str, float] = field(default_factory=dict)


class SpendLedger:
    """Running totals per agent session, kept in a small JSON file so a chat
    session's budget survives a restart."""

    def __init__(self, path: Path | None) -> None:
        self._path = path
        self._lock = threading.Lock()
        self._sessions: dict[str, dict[str, Any]] | None = None

    def _load(self) -> dict[str, dict[str, Any]]:
        if self._sessions is None:
            self._sessions = {}
            if self._path is not None and self._path.exists():
                try:
                    data = json.loads(self._path.read_text(encoding="utf-8"))
                    if isinstance(data, dict) and isinstance(data.get("sessions"), dict):
                        self._sessions = {str(k): v for k, v in data["sessions"].items() if isinstance(v, dict)}
                except (OSError, ValueError):
                    self._sessions = {}
        return self._sessions

    def spent(self, key: str) -> Spent:
        with self._lock:
            entry = self._load().get(key) or {}
        models = entry.get("models") if isinstance(entry.get("models"), dict) else {}
        return Spent(float(entry.get("total") or 0.0), {str(k): float(v) for k, v in models.items()})

    def record(self, key: str, label: str, by_model: Mapping[str, float]) -> None:
        if not by_model:
            return
        with self._lock:
            sessions = self._load()
            entry = sessions.pop(key, None) or {"agent": label, "total": 0.0, "models": {}}
            for definition_id, amount in by_model.items():
                entry["models"][definition_id] = round(entry["models"].get(definition_id, 0.0) + amount, 6)
                entry["total"] = round(entry["total"] + amount, 6)
            entry["agent"] = label
            entry["updated"] = time.time()
            sessions[key] = entry  # most recent last
            while len(sessions) > MAX_SESSIONS:
                sessions.pop(next(iter(sessions)))
            self._save(sessions)

    def _save(self, sessions: Mapping[str, Any]) -> None:
        if self._path is None:
            return
        self._path.parent.mkdir(parents=True, exist_ok=True)
        tmp = self._path.with_suffix(".tmp")
        tmp.write_text(json.dumps({"sessions": sessions}), encoding="utf-8")
        os.replace(tmp, self._path)


# -- the decision ------------------------------------------------------------------

@dataclass
class Decision:
    refusal: str | None
    charge: dict[str, float]  # upper-bound USD per node definition, to record if the run goes ahead


def _usd(amount: float) -> str:
    return f"${amount:,.2f}" if amount >= 0.01 or amount == 0 else f"${amount:.3f}"


def _names(ids: list[str], labels: Mapping[str, str]) -> str:
    def name(node_id: str) -> str:
        label = labels.get(node_id)
        if not label:
            return node_id
        # Ids starting with "_" are internal (nebula quick's temporary nodes).
        return label if node_id.startswith("_") else f"{node_id} ({label})"
    shown = [name(node_id) for node_id in ids[:4]]
    return ", ".join(shown) + (f" and {len(ids) - 4} more" if len(ids) > 4 else "")


def decide(
    items: list[Mapping[str, Any]],
    edges: list[tuple[str, str]],
    *,
    settings: Mapping[str, Any],
    pricing: Mapping[str, Any],
    definitions: Mapping[str, Mapping[str, Any]],
    spent: Spent,
    how_to_ask: str,
) -> Decision:
    """Whether an agent may start this run itself, and what it would cost.

    ``items`` are the nodes the run includes, each {id, definitionId, params};
    ``edges`` are (source, target) pairs between them; ``spent`` is what this
    agent's session has already been charged. ``how_to_ask`` is the sentence
    that tells the agent what to do instead."""
    threshold = threshold_from_settings(settings)
    caps = caps_from_settings(settings)
    model_caps: Mapping[str, Mapping[str, float | None]] = caps["models"]
    api_keys = settings.get("apiKeys") or {}
    multipliers = model_pricing.run_multipliers(list(items), edges)
    estimate = model_pricing.estimate_run(list(items), pricing, definitions, api_keys, multipliers)
    # A node with no key for its provider fails before any provider call, so
    # it can't spend: it neither counts against a budget nor needs approval.
    keys = node_readiness.configured_keys(settings)
    keyless = {str(item["id"]) for item in items
               if not node_readiness.can_bill(definitions.get(str(item.get("definitionId") or "")) or {},
                                              item.get("params") or {}, keys)}
    if keyless:
        estimate = {**estimate,
                    "priced": {k: v for k, v in estimate["priced"].items() if k not in keyless},
                    "unpriced": [k for k in estimate["unpriced"] if k not in keyless]}
    definition_of = {str(item["id"]): str(item.get("definitionId") or "") for item in items}
    labels = {node_id: str((definitions.get(def_id) or {}).get("displayName") or "") for node_id, def_id in definition_of.items()}

    by_model: dict[str, float] = {}
    for node_id, line in estimate["priced"].items():
        def_id = definition_of.get(node_id, "")
        by_model[def_id] = by_model.get(def_id, 0.0) + line["high"]

    def refuse(reason: str) -> Decision:
        return Decision(f"Needs the person's approval: {reason} {how_to_ask}", by_model)

    limited = (threshold is not None or caps["sessionUsd"] is not None
               or any(v is not None for limits in model_caps.values() for v in limits.values()))
    if not limited:
        return Decision(None, by_model)

    if estimate["unpriced"]:
        return refuse(f"Nebula has no list price for {_names(estimate['unpriced'], labels)}, "
                      "so it can't check this run against the spending limits set in Nebula Settings.")

    # Per run: each model with its own limit, then everything else against the general one.
    for def_id, amount in sorted(by_model.items(), key=lambda kv: -kv[1]):
        cap = (model_caps.get(def_id) or {}).get("perRunUsd")
        if cap is not None and amount >= cap:
            name = (definitions.get(def_id) or {}).get("displayName") or def_id
            return refuse(f"this run's {name} nodes could cost up to {_usd(amount)}, at or over the "
                          f"{_usd(cap)} per-run limit for {name} in Nebula Settings.")
    general = sum(amount for def_id, amount in by_model.items() if (model_caps.get(def_id) or {}).get("perRunUsd") is None)
    if threshold is not None and general > 0 and general >= threshold:
        priced = sorted((node_id for node_id in estimate["priced"]
                         if (model_caps.get(definition_of.get(node_id, "")) or {}).get("perRunUsd") is None),
                        key=lambda node_id: -estimate["priced"][node_id]["high"])
        return refuse(f"this run could cost up to {_usd(general)} (mostly {_names(priced[:2], labels)}), "
                      f"at or over the {_usd(threshold)} per-run limit set in Nebula Settings.")

    # Per session.
    run_total = sum(by_model.values())
    budget = caps["sessionUsd"]
    if budget is not None and run_total > 0 and spent.total + run_total > budget:
        return refuse(f"this run could cost up to {_usd(run_total)}, and this session has already used "
                      f"{_usd(spent.total)} of its {_usd(budget)} budget set in Nebula Settings.")
    for def_id, amount in by_model.items():
        model_budget = (model_caps.get(def_id) or {}).get("sessionUsd")
        used = spent.models.get(def_id, 0.0)
        if model_budget is not None and amount > 0 and used + amount > model_budget:
            name = (definitions.get(def_id) or {}).get("displayName") or def_id
            return refuse(f"this run's {name} nodes could cost up to {_usd(amount)}, and this session has "
                          f"already used {_usd(used)} of its {_usd(model_budget)} {name} budget set in Nebula Settings.")
    return Decision(None, by_model)


def propose_hint(run_ids: list[str]) -> str:
    """The sentence pointing an agent at a proposal for these canvas nodes."""
    targets = " ".join(f"--run {node_id}" for node_id in run_ids[:6]) or "--run <node>"
    return (
        f"Propose it instead: `nebula propose --note \"<why>\" {targets}` "
        "(MCP: propose_change). The person accepts on the canvas, and the canvas runs it."
    )
