"""Deterministic code measurements (§6.1 step 2).

Reuses cinema.color's seeded k-means in CIELAB (seed 1729, 256 px, NEAREST
resize) and adds what the analysis needs: a share per colour, merging of
clusters closer than dE00 5, and a separate accent pass that keeps small,
high-chroma regions (a button, a logo mark) that pixel-weighted k-means
absorbs. Palette entries are indexed P0..Pn; the model later assigns roles
by index and never emits hex (§6.1 step 3).

Accent `share` is the fraction of all pixels in that accent cluster; those
pixels also count toward a main entry, so accent shares overlap main shares.
"""
from __future__ import annotations

import cv2
import numpy as np
from PIL import Image

from cinema.color import _kmeans_lab, rgb_to_lab
from commons.colour import delta_e00, lab_to_hex

CODE_VERSION = "measure-1"
MAX_DIM = 256
K = 8
MERGE_DELTA_E = 5.0
ACCENT_MIN_CHROMA = 40.0
ACCENT_SEPARATION = 10.0
ACCENT_MIN_SHARE = 0.001
ACCENT_MAX_SHARE = 0.05


def _downsampled_rgb(img: Image.Image) -> np.ndarray:
    rgb = img.convert("RGB")
    w, h = rgb.size
    if max(w, h) > MAX_DIM:
        scale = MAX_DIM / float(max(w, h))
        rgb = rgb.resize((max(1, int(w * scale)), max(1, int(h * scale))), Image.Resampling.NEAREST)
    return np.asarray(rgb, dtype=np.uint8)


def _assign(points: np.ndarray, centers: np.ndarray) -> np.ndarray:
    return np.argmin(((points[:, None, :] - centers[None, :, :]) ** 2).sum(axis=2), axis=1)


def _merge(entries: list[list]) -> list[list]:
    """Greedily merge the closest pair under MERGE_DELTA_E until none remain."""
    items = [[np.asarray(c, dtype=np.float64), float(s)] for c, s in entries if s > 0]
    while len(items) > 1:
        best: tuple[float, int, int] | None = None
        for i in range(len(items)):
            for j in range(i + 1, len(items)):
                d = float(delta_e00(items[i][0], items[j][0]))
                if d < MERGE_DELTA_E and (best is None or d < best[0]):
                    best = (d, i, j)
        if best is None:
            break
        _, i, j = best
        (ci, si), (cj, sj) = items[i], items[j]
        items[i] = [(ci * si + cj * sj) / (si + sj), si + sj]
        del items[j]
    return items


def _palette(lab: np.ndarray) -> list[dict]:
    n = lab.shape[0]
    centers = _kmeans_lab(lab, K)
    labels = _assign(lab, centers)
    shares = np.bincount(labels, minlength=len(centers)) / float(n)
    mains = _merge([[c, s] for c, s in zip(centers, shares)])
    mains.sort(key=lambda it: (-round(it[1], 6), float(it[0][0])))

    main_centers = np.array([c for c, _ in mains])
    chroma = np.hypot(lab[:, 1], lab[:, 2])
    nearest_main = np.min(delta_e00(lab[:, None, :], main_centers[None, :, :]), axis=1)
    candidates = lab[(chroma >= ACCENT_MIN_CHROMA) & (nearest_main >= ACCENT_SEPARATION)]

    accents: list[list] = []
    if candidates.shape[0] >= max(1, int(ACCENT_MIN_SHARE * n)):
        acc_centers = _kmeans_lab(candidates, min(3, candidates.shape[0]))
        acc_labels = _assign(candidates, acc_centers)
        for j, c in enumerate(acc_centers):
            share = float((acc_labels == j).sum()) / n
            if not (ACCENT_MIN_SHARE <= share <= ACCENT_MAX_SHARE):
                continue
            existing = [m[0] for m in mains] + [a[0] for a in accents]
            if min(float(delta_e00(c, e)) for e in existing) >= MERGE_DELTA_E:
                accents.append([c, share])
        accents.sort(key=lambda it: (-round(it[1], 6), float(it[0][0])))

    out: list[dict] = []
    for c, s in mains:
        c_chroma = float(np.hypot(c[1], c[2]))
        out.append({"hex": lab_to_hex(c), "share": round(s, 4),
                    "is_accent": bool(s < ACCENT_MAX_SHARE and c_chroma >= ACCENT_MIN_CHROMA)})
    for c, s in accents:
        out.append({"hex": lab_to_hex(c), "share": round(s, 4), "is_accent": True})
    for index, entry in enumerate(out):
        entry["index"] = index
    return [{"index": e["index"], "hex": e["hex"], "share": e["share"], "is_accent": e["is_accent"]} for e in out]


def measure_image(img: Image.Image) -> dict:
    rgb = _downsampled_rgb(img)
    lab = rgb_to_lab(rgb.reshape(-1, 3).astype(np.float64))
    w, h = img.size
    return {
        "palette": _palette(lab),
        "value_range": {
            "low": round(float(np.percentile(lab[:, 0], 2)), 1),
            "high": round(float(np.percentile(lab[:, 0], 98)), 1),
        },
        "aspect": round(w / float(h), 4) if h else 0.0,
        "code_version": CODE_VERSION,
    }


def phash(img: Image.Image) -> str:
    """64-bit DCT perceptual hash (the imagehash `phash` recipe, no dependency)."""
    gray = np.asarray(img.convert("L").resize((32, 32), Image.Resampling.LANCZOS), dtype=np.float32)
    low = cv2.dct(gray)[:8, :8].flatten()
    median = float(np.median(low[1:]))
    bits = "".join("1" if v > median else "0" for v in low)
    return f"{int(bits, 2):016x}"


def phash_distance(a: str, b: str) -> int:
    return (int(a, 16) ^ int(b, 16)).bit_count()
