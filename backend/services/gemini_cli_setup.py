"""What Nebula checks about the person's own Gemini CLI before it starts it over ACP.

The "Gemini (your setup)" preset runs the ``gemini`` the person installed.
Two things changed under it, so Nebula looks before it starts it:

- **The ACP flag.** Gemini CLI started ACP with ``--experimental-acp``; newer
  releases take ``--acp`` and mark the old flag deprecated
  (packages/cli/src/config/config.ts in google-gemini/gemini-cli, v0.64.0).
  Nebula reads ``gemini --help`` once per binary and uses the flag it lists,
  ``--acp`` first.
- **Which logins Google still serves.** Since 2026-06-18 Gemini CLI serves
  requests only with a paid Gemini API key (or a Gemini Enterprise Agent
  Platform key) or a Gemini Code Assist Standard or Enterprise license. A
  Google account login on the free tier or on Google AI Pro or Ultra no longer
  works (Google Developers Blog, "An important update: transitioning Gemini
  CLI to Antigravity CLI", 2026-05-19, read 2026-10-20).

So the preset reads the CLI's own settings (``~/.gemini/settings.json``, and
the system settings file that overrides it) to see which login it uses, and
says what's missing before anything starts. Nebula reads only the names in
``.env`` files, never their values, and never changes the person's Gemini
files.

**Nebula's own Gemini API key, by choice.** The person can turn on "Use my
Gemini API key from Nebula" for this agent. Then, and only then, Nebula
starts the CLI with ``GEMINI_API_KEY`` set to the key saved in Settings > API
keys (``GOOGLE_API_KEY``), and points ``GEMINI_CLI_SYSTEM_SETTINGS_PATH`` at
a file of Nebula's that selects API-key login for that process. That file is
the CLI's real system settings (if any) plus ``security.auth.selectedType =
gemini-api-key``; system settings outrank user settings, so the person's own
``~/.gemini/settings.json`` and cached Google login stay as they are. Nebula
can't ask the CLI to switch over ACP instead: its ``authenticate`` deletes the
cached Google credentials and rewrites the user's settings file
(acpRpcDispatcher.ts ``authenticate``, v0.64.0; zedIntegration.js in 0.25.2).
"""
from __future__ import annotations

import json
import logging
import os
import re
import signal
import subprocess
import sys
import threading
import time
from dataclasses import dataclass
from pathlib import Path
from typing import Any, Mapping

from services.child_env import scrubbed_env

logger = logging.getLogger(__name__)

PROBE_TIMEOUT_S = 30.0
ACP_FLAGS = ("--acp", "--experimental-acp")
SERVICE_CHANGE_DATE = "2026-06-18"
OVERLAY_FILE = "gemini-cli-system-settings.json"

AUTH_GOOGLE = "oauth-personal"
AUTH_API_KEY = "gemini-api-key"
AUTH_VERTEX = "vertex-ai"
AUTH_ADC = "compute-default-credentials"
AUTH_CLOUD_SHELL = "cloud-shell"
AUTH_GATEWAY = "gateway"

_VERSION_RE = re.compile(r"\b(\d+\.\d+\.\d+(?:-[0-9A-Za-z.]+)?)\b")
_ENV_NAME_RE = re.compile(r"^\s*(?:export\s+)?([A-Za-z_][A-Za-z0-9_]*)\s*=\s*(\S?)")

KEY_BILLING = ("Nebula gives the CLI your Gemini API key from Settings > API keys (Google). Google bills that key "
               "for every turn this agent runs, at Gemini API prices. Off until you turn it on.")


@dataclass(frozen=True)
class CliInfo:
    version: str | None
    acp_flag: str | None
    ran: bool
    timed_out: bool = False
    # Another look at the same binary is still running (probe answers at once).
    checking: bool = False


@dataclass(frozen=True)
class Readiness:
    ready: bool
    note: str
    acp_flag: str | None
    version: str | None
    auth: str | None
    # Why the "use my Nebula key" choice can't work here, or None when it can.
    key_blocked: str | None = None


