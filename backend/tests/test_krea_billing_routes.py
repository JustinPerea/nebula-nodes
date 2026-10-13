"""Only the person moves a Krea node onto the plan: on runs and project snapshots too.

The edit routes refuse an agent's change to ``_kreaAuth`` (tests/test_graph_apply.py).
These are the other ways a node's params reach the canvas or a provider: run
routes that take params in the request, the params a run writes back to the
canvas, and project snapshots that load onto the canvas when opened.
"""
from __future__ import annotations

import sys
import time
from pathlib import Path
from unittest.mock import AsyncMock

import pytest
from fastapi.testclient import TestClient

sys.path.insert(0, str(Path(__file__).resolve().parent.parent))

from services import agent_spend  # noqa: E402
from services.cli_graph import CLIGraph  # noqa: E402
from services.project_store import ProjectStore  # noqa: E402
from tests.conftest import FORGED_ORIGIN, PERSON  # noqa: E402

DUAL = "krea-2-generate"  # bills the API token or the signed-in plan
AGENT = {"X-Nebula-Agent": "Codex"}
REFUSED = "is the person's call"


async def runs_nothing(*, nodes, run_id=None, **kwargs):
    """A stand-in engine: each node reaches its handler (so its count stays) and changes nothing."""
    from execution import provider_calls

    for node in nodes:
        provider_calls.mark(run_id, node.id)


@pytest.fixture
def client(monkeypatch, person, tmp_path):
    import main

    monkeypatch.setattr(main, "cli_graph", CLIGraph(persist_path=tmp_path / "state.json"))
    monkeypatch.setattr(main, "project_store", ProjectStore(tmp_path / "projects"))
    monkeypatch.setattr(main.model_pricing, "load_pricing", lambda path=None: {"nodes": {}})
    monkeypatch.setattr(main, "execute_graph", AsyncMock(side_effect=runs_nothing))
    monkeypatch.setattr(main, "agent_spend_ledger", agent_spend.SpendLedger(None))
    # These graphs have no keys or prompts; what's tested is who may bill what.
    monkeypatch.setattr(main, "validate_graph", lambda *args, **kwargs: [])
    test_client = TestClient(main.app)
    limits = {"runCostConfirmUsd": None, "agentSpend": {"sessionUsd": None, "kreaPlanRuns": None, "models": {}}}
    assert test_client.put("/api/settings", json=limits, headers=PERSON).status_code == 200
    yield test_client
    test_client.put("/api/settings", json={"runCostConfirmUsd": 1, "agentSpend": {"sessionUsd": None, "models": {}}},
                    headers=PERSON)


def add_node(client, definition_id: str, params: dict) -> str:
    response = client.post("/api/graph/node", json={"definitionId": definition_id, "params": params}, headers=PERSON)
    assert response.status_code == 200, response.text
    return response.json()["id"]


def wait_for(client, run_id: str) -> None:
    for _ in range(200):
        response = client.get(f"/api/executions/{run_id}")
        if response.status_code == 404 or response.json()["status"] not in {"running", "cancelling"}:
            return
        time.sleep(0.01)
    raise AssertionError(f"run {run_id} never finished")


def billing(node_id: str) -> tuple[str, str | None]:
    import main

    node = main.cli_graph.nodes[node_id]
    return node["definitionId"], node["params"].get("_kreaAuth")


# -- run routes that take params in the request ------------------------------------

def on_plan(node_id: str = "n1") -> dict:
    return {"id": node_id, "definitionId": DUAL, "params": {"seed": 1, "_kreaAuth": "mcp"}}


@pytest.mark.parametrize("headers", [{}, AGENT, FORGED_ORIGIN])
def test_a_run_request_cant_bill_a_node_to_the_plan(client, headers):
    import main

    for route, body in (
        ("/api/execute", {"nodes": [on_plan()], "edges": []}),
        ("/api/execute-node", {"nodes": [on_plan()], "edges": [], "targetNodeId": "n1"}),
        ("/api/quick", {"definitionId": DUAL, "params": {"_kreaAuth": "mcp"}, "inputs": {"prompt": "a cat"}}),
    ):
        response = client.post(route, json=body, headers=headers)
        assert response.status_code == 403, (route, response.text)
        assert REFUSED in response.json()["detail"] and "propose_change" in response.json()["detail"]
    main.execute_graph.assert_not_awaited()
    assert main.agent_spend_ledger.spent_outside() == agent_spend.Spent()


