"""The Message box thread, round 5b (review 4 of #223/#225; the push ledger; GM r108, r110, r112).

- The push ledger (services/push_ledger.py; coordinator decision, the
  numbered tests): the listener reports each push (messageIds and
  questionIds), and a reply answers its session's OLDEST open push, in that
  push's project, marked once the row is saved.
- GM r112.1: one "replied in" Update per agent and project while unread,
  updated in place with a count; GM r108 d: “Untitled”.
- GM r108 b, review 4 LOW-3: a reply for another project's thread ignores
  its node, flies no cursor, and says so.
- GM r110: the no-project refusal points at open_project, in the refusal,
  the tool's docstring, MCP-SETUP and SKILL.md.
- Review 4 LOW-4: the inbox, accepted and held routes answer only the
  listener's own process (its nonce). And a message sent before a Nebula
  restart is still read after it (matched by agent and session).
"""
from __future__ import annotations

import json
import re
from pathlib import Path

import pytest

import mcp_channel
import mcp_server
from services import channel_listeners, person_thread, push_ledger
from services.project_store import make_project
from tests.conftest import PERSON
from tests.test_canvas_proposals import KEY, Clock, api  # noqa: F401 - fixture
from tests.test_person_thread import CLAUDE_TOKEN, CODEX_TOKEN, SESSION_A, SESSION_B, _listen, _send, thread  # noqa: F401
from tests.test_person_thread_round3 import _reply

ROOT = Path(__file__).resolve().parents[2]


def _accept(thread, headers, message_ids=(), question_ids=(), nonce=None):
    params = {"nonce": nonce} if nonce else None
    answer = thread.client.post("/api/agent/thread/accepted", headers=headers, params=params,
                                json={"messageIds": list(message_ids), "questionIds": list(question_ids)})
    assert answer.status_code == 200, answer.text
    return answer.json()


def _new_project(thread, name: str) -> str:
    store = thread.main.project_store
    with store.transaction() as catalog:
        project = make_project(name)
        catalog["projects"][project["id"]] = project
        store.commit(catalog)
    return project["id"]


def _open(thread, project_id: str | None) -> None:
    store = thread.main.project_store
    with store.transaction() as catalog:
        catalog["activeProjectId"] = project_id
        store.commit(catalog)


def _rename(thread, project_id: str, name: str) -> None:
    store = thread.main.project_store
    with store.transaction() as catalog:
        catalog["projects"][project_id]["name"] = name
        store.commit(catalog)


def _notes_of(thread, project_id: str) -> list[dict]:
    return list(thread.main.project_store.read()["projects"][project_id].get("agentNotes") or [])


def _replies_in(thread, project_id: str) -> list[dict]:
    return [row for row in thread.main.thread_book.rows(project_id)[1] if row["kind"] == "reply"]


def _message(thread, listener: str, headers, text: str = "make the sky warmer") -> str:
    row = _send(thread, listener, text).json()["row"]
    _accept(thread, headers, [row["id"]])
    return row["id"]


def _ask_answered(thread, headers=SESSION_A, choice: str = "Warm") -> str:
    asked = thread.client.post("/api/canvas/questions", headers=headers, json={"questions": [
        {"text": "Warm or cool?", "options": ["Warm", "Cool"]}]})
    assert asked.status_code == 201, asked.text
    set_id = asked.json()["questions"]["id"]
    key = next(m["answerKey"] for m in reversed(thread.browser) if m.get("type") == "questionsOpened")
    answered = thread.client.post(f"/api/canvas/questions/{set_id}/answer", headers={**PERSON, KEY: key},
                                  json={"answers": [{"questionId": "q1", "choices": [choice]}]})
    assert answered.status_code == 200, answered.text
    return set_id


def _later(thread, seconds: float = 2.5) -> None:
    thread.channel_clock.now += seconds  # past the reply pace, inside every span


# -- the push ledger: which push a reply answers --------------------------------------------------

def test_2_two_messages_in_one_push_one_reply_answers_it_naming_the_newer(thread):
    a = _listen(thread, SESSION_A)
    one = _send(thread, a, "make the sky warmer").json()["row"]["id"]
    two = _send(thread, a, "and add a moon").json()["row"]["id"]
    _accept(thread, SESSION_A, [one, two])
    first = _reply(thread, "Both done.", headers=SESSION_A).json()
    assert first["reply"]["replyTo"] == two
    assert thread.ledger.peek("app:claude1", "sess-a") is None  # nothing left to answer
    _later(thread)
    assert _reply(thread, "And one more thing.", headers=SESSION_A).json()["reply"]["replyTo"] is None


