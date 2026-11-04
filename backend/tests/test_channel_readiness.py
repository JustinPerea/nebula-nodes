"""Channel readiness (services/channel_listeners.py): whether a Claude Code
session listens to the canvas, per agent session, for the Message box's lines
(GM r50: "not connected" and "listener stopped" are separate states).

A --channel listener posts POST /api/agent/channel while it runs and deletes
its entry when its session ends; one that goes quiet past the TTL is gone.
The person's tabs get every listener (with its cursor's key and number) in a
channelListeners message on each change and after a verified hello; an agent
reads only its own entries (GET /api/canvas/channel, MCP channel_status).
"""
from __future__ import annotations

import pytest

import mcp_server
from nebula_api import NebulaAPI
from services import app_tokens, channel_listeners
from services.agent_presence import AgentIdentity
from tests.conftest import PERSON
from tests.test_canvas_proposals import CLAUDE, CODEX, Clock, api  # noqa: F401 - fixture

# Only an agent token registers a listener (Justin, 2026-11-03): two
# Settings tokens, as `nebula mcp connect claude-code --channel` saves them.
TOKENS = {"tok-claude": {"id": "claude1", "name": "Claude Code", "color": "#C3E86B"},
          "tok-codex": {"id": "codex1", "name": "Codex", "color": "#7AA2F7"}}
CLAUDE_TOKEN = {"Authorization": "Agent tok-claude"}
CODEX_TOKEN = {"Authorization": "Agent tok-codex"}
SESSION_A = {**CLAUDE_TOKEN, "X-Nebula-Agent-Session": "sess-a"}
SESSION_B = {**CLAUDE_TOKEN, "X-Nebula-Agent-Session": "sess-b"}


@pytest.fixture
def ready(api, monkeypatch):  # noqa: F811 - the imported fixture
    monkeypatch.setattr(app_tokens, "lookup", lambda token: TOKENS.get(token))
    clock = Clock()
    book = channel_listeners.ListenerBook(clock)
    monkeypatch.setattr(api.main, "channel_book", book)
    api.channel_clock = clock
    api.channel = book
    return api


def _beat(api, headers=SESSION_A, **body):
    return api.client.post("/api/agent/channel", headers=headers, json={"state": "listening", **body})


def _messages(api):
    return [m for m in api.browser if m.get("type") == "channelListeners"]


def test_a_listener_is_listening_stopped_or_not_connected(ready):
    # Not connected: nothing has said it listens.
    seen = ready.client.get("/api/canvas/channel", headers=PERSON).json()
    assert seen["listeners"] == [] and seen["projectId"] == ready.project_id
    answer = _beat(ready, projectId=ready.project_id)
    assert answer.status_code == 200, answer.text
    listener = answer.json()["listener"]
    assert listener["state"] == "listening" and listener["reason"] is None
    assert listener["listenerId"].startswith("ch_") and listener["agent"]["name"] == "Claude Code"
    assert "session" not in listener  # the agent's form never carries cursor keys
    assert answer.json()["beatSeconds"] == channel_listeners.BEAT_SECONDS
    person = ready.client.get("/api/canvas/channel", headers=PERSON).json()["listeners"]
    assert [(entry["state"], entry["listenerId"]) for entry in person] == [("listening", listener["listenerId"])]
    assert set(person[0]["session"]) == {"key", "ordinal"} and "sess-a" not in str(person)
    # The listener stopped (2 h idle): the session still runs, the state says so.
    stopped = _beat(ready, state="stopped", reason="idle").json()["listener"]
    assert stopped["state"] == "stopped" and stopped["reason"] == "idle"
    assert stopped["listenerId"] == listener["listenerId"]
    # The session ended: not connected again.
    assert ready.client.delete("/api/agent/channel", headers=SESSION_A).json() == {"listener": None}
    assert ready.client.get("/api/canvas/channel", headers=PERSON).json()["listeners"] == []


