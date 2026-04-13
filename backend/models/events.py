from __future__ import annotations

from typing import Any, Literal, Union

from pydantic import BaseModel


class QueuedEvent(BaseModel):
    type: Literal["queued"] = "queued"
    node_id: str


class ExecutingEvent(BaseModel):
    type: Literal["executing"] = "executing"
    node_id: str


class ProgressEvent(BaseModel):
    type: Literal["progress"] = "progress"
    node_id: str
    value: float


class ExecutedEvent(BaseModel):
    type: Literal["executed"] = "executed"
    node_id: str
    outputs: dict[str, Any]


class ErrorEvent(BaseModel):
    type: Literal["error"] = "error"
    node_id: str
    error: str
    retryable: bool = False


class ValidationErrorDetail(BaseModel):
    node_id: str
    port_id: str
    message: str


class ValidationErrorEvent(BaseModel):
    type: Literal["validation_error"] = "validation_error"
    errors: list[ValidationErrorDetail]


class GraphCompleteEvent(BaseModel):
    type: Literal["graph_complete"] = "graph_complete"
    duration: float
    nodes_executed: int


ExecutionEvent = Union[
    QueuedEvent,
    ExecutingEvent,
    ProgressEvent,
    ExecutedEvent,
    ErrorEvent,
    ValidationErrorEvent,
    GraphCompleteEvent,
]
