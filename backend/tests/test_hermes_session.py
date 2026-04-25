"""Tests for run_hermes — mirrors the run_claude event contract."""
from __future__ import annotations

import asyncio
from unittest.mock import AsyncMock, patch

import pytest

import sys
from pathlib import Path
sys.path.insert(0, str(Path(__file__).resolve().parent.parent))

from services.hermes_session import run_hermes


async def _collect(agen):
    return [event async for event in agen]


def _readline_chunks(data: bytes) -> list[bytes]:
    """Split bytes into stdout.readline()-style chunks for AsyncMock side_effect.

    Each chunk is one line with trailing `\\n` preserved; the final chunk is
    `b''` signalling EOF. `run_hermes` calls `proc.stdout.readline()` in a loop
    and breaks on empty bytes, so this mirrors real subprocess behavior.
    """
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


# --- Verbose-mode fixture builder -------------------------------------------
# run_hermes now invokes `hermes chat` WITHOUT -Q; Hermes emits a banner,
# Query echo, `╭─ ⚕ Hermes ─╮` prose boxes interleaved with `┊ 💻` tool
# previews, and a footer containing `Session: <id>`. Tests feed this shape
# through proc.stdout so the verbose-mode parser exercises end-to-end.

_BOX_TOP = "╭──── ⚕ Hermes ────────────────────────╮"
_BOX_BOT = "╰──────────────────────────────────────╯"


def _verbose_bytes(
    *,
    query: str = "hi",
    prose_boxes: list[list[str]],
    session_id: str = "20260424_120000_abcdef",
    tool_previews: list[list[str]] | None = None,
) -> bytes:
    """Build synthetic verbose-mode stdout bytes.

    `prose_boxes` is a list of prose-box contents (each a list of lines).
    `tool_previews` is an optional list of tool-preview line groups, one per
    gap between prose boxes.
    """
    tool_previews = tool_previews or []
    lines: list[str] = [
        # Banner chrome — parser skips until `Query:` appears.
        "╭─ banner ─╮",
        "│ Hermes Agent v0.10.0 │",
        "╰──────────╯",
        f"Query: {query}",
        "Initializing agent...",
        "─" * 40,
        "",
    ]
    for i, box in enumerate(prose_boxes):
        lines.append(_BOX_TOP)
        for bl in box:
            lines.append(f"│    {bl}    │")
        lines.append(_BOX_BOT)
        if i < len(tool_previews):
            lines.extend(tool_previews[i])
        lines.append("")
    lines.extend([
        "Resume this session with:",
        f"  hermes --resume {session_id}",
        "",
        f"Session:        {session_id}",
        "Duration:       1m 2s",
        "Messages:       4 (1 user, 2 tool calls)",
    ])
    return ("\n".join(lines) + "\n").encode("utf-8")


@pytest.mark.asyncio
async def test_happy_path_yields_text_and_done():
    """Minimal successful turn: Hermes prints a response, wrapper emits text + done."""
    fake_stdout = _verbose_bytes(prose_boxes=[["HELLO"]])
    fake_stderr = b""

    proc = AsyncMock()
    proc.stdout.readline = AsyncMock(side_effect=_readline_chunks(fake_stdout))
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
    fake_stdout = _verbose_bytes(
        prose_boxes=[["Some response text."]],
        session_id="20260423_095548_a2985d",
    )

    proc = AsyncMock()
    proc.stdout.readline = AsyncMock(side_effect=_readline_chunks(fake_stdout))
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
        proc.stdout.readline = AsyncMock(side_effect=_readline_chunks(b"ok\n"))
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
    """When Daedalus prints APPROVAL_REQUIRED, emit approval_request event."""
    fake_stdout = _verbose_bytes(
        prose_boxes=[[
            "Planning the render.",
            "APPROVAL_REQUIRED: Run Veo 3.1 on n4 (est $0.15, ~60s)",
            "PLAN: connect n2:image -> n4:first_frame + n4:last_frame; run n4",
            "COST: $0.15",
        ]],
        session_id="20260423_095548_a2985d",
    )

    proc = AsyncMock()
    proc.stdout.readline = AsyncMock(side_effect=_readline_chunks(fake_stdout))
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
    fake_stdout = _verbose_bytes(
        prose_boxes=[[
            "Earlier I said APPROVAL_REQUIRED: run this.",
            "But I've changed my plan.",
            "Here is the final result with no pending approval.",
        ]],
        session_id="20260423_095548_a2985d",
    )

    proc = AsyncMock()
    proc.stdout.readline = AsyncMock(side_effect=_readline_chunks(fake_stdout))
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
    fake_stdout = _verbose_bytes(
        prose_boxes=[[
            "Planning.",
            "APPROVAL_REQUIRED: Run expensive op",
        ]],
        session_id="20260423_095548_a2985d",
    )

    proc = AsyncMock()
    proc.stdout.readline = AsyncMock(side_effect=_readline_chunks(fake_stdout))
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
    fake_stdout = _verbose_bytes(
        prose_boxes=[[
            "Loops cleanly now.",
            "LEARNING_SAVED: loop-color-grade-drift",
        ]],
        session_id="20260423_095548_a2985d",
    )

    proc = AsyncMock()
    proc.stdout.readline = AsyncMock(side_effect=_readline_chunks(fake_stdout))
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
    fake_stdout = _verbose_bytes(
        prose_boxes=[[
            "I previously noted LEARNING_SAVED: some-slug was useful.",
            "But here is my response.",
        ]],
        session_id="20260423_095548_a2985d",
    )

    proc = AsyncMock()
    proc.stdout.readline = AsyncMock(side_effect=_readline_chunks(fake_stdout))
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
    """When hermes-daedalus wrapper isn't in PATH, emit error + done gracefully."""
    with patch("services.hermes_session.asyncio.create_subprocess_exec",
               side_effect=FileNotFoundError("no such file")):
        events = await _collect(run_hermes("hi", None, autonomy="auto"))

    assert events[0]["type"] == "error"
    assert "hermes-daedalus" in events[0]["message"].lower()
    # Message points the user at the profile-alias setup flow.
    assert "profile alias daedalus" in events[0]["message"]
    assert events[-1]["type"] == "done"