def test_each_agent_session_is_its_own_listener(ready):
    a = _beat(ready, SESSION_A).json()["listener"]
    b = _beat(ready, SESSION_B).json()["listener"]
    codex = _beat(ready, CODEX_TOKEN).json()["listener"]
    assert len({a["listenerId"], b["listenerId"], codex["listenerId"]}) == 3
    person = ready.client.get("/api/canvas/channel", headers=PERSON).json()["listeners"]
    assert len(person) == 3 and len({entry["session"]["key"] for entry in person}) == 3
    # An agent reads only its own entries: both of Claude's sessions, not Codex's.
    own = ready.client.get("/api/canvas/channel", headers=SESSION_A).json()["listeners"]
    assert {entry["listenerId"] for entry in own} == {a["listenerId"], b["listenerId"]}
    assert all("session" not in entry for entry in own)
    # A beat again keeps its id.
    assert _beat(ready, SESSION_A).json()["listener"]["listenerId"] == a["listenerId"]


def test_a_listener_that_goes_quiet_is_not_connected(ready):
    _beat(ready)
    ready.channel_clock.now += channel_listeners.TTL_SECONDS - 1
    assert len(ready.client.get("/api/canvas/channel", headers=PERSON).json()["listeners"]) == 1
    ready.channel_clock.now += 2
    assert ready.client.get("/api/canvas/channel", headers=PERSON).json()["listeners"] == []


def test_the_persons_tabs_hear_each_change_and_only_changes(ready):
    _beat(ready)
    _beat(ready)  # the same state again: nothing new for the tabs
    _beat(ready, state="stopped", reason="error")
    ready.client.delete("/api/agent/channel", headers=SESSION_A)
    shown = [[entry["state"] for entry in m["listeners"]] for m in _messages(ready)]
    assert shown == [["listening"], ["stopped"], []]
    assert all(m["projectId"] == ready.project_id for m in _messages(ready))
    # Only the person's sockets get it (broadcast_browser), never agents'.
    assert not [m for m in ready.sent if m.get("type") == "channelListeners"]


def test_a_quiet_listeners_expiry_reaches_the_tabs(ready):
    import anyio

    _beat(ready)
    ready.channel_clock.now += channel_listeners.TTL_SECONDS + 1
    anyio.run(ready.main._sweep_channel_listeners)
    assert _messages(ready)[-1]["listeners"] == []


NO_TOKEN_LINE = ("Nebula couldn’t connect this listener because it has no token. Copy one from Settings › Connect "
                 "your agent, then run this command again.")
BAD_TOKEN_LINE = ("Nebula couldn’t connect this listener because its token isn’t valid anymore. Copy a new one from "
                  "Settings › Connect your agent, then run this command again.")


def test_only_an_agent_token_registers_a_listener(ready):
    """Justin, 2026-11-03: a name alone (tokenless) can't register, so the
    person's messages never reach it; GM r81's lines say why."""
    for headers in (CLAUDE, {**CLAUDE, "X-Nebula-Agent-Session": "sess-a"}, PERSON, {}):
        refused = ready.client.post("/api/agent/channel", headers=headers, json={"state": "listening"})
        assert refused.status_code == 401 and refused.json()["detail"] == NO_TOKEN_LINE
        assert refused.headers["X-Nebula-Code"] == "listener_no_token"
    revoked = ready.client.post("/api/agent/channel", headers={**CLAUDE, "Authorization": "Agent gone"},
                                json={"state": "listening"})
    assert revoked.status_code == 401 and revoked.json()["detail"] == BAD_TOKEN_LINE
    assert revoked.headers["X-Nebula-Code"] == "listener_token_invalid"
    assert ready.client.delete("/api/agent/channel", headers=CLAUDE).status_code == 401
    assert ready.channel.entries() == [] and _messages(ready) == []
    # A token registers as its own agent: a name beside it changes nothing.
    as_other = ready.client.post("/api/agent/channel", headers={**CODEX_TOKEN, "X-Nebula-Agent": "Claude Code"},
                                 json={"state": "listening"})
    assert as_other.status_code == 200 and as_other.json()["listener"]["agent"]["name"] == "Codex"
    assert as_other.json()["listener"]["agent"]["id"] == "app:codex1"
    assert ready.client.get("/api/canvas/channel", headers=CLAUDE_TOKEN).json()["listeners"] == []


