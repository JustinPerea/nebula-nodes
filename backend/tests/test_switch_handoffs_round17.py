"""Round 17 of PR #114, review 16 M1: one save handoff per project an agent's
switches left, not only the last one.

A tab that is offline (or only thinks it is) while an agent switches twice
holds its last unsaved changes for the project it was showing. Before this
round the backend kept a single handoff, the next switch replaced it, and the
tab's held save for the first project got 409, which the tab turned into a
"(recovered)" copy of work that was already saved (live, review 16 F and G).
"""
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

AGENT = {"X-Nebula-Agent": "Codex"}


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
    return TestClient(main_module.app), graph, store


def _create(client, name, revision=None, headers=None):
    body = {"name": name, **({"workspaceRevision": revision} if revision else {})}
    response = client.post("/api/projects", json=body, headers=headers or {})
    assert response.status_code == 200, response.text
    return response.json()


def _open(client, project_id, revision, headers=None):
    response = client.post(f"/api/projects/{project_id}/open", json={"workspaceRevision": revision},
                           headers=headers or {})
    assert response.status_code == 200, response.text
    return response.json()


def _tab(*node_ids: str, viewport=None) -> dict:
    return {"nodes": [{"id": node_id, "type": "model-node", "position": {"x": 0, "y": 0},
                       "data": {"definitionId": "text-input", "params": {"value": node_id}, "outputs": {}}}
                      for node_id in node_ids],
            "edges": [], "runHistory": [], "viewport": viewport or {"x": 0, "y": 0, "zoom": 1},
            "createSessionId": None}


def test_a_tab_offline_through_two_agent_switches_still_saves_into_its_own_project(workspace, person):
    """Review 16 F: A, then the agent makes B, then C. The tab's held save
    for A lands in A (no 409, so no recovered copy)."""
    client, _, store = workspace
    mine = _create(client, "Recovered canvas", headers=person.headers)
    a_id, a_revision = mine["project"]["id"], mine["workspaceRevision"]
    b = _create(client, "Agent B", a_revision, headers=AGENT)
    c = _create(client, "Agent C", b["workspaceRevision"], headers=AGENT)

    saved = client.put(f"/api/projects/{a_id}", json={"snapshot": _tab("local-sticky"), "workspaceRevision": a_revision},
                       headers=person.headers)
    assert saved.status_code == 200, saved.text
    assert saved.json()["handoff"] is True
    catalog = store.read()
    assert [node["id"] for node in catalog["projects"][a_id]["snapshot"]["nodes"]] == ["local-sticky"]
    # B keeps its own handoff too, at its own revision.
    b_saved = client.put(f"/api/projects/{b['project']['id']}",
                         json={"snapshot": _tab(), "workspaceRevision": b["workspaceRevision"]}, headers=person.headers)
    assert b_saved.status_code == 200, b_saved.text
    assert catalog["activeProjectId"] == c["project"]["id"]
    assert len(catalog["projects"]) == 3


def test_a_project_reopened_by_the_agent_ends_its_handoff(workspace, person):
    """Review 16 G: C, then D, then back to C. C was opened again from what
    it had saved, so the tab's old save for C is refused (the tab then
    compares it with what C has saved before making any copy)."""
    client, _, store = workspace
    mine = _create(client, "Agent C", headers=person.headers)
    c_id, c_revision = mine["project"]["id"], mine["workspaceRevision"]
    d = _create(client, "Agent D", c_revision, headers=AGENT)
    _open(client, c_id, d["workspaceRevision"], headers=AGENT)
    late = client.put(f"/api/projects/{c_id}", json={"snapshot": _tab("x"), "workspaceRevision": c_revision},
                      headers=person.headers)
    assert late.status_code == 409
    # D, which the reopen left, takes the tab's save at D's revision.
    assert set(store.read()["handoffs"]) == {d["project"]["id"]}


def test_the_persons_own_switch_ends_every_handoff(workspace, person):
    client, _, store = workspace
    mine = _create(client, "Mine", headers=person.headers)
    b = _create(client, "Agent B", mine["workspaceRevision"], headers=AGENT)
    c = _create(client, "Agent C", b["workspaceRevision"], headers=AGENT)
    assert set(store.read()["handoffs"]) == {mine["project"]["id"], b["project"]["id"]}
    _create(client, "Person's next", c["workspaceRevision"], headers=person.headers)
    catalog = store.read()
    assert "handoffs" not in catalog and "handoff" not in catalog
    late = client.put(f"/api/projects/{mine['project']['id']}",
                      json={"snapshot": _tab(), "workspaceRevision": mine["workspaceRevision"]}, headers=person.headers)
    assert late.status_code == 409


def test_handoffs_are_bounded_oldest_first(workspace, person):
    client, _, store = workspace
    first = _create(client, "First", headers=person.headers)
    revision = first["workspaceRevision"]
    left = [first["project"]["id"]]
    for index in range(main_module._MAX_SWITCH_HANDOFFS + 3):
        made = _create(client, f"Agent {index}", revision, headers=AGENT)
        revision = made["workspaceRevision"]
        left.append(made["project"]["id"])
    handoffs = store.read()["handoffs"]
    assert len(handoffs) == main_module._MAX_SWITCH_HANDOFFS
    assert first["project"]["id"] not in handoffs
    # The newest projects left are kept (the open one, the last made, has none).
    assert list(handoffs) == left[-main_module._MAX_SWITCH_HANDOFFS - 1:-1]


def test_a_catalog_with_the_old_single_handoff_still_takes_that_save(workspace, person):
    """A catalog written before round 17 kept ``handoff`` ({projectId,
    revision}); it reads as one of the handoffs."""
    client, _, store = workspace
    mine = _create(client, "Mine", headers=person.headers)
    made = _create(client, "Agent's", mine["workspaceRevision"], headers=AGENT)
    with store.transaction() as catalog:
        handoffs = catalog.pop("handoffs")
        catalog["handoff"] = {"projectId": mine["project"]["id"], "revision": handoffs[mine["project"]["id"]]}
        store.commit(catalog)
    saved = client.put(f"/api/projects/{mine['project']['id']}",
                       json={"snapshot": _tab("old"), "workspaceRevision": mine["workspaceRevision"]},
                       headers=person.headers)
    assert saved.status_code == 200 and saved.json()["handoff"] is True, saved.text
    # The next agent switch writes the new form and keeps that handoff.
    _create(client, "Agent's next", made["workspaceRevision"], headers=AGENT)
    catalog = store.read()
    assert "handoff" not in catalog
    assert mine["project"]["id"] in catalog["handoffs"]
