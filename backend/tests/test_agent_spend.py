"""Agents may not start costly or unpriced runs without the person's approval."""
from __future__ import annotations

import math
import sys
from pathlib import Path
from unittest.mock import AsyncMock

import pytest
from fastapi.testclient import TestClient

sys.path.insert(0, str(Path(__file__).resolve().parent.parent))

from services import agent_spend  # noqa: E402

PERSON = {"Origin": "http://localhost:5173"}
PAID = "gpt-image-1-generate"
FREE = "text-input"


# -- the rule on its own ---------------------------------------------------------

DEFINITIONS = {
    "paid": {"id": "paid", "displayName": "Paid Model", "apiProvider": "openai", "envKeyName": "OPENAI_API_KEY"},
    "unpriced": {"id": "unpriced", "displayName": "Mystery Model", "apiProvider": "openai", "envKeyName": "OPENAI_API_KEY"},
    "free": {"id": "free", "displayName": "Text", "apiProvider": "utility"},
    "batch": {"id": "batch", "displayName": "Batch", "apiProvider": "utility"},
    "krea": {"id": "krea", "displayName": "Krea 2", "apiProvider": "krea",
             "params": [{"key": "_kreaAuth", "options": ["mcp"]}]},
}


def pricing(amount: float | list[float] = 0.4) -> dict:
    return {"nodes": {"paid": {"currency": "usd", "rows": [{"match": {}, "price": amount}]}}}


def refusal(items, edges=(), *, settings=None, amount=0.4, spent=None):
    return decide(items, edges, settings=settings, amount=amount, spent=spent).refusal


def decide(items, edges=(), *, settings=None, amount=0.4, spent=None):
    return agent_spend.decide(
        items, list(edges), settings=settings if settings is not None else {},
        pricing=pricing(amount), definitions=DEFINITIONS, spent=spent or agent_spend.Spent(),
        how_to_ask="ASK.",
    )


ONE_PAID = [{"id": "n1", "definitionId": "paid", "params": {}}]


@pytest.mark.parametrize(("settings", "expected"), [
    ({}, 1.0),
    ({"runCostConfirmUsd": None}, None),
    ({"runCostConfirmUsd": 5}, 5.0),
    ({"runCostConfirmUsd": "lots"}, 1.0),
    ({"runCostConfirmUsd": -2}, 1.0),
])
def test_threshold_reads_like_the_canvas(settings, expected):
    assert agent_spend.threshold_from_settings(settings) == expected


@pytest.mark.parametrize("bad", [0, -1, "5", True, math.nan, math.inf, [1]])
def test_threshold_rejects_anything_but_a_positive_amount_or_null(bad):
    with pytest.raises(ValueError):
        agent_spend.validate_threshold(bad)
    assert agent_spend.validate_threshold(None) is None
    assert agent_spend.validate_threshold(0.5) == 0.5


def test_a_run_under_the_threshold_passes():
    assert refusal([{"id": "n1", "definitionId": "paid", "params": {}}]) is None


def test_a_run_at_or_over_the_threshold_needs_approval():
    message = refusal([{"id": "n1", "definitionId": "paid", "params": {}}], amount=1.0)
    assert message is not None
    assert "$1.00" in message and "n1 (Paid Model)" in message and message.endswith("ASK.")


def test_the_upper_bound_counts():
    message = refusal([{"id": "n1", "definitionId": "paid", "params": {}}], amount=[0.5, 1.5])
    assert message is not None and "up to $1.50" in message


def test_fan_out_multiplies_the_estimate():
    items = [
        {"id": "n1", "definitionId": "batch", "params": {"items_text": "a\nb\nc"}},
        {"id": "n2", "definitionId": "paid", "params": {}},
    ]
    assert refusal(items[1:]) is None
    assert refusal(items, [("n1", "n2")]) is not None  # 3 × $0.40


def test_a_paid_node_without_a_price_needs_approval():
    message = refusal([{"id": "n4", "definitionId": "unpriced", "params": {}}])
    assert message is not None and "no list price for n4 (Mystery Model)" in message


