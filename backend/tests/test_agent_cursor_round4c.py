"""Agent cursors, PR #211 round 4c (review 5).

- M3 / MEDIUM-1: conftest's cursor checks are installed before any fixture,
  so a fixture that patches ``main.manager.broadcast_raw`` can't blind them,
  and every cursor test file passes run alone, in its own pytest run.
- LOW-1: the checks read the content too. No person-only frame (a cursor
  event with ``session``, or the replay) reaches a socket that isn't the
  person's canvas: through the real senders, an instance-level stand-in, or
  in main.py's source.
- N1: ``person_form(live_only=True)``'s TTL edge.

Tests only: the backend's boundary (person_gate, scene_keys, person_session,
the read boundaries) is unchanged.
"""
from __future__ import annotations

import asyncio
import os
import subprocess
import sys
from pathlib import Path

import pytest

from services.agent_presence import PRESENCE_TTL_SECONDS, AgentIdentity, AgentPresence
from tests.conftest import BroadcastCapture, person_only_frame, watch_cursor_routes
from tests.test_agent_cursor_round4 import person_only_sends
from tests.test_agent_cursor_sessions import Clock, api, sockets  # noqa: F401 - fixtures

BACKEND = Path(__file__).resolve().parents[1]
AGENT = AgentIdentity(id="ext:claude-code", name="Claude Code", color="#3FC1A5", verified=False)


def _pytest_alone(*args: str) -> subprocess.CompletedProcess[str]:
    """A pytest run of its own, without CI's shard split (the files named
    must run whatever shard this test is in)."""
    env = {k: v for k, v in os.environ.items() if k != "NEBULA_TEST_SHARD"}
    return subprocess.run(
        [sys.executable, "-m", "pytest", "-q", "-p", "no:cacheprovider", *args],
        cwd=BACKEND, capture_output=True, text=True, timeout=600, env={**env, "PYTHONPATH": str(BACKEND)},
    )


# -- M3: each cursor file passes alone, and a patching fixture can't blind the check

@pytest.mark.parametrize("name", [
    "test_agent_cursor_sessions.py", "test_agent_cursor_review2.py", "test_agent_cursor_round4.py",
])
def test_each_cursor_file_passes_run_alone(name):
    run = _pytest_alone(f"tests/{name}")
    assert run.returncode == 0, run.stdout[-3000:]
    assert " passed" in run.stdout and " failed" not in run.stdout, run.stdout[-3000:]


def test_a_fixture_that_patches_broadcast_raw_cant_blind_the_check(tmp_path):
    """Review 5, M3: a fixture saved the unwrapped sender and its undo left it
    on the manager instance, so later tests sent around the check. Here the
    first test's fixture patches broadcast_raw; the two after it each send
    around the helper (one stray cursor event, one person-only frame to
    the other sockets) and must fail, and nothing stale is left behind."""
    probe = tmp_path / "test_blind_probe.py"
    probe.write_text(
        "import asyncio\n"
        "import pytest\n"
        "import main\n"
        "from services.agent_presence import AgentIdentity\n"
        "from tests.conftest import BroadcastCapture\n\n"
        "AGENT = AgentIdentity(id='ext:x', name='X', color='#3FC1A5', verified=False)\n\n"
        "@pytest.fixture\n"
        "def patched(monkeypatch):\n"
        "    monkeypatch.setattr(main.manager, 'broadcast_raw', BroadcastCapture())\n\n"
        "def test_a_uses_the_patching_fixture(patched):\n"
        "    assert True\n\n"
        "def test_b_stray_cursor_after_it():\n"
        "    assert 'broadcast_raw' not in vars(main.manager)\n"
        "    event = main.agent_presence.point(AGENT, target={'x': 1, 'y': 1})\n"
        "    asyncio.run(main.manager.broadcast_raw(event))\n\n"
        "def test_c_person_form_to_the_others_after_it(patched):\n"
        "    event = main.agent_presence.point(AGENT, target=None, say='x')\n"
        "    asyncio.run(main.manager.broadcast_raw({'type': 'x'}, others={**event, 'session': {'key': 'k', 'ordinal': 2}}))\n",
        encoding="utf-8",
    )
    run = _pytest_alone("-p", "tests.conftest", "--rootdir", str(tmp_path), str(probe))
    out = run.stdout
    assert run.returncode != 0, out[-3000:]
    assert "1 passed" in out and "2 failed" in out, out[-3000:]
    # Each failed on the check (its message names the test), not on an assert of its own.
    assert "test_b_stray_cursor_after_it: a cursor event with a target went out" in out, out[-3000:]
    assert "test_c_person_form_to_the_others_after_it: a cursor event with a target went out" in out, out[-3000:]
    assert "broadcast_raw (a stand-in): a person-only frame for the other sockets" in out, out[-3000:]


