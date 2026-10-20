"""Who bills a run stays the person's call on every route that runs the nodes
the request sends (audit U8, 2026-10-20).

/api/execute, /api/execute-node, /api/cinema/generate-shot and /api/quick run
the request's own nodes, so the guard on edits alone wouldn't hold. Each one
goes through _require_spend_approval, which refuses a caller that isn't the
person (an agent, or an anonymous local program) when a node would bill
differently from its canvas node: a route-table node's ``_provider``, a Krea
node's ``_kreaAuth``, a Moodboard node's ``send_notes``
(_refuse_agent_billing_in_run). tests/test_krea_billing_routes.py covers
``_kreaAuth`` on three of the routes; this file covers ``_provider`` and
``send_notes`` on all four, the Cinema shot route for each, and the params a
run actually runs with (the engine migrates retired params first).
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

ROUTED = "flux-2-pro"  # a route-table node: Auto, bfl or fal
DUAL = "krea-2-generate"  # bills the API token or the signed-in Krea plan
AGENT = {"X-Nebula-Agent": "Codex"}
NOT_THE_PERSON = [{}, AGENT, FORGED_ORIGIN]
PROVIDER_REFUSED = "Changing which provider a node runs on"
NOTES_REFUSED = "send_notes"


async def runs_nothing(*, nodes, run_id=None, **kwargs):
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
    # No keys or prompts here; what's tested is who may bill what.
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
    for _ in range(300):
        response = client.get(f"/api/executions/{run_id}")
        if response.status_code == 404 or response.json()["status"] not in {"running", "cancelling"}:
            return
        time.sleep(0.01)
    raise AssertionError(f"run {run_id} never finished")


def node(node_id: str, definition_id: str, params: dict) -> dict:
    return {"id": node_id, "definitionId": definition_id, "params": params}


SCENE = {"scene": {"version": 1, "base": {"model": "seedream-4-5"}, "aspectRatio": "16:9",
                   "shots": [{"id": "a", "prompt": "a cat"}]}}


def bodies(sent: dict) -> list[tuple[str, dict]]:
    """``sent`` run on each route that takes nodes in the request: alone, as
    the target, and upstream of a Cinema scene (wired into its references)."""
    cinema = node("cin", "cinema-scene", SCENE)
    wire = {"id": "w1", "source": sent["id"], "sourceHandle": "image", "target": "cin",
            "targetHandle": "reference_set"}
    return [
        ("/api/execute", {"nodes": [sent], "edges": []}),
        ("/api/execute-node", {"nodes": [sent], "edges": [], "targetNodeId": sent["id"]}),
        ("/api/cinema/generate-shot", {"nodes": [sent, cinema], "edges": [wire], "nodeId": "cin", "shotId": "a"}),
    ]


def started(response) -> str:
    assert response.status_code == 200, response.text
    body = response.json()
    assert body.get("status") == "started", body
    return body["runId"]


# -- _provider ----------------------------------------------------------------

@pytest.mark.parametrize("headers", NOT_THE_PERSON)
def test_a_run_request_cant_pick_the_provider(client, headers):
    import main

    on_canvas = add_node(client, ROUTED, {"seed": 1})  # on Auto
    for sent in (node(on_canvas, ROUTED, {"seed": 1, "_provider": "fal"}),  # switched
                 node("n9", ROUTED, {"seed": 1, "_provider": "bfl"})):      # not on the canvas
        for route, body in bodies(sent):
            response = client.post(route, json=body, headers=headers)
            assert response.status_code == 403, (route, response.text)
            assert PROVIDER_REFUSED in response.json()["detail"] and "propose_change" in response.json()["detail"]
    quick = {"definitionId": ROUTED, "params": {"_provider": "fal"}, "inputs": {"prompt": "a cat"}}
    response = client.post("/api/quick", json=quick, headers=headers)
    assert response.status_code == 403 and PROVIDER_REFUSED in response.json()["detail"]
    main.execute_graph.assert_not_awaited()
    assert main.agent_spend_ledger.spent_outside() == agent_spend.Spent()


def test_a_run_request_cant_put_an_auto_node_back_on_auto_either(client):
    # The person picked fal: running it on Auto (or leaving _provider out) is a switch too.
    on_canvas = add_node(client, ROUTED, {"seed": 1, "_provider": "fal"})
    for params in ({"seed": 1, "_provider": "auto"}, {"seed": 1}):
        for route, body in bodies(node(on_canvas, ROUTED, params)):
            response = client.post(route, json=body, headers=AGENT)
            assert response.status_code == 403, (route, response.text)


def test_an_agent_runs_a_node_on_the_provider_the_person_picked(client):
    on_canvas = add_node(client, ROUTED, {"seed": 1, "_provider": "fal"})
    add_node(client, "cinema-scene", SCENE)
    for route, body in bodies(node(on_canvas, ROUTED, {"seed": 2, "_provider": "fal"})):
        wait_for(client, started(client.post(route, json=body, headers=AGENT)))
    quick = {"definitionId": ROUTED, "params": {"_provider": "auto"}, "inputs": {"prompt": "a cat"}}
    assert client.post("/api/quick", json=quick, headers=AGENT).status_code == 200


# -- _kreaAuth on the Cinema shot route (the other three: test_krea_billing_routes.py)

@pytest.mark.parametrize("headers", NOT_THE_PERSON)
def test_a_cinema_shot_cant_bill_an_upstream_node_to_the_plan(client, headers):
    import main

    on_canvas = add_node(client, DUAL, {"seed": 1})
    _, body = bodies(node(on_canvas, DUAL, {"seed": 1, "_kreaAuth": "mcp"}))[2]
    response = client.post("/api/cinema/generate-shot", json=body, headers=headers)
    assert response.status_code == 403 and "_kreaAuth" in response.json()["detail"]
    main.execute_graph.assert_not_awaited()


# -- send_notes ---------------------------------------------------------------

@pytest.mark.parametrize("headers", NOT_THE_PERSON)
def test_a_run_request_cant_open_a_boards_notes(client, headers):
    import main

    on_canvas = add_node(client, "nebula-moodboard", {"send_notes": "board"})
    for route, body in bodies(node(on_canvas, "nebula-moodboard", {"send_notes": "yes"})):
        response = client.post(route, json=body, headers=headers)
        assert response.status_code == 403, (route, response.text)
        assert NOTES_REFUSED in response.json()["detail"]
    quick = {"definitionId": "nebula-moodboard", "params": {"send_notes": "yes"}, "inputs": {}}
    response = client.post("/api/quick", json=quick, headers=headers)
    assert response.status_code == 403 and NOTES_REFUSED in response.json()["detail"]
    main.execute_graph.assert_not_awaited()


@pytest.mark.parametrize("route", ["/api/execute", "/api/execute-node", "/api/cinema/generate-shot"])
def test_a_yes_cant_be_pointed_at_another_board_through_a_retired_param(client, route):
    """A "yes" with no board picked sends nothing. A run that names a board
    only in the retired ``_moodboardId`` (which the engine moves to
    ``moodboard`` before the node runs, services/retired_nodes.py) would
    send that board's notes: the check reads the params the run runs with."""
    import main

    on_canvas = add_node(client, "nebula-moodboard", {"send_notes": "yes"})
    sent = node(on_canvas, "nebula-moodboard", {"send_notes": "yes", "_moodboardId": "mb-other"})
    body = dict(bodies(sent))[route]
    response = client.post(route, json=body, headers=AGENT)
    assert response.status_code == 403, response.text
    assert NOTES_REFUSED in response.json()["detail"]
    main.execute_graph.assert_not_awaited()


# -- the person's own runs ------------------------------------------------------

def test_the_persons_runs_bill_as_they_send_them(client):
    """The canvas runs its unsaved edits, Cinema shots included: whatever it
    sends is the person's choice."""
    import main

    add_node(client, "cinema-scene", SCENE)
    on_canvas = add_node(client, ROUTED, {"seed": 1})
    sends = [node(on_canvas, ROUTED, {"seed": 1, "_provider": "fal"}),
             node("n9", DUAL, {"seed": 1, "_kreaAuth": "mcp"}),
             node("n8", "nebula-moodboard", {"send_notes": "yes", "_moodboardId": "mb-other"})]
    for sent in sends:
        for route, body in bodies(sent):
            wait_for(client, started(client.post(route, json=body, headers=PERSON)))
    quick = {"definitionId": ROUTED, "params": {"_provider": "fal"}, "inputs": {"prompt": "a cat"}}
    assert client.post("/api/quick", json=quick, headers=PERSON).status_code == 200
    assert main.execute_graph.await_count == len(sends) * 3 + 1
