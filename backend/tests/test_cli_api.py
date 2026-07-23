from pathlib import Path

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

    def test_export_nous_portal_as_dynamic_node(self, client):
        client.post("/api/graph/node", json={
            "definitionId": "nous-portal-universal",
            "params": {"model": "moonshotai/kimi-k2.6"},
        })

        resp = client.get("/api/graph/export")
        assert resp.status_code == 200
        node = resp.json()["nodes"][0]
        assert node["type"] == "dynamic-node"
        assert node["data"]["isDynamic"] is True
        assert node["data"]["providerType"] == "nous"
        assert node["data"]["modelId"] == "moonshotai/kimi-k2.6"
        assert any(p["id"] == "images" and p["multiple"] is True for p in node["data"]["dynamicInputPorts"])

    def test_run_syncs_handler_mutated_params_to_cli_graph(self, client, tmp_path, monkeypatch):
        """After /api/graph/run, handler-mutated node.params should be mirrored
        back to cli_graph and visible via /api/graph/export. Regression for the
        Phase F bug where Pydantic deep-copied params into GraphNode and lost
        the video-edit handler's seeded clips + probed sourceDuration after
        execution, leaving the editor stuck in the 0-clips state forever.
        """
        from unittest.mock import AsyncMock, patch

        src = tmp_path / "src.mp4"
        src.write_bytes(b"fake")
        monkeypatch.setattr("handlers.video_edit.OUTPUT_ROOT", tmp_path)

        client.post("/api/graph/node", json={
            "definitionId": "video-input",
            "params": {"filePath": str(src)},
        })
        client.post("/api/graph/node", json={
            "definitionId": "video-edit",
            "params": {},
        })
        client.post("/api/graph/connect", json={
            "source": "n1", "sourceHandle": "video",
            "target": "n2", "targetHandle": "video_in",
        })

        probe_result = type("PR", (), {"duration": 7.0, "fps": 24.0, "is_vfr": False})()

        with (
            patch("handlers.video_edit.ffprobe_video", AsyncMock(return_value=probe_result)),
            patch("handlers.video_edit.run_ffmpeg", AsyncMock()),
        ):
            run_resp = client.post("/api/graph/run", json={"targetNodeId": "n2"})
        assert run_resp.status_code == 200

        export = client.get("/api/graph/export").json()
        n2 = next(n for n in export["nodes"] if n["id"] == "n2")
        # Handler seeded a full-span clip and probed metadata — both must
        # now be visible to the frontend via export, not stuck on the
        # in-memory GraphNode that was discarded post-run.
        assert n2["data"]["params"]["sourceDuration"] == 7.0
        assert n2["data"]["params"]["sourceFps"] == 24.0
        clips = n2["data"]["params"]["clips"]
        assert len(clips) == 1
        assert clips[0]["sourceIn"] == 0.0
        assert clips[0]["sourceOut"] == 7.0

    def test_export_video_edit_as_editNode_type(self, client):
        """Frontend renders the custom EditNode card only when type=='editNode'.
        Regression for Phase F smoke: CLI-imported video-edit nodes used to
        fall through to the generic model-node renderer, hiding the trim/cut/
        speed/volume summary that's the headline portfolio moment.
        """
        client.post("/api/graph/node", json={
            "definitionId": "video-edit",
            "params": {},
        })

        resp = client.get("/api/graph/export")
        assert resp.status_code == 200
        node = resp.json()["nodes"][0]
        assert node["type"] == "editNode"
        assert node["data"]["definitionId"] == "video-edit"

    def test_export_remotion_node_as_remotionNode_type(self, client):
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
        node = resp.json()["nodes"][0]
        assert node["type"] == "remotionNode"
        assert node["data"]["definitionId"] == "remotion-node"

    def test_video_edit_runtime_params_persist(self, client):
        """The dedicated editor's hidden clip state must survive graph reloads."""
        params = {
            "clips": [{
                "id": "c1",
                "start": 0,
                "duration": 3.0,
                "sourceIn": 0,
                "sourceOut": 3.0,
                "volume": 1,
                "mute": False,
            }],
            "sourceDuration": 3.0,
            "sourceFps": 24.0,
            "sourceIsVfr": False,
        }
        create = client.post(
            "/api/graph/node",
            json={"definitionId": "video-edit", "params": params},
        )
        assert create.status_code == 200, create.text

        update = client.put(
            "/api/graph/node/n1",
            json={"params": {**params, "sourceDuration": 4.0}},
        )
        assert update.status_code == 200, update.text

        exported = client.get("/api/graph/export").json()["nodes"][0]
        assert exported["data"]["params"]["clips"] == params["clips"]
        assert exported["data"]["params"]["sourceDuration"] == 4.0

    def test_remotion_manifest_persists(self, client):
        """The exact structured manifest must be accepted by create and update."""
        manifest = {
            "graph": {"nodes": [], "edges": []},
            "timeline": [{
                "id": "title",
                "sourceNodeId": "text-source",
                "componentType": "Text",
                "time": {"startFrame": 0, "durationInFrames": 60},
                "spatial": {
                    "x": 0,
                    "y": 0,
                    "z": 0,
                    "scale": [1, 1, 1],
                    "rotation": [0, 0, 0],
                },
                "keyframes": {},
                "props": {"text": "Nebula export"},
            }],
        }
        create = client.post(
            "/api/graph/node",
            json={"definitionId": "remotion-node", "params": {"manifest": manifest}},
        )
        assert create.status_code == 200, create.text

        updated_manifest = {**manifest, "timeline": []}
        update = client.put(
            "/api/graph/node/n1",
            json={"params": {"manifest": updated_manifest}},
        )
        assert update.status_code == 200, update.text

        exported = client.get("/api/graph/export").json()["nodes"][0]
        assert exported["data"]["params"]["manifest"] == updated_manifest

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


