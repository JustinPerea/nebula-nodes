"""PR #204 round 4 (review 2 LOW-1 and NIT-2): a shared asset Update's ``asks`` and
``firstSince`` stay true when an ask closes while a new one is posting, and a refresh
after an undo reviews the newest open ask.

Each race is a fixed interleave: the close and its follow run inside the patched notes
call, on the loop, before that call goes on. No sleeps."""
from __future__ import annotations

import asyncio

from tests.test_presence_followups_3_round3 import _ms, _proposal_notes, _second_cover, _two_asks
from tests.test_undo_restores_deletes import (  # noqa: F401 - api and canvas are fixtures
    CLAUDE,
    _cover_setup,
    _delete,
    _restore,
    _whole,
    api,
    canvas,
)


def _record_loop(canvas, monkeypatch, seen: dict) -> None:
    main = canvas.main
    real = main._post_asset_update

    async def poster(proposal):
        seen.setdefault("loop", asyncio.get_running_loop())
        return await real(proposal)

    monkeypatch.setattr(main, "_post_asset_update", poster)


def _close_and_follow(canvas, seen: dict, pid: str) -> None:
    """On the notes worker thread: close ``pid`` and run its follow on the loop, to the end."""
    book = canvas.main.asset_proposals
    book.close(pid, "withdrawn", reason="withdrawn by the agent")
    asyncio.run_coroutine_threadsafe(canvas.main._follow_asset_updates([book.get(pid)]), seen["loop"]).result(timeout=20)


def test_an_ask_closed_before_the_new_one_is_written_isnt_counted(canvas, monkeypatch):
    """Review 2's probe: p1 closes (and its follow runs) while p2's Update is being posted,
    before the write. The Update counts only p2."""
    book, _c, p1 = _cover_setup(canvas, monkeypatch)
    notes = canvas.main.agent_notes
    real_post = notes.post_proposal
    seen: dict = {}
    _record_loop(canvas, monkeypatch, seen)

    def post(*args, **kwargs):
        if "closed" not in seen:
            seen["closed"] = True
            _close_and_follow(canvas, seen, p1)
        return real_post(*args, **kwargs)

    monkeypatch.setattr(notes, "post_proposal", post)
    canvas.sent.clear()
    _d, p2 = _second_cover(canvas)
    live = [n for n in _proposal_notes(canvas) if not n.get("resolvedAt")]
    assert [n["proposal"]["id"] for n in live] == [p2]
    assert (live[0]["proposal"]["asks"], live[0]["proposal"]["firstSince"]) == (1, _ms(book, p2))
    # Said right the first time: the tabs get "added" with one, never two then one (nothing moves).
    said = [(m.get("op"), m["note"]["proposal"].get("asks")) for m in canvas.sent
            if m.get("type") == "agentNotes" and (m.get("note") or {}).get("id") == live[0]["id"]]
    assert said == [("added", 1)], said


def test_an_ask_closed_after_the_write_but_before_it_joins_isnt_counted(canvas, monkeypatch):
    """p2's Update is written counting p1 and p2; p1 then closes before it joins p2's Update,
    so its follow lands on the Update p2's replaced. The post counts again and says one."""
    book, _c, p1 = _cover_setup(canvas, monkeypatch)
    notes = canvas.main.agent_notes
    real_post = notes.post_proposal
    seen: dict = {}
    _record_loop(canvas, monkeypatch, seen)

    def post(*args, **kwargs):
        result = real_post(*args, **kwargs)
        if "closed" not in seen:
            seen["closed"] = True
            seen["written"] = dict(result["note"]["proposal"])
            _close_and_follow(canvas, seen, p1)
        return result

    monkeypatch.setattr(notes, "post_proposal", post)
    canvas.sent.clear()
    _d, p2 = _second_cover(canvas)
    assert seen["written"]["asks"] == 2  # the interleave happened where it should
    live = [n for n in _proposal_notes(canvas) if not n.get("resolvedAt")]
    assert [n["proposal"]["id"] for n in live] == [p2]
    assert (live[0]["proposal"]["asks"], live[0]["proposal"]["firstSince"]) == (1, _ms(book, p2))
    changed = [m for m in canvas.sent if m.get("type") == "agentNotes" and m.get("op") == "changed"
               and live[0]["id"] in (m.get("ids") or [])]
    assert changed and changed[-1]["note"]["proposal"]["asks"] == 1


