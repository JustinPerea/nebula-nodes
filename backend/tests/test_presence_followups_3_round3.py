"""PR #204 round 3 (review 1 on ffd33872; GM 2026-10-30).

MEDIUM-1: one agent's open asks on one asset target share one Update, and
its ref named only the newest ask. A tab not connected as the person counts
from the Update, so it read "1 proposal" dated by the newest ask, and the
promote (which brings the real views) read "2 proposals" dated by the oldest:
the row moved. GM: nothing moves on the promote. The shared Update's ref now
says how many open asks it stands for (``asks``) and the oldest one's time
(``firstSince``), kept current as asks join and leave it: a new ask, one of
them closing (the follow's retarget), an undo reopening one.

NIT-1: the no-op retarget compares the words too. NIT-2: the ref bounds are
the backend's own constants, and the frontend's copies are pinned to them.
"""
from __future__ import annotations

import re
from pathlib import Path

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


def _proposal_notes(canvas) -> list[dict]:
    catalog = canvas.main.project_store.read()
    return [n for n in catalog["projects"][canvas.project_id].get("agentNotes") or [] if n.get("about") == "proposal"]


def _second_cover(canvas, url="/api/outputs/d.png"):
    node = canvas.graph.add_node("nano-banana", {}, outputs={"image": {"type": "Image", "value": url}})
    made = canvas.client.post("/api/asset-proposals", headers=CLAUDE, json={
        "kind": "project", "id": canvas.project_id, "change": {"cover": url}, "note": url})
    assert made.status_code == 201, made.text
    return node, made.json()["proposal"]["id"]


def _ms(book, pid) -> int:
    return int(book.get(pid).created_at * 1000)


def _two_asks(canvas, monkeypatch):
    book, c, p1 = _cover_setup(canvas, monkeypatch)
    d, p2 = _second_cover(canvas)
    # p1 asked first, p2 later (whatever the test clock does).
    book.get(p2).created_at = book.get(p1).created_at + 7
    return book, c, d, p1, p2


def test_two_asks_under_one_update_say_how_many_and_the_oldest_ones_time(canvas, monkeypatch):
    book, _c, p1 = _cover_setup(canvas, monkeypatch)
    (first,) = _proposal_notes(canvas)
    assert first["proposal"]["asks"] == 1 and first["proposal"]["firstSince"] == _ms(book, p1)
    _d, p2 = _second_cover(canvas)
    (note,) = _proposal_notes(canvas)  # the new ask's Update replaced the first: one per agent and target
    ref = note["proposal"]
    assert ref["id"] == p2 and ref["since"] == _ms(book, p2)
    assert ref["asks"] == 2 and ref["firstSince"] == min(_ms(book, p1), _ms(book, p2))
    assert book.get(p1).update == book.get(p2).update


def test_one_of_two_closing_leaves_the_update_saying_one(canvas, monkeypatch):
    book, _c, _d, p1, p2 = _two_asks(canvas, monkeypatch)
    # The older one goes: the Update stays on p2, now standing for one, from p2's time.
    assert canvas.client.delete(f"/api/canvas/proposals/{p1}", headers=CLAUDE).status_code == 200
    (note,) = _proposal_notes(canvas)
    assert not note.get("resolvedAt")
    assert note["proposal"]["id"] == p2 and note["proposal"]["asks"] == 1
    assert note["proposal"]["firstSince"] == _ms(book, p2)


def test_the_newer_closing_moves_the_update_to_the_older_with_its_count(canvas, monkeypatch):
    book, _c, _d, p1, p2 = _two_asks(canvas, monkeypatch)
    canvas.sent.clear()
    assert canvas.client.delete(f"/api/canvas/proposals/{p2}", headers=CLAUDE).status_code == 200
    (note,) = _proposal_notes(canvas)
    assert note["proposal"]["id"] == p1 and note["proposal"]["asks"] == 1
    assert note["proposal"]["firstSince"] == _ms(book, p1) == note["proposal"]["since"]
    sent = [m for m in canvas.sent if m.get("type") == "agentNotes" and note["id"] in (m.get("ids") or [])]
    assert [m.get("op") for m in sent] == ["changed"]
    assert sent[0]["note"]["proposal"]["asks"] == 1  # the held tab hears the new count


def test_an_undo_reopening_one_of_two_counts_it_again(canvas, monkeypatch):
    book, c, _d, p1, p2 = _two_asks(canvas, monkeypatch)
    item = _whole(canvas, c)
    removal = _delete(canvas, c)["removal"]  # p1 used c's image: it closes
    assert book.get(p1).status == "invalidated"
    (note,) = _proposal_notes(canvas)
    assert note["proposal"]["id"] == p2 and note["proposal"]["asks"] == 1
    canvas.sent.clear()
    assert _restore(canvas, [item], [removal]).json()["reopened"] == [p1]
    (again,) = _proposal_notes(canvas)
    assert not again.get("resolvedAt")
    assert again["proposal"]["asks"] == 2 and again["proposal"]["firstSince"] == _ms(book, p1)
    changed = [m for m in canvas.sent if m.get("type") == "agentNotes" and m.get("op") == "changed"
               and note["id"] in (m.get("ids") or [])]
    assert changed and changed[-1]["note"]["proposal"]["asks"] == 2


