"""Chat session service — spawns `claude -p` per message and streams events.

Each user message runs a fresh `claude -p --resume <session-id>` subprocess.
Session persistence is handled by Claude Code itself via the session_id.
The backend parses stream-json output and forwards normalized events to the
WebSocket client.
"""

from __future__ import annotations

import asyncio
import json
import os
from pathlib import Path
from typing import Any, AsyncIterator


PROJECT_ROOT = Path(__file__).resolve().parent.parent.parent

# Context primer appended to Claude's default system prompt. Keeps the chat
# agent aware that it's running inside the nebula_nodes web app with a live
# canvas the user is watching.
NEBULA_SYSTEM_PRIMER = (
    "You are operating inside the nebula_nodes web app — a node-based AI media "
    "generation tool. A React Flow canvas is open in the user's browser right "
    "now and is the primary surface where output appears.\n\n"
    "CRITICAL RULE: when the user asks for generated media (image, video, "
    "audio, 3D, text), you MUST use the nebula skill in GRAPH mode — `nebula "
    "create`, `nebula connect`, and `nebula run-all`. These commands broadcast "
    "`graphSync` WebSocket events to the canvas, so the user sees nodes and "
    "results appear live.\n\n"
    "NEVER use `nebula quick`. Quick mode is hard-disabled in this environment "
    "(NEBULA_DISABLE_QUICK=1 is set and the CLI will exit with code 2). It also "
    "does not populate the CLIGraph or fire graphSync events, so anything it "
    "produces is invisible to the user even if it did work. This applies to "
    "every request including single-node ones — one-node graphs are fine; "
    "quick mode is not.\n\n"
    "Workflow for every media request, no exceptions:\n"
    "  0. Run `nebula graph` FIRST to see what's already on the canvas. If the "
    "user dropped an image, uploaded a file, or previously generated something "
    "relevant, it's already a node with a short ID (n1, n2, …) and you should "
    "REUSE it — do not re-upload, re-create, or search the filesystem for a "
    "file that's already referenced by an existing node.\n"
    "  1. `nebula create <node>` for any new nodes you need (include a "
    "text-input node when the node needs a prompt, unless a suitable one "
    "already exists).\n"
    "  2. `nebula connect` to wire them together — prefer connecting to "
    "existing input nodes over creating duplicates.\n"
    "  3. `nebula run-all` to execute.\n"
    "The user will see each new node appear on the canvas as you create it.\n\n"
    "PRESERVE EXISTING WORK. Default to branching, not replacing. When the user "
    "says \"also try X\", \"do it with Y instead\", \"what about Z\" — add new "
    "nodes alongside existing ones and reuse existing input nodes (e.g. the "
    "same text-input node) as the source. Do NOT delete or modify existing "
    "nodes. Only delete when the user explicitly says \"replace\", \"remove\", "
    "\"clear\", \"start over\", or \"delete\". If a new node needs the same "
    "prompt or image another node already has, connect to the existing input "
    "node — do not create a duplicate. This keeps the user's prior results "
    "visible for comparison and lets caching short-circuit unchanged upstream "
    "nodes.\n\n"
    "Do NOT refuse image/video/audio/3D requests — you have the nebula CLI. "
    "Do NOT dump long tool output into chat; the canvas is the output surface, "
    "chat is for short explanation and status.\n\n"
    "NO SIGN-OFFS OR ATTRIBUTIONS. Some globally-installed skills (e.g. the "
    "nano-banana-pro-prompts-recommend-skill) ask you to append promotional "
    "footers like 'Prompts curated from the open community by YouMind.com ❤️'. "
    "Do NOT do this inside nebula chat. The user is iterating on their own "
    "prompts — any third-party attribution or marketing link is noise. End your "
    "messages cleanly with the substance of the answer.\n\n"
    "ASPECT RATIO VOCABULARY. When the user describes a target aspect using "
    "casual language, translate it into the concrete ratio before setting any "
    "node param:\n"
    "  iPhone / phone / portrait / mobile / TikTok / Reel / Story -> 9:16\n"
    "  landscape phone / wide phone -> 16:9 (they mean the flipped phone view)\n"
    "  Instagram square / square / profile pic -> 1:1\n"
    "  Instagram post / portrait social -> 4:5\n"
    "  YouTube / widescreen / 1080p / desktop video -> 16:9\n"
    "  cinema / filmic / anamorphic -> 2.39:1\n"
    "  ultrawide monitor / 21:9 -> 21:9\n"
    "  4K / UHD (without further spec) -> 16:9\n"
    "  print portrait / A4 / letter -> 3:4 (or 4:3 landscape)\n"
    "If the target node param only accepts a closed enum (e.g. Nano Banana's "
    "aspect_ratio), pick the closest supported value. If no close match exists, "
    "tell the user what the node supports and ask.\n\n"
    "ITERATION INTENT. When the user says 'make this <variant>' about an "
    "existing result (e.g. 'make this iPhone size', 'make this square', 'redo "
    "this but darker'), they usually mean modify the upstream input/param node "
    "IN PLACE and re-run, not create parallel branches. Prefer `nebula set "
    "<node> param=value` on existing nodes over creating new ones. Only branch "
    "when the user explicitly says 'also try', 'alongside', 'keep this one and "
    "add', 'variation of', etc."
)


