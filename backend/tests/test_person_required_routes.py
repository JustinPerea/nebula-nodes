"""Every person-only refusal a canvas tab can get says so: ``code: person_required``.

GM - Design, 2026-10-23 (Q116 a), for the line under "Couldn't recover the
project.": "Use it for every person-only refusal, not just Krea billing. The
agents' text stays behind Details." The canvas classifies a refusal by its
``code``, never its words, so every route that refuses a request only because
it isn't the person's (who bills a node, a run the person approved, the agent
spending limits the person isn't held to) answers a request with no agent
marker the way require_person does: 403, ``code: "person_required"``, and the
same ``detail`` word for word. That is a tab without the person token (one
opened without the launch link, or holding a token from before Nebula
restarted), and also curl or the CLI without NEBULA_AGENT_NAME.

Nothing new is allowed: each case checks the refusal still happens (same
status, same detail, nothing ran or changed), and that an agent with a marker
gets exactly what it got before, ``{"detail": ...}`` with no ``code``.
"""
from __future__ import annotations

import sys
from pathlib import Path
from unittest.mock import AsyncMock

import pytest
from fastapi.testclient import TestClient

sys.path.insert(0, str(Path(__file__).resolve().parent.parent))

from services import agent_spend  # noqa: E402
from services.cli_graph import CLIGraph  # noqa: E402
from services.project_store import ProjectStore, make_project  # noqa: E402
from services.saved_graph_upgrades import PARAMS_VERSION  # noqa: E402
from tests.conftest import FORGED_ORIGIN, PERSON  # noqa: E402

DUAL = "krea-2-generate"  # bills the API token or the signed-in Krea plan
ROUTED = "flux-2-pro"  # a route-table node: Auto, bfl or fal
PAID = "gpt-image-1-generate"
AGENT = {"X-Nebula-Agent": "Codex"}
STALE_PERSON = {**FORGED_ORIGIN, "X-Nebula-Person": "stale-person-token-" + "1" * 24}
# A canvas tab with no person token, and one whose token is from an earlier launch.
UNMARKED = [FORGED_ORIGIN, STALE_PERSON]
UNMARKED_IDS = ["no-person-token", "stale-person-token"]


async def runs_nothing(*, nodes, run_id=None, **kwargs):
    from execution import provider_calls

    for node in nodes:
        provider_calls.mark(run_id, node.id)


PRICES: dict = {"nodes": {}}


@pytest.fixture
def client(monkeypatch, person, tmp_path):
    import main

    store = ProjectStore(tmp_path / "projects")
    with store.transaction() as catalog:
        project = make_project("Active")
        catalog["projects"][project["id"]] = project
        catalog["activeProjectId"] = project["id"]
        store.commit(catalog)
    monkeypatch.setenv("NEBULA_PRESET_ROOT", str(tmp_path / "presets"))
    monkeypatch.setattr(main, "cli_graph", CLIGraph(persist_path=tmp_path / "state.json"))
    monkeypatch.setattr(main, "project_store", store)
    PRICES["nodes"] = {}
    monkeypatch.setattr(main.model_pricing, "load_pricing", lambda path=None: PRICES)
    monkeypatch.setattr(main, "execute_graph", AsyncMock(side_effect=runs_nothing))
    monkeypatch.setattr(main, "agent_spend_ledger", agent_spend.SpendLedger(None))
    # These graphs have no keys or prompts; what's tested is who may do what.
    monkeypatch.setattr(main, "validate_graph", lambda *args, **kwargs: [])

    async def ignore(data):
        return None

    monkeypatch.setattr(main.manager, "broadcast_raw", ignore)
    monkeypatch.setattr(main.manager, "broadcast_browser", ignore)
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


def graph_state() -> dict:
    import main

    return {node_id: dict(node.get("params") or {}) for node_id, node in main.cli_graph.nodes.items()}


