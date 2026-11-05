"""The Message box's thread (services/person_thread.py, GM - Design r50).

The person messages a Claude Code session listening through the Nebula
channel from the canvas; it answers with reply_to_person (MCP) or `nebula
reply` (CLI). Rows are kept on the project record, so a reload and every tab
agree. What these pin down:

- only the person sends, only to a listening session; the 201st message to
  one listener in an hour is accepted and held (GM r55), never refused, and
  the listener reports any other message it holds;
- the read boundary (Justin, 2026-11-03): every connected agent reads the
  thread, as pins (journal and read tool), under ONE switch,
  person_thread.AGENTS_READ_WHOLE_THREAD; only the listener named in `to`
  wakes;
- the listener reads its own messages back (the inbox) and says when it
  pushed them (accepted: "Waiting for Claude");
- replies: agents only, journaled, and the cursor's first-sentence say;
- the rows that point elsewhere (question, proposal, note, pin, pin reply)
  are added only while that session listens.
"""
from __future__ import annotations

import json
from types import SimpleNamespace

import asyncio

import pytest

import mcp_channel
import mcp_server
from services import app_tokens, channel_listeners, krea_agent_mcp, person_thread
from tests.conftest import PERSON
from tests.test_canvas_proposals import CLAUDE, CODEX, KEY, Clock, api  # noqa: F401 - fixture

# Only an agent token registers a listener (Justin, 2026-11-03): sessions of
# one Settings token, as `nebula mcp connect claude-code --channel` saves it.
TOKENS = {"tok-claude": {"id": "claude1", "name": "Claude Code", "color": "#C3E86B"},
          "tok-codex": {"id": "codex1", "name": "Codex", "color": "#7AA2F7"}}
CLAUDE_TOKEN = {"Authorization": "Agent tok-claude"}
CODEX_TOKEN = {"Authorization": "Agent tok-codex"}
SESSION_A = {**CLAUDE_TOKEN, "X-Nebula-Agent-Session": "sess-a"}
SESSION_B = {**CLAUDE_TOKEN, "X-Nebula-Agent-Session": "sess-b"}


@pytest.fixture
def thread(api, monkeypatch):  # noqa: F811 - the imported fixture
    monkeypatch.setattr(app_tokens, "lookup", lambda token: TOKENS.get(token))
    clock = Clock()
    book = channel_listeners.ListenerBook(clock)
    monkeypatch.setattr(api.main, "channel_book", book)
    cap = person_thread.SendCap(clock)
    monkeypatch.setattr(api.main, "thread_send_cap", cap)
    # Each test starts with a fresh reply pace (round 3: 5 in a row, then one every 2 s).
    monkeypatch.setattr(api.main, "thread_reply_pace", person_thread.ReplyPace(clock))
    # And a fresh push ledger on the same clock (review 4: which push a reply answers).
    from services import push_ledger

    ledger = push_ledger.PushLedger(clock)
    monkeypatch.setattr(api.main, "thread_ledger", ledger)
    api.ledger = ledger
    # Agent sockets: what the agents' form of a broadcast reached.
    others: list[dict] = []

    async def capture_others(data):
        others.append(data)

    monkeypatch.setattr(api.main.manager, "broadcast_others", capture_others)
    # broadcast_raw's `others` (the agents' form), which the api fixture drops.
    raw_others: list[dict] = []

    async def capture_raw(data, *, others=None):
        api.sent.append(data)
        raw_others.append(data if others is None else others)

    monkeypatch.setattr(api.main.manager, "broadcast_raw", capture_raw)
    api.raw_others = raw_others
    api.channel = book
    api.channel_clock = clock
    api.cap = cap
    api.others = others
    return api


def _listen(api, headers=SESSION_A) -> str:
    answer = api.client.post("/api/agent/channel", headers=headers, json={"state": "listening"})
    assert answer.status_code == 200, answer.text
    return answer.json()["listener"]["listenerId"]


