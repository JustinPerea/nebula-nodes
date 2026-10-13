"""How much an agent may spend without asking the person.

The person sets these in Settings > Preferences:

- ``runCostConfirmUsd``: the per-run threshold. Their own Run button asks
  them at or over it, and agents are held to it too.
- ``agentSpend.sessionUsd``: what one agent chat session may spend in total.
  Each in-app chat (Claude or Codex) is its own session: the turn
  token its Nebula MCP server sends names the chat (``main._spend_session``).
- ``agentSpend.outsideDailyUsd``: what every agent without a Nebula chat
  (Claude Desktop, terminal tools, scripts) may spend together over the last
  24 hours. Left unset, it is the per-session budget, so adding it never made
  anything looser.
- ``agentSpend.kreaPlanRuns``: how many runs one chat session, or the outside
  agents together over 24 hours, may bill to the signed-in Krea plan. Left
  unset it is DEFAULT_PLAN_RUNS; only the person's explicit null ("No
  limit") lifts it, and an unreadable value is 0 (every plan run asks).
- ``agentSpend.models[<definitionId>]``: per-model limits, ``perRunUsd`` (it
  replaces the general per-run threshold for that model) and ``sessionUsd``
  (per chat session, and over 24 hours for the outside agents).

Agents can't be asked, so the backend refuses an agent's run that would break
a limit and points it at a proposal, which the person accepts on the canvas.
These limits never stop the person's own runs; the canvas asks them itself.
"The person" means a request with this launch's person token and no agent
marker (services/person_gate.py), not one with a browser Origin, which any
local program can write. Everyone else, including a canvas tab opened without
the person link, is held to these limits.

Whose total a run counts against (``main._spend_session``):

- ``chat:<session>``: an in-app chat, named by the token Nebula minted for it.
- ``outside:shared``: every other caller. Names and headers are the caller's
  to set, so they can't buy a fresh budget, and the key never changes, so
  restarting Nebula doesn't reset it either.
- ``outside:personal:<agentId>``: one of the person's own agents (Claude,
  Codex, Gemini or a custom ACP agent) started from the chat panel
  (services/acp_session.py). It is an outside agent: its runs count in the
  shared outside budget, with a line per agent in Settings.
  ``PERSONAL_AGENT_BUDGET = "chat"`` switches it to a per-chat ``chat:`` key.
- ``outside:app:<id>``: an outside app the person gave its own token in
  Settings (services/app_tokens.py). The app's own daily limit applies, and
  its runs also count inside the outside budget: both are checked and the
  stricter wins, so issuing tokens never adds headroom.

Outside totals are rolling: each run is an event with its time, and only the
last 24 hours count (``WINDOW_SECONDS``). A give-back lands at the time of the
run it gives back, so it never reaches into a later window.

Rules, with any limit set:

- A paid node without a list price needs a proposal, since its cost can't be
  checked.
- Per run: the estimate's upper bound at or over the limit needs a proposal,
  the same comparison the canvas makes (``shouldConfirmRunCost`` in
  frontend/src/lib/runScope.ts). Nodes with their own per-run limit are judged
  by it; the rest by the general threshold.
- Per budget: a run that would take a total over a budget needs a proposal. A
  run is counted when it starts, at its upper bound, and the person's runs
  (including accepted proposals) aren't counted.

An accepted proposal's run is the person's, so it isn't held to these limits;
what makes that safe is that Accept approves values, not node ids
(services/run_approvals.py). Agents can't change those nodes until the canvas
starts the run, and the backend refuses the run if anything in it changed
since Accept.

Runs billed to a signed-in Krea plan (``plan``) have no per-call USD price:
Krea charges compute units it doesn't publish per model. They are counted as
runs instead (times a node's batch runs, shots and passes) against
``kreaPlanRuns``, and always counted even with no limit set. Agents can't move
a node onto the plan themselves: changing ``_kreaAuth`` takes a proposal
(``main._refuse_agent_krea_billing_change``). That holds on every way in: the
edit routes, project snapshots, and the run routes, which take params in the
request (a run may only bill a node the way its canvas node does, and a node
that exists only for the run starts on the API token).

A cinema scene is a local node that calls its base image model once per
shot, so it is priced, limited and counted as that model, times its shots
(``model_pricing.cinema_scene_base``). A shot request with variations runs
the whole subgraph once per variation with the cache off, so it is counted
once per variation (``passes``).

The Video QC nodes are local too, but in any mode other than heuristic or
opencv (vision-llm, or a value the handler would refuse) they call a vision
model with the first of ANTHROPIC_API_KEY, OPENAI_API_KEY and GOOGLE_API_KEY
that is set (the definition's ``providerVia``). Nebula has no list price for
that, so such a run is unpriced: with any limit set it needs a proposal, as
for any other paid node without one. Heuristic and opencv runs stay free.

A priced setting that arrives by wire (Krea Kling 3.0's ``multi_prompt``
port) is only known at run time, so that node is unpriced too
(``model_pricing.wired_ports``).

Nodes that made no provider request get their share of the count back, since
they can't have cost anything:

- a node that fails at its own key check (``execution.missing_credential``),
  given back when the run reports it;
- a node that never reached its handler (answered from the cache, held back
  by an upstream failure, or the run stopped first), given back when the run
  ends (``execution.provider_calls``, ``main._settle_hold``).

A node whose handler was called stays counted, even if it then failed or was
stopped: a request may already have gone out.

The limits themselves are still checked up front on the whole estimate.
What the cache will skip can only be known by running: cache keys depend on
upstream outputs, and the cache is lost on restart. Which key a handler
finds is fixed before that: every run route reads settings once and gives
the same snapshot to this check and to the run (``main._require_spend_approval``
takes it), so the route priced is the route billed.
"""
from __future__ import annotations

