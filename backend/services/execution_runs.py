from __future__ import annotations

import asyncio
from dataclasses import dataclass, field
from typing import Any, Callable, Literal, Mapping


ExecutionRunStatus = Literal[
    "running",
    "cancelling",
    "cancelled",
    "completed",
    "failed",
]


class ExecutionCancelledBeforeStartError(RuntimeError):
    """A Stop intent arrived before this run completed admission."""


class ExecutionCancellationCapacityError(RuntimeError):
    """Unresolved pre-admission Stop intents exhausted safe capacity."""


@dataclass
class ExecutionRunRecord:
    run_id: str
    task: asyncio.Task[None]
    status: ExecutionRunStatus = "running"
    had_error: bool = False
    # Who started it and who first asked to stop it: {"kind": "person"},
    # {"kind": "agent", "name": ...} or {"kind": "anonymous"} (see
    # stop_refusal below). Attribution and the Stop rule, nothing else.
    started_by: dict[str, Any] = field(default_factory=lambda: dict(ANONYMOUS_STARTER))
    stopped_by: dict[str, Any] | None = None
    # The canvas the run registered on, as main.py notes it (the open project
    # and its id epoch): every write-back from the run checks it is still the
    # one open (round 11 of PR #114). None: not noted (writes go through).
    canvas: Any = None


