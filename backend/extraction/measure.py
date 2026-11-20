"""Measure a decoded image with code: palette, value range, aspect, lightness, saturation, phash.

Everything here is origin "code": a fact about the pixels, not a reading.
"""
from __future__ import annotations

from typing import Any

from PIL import Image

from commons.measure import measure_image, phash
from services.moodboard_analysis import measure_image_stats


def measure(image: Image.Image) -> tuple[dict[str, Any], str]:
    """(the ``structure.measured`` block, the image's phash).

    The palette, value range and aspect come from ``commons.measure``;
    lightness and saturation (0-255, mean) from the moodboard measurement.
    """
    measured = measure_image(image)
    stats = measure_image_stats(image)
    block = {
        "origin": "code",
        "code_version": measured["code_version"],
        "palette": measured["palette"],
        "value_range": measured["value_range"],
        "aspect": measured["aspect"],
        "lightness": stats["lightness"],
        "saturation": stats["saturation"],
        "region_measures": {},
    }
    return block, phash(image)
