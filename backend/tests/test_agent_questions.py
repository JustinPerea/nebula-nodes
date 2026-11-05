"""Agents ask the person questions and wait for the answers (Q125 item 1).

Justin, 2026-10-24: "Yes, all four, in that order", then "go with your
suggestions". Item 1 of four: an agent asks 1-5 questions, the person
answers (or dismisses them) from the question set's Update, and the agent
reads the answers with get_answers. Modelled on proposals
(services/canvas_proposals.py): the same memory-only book with open caps and
closed sets kept a while, the same two-layer person gate (no agent marker
plus this launch's person token, then a per-set key that only the person's
browser sockets get), and the same Update that settles when the set closes.

These tests pin the store, the routes and every person-gate refusal. The
agent surfaces (MCP, CLI, docs, tool lists) are in
test_agent_questions_agents.py.
"""
from __future__ import annotations

import asyncio
import json
import time

import httpx
import pytest

from services.agent_notes import AgentNotes
from services.agent_presence import AgentIdentity
from services.agent_questions import (
    CAP_LINE,
    CLOSED_KEEP_SECONDS,
    MAX_CLOSED,
    MAX_OPEN_PER_AGENT,
    MAX_OPEN_TOTAL,
    MAX_QUESTIONS,
    QuestionBook,
    QuestionError,
    parse_answers,
    parse_questions,
    update_outcome,
    update_text,
)
from tests.conftest import FORGED_ORIGIN, PERSON, PERSON_HELLO, asgi_get
from tests.test_canvas_proposals import CLAUDE, CODEX, KEY, Clock, api  # noqa: F401 - api is a fixture

ME = AgentIdentity(id="ext:claude-code", name="Claude Code", color="#3FC1A5", verified=False)
OTHER = AgentIdentity(id="ext:codex", name="Codex", color="#F2C14E", verified=False)
# The person's own words: never in a log, the journal or another agent's read.
SECRET_ANSWER = "Use the blue one, my client hates orange"

TWO = {
    "note": "Picking the hero crop",
    "questions": [
        {"text": "Which crop for the hero?", "options": ["Square", "Wide", "Tall"]},
        {"text": "Anything to avoid?"},
    ],
}


@pytest.fixture
def asked(api, monkeypatch):
    """The canvas app with its own question book and Updates service."""
    # Kept on the project store, as main's is (test_agent_questions_persist.py).
    book = QuestionBook(api.clock, store=lambda: api.main.project_store)
    monkeypatch.setattr(api.main, "agent_questions", book)
    monkeypatch.setattr(api.main, "agent_notes", AgentNotes(lambda: api.main.project_store))
    api.questions = book
    return api


def _ask(api, body=None, headers=CLAUDE):
    return api.client.post("/api/canvas/questions", headers=headers, json=body if body is not None else TWO)


def _key(api, set_id: str) -> str:
    """The answer key, read the way the canvas reads it: from a browser-only message."""
    for message in api.browser:
        if message.get("type") == "questionsOpened" and message["set"]["id"] == set_id:
            return message["answerKey"]
    raise AssertionError("no questionsOpened message for the browser")


def _notes(api) -> list[dict]:
    return list(api.main.project_store.read()["projects"][api.project_id].get("agentNotes") or [])


def _question_updates(api) -> list[dict]:
    return [note for note in _notes(api) if note.get("about") == "question"]


def _answer(api, set_id, body, headers=None, key=None):
    headers = {**PERSON, **(headers or {})}
    if key is not False:
        headers[KEY] = key or _key(api, set_id)
    return api.client.post(f"/api/canvas/questions/{set_id}/answer", headers=headers, json=body)


GOOD_ANSWERS = {"answers": [{"questionId": "q1", "choices": ["Wide"]},
                            {"questionId": "q2", "text": SECRET_ANSWER}]}


# -- the request ------------------------------------------------------------------

def test_parse_questions_shapes_and_defaults():
    spec = parse_questions({
        "note": "  why\n I ask ",
        "questions": [
            {"text": "  Which\ncrop?​ ", "options": [" Square ", "Wide"]},
            {"text": "Anything else?", "multiple": False},
            {"text": "Pick moods", "options": ["Calm", "Loud", "Odd"], "multiple": True, "allowText": False},
        ],
        "nodeIds": ["n1", "n2"],
    })
    assert spec.note == "why I ask"
    assert [q.id for q in spec.questions] == ["q1", "q2", "q3"]
    first, second, third = spec.questions
    assert first.text == "Which crop?" and first.options == ("Square", "Wide")
    assert first.multiple is False and first.allow_text is True
    assert second.options == () and second.allow_text is True
    assert third.multiple is True and third.allow_text is False
    assert spec.node_ids == ("n1", "n2")


