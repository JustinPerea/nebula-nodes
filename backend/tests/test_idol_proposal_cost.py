"""How a proposal counts a run that may bill the person's own account.

GM, PR #203 r11 items 2, 4 and 6, and r12: Idol runs free on Hugging Face's
shared GPUs without a token and on the person's own allowance with one. It is
never counted as "paid": with a token it "may cost" (its own count, named,
with the account it may bill), without one it is free. It adds nothing to the
estimate line (not "$0": past the allowance the cost is real). A sourced $0 is
told apart from an estimate that rounds to zero by its source, not its value.
"""

from __future__ import annotations

import pytest

from cli.formatter import _cost_line
from services import model_pricing, node_route
from services.canvas_proposals import cost_for, summarize_cost
from services.node_registry import NodeRegistry
from tests.test_canvas_proposals import CLAUDE, _propose, api  # noqa: F401 - fixture

TOKEN = "hf_" + "a" * 34
SIGNED_IN = {"HF_TOKEN": TOKEN}
DEFINITIONS = NodeRegistry().get_all()
IDOL = DEFINITIONS["speridlabs-idol"]


# -- key_billing ----------------------------------------------------------------


def test_key_billing_is_may_cost_with_the_token_and_free_without():
    assert node_route.key_billing(IDOL, {}, SIGNED_IN) == "mayCost"
    assert node_route.key_billing(IDOL, {}, {}) == "free"
    assert node_route.key_billing(IDOL, {"_provider": "auto"}, {"HF_TOKEN": ""}) == "free"


def test_key_billing_leaves_every_other_node_as_it_was():
    assert node_route.key_billing(DEFINITIONS["nano-banana"], {}, {"GEMINI_API_KEY": "k"}) is None
    assert node_route.key_billing(DEFINITIONS["text-input"], {}, {}) is None
    assert node_route.key_billing(None, {}, {}) is None


def test_key_billing_reads_the_flag_not_the_node():
    unflagged = {**IDOL, "routes": [{k: v for k, v in route.items() if k != "mayBillWithKey"} for route in IDOL["routes"]]}
    assert node_route.key_billing(unflagged, {}, SIGNED_IN) is None


# -- cost_for ---------------------------------------------------------------------


def test_cost_for_idol_with_a_token_may_cost_on_hugging_face():
    entry = cost_for(IDOL, {}, DEFINITIONS, SIGNED_IN)
    assert entry["kind"] == "mayCost"
    assert entry["label"] == "may cost · Hugging Face"
    assert entry["name"] == "Idol" and entry["account"] == "Hugging Face"


def test_cost_for_idol_without_a_token_is_free_on_hugging_face():
    entry = cost_for(IDOL, {}, DEFINITIONS, {})
    assert entry["kind"] == "free"
    assert entry["label"] == "free · Hugging Face"


def test_cost_for_a_paid_node_is_unchanged():
    assert cost_for(DEFINITIONS["nano-banana"], {}, DEFINITIONS, {"GEMINI_API_KEY": "k"})["kind"] == "paid"


# -- summarize_cost ---------------------------------------------------------------


def _entry(ref, kind, name="", account=""):
    return {"ref": ref, "nodeId": None, "kind": kind, "provider": "google" if kind == "paid" else "huggingface",
            "label": kind, "price": None, "name": name, "account": account}


def test_summarize_counts_may_cost_apart_from_paid_and_free():
    summary = summarize_cost([_entry("+a", "paid"), _entry("+b", "paid"), _entry("+i", "mayCost", "Idol", "Hugging Face"),
                              _entry("+t", "free")], up_to=False)
    assert summary["paidRuns"] == 2
    assert summary["mayCostRuns"] == 1
    assert summary["mayCost"] == [{"name": "Idol", "account": "Hugging Face"}]
    assert summary["freeRuns"] == 1
    assert summary["providers"] == ["google"]


def test_summarize_names_two_idol_runs_once():
    summary = summarize_cost([_entry("+i", "mayCost", "Idol", "Hugging Face"),
                              _entry("+j", "mayCost", "Idol", "Hugging Face")], up_to=False)
    assert summary["mayCostRuns"] == 2
    assert summary["mayCost"] == [{"name": "Idol", "account": "Hugging Face"}]
    assert summary["freeRuns"] == 0


def test_summarize_passes_a_sourced_zero_on_and_only_then():
    base = {"currency": "usd", "low": 0, "high": 0, "unpriced": [], "plan": [], "plus": []}
    sourced = summarize_cost([_entry("+a", "paid")], up_to=False, estimate={**base, "sourcedZero": True})["estimate"]
    assert sourced["sourcedZero"] is True
    rounded = summarize_cost([_entry("+a", "paid")], up_to=False, estimate={**base, "sourcedZero": False})["estimate"]
    assert "sourcedZero" not in rounded


# -- estimate_run: a sourced $0 by its source ----------------------------------------


