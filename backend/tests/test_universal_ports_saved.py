"""Saved universal nodes (OpenRouter, Nous Portal, Replicate) look and check
the same after the universal-ports change as they did before it.

`tests/fixtures/universal_ports_saved_before.json` was captured on untouched
main (23f11b8e) by running this file with NEBULA_CAPTURE_UNIVERSAL_BEFORE=1:
the canvas export (/api/graph/export) of real saved node shapes and the run
check (engine.validate_graph) of the same graph. A saved node carries only
its params (no `_model_ports`), so it must come back with exactly the ports,
wire types and run errors it had.
"""
from __future__ import annotations

import json
import os
from pathlib import Path

import pytest
from fastapi.testclient import TestClient

from services.cli_graph import CLIGraph
from services.project_store import ProjectStore, make_project
from tests.conftest import PERSON

FIXTURE = Path(__file__).parent / "fixtures" / "universal_ports_saved_before.json"

# The shapes cli_graph saves for these nodes. The canvas pushes a node's whole
# params after any edit, so a node picked in the Inspector keeps `_output_image`
# (OpenRouter, Nous) or `_version_id`/`_schema_fetched` and the schema's
# defaults (Replicate) next to its model.
SAVED_NODES: list[tuple[str, dict]] = [
    ("text-input", {"value": "Describe the picture"}),
    ("image-input", {"imagePath": "", "_previewUrl": ""}),
    ("openrouter-universal", {"model": "anthropic/claude-sonnet-4.5", "temperature": 1, "max_tokens": 4096,
                              "response_format": "text", "prompt_caching": False, "_output_image": False}),
    ("openrouter-universal", {"model": "google/gemini-2.5-flash-image", "temperature": 1, "max_tokens": 4096,
                              "response_format": "text", "prompt_caching": False, "_output_image": True}),
    ("openrouter-universal", {"model": "", "temperature": 1, "max_tokens": 4096,
                              "response_format": "text", "prompt_caching": False}),
    ("nous-portal-universal", {"model": "moonshotai/kimi-k2.6", "temperature": 1, "max_tokens": 4096,
                               "_output_image": False}),
    ("replicate-universal", {"model_id": "black-forest-labs/flux-kontext-pro", "_version_id": "v-kontext",
                             "_schema_fetched": True, "prompt": "make it dusk", "aspect_ratio": "match_input_image",
                             "output_format": "png", "safety_tolerance": 2}),
    ("replicate-universal", {"model_id": ""}),
]
# (source index, handle, target index, handle): the wires such a graph holds.
# Replicate declares no ports, so its file input was accepted by name.
SAVED_EDGES: list[tuple[int, str, int, str]] = [
    (0, "text", 2, "messages"),
    (0, "text", 3, "messages"),
    (0, "text", 5, "messages"),
    (1, "image", 5, "images"),
    (1, "image", 6, "input_image"),
    (2, "text", 6, "prompt"),
]


@pytest.fixture
def api(tmp_path, monkeypatch, person):
    import main as main_module

    graph = CLIGraph(persist_path=tmp_path / "state.json")
    store = ProjectStore(tmp_path / "projects")
    with store.transaction() as catalog:
        project = make_project("Active")
        catalog["projects"][project["id"]] = project
        catalog["activeProjectId"] = project["id"]
        store.commit(catalog)
    monkeypatch.setattr(main_module, "cli_graph", graph)
    monkeypatch.setattr(main_module, "project_store", store)

    async def ignore(_data):
        return None

    monkeypatch.setattr(main_module.manager, "broadcast_raw", ignore)
    monkeypatch.setattr(main_module.manager, "broadcast_browser", ignore)
    return TestClient(main_module.app), graph


def _saved_graph(graph: CLIGraph) -> list[str]:
    ids = [graph.add_node(definition_id, json.loads(json.dumps(params)), position={"x": 300.0 * i, "y": 0.0})
           for i, (definition_id, params) in enumerate(SAVED_NODES)]
    for source, source_handle, target, target_handle in SAVED_EDGES:
        graph.connect(ids[source], source_handle, ids[target], target_handle)
    return ids


def _observed(client: TestClient, graph: CLIGraph) -> dict:
    from execution.engine import validate_graph
    from models.graph import GraphEdge, GraphNode

    _saved_graph(graph)
    exported = client.get("/api/graph/export", headers=PERSON)
    assert exported.status_code == 200, exported.text
    body = exported.json()
    nodes = [{key: node[key] for key in ("id", "type", "data")} for node in body["nodes"]]
    for node in nodes:
        node["data"].pop("keyStatus", None)
    graph_nodes, graph_edges = graph.to_execute_format()
    errors = validate_graph([GraphNode.model_validate(n) for n in graph_nodes],
                            [GraphEdge.model_validate(e) for e in graph_edges],
                            {"OPENROUTER_API_KEY": "or-test", "REPLICATE_API_TOKEN": "r8-test"})
    return {
        "nodes": nodes,
        "edges": body["edges"],
        "runErrors": sorted([[e.node_id, e.port_id, e.message] for e in errors]),
    }


def test_saved_universal_nodes_export_and_check_as_before(api):
    client, graph = api
    observed = _observed(client, graph)
    if os.environ.get("NEBULA_CAPTURE_UNIVERSAL_BEFORE") == "1":
        FIXTURE.write_text(json.dumps(observed, indent=1, sort_keys=True) + "\n")
    assert observed == json.loads(FIXTURE.read_text())
