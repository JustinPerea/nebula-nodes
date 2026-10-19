"""Small previews of node outputs, sized for an agent to look at inline.

MCP clients cap tool results (Claude Code: 25,000 tokens by default, images
included), so previews are downscaled and re-encoded under a byte budget.
"""
from __future__ import annotations

import io
from pathlib import Path

from PIL import Image, ImageOps

SIZES = {"small": 512, "medium": 1024, "large": 1568}
MAX_BYTES = 350_000
_SHEET_GAP = 8


def has_alpha(image: Image.Image) -> bool:
    if image.mode in ("RGBA", "LA") or (image.mode == "P" and "transparency" in image.info):
        alpha = image.convert("RGBA").getchannel("A")
        return alpha.getextrema()[0] < 255
    return False


def _encode(image: Image.Image, longest: int) -> tuple[bytes, str]:
    """Fit `image` within `longest` px and under MAX_BYTES; PNG only when it has transparency."""
    image = ImageOps.exif_transpose(image)
    alpha = has_alpha(image)
    edge = longest
    while True:
        frame = image.copy()
        frame.thumbnail((edge, edge), Image.Resampling.LANCZOS)
        if alpha:
            buffer = io.BytesIO()
            frame.convert("RGBA").save(buffer, "PNG", optimize=True)
            data = buffer.getvalue()
            if len(data) <= MAX_BYTES or edge <= 256:
                return data, "image/png"
        else:
            rgb = frame.convert("RGB")
            for quality in (85, 72, 60):
                buffer = io.BytesIO()
                rgb.save(buffer, "JPEG", quality=quality, optimize=True)
                data = buffer.getvalue()
                if len(data) <= MAX_BYTES:
                    return data, "image/jpeg"
            if edge <= 256:
                return data, "image/jpeg"
        edge = int(edge * 0.8)


def image_preview(path: Path, size: str = "medium") -> tuple[bytes, str]:
    with Image.open(path) as image:
        image.load()
        return _encode(image, SIZES.get(size, SIZES["medium"]))


def contact_sheet(paths: list[Path], size: str = "medium") -> tuple[bytes, str]:
    """Several images side by side in one preview (video frames, image arrays)."""
    longest = SIZES.get(size, SIZES["medium"])
    tiles: list[Image.Image] = []
    for path in paths:
        with Image.open(path) as image:
            tile = ImageOps.exif_transpose(image).convert("RGB")
        tile.thumbnail((longest, longest), Image.Resampling.LANCZOS)
        tiles.append(tile)
    if not tiles:
        raise ValueError("nothing to preview")
    height = max(tile.height for tile in tiles)
    width = sum(tile.width for tile in tiles) + _SHEET_GAP * (len(tiles) - 1)
    sheet = Image.new("RGB", (width, height), (24, 24, 24))
    x = 0
    for tile in tiles:
        sheet.paste(tile, (x, (height - tile.height) // 2))
        x += tile.width + _SHEET_GAP
    return _encode(sheet, max(longest, min(width, longest * 2)))
