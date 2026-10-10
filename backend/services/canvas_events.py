"""What changed on the canvas, and who changed it, for agents that are waiting.

Agents used to learn about the person's edits only by re-running
``nebula look``. This module keeps a short in-memory journal of canvas
changes (nodes added or removed, params set, wires, moves, selection, runs,
and later pins and proposals) with the actor behind each one:

- ``{"kind": "agent", id, name, color, verified}`` for an identified agent,
- ``{"kind": "person"}`` for the browser (an allowed ``Origin`` header),
- ``{"kind": "anonymous"}`` for anything else (an unnamed CLI, curl, tests).
  Without this third kind an unnamed script's edit would be reported to other
  agents as "the person did X".
- ``{"kind": "system"}`` for Nebula itself (a proposal expiring).

``GET /api/canvas/events`` reads it as a long-poll: it answers at once when
newer events exist and otherwise waits (bounded) for the next one.

Everything is bounded and memory-only: a ring buffer of ``MAX_EVENTS``,
``MAX_EVENT_BYTES`` per event, a wait cap and a waiter cap. A backend restart
starts a new journal (a new ``journal_id``), and clients that still hold the
old one are told to re-read the canvas.

Threading: every publisher runs on the event-loop thread (async routes and
execution callbacks). Waiters are woken through their own loop, so a publish
from another thread or loop is still safe.
"""
from __future__ import annotations

import asyncio
import json
import secrets
import time
from collections import OrderedDict, deque
from typing import Any, Callable, Mapping

from services.agent_presence import AgentIdentity, identify
from services.local_guard import origin_allowed
from services.selection_context import _safe_value as safe_value

MAX_EVENTS = 500
WAIT_CAP_SECONDS = 25.0
MAX_BATCH = 100
DEFAULT_BATCH = 50
MAX_WAITERS = 32
MAX_EVENT_BYTES = 4096
MOVE_THRESHOLD_PX = 8.0
MAX_VALUE_CHARS = 160
MAX_SUMMARY_CHARS = 200
MAX_LISTED_IDS = 50
MAX_TRACKED_RUNS = 256

EVENT_KINDS = frozenset({
    "node.added",
    "node.removed",
    "node.params",
    "node.moved",
    "edge.added",
    "edge.removed",
    "selection.changed",
    "run.started",
    "run.finished",
    "run.failed",
    "run.cancelled",
    "canvas.replaced",
    "canvas.cleared",
    "pin.added",
    "pin.resolved",
    "pin.removed",
    "pin.detached",
    "proposal.created",
    "proposal.accepted",
    "proposal.rejected",
    "proposal.withdrawn",
    "proposal.expired",
    "proposal.invalidated",
})
EVENT_GROUPS = frozenset(kind.split(".", 1)[0] for kind in EVENT_KINDS)

ANONYMOUS: dict[str, Any] = {"kind": "anonymous"}
PERSON: dict[str, Any] = {"kind": "person"}


class TooManyWaiters(RuntimeError):
    """More long-polls are open than ``MAX_WAITERS``."""


# -- actors ---------------------------------------------------------------

def actor_for_identity(identity: AgentIdentity) -> dict[str, Any]:
    return {"kind": "agent", **identity.as_dict()}


def actor_for_headers(headers: Mapping[str, str] | None) -> dict[str, Any]:
    """Who sent this request: a named agent, the person's browser, or nobody we know."""
    identity = identify(headers)
    if identity is not None:
        return actor_for_identity(identity)
    lower = {k.lower(): v for k, v in (headers or {}).items()}
    origin = lower.get("origin")
    # local_guard treats a missing Origin as allowed (non-browser clients),
    # so check for its presence first: only a browser sends one.
    if origin is not None and origin_allowed(origin):
        return dict(PERSON)
    return dict(ANONYMOUS)


def actor_label(actor: Mapping[str, Any] | None) -> str:
    actor = actor or {}
    if actor.get("kind") == "agent":
        return str(actor.get("name") or "Agent")
    if actor.get("kind") == "person":
        return "Person"
    if actor.get("kind") == "system":  # Nebula itself, e.g. a proposal expiring
        return "Nebula"
    return "Unnamed client"


# -- payload bounds -------------------------------------------------------

def _cap_strings(value: Any) -> Any:
    if isinstance(value, str):
        return value if len(value) <= MAX_VALUE_CHARS else value[:MAX_VALUE_CHARS] + "…"
    if isinstance(value, dict):
        return {str(k): _cap_strings(v) for k, v in value.items()}
    if isinstance(value, (list, tuple)):
        return [_cap_strings(v) for v in value]
    return value


def _size(data: Any) -> int:
    return len(json.dumps(data, ensure_ascii=False, default=str))


