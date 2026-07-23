"""Small in-memory lifecycle manager for local final-render jobs."""

from __future__ import annotations

import asyncio
from dataclasses import dataclass
from pathlib import Path
from typing import Awaitable, Callable, Literal
from uuid import uuid4

from services.output import OUTPUT_ROOT


RenderJobStatus = Literal["running", "complete", "failed", "cancelled"]
RenderRunner = Callable[[Callable[[float], None]], Awaitable[Path]]


@dataclass
class RenderJob:
    id: str
    kind: str
    status: RenderJobStatus = "running"
    progress: float = 0.0
    output_url: str | None = None
    error: str | None = None
    task: asyncio.Task[None] | None = None

    def payload(self) -> dict[str, object | None]:
        return {
            "id": self.id,
            "kind": self.kind,
            "status": self.status,
            "progress": self.progress,
            "outputUrl": self.output_url,
            "error": self.error,
        }


class RenderJobManager:
    def __init__(self, max_jobs: int = 50) -> None:
        self._jobs: dict[str, RenderJob] = {}
        self._max_jobs = max_jobs

    def get(self, job_id: str) -> RenderJob | None:
        return self._jobs.get(job_id)

    def start(self, kind: str, runner: RenderRunner) -> RenderJob:
        self._prune()
        job = RenderJob(id=uuid4().hex, kind=kind)
        self._jobs[job.id] = job

        def _progress(value: float) -> None:
            if job.status == "running":
                job.progress = max(job.progress, min(max(value, 0.0), 1.0))

        async def _run() -> None:
            try:
                output_path = await runner(_progress)
                resolved = output_path.resolve()
                resolved.relative_to(OUTPUT_ROOT.resolve())
                job.output_url = f"/api/outputs/{resolved.relative_to(OUTPUT_ROOT.resolve())}"
                job.progress = 1.0
                job.status = "complete"
            except asyncio.CancelledError:
                job.status = "cancelled"
                job.error = None
            except Exception as exc:
                job.status = "failed"
                job.error = str(exc)

        job.task = asyncio.create_task(_run())
        return job

    def cancel(self, job_id: str) -> RenderJob | None:
        job = self._jobs.get(job_id)
        if job is None:
            return None
        if job.status == "running" and job.task is not None:
            job.status = "cancelled"
            job.task.cancel()
        return job

    def _prune(self) -> None:
        if len(self._jobs) < self._max_jobs:
            return
        terminal_ids = [
            job_id for job_id, job in self._jobs.items() if job.status != "running"
        ]
        for job_id in terminal_ids[: max(1, len(self._jobs) - self._max_jobs + 1)]:
            del self._jobs[job_id]


render_job_manager = RenderJobManager()
