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

    def test_family_name_404_suggests_prefix_matches(self, client):
        """Asking for a family name like 'gpt-image-2' (which isn't a real
        definition id but is the natural way to reach for the family) should
        return 404 with a 'Did you mean:' list of the actual variants.

        This removes a friction point Daedalus hit in live dogfood — he ran
        `nebula info gpt-image-2`, got a hard "not found", then had to
        `nebula nodes | grep gpt` to discover the real ids. One round-trip
        instead of three.
        """
        resp = client.get("/api/nodes/gpt-image-2")
        assert resp.status_code == 404
        detail = resp.json()["detail"]
        assert "gpt-image-2" in detail
        assert "Did you mean" in detail
        # All four gpt-image-2 variants should be listed.
        assert "gpt-image-2-generate" in detail
        assert "gpt-image-2-edit" in detail
        assert "gpt-image-2-fal-generate" in detail
        assert "gpt-image-2-fal-edit" in detail

    def test_family_name_404_suggests_single_variant(self, client):
        """Family with one variant (e.g. 'veo' → 'veo-3') still gets a
        suggestion — user learns the real id without a second lookup."""
        resp = client.get("/api/nodes/veo")
        assert resp.status_code == 404
        detail = resp.json()["detail"]
        assert "Did you mean" in detail
        assert "veo-3" in detail

    def test_typo_404_falls_back_to_close_matches(self, client):
        """When the query doesn't prefix-match anything, fall back to
        difflib close matches so typos still get useful suggestions."""
        resp = client.get("/api/nodes/meshy-animat")  # missing final 'e'
        assert resp.status_code == 404
        detail = resp.json()["detail"]
        assert "Did you mean" in detail
        assert "meshy-animate" in detail

    def test_totally_unknown_node_404_plain_message(self, client):
        """When nothing matches at all, keep the terse original message —
        don't pad the 404 with an empty 'Did you mean:' block."""
        resp = client.get("/api/nodes/xyzzy-quux-nothing")
        assert resp.status_code == 404
        detail = resp.json()["detail"]
        assert "xyzzy-quux-nothing" in detail
        assert "not found" in detail
        assert "Did you mean" not in detail


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

    def test_connect_invalid_source_handle_400(self, client):
        """Real definitions: reject connect calls whose sourceHandle isn't in
        the source node's outputPorts. Prevents the React Flow render-storm
        bug where invalid edges warn on every re-render and freeze the panel.

        text-input's only output port is "text"; "value" is a param KEY, not
        an output. An agent that wires `n1:value -> n2:prompt` should get 400
        with a message listing the valid port ids."""
        client.post("/api/graph/node", json={"definitionId": "text-input", "params": {}})
        client.post("/api/graph/node", json={"definitionId": "gpt-image-2-generate", "params": {}})
        resp = client.post("/api/graph/connect", json={
            "source": "n1", "sourceHandle": "value",
            "target": "n2", "targetHandle": "prompt",
        })
        assert resp.status_code == 400
        msg = resp.json()["detail"]
        assert "value" in msg
        assert "outputPorts" in msg
        # Valid ports should be listed so the agent can retry.
        assert "text" in msg

    def test_connect_invalid_target_handle_400(self, client):
        """Same check for the target side — targetHandle must exist in the
        target node's inputPorts."""
        client.post("/api/graph/node", json={"definitionId": "text-input", "params": {}})
        client.post("/api/graph/node", json={"definitionId": "gpt-image-2-generate", "params": {}})
        resp = client.post("/api/graph/connect", json={
            "source": "n1", "sourceHandle": "text",
            "target": "n2", "targetHandle": "nonexistent_port",
        })
        assert resp.status_code == 400
        assert "nonexistent_port" in resp.json()["detail"]
        assert "inputPorts" in resp.json()["detail"]

    def test_connect_valid_real_handles_200(self, client):
        """Happy path with real definitions: text-input:text → gpt-image-2:prompt."""
        client.post("/api/graph/node", json={"definitionId": "text-input", "params": {}})
        client.post("/api/graph/node", json={"definitionId": "gpt-image-2-generate", "params": {}})
        resp = client.post("/api/graph/connect", json={
            "source": "n1", "sourceHandle": "text",
            "target": "n2", "targetHandle": "prompt",
        })
        assert resp.status_code == 200

    def test_node_and_connect_invalid_handle_rolls_back_new_node(self, client):
        """node-and-connect creates the new node FIRST, then connects. If the
        handle is invalid, the new node should NOT survive — otherwise the
        endpoint leaves a dangling node the caller didn't ask for standalone."""
        # Create an anchor node to connect TO.
        client.post("/api/graph/node", json={"definitionId": "gpt-image-2-generate", "params": {}})
        # Try to add a text-input and wire its (nonexistent) "value" port.
        resp = client.post("/api/graph/node-and-connect", json={
            "definitionId": "text-input",
            "params": {},
            "connect": {
                "source": "",  # filled in as newNodeIs=source
                "sourceHandle": "value",  # INVALID — text-input has no "value" output
                "target": "n1",
                "targetHandle": "prompt",
                "newNodeIs": "source",
            },
        })
        assert resp.status_code == 400
        # Graph should still only have the anchor node — the new text-input
        # must have been rolled back.
        graph = client.get("/api/graph").json()
        defs = [n["definitionId"] for n in graph["nodes"]]
        assert "text-input" not in defs
        assert "gpt-image-2-generate" in defs
        assert len(graph["nodes"]) == 1

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


