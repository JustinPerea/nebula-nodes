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
- ``agentSpend.dailyTotalUsd``: the daily total, what everything that isn't
  the person (agent chats, agents outside Nebula, scripts, tabs not opened
  from the link) may spend together over the last 24 hours (Justin decided,
  2026-10-31). Left unset it is DEFAULT_DAILY_TOTAL_USD ($5), and so is an
  unreadable value; only the person's explicit null ("No limit") lifts it.
  The other limits stay as finer ones inside it. A run that would pass it
  isn't refused like the others: it becomes a proposal the person accepts
  on the canvas (``DailyWait``, main._propose_waiting_run), as Justin put it,
  "runs wait for your OK like a run over $1 does".

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
  shared outside budget, with a line in Settings for each agent that spent
  in the last 24 hours (AgentSpendSection's PersonalAgentSpend).
  ``PERSONAL_AGENT_BUDGET = "chat"`` switches it to a per-chat ``chat:`` key.
- ``outside:app:<id>``: an outside app the person gave its own token in
  Settings (services/app_tokens.py). The app's own daily limit applies, and
  its runs also count inside the outside budget: both are checked and the
  stricter wins, so issuing tokens never adds headroom.

Outside totals are rolling: each run is an event with its time, and only the
last 24 hours count (``WINDOW_SECONDS``). A chat's runs are also kept as
events, under CHATS_DAILY, so the daily total rolls the same way over every
key (``SpendLedger.spent_daily``). A give-back lands at the time of the
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
a node onto the plan themselves, or onto another provider: changing
``_kreaAuth`` or a route-table node's ``_provider`` takes a proposal
(``main._refuse_agent_billing_change``). That holds on every way in: the
edit routes, project snapshots, and the run routes, which take params in the
request (a run may only bill a node the way its canvas node does, and a node
that exists only for the run starts on Auto and the API token).

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
for any other paid node without one. Jev mode calls TypeSafe with
TYPESAFE_API_KEY and is priced per request at its context ceiling (the QC
entries in model_pricing.json), so it counts against a limit like any priced
node. Heuristic and opencv runs stay free.

A priced setting that arrives by wire (Krea Kling 3.0's ``multi_prompt``
port) is only known at run time, so that node is unpriced too
(``model_pricing.wired_ports``).

A price measured from the run's input file (SeedVR2 per megapixel, FLUX
Video Upscale and Edit by the clip: model_pricing ``sizing``) is checked at
the size the caller measured (``sizes``, services/input_sizes.py), at the
top of whatever range results. When the input doesn't exist yet (its
upstream node runs in this same request), the node is unpriced, and the
refusal says what makes it priced: an Image or Video Input holding the
file, `nebula quick` on the file, or a proposal. Only a file in Nebula's
output folder (or an inline image) is measured, since one anywhere else
could change between the check and the run (input_sizes OUTSIDE): the
refusal says to add it first (`nebula upload`, MCP upload_file).

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
from typing import Any, Callable, Mapping, Sequence

from services import model_pricing, money, node_route
from services.node_names import node_name_list, quoted
from services.retired_nodes import merged_into

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

# The daily total (Justin decided, 2026-10-31: "Add a default daily total for
# everything that isn't you ... $5 a day is a starting point").
DAILY_TOTAL_KEY = "dailyTotalUsd"
DEFAULT_DAILY_TOTAL_USD = 5.0
# The most a daily total may be. Settings offers $1 to $50 a day and "No
# limit"; a typed amount above this isn't a limit anyone means (No limit says
# that), and keeping it here keeps every sum and the "$100,000 / day" label
# finite: a hand-written 1e308 or 10**400 is read as unreadable ($5), never
# an OverflowError (review 1 of PR #212, N-2). frontend lib/dailyTotal.ts
# MAX_DAILY_TOTAL_USD is the same.
MAX_DAILY_TOTAL_USD = 100_000.0
DAILY_WHO = "everything that isn't the person"
# Every chat's runs as events with their time, so the daily total counts
# chats over the same rolling 24 hours as the outside agents. Never a chat's
# own budget, and never dropped for room.
CHATS_DAILY = "daily:chats"
CHATS_DAILY_LABEL = "Nebula chats"
# Set in the file once chats' spend from before the daily total was counted in it.
_CHATS_DAILY_SEEDED = "chatsDailySeeded"


# -- settings ----------------------------------------------------------------------

def _fold_models(models: Mapping[str, dict[str, float | None]]) -> dict[str, dict[str, float | None]]:
    """Per-model limits with a folded node's limits moved to the node it
    became (retired_nodes.MERGED: Krea's FLUX copies are now routes on the
    FLUX nodes, one limit per model across providers). Where both are set,
    the lower of each limit holds, so folding never loosens one."""
    folded: dict[str, dict[str, float | None]] = {}
    for definition_id, limits in models.items():
        target = merged_into(definition_id)
        if target not in folded:
            folded[target] = dict(limits)
            continue
        merged = folded[target]
        for key, value in limits.items():
            if value is not None and (merged.get(key) is None or value < merged[key]):
                merged[key] = value
    return folded


def saved_caps_view(raw: Any) -> Any:
    """``agentSpend`` as saved, with folded nodes' limits under the node they
    became (``_fold_models``), for Settings to show and save back. Anything
    unreadable is left as it is; caps_from_settings reads it as before."""
    if not isinstance(raw, dict) or not isinstance(raw.get("models"), dict):
        return raw
    models = raw["models"]
    if not any(merged_into(str(k)) != k for k in models):
        return raw
    readable: dict[str, dict[str, float | None]] = {}
    rest: dict[str, Any] = {}
    for definition_id, limits in models.items():
        try:
            readable[str(definition_id)] = {key: validate_threshold(limits.get(key)) for key in ("perRunUsd", "sessionUsd")}
        except (AttributeError, ValueError):
            rest[str(definition_id)] = limits
    return {**raw, "models": {**rest, **_fold_models(readable)}}


