"""Tests for run_hermes — mirrors the run_claude event contract."""
from __future__ import annotations

from unittest.mock import AsyncMock, patch

import pytest

import sys
from pathlib import Path
sys.path.insert(0, str(Path(__file__).resolve().parent.parent))

from services.hermes_session import run_hermes


async def _collect(agen):
    return [event async for event in agen]


@pytest.mark.asyncio
async def test_happy_path_yields_text_and_done():
    """Minimal successful turn: Hermes prints a response, wrapper emits text + done."""
    fake_stdout = b"HELLO\n"
    fake_stderr = b""

    proc = AsyncMock()
    proc.stdout.read = AsyncMock(return_value=fake_stdout)
    proc.stderr.read = AsyncMock(return_value=fake_stderr)
    proc.wait = AsyncMock(return_value=0)
    proc.returncode = 0

    with patch("services.hermes_session.asyncio.create_subprocess_exec",
               return_value=proc):
        events = await _collect(run_hermes("hi", None, autonomy="auto"))

    types = [e["type"] for e in events]
    assert "text" in types
    assert events[-1]["type"] == "done"
    text_event = next(e for e in events if e["type"] == "text")
    assert "HELLO" in text_event["text"]


@pytest.mark.asyncio
async def test_emits_session_event_when_session_id_present():
    """Hermes -Q mode prints `session_id: <id>` on the first stdout line automatically.
    Format verified from Task 0 fixture: session_id is lowercase, leading line."""
    fake_stdout = b"session_id: 20260423_095548_a2985d\nSome response text.\n"

    proc = AsyncMock()
    proc.stdout.read = AsyncMock(return_value=fake_stdout)
    proc.stderr.read = AsyncMock(return_value=b"")
    proc.wait = AsyncMock(return_value=0)
    proc.returncode = 0

    with patch("services.hermes_session.asyncio.create_subprocess_exec",
               return_value=proc):
        events = await _collect(run_hermes("hi", None, autonomy="auto"))

    session_events = [e for e in events if e["type"] == "session"]
    assert len(session_events) == 1
    assert session_events[0]["sessionId"] == "20260423_095548_a2985d"
    # Session marker stripped from text
    text_event = next(e for e in events if e["type"] == "text")
    assert "session_id" not in text_event["text"].lower()
    assert "Some response text." in text_event["text"]


@pytest.mark.asyncio
async def test_resume_flag_passed_when_session_id_given():
    """When session_id arg is provided, --resume is in the subprocess args."""
    captured_args = []

    async def fake_create(*args, **kwargs):
        captured_args.extend(args)
        proc = AsyncMock()
        proc.stdout.read = AsyncMock(return_value=b"ok\n")
        proc.stderr.read = AsyncMock(return_value=b"")
        proc.wait = AsyncMock(return_value=0)
        proc.returncode = 0
        return proc

    with patch("services.hermes_session.asyncio.create_subprocess_exec",
               side_effect=fake_create):
        _ = await _collect(run_hermes("hi", "01HEXISTING", autonomy="auto"))

    assert "--resume" in captured_args
    idx = captured_args.index("--resume")
    assert captured_args[idx + 1] == "01HEXISTING"


@pytest.mark.asyncio
async def test_parses_approval_required_marker():
    """When Hephaestus prints APPROVAL_REQUIRED, emit approval_request event."""
    fake_stdout = (
        b"session_id: 20260423_095548_a2985d\n"
        b"Planning the render.\n"
        b"APPROVAL_REQUIRED: Run Veo 3.1 on n4 (est $0.15, ~60s)\n"
        b"PLAN: connect n2:image -> n4:first_frame + n4:last_frame; run n4\n"
        b"COST: $0.15\n"
    )

    proc = AsyncMock()
    proc.stdout.read = AsyncMock(return_value=fake_stdout)
    proc.stderr.read = AsyncMock(return_value=b"")
    proc.wait = AsyncMock(return_value=0)
    proc.returncode = 0

    with patch("services.hermes_session.asyncio.create_subprocess_exec",
               return_value=proc):
        events = await _collect(run_hermes("render it", None, autonomy="step"))

    approval = [e for e in events if e["type"] == "approval_request"]
    assert len(approval) == 1
    assert "Veo 3.1" in approval[0]["summary"]
    assert "connect n2:image" in approval[0]["plan"]
    assert approval[0]["cost"] == "$0.15"

    # Markers stripped from the free-text event
    text = next((e for e in events if e["type"] == "text"), None)
    if text:
        assert "APPROVAL_REQUIRED" not in text["text"]
        assert "PLAN:" not in text["text"]
        assert "COST:" not in text["text"]


