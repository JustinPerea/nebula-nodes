"""Tests for run_codex — mirrors the chat-agent event contract."""
from __future__ import annotations

import asyncio
from unittest.mock import AsyncMock, MagicMock, patch

import pytest

import sys
from pathlib import Path
sys.path.insert(0, str(Path(__file__).resolve().parent.parent))

import services.codex_session as codex_session
from services.codex_session import (
    codex_chatgpt_login_state,
    codex_login_status,
    run_codex,
    start_codex_chatgpt_login,
)


@pytest.fixture(autouse=True)
def reset_codex_login_state():
    codex_session._codex_login_task = None
    codex_session._codex_login_state.clear()
    codex_session._codex_login_state.update({
        "running": False,
        "mode": "browser",
        "authUrl": None,
        "deviceCode": None,
        "message": "No Codex ChatGPT login is running.",
        "output": [],
        "exitCode": None,
    })
    yield


async def _collect(agen):
    return [event async for event in agen]


def _readline_chunks(data: bytes) -> list[bytes]:
    chunks: list[bytes] = []
    start = 0
    for i in range(len(data)):
        if data[i:i + 1] == b"\n":
            chunks.append(data[start:i + 1])
            start = i + 1
    if start < len(data):
        chunks.append(data[start:])
    chunks.append(b"")
    return chunks


class _FakeStdin:
    def __init__(self) -> None:
        self.data = b""
        self.closed = False

    def write(self, data: bytes) -> None:
        self.data += data

    async def drain(self) -> None:
        return None

    def close(self) -> None:
        self.closed = True


def _proc(stdout: bytes, stderr: bytes = b"", returncode: int = 0) -> AsyncMock:
    proc = AsyncMock()
    proc.stdin = _FakeStdin()
    proc.stdout.readline = AsyncMock(side_effect=_readline_chunks(stdout))
    proc.stderr.readline = AsyncMock(side_effect=_readline_chunks(stderr))
    proc.stderr.read = AsyncMock(return_value=stderr)
    proc.wait = AsyncMock(return_value=returncode)
    proc.returncode = returncode
    return proc


def _communicate_proc(stdout: bytes = b"", stderr: bytes = b"", returncode: int = 0) -> AsyncMock:
    proc = AsyncMock()
    proc.communicate = AsyncMock(return_value=(stdout, stderr))
    proc.wait = AsyncMock(return_value=returncode)
    proc.kill = AsyncMock()
    proc.returncode = returncode
    return proc


def _chatgpt_status_proc() -> AsyncMock:
    return _communicate_proc(b"Logged in using ChatGPT\n")


@pytest.mark.asyncio
async def test_codex_jsonl_yields_session_tool_text_result_and_done():
    stdout = b"\n".join([
        b'{"type":"thread.started","thread_id":"thread-123"}',
        b'{"type":"turn.started"}',
        b'{"type":"item.started","item":{"id":"item_0","type":"command_execution","command":"/bin/zsh -lc pwd","aggregated_output":"","exit_code":null,"status":"in_progress"}}',
        b'{"type":"item.completed","item":{"id":"item_0","type":"command_execution","command":"/bin/zsh -lc pwd","aggregated_output":"/repo\\n","exit_code":0,"status":"completed"}}',
        b'{"type":"item.completed","item":{"id":"item_1","type":"agent_message","text":"done"}}',
        b'{"type":"turn.completed","usage":{"input_tokens":1,"output_tokens":2}}',
    ]) + b"\n"
    proc = _proc(stdout)

    async def fake_create(*args, **kwargs):
        if args[:3] == ("codex", "login", "status"):
            return _chatgpt_status_proc()
        return proc

    with patch("services.codex_session._build_prompt", return_value="prompt"), \
         patch("services.codex_session.asyncio.create_subprocess_exec", side_effect=fake_create):
        events = await _collect(run_codex("hi", None))

    assert events[0] == {"type": "session", "sessionId": "thread-123"}
    assert {
        "type": "tool_use",
        "toolUseId": "item_0",
        "tool": "shell",
        "input": {"command": "/bin/zsh -lc pwd"},
    } in events
    assert {
        "type": "tool_result",
        "toolUseId": "item_0",
        "content": "/repo\n",
        "isError": False,
    } in events
    assert {"type": "text", "text": "done"} in events
    assert any(e["type"] == "result" for e in events)
    assert events[-1]["type"] == "done"
    assert proc.stdin.data == b"prompt"
    assert proc.stdin.closed


