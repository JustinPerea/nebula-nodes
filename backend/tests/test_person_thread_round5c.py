"""The Message box thread, round 5c (the final review of #225: the push ledger).

- MEDIUM-1: one agent's churn never evicts another's pushes, and a re-report
  counts only from the session the message was sent to.
- LOW-1: a reply after the 10-minute cap still answers its message, until the
  ledger's own bound (24 h).
- LOW-2: a message to a listener that expires, ends or stops settles as dropped.
- LOW-3: past 64 pushes in a session answered ones go first; 64 unanswered in
  span hold a new push (ledger and listener), never dropping the oldest.
- NIT-1: `nebula reply --node` says what happened when the node was ignored.
"""
from __future__ import annotations

from types import SimpleNamespace

import mcp_channel
from mcp_channel import ChannelState
from services import person_thread, push_ledger
from tests.test_canvas_proposals import Clock, api  # noqa: F401 - fixture
from tests.test_mcp_channel_deliberate import listening, sent
from tests.test_mcp_channel import take
from tests.test_person_thread import CODEX_TOKEN, SESSION_A, _listen, _send, thread  # noqa: F401
from tests.test_person_thread_round3 import _reply
from tests.test_person_thread_round5b import _accept, _message, _new_project, _open, _replies_in


def _row(thread, message_id: str) -> dict:
    for project_id in thread.main.project_store.read()["projects"]:
        for row in thread.main.thread_book.rows(project_id)[1]:
            if row["id"] == message_id:
                return row
    raise AssertionError(message_id)


# -- MEDIUM-1 --------------------------------------------------------------------------------

def test_codex_flooding_the_accepted_route_never_evicts_claudes_push(thread):
    """The reviewer's probe: 256+ made-up Codex sessions, then Claude's reply
    still goes to Coast with replyTo set, and Coast's message clears."""
    coast = thread.project_id
    a = _listen(thread, SESSION_A)
    mine = _message(thread, a, SESSION_A)
    codex = {**CODEX_TOKEN, "X-Nebula-Agent-Session": "codex-0"}
    c = _listen(thread, codex)
    theirs = _message(thread, c, codex, "hi codex")
    forest = _new_project(thread, "Forest")
    _open(thread, forest)
    for n in range(300):
        _accept(thread, {**CODEX_TOKEN, "X-Nebula-Agent-Session": f"x{n}"}, [theirs])
    answer = _reply(thread, "Warmer now.", headers=SESSION_A).json()
    assert answer["projectId"] == coast and answer["reply"]["replyTo"] == mine
    assert [r["text"] for r in _replies_in(thread, coast)] == ["Warmer now."]


def test_one_agents_churn_only_evicts_its_own_keys():
    ledger = push_ledger.PushLedger(Clock())
    ledger.record("app:claude1", "sess-a", [("m1", push_ledger.MESSAGE, "p")])
    for n in range(push_ledger.MAX_KEYS_PER_AGENT * 4):
        ledger.record("app:codex1", f"s{n}", [(f"q{n}", push_ledger.MESSAGE, "p")])
    assert ledger.peek("app:claude1", "sess-a").reply_to() == "m1"
    kept = [n for n in range(push_ledger.MAX_KEYS_PER_AGENT * 4) if ledger.peek("app:codex1", f"s{n}")]
    assert len(kept) == push_ledger.MAX_KEYS_PER_AGENT and kept[-1] == push_ledger.MAX_KEYS_PER_AGENT * 4 - 1


def test_a_re_report_counts_only_from_the_session_the_message_went_to(thread):
    a = _listen(thread, SESSION_A)
    mine = _message(thread, a, SESSION_A)
    other = {**SESSION_A, "X-Nebula-Agent-Session": "sess-other"}
    _accept(thread, other, [mine])  # the same agent, another session: records nothing
    assert thread.ledger.open_pushes("app:claude1", "sess-other") == []
    # A Nebula restart: the ledger is empty, the row says accepted, and its
    # own session reports it again (the route is stable): it counts.
    thread.main.thread_ledger.forget_agent("app:claude1")
    assert thread.ledger.peek("app:claude1", "sess-a") is None
    _accept(thread, SESSION_A, [mine])
    assert thread.ledger.peek("app:claude1", "sess-a").reply_to() == mine


