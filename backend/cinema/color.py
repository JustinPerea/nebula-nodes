"""Soul HEX — deterministic local color / palette processing.

Pure functions over Pillow images and numpy arrays. No I/O, no API calls,
no randomness without a fixed seed: identical inputs always produce
byte-identical outputs (ExecutionCache-friendly).

Two public entry points:

- ``extract_palette(img, k=6)`` — k-means in CIELAB with a FIXED seed,
  returns the cluster-center colors as ``#rrggbb`` hex strings.
- ``transfer_to_palette(img, swatches, strength, method)`` — push an image's
  colors toward a target palette. Three methods:
    * ``'lab-transfer'`` (default) — Reinhard mean/std match in Lab toward the
      palette's aggregate statistics, then nudge each pixel toward its nearest
      target swatch by ``strength``.
    * ``'reinhard'`` — classic global mean/std color transfer in Lab using the
      palette as the reference distribution.
    * ``'histogram'`` — per-channel histogram matching toward the palette
      distribution (in RGB).

The hex parser ``_parse_recraft_color`` lives here as the single source of
truth (it was historically defined in ``execution.sync_runner``; that module
now re-imports it from here so the Recraft handler and its tests keep working).
"""

from __future__ import annotations

from typing import Any

import numpy as np
from PIL import Image

# Fixed seed so k-means cluster initialisation is reproducible across runs.
_KMEANS_SEED = 1729
_KMEANS_ITERS = 24


# ---------------------------------------------------------------------------
# Hex parsing (single source of truth — re-exported by sync_runner)
# ---------------------------------------------------------------------------


def _parse_recraft_color(value: Any) -> dict[str, int] | None:
    """Parse a single color value into an RGBColor dict ``{r, g, b}``.

    Accepts:
    - Hex string: ``"#FF0000"`` or ``"FF0000"`` → ``{"r": 255, "g": 0, "b": 0}``
    - RGB dict: ``{"r": 255, "g": 0, "b": 0}`` (returned as-is, ints coerced)

    Returns ``None`` if the value cannot be parsed.
    """
    if isinstance(value, dict):
        if "r" in value and "g" in value and "b" in value:
            return {"r": int(value["r"]), "g": int(value["g"]), "b": int(value["b"])}
        return None
    s = str(value).strip().lstrip("#")
    if len(s) == 6:
        try:
            return {
                "r": int(s[0:2], 16),
                "g": int(s[2:4], 16),
                "b": int(s[4:6], 16),
            }
        except ValueError:
            return None
    return None


def parse_hex_color(value: Any) -> tuple[int, int, int] | None:
    """Parse a hex string / ``{r,g,b}`` dict into an ``(r, g, b)`` tuple.

    Thin convenience wrapper over :func:`_parse_recraft_color` for callers that
    want a tuple instead of a dict. Returns ``None`` on unparseable input.
    """
    parsed = _parse_recraft_color(value)
    if parsed is None:
        return None
    return (parsed["r"], parsed["g"], parsed["b"])


def _swatches_to_rgb_array(swatches: list[Any]) -> np.ndarray:
    """Convert a list of hex/dict swatches into an (N, 3) float64 RGB array.

    Unparseable swatches are skipped. Returns an empty (0, 3) array if nothing
    parses, which callers treat as a no-op.
    """
    rows: list[tuple[int, int, int]] = []
    for sw in swatches or []:
        rgb = parse_hex_color(sw)
        if rgb is not None:
            rows.append(rgb)
    if not rows:
        return np.zeros((0, 3), dtype=np.float64)
    return np.asarray(rows, dtype=np.float64)


# ---------------------------------------------------------------------------
# sRGB <-> CIELAB conversion (D65, vectorised, no external deps)
# ---------------------------------------------------------------------------


