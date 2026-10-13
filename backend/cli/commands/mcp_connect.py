"""`nebula mcp connect <client>` / `nebula mcp disconnect <client>`.

The CLI can't make the token. Making one is the person's alone
(POST /api/agent/spend/apps needs this launch's person token, which only the
canvas holds, and the CLI is also what agents run), so the person makes it in
Settings > Connect your agent and the CLI takes it from $NEBULA_APP_TOKEN or a
hidden prompt. The CLI then checks it with Nebula, and:

- Claude Code, Codex: runs the client's own `mcp add` / `mcp remove`.
- Claude Desktop, Cursor: merges one `nebula` entry into the JSON config after
  showing the change, keeping a timestamped backup; other entries are never
  touched; files are written 0600.
- Hermes, OpenClaw, other: prints the config and where it goes (Hermes keeps
  comments in its YAML, which a rewrite would lose; OpenClaw's own command
  needs its Gateway stopped).

`--print` only prints. An in-app agent (NEBULA_AGENT_TOKEN set) is refused:
wiring other apps to Nebula is the person's call.
"""
from __future__ import annotations

import difflib
import getpass
import json
import os
import shutil
import subprocess
import sys
import time
from pathlib import Path
from typing import Any, Callable

import httpx

from services import agent_connect
from services.agent_connect import SERVER_NAME


def config_path(client_id: str, home: Path | None = None) -> Path:
    """The JSON file Nebula merges into, under $HOME (a temp HOME in tests)."""
    home = home if home is not None else Path(os.path.expanduser("~"))
    if client_id == "cursor":
        return home / ".cursor" / "mcp.json"
    if client_id == "claude-desktop":
        if sys.platform == "darwin":
            return home / "Library" / "Application Support" / "Claude" / "claude_desktop_config.json"
        if sys.platform.startswith("win"):
            return Path(os.environ.get("APPDATA") or home / "AppData" / "Roaming") / "Claude" / "claude_desktop_config.json"
        return home / ".config" / "Claude" / "claude_desktop_config.json"
    raise ValueError(f"{client_id} has no JSON config Nebula edits")


class MergeError(RuntimeError):
    pass


def _load(path: Path) -> dict[str, Any]:
    if not path.exists():
        return {}
    try:
        data = json.loads(path.read_text(encoding="utf-8") or "{}")
    except ValueError as exc:
        raise MergeError(f"{path} isn't valid JSON ({exc}); fix it by hand, Nebula won't overwrite it.") from exc
    if not isinstance(data, dict):
        raise MergeError(f"{path} doesn't hold a JSON object; Nebula won't overwrite it.")
    servers = data.get("mcpServers")
    if servers is not None and not isinstance(servers, dict):
        raise MergeError(f"mcpServers in {path} isn't an object; Nebula won't overwrite it.")
    return data


def merged(data: dict[str, Any], entry: dict[str, Any] | None) -> dict[str, Any]:
    """`data` with mcpServers.nebula set to `entry` (None removes it). Nothing else changes."""
    out = dict(data)
    servers = dict(out.get("mcpServers") or {})
    if entry is None:
        servers.pop(SERVER_NAME, None)
    else:
        servers[SERVER_NAME] = entry
    out["mcpServers"] = servers
    return out


def _mask(text: str, token: str | None) -> str:
    if token and len(token) > 16:
        return text.replace(token, token[:15] + "…" + token[-4:])
    return text


def diff(path: Path, before: dict[str, Any], after: dict[str, Any], token: str | None) -> str:
    old = json.dumps(before, indent=2).splitlines() if before else []
    new = json.dumps(after, indent=2).splitlines()
    lines = difflib.unified_diff(old, new, fromfile=str(path), tofile=str(path), lineterm="")
    return _mask("\n".join(lines), token)


def write_private(path: Path, data: dict[str, Any]) -> Path | None:
    """Back up `path` (timestamped, 0600) and write `data` there with mode 0600.
    Returns the backup's path, or None when there was no file."""
    path.parent.mkdir(parents=True, exist_ok=True)
    backup = None
    if path.exists():
        stamp = time.strftime("%Y%m%d-%H%M%S")
        backup = path.with_name(f"{path.name}.nebula-backup-{stamp}")
        n = 1
        while backup.exists():
            backup = path.with_name(f"{path.name}.nebula-backup-{stamp}-{n}")
            n += 1
        fd = os.open(backup, os.O_WRONLY | os.O_CREAT | os.O_EXCL, 0o600)
        with os.fdopen(fd, "wb") as handle:
            handle.write(path.read_bytes())
    tmp = path.with_name(f".{path.name}.nebula-tmp")
    fd = os.open(tmp, os.O_WRONLY | os.O_CREAT | os.O_TRUNC, 0o600)
    with os.fdopen(fd, "w", encoding="utf-8") as handle:
        json.dump(data, handle, indent=2)
        handle.write("\n")
    os.chmod(tmp, 0o600)
    os.replace(tmp, path)
    return backup


