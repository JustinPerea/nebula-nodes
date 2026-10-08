"""Cinema authoring PUTs preserve newer server-owned media, with no providers."""
from __future__ import annotations

import asyncio
import copy
from contextlib import nullcontext
from unittest.mock import AsyncMock, Mock

import pytest
from fastapi.testclient import TestClient
from PIL import Image

import main
import execution.sync_runner as sync_runner
import handlers.cinema_scene as cinema_scene
from execution.engine import execute_graph
from models.events import ExecutedEvent
from models.graph import GraphEdge, GraphNode
from services.cache import ExecutionCache
from services.cli_graph import CLIGraph
from services.output import OUTPUT_ROOT


def scene(shots):
    return {"version": 1, "base": {"model": "nano-banana"}, "aspectRatio": "16:9", "shots": shots}


@pytest.fixture
def authoring_client(tmp_path, monkeypatch):
    path = tmp_path / "synthetic-cinema-graph.json"
    graph = CLIGraph(path)
    graph.add_node("cinema-scene", {"scene": scene([
        {"id": "a", "prompt": "Initial", "output": {"status": "idle"}},
        {"id": "b", "prompt": "Sibling", "output": {"status": "idle"}},
    ]), "_editorNote": "preserve"})
    monkeypatch.setattr(main, "cli_graph", graph)
    monkeypatch.setattr(main, "_paid_graph_mutation", lambda _action: nullcontext())
    broadcast = AsyncMock()
    monkeypatch.setattr(main, "_broadcast_graph_sync", broadcast)
    monkeypatch.setattr(main, "publish_action", Mock())
    return TestClient(main.app), graph, path, broadcast


def test_stale_authoring_put_keeps_completed_media_variations_and_selection_after_reload(authoring_client):
    client, graph, path, broadcast = authoring_client
    # The browser captures this authoring snapshot before the provider settles.
    authored = copy.deepcopy(graph.nodes["n1"]["params"]["scene"])
    authored["shots"][0].update({"prompt": "New authored prompt", "refImageUrls": ["https://fixture.example/reference.png"]})
    authored["base"] = {"model": "seedream-4-5"}
    authored["shots"].reverse()
    runtime = {
        "output": {"status": "done", "imageUrl": "https://fixture.example/new.png", "hash": "synthetic-hash"},
        "variations": [{"url": "https://fixture.example/new.png", "seed": 7}, {"url": "https://fixture.example/other.png", "seed": 8}],
        "selectedVariation": 1,
    }
    graph.nodes["n1"]["params"]["scene"]["shots"][0].update(copy.deepcopy(runtime))
    graph.nodes["n1"]["outputs"]["shot_a"] = {"type": "Image", "value": "https://fixture.example/other.png"}

    response = client.put("/api/graph/node/n1", json={"params": {"scene": authored}})

    assert response.status_code == 200
    saved = response.json()["params"]["scene"]
    assert saved["base"] == {"model": "seedream-4-5"}
    assert [shot["id"] for shot in saved["shots"]] == ["b", "a"]
    target = saved["shots"][1]
    assert target["prompt"] == "New authored prompt"
    assert target["refImageUrls"] == ["https://fixture.example/reference.png"]
    assert {key: target[key] for key in runtime} == runtime
    assert response.json()["params"]["_editorNote"] == "preserve"
    reloaded = CLIGraph()
    reloaded.load(path)
    exported = reloaded.get_state()["nodes"][0]
    assert exported["params"]["scene"] == saved
    assert exported["outputs"]["shot_a"]["value"] == "https://fixture.example/other.png"
    broadcast.assert_awaited_once_with()