def test_the_check_is_in_before_any_fixture_runs(tmp_path):
    """Review 5, M3, the fix itself: the senders are checked before the first
    fixture, and a fixture that imports main itself and patches a sender
    saves (so puts back) the checked one. Each probe runs in a pytest of its
    own, so nothing imported main earlier."""
    probe = tmp_path / "test_early_probe.py"
    probe.write_text(
        "import pytest\n"
        "import main\n\n"
        "@pytest.fixture\n"
        "def seen():\n"
        "    return getattr(main.ConnectionManager.__dict__['broadcast_raw'], '_nebula_cursor_route', False)\n\n"
        "def test_checked_before_fixtures(seen):\n"
        "    assert seen\n",
        encoding="utf-8",
    )
    # Checked by behaviour, not by pytest's private record of what it saved
    # (pytest 9.2 records an instance attribute that isn't in __dict__ as
    # NOTSET and deletes it on undo; 9.0 saved the bound method). Either way,
    # once the patching fixture is undone the sender in use must be the checked one.
    lazy = tmp_path / "test_lazy_probe.py"
    lazy.write_text(
        "import pytest\n\n"
        "@pytest.fixture\n"
        "def patched(monkeypatch):\n"
        "    import main\n"
        "    async def fake(data, **kw):\n"
        "        return None\n"
        "    monkeypatch.setattr(main.manager, 'broadcast_raw', fake)\n"
        "    return fake\n\n"
        "def test_a_lazy_fixture_patches_a_sender(patched):\n"
        "    assert patched  # the check wraps the stand-in; what matters is what comes back\n\n"
        "def test_after_it_the_checked_sender_is_back():\n"
        "    import main\n"
        "    sender = main.manager.broadcast_raw\n"
        "    assert getattr(getattr(sender, '__func__', sender), '_nebula_cursor_route', False)\n",
        encoding="utf-8",
    )
    for path, passed in ((probe, "1 passed"), (lazy, "2 passed")):
        run = _pytest_alone("-p", "tests.conftest", "--rootdir", str(tmp_path), str(path))
        assert run.returncode == 0 and passed in run.stdout, run.stdout[-3000:]


# -- LOW-1: the content, at run time --------------------------------------------

def _person(presence: AgentPresence, session: str = "a") -> tuple[dict, dict]:
    event = presence.point(AGENT, target={"x": 1, "y": 1})
    return event, presence.person_form(event, AGENT, session=session)


def test_a_person_only_frame_is_recorded_on_its_way_to_the_other_sockets(sockets):
    api = sockets
    event, person = _person(api.main.agent_presence)
    replay = {"type": "agentPresenceReplay", "cursors": api.main.agent_presence.replay()}
    assert person_only_frame(person) and person_only_frame(replay) and not person_only_frame(event)
    manager = api.main.manager

    async def through_the_route(event, person):
        await api.main._broadcast_presence(event, person)

    with watch_cursor_routes() as stray:
        asyncio.run(through_the_route(event, person))  # person form to the person, agent form to the rest
        asyncio.run(manager.broadcast_browser(replay))  # the person's canvas only
        assert stray == []
        asyncio.run(through_the_route(person, person))  # the person form to everyone
        asyncio.run(manager.broadcast_others(replay))
        asyncio.run(manager.broadcast_raw({"type": "x"}, others=person))
    content = [line for line in stray if "a person-only frame for the other sockets" in line]
    assert len(content) == 3, stray
    # The last one also went around the helper with a target: the route check's too.
    assert len(stray) == 4 and "broadcast_raw: {'type': 'x'}" in stray, stray
    # The listener got the three it was sent (the check records; the backend
    # refuses nothing), and nothing person-only from the clean pass.
    assert sum('"session"' in text for text in api.listener.sent) == 3


