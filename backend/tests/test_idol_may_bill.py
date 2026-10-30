"""Agents propose Idol runs when a Hugging Face token is set (a product
decision, PR #203 round 7).

With HF_TOKEN set, an Idol run uses the person's own ZeroGPU allowance, and
past it Hugging Face bills a PRO, Team or Enterprise account's prepaid
credits. Nebula prices Idol at $0 (sourced) and keeps it that way: the route
carries a separate "may bill" flag (RouteSpec ``mayBillWithKey``), and
``agent_spend.decide`` refuses an agent's run that includes such a node, at
any spending limit, pointing it at a proposal. Every agent run route goes
through that check (``main._require_spend_approval``): /api/execute and
/api/execute-node (the canvas's runs and an agent's apply and run),
/api/graph/run (MCP run_nodes and `nebula run` post it), /api/quick
(`nebula quick`) and /api/cinema/generate-shot. Without the token
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
WHO = "is in this run and the person's Hugging Face token is set, so it can bill their Hugging Face account"

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
    # Review 7, LOW-3: with every limit off, too.
    every_limit_off = {"runCostConfirmUsd": None,
                       "agentSpend": {"sessionUsd": None, "outsideDailyUsd": None, "models": {}}}
    for settings in ({}, {"runCostConfirmUsd": 100}, every_limit_off):
        decision = _decide([TEXT, IDOL], SIGNED_IN, **settings)
        assert decision.refusal is not None
        assert decision.refusal.startswith("Needs the person's approval: n1 (Idol) " + WHO)
        assert "PRO, Team or Enterprise account's prepaid credits" in decision.refusal
        # Review 7, NIT-3: why, and what to do instead.
        assert decision.refusal.endswith(
            "An agent can't start a run that includes it, at any spending limit, even for a node after it: "
            "propose the run, or run only nodes that don't need it. Propose it.")
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
    assert decision.refusal.startswith("Needs the person's approval: n1 (Idol), n2 (Idol) are in this run and the "
                                       "person's Hugging Face token is set, so they can bill their Hugging Face account")
    assert "includes them" in decision.refusal and "don't need them" in decision.refusal


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


# -- a Cinema shot (review 7, LOW-3) and the person's run over a placeholder ---------------


def _idol_shot(api, headers):
    """/api/cinema/generate-shot over a scene that reads an Idol node's output."""
    image, idol = _idol_graph(api)
    cine = api.graph.add_node("cinema-scene", {"scene": {
        "version": 1, "base": {"model": "seedream-4-5"}, "aspectRatio": "16:9",
        "shots": [{"id": "a", "prompt": "a cat"}]}})
    nodes, edges = api.graph.to_execute_format()
    edges = [*edges, {"id": "e-idol", "source": idol, "sourceHandle": "world",
                      "target": cine, "targetHandle": "character_refs"}]
    return api.client.post("/api/cinema/generate-shot", headers=headers,
                           json={"nodes": nodes, "edges": edges, "nodeId": cine, "shotId": "a"}), idol


def test_an_agents_cinema_shot_reading_idol_with_a_token_is_sent_to_a_proposal(gated):
    gated.keys(SIGNED_IN)
    response, idol = _idol_shot(gated, CLAUDE)
    assert response.status_code == 403, response.text
    assert WHO in response.json()["detail"] and gated.ran == []


def test_an_agents_cinema_shot_reading_idol_without_a_token_is_not_held_for_idol(gated):
    """Without the token Idol can't bill: any refusal is the scene's own
    (it has no list price at the fixture's limits), never Idol's."""
    gated.keys({})
    response, _idol = _idol_shot(gated, CLAUDE)
    assert WHO not in response.text and "Hugging Face" not in response.text


def _idol_placeholder(api):
    """An agent's Idol placeholder fed by a free image input."""
    from tests.test_pending_nodes import _apply

    image = api.graph.add_node("image-input", {"filePath": "/x.png"})
    response = _apply(api, {"note": "a world", "nodes": [{"ref": "+w", "definitionId": "speridlabs-idol"}],
                            "edges": [{"source": image, "sourceHandle": "image", "target": "+w",
                                       "targetHandle": "image"}], "pending": True})
    assert response.status_code == 200, response.text
    return response.json()["idMap"]["+w"]


def test_the_persons_run_over_an_idol_placeholder_without_a_token_needs_no_confirm(gated):
    """GM, PR #203 r15 item 2: free with no token, so no paid confirm on its own."""
    gated.keys({})
    idol = _idol_placeholder(gated)
    response = _execute(gated, PERSON, "r-free", idol)
    assert response.status_code == 200, response.text
    assert any(idol in ran for ran in gated.ran)


def test_the_persons_run_over_an_idol_placeholder_with_a_token_still_asks(gated):
    """"May cost" with the token: the person confirms it like a paid one."""
    gated.keys(SIGNED_IN)
    idol = _idol_placeholder(gated)
    response = _execute(gated, PERSON, "r-may", idol)
    assert response.status_code == 409, response.text
    detail = response.json()["detail"]
    assert detail["code"] == "placeholder_confirm_required" and detail["placeholders"] == [idol]
    assert gated.ran == []


# -- one "token is set" for the gate, the handler and Settings (review 7, NIT-4) -----------


def _key_cases():
    import json
    from pathlib import Path

    path = Path(__file__).parent / "fixtures" / "key_text_cases.json"
    return json.loads(path.read_text(encoding="utf-8"))["cases"]


@pytest.mark.parametrize("case", _key_cases(), ids=lambda case: repr(case["raw"]))
def test_key_text_reads_each_shared_case(case):
    assert node_route.key_text(case["raw"]) == case["text"]


@pytest.mark.parametrize("token", ["\ufeff", "\u200b", " \u2060\ufeff\n", "\u00a0"])
def test_an_invisible_only_token_is_unset_for_the_gate_and_the_handler(token):
    """Before: the gate read a BOM-only token as set (may bill), the handler as
    a bad character, and Settings (JS trim) as unset. Now unset for all."""
    from handlers.speridlabs_idol import clean_token

    keys = {"HF_TOKEN": token}
    assert _decide([TEXT, IDOL], keys).refusal is None
    assert node_route.key_billing(NodeRegistry().get("speridlabs-idol"), {}, keys) == "free"
    assert clean_token(token) is None
    assert node_route.key_set(keys, "HF_TOKEN") is False


def test_a_padded_token_is_set_for_all_three_and_sent_trimmed():
    from handlers.speridlabs_idol import clean_token

    from services.settings import PROVIDER_CHECKS, hf_token_character_line

    keys = {"HF_TOKEN": f"\ufeff{TOKEN}\u200b\n"}
    assert _decide([TEXT, IDOL], keys).refusal is not None
    assert clean_token(keys["HF_TOKEN"]) == TOKEN
    assert node_route.key_set(keys, "HF_TOKEN") is True
    # The Settings check trims the same way, so it checks the token the run sends.
    assert hf_token_character_line(keys["HF_TOKEN"]) is None
    assert PROVIDER_CHECKS["Hugging Face"].auth_headers(keys["HF_TOKEN"]) == {"Authorization": f"Bearer {TOKEN}"}
