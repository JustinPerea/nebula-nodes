"""Codex runtime — wraps `codex exec --json` and normalizes JSONL events.

Yields dicts with the same event contract as run_claude/run_hermes:
  - session       — {sessionId}
  - text          — {text}
  - tool_use      — {toolUseId, tool, input}
  - tool_result   — {toolUseId, content, isError}
  - result        — {text, durationMs}
  - error         — {message}
  - done          — {}
"""
from __future__ import annotations

import asyncio
import json
import os
import re
from pathlib import Path
from typing import Any, AsyncIterator


PROJECT_ROOT = Path(__file__).resolve().parent.parent.parent
CODEX_BIN = os.environ.get("NEBULA_CODEX_BIN", "codex")
SKILL_ROOT = PROJECT_ROOT / ".agents" / "skills"
MAX_SKILL_DOC_CHARS = 12000
MAX_SKILL_BOOTSTRAP_CHARS = 28000

SKILL_TRIGGER_KEYWORDS: dict[str, tuple[str, ...]] = {
    "fal": (
        "fal", "fal-ai", "flux", "kling", "sora", "veo", "seedance",
        "wan", "luma", "ltx", "pixverse", "recraft", "hunyuan", "tripo",
        "seedream", "nano-banana",
    ),
    "gemini": ("gemini", "google", "imagen", "nano banana", "nano-banana", "veo"),
    "gpt-image-2": (
        "gpt-image-2", "gpt image 2", "gpt 2 image", "openai image",
        "image 2", "gpt-image",
    ),
    "meshy": ("meshy", "3d", "text-to-3d", "image-to-3d", "rig", "rigging", "remesh"),
    "runway": ("runway", "gen-4", "gen4", "act-two", "aleph"),
}


def _read_text(path: Path, limit: int | None = None) -> str:
    try:
        text = path.read_text(encoding="utf-8")
    except OSError:
        return ""
    if limit is not None and len(text) > limit:
        return text[:limit].rstrip() + "\n\n[truncated]"
    return text


def _parse_frontmatter(text: str) -> dict[str, str]:
    if not text.startswith("---\n"):
        return {}
    _, rest = text.split("---\n", 1)
    frontmatter, _, _ = rest.partition("\n---")
    fields: dict[str, str] = {}
    for line in frontmatter.splitlines():
        if ":" not in line:
            continue
        key, value = line.split(":", 1)
        fields[key.strip()] = value.strip().strip("\"'")
    return fields


def _skill_index() -> list[dict[str, str]]:
    skills: list[dict[str, str]] = []
    if not SKILL_ROOT.exists():
        return skills
    for skill_file in sorted(SKILL_ROOT.glob("*/SKILL.md")):
        text = _read_text(skill_file, MAX_SKILL_DOC_CHARS)
        fields = _parse_frontmatter(text)
        try:
            rel_path = skill_file.relative_to(PROJECT_ROOT)
        except ValueError:
            rel_path = skill_file
        name = fields.get("name") or skill_file.parent.name
        skills.append({
            "name": name,
            "description": fields.get("description", ""),
            "path": str(rel_path),
            "dir": skill_file.parent.name,
        })
    return skills


def _select_skill_names(message: str, skills: list[dict[str, str]]) -> list[str]:
    lower = message.lower()
    selected: list[str] = []

    for skill in skills:
        name = skill["name"]
        haystack = " ".join([
            name.lower(),
            skill["dir"].lower(),
            skill["description"].lower(),
        ])
        score = 0
        if name.lower() in lower or skill["dir"].lower() in lower:
            score += 4
        for keyword in SKILL_TRIGGER_KEYWORDS.get(name, ()):
            if keyword in lower:
                score += 3
        for token in set(re.findall(r"[a-z0-9][a-z0-9_.-]{2,}", lower)):
            if token in haystack:
                score += 1
        if score > 0:
            selected.append(name)

    # Provider meta-skills are cheap and high-value when the user is asking
    # about graph/API capability rather than a specific model.
    if any(term in lower for term in ("skill", "api", "node", "model", "graph")):
        for name in ("gpt-image-2", "fal"):
            if any(skill["name"] == name for skill in skills) and name not in selected:
                selected.append(name)

    return selected[:4]