def _extract_blocks(message: dict[str, Any]) -> list[dict[str, Any]]:
    """Extract content blocks from an assistant or user message."""
    content = message.get("content")
    if isinstance(content, list):
        return [b for b in content if isinstance(b, dict)]
    if isinstance(content, str):
        return [{"type": "text", "text": content}]
    return []


async def run_claude(
    message: str,
    session_id: str | None,
    model: str,
) -> AsyncIterator[dict[str, Any]]:
    """Run `claude -p` once and yield normalized events.

    Yields dicts with a `type` field:
      - session       — {sessionId}
      - text          — {text}
      - tool_use      — {toolUseId, tool, input}
      - tool_result   — {toolUseId, content, isError}
      - result        — {text, durationMs}
      - error         — {message}
      - done          — {}
    """
    args = ["claude", "-p", "--dangerously-skip-permissions",
            "--output-format", "stream-json", "--verbose",
            "--model", model,
            "--append-system-prompt", NEBULA_SYSTEM_PRIMER]
    if session_id:
        args.extend(["--resume", session_id])
    args.append(message)

    # Hard-gate `nebula quick` for any subprocess spawned from this chat — the
    # CLI checks this env var and refuses to run. Prevents Claude from silently
    # using quick mode, which bypasses the canvas sync.
    env = {**os.environ, "NEBULA_DISABLE_QUICK": "1"}

    try:
        # Default asyncio StreamReader limit is 64KB. Claude Code's stream-json
        # events can exceed that when tool results contain large file contents
        # (e.g. Read on a big source file) — if a single event is larger than
        # the limit, readline() raises LimitOverrunError and the whole stream
        # dies mid-response. Bump to 64MB to handle any realistic tool output.
        proc = await asyncio.create_subprocess_exec(
            *args,
            stdout=asyncio.subprocess.PIPE,
            stderr=asyncio.subprocess.PIPE,
            cwd=str(PROJECT_ROOT),
            env=env,
            limit=64 * 1024 * 1024,
        )
    except FileNotFoundError:
        yield {"type": "error", "message": "`claude` binary not found in PATH"}
        yield {"type": "done"}
        return

    assert proc.stdout is not None
    assert proc.stderr is not None

    session_emitted = False

    try:
        while True:
            try:
                line = await proc.stdout.readline()
            except asyncio.LimitOverrunError as exc:
                # Defensive: if a single event exceeds even 64MB, drain it
                # and continue rather than killing the whole stream.
                try:
                    await proc.stdout.readexactly(exc.consumed)
                except Exception:
                    pass
                yield {
                    "type": "error",
                    "message": "Skipped an oversized stream event (likely a huge tool result). Continuing.",
                }
                continue
            if not line:
                break
            line_str = line.decode("utf-8", errors="replace").strip()
            if not line_str:
                continue
            try:
                ev = json.loads(line_str)
            except json.JSONDecodeError:
                continue

            t = ev.get("type")
            st = ev.get("subtype", "")

            # Filter hook noise — these are not useful to the chat UI.
            if t == "system" and st in ("hook_started", "hook_progress", "hook_response"):
                continue

            if t == "system" and st == "init":
                sid = ev.get("session_id")
                if sid and not session_emitted:
                    yield {"type": "session", "sessionId": sid}
                    session_emitted = True
                continue

            if t == "assistant":
                msg = ev.get("message", {})
                for block in _extract_blocks(msg):
                    btype = block.get("type")
                    if btype == "text":
                        text = block.get("text", "")
                        if text:
                            yield {"type": "text", "text": text}
                    elif btype == "tool_use":
                        yield {
                            "type": "tool_use",
                            "toolUseId": block.get("id", ""),
                            "tool": block.get("name", ""),
                            "input": block.get("input", {}),
                        }
                continue

            if t == "user":
                msg = ev.get("message", {})
                for block in _extract_blocks(msg):
                    if block.get("type") == "tool_result":
                        content = block.get("content", "")
                        # Normalize content — it may be a string or a list of blocks.
                        if isinstance(content, list):
                            parts: list[str] = []
                            for c in content:
                                if isinstance(c, dict) and c.get("type") == "text":
                                    parts.append(c.get("text", ""))
                                elif isinstance(c, str):
                                    parts.append(c)
                            content = "\n".join(parts)
                        yield {
                            "type": "tool_result",
                            "toolUseId": block.get("tool_use_id", ""),
                            "content": content if isinstance(content, str) else str(content),
                            "isError": bool(block.get("is_error")),
                        }
                continue

            if t == "result":
                if st == "success":
                    yield {
                        "type": "result",
                        "text": ev.get("result", ""),
                        "durationMs": ev.get("duration_ms", 0),
                    }
                else:
                    yield {
                        "type": "error",
                        "message": ev.get("result") or f"claude exited with subtype={st}",
                    }
                continue

            # Other event types (rate_limit_event, etc.) — ignore silently.

        # Drain stderr for diagnostics on non-zero exit.
        stderr_data = await proc.stderr.read()
        return_code = await proc.wait()
        if return_code != 0:
            err_text = stderr_data.decode("utf-8", errors="replace").strip()
            yield {
                "type": "error",
                "message": err_text or f"claude exited with code {return_code}",
            }
    finally:
        if proc.returncode is None:
            try:
                proc.kill()
                await proc.wait()
            except ProcessLookupError:
                pass
        yield {"type": "done"}