class TestParamCoercion:
    """CLI sends every --param k=v as a string; coerce to declared types.

    Regression test for a real bug: Meshy rejected graphs because
    should_remesh="true" arrived at the provider API instead of
    should_remesh=True.
    """

    def test_string_true_coerces_to_bool(self, client):
        resp = client.post("/api/graph/node", json={
            "definitionId": "meshy-multi-image-to-3d",
            "params": {"should_remesh": "true", "should_texture": "false"},
        })
        assert resp.status_code == 200
        node = resp.json()
        assert node["params"]["should_remesh"] is True
        assert node["params"]["should_texture"] is False

    def test_string_integer_coerces_to_int(self, client):
        resp = client.post("/api/graph/node", json={
            "definitionId": "meshy-multi-image-to-3d",
            "params": {"target_polycount": "30000"},
        })
        assert resp.status_code == 200
        assert resp.json()["params"]["target_polycount"] == 30000
        assert isinstance(resp.json()["params"]["target_polycount"], int)

    def test_enum_and_string_pass_through(self, client):
        resp = client.post("/api/graph/node", json={
            "definitionId": "meshy-multi-image-to-3d",
            "params": {"pose_mode": "t-pose", "topology": "quad"},
        })
        assert resp.status_code == 200
        assert resp.json()["params"]["pose_mode"] == "t-pose"

    def test_native_bool_passes_through(self, client):
        """Frontend Inspector sends typed values; don't mangle them."""
        resp = client.post("/api/graph/node", json={
            "definitionId": "meshy-multi-image-to-3d",
            "params": {"should_remesh": True, "target_polycount": 50000},
        })
        assert resp.status_code == 200
        node = resp.json()
        assert node["params"]["should_remesh"] is True
        assert node["params"]["target_polycount"] == 50000

    def test_invalid_bool_returns_400(self, client):
        resp = client.post("/api/graph/node", json={
            "definitionId": "meshy-multi-image-to-3d",
            "params": {"should_remesh": "maybe"},
        })
        assert resp.status_code == 400
        assert "should_remesh" in resp.json()["detail"]

    def test_update_coerces_params(self, client):
        client.post("/api/graph/node", json={
            "definitionId": "meshy-multi-image-to-3d",
            "params": {},
        })
        resp = client.put("/api/graph/node/n1", json={
            "params": {"should_remesh": "true", "target_polycount": "45000"},
        })
        assert resp.status_code == 200
        node = resp.json()
        assert node["params"]["should_remesh"] is True
        assert node["params"]["target_polycount"] == 45000


