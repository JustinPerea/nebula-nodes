"""Unit / golden tests for backend/cinema/look.py (film-look post stage).

Synthetic numpy fixtures only. We assert:
- determinism: identical (image, look) → byte-identical output;
- no-op identity: empty look / all-zero params / preset 'none' is identity;
- properties: vignette darkens corners vs centre; grain raises pixel variance;
  greyscale saturation collapses channels; presets resolve and run;
- robustness: a bad / missing .cube LUT is skipped with a warning, never crashes.
"""

from __future__ import annotations

import io

import numpy as np
import pytest
from PIL import Image

from cinema.look import PRESETS, apply_look
from cinema.lut import apply_cube_lut, load_cube_lut


# ---------- synthetic fixtures ----------


def _mid_grey_image(w: int = 64, h: int = 64) -> Image.Image:
    """Uniform mid-grey — ideal for isolating per-pass effects."""
    arr = np.full((h, w, 3), 128, dtype=np.uint8)
    return Image.fromarray(arr, mode="RGB")


def _textured_image(w: int = 64, h: int = 64, seed: int = 11) -> Image.Image:
    rng = np.random.default_rng(seed)
    yy, xx = np.mgrid[0:h, 0:w]
    base = ((xx + yy) / max(1, (w + h - 2)) * 200 + 28).astype(np.float64)
    arr = np.stack([base, base, base], axis=-1)
    arr += rng.integers(-8, 8, size=arr.shape)
    return Image.fromarray(np.clip(arr, 0, 255).astype(np.uint8), mode="RGB")


def _bright_center_image(w: int = 64, h: int = 64) -> Image.Image:
    """A bright field so vignette darkening is measurable at the corners."""
    arr = np.full((h, w, 3), 220, dtype=np.uint8)
    return Image.fromarray(arr, mode="RGB")


def _highlight_image(w: int = 64, h: int = 64) -> Image.Image:
    """Dark field with a bright central square → halation has something to bloom."""
    arr = np.full((h, w, 3), 20, dtype=np.uint8)
    cy0, cy1 = h // 2 - 6, h // 2 + 6
    cx0, cx1 = w // 2 - 6, w // 2 + 6
    arr[cy0:cy1, cx0:cx1] = 255
    return Image.fromarray(arr, mode="RGB")


def _raw_bytes(img: Image.Image) -> bytes:
    return np.asarray(img.convert("RGB"), dtype=np.uint8).tobytes()


def _png_bytes(img: Image.Image) -> bytes:
    buf = io.BytesIO()
    img.save(buf, format="PNG")
    return buf.getvalue()


def _arr(img: Image.Image) -> np.ndarray:
    return np.asarray(img.convert("RGB"), dtype=np.float64)


# ---------- determinism ----------


def test_apply_look_is_byte_identical() -> None:
    img = _textured_image()
    look = {
        "contrast": 0.2,
        "saturation": 0.1,
        "temperature": 0.15,
        "grain": 0.3,
        "halation": 0.2,
        "vignette": 0.25,
    }
    out1 = apply_look(img, look)
    out2 = apply_look(img, look)
    assert _raw_bytes(out1) == _raw_bytes(out2)
    assert _png_bytes(out1) == _png_bytes(out2)


def test_grain_seed_is_stable_across_calls() -> None:
    """Grain is the only stochastic pass; its seed must be derived deterministically."""
    img = _mid_grey_image()
    look = {"grain": 0.5}
    a = _raw_bytes(apply_look(img, look))
    b = _raw_bytes(apply_look(img, look))
    assert a == b


# ---------- no-op identity ----------


def test_empty_look_is_identity() -> None:
    img = _textured_image()
    assert _raw_bytes(apply_look(img, {})) == _raw_bytes(img)
    assert _raw_bytes(apply_look(img, None)) == _raw_bytes(img)


def test_all_zero_params_is_identity() -> None:
    img = _textured_image()
    look = {
        "contrast": 0.0,
        "saturation": 0.0,
        "temperature": 0.0,
        "grain": 0.0,
        "halation": 0.0,
        "vignette": 0.0,
        "teal_orange": 0.0,
    }
    assert _raw_bytes(apply_look(img, look)) == _raw_bytes(img)


def test_unknown_preset_with_no_sliders_is_identity() -> None:
    """preset='none' (unknown) with no explicit params resolves to all-zero → identity."""
    img = _textured_image()
    assert _raw_bytes(apply_look(img, {"preset": "none"})) == _raw_bytes(img)