def _bound_data(data: Mapping[str, Any] | None) -> dict[str, Any]:
    """Cap strings, then shrink anything still over MAX_EVENT_BYTES."""
    bounded = _cap_strings(dict(data or {}))
    if _size(bounded) <= MAX_EVENT_BYTES:
        return bounded
    if "values" in bounded:
        bounded.pop("values")
        bounded["valuesOmitted"] = True
        if _size(bounded) <= MAX_EVENT_BYTES:
            return bounded
    keys = bounded.get("keys")
    if isinstance(keys, list):
        return {"keys": keys[:MAX_LISTED_IDS], "count": len(keys), "valuesOmitted": True}
    # A publisher passed something unexpectedly large: keep only the scalars.
    small = {k: v for k, v in bounded.items() if isinstance(v, (bool, int, float)) or v is None}
    small["omitted"] = True
    return small


def param_changes(before: Mapping[str, Any] | None, after: Mapping[str, Any] | None) -> dict[str, Any] | None:
    """The params whose value changed, with redacted values, or None when nothing changed.

    The browser PUTs whole-param snapshots, so diffing is what turns "saved the
    inspector" into "changed the prompt". Underscore keys are editor
    bookkeeping (e.g. `_paperSource`), not something an agent acts on, so they
    are left out. A removed key reports the value None.
    """
    before = before or {}
    after = after or {}
    keys = sorted(
        str(key)
        for key in set(before) | set(after)
        if not str(key).startswith("_") and before.get(key) != after.get(key)
    )
    if not keys:
        return None
    values = {key: safe_value(after.get(key), key=key) for key in keys[:MAX_LISTED_IDS]}
    return {"keys": keys[:MAX_LISTED_IDS], "values": values}


def matches(event: Mapping[str, Any], kinds: set[str] | None, exclude_actor_id: str | None) -> bool:
    kind = str(event.get("kind", ""))
    if kinds and kind not in kinds and kind.split(".", 1)[0] not in kinds:
        return False
    actor = event.get("actor") or {}
    if exclude_actor_id is not None and actor.get("kind") == "agent" and actor.get("id") == exclude_actor_id:
        return False
    return True


def parse_kinds(raw: str | None) -> set[str] | None:
    """`pin,proposal,node.params` → a set of groups and exact kinds. ValueError on unknown names."""
    if raw is None or not raw.strip():
        return None
    kinds: set[str] = set()
    for part in raw.split(","):
        name = part.strip()
        if not name:
            continue
        if name not in EVENT_KINDS and name not in EVENT_GROUPS:
            raise ValueError(f"unknown event kind '{name[:40]}'")
        kinds.add(name)
    return kinds or None


# -- the journal ----------------------------------------------------------

