"""Commons text is data, not instructions (§3.2).

Every string an agent reads from the commons (summaries, why, comments,
page titles, notes) is wrapped so the agent's harness can tell it apart from
its instructions, following PLAN's FLORA handling."""
from __future__ import annotations

from typing import Any

OPEN = "<untrusted-commons-text>"
CLOSE = "</untrusted-commons-text>"


def wrap(text: str | None) -> str | None:
    if text is None:
        return None
    safe = str(text).replace(CLOSE, "</untrusted-commons-text​>").replace(OPEN, "<untrusted-commons-text​>")
    return f"{OPEN}{safe}{CLOSE}"


def _wrap_value(value: Any, keys: set[str]) -> Any:
    if isinstance(value, str):
        return wrap(value)
    if isinstance(value, list) and all(isinstance(v, str) for v in value):
        return [wrap(v) for v in value]  # e.g. also_in: a list of collection names
    return wrap_fields(value, keys)


def wrap_fields(obj: Any, keys: set[str]) -> Any:
    if isinstance(obj, dict):
        return {k: _wrap_value(v, keys) if k in keys else wrap_fields(v, keys) for k, v in obj.items()}
    if isinstance(obj, list):
        return [wrap_fields(v, keys) for v in obj]
    return obj