def test_an_instance_level_stand_in_is_checked_too(sockets, monkeypatch):
    """A stand-in on the manager instance shadows the checked class method:
    it is wrapped as it goes in, and both checks see what it is sent."""
    api = sockets
    event, person = _person(api.main.agent_presence)
    capture = BroadcastCapture()
    monkeypatch.setattr(api.main.manager, "broadcast_raw", capture)
    with watch_cursor_routes() as stray:
        asyncio.run(api.main._broadcast_presence(event, person))
        assert stray == [] and capture.sent == [person] and capture.others == [event]
        asyncio.run(api.main.manager.broadcast_raw(person))  # around the helper, person form to all
    assert [line.split(":")[0] for line in stray] == ["broadcast_raw (a stand-in)"] * 2, stray
    assert "other than" not in stray[0] and "a person-only frame" in stray[1]
    assert capture.sent[-1] == person  # still delivered to the stand-in


def test_an_asyncmock_stand_in_is_checked_and_still_reads_as_the_mock(sockets, monkeypatch):
    """Review 6, MEDIUM-1: a Mock makes up any attribute, the check's marker
    too, so it used to pass as checked and go unwrapped (16 files patch a
    sender with AsyncMock). It is wrapped now, and the test still reads the
    mock's own attributes through the wrapper."""
    from unittest.mock import AsyncMock

    api = sockets
    event, person = _person(api.main.agent_presence)
    fake = AsyncMock()
    monkeypatch.setattr(api.main.manager, "broadcast_raw", fake)
    wrapped = vars(api.main.manager)["broadcast_raw"]
    assert wrapped is not fake and getattr(wrapped, "_nebula_cursor_route", None) is True
    with watch_cursor_routes() as stray:
        asyncio.run(api.main.manager.broadcast_raw(person))  # the person form to every socket
    # Both checks: it went around the route with a target, and it is person-only.
    assert [line.split(":")[0] for line in stray] == ["broadcast_raw (a stand-in)"] * 2, stray
    assert "a person-only frame for the other sockets" in stray[1], stray
    # The mock got it, and reads as itself: await_args, assert_awaited_once_with.
    assert api.main.manager.broadcast_raw.await_args.args == (person,)
    api.main.manager.broadcast_raw.assert_awaited_once_with(person)
    # A stand-in that rebinds an attribute later is read as it is now (N4).
    fake.calls = ["later"]
    assert api.main.manager.broadcast_raw.calls == ["later"]
    # And one set through it lands on the stand-in.
    api.main.manager.broadcast_raw.marker = 1
    assert fake.marker == 1


def test_a_stand_in_marked_by_hand_is_still_wrapped_and_reads_as_itself(sockets, monkeypatch):
    """Review 7, NIT-1 and NIT-4: the marker alone no longer passes a stand-in
    unwrapped; the wrapper shows the stand-in in its repr, and deleting an
    attribute through it deletes it on the stand-in."""
    from unittest.mock import AsyncMock

    api = sockets
    _, person = _person(api.main.agent_presence)
    fake = AsyncMock()
    fake._nebula_cursor_route = True
    monkeypatch.setattr(api.main.manager, "broadcast_others", fake)
    wrapped = vars(api.main.manager)["broadcast_others"]
    assert wrapped is not fake
    assert repr(wrapped) == f"<checked {fake!r}>"
    with watch_cursor_routes() as stray:
        asyncio.run(api.main.manager.broadcast_others(person))
    assert any("a person-only frame for the other sockets" in line for line in stray), stray
    wrapped.marker = 1
    del wrapped.marker
    assert "marker" not in vars(fake)
    # Already checked: set again, it isn't wrapped twice.
    monkeypatch.setattr(api.main.manager, "broadcast_others", wrapped)
    assert vars(api.main.manager)["broadcast_others"] is wrapped


def test_a_magicmock_stand_in_sent_the_agent_form_is_left_alone(sockets, monkeypatch):
    from unittest.mock import MagicMock

    api = sockets
    event, _ = _person(api.main.agent_presence)
    fake = MagicMock()
    monkeypatch.setattr(api.main.manager, "broadcast_browser", fake)
    with watch_cursor_routes() as stray:
        api.main.manager.broadcast_browser({"type": "graphSync"})
    assert stray == [] and fake.call_args.args == ({"type": "graphSync"},)


