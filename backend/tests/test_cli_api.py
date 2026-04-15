import pytest
from fastapi.testclient import TestClient

@pytest.fixture
def client():
    import sys
    from pathlib import Path
    sys.path.insert(0, str(Path(__file__).resolve().parent.parent))
    from main import app
    return TestClient(app)

@pytest.fixture(autouse=True)
def clear_graph(client):
    client.delete("/api/graph")
    yield
    client.delete("/api/graph")


class TestNodeEndpoints:
    def test_get_all_nodes(self, client):
        resp = client.get("/api/nodes")
        assert resp.status_code == 200
        data = resp.json()
        assert "nodes" in data
        assert len(data["nodes"]) > 0
        first = data["nodes"][0]
        assert "id" in first
        assert "displayName" in first
        assert "category" in first

    def test_get_all_nodes_has_categories(self, client):
        resp = client.get("/api/nodes")
        data = resp.json()
        assert "categories" in data
        assert len(data["categories"]) > 0

    def test_get_single_node(self, client):
        resp = client.get("/api/nodes/gpt-image-1-generate")
        assert resp.status_code == 200
        data = resp.json()
        assert data["id"] == "gpt-image-1-generate"
        assert "inputPorts" in data
        assert "outputPorts" in data
        assert "params" in data

    def test_get_unknown_node_404(self, client):
        resp = client.get("/api/nodes/nonexistent")
        assert resp.status_code == 404


class TestGraphEndpoints:
    def test_create_node(self, client):
        resp = client.post("/api/graph/node", json={
            "definitionId": "gpt-image-1-generate",
            "params": {"model": "gpt-image-1"},
        })
        assert resp.status_code == 200
        data = resp.json()
        assert data["id"] == "n1"
        assert data["definitionId"] == "gpt-image-1-generate"

    def test_create_multiple_nodes(self, client):
        r1 = client.post("/api/graph/node", json={"definitionId": "node-a", "params": {}})
        r2 = client.post("/api/graph/node", json={"definitionId": "node-b", "params": {}})
        assert r1.json()["id"] == "n1"
        assert r2.json()["id"] == "n2"

    def test_connect_nodes(self, client):
        client.post("/api/graph/node", json={"definitionId": "node-a", "params": {}})
        client.post("/api/graph/node", json={"definitionId": "node-b", "params": {}})
        resp = client.post("/api/graph/connect", json={
            "source": "n1", "sourceHandle": "image",
            "target": "n2", "targetHandle": "image",
        })
        assert resp.status_code == 200
        assert "n1:image" in resp.json()["connection"]

    def test_connect_unknown_node_400(self, client):
        client.post("/api/graph/node", json={"definitionId": "node-a", "params": {}})
        resp = client.post("/api/graph/connect", json={
            "source": "n1", "sourceHandle": "out",
            "target": "n99", "targetHandle": "in",
        })
        assert resp.status_code == 400

    def test_update_node_params(self, client):
        client.post("/api/graph/node", json={"definitionId": "node-a", "params": {"x": 1}})
        resp = client.put("/api/graph/node/n1", json={"params": {"x": 2, "y": 3}})
        assert resp.status_code == 200
        graph = client.get("/api/graph").json()
        n1 = next(n for n in graph["nodes"] if n["id"] == "n1")
        assert n1["params"]["x"] == 2
        assert n1["params"]["y"] == 3

    def test_update_unknown_node_404(self, client):
        resp = client.put("/api/graph/node/n99", json={"params": {"x": 1}})
        assert resp.status_code == 404

    def test_get_graph(self, client):
        client.post("/api/graph/node", json={"definitionId": "node-a", "params": {}})
        client.post("/api/graph/node", json={"definitionId": "node-b", "params": {}})
        client.post("/api/graph/connect", json={
            "source": "n1", "sourceHandle": "out",
            "target": "n2", "targetHandle": "in",
        })
        resp = client.get("/api/graph")
        assert resp.status_code == 200
        data = resp.json()
        assert len(data["nodes"]) == 2
        assert len(data["edges"]) == 1

    def test_clear_graph(self, client):
        client.post("/api/graph/node", json={"definitionId": "node-a", "params": {}})
        resp = client.delete("/api/graph")
        assert resp.status_code == 200
        graph = client.get("/api/graph").json()
        assert len(graph["nodes"]) == 0
