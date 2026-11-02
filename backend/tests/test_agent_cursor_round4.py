"""Agent cursors, PR #211 round 4 (review 3 and GM - Design's r9 answers).

- MEDIUM-1: a pin reply and an accepted proposal reach the person's tabs in
  the person form, on the right session's cursor, and are in the replay, so
  no tab draws a second cursor with the same name and later tabs agree.
- GM 1: "Accepted" lands on the cursor of the session that proposed it,
  recorded on the proposal, person side only. When that session has left by
  the accept, the person's tabs get no click.
- A guard: no ``broadcast_raw`` in main.py sends a cursor event with a
  target outside ``_broadcast_presence``.
- LOW-3 (B24): the replay ages ``did.secondsAgo``.
- NIT-2: past the agent cap, the replay has no cursor for that agent.
"""
from __future__ import annotations

import ast
import json
from pathlib import Path

import pytest

from services import agent_presence as presence_module
from services.agent_presence import PRESENCE_TTL_SECONDS, AgentIdentity, AgentPresence
from tests.conftest import PERSON
from tests.test_agent_cursor_sessions import (  # noqa: F401 - fixtures
    CLAUDE,
    MCP_SESSION,
    Clock,
    _connect,
    _presence_frames,
    api,
    sockets,
)

LANE_A = {"X-Nebula-Agent-Session": "lane-a"}
LANE_B = {"X-Nebula-Agent-Session": "lane-b"}


def _frames(socket) -> list[dict]:
    return [json.loads(text) for text in _presence_frames(socket)]


def _replay(api, person) -> list[dict]:  # noqa: F811
    sent = _connect(api, [{"type": "hello", "personToken": person.token}])
    return next(m for m in sent if m["type"] == "agentPresenceReplay")["cursors"]


def _look(api, node, headers):  # noqa: F811
    response = api.client.post("/api/canvas/cursor", headers={**CLAUDE, **headers},
                               json={"target": {"nodeId": node}, "action": "look"})
    assert response.status_code == 200, response.text


# -- MEDIUM-1: the pin reply ---------------------------------------------------

@pytest.mark.parametrize("headers", [{}, LANE_B], ids=["plain", "session"])
def test_a_pin_reply_lands_on_the_resolving_sessions_own_cursor_and_is_replayed(sockets, person, headers):
    api = sockets
    node = api.graph.add_node("text-input", {"value": "hi"})
    _look(api, node, LANE_A)
    _look(api, node, headers)
    (*_, mine) = _frames(api.person_socket)
    pin = api.client.post("/api/canvas/pins", headers=PERSON, json={"text": "warmer", "nodeId": node}).json()["pin"]
    api.person_socket.sent.clear()
    api.listener.sent.clear()

    resolved = api.client.post(f"/api/canvas/pins/{pin['id']}/resolve", headers={**CLAUDE, **headers},
                               json={"reply": "Warmed"})
    assert resolved.status_code == 200, resolved.text
    (person_frame,) = _frames(api.person_socket)
    (agent_frame,) = _frames(api.listener)
    # The person's tab: the resolving session's own cursor, its key and number.
    assert person_frame["session"] == mine["session"]
    assert person_frame["say"] == "Warmed" and person_frame["target"] == {"nodeId": node}
    # Agents read the agent form exactly, with no session.
    assert "session" not in agent_frame
    assert {k: v for k, v in person_frame.items() if k != "session"} == agent_frame

    # A tab opened later shows the same cursors: the reply is in the replay,
    # under the same key, and no cursor is there twice.
    cursors = _replay(api, person)
    keys = [c["session"]["key"] for c in cursors]
    assert len(keys) == len(set(keys)) == 2
    replayed = next(c for c in cursors if c["session"]["key"] == mine["session"]["key"])
    assert replayed["say"] == "Warmed" and replayed["session"]["ordinal"] == mine["session"]["ordinal"]


# -- MEDIUM-1 and GM 1: the accepted proposal ------------------------------------

def _accept_key(api, proposal_id: str) -> str:  # noqa: F811
    return api.main.canvas_proposals.get(proposal_id).accept_key


def _propose(api, node, headers) -> str:  # noqa: F811
    body = {"note": "Add a second prompt", "nodes": [{"ref": "+t", "definitionId": "text-input",
                                                       "params": {"value": "two"}}]}
    response = api.client.post("/api/canvas/proposals", headers={**CLAUDE, **headers}, json=body)
    assert response.status_code == 201, response.text
    return response.json()["proposal"]["id"]