def test_the_socket_check_reads_bytes_too():
    """Review 6, N1: send_bytes is wrapped, and a frame sent as bytes is read."""
    import main
    from starlette.websockets import WebSocket

    assert getattr(WebSocket.send_bytes, "_nebula_cursor_route", False) is True

    class Sink(WebSocket):
        def __init__(self) -> None:
            self.frames: list[object] = []

        async def send(self, message):  # type: ignore[no-untyped-def]
            self.frames.append(message)

    other = Sink()
    assert person_only_frame(b'{"type": "agentPresenceReplay", "cursors": []}')
    assert not person_only_frame(b'{"type": "agentPresence", "target": null}')
    # Review 7, NIT-2: a bytearray, a UTF-8 BOM, UTF-16, and bad UTF-8 in a value.
    frame = '{"type": "agentPresence", "session": {"key": "k", "ordinal": 1}}'
    assert person_only_frame(bytearray(frame.encode()))
    assert person_only_frame(b"\xef\xbb\xbf" + frame.encode())
    assert person_only_frame(frame.encode("utf-16"))
    assert person_only_frame(frame.encode("utf-32"))
    assert person_only_frame(b'{"type": "agentPresence", "say": "\xff", "session": {"key": "k", "ordinal": 1}}')
    assert not person_only_frame(bytearray(b'{"type": "agentPresence", "target": null}'))
    assert not person_only_frame("not json, agentPresence".encode("utf-16"))
    with watch_cursor_routes() as stray:
        asyncio.run(other.send_bytes(b'{"type": "agentPresence", "target": null}'))
        assert stray == []
        asyncio.run(other.send_bytes(b'{"type": "agentPresence", "session": {"key": "k", "ordinal": 1}}'))
    assert [line.split(":")[0] for line in stray] == ["send_bytes"], stray
    assert main.manager is not None and len(other.frames) == 2


def test_the_starlette_socket_check_reads_the_frame_and_the_socket():
    """The replay goes out on the socket itself (websocket_endpoint, after a
    verified hello): a person-only frame on a socket that isn't the person's
    canvas is recorded."""
    import main
    from starlette.websockets import WebSocket

    assert getattr(WebSocket.send_text, "_nebula_cursor_route", False)
    assert getattr(WebSocket.send_json, "_nebula_cursor_route", False)

    class Sink(WebSocket):
        def __init__(self) -> None:
            self.frames: list[object] = []

        async def send(self, message):  # type: ignore[no-untyped-def]
            self.frames.append(message)

    person, other = Sink(), Sink()
    replay = {"type": "agentPresenceReplay", "cursors": []}
    main.manager.browser_connections.add(person)
    try:
        with watch_cursor_routes() as stray:
            asyncio.run(person.send_json(replay))
            asyncio.run(other.send_text('{"type": "agentPresence", "target": null}'))
            assert stray == []
            asyncio.run(other.send_json(replay))
            asyncio.run(other.send_text('{"type": "agentPresence", "session": {"key": "k", "ordinal": 1}}'))
    finally:
        main.manager.browser_connections.discard(person)
    assert [line.split(":")[0] for line in stray] == ["send_json", "send_text"], stray
    assert len(other.frames) == 3  # recorded, still sent


# -- LOW-1: the content, in main.py's source ------------------------------------

def test_main_sends_a_person_only_frame_only_to_the_persons_canvas():
    """Every person-only frame main.py builds goes out as
    ``_broadcast_presence``'s person form, except the replay, which the
    socket endpoint sends on the socket a verified hello just promoted."""
    import ast

    source = (BACKEND / "main.py").read_text(encoding="utf-8")
    sends = person_only_sends(source)
    assert [where for _, where in sends] == ["websocket_endpoint"], sends
    (line, _), = sends
    tree = ast.parse(source)
    branch = next(
        node for node in ast.walk(tree)
        if isinstance(node, ast.If) and node.lineno < line <= max(n.lineno for n in ast.walk(node) if hasattr(n, "lineno"))
        and any(isinstance(n, ast.Call) and getattr(n.func, "attr", None) == "promote" for n in ast.walk(node.test))
    )
    assert any(getattr(n, "lineno", None) == line for stmt in branch.body for n in ast.walk(stmt)), \
        "the replay goes out only in the branch where manager.promote(...) verified the hello"