# ---------- property: grain raises variance ----------


def test_grain_increases_variance() -> None:
    img = _mid_grey_image()
    base_var = float(_arr(img).var())
    out_var = float(_arr(apply_look(img, {"grain": 0.5})).var())
    assert out_var > base_var + 1.0


def test_more_grain_more_variance() -> None:
    img = _mid_grey_image()
    low = float(_arr(apply_look(img, {"grain": 0.2})).var())
    high = float(_arr(apply_look(img, {"grain": 0.8})).var())
    assert high > low


# ---------- property: vignette darkens corners vs centre ----------


def test_vignette_darkens_corners() -> None:
    img = _bright_center_image(64, 64)
    out = _arr(apply_look(img, {"vignette": 0.6}))
    h, w = out.shape[:2]
    center = out[h // 2 - 2 : h // 2 + 2, w // 2 - 2 : w // 2 + 2].mean()
    corner = out[0:4, 0:4].mean()
    assert corner < center, f"corner ({corner:.1f}) should be darker than center ({center:.1f})"


def test_vignette_zero_is_identity() -> None:
    img = _bright_center_image()
    assert _raw_bytes(apply_look(img, {"vignette": 0.0})) == _raw_bytes(img)


# ---------- property: saturation -1 → greyscale (channels equal) ----------


def test_full_desaturation_collapses_channels() -> None:
    rng = np.random.default_rng(5)
    arr = rng.integers(0, 256, size=(32, 32, 3)).astype(np.uint8)
    img = Image.fromarray(arr, mode="RGB")
    out = _arr(apply_look(img, {"saturation": -1.0}))
    # All three channels should be (near) equal per pixel.
    spread = np.max(out, axis=2) - np.min(out, axis=2)
    assert float(spread.max()) <= 1.0


# ---------- property: contrast increases dynamic range ----------


def test_contrast_increases_spread() -> None:
    img = _textured_image()
    base = _arr(img)
    out = _arr(apply_look(img, {"contrast": 0.6}))
    # Std around the mean grows under positive contrast.
    assert out.std() > base.std()


# ---------- property: halation brightens around highlights ----------


def test_halation_adds_glow_around_highlights() -> None:
    img = _highlight_image()
    base = _arr(img)
    out = _arr(apply_look(img, {"halation": 0.9}))
    # The dark ring immediately around the bright square should brighten.
    h, w = base.shape[:2]
    ring = (slice(h // 2 - 10, h // 2 - 7), slice(w // 2 - 2, w // 2 + 2))
    assert out[ring].mean() > base[ring].mean()


# ---------- presets resolve and run ----------


@pytest.mark.parametrize("preset", list(PRESETS.keys()))
def test_each_preset_runs_and_is_deterministic(preset: str) -> None:
    img = _textured_image()
    out1 = apply_look(img, {"preset": preset})
    out2 = apply_look(img, {"preset": preset})
    assert out1.size == img.size
    assert out1.mode == "RGB"
    assert _raw_bytes(out1) == _raw_bytes(out2)


def test_bw_preset_desaturates() -> None:
    """bw-tri-x has saturation -1 → output is near-monochrome.

    Desaturation collapses channels, but the preset's later passes (reddish
    halation, vignette) and per-channel rounding leave a small residual spread.
    We assert the image is *overwhelmingly* monochrome: the mean per-pixel
    channel spread is tiny even if a few highlight pixels pick up a faint tint."""
    rng = np.random.default_rng(9)
    arr = rng.integers(0, 256, size=(32, 32, 3)).astype(np.uint8)
    img = Image.fromarray(arr, mode="RGB")
    out = _arr(apply_look(img, {"preset": "bw-tri-x"}))
    spread = np.max(out, axis=2) - np.min(out, axis=2)
    assert float(spread.mean()) <= 1.0
    assert float(spread.max()) <= 8.0


def test_explicit_param_overrides_preset() -> None:
    """An explicit slider value overrides the preset's value for that key."""
    img = _textured_image()
    from_preset = apply_look(img, {"preset": "kodak-portra"})
    overridden = apply_look(img, {"preset": "kodak-portra", "vignette": 0.95})
    assert _raw_bytes(from_preset) != _raw_bytes(overridden)


# ---------- LUT robustness ----------


def test_missing_lut_is_skipped_with_warning() -> None:
    img = _textured_image()
    look = {"lut": "/nonexistent/path/does-not-exist.cube"}
    with pytest.warns(UserWarning):
        out = apply_look(img, look)
    # With no other params, a skipped LUT leaves the image unchanged.
    assert _raw_bytes(out) == _raw_bytes(img)


def test_malformed_lut_is_skipped_with_warning(tmp_path) -> None:
    bad = tmp_path / "bad.cube"
    bad.write_text("this is not a valid cube file\nLUT_3D_SIZE 2\n1 2 3\n")
    img = _textured_image()
    with pytest.warns(UserWarning):
        out = apply_look(img, {"lut": str(bad)})
    assert _raw_bytes(out) == _raw_bytes(img)


def test_valid_identity_lut_round_trips(tmp_path) -> None:
    """A correctly-formed identity .cube should parse and apply as ~no-op."""
    size = 2
    lines = ["LUT_3D_SIZE 2"]
    # red varies fastest; entries are the normalized grid coordinates.
    for b in range(size):
        for g in range(size):
            for r in range(size):
                lines.append(f"{r/(size-1)} {g/(size-1)} {b/(size-1)}")
    cube = tmp_path / "identity.cube"
    cube.write_text("\n".join(lines))

    lut = load_cube_lut(str(cube))
    assert lut is not None

    rng = np.random.default_rng(2)
    rgb = rng.integers(0, 256, size=(16, 16, 3)).astype(np.float64)
    out = apply_cube_lut(rgb, lut)
    assert np.max(np.abs(out - rgb)) < 1.0


def test_one_d_lut_is_rejected(tmp_path) -> None:
    cube = tmp_path / "oned.cube"
    cube.write_text("LUT_1D_SIZE 2\n0 0 0\n1 1 1\n")
    assert load_cube_lut(str(cube)) is None


# ---------- handler _build_look: named presets must not be clobbered ----------
#
# Regression: the cinema-look node always carries its slider params (the catalog
# defines defaults: grain 0.2 / halation 0.2 / vignette 0.25 / contrast 0 /
# saturation 0 / temperature 0), and the frontend sends them even when they are
# hidden (visibleWhen preset==='custom'). _resolve_params lets explicit floats
# override the preset, so forwarding those neutral defaults flattened a selected
# named preset down to "grain+vignette only, no colour grade" — the bug that made
# a kodak-portra look like an untouched (slightly darker) copy.


def test_build_look_named_preset_drops_neutral_sliders() -> None:
    from handlers.cinema_look import _build_look

    params = {
        "preset": "kodak-portra",
        "grain": 0.2, "halation": 0.2, "vignette": 0.25,
        "contrast": 0, "saturation": 0, "temperature": 0, "lut": "",
    }
    look = _build_look(params)
    assert look.get("preset") == "kodak-portra"
    for k in ("grain", "halation", "vignette", "contrast", "saturation", "temperature"):
        assert k not in look, f"named preset must not forward slider {k!r}"


def test_build_look_named_preset_survives_to_full_grade() -> None:
    """The node's default sliders must NOT change a named preset's output."""
    img = _textured_image()
    params = {
        "preset": "kodak-portra",
        "grain": 0.2, "halation": 0.2, "vignette": 0.25,
        "contrast": 0, "saturation": 0, "temperature": 0,
    }
    from handlers.cinema_look import _build_look

    via_node = apply_look(img, _build_look(params))
    preset_only = apply_look(img, {"preset": "kodak-portra"})
    assert _raw_bytes(via_node) == _raw_bytes(preset_only)


def test_build_look_custom_forwards_sliders() -> None:
    from handlers.cinema_look import _build_look

    look = _build_look({"preset": "custom", "grain": 0.3, "contrast": 0.2})
    assert look.get("preset") == "custom"
    assert look["grain"] == 0.3
    assert look["contrast"] == 0.2


def test_build_look_no_preset_forwards_sliders() -> None:
    from handlers.cinema_look import _build_look

    look = _build_look({"grain": 0.4})
    assert look["grain"] == 0.4


def test_build_look_lut_honoured_with_named_preset(tmp_path) -> None:
    """A LUT applies on top of any preset, so it is always forwarded."""
    from handlers.cinema_look import _build_look

    cube = tmp_path / "x.cube"
    cube.write_text("LUT_3D_SIZE 2\n0 0 0\n1 1 1\n0 0 0\n1 1 1\n0 0 0\n1 1 1\n0 0 0\n1 1 1\n")
    look = _build_look({"preset": "kodak-portra", "lut": str(cube)})
    assert look.get("preset") == "kodak-portra"
    assert look.get("lutId") == str(cube)
