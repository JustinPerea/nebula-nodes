"""Actions only the person may take, and how Nebula tells the person apart.

Pins are the person's notes to agents, accepting a proposal is the person's
approval, and the spending limits, Settings, provider keys and the Krea
connection are the person's to change. Runs the person starts aren't held to
the agent spending limits. An agent must not be able to do any of this for
itself, even by accident or because a prompt told it to.

Two checks, both required:

1. No agent markers. A request that carries ``Authorization: Agent ...``,
   ``X-Daedalus-Caller``, ``X-Nebula-Agent`` or ``X-Nebula-Client`` is refused,
   even when the token is invalid or expired and even with a valid person
   token. Something that claims to be an agent never counts as the person.
2. This launch's person token (services/person_session.py) in the
   ``X-Nebula-Person`` header. The canvas gets it from the link the dev
   launcher prints (or opens), or from Electron main over IPC. An ``Origin``
   header proves nothing here: any local program can write one. Origins are
   checked only by LocalRequestGuard, which keeps websites (CSRF, DNS
   rebinding) away from the backend.

With no person session (desktop stdin missing, or a debugging port open),
nothing counts as the person.

What this does and doesn't protect. The limits and person-only actions bind
agents that reach Nebula only through its API: in-app Claude, in-app Codex
and Hermes once their shells have no network, and outside clients that only
have MCP or the ``nebula`` CLI. They do not bind a program running as the same
OS user with its own unsandboxed shell: it can read the token where the
person's browser keeps it (Chrome's on-disk Session Storage and History), read
the reload supervisor's memory or a debug CDP port, edit settings.json, or
start its own backend. No check inside the app can stop that.
"""
from __future__ import annotations

from typing import Mapping

from services import person_session

AGENT_MARKER_HEADERS = ("x-daedalus-caller", "x-nebula-agent", "x-nebula-client")
PERSON_HEADER = person_session.PERSON_HEADER

PERSON_REQUIRED = "person_required"
AGENT_REFUSED = "agent_refused"
PERSON_REQUIRED_DETAIL = (
    "Only the person can do this, from a Nebula canvas connected as them. This tab isn't: "
    "open the link the backend printed at launch (backend/devserver.py, or restart it with --open)."
)


class PersonGateError(Exception):
    def __init__(self, status: int, detail: str, code: str = PERSON_REQUIRED) -> None:
        super().__init__(detail)
        self.status = status
        self.detail = detail
        self.code = code


def _lower(headers: Mapping[str, str] | None) -> dict[str, str]:
    return {k.lower(): v for k, v in (headers or {}).items()}


def has_agent_marker(headers: Mapping[str, str] | None) -> bool:
    lower = _lower(headers)
    if lower.get("authorization", "").strip().lower().startswith("agent "):
        return True
    return any(lower.get(name) for name in AGENT_MARKER_HEADERS)


def has_person_token(headers: Mapping[str, str] | None) -> bool:
    """True when the headers carry this launch's person token (markers not checked)."""
    return person_session.verify(_lower(headers).get(PERSON_HEADER))


def is_person(headers: Mapping[str, str] | None) -> bool:
    """No agent marker and this launch's person token."""
    return not has_agent_marker(headers) and has_person_token(headers)


def require_person(headers: Mapping[str, str] | None) -> None:
    """Raise PersonGateError(403) unless this request is the person."""
    if has_agent_marker(headers):
        raise PersonGateError(403, "Only the person can do this from the Nebula canvas.", AGENT_REFUSED)
    if not has_person_token(headers):
        raise PersonGateError(403, PERSON_REQUIRED_DETAIL, PERSON_REQUIRED)