@pytest.mark.asyncio
async def test_non_zero_exit_surfaces_stderr_tail():
    """If hermes subprocess exits non-zero, emit error with stderr tail."""
    proc = AsyncMock()
    proc.stdout.readline = AsyncMock(side_effect=_readline_chunks(b""))
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


@pytest.mark.asyncio
async def test_cancelled_task_kills_subprocess():
    """If stdout.read is interrupted (cancellation), the subprocess is killed via finally."""
    import asyncio as _asyncio

    killed = {"value": False}

    class FakeProc:
        def __init__(self):
            self.returncode = None
            self.stdout = AsyncMock()
            self.stderr = AsyncMock()
            # Simulate the task being cancelled mid-read.
            self.stdout.readline = AsyncMock(side_effect=_asyncio.CancelledError)
            self.stderr.read = AsyncMock(return_value=b"")

        async def wait(self):
            return 0

        def kill(self):
            killed["value"] = True
            self.returncode = -9

    proc = FakeProc()
    with patch("services.hermes_session.asyncio.create_subprocess_exec",
               return_value=proc):
        agen = run_hermes("hi", None, autonomy="auto")
        with pytest.raises(_asyncio.CancelledError):
            async for _ in agen:
                pass

    assert killed["value"], "subprocess should have been killed on cancellation"


@pytest.mark.asyncio
async def test_thinking_events_emitted_from_log_tail(tmp_path, monkeypatch):
    """A simulated log file with INFO lines should produce thinking events.

    The tailer watches `LOG_PATH` and surfaces human-readable log messages
    as `thinking` events in parallel with the (slow) subprocess read.
    """
    from services import hermes_session

    log_file = tmp_path / "agent.log"
    log_file.write_text("")
    monkeypatch.setattr(hermes_session, "LOG_PATH", log_file)

    # Subprocess takes 1s before returning stdout, giving the tailer time to
    # observe log writes. Stdout has an actual response so the turn completes
    # with a text event too (sanity).
    readline_calls = {"n": 0}

    async def fake_readline_stdout():
        readline_calls["n"] += 1
        if readline_calls["n"] == 1:
            await asyncio.sleep(1.0)
            return b"done.\n"
        return b""

    async def fake_read_stderr():
        return b""

    proc = AsyncMock()
    proc.stdout.readline = AsyncMock(side_effect=fake_readline_stdout)
    proc.stderr.read = AsyncMock(side_effect=fake_read_stderr)
    proc.wait = AsyncMock(return_value=0)
    proc.returncode = 0

    async def fake_create(*args, **kwargs):
        async def write_log_entries():
            await asyncio.sleep(0.3)
            # Use a non-noise log line — `agent.auxiliary_client: Vision
            # auto-detect: …` lines are filtered as startup chatter (see
            # `test_extract_log_message_filters_auxiliary_noise`), so the
            # log-tail emission path needs a fixture that survives the filter.
            log_file.write_text(
                "2026-01-01 00:00:00,000 INFO agent.runtime: "
                "Pipeline ready\n"
            )
        asyncio.create_task(write_log_entries())
        return proc

    with patch(
        "services.hermes_session.asyncio.create_subprocess_exec",
        side_effect=fake_create,
    ):
        events = await _collect(run_hermes("hi", None, autonomy="auto"))

    thinking = [e for e in events if e["type"] == "thinking"]
    assert len(thinking) >= 1
    assert any("Pipeline ready" in e["text"] for e in thinking)
    # Sanity: the rest of the event contract still fires.
    assert events[-1]["type"] == "done"


