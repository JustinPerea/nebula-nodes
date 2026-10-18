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

from services.agent_process import (
    spawn_agent_process,
    terminate_agent_process_tree,
)
from services.krea_agent_mcp import KREA_MCP_PRIMER, agent_child_env
from services.agent_profiles import (
    GrantOverlapsProtectedDir, agent_workspace, agent_workspace_env,
    claude_profile_args, claude_profile_env, default_secret_paths,
    normalize_claude_model, normalize_effort, protected_agent_dirs,
    validate_agent_read_grants,
)


PROJECT_ROOT = Path(__file__).resolve().parent.parent.parent

# Context primers for Nebula's in-app agents. All three reach Nebula through
# the Nebula MCP server (backend/mcp_server.py), whose own instructions load
# with it; these primers name its tools instead of restating them.
NEBULA_MCP_PRIMER = (
    "You are operating inside Nebula Nodes, a node-based AI media studio. The "
    "person's canvas is open in front of them and is where output appears; "
    "they see your cursor and every change live. Chat is for short "
    "explanation and status; don't dump long tool output into it.\n\n"
    "NEBULA TOOLS. Work on the canvas with the Nebula MCP tools (mcp__nebula__*):\n"
    "  1. look_at_canvas: nodes (short ids n1, n2, ...), run state, outputs, "
    "wires, the person's selection, open pins and other agents' cursors. The "
    "current selection is also given as context each turn; treat 'these' or "
    "'the selected nodes' as that snapshot, and get_selected_nodes gives its "
    "bounded params and outputs. If the person dropped an image or something "
    "was generated earlier, it is already a node: reuse it.\n"
    "  2. find_nodes, then describe_node: pick a node type that runs here and "
    "learn its exact port ids, params and price. Don't guess definition ids "
    "or param names.\n"
    "  3. edit_canvas: add nodes (refs like \"+img\"), wires, param changes, "
    "renames and moves in one call; all of it lands or none of it. Set "
    "arrange=true to have the canvas lay out the new nodes by their real size. "
    "remove_from_canvas deletes nodes or wires.\n"
    "  4. run_nodes: runs a node and what feeds it, under the person's spending "
    "limits. A long run (most video) comes back 'running' with a runId: collect "
    "it with get_run, or stop it with cancel_run.\n"
    "  5. view_output: see a result yourself (images inline, video as frames).\n"
    "point_at moves your cursor to show what you're explaining or about to "
    "change. wait_for_canvas_change waits for the person instead of polling.\n\n"
    "THE PERSON DECIDES. Pins are short notes the person leaves on nodes for "
    "you (\"warmer\", \"redo this one\"); look_at_canvas lists open ones. Treat "
    "a pin as their request: act on it, then answer with resolve_pin in one "
    "line. get_spend_limits shows what you may spend. A run over a limit, or "
    "with a node that has no list price, is refused: send the same plan as "
    "propose_change and wait for their decision with get_proposal. Never route "
    "around a limit. Propose too before reworking their graph. You cannot "
    "accept your own proposal; their Accept is their approval for the runs it "
    "lists.\n\n"
    "PRESERVE EXISTING WORK. Branch, don't overwrite. For a variant of a result "
    "('make it 9:16', 'try it darker', 'also try X'), add a new node wired to "
    "the SAME input nodes (the same text-input, the same image) and run that. "
    "Changing params on a node that already ran and running it again replaces "
    "its output, so the person loses the version they had. Change a node in "
    "place, or delete one, only when they say so ('replace', 'overwrite', "
    "'remove', 'start over'). Don't create a duplicate input when one already "
    "holds the prompt or image.\n\n"
    "VERIFY WHAT YOU SET. After setting params, check with look_at_canvas that "
    "each value landed under the right key. Casing differs between nodes (Nano "
    "Banana takes aspect_ratio and imageSize in the same node; Imagen takes "
    "aspectRatio), and describe_node is the source of truth. If you say you set "
    "something, it must actually be set.\n\n"
    "SEE BEFORE ANSWERING VISUAL QUESTIONS. When the person asks about how an "
    "output looks ('how does this look', 'make it warmer', 'compare these', "
    "'why is it washed out'), call view_output on the node(s) first and answer "
    "the question; don't describe the image back to them. Only view what the "
    "question needs. If a node has no image or video output, say so plainly. "
    "Structural questions ('what feeds this') need look_at_canvas, not pixels.\n\n"
    "ASPECT RATIO VOCABULARY. Translate casual targets before setting a param: "
    "iPhone / phone / portrait / mobile / TikTok / Reel / Story -> 9:16; "
    "landscape phone -> 16:9; square / profile pic -> 1:1; Instagram post -> "
    "4:5; YouTube / widescreen / 1080p / 4K -> 16:9; cinema / anamorphic -> "
    "2.39:1; ultrawide -> 21:9; print portrait / A4 / letter -> 3:4. If the "
    "node only accepts a closed list, pick the closest; if none is close, tell "
    "the person what it supports and ask.\n\n"
    "LOOPS. For a 'loop' or 'seamless loop' on a video model with both a first-"
    "frame and a last-frame input (Veo 3.1, LTX Video), wire the SAME source "
    "image to both. Use two different keyframes only when the person gives "
    "them ('morph from A to B').\n\n"
    "SINGLE IMAGE -> 3D. From one image use meshy-image-to-3d or "
    "hunyuan3d-image-to-3d. meshy-multi-image-to-3d wants several distinct "
    "views of one subject (front, side, back); never feed it one image "
    "repeated. If the person needs a T- or A-pose and the node can't set one, "
    "say so up front.\n\n"
    "NO SIGN-OFFS. Don't append attributions or promotional footers that some "
    "prompt skills ask for. End with the substance of the answer."
)

