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
import functools
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
#
# A cheap first line, read from main.py's source. conftest.py checks the same
# rule in behaviour, in every test (review 4, LOW-1): a cursor event with a
# target that reaches a ConnectionManager sender other than through
# _broadcast_presence fails the test that sent it.

SENDERS = {"broadcast_raw", "broadcast_others", "broadcast_browser", "_broadcast_raw_quietly",
           "send_text", "send_json"}
POINT_FUNCS = {"_point", "point"}


def _call_name(call: ast.Call) -> str | None:
    func = call.func
    if isinstance(func, ast.Name):
        return func.id
    if isinstance(func, ast.Attribute):
        return func.attr
    return None


def _literal_text(node: ast.AST) -> str | None:
    if isinstance(node, ast.Constant) and isinstance(node.value, str):
        return node.value
    if isinstance(node, ast.JoinedStr) and all(isinstance(v, ast.Constant) for v in node.values):
        return "".join(str(v.value) for v in node.values)  # type: ignore[attr-defined]
    return None


class _Cursors:
    """What counts as a cursor event in one function: see ``is_cursor``."""

    def __init__(self, bindings: list[tuple[ast.AST, ast.AST]], cursor_funcs: set[str] | frozenset[str],
                 point_funcs: set[str] | frozenset[str] = frozenset(POINT_FUNCS)) -> None:
        self.cursor_funcs = cursor_funcs
        self.point_funcs = point_funcs
        self.names: set[str] = set()
        self.senders: set[str] = set(SENDERS)
        # A fixpoint: a name can come from a name assigned later in the source.
        for _ in range(4):
            before = (len(self.names), len(self.senders))
            for target, value in bindings:
                if isinstance(target, ast.Name):
                    if self.is_cursor(value):
                        self.names.add(target.id)
                    if (isinstance(value, ast.Attribute) and value.attr in self.senders) or (
                            isinstance(value, ast.Name) and value.id in self.senders):
                        self.senders.add(target.id)
            if (len(self.names), len(self.senders)) == before:
                break

    @staticmethod
    def bindings(node: ast.AST):
        if isinstance(node, ast.Assign):
            for target in node.targets:
                if isinstance(target, (ast.Tuple, ast.List)) and isinstance(node.value, (ast.Tuple, ast.List)):
                    yield from zip(target.elts, node.value.elts)
                else:
                    yield target, node.value
        elif isinstance(node, ast.AnnAssign) and node.value is not None:
            yield node.target, node.value
        elif isinstance(node, ast.NamedExpr):
            yield node.target, node.value

    def is_cursor(self, node: ast.AST | None) -> bool:
        """A cursor event with a target: ``_point``/``agent_presence.point``
        with a target that isn't the literal None, a call to a function that
        returns one, a name bound to one, a copy of one (``{**e}``,
        ``dict(e)``, ``e.copy()``, ``json.dumps(e)``), or a literal
        ``{"type": "agentPresence", "target": ...}``."""
        if node is None:
            return False
        if isinstance(node, ast.Name):
            return node.id in self.names
        if isinstance(node, ast.NamedExpr):
            return self.is_cursor(node.value)
        if isinstance(node, ast.Dict):
            keys = {_literal_text(k): v for k, v in zip(node.keys, node.values) if k is not None}
            if _literal_text(keys.get("type", ast.Constant(None))) == "agentPresence" and "target" in keys:
                target = keys["target"]
                return not (isinstance(target, ast.Constant) and target.value is None)
            return any(k is None and self.is_cursor(v) for k, v in zip(node.keys, node.values))
        if isinstance(node, ast.Call):
            name = _call_name(node)
            if name in self.point_funcs:
                target = next((kw.value for kw in node.keywords if kw.arg == "target"), None)
                return not (isinstance(target, ast.Constant) and target.value is None)
            if name in self.cursor_funcs:
                return True
            if name in {"dict", "copy", "deepcopy", "dumps"} and node.args:
                return self.is_cursor(node.args[0])
            if name == "copy" and isinstance(node.func, ast.Attribute):
                return self.is_cursor(node.func.value)
        return False


def _functions(tree: ast.AST):
    return [f for f in ast.walk(tree) if isinstance(f, (ast.FunctionDef, ast.AsyncFunctionDef))]


