from __future__ import annotations

import copy
import json
import stat
import sys
from pathlib import Path
from unittest.mock import AsyncMock

import pytest
from fastapi.testclient import TestClient

sys.path.insert(0, str(Path(__file__).resolve().parent.parent))
import main as main_module
from services.cli_graph import CLIGraph
from services.execution_runs import ExecutionRunRegistry
from services.project_store import ProjectStore
from services.provider_recovery import ProviderRecoveryStore
from services.provider_start_guard import ProviderStartGuard


@pytest.fixture
def workspace(tmp_path, monkeypatch):
    graph = CLIGraph(persist_path=tmp_path / "state.json")
    store = ProjectStore(tmp_path / "projects")
    monkeypatch.setattr(main_module, "cli_graph", graph)
    monkeypatch.setattr(main_module, "project_store", store)
    monkeypatch.setattr(main_module, "provider_recovery_store", ProviderRecoveryStore(None))
    monkeypatch.setattr(main_module, "provider_start_guard", ProviderStartGuard(tmp_path / "paid-starts.json"))
    monkeypatch.setattr(main_module, "execution_runs", ExecutionRunRegistry())
    monkeypatch.setattr(main_module, "_graph_recovery_bootstrap_error", None)
    broadcast = AsyncMock()
    monkeypatch.setattr(main_module.manager, "broadcast_raw", broadcast)
    return TestClient(main_module.app), graph, store, broadcast


def node(node_id="n42", value="Saved prompt", **extras):
    return {
        "id": node_id, "type": "model-node", "position": {"x": 340, "y": -80},
        "data": {"definitionId": "text-input", "label": "Prompt", "params": {"value": value}, "outputs": {"text": {"type": "Text", "value": value}}, **extras},
    }


def saved_snapshot():
    return {
        "nodes": [node(), node("n90", "Second")],
        "edges": [{"id": "custom-edge", "source": "n42", "sourceHandle": "text", "target": "n90", "targetHandle": "text"}],
        "runHistory": [{"id": "run-immutable", "status": "complete", "startedAt": 123,
            "snapshot": {"nodes": [{"id": "n42", "definitionId": "text-input", "params": {"value": "Old prompt"}, "outputs": {}}], "edges": []},
            "resultOutputs": {"n42": {"text": {"type": "Text", "value": "Earlier output"}}}}],
        "viewport": {"x": 4, "y": 9, "zoom": 0.8}, "createSessionId": "saved-create-session",
        "createDraft": {"prompt": "draft", "selectedModels": ["nano-banana"]},
    }


def create(client, name="Test project", revision=None):
    body = {"name": name}
    if revision:
        body["workspaceRevision"] = revision
    response = client.post("/api/projects", json=body)
    assert response.status_code == 200, response.text
    return response.json()


def test_empty_workspace_starts_with_projects_home_without_default_nodes(workspace):
    client, graph, store, _ = workspace
    listing = client.get("/api/projects")
    assert listing.status_code == 200
    assert listing.json()["projects"] == []
    assert listing.json()["activeProjectId"] is None
    created = create(client)
    assert created["project"]["snapshot"]["nodes"] == []
    assert graph.nodes == {}
    assert stat.S_IMODE(store.path.stat().st_mode) == 0o600
    assert stat.S_IMODE(store.root.stat().st_mode) == 0o700


def test_migrates_existing_canvas_once_without_replacing_it(workspace):
    client, graph, store, broadcast = workspace
    graph.add_node("text-input", {"value": "keep this canvas"}, position={"x": 9, "y": 21})
    before = copy.deepcopy(graph.get_state())
    listing = client.get("/api/projects").json()
    project_id = listing["migratedProjectId"]
    assert listing["projects"][0]["name"] == "Recovered canvas"
    assert graph.get_state() == before
    assert client.get("/api/projects").json()["projects"] == listing["projects"]
    assert client.get("/api/projects").json()["migratedProjectId"] == project_id
    assert len(ProjectStore(store.root).read()["projects"]) == 1
    broadcast.assert_not_awaited()
    document = client.get(f"/api/projects/{project_id}").json()
    assert document["snapshot"]["runHistory"] == []
    assert document["snapshot"]["nodes"][0]["id"] == "n1"


