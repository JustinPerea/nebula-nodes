"""The person's own agents (Claude, Codex, Gemini, Hermes, custom), run over ACP.

A personal agent is the person's own CLI agent (their login, their settings,
hooks, MCP servers and memory), started by Nebula as an ACP subprocess and
shown in the chat panel. See docs/PERSONAL-AGENTS.md.

Only the person edits this registry (main.py's routes use require_person),
and Nebula refuses to start any of them until the person has acknowledged
the one-time warning (``warning_acknowledged``).

Presets are owned by this file. The person can switch one on or off and
rename or recolor it, but not change its command or args, so the adapter
version pins below can't drift. Pins follow the 14-day package rule; they
were checked on registry.npmjs.org on 2026-10-13 (cutoff 2026-09-29):

- @agentclientprotocol/claude-agent-acp 0.84.0, published 2026-09-28
- @agentclientprotocol/codex-acp 2.0.0, published 2026-09-28

``NPX_ENV`` also sets ``npm_config_before`` to 14 days ago, which holds
everything npx installs for them (``@openai/codex``, say) to the same rule.
Gemini and Hermes are binaries the person installed themselves.
"""
from __future__ import annotations

import json
import os
import re
import tempfile
import threading
from dataclasses import asdict, dataclass, field
from datetime import datetime, timedelta, timezone
from pathlib import Path
from typing import Any

from services import agent_binaries
from services.agent_presence import clean_agent_name

FILE_NAME = "personal-agents.json"
MAX_AGENTS = 20
MAX_ARGS = 32
MAX_ARG_CHARS = 512
PACKAGE_AGE_DAYS = 14
NPX_STARTUP_TIMEOUT_S = 180.0
STARTUP_TIMEOUT_S = 60.0
ID_RE = re.compile(r"^[a-z0-9-]{1,32}$")
COLOR_RE = re.compile(r"^#[0-9A-Fa-f]{6}$")
STATUSES = ("ready", "not_installed", "needs_node", "needs_setup", "disabled")

_lock = threading.Lock()


class PersonalAgentError(ValueError):
    def __init__(self, code: str, message: str) -> None:
        super().__init__(message)
        self.code = code
        self.message = message


@dataclass(frozen=True)
class Preset:
    id: str
    display_name: str
    color: str
    command: str
    args: tuple[str, ...]
    env: tuple[tuple[str, str], ...] = ()
    note: str = ""
    min_node: int | None = None
    startable: bool = True
    setup_note: str = ""
    npx: bool = False


PRESETS: dict[str, Preset] = {
    "claude": Preset(
        "claude", "Claude (your setup)", "#D97757", "npx",
        ("-y", "@agentclientprotocol/claude-agent-acp@0.84.0"),
        note="Loads your ~/.claude settings, hooks and MCP servers.", min_node=22, npx=True),
    "codex": Preset(
        "codex", "Codex (your setup)", "#10A37F", "npx",
        ("-y", "@agentclientprotocol/codex-acp@2.0.0"), env=(("NO_BROWSER", "1"),),
        note="Uses your Codex login and ~/.codex config.", npx=True),
    "gemini": Preset(
        "gemini", "Gemini (your setup)", "#4285F4", "gemini", ("--acp",),
        note="Uses the gemini CLI you installed and its login."),
    "hermes": Preset(
        "hermes", "Hermes", "#A78BFA", "hermes", ("acp",), env=(("HERMES_ACP_SKIP_CONFIGURED_MCP", "1"),),
        startable=False, setup_note="Hermes needs a Nebula profile before it can start here. Not set up yet."),
}


@dataclass
class LaunchSpec:
    argv: list[str]
    env: dict[str, str]
    display_name: str
    color: str
    startup_timeout: float
    agent_id: str


@dataclass
class AgentView:
    id: str
    kind: str
    displayName: str
    color: str
    enabled: bool
    command: str
    args: list[str]
    status: str
    resolvedPath: str | None = None
    note: str = ""
    startable: bool = True
    extra: dict[str, Any] = field(default_factory=dict)

    def as_dict(self) -> dict[str, Any]:
        data = asdict(self)
        data.pop("extra")
        return data


