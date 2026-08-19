"""Shared, local-only infrastructure for the Video QC analyzer nodes.

The helpers in this module deliberately accept only files contained by a
configured Nebula output root.  Passing raw URLs to ffmpeg/Pillow/OpenCV would
re-introduce the SSRF class fixed for ``video-duration-check``.
"""

from __future__ import annotations

import asyncio
import json
import math
import re
from datetime import datetime, timezone
from pathlib import Path
from typing import Any, Iterable, Sequence
from uuid import uuid4

import numpy as np
from PIL import Image, ImageDraw, ImageOps

from services.ffmpeg import ffprobe_video, run_ffmpeg
from services.output import DEFAULT_OUTPUT_ROOT, OUTPUT_ROOT, get_run_dir, resolve_output_ref

MAX_SAMPLE_FRAMES = 12
FRAME_EXTRACTION_TIMEOUT_SECONDS = 60
CONTACT_CELL_WIDTH = 320
CONTACT_CELL_HEIGHT = 210


def _allowed_roots() -> tuple[Path, ...]:
    roots = [OUTPUT_ROOT.resolve()]
    fallback = DEFAULT_OUTPUT_ROOT.resolve()
    if fallback not in roots:
        roots.append(fallback)
    return tuple(roots)


def resolve_local_media(value: str, *, label: str) -> Path:
    """Resolve a graph media reference to a contained, existing local file."""
    if not isinstance(value, str) or not value.strip():
        raise ValueError(f"{label} is required")
    raw = value.strip()
    if raw.startswith(("http://", "https://", "data:")):
        raise ValueError(
            f"Remote or inline {label} references are not supported; "
            "use a contained /api/outputs/ reference"
        )

    resolved_ref = resolve_output_ref(raw)
    if raw.startswith("/api/outputs/") and resolved_ref == raw:
        raise ValueError(f"{label} reference escapes Nebula's output directory")
    resolved = Path(resolved_ref).expanduser().resolve()
    if not resolved.is_file():
        raise FileNotFoundError(f"{label} not found: {value}")
    if not any(_is_relative_to(resolved, root) for root in _allowed_roots()):
        raise ValueError(f"{label} must be contained by Nebula's output directory")
    return resolved


def _is_relative_to(path: Path, root: Path) -> bool:
    try:
        path.relative_to(root)
        return True
    except ValueError:
        return False


def bounded_sample_count(raw: Any, *, default: int = 5) -> int:
    try:
        count = int(raw)
    except (TypeError, ValueError):
        count = default
    return max(2, min(MAX_SAMPLE_FRAMES, count))


def evenly_spaced_points(count: int) -> list[float]:
    """Return bounded normalized positions including both clip boundaries."""
    count = bounded_sample_count(count)
    return [float(value) for value in np.linspace(0.0, 1.0, count)]


async def extract_frames(
    video_path: Path,
    sample_points: Sequence[float],
    work_dir: Path,
) -> list[Path]:
    """Extract bounded, scaled PNG samples at normalized clip positions."""
    probe = await ffprobe_video(video_path)
    if probe.duration <= 0:
        raise ValueError("Video duration must be positive")

    points = list(sample_points)[:MAX_SAMPLE_FRAMES]
    if not points:
        raise ValueError("At least one sample point is required")
    work_dir.mkdir(parents=True, exist_ok=True)
    loop = asyncio.get_running_loop()
    deadline = loop.time() + FRAME_EXTRACTION_TIMEOUT_SECONDS

    frames: list[Path] = []
    for index, point in enumerate(points):
        try:
            normalized = float(point)
        except (TypeError, ValueError):
            raise ValueError(f"Invalid sample point: {point!r}") from None
        normalized = min(1.0, max(0.0, normalized))
        # Seeking exactly to EOF commonly yields no frame. Keep the final sample
        # inside the media timeline while preserving a true boundary comparison.
        # Container duration commonly points one frame beyond the final
        # decodable presentation timestamp. Stay one nominal frame inside the
        # timeline so the 1.0 boundary sample works for low-FPS and VFR clips.
        frame_interval = 1.0 / probe.fps if probe.fps > 0 else 0.04
        timestamp = min(
            max(0.0, probe.duration - max(0.001, frame_interval)),
            probe.duration * normalized,
        )
        timestamp = max(0.0, timestamp)
        destination = work_dir / f"frame-{index:02d}.png"
        args = [
            "-ss",
            f"{timestamp:.6f}",
            "-i",
            str(video_path),
            "-frames:v",
            "1",
            "-vf",
            "scale=960:-2:force_original_aspect_ratio=decrease",
            str(destination),
        ]
        try:
            remaining = deadline - loop.time()
            if remaining <= 0:
                raise asyncio.TimeoutError
            await asyncio.wait_for(
                run_ffmpeg(args), timeout=remaining
            )
        except asyncio.TimeoutError as exc:
            raise RuntimeError(
                f"Frame extraction timed out after {FRAME_EXTRACTION_TIMEOUT_SECONDS} seconds"
            ) from exc
        if not destination.is_file():
            raise RuntimeError(f"ffmpeg did not produce sample frame {index}")
        frames.append(destination)
    return frames


