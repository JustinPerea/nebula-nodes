from __future__ import annotations

import copy
from contextvars import ContextVar
from typing import Any, Literal, Union

from pydantic import BaseModel, Field, PrivateAttr


execution_run_id: ContextVar[str | None] = ContextVar(
    "execution_run_id",
    default=None,
)

# Handler progress callbacks inherit the invocation that created their task.
# This is metadata beside scalar outputs, never a change to their port values.
execution_variant: ContextVar[dict[str, Any] | None] = ContextVar(
    "execution_variant", default=None,
)


def _current_variant() -> dict[str, Any] | None:
    return copy.deepcopy(execution_variant.get())


# Plain-language notes about one invocation that a person or agent should
# know, beside its outputs (never a port value): today, the size a maker
# made when it couldn't make the one asked for
# (execution/maker_routes_ideogram_runway.py). The engine gives each
# invocation a fresh list and carries it on the executed event, in the cache
# with the outputs, and in the run manifest (services/output.py).
execution_notes: ContextVar[list[str] | None] = ContextVar("execution_notes", default=None)


def add_run_note(text: str) -> None:
    """Add a note to the invocation that is running (no-op outside one)."""
    notes = execution_notes.get()
    if notes is not None and text and text not in notes:
        notes.append(text)


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
    variant: dict[str, Any] | None = Field(default_factory=_current_variant)


class ProgressEvent(RunScopedEvent):
    type: Literal["progress"] = "progress"
    node_id: str
    value: float
    variant: dict[str, Any] | None = Field(default_factory=_current_variant)


class ExecutedEvent(RunScopedEvent):
    type: Literal["executed"] = "executed"
    node_id: str
    outputs: dict[str, Any]
    # Current outputs remain scalar. Batch snapshots retain earlier iterator
    # invocations without changing any node's declared output-port contract.
    batch_outputs: list[dict[str, Any]] | None = None
    variant: dict[str, Any] | None = Field(default_factory=_current_variant)
    batch_variants: list[dict[str, Any]] | None = None
    # Output ports the node left empty on purpose (port -> reason), so the
    # canvas can show their wires as inactive. See execution/gating.py.
    withheld: dict[str, str] | None = None
    # execution_notes for this invocation, when it has any.
    notes: list[str] | None = None


class SkippedEvent(RunScopedEvent):
    """The node didn't run because a gate upstream withheld its input.

    ``reason`` names the gate ("Jev Decide failed (answered no, 0.12)") and
    ``gate_node_id`` is the node that withheld it. A skipped node made no
    provider call, wrote no cache entry and costs nothing.
    """

    type: Literal["skipped"] = "skipped"
    node_id: str
    reason: str
    gate_node_id: str | None = None


class ErrorEvent(RunScopedEvent):
    type: Literal["error"] = "error"
    node_id: str
    variant: dict[str, Any] | None = Field(default_factory=_current_variant)
    error: str
    retryable: bool = False
    # Optional friendly classification (see execution.error_classifier). `error`
    # always holds the raw provider string for debugging; these enrich the UI.
    category: str | None = None
    friendly: str | None = None
    # The handler stopped at its own key check, before any provider request
    # (execution.missing_credential), so the node cost nothing.
    missing_credential: bool = False
    # The person's line for this failure, when the handler wrote one
    # (execution/person_line.py, error copy round 3c): what the canvas card
    # shows, with no ids or record names. `error` keeps the specific text
    # word for word for agents, the run record and MCP. Additive: None means
    # the card shows its fallback, with `error` behind "Details".
    person: str | None = None
    # The exception text in `error` carries the provider's own words, so the
    # card keeps it behind "Details" beside `person` (error copy round 3d,
    # GM: "Raw provider text stays behind Details in every case."): the
    # status table's lines, an empty answer's, and a handler's
    # with_provider_line. False: a `person` in Nebula's own words, with no
    # Details (the specific text is for agents).
    provider_text: bool = False
    # The provider the run called, from the route it took (round 3f): the
    # card's general line says "Details shows what {Provider} said." when a
    # failure has no line of its own. Additive and card-only: never read from
    # the error's text, None for a node that calls no provider or a failure
    # that provider never answered (execution/provider_status.card_line).
    provider: str | None = None


class ValidationErrorDetail(BaseModel):
    node_id: str
    port_id: str
    message: str
    # The person's line for this check (error copy round 3e), as ErrorEvent's
    # `person`: what the canvas card shows, naming a field by its label, an
    # input in words and a key by its provider, never a key, id or env-var
    # name. `message` keeps the specific text word for word for agents (run
    # results, look_at_canvas, the run record). Additive: None is a check
    # only an agent or a damaged saved graph reaches; the card shows GM's
    # general line with `message` behind "Details".
    person: str | None = None
    # What kind of stop this is, for the Agent log's merged line
    # (main._refused_run_log_line), set where the check is made, never sent:
    # "reason" for a stop the node's not-ready reason says (a key, a route,
    # a Krea plan), "input" for a required input with no wire (``_need`` its
    # label). None for any other stop: the log says its card line.
    _stop: str | None = PrivateAttr(default=None)
    _need: str | None = PrivateAttr(default=None)

    def marked(self, stop: str, need: str | None = None) -> "ValidationErrorDetail":
        """This check, marked with its kind of stop (``_stop``)."""
        self._stop, self._need = stop, need
        return self


class ValidationErrorEvent(RunScopedEvent):
    type: Literal["validation_error"] = "validation_error"
    errors: list[ValidationErrorDetail]


class GraphCompleteEvent(RunScopedEvent):
    type: Literal["graph_complete"] = "graph_complete"
    duration: float
    nodes_executed: int
    nodes_skipped: int = 0


class GraphCancelledEvent(RunScopedEvent):
    type: Literal["graph_cancelled"] = "graph_cancelled"


class ProviderRecoveryEvent(RunScopedEvent):
    """Recovery checkpoint for accepted provider-side work.

    Both identifiers are present on the wire. ``None`` explicitly clears the
    corresponding node parameter when an operation advances to a World ID.
    The API layer marks whether the checkpoint reached its durable journal;
    a false value keeps the live ID visible while warning against reload.
    """

    type: Literal["provider_recovery"] = "provider_recovery"
    node_id: str
    resume_operation_id: str | None = None
    existing_world_id: str | None = None
    durable: bool = True
    warning: str | None = None


class ProviderStartAmbiguousEvent(RunScopedEvent):
    """Fail-closed hold after a paid start returned no trustworthy ID."""

    type: Literal["provider_start_ambiguous"] = "provider_start_ambiguous"
    node_id: str
    kind: Literal["worldlabs-environment", "worldlabs-world-export"]
    message: str
    durable: bool = True


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
    SkippedEvent,
    ErrorEvent,
    ValidationErrorEvent,
    GraphCompleteEvent,
    GraphCancelledEvent,
    ProviderRecoveryEvent,
    ProviderStartAmbiguousEvent,
    StreamDeltaEvent,
    StreamPartialImageEvent,
    StreamPartialSvgEvent,
]