def test_3_two_pushes_the_first_reply_marks_the_older_the_second_the_newer(thread):
    a = _listen(thread, SESSION_A)
    one = _message(thread, a, SESSION_A, "make the sky warmer")
    two = _message(thread, a, SESSION_A, "and add a moon")
    assert _reply(thread, "Warmer.", headers=SESSION_A).json()["reply"]["replyTo"] == one
    _later(thread)
    assert _reply(thread, "Moon added.", headers=SESSION_A).json()["reply"]["replyTo"] == two


def test_a_retried_report_records_no_second_push(thread):
    a = _listen(thread, SESSION_A)
    one = _message(thread, a, SESSION_A)
    _accept(thread, SESSION_A, [one])  # the listener's retry
    assert len(thread.ledger.open_pushes("app:claude1", "sess-a")) == 1


def test_4_a_shell_reply_to_an_answer_only_push_names_its_question_set(thread):
    # Review 4 live MEDIUM-4: a session with no message asks; the person
    # picks; `nebula reply` from its shell (the same session) answers it.
    _listen(thread, SESSION_A)
    set_id = _ask_answered(thread)
    _accept(thread, SESSION_A, question_ids=[set_id])
    answer = _reply(thread, "Warm light it is, from my shell.", headers=SESSION_A).json()
    assert answer["reply"]["replyTo"] == set_id and answer["projectId"] == thread.project_id


def test_a_question_set_counts_only_when_the_caller_asked_it_and_it_is_answered(thread):
    _listen(thread, SESSION_A)
    _listen(thread, CODEX_TOKEN)
    asked = thread.client.post("/api/canvas/questions", headers=SESSION_A, json={"questions": [
        {"text": "Warm or cool?", "options": ["Warm", "Cool"]}]}).json()["questions"]["id"]
    _accept(thread, SESSION_A, question_ids=[asked])  # still open: not an answer push
    _accept(thread, CODEX_TOKEN, question_ids=[_ask_answered(thread)])  # Claude's set, Codex's report
    assert thread.ledger.open_pushes("app:claude1", "sess-a") == []
    assert thread.ledger.open_pushes("app:codex1", "") == []


def test_5_a_coast_message_then_a_harbor_answer_the_second_reply_lands_in_harbor_with_no_update(thread):
    coast = thread.project_id
    _rename(thread, coast, "Coast")
    harbor = _new_project(thread, "Harbor")
    a = _listen(thread, SESSION_A)
    message = _message(thread, a, SESSION_A)
    assert _reply(thread, "Warmer.", headers=SESSION_A).json()["reply"]["replyTo"] == message
    _open(thread, harbor)
    set_id = _ask_answered(thread, choice="Warm")
    _accept(thread, SESSION_A, question_ids=[set_id])
    _later(thread)
    answer = _reply(thread, "Red boat moved to the front.", headers=SESSION_A).json()
    assert answer["projectId"] == harbor and answer["reply"]["replyTo"] == set_id
    assert [r["text"] for r in _replies_in(thread, harbor)] == ["Red boat moved to the front."]
    assert _notes_of(thread, harbor) == [n for n in _notes_of(thread, harbor) if n.get("about") != "other"]


def test_6_an_answered_message_then_ten_replies_go_to_the_open_project_with_no_update(thread):
    # Review 4 MEDIUM-1 (34 Updates in 60 s): only a reply that answers a
    # push goes elsewhere.
    coast = thread.project_id
    forest = _new_project(thread, "Forest")
    a = _listen(thread, SESSION_A)
    _message(thread, a, SESSION_A)
    assert _reply(thread, "Done.", headers=SESSION_A).json()["projectId"] == coast
    _open(thread, forest)
    for n in range(10):
        _later(thread)
        answer = _reply(thread, f"Follow-up {n}.", headers=SESSION_A).json()
        assert answer["projectId"] == forest and answer["reply"]["replyTo"] is None
    assert [n for n in _notes_of(thread, forest) if n.get("about") == "other"] == []
    assert len(_replies_in(thread, forest)) == 10


