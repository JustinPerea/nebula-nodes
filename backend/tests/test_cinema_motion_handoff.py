"""Real persisted Cinema-to-motion mutations, with no provider/execution calls."""
from __future__ import annotations

import asyncio
import copy
from unittest.mock import AsyncMock, Mock

import httpx
import pytest
from fastapi import HTTPException
from fastapi.testclient import TestClient

import main
from services.cli_graph import CLIGraph
from services.output import OUTPUT_ROOT, portable_output_ref


IMAGE = "/api/outputs/synthetic-cinema/teal.png"
BODY = {"nodeId": "n1", "shotId": "opening", "expectedImageUrl": IMAGE}
ROUTE = "/api/cinema/send-to-motion"
REAL_BROADCAST_GRAPH_SYNC = main._broadcast_graph_sync


@pytest.fixture
def handoff(tmp_path, monkeypatch):
    path = tmp_path / "synthetic-motion-graph.json"
    graph = CLIGraph(path)
    graph.add_node("cinema-scene", {"scene": {
        "version": 1, "base": {"model": "nano-banana"}, "aspectRatio": "16:9",
        "shots": [{"id": "opening", "prompt": "Synthetic teal logo",
                   "output": {"status": "done", "imageUrl": IMAGE},
                   "variations": [{"url": IMAGE, "seed": 3}], "selectedVariation": 0},
                  {"id": "closing", "prompt": "Untouched sibling", "output": {"status": "idle"}}],
    }}, position={"x": 120, "y": 240}, outputs={"shot_opening": {"type": "Image", "value": IMAGE}})
    graph.add_node("text-input", {"value": "Unrelated authored node"}, outputs={"text": {"type": "Text", "value": "Earlier result"}})
    monkeypatch.setattr(main, "cli_graph", graph)
    broadcast = AsyncMock()
    monkeypatch.setattr(main, "_broadcast_graph_sync", broadcast)
    monkeypatch.setattr(main, "publish_action", Mock())
    execution = AsyncMock(side_effect=AssertionError("Handoff must not execute"))
    providers = Mock(side_effect=AssertionError("Handoff must not inspect provider settings"))
    handlers = Mock(side_effect=AssertionError("Handoff must not load generation handlers"))
    monkeypatch.setattr(main, "execute_graph", execution)
    monkeypatch.setattr(main, "load_settings", providers)
    monkeypatch.setattr(main, "get_handler_registry", handlers)
    yield TestClient(main.app, raise_server_exceptions=False), graph, path, broadcast
    execution.assert_not_called()
    providers.assert_not_called()
    handlers.assert_not_called()


def assert_unchanged(graph, path, before, bytes_before):
    assert graph.get_state() == before
    assert path.read_bytes() == bytes_before


def test_create_returns_confirmed_frontend_node_and_exact_image_edge_and_persists(handoff):
    client, graph, path, broadcast = handoff
    originals = copy.deepcopy(graph.nodes)
    response = client.post(ROUTE, json=BODY)
    assert response.status_code == 200, response.text
    result = response.json()
    assert set(result) == {"node", "edge"}
    assert result["node"]["id"] == "n3"
    assert result["node"]["type"] == "model-node"
    assert result["node"]["position"] == {"x": 480, "y": 240}
    assert result["node"]["data"]["definitionId"] == "veo-3"
    assert result["node"]["data"]["state"] == "idle"
    assert result["node"]["data"]["outputs"] == {}
    assert result["node"]["data"]["params"]["aspectRatio"] == "16:9"
    assert result["node"]["data"]["params"]["model"] == "veo-3.1-generate-preview"
    assert result["edge"] == {"id": "e1", "source": "n1", "sourceHandle": "shot_opening",
                              "target": "n3", "targetHandle": "image", "type": "typed-edge", "data": {"dataType": "Image"}}
    assert {node_id: graph.nodes[node_id] for node_id in originals} == originals
    reloaded = CLIGraph()
    reloaded.load(path)
    assert reloaded.get_state() == graph.get_state()
    broadcast.assert_awaited_once_with()


