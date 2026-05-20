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


_OUTPUTS_URL_PREFIX = "/api/outputs/"


def _resolve_local_path(value: str) -> Path | None:
    """Resolve a `video_in` value to a real filesystem path, or None.

    Accepts:
    - `/api/outputs/<rel>` — sandboxed under OUTPUT_ROOT via `relative_to` check
    - absolute filesystem path — used as-is if it exists

    Mirrors `handlers/style_reference.py` defensively: returns None for
    anything unresolvable so the caller can raise a clear error instead of
    silently following a path-traversal escape.
    """
    if not value:
        return None
    if value.startswith(_OUTPUTS_URL_PREFIX):
        rel = value[len(_OUTPUTS_URL_PREFIX):]
        candidate = (OUTPUT_ROOT / rel).resolve()
        try:
            candidate.relative_to(OUTPUT_ROOT.resolve())
        except ValueError:
            return None
        return candidate if candidate.exists() else None
    candidate = Path(value).expanduser()
    if candidate.is_absolute() and candidate.exists():
        return candidate
    return None


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


def _atempo_chain(speed: float) -> str:
    """Build an atempo filter chain that handles speeds outside the [0.5, 2.0] single-filter range.

    Per ffmpeg docs, atempo supports [0.5, 100.0] but accuracy degrades outside
    [0.5, 2.0]; chain multiple atempo filters by sqrt to stay in range.
    """
    if 0.5 <= speed <= 2.0:
        return f"atempo={speed}"
    factors: list[float] = []
    remaining = speed
    while remaining > 2.0:
        factors.append(2.0)
        remaining /= 2.0
    while remaining < 0.5:
        factors.append(0.5)
        remaining /= 0.5
    factors.append(remaining)
    return ",".join(f"atempo={f}" for f in factors)


def _build_filter_complex(clips: list[dict[str, Any]]) -> tuple[str, bool]:
    """Build the ffmpeg -filter_complex graph for the given sub-clip list.

    Returns (filter_str, has_audio). Each sub-clip emits labeled video + audio
    streams; the concat filter joins them.

    Audio handling:
    - If all clips are muted: concat=n=N:v=1:a=0 (no audio output at all).
    - Otherwise: every clip contributes an [ai] stream so concat can interleave
      [v0][a0][v1][a1]... — muted clips get a silent anullsrc track sized to
      their output duration so the stream count matches.
    """
    parts: list[str] = []
    n = len(clips)
    has_audio = any(not c.get("mute", False) for c in clips)

    for i, c in enumerate(clips):
        s_in = float(c["sourceIn"])
        s_out = float(c["sourceOut"])
        speed = float(c.get("speed", 1.0))
        volume = float(c.get("volume", 1.0))
        mute = bool(c.get("mute", False))

        v = f"[0:v]trim=start={s_in}:end={s_out},setpts=PTS-STARTPTS"
        if speed != 1.0:
            v += f",setpts=PTS/{speed}"
        v += f"[v{i}]"
        parts.append(v)

        if not has_audio:
            # All-muted shortcut: no audio chain at all.
            continue
        if mute:
            # Silent audio sized to the OUTPUT duration so concat lines up.
            output_dur = (s_out - s_in) / speed
            parts.append(f"anullsrc=cl=stereo:r=44100:d={output_dur}[a{i}]")
        else:
            a = f"[0:a]atrim=start={s_in}:end={s_out},asetpts=PTS-STARTPTS"
            if speed != 1.0:
                a += f",{_atempo_chain(speed)}"
            if volume != 1.0:
                a += f",volume={volume}"
            a += f"[a{i}]"
            parts.append(a)

    if has_audio:
        streams: list[str] = []
        for i in range(n):
            streams.append(f"[v{i}]")
            streams.append(f"[a{i}]")
        parts.append(f"{''.join(streams)}concat=n={n}:v=1:a=1[outv][outa]")
    else:
        v_streams = "".join(f"[v{i}]" for i in range(n))
        parts.append(f"{v_streams}concat=n={n}:v=1:a=0[outv]")

    return ";".join(parts), has_audio


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
    if src_path is None:
        raise FileNotFoundError(f"Source video not found: {src_input.value}")

    probe = await ffprobe_video(src_path)
    node.params["sourceDuration"] = probe.duration
    node.params["sourceFps"] = probe.fps
    node.params["sourceIsVfr"] = probe.is_vfr

    # Clamp + frame-snap existing clips against the (potentially-new) source.
    # If the source shrank, drop sub-clips that fall entirely outside and clamp
    # any that hang off the end. Snap times to the source frame grid so the
    # virtual editor preview and the final ffmpeg render agree at boundaries.
    existing_clips = node.params.get("clips")
    if existing_clips:
        snapped: list[dict[str, Any]] = []
        for c in existing_clips:
            if c["sourceIn"] >= probe.duration:
                continue
            s_in = min(c["sourceIn"], probe.duration)
            s_out = min(c["sourceOut"], probe.duration)
            if probe.fps > 0:
                s_in = int(s_in * probe.fps) / probe.fps
                s_out = int(s_out * probe.fps) / probe.fps
            snapped.append({**c, "sourceIn": s_in, "sourceOut": s_out})
        if not snapped:
            snapped = [
                {"id": "c1", "sourceIn": 0.0, "sourceOut": probe.duration, "speed": 1.0, "volume": 1.0, "mute": False}
            ]
        node.params["clips"] = snapped

    clips = node.params["clips"]

    if _is_no_op(clips, probe.duration):
        return {"video": {"type": "Video", "value": str(src_input.value)}}

    # Render path
    filter_complex, has_audio = _build_filter_complex(clips)
    run_dir = get_run_dir()
    output_path = run_dir / f"{uuid4().hex[:12]}.mp4"

    args = [
        "-i", str(src_path),
        "-filter_complex", filter_complex,
        "-map", "[outv]",
    ]
    if has_audio:
        args += ["-map", "[outa]"]
    args += [
        "-c:v", "libx264",
        "-preset", "fast",
        "-crf", "23",
        "-color_primaries", "bt709",
        "-color_trc", "bt709",
        "-colorspace", "bt709",
        "-color_range", "tv",
    ]
    if has_audio:
        args += ["-c:a", "aac", "-b:a", "192k", "-af", "aresample=async=1"]
    args += ["-progress", "pipe:1", "-stats_period", "0.25", str(output_path)]

    def _on_progress(block: dict[str, str]) -> None:
        if emit is None:
            return
        out_us = block.get("out_time_us")
        if out_us is None:
            return
        try:
            elapsed = float(out_us) / 1_000_000.0
            expected = sum(
                (c["sourceOut"] - c["sourceIn"]) / c.get("speed", 1.0)
                for c in clips
            )
            value = min(elapsed / expected, 0.99) if expected > 0 else 0.0
            import asyncio as _asyncio
            _asyncio.create_task(emit(ProgressEvent(node_id=node.id, value=value)))
        except (ValueError, KeyError):
            pass

    await run_ffmpeg(args, on_progress=_on_progress)
    return {"video": {"type": "Video", "value": str(output_path)}}
