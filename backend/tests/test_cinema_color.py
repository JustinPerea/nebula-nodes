"""Unit / golden tests for backend/cinema/color.py (Soul HEX).

All fixtures are synthetic numpy arrays — no external image files. We assert:
- determinism: identical inputs → byte-identical output PNG bytes;
- properties: palette transfer shifts the image's color statistics toward the
  target swatches; a no-op (empty palette / zero strength) is identity;
  extract_palette returns the requested count and is stable across calls.
"""

from __future__ import annotations

import io

import numpy as np
import pytest
from PIL import Image

from cinema.color import (
    _parse_recraft_color,
    extract_palette,
    lab_to_rgb,
    parse_hex_color,
    rgb_to_lab,
    transfer_to_palette,
)


# ---------- synthetic fixtures ----------


def _gradient_image(w: int = 48, h: int = 48, seed: int = 7) -> Image.Image:
    """A deterministic multi-color synthetic image: a smooth RGB gradient plus
    a seeded speckle so it has non-trivial color statistics."""
    rng = np.random.default_rng(seed)
    yy, xx = np.mgrid[0:h, 0:w]
    r = (xx / max(1, w - 1) * 255).astype(np.float64)
    g = (yy / max(1, h - 1) * 255).astype(np.float64)
    b = ((xx + yy) / max(1, (w + h - 2)) * 255).astype(np.float64)
    arr = np.stack([r, g, b], axis=-1)
    arr += rng.integers(-12, 12, size=arr.shape)
    arr = np.clip(arr, 0, 255).astype(np.uint8)
    return Image.fromarray(arr, mode="RGB")


def _solid_image(rgb: tuple[int, int, int], w: int = 32, h: int = 32) -> Image.Image:
    arr = np.zeros((h, w, 3), dtype=np.uint8)
    arr[:, :] = rgb
    return Image.fromarray(arr, mode="RGB")


def _png_bytes(img: Image.Image) -> bytes:
    buf = io.BytesIO()
    img.save(buf, format="PNG")
    return buf.getvalue()


def _raw_bytes(img: Image.Image) -> bytes:
    return np.asarray(img.convert("RGB"), dtype=np.uint8).tobytes()


# ---------- hex parser (shared single source of truth) ----------


def test_parse_recraft_color_hex_and_dict() -> None:
    assert _parse_recraft_color("#FF0000") == {"r": 255, "g": 0, "b": 0}
    assert _parse_recraft_color("00ff00") == {"r": 0, "g": 255, "b": 0}
    assert _parse_recraft_color({"r": 1, "g": 2, "b": 3}) == {"r": 1, "g": 2, "b": 3}
    assert _parse_recraft_color("nope") is None
    assert _parse_recraft_color("#FFF") is None


def test_parse_hex_color_tuple() -> None:
    assert parse_hex_color("#0000FF") == (0, 0, 255)
    assert parse_hex_color("bad") is None


def test_sync_runner_reexports_same_parser() -> None:
    """The historical import path must keep resolving to this implementation."""
    from execution.sync_runner import _parse_recraft_color as reexported

    assert reexported is _parse_recraft_color


# ---------- Lab round-trip sanity ----------


def test_lab_roundtrip_is_near_identity() -> None:
    rng = np.random.default_rng(3)
    rgb = rng.integers(0, 256, size=(200, 3)).astype(np.float64)
    back = lab_to_rgb(rgb_to_lab(rgb))
    assert np.max(np.abs(back - rgb)) < 1.0


# ---------- extract_palette ----------


def test_extract_palette_count_and_format() -> None:
    img = _gradient_image()
    palette = extract_palette(img, k=6)
    assert len(palette) == 6
    for hexcode in palette:
        assert hexcode.startswith("#") and len(hexcode) == 7
        assert parse_hex_color(hexcode) is not None


def test_extract_palette_is_deterministic() -> None:
    img = _gradient_image()
    assert extract_palette(img, k=5) == extract_palette(img, k=5)


def test_extract_palette_solid_image() -> None:
    img = _solid_image((120, 60, 200))
    palette = extract_palette(img, k=4)
    # A solid image collapses to (near) one color; the dominant swatch should be
    # close to the input color.
    r, g, b = parse_hex_color(palette[0])  # type: ignore[misc]
    assert abs(r - 120) <= 4 and abs(g - 60) <= 4 and abs(b - 200) <= 4


# ---------- transfer_to_palette: determinism ----------


@pytest.mark.parametrize("method", ["lab-transfer", "reinhard", "histogram"])
def test_transfer_is_byte_identical(method: str) -> None:
    img = _gradient_image()
    swatches = ["#1b3a4b", "#d98841", "#e8d8c3"]
    out1 = transfer_to_palette(img, swatches, strength=0.7, method=method)
    out2 = transfer_to_palette(img, swatches, strength=0.7, method=method)
    assert _png_bytes(out1) == _png_bytes(out2)
    assert _raw_bytes(out1) == _raw_bytes(out2)


