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
    # The opened project's pins (canvasPins) follow the graph replacement.
    replacement = next(call.args[0] for call in reversed(broadcast.await_args_list)
                       if call.args[0]["type"] == "graphSync")
    assert broadcast.await_args.args[0]["type"] == "canvasPins"
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


def test_deleting_an_inactive_project_leaves_the_open_canvas_alone(workspace):
    client, graph, store, broadcast = workspace
    first = create(client, "Old idea")
    second = create(client, "Current", first["workspaceRevision"])
    graph.add_node("text-input", {"value": "live work"})
    graph_before = copy.deepcopy(graph.get_state())
    broadcast.reset_mock()
    deleted = client.request("DELETE", f"/api/projects/{first['project']['id']}",
                             json={"workspaceRevision": second["workspaceRevision"]})
    assert deleted.status_code == 200, deleted.text
    result = deleted.json()
    assert result["deletedProjectId"] == first["project"]["id"]
    assert result["activeProjectId"] == second["project"]["id"]
    assert result["workspaceRevision"] == second["workspaceRevision"]
    assert result["trashedProject"]["name"] == "Old idea"
    catalog = store.read()
    assert list(catalog["projects"]) == [second["project"]["id"]]
    assert list(catalog["trash"]) == [first["project"]["id"]]
    assert catalog["workspaceRevision"] == second["workspaceRevision"]
    assert graph.get_state() == graph_before
    broadcast.assert_not_awaited()
    assert client.get(f"/api/projects/{first['project']['id']}").status_code == 404
    assert client.request("DELETE", f"/api/projects/{first['project']['id']}",
                          json={"workspaceRevision": second["workspaceRevision"]}).status_code == 404


def test_deleting_the_open_project_empties_the_canvas_and_retires_the_revision(workspace):
    client, graph, store, broadcast = workspace
    keep = create(client, "Keep")
    doomed = create(client, "Scratch", keep["workspaceRevision"])
    graph.add_node("text-input", {"value": "throwaway"})
    broadcast.reset_mock()
    deleted = client.request("DELETE", f"/api/projects/{doomed['project']['id']}",
                             json={"workspaceRevision": doomed["workspaceRevision"]})
    assert deleted.status_code == 200, deleted.text
    result = deleted.json()
    assert result["activeProjectId"] is None
    assert result["workspaceRevision"] != doomed["workspaceRevision"]
    assert graph.nodes == {}
    assert json.loads((store.root.parent / "state.json").read_text())["nodes"] == []
    catalog = store.read()
    assert list(catalog["projects"]) == [keep["project"]["id"]]
    assert catalog["activeProjectId"] is None
    replacement = next(call.args[0] for call in broadcast.await_args_list if call.args[0]["type"] == "graphSync")
    assert replacement["graphReplaced"] is True
    assert replacement["workspaceRevision"] == result["workspaceRevision"]
    # An emptied live canvas must not be re-adopted as a "Recovered canvas".
    listing = client.get("/api/projects").json()
    assert [project["name"] for project in listing["projects"]] == ["Keep"]
    # The old revision is retired: the deleted project's tab can't save over anything.
    assert client.put(f"/api/projects/{keep['project']['id']}", json={
        "workspaceRevision": doomed["workspaceRevision"], "snapshot": saved_snapshot()}).status_code == 409


def test_delete_requires_a_current_view(workspace):
    client, graph, store, _ = workspace
    first = create(client, "First")
    second = create(client, "Second", first["workspaceRevision"])
    path = f"/api/projects/{first['project']['id']}"
    assert client.request("DELETE", path).status_code == 409
    assert client.request("DELETE", path, json={"workspaceRevision": first["workspaceRevision"]}).status_code == 409
    assert set(store.read()["projects"]) == {first["project"]["id"], second["project"]["id"]}