@functools.lru_cache(maxsize=64)
def _parsed(source: str):
    """main.py parsed and walked once per source (review 5, N5: the guard
    took about 6 s): each function with its nodes and its name bindings."""
    functions = []
    for func in _functions(ast.parse(source)):
        nodes = list(ast.walk(func))
        bindings = [pair for node in nodes for pair in _Cursors.bindings(node)]
        functions.append((func, nodes, bindings))
    return functions


def _returning(functions, start: set[str], point_funcs) -> set[str]:
    """Functions that build and return a cursor event (or a person-only
    frame), so one built in one function and sent from another is seen too."""
    found = set(start)
    for _ in range(4):
        grew = False
        for func, nodes, bindings in functions:
            if func.name in point_funcs or func.name in found:
                continue
            returns = [n for n in nodes if isinstance(n, ast.Return) and n.value is not None]
            if not returns:
                continue
            seen = _Cursors(bindings, found, point_funcs)
            if any(seen.is_cursor(n.value) for n in returns):
                found.add(func.name)
                grew = True
        if not grew:
            break
    return found


def cursor_broadcasts_outside_the_helper(source: str) -> list[int]:
    """Lines of main.py that send a cursor event (see ``_Cursors.is_cursor``)
    through a sender (``broadcast_raw``, ``broadcast_others``,
    ``broadcast_browser``, ``_broadcast_raw_quietly``, a socket's
    ``send_text``/``send_json``, or a name bound to one) anywhere but
    ``_broadcast_presence``, and every ``_broadcast_presence(e, e)``, which
    would send the bare form to the person's tabs."""
    functions = _parsed(source)
    cursor_funcs = _returning(functions, set(), POINT_FUNCS)
    bad: list[int] = []
    for func, nodes, bindings in functions:
        if func.name == "_broadcast_presence":
            continue
        seen = _Cursors(bindings, cursor_funcs)
        for node in nodes:
            if not isinstance(node, ast.Call):
                continue
            name = _call_name(node)
            args = [*node.args, *(kw.value for kw in node.keywords)]
            if name in seen.senders and any(seen.is_cursor(arg) for arg in args):
                bad.append(node.lineno)
            elif name == "_broadcast_presence" and len(node.args) >= 2 and seen.is_cursor(node.args[0]) \
                    and ast.dump(node.args[0]) == ast.dump(node.args[1]):
                bad.append(node.lineno)
    return sorted(set(bad))


# What only the person's canvas may get (review 5, LOW-1): a cursor event in
# the person form, and the replay of the live cursors.
PERSON_FUNCS = frozenset({"person_form", "_person_form", "_accepted_person_form", "replay"})


def _dotted(node: ast.AST) -> str | None:
    """``self.p`` as "self.p", a bare name as itself; else None."""
    if isinstance(node, ast.Name):
        return node.id
    if isinstance(node, ast.Attribute):
        inner = _dotted(node.value)
        return f"{inner}.{node.attr}" if inner else None
    return None