IN_APP_LINE = ("Nebula couldn’t connect this listener because it uses an in-app agent’s token, and only a token "
               "from Settings › Connect your agent can listen. Copy one there, then run this command again.")


def test_an_in_app_agents_turn_token_never_registers_a_listener(ready, monkeypatch):
    """J3 (Justin, 2026-11-04; boundary LOW-3): an in-app agent's turn token
    is verified, but only a Settings app token listens."""
    from commons.actors import agent_registry
    monkeypatch.setattr(agent_registry, "lookup", lambda token: {"runner": "claude", "session": "chat1"}
                        if token == "tok-inapp" else None)
    in_app = {"Authorization": "Agent tok-inapp", "X-Nebula-Agent-Session": "sess-a"}
    for call in (lambda: ready.client.post("/api/agent/channel", headers=in_app, json={"state": "listening"}),
                 lambda: ready.client.delete("/api/agent/channel", headers=in_app)):
        refused = call()
        assert refused.status_code == 401 and refused.json()["detail"] == IN_APP_LINE
        assert refused.headers["X-Nebula-Code"] == "listener_in_app_token"
    assert ready.channel.entries() == [] and _messages(ready) == []
    assert _beat(ready).status_code == 200  # a Settings token still registers


def test_revoking_a_token_drops_its_listeners_at_once(ready, monkeypatch):
    """Boundary LOW-1: the revoke route drops that app's entries and tells
    the person's tabs, not 45 s later at the TTL."""
    monkeypatch.setattr(app_tokens, "valid_id", lambda app_id: app_id.isalnum())
    monkeypatch.setattr(ready.main.app_token_store, "revoke", lambda app_id: app_id == "claude1")
    _beat(ready)
    _beat(ready, SESSION_B)
    _beat(ready, CODEX_TOKEN)
    before = len(_messages(ready))
    answer = ready.client.delete("/api/agent/spend/apps/claude1", headers=PERSON)
    assert answer.status_code == 200, answer.text
    assert [e.agent.id for e in ready.channel.entries()] == ["app:codex1"]
    sent = _messages(ready)
    assert len(sent) == before + 1 and [e["agent"]["id"] for e in sent[-1]["listeners"]] == ["app:codex1"]
    # Nothing of another app's goes, and an unknown app changes nothing.
    assert ready.client.delete("/api/agent/spend/apps/nobody", headers=PERSON).status_code == 404
    assert len(_messages(ready)) == before + 1


def test_a_listener_keeps_its_id_through_a_lapse(ready):
    first = _beat(ready).json()["listener"]["listenerId"]
    ready.channel_clock.now += channel_listeners.TTL_SECONDS + 1
    assert ready.channel.entries() == []
    assert _beat(ready).json()["listener"]["listenerId"] == first
    assert _beat(ready, SESSION_B).json()["listener"]["listenerId"] != first


def test_one_agent_holds_at_most_its_own_cap_of_entries(monkeypatch):
    monkeypatch.setattr(channel_listeners, "MAX_PER_AGENT", 2)
    clock = Clock()
    book = channel_listeners.ListenerBook(clock)
    codex, _ = book.beat(AgentIdentity("app:codex1", "Codex", "#000000", True), "x", state="listening",
                         reason=None, project_id=None)
    for n in range(4):
        clock.now += 1
        book.beat(AgentIdentity("app:claude1", "Claude Code", "#000000", True), f"s{n}", state="listening",
                  reason=None, project_id=None)
    assert sorted(e.session for e in book.entries() if e.agent.name == "Claude Code") == ["s2", "s3"]
    assert codex in book.entries()


def test_only_an_agent_reports_and_only_the_person_or_an_agent_reads(ready):
    assert ready.client.post("/api/agent/channel", headers=PERSON, json={"state": "listening"}).status_code == 401
    assert ready.client.post("/api/agent/channel", json={"state": "listening"}).status_code == 401
    assert _beat(ready, state="asleep").status_code == 422
    assert ready.client.post("/api/agent/channel", headers=SESSION_A, json=[1]).status_code == 422
    # An anonymous read (no person token, no agent name) is refused.
    assert ready.client.get("/api/canvas/channel").status_code in (401, 403)