@pytest.mark.parametrize("body, words", [
    ({"questions": []}, "1 to 5 questions"),
    ({"questions": [{"text": f"q{i}?"} for i in range(MAX_QUESTIONS + 1)]}, "1 to 5 questions"),
    ({}, "1 to 5 questions"),
    ({"questions": [{"text": "x" * 201}]}, "200 characters"),
    ({"questions": [{"text": "   "}]}, "can't be empty"),
    ({"questions": [{"text": "Pick", "options": ["Only one"]}]}, "2 to 6 options"),
    ({"questions": [{"text": "Pick", "options": [str(i) for i in range(7)]}]}, "2 to 6 options"),
    ({"questions": [{"text": "Pick", "options": ["Wide", "wide "]}]}, "different"),
    ({"questions": [{"text": "Pick", "options": ["a", "b" * 81]}]}, "80 characters"),
    ({"questions": [{"text": "Say", "allowText": False}]}, "must allow a typed answer"),
    ({"questions": [{"text": "Say", "multiple": True}]}, "multiple needs options"),
    ({"questions": [{"text": "Pick", "options": ["a", "b"], "multiple": "yes"}]}, "true or false"),
    ({"questions": [{"text": "Say", "allowText": 1}]}, "true or false"),
    ({"questions": [{"text": "Say"}], "note": "n" * 161}, "160 characters"),
    ({"questions": [{"text": "Say"}], "why": "x"}, "unknown field 'why'"),
    ({"questions": [{"text": "Say", "choices": ["a", "b"]}]}, "questions[0] has unknown field 'choices'"),
    ({"questions": ["Say"]}, "questions[0] must be an object"),
    ({"questions": [{"text": "Say"}], "nodeIds": "n1"}, "nodeIds must be a list"),
    ({"questions": [{"text": "Say"}], "nodeIds": [f"n{i}" for i in range(13)]}, "at most 12"),
])
def test_parse_questions_refuses_in_one_line(body, words):
    with pytest.raises(QuestionError) as caught:
        parse_questions(body)
    assert caught.value.status == 422
    assert words in caught.value.detail


def _spec():
    return parse_questions({"questions": [
        {"text": "Crop?", "options": ["Square", "Wide", "Tall"]},
        {"text": "Moods?", "options": ["Calm", "Loud"], "multiple": True},
        {"text": "Anything else?"},
        {"text": "Pick one only", "options": ["A", "B"], "allowText": False},
    ]})


def test_parse_answers_takes_choices_text_and_blanks():
    answers = parse_answers(_spec(), {"answers": [
        {"questionId": "q1", "choices": ["Wide"]},
        {"questionId": "q2", "choices": ["Loud", "Calm", "Loud"], "text": "  and odd\n\nreally \u0007"},
        {"questionId": "q3", "text": "   "},
    ]})
    assert answers == [
        {"questionId": "q1", "answered": True, "choices": ["Wide"], "text": None},
        # Picked in the question's own order, once each; the text keeps its line breaks, plain.
        {"questionId": "q2", "answered": True, "choices": ["Calm", "Loud"], "text": "and odd\n\nreally"},
        {"questionId": "q3", "answered": False, "choices": [], "text": None},
        # A question the person left out entirely is blank too.
        {"questionId": "q4", "answered": False, "choices": [], "text": None},
    ]


@pytest.mark.parametrize("body, words", [
    ({"answers": []}, "Answer at least one question, or dismiss them"),
    ({"answers": [{"questionId": "q3", "text": " "}]}, "Answer at least one question, or dismiss them"),
    ({"answers": [{"questionId": "q1", "choices": ["Square", "Wide"]}]}, "takes one choice"),
    ({"answers": [{"questionId": "q1", "choices": ["Round"]}]}, "isn't one of its options"),
    ({"answers": [{"questionId": "q4", "text": "C"}]}, "takes no typed answer"),
    ({"answers": [{"questionId": "q3", "choices": ["x"]}]}, "has no options"),
    ({"answers": [{"questionId": "q9", "text": "x"}]}, "no question q9"),
    ({"answers": [{"questionId": "q3", "text": "a"}, {"questionId": "q3", "text": "b"}]}, "twice"),
    ({"answers": [{"questionId": "q3", "text": "x" * 1001}]}, "1000 characters"),
    ({"answers": "q1"}, "answers must be a list"),
    ({"answers": [{"questionId": "q3", "text": "x", "extra": 1}]}, "unknown field 'extra'"),
])
def test_parse_answers_refuses_in_one_line(body, words):
    with pytest.raises(QuestionError) as caught:
        parse_answers(_spec(), body)
    assert caught.value.status == 422
    assert words in caught.value.detail


