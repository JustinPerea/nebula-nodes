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
from tests.conftest import FORGED_ORIGIN, PERSON  # noqa: E402

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

async def every_node_calls_its_provider(*, nodes, run_id=None, **kwargs):
    """A stand-in engine: each node reaches its handler, so the whole count stays."""
    from execution import provider_calls

    for node in nodes:
        provider_calls.mark(run_id, node.id)


@pytest.fixture
def client(monkeypatch, person):
    import main

    monkeypatch.setattr(main.model_pricing, "load_pricing", lambda path=None: PRICES)
    monkeypatch.setattr(main, "execute_graph", AsyncMock(side_effect=every_node_calls_its_provider))
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


def test_a_forged_browser_origin_is_held_to_it(client):
    import main

    price(None)
    node_id = add_paid_node(client)
    response = client.post("/api/graph/run", json={"targetNodeId": node_id}, headers=FORGED_ORIGIN)
    assert response.status_code == 403 and "no list price" in response.json()["detail"]
    main.execute_graph.assert_not_awaited()
    spend = client.get("/api/agent/spend", headers=FORGED_ORIGIN).json()
    assert spend["limited"] is True and spend["budget"] == "shared"
    assert client.get("/api/agent/spend", headers=PERSON).json()["limited"] is False


def test_an_agent_with_the_person_token_is_still_held_to_it(client):
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


@pytest.mark.parametrize("headers", [{}, FORGED_ORIGIN, {**PERSON, "X-Nebula-Agent": "Codex"},
                                     {"Authorization": "Agent x"}])
def test_only_the_person_can_change_the_threshold(client, headers):
    response = client.put("/api/settings", json={"runCostConfirmUsd": 500}, headers=headers)
    assert response.status_code in (401, 403)  # a bad agent token is turned away before the route
    assert client.get("/api/settings").json()["runCostConfirmUsd"] == 1


def test_the_person_can_change_the_threshold_and_bad_values_are_refused(client):
    assert client.put("/api/settings", json={"runCostConfirmUsd": 20}, headers=PERSON).status_code == 200
    assert client.get("/api/settings").json()["runCostConfirmUsd"] == 20
    assert client.put("/api/settings", json={"runCostConfirmUsd": 0}, headers=PERSON).status_code == 400
    # Every setting is the person's now, not only the limits.
    assert client.put("/api/settings", json={"zoomTelemetryEnabled": True}).status_code == 403
    assert client.put("/api/settings", json={"zoomTelemetryEnabled": True}, headers=FORGED_ORIGIN).status_code == 403
    assert client.put("/api/settings", json={"zoomTelemetryEnabled": True}, headers=PERSON).status_code == 200


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
    # A name isn't a chat token: this is an outside agent, held to the shared
    # outside budget, which is the per-session amount while it's unset.
    assert third.status_code == 403
    assert ("agents outside Nebula chats have already used $0.80 of their $1.00 budget in the last 24 hours"
            in third.json()["detail"])
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


# -- runs that couldn't have cost anything give their count back -------------------

def test_the_ledger_gives_back_part_of_a_count():
    ledger = agent_spend.SpendLedger(None)
    ledger.record("s", "Agent", {"paid": 0.5, "other": 0.25})
    ledger.refund("s", {"paid": 0.5})
    assert ledger.spent("s") == agent_spend.Spent(0.25, {"other": 0.25})
    ledger.refund("s", {"other": 1.0})  # never below zero
    assert ledger.spent("s") == agent_spend.Spent(0.0, {})
    ledger.refund("unknown", {"paid": 1})  # nothing to give back


def test_the_decision_keeps_each_nodes_share():
    decision = decide([{"id": "n1", "definitionId": "paid", "params": {}},
                       {"id": "n2", "definitionId": "paid", "params": {}}], amount=0.3)
    assert decision.per_node == {"n1": ("paid", 0.3), "n2": ("paid", 0.3)}


def spent(client) -> float:
    return client.get("/api/agent/spend").json()["spent"]["totalUsd"]


def test_a_node_without_its_key_gives_its_count_back(client, monkeypatch):
    """The real engine and handler: no OPENAI_API_KEY stops gpt-image-1 at its own
    key check, before any request, and the run's count goes back to zero."""
    import main
    from execution.engine import execute_graph

    monkeypatch.setattr(main, "execute_graph", execute_graph)
    price(0.4)
    node_id = add_paid_node(client)
    prompt = client.post("/api/graph/node", json={"definitionId": FREE, "params": {"value": "a cat"}}).json()["id"]
    wired = client.post("/api/graph/connect", json={"source": prompt, "sourceHandle": "text",
                                                    "target": node_id, "targetHandle": "prompt"})
    assert wired.status_code == 200, wired.text
    result = client.post("/api/graph/run", json={"targetNodeId": node_id}).json()
    assert "OPENAI_API_KEY is required" in result["errors"][node_id]
    assert spent(client) == 0


