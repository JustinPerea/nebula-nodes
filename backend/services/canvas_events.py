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
import unicodedata
from collections import OrderedDict, deque
from typing import Any, Callable, Mapping

from services.agent_presence import AgentIdentity, identify
from services.person_gate import is_person
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
    "node.renamed",
    "edge.added",
    "edge.removed",
    "selection.changed",
    "run.started",
    "run.finished",
    "run.failed",
    "run.skipped",
    "run.cancelled",
    "canvas.replaced",
    "canvas.cleared",
    "pin.added",
    "pin.resolved",
    "pin.removed",
    "pin.detached",
    # The undo of a node's delete put the note back on it (GM, 2026-10-23):
    # data {pinId, text, anchor}.
    "pin.reattached",
    "proposal.created",
    "proposal.accepted",
    "proposal.rejected",
    "proposal.withdrawn",
    "proposal.expired",
    "proposal.invalidated",
    # The undo of a node's delete put back what an invalidated proposal needs,
    # and it still fits, so it is open again (same id, same expiry).
    "proposal.reopened",
    # Questions an agent asked the person (services/agent_questions.py; Q125
    # item 1): data {questionId, agentId, count}. Never the questions' text
    # and never the person's answers: those reach only the agent that asked.
    "question.asked",
    "question.answered",
    "question.dismissed",
    "question.withdrawn",
    # Moodboards (services/moodboard_edits.py): one event per board edit
    # batch or PUT that changed its images, cards or frames, with data
    # {boardId, boardName, scope, refs, kinds}, and one board.fields event
    # when it changed the board's own fields.
    "board.added",
    "board.removed",
    "board.moved",
    "board.resized",
    "board.grouped",
    "board.setAside",
    "board.noted",
    "board.frame",
    # The image the board opens on changed (a cover pick; nothing moves).
    "board.cover",
    # The board's own fields changed (Direction, Avoid, pinned colours, its
    # notes, Send notes, strength...): data {boardId, boardName, scope,
    # fields}, the field names only, never a value (Justin's Q91).
    "board.fields",
    "board.sorted",
    "board.arranged",
    "board.suggested",
    # Styles (presets, main.py /api/presets and /api/trash): one event per
    # write, with data {styleId, styleName, scope} (+ fields for an update).
    "style.created",
    "style.updated",
    "style.deleted",
    "style.restored",
    "style.purged",
    # Updates (services/agent_notes.py): one event per update an agent or
    # Nebula posts, data {surface, boardId?, noteId, about, refs, text}.
    # Marking read and dismissing aren't journaled.
    "note.posted",
    # An undo or redo of a whole edit (an agent's undo_canvas_edit, or the
    # person's Cmd+Z of a step the canvas knew the edit of), after the node
    # and wire events it made. data {editId, of?, events?, ...}; see
    # services/canvas_undo.py.
    "edit.undone",
    "edit.redone",
    # Projects outside the canvas graph: a cover pinned, changed or set back
    # to automatic, with data {projectId, projectName, cover} (main
    # _set_project_cover; U16).
    "project.cover",
    # Commons curation, by the person or an accepted proposal (routes/commons.py
    # curation_listeners; Q63 b): data {assetId, fieldPath, op} for a
    # correction, {assetId, regionId, change} for a region, {assetId,
    # membershipId, collectionId, change} for a membership. Never Commons text.
    "commons.corrected",
    "commons.region",
    "commons.membership",
    # Saved projects (main.py, next to _broadcast_projects_changed), whoever
    # changed them: data {projectId, name; from/to for a rename; wasOpen}.
    "project.created",
    "project.renamed",
    "project.deleted",
    "project.restored",
    # Nebula found catalog.json damaged and restored it (services/
    # project_store.py _restore): data {id, kind (restored | rebuilt), reason,
    # source (the copy, or null for a rebuild), folder, damagedFile and
    # setAside (file names in that folder), addedBack [{id, name}],
    # addedBackCount, notAddedBackCount, projectCount}.
    "project.catalogRestored",
    # The live canvas wasn't a project in the list (after a restore, or a
    # crash between state.json and catalog.json) and was saved as its own
    # (main._note_canvas_settled), or from its copy held aside when a
    # project opened over it (main._note_held_filed, held true): data
    # {projectId, name, from (the project it was, or null), restoreId (the
    # restore it came from, or null), held?}.
    "project.canvasFiled",
    # It couldn't be: the list is at a limit. Nothing in it is lost (Nebula
    # keeps it, also across restarts), no project is open, the person can't
    # see or open it, opening a project holds it aside first, and the next
    # listing with room files it: data
    # {reason (projects | storage), from, restoreId, since (when it began
    # waiting)}.
    "project.canvasNotFiled",
    # A paid start Nebula holds (World Labs recovery checkpoints and starts it
    # couldn't confirm) and its clearing: data {hold, change, runId, ...}.
    "provider.hold",
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
    """Who sent this request: a named agent, the person, or nobody we know.

    The person is the launch's person token (services/person_gate.py), not
    an Origin header: any local program can write one, and the journal must
    not credit an agent's edit to the person."""
    identity = identify(headers)
    if identity is not None:
        return actor_for_identity(identity)
    if is_person(headers):
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


