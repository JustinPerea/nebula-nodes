"""Daedalus runtime — wraps `hermes-daedalus chat -q -Q` subprocess and normalizes
output into the same event dict contract as run_claude.

Yields dicts with a `type` field:
  - session          — {sessionId}
  - text             — {text}
  - thinking         — {text}   progress message from the daedalus agent log
                                or a heartbeat when the log has been quiet
  - approval_request — {summary, plan?, cost?}  (plan/cost omitted if absent)
  - learning_saved   — {topic, entry_preview}
  - error            — {message}
  - done             — {}
"""
from __future__ import annotations

import asyncio
import os
from pathlib import Path
from typing import Any, AsyncIterator

from services.chat_actions import (
    mark_activity,
    reset_activity,
    seconds_since_activity,
)
from services.hermes_verbose_parser import HermesVerboseParser

# Fire a heartbeat only when nothing user-visible has happened for this long.
# 20s is a balance: short enough to reassure users the turn is still alive
# during Kimi's long silent stretches, long enough to not spam the thinking
# box when canvas actions are firing every few seconds.
HEARTBEAT_QUIET_WINDOW = 20.0

PROJECT_ROOT = Path(__file__).resolve().parent.parent.parent

DEFAULT_MODEL = "moonshotai/kimi-k2.6"
DEFAULT_PROVIDER = "openrouter"
DEFAULT_SKILLS = "daedalus-core"

# Path to the Daedalus profile's agent log. We tail this in parallel with the
# subprocess so users see "thinking…" progress updates during multi-minute
# Kimi-powered turns (hermes -Q is non-streaming — stdout only arrives at end).
LOG_PATH = Path.home() / ".hermes" / "profiles" / "daedalus" / "logs" / "agent.log"

# We invoke Hermes through the `hermes-daedalus` profile-alias wrapper instead
# of plain `hermes`. Hermes has no `--profile` flag on `chat`, so the only way
# to guarantee Daedalus uses its own isolated profile (SOUL.md, memories,
# skills) — independent of whatever the user has set as their globally active
# profile — is the alias wrapper. See docs/HERMES-SETUP.md §3 for setup.
HERMES_BIN = "hermes-daedalus"

# Structured markers emitted by Daedalus per SKILL.md directives (Task 8).
# ALL_MARKERS — every line prefix we recognize as a structured marker.
# ANCHOR_MARKERS — subset that signal a real end-of-response marker block.
# PLAN:/COST: alone are ambiguous (could be markdown headings or quoted text);
# they only count as markers when they appear alongside an anchor in the tail.
ALL_MARKERS = ("APPROVAL_REQUIRED:", "PLAN:", "COST:", "LEARNING_SAVED:")
ANCHOR_MARKERS = ("APPROVAL_REQUIRED:", "LEARNING_SAVED:")


def _is_marker(s: str) -> bool:
    return s.startswith(ALL_MARKERS)


def _extract_log_message(line: str) -> str | None:
    """Extract human-readable message from a Hermes log line, or None to skip.

    Lines look like:
      2026-04-23 20:33:52,916 INFO agent.auxiliary_client: Vision auto-detect: using main provider openrouter (moonshotai/kimi-k2.6)
      2026-04-23 20:08:46,643 ERROR [20260423_200844_b6be84] root: Non-retryable client error: Error code: 400 - {...}

    We keep only the message body (everything after the final `module: `) so
    the thinking-stream reads as prose, not logs.
    """
    if " INFO " not in line and " ERROR " not in line:
        return None
    # Skip plugin-discovery / env-load noise that fires on every invocation
    # and adds no signal for the user watching the stream.
    if (
        "hermes_cli.plugins:" in line
        or "run_agent: Loaded environment" in line
        or "run_agent: No .env" in line
    ):
        return None
    # Format: `YYYY-MM-DD HH:MM:SS,ms LEVEL [session_id]? module.name: message body`.
    # The message body itself may contain ": " (e.g. "Vision auto-detect: ..."),
    # so we locate the FIRST `: ` that appears AFTER the level keyword, which
    # is always the module/message boundary.
    for level in (" INFO ", " ERROR "):
        level_idx = line.find(level)
        if level_idx == -1:
            continue
        after_level = line[level_idx + len(level):]
        sep_idx = after_level.find(": ")
        if sep_idx == -1:
            return after_level.strip() or None
        body = after_level[sep_idx + 2:].strip()
        return body or None
    return None


