"""Cinema request translation; provider responses are local deterministic PNGs.

These checks prove outgoing guidance/reference requests and explicit replay,
not that a model physically reproduces camera settings or reference roles.
"""
from __future__ import annotations

import copy
import json
from uuid import uuid4
from unittest.mock import AsyncMock, patch

import pytest
from PIL import Image

from cinema.art_direction import reference_cap_for
from execution.engine import execute_graph, validate_graph
from handlers.camera_rig import handle_camera_rig
from handlers.cinema_scene import _build_base_node, handle_cinema_scene
from handlers.reference_set import handle_reference_set
from models.graph import GraphEdge, GraphNode, PortValueDict
from services.output import OUTPUT_ROOT, get_run_dir, read_manifest


def scene_node(model="nano-banana", shots=None, base_params=None):
    return GraphNode(id="scene", definitionId="cinema-scene", params={"scene": {
        "version": 1,
        "base": {"model": model, "params": base_params or {}},
        "prompt": "scene direction",
        "aspectRatio": "16:9",
        "shots": shots or [{"id": "a", "prompt": "shot direction"}],
    }})


def port(kind, value):
    return PortValueDict(type=kind, value=value)


def patch_base(monkeypatch):
    import execution.sync_runner as runner
    original_registry = runner.get_handler_registry
    calls = []

    async def base(node, inputs, _keys):
        calls.append({"params": copy.deepcopy(node.params), "inputs": {
            key: copy.deepcopy(value.value) for key, value in inputs.items()
        }})
        path = get_run_dir() / f"base-{uuid4().hex}.png"
        Image.new("RGB", (8, 8), "navy").save(path)
        return {"image": {"type": "Image", "value": str(path)}}

    def registry(emit=None):
        handlers = original_registry(emit)
        for model in ("nano-banana", "nano-banana-fal-edit", "seedream-4-5", "flux-kontext"):
            handlers[model] = base
        return handlers

    monkeypatch.setattr(runner, "get_handler_registry", registry)
    return calls, registry


@pytest.mark.asyncio
async def test_real_typed_utility_outputs_reach_cinema_base_request_with_verbatim_identity(monkeypatch):
    calls, _ = patch_base(monkeypatch)
    camera = await handle_camera_rig(GraphNode(id="cam", definitionId="camera-rig", params={
        "height": 2.5, "pitch": -15, "yaw": 45, "roll": 5, "focalLength": 85,
        "subjectDistance": 4.2, "focusDistance": 4, "subjectScreenX": .33, "subjectScreenY": .62,
    }), {}, {})
    references = await handle_reference_set(
        GraphNode(id="refs", definitionId="reference-set", params={
            "style_weight": .8, "lighting_weight": .8, "pose_weight": 0,
        }), {"style": port("Image", "style.png"), "lighting": port("Image", "light.png"),
             "pose": port("Image", "excluded.png")}, {},
    )
    trait = "  KEEP Exact: CASE; freckles!  "
    character = {"frozenTraitString": trait, "referenceViews": ["face.png"], "seed": 84,
                 "overridePrompt": "identity direction", "overrideRefs": ["outfit.png"]}
    node = scene_node(shots=[{"id": "a", "prompt": "shot direction", "refImageUrls": ["shot.png"]}])
    result = await handle_cinema_scene(node, {
        "character": port("Character", character),
        "camera_rig": PortValueDict(**camera["camera_rig"]),
        "reference_set": PortValueDict(**references["reference_set"]),
    }, {})
    assert result["shot_a"]["value"]
    assert calls[0]["inputs"]["images"] == ["face.png", "outfit.png", "shot.png", "style.png", "light.png"]
    assert "image" not in calls[0]["inputs"]
    assert calls[0]["inputs"]["prompt"] == (
        f"{trait}. scene direction shot direction. identity direction\n\n"
        "Camera prompt guidance: camera height: 2.5 m; pitch: -15 deg; yaw around subject: 45 deg; "
        "roll: 5 deg; focal length: 85 mm; subject distance: 4.2 m; focus distance: 4 m; "
        "subject horizontal position (0 left, 1 right): 0.33; subject vertical position (0 top, 1 bottom): 0.62.\n\n"
        "Reference image guidance (image numbers follow the supplied order): image 4: style; image 5: lighting."
    )
    assert calls[0]["params"]["seed"] == 84
    assert all(key not in calls[0]["params"] for key in ("camera_rig", "reference_set", "weight", "height"))


