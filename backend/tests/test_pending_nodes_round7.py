"""Placeholders, round 7 (review 6 of feat/agent-presence, GM - Design's
round-7 rulings of 2026-10-26).

Justin, Q133 b: what runs never costs more than the person was shown. Review 6,
L-e (GM's answer): the canvas shows the amount the person confirms in cents,
rounded up, and sends exactly that; Nebula lets no run exceed it, so no slack
above the confirmed total. GM round 7, polish: a status cut to 140 characters
is cut at a word.
"""
from __future__ import annotations

from services import agent_status
from tests.conftest import PERSON
from tests.test_canvas_proposals import CLAUDE, CODEX, KEY, _key, api  # noqa: F401 - fixture
from tests.test_pending_nodes import (  # noqa: F401 - fixture
    _apply, _execute_body, _owner, _paid_chain, pend,
)
from tests.test_pending_nodes_round6 import _estimate_high, _finished_chain, _run


# -- L-e: no slack above what the person confirmed ---------------------------------------------------

def test_a_confirmed_total_a_millionth_below_nebulas_estimate_is_refused(pend):
    ids = _finished_chain(pend)
    high = _estimate_high(pend, ids["+i"])
    response = _run(pend, ids["+i"], confirmedPlaceholders=[], confirmedCost=high - 0.0000005)
    assert response.status_code == 409, response.text
    assert response.json()["detail"]["code"] == "placeholder_confirm_required"
    assert pend.ran == []


def test_a_confirmed_total_in_cents_rounded_up_runs(pend):
    """What the canvas sends: the shown amount, rounded up to the cent."""
    import math
    ids = _finished_chain(pend)
    high = _estimate_high(pend, ids["+i"])
    shown = math.ceil(round(high * 1e6) / 1e4) / 100
    assert shown >= high
    response = _run(pend, ids["+i"], confirmedPlaceholders=[], confirmedCost=shown)
    assert response.status_code == 200, response.text
    assert pend.ran


def test_with_a_placeholder_left_the_confirmed_total_has_no_slack_either(pend):
    ids = _paid_chain(pend)
    target = ids["+i"]
    paid = [ids["+i"]]  # +p is free text
    probe = _run(pend, target, confirmedPlaceholders=paid, confirmedCost=0)
    assert probe.status_code == 409, probe.text
    high = probe.json()["detail"]["estimate"]["high"]
    assert high and high > 0
    refused = _run(pend, target, confirmedPlaceholders=paid, confirmedCost=high - 0.0000005)
    assert refused.status_code == 409, refused.text
    ok = _run(pend, target, confirmedPlaceholders=paid, confirmedCost=high)
    assert ok.status_code == 200, ok.text


# -- GM round 7, polish: the status cut lands on a word ----------------------------------------------

LONG = ("Writing the hero prompt for three crops at dusk, then the alternates for the lamp room, "
        "the stairwell and the keeper's cottage, then checking every crop against the moodboard")


def test_a_cut_status_ends_at_the_last_word_before_the_cap():
    cut = agent_status.clean_status_text(LONG)
    assert len(cut) <= agent_status.MAX_STATUS_CHARS
    assert cut.endswith("then…"), cut
    assert not cut.endswith("checki…")
    assert LONG.startswith(cut[:-1])


def test_a_word_ending_exactly_at_the_cap_is_kept():
    words = ("word " * 40).strip()  # 199 characters, a word ends every 5
    cap = agent_status.MAX_STATUS_CHARS
    cut = agent_status.clean_status_text(words)
    assert cut.endswith("word…")
    assert len(cut) <= cap
    # The longest whole-word prefix that fits with its "…".
    assert len(cut) == max(i for i in range(0, cap) if words[:i].endswith("word") and i + 1 <= cap) + 1


def test_a_status_with_no_space_is_cut_hard():
    cut = agent_status.clean_status_text("x" * 300)
    assert cut == "x" * (agent_status.MAX_STATUS_CHARS - 1) + "…"


def test_a_status_set_over_http_is_cut_at_a_word(pend):
    response = pend.client.post("/api/canvas/status", headers=CLAUDE, json={"text": LONG})
    assert response.status_code == 200, response.text
    assert response.json()["status"]["text"].endswith("then…"), response.text
