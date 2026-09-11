import sys
from pathlib import Path

import pytest
from fastapi.testclient import TestClient

sys.path.insert(0, str(Path(__file__).resolve().parent.parent))
import main as main_module  # noqa: E402
from main import app  # noqa: E402
from execution import engine
from services import output as output_mod
from services.cli_graph import CLIGraph
from services.provider_recovery import ProviderRecoveryStore


@pytest.fixture(autouse=True)
def clear_graph():
    # Replace main.cli_graph with a fresh, persist-free instance so prior
    # tests that swap the reference (e.g. test_chat_uploads) don't leave a
    # stale object here.  The route and the test body both access
    # main_module.cli_graph, so they always see the same object.
    main_module.cli_graph = CLIGraph()
    yield
    main_module.cli_graph = CLIGraph()


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
    main_module.cli_graph.add_node("text-input", {"value": "preexisting"})  # n1 stays
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
    assert len(main_module.cli_graph.nodes) == 3


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
    assert main_module.cli_graph.nodes[new_id]["params"]["filePath"] != "/api/outputs/run1/x.png"


def test_cluster_invalid_handle_is_rejected_without_partial_mutation():
    main_module.cli_graph.add_node("text-input", {"value": "keep me"})
    before = main_module.cli_graph.get_state()
    client = TestClient(app)

    resp = client.post("/api/graph/cluster", json={
        "nodes": [
            {"tempId": "source", "definitionId": "text-input", "params": {"value": "new"}},
            {"tempId": "target", "definitionId": "nano-banana", "params": {}},
        ],
        "edges": [{
            "source": "source",
            "sourceHandle": "not-a-real-output",
            "target": "target",
            "targetHandle": "prompt",
        }],
    })

    assert resp.status_code == 400
    assert "Invalid source handle" in resp.json()["detail"]
    assert main_module.cli_graph.get_state() == before


def test_cluster_malformed_later_node_does_not_persist_earlier_node():
    main_module.cli_graph.add_node("text-input", {"value": "keep me"})
    before = main_module.cli_graph.get_state()
    client = TestClient(app)

    resp = client.post("/api/graph/cluster", json={
        "nodes": [
            {"tempId": "valid", "definitionId": "text-input", "params": {"value": "staged"}},
            {"tempId": "broken", "definitionId": "text-input", "params": "not-an-object"},
        ],
        "edges": [],
    })

    assert resp.status_code == 400
    assert main_module.cli_graph.get_state() == before


def test_import_malformed_params_preserves_existing_graph():
    main_module.cli_graph.add_node("text-input", {"value": "irreplaceable"})
    before = main_module.cli_graph.get_state()
    client = TestClient(app)

    resp = client.post("/api/graph/import", json={
        "nodes": [
            {"id": "valid", "definitionId": "text-input", "params": {"value": "candidate"}},
            {"id": "broken", "definitionId": "text-input", "params": "malformed"},
        ],
        "edges": [],
    })

    assert resp.status_code == 400
    assert main_module.cli_graph.get_state() == before


def test_import_invalid_handle_preserves_existing_graph():
    main_module.cli_graph.add_node("text-input", {"value": "irreplaceable"})
    before = main_module.cli_graph.get_state()
    client = TestClient(app)

    resp = client.post("/api/graph/import", json={
        "nodes": [
            {"id": "source", "definitionId": "text-input", "params": {"value": "candidate"}},
            {"id": "target", "definitionId": "nano-banana", "params": {}},
        ],
        "edges": [{
            "source": "source",
            "sourceHandle": "text",
            "target": "target",
            "targetHandle": "missing-handle",
        }],
    })

    assert resp.status_code == 400
    assert "Invalid target handle" in resp.json()["detail"]
    assert main_module.cli_graph.get_state() == before


def test_valid_import_replaces_graph_after_full_validation():
    main_module.cli_graph.add_node("text-input", {"value": "old"})
    client = TestClient(app)

    resp = client.post("/api/graph/import", json={
        "nodes": [
            {"id": "source", "definitionId": "text-input", "params": {"value": "new"}},
            {"id": "target", "definitionId": "nano-banana", "params": {}},
        ],
        "edges": [{
            "source": "source",
            "sourceHandle": "text",
            "target": "target",
            "targetHandle": "prompt",
        }],
    })

    assert resp.status_code == 200
    assert resp.json()["nodeCount"] == 2
    assert resp.json()["edgeCount"] == 1
    assert {node["params"].get("value") for node in main_module.cli_graph.nodes.values()} == {"new", None}