class CanvasEventJournal:
    def __init__(self, clock: Callable[[], float] = time.time, max_events: int = MAX_EVENTS) -> None:
        self.journal_id = secrets.token_hex(6)
        self._clock = clock
        self._events: deque[dict[str, Any]] = deque(maxlen=max_events)
        self._seq = 0
        self._project_id: str | None = None
        self._project_known = False
        # One (loop, Event) per open long-poll. Each waiter owns its Event so
        # waiters on different loops never share a loop-bound primitive.
        self._waiters: set[tuple[asyncio.AbstractEventLoop, asyncio.Event]] = set()
        self._run_actors: OrderedDict[str, dict[str, Any]] = OrderedDict()
        self._run_seen: OrderedDict[str, set[tuple[str, str]]] = OrderedDict()

    # -- project ----------------------------------------------------------
    @property
    def project_known(self) -> bool:
        return self._project_known

    @property
    def project_id(self) -> str | None:
        return self._project_id

    def set_project(self, project_id: str | None) -> None:
        self._project_id = project_id
        self._project_known = True

    # -- publish ----------------------------------------------------------
    @property
    def latest(self) -> int:
        return self._seq

    @property
    def oldest(self) -> int:
        """Seq of the oldest event still buffered (latest + 1 when empty)."""
        return self._events[0]["seq"] if self._events else self._seq + 1

    def publish(
        self,
        kind: str,
        *,
        actor: Mapping[str, Any],
        node_id: str | None = None,
        data: Mapping[str, Any] | None = None,
        summary: str = "",
    ) -> dict[str, Any]:
        if kind not in EVENT_KINDS:
            raise ValueError(f"unknown canvas event kind '{kind}'")
        self._seq += 1
        event: dict[str, Any] = {
            "seq": self._seq,
            "at": int(self._clock() * 1000),
            "kind": kind,
            "actor": dict(actor or ANONYMOUS),
            "projectId": self._project_id,
            "data": _bound_data(data),
            "summary": " ".join(str(summary or "").split())[:MAX_SUMMARY_CHARS],
        }
        if node_id is not None:
            event["nodeId"] = str(node_id)[:128]
        self._events.append(event)
        self._wake()
        return event

    def _wake(self) -> None:
        waiters, self._waiters = self._waiters, set()
        try:
            current = asyncio.get_running_loop()
        except RuntimeError:
            current = None
        for loop, signal in waiters:
            try:
                if loop is current:
                    signal.set()
                else:
                    loop.call_soon_threadsafe(signal.set)
            except RuntimeError:  # the waiter's loop already closed
                pass

    # -- read -------------------------------------------------------------
    def read(
        self,
        *,
        after: int | None,
        journal: str | None = None,
        limit: int = DEFAULT_BATCH,
        kinds: set[str] | None = None,
        exclude_actor_id: str | None = None,
    ) -> dict[str, Any]:
        limit = max(1, min(int(limit), MAX_BATCH))
        reset = journal is not None and journal != self.journal_id
        if reset:
            after = 0  # a new backend: start at the beginning of its buffer
        elif after is None:
            after = self._seq  # "from now"
        after = max(0, min(int(after), self._seq))
        oldest = self.oldest
        gap = not reset and after < oldest - 1

        events: list[dict[str, Any]] = []
        cursor = after
        more = False
        for event in self._events:
            if event["seq"] <= after:
                continue
            if not matches(event, kinds, exclude_actor_id):
                if len(events) < limit:
                    cursor = event["seq"]
                continue
            if len(events) >= limit:
                more = True
                break
            events.append(event)
            cursor = event["seq"]
        if not more:
            cursor = max(cursor, self._seq)
        return {
            "journal": self.journal_id,
            "cursor": cursor,
            "oldest": oldest,
            "latest": self._seq,
            "gap": gap,
            "reset": reset,
            "more": more,
            "timedOut": False,
            "projectId": self._project_id,
            "events": events,
        }

    async def wait(
        self,
        *,
        after: int | None,
        journal: str | None = None,
        wait: float = 0.0,
        limit: int = DEFAULT_BATCH,
        kinds: set[str] | None = None,
        exclude_actor_id: str | None = None,
    ) -> dict[str, Any]:
        """Read, and if nothing matches yet, wait up to `wait` seconds for a matching event."""
        wait = max(0.0, min(float(wait), WAIT_CAP_SECONDS))
        result = self.read(after=after, journal=journal, limit=limit, kinds=kinds,
                           exclude_actor_id=exclude_actor_id)
        if result["events"] or result["reset"] or result["gap"] or wait <= 0:
            return result
        if len(self._waiters) >= MAX_WAITERS:
            raise TooManyWaiters(f"at most {MAX_WAITERS} watchers can wait at once")
        loop = asyncio.get_running_loop()
        deadline = loop.time() + wait
        while True:
            remaining = deadline - loop.time()
            if remaining <= 0:
                return {**result, "timedOut": True}
            signal = asyncio.Event()
            entry = (loop, signal)
            self._waiters.add(entry)
            try:
                await asyncio.wait_for(signal.wait(), remaining)
            except asyncio.TimeoutError:
                pass
            finally:
                self._waiters.discard(entry)
            # Resume after what we already scanned, so skipped events (our own,
            # or other kinds) never wake us into a busy loop.
            result = self.read(after=result["cursor"], journal=self.journal_id, limit=limit,
                               kinds=kinds, exclude_actor_id=exclude_actor_id)
            if result["events"] or result["gap"]:
                return result

    @property
    def waiting(self) -> int:
        return len(self._waiters)

    # -- runs -------------------------------------------------------------
    def note_run(self, run_id: str | None, actor: Mapping[str, Any]) -> None:
        """Remember who started a run so its node events carry that actor."""
        if not run_id:
            return
        self._run_actors[run_id] = dict(actor)
        self._run_actors.move_to_end(run_id)
        while len(self._run_actors) > MAX_TRACKED_RUNS:
            self._run_actors.popitem(last=False)

    def run_actor(self, run_id: str | None) -> dict[str, Any]:
        if run_id and run_id in self._run_actors:
            return dict(self._run_actors[run_id])
        return dict(ANONYMOUS)

    def first_run_event(self, run_id: str | None, node_id: str, kind: str) -> bool:
        """True the first time (run, node, kind) is seen; batch variants repeat events."""
        if not run_id:
            return True
        seen = self._run_seen.get(run_id)
        if seen is None:
            seen = self._run_seen[run_id] = set()
            while len(self._run_seen) > MAX_TRACKED_RUNS:
                self._run_seen.popitem(last=False)
        key = (node_id, kind)
        if key in seen:
            return False
        seen.add(key)
        return True

    def forget_run(self, run_id: str | None) -> None:
        if run_id:
            self._run_seen.pop(run_id, None)


canvas_events = CanvasEventJournal()
