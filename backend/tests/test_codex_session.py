"""Tests for run_codex — mirrors the chat-agent event contract."""
from __future__ import annotations

from unittest.mock import AsyncMock, patch

import pytest

import sys
from pathlib import Path
sys.path.insert(0, str(Path(__file__).resolve().parent.parent))

import services.codex_session as codex_session
from services.codex_session import codex_login_status, run_codex


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
    proc.stderr.read = AsyncMock(return_value=stderr)
    proc.wait = AsyncMock(return_value=returncode)
    proc.returncode = returncode
    return proc


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

    with patch("services.codex_session._build_prompt", return_value="prompt"), \
         patch("services.codex_session.asyncio.create_subprocess_exec", return_value=proc):
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
async def test_codex_login_status_detects_chatgpt_login():
    proc = AsyncMock()
    proc.communicate = AsyncMock(return_value=(b"Logged in using ChatGPT\n", b""))
    proc.returncode = 0

    with patch("services.codex_session.asyncio.create_subprocess_exec", return_value=proc):
        status = await codex_login_status()

    assert status["installed"] is True
    assert status["loggedIn"] is True
    assert status["mode"] == "chatgpt"


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