def person_only_sends(source: str) -> list[tuple[int, str]]:
    """Every place main.py sends a person-only frame: a call to one of
    PERSON_FUNCS, a name (or ``self.x``) bound to one, a copy of one, a
    function returning one, a dict with a ``"session"`` key built from a
    presence event (a literal ``agentPresence``, a spread, or
    ``e["session"] = ...`` on a bound name), or a replay, literal or
    ``dict(type="agentPresenceReplay", ...)``; read through ``a if c else b``,
    lists and tuples looped over, ``functools.partial(sender, ...)`` and
    ``getattr(manager, "<sender>")`` (review 6, LOW-2). Given to a sender or
    as ``_broadcast_presence``'s first (the other sockets') form. Each comes
    with the function it's in; the one allowed route,
    ``_broadcast_presence``'s ``person`` argument, isn't listed."""
    functions = _parsed(source)
    person_funcs = _returning(functions, set(PERSON_FUNCS), frozenset())

    class _Person(_Cursors):
        def __init__(self, bindings, cursor_funcs, point_funcs, loops):  # type: ignore[no-untyped-def]
            self.loops = loops
            super().__init__(bindings, cursor_funcs, point_funcs)
            # ``e["session"] = ...`` makes ``e`` the person form; a loop over a
            # list or tuple of person-only frames binds its name to one.
            for _ in range(4):
                before = len(self.names)
                for target, value in bindings:
                    if isinstance(target, ast.Subscript) and _literal_text(target.slice) == "session":
                        name = _dotted(target.value)
                        if name:
                            self.names.add(name)
                    name = _dotted(target)
                    if name and self.is_cursor(value):
                        self.names.add(name)
                for target, iterable in self.loops:
                    name = _dotted(target)
                    if name and isinstance(iterable, (ast.List, ast.Tuple, ast.Set)) and any(self.is_cursor(e) for e in iterable.elts):
                        self.names.add(name)
                if len(self.names) == before:
                    break

        def is_cursor(self, node):  # type: ignore[no-untyped-def]
            if isinstance(node, ast.Attribute):
                return _dotted(node) in self.names
            if isinstance(node, ast.IfExp):
                return self.is_cursor(node.body) or self.is_cursor(node.orelse)
            if isinstance(node, (ast.List, ast.Tuple, ast.Set)):
                return any(self.is_cursor(e) for e in node.elts)
            if isinstance(node, ast.Dict):
                keys = {_literal_text(k): v for k, v in zip(node.keys, node.values) if k is not None}
                kind = _literal_text(keys.get("type", ast.Constant(None)))
                if kind == "agentPresenceReplay":
                    return True
                if "session" in keys and (kind == "agentPresence" or any(k is None for k in node.keys)):
                    return True
                return any(self.is_cursor(v) for v in node.values if v is not None)
            if isinstance(node, ast.Call) and _call_name(node) == "dict":
                kw = {k.arg: k.value for k in node.keywords if k.arg is not None}
                if _literal_text(kw.get("type", ast.Constant(None))) == "agentPresenceReplay":
                    return True
                if "session" in kw and (node.args or _literal_text(kw.get("type", ast.Constant(None))) == "agentPresence"):
                    return True
            return super().is_cursor(node)

    def sender_call(node: ast.Call, seen: _Cursors) -> list[ast.AST] | None:
        """The frames a call sends, if it is a sender's: by name, through
        ``getattr(x, "<sender>")``, or ``functools.partial(sender, ...)``."""
        args = [*node.args, *(kw.value for kw in node.keywords)]
        if _call_name(node) in seen.senders:
            return args
        inner = node.func
        if isinstance(inner, ast.Call):
            if _call_name(inner) == "getattr" and len(inner.args) >= 2 and _literal_text(inner.args[1]) in seen.senders:
                return args
            if _call_name(inner) == "partial" and inner.args:
                first = inner.args[0]
                name = first.attr if isinstance(first, ast.Attribute) else first.id if isinstance(first, ast.Name) else None
                if name in seen.senders:
                    return [*inner.args[1:], *(kw.value for kw in inner.keywords), *args]
        return None

    found: list[tuple[int, str]] = []
    for func, nodes, bindings in functions:
        if func.name == "_broadcast_presence":
            continue
        loops = [(n.target, n.iter) for n in nodes if isinstance(n, (ast.For, ast.AsyncFor, ast.comprehension))]
        seen = _Person(bindings, person_funcs, frozenset(), loops)
        for node in nodes:
            if not isinstance(node, ast.Call):
                continue
            name = _call_name(node)
            if name == "_broadcast_presence":
                if node.args and seen.is_cursor(node.args[0]):
                    found.append((node.lineno, func.name))
                continue
            args = sender_call(node, seen)
            if args is not None and any(seen.is_cursor(arg) for arg in args):
                found.append((node.lineno, func.name))
    return sorted(set(found))