def test_free_nodes_and_krea_plan_runs_pass():
    assert refusal([
        {"id": "n1", "definitionId": "free", "params": {}},
        {"id": "n2", "definitionId": "krea", "params": {}},
    ]) is None


def test_threshold_off_lets_everything_through():
    assert refusal([{"id": "n4", "definitionId": "unpriced", "params": {}}],
                   settings={"runCostConfirmUsd": None}) is None


def test_the_charge_is_the_upper_bound_per_model():
    assert decide(ONE_PAID, amount=[0.1, 0.3]).charge == {"paid": 0.3}


def test_a_model_limit_replaces_the_general_one_for_that_model():
    looser = {"runCostConfirmUsd": 1, "agentSpend": {"models": {"paid": {"perRunUsd": 5}}}}
    assert refusal(ONE_PAID, settings=looser, amount=3) is None
    message = refusal(ONE_PAID, settings=looser, amount=5)
    assert message is not None and "$5.00 per-run limit for Paid Model" in message
    stricter = {"agentSpend": {"models": {"paid": {"perRunUsd": 0.25}}}}
    assert refusal(ONE_PAID, settings=stricter, amount=0.3) is not None


def test_the_session_budget_counts_what_was_already_spent():
    settings = {"runCostConfirmUsd": None, "agentSpend": {"sessionUsd": 1}}
    assert refusal(ONE_PAID, settings=settings, spent=agent_spend.Spent(0.6)) is None
    message = refusal(ONE_PAID, settings=settings, spent=agent_spend.Spent(0.7))
    assert message is not None and "already used $0.70 of its $1.00 budget" in message


def test_a_model_session_budget_counts_only_that_model():
    settings = {"runCostConfirmUsd": None, "agentSpend": {"models": {"paid": {"sessionUsd": 1}}}}
    assert refusal(ONE_PAID, settings=settings, spent=agent_spend.Spent(50, {"other": 50})) is None
    assert refusal(ONE_PAID, settings=settings, spent=agent_spend.Spent(0.7, {"paid": 0.7})) is not None


def test_any_limit_makes_unpriced_nodes_ask():
    unpriced = [{"id": "n4", "definitionId": "unpriced", "params": {}}]
    assert refusal(unpriced, settings={"runCostConfirmUsd": None, "agentSpend": {"sessionUsd": 50}}) is not None


@pytest.mark.parametrize("bad", [
    [], {"sessionUsd": 0}, {"perRunUsd": 1}, {"models": []}, {"models": {"nope": {"perRunUsd": 1}}},
    {"models": {"paid": {"perRunUsd": 1, "daily": 2}}}, {"models": {"paid": 5}},
])
def test_caps_are_validated(bad):
    with pytest.raises(ValueError):
        agent_spend.validate_caps(bad, DEFINITIONS)


def test_caps_drop_empty_model_entries():
    caps = agent_spend.validate_caps({"sessionUsd": 10, "models": {"paid": {"perRunUsd": None}, "krea": {"sessionUsd": 4}}},
                                     DEFINITIONS)
    assert caps == {"sessionUsd": 10.0, "models": {"krea": {"perRunUsd": None, "sessionUsd": 4.0}}}


def test_the_ledger_keeps_sessions_apart_and_survives_a_restart(tmp_path):
    path = tmp_path / "agent-spend.json"
    ledger = agent_spend.SpendLedger(path)
    ledger.record("chat:a", "Claude", {"paid": 0.5})
    ledger.record("chat:a", "Claude", {"paid": 0.25, "other": 1})
    ledger.record("chat:b", "Codex", {"paid": 2})
    again = agent_spend.SpendLedger(path)
    assert again.spent("chat:a") == agent_spend.Spent(1.75, {"paid": 0.75, "other": 1.0})
    assert again.spent("chat:b").total == 2
    assert again.spent("chat:new") == agent_spend.Spent()


# -- the endpoints ---------------------------------------------------------------

