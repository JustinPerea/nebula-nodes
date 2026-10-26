"""Placeholders, round 4 (review 3 of feat/agent-presence, GM - Design's
round-4 rulings of 2026-10-25).

Justin, Q133 b: the person's direct run makes the placeholders it needs
normal and runs them, but when any of them calls a paid model Nebula ALWAYS
asks first, and the backend refuses a direct run that doesn't name exactly
those placeholders. These tests hold that on every route that runs or prices
canvas nodes (the route table below), and pin the cost the person confirmed
against what runs.
"""
from __future__ import annotations

import pytest

from services import canvas_undo, pending_nodes
from tests.conftest import PERSON
from tests.test_canvas_proposals import CLAUDE, CODEX, KEY, _key, api  # noqa: F401 - fixture
from tests.test_pending_nodes import (  # noqa: F401 - fixture
    CLAUDE_ID, CODEX_ID, _apply, _chain, _direct, _execute_body, _owner, _paid_chain, _undo, pend,
)

GM_ONE = ("Nothing ran. This run includes 1 paid node Claude Code is still setting up, and Nebula asks "
          "before running those. Click “Run” again to review it.")


def _cinema(pend, source: str) -> str:
    """A Cinema Scene fed by ``source``'s image (its character references)."""
    cine = pend.graph.add_node("cinema-scene", {"scene": {
        "version": 1, "base": {"model": "seedream-4-5"}, "aspectRatio": "16:9",
        "shots": [{"id": "a", "prompt": "a cat"}, {"id": "b", "prompt": "a dog"}]}})
    pend.graph.connect(source, "image", cine, "character_refs")
    return cine


def _shot(pend, cine: str, headers=PERSON, **extra):
    nodes, edges = pend.graph.to_execute_format()
    return pend.client.post("/api/cinema/generate-shot", headers=headers,
                            json={"nodes": nodes, "edges": edges, "nodeId": cine, "shotId": "a", **extra})


def _priced_ids(pend) -> set[str]:
    return {node_id for priced in pend.priced for node_id in priced}


def _ran_ids(pend) -> set[str]:
    return {node_id for ran in pend.ran for node_id in ran}


# -- finding 1: a Cinema shot is a direct run ---------------------------------------------------

@pytest.mark.parametrize("confirmed", [None, [], ["+p"]])
def test_the_persons_shot_over_a_paid_placeholder_needs_their_confirmation(pend, confirmed):
    ids = _paid_chain(pend)
    cine = _cinema(pend, ids["+i"])
    extra = {} if confirmed is None else {"confirmedPlaceholders": [ids.get(ref, ref) for ref in confirmed]}
    response = _shot(pend, cine, **extra)
    assert response.status_code == 409, response.text
    detail = response.json()["detail"]
    assert detail["code"] == "placeholder_confirm_required"
    assert detail["placeholders"] == [ids["+i"]]
    assert detail["message"] == GM_ONE
    assert pend.priced == [] and pend.ran == []
    assert all(_owner(pend, node_id)["id"] == CLAUDE_ID for node_id in ids.values())


def test_the_persons_confirmed_shot_runs_them_and_turns_them_normal(pend):
    ids = _paid_chain(pend)
    cine = _cinema(pend, ids["+i"])
    response = _shot(pend, cine, confirmedPlaceholders=[ids["+i"]])
    assert response.status_code == 200, response.text
    assert ids["+i"] in _priced_ids(pend)
    assert all(_owner(pend, node_id) is None for node_id in ids.values())


def test_another_agents_shot_skips_the_placeholders_and_prices_nothing_of_them(pend):
    ids = _paid_chain(pend)  # Claude Code's
    cine = _cinema(pend, ids["+i"])
    response = _shot(pend, cine, headers=CODEX, confirmedPlaceholders=[ids["+i"]])
    assert response.status_code == 200, response.text
    body = response.json()
    assert body["status"] == "skipped"
    assert set(body["skipped"]) == {ids["+p"], ids["+i"], cine}
    assert not (_priced_ids(pend) & set(ids.values())) and not (_ran_ids(pend) & set(ids.values()))
    assert all(_owner(pend, node_id)["id"] == CLAUDE_ID for node_id in ids.values())


