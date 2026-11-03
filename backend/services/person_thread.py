"""The Message box's thread: the person and the terminal Claude, per project.

GM - Design r50 (Justin's choice on 2026-11-03, option b of the demo
audit): a canvas-wide "Message Claude" box inside the Agent log. The person
writes; a Claude Code session listening through the Nebula channel
(mcp_channel.py, ``--channel``) is woken at once; it answers with
``reply_to_person``. The thread is kept on the project record,
``catalog["projects"][id]["personThread"]``, next to ``pins`` and
``agentNotes`` and outside ``snapshot`` (the browser's autosave never drops
it), so a reload and every tab show the same rows.

Rows, oldest first, at most ``MAX_ROWS`` (the oldest go first):

- ``message``: the person's. ``{id, kind, at, text, nodeIds, to: {listenerId,
  agent, session: {key, ordinal}}, state, acceptedAt}``. ``state`` is
  ``sent`` until the recipient's listener has pushed it to the session
  (``accepted``, what "Waiting for Claude" reads: Nebula saw the listener
  take it, never a read receipt). ``clientId`` makes a resend of the same
  message (Try again after a lost answer) land once.
- ``reply``: an agent's, through reply_to_person. ``{id, kind, at, text,
  nodeId, agent, session}``.
- Rows that point at what Nebula already keeps elsewhere, added only while
  that agent's session listens (what crosses the channel): ``question``
  (``questionId`` and the questions as asked), ``proposal``
  (``proposalId``), ``note`` (an Update it posted, ``noteId``), ``pinReply``
  (its reply on a pin) and, from the person while any session listens,
  ``pin`` (a note they pinned, with its text and node).

Who reads what (ONE rule, ``AGENTS_READ_WHOLE_THREAD``, read by
``visible_to_agent``, ``message_event_data`` and ``reply_event_data``):
Justin decided on 2026-11-03 that every connected agent reads the thread,
the same as pins: the person's messages and every agent's replies, through
the journal (``person.message`` and ``thread.replied`` events) and the
thread read tool (MCP read_thread, ``nebula thread``). Flipping the switch
to False narrows all three at once to the person plus a row's own agent
(the journal events then carry no data). Only the listener named in a
message's ``to`` is woken, whatever the switch. It reads its messages back
from ``inbox`` (the journal is not trusted to hold them), pushes them and
says so (``accept``).

Sending is the person's alone (the route checks the person token): agents
write only replies. The 201st message to one listener in a rolling hour is
accepted and held, never refused (GM r55): PR A's listener holds a
deliberate send past its runaway cap of 200 an hour. The row reads
``held`` while Nebula knows it waits: the route marks it when that
listener already had ``SEND_CAP`` messages this hour (its push of each of
them falls inside the same hour, so the listener is sure to hold this one),
and the listener reports any other it holds (a pin or an answer can fill
its cap too). Once pushed it is ``accepted`` like any other.
"""
from __future__ import annotations

import copy
import secrets
import threading
import time
from collections import deque
from typing import Any, Callable, Iterable, Mapping

from services.canvas_pins import shown_text, text_length

MAX_ROWS = 300
MAX_TEXT = 2000
MAX_NODE_IDS = 20
MAX_QUESTIONS_SHOWN = 5
SEND_CAP = 200          # messages in a rolling hour (GM r50 "Pacing")
SEND_WINDOW = 3600.0
FIELD = "personThread"
# The journal kind a send wakes listeners with (mcp_channel.MESSAGE_KIND; a test keeps them equal).
MESSAGE_EVENT = "person.message"
ROW_KINDS = ("message", "reply", "question", "proposal", "note", "pin", "pinReply")
# Rows only the person reads when the thread is narrowed (no agent owns them): a pin they left.
PERSON_ROWS = frozenset({"pin"})
# The journal kind a reply is announced with (every agent reads it while the thread is open to all).
REPLY_EVENT = "thread.replied"