@pytest.fixture
def client(monkeypatch):
    import main

    monkeypatch.setattr(main.model_pricing, "load_pricing", lambda path=None: PRICES)
    monkeypatch.setattr(main, "execute_graph", AsyncMock())
    monkeypatch.setattr(main, "agent_spend_ledger", agent_spend.SpendLedger(None))
    test_client = TestClient(main.app)
    test_client.delete("/api/graph")
    reset = {"runCostConfirmUsd": 1, "agentSpend": {"sessionUsd": None, "models": {}}}
    test_client.put("/api/settings", json=reset, headers=PERSON)
    yield test_client
    test_client.delete("/api/graph")
    test_client.put("/api/settings", json=reset, headers=PERSON)


PRICES: dict = {"nodes": {}}


def price(amount: float | None) -> None:
    PRICES["nodes"] = {} if amount is None else {PAID: {"currency": "usd", "rows": [{"match": {}, "price": amount}]}}


def add_paid_node(client) -> str:
    response = client.post("/api/graph/node", json={"definitionId": PAID, "params": {}})
    assert response.status_code == 200, response.text
    return response.json()["id"]


def test_cli_run_over_the_threshold_is_refused_with_a_proposal_hint(client):
    import main

    price(2.0)
    node_id = add_paid_node(client)
    response = client.post("/api/graph/run", json={"targetNodeId": node_id})
    assert response.status_code == 403
    detail = response.json()["detail"]
    assert "$2.00" in detail and f"--run {node_id}" in detail and "nebula propose" in detail
    main.execute_graph.assert_not_awaited()


def test_cli_run_under_the_threshold_goes_ahead(client):
    import main

    price(0.04)
    node_id = add_paid_node(client)
    assert client.post("/api/graph/run", json={"targetNodeId": node_id}).status_code == 200
    main.execute_graph.assert_awaited_once()


def test_cli_run_of_an_unpriced_node_is_refused(client):
    price(None)
    node_id = add_paid_node(client)
    response = client.post("/api/graph/run", json={})
    assert response.status_code == 403
    assert "no list price" in response.json()["detail"] and f"--run {node_id}" in response.json()["detail"]


def test_free_nodes_run_without_a_price(client):
    import main

    price(None)
    client.post("/api/graph/node", json={"definitionId": FREE, "params": {"value": "hi"}})
    assert client.post("/api/graph/run", json={}).status_code == 200
    main.execute_graph.assert_awaited_once()


def test_the_persons_runs_are_not_held_to_it(client):
    import main

    price(None)
    node_id = add_paid_node(client)
    assert client.post("/api/graph/run", json={"targetNodeId": node_id}, headers=PERSON).status_code == 200
    main.execute_graph.assert_awaited_once()


def test_an_agent_with_a_browser_origin_is_still_held_to_it(client):
    price(None)
    node_id = add_paid_node(client)
    response = client.post("/api/graph/run", json={"targetNodeId": node_id},
                           headers={**PERSON, "X-Nebula-Agent": "Claude Code"})
    assert response.status_code == 403


def test_turning_the_threshold_off_lets_agents_run(client):
    import main

    price(None)
    node_id = add_paid_node(client)
    assert client.put("/api/settings", json={"runCostConfirmUsd": None}, headers=PERSON).status_code == 200
    assert client.post("/api/graph/run", json={"targetNodeId": node_id}).status_code == 200
    main.execute_graph.assert_awaited_once()


def test_quick_points_at_the_canvas(client):
    price(5.0)
    response = client.post("/api/quick", json={"definitionId": PAID, "params": {}, "inputs": {"prompt": "a cat"}})
    assert response.status_code == 403
    assert f"nebula create {PAID}" in response.json()["detail"]


def test_canvas_run_endpoints_hold_other_callers_to_it(client, monkeypatch):
    import main

    price(3.0)
    node = {"id": "n1", "definitionId": PAID, "params": {}}
    # This graph has no prompt or key, so it can't run: that comes first, not its cost.
    invalid = client.post("/api/execute", json={"nodes": [node], "edges": []})
    assert invalid.status_code == 200 and invalid.json()["status"] == "validation_error"
    monkeypatch.setattr(main, "validate_graph", lambda *args, **kwargs: [])
    execute = client.post("/api/execute", json={"nodes": [node], "edges": []})
    assert execute.status_code == 403 and "--run n1" in execute.json()["detail"]
    one = client.post("/api/execute-node", json={"nodes": [node], "edges": [], "targetNodeId": "n1"})
    assert one.status_code == 403


