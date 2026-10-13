"""Connect your agent: the exact config each client needs to start Nebula's MCP server.

Settings > Connect your agent (POST /api/agent/spend/apps with ``client``) and
``nebula mcp connect`` both render their snippets here, so the two can't
drift. Every client gets the same stdio server: this checkout's
``backend/.venv/bin/python`` running ``backend/mcp_server.py``, with
``NEBULA_APP_TOKEN`` and Nebula's address in its environment: ``NEBULA_URL``
for a dev backend on a fixed port, or ``NEBULA_URL_FILE`` for the desktop app,
whose port changes every launch (services/backend_address.py).

Formats were checked against each client's own docs on 2026-10-13:

- Hermes: ``~/.hermes/config.yaml`` ``mcp_servers`` (command, args, env,
  ``trust: untrusted``), then ``/reload-mcp``. ``hermes mcp add`` has no env
  flag, so it can't carry the token.
- OpenClaw: ``openclaw mcp set <name> '<json>'`` (refuses while the local
  Gateway runs), or Control UI Settings > MCP > Add server > Stdio.
- Claude Desktop: ``claude_desktop_config.json`` ``mcpServers``; quit and
  reopen the app.
- Claude Code: ``claude mcp add --scope user --env K=V --transport stdio
  <name> -- <command> [args]`` (an option must sit between ``--env`` and the
  name).
- Cursor: ``~/.cursor/mcp.json`` ``mcpServers`` with ``type: "stdio"``.
- Codex: ``codex mcp add <name> --env K=V -- <command>``, or
  ``[mcp_servers.<name>]`` in ``~/.codex/config.toml``.

A packaged app (bundled Python) has no checkout to point at; that waits for
the desktop pass, and ``checkout_paths`` says so.
"""
from __future__ import annotations

import json
import shlex
import sys
from dataclasses import dataclass
from pathlib import Path
from typing import Any

SERVER_NAME = "nebula"
TOKEN_PLACEHOLDER = "nebula_app_PASTE_YOUR_TOKEN"
# Same as the in-app Codex registration (services/krea_agent_mcp.py): runs can
# outlast Codex's 60-second default tool timeout.
CODEX_TOOL_TIMEOUT_SEC = 150


@dataclass(frozen=True)
class Client:
    id: str
    label: str
    # command: the client's own CLI adds the server. json: one entry merged
    # into a JSON file. manual: Nebula prints, the person pastes.
    kind: str
    # Where the token ends up, as the person would recognize it.
    stored_in: str


CLIENTS: dict[str, Client] = {
    "hermes": Client("hermes", "Hermes", "manual", "~/.hermes/config.yaml"),
    "openclaw": Client("openclaw", "OpenClaw", "manual", "OpenClaw's config (mcp.servers)"),
    "claude-desktop": Client("claude-desktop", "Claude Desktop", "json",
                             "~/Library/Application Support/Claude/claude_desktop_config.json"),
    "claude-code": Client("claude-code", "Claude Code", "command", "~/.claude.json"),
    "cursor": Client("cursor", "Cursor", "json", "~/.cursor/mcp.json"),
    "codex": Client("codex", "Codex", "command", "~/.codex/config.toml"),
    "other": Client("other", "Other MCP client", "manual", "that app's MCP config"),
}


class ConnectError(ValueError):
    """The setup can't be made here (unknown client, no checkout)."""


def client(client_id: Any) -> Client:
    found = CLIENTS.get(client_id) if isinstance(client_id, str) else None
    if found is None:
        raise ConnectError(f"client must be one of: {', '.join(CLIENTS)}")
    return found


def client_list() -> list[dict[str, str]]:
    return [{"id": c.id, "label": c.label} for c in CLIENTS.values()]


@dataclass(frozen=True)
class CheckoutPaths:
    python: str
    server: str


def _backend_dir() -> Path:
    return Path(__file__).resolve().parent.parent


def checkout_paths(backend_dir: Path | None = None) -> CheckoutPaths:
    """This checkout's venv Python and MCP server. The venv path is kept as
    is, never resolved: its python is a symlink, and resolving it would point
    the client at the base interpreter without the venv's packages."""
    backend = Path(backend_dir) if backend_dir is not None else _backend_dir()
    if ".app/Contents/" in str(backend) or getattr(sys, "frozen", False):
        raise ConnectError(
            "Nebula is running from the packaged app, whose bundled Python isn't set up for outside apps yet. "
            "Connect your agent from a source checkout for now (it's planned for the desktop pass).")
    python = backend / ".venv" / "bin" / "python"
    server = backend / "mcp_server.py"
    if not server.is_file():
        raise ConnectError(f"Nebula's MCP server isn't at {server}.")
    if not python.exists():
        raise ConnectError(f"This checkout has no backend virtualenv at {python}. Create it first (see the README).")
    return CheckoutPaths(python=str(python), server=str(server))


