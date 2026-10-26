"""Placeholders, round 6 (review 5 of feat/agent-presence, GM - Design's
round-6 rulings of 2026-10-26).

Justin, Q133 b: a paid placeholder never runs without the person's
confirmation, and what runs never costs more than the person was shown.
Review 5, H1: an agent finishing its placeholders while the dialog was open
left nothing for Nebula to hold the run to (no placeholders left, so no
check), and a pricier model ran at a total nobody saw. A run that carries
``confirmedCost`` is now held to it whether or not a placeholder is left.
"""
from __future__ import annotations

import base64
import io

from services import agent_status, input_sizes
from tests.conftest import PERSON
from tests.test_canvas_proposals import CLAUDE, CODEX, KEY, _key, api  # noqa: F401 - fixture
from tests.test_pending_nodes import (  # noqa: F401 - fixture
    _apply, _execute_body, _owner, _paid_chain, pend,
)

GM_CHANGED_RUN = "Nothing ran. This run changed since you last reviewed it. Click “Run” again to review it."
GM_CHANGED_SHOT = "Nothing ran. This run changed since you last reviewed it. Generate again to review it."


def _run(pend, target: str, **extra):
    return pend.client.post("/api/execute-node", headers=PERSON,
                            json={**_execute_body(pend), "targetNodeId": target, **extra})


def _shot(pend, cine: str, **extra):
    nodes, edges = pend.graph.to_execute_format()
    return pend.client.post("/api/cinema/generate-shot", headers=PERSON,
                            json={"nodes": nodes, "edges": edges, "nodeId": cine, "shotId": "a", **extra})


def _cinema(pend, source: str) -> str:
    cine = pend.graph.add_node("cinema-scene", {"scene": {
        "version": 1, "base": {"model": "seedream-4-5"}, "aspectRatio": "16:9",
        "shots": [{"id": "a", "prompt": "a cat"}, {"id": "b", "prompt": "a dog"}]}})
    pend.graph.connect(source, "image", cine, "character_refs")
    return cine


def _with_keys(pend, monkeypatch, keys: dict[str, str]) -> None:
    main = pend.main
    real = main.load_settings
    monkeypatch.setattr(main, "load_settings", lambda *a, **k: {**real(*a, **k), "apiKeys": dict(keys)})


def _finished_chain(pend) -> dict[str, str]:
    """Claude Code's paid chain, which it then finishes (``pending: false``):
    no placeholder is left when the person's Run arrives."""
    ids = _paid_chain(pend)
    done = _apply(pend, {"note": "done", "pending": False, "nodeIds": [ids["+p"], ids["+i"]]})
    assert done.status_code == 200, done.text
    assert _owner(pend, ids["+i"]) is None
    return ids


def _estimate_high(pend, target: str) -> float:
    main = pend.main
    body = _execute_body(pend)
    nodes = [main.GraphNode.model_validate(n) for n in body["nodes"]]
    edges = [main.GraphEdge.model_validate(e) for e in body["edges"]]
    high = main._run_estimate_high(nodes, edges)
    assert high and high > 0
    return high


# -- H1: a confirmed total holds even when no placeholder is left ----------------------------------

def test_a_confirmed_total_below_nebulas_estimate_is_refused_with_no_placeholder_left(pend):
    ids = _finished_chain(pend)
    response = _run(pend, ids["+i"], confirmedPlaceholders=[], confirmedCost=0.000001)
    assert response.status_code == 409, response.text
    detail = response.json()["detail"]
    assert detail["code"] == "placeholder_confirm_required"
    assert detail["placeholders"] == []
    assert detail["estimate"]["high"] > 0.000001
    assert detail["message"] == GM_CHANGED_RUN
    assert pend.ran == []


def test_stale_confirmed_ids_dont_matter_once_no_placeholder_is_left(pend):
    """The person confirmed Claude Code's node; it finished it before the request arrived."""
    ids = _finished_chain(pend)
    high = _estimate_high(pend, ids["+i"])
    low = _run(pend, ids["+i"], confirmedPlaceholders=[ids["+i"]], confirmedCost=high / 10)
    assert low.status_code == 409, low.text
    ok = _run(pend, ids["+i"], confirmedPlaceholders=[ids["+i"]], confirmedCost=high)
    assert ok.status_code == 200, ok.text
    assert pend.ran


def test_a_confirmed_total_that_covers_the_run_runs(pend):
    ids = _finished_chain(pend)
    response = _run(pend, ids["+i"], confirmedPlaceholders=[], confirmedCost=_estimate_high(pend, ids["+i"]))
    assert response.status_code == 200, response.text
    assert pend.ran


