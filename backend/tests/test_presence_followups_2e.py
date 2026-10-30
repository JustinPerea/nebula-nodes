"""PR #202 review 3 (round 5): LOW-1.

LOW-1: a held tab orders a project's cover and a moodboard's placeholder
cards by when each ask was made (the Update ref's ``since``), as the promoted
cards order by the proposal's createdAt. Review 2's LOW-A gave Commons asks
``since``; covers and moodboards now get it too, so after the Update falls
back to an agent's older ask the cards keep their places on the promote.
LOW-2 is in test_presence_followups_2e_settle.py.
"""
from __future__ import annotations

from tests.test_asset_proposal_updates import _proposal_notes
from tests.test_asset_proposals import A, B, C, CLAUDE, CODEX, _board, _pin, _propose, api  # noqa: F401


def _by_author(api) -> dict[str, dict]:
    return {n["author"]["name"]: n for n in _proposal_notes(api) if not n.get("resolvedAt")}


# -- LOW-1 --------------------------------------------------------------------

def _fall_back(api, change_first, change_other, change_again, *, kind="project", target=None):
    """Review 3's R3-1: Codex asks, Claude Code asks, Codex asks again and
    withdraws that ask, so Codex's Update falls back to its first ask while
    keeping the later time."""
    first = _propose(api, change_first, kind=kind, target=target, headers=CODEX).json()["proposal"]
    api.clock.now += 1
    other = _propose(api, change_other, kind=kind, target=target).json()["proposal"]
    api.clock.now += 1
    again = _propose(api, change_again, kind=kind, target=target, headers=CODEX).json()["proposal"]
    assert _by_author(api)["Codex"]["proposal"]["id"] == again["id"]
    assert api.client.delete(f"/api/canvas/proposals/{again['id']}", headers=CODEX).status_code == 200
    return first, other


def _held_order(api) -> list[str]:
    """The held tab's order: oldest ``since`` first (heldProposalsFor)."""
    return [name for name, _ in sorted(_by_author(api).items(), key=lambda item: item[1]["proposal"]["since"])]


def test_a_cover_ask_says_when_it_was_asked_after_a_fallback(api):
    _pin(api, A, api.person)
    first, other = _fall_back(api, {"cover": B}, {"cover": C}, {"cover": C})
    notes = _by_author(api)
    assert notes["Codex"]["proposal"]["id"] == first["id"]
    assert notes["Codex"]["proposal"]["since"] == first["createdAt"]
    assert notes["Claude Code"]["proposal"]["since"] == other["createdAt"]
    # The promoted cards' order (createdAt) is the held one.
    assert _held_order(api) == ["Codex", "Claude Code"]


def test_a_moodboard_ask_says_when_it_was_asked_after_a_fallback(api):
    board = _board(api)
    first, other = _fall_back(api, {"sendNotes": True}, {"sendNotes": True}, {"sendNotes": True},
                              kind="moodboard", target=board["id"])
    notes = _by_author(api)
    assert notes["Codex"]["proposal"]["id"] == first["id"]
    assert notes["Codex"]["proposal"]["since"] == first["createdAt"]
    assert notes["Claude Code"]["proposal"]["since"] == other["createdAt"]
    assert _held_order(api) == ["Codex", "Claude Code"]
