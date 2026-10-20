"""Why each canvas node's last run failed, for agents to read.

The canvas shows a failed node's message on its card. Agents don't see the
card, so the backend keeps the same message here: look_at_canvas and `nebula
look` give it as the node's `error`, and view_output and `nebula path` answer
with it instead of "no output yet".

Every run path feeds it: a node's ErrorEvent (canvas runs, agent runs, a
single node) and the pre-call check's validation errors (a missing key, an
unwired required input). A node that starts again, finishes or is skipped by
a gate loses its error, as its card does. Memory only, like the card's state:
a backend restart forgets them, and so does replacing the canvas, which
restarts node ids.
"""
from __future__ import annotations

from typing import Any, Container, Iterable

from models.events import ErrorEvent, ExecutedEvent, ExecutingEvent, SkippedEvent

# What an agent reads is a message, not a log: long provider bodies are cut.
MAX_ERROR_CHARS = 2000


def _clip(text: Any) -> str:
    value = " ".join(str(text or "").split())
    return value if len(value) <= MAX_ERROR_CHARS else value[: MAX_ERROR_CHARS - 1] + "…"


class NodeErrors:
    def __init__(self) -> None:
        self._errors: dict[str, dict[str, str]] = {}

    def record(self, node_id: str, message: str, *, friendly: str | None = None) -> None:
        if not node_id or not message:
            return
        entry = {"error": _clip(message)}
        hint = _clip(friendly) if friendly else ""
        # classify_error's fallback is the message itself less its full stop.
        if hint and hint.rstrip(".") != entry["error"].rstrip("."):
            entry["hint"] = hint
        self._errors[node_id] = entry

    def record_validation(self, errors: Iterable[Any]) -> None:
        """A pre-call check's errors (ValidationErrorDetail), several per node joined in order."""
        by_node: dict[str, list[str]] = {}
        for error in errors:
            node_id = str(getattr(error, "node_id", "") or "")
            message = str(getattr(error, "message", "") or "")
            if node_id and message and message not in by_node.setdefault(node_id, []):
                by_node[node_id].append(message)
        for node_id, messages in by_node.items():
            self.record(node_id, "; ".join(messages))

    def observe(self, event: Any) -> None:
        """Follow one execution event the way the canvas card does."""
        if isinstance(event, ErrorEvent):
            self.record(event.node_id, event.error, friendly=event.friendly)
        elif isinstance(event, (ExecutingEvent, ExecutedEvent, SkippedEvent)):
            self._errors.pop(event.node_id, None)

    def get(self, node_id: str) -> dict[str, str] | None:
        entry = self._errors.get(node_id)
        return dict(entry) if entry else None

    def prune(self, existing: Container[str]) -> None:
        """Forget nodes no longer on the canvas."""
        for node_id in [key for key in self._errors if key not in existing]:
            del self._errors[node_id]

    def forget_all(self) -> None:
        self._errors.clear()


node_errors = NodeErrors()