import json
import math
import os
import threading
import time
from dataclasses import dataclass, field
from pathlib import Path
from typing import Any, Callable, Mapping

from services import model_pricing

SETTING_KEY = "runCostConfirmUsd"
CAPS_KEY = "agentSpend"
DEFAULT_THRESHOLD_USD = 1.0
MAX_SESSIONS = 500
MAX_PLAN_RUNS = 100_000
# Plan runs per chat, or for the outside agents over 24 hours, until the
# person picks a number (or "No limit") in Settings.
DEFAULT_PLAN_RUNS = 10

WINDOW_SECONDS = 24 * 60 * 60
OUTSIDE_PREFIX = "outside:"
OUTSIDE_SHARED = "outside:shared"
OUTSIDE_LABEL = "Agents outside Nebula chats"
APP_PREFIX = "outside:app:"
# The person's own agents run over ACP in the chat panel
# (services/acp_session.py). Their spend counts inside the shared outside
# budget under one key per agent, so Settings can still show a line each.
PERSONAL_AGENT_PREFIX = "outside:personal:"
# The single switch: "outside" (default) puts personal agents in the shared
# 24h outside budget; "chat" gives each personal chat its own session budget
# (key ``chat:<chat id>``) like the in-app Claude and Codex chats.
PERSONAL_AGENT_BUDGET = "outside"
# Keys from before the outside budget had a stable name: one per backend
# launch. Folded into OUTSIDE_SHARED once (SpendLedger._migrate).
_LEGACY_PREFIX = "unverified:"


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


def validate_plan_runs(value: Any) -> int | None:
    """A whole number of runs from 0 (every plan run needs a proposal) up, or
    None for no limit."""
    if value is None:
        return None
    if isinstance(value, bool) or not isinstance(value, int) or not 0 <= value <= MAX_PLAN_RUNS:
        raise ValueError(f"{CAPS_KEY}.kreaPlanRuns must be a whole number of runs from 0 to {MAX_PLAN_RUNS}, or null")
    return value


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
    """Normalize ``agentSpend`` from a request; raise ValueError when it's malformed.

    ``outsideDailyUsd`` and ``kreaPlanRuns`` are kept only when the request
    names them: left out, the outside agents share the per-session amount and
    plan runs are held to DEFAULT_PLAN_RUNS (see caps_from_settings)."""
    if not isinstance(value, dict):
        raise ValueError(f"{CAPS_KEY} must be an object")
    unknown = set(value) - {"sessionUsd", "outsideDailyUsd", "kreaPlanRuns", "models"}
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
    caps: dict[str, Any] = {"sessionUsd": validate_threshold(value.get("sessionUsd"))}
    if "outsideDailyUsd" in value:
        caps["outsideDailyUsd"] = validate_threshold(value["outsideDailyUsd"])
    if "kreaPlanRuns" in value:
        caps["kreaPlanRuns"] = validate_plan_runs(value["kreaPlanRuns"])
    caps["models"] = models
    return caps