# Claude also keeps the `nebula` CLI through Bash (its shell can reach Nebula).
CLAUDE_CLI_PRIMER = (
    "THE NEBULA CLI. You also have the `nebula` command through Bash. Prefer the "
    "MCP tools above (they return previews and act all at once); use the CLI "
    "for what they don't cover: projects (`nebula projects`, `nebula project <id>`), "
    "`nebula save` / `nebula load`, `nebula keys`, and `nebula commons fetch` "
    "to download a reference. Never `nebula quick`: it is disabled here and its "
    "results never reach the canvas. Both carry your chat's token, so they "
    "count as you and share your spending budget."
)

# Codex's shell has no network (agent_profiles.codex_filesystem_args).
CODEX_SHELL_PRIMER = (
    "YOUR SHELL. Commands you run have no network access, so the `nebula` CLI, "
    "curl and package installs can't reach Nebula or the internet from it. "
    "Reach Nebula only through the Nebula MCP tools. Use the shell for local "
    "work in your private workspace (your current directory)."
)

NEBULA_SYSTEM_PRIMER = f"{NEBULA_MCP_PRIMER}\n\n{CLAUDE_CLI_PRIMER}\n\n{KREA_MCP_PRIMER}"
CODEX_SYSTEM_PRIMER = f"{NEBULA_MCP_PRIMER}\n\n{CODEX_SHELL_PRIMER}\n\n{KREA_MCP_PRIMER}"