def _run_both(binary: Path, *calls: tuple[str, ...]) -> tuple[list[str | None], bool]:
    """Each call's output (None when it failed), all started at once and
    given PROBE_TIMEOUT_S between them, and whether any ran out of time.
    A cold ``node`` start on a busy machine takes seconds, and Settings waits
    for this the first time it opens."""
    procs: list[subprocess.Popen | None] = []
    for args in calls:
        try:
            procs.append(subprocess.Popen([str(binary), *args], stdout=subprocess.PIPE, stderr=subprocess.PIPE,
                                          stdin=subprocess.DEVNULL, text=True, env=scrubbed_env(),
                                          start_new_session=os.name == "posix"))
        except OSError as exc:
            logger.warning("gemini %s didn't start: %s", " ".join(args), type(exc).__name__)
            procs.append(None)
    deadline = time.monotonic() + PROBE_TIMEOUT_S
    outputs: list[str | None] = []
    timed_out = False
    for args, proc in zip(calls, procs):
        if proc is None:
            outputs.append(None)
            continue
        try:
            stdout, stderr = proc.communicate(timeout=max(0.0, deadline - time.monotonic()))
        except subprocess.TimeoutExpired:
            _kill(proc)
            proc.communicate()
            logger.warning("gemini %s took longer than %ss", " ".join(args), PROBE_TIMEOUT_S)
            timed_out = True
            outputs.append(None)
            continue
        if proc.returncode != 0:
            logger.warning("gemini %s exited %s", " ".join(args), proc.returncode)
            outputs.append(None)
            continue
        outputs.append((stdout or "") + (stderr or ""))
    return outputs, timed_out


def _kill(proc: subprocess.Popen) -> None:
    """The CLI and anything it started (it can relaunch itself in a child node)."""
    try:
        if os.name == "posix":
            os.killpg(proc.pid, signal.SIGKILL)
        else:
            proc.kill()
    except OSError:
        pass


_probes: dict[tuple, CliInfo] = {}
_probing: set[tuple] = set()
_probe_lock = threading.Lock()


def _probe_now(binary: Path) -> CliInfo:
    """Both answers, or a CliInfo with ``ran`` False when either one failed."""
    (version_out, help_out), timed_out = _run_both(binary, ("--version",), ("--help",))
    if version_out is None or help_out is None:
        return CliInfo(None, None, False, timed_out)
    match = _VERSION_RE.search(version_out)
    flags = set(re.findall(r"(?<![\w-])(--[a-z][a-z-]*)", help_out))
    flag = next((candidate for candidate in ACP_FLAGS if candidate in flags), None)
    return CliInfo(match.group(1) if match else None, flag, True)


def probe(binary: Path) -> CliInfo:
    """The CLI's version and the ACP flag its ``--help`` lists. Kept per binary
    until the file it resolves to changes (an upgrade); a probe that failed is
    never kept, so the next look tries again. One probe per binary at a time:
    Settings lists the agents every second while a download runs, and a slow
    probe (up to PROBE_TIMEOUT_S) must not start again on each of those looks,
    so a look while one runs answers at once with ``checking``."""
    try:
        real = Path(binary).resolve()
        info = real.stat()
    except OSError:
        return CliInfo(None, None, False)
    key = (str(real), info.st_mtime_ns, info.st_size, info.st_ino)
    with _probe_lock:
        cached = _probes.get(key)
        if cached is not None:
            return cached
        if key in _probing:
            return CliInfo(None, None, False, checking=True)
        _probing.add(key)
    try:
        result = _probe_now(real)
    finally:
        with _probe_lock:
            _probing.discard(key)
    if not result.ran:
        return result
    with _probe_lock:
        if len(_probes) >= 8:
            _probes.clear()
        _probes[key] = result
    return result


