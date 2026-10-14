"""`nebula mcp connect <client>` / `nebula mcp disconnect <client>`.

The CLI can't make the token. Making one is the person's alone
(POST /api/agent/spend/apps needs this launch's person token, which only the
canvas holds, and the CLI is also what agents run), so the person makes it in
Settings > Connect your agent. Nebula writes it to a private file
(services/app_token_file.py) and Settings shows this command with
`--token-file <that file>` (or $NEBULA_APP_TOKEN_FILE). The CLI reads the file
with the MCP server's own strict reader, checks the token with Nebula, and
writes a config that names the file, never the token:

- Claude Code, Codex: runs the client's own `mcp add` / `mcp remove`. Only the
  file's path is on argv.
- Claude Desktop, Cursor: merges one `nebula` entry into the JSON config after
  showing the change, keeping a timestamped backup; other entries are never
  touched; files are written 0600.
- Hermes, OpenClaw, other: prints the config and where it goes (Hermes keeps
  comments in its YAML, which a rewrite would lose; OpenClaw's own command
  needs its Gateway stopped).

A token made before token files exist has no file (Nebula keeps only its
hash). It still works the old way, from $NEBULA_APP_TOKEN or `--paste-token`
(a hidden prompt): the config then holds the token itself, and for Codex a
one-off placeholder goes on argv and is swapped for the token in config.toml.
Revoking it and connecting again moves the app to a token file.

`--print` only prints. An in-app agent (NEBULA_AGENT_TOKEN set) is refused:
wiring other apps to Nebula is the person's call.
"""
from __future__ import annotations

import difflib
import getpass
import json
import os
import secrets
import shutil
import subprocess
import sys
import time
import tomllib
from pathlib import Path
from typing import Any, Callable

import httpx

from services import agent_connect, agent_token_file, app_tokens
from services.agent_connect import SERVER_NAME, TOKEN_ENV, TOKEN_FILE_ENV


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


REDACTED = "nebula_app_REDACTED_BY_NEBULA_MCP"


def write_private(path: Path, data: dict[str, Any], redact: str | None = None) -> Path | None:
    """Back up `path` (timestamped, 0600) and write `data` there with mode 0600.
    Returns the backup's path, or None when there was no file.

    `redact` is the Nebula token the old file held (a disconnect, or a connect
    that replaces the nebula entry): the backup gets a placeholder in its
    place, so no working token is left behind in a file nobody cleans up."""
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
        old = path.read_bytes()
        if redact:
            old = old.replace(redact.encode("utf-8"), REDACTED.encode("utf-8"))
        with os.fdopen(fd, "wb") as handle:
            handle.write(old)
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


class TokenSourceError(RuntimeError):
    pass


def _token_file(args: Any) -> str | None:
    value = getattr(args, "token_file", None) or os.environ.get(TOKEN_FILE_ENV, "").strip()
    return os.path.abspath(os.path.expanduser(value)) if value else None


def _token(args: Any) -> tuple[str | None, str | None]:
    """(token, token file). With a token file (--token-file or
    $NEBULA_APP_TOKEN_FILE), the token is read from it, strictly; the config
    will name the file. Otherwise the older ways, for tokens made before
    token files: $NEBULA_APP_TOKEN, or --paste-token's hidden prompt."""
    path = _token_file(args)
    if path is not None:
        try:
            token = agent_token_file.read(path)
        except agent_token_file.TokenFileError as exc:
            raise TokenSourceError(f"{path}: {exc}. Use the path Settings > Connect your agent shows.") from exc
        if not token.startswith(app_tokens.TOKEN_PREFIX):
            raise TokenSourceError(f"{path} doesn't hold an app token from Settings > Connect your agent.")
        return token, path
    token = os.environ.get(TOKEN_ENV, "").strip()
    if token:
        return token, None
    if args.print_only or not getattr(args, "paste_token", False):
        return None, None
    if not sys.stdin.isatty():
        line = sys.stdin.readline().strip()
        return line or None, None
    return getpass.getpass("Token from Settings > Connect your agent (hidden): ").strip() or None, None


