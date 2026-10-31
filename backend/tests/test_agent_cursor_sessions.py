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
    for bad in ("hover", "MOVE", 5, None):
        with pytest.raises(PresenceError, match=f"^action must be one of {TEN_TEXT}$"):
            _event(presence, action=bad)


def test_the_cursor_route_takes_all_ten_and_refuses_anything_else_listing_them(api):  # noqa: F811
    node = api.graph.add_node("text-input", {"value": "hi"})
    for action in TEN:
        ok = api.client.post("/api/canvas/cursor", headers=CLAUDE,
                             json={"target": {"nodeId": node}, "action": action})
        assert ok.status_code == 200, (action, ok.text)
        assert ok.json()["action"] == action
    for bad in ("hover", 5, "MOVE", ["move"], {"a": 1}):
        refused = api.client.post("/api/canvas/cursor", headers=CLAUDE,
                                  json={"target": {"nodeId": node}, "action": bad})
        assert refused.status_code == 422, bad
        assert refused.json()["detail"] == f"action must be one of {TEN_TEXT}"


def test_mcp_point_at_refuses_an_unknown_action_before_any_request(monkeypatch):
    import mcp_server

    calls: list = []
    monkeypatch.setattr(mcp_server.httpx, "request", lambda *a, **k: calls.append(a))
    with pytest.raises(ValueError) as refused:
        mcp_server.point_at(node_id="n1", action="hover")
    assert str(refused.value) == f'point_at: action must be one of {TEN_TEXT} (you gave "hover")'
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
    assert "hover" in capsys.readouterr().err


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

def test_numbers_go_by_first_appearance_and_stay():
    clock = Clock()
    presence = AgentPresence(clock)
    forms = {}
    for raw in ("a", "b", "c", "a", "b"):
        clock.now += 1
        forms[raw] = presence.person_form(_event(presence), AGENT, session=raw)
    assert [forms[raw]["session"]["ordinal"] for raw in ("a", "b", "c")] == [1, 2, 3]
    # Gone past the TTL and back: the same number and key.
    key_b = forms["b"]["session"]["key"]
    clock.now += PRESENCE_TTL_SECONDS + 5
    again = presence.person_form(_event(presence), AGENT, session="b")
    assert again["session"] == {"key": key_b, "ordinal": 2}
    fresh = presence.person_form(_event(presence), AGENT, session="d")
    assert fresh["session"]["ordinal"] == 4


def test_the_no_session_cursor_takes_part_and_carries_a_number_only_after_others():
    clock = Clock()
    alone = AgentPresence(clock)
    event = _event(alone)
    assert alone.person_form(event, AGENT, session=None) is event  # one form, as before

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
    keys = dict((raw, presence.session_key(AGENT.id, raw)) for raw in (f"s{n}" for n in range(9)))
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
    # A pruned session keeps its number when it comes back.
    back = presence.person_form(_event(presence), AGENT, session="s3")
    assert back["session"]["ordinal"] == 4


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
    # No session: the person's canvas gets the very same bytes.
    assert _presence_frames(api.person_socket) == [expected]

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
        assert json.dumps(form) == expected
        assert set(session_field) == {"key", "ordinal"}
        assert next(iter(session.values())) not in person  # never the raw id
        # What agents read is the same, from either session.
        assert reads({**CLAUDE, **session}) == before == reads(CLAUDE)

    # Nothing an agent reads names a session or its number anywhere.
    for text in [*reads(CLAUDE), *_presence_frames(api.listener)]:
        assert '"session"' not in text and '"ordinal"' not in text


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


def test_an_edit_with_no_session_and_its_own_action_sends_one_form(sockets):
    api = sockets
    api.client.post("/api/graph/node", headers=CLAUDE, json={"definitionId": "text-input", "params": {}})
    assert _presence_frames(api.person_socket) == _presence_frames(api.listener)


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
