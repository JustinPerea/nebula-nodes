import sys
from pathlib import Path

import pytest
from fastapi.testclient import TestClient

sys.path.insert(0, str(Path(__file__).resolve().parent.parent))
from main import app, cli_graph  # noqa: E402
from execution import engine
from services import output as output_mod


@pytest.fixture(autouse=True)
def clear_graph():
    cli_graph.clear()
    yield
    cli_graph.clear()


def test_image_input_resolves_api_outputs_url(tmp_path, monkeypatch):
    # An image-input whose filePath is a served /api/outputs URL must resolve to
    # the absolute on-disk path in the node's Image output.
    monkeypatch.setattr(output_mod, "OUTPUT_ROOT", tmp_path)
    f = tmp_path / "run1" / "img.png"
    f.parent.mkdir(parents=True)
    f.write_bytes(b"\x89PNG\r\n\x1a\n")
    out = engine._image_input_output({"filePath": "/api/outputs/run1/img.png"})
    assert out["image"]["value"] == str(f.resolve())


def test_cluster_route_adds_nodes_additively_and_returns_idmap():
    cli_graph.add_node("text-input", {"value": "preexisting"})  # n1 stays
    client = TestClient(app)
    body = {
        "nodes": [
            {"tempId": "t-text", "definitionId": "text-input", "params": {"value": "a cat"}},
            {"tempId": "t-model", "definitionId": "nano-banana", "params": {"aspect_ratio": "16:9"}},
        ],
        "edges": [
            {"source": "t-text", "sourceHandle": "text", "target": "t-model", "targetHandle": "prompt"},
        ],
    }
    resp = client.post("/api/graph/cluster", json=body)
    assert resp.status_code == 200
    data = resp.json()
    assert set(data["idMap"].keys()) == {"t-text", "t-model"}
    new_ids = set(data["idMap"].values())
    assert len(new_ids) == 2 and "n1" not in new_ids  # n1 was preexisting
    # returned nodes are React Flow shape with data.definitionId
    returned_defs = {n["id"]: n["data"]["definitionId"] for n in data["nodes"]}
    assert returned_defs[data["idMap"]["t-model"]] == "nano-banana"
    # an edge connects the two new nodes
    assert any(e["source"] == data["idMap"]["t-text"] and e["target"] == data["idMap"]["t-model"]
               for e in data["edges"])
    # cli_graph still holds the preexisting node + the 2 new ones (additive)
    assert len(cli_graph.nodes) == 3


def test_cluster_route_normalizes_image_input():
    client = TestClient(app)
    body = {
        "nodes": [{"tempId": "t-img", "definitionId": "image-input",
                   "params": {"filePath": "/api/outputs/run1/x.png"}}],
        "edges": [],
    }
    resp = client.post("/api/graph/cluster", json=body)
    assert resp.status_code == 200
    new_id = resp.json()["idMap"]["t-img"]
    # _normalize_image_input_params ran (filePath rewritten away from the URL form)
    assert cli_graph.nodes[new_id]["params"]["filePath"] != "/api/outputs/run1/x.png"