def _send(api, to: str, text: str = "make the sky warmer", **body):
    return api.client.post("/api/canvas/thread/messages", headers=PERSON, json={"text": text, "to": to, **body})


def _rows(api) -> list[dict]:
    return [row for m in api.browser if m.get("type") == "personThread" for row in m["rows"]]


def _journal_text(api) -> str:
    return json.dumps(list(api.journal._events))


# -- sending -------------------------------------------------------------------------------

def test_the_person_sends_and_only_the_listener_named_reads_it(thread):
    n1 = thread.graph.add_node("text-input", {"value": "a cat"})
    a = _listen(thread, SESSION_A)
    _listen(thread, SESSION_B)
    sent = _send(thread, a, "line one\nline two", nodeIds=[n1, "nope"])
    assert sent.status_code == 201, sent.text
    row = sent.json()["row"]
    assert row["kind"] == "message" and row["text"] == "line one\nline two" and row["nodeIds"] == [n1]
    assert row["state"] == "sent" and row["to"]["listenerId"] == a
    assert set(row["to"]["session"]) == {"key", "ordinal"} and "sess-a" not in json.dumps(row)
    # The person's tabs got it; agent sockets never did.
    assert [r["id"] for r in _rows(thread)] == [row["id"]]
    assert not any(m.get("type") == "personThread" for m in thread.others + thread.sent)
    # Session A reads it back; session B, Codex and the person's other session don't.
    inbox = thread.client.get("/api/agent/thread/inbox", headers=SESSION_A).json()["messages"]
    assert inbox == [{"messageId": row["id"], "text": "line one\nline two", "nodeIds": [n1],
                      "projectId": thread.project_id}]
    assert thread.client.get("/api/agent/thread/inbox", headers=SESSION_B).json()["messages"] == []
    assert thread.client.get("/api/agent/thread/inbox", headers=CODEX_TOKEN).json()["messages"] == []
    # A name alone (no token) can't read any inbox (Justin, 2026-11-03).
    refused = thread.client.get("/api/agent/thread/inbox", headers={**CLAUDE, "X-Nebula-Agent-Session": "sess-a"})
    assert refused.status_code == 401 and "has no token" in refused.json()["detail"]


def test_every_agent_reads_the_message_in_the_journal_and_the_switch_narrows_it(thread, monkeypatch):
    a = _listen(thread)
    row = _send(thread, a, "the plan for the hero shot").json()["row"]
    events = [e for e in thread.journal._events if e["kind"] == mcp_channel.MESSAGE_KIND]
    assert len(events) == 1 and events[0]["actor"] == {"kind": "person"}
    assert events[0]["data"] == {"messageId": row["id"], "text": "the plan for the hero shot", "nodeIds": [],
                                 "to": a}
    seen = thread.client.get("/api/canvas/events", headers=CODEX_TOKEN, params={"after": 0}).json()["events"]
    assert "the plan for the hero shot" in json.dumps(seen)
    assert person_thread.MESSAGE_EVENT == mcp_channel.MESSAGE_KIND
    # Narrowed, the event names only its listener (the wake still works).
    monkeypatch.setattr(person_thread, "AGENTS_READ_WHOLE_THREAD", False)
    _send(thread, a, "private now")
    last = [e for e in thread.journal._events if e["kind"] == mcp_channel.MESSAGE_KIND][-1]
    assert last["data"] == {"to": a} and "private now" not in _journal_text(thread)


def test_only_the_person_can_send(thread):
    a = _listen(thread)
    for headers in (SESSION_A, CODEX, {}):
        answer = thread.client.post("/api/canvas/thread/messages", headers=headers, json={"text": "hi", "to": a})
        assert answer.status_code in (400, 403), (headers, answer.status_code)
    assert thread.client.get("/api/canvas/thread", headers=PERSON).json()["rows"] == []


