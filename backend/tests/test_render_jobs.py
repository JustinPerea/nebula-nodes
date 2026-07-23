from __future__ import annotations

import asyncio

import pytest

from services.render_jobs import RenderJobManager


@pytest.mark.asyncio
async def test_render_job_completes_with_served_output_url(tmp_path, monkeypatch) -> None:
    monkeypatch.setattr("services.render_jobs.OUTPUT_ROOT", tmp_path)
    output = tmp_path / "run" / "final.mp4"

    async def runner(on_progress):
        output.parent.mkdir()
        on_progress(0.4)
        output.write_bytes(b"video")
        return output

    manager = RenderJobManager()
    job = manager.start("remotion", runner)
    assert job.task is not None
    await job.task

    assert job.status == "complete"
    assert job.progress == 1.0
    assert job.output_url == "/api/outputs/run/final.mp4"


@pytest.mark.asyncio
async def test_render_job_cancel_propagates_to_worker() -> None:
    cancelled = asyncio.Event()

    async def runner(on_progress):
        try:
            await asyncio.Future()
        finally:
            cancelled.set()

    manager = RenderJobManager()
    job = manager.start("video-edit", runner)
    await asyncio.sleep(0)
    manager.cancel(job.id)
    assert job.task is not None
    await job.task

    assert job.status == "cancelled"
    assert cancelled.is_set()


@pytest.mark.asyncio
async def test_failed_render_exposes_error_without_output() -> None:
    async def runner(on_progress):
        raise RuntimeError("encoder exploded")

    manager = RenderJobManager()
    job = manager.start("video-edit", runner)
    assert job.task is not None
    await job.task

    assert job.status == "failed"
    assert job.error == "encoder exploded"
    assert job.output_url is None