def test_a_stopped_reason_is_idle_or_error():
    assert channel_listeners.parse_beat({"state": "stopped", "reason": "idle"}) == ("stopped", "idle", None)
    assert channel_listeners.parse_beat({"state": "stopped", "reason": "bored"})[1] == "error"
    assert channel_listeners.parse_beat({"state": "listening", "reason": "idle"})[1] is None
    assert channel_listeners.parse_beat({"state": "listening", "projectId": "x" * 500})[2] is None


def test_the_book_keeps_at_most_its_cap():
    clock = Clock()
    book = channel_listeners.ListenerBook(clock)
    for n in range(channel_listeners.MAX_LISTENERS + 5):
        clock.now += 0.01
        book.beat(AgentIdentity(f"app:a{n}", "A", "#000000", True), None, state="listening", reason=None,
                  project_id=None)
    entries = book.entries()
    assert len(entries) == channel_listeners.MAX_LISTENERS and entries[0].agent.id == "app:a5"
    assert book.by_listener_id(entries[-1].listener_id) is entries[-1]


# -- MCP parity: channel_status -----------------------------------------------------------

@pytest.fixture
def tools(ready, monkeypatch):
    monkeypatch.delenv("NEBULA_AGENT_TOKEN", raising=False)
    monkeypatch.setenv("NEBULA_APP_TOKEN", "tok-claude")
    monkeypatch.setenv("NEBULA_AGENT_NAME", "Claude Code")
    monkeypatch.setattr(mcp_server, "_api", lambda: NebulaAPI("http://testserver", client=ready.client))
    return ready


def test_channel_status_says_whether_this_server_listens_and_what_nebula_sees(tools, monkeypatch):
    shown = mcp_server.channel_status()
    assert shown["thisServer"] == {"channel": False, "state": None} and shown["listeners"] == []
    session = {**CLAUDE_TOKEN, "X-Nebula-Agent-Session": mcp_server._AGENT_SESSION}
    listener = _beat(tools, session).json()["listener"]
    import mcp_channel

    state = mcp_channel.ChannelState(now=0.0)
    state.listener_id = listener["listenerId"]
    monkeypatch.setattr(mcp_server, "_channel", type("L", (), {"state": state})())
    shown = mcp_server.channel_status()
    assert shown["thisServer"] == {"channel": True, "state": "listening", "reason": None,
                                   "listenerId": listener["listenerId"], "registerError": None}
    assert [entry["listenerId"] for entry in shown["listeners"]] == [listener["listenerId"]]
    state.stop("Nebula stopped listening after 2 hours with no activity from the person.", reason="idle")
    assert mcp_server.channel_status()["thisServer"]["state"] == "stopped"
    assert mcp_server.channel_status()["thisServer"]["reason"] == "idle"


# -- round 5, D2: one session is one process ------------------------------------------------

def test_a_second_process_on_the_same_session_is_refused_while_the_first_lives(ready):
    first = _beat(ready, nonce="process-one-0001")
    assert first.status_code == 200
    second = _beat(ready, nonce="process-two-0002")
    assert second.status_code == 409
    assert second.headers["X-Nebula-Code"] == channel_listeners.SESSION_TAKEN_CODE
    assert second.json()["detail"] == channel_listeners.SESSION_TAKEN_LINE
    assert "because another process is already listening as this session" in channel_listeners.SESSION_TAKEN_LINE
    assert channel_listeners.SESSION_TAKEN_LINE.endswith("\nnebula mcp connect claude-code --channel")
    # Its goodbye never removes the first's entry; the first's own does.
    assert ready.client.delete("/api/agent/channel?nonce=process-two-0002", headers=SESSION_A).status_code == 200
    assert len(ready.client.get("/api/canvas/channel", headers=PERSON).json()["listeners"]) == 1
    assert _beat(ready, nonce="process-one-0001").status_code == 200  # the first beats on
    ready.client.delete("/api/agent/channel?nonce=process-one-0001", headers=SESSION_A)
    assert ready.client.get("/api/canvas/channel", headers=PERSON).json()["listeners"] == []
    assert _beat(ready, nonce="process-two-0002").status_code == 200  # now it may