class ExecutionRunRegistry:
    """Own fire-and-forget graph tasks and expose truthful cancellation state."""

    def __init__(self, max_records: int = 256) -> None:
        self._records: dict[str, ExecutionRunRecord] = {}
        self._cancel_before_start: dict[str, None] = {}
        self._max_records = max_records
        self._terminal_callback: Callable[[str, ExecutionRunStatus], None] | None = None
        self._starter_source: Callable[[], Mapping[str, Any]] | None = None

    def set_terminal_callback(
        self,
        callback: Callable[[str, ExecutionRunStatus], None] | None,
    ) -> None:
        self._terminal_callback = callback

    def set_starter_source(self, source: Callable[[], Mapping[str, Any]] | None) -> None:
        """Who is starting a run, asked once as it registers (main.py reads
        the request's headers). A run registered with ``started_by`` keeps that."""
        self._starter_source = source

    def register(self, run_id: str, task: asyncio.Task[None], *,
                 started_by: Mapping[str, Any] | None = None, canvas: Any = None) -> ExecutionRunRecord:
        if not run_id or len(run_id) > 128:
            raise ValueError("runId must be between 1 and 128 characters")
        if run_id in self._records:
            raise ValueError(f"run '{run_id}' already exists")
        try:
            self.assert_admissible(run_id)
        except (ExecutionCancelledBeforeStartError, ExecutionCancellationCapacityError):
            task.cancel()
            raise
        self._prune()
        if started_by is None and self._starter_source is not None:
            started_by = self._starter_source()
        record = ExecutionRunRecord(run_id=run_id, task=task,
                                    started_by=dict(started_by or ANONYMOUS_STARTER), canvas=canvas)
        self._records[run_id] = record
        task.add_done_callback(lambda completed, rid=run_id: self._finish(rid, completed))
        return record

    def get(self, run_id: str) -> ExecutionRunRecord | None:
        return self._records.get(run_id)

    def has_active(self) -> bool:
        """Keep graph replacement fenced until every owning task is terminal."""
        return any(record.status in {"running", "cancelling"}
                   for record in self._records.values())

    def list_statuses(self) -> list[dict[str, str]]:
        """Return a bounded reconnect snapshot of every retained run."""
        statuses = [
            {"runId": record.run_id, "status": record.status}
            for record in self._records.values()
        ]
        statuses.extend(
            {"runId": run_id, "status": "cancelled"}
            for run_id in self._cancel_before_start
            if run_id not in self._records
        )
        return statuses

    def cancel_requested_before_start(self, run_id: str) -> bool:
        return run_id in self._cancel_before_start

    def compact_cancel_intent(self, run_id: str) -> bool:
        """Drop a local exact tombstone after durable permanent-deny compaction.

        The shared provider-start guard remains authoritative and continues to
        reject the run ID from its durable Bloom filter.  This method only
        recovers bounded in-process inspection capacity.
        """
        return self._cancel_before_start.pop(run_id, None) is not None

    def assert_admissible(self, run_id: str) -> None:
        if run_id in self._cancel_before_start:
            raise ExecutionCancelledBeforeStartError(
                f"run '{run_id}' was cancelled before it started"
            )
        if len(self._cancel_before_start) >= self._max_records:
            raise ExecutionCancellationCapacityError(
                "pre-admission cancellation safety capacity is exhausted; restart "
                "the backend before starting more work"
            )

    def mark_error(self, run_id: str) -> None:
        record = self._records.get(run_id)
        if record is not None and record.status == "running":
            record.had_error = True

    def cancel(self, run_id: str) -> ExecutionRunRecord | None:
        if not run_id or len(run_id) > 128:
            raise ValueError("runId must be between 1 and 128 characters")
        record = self._records.get(run_id)
        if record is None:
            if (
                run_id not in self._cancel_before_start
                and len(self._cancel_before_start) >= self._max_records
            ):
                raise ExecutionCancellationCapacityError(
                    "pre-admission cancellation safety capacity is exhausted; "
                    "the existing Stop intents were preserved"
                )
            self._cancel_before_start.pop(run_id, None)
            self._cancel_before_start[run_id] = None
            return None
        if record.status in {"completed", "failed", "cancelled"}:
            return record
        record.status = "cancelling"
        record.task.cancel()
        return record

    def clear(self) -> None:
        """Testing/shutdown helper; active tasks are cancelled before removal."""
        for record in self._records.values():
            if not record.task.done():
                record.task.cancel()
        self._records.clear()
        self._cancel_before_start.clear()

    def _finish(self, run_id: str, task: asyncio.Task[None]) -> None:
        record = self._records.get(run_id)
        if record is None:
            return
        if task.cancelled() or record.status == "cancelling":
            record.status = "cancelled"
        else:
            try:
                error = task.exception()
            except asyncio.CancelledError:
                record.status = "cancelled"
            else:
                record.status = (
                    "failed" if error is not None or record.had_error else "completed"
                )
        if self._terminal_callback is not None:
            self._terminal_callback(run_id, record.status)

    def _prune(self) -> None:
        excess = len(self._records) - self._max_records + 1
        if excess <= 0:
            return
        terminal = [
            run_id
            for run_id, record in self._records.items()
            if record.status in {"completed", "failed", "cancelled"}
        ]
        for run_id in terminal[:excess]:
            self._records.pop(run_id, None)


# -- who may stop a run (Justin, 2026-10-20, MCP parity Q61 a) -------------------

ANONYMOUS_STARTER: dict[str, Any] = {"kind": "anonymous"}

PERSONS_RUN_REFUSAL = (
    "The person started this run, so only they can stop it: ask them to press Stop "
    "in Nebula (the toolbar, or the run in Run history). Agents stop only runs an agent started."
)


def stop_refusal(started_by: Mapping[str, Any] | None, *, caller_is_person: bool) -> str | None:
    """Why this caller may not stop a run, or None when it may.

    The person (their launch token, services/person_gate.py) stops any run.
    Anyone else, a named agent or an unnamed caller such as the `nebula` CLI
    without NEBULA_AGENT_NAME, stops only runs that weren't the person's: a
    Stop can't be undone, and the person's run is theirs to end. An unnamed
    caller's runs count as an agent's, since nothing proves the person
    started them, so the CLI by hand still stops what it started."""
    if caller_is_person:
        return None
    if (started_by or {}).get("kind") == "person":
        return PERSONS_RUN_REFUSAL
    return None