def test_a_refused_answer_never_repeats_the_persons_text():
    long = SECRET_ANSWER + " " + "x" * 1000
    with pytest.raises(QuestionError) as caught:
        parse_answers(_spec(), {"answers": [{"questionId": "q3", "text": long}]})
    assert "client hates orange" not in caught.value.detail


# -- the book ---------------------------------------------------------------------

def test_open_caps_per_agent_and_in_total_say_what_is_open():
    clock = Clock()
    book = QuestionBook(clock)
    spec = parse_questions({"questions": [{"text": "Crop?"}]})
    mine = [book.create(agent=ME, project_id="p", spec=spec) for _ in range(MAX_OPEN_PER_AGENT)]
    with pytest.raises(QuestionError) as caught:
        book.create(agent=ME, project_id="p", spec=spec)
    assert caught.value.status == 429
    assert caught.value.detail == CAP_LINE == (
        "You already have 3 open question sets. Wait for answers or withdraw one.")
    assert [row["id"] for row in caught.value.still_open] == [s.id for s in mine]
    assert caught.value.still_open[0]["questions"] == ["Crop?"]
    # Forward (items 2 and 3): per agent, its open sets.
    assert [s.id for s in book.open_for_agent(ME.id)] == [s.id for s in mine]
    assert book.open_for_agent(OTHER.id) == []

    others = [AgentIdentity(id=f"ext:a{i}", name=f"A{i}", color="#3FC1A5", verified=False) for i in range(4)]
    for agent in others:
        for _ in range(MAX_OPEN_PER_AGENT if len(book.open_list()) + 3 <= MAX_OPEN_TOTAL else 0):
            book.create(agent=agent, project_id="p", spec=spec)
    assert len(book.open_list()) == MAX_OPEN_TOTAL
    with pytest.raises(QuestionError) as total:
        book.create(agent=OTHER, project_id="p", spec=spec)
    assert total.value.status == 429 and "waiting for the person" in total.value.detail


def test_closed_sets_are_kept_a_while_then_pruned():
    clock = Clock()
    book = QuestionBook(clock)
    spec = parse_questions({"questions": [{"text": "Crop?"}]})
    first = book.create(agent=ME, project_id="p", spec=spec)
    book.close(first.id, "dismissed")
    assert book.get(first.id).status == "dismissed"
    clock.now += CLOSED_KEEP_SECONDS + 1
    book.create(agent=ME, project_id="p", spec=spec)  # any write prunes
    assert book.get(first.id) is None
    for _ in range(MAX_CLOSED + 5):
        made = book.create(agent=ME, project_id="p", spec=spec)
        book.close(made.id, "withdrawn")
    assert len([s for s in book._items.values() if not s.is_open]) == MAX_CLOSED  # noqa: SLF001


def test_a_set_closes_once():
    book = QuestionBook(Clock())
    made = book.create(agent=ME, project_id="p", spec=parse_questions({"questions": [{"text": "Crop?"}]}))
    book.close(made.id, "withdrawn")
    with pytest.raises(QuestionError) as caught:
        book.close(made.id, "dismissed")
    assert caught.value.status == 409
    with pytest.raises(ValueError):
        book.close(made.id, "expired")


def test_update_words_follow_gm_copy():
    book = QuestionBook(Clock())
    one = book.create(agent=ME, project_id="p", spec=parse_questions({"questions": [{"text": "Crop?"}]}))
    two = book.create(agent=ME, project_id="p", spec=parse_questions(TWO))
    assert update_text(one) == "Claude Code has a question."
    assert update_text(two) == "Claude Code has 2 questions."
    for status, line in (("answered", "Answered."), ("dismissed", "Dismissed."),
                         ("withdrawn", "Withdrawn by Claude Code.")):
        made = book.create(agent=OTHER if status == "withdrawn" else ME, project_id="p",
                           spec=parse_questions({"questions": [{"text": "Crop?"}]}))
        made.agent = ME
        book.close(made.id, status)
        assert update_outcome(made) == line