def npx_env(now: datetime | None = None) -> dict[str, str]:
    """npm settings for every npx launch: nothing newer than 14 days, no noise."""
    now = now or datetime.now(timezone.utc)
    before = (now - timedelta(days=PACKAGE_AGE_DAYS)).strftime("%Y-%m-%dT%H:%M:%SZ")
    return {"npm_config_before": before, "npm_config_update_notifier": "false",
            "npm_config_fund": "false", "npm_config_audit": "false"}


def _path(state_dir: Path) -> Path:
    return Path(state_dir) / FILE_NAME


def _empty() -> dict[str, Any]:
    return {"version": 1, "warningAcknowledgedAt": None, "agents": []}


def _load(state_dir: Path) -> dict[str, Any]:
    path = _path(state_dir)
    try:
        data = json.loads(path.read_text(encoding="utf-8"))
    except (OSError, ValueError):
        return _empty()
    if not isinstance(data, dict) or not isinstance(data.get("agents"), list):
        return _empty()
    acknowledged = data.get("warningAcknowledgedAt")
    agents = []
    for row in data["agents"][:MAX_AGENTS + len(PRESETS)]:
        try:
            agents.append(_validate_row(row, existing_custom=True))
        except PersonalAgentError:
            continue
    return {"version": 1, "warningAcknowledgedAt": acknowledged if isinstance(acknowledged, str) else None,
            "agents": agents}


def _save(state_dir: Path, data: dict[str, Any]) -> None:
    path = _path(state_dir)
    path.parent.mkdir(parents=True, exist_ok=True)
    fd, tmp = tempfile.mkstemp(prefix=".personal-agents-", dir=str(path.parent))
    try:
        os.fchmod(fd, 0o600)
        with os.fdopen(fd, "w", encoding="utf-8") as handle:
            json.dump(data, handle, indent=2)
        os.replace(tmp, path)
        os.chmod(path, 0o600)
    except BaseException:
        try:
            os.unlink(tmp)
        except OSError:
            pass
        raise


def _clean_name(value: Any) -> str:
    if not isinstance(value, str):
        raise PersonalAgentError("invalid", "displayName must be text")
    name = clean_agent_name(value)
    if not name:
        raise PersonalAgentError("invalid", "displayName needs letters or numbers")
    return name


def _clean_color(value: Any) -> str:
    if not isinstance(value, str) or not COLOR_RE.fullmatch(value):
        raise PersonalAgentError("invalid", "color must look like #RRGGBB")
    return value


def _clean_command(value: Any) -> str:
    if not isinstance(value, str) or not value or len(value) > MAX_ARG_CHARS or "\x00" in value:
        raise PersonalAgentError("invalid", "command must be an absolute path or a bare command name")
    if not (Path(value).is_absolute() or re.fullmatch(r"[A-Za-z0-9._+-]{1,128}", value)):
        raise PersonalAgentError("invalid", "command must be an absolute path or a bare command name")
    return value


def _clean_args(value: Any) -> list[str]:
    if value is None:
        return []
    if not isinstance(value, list) or len(value) > MAX_ARGS:
        raise PersonalAgentError("invalid", f"args must be a list of at most {MAX_ARGS} strings")
    for arg in value:
        if not isinstance(arg, str) or len(arg) > MAX_ARG_CHARS or "\x00" in arg:
            raise PersonalAgentError("invalid", f"each arg must be text of at most {MAX_ARG_CHARS} characters")
    return list(value)


def _validate_row(row: Any, *, existing_custom: bool = False) -> dict[str, Any]:
    if not isinstance(row, dict):
        raise PersonalAgentError("invalid", "agent must be an object")
    agent_id = row.get("id")
    if not isinstance(agent_id, str) or not ID_RE.fullmatch(agent_id):
        raise PersonalAgentError("invalid", "id must be 1-32 lowercase letters, digits or dashes")
    clean: dict[str, Any] = {"id": agent_id, "enabled": bool(row.get("enabled", False))}
    if row.get("displayName") is not None:
        clean["displayName"] = _clean_name(row["displayName"])
    if row.get("color") is not None:
        clean["color"] = _clean_color(row["color"])
    if agent_id in PRESETS:
        return clean
    clean["displayName"] = clean.get("displayName") or _clean_name(agent_id)
    clean["color"] = clean.get("color") or "#7AD3FF"
    clean["command"] = _clean_command(row.get("command"))
    clean["args"] = _clean_args(row.get("args"))
    return clean


