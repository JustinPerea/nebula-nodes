"""Hephaestus runtime — wraps `hermes chat -q -Q` subprocess and normalizes
output into the same event dict contract as run_claude.

Yields dicts with a `type` field:
  - session          — {sessionId}
  - text             — {text}
  - approval_request — {summary, plan, cost}
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
    if text.strip():
        yield {"type": "text", "text": text.rstrip("\n")}
    yield {"type": "done"}