def server_entry(paths: CheckoutPaths, url: str | None, token: str, *, url_file: str | None = None) -> dict[str, Any]:
    """The stdio server every client starts. With ``url_file`` (the desktop
    app, whose port changes every launch; services/backend_address.py) the
    server reads Nebula's address from that file on each call instead of a
    fixed ``NEBULA_URL``."""
    if url_file:
        where = {"NEBULA_URL_FILE": url_file}
    elif url:
        where = {"NEBULA_URL": url.rstrip("/")}
    else:
        raise ConnectError("need Nebula's address (a URL or its backend-url file)")
    return {"command": paths.python, "args": [paths.server], "env": {**where, "NEBULA_APP_TOKEN": token}}


def _json(value: Any) -> str:
    return json.dumps(value, indent=2)


def _q(value: str) -> str:
    # A JSON string is also a valid YAML double-quoted scalar and TOML basic string.
    return json.dumps(value)


def _shell(argv: list[str]) -> str:
    """One command, broken with backslashes so it reads in a narrow panel and
    still runs as one: the program and its subcommand words, then each option
    with its value, then each word after ``--``, and any long word, on its own line."""
    groups: list[list[str]] = []
    after_separator = False
    for part in argv:
        quoted = shlex.quote(part)
        last = groups[-1] if groups else None
        joins = last is not None and not after_separator and not part.startswith("-") and (
            (last[0].startswith("-") and len(last) == 1)  # an option's value, however long
            or ((len(groups) == 1 or last[0].startswith("-")) and len(quoted) <= 60))
        if joins:
            last.append(quoted)
        else:
            groups.append([quoted])
        after_separator = after_separator or part == "--"
    return " \\\n  ".join(" ".join(group) for group in groups)


def json_entry(client_id: str, entry: dict[str, Any]) -> dict[str, Any]:
    """The value stored under mcpServers.nebula for a JSON client."""
    if client_id == "cursor":
        return {"type": "stdio", **entry}
    return dict(entry)


def claude_code_add_argv(entry: dict[str, Any]) -> list[str]:
    argv = ["claude", "mcp", "add", "--scope", "user"]
    for key, value in entry["env"].items():
        argv += ["--env", f"{key}={value}"]
    # --env takes several values, so another option must come before the name.
    return argv + ["--transport", "stdio", SERVER_NAME, "--", entry["command"], *entry["args"]]


def codex_add_argv(entry: dict[str, Any]) -> list[str]:
    argv = ["codex", "mcp", "add", SERVER_NAME]
    for key, value in entry["env"].items():
        argv += ["--env", f"{key}={value}"]
    return argv + ["--", entry["command"], *entry["args"]]


def remove_argv(client_id: str) -> list[str] | None:
    return {
        # No --scope: remove it from whichever scope holds it. An older setup
        # (claude mcp add's default) put nebula in local scope, and `claude mcp
        # get`, which connect checks first, finds it in any scope.
        "claude-code": ["claude", "mcp", "remove", SERVER_NAME],
        "codex": ["codex", "mcp", "remove", SERVER_NAME],
        "hermes": ["hermes", "mcp", "remove", SERVER_NAME],
        "openclaw": ["openclaw", "mcp", "unset", SERVER_NAME],
    }.get(client_id)


def hermes_yaml(entry: dict[str, Any]) -> str:
    env = "\n".join(f"      {key}: {_q(value)}" for key, value in entry["env"].items())
    args = ", ".join(_q(arg) for arg in entry["args"])
    return (f"mcp_servers:\n  {SERVER_NAME}:\n    command: {_q(entry['command'])}\n    args: [{args}]\n"
            f"    env:\n{env}\n    trust: untrusted\n")


def codex_toml(entry: dict[str, Any]) -> str:
    args = ", ".join(_q(arg) for arg in entry["args"])
    env = "\n".join(f"{key} = {_q(value)}" for key, value in entry["env"].items())
    return (f"[mcp_servers.{SERVER_NAME}]\ncommand = {_q(entry['command'])}\nargs = [{args}]\n"
            f"tool_timeout_sec = {CODEX_TOOL_TIMEOUT_SEC}\n\n[mcp_servers.{SERVER_NAME}.env]\n{env}\n")


def _limit_text(daily_usd: float | None) -> str:
    if daily_usd is None:
        return "the shared budget for agents outside Nebula chats"
    amount = f"${daily_usd:.2f}" if daily_usd < 1 else f"${daily_usd:g}"
    return f"its {amount} daily limit (and the shared budget for agents outside Nebula chats)"


