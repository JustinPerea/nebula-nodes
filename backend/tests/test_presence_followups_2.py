"""PR #200 follow-up 2 (GM's ruling on review 20 GM-Q1, and review 20 NIT-3).

A tab that isn't connected as the person sees a new asset proposal only as
its Update, and shows a placeholder card built from it. The placeholder
says what the real card says ("proposes the automatic cover", "proposes 3
changes to this reference"), so the Update's structured ref carries the
kind of cover and the count of edits. Only those: never the image, the asset
or a field value (GM: "a held tab gets nothing more than today but a more
exact word"). The count is never read from the text, where an agent's name
could spoof it.
"""
from __future__ import annotations

import json

from services import agent_notes as agent_notes_module
from tests.test_asset_proposals import A, B, C, CLAUDE, _pin, _propose, api  # noqa: F401
from tests.test_asset_proposal_updates import _note_messages, _proposal_notes


def test_a_cover_to_an_image_says_image_and_never_which(api):
    _pin(api, A, api.person)
    view = _propose(api, {"cover": C}).json()["proposal"]
    (note,) = _proposal_notes(api)
    assert note["proposal"] == {"id": view["id"], "kind": "project", "targetId": api.dusk, "cover": "image"}
    # What every tab gets (the socket's "added"): no image, no asset path.
    added = _note_messages(api, "added")[-1]["note"]
    assert added["proposal"]["cover"] == "image"
    assert C not in json.dumps(added) and "c.png" not in json.dumps(added)


def test_a_cover_back_to_automatic_says_automatic(api):
    _pin(api, A, api.person)
    _propose(api, {"cover": None})
    (note,) = _proposal_notes(api)
    assert note["proposal"]["cover"] == "automatic"
    assert "changes" not in note["proposal"]
    # The text is as before: the kind is in the ref only.
    assert note["text"] == "Claude Code asks to change the cover of Dusk"


def test_closing_one_of_two_retargets_the_ref_with_the_other_ones_kind(api):
    _pin(api, A, api.person)
    first = _propose(api, {"cover": None}).json()["proposal"]
    second = _propose(api, {"cover": B}).json()["proposal"]
    (note,) = _proposal_notes(api)
    assert note["proposal"]["id"] == second["id"] and note["proposal"]["cover"] == "image"
    assert api.client.delete(f"/api/canvas/proposals/{second['id']}", headers=CLAUDE).status_code == 200
    (note,) = _proposal_notes(api)
    assert note["proposal"] == {"id": first["id"], "kind": "project", "targetId": api.dusk, "cover": "automatic"}
    changed = _note_messages(api, "changed")[-1]["note"]
    assert changed["proposal"]["cover"] == "automatic"


def test_a_moodboard_ask_carries_no_detail(api):
    from tests.test_asset_proposals import _board

    board = _board(api)
    _propose(api, {"sendNotes": True}, kind="moodboard", target=board["id"])
    (note,) = _proposal_notes(api)
    assert set(note["proposal"]) == {"id", "kind", "targetId"}


def test_post_proposal_keeps_only_a_checked_kind_and_count():
    clean = agent_notes_module.proposal_detail
    assert clean({"cover": "automatic"}) == {"cover": "automatic"}
    assert clean({"cover": "image", "changes": 3}) == {"cover": "image", "changes": 3}
    # Never a value, an image or anything else; a malformed one is dropped.
    assert clean({"cover": "/api/outputs/c.png"}) == {}
    assert clean({"cover": None, "changes": "3"}) == {}
    assert clean({"changes": True}) == {}
    assert clean({"changes": -1}) == {} and clean({"changes": 1000}) == {}
    assert clean({"url": C, "value": "A quiet grid poster", "changes": 2}) == {"changes": 2}
    assert clean(None) == {}


def test_a_retarget_without_detail_drops_the_closed_ones():
    ref = agent_notes_module._retargeted_ref({"id": "a", "kind": "project", "targetId": "p", "cover": "image"}, "b", None)
    assert ref == {"id": "b", "kind": "project", "targetId": "p"}
    ref = agent_notes_module._retargeted_ref({"id": "a", "kind": "commons", "targetId": "x", "changes": 4}, "b",
                                             {"changes": 1})
    assert ref == {"id": "b", "kind": "commons", "targetId": "x", "changes": 1}
