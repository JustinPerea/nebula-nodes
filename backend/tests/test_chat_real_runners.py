"""/ws/chat drives each agent's real runner, not a stand-in.

Other chat tests swap in fake runners that accept **kwargs, so they can't see
the keywords main passes drift from a runner's signature (that drift once broke
every Daedalus turn). These keep the real runner and fake only the process it
spawns, then check what it was spawned with.
"""
from __future__ import annotations

import asyncio
from pathlib import Path
from unittest.mock import AsyncMock

import pytest

import main
from commons import actors
from services import codex_session, hermes_session, krea_agent_mcp
from services.agent_profiles import CODEX_ALLOWED_FEATURES, CODEX_DISABLED_FEATURES
from tests.conftest import PERSON_TOKEN
from tests.test_chat_isolation_lifecycle import QueueSocket
from tests.test_commons_integration import isolated_app  # noqa: F401
from tests.test_hermes_session import _readline_chunks, _verbose_bytes


pytestmark = pytest.mark.usefixtures("person")


def _stream_proc(stdout: bytes) -> AsyncMock:
    proc = AsyncMock()
    proc.stdin = AsyncMock()
    proc.stdin.write = lambda data: None
    proc.stdin.close = lambda: None
    proc.stdout.readline = AsyncMock(side_effect=_readline_chunks(stdout))
    proc.stderr.readline = AsyncMock(side_effect=_readline_chunks(b""))
    proc.stderr.read = AsyncMock(return_value=b"")
    proc.wait = AsyncMock(return_value=0)
    proc.returncode = 0
    return proc


def _communicate_proc(stdout: bytes) -> AsyncMock:
    proc = AsyncMock()
    proc.communicate = AsyncMock(return_value=(stdout, b""))
    proc.wait = AsyncMock(return_value=0)
    proc.returncode = 0
    return proc


def _reviewed_listing() -> bytes:
    rows = [f"{name:<40} stable             true" for name in CODEX_ALLOWED_FEATURES]
    rows += [f"{name:<40} stable             false" for name in CODEX_DISABLED_FEATURES]
    return ("\n".join(rows) + "\n").encode()


async def _one_turn(agent: str) -> list[dict]:
    async def send(socket, event):
        if event["type"] == "done":
            socket.disconnect()
    socket = QueueSocket({"type": "send", "message": "hi", "agent": agent, "personToken": PERSON_TOKEN}, send)
    await asyncio.wait_for(main.chat_websocket(socket), timeout=10)
    return socket.events


def _capture_turn_spawn(monkeypatch, module, stdout: bytes, extra=None):
    """Fake `module`'s process spawns; record the turn's own spawn and who its
    token belonged to while it ran."""
    spawned: list[dict] = []

    async def create(*args, **kwargs):
        if extra:
            other = extra(args)
            if other is not None:
                return other
        env = kwargs.get("env") or {}
        token = env.get("NEBULA_AGENT_TOKEN")
        spawned.append({
            "args": list(args), "cwd": kwargs.get("cwd"), "env": dict(env),
            "actor": actors.agent_registry.lookup(token) if token else None,
            "overlay": (Path(env["HERMES_MANAGED_DIR"]) / "config.yaml").read_text()
            if env.get("HERMES_MANAGED_DIR") else None,
        })
        return _stream_proc(stdout)
    monkeypatch.setattr(module.asyncio, "create_subprocess_exec", create)
    return spawned


def _assert_turn_spawn(spawned, events, agent):
    errors = [event for event in events if event["type"] == "error"]
    assert not errors, errors
    assert events[-1]["type"] == "done"
    assert len(spawned) == 1
    spawn = spawned[0]
    actor = spawn["actor"]
    assert actor is not None and actor["runner"] == agent
    assert Path(spawn["cwd"]).resolve() == actor["workspace"]
    assert spawn["env"]["NEBULA_URL"]
    return spawn


@pytest.mark.asyncio
async def test_daedalus_turn_spawns_hermes_with_only_nebula_tools(isolated_app, monkeypatch):
    profile = isolated_app / "daedalus-profile"
    monkeypatch.setattr(hermes_session, "PROFILE_HOME", profile)
    monkeypatch.setattr(hermes_session, "LOG_PATH", profile / "logs" / "agent.log")
    monkeypatch.setattr(krea_agent_mcp, "HERMES_SYSTEM_MANAGED_DIR", isolated_app / "no-policy")
    spawned = _capture_turn_spawn(monkeypatch, hermes_session, _verbose_bytes(prose_boxes=[["hello"]]))

    events = await _one_turn("daedalus")

    spawn = _assert_turn_spawn(spawned, events, "daedalus")
    args = spawn["args"]
    assert args[0] == hermes_session.HERMES_BIN
    assert args[args.index("-t") + 1] == "nebula,nebula_krea,clarify"
    assert args.count("-t") == 1 and "--toolsets" not in args
    # The overlay names the token by reference; the value only rides in env.
    assert "${NEBULA_AGENT_TOKEN}" in spawn["overlay"]
    assert spawn["env"]["NEBULA_AGENT_TOKEN"] not in spawn["overlay"]
    assert spawn["env"]["NEBULA_AGENT_TOKEN"] not in " ".join(args)
    # The turn's authority ends with the turn.
    assert actors.agent_registry.lookup(spawn["env"]["NEBULA_AGENT_TOKEN"]) is None


@pytest.mark.asyncio
async def test_claude_turn_spawns_claude_in_its_workspace_with_its_token(isolated_app, monkeypatch):
    from services import chat_session
    spawned = _capture_turn_spawn(monkeypatch, chat_session, b"")

    events = await _one_turn("claude")

    spawn = _assert_turn_spawn(spawned, events, "claude")
    assert spawn["args"][:2] == ["claude", "-p"]
    assert "--strict-mcp-config" in spawn["args"]
    assert spawn["env"]["NEBULA_AGENT_TOKEN"] not in " ".join(spawn["args"])


@pytest.mark.asyncio
async def test_codex_turn_spawns_codex_in_its_workspace_with_its_token(isolated_app, monkeypatch):
    monkeypatch.setattr(codex_session, "codex_default_model", lambda: None)

    def side_commands(args):
        # `codex login status` and the feature preflight run before the turn.
        if list(args[1:3]) == ["login", "status"]:
            return _communicate_proc(b"Logged in using ChatGPT\n")
        if list(args[1:3]) == ["features", "list"]:
            return _communicate_proc(_reviewed_listing())
        return None
    stdout = b'{"type":"thread.started","thread_id":"thread-1"}\n'
    spawned = _capture_turn_spawn(monkeypatch, codex_session, stdout, side_commands)

    events = await _one_turn("codex")

    spawn = _assert_turn_spawn(spawned, events, "codex")
    assert spawn["args"][:2] == [codex_session.CODEX_BIN, "exec"]
    assert spawn["env"]["NEBULA_AGENT_TOKEN"] not in " ".join(spawn["args"])