def test_a_stopped_or_gone_listener_refuses_with_the_persons_line(thread):
    a = _listen(thread)
    thread.client.post("/api/agent/channel", headers=SESSION_A, json={"state": "stopped", "reason": "idle"})
    for to in (a, "ch_gone"):
        answer = _send(thread, to)
        assert answer.status_code == 409
        assert answer.json()["code"] == person_thread.STOPPED_CODE
        assert answer.json()["person"] == person_thread.STOPPED_LINE
    assert person_thread.STOPPED_LINE == ("Nebula couldn’t send your message because Claude stopped listening. "
                                          "Reconnect it in the terminal, then send it again.")
    assert not [e for e in thread.journal._events if e["kind"] == mcp_channel.MESSAGE_KIND]


def test_the_201st_message_to_a_listener_in_an_hour_is_accepted_and_held(thread):
    a = _listen(thread)
    b = _listen(thread, SESSION_B)
    for n in range(person_thread.SEND_CAP):
        answer = _send(thread, a, f"message {n}")
        assert answer.status_code == 201 and answer.json()["row"]["state"] == "sent"
        if n % 20 == 0:
            thread.channel_clock.now += 1  # under the hour throughout
            _listen(thread)  # the listeners beat on
            _listen(thread, SESSION_B)
    held = _send(thread, a, "one more")
    assert held.status_code == 201 and held.json()["row"]["state"] == "held"
    assert [e for e in thread.journal._events if e["kind"] == mcp_channel.MESSAGE_KIND][-1]["data"]["text"] == "one more"
    # Counted per listener: another session's first isn't held.
    assert _send(thread, b, "to b").json()["row"]["state"] == "sent"
    # Still in its inbox; once pushed it is accepted like any other.
    inbox = thread.client.get("/api/agent/thread/inbox", headers=SESSION_A).json()["messages"]
    assert held.json()["row"]["id"] in [m["messageId"] for m in inbox]
    thread.client.post("/api/agent/thread/accepted", headers=SESSION_A, json={"messageIds": [held.json()["row"]["id"]]})
    rows = {r["id"]: r for r in thread.client.get("/api/canvas/thread", headers=PERSON, params={"limit": 300}).json()["rows"]}
    assert rows[held.json()["row"]["id"]]["state"] == "accepted"
    assert person_thread.HELD_LINE == "Sends in a few minutes because you’ve sent 200 this hour."


def test_the_listener_reports_what_it_holds(thread):
    a = _listen(thread)
    b = _listen(thread, SESSION_B)
    to_a = _send(thread, a).json()["row"]["id"]
    to_b = _send(thread, b).json()["row"]["id"]
    assert thread.client.post("/api/agent/thread/held", headers=SESSION_A,
                              json={"messageIds": [to_a, to_b]}).json() == {"held": [to_a]}
    rows = {r["id"]: r for r in thread.client.get("/api/canvas/thread", headers=PERSON).json()["rows"]}
    assert rows[to_a]["state"] == "held" and rows[to_b]["state"] == "sent"
    assert [r["state"] for r in _rows(thread) if r["id"] == to_a] == ["sent", "held"]
    assert thread.client.post("/api/agent/thread/held", headers=PERSON, json={"messageIds": [to_a]}).status_code == 401


def test_a_resend_with_the_same_client_id_lands_once(thread):
    a = _listen(thread)
    first = _send(thread, a, clientId="c-1").json()["row"]
    again = _send(thread, a, clientId="c-1").json()["row"]
    assert first["id"] == again["id"] and first["clientId"] == "c-1"
    assert len(thread.client.get("/api/canvas/thread", headers=PERSON).json()["rows"]) == 1
    assert thread.cap.count(a) == 1
    assert len([e for e in thread.journal._events if e["kind"] == mcp_channel.MESSAGE_KIND]) == 1