def caps_from_settings(settings: Mapping[str, Any]) -> dict[str, Any]:
    """The saved agent limits; anything unreadable counts as unset, except an
    unreadable outside budget, which falls back to the per-session one, and
    plan runs: unset is DEFAULT_PLAN_RUNS and unreadable is 0 (every plan run
    needs a proposal). Krea doesn't price plan runs, so no USD limit stands
    behind them; only an explicit null (the person's "No limit") lifts it."""
    if CAPS_KEY not in settings:
        return {"sessionUsd": None, "outsideDailyUsd": None, "kreaPlanRuns": DEFAULT_PLAN_RUNS, "models": {}}
    raw = settings.get(CAPS_KEY)
    if not isinstance(raw, dict):
        return {"sessionUsd": None, "outsideDailyUsd": None, "kreaPlanRuns": 0, "models": {}}
    try:
        session = validate_threshold(raw.get("sessionUsd"))
    except ValueError:
        session = None
    outside = session
    if "outsideDailyUsd" in raw:
        try:
            outside = validate_threshold(raw.get("outsideDailyUsd"))
        except ValueError:
            outside = session
    plan_runs: int | None = DEFAULT_PLAN_RUNS
    if "kreaPlanRuns" in raw:
        try:
            plan_runs = validate_plan_runs(raw["kreaPlanRuns"])
        except ValueError:
            plan_runs = 0
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
    return {"sessionUsd": session, "outsideDailyUsd": outside, "kreaPlanRuns": plan_runs, "models": models}


# -- what a session has spent ------------------------------------------------------

@dataclass
class Spent:
    total: float = 0.0
    models: dict[str, float] = field(default_factory=dict)
    plan_runs: int = 0


def is_outside(key: str) -> bool:
    return key.startswith(OUTSIDE_PREFIX)


def personal_agent_spend_key(agent_id: str, chat_id: str) -> str:
    """The budget a personal agent's session token names (see PERSONAL_AGENT_BUDGET)."""
    if PERSONAL_AGENT_BUDGET == "chat":
        return f"chat:{chat_id}"
    return f"{PERSONAL_AGENT_PREFIX}{agent_id}"