def test_an_undo_reopening_the_only_ask_says_one(canvas, monkeypatch):
    book, c, p1 = _cover_setup(canvas, monkeypatch)
    item = _whole(canvas, c)
    removal = _delete(canvas, c)["removal"]
    (closed,) = _proposal_notes(canvas)
    assert closed.get("resolvedAt")
    assert _restore(canvas, [item], [removal]).json()["reopened"] == [p1]
    (note,) = _proposal_notes(canvas)
    assert not note.get("resolvedAt") and note["proposal"]["asks"] == 1
    assert note["proposal"]["firstSince"] == _ms(book, p1)


def test_the_shared_fields_are_checked():
    from services.agent_notes import MAX_SHARED_ASKS, proposal_detail
    from services.canvas_proposals import MAX_OPEN_PER_AGENT

    assert MAX_SHARED_ASKS == MAX_OPEN_PER_AGENT
    assert proposal_detail({"asks": 2, "firstSince": 5}) == {"asks": 2, "firstSince": 5}
    assert proposal_detail({"asks": MAX_SHARED_ASKS}) == {"asks": MAX_SHARED_ASKS}
    for junk in ({"asks": 0}, {"asks": MAX_SHARED_ASKS + 1}, {"asks": True}, {"asks": 1.5}, {"asks": "2"},
                 {"firstSince": -1}, {"firstSince": 2**53}, {"firstSince": False}):
        assert proposal_detail(junk) == {}, junk


def test_a_retarget_keeps_no_stale_share_fields(canvas, monkeypatch):
    """A caller passing no share detail leaves none (never the closed asks' count)."""
    book, _c, _d, p1, p2 = _two_asks(canvas, monkeypatch)
    (note,) = _proposal_notes(canvas)
    result = canvas.main.agent_notes.retarget_proposal(canvas.project_id, note["id"], p1, {"cover": "image"})
    assert result is not None
    (after,) = _proposal_notes(canvas)
    assert "asks" not in after["proposal"] and "firstSince" not in after["proposal"]


# -- NIT-1: the no-op retarget compares the words too --------------------------

def test_a_retarget_with_new_words_on_the_same_ref_still_writes(canvas, monkeypatch):
    _book, _c, p1 = _cover_setup(canvas, monkeypatch)
    notes = canvas.main.agent_notes
    (note,) = _proposal_notes(canvas)
    detail = {k: v for k, v in note["proposal"].items() if k not in ("id", "kind", "targetId")}
    assert notes.retarget_proposal(canvas.project_id, note["id"], p1, detail, note["text"]) is None
    moved = notes.retarget_proposal(canvas.project_id, note["id"], p1, detail, "Claude asks something else")
    assert moved is not None and moved["note"]["text"] == "Claude asks something else"


# -- NIT-2: one constant each --------------------------------------------------

def test_the_ref_bounds_are_the_backends_own_constants_and_the_frontends_match():
    from services import agent_notes, agent_questions, canvas_proposals

    # A reference, not a copied number (small ints are shared, so `is` can't tell): the source says so.
    notes_source = Path(agent_notes.__file__).read_text()
    assert re.search(r"^MAX_REF_QUESTIONS = MAX_QUESTIONS$", notes_source, re.M)
    assert re.search(r"^MAX_SHARED_ASKS = MAX_OPEN_PER_AGENT$", notes_source, re.M)
    assert agent_notes.MAX_REF_QUESTIONS == agent_questions.MAX_QUESTIONS
    assert agent_notes.MAX_SHARED_ASKS == canvas_proposals.MAX_OPEN_PER_AGENT
    source = (Path(__file__).resolve().parents[2] / "frontend/src/lib/agentNotes.ts").read_text()

    def frontend(name: str) -> int:
        found = re.search(rf"export const {name} = (\d+);", source)
        assert found, f"frontend lib/agentNotes.ts has no {name}"
        return int(found.group(1))

    assert frontend("MAX_REF_QUESTIONS") == agent_questions.MAX_QUESTIONS
    assert frontend("MAX_SHARED_ASKS") == canvas_proposals.MAX_OPEN_PER_AGENT


def test_the_question_ref_count_bound_is_the_sets_own():
    from services.agent_notes import questions_detail
    from services.agent_questions import MAX_QUESTIONS

    assert questions_detail({"count": MAX_QUESTIONS}) == {"count": MAX_QUESTIONS}
    assert questions_detail({"count": MAX_QUESTIONS + 1}) == {}


def test_the_person_reads_the_shared_fields_as_agents_do(canvas, monkeypatch):
    """list_notes (the agents' read) carries the same ref the held tab counts from."""
    book, _c, _d, p1, p2 = _two_asks(canvas, monkeypatch)
    listed = canvas.client.get("/api/canvas/agent-notes", headers=PERSON).json()["notes"]
    (ref,) = [n["proposal"] for n in listed if n.get("about") == "proposal"]
    assert ref["asks"] == 2