def clear_probe_cache() -> None:
    with _probe_lock:
        _probes.clear()


def strip_json_comments(text: str) -> str:
    """JSON with ``//`` and ``/* */`` comments (the CLI accepts them) as plain JSON."""
    out: list[str] = []
    index, length = 0, len(text)
    in_string = False
    while index < length:
        char = text[index]
        if in_string:
            out.append(char)
            if char == "\\" and index + 1 < length:
                out.append(text[index + 1])
                index += 2
                continue
            if char == '"':
                in_string = False
            index += 1
            continue
        if char == '"':
            in_string = True
            out.append(char)
            index += 1
        elif text.startswith("//", index):
            end = text.find("\n", index)
            index = length if end == -1 else end
        elif text.startswith("/*", index):
            end = text.find("*/", index + 2)
            index = length if end == -1 else end + 2
        else:
            out.append(char)
            index += 1
    return "".join(out)


def read_settings(path: Path) -> dict[str, Any] | None:
    """A Gemini CLI settings file, or None when it's missing or unreadable."""
    try:
        raw = Path(path).read_text(encoding="utf-8")
    except (OSError, UnicodeDecodeError):
        return None
    try:
        data = json.loads(strip_json_comments(raw))
    except ValueError:
        return None
    return data if isinstance(data, dict) else None


def system_settings_path(environ: Mapping[str, str] | None = None) -> Path:
    """Where the CLI reads its system settings (settings.ts getSystemSettingsPath)."""
    environ = os.environ if environ is None else environ
    override = environ.get("GEMINI_CLI_SYSTEM_SETTINGS_PATH")
    if override:
        return Path(override)
    if sys.platform == "darwin":
        return Path("/Library/Application Support/GeminiCli/settings.json")
    if sys.platform == "win32":
        return Path("C:/ProgramData/gemini-cli/settings.json")
    return Path("/etc/gemini-cli/settings.json")


def system_defaults_path(environ: Mapping[str, str] | None = None) -> Path:
    """Where the CLI reads its system defaults (settings.ts getSystemDefaultsPath):
    next to the system settings file unless overridden. A key-on launch names it
    explicitly, since the overlay moves the system settings file elsewhere."""
    environ = os.environ if environ is None else environ
    override = environ.get("GEMINI_CLI_SYSTEM_DEFAULTS_PATH")
    if override:
        return Path(override)
    return system_settings_path(environ).parent / "system-defaults.json"


def _auth_block(settings: dict[str, Any] | None) -> dict[str, Any]:
    security = (settings or {}).get("security")
    auth = security.get("auth") if isinstance(security, dict) else None
    return auth if isinstance(auth, dict) else {}


def _text(value: Any) -> str | None:
    return value if isinstance(value, str) and value else None


def selected_auth(home: Path, environ: Mapping[str, str] | None = None) -> tuple[str | None, str | None]:
    """(selectedType, enforcedType) as the CLI merges them: system over user.
    ``selectedAuthType`` at the top level is the pre-0.2 spelling."""
    user = read_settings(Path(home) / ".gemini" / "settings.json") or {}
    system = read_settings(system_settings_path(environ)) or {}
    selected = (_text(_auth_block(system).get("selectedType")) or _text(_auth_block(user).get("selectedType"))
                or _text(user.get("selectedAuthType")))
    enforced = _text(_auth_block(system).get("enforcedType")) or _text(_auth_block(user).get("enforcedType"))
    return selected, enforced


def folder_trust_enabled(home: Path, environ: Mapping[str, str] | None = None) -> bool:
    """With folder trust on, the CLI skips .env files in a folder it doesn't
    trust, and Nebula's private workspace is one (settings.ts loadEnvironment)."""
    for settings in (read_settings(system_settings_path(environ)), read_settings(Path(home) / ".gemini" / "settings.json")):
        security = (settings or {}).get("security")
        trust = security.get("folderTrust") if isinstance(security, dict) else None
        if isinstance(trust, dict) and isinstance(trust.get("enabled"), bool):
            return trust["enabled"]
    return False


