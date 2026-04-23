"""Hephaestus runtime — wraps `hermes chat -q -Q` subprocess and normalizes
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
DEFAULT_SKILLS = "hephaestus-core"


async def run_hermes(
    message: str,
    session_id: str | None,
    model: str = DEFAULT_MODEL,
    autonomy: str = "auto",
) -> AsyncIterator[dict[str, Any]]:
    """Run a single Hephaestus turn via `hermes chat -q -Q` and yield events."""
    # Note (from Task 0 fixture): `hermes chat -Q` emits `session_id: <id>` on
    # its own first line automatically — no `--pass-session-id` flag needed.
    args = [
        "hermes", "chat", "-q", message, "-Q",
        "--provider", DEFAULT_PROVIDER,
        "--model", model,
        "--skills", DEFAULT_SKILLS,
    ]
    if session_id:
        args.extend(["--resume", session_id])

    env = {
        **os.environ,
        "NEBULA_DISABLE_QUICK": "1",
        "HEPHAESTUS_APPROVAL": autonomy,
    }

    try:
        proc = await asyncio.create_subprocess_exec(
            *args,
            stdout=asyncio.subprocess.PIPE,
            stderr=asyncio.subprocess.PIPE,
            cwd=str(PROJECT_ROOT),
            env=env,
            limit=64 * 1024 * 1024,
        )
    except FileNotFoundError:
        yield {"type": "error", "message": "`hermes` binary not found in PATH. See docs/HERMES-SETUP.md."}
        yield {"type": "done"}
        return

    stdout_bytes = await proc.stdout.read()
    _ = await proc.stderr.read()
    await proc.wait()

    text = stdout_bytes.decode("utf-8", errors="replace")

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
    # Emitted by Hephaestus per SKILL.md directives (Task 8) AT THE END of the
    # response. APPROVAL_REQUIRED + PLAN + COST consolidate into one
    # approval_request event; LEARNING_SAVED emits its own learning_saved event.
    #
    # Contract: markers must appear as a contiguous block at the END of stdout,
    # after the response body. This prevents mid-response collisions — e.g. if
    # the model quotes a previous turn ("Earlier I said APPROVAL_REQUIRED: ...")
    # or writes a markdown heading like "PLAN: Next steps", those lines stay in
    # the text body instead of being parsed as markers.
    #
    # "Anchor" markers signal a real end-of-response marker block.
    # PLAN:/COST: on their own (without an anchor) likely come from narrative
    # text (markdown headings, quoted planning discussion) and stay in body.
    # Either APPROVAL_REQUIRED or LEARNING_SAVED serves as a valid anchor.
    ANCHOR_MARKERS = ("APPROVAL_REQUIRED:", "LEARNING_SAVED:")

    def _is_marker(s: str) -> bool:
        return (
            s.startswith("APPROVAL_REQUIRED:")
            or s.startswith("PLAN:")
            or s.startswith("COST:")
            or s.startswith("LEARNING_SAVED:")
        )

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

    if learning_topic is not None:
        yield {"type": "learning_saved", "topic": learning_topic, "entry_preview": ""}

    body = "\n".join(filtered_lines).strip()
    if body:
        yield {"type": "text", "text": body}

    yield {"type": "done"}