def test_the_owning_agents_shot_runs_its_own_placeholders(pend):
    ids = _paid_chain(pend)
    cine = _cinema(pend, ids["+i"])
    response = _shot(pend, cine, headers=CLAUDE)
    assert response.status_code == 200, response.text
    assert ids["+i"] in _priced_ids(pend)
    assert all(_owner(pend, node_id) is None for node_id in ids.values())


# -- the route table: every route that runs or prices canvas nodes ----------------------------

def _person_route(pend, route: str, target: str, cine: str | None):
    if route == "execute":
        return pend.client.post("/api/execute", headers=PERSON, json=_execute_body(pend))
    if route == "execute-node":
        return _direct(pend, target)
    if route == "cinema-shot":
        return _shot(pend, cine)
    if route == "graph-run":
        return pend.client.post("/api/graph/run", headers=PERSON, json={"targetNodeId": target})
    raise AssertionError(route)


@pytest.mark.parametrize("route, expect", [
    # The whole canvas: the person's Run skips every placeholder and what needs it.
    ("execute", "skips"),
    # A node's own Run, the Inspector, the context menu, a replay of a node run.
    ("execute-node", "asks"),
    # The Cinema panel's Generate and a shot replay.
    ("cinema-shot", "asks"),
    # `nebula run` with the person's token is not the canvas's direct Run: it skips.
    ("graph-run", "skips"),
])
def test_route_table_a_paid_placeholder_never_runs_unconfirmed_for_the_person(pend, route, expect):
    """Q133 on every route: the person's run either skips an agent's paid
    placeholder (nothing priced, still pending) or refuses until the person
    confirmed exactly it (409 placeholder_confirm_required)."""
    ids = _paid_chain(pend)
    cine = _cinema(pend, ids["+i"]) if route == "cinema-shot" else None
    target = ids["+i"]
    response = _person_route(pend, route, target, cine)
    if expect == "asks":
        assert response.status_code == 409, response.text
        assert response.json()["detail"]["code"] == "placeholder_confirm_required"
    else:
        assert response.status_code == 200, response.text
        assert ids["+i"] in (response.json().get("skipped") or {})
    assert ids["+i"] not in _priced_ids(pend) and ids["+i"] not in _ran_ids(pend)
    assert _owner(pend, ids["+i"])["id"] == CLAUDE_ID


@pytest.mark.parametrize("route", ["execute", "execute-node", "cinema-shot", "graph-run"])
def test_route_table_another_agent_never_runs_or_prices_a_placeholder_not_its_own(pend, route):
    ids = _paid_chain(pend)  # Claude Code's
    cine = _cinema(pend, ids["+i"]) if route == "cinema-shot" else None
    if route == "execute":
        response = pend.client.post("/api/execute", headers=CODEX, json=_execute_body(pend))
    elif route == "execute-node":
        response = _direct(pend, ids["+i"], [ids["+i"]], headers=CODEX)
    elif route == "cinema-shot":
        response = _shot(pend, cine, headers=CODEX, confirmedPlaceholders=[ids["+i"]])
    else:
        response = pend.client.post("/api/graph/run", headers=CODEX, json={"targetNodeId": ids["+i"]})
    assert response.status_code == 200, response.text
    assert ids["+i"] not in _priced_ids(pend) and ids["+i"] not in _ran_ids(pend)
    assert _owner(pend, ids["+i"])["id"] == CLAUDE_ID


def test_route_table_an_approved_proposal_run_with_a_made_up_approval_skips(pend):
    """An accepted proposal's run is not the person's direct run: with an
    approval id (even one that doesn't exist) the placeholder is skipped
    before anything is priced, never run."""
    ids = _paid_chain(pend)
    body = {**_execute_body(pend), "targetNodeId": ids["+i"], "approvalId": "ap_" + "0" * 16}
    pend.client.post("/api/execute-node", headers=PERSON, json=body)
    assert ids["+i"] not in _ran_ids(pend) and ids["+i"] not in _priced_ids(pend)
    assert _owner(pend, ids["+i"])["id"] == CLAUDE_ID


