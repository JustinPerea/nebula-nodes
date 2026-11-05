"""An uploaded image's size as a browser shows it, kept with its preview.

The Inspector's preview (`.inspector__file-preview`) is laid out at 0 px
until the image decodes, so the floating Inspector measured the wrong height
on the first frames after it opened (#226 review 1, MEDIUM-1). With the size
known when the file is stored, the preview gets its aspect ratio before it
loads (`width`/`height` on the `<img>`) and the panel measures right on its
first frame.

Where it lives: ``POST /api/uploads`` returns ``previewSize`` for an image,
and a node it creates (``create_node``: a canvas drop, ``nebula upload``, MCP
``upload_file``) gets it as the private param ``_previewSize``, next to
``_previewUrl``. The Inspector's own upload control stores the same param
from the same response. It is a private layout param, the canvas's own
bookkeeping (``services/agent_params``): agents can't write it, and it isn't
shown to them (node params they read leave ``_`` keys out, and the upload
answer ``nebula upload`` and MCP ``upload_file`` return doesn't carry it).
Where an agent or the CLI changes the file (``filePath``, ``_previewUrl``),
``main`` drops the size that went with the old one.

Headers only, never pixels (#226 review 2, MEDIUM-2): Pillow's
``getexif()`` decodes a whole PNG when its EXIF isn't ahead of the pixel
data, so the orientation is read from the EXIF block the header already
holds (``info["exif"]``: JPEG's APP1, WebP's EXIF chunk, a PNG eXIf chunk
before its first IDAT, the only one browsers honour). A size over
``Image.MAX_IMAGE_PIXELS`` is not reported at all. The route runs this off
the event loop (``asyncio.to_thread``).
"""
from __future__ import annotations

import io
from typing import Any

# EXIF orientations that turn the picture a quarter turn: the browser shows
# it with width and height swapped (CSS `image-orientation: from-image`).
_QUARTER_TURNS = {5, 6, 7, 8}
_ORIENTATION = 0x0112


def _orientation(raw: Any) -> Any:
    """The EXIF orientation in a header's raw EXIF block, or None."""
    from PIL import Image

    if not isinstance(raw, (bytes, bytearray)) or not raw:
        return None
    exif = Image.Exif()
    exif.load(bytes(raw))
    return exif.get(_ORIENTATION)


def preview_size(content: bytes) -> dict[str, int] | None:
    """{width, height} of an image as shown (EXIF orientation applied), read
    from its header only, or None when it can't be read or is too large."""
    from PIL import Image, UnidentifiedImageError

    try:
        # Image.open reads the header; nothing here calls load().
        with Image.open(io.BytesIO(content)) as image:
            width, height = image.size
            raw_exif = image.info.get("exif")
    except (OSError, ValueError, TypeError, EOFError, UnidentifiedImageError, Image.DecompressionBombError):
        return None
    if width <= 0 or height <= 0:
        return None
    # Image.open only refuses twice the limit; a size past the limit itself
    # is one Nebula would never decode either.
    ceiling = Image.MAX_IMAGE_PIXELS
    if ceiling is not None and width * height > ceiling:
        return None
    try:
        orientation = _orientation(raw_exif)
    except Exception:  # a broken EXIF block leaves the size as stored
        orientation = None
    if orientation in _QUARTER_TURNS:
        width, height = height, width
    return {"width": int(width), "height": int(height)}
