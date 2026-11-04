"""The Message box thread, round 3 (review 1 of #225 and GM r79).

- MEDIUM-2: the person's messages still in flight are never trimmed (agent
  rows go first), and reply_to_person is paced per agent (5 in a row, then
  one every 2 s), refused with a line saying when it can reply again.
- MEDIUM-1: a question row's text is the asker's; no agent reads the
  person's answer in the thread (GM r79.5 keeps it there, person form only).
- GM r79.6: an answer racing a withdrawal is refused; nothing goes out.
- The LOWs: a stable listener id (its messages survive a lapse; #223 tests eviction),
  replyTo, an unnamed reader's line, `nebula channel`, and the mutation
  survivors (hold never reopens an accepted row, no clientId for agents, the
  read limit, the nodeIds cap, unknown reply fields, pin rows only while
  someone listens, pin text in agents' form).
"""
from __future__ import annotations

import json
import re
from types import SimpleNamespace

import pytest

import mcp_channel
from services import channel_listeners, person_thread
from tests.conftest import PERSON
from tests.test_canvas_proposals import CLAUDE, CODEX, KEY, Clock  # noqa: F401
from tests.test_canvas_proposals import api  # noqa: F401 - fixture
from tests.test_person_thread import SESSION_A, SESSION_B, _listen, _send, thread  # noqa: F401 - fixture


@pytest.fixture
def paced(thread, monkeypatch):  # noqa: F811
    clock = Clock()
    pace = person_thread.ReplyPace(clock)
    monkeypatch.setattr(thread.main, "thread_reply_pace", pace)
    thread.pace_clock = clock
    return thread


def _reply(api, text="Done.", headers=SESSION_A, **body):
    return api.client.post("/api/canvas/thread/replies", headers=headers, json={"text": text, **body})


def _person_rows(api):
    return api.client.get("/api/canvas/thread", headers=PERSON, params={"limit": 300}).json()["rows"]


# -- MEDIUM-2: trimming and the reply pace ------------------------------------------------

def test_trim_drops_agent_rows_first_then_settled_rows_never_one_in_flight():
    rows = [{"id": "m0", "kind": "message", "state": "sent"}, {"id": "r0", "kind": "reply"},
            {"id": "m1", "kind": "message", "state": "accepted"}, {"id": "p0", "kind": "pin"},
            {"id": "q0", "kind": "question"}, {"id": "m2", "kind": "message", "state": "held"},
            {"id": "r1", "kind": "reply"}]
    person_thread.trim(rows, limit=4)
    assert [r["id"] for r in rows] == ["m0", "m1", "p0", "m2"]  # every agent row went first
    person_thread.trim(rows, limit=2)
    assert [r["id"] for r in rows] == ["m0", "m2"]  # then the settled ones, oldest first
    person_thread.trim(rows, limit=1)
    assert [r["id"] for r in rows] == ["m0", "m2"]  # in flight: kept over the cap


def test_a_looping_agent_never_pushes_out_the_persons_message(paced, monkeypatch):
    monkeypatch.setattr(person_thread, "MAX_ROWS", 20)
    a = _listen(paced, SESSION_A)
    sent = _send(paced, a, "the one that matters").json()["row"]
    accepted_ids = []
    for n in range(3):
        accepted_ids.append(_send(paced, a, f"read {n}").json()["row"]["id"])
    paced.client.post("/api/agent/thread/accepted", headers=SESSION_A, json={"messageIds": accepted_ids})
    statuses = []
    for n in range(60):  # Codex replies in a loop, as fast as the pace lets it
        paced.pace_clock.now += 2.0
        statuses.append(_reply(paced, f"loop {n}", headers=CODEX).status_code)
    assert set(statuses) == {201}
    rows = _person_rows(paced)
    assert len(rows) == 20
    # The message still in flight and the person's settled ones are all kept.
    assert [r["text"] for r in rows if r["kind"] == "message"] == ["the one that matters", "read 0", "read 1", "read 2"]
    inbox = paced.client.get("/api/agent/thread/inbox", headers=SESSION_A).json()["messages"]
    assert [m["messageId"] for m in inbox] == [sent["id"]]