class TestSetParamsIterationGuard:
    """SKILL.md §1.5 also forbids `nebula set` as an iteration mechanism: once
    a node has outputs, mutating its params clobbers the craft log just as
    surely as re-running the same node would. Without this guard, Daedalus
    could route around the run-target guard via `set` + a follow-up
    `run-all` (cache-bypassed because params changed). Same X-Daedalus-Caller
    gate as the run guard so humans can still tweak params freely."""

    DAEDALUS_HEADERS = {"X-Daedalus-Caller": "1"}

    def _make_and_populate(self, client, node_id: str = "n1"):
        # Mirrors the existing test_update_coerces_params shape (line 294)
        # so we know the PUT body is valid and won't 400 on schema grounds.
        client.post("/api/graph/node", json={
            "definitionId": "meshy-multi-image-to-3d", "params": {}
        })
        import sys
        from pathlib import Path
        sys.path.insert(0, str(Path(__file__).resolve().parent.parent))
        from main import cli_graph
        cli_graph.nodes[node_id]["outputs"] = {"mesh": {"type": "Any", "value": "stale"}}

    def test_set_on_populated_node_blocked_for_daedalus(self, client):
        """Daedalus PUT /api/graph/node/n1 with new params, where n1 already
        has outputs → 400 with the §1.5 reminder. Forces him to ADD a new
        node instead of mutating the existing one."""
        self._make_and_populate(client, "n1")
        resp = client.put(
            "/api/graph/node/n1",
            json={"params": {"target_polycount": 60000}},
            headers=self.DAEDALUS_HEADERS,
        )
        assert resp.status_code == 400
        detail = resp.json()["detail"]
        assert "n1" in detail
        assert "1.5" in detail or "add a new node" in detail.lower()

    def test_set_on_empty_node_allowed_for_daedalus(self, client):
        """Pre-first-run config is the normal path — Daedalus creates a node
        and dials params before executing it. Outputs are still empty here."""
        client.post("/api/graph/node", json={
            "definitionId": "meshy-multi-image-to-3d", "params": {}
        })
        resp = client.put(
            "/api/graph/node/n1",
            json={"params": {"target_polycount": 50000}},
            headers=self.DAEDALUS_HEADERS,
        )
        assert resp.status_code == 200

    def test_set_on_populated_node_allowed_for_human(self, client):
        """Human users (frontend Inspector edits, curl, etc.) keep the freedom
        to retune in place. Guard only disciplines Daedalus."""
        self._make_and_populate(client, "n1")
        resp = client.put(
            "/api/graph/node/n1",
            json={"params": {"target_polycount": 60000}},
            # no X-Daedalus-Caller header
        )
        assert resp.status_code == 200


