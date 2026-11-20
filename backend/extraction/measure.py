"""Measure a decoded image with code: palette, value range, aspect, lightness, saturation, phash.

Everything here is origin "code": a fact about the pixels, not a reading.
"""
from __future__ import annotations

from typing import Any

import numpy as np
from PIL import Image

from cinema.color import rgb_to_lab, visible_pixels
from commons.measure import MAX_DIM, measure_image, phash
from services.moodboard_analysis import measure_image_stats

UNITS = {"value_range": "L* 0-100", "lightness": "L* 0-100", "saturation": "HSL saturation 0-100"}


def _mean_lightness(image: Image.Image) -> float | None:
    """Mean CIELAB L* (0-100) of the visible, alpha-weighted pixels the palette reads; None when none is visible."""
    rgb, weights = visible_pixels(image, MAX_DIM)
    if rgb.shape[0] == 0:
        return None
    lab = rgb_to_lab(rgb.astype(np.float64))
    return round(float(np.average(lab[:, 0], weights=weights)), 1)


def measure(image: Image.Image) -> tuple[dict[str, Any], str]:
    """(the ``structure.measured`` block, the image's phash).

    The palette, value range and aspect come from ``commons.measure``;
    lightness is the mean L* (0-100) of the palette's own pixels; saturation is the moodboard's mean
    (0-255) rescaled to 0-100. ``units`` says so, for a record read later.
    """
    measured = measure_image(image)
    stats = measure_image_stats(image)
    block = {
        "origin": "code",
        "code_version": measured["code_version"],
        "palette": measured["palette"],
        "value_range": measured["value_range"],
        "aspect": measured["aspect"],
        "lightness": _mean_lightness(image),
        "saturation": None if stats["saturation"] is None else round(stats["saturation"] / 255.0 * 100.0, 1),
        "units": dict(UNITS),
        "region_measures": {},
    }
    return block, phash(image)
