"""CIEDE2000 and hex/Lab helpers on top of cinema.color's Lab conversion."""
from __future__ import annotations

import numpy as np

from cinema.color import lab_to_rgb, rgb_to_lab


def hex_to_lab(value: str) -> np.ndarray:
    text = value.strip().lstrip("#")
    if len(text) != 6:
        raise ValueError(f"not a #rrggbb colour: {value!r}")
    rgb = np.array([[int(text[i:i + 2], 16) for i in (0, 2, 4)]], dtype=np.float64)
    return rgb_to_lab(rgb)[0]


def lab_to_hex(lab: np.ndarray) -> str:
    rgb = np.clip(np.rint(lab_to_rgb(np.asarray(lab, dtype=np.float64).reshape(1, 3))), 0, 255).astype(int)[0]
    return "#{:02x}{:02x}{:02x}".format(*rgb)


def delta_e00(lab1: np.ndarray, lab2: np.ndarray) -> np.ndarray:
    """CIEDE2000 colour difference; broadcasts over leading dimensions."""
    lab1 = np.asarray(lab1, dtype=np.float64)
    lab2 = np.asarray(lab2, dtype=np.float64)
    L1, a1, b1 = lab1[..., 0], lab1[..., 1], lab1[..., 2]
    L2, a2, b2 = lab2[..., 0], lab2[..., 1], lab2[..., 2]
    c1 = np.hypot(a1, b1)
    c2 = np.hypot(a2, b2)
    cbar = (c1 + c2) / 2.0
    g = 0.5 * (1.0 - np.sqrt(cbar**7 / (cbar**7 + 25.0**7)))
    a1p = (1.0 + g) * a1
    a2p = (1.0 + g) * a2
    c1p = np.hypot(a1p, b1)
    c2p = np.hypot(a2p, b2)
    h1p = np.degrees(np.arctan2(b1, a1p)) % 360.0
    h2p = np.degrees(np.arctan2(b2, a2p)) % 360.0
    zero = (c1p * c2p) == 0

    dLp = L2 - L1
    dCp = c2p - c1p
    dhp = h2p - h1p
    dhp = np.where(dhp > 180.0, dhp - 360.0, dhp)
    dhp = np.where(dhp < -180.0, dhp + 360.0, dhp)
    dhp = np.where(zero, 0.0, dhp)
    dHp = 2.0 * np.sqrt(c1p * c2p) * np.sin(np.radians(dhp / 2.0))

    Lbp = (L1 + L2) / 2.0
    Cbp = (c1p + c2p) / 2.0
    hsum = h1p + h2p
    hbp = np.where(
        np.abs(h1p - h2p) > 180.0,
        np.where(hsum < 360.0, (hsum + 360.0) / 2.0, (hsum - 360.0) / 2.0),
        hsum / 2.0,
    )
    hbp = np.where(zero, hsum, hbp)

    t = (1.0 - 0.17 * np.cos(np.radians(hbp - 30.0)) + 0.24 * np.cos(np.radians(2.0 * hbp))
         + 0.32 * np.cos(np.radians(3.0 * hbp + 6.0)) - 0.20 * np.cos(np.radians(4.0 * hbp - 63.0)))
    d_theta = 30.0 * np.exp(-(((hbp - 275.0) / 25.0) ** 2))
    rc = 2.0 * np.sqrt(Cbp**7 / (Cbp**7 + 25.0**7))
    sl = 1.0 + (0.015 * (Lbp - 50.0) ** 2) / np.sqrt(20.0 + (Lbp - 50.0) ** 2)
    sc = 1.0 + 0.045 * Cbp
    sh = 1.0 + 0.015 * Cbp * t
    rt = -np.sin(np.radians(2.0 * d_theta)) * rc
    return np.sqrt(
        (dLp / sl) ** 2 + (dCp / sc) ** 2 + (dHp / sh) ** 2 + rt * (dCp / sc) * (dHp / sh)
    )
