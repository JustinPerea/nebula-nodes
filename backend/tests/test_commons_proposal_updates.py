"""A Commons curation proposal posts an Update too (Justin's Q92 a, 2026-10-21).

The words follow the line above the Commons grid (CommonsProposalsLine:
"asks to change a reference"). No Commons text in it: not the proposed
value, not the reading as it is, not the agent's note or reason.
"""
from __future__ import annotations

import json

from tests.test_commons_proposals import CLAUDE, KEY, _opened, _propose, cx  # noqa: F401


def _proposal_notes(project_id: str) -> list[dict]:
    import main

    project = main.project_store.read()["projects"][project_id]
    return [note for note in project.get("agentNotes") or [] if note.get("about") == "proposal"]


def test_a_commons_proposal_posts_an_update_without_commons_text(cx, canvas_project):
    made = _propose(cx, {"correction": {"field_path": "summary", "op": "set", "value": "A quiet grid poster",
                                        "reason": "the type is small"}}, note="Reads quieter to me")
    assert made.status_code == 201, made.text
    view = made.json()["proposal"]
    (note,) = _proposal_notes(canvas_project)
    assert note["text"] == "Claude Code asks to change a reference in the Commons"
    assert note["actions"][0]["op"] == {"kind": "proposal.review", "proposalId": view["id"], "target": "commons",
                                        "targetId": cx.poster}
    text = json.dumps(note)
    for private in ("A quiet grid poster", "the type is small", "Reads quieter", "A loud poster"):
        assert private not in text

    accepted = cx.client.post(f"/api/asset-proposals/{view['id']}/accept",
                              headers={**cx.person, KEY: _opened(cx, view["id"])["acceptKey"]})
    assert accepted.status_code == 200, accepted.text
    (note,) = _proposal_notes(canvas_project)
    assert note["outcome"] == "Applied" and note["readAt"]


def test_several_edits_and_an_inbox_ask_use_the_lines_words(cx, canvas_project):
    _propose(cx, {"edits": [
        {"correction": {"field_path": "type_style.value", "value": "serif"}},
        {"correction": {"field_path": "axes.quiet_loud", "value": -0.4}},
    ]})
    _propose(cx, {"membership": {"id": cx.inbox_membership, "accept": True}}, target=cx.inbox)
    texts = sorted(note["text"] for note in _proposal_notes(canvas_project))
    assert texts == ["Claude Code asks to make 2 changes to a reference in the Commons",
                     "Claude Code asks to take a reference out of the inbox"]


def test_the_updates_ref_counts_the_edits_never_their_values(cx, canvas_project):
    """PR #200 follow-up 2 (review 20 NIT-3): the count a held tab's placeholder
    shows comes from the ref, not from the text an agent's name is part of."""
    _propose(cx, {"edits": [
        {"correction": {"field_path": "type_style.value", "value": "serif"}},
        {"correction": {"field_path": "axes.quiet_loud", "value": -0.4}},
        {"correction": {"field_path": "summary", "op": "set", "value": "A quiet grid poster"}},
    ]})
    (note,) = _proposal_notes(canvas_project)
    assert note["proposal"]["changes"] == 3 and "cover" not in note["proposal"]
    text = json.dumps(note["proposal"])
    for private in ("serif", "-0.4", "A quiet grid poster", "type_style"):
        assert private not in text


def test_an_inbox_ask_says_so_in_the_ref_and_nothing_else_does(cx, canvas_project):
    """GM, PR #202 r1: the held Commons line words an inbox ask as the promoted
    line does, from the ref (``inbox: true``), never from the Update's text."""
    _propose(cx, {"membership": {"id": cx.inbox_membership, "accept": True}}, target=cx.inbox)
    _propose(cx, {"correction": {"field_path": "summary", "op": "set", "value": "A quiet grid poster"}})
    refs = {note["proposal"]["targetId"]: note["proposal"] for note in _proposal_notes(canvas_project)}
    assert refs[cx.inbox]["changes"] == 1 and refs[cx.inbox]["inbox"] is True
    assert refs[cx.poster]["changes"] == 1 and "inbox" not in refs[cx.poster]


def test_a_fallback_to_the_older_ask_rewrites_the_words_with_the_count(cx, canvas_project):
    """PR #202 review 1 LOW-1 (GM's ruling on its Q1): when the agent's newer
    ask on a reference closes and its Update falls back to the older, open
    one, the Update's words change in place with its ref: both say the older
    ask, so the corner, a held tab's line and its placeholder agree."""
    older = _propose(cx, {"edits": [
        {"correction": {"field_path": "type_style.value", "value": "serif"}},
        {"correction": {"field_path": "axes.quiet_loud", "value": -0.4}},
        {"correction": {"field_path": "summary", "op": "set", "value": "A quiet grid poster"}},
    ]}).json()["proposal"]
    newer = _propose(cx, {"correction": {"field_path": "summary", "op": "set", "value": "A loud grid poster"}}).json()["proposal"]
    (note,) = _proposal_notes(canvas_project)
    assert note["text"] == "Claude Code asks to change a reference in the Commons"
    assert note["proposal"] == {"id": newer["id"], "kind": "commons", "targetId": cx.poster, "changes": 1}

    assert cx.client.delete(f"/api/canvas/proposals/{newer['id']}", headers=CLAUDE).status_code == 200
    (after,) = _proposal_notes(canvas_project)
    assert after["id"] == note["id"] and not after.get("resolvedAt")
    assert after["text"] == "Claude Code asks to make 3 changes to a reference in the Commons"
    assert after["proposal"] == {"id": older["id"], "kind": "commons", "targetId": cx.poster, "changes": 3}
    assert after["actions"][0]["op"]["proposalId"] == older["id"]
    # In place: still read as it was, no new Update.
    assert after.get("readAt") == note.get("readAt")
    assert "A quiet grid poster" not in json.dumps(after)


def test_a_fallback_to_an_inbox_ask_says_so_in_words_and_ref(cx, canvas_project):
    older = _propose(cx, {"membership": {"id": cx.inbox_membership, "accept": True}}, target=cx.inbox).json()["proposal"]
    newer = _propose(cx, {"edits": [
        {"correction": {"field_path": "type_style.value", "value": "serif"}},
        {"correction": {"field_path": "axes.quiet_loud", "value": -0.4}},
    ]}, target=cx.inbox).json()["proposal"]
    assert cx.client.delete(f"/api/canvas/proposals/{newer['id']}", headers=CLAUDE).status_code == 200
    (after,) = _proposal_notes(canvas_project)
    assert after["text"] == "Claude Code asks to take a reference out of the inbox"
    assert after["proposal"] == {"id": older["id"], "kind": "commons", "targetId": cx.inbox, "changes": 1, "inbox": True}