def env_file(home: Path, start: Path | None) -> Path | None:
    """The one .env file the CLI loads, found the way settings.ts findEnvFile
    does: from its working directory up, ``.gemini/.env`` before ``.env``,
    then the same two under home."""
    current = Path(start).resolve() if start is not None else None
    while current is not None:
        for candidate in (current / ".gemini" / ".env", current / ".env"):
            if candidate.is_file():
                return candidate
        if current.parent == current:
            break
        current = current.parent
    for candidate in (Path(home) / ".gemini" / ".env", Path(home) / ".env"):
        if candidate.is_file():
            return candidate
    return None


def env_file_names(path: Path | None) -> set[str]:
    """The names a .env file sets to something non-empty. Values are never kept."""
    if path is None:
        return set()
    names: set[str] = set()
    try:
        with open(path, encoding="utf-8", errors="replace") as handle:
            for line in handle:
                match = _ENV_NAME_RE.match(line)
                if match and match.group(2) and match.group(2) not in {"#"}:
                    names.add(match.group(1))
    except OSError:
        return set()
    return names


def _defined(name: str, environ: Mapping[str, str], file_names: set[str]) -> bool:
    return bool(environ.get(name)) or name in file_names


def readiness(binary: Path, home: Path, *, use_nebula_key: bool, nebula_key_saved: bool,
              start_dir: Path | None = None, environ: Mapping[str, str] | None = None,
              dropped_env: frozenset[str] = frozenset()) -> Readiness:
    """Whether this Gemini CLI can work as an ACP agent here, and what to say.

    ``environ`` is what the agent will inherit, before Nebula drops
    ``dropped_env`` from it (the provider keys it never passes on)."""
    environ = dict(os.environ if environ is None else environ)
    for name in dropped_env:
        environ.pop(name, None)
    info = probe(binary)
    if info.checking:
        return Readiness(False, "Nebula is still checking your Gemini CLI (`gemini --version` and `--help`), which "
                         "can take a while on its first start. Open Settings again in a moment.", None, None, None)
    if not info.ran and info.timed_out:
        return Readiness(False, f"Gemini CLI took too long to answer (over {PROBE_TIMEOUT_S:g} seconds), which can "
                         "happen on its first start or on a busy machine. Open Settings again to check again.",
                         None, None, None)
    if not info.ran:
        return Readiness(False, "Nebula couldn't run `gemini --version` and `gemini --help`. Check the CLI works in a "
                         "terminal, then open Settings again.",
                         None, None, None)
    version = info.version or "unknown version"
    if info.acp_flag is None:
        return Readiness(False, f"Gemini CLI {version} has no ACP mode (`--acp`). Update it, then check again.",
                         None, info.version, None)
    selected, enforced = selected_auth(home, environ)
    key_blocked = None
    if enforced and enforced != AUTH_API_KEY:
        key_blocked = (f"Your Gemini CLI settings require the `{enforced}` login, so Nebula can't give it an API key.")
    flag_note = f"Gemini CLI {version}, started with `{info.acp_flag}`."
    if use_nebula_key:
        if key_blocked:
            return Readiness(False, key_blocked, info.acp_flag, info.version, selected, key_blocked)
        if not nebula_key_saved:
            return Readiness(False, "Save a Gemini API key in Settings > API keys (Google) first, or turn off "
                             "\"Use my Gemini API key from Nebula\".", info.acp_flag, info.version, selected)
        return Readiness(True, f"{flag_note} Uses your Gemini API key from Nebula; Google bills that key.",
                         info.acp_flag, info.version, AUTH_API_KEY)
    if enforced and selected and enforced != selected:
        return Readiness(False, f"Your Gemini CLI settings require the `{enforced}` login but select `{selected}`. "
                         "Fix that in a terminal (`gemini`, then /auth).", info.acp_flag, info.version, selected,
                         key_blocked)
    names = set() if folder_trust_enabled(home, environ) else env_file_names(env_file(home, start_dir))
    switch = ("Turn on \"Use my Gemini API key from Nebula\" below (Google bills that key), or switch the CLI to a "
              "Gemini API key: run `gemini` in a terminal, then /auth.")
    if selected is None:
        return Readiness(False, f"{flag_note} It isn't signed in yet. {switch}", info.acp_flag, info.version, None,
                         key_blocked)
    if selected == AUTH_GOOGLE:
        if _defined("GOOGLE_CLOUD_PROJECT", environ, names) or _defined("GOOGLE_CLOUD_PROJECT_ID", environ, names):
            return Readiness(True, f"{flag_note} Signs in with your Google account on your Google Cloud project; "
                             "Google serves that only with a Gemini Code Assist Standard or Enterprise license.",
                             info.acp_flag, info.version, selected, key_blocked)
        return Readiness(False, f"{flag_note} It signs in with a Google account. Since {SERVICE_CHANGE_DATE} Google "
                         "serves Gemini CLI only with a paid Gemini API key or a Gemini Code Assist Standard or "
                         "Enterprise license; a free or Google AI Pro/Ultra login no longer works. " + switch,
                         info.acp_flag, info.version, selected, key_blocked)
    if selected == AUTH_API_KEY:
        if _defined("GEMINI_API_KEY", environ, names):
            return Readiness(True, f"{flag_note} Uses the Gemini API key in your Gemini CLI setup; Google bills it.",
                             info.acp_flag, info.version, selected, key_blocked)
        return Readiness(False, f"{flag_note} It's set to a Gemini API key, but none reaches it from Nebula: put "
                         "GEMINI_API_KEY in ~/.gemini/.env, or turn on \"Use my Gemini API key from Nebula\" below. "
                         "Nebula doesn't pass on a key your shell exported.",
                         info.acp_flag, info.version, selected, key_blocked)
    if selected == AUTH_VERTEX:
        return Readiness(True, f"{flag_note} Uses Vertex AI, billed to your Google Cloud project.",
                         info.acp_flag, info.version, selected, key_blocked)
    if selected in {AUTH_ADC, AUTH_CLOUD_SHELL}:
        return Readiness(True, f"{flag_note} Uses your Google Cloud credentials.", info.acp_flag, info.version,
                         selected, key_blocked)
    if selected == AUTH_GATEWAY:
        return Readiness(True, f"{flag_note} Uses your AI API gateway.", info.acp_flag, info.version, selected,
                         key_blocked)
    return Readiness(True, f"{flag_note} Login: `{selected}`.", info.acp_flag, info.version, selected, key_blocked)


def write_key_overlay(state_dir: Path, environ: Mapping[str, str] | None = None) -> Path:
    """Nebula's system settings file for a key-on launch: the CLI's real system
    settings, if any, with API-key login selected. No secret goes in it."""
    base = read_settings(system_settings_path(environ)) or {}
    merged = json.loads(json.dumps(base))
    security = merged.get("security") if isinstance(merged.get("security"), dict) else {}
    auth = security.get("auth") if isinstance(security.get("auth"), dict) else {}
    auth["selectedType"] = AUTH_API_KEY
    security["auth"] = auth
    merged["security"] = security
    folder = Path(state_dir) / "personal-agents"
    folder.mkdir(parents=True, exist_ok=True)
    os.chmod(folder, 0o700)
    path = folder / OVERLAY_FILE
    tmp = folder / f".{OVERLAY_FILE}.tmp"
    fd = os.open(tmp, os.O_WRONLY | os.O_CREAT | os.O_TRUNC | getattr(os, "O_NOFOLLOW", 0), 0o600)
    with os.fdopen(fd, "w", encoding="utf-8") as handle:
        json.dump(merged, handle, indent=2)
    os.replace(tmp, path)
    return path