def test_the_view_never_carries_the_answer_key():
    book = QuestionBook(Clock())
    made = book.create(agent=ME, project_id="p", spec=parse_questions(TWO))
    view = book.view(made)
    assert made.answer_key not in json.dumps(view)
    assert view["questions"][0] == {"id": "q1", "text": "Which crop for the hero?",
                                    "options": ["Square", "Wide", "Tall"], "multiple": False, "allowText": True}
    assert view["status"] == "open" and view["answers"] is None and view["note"] == "Picking the hero crop"
    assert "answer_key" not in repr(made)


# -- asking over HTTP ------------------------------------------------------------------

def test_asking_posts_one_update_with_answer_and_sends_the_key_to_the_browser_only(asked):
    n1 = asked.graph.add_node("text-input", {"value": "a cat"})
    response = _ask(asked, {**TWO, "nodeIds": [n1, "n99"]})
    assert response.status_code == 201, response.text
    body = response.json()
    view = body["questions"]
    assert view["status"] == "open" and view["id"].startswith("qs_")
    assert view["nodeIds"] == [n1] and body["dropped"] == ["n99"]
    (note,) = _question_updates(asked)
    assert note["text"] == "Claude Code has 2 questions."
    assert note["source"] == "nebula" and note["author"]["name"] == "Claude Code"
    assert note["refs"] == [n1]
    assert note["actions"] == [{"label": "Answer", "op": {"kind": "question.answer", "questionId": view["id"]}}]
    # GM 2026-10-29 (the held needs-you count): how many it asks, as its line says, and when.
    assert note["questions"] == {"id": view["id"], "count": 2, "since": view["createdAt"]}
    assert view["update"] == {"id": note["id"], "projectId": asked.project_id}
    # Template words only: the questions and the note are the form's, not the Update's.
    assert "crop" not in json.dumps(note).lower()

    key = _key(asked, view["id"])
    assert key not in json.dumps(body)
    assert key not in json.dumps(asked.sent)
    events = asked.journal.read(after=0, limit=100)["events"]
    (event,) = [e for e in events if e["kind"] == "question.asked"]
    assert event["data"] == {"questionId": view["id"], "agentId": "ext:claude-code", "count": 2}
    assert "crop" not in json.dumps(event).lower()


def test_one_question_says_a_question(asked):
    _ask(asked, {"questions": [{"text": "Square or wide?", "options": ["Square", "Wide"]}]}, headers=CODEX)
    (note,) = _question_updates(asked)
    assert note["text"] == "Codex has a question."


def test_only_a_named_agent_asks(asked):
    assert _ask(asked, headers=PERSON).status_code == 403
    assert _ask(asked, headers={}).status_code == 400
    assert _ask(asked, {"questions": []}).status_code == 422


def test_no_project_open_refuses_and_keeps_nothing(asked):
    with asked.main.project_store.transaction() as catalog:
        catalog["activeProjectId"] = None
        asked.main.project_store.commit(catalog)
    response = _ask(asked)
    assert response.status_code == 409
    assert "project" in response.json()["detail"]
    assert asked.questions.open_list() == []


def test_the_cap_refusal_lists_the_open_sets_and_the_withdraw_call(asked):
    ids = [_ask(asked).json()["questions"]["id"] for _ in range(MAX_OPEN_PER_AGENT)]
    response = _ask(asked)
    assert response.status_code == 429
    body = response.json()
    assert body["detail"] == CAP_LINE
    assert [row["id"] for row in body["stillOpen"]] == ids
    assert body["stillOpen"][0]["withdrawWith"] == f"DELETE /api/canvas/questions/{ids[0]}"
    assert body["stillOpen"][0]["questions"] == ["Which crop for the hero?", "Anything to avoid?"]
    # Another agent may still ask.
    assert _ask(asked, headers=CODEX).status_code == 201


# -- the person gate -----------------------------------------------------------------