def test_deleting_the_open_project_is_blocked_during_a_run(workspace, monkeypatch):
    client, graph, store, _ = workspace
    other = create(client, "Other")
    running = create(client, "Running", other["workspaceRevision"])
    graph.add_node("text-input", {"value": "mid-run"})
    before = copy.deepcopy(graph.get_state())
    monkeypatch.setattr(main_module.execution_runs, "has_active", lambda: True)
    blocked = client.request("DELETE", f"/api/projects/{running['project']['id']}",
                             json={"workspaceRevision": running["workspaceRevision"]})
    assert blocked.status_code == 409
    assert "delete the open project" in blocked.json()["detail"]
    assert graph.get_state() == before
    assert running["project"]["id"] in store.read()["projects"]
    # A run on the open canvas does not stop tidying up other projects.
    assert client.request("DELETE", f"/api/projects/{other['project']['id']}",
                          json={"workspaceRevision": running["workspaceRevision"]}).status_code == 200


def test_unsaved_edits_to_a_project_deleted_elsewhere_can_still_be_recovered(workspace):
    from uuid import uuid4
    client, graph, store, _ = workspace
    first = create(client, "Deleted elsewhere")
    second = create(client, "Survivor", first["workspaceRevision"])
    assert client.request("DELETE", f"/api/projects/{first['project']['id']}",
                          json={"workspaceRevision": second["workspaceRevision"]}).status_code == 200
    snapshot = {**saved_snapshot(), "edges": []}
    body = {"sourceProjectId": first["project"]["id"], "recoveryId": uuid4().hex, "snapshot": snapshot}
    recovered = client.post("/api/projects/recover", json=body)
    assert recovered.status_code == 200, recovered.text
    # Still in the trash, so the copy keeps its real name.
    assert recovered.json()["project"]["name"] == "Deleted elsewhere (recovered)"
    assert recovered.json()["project"]["snapshot"] == snapshot
    assert client.post("/api/projects/recover", json=body).json() == recovered.json()
    # Gone for good: the copy is still made, under a generic name.
    assert client.request("DELETE", f"/api/projects/trash/{first['project']['id']}").status_code == 200
    body["recoveryId"] = uuid4().hex
    gone = client.post("/api/projects/recover", json=body)
    assert gone.status_code == 200, gone.text
    assert gone.json()["project"]["name"] == "Deleted project (recovered)"


def _trash(client, project_id, revision):
    response = client.request("DELETE", f"/api/projects/{project_id}", json={"workspaceRevision": revision})
    assert response.status_code == 200, response.text
    return response.json()


def test_a_deleted_project_waits_in_the_trash_and_restores_whole(workspace):
    client, graph, store, _ = workspace
    first = create(client, "Moodboard")
    project_id = first["project"]["id"]
    saved = client.put(f"/api/projects/{project_id}", json={"workspaceRevision": first["workspaceRevision"], "snapshot": {**saved_snapshot(), "edges": []}})
    assert saved.status_code == 200, saved.text
    store_catalog = store.read()
    store_catalog["projects"][project_id]["pins"] = [{"id": "p1", "status": "open", "text": "keep me"}]
    store.commit(store_catalog)
    before = store.read()["projects"][project_id]
    second = create(client, "Current", first["workspaceRevision"])
    trashed = _trash(client, project_id, second["workspaceRevision"])["trashedProject"]
    listing = client.get("/api/projects").json()
    assert [project["name"] for project in listing["projects"]] == ["Current"]
    assert [entry["id"] for entry in listing["trash"]] == [project_id]
    assert listing["trash"][0]["deletedAt"] == trashed["deletedAt"]
    assert listing["trash"][0]["purgeAt"] > trashed["deletedAt"]
    # A trashed project can't be opened or saved over.
    assert client.post(f"/api/projects/{project_id}/open", json={"workspaceRevision": second["workspaceRevision"]}).status_code == 404
    restored = client.post(f"/api/projects/{project_id}/restore")
    assert restored.status_code == 200, restored.text
    assert restored.json()["project"]["name"] == "Moodboard"
    catalog = store.read()
    assert catalog["trash"] == {}
    assert catalog["activeProjectId"] == second["project"]["id"]
    assert catalog["projects"][project_id] == before
    assert client.post(f"/api/projects/{project_id}/restore").status_code == 404