def test_retry_reuses_target_and_preserves_target_authoring_results_and_source_variations(handoff):
    client, graph, path, broadcast = handoff
    first = client.post(ROUTE, json=BODY).json()
    target = graph.nodes[first["node"]["id"]]
    target["params"].update({"duration": "4", "model": "veo-3.1-fast-generate-preview", "_editorNote": "Keep motion edits"})
    target["outputs"] = {"video": {"type": "Video", "value": "/api/outputs/synthetic-motion/earlier.mp4"}}
    graph.save(path)
    before, bytes_before = copy.deepcopy(graph.get_state()), path.read_bytes()
    retry = client.post(ROUTE, json=BODY)
    assert retry.status_code == 200, retry.text
    assert retry.json()["node"]["id"] == first["node"]["id"]
    assert retry.json()["node"]["data"]["params"] == target["params"]
    assert retry.json()["node"]["data"]["outputs"] == target["outputs"]
    assert retry.json()["node"]["data"]["state"] == "complete"
    assert retry.json()["edge"] == first["edge"]
    assert_unchanged(graph, path, before, bytes_before)
    assert broadcast.await_count == 1


def test_lost_acknowledgement_retry_after_reload_does_not_duplicate(handoff, monkeypatch):
    client, graph, path, broadcast = handoff
    broadcast.side_effect = RuntimeError("Synthetic lost acknowledgement after durable commit")
    assert client.post(ROUTE, json=BODY).status_code == 500
    assert len(graph.nodes) == 3 and len(graph.edges) == 1
    reloaded = CLIGraph(path)
    reloaded.load(path)
    monkeypatch.setattr(main, "cli_graph", reloaded)
    broadcast.side_effect = None
    retry = client.post(ROUTE, json=BODY)
    assert retry.status_code == 200, retry.text
    assert retry.json()["node"]["id"] == "n3"
    assert len(reloaded.nodes) == 3 and len(reloaded.edges) == 1


@pytest.mark.asyncio
async def test_overlapping_requests_commit_before_broadcast_and_reuse_exact_connection(handoff, monkeypatch):
    _, graph, _, _ = handoff
    entered, release = asyncio.Event(), asyncio.Event()

    async def held_broadcast():
        entered.set()
        await release.wait()

    monkeypatch.setattr(main, "_broadcast_graph_sync", held_broadcast)
    async with httpx.AsyncClient(transport=httpx.ASGITransport(app=main.app), base_url="http://127.0.0.1") as client:
        first = asyncio.create_task(client.post(ROUTE, json=BODY))
        await asyncio.wait_for(entered.wait(), timeout=3)
        retry = await client.post(ROUTE, json=BODY)
        assert retry.status_code == 200
        assert len(graph.nodes) == 3 and len(graph.edges) == 1
        release.set()
        original = await first
    assert original.json() == retry.json()


@pytest.mark.parametrize("mutation,detail", [
    (lambda graph: graph.nodes.pop("n1"), "removed"),
    (lambda graph: graph.nodes["n1"].update(definitionId="text-input"), "cinema-scene"),
    (lambda graph: graph.nodes["n1"]["params"]["scene"].update(shots=[]), "removed or changed"),
    (lambda graph: graph.nodes["n1"]["params"].update(scene=None), "removed or changed"),
    (lambda graph: graph.nodes["n1"]["params"]["scene"]["shots"].append(copy.deepcopy(graph.nodes["n1"]["params"]["scene"]["shots"][0])), "removed or changed"),
    (lambda graph: graph.nodes["n1"]["params"]["scene"]["shots"][0]["output"].update(status="running"), "finish"),
    (lambda graph: graph.nodes["n1"]["params"]["scene"]["shots"][0]["output"].update(status="error"), "finish"),
    (lambda graph: graph.nodes["n1"]["params"]["scene"]["shots"][0]["output"].update(imageUrl="/api/outputs/synthetic-cinema/new.png"), "changed"),
    (lambda graph: graph.nodes["n1"]["outputs"].clear(), "finish"),
    (lambda graph: graph.nodes["n1"]["outputs"]["shot_opening"].update(type="Video"), "finish"),
    (lambda graph: graph.nodes["n1"]["outputs"]["shot_opening"].update(value="/api/outputs/synthetic-cinema/other.png"), "changed"),
    (lambda graph: graph.nodes["n1"]["outputs"]["shot_opening"].update(value=None), "unavailable"),
])
def test_stale_or_unsettled_source_rejects_without_any_commit(handoff, mutation, detail):
    client, graph, path, broadcast = handoff
    mutation(graph)
    graph.save(path)
    before, bytes_before = copy.deepcopy(graph.get_state()), path.read_bytes()
    response = client.post(ROUTE, json=BODY)
    assert response.status_code in {400, 409}, response.text
    assert detail in response.json()["detail"]
    assert_unchanged(graph, path, before, bytes_before)
    broadcast.assert_not_called()