def test_a_new_ask_with_nothing_closing_writes_once(canvas, monkeypatch):
    """The recount after a post writes nothing when the count already holds: one "added",
    no "changed"."""
    book, _c, p1 = _cover_setup(canvas, monkeypatch)
    canvas.sent.clear()
    _d, p2 = _second_cover(canvas)
    (note,) = [n for n in _proposal_notes(canvas) if not n.get("resolvedAt")]
    assert note["proposal"]["asks"] == 2
    ops = [m.get("op") for m in canvas.sent if m.get("type") == "agentNotes" and note["id"] in (
        [*(m.get("ids") or []), (m.get("note") or {}).get("id")])]
    assert ops == ["added"], ops


def test_an_undo_reopening_the_newer_of_two_reviews_it_again(canvas, monkeypatch):
    """Review 2 NIT-2: the refresh after an undo reviews the newest open ask, not the oldest."""
    book, _c, d, p1, p2 = _two_asks(canvas, monkeypatch)
    item = _whole(canvas, d)
    removal = _delete(canvas, d)["removal"]  # p2 used d's image: it closes
    assert book.get(p2).status == "invalidated"
    (note,) = _proposal_notes(canvas)
    assert note["proposal"]["id"] == p1 and note["proposal"]["asks"] == 1
    assert _restore(canvas, [item], [removal]).json()["reopened"] == [p2]
    (again,) = _proposal_notes(canvas)
    assert not again.get("resolvedAt")
    assert again["proposal"]["id"] == p2
    assert (again["proposal"]["asks"], again["proposal"]["firstSince"]) == (2, _ms(book, p1))


def test_an_undo_reopening_the_only_ask_says_its_count_in_one_change(canvas, monkeypatch):
    """Review 2 NIT-2's reopen_no_share: the reopen writes the count itself, so the tabs get one
    "changed" that already says one, not an Update without it and then a second one."""
    book, c, p1 = _cover_setup(canvas, monkeypatch)
    item = _whole(canvas, c)
    removal = _delete(canvas, c)["removal"]
    (closed,) = _proposal_notes(canvas)
    canvas.sent.clear()
    assert _restore(canvas, [item], [removal]).json()["reopened"] == [p1]
    said = [m["note"]["proposal"].get("asks") for m in canvas.sent
            if m.get("type") == "agentNotes" and m.get("op") == "changed" and closed["id"] in (m.get("ids") or [])]
    assert said == [1], said


def test_an_ask_reopened_after_a_newer_one_replaced_its_update_joins_that_update(canvas, monkeypatch):
    """p1 closes (node deleted); the same agent asks again (p2), whose Update replaces p1's; the
    undo reopens p1. p1 joins p2's live Update, which now stands for both, so a held tab counts
    two as the connected one does; and p2 closing falls back to p1 instead of closing the Update."""
    book, c, p1 = _cover_setup(canvas, monkeypatch)
    item = _whole(canvas, c)
    removal = _delete(canvas, c)["removal"]
    assert book.get(p1).status == "invalidated"
    _d, p2 = _second_cover(canvas)
    book.get(p2).created_at = book.get(p1).created_at + 7
    assert _restore(canvas, [item], [removal]).json()["reopened"] == [p1]
    assert book.get(p1).update == book.get(p2).update
    (note,) = _proposal_notes(canvas)
    assert not note.get("resolvedAt") and note["proposal"]["id"] == p2
    assert (note["proposal"]["asks"], note["proposal"]["firstSince"]) == (2, _ms(book, p1))
    assert canvas.client.delete(f"/api/canvas/proposals/{p2}", headers=CLAUDE).status_code == 200
    (after,) = _proposal_notes(canvas)
    assert not after.get("resolvedAt") and after["proposal"]["id"] == p1 and after["proposal"]["asks"] == 1