def warning_acknowledged(state_dir: Path) -> bool:
    return _load(state_dir)["warningAcknowledgedAt"] is not None


def acknowledge_warning(state_dir: Path) -> str:
    with _lock:
        data = _load(state_dir)
        if data["warningAcknowledgedAt"] is None:
            data["warningAcknowledgedAt"] = datetime.now(timezone.utc).isoformat()
            _save(state_dir, data)
        return data["warningAcknowledgedAt"]


def _row(data: dict[str, Any], agent_id: str) -> dict[str, Any] | None:
    return next((row for row in data["agents"] if row["id"] == agent_id), None)


def _preset_status(preset: Preset, enabled: bool, home: Path | None) -> tuple[str, Path | None, str]:
    resolved = agent_binaries.resolve(preset.command, home=home)
    if not preset.startable:
        return "needs_setup", resolved, preset.setup_note
    if resolved is None:
        what = "npx (Node.js)" if preset.npx else f"`{preset.command}`"
        return "not_installed", None, f"Install {what} first; Nebula doesn't install it."
    if preset.min_node is not None:
        major = agent_binaries.node_major(str(resolved))
        if major is None or major < preset.min_node:
            return "needs_node", resolved, f"Needs Node.js {preset.min_node} or newer next to npx."
    if not enabled:
        return "disabled", resolved, preset.note
    return "ready", resolved, preset.note


def _view(agent_id: str, row: dict[str, Any] | None, home: Path | None) -> AgentView:
    preset = PRESETS.get(agent_id)
    if preset is not None:
        enabled = bool(row and row.get("enabled"))
        status, resolved, note = _preset_status(preset, enabled, home)
        return AgentView(
            id=agent_id, kind="preset", displayName=(row or {}).get("displayName") or preset.display_name,
            color=(row or {}).get("color") or preset.color, enabled=enabled, command=preset.command,
            args=list(preset.args), status=status, resolvedPath=str(resolved) if resolved else None,
            note=note, startable=preset.startable)
    assert row is not None
    resolved = agent_binaries.resolve(row["command"], home=home)
    status = "not_installed" if resolved is None else "ready" if row.get("enabled") else "disabled"
    return AgentView(
        id=agent_id, kind="custom", displayName=row["displayName"], color=row["color"],
        enabled=bool(row.get("enabled")), command=row["command"], args=list(row["args"]), status=status,
        resolvedPath=str(resolved) if resolved else None,
        note="" if resolved else "Command not found.")


def list_agents(state_dir: Path, home: Path | None = None) -> list[AgentView]:
    data = _load(state_dir)
    views = [_view(agent_id, _row(data, agent_id), home) for agent_id in PRESETS]
    views += [_view(row["id"], row, home) for row in data["agents"] if row["id"] not in PRESETS]
    return views


def get_agent(state_dir: Path, agent_id: str, home: Path | None = None) -> AgentView | None:
    if not isinstance(agent_id, str) or not ID_RE.fullmatch(agent_id):
        return None
    data = _load(state_dir)
    row = _row(data, agent_id)
    if agent_id not in PRESETS and row is None:
        return None
    return _view(agent_id, row, home)


def create_custom(state_dir: Path, body: Any, home: Path | None = None) -> AgentView:
    if not isinstance(body, dict):
        raise PersonalAgentError("invalid", "Send an agent object")
    allowed = {"id", "displayName", "color", "enabled", "command", "args"}
    if set(body) - allowed:
        raise PersonalAgentError("invalid", f"Unknown fields: {sorted(set(body) - allowed)}")
    if body.get("id") in PRESETS:
        raise PersonalAgentError("conflict", "That id belongs to a built-in agent")
    row = _validate_row({**body, "enabled": body.get("enabled", True)})
    with _lock:
        data = _load(state_dir)
        if _row(data, row["id"]) is not None:
            raise PersonalAgentError("conflict", "An agent with that id already exists")
        if sum(1 for r in data["agents"] if r["id"] not in PRESETS) >= MAX_AGENTS:
            raise PersonalAgentError("invalid", f"At most {MAX_AGENTS} custom agents")
        data["agents"].append(row)
        _save(state_dir, data)
    return _view(row["id"], row, home)