class SpendLedger:
    """Totals per agent session, kept in a small JSON file so budgets survive
    a restart.

    A chat key keeps running totals: {agent, total, models, planRuns}. An
    outside key keeps events, [time, definitionId, usd, planRuns], and counts
    only the last 24 hours of them; events older than that are dropped on save."""

    def __init__(self, path: Path | None, *, clock: Callable[[], float] = time.time) -> None:
        self._path = path
        self._clock = clock
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
            if self._migrate(self._sessions):
                self._save(self._sessions)
        return self._sessions

    def _migrate(self, sessions: dict[str, dict[str, Any]]) -> bool:
        """Fold the per-launch budgets older versions kept for agents without a
        chat token into the outside budget, once. Anything updated in the last
        24 hours counts as spent at that time (it was spent then or earlier,
        so this can only overcount); older totals are dropped."""
        legacy = [key for key in sessions if key.startswith(_LEGACY_PREFIX)]
        if not legacy:
            return False
        since = self._clock() - WINDOW_SECONDS
        shared = sessions.get(OUTSIDE_SHARED)
        if not isinstance(shared, dict) or not isinstance(shared.get("events"), list):
            shared = {"agent": OUTSIDE_LABEL, "events": []}
        for key in legacy:
            entry = sessions.pop(key)
            try:
                at = float(entry.get("updated") or 0)
                total = float(entry.get("total") or 0)
                models = {str(k): float(v) for k, v in (entry.get("models") or {}).items()}
            except (TypeError, ValueError, AttributeError):
                # Unreadable: count it as spent now at whatever total it shows.
                at, models = self._clock(), {}
                try:
                    total = float(entry.get("total") or 0)
                except (TypeError, ValueError, AttributeError):
                    total = 0.0
            if at <= since:
                continue
            for definition_id, amount in models.items():
                if amount > 0:
                    shared["events"].append([at, definition_id, round(amount, 6), 0])
            rest = round(total - sum(amount for amount in models.values() if amount > 0), 6)
            if rest > 0:
                shared["events"].append([at, "", rest, 0])
        if shared["events"]:
            shared["updated"] = self._clock()
            sessions[OUTSIDE_SHARED] = shared
        return True

    @staticmethod
    def _events(entry: Mapping[str, Any]) -> list[list[Any]]:
        events = entry.get("events")
        if not isinstance(events, list):
            return []

        def readable(event: Any) -> bool:
            return (isinstance(event, list) and len(event) == 4 and isinstance(event[1], str)
                    and all(isinstance(value, (int, float)) and not isinstance(value, bool)
                            and math.isfinite(value) for value in (event[0], event[2], event[3])))
        return [event for event in events if readable(event)]

    def _sum(self, events: list[list[Any]]) -> Spent:
        since = self._clock() - WINDOW_SECONDS
        total = 0.0
        runs = 0
        models: dict[str, float] = {}
        for at, definition_id, amount, plan_runs in events:
            if float(at) <= since:
                continue
            total += float(amount)
            runs += int(plan_runs)
            if amount:
                models[str(definition_id)] = models.get(str(definition_id), 0.0) + float(amount)
        return Spent(max(0.0, round(total, 6)),
                     {k: round(v, 6) for k, v in models.items() if round(v, 6) > 0 and k},
                     max(0, runs))

    def spent(self, key: str) -> Spent:
        with self._lock:
            entry = self._load().get(key) or {}
            if is_outside(key):
                return self._sum(self._events(entry))
        models = entry.get("models") if isinstance(entry.get("models"), dict) else {}
        return Spent(float(entry.get("total") or 0.0), {str(k): float(v) for k, v in models.items()},
                     int(entry.get("planRuns") or 0))

    def spent_outside(self) -> Spent:
        """Everything every outside agent (shared or with an app token) spent in the last 24 hours."""
        with self._lock:
            events = [event for key, entry in self._load().items() if is_outside(key) for event in self._events(entry)]
            return self._sum(events)

    def record(self, key: str, label: str, by_model: Mapping[str, float],
               plan_runs: Mapping[str, int] | None = None) -> float:
        """Count a run that is starting; returns its time, which a give-back passes as ``at``."""
        now = self._clock()
        plan_runs = {k: v for k, v in (plan_runs or {}).items() if v}
        if not by_model and not plan_runs:
            return now
        with self._lock:
            sessions = self._load()
            if is_outside(key):
                entry = sessions.pop(key, None) or {"agent": label, "events": []}
                events = self._events(entry)
                for definition_id in set(by_model) | set(plan_runs):
                    events.append([now, definition_id, round(by_model.get(definition_id, 0.0), 6),
                                   int(plan_runs.get(definition_id, 0))])
                entry["events"] = events
            else:
                entry = sessions.pop(key, None) or {"agent": label, "total": 0.0, "models": {}}
                for definition_id, amount in by_model.items():
                    entry["models"][definition_id] = round(entry["models"].get(definition_id, 0.0) + amount, 6)
                    entry["total"] = round(entry["total"] + amount, 6)
                entry["planRuns"] = int(entry.get("planRuns") or 0) + sum(plan_runs.values())
            entry["agent"] = label
            entry["updated"] = now
            sessions[key] = entry  # most recent last
            chats = [k for k in sessions if not is_outside(k)]
            # Outside keys are never dropped for room: one per app plus the
            # shared one, and saving prunes their old events.
            for dropped in chats[:max(0, len(chats) - MAX_SESSIONS)]:
                sessions.pop(dropped)
            self._save(sessions)
        return now

    def refund(self, key: str, by_model: Mapping[str, float], plan_runs: Mapping[str, int] | None = None,
               *, at: float | None = None) -> None:
        """Give back part of what record() counted, for nodes that couldn't have
        spent it. On an outside key it lands at ``at``, the run's own time; with
        no time it gives nothing back, rather than guess a window."""
        plan_runs = {k: v for k, v in (plan_runs or {}).items() if v}
        with self._lock:
            sessions = self._load()
            entry = sessions.get(key)
            if entry is None:
                return
            if is_outside(key):
                if at is None:
                    return
                events = self._events(entry)
                for definition_id in set(by_model) | set(plan_runs):
                    events.append([at, definition_id, -round(by_model.get(definition_id, 0.0), 6),
                                   -int(plan_runs.get(definition_id, 0))])
                entry["events"] = events
            else:
                for definition_id, amount in by_model.items():
                    left = round(entry["models"].get(definition_id, 0.0) - amount, 6)
                    if left > 0:
                        entry["models"][definition_id] = left
                    else:
                        entry["models"].pop(definition_id, None)
                    entry["total"] = max(0.0, round(entry["total"] - amount, 6))
                entry["planRuns"] = max(0, int(entry.get("planRuns") or 0) - sum(plan_runs.values()))
            entry["updated"] = self._clock()
            self._save(sessions)

    def _save(self, sessions: dict[str, Any]) -> None:
        since = self._clock() - WINDOW_SECONDS
        for key in [k for k in sessions if is_outside(k)]:
            kept = [event for event in self._events(sessions[key]) if float(event[0]) > since]
            if kept:
                sessions[key]["events"] = kept
            else:
                sessions.pop(key)
        if self._path is None:
            return
        self._path.parent.mkdir(parents=True, exist_ok=True)
        tmp = self._path.with_suffix(".tmp")
        tmp.write_text(json.dumps({"sessions": sessions}), encoding="utf-8")
        os.replace(tmp, self._path)


