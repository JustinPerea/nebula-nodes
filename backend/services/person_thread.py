"""The Message box's thread: the person and the terminal Claude, per project.

GM - Design r50 (Justin's choice on 2026-11-03, option b of the demo
audit): a canvas-wide "Message Claude" box inside the Agent log. The person
writes; a Claude Code session listening through the Nebula channel
(mcp_channel.py, ``--channel``) is woken at once; it answers with
``reply_to_person``. The thread is kept on the project record,
``catalog["projects"][id]["personThread"]``, next to ``pins`` and
``agentNotes`` and outside ``snapshot`` (the browser's autosave never drops
it), so a reload and every tab show the same rows.

Rows, oldest first, at most ``MAX_ROWS``. Past it the oldest agent rows
go first, then the person's settled rows (an accepted message, a pin); a
message of theirs still ``sent`` or ``held`` is never trimmed, so an agent
replying in a loop can't push it out before its listener takes it (review
1 of #225, MEDIUM-2; replies are also paced per agent: ReplyPace).

- ``message``: the person's. ``{id, kind, at, text, nodeIds, to: {listenerId,
  agent, session: {key, ordinal}}, state, acceptedAt}``. ``state`` is
  ``sent`` until the recipient's listener has pushed it to the session
  (``accepted``, what "Waiting for Claude" reads: Nebula saw the listener
  take it, never a read receipt). ``clientId`` makes a resend of the same
  message (Try again after a lost answer) land once.
- ``reply``: an agent's, through reply_to_person. ``{id, kind, at, text,
  nodeId, agent, session, replyTo}``. ``replyTo`` names the push it
  answers (services/push_ledger.py, review 4): that push's newest message,
  else its first question set id; null for a follow-up that answers no
  push. The box clears that message's status and the ones before it, never
  a later one still in flight (review 1, NIT-4), and a question set id
  clears no message.
- Rows that point at what Nebula already keeps elsewhere, added only while
  that agent's session listens (what crosses the channel): ``question``
  (``questionId``, the questions as asked and, once it closes, ``outcome``:
  ``{status, closedAt, answers?}``, the person's own record of what they
  chose or typed, GM r79.5), ``proposal``
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
(the journal events then carry only ids: a message's ``to``, a reply's
``replyId``). Only the listener named in a
message's ``to`` is woken, whatever the switch. It reads its messages back
from ``inbox`` (the journal is not trusted to hold them), pushes them and
says so (``accept``).

Questions stay owner-scoped in the thread too (review 1, MEDIUM-1): every
agent reads a question row's ``questionId`` and ``agent``, but only the
asker reads the questions' text and options, as GET
/api/canvas/questions/{id} answers only the asker. A row's ``outcome``
holds the person's answer, which goes only to the asker through
question.answered and get_answers: no agent reads it here (agent_view
drops it for every agent), the way agent_questions keeps typed text out of
every agent route.

Sending is the person's alone (the route checks the person token): agents
write only replies. The 201st message to one listener in a rolling hour is
accepted and held, never refused (GM r55): PR A's listener holds a
deliberate send past its runaway cap of 200 an hour. The row reads
``held`` while Nebula knows it waits: the route marks it when that
listener already had ``SEND_CAP`` messages this hour (its push of each of
them falls inside the same hour, so the listener is sure to hold this one),
and the listener reports any other it holds (a pin or an answer can fill
its cap too, and one push can batch several messages, so a row marked
held may still go at once: the listener's accept then corrects it). Once
pushed it is ``accepted`` like any other; a held mark never reopens an
accepted row.
"""
from __future__ import annotations

import copy
import secrets
import threading
import time
from collections import deque
from typing import Any, Callable, Iterable, Mapping

