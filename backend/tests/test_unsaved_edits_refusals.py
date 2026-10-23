"""Q116 a) (Justin, 2026-10-23): "a): "Download your edits" plus "Continue
without them"."

A stale tab saves its unsaved edits as a recovered project
(POST /api/projects/recover). When the backend refuses that copy for good,
the Projects screen offers to download the edits instead of a Try again that
sends the same copy into the same refusal. The screen tells the refusals
apart by status and, where the backend gives one, a structured field, never
by the words. GM - Design's "too large" line is for a copy that is itself
too big; the store's own limits (how many projects, how big the whole
catalog is) are 413s too, so their answer says which limit it was:
``limit: "projects"`` or ``limit: "storage"``, beside the same ``detail``
agents read.
"""
from __future__ import annotations

import sys
from pathlib import Path
from unittest.mock import AsyncMock
from uuid import uuid4

import pytest
from fastapi.testclient import TestClient

sys.path.insert(0, str(Path(__file__).resolve().parent.parent))
import main as main_module
import services.project_store as project_store_module
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
    monkeypatch.setattr(main_module.manager, "broadcast_raw", AsyncMock())
    return TestClient(main_module.app), store


def _snapshot(value: str = "unsaved edit") -> dict:
    return {
        "nodes": [{"id": "n1", "type": "model-node", "position": {"x": 0, "y": 0},
                   "data": {"definitionId": "text-input", "label": "Prompt", "params": {"value": value}, "outputs": {}}}],
        "edges": [], "runHistory": [], "viewport": None, "createSessionId": None,
    }


def _source(client: TestClient) -> str:
    response = client.post("/api/projects", json={"name": "Glass campaign"})
    assert response.status_code == 200, response.text
    return response.json()["project"]["id"]


def _recover(client: TestClient, source_id: str, snapshot: dict | None = None):
    return client.post("/api/projects/recover", json={
        "sourceProjectId": source_id, "recoveryId": uuid4().hex, "snapshot": snapshot or _snapshot(),
        "paramsVersion": main_module.PARAMS_VERSION,
    })


def test_a_copy_too_large_to_save_is_a_413_with_no_store_limit(workspace, monkeypatch):
    client, _ = workspace
    source = _source(client)
    monkeypatch.setattr(main_module, "MAX_PROJECT_BYTES", 256)
    response = _recover(client, source, _snapshot("x" * 1024))
    assert response.status_code == 413
    # Word for word, as agents and the CLI read it.
    assert response.json()["detail"] == "Project snapshot exceeds the 16 MiB limit"
    assert "limit" not in response.json()


def test_the_project_count_limit_says_which_limit(workspace, monkeypatch):
    client, _ = workspace
    source = _source(client)
    monkeypatch.setattr(project_store_module, "MAX_PROJECTS", 1)
    response = _recover(client, source)
    assert response.status_code == 413
    assert response.json() == {"detail": "Project limit reached", "limit": "projects"}


def test_the_catalog_size_limit_says_which_limit(workspace, monkeypatch):
    client, store = workspace
    source = _source(client)
    # Room for the catalog as it is (reads refuse one past the limit), not
    # for the copy on top of it.
    monkeypatch.setattr(project_store_module, "MAX_CATALOG_BYTES", store.path.stat().st_size + 16)
    response = _recover(client, source)
    assert response.status_code == 413
    assert response.json() == {"detail": "Project storage limit reached", "limit": "storage"}


def test_a_store_limit_on_any_route_keeps_its_detail_and_says_which_limit(workspace, monkeypatch):
    client, _ = workspace
    _source(client)
    monkeypatch.setattr(project_store_module, "MAX_PROJECTS", 1)
    # A create (an agent's new_project goes here too) over the count limit.
    response = client.post("/api/projects", json={"name": "One too many"})
    assert response.status_code == 413
    assert response.json() == {"detail": "Project limit reached", "limit": "projects"}


def test_a_storage_failure_stays_a_507_with_no_limit(workspace, monkeypatch):
    client, store = workspace
    source = _source(client)

    def fail(*_args, **_kwargs):
        raise OSError("simulated recovery failure")

    monkeypatch.setattr(store, "prepare", fail)
    response = _recover(client, source)
    # A failure a retry can fix: the screen keeps Try again for it.
    assert response.status_code == 507
    assert "limit" not in response.json()


# -- review: a tab that isn't connected as the person -------------------------
#
# A tab whose person token is from an earlier launch (Nebula restarted) or
# missing sends the same snapshot the person would. When that copy changes
# who bills a node, the billing gate refuses it because the request isn't the
# person's. Reconnecting fixes that, so it isn't a refusal for good: the
# answer says person_required (as require_person's do), the canvas shows its
# reconnect banner and keeps Try again. The detail stays word for word, for
# the CLI and scripts that read it; an agent's refusal is unchanged.

KREA_DUAL = "krea-2-generate"  # bills the API token or the signed-in plan
STALE_PERSON = {"Origin": "http://localhost:5173", "X-Nebula-Person": "stale-person-token-" + "1" * 24,
                "X-Nebula-Params-Version": str(main_module.PARAMS_VERSION)}
BILLING_REFUSED = "is the person's call"


def _on_plan() -> dict:
    return {"nodes": [{"id": "zz1", "type": "model-node", "position": {"x": 0, "y": 0},
                       "data": {"definitionId": KREA_DUAL, "params": {"_kreaAuth": "mcp"}, "outputs": {}}}],
            "edges": [], "runHistory": [], "viewport": None, "createSessionId": None}


@pytest.mark.parametrize("headers", [{}, STALE_PERSON], ids=["no-person-token", "stale-person-token"])
def test_a_billing_change_from_a_tab_not_connected_as_the_person_says_person_required(workspace, person, headers):
    client, _ = workspace
    source = _source(client)
    response = client.post("/api/projects/recover", headers=headers, json={
        "sourceProjectId": source, "recoveryId": uuid4().hex, "snapshot": _on_plan(),
        "paramsVersion": main_module.PARAMS_VERSION,
    })
    assert response.status_code == 403, response.text
    body = response.json()
    assert body["code"] == "person_required"
    assert BILLING_REFUSED in body["detail"] and "propose_change" in body["detail"]


def test_an_autosave_from_a_tab_not_connected_as_the_person_says_person_required(workspace, person):
    client, _ = workspace
    created = client.post("/api/projects", json={"name": "Glass campaign"}).json()
    response = client.put(f"/api/projects/{created['project']['id']}", headers=STALE_PERSON, json={
        "workspaceRevision": created["workspaceRevision"], "snapshot": _on_plan(),
    })
    assert response.status_code == 403, response.text
    assert response.json()["code"] == "person_required"
    assert BILLING_REFUSED in response.json()["detail"]


def test_an_agents_billing_change_keeps_its_plain_refusal(workspace, person):
    client, _ = workspace
    source = _source(client)
    response = client.post("/api/projects/recover", headers={"X-Nebula-Agent": "Codex"}, json={
        "sourceProjectId": source, "recoveryId": uuid4().hex, "snapshot": _on_plan(),
        "paramsVersion": main_module.PARAMS_VERSION,
    })
    assert response.status_code == 403
    assert "code" not in response.json()
    assert BILLING_REFUSED in response.json()["detail"]