@pytest.mark.asyncio
async def test_thinking_noise_lines_filtered(tmp_path, monkeypatch):
    """Plugin-discovery / env-load noise should NOT produce thinking events."""
    from services import hermes_session

    log_file = tmp_path / "agent.log"
    log_file.write_text("")
    monkeypatch.setattr(hermes_session, "LOG_PATH", log_file)

    readline_calls = {"n": 0}

    async def fake_readline_stdout():
        readline_calls["n"] += 1
        if readline_calls["n"] == 1:
            await asyncio.sleep(0.8)
            return b"done.\n"
        return b""

    proc = AsyncMock()
    proc.stdout.readline = AsyncMock(side_effect=fake_readline_stdout)
    proc.stderr.read = AsyncMock(return_value=b"")
    proc.wait = AsyncMock(return_value=0)
    proc.returncode = 0

    async def fake_create(*args, **kwargs):
        async def write_noise():
            await asyncio.sleep(0.2)
            log_file.write_text(
                "2026-01-01 00:00:00,000 INFO hermes_cli.plugins: scanning entry points\n"
                "2026-01-01 00:00:00,001 INFO run_agent: Loaded environment from .env\n"
                "2026-01-01 00:00:00,002 INFO run_agent: No .env found\n"
            )
        asyncio.create_task(write_noise())
        return proc

    with patch(
        "services.hermes_session.asyncio.create_subprocess_exec",
        side_effect=fake_create,
    ):
        events = await _collect(run_hermes("hi", None, autonomy="auto"))

    thinking = [e for e in events if e["type"] == "thinking"]
    assert all("hermes_cli.plugins" not in e["text"] for e in thinking)
    assert all("run_agent" not in e["text"] for e in thinking)


def test_extract_log_message_happy_path():
    """`_extract_log_message` keeps only the prose body after `module: `."""
    from services.hermes_session import _extract_log_message

    # Using a non-auxiliary_client line because lines from that module that
    # match the auto-detect / title_generation patterns are explicitly
    # filtered (see `test_extract_log_message_filters_auxiliary_noise`).
    line = (
        "2026-04-23 20:33:52,916 INFO agent.runtime: "
        "Pipeline ready — 3 nodes, 2 edges"
    )
    out = _extract_log_message(line)
    assert out is not None
    # Keeps the body, strips the timestamp + module.
    assert out.startswith("Pipeline ready")
    assert "agent.runtime" not in out


def test_extract_log_message_filters_auxiliary_noise():
    """`agent.auxiliary_client` lines that are pure provider auto-detection
    or post-turn title generation should be dropped — they fire every turn
    before any real work happens and only add noise to the thinking stream.
    """
    from services.hermes_session import _extract_log_message

    noise_lines = [
        "2026-04-23 20:33:52 INFO agent.auxiliary_client: "
        "Vision auto-detect: using main provider nous (google/gemini-3-flash-preview)",
        "2026-04-23 20:33:53 INFO agent.auxiliary_client: "
        "Auxiliary auto-detect: using main provider nous (moonshotai/kimi-k2.6)",
        "2026-04-23 20:33:54 INFO agent.auxiliary_client: "
        "Auxiliary title_generation: using auto (moonshotai/kimi-k2.6) at https://...",
    ]
    for line in noise_lines:
        assert _extract_log_message(line) is None, f"should drop: {line[:80]}"

    # Non-noise auxiliary_client lines (e.g. real call results) still pass.
    real_call = (
        "2026-04-23 20:33:55 INFO agent.auxiliary_client: "
        "Vision call returned 1 description"
    )
    out = _extract_log_message(real_call)
    assert out is not None
    assert "Vision call" in out


def test_extract_log_message_skips_non_info_lines():
    from services.hermes_session import _extract_log_message
    assert _extract_log_message("") is None
    assert _extract_log_message("some debug output") is None
    # DEBUG-level lines pass through the INFO/ERROR filter → dropped.
    assert _extract_log_message("2026-04-23 DEBUG foo: bar") is None


def test_extract_log_message_skips_plugin_noise():
    from services.hermes_session import _extract_log_message
    line = "2026-04-23 20:33:52,000 INFO hermes_cli.plugins: loaded"
    assert _extract_log_message(line) is None