from services.canvas_pins import agent_text, shown_text, text_length

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
# Rows an agent writes (or that point at an agent's act): trimmed first.
AGENT_ROWS = frozenset({"reply", "question", "proposal", "note", "pinReply"})
# reply_to_person's pace per agent (Justin, 2026-11-03: like the passive
# wakes): a burst of REPLY_BURST, then one every REPLY_EVERY seconds.
REPLY_BURST = 5
REPLY_EVERY = 2.0
REPLY_LIMITED_CODE = "replies_rate_limited"
# J1 (Justin, 2026-11-04): replying takes a Settings agent token, the same as
# listening. A name alone, an in-app agent's turn token, or a token Nebula no
# longer knows is refused (401) with one of these lines and codes. The token
# middleware (agent_workspaces) answers the revoked one on REPLIES_PATH.
REPLIES_PATH = "/api/canvas/thread/replies"
AGENT_THREAD_PREFIX = "/api/agent/thread/"  # the listener's own routes (inbox, accepted, held)
REPLY_NO_TOKEN_CODE = "reply_no_token"
REPLY_IN_APP_CODE = "reply_in_app_token"
REPLY_BAD_TOKEN_CODE = "reply_token_invalid"
# GM r94 (verbatim): the command on its own line.
CONNECT_CHANNEL_COMMAND = "nebula mcp connect claude-code --channel"
REPLY_NO_TOKEN_LINE = ("Nebula couldn’t post this reply because this agent has no token. Copy one from Settings › "
                       "Connect your agent, run this command, then reply again.\n" + CONNECT_CHANNEL_COMMAND +
                       "\nThe nebula CLI finds the token through NEBULA_APP_TOKEN_FILE, which this command sets up.")
REPLY_IN_APP_LINE = ("Nebula couldn’t post this reply because it uses an in-app agent’s token, and only an agent "
                     "connected from Settings › Connect your agent can reply in the Message box. Answer the person "
                     "in this chat instead.")
REPLY_BAD_TOKEN_LINE = ("Nebula couldn’t post this reply because its token isn’t valid anymore. Copy a new one from "
                        "Settings › Connect your agent, run this command, then reply again.\n" + CONNECT_CHANNEL_COMMAND)
# GM r110 (verbatim): a reply that answers no push, with no project open.
# Agents open a project themselves (open_project, its id from list_projects);
# open_project switches the person's canvas, so the docs say to open the
# project the person's message came from, never an unrelated one.
REPLY_NO_PROJECT_CODE = "no_project"
REPLY_NO_PROJECT_LINE = ("Nebula couldn’t post this reply because no project is open. Open one with open_project, "
                         "then reply again.")
# Round 5 (D2), GM r108 string 3: a reply from a terminal that isn't a
# listening session of this agent, while two or more of its sessions
# listen. Nebula saves it but won't guess which push it answers (replyTo
# None).
def reply_unmatched_line(name: str, count: int) -> str:
    return (f"Nebula posted this reply but couldn’t tell which message it answers because {count} {name} sessions "
            "are listening and this terminal isn’t one of them. Reply from the Claude Code the person messaged. To "
            "stop this, start each Claude Code with this command, which gives it its own session that its "
            "terminals share.\n" + CONNECT_CHANNEL_COMMAND)


# Review 4 (the push ledger): a reply that answers a push from another
# project than the open one ignores its node_id (the node is on that
# project's canvas, not the one the person sees), and says so.
def reply_node_elsewhere_line(node_id: str, project_name: str) -> str:
    return (f"Nebula posted this reply in “{project_name}” but didn’t point at {node_id} because that project "
            "isn’t open, so your cursor stayed where it was.")


# GM r100, r112.1: the Update a reply posts when it lands in another
# project's thread than the open one (the thread of the push it answers).
# One per agent and project while unread, counted from the second reply.
# An unnamed project reads “Untitled” (GM r108 d).
UNTITLED = "Untitled"


def replied_elsewhere_text(name: str, project_name: str, count: int = 1) -> str:
    shown = project_name.strip() or UNTITLED
    if count > 1:
        return f"{name} replied {count} times in “{shown}”."
    return f"{name} replied in “{shown}”."


