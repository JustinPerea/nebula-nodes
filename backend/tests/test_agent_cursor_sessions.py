"""Agent cursors, foundations (GM - Design's cursor spec, §2 and §4): the ten
actions at every agent surface, one cursor per agent session on the person's
tabs, and the read boundary.

Two forms of one cursor event (services/agent_presence.py):
- the agent form, what every agent can read (the snapshot, the roster, the
  start bundle, a /ws listener that isn't the person's canvas), exactly as it
  was before sessions;
- the person form, only for the person's verified canvas sockets: plus an
  opaque session key and its number, and the action a backend edit really
  was (a param edit shows as ``type``).
"""
from __future__ import annotations

import asyncio
import hashlib
import json
from dataclasses import dataclass, field

import pytest

from services import person_gate
from services.agent_presence import (
    ACTIONS,
    PRESENCE_TTL_SECONDS,
    SESSION_IDLE_SECONDS,
    SESSIONS_PER_AGENT,
    AgentIdentity,
    AgentPresence,
    PresenceError,
    identify,
    presence_session,
)
from services.cursor_actions import ACTIONS as SHARED_ACTIONS
from tests.test_canvas_proposals import CLAUDE, api  # noqa: F401 - fixture

TEN = ["move", "look", "think", "type", "click", "drag", "run", "propose", "wait", "error"]
TEN_TEXT = ", ".join(TEN)


def REFUSED(value: str) -> str:
    """GM's line, verbatim (PR #211 r2), echoing the value given."""
    return (f"\u201c{value}\u201d isn\u2019t an action Nebula knows. "
            "Use one of move, look, think, type, click, drag, run, propose, wait or error.")
MCP_SESSION = {"X-Nebula-Agent-Session": "a1b2c3d4e5f60718"}
CLI_SESSION = {"X-Nebula-Cursor-Session": "cc-0123456789abcdef"}


class Clock:
    def __init__(self) -> None:
        self.now = 5_000.0

    def __call__(self) -> float:
        return self.now


AGENT = AgentIdentity(id="ext:claude-code", name="Claude Code", color="#3FC1A5", verified=False)


def _event(presence: AgentPresence, target=None, **kwargs):
    return presence.point(AGENT, target=target or {"nodeId": "n1"}, **kwargs)


# -- the ten actions ---------------------------------------------------------

def test_one_list_of_ten_actions_in_one_order():
    assert list(ACTIONS) == TEN
    assert ACTIONS is SHARED_ACTIONS


def test_presence_itself_takes_only_the_ten():
    # The backstop under the route, for Nebula's own callers.
    presence = AgentPresence(Clock())
    for action in TEN:
        assert _event(presence, action=action)["action"] == action
    for bad, shown in (("hover", "hover"), ("MOVE", "MOVE"), (5, "5"), (None, "null")):
        with pytest.raises(PresenceError) as refused:
            _event(presence, action=bad)
        assert str(refused.value) == REFUSED(shown)
    assert REFUSED("hover") == "\u201chover\u201d isn\u2019t an action Nebula knows. Use one of move, look, think, type, click, drag, run, propose, wait or error."
    # A long value is cut, never echoed whole.
    with pytest.raises(PresenceError) as refused:
        _event(presence, action="x" * 500)
    assert str(refused.value) == REFUSED("x" * 39 + "\u2026")


def test_the_cursor_route_takes_all_ten_and_refuses_anything_else_listing_them(api):  # noqa: F811
    node = api.graph.add_node("text-input", {"value": "hi"})
    for action in TEN:
        ok = api.client.post("/api/canvas/cursor", headers=CLAUDE,
                             json={"target": {"nodeId": node}, "action": action})
        assert ok.status_code == 200, (action, ok.text)
        assert ok.json()["action"] == action
    for bad, shown in (("hover", "hover"), (5, "5"), ("MOVE", "MOVE"), (["move"], '["move"]'), ({"a": 1}, '{"a": 1}')):
        refused = api.client.post("/api/canvas/cursor", headers=CLAUDE,
                                  json={"target": {"nodeId": node}, "action": bad})
        assert refused.status_code == 422, bad
        assert refused.json()["detail"] == REFUSED(shown)


def test_mcp_point_at_refuses_an_unknown_action_before_any_request(monkeypatch):
    import mcp_server

    calls: list = []
    monkeypatch.setattr(mcp_server.httpx, "request", lambda *a, **k: calls.append(a))
    with pytest.raises(ValueError) as refused:
        mcp_server.point_at(node_id="n1", action="hover")
    assert str(refused.value) == f"point_at: {REFUSED('hover')}"
    assert calls == []
    # What each means is in the tool's own description, in this order.
    doc = mcp_server.point_at.__doc__ or ""
    positions = [doc.index(f"- `{action}`:") for action in TEN]
    assert positions == sorted(positions)


def test_mcp_point_at_sends_any_of_the_ten_with_its_process_session(monkeypatch):
    import httpx
    import mcp_server

    calls: list[dict] = []

    def fake_request(method, url, *, headers, timeout, **kwargs):
        calls.append({"headers": headers, **kwargs})
        return httpx.Response(200, json={"ok": True}, request=httpx.Request(method, url))

    monkeypatch.setattr(mcp_server.httpx, "request", fake_request)
    monkeypatch.delenv("NEBULA_AGENT_TOKEN", raising=False)
    monkeypatch.setenv("NEBULA_AGENT_NAME", "Claude Code")
    for action in TEN:
        mcp_server.point_at(node_id="n1", action=action)
    assert [call["json"]["action"] for call in calls] == TEN
    # One id per server process, the scene-read session it already sent:
    # presence only reads it.
    assert {call["headers"]["X-Nebula-Agent-Session"] for call in calls} == {mcp_server._AGENT_SESSION}
    assert "X-Nebula-Cursor-Session" not in calls[0]["headers"]


def test_the_cli_takes_the_ten_and_refuses_others(capsys):
    from cli.__main__ import build_parser

    parser = build_parser()
    for action in TEN:
        assert parser.parse_args(["point", "n1", "--action", action]).action == action
    with pytest.raises(SystemExit):
        parser.parse_args(["point", "n1", "--action", "hover"])
    assert capsys.readouterr().err.rstrip().endswith(f"argument --action: {REFUSED('hover')}")
    # The help still lists the ten.
    assert "{move,look,think,type,click,drag,run,propose,wait,error}" in " ".join(
        parser._subparsers._group_actions[0].choices["point"].format_help().split())


def test_the_cli_sends_the_action_and_defaults_as_before():
    from cli.commands.canvas import run_point

    bodies: list[dict] = []

    class Client:
        def point_cursor(self, body, agent_name=None):
            bodies.append(body)
            return {"agent": {"name": "Claude Code"}, "say": ""}

    run_point(Client(), "n1", action="propose")
    run_point(Client(), "n1")
    run_point(Client(), "n2", origin="n1")
    assert [body["action"] for body in bodies] == ["propose", "move", "drag"]


# -- where a session comes from ---------------------------------------------

def _record(session):
    return lambda token: {"runner": "claude", "session": session} if token == "t" else None


