"""Tests for the Claude CLI chat bridge event and lifecycle contract."""
from __future__ import annotations

import asyncio
from pathlib import Path
import sys
from unittest.mock import AsyncMock, MagicMock, patch

import pytest

sys.path.insert(0, str(Path(__file__).resolve().parent.parent))

from services.chat_session import NEBULA_SYSTEM_PRIMER, run_claude


async def _collect(agen):
    return [event async for event in agen]


def _readline_chunks(data: bytes) -> list[bytes]:
    chunks = data.splitlines(keepends=True)
    if data and not data.endswith((b"\n", b"\r")):
        chunks[-1] = chunks[-1].rstrip(b"\r\n")
    return [*chunks, b""]


def _proc(stdout: bytes, stderr: bytes = b"", returncode: int = 0) -> AsyncMock:
    proc = AsyncMock()
    proc.stdout.readline = AsyncMock(side_effect=_readline_chunks(stdout))
    proc.stderr.read = AsyncMock(return_value=stderr)
    proc.wait = AsyncMock(return_value=returncode)
    proc.kill = MagicMock()
    proc.returncode = returncode
    return proc


@pytest.mark.asyncio
async def test_claude_stream_yields_normalized_events_and_done(monkeypatch):
    stdout = b"\n".join([
        b'{"type":"system","subtype":"init","session_id":"session-123"}',
        b'{"type":"system","subtype":"hook_progress","message":"noise"}',
        b'{"type":"assistant","message":{"content":[{"type":"text","text":"working"},{"type":"tool_use","id":"tool-1","name":"Bash","input":{"command":"nebula graph"}}]}}',
        b'{"type":"user","message":{"content":[{"type":"tool_result","tool_use_id":"tool-1","content":[{"type":"text","text":"8 nodes"}],"is_error":false}]}}',
        b'{"type":"result","subtype":"success","result":"done","duration_ms":42}',
    ]) + b"\n"
    proc = _proc(stdout)
    captured_args: tuple[str, ...] | None = None
    captured_env: dict[str, str] | None = None
    captured_spawn_options: dict[str, object] = {}
    monkeypatch.setenv("NEBULA_DISABLE_QUICK", "0")

    async def fake_create(*args, **kwargs):
        nonlocal captured_args, captured_env
        captured_args = args
        captured_env = kwargs.get("env")
        captured_spawn_options.update(kwargs)
        return proc

    with patch(
        "services.chat_session.asyncio.create_subprocess_exec",
        side_effect=fake_create,
    ):
        events = await _collect(
            run_claude(
                "inspect the graph",
                "existing-session",
                "claude-sonnet-4-6",
            )
        )

    assert events == [
        {"type": "session", "sessionId": "session-123"},
        {"type": "text", "text": "working"},
        {
            "type": "tool_use",
            "toolUseId": "tool-1",
            "tool": "Bash",
            "input": {"command": "nebula graph"},
        },
        {
            "type": "tool_result",
            "toolUseId": "tool-1",
            "content": "8 nodes",
            "isError": False,
        },
        {"type": "result", "text": "done", "durationMs": 42},
        {"type": "done"},
    ]
    assert captured_args is not None
    assert captured_args[:2] == ("claude", "-p")
    assert "--dangerously-skip-permissions" in captured_args
    assert captured_args[captured_args.index("--model") + 1] == "claude-sonnet-4-6"
    assert captured_args[captured_args.index("--append-system-prompt") + 1] == NEBULA_SYSTEM_PRIMER
    assert captured_args[captured_args.index("--resume") + 1] == "existing-session"
    assert captured_args[-1] == "inspect the graph"
    assert captured_env is not None
    assert captured_env["NEBULA_DISABLE_QUICK"] == "1"
    if sys.platform != "win32":
        assert captured_spawn_options["start_new_session"] is True


@pytest.mark.asyncio
async def test_claude_nonzero_exit_surfaces_stderr_then_done():
    proc = _proc(b"", b"authentication failed", returncode=1)

    with patch(
        "services.chat_session.asyncio.create_subprocess_exec",
        return_value=proc,
    ):
        events = await _collect(run_claude("hi", None, "claude-sonnet-4-6"))

    assert events == [
        {"type": "error", "message": "authentication failed"},
        {"type": "done"},
    ]


@pytest.mark.asyncio
async def test_claude_missing_binary_surfaces_error_then_done():
    with patch(
        "services.chat_session.asyncio.create_subprocess_exec",
        side_effect=FileNotFoundError,
    ):
        events = await _collect(run_claude("hi", None, "claude-sonnet-4-6"))

    assert events == [
        {"type": "error", "message": "`claude` binary not found in PATH"},
        {"type": "done"},
    ]


@pytest.mark.asyncio
async def test_claude_cancel_kills_and_awaits_subprocess():
    entered_read = asyncio.Event()

    async def blocked_readline() -> bytes:
        entered_read.set()
        await asyncio.Future()
        return b""

    proc = AsyncMock()
    proc.stdout.readline = AsyncMock(side_effect=blocked_readline)
    proc.stderr.read = AsyncMock(return_value=b"")
    proc.wait = AsyncMock(return_value=-9)
    proc.kill = MagicMock(side_effect=lambda: setattr(proc, "returncode", -9))
    proc.returncode = None

    with patch(
        "services.chat_session.asyncio.create_subprocess_exec",
        return_value=proc,
    ):
        agen = run_claude("hi", None, "claude-sonnet-4-6")
        pending = asyncio.create_task(anext(agen))
        await entered_read.wait()
        pending.cancel()

        # The bridge deliberately gets one chance to emit its terminal marker
        # while unwinding. The original cancellation remains suspended inside
        # the async generator and propagates as soon as the consumer advances
        # it again.
        assert await pending == {"type": "done"}
        with pytest.raises(asyncio.CancelledError):
            await anext(agen)

    proc.kill.assert_called_once_with()
    proc.wait.assert_awaited_once_with()


@pytest.mark.asyncio
async def test_claude_failed_result_is_an_error_not_success_text():
    proc = _proc(
        b'{"type":"result","subtype":"error_max_turns","result":"turn limit reached"}\n'
    )

    with patch(
        "services.chat_session.asyncio.create_subprocess_exec",
        return_value=proc,
    ):
        events = await _collect(run_claude("hi", None, "claude-sonnet-4-6"))

    assert events == [
        {"type": "error", "message": "turn limit reached"},
        {"type": "done"},
    ]