@pytest.mark.parametrize("canonical_runtime", [
    {}, {"output": None}, {"variations": None}, {"selectedVariation": None},
    {"output": {"status": "running"}},
    {"output": {"status": "error", "error": "synthetic error"}},
    {"variations": [], "selectedVariation": 0},
])
def test_existing_shot_preserves_exact_runtime_presence_instead_of_installing_stale_values(authoring_client, canonical_runtime):
    client, graph, _, _ = authoring_client
    canonical = {"id": "a", "prompt": "Canonical", **copy.deepcopy(canonical_runtime)}
    graph.nodes["n1"]["params"]["scene"] = scene([canonical])
    incoming = {"id": "a", "prompt": "Authored edit", "output": {"status": "done", "imageUrl": "https://fixture.example/stale.png"},
                "variations": [{"url": "https://fixture.example/stale.png", "seed": 1}], "selectedVariation": 2}
    response = client.put("/api/graph/node/n1", json={"params": {"scene": scene([incoming])}})
    assert response.status_code == 200
    shot = response.json()["params"]["scene"]["shots"][0]
    assert shot == {"id": "a", "prompt": "Authored edit", **canonical_runtime}


def test_new_authoring_shot_starts_idle_and_cannot_install_client_runtime(authoring_client):
    client, graph, _, _ = authoring_client
    existing = copy.deepcopy(graph.nodes["n1"]["params"]["scene"]["shots"][0])
    new = {"id": "new", "prompt": "New shot", "refImageUrls": ["https://fixture.example/ref.png"],
           "output": {"status": "done", "imageUrl": "https://fixture.example/import.png"},
           "variations": [{"url": "https://fixture.example/import.png", "seed": 3}], "selectedVariation": 0}
    response = client.put("/api/graph/node/n1", json={"params": {"scene": scene([new, existing])}})
    assert response.status_code == 200
    assert response.json()["params"]["scene"]["shots"][0] == {
        "id": "new", "prompt": "New shot", "refImageUrls": ["https://fixture.example/ref.png"], "output": {"status": "idle"},
    }


def test_removed_shots_prune_only_their_output_ports_and_downstream_edges(authoring_client):
    client, graph, path, _ = authoring_client
    graph.nodes["n1"]["outputs"] = {"shot_a": {"type": "Image", "value": "https://fixture.example/a.png"},
                                     "shot_b": {"type": "Image", "value": "https://fixture.example/b.png"},
                                     "summary": {"type": "Text", "value": "Keep"}}
    graph.add_node("image-input", {})
    graph.connect("n1", "shot_a", "n2", "image")
    graph.connect("n1", "shot_b", "n2", "other")
    graph.connect("n1", "summary", "n2", "text")
    authored = scene([{"id": "b", "prompt": "Remaining"}])
    response = client.put("/api/graph/node/n1", json={"params": {"scene": authored}})
    assert response.status_code == 200
    assert response.json()["outputs"] == {"shot_b": {"type": "Image", "value": "https://fixture.example/b.png"},
                                           "summary": {"type": "Text", "value": "Keep"}}
    assert [edge["sourceHandle"] for edge in graph.edges] == ["shot_b", "summary"]
    reloaded = CLIGraph()
    reloaded.load(path)
    assert reloaded.nodes["n1"]["outputs"] == response.json()["outputs"]
    assert reloaded.edges == graph.edges


@pytest.mark.parametrize("invalid_scene", [None, {}, {"shots": "wrong"}, {"shots": ["wrong"]},
                                           {"shots": [{"id": 1}]}, {"shots": [{"id": ""}]},
                                           {"shots": [{"id": "a"}, {"id": "a"}]}])
def test_invalid_authoring_identity_fails_before_any_graph_or_disk_mutation(authoring_client, invalid_scene):
    client, graph, path, broadcast = authoring_client
    before = copy.deepcopy(graph.get_state())
    disk = path.read_bytes()
    response = client.put("/api/graph/node/n1", json={"params": {"scene": invalid_scene}})
    assert response.status_code == 400
    assert graph.get_state() == before
    assert path.read_bytes() == disk
    broadcast.assert_not_awaited()


def test_other_parameter_edits_leave_cinema_runtime_untouched(authoring_client):
    client, graph, _, _ = authoring_client
    before = copy.deepcopy(graph.nodes["n1"]["params"]["scene"])
    response = client.put("/api/graph/node/n1", json={"params": {"_editorNote": "new note"}})
    assert response.status_code == 200
    assert response.json()["params"]["scene"] == before
    assert response.json()["params"]["_editorNote"] == "new note"


