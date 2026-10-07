"""Explicit process opt-in for Commons, without opening its persisted state.

Keep the check dynamic so tests and lazy factories use the same authority as
startup. Only the literal value ``1`` enables this experimental subsystem.
"""
from __future__ import annotations

import os


class CommonsDisabledError(RuntimeError):
    """Commons was requested without the server's explicit activation."""


def is_enabled() -> bool:
    return os.environ.get("NEBULA_COMMONS_ENABLED") == "1"


def require_enabled() -> None:
    if not is_enabled():
        raise CommonsDisabledError("Commons is disabled; start the backend with NEBULA_COMMONS_ENABLED=1")