class TestOutputsRestore:
    """POST /api/outputs/restore accepts a zip bundle exported by the frontend
    Save action, extracts assets to a fresh output/<timestamp>/restored-<id>/
    dir, and returns a mapping so the frontend can rewrite URLs in the loaded
    graph JSON. The whole point: a .nebula.zip is portable — open it on any
    machine and the images come back."""

    def _make_zip(self, files: dict[str, bytes]) -> bytes:
        import io, zipfile
        buf = io.BytesIO()
        with zipfile.ZipFile(buf, "w", zipfile.ZIP_DEFLATED) as zf:
            for name, data in files.items():
                zf.writestr(name, data)
        return buf.getvalue()

    def test_restore_writes_files_and_returns_mapping(self, client):
        """Upload a zip with two asset files, confirm both are extracted and
        the mapping points at URLs the frontend can use verbatim."""
        zip_bytes = self._make_zip({
            "assets/2026-04-24_22-10-51/n20_final.png": b"\x89PNG\r\n\x1a\nFAKE",
            "assets/2026-04-24_22-11-02/n21_final.png": b"\x89PNG\r\n\x1a\nFAKE2",
        })
        resp = client.post(
            "/api/outputs/restore",
            content=zip_bytes,
            headers={"content-type": "application/zip"},
        )
        assert resp.status_code == 200
        data = resp.json()
        assert "urlMapping" in data
        mapping = data["urlMapping"]
        # Each original asset path maps to a new served URL
        assert "2026-04-24_22-10-51/n20_final.png" in mapping
        assert "2026-04-24_22-11-02/n21_final.png" in mapping
        # URLs are under /api/outputs/ so the frontend can use them directly
        for new_url in mapping.values():
            assert new_url.startswith("/api/outputs/")

    def test_restore_files_are_actually_served(self, client, tmp_path):
        """End-to-end: after restore, GET the returned URL returns the bytes."""
        original_bytes = b"\x89PNG\r\n\x1a\nRESTORED_PIXEL_DATA"
        zip_bytes = self._make_zip({
            "assets/demo/sample.png": original_bytes,
        })
        resp = client.post(
            "/api/outputs/restore",
            content=zip_bytes,
            headers={"content-type": "application/zip"},
        )
        assert resp.status_code == 200
        new_url = resp.json()["urlMapping"]["demo/sample.png"]
        # Fetch via the served URL — should return original bytes unchanged
        fetch = client.get(new_url)
        assert fetch.status_code == 200
        assert fetch.content == original_bytes

    def test_restore_rejects_non_zip_body(self, client):
        resp = client.post(
            "/api/outputs/restore",
            content=b"not a zip",
            headers={"content-type": "application/zip"},
        )
        assert resp.status_code == 400

    def test_restore_rejects_path_traversal(self, client):
        """A zip with ../ in its paths must not escape OUTPUT_ROOT."""
        zip_bytes = self._make_zip({
            "assets/../../escape.png": b"evil",
            "../escape2.png": b"evil",
        })
        resp = client.post(
            "/api/outputs/restore",
            content=zip_bytes,
            headers={"content-type": "application/zip"},
        )
        # Either reject outright (400) or quietly skip the traversal entries;
        # must not create files outside OUTPUT_ROOT. Accept either; the mapping
        # should be empty (or not include escape paths).
        assert resp.status_code in (200, 400)
        if resp.status_code == 200:
            for key in resp.json().get("urlMapping", {}).keys():
                assert ".." not in key


