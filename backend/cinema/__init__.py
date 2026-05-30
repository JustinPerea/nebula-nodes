"""Soul Cinema deterministic pillars.

Pure, local, deterministic image processing reused by both the standalone
canvas nodes (``cinema-color``, ``cinema-look``) and the ``cinema-scene``
handler — a single source of truth per pillar.

- Soul HEX (color/palette): :func:`extract_palette`, :func:`transfer_to_palette`
- Film-look post: :func:`apply_look`
"""

from __future__ import annotations

from cinema.color import extract_palette, transfer_to_palette
from cinema.look import apply_look

__all__ = ["extract_palette", "transfer_to_palette", "apply_look"]
