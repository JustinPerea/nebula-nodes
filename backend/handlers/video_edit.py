"""video-edit handler — applies trim/speed/cut/volume edits via ffmpeg.

Edits live in node.params.clips as an ordered list of sub-clips with
source-relative timestamps. When clips describe a virgin no-op (single
full-range entry, default speed/volume/no-mute), return the upstream URL
unchanged — matching the reroute / style-reference passthrough precedent.
Anything else triggers an ffmpeg render.
"""

from __future__ import annotations

from pathlib import Path
from typing import Any, Awaitable, Callable
from uuid import uuid4

from models.events import ExecutionEvent, ProgressEvent
from models.graph import GraphNode, PortValueDict
from services.ffmpeg import ProbeResult, ffprobe_video, run_ffmpeg
from services.output import OUTPUT_ROOT, get_run_dir


def _resolve_local_path(value: str) -> Path:
    """Accept either a filesystem path or /api/outputs/<rel> URL.

    Mirrors the pattern from handlers/style_reference.py — saved graphs
    re-execute with /api/outputs URLs while fresh runs have raw paths.
    """
    if value.startswith("/api/outputs/"):
        rel = value[len("/api/outputs/"):]
        return OUTPUT_ROOT / rel
    return Path(value)


def _is_no_op(clips: list[dict[str, Any]], source_duration: float) -> bool:
    if len(clips) != 1:
        return False
    c = clips[0]
    return (
        abs(c.get("sourceIn", 0.0)) < 0.01
        and abs(c.get("sourceOut", 0.0) - source_duration) < 0.01
        and abs(c.get("speed", 1.0) - 1.0) < 0.001
        and abs(c.get("volume", 1.0) - 1.0) < 0.001
        and c.get("mute", False) is False
    )


async def handle_video_edit(
    node: GraphNode,
    inputs: dict[str, PortValueDict],
    api_keys: dict[str, str],
    emit: Callable[[ExecutionEvent], Awaitable[None]] | None = None,
) -> dict[str, Any]:
    """Run the edit graph on the upstream source."""
    src_input = inputs.get("video_in")
    if src_input is None or not src_input.value:
        raise ValueError("video_in port is required for video-edit")
    src_path = _resolve_local_path(str(src_input.value))
    if not src_path.exists():
        raise FileNotFoundError(f"Source video not found: {src_path}")

    probe = await ffprobe_video(src_path)
    node.params["sourceDuration"] = probe.duration
    node.params["sourceFps"] = probe.fps
    node.params["sourceIsVfr"] = probe.is_vfr

    clips = node.params.get("clips") or [
        {"id": "c1", "sourceIn": 0.0, "sourceOut": probe.duration, "speed": 1.0, "volume": 1.0, "mute": False}
    ]

    if _is_no_op(clips, probe.duration):
        return {"video": {"type": "Video", "value": str(src_input.value)}}

    raise NotImplementedError("Render path lands in Task 4")
