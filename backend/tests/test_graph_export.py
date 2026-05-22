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


class TestGraphExportNodeTypes:
    def test_remotion_node_exports_as_remotionNode_type(self, client):
        """graph/export must resolve remotion-node definitionId to type=='remotionNode'.

        Regression guard: before the resolver branch was added, remotion-node
        fell through to 'model-node', which rendered the wrong React card and
        hid the manifest editor UI.
        """
        client.post("/api/graph/node", json={
            "definitionId": "remotion-node",
            "params": {},
        })

        resp = client.get("/api/graph/export")
        assert resp.status_code == 200
        nodes = resp.json()["nodes"]
        assert len(nodes) == 1
        assert nodes[0]["type"] == "remotionNode"
        assert nodes[0]["data"]["definitionId"] == "remotion-node"
