"""Treat every intake file as untrusted (§3.2).

- Types are decided by magic bytes, never by extension.
- Size caps: 25 MB for images, 500 MB for video.
- Pillow decodes only the sniffed format, and the pixel budget (MAX_IMAGE_PIXELS) is checked from the header before decoding.
- HEIC is converted by macOS `sips` in a subprocess with a timeout.
- ffmpeg/ffprobe run with -t/-fs limits and a 60 s timeout.
- Animated GIF/WebP are analyzed on their first frame.
"""
from __future__ import annotations

import io
import json
import math
import re
import subprocess
import tempfile
import warnings
from dataclasses import dataclass
from pathlib import Path

from PIL import Image

IMAGE_CAP = 25 * 1024 * 1024
VIDEO_CAP = 500 * 1024 * 1024
ACCEPTED_EXT = {"jpg", "jpeg", "png", "webp", "gif", "heic", "mp4", "mov"}
TOOL_TIMEOUT = 60
_HEIC_BRANDS = {b"heic", b"heix", b"hevc", b"hevx", b"mif1", b"msf1"}
_MOV_ATOMS = {b"moov", b"mdat", b"wide", b"free", b"skip"}


class MediaError(Exception):
    pass


@dataclass(frozen=True)
class Sniffed:
    media: str
    mime: str
    ext: str


def sniff(data: bytes) -> Sniffed:
    head = data[:32]
    if head.startswith(b"\xff\xd8\xff"):
        return Sniffed("image", "image/jpeg", "jpg")
    if head.startswith(b"\x89PNG\r\n\x1a\n"):
        return Sniffed("image", "image/png", "png")
    if head[:6] in (b"GIF87a", b"GIF89a"):
        return Sniffed("image", "image/gif", "gif")
    if head[:4] == b"RIFF" and head[8:12] == b"WEBP":
        return Sniffed("image", "image/webp", "webp")
    if head[4:8] == b"ftyp":
        brand = head[8:12]
        if brand in _HEIC_BRANDS:
            return Sniffed("image", "image/heic", "heic")
        if brand == b"qt  ":
            return Sniffed("video", "video/quicktime", "mov")
        return Sniffed("video", "video/mp4", "mp4")
    if head[4:8] in _MOV_ATOMS:
        return Sniffed("video", "video/quicktime", "mov")
    raise MediaError("unsupported file type (accepted: jpg, png, webp, gif, heic, mp4, mov)")


def check_size(kind: str, size: int) -> None:
    if kind == "video" and size > VIDEO_CAP:
        raise MediaError("video is larger than the 500 MB cap")
    if kind == "image" and size > IMAGE_CAP:
        raise MediaError("image is larger than the 25 MB cap")


def _heic_to_png(data: bytes) -> bytes:
    with tempfile.TemporaryDirectory(prefix="commons-heic-") as tmp:
        src = Path(tmp) / "in.heic"
        dst = Path(tmp) / "out.png"
        src.write_bytes(data)
        try:
            subprocess.run(
                ["sips", "-s", "format", "png", str(src), "--out", str(dst)],
                check=True, capture_output=True, timeout=TOOL_TIMEOUT,
            )
        except (OSError, subprocess.SubprocessError) as exc:
            raise MediaError(f"HEIC conversion failed: {exc}") from exc
        return dst.read_bytes()


_PIL_FORMATS = {"image/jpeg": "JPEG", "image/png": "PNG", "image/gif": "GIF", "image/webp": "WEBP",
                "image/heic": "PNG"}  # HEIC arrives here already converted to PNG by sips


def load_image(data: bytes, mime: str) -> Image.Image:
    """Decode an untrusted image.

    - Pillow may only use the format the magic-byte sniffer chose, so the
      validator and the decoder can't disagree about what the bytes are.
    - The pixel budget is checked explicitly from the header before any
      decode. `warnings.catch_warnings()` is process-global and not
      thread-safe, and intake runs in a thread pool, so a warnings filter
      could be reset mid-load by another thread (fail-open).
    """
    fmt = _PIL_FORMATS.get(mime)
    if fmt is None:
        raise MediaError(f"unsupported image type {mime}")
    if mime == "image/heic":
        data = _heic_to_png(data)
    try:
        img = Image.open(io.BytesIO(data), formats=[fmt])
        limit = Image.MAX_IMAGE_PIXELS
        if limit and img.width * img.height > limit:
            raise MediaError(f"image has too many pixels: {img.width}x{img.height} exceeds {limit}")
        img.seek(0)
        img.load()
        return img.convert("RGB")
    except Image.DecompressionBombError as exc:
        raise MediaError(f"image has too many pixels: {exc}") from exc
    except (OSError, ValueError, SyntaxError, EOFError) as exc:
        raise MediaError(f"unreadable image: {exc}") from exc