# -- the decision ------------------------------------------------------------------

@dataclass
class Budget:
    """One total a run counts against, and its limits.

    ``who`` names it in a refusal ("this session", "agents outside Nebula
    chats"); ``window`` follows the amount (" in the last 24 hours");
    ``model_caps`` says whether the per-model session limits apply to it."""
    who: str
    spent: Spent
    usd: float | None
    plan_runs: int | None = None
    model_caps: bool = True
    plural: bool = False
    window: str = ""
    noun: str = "budget"

    def _has(self) -> str:
        return f"{self.who} {'have' if self.plural else 'has'} already used"

    def _its(self) -> str:
        return "their" if self.plural else "its"


def session_budgets(key: str, spent: Spent, caps: Mapping[str, Any], *, outside_spent: Spent | None = None,
                    app_name: str | None = None, app_daily_usd: float | None = None) -> list[Budget]:
    """The budgets a run from ``key`` counts against (see the module docstring)."""
    if not is_outside(key):
        return [Budget("this session", spent, caps.get("sessionUsd"), caps.get("kreaPlanRuns"))]
    window = " in the last 24 hours"
    shared = Budget("agents outside Nebula chats", outside_spent if outside_spent is not None else spent,
                    caps.get("outsideDailyUsd"), caps.get("kreaPlanRuns"), plural=True, window=window)
    if not key.startswith(APP_PREFIX):
        return [shared]
    own = Budget(app_name or "this app", spent, app_daily_usd, None, model_caps=False, window=window,
                 noun="daily limit")
    return [own, shared]


@dataclass
class Decision:
    refusal: str | None
    charge: dict[str, float]  # upper-bound USD per node definition, to record if the run goes ahead
    per_node: dict[str, tuple[str, float]] = field(default_factory=dict)  # node id -> (definition, USD)
    plan_charge: dict[str, int] = field(default_factory=dict)  # Krea plan runs per node definition
    plan_per_node: dict[str, tuple[str, int]] = field(default_factory=dict)  # node id -> (definition, runs)


def _usd(amount: float) -> str:
    return f"${amount:,.2f}" if amount >= 0.01 or amount == 0 else f"${amount:.3f}"