def test_replies_are_paced_per_agent_with_a_line_saying_when(paced):
    codes = [_reply(paced, f"r{n}").status_code for n in range(5)]
    assert codes == [201] * 5
    refused = _reply(paced, "one too many")
    assert refused.status_code == 429 and refused.headers["Retry-After"] == "2"
    body = refused.json()
    assert body["code"] == person_thread.REPLY_LIMITED_CODE and body["retryAfter"] == 2
    assert body["detail"] == ("Too many replies at once: you can reply again in 2 s. Replies are paced at 5 in a "
                              "row, then one every 2 s, so put everything you have to say in one reply.")
    assert "one too many" not in json.dumps(_person_rows(paced))  # nothing saved
    # Another agent has its own pace.
    assert _reply(paced, "from codex", headers=CODEX).status_code == 201
    # One more every 2 s.
    paced.pace_clock.now += 1.0
    assert _reply(paced, "too soon").json()["retryAfter"] == 1
    paced.pace_clock.now += 1.0
    assert _reply(paced, "now").status_code == 201
    assert _reply(paced, "and again").status_code == 429
    # A malformed reply doesn't spend one.
    paced.pace_clock.now += 2.0
    assert _reply(paced, " ").status_code == 422
    assert _reply(paced, "fine").status_code == 201


def test_the_pace_forgets_the_least_recent_agent_past_its_cap():
    clock = Clock()
    pace = person_thread.ReplyPace(clock, burst=1, every=10.0, max_agents=2)
    assert pace.take("a") == 0 and pace.take("a") == pytest.approx(10.0)
    pace.take("b")
    pace.take("c")  # a goes (it starts full again)
    assert pace.take("a") == 0


# -- MEDIUM-1 and GM r79.5: questions stay the asker's --------------------------------------

def _ask(api, headers=SESSION_A, questions=None):
    asked = api.client.post("/api/canvas/questions", headers=headers, json={"questions": questions or [
        {"text": "SECRET-QUESTION about the client brief?", "options": ["Warm", "Cool"]}]})
    assert asked.status_code == 201, asked.text
    key = next(m["answerKey"] for m in reversed(api.browser) if m.get("type") == "questionsOpened")
    return asked.json()["questions"]["id"], key


def test_only_the_asker_reads_a_question_rows_text(thread):
    _listen(thread, SESSION_A)
    set_id, _ = _ask(thread)
    codex = thread.client.get("/api/canvas/thread", headers=CODEX).json()["rows"]
    assert [(r["kind"], r["questionId"], r["agent"]["name"]) for r in codex] == [("question", set_id, "Claude Code")]
    assert "questions" not in codex[0] and "SECRET-QUESTION" not in json.dumps(codex)
    own = thread.client.get("/api/canvas/thread", headers=SESSION_B).json()["rows"]  # the same agent, another session
    assert own[0]["questions"][0]["text"] == "SECRET-QUESTION about the client brief?"
    assert _person_rows(thread)[0]["questions"][0]["options"] == ["Warm", "Cool"]
    # As the questions route: another agent's set isn't there for it.
    assert thread.client.get(f"/api/canvas/questions/{set_id}", headers=CODEX).status_code == 404
    # The journal never had it either.
    assert "SECRET-QUESTION" not in json.dumps(list(thread.journal._events))
    view = person_thread.agent_view({"kind": "question", "questionId": "qs_1", "questions": [{"text": "x"}],
                                     "agent": {"id": "ext:a"}, "outcome": {"status": "answered"}})
    assert "questions" not in view and "outcome" not in view  # no viewer: no text


def test_a_closed_question_keeps_its_outcome_for_the_person_only(thread):
    _listen(thread, SESSION_A)
    picked, key = _ask(thread)
    answered = thread.client.post(f"/api/canvas/questions/{picked}/answer", headers={**PERSON, KEY: key},
                                  json={"answers": [{"questionId": "q1", "choices": ["Warm"]}]})
    assert answered.status_code == 200, answered.text
    withdrawn, _ = _ask(thread)
    assert thread.client.delete(f"/api/canvas/questions/{withdrawn}", headers=SESSION_A).status_code == 200
    dismissed, key3 = _ask(thread)
    assert thread.client.post(f"/api/canvas/questions/{dismissed}/dismiss", headers={**PERSON, KEY: key3}).status_code == 200
    rows = {r["questionId"]: r for r in _person_rows(thread)}
    assert rows[picked]["outcome"]["status"] == "answered"
    assert rows[picked]["outcome"]["answers"] == [{"questionId": "q1", "choices": ["Warm"], "text": None}]
    assert isinstance(rows[picked]["outcome"]["closedAt"], int)
    assert rows[withdrawn]["outcome"] == {"status": "withdrawn", "closedAt": rows[withdrawn]["outcome"]["closedAt"]}
    assert rows[dismissed]["outcome"]["status"] == "dismissed"
    for headers in (SESSION_A, CODEX):
        assert "outcome" not in thread.client.get("/api/canvas/thread", headers=headers).text
    # Kept with the project: a reload reads it back (the hello sync).
    sync = thread.main._thread_sync_message()
    assert {r["questionId"]: r["outcome"]["status"] for r in sync["rows"]} == {
        picked: "answered", withdrawn: "withdrawn", dismissed: "dismissed"}


