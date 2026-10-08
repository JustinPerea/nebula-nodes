"""Shot grade ownership through the real local Cinema post-processing stack.

The base-model registry is replaced with a deterministic local image handler.
No provider request or credential lookup is permitted by these tests.
"""

from __future__ import annotations

import copy
from pathlib import Path
from typing import Any

import numpy as np
import pytest
from PIL import Image

import execution.sync_runner as sync_runner
import handlers.cinema_scene as cinema_scene
from cinema.color import transfer_to_palette
from cinema.look import PRESETS, apply_look
from models.graph import GraphNode


@pytest.mark.parametrize("preset", PRESETS)
def test_named_shot_preset_owns_grade_without_shared_scalars_or_lut(preset: str) -> None:
    shared = {"preset": "custom", "contrast": 0.91, "saturation": -0.5,
              "temperature": 0.8, "grain": 0.0, "halation": 0.7,
              "vignette": 0.0, "teal_orange": 0.92, "lutId": "shared.cube", "lut": "legacy.cube"}
    override = {"preset": preset}
    before = copy.deepcopy((shared, override))
    assert cinema_scene._merge_look(shared, override) == {"preset": preset}
    assert (shared, override) == before


def test_named_shot_preset_keeps_explicit_zero_scalar_and_lut_values() -> None:
    override = {"preset": "kodak-portra", "grain": 0.0, "temperature": -0.4,
                "lutId": "shot.cube", "vignette": None}
    assert cinema_scene._merge_look({"contrast": 0.9, "lutId": "shared.cube"}, override) == {
        "preset": "kodak-portra", "grain": 0.0, "temperature": -0.4, "lutId": "shot.cube",
    }


@pytest.mark.parametrize("override", [None, {}, {"preset": None}, {"preset": "custom"}, {"preset": "unknown"}])
def test_partial_or_custom_shot_look_retains_shared_values(override: dict[str, Any] | None) -> None:
    shared = {"preset": "fuji-400h", "grain": 0.2, "lutId": "shared.cube"}
    expected = {**shared, **{key: value for key, value in (override or {}).items() if value is not None}}
    assert cinema_scene._merge_look(shared, override) == expected


def test_partial_shot_slider_overrides_only_that_field_and_reset_restores_scene() -> None:
    shared = {"preset": "custom", "grain": 0.3, "contrast": 0.7, "lutId": "shared.cube"}
    assert cinema_scene._merge_look(shared, {"grain": 0.0}) == {**shared, "grain": 0.0}
    assert cinema_scene._merge_look(shared, None) == shared
    assert cinema_scene._merge_look(None, None) is None


@pytest.fixture
def local_cinema(monkeypatch, tmp_path: Path):
    """Keep real image load/color/look/save, replacing only paid base dispatch."""
    output_root = tmp_path / "outputs"
    output_root.mkdir()
    y, x = np.mgrid[:24, :32]
    pixels = np.stack((50 + x * 5, 70 + y * 6, 200 - x * 3), axis=-1).astype(np.uint8)
    image = Image.fromarray(pixels, mode="RGB")
    image.save(output_root / "base.png")
    monkeypatch.setattr(cinema_scene, "OUTPUT_ROOT", output_root)
    monkeypatch.setattr(cinema_scene, "get_run_dir", lambda: output_root)
    calls = []

    async def local_base(node, inputs, api_keys):
        assert api_keys == {}
        calls.append((node, inputs))
        return {"image": {"type": "Image", "value": "/api/outputs/base.png"}}

    def registry(*, emit=None):
        return {"nano-banana": local_base}

    monkeypatch.setattr(sync_runner, "get_handler_registry", registry)
    return output_root, image, calls


def pixels_for(output_root: Path, result: dict[str, Any], shot_id: str) -> np.ndarray:
    url = result[f"shot_{shot_id}"]["value"]
    assert url and url.startswith("/api/outputs/")
    return np.asarray(Image.open(output_root / url.removeprefix("/api/outputs/")).convert("RGB"))


