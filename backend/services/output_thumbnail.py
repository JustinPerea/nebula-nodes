"""Small stills of output images and videos for the zoomed-out canvas.

Zoomed out past the canvas's level-of-detail cutoff, a node shows its image
(or a still from its video) as a thumbnail instead of the full file, so an
overview of a large graph stays light (design-canvas gap 19). Each thumbnail
is made once and kept in a cache folder; the key includes the source's size
and modification time, so a changed file gets a new one. The cache keeps the
most recently used ``CACHE_LIMIT`` files.
"""
from __future__ import annotations

import asyncio
import hashlib
import os
import tempfile
import weakref
from io import BytesIO
from pathlib import Path

from PIL import Image, ImageOps

from services.output_preview import has_alpha

# Longest edge in pixels. A card is at most about 600 px tall at 100% zoom, so
# below the 40% cutoff it is under 240 css px, or 480 px on a 2x display.
EDGE = 512
JPEG_QUALITY = 80
CACHE_LIMIT = 4000
# Bumped when the encoding changes, so old thumbnails aren't reused.
_VERSION = "1"

RASTER_SUFFIXES = frozenset({".png", ".jpg", ".jpeg", ".webp", ".gif", ".bmp", ".tif", ".tiff"})
VIDEO_SUFFIXES = frozenset({".mp4", ".mov", ".webm", ".m4v", ".mkv"})

# A still from a tenth of the way in: past a fade from black, still early.
_VIDEO_STILL_AT = 0.1

# First visit to a big overview asks for many at once; bound the work. One
# semaphore per event loop (tests run several), made on first use.
_CONCURRENCY = 4
_slots: weakref.WeakKeyDictionary[asyncio.AbstractEventLoop, asyncio.Semaphore] = weakref.WeakKeyDictionary()


def _loop_slots() -> asyncio.Semaphore:
    loop = asyncio.get_running_loop()
    slots = _slots.get(loop)
    if slots is None:
        slots = _slots[loop] = asyncio.Semaphore(_CONCURRENCY)
    return slots


class ThumbnailUnavailable(Exception):
    """The file can't be made into a thumbnail (not an image or video, or unreadable)."""


def supports(path: Path) -> bool:
    suffix = path.suffix.lower()
    return suffix in RASTER_SUFFIXES or suffix in VIDEO_SUFFIXES


def _key(source: Path) -> str:
    stat = source.stat()
    raw = f"{_VERSION}|{EDGE}|{source.resolve()}|{stat.st_size}|{stat.st_mtime_ns}"
    return hashlib.sha256(raw.encode("utf-8")).hexdigest()[:32]


def _cached(cache_dir: Path, key: str) -> Path | None:
    for suffix in (".jpg", ".png"):
        candidate = cache_dir / f"{key}{suffix}"
        if candidate.is_file():
            try:
                os.utime(candidate)  # most recently used, for pruning
            except OSError:
                pass
            return candidate
    return None


def _encode(image: Image.Image) -> tuple[bytes, str]:
    image = ImageOps.exif_transpose(image)
    alpha = has_alpha(image)
    frame = image.convert("RGBA" if alpha else "RGB")
    frame.thumbnail((EDGE, EDGE), Image.Resampling.LANCZOS)
    buffer = BytesIO()
    if alpha:
        frame.save(buffer, "PNG", optimize=True)
        return buffer.getvalue(), ".png"
    frame.save(buffer, "JPEG", quality=JPEG_QUALITY, optimize=True)
    return buffer.getvalue(), ".jpg"


def _write(cache_dir: Path, key: str, data: bytes, suffix: str) -> Path:
    cache_dir.mkdir(parents=True, exist_ok=True)
    target = cache_dir / f"{key}{suffix}"
    fd, tmp = tempfile.mkstemp(dir=cache_dir, prefix=".tmp-", suffix=suffix)
    try:
        with os.fdopen(fd, "wb") as handle:
            handle.write(data)
        os.replace(tmp, target)
    except BaseException:
        Path(tmp).unlink(missing_ok=True)
        raise
    _prune(cache_dir)
    return target


def _prune(cache_dir: Path) -> None:
    """Keep the most recently used ``CACHE_LIMIT`` thumbnails."""
    try:
        entries = [entry for entry in os.scandir(cache_dir)
                   if entry.is_file() and not entry.name.startswith(".tmp-")]
    except OSError:
        return
    if len(entries) <= CACHE_LIMIT:
        return
    entries.sort(key=lambda entry: entry.stat().st_mtime)
    for entry in entries[: len(entries) - int(CACHE_LIMIT * 0.9)]:
        try:
            os.unlink(entry.path)
        except OSError:
            pass


def _image_thumbnail(source: Path) -> tuple[bytes, str]:
    try:
        with Image.open(source) as image:
            image.load()
            return _encode(image)
    except (OSError, ValueError, Image.DecompressionBombError) as exc:
        raise ThumbnailUnavailable(f"{source.name} couldn't be read as an image") from exc


async def _video_thumbnail(source: Path) -> tuple[bytes, str]:
    from services.qc_common import extract_frames

    with tempfile.TemporaryDirectory(prefix="nebula-thumb-") as work:
        try:
            frames = await extract_frames(source, [_VIDEO_STILL_AT], Path(work))
        except Exception as exc:  # noqa: BLE001 - ffmpeg missing, unreadable clip, timeout
            raise ThumbnailUnavailable(f"No still could be taken from {source.name}") from exc
        if not frames:
            raise ThumbnailUnavailable(f"No still could be taken from {source.name}")
        return await asyncio.to_thread(_image_thumbnail, frames[0])


async def thumbnail(source: Path, cache_dir: Path) -> Path:
    """The cached thumbnail for ``source``, made now if there isn't one.

    Raises ThumbnailUnavailable for other file types and unreadable files.
    """
    if not supports(source):
        raise ThumbnailUnavailable(f"{source.suffix or 'This file'} has no thumbnail")
    key = _key(source)
    cached = _cached(cache_dir, key)
    if cached is not None:
        return cached
    async with _loop_slots():
        cached = _cached(cache_dir, key)  # made by a request that held the slot
        if cached is not None:
            return cached
        if source.suffix.lower() in VIDEO_SUFFIXES:
            data, suffix = await _video_thumbnail(source)
        else:
            data, suffix = await asyncio.to_thread(_image_thumbnail, source)
        return await asyncio.to_thread(_write, cache_dir, key, data, suffix)