def test_estimate_run_says_sourced_zero_only_when_every_priced_row_is_zero():
    pricing = model_pricing.load_pricing()
    idol = [{"id": "n1", "definitionId": "speridlabs-idol", "params": {}}]
    assert model_pricing.estimate_run(idol, pricing, DEFINITIONS, {})["sourcedZero"] is True
    paid = [{"id": "n2", "definitionId": "nano-banana", "params": {}}]
    both = model_pricing.estimate_run(idol + paid, pricing, DEFINITIONS, {"GEMINI_API_KEY": "k"})
    assert both["high"] and both["high"] > 0
    assert both["sourcedZero"] is False


def test_estimate_run_with_nothing_priced_is_not_a_sourced_zero():
    text = [{"id": "t1", "definitionId": "text-input", "params": {"value": "a"}}]
    assert model_pricing.estimate_run(text, model_pricing.load_pricing(), DEFINITIONS, {})["sourcedZero"] is False


# -- the CLI's cost line ---------------------------------------------------------------


def test_the_cli_names_a_may_cost_run_apart_from_paid():
    alone = {"paidRuns": 0, "mayCostRuns": 1, "mayCost": [{"name": "Idol", "account": "Hugging Face"}], "freeRuns": 0}
    assert _cost_line(alone) == "1 run: 1 that may bill the person's own account (Idol)"
    mixed = {**alone, "paidRuns": 2, "providers": ["google"], "estimate": None}
    assert _cost_line(mixed) == "2 paid runs (google), 1 that may bill the person's own account (Idol) — no list price"


def test_the_cli_line_without_may_cost_is_unchanged():
    assert _cost_line({"paidRuns": 0, "freeRuns": 2}) == "2 free runs (runs locally)"


# -- end to end: a proposal with Idol ----------------------------------------------------


@pytest.fixture
def keyed(api, monkeypatch):  # noqa: F811 - the imported fixture
    real = api.main.load_settings

    def keys(api_keys):
        monkeypatch.setattr(api.main, "load_settings", lambda *a, **k: {**real(*a, **k), "apiKeys": dict(api_keys)})

    api.keys = keys
    return api


def _idol_and_paid(api):
    image = api.graph.add_node("image-input", {"filePath": "/x.png"})
    api.graph.nodes[image]["outputs"] = {"image": {"type": "Image", "value": "/x.png"}}
    text = api.graph.add_node("text-input", {"value": "a cat"})
    api.graph.nodes[text]["outputs"] = {"text": {"type": "Text", "value": "a cat"}}
    return {
        "note": "a world and a picture",
        "nodes": [{"ref": "+idol", "definitionId": "speridlabs-idol", "params": {}},
                  {"ref": "+img", "definitionId": "nano-banana", "params": {"aspect_ratio": "16:9"}}],
        "edges": [{"source": image, "sourceHandle": "image", "target": "+idol", "targetHandle": "image"},
                  {"source": text, "sourceHandle": "text", "target": "+img", "targetHandle": "prompt"}],
        "run": ["+idol", "+img"],
    }


def test_a_proposal_with_idol_and_a_token_counts_it_as_may_cost_and_leaves_it_out_of_the_estimate(keyed):
    keyed.keys({**SIGNED_IN, "GEMINI_API_KEY": "k"})
    response = _propose(keyed, _idol_and_paid(keyed))
    assert response.status_code == 201, response.text
    cost = response.json()["proposal"]["cost"]
    assert cost["paidRuns"] == 1 and cost["mayCostRuns"] == 1 and cost["freeRuns"] == 0
    assert cost["mayCost"] == [{"name": "Idol", "account": "Hugging Face"}]
    kinds = {node["ref"]: node["kind"] for node in cost["nodes"]}
    assert kinds == {"+idol": "mayCost", "+img": "paid"}
    estimate = cost["estimate"]
    assert estimate is not None and estimate["high"] > 0
    assert "+idol" not in estimate["unpriced"]
    assert "sourcedZero" not in estimate


def test_a_proposal_with_idol_and_no_token_counts_it_free(keyed):
    keyed.keys({"GEMINI_API_KEY": "k"})
    response = _propose(keyed, _idol_and_paid(keyed))
    assert response.status_code == 201, response.text
    cost = response.json()["proposal"]["cost"]
    assert cost["paidRuns"] == 1 and cost["mayCostRuns"] == 0 and cost["freeRuns"] == 1
    assert cost["mayCost"] == []
    assert {node["ref"]: node["kind"] for node in cost["nodes"]}["+idol"] == "free"


@pytest.mark.parametrize("api_keys", [SIGNED_IN, {}], ids=["token", "no-token"])
def test_a_proposal_that_runs_only_idol_has_no_estimate_line(keyed, api_keys):
    """Not "$0" (its sourced price): with a token, time past the allowance
    is billed; without one there is nothing to estimate."""
    keyed.keys(api_keys)
    body = _idol_and_paid(keyed)
    body = {**body, "nodes": body["nodes"][:1], "edges": body["edges"][:1], "run": ["+idol"]}
    response = _propose(keyed, body)
    assert response.status_code == 201, response.text
    cost = response.json()["proposal"]["cost"]
    assert cost["estimate"] is None
    assert {node["ref"]: node["price"] for node in cost["nodes"]}["+idol"] is None