def test_a_provider_failure_still_counts(client, monkeypatch):
    import main
    from models.events import ErrorEvent

    async def provider_said_no(*, nodes, emit, run_id, **kwargs):
        await every_node_calls_its_provider(nodes=nodes, run_id=run_id)
        await emit(ErrorEvent(node_id=nodes[0].id, error="HTTP 500 from provider", run_id=run_id))

    monkeypatch.setattr(main, "execute_graph", provider_said_no)
    price(0.4)
    node_id = add_paid_node(client)
    client.post("/api/graph/run", json={"targetNodeId": node_id})
    assert spent(client) == pytest.approx(0.4)


def test_only_the_keyless_node_of_a_run_is_given_back(client, monkeypatch):
    import main
    from models.events import ErrorEvent, ExecutedEvent

    async def one_of_each(*, nodes, emit, run_id, **kwargs):
        first, second = nodes
        await every_node_calls_its_provider(nodes=nodes, run_id=run_id)
        await emit(ExecutedEvent(node_id=first.id, outputs={}, run_id=run_id))
        await emit(ErrorEvent(node_id=second.id, error="OPENAI_API_KEY is required", run_id=run_id,
                              missing_credential=True))

    monkeypatch.setattr(main, "execute_graph", one_of_each)
    price(0.4)
    add_paid_node(client)
    add_paid_node(client)
    client.post("/api/graph/run", json={})
    assert spent(client) == pytest.approx(0.4)


def test_a_request_refused_after_the_check_does_not_count(client):
    price(0.4)
    node_id = add_paid_node(client)
    assert client.post("/api/graph/run", json={"targetNodeId": node_id, "wait": -1}).status_code == 400
    assert spent(client) == 0


def test_a_keyless_run_over_the_limit_is_still_asked_about(client):
    # Which key a handler will find is only known by running it, so the limit
    # is checked on the whole estimate; only the count is given back.
    price(5.0)
    node_id = add_paid_node(client)
    assert client.post("/api/graph/run", json={"targetNodeId": node_id}).status_code == 403


# -- nodes that never reach their provider ------------------------------------------

EDIT = "gpt-image-1-edit"


@pytest.fixture
def fake_providers(client, monkeypatch):
    """The real engine, with the two OpenAI handlers replaced by fakes that count calls."""
    import main
    from execution.engine import execute_graph

    calls: list[str] = []
    fail: set[str] = set()
    real_registry = main.get_handler_registry

    def registry(**kwargs):
        handlers = real_registry(**kwargs)

        def fake(definition_id):
            async def handler(node, inputs, api_keys):
                calls.append(node.id)
                if node.id in fail:
                    raise RuntimeError("HTTP 500 from provider")
                return {"image": {"type": "Text", "value": f"made by {node.id}"}}
            return handler

        handlers[PAID] = fake(PAID)
        handlers[EDIT] = fake(EDIT)
        return handlers

    monkeypatch.setattr(main, "execute_graph", execute_graph)
    monkeypatch.setattr(main, "get_handler_registry", registry)
    PRICES["nodes"] = {PAID: {"currency": "usd", "rows": [{"match": {}, "price": 0.4}]},
                       EDIT: {"currency": "usd", "rows": [{"match": {}, "price": 0.3}]}}
    main.execution_cache.clear()
    yield calls, fail
    main.execution_cache.clear()


def _chain(client) -> tuple[str, str]:
    """A text prompt into the paid generator, whose image feeds the paid editor."""
    prompt = client.post("/api/graph/node", json={"definitionId": FREE, "params": {"value": "a cat"}}).json()["id"]
    first = add_paid_node(client)
    second = client.post("/api/graph/node", json={"definitionId": EDIT, "params": {}}).json()["id"]
    for source, port, target, handle in ((prompt, "text", first, "prompt"), (prompt, "text", second, "prompt"),
                                         (first, "image", second, "image")):
        wired = client.post("/api/graph/connect", json={"source": source, "sourceHandle": port,
                                                        "target": target, "targetHandle": handle})
        assert wired.status_code == 200, wired.text
    return first, second


def test_a_cache_hit_gives_its_count_back(client, fake_providers):
    calls, _ = fake_providers
    first, _second = _chain(client)
    client.post("/api/graph/run", json={"targetNodeId": first})
    assert calls == [first] and spent(client) == pytest.approx(0.4)
    client.post("/api/graph/run", json={"targetNodeId": first})  # answered from the cache
    assert calls == [first] and spent(client) == pytest.approx(0.4)


