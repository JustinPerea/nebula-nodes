"""Handler smoke tests for backend/handlers/cinema_scene.py.

The base-model call is MOCKED — no network, no real generation. We assert:
- each shot's image maps to that shot's dynamic output port (id derived from
  shot.id);
- a shot whose base call raises is isolated: it gets status 'error' while the
  other shots still complete (scene completes partially);
- the License guard substitutes the commercial-OK default base for FLUX.1-dev;
- color + look stages run on the base output (real deterministic pillars).
"""

from __future__ import annotations

from pathlib import Path
from typing import Any
from uuid import uuid4

import numpy as np
import pytest
from PIL import Image

import handlers.cinema_scene as cinema_scene
from handlers.cinema_scene import (
    _guard_base_model,
    _output_port_id,
    handle_cinema_scene,
)
from models.graph import GraphNode, PortValueDict
from services.output import OUTPUT_ROOT


# ---------- helpers ----------


def _write_base_image(rgb: tuple[int, int, int] = (90, 120, 200)) -> str:
    """Write a small solid image under OUTPUT_ROOT and return its served URL —
    standing in for a base model's generated output."""
    run_dir = OUTPUT_ROOT / "cinema-scene-test"
    run_dir.mkdir(parents=True, exist_ok=True)
    arr = np.zeros((24, 24, 3), dtype=np.uint8)
    arr[:, :] = rgb
    out_path = run_dir / f"{uuid4().hex[:12]}.png"
    Image.fromarray(arr, mode="RGB").save(out_path, format="PNG")
    rel = out_path.resolve().relative_to(OUTPUT_ROOT.resolve())
    return f"/api/outputs/{rel}"


def _scene_node(scene: dict[str, Any]) -> GraphNode:
    return GraphNode(id="scene1", definitionId="cinema-scene", params={"scene": scene})


def _patch_base(monkeypatch, behavior) -> list[dict[str, Any]]:
    """Patch get_handler_registry so the base model handler is `behavior`.

    Returns a list that records each base-handler invocation's (node, inputs)
    for assertions. `behavior(node, inputs, api_keys)` is the async stand-in.
    """
    calls: list[dict[str, Any]] = []

    async def fake_base_handler(node, inputs, api_keys):
        calls.append({"node": node, "inputs": inputs})
        return await behavior(node, inputs, api_keys)

    def fake_registry(emit=None):
        # Every base model id resolves to our stand-in.
        class _AnyKeyRegistry(dict):
            def get(self, _key, _default=None):
                return fake_base_handler

        return _AnyKeyRegistry()

    monkeypatch.setattr(cinema_scene, "get_handler_registry", fake_registry, raising=False)
    # handle_cinema_scene does `from execution.sync_runner import get_handler_registry`
    # at call time, so patch the source module too.
    import execution.sync_runner as sync_runner
    monkeypatch.setattr(sync_runner, "get_handler_registry", fake_registry)
    return calls


# ---------- pure helpers ----------


def test_output_port_id_derives_from_shot_id() -> None:
    assert _output_port_id("abc") == "shot_abc"


def test_license_guard_substitutes_flux_dev() -> None:
    assert _guard_base_model({"model": "flux-1-dev"}) == "seedream-4-5"
    assert _guard_base_model({"model": "FLUX.1-dev"}) == "seedream-4-5"
    assert _guard_base_model({}) == "seedream-4-5"
    # A commercial-OK model is left alone.
    assert _guard_base_model({"model": "nano-banana"}) == "nano-banana"


# ---------- per-shot port mapping ----------


@pytest.mark.asyncio
async def test_shots_map_to_dynamic_output_ports(monkeypatch) -> None:
    async def ok(node, inputs, api_keys):
        return {"image": {"type": "Image", "value": _write_base_image()}}

    _patch_base(monkeypatch, ok)

    scene = {
        "version": 1,
        "base": {"model": "nano-banana"},
        "aspectRatio": "16:9",
        "shots": [
            {"id": "s1", "prompt": "a stepling at dawn"},
            {"id": "s2", "prompt": "a stepling at dusk"},
        ],
    }
    result = await handle_cinema_scene(
        _scene_node(scene), inputs={}, api_keys={"FAL_KEY": "x"}, emit=None
    )

    assert set(result.keys()) == {"shot_s1", "shot_s2"}
    for port_id in ("shot_s1", "shot_s2"):
        assert result[port_id]["type"] == "Image"
        assert isinstance(result[port_id]["value"], str)
        assert result[port_id]["value"].startswith("/api/outputs/")

    # Per-shot status is recorded back on the spec.
    shots = scene["shots"]
    assert shots[0]["output"]["status"] == "done"
    assert shots[1]["output"]["status"] == "done"
    assert shots[0]["output"]["hash"]