def route_key(agent_id: str, session: str | None) -> str:
    """Which listener a message is for, stable across Nebula restarts: a
    digest of (agent, raw session). A listener id (an HMAC under a secret
    each backend process makes) changes when Nebula restarts, so a message
    "Sent" before a restart was never read back after it (review 4). Kept
    on the row as ``route``, which never leaves the backend."""
    import hashlib

    return hashlib.sha256(f"{agent_id}\0{session or ''}".encode("utf-8")).hexdigest()[:32]

# THE read rule (Justin, 2026-11-03: every connected agent reads the thread,
# as pins). False narrows the journal, the read tool and the cursor's say to
# the person plus each row's own agent.
AGENTS_READ_WHOLE_THREAD = True

# The person's lines (GM r50 and r55, verbatim; curly apostrophes).
HELD_LINE = "Sends in a few minutes because you’ve sent 200 this hour."
# A message whose listener's token the person revoked before it took the
# message (boundary LOW-1): never delivered, so it settles as ``dropped``
# (the box words it as the send-time "stopped listening" line).
DROPPED_STATE = "dropped"
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


def reply_event_data(row: Mapping[str, Any]) -> dict[str, Any]:
    """The thread.replied event's data: only the reply's id and the message
    it answers when narrowed.

    Every saved reply is journaled, whatever the switch: the replying
    agent's own channel listener counts it as an answer to the message it
    pushed (``replyTo``, set by Nebula: round 5, D1; its reply from any
    route, `nebula reply` in its shell too: Justin, 2026-11-04, PR A's
    ownReplies=1). Never a session key or a listener id: this event reaches
    every agent's feed. The ids say nothing of what the reply says."""
    if not AGENTS_READ_WHOLE_THREAD:
        return {"replyId": row.get("id"), "replyTo": row.get("replyTo")}
    return {"replyId": row.get("id"), "text": row.get("text"), "nodeId": row.get("nodeId"),
            "replyTo": row.get("replyTo")}


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


def _bump(row: dict[str, Any]) -> None:
    """A row changed: its ``rev`` goes up, so a tab keeps the newer copy
    whatever order a sync and a change reach it in (review 3, LOW-4)."""
    rev = row.get("rev")
    row["rev"] = (rev if isinstance(rev, int) and rev > 0 else 1) + 1


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


def _for_listener(row: Mapping[str, Any], listener_ids: set[str], route: str | None) -> bool:
    """Whether the person's message ``row`` is for this listener: by its
    ``route`` (agent and raw session, stable across a Nebula restart), else,
    for a row saved before routes, by its listener id."""
    if row.get("route"):
        return route is not None and row.get("route") == route
    return (row.get("to") or {}).get("listenerId") in listener_ids


def _in_flight(row: Mapping[str, Any]) -> bool:
    """The person's message its listener hasn't taken yet: never trimmed."""
    return row.get("kind") == "message" and row.get("state") in ("sent", "held")


def trim(rows: list[dict[str, Any]], limit: int | None = None) -> None:
    """Keep at most ``limit`` rows (MAX_ROWS): the oldest agent rows go
    first, then the person's settled rows; a message still in flight never
    goes (it may then run over, by at most the messages in flight)."""
    excess = len(rows) - (MAX_ROWS if limit is None else limit)
    if excess <= 0:
        return
    drop: set[int] = set()
    for wanted in (lambda row: row.get("kind") in AGENT_ROWS, lambda row: not _in_flight(row)):
        for index, row in enumerate(rows):
            if len(drop) >= excess:
                break
            if index not in drop and wanted(row):
                drop.add(index)
    rows[:] = [row for index, row in enumerate(rows) if index not in drop]


