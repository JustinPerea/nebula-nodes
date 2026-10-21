"""The person's own agents (Claude, Codex, Gemini, Antigravity, Hermes, custom), run over ACP.

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
Gemini and Hermes are binaries the person installed themselves; Nebula checks
the Gemini CLI's ACP flag and login first (services/gemini_cli_setup.py).
Antigravity is Google's ACP server, which Nebula downloads, pinned by version
and SHA-256, into its own data dir (services/antigravity_agent.py).
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

from services import agent_binaries, agent_token_file, antigravity_agent, gemini_cli_setup
from services.agent_presence import clean_agent_name
from services.credential_catalog import CREDENTIAL_PROVIDERS

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

# Environment variables a personal agent never inherits from the backend:
# Nebula's own spending tokens, and every provider key the backend may have
# inherited from the shell that started it. Claude Code bills ANTHROPIC_API_KEY
# ahead of the subscription login, and Codex OPENAI_API_KEY, so a terminal's
# key would silently replace the plan the person set the agent up with.
# GEMINI_API_KEY too: Gemini CLI and Google's Antigravity server would bill a
# shell's key; a key reaches them only when the person turns it on here, or
# from their own ~/.gemini/.env, which the CLI reads itself.
AGENT_ENV_DROP = frozenset({"NEBULA_AGENT_TOKEN", "NEBULA_APP_TOKEN", "NEBULA_APP_TOKEN_FILE", agent_token_file.ENV_VAR,
                            "GEMINI_API_KEY"} | CREDENTIAL_PROVIDERS)

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
    # "command" (found on PATH), "gemini" (checked by gemini_cli_setup) or
    # "download" (Nebula's pinned copy, antigravity_agent).
    kind: str = "command"
    # Settings key the person may choose to hand this agent (off by default).
    key_option: str | None = None
    # ACP auth method Nebula calls before session/new, after an explicit sign-in.
    sign_in: str | None = None
    terms_note: str = ""


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
        note="Uses the gemini CLI you installed and its login.", kind="gemini", key_option="GOOGLE_API_KEY"),
    "antigravity": Preset(
        "antigravity", "Antigravity (your setup)", "#34A853", antigravity_agent.COMMAND, (),
        env=(("BROWSER", antigravity_agent.NO_BROWSER),),
        note="Google's Antigravity ACP server, on your Google AI plan.", kind="download",
        sign_in=antigravity_agent.AUTH_METHOD, terms_note=antigravity_agent.TERMS_NOTE),
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
    # ACP auth method to call before session/new (a sign-in the person did here).
    auth_method: str | None = None
    # Values to mask in anything the agent prints (a key Nebula handed it).
    secrets: tuple[str, ...] = ()

    def __repr__(self) -> str:  # never print a handed-over key
        return f"LaunchSpec(agent_id={self.agent_id!r}, argv={self.argv!r}, env_keys={sorted(self.env)!r})"


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
    version: str | None = None
    # The "hand this agent my key" choice: {enabled, keySaved, billing, blocked}.
    keyOption: dict[str, Any] | None = None
    # A download Nebula manages: {state, version, sizeBytes, message, job?}.
    install: dict[str, Any] | None = None
    # A sign-in run through the agent: {state, message, job?}.
    signIn: dict[str, Any] | None = None
    termsNote: str = ""
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
        preset = PRESETS[agent_id]
        if preset.key_option is not None:
            if "useNebulaKey" in row and not isinstance(row["useNebulaKey"], bool):
                raise PersonalAgentError("invalid", "useNebulaKey must be true or false")
            clean["useNebulaKey"] = bool(row.get("useNebulaKey", False))
        if preset.sign_in is not None:
            clean["signedIn"] = row.get("signedIn") is True
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


def _nebula_key(name: str) -> str | None:
    from services import settings
    try:
        return settings.get_api_key(name)
    except (OSError, ValueError):
        return None


def _not_installed(preset: Preset) -> str:
    what = "npx (Node.js)" if preset.npx else f"`{preset.command}`"
    return f"Install {what} first; Nebula doesn't install it."


def _command_status(preset: Preset, enabled: bool, home: Path | None) -> tuple[str, Path | None, str]:
    resolved = agent_binaries.resolve(preset.command, home=home)
    if not preset.startable:
        return "needs_setup", resolved, preset.setup_note
    if resolved is None:
        return "not_installed", None, _not_installed(preset)
    if preset.min_node is not None:
        major = agent_binaries.node_major(str(resolved))
        if major is None or major < preset.min_node:
            return "needs_node", resolved, f"Needs Node.js {preset.min_node} or newer next to npx."
    if not enabled:
        return "disabled", resolved, preset.note
    return "ready", resolved, preset.note


def _gemini_view(preset: Preset, row: dict[str, Any], enabled: bool, home: Path | None,
                 state_dir: Path) -> dict[str, Any]:
    resolved = agent_binaries.resolve(preset.command, home=home)
    use_key = bool(row.get("useNebulaKey"))
    key_saved = bool(_nebula_key(preset.key_option or ""))
    key_option = {"enabled": use_key, "keySaved": key_saved, "billing": gemini_cli_setup.KEY_BILLING,
                  "blocked": None}
    if resolved is None:
        return {"status": "not_installed", "resolved": None, "note": _not_installed(preset), "args": list(preset.args),
                "version": None, "keyOption": key_option}
    ready = gemini_cli_setup.readiness(resolved, Path(home) if home is not None else Path.home(),
                                       use_nebula_key=use_key, nebula_key_saved=key_saved, start_dir=state_dir,
                                       dropped_env=AGENT_ENV_DROP)
    key_option["blocked"] = ready.key_blocked
    status = "needs_setup" if not ready.ready else "ready" if enabled else "disabled"
    return {"status": status, "resolved": resolved, "note": ready.note,
            "args": [ready.acp_flag] if ready.acp_flag else list(preset.args), "version": ready.version,
            "keyOption": key_option}


def _download_view(preset: Preset, row: dict[str, Any], enabled: bool, state_dir: Path) -> dict[str, Any]:
    state, message = antigravity_agent.install_state(state_dir)
    rel = antigravity_agent.release()
    install: dict[str, Any] = {"state": state, "version": antigravity_agent.VERSION,
                               "sizeBytes": rel.size if rel else None, "message": message,
                               "source": rel.url if rel else None}
    job = antigravity_agent.job(state_dir, "install")
    if job is not None and job.state != "done":
        install["job"] = job.view()
        if job.state == "running":
            install["state"] = "downloading"
    signed_in = bool(row.get("signedIn"))
    sign_in: dict[str, Any] = {"state": "signed_in" if signed_in else "signed_out"}
    sign_job = antigravity_agent.job(state_dir, "sign_in")
    if sign_job is not None and sign_job.state != "done":
        sign_in["job"] = sign_job.view()
        if sign_job.state == "running":
            sign_in["state"] = "waiting"
    resolved = antigravity_agent.installed_command(state_dir)
    if state in {"unsupported", "changed"} or install["state"] == "downloading":
        status, note = ("not_installed" if install["state"] == "downloading" else "needs_setup"), message
    elif state == "missing":
        status, note = "not_installed", message
    elif not signed_in:
        status, note = "needs_setup", "Sign in with Google below. Google's server opens the sign-in page in your browser."
    else:
        status, note = ("ready" if enabled else "disabled"), preset.note
    return {"status": status, "resolved": resolved, "note": note, "args": list(preset.args),
            "version": antigravity_agent.VERSION if resolved else None, "install": install, "signIn": sign_in}


def _view(agent_id: str, row: dict[str, Any] | None, home: Path | None, state_dir: Path | None = None) -> AgentView:
    preset = PRESETS.get(agent_id)
    if preset is not None:
        row = row or {}
        enabled = bool(row.get("enabled"))
        extras: dict[str, Any] = {}
        if preset.kind == "gemini":
            extras = _gemini_view(preset, row, enabled, home, Path(state_dir) if state_dir else Path("."))
        elif preset.kind == "download":
            extras = _download_view(preset, row, enabled, Path(state_dir) if state_dir else Path("."))
        else:
            status, resolved, note = _command_status(preset, enabled, home)
            extras = {"status": status, "resolved": resolved, "note": note, "args": list(preset.args)}
        resolved = extras["resolved"]
        return AgentView(
            id=agent_id, kind="preset", displayName=row.get("displayName") or preset.display_name,
            color=row.get("color") or preset.color, enabled=enabled,
            command=str(resolved) if preset.kind == "download" and resolved else preset.command,
            args=extras["args"], status=extras["status"], resolvedPath=str(resolved) if resolved else None,
            note=extras["note"], startable=preset.startable, version=extras.get("version"),
            keyOption=extras.get("keyOption"), install=extras.get("install"), signIn=extras.get("signIn"),
            termsNote=preset.terms_note)
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
    views = [_view(agent_id, _row(data, agent_id), home, state_dir) for agent_id in PRESETS]
    views += [_view(row["id"], row, home, state_dir) for row in data["agents"] if row["id"] not in PRESETS]
    return views


def get_agent(state_dir: Path, agent_id: str, home: Path | None = None) -> AgentView | None:
    if not isinstance(agent_id, str) or not ID_RE.fullmatch(agent_id):
        return None
    data = _load(state_dir)
    row = _row(data, agent_id)
    if agent_id not in PRESETS and row is None:
        return None
    return _view(agent_id, row, home, state_dir)


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
    return _view(row["id"], row, home, state_dir)


def update_agent(state_dir: Path, agent_id: str, body: Any, home: Path | None = None) -> AgentView:
    if not isinstance(body, dict) or not body:
        raise PersonalAgentError("invalid", "Send the fields to change")
    preset = agent_id in PRESETS
    key_option = preset and PRESETS[agent_id].key_option is not None
    allowed = {"displayName", "color", "enabled"} | (set() if preset else {"command", "args"}) \
        | ({"useNebulaKey"} if key_option else set())
    if set(body) - allowed:
        raise PersonalAgentError(
            "invalid", ("Built-in agents only change enabled, displayName and color"
                        + (", and useNebulaKey" if key_option else "")) if preset
            else f"Unknown fields: {sorted(set(body) - allowed)}")
    if "enabled" in body and not isinstance(body["enabled"], bool):
        raise PersonalAgentError("invalid", "enabled must be true or false")
    if "useNebulaKey" in body and not isinstance(body["useNebulaKey"], bool):
        raise PersonalAgentError("invalid", "useNebulaKey must be true or false")
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
    return _view(agent_id, row, home, state_dir)


def set_signed_in(state_dir: Path, agent_id: str, signed_in: bool) -> None:
    """Record that the person finished (or undid) a sign-in run through this
    agent. Only Nebula's sign-in and sign-out flows call this; it holds no
    credential, just whether to call the agent's auth method on start."""
    preset = PRESETS.get(agent_id)
    if preset is None or preset.sign_in is None:
        raise PersonalAgentError("invalid", "That agent has no sign-in")
    with _lock:
        data = _load(state_dir)
        row = _row(data, agent_id)
        if row is None:
            row = {"id": agent_id, "enabled": False}
            data["agents"].append(row)
        if bool(row.get("signedIn")) == signed_in:
            return
        row["signedIn"] = signed_in
        _save(state_dir, data)


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
    secrets: tuple[str, ...] = ()
    auth_method = None
    if preset is not None:
        env.update(dict(preset.env))
        if preset.npx:
            env.update(npx_env())
            timeout = NPX_STARTUP_TIMEOUT_S
        if agent_id == "codex":
            codex = agent_binaries.resolve("codex", home=home)
            if codex is not None:
                env["CODEX_PATH"] = str(codex)
        if preset.key_option is not None and view.keyOption and view.keyOption.get("enabled"):
            # The person turned this on for this agent; readiness checked the key exists.
            key = _nebula_key(preset.key_option)
            if not key:
                raise PersonalAgentError("personal_agent_needs_setup",
                                         f"{view.displayName}: save a Gemini API key in Settings > API keys first.")
            env["GEMINI_API_KEY"] = key
            # Read before the overlay replaces the system settings path: the
            # CLI looks for system-defaults.json next to that file.
            env["GEMINI_CLI_SYSTEM_DEFAULTS_PATH"] = str(gemini_cli_setup.system_defaults_path())
            env["GEMINI_CLI_SYSTEM_SETTINGS_PATH"] = str(gemini_cli_setup.write_key_overlay(state_dir))
            secrets = (key,)
        if preset.sign_in is not None:
            auth_method = preset.sign_in
    return LaunchSpec(argv=[view.resolvedPath, *view.args], env=env, display_name=view.displayName,
                      color=view.color, startup_timeout=timeout, agent_id=agent_id, auth_method=auth_method,
                      secrets=secrets)


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
        key: tuple = ("preset", agent_id, preset.command, tuple(preset.args))
        if preset.key_option is not None:
            key += (("useNebulaKey", bool(row.get("useNebulaKey"))),)
        if preset.sign_in is not None:
            key += (("signedIn", bool(row.get("signedIn"))),)
        if preset.kind == "download":
            # Removing or replacing the download stops its sessions too.
            marker = antigravity_agent.version_dir(state_dir) / antigravity_agent.MARKER
            key += (("download", antigravity_agent.VERSION, marker.exists()),)
        return key
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