def test_an_in_app_chat_session_comes_from_its_token_and_beats_the_headers():
    headers = {"Authorization": "Agent t", **MCP_SESSION, **CLI_SESSION}
    assert presence_session(headers, token_lookup=_record("9f" * 16)) == "chat:" + "9f" * 16
    # A token with no chat session (a personal agent, an app): the headers.
    assert presence_session(headers, token_lookup=_record(None)) == MCP_SESSION["X-Nebula-Agent-Session"]
    assert presence_session({**CLI_SESSION}) == CLI_SESSION["X-Nebula-Cursor-Session"]
    assert presence_session({"X-Nebula-Agent": "Claude Code"}) is None
    assert presence_session(None) is None


@pytest.mark.parametrize("bad", ["x" * 65, "has space", "a/b", "", "é", "a\nb"])
def test_an_invalid_session_is_dropped_and_the_next_source_tried(bad):
    assert presence_session({"X-Nebula-Agent-Session": bad}) is None
    assert presence_session({"X-Nebula-Agent-Session": bad, **CLI_SESSION}) == CLI_SESSION["X-Nebula-Cursor-Session"]
    # A token's own session that would not fit is skipped too.
    headers = {"Authorization": "Agent t", **CLI_SESSION}
    assert presence_session(headers, token_lookup=_record(bad)) == CLI_SESSION["X-Nebula-Cursor-Session"]
    assert presence_session(headers, token_lookup=_record(5)) == CLI_SESSION["X-Nebula-Cursor-Session"]
    assert presence_session({"X-Nebula-Agent-Session": "x" * 64}) == "x" * 64


def test_the_cli_derives_its_cursor_session_from_claude_code_and_never_sends_the_raw_id(monkeypatch):
    from cli.client import NebulaClient, cursor_session

    raw = "64d83e4d-be74-411e-95ee-3f12e9556048"
    expected = "cc-" + hashlib.sha256(raw.encode()).hexdigest()[:16]
    assert cursor_session({"CLAUDE_CODE_SESSION_ID": raw}) == expected
    assert len(expected) == 19 and presence_session({"X-Nebula-Cursor-Session": expected}) == expected
    assert cursor_session({}) is None and cursor_session({"CLAUDE_CODE_SESSION_ID": "  "}) is None

    client = NebulaClient("http://127.0.0.1:1")
    monkeypatch.setenv("NEBULA_AGENT_NAME", "Claude Code")
    monkeypatch.delenv("NEBULA_AGENT_SESSION", raising=False)
    monkeypatch.setenv("CLAUDE_CODE_SESSION_ID", raw)
    headers = client._identity_headers()
    assert headers == {"X-Nebula-Agent": "Claude Code", "X-Nebula-Cursor-Session": expected}
    assert raw not in json.dumps(headers)
    # Never the scene-read header: that would change which reads guard a write.
    assert "X-Nebula-Agent-Session" not in headers

    # NEBULA_AGENT_SESSION set: the headers sent before, exactly.
    monkeypatch.setenv("NEBULA_AGENT_SESSION", "lane-a")
    assert client._identity_headers() == {"X-Nebula-Agent": "Claude Code", "X-Nebula-Agent-Session": "lane-a"}
    # Neither: no session header at all.
    monkeypatch.delenv("NEBULA_AGENT_SESSION")
    monkeypatch.delenv("CLAUDE_CODE_SESSION_ID")
    assert client._identity_headers() == {"X-Nebula-Agent": "Claude Code"}


def test_sessions_touch_no_permission_path():
    # The person gate's agent markers are what they were: the new header is
    # presence only.
    assert person_gate.AGENT_MARKER_HEADERS == ("x-nebula-agent", "x-nebula-client")
    import inspect

    from services import agent_spend, scene_keys

    for module in (person_gate, scene_keys, agent_spend):
        source = inspect.getsource(module).lower()
        assert "x-nebula-cursor-session" not in source and "presence_session" not in source


# -- the session table ----------------------------------------------------

def _ordinal(presence, session, target=None):
    form = presence.person_form(_event(presence, target), AGENT, session=session)
    return form.get("session", {}).get("ordinal", 1)


def test_numbers_go_among_live_sessions_the_lowest_free_first():
    clock = Clock()
    presence = AgentPresence(clock)
    numbers = {}
    for raw in ("a", "b", "c", "a", "b"):
        clock.now += 1
        numbers[raw] = _ordinal(presence, raw)
    assert [numbers[raw] for raw in ("a", "b", "c")] == [1, 2, 3]
    # All gone quiet past the TTL: they left, and a new session is "Claude".
    clock.now += PRESENCE_TTL_SECONDS + 5
    assert _ordinal(presence, "d") == 1
    # So is a returning one: its old number was freed when it left.
    assert _ordinal(presence, "b") == 2


def test_a_lone_chat_after_three_clears_reads_claude():
    clock = Clock()
    presence = AgentPresence(clock)
    # Each /clear starts a new chat session. The old chat's cursor leaves
    # with the canvas the clear wipes (forget_graph), as it does on the tab.
    for chat in range(4):
        clock.now += 1
        form = presence.person_form(_event(presence, {"nodeId": "n1"}), AGENT, session=f"chat:{chat:032x}")
        assert form["session"]["ordinal"] == 1
        assert form["session"]["key"]  # a session, shown bare: "Claude"
        presence.forget_graph()
    # Or the old one went quiet past the TTL (a clear the canvas refused).
    presence = AgentPresence(clock)
    for chat in range(4):
        clock.now += PRESENCE_TTL_SECONDS + 1
        assert _ordinal(presence, f"chat:{chat:032x}") == 1
    # Within the TTL the old chat's cursor is still on the canvas, so the
    # new one is numbered beside it.
    assert _ordinal(presence, "chat:" + "f" * 32) == 2


