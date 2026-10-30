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
    assert note["proposal"] == {"id": cover, "kind": "project", "targetId": canvas.project_id, "cover": "image",
                                "since": int(book.get(cover).created_at * 1000)}


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


# -- PR #202 review 2 LOW-C: a reopen racing the close of the agent's other proposal ----------
#
# The agent has two cover proposals sharing one Update: P1 (invalidated by a
# node delete) and P2 (open, the Update reviews it). The agent withdraws P2
# while the person undoes the delete, which reopens P1. In either order the
# result is P1 open under an Update that reviews it, never an open proposal
# under an Update that says "Withdrawn".

def _two(canvas, monkeypatch):
    from tests.test_undo_restores_deletes import CLAUDE

    book, c, p1 = _cover_setup(canvas, monkeypatch)
    canvas.graph.add_node("nano-banana", {}, outputs={"image": {"type": "Image", "value": "/api/outputs/b.png"}})
    p2 = canvas.client.post("/api/asset-proposals", headers=CLAUDE, json={
        "kind": "project", "id": canvas.project_id, "change": {"cover": "/api/outputs/b.png"}, "note": "B"}).json()["proposal"]["id"]
    item = _whole(canvas, c)
    removal = _delete(canvas, c)["removal"]
    assert book.get(p1).status == "invalidated" and book.get(p2).status == "open"
    note = _proposal_note(canvas)
    assert note["proposal"]["id"] == p2 and not note.get("resolvedAt")
    return book, p1, p2, item, removal, CLAUDE


def _reviews_the_reopened_one(canvas, book, p1):
    note = _proposal_note(canvas)
    assert book.get(p1).status == "open"
    assert not note.get("resolvedAt") and not note.get("outcome")
    assert note["proposal"]["id"] == p1 and note["actions"][0]["op"]["proposalId"] == p1
    assert note["text"] == canvas.main.asset_update_text(book.get(p1))


def test_the_close_lands_first_then_the_reopen(canvas, monkeypatch):
    book, p1, p2, item, removal, claude = _two(canvas, monkeypatch)
    assert canvas.client.delete(f"/api/canvas/proposals/{p2}", headers=claude).status_code == 200
    assert _proposal_note(canvas).get("resolvedAt")
    assert _restore(canvas, [item], [removal]).json()["reopened"] == [p1]
    _reviews_the_reopened_one(canvas, book, p1)


def test_the_reopen_lands_while_the_close_is_being_written(canvas, monkeypatch):
    book, p1, p2, item, removal, claude = _two(canvas, monkeypatch)
    notes = canvas.main.agent_notes
    real = notes.resolve_proposal
    seen: dict = {}

    def slow_resolve(*args, **kwargs):
        # The withdraw's follow already found nothing waiting; the undo lands now.
        seen["reopened"] = _restore(canvas, [item], [removal]).json().get("reopened")
        return real(*args, **kwargs)

    monkeypatch.setattr(notes, "resolve_proposal", slow_resolve)
    assert canvas.client.delete(f"/api/canvas/proposals/{p2}", headers=claude).status_code == 200
    assert seen["reopened"] == [p1]
    _reviews_the_reopened_one(canvas, book, p1)


def test_the_store_resolves_only_the_proposal_it_still_reviews(canvas, monkeypatch):
    book, p1, p2, item, removal, claude = _two(canvas, monkeypatch)
    notes = canvas.main.agent_notes
    note = _proposal_note(canvas)
    # Another proposal's resolve leaves it; its own resolves it.
    assert notes.resolve_proposal(canvas.project_id, note["id"], outcome="Withdrawn", by={"kind": "system"},
                                  proposal_id=p1) is None
    assert not _proposal_note(canvas).get("resolvedAt")
    # A reopen leaves an Update whose proposal is still open.
    assert notes.reopen_proposal(canvas.project_id, note["id"], p1, None, None, lambda pid: False) is None
    assert _proposal_note(canvas)["proposal"]["id"] == p2
    assert notes.resolve_proposal(canvas.project_id, note["id"], outcome="Withdrawn", by={"kind": "system"},
                                  proposal_id=p2) is not None
    assert _proposal_note(canvas)["outcome"] == "Withdrawn"
