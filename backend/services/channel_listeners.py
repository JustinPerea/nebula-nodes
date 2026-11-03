"""Channel readiness: which Claude Code sessions are listening to the canvas.

An MCP server started with ``--channel`` (mcp_channel.py, docs/MCP-SETUP.md
"Claude Code channels (experiment)") says so to Nebula: once Claude Code is
ready it posts ``POST /api/agent/channel`` every ``BEAT_SECONDS`` while it
runs, with ``state`` "listening" or, once its listener has stopped (2 h with
nothing from the person, or a failure), "stopped" and the ``reason``. It
deletes its entry when its session ends. An entry with no word for
``TTL_SECONDS`` (the process was killed, Nebula restarted) is gone.

So the canvas can tell three things apart (GM r50, the Message box's lines):

- no entry for a session: **not connected** (never started with the
  channel, or that session ended);
- ``state: "stopped"``: **the listener stopped** while the session runs on
  (/mcp > nebula-listen > Reconnect starts it again);
- ``state: "listening"``: connected and accepting pushes.

Nebula can't see whether Claude Code delivers a push (it never acknowledges
one): a session started without ``--dangerously-load-development-channels``,
or one whose org keeps Channels off, still reads "listening". The docs say so.

Each entry is one agent session: the agent identity plus the session its
requests name (agent_presence.presence_session), the same pair that gives it
its own cursor. Nebula gives each a ``listenerId`` (random, kept while the
entry lives): a message the person sends one session names it, and only that
listener wakes. The person's tabs also get the session's cursor key and
number, so "Message Claude · 2" names the cursor it reaches; agents only ever
read their own entries, without cursor keys (those are the person's form).
Memory only, never saved.
"""
from __future__ import annotations

import secrets
import threading
import time
from dataclasses import dataclass
from typing import Any, Callable

from services.agent_presence import AgentIdentity

BEAT_SECONDS = 15.0  # how often a listener says it is there
TTL_SECONDS = 45.0   # an entry with no word this long is gone (three beats)
MAX_LISTENERS = 64   # entries kept; past this the least recently heard goes
STATES = ("listening", "stopped")
REASONS = ("idle", "error")


class ListenerError(ValueError):
    pass


@dataclass
class Listener:
    listener_id: str
    agent: AgentIdentity
    session: str  # the raw session id ("" for none); never leaves the backend
    state: str
    reason: str | None
    project_id: str | None
    since: float     # when it entered this state
    seen_at: float   # its last word


def parse_beat(body: Any) -> tuple[str, str | None, str | None]:
    """(state, reason, project id) from a POST body."""
    if not isinstance(body, dict):
        raise ListenerError("Send {state: listening|stopped, reason?, projectId?}")
    state = body.get("state")
    if state not in STATES:
        raise ListenerError("state must be listening or stopped")
    reason = body.get("reason")
    if state == "listening":
        reason = None
    elif reason not in REASONS:
        reason = "error"
    project = body.get("projectId")
    project = project if isinstance(project, str) and 0 < len(project) <= 128 else None
    return state, reason, project


class ListenerBook:
    def __init__(self, clock: Callable[[], float] = time.time) -> None:
        self._clock = clock
        self._lock = threading.Lock()
        self._entries: dict[tuple[str, str], Listener] = {}
        self.revision = 0

    def now(self) -> float:
        return self._clock()

    def beat(self, agent: AgentIdentity, session: str | None, *, state: str, reason: str | None,
             project_id: str | None) -> tuple[Listener, bool]:
        """A listener's word. Returns its entry and whether anything the
        person's tabs show changed (a new entry, a new state or reason)."""
        now = self._clock()
        key = (agent.id, session or "")
        with self._lock:
            self._expire(now)
            entry = self._entries.get(key)
            changed = False
            if entry is None:
                if len(self._entries) >= MAX_LISTENERS:
                    oldest = min(self._entries, key=lambda k: self._entries[k].seen_at)
                    del self._entries[oldest]
                entry = Listener(listener_id="ch_" + secrets.token_hex(8), agent=agent, session=key[1],
                                 state=state, reason=reason, project_id=project_id, since=now, seen_at=now)
                self._entries[key] = entry
                changed = True
            else:
                if (entry.state, entry.reason) != (state, reason):
                    entry.state, entry.reason, entry.since = state, reason, now
                    changed = True
                if entry.agent != agent or entry.project_id != project_id:
                    entry.agent, entry.project_id = agent, project_id
                    changed = True
                entry.seen_at = now
            if changed:
                self.revision += 1
            return entry, changed

    def gone(self, agent: AgentIdentity, session: str | None) -> bool:
        """Its session ended. Returns whether there was an entry."""
        with self._lock:
            removed = self._entries.pop((agent.id, session or ""), None) is not None
            if removed:
                self.revision += 1
            return removed

    def _expire(self, now: float) -> bool:
        stale = [key for key, entry in self._entries.items() if now - entry.seen_at > TTL_SECONDS]
        for key in stale:
            del self._entries[key]
        if stale:
            self.revision += 1
        return bool(stale)

    def sweep(self) -> bool:
        """Drop entries past TTL_SECONDS. Returns whether any went."""
        with self._lock:
            return self._expire(self._clock())

    def next_deadline(self) -> float | None:
        with self._lock:
            if not self._entries:
                return None
            return min(entry.seen_at for entry in self._entries.values()) + TTL_SECONDS

    def entries(self) -> list[Listener]:
        with self._lock:
            self._expire(self._clock())
            return sorted(self._entries.values(), key=lambda e: e.since)

    def by_listener_id(self, listener_id: str) -> Listener | None:
        """The entry a message names (PR C's send route), if it still lives."""
        return next((entry for entry in self.entries() if entry.listener_id == listener_id), None)

    def for_agent(self, agent_id: str) -> list[Listener]:
        return [entry for entry in self.entries() if entry.agent.id == agent_id]


def view(entry: Listener, *, session: dict[str, Any] | None = None) -> dict[str, Any]:
    """One listener as the readiness answers show it. ``session`` (the
    cursor's {key, ordinal}) only in the person's form."""
    shown: dict[str, Any] = {
        "listenerId": entry.listener_id,
        "agent": entry.agent.as_dict(),
        "state": entry.state,
        "reason": entry.reason,
        "projectId": entry.project_id,
        "since": int(entry.since * 1000),
        "seenAt": int(entry.seen_at * 1000),
    }
    if session is not None:
        shown["session"] = session
    return shown