# ---------- transfer_to_palette: no-op identity ----------


def test_transfer_empty_palette_is_identity() -> None:
    img = _gradient_image()
    out = transfer_to_palette(img, [], strength=0.7, method="lab-transfer")
    assert _raw_bytes(out) == _raw_bytes(img)


def test_transfer_zero_strength_is_identity() -> None:
    img = _gradient_image()
    out = transfer_to_palette(img, ["#1b3a4b", "#d98841"], strength=0.0)
    assert _raw_bytes(out) == _raw_bytes(img)


def test_transfer_invalid_swatches_is_identity() -> None:
    img = _gradient_image()
    out = transfer_to_palette(img, ["not-a-color", "#FFF"], strength=0.9)
    assert _raw_bytes(out) == _raw_bytes(img)


# ---------- transfer_to_palette: property — shifts toward target ----------


def _mean_rgb(img: Image.Image) -> np.ndarray:
    return np.asarray(img.convert("RGB"), dtype=np.float64).reshape(-1, 3).mean(axis=0)


@pytest.mark.parametrize("method", ["lab-transfer", "reinhard", "histogram"])
def test_transfer_shifts_mean_toward_palette(method: str) -> None:
    """A neutral-ish source pushed toward a strongly warm palette should move its
    mean color closer to the palette's mean than it started."""
    img = _gradient_image()
    # Strongly warm/orange palette.
    swatches = ["#d98841", "#e8a85c", "#c46a28"]
    target_mean = np.asarray(
        [parse_hex_color(s) for s in swatches], dtype=np.float64
    ).mean(axis=0)

    before = _mean_rgb(img)
    out = transfer_to_palette(img, swatches, strength=0.9, method=method)
    after = _mean_rgb(out)

    dist_before = np.linalg.norm(before - target_mean)
    dist_after = np.linalg.norm(after - target_mean)
    assert dist_after < dist_before, (
        f"{method}: expected mean to move toward palette "
        f"(before={dist_before:.1f}, after={dist_after:.1f})"
    )


def test_transfer_strength_monotonic() -> None:
    """Higher strength should move the image further toward the palette."""
    img = _gradient_image()
    swatches = ["#d98841", "#c46a28"]
    target_mean = np.asarray(
        [parse_hex_color(s) for s in swatches], dtype=np.float64
    ).mean(axis=0)

    low = _mean_rgb(transfer_to_palette(img, swatches, strength=0.3, method="reinhard"))
    high = _mean_rgb(transfer_to_palette(img, swatches, strength=0.9, method="reinhard"))

    assert np.linalg.norm(high - target_mean) < np.linalg.norm(low - target_mean)


def test_transfer_returns_rgb_same_size() -> None:
    img = _gradient_image(w=40, h=24)
    out = transfer_to_palette(img, ["#1b3a4b"], strength=0.5)
    assert out.mode == "RGB"
    assert out.size == img.size


# ---------- handler guard: empty palette is not a silent no-op ----------


def _write_input_image() -> str:
    from uuid import uuid4

    from services.output import OUTPUT_ROOT

    run_dir = OUTPUT_ROOT / "cinema-color-test"
    run_dir.mkdir(parents=True, exist_ok=True)
    p = run_dir / f"{uuid4().hex[:12]}.png"
    _gradient_image(40, 24).save(p, format="PNG")
    rel = p.resolve().relative_to(OUTPUT_ROOT.resolve())
    return f"/api/outputs/{rel}"


@pytest.mark.asyncio
async def test_handler_empty_palette_raises() -> None:
    from handlers.cinema_color import handle_cinema_color
    from models.graph import GraphNode, PortValueDict

    node = GraphNode(id="c1", definitionId="cinema-color", params={})
    inputs = {"image": PortValueDict(type="Image", value=_write_input_image())}
    with pytest.raises(ValueError, match="target palette"):
        await handle_cinema_color(node, inputs, api_keys={}, emit=None)


@pytest.mark.asyncio
async def test_handler_with_palette_returns_image() -> None:
    from handlers.cinema_color import handle_cinema_color
    from models.graph import GraphNode, PortValueDict

    node = GraphNode(
        id="c1", definitionId="cinema-color", params={"palette": ["#1b3a4b", "#d98841"]}
    )
    inputs = {"image": PortValueDict(type="Image", value=_write_input_image())}
    out = await handle_cinema_color(node, inputs, api_keys={}, emit=None)
    assert out["image"]["type"] == "Image"
    assert str(out["image"]["value"]).startswith("/api/outputs/")