def test_text_is_checked(thread):
    a = _listen(thread)
    assert _send(thread, a, "   ").status_code == 422
    assert _send(thread, a, "x" * 2001).status_code == 422
    assert _send(thread, a, "x" * 2000).status_code == 201
    assert thread.client.post("/api/canvas/thread/messages", headers=PERSON,
                              json={"text": "hi", "to": a, "extra": 1}).status_code == 422


def test_accepted_marks_only_the_callers_own_messages(thread):
    a = _listen(thread, SESSION_A)
    b = _listen(thread, SESSION_B)
    to_a = _send(thread, a).json()["row"]["id"]
    to_b = _send(thread, b).json()["row"]["id"]
    # Session A can't mark B's, nor Codex A's.
    assert thread.client.post("/api/agent/thread/accepted", headers=SESSION_A,
                              json={"messageIds": [to_a, to_b]}).json() == {"accepted": [to_a]}
    assert thread.client.post("/api/agent/thread/accepted", headers=CODEX_TOKEN,
                              json={"messageIds": [to_b]}).json() == {"accepted": []}
    rows = {r["id"]: r for r in thread.client.get("/api/canvas/thread", headers=PERSON).json()["rows"]}
    assert rows[to_a]["state"] == "accepted" and isinstance(rows[to_a]["acceptedAt"], int)
    assert rows[to_b]["state"] == "sent"
    # An accepted message leaves the inbox.
    assert thread.client.get("/api/agent/thread/inbox", headers=SESSION_A).json()["messages"] == []
    # The person's tabs heard the change.
    assert [r["state"] for r in _rows(thread) if r["id"] == to_a] == ["sent", "accepted"]


# -- replies -------------------------------------------------------------------------------

def test_an_agent_replies_and_its_cursor_says_the_first_sentence_on_the_persons_tabs_only(thread):
    n1 = thread.graph.add_node("text-input", {"value": "a cat"})
    _listen(thread)
    text = "Done. I warmed the palette on the hero shot and kept the 1:1 crop.\nMore later."
    answer = thread.client.post("/api/canvas/thread/replies", headers=SESSION_A, json={"text": text, "nodeId": n1})
    assert answer.status_code == 201, answer.text
    reply = answer.json()["reply"]
    assert reply["kind"] == "reply" and reply["text"] == text and "session" not in reply
    # broadcast_raw(person, others=agents' form): both say the first sentence today.
    cursor = [m for m in thread.sent if m.get("type") == "agentPresence"]
    assert len(cursor) == 1 and cursor[0]["say"] == "Done." and cursor[0]["target"] == {"nodeId": n1}
    assert cursor[0]["session"]["key"]
    assert thread.raw_others[-1]["say"] == "Done." and "session" not in thread.raw_others[-1]
    replied = [e for e in thread.journal._events if e["kind"] == person_thread.REPLY_EVENT]
    assert len(replied) == 1 and replied[0]["data"] == {"replyId": reply["id"], "text": text, "nodeId": n1,
                                                     "replyTo": None}
    assert replied[0]["actor"]["kind"] == "agent"


def test_narrowed_a_reply_reaches_no_other_agent(thread, monkeypatch):
    monkeypatch.setattr(person_thread, "AGENTS_READ_WHOLE_THREAD", False)
    n1 = thread.graph.add_node("text-input", {"value": "a cat"})
    thread.client.post("/api/canvas/thread/replies", headers=SESSION_A,
                       json={"text": "Done. I warmed the palette.", "nodeId": n1})
    cursor = [m for m in thread.sent if m.get("type") == "agentPresence"]
    assert cursor[0]["say"] == "Done." and thread.raw_others[-1]["say"] == ""
    assert all(c["say"] == "" for c in thread.main.agent_presence.active())
    assert "warmed the palette" not in json.dumps(thread.others + thread.raw_others) + _journal_text(thread)


