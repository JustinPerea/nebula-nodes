"""PR #202 review 3 (round 5) LOW-2: the Update settle
(``_settle_proposal_updates``, on every list, tab connect and project switch)
never leaves an open proposal under an Update that says "Withdrawn by …". It
leaves a closed proposal's Update to the close handling while the same
agent's other ask still shares it, and it resolves only the proposal the
Update still reviews (an undo's reopen may have taken it over meanwhile).
"""
from __future__ import annotations

from tests.conftest import PERSON
from tests.test_undo_restores_deletes import (  # noqa: F401 - api and canvas are fixtures
    CLAUDE,
    _cover_setup,
    _delete,
    _restore,
    _whole,
    api,
    canvas,
)


# -- LOW-2 --------------------------------------------------------------------
#
# Claude Code has two cover asks on one project sharing one Update. Never, in
# either race, an open proposal under an Update that says "Withdrawn by …".

def _note(canvas) -> dict:
    catalog = canvas.main.project_store.read()
    (note,) = [n for n in catalog["projects"][canvas.project_id].get("agentNotes") or [] if n.get("about") == "proposal"]
    return note


def _second_cover(canvas) -> str:
    canvas.graph.add_node("nano-banana", {}, outputs={"image": {"type": "Image", "value": "/api/outputs/b.png"}})
    return canvas.client.post("/api/asset-proposals", headers=CLAUDE, json={
        "kind": "project", "id": canvas.project_id, "change": {"cover": "/api/outputs/b.png"}, "note": "B"}).json()["proposal"]["id"]


def _reviews(canvas, book, pid):
    note = _note(canvas)
    assert book.get(pid).status == "open"
    assert not note.get("resolvedAt") and not note.get("outcome"), note.get("outcome")
    assert note["proposal"]["id"] == pid and note["actions"][0]["op"]["proposalId"] == pid


def test_a_tab_connecting_mid_withdraw_leaves_the_other_open_ask_its_update(canvas, monkeypatch):
    """R3 race 1: P1 and P2 open, P2 withdrawn, and a list of the Updates (a
    tab connecting) lands between the close and the follow's retarget."""
    book, _c, p1 = _cover_setup(canvas, monkeypatch)
    p2 = _second_cover(canvas)
    assert _note(canvas)["proposal"]["id"] == p2 and book.get(p1).status == "open"
    notes = canvas.main.agent_notes
    real = notes.retarget_proposal
    seen: dict = {}

    def slow_retarget(*args, **kwargs):
        seen["list"] = canvas.client.get("/api/canvas/agent-notes", headers=PERSON).status_code
        return real(*args, **kwargs)

    monkeypatch.setattr(notes, "retarget_proposal", slow_retarget)
    assert canvas.client.delete(f"/api/canvas/proposals/{p2}", headers=CLAUDE).status_code == 200
    assert seen["list"] == 200
    _reviews(canvas, book, p1)


def test_an_undos_reopen_inside_the_settles_resolve_keeps_its_update(canvas, monkeypatch):
    """R3 race 2: P1 invalidated by a delete, P2 open under the Update. P2 is
    withdrawn; a settle runs before the follow resolves, and the undo's
    reopen of P1 lands inside the settle's own resolve."""
    book, c, p1 = _cover_setup(canvas, monkeypatch)
    p2 = _second_cover(canvas)
    item = _whole(canvas, c)
    removal = _delete(canvas, c)["removal"]
    assert book.get(p1).status == "invalidated" and _note(canvas)["proposal"]["id"] == p2
    notes = canvas.main.agent_notes
    real = notes.resolve_proposal
    seen: dict = {"calls": 0}

    def wrapped(*args, **kwargs):
        seen["calls"] += 1
        if seen["calls"] == 1:  # the follow's resolve: a tab lists the Updates first
            seen["list"] = canvas.client.get("/api/canvas/agent-notes", headers=PERSON).status_code
        elif seen["calls"] == 2:  # the settle's resolve: the undo lands first
            seen["reopened"] = _restore(canvas, [item], [removal]).json().get("reopened")
        return real(*args, **kwargs)

    monkeypatch.setattr(notes, "resolve_proposal", wrapped)
    assert canvas.client.delete(f"/api/canvas/proposals/{p2}", headers=CLAUDE).status_code == 200
    assert seen["list"] == 200 and seen["reopened"] == [p1]
    _reviews(canvas, book, p1)


def test_the_settle_still_closes_an_update_nothing_open_shares(canvas, monkeypatch):
    """The guard is narrow: a closed ask with no other open ask under its
    Update is still resolved by the settle (a missed follow, a restart)."""
    book, _c, p1 = _cover_setup(canvas, monkeypatch)
    follow = canvas.main._follow_asset_updates

    async def no_follow(proposals):
        return None

    monkeypatch.setattr(canvas.main, "_follow_asset_updates", no_follow)
    assert canvas.client.delete(f"/api/canvas/proposals/{p1}", headers=CLAUDE).status_code == 200
    assert not _note(canvas).get("resolvedAt")
    monkeypatch.setattr(canvas.main, "_follow_asset_updates", follow)
    assert canvas.client.get("/api/canvas/agent-notes", headers=PERSON).status_code == 200
    assert _note(canvas)["outcome"] == "Withdrawn by Claude Code"
