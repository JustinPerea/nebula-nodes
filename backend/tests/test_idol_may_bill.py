"""Agents propose Idol runs when a Hugging Face token is set (a product
decision, PR #203 round 7).

With HF_TOKEN set, an Idol run uses the person's own ZeroGPU allowance, and
past it Hugging Face bills a PRO, Team or Enterprise account's prepaid
credits. Nebula prices Idol at $0 (sourced) and keeps it that way: the route
carries a separate "may bill" flag (RouteSpec ``mayBillWithKey``), and
``agent_spend.decide`` refuses an agent's run that includes such a node, at
any spending limit, pointing it at a proposal. Every agent run route goes
through that check (``main._require_spend_approval``): /api/execute and
/api/execute-node (MCP run_nodes, `nebula run`, an agent's apply and run),
/api/quick (`nebula quick`) and /api/cinema/generate-shot. Without the token
nothing can bill, so an agent runs Idol like any free node. The person's own
run is their consent, and an accepted proposal's run is theirs.
"""
from __future__ import annotations

import pytest

from services import agent_spend, model_pricing, node_route
from services.node_registry import NodeRegistry
from tests.conftest import PERSON
from tests.test_canvas_proposals import CLAUDE, CODEX, KEY, _key, api  # noqa: F401 - fixture
from tests.test_pending_nodes import _execute_body, pend  # noqa: F401 - fixture

TOKEN = "hf_fixturetoken0123456789abcdefghijklmnop"
SIGNED_IN = {"HF_TOKEN": TOKEN}
WHO = "can bill the person's Hugging Face account"

import main as _main  # noqa: E402 - the real gate, before the pend fixture stubs it

REAL_SPEND_APPROVAL = _main._require_spend_approval
REAL_MEASURE = _main._measure_run_inputs


def _decide(items, keys, **settings):
    return agent_spend.decide(
        items, [], settings={"apiKeys": dict(keys), **settings}, pricing=model_pricing.load_pricing(),
        definitions=NodeRegistry().get_all(), how_to_ask="Propose it.")


IDOL = {"id": "n1", "definitionId": "speridlabs-idol", "params": {"_provider": "auto"}}
TEXT = {"id": "t1", "definitionId": "text-input", "params": {"value": "a"}}


# -- the rule ------------------------------------------------------------------


def test_an_agent_run_with_idol_and_a_token_needs_a_proposal_at_any_limit():
    for settings in ({}, {"runCostConfirmUsd": 100}):
        decision = _decide([TEXT, IDOL], SIGNED_IN, **settings)
        assert decision.refusal is not None
        assert decision.refusal.startswith("Needs the person's approval: n1 (Idol) " + WHO)
        assert "PRO, Team or Enterprise account's prepaid credits" in decision.refusal
        assert decision.refusal.endswith("An agent can't start it itself, at any spending limit. Propose it.")
        # Idol is never counted as paid: its price stays the sourced $0.
        assert decision.charge.get("speridlabs-idol", 0) == 0


def test_without_a_token_an_agent_runs_idol_with_no_proposal():
    for keys in ({}, {"HF_TOKEN": ""}):
        assert _decide([TEXT, IDOL], keys).refusal is None
        assert _decide([TEXT, IDOL], keys, runCostConfirmUsd=0.01).refusal is None


def test_a_run_without_idol_is_unchanged_by_the_token():
    assert _decide([TEXT], SIGNED_IN).refusal is None


def test_may_bill_nodes_lists_only_the_nodes_that_may_bill():
    definitions = NodeRegistry().get_all()
    second = {**IDOL, "id": "n2"}
    assert agent_spend.may_bill_nodes([TEXT, IDOL, second], definitions, SIGNED_IN) == ["n1", "n2"]
    assert agent_spend.may_bill_nodes([TEXT, IDOL], definitions, {}) == []


def test_the_flag_not_the_price_decides():
    """A keyless route without mayBillWithKey (a free Space that can't bill)
    needs no proposal with its optional key set."""
    definitions = NodeRegistry().get_all()
    unflagged = {**definitions["speridlabs-idol"],
                 "routes": [{k: v for k, v in definitions["speridlabs-idol"]["routes"][0].items()
                             if k != "mayBillWithKey"}]}
    assert node_route.may_bill(unflagged, IDOL["params"], SIGNED_IN) is False
    assert agent_spend.may_bill_nodes([IDOL], {**definitions, "speridlabs-idol": unflagged}, SIGNED_IN) == []


def test_two_flagged_nodes_are_named_together():
    decision = _decide([IDOL, {**IDOL, "id": "n2"}], SIGNED_IN)
    assert decision.refusal.startswith("Needs the person's approval: n1 (Idol), n2 (Idol) " + WHO)


# -- every agent run route -------------------------------------------------------