def test_replies_are_an_agents_and_checked(thread):
    assert thread.client.post("/api/canvas/thread/replies", headers=PERSON, json={"text": "hi"}).status_code == 403
    # J1 (Justin, 2026-11-04): only a Settings token replies; a name alone,
    # or nothing at all, gets the line that says what to do.
    for headers in ({}, CLAUDE):
        refused = thread.client.post("/api/canvas/thread/replies", headers=headers, json={"text": "hi"})
        assert refused.status_code == 401 and refused.json()["detail"] == person_thread.REPLY_NO_TOKEN_LINE
        assert refused.headers["X-Nebula-Code"] == "reply_no_token"
    assert thread.client.post("/api/canvas/thread/replies", headers=CLAUDE_TOKEN, json={"text": " "}).status_code == 422
    assert thread.client.post("/api/canvas/thread/replies", headers=CLAUDE_TOKEN,
                              json={"text": "hi", "nodeId": "n404"}).status_code == 422
    assert thread.client.post("/api/canvas/thread/replies", headers=CLAUDE_TOKEN, json={"text": "hi"}).status_code == 201


def test_first_sentence():
    assert person_thread.first_sentence("Done. More.") == "Done."
    assert person_thread.first_sentence("v1.2 is out! Next") == "v1.2 is out!"
    assert person_thread.first_sentence("one line\nsecond") == "one line"
    long = person_thread.first_sentence("x" * 300)
    assert len(long) == 140 and long.endswith("…")


# -- the read boundary ---------------------------------------------------------------------

def test_every_agent_reads_the_whole_thread_and_the_switch_narrows_it(thread, monkeypatch):
    a = _listen(thread, SESSION_A)
    codex = _listen(thread, CODEX_TOKEN)
    _send(thread, a, "for claude")
    _send(thread, codex, "for codex")
    thread.client.post("/api/canvas/thread/replies", headers=SESSION_A, json={"text": "claude's answer"})
    thread.client.post("/api/canvas/thread/replies", headers=CODEX_TOKEN, json={"text": "codex's answer"})
    every = ["for claude", "for codex", "claude's answer", "codex's answer"]
    person = thread.client.get("/api/canvas/thread", headers=PERSON).json()["rows"]
    assert [r["text"] for r in person] == every
    other = thread.client.get("/api/canvas/thread", headers=CODEX_TOKEN).json()["rows"]
    assert [r["text"] for r in other] == every
    assert other[0]["from"] == "person" and other[0]["toAgent"]["name"] == "Claude Code"
    assert "to" not in other[0] and "session" not in other[2]  # the person's form only
    # Anyone else gets nothing.
    assert thread.client.get("/api/canvas/thread").status_code in (401, 403)
    monkeypatch.setattr(person_thread, "AGENTS_READ_WHOLE_THREAD", False)
    claude = thread.client.get("/api/canvas/thread", headers=SESSION_B).json()["rows"]  # any of Claude's sessions
    assert [r["text"] for r in claude] == ["for claude", "claude's answer"]
    other = thread.client.get("/api/canvas/thread", headers=CODEX_TOKEN).json()["rows"]
    assert [r["text"] for r in other] == ["for codex", "codex's answer"]


def test_the_rule_is_one_switch(monkeypatch):
    message = {"kind": "message", "id": "pm_1", "text": "hi", "to": {"agent": {"id": "claude"}, "listenerId": "ch_1"}}
    reply = {"kind": "reply", "id": "pt_1", "text": "ok", "agent": {"id": "codex"}}
    pin = {"kind": "pin", "text": "warmer"}
    assert person_thread.AGENTS_READ_WHOLE_THREAD is True  # Justin, 2026-11-03
    assert all(person_thread.visible_to_agent(row, "anyone") for row in (message, reply, pin))
    assert person_thread.message_event_data(message)["text"] == "hi" and person_thread.reply_event_data(reply)
    monkeypatch.setattr(person_thread, "AGENTS_READ_WHOLE_THREAD", False)
    assert person_thread.visible_to_agent(message, "claude") and not person_thread.visible_to_agent(message, "codex")
    assert person_thread.visible_to_agent(reply, "codex") and not person_thread.visible_to_agent(reply, "claude")
    assert not person_thread.visible_to_agent(pin, "claude")
    assert person_thread.message_event_data(message) == {"to": "ch_1"}
    assert person_thread.reply_event_data(reply) == {"replyId": "pt_1", "replyTo": reply.get("replyTo")}
    assert not person_thread.say_reaches_agents()