def test_import_invalid_spatial_output_preserves_existing_graph():
    main_module.cli_graph.add_node("text-input", {"value": "irreplaceable"})
    before = main_module.cli_graph.get_state()
    client = TestClient(app)

    resp = client.post("/api/graph/import", json={
        "nodes": [{
            "id": "camera",
            "definitionId": "camera-pose",
            "params": {},
            "outputs": {
                "pose": {
                    "type": "CameraPose",
                    "value": {
                        "schemaVersion": 1,
                        "kind": "camera-pose",
                        "id": "camera",
                        "coordinateSystem": {
                            "schemaVersion": 1,
                            "kind": "coordinate-system",
                            "id": "world",
                            "handedness": "right",
                            "upAxis": "y",
                            "forwardAxis": "-y",
                            "unit": "meters",
                            "metersPerUnit": 1.0,
                            "originMeters": [0.0, 0.0, 0.0],
                        },
                        "position": [0.0, 0.0, 0.0],
                        "orientation": [0.0, 0.0, 0.0, 1.0],
                    },
                },
            },
        }],
        "edges": [],
    })

    assert resp.status_code == 400
    assert "outputs is invalid" in resp.json()["detail"]
    assert main_module.cli_graph.get_state() == before


@pytest.mark.parametrize(
    "outputs",
    [
        {"pose": {"type": "CameraPose", "value": None}},
        {"fabricated": {"type": "CameraPose", "value": {}}},
        {"pose": {"type": "Text", "value": "not a camera"}},
        {"pose": {"type": "Any", "value": {"uri": "https://signed.example/asset"}}},
    ],
)
def test_import_rejects_null_spatial_or_fabricated_output_contracts(outputs):
    main_module.cli_graph.add_node("text-input", {"value": "irreplaceable"})
    before = main_module.cli_graph.get_state()

    response = TestClient(app).post(
        "/api/graph/import",
        json={
            "nodes": [
                {
                    "id": "camera",
                    "definitionId": "camera-pose",
                    "params": {},
                    "outputs": outputs,
                }
            ],
            "edges": [],
        },
    )

    assert response.status_code == 400
    assert main_module.cli_graph.get_state() == before


def test_import_canonicalizes_spatial_values_before_persistence():
    camera = {
        "schemaVersion": 1,
        "kind": "camera-pose",
        "id": "camera",
        "coordinateSystem": {
            "schemaVersion": 1,
            "kind": "coordinate-system",
            "id": "world",
            "handedness": "right",
            "upAxis": "y",
            "forwardAxis": "-z",
            "unit": "meters",
            "metersPerUnit": 1.0,
            "originMeters": [0.0, 0.0, 0.0],
        },
        "position": [0.0, 0.0, 0.0],
        "orientation": [0.0, 0.0, 0.0, 2.0],
        "intrinsics": None,
        "timestampSeconds": None,
    }
    response = TestClient(app).post(
        "/api/graph/import",
        json={
            "nodes": [
                {
                    "id": "camera",
                    "definitionId": "camera-pose",
                    "params": {},
                    "outputs": {"pose": {"type": "CameraPose", "value": camera}},
                }
            ],
            "edges": [],
        },
    )

    assert response.status_code == 200
    stored = next(iter(main_module.cli_graph.nodes.values()))["outputs"]["pose"]["value"]
    assert stored["orientation"] == [0.0, 0.0, 0.0, 1.0]
    assert "intrinsics" not in stored
    assert "timestampSeconds" not in stored


def test_import_accepts_schema_only_spatial_type_from_generic_validator_output():
    session = {
        "schemaVersion": 1,
        "kind": "spatial-session",
        "id": "session",
        "source": "captured",
        "tags": ["metric"],
    }
    response = TestClient(app).post(
        "/api/graph/import",
        json={
            "nodes": [
                {
                    "id": "validate",
                    "definitionId": "spatial-value-validate",
                    "params": {"expected_type": "SpatialSession"},
                    "outputs": {
                        "value": {"type": "SpatialSession", "value": session}
                    },
                }
            ],
            "edges": [],
        },
    )

    assert response.status_code == 200
    stored = next(iter(main_module.cli_graph.nodes.values()))["outputs"]["value"]
    assert stored == {"type": "SpatialSession", "value": session}


def test_import_nonfinite_position_preserves_existing_graph():
    main_module.cli_graph.add_node("text-input", {"value": "irreplaceable"})
    before = main_module.cli_graph.get_state()
    payload = (
        '{"nodes":[{"id":"bad","definitionId":"text-input",'
        '"params":{},"position":{"x":1e400,"y":0}}],"edges":[]}'
    )

    response = TestClient(app).post(
        "/api/graph/import",
        content=payload,
        headers={"content-type": "application/json"},
    )

    assert response.status_code == 400
    assert "non-finite" in response.json()["detail"]
    assert main_module.cli_graph.get_state() == before


