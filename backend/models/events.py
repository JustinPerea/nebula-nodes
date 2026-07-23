from __future__ import annotations

from contextvars import ContextVar
from typing import Any, Literal, Union

from pydantic import BaseModel


execution_run_id: ContextVar[str | None] = ContextVar(
    "execution_run_id",
    default=None,
)


class RunScopedEvent(BaseModel):
    """Execution event correlated to the request that produced it.

    ``None`` keeps CLI and older callers backwards compatible. The serializer
    fills it from ``execution_run_id`` for events emitted inside execute_graph.
    """

    run_id: str | None = None


class QueuedEvent(RunScopedEvent):
    type: Literal["queued"] = "queued"
    node_id: str


class ExecutingEvent(RunScopedEvent):
    type: Literal["executing"] = "executing"
    node_id: str


class ProgressEvent(RunScopedEvent):
    type: Literal["progress"] = "progress"
    node_id: str
    value: float


class ExecutedEvent(RunScopedEvent):
    type: Literal["executed"] = "executed"
    node_id: str
    outputs: dict[str, Any]


class ErrorEvent(RunScopedEvent):
    type: Literal["error"] = "error"
    node_id: str
    error: str
    retryable: bool = False
    # Optional friendly classification (see execution.error_classifier). `error`
    # always holds the raw provider string for debugging; these enrich the UI.
    category: str | None = None
    friendly: str | None = None


class ValidationErrorDetail(BaseModel):
    node_id: str
    port_id: str
    message: str


class ValidationErrorEvent(RunScopedEvent):
    type: Literal["validation_error"] = "validation_error"
    errors: list[ValidationErrorDetail]


class GraphCompleteEvent(RunScopedEvent):
    type: Literal["graph_complete"] = "graph_complete"
    duration: float
    nodes_executed: int


class StreamDeltaEvent(RunScopedEvent):
    type: Literal["stream_delta"] = "stream_delta"
    node_id: str
    delta: str
    accumulated: str


class StreamPartialImageEvent(RunScopedEvent):
    type: Literal["stream_partial_image"] = "stream_partial_image"
    node_id: str
    partial_index: int
    src: str  # server-relative file path
    is_final: bool = False


class StreamPartialSvgEvent(RunScopedEvent):
    type: Literal["stream_partial_svg"] = "stream_partial_svg"
    node_id: str
    partial_index: int
    svg: str  # raw SVG markup; frontend renders inline as a data URI for progressive preview
    is_final: bool = False


ExecutionEvent = Union[
    QueuedEvent,
    ExecutingEvent,
    ProgressEvent,
    ExecutedEvent,
    ErrorEvent,
    ValidationErrorEvent,
    GraphCompleteEvent,
    StreamDeltaEvent,
    StreamPartialImageEvent,
    StreamPartialSvgEvent,
]