class ReplyPace:
    """reply_to_person's pace, per agent identity (memory only): a burst of
    ``burst`` replies, then one every ``every`` seconds (a token bucket).
    ``take`` returns 0 when a reply may go now (and counts it), else the
    seconds until one may."""

    def __init__(self, clock: Callable[[], float] = time.monotonic, *, burst: int = REPLY_BURST,
                 every: float = REPLY_EVERY, max_agents: int = 256) -> None:
        self._clock = clock
        self.burst = burst
        self.every = every
        self._max = max_agents
        self._tokens: dict[str, tuple[float, float]] = {}
        self._lock = threading.Lock()

    def take(self, agent_id: str) -> float:
        with self._lock:
            now = self._clock()
            tokens, at = self._tokens.pop(agent_id, (float(self.burst), now))
            tokens = min(float(self.burst), tokens + max(0.0, now - at) / self.every)
            if tokens >= 1.0:
                self._tokens[agent_id] = (tokens - 1.0, now)
                wait = 0.0
            else:
                self._tokens[agent_id] = (tokens, now)
                wait = (1.0 - tokens) * self.every
            while len(self._tokens) > self._max:  # the least recently used goes (it starts full again)
                del self._tokens[next(iter(self._tokens))]
            return wait


    def refund(self, agent_id: str) -> None:
        """Give back the reply take() counted, when Nebula then refused it
        (no project, a store failure): a refusal never spends one (live L1)."""
        with self._lock:
            held = self._tokens.get(agent_id)
            if held is not None:
                self._tokens[agent_id] = (min(float(self.burst), held[0] + 1.0), held[1])