@pytest.mark.parametrize("legacy_scene", [None, {"shots": None}, {"shots": "malformed"}, {"shots": [None, "bad"]}])
def test_valid_authoring_put_repairs_malformed_legacy_scene_without_reusing_runtime(authoring_client, legacy_scene):
    client, graph, _, _ = authoring_client
    graph.nodes["n1"]["params"]["scene"] = legacy_scene
    response = client.put("/api/graph/node/n1", json={"params": {"scene": scene([
        {"id": "a", "prompt": "Repaired", "variations": [{"url": "https://fixture.example/stale.png"}]},
    ])}})
    assert response.status_code == 200
    assert response.json()["params"]["scene"]["shots"] == [
        {"id": "a", "prompt": "Repaired", "output": {"status": "idle"}},
    ]


@pytest.mark.asyncio
async def test_whole_scene_completion_merges_produced_output_without_rewinding_new_authoring_or_history(
    authoring_client, monkeypatch,
):
    client, graph, path, _ = authoring_client
    old_scene = scene([
        {"id": "a", "prompt": "Recipe A", "refImageUrls": ["https://fixture.example/old-ref.png"],
         "output": {"status": "done", "imageUrl": "https://fixture.example/old-a.png"},
         "variations": [{"url": "https://fixture.example/old-a.png"}], "selectedVariation": 0},
        {"id": "b", "prompt": "Recipe B", "output": {"status": "idle"}},
    ])
    executed = GraphNode(id="n1", definitionId="cinema-scene", params={"scene": copy.deepcopy(old_scene), "_editorNote": "old note"})
    canonical_scene = {
        **scene([
            {"id": "c", "prompt": "Added while running", "output": {"status": "done", "imageUrl": "https://fixture.example/new-c.png"}},
            {"id": "a", "prompt": "Edited while running", "refImageUrls": ["https://fixture.example/upload.png"],
             "overrides": {"look": {"grain": 0.4}},
             "output": {"status": "done", "imageUrl": "https://fixture.example/promoted.png"},
             "variations": [{"url": "https://fixture.example/new-var.png"}, {"url": "https://fixture.example/promoted.png"}],
             "selectedVariation": 1},
        ]),
        "base": {"model": "seedream-4-5", "params": {"seed": 99}},
        "look": {"grain": 0.2}, "prompt": "New scene direction",
        "refImageUrls": ["https://fixture.example/shared-upload.png"],
    }
    canonical_params = {"scene": canonical_scene, "_editorNote": "new note"}
    canonical_ports = {
        "shot_a": {"type": "Image", "value": "https://fixture.example/promoted.png"},
        "shot_c": {"type": "Image", "value": "https://fixture.example/new-c.png"},
        "summary": {"type": "Text", "value": "retain"},
    }
    calls = 0

    async def fake_base(_node, _inputs, _keys):
        nonlocal calls
        calls += 1
        if calls == 1:
            # The real handler is awaiting its old recipe's base call while
            # newer authoring and a variation promotion become canonical.
            graph.nodes["n1"]["params"] = copy.deepcopy(canonical_params)
            graph.nodes["n1"]["outputs"] = copy.deepcopy(canonical_ports)
        return {"image": {"type": "Image", "value": "https://fixture.example/base.png"}}

    monkeypatch.setattr(sync_runner, "get_handler_registry", lambda emit=None: {"nano-banana": fake_base})
    monkeypatch.setattr(cinema_scene, "_load_image", AsyncMock(return_value=Image.new("RGB", (2, 2))))
    monkeypatch.setattr(cinema_scene, "_save_output_image", Mock(side_effect=["https://fixture.example/recipe-a.png", "https://fixture.example/recipe-b.png"]))
    produced = await cinema_scene.handle_cinema_scene(executed, {}, {})
    broadcast = AsyncMock()
    monkeypatch.setattr(main.manager, "broadcast", broadcast)
    await main._emit_and_sync(ExecutedEvent(node_id="n1", outputs=produced))
    assert main._sync_params_to_cli_graph([executed]) is True

    saved = graph.nodes["n1"]
    expected_params = copy.deepcopy(canonical_params)
    expected_params["scene"]["shots"][1]["output"] = copy.deepcopy(executed.params["scene"]["shots"][0]["output"])
    assert saved["params"] == expected_params
    assert saved["outputs"] == {
        **canonical_ports, "shot_a": {"type": "Image", "value": "https://fixture.example/recipe-a.png"},
    }
    # The historical event contains the removed shot's actual artifact, while
    # the live canonical ports and authored shot list do not resurrect it.
    assert broadcast.await_args.args[0].outputs == produced
    assert "shot_b" in broadcast.await_args.args[0].outputs
    assert [shot["id"] for shot in saved["params"]["scene"]["shots"]] == ["c", "a"]
    assert executed.params["scene"]["shots"][0]["variations"] == old_scene["shots"][0]["variations"]
    assert saved["params"]["scene"]["shots"][1]["variations"] == canonical_scene["shots"][1]["variations"]
    assert saved["params"]["scene"]["shots"][1]["selectedVariation"] == 1
    reloaded = CLIGraph()
    reloaded.load(path)
    assert reloaded.nodes["n1"]["params"] == expected_params
    assert reloaded.nodes["n1"]["outputs"] == saved["outputs"]
    exported = client.get("/api/graph/export").json()["nodes"][0]["data"]
    assert exported["params"] == expected_params
    assert exported["outputs"] == saved["outputs"]
    assert main._sync_params_to_cli_graph([executed]) is False


