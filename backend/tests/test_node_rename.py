"""Custom node names live in the backend graph, so they survive graphSync,
project restore and graph-file import."""
import sys
from pathlib import Path
from unittest.mock import AsyncMock

import pytest
from fastapi.testclient import TestClient

sys.path.insert(0, str(Path(__file__).resolve().parent.parent))
import main as main_module  # noqa: E402
from main import app  # noqa: E402
from services.cli_graph import CLIGraph  # noqa: E402


@pytest.fixture(autouse=True)
def fresh_graph(monkeypatch):
    main_module.cli_graph = CLIGraph()
    monkeypatch.setattr(main_module.manager, "broadcast_raw", AsyncMock())
    yield
    main_module.cli_graph = CLIGraph()


def test_rename_is_stored_broadcast_and_clearable(monkeypatch):
    main_module.cli_graph.add_node("text-input", {"value": "hello"})
    client = TestClient(app)

    renamed = client.put("/api/graph/node/n1/label", json={"label": "  Hero   prompt "})
    assert renamed.status_code == 200
    assert renamed.json() == {"id": "n1", "label": "Hero prompt"}
    assert main_module.cli_graph.nodes["n1"]["label"] == "Hero prompt"
    sync = main_module.manager.broadcast_raw.await_args.args[0]
    assert sync["type"] == "graphSync"
    assert next(node for node in sync["nodes"] if node["id"] == "n1")["data"]["label"] == "Hero prompt"

    # Renaming to the same name again is a no-op for the journal.
    journal = []
    monkeypatch.setattr(main_module, "_journal", lambda kind, **kw: journal.append((kind, kw)))
    client.put("/api/graph/node/n1/label", json={"label": "Hero prompt"})
    assert journal == []
    client.put("/api/graph/node/n1/label", json={"label": "Wide prompt"})
    assert journal[0][0] == "node.renamed"
    assert journal[0][1]["data"] == {"from": "Hero prompt", "to": "Wide prompt"}

    # Blank goes back to the model's own name, and isn't stored.
    cleared = client.put("/api/graph/node/n1/label", json={"label": "   "})
    assert cleared.status_code == 200
    assert "label" not in main_module.cli_graph.nodes["n1"]
    display = main_module.node_registry.get("text-input")["displayName"]
    assert cleared.json()["label"] == display


def test_rename_rejects_unknown_nodes_and_non_strings():
    client = TestClient(app)
    assert client.put("/api/graph/node/n9/label", json={"label": "x"}).status_code == 404
    main_module.cli_graph.add_node("text-input", {})
    assert client.put("/api/graph/node/n1/label", json={"label": 3}).status_code == 400


def test_rename_caps_length():
    main_module.cli_graph.add_node("text-input", {})
    response = TestClient(app).put("/api/graph/node/n1/label", json={"label": "x" * 200})
    assert len(response.json()["label"]) == main_module.MAX_NODE_LABEL_LENGTH


def test_graph_file_import_keeps_custom_names_only():
    display = main_module.node_registry.get("text-input")["displayName"]
    response = TestClient(app).post("/api/graph/import", json={
        "nodes": [
            {"id": "a", "definitionId": "text-input", "params": {}, "label": "Brief"},
            {"id": "b", "definitionId": "text-input", "params": {}, "label": display},
        ],
        "edges": [],
    })
    assert response.status_code == 200
    labels = {node["label"] if "label" in node else None for node in main_module.cli_graph.nodes.values()}
    assert labels == {"Brief", None}