GUARD_SHAPES = {
    "direct": "await manager.broadcast_raw(_point(i, target=t, action='click'))",
    "named": "e = _point(i, target={'nodeId': n})\n    await manager.broadcast_raw(e)",
    "others": "e = _point(i, target=t)\n    await manager.broadcast_others(e)",
    "as others=": "e = _point(i, target=t)\n    await manager.broadcast_raw(p, others=e)",
    "quiet helper": "e = _point(i, target=t)\n    await _broadcast_raw_quietly(e)",
    "browser": "e = _point(i, target=t)\n    await manager.broadcast_browser(e)",
    "one form both ways": "e = _point(i, target=t)\n    await _broadcast_presence(e, e)",
    "annotated": "e: dict = _point(i, target=t)\n    await manager.broadcast_raw(e)",
    "spread copy": "e = _point(i, target=t)\n    await manager.broadcast_raw({**e})",
    "dict copy": "e = _point(i, target=t)\n    await manager.broadcast_raw(dict(e))",
    "method copy": "e = _point(i, target=t)\n    await manager.broadcast_raw(e.copy())",
    "walrus": "await manager.broadcast_raw((e := _point(i, target=t)))",
    "tuple": "e, f = _point(i, target=t), 1\n    await manager.broadcast_raw(e)",
    "alias": "send = manager.broadcast_raw\n    await send(_point(i, target=t))",
    "presence module": "await manager.broadcast_raw(agent_presence.point(i, target=t))",
    "literal": "await manager.broadcast_raw({'type': 'agentPresence', 'target': t})",
    "f-string": "await manager.broadcast_raw({'type': f'agentPresence', 'target': t})",
    "gather": "await asyncio.gather(manager.broadcast_raw(_point(i, target=t)))",
    "socket": "await ws.send_text(json.dumps(_point(i, target=t)))",
    "from another function": "await manager.broadcast_raw(build())",
    # Bound from a name assigned further down (a loop body): the fixpoint's second pass.
    "bound later": "f = e\n    e = _point(i, target=t)\n    await manager.broadcast_raw(f)",
}


def test_no_cursor_event_is_broadcast_outside_broadcast_presence():
    source = (Path(__file__).resolve().parents[1] / "main.py").read_text(encoding="utf-8")
    assert cursor_broadcasts_outside_the_helper(source) == []
    # The two target=None emitters (the Agent log only) stay allowed.
    assert source.count("broadcast_raw(_point(") == 2


@pytest.mark.parametrize("shape", GUARD_SHAPES.values(), ids=GUARD_SHAPES.keys())
def test_the_guard_catches_every_shape_review_4_found(shape):
    helper = "def build():\n    return _point(i, target=t)\n\n"
    source = f"{helper}async def f():\n    {shape}\n"
    lines = cursor_broadcasts_outside_the_helper(source)
    assert lines == [len(source.splitlines())], (shape, lines)  # the send, the last line


@pytest.mark.parametrize("shape", [
    "await manager.broadcast_raw(_point(i, target=None, say='x'))",
    "await manager.broadcast_raw({'type': 'agentPresence', 'target': None})",
    "e = _point(i, target=t)\n    await _broadcast_presence(e, person)",
    "await manager.broadcast_raw({'type': 'graphSync', 'target': t})",
], ids=["no target", "literal no target", "through the helper", "not a cursor"])
def test_the_guard_lets_the_allowed_shapes_through(shape):
    assert cursor_broadcasts_outside_the_helper(f"async def f():\n    {shape}\n") == []


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


# -- round 4b: the accept past the agent memory, one clock read, a failure ------

CODEX = {"X-Nebula-Agent": "Codex"}


def test_no_accepted_click_for_an_agent_past_the_agent_memory(sockets, monkeypatch):
    """GM - Design, PR #211 review 4 (3): its cursor is the unnumbered one,
    which can't be tied to the proposing session, so the person's tabs get no
    click; agents still read the agent form."""
    api = sockets
    monkeypatch.setattr(presence_module, "SESSION_AGENT_MEMORY", 1)
    node = api.graph.add_node("text-input", {"value": "hi"})
    other = api.client.post("/api/canvas/cursor", headers=CODEX, json={"target": {"nodeId": node}, "action": "look"})
    assert other.status_code == 200, other.text
    proposal_id = _propose(api, node, {})
    (*_, proposing) = _frames(api.person_socket)
    assert proposing["action"] == "propose" and "session" not in proposing  # past the memory: unnumbered
    api.person_socket.sent.clear()
    api.listener.sent.clear()

    _accept(api, proposal_id)
    assert _frames(api.person_socket) == []
    (agent_frame,) = _frames(api.listener)
    assert agent_frame["say"] == "Accepted" and "session" not in agent_frame


