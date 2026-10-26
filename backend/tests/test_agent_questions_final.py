"""Question sets, final pass (Q125 item 1, same PR, 2026-10-24).

Two rules on the set's Update, the person's only way into an open set:

- GM - Design's copy: once the set closes, the line is past tense for every
  closed outcome ("{agent} asked a question." / "{agent} asked {n}
  questions."); while it is open it stays "{agent} has a question." / "{agent}
  has {n} questions.". It changes on the stored Update, so the person, an
  agent's list_notes and a restart all read the same words.
- The 200-Update cap never prunes an Update whose set is still open (it
  would silently forget the set); once the set closes, it is prunable again.
"""
from __future__ import annotations

import pytest

from services import agent_notes as notes_module
from services.agent_notes import MAX_PROJECT_NOTES, _prune
from services.agent_presence import AgentIdentity
from services.agent_questions import MAX_OPEN_PER_AGENT, closed_update_text
from tests.conftest import PERSON
from tests.test_agent_questions import GOOD_ANSWERS, TWO, _answer, _ask, _question_updates
from tests.test_agent_questions_persist import _notes_listing, _read, _stored, _sync, kept  # noqa: F401 - fixture
from tests.test_canvas_proposals import CLAUDE, CODEX, KEY, api  # noqa: F401 - api is a fixture

ONE = {"questions": [{"text": "Square or wide?", "options": ["Square", "Wide"]}]}
PICK_WIDE = {"answers": [{"questionId": "q1", "choices": ["Wide"]}]}


# -- past tense once closed (GM - Design) ------------------------------------------------

def test_closed_update_text_is_past_tense():
    assert closed_update_text("Claude Code has a question.") == "Claude Code asked a question."
    assert closed_update_text("Claude Code has 2 questions.") == "Claude Code asked 2 questions."
    # Only the template's own end changes, whatever the agent is called.
    assert closed_update_text("Has has 3 questions.") == "Has asked 3 questions."
    assert closed_update_text("Bob has Tools has a question.") == "Bob has Tools asked a question."
    # Anything else (already past tense, or not this template) is left as it is.
    assert closed_update_text("Claude Code asked 2 questions.") == "Claude Code asked 2 questions."
    assert closed_update_text("Something else.") == "Something else."


def _question_note(listing: list[dict]) -> dict:
    (note,) = [n for n in listing if n.get("about") == "question"]
    return note


def _close(api, set_id: str, outcome: str) -> None:
    key = _sync(api)[set_id]["answerKey"]
    if outcome == "answered":
        two = len(api.questions.get(set_id).spec.questions) == 2
        response = _answer(api, set_id, GOOD_ANSWERS if two else PICK_WIDE, key=key)
        assert response.status_code == 200, response.text
    elif outcome == "dismissed":
        response = api.client.post(f"/api/canvas/questions/{set_id}/dismiss", headers={**PERSON, KEY: key})
        assert response.status_code == 200, response.text
    else:
        assert api.client.delete(f"/api/canvas/questions/{set_id}", headers=CLAUDE).status_code == 200


@pytest.mark.parametrize("outcome, line", [
    ("answered", "Answered."), ("dismissed", "Dismissed."), ("withdrawn", "Withdrawn by Claude Code."),
])
@pytest.mark.parametrize("body, open_text, closed_text", [
    (TWO, "Claude Code has 2 questions.", "Claude Code asked 2 questions."),
    (ONE, "Claude Code has a question.", "Claude Code asked a question."),
])
def test_a_closed_sets_update_is_past_tense_for_the_person_and_agents(kept, outcome, line, body, open_text,
                                                                      closed_text):
    set_id = _ask(kept, body).json()["questions"]["id"]
    assert _question_note(_notes_listing(kept))["text"] == open_text
    assert _question_note(_notes_listing(kept, headers=CODEX))["text"] == open_text
    _close(kept, set_id, outcome)
    # The socket message the person's tabs get carries the new words.
    resolved = [m for m in kept.sent if m.get("type") == "agentNotes" and m.get("op") == "resolved"]
    assert resolved and resolved[-1]["note"]["text"] == closed_text
    for headers in (PERSON, CLAUDE, CODEX):  # the person, the asker and another agent (list_notes)
        note = _question_note(_notes_listing(kept, headers=headers))
        assert (note["text"], note["outcome"]) == (closed_text, line)
    # At the source: the stored Update, so a restart reads the same.
    (stored,) = _question_updates(kept)
    assert stored["text"] == closed_text
    kept.restart()
    assert _question_note(_notes_listing(kept, headers=CODEX))["text"] == closed_text


