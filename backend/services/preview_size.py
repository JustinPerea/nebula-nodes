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
from the same response. It is canvas bookkeeping (``services/agent_params``):
agents read it with a node's params and never write it.
"""
from __future__ import annotations

import io
from typing import Any

# EXIF orientations that turn the picture a quarter turn: the browser shows
# it with width and height swapped (CSS `image-orientation: from-image`).
_QUARTER_TURNS = {5, 6, 7, 8}


def preview_size(content: bytes) -> dict[str, int] | None:
    """{width, height} of an image as shown (EXIF orientation applied), read
    from its header only, or None when it can't be read."""
    from PIL import Image, UnidentifiedImageError

    try:
        with Image.open(io.BytesIO(content)) as image:  # lazy: headers, not pixels
            width, height = image.size
            orientation: Any = None
            try:
                orientation = image.getexif().get(0x0112)
            except Exception:  # a broken EXIF block leaves the size as stored
                orientation = None
    except (OSError, ValueError, TypeError, EOFError, UnidentifiedImageError, Image.DecompressionBombError):
        return None
    if width <= 0 or height <= 0:
        return None
    if orientation in _QUARTER_TURNS:
        width, height = height, width
    return {"width": int(width), "height": int(height)}