def _confirm(question: str, yes: bool, ask: Callable[[str], str]) -> bool:
    if yes:
        return True
    if not sys.stdin.isatty():
        print("error: not a terminal; rerun with --yes to apply", file=sys.stderr)
        return False
    return ask(f"{question} [y/N] ").strip().lower() in ("y", "yes")


def _token(print_only: bool) -> str | None:
    token = os.environ.get("NEBULA_APP_TOKEN", "").strip()
    if token:
        return token
    if print_only:
        return None
    if not sys.stdin.isatty():
        line = sys.stdin.readline().strip()
        return line or None
    return getpass.getpass("Token from Settings > Connect your agent (hidden): ").strip() or None


def check_token(url: str, token: str) -> dict[str, Any] | None:
    """The app this token belongs to, per Nebula; None if Nebula can't be reached.
    Raises SystemExit if Nebula refuses it."""
    try:
        response = httpx.get(f"{url.rstrip('/')}/api/agent/spend",
                             headers={"Authorization": f"Agent {token}"}, timeout=5.0)
    except httpx.HTTPError:
        return None
    if response.status_code == 401:
        print("error: Nebula doesn't recognize this token (revoked, or from another Nebula). "
              "Make a new one in Settings > Connect your agent.", file=sys.stderr)
        sys.exit(1)
    try:
        payload = response.json()
    except ValueError:
        return None
    if response.status_code != 200 or not isinstance(payload, dict):
        return None
    if payload.get("budget") != "app":
        print("error: that isn't an app token from Settings > Connect your agent.", file=sys.stderr)
        sys.exit(1)
    return payload


def _limit(payload: dict[str, Any] | None) -> float | None:
    limits = (payload or {}).get("limits") or {}
    value = limits.get("appDailyUsd")
    return float(value) if isinstance(value, (int, float)) else None


def _print_setup(setup: dict[str, Any]) -> None:
    print(f"# {setup['label']}: {setup['where']}")
    print(setup["snippet"].rstrip("\n"))
    if setup.get("alternative"):
        alt = setup["alternative"]
        print(f"\n# Or: {alt['where']}")
        print(alt["snippet"].rstrip("\n"))
    print()
    for step in setup["steps"]:
        print(f"- {step}")
    for warning in setup["warnings"]:
        print(f"! {warning}")


def _bundle_refusal(paths_error: Exception) -> int:
    print(f"error: {paths_error}", file=sys.stderr)
    return 1


