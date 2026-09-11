from __future__ import annotations

import asyncio
from dataclasses import dataclass
from typing import Callable, Literal


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


class ExecutionRunRegistry:
    """Own fire-and-forget graph tasks and expose truthful cancellation state."""

    def __init__(self, max_records: int = 256) -> None:
        self._records: dict[str, ExecutionRunRecord] = {}
        self._cancel_before_start: dict[str, None] = {}
        self._max_records = max_records
        self._terminal_callback: Callable[[str, ExecutionRunStatus], None] | None = None

    def set_terminal_callback(
        self,
        callback: Callable[[str, ExecutionRunStatus], None] | None,
    ) -> None:
        self._terminal_callback = callback

    def register(self, run_id: str, task: asyncio.Task[None]) -> ExecutionRunRecord:
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
        record = ExecutionRunRecord(run_id=run_id, task=task)
        self._records[run_id] = record
        task.add_done_callback(lambda completed, rid=run_id: self._finish(rid, completed))
        return record

    def get(self, run_id: str) -> ExecutionRunRecord | None:
        return self._records.get(run_id)

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
