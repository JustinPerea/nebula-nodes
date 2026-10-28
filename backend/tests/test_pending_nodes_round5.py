"""Placeholders, round 5 (review 4 of feat/agent-presence, GM - Design's
round-5 rulings of 2026-10-25).

Justin, Q133 b: a paid placeholder never runs without the person's
confirmation, and what runs never costs more than the person was shown.
Review 4 found the backend's own estimate of the person's run left out a
price read from an input's size (H1), refused forever when the tab and the
server priced with different keys (M1), and let a confirmation without a
total through at any cost (M4); the comparison rounded differently from the
canvas (L1). The refusal now carries Nebula's own estimate, so the canvas
re-asks with it instead of a dead end.
"""
from __future__ import annotations

import copy

import pytest

from services import input_sizes, model_pricing
from tests.conftest import PERSON
from tests.test_canvas_proposals import CLAUDE, CODEX, KEY, _key, api  # noqa: F401 - fixture
from tests.test_pending_nodes import (  # noqa: F401 - fixture
    CLAUDE_ID, _apply, _chain, _execute_body, _owner, _paid_chain, _undo, pend,
)

UPSCALE_CLIP = {"width": 1920, "height": 1080, "seconds": 60.0, "frames": 1440}


def _cinema(pend, source: str) -> str:
    cine = pend.graph.add_node("cinema-scene", {"scene": {
        "version": 1, "base": {"model": "seedream-4-5"}, "aspectRatio": "16:9",
        "shots": [{"id": "a", "prompt": "a cat"}, {"id": "b", "prompt": "a dog"}]}})
    pend.graph.connect(source, "image", cine, "character_refs")
    return cine


def _shot(pend, cine: str, headers=PERSON, **extra):
    nodes, edges = pend.graph.to_execute_format()
    return pend.client.post("/api/cinema/generate-shot", headers=headers,
                            json={"nodes": nodes, "edges": edges, "nodeId": cine, "shotId": "a", **extra})


def _run(pend, target: str, **extra):
    return pend.client.post("/api/execute-node", headers=PERSON,
                            json={**_execute_body(pend), "targetNodeId": target, **extra})


def _with_keys(pend, monkeypatch, keys: dict[str, str]) -> None:
    main = pend.main
    real = main.load_settings
    monkeypatch.setattr(main, "load_settings", lambda *a, **k: {**real(*a, **k), "apiKeys": dict(keys)})


def _upscale_placeholder(pend, monkeypatch) -> str:
    """Video Input (a 1080p minute) -> Codex's FLUX Video Upscale placeholder."""
    _with_keys(pend, monkeypatch, {"BFL_API_KEY": "set"})
    monkeypatch.setattr(input_sizes, "measure", lambda ref, kind, inline=True: dict(UPSCALE_CLIP))
    clip = pend.graph.add_node("video-input", {"filePath": "/clips/long-1080p.mp4"})
    made = _apply(pend, {"note": "upscale", "pending": True,
                         "nodes": [{"ref": "+u", "definitionId": "flux-video-upscale"}],
                         "edges": [{"source": clip, "sourceHandle": "video", "target": "+u", "targetHandle": "video"}]},
                  CODEX)
    assert made.status_code == 200, made.text
    return made.json()["idMap"]["+u"]


# -- H1: a size-priced placeholder is priced at its measured input --------------------------------

def test_a_size_priced_placeholder_confirmed_at_zero_is_refused_with_its_measured_price(pend, monkeypatch):
    up = _upscale_placeholder(pend, monkeypatch)
    response = _run(pend, up, confirmedPlaceholders=[up], confirmedCost=0)
    assert response.status_code == 409, response.text
    detail = response.json()["detail"]
    assert detail["code"] == "placeholder_confirm_required"
    # The refusal says what Nebula prices it at, measured: a 2x 1080p minute is dollars, not $0.
    assert detail["estimate"]["high"] > 1
    assert detail["estimate"]["nodes"][up]["high"] == pytest.approx(detail["estimate"]["high"])
    assert pend.ran == [] and _owner(pend, up) is not None


def test_a_size_priced_placeholder_confirmed_at_its_measured_price_runs(pend, monkeypatch):
    up = _upscale_placeholder(pend, monkeypatch)
    estimate = _run(pend, up, confirmedPlaceholders=[up], confirmedCost=0).json()["detail"]["estimate"]
    response = _run(pend, up, confirmedPlaceholders=[up], confirmedCost=estimate["high"])
    assert response.status_code == 200, response.text
    assert _owner(pend, up) is None


