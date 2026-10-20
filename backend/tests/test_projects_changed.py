"""The Projects screen follows projects other writers change (an agent, the
CLI, another tab): every change to the saved-project list sends
``projectsChanged`` over the socket, and the screen lists again
(frontend projectStore). graphSync alone only follows the open project."""
from __future__ import annotations

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

AGENT = {"X-Nebula-Agent": "Claude Code"}


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
    return TestClient(main_module.app), broadcast


def _changes(broadcast) -> list[dict]:
    return [call.args[0] for call in broadcast.call_args_list
            if call.args and call.args[0].get("type") == "projectsChanged"]


def _create(client, name, headers=None) -> dict:
    revision = client.get("/api/projects").json()["workspaceRevision"]
    response = client.post("/api/projects", json={"name": name, "workspaceRevision": revision}, headers=headers or {})
    assert response.status_code == 200, response.text
    return response.json()


def test_an_agents_new_project_on_an_empty_workspace_is_announced_to_the_projects_screen(workspace):
    client, broadcast = workspace
    revision = client.get("/api/projects").json()["workspaceRevision"]

    made = _create(client, "Summer campaign", headers=AGENT)

    sync = next(event for event in (call.args[0] for call in broadcast.call_args_list) if event.get("type") == "graphSync")
    # A tab on Projects with nothing open follows from the revision it listed.
    assert sync["projectSwitch"]["previousRevision"] == revision
    assert sync["projectSwitch"]["previousProjectId"] is None
    assert _changes(broadcast) == [{"type": "projectsChanged", "change": "created", "projectId": made["project"]["id"]}]


def test_every_change_to_the_project_list_is_announced(workspace, person):
    client, broadcast = workspace
    first = _create(client, "First")
    second = _create(client, "Second")
    first_id, second_id = first["project"]["id"], second["project"]["id"]
    broadcast.reset_mock()

    revision = client.get("/api/projects").json()["workspaceRevision"]
    assert client.post(f"/api/projects/{first_id}/open", json={"workspaceRevision": revision}, headers=AGENT).status_code == 200
    assert client.put(f"/api/projects/{second_id}", json={"name": "Renamed by the CLI"}).status_code == 200
    revision = client.get("/api/projects").json()["workspaceRevision"]
    snapshot = client.get(f"/api/projects/{first_id}").json()["snapshot"]
    assert client.put(f"/api/projects/{first_id}", json={"snapshot": snapshot, "workspaceRevision": revision}).status_code == 200
    revision = client.get("/api/projects").json()["workspaceRevision"]
    assert client.request("DELETE", f"/api/projects/{second_id}", json={"workspaceRevision": revision}).status_code == 200
    assert client.post(f"/api/projects/{second_id}/restore").status_code == 200
    revision = client.get("/api/projects").json()["workspaceRevision"]
    assert client.request("DELETE", f"/api/projects/{second_id}", json={"workspaceRevision": revision}).status_code == 200
    assert client.request("DELETE", f"/api/projects/trash/{second_id}", headers=person.headers).status_code == 200

    assert [(event["change"], event["projectId"]) for event in _changes(broadcast)] == [
        ("opened", first_id), ("renamed", second_id), ("saved", first_id), ("deleted", second_id),
        ("restored", second_id), ("deleted", second_id), ("purged", second_id),
    ]


def test_trash_routes_shared_with_assets_announce_project_changes_too(workspace, person):
    client, broadcast = workspace
    made = _create(client, "Old idea")
    project_id = made["project"]["id"]
    revision = client.get("/api/projects").json()["workspaceRevision"]
    assert client.request("DELETE", f"/api/projects/{project_id}", json={"workspaceRevision": revision}).status_code == 200
    broadcast.reset_mock()

    assert client.post(f"/api/trash/project/{project_id}/restore").status_code == 200
    revision = client.get("/api/projects").json()["workspaceRevision"]
    assert client.request("DELETE", f"/api/projects/{project_id}", json={"workspaceRevision": revision}).status_code == 200
    assert client.post("/api/trash/empty", json={}, headers=person.headers).status_code == 200

    assert [event["change"] for event in _changes(broadcast)] == ["restored", "deleted", "purged"]


def test_a_failed_change_announces_nothing(workspace):
    client, broadcast = workspace
    made = _create(client, "Kept")
    broadcast.reset_mock()

    assert client.put(f"/api/projects/{made['project']['id']}", json={"name": ""}).status_code == 400
    assert client.post("/api/projects", json={"name": "Late", "workspaceRevision": "stale"}).status_code == 409
    assert client.post(f"/api/projects/{'0' * 32}/restore").status_code == 404

    assert _changes(broadcast) == []