def _runs(count: int) -> str:
    return f"{count} run{'' if count == 1 else 's'}"


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
    edges: list[tuple[str, str, str | None]],
    *,
    settings: Mapping[str, Any],
    pricing: Mapping[str, Any],
    definitions: Mapping[str, Mapping[str, Any]],
    spent: Spent | None = None,
    budgets: list[Budget] | None = None,
    how_to_ask: str,
    passes: int = 1,
) -> Decision:
    """Whether an agent may start this run itself, and what it would cost.

    ``items`` are the nodes the run includes, each {id, definitionId, params};
    ``edges`` are the run's (source, target, target handle) edges: they set
    fan-out, and a priced setting that arrives by wire leaves its node
    unpriced. ``settings`` must be the snapshot whose ``apiKeys`` the run
    itself receives, so the route priced is the route billed. ``budgets`` are the
    totals the caller counts against (session_budgets); without them, ``spent``
    is a chat session's total, held to the per-session limits. ``how_to_ask``
    is the sentence that tells the agent what to do instead. ``passes`` is how
    many times the request runs these nodes, uncached (a cinema shot's
    variations)."""
    if isinstance(passes, bool) or not isinstance(passes, int) or passes < 1:
        raise ValueError("passes must be a positive whole number")
    threshold = threshold_from_settings(settings)
    caps = caps_from_settings(settings)
    model_caps: Mapping[str, Mapping[str, float | None]] = caps.get("models") or {}
    if budgets is None:
        budgets = session_budgets("chat:", spent or Spent(), caps)
    api_keys = settings.get("apiKeys") or {}
    multipliers = model_pricing.run_multipliers(list(items), [(source, target) for source, target, _ in edges])
    estimate = model_pricing.estimate_run(list(items), pricing, definitions, api_keys, multipliers,
                                          model_pricing.wired_ports(list(items), edges))
    definition_of = {str(item["id"]): str(item.get("definitionId") or "") for item in items}
    labels = {node_id: str((definitions.get(def_id) or {}).get("displayName") or "") for node_id, def_id in definition_of.items()}

    by_model: dict[str, float] = {}
    per_node: dict[str, tuple[str, float]] = {}
    billed_as: dict[str, str] = {}
    for node_id, line in estimate["priced"].items():
        # Counted against the model billed: a cinema scene's shots are its base model's.
        def_id = line.get("model") or definition_of.get(node_id, "")
        billed_as[str(node_id)] = def_id
        amount = line["high"] * passes
        by_model[def_id] = by_model.get(def_id, 0.0) + amount
        per_node[str(node_id)] = (def_id, amount)
    plan_charge: dict[str, int] = {}
    plan_per_node: dict[str, tuple[str, int]] = {}
    for node_id, line in (estimate.get("planRuns") or {}).items():
        def_id, count = str(line["model"]), int(line["runs"]) * passes
        plan_charge[def_id] = plan_charge.get(def_id, 0) + count
        plan_per_node[str(node_id)] = (def_id, count)

    def decision(refusal: str | None) -> Decision:
        return Decision(refusal, by_model, per_node, plan_charge, plan_per_node)

    def refuse(reason: str) -> Decision:
        return decision(f"Needs the person's approval: {reason} {how_to_ask}")

    # Plan-run limits stand on their own: a Krea plan cap (on by default)
    # doesn't make unpriced nodes need a proposal when no USD limit is set.
    usd_limited = (threshold is not None
                   or any(budget.usd is not None for budget in budgets)
                   or any(v is not None for limits in model_caps.values() for v in limits.values()))
    if not usd_limited and not any(budget.plan_runs is not None for budget in budgets):
        return decision(None)

    if usd_limited and estimate["unpriced"]:
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
                         if (model_caps.get(billed_as.get(str(node_id), "")) or {}).get("perRunUsd") is None),
                        key=lambda node_id: -estimate["priced"][node_id]["high"])
        return refuse(f"this run could cost up to {_usd(general)} (mostly {_names(priced[:2], labels)}), "
                      f"at or over the {_usd(threshold)} per-run limit set in Nebula Settings.")

    # Per budget: every total this run counts against.
    run_total = sum(by_model.values())
    run_plan = sum(plan_charge.values())
    for budget in budgets:
        used = budget.spent
        if budget.usd is not None and run_total > 0 and used.total + run_total > budget.usd:
            return refuse(f"this run could cost up to {_usd(run_total)}, and {budget._has()} "
                          f"{_usd(used.total)} of {budget._its()} {_usd(budget.usd)} {budget.noun}{budget.window} "
                          "set in Nebula Settings.")
        if budget.model_caps:
            for def_id, amount in by_model.items():
                model_budget = (model_caps.get(def_id) or {}).get("sessionUsd")
                model_used = used.models.get(def_id, 0.0)
                if model_budget is not None and amount > 0 and model_used + amount > model_budget:
                    name = (definitions.get(def_id) or {}).get("displayName") or def_id
                    return refuse(f"this run's {name} nodes could cost up to {_usd(amount)}, and {budget._has()} "
                                  f"{_usd(model_used)} of {budget._its()} {_usd(model_budget)} {name} budget"
                                  f"{budget.window} set in Nebula Settings.")
        if budget.plan_runs is not None and run_plan > 0 and used.plan_runs + run_plan > budget.plan_runs:
            return refuse(f"this run bills {_runs(run_plan)} to the signed-in Krea plan, and {budget._has()} "
                          f"{_runs(used.plan_runs)} of {budget._its()} {budget.plan_runs}-run Krea plan limit"
                          f"{budget.window} set in Nebula Settings.")
    return decision(None)


def propose_hint(run_ids: list[str]) -> str:
    """The sentence pointing an agent at a proposal for these canvas nodes."""
    targets = " ".join(f"--run {node_id}" for node_id in run_ids[:6]) or "--run <node>"
    return (
        f"Propose it instead: `nebula propose --note \"<why>\" {targets}` "
        "(MCP: propose_change). The person accepts on the canvas, and the canvas runs it."
    )
