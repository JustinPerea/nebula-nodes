"""Edit masks, shaped for the provider that reads them.

Nebula's own masks (Mask Painter, Jev Box) are white-on-black greyscale
PNGs with no alpha: white marks the area to change. Providers disagree on
what a mask means:

- OpenAI image edits change only the pixels where the mask is fully
  transparent, and the mask must be a PNG the same size as the first image.
  openai-python 3.31.0, ``Images.edit`` docstring for ``mask``: the mask's
  "fully transparent areas (e.g. where alpha is zero) indicate where `image`
  should be edited", and it must "have the same dimensions as `image`".
  ``openai_edit_mask`` converts a mask with no transparency to that form.
- FLUX Fill (Black Forest Labs, on fal) inpaints the white areas and keeps
  the black, and the mask must match the image size. ``fit_mask`` only
  resizes, keeping the polarity.
"""
from __future__ import annotations

import io
from pathlib import Path

from PIL import Image

from services.file_access import require_allowed_path

# Formats Pillow may parse here. Masks and edit inputs are images Nebula or
# the person made; nothing else should be decoded.
_FORMATS = ("PNG", "JPEG", "WEBP", "GIF")


def _open(data: bytes, label: str) -> Image.Image:
    try:
        image = Image.open(io.BytesIO(data), formats=_FORMATS)
        image.load()
    except Exception as exc:  # Pillow raises several types for bad data
        raise ValueError(f"{label} isn't a PNG, JPEG, WebP or GIF image Nebula can read") from exc
    return image


def image_size(path: str | Path) -> tuple[int, int]:
    """Pixel size of a local image, read from its header."""
    checked = require_allowed_path(path)
    with Image.open(checked, formats=_FORMATS) as image:
        return image.size


def has_transparency(image: Image.Image) -> bool:
    """True when some pixel isn't fully opaque."""
    if image.mode in ("RGBA", "LA", "PA"):
        return image.getchannel("A").getextrema()[0] < 255
    if image.mode == "P" and "transparency" in image.info:
        return image.convert("RGBA").getchannel("A").getextrema()[0] < 255
    return False


def _png(image: Image.Image) -> bytes:
    buffer = io.BytesIO()
    image.save(buffer, format="PNG", optimize=True)
    return buffer.getvalue()


def openai_edit_mask(mask: bytes, image_size: tuple[int, int]) -> bytes:
    """A mask OpenAI reads the way Nebula drew it.

    A mask that already has transparency is the person's own OpenAI-style
    mask and goes out unchanged. Otherwise white (edit) becomes alpha 0 and
    black (keep) alpha 255, split at mid-grey so edges stay hard, resized
    to the first image's size if it differs, and saved as PNG.
    """
    image = _open(mask, "The mask")
    if has_transparency(image):
        return mask
    grey = image.convert("L")
    if grey.size != tuple(image_size):
        # NEAREST keeps the edge hard instead of adding greys.
        grey = grey.resize(tuple(image_size), Image.Resampling.NEAREST)
    alpha = grey.point(lambda level: 0 if level >= 128 else 255)
    out = Image.new("RGBA", grey.size, (0, 0, 0, 255))
    out.putalpha(alpha)
    return _png(out)


def fit_mask(mask: bytes, image_size: tuple[int, int]) -> bytes | None:
    """The mask resized to ``image_size`` as PNG, or None when it already fits.

    Polarity and mode are kept: FLUX Fill reads white as fill, black as keep.
    """
    image = _open(mask, "The mask")
    if image.size == tuple(image_size):
        return None
    if image.mode not in ("1", "L", "LA", "RGB", "RGBA"):
        image = image.convert("RGBA" if has_transparency(image) else "L")
    return _png(image.resize(tuple(image_size), Image.Resampling.NEAREST))