def _accept(api, proposal_id: str) -> None:  # noqa: F811
    key = _accept_key(api, proposal_id)
    accepted = api.client.post(f"/api/canvas/proposals/{proposal_id}/accept",
                               headers={**PERSON, "X-Nebula-Proposal-Key": key}, json={})
    assert accepted.status_code == 200, accepted.text


@pytest.mark.parametrize("headers", [{}, LANE_B], ids=["plain", "session"])
def test_accepted_lands_on_the_proposing_sessions_cursor_while_it_is_live(sockets, person, headers):
    api = sockets
    node = api.graph.add_node("text-input", {"value": "hi"})
    _look(api, node, LANE_A)
    proposal_id = _propose(api, node, headers)
    (*_, proposing) = _frames(api.person_socket)
    assert proposing["action"] == "propose"
    # Another session of the same agent acts in between: "Accepted" still
    # goes to the cursor that proposed, not the agent's latest.
    _look(api, node, LANE_A)
    api.person_socket.sent.clear()
    api.listener.sent.clear()

    _accept(api, proposal_id)
    (person_frame,) = _frames(api.person_socket)
    (agent_frame,) = _frames(api.listener)
    assert person_frame["say"] == "Accepted" and person_frame["action"] == "click"
    assert person_frame["session"] == proposing["session"]
    assert "session" not in agent_frame
    assert {k: v for k, v in person_frame.items() if k != "session"} == agent_frame
    replayed = [c for c in _replay(api, person) if c["session"]["key"] == proposing["session"]["key"]]
    assert [c["say"] for c in replayed] == ["Accepted"]
    assert len(_replay(api, person)) == 2


@pytest.mark.parametrize("headers", [{}, LANE_B], ids=["plain", "session"])
def test_no_accepted_click_on_the_persons_tabs_when_the_proposing_session_has_left(sockets, person, headers):
    api = sockets
    node = api.graph.add_node("text-input", {"value": "hi"})
    proposal_id = _propose(api, node, headers)
    # The proposing session goes quiet past the TTL while lane a stays live.
    for _ in range(5):
        api.presence_clock.now += 30
        _look(api, node, LANE_A)
    before = {c["session"]["key"] for c in _replay(api, person)}
    api.person_socket.sent.clear()
    api.listener.sent.clear()

    _accept(api, proposal_id)
    # No cursor click on the person's tab, and no cursor comes back for it.
    assert _frames(api.person_socket) == []
    assert {c["session"]["key"] for c in _replay(api, person)} == before
    assert len(before) == 1
    # Agents still read the agent form, as before.
    (agent_frame,) = _frames(api.listener)
    assert agent_frame["say"] == "Accepted" and "session" not in agent_frame


def test_the_proposing_session_never_reaches_an_agent(sockets, person):
    api = sockets
    node = api.graph.add_node("text-input", {"value": "hi"})
    raw = "lane-secret-7f3a"
    proposal_id = _propose(api, node, {"X-Nebula-Agent-Session": raw})
    assert api.main.canvas_proposals.get(proposal_id).presence_session == raw
    assert raw not in repr(api.main.canvas_proposals.get(proposal_id))
    surfaces = [
        json.dumps(api.client.get(path, headers=CLAUDE).json())
        for path in ("/api/canvas/proposals", f"/api/canvas/proposals/{proposal_id}",
                     "/api/canvas/snapshot", "/api/canvas/agents", "/api/agent/start")
    ]
    surfaces.append(json.dumps(api.main._proposal_view(api.main.canvas_proposals.get(proposal_id))))
    surfaces.append(json.dumps(api.main.canvas_proposals.brief(api.main.canvas_proposals.get(proposal_id))))
    surfaces += [json.dumps(json.loads(text)) for text in api.listener.sent]
    surfaces.append(json.dumps(api.main.canvas_events.read(after=0)))
    # The person's own sockets carry only the opaque key, never the raw id.
    surfaces += api.person_socket.sent
    _accept(api, proposal_id)
    surfaces += api.listener.sent + api.person_socket.sent
    surfaces += [json.dumps(m) for m in _connect(api, [{"type": "hello", "personToken": person.token}])]
    for text in surfaces:
        assert raw not in text
        assert "presence_session" not in text and "presenceSession" not in text


# -- the guard ---------------------------------------------------------------------

def _point_targets(call: ast.Call) -> ast.expr | None:
    """The ``target=`` given to a ``_point(...)`` call, or None when absent."""
    return next((kw.value for kw in call.keywords if kw.arg == "target"), None)


def _is_point(node: ast.AST) -> bool:
    return isinstance(node, ast.Call) and isinstance(node.func, ast.Name) and node.func.id == "_point"


def _cursor_point(node: ast.AST) -> bool:
    """A ``_point`` call whose target isn't the literal None: a cursor event."""
    if not _is_point(node):
        return False
    target = _point_targets(node)
    return not (isinstance(target, ast.Constant) and target.value is None)


