"""A refused node delete: the person reads written copy, agents keep the detail.

Review of error-copy round 2: the canvas alert read "Couldn't delete the node.
Cannot delete n3: it has unresolved World Labs paid state. Check Marble, then
resolve its exact recovery/ambiguity record first." and "Couldn't delete the
node. Node n3 not found": an internal id and technical words (GM: never ids
in what the person reads). GM's split for refusals (error-copy round 2):
"People get the written line and agents keep the specific detail." The
person's canvas is a browser page (Origin or Sec-Fetch-Site) with no agent
marker, with or without this launch's person token (a plain tab has none).
Both person paths that delete a node are covered: DELETE /api/graph/node/{id}
and the canvas's undo/redo (POST /api/graph/restore).
"""
from __future__ import annotations

import re

import pytest
from fastapi.testclient import TestClient

from services.agent_presence import AgentPresence
from services.canvas_events import CanvasEventJournal
from services.canvas_pins import CanvasPins
from services.canvas_proposals import ProposalBook
from services.cli_graph import CLIGraph
from services.project_store import ProjectStore, make_project
from services.provider_recovery import ProviderRecoveryStore
from services.provider_start_guard import ProviderStartGuard
from tests.conftest import CANVAS_PARAMS_VERSION, FORGED_ORIGIN, PERSON

AGENT = {"X-Nebula-Agent": "Claude"}
CLI = {"X-Nebula-Client": "nebula-cli"}
# The packaged desktop renderer (a file: page) sends no Origin, but does send Sec-Fetch-Site.
DESKTOP = {"Sec-Fetch-Site": "same-site", **CANVAS_PARAMS_VERSION}

# Round 3 (GM): "'settle' and 'start' are internal." These nodes' start is
# still in flight (has_active_node), so the line says to let the run finish;
# tests/test_error_copy_round3.py has the line for each other record.
PAID_PERSON = "A World Labs run is still starting. Try again in a moment."  # GM, round 13 of PR #114
GONE_PERSON = "That node isn't on the canvas anymore."


@pytest.fixture
def api(tmp_path, monkeypatch, person):
    import main as main_module

    graph = CLIGraph(persist_path=tmp_path / "state.json")
    store = ProjectStore(tmp_path / "projects")
    with store.transaction() as catalog:
        project = make_project("Active")
        catalog["projects"][project["id"]] = project
        catalog["activeProjectId"] = project["id"]
        store.commit(catalog)
    guard = ProviderStartGuard(tmp_path / "paid-starts.json")

    async def capture(_data):
        return None

    monkeypatch.setattr(main_module, "cli_graph", graph)
    monkeypatch.setattr(main_module, "project_store", store)
    monkeypatch.setattr(main_module, "canvas_pins", CanvasPins(lambda: main_module.project_store))
    monkeypatch.setattr(main_module, "canvas_proposals", ProposalBook())
    monkeypatch.setattr(main_module, "agent_presence", AgentPresence())
    monkeypatch.setattr(main_module, "canvas_events", CanvasEventJournal())
    monkeypatch.setattr(main_module, "provider_recovery_store", ProviderRecoveryStore(None))
    monkeypatch.setattr(main_module, "provider_start_guard", guard)
    monkeypatch.setattr(main_module, "_graph_recovery_bootstrap_error", None)
    monkeypatch.setattr(main_module.manager, "broadcast_raw", capture)
    monkeypatch.setattr(main_module.manager, "broadcast_browser", capture)

    class Api:
        pass

    ctx = Api()
    ctx.client = TestClient(main_module.app)
    ctx.graph = graph
    ctx.guard = guard
    return ctx


def _paid_node(api, monkeypatch) -> str:
    node = api.graph.add_node("text-input", {"value": "a lighthouse"}, position={"x": 0, "y": 0})
    monkeypatch.setattr(api.guard, "has_active_node", lambda node_id: node_id == node)
    return node


def _no_id(text: str) -> None:
    assert not re.search(r"\bn\d+\b", text), text


@pytest.mark.parametrize("headers", [PERSON, FORGED_ORIGIN, DESKTOP], ids=["person", "plain-tab", "desktop"])
def test_the_canvas_delete_of_a_node_with_paid_state_says_written_copy(api, monkeypatch, headers):
    node = _paid_node(api, monkeypatch)
    response = api.client.delete(f"/api/graph/node/{node}", headers=headers)
    assert response.status_code == 409
    assert response.json()["detail"] == PAID_PERSON
    _no_id(response.json()["detail"])
    assert node in api.graph.nodes


@pytest.mark.parametrize("headers", [AGENT, CLI, {}], ids=["agent", "cli", "script"])
def test_an_agent_keeps_the_specific_paid_state_detail(api, monkeypatch, headers):
    node = _paid_node(api, monkeypatch)
    response = api.client.delete(f"/api/graph/node/{node}", headers=headers)
    assert response.status_code == 409
    assert response.json()["detail"] == (
        f"Cannot delete {node}: it has unresolved World Labs paid state. "
        "Check Marble, then resolve its exact recovery/ambiguity record first.")


def test_an_agent_marker_wins_over_a_browser_origin(api, monkeypatch):
    node = _paid_node(api, monkeypatch)
    response = api.client.delete(f"/api/graph/node/{node}", headers={**FORGED_ORIGIN, **AGENT})
    assert response.json()["detail"].startswith(f"Cannot delete {node}:")


def test_a_node_already_gone_says_written_copy_to_the_canvas(api):
    canvas = api.client.delete("/api/graph/node/n9", headers=PERSON)
    assert canvas.status_code == 404
    assert canvas.json()["detail"] == GONE_PERSON
    agent = api.client.delete("/api/graph/node/n9", headers=AGENT)
    assert agent.status_code == 404
    assert agent.json()["detail"].startswith("Node n9 not found. ") and "read the canvas again" in agent.json()["detail"]


def test_the_canvas_undo_that_would_remove_a_node_with_paid_state_says_written_copy(api, monkeypatch):
    node = _paid_node(api, monkeypatch)
    canvas = api.client.post("/api/graph/restore", headers=PERSON, json={"action": "undo", "remove": [node]})
    assert canvas.status_code == 409
    assert canvas.json()["detail"] == PAID_PERSON
    agent = api.client.post("/api/graph/restore", headers=AGENT, json={"action": "undo", "remove": [node]})
    assert agent.status_code == 409
    assert agent.json()["detail"].startswith(f"Cannot delete {node}: it has unresolved World Labs paid state.")
    assert node in api.graph.nodes