def assert_person_required_for_unmarked(client, method: str, path: str, body: dict, headers: dict) -> str:
    """The unmarked caller is refused as before, now with the person gate's code,
    and an agent is refused with the same words and no code. Returns the detail."""
    import main

    before = graph_state()
    agent = client.request(method, path, json=body, headers=AGENT)
    assert agent.status_code == 403, (path, agent.text)
    # An agent's answer is exactly what it was: the detail, nothing else.
    assert set(agent.json()) == {"detail"}, agent.json()
    unmarked = client.request(method, path, json=body, headers=headers)
    assert unmarked.status_code == 403, (path, unmarked.text)
    assert unmarked.json() == {"detail": agent.json()["detail"], "code": "person_required"}
    # Refused, not let through: nothing changed and nothing ran.
    assert graph_state() == before
    main.execute_graph.assert_not_awaited()
    return agent.json()["detail"]


# -- who bills a node: the node edit routes -------------------------------------

@pytest.mark.parametrize("headers", UNMARKED, ids=UNMARKED_IDS)
def test_a_node_param_edit_that_switches_billing(client, headers):
    node_id = add_node(client, DUAL, {"_kreaAuth": "api-token"})
    detail = assert_person_required_for_unmarked(
        client, "PUT", f"/api/graph/node/{node_id}", {"params": {"_kreaAuth": "mcp"}}, headers)
    assert "_kreaAuth" in detail and "propose_change" in detail


@pytest.mark.parametrize("headers", UNMARKED, ids=UNMARKED_IDS)
def test_a_new_node_on_the_plan(client, headers):
    detail = assert_person_required_for_unmarked(
        client, "POST", "/api/graph/node", {"definitionId": DUAL, "params": {"_kreaAuth": "mcp"}}, headers)
    assert "_kreaAuth" in detail


@pytest.mark.parametrize("headers", UNMARKED, ids=UNMARKED_IDS)
def test_a_new_node_and_its_wire_on_another_provider(client, headers):
    target = add_node(client, "text-input", {"value": "a cat"})
    body = {"definitionId": ROUTED, "params": {"_provider": "fal"}, "connect": {
        "source": target, "sourceHandle": "text", "target": "", "targetHandle": "prompt", "newNodeIs": "target"}}
    detail = assert_person_required_for_unmarked(client, "POST", "/api/graph/node-and-connect", body, headers)
    assert "_provider" in detail


@pytest.mark.parametrize("headers", UNMARKED, ids=UNMARKED_IDS)
def test_a_cluster_on_the_plan(client, headers):
    body = {"nodes": [{"tempId": "a", "definitionId": DUAL, "params": {"_kreaAuth": "mcp"}}], "edges": []}
    assert "_kreaAuth" in assert_person_required_for_unmarked(client, "POST", "/api/graph/cluster", body, headers)


@pytest.mark.parametrize("headers", UNMARKED, ids=UNMARKED_IDS)
def test_an_import_on_the_plan(client, headers):
    body = {"nodes": [{"id": "a", "definitionId": DUAL, "params": {"_kreaAuth": "mcp"}}], "edges": []}
    assert "_kreaAuth" in assert_person_required_for_unmarked(client, "POST", "/api/graph/import", body, headers)


@pytest.mark.parametrize("headers", UNMARKED, ids=UNMARKED_IDS)
def test_an_undo_restore_that_switches_billing(client, headers):
    node_id = add_node(client, DUAL, {"_kreaAuth": "api-token"})
    body = {"nodes": [{"id": node_id, "definitionId": DUAL, "params": {"_kreaAuth": "mcp"}}]}
    assert "_kreaAuth" in assert_person_required_for_unmarked(client, "POST", "/api/graph/restore", body, headers)


@pytest.mark.parametrize("headers", UNMARKED, ids=UNMARKED_IDS)
def test_a_style_that_bills_the_plan(client, headers):
    style = {"name": "Neon noir", "category": "My Styles", "prompt": "neon noir", "params": {"_kreaAuth": "mcp"},
             "modelId": DUAL, "refImages": [], "scope": "global", "paramsVersion": PARAMS_VERSION}
    detail = assert_person_required_for_unmarked(client, "POST", "/api/presets", style, headers)
    assert "_kreaAuth" in detail
    # And changing one the person made.
    made = client.post("/api/presets", json={**style, "params": {"_kreaAuth": "api-token"}}, headers=PERSON)
    assert made.status_code == 200, made.text
    assert_person_required_for_unmarked(client, "PUT", f"/api/presets/{made.json()['id']}",
                                        {"params": {"_kreaAuth": "mcp"}}, headers)