# ---------- per-shot isolation ----------


@pytest.mark.asyncio
async def test_failing_shot_is_isolated(monkeypatch) -> None:
    async def flaky(node, inputs, api_keys):
        prompt = inputs.get("prompt")
        if prompt and "boom" in str(prompt.value):
            raise RuntimeError("base model exploded")
        return {"image": {"type": "Image", "value": _write_base_image()}}

    _patch_base(monkeypatch, flaky)

    scene = {
        "version": 1,
        "base": {"model": "seedream-4-5"},
        "aspectRatio": "2.39:1",
        "shots": [
            {"id": "good1", "prompt": "calm scene"},
            {"id": "bad", "prompt": "boom scene"},
            {"id": "good2", "prompt": "another calm scene"},
        ],
    }
    result = await handle_cinema_scene(
        _scene_node(scene), inputs={}, api_keys={"FAL_KEY": "x"}, emit=None
    )

    # All three ports present — scene completed partially.
    assert set(result.keys()) == {"shot_good1", "shot_bad", "shot_good2"}
    assert result["shot_good1"]["value"].startswith("/api/outputs/")
    assert result["shot_good2"]["value"].startswith("/api/outputs/")
    assert result["shot_bad"]["value"] is None

    shots = {s["id"]: s for s in scene["shots"]}
    assert shots["good1"]["output"]["status"] == "done"
    assert shots["good2"]["output"]["status"] == "done"
    assert shots["bad"]["output"]["status"] == "error"
    assert "exploded" in shots["bad"]["output"]["error"]


# ---------- color + look stages run on the base output ----------


@pytest.mark.asyncio
async def test_color_and_look_modify_base_output(monkeypatch) -> None:
    base_url = _write_base_image(rgb=(128, 128, 128))

    async def ok(node, inputs, api_keys):
        return {"image": {"type": "Image", "value": base_url}}

    _patch_base(monkeypatch, ok)

    # A strong warm palette + vignette should change the pixels vs the base.
    scene = {
        "version": 1,
        "base": {"model": "nano-banana"},
        "aspectRatio": "16:9",
        "palette": {"swatches": ["#d98841", "#c46a28"], "strength": 0.9, "method": "reinhard"},
        "look": {"vignette": 0.6, "contrast": 0.3},
        "shots": [{"id": "only", "prompt": "warm-graded shot"}],
    }
    result = await handle_cinema_scene(
        _scene_node(scene), inputs={}, api_keys={"FAL_KEY": "x"}, emit=None
    )

    out_url = result["shot_only"]["value"]
    rel = out_url[len("/api/outputs/"):]
    out_path = (OUTPUT_ROOT / rel).resolve()
    assert out_path.exists()

    base_rel = base_url[len("/api/outputs/"):]
    base_arr = np.asarray(Image.open((OUTPUT_ROOT / base_rel).resolve()).convert("RGB"), dtype=np.int64)
    out_arr = np.asarray(Image.open(out_path).convert("RGB"), dtype=np.int64)
    # The graded output must differ from the flat base.
    assert out_arr.shape == base_arr.shape
    assert int(np.abs(out_arr - base_arr).sum()) > 0


# ---------- character refs flow into the base call ----------


@pytest.mark.asyncio
async def test_character_refs_passed_to_base(monkeypatch) -> None:
    ref_url = _write_base_image(rgb=(10, 200, 10))

    captured: dict[str, Any] = {}

    async def capture(node, inputs, api_keys):
        captured["images"] = inputs.get("images")
        captured["prompt"] = inputs.get("prompt")
        captured["aspectRatio"] = node.params.get("aspectRatio")
        return {"image": {"type": "Image", "value": _write_base_image()}}

    _patch_base(monkeypatch, capture)

    scene = {
        "version": 1,
        "base": {"model": "nano-banana"},
        "character": {"refImageUrls": [ref_url], "strength": 0.8},
        "prompt": "cinematic",
        "aspectRatio": "4:5",
        "shots": [{"id": "s1", "prompt": "close-up", "refImageUrls": []}],
    }
    await handle_cinema_scene(
        _scene_node(scene), inputs={}, api_keys={"FAL_KEY": "x"}, emit=None
    )

    images_port = captured["images"]
    assert images_port is not None
    assert ref_url in images_port.value
    # Prompt combines scene prompt + shot prompt.
    assert captured["prompt"].value == "cinematic close-up"
    assert captured["aspectRatio"] == "4:5"
