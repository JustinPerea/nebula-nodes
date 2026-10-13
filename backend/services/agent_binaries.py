"""Find a person's agent binaries (npx, gemini, hermes) as absolute paths.

A backend launched from the Dock (the desktop app) gets launchd's PATH,
which misses Homebrew, nvm, volta and ~/.local/bin. Nebula never runs a
shell to find a command: it checks a fixed list of the usual directories,
and only if those miss does it ask the person's login shell for its PATH
once (no ``-i``, a short timeout, a scrubbed environment).
"""
from __future__ import annotations

import os
import re
import subprocess
from functools import lru_cache
from pathlib import Path

from services.child_env import scrubbed_env

LOGIN_SHELL_TIMEOUT_S = 3.0
_FIXED_DIRS = (
    ".local/bin", "/opt/homebrew/bin", "/usr/local/bin", ".npm-global/bin", ".volta/bin",
    ".bun/bin", ".cargo/bin", ".asdf/shims",
)
_VERSION_RE = re.compile(r"v?(\d+)\.(\d+)\.(\d+)")


def _version_key(path: Path) -> tuple[int, int, int]:
    match = _VERSION_RE.search(path.name)
    return tuple(int(part) for part in match.groups()) if match else (0, 0, 0)  # type: ignore[return-value]


def candidate_dirs(home: Path | None = None, path_env: str | None = None) -> list[Path]:
    """Where to look, in order: $PATH, the usual install dirs, then nvm/fnm."""
    home = Path(home) if home is not None else Path.home()
    raw_path = os.environ.get("PATH", "") if path_env is None else path_env
    dirs: list[Path] = [Path(entry) for entry in raw_path.split(os.pathsep) if entry]
    for entry in _FIXED_DIRS:
        dirs.append(Path(entry) if entry.startswith("/") else home / entry)
    nvm = home / ".nvm" / "versions" / "node"
    try:
        versions = sorted((p for p in nvm.iterdir() if p.is_dir()), key=_version_key, reverse=True)
    except OSError:
        versions = []
    if versions:
        dirs.append(versions[0] / "bin")
    dirs.append(home / ".local" / "share" / "fnm" / "aliases" / "default" / "bin")
    seen: set[str] = set()
    unique = []
    for directory in dirs:
        key = str(directory)
        if key not in seen and directory.is_absolute():
            seen.add(key)
            unique.append(directory)
    return unique


@lru_cache(maxsize=1)
def login_shell_path() -> str:
    """The person's login-shell PATH, asked once per process. Empty on any failure."""
    shell = os.environ.get("SHELL") or "/bin/zsh"
    if not Path(shell).is_absolute() or not Path(shell).exists():
        return ""
    try:
        result = subprocess.run([shell, "-l", "-c", 'printf %s "$PATH"'], capture_output=True, text=True,
                                timeout=LOGIN_SHELL_TIMEOUT_S, env=scrubbed_env(), stdin=subprocess.DEVNULL)
    except (OSError, subprocess.SubprocessError):
        return ""
    return result.stdout.strip() if result.returncode == 0 else ""


def _is_executable_file(path: Path) -> bool:
    try:
        return path.is_file() and os.access(path, os.X_OK)
    except OSError:
        return False


def resolve(command: str, *, home: Path | None = None, path_env: str | None = None,
            use_login_shell: bool = True) -> Path | None:
    """An absolute executable for ``command``, or None. No shell is involved."""
    if not isinstance(command, str) or not command or "\x00" in command:
        return None
    candidate = Path(command)
    if candidate.is_absolute():
        return candidate if _is_executable_file(candidate) else None
    if "/" in command or command in {".", ".."}:
        return None
    for directory in candidate_dirs(home, path_env):
        found = directory / command
        if _is_executable_file(found):
            return found
    if use_login_shell:
        for entry in login_shell_path().split(os.pathsep):
            if entry and Path(entry).is_absolute():
                found = Path(entry) / command
                if _is_executable_file(found):
                    return found
    return None


def child_path(resolved: Path, *, home: Path | None = None, path_env: str | None = None) -> str:
    """PATH for the agent: its own directory first, then the probed directories.

    ``#!/usr/bin/env node`` scripts (npx, claude-agent-acp) need ``node``
    next to them on PATH; the binary's own directory provides it."""
    entries = [str(Path(resolved).parent)] + [str(d) for d in candidate_dirs(home, path_env)]
    for fallback in ("/usr/bin", "/bin", "/usr/sbin", "/sbin"):
        entries.append(fallback)
    return os.pathsep.join(dict.fromkeys(entries))


@lru_cache(maxsize=16)
def node_major(npx_path: str) -> int | None:
    """The major version of the ``node`` next to ``npx_path``, or None."""
    node = Path(npx_path).parent / "node"
    if not _is_executable_file(node):
        return None
    try:
        result = subprocess.run([str(node), "--version"], capture_output=True, text=True, timeout=5,
                                env=scrubbed_env(), stdin=subprocess.DEVNULL)
    except (OSError, subprocess.SubprocessError):
        return None
    match = _VERSION_RE.search(result.stdout or "")
    return int(match.group(1)) if match else None
