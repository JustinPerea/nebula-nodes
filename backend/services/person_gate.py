"""Actions only the person may take from the Nebula canvas.

Pins are the person's notes to agents, and accepting a proposal is the
person's approval. An agent must not be able to do either for itself, even by
accident or because a prompt told it to.

Two checks, both required:

1. No agent markers. A request that carries ``Authorization: Agent ...``,
   ``X-Daedalus-Caller``, ``X-Nebula-Agent`` or ``X-Nebula-Client`` is refused,
   even when the token is invalid or expired. Something that claims to be an
   agent never counts as the person.
2. A browser. Browsers always send ``Origin`` on POST, PUT and DELETE (also
   same-origin, also through the Vite proxy); the ``nebula`` CLI, the MCP
   server and curl send none. The packaged desktop renderer may send
   ``Origin: null``, so in desktop mode the per-launch connector session the
   preload hands to trusted renderers counts instead.

In-app agents (Claude, Codex, Hermes) start with agent_child_env(), which
strips ``NEBULA_CONNECTOR_SESSION``, so they cannot borrow the desktop
session to pass check 2.

Remaining risk: every agent runs as the same OS user with a shell. A local
program that deliberately forges an ``Origin`` header passes check 2, and one
that reads the backend process's environment could find the desktop session.
These checks stop confused or prompt-injected agents using their normal tools,
not a malicious program on the same machine.
"""
from __future__ import annotations

import os
import secrets
from typing import Mapping

from services.local_guard import origin_allowed

AGENT_MARKER_HEADERS = ("x-daedalus-caller", "x-nebula-agent", "x-nebula-client")
CONNECTOR_SESSION_HEADER = "x-nebula-connector-session"


class PersonGateError(Exception):
    def __init__(self, status: int, detail: str) -> None:
        super().__init__(detail)
        self.status = status
        self.detail = detail


def desktop_session_matches(supplied: str | None) -> bool:
    """True in desktop mode when ``supplied`` is this launch's connector session."""
    expected = os.environ.get("NEBULA_CONNECTOR_SESSION")
    if os.environ.get("NEBULA_DESKTOP_MODE") != "1" or not expected or not supplied:
        return False
    return secrets.compare_digest(supplied.encode(), expected.encode())


def has_agent_marker(headers: Mapping[str, str] | None) -> bool:
    lower = {k.lower(): v for k, v in (headers or {}).items()}
    if lower.get("authorization", "").strip().lower().startswith("agent "):
        return True
    return any(lower.get(name) for name in AGENT_MARKER_HEADERS)


def is_browser_request(headers: Mapping[str, str] | None) -> bool:
    lower = {k.lower(): v for k, v in (headers or {}).items()}
    if desktop_session_matches(lower.get(CONNECTOR_SESSION_HEADER)):
        return True
    origin = lower.get("origin")
    # origin_allowed() lets a missing Origin through (non-browser clients),
    # so require its presence here.
    return origin is not None and origin_allowed(origin)


def require_person(headers: Mapping[str, str] | None) -> None:
    """Raise PersonGateError(403) unless this request came from the person's canvas."""
    if has_agent_marker(headers):
        raise PersonGateError(403, "Only the person can do this from the Nebula canvas.")
    if not is_browser_request(headers):
        raise PersonGateError(403, "This action only works from the Nebula canvas.")