class TestOutputsArchive:
    """POST /api/outputs/archive moves timestamped output/<YYYY-MM-DD_*>
    directories older than N days into output/.archive/. Explicit-only: the
    backend never auto-runs this. Users who want disk savings call it via
    Settings UI or curl, and they can always recover by moving the archived
    dirs back (nothing is deleted)."""

    def _setup_output_dirs(self, client):
        """Create two timestamped output dirs: one old, one recent."""
        import sys, time, os
        from pathlib import Path
        sys.path.insert(0, str(Path(__file__).resolve().parent.parent))
        from services.output import OUTPUT_ROOT

        old_dir = OUTPUT_ROOT / "2024-01-01_00-00-00"
        old_dir.mkdir(parents=True, exist_ok=True)
        (old_dir / "n1_final.png").write_bytes(b"old")
        # Back-date the mtime so the "older than N days" filter catches it.
        long_ago = time.time() - 60 * 60 * 24 * 100  # 100 days
        os.utime(old_dir, (long_ago, long_ago))

        recent_dir = OUTPUT_ROOT / "2026-04-24_12-00-00"
        recent_dir.mkdir(parents=True, exist_ok=True)
        (recent_dir / "n2_final.png").write_bytes(b"recent")

        return OUTPUT_ROOT, old_dir, recent_dir

    def test_archive_moves_old_dirs(self, client):
        OUTPUT_ROOT, old_dir, recent_dir = self._setup_output_dirs(client)
        resp = client.post("/api/outputs/archive?older_than_days=30")
        assert resp.status_code == 200
        data = resp.json()
        # Old dir moved, recent dir untouched.
        assert not old_dir.exists()
        assert recent_dir.exists()
        # Archived into output/.archive/
        archived = OUTPUT_ROOT / ".archive" / "2024-01-01_00-00-00"
        assert archived.exists()
        assert (archived / "n1_final.png").read_bytes() == b"old"
        assert data["archived"] == ["2024-01-01_00-00-00"]

    def test_archive_never_auto_runs(self, client):
        """Sanity: hitting the healthcheck or any read endpoint must not
        trigger archiving. Cleanup is explicit-only."""
        OUTPUT_ROOT, old_dir, _ = self._setup_output_dirs(client)
        # Random reads
        client.get("/api/nodes")
        client.get("/api/graph")
        assert old_dir.exists(), "archive must never run automatically"

    def test_archive_skips_special_dirs(self, client):
        """chat-uploads, .archive, and anything not matching YYYY-MM-DD_ must
        be left alone regardless of age."""
        import sys, time, os
        from pathlib import Path
        sys.path.insert(0, str(Path(__file__).resolve().parent.parent))
        from services.output import OUTPUT_ROOT

        chat_uploads = OUTPUT_ROOT / "chat-uploads"
        chat_uploads.mkdir(parents=True, exist_ok=True)
        long_ago = time.time() - 60 * 60 * 24 * 365  # 1 year
        os.utime(chat_uploads, (long_ago, long_ago))

        resp = client.post("/api/outputs/archive?older_than_days=30")
        assert resp.status_code == 200
        assert chat_uploads.exists(), "chat-uploads must never be archived"
        assert "chat-uploads" not in resp.json()["archived"]


class TestOpenAIApiBillingDoesNotBlock:
    """OpenAI-direct image nodes should not be blocked by a separate billing
    acknowledgement. Normal graph validation still applies."""

    def test_execute_reaches_normal_validation_without_billing_ack(self, client):
        resp = client.post("/api/execute", json={
            "nodes": [
                {"id": "n1", "definitionId": "gpt-image-2-generate", "params": {}, "outputs": {}},
            ],
            "edges": [],
        })

        assert resp.status_code == 200
        assert resp.json()["status"] == "validation_error"