@pytest.mark.parametrize("field,value", [("nodeId", None), ("nodeId", ""), ("shotId", []), ("shotId", ""),
    ("expectedImageUrl", None), ("expectedImageUrl", 5), ("expectedImageUrl", ""),
    ("expectedImageUrl", " /api/outputs/test.png"), ("expectedImageUrl", "data:image/png;base64,fixture"),
    ("expectedImageUrl", "/api/outputs/%ZZ.png"), ("expectedImageUrl", "/api/outputs/../outside.png"),
    ("expectedImageUrl", "http://localhost:8045/api/outputs/test.png?cache=2")])
def test_invalid_request_rejects_without_mutation(handoff, field, value):
    client, graph, path, broadcast = handoff
    before, bytes_before = copy.deepcopy(graph.get_state()), path.read_bytes()
    response = client.post(ROUTE, json={**BODY, field: value})
    assert response.status_code == 400, response.text
    assert_unchanged(graph, path, before, bytes_before)
    broadcast.assert_not_called()


@pytest.mark.parametrize("browser_origin", ["http://127.0.0.1:8045", "http://localhost:8045", "http://[::1]:8045"])
def test_local_preview_origin_and_encoded_saved_path_identify_the_same_image(handoff, browser_origin):
    client, graph, _, _ = handoff
    absolute = str(OUTPUT_ROOT / "synthetic-cinema" / "teal logo ü.png")
    canonical = portable_output_ref(absolute)
    graph.nodes["n1"]["params"]["scene"]["shots"][0]["output"]["imageUrl"] = absolute
    graph.nodes["n1"]["outputs"]["shot_opening"]["value"] = canonical
    response = client.post(ROUTE, json={**BODY, "expectedImageUrl": browser_origin + canonical})
    assert response.status_code == 200, response.text


def test_remote_signed_image_is_compared_exactly_without_fetching(handoff):
    client, graph, _, _ = handoff
    image = "https://fixture.example/teal.png?signature=synthetic#v1"
    graph.nodes["n1"]["params"]["scene"]["shots"][0]["output"]["imageUrl"] = image
    graph.nodes["n1"]["outputs"]["shot_opening"]["value"] = image
    assert client.post(ROUTE, json={**BODY, "expectedImageUrl": image.replace("synthetic", "different")}).status_code == 409
    assert client.post(ROUTE, json={**BODY, "expectedImageUrl": image}).status_code == 200


@pytest.mark.parametrize("exception", [HTTPException(status_code=400, detail="Synthetic invalid handle"), ValueError("Synthetic connect failed")])
def test_rejected_connection_rolls_back_candidate_node_edge_and_counter(handoff, monkeypatch, exception):
    client, graph, path, broadcast = handoff
    before, bytes_before, counter = copy.deepcopy(graph.get_state()), path.read_bytes(), graph._counter
    monkeypatch.setattr(main, "_validate_connect_handles", Mock(side_effect=exception))
    response = client.post(ROUTE, json=BODY)
    assert response.status_code == 400, response.text
    assert graph._counter == counter
    assert_unchanged(graph, path, before, bytes_before)
    broadcast.assert_not_called()


def test_failed_durable_write_does_not_adopt_candidate(handoff, monkeypatch):
    client, graph, path, broadcast = handoff
    before, bytes_before, counter = copy.deepcopy(graph.get_state()), path.read_bytes(), graph._counter
    monkeypatch.setattr(graph, "_save_state", Mock(side_effect=OSError("Synthetic disk failure")))
    assert client.post(ROUTE, json=BODY).status_code == 500
    assert graph._counter == counter
    assert_unchanged(graph, path, before, bytes_before)
    broadcast.assert_not_called()


