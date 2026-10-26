"""Who reads a refusal, and the words they get (GM - Design, error-copy rounds 2 and 3).

GM: "People get the written line and agents keep the specific detail. Keep it
that way." A refusal is said twice: `specific`, the text an agent (MCP, the
CLI, a script) fixes its call with and the log keeps; and `person`, a line
written to GM's patterns for the person's UI. This is the one place that
decides which one a reply carries, for main.py, routes/commons.py and every
other router:

- The Commons routes decide by their actor (`actor=`): its UI session is the
  person (Actor.is_human), anyone else an agent. A human-only route
  (Depends(human_dep)) passes `actor=None`: only the person gets there.
- Every other route decides by the request (the default): a browser page
  (Origin, or Sec-Fetch-Site from the packaged desktop renderer; see main.py
  _from_a_browser) with no agent marker is the person, with or without this
  launch's person token, so a plain tab reads the line too.

It picks words, never authority. The specific text the person didn't read
goes to the log, without any URL's sign-in part.
"""
from __future__ import annotations

import logging
import re
from typing import Any, Callable

from fastapi import HTTPException

from services.agent_presence import current_request_headers
from services.person_gate import has_agent_marker

logger = logging.getLogger("nebula.refusals")

# The default for `actor`: decide by the request's headers.
BY_REQUEST: Any = object()


def gone(thing: str, things: str) -> str:
    """GM's 404 line (round 3): "That {thing} isn't there anymore. Reload to
    get the latest {things}.", with the thing named the way the UI names it."""
    return f"That {thing} isn't there anymore. Reload to get the latest {things}."


def gone_from_trash(thing: str) -> str:
    """GM's 404 pattern for something no longer in Recently deleted."""
    return f"That {thing} isn't in Recently deleted anymore. Reload to get the latest list."


def person_reads(actor: Any = BY_REQUEST) -> bool:
    """Whether the reply's words go to the person (see the module doc)."""
    if actor is not BY_REQUEST:
        return actor is None or bool(getattr(actor, "is_human", False))
    headers = current_request_headers() or {}
    if has_agent_marker(headers):
        return False
    lower = {str(key).lower() for key in headers}
    return "origin" in lower or "sec-fetch-site" in lower


_URL = re.compile(r"\b([a-zA-Z][a-zA-Z0-9+.-]*://)(?:[^\s/?#@]*@)?([^\s?#]*)(?:\?[^\s#]*)?(?:#\S*)?")


def log_safe(text: str) -> str:
    """`text` for the terminal: every URL without its sign-in part, query or
    fragment (a signed link the person pasted carries its key there)."""
    return _URL.sub(lambda m: m.group(1) + m.group(2), text)


def _log(route: str | None, specific: str) -> None:
    # WARNING: the backend configures no logging, so an INFO line is dropped.
    logger.warning("%s refused (the person was told written copy): %s", route or "request", log_safe(specific))


def refusal_detail(specific: str, person: str, *, actor: Any = BY_REQUEST, route: str | None = None,
                   log: Callable[[str | None, str], None] | None = None) -> str:
    """The detail a refusal carries: `person` for the person (the specific
    text then goes to the log), else `specific`, unchanged."""
    if not person_reads(actor):
        return specific
    (log or _log)(route, specific)
    return person


def refusal(status: int, specific: str, person: str, *, actor: Any = BY_REQUEST, route: str | None = None,
            log: Callable[[str | None, str], None] | None = None) -> HTTPException:
    """An HTTPException whose detail is refusal_detail(...)."""
    return HTTPException(status_code=status,
                         detail=refusal_detail(specific, person, actor=actor, route=route, log=log))


def not_found(specific: str, thing: str, things: str, **kwargs: Any) -> HTTPException:
    """A 404: gone(thing, things) for the person, `specific` for agents."""
    return refusal(404, specific, gone(thing, things), **kwargs)
