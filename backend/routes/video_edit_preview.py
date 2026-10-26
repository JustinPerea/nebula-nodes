"""POST /api/video-edit/preview-render — low-res render-on-demand.

Used by the editor surface to verify virtual-vs-rendered divergence
before committing the user to a full Run. Output lives under
output/<run>/_preview/ and is auto-cleaned on next preview render.
"""

from __future__ import annotations

from pathlib import Path
from typing import Any
from uuid import uuid4

from fastapi import APIRouter, HTTPException
from pydantic import BaseModel

from handlers.video_edit import _build_filter_complex, _resolve_local_path
from services.file_access import ProtectedPathError
from services.ffmpeg import ffprobe_video, run_ffmpeg
from services.output import OUTPUT_ROOT, get_run_dir, seal_run_dir
from services import refusal_copy

# GM's 404 pattern (error-copy round 3): the video the edit cuts from is gone.
SOURCE_GONE = "That video isn't there anymore. Reload to get the latest outputs."

router = APIRouter(prefix="/api/video-edit", tags=["video-edit"])


class PreviewRenderRequest(BaseModel):
    sourceUrl: str
    clips: list[dict[str, Any]]


class PreviewRenderResponse(BaseModel):
    previewUrl: str


@router.post("/preview-render", response_model=PreviewRenderResponse)
async def preview_render(req: PreviewRenderRequest) -> PreviewRenderResponse:
    try:
        src_path = _resolve_local_path(req.sourceUrl)
    except ProtectedPathError as exc:
        raise HTTPException(status_code=400, detail=str(exc)) from exc
    if src_path is None:
        raise refusal_copy.refusal(404, f"Source not found: {req.sourceUrl}", SOURCE_GONE)
    if not req.clips:
        raise HTTPException(status_code=400, detail="clips required")

    await ffprobe_video(src_path)  # validates source decodes
    filter_complex, has_audio = _build_filter_complex(req.clips)
    # Chain the preview downscale into the filter_complex graph itself —
    # ffmpeg rejects mixing -vf (simple filter) with -filter_complex on the
    # same stream. Concat outputs [outv]; we re-label after scaling.
    filter_complex = f"{filter_complex};[outv]scale=640:-2[outvs]"

    preview_dir = get_run_dir() / "_preview"
    preview_dir.mkdir(parents=True, exist_ok=True)
    for old in preview_dir.glob("*.mp4"):
        try:
            old.unlink()
        except OSError:
            pass

    output_path = preview_dir / f"{uuid4().hex[:12]}_preview.mp4"
    args = [
        "-i", str(src_path),
        "-filter_complex", filter_complex,
        "-map", "[outvs]",
    ]
    if has_audio:
        args += ["-map", "[outa]"]
    args += [
        "-c:v", "libx264",
        "-preset", "ultrafast",
        "-crf", "32",
    ]
    if has_audio:
        args += ["-c:a", "aac", "-b:a", "96k"]
    args += [str(output_path)]
    await run_ffmpeg(args)
    # Whole now: a price may be measured from it (services/output.py _LIVE_RUN_DIRS).
    seal_run_dir(preview_dir.parent)

    rel = output_path.relative_to(OUTPUT_ROOT)
    return PreviewRenderResponse(previewUrl=f"/api/outputs/{rel}")