def test_with_three_live_a_new_session_takes_the_number_one_that_left_freed():
    clock = Clock()
    presence = AgentPresence(clock)
    for raw in ("s1", "s2", "s3"):
        clock.now += 1
        assert _ordinal(presence, raw) == int(raw[1])
    # s1 and s3 keep talking; s2 goes quiet until it leaves.
    for _ in range(int(PRESENCE_TTL_SECONDS // 30) + 1):
        clock.now += 30
        assert _ordinal(presence, "s1") == 1
        assert _ordinal(presence, "s3") == 3
    assert _ordinal(presence, "new") == 2
    assert sorted(n for _, n in presence.live_sessions(AGENT.id)) == [1, 2, 3]


def test_a_live_sessions_number_never_changes_while_another_leaves():
    clock = Clock()
    presence = AgentPresence(clock)
    for raw in ("s1", "s2", "s3", "s4"):
        clock.now += 1
        _ordinal(presence, raw, {"nodeId": f"node-{raw}"})
    # s1 leaves (quiet past the TTL), then s2 (its node is deleted with no
    # place to go), then s3 (the graph is replaced while s4 points at a spot).
    for _ in range(5):
        clock.now += 30
        for raw, n in (("s2", 2), ("s3", 3), ("s4", 4)):
            assert _ordinal(presence, raw, {"nodeId": f"node-{raw}"}) == n
    presence.forget_node("node-s2")
    assert _ordinal(presence, "s4", {"x": 5, "y": 5}) == 4
    assert _ordinal(presence, "s3", {"nodeId": "node-s3"}) == 3
    presence.forget_graph()
    assert _ordinal(presence, "s4", {"x": 6, "y": 6}) == 4
    assert [n for _, n in presence.live_sessions(AGENT.id)] == [4]
    # The freed numbers go lowest first, and s4 still holds its own.
    assert [_ordinal(presence, raw) for raw in ("n1", "n2", "n3", "n4")] == [1, 2, 3, 5]
    assert _ordinal(presence, "s4", {"x": 6, "y": 6}) == 4


def test_leaving_means_the_same_on_the_backend_and_the_tab():
    """One source of numbers: the backend frees a number when the cursor
    leaves, by the same TTL and cap the tab prunes by."""
    import pathlib
    import re as _re
    store = (pathlib.Path(__file__).resolve().parents[2] / "frontend/src/store/agentPresenceStore.ts").read_text()
    expire = int(_re.search(r"AGENT_CURSOR_EXPIRE_MS = ([0-9_]+);", store).group(1).replace("_", ""))
    idle = int(_re.search(r"AGENT_CURSOR_IDLE_MS = ([0-9_]+);", store).group(1).replace("_", ""))
    cap = int(_re.search(r"AGENT_CURSOR_SESSIONS_PER_AGENT = ([0-9]+);", store).group(1))
    assert expire == PRESENCE_TTL_SECONDS * 1000
    assert idle == SESSION_IDLE_SECONDS * 1000
    assert cap == SESSIONS_PER_AGENT


def test_the_no_session_cursor_takes_part_and_carries_its_number_to_the_person():
    """GM - Design, PR #211 r3: every person-tab event carries the backend's
    number, the plain cursor's too, so a tab never works one out. The agent
    form is untouched."""
    clock = Clock()
    alone = AgentPresence(clock)
    event = _event(alone)
    before = json.dumps(event)
    person = alone.person_form(event, AGENT, session=None)
    assert person is not event
    assert person["session"] == {"key": alone.session_key(AGENT.id, ""), "ordinal": 1}
    # And when its cursor came there (r21): person-only, for the stack order.
    assert person["since"] == int(clock.now * 1000)
    assert {k: v for k, v in person.items() if k not in ("session", "since")} == event
    assert json.dumps(event) == before  # the agent form, byte for byte

    presence = AgentPresence(clock)
    presence.person_form(_event(presence), AGENT, session="a")
    presence.person_form(_event(presence), AGENT, session="b")
    plain = presence.person_form(_event(presence), AGENT, session=None)
    assert plain["session"]["ordinal"] == 3


def test_the_key_is_opaque_per_agent_and_never_the_raw_id():
    presence = AgentPresence(Clock())
    raw = "chat:" + "ab" * 16
    form = presence.person_form(_event(presence), AGENT, session=raw)
    key = form["session"]["key"]
    assert len(key) == 12 and all(ch in "0123456789abcdef" for ch in key)
    assert raw not in json.dumps(form) and "ab" * 16 not in json.dumps(form)
    other = AgentIdentity(id="codex", name="Codex", color="#5B9DFF", verified=True)
    assert presence.session_key(other.id, raw) != key
    # A new backend process: new keys.
    assert AgentPresence(Clock()).session_key(AGENT.id, raw) != key


def test_an_agent_has_at_most_eight_live_sessions_and_the_oldest_idle_goes_first():
    clock = Clock()
    presence = AgentPresence(clock)
    for n in range(SESSIONS_PER_AGENT):
        clock.now += 1
        presence.person_form(_event(presence), AGENT, session=f"s{n}")
    keys = dict((raw, presence.session_key(AGENT.id, raw)) for raw in (f"s{n}" for n in range(10)))
    # s3 idle long enough; the others active just now.
    clock.now += SESSION_IDLE_SECONDS
    for n in range(SESSIONS_PER_AGENT):
        if n != 3:
            clock.now += 0.01  # distinct times, so "oldest" never rests on a tie
            presence.person_form(_event(presence), AGENT, session=f"s{n}")
    clock.now += 0.01
    presence.person_form(_event(presence), AGENT, session="s8")
    live = [key for key, _ in presence.live_sessions(AGENT.id)]
    assert len(live) == SESSIONS_PER_AGENT and keys["s3"] not in live and keys["s8"] in live

    # None idle: the oldest overall goes.
    clock.now += 1
    presence.person_form(_event(presence), AGENT, session="s9")
    live = [key for key, _ in presence.live_sessions(AGENT.id)]
    assert len(live) == SESSIONS_PER_AGENT and keys["s0"] not in live and keys["s8"] in live
    # The new sessions took the numbers the pruned ones freed: s8 took s3's 4,
    # s9 took s0's 1, and the others kept theirs.
    numbers = dict(presence.live_sessions(AGENT.id))
    assert numbers[keys["s8"]] == 4 and numbers[keys["s9"]] == 1
    assert sorted(numbers.values()) == list(range(1, SESSIONS_PER_AGENT + 1))
    assert all(numbers[keys[f"s{n}"]] == n + 1 for n in (1, 2, 4, 5, 6, 7))
    # A pruned session coming back is a new one: the oldest goes (s1, idle
    # since the first round), and it takes that freed number.
    clock.now += SESSION_IDLE_SECONDS
    back = presence.person_form(_event(presence), AGENT, session="s3")
    assert back["session"]["ordinal"] == 2
    assert keys["s1"] not in dict(presence.live_sessions(AGENT.id))


def test_a_line_said_in_place_stays_at_its_own_sessions_cursor():
    clock = Clock()
    presence = AgentPresence(clock)
    presence.report_view({"viewport": {"x": 0, "y": 0, "zoom": 1}, "screen": {"width": 800, "height": 600}})
    presence.person_form(_event(presence, {"nodeId": "n1"}), AGENT, session="a")
    presence.person_form(_event(presence, {"nodeId": "n2"}), AGENT, session="b")
    # Session a says something in place: agents see the agent's last cursor
    # (n2, here() as before); the person sees a's own, at n1.
    target, placed = presence.here(AGENT)
    assert (target, placed) == ({"nodeId": "n2"}, "cursor")
    event = presence.point(AGENT, target=target, say="Checking this")
    assert event["target"] == {"nodeId": "n2"}
    form = presence.person_form(event, AGENT, session="a", in_place=True)
    assert form["target"] == {"nodeId": "n1"} and form["say"] == "Checking this"
    # A new session's first words: the middle of the view, not b's cursor.
    first = presence.person_form(presence.point(AGENT, target=target, say="Hi"), AGENT, session="c", in_place=True)
    assert first["target"] == {"x": 400.0, "y": 300.0}


def test_deleting_a_node_or_the_graph_moves_session_cursors_like_agent_cursors():
    clock = Clock()
    presence = AgentPresence(clock)
    presence.report_view({"viewport": {"x": 0, "y": 0, "zoom": 1},
                          "nodes": [{"id": "n1", "x": 0, "y": 0, "width": 100, "height": 50}]})
    presence.person_form(_event(presence, {"nodeId": "n1"}), AGENT, session="a")
    presence.person_form(_event(presence, {"nodeId": "n2"}), AGENT, session="b")
    presence.forget_node("n1")
    presence.forget_node("n2")
    said_a = presence.person_form(presence.point(AGENT, target={"x": 0, "y": 0}, say="x"), AGENT,
                                  session="a", in_place=True)
    assert said_a["target"] == {"x": 50.0, "y": 25.0}
    said_b = presence.person_form(presence.point(AGENT, target={"x": 9, "y": 9}, say="x"), AGENT,
                                  session="b", in_place=True)
    assert said_b["target"] == {"x": 0.0, "y": 0.0}  # its node gone with no place: the view's middle

    presence.person_form(_event(presence, {"nodeId": "n7"}), AGENT, session="a")
    presence.forget_graph()
    said = presence.person_form(presence.point(AGENT, target={"x": 3, "y": 3}, say="x"), AGENT,
                                session="a", in_place=True)
    assert said["target"] == {"x": 0.0, "y": 0.0}


def test_the_shown_action_changes_only_the_person_form():
    presence = AgentPresence(Clock())
    event = _event(presence, action="click")
    form = presence.person_form(event, AGENT, session=None, shown="type")
    assert event["action"] == "click" and form["action"] == "type"
    assert presence.active()[0]["action"] == "click"
    # A value outside the ten is ignored.
    same = presence.person_form(_event(presence, action="click"), AGENT, session=None, shown="hover")
    assert same["action"] == "click"


def test_an_agent_log_only_event_has_one_form():
    presence = AgentPresence(Clock())
    event = presence.point(AGENT, target=None, say="Made “Desert light”")
    assert presence.person_form(event, AGENT, session="a", shown="type") is event
    assert presence.live_sessions(AGENT.id) == []


# -- the read boundary --------------------------------------------------------

@dataclass(eq=False)
class FakeSocket:
    sent: list[str] = field(default_factory=list)

    async def send_text(self, text: str) -> None:
        self.sent.append(text)


@pytest.fixture
def sockets(api, monkeypatch):  # noqa: F811
    """The real ConnectionManager with one person canvas and one plain listener."""
    manager = api.main.ConnectionManager()
    person, listener = FakeSocket(), FakeSocket()
    manager.active_connections.extend([person, listener])
    manager.browser_connections.add(person)
    monkeypatch.setattr(api.main, "manager", manager)
    clock = Clock()
    monkeypatch.setattr(api.main, "agent_presence", AgentPresence(clock))
    api.person_socket, api.listener, api.presence_clock = person, listener, clock
    return api


def _presence_frames(socket: FakeSocket) -> list[str]:
    return [text for text in socket.sent if json.loads(text).get("type") == "agentPresence"]


def test_decision_4_the_read_boundary_agents_get_the_same_bytes_with_or_without_sessions(sockets):
    """Decision 4 (the read boundary): whatever an agent can read is byte for
    byte what it was before sessions. Session keys, numbers and the shown
    action reach only the person's canvas sockets. Fails if presence data
    leaks into an agent path."""
    api = sockets
    node = api.graph.add_node("text-input", {"value": "hi"})
    body = {"target": {"nodeId": node}, "action": "look", "say": "Reading the brief"}

    assert api.client.post("/api/canvas/cursor", headers=CLAUDE, json=body).status_code == 200
    # Today's event, key for key and in today's order.
    expected = json.dumps({
        "type": "agentPresence",
        "agent": identify(CLAUDE).as_dict(),
        "action": "look",
        "say": "Reading the brief",
        "at": 5_000_000,
        "projectId": api.project_id,
        "target": {"nodeId": node},
        "did": {"verb": "Looked at", "nodeId": node, "label": "Text Input", "secondsAgo": 0.0},
    })
    assert _presence_frames(api.listener) == [expected]
    # No session: the person's canvas gets the same event plus the backend's
    # number for the plain cursor (r3), and nothing else differs.
    (plain,) = _presence_frames(api.person_socket)
    plain = json.loads(plain)
    assert plain.pop("session")["ordinal"] == 1
    assert isinstance(plain.pop("since"), int)  # its arrival, person-only (r21)
    assert json.dumps(plain) == expected

    def reads(headers: dict) -> list[str]:
        return [json.dumps(api.client.get(path, headers=headers).json(), sort_keys=True)
                for path in ("/api/canvas/snapshot", "/api/canvas/agents")]

    before = reads(CLAUDE)
    for session in (MCP_SESSION, CLI_SESSION):
        api.listener.sent.clear()
        api.person_socket.sent.clear()
        response = api.client.post("/api/canvas/cursor", headers={**CLAUDE, **session}, json=body)
        assert response.json() == {"agent": json.loads(expected)["agent"], "target": {"nodeId": node},
                                   "action": "look", "say": "Reading the brief", "placed": "target"}
        assert _presence_frames(api.listener) == [expected]
        (person,) = _presence_frames(api.person_socket)
        form = json.loads(person)
        session_field = form.pop("session")
        assert isinstance(form.pop("since"), int)
        assert json.dumps(form) == expected
        assert set(session_field) == {"key", "ordinal"}
        assert next(iter(session.values())) not in person  # never the raw id
        # What agents read is the same, from either session.
        assert reads({**CLAUDE, **session}) == before == reads(CLAUDE)

    # Nothing an agent reads names a session or its number anywhere, or a
    # cursor's arrival (r21).
    for text in [*reads(CLAUDE), *_presence_frames(api.listener)]:
        assert '"session"' not in text and '"ordinal"' not in text and '"since"' not in text


def test_decision_4_the_start_bundle_is_the_same_with_session_headers(sockets):
    api = sockets
    node = api.graph.add_node("text-input", {"value": "hi"})
    api.client.post("/api/canvas/cursor", headers={**CLAUDE, **MCP_SESSION}, json={"target": {"nodeId": node}})
    api.client.post("/api/canvas/cursor", headers={**CLAUDE, **CLI_SESSION}, json={"target": {"nodeId": node}})

    def start(headers):
        payload = api.client.get("/api/agent/start", headers=headers).json()
        return payload.get("canvas", payload).get("agents", payload)

    plain = json.dumps(start(CLAUDE), sort_keys=True)
    assert json.dumps(start({**CLAUDE, **MCP_SESSION}), sort_keys=True) == plain
    assert '"session"' not in plain and '"ordinal"' not in plain


def test_a_say_in_place_answers_as_before_and_only_the_person_form_moves(sockets):
    api = sockets
    n1 = api.graph.add_node("text-input", {"value": "a"})
    n2 = api.graph.add_node("text-input", {"value": "b"})
    a, b = {**CLAUDE, **MCP_SESSION}, {**CLAUDE, **CLI_SESSION}
    api.client.post("/api/canvas/cursor", headers=a, json={"target": {"nodeId": n1}})
    api.client.post("/api/canvas/cursor", headers=b, json={"target": {"nodeId": n2}})
    api.listener.sent.clear()
    api.person_socket.sent.clear()
    said = api.client.post("/api/canvas/cursor", headers=a, json={"say": "Here"}).json()
    assert said["target"] == {"nodeId": n2} and said["placed"] == "cursor"
    (agent_frame,) = _presence_frames(api.listener)
    (person_frame,) = _presence_frames(api.person_socket)
    assert json.loads(agent_frame)["target"] == {"nodeId": n2}
    assert json.loads(person_frame)["target"] == {"nodeId": n1}


# -- the backend's own edits -------------------------------------------------

def _forms(api) -> list[tuple[str, str]]:
    """(agent form action, person form action) of every cursor event with a target."""
    agent = [json.loads(t) for t in _presence_frames(api.listener)]
    person = [json.loads(t) for t in _presence_frames(api.person_socket)]
    assert len(agent) == len(person)
    return [(a["action"], p["action"]) for a, p in zip(agent, person) if "target" in a]


def test_each_edit_shows_its_real_action_to_the_person_and_agents_read_what_they_did(sockets):
    api = sockets
    text = api.client.post("/api/graph/node", headers=CLAUDE,
                           json={"definitionId": "text-input", "params": {"value": "b"}}).json()["id"]
    image = api.client.post("/api/graph/node", headers=CLAUDE,
                            json={"definitionId": "gpt-image-2-5-generate", "params": {}}).json()["id"]
    assert _forms(api) == [("click", "click"), ("click", "click")]

    def step(call) -> list[tuple[str, str]]:
        api.listener.sent.clear()
        api.person_socket.sent.clear()
        call()
        return _forms(api)

    assert step(lambda: api.client.post("/api/graph/connect", headers=CLAUDE, json={
        "source": text, "sourceHandle": "text", "target": image, "targetHandle": "prompt"})) == [("drag", "drag")]
    assert step(lambda: api.client.put(f"/api/graph/node/{image}", headers=CLAUDE,
                                       json={"params": {"quality": "low"}})) == [("click", "type")]
    assert api.main.agent_presence.active()[0]["action"] == "click"
    assert step(lambda: api.client.post("/api/graph/run", headers=CLAUDE,
                                        json={"wait": 5, "targetNodeId": text})) == [("click", "run")]
    lone = api.graph.add_node("gpt-image-2-5-generate", {})
    assert step(lambda: api.client.post("/api/graph/run", headers=CLAUDE,
                                        json={"targetNodeId": lone})) == [("click", "error")]
    proposal = {"note": "A wide hero", "nodes": [
        {"ref": "+img", "definitionId": "nano-banana", "params": {"aspect_ratio": "16:9"}}],
        "edges": [{"source": text, "sourceHandle": "text", "target": "+img", "targetHandle": "prompt"}]}
    assert step(lambda: api.client.post("/api/canvas/proposals", headers=CLAUDE, json=proposal)) == [
        ("click", "propose")]
    # What agents read keeps the action as it was.
    assert {cursor["action"] for cursor in api.main.agent_presence.active()} <= {"click", "drag", "move"}


def test_an_edit_with_no_session_reaches_the_person_with_its_number_and_agents_unchanged(sockets):
    api = sockets
    api.client.post("/api/graph/node", headers=CLAUDE, json={"definitionId": "text-input", "params": {}})
    (agent_frame,) = _presence_frames(api.listener)
    (person_frame,) = _presence_frames(api.person_socket)
    assert "session" not in json.loads(agent_frame)
    person = json.loads(person_frame)
    assert person.pop("session")["ordinal"] == 1
    assert isinstance(person.pop("since"), int)
    assert "since" not in json.loads(agent_frame)
    assert json.dumps(person) == agent_frame


def test_a_session_edit_reaches_the_person_with_its_session(sockets):
    api = sockets
    headers = {**CLAUDE, **MCP_SESSION}
    api.client.post("/api/graph/node", headers=headers, json={"definitionId": "text-input", "params": {}})
    (agent_frame,) = _presence_frames(api.listener)
    (person_frame,) = _presence_frames(api.person_socket)
    assert "session" not in json.loads(agent_frame)
    assert json.loads(person_frame)["session"]["ordinal"] == 1


def test_an_in_app_chat_token_gives_its_cursor_a_session_and_no_title(sockets):
    """In-app chats are named by number: Nebula's chats have no titles yet,
    so nothing beyond the key and number ever reaches a tab."""
    from commons.actors import agent_registry

    api = sockets
    node = api.graph.add_node("text-input", {"value": "hi"})
    token = agent_registry.mint("claude", [], session="5e" * 16)
    try:
        headers = {"Authorization": f"Agent {token}", **MCP_SESSION}
        assert api.client.post("/api/canvas/cursor", headers=headers,
                               json={"target": {"nodeId": node}}).status_code == 200
    finally:
        agent_registry.revoke(token)
    (person_frame,) = _presence_frames(api.person_socket)
    form = json.loads(person_frame)
    expected_key = api.main.agent_presence.session_key("claude", "chat:" + "5e" * 16)
    assert form["session"] == {"key": expected_key, "ordinal": 1}
    assert "title" not in json.dumps(form) and "5e" * 16 not in person_frame
    assert "session" not in json.loads(_presence_frames(api.listener)[0])


def test_the_broadcast_helper_sends_one_form_when_they_are_the_same(sockets):
    api = sockets
    event = {"type": "agentPresence", "x": 1}
    asyncio.run(api.main._broadcast_presence(event, event))
    assert api.person_socket.sent == api.listener.sent == [json.dumps(event)]
    asyncio.run(api.main._broadcast_presence(event, {**event, "session": {"key": "k", "ordinal": 2}}))
    assert api.listener.sent[-1] == json.dumps(event)
    assert json.loads(api.person_socket.sent[-1])["session"]["ordinal"] == 2


# -- NEBULA_AGENT_SESSION for orchestrators (GM - Design, PR #211 r1) ---------

def test_nebula_agent_session_is_documented_where_an_orchestrator_looks():
    """The CLI help, the skill and MCP-SETUP say how to give each subagent
    its own cursor, and what happens without it."""
    import pathlib

    from cli.__main__ import build_parser

    parser = build_parser()
    top = parser.format_help()
    assert "NEBULA_AGENT_SESSION" in top
    assert "subagents share" in top and "parent's cursor" in top
    assert "NEBULA_AGENT_SESSION=lane-a nebula point" in top
    subs = next(a for a in parser._actions if a.__class__.__name__ == "_SubParsersAction").choices
    point = subs["point"].format_help()
    assert "NEBULA_AGENT_SESSION" in point and "parent's" in point
    assert "NEBULA_AGENT_SESSION" in subs["agents"].format_help()

    root = pathlib.Path(__file__).resolve().parents[2]
    skill = " ".join((root / "skills/nebula/SKILL.md").read_text().split())
    setup = " ".join((root / "docs/MCP-SETUP.md").read_text().split())
    for text in (skill, setup):
        assert "NEBULA_AGENT_SESSION=lane-a nebula point" in text
        assert "subagents share" in text.lower() or "your subagents see the same one" in text.lower()
    assert "Without it" in skill and "Without it, subagents share the parent's cursor" in setup
    # The numbering the docs describe is the live one, not "until Nebula restarts".
    assert "lowest number free" in setup and "until Nebula restarts (\"Claude" not in setup
    assert "lowest number free" in skill


# -- review 1 and GM's r2 answers ---------------------------------------------

def test_any_param_value_change_shows_type_through_put_and_apply_and_rename_stays_click(sockets):
    """GM - Design, PR #211 r2, answer 8: a param value change is `type`
    through PUT, edit_canvas or apply; a rename stays `click`. Agents read
    `click` throughout."""
    api = sockets
    text = api.client.post("/api/graph/node", headers=CLAUDE,
                           json={"definitionId": "text-input", "params": {"value": "a"}}).json()["id"]

    def step(call) -> list[tuple[str, str]]:
        api.listener.sent.clear()
        api.person_socket.sent.clear()
        response = call()
        assert response.status_code < 300, response.text
        return _forms(api)

    # apply / edit_canvas: a param value change.
    assert step(lambda: api.client.post("/api/graph/apply", headers=CLAUDE, json={
        "params": [{"nodeId": text, "params": {"value": "b"}}]})) == [("click", "type")]
    # apply: a rename only.
    assert step(lambda: api.client.post("/api/graph/apply", headers=CLAUDE, json={
        "rename": {text: "Brief"}})) == [("click", "click")]
    # apply: an added node with its params.
    assert step(lambda: api.client.post("/api/graph/apply", headers=CLAUDE, json={
        "nodes": [{"ref": "+t", "definitionId": "text-input", "params": {"value": "c"}}]})) == [("click", "click")]
    # PUT with values: type. PUT with no keys (position only): one form, click.
    assert step(lambda: api.client.put(f"/api/graph/node/{text}", headers=CLAUDE,
                                       json={"params": {"value": "d"}})) == [("click", "type")]
    api.listener.sent.clear()
    api.person_socket.sent.clear()
    moved = api.client.put(f"/api/graph/node/{text}", headers=CLAUDE, json={"position": {"x": 40, "y": 40}})
    assert moved.status_code < 300, moved.text
    agent = [json.loads(t) for t in _presence_frames(api.listener)]
    person = [json.loads(t) for t in _presence_frames(api.person_socket)]
    assert [e["action"] for e in agent if "target" in e] == [e["action"] for e in person if "target" in e]
    assert {e["action"] for e in person if "target" in e} <= {"click"}
    # The rename route: click.
    renamed = step(lambda: api.client.put(f"/api/graph/node/{text}/label", headers=CLAUDE, json={"label": "Hero"}))
    assert renamed == [("click", "click")]


def test_a_person_form_failure_still_sends_the_agent_form_and_never_500s(sockets, monkeypatch):
    """Review 1, LOW-1: the person's copy is built apart from the agent form."""
    api = sockets

    def broken(*args, **kwargs):
        raise RuntimeError("person form broke")

    monkeypatch.setattr(api.main.agent_presence, "person_form", broken)
    node = api.graph.add_node("text-input", {"value": "hi"})
    pointed = api.client.post("/api/canvas/cursor", headers={**CLAUDE, **MCP_SESSION},
                              json={"target": {"nodeId": node}, "action": "look"})
    assert pointed.status_code == 200, pointed.text
    # Agents get the agent form. The person's tabs get nothing for a session
    # with no live cursor yet: never a bare form the tab would number 1
    # (review 2, NIT-3; test_agent_cursor_review2 covers a live one).
    frames = [json.loads(t) for t in _presence_frames(api.listener)]
    assert frames and frames[-1]["action"] == "look" and "session" not in frames[-1]
    assert _presence_frames(api.person_socket) == []
    # An edit emitter too.
    api.listener.sent.clear()
    api.person_socket.sent.clear()
    put = api.client.put(f"/api/graph/node/{node}", headers=CLAUDE, json={"params": {"value": "yo"}})
    assert put.status_code < 300
    assert [json.loads(t)["action"] for t in _presence_frames(api.listener)] == ["click"]
    assert _presence_frames(api.person_socket) == []


def test_the_agents_kept_are_bounded_and_a_left_one_goes_with_its_slots():
    """Review 1, LOW-3: at most SESSION_AGENT_MEMORY agents keep slots.
    Review 2, LOW-2 (GM - Design, PR #211 r5): only an agent whose cursors
    have all left goes; a live one keeps its numbers, and a new agent past
    the cap gets the plain agent cursor, no session, until room frees."""
    from services.agent_presence import SESSION_AGENT_MEMORY

    clock = Clock()
    presence = AgentPresence(clock)
    first = AgentIdentity(id="ext:a0", name="A0", color="#3FC1A5", verified=False)
    presence.person_form(presence.point(first, target={"x": 1, "y": 1}), first, session="s")
    assert presence.live_sessions(first.id)
    clock.now += PRESENCE_TTL_SECONDS + 1  # A0's cursor leaves
    sessions = []
    for n in range(1, SESSION_AGENT_MEMORY + 4):
        clock.now += 0.001
        agent = AgentIdentity(id=f"ext:a{n}", name=f"A{n}", color="#3FC1A5", verified=False)
        sessions.append(presence.person_form(presence.point(agent, target={"x": 1, "y": 1}), agent,
                                             session="s").get("session"))
    assert presence.live_sessions(first.id) == []
    assert "ext:a0" not in presence._slots
    assert len(presence._slots) == SESSION_AGENT_MEMORY
    assert all(sessions[:SESSION_AGENT_MEMORY]) and sessions[SESSION_AGENT_MEMORY:] == [None, None, None]
    # Seen again once room frees, it starts afresh: "A0" is plain number 1.
    clock.now += PRESENCE_TTL_SECONDS + 1
    again = presence.person_form(presence.point(first, target={"x": 1, "y": 1}), first, session="s")
    assert again["session"]["ordinal"] == 1


def test_a_marked_socket_with_the_real_token_is_never_the_persons(api, person):  # noqa: F811
    """Review 1, M3 (it hung through the socket tests): promote, directly."""
    token = person.token
    manager = api.main.ConnectionManager()

    class Socket:
        def __init__(self, headers):
            self.headers = headers

    marked, plain = Socket({"x-nebula-agent": "Claude"}), Socket({})
    manager.active_connections.extend([marked, plain])
    assert manager.promote(marked, token) is False
    assert marked not in manager.browser_connections
    for header in ({"x-nebula-client": "cli"}, {"authorization": "Agent abc"}):
        other = Socket(header)
        manager.active_connections.append(other)
        assert manager.promote(other, token) is False
    assert manager.promote(plain, "wrong") is False
    assert manager.promote(plain, token) is True


def test_every_broadcast_raw_stand_in_must_take_others():
    """Review 1, LOW-2: a fake that can't take ``others=`` raised a TypeError
    that _show_agent swallowed, so presence events vanished in 40 test files.
    Review 2, LOW-3: the guard is now a runtime check in conftest.py (after
    every monkeypatch.setattr, and when each test body ends), so every way of
    installing a narrow stand-in is caught, not only the ones a syntax scan
    could read."""
    import functools

    import main
    from tests.conftest import _check_broadcast_raw, broadcast_raw_takes_others

    async def narrow(data):
        return None

    async def wide(data, **kw):
        return None

    class Narrow:
        async def __call__(self, data):
            return None

    class Wide:
        async def __call__(self, data, *, others=None):
            return None

    async def two(data, extra):
        return None

    narrow_ones = [narrow, functools.partial(two, extra=1), Narrow(), lambda data: None]
    for fake in narrow_ones:
        assert not broadcast_raw_takes_others(fake), fake
    for fake in [wide, Wide(), main.manager.broadcast_raw, lambda data, **_: None]:
        assert broadcast_raw_takes_others(fake), fake
    real = main.manager.broadcast_raw
    installs = [
        lambda mp, fake: mp.setattr(main.manager, "broadcast_raw", fake),
        lambda mp, fake: mp.setattr(target=main.manager, name="broadcast_raw", value=fake),
        lambda mp, fake: mp.setattr("main.manager.broadcast_raw", fake),
    ]
    for install in installs:
        for fake in narrow_ones:
            with pytest.MonkeyPatch.context() as mp:
                with pytest.raises(TypeError, match="can't take others="):
                    install(mp, fake)
            assert main.manager.broadcast_raw == real
        with pytest.MonkeyPatch.context() as mp:
            install(mp, wide)  # a wide one goes in quietly
    # A direct assignment is caught when the test body ends.
    main.manager.broadcast_raw = narrow
    try:
        with pytest.raises(TypeError, match="can't take others="):
            _check_broadcast_raw("here")
    finally:
        del main.manager.broadcast_raw
    assert main.manager.broadcast_raw == real
    _check_broadcast_raw("here")


def test_the_shared_capture_records_both_forms(sockets, broadcast_capture):
    api = sockets
    node = api.graph.add_node("text-input", {"value": "hi"})
    api.client.post("/api/canvas/cursor", headers={**CLAUDE, **MCP_SESSION}, json={"target": {"nodeId": node}})
    person, agent = broadcast_capture.sent[-1], broadcast_capture.others[-1]
    assert person["session"]["ordinal"] == 1 and "session" not in agent


# -- round 3 (GM - Design, PR #211 r3) ---------------------------------------

def test_a_refused_clear_keeps_the_old_chat_live_so_the_new_one_is_2_and_keeps_it():
    """GM r3, answer 3: a /clear whose canvas clear is refused (a run going)
    leaves the old chat's cursor live, so the new chat is "Claude · 2" and
    keeps 2 after the old one leaves. No borrowing of the freed 1."""
    clock = Clock()
    presence = AgentPresence(clock)
    old = presence.person_form(_event(presence), AGENT, session="chat:old")
    assert old["session"]["ordinal"] == 1
    # The clear was refused: forget_graph never ran. The new chat speaks.
    new = presence.person_form(_event(presence), AGENT, session="chat:new")
    assert new["session"]["ordinal"] == 2
    # The old chat goes quiet and leaves; the new one keeps talking.
    for _ in range(5):
        clock.now += 30
        assert presence.person_form(_event(presence), AGENT, session="chat:new")["session"]["ordinal"] == 2
    assert [number for _, number in presence.live_sessions(AGENT.id)] == [2]
    # A third chat takes the freed 1; the new one still reads 2.
    assert presence.person_form(_event(presence), AGENT, session="chat:third")["session"]["ordinal"] == 1
    assert presence.person_form(_event(presence), AGENT, session="chat:new")["session"]["ordinal"] == 2


def test_the_replay_lists_every_live_cursor_with_its_number_where_it_is():
    clock = Clock()
    presence = AgentPresence(clock)
    for raw, x in (("a", 10), ("b", 20), ("c", 30)):
        presence.person_form(_event(presence, {"x": x, "y": 5}, say=f"from {raw}"), AGENT, session=raw)
    # b goes quiet past the TTL; a and c keep talking.
    for _ in range(5):
        clock.now += 30
        presence.person_form(_event(presence, {"x": 10, "y": 5}), AGENT, session="a")
        presence.person_form(_event(presence, {"x": 30, "y": 5}), AGENT, session="c")
    clock.now += 2
    cursors = presence.replay()
    assert [(c["target"]["x"], c["session"]["ordinal"]) for c in cursors] == [(10, 1), (30, 3)]
    for cursor in cursors:
        assert cursor["replay"] is True
        assert cursor["secondsAgo"] == 2.0
        assert cursor["type"] == "agentPresence"
        assert cursor["agent"] == AGENT.as_dict()
    # b's number is free again, and the replay agrees with what tabs were sent.
    assert presence.person_form(_event(presence), AGENT, session="d")["session"]["ordinal"] == 2


def test_the_replay_leaves_out_a_drag_origin_and_follows_a_deleted_or_cleared_node():
    clock = Clock()
    presence = AgentPresence(clock)
    presence.person_form(_event(presence, {"nodeId": "n2"}, origin={"nodeId": "n1"}, action="drag"), AGENT, session="a")
    presence.person_form(_event(presence, {"x": 1, "y": 2}), AGENT, session="b")
    (drag, plain) = presence.replay()
    assert "from" not in drag and drag["target"] == {"nodeId": "n2"}
    presence.forget_graph()
    assert [c["session"]["ordinal"] for c in presence.replay()] == [2]
    assert plain["target"] == {"x": 1, "y": 2}


def test_the_replay_keeps_the_eight_cursor_cap():
    clock = Clock()
    presence = AgentPresence(clock)
    for n in range(10):
        clock.now += 1
        presence.person_form(_event(presence, {"x": n, "y": 0}), AGENT, session=f"s{n}")
    cursors = presence.replay()
    assert len(cursors) == SESSIONS_PER_AGENT
    assert sorted(c["session"]["ordinal"] for c in cursors) == list(range(1, 9))


class _HelloSocket:
    """Enough of a WebSocket for websocket_endpoint: the frames it will
    receive, then a disconnect. Run under a timeout, so it can never hang."""

    def __init__(self, frames: list[dict], headers: dict | None = None) -> None:
        self.headers = headers or {}
        self.incoming = [json.dumps(frame) for frame in frames]
        self.sent: list[dict] = []

    async def accept(self) -> None:
        return None

    async def send_text(self, text: str) -> None:
        self.sent.append(json.loads(text))

    async def receive_text(self) -> str:
        from fastapi import WebSocketDisconnect

        if not self.incoming:
            raise WebSocketDisconnect()
        return self.incoming.pop(0)


def _connect(api, frames, headers=None) -> list[dict]:  # noqa: F811
    socket = _HelloSocket(frames, headers)
    asyncio.run(asyncio.wait_for(api.main.websocket_endpoint(socket), 20))
    return socket.sent


def test_a_person_tab_gets_the_replay_on_its_hello_and_no_one_else_does(sockets, person):
    api = sockets
    node = api.graph.add_node("text-input", {"value": "hi"})
    no_hello_before = _connect(api, [])
    for raw in ("lane-a", "lane-b", "lane-c"):
        body = {"target": {"nodeId": node}, "action": "look", "say": f"Reading in {raw}"}
        assert api.client.post("/api/canvas/cursor", headers={**CLAUDE, "X-Nebula-Agent-Session": raw},
                               json=body).status_code == 200
    # b leaves (quiet past the TTL); a and c keep going.
    for _ in range(5):
        api.presence_clock.now += 30
        for raw in ("lane-a", "lane-c"):
            api.client.post("/api/canvas/cursor", headers={**CLAUDE, "X-Nebula-Agent-Session": raw},
                            json={"target": {"x": 10, "y": 10}, "action": "move"})

    sent = _connect(api, [{"type": "hello", "personToken": person.token}])
    types = [message["type"] for message in sent]
    replay_at = types.index("agentPresenceReplay")
    # The last of the syncs a verified hello gets, after the person's pins.
    assert types[replay_at - 1] == "canvasPins" and replay_at == len(types) - 1
    cursors = sent[replay_at]["cursors"]
    assert [c["session"]["ordinal"] for c in cursors] == [1, 3]
    assert all(c["replay"] is True and c["agent"] == identify(CLAUDE).as_dict() for c in cursors)

    # A second tab (or a reconnect) gets the same list: the same keys, numbers.
    again = next(m for m in _connect(api, [{"type": "hello", "personToken": person.token}])
                 if m["type"] == "agentPresenceReplay")["cursors"]
    assert [(c["session"]["key"], c["session"]["ordinal"]) for c in again] == [
        (c["session"]["key"], c["session"]["ordinal"]) for c in cursors]

    # No replay without a verified hello: no hello, a wrong token, or an agent-marked socket.
    for frames, headers in (([], None),
                            ([{"type": "hello", "personToken": "wrong"}], None),
                            ([{"type": "hello", "personToken": person.token}], {"x-nebula-agent": "Claude"})):
        assert "agentPresenceReplay" not in [m["type"] for m in _connect(api, frames, headers)]
    # The boundary, key for key: a socket that never says hello gets exactly
    # what it got before any session was live, and agents' reads don't change.
    def timeless(messages):  # a notes sync stamps its send time
        return [{k: v for k, v in m.items() if k != "at"} for m in messages]
    assert timeless(_connect(api, [])) == timeless(no_hello_before)
    for path in ("/api/canvas/agents", "/api/canvas/snapshot"):
        read = json.dumps(api.client.get(path, headers=CLAUDE).json())
        assert '"session"' not in read and '"ordinal"' not in read and '"replay"' not in read, path


def test_every_person_form_carries_the_backends_number_and_the_tab_has_no_fallback():
    """GM r3, answer 4: the backend numbers in every event a person tab gets;
    the tab computes none (no `?? 1` or the like)."""
    import pathlib

    presence = AgentPresence(Clock())
    for session in (None, "a", None, "b"):
        assert "ordinal" in presence.person_form(_event(presence), AGENT, session=session)["session"]
    store = (pathlib.Path(__file__).resolve().parents[2] / "frontend/src/store/agentPresenceStore.ts").read_text()
    assert "ordinal ?? " not in store and "ordinal || " not in store


def test_the_replay_never_names_a_node_that_went():
    """A cursor that moved off a node keeps its last action's name, not the
    node: after a clear or a delete, the replay says "Added “Hero”" with no
    node id (ids restart per graph), as the agents' copy does."""
    clock = Clock()
    presence = AgentPresence(clock)
    did = {"verb": "Added", "nodeId": "n1", "label": "Hero"}
    presence.person_form(_event(presence, {"x": 5, "y": 5}, did=did), AGENT, session="a")
    presence.person_form(_event(presence, {"x": 9, "y": 9}, did={**did, "nodeId": "n2"},
                                origin={"nodeId": "n2"}, action="drag"), AGENT, session="b")
    presence.forget_node("n1")
    (first, second) = presence.replay()
    assert first["did"]["nodeId"] is None and first["did"]["label"] == "Hero"
    assert second["did"]["nodeId"] == "n2"
    presence.forget_graph()
    assert all(cursor["did"]["nodeId"] is None for cursor in presence.replay())


def test_the_replay_drops_cursors_that_left_with_no_event_since():
    """Expiry is lazy (on the agent's next event); the replay checks it too,
    so a tab that connects after everyone went quiet gets no ghost."""
    clock = Clock()
    presence = AgentPresence(clock)
    presence.person_form(_event(presence, {"x": 1, "y": 1}), AGENT, session="a")
    presence.person_form(_event(presence, {"x": 2, "y": 2}), AGENT, session="b")
    clock.now += PRESENCE_TTL_SECONDS - 1
    assert len(presence.replay()) == 2
    clock.now += 2
    assert presence.replay() == []
    # Their numbers are free: the next session is 1.
    assert presence.person_form(_event(presence), AGENT, session="c")["session"]["ordinal"] == 1


def test_the_replay_is_oldest_first_so_the_newest_paints_on_top():
    clock = Clock()
    presence = AgentPresence(clock)
    presence.person_form(_event(presence, {"x": 1, "y": 1}), AGENT, session="a")
    clock.now += 1
    presence.person_form(_event(presence, {"x": 2, "y": 2}), AGENT, session="b")
    assert [c["target"]["x"] for c in presence.replay()] == [1, 2]
    clock.now += 1
    presence.person_form(_event(presence, {"x": 3, "y": 3}), AGENT, session="a")
    assert [c["target"]["x"] for c in presence.replay()] == [2, 3]


def test_the_replay_puts_a_cursor_whose_node_went_where_the_node_was():
    clock = Clock()
    presence = AgentPresence(clock)
    presence.report_view({"viewport": {"x": 0, "y": 0, "zoom": 1},
                          "nodes": [{"id": "n1", "x": 100, "y": 200, "width": 40, "height": 20}]})
    presence.person_form(_event(presence, {"nodeId": "n1"}), AGENT, session="a")
    presence.forget_node("n1")
    (cursor,) = presence.replay()
    assert cursor["target"] == {"x": 120.0, "y": 210.0}


# -- arrival order (GM - Design, PR #211 r21) --------------------------------

def test_each_cursor_carries_when_it_came_to_where_it_is_and_the_replay_keeps_it():
    """Every tab stacks a column by the backend's arrival order, so the same
    cursors are drawn in full before and after a reload, and in every tab.
    A cursor's arrival moves only when it goes somewhere new: the same node,
    or a point within ARRIVAL_RADIUS, keeps it."""
    from services.agent_presence import ARRIVAL_RADIUS

    clock = Clock()
    presence = AgentPresence(clock)

    def form(raw, target, say=""):
        return presence.person_form(_event(presence, target, say=say), AGENT, session=raw)

    first = form("s1", {"nodeId": "n1"})
    clock.now += 2
    second = form("s2", {"nodeId": "n1"})
    assert (first["since"], second["since"]) == (5_000_000, 5_002_000)
    # Talking on the same node, or a nudge within the radius, keeps it.
    clock.now += 3
    assert form("s1", {"nodeId": "n1"}, say="Still here")["since"] == 5_000_000
    form("s3", {"x": 10, "y": 10})
    clock.now += 1
    assert form("s3", {"x": 10 + ARRIVAL_RADIUS, "y": 10})["since"] == 5_005_000
    # Somewhere new: it arrives now.
    clock.now += 1
    assert form("s3", {"x": 10 + 3 * ARRIVAL_RADIUS, "y": 10})["since"] == 5_007_000
    assert form("s1", {"nodeId": "n2"})["since"] == 5_007_000
    # The replay (a reload, another tab) carries the same arrivals.
    replayed = {c["session"]["ordinal"]: c["since"] for c in presence.replay()}
    assert replayed == {1: 5_007_000, 2: 5_002_000, 3: 5_007_000}
    # The agent form never carries it.
    assert "since" not in _event(presence)