class TestProviderCapabilityValidationResponse:
    @staticmethod
    def _omni_extension_graph():
        return {
            "nodes": [
                {
                    "id": "prompt",
                    "definitionId": "text-input",
                    "params": {"value": "Continue the same clip with a second scene."},
                    "outputs": {},
                },
                {
                    "id": "previous",
                    "definitionId": "text-input",
                    "params": {"value": "v1_previous"},
                    "outputs": {},
                },
                {
                    "id": "omni",
                    "definitionId": "gemini-omni-flash",
                    "params": {},
                    "outputs": {},
                },
            ],
            "edges": [
                {
                    "id": "prompt-edge",
                    "source": "prompt",
                    "sourceHandle": "text",
                    "target": "omni",
                    "targetHandle": "prompt",
                },
                {
                    "id": "previous-edge",
                    "source": "previous",
                    "sourceHandle": "text",
                    "target": "omni",
                    "targetHandle": "previous_interaction_id",
                },
            ],
        }

    @staticmethod
    def _capability_message(body):
        return next(
            error["message"]
            for error in body["errors"]
            if error["nodeId"] == "omni" and error["portId"] == "prompt"
        )

    def test_create_and_canvas_execution_routes_return_same_capability_error(self, client):
        from services.provider_capabilities import GEMINI_OMNI_EXTENSION_ERROR

        graph = self._omni_extension_graph()
        create_response = client.post("/api/execute", json=graph)
        canvas_response = client.post(
            "/api/execute-node",
            json={**graph, "targetNodeId": "omni"},
        )

        assert create_response.status_code == 200
        assert canvas_response.status_code == 200
        assert create_response.json()["status"] == "validation_error"
        assert canvas_response.json()["status"] == "validation_error"
        assert self._capability_message(create_response.json()) == GEMINI_OMNI_EXTENSION_ERROR
        assert self._capability_message(canvas_response.json()) == GEMINI_OMNI_EXTENSION_ERROR

    def test_validation_websocket_event_echoes_request_run_id(self, client):
        graph = {**self._omni_extension_graph(), "runId": "run-validation-123"}

        with client.websocket_connect("/ws") as websocket:
            response = client.post("/api/execute", json=graph)
            event = websocket.receive_json()

        assert response.status_code == 200
        assert response.json()["status"] == "validation_error"
        assert event["type"] == "validationError"
        assert event["runId"] == "run-validation-123"

    def test_event_serializer_inherits_task_local_run_id(self):
        from main import _event_to_camel
        from models.events import QueuedEvent, execution_run_id

        token = execution_run_id.set("run-context-123")
        try:
            event = _event_to_camel(QueuedEvent(node_id="n1"))
        finally:
            execution_run_id.reset(token)

        assert event == {
            "runId": "run-context-123",
            "type": "queued",
            "nodeId": "n1",
        }


class TestChatAgentDispatch:
    """WebSocket /ws/chat accepts an 'agent' field and routes to the right runner."""

    def test_dispatch_registers_both_agents(self):
        """The dispatch table exposes claude, codex, and daedalus."""
        import sys
        from pathlib import Path
        sys.path.insert(0, str(Path(__file__).resolve().parent.parent))
        from services.chat_session import AGENT_RUNNERS
        assert "claude" in AGENT_RUNNERS
        assert "codex" in AGENT_RUNNERS
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