def test_a_shot_over_a_size_priced_placeholder_is_priced_at_its_measured_input(pend, monkeypatch):
    """Image Input -> SeedVR2 (priced per megapixel of its input) placeholder -> the scene."""
    _with_keys(pend, monkeypatch, {"FAL_KEY": "set"})
    monkeypatch.setattr(input_sizes, "measure", lambda ref, kind, inline=True: {"width": 4096, "height": 4096})
    still = pend.graph.add_node("image-input", {"filePath": "/stills/big.png"})
    made = _apply(pend, {"note": "upscale", "pending": True,
                         "nodes": [{"ref": "+s", "definitionId": "seedvr2-upscale"}],
                         "edges": [{"source": still, "sourceHandle": "image", "target": "+s", "targetHandle": "image"}]})
    assert made.status_code == 200, made.text
    paid = made.json()["idMap"]["+s"]
    cine = _cinema(pend, paid)
    base = pend.main._run_estimate_high
    nodes, edges = pend.graph.to_execute_format()
    unmeasured = base([pend.main.GraphNode.model_validate(n) for n in nodes if n["id"] == cine],
                      [], passes=2) or 0
    refused = _shot(pend, cine, confirmedPlaceholders=[paid], confirmedCost=unmeasured, variations=2)
    assert refused.status_code == 409, refused.text
    estimate = refused.json()["detail"]["estimate"]
    assert estimate["nodes"][paid]["high"] > 0  # measured: the upscale is priced, twice
    ok = _shot(pend, cine, confirmedPlaceholders=[paid], confirmedCost=estimate["high"], variations=2)
    assert ok.status_code == 200, ok.text


# -- M1: the refusal carries Nebula's estimate, so a re-ask with it runs ---------------------------

def test_the_tab_and_the_server_pricing_with_different_keys_settles_in_one_re_ask(pend, monkeypatch):
    made = _apply(pend, {
        "note": "flux", "pending": True,
        "nodes": [{"ref": "+p", "definitionId": "text-input", "params": {"value": "x"}},
                  {"ref": "+f", "definitionId": "flux-2-pro"}],
        "edges": [{"source": "+p", "sourceHandle": "text", "target": "+f", "targetHandle": "prompt"}],
    })
    assert made.status_code == 200, made.text
    flux = made.json()["idMap"]["+f"]
    _with_keys(pend, monkeypatch, {"BFL_API_KEY": "set"})
    # The tab had no keys loaded, so it showed "price not listed" and confirmed $0.
    first = _run(pend, flux, confirmedPlaceholders=[flux], confirmedCost=0)
    assert first.status_code == 409, first.text
    estimate = first.json()["detail"]["estimate"]
    assert estimate["high"] > 0 and flux in estimate["nodes"]
    again = _run(pend, flux, confirmedPlaceholders=[flux], confirmedCost=estimate["high"])
    assert again.status_code == 200, again.text


def test_the_refusal_for_a_missing_confirmation_carries_the_estimate_too(pend):
    ids = _paid_chain(pend)
    response = _run(pend, ids["+i"])
    assert response.status_code == 409, response.text
    detail = response.json()["detail"]
    assert detail["placeholders"] == [ids["+i"]]
    assert detail["estimate"]["high"] > 0
    # Who each paid placeholder belongs to, for a tab that hasn't heard yet.
    assert detail["agents"][ids["+i"]]["id"] == CLAUDE_ID


# -- M4: confirmedCost is required with confirmedPlaceholders --------------------------------------

def test_confirmed_placeholders_without_a_cost_are_refused_when_nebula_can_price_the_run(pend):
    ids = _paid_chain(pend)
    response = _run(pend, ids["+i"], confirmedPlaceholders=[ids["+i"]])
    assert response.status_code == 409, response.text
    assert response.json()["detail"]["code"] == "placeholder_confirm_required"
    assert pend.ran == [] and _owner(pend, ids["+i"]) is not None


def test_a_shot_without_a_confirmed_cost_is_refused_too(pend):
    ids = _paid_chain(pend)
    cine = _cinema(pend, ids["+i"])
    response = _shot(pend, cine, confirmedPlaceholders=[ids["+i"]])
    assert response.status_code == 409, response.text


# -- L1: the same arithmetic as the canvas ----------------------------------------------------------