def run_connect(args: Any, *, home: Path | None = None, ask: Callable[[str], str] = input,
                runner: Callable[..., subprocess.CompletedProcess] = subprocess.run,
                backend_dir: Path | None = None) -> int:
    if os.environ.get("NEBULA_AGENT_TOKEN"):
        print("error: an in-app agent can't connect other apps to Nebula; the person runs this.", file=sys.stderr)
        return 1
    try:
        client = agent_connect.client(args.client)
        paths = agent_connect.checkout_paths(backend_dir)
    except agent_connect.ConnectError as exc:
        return _bundle_refusal(exc)

    print_only = bool(args.print_only)
    token = _token(print_only)
    if token is None and not print_only:
        print("error: no token. Make one in Settings > Connect your agent "
              f"(pick {client.label}{', name it ' + args.name if args.name else ''}"
              f"{', daily limit $' + format(args.daily_usd, 'g') if args.daily_usd else ''}), then run this again and "
              "paste it, or set NEBULA_APP_TOKEN. The CLI can't make tokens: only the Nebula canvas you opened "
              "from the launch link can.", file=sys.stderr)
        return 1

    status = check_token(args.url, token) if token else None
    if token and status is None:
        print(f"warning: couldn't reach Nebula at {args.url} to check the token; continuing.", file=sys.stderr)
    app_name = (status or {}).get("agent") or args.name or client.label
    if status and args.name and args.name != app_name:
        print(f"note: this token belongs to {app_name!r}, not {args.name!r}; the canvas will show {app_name!r}.",
              file=sys.stderr)
    daily = _limit(status) if status else args.daily_usd

    setup = agent_connect.render(client.id, paths=paths, url=args.url, token=token or agent_connect.TOKEN_PLACEHOLDER,
                                 app_name=app_name, daily_usd=daily)
    if print_only or client.kind == "manual":
        if not token:
            print("# No token given: replace nebula_app_PASTE_YOUR_TOKEN with the one Settings > Connect your agent "
                  "shows you. The CLI can't make tokens.\n")
        _print_setup(setup)
        return 0

    for warning in setup["warnings"]:
        print(f"! {warning}")
    entry = agent_connect.server_entry(paths, args.url, token)
    if client.kind == "command":
        argv = (agent_connect.claude_code_add_argv(entry) if client.id == "claude-code"
                else agent_connect.codex_add_argv(entry))
        if shutil.which(argv[0]) is None:
            print(f"error: `{argv[0]}` isn't on PATH. Run this yourself once it is:", file=sys.stderr)
            print(setup["snippet"])
            return 1
        print(f"Running: {_mask(setup['snippet'], token)}")
        if not _confirm(f"Add Nebula to {client.label}?", args.yes, ask):
            return 1
        done = runner(argv, capture_output=True, text=True)
        if done.returncode != 0:
            print(_mask((done.stderr or done.stdout or "").strip(), token), file=sys.stderr)
            print(f"error: {argv[0]} refused. If a server named nebula already exists, run "
                  f"`nebula mcp disconnect {client.id}` first.", file=sys.stderr)
            return 1
        print(f"Connected {app_name} in {client.label}.")
        for step in setup["steps"][1:]:
            print(f"- {step}")
        return 0

    path = config_path(client.id, home)
    try:
        before = _load(path)
    except MergeError as exc:
        print(f"error: {exc}", file=sys.stderr)
        return 1
    after = merged(before, agent_connect.json_entry(client.id, entry))
    if after == before:
        print(f"{client.label} already has this nebula entry in {path}.")
        return 0
    existing = (before.get("mcpServers") or {}).get(SERVER_NAME)
    if existing is not None:
        print(f"note: {path} already has a server named nebula; this replaces only that entry.")
    print(diff(path, before, after, token))
    if not _confirm(f"Write {path}?", args.yes, ask):
        return 1
    backup = write_private(path, after)
    print(f"Wrote {path} (mode 600)." + (f" Backup: {backup}" if backup else ""))
    for step in setup["steps"][2:] if client.id == "claude-desktop" else setup["steps"][1:]:
        print(f"- {step}")
    return 0


def run_disconnect(args: Any, *, home: Path | None = None, ask: Callable[[str], str] = input,
                   runner: Callable[..., subprocess.CompletedProcess] = subprocess.run) -> int:
    if os.environ.get("NEBULA_AGENT_TOKEN"):
        print("error: an in-app agent can't disconnect other apps from Nebula; the person runs this.", file=sys.stderr)
        return 1
    try:
        client = agent_connect.client(args.client)
    except agent_connect.ConnectError as exc:
        print(f"error: {exc}", file=sys.stderr)
        return 1
    revoke = "Then revoke its token in Settings > Connect your agent, so a copy left anywhere stops working."
    if client.kind == "json":
        path = config_path(client.id, home)
        try:
            before = _load(path)
        except MergeError as exc:
            print(f"error: {exc}", file=sys.stderr)
            return 1
        if SERVER_NAME not in (before.get("mcpServers") or {}):
            print(f"{path} has no nebula entry; nothing to remove.")
            print(revoke)
            return 0
        after = merged(before, None)
        print(diff(path, before, after, None))
        if not _confirm(f"Write {path}?", args.yes, ask):
            return 1
        backup = write_private(path, after)
        print(f"Removed nebula from {path}." + (f" Backup: {backup}" if backup else ""))
        print(revoke)
        return 0
    argv = agent_connect.remove_argv(client.id)
    if client.kind == "command" and argv and shutil.which(argv[0]):
        if not _confirm(f"Run `{' '.join(argv)}`?", args.yes, ask):
            return 1
        done = runner(argv, capture_output=True, text=True)
        if done.returncode != 0:
            print((done.stderr or done.stdout or "").strip(), file=sys.stderr)
            return 1
        print(f"Removed nebula from {client.label}.")
        print(revoke)
        return 0
    if argv:
        print(f"Run: {' '.join(argv)}" + (" (with the OpenClaw Gateway stopped)" if client.id == "openclaw" else ""))
    else:
        print(f"Remove the nebula server from {client.stored_in}.")
    if client.id == "hermes":
        print("Or delete the nebula entry under mcp_servers in ~/.hermes/config.yaml, then /reload-mcp.")
    print(revoke)
    return 0