def test_cinema_output_sync_keeps_current_unexecuted_ports_and_prunes_removed_ports(authoring_client):
    _, graph, path, _ = authoring_client
    graph.nodes["n1"]["params"]["scene"] = scene([{"id": "a"}, {"id": "new"}])
    graph.nodes["n1"]["outputs"] = {
        "shot_a": {"type": "Image", "value": "https://fixture.example/old.png"},
        "shot_new": {"type": "Image", "value": "https://fixture.example/new.png"},
        "shot_removed": {"type": "Image", "value": "https://fixture.example/stale.png"},
    }
    recipe = {"shot_a": {"type": "Image", "value": "https://fixture.example/result.png"},
              "shot_removed": {"type": "Image", "value": "https://fixture.example/history.png"}}
    returned = main._sync_outputs_to_cli_graph("n1", recipe)
    assert returned == recipe
    assert graph.nodes["n1"]["outputs"] == {
        "shot_a": recipe["shot_a"], "shot_new": {"type": "Image", "value": "https://fixture.example/new.png"},
    }
    reloaded = CLIGraph()
    reloaded.load(path)
    assert reloaded.nodes["n1"]["outputs"] == graph.nodes["n1"]["outputs"]


@pytest.mark.parametrize("canonical_scene", [None, {"shots": None}, {"shots": "legacy"}])
def test_whole_scene_completion_does_not_seed_old_authoring_into_missing_scene(authoring_client, canonical_scene):
    _, graph, _, _ = authoring_client
    graph.nodes["n1"]["params"]["scene"] = copy.deepcopy(canonical_scene)
    executed = GraphNode(id="n1", definitionId="cinema-scene", params={"scene": scene([
        {"id": "a", "prompt": "Old recipe", "output": {"status": "done"}},
    ])})
    assert main._sync_params_to_cli_graph([executed]) is False
    assert graph.nodes["n1"]["params"]["scene"] == canonical_scene


def test_whole_scene_completion_ignores_missing_or_retyped_target_and_other_handlers_still_sync(authoring_client):
    _, graph, _, _ = authoring_client
    stale = GraphNode(id="n1", definitionId="cinema-scene", params={"scene": scene([])})
    graph.nodes["n1"]["definitionId"] = "video-edit"
    graph.nodes["n1"]["params"] = {"clips": []}
    assert main._sync_params_to_cli_graph([stale, stale.model_copy(update={"id": "absent"})]) is False
    assert graph.nodes["n1"]["params"] == {"clips": []}
    video_edit = GraphNode(id="n1", definitionId="video-edit", params={"clips": [{"duration": 3}], "sourceDuration": 3})
    assert main._sync_params_to_cli_graph([video_edit]) is True
    assert graph.nodes["n1"]["params"] == video_edit.params


