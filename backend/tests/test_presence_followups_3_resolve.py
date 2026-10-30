"""PR #202 review 5 (follow-up 3): LOW-1 and NIT-1.

LOW-1: an undo's reopen can land between a resolve's caller checking that
its proposal closed and the resolve's write. The reopen found the Update
not yet resolved and left it (it still reviewed that proposal), and then
the resolve wrote the outcome: an open ask under a resolved Update, with no
Review, and nothing to heal it (the settle skips resolved Updates). Now
``resolve_proposal`` asks ``_proposal_closed`` again inside its write, as
``reopen_proposal`` does, at every caller: the asset follow, the canvas
follow and the settle.

NIT-1: a move onto the proposal the Update already reviews (another follow
moved it there first) writes nothing and says nothing: no second "changed".
"""
from __future__ import annotations

import asyncio
import threading

from tests.conftest import PERSON
from tests.test_undo_restores_deletes import (  # noqa: F401 - api and canvas are fixtures
    CLAUDE,
    _cover_setup,
    _setup,
    api,
    canvas,
)


def _proposal_notes(canvas) -> list[dict]:
    catalog = canvas.main.project_store.read()
    return [n for n in catalog["projects"][canvas.project_id].get("agentNotes") or [] if n.get("about") == "proposal"]


def _on_a_loop(coro_fn):
    """Run ``coro_fn(loop)`` on a loop of its own thread, as the app's loop would."""
    loop = asyncio.new_event_loop()
    thread = threading.Thread(target=loop.run_forever, daemon=True)
    thread.start()
    try:
        return asyncio.run_coroutine_threadsafe(coro_fn(loop), loop).result(timeout=20)
    finally:
        loop.call_soon_threadsafe(loop.stop)
        thread.join(timeout=5)
        loop.close()


def _reopen_inside_the_resolve(canvas, monkeypatch, pid, reopen):
    """The undo's reopen of ``pid`` lands inside the first resolve of it,
    before that resolve's write."""
    notes = canvas.main.agent_notes
    real = notes.resolve_proposal
    seen: dict = {"calls": []}

    def resolve(*args, **kwargs):
        seen["calls"].append(kwargs.get("proposal_id"))
        if "reopened" not in seen and kwargs.get("proposal_id") == pid:
            seen["reopened"] = True
            reopen(seen["loop"])
        return real(*args, **kwargs)

    monkeypatch.setattr(notes, "resolve_proposal", resolve)
    return seen


def _asset_reopen(canvas, pid):
    main = canvas.main

    def reopen(loop):
        main.asset_proposals.reopen(pid)
        prop = main.asset_proposals.get(pid)
        asyncio.run_coroutine_threadsafe(main._reopen_update(prop.update, pid, main.asset_update_detail(prop),
                                                             main.asset_update_text(prop)), loop).result(timeout=20)
    return reopen


def _keeps_its_update(canvas, pid, status_of):
    (note,) = _proposal_notes(canvas)
    assert status_of(pid) == "open"
    assert not note.get("resolvedAt") and not note.get("outcome"), note.get("outcome")
    assert note["proposal"]["id"] == pid and note["actions"][0]["op"]["proposalId"] == pid
    # Nothing left for a list to heal: it stays so.
    assert canvas.client.get("/api/canvas/agent-notes", headers=PERSON).status_code == 200
    (again,) = _proposal_notes(canvas)
    assert not again.get("resolvedAt")


def test_an_asset_follows_resolve_leaves_an_update_its_ask_reopened_meanwhile(canvas, monkeypatch):
    book, _c, p1 = _cover_setup(canvas, monkeypatch)
    seen = _reopen_inside_the_resolve(canvas, monkeypatch, p1, _asset_reopen(canvas, p1))
    book.close(p1, "invalidated", reason="its node was deleted")

    async def follow(loop):
        seen["loop"] = loop
        await canvas.main._follow_asset_updates([book.get(p1)])

    _on_a_loop(follow)
    assert seen["reopened"]
    _keeps_its_update(canvas, p1, lambda pid: book.get(pid).status)


def test_the_settles_resolve_leaves_an_update_its_ask_reopened_meanwhile(canvas, monkeypatch):
    book, _c, p1 = _cover_setup(canvas, monkeypatch)
    book.close(p1, "invalidated", reason="its node was deleted")  # its follow never ran (a missed follow)
    seen = _reopen_inside_the_resolve(canvas, monkeypatch, p1, _asset_reopen(canvas, p1))

    async def settle(loop):
        seen["loop"] = loop
        await canvas.main._settle_proposal_updates()

    _on_a_loop(settle)
    assert seen["reopened"]
    _keeps_its_update(canvas, p1, lambda pid: book.get(pid).status)