async def _tail_log(
    start_offset: int,
    stop_event: asyncio.Event,
    queue: "asyncio.Queue[str]",
    started_at: float,
) -> None:
    """Tail the daedalus agent log, pushing human-readable messages onto queue.

    Emits:
      - One message per new INFO/ERROR line appended to the log.
      - A heartbeat ("thinking... (Ns elapsed)") every HEARTBEAT_QUIET_WINDOW
        seconds when NOTHING user-visible has fired (log line, stdout line, or
        canvas action from chat_actions). The activity time is shared across
        all three sources via the chat_actions module, so heartbeats naturally
        suppress themselves when canvas actions are streaming in.
    """
    last_heartbeat_time = started_at
    current_offset = start_offset
    while not stop_event.is_set():
        try:
            if LOG_PATH.exists():
                size = LOG_PATH.stat().st_size
                if size > current_offset:
                    with LOG_PATH.open("r", encoding="utf-8", errors="replace") as f:
                        f.seek(current_offset)
                        new = f.read()
                    current_offset = size
                    for line in new.splitlines():
                        msg = _extract_log_message(line)
                        if msg:
                            await queue.put(msg)
                            mark_activity()
                elif size < current_offset:
                    # Log rotated / truncated under us — restart from 0 so we
                    # don't miss fresh entries.
                    current_offset = 0
        except Exception:
            # Tailer must never break the turn; swallow I/O errors silently.
            pass

        now = asyncio.get_event_loop().time()
        # Fire a heartbeat only if (a) nothing user-visible has emitted in the
        # quiet window AND (b) we haven't just fired one. Both guards are
        # needed — (a) handles the "canvas actions are streaming" case;
        # (b) handles the "activity tracker just rolled past the window so
        # now we'd fire twice in quick succession" case.
        if (
            seconds_since_activity() >= HEARTBEAT_QUIET_WINDOW
            and (now - last_heartbeat_time) >= HEARTBEAT_QUIET_WINDOW
        ):
            elapsed = int(now - started_at)
            await queue.put(f"thinking... ({elapsed}s elapsed)")
            last_heartbeat_time = now

        # Sleep ~300ms, but exit promptly if stop_event fires.
        try:
            await asyncio.wait_for(stop_event.wait(), timeout=0.3)
        except asyncio.TimeoutError:
            pass


