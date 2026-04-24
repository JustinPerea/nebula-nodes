"""Daedalus runtime — wraps `hermes-daedalus chat -q -Q` subprocess and normalizes
output into the same event dict contract as run_claude.

Yields dicts with a `type` field:
  - session          — {sessionId}
  - text             — {text}
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

PROJECT_ROOT = Path(__file__).resolve().parent.parent.parent

DEFAULT_MODEL = "moonshotai/kimi-k2.6"
DEFAULT_PROVIDER = "openrouter"
DEFAULT_SKILLS = "daedalus-core"

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


async def run_hermes(
    message: str,
    session_id: str | None,
    model: str = DEFAULT_MODEL,
    autonomy: str = "auto",
) -> AsyncIterator[dict[str, Any]]:
    """Run a single Daedalus turn via `hermes-daedalus chat -q -Q` and yield events."""
    # Note (from Task 0 fixture): `hermes chat -Q` emits `session_id: <id>` on
    # its own first line automatically — no `--pass-session-id` flag needed.
    #
    # Model override: the frontend's model picker is Claude-specific (defaults
    # to claude-sonnet-4-6). Daedalus must run on Kimi K2.6 for (a) the
    # Hermes Agent Creative Hackathon Kimi-track qualification and (b) because
    # Hermes is configured for OpenRouter and wouldn't recognize Claude Code
    # model slugs. Silently swap any non-OpenRouter-slug model for the Kimi
    # default.
    if "/" not in model:
        model = DEFAULT_MODEL
    args = [
        HERMES_BIN, "chat", "-q", message, "-Q",
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
    }

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

    try:
        stdout_bytes = await proc.stdout.read()
        stderr_bytes = await proc.stderr.read()
        await proc.wait()

        if proc.returncode != 0:
            stderr_full = stderr_bytes.decode("utf-8", errors="replace").strip()
            stdout_full = stdout_bytes.decode("utf-8", errors="replace").strip()
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

        text = stdout_bytes.decode("utf-8", errors="replace")
    finally:
        # If the task was cancelled mid-read, the subprocess is still alive.
        # Kill it to prevent orphaned hermes processes.
        if proc.returncode is None:
            try:
                proc.kill()
                await proc.wait()
            except Exception:
                pass

    # Event accumulators.
    # Session ID format verified via Task 0 fixture: Hermes `-Q` mode prints
    # `session_id: <timestamp_id>` on the first line (e.g. `session_id: 20260423_095548_a2985d`).
    session_id_emitted: str | None = None
    approval_summary: str | None = None
    approval_plan: str | None = None
    approval_cost: str | None = None
    learning_topic: str | None = None
    filtered_lines: list[str] = []

    lines = text.splitlines()

    # Session ID only appears as a first-line marker in hermes -Q mode.
    # Restrict the check to the first non-empty line to avoid false positives
    # if a model echoes "session_id" mid-response.
    first_non_empty_idx = next(
        (i for i, ln in enumerate(lines) if ln.strip()),
        None,
    )
    if first_non_empty_idx is not None:
        first = lines[first_non_empty_idx].strip()
        if first.lower().startswith("session_id:"):
            session_id_emitted = first.split(":", 1)[1].strip()
            # Drop the session line from downstream processing.
            lines = lines[:first_non_empty_idx] + lines[first_non_empty_idx + 1:]

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