@pytest.mark.asyncio
async def test_reference_order_priority_deduplication_and_legend_use_actual_final_indexes(monkeypatch):
    calls, _ = patch_base(monkeypatch)
    node = scene_node(shots=[{"id": "a", "refImageUrls": ["shared.png", "existing.png"]}])
    items = [
        {"url": "low.png", "role": "style", "weight": .1},
        {"url": "high.png", "role": "lighting", "weight": .9},
        {"url": "shared.png", "role": "identity", "weight": .9},
        {"url": "high.png", "role": "composition", "weight": .9},
        {"url": "excluded.png", "role": "pose", "weight": 0},
    ]
    original = copy.deepcopy(items)
    await handle_cinema_scene(node, {"reference_set": port("ReferenceSet", {"items": items})}, {})
    assert items == original
    assert calls[0]["inputs"]["images"] == ["shared.png", "existing.png", "high.png", "low.png"]
    assert calls[0]["inputs"]["prompt"].endswith("image 3: lighting, composition; image 1: identity; image 4: style.")


@pytest.mark.asyncio
@pytest.mark.parametrize("new_inputs", [
    {}, {"camera_rig": port("CameraRig", {}), "reference_set": port("ReferenceSet", {"items": []})},
    {"reference_set": port("ReferenceSet", {"items": [{"url": "zero.png", "role": "pose", "weight": 0}]})},
])
async def test_empty_art_direction_preserves_existing_prompt_and_duplicate_refs(monkeypatch, new_inputs):
    calls, _ = patch_base(monkeypatch)
    node = scene_node(shots=[{"id": "a", "prompt": "  old prompt  ", "refImageUrls": ["old.png", "old.png"]}])
    await handle_cinema_scene(node, new_inputs, {})
    assert calls[0]["inputs"]["prompt"] == "scene direction   old prompt"
    assert calls[0]["inputs"]["images"] == ["old.png", "old.png"]


@pytest.mark.asyncio
@pytest.mark.parametrize("model,selector,cap", [
    ("seedream-4-5", "4.5", 10), ("seedream-4-5", "5.0-lite", 10),
    ("nano-banana", "gemini-3.1-flash-image", 14),
    ("nano-banana", "gemini-3.1-flash-lite-image", 14),
    ("nano-banana", "gemini-3-pro-image", 14),
    ("nano-banana", "gemini-2.5-flash-image", 3),
    ("nano-banana-fal-edit", "nano-banana-2", 14),
    ("nano-banana-fal-edit", "nano-banana-pro", 14),
    ("nano-banana-fal-edit", "nano-banana", 3),
    ("nano-banana-fal-edit", "gemini-25-flash-image", 3),
    ("nano-banana-fal-edit", "gemini-3-pro-image", 14),
    ("flux-kontext", "base", 1), ("flux-kontext", "max", 1),
])
async def test_actual_adapter_cap_blocks_overflow_without_character(monkeypatch, model, selector, cap):
    calls, _ = patch_base(monkeypatch)
    node = scene_node(model, [{"id": "a", "refImageUrls": [f"ref{i}.png" for i in range(cap)]}], {"model": selector})
    inputs = {"reference_set": port("ReferenceSet", {"items": [{"url": "extra.png", "role": "style", "weight": 1}]})}
    result = await handle_cinema_scene(node, inputs, {})
    assert result["shot_a"]["value"] is None
    assert calls == []
    assert f"at most {cap}" in node.params["scene"]["shots"][0]["output"]["error"]
    within_limit = scene_node(model, [{"id": "a", "refImageUrls": [f"ref{i}.png" for i in range(cap - 1)]}], {"model": selector})
    result = await handle_cinema_scene(within_limit, inputs, {})
    assert result["shot_a"]["value"]
    reference_values = calls[0]["inputs"].get("images", [calls[0]["inputs"].get("image")])
    assert len(reference_values) == cap


@pytest.mark.asyncio
async def test_overflow_isolated_to_shot_and_other_shot_request_still_runs(monkeypatch):
    calls, _ = patch_base(monkeypatch)
    node = scene_node("flux-kontext", [
        {"id": "bad", "prompt": "bad", "refImageUrls": ["shot.png"]},
        {"id": "good", "prompt": "good"},
    ])
    result = await handle_cinema_scene(node, {"reference_set": port("ReferenceSet", {
        "items": [{"url": "role.png", "role": "lighting", "weight": 1}],
    })}, {})
    assert result["shot_bad"]["value"] is None
    assert result["shot_good"]["value"]
    assert len(calls) == 1
    assert calls[0]["inputs"]["image"] == "role.png"
    assert "images" not in calls[0]["inputs"]
    assert calls[0]["inputs"]["prompt"].endswith("image 1: lighting.")