def test_unexecuted_snapshot_cannot_install_copied_runtime_and_marker_is_not_request_data(authoring_client):
    _, graph, _, _ = authoring_client
    canonical = copy.deepcopy(graph.nodes["n1"]["params"])
    canonical["scene"]["shots"][0]["output"] = {"status": "done", "imageUrl": "https://fixture.example/newer.png"}
    graph.nodes["n1"]["params"] = canonical
    copied = GraphNode.model_validate({
        "id": "n1", "definitionId": "cinema-scene", "params": {"scene": scene([
            {"id": "a", "prompt": "Old", "output": {"status": "done", "imageUrl": "https://fixture.example/old.png"}},
        ])},
        "_cinema_produced_outputs": {"a": {"status": "done", "imageUrl": "https://fixture.example/injected.png"}},
    })
    assert copied._cinema_produced_outputs == {}
    assert "_cinema_produced_outputs" not in copied.model_dump()
    assert main._sync_params_to_cli_graph([copied]) is False
    assert graph.nodes["n1"]["params"] == canonical


@pytest.mark.asyncio
@pytest.mark.parametrize("first_success", [True, False])
async def test_cancelled_whole_scene_sync_only_installs_shots_that_actually_settled(authoring_client, monkeypatch, first_success):
    _, graph, path, _ = authoring_client
    executed = GraphNode(id="n1", definitionId="cinema-scene", params=copy.deepcopy(graph.nodes["n1"]["params"]))
    newer = copy.deepcopy(graph.nodes["n1"]["params"])
    newer["scene"]["shots"][1].update({"prompt": "New sibling", "output": {"status": "done", "imageUrl": "https://fixture.example/new-b.png"}})
    graph.nodes["n1"]["params"] = newer
    graph.nodes["n1"]["outputs"] = {
        "shot_a": {"type": "Image", "value": "https://fixture.example/old-a.png"},
        "shot_b": {"type": "Image", "value": "https://fixture.example/new-b.png"},
    }
    calls = 0

    async def fake_base(_node, _inputs, _keys):
        nonlocal calls
        calls += 1
        if calls == 2:
            raise asyncio.CancelledError
        if not first_success:
            raise RuntimeError("Synthetic first-shot error")
        return {"image": {"type": "Image", "value": "https://fixture.example/base.png"}}

    monkeypatch.setattr(sync_runner, "get_handler_registry", lambda emit=None: {"nano-banana": fake_base})
    monkeypatch.setattr(cinema_scene, "_load_image", AsyncMock(return_value=Image.new("RGB", (2, 2))))
    monkeypatch.setattr(cinema_scene, "_save_output_image", Mock(return_value="https://fixture.example/completed-a.png"))
    with pytest.raises(asyncio.CancelledError):
        await cinema_scene.handle_cinema_scene(executed, {}, {})
    assert set(executed._cinema_produced_outputs) == {"a"}
    assert main._sync_params_to_cli_graph([executed]) is True
    saved = graph.nodes["n1"]["params"]["scene"]["shots"]
    if first_success:
        assert saved[0]["output"]["imageUrl"] == "https://fixture.example/completed-a.png"
    else:
        assert saved[0]["output"] == {"status": "error", "error": "Synthetic first-shot error"}
    assert saved[1] == newer["scene"]["shots"][1]
    assert graph.nodes["n1"]["outputs"] == {
        "shot_a": {"type": "Image", "value": "https://fixture.example/completed-a.png" if first_success else None},
        "shot_b": {"type": "Image", "value": "https://fixture.example/new-b.png"},
    }
    reloaded = CLIGraph()
    reloaded.load(path)
    assert reloaded.nodes["n1"]["outputs"] == graph.nodes["n1"]["outputs"]