def test_a_node_after_a_failed_one_gives_its_count_back(client, fake_providers):
    calls, fail = fake_providers
    first, second = _chain(client)
    fail.add(first)
    result = client.post("/api/graph/run", json={"targetNodeId": second}).json()
    assert "HTTP 500" in result["errors"][first]
    assert calls == [first]  # the editor never ran
    assert spent(client) == pytest.approx(0.4)  # the failed call still counts, the editor's 0.3 doesn't


def test_every_node_that_ran_still_counts(client, fake_providers):
    calls, _ = fake_providers
    _first, second = _chain(client)
    client.post("/api/graph/run", json={"targetNodeId": second})
    assert len(calls) == 2 and spent(client) == pytest.approx(0.7)


def test_only_a_trustworthy_record_gives_anything_back(monkeypatch):
    from execution import provider_calls

    provider_calls.mark("never-begun", "n1")  # a mark never creates a record
    assert provider_calls.take("never-begun") is None

    provider_calls.begin("tracked")
    provider_calls.mark("tracked", "n1")
    assert provider_calls.take("tracked") == {"n1"}
    assert provider_calls.take("tracked") is None
    provider_calls.mark("tracked", "n2")  # after its record is taken, nothing comes back
    assert provider_calls.take("tracked") is None

    provider_calls.begin("reused")
    provider_calls.mark("reused", "n1")
    provider_calls.begin("reused")  # the same run id again: the record can't be trusted
    provider_calls.mark("reused", "n2")
    assert provider_calls.take("reused") is None

    monkeypatch.setattr(provider_calls, "MAX_RUNS", 1)
    provider_calls.begin("first")
    provider_calls.begin("second")  # full: not recorded, so it keeps its whole count
    assert provider_calls.take("second") is None
    assert provider_calls.take("first") == set()


def test_a_dropped_hold_takes_its_record_with_it(monkeypatch):
    import main
    from execution import provider_calls

    monkeypatch.setattr(main, "_spend_holds", type(main._spend_holds)())
    monkeypatch.setattr(main, "_MAX_SPEND_HOLDS", 1)
    main._place_hold("old", "agent", {"n1": (PAID, 0.4)})
    provider_calls.mark("old", "n1")
    main._place_hold("new", "agent", {"n1": (PAID, 0.4)})
    assert "old" not in main._spend_holds
    provider_calls.mark("old", "n2")  # the old run is still going
    assert provider_calls.take("old") is None
    assert provider_calls.take("new") == set()


# -- cinema shot variations ---------------------------------------------------------

def test_each_pass_counts_in_full():
    once = decide(ONE_PAID, amount=0.3)
    three = agent_spend.decide(ONE_PAID, [], settings={}, pricing=pricing(0.3), definitions=DEFINITIONS,
                               spent=agent_spend.Spent(), how_to_ask="ASK.", passes=3)
    assert once.charge == {"paid": pytest.approx(0.3)}
    assert three.charge == {"paid": pytest.approx(0.9)} and three.per_node == {"n1": ("paid", pytest.approx(0.9))}
    for bad in (0, -1, 1.5, True):
        with pytest.raises(ValueError):
            agent_spend.decide(
                ONE_PAID, [], settings={}, pricing=pricing(0.3), definitions=DEFINITIONS,
                spent=agent_spend.Spent(), how_to_ask="ASK.", passes=bad)


def _scene_node(base: str | None = "nano-banana", shots: int = 1) -> dict:
    scene = {"version": 1, "aspectRatio": "16:9",
             "shots": [{"id": chr(97 + i), "prompt": "a lighthouse at dusk"} for i in range(shots)]}
    if base:
        scene["base"] = {"model": base}
    return {"id": "c1", "definitionId": "cinema-scene", "params": {"scene": scene}, "outputs": {}}


def _shot_request(variations: int, base: str | None = "nano-banana") -> dict:
    return {"nodes": [_scene_node(base)], "edges": [], "nodeId": "c1", "shotId": "a", "variations": variations}


def _price_base(amount: float) -> None:
    PRICES["nodes"] = {"nano-banana": {"currency": "usd", "rows": [{"match": {}, "price": amount}]}}


@pytest.mark.parametrize(("variations", "allowed"), [(1, True), (3, True), (4, False)])
def test_shot_variations_are_counted_per_variation(client, variations, allowed):
    _price_base(0.3)
    response = client.post("/api/cinema/generate-shot", json=_shot_request(variations))
    if allowed:
        assert response.status_code == 200, response.text
        assert spent(client) == pytest.approx(0.3 * variations)
    else:
        assert response.status_code == 403
        assert "$1.20" in response.json()["detail"]
        assert spent(client) == 0