def cursor_broadcasts_outside_the_helper(source: str) -> list[int]:
    """Lines of main.py where ``broadcast_raw``/``broadcast_others`` sends a
    cursor event (``_point`` with a target, directly or through a name
    assigned from one in the same function) anywhere but
    ``_broadcast_presence``."""
    tree = ast.parse(source)
    bad: list[int] = []
    for func in ast.walk(tree):
        if not isinstance(func, (ast.FunctionDef, ast.AsyncFunctionDef)) or func.name == "_broadcast_presence":
            continue
        cursor_names = {
            target.id
            for node in ast.walk(func) if isinstance(node, ast.Assign) and _cursor_point(node.value)
            for target in node.targets if isinstance(target, ast.Name)
        }
        for node in ast.walk(func):
            if not (isinstance(node, ast.Call) and isinstance(node.func, ast.Attribute)
                    and node.func.attr in {"broadcast_raw", "broadcast_others"}):
                continue
            args = [*node.args, *(kw.value for kw in node.keywords)]
            if any(_cursor_point(arg) or (isinstance(arg, ast.Name) and arg.id in cursor_names) for arg in args):
                bad.append(node.lineno)
    return sorted(set(bad))


def test_no_cursor_event_is_broadcast_outside_broadcast_presence():
    source = (Path(__file__).resolve().parents[1] / "main.py").read_text(encoding="utf-8")
    assert cursor_broadcasts_outside_the_helper(source) == []
    # The two target=None emitters (the Agent log only) stay allowed.
    assert source.count("broadcast_raw(_point(") == 2
    # The guard itself catches each shape round 3 had.
    for shape in (
        "async def f():\n    await manager.broadcast_raw(_point(i, target=t, action='click'))\n",
        "async def f():\n    e = _point(i, target={'nodeId': n})\n    await manager.broadcast_raw(e)\n",
        "async def f():\n    e = _point(i, target=t)\n    await manager.broadcast_others(e)\n",
        "async def f():\n    e = _point(i, target=t)\n    await manager.broadcast_raw(p, others=e)\n",
    ):
        assert cursor_broadcasts_outside_the_helper(shape) == [2 + shape.count("\n    e =")], shape
    ok = "async def f():\n    await manager.broadcast_raw(_point(i, target=None, say='x'))\n"
    assert cursor_broadcasts_outside_the_helper(ok) == []


# -- LOW-3 (B24) and NIT-2 ------------------------------------------------------

AGENT = AgentIdentity(id="ext:claude-code", name="Claude Code", color="#3FC1A5", verified=False)


def test_the_replay_ages_the_last_actions_time_by_the_cursors_age():
    clock = Clock()
    presence = AgentPresence(clock)
    event = presence.point(AGENT, target={"x": 1, "y": 1}, did={"verb": "Added", "label": "Brief"})
    presence.person_form(event, AGENT, session="a")
    clock.now += 2.5
    event = presence.point(AGENT, target={"x": 4, "y": 4})  # carries the action, 2.5 s old
    presence.person_form(event, AGENT, session="a")
    clock.now += 40
    (cursor,) = presence.replay()
    assert cursor["secondsAgo"] == 40.0
    assert cursor["did"]["secondsAgo"] == 42.5


def test_past_the_agent_cap_the_replay_has_no_cursor_for_that_agent(monkeypatch):
    """NIT-2, documented: an agent past SESSION_AGENT_MEMORY gets the plain
    cursor with no session (GM r5, "until room frees"), and nothing is kept
    for it, so a tab that connects now shows it only from its next event."""
    monkeypatch.setattr(presence_module, "SESSION_AGENT_MEMORY", 2)
    clock = Clock()
    presence = AgentPresence(clock)
    agents = [AgentIdentity(id=f"ext:x{n}", name=f"X{n}", color="#3FC1A5", verified=False) for n in range(3)]
    for agent in agents:
        form = presence.person_form(presence.point(agent, target={"x": 1, "y": 1}), agent, session=None)
        clock.now += 1
    assert "session" not in form  # the third: past the cap
    assert [c["agent"]["id"] for c in presence.replay()] == ["ext:x0", "ext:x1"]
    # Room frees when the first two leave; the third's next event is numbered and replayed.
    clock.now += PRESENCE_TTL_SECONDS + 1
    form = presence.person_form(presence.point(agents[2], target={"x": 2, "y": 2}), agents[2], session=None)
    assert form["session"]["ordinal"] == 1
    assert [c["agent"]["id"] for c in presence.replay()] == ["ext:x2"]