def test_first_valid_exact_edge_is_reused_deterministically_when_several_exist(handoff):
    client, graph, path, _ = handoff
    for number in range(2):
        target = graph.add_node("veo-3", {"_editorNote": f"Existing target {number}"})
        graph.connect("n1", "shot_opening", target, "image")
    before, bytes_before = copy.deepcopy(graph.get_state()), path.read_bytes()
    response = client.post(ROUTE, json=BODY)
    assert response.status_code == 200, response.text
    assert response.json()["node"]["id"] == "n3"
    assert response.json()["edge"]["id"] == "e1"
    assert_unchanged(graph, path, before, bytes_before)


def test_unrelated_or_invalid_existing_targets_do_not_count_as_exact_handoffs(handoff):
    client, graph, _, _ = handoff
    wrong_model = graph.add_node("gpt-image-2-generate", {})
    wrong_port = graph.add_node("veo-3", {})
    wrong_shot = graph.add_node("veo-3", {})
    graph.connect("n1", "shot_opening", wrong_model, "image")
    graph.connect("n1", "shot_opening", wrong_port, "last_frame")
    graph.connect("n1", "shot_closing", wrong_shot, "image")
    response = client.post(ROUTE, json=BODY)
    assert response.status_code == 200, response.text
    assert response.json()["node"]["id"] == "n6"
    assert len(graph.nodes) == 6 and len(graph.edges) == 4


def test_new_edge_identity_does_not_collide_after_earlier_edge_deletion(handoff):
    client, graph, _, _ = handoff
    text_target = graph.add_node("combine-text", {})
    graph.connect("n2", "text", text_target, "text1")
    graph.connect("n2", "text", text_target, "text2")
    graph.remove_edge("n2", "text", text_target, "text1")
    response = client.post(ROUTE, json=BODY)
    assert response.status_code == 200, response.text
    assert response.json()["edge"]["id"] != "e2"
    assert len({edge["id"] for edge in graph.edges}) == len(graph.edges)
    assert client.post(ROUTE, json=BODY).json()["node"]["id"] == response.json()["node"]["id"]


def test_unpositioned_source_uses_canvas_export_fallback(handoff):
    client, graph, _, _ = handoff
    del graph.nodes["n1"]["position"]
    graph.nodes["n2"]["position"] = {"x": 650, "y": 30}
    response = client.post(ROUTE, json=BODY)
    assert response.status_code == 200, response.text
    assert response.json()["node"]["position"] == {"x": 1310, "y": 100}


def test_canonical_export_and_real_graph_sync_hydrate_valid_cinema_image_edges(handoff, monkeypatch):
    client, graph, _, _ = handoff
    ws_broadcast = AsyncMock()
    monkeypatch.setattr(main.manager, "broadcast_raw", ws_broadcast)
    monkeypatch.setattr(main, "_broadcast_graph_sync", REAL_BROADCAST_GRAPH_SYNC)

    response = client.post(ROUTE, json=BODY)
    assert response.status_code == 200, response.text
    connected_edge = response.json()["edge"]
    first_sync = ws_broadcast.call_args.args[0]
    assert first_sync["type"] == "graphSync"
    assert next(edge for edge in first_sync["edges"] if edge["id"] == connected_edge["id"]) == connected_edge

    text_edge = graph.connect("n2", "text", connected_edge["target"], "prompt")
    unknown_edge = graph.connect("n1", "shot_removed", connected_edge["target"], "last_frame")
    exported = client.get("/api/graph/export").json()
    by_id = {edge["id"]: edge for edge in exported["edges"]}
    assert by_id[connected_edge["id"]] == connected_edge
    assert by_id[text_edge["id"]]["data"] == {"dataType": "Text"}
    assert by_id[unknown_edge["id"]]["data"] == {"dataType": "Any"}
    asyncio.run(REAL_BROADCAST_GRAPH_SYNC())
    assert ws_broadcast.call_args.args[0]["edges"] == exported["edges"]