def reply_limited_detail(wait: float) -> str:
    """The refusal an agent replying too fast gets: what happened, when it
    can reply again, and what to do instead."""
    seconds = max(1, int(-(-wait // 1)))
    return (f"Nebula couldn’t post this reply because replies are paced at {REPLY_BURST} in a row, then one every "
            f"{REPLY_EVERY:g} s. You can reply again in {seconds} s, so put everything you have to say in one reply.")


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
        mine = [agent_view(row, agent_id) for row in rows if visible_to_agent(row, agent_id)]
        return project_id, mine[-limit:]

    def inbox(self, listener_ids: Iterable[str], route: str | None = None
              ) -> tuple[str | None, list[dict[str, Any]]]:
        """Messages to this listener that no listener has taken yet, in
        every project (boundary LOW-2: the person may switch projects before
        the listener reads), the open project's first. Each names its
        project. Returns (the open project, messages). A message is this
        listener's by its ``route`` (agent and session, so one sent before
        a Nebula restart is still found after it), else, for a row saved
        before routes, by its listener id."""
        wanted = set(listener_ids)
        catalog = self._store().read()
        open_id = catalog.get("activeProjectId")
        projects = catalog.get("projects") or {}
        order = ([open_id] if open_id in projects else []) + [pid for pid in projects if pid != open_id]
        due = []
        for project_id in order:
            project = projects.get(project_id)
            rows = project.get(FIELD) if isinstance(project, dict) else None
            for row in rows if isinstance(rows, list) else []:
                if (isinstance(row, dict) and row.get("kind") == "message" and row.get("state") in ("sent", "held")
                        and _for_listener(row, wanted, route)):
                    due.append({"messageId": row["id"], "text": row.get("text") or "",
                                "nodeIds": list(row.get("nodeIds") or []), "projectId": project_id})
        return open_id, due

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
            trim(rows)
            if rows != before:
                store.commit(catalog)
        return project_id, result

    def _write_all(self, mutate: Callable[..., list[dict[str, Any]]], *, with_project: bool = False
                   ) -> list[tuple[str, list[dict[str, Any]]]]:
        """``mutate`` each project's thread in one transaction (``mutate(
        project_id, rows)`` with ``with_project``); the projects whose rows
        changed, with those rows (boundary LOW-2: a message is found by id
        wherever it was sent)."""
        store = self._store()
        changed: list[tuple[str, list[dict[str, Any]]]] = []
        with store.transaction() as catalog:
            for project_id, project in (catalog.get("projects") or {}).items():
                rows = project.get(FIELD) if isinstance(project, dict) else None
                if not isinstance(rows, list) or not rows:
                    continue
                result = mutate(project_id, rows) if with_project else mutate(rows)
                if result:
                    changed.append((project_id, result))
            if changed:
                store.commit(catalog)
        return changed

    def add_message(self, *, text: str, node_ids: list[str], to: dict[str, Any],
                    client_id: str | None = None, held: bool = False,
                    route: str | None = None) -> tuple[str, dict[str, Any], bool]:
        """(project id, row, new). A resend with the same client id returns the
        first row. ``held``: the listener is sure to hold it (SendCap).
        ``route``: route_key of its listener's agent and session."""
        row = {"id": _new_id("pm"), "kind": "message", "at": self._now_ms(), "text": text, "nodeIds": node_ids,
               "to": to, "state": "held" if held else "sent", "acceptedAt": None, "rev": 1}
        if route:
            row["route"] = route
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

    def accept(self, message_ids: Iterable[str], listener_ids: Iterable[str], route: str | None = None,
               agent_id: str | None = None, counted: dict[str, str] | None = None
               ) -> list[tuple[str, list[dict[str, Any]]]]:
        """The listener pushed these: mark them accepted, in whichever project
        each was sent. Only messages sent to the caller's own listener change
        (its ``route``, else one of ``listener_ids``). Returns [(project id,
        changed rows)]. ``counted`` gets, for the push ledger, each id that
        counts as this caller's push (id -> project): one it just accepted,
        or a re-send of one already accepted for this agent and this
        ``route`` (the listener reports its open pushes again after Nebula
        restarted, in the same session)."""
        wanted, own = set(message_ids), set(listener_ids)
        at = self._now_ms()

        def mutate(project_id: str, rows: list[dict[str, Any]]) -> list[dict[str, Any]]:
            changed = []
            for row in rows:
                if row.get("kind") != "message" or row.get("id") not in wanted:
                    continue
                if row.get("state") in ("sent", "held") and _for_listener(row, own, route):
                    row["state"] = "accepted"
                    row["acceptedAt"] = at
                    _bump(row)
                    changed.append(dict(row))
                    if counted is not None:
                        counted[row["id"]] = project_id
                elif (counted is not None and row.get("state") == "accepted" and agent_id and route is not None
                      and row.get("route") == route
                      and ((row.get("to") or {}).get("agent") or {}).get("id") == agent_id):
                    # A re-report counts only from the session the row was sent to (round 5c,
                    # MEDIUM-1): the route survives a restart, an invented session never matches.
                    counted[row["id"]] = project_id
            return changed

        return self._write_all(mutate, with_project=True)

    def hold(self, message_ids: Iterable[str], listener_ids: Iterable[str], route: str | None = None
             ) -> list[tuple[str, list[dict[str, Any]]]]:
        """The listener holds these at its runaway cap: mark them held (only
        the caller's own, and only while not yet pushed), in any project."""
        wanted, own = set(message_ids), set(listener_ids)

        def mutate(rows: list[dict[str, Any]]) -> list[dict[str, Any]]:
            changed = []
            for row in rows:
                if (row.get("kind") == "message" and row.get("id") in wanted and row.get("state") == "sent"
                        and _for_listener(row, own, route)):
                    row["state"] = "held"
                    _bump(row)
                    changed.append(dict(row))
            return changed

        return self._write_all(mutate)

    def drop_for(self, agent_id: str) -> list[tuple[str, list[dict[str, Any]]]]:
        """That agent is gone for good (its token was revoked, boundary
        LOW-1): its messages still in flight settle as dropped, in every
        project and every session, whether a listener of it was still
        registered or not. Never touches an accepted message."""
        own = agent_id

        def mutate(rows: list[dict[str, Any]]) -> list[dict[str, Any]]:
            changed = []
            for row in rows:
                if _in_flight(row) and ((row.get("to") or {}).get("agent") or {}).get("id") == own:
                    row["state"] = DROPPED_STATE
                    _bump(row)
                    changed.append(dict(row))
            return changed

        return self._write_all(mutate) if own else []

    def drop_route(self, agent_id: str, session: str | None, listener_id: str | None = None
                   ) -> list[tuple[str, list[dict[str, Any]]]]:
        """That one listener (agent and raw session) expired or stopped
        before taking these (round 5c, LOW-2): its messages still in flight
        settle as dropped, so the box reads its stopped line, not "Sent"
        forever. Never touches an accepted message or another session's.
        The row keeps ``lapsed``: the same session's listener coming back
        (a sleep, a reconnect) takes it after all (``revive_route``), as a
        message sent before a lapse always reached it."""
        route = route_key(agent_id, session)
        own = {listener_id} if listener_id else set()

        def mutate(rows: list[dict[str, Any]]) -> list[dict[str, Any]]:
            changed = []
            for row in rows:
                if _in_flight(row) and _for_listener(row, own, route):
                    row["state"] = DROPPED_STATE
                    row["lapsed"] = True
                    _bump(row)
                    changed.append(dict(row))
            return changed

        return self._write_all(mutate)

    def revive_route(self, agent_id: str, session: str | None) -> list[tuple[str, list[dict[str, Any]]]]:
        """A listener of that agent and session is back: the messages
        ``drop_route`` settled for its going away are sent again, so its
        inbox reads them. A revoked agent's dropped rows never come back."""
        route = route_key(agent_id, session)

        def mutate(rows: list[dict[str, Any]]) -> list[dict[str, Any]]:
            changed = []
            for row in rows:
                if (row.get("kind") == "message" and row.get("state") == DROPPED_STATE and row.get("lapsed")
                        and row.get("route") == route):
                    row["state"] = "sent"
                    row.pop("lapsed", None)
                    _bump(row)
                    changed.append(dict(row))
            return changed

        return self._write_all(mutate)

    def reply_target(self, ledger: Any = None, key: tuple[str, str | None] | None = None) -> str | None:
        """The project a reply from this listener session would go to now,
        without taking anything (the route checks its node against the
        open canvas only when that is where it goes). None: the open one."""
        if ledger is None or key is None:
            return None
        projects = (self._store().read().get("projects") or {})
        push = ledger.peek(key[0], key[1], lambda project: project is None or project in projects)
        return push.project() if push is not None else None

    def add_reply(self, fields: Mapping[str, Any], *, ledger: Any = None,
                  key: tuple[str, str | None] | None = None,
                  taker_session: Mapping[str, Any] | None = None) -> tuple[str, dict[str, Any]]:
        """An agent's reply. It answers the replying listener session's
        OLDEST open push in the push ledger (``key``: (agent id, raw
        session); services/push_ledger.py) whose project still exists:
        ``replyTo`` is that push's newest message, else its first question
        set, and the reply goes to that one's project (GM r100.3, r112.2:
        the person may have opened another project since). Nothing to
        answer: the open project's thread, ``replyTo`` None (a follow-up);
        no project open: refused (REPLY_NO_PROJECT_LINE). The push is
        marked answered only once the row is saved; a save that fails
        leaves it open. A reply that answers a push carries the taking
        listener's session (``taker_session``, the person's form), so one
        from the agent's own shell reads as that session. Its ``nodeId``
        stays only in the open project's thread (the node was checked on
        the open canvas)."""
        row = {"id": _new_id("pt"), "kind": "reply", "at": self._now_ms(), **fields, "replyTo": None, "rev": 1}
        store = self._store()
        token = secrets.token_hex(8)
        picked = None
        try:
            with store.transaction() as catalog:
                open_id = catalog.get("activeProjectId")
                projects = catalog.get("projects") or {}
                opened = open_id if open_id in projects else None
                if ledger is not None and key is not None:
                    # A push asked in no project (None) answers into the open one.
                    picked = ledger.claim(key[0], key[1], lambda project: (project or opened) in projects, token)
                project_id = opened
                if picked is not None:
                    row["replyTo"] = picked.reply_to()
                    project_id = picked.project() or opened
                    if taker_session and taker_session.get("key"):
                        row["session"] = copy.deepcopy(dict(taker_session))
                if not project_id or project_id not in projects:
                    raise ThreadError(409, REPLY_NO_PROJECT_LINE, REPLY_NO_PROJECT_CODE)
                if project_id != open_id:
                    row["nodeId"] = None
                project = projects[project_id]
                rows = project.get(FIELD)
                if not isinstance(rows, list):
                    rows = project[FIELD] = []
                rows.append(row)
                trim(rows)
                store.commit(catalog)
        except BaseException:
            if picked is not None:
                ledger.release(picked, token)
            raise
        if picked is not None:
            ledger.settle(picked, token, row["id"])
        return project_id, row

    def close_question(self, question_id: str, outcome: Mapping[str, Any], *,
                       project_id: str | None = None) -> tuple[str | None, list[dict[str, Any]]]:
        """A question set closed: its rows keep the outcome (person form
        only, GM r79.5), so "You chose …" survives any reload. Nothing
        changes when no row names the set."""
        kept = copy.deepcopy(dict(outcome))

        def mutate(rows: list[dict[str, Any]]) -> list[dict[str, Any]]:
            changed = []
            for row in rows:
                if row.get("kind") == "question" and row.get("questionId") == question_id:
                    row["outcome"] = copy.deepcopy(kept)
                    _bump(row)
                    changed.append(dict(row))
            return changed

        try:
            return self._write(mutate, project_id)
        except ThreadError:
            return None, []

    def add_row(self, kind: str, fields: Mapping[str, Any], *, project_id: str | None = None) -> tuple[str, dict[str, Any]]:
        if kind not in ROW_KINDS:
            raise ValueError(kind)
        row = {"id": _new_id("pt"), "kind": kind, "at": self._now_ms(), **fields, "rev": 1}
        project_id, _ = self._write(lambda rows: rows.append(row), project_id)
        return project_id, row


# Never outside the backend: a message's route (a digest of its listener's
# agent and raw session, route_key).
_SERVER_ONLY_KEYS = ("route", "lapsed")


def person_view(row: Mapping[str, Any]) -> dict[str, Any]:
    """A row as the person's tabs get it: every field but the route, the
    client id too (a tab matches its own pending send to the saved row by it)."""
    return {key: copy.deepcopy(value) for key, value in row.items() if key not in _SERVER_ONLY_KEYS}


# Never in an agent's form: the person's form only (cursor keys, listener
# ids, the tab's client id, a question's outcome, which holds their answer).
_PERSON_ONLY_KEYS = ("clientId", "session", "to", "outcome", *_SERVER_ONLY_KEYS)


def agent_view(row: Mapping[str, Any], viewer_id: str | None = None) -> dict[str, Any]:
    """A row as an agent reads it: no cursor keys or listener ids (those are
    the person's form), no client id; a message names the agent it was for.
    A question row keeps its id and agent for every agent, but its text and
    options only for the asker (``viewer_id``), and its outcome for none
    (review 1 of #225, MEDIUM-1; GM r79.5). Pin text is in agents' form
    (canvas_pins.agent_text, GM r23)."""
    shown = {key: copy.deepcopy(value) for key, value in row.items() if key not in _PERSON_ONLY_KEYS}
    if row.get("kind") == "question" and (viewer_id is None or row_agent_id(row) != viewer_id):
        shown.pop("questions", None)
    if row.get("kind") in ("pin", "pinReply") and isinstance(shown.get("text"), str):
        shown["text"] = agent_text(shown["text"])
    if row.get("kind") == "message":
        shown["from"] = "person"
        agent = (row.get("to") or {}).get("agent")
        if isinstance(agent, Mapping):
            shown["toAgent"] = dict(agent)
    return shown