class TestCinemaScenePersistsScene:
    """Regression for the scene-parity gap: agents and the Cinema Studio must be
    able to persist a `scene` spec on a cinema-scene node via the standard graph
    API. Before the fix, cinema-scene declared `params: []`, so `_validate_params`
    rejected the `scene` key with HTTP 400 — the Studio's persistSceneParam PUT
    failed silently and no agent could author a scene. The fix declares `scene`
    as a (hidden) param on the cinema-scene def so `_valid_param_keys` includes
    it and the validator accepts it through its normal declared-keys path.

    These run against the FastAPI TestClient, which imports `main` fresh and so
    loads the regenerated node_definitions.json without needing the live restart.
    """

    _SCENE = {
        "base": {"model": "nano-banana"},
        "aspectRatio": "1:1",
        "shots": [{"id": "s1", "prompt": "x"}],
    }

    def test_create_cinema_scene_node_with_scene_returns_200(self, client):
        resp = client.post(
            "/api/graph/node",
            json={"definitionId": "cinema-scene", "params": {"scene": self._SCENE}},
        )
        # The whole point: NOT a 400.
        assert resp.status_code == 200, resp.text
        node = resp.json()
        short_id = node["id"]
        try:
            assert node["params"]["scene"] == self._SCENE
        finally:
            client.delete(f"/api/graph/node/{short_id}")

    def test_put_scene_on_cinema_scene_node_persists(self, client):
        # Create an empty cinema-scene node first (mirrors the Studio flow:
        # node dropped, then persistSceneParam PUTs the scene).
        create = client.post(
            "/api/graph/node",
            json={"definitionId": "cinema-scene", "params": {}},
        )
        assert create.status_code == 200, create.text
        short_id = create.json()["id"]
        try:
            resp = client.put(
                f"/api/graph/node/{short_id}",
                json={"params": {"scene": self._SCENE}},
            )
            assert resp.status_code == 200, resp.text
            # The scene must survive into the persisted node params.
            # GET /api/graph returns cli_graph.get_state(): nodes are flat
            # dicts with params at the top level (not under a `data` key).
            graph = client.get("/api/graph").json()
            node = next(n for n in graph["nodes"] if n["id"] == short_id)
            assert node["params"]["scene"] == self._SCENE
        finally:
            client.delete(f"/api/graph/node/{short_id}")


class TestQuickImageInputParams:
    """Regression: /api/quick previously built image-input nodes with
    ``params={"value": <path>}``, but the engine resolves image/video/audio
    inputs via ``params["filePath"]`` (execution/engine.py). The mismatch made a
    local file reference unreadable (observed: ``[Errno 21] Is a directory: '.'``).
    """

    def test_quick_image_reference_writes_filePath_not_value(
        self, client, tmp_path, monkeypatch
    ):
        import main

        img = tmp_path / "ref.png"
        img.write_bytes(b"\x89PNG\r\n\x1a\n")  # minimal PNG-ish bytes

        captured = {}

        async def _fake_execute_graph(*, nodes, edges, **kwargs):
            captured["nodes"] = nodes
            captured["edges"] = edges
            # No real model call — just record what the route assembled.

        monkeypatch.setattr(main, "execute_graph", _fake_execute_graph)

        resp = client.post(
            "/api/quick",
            json={
                "definitionId": "gpt-image-1-edit",
                "inputs": {"image": str(img)},
                "params": {"prompt": "make it blue"},
            },
        )
        assert resp.status_code == 200, resp.text

        input_nodes = [
            n for n in captured["nodes"] if n.definition_id == "image-input"
        ]
        assert len(input_nodes) == 1, "quick image ref should build one image-input node"
        params = input_nodes[0].params

        # The handler reads `filePath` (absolute) — `value` alone is unreadable.
        assert "filePath" in params, f"missing filePath; got {params!r}"
        file_path = params["filePath"]
        assert isinstance(file_path, str) and file_path
        assert Path(file_path).is_absolute(), file_path
        # Must resolve to a real file, not a bare dir like '.' (the old bug).
        assert Path(file_path).is_file(), file_path
        assert params.get("value") != "."

        # And the engine's own resolution would read a non-empty path.
        assert input_nodes[0].params.get("filePath", "") != ""

    def test_quick_text_input_still_uses_value(self, client, monkeypatch):
        import main

        captured = {}

        async def _fake_execute_graph(*, nodes, edges, **kwargs):
            captured["nodes"] = nodes

        monkeypatch.setattr(main, "execute_graph", _fake_execute_graph)

        resp = client.post(
            "/api/quick",
            json={
                "definitionId": "gpt-image-1-generate",
                "inputs": {"prompt": "a red balloon"},
                "params": {},
            },
        )
        assert resp.status_code == 200, resp.text

        text_nodes = [
            n for n in captured["nodes"] if n.definition_id == "text-input"
        ]
        assert len(text_nodes) == 1
        assert text_nodes[0].params == {"value": "a red balloon"}