def test_a_run_request_can_bill_a_node_the_way_its_canvas_node_does(client):
    import main

    # The person put this node on the plan; an agent may run it as it is.
    node_id = add_node(client, DUAL, {"seed": 1, "_kreaAuth": "mcp"})
    response = client.post("/api/execute", json={"nodes": [on_plan(node_id)], "edges": []}, headers=AGENT)
    assert response.status_code == 200, response.text
    wait_for(client, response.json()["runId"])
    assert main.agent_spend_ledger.spent_outside().plan_runs == 1
    # And on the API token, which is the default, anywhere.
    api_token = {"definitionId": DUAL, "params": {"_kreaAuth": "api-token"}, "inputs": {"prompt": "a cat"}}
    assert client.post("/api/quick", json=api_token, headers=AGENT).status_code == 200


def test_a_canvas_node_on_the_api_token_cant_be_run_on_the_plan(client):
    node_id = add_node(client, DUAL, {"seed": 1})
    response = client.post("/api/execute-node", json={"nodes": [on_plan(node_id)], "edges": [], "targetNodeId": node_id},
                           headers=AGENT)
    assert response.status_code == 403 and REFUSED in response.json()["detail"]


def test_the_persons_runs_may_bill_the_plan(client):
    import main

    response = client.post("/api/execute", json={"nodes": [on_plan()], "edges": []}, headers=PERSON)
    assert response.status_code == 200, response.text
    wait_for(client, response.json()["runId"])
    quick = {"definitionId": DUAL, "params": {"_kreaAuth": "mcp"}, "inputs": {"prompt": "a cat"}}
    assert client.post("/api/quick", json=quick, headers=PERSON).status_code == 200
    assert main.execute_graph.await_count == 2


# -- what a run writes back to the canvas ------------------------------------------

def test_a_run_reusing_a_canvas_nodes_id_cant_rewrite_it(client):
    """An agent ran a free node under the id of a Krea node on the API token,
    with _kreaAuth in its params: the run's params must not land on the Krea node."""
    import main

    node_id = add_node(client, DUAL, {"seed": 1})
    imposter = {"id": node_id, "definitionId": "text-input", "params": {"value": "hi", "_kreaAuth": "mcp"}}
    response = client.post("/api/execute", json={"nodes": [imposter], "edges": []}, headers=AGENT)
    assert response.status_code == 200, response.text
    wait_for(client, response.json()["runId"])
    assert billing(node_id) == (DUAL, None)
    assert main.cli_graph.nodes[node_id]["params"] == {"seed": 1}


def test_an_agents_run_writes_back_only_what_the_run_changed(client, monkeypatch):
    import main

    node_id = add_node(client, DUAL, {"seed": 1})

    async def enriches(*, nodes, run_id=None, **kwargs):
        nodes[0].params["resolution"] = "2K"  # what a handler adds while it runs

    monkeypatch.setattr(main, "execute_graph", AsyncMock(side_effect=enriches))
    sent = {"id": node_id, "definitionId": DUAL, "params": {"seed": 2}}
    response = client.post("/api/execute", json={"nodes": [sent], "edges": []}, headers=AGENT)
    assert response.status_code == 200, response.text
    wait_for(client, response.json()["runId"])
    # The handler's addition lands; the request's own edit doesn't (edits have their own routes).
    assert main.cli_graph.nodes[node_id]["params"] == {"seed": 1, "resolution": "2K"}