def _build_skill_bootstrap(message: str) -> str:
    skills = _skill_index()
    if not skills:
        return (
            "Repo-backed Nebula skills: no `.agents/skills/*/SKILL.md` files "
            "were found. Fall back to `docs/model-providers/`, `nebula nodes`, "
            "and live vendor docs for exact model/API details."
        )

    lines = [
        "Repo-backed Nebula skills are available in this checkout. Treat them "
        "as first-class local API knowledge before guessing node IDs, params, "
        "provider routing, or model limitations.",
        "",
        "Available root skills:",
    ]
    for skill in skills:
        desc = f" — {skill['description']}" if skill["description"] else ""
        lines.append(f"- {skill['name']} ({skill['path']}){desc}")

    lines.extend([
        "",
        "Use pattern:",
        "1. Match the user's request to the skill list.",
        "2. Read the relevant `SKILL.md` and linked files before creating or "
        "editing graph nodes.",
        "3. For exact node IDs and current params, verify with `nebula nodes`, "
        "`nebula info <node-id>`, or the tracked docs under `docs/model-providers/`.",
        "4. If a vendor fact may be stale, verify against the canonical vendor "
        "docs before presenting it as current.",
        "",
        "Additional tracked knowledge roots:",
        "- docs/model-providers/openai/gpt-image-2.md",
        "- docs/model-providers/fal/",
        "- docs/model-providers/google/gemini-nano-banana.md",
        "- docs/fal-model-schemas.md",
    ])

    selected = _select_skill_names(message, skills)
    if selected:
        lines.append("")
        lines.append("Preloaded relevant skill docs:")
        used_chars = sum(len(line) + 1 for line in lines)
        by_name = {skill["name"]: skill for skill in skills}
        for name in selected:
            skill = by_name.get(name)
            if not skill:
                continue
            path = PROJECT_ROOT / skill["path"]
            text = _read_text(path, MAX_SKILL_DOC_CHARS)
            if not text:
                continue
            section = f"\n### {skill['path']}\n{text}"
            if used_chars + len(section) > MAX_SKILL_BOOTSTRAP_CHARS:
                break
            lines.append(section)
            used_chars += len(section)

    return "\n".join(lines)


def _build_prompt(message: str) -> str:
    # Import lazily to avoid a module-load cycle: chat_session imports this
    # module when it builds AGENT_RUNNERS.
    from services.chat_session import NEBULA_SYSTEM_PRIMER

    skill_bootstrap = _build_skill_bootstrap(message)
    return (
        f"{NEBULA_SYSTEM_PRIMER}\n\n"
        f"{skill_bootstrap}\n\n"
        "You are the Codex agent selected in Nebula's chat panel. Follow the "
        "Nebula workflow above and keep chat responses concise; the canvas is "
        "the main output surface.\n\n"
        f"User message:\n{message}"
    )


def _codex_base_args(model: str | None) -> list[str]:
    args = [
        CODEX_BIN,
        "exec",
        "--json",
        "--color",
        "never",
        "--sandbox",
        "workspace-write",
        "-c",
        'approval_policy="never"',
        "-c",
        "sandbox_workspace_write.network_access=true",
        "--cd",
        str(PROJECT_ROOT),
    ]
    # The frontend's default model is Claude-specific. Do not forward that to
    # Codex; let the user's Codex config/account pick the active Codex model.
    if model and not model.startswith("claude-"):
        args.extend(["--model", model])
    return args


def _normalize_codex_event(ev: dict[str, Any]) -> list[dict[str, Any]]:
    event_type = ev.get("type")
    normalized: list[dict[str, Any]] = []

    if event_type == "thread.started":
        thread_id = ev.get("thread_id")
        if thread_id:
            normalized.append({"type": "session", "sessionId": str(thread_id)})
        return normalized

    if event_type in {"error", "turn.failed"}:
        message = ev.get("message") or ev.get("error") or ev.get("reason") or "Codex turn failed"
        normalized.append({"type": "error", "message": str(message)})
        return normalized

    if event_type == "item.started":
        item = ev.get("item") if isinstance(ev.get("item"), dict) else {}
        if item.get("type") == "command_execution":
            normalized.append({
                "type": "tool_use",
                "toolUseId": str(item.get("id") or ""),
                "tool": "shell",
                "input": {"command": item.get("command") or ""},
            })
        return normalized

    if event_type == "item.completed":
        item = ev.get("item") if isinstance(ev.get("item"), dict) else {}
        item_type = item.get("type")
        if item_type == "agent_message":
            text = item.get("text")
            if text:
                normalized.append({"type": "text", "text": str(text)})
            return normalized
        if item_type == "command_execution":
            output = item.get("aggregated_output") or ""
            status = item.get("status")
            exit_code = item.get("exit_code")
            normalized.append({
                "type": "tool_result",
                "toolUseId": str(item.get("id") or ""),
                "content": str(output),
                "isError": status not in (None, "completed") or exit_code not in (None, 0),
            })
            return normalized

    if event_type == "turn.completed":
        normalized.append({"type": "result", "text": "", "durationMs": 0})
        return normalized

    return normalized