def test_a_canvas_follows_resolve_leaves_an_update_its_proposal_reopened_meanwhile(canvas, monkeypatch):
    main = canvas.main
    _n1, _pin, proposal = _setup(canvas)
    (note,) = _proposal_notes(canvas)
    assert note["proposal"]["id"] == proposal

    def reopen(loop):
        canvas.book.reopen(proposal)
        asyncio.run_coroutine_threadsafe(main._reopen_update(canvas.book.get(proposal).update, proposal),
                                         loop).result(timeout=20)

    seen = _reopen_inside_the_resolve(canvas, monkeypatch, proposal, reopen)
    canvas.book.close(proposal, "invalidated", reason="its node was deleted")

    async def follow(loop):
        seen["loop"] = loop
        await main._follow_canvas_updates([canvas.book.get(proposal)])

    _on_a_loop(follow)
    assert seen["reopened"]
    _keeps_its_update(canvas, proposal, lambda pid: canvas.book.get(pid).status)


def test_the_store_resolves_only_a_proposal_still_closed(canvas, monkeypatch):
    _book, _c, p1 = _cover_setup(canvas, monkeypatch)
    notes = canvas.main.agent_notes
    (note,) = _proposal_notes(canvas)
    asked: list[str] = []

    def still_open(pid):
        asked.append(pid)
        return False

    assert notes.resolve_proposal(canvas.project_id, note["id"], outcome="Expired", by={"kind": "system"},
                                  proposal_id=p1, closed=still_open) is None
    assert asked == [p1] and not _proposal_notes(canvas)[0].get("resolvedAt")
    assert notes.resolve_proposal(canvas.project_id, note["id"], outcome="Expired", by={"kind": "system"},
                                  proposal_id=p1, closed=lambda pid: True) is not None
    assert _proposal_notes(canvas)[0]["outcome"] == "Expired"


# -- NIT-1 -------------------------------------------------------------------

def test_a_move_onto_the_proposal_the_update_already_reviews_says_nothing(canvas, monkeypatch):
    """Review 5's THREE-ONE: p3 withdrawn; while its follow moves the Update
    to p1, p2 is withdrawn and p2's follow moves it to p1 first. The outer
    move to p1 then finds it there: one "changed", not two."""
    book, _c, p1 = _cover_setup(canvas, monkeypatch)
    asks = []
    for url in ("/api/outputs/b.png", "/api/outputs/d.png"):
        canvas.graph.add_node("nano-banana", {}, outputs={"image": {"type": "Image", "value": url}})
        made = canvas.client.post("/api/asset-proposals", headers=CLAUDE, json={
            "kind": "project", "id": canvas.project_id, "change": {"cover": url}, "note": url})
        assert made.status_code == 201, made.text
        asks.append(made.json()["proposal"]["id"])
    p2, p3 = asks
    # p2 oldest, then p1, then p3: the outer move goes to p1 (the newest still
    # open), and so does p2's own follow.
    base = book.get(p1).created_at
    for i, pid in enumerate((p2, p1, p3)):
        book.get(pid).created_at = base + i
    main = canvas.main
    notes = main.agent_notes
    follow = main._follow_asset_updates
    real = notes.retarget_proposal
    seen: dict = {"moves": 0}

    async def recording_follow(proposals):
        seen.setdefault("loop", asyncio.get_running_loop())
        return await follow(proposals)

    def retarget(*args, **kwargs):
        seen["moves"] += 1
        if seen["moves"] == 1:  # the outer move: p2 is withdrawn and followed first
            book.close(p2, "withdrawn", reason="withdrawn by the agent")
            asyncio.run_coroutine_threadsafe(follow([book.get(p2)]), seen["loop"]).result(timeout=20)
        return real(*args, **kwargs)

    monkeypatch.setattr(main, "_follow_asset_updates", recording_follow)
    monkeypatch.setattr(notes, "retarget_proposal", retarget)
    (note,) = _proposal_notes(canvas)
    canvas.sent.clear()
    assert canvas.client.delete(f"/api/canvas/proposals/{p3}", headers=CLAUDE).status_code == 200
    (after,) = _proposal_notes(canvas)
    assert after["proposal"]["id"] == p1 and not after.get("resolvedAt") and book.get(p1).status == "open"
    ops = [m.get("op") for m in canvas.sent if m.get("type") == "agentNotes" and note["id"] in (m.get("ids") or [])]
    assert ops == ["changed"], ops


# -- GM 2026-10-29: refs a held tab counts and orders by -----------------------

def test_a_reopened_canvas_proposals_update_says_when_it_was_asked_again(canvas):
    from tests.test_undo_restores_deletes import _delete, _restore, _whole

    n1, _pin, proposal = _setup(canvas)
    (note,) = _proposal_notes(canvas)
    since = note["proposal"]["since"]
    assert since == int(canvas.book.get(proposal).created_at * 1000)
    item = _whole(canvas, n1)
    removal = _delete(canvas, n1)["removal"]
    assert _restore(canvas, [item], [removal]).json()["reopened"] == [proposal]
    (again,) = _proposal_notes(canvas)
    assert not again.get("resolvedAt") and again["proposal"]["since"] == since


def test_a_question_refs_count_and_since_are_checked():
    from services.agent_notes import questions_detail

    assert questions_detail({"id": "qs_1", "count": 2, "since": 5}) == {"count": 2, "since": 5}
    for junk in ({"count": 0}, {"count": 6}, {"count": True}, {"count": 1.5}, {"since": -1}, {"since": 2**53},
                 {"since": "5"}, {"other": 1}):
        assert questions_detail(junk) == {}, junk
    assert questions_detail(None) == {}