# -- runs ---------------------------------------------------------------------------

def on_plan(node_id: str = "n1") -> dict:
    return {"id": node_id, "definitionId": DUAL, "params": {"seed": 1, "_kreaAuth": "mcp"}}


@pytest.mark.parametrize("headers", UNMARKED, ids=UNMARKED_IDS)
@pytest.mark.parametrize("route,body", [
    ("/api/execute", {"nodes": [on_plan()], "edges": []}),
    ("/api/execute-node", {"nodes": [on_plan()], "edges": [], "targetNodeId": "n1"}),
    ("/api/quick", {"definitionId": DUAL, "params": {"_kreaAuth": "mcp"}, "inputs": {"prompt": "a cat"}}),
    ("/api/cinema/generate-shot", {
        "nodes": [on_plan(), {"id": "cin", "definitionId": "cinema-scene", "params": {"scene": {
            "version": 1, "base": {"model": "seedream-4-5"}, "aspectRatio": "16:9",
            "shots": [{"id": "a", "prompt": "a cat"}]}}}],
        "edges": [{"id": "w1", "source": "n1", "sourceHandle": "image", "target": "cin",
                   "targetHandle": "reference_set"}],
        "nodeId": "cin", "shotId": "a"}),
], ids=["execute", "execute-node", "quick", "cinema-shot"])
def test_a_run_that_bills_a_node_differently(client, headers, route, body):
    assert "_kreaAuth" in assert_person_required_for_unmarked(client, "POST", route, body, headers)


@pytest.mark.parametrize("headers", UNMARKED, ids=UNMARKED_IDS)
def test_a_run_the_person_approved_started_from_a_tab_not_connected_as_them(client, headers):
    body = {"nodes": [{"id": "n1", "definitionId": "text-input", "params": {"value": "a cat"}}], "edges": [],
            "approvalId": "ap_" + "0" * 16}
    detail = assert_person_required_for_unmarked(client, "POST", "/api/execute", body, headers)
    assert "Only the person's canvas starts a run they approved" in detail


@pytest.mark.parametrize("headers", UNMARKED, ids=UNMARKED_IDS)
@pytest.mark.parametrize("route", ["/api/execute", "/api/execute-node", "/api/graph/run"])
def test_a_run_over_the_agent_spending_limit(client, headers, route):
    """The person's runs aren't held to the agents' limits; a tab that isn't
    connected as them is, so its refusal is one reconnecting fixes."""
    PRICES["nodes"] = {PAID: {"currency": "usd", "rows": [{"match": {}, "price": 2.0}]}}
    assert client.put("/api/settings", json={"runCostConfirmUsd": 1}, headers=PERSON).status_code == 200
    node_id = add_node(client, PAID, {})
    sent = {"id": node_id, "definitionId": PAID, "params": {}}
    body = {"targetNodeId": node_id} if route == "/api/graph/run" else {
        "nodes": [sent], "edges": [], **({"targetNodeId": node_id} if route == "/api/execute-node" else {})}
    detail = assert_person_required_for_unmarked(client, "POST", route, body, headers)
    assert "$2.00" in detail


# -- the paths that already said so keep saying it ----------------------------------

def test_the_project_snapshot_paths_still_say_person_required(client):
    snapshot = {"nodes": [{"id": "zz1", "type": "model-node", "position": {"x": 0, "y": 0},
                           "data": {"definitionId": DUAL, "params": {"_kreaAuth": "mcp"}, "outputs": {}}}],
                "edges": [], "runHistory": [], "viewport": None, "createSessionId": None}
    body = {"sourceProjectId": client.get("/api/projects").json()["activeProjectId"], "recoveryId": "a" * 32,
            "snapshot": snapshot, "paramsVersion": PARAMS_VERSION}
    agent = client.post("/api/projects/recover", json=body, headers=AGENT)
    assert agent.status_code == 403 and set(agent.json()) == {"detail"}, agent.text
    for headers in UNMARKED:
        response = client.post("/api/projects/recover", json=body, headers=headers)
        assert response.status_code == 403, response.text
        assert response.json() == {"detail": agent.json()["detail"], "code": "person_required"}