def open_rgb(path: Path) -> Image.Image:
    with Image.open(path) as image:
        return image.convert("RGB")


def normalized_rgb(image: Image.Image, size: tuple[int, int] = (320, 180)) -> np.ndarray:
    resized = ImageOps.fit(image.convert("RGB"), size, method=Image.Resampling.LANCZOS)
    return np.asarray(resized, dtype=np.float32) / 255.0


def create_annotated_frame(
    frames: Sequence[Image.Image | Path],
    *,
    title: str,
    labels: Sequence[str] | None = None,
    boxes: dict[int, Sequence[tuple[int, int, int, int]]] | None = None,
    footer: Sequence[str] | None = None,
) -> Image.Image:
    """Create a compact contact sheet with labels, boxes, and report footer."""
    if not frames:
        raise ValueError("Cannot annotate an empty frame list")
    loaded = [open_rgb(item) if isinstance(item, Path) else item.convert("RGB") for item in frames]
    columns = min(3, len(loaded))
    rows = math.ceil(len(loaded) / columns)
    title_h = 38
    label_h = 24
    footer_lines = list(footer or [])[:6]
    footer_h = 16 + 20 * len(footer_lines) if footer_lines else 0
    canvas = Image.new(
        "RGB",
        (columns * CONTACT_CELL_WIDTH, title_h + rows * (CONTACT_CELL_HEIGHT + label_h) + footer_h),
        "#0b0d10",
    )
    draw = ImageDraw.Draw(canvas)
    draw.text((12, 11), title, fill="#f4f5f7")

    for index, image in enumerate(loaded):
        col = index % columns
        row = index // columns
        x = col * CONTACT_CELL_WIDTH
        y = title_h + row * (CONTACT_CELL_HEIGHT + label_h)
        fitted = ImageOps.fit(
            image,
            (CONTACT_CELL_WIDTH, CONTACT_CELL_HEIGHT),
            method=Image.Resampling.LANCZOS,
        )
        canvas.paste(fitted, (x, y))
        for box in (boxes or {}).get(index, []):
            sx = CONTACT_CELL_WIDTH / max(1, image.width)
            sy = CONTACT_CELL_HEIGHT / max(1, image.height)
            left, top, width, height = box
            draw.rectangle(
                (x + left * sx, y + top * sy, x + (left + width) * sx, y + (top + height) * sy),
                outline="#65e6c4",
                width=3,
            )
        label = labels[index] if labels and index < len(labels) else f"Frame {index + 1}"
        draw.rectangle((x, y + CONTACT_CELL_HEIGHT, x + CONTACT_CELL_WIDTH, y + CONTACT_CELL_HEIGHT + label_h), fill="#15191f")
        draw.text((x + 8, y + CONTACT_CELL_HEIGHT + 6), label[:56], fill="#cbd3dc")

    if footer_lines:
        footer_y = title_h + rows * (CONTACT_CELL_HEIGHT + label_h) + 8
        for line in footer_lines:
            draw.text((12, footer_y), line[:140], fill="#aeb9c5")
            footer_y += 20
    return canvas


def save_annotated_output(image: Image.Image, *, node_id: str, stem: str) -> tuple[Path, str]:
    run_dir = get_run_dir()
    safe_node = re.sub(r"[^a-zA-Z0-9_-]+", "-", node_id).strip("-") or "node"
    safe_stem = re.sub(r"[^a-zA-Z0-9_-]+", "-", stem).strip("-") or "qc"
    path = run_dir / f"{safe_stem}-{safe_node}-{uuid4().hex[:8]}.png"
    image.save(path, format="PNG", optimize=True)
    relative = path.resolve().relative_to(OUTPUT_ROOT.resolve()).as_posix()
    return path, f"/api/outputs/{relative}"


def format_report(findings: dict[str, Any], *, node_id: str, mode: str) -> str:
    payload = dict(findings)
    payload["mode"] = mode
    payload["node_id"] = node_id
    payload["timestamp"] = datetime.now(timezone.utc).isoformat()
    return json.dumps(payload, sort_keys=True, separators=(",", ":"), allow_nan=False)


def clamp_score(value: Any, default: float = 0.0) -> float:
    try:
        number = float(value)
    except (TypeError, ValueError):
        number = default
    if not math.isfinite(number):
        number = default
    return round(max(0.0, min(1.0, number)), 4)


def as_string_list(value: Any, *, allowed: Iterable[str] | None = None) -> list[str]:
    items = value if isinstance(value, list) else []
    result = [str(item) for item in items if isinstance(item, (str, int, float))]
    if allowed is not None:
        allowed_set = set(allowed)
        result = [item for item in result if item in allowed_set]
    return result[:20]