def test_7_a_coast_message_with_the_person_in_harbor_one_update_and_a_second_reply_none(thread):
    coast = thread.project_id
    _rename(thread, coast, "Coast")
    harbor = _new_project(thread, "Harbor")
    a = _listen(thread, SESSION_A)
    _message(thread, a, SESSION_A)
    _open(thread, harbor)
    first = _reply(thread, "Warmer.", headers=SESSION_A).json()
    assert first["projectId"] == coast
    _later(thread)
    second = _reply(thread, "Anything else?", headers=SESSION_A).json()
    assert second["projectId"] == harbor and second["reply"]["replyTo"] is None
    notes = [n for n in _notes_of(thread, harbor) if n.get("about") == "other"]
    assert [n["text"] for n in notes] == ["Claude Code replied in “Coast”."]
    assert notes[0]["actions"] == [{"label": "Open", "op": {"kind": "thread.open", "projectId": coast,
                                                            "replyId": first["reply"]["id"]}}]


def test_8_a_sibling_session_or_a_stray_shell_never_answers_this_sessions_push(thread):
    a = _listen(thread, SESSION_A)
    _listen(thread, SESSION_B)
    message = _message(thread, a, SESSION_A)
    assert _reply(thread, "B here.", headers=SESSION_B).json()["reply"]["replyTo"] is None
    _later(thread)
    stray = {**CLAUDE_TOKEN, "X-Nebula-Cursor-Session": "cc-0123456789abcdef"}
    answer = _reply(thread, "Which one?", headers=stray).json()
    assert answer["reply"]["replyTo"] is None and "note" in answer  # two fresh listeners: no guess
    assert thread.ledger.peek("app:claude1", "sess-a").reply_to() == message
    _later(thread)
    assert _reply(thread, "Done.", headers=SESSION_A).json()["reply"]["replyTo"] == message


def test_9_another_token_never_marks(thread):
    a = _listen(thread, SESSION_A)
    _listen(thread, CODEX_TOKEN)
    message = _message(thread, a, SESSION_A)
    _accept(thread, CODEX_TOKEN, [message])  # Codex reporting Claude's message records nothing
    assert _reply(thread, "Codex here.", headers=CODEX_TOKEN).json()["reply"]["replyTo"] is None
    assert thread.ledger.peek("app:claude1", "sess-a").reply_to() == message
    assert thread.ledger.open_pushes("app:codex1", "") == []


def test_11_the_cap_mirrors_the_listeners_span():
    assert push_ledger.DELIBERATE_SPAN_CAP == mcp_channel.DELIBERATE_SPAN_CAP
    clock = Clock()
    start = clock.now
    ledger = push_ledger.PushLedger(clock)
    ledger.record("app:a", "s", [("m0", push_ledger.MESSAGE, "p")])
    clock.now = start + 550.0
    ledger.record("app:a", "s", [("m1", push_ledger.MESSAGE, "p")])
    clock.now = start + 900.0  # one period (550 s apart): the t=0 push is still pickable
    assert ledger.peek("app:a", "s").reply_to() == "m0"
    clock.now = start + 1200.0  # 650 s after the last push: past the span, so the listener is told of none,
    assert ledger.open_pushes("app:a", "s") == []  # but a late reply (round 5c, LOW-1) still answers m0
    assert ledger.peek("app:a", "s").reply_to() == "m0"
    # Past the cap between two pushes: only the latest period is pickable.
    clock.now = start + 1900.0
    ledger.record("app:a", "s", [("m3", push_ledger.MESSAGE, "p")])
    assert ledger.peek("app:a", "s").reply_to() == "m3"
    assert [p["ids"] for p in ledger.open_pushes("app:a", "s")] == [["m3"]]


def test_a_failed_save_leaves_the_push_open_and_a_race_takes_the_next():
    ledger = push_ledger.PushLedger(Clock())
    ledger.record("app:a", "s", [("m0", push_ledger.MESSAGE, "p")])
    ledger.record("app:a", "s", [("m1", push_ledger.MESSAGE, "p")])
    first = ledger.claim("app:a", "s", lambda _p: True, "t1")
    racing = ledger.claim("app:a", "s", lambda _p: True, "t2")
    assert (first.reply_to(), racing.reply_to()) == ("m0", "m1")
    ledger.release(first, "t1")  # its row failed to save
    assert ledger.settle(racing, "t2", "pt_2") and not ledger.settle(first, "t1", "pt_1")
    assert ledger.peek("app:a", "s").reply_to() == "m0"


