"""Film-look post stage — deterministic, local, composable passes.

``apply_look(img, look_dict)`` runs a fixed-order chain, each pass gated by its
param so ``0`` (or absent) is a no-op:

1. tone / contrast, saturation, temperature (warm/cool white-balance shift)
2. teal-orange channel split (preset ``teal-orange`` or explicit ``teal_orange`` mix)
3. film grain — gaussian noise, luminance-masked (more in mids), blended
4. halation — threshold highlights → gaussian blur → reddish screen blend
5. vignette — radial luminance falloff
6. LUT — optional ``.cube`` via trilinear interp (bad/missing → skip + warn)

Determinism: the grain seed is derived from a stable hash of the look params +
image dimensions, so the same (image-size, params) always yields the same noise
field. No wall-clock, no unseeded RNG.

``PRESETS`` are named param bundles. ``custom`` (or an unknown preset) means
"use the raw slider values as given".
"""

from __future__ import annotations

import hashlib
import warnings
from typing import Any

import numpy as np
from PIL import Image, ImageFilter

from cinema.lut import apply_cube_lut, load_cube_lut


# ---------------------------------------------------------------------------
# Presets — named bundles of look params. `custom` uses the raw sliders.
# ---------------------------------------------------------------------------

PRESETS: dict[str, dict[str, Any]] = {
    "kodak-portra": {
        "contrast": 0.12,
        "saturation": 0.08,
        "temperature": 0.18,
        "grain": 0.10,
        "halation": 0.18,
        "vignette": 0.22,
        "teal_orange": 0.0,
    },
    "fuji-400h": {
        "contrast": 0.06,
        "saturation": 0.14,
        "temperature": -0.10,
        "grain": 0.08,
        "halation": 0.10,
        "vignette": 0.16,
        "teal_orange": 0.12,
    },
    "cinestill-800t": {
        "contrast": 0.10,
        "saturation": 0.05,
        "temperature": -0.22,
        "grain": 0.14,
        "halation": 0.45,
        "vignette": 0.26,
        "teal_orange": 0.0,
    },
    "bw-tri-x": {
        "contrast": 0.22,
        "saturation": -1.0,
        "temperature": 0.0,
        "grain": 0.22,
        "halation": 0.06,
        "vignette": 0.30,
        "teal_orange": 0.0,
    },
    "teal-orange": {
        "contrast": 0.14,
        "saturation": 0.10,
        "temperature": 0.05,
        "grain": 0.05,
        "halation": 0.12,
        "vignette": 0.20,
        "teal_orange": 0.55,
    },
}

_FLOAT_KEYS = (
    "contrast",
    "saturation",
    "temperature",
    "grain",
    "halation",
    "vignette",
    "teal_orange",
)


# ---------------------------------------------------------------------------
# Helpers
# ---------------------------------------------------------------------------


def _to_float_array(img: Image.Image) -> np.ndarray:
    """Pillow image → (H, W, 3) float64 RGB in 0..255 (alpha dropped)."""
    if img.mode != "RGB":
        img = img.convert("RGB")
    return np.asarray(img, dtype=np.float64)


def _array_to_image(arr: np.ndarray) -> Image.Image:
    return Image.fromarray(np.clip(np.rint(arr), 0, 255).astype(np.uint8), mode="RGB")


def _luminance(rgb: np.ndarray) -> np.ndarray:
    """Rec.709 luma of an (H, W, 3) array → (H, W) in the same 0..255 scale."""
    return 0.2126 * rgb[..., 0] + 0.7152 * rgb[..., 1] + 0.0722 * rgb[..., 2]


def _resolve_params(look: dict[str, Any]) -> dict[str, Any]:
    """Merge a preset bundle with explicit overrides.

    If ``preset`` names a known preset, start from it; explicit float keys in
    ``look`` override the preset value. ``custom`` / unknown preset → raw sliders.
    """
    preset_name = look.get("preset")
    base: dict[str, Any] = {}
    if isinstance(preset_name, str) and preset_name in PRESETS:
        base = dict(PRESETS[preset_name])

    resolved: dict[str, Any] = {}
    for key in _FLOAT_KEYS:
        if key in look and look[key] is not None:
            try:
                resolved[key] = float(look[key])
            except (TypeError, ValueError):
                resolved[key] = base.get(key, 0.0)
        else:
            resolved[key] = base.get(key, 0.0)
    resolved["lutId"] = look.get("lutId") or look.get("lut")
    return resolved


def _stable_seed(params: dict[str, Any], shape: tuple[int, int]) -> int:
    """Derive a deterministic 32-bit seed from look params + image dimensions."""
    h, w = shape
    key_parts = [f"{w}x{h}"]
    for k in _FLOAT_KEYS:
        key_parts.append(f"{k}={params.get(k, 0.0):.6f}")
    digest = hashlib.sha256("|".join(key_parts).encode("utf-8")).hexdigest()
    return int(digest[:8], 16)


# ---------------------------------------------------------------------------
# Passes
# ---------------------------------------------------------------------------


def _apply_contrast(rgb: np.ndarray, amount: float) -> np.ndarray:
    """S-curve contrast around mid-grey (128). ``amount`` in roughly -1..1."""
    if amount == 0.0:
        return rgb
    factor = 1.0 + amount
    return (rgb - 128.0) * factor + 128.0


def _apply_saturation(rgb: np.ndarray, amount: float) -> np.ndarray:
    """Blend toward (amount<0) or away from (amount>0) luma. ``-1`` = greyscale."""
    if amount == 0.0:
        return rgb
    lum = _luminance(rgb)[..., None]
    factor = 1.0 + amount
    return lum + (rgb - lum) * factor