def test_preserves_ids_outputs_recipe_and_creator_state_on_switch(workspace):
    client, graph, store, broadcast = workspace
    first = create(client, "First")
    project_id = first["project"]["id"]
    snapshot = saved_snapshot()
    # Text input has no input handle; use a model prompt target for this edge.
    snapshot["nodes"][1]["data"].update({"definitionId": "nano-banana", "params": {}, "outputs": {}})
    snapshot["edges"][0]["targetHandle"] = "prompt"
    saved = client.put(f"/api/projects/{project_id}", json={"workspaceRevision": first["workspaceRevision"], "snapshot": snapshot})
    assert saved.status_code == 200, saved.text
    # Snapshot save intentionally does not replace the live graph.
    assert graph.nodes == {}
    second = create(client, "Second", first["workspaceRevision"])
    opened = client.post(f"/api/projects/{project_id}/open", json={"workspaceRevision": second["workspaceRevision"]})
    assert opened.status_code == 200, opened.text
    document = opened.json()["project"]
    assert document["snapshot"] == snapshot
    assert set(graph.nodes) == {"n42", "n90"}
    assert graph.edges[0]["id"] == "custom-edge"
    assert graph.nodes["n42"]["outputs"]["text"]["value"] == "Saved prompt"
    assert graph.add_node("text-input", {"value": "new"}) == "n91"
    persisted = ProjectStore(store.root).read()["projects"][project_id]
    assert persisted["snapshot"]["runHistory"] == snapshot["runHistory"]
    replacement = broadcast.await_args.args[0]
    assert replacement["graphReplaced"] is True
    assert replacement["workspaceRevision"] == opened.json()["workspaceRevision"]
    assert replacement["activeProjectId"] == project_id


def test_latest_cli_changes_overlay_without_erasing_frontend_extras_or_history(workspace):
    client, graph, _, _ = workspace
    graph.add_node("text-input", {"value": "old"})
    listing = client.get("/api/projects").json()
    project_id = listing["activeProjectId"]
    doc = client.get(f"/api/projects/{project_id}").json()
    snapshot = doc["snapshot"]
    snapshot["nodes"][0]["data"]["customDetail"] = {"keep": True}
    snapshot["nodes"].append(node("frontend-only", "view-only"))
    snapshot["runHistory"] = saved_snapshot()["runHistory"]
    snapshot["viewport"] = {"x": 9, "y": 2, "zoom": 1.3}
    saved = client.put(f"/api/projects/{project_id}", json={"workspaceRevision": listing["workspaceRevision"], "snapshot": snapshot})
    assert saved.status_code == 200, saved.text
    graph.update_params("n1", {"value": "CLI edit"})
    added = graph.add_node("text-input", {"value": "CLI addition"})
    client.get("/api/projects")
    updated = client.get(f"/api/projects/{project_id}").json()["snapshot"]
    assert updated["nodes"][0]["data"]["params"]["value"] == "CLI edit"
    assert updated["nodes"][0]["data"]["customDetail"] == {"keep": True}
    assert {n["id"] for n in updated["nodes"]} == {"n1", added, "frontend-only"}
    assert updated["runHistory"] == snapshot["runHistory"]
    assert updated["viewport"] == snapshot["viewport"]
    graph.remove_node("n1")
    client.get("/api/projects")
    assert {n["id"] for n in client.get(f"/api/projects/{project_id}").json()["snapshot"]["nodes"]} == {added, "frontend-only"}