def test_an_answer_racing_a_withdrawal_is_refused_and_nothing_goes_out(thread):
    """GM r79.6: the agent withdraws while the person types; their send is
    refused, no message, no wake, no row."""
    a = _listen(thread, SESSION_A)
    set_id, key = _ask(thread, questions=[{"text": "Which palette?", "allowText": True}])
    assert thread.client.delete(f"/api/canvas/questions/{set_id}", headers=SESSION_A).status_code == 200
    seq = max(e["seq"] for e in thread.journal._events)
    rows_before = _person_rows(thread)
    late = thread.client.post(f"/api/canvas/questions/{set_id}/answer", headers={**PERSON, KEY: key},
                              json={"answers": [{"questionId": "q1", "text": "the warm one"}]})
    assert late.status_code == 409 and "withdrawn" in late.json()["detail"]
    assert [e for e in thread.journal._events if e["seq"] > seq] == []
    assert _person_rows(thread) == rows_before
    assert thread.client.get("/api/agent/thread/inbox", headers=SESSION_A).json()["messages"] == []
    assert "the warm one" not in json.dumps(thread.browser + thread.others)
    assert a


# -- the LOWs -------------------------------------------------------------------------------

def test_a_listener_keeps_its_id_through_a_lapse_and_its_messages_still_reach_it(thread):
    a = _listen(thread, SESSION_A)
    row = _send(thread, a, "while you were away").json()["row"]
    thread.channel_clock.now += channel_listeners.TTL_SECONDS + 1
    assert thread.channel.entries() == []
    assert _listen(thread, SESSION_A) == a
    inbox = thread.client.get("/api/agent/thread/inbox", headers=SESSION_A).json()["messages"]
    assert [m["messageId"] for m in inbox] == [row["id"]]
    assert _listen(thread, SESSION_B) != a  # another session, another id


def test_a_reply_names_the_message_it_followed(thread):
    a = _listen(thread, SESSION_A)
    first = _send(thread, a, "first").json()["row"]["id"]
    second = _send(thread, a, "second").json()["row"]["id"]
    assert _reply(thread, "nothing taken yet").json()["reply"]["replyTo"] is None
    thread.client.post("/api/agent/thread/accepted", headers=SESSION_A, json={"messageIds": [first]})
    assert _reply(thread, "about the first").json()["reply"]["replyTo"] == first
    thread.client.post("/api/agent/thread/accepted", headers=SESSION_A, json={"messageIds": [second]})
    # Another session's reply follows none of A's messages.
    assert _reply(thread, "from b", headers=SESSION_B).json()["reply"]["replyTo"] is None
    assert _reply(thread, "about the second").json()["reply"]["replyTo"] == second


def test_an_unnamed_agent_reading_the_thread_is_told_to_name_itself(thread):
    unnamed = thread.client.get("/api/canvas/thread", headers={"X-Nebula-Client": "cli"})
    assert unnamed.status_code == 400 and "NEBULA_AGENT_NAME" in unnamed.json()["detail"]
    assert thread.client.get("/api/canvas/thread").status_code == 403  # anonymous: still the person's


def test_hold_never_reopens_an_accepted_message(thread):
    a = _listen(thread, SESSION_A)
    row = _send(thread, a).json()["row"]
    thread.client.post("/api/agent/thread/accepted", headers=SESSION_A, json={"messageIds": [row["id"]]})
    held = thread.client.post("/api/agent/thread/held", headers=SESSION_A, json={"messageIds": [row["id"]]})
    assert held.json()["held"] == []
    assert _person_rows(thread)[0]["state"] == "accepted"


def test_agents_never_read_a_client_id_and_the_limit_counts(thread):
    a = _listen(thread, SESSION_A)
    for n in range(4):
        _send(thread, a, f"m{n}", clientId=f"c-{n}")
    read = thread.client.get("/api/canvas/thread", headers=CODEX, params={"limit": 2}).json()["rows"]
    assert [r["text"] for r in read] == ["m2", "m3"] and "clientId" not in json.dumps(read)
    assert [r["text"] for r in thread.client.get("/api/canvas/thread", headers=PERSON,
                                                 params={"limit": 3}).json()["rows"]] == ["m1", "m2", "m3"]


def test_a_message_keeps_at_most_20_nodes(thread):
    ids = [thread.graph.add_node("text-input", {"value": str(n)}) for n in range(22)]
    a = _listen(thread, SESSION_A)
    row = _send(thread, a, nodeIds=ids).json()["row"]
    assert row["nodeIds"] == ids[:20]