@pytest.mark.asyncio
async def test_active_role_refs_deduplicate_character_views_before_cap_check(monkeypatch):
    calls, _ = patch_base(monkeypatch)
    character = {"frozenTraitString": "Exact trait", "referenceViews": ["same.png", "same.png"], "seed": 7}
    node = scene_node("flux-kontext")
    await handle_cinema_scene(node, {
        "character": port("Character", character),
        "reference_set": port("ReferenceSet", {"items": [{"url": "same.png", "role": "identity", "weight": 1}]}),
    }, {})
    assert calls[0]["inputs"]["image"] == "same.png"
    assert calls[0]["inputs"]["prompt"].startswith("Exact trait. scene direction shot direction")


@pytest.mark.asyncio
@pytest.mark.parametrize("value", [float("nan"), float("inf"), float("-inf"), True, "45"])
async def test_malformed_typed_camera_fails_before_provider(monkeypatch, value):
    calls, _ = patch_base(monkeypatch)
    with pytest.raises(ValueError, match="yaw must be a finite number"):
        await handle_cinema_scene(scene_node(), {"camera_rig": port("CameraRig", {"yaw": value})}, {})
    assert calls == []


@pytest.mark.asyncio
async def test_unknown_base_submodel_rejected_before_provider(monkeypatch):
    calls, _ = patch_base(monkeypatch)
    with pytest.raises(ValueError, match="reference support is not verified"):
        await handle_cinema_scene(scene_node(base_params={"model": "unknown-image-model"}), {}, {})
    assert calls == []


@pytest.mark.parametrize("base", ["nano-banana", "nano-banana-fal-edit", "seedream-4-5", "flux-kontext"])
@pytest.mark.parametrize("selector", [None, "", 0, False, 4.5, [], {}])
def test_explicit_falsey_or_nonstring_selector_is_not_an_adapter_default(base, selector):
    params = {"model": selector}
    before = copy.deepcopy(params)
    with pytest.raises(ValueError, match="model selector must be a nonempty string"):
        reference_cap_for(base, params)
    assert params == before


@pytest.mark.parametrize("base,cap", [
    ("nano-banana", 14), ("nano-banana-fal-edit", 14), ("seedream-4-5", 10), ("flux-kontext", 1),
])
def test_missing_selector_still_uses_actual_adapter_default(base, cap):
    assert reference_cap_for(base, {}) == cap


@pytest.mark.asyncio
@pytest.mark.parametrize("base", ["nano-banana", "nano-banana-fal-edit", "seedream-4-5", "flux-kontext"])
@pytest.mark.parametrize("selector", [None, "", 0, False])
async def test_explicit_invalid_selector_fails_before_actual_transport(base, selector):
    from execution.sync_runner import get_handler_registry

    node = scene_node(base, base_params={"model": selector})
    before = copy.deepcopy(node.params)
    with patch("handlers.fal_universal.httpx.AsyncClient") as fal_transport, patch(
        "handlers.google_gemini.httpx.AsyncClient"
    ) as google_transport:
        with pytest.raises(ValueError, match="model selector must be a nonempty string"):
            await get_handler_registry(emit=AsyncMock())["cinema-scene"](node, {
                "reference_set": port("ReferenceSet", {"items": [
                    {"url": "https://example.com/ref.png", "role": "style", "weight": 1},
                ]}),
            }, {"FAL_KEY": "fixture-key", "GOOGLE_API_KEY": "fixture-key"})
        fal_transport.assert_not_called()
        google_transport.assert_not_called()
    assert node.params == before


@pytest.mark.parametrize("base", ["nano-banana", "nano-banana-fal-edit", "seedream-4-5", "flux-kontext"])
def test_synthesized_inputs_use_only_actual_adapter_reference_port(base):
    _, inputs = _build_base_node(base, "prompt", ["ref.png"], "16:9", {}, "n")
    assert set(inputs) == {"prompt", "image" if base == "flux-kontext" else "images"}


@pytest.mark.parametrize("ratio,size", [
    ("16:9", "landscape_16_9"), ("9:16", "portrait_16_9"), ("1:1", "square_hd"),
    ("4:3", "landscape_4_3"), ("3:4", "portrait_4_3"),
    ("2.39:1", {"width": 4096, "height": 1714}),
    ("4:5", {"width": 3277, "height": 4096}),
])
def test_seedream_scene_ratio_maps_to_actual_adapter_size(ratio, size):
    node, _ = _build_base_node("seedream-4-5", "prompt", ["ref.png"], ratio, {}, "n")
    assert node.params == {"image_size": size}