def test_only_the_person_answers_or_dismisses(asked):
    set_id = _ask(asked).json()["questions"]["id"]
    key = _key(asked, set_id)
    for route in ("answer", "dismiss"):
        url = f"/api/canvas/questions/{set_id}/{route}"
        # An agent marker is refused even with the person token and the key.
        for marker in (CLAUDE, CODEX, {"X-Nebula-Client": "cli"}):
            refused = asked.client.post(url, headers={**PERSON, **marker, KEY: key}, json=GOOD_ANSWERS)
            assert refused.status_code == 403, (route, marker)
            assert refused.json()["code"] == "agent_refused"
        # A made-up agent token is turned away before the route (401).
        refused = asked.client.post(url, headers={**PERSON, "Authorization": "Agent not-a-token", KEY: key},
                                    json=GOOD_ANSWERS)
        assert refused.status_code in (401, 403)
        # No person token (a forged Origin, a tab without the launch link).
        refused = asked.client.post(url, headers={**FORGED_ORIGIN, KEY: key}, json=GOOD_ANSWERS)
        assert refused.status_code == 403 and refused.json()["code"] == "person_required"
        # The person without the key, or with a wrong one.
        for headers in (PERSON, {**PERSON, KEY: "x" * 32}):
            refused = asked.client.post(url, headers=headers, json=GOOD_ANSWERS)
            assert refused.status_code == 403, (route, headers)
    assert asked.questions.get(set_id).is_open


def test_another_sets_key_does_not_answer_this_one(asked):
    first = _ask(asked).json()["questions"]["id"]
    second = _ask(asked).json()["questions"]["id"]
    refused = _answer(asked, first, GOOD_ANSWERS, key=_key(asked, second))
    assert refused.status_code == 403
    assert asked.questions.get(first).is_open


def test_the_person_answers_and_only_the_asker_reads_it(asked):
    set_id = _ask(asked).json()["questions"]["id"]
    response = _answer(asked, set_id, GOOD_ANSWERS)
    assert response.status_code == 200, response.text
    assert response.json() == {"status": "answered", "questionId": set_id}

    read = asked.client.get(f"/api/canvas/questions/{set_id}", headers=CLAUDE).json()["questions"]
    assert read["status"] == "answered"
    assert read["answers"] == [
        {"questionId": "q1", "answered": True, "choices": ["Wide"], "text": None},
        {"questionId": "q2", "answered": True, "choices": [], "text": SECRET_ANSWER},
    ]
    # Another agent, or no name at all, never reads it.
    other = asked.client.get(f"/api/canvas/questions/{set_id}", headers=CODEX)
    assert other.status_code == 404
    assert SECRET_ANSWER not in other.text
    assert asked.client.get(f"/api/canvas/questions/{set_id}").status_code == 400

    (note,) = _question_updates(asked)
    assert note["outcome"] == "Answered." and note["resolvedBy"] == {"kind": "person"}
    # The person's words are in no event any socket or agent reads, nor on the project.
    events = asked.journal.read(after=0, limit=100)["events"]
    assert [e for e in events if e["kind"] == "question.answered"]
    assert "client hates orange" not in json.dumps(events)
    assert "client hates orange" not in json.dumps(asked.sent)
    assert "client hates orange" not in json.dumps(_notes(asked))
    # The person's own tab gets them back, for the closed view.
    (closed,) = [m for m in asked.browser if m.get("type") == "questionsClosed"]
    assert closed["questionId"] == set_id and closed["status"] == "answered"
    assert closed["set"]["answers"][1]["text"] == SECRET_ANSWER
    assert _answer(asked, set_id, GOOD_ANSWERS).status_code == 409


def test_the_person_dismisses(asked):
    set_id = _ask(asked).json()["questions"]["id"]
    key = _key(asked, set_id)
    response = asked.client.post(f"/api/canvas/questions/{set_id}/dismiss", headers={**PERSON, KEY: key})
    assert response.status_code == 200
    read = asked.client.get(f"/api/canvas/questions/{set_id}", headers=CLAUDE).json()["questions"]
    assert read["status"] == "dismissed" and read["answers"] is None
    (note,) = _question_updates(asked)
    assert note["outcome"] == "Dismissed."


def test_an_answer_with_nothing_filled_in_is_refused(asked):
    set_id = _ask(asked).json()["questions"]["id"]
    refused = _answer(asked, set_id, {"answers": [{"questionId": "q2", "text": "  "}]})
    assert refused.status_code == 422
    assert "dismiss" in refused.json()["detail"]
    assert asked.questions.get(set_id).is_open


