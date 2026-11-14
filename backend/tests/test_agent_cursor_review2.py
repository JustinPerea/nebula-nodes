"""Agent cursors, PR #211 review 2 (backend items).

- LOW-1: the refusal echo is cleaned in services/cursor_actions.py, the one
  place, so the route, MCP and the CLI all get it: no lone surrogate, no
  control, format or bidi character, a cut that never splits a character,
  and never a 500.
- LOW-2: an agent with a live cursor is never evicted from the agent cap; a
  new agent past the cap gets the plain agent cursor (no session).
- LOW-4: the cap prefers an idle agent, then the least recently used one.
- NIT-1: an invalid NEBULA_AGENT_SESSION acts as if it were unset.
"""
from __future__ import annotations

import json

import pytest

from services import agent_presence as presence_module
from services.agent_presence import AgentIdentity, AgentPresence, PresenceError
from services.cursor_actions import refusal
from tests.test_agent_cursor_sessions import Clock, sockets  # noqa: F401 - fixture
from tests.test_canvas_proposals import CLAUDE, api  # noqa: F401 - fixture

ESC = "\x1b[2J\x1b[31mred"
RLO = "ab\u202edcba"
FAMILY = "\U0001F468‍\U0001F469‍\U0001F467‍\U0001F466"  # 7 code points, one character


def _quoted(line: str) -> str:
    return line[line.index("“") + 1: line.index("”")]


def _clean(line: str) -> None:
    line.encode("utf-8")  # a lone surrogate would raise here
    for char in _quoted(line):
        assert char in "‍" or not (0xD800 <= ord(char) <= 0xDFFF), repr(line)
        assert char not in "\x1b\u202e\u202d\u2066\u2067\u2068\u2069​\x00\x7f", repr(line)


# -- LOW-1: the echo ----------------------------------------------------------

def test_the_echo_drops_surrogates_controls_and_bidi_and_still_says_where():
    assert _quoted(refusal("\ud800x")) == "�x"
    assert _quoted(refusal(ESC)) == "�[2J�[31mred"
    assert _quoted(refusal(RLO)) == "ab�dcba"
    assert _quoted(refusal("a​b\x00c\u2066d")) == "a�b�c�d"
    for value in ("\ud800", ESC, RLO, "\udcff" * 3):
        _clean(refusal(value))
    # Plain text and a whole emoji are echoed as given.
    assert _quoted(refusal("hover")) == "hover"
    assert _quoted(refusal(FAMILY)) == FAMILY


def test_a_100kb_value_is_cut_to_forty_characters():
    line = refusal("\x1b" + "x" * 100_000)
    assert _quoted(line) == "�" + "x" * 38 + "…"
    assert len(line) < 200


def test_the_cut_never_splits_an_emoji_sequence():
    # The family straddles character 39: the cut backs off to its start.
    value = "x" * 36 + FAMILY + "tail"
    shown = _quoted(refusal(value))
    assert shown == "x" * 36 + "…"
    # A family that fits whole before the cut stays whole.
    value = "x" * 30 + FAMILY + "y" * 10
    assert _quoted(refusal(value)) == "x" * 30 + FAMILY + "yy…"


@pytest.mark.parametrize("bad", ["\ud800", ESC, RLO, "\x1b" + "y" * 100_000, "x" * 36 + FAMILY + "tail"])
def test_the_route_refuses_each_with_a_422_and_a_clean_line(api, bad):  # noqa: F811
    node = api.graph.add_node("text-input", {"value": "hi"})
    body = json.dumps({"target": {"nodeId": node}, "action": bad})  # ensure_ascii: "\\ud800" on the wire
    refused = api.client.post("/api/canvas/cursor", headers={**CLAUDE, "Content-Type": "application/json"},
                              content=body.encode("ascii"))
    assert refused.status_code == 422, refused.text
    detail = refused.json()["detail"]
    assert detail == refusal(bad)
    _clean(detail)
    assert len(_quoted(detail)) <= 40


@pytest.mark.parametrize("bad", ["\ud800", ESC, RLO, "\x1b" + "y" * 100_000])
def test_mcp_point_at_refuses_each_with_a_clean_line(monkeypatch, bad):
    import mcp_server

    monkeypatch.setattr(mcp_server.httpx, "request", lambda *a, **k: pytest.fail("no request"))
    with pytest.raises(ValueError) as refused:
        mcp_server.point_at(node_id="n1", action=bad)
    _clean(str(refused.value))
    assert str(refused.value) == f"point_at: {refusal(bad)}"


@pytest.mark.parametrize("bad", ["\udcff\udc80", ESC, RLO, "z" * 100_000])
def test_the_cli_refuses_each_with_a_clean_line(capsys, bad):
    from cli.__main__ import build_parser

    with pytest.raises(SystemExit):
        build_parser().parse_args(["point", "n1", "--action", bad])
    err = capsys.readouterr().err
    err.encode("utf-8")
    assert refusal(bad) in err
    assert "\x1b" not in err and "\u202e" not in err


# -- LOW-2 and LOW-4: the caps ----------------------------------------------

