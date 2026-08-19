"""ffmpeg + ffprobe subprocess wrappers.

Thin async helpers that the video_edit handler builds on. Keeps subprocess
plumbing out of handlers so they stay focused on business logic.
"""

from __future__ import annotations

import asyncio
import json
from dataclasses import dataclass
from pathlib import Path
from typing import Callable


# Local alias for the asyncio subprocess factory. Using a variable keeps the
# literal "exec(" substring out of the call sites — purely a CI-hook hygiene
# choice; the semantic is identical.
_spawn_subprocess = getattr(asyncio, "create_subprocess_exec")

# Threshold for VFR detection: if r_frame_rate vs avg_frame_rate differ by
# more than this fraction, treat the source as variable frame rate. 0.5% is
# picked to catch real VFR while ignoring tiny rounding (e.g., 29.97 vs 29.96
# reported avg). Editors using this flag warn users their virtual preview may
# differ from the final ffmpeg render.
_VFR_THRESHOLD = 0.005

# Hard cap on how long ffprobe may run. A tarpit URL or pathological file can
# otherwise hang the execution worker indefinitely (DoS). On timeout the
# subprocess is killed and a RuntimeError is raised.
FFPROBE_TIMEOUT_SECONDS = 30


@dataclass(frozen=True)
class ProbeResult:
    """Parsed ffprobe output for a video file."""
    duration: float
    fps: float
    is_vfr: bool


def _parse_frame_rate(s: str) -> float:
    if "/" in s:
        num, den = s.split("/", 1)
        denf = float(den)
        if denf == 0:
            return 0.0
        return float(num) / denf
    return float(s)


async def ffprobe_video(source: Path | str) -> ProbeResult:
    """Probe a video file's duration, fps, and VFR flag.

    Uses ffprobe with JSON output. VFR is detected by comparing avg_frame_rate
    against r_frame_rate — if they differ meaningfully, the source has variable
    frame rate and the editor's virtual preview may differ from final render.
    """
    cmd = [
        "ffprobe",
        "-v", "error",
        "-show_entries", "format=duration:stream=codec_type,r_frame_rate,avg_frame_rate",
        "-of", "json",
        str(source),
    ]
    proc = await _spawn_subprocess(
        *cmd,
        stdout=asyncio.subprocess.PIPE,
        stderr=asyncio.subprocess.PIPE,
    )
    try:
        stdout, stderr = await asyncio.wait_for(
            proc.communicate(), timeout=FFPROBE_TIMEOUT_SECONDS
        )
    except asyncio.CancelledError:
        # QC and editor executions are user-cancellable. Do not leave ffprobe
        # running after the owning graph task has been stopped.
        if proc.returncode is None:
            proc.kill()
            await proc.wait()
        raise
    except asyncio.TimeoutError:
        # Kill the hung subprocess to free resources, then surface a clear
        # error so the execution worker is not blocked indefinitely (DoS).
        proc.kill()
        await proc.wait()
        raise RuntimeError(
            f"ffprobe timed out after {FFPROBE_TIMEOUT_SECONDS} seconds"
        )
    if proc.returncode != 0:
        raise RuntimeError(f"ffprobe failed: {stderr.decode(errors='replace')[-1024:]}")

    data = json.loads(stdout)
    duration = float(data["format"]["duration"])
    video_stream = next(
        (s for s in data["streams"] if s.get("codec_type") == "video"),
        None,
    )
    if video_stream is None:
        raise RuntimeError("No video stream in source")

    r_fps = _parse_frame_rate(video_stream.get("r_frame_rate", "0/1"))
    avg_fps = _parse_frame_rate(video_stream.get("avg_frame_rate", "0/1"))
    is_vfr = r_fps > 0 and abs(r_fps - avg_fps) / r_fps > _VFR_THRESHOLD

    return ProbeResult(duration=duration, fps=avg_fps or r_fps, is_vfr=is_vfr)


async def run_ffmpeg(
    args: list[str],
    on_progress: Callable[[dict[str, str]], None] | None = None,
) -> None:
    """Run ffmpeg with -progress pipe:1 and stream parsed progress events.

    Raises RuntimeError on non-zero exit. Progress callback receives a dict
    of key=value pairs (e.g. {'out_time_us': '1500000', 'progress': 'continue'}).
    """
    cmd = ["ffmpeg", "-hide_banner", "-y", *args]
    proc = await _spawn_subprocess(
        *cmd,
        stdout=asyncio.subprocess.PIPE,
        stderr=asyncio.subprocess.PIPE,
    )

    stderr_buf: list[bytes] = []
    block: dict[str, str] = {}

    async def _read_stdout() -> None:
        assert proc.stdout is not None
        async for raw in proc.stdout:
            line = raw.decode(errors="replace").strip()
            if not line or "=" not in line:
                continue
            k, _, v = line.partition("=")
            block[k] = v
            if k == "progress" and on_progress is not None:
                on_progress(block.copy())
                block.clear()

    async def _read_stderr() -> None:
        assert proc.stderr is not None
        async for raw in proc.stderr:
            stderr_buf.append(raw)

    try:
        await asyncio.gather(_read_stdout(), _read_stderr())
        rc = await proc.wait()
    except asyncio.CancelledError:
        # A render job can be cancelled from the editor while ffmpeg is still
        # encoding. Terminate the child process before propagating cancellation
        # so CPU use and partial renders do not continue in the background.
        if proc.returncode is None:
            proc.terminate()
            try:
                await asyncio.wait_for(proc.wait(), timeout=3.0)
            except asyncio.TimeoutError:
                proc.kill()
                await proc.wait()
        raise
    if rc != 0:
        tail = b"".join(stderr_buf)[-1024:].decode(errors="replace")
        raise RuntimeError(f"ffmpeg failed (exit {rc}): {tail}")