@pytest.mark.parametrize(
    "payload",
    [
        '{"nodes":[{"id":"bad","definitionId":"camera-pose","params":{"position_x":1e400}}],"edges":[]}',
        '{"nodes":[{"id":"bad","definitionId":"text-input","params":{"_nested":{"value":1e400}}}],"edges":[]}',
    ],
)
def test_import_nonfinite_params_preserve_existing_graph_and_disk(
    tmp_path, monkeypatch, payload
):
    path = tmp_path / "graph.json"
    live = CLIGraph(persist_path=path)
    live.add_node("text-input", {"value": "irreplaceable"})
    before = live.get_state()
    monkeypatch.setattr(main_module, "cli_graph", live)

    response = TestClient(app).post(
        "/api/graph/import",
        content=payload,
        headers={"content-type": "application/json"},
    )

    assert response.status_code == 400
    assert "non-finite" in response.json()["detail"]
    assert live.get_state() == before
    restored = CLIGraph()
    restored.load(path)
    assert restored.get_state() == before


def test_failed_graph_commit_rolls_back_only_new_recovery_records(
    tmp_path, monkeypatch
):
    path = tmp_path / "graph.json"
    live = CLIGraph(persist_path=path)
    live.add_node("text-input", {"value": "keep"})
    before = live.get_state()
    candidate = live.clone()
    created = candidate.add_node(
        "worldlabs-environment",
        {"resume_operation_id": "candidate-operation"},
    )
    store = ProviderRecoveryStore(tmp_path / "recoveries.json")
    store.set(
        run_id="existing",
        node_id="existing-node",
        resume_operation_id="existing-operation",
        existing_world_id=None,
    )
    monkeypatch.setattr(main_module, "cli_graph", live)
    monkeypatch.setattr(main_module, "provider_recovery_store", store)

    def fail_graph_save(*_args, **_kwargs):
        raise OSError("disk full")

    monkeypatch.setattr(CLIGraph, "_save_state", staticmethod(fail_graph_save))

    with pytest.raises(OSError, match="disk full"):
        main_module._commit_graph_candidate_with_recoveries(
            candidate,
            [candidate.nodes[created]],
            source="test",
        )

    assert live.get_state() == before
    assert store.list() == [
        {
            "runId": "existing",
            "nodeId": "existing-node",
            "resumeOperationId": "existing-operation",
            "existingWorldId": None,
        }
    ]


@pytest.mark.parametrize(("field", "invalid"), [("params", []), ("outputs", False)])
def test_import_rejects_falsey_wrong_container_types(field, invalid):
    main_module.cli_graph.add_node("text-input", {"value": "irreplaceable"})
    before = main_module.cli_graph.get_state()
    node = {"id": "bad", "definitionId": "text-input", "params": {}}
    node[field] = invalid

    response = TestClient(app).post(
        "/api/graph/import",
        json={"nodes": [node], "edges": []},
    )

    assert response.status_code == 400
    assert main_module.cli_graph.get_state() == before


def test_import_keeps_valid_legacy_world_v1_while_validating_adapter_path():
    client = TestClient(app)
    legacy_world = {
        "schemaVersion": 1,
        "provider": "worldlabs",
        "worldId": "legacy-world",
        "model": "marble-1.1",
        "displayName": "Legacy World",
        "promptType": "image",
        "assets": {"splats": {"100k": "/api/outputs/run/world.spz"}},
        "semantics": {
            "coordinateFrame": "marble_raw_opencv",
            "metricScaleFactor": 1.0,
            "groundPlaneOffset": 0.0,
        },
    }

    resp = client.post("/api/graph/import", json={
        "nodes": [{
            "id": "world",
            "definitionId": "worldlabs-environment",
            "params": {},
            "outputs": {"world": {"type": "World", "value": legacy_world}},
        }],
        "edges": [],
    })

    assert resp.status_code == 200
    stored = next(iter(main_module.cli_graph.nodes.values()))["outputs"]["world"]["value"]
    assert stored["schemaVersion"] == 1
    assert stored["worldId"] == "legacy-world"
    assert "kind" not in stored


def test_imported_atlas_placeholder_cannot_enter_executable_catalog():
    main_module.cli_graph.add_node("text-input", {"value": "irreplaceable"})
    before = main_module.cli_graph.get_state()
    response = TestClient(app).post("/api/graph/import", json={
        "nodes": [{
            "id": "claimed-atlas",
            "definitionId": "worldlabs-atlas",
            "params": {"model": "atlas"},
        }],
        "edges": [],
    })

    assert response.status_code == 400
    assert "unknown node definition 'worldlabs-atlas'" in response.json()["detail"]
    assert main_module.cli_graph.get_state() == before
