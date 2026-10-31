"""Deterministic code measurements (§6.1 step 2).

Reuses cinema.color's seeded k-means in CIELAB (seed 1729, 256 px, NEAREST
resize) and adds what the analysis needs: a share per colour, merging of
clusters closer than dE00 5, and a separate accent pass that keeps small,
high-chroma regions (a button, a logo mark) that pixel-weighted k-means
absorbs. Palette entries are indexed P0..Pn; the model later assigns roles
by index and never emits hex (§6.1 step 3).

Accent `share` is the fraction of all pixels in that accent cluster; those
pixels also count toward a main entry, so accent shares overlap main shares.

``measure_image`` takes the three thresholds as optional overrides (a moodboard
dry run tries other values). Left out, each is the module constant, read at
call time, so every existing caller measures exactly as before.

Alpha counts (measure-2): pixels come from cinema.color.visible_pixels, so a
transparent pixel isn't a colour and a partly transparent one counts by its
alpha. Shares are of the visible (alpha-weighted) pixels. An image with no
transparency measures exactly as in measure-1; a fully transparent one has an
empty palette and no value range.
"""
from __future__ import annotations

import cv2
import numpy as np
from PIL import Image

from cinema.color import _kmeans_lab, rgb_to_lab, visible_pixels
from commons.colour import delta_e00, lab_to_hex

# measure-2: alpha counts (see above). Opaque images measure as in measure-1.
CODE_VERSION = "measure-2"
MAX_DIM = 256
K = 8
MERGE_DELTA_E = 5.0
ACCENT_MIN_CHROMA = 40.0
ACCENT_SEPARATION = 10.0
ACCENT_MIN_SHARE = 0.001
ACCENT_MAX_SHARE = 0.05


def _assign(points: np.ndarray, centers: np.ndarray) -> np.ndarray:
    return np.argmin(((points[:, None, :] - centers[None, :, :]) ** 2).sum(axis=2), axis=1)


def _merge(entries: list[list], merge_delta_e: float) -> list[list]:
    """Greedily merge the closest pair under ``merge_delta_e`` until none remain."""
    items = [[np.asarray(c, dtype=np.float64), float(s)] for c, s in entries if s > 0]
    while len(items) > 1:
        best: tuple[float, int, int] | None = None
        for i in range(len(items)):
            for j in range(i + 1, len(items)):
                d = float(delta_e00(items[i][0], items[j][0]))
                if d < merge_delta_e and (best is None or d < best[0]):
                    best = (d, i, j)
        if best is None:
            break
        _, i, j = best
        (ci, si), (cj, sj) = items[i], items[j]
        items[i] = [(ci * si + cj * sj) / (si + sj), si + sj]
        del items[j]
    return items


def _palette(lab: np.ndarray, accent_min_chroma: float, accent_separation: float,
             merge_delta_e: float, weights: np.ndarray | None = None) -> list[dict]:
    """``weights``: each pixel's alpha weight (cinema.color.visible_pixels),
    or None when every pixel is opaque, which counts pixels as measure-1 did."""
    n = lab.shape[0]
    if n == 0:
        return []
    total = float(n) if weights is None else float(weights.sum())

    def mass(mask: np.ndarray) -> float:
        return float(mask.sum()) if weights is None else float(weights[mask].sum())

    centers = _kmeans_lab(lab, K, weights=weights)
    labels = _assign(lab, centers)
    shares = np.bincount(labels, weights=weights, minlength=len(centers)) / total
    mains = _merge([[c, s] for c, s in zip(centers, shares)], merge_delta_e)
    mains.sort(key=lambda it: (-round(it[1], 6), float(it[0][0])))

    main_centers = np.array([c for c, _ in mains])
    chroma = np.hypot(lab[:, 1], lab[:, 2])
    nearest_main = np.min(delta_e00(lab[:, None, :], main_centers[None, :, :]), axis=1)
    is_candidate = (chroma >= accent_min_chroma) & (nearest_main >= accent_separation)
    candidates = lab[is_candidate]
    candidate_weights = None if weights is None else weights[is_candidate]

    accents: list[list] = []
    if candidates.shape[0] and mass(is_candidate) >= max(1, int(ACCENT_MIN_SHARE * total)):
        acc_centers = _kmeans_lab(candidates, min(3, candidates.shape[0]), weights=candidate_weights)
        acc_labels = _assign(candidates, acc_centers)
        for j, c in enumerate(acc_centers):
            in_cluster = acc_labels == j
            share = (float(in_cluster.sum()) if candidate_weights is None
                     else float(candidate_weights[in_cluster].sum())) / total
            if not (ACCENT_MIN_SHARE <= share <= ACCENT_MAX_SHARE):
                continue
            existing = [m[0] for m in mains] + [a[0] for a in accents]
            if min(float(delta_e00(c, e)) for e in existing) >= merge_delta_e:
                accents.append([c, share])
        accents.sort(key=lambda it: (-round(it[1], 6), float(it[0][0])))

    out: list[dict] = []
    for c, s in mains:
        c_chroma = float(np.hypot(c[1], c[2]))
        out.append({"hex": lab_to_hex(c), "share": round(s, 4),
                    "is_accent": bool(s < ACCENT_MAX_SHARE and c_chroma >= accent_min_chroma)})
    for c, s in accents:
        out.append({"hex": lab_to_hex(c), "share": round(s, 4), "is_accent": True})
    for index, entry in enumerate(out):
        entry["index"] = index
    return [{"index": e["index"], "hex": e["hex"], "share": e["share"], "is_accent": e["is_accent"]} for e in out]


def _value_range(lightness: np.ndarray, weights: np.ndarray | None) -> dict | None:
    if lightness.shape[0] == 0:
        return None
    if weights is None:
        low, high = np.percentile(lightness, 2), np.percentile(lightness, 98)
    else:
        low = np.percentile(lightness, 2, weights=weights, method="inverted_cdf")
        high = np.percentile(lightness, 98, weights=weights, method="inverted_cdf")
    return {"low": round(float(low), 1), "high": round(float(high), 1)}


def measure_image(img: Image.Image, *, accent_min_chroma: float | None = None,
                  accent_separation: float | None = None, merge_delta_e: float | None = None) -> dict:
    """Measure ``img`` in any mode; alpha counts (see the module note). A
    fully transparent image gives an empty palette and ``value_range`` None."""
    rgb, weights = visible_pixels(img, MAX_DIM)
    lab = rgb_to_lab(rgb.astype(np.float64))
    w, h = img.size
    return {
        "palette": _palette(
            lab,
            ACCENT_MIN_CHROMA if accent_min_chroma is None else float(accent_min_chroma),
            ACCENT_SEPARATION if accent_separation is None else float(accent_separation),
            MERGE_DELTA_E if merge_delta_e is None else float(merge_delta_e),
            weights,
        ),
        "value_range": _value_range(lab[:, 0], weights),
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