# THE read rule (Justin, 2026-11-03: every connected agent reads the thread,
# as pins). False narrows the journal, the read tool and the cursor's say to
# the person plus each row's own agent.
AGENTS_READ_WHOLE_THREAD = True

# The person's lines (GM r50 and r55, verbatim; curly apostrophes).
HELD_LINE = "Sends in a few minutes because you’ve sent 200 this hour."
STOPPED_LINE = ("Nebula couldn’t send your message because Claude stopped listening. Reconnect it in the "
                "terminal, then send it again.")
STOPPED_CODE = "listener_stopped"


class ThreadError(Exception):
    def __init__(self, status: int, detail: str, code: str | None = None, person: str | None = None) -> None:
        super().__init__(detail)
        self.status = status
        self.detail = detail
        self.code = code
        self.person = person


def row_agent_id(row: Mapping[str, Any]) -> str | None:
    """The agent a row belongs to: a message's recipient, else its author."""
    if row.get("kind") == "message":
        agent = (row.get("to") or {}).get("agent") or {}
    else:
        agent = row.get("agent") or {}
    value = agent.get("id") if isinstance(agent, Mapping) else None
    return value if isinstance(value, str) and value else None


def visible_to_agent(row: Mapping[str, Any], agent_id: str) -> bool:
    """THE read rule for agents (see the module docstring)."""
    if AGENTS_READ_WHOLE_THREAD:
        return True
    if row.get("kind") in PERSON_ROWS:
        return False
    return row_agent_id(row) == agent_id


def message_event_data(row: Mapping[str, Any]) -> dict[str, Any]:
    """The person.message journal event's data (PR A's form) while every agent
    reads the thread; nothing but the recipient's listener id otherwise."""
    to = (row.get("to") or {}).get("listenerId")
    if not AGENTS_READ_WHOLE_THREAD:
        return {"to": to}
    return {"messageId": row.get("id"), "text": row.get("text"), "nodeIds": list(row.get("nodeIds") or []),
            "to": to}


def reply_event_data(row: Mapping[str, Any]) -> dict[str, Any] | None:
    """The thread.replied event's data, or None (no event) when narrowed."""
    if not AGENTS_READ_WHOLE_THREAD:
        return None
    return {"replyId": row.get("id"), "text": row.get("text"), "nodeId": row.get("nodeId")}


def say_reaches_agents() -> bool:
    """Whether the reply's first sentence rides on the cursor's agent form too."""
    return AGENTS_READ_WHOLE_THREAD


def clean_message(raw: Any) -> str:
    """The person's text as stored and shown: lines kept, hidden characters
    dropped (the pin note's rule), 1..MAX_TEXT characters."""
    if not isinstance(raw, str):
        raise ThreadError(422, "text must be text")
    text = shown_text(raw, multiline=True).strip()
    if not text:
        raise ThreadError(422, "text can't be empty")
    if text_length(text) > MAX_TEXT:
        raise ThreadError(422, f"text must be {MAX_TEXT} characters or fewer", "too_long")
    return text


def clean_reply(raw: Any) -> str:
    if not isinstance(raw, str):
        raise ThreadError(422, "text must be text")
    text = shown_text(raw, multiline=True).strip()
    if not text:
        raise ThreadError(422, "text can't be empty: say something, or don't call reply_to_person")
    if text_length(text) > MAX_TEXT:
        raise ThreadError(422, f"text must be {MAX_TEXT} characters or fewer: say it shorter, or post_note")
    return text


def clean_node_ids(raw: Any) -> list[str]:
    if raw is None:
        return []
    if not isinstance(raw, list) or not all(isinstance(item, str) for item in raw):
        raise ThreadError(422, "nodeIds must be a list of node ids")
    kept: list[str] = []
    for item in raw:
        item = item.strip()[:128]
        if item and item not in kept:
            kept.append(item)
    return kept[:MAX_NODE_IDS]