def test_an_open_set_still_says_has_after_a_restart(kept):
    _ask(kept)
    kept.restart()
    assert _question_note(_notes_listing(kept, headers=CODEX))["text"] == "Claude Code has 2 questions."


def test_a_set_loaded_from_the_record_and_closed_after_a_restart_is_past_tense(kept):
    set_id = _ask(kept).json()["questions"]["id"]
    kept.restart()
    _close(kept, set_id, "answered")
    assert _question_note(_notes_listing(kept, headers=CODEX))["text"] == "Claude Code asked 2 questions."


def test_the_restart_line_is_past_tense_too(kept):
    _ask(kept, ONE)
    store = kept.main.project_store
    with store.transaction() as catalog:
        catalog["projects"][kept.project_id]["agentQuestions"][0]["questions"] = "not a list"
        store.commit(catalog)
    kept.restart()
    note = _question_note(_notes_listing(kept, headers=CODEX))
    assert (note["text"], note["outcome"]) == ("Claude Code asked a question.", "Closed when Nebula restarted.")


def test_an_update_closed_before_this_change_reads_past_tense(kept):
    # A record written by the earlier build of this branch: resolved, but the
    # stored line still says "has". Every reader goes through note_view.
    set_id = _ask(kept).json()["questions"]["id"]
    _close(kept, set_id, "answered")
    store = kept.main.project_store
    with store.transaction() as catalog:
        for note in catalog["projects"][kept.project_id]["agentNotes"]:
            if note.get("about") == "question":
                note["text"] = "Claude Code has 2 questions."
        store.commit(catalog)
    for headers in (PERSON, CODEX):
        assert _question_note(_notes_listing(kept, headers=headers))["text"] == "Claude Code asked 2 questions."


# -- an open set's Update is never pruned ------------------------------------------------

def _note(note_id: str, at: str, *, read: bool) -> dict:
    return {"id": note_id, "at": at, **({"readAt": at} if read else {})}


def test_prune_skips_the_kept_ids_and_still_holds_the_cap():
    notes = [_note("q-open", "2026-01-01", read=True), _note("old", "2026-01-02", read=True),
             _note("new", "2026-01-03", read=False)]
    assert _prune(notes, 2, keep=frozenset({"q-open"})) == ["old"]
    assert [n["id"] for n in notes] == ["q-open", "new"]
    # Unread ones go before a kept one, too.
    notes.append(_note("newer", "2026-01-04", read=False))
    assert _prune(notes, 2, keep=frozenset({"q-open"})) == ["new"]
    # Backstop: if nothing but kept ones were left, the cap still holds.
    notes = [_note("a", "2026-01-01", read=True), _note("b", "2026-01-02", read=True)]
    assert _prune(notes, 1, keep=frozenset({"a", "b"})) == ["a"]


def _fill_with_read_updates(api, count: int) -> None:
    """Newer read Updates up to ``count`` on the list (as months of use leave it)."""
    store = api.main.project_store
    with store.transaction() as catalog:
        notes = catalog["projects"][api.project_id]["agentNotes"]
        for note in notes:
            note.setdefault("readAt", note["at"])
        template = {"author": {"kind": "agent", "id": "ext:codex", "name": "Codex", "color": "#33AAFF"},
                    "source": "agent", "about": "other", "text": "filler", "refs": []}
        for i in range(count - len(notes)):
            at = f"2999-01-01T00:{i // 60:02d}:{i % 60:02d}+00:00"
            notes.append({**template, "id": f"filler{i:04d}", "at": at, "readAt": at})
        store.commit(catalog)


