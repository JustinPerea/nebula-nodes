"""PR #200 follow-up 2: a cover proposal that an undo reopens carries its
cover kind on its Update's ref again (see test_presence_followups_2.py)."""
from __future__ import annotations

from tests.test_undo_restores_deletes import (  # noqa: F401 - api and canvas are fixtures
    _cover_setup,
    _delete,
    _restore,
    _whole,
    api,
    canvas,
)


def _proposal_note(canvas) -> dict:
    catalog = canvas.main.project_store.read()
    (note,) = [n for n in catalog["projects"][canvas.project_id].get("agentNotes") or [] if n.get("about") == "proposal"]
    return note


def test_a_reopened_cover_proposals_update_says_image_again(canvas, monkeypatch):
    book, c, cover = _cover_setup(canvas, monkeypatch)
    assert _proposal_note(canvas)["proposal"]["cover"] == "image"
    item = _whole(canvas, c)
    removal = _delete(canvas, c)["removal"]
    assert book.get(cover).status == "invalidated"
    assert _proposal_note(canvas)["resolvedAt"]
    assert _restore(canvas, [item], [removal]).json()["reopened"] == [cover]
    note = _proposal_note(canvas)
    assert not note.get("resolvedAt")
    assert note["proposal"] == {"id": cover, "kind": "project", "targetId": canvas.project_id, "cover": "image"}


def test_a_reopened_proposals_update_says_its_words_again(canvas, monkeypatch):
    """PR #202 review 1 LOW-1: a reopen rewrites the Update's words from the
    reopened proposal (update_text), as a retarget does, so the words and the
    ref always come from the same proposal."""
    book, c, cover = _cover_setup(canvas, monkeypatch)
    item = _whole(canvas, c)
    removal = _delete(canvas, c)["removal"]
    # Words that went stale while it was closed: the reopen must put the proposal's back.
    with canvas.main.project_store.transaction() as catalog:
        for n in catalog["projects"][canvas.project_id].get("agentNotes") or []:
            if n.get("about") == "proposal":
                n["text"] = "stale words"
        canvas.main.project_store.commit(catalog)
    assert _proposal_note(canvas)["text"] == "stale words"
    assert _restore(canvas, [item], [removal]).json()["reopened"] == [cover]
    assert _proposal_note(canvas)["text"] == canvas.main.asset_update_text(book.get(cover))