def first_sentence(text: str, limit: int = 140) -> str:
    """The reply's first sentence for the cursor's say (GM r50): up to the
    first . ! ? or line break, at most ``limit`` characters."""
    line = " ".join(text.splitlines()[0].split()) if text else ""
    for index, ch in enumerate(line):
        if ch in ".!?" and (index + 1 == len(line) or line[index + 1] == " "):
            line = line[: index + 1]
            break
    if len(line) > limit:
        line = line[: limit - 1].rstrip() + "…"
    return line


def _new_id(prefix: str) -> str:
    return f"{prefix}_{secrets.token_hex(6)}"


class SendCap:
    """The rolling-hour count of the person's messages, per listener (memory only)."""

    def __init__(self, clock: Callable[[], float] = time.time, cap: int = SEND_CAP) -> None:
        self._clock = clock
        self.cap = cap
        self._sent: dict[str, deque[float]] = {}
        self._lock = threading.Lock()

    def _trim(self, listener_id: str, now: float) -> deque[float]:
        sent = self._sent.setdefault(listener_id, deque())
        while sent and now - sent[0] >= SEND_WINDOW:
            sent.popleft()
        return sent

    def full(self, listener_id: str) -> bool:
        """Whether this listener already had ``cap`` messages this hour: it holds the next."""
        with self._lock:
            return len(self._trim(listener_id, self._clock())) >= self.cap

    def take(self, listener_id: str) -> None:
        with self._lock:
            self._trim(listener_id, self._clock()).append(self._clock())
            for key in [k for k, v in self._sent.items() if not v]:
                del self._sent[key]

    def count(self, listener_id: str) -> int:
        with self._lock:
            return len(self._trim(listener_id, self._clock()))