@pytest.mark.parametrize("headers", [{}, {**PERSON, "X-Nebula-Agent": "Codex"}, {"Authorization": "Agent x"}])
def test_only_the_person_can_change_the_threshold(client, headers):
    response = client.put("/api/settings", json={"runCostConfirmUsd": 500}, headers=headers)
    assert response.status_code in (401, 403)  # a bad agent token is turned away before the route
    assert client.get("/api/settings").json()["runCostConfirmUsd"] == 1


def test_the_person_can_change_the_threshold_and_bad_values_are_refused(client):
    assert client.put("/api/settings", json={"runCostConfirmUsd": 20}, headers=PERSON).status_code == 200
    assert client.get("/api/settings").json()["runCostConfirmUsd"] == 20
    assert client.put("/api/settings", json={"runCostConfirmUsd": 0}, headers=PERSON).status_code == 400
    # Other settings still save from anywhere, as before.
    assert client.put("/api/settings", json={"zoomTelemetryEnabled": True}).status_code == 200


def test_a_session_budget_holds_across_runs_and_renaming_does_not_reset_it(client):
    import main

    price(0.4)
    node_id = add_paid_node(client)
    caps = {"runCostConfirmUsd": None, "agentSpend": {"sessionUsd": 1, "models": {}}}
    assert client.put("/api/settings", json=caps, headers=PERSON).status_code == 200
    as_claude = {"X-Nebula-Agent": "Claude Code", "X-Nebula-Agent-Session": "s1"}
    assert client.post("/api/graph/run", json={"targetNodeId": node_id}, headers=as_claude).status_code == 200
    assert client.post("/api/graph/run", json={"targetNodeId": node_id}, headers=as_claude).status_code == 200
    third = client.post("/api/graph/run", json={"targetNodeId": node_id}, headers=as_claude)
    assert third.status_code == 403 and "already used $0.80 of its $1.00 budget" in third.json()["detail"]
    status = client.get("/api/agent/spend", headers=as_claude).json()
    assert status["spent"]["totalUsd"] == 0.8 and status["limits"]["sessionUsd"] == 1
    # Names and session headers are the caller's to set, so they can't buy a fresh budget.
    for renamed in ({"X-Nebula-Agent": "Claude Code", "X-Nebula-Agent-Session": "s2"},
                    {"X-Nebula-Agent": "Someone Else"}, {}):
        refused = client.post("/api/graph/run", json={"targetNodeId": node_id}, headers=renamed)
        assert refused.status_code == 403, renamed
    # The person's runs are never counted or held back.
    assert client.post("/api/graph/run", json={"targetNodeId": node_id}, headers=PERSON).status_code == 200
    assert main.execute_graph.await_count == 3


def test_only_the_person_can_change_agent_limits(client):
    caps = {"agentSpend": {"sessionUsd": 999, "models": {}}}
    assert client.put("/api/settings", json=caps, headers={"X-Nebula-Agent": "Codex"}).status_code == 403
    assert client.put("/api/settings", json=caps).status_code == 403
    assert client.put("/api/settings", json=caps, headers=PERSON).status_code == 200
    bad = {"agentSpend": {"models": {"not-a-node": {"perRunUsd": 1}}}}
    assert client.put("/api/settings", json=bad, headers=PERSON).status_code == 400


def test_in_app_tokens_count_against_their_chat_session(client):
    import main
    from commons.actors import agent_registry

    price(0.4)
    node_id = add_paid_node(client)
    client.put("/api/settings", json={"runCostConfirmUsd": None, "agentSpend": {"sessionUsd": 1, "models": {}}},
               headers=PERSON)
    token = agent_registry.mint("claude", [], session="chat-123")
    try:
        headers = {"Authorization": f"Agent {token}"}
        assert client.post("/api/graph/run", json={"targetNodeId": node_id}, headers=headers).status_code == 200
        assert main.agent_spend_ledger.spent("chat:chat-123").total == pytest.approx(0.4)
    finally:
        agent_registry.revoke(token)