def update_agent(state_dir: Path, agent_id: str, body: Any, home: Path | None = None) -> AgentView:
    if not isinstance(body, dict) or not body:
        raise PersonalAgentError("invalid", "Send the fields to change")
    preset = agent_id in PRESETS
    allowed = {"displayName", "color", "enabled"} | (set() if preset else {"command", "args"})
    if set(body) - allowed:
        raise PersonalAgentError(
            "invalid", "Built-in agents only change enabled, displayName and color" if preset
            else f"Unknown fields: {sorted(set(body) - allowed)}")
    if "enabled" in body and not isinstance(body["enabled"], bool):
        raise PersonalAgentError("invalid", "enabled must be true or false")
    with _lock:
        data = _load(state_dir)
        row = _row(data, agent_id)
        if row is None:
            if not preset:
                raise PersonalAgentError("not_found", "No agent with that id")
            row = {"id": agent_id, "enabled": False}
            data["agents"].append(row)
        merged = _validate_row({**row, **body})
        row.clear()
        row.update(merged)
        _save(state_dir, data)
    return _view(agent_id, row, home)


def delete_custom(state_dir: Path, agent_id: str) -> bool:
    if agent_id in PRESETS:
        raise PersonalAgentError("invalid", "Built-in agents can be switched off, not deleted")
    with _lock:
        data = _load(state_dir)
        before = len(data["agents"])
        data["agents"] = [row for row in data["agents"] if row["id"] != agent_id]
        if len(data["agents"]) == before:
            return False
        _save(state_dir, data)
    return True


def launch_spec(state_dir: Path, agent_id: str, home: Path | None = None) -> LaunchSpec:
    """How to start ``agent_id``: absolute argv, extra env and timeouts."""
    view = get_agent(state_dir, agent_id, home)
    if view is None:
        raise PersonalAgentError("personal_agent_unknown", "No personal agent with that id")
    if view.status != "ready":
        messages = {
            "disabled": f"{view.displayName} is switched off in Settings > Personal agents.",
            "not_installed": f"{view.displayName} isn't installed. {view.note}".strip(),
            "needs_node": f"{view.displayName}: {view.note}",
            "needs_setup": f"{view.displayName}: {view.note}",
        }
        raise PersonalAgentError(f"personal_agent_{view.status}", messages.get(view.status, "Not startable"))
    assert view.resolvedPath is not None
    env: dict[str, str] = {}
    preset = PRESETS.get(agent_id)
    timeout = STARTUP_TIMEOUT_S
    if preset is not None:
        env.update(dict(preset.env))
        if preset.npx:
            env.update(npx_env())
            timeout = NPX_STARTUP_TIMEOUT_S
        if agent_id == "codex":
            codex = agent_binaries.resolve("codex", home=home)
            if codex is not None:
                env["CODEX_PATH"] = str(codex)
    return LaunchSpec(argv=[view.resolvedPath, *view.args], env=env, display_name=view.displayName,
                      color=view.color, startup_timeout=timeout, agent_id=agent_id)


def launch_key(state_dir: Path, agent_id: str) -> tuple | None:
    """What a running session of ``agent_id`` was allowed to start as, read from
    the registry alone (no binary probes, so it is cheap on every send).

    None when the agent is switched off or gone. A live session whose key no
    longer matches (switched off, removed, or a custom agent's command or args
    changed) must stop: acp_session.AcpSessionManager.close_stale."""
    if not isinstance(agent_id, str) or not ID_RE.fullmatch(agent_id):
        return None
    data = _load(state_dir)
    row = _row(data, agent_id)
    if row is None or not row.get("enabled"):
        return None
    if agent_id in PRESETS:
        preset = PRESETS[agent_id]
        return ("preset", agent_id, preset.command, tuple(preset.args))
    return ("custom", agent_id, row.get("command"), tuple(row.get("args") or ()))


def known_names(state_dir: Path) -> list[tuple[str, str]]:
    """(id, display name) for every preset and custom agent, without probing binaries."""
    data = _load(state_dir)
    names = []
    for agent_id, preset in PRESETS.items():
        row = _row(data, agent_id) or {}
        names.append((agent_id, row.get("displayName") or preset.display_name))
    names += [(row["id"], row["displayName"]) for row in data["agents"] if row["id"] not in PRESETS]
    return names