# -- finding 2: the cost the person confirmed is the cost that runs ---------------------------

def test_a_confirmed_run_costing_more_than_the_person_confirmed_is_refused(pend):
    ids = _paid_chain(pend)
    response = pend.client.post(
        "/api/execute-node", headers=PERSON,
        json={**_execute_body(pend), "targetNodeId": ids["+i"], "confirmedPlaceholders": [ids["+i"]],
              "confirmedCost": 0.0001})
    assert response.status_code == 409, response.text
    detail = response.json()["detail"]
    assert detail["code"] == "placeholder_confirm_required"
    assert detail["message"] == GM_ONE
    assert pend.ran == [] and pend.priced == []
    assert _owner(pend, ids["+i"])["id"] == CLAUDE_ID


def test_a_confirmed_run_within_what_the_person_confirmed_runs(pend):
    ids = _paid_chain(pend)
    high = pend.main._run_estimate_high(
        [pend.main.GraphNode.model_validate(node) for node in _execute_body(pend)["nodes"]],
        [pend.main.GraphEdge.model_validate(edge) for edge in _execute_body(pend)["edges"]], passes=1)
    assert high is not None and high > 0
    response = pend.client.post("/api/execute-node", headers=PERSON, json={
        **_execute_body(pend), "targetNodeId": ids["+i"], "confirmedPlaceholders": [ids["+i"]],
        "confirmedCost": high})
    assert response.status_code == 200, response.text


def test_a_shots_confirmed_cost_counts_one_shot_times_its_variations(pend):
    ids = _paid_chain(pend)
    cine = _cinema(pend, ids["+i"])
    nodes, edges = pend.graph.to_execute_format()
    graph_nodes = [pend.main.GraphNode.model_validate(node) for node in nodes]
    one_shot = [node.model_copy(update={"params": {**node.params, "scene": {
        **node.params["scene"], "shots": [node.params["scene"]["shots"][0]]}}}) if node.id == cine else node
        for node in graph_nodes]
    high = pend.main._run_estimate_high(one_shot, [pend.main.GraphEdge.model_validate(e) for e in edges],
                                        passes=2)
    under = _shot(pend, cine, confirmedPlaceholders=[ids["+i"]], confirmedCost=high * 0.99, variations=2)
    assert under.status_code == 409, under.text
    ok = _shot(pend, cine, confirmedPlaceholders=[ids["+i"]], confirmedCost=high, variations=2)
    assert ok.status_code == 200, ok.text


# -- finding 3: a proposal's run that a placeholder turned normal changed -----------------------

def _upscale_proposal(pend, paid: str) -> dict:
    body = {
        "note": "upscale-ish",
        "nodes": [{"ref": "+c", "definitionId": "nano-banana"}],
        "edges": [{"source": paid, "sourceHandle": "image", "target": "+c", "targetHandle": "images"}],
        "run": ["+c"],
    }
    proposal = pend.client.post("/api/canvas/proposals", headers=CLAUDE, json=body)
    assert proposal.status_code == 201, proposal.text
    return proposal.json()["proposal"]


def _accept(pend, proposal_id: str):
    return pend.client.post(f"/api/canvas/proposals/{proposal_id}/accept",
                            headers={**PERSON, KEY: _key(pend, proposal_id)}, json={})


def test_accept_refuses_a_run_a_placeholder_turned_normal_since_it_was_proposed(pend):
    ids = _paid_chain(pend, headers=CODEX)
    paid = ids["+i"]
    proposal = _upscale_proposal(pend, paid)
    assert paid not in [entry.get("nodeId") for entry in proposal["cost"]["nodes"]]
    ready = _apply(pend, {"note": "ready", "pending": False, "nodeIds": [ids["+p"], paid]}, CODEX)
    assert ready.status_code == 200, ready.text
    accepted = _accept(pend, proposal["id"])
    assert accepted.status_code == 409, accepted.text
    assert "what it runs changed after it was proposed" in accepted.json()["detail"]
    assert pend.ran == [] and pend.priced == []