def test_restoring_the_project_that_was_open_brings_it_back_closed(workspace):
    client, graph, store, _ = workspace
    first = create(client, "Was open")
    graph.add_node("text-input", {"value": "live"})
    result = _trash(client, first["project"]["id"], first["workspaceRevision"])
    assert graph.nodes == {}
    restored = client.post(f"/api/projects/{first['project']['id']}/restore")
    assert restored.status_code == 200
    assert restored.json()["workspaceRevision"] == result["workspaceRevision"]
    assert store.read()["activeProjectId"] is None
    assert graph.nodes == {}
    opened = client.post(f"/api/projects/{first['project']['id']}/open", json={"workspaceRevision": result["workspaceRevision"]})
    assert opened.status_code == 200, opened.text


def test_trash_can_be_purged_one_at_a_time_or_emptied(workspace):
    client, graph, store, _ = workspace
    a = create(client, "A")
    b = create(client, "B", a["workspaceRevision"])
    c = create(client, "C", b["workspaceRevision"])
    _trash(client, a["project"]["id"], c["workspaceRevision"])
    _trash(client, b["project"]["id"], c["workspaceRevision"])
    purged = client.request("DELETE", f"/api/projects/trash/{a['project']['id']}")
    assert purged.status_code == 200
    assert [entry["id"] for entry in purged.json()["trash"]] == [b["project"]["id"]]
    assert client.request("DELETE", f"/api/projects/trash/{a['project']['id']}").status_code == 404
    # Purging only reaches the trash, never a live project.
    assert client.request("DELETE", f"/api/projects/trash/{c['project']['id']}").status_code == 404
    assert client.request("DELETE", "/api/projects/trash/not-an-id").status_code == 400
    assert client.post("/api/projects/trash/empty").json() == {"trash": []}
    catalog = store.read()
    assert catalog["trash"] == {}
    assert list(catalog["projects"]) == [c["project"]["id"]]


def test_trash_expires_after_thirty_days(workspace):
    from datetime import datetime, timedelta, timezone
    client, graph, store, _ = workspace
    old = create(client, "Old")
    recent = create(client, "Recent", old["workspaceRevision"])
    keep = create(client, "Keep", recent["workspaceRevision"])
    _trash(client, old["project"]["id"], keep["workspaceRevision"])
    _trash(client, recent["project"]["id"], keep["workspaceRevision"])
    catalog = store.read()
    now = datetime.now(timezone.utc)
    catalog["trash"][old["project"]["id"]]["deletedAt"] = (now - timedelta(days=30, minutes=1)).isoformat()
    catalog["trash"][recent["project"]["id"]]["deletedAt"] = (now - timedelta(days=29)).isoformat()
    store.commit(catalog)
    # An expired entry can't be restored even before a listing sweeps it.
    assert client.post(f"/api/projects/{old['project']['id']}/restore").status_code == 404
    listing = client.get("/api/projects").json()
    assert [entry["name"] for entry in listing["trash"]] == ["Recent"]
    assert set(store.read()["trash"]) == {recent["project"]["id"]}


def test_restore_respects_the_project_limit(workspace, monkeypatch):
    client, graph, store, _ = workspace
    a = create(client, "A")
    b = create(client, "B", a["workspaceRevision"])
    _trash(client, a["project"]["id"], b["workspaceRevision"])
    monkeypatch.setattr("services.project_store.MAX_PROJECTS", 1)
    assert client.post(f"/api/projects/{a['project']['id']}/restore").status_code == 413
    assert a["project"]["id"] in store.read()["trash"]


def test_a_corrupt_trash_entry_is_reported_not_silently_dropped(workspace):
    client, graph, store, _ = workspace
    create(client, "A")
    raw = json.loads(store.path.read_text())
    raw["trash"] = {"0" * 32: {"id": "0" * 32, "snapshot": {}, "deletedAt": "not a date"}}
    store.path.write_text(json.dumps(raw))
    before = store.path.read_bytes()
    assert client.get("/api/projects").status_code == 507
    assert store.path.read_bytes() == before
