"""Final video-editor and Remotion export routes with job lifecycle APIs."""

from __future__ import annotations

from typing import Any, Literal

from fastapi import APIRouter, HTTPException
from pydantic import BaseModel

from handlers.remotion_node import _validate_manifest
from handlers.video_edit import (
    VIDEO_EXPORT_FORMATS,
    VIDEO_EXPORT_QUALITIES,
    VIDEO_EXPORT_RESOLUTIONS,
    _resolve_local_path,
    render_video_edit_file,
)
from services.remotion_render import render_remotion_manifest
from services.render_jobs import render_job_manager


router = APIRouter(tags=["render-exports"])


class VideoExportRequest(BaseModel):
    sourceUrl: str
    clips: list[dict[str, Any]]
    format: Literal["mp4", "mov", "webm", "gif"] = "mp4"
    resolution: Literal["source", "1080p", "720p", "480p"] = "source"
    quality: Literal["high", "balanced", "small"] = "balanced"


class RemotionRenderRequest(BaseModel):
    manifest: dict[str, Any]


@router.post("/api/video-edit/export", status_code=202)
async def start_video_export(req: VideoExportRequest) -> dict[str, object | None]:
    source_path = _resolve_local_path(req.sourceUrl)
    if source_path is None:
        raise HTTPException(status_code=404, detail=f"Source not found: {req.sourceUrl}")
    if not req.clips:
        raise HTTPException(status_code=400, detail="clips required")
    if req.format not in VIDEO_EXPORT_FORMATS:
        raise HTTPException(status_code=400, detail="unsupported format")
    if req.resolution not in VIDEO_EXPORT_RESOLUTIONS:
        raise HTTPException(status_code=400, detail="unsupported resolution")
    if req.quality not in VIDEO_EXPORT_QUALITIES:
        raise HTTPException(status_code=400, detail="unsupported quality")

    async def _runner(on_progress):
        return await render_video_edit_file(
            source_path,
            req.clips,
            output_format=req.format,
            resolution=req.resolution,
            quality=req.quality,
            on_progress=on_progress,
        )

    return render_job_manager.start("video-edit", _runner).payload()


@router.post("/api/remotion-render", status_code=202)
async def start_remotion_render(req: RemotionRenderRequest) -> dict[str, object | None]:
    try:
        _validate_manifest(req.manifest)
    except ValueError as exc:
        raise HTTPException(status_code=400, detail=str(exc)) from exc

    async def _runner(on_progress):
        return await render_remotion_manifest(req.manifest, on_progress=on_progress)

    return render_job_manager.start("remotion", _runner).payload()


@router.get("/api/render-jobs/{job_id}")
async def get_render_job(job_id: str) -> dict[str, object | None]:
    job = render_job_manager.get(job_id)
    if job is None:
        raise HTTPException(status_code=404, detail="render job not found")
    return job.payload()


@router.delete("/api/render-jobs/{job_id}")
async def cancel_render_job(job_id: str) -> dict[str, object | None]:
    job = render_job_manager.cancel(job_id)
    if job is None:
        raise HTTPException(status_code=404, detail="render job not found")
    return job.payload()