def test_a_scene_on_a_base_without_a_list_price_needs_a_proposal(client):
    # cinema-scene itself is a utility node; it used to pass the check as free.
    _price_base(0.3)
    for base in (None, "seedream-4-5"):  # None: the handler's default base
        response = client.post("/api/cinema/generate-shot", json=_shot_request(1, base=base))
        assert response.status_code == 403
        assert "no list price for c1 (Cinema Scene)" in response.json()["detail"]
    assert spent(client) == 0


def test_a_scene_counts_as_its_base_model_once_per_shot():
    from services import model_pricing

    definitions = {"cinema-scene": {"id": "cinema-scene", "apiProvider": "utility"},
                   "nano-banana": {"id": "nano-banana", "apiProvider": "google"}}
    pricing_table = {"nodes": {"nano-banana": {"currency": "usd", "rows": [{"match": {}, "price": 0.25}]}}}

    def run(node):
        return model_pricing.estimate_run([node], pricing_table, definitions, {})

    three = run(_scene_node(shots=3))
    assert three["priced"]["c1"] == {"low": pytest.approx(0.75), "high": pytest.approx(0.75), "model": "nano-banana"}
    assert run(_scene_node(shots=0))["priced"]["c1"]["high"] == 0
    assert run(_scene_node(base="seedream-4-5"))["unpriced"] == ["c1"]
    assert run(_scene_node(base="world-labs-anything"))["unpriced"] == ["c1"]  # the handler refuses it
    broken = _scene_node()
    broken["params"] = {"scene": "not a scene"}
    assert run(broken)["unpriced"] == ["c1"]


def test_a_scenes_shots_fall_under_its_base_models_own_limit(client):
    _price_base(0.3)
    limits = {"agentSpend": {"sessionUsd": None, "models": {"nano-banana": {"perRunUsd": 0.5, "sessionUsd": None}}}}
    assert client.put("/api/settings", json=limits, headers=PERSON).status_code == 200
    response = client.post("/api/cinema/generate-shot", json=_shot_request(2))
    assert response.status_code == 403
    assert "per-run limit for" in response.json()["detail"]


# -- the outside agents' budget: stable, rolling 24 hours ------------------------------

class Clock:
    def __init__(self, now: float = 1_760_000_000.0) -> None:
        self.now = now

    def __call__(self) -> float:
        return self.now


HOUR = 60 * 60


def test_outside_spending_counts_the_last_24_hours():
    clock = Clock()
    ledger = agent_spend.SpendLedger(None, clock=clock)
    ledger.record("outside:shared", "Outside", {"paid": 0.5})
    clock.now += 20 * HOUR
    ledger.record("outside:shared", "Outside", {"paid": 0.25})
    assert ledger.spent("outside:shared") == agent_spend.Spent(0.75, {"paid": 0.75})
    clock.now += 4 * HOUR + 1  # the first run is now older than 24 hours
    assert ledger.spent("outside:shared") == agent_spend.Spent(0.25, {"paid": 0.25})
    clock.now += 20 * HOUR
    assert ledger.spent("outside:shared") == agent_spend.Spent()


def test_a_give_back_lands_in_its_runs_window():
    clock = Clock()
    ledger = agent_spend.SpendLedger(None, clock=clock)
    first = ledger.record("outside:shared", "Outside", {"paid": 0.5})
    clock.now += 23 * HOUR
    second = ledger.record("outside:shared", "Outside", {"paid": 0.4})
    clock.now += 2 * HOUR  # the first run has left the window
    ledger.refund("outside:shared", {"paid": 0.5}, at=first)
    assert ledger.spent("outside:shared").total == pytest.approx(0.4)  # not 0.4 - 0.5
    ledger.refund("outside:shared", {"paid": 0.4}, at=second)
    assert ledger.spent("outside:shared") == agent_spend.Spent()
    # Without the run's time an outside give-back can't be placed, so nothing comes back.
    ledger.record("outside:shared", "Outside", {"paid": 0.3})
    ledger.refund("outside:shared", {"paid": 0.3})
    assert ledger.spent("outside:shared").total == pytest.approx(0.3)


def test_old_outside_events_are_dropped_when_saved(tmp_path):
    clock = Clock()
    path = tmp_path / "agent-spend.json"
    ledger = agent_spend.SpendLedger(path, clock=clock)
    ledger.record("outside:shared", "Outside", {"paid": 0.5})
    clock.now += 25 * HOUR
    ledger.record("outside:shared", "Outside", {"paid": 0.1})
    import json
    events = json.loads(path.read_text())["sessions"]["outside:shared"]["events"]
    assert [event[2] for event in events] == [0.1]


