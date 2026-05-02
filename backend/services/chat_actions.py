"""Chat action event bus — lets graph mutation endpoints publish `thinking`
events to the active chat turn's WebSocket.

The chat WebSocket registers a handler at turn start and unregisters at turn
end. Graph routes call `publish_action` after each mutation; if no turn is
active, the call is a no-op.

Scope: one active handler at a time. The chat WebSocket already cancels any
in-flight turn before starting a new one, so single-slot state is safe.

This exists because the agent runtime (`hermes-daedalus chat -Q`) buffers
stdout through tool-call rounds — we don't get mid-turn narration from the
subprocess. But every `nebula create / connect / run` tool call lands as an
HTTP request on this backend, so we surface those directly to the chat.
"""
from __future__ import annotations

import time
from typing import Any, Callable

_active_handler: Callable[[dict[str, Any]], None] | None = None

# Shared "last real activity" timestamp used by the heartbeat in hermes_session
# to suppress its 20s-interval "thinking... (Xs elapsed)" line when real events
# have fired recently. Non-heartbeat emissions call `mark_activity()`; the
# heartbeat reads `seconds_since_activity()` before firing.
_last_activity_monotonic: float = 0.0

# Per-turn buffer of action text — captures every prose line published this
# turn so the narrator (services.narrator) can synthesize a chat-bubble
# fallback when Kimi K2.6 emits empty content alongside tool_calls. Single
# slot, same single-active-turn constraint as `_active_handler`.
_action_buffer: list[str] = []


def register_action_handler(handler: Callable[[dict[str, Any]], None]) -> None:
    """Install the single active handler. Called by the chat WS at turn start."""
    global _active_handler
    _active_handler = handler


def unregister_action_handler() -> None:
    """Clear the active handler. Called by the chat WS at turn end."""
    global _active_handler
    _active_handler = None


def mark_activity() -> None:
    """Record a non-heartbeat user-visible emission.

    Called by any path that surfaces something meaningful to the user: the
    hermes stdout streamer, the hermes log tailer, and `publish_action` below.
    Heartbeats must NOT call this — otherwise they'd suppress themselves.
    """
    global _last_activity_monotonic
    _last_activity_monotonic = time.monotonic()


def reset_activity() -> None:
    """Reset at turn start so the first heartbeat waits the full quiet window."""
    global _last_activity_monotonic
    _last_activity_monotonic = time.monotonic()


def seconds_since_activity() -> float:
    """Elapsed seconds since the last real emission this turn. Returns a very
    large number if nothing has been marked yet (i.e. heartbeat should fire)."""
    if _last_activity_monotonic == 0.0:
        return float("inf")
    return time.monotonic() - _last_activity_monotonic


def publish_action(text: str) -> None:
    """Publish a human-readable action line to the active chat turn, if any.

    Safe to call from any HTTP handler — silently drops when no chat turn
    is active. `text` should read as prose ("Added text-input as n1"),
    not as debug output.

    Also appends to `_action_buffer` so the narrator can synthesize a
    chat-bubble fallback if Kimi K2.6 emits empty content. The buffer is
    reset at turn start by `reset_actions()` and drained at turn end by
    `consume_actions()`, so cross-turn leakage is bounded.
    """
    mark_activity()
    _action_buffer.append(text)
    h = _active_handler
    if h is None:
        return
    try:
        h({"type": "thinking", "text": text})
    except Exception:
        # Never break the calling route on a publish failure.
        pass


def reset_actions() -> None:
    """Clear the per-turn action buffer. Called at turn start in hermes_session."""
    global _action_buffer
    _action_buffer = []


def consume_actions() -> list[str]:
    """Return and clear the per-turn action buffer.

    Called at turn end by the narrator-fallback path in hermes_session when
    Kimi's `content` came back empty.
    """
    global _action_buffer
    out = list(_action_buffer)
    _action_buffer = []
    return out