def _post_one_more(api, path: str) -> list[str]:
    """One more Update on the full list through ``path``; returns the ids that left."""
    service = api.main.agent_notes
    author = {"kind": "agent", "id": "ext:codex", "name": "Codex", "color": "#33AAFF"}
    if path == "agent":
        identity = AgentIdentity(id="ext:codex", name="Codex", color="#33AAFF", verified=False)
        return service.canvas_post(identity, {"text": "one more"}, graph_nodes={})["removed"]
    if path == "nebula":
        return service.post_nebula(("canvas", None), author=author, about="other", text="one more")["removed"]
    if path == "proposal":
        return service.post_proposal(author=author, text="Codex proposes a change",
                                     proposal={"id": "pa_1", "kind": "canvas", "targetId": "canvas"})["removed"]
    response = _ask(api, ONE, headers=CODEX)
    assert response.status_code == 201, response.text
    return [m for m in api.sent if m.get("type") == "agentNotes" and m.get("op") == "added"][-1]["removed"]


@pytest.mark.parametrize("path", ["agent", "nebula", "proposal", "question"])
def test_an_open_sets_update_is_never_pruned(kept, monkeypatch, path):
    monkeypatch.setattr(notes_module, "RATE_LIMIT", 1000)
    set_id = _ask(kept).json()["questions"]["id"]
    (stored,) = _stored(kept)
    update_id = stored["update"]["id"]
    _fill_with_read_updates(kept, MAX_PROJECT_NOTES)
    removed = _post_one_more(kept, path)
    # The oldest read Update is the open set's: the next oldest went instead.
    assert removed == ["filler0000"]
    listing = kept.main.project_store.read()["projects"][kept.project_id]["agentNotes"]
    assert len(listing) == MAX_PROJECT_NOTES
    assert update_id in {n["id"] for n in listing}
    assert _read(kept, set_id).json()["questions"]["status"] == "open"
    kept.restart()
    assert _read(kept, set_id).json()["questions"]["status"] == "open"
    assert _answer(kept, set_id, GOOD_ANSWERS, key=_sync(kept)[set_id]["answerKey"]).status_code == 200


def test_once_closed_its_update_is_prunable_again(kept, monkeypatch):
    monkeypatch.setattr(notes_module, "RATE_LIMIT", 1000)
    set_id = _ask(kept).json()["questions"]["id"]
    update_id = _stored(kept)[0]["update"]["id"]
    _fill_with_read_updates(kept, MAX_PROJECT_NOTES)
    assert _answer(kept, set_id, GOOD_ANSWERS).status_code == 200
    assert _post_one_more(kept, "agent") == [update_id]
    # The closed set is kept for its 30 minutes either way: the asker still gets the answers.
    assert _read(kept, set_id).json()["questions"]["status"] == "answered"


def test_open_updates_kept_from_the_prune_are_bounded(kept, monkeypatch):
    # The bound: an ask goes to the open project, and the 12-in-all cap counts
    # every open set in live projects, so no project's list ever holds more
    # than 12 open sets' Updates; the other 188 are always prunable.
    from services.agent_questions import MAX_OPEN_TOTAL

    monkeypatch.setattr(notes_module, "RATE_LIMIT", 1000)
    for i in range(MAX_OPEN_TOTAL // MAX_OPEN_PER_AGENT):
        for _ in range(MAX_OPEN_PER_AGENT):
            assert _ask(kept, headers={"X-Nebula-Agent": f"Helper {i}"}).status_code == 201
    assert _ask(kept, headers={"X-Nebula-Agent": "Newcomer"}).status_code == 429
    update_ids = {s["update"]["id"] for s in _stored(kept)}
    assert len(update_ids) == MAX_OPEN_TOTAL
    _fill_with_read_updates(kept, MAX_PROJECT_NOTES)
    removed = _post_one_more(kept, "agent")
    assert removed and not set(removed) & update_ids
    listing = kept.main.project_store.read()["projects"][kept.project_id]["agentNotes"]
    assert len(listing) == MAX_PROJECT_NOTES and update_ids <= {n["id"] for n in listing}