def test_only_the_asker_withdraws(asked):
    set_id = _ask(asked).json()["questions"]["id"]
    assert asked.client.delete(f"/api/canvas/questions/{set_id}", headers=CODEX).status_code == 404
    assert asked.client.delete(f"/api/canvas/questions/{set_id}", headers=PERSON).status_code == 400
    response = asked.client.delete(f"/api/canvas/questions/{set_id}", headers=CLAUDE)
    assert response.status_code == 200
    assert response.json()["questions"]["status"] == "withdrawn"
    (note,) = _question_updates(asked)
    assert note["outcome"] == "Withdrawn by Claude Code."
    assert _answer(asked, set_id, GOOD_ANSWERS).status_code == 409


def test_proposals_keep_their_own_restart_line(asked):
    from services.asset_proposals import RESTART_OUTCOME

    assert RESTART_OUTCOME == "Closed: Nebula restarted"


def test_waiting_returns_open_when_nobody_answered(asked):
    set_id = _ask(asked).json()["questions"]["id"]
    response = asked.client.get(f"/api/canvas/questions/{set_id}", headers=CLAUDE, params={"wait": 0.2})
    assert response.status_code == 200
    assert response.json()["questions"]["status"] == "open"


def test_a_wait_returns_as_soon_as_the_person_answers(asked):
    # get_answers and `nebula answers --wait` sit on this route: the person's
    # answer (a question.answered event) must wake the wait, not its deadline.
    set_id = _ask(asked).json()["questions"]["id"]
    key = _key(asked, set_id)

    async def scenario():
        transport = httpx.ASGITransport(app=asked.main.app)
        async with httpx.AsyncClient(transport=transport, base_url="http://testserver") as http:
            async def later():
                await asyncio.sleep(0.3)
                return await http.post(f"/api/canvas/questions/{set_id}/answer",
                                       headers={**PERSON, KEY: key}, json=GOOD_ANSWERS)

            task = asyncio.create_task(later())
            started = time.monotonic()
            waited = await http.get(f"/api/canvas/questions/{set_id}?wait=10", headers=CLAUDE)
            took = time.monotonic() - started
            await task
            return waited, task.result(), took

    waited, answered, took = asyncio.run(scenario())
    assert answered.status_code == 200, answered.text
    view = waited.json()["questions"]
    assert view["status"] == "answered"
    assert [a["answered"] for a in view["answers"]] == [True, True]
    assert took < 3.0, f"the wait ran {took:.1f} s: the answer didn't wake it"


def test_an_abandoned_answers_wait_frees_its_waiter_slot(asked):
    # Review 1 of PR #114 (M2): the waits share /api/canvas/events' 32 slots,
    # and a client that went away held one for the rest of its wait.
    from services.canvas_events import MAX_WAITERS

    set_id = _ask(asked).json()["questions"]["id"]

    async def scenario():
        gone = asyncio.Event()
        waits = [asyncio.create_task(asgi_get(asked.main.app, f"/api/canvas/questions/{set_id}", "wait=25", CLAUDE,
                                              gone)) for _ in range(MAX_WAITERS)]
        for _ in range(500):
            if asked.journal.waiting == MAX_WAITERS:
                break
            await asyncio.sleep(0.01)
        full = asked.journal.waiting
        gone.set()
        ended = await asyncio.wait_for(asyncio.gather(*waits), 2.0)
        return full, ended, asked.journal.waiting

    full, ended, freed = asyncio.run(scenario())
    assert full == MAX_WAITERS and freed == 0
    assert {answer["status"] for answer in ended} == {499}


def test_the_persons_socket_gets_the_open_sets_with_keys_on_hello(asked):
    set_id = _ask(asked).json()["questions"]["id"]
    key = _key(asked, set_id)
    with asked.client.websocket_connect("/ws", headers=FORGED_ORIGIN) as ws:
        for _ in range(3):
            ws.receive_json()
        ws.send_json(PERSON_HELLO)
        seen = [ws.receive_json() for _ in range(3)]
    (sync,) = [m for m in seen if m["type"] == "questionsSync"]
    (entry,) = sync["sets"]
    assert entry["id"] == set_id and entry["answerKey"] == key
    # A socket that never says hello never gets the key.
    with asked.client.websocket_connect("/ws", headers=FORGED_ORIGIN) as ws:
        quiet = [ws.receive_json() for _ in range(3)]
    assert key not in json.dumps(quiet)