# -- the ghost card and every listing read the keys set now (GM, PR #203 r15) -----------


def _ghost(proposal, ref="+idol"):
    return next(node for node in proposal["nodes"] if node["ref"] == ref)


def _listed(api, proposal_id):
    """What an agent's listing (MCP list_proposals, `nebula proposals`) reads."""
    listed = api.client.get("/api/canvas/proposals", headers=CLAUDE).json()["proposals"]
    return next(proposal for proposal in listed if proposal["id"] == proposal_id)


def test_the_ghost_card_prices_idol_with_the_token_as_the_run_does(keyed):
    keyed.keys({**SIGNED_IN, "GEMINI_API_KEY": "k"})
    proposal = _propose(keyed, _idol_and_paid(keyed)).json()["proposal"]
    assert _ghost(proposal)["cost"]["label"] == "may cost · Hugging Face"
    assert _ghost(proposal)["cost"]["kind"] == "mayCost"
    listed = _listed(keyed, proposal["id"])
    assert _ghost(listed)["cost"]["label"] == "may cost · Hugging Face"
    assert listed["cost"]["mayCostRuns"] == 1


def test_the_ghost_card_without_a_token_is_free(keyed):
    keyed.keys({"GEMINI_API_KEY": "k"})
    proposal = _propose(keyed, _idol_and_paid(keyed)).json()["proposal"]
    assert _ghost(proposal)["cost"]["label"] == "free · Hugging Face"
    assert _ghost(_listed(keyed, proposal["id"]))["cost"]["label"] == "free · Hugging Face"


def test_a_token_added_after_the_proposal_makes_idol_may_cost_everywhere(keyed):
    """Review 7, NIT-5: the count isn't frozen at propose time."""
    keyed.keys({"GEMINI_API_KEY": "k"})
    proposal = _propose(keyed, _idol_and_paid(keyed)).json()["proposal"]
    assert proposal["cost"]["mayCostRuns"] == 0 and proposal["cost"]["freeRuns"] == 1
    keyed.keys({**SIGNED_IN, "GEMINI_API_KEY": "k"})
    listed = _listed(keyed, proposal["id"])
    assert _ghost(listed)["cost"]["label"] == "may cost · Hugging Face"
    cost = listed["cost"]
    assert cost["mayCostRuns"] == 1 and cost["freeRuns"] == 0 and cost["paidRuns"] == 1
    assert cost["mayCost"] == [{"name": "Idol", "account": "Hugging Face"}]
    assert {node["ref"]: node["kind"] for node in cost["nodes"]}["+idol"] == "mayCost"
    # The estimate is unchanged: Idol adds nothing to it either way.
    assert cost["estimate"] == proposal["cost"]["estimate"]


def test_a_token_removed_after_the_proposal_makes_idol_free_everywhere(keyed):
    keyed.keys({**SIGNED_IN, "GEMINI_API_KEY": "k"})
    proposal = _propose(keyed, _idol_and_paid(keyed)).json()["proposal"]
    assert proposal["cost"]["mayCostRuns"] == 1
    keyed.keys({"GEMINI_API_KEY": "k"})
    listed = _listed(keyed, proposal["id"])
    assert _ghost(listed)["cost"]["label"] == "free · Hugging Face"
    cost = listed["cost"]
    assert cost["mayCostRuns"] == 0 and cost["mayCost"] == [] and cost["freeRuns"] == 1
    assert {node["ref"]: node["label"] for node in cost["nodes"]}["+idol"] == "free · Hugging Face"


def test_an_idol_on_the_canvas_in_the_run_follows_the_token(keyed):
    """A canvas node the run starts: its class comes from the params it was
    priced with, kept on the proposal (never shown)."""
    keyed.keys({})
    image = keyed.graph.add_node("image-input", {"filePath": "/x.png"})
    keyed.graph.nodes[image]["outputs"] = {"image": {"type": "Image", "value": "/x.png"}}
    idol = keyed.graph.add_node("speridlabs-idol", {})
    keyed.graph.connect(image, "image", idol, "image")
    response = _propose(keyed, {"note": "run the world", "run": [idol]})
    assert response.status_code == 201, response.text
    proposal = response.json()["proposal"]
    assert proposal["cost"]["freeRuns"] == 1 and proposal["cost"]["mayCostRuns"] == 0
    assert "_keyParams" not in proposal["cost"] and "keyParams" not in str(proposal)
    keyed.keys(SIGNED_IN)
    cost = _listed(keyed, proposal["id"])["cost"]
    assert cost["mayCostRuns"] == 1 and cost["freeRuns"] == 0