@pytest.mark.asyncio
async def test_approval_marker_mid_response_is_not_parsed():
    """Markers only count when they form a contiguous END-of-response block.
    Mid-response quotes or headings should NOT trigger a fake approval."""
    fake_stdout = (
        b"session_id: 20260423_095548_a2985d\n"
        b"Earlier I said APPROVAL_REQUIRED: run this.\n"
        b"But I've changed my plan.\n"
        b"Here is the final result with no pending approval.\n"
    )

    proc = AsyncMock()
    proc.stdout.read = AsyncMock(return_value=fake_stdout)
    proc.stderr.read = AsyncMock(return_value=b"")
    proc.wait = AsyncMock(return_value=0)
    proc.returncode = 0

    with patch("services.hermes_session.asyncio.create_subprocess_exec",
               return_value=proc):
        events = await _collect(run_hermes("hi", None, autonomy="auto"))

    approval = [e for e in events if e["type"] == "approval_request"]
    assert len(approval) == 0  # no false approval
    text = next(e for e in events if e["type"] == "text")
    assert "Earlier I said APPROVAL_REQUIRED: run this." in text["text"]


@pytest.mark.asyncio
async def test_approval_summary_only_no_plan_cost_omits_those_keys():
    """When only APPROVAL_REQUIRED is present (no PLAN, no COST), the event
    should NOT have plan/cost keys — not empty strings."""
    fake_stdout = (
        b"session_id: 20260423_095548_a2985d\n"
        b"Planning.\n"
        b"APPROVAL_REQUIRED: Run expensive op\n"
    )

    proc = AsyncMock()
    proc.stdout.read = AsyncMock(return_value=fake_stdout)
    proc.stderr.read = AsyncMock(return_value=b"")
    proc.wait = AsyncMock(return_value=0)
    proc.returncode = 0

    with patch("services.hermes_session.asyncio.create_subprocess_exec",
               return_value=proc):
        events = await _collect(run_hermes("hi", None, autonomy="step"))

    approval = [e for e in events if e["type"] == "approval_request"]
    assert len(approval) == 1
    assert approval[0]["summary"] == "Run expensive op"
    assert "plan" not in approval[0]
    assert "cost" not in approval[0]


@pytest.mark.asyncio
async def test_parses_learning_saved_marker():
    """LEARNING_SAVED: <slug> on stdout becomes a learning_saved event."""
    fake_stdout = (
        b"session_id: 20260423_095548_a2985d\n"
        b"Loops cleanly now.\n"
        b"LEARNING_SAVED: loop-color-grade-drift\n"
    )

    proc = AsyncMock()
    proc.stdout.read = AsyncMock(return_value=fake_stdout)
    proc.stderr.read = AsyncMock(return_value=b"")
    proc.wait = AsyncMock(return_value=0)
    proc.returncode = 0

    with patch("services.hermes_session.asyncio.create_subprocess_exec",
               return_value=proc):
        events = await _collect(run_hermes("render", None, autonomy="auto"))

    learn = [e for e in events if e["type"] == "learning_saved"]
    assert len(learn) == 1
    assert learn[0]["topic"] == "loop-color-grade-drift"

    text = next((e for e in events if e["type"] == "text"), None)
    if text:
        assert "LEARNING_SAVED" not in text["text"]


@pytest.mark.asyncio
async def test_learning_marker_mid_response_is_not_parsed():
    """LEARNING_SAVED only counts when it's in the contiguous end-of-response tail block."""
    fake_stdout = (
        b"session_id: 20260423_095548_a2985d\n"
        b"I previously noted LEARNING_SAVED: some-slug was useful.\n"
        b"But here is my response.\n"
    )

    proc = AsyncMock()
    proc.stdout.read = AsyncMock(return_value=fake_stdout)
    proc.stderr.read = AsyncMock(return_value=b"")
    proc.wait = AsyncMock(return_value=0)
    proc.returncode = 0

    with patch("services.hermes_session.asyncio.create_subprocess_exec",
               return_value=proc):
        events = await _collect(run_hermes("hi", None, autonomy="auto"))

    learn = [e for e in events if e["type"] == "learning_saved"]
    assert len(learn) == 0  # mid-response mention should not fire
    text = next(e for e in events if e["type"] == "text")
    assert "LEARNING_SAVED" in text["text"]  # stays in body


@pytest.mark.asyncio
async def test_binary_missing_yields_error_event():
    """When hermes binary isn't in PATH, emit error + done gracefully."""
    with patch("services.hermes_session.asyncio.create_subprocess_exec",
               side_effect=FileNotFoundError("no such file")):
        events = await _collect(run_hermes("hi", None, autonomy="auto"))

    assert events[0]["type"] == "error"
    assert "hermes" in events[0]["message"].lower()
    assert "HERMES-SETUP" in events[0]["message"]
    assert events[-1]["type"] == "done"


@pytest.mark.asyncio
async def test_non_zero_exit_surfaces_stderr_tail():
    """If hermes subprocess exits non-zero, emit error with stderr tail."""
    proc = AsyncMock()
    proc.stdout.read = AsyncMock(return_value=b"")
    proc.stderr.read = AsyncMock(return_value=b"auth failed: no API key configured\n")
    proc.wait = AsyncMock(return_value=1)
    proc.returncode = 1

    with patch("services.hermes_session.asyncio.create_subprocess_exec",
               return_value=proc):
        events = await _collect(run_hermes("hi", None, autonomy="auto"))

    error_events = [e for e in events if e["type"] == "error"]
    assert len(error_events) == 1
    assert "auth failed" in error_events[0]["message"]
    assert events[-1]["type"] == "done"