def _srgb_to_linear(c: np.ndarray) -> np.ndarray:
    """sRGB (0..1) → linear RGB. Vectorised, matches the standard EOTF."""
    return np.where(c <= 0.04045, c / 12.92, ((c + 0.055) / 1.055) ** 2.4)


def _linear_to_srgb(c: np.ndarray) -> np.ndarray:
    """Linear RGB → sRGB (0..1). Inverse of :func:`_srgb_to_linear`."""
    c = np.clip(c, 0.0, 1.0)
    return np.where(c <= 0.0031308, c * 12.92, 1.055 * (c ** (1.0 / 2.4)) - 0.055)


# D65 reference white
_XYZ_WHITE = np.array([0.95047, 1.0, 1.08883], dtype=np.float64)

# Linear-sRGB → XYZ matrix (D65)
_RGB_TO_XYZ = np.array(
    [
        [0.4124564, 0.3575761, 0.1804375],
        [0.2126729, 0.7151522, 0.0721750],
        [0.0193339, 0.1191920, 0.9503041],
    ],
    dtype=np.float64,
)
_XYZ_TO_RGB = np.linalg.inv(_RGB_TO_XYZ)

_LAB_EPS = 216.0 / 24389.0
_LAB_KAPPA = 24389.0 / 27.0


def rgb_to_lab(rgb: np.ndarray) -> np.ndarray:
    """Convert an RGB array (..., 3) in 0..255 to CIELAB (..., 3).

    L in 0..100, a/b roughly -128..127. Operates on any leading shape.
    """
    arr = np.asarray(rgb, dtype=np.float64) / 255.0
    lin = _srgb_to_linear(arr)
    xyz = lin @ _RGB_TO_XYZ.T
    xyz = xyz / _XYZ_WHITE

    def _f(t: np.ndarray) -> np.ndarray:
        return np.where(t > _LAB_EPS, np.cbrt(t), (_LAB_KAPPA * t + 16.0) / 116.0)

    fx, fy, fz = _f(xyz[..., 0]), _f(xyz[..., 1]), _f(xyz[..., 2])
    L = 116.0 * fy - 16.0
    a = 500.0 * (fx - fy)
    b = 200.0 * (fy - fz)
    return np.stack([L, a, b], axis=-1)


def lab_to_rgb(lab: np.ndarray) -> np.ndarray:
    """Convert a CIELAB array (..., 3) back to RGB (..., 3) in 0..255 float.

    Result is NOT rounded/clipped to uint8 here — callers decide. Values may
    fall slightly outside 0..255 before clipping.
    """
    lab = np.asarray(lab, dtype=np.float64)
    L, a, b = lab[..., 0], lab[..., 1], lab[..., 2]
    fy = (L + 16.0) / 116.0
    fx = fy + a / 500.0
    fz = fy - b / 200.0

    def _finv(t: np.ndarray) -> np.ndarray:
        t3 = t ** 3
        return np.where(t3 > _LAB_EPS, t3, (116.0 * t - 16.0) / _LAB_KAPPA)

    xyz = np.stack([_finv(fx), _finv(fy), _finv(fz)], axis=-1) * _XYZ_WHITE
    lin = xyz @ _XYZ_TO_RGB.T
    srgb = _linear_to_srgb(lin)
    return srgb * 255.0


# ---------------------------------------------------------------------------
# Image helpers
# ---------------------------------------------------------------------------


def _to_rgb_array(img: Image.Image) -> np.ndarray:
    """Pillow image → (H, W, 3) uint8 RGB array, dropping any alpha."""
    if img.mode != "RGB":
        img = img.convert("RGB")
    return np.asarray(img, dtype=np.uint8)


def _array_to_image(arr: np.ndarray) -> Image.Image:
    """(H, W, 3) float/int array → clipped uint8 RGB Pillow image."""
    clipped = np.clip(np.rint(arr), 0, 255).astype(np.uint8)
    return Image.fromarray(clipped, mode="RGB")