# -- rows that point elsewhere -------------------------------------------------------------

def test_rows_that_point_elsewhere_come_only_while_that_session_listens(thread):
    n1 = thread.graph.add_node("text-input", {"value": "a cat"})
    # Not listening: an Update leaves no row.
    assert thread.client.post("/api/canvas/agent-notes", headers=SESSION_A, json={"text": "noticed"}).status_code == 201
    assert thread.client.get("/api/canvas/thread", headers=PERSON).json()["rows"] == []
    _listen(thread, SESSION_A)
    note = thread.client.post("/api/canvas/agent-notes", headers=SESSION_A, json={"text": "noticed more"})
    asked = thread.client.post("/api/canvas/questions", headers=SESSION_A,
                               json={"questions": [{"text": "All three?", "options": ["All three", "Only this one"]}]})
    assert asked.status_code == 201, asked.text
    # Another session of the same agent doesn't listen: no row for it.
    thread.client.post("/api/canvas/agent-notes", headers=SESSION_B, json={"text": "from b"})
    pin = thread.client.post("/api/canvas/pins", headers=PERSON, json={"text": "warmer", "nodeId": n1})
    assert pin.status_code == 201, pin.text
    rows = thread.client.get("/api/canvas/thread", headers=PERSON).json()["rows"]
    assert [r["kind"] for r in rows] == ["note", "question", "pin"]
    assert rows[0]["noteId"] == note.json()["note"]["id"]
    assert rows[1]["questions"][0]["options"] == ["All three", "Only this one"]
    assert rows[2]["text"] == "warmer" and rows[2]["nodeId"] == n1
    # Every agent reads them all, the pin too.
    own = thread.client.get("/api/canvas/thread", headers=CODEX_TOKEN).json()["rows"]
    assert [r["kind"] for r in own] == ["note", "question", "pin"]
    reply = thread.client.post(f"/api/canvas/pins/{pin.json()['pin']['id']}/resolve", headers=SESSION_A,
                               json={"reply": "Warmed it"})
    assert reply.status_code == 200, reply.text
    rows = thread.client.get("/api/canvas/thread", headers=PERSON).json()["rows"]
    assert rows[-1]["kind"] == "pinReply" and rows[-1]["text"] == "Warmed it"


def test_the_thread_is_kept_with_the_project_and_capped(thread, monkeypatch):
    monkeypatch.setattr(person_thread, "MAX_ROWS", 5)
    a = _listen(thread)
    ids = [_send(thread, a, f"m{n}").json()["row"]["id"] for n in range(7)]
    catalog = thread.main.project_store.read()
    kept = catalog["projects"][thread.project_id][person_thread.FIELD]
    # Messages still in flight (sent, not taken) are never trimmed (MEDIUM-2).
    assert [r["text"] for r in kept] == [f"m{n}" for n in range(7)]
    assert "personThread" not in catalog["projects"][thread.project_id]["snapshot"]
    # Once taken (accepted) they are the person's settled rows: the oldest go.
    assert thread.client.post("/api/agent/thread/accepted", headers=SESSION_A, json={"messageIds": ids}).status_code == 200
    _send(thread, a, "m7")
    kept = thread.main.project_store.read()["projects"][thread.project_id][person_thread.FIELD]
    assert [r["text"] for r in kept] == ["m3", "m4", "m5", "m6", "m7"]