PERSON_SHAPES = {
    "person form to all": "await manager.broadcast_raw(_person_form(e, i, h))",
    "as others=": "p = _person_form(e, i, h)\n    await manager.broadcast_raw(e, others=p)",
    "accepted to the others": "await manager.broadcast_others(_accepted_person_form(e, q))",
    "swapped forms": "p = _person_form(e, i, h)\n    await _broadcast_presence(p, e)",
    "module call": "await manager.broadcast_raw(agent_presence.person_form(e, i, session=s))",
    "replay to the others": "await manager.broadcast_others({'type': 'agentPresenceReplay', 'cursors': agent_presence.replay()})",
    "replay's cursors alone": "await manager.broadcast_others(agent_presence.replay())",
    "replay literal": "await ws.send_text(json.dumps({'type': 'agentPresenceReplay', 'cursors': []}))",
    "copy": "p = _person_form(e, i, h)\n    await manager.broadcast_raw(dict(p))",
    "from another function": "await manager.broadcast_raw(build())",
    # Review 6, N2.
    "nested in a dict": "await manager.broadcast_others({'cursor': _person_form(e, i, h)})",
    "sender alias": "send = manager.broadcast_others\n    await send(_person_form(e, i, h))",
    # Review 6, LOW-2: built by hand, or sent another way.
    "hand-built, a target": "await manager.broadcast_raw({'type': 'agentPresence', 'target': t, 'session': tag})",
    "hand-built, no target": "await manager.broadcast_others({'type': 'agentPresence', 'target': None, 'say': 'x', 'session': tag})",
    "spread plus session": "await manager.broadcast_raw({**agent_presence.point(i, target=None, say='x'), 'session': agent_presence.session_tag(i, s)})",
    "session set on a name": "e = agent_presence.point(i, target=None, say='x')\n    e['session'] = agent_presence.session_tag(i, s)\n    await manager.broadcast_raw(e)",
    "dict() replay": "await manager.broadcast_others(dict(type='agentPresenceReplay', cursors=agent_presence.replay()))",
    "either branch": "p = _person_form(e, i, h)\n    await manager.broadcast_others(p if ok else e)",
    "partial": "p = _person_form(e, i, h)\n    await functools.partial(manager.broadcast_others, p)()",
    "getattr": "p = _person_form(e, i, h)\n    await getattr(manager, 'broadcast_raw')(p)",
    "loop over a list": "p = _person_form(e, i, h)\n    for x in [p]:\n        await manager.broadcast_others(x)",
    "on self": "self.p = _person_form(e, i, h)\n    await manager.broadcast_others(self.p)",
    # Review 7, LOW-B: each reader from its other side.
    "other branch": "p = _person_form(e, i, h)\n    await manager.broadcast_others(e if ok else p)",
    "loop over a tuple": "p = _person_form(e, i, h)\n    for x in (p,):\n        await manager.broadcast_others(x)",
    "loop over a set": "p = _person_form(e, i, h)\n    for x in {p}:\n        await manager.broadcast_others(x)",
    "partial, keyword": "p = _person_form(e, i, h)\n    await functools.partial(manager.broadcast_others, data=p)()",
    "dict() with session": "await manager.broadcast_raw(dict(e, session=tag))",
    "dict() presence with session": "await manager.broadcast_raw(dict(type='agentPresence', target=t, session=tag))",
    # Review 7, LOW-A: the shapes it found missed.
    "send_bytes": "p = _person_form(e, i, h)\n    await ws.send_bytes(json.dumps(p).encode())",
    "raw socket send": "p = _person_form(e, i, h)\n    await ws.send({'type': 'websocket.send', 'text': json.dumps(p)})",
    "person function alias": "pf = _person_form\n    await manager.broadcast_raw(pf(e, i, h))",
    "person function partial": "await manager.broadcast_raw(functools.partial(_person_form, e)(i, h))",
    "person function lambda": "mk = lambda: _person_form(e, i, h)\n    await manager.broadcast_raw(mk())",
    "person function getattr": "await manager.broadcast_raw(getattr(agent_presence, 'person_form')(e, i))",
    "stored partial": "p = _person_form(e, i, h)\n    f = functools.partial(manager.broadcast_others, p)\n    await f()",
    "sender either branch": "p = _person_form(e, i, h)\n    s = manager.broadcast_raw if ok else manager.broadcast_others\n    await s(p)",
    "sender in the other branch": "p = _person_form(e, i, h)\n    s = log_it if quiet else manager.broadcast_others\n    await s(p)",
    "sender on self": "p = _person_form(e, i, h)\n    self.out = manager.broadcast_raw\n    await self.out(p)",
    "getattr, a variable": "p = _person_form(e, i, h)\n    await getattr(manager, n)(p)",
    "update(session=)": "e = _point(i, target=None, say='x')\n    e.update(session=tag)\n    await manager.broadcast_raw(e)",
    "update({session})": "e = _point(i, target=None, say='x')\n    e.update({'session': tag})\n    await manager.broadcast_raw(e)",
    "|=": "e = _point(i, target=None, say='x')\n    e |= {'session': tag}\n    await manager.broadcast_raw(e)",
    "|": "e = _point(i, target=None, say='x')\n    await manager.broadcast_raw(e | {'session': tag})",
    "setdefault": "e = _point(i, target=None, say='x')\n    e.setdefault('session', tag)\n    await manager.broadcast_raw(e)",
    "a variable type": "await manager.broadcast_raw({'type': kind, 'target': t, 'session': tag})",
    "dict(), a variable type": "await manager.broadcast_raw(dict(target=t, session=tag, type=kind))",
    "no type": "await manager.broadcast_raw({'session': tag, 'target': t})",
    "a list, looped by name": "p = _person_form(e, i, h)\n    ps = [p]\n    for x in ps:\n        await manager.broadcast_others(x)",
    "indexed": "p = _person_form(e, i, h)\n    await manager.broadcast_others([p][0])",
    "spread": "p = _person_form(e, i, h)\n    await manager.broadcast_others(*[p])",
}