def actor_record(actor: Mapping[str, Any] | None) -> dict[str, str]:
    """Who did something, as a saved record keeps it: ``{kind, name}``.

    Recently deleted (services/asset_trash.py, project_store) uses it for
    "deleted by". Only ``kind`` says who it was: the person is ``person``
    (named "You"), an agent is ``agent`` with the name it gave. An outside
    agent picks its own name, so a name proves nothing; every display labels
    an agent from ``kind`` ("Claude (agent)", frontend lib/trash.ts
    actorLabel, cli/commands/trash.py), and only ``kind == "person"`` reads
    as "you". This is attribution, never permission (services/person_gate.py)."""
    actor = actor or {}
    kind = str(actor.get("kind") or "")
    if kind not in ("agent", "person", "system"):
        kind = "anonymous"
    if kind == "person":
        return {"kind": kind, "name": "You"}
    name = clean_actor_name(actor_label(actor))
    return {"kind": kind, "name": name or ("Agent" if kind == "agent" else actor_label({"kind": kind}))}


_HIDDEN_CATEGORIES = frozenset({"Cc", "Cf", "Co", "Cs"})


def clean_actor_name(raw: Any, limit: int = 64) -> str:
    """A name as attribution stores it: NFKC (fullwidth letters become
    plain ones), no control, format (zero-width, bidi override), private-use
    or surrogate characters, whitespace collapsed, at most ``limit`` chars."""
    text = unicodedata.normalize("NFKC", str(raw or ""))
    text = "".join(ch for ch in text if unicodedata.category(ch) not in _HIDDEN_CATEGORIES)
    return " ".join(text.split())[:limit].strip()


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
        # Where the open project comes from (follow): the catalog, in main.
        self._project_source: Callable[[], str | None] | None = None
        # One (loop, Event) per open long-poll. Each waiter owns its Event so
        # waiters on different loops never share a loop-bound primitive.
        self._waiters: set[tuple[asyncio.AbstractEventLoop, asyncio.Event]] = set()
        self._run_actors: OrderedDict[str, dict[str, Any]] = OrderedDict()
        self._run_seen: OrderedDict[str, set[tuple[str, str]]] = OrderedDict()
        # A run the person approved by accepting a proposal: run id -> proposal id.
        self._run_proposals: OrderedDict[str, str] = OrderedDict()

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

    @property
    def following(self) -> bool:
        return self._project_source is not None

    def follow(self, source: Callable[[], str | None]) -> None:
        """Take the open project from ``source`` (main: the catalog's
        projection, ProjectStore.projection) each time an event is published
        or the journal is read, instead of from set_project. The tag then
        changes where the open project is committed, by any route or process:
        a "Recovered canvas" filed by GET /api/projects (no graph broadcast)
        was never tagged before, and a pin the person added between a
        switch's commit and its broadcast was tagged with the project left
        (review 5 of PR #114, M1)."""
        self._project_source = source
        self._project_known = True

    def _current_project(self) -> str | None:
        """The open project now; the last one known when the source can't say
        (an unreadable catalog): the journal never fails over its tag."""
        if self._project_source is not None:
            try:
                self._project_id = self._project_source()
            except Exception:  # noqa: BLE001 - see above
                pass
        return self._project_id

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
        edit: Mapping[str, Any] | None = None,
        project_id: str | None | object = ...,
    ) -> dict[str, Any]:
        """``edit`` names the canvas edit behind the event (services/canvas_undo.py):
        ``{id}`` for an agent's edit, plus ``undoes`` or ``redoes`` (the edit id it
        reverts or applies again) and ``of`` (whose edit that was) for an undo.
        ``project_id``: the project the change was made in, when the caller
        knows it (a pin's own project); otherwise the project open now."""
        if kind not in EVENT_KINDS:
            raise ValueError(f"unknown canvas event kind '{kind}'")
        tag = self._current_project() if project_id is ... else project_id
        self._seq += 1
        event: dict[str, Any] = {
            "seq": self._seq,
            "at": int(self._clock() * 1000),
            "kind": kind,
            "actor": dict(actor or ANONYMOUS),
            "projectId": tag,
            "data": _bound_data(data),
            "summary": " ".join(str(summary or "").split())[:MAX_SUMMARY_CHARS],
        }
        if node_id is not None:
            event["nodeId"] = str(node_id)[:128]
        if edit:
            event["edit"] = _cap_strings(dict(edit))
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
            "projectId": self._current_project(),
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
                # The project open now: one opened during the wait without an event (a recovery) counts.
                return {**result, "timedOut": True, "projectId": self._current_project()}
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

    def seqs_of_edit(self, edit_id: str, *, skip_kinds: frozenset[str] = frozenset()) -> list[int]:
        """The buffered events of one canvas edit (``edit.id``), oldest first,
        but those of a kind in ``skip_kinds``."""
        return [seq for seq, _kind in self.events_of_edit(edit_id, skip_kinds=skip_kinds)]

    def events_of_edit(self, edit_id: str, *, skip_kinds: frozenset[str] = frozenset()) -> list[tuple[int, str]]:
        """``seqs_of_edit`` with each event's kind: (seq, kind)."""
        return [(event["seq"], str(event.get("kind"))) for event in self._events
                if (event.get("edit") or {}).get("id") == edit_id and event.get("kind") not in skip_kinds]

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

    def note_run_proposal(self, run_id: str | None, proposal_id: str) -> None:
        """This run is the one an Accept approved: its run events name the proposal."""
        if not run_id or not proposal_id:
            return
        self._run_proposals[run_id] = proposal_id
        self._run_proposals.move_to_end(run_id)
        while len(self._run_proposals) > MAX_TRACKED_RUNS:
            self._run_proposals.popitem(last=False)

    def run_proposal(self, run_id: str | None) -> str | None:
        return self._run_proposals.get(run_id) if run_id else None

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
            self._run_proposals.pop(run_id, None)


canvas_events = CanvasEventJournal()