def warnings(c: Client, app_name: str, daily_usd: float | None) -> list[str]:
    found = [
        f"{c.label if c.id != 'other' else 'The app'}'s own scheduled jobs, cron tasks and automations can run Nebula "
        f"nodes with this token while you aren't watching, up to {_limit_text(daily_usd)}.",
        f"The token is saved in plain text in {c.stored_in}. Anything that can read that file can spend as "
        f"{app_name} until you revoke it in Settings > Connect your agent.",
    ]
    if c.id in ("claude-code", "codex", "openclaw"):
        found.append("Running the command also leaves the token in your shell history, and while it runs any "
                     "program of yours can see it in the process list.")
    return found


def render(client_id: str, *, paths: CheckoutPaths, url: str | None, token: str, app_name: str,
           daily_usd: float | None = None, url_file: str | None = None) -> dict[str, Any]:
    """What the person pastes or runs for one client: steps, a main snippet,
    an optional alternative, and the warnings to show beside them."""
    c = client(client_id)
    entry = server_entry(paths, url, token, url_file=url_file)
    alternative: dict[str, str] | None = None
    if c.id == "hermes":
        main = {"format": "yaml", "where": "~/.hermes/config.yaml", "snippet": hermes_yaml(entry)}
        steps = ["Add this under mcp_servers in ~/.hermes/config.yaml (keep any servers already there).",
                 "Run /reload-mcp in Hermes, or restart it.",
                 "trust: untrusted makes Hermes ask you before every Nebula tool that changes something."]
    elif c.id == "openclaw":
        main = {"format": "shell", "where": "Terminal, with the OpenClaw Gateway stopped",
                "snippet": _shell(["openclaw", "mcp", "set", SERVER_NAME, json.dumps(entry)])}
        steps = ["Stop the local OpenClaw Gateway first: openclaw mcp set refuses while it runs.",
                 "Run the command, then start the Gateway again.",
                 "Or, with the Gateway running: Control UI > Settings > MCP > Add server, name it nebula, pick "
                 "Stdio and enter the command line from the second block. Then add "
                 f"{' and '.join(entry['env'])} from the command above as environment variables if the form offers them.",
                 "openclaw mcp doctor will flag the token as a literal env value; that is expected."]
        alternative = {"format": "text", "where": "Settings > MCP > Stdio command",
                       "snippet": " ".join(shlex.quote(part) for part in [entry["command"], *entry["args"]])}
    elif c.id == "claude-desktop":
        main = {"format": "json", "where": c.stored_in,
                "snippet": _json({"mcpServers": {SERVER_NAME: json_entry(c.id, entry)}})}
        steps = ["Claude menu > Settings > Developer > Edit Config opens the file.",
                 "Add the nebula entry inside mcpServers, keeping any servers already there.",
                 "Quit Claude Desktop completely and open it again."]
    elif c.id == "cursor":
        main = {"format": "json", "where": c.stored_in,
                "snippet": _json({"mcpServers": {SERVER_NAME: json_entry(c.id, entry)}})}
        steps = ["Add the nebula entry inside mcpServers in ~/.cursor/mcp.json, keeping any servers already there.",
                 "Check it's enabled in Cursor's MCP settings (restart Cursor if it doesn't show up)."]
    elif c.id == "claude-code":
        main = {"format": "shell", "where": "Terminal", "snippet": _shell(claude_code_add_argv(entry))}
        steps = ["Run this once. --scope user makes Nebula available in every project.",
                 "Check with: claude mcp get nebula"]
    elif c.id == "codex":
        main = {"format": "shell", "where": "Terminal", "snippet": _shell(codex_add_argv(entry))}
        steps = ["Run this once, or paste the config.toml block (the second block) instead.",
                 f"Runs can take longer than Codex's 60-second tool timeout: add tool_timeout_sec = "
                 f"{CODEX_TOOL_TIMEOUT_SEC} under [mcp_servers.nebula] in ~/.codex/config.toml."]
        alternative = {"format": "toml", "where": "~/.codex/config.toml", "snippet": codex_toml(entry)}
    else:
        main = {"format": "json", "where": "The app's MCP config",
                "snippet": _json({"mcpServers": {SERVER_NAME: entry}})}
        steps = ["Most MCP clients take this mcpServers shape. Otherwise give the app a stdio server with this "
                 "command, argument and environment."]
    return {"client": c.id, "label": c.label, "kind": c.kind, **main, "steps": steps,
            "alternative": alternative, "warnings": warnings(c, app_name, daily_usd)}