class PersonThread:
    """The rows, read from and written to the project record."""

    def __init__(self, store: Callable[[], Any], clock: Callable[[], float] = time.time) -> None:
        self._store = store
        self._clock = clock

    def _now_ms(self) -> int:
        return int(self._clock() * 1000)

    # -- reading -----------------------------------------------------------
    def rows(self, project_id: str | None = None) -> tuple[str | None, list[dict[str, Any]]]:
        """(project id, rows) of ``project_id``, else the open project."""
        catalog = self._store().read()
        if project_id is None:
            project_id = catalog.get("activeProjectId")
        project = (catalog.get("projects") or {}).get(project_id) if project_id else None
        if not isinstance(project, dict):
            return None, []
        rows = [row for row in project.get(FIELD) or [] if isinstance(row, dict) and row.get("kind") in ROW_KINDS]
        return project_id, rows

    def for_agent(self, agent_id: str, *, limit: int = 50) -> tuple[str | None, list[dict[str, Any]]]:
        project_id, rows = self.rows()
        mine = [agent_view(row) for row in rows if visible_to_agent(row, agent_id)]
        return project_id, mine[-limit:]

    def inbox(self, listener_ids: Iterable[str]) -> tuple[str | None, list[dict[str, Any]]]:
        """Messages to these listeners that no listener has taken yet."""
        wanted = set(listener_ids)
        project_id, rows = self.rows()
        due = [row for row in rows if row.get("kind") == "message" and row.get("state") in ("sent", "held")
               and (row.get("to") or {}).get("listenerId") in wanted]
        return project_id, [{"messageId": row["id"], "text": row.get("text") or "",
                             "nodeIds": list(row.get("nodeIds") or [])} for row in due]

    # -- writing -----------------------------------------------------------
    def _write(self, mutate: Callable[[list[dict[str, Any]]], Any], project_id: str | None = None) -> tuple[str, Any]:
        store = self._store()
        with store.transaction() as catalog:
            if project_id is None:
                project_id = catalog.get("activeProjectId")
            if not project_id or project_id not in catalog["projects"]:
                raise ThreadError(409, "Open or create a project first: the thread is kept with a project",
                                  "no_project")
            project = catalog["projects"][project_id]
            rows = project.get(FIELD)
            if not isinstance(rows, list):
                rows = project[FIELD] = []
            before = copy.deepcopy(rows)
            result = mutate(rows)
            if len(rows) > MAX_ROWS:
                del rows[: len(rows) - MAX_ROWS]
            if rows != before:
                store.commit(catalog)
        return project_id, result

    def add_message(self, *, text: str, node_ids: list[str], to: dict[str, Any],
                    client_id: str | None = None, held: bool = False) -> tuple[str, dict[str, Any], bool]:
        """(project id, row, new). A resend with the same client id returns the
        first row. ``held``: the listener is sure to hold it (SendCap)."""
        row = {"id": _new_id("pm"), "kind": "message", "at": self._now_ms(), "text": text, "nodeIds": node_ids,
               "to": to, "state": "held" if held else "sent", "acceptedAt": None}
        if client_id:
            row["clientId"] = client_id

        def mutate(rows: list[dict[str, Any]]) -> tuple[dict[str, Any], bool]:
            if client_id:
                for old in rows:
                    if old.get("kind") == "message" and old.get("clientId") == client_id:
                        return old, False
            rows.append(row)
            return row, True

        project_id, (kept, new) = self._write(mutate)
        return project_id, kept, new

    def accept(self, message_ids: Iterable[str], listener_ids: Iterable[str]) -> tuple[str, list[dict[str, Any]]]:
        """The listener pushed these: mark them accepted. Only messages sent to
        one of ``listener_ids`` (the caller's own) change."""
        wanted, own = set(message_ids), set(listener_ids)
        at = self._now_ms()

        def mutate(rows: list[dict[str, Any]]) -> list[dict[str, Any]]:
            changed = []
            for row in rows:
                if (row.get("kind") == "message" and row.get("id") in wanted
                        and row.get("state") in ("sent", "held")
                        and (row.get("to") or {}).get("listenerId") in own):
                    row["state"] = "accepted"
                    row["acceptedAt"] = at
                    changed.append(dict(row))
            return changed

        return self._write(mutate)

    def hold(self, message_ids: Iterable[str], listener_ids: Iterable[str]) -> tuple[str, list[dict[str, Any]]]:
        """The listener holds these at its runaway cap: mark them held (only
        the caller's own, and only while not yet pushed)."""
        wanted, own = set(message_ids), set(listener_ids)

        def mutate(rows: list[dict[str, Any]]) -> list[dict[str, Any]]:
            changed = []
            for row in rows:
                if (row.get("kind") == "message" and row.get("id") in wanted and row.get("state") == "sent"
                        and (row.get("to") or {}).get("listenerId") in own):
                    row["state"] = "held"
                    changed.append(dict(row))
            return changed

        return self._write(mutate)

    def add_row(self, kind: str, fields: Mapping[str, Any], *, project_id: str | None = None) -> tuple[str, dict[str, Any]]:
        if kind not in ROW_KINDS:
            raise ValueError(kind)
        row = {"id": _new_id("pt"), "kind": kind, "at": self._now_ms(), **fields}
        project_id, _ = self._write(lambda rows: rows.append(row), project_id)
        return project_id, row


def person_view(row: Mapping[str, Any]) -> dict[str, Any]:
    """A row as the person's tabs get it: every field, the client id too (a
    tab matches its own pending send to the saved row by it)."""
    return copy.deepcopy(dict(row))


def agent_view(row: Mapping[str, Any]) -> dict[str, Any]:
    """A row as an agent reads it: no cursor keys or listener ids (those are
    the person's form), no client id; a message names the agent it was for."""
    shown = {key: copy.deepcopy(value) for key, value in row.items()
             if key not in ("clientId", "session", "to")}
    if row.get("kind") == "message":
        shown["from"] = "person"
        agent = (row.get("to") or {}).get("agent")
        if isinstance(agent, Mapping):
            shown["toAgent"] = dict(agent)
    return shown