async def run_codex(
    message: str,
    session_id: str | None,
    model: str = "",
    autonomy: str = "auto",
    provider: str | None = None,
) -> AsyncIterator[dict[str, Any]]:
    """Run one Codex turn and yield normalized chat events."""
    # Accepted for runner signature parity. Codex auth/provider selection lives
    # in the Codex CLI configuration and login state.
    del autonomy
    del provider

    args = _codex_base_args(model)
    if session_id:
        args.extend(["resume", session_id, "-"])
    else:
        args.append("-")

    env = {**os.environ, "NEBULA_DISABLE_QUICK": "1", "NO_COLOR": "1"}
    prompt = _build_prompt(message)

    try:
        proc = await asyncio.create_subprocess_exec(
            *args,
            stdin=asyncio.subprocess.PIPE,
            stdout=asyncio.subprocess.PIPE,
            stderr=asyncio.subprocess.PIPE,
            cwd=str(PROJECT_ROOT),
            env=env,
            limit=64 * 1024 * 1024,
        )
    except FileNotFoundError:
        yield {"type": "error", "message": "`codex` binary not found in PATH"}
        yield {"type": "done"}
        return

    assert proc.stdin is not None
    assert proc.stdout is not None
    assert proc.stderr is not None

    stderr_task = asyncio.create_task(proc.stderr.read())

    try:
        proc.stdin.write(prompt.encode("utf-8"))
        await proc.stdin.drain()
        proc.stdin.close()

        while True:
            line = await proc.stdout.readline()
            if not line:
                break
            line_str = line.decode("utf-8", errors="replace").strip()
            if not line_str or not line_str.startswith("{"):
                continue
            try:
                ev = json.loads(line_str)
            except json.JSONDecodeError:
                continue
            for normalized in _normalize_codex_event(ev):
                yield normalized

        return_code = await proc.wait()
        stderr_text = (await stderr_task).decode("utf-8", errors="replace").strip()
        if return_code != 0:
            yield {
                "type": "error",
                "message": stderr_text or f"codex exited with code {return_code}",
            }
    finally:
        if proc.returncode is None:
            try:
                proc.kill()
                await proc.wait()
            except ProcessLookupError:
                pass
        if not stderr_task.done():
            stderr_task.cancel()
        yield {"type": "done"}


async def codex_login_status() -> dict[str, Any]:
    """Return the local Codex CLI authentication status."""
    try:
        proc = await asyncio.create_subprocess_exec(
            CODEX_BIN,
            "login",
            "status",
            stdout=asyncio.subprocess.PIPE,
            stderr=asyncio.subprocess.PIPE,
            cwd=str(PROJECT_ROOT),
        )
    except FileNotFoundError:
        return {
            "installed": False,
            "loggedIn": False,
            "mode": None,
            "message": "`codex` binary not found in PATH",
        }

    stdout, stderr = await proc.communicate()
    text = stdout.decode("utf-8", errors="replace").strip()
    err = stderr.decode("utf-8", errors="replace").strip()
    logged_in = proc.returncode == 0
    mode: str | None = None
    lower = f"{text}\n{err}".lower()
    if "chatgpt" in lower:
        mode = "chatgpt"
    elif "api" in lower:
        mode = "api"
    elif "access token" in lower:
        mode = "access_token"

    return {
        "installed": True,
        "loggedIn": logged_in,
        "mode": mode,
        "message": text or err or ("Logged in" if logged_in else "Not logged in"),
    }