def encode_png(img: Image.Image, max_edge: int | None = None) -> bytes:
    if max_edge and max(img.size) > max_edge:
        scale = max_edge / float(max(img.size))
        img = img.resize((max(1, round(img.width * scale)), max(1, round(img.height * scale))),
                         Image.Resampling.LANCZOS)
    buf = io.BytesIO()
    img.save(buf, "PNG")
    return buf.getvalue()


# ffmpeg/ffprobe auto-detect the container, so a file whose magic bytes say
# `ftyp` could still be parsed as, say, an HLS playlist or a concat list that
# pulls in other local files or URLs. Every input is therefore forced through
# the mov/mp4 demuxer, only the `file` protocol is allowed, external data
# references are off, and paths go in as `file:` URLs so a name can never be
# read as an option.
_INPUT_GUARD = ["-protocol_whitelist", "file", "-f", "mov", "-enable_drefs", "0"]


def _input(path: Path) -> list[str]:
    return [*_INPUT_GUARD, "-i", f"file:{Path(path).resolve()}"]


def _run(args: list[str]) -> subprocess.CompletedProcess:
    try:
        return subprocess.run(args, capture_output=True, timeout=TOOL_TIMEOUT, check=False)
    except (OSError, subprocess.TimeoutExpired) as exc:
        raise MediaError(f"{args[0]} failed: {exc}") from exc


def probe_video(path: Path) -> dict:
    proc = _run(["ffprobe", "-v", "error", "-print_format", "json",
                 "-show_streams", "-show_format", *_input(path)])
    if proc.returncode != 0:
        raise MediaError(f"ffprobe failed: {proc.stderr.decode(errors='replace')[-300:]}")
    info = json.loads(proc.stdout or b"{}")
    stream = next((s for s in info.get("streams", []) if s.get("codec_type") == "video"), None)
    if stream is None:
        raise MediaError("no video stream")
    num, _, den = str(stream.get("avg_frame_rate") or "0/1").partition("/")
    fps = float(num) / float(den) if den and float(den) else 0.0
    duration = float(info.get("format", {}).get("duration") or stream.get("duration") or 0.0)
    return {"duration": round(duration, 3), "fps": round(fps, 3),
            "width": int(stream.get("width") or 0), "height": int(stream.get("height") or 0),
            "codec": str(stream.get("codec_name") or "")}


_PTS = re.compile(r"pts_time:([0-9.]+)")


def scene_cuts(path: Path) -> list[float]:
    proc = _run(["ffmpeg", "-hide_banner", "-t", "600", *_input(path),
                 "-filter:v", "select='gt(scene,0.3)',showinfo", "-f", "null", "-"])
    return sorted({round(float(m.group(1)), 3) for m in _PTS.finditer(proc.stderr.decode(errors="replace"))})


def keyframe_times(duration: float, cuts: list[float], max_frames: int = 12) -> list[float]:
    if duration <= 0:
        return []
    bounds = [0.0] + [c for c in sorted(cuts) if 0 < c < duration] + [duration]
    if len(bounds) > 2:
        mids = [(a + b) / 2.0 for a, b in zip(bounds, bounds[1:]) if b - a > 1e-3]
        if len(mids) > max_frames:
            step = len(mids) / float(max_frames)
            mids = [mids[int(i * step)] for i in range(max_frames)]
        return [round(t, 3) for t in mids]
    n = min(max_frames, max(3, math.ceil(duration / 10.0)))
    return [round((i + 0.5) * duration / n, 3) for i in range(n)]


def extract_frame(path: Path, t: float) -> bytes:
    # -ss before -i is frame-accurate when decoding (accurate_seek is the
    # default); -fs caps the output at the image cap.
    proc = _run(["ffmpeg", "-v", "error", "-ss", f"{t:.3f}", *_input(path), "-frames:v", "1",
                 "-fs", str(IMAGE_CAP), "-f", "image2pipe", "-vcodec", "png", "-"])
    if proc.returncode != 0 or not proc.stdout:
        raise MediaError(f"frame extraction failed at {t:.3f}s")
    return proc.stdout