def test_a_store_error_leaves_the_push_open(thread, monkeypatch):
    a = _listen(thread, SESSION_A)
    message = _message(thread, a, SESSION_A)
    store = thread.main.project_store
    real = store.commit

    def broken(catalog):
        raise person_thread.ThreadError(409, "nope")

    monkeypatch.setattr(store, "commit", broken)
    assert _reply(thread, "Done.", headers=SESSION_A).status_code == 409
    monkeypatch.setattr(store, "commit", real)
    assert thread.ledger.peek("app:claude1", "sess-a").reply_to() == message


def test_15_a_push_whose_project_was_deleted_is_skipped(thread):
    first = thread.project_id
    coast = _new_project(thread, "Coast")
    a = _listen(thread, SESSION_A)
    _open(thread, coast)
    gone = _message(thread, a, SESSION_A, "in Coast")
    _open(thread, first)
    kept = _message(thread, a, SESSION_A, "in the first")
    store = thread.main.project_store
    with store.transaction() as catalog:
        del catalog["projects"][coast]
        store.commit(catalog)
    answer = _reply(thread, "Done.", headers=SESSION_A).json()
    assert answer["reply"]["replyTo"] == kept and answer["projectId"] == first
    assert gone


def test_16_a_cross_project_reply_with_a_node_is_saved_without_it_flies_nothing_and_says_so(thread):
    coast = thread.project_id
    _rename(thread, coast, "Coast")
    harbor = _new_project(thread, "Harbor")
    a = _listen(thread, SESSION_A)
    _message(thread, a, SESSION_A)
    _open(thread, harbor)
    before = len([m for m in thread.sent if m.get("type") == "agentPresence"])
    answer = _reply(thread, "Cooler sky is in.", headers=SESSION_A, nodeId="n3")  # not on Harbor's canvas
    assert answer.status_code == 201, answer.text
    assert answer.json()["projectId"] == coast and _replies_in(thread, coast)[0]["nodeId"] is None
    assert answer.json()["note"] == ("Nebula posted this reply in “Coast” but didn’t point at n3 because that "
                                     "project isn’t open, so your cursor stayed where it was.")
    assert len([m for m in thread.sent if m.get("type") == "agentPresence"]) == before  # GM r108 b


def test_a_node_on_the_open_canvas_is_still_checked_and_points(thread):
    n1 = thread.main.cli_graph.add_node("text-input", {"value": "a"})
    a = _listen(thread, SESSION_A)
    _message(thread, a, SESSION_A)
    refused = _reply(thread, "Done.", headers=SESSION_A, nodeId="n_missing")
    assert refused.status_code == 422 and "No node 'n_missing' on the canvas" in refused.json()["detail"]
    assert _reply(thread, "Done.", headers=SESSION_A, nodeId=n1).status_code == 201
    assert [m for m in thread.sent if m.get("type") == "agentPresence"]


def test_18_the_reply_events_data_keys_are_exactly_these(thread):
    a = _listen(thread, SESSION_A)
    _message(thread, a, SESSION_A)
    assert _reply(thread, "Done.", headers=SESSION_A).status_code == 201
    event = [e for e in thread.journal._events if e["kind"] == person_thread.REPLY_EVENT][-1]
    assert set(event["data"]) == {"replyId", "text", "nodeId", "replyTo"}


# -- the listener against the real routes -----------------------------------------------------------

def _feed(thread, state, now, headers):
    params = {"wait": 0, "ownReplies": 1, "after": state.cursor if state.cursor is not None else 0}
    if state.journal:
        params["journal"] = state.journal
    answer = thread.client.get("/api/canvas/events", params=params, headers=headers)
    assert answer.status_code == 200, answer.text
    state.observe(answer.json(), now)


def _listening_state(thread, headers, nonce="process-one-0001"):
    beat = thread.client.post("/api/agent/channel", headers=headers, json={"state": "listening", "nonce": nonce})
    assert beat.status_code == 200, beat.text
    state = mcp_channel.ChannelState(now=0.0)
    state.beat_answered(beat.json(), 1.0)
    _feed(thread, state, 1.0, headers)
    return state


def _push_messages(thread, state, headers, texts, now, nonce="process-one-0001"):
    """The person sends; the listener reads its inbox, pushes, and reports the push."""
    for text in texts:
        _send(thread, state.listener_id, text)
    _feed(thread, state, now, headers)
    assert state.inbox_to_fetch()
    inbox = thread.client.get("/api/agent/thread/inbox", headers=headers, params={"nonce": nonce}).json()
    state.messages_fetched(inbox["messages"])
    push = state.take_push(now)
    assert push is not None and push.group
    return push