@pytest.mark.asyncio
async def test_codex_resume_uses_exec_resume_command():
    captured_args: list[str] = []
    proc = _proc(b'{"type":"item.completed","item":{"id":"item_1","type":"agent_message","text":"ok"}}\n')

    async def fake_create(*args, **kwargs):
        if args[:3] == ("codex", "login", "status"):
            return _chatgpt_status_proc()
        captured_args.extend(args)
        return proc

    with patch("services.codex_session._build_prompt", return_value="prompt"), \
         patch("services.codex_session.asyncio.create_subprocess_exec", side_effect=fake_create):
        await _collect(run_codex("again", "thread-existing"))

    assert captured_args[:2] == ["codex", "exec"]
    assert "resume" in captured_args
    idx = captured_args.index("resume")
    assert captured_args[idx + 1] == "thread-existing"
    assert captured_args[idx + 2] == "-"


@pytest.mark.asyncio
async def test_run_codex_refuses_api_key_auth_before_exec():
    captured_args: list[tuple[str, ...]] = []
    status_proc = _communicate_proc(b"Logged in using an API key - sk-proj-***test\n")

    async def fake_create(*args, **kwargs):
        captured_args.append(tuple(args))
        if args[:3] == ("codex", "login", "status"):
            return status_proc
        raise AssertionError("codex exec should not start in API-key mode")

    with patch("services.codex_session.asyncio.create_subprocess_exec", side_effect=fake_create):
        events = await _collect(run_codex("hi", None))

    assert captured_args == [("codex", "login", "status")]
    assert events[0]["type"] == "error"
    assert "ChatGPT account login" in events[0]["message"]
    assert "API-key billing mode" in events[0]["message"]
    assert events[-1] == {"type": "done"}


@pytest.mark.asyncio
async def test_run_codex_strips_openai_api_credentials_from_exec_env(monkeypatch):
    proc = _proc(b'{"type":"item.completed","item":{"id":"item_1","type":"agent_message","text":"ok"}}\n')
    exec_env: dict[str, str] | None = None
    monkeypatch.setenv("OPENAI_API_KEY", "sk-proj-test")
    monkeypatch.setenv("OPENAI_ACCESS_TOKEN", "openai-access-test")
    monkeypatch.setenv("CODEX_ACCESS_TOKEN", "codex-access-test")

    async def fake_create(*args, **kwargs):
        nonlocal exec_env
        if args[:3] == ("codex", "login", "status"):
            return _chatgpt_status_proc()
        exec_env = kwargs.get("env")
        return proc

    with patch("services.codex_session._build_prompt", return_value="prompt"), \
         patch("services.codex_session.asyncio.create_subprocess_exec", side_effect=fake_create):
        events = await _collect(run_codex("hi", None))

    assert {"type": "text", "text": "ok"} in events
    assert exec_env is not None
    assert "OPENAI_API_KEY" not in exec_env
    assert "OPENAI_ACCESS_TOKEN" not in exec_env
    assert "CODEX_ACCESS_TOKEN" not in exec_env


@pytest.mark.asyncio
async def test_codex_cancel_kills_and_awaits_agent_process_tree():
    entered_read = asyncio.Event()

    async def blocked_readline() -> bytes:
        entered_read.set()
        await asyncio.Future()
        return b""

    proc = _proc(b"")
    proc.stdout.readline = AsyncMock(side_effect=blocked_readline)

    async def blocked_stderr() -> bytes:
        await asyncio.Future()
        return b""

    proc.stderr.read = AsyncMock(side_effect=blocked_stderr)
    proc.kill = MagicMock(side_effect=lambda: setattr(proc, "returncode", -9))
    proc.returncode = None

    async def fake_create(*args, **kwargs):
        if args[:3] == ("codex", "login", "status"):
            return _chatgpt_status_proc()
        if sys.platform != "win32":
            assert kwargs["start_new_session"] is True
        return proc

    with patch("services.codex_session._build_prompt", return_value="prompt"), \
         patch("services.codex_session.asyncio.create_subprocess_exec", side_effect=fake_create):
        agen = run_codex("hi", None)
        pending = asyncio.create_task(anext(agen))
        await entered_read.wait()
        pending.cancel()

        assert await pending == {"type": "done"}
        with pytest.raises(asyncio.CancelledError):
            await anext(agen)

    proc.kill.assert_called_once_with()
    proc.wait.assert_awaited()


@pytest.mark.asyncio
async def test_codex_cancel_during_login_preflight_kills_status_process_tree():
    entered_status = asyncio.Event()

    async def blocked_communicate():
        entered_status.set()
        await asyncio.Future()
        return b"", b""

    status_proc = AsyncMock()
    status_proc.communicate = AsyncMock(side_effect=blocked_communicate)
    status_proc.kill = MagicMock(side_effect=lambda: setattr(status_proc, "returncode", -9))
    status_proc.wait = AsyncMock(return_value=-9)
    status_proc.returncode = None

    async def fake_create(*args, **kwargs):
        assert args[:3] == ("codex", "login", "status")
        if sys.platform != "win32":
            assert kwargs["start_new_session"] is True
        return status_proc

    with patch(
        "services.codex_session.asyncio.create_subprocess_exec",
        side_effect=fake_create,
    ):
        task = asyncio.create_task(_collect(run_codex("hi", None)))
        await entered_status.wait()
        task.cancel()
        with pytest.raises(asyncio.CancelledError):
            await task

    status_proc.kill.assert_called_once_with()
    status_proc.wait.assert_awaited_once_with()