def test_accept_refuses_when_the_idle_rule_turned_it_normal(pend):
    ids = _paid_chain(pend, headers=CODEX)
    proposal = _upscale_proposal(pend, ids["+i"])
    pend.main._clear_pending([ids["+p"], ids["+i"]])  # the 10-minute idle sweep
    accepted = _accept(pend, proposal["id"])
    assert accepted.status_code == 409, accepted.text
    assert "what it runs changed after it was proposed" in accepted.json()["detail"]


def test_the_approved_run_refuses_a_placeholder_turned_normal_after_accept(pend):
    ids = _paid_chain(pend, headers=CODEX)
    proposal = _upscale_proposal(pend, ids["+i"])
    accepted = _accept(pend, proposal["id"])
    assert accepted.status_code == 200, accepted.text
    made = accepted.json()
    # Codex can't change a run the person approved and the canvas hasn't started.
    refused = _apply(pend, {"note": "ready", "pending": False, "nodeIds": [ids["+i"]]}, CODEX)
    assert refused.status_code == 409, refused.text
    assert _owner(pend, ids["+i"])["id"] == CODEX_ID
    # The idle rule isn't an edit: the run itself sees the change and refuses.
    pend.main._clear_pending([ids["+p"], ids["+i"]])
    run = pend.client.post("/api/execute-node", headers=PERSON, json={
        **_execute_body(pend), "targetNodeId": made["idMap"]["+c"], "approvalId": made["approvalId"]})
    assert run.status_code == 409, run.text
    assert "changed since you accepted" in run.json()["detail"]
    assert pend.ran == [] and ids["+i"] not in _priced_ids(pend)


def test_the_approved_run_with_its_placeholders_unchanged_still_runs(pend):
    ids = _paid_chain(pend, headers=CODEX)
    proposal = _upscale_proposal(pend, ids["+i"])
    made = _accept(pend, proposal["id"]).json()
    run = pend.client.post("/api/execute-node", headers=PERSON, json={
        **_execute_body(pend), "targetNodeId": made["idMap"]["+c"], "approvalId": made["approvalId"]})
    assert run.status_code == 200, run.text
    assert ids["+i"] in run.json()["skipped"]


# -- finding 5: an agent's undo never re-pends a node the person changed since ------------------

@pytest.mark.parametrize("change", ["params", "label", "move", "connect"])
def test_an_agents_undo_leaves_a_node_the_person_changed_since(pend, change):
    ids = _chain(pend)
    node = ids["+a"]
    ready = _apply(pend, {"note": "ready", "pending": False, "nodeIds": [node]})
    token = ready.json()["undo"]["token"]
    if change == "params":
        edited = pend.client.put(f"/api/graph/node/{node}", headers=PERSON, json={"params": {"separator": " / "}})
    elif change == "label":
        edited = pend.client.put(f"/api/graph/node/{node}/label", headers=PERSON, json={"label": "Mine now"})
    elif change == "move":
        edited = pend.client.put("/api/graph/layout", headers=PERSON,
                                 json={"positions": {node: {"x": 900, "y": 900}}})
    else:
        other = pend.graph.add_node("text-input", {"value": "the person's"})
        edited = pend.client.post("/api/graph/connect", headers=PERSON, json={
            "source": other, "sourceHandle": "text", "target": node, "targetHandle": "text2"})
    assert edited.status_code == 200, edited.text
    undone = _undo(pend, token)
    assert undone.status_code == 200, undone.text
    assert _owner(pend, node) is None
    skipped = [item for item in undone.json().get("skipped") or [] if item.get("nodeId") == node]
    assert skipped and skipped[0]["reason"] == "changed since"


def test_an_agents_undo_still_re_pends_a_node_nobody_changed(pend):
    ids = _chain(pend)
    node = ids["+a"]
    ready = _apply(pend, {"note": "ready", "pending": False, "nodeIds": [node]})
    undone = _undo(pend, ready.json()["undo"]["token"])
    assert undone.status_code == 200, undone.text
    assert _owner(pend, node)["id"] == CLAUDE_ID