def _tool(state, result, now):
    assert state.tool_started("reply_to_person", {"text": "x"}, now) is None
    state.tool_finished("reply_to_person", {"text": "x"}, result, now)


@pytest.mark.parametrize("order", ["echo first", "result first"])
def test_1_one_reply_through_the_real_route_ends_exactly_one_push_in_either_order(thread, order):
    state = _listening_state(thread, SESSION_A)
    pushes = [_push_messages(thread, state, SESSION_A, ["make the sky warmer"], 100.0),
              _push_messages(thread, state, SESSION_A, ["and add a moon"], 110.0)]
    for push in pushes:
        _accept(thread, SESSION_A, push.message_ids, push.question_ids, nonce="process-one-0001")
        state.push_accepted(push.group)
    answer = _reply(thread, "Warmer.", headers=SESSION_A).json()
    if order == "echo first":
        _feed(thread, state, 150.0, SESSION_A)
        _tool(state, answer, 150.1)
    else:
        _tool(state, answer, 150.0)
        _feed(thread, state, 150.1, SESSION_A)
    assert [g["ids"] for g in state._open_groups.values()] == [pushes[1].message_ids]
    assert state._reply_due_at is not None  # the moon's span holds


def test_12_after_a_nebula_restart_the_resend_lets_a_shell_reply_end_the_span(thread, monkeypatch):
    state = _listening_state(thread, SESSION_A)
    push = _push_messages(thread, state, SESSION_A, ["make the sky warmer"], 100.0)
    _accept(thread, SESSION_A, push.message_ids, nonce="process-one-0001")
    state.push_accepted(push.group)
    second = _push_messages(thread, state, SESSION_A, ["and add a moon"], 110.0)
    _accept(thread, SESSION_A, second.message_ids, nonce="process-one-0001")
    state.push_accepted(second.group)
    # Nebula restarts: a new ledger and a new listener secret (the journal id changes too).
    monkeypatch.setattr(thread.main, "thread_ledger", push_ledger.PushLedger(thread.channel_clock))
    thread.ledger = thread.main.thread_ledger
    state.observe({"journal": "a-new-journal", "cursor": 0, "reset": True, "events": []}, 200.0)
    resend = state.groups_to_resend()
    assert len(resend) == 2
    # Before the re-send: Nebula marks nothing; the tool's own result ends exactly one.
    answer = _reply(thread, "Warmer.", headers=SESSION_A).json()
    assert answer["reply"]["replyTo"] is None
    _tool(state, answer, 201.0)
    assert len(state._open_groups) == 1
    # Re-sent (already accepted rows count for this agent): a shell reply then ends it.
    group, message_ids, question_ids = resend[1]
    _accept(thread, SESSION_A, message_ids, question_ids, nonce="process-one-0001")
    state.push_accepted(group)
    _later(thread)
    answer = _reply(thread, "Moon added.", headers=SESSION_A).json()
    assert answer["reply"]["replyTo"] == second.message_ids[-1]
    state.journal = None
    state.cursor = None
    _feed(thread, state, 210.0, SESSION_A)
    assert state._open_groups == {} and state._reply_due_at is None


def test_13_a_listener_restarted_in_the_same_session_takes_its_open_pushes(thread):
    state = _listening_state(thread, SESSION_A)
    push = _push_messages(thread, state, SESSION_A, ["make the sky warmer"], 100.0)
    _accept(thread, SESSION_A, push.message_ids, nonce="process-one-0001")
    # The old process dies; once its entry lapses the successor beats.
    thread.channel_clock.now += channel_listeners.TTL_SECONDS + 1
    beat = thread.client.post("/api/agent/channel", headers=SESSION_A,
                              json={"state": "listening", "nonce": "process-two-0002"}).json()
    assert [p["ids"] for p in beat["openPushes"]] == [push.message_ids]
    again = thread.client.post("/api/agent/channel", headers=SESSION_A,
                               json={"state": "listening", "nonce": "process-two-0002"}).json()
    assert "openPushes" not in again  # only a new process's first beat
    successor = mcp_channel.ChannelState(now=0.0)
    assert successor.beat_answered(beat, 500.0) is True
    assert successor._reply_due_at is not None and len(successor._open_groups) == 1
    _feed(thread, successor, 500.0, SESSION_A)
    assert _reply(thread, "Warmer.", headers=SESSION_A).json()["reply"]["replyTo"] == push.message_ids[-1]
    _feed(thread, successor, 501.0, SESSION_A)
    assert successor._open_groups == {} and successor._reply_due_at is None