# -- LOW-1 -----------------------------------------------------------------------------------

def test_a_late_reply_still_answers_its_message_in_its_project(thread):
    coast = thread.project_id
    a = _listen(thread, SESSION_A)
    mine = _message(thread, a, SESSION_A)
    _open(thread, _new_project(thread, "Forest"))
    thread.channel_clock.now += 11 * 60
    _listen(thread, SESSION_A)  # keep beating
    answer = _reply(thread, "Done, took a while.", headers=SESSION_A).json()
    assert answer["projectId"] == coast and answer["reply"]["replyTo"] == mine


def test_a_push_nobody_answered_for_a_day_is_gone():
    clock = Clock()
    ledger = push_ledger.PushLedger(clock)
    ledger.record("app:a", "s", [("m0", push_ledger.MESSAGE, "p")])
    clock.now += 11 * 60  # past the span: still pickable, but the listener is no longer told of it
    assert ledger.peek("app:a", "s").reply_to() == "m0" and ledger.open_pushes("app:a", "s") == []
    clock.now += push_ledger.KEEP_SECONDS  # past the bound
    assert ledger.peek("app:a", "s") is None


def test_a_push_after_a_gap_past_the_cap_starts_a_new_period():
    clock = Clock()
    ledger = push_ledger.PushLedger(clock)
    ledger.record("app:a", "s", [("m0", push_ledger.MESSAGE, "p")])
    clock.now += 700
    ledger.record("app:a", "s", [("m1", push_ledger.MESSAGE, "p")])
    assert ledger.peek("app:a", "s").reply_to() == "m1"


# -- LOW-2 -----------------------------------------------------------------------------------

def test_a_message_to_a_listener_that_expires_settles_as_dropped(thread):
    a = _listen(thread, SESSION_A)
    mine = _send(thread, a, "hello").json()["row"]["id"]
    thread.channel_clock.now += channel_ttl(thread) + 1
    import asyncio
    asyncio.run(thread.main._sweep_channel_listeners())
    assert _row(thread, mine)["state"] == person_thread.DROPPED_STATE


def test_a_message_to_a_listener_that_ends_or_stops_settles_as_dropped(thread):
    a = _listen(thread, SESSION_A)
    first = _send(thread, a, "one").json()["row"]["id"]
    assert thread.client.delete("/api/agent/channel", headers=SESSION_A).status_code == 200
    assert _row(thread, first)["state"] == person_thread.DROPPED_STATE
    a = _listen(thread, SESSION_A)
    second = _send(thread, a, "two").json()["row"]["id"]
    stopped = thread.client.post("/api/agent/channel", headers=SESSION_A, json={"state": "stopped", "reason": "error"})
    assert stopped.status_code == 200
    assert _row(thread, second)["state"] == person_thread.DROPPED_STATE


def test_an_accepted_message_and_another_sessions_message_stay_when_a_listener_goes(thread):
    a = _listen(thread, SESSION_A)
    taken = _message(thread, a, SESSION_A)
    other = {**SESSION_A, "X-Nebula-Agent-Session": "sess-b"}
    b = _listen(thread, other)
    waiting = _send(thread, b, "for b").json()["row"]["id"]
    assert thread.client.delete("/api/agent/channel", headers=SESSION_A).status_code == 200
    assert _row(thread, taken)["state"] == "accepted" and _row(thread, waiting)["state"] == "sent"


def channel_ttl(thread) -> float:
    from services import channel_listeners
    return channel_listeners.TTL_SECONDS


# -- LOW-3 -----------------------------------------------------------------------------------

def _push(ledger, n: int, agent="app:a", session="s"):
    return ledger.record(agent, session, [(f"m{n}", push_ledger.MESSAGE, "p")])


def test_past_64_answered_pushes_go_first_and_the_oldest_unanswered_stays():
    clock = Clock()
    ledger = push_ledger.PushLedger(clock)
    for n in range(push_ledger.MAX_PUSHES):
        assert _push(ledger, n)
    answered = ledger.claim("app:a", "s", lambda _p: True, "t")
    ledger.settle(answered, "t", "pt_1")  # m0 answered
    assert _push(ledger, 100)  # m0 goes, not m1
    assert ledger.peek("app:a", "s").reply_to() == "m1"
    assert [p["ids"] for p in ledger.open_pushes("app:a", "s")][-1] == ["m100"]