# ---------------------------------------------------------------------------
# Palette extraction — k-means in CIELAB (fixed seed)
# ---------------------------------------------------------------------------


def _kmeans_lab(points: np.ndarray, k: int, seed: int = _KMEANS_SEED) -> np.ndarray:
    """Deterministic Lloyd's k-means over (N, 3) Lab points.

    Uses k-means++ seeding driven by a seeded RNG so cluster centres are
    reproducible. Returns the (k, 3) cluster centres sorted by lightness (L)
    so the palette order is stable.
    """
    rng = np.random.default_rng(seed)
    n = points.shape[0]
    k = max(1, min(k, n))

    # k-means++ seeding
    first = int(rng.integers(0, n))
    centers = [points[first]]
    closest_sq = np.sum((points - centers[0]) ** 2, axis=1)
    for _ in range(1, k):
        total = float(closest_sq.sum())
        if total <= 0.0:
            # All remaining points coincide with chosen centres; pad arbitrarily.
            centers.append(points[int(rng.integers(0, n))])
            continue
        probs = closest_sq / total
        idx = int(rng.choice(n, p=probs))
        centers.append(points[idx])
        new_sq = np.sum((points - points[idx]) ** 2, axis=1)
        closest_sq = np.minimum(closest_sq, new_sq)

    centroids = np.asarray(centers, dtype=np.float64)

    for _ in range(_KMEANS_ITERS):
        dists = np.sum((points[:, None, :] - centroids[None, :, :]) ** 2, axis=2)
        labels = np.argmin(dists, axis=1)
        new_centroids = centroids.copy()
        for j in range(k):
            members = points[labels == j]
            if members.shape[0] > 0:
                new_centroids[j] = members.mean(axis=0)
        if np.allclose(new_centroids, centroids):
            centroids = new_centroids
            break
        centroids = new_centroids

    # Stable ordering by lightness
    order = np.argsort(centroids[:, 0])
    return centroids[order]


def extract_palette(img: Image.Image, k: int = 6) -> list[str]:
    """Extract a ``k``-color palette from ``img`` via k-means in CIELAB.

    Deterministic: same image + k → same hex list (fixed seed). Returns a list
    of ``#rrggbb`` strings ordered from darkest to lightest. Large images are
    downsampled to keep clustering fast without changing the result materially
    (the resize is deterministic too).
    """
    rgb = _to_rgb_array(img)

    # Deterministic downsample for speed on big inputs.
    h, w = rgb.shape[:2]
    max_dim = 256
    if max(h, w) > max_dim:
        scale = max_dim / float(max(h, w))
        small = img.convert("RGB").resize(
            (max(1, int(w * scale)), max(1, int(h * scale))),
            Image.Resampling.NEAREST,
        )
        rgb = np.asarray(small, dtype=np.uint8)

    pixels = rgb.reshape(-1, 3).astype(np.float64)
    lab = rgb_to_lab(pixels)
    centers_lab = _kmeans_lab(lab, k)
    centers_rgb = lab_to_rgb(centers_lab)
    centers_rgb = np.clip(np.rint(centers_rgb), 0, 255).astype(int)

    return ["#{:02x}{:02x}{:02x}".format(int(r), int(g), int(b)) for r, g, b in centers_rgb]


# ---------------------------------------------------------------------------
# Color transfer
# ---------------------------------------------------------------------------


def _reinhard_match(src_lab: np.ndarray, ref_lab: np.ndarray) -> np.ndarray:
    """Reinhard mean/std transfer of ``src_lab`` (N, 3) toward ``ref_lab`` stats.

    For each Lab channel: ``out = (src - mean_src) * (std_ref / std_src) + mean_ref``.
    Guards against zero variance.
    """
    src_mean = src_lab.mean(axis=0)
    src_std = src_lab.std(axis=0)
    ref_mean = ref_lab.mean(axis=0)
    ref_std = ref_lab.std(axis=0)

    safe_src_std = np.where(src_std < 1e-6, 1.0, src_std)
    scale = ref_std / safe_src_std
    return (src_lab - src_mean) * scale + ref_mean