def test_14_an_unreported_push_is_ended_by_the_tool_once_never_by_a_shell_reply(thread):
    state = _listening_state(thread, SESSION_A)
    _push_messages(thread, state, SESSION_A, ["make the sky warmer"], 100.0)  # its accept never reached Nebula
    answer = _reply(thread, "Done.", headers=SESSION_A).json()
    assert answer["reply"]["replyTo"] is None
    _feed(thread, state, 150.0, SESSION_A)  # the shell's echo: names nothing
    assert len(state._open_groups) == 1
    _tool(state, answer, 150.1)  # the tool's result: the oldest unconfirmed
    assert state._open_groups == {}


def test_the_first_good_beat_marks_the_inbox_due(thread):
    # GM r112.5: a message sent while the successor waited is read once it registers.
    state = mcp_channel.ChannelState(now=0.0)
    beat = thread.client.post("/api/agent/channel", headers=SESSION_A,
                              json={"state": "listening", "nonce": "process-one-0001"}).json()
    assert state.beat_answered(beat, 1.0) is True and state.inbox_to_fetch()
    assert state.beat_answered(beat, 2.0) is False and not state.inbox_to_fetch()


# -- review 4 LOW-4: the nonce binds the inbox, accepted and held routes -------------------------

def test_only_the_process_holding_the_session_reads_or_marks_its_messages(thread):
    one = thread.client.post("/api/agent/channel", headers=SESSION_A,
                             json={"state": "listening", "nonce": "process-one-0001"}).json()["listener"]
    row = _send(thread, one["listenerId"]).json()["row"]
    for method, path, body in (("get", "/api/agent/thread/inbox", None),
                               ("post", "/api/agent/thread/accepted", {"messageIds": [row["id"]]}),
                               ("post", "/api/agent/thread/held", {"messageIds": [row["id"]]})):
        for nonce in ("process-two-0002", None):
            call = getattr(thread.client, method)
            kwargs = {"headers": SESSION_A, "params": {"nonce": nonce} if nonce else None}
            if body is not None:
                kwargs["json"] = body
            refused = call(path, **kwargs)
            assert refused.status_code == 409, (path, nonce)
            assert refused.headers["X-Nebula-Code"] == channel_listeners.SESSION_TAKEN_CODE
            assert refused.json()["detail"] == channel_listeners.SESSION_TAKEN_LINE
    inbox = thread.client.get("/api/agent/thread/inbox", headers=SESSION_A, params={"nonce": "process-one-0001"})
    assert [m["messageId"] for m in inbox.json()["messages"]] == [row["id"]]


def test_the_listener_sends_its_nonce_on_its_inbox_accepted_and_held_calls():
    import inspect

    source = inspect.getsource(mcp_server.serve_channel)
    for path in ("/api/agent/thread/inbox", "/api/agent/thread/accepted", "/api/agent/thread/held"):
        call = source[source.index(path) - 40: source.index(path) + 80]
        assert '{"nonce": _CHANNEL_NONCE}' in call, path
    assert '"questionIds": question_ids' in source


# -- review 4: a message sent before a Nebula restart is still read after it ----------------------

def test_a_message_sent_before_a_restart_is_read_after_it(thread, monkeypatch):
    # Probe (review 4, "outside the design"): the inbox matched to.listenerId,
    # an HMAC under a secret each backend process makes, so after a restart
    # the listener's new id never matched a message "Sent" before it.
    old = _listen(thread, SESSION_A)
    row = _send(thread, old).json()["row"]
    restarted = channel_listeners.ListenerBook(thread.channel_clock)
    monkeypatch.setattr(thread.main, "channel_book", restarted)
    new = _listen(thread, SESSION_A)
    assert new != old  # a new process secret: a new listener id
    inbox = thread.client.get("/api/agent/thread/inbox", headers=SESSION_A).json()["messages"]
    assert [m["messageId"] for m in inbox] == [row["id"]]
    assert _accept(thread, SESSION_A, [row["id"]])["accepted"] == [row["id"]]
    # The route never leaves the backend.
    assert "route" not in json.dumps(thread.browser) and "route" not in json.dumps(
        thread.client.get("/api/canvas/thread", headers=PERSON).json())
    assert "route" not in json.dumps(thread.client.get("/api/canvas/thread", headers=SESSION_A).json())