@pytest.mark.parametrize("shape", PERSON_SHAPES.values(), ids=PERSON_SHAPES.keys())
def test_the_person_only_guard_catches_each_shape(shape):
    helper = "def build():\n    return _person_form(e, i, h)\n\n"
    source = f"{helper}async def f():\n    {shape}\n"
    assert [line for line, _ in person_only_sends(source)] == [len(source.splitlines())], shape


@pytest.mark.parametrize("shape", [
    "await _broadcast_presence(e, _person_form(e, i, h))",
    "p = _accepted_person_form(e, q)\n    await _broadcast_presence(e, p)",
    "await manager.broadcast_raw(_point(i, target=None, say='x'))",
    "await manager.broadcast_browser({'type': 'graphSync'})",
    "await manager.broadcast_raw({'type': 'graphSync', 'session': s})",
    "await manager.broadcast_raw(dict(type='graphSync', session=s))",
    "e = _point(i, target=None, say='x')\n    await manager.broadcast_raw(e if ok else {**e})",
    # Review 7: each reader's other side, with nothing person-only in it.
    "e = _point(i, target=None, say='x')\n    for x in (e,):\n        await manager.broadcast_others(x)",
    "e = _point(i, target=None, say='x')\n    await functools.partial(manager.broadcast_others, data=e)()",
    "e = _point(i, target=None, say='x')\n    await manager.broadcast_raw(dict(e, say='y'))",
    "e = _point(i, target=None, say='x')\n    e.update(say='y')\n    await manager.broadcast_raw(e)",
    "e = _point(i, target=None, say='x')\n    await manager.broadcast_raw(e | {'say': 'y'})",
    "pf = _person_form\n    await _broadcast_presence(e, pf(e, i, h))",
    "await ws.send_bytes(json.dumps({'type': 'graphSync', 'session': s}).encode())",
    "await manager.broadcast_raw({'type': 'workspaceSession', 'session': s})",
], ids=["the route", "the route, named", "agent log", "not presence", "another kind's session", "dict() of another kind",
        "agent forms either way", "agent form in a tuple", "agent form, partial keyword", "agent form, dict() copy",
        "agent form, updated", "agent form, merged", "alias to the route", "bytes of another kind", "a literal other kind"])
def test_the_person_only_guard_lets_the_route_through(shape):
    assert person_only_sends(f"async def f():\n    {shape}\n") == []


# -- N1: live_only's TTL edge -----------------------------------------------------

def test_an_accept_lands_on_a_cursor_exactly_at_its_ttl_and_not_past_it():
    """Review 5, N1: live_only reads liveness as _slot and session_tag do, a
    cursor is live through exactly PRESENCE_TTL_SECONDS (``>``, not ``>=``)."""
    for age, lands in ((PRESENCE_TTL_SECONDS, True), (PRESENCE_TTL_SECONDS + 0.001, False)):
        clock = Clock()
        presence = AgentPresence(clock)
        presence.person_form(presence.point(AGENT, target={"x": 1, "y": 1}), AGENT, session="a")
        clock.now += age
        event = presence.point(AGENT, target={"x": 2, "y": 2})
        form = presence.person_form(event, AGENT, session="a", live_only=True)
        assert (form is not None) is lands, age
        if lands:
            assert form["session"]["ordinal"] == 1