def test_seedream_explicit_saved_recipe_image_size_is_authoritative():
    node, _ = _build_base_node("seedream-4-5", "prompt", ["ref.png"], "16:9", {
        "image_size": {"width": 2048, "height": 2048}, "seed": 3,
    }, "n")
    assert node.params == {"image_size": {"width": 2048, "height": 2048}, "seed": 3}


@pytest.mark.asyncio
@pytest.mark.parametrize("field,value", [
    ("prompt", "replace the translated guidance"),
    ("image_url", "https://example.com/override.png"),
    ("image_urls", [f"https://example.com/override{i}.png" for i in range(11)]),
])
async def test_reserved_base_params_rejected_before_actual_provider_transport(field, value):
    from execution.sync_runner import get_handler_registry

    node = scene_node("seedream-4-5", base_params={field: value})
    before = copy.deepcopy(node.params)
    with patch("handlers.fal_universal.httpx.AsyncClient") as transport:
        with pytest.raises(ValueError, match=f"cannot override Cinema inputs: {field}"):
            await get_handler_registry(emit=AsyncMock())["cinema-scene"](node, {
                "camera_rig": port("CameraRig", {"yaw": 45}),
                "reference_set": port("ReferenceSet", {"items": [
                    {"url": "https://example.com/valid.png", "role": "style", "weight": 1},
                ]}),
            }, {"FAL_KEY": "fixture-key"})
        transport.assert_not_called()
    assert node.params == before


@pytest.mark.asyncio
@pytest.mark.parametrize("field", ["prompt", "image_url", "image_urls"])
async def test_engine_rejects_reserved_saved_base_inputs_without_submission(field):
    from execution.sync_runner import get_handler_registry

    nodes, edges = graph_with_art_direction()
    scene = nodes[-1]
    scene.params["scene"]["base"] = {"model": "seedream-4-5", "params": {
        field: ["https://example.com/override.png"] if field == "image_urls" else "override",
    }}
    before = copy.deepcopy(scene.params)
    events = []
    async def emit(event):
        events.append(event)

    with patch("handlers.fal_universal.httpx.AsyncClient") as transport:
        await execute_graph(nodes, edges, {"FAL_KEY": "fixture-key"}, get_handler_registry(emit), emit)
        transport.assert_not_called()
    errors = [event for event in events if event.type == "error" and event.node_id == "scene"]
    assert len(errors) == 1
    assert f"cannot override Cinema inputs: {field}" in errors[0].error
    assert not any(event.type == "executed" and event.node_id == "scene" for event in events)
    assert scene.params == before


@pytest.mark.parametrize("field", ["prompt", "image_url", "image_urls"])
def test_direct_cinema_request_synthesis_rejects_reserved_base_fields(field):
    with pytest.raises(ValueError, match=f"cannot override Cinema inputs: {field}"):
        _build_base_node("seedream-4-5", "typed guidance", ["safe.png"], "16:9", {field: "override"}, "n")


@pytest.mark.asyncio
@pytest.mark.parametrize("scene_wide", [False, True])
async def test_original_gemini_character_overflow_names_conservative_adapter_limit(monkeypatch, scene_wide):
    calls, _ = patch_base(monkeypatch)
    bundle = {"frozenTraitString": "Exact trait", "referenceViews": ["a.png", "b.png"], "seed": 7}
    node = scene_node("nano-banana", [{"id": "a", "refImageUrls": [] if scene_wide else ["c.png", "d.png"]}],
                      {"model": "gemini-2.5-flash-image"})
    if scene_wide:
        bundle["referenceViews"] += ["c.png", "d.png"]
        with pytest.raises(ValueError, match="Cinema adapter.*allows at most 3"):
            await handle_cinema_scene(node, {"character": port("Character", bundle)}, {})
    else:
        await handle_cinema_scene(node, {"character": port("Character", bundle)}, {})
        assert "Cinema adapter" in node.params["scene"]["shots"][0]["output"]["error"]
        assert "allows at most 3" in node.params["scene"]["shots"][0]["output"]["error"]
    assert calls == []


@pytest.mark.asyncio
@pytest.mark.parametrize("ratio", ["invalid", "0:1", "1:0", "-1:1", "1:100", "NaN:1"])
async def test_invalid_seedream_scene_ratio_errors_before_provider(monkeypatch, ratio):
    calls, _ = patch_base(monkeypatch)
    node = scene_node("seedream-4-5")
    node.params["scene"]["aspectRatio"] = ratio
    result = await handle_cinema_scene(node, {}, {})
    assert result["shot_a"]["value"] is None
    assert calls == []
    assert "aspectRatio" in node.params["scene"]["shots"][0]["output"]["error"]


