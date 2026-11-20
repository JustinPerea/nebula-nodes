"""Chat action event bus — lets a route publish a `thinking` event to the
active chat turn's WebSocket.

The chat WebSocket registers a handler at turn start and unregisters at turn
end. A route calls `publish_action`; if no turn is active, the call is a no-op.

Scope: one active handler at a time. The chat WebSocket already cancels any
in-flight turn before starting a new one, so single-slot state is safe.

The line goes to the turn that is open, labelled with that turn's runner, not
with whoever made the request. So the Agent log's rows for an agent's actions
no longer come from here: each is the agent's own cursor event, under its name
(main._show_agent, main._say_agent_action; design). What still publishes is a
refused run's line that no agent cursor carried (a caller with no agent name).
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
    is active. `text` should read as prose in canvas words (names, never
    node ids), not as debug output.
    """
    h = _active_handler
    if h is None:
        return
    try:
        h({"type": "thinking", "text": text})
    except Exception:
        # Never break the calling route on a publish failure.
        pass