def test_the_sync_never_writes_billing_from_a_request_that_isnt_the_persons():
    import main
    from models.graph import GraphNode

    graph = CLIGraph()
    node_id = graph.add_node(DUAL, {"seed": 1, "_kreaAuth": "api-token"})
    original, main.cli_graph = main.cli_graph, graph
    try:
        node = GraphNode(id=node_id, definition_id=DUAL, params={"seed": 1}, outputs={})
        submitted = {node_id: dict(node.params)}
        node.params["_kreaAuth"] = "mcp"  # even if a handler set it
        main._sync_params_to_cli_graph([node], submitted=submitted)
        assert graph.nodes[node_id]["params"]["_kreaAuth"] == "api-token"
        # The person's run (no ``submitted``) still mirrors its params, as before.
        assert main._sync_params_to_cli_graph([node]) is True
        assert graph.nodes[node_id]["params"]["_kreaAuth"] == "mcp"
        # Never onto a node of another definition, whoever ran it.
        other = GraphNode(id=node_id, definition_id="text-input", params={"value": "x"}, outputs={})
        assert main._sync_params_to_cli_graph([other]) is False
    finally:
        main.cli_graph = original


# -- project snapshots -------------------------------------------------------------

def snapshot_with(node_id: str, params: dict) -> dict:
    return {"nodes": [{"id": node_id, "type": "model-node", "position": {"x": 0, "y": 0},
                       "data": {"definitionId": DUAL, "params": params, "outputs": {}}}], "edges": []}


def new_project(client, name: str, revision: str | None = None) -> dict:
    body = {"name": name, **({"workspaceRevision": revision} if revision else {})}
    response = client.post("/api/projects", json=body, headers=PERSON)
    assert response.status_code == 200, response.text
    return response.json()


@pytest.mark.parametrize("headers", [{}, AGENT, FORGED_ORIGIN])
def test_a_snapshot_save_cant_put_a_node_on_the_plan(client, headers):
    import main

    first = new_project(client, "First")
    project_id = first["project"]["id"]
    body = {"workspaceRevision": first["workspaceRevision"], "snapshot": snapshot_with("zz1", {"_kreaAuth": "mcp"})}
    response = client.put(f"/api/projects/{project_id}", json=body, headers=headers)
    assert response.status_code == 403 and REFUSED in response.json()["detail"]
    # So switching away and back can't load it onto the canvas.
    second = new_project(client, "Second", first["workspaceRevision"])
    opened = client.post(f"/api/projects/{project_id}/open", json={"workspaceRevision": second["workspaceRevision"]},
                         headers=headers)
    assert opened.status_code == 200, opened.text
    assert "zz1" not in main.cli_graph.nodes


def test_a_snapshot_save_cant_switch_a_live_node_to_the_plan(client):
    first = new_project(client, "First")
    node_id = add_node(client, DUAL, {"seed": 1})
    body = {"workspaceRevision": first["workspaceRevision"],
            "snapshot": snapshot_with(node_id, {"seed": 1, "_kreaAuth": "mcp"})}
    response = client.put(f"/api/projects/{first['project']['id']}", json=body, headers=AGENT)
    assert response.status_code == 403 and REFUSED in response.json()["detail"]


def test_snapshots_keep_the_persons_billing_and_the_person_may_change_it(client):
    import main

    first = new_project(client, "First")
    project_id = first["project"]["id"]
    plan = {"workspaceRevision": first["workspaceRevision"], "snapshot": snapshot_with("zz1", {"_kreaAuth": "mcp"})}
    assert client.put(f"/api/projects/{project_id}", json=plan, headers=PERSON).status_code == 200
    # An agent's (or a canvas tab's) autosave that leaves it as it is passes.
    assert client.put(f"/api/projects/{project_id}", json=plan, headers=AGENT).status_code == 200
    second = new_project(client, "Second", first["workspaceRevision"])
    opened = client.post(f"/api/projects/{project_id}/open", json={"workspaceRevision": second["workspaceRevision"]})
    assert opened.status_code == 200, opened.text
    assert billing("zz1") == (DUAL, "mcp")
    assert main.cli_graph.nodes["zz1"]["params"]["_kreaAuth"] == "mcp"


def test_a_recovered_copy_cant_put_a_node_on_the_plan(client):
    from uuid import uuid4

    first = new_project(client, "First")
    body = {"sourceProjectId": first["project"]["id"], "recoveryId": uuid4().hex,
            "snapshot": snapshot_with("zz1", {"_kreaAuth": "mcp"})}
    response = client.post("/api/projects/recover", json=body, headers=AGENT)
    assert response.status_code == 403 and REFUSED in response.json()["detail"]
    assert client.post("/api/projects/recover", json=body, headers=PERSON).status_code == 200