def test_a_revoked_agents_messages_and_pushes_go_even_after_a_restart(thread, monkeypatch):
    # Revoke used to find in-flight rows by the listeners still registered;
    # after a restart there are none, so it settles by agent id.
    from services import app_tokens
    monkeypatch.setattr(app_tokens, "valid_id", lambda app_id: app_id.isalnum())
    monkeypatch.setattr(thread.main.app_token_store, "revoke", lambda app_id: app_id == "claude1")
    a = _listen(thread, SESSION_A)
    taken = _message(thread, a, SESSION_A)
    stranded = _send(thread, a, "after the restart").json()["row"]
    monkeypatch.setattr(thread.main, "channel_book", channel_listeners.ListenerBook(thread.channel_clock))
    assert thread.ledger.peek("app:claude1", "sess-a") is not None
    assert thread.client.delete("/api/agent/spend/apps/claude1", headers=PERSON).status_code == 200
    rows = thread.client.get("/api/canvas/thread", headers=PERSON).json()["rows"]
    states = {r["id"]: r["state"] for r in rows if r["kind"] == "message"}
    assert states == {taken: "accepted", stranded["id"]: person_thread.DROPPED_STATE}
    assert thread.ledger.peek("app:claude1", "sess-a") is None


# -- GM r112.1: one "replied in" Update per agent and project while unread -------------------------

def _away_reply(thread, a, harbor, text):
    _open(thread, thread.project_id)
    _message(thread, a, SESSION_A)
    _open(thread, harbor)
    _later(thread)
    answer = _reply(thread, text, headers=SESSION_A)
    assert answer.status_code == 201, answer.text
    return answer.json()


def test_replies_in_coast_coalesce_into_one_update_counted_from_the_second(thread):
    coast = thread.project_id
    _rename(thread, coast, "Coast")
    harbor = _new_project(thread, "Harbor")
    a = _listen(thread, SESSION_A)
    first = _away_reply(thread, a, harbor, "One.")
    note_id = [n for n in _notes_of(thread, harbor) if n.get("about") == "other"][0]["id"]
    _away_reply(thread, a, harbor, "Two.")
    third = _away_reply(thread, a, harbor, "Three.")
    notes = [n for n in _notes_of(thread, harbor) if n.get("about") == "other"]
    assert [(n["id"], n["text"]) for n in notes] == [(note_id, "Claude Code replied 3 times in “Coast”.")]
    assert notes[0]["actions"][0]["op"]["replyId"] == third["reply"]["id"] != first["reply"]["id"]
    assert _notes_of(thread, harbor)[-1]["id"] == note_id  # moved to the top (newest last on the record)
    # The tabs hear it as the same Update (in place, no second card).
    added = [m for m in thread.sent if m.get("type") == "agentNotes" and m.get("op") == "added"]
    assert {m["note"]["id"] for m in added} == {note_id}


def test_two_projects_two_updates_and_once_read_the_next_reply_starts_a_new_one(thread):
    coast = thread.project_id
    _rename(thread, coast, "Coast")
    forest = _new_project(thread, "Forest")
    harbor = _new_project(thread, "Harbor")
    a = _listen(thread, SESSION_A)
    _away_reply(thread, a, harbor, "Coast one.")
    _open(thread, forest)
    _message(thread, a, SESSION_A, "in Forest")
    _open(thread, harbor)
    _later(thread)
    _reply(thread, "Forest one.", headers=SESSION_A)
    texts = sorted(n["text"] for n in _notes_of(thread, harbor) if n.get("about") == "other")
    assert texts == ["Claude Code replied in “Coast”.", "Claude Code replied in “Forest”."]
    assert thread.client.post("/api/canvas/agent-notes/read", headers=PERSON, json={}).status_code == 200
    _away_reply(thread, a, harbor, "Coast two.")
    unread = [n for n in _notes_of(thread, harbor) if n.get("about") == "other" and not n.get("readAt")]
    assert [n["text"] for n in unread] == ["Claude Code replied in “Coast”."]