def test_a_dead_processs_entry_lapses_and_the_new_process_registers(ready):
    assert _beat(ready, nonce="process-one-0001").status_code == 200
    assert _beat(ready, nonce="process-two-0002").status_code == 409
    ready.channel_clock.now += channel_listeners.TTL_SECONDS + 1  # the first died without a goodbye
    assert _beat(ready, nonce="process-two-0002").status_code == 200


def test_two_launches_of_the_printed_command_are_two_listeners(ready):
    # Each launch evaluates NEBULA_AGENT_SESSION="cc-$(date +%s)-$$" afresh: two
    # sessions, two listener ids, two cursors (each its own number).
    one = {**CLAUDE_TOKEN, "X-Nebula-Agent-Session": "cc-1B4E28BA-2FA1-11D2-883F-0016D3CCA427"}
    two = {**CLAUDE_TOKEN, "X-Nebula-Agent-Session": "cc-6F9619FF-8B86-D011-B42D-00C04FC964FF"}
    a = _beat(ready, one, nonce="process-one-0001").json()["listener"]
    b = _beat(ready, two, nonce="process-two-0002").json()["listener"]
    assert a["listenerId"] != b["listenerId"]
    person = ready.client.get("/api/canvas/channel", headers=PERSON).json()["listeners"]
    assert len({entry["session"]["key"] for entry in person}) == 2  # two cursors, one per session


def test_a_nonce_must_look_like_one():
    assert channel_listeners.parse_nonce("abcdef12") == "abcdef12"
    for bad in (None, 7, "short", "x" * 65, "has space1", "semi;colon1"):
        assert channel_listeners.parse_nonce(bad) is None


def test_fresh_listening_leaves_out_a_crashed_sessions_leftover_and_stopped_ones():
    clock = Clock()
    book = channel_listeners.ListenerBook(clock)
    claude = AgentIdentity(id="app:claude1", name="Claude Code", color="#C3E86B", verified=True)
    book.beat(claude, "old", state="listening", reason=None, project_id=None)
    clock.now += channel_listeners.FRESH_SECONDS + 1  # the old one crashed; its entry lives on for a while
    book.beat(claude, "new", state="listening", reason=None, project_id=None)
    book.beat(claude, "idle", state="stopped", reason="idle", project_id=None)
    assert [entry.session for entry in book.for_agent("app:claude1")] == ["old", "new", "idle"]
    assert [entry.session for entry in book.fresh_listening("app:claude1")] == ["new"]


def test_the_mcp_listener_sends_its_own_nonce_with_each_beat_and_its_goodbye():
    nonce = mcp_server._CHANNEL_NONCE
    assert channel_listeners.parse_nonce(nonce) == nonce


def test_one_missed_beat_never_makes_a_live_listener_stale():
    # Review 4 NIT-3: beats every 15 s with a 5 s timeout. One that failed
    # leaves a gap of up to 35 s; at 25 s the live listener read as stale.
    clock = Clock()
    book = channel_listeners.ListenerBook(clock)
    claude = AgentIdentity(id="app:claude1", name="Claude Code", color="#C3E86B", verified=True)
    book.beat(claude, "live", state="listening", reason=None, project_id=None)
    clock.now += 34.0
    assert [entry.session for entry in book.fresh_listening("app:claude1")] == ["live"]
    clock.now += 2.0
    assert book.fresh_listening("app:claude1") == []
    assert channel_listeners.FRESH_SECONDS == 35.0 < channel_listeners.TTL_SECONDS


def test_another_process_holding_the_session_is_told_apart_from_none():
    # Review 4 LOW-4: PR C's inbox, accepted and held routes refuse a
    # process whose nonce isn't the entry's.
    book = channel_listeners.ListenerBook(Clock())
    claude = AgentIdentity(id="app:claude1", name="Claude Code", color="#C3E86B", verified=True)
    assert book.taken_by_another(claude, "s", "process-one-0001") is False  # no entry yet
    book.beat(claude, "s", state="listening", reason=None, project_id=None, nonce="process-one-0001")
    assert book.taken_by_another(claude, "s", "process-one-0001") is False
    assert book.taken_by_another(claude, "s", "process-two-0002") is True
    assert book.taken_by_another(claude, "s", None) is True