def graph_with_art_direction():
    path = get_run_dir() / "reference.png"
    Image.new("RGB", (8, 8), "gold").save(path)
    nodes = [
        GraphNode(id="camera", definitionId="camera-rig", params={"yaw": 45}),
        GraphNode(id="image", definitionId="image-input", params={"filePath": str(path)}),
        GraphNode(id="refs", definitionId="reference-set", params={"style_weight": .8}),
        scene_node(),
    ]
    edges = [
        GraphEdge(id="camera-scene", source="camera", sourceHandle="camera_rig", target="scene", targetHandle="camera_rig"),
        GraphEdge(id="image-refs", source="image", sourceHandle="image", target="refs", targetHandle="style"),
        GraphEdge(id="refs-scene", source="refs", sourceHandle="reference_set", target="scene", targetHandle="reference_set"),
    ]
    return nodes, edges


@pytest.mark.asyncio
async def test_engine_frozen_recipe_rerun_uses_saved_inputs_and_keeps_earlier_artifact(monkeypatch):
    calls, registry = patch_base(monkeypatch)
    nodes, edges = graph_with_art_direction()
    saved = json.loads(json.dumps({"nodes": [n.model_dump(by_alias=True) for n in nodes],
                                  "edges": [e.model_dump(by_alias=True) for e in edges]}))
    events = []
    async def emit(event):
        events.append(event)

    assert validate_graph(nodes, edges, {"FAL_KEY": "test"}) == []
    await execute_graph(nodes, edges, {}, registry(emit), emit, run_id="art-direction-original")
    scene_results = [e for e in events if e.type == "executed" and e.node_id == "scene"]
    assert scene_results, [event.model_dump() for event in events if event.type == "error"]
    first = scene_results[0]
    output_url = first.outputs["shot_a"]["value"]
    output_path = OUTPUT_ROOT / output_url.removeprefix("/api/outputs/")
    original_bytes = output_path.read_bytes()
    original_manifest = read_manifest(output_path.parent)
    original_request = copy.deepcopy(calls[0])

    # Editing producer settings or disconnecting an edge does not call a model.
    nodes[0].params["yaw"] = 120
    nodes[1].params["filePath"] = "different.png"
    edges.pop()
    assert len(calls) == 1
    assert output_path.read_bytes() == original_bytes
    assert read_manifest(output_path.parent) == original_manifest

    # Explicit replay deserializes the saved graph; the edited live graph stays
    # edited and the original output/history file remains available.
    replay_nodes = [GraphNode(**n) for n in saved["nodes"]]
    replay_edges = [GraphEdge(**e) for e in saved["edges"]]
    await execute_graph(replay_nodes, replay_edges, {}, registry(emit), emit, run_id="art-direction-explicit-replay")
    assert calls[1] == original_request
    assert nodes[0].params["yaw"] == 120
    assert nodes[1].params["filePath"] == "different.png"
    assert len(edges) == 2
    assert output_path.read_bytes() == original_bytes
    assert read_manifest(output_path.parent) == original_manifest
    scene_events = [e for e in events if e.type == "executed" and e.node_id == "scene"]
    assert len(scene_events) == 2
    assert scene_events[1].outputs["shot_a"]["value"] != output_url


@pytest.mark.asyncio
async def test_single_shot_execution_pass_resolves_typed_inputs_with_same_handler(monkeypatch):
    import main as main_module
    calls, registry = patch_base(monkeypatch)
    nodes, edges = graph_with_art_direction()
    emitted = []
    async def emit(event):
        emitted.append(event)
    monkeypatch.setattr(main_module, "get_handler_registry", registry)
    monkeypatch.setattr(main_module, "_emit_and_sync", emit)
    executed, outputs = await main_module._execute_single_shot_pass(
        node_id="scene", sub_nodes=nodes, sub_edges=edges, api_keys={}, use_cache=False,
        seed=123, run_id="art-direction-single-shot",
    )
    assert executed is not None
    assert outputs["shot_a"]["value"]
    assert calls[0]["inputs"]["images"] == [nodes[1].params["filePath"]]
    assert "yaw around subject: 45 deg" in calls[0]["inputs"]["prompt"]
    assert calls[0]["inputs"]["prompt"].endswith("image 1: style.")
    assert calls[0]["params"]["seed"] == 123