@pytest.mark.asyncio
async def test_handler_applies_named_shot_grade_after_effective_palette_and_preserves_authoring(local_cinema) -> None:
    output_root, base_image, calls = local_cinema
    palette = {"swatches": ["#aa6633", "#ddbb77"], "strength": 0.65, "method": "reinhard"}
    override_palette = {"swatches": ["#336688", "#66bbcc"], "strength": 0.0}
    shared_look = {"preset": "custom", "contrast": 0.7, "saturation": 0.4,
                   "temperature": 0.8, "grain": 0.0, "vignette": 0.8, "lutId": "unused-scene.cube"}
    shot_override = {"palette": override_palette, "look": {"preset": "bw-tri-x", "grain": 0.0}}
    scene = {"version": 1, "base": {"model": "nano-banana"}, "aspectRatio": "16:9",
             "palette": palette, "look": shared_look, "shots": [{"id": "s", "prompt": "Local fixture",
             "overrides": shot_override, "variations": [{"url": "/previous.png", "seed": 2}],
             "selectedVariation": 0, "output": {"status": "done", "imageUrl": "/previous.png"}}]}
    original_authoring = copy.deepcopy(scene)
    node = GraphNode(id="scene", definitionId="cinema-scene", params={"scene": scene})
    result = await cinema_scene.handle_cinema_scene(node, {}, {}, emit=None)
    effective_palette = {**palette, **override_palette}
    expected = apply_look(transfer_to_palette(base_image, effective_palette["swatches"],
        strength=effective_palette["strength"], method=effective_palette["method"]),
        {"preset": "bw-tri-x", "grain": 0.0})
    np.testing.assert_array_equal(pixels_for(output_root, result, "s"), np.asarray(expected))
    assert len(calls) == 1
    assert node.params["scene"]["shots"][0]["output"]["status"] == "done"
    assert node.params["scene"]["look"] == original_authoring["look"]
    assert node.params["scene"]["palette"] == original_authoring["palette"]
    assert node.params["scene"]["shots"][0]["overrides"] == original_authoring["shots"][0]["overrides"]
    assert node.params["scene"]["shots"][0]["variations"] == original_authoring["shots"][0]["variations"]


@pytest.mark.asyncio
async def test_handler_shared_changes_flow_to_partial_override_until_reset(local_cinema) -> None:
    output_root, base_image, calls = local_cinema
    palette = {"swatches": ["#334477", "#aaccee"], "strength": 0.4, "method": "reinhard"}
    shared_look = {"preset": "custom", "grain": 0.0, "contrast": 0.2, "temperature": 0.1}
    scene = {"version": 1, "base": {"model": "nano-banana"}, "aspectRatio": "16:9",
             "palette": palette, "look": shared_look, "shots": [{"id": "s", "prompt": "Local fixture",
             "overrides": {"look": {"temperature": -0.6}, "palette": {"strength": 0.0}}}]}
    node = GraphNode(id="scene", definitionId="cinema-scene", params={"scene": scene})
    first = await cinema_scene.handle_cinema_scene(node, {}, {}, emit=None)
    first_pixels = pixels_for(output_root, first, "s")
    first_hash = node.params["scene"]["shots"][0]["output"]["hash"]
    np.testing.assert_array_equal(first_pixels, np.asarray(apply_look(base_image,
        {**shared_look, "temperature": -0.6})))

    # Shared contrast changes while shot temperature + palette strength stay owned.
    node.params["scene"]["look"]["contrast"] = 0.8
    node.params["scene"]["palette"]["strength"] = 0.95
    second = await cinema_scene.handle_cinema_scene(node, {}, {}, emit=None)
    second_pixels = pixels_for(output_root, second, "s")
    np.testing.assert_array_equal(second_pixels, np.asarray(apply_look(base_image,
        {**node.params["scene"]["look"], "temperature": -0.6})))
    assert not np.array_equal(first_pixels, second_pixels)
    assert node.params["scene"]["shots"][0]["output"]["hash"] != first_hash

    # Reset is removal of the authoring overrides, so current scene settings apply.
    node.params["scene"]["shots"][0].pop("overrides")
    reset = await cinema_scene.handle_cinema_scene(node, {}, {}, emit=None)
    expected_reset = apply_look(transfer_to_palette(base_image,
        node.params["scene"]["palette"]["swatches"], strength=0.95, method="reinhard"),
        node.params["scene"]["look"])
    np.testing.assert_array_equal(pixels_for(output_root, reset, "s"), np.asarray(expected_reset))
    assert len(calls) == 3
    assert all(base_node.definition_id == "nano-banana" for base_node, _ in calls)