def test_the_old_per_launch_budgets_fold_into_the_outside_one(tmp_path):
    import json

    clock = Clock()
    path = tmp_path / "agent-spend.json"
    path.write_text(json.dumps({"sessions": {
        "unverified:aaa": {"agent": "x", "total": 0.9, "models": {"paid": 0.6}, "updated": clock.now - HOUR},
        "unverified:bbb": {"agent": "x", "total": 5, "models": {"paid": 5}, "updated": clock.now - 30 * HOUR},
        "chat:c1": {"agent": "Claude", "total": 1, "models": {"paid": 1}, "updated": clock.now},
    }}))
    ledger = agent_spend.SpendLedger(path, clock=clock)
    # Counted at its last update (fail closed), the unattributed rest included; the stale one is gone.
    assert ledger.spent_outside().total == pytest.approx(0.9)
    assert ledger.spent("chat:c1").total == 1
    saved = json.loads(path.read_text())["sessions"]
    assert not any(key.startswith("unverified:") for key in saved)
    clock.now += 23 * HOUR + 1
    assert agent_spend.SpendLedger(path, clock=clock).spent_outside() == agent_spend.Spent()


def test_restarting_nebula_does_not_reset_the_outside_budget(client, tmp_path, monkeypatch):
    import main

    path = tmp_path / "agent-spend.json"
    monkeypatch.setattr(main, "agent_spend_ledger", agent_spend.SpendLedger(path))
    assert not hasattr(main, "_SPEND_LAUNCH")  # the key no longer depends on the launch
    price(0.6)
    node_id = add_paid_node(client)
    caps = {"runCostConfirmUsd": None, "agentSpend": {"sessionUsd": 50, "outsideDailyUsd": 1, "models": {}}}
    assert client.put("/api/settings", json=caps, headers=PERSON).status_code == 200
    assert client.post("/api/graph/run", json={"targetNodeId": node_id}).status_code == 200
    # A restart: a fresh ledger over the same file, and a caller with another name.
    monkeypatch.setattr(main, "agent_spend_ledger", agent_spend.SpendLedger(path))
    status = client.get("/api/agent/spend", headers={"X-Nebula-Agent": "Someone New"}).json()
    assert status["budget"] == "shared" and status["spent"]["totalUsd"] == pytest.approx(0.6)
    assert status["limits"]["outsideDailyUsd"] == 1
    again = client.post("/api/graph/run", json={"targetNodeId": node_id}, headers={"X-Nebula-Agent": "Someone New"})
    assert again.status_code == 403
    assert "agents outside Nebula chats have already used $0.60 of their $1.00 budget in the last 24 hours" \
        in again.json()["detail"] and "propose" in again.json()["detail"]


def test_the_outside_budget_defaults_to_the_session_budget():
    assert agent_spend.caps_from_settings({"agentSpend": {"sessionUsd": 5}})["outsideDailyUsd"] == 5
    assert agent_spend.caps_from_settings({"agentSpend": {"sessionUsd": 5, "outsideDailyUsd": None}})["outsideDailyUsd"] is None
    assert agent_spend.caps_from_settings({"agentSpend": {"sessionUsd": 5, "outsideDailyUsd": 2}})["outsideDailyUsd"] == 2
    # Unreadable falls back to the session amount, never to no limit.
    assert agent_spend.caps_from_settings({"agentSpend": {"sessionUsd": 5, "outsideDailyUsd": "lots"}})["outsideDailyUsd"] == 5
    assert "outsideDailyUsd" not in agent_spend.validate_caps({"sessionUsd": 5}, DEFINITIONS)
    with pytest.raises(ValueError):
        agent_spend.validate_caps({"outsideDailyUsd": 0}, DEFINITIONS)


def test_chats_and_outside_agents_are_held_to_their_own_budgets(client):
    from commons.actors import agent_registry

    price(0.4)
    node_id = add_paid_node(client)
    caps = {"runCostConfirmUsd": None, "agentSpend": {"sessionUsd": 5, "outsideDailyUsd": 0.5, "models": {}}}
    client.put("/api/settings", json=caps, headers=PERSON)
    assert client.post("/api/graph/run", json={"targetNodeId": node_id}).status_code == 200
    assert client.post("/api/graph/run", json={"targetNodeId": node_id}).status_code == 403
    token = agent_registry.mint("claude", [], session="chat-9")
    try:
        chat = {"Authorization": f"Agent {token}"}
        assert client.post("/api/graph/run", json={"targetNodeId": node_id}, headers=chat).status_code == 200
        assert client.get("/api/agent/spend", headers=chat).json()["budget"] == "chat"
    finally:
        agent_registry.revoke(token)