def validate_threshold(value: Any) -> float | None:
    """A positive finite number of USD, or None for no limit."""
    if value is None:
        return None
    if isinstance(value, bool) or not isinstance(value, (int, float)):
        raise ValueError("a spending limit must be a positive number of USD or null")
    try:
        amount = float(value)
    except OverflowError:  # an integer too large for a float (10**400): unreadable, not a 500
        raise ValueError("a spending limit must be a positive number of USD or null") from None
    if not math.isfinite(amount) or amount <= 0:
        raise ValueError("a spending limit must be a positive number of USD or null")
    return amount


def validate_daily_total(value: Any) -> float | None:
    """The daily total: validate_threshold, at most MAX_DAILY_TOTAL_USD."""
    amount = validate_threshold(value)
    if amount is not None and amount > MAX_DAILY_TOTAL_USD:
        raise ValueError(f"{CAPS_KEY}.{DAILY_TOTAL_KEY} must be at most {limit_usd(MAX_DAILY_TOTAL_USD)} a day, "
                         "or null for no limit")
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

    ``outsideDailyUsd``, ``kreaPlanRuns`` and ``dailyTotalUsd`` are kept only
    when the request names them: left out, the outside agents share the
    per-session amount, plan runs are held to DEFAULT_PLAN_RUNS and the daily
    total is DEFAULT_DAILY_TOTAL_USD (see caps_from_settings)."""
    if not isinstance(value, dict):
        raise ValueError(f"{CAPS_KEY} must be an object")
    unknown = set(value) - {"sessionUsd", "outsideDailyUsd", "kreaPlanRuns", DAILY_TOTAL_KEY, "models"}
    if unknown:
        raise ValueError(f"{CAPS_KEY} has unknown fields: {', '.join(sorted(unknown))}")
    models_in = value.get("models", {})
    if models_in is None:
        models_in = {}
    if not isinstance(models_in, dict):
        raise ValueError(f"{CAPS_KEY}.models must be an object keyed by node id")
    models: dict[str, dict[str, float | None]] = {}
    for definition_id, limits in models_in.items():
        if definition_id not in known_definitions and merged_into(definition_id) not in known_definitions:
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
    if DAILY_TOTAL_KEY in value:
        caps[DAILY_TOTAL_KEY] = validate_daily_total(value[DAILY_TOTAL_KEY])
    caps["models"] = _fold_models(models)
    return caps


def caps_from_settings(settings: Mapping[str, Any]) -> dict[str, Any]:
    """The saved agent limits; anything unreadable counts as unset, except an
    unreadable outside budget, which falls back to the per-session one, and
    plan runs: unset is DEFAULT_PLAN_RUNS and unreadable is 0 (every plan run
    needs a proposal). Krea doesn't price plan runs, so no USD limit stands
    behind them; only an explicit null (the person's "No limit") lifts it.
    The daily total is the same: unset or unreadable is
    DEFAULT_DAILY_TOTAL_USD, and only an explicit null lifts it."""
    if CAPS_KEY not in settings:
        return {"sessionUsd": None, "outsideDailyUsd": None, "kreaPlanRuns": DEFAULT_PLAN_RUNS,
                DAILY_TOTAL_KEY: DEFAULT_DAILY_TOTAL_USD, "models": {}}
    raw = settings.get(CAPS_KEY)
    if not isinstance(raw, dict):
        return {"sessionUsd": None, "outsideDailyUsd": None, "kreaPlanRuns": 0,
                DAILY_TOTAL_KEY: DEFAULT_DAILY_TOTAL_USD, "models": {}}
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
    daily: float | None = DEFAULT_DAILY_TOTAL_USD
    if DAILY_TOTAL_KEY in raw:
        try:
            daily = validate_daily_total(raw[DAILY_TOTAL_KEY])
        except ValueError:
            daily = DEFAULT_DAILY_TOTAL_USD
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
    return {"sessionUsd": session, "outsideDailyUsd": outside, "kreaPlanRuns": plan_runs, DAILY_TOTAL_KEY: daily,
            "models": _fold_models(models)}


# -- what a session has spent ------------------------------------------------------

@dataclass
class Spent:
    total: float = 0.0
    models: dict[str, float] = field(default_factory=dict)
    plan_runs: int = 0


def is_outside(key: str) -> bool:
    return key.startswith(OUTSIDE_PREFIX)


def _keeps_events(key: str) -> bool:
    """A key whose runs are events in time: an outside budget, or every chat's
    runs for the daily total (CHATS_DAILY)."""
    return is_outside(key) or key == CHATS_DAILY


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
    only the last 24 hours of them; events older than that are dropped on save.
    Every chat run is also an event under CHATS_DAILY, for the daily total.

    ``reserve`` is the one way a run is checked and counted: the check and
    the count happen under one lock, so two runs that each fit alone can't
    both pass a total they pass together."""

    def __init__(self, path: Path | None, *, clock: Callable[[], float] = time.time) -> None:
        self._path = path
        self._clock = clock
        self._lock = threading.Lock()
        self._reserve_lock = threading.RLock()
        self._sessions: dict[str, dict[str, Any]] | None = None

    def _load(self) -> dict[str, dict[str, Any]]:
        if self._sessions is None:
            self._sessions = {}
            # A file from before the daily total kept chats as running totals
            # only: their last 24 hours go into CHATS_DAILY once (_seed_chats_daily).
            seeded = True
            if self._path is not None and self._path.exists():
                try:
                    data = json.loads(self._path.read_text(encoding="utf-8"))
                    if isinstance(data, dict) and isinstance(data.get("sessions"), dict):
                        self._sessions = {str(k): v for k, v in data["sessions"].items() if isinstance(v, dict)}
                        seeded = data.get(_CHATS_DAILY_SEEDED) is True
                except (OSError, ValueError):
                    self._sessions = {}
            changed = self._migrate(self._sessions)
            if not seeded:
                self._seed_chats_daily(self._sessions)
                changed = True
            if changed:
                self._save(self._sessions)
        return self._sessions

    def _seed_chats_daily(self, sessions: dict[str, dict[str, Any]]) -> None:
        """Chat spend from before the daily total counts toward it from the
        start (review 1 of PR #212, L-4): each chat entry updated in the last
        24 hours counts as spent at that time, as _migrate folds legacy keys
        (it was spent then or earlier, so this can only overcount). Once per
        file; a file that already has CHATS_DAILY counted its chats itself."""
        if CHATS_DAILY in sessions:
            return
        since = self._clock() - WINDOW_SECONDS
        events: list[list[Any]] = []
        for key, entry in sessions.items():
            if _keeps_events(key):
                continue
            try:
                at = float(entry.get("updated") or 0)
                total = float(entry.get("total") or 0)
                models = {str(k): float(v) for k, v in (entry.get("models") or {}).items()}
                plan_runs = int(entry.get("planRuns") or 0)
            except (TypeError, ValueError, AttributeError, OverflowError):
                continue
            if at <= since or not math.isfinite(at):
                continue
            for definition_id, amount in models.items():
                if amount > 0 and math.isfinite(amount):
                    events.append([at, definition_id, round(amount, 6), 0])
            rest = round(total - sum(a for a in models.values() if a > 0 and math.isfinite(a)), 6)
            if rest > 0 and math.isfinite(rest) or plan_runs > 0:
                events.append([at, "", max(0.0, rest) if math.isfinite(rest) else 0.0, max(0, plan_runs)])
        if events:
            sessions[CHATS_DAILY] = {"agent": CHATS_DAILY_LABEL, "events": events, "updated": self._clock()}

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
                # Spend recorded under a folded node counts as the node it became.
                model = merged_into(str(definition_id))
                models[model] = models.get(model, 0.0) + float(amount)
        return Spent(max(0.0, round(total, 6)),
                     {k: round(v, 6) for k, v in models.items() if round(v, 6) > 0 and k},
                     max(0, runs))

    def spent(self, key: str) -> Spent:
        with self._lock:
            entry = self._load().get(key) or {}
            if _keeps_events(key):
                return self._sum(self._events(entry))
        models = entry.get("models") if isinstance(entry.get("models"), dict) else {}
        spent_models: dict[str, float] = {}
        for k, v in models.items():
            model = merged_into(str(k))
            spent_models[model] = spent_models.get(model, 0.0) + float(v)
        return Spent(float(entry.get("total") or 0.0), spent_models, int(entry.get("planRuns") or 0))

    def spent_outside(self) -> Spent:
        """Everything every outside agent (shared or with an app token) spent in the last 24 hours."""
        with self._lock:
            events = [event for key, entry in self._load().items() if is_outside(key) for event in self._events(entry)]
            return self._sum(events)

    def spent_daily(self) -> Spent:
        """Everything that isn't the person spent in the last 24 hours, for the
        daily total: every outside key's events and every chat's (CHATS_DAILY).
        Each key is summed and held at 0 on its own before they're added, so a
        give-back larger than its own key's charge can't erase another key's
        spend (review 1 of PR #212, N-1)."""
        with self._lock:
            parts = [self._sum(self._events(entry)) for key, entry in self._load().items() if _keeps_events(key)]
        models: dict[str, float] = {}
        for part in parts:
            for model, amount in part.models.items():
                models[model] = round(models.get(model, 0.0) + amount, 6)
        return Spent(round(sum(part.total for part in parts), 6), models, sum(part.plan_runs for part in parts))

    def reserve(self, key: str, label: str, check: Callable[[], "Decision"]) -> tuple["Decision", float | None]:
        """Run ``check`` (which reads what was spent and decides) and, when it
        doesn't refuse, count its charge, all under one lock: no other run is
        checked between the read and the count. Returns the decision and the
        time it was counted (None when it refused)."""
        with self._reserve_lock:
            decision = check()
            if decision.refusal:
                return decision, None
            return decision, self.record(key, label, decision.charge, decision.plan_charge)

    @staticmethod
    def _add_events(entry: dict[str, Any], at: float, by_model: Mapping[str, float],
                    plan_runs: Mapping[str, int], sign: int) -> None:
        events = SpendLedger._events(entry)
        for definition_id in set(by_model) | set(plan_runs):
            events.append([at, definition_id, sign * round(by_model.get(definition_id, 0.0), 6),
                           sign * int(plan_runs.get(definition_id, 0))])
        entry["events"] = events

    def record(self, key: str, label: str, by_model: Mapping[str, float],
               plan_runs: Mapping[str, int] | None = None) -> float:
        """Count a run that is starting; returns its time, which a give-back passes as ``at``."""
        now = self._clock()
        plan_runs = {k: v for k, v in (plan_runs or {}).items() if v}
        if not by_model and not plan_runs:
            return now
        with self._lock:
            sessions = self._load()
            if _keeps_events(key):
                entry = sessions.pop(key, None) or {"agent": label, "events": []}
                self._add_events(entry, now, by_model, plan_runs, 1)
            else:
                entry = sessions.pop(key, None) or {"agent": label, "total": 0.0, "models": {}}
                for definition_id, amount in by_model.items():
                    entry["models"][definition_id] = round(entry["models"].get(definition_id, 0.0) + amount, 6)
                    entry["total"] = round(entry["total"] + amount, 6)
                entry["planRuns"] = int(entry.get("planRuns") or 0) + sum(plan_runs.values())
                # The same run, in time, for the daily total.
                daily = sessions.get(CHATS_DAILY) or {"agent": CHATS_DAILY_LABEL, "events": []}
                self._add_events(daily, now, by_model, plan_runs, 1)
                daily["updated"] = now
                sessions[CHATS_DAILY] = daily
            entry["agent"] = label
            entry["updated"] = now
            sessions[key] = entry  # most recent last
            chats = [k for k in sessions if not _keeps_events(k)]
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
            if _keeps_events(key):
                if at is None:
                    return
                self._add_events(entry, at, by_model, plan_runs, -1)
            else:
                # The daily total's copy lands at the run's own time too; with
                # no time it stays counted, rather than guess a window.
                daily = sessions.get(CHATS_DAILY)
                if at is not None and daily is not None:
                    self._add_events(daily, at, by_model, plan_runs, -1)
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
        for key in [k for k in sessions if _keeps_events(k)]:
            kept = [event for event in self._events(sessions[key]) if float(event[0]) > since]
            if kept:
                sessions[key]["events"] = kept
            else:
                sessions.pop(key)
        if self._path is None:
            return
        self._path.parent.mkdir(parents=True, exist_ok=True)
        tmp = self._path.with_suffix(".tmp")
        tmp.write_text(json.dumps({"sessions": sessions, _CHATS_DAILY_SEEDED: True}), encoding="utf-8")
        os.replace(tmp, self._path)


# -- the decision ------------------------------------------------------------------

@dataclass
class Budget:
    """One total a run counts against, and its limits.

    ``who`` names it in a refusal ("this session", "agents outside Nebula
    chats"); ``window`` follows the amount (" in the last 24 hours");
    ``model_caps`` says whether the per-model session limits apply to it.
    ``daily`` marks the daily total, the umbrella over the others: a run
    that would pass it waits for the person's OK (DailyWait) instead of
    being refused like the rest."""
    who: str
    spent: Spent
    usd: float | None
    plan_runs: int | None = None
    model_caps: bool = True
    plural: bool = False
    window: str = ""
    noun: str = "budget"
    daily: bool = False

    def _has(self) -> str:
        return f"{self.who} {'have' if self.plural else 'has'} already used"

    def _its(self) -> str:
        return "their" if self.plural else "its"


def daily_budget(daily_spent: Spent, caps: Mapping[str, Any]) -> Budget:
    """The daily total, shared by every key that isn't the person."""
    return Budget(DAILY_WHO, daily_spent, caps.get(DAILY_TOTAL_KEY), None, model_caps=False,
                  window=" in the last 24 hours", noun="daily total", daily=True)


def session_budgets(key: str, spent: Spent, caps: Mapping[str, Any], *, outside_spent: Spent | None = None,
                    app_name: str | None = None, app_daily_usd: float | None = None,
                    daily_spent: Spent | None = None) -> list[Budget]:
    """The budgets a run from ``key`` counts against (see the module docstring).
    With ``daily_spent`` (SpendLedger.spent_daily), the daily total comes
    first: every key counts against it."""
    daily = [daily_budget(daily_spent, caps)] if daily_spent is not None else []
    if not is_outside(key):
        return [*daily, Budget("this session", spent, caps.get("sessionUsd"), caps.get("kreaPlanRuns"))]
    window = " in the last 24 hours"
    shared = Budget("agents outside Nebula chats", outside_spent if outside_spent is not None else spent,
                    caps.get("outsideDailyUsd"), caps.get("kreaPlanRuns"), plural=True, window=window)
    if not key.startswith(APP_PREFIX):
        return [*daily, shared]
    own = Budget(app_name or "this app", spent, app_daily_usd, None, model_caps=False, window=window,
                 noun="daily limit")
    return [*daily, own, shared]


def limit_usd(amount: float) -> str:
    """A limit the person picked, as Settings writes it: "$5", "$7.50", "$0.50"
    (whole dollars bare, anything else to the cent). frontend
    lib/dailyTotal.ts limitUsd is the same."""
    cents = int(math.floor(float(amount) * 100 + 0.5))
    if cents % 100 == 0:
        return f"${cents // 100:,}"
    return f"${cents // 100:,}.{cents % 100:02d}"


# Why a run that passes the daily total also needs the person's OK
# (DailyWait.also): the reason the guard gives first without the total.
ALSO_PER_RUN = "perRun"            # over the per-run limit (Settings > Run cost)
ALSO_MODEL_PER_RUN = "modelPerRun"  # over one model's own per-run limit
ALSO_UNPRICED = "unpriced"          # a node with no list price, with a USD limit set
ALSO_LIMIT = "limit"                # over a chat's, the outside agents', an app's or a model's budget
ALSO_PLAN_RUNS = "planRuns"         # over a Krea plan-run limit


def limit_owner(who: str) -> str:
    """Whose limit a Budget is, as the bar names it (GM - Design, 2026-10-31):
    "this chat", "agents outside Nebula chats", or an app by name."""
    if who == "this session":
        return "this chat"
    if who in ("agents outside Nebula chats", "this app"):
        return who
    return quoted(who)


@dataclass
class DailyWait:
    """A run that would pass the daily total: it waits for the person's OK as
    a proposal, with these as its reasons (GM - Design, 2026-10-31,
    verbatim). ``limit`` is the total, ``used`` what everything that isn't
    the person spent in the last 24 hours before this run, ``run`` this run's
    upper bound.

    ``also`` is the other reason it needs an OK, when it has one: the one the
    guard would give first without the total, since accepting overrides both
    (GM: "Accepting overrides both, so the person should know"). With it:
    ``per_run_limit`` (the per-run limit, a model's own, or the budget's
    amount), ``model`` (that model's display name), ``owner`` (whose budget,
    limit_owner), ``plan_runs_limit``, and ``unpriced`` (the nodes with no
    list price, named through ``names``: their canvas names, filled in when
    the proposal is made, else their titles)."""
    limit: float
    used: float
    run: float
    also: str | None = None
    per_run_limit: float | None = None
    model: str | None = None
    owner: str | None = None
    plan_runs_limit: int | None = None
    unpriced: tuple[str, ...] = ()
    names: dict[str, str] = field(default_factory=dict)
    # False when the run itself fits under the total and waits only because a
    # node has no list price, which Nebula can't count toward it (Justin's
    # Q165): every line then says that, never "would pass".
    over: bool = True

    @property
    def left(self) -> float:
        return max(0.0, round(self.limit - self.used, 6))

    def bar_line(self) -> str:
        """The proposal bar's line (and the Updates card's second sentence)."""
        total = f"the {limit_usd(self.limit)} daily total"
        if not self.over:
            return self._cannot_count()
        if self.also == ALSO_PER_RUN and self.per_run_limit is not None:
            return f"This would pass {total} and cost more than {limit_usd(self.per_run_limit)} per run."
        if self.also == ALSO_MODEL_PER_RUN and self.per_run_limit is not None and self.model:
            return (f"This would pass {total} and cost more than the {limit_usd(self.per_run_limit)} per-run "
                    f"limit for {quoted(self.model)}.")
        if self.also == ALSO_UNPRICED and self.unpriced:
            names = [self.names.get(node_id) or node_id for node_id in self.unpriced]
            verb = "has" if len(names) == 1 else "have"
            return f"This would pass {total}, and {node_name_list(names)} {verb} no list price."
        if self.also == ALSO_UNPRICED:
            return f"This would pass {total} and has a node with no list price."
        if self.also == ALSO_LIMIT and self.per_run_limit is not None and self.owner:
            amount = limit_usd(self.per_run_limit)
            cap = f"the {amount} {quoted(self.model)} limit" if self.model else f"the {amount} limit"
            return f"This would pass {total} and {cap} for {self.owner}."
        if self.also == ALSO_PLAN_RUNS and self.plan_runs_limit is not None and self.owner:
            return f"This would pass {total} and the {self.plan_runs_limit}-run Krea plan limit for {self.owner}."
        if money.usd_spent(self.left) == "$0.00":
            return f"This would pass {total}, which is used up."
        return f"This would pass {total}, which has {money.usd_spent(self.left)} left."

    def _unpriced_names(self) -> list[str]:
        return [self.names.get(node_id) or node_id for node_id in self.unpriced]

    def _cannot_count(self) -> str:
        """GM - Design (PR #212 r2, item 4), verbatim: the line when only a node
        with no list price makes the run wait. "“Sketch” has no list price, so
        Nebula can\u2019t count it toward the $5 daily total." (several: "have
        no list price" and "them")."""
        names = self._unpriced_names() or ["A node"]
        one = len(names) == 1
        return (f"{node_name_list(names) if self.unpriced else names[0]} {'has' if one else 'have'} no list price, "
                f"so Nebula can\u2019t count {'it' if one else 'them'} toward the {limit_usd(self.limit)} daily total.")

    def update_line(self, run_names: list[str]) -> str:
        """The Updates card's second sentence. Beside the bar's line except
        when only the unpriced nodes make the run wait: "It has no list
        price, so Nebula can\u2019t count it toward the $5 daily total." (GM
        item 4). When the run holds other nodes too, the nodes are named
        (the bar's line), since "It" would be unclear."""
        names = self._unpriced_names()
        if self.over or not names or sorted(names) != sorted(run_names):
            return self.bar_line()
        one = len(names) == 1
        return (f"{'It has' if one else 'They have'} no list price, so Nebula can\u2019t count "
                f"{'it' if one else 'them'} toward the {limit_usd(self.limit)} daily total.")

    def _agents(self) -> str:
        return (f"this run (about {money.usd_amount(self.run)}) would pass their {limit_usd(self.limit)} daily "
                f"total for everything that isn\u2019t them ({money.usd_spent(self.used)} used in the last 24 hours)")

    def agent_line(self, proposal_id: str) -> str:
        """What an agent reads (run results, the CLI, HTTP), in GM's words.
        MCP's run_nodes words the last sentence for its reader (for_mcp)."""
        if not self.over:
            return (f"{self._cannot_count()} Proposing {'it' if len(self.unpriced) < 2 else 'them'} for the "
                    f"person\u2019s OK. Sent as proposal {proposal_id}. {CHECK_CLI}")
        return (f"Waiting for the person\u2019s OK: {self._agents()}. Sent as proposal {proposal_id}. "
                f"{CHECK_CLI}")

    def _reason(self) -> str:
        """Why the run waits, as the lines that give no node name say it."""
        return f"This would pass the {limit_usd(self.limit)} daily total" if self.over else self._cannot_count()[:-1]

    def nameless_line(self) -> str:
        """A caller that didn't name itself (a script, curl) over the total:
        refused, since only a caller with a name gets a proposal (GM - Design,
        2026-10-31). A tab not opened from the link reads its own lock line."""
        if not self.over:
            return f"{self._cannot_count()} Name yourself with NEBULA_AGENT_NAME or --as to send it as a proposal."
        return (f"This would pass the {limit_usd(self.limit)} daily total. Name yourself with "
                "NEBULA_AGENT_NAME or --as to send it as a proposal.")

    def slots_full_line(self, open_count: int) -> str:
        """The agent's line when its proposal slots are full (GM - Design, 2026-10-31)."""
        return (f"{self._reason()}, and you already have {open_count} "
                "open proposals. Wait until the person accepts or rejects one, then propose it again.")

    def total_full_line(self, open_count: int) -> str:
        """The agent's line when Nebula's open proposals are at the cap (GM -
        Design, PR #212 r2, item 3), verbatim: "This would pass the $5 daily
        total, and Nebula already has 12 open proposals. Wait until the person
        accepts or rejects one, then propose it again."""
        return (f"{self._reason()}, and Nebula already has {open_count} "
                "open proposals. Wait until the person accepts or rejects one, then propose it again.")

    def _log_reason(self, names: list[str]) -> str:
        if self.over:
            return f"it would pass the {limit_usd(self.limit)} daily total"
        mine = self._unpriced_names()
        if not mine or sorted(mine) == sorted(names):
            return "it has no list price"
        return f"{node_name_list(mine)} {'has' if len(mine) == 1 else 'have'} no list price"

    def slots_full_log(self, names: list[str], open_count: int) -> str:
        """The person's Agent log line for it. The log's source column names the
        agent, so the sentence reads whole without it (GM - Design, PR #212 r2,
        item 2)."""
        return (f"Couldn\u2019t run {node_name_list(names)} because {self._log_reason(names)} and all "
                f"{open_count} proposal slots are full.")

    def total_full_log(self, names: list[str], open_count: int) -> str:
        """The person's Agent log line when Nebula's open proposals are at the
        cap (GM item 3), verbatim: "Couldn\u2019t run \u201cWriter\u201d because it would pass
        the $5 daily total and Nebula already has 12 open proposals."""
        return (f"Couldn\u2019t run {node_name_list(names)} because {self._log_reason(names)} and Nebula "
                f"already has {open_count} open proposals.")

    def refusal(self, how_to_ask: str) -> str:
        """For a run Nebula can't make a proposal of (a run off the canvas,
        such as `nebula quick` or a moodboard read): refused as the other
        limits refuse, in the same words."""
        if not self.over:
            return f"Needs the person's approval: {self._cannot_count()} {how_to_ask}"
        return f"Needs the person's approval: {self._agents()}. {how_to_ask}"

    def as_dict(self) -> dict[str, Any]:
        """The exact numbers, for agents and the canvas."""
        return {"limitUsd": self.limit, "usedUsd": round(self.used, 6), "leftUsd": self.left,
                "runUsd": round(self.run, 6), "also": self.also, "alsoLimitUsd": self.per_run_limit,
                "alsoModel": self.model, "alsoFor": self.owner, "alsoPlanRuns": self.plan_runs_limit,
                "over": self.over, "barLine": self.bar_line()}


@dataclass
class Decision:
    refusal: str | None
    charge: dict[str, float]  # upper-bound USD per node definition, to record if the run goes ahead
    per_node: dict[str, tuple[str, float]] = field(default_factory=dict)  # node id -> (definition, USD)
    plan_charge: dict[str, int] = field(default_factory=dict)  # Krea plan runs per node definition
    plan_per_node: dict[str, tuple[str, int]] = field(default_factory=dict)  # node id -> (definition, runs)
    # Set when the run would pass the daily total: it waits for the person's OK.
    wait: DailyWait | None = None


# How each surface checks on a waiting run's proposal (GM - Design,
# 2026-10-31: "MCP gets get_proposal("<id>") and the CLI gets “nebula proposals”").
CHECK_CLI = "Check it with nebula proposals."
CHECK_MCP = 'Check it with get_proposal("{id}").'


def for_mcp(message: str, proposal_id: str) -> str:
    """A waiting run's agent line (DailyWait.agent_line) in MCP's words."""
    check = CHECK_MCP.format(id=proposal_id)
    if message.endswith(CHECK_CLI):
        return message[: -len(CHECK_CLI)] + check
    return message


def _usd(amount: float) -> str:
    """A cost, limit or amount used in a refusal line: services/money.py's
    one form for an amount ("$0.0004", never "$0.000"; review 2, L4)."""
    return money.usd_amount(amount)


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


_NO_LIMIT_CHECK = "so it can't check this run against the spending limits set in Nebula Settings."

# {node id: (port, [(source name, source id, source port), ...])}: what is
# connected to the port a node is priced from, when more than one input is.
SizeInputs = Mapping[str, tuple[str, Sequence[tuple[str, str, str | None]]]]


def _and(items: list[str]) -> str:
    return items[0] if len(items) == 1 else ", ".join(items[:-1]) + f" and {items[-1]}"


# How many sources, and how many nodes' groups of them, a size refusal lists
# before "and N more" (as _names caps node names): 100 inputs on one port
# would otherwise make a 10 KB refusal.
_LISTED = 5


def _connected_now(ids: list[str], size_inputs: SizeInputs | None) -> str:
    """The inputs connected to each node's measured port, so the agent knows
    which to choose from (GM - Design: "If the refusal doesn't already name
    the connected inputs, list them right before it"). Each is the source
    node's name in quotes and its id:port, as `--unwire` takes it. Text only:
    the refusal itself is decided before this runs, whatever it lists."""
    def inputs(node_id: str) -> str:
        _port, sources = (size_inputs or {})[node_id]
        shown = [f"{quoted(name)} ({source}:{handle})" if handle else f"{quoted(name)} ({source})"
                 for name, source, handle in sources[:_LISTED]]
        if len(sources) > _LISTED:
            return ", ".join(shown) + f" and {len(sources) - _LISTED} more"
        return _and(shown)

    known = [node_id for node_id in ids if node_id in (size_inputs or {}) and (size_inputs or {})[node_id][1]]
    if not known:
        return ""
    if len(ids) == 1:
        return f"Connected to it now: {inputs(known[0])}. "
    first, *rest = known[:_LISTED]
    more = f"; and {len(known) - _LISTED} more nodes" if len(known) > _LISTED else ""
    return (f"Connected to {first} now: {inputs(first)}"
            + "".join(f"; to {node_id}: {inputs(node_id)}" for node_id in rest) + more + ". ")


def _awaiting_reasons(
    awaiting: list[str], why: Mapping[str, str], labels: Mapping[str, str],
    definition_of: Mapping[str, str], pricing: Mapping[str, Any],
    definitions: Mapping[str, Mapping[str, Any]] | None = None,
    size_inputs: SizeInputs | None = None,
) -> list[str]:
    """One sentence per reason the nodes priced from their input's size have
    no size here (input_sizes.run_input_sizes ``reasons``): each says what to
    do instead, and none suggests the step that just failed.

    Adding a local file to Nebula first is `nebula upload <file>` (MCP:
    upload_file): Nebula's own copy is in its output folder, the only place
    a price is measured from (services/input_sizes.py). `nebula quick` is
    offered on a local file only for an image port and only for PENDING and
    REMOTE: /api/quick copies a local image into Nebula before the check
    (never a clip), and an image that is OUTSIDE is one that copy (the same
    one every run route makes) already refused, so OUTSIDE names the
    upload's limits instead."""
    from services import input_sizes

    def port_of(node_id: str) -> tuple[str, str]:
        definition_id = definition_of.get(node_id, "")
        port = next(iter(sorted(model_pricing.sizing_ports((pricing.get("nodes") or {}).get(definition_id)))), "image")
        port_type = next((str(spec.get("dataType") or "") for spec in ((definitions or {}).get(definition_id) or {})
                          .get("inputPorts") or [] if isinstance(spec, Mapping) and spec.get("id") == port), "")
        return port, port_type

    # One sentence per reason and measured port type: an audio node and a
    # video node refused for the same reason each get their own wording.
    groups: dict[tuple[str, str], list[str]] = {}
    for node_id in awaiting:
        key = (why.get(node_id) or input_sizes.PENDING, port_of(node_id)[1])
        groups.setdefault(key, []).append(node_id)
    base_upload = ("`nebula upload <file>` (MCP: upload_file) copies it into Nebula's output folder and puts an "
                   "Image Input or Video Input holding the copy on the canvas; connect that to the node and run it")
    audio_upload = ("`nebula upload <file>` (MCP: upload_file) copies it into Nebula's output folder and puts an "
                    "Audio Input holding the copy on the canvas; connect that to the node and run it")
    sentences = []
    for (reason, port_type), ids in groups.items():
        first = definition_of.get(ids[0], "")
        port, _ = port_of(ids[0])
        image_port = port_type not in ("Video", "Audio")
        audio_port = port_type == "Audio"
        names = f"Nebula prices {_names(ids, labels)} from the length of its audio" if audio_port else (
            f"Nebula prices {_names(ids, labels)} from the size of its input")
        upload = audio_upload if audio_port else base_upload
        if reason == input_sizes.REMOTE:
            quick = (f", or run `nebula quick {first} --input {port}=<local file path>`" if image_port else "")
            sentences.append(
                f"{names}, and that input is a file on another host: Nebula never downloads a file to price it, "
                f"{_NO_LIMIT_CHECK} To run it within the limits, download the file and add the local copy to "
                f"Nebula: {upload}{quick}; otherwise propose it.")
        elif reason == input_sizes.OUTSIDE:
            # Every run route has already tried to copy an outside image in
            # (main._import_external_image_to_output_root), so an image is
            # still outside only when that refused it; the upload refuses the
            # same files. No `nebula quick` here: it is that same import.
            limit = (" An image over 20 MB, or one Nebula can't recognise as an image, can't be added this way: "
                     "the upload refuses it, and the run already tried to copy it in."
                     if image_port else
                     "" if audio_port else
                     " A clip over 500 MB can't be added this way: the upload refuses it.")
            sentences.append(
                f"{names}, and that input is a local file outside Nebula's output folder, which could change "
                f"after the check: Nebula doesn't price a run from such a file, {_NO_LIMIT_CHECK} To run it within "
                f"the limits, add it to Nebula first: {upload}.{limit} Otherwise propose it.")
        elif reason == input_sizes.UNREADABLE:
            if audio_port:
                sentences.append(
                    f"{names}, and Nebula couldn't read that file's length (it is missing, isn't an audio file "
                    "Nebula can measure, such as one with a video stream or more than one audio stream, or is "
                    f"outside the folders Nebula may read), {_NO_LIMIT_CHECK} Point the input at a readable audio "
                    "file and run it again, or propose it.")
                continue
            sentences.append(
                f"{names}, and Nebula couldn't read that file's size (it is missing, isn't an image or video Nebula "
                "can measure, such as one with more than one frame, size or video stream, or is outside the "
                f"folders Nebula may read), {_NO_LIMIT_CHECK} Point the input at a readable image or video file "
                "and run it again, or propose it.")
        elif reason == input_sizes.WIRES:
            sentences.append(
                f"{names}, and more than one input is connected to its {port} port, so Nebula can't tell which "
                f"file it sends; {_NO_LIMIT_CHECK} {_connected_now(ids, size_inputs)}"
                "Disconnect all but one, or propose it.")
        elif reason == input_sizes.UNWIRED:
            holder = "an Audio Input" if audio_port else "an Image Input (or Video Input)"
            sentences.append(
                f"{names}, and nothing connected to its {port} port gives it a file, {_NO_LIMIT_CHECK} Connect "
                f"{holder} holding the file to it, or propose it.")
        else:
            quick = (f", or run it on the file with `nebula quick {first} --input {port}=<file>`"
                     if image_port else "")
            what = "audio" if audio_port else "image or video"
            holder = "an Audio Input" if audio_port else "an Image Input (or Video Input)"
            sentences.append(
                f"{names}, and that {what} doesn't exist yet (the node that makes it runs in this same "
                f"run or hasn't run, or Nebula is still writing it), {_NO_LIMIT_CHECK} To run it within the "
                f"limits, connect {holder} holding the file to it: {upload}{quick}; "
                "otherwise propose it (once the node that makes the input has run, a proposal is priced from "
                "that output).")
    return sentences


def _first_other_reason(wait: DailyWait, *, usd_limited: bool, estimate: Mapping[str, Any],
                        by_model: Mapping[str, float], model_caps: Mapping[str, Any], threshold: float | None,
                        finer: list[Budget], run_total: float, plan_charge: Mapping[str, int],
                        definitions: Mapping[str, Any]) -> None:
    """Set ``wait.also`` to the reason ``decide`` would give first for this
    run without the daily total, in the same order and on the same terms:
    a node with no list price, a model's own per-run limit, the per-run
    limit, then each finer budget (its USD amount, a model's budget in it,
    its Krea plan runs). Nothing when the run would otherwise go ahead."""
    if not usd_limited and not any(budget.plan_runs is not None for budget in finer):
        return
    if usd_limited and estimate["unpriced"]:
        awaiting = set(estimate.get("awaitingInput") or [])
        unlisted = [str(node_id) for node_id in estimate["unpriced"] if node_id not in awaiting]
        wait.also = ALSO_UNPRICED
        wait.unpriced = tuple(unlisted or [str(node_id) for node_id in estimate["unpriced"]])
        return

    def model_name(def_id: str) -> str:
        return (definitions.get(def_id) or {}).get("displayName") or def_id

    for def_id, amount in sorted(by_model.items(), key=lambda kv: -kv[1]):
        cap = (model_caps.get(def_id) or {}).get("perRunUsd")
        if cap is not None and amount >= cap:
            wait.also, wait.per_run_limit, wait.model = ALSO_MODEL_PER_RUN, cap, model_name(def_id)
            return
    general = sum(amount for def_id, amount in by_model.items() if (model_caps.get(def_id) or {}).get("perRunUsd") is None)
    if threshold is not None and general > 0 and general >= threshold:
        wait.also, wait.per_run_limit = ALSO_PER_RUN, threshold
        return
    run_plan = sum(plan_charge.values())
    for budget in finer:
        used = budget.spent
        owner = limit_owner(budget.who)
        if budget.usd is not None and run_total > 0 and used.total + run_total > budget.usd:
            wait.also, wait.per_run_limit, wait.owner = ALSO_LIMIT, budget.usd, owner
            return
        if budget.model_caps:
            for def_id, amount in by_model.items():
                model_budget = (model_caps.get(def_id) or {}).get("sessionUsd")
                if model_budget is not None and amount > 0 and used.models.get(def_id, 0.0) + amount > model_budget:
                    wait.also, wait.per_run_limit, wait.owner = ALSO_LIMIT, model_budget, owner
                    wait.model = model_name(def_id)
                    return
        if budget.plan_runs is not None and run_plan > 0 and used.plan_runs + run_plan > budget.plan_runs:
            wait.also, wait.plan_runs_limit, wait.owner = ALSO_PLAN_RUNS, budget.plan_runs, owner
            return


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
    sizes: Mapping[str, Mapping[str, Any]] | None = None,
    size_reasons: Mapping[str, str] | None = None,
    size_inputs: SizeInputs | None = None,
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
    variations). ``sizes`` are the measured inputs of nodes priced by their
    input's size (input_sizes.run_input_sizes), and ``size_reasons`` why
    each of the others wasn't measured (its ``reasons``), so the refusal says
    what is true: still to be made, a file on another host, a local file
    outside Nebula's output folder, unreadable, or not one wire.
    ``size_inputs`` names what is connected to a port with more than one
    input (SizeInputs), which that refusal lists."""
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
                                          model_pricing.wired_counts(list(items), edges), sizes)
    definition_of = {str(item["id"]): str(item.get("definitionId") or "") for item in items}
    # A node by its canvas title (review 18 M-D: the name the canvas shows).
    labels = {node_id: node_route.node_name(definitions.get(def_id), None) for node_id, def_id in definition_of.items()}

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
    # The daily total is a USD limit (Justin's Q165, 2026-10-31): with it on,
    # a node with no list price always waits for the person's OK, since
    # Nebula can't count it toward the total, even with no other limit set.
    finer = [budget for budget in budgets if not budget.daily]
    daily_on = any(budget.daily and budget.usd is not None for budget in budgets)
    usd_limited = (threshold is not None
                   or daily_on
                   or any(budget.usd is not None for budget in finer)
                   or any(v is not None for limits in model_caps.values() for v in limits.values()))

    # The daily total, first: a run that would pass it waits for the
    # person's OK as a proposal, whatever else it would need; so does one that
    # fits but has a node with no list price (``over`` False). Its other
    # reason, if it has one, is the one the checks below would give first.
    run_total = sum(by_model.values())
    for budget in budgets:
        if not (budget.daily and budget.usd is not None):
            continue
        over = run_total > 0 and budget.spent.total + run_total > budget.usd
        # A node with no list price asks, with room or not. One priced by an
        # input's size that can't be measured yet keeps its own refusal below
        # (it says why), as it did.
        awaiting = set(estimate.get("awaitingInput") or [])
        unlisted = [node_id for node_id in estimate["unpriced"] if node_id not in awaiting]
        if not over and not unlisted:
            continue
        wait = DailyWait(budget.usd, budget.spent.total, run_total,
                         names={str(node_id): label for node_id, label in labels.items()}, over=over)
        _first_other_reason(wait, usd_limited=usd_limited, estimate=estimate, by_model=by_model,
                            model_caps=model_caps, threshold=threshold, finer=finer, run_total=run_total,
                            plan_charge=plan_charge, definitions=definitions)
        return Decision(wait.refusal(how_to_ask), by_model, per_node, plan_charge, plan_per_node, wait=wait)

    if not usd_limited and not any(budget.plan_runs is not None for budget in finer):
        return decision(None)

    if usd_limited and estimate["unpriced"]:
        awaiting = [node_id for node_id in estimate["unpriced"] if node_id in (estimate.get("awaitingInput") or [])]
        unlisted = [node_id for node_id in estimate["unpriced"] if node_id not in awaiting]
        reasons = []
        if unlisted:
            reasons.append(f"Nebula has no list price for {_names(unlisted, labels)}, "
                           "so it can't check this run against the spending limits set in Nebula Settings.")
        if awaiting:
            reasons.extend(_awaiting_reasons(awaiting, size_reasons or {}, labels, definition_of, pricing,
                                              definitions, size_inputs))
        return refuse(" ".join(reasons))

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

    # Per budget: every finer total this run counts against.
    run_plan = sum(plan_charge.values())
    for budget in finer:
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


_PROPOSE_TAIL = "The person accepts on the canvas, and the canvas runs it."
_PROPOSE_CLI = "Propose it instead: `nebula propose --note \"<why>\" {targets}`. "
_PROPOSE_MCP = "Propose it instead with propose_change. "


def propose_hint(run_ids: list[str]) -> str:
    """The sentence pointing an agent at a proposal for these canvas nodes, in
    the CLI's words (the backend can't tell which surface asked). MCP's tools
    reword it for their reader (propose_hint_for_mcp): each surface names only
    its own call (GM - Design, PR #212 r2, item 3)."""
    targets = " ".join(f"--run {node_id}" for node_id in run_ids[:6]) or "--run <node>"
    return _PROPOSE_CLI.format(targets=targets) + _PROPOSE_TAIL


def propose_hint_for_mcp(message: str) -> str:
    """A refusal that carries propose_hint, in MCP's words: propose_change,
    with no `nebula` command. Everything else in it stays as it was."""
    start = message.find("Propose it instead: `nebula propose ")
    if start < 0:
        return message
    end = message.find("`. ", start)
    if end < 0:
        return message
    return message[:start] + _PROPOSE_MCP + message[end + 3:]