def _agent(index: int) -> AgentIdentity:
    return AgentIdentity(id=f"ext:x{index}", name=f"X{index}", color="#3FC1A5", verified=False)


def _seen(presence: AgentPresence, agent: AgentIdentity, session: str = "s"):
    return presence.person_form(presence.point(agent, target={"x": 1, "y": 1}), agent, session=session)


def test_live_agents_keep_their_numbers_past_the_cap_and_a_new_one_gets_the_plain_cursor(monkeypatch):
    monkeypatch.setattr(presence_module, "SESSION_AGENT_MEMORY", 4)
    clock = Clock()
    presence = AgentPresence(clock)
    for index in range(1, 5):
        _seen(presence, _agent(index), "a")
        _seen(presence, _agent(index), "b")
        clock.now += 1
    # All four are live: none is pushed out for a fifth, which gets the plain
    # agent cursor, the agent form exactly, with no session.
    fifth = _agent(5)
    event = presence.point(fifth, target={"x": 5, "y": 0})
    assert presence.person_form(event, fifth, session="a") == event
    assert "session" not in presence.person_form(event, fifth, session="a")
    assert set(presence._slots) == {f"ext:x{index}" for index in range(1, 5)}
    for index in range(1, 5):
        assert _seen(presence, _agent(index), "b")["session"]["ordinal"] == 2
    # X1's cursors leave (no event for the TTL) while the rest stay live: the
    # next new agent takes X1's room and gets its own numbers.
    clock.now += presence_module.PRESENCE_TTL_SECONDS - 3
    for index in (2, 3, 4):
        _seen(presence, _agent(index), "b")
    clock.now += 4
    assert _seen(presence, fifth, "a")["session"]["ordinal"] == 1
    assert "ext:x1" not in presence._slots
    for index in (2, 3, 4):
        assert _seen(presence, _agent(index), "b")["session"]["ordinal"] == 2


def test_the_agent_memory_lets_the_least_recently_seen_left_agent_go(monkeypatch):
    monkeypatch.setattr(presence_module, "SESSION_AGENT_MEMORY", 4)
    clock = Clock()
    presence = AgentPresence(clock)
    for index in range(1, 5):
        _seen(presence, _agent(index))
        clock.now += 1
    _seen(presence, _agent(1))  # X1 seen again: X2 is now the least recent
    clock.now += presence_module.PRESENCE_TTL_SECONDS + 1  # every cursor has left
    _seen(presence, _agent(5))
    assert list(presence._slots) == ["ext:x3", "ext:x4", "ext:x1", "ext:x5"]
    _seen(presence, _agent(6))
    assert list(presence._slots) == ["ext:x4", "ext:x1", "ext:x5", "ext:x6"]


def test_the_session_cap_lets_a_younger_idle_session_go_before_an_older_active_one():
    clock = Clock()
    presence = AgentPresence(clock)
    agent = _agent(1)
    names = [f"s{index}" for index in range(presence_module.SESSIONS_PER_AGENT)]
    for name in names:
        _seen(presence, agent, name)
        clock.now += 1
    # s0, the oldest, keeps going; s5, younger, goes idle; the rest are newer
    # but also idle... so make every other one active again.
    clock.now += presence_module.SESSION_IDLE_SECONDS + 1
    for name in names:
        if name != "s5":
            _seen(presence, agent, name)
            clock.now += 0.1
    numbers = dict(zip(names, (ordinal for _key, ordinal in presence.live_sessions(agent.id))))
    assert _seen(presence, agent, "new")["session"]["ordinal"] == numbers["s5"]
    kept = {key for key, _ordinal in presence.live_sessions(agent.id)}
    assert presence.session_key(agent.id, "s5") not in kept
    assert presence.session_key(agent.id, "s0") in kept
    # With none idle, the least recently seen goes: s0 was seen first above.
    assert _seen(presence, agent, "newer")["session"]["ordinal"] == numbers["s0"]
    assert presence.session_key(agent.id, "s0") not in {key for key, _o in presence.live_sessions(agent.id)}


# -- NIT-1: an invalid NEBULA_AGENT_SESSION is ignored for the cursor ---------
@pytest.mark.parametrize("bad", ["lane a", "x" * 65, "lane/a", "lañe", "\u202elane"])
def test_the_cli_treats_an_invalid_session_as_unset_for_the_cursor(monkeypatch, bad):
    from cli.client import NebulaClient, cursor_session
    from services.agent_presence import presence_session

    client = NebulaClient("http://127.0.0.1:1")
    monkeypatch.setenv("NEBULA_AGENT_NAME", "Claude Code")
    monkeypatch.setenv("CLAUDE_CODE_SESSION_ID", "64d83e4d-be74-411e-95ee-3f12e9556048")
    unset = cursor_session()
    monkeypatch.setenv("NEBULA_AGENT_SESSION", bad)
    headers = client._identity_headers()
    # The scene-read header is sent as given (scene keys unchanged), and the
    # cursor lands on the Claude Code session's own cursor, as if unset.
    assert headers == {"X-Nebula-Agent": "Claude Code", "X-Nebula-Agent-Session": bad,
                       "X-Nebula-Surface": "cli", "X-Nebula-Cursor-Session": unset}
    assert presence_session(headers) == unset
    # Outside Claude Code: one cursor for the name, as if unset.
    monkeypatch.delenv("CLAUDE_CODE_SESSION_ID")
    headers = client._identity_headers()
    assert headers == {"X-Nebula-Agent": "Claude Code", "X-Nebula-Agent-Session": bad, "X-Nebula-Surface": "cli"}
    assert presence_session(headers) is None