def check_token(url: str, token: str) -> dict[str, Any] | None:
    """The app this token belongs to, per Nebula; None only when nothing
    answers at `url` (connection refused or timed out). Anything else that
    isn't Nebula accepting an app token exits 1: a 404 or an HTML page means
    some other server holds that port, and it must not get a config."""
    try:
        response = httpx.get(f"{url.rstrip('/')}/api/agent/spend",
                             headers={"Authorization": f"Agent {token}"}, timeout=5.0, trust_env=False)
    except (httpx.ConnectError, httpx.TimeoutException):
        return None
    except httpx.HTTPError as exc:
        print(f"error: couldn't talk to {url} ({type(exc).__name__}). Pass Nebula's address with --url.",
              file=sys.stderr)
        sys.exit(1)
    if response.status_code == 401:
        print("error: Nebula doesn't recognize this token (revoked, or from another Nebula). "
              "Make a new one in Settings > Connect your agent.", file=sys.stderr)
        sys.exit(1)
    try:
        payload = response.json()
    except ValueError:
        payload = None
    if response.status_code != 200 or not isinstance(payload, dict) or "budget" not in payload:
        print(f"error: {url} answered (HTTP {response.status_code}) but isn't a Nebula backend that knows this "
              "token. Pass Nebula's address with --url (or NEBULA_URL_FILE for the desktop app).", file=sys.stderr)
        sys.exit(1)
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


def codex_config_path(home: Path | None = None) -> Path:
    if os.environ.get("CODEX_HOME"):
        return Path(os.environ["CODEX_HOME"]) / "config.toml"
    home = home if home is not None else Path(os.path.expanduser("~"))
    return home / ".codex" / "config.toml"


def _rewrite_keeping_mode(path: Path, text: str) -> None:
    mode = path.stat().st_mode & 0o777
    tmp = path.with_name(f".{path.name}.nebula-tmp")
    fd = os.open(tmp, os.O_WRONLY | os.O_CREAT | os.O_TRUNC, 0o600)
    with os.fdopen(fd, "w", encoding="utf-8") as handle:
        handle.write(text)
    os.chmod(tmp, mode & 0o600 or 0o600)
    os.replace(tmp, path)


def fill_codex_token(path: Path, placeholder: str | None, value: str, key: str = TOKEN_ENV) -> bool:
    """Finish the entry `codex mcp add` just wrote: set tool_timeout_sec
    (which `codex mcp add` can't), and with a ``placeholder`` (a pasted token,
    kept off argv), swap the real token in for it. Checks env[key] is ``value``
    afterwards. Returns whether the timeout was set; raises MergeError if the
    file isn't what `codex mcp add` should have left."""
    token = value
    try:
        text = path.read_text(encoding="utf-8")
    except OSError as exc:
        raise MergeError(f"can't read {path}: {exc}") from exc
    if placeholder is not None:
        if text.count(placeholder) != 1:
            raise MergeError(f"{path} doesn't hold the entry `codex mcp add` just wrote")
        text = text.replace(placeholder, token)

    def nebula_server(candidate: str) -> dict[str, Any] | None:
        try:
            server = tomllib.loads(candidate)["mcp_servers"][SERVER_NAME]
        except (tomllib.TOMLDecodeError, KeyError, TypeError):
            return None
        return server if isinstance(server, dict) else None

    server = nebula_server(text)
    env = (server or {}).get("env")
    if not isinstance(env, dict) or env.get(key) != token:
        raise MergeError(f"{path} didn't parse back with the {'token' if key == TOKEN_ENV else 'token file'} in place")
    timeout_set = False
    header = f"[mcp_servers.{SERVER_NAME}]\n"
    lines = text.splitlines(keepends=True)
    if "tool_timeout_sec" not in server and lines.count(header) == 1:
        lines.insert(lines.index(header) + 1, f"tool_timeout_sec = {agent_connect.CODEX_TOOL_TIMEOUT_SEC}\n")
        candidate = "".join(lines)
        after = nebula_server(candidate)
        if after is not None and after.get("tool_timeout_sec") == agent_connect.CODEX_TOOL_TIMEOUT_SEC \
                and (after.get("env") or {}).get(key) == token:
            text, timeout_set = candidate, True
    _rewrite_keeping_mode(path, text)
    return timeout_set


