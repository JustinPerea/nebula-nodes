"""The push ledger: which of a session's deliberate pushes a reply answers.

Review 4 of #225 (HIGH-1, MEDIUM-1, MEDIUM-4), coordinator decision
2026-11-04, adversarially checked. A --channel listener (mcp_channel.py)
pushes the person's messages and the answers to its questions to its
Claude Code session, then reports each push (POST
/api/agent/thread/accepted, with ``messageIds`` and ``questionIds``). Nebula
records one push per report here, keyed by (agent id, raw session): never
by a listener id or a cursor's session key, both HMACs under a secret each
backend process makes, so a ledger keyed by them would lose a session's
pushes to an eviction or a listener restart.

A reply from session S answers S's OLDEST pickable push no reply has
answered yet (the listener reports pushes while Claude is busy, and Claude
Code queues them, so oldest first follows the order Claude answers in).
``replyTo`` is that push's newest message id, else its first question set
id; the listener removes the push holding it (mcp_channel._answer_group).
A push is marked answered only once the reply row is saved
(``claim`` -> ``settle``, or ``release`` when saving failed), and two
replies racing claim two different pushes.

The cap mirrors the listener's (mcp_channel.DELIBERATE_SPAN_CAP; a test
keeps them equal): pushes split into periods wherever the gap to the
previous push is more than the cap. Only the latest period's pushes are
pickable. The cap ends the listener's protected turn only (round 5c, LOW-1):
an unanswered push stays pickable for a late reply (an 11-minute edit still
answers its message and lands in its project) for ``KEEP_SECONDS`` (24 h,
long enough for any working session to come back, short enough that a
forgotten push doesn't outlive the day), or until answered. The listener is
only told of pushes still within the cap (``open_pushes``). Memory only: a
restarted Nebula has none, and the listener reports its open pushes again
after the journal reset.

One agent's churn only ever evicts its own keys (MAX_KEYS_PER_AGENT, as
channel_listeners.MAX_PER_AGENT), so no token can push another's open pushes
out. Past MAX_PUSHES in a session, answered pushes go first, then unanswered
ones whose span is over; while MAX_PUSHES are unanswered and in span a new
push is not recorded (the listener holds it at the same count: a runaway
holds, never drops the oldest).

Sessions are a convenience boundary inside one token, not an auth
boundary: any holder of the token can name any session. The ledger only
keeps one Claude Code's replies from settling another's pushes by mistake.
"""
from __future__ import annotations

import threading
import time
from dataclasses import dataclass, field
from typing import Any, Callable, Iterable

DELIBERATE_SPAN_CAP = 600.0  # mcp_channel.DELIBERATE_SPAN_CAP
MAX_PUSHES = 64   # per (agent, session); mcp_channel.MAX_OPEN_PUSHES holds a push at this many open
MAX_KEYS_PER_AGENT = 8  # sessions kept per agent: its own least recently written go first
KEEP_SECONDS = 24 * 3600.0  # an unanswered push stays pickable this long (a late reply)
MESSAGE = "message"
QUESTION = "question"


@dataclass
class LedgerPush:
    ids: list[str]                 # message ids, then question set ids, in push order
    kinds: dict[str, str]          # id -> MESSAGE or QUESTION
    projects: dict[str, str | None]  # id -> the project it was sent or asked in (None: the open one)
    at: float
    answered: str | None = None    # the reply that answered it
    pending: str | None = field(default=None, repr=False)  # a claim not settled yet

    def reply_to(self) -> str:
        """The id a reply to this push names: its newest message, else its first question set."""
        messages = [item for item in self.ids if self.kinds.get(item) == MESSAGE]
        return messages[-1] if messages else self.ids[0]

    def project(self) -> str | None:
        return self.projects.get(self.reply_to())

    def open(self) -> bool:
        return self.answered is None and self.pending is None