def test_a_reply_refuses_unknown_fields(thread):
    refused = _reply(thread, "Done.", to="someone")
    assert refused.status_code == 422 and "unknown field 'to'" in refused.json()["detail"]


def test_a_person_pin_adds_a_row_only_while_a_session_listens_and_agents_read_its_agent_form(thread):
    n1 = thread.graph.add_node("text-input", {"value": "a cat"})
    assert thread.client.post("/api/canvas/pins", headers=PERSON, json={"text": "first", "nodeId": n1}).status_code == 201
    assert _person_rows(thread) == []
    _listen(thread, SESSION_A)
    text = "warmer ❤️ and 葛\U000e0100"
    assert thread.client.post("/api/canvas/pins", headers=PERSON, json={"text": text, "nodeId": n1}).status_code == 201
    agents = thread.client.get("/api/canvas/thread", headers=CODEX).json()["rows"]
    pins = thread.client.get("/api/canvas/pins", headers=CODEX).json()["pins"]
    listed = next(p["text"] for p in pins if p["text"].startswith("warmer"))
    assert agents[-1]["kind"] == "pin" and agents[-1]["text"] == listed  # GM r23: the agents' form
    assert "️" not in agents[-1]["text"]


def test_the_gated_turn_names_reply_to_person():
    state = mcp_channel.ChannelState(now=0.0)
    state._window_at = 0.0
    refusal = state.tool_started("edit_canvas", {}, 1.0)
    assert refusal and "reply to the person (reply_to_person)" in refusal
    assert state.tool_started("reply_to_person", {}, 2.0) is None
    assert "reply_to_person" in mcp_channel.INSTRUCTIONS
    assert "reply_to_person" in state._render("change", [], 0, [], [], [], [], [], [], [], set(), 0, held=0,
                                              now=3.0, gate=True, nth=1)


def test_nebula_channel_prints_your_listeners(capsys):
    from cli.__main__ import build_parser
    from cli.commands import thread as thread_cmd

    parsed = build_parser().parse_args(["channel", "--json", "--as", "Claude Code"])
    assert (parsed.command, parsed.json, parsed.agent_name) == ("channel", True, "Claude Code")

    class Client:
        def __init__(self, listeners):
            self.listeners = listeners

        def get_channel(self, agent_name=None):
            return {"projectId": "p", "listeners": self.listeners}

    entry = {"listenerId": "ch_0123456789abcdef", "state": "stopped", "reason": "idle", "since": 0, "seenAt": 0}
    assert thread_cmd.run_channel(Client([entry]), SimpleNamespace(json=False, agent_name=None)) == 0
    assert thread_cmd.run_channel(Client([]), SimpleNamespace(json=False, agent_name=None)) == 0
    out = capsys.readouterr().out
    assert "ch_0123456789abcdef  stopped (idle)" in out
    assert "No listener of yours: Nebula doesn't count you as connected" in out


# -- GM r79.2: an edit with no note is logged in the person's words ----------------------------

def _presence(api):
    return [m for m in api.sent + api.browser if m.get("type") == "agentPresence"]


def test_an_edit_with_no_note_logs_the_persons_words_never_the_terse_summary(thread):
    n1 = thread.graph.add_node("text-input", {"value": "a cat"})
    thread.client.post("/api/graph/apply", headers=CLAUDE, json={"rename": {n1: "Hero shot"}})
    n2 = thread.graph.add_node("text-input", {"value": "a dog"})
    before = len(_presence(thread))
    edited = thread.client.post("/api/graph/apply", headers=CLAUDE,
                                json={"params": [{"nodeId": n1, "params": {"value": "a warmer cat"}}]})
    assert edited.status_code == 200, edited.text
    event = _presence(thread)[before:][-1]
    assert event["say"] == "changed 1"  # the bubble keeps the summary
    label = thread.main._card_label(thread.main.node_registry.get("text-input") or {}, thread.graph.nodes[n1], "value")
    assert event["log"] == f"Changed “{label}” on “Hero shot”"
    before = len(_presence(thread))
    thread.client.post("/api/graph/apply", headers=CLAUDE,
                       json={"params": [{"nodeId": n1, "params": {"value": "x"}}, {"nodeId": n2, "params": {"value": "y"}}]})
    assert _presence(thread)[before:][-1]["log"].endswith(" and 1 more node")
    noted = thread.client.post("/api/graph/apply", headers=CLAUDE,
                               json={"note": "Cooler sky", "params": [{"nodeId": n1, "params": {"value": "z"}}]})
    assert noted.status_code == 200 and _presence(thread)[-1]["say"] == "Cooler sky" and "log" not in _presence(thread)[-1]
    assert not any(re.search(r"\b(changed|moved) \d", e.get("log") or "") for e in _presence(thread))