def _apply_temperature(rgb: np.ndarray, amount: float) -> np.ndarray:
    """Warm (>0, boost R / cut B) or cool (<0) white-balance shift."""
    if amount == 0.0:
        return rgb
    out = rgb.copy()
    shift = amount * 30.0
    out[..., 0] += shift
    out[..., 2] -= shift
    return out


def _apply_teal_orange(rgb: np.ndarray, amount: float) -> np.ndarray:
    """Push shadows toward teal and highlights toward orange by ``amount``."""
    if amount <= 0.0:
        return rgb
    lum = _luminance(rgb) / 255.0  # 0..1
    # Highlight mask (toward orange) vs shadow mask (toward teal).
    hi = lum[..., None]
    sh = (1.0 - lum)[..., None]
    out = rgb.copy()
    k = amount * 24.0
    # Orange = +R, +G(slight), -B in highlights
    out[..., 0] += k * hi[..., 0]
    out[..., 2] -= k * hi[..., 0]
    # Teal = -R, +B in shadows
    out[..., 0] -= k * sh[..., 0]
    out[..., 2] += k * sh[..., 0]
    return out


def _apply_grain(rgb: np.ndarray, amount: float, seed: int) -> np.ndarray:
    """Luminance-masked gaussian grain. Seed makes the noise field deterministic."""
    if amount <= 0.0:
        return rgb
    rng = np.random.default_rng(seed)
    h, w = rgb.shape[:2]
    noise = rng.standard_normal((h, w))  # monochrome grain across channels
    # Mask: strongest in mids, tapering at black/white. parabola peaking at 0.5.
    lum = _luminance(rgb) / 255.0
    mask = 1.0 - (2.0 * lum - 1.0) ** 2  # 0 at extremes, 1 at mid
    strength = amount * 40.0
    grain = (noise * mask * strength)[..., None]
    return rgb + grain


def _apply_halation(rgb: np.ndarray, amount: float) -> np.ndarray:
    """Threshold highlights → gaussian blur → reddish screen blend."""
    if amount <= 0.0:
        return rgb
    lum = _luminance(rgb)
    threshold = 200.0
    highlights = np.clip((lum - threshold) / (255.0 - threshold), 0.0, 1.0)

    # Reddish glow source: weighted toward red/orange.
    glow_img = _array_to_image(
        np.stack(
            [highlights * 255.0, highlights * 120.0, highlights * 60.0], axis=-1
        )
    )
    radius = max(1.0, 0.012 * max(rgb.shape[0], rgb.shape[1]))
    blurred = np.asarray(
        glow_img.filter(ImageFilter.GaussianBlur(radius=radius)), dtype=np.float64
    )

    # Screen blend: 1 - (1-a)(1-b), scaled by amount.
    base = rgb / 255.0
    glow = (blurred / 255.0) * amount
    screened = 1.0 - (1.0 - base) * (1.0 - glow)
    return screened * 255.0


def _apply_vignette(rgb: np.ndarray, amount: float) -> np.ndarray:
    """Radial luminance falloff — corners darker than centre by ``amount``."""
    if amount <= 0.0:
        return rgb
    h, w = rgb.shape[:2]
    yy, xx = np.mgrid[0:h, 0:w].astype(np.float64)
    cy, cx = (h - 1) / 2.0, (w - 1) / 2.0
    # Normalised radius: 0 at centre, ~1 at corners.
    dist = np.sqrt(((xx - cx) / (w / 2.0)) ** 2 + ((yy - cy) / (h / 2.0)) ** 2)
    dist = dist / np.sqrt(2.0)
    falloff = 1.0 - amount * (dist ** 2)
    falloff = np.clip(falloff, 0.0, 1.0)[..., None]
    return rgb * falloff


# ---------------------------------------------------------------------------
# Public entry point
# ---------------------------------------------------------------------------


def apply_look(img: Image.Image, look: dict[str, Any] | None) -> Image.Image:
    """Apply the film-look chain to ``img``. Returns a new RGB Pillow image.

    A ``None`` / empty look, or a look whose every param is ``0`` (e.g.
    ``preset='none'``), is an identity transform (byte-identical output).
    Deterministic for a given (image, look). Never raises on a bad LUT — it
    skips that stage and emits a warning.
    """
    if not look:
        return img.convert("RGB") if img.mode != "RGB" else img.copy()

    params = _resolve_params(look)
    rgb = _to_float_array(img)
    seed = _stable_seed(params, rgb.shape[:2])

    # 1. tone / contrast, saturation, temperature
    rgb = _apply_contrast(rgb, params["contrast"])
    rgb = _apply_saturation(rgb, params["saturation"])
    rgb = _apply_temperature(rgb, params["temperature"])

    # 2. teal-orange split
    rgb = _apply_teal_orange(rgb, params["teal_orange"])

    # 3. film grain (luminance-masked)
    rgb = _apply_grain(rgb, params["grain"], seed)

    # 4. halation
    rgb = _apply_halation(rgb, params["halation"])

    # 5. vignette
    rgb = _apply_vignette(rgb, params["vignette"])

    # 6. optional LUT
    lut_id = params.get("lutId")
    if lut_id:
        lut = load_cube_lut(lut_id)
        if lut is None:
            warnings.warn(
                f"cinema.look: could not load LUT '{lut_id}', skipping LUT stage",
                stacklevel=2,
            )
        else:
            clipped = np.clip(np.rint(rgb), 0, 255).astype(np.float64)
            rgb = apply_cube_lut(clipped, lut)

    return _array_to_image(rgb)
