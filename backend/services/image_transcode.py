"""Transcode a generated image to a chosen raster format (PNG/JPG/WEBP) for the
Create gallery's per-result download menu. Pillow only — no new dependency.

`normalize_image_format` is a pure, unit-tested mapping; `transcode_image_file`
does the Pillow conversion (flattening alpha onto white for JPEG)."""

from __future__ import annotations

import io
from pathlib import Path

from PIL import Image

# requested format -> (Pillow format, mime, file extension)
_FORMATS: dict[str, tuple[str, str, str]] = {
    "png": ("PNG", "image/png", "png"),
    "jpg": ("JPEG", "image/jpeg", "jpg"),
    "jpeg": ("JPEG", "image/jpeg", "jpg"),
    "webp": ("WEBP", "image/webp", "webp"),
}


class UnsupportedFormatError(ValueError):
    """Requested an image format we don't transcode to."""


def normalize_image_format(fmt: str) -> tuple[str, str, str]:
    """Return (Pillow format, mime, extension) for a requested format. Pure."""
    key = (fmt or "").strip().lower().lstrip(".")
    if key not in _FORMATS:
        raise UnsupportedFormatError(f"Unsupported image format: {fmt!r}")
    return _FORMATS[key]


def transcode_image_file(src: Path, fmt: str) -> tuple[bytes, str, str]:
    """Transcode the image at `src` to `fmt`. Returns (bytes, mime, filename)."""
    pil_fmt, mime, ext = normalize_image_format(fmt)
    with Image.open(src) as im:
        im.load()
        if pil_fmt == "JPEG":
            # JPEG has no alpha channel — flatten transparency onto white.
            if im.mode in ("RGBA", "LA") or (im.mode == "P" and "transparency" in im.info):
                rgba = im.convert("RGBA")
                bg = Image.new("RGB", rgba.size, (255, 255, 255))
                bg.paste(rgba, mask=rgba.split()[-1])
                im = bg
            elif im.mode != "RGB":
                im = im.convert("RGB")
        buf = io.BytesIO()
        im.save(buf, format=pil_fmt)
    return buf.getvalue(), mime, f"{src.stem}.{ext}"