def test_a_run_with_no_confirmation_and_no_placeholder_is_unchanged(pend):
    ids = _finished_chain(pend)
    response = _run(pend, ids["+i"])
    assert response.status_code == 200, response.text


def test_a_shot_is_held_to_its_confirmed_total_with_no_placeholder_left(pend):
    ids = _finished_chain(pend)
    cine = _cinema(pend, ids["+i"])
    refused = _shot(pend, cine, confirmedPlaceholders=[], confirmedCost=0.000001, variations=2)
    assert refused.status_code == 409, refused.text
    detail = refused.json()["detail"]
    assert detail["message"] == GM_CHANGED_SHOT
    assert detail["placeholders"] == []
    ok = _shot(pend, cine, confirmedPlaceholders=[], confirmedCost=detail["estimate"]["high"], variations=2)
    assert ok.status_code == 200, ok.text


def test_an_agents_run_is_never_held_to_a_confirmed_total(pend):
    ids = _finished_chain(pend)
    response = pend.client.post("/api/execute-node", headers=CLAUDE, json={
        **_execute_body(pend), "targetNodeId": ids["+i"], "confirmedPlaceholders": [], "confirmedCost": 0.000001})
    assert response.status_code != 409, response.text


# -- L4: the canvas's size and the confirmation's size are the same measuring ----------------------

def _png_data_uri(width: int, height: int) -> str:
    from PIL import Image
    buf = io.BytesIO()
    Image.new("1", (width, height)).save(buf, format="PNG")
    return "data:image/png;base64," + base64.b64encode(buf.getvalue()).decode()


def test_the_canvas_measures_an_inline_image_as_the_confirmation_does(pend):
    uri = _png_data_uri(640, 480)
    sizes = pend.client.post("/api/pricing/input-sizes", headers=PERSON,
                             json={"refs": [{"ref": uri, "kind": "Image"}]})
    assert sizes.status_code == 200, sizes.text
    assert sizes.json()["sizes"][uri] == input_sizes.measure(uri, "Image", inline=True)
    assert sizes.json()["sizes"][uri] is not None


# -- L5: a normal paid node with no list price beside a priced placeholder -------------------------

def test_a_normal_unpriced_node_counts_nothing_on_both_sides(pend, monkeypatch):
    """The dialog shows it as "price not listed" and the button just "Run";
    the listed prices are what the person confirmed, and Nebula holds the run
    to exactly those (review 5, L5: the same arithmetic as the canvas)."""
    _with_keys(pend, monkeypatch, {"FAL_KEY": "set", "GOOGLE_API_KEY": "set"})
    still = pend.graph.add_node("image-input", {"filePath": "https://example.com/huge.png"})
    upscale = pend.graph.add_node("seedvr2-upscale", {})
    pend.graph.connect(still, "image", upscale, "image")
    made = _apply(pend, {"note": "img", "pending": True, "nodes": [{"ref": "+i", "definitionId": "nano-banana"}],
                         "edges": [{"source": upscale, "sourceHandle": "image", "target": "+i",
                                    "targetHandle": "images"}]})
    assert made.status_code == 200, made.text
    paid = made.json()["idMap"]["+i"]
    estimate = _run(pend, paid, confirmedPlaceholders=[paid], confirmedCost=0).json()["detail"]["estimate"]
    assert upscale in estimate["unpriced"] and upscale not in estimate["nodes"]
    assert set(estimate["nodes"]) == {paid}
    ok = _run(pend, paid, confirmedPlaceholders=[paid], confirmedCost=estimate["high"])
    assert ok.status_code == 200, ok.text


# -- GM round 6, item 5: a status cut to its 140 characters says so ---------------------------------

def test_a_status_cut_at_140_characters_ends_with_an_ellipsis():
    long = "Writing the hero prompt for three crops at dusk, then the alternates for the lamp room, " \
           "the stairwell and the keeper's cottage, then checking every crop against the moodboard"
    cut = agent_status.clean_status_text(long)
    assert len(cut) <= agent_status.MAX_STATUS_CHARS
    assert cut.endswith("…")
    assert long.startswith(cut[:-1].rstrip())


def test_a_status_that_fits_is_kept_whole():
    fits = "x" * agent_status.MAX_STATUS_CHARS
    assert agent_status.clean_status_text(fits) == fits
    assert agent_status.clean_status_text("  Checking   the crop ") == "Checking the crop"