@pytest.mark.asyncio
async def test_codex_login_status_detects_chatgpt_login():
    proc = AsyncMock()
    proc.communicate = AsyncMock(return_value=(b"Logged in using ChatGPT\n", b""))
    proc.returncode = 0

    with patch("services.codex_session.asyncio.create_subprocess_exec", return_value=proc):
        status = await codex_login_status()

    assert status["installed"] is True
    assert status["loggedIn"] is True
    assert status["mode"] == "chatgpt"


@pytest.mark.asyncio
async def test_start_codex_chatgpt_login_logs_out_then_launches_oauth():
    captured_args: list[tuple[str, ...]] = []
    logout_proc = _communicate_proc(b"Logged out\n")
    login_proc = _proc(
        b"Starting local login server\n"
        b"https://auth.openai.com/oauth/authorize?state=abc123\n"
        b"Successfully logged in\n"
    )

    async def fake_create(*args, **kwargs):
        captured_args.append(tuple(args))
        return logout_proc if args[:2] == ("codex", "logout") else login_proc

    with patch("services.codex_session.asyncio.create_subprocess_exec", side_effect=fake_create):
        state = await start_codex_chatgpt_login()
        assert state["running"] is True
        assert state["mode"] == "browser"
        assert codex_session._codex_login_task is not None
        await codex_session._codex_login_task

    final_state = await codex_chatgpt_login_state()

    assert captured_args[0][:2] == ("codex", "logout")
    assert captured_args[1][:2] == ("codex", "login")
    assert "--device-auth" not in captured_args[1]
    assert final_state["running"] is False
    assert final_state["exitCode"] == 0
    assert final_state["authUrl"] == "https://auth.openai.com/oauth/authorize?state=abc123"
    assert final_state["message"] == "Codex ChatGPT login completed."


@pytest.mark.asyncio
async def test_start_codex_chatgpt_login_supports_device_auth():
    captured_args: list[tuple[str, ...]] = []
    logout_proc = _communicate_proc()
    login_proc = _proc(b"Enter code ABCD-1234\n")

    async def fake_create(*args, **kwargs):
        captured_args.append(tuple(args))
        return logout_proc if args[:2] == ("codex", "logout") else login_proc

    with patch("services.codex_session.asyncio.create_subprocess_exec", side_effect=fake_create):
        state = await start_codex_chatgpt_login(device_auth=True)
        assert state["mode"] == "device"
        assert codex_session._codex_login_task is not None
        await codex_session._codex_login_task

    final_state = await codex_chatgpt_login_state()

    assert captured_args[1][:3] == ("codex", "login", "--device-auth")
    assert final_state["deviceCode"] == "ABCD-1234"


def test_skill_bootstrap_indexes_and_preloads_relevant_repo_skill(tmp_path, monkeypatch):
    skill_dir = tmp_path / ".agents" / "skills" / "gpt-image-2"
    skill_dir.mkdir(parents=True)
    (skill_dir / "SKILL.md").write_text(
        "---\n"
        "name: gpt-image-2\n"
        "description: Use when building gpt-image-2 Nebula nodes.\n"
        "---\n\n"
        "# GPT Image 2\n\n"
        "Node ID: `gpt-image-2-generate`.\n",
        encoding="utf-8",
    )
    fal_dir = tmp_path / ".agents" / "skills" / "fal"
    fal_dir.mkdir(parents=True)
    (fal_dir / "SKILL.md").write_text(
        "---\n"
        "name: fal\n"
        "description: Use for FAL-backed Nebula nodes.\n"
        "---\n\n"
        "# FAL\n",
        encoding="utf-8",
    )

    monkeypatch.setattr(codex_session, "PROJECT_ROOT", tmp_path)
    monkeypatch.setattr(codex_session, "SKILL_ROOT", tmp_path / ".agents" / "skills")

    bootstrap = codex_session._build_skill_bootstrap("make a GPT Image 2 graph")

    assert "Available root skills" in bootstrap
    assert "- gpt-image-2 (.agents/skills/gpt-image-2/SKILL.md)" in bootstrap
    assert "### .agents/skills/gpt-image-2/SKILL.md" in bootstrap
    assert "Node ID: `gpt-image-2-generate`" in bootstrap
    assert "docs/model-providers/openai/gpt-image-2.md" in bootstrap
