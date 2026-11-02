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
    lazy = tmp_path / "test_lazy_probe.py"
    lazy.write_text(
        "import pytest\n\n"
        "@pytest.fixture\n"
        "def saved(monkeypatch):\n"
        "    import main\n"
        "    async def fake(data, **kw):\n"
        "        return None\n"
        "    monkeypatch.setattr(main.manager, 'broadcast_raw', fake)\n"
        "    return monkeypatch._setattr[-1][2]\n\n"
        "def test_a_lazy_fixture_saves_the_checked_sender(saved):\n"
        "    assert getattr(saved, '_nebula_cursor_route', False)\n",
        encoding="utf-8",
    )
    for path in (probe, lazy):
        run = _pytest_alone("-p", "tests.conftest", "--rootdir", str(tmp_path), str(path))
        assert run.returncode == 0 and "1 passed" in run.stdout, run.stdout[-3000:]


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
], ids=["the route", "the route, named", "agent log", "not presence"])
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