async def run_hermes(
    message: str,
    session_id: str | None,
    model: str = DEFAULT_MODEL,
    autonomy: str = "auto",
) -> AsyncIterator[dict[str, Any]]:
    """Run a single Daedalus turn via `hermes-daedalus chat -q` and yield events.

    Verbose mode (no `-Q` flag) is used so we can stream pre-tool and post-tool
    narration out of the `╭─ ⚕ Hermes ─...─╯` prose boxes as they arrive. The
    quiet-mode first-line `session_id:` handshake is replaced by parsing
    `Session: <id>` from the footer that prints at the end of the turn.
    """
    # Model override: the frontend's model picker is Claude-specific (defaults
    # to claude-sonnet-4-6). Daedalus must run on Kimi K2.6 for (a) the
    # Hermes Agent Creative Hackathon Kimi-track qualification and (b) because
    # Hermes is configured for OpenRouter and wouldn't recognize Claude Code
    # model slugs. Silently swap any non-OpenRouter-slug model for the Kimi
    # default.
    if "/" not in model:
        model = DEFAULT_MODEL
    args = [
        HERMES_BIN, "chat", "-q", message,
        "--provider", DEFAULT_PROVIDER,
        "--model", model,
        "--skills", DEFAULT_SKILLS,
    ]
    if session_id:
        args.extend(["--resume", session_id])

    env = {
        **os.environ,
        "NEBULA_DISABLE_QUICK": "1",
        "DAEDALUS_APPROVAL": autonomy,
        # Force Python-CLI Hermes to flush stdout after every print so the
        # line-by-line `readline()` reader sees intermediate narration in real
        # time. Without this, Python block-buffers stdout when the descriptor
        # is a pipe — the whole response arrives as a burst at exit, defeating
        # the streaming reader.
        "PYTHONUNBUFFERED": "1",
    }

    # Capture the log's current size BEFORE spawn so the tailer only surfaces
    # lines from *this* turn, not stale entries from previous runs.
    try:
        log_start_offset = LOG_PATH.stat().st_size if LOG_PATH.exists() else 0
    except Exception:
        log_start_offset = 0
    started_at = asyncio.get_event_loop().time()

    try:
        proc = await asyncio.create_subprocess_exec(
            *args,
            stdin=asyncio.subprocess.DEVNULL,
            stdout=asyncio.subprocess.PIPE,
            stderr=asyncio.subprocess.PIPE,
            cwd=str(PROJECT_ROOT),
            env=env,
            limit=64 * 1024 * 1024,
        )
    except FileNotFoundError:
        yield {
            "type": "error",
            "message": (
                "`hermes-daedalus` wrapper not found in PATH. Create it with "
                "`hermes profile create daedalus && hermes profile alias daedalus --name hermes-daedalus`, "
                "then install the skill per docs/HERMES-SETUP.md."
            ),
        }
        yield {"type": "done"}
        return

    # Start the log-tailer task in parallel with the subprocess so we can emit
    # `thinking` events while stdout is still buffering.
    thinking_queue: asyncio.Queue[str] = asyncio.Queue()
    stop_tail = asyncio.Event()
    # Reset the activity clock so the heartbeat waits the full quiet window
    # before firing instead of piggy-backing on a stale timestamp from the
    # previous turn.
    reset_activity()
    # Prime the queue with an immediate "starting..." so the thinking box
    # appears within the first second — gives the user a liveness signal
    # while Hermes boots. Counts as activity (delays the first heartbeat).
    thinking_queue.put_nowait("starting...")
    mark_activity()
    tail_task = asyncio.create_task(
        _tail_log(log_start_offset, stop_tail, thinking_queue, started_at)
    )

    # Raw stdout buffer — kept only for diagnostic tail on non-zero exit.
    # Parsed content (session id, final prose box for the assistant bubble,
    # streamed thinking events) comes from the parser, not this list.
    raw_stdout_lines: list[str] = []
    parser = HermesVerboseParser()

    async def _stream_stdout() -> None:
        """Read hermes verbose-mode stdout line-by-line and feed it through the
        parser. Parser emits `thinking` events for prose-box content (which
        we push onto the thinking queue) and a `session` event when the footer
        announces the session id (captured into the parser instance)."""
        while True:
            line_bytes = await proc.stdout.readline()
            if not line_bytes:
                break
            # Strip both CR and LF — hermes's spinner frames use \r, and we
            # don't want a trailing \r leaking into emitted text.
            line = line_bytes.decode("utf-8", errors="replace").rstrip("\n").rstrip("\r")
            raw_stdout_lines.append(line)
            for evt in parser.feed(line):
                if evt.kind == "thinking":
                    thinking_queue.put_nowait(evt.text)
                    mark_activity()
                # session events are captured into parser.session_id; no need
                # to queue — they're read after stream close.
        parser.finalize()

    try:
        # Kick stdout+stderr reads off as tasks so we can interleave thinking
        # events from the queue without blocking on the full stdout read.
        stdout_task = asyncio.create_task(_stream_stdout())
        stderr_task = asyncio.create_task(proc.stderr.read())

        try:
            # Race stdout completion against queue arrivals so we (a) yield
            # thinking events the instant they arrive and (b) exit the loop
            # as soon as stdout is done, without a 500ms lag.
            while not stdout_task.done():
                queue_task = asyncio.create_task(thinking_queue.get())
                done, _pending = await asyncio.wait(
                    {stdout_task, queue_task},
                    return_when=asyncio.FIRST_COMPLETED,
                )
                if queue_task in done:
                    yield {"type": "thinking", "text": queue_task.result()}
                else:
                    # stdout finished first; cancel the pending queue get.
                    queue_task.cancel()
                    try:
                        await queue_task
                    except (asyncio.CancelledError, Exception):
                        pass
            # Drain any thinking events that landed in the queue between the
            # last await and the subprocess finishing.
            while not thinking_queue.empty():
                try:
                    yield {"type": "thinking", "text": thinking_queue.get_nowait()}
                except asyncio.QueueEmpty:
                    break
            # Surface any exception from the stdout streamer.
            stdout_task.result()
            stderr_bytes = await stderr_task
            await proc.wait()
        except BaseException:
            # Cancel outstanding reads so they don't linger on CancelledError.
            stdout_task.cancel()
            stderr_task.cancel()
            raise
        # (the rest of the original happy-path continues below)

        if proc.returncode != 0:
            stderr_full = stderr_bytes.decode("utf-8", errors="replace").strip()
            stdout_full = "\n".join(raw_stdout_lines).strip()
            # Print the full diagnostics to server logs so we can debug why
            # hermes exits non-zero even when standalone CLI invocations succeed.
            print("=" * 60, flush=True)
            print(f"[hermes_session] hermes exited {proc.returncode}", flush=True)
            print(f"[hermes_session] ARGS: {args}", flush=True)
            print(f"[hermes_session] STDERR ({len(stderr_full)} chars):\n{stderr_full}", flush=True)
            print(f"[hermes_session] STDOUT ({len(stdout_full)} chars):\n{stdout_full}", flush=True)
            print("=" * 60, flush=True)
            # Trim to last 500 chars so a noisy stderr doesn't bloat the chat bubble.
            tail = stderr_full[-500:] if len(stderr_full) > 500 else stderr_full
            yield {
                "type": "error",
                "message": f"hermes exited {proc.returncode}: {tail}" if tail else f"hermes exited {proc.returncode} with no output",
            }
            yield {"type": "done"}
            return

        # No-op — session_id and final text come from the parser now.
    finally:
        # Stop the log tailer before touching the subprocess so it doesn't
        # keep spinning on a file we no longer care about.
        stop_tail.set()
        tail_task.cancel()
        try:
            await tail_task
        except (asyncio.CancelledError, Exception):
            pass
        # If the task was cancelled mid-read, the subprocess is still alive.
        # Kill it to prevent orphaned hermes processes.
        if proc.returncode is None:
            try:
                proc.kill()
                await proc.wait()
            except Exception:
                pass

    # Event accumulators.
    # Session ID in verbose mode comes from the footer's `Session: <id>` line,
    # captured by the parser during streaming.
    session_id_emitted: str | None = parser.session_id
    approval_summary: str | None = None
    approval_plan: str | None = None
    approval_cost: str | None = None
    learning_topic: str | None = None
    filtered_lines: list[str] = []

    # Final response text is the content of the LAST prose Hermes box. Earlier
    # prose boxes are mid-turn narration and were already streamed as thinking
    # events — they don't belong in the persistent assistant bubble.
    lines = list(parser.final_box_lines)

    # Structured markers: APPROVAL_REQUIRED / PLAN / COST / LEARNING_SAVED.
    # Emitted by Daedalus per SKILL.md directives (Task 8) AT THE END of the
    # response. APPROVAL_REQUIRED + PLAN + COST consolidate into one
    # approval_request event; LEARNING_SAVED emits its own learning_saved event.
    #
    # Contract: markers must appear as a contiguous block at the END of stdout,
    # after the response body. This prevents mid-response collisions — e.g. if
    # the model quotes a previous turn ("Earlier I said APPROVAL_REQUIRED: ...")
    # or writes a markdown heading like "PLAN: Next steps", those lines stay in
    # the text body instead of being parsed as markers.
    #
    # ALL_MARKERS and ANCHOR_MARKERS are defined at module scope — they are
    # part of the external contract with Daedalus.

    # Walk backward from the end, collecting contiguous marker lines.
    # Skip trailing blank lines before starting the walk.
    end = len(lines)
    while end > 0 and not lines[end - 1].strip():
        end -= 1

    tail_start = end
    while tail_start > 0 and _is_marker(lines[tail_start - 1].strip()):
        tail_start -= 1

    tail_lines = lines[tail_start:end]
    has_anchor = any(
        ln.strip().startswith(m)
        for ln in tail_lines
        for m in ANCHOR_MARKERS
    )

    if has_anchor:
        # Tail block is the marker block; everything before it is body.
        body_lines = lines[:tail_start]
        for line in tail_lines:
            stripped = line.strip()
            if stripped.startswith("APPROVAL_REQUIRED:"):
                approval_summary = stripped.split(":", 1)[1].strip()
            elif stripped.startswith("PLAN:"):
                approval_plan = stripped.split(":", 1)[1].strip()
            elif stripped.startswith("COST:"):
                approval_cost = stripped.split(":", 1)[1].strip()
            elif stripped.startswith("LEARNING_SAVED:"):
                learning_topic = stripped.split(":", 1)[1].strip()
        filtered_lines = body_lines
    else:
        # No marker tail block — all lines are body.
        filtered_lines = lines

    if session_id_emitted:
        yield {"type": "session", "sessionId": session_id_emitted}

    if approval_summary:
        event: dict[str, Any] = {
            "type": "approval_request",
            "summary": approval_summary,
        }
        if approval_plan is not None:
            event["plan"] = approval_plan
        if approval_cost is not None:
            event["cost"] = approval_cost
        yield event

    if learning_topic:
        # entry_preview hardcoded empty for MVP; later task can parse preview
        # text from SKILL.md emission if Daedalus starts surfacing it.
        yield {"type": "learning_saved", "topic": learning_topic, "entry_preview": ""}

    body = "\n".join(filtered_lines).strip()
    if body:
        yield {"type": "text", "text": body}

    yield {"type": "done"}
