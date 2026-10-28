"""Placeholders and statuses, round 8 (review 7 of feat/agent-presence, with
the coordinator's decisions and GM - Design's round-8 rulings of 2026-10-26).

Justin, Q133 b: what runs never costs more than the person was shown.
- L4: an amount above zero never confirms as nothing. The canvas shows and
  sends at least $0.01 for it (lib/placeholderRunConfirm.ts roundUpToCent);
  Nebula's estimate, read at 6 places, never rounds a positive run to 0, so
  a confirmed 0 can't pass a run that costs something.
- L5 (coordinator's decision): a status over 140 characters is cut at its
  last space only when that keeps at least 100 characters; otherwise it is
  cut hard, and a hard cut never splits a character (a combining mark, a
  ZWJ sequence, a variation selector, a skin-tone modifier or a flag's
  regional-indicator pair stays whole). A cursor's `say` is cut the same
  safe way (it has no "…").
"""
from __future__ import annotations

from services import agent_presence, agent_status
from tests.conftest import PERSON  # noqa: F401
from tests.test_canvas_proposals import CLAUDE, CODEX, KEY, _key, api  # noqa: F401 - fixture
from tests.test_pending_nodes import (  # noqa: F401 - fixture
    _apply, _execute_body, _owner, _paid_chain, pend,
)
from tests.test_pending_nodes_round6 import _finished_chain, _run

CAP = agent_status.MAX_STATUS_CHARS


# -- L4: an amount above zero never confirms as nothing ------------------------------------------------

def _tiny_prices(pend, monkeypatch, total: float = 4e-7) -> None:
    """Every priced line of the run shares `total` (USD): under half a millionth."""
    pricing = pend.main.model_pricing
    real = pricing.estimate_run

    def tiny(*args, **kwargs):
        estimate = dict(real(*args, **kwargs))
        priced = estimate.get("priced") or {}
        if priced:
            share = total / len(priced)
            estimate["priced"] = {node_id: {**line, "low": share, "high": share} for node_id, line in priced.items()}
        return estimate

    monkeypatch.setattr(pricing, "estimate_run", tiny)


def test_a_run_under_half_a_millionth_is_not_priced_as_nothing(pend, monkeypatch):
    ids = _finished_chain(pend)
    _tiny_prices(pend, monkeypatch)
    main = pend.main
    body = _execute_body(pend)
    nodes = [main.GraphNode.model_validate(n) for n in body["nodes"]]
    edges = [main.GraphEdge.model_validate(e) for e in body["edges"]]
    estimate = main._run_estimate(nodes, edges)
    assert estimate is not None and estimate["high"] is not None
    assert estimate["high"] > 0, estimate
    assert estimate["low"] > 0, estimate
    assert ids


def test_a_confirmed_zero_does_not_pass_a_run_that_costs_something(pend, monkeypatch):
    ids = _finished_chain(pend)
    _tiny_prices(pend, monkeypatch)
    refused = _run(pend, ids["+i"], confirmedPlaceholders=[], confirmedCost=0)
    assert refused.status_code == 409, refused.text
    assert refused.json()["detail"]["estimate"]["high"] > 0
    assert pend.ran == []


def test_the_cent_the_canvas_shows_for_it_runs(pend, monkeypatch):
    ids = _finished_chain(pend)
    _tiny_prices(pend, monkeypatch)
    response = _run(pend, ids["+i"], confirmedPlaceholders=[], confirmedCost=0.01)
    assert response.status_code == 200, response.text
    assert pend.ran


# -- L5: the word cut keeps at least 100 characters; a hard cut never splits a character -------------

URL = "Reading https://example.com/" + "p" * 200


def test_a_long_url_after_a_short_word_is_cut_hard_not_to_one_word():
    cut = agent_status.clean_status_text(URL)
    assert cut == URL[:CAP - 1] + "…", cut
    assert len(cut) == CAP


def test_the_word_cut_holds_when_it_keeps_at_least_100_characters():
    text = "a" * 100 + " " + "b" * 100
    assert agent_status.clean_status_text(text) == "a" * 100 + "…"
    text = "a" * 110 + " " + "b" * 50
    assert agent_status.clean_status_text(text) == "a" * 110 + "…"


def test_a_word_cut_that_keeps_99_characters_is_a_hard_cut_instead():
    text = "a" * 99 + " " + "b" * 100
    assert agent_status.clean_status_text(text) == text[:CAP - 1] + "…"


def _whole(cut: str, unit: str) -> None:
    """The kept text (before the "…") is a whole number of `unit`s."""
    assert cut.endswith("…"), cut
    kept = cut[:-1]
    assert kept, cut
    assert len(kept) % len(unit) == 0, (len(kept), len(unit))
    assert kept == unit * (len(kept) // len(unit))
    assert len(cut) <= CAP


def test_a_hard_cut_never_splits_a_combining_mark():
    _whole(agent_status.clean_status_text("é" * 100), "é")


def test_a_hard_cut_never_splits_a_zwj_sequence():
    family = "\U0001F468‍\U0001F469‍\U0001F467"  # 5 code points
    _whole(agent_status.clean_status_text(family * 40), family)


def test_a_hard_cut_never_splits_a_flag():
    _whole(agent_status.clean_status_text("\U0001F1FA\U0001F1F8" * 100), "\U0001F1FA\U0001F1F8")


def test_a_hard_cut_never_splits_a_variation_selector():
    _whole(agent_status.clean_status_text("✔️" * 100), "✔️")


def test_a_hard_cut_never_splits_a_skin_tone():
    _whole(agent_status.clean_status_text("\U0001F44D\U0001F3FD" * 100), "\U0001F44D\U0001F3FD")


def test_a_flag_run_after_an_odd_one_out_keeps_its_pairs():
    """Pairs count from the start of the run: one lone indicator first."""
    text = "x" + "\U0001F1FA\U0001F1F8" * 100
    cut = agent_status.clean_status_text(text)
    kept = cut[:-1]
    assert kept.startswith("x")
    assert (len(kept) - 1) % 2 == 0, len(kept)


def test_a_long_status_over_http_keeps_the_url(pend):
    response = pend.client.post("/api/canvas/status", headers=CLAUDE, json={"text": URL})
    assert response.status_code == 200, response.text
    assert response.json()["status"]["text"] == URL[:CAP - 1] + "…"


def test_a_cursor_say_is_cut_without_splitting_a_character():
    say = agent_presence._clean_say("x" + "é" * 100)
    assert len(say) <= agent_presence.MAX_SAY_CHARS
    assert not say.endswith("e"), say[-3:]
    assert say == "x" + "é" * ((len(say) - 1) // 2)
