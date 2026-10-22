"""A node run error's line for the person (error copy round 3c, GM - Design).

A handler's exception text is the specific text: ids, record and parameter
names, what to call. Agents read it (MCP run results, the node's stored error,
the run record), so it stays exactly as it is. GM: "the person reads these on
the node, so their lines shouldn't carry ids or record names. ... The node's
error stores the specific text for agents (and the run record and MCP keep
it), and the canvas shows the written line. If a fact helps the person act,
put it in words, like "the node's Resume Operation ID field"."

So the handler attaches the person's line to the exception it raises
(``with_person_line``) and the engine carries it on the ErrorEvent as the
additive ``person`` field (execution/engine.py), beside ``error``. Only the
raised exception's own line counts: a wrapper that turns one failure into
another writes its own line, so a cause's line never leaks into a different
failure. A node error with no person line shows "Couldn't run the node." and
GM's general line on the card, the raw text behind "Details" (the frontend's
lib/nodeErrorCopy.ts).
"""
from __future__ import annotations

from typing import TypeVar

_ATTRIBUTE = "nebula_person_line"

E = TypeVar("E", bound=BaseException)


def with_person_line(exc: E, line: str) -> E:
    """Attach the person's line to `exc` and return it (``raise with_person_line(...)``)."""
    setattr(exc, _ATTRIBUTE, line)
    return exc


def person_line(exc: BaseException) -> str | None:
    """The person's line `exc` was raised with, or None (the card's fallback)."""
    line = getattr(exc, _ATTRIBUTE, None)
    return line.strip() if isinstance(line, str) and line.strip() else None