# -- app tokens the person issues -------------------------------------------------------

@pytest.fixture
def apps(client, tmp_path, monkeypatch):
    import main
    from services import app_tokens

    store = app_tokens.AppTokens(tmp_path / "app-tokens.json")
    monkeypatch.setattr(main, "app_token_store", store)
    monkeypatch.setattr(app_tokens, "_store", store)
    return store


def make_app(client, name="Claude Desktop", daily=None) -> tuple[str, dict]:
    response = client.post("/api/agent/spend/apps", json={"name": name, "dailyUsd": daily}, headers=PERSON)
    assert response.status_code == 200, response.text
    return response.json()["token"], response.json()["app"]


def test_only_the_person_manages_app_tokens(client, apps):
    for headers in ({}, FORGED_ORIGIN, {**PERSON, "X-Nebula-Agent": "Claude"}):
        assert client.post("/api/agent/spend/apps", json={"name": "Sneaky"}, headers=headers).status_code == 403
        assert client.get("/api/agent/spend/apps", headers=headers).status_code == 403
    token, app = make_app(client)
    assert token.startswith("nebula_app_")
    # Only a hash is stored, and the list never shows the token.
    assert token not in (apps._path.read_text()) and token not in client.get("/api/agent/spend/apps", headers=PERSON).text
    assert client.put(f"/api/agent/spend/apps/{app['id']}", json={"dailyUsd": 3}, headers={"Authorization": f"Agent {token}"}).status_code == 403
    assert client.delete(f"/api/agent/spend/apps/{app['id']}", headers=FORGED_ORIGIN).status_code == 403
    assert client.post("/api/agent/spend/apps", json={"name": "  "}, headers=PERSON).status_code == 400
    assert client.post("/api/agent/spend/apps", json={"name": "x", "dailyUsd": -1}, headers=PERSON).status_code == 400


def test_an_app_token_counts_against_its_own_line_and_the_shared_budget(client, apps):
    price(0.4)
    node_id = add_paid_node(client)
    caps = {"runCostConfirmUsd": None, "agentSpend": {"sessionUsd": 5, "outsideDailyUsd": 1, "models": {}}}
    client.put("/api/settings", json=caps, headers=PERSON)
    token, app = make_app(client, daily=5)
    as_app = {"Authorization": f"Agent {token}"}
    status = client.get("/api/agent/spend", headers=as_app).json()
    assert status["budget"] == "app" and status["agent"] == "Claude Desktop" and status["limits"]["appDailyUsd"] == 5
    assert client.post("/api/graph/run", json={"targetNodeId": node_id}, headers=as_app).status_code == 200
    assert client.post("/api/graph/run", json={"targetNodeId": node_id}).status_code == 200  # untokened: shared
    # $0.40 fits the app's $5 but not the shared $1 ($0.80 used): the stricter wins.
    refused = client.post("/api/graph/run", json={"targetNodeId": node_id}, headers=as_app)
    assert refused.status_code == 403
    assert "agents outside Nebula chats have already used $0.80 of their $1.00 budget" in refused.json()["detail"]
    view = client.get("/api/agent/spend/apps", headers=PERSON).json()
    assert view["outside"]["spentUsd"] == pytest.approx(0.8)
    assert view["apps"][0]["spentUsd"] == pytest.approx(0.4) and view["apps"][0]["name"] == "Claude Desktop"


def test_an_apps_own_daily_limit_applies(client, apps):
    price(0.4)
    node_id = add_paid_node(client)
    client.put("/api/settings", json={"runCostConfirmUsd": None, "agentSpend": {"sessionUsd": None, "models": {}}},
               headers=PERSON)
    token, app = make_app(client, name="Script", daily=0.5)
    as_app = {"Authorization": f"Agent {token}"}
    assert client.post("/api/graph/run", json={"targetNodeId": node_id}, headers=as_app).status_code == 200
    refused = client.post("/api/graph/run", json={"targetNodeId": node_id}, headers=as_app)
    assert refused.status_code == 403 and "Script has already used $0.40 of its $0.50 daily limit" in refused.json()["detail"]
    raised = client.put(f"/api/agent/spend/apps/{app['id']}", json={"dailyUsd": 2}, headers=PERSON)
    assert raised.status_code == 200 and raised.json()["app"]["dailyUsd"] == 2
    assert client.post("/api/graph/run", json={"targetNodeId": node_id}, headers=as_app).status_code == 200