class PushLedger:
    def __init__(self, clock: Callable[[], float] = time.time, cap: float = DELIBERATE_SPAN_CAP,
                 keep: float = KEEP_SECONDS) -> None:
        self._clock = clock
        self.cap = cap
        self.keep = keep
        self._lock = threading.Lock()
        self._pushes: dict[tuple[str, str], list[LedgerPush]] = {}

    def _live(self, key: tuple[str, str], now: float) -> list[LedgerPush]:
        """The pushes of ``key`` still kept (lock held): none older than ``keep``."""
        pushes = [push for push in self._pushes.get(key) or [] if now - push.at <= self.keep]
        if pushes:
            self._pushes[key] = pushes
        else:
            self._pushes.pop(key, None)
        return pushes

    def _period(self, key: tuple[str, str], now: float) -> list[LedgerPush]:
        """The pickable pushes of ``key``: the latest period, where a gap
        longer than the cap to the previous push starts a new one (lock held)."""
        pushes = self._live(key, now)
        start = len(pushes)
        while start > 0 and (start == len(pushes) or pushes[start].at - pushes[start - 1].at <= self.cap):
            start -= 1
        return pushes[start:]

    def record(self, agent_id: str, session: str | None,
               items: Iterable[tuple[str, str, str | None]]) -> bool:
        """One push the listener reported: (id, MESSAGE or QUESTION, project)
        in push order. A retry with the same id set (the report's own retry)
        adds nothing. Returns whether a push was recorded (False too when the
        session holds MAX_PUSHES unanswered pushes still in span)."""
        kept = [(str(i), kind, project) for i, kind, project in items if i and kind in (MESSAGE, QUESTION)]
        if not kept:
            return False
        ids = list(dict.fromkeys(i for i, _, _ in kept))
        key = (agent_id, session or "")
        now = self._clock()
        with self._lock:
            pushes = self._live(key, now)
            if any(set(push.ids) == set(ids) for push in pushes):
                return False
            if len(pushes) >= MAX_PUSHES:
                # Make room: an answered push first, then an unanswered one
                # whose span is over; never one still in span.
                victim = next((p for p in pushes if p.answered is not None), None) or next(
                    (p for p in pushes if p.pending is None and now - p.at > self.cap), None)
                if victim is None:
                    return False
                pushes.remove(victim)
            pushes.append(LedgerPush(ids=ids, kinds={i: kind for i, kind, _ in kept},
                                     projects={i: project for i, _, project in kept}, at=now))
            self._pushes.pop(key, None)
            self._pushes[key] = pushes  # the most recently written last
            own = [k for k in self._pushes if k[0] == agent_id]
            for old in own[:max(0, len(own) - MAX_KEYS_PER_AGENT)]:  # only this agent's own keys go
                del self._pushes[old]
            return True

    def _oldest(self, key: tuple[str, str], usable: Callable[[str | None], bool]) -> LedgerPush | None:
        for push in self._period(key, self._clock()):
            if push.open() and usable(push.project()):
                return push
        return None

    def peek(self, agent_id: str, session: str | None,
             usable: Callable[[str | None], bool] = lambda _project: True) -> LedgerPush | None:
        """The push a reply from this session would answer now, unclaimed."""
        with self._lock:
            return self._oldest((agent_id, session or ""), usable)

    def claim(self, agent_id: str, session: str | None, usable: Callable[[str | None], bool],
              token: str) -> LedgerPush | None:
        """Take the oldest open push whose project ``usable`` keeps, for a
        reply being saved (compare-and-set: a racing reply takes the next)."""
        with self._lock:
            push = self._oldest((agent_id, session or ""), usable)
            if push is not None:
                push.pending = token
            return push

    def settle(self, push: LedgerPush, token: str, reply_id: str) -> bool:
        """The reply row was saved: the claimed push is answered."""
        with self._lock:
            if push.pending != token:
                return False
            push.pending, push.answered = None, reply_id
            return True

    def release(self, push: LedgerPush, token: str) -> None:
        """Saving the reply failed: the push is open again."""
        with self._lock:
            if push.pending == token:
                push.pending = None

    def open_pushes(self, agent_id: str, session: str | None) -> list[dict[str, Any]]:
        """The session's pickable pushes no reply has answered, for a listener
        restarted in that session (the first beat of a new nonce)."""
        now = self._clock()
        with self._lock:
            return [{"ids": list(push.ids),
                     "messageIds": [i for i in push.ids if push.kinds.get(i) == MESSAGE],
                     "questionIds": [i for i in push.ids if push.kinds.get(i) == QUESTION],
                     "at": int(push.at * 1000), "ageSeconds": round(max(0.0, now - push.at), 3)}
                    for push in self._period((agent_id, session or ""), now)
                    if push.answered is None and now - push.at <= self.cap]

    def forget_agent(self, agent_id: str) -> None:
        """Its token was revoked: its sessions' pushes go."""
        with self._lock:
            for key in [key for key in self._pushes if key[0] == agent_id]:
                del self._pushes[key]