@pytest.mark.asyncio
@pytest.mark.parametrize("cached_success", [True, False])
async def test_cached_context_cinema_result_syncs_rebound_runtime_without_copying_cached_authoring(
    authoring_client, monkeypatch, tmp_path, cached_success,
):
    _, graph, _, _ = authoring_client
    reference = tmp_path / "synthetic-reference.png"
    Image.new("RGB", (2, 2)).save(reference)
    cache_source = OUTPUT_ROOT / "synthetic-cinema-cache.png"
    Image.new("RGB", (2, 2), "blue").save(cache_source)
    cached_url = "/api/outputs/synthetic-cinema-cache.png"
    recipe = GraphNode(id="n1", definitionId="cinema-scene", params={"scene": scene([
        {"id": "a", "prompt": "Cached recipe", "output": {"status": "idle"},
         "variations": [{"url": "https://fixture.example/old-var.png"}], "selectedVariation": 0},
    ])})
    cache = ExecutionCache()
    key = cache.get_key("cinema-scene", recipe.params, {
        "character_refs": {"type": "Image", "value": [str(reference)]},
    }, node_id="n1")
    effective = copy.deepcopy(recipe.params)
    cached_runtime = ({"status": "done", "imageUrl": cached_url, "hash": "cached-hash"} if cached_success
                      else {"status": "error", "error": "Synthetic cached base failure"})
    effective["scene"]["shots"][0]["output"] = cached_runtime
    cache.set(key, {"shot_a": {"type": "Image", "value": cached_url if cached_success else None}}, effective_params=effective)
    canonical = {"scene": scene([
        {"id": "new", "prompt": "Added", "output": {"status": "idle"}},
        {"id": "a", "prompt": "New authored prompt", "refImageUrls": ["https://fixture.example/upload.png"],
         "variations": [{"url": "https://fixture.example/new-var.png"}], "selectedVariation": 0},
    ]), "_editorNote": "keep"}
    graph.nodes["n1"]["params"] = copy.deepcopy(canonical)
    graph.nodes["n1"]["outputs"] = {"shot_new": {"type": "Image", "value": None}}
    nodes = [
        GraphNode(id="ref", definitionId="image-input", params={"filePath": str(reference)}),
        GraphNode(id="array", definitionId="array-builder"),
        GraphNode(id="iterator", definitionId="iterator-image"), recipe,
    ]
    edges = [
        GraphEdge(id="ref-array", source="ref", sourceHandle="image", target="array", targetHandle="item1"),
        GraphEdge(id="array-iterator", source="array", sourceHandle="array", target="iterator", targetHandle="array"),
        GraphEdge(id="iterator-cinema", source="iterator", sourceHandle="image", target="n1", targetHandle="character_refs"),
    ]
    handler = AsyncMock(side_effect=AssertionError("A warm cache must bypass the handler"))
    events = []

    async def emit(event):
        events.append(event)
        if isinstance(event, ExecutedEvent):
            main._sync_outputs_to_cli_graph(event.node_id, event.outputs)

    await execute_graph(nodes, edges, {}, {"cinema-scene": handler}, emit, cache=cache)
    handler.assert_not_awaited()
    results = [event for event in events if isinstance(event, ExecutedEvent) and event.node_id == "n1"]
    assert len(results) == 1, [event.model_dump() for event in events if event.type == "error"]
    rebound = results[0].outputs["shot_a"]["value"]
    if cached_success:
        assert rebound != cached_url
        assert rebound.startswith("/api/outputs/")
    else:
        assert rebound is None
    assert set(recipe._cinema_produced_outputs) == {"a"}
    assert main._sync_params_to_cli_graph([recipe]) is True
    expected = copy.deepcopy(canonical)
    expected["scene"]["shots"][1]["output"] = ({"status": "done", "imageUrl": rebound, "hash": "cached-hash"}
                                              if cached_success else cached_runtime)
    assert graph.nodes["n1"]["params"] == expected
    assert graph.nodes["n1"]["outputs"] == {"shot_new": {"type": "Image", "value": None}, "shot_a": results[0].outputs["shot_a"]}
    assert recipe.params["scene"]["shots"][0]["prompt"] == "Cached recipe"
    assert "_cinema_produced_outputs" not in recipe.model_dump()