def test_the_cli_sends_a_valid_session_alone(monkeypatch):
    from cli.client import NebulaClient

    client = NebulaClient("http://127.0.0.1:1")
    monkeypatch.setenv("NEBULA_AGENT_NAME", "Claude Code")
    monkeypatch.setenv("CLAUDE_CODE_SESSION_ID", "abc")
    for good in ("lane-a", "x" * 64, "a.b:c_d-1"):
        monkeypatch.setenv("NEBULA_AGENT_SESSION", good)
        assert client._identity_headers() == {"X-Nebula-Agent": "Claude Code", "X-Nebula-Agent-Session": good,
                                                         "X-Nebula-Surface": "cli"}


def test_mcp_treats_an_invalid_session_as_unset_for_the_cursor(monkeypatch):
    import mcp_server
    from services.agent_presence import presence_session

    assert mcp_server._own_cursor_session("lane-a") is None
    assert mcp_server._own_cursor_session("x" * 64) is None
    own = mcp_server._own_cursor_session("lane a")
    assert own and own != mcp_server._own_cursor_session("lane a")  # one per process, never fixed
    assert presence_session({"X-Nebula-Cursor-Session": own}) == own

    monkeypatch.setattr(mcp_server, "_AGENT_SESSION", "lane a")
    monkeypatch.setattr(mcp_server, "_CURSOR_SESSION", own)
    headers = mcp_server._agent_headers(None)
    assert headers["X-Nebula-Agent-Session"] == "lane a"  # scene reads as before
    assert presence_session(headers) == own               # this process's own cursor

    monkeypatch.setattr(mcp_server, "_AGENT_SESSION", "lane-a")
    monkeypatch.setattr(mcp_server, "_CURSOR_SESSION", None)
    headers = mcp_server._agent_headers(None)
    assert "X-Nebula-Cursor-Session" not in headers and presence_session(headers) == "lane-a"


def test_one_session_rule_for_the_backend_cli_and_mcp():
    from services import cursor_actions

    assert presence_module._SESSION_RE is cursor_actions.SESSION_RE


# -- NIT-3: a failed person form carries the real number, or none -------------
def test_a_failed_person_form_carries_the_live_sessions_real_number(sockets, monkeypatch):
    from tests.test_agent_cursor_sessions import MCP_SESSION, _presence_frames

    api = sockets
    node = api.graph.add_node("text-input", {"value": "hi"})
    # Two live cursors: the plain one is 1, the MCP session 2.
    for headers in (CLAUDE, {**CLAUDE, **MCP_SESSION}):
        assert api.client.post("/api/canvas/cursor", headers=headers,
                               json={"target": {"nodeId": node}, "action": "look"}).status_code == 200
    second = json.loads(_presence_frames(api.person_socket)[-1])["session"]
    assert second["ordinal"] == 2

    def broken(*args, **kwargs):
        raise RuntimeError("person form broke")

    monkeypatch.setattr(api.main.agent_presence, "person_form", broken)
    for call in (
        lambda: api.client.post("/api/canvas/cursor", headers={**CLAUDE, **MCP_SESSION},
                                json={"target": {"nodeId": node}, "action": "click"}),
        lambda: api.client.put(f"/api/graph/node/{node}", headers={**CLAUDE, **MCP_SESSION},
                               json={"params": {"value": "yo"}}),
    ):
        api.listener.sent.clear()
        api.person_socket.sent.clear()
        assert call().status_code < 300
        person = [json.loads(t) for t in _presence_frames(api.person_socket)]
        agent = [json.loads(t) for t in _presence_frames(api.listener)]
        # The tab gets session 2's own number, never the plain cursor's 1;
        # agents get the agent form, with no session, as always.
        assert [p["session"] for p in person] == [second]
        assert agent and all("session" not in a for a in agent)
        assert {k: v for k, v in person[0].items() if k != "session"} == agent[0]


def test_session_tag_reads_without_making_a_slot_and_forgets_a_left_cursor():
    clock = Clock()
    presence = AgentPresence(clock)
    agent = AgentIdentity(id="ext:t", name="T", color="#3FC1A5", verified=False)
    assert presence.session_tag(agent, "s") is None and presence._slots == {}
    made = presence.person_form(presence.point(agent, target={"x": 1, "y": 1}), agent, session="s")
    assert presence.session_tag(agent, "s") == made["session"]
    assert presence.session_tag(agent, None) is None  # the plain cursor isn't live
    assert presence.session_tag(agent, "bad value") is None
    clock.now += presence_module.PRESENCE_TTL_SECONDS + 1
    assert presence.session_tag(agent, "s") is None