@pytest.mark.parametrize("failure_at", ["prepare", "graph", "commit"])
def test_switch_write_failures_preserve_live_graph_and_catalog(workspace, monkeypatch, failure_at):
    client, graph, store, broadcast = workspace
    first = create(client, "First")
    first_id = first["project"]["id"]
    second = create(client, "Second")
    graph.add_node("text-input", {"value": "current canvas"})
    before_graph = copy.deepcopy(graph.get_state())
    before_catalog = store.path.read_bytes()
    before_state = graph._persist_path.read_bytes()
    broadcast.reset_mock()
    def fail(*_args, **_kwargs):
        raise OSError("synthetic write failure")
    if failure_at == "graph":
        monkeypatch.setattr(CLIGraph, "save", fail)
    else:
        monkeypatch.setattr(store, "prepare" if failure_at == "prepare" else "commit_prepared", fail)
    response = client.post(f"/api/projects/{first_id}/open", json={"workspaceRevision": second["workspaceRevision"]})
    assert response.status_code == 507, response.text
    assert graph.get_state() == before_graph
    assert store.path.read_bytes() == before_catalog
    assert graph._persist_path.read_bytes() == before_state
    broadcast.assert_not_awaited()


def test_invalid_snapshot_and_invalid_name_are_atomic(workspace):
    client, graph, store, broadcast = workspace
    created = create(client)
    project_id = created["project"]["id"]
    graph.add_node("text-input", {"value": "current"})
    before = copy.deepcopy(graph.get_state())
    catalog = store.path.read_bytes()
    bad = saved_snapshot()
    bad["nodes"].append({**node(), "id": "n42"})
    response = client.put(f"/api/projects/{project_id}", json={"workspaceRevision": created["workspaceRevision"], "snapshot": bad})
    assert response.status_code == 400
    assert graph.get_state() == before
    assert store.path.read_bytes() == catalog
    response = client.post("/api/projects", json={"name": " "})
    assert response.status_code == 400
    assert graph.get_state() == before


def test_stale_project_tabs_cannot_save_switch_edit_or_execute(workspace):
    client, graph, _, _ = workspace
    first = create(client, "First")
    second = create(client, "Second", first["workspaceRevision"])
    stale = first["workspaceRevision"]
    assert client.put(f"/api/projects/{first['project']['id']}", json={"workspaceRevision": stale, "snapshot": {"nodes": [], "edges": []}}).status_code == 409
    assert client.post(f"/api/projects/{first['project']['id']}/open", json={"workspaceRevision": stale}).status_code == 409
    assert client.post("/api/projects", json={"workspaceRevision": stale}).status_code == 409
    for method, path, body in [
        ("post", "/api/graph/node", {"definitionId": "text-input", "params": {"value": "stale"}}),
        ("post", "/api/execute", {"nodes": [], "edges": []}),
        ("post", "/api/execute-node", {}),
        ("post", "/api/cinema/generate-shot", {}),
        ("post", "/api/quick", {}),
    ]:
        response = getattr(client, method)(path, json=body, headers={"X-Nebula-Workspace-Revision": stale})
        assert response.status_code == 409, response.text
    # Headerless CLI requests retain compatibility.
    assert client.post("/api/graph/node", json={"definitionId": "text-input", "params": {"value": "CLI"}}).status_code == 200
    assert client.get("/api/graph/export").json()["workspaceRevision"] == second["workspaceRevision"]
    # Inactive project renaming never switches the live canvas.
    assert client.put(f"/api/projects/{first['project']['id']}", json={"name": "Renamed"}).status_code == 200


def test_switch_is_blocked_for_active_runs_and_paid_recovery(workspace, monkeypatch):
    client, graph, store, broadcast = workspace
    first = create(client)
    graph.add_node("text-input", {"value": "keep"})
    before = copy.deepcopy(graph.get_state())
    monkeypatch.setattr(main_module.execution_runs, "has_active", lambda: True)
    assert client.post("/api/projects", json={"name": "Blocked"}).status_code == 409
    assert client.post(f"/api/projects/{first['project']['id']}/open", json={}).status_code == 409
    assert graph.get_state() == before
    monkeypatch.setattr(main_module.execution_runs, "has_active", lambda: False)
    monkeypatch.setattr(main_module.provider_recovery_store, "list", lambda: [{"runId": "unresolved"}])
    assert client.post("/api/projects", json={"name": "Blocked"}).status_code == 409
    assert graph.get_state() == before


