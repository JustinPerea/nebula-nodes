"""Who started the run a node is part of, for the one check made at a call:
an agent's run stops at an Idol node that would call Hugging Face with the
person's token set (Justin decided, 2026-10-31: only that call is gated,
never the rest of the run; handlers/speridlabs_idol.run_idol).

Each run route records the origin of the request that started it, read the
way every person-only check reads it (main._is_person_request, the person
gate), and runs the graph inside :func:`running`. The record is a ContextVar,
so every node task of that run sees it and no other run does. A run started
anywhere else carries none, and a check that finds none fails closed, as if
an agent had started it.
"""
from __future__ import annotations

import contextlib
from contextvars import ContextVar
from dataclasses import dataclass
from typing import Iterator


@dataclass(frozen=True)
class RunOrigin:
    """``person``: the person started the run (their own Run, or the run an
    Accept approved, which only the person's tab can start). ``surface``: the
    agent's surface for the proposal it is pointed at (agent_words: "mcp" or
    "cli"). ``ask``: how the agent proposes this run instead, when it has no
    canvas node to name (a quick run's: main._quick_propose_hint); None
    points at the stopped node's own id."""

    person: bool
    surface: str = "mcp"
    ask: str | None = None


_origin: ContextVar[RunOrigin | None] = ContextVar("run_origin", default=None)


class ProposalNeeded(RuntimeError):
    """A node of an agent's run stopped at its call, before any request,
    because only the person may make that call: the agent proposes the run
    instead. The engine marks the node's ErrorEvent ``proposal_needed`` and
    the agent's done card says it stopped, not that it failed. Raise it only
    before the node's first request."""


@contextlib.contextmanager
def running(origin: RunOrigin) -> Iterator[None]:
    """Run a graph as started by ``origin``."""
    token = _origin.set(origin)
    try:
        yield
    finally:
        _origin.reset(token)


def current() -> RunOrigin | None:
    """The origin of the run this task belongs to, or None when it wasn't recorded."""
    return _origin.get()


def by_person() -> bool:
    """Whether the person started this run. False when the origin is unknown
    (fail closed)."""
    origin = _origin.get()
    return bool(origin is not None and origin.person)