def _nudge_to_nearest(lab: np.ndarray, target_lab: np.ndarray, strength: float) -> np.ndarray:
    """Move each Lab pixel a fraction ``strength`` toward its nearest target swatch."""
    if target_lab.shape[0] == 0 or strength <= 0.0:
        return lab
    dists = np.sum((lab[:, None, :] - target_lab[None, :, :]) ** 2, axis=2)
    nearest = target_lab[np.argmin(dists, axis=1)]
    return lab + (nearest - lab) * strength


def _histogram_match_channel(src: np.ndarray, ref: np.ndarray) -> np.ndarray:
    """Match the distribution of ``src`` (0..255) to ``ref`` via CDF mapping."""
    src_int = src.astype(np.int64)
    ref_int = np.clip(np.rint(ref), 0, 255).astype(np.int64)

    src_hist = np.bincount(src_int, minlength=256).astype(np.float64)
    ref_hist = np.bincount(ref_int, minlength=256).astype(np.float64)

    src_cdf = np.cumsum(src_hist)
    ref_cdf = np.cumsum(ref_hist)
    if src_cdf[-1] == 0 or ref_cdf[-1] == 0:
        return src.astype(np.float64)
    src_cdf /= src_cdf[-1]
    ref_cdf /= ref_cdf[-1]

    # For each source level, find the ref level with the closest CDF value.
    mapping = np.interp(src_cdf, ref_cdf, np.arange(256))
    return mapping[src_int]


def transfer_to_palette(
    img: Image.Image,
    swatches: list[Any],
    strength: float = 0.7,
    method: str = "lab-transfer",
) -> Image.Image:
    """Push ``img``'s colors toward the target ``swatches`` palette.

    Args:
        img: source Pillow image.
        swatches: target palette as hex strings (``"#rrggbb"``) or ``{r,g,b}`` dicts.
        strength: 0..1 blend amount. 0 = identity, 1 = full effect.
        method: ``'lab-transfer'`` | ``'reinhard'`` | ``'histogram'``.

    Returns a new RGB Pillow image. Deterministic: same args → identical pixels.
    Empty/invalid swatches or ``strength <= 0`` → returns the source unchanged.
    """
    try:
        strength = float(strength)
    except (TypeError, ValueError):
        strength = 0.0
    strength = max(0.0, min(1.0, strength))

    target_rgb = _swatches_to_rgb_array(swatches)
    src_rgb = _to_rgb_array(img)

    if target_rgb.shape[0] == 0 or strength <= 0.0:
        return Image.fromarray(src_rgb, mode="RGB")

    flat = src_rgb.reshape(-1, 3).astype(np.float64)

    if method == "histogram":
        target_full = np.repeat(target_rgb, 256, axis=0)  # broad reference mass per swatch
        matched = np.empty_like(flat)
        for ch in range(3):
            matched[:, ch] = _histogram_match_channel(flat[:, ch], target_full[:, ch])
        out = flat + (matched - flat) * strength
        out_img = out.reshape(src_rgb.shape)
        return _array_to_image(out_img)

    # Lab-based methods
    src_lab = rgb_to_lab(flat)
    target_lab = rgb_to_lab(target_rgb)

    matched_lab = _reinhard_match(src_lab, target_lab)

    if method == "reinhard":
        result_lab = src_lab + (matched_lab - src_lab) * strength
    else:  # 'lab-transfer' (default) — reinhard + per-pixel nudge to nearest swatch
        result_lab = src_lab + (matched_lab - src_lab) * strength
        result_lab = _nudge_to_nearest(result_lab, target_lab, strength * 0.5)

    out_rgb = lab_to_rgb(result_lab).reshape(src_rgb.shape)
    return _array_to_image(out_rgb)