def test_64_unanswered_pushes_in_span_hold_a_new_one_never_dropping_the_oldest():
    ledger = push_ledger.PushLedger(Clock())
    for n in range(push_ledger.MAX_PUSHES):
        assert _push(ledger, n)
    assert not _push(ledger, 100)
    assert ledger.peek("app:a", "s").reply_to() == "m0"
    assert len(ledger.open_pushes("app:a", "s")) == push_ledger.MAX_PUSHES


def test_unanswered_pushes_past_the_span_make_room_oldest_first():
    clock = Clock()
    ledger = push_ledger.PushLedger(clock)
    for n in range(push_ledger.MAX_PUSHES):
        _push(ledger, n)
    clock.now += 700
    assert _push(ledger, 100)


def test_the_listener_holds_a_push_at_64_open_ones_and_sends_it_when_one_is_answered():
    assert mcp_channel.MAX_OPEN_PUSHES == push_ledger.MAX_PUSHES
    state: ChannelState = listening()
    for n in range(1, mcp_channel.MAX_OPEN_PUSHES + 1):
        sent(state, n, float(n))
        assert take(state, float(n)) is not None
    sent(state, 65, 65.0)
    assert take(state, 65.0) is None  # held, not pushed in place of the oldest
    assert len(state._open_groups) == mcp_channel.MAX_OPEN_PUSHES
    due = state.next_check(65.0)
    assert due is not None and due > 1.0  # waits for the span's end, no busy loop
    assert state.messages_held(66.0) == ["msg_65"]
    assert state.tool_started("reply_to_person", {"text": "Done."}, 66.0) is None
    state.tool_finished("reply_to_person", {"text": "Done."}, {"reply": {"id": "pt_1", "replyTo": "msg_1"}}, 66.0)
    late = take(state, 67.0)
    assert late is not None and "msg_65" in "".join(late.message_ids)


# -- NIT-1 -----------------------------------------------------------------------------------

def test_nebula_reply_node_says_the_node_was_ignored_when_it_was(capsys):
    from cli.commands import thread as thread_cmd

    note = "Nebula kept your reply in “Coast”, so your cursor stayed where it was."

    class Elsewhere:
        def reply_to_person(self, body, agent_name=None):
            return {"projectId": "p", "reply": {"id": "pt", "nodeId": None}, "note": note}

    class Here:
        def reply_to_person(self, body, agent_name=None):
            return {"projectId": "p", "reply": {"id": "pt", "nodeId": "n3"}}

    args = SimpleNamespace(text="Done.", node="n3", json=False, agent_name=None)
    assert thread_cmd.run_reply(Elsewhere(), args) == 0
    out = capsys.readouterr()
    assert "Your cursor went" not in out.out and note in out.out
    assert thread_cmd.run_reply(Here(), args) == 0
    assert "Your cursor went to n3." in capsys.readouterr().out


def json_of(thread, message_id: str) -> str:
    import json
    return json.dumps(person_thread.agent_view(_row(thread, message_id)))


def test_a_dropped_message_comes_back_when_the_same_session_returns_but_not_another(thread):
    a = _listen(thread, SESSION_A)
    mine = _send(thread, a, "while you were away").json()["row"]["id"]
    thread.channel_clock.now += channel_ttl(thread) + 1
    import asyncio
    asyncio.run(thread.main._sweep_channel_listeners())
    assert _row(thread, mine)["state"] == person_thread.DROPPED_STATE
    assert "lapsed" not in json_of(thread, mine)  # server only
    _listen(thread, {**SESSION_A, "X-Nebula-Agent-Session": "sess-new"})
    assert _row(thread, mine)["state"] == person_thread.DROPPED_STATE  # a new session never takes it
    assert _listen(thread, SESSION_A) == a
    assert _row(thread, mine)["state"] == "sent"
    inbox = thread.client.get("/api/agent/thread/inbox", headers=SESSION_A).json()["messages"]
    assert [m["messageId"] for m in inbox] == [mine]
