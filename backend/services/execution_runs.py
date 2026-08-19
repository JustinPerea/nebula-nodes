from __future__ import annotations

import asyncio
from dataclasses import dataclass
from typing import Literal


ExecutionRunStatus = Literal[
    "running",
    "cancelling",
    "cancelled",
    "completed",
    "failed",
]


@dataclass
class ExecutionRunRecord:
    run_id: str
    task: asyncio.Task[None]
    status: ExecutionRunStatus = "running"


class ExecutionRunRegistry:
    """Own fire-and-forget graph tasks and expose truthful cancellation state."""

    def __init__(self, max_records: int = 256) -> None:
        self._records: dict[str, ExecutionRunRecord] = {}
        self._max_records = max_records

    def register(self, run_id: str, task: asyncio.Task[None]) -> ExecutionRunRecord:
        if not run_id or len(run_id) > 128:
            raise ValueError("runId must be between 1 and 128 characters")
        if run_id in self._records:
            raise ValueError(f"run '{run_id}' already exists")
        self._prune()
        record = ExecutionRunRecord(run_id=run_id, task=task)
        self._records[run_id] = record
        task.add_done_callback(lambda completed, rid=run_id: self._finish(rid, completed))
        return record

    def get(self, run_id: str) -> ExecutionRunRecord | None:
        return self._records.get(run_id)

    def cancel(self, run_id: str) -> ExecutionRunRecord | None:
        record = self._records.get(run_id)
        if record is None:
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

    def _finish(self, run_id: str, task: asyncio.Task[None]) -> None:
        record = self._records.get(run_id)
        if record is None:
            return
        if task.cancelled() or record.status == "cancelling":
            record.status = "cancelled"
            return
        try:
            error = task.exception()
        except asyncio.CancelledError:
            record.status = "cancelled"
        else:
            record.status = "failed" if error is not None else "completed"

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