def _bundle_refusal(paths_error: Exception) -> int:
    print(f"error: {paths_error}", file=sys.stderr)
    return 1


def _entry_token(entry: Any) -> str | None:
    env = entry.get("env") if isinstance(entry, dict) else None
    token = env.get(TOKEN_ENV) if isinstance(env, dict) else None
    return token if isinstance(token, str) and token else None


def _backup_note(backup: Path | None, redacted: str | None) -> str:
    if backup is None:
        return ""
    return f" Backup: {backup}" + (" (the old Nebula token is blanked out in it)." if redacted else "")


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
    try:
        token, token_file = _token(args)
    except TokenSourceError as exc:
        print(f"error: {exc}", file=sys.stderr)
        return 1
    if token is None and not print_only:
        print("error: no token. Make one in Settings > Connect your agent "
              f"(pick {client.label}{', name it ' + args.name if args.name else ''}"
              f"{', daily limit $' + format(args.daily_usd, 'g') if args.daily_usd else ''}), then run the command "
              "it shows, with --token-file and the file Nebula saved the token to. The CLI can't make tokens: only "
              "the Nebula canvas you opened from the launch link can. (A token made before token files: set "
              "NEBULA_APP_TOKEN or pass --paste-token.)", file=sys.stderr)
        return 1

    # args.url is None when the desktop app's backend-url file failed its
    # check (Nebula closed, or something else on its old port): no token goes there.
    where = args.url or f"the address in {os.environ.get('NEBULA_URL_FILE')}"
    status = check_token(args.url, token) if token and args.url else None
    writes = not print_only and client.kind != "manual"
    if token and status is None:
        if writes:
            # A config written blind can point at nothing (the desktop app's
            # port changes every launch) or at another Nebula.
            print(f"error: couldn't reach Nebula at {where} to check the token, so nothing was written. "
                  "Start Nebula, or pass its address with --url (the desktop app: set NEBULA_URL_FILE to the "
                  "file Settings > Connect your agent names). --print shows the config without checking.",
                  file=sys.stderr)
            return 1
        print(f"warning: couldn't reach Nebula at {where} to check the token.", file=sys.stderr)
    app_name = (status or {}).get("agent") or args.name or client.label
    if status and args.name and args.name != app_name:
        print(f"note: this token belongs to {app_name!r}, not {args.name!r}; the canvas will show {app_name!r}.",
              file=sys.stderr)
    daily = _limit(status) if status else args.daily_usd

    # Where the client finds Nebula from now on, as Nebula says: its
    # backend-url file for the desktop app (a new port each launch), else the
    # address the CLI just reached.
    address = (status or {}).get("mcpAddress") or {}
    url_file = address.get("urlFile") if isinstance(address.get("urlFile"), str) else None
    if url_file is None and not status and os.environ.get("NEBULA_URL_FILE") and not os.environ.get("NEBULA_URL"):
        url_file = os.environ["NEBULA_URL_FILE"]
    url = None if url_file else args.url
    # A pasted token has no file: its config holds the token itself.
    legacy = token is not None and token_file is None
    credential = {"token": token} if legacy else {"token_file": token_file or agent_connect.TOKEN_FILE_PLACEHOLDER}
    setup = agent_connect.render(client.id, paths=paths, url=url, url_file=url_file, **credential,
                                 app_name=app_name, daily_usd=daily)
    if legacy:
        print(f"note: this token has no token file, so {client.label}'s config will hold the token itself. Revoke it "
              "in Settings > Connect your agent and connect again to keep it in a token file instead.",
              file=sys.stderr)
    if print_only or client.kind == "manual":
        if not token:
            print(f"# No token file given: replace {agent_connect.TOKEN_FILE_PLACEHOLDER} with the token file "
                  "Settings > Connect your agent shows you. The CLI can't make tokens.\n")
        _print_setup(setup)
        return 0

    # The CLI runs the client's command itself, so nothing lands in shell history.
    for warning in setup["warnings"]:
        if "shell history" not in warning:
            print(f"! {warning}")
    if client.id == "claude-code" and legacy:
        print("! While `claude mcp add` runs (about a second), any program of yours can see the token in the "
              "process list: Claude Code has no other way to take it.")
    entry = agent_connect.server_entry(paths, url, url_file=url_file, **credential)
    if client.kind == "command":
        placeholder = None
        if client.id == "claude-code":
            # With a pasted token, `claude mcp add` has no way to take it
            # except argv (the warning above says so); it's there for about a
            # second. With a token file only its path is.
            argv = agent_connect.claude_code_add_argv(entry)
        elif legacy:
            placeholder = f"nebula_app_PENDING_{secrets.token_hex(16)}"
            argv = agent_connect.codex_add_argv({**entry, "env": {**entry["env"], TOKEN_ENV: placeholder}})
        else:
            argv = agent_connect.codex_add_argv(entry)
        if shutil.which(argv[0]) is None:
            print(f"error: `{argv[0]}` isn't on PATH. Run this yourself once it is:", file=sys.stderr)
            print(setup["snippet"])
            return 1
        # `codex mcp add` silently replaces a server with the same name, so
        # look first: an existing nebula entry is left for the person to remove.
        existing = runner([argv[0], "mcp", "get", SERVER_NAME], capture_output=True, text=True)
        if existing.returncode == 0:
            print(f"error: {client.label} already has a server named nebula. Run `nebula mcp disconnect {client.id}` "
                  "first if you want to replace it.", file=sys.stderr)
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
        steps = setup["steps"][1:]
        if client.id == "codex":
            toml_path = codex_config_path(home)
            try:
                timeout_set = (fill_codex_token(toml_path, placeholder, token) if legacy
                               else fill_codex_token(toml_path, None, token_file, TOKEN_FILE_ENV))
            except MergeError as exc:
                runner(agent_connect.remove_argv(client.id), capture_output=True, text=True)
                print(f"error: {exc}; removed the half-made entry. Paste the config.toml block from "
                      f"`nebula mcp connect codex --print` instead.", file=sys.stderr)
                return 1
            if timeout_set:
                steps = [step for step in steps if "tool_timeout_sec" not in step]
                print(f"Set tool_timeout_sec = {agent_connect.CODEX_TOOL_TIMEOUT_SEC} for nebula in {toml_path}.")
        print(f"Connected {app_name} in {client.label}.")
        for step in steps:
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
    old_token = _entry_token(existing)
    if existing is not None:
        print(f"note: {path} already has a server named nebula; this replaces only that entry.")
    print(_mask(diff(path, before, after, token), old_token))
    if not _confirm(f"Write {path}?", args.yes, ask):
        return 1
    backup = write_private(path, after, redact=old_token)
    print(f"Wrote {path} (mode 600)." + _backup_note(backup, old_token))
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
        old_token = _entry_token(before["mcpServers"][SERVER_NAME])
        print(diff(path, before, after, old_token))
        if not _confirm(f"Write {path}?", args.yes, ask):
            return 1
        backup = write_private(path, after, redact=old_token)
        print(f"Removed nebula from {path}." + _backup_note(backup, old_token))
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