def test_a_tiny_price_times_variations_matches_the_canvas_total(pend, monkeypatch):
    table = copy.deepcopy(model_pricing.load_pricing())
    table["nodes"]["nano-banana"] = {"currency": "usd", "per": "image", "rows": [{"match": {}, "price": 0.00001256}]}
    monkeypatch.setattr(model_pricing, "load_pricing", lambda *a, **k: table)
    ids = _paid_chain(pend)
    cine = _cinema(pend, ids["+i"])
    refused = _shot(pend, cine, confirmedPlaceholders=[ids["+i"]], confirmedCost=0, variations=4)
    estimate = refused.json()["detail"]["estimate"]
    unrounded = sum(line["high"] for line in estimate["nodes"].values())
    # The canvas: the unrounded sum of one pass, times the variations, rounded to 6 places.
    response = _shot(pend, cine, confirmedPlaceholders=[ids["+i"]], confirmedCost=round(unrounded, 6), variations=4)
    assert response.status_code == 200, response.text


def test_the_estimate_multiplies_then_rounds(pend, monkeypatch):
    table = copy.deepcopy(model_pricing.load_pricing())
    table["nodes"]["nano-banana"] = {"currency": "usd", "per": "image", "rows": [{"match": {}, "price": 0.00001256}]}
    monkeypatch.setattr(model_pricing, "load_pricing", lambda *a, **k: table)
    ids = _paid_chain(pend)
    main = pend.main
    body = _execute_body(pend)
    nodes = [main.GraphNode.model_validate(n) for n in body["nodes"] if n["id"] in ids.values()]
    edges = [main.GraphEdge.model_validate(e) for e in body["edges"]]
    assert main._run_estimate_high(nodes, edges, passes=4) == pytest.approx(round(0.00001256 * 4, 6))


# -- L3 (GM, round 5): a shot's refusal ends with the shot panel's words ----------------------------

def test_a_shots_refusal_says_generate_again(pend):
    ids = _paid_chain(pend)
    cine = _cinema(pend, ids["+i"])
    detail = _shot(pend, cine).json()["detail"]
    assert detail["message"] == ("Nothing ran. This run includes 1 paid node Claude Code is still setting up, "
                                 "and Nebula asks before running those. Generate again to review it.")


def test_a_node_runs_refusal_keeps_click_run(pend):
    ids = _paid_chain(pend)
    detail = _run(pend, ids["+i"]).json()["detail"]
    assert detail["message"].endswith("Click “Run” again to review it.")


# -- M2: "runs nothing until Codex finishes N nodes" counts the placeholders ------------------------

def test_a_proposals_wait_count_is_the_placeholders_not_whats_downstream(pend):
    made = _apply(pend, {"note": "img", "pending": True, "nodes": [{"ref": "+i", "definitionId": "nano-banana"}]}, CODEX)
    assert made.status_code == 200, made.text
    paid = made.json()["idMap"]["+i"]
    body = {"note": "use it", "nodes": [{"ref": "+c", "definitionId": "nano-banana"}],
            "edges": [{"source": paid, "sourceHandle": "image", "target": "+c", "targetHandle": "images"}],
            "run": ["+c"]}
    proposal = pend.client.post("/api/canvas/proposals", headers=CLAUDE, json=body)
    assert proposal.status_code == 201, proposal.text
    skipped = proposal.json()["proposal"]["cost"]["pendingSkipped"]
    assert skipped["count"] == 2  # the skip line still counts what needs it
    assert skipped["placeholders"] == 1


# -- L4: a nudge too small to be a move doesn't block the agent's undo ------------------------------

def test_the_undo_ignores_a_nudge_that_is_not_a_move(pend):
    ids = _chain(pend)
    node = ids["+p"]
    placed = _apply(pend, {"note": "place", "move": {node: {"x": 100, "y": 100}}})
    assert placed.status_code == 200, placed.text
    ready = _apply(pend, {"note": "ready", "pending": False, "nodeIds": [node]})
    assert ready.status_code == 200, ready.text
    token = ready.json()["undo"]["token"]
    nudged = pend.client.put("/api/graph/layout", headers=PERSON, json={"positions": {node: {"x": 100.5, "y": 100}}})
    assert nudged.status_code == 200
    undone = _undo(pend, token)
    assert undone.status_code == 200, undone.text
    assert _owner(pend, node) is not None  # a placeholder again: a 0.5 px nudge isn't the person's edit


def test_the_undo_still_leaves_a_real_move(pend):
    ids = _chain(pend)
    node = ids["+p"]
    _apply(pend, {"note": "place", "move": {node: {"x": 100, "y": 100}}})
    ready = _apply(pend, {"note": "ready", "pending": False, "nodeIds": [node]})
    token = ready.json()["undo"]["token"]
    pend.client.put("/api/graph/layout", headers=PERSON, json={"positions": {node: {"x": 400, "y": 100}}})
    _undo(pend, token)
    assert _owner(pend, node) is None
