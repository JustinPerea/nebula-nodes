"""A run's params go back to the canvas only when the definition declares them.

Many fal handlers route by writing ``endpoint_id`` into ``node.params``. The
run then mirrored it onto the canvas node, and every later project autosave
failed with "Unknown param(s) for flux-fill-inpaint: ['endpoint_id']", so the
top bar stuck on "Save failed · Retry" after any FLUX Fill run (found in the
Jev tournament demo's dry run).
"""
from __future__ import annotations

import sys
from pathlib import Path
from typing import Any
from unittest.mock import AsyncMock

import pytest
from fastapi.testclient import TestClient
from PIL import Image

sys.path.insert(0, str(Path(__file__).resolve().parent.parent))
import main as main_module
from execution.engine import execute_graph
from execution.sync_runner import get_handler_registry
from models.graph import GraphEdge, GraphNode
from services.cli_graph import CLIGraph
from services.project_store import ProjectStore


@pytest.fixture
def graph(tmp_path, monkeypatch) -> CLIGraph:
    cli = CLIGraph(persist_path=tmp_path / "state.json")
    monkeypatch.setattr(main_module, "cli_graph", cli)
    monkeypatch.setattr(main_module, "project_store", ProjectStore(tmp_path / "projects"))
    monkeypatch.setattr(main_module.manager, "broadcast_raw", AsyncMock())
    return cli


def test_undeclared_keys_a_handler_adds_stay_off_the_canvas(graph) -> None:
    node_id = graph.add_node("flux-fill-inpaint", {"num_images": 1})
    node = GraphNode(id=node_id, definitionId="flux-fill-inpaint", params={
        "num_images": 2,  # declared: syncs
        "_previewUrl": "/api/outputs/x.png",  # canvas state: syncs
        "endpoint_id": "fal-ai/flux-pro/v1/fill",  # a handler's routing key: doesn't
    }, outputs={})

    assert main_module._sync_params_to_cli_graph([node]) is True
    assert graph.nodes[node_id]["params"] == {"num_images": 2, "_previewUrl": "/api/outputs/x.png"}


def test_a_leaked_key_on_the_canvas_is_dropped_by_the_next_run(graph) -> None:
    node_id = graph.add_node("flux-fill-inpaint", {"num_images": 1})
    graph.nodes[node_id]["params"]["endpoint_id"] = "fal-ai/flux-pro/v1/fill"  # left by an older build
    node = GraphNode(id=node_id, definitionId="flux-fill-inpaint",
                     params=dict(graph.nodes[node_id]["params"]), outputs={})

    assert main_module._sync_params_to_cli_graph([node]) is True
    assert graph.nodes[node_id]["params"] == {"num_images": 1}


def test_universal_nodes_still_sync_every_key(graph) -> None:
    node_id = graph.add_node("fal-universal", {"endpoint_id": "fal-ai/flux/dev"})
    node = GraphNode(id=node_id, definitionId="fal-universal",
                     params={"endpoint_id": "fal-ai/flux/dev", "guidance_scale": 4}, outputs={})

    main_module._sync_params_to_cli_graph([node])
    assert graph.nodes[node_id]["params"] == {"endpoint_id": "fal-ai/flux/dev", "guidance_scale": 4}


@pytest.mark.asyncio
async def test_a_flux_fill_run_still_autosaves(graph, tmp_path, monkeypatch) -> None:
    """The real FLUX Fill handler, fal mocked: run, mirror params, then save the project."""
    image, mask = tmp_path / "image.png", tmp_path / "mask.png"
    Image.new("RGB", (64, 64), "grey").save(image)
    Image.new("L", (64, 64), 0).save(mask)
    sent: dict[str, Any] = {}

    async def fal(node, inputs, api_keys, emit=None):
        sent.update(node.params)
        return {"image": {"type": "Image", "value": str(image)}}

    import handlers.fal_universal as fal_universal
    monkeypatch.setattr(fal_universal, "handle_fal_universal", fal)

    ids = {
        "prompt": graph.add_node("text-input", {"value": "a crystal cup"}),
        "image": graph.add_node("image-input", {"filePath": str(image)}),
        "mask": graph.add_node("image-input", {"filePath": str(mask)}),
        "fill": graph.add_node("flux-fill-inpaint", {"num_images": 1, "output_format": "png"}),
    }
    nodes = [GraphNode(id=nid, definitionId=graph.nodes[nid]["definitionId"],
                       params=dict(graph.nodes[nid]["params"]), outputs={}) for nid in ids.values()]
    edges = [
        GraphEdge(id="e1", source=ids["prompt"], sourceHandle="text", target=ids["fill"], targetHandle="prompt"),
        GraphEdge(id="e2", source=ids["image"], sourceHandle="image", target=ids["fill"], targetHandle="image"),
        GraphEdge(id="e3", source=ids["mask"], sourceHandle="image", target=ids["fill"], targetHandle="mask"),
    ]

    async def emit(event: Any) -> None:
        pass

    await execute_graph(nodes, edges, {"FAL_KEY": "test"}, get_handler_registry(emit), emit)
    assert sent["endpoint_id"] == "fal-ai/flux-pro/v1/fill"  # the handler still routes

    main_module._sync_params_to_cli_graph(nodes)
    assert "endpoint_id" not in graph.nodes[ids["fill"]]["params"]

    # What the canvas autosaves: the mirrored params (creating a project resets the canvas).
    canvas = {nid: dict(graph.nodes[nid]) for nid in ids.values()}
    client = TestClient(main_module.app)
    created = client.post("/api/projects", json={"name": "Fill"}).json()
    snapshot = {
        "nodes": [{"id": nid, "type": "model-node", "position": {"x": 0, "y": 0},
                   "data": {"definitionId": canvas[nid]["definitionId"], "label": key,
                            "params": canvas[nid]["params"], "outputs": {}}}
                  for key, nid in ids.items()],
        "edges": [edge.model_dump(by_alias=True) for edge in edges],
        "viewport": {"x": 0, "y": 0, "zoom": 1},
    }
    response = client.put(f"/api/projects/{created['project']['id']}",
                          json={"snapshot": snapshot, "workspaceRevision": created["workspaceRevision"]})
    assert response.status_code == 200, response.text