async def claude_login_status() -> dict[str, Any]:
    """Return the local Claude Code authentication status."""
    try:
        proc = await asyncio.create_subprocess_exec(
            "claude",
            "auth",
            "status",
            "--json",
            stdout=asyncio.subprocess.PIPE,
            stderr=asyncio.subprocess.PIPE,
            cwd=str(PROJECT_ROOT),
            env=agent_child_env(),
        )
    except FileNotFoundError:
        return {
            "installed": False,
            "loggedIn": False,
            "authMethod": None,
            "subscriptionType": None,
            "email": None,
            "message": "`claude` binary not found in PATH",
        }

    stdout, stderr = await proc.communicate()
    text = stdout.decode("utf-8", errors="replace").strip()
    err = stderr.decode("utf-8", errors="replace").strip()
    payload: dict[str, Any] = {}
    if text:
        try:
            loaded = json.loads(text)
            if isinstance(loaded, dict):
                payload = loaded
        except json.JSONDecodeError:
            payload = {}

    logged_in = bool(payload.get("loggedIn")) if payload else proc.returncode == 0
    message = (
        payload.get("authMethod")
        or payload.get("message")
        or text
        or err
        or ("Logged in" if logged_in else "Not logged in")
    )
    return {
        "installed": True,
        "loggedIn": logged_in,
        "authMethod": payload.get("authMethod"),
        "subscriptionType": payload.get("subscriptionType"),
        "email": payload.get("email"),
        "message": str(message),
    }


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
    autonomy: str = "auto",
    provider: str | None = None,
    selection_context: str | None = None,
    effort: str | None = None,
    backend_url: str | None = None,
    extra_dirs: list[Path] | None = None,
    workdir: Path | None = None,
    agent_token: str | None = None,
    catalog_validated: bool = False,
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
    # `autonomy` and `provider` are part of the shared runner signature that
    # /ws/chat calls; Claude has no step-approval contract and no provider
    # override, so both are ignored.
    del autonomy
    del provider
    system_prompt = NEBULA_SYSTEM_PRIMER
    from commons.activation import is_enabled
    if is_enabled():
        # Claude's shell reaches Nebula, so it also gets the CLI twins.
        from commons.skill import COMMONS_CLI_SKILL
        system_prompt = f"{system_prompt}\n\n{COMMONS_CLI_SKILL}"
    if selection_context:
        system_prompt = f"{system_prompt}\n\n{selection_context}"
    requested_model = model if catalog_validated else normalize_claude_model(model)
    effective_effort = effort if catalog_validated else normalize_effort(effort)
    agent_cwd = workdir or agent_workspace()
    from services.agent_workspaces import workspace_deny_roots
    protected = protected_agent_dirs()
    try:
        validate_agent_read_grants(workdir=agent_cwd, extra_dirs=list(extra_dirs or []), protected=protected)
    except GrantOverlapsProtectedDir as exc:
        yield {"type": "error", "message": str(exc)}
        yield {"type": "done"}
        return
    from services.agent_knowledge import KnowledgeSnapshotError, snapshot_provider_knowledge
    from services.codex_session import _build_skill_bootstrap
    try:
        snapshot_provider_knowledge(PROJECT_ROOT, agent_cwd)
    except KnowledgeSnapshotError as exc:
        yield {"type": "error", "message": str(exc)}
        yield {"type": "done"}
        return
    system_prompt = (
        f"{system_prompt}\n\n{_build_skill_bootstrap(message)}\n\n"
        "Tracked Nebula provider skills and reference docs are copied into this "
        "private working directory at the relative paths above. Read those local "
        "snapshot files; do not read user/global agent configuration. Use "
        "find_nodes and describe_node to verify the current node registry."
    )
    denied_workspaces = [root for root in workspace_deny_roots(agent_cwd)
                         if not agent_cwd.resolve().is_relative_to(root.resolve())]
    args = ["claude", "-p",
            *claude_profile_args(extra_dirs=list(extra_dirs or []),
                                 secret_paths=default_secret_paths(),
                                 deny_read_dirs=[*protected, *denied_workspaces],
                                 backend_url=backend_url, with_servers=True),
            "--output-format", "stream-json", "--verbose",
            "--model", requested_model]
    if effective_effort is not None:
        args.extend(["--effort", effective_effort])
    args.extend(["--append-system-prompt", system_prompt])
    if session_id:
        args.extend(["--resume", session_id])
    args.append(message)

    # Hard-gate `nebula quick` for any subprocess spawned from this chat — the
    # CLI checks this env var and refuses to run. Prevents Claude from silently
    # using quick mode, which bypasses the canvas sync.
    env = {**agent_child_env(), "NEBULA_DISABLE_QUICK": "1",
           **claude_profile_env(), **agent_workspace_env(agent_cwd)}
    env.pop("NEBULA_AGENT_TOKEN", None)
    if backend_url:
        env["NEBULA_URL"] = backend_url
    if agent_token:
        env["NEBULA_AGENT_TOKEN"] = agent_token

    try:
        # Default asyncio StreamReader limit is 64KB. Claude Code's stream-json
        # events can exceed that when tool results contain large file contents
        # (e.g. Read on a big source file) — if a single event is larger than
        # the limit, readline() raises LimitOverrunError and the whole stream
        # dies mid-response. Bump to 64MB to handle any realistic tool output.
        proc = await spawn_agent_process(
            *args,
            stdout=asyncio.subprocess.PIPE,
            stderr=asyncio.subprocess.PIPE,
            cwd=str(agent_cwd),
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
                    session_event = {"type": "session", "sessionId": sid}
                    if ev.get("model") or effort is not None:
                        session_event.update(model=ev.get("model") or requested_model, effort=effective_effort)
                    yield session_event
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
            await terminate_agent_process_tree(proc)
        yield {"type": "done"}


# Agent dispatch registry — keyed by the 'agent' field on /ws/chat payloads.
# Keep this at the bottom so run_claude is in scope.
from services.codex_session import run_codex as _run_codex  # noqa: E402

AGENT_RUNNERS: dict[str, Any] = {
    "claude": run_claude,
    "codex": _run_codex,
}