def test_the_undo_plan_compares_what_the_ready_entry_kept():
    flag = {"agent": {"id": CLAUDE_ID, "name": "Claude Code", "color": "#123456", "verified": False}, "at": 1}
    nodes = {"n1": {"id": "n1", "definitionId": "combine-text", "params": {"separator": ""}, "label": "A",
                    "position": {"x": 1, "y": 2}}}
    before =canvas_undo.capture_before({"n1": {**nodes["n1"], "pending": flag}}, [], removed=[], changed=[],
                                        renamed=[], moved=[], shown={}, ready=["n1"])
    inverse = canvas_undo.build_inverse(before, nodes, [], added=[])
    entry = inverse["ready"][0]
    assert entry["params"] == {"separator": ""} and entry["label"] == "A" and entry["position"] == {"x": 1.0, "y": 2.0}
    renamed = {"n1": {**nodes["n1"], "label": "B"}}
    plan = canvas_undo.plan_undo(inverse, renamed, [], cannot_remove=lambda *a: None,
                                 refused_change=lambda *a: None)
    assert not plan.restore["nodes"]
    assert plan.skipped[0]["reason"] == "changed since"


# -- GM round 4, items 4 and 6 -------------------------------------------------------------------

def test_the_refusal_says_gms_words_plural_and_several_agents(pend):
    ids = _paid_chain(pend)
    second = _apply(pend, {"note": "alt", "nodes": [{"ref": "+j", "definitionId": "nano-banana"}],
                           "edges": [{"source": ids["+p"], "sourceHandle": "text", "target": "+j",
                                      "targetHandle": "prompt"}],
                           "pending": True})
    assert second.status_code == 200, second.text
    combine = pend.graph.add_node("combine-text", {})
    pend.graph.connect(ids["+i"], "text", combine, "text1")
    pend.graph.connect(second.json()["idMap"]["+j"], "text", combine, "text2")
    response = _direct(pend, combine)
    assert response.status_code == 409, response.text
    assert response.json()["detail"]["message"] == (
        "Nothing ran. This run includes 2 paid nodes Claude Code is still setting up, and Nebula asks "
        "before running those. Click “Run” again to review them.")


def test_the_refusal_names_agents_when_they_are_several(pend):
    mine = _paid_chain(pend)
    theirs = _paid_chain(pend, headers=CODEX)
    combine = pend.graph.add_node("combine-text", {})
    pend.graph.connect(mine["+i"], "text", combine, "text1")
    pend.graph.connect(theirs["+i"], "text", combine, "text2")
    response = _direct(pend, combine)
    assert response.status_code == 409, response.text
    assert response.json()["detail"]["message"] == (
        "Nothing ran. This run includes 2 paid nodes agents are still setting up, and Nebula asks "
        "before running those. Click “Run” again to review them.")


def test_a_downstream_reason_names_the_placeholder_by_its_name_only():
    owner = {"id": "ext:codex", "name": "Codex", "color": "#F2C14E", "verified": False}
    nodes = {"n1": {"pending": {"agent": owner, "at": 0}}, "n2": {}}
    skips = pending_nodes.run_skips(["n1", "n2"], [("n1", "n2")], nodes, label=lambda node_id: "Hero prompt")
    assert skips["n2"]["reason"] == "needs “Hero prompt”, which Codex is still setting up."


def test_a_downstream_reason_falls_back_to_the_type_name_without_a_label(pend):
    ids = _chain(pend)
    pend.main._clear_pending([ids["+a"], ids["+b"]])  # only the prompt is a placeholder
    pend.graph.nodes[ids["+p"]].pop("label", None)
    response = pend.client.post("/api/execute", headers=PERSON, json=_execute_body(pend))
    assert response.status_code == 200, response.text
    assert response.json()["skipped"][ids["+a"]] == "needs “Text Input”, which Claude Code is still setting up."


def test_a_proposals_skip_reasons_use_the_type_name_without_a_label(pend):
    ids = _chain(pend, headers=CODEX)
    pend.main._clear_pending([ids["+a"], ids["+b"]])
    pend.graph.nodes[ids["+p"]].pop("label", None)
    candidate = pend.graph.clone()
    *_rest, skips = pend.main._proposal_run_scope(candidate, [ids["+b"]])
    assert skips[ids["+b"]]["reason"] == "needs “Text Input”, which Codex is still setting up."