@pytest.fixture
def gated(pend, monkeypatch):  # noqa: F811 - the imported fixture
    """The pend app (a fake engine) with the real spend check, and keys as given."""
    main = pend.main
    monkeypatch.setattr(main, "_require_spend_approval", REAL_SPEND_APPROVAL)
    monkeypatch.setattr(main, "_measure_run_inputs", REAL_MEASURE)
    real = main.load_settings

    def keys(api_keys):
        monkeypatch.setattr(main, "load_settings", lambda *a, **k: {**real(*a, **k), "apiKeys": dict(api_keys)})

    pend.keys = keys
    return pend


def _idol_graph(api):
    image = api.graph.add_node("image-input", {"filePath": "/x.png"})
    idol = api.graph.add_node("speridlabs-idol", {})
    api.graph.connect(image, "image", idol, "image")
    return image, idol


def _execute(api, headers, run_id, target=None):
    body = {**_execute_body(api), "runId": run_id}
    if target is None:
        return api.client.post("/api/execute", headers=headers, json=body)
    return api.client.post("/api/execute-node", headers=headers, json={**body, "targetNodeId": target})


@pytest.mark.parametrize("node_run", [False, True], ids=["execute", "execute-node"])
def test_an_agents_run_with_idol_and_a_token_is_sent_to_a_proposal(gated, node_run):
    _, idol = _idol_graph(gated)
    gated.keys(SIGNED_IN)
    response = _execute(gated, CLAUDE, "r1", idol if node_run else None)
    assert response.status_code == 403, response.text
    detail = response.json()["detail"]
    assert WHO in detail and "Propose it instead: `nebula propose" in detail
    assert f"--run {idol}" in detail or not node_run
    assert gated.ran == []


@pytest.mark.parametrize("node_run", [False, True], ids=["execute", "execute-node"])
def test_an_agents_run_with_idol_and_no_token_runs(gated, node_run):
    _, idol = _idol_graph(gated)
    gated.keys({})
    response = _execute(gated, CLAUDE, "r1", idol if node_run else None)
    assert response.status_code == 200, response.text
    assert response.json()["status"] == "started"
    assert any(idol in ran for ran in gated.ran)


@pytest.mark.parametrize("node_run", [False, True], ids=["execute", "execute-node"])
def test_the_persons_run_with_idol_and_a_token_runs(gated, node_run):
    _, idol = _idol_graph(gated)
    gated.keys(SIGNED_IN)
    response = _execute(gated, PERSON, "r1", idol if node_run else None)
    assert response.status_code == 200, response.text
    assert response.json()["status"] == "started"


def test_an_agents_run_without_idol_is_unchanged_by_the_token(gated):
    text = gated.graph.add_node("text-input", {"value": "a"})
    gated.keys(SIGNED_IN)
    response = _execute(gated, CLAUDE, "r1", text)
    assert response.status_code == 200, response.text
    assert gated.ran == [[text]]


def _quick(api, monkeypatch, headers):
    called = []

    async def fake(**kwargs):
        called.append(1)

    monkeypatch.setattr(api.main, "execute_graph", fake)
    response = api.client.post("/api/quick", headers=headers, json={
        "definitionId": "speridlabs-idol", "inputs": {"image": "https://example.com/a.png"}, "params": {}})
    return response, called


def test_quick_with_a_token_sends_an_agent_to_a_proposal_and_runs_the_persons(gated, monkeypatch):
    gated.keys(SIGNED_IN)
    response, called = _quick(gated, monkeypatch, CLAUDE)
    assert response.status_code == 403, response.text
    detail = response.json()["detail"]
    assert detail.startswith("Needs the person's approval: ") and WHO in detail
    assert "`nebula create speridlabs-idol`" in detail and called == []
    response, called = _quick(gated, monkeypatch, PERSON)
    assert response.status_code == 200, response.text
    assert called == [1]


def test_quick_without_a_token_runs_for_an_agent(gated, monkeypatch):
    gated.keys({})
    response, called = _quick(gated, monkeypatch, CODEX)
    assert response.status_code == 200, response.text
    assert called == [1]


@pytest.mark.parametrize("target", [False, True], ids=["whole-canvas", "one-node"])
def test_nebula_run_and_mcp_run_nodes_send_an_agents_idol_run_with_a_token_to_a_proposal(gated, target):
    """`nebula run` and MCP run_nodes post /api/graph/run (cli/client.py,
    mcp_server.run_nodes): the same check, before anything runs."""
    _, idol = _idol_graph(gated)
    body = {"wait": 5, **({"targetNodeId": idol} if target else {})}
    gated.keys(SIGNED_IN)
    response = gated.client.post("/api/graph/run", headers=CLAUDE, json=body)
    assert response.status_code == 403, response.text
    assert WHO in response.json()["detail"] and gated.ran == []
    gated.keys({})
    response = gated.client.post("/api/graph/run", headers=CLAUDE, json=body)
    assert response.status_code == 200, response.text
    assert any(idol in ran for ran in gated.ran)
