"""Chat action event bus — lets graph mutation endpoints publish `thinking`
events to the active chat turn's WebSocket.

The chat WebSocket registers a handler at turn start and unregisters at turn
end. Graph routes call `publish_action` after each mutation; if no turn is
active, the call is a no-op.

Scope: one active handler at a time. The chat WebSocket already cancels any
in-flight turn before starting a new one, so single-slot state is safe.

Every `nebula create / connect / run` tool call an agent makes lands as an
HTTP request on this backend, so we surface those directly to the chat as
prose lines alongside whatever the agent itself streams.
"""
from __future__ import annotations

from typing import Any, Callable

_active_handler: Callable[[dict[str, Any]], None] | None = None


def register_action_handler(handler: Callable[[dict[str, Any]], None]) -> None:
    """Install the single active handler. Called by the chat WS at turn start."""
    global _active_handler
    _active_handler = handler


def unregister_action_handler() -> None:
    """Clear the active handler. Called by the chat WS at turn end."""
    global _active_handler
    _active_handler = None


def publish_action(text: str) -> None:
    """Publish a human-readable action line to the active chat turn, if any.

    Safe to call from any HTTP handler — silently drops when no chat turn
    is active. `text` should read as prose ("Added text-input as n1"),
    not as debug output.
    """
    h = _active_handler
    if h is None:
        return
    try:
        h({"type": "thinking", "text": text})
    except Exception:
        # Never break the calling route on a publish failure.
        pass
