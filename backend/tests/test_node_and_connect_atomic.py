"""Persisted create-and-connect contract tests; no execution or providers."""
from __future__ import annotations

import copy
from unittest.mock import AsyncMock, Mock

import pytest
from fastapi.testclient import TestClient

import main
from services.cli_graph import CLIGraph


ROUTE = "/api/graph/node-and-connect"
BODY = {
    "definitionId": "gpt-image-2-edit",
    "params": {"size": "auto"},
    "position": {"x": 480, "y": 160},
    "connect": {
        "source": "n1", "sourceHandle": "image",
        "target": "", "targetHandle": "images", "newNodeIs": "target",
    },
}


@pytest.fixture
def connected_graph(tmp_path, monkeypatch):
    path = tmp_path / "synthetic-connected-graph.json"
    graph = CLIGraph(path)
    graph.add_node("image-input", {"filePath": ""}, position={"x": 120, "y": 160},
                   outputs={"image": {"type": "Image", "value": "/api/outputs/synthetic/source.png"}})
    graph.add_node("gpt-image-2-edit", {"size": "auto"}, position={"x": 480, "y": 480})
    graph.add_node("text-input", {"value": "Keep this authored prompt"},
                   outputs={"text": {"type": "Text", "value": "Keep this earlier result"}})
    monkeypatch.setattr(main, "cli_graph", graph)
    broadcast = AsyncMock()
    actions = Mock()
    monkeypatch.setattr(main, "_broadcast_graph_sync", broadcast)
    monkeypatch.setattr(main, "publish_action", actions)
    execution = AsyncMock(side_effect=AssertionError("Connecting must not execute"))
    providers = Mock(side_effect=AssertionError("Connecting must not inspect provider settings"))
    handlers = Mock(side_effect=AssertionError("Connecting must not load generation handlers"))
    monkeypatch.setattr(main, "execute_graph", execution)
    monkeypatch.setattr(main, "load_settings", providers)
    monkeypatch.setattr(main, "get_handler_registry", handlers)
    yield TestClient(main.app, raise_server_exceptions=False), graph, path, broadcast, actions
    execution.assert_not_called()
    providers.assert_not_called()
    handlers.assert_not_called()


def assert_unchanged(graph, path, before, bytes_before, counter_before):
    assert graph.get_state() == before
    assert graph._counter == counter_before
    assert path.read_bytes() == bytes_before


@pytest.mark.parametrize("new_side", ["target", "source"])
def test_success_confirms_canonical_pair_retains_raw_node_and_preserves_history(connected_graph, new_side):
    client, graph, path, broadcast, actions = connected_graph
    originals = copy.deepcopy(graph.nodes)
    body = copy.deepcopy(BODY)
    if new_side == "source":
        body.update(definitionId="image-input", params={"filePath": ""})
        body["connect"].update(source="", target="n2", newNodeIs="source")
    response = client.post(ROUTE, json=body)
    assert response.status_code == 200, response.text
    result = response.json()
    assert result["connected"] is True
    assert {key: result[key] for key in graph.nodes["n4"]} == graph.nodes["n4"]
    assert result["id"] == "n4"
    assert result["definitionId"] == body["definitionId"]
    assert result["params"] == body["params"]
    assert result["position"] == body["position"]
    assert result["outputs"] == {}
    assert result["edge"] == {
        "id": "e1", "source": "n1" if new_side == "target" else "n4", "sourceHandle": "image",
        "target": "n4" if new_side == "target" else "n2", "targetHandle": "images",
        "type": "typed-edge", "data": {"dataType": "Image"},
    }
    assert graph.edges == [{key: result["edge"][key] for key in ("id", "source", "sourceHandle", "target", "targetHandle")}]
    assert {node_id: graph.nodes[node_id] for node_id in originals} == originals
    reloaded = CLIGraph()
    reloaded.load(path)
    assert reloaded.get_state() == graph.get_state()
    broadcast.assert_awaited_once_with()
    assert actions.call_count == 2