def test_the_updates_limit_applies_to_replied_updates(thread):
    coast = thread.project_id
    harbor = _new_project(thread, "Harbor")
    a = _listen(thread, SESSION_A)
    _open(thread, harbor)
    for n in range(6):  # the agent's own 6 Updates this minute
        assert thread.client.post("/api/canvas/agent-notes", headers=SESSION_A, json={"text": f"n{n}"}).status_code \
            == 201
    _open(thread, coast)
    _message(thread, a, SESSION_A)
    _open(thread, harbor)
    answer = _reply(thread, "Done.", headers=SESSION_A)
    assert answer.status_code == 201 and answer.json()["projectId"] == coast  # the reply is saved
    assert [n for n in _notes_of(thread, harbor) if n.get("about") == "other" and n.get("replied")] == []


def test_an_unnamed_project_reads_untitled(thread):
    assert person_thread.replied_elsewhere_text("Claude Code", "  ") == "Claude Code replied in “Untitled”."
    assert person_thread.replied_elsewhere_text("Claude Code", "Coast", 2) == "Claude Code replied 2 times in “Coast”."
    coast = thread.project_id
    _rename(thread, coast, "")
    harbor = _new_project(thread, "Harbor")
    a = _listen(thread, SESSION_A)
    _message(thread, a, SESSION_A)
    _open(thread, harbor)
    _reply(thread, "Done.", headers=SESSION_A)
    assert [n["text"] for n in _notes_of(thread, harbor) if n.get("about") == "other"] == [
        "Claude Code replied in “Untitled”."]


# -- GM r110: the no-project refusal points at open_project --------------------------------------

NO_PROJECT = ("Nebula couldn’t post this reply because no project is open. Open one with open_project, then reply "
              "again.")
FORBIDDEN = ("ask the person to open one", "Ask the person to open one", "Ask the person to open it with Load graph")


def test_the_no_project_refusal_is_gm_r110s(thread):
    assert person_thread.REPLY_NO_PROJECT_LINE == NO_PROJECT
    _listen(thread, SESSION_A)
    _open(thread, None)
    refused = _reply(thread, "Done.", headers=SESSION_A)
    assert refused.status_code == 409 and refused.json() == {"detail": NO_PROJECT, "code": "no_project"}


def test_the_agent_docs_never_tell_an_agent_to_ask_the_person_to_open_a_project():
    # The CI failure on eebe52f0: agents open projects themselves. A sweep of
    # every agent-facing text: SKILL.md, MCP-SETUP.md and every MCP tool's
    # docstring (the descriptions agents read).
    texts = {doc: (ROOT / doc).read_text() for doc in ("skills/nebula/SKILL.md", "docs/MCP-SETUP.md")}
    texts.update({f"tool {name}": tool.description or "" for name, tool in mcp_server.mcp._tool_manager._tools.items()})
    texts["mcp INSTRUCTIONS"] = mcp_server.INSTRUCTIONS + mcp_channel.INSTRUCTIONS
    for where, text in texts.items():
        flat = " ".join(text.split())
        for phrase in FORBIDDEN:
            assert phrase not in flat, (where, phrase)
    for doc in ("skills/nebula/SKILL.md", "docs/MCP-SETUP.md"):
        assert NO_PROJECT in " ".join(texts[doc].split()), doc
    reply = " ".join((mcp_server.mcp._tool_manager._tools["reply_to_person"].description or "").split())
    assert NO_PROJECT in reply
    # open_project switches the person's canvas: open the message's own project.
    assert "never an unrelated one" in reply
    assert "never an unrelated one" in " ".join(texts["skills/nebula/SKILL.md"].split())
    assert "never open an unrelated one" in " ".join(texts["docs/MCP-SETUP.md"].split())


def test_mcp_setup_lists_every_token_file_clause():
    # Review 4 parity NIT-1: the symlink clause was missing from the list.
    source = (ROOT / "backend/services/agent_token_file.py").read_text()
    clauses = set(re.findall(r'"(points to [^"]+)"', source))
    assert "points to a file Nebula can’t open" in clauses
    doc = " ".join((ROOT / "docs/MCP-SETUP.md").read_text().split())
    for clause in clauses:
        assert f"“{clause}”" in doc or f'"{clause}"' in doc, clause


def test_the_gm_r108_strings_3_and_4_put_the_command_on_its_own_line():
    three = person_thread.reply_unmatched_line("Claude Code", 2).split("\n")
    four = channel_listeners.SESSION_TAKEN_LINE.split("\n")
    assert three[1] == four[1] == "nebula mcp connect claude-code --channel" and len(three) == len(four) == 2
    assert four[0].endswith("which gives each one its own session, then start this listener again.")
    assert three[0].endswith("which gives it its own session that its terminals share.")