class TestRunGraphIterationGuard:
    """SKILL.md §1.5 says Daedalus must ADD a new node to iterate, never re-run
    an existing populated one in place. We enforce this at the backend so a
    §1.5 violation fails loudly instead of silently clobbering iteration
    history. The guard is gated on the X-Daedalus-Caller header so a human
    clicking Run in the frontend (or any other API consumer) is unaffected."""

    DAEDALUS_HEADERS = {"X-Daedalus-Caller": "1"}

    def _make_and_populate(self, client, node_id: str = "n1"):
        """Create a node and fake an execution result so outputs look 'populated'."""
        client.post("/api/graph/node", json={"definitionId": "text-input", "params": {}})
        import sys
        from pathlib import Path
        sys.path.insert(0, str(Path(__file__).resolve().parent.parent))
        from main import cli_graph
        cli_graph.nodes[node_id]["outputs"] = {"text": {"type": "String", "value": "stale"}}

    def test_run_on_populated_node_blocked_for_daedalus(self, client):
        """Daedalus-called /api/graph/run targeting a node that already has
        outputs gets 400 with the §1.5 reminder — forces him to ADD a new
        node instead of clobbering iteration history."""
        self._make_and_populate(client, "n1")
        resp = client.post(
            "/api/graph/run",
            json={"targetNodeId": "n1"},
            headers=self.DAEDALUS_HEADERS,
        )
        assert resp.status_code == 400
        detail = resp.json()["detail"]
        assert "n1" in detail
        assert "1.5" in detail or "add a new node" in detail.lower()

    def test_run_on_empty_node_allowed_for_daedalus(self, client):
        """Running a node that has no outputs yet is fine — that's the normal
        first execution path."""
        client.post("/api/graph/node", json={"definitionId": "text-input", "params": {}})
        resp = client.post(
            "/api/graph/run",
            json={"targetNodeId": "n1"},
            headers=self.DAEDALUS_HEADERS,
        )
        # 200 on execution; guard isn't triggered because outputs are empty
        assert resp.status_code == 200

    def test_run_on_populated_node_allowed_for_human(self, client):
        """Without the X-Daedalus-Caller header (frontend user, curl, etc.),
        the guard doesn't fire — people can re-run a node in place if they
        want to."""
        self._make_and_populate(client, "n1")
        resp = client.post(
            "/api/graph/run",
            json={"targetNodeId": "n1"},
            # no headers — human caller
        )
        # 200 on execution; no guard
        assert resp.status_code == 200

    def test_run_whole_graph_allowed_for_daedalus(self, client):
        """Guard only fires when Daedalus targets a specific populated node.
        A whole-graph run (no targetNodeId) is always allowed — that's the
        batch-execution path."""
        self._make_and_populate(client, "n1")
        resp = client.post(
            "/api/graph/run",
            json={},  # no targetNodeId
            headers=self.DAEDALUS_HEADERS,
        )
        assert resp.status_code == 200


class TestChatAgentDispatch:
    """WebSocket /ws/chat accepts an 'agent' field and routes to the right runner."""

    def test_dispatch_registers_both_agents(self):
        """The dispatch table exposes both claude and daedalus."""
        import sys
        from pathlib import Path
        sys.path.insert(0, str(Path(__file__).resolve().parent.parent))
        from services.chat_session import AGENT_RUNNERS
        assert "claude" in AGENT_RUNNERS
        assert "daedalus" in AGENT_RUNNERS

    def test_unknown_agent_returns_error_event(self, client):
        """Sending a send payload with an unknown agent surfaces an error + done."""
        with client.websocket_connect("/ws/chat") as ws:
            ws.send_json({
                "type": "send",
                "message": "hi",
                "sessionId": None,
                "model": "claude-sonnet-4-6",
                "agent": "bogus",
                "autonomy": "auto",
            })
            first = ws.receive_json()
            assert first["type"] == "error"
            assert "bogus" in first["message"]
            assert "Valid:" in first["message"]

            second = ws.receive_json()
            assert second["type"] == "done"