@pytest.mark.parametrize("connect", [None, {}])
def test_legacy_standalone_creation_is_explicitly_unconnected(connected_graph, connect):
    client, graph, _, broadcast, _ = connected_graph
    response = client.post(ROUTE, json={"definitionId": "text-input", "params": {}, "connect": connect})
    assert response.status_code == 200, response.text
    assert response.json() == {**graph.nodes["n4"], "connected": False, "edge": None}
    assert graph.edges == []
    broadcast.assert_awaited_once_with()


@pytest.mark.parametrize("changes", [
    {"source": "missing"},
    {"newNodeIs": "source", "target": "missing"},
    {"source": []},
    {"sourceHandle": "missing"},
    {"targetHandle": "missing"},
    {"targetHandle": "prompt"},  # Image cannot feed a Text input.
    {"sourceHandle": None},
    {"targetHandle": []},
    {"newNodeIs": "sideways"},
    {"newNodeIs": {}},
])
def test_invalid_connection_rejects_without_node_edge_counter_or_disk_changes(connected_graph, changes):
    client, graph, path, broadcast, actions = connected_graph
    before, bytes_before, counter_before = copy.deepcopy(graph.get_state()), path.read_bytes(), graph._counter
    body = copy.deepcopy(BODY)
    body["connect"].update(changes)
    response = client.post(ROUTE, json=body)
    assert response.status_code == 400, response.text
    assert_unchanged(graph, path, before, bytes_before, counter_before)
    broadcast.assert_not_awaited()
    actions.assert_not_called()


@pytest.mark.parametrize("connect", [[], "source", False])
def test_non_object_connect_is_rejected_even_when_falsy(connected_graph, connect):
    client, graph, path, broadcast, actions = connected_graph
    before, bytes_before, counter_before = copy.deepcopy(graph.get_state()), path.read_bytes(), graph._counter
    body = {**BODY, "connect": connect}
    response = client.post(ROUTE, json=body)
    assert response.status_code == 400, response.text
    assert_unchanged(graph, path, before, bytes_before, counter_before)
    broadcast.assert_not_awaited()
    actions.assert_not_called()


def test_connect_value_error_discards_even_partially_mutated_candidate(connected_graph, monkeypatch):
    client, graph, path, broadcast, actions = connected_graph
    before, bytes_before, counter_before = copy.deepcopy(graph.get_state()), path.read_bytes(), graph._counter
    real_connect = CLIGraph.connect

    def failed_connect(candidate, *args):
        real_connect(candidate, *args)
        raise ValueError("Synthetic connection failure after staging")

    monkeypatch.setattr(CLIGraph, "connect", failed_connect)
    response = client.post(ROUTE, json=BODY)
    assert response.status_code == 400, response.text
    assert "Synthetic connection failure" in response.json()["detail"]
    assert_unchanged(graph, path, before, bytes_before, counter_before)
    broadcast.assert_not_awaited()
    actions.assert_not_called()


def test_deleted_edge_does_not_reuse_an_existing_confirmed_edge_id(connected_graph):
    client, graph, path, _, _ = connected_graph
    graph.connect("n1", "image", "n2", "images")
    existing = copy.deepcopy(graph.connect("n3", "text", "n2", "prompt"))
    graph.edges = [graph.edges[1]]
    graph.save(path)
    response = client.post(ROUTE, json=BODY)
    assert response.status_code == 200, response.text
    assert response.json()["edge"]["id"] == "e3"
    assert graph.edges[0] == existing
    assert len({edge["id"] for edge in graph.edges}) == len(graph.edges)


def test_graph_persistence_error_keeps_live_graph_and_disk_unchanged(connected_graph, monkeypatch):
    client, graph, path, broadcast, actions = connected_graph
    before, bytes_before, counter_before = copy.deepcopy(graph.get_state()), path.read_bytes(), graph._counter
    monkeypatch.setattr(graph, "replace_with", Mock(side_effect=OSError("Synthetic disk failure")))
    response = client.post(ROUTE, json=BODY)
    assert response.status_code == 500, response.text
    assert_unchanged(graph, path, before, bytes_before, counter_before)
    broadcast.assert_not_awaited()
    actions.assert_not_called()
