"""Palette utilities.

Palette extraction itself lives in :mod:`cinema.color` (k-means in CIELAB,
fixed seed) since it shares the sRGB↔Lab conversion machinery with color
transfer. This module is a thin namespace that re-exports the palette-facing
helpers so callers can ``from cinema.palette import extract_palette`` when that
reads more clearly than reaching into ``color``.
"""

from __future__ import annotations

from cinema.color import extract_palette, parse_hex_color

__all__ = ["extract_palette", "parse_hex_color"]
