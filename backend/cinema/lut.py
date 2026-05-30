"""Minimal Adobe ``.cube`` 3D-LUT parser + trilinear application.

Pure, dependency-light (numpy only). A malformed or unreadable LUT must NEVER
crash the look pipeline — :func:`load_cube_lut` returns ``None`` on any problem
and the caller skips the LUT stage with a warning.

``.cube`` format (the subset we support):
- comment lines start with ``#``
- ``TITLE "..."`` (ignored)
- ``LUT_3D_SIZE N`` (required for a 3D LUT)
- ``LUT_1D_SIZE N`` (1D LUTs are not supported → returns None)
- ``DOMAIN_MIN r g b`` / ``DOMAIN_MAX r g b`` (optional)
- then ``N*N*N`` rows of ``r g b`` floats, red varying fastest.
"""

from __future__ import annotations

from pathlib import Path
from typing import NamedTuple

import numpy as np


class CubeLUT(NamedTuple):
    """A parsed 3D LUT: ``size**3`` entries plus the input domain."""

    size: int
    table: np.ndarray  # shape (size, size, size, 3), float64, indexed [b, g, r]
    domain_min: np.ndarray  # (3,)
    domain_max: np.ndarray  # (3,)


def load_cube_lut(path: str | Path) -> CubeLUT | None:
    """Parse a ``.cube`` 3D LUT file. Returns ``None`` on ANY error.

    Never raises — bad path, malformed body, 1D LUT, wrong row count all map to
    ``None`` so the look pipeline can skip + warn instead of crashing.
    """
    try:
        p = Path(path)
        if not p.exists() or not p.is_file():
            return None
        text = p.read_text(encoding="utf-8", errors="replace")
    except (OSError, ValueError):
        return None

    size: int | None = None
    domain_min = np.array([0.0, 0.0, 0.0])
    domain_max = np.array([1.0, 1.0, 1.0])
    rows: list[tuple[float, float, float]] = []

    try:
        for raw in text.splitlines():
            line = raw.strip()
            if not line or line.startswith("#"):
                continue
            upper = line.upper()
            if upper.startswith("TITLE"):
                continue
            if upper.startswith("LUT_1D_SIZE"):
                return None  # 1D LUTs unsupported
            if upper.startswith("LUT_3D_SIZE"):
                size = int(line.split()[1])
                continue
            if upper.startswith("DOMAIN_MIN"):
                domain_min = np.array([float(x) for x in line.split()[1:4]])
                continue
            if upper.startswith("DOMAIN_MAX"):
                domain_max = np.array([float(x) for x in line.split()[1:4]])
                continue
            parts = line.split()
            if len(parts) >= 3:
                r, g, b = float(parts[0]), float(parts[1]), float(parts[2])
                rows.append((r, g, b))
    except (ValueError, IndexError):
        return None

    if size is None or size < 2:
        return None
    if len(rows) != size ** 3:
        return None

    data = np.asarray(rows, dtype=np.float64)
    # .cube stores red varying fastest → reshape to [b, g, r, 3].
    table = data.reshape(size, size, size, 3)
    return CubeLUT(size=size, table=table, domain_min=domain_min, domain_max=domain_max)


def apply_cube_lut(rgb: np.ndarray, lut: CubeLUT) -> np.ndarray:
    """Apply a 3D LUT to an (H, W, 3) RGB array (0..255) via trilinear interp.

    Returns an (H, W, 3) float array in 0..255. Pure / deterministic.
    """
    size = lut.size
    table = lut.table
    dmin = lut.domain_min
    dmax = lut.domain_max

    arr = np.asarray(rgb, dtype=np.float64) / 255.0
    span = np.where((dmax - dmin) == 0, 1.0, dmax - dmin)
    norm = np.clip((arr - dmin) / span, 0.0, 1.0)

    # Continuous grid coordinates per channel.
    coords = norm * (size - 1)
    lo = np.floor(coords).astype(np.int64)
    hi = np.minimum(lo + 1, size - 1)
    frac = coords - lo

    r0, g0, b0 = lo[..., 0], lo[..., 1], lo[..., 2]
    r1, g1, b1 = hi[..., 0], hi[..., 1], hi[..., 2]
    fr, fg, fb = frac[..., 0:1], frac[..., 1:2], frac[..., 2:3]

    # table is indexed [b, g, r]
    def sample(bi, gi, ri):
        return table[bi, gi, ri]

    c000 = sample(b0, g0, r0)
    c100 = sample(b0, g0, r1)
    c010 = sample(b0, g1, r0)
    c110 = sample(b0, g1, r1)
    c001 = sample(b1, g0, r0)
    c101 = sample(b1, g0, r1)
    c011 = sample(b1, g1, r0)
    c111 = sample(b1, g1, r1)

    # Interpolate along red, then green, then blue.
    c00 = c000 * (1 - fr) + c100 * fr
    c10 = c010 * (1 - fr) + c110 * fr
    c01 = c001 * (1 - fr) + c101 * fr
    c11 = c011 * (1 - fr) + c111 * fr

    c0 = c00 * (1 - fg) + c10 * fg
    c1 = c01 * (1 - fg) + c11 * fg

    out = c0 * (1 - fb) + c1 * fb
    return np.clip(out, 0.0, 1.0) * 255.0