def test_removed_definition_is_retained_without_trusting_frontend_definition(workspace):
    client, graph, _, _ = workspace
    graph.add_node("retired-provider", {"legacy": "old config"}, outputs={"image": {"type": "Image", "value": "https://example.com/image.png"}})
    listing = client.get("/api/projects").json()
    project_id = listing["activeProjectId"]
    create(client, "Other")
    opened = client.post(f"/api/projects/{project_id}/open", json={})
    assert opened.status_code == 200, opened.text
    assert graph.nodes["n1"]["definitionId"] == "retired-provider"
    assert graph.nodes["n1"]["params"] == {"legacy": "old config"}
    snapshot = opened.json()["project"]["snapshot"]
    snapshot["nodes"].append({**node("forged"), "data": {"definitionId": "forged", "params": {}, "outputs": {}, "definition": {"id": "forged", "inputPorts": [], "outputPorts": []}}})
    assert client.put(f"/api/projects/{project_id}", json={"workspaceRevision": opened.json()["workspaceRevision"], "snapshot": snapshot}).status_code == 400


@pytest.mark.parametrize("project_id", ["not-an-id", "..", "%2e%2e", "..%2Fsettings.json"])
def test_project_id_traversal_is_rejected(workspace, project_id):
    client, _, _, _ = workspace
    response = client.get(f"/api/projects/{project_id}")
    assert response.status_code in {400, 404}


def test_non_finite_and_protected_snapshot_refs_are_rejected(workspace):
    client, _, store, _ = workspace
    created = create(client)
    project_id = created["project"]["id"]
    before = store.path.read_bytes()
    payload = {"workspaceRevision": created["workspaceRevision"], "snapshot": {"nodes": [], "edges": [], "viewport": {"x": float("inf"), "y": 0, "zoom": 1}}}
    response = client.put(f"/api/projects/{project_id}", content=json.dumps(payload), headers={"Content-Type": "application/json"})
    assert response.status_code == 400
    payload["snapshot"] = {"nodes": [node()], "edges": [], "runHistory": []}
    from services.agent_profiles import default_secret_paths
    payload["snapshot"]["nodes"][0]["data"]["params"]["value"] = str(default_secret_paths()[0])
    response = client.put(f"/api/projects/{project_id}", json=payload)
    assert response.status_code == 400, response.text
    assert store.path.read_bytes() == before


def test_creating_before_first_list_preserves_existing_legacy_canvas(workspace):
    client, graph, store, _ = workspace
    graph.add_node("text-input", {"value": "legacy canvas"})
    created = create(client, "New project")
    catalog = store.read()
    assert len(catalog["projects"]) == 2
    recovered = catalog["projects"][catalog["migratedProjectId"]]
    assert recovered["snapshot"]["nodes"][0]["data"]["params"]["value"] == "legacy canvas"
    assert catalog["activeProjectId"] == created["project"]["id"]
    assert graph.nodes == {}


def test_migration_remains_pending_until_legacy_history_is_saved(workspace):
    client, graph, _, _ = workspace
    graph.add_node("text-input", {"value": "legacy"})
    initial = client.get("/api/projects").json()
    project_id = initial["migratedProjectId"]
    assert client.get("/api/projects").json()["migratedProjectId"] == project_id
    document = client.get(f"/api/projects/{project_id}").json()
    document["snapshot"]["runHistory"] = saved_snapshot()["runHistory"]
    saved = client.put(f"/api/projects/{project_id}", json={"workspaceRevision": initial["workspaceRevision"], "snapshot": document["snapshot"]})
    assert saved.status_code == 200, saved.text
    assert "migratedProjectId" not in client.get("/api/projects").json()