def test_a_revoked_app_token_is_refused_and_its_spending_still_counts(client, apps):
    price(0.4)
    node_id = add_paid_node(client)
    client.put("/api/settings", json={"runCostConfirmUsd": None, "agentSpend": {"sessionUsd": 1, "models": {}}},
               headers=PERSON)
    token, app = make_app(client)
    as_app = {"Authorization": f"Agent {token}"}
    assert client.post("/api/graph/run", json={"targetNodeId": node_id}, headers=as_app).status_code == 200
    assert client.delete(f"/api/agent/spend/apps/{app['id']}", headers=PERSON).status_code == 200
    assert client.post("/api/graph/run", json={"targetNodeId": node_id}, headers=as_app).status_code == 401
    assert client.get("/api/agent/spend").json()["outsideSpent"]["totalUsd"] == pytest.approx(0.4)
    assert client.delete(f"/api/agent/spend/apps/{app['id']}", headers=PERSON).status_code == 404


def test_an_app_token_names_the_app_on_the_canvas(client, apps):
    import main

    token, _app = make_app(client, name="Claude Desktop")
    identity = main.identify_agent({"Authorization": f"Agent {token}"})
    assert identity is not None and identity.name == "Claude Desktop" and identity.verified
    assert main.identify_agent({"Authorization": "Agent nebula_app_forged"}) is None


# -- Krea plan runs ----------------------------------------------------------------------

PLAN = [{"id": f"k{i}", "definitionId": "krea", "params": {}} for i in range(3)]


def test_plan_runs_are_counted_and_capped():
    settings = {"runCostConfirmUsd": None, "agentSpend": {"kreaPlanRuns": 2}}
    message = refusal(PLAN, settings=settings)
    assert message is not None and "bills 3 runs to the signed-in Krea plan" in message
    assert "0 runs of its 2-run Krea plan limit" in message
    one = decide(PLAN[:1], settings=settings)
    assert one.refusal is None and one.plan_charge == {"krea": 1} and one.plan_per_node == {"k0": ("krea", 1)}
    assert decide(PLAN[:1], settings=settings, spent=agent_spend.Spent(plan_runs=2)).refusal is not None
    # With no limit the runs are still counted.
    assert decide(PLAN, settings={}).plan_charge == {"krea": 3}


def test_plan_runs_multiply_by_batch_items_and_passes():
    batch = {"id": "b", "definitionId": "batch", "params": {"items_text": "a\nb\nc"}}
    decision = decide([batch, PLAN[0]], [("b", "k0")])
    assert decision.plan_per_node == {"k0": ("krea", 3)}
    twice = agent_spend.decide(PLAN[:1], [], settings={}, pricing=pricing(), definitions=DEFINITIONS,
                               spent=agent_spend.Spent(), how_to_ask="ASK.", passes=2)
    assert twice.plan_charge == {"krea": 2}


def test_the_ledger_keeps_plan_runs():
    clock = Clock()
    ledger = agent_spend.SpendLedger(None, clock=clock)
    ledger.record("chat:a", "Claude", {}, {"krea": 2})
    ledger.refund("chat:a", {}, {"krea": 1})
    assert ledger.spent("chat:a") == agent_spend.Spent(plan_runs=1)
    at = ledger.record("outside:shared", "Outside", {}, {"krea": 3})
    ledger.refund("outside:shared", {}, {"krea": 1}, at=at)
    assert ledger.spent_outside().plan_runs == 2
    clock.now += 25 * HOUR
    assert ledger.spent_outside().plan_runs == 0


PLAN_NODE = "krea-2-generate"


def add_plan_node(client) -> str:
    # Only the person can put a dual-mode Krea node on the plan.
    response = client.post("/api/graph/node", json={"definitionId": PLAN_NODE, "params": {"_kreaAuth": "mcp"}},
                           headers=PERSON)
    assert response.status_code == 200, response.text
    return response.json()["id"]


def test_agent_plan_runs_need_a_proposal_over_the_cap(client):
    import main

    first, second = add_plan_node(client), add_plan_node(client)
    caps = {"runCostConfirmUsd": 1, "agentSpend": {"sessionUsd": None, "kreaPlanRuns": 1, "models": {}}}
    assert client.put("/api/settings", json=caps, headers=PERSON).status_code == 200
    both = client.post("/api/graph/run", json={})
    assert both.status_code == 403 and "bills 2 runs to the signed-in Krea plan" in both.json()["detail"]
    main.execute_graph.assert_not_awaited()
    assert client.post("/api/graph/run", json={"targetNodeId": first}).status_code == 200
    status = client.get("/api/agent/spend").json()
    assert status["spent"]["kreaPlanRuns"] == 1 and status["limits"]["kreaPlanRuns"] == 1
    again = client.post("/api/graph/run", json={"targetNodeId": second})
    assert again.status_code == 403 and "1 run of their 1-run Krea plan limit in the last 24 hours" in again.json()["detail"]
    # The person's own runs are never counted.
    assert client.post("/api/graph/run", json={"targetNodeId": second}, headers=PERSON).status_code == 200