def test_the_hello_sync_is_the_persons_form(thread):
    a = _listen(thread)
    _send(thread, a, clientId="c-9")
    message = thread.main._thread_sync_message()
    assert message["type"] == "personThread" and message["change"] == "sync"
    assert message["projectId"] == thread.project_id and len(message["rows"]) == 1
    assert message["rows"][0]["clientId"] == "c-9"



def test_opening_a_project_sends_its_thread(thread):
    a = _listen(thread)
    _send(thread, a, text="for this project")
    thread.browser.clear()
    asyncio.run(thread.main._broadcast_projects_changed("opened", thread.project_id))
    syncs = [m for m in thread.browser if m.get("type") == "personThread"]
    assert len(syncs) == 1 and syncs[0]["change"] == "sync"
    assert [row["text"] for row in syncs[0]["rows"]] == ["for this project"]
    thread.browser.clear()
    asyncio.run(thread.main._broadcast_projects_changed("renamed", thread.project_id))
    assert not [m for m in thread.browser if m.get("type") == "personThread"]

# -- a typed answer stays the asking agent's (GM r73 item 2, Justin's boundary rule) ------

TYPED_ANSWER = "Keep the warm one only for the hero, please"


def test_a_typed_answer_is_one_question_answered_and_never_a_thread_row_post_or_wake(thread):
    """The person's You row for a typed answer is drawn by their own tab from
    the answered set (frontend answerRows): every connected agent reads the
    thread, so the answer is never a row, a person.message, a socket field or
    a second wake. Only the asking agent reads it, through question.answered."""
    a = _listen(thread, SESSION_A)
    asked = thread.client.post("/api/canvas/questions", headers=SESSION_A, json={"questions": [
        {"text": "Use the same palette on the other three shots, or keep the warm one only for the hero?",
         "allowText": True}]})
    assert asked.status_code == 201, asked.text
    set_id = asked.json()["questions"]["id"]
    key = next(m["answerKey"] for m in thread.browser if m.get("type") == "questionsOpened")
    rows_before = thread.client.get("/api/canvas/thread", headers=PERSON).json()["rows"]
    assert [r["kind"] for r in rows_before] == ["question"]
    seq_before = max((e["seq"] for e in thread.journal._events), default=0)
    browser_before, others_before, raw_before = len(thread.browser), len(thread.others), len(thread.raw_others)

    answered = thread.client.post(f"/api/canvas/questions/{set_id}/answer", headers={**PERSON, KEY: key},
                                  json={"answers": [{"questionId": "q1", "text": TYPED_ANSWER}]})
    assert answered.status_code == 200, answered.text

    # Exactly one event: question.answered, without the words.
    new = [e for e in thread.journal._events if e["seq"] > seq_before]
    assert [e["kind"] for e in new] == [mcp_channel.ANSWERED_KIND]
    assert TYPED_ANSWER not in _journal_text(thread)
    # No new thread row, no message, nothing in an inbox. GM r79.5: the
    # question row keeps the outcome, in the person's form only.
    rows_after = thread.client.get("/api/canvas/thread", headers=PERSON).json()["rows"]
    assert [r["id"] for r in rows_after] == [r["id"] for r in rows_before]
    assert rows_after[0]["outcome"] == {"status": "answered", "closedAt": rows_after[0]["outcome"]["closedAt"],
                                        "answers": [{"questionId": "q1", "choices": [], "text": TYPED_ANSWER}]}
    later = thread.browser[browser_before:]
    # Only the person's sockets got the answer: the question row's outcome
    # and the questionsClosed that draws their row.
    assert [m["type"] for m in later if TYPED_ANSWER in json.dumps(m)] == ["personThread", "questionsClosed"]
    assert all(m["change"] == "rows" and [r["kind"] for r in m["rows"]] == ["question"]
               for m in later if m.get("type") == "personThread")
    assert TYPED_ANSWER not in json.dumps(thread.others[others_before:] + thread.raw_others[raw_before:])
    assert thread.client.get("/api/agent/thread/inbox", headers=SESSION_A).json()["messages"] == []
    # An agent's thread read (MCP read_thread and `nebula thread` call this route) never has it,
    # the asker's included (it reads its answers with get_answers).
    for headers in (SESSION_A, SESSION_B, CODEX_TOKEN):
        read = thread.client.get("/api/canvas/thread", headers=headers)
        assert read.status_code == 200 and TYPED_ANSWER not in read.text and "outcome" not in read.text
    stored = thread.main.project_store.read()["projects"][thread.project_id][person_thread.FIELD]
    assert [json.dumps(r).count(TYPED_ANSWER) for r in stored] == [1]  # the outcome, nowhere else
    # The asking agent reads it, as its own set.
    own = thread.client.get(f"/api/canvas/questions/{set_id}", headers=SESSION_A).json()
    assert own["questions"]["answers"][0]["text"] == TYPED_ANSWER

    # The listener sees those events and wakes once, with the answer.
    events = thread.client.get("/api/canvas/events", headers=SESSION_A, params={"after": seq_before}).json()
    state = mcp_channel.ChannelState(limits=mcp_channel.Limits(), now=0.0)
    state.listener_id = a
    state.tool_started("ask_person", {"questions": []}, 1.0)
    state.tool_finished("ask_person", {"questions": []}, {"questions": {"id": set_id, "status": "open"}}, 1.0)
    state.observe(events, now=20.0)
    assert not state.inbox_to_fetch()  # no message to read: no message wake
    assert state.answers_to_fetch() == [set_id]
    state.answer_fetched(set_id, own["questions"])
    pushes = [p for p in (state.take_push(20.0 + n * 0.5) for n in range(240)) if p is not None]
    assert [p.wake for p in pushes] == ["answer"]
    assert TYPED_ANSWER in pushes[0].content