@pytest.mark.asyncio
async def test_delayed_execution_event_keeps_its_admitted_project_revision(workspace):
    client, _, _, _ = workspace
    from models.events import ExecutedEvent
    first = create(client, "First")
    token = main_module._execution_workspace_context.set({"activeProjectId": first["project"]["id"], "workspaceRevision": first["workspaceRevision"]})
    try:
        second = create(client, "Second")
        manager = main_module.ConnectionManager()
        manager.broadcast_raw = AsyncMock()
        await manager.broadcast(ExecutedEvent(node_id="n1", outputs={}, run_id="run-old"))
        event = manager.broadcast_raw.await_args.args[0]
        assert event["activeProjectId"] == first["project"]["id"]
        assert event["workspaceRevision"] == first["workspaceRevision"]
        assert event["workspaceRevision"] != second["workspaceRevision"]
    finally:
        main_module._execution_workspace_context.reset(token)


@pytest.mark.asyncio
@pytest.mark.parametrize("endpoint", ["graph", "quick"])
async def test_synchronous_runs_block_project_switch_until_settled(workspace, monkeypatch, endpoint):
    import asyncio
    from starlette.requests import Request
    client, graph, _, _ = workspace
    create(client)
    graph.add_node("text-input", {"value": "running"})
    started, finish = asyncio.Event(), asyncio.Event()
    async def executing(**_kwargs):
        started.set()
        await finish.wait()
    monkeypatch.setattr(main_module, "execute_graph", executing)
    if endpoint == "graph":
        task = asyncio.create_task(main_module.run_graph(Request({"type": "http", "headers": []}), {}))
    else:
        task = asyncio.create_task(main_module.quick_execute({"definitionId": "text-input", "params": {"value": "quick"}}))
    await started.wait()
    try:
        with pytest.raises(main_module.HTTPException) as rejected:
            await main_module.create_saved_project({"name": "blocked"})
        assert rejected.value.status_code == 409
    finally:
        finish.set()
        await task
    assert not main_module._synchronous_workspace_runs
    assert (await main_module.create_saved_project({"name": "allowed"}))["project"]["name"] == "allowed"


def test_stale_snapshot_recovery_is_inactive_atomic_and_idempotent(workspace, monkeypatch):
    from uuid import uuid4
    client, graph, store, broadcast = workspace
    first = create(client, "Original")
    second = create(client, "Latest")
    graph.add_node("text-input", {"value": "latest live work"})
    graph_before = copy.deepcopy(graph.get_state())
    catalog_before = store.read()
    broadcast.reset_mock()
    snapshot = {**saved_snapshot(), "edges": []}
    body = {"sourceProjectId": first["project"]["id"], "recoveryId": uuid4().hex, "snapshot": snapshot, "workspaceRevision": first["workspaceRevision"]}
    recovered = client.post("/api/projects/recover", json=body)
    assert recovered.status_code == 200, recovered.text
    recovery = recovered.json()
    assert recovery["project"]["id"] == body["recoveryId"]
    assert recovery["project"]["lastOpenedAt"] is None
    assert recovery["project"]["snapshot"] == snapshot
    assert recovery["workspaceRevision"] == second["workspaceRevision"]
    assert graph.get_state() == graph_before
    assert store.read()["activeProjectId"] == second["project"]["id"]
    assert store.read()["projects"][first["project"]["id"]] == catalog_before["projects"][first["project"]["id"]]
    retry = client.post("/api/projects/recover", json=body)
    assert retry.status_code == 200
    assert retry.json() == recovery
    assert len(store.read()["projects"]) == 3
    broadcast.assert_not_awaited()
    body["snapshot"]["nodes"][0]["data"]["params"]["value"] = "different"
    assert client.post("/api/projects/recover", json=body).status_code == 409
    before = store.path.read_bytes()
    body["recoveryId"] = uuid4().hex
    def fail(*_args, **_kwargs):
        raise OSError("simulated recovery failure")
    monkeypatch.setattr(store, "prepare", fail)
    assert client.post("/api/projects/recover", json=body).status_code == 507
    assert store.path.read_bytes() == before
    assert graph.get_state() == graph_before