def test_a_plan_node_that_never_reached_its_handler_gives_its_run_back(client, monkeypatch):
    import main

    async def answered_from_the_cache(*, nodes, run_id=None, **kwargs):
        return None  # no node reached its handler

    monkeypatch.setattr(main, "execute_graph", AsyncMock(side_effect=answered_from_the_cache))
    node_id = add_plan_node(client)
    assert client.post("/api/graph/run", json={"targetNodeId": node_id}).status_code == 200
    assert client.get("/api/agent/spend").json()["spent"]["kreaPlanRuns"] == 0


@pytest.mark.parametrize(("saved", "expected"), [
    ({}, agent_spend.DEFAULT_PLAN_RUNS),  # never set: the default, not no limit
    ({"agentSpend": {"sessionUsd": 5}}, agent_spend.DEFAULT_PLAN_RUNS),
    ({"agentSpend": {"kreaPlanRuns": None}}, None),  # the person's "No limit"
    ({"agentSpend": {"kreaPlanRuns": 25}}, 25),
    ({"agentSpend": {"kreaPlanRuns": 0}}, 0),
    # Unreadable (hand-edited, or from an older build): every plan run asks.
    ({"agentSpend": {"kreaPlanRuns": "lots"}}, 0),
    ({"agentSpend": {"kreaPlanRuns": -1}}, 0),
    ({"agentSpend": {"kreaPlanRuns": agent_spend.MAX_PLAN_RUNS + 1}}, 0),
    ({"agentSpend": {"kreaPlanRuns": True}}, 0),
    ({"agentSpend": "garbage"}, 0),
])
def test_plan_runs_fail_closed(saved, expected):
    assert agent_spend.caps_from_settings(saved)["kreaPlanRuns"] == expected


def test_plan_runs_are_held_to_the_default_until_the_person_picks():
    settings = {"runCostConfirmUsd": None}
    many = [{"id": f"k{i}", "definitionId": "krea", "params": {}} for i in range(agent_spend.DEFAULT_PLAN_RUNS + 1)]
    message = refusal(many, settings=settings)
    assert message is not None and f"{agent_spend.DEFAULT_PLAN_RUNS}-run Krea plan limit" in message
    assert refusal(many[:-1], settings=settings) is None
    assert refusal(many, settings={**settings, "agentSpend": {"kreaPlanRuns": None}}) is None
    asks = refusal(PLAN[:1], settings={**settings, "agentSpend": {"kreaPlanRuns": 0}})
    assert asks is not None and "0 runs of its 0-run Krea plan limit" in asks


def test_the_plan_run_default_doesnt_make_unpriced_nodes_ask():
    # With every USD limit off, an unpriced node runs as before; plan runs are still capped.
    unpriced = [{"id": "n4", "definitionId": "unpriced", "params": {}}]
    assert refusal(unpriced, settings={"runCostConfirmUsd": None}) is None


def test_plan_run_limits_are_kept_only_when_named():
    assert "kreaPlanRuns" not in agent_spend.validate_caps({"sessionUsd": 5}, DEFINITIONS)
    assert agent_spend.validate_caps({"kreaPlanRuns": None}, DEFINITIONS)["kreaPlanRuns"] is None
    assert agent_spend.validate_caps({"kreaPlanRuns": 0}, DEFINITIONS)["kreaPlanRuns"] == 0
    for bad in (-1, 2.5, "10", True, agent_spend.MAX_PLAN_RUNS + 1):
        with pytest.raises(ValueError):
            agent_spend.validate_caps({"kreaPlanRuns": bad}, DEFINITIONS)


def test_the_status_reports_the_default_plan_run_limit(client):
    assert client.get("/api/agent/spend").json()["limits"]["kreaPlanRuns"] == agent_spend.DEFAULT_PLAN_RUNS
    caps = {"agentSpend": {"sessionUsd": None, "kreaPlanRuns": 0, "models": {}}}
    assert client.put("/api/settings", json=caps, headers=PERSON).status_code == 200
    assert client.get("/api/agent/spend").json()["limits"]["kreaPlanRuns"] == 0