def test_an_accepted_click_reads_liveness_and_the_slot_at_one_time():
    """Review 4, NIT-1: the live check and the slot it lands on are read with
    one clock read, so a TTL running out between two reads can't bring a
    cursor back for an ended session."""
    clock = Clock()
    presence = AgentPresence(clock)
    presence.person_form(presence.point(AGENT, target={"x": 1, "y": 1}), AGENT, session="a")
    reads = []

    def ticking() -> float:
        reads.append(clock.now)
        clock.now += 1.0
        return clock.now - 1.0

    # point() reads the clock once (+1 s); person_form's read then finds the
    # slot 0.5 s inside the TTL, and a second read would find it gone.
    clock.now += PRESENCE_TTL_SECONDS - 1.5
    presence._clock = ticking
    event = presence.point(AGENT, target={"x": 2, "y": 2})
    reads.clear()
    form = presence.person_form(event, AGENT, session="a", live_only=True)
    assert len(reads) == 1
    assert form is not None and form["session"]["ordinal"] == 1
    clock.now += PRESENCE_TTL_SECONDS + 1
    assert presence.person_form(event, AGENT, session="a", live_only=True) is None
    assert presence.person_form(event, AGENT, session="never", live_only=True) is None
    assert len(presence.live_sessions(AGENT.id)) == 1  # no slot was made for either


def test_a_failed_accepted_person_form_sends_the_person_nothing(sockets, monkeypatch):
    """Review 4, NIT-2 (R15): on a failure the person's tabs get no click,
    never the bare agent form (a tab would draw it as the plain cursor)."""
    api = sockets
    node = api.graph.add_node("text-input", {"value": "hi"})
    proposal_id = _propose(api, node, LANE_B)
    api.person_socket.sent.clear()
    api.listener.sent.clear()
    real = api.main.agent_presence.person_form

    def broken(*args, **kwargs):  # noqa: ANN001, ANN202
        if kwargs.get("live_only"):
            raise RuntimeError("boom")
        return real(*args, **kwargs)

    monkeypatch.setattr(api.main.agent_presence, "person_form", broken)
    _accept(api, proposal_id)
    assert _frames(api.person_socket) == []
    (agent_frame,) = _frames(api.listener)
    assert agent_frame["say"] == "Accepted" and "session" not in agent_frame


def test_the_runtime_guard_fails_a_cursor_event_sent_around_the_helper(sockets):
    """conftest.py's check (review 4, LOW-1), run here by hand: a targeted
    cursor event sent straight to broadcast_raw is recorded; one through
    _broadcast_presence, and one with no target, are not."""
    import asyncio

    from tests.conftest import watch_cursor_routes

    api = sockets
    with watch_cursor_routes() as stray:
        event = api.main.agent_presence.point(AGENT, target={"x": 1, "y": 1})
        log_only = api.main.agent_presence.point(AGENT, target=None, say="x")
        asyncio.run(api.main._broadcast_presence(event, event))
        asyncio.run(api.main.manager.broadcast_raw(log_only))
        assert stray == []
        asyncio.run(api.main.manager.broadcast_raw(event))
        asyncio.run(api.main.manager.broadcast_browser({**event}))
        asyncio.run(api.main.manager.broadcast_raw({"type": "x"}, others=event))
    assert [line.split(":")[0] for line in stray] == ["broadcast_raw", "broadcast_browser", "broadcast_raw"]


def test_the_check_fails_a_test_that_sends_a_stray_cursor_event(tmp_path):
    """The hook itself: a test that sends a targeted cursor event around
    _broadcast_presence fails, in its own pytest run."""
    import os
    import subprocess
    import sys

    probe = tmp_path / "test_stray_probe.py"
    probe.write_text(
        "import asyncio\n"
        "import main\n"
        "from services.agent_presence import AgentIdentity\n\n"
        "def test_sends_around_the_helper():\n"
        "    agent = AgentIdentity(id='ext:x', name='X', color='#3FC1A5', verified=False)\n"
        "    event = main.agent_presence.point(agent, target={'x': 1, 'y': 1})\n"
        "    asyncio.run(main.manager.broadcast_raw(event))\n",
        encoding="utf-8",
    )
    backend = Path(__file__).resolve().parents[1]
    run = subprocess.run(
        [sys.executable, "-m", "pytest", "-q", "-p", "no:cacheprovider", "-p", "tests.conftest",
         "--rootdir", str(tmp_path), str(probe)],
        cwd=backend, capture_output=True, text=True, timeout=300,
        # Without CI's shard split: the probe file is one file and must run whatever shard this is.
        env={**{k: v for k, v in os.environ.items() if k != "NEBULA_TEST_SHARD"}, "PYTHONPATH": str(backend)},
    )
    assert run.returncode != 0, run.stdout[-2000:]
    assert "other than through main._broadcast_presence" in run.stdout, run.stdout[-2000:]