# -- the MCP and CLI surface -------------------------------------------------------------

def test_the_tools_exist_everywhere_they_must():
    tools = {tool.name for tool in mcp_server.mcp._tool_manager.list_tools()}
    for name in ("reply_to_person", "read_thread"):
        assert name in tools and name in krea_agent_mcp.NEBULA_MCP_TOOLS and name in mcp_channel.CHANGE_TURN_TOOLS


def test_the_cli_parses_reply_and_thread():
    from cli.__main__ import build_parser

    parser = build_parser()
    parsed = parser.parse_args(["reply", "Done.", "--node", "n3"])
    assert (parsed.command, parsed.text, parsed.node) == ("reply", "Done.", "n3")
    assert parser.parse_args(["thread", "--limit", "5"]).limit == 5


def test_the_cli_commands_call_the_routes(capsys):
    from cli.commands import thread as thread_cmd

    calls = []

    class Client:
        def reply_to_person(self, body, agent_name=None):
            calls.append(("reply", body))
            return {"reply": {"kind": "reply", **body}}

        def get_thread(self, limit=20, agent_name=None):
            calls.append(("thread", limit))
            return {"rows": [{"kind": "message", "at": 0, "text": "warmer", "state": "accepted", "nodeIds": ["n1"]},
                             {"kind": "reply", "at": 0, "text": "Done.", "nodeId": "n1"}]}

    args = SimpleNamespace(text="Done.", node="n1", json=False, agent_name=None)
    assert thread_cmd.run_reply(Client(), args) == 0
    assert thread_cmd.run_thread(Client(), SimpleNamespace(limit=5, json=False, agent_name="Claude Code")) == 0
    assert calls == [("reply", {"text": "Done.", "nodeId": "n1"}), ("thread", 5)]
    out = capsys.readouterr().out
    assert "person [accepted]  warmer  (n1)" in out and "agent  Done.  (n1)" in out
    assert thread_cmd.run_reply(Client(), SimpleNamespace(text=" ", node=None, json=False, agent_name=None)) == 2
