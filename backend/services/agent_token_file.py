"""A personal agent's Nebula session token, handed over as a private file.

ACP's ``session/new`` gives the agent the ``nebula`` MCP server's command and
environment, and adapters pass that on however they like. The pinned Claude
adapter hands it to the Claude Agent SDK, which starts ``claude`` with
``--mcp-config <json>``: anything in that environment lands in argv, where
other local accounts can read it with ``ps``. So the token never goes into
``session/new``. Nebula writes it to a file only this macOS user can read and
passes the file's path (``NEBULA_AGENT_TOKEN_FILE``); backend/mcp_server.py
reads it at startup.

Layout: ``<state>/agent-tokens/<backend pid>/<session id>.token``. Both
directories are 0700 and the file 0600. It sits outside the agent's
workspace, and is deleted when the session ends. Tokens live in the backend's
memory, so a file left behind by a backend that died is already dead; the
next backend start removes it (``clear_stale``). The pid level keeps one
backend from deleting the files of another that shares the state dir.
"""
from __future__ import annotations

import os
import re
import shutil
import stat
from pathlib import Path

DIR_NAME = "agent-tokens"
ENV_VAR = "NEBULA_AGENT_TOKEN_FILE"
MAX_FILE_BYTES = 512
# secrets.token_urlsafe output (commons/actors.py mints 43 characters).
TOKEN_RE = re.compile(r"[A-Za-z0-9_-]{20,256}")
_NAME_RE = re.compile(r"[A-Za-z0-9_-]{1,128}")
_NOFOLLOW = getattr(os, "O_NOFOLLOW", 0)


class TokenFileError(ValueError):
    """The token file is missing, unreadable, too open or malformed."""


def root(state_dir: Path) -> Path:
    return Path(state_dir) / DIR_NAME


def _private_dir(path: Path) -> None:
    path.mkdir(mode=0o700, exist_ok=True)
    info = os.lstat(path)
    if not stat.S_ISDIR(info.st_mode):
        raise OSError(f"{path} is not a directory")
    if hasattr(os, "getuid") and info.st_uid != os.getuid():
        raise OSError(f"{path} belongs to another user")
    if os.name == "posix" and stat.S_IMODE(info.st_mode) != 0o700:
        os.chmod(path, 0o700)


def write(state_dir: Path, session_id: str, token: str) -> Path:
    """Write ``token`` to a new 0600 file for ``session_id`` and return its path."""
    if not _NAME_RE.fullmatch(session_id or ""):
        raise ValueError("session id is not a safe file name")
    if not TOKEN_RE.fullmatch(token or ""):
        raise ValueError("token is not in the expected format")
    base = root(state_dir)
    base.parent.mkdir(parents=True, exist_ok=True)
    _private_dir(base)
    directory = base / str(os.getpid())
    _private_dir(directory)
    path = directory / f"{session_id}.token"
    fd = os.open(path, os.O_WRONLY | os.O_CREAT | os.O_EXCL | _NOFOLLOW, 0o600)
    try:
        if hasattr(os, "fchmod"):
            os.fchmod(fd, 0o600)
        data = token.encode("ascii")
        while data:
            data = data[os.write(fd, data):]
    except BaseException:
        os.close(fd)
        remove(path)
        raise
    os.close(fd)
    return path


def remove(path: Path | None) -> None:
    if path is None:
        return
    try:
        os.unlink(path)
    except FileNotFoundError:
        pass
    except OSError:
        pass


def read(path: str | os.PathLike[str]) -> str:
    """The token in ``path``, checked strictly; TokenFileError otherwise.

    The file must be a regular file (not a symlink) owned by this user,
    readable by nobody else, at most MAX_FILE_BYTES, holding one token."""
    try:
        fd = os.open(os.fspath(path), os.O_RDONLY | _NOFOLLOW)
    except OSError as exc:
        raise TokenFileError(f"can't open the agent token file ({exc.strerror or exc})") from exc
    try:
        info = os.fstat(fd)
        if not stat.S_ISREG(info.st_mode):
            raise TokenFileError("the agent token file is not a regular file")
        if info.st_size > MAX_FILE_BYTES:
            raise TokenFileError("the agent token file is too large")
        if os.name == "posix":
            if info.st_uid != os.getuid():
                raise TokenFileError("the agent token file belongs to another user")
            if stat.S_IMODE(info.st_mode) & 0o077:
                raise TokenFileError("the agent token file is readable by other users")
        data = os.read(fd, MAX_FILE_BYTES + 1)
    except OSError as exc:
        raise TokenFileError(f"can't read the agent token file ({exc.strerror or exc})") from exc
    finally:
        os.close(fd)
    if len(data) > MAX_FILE_BYTES:
        raise TokenFileError("the agent token file is too large")
    try:
        token = data.decode("ascii")
    except UnicodeDecodeError as exc:
        raise TokenFileError("the agent token file is malformed") from exc
    if not TOKEN_RE.fullmatch(token):
        raise TokenFileError("the agent token file is malformed")
    return token


def _pid_alive(pid: int) -> bool:
    try:
        os.kill(pid, 0)
    except ProcessLookupError:
        return False
    except PermissionError:
        return True
    except OSError:
        return False
    return True


def clear_stale(state_dir: Path) -> int:
    """At backend startup: delete token files left by backends that are gone.

    Skips the folder of any other backend still running. This backend's own
    pid folder can only be left over from a dead process that had the same
    pid, so it goes too; call this before any session starts. Returns the
    number of folders removed."""
    base = root(state_dir)
    # Open the folder itself without following a symlink, and work through
    # that descriptor: a symlink planted at <state>/agent-tokens (by any
    # program running as this user, an agent included) must never turn this
    # sweep loose on the folder it points to, even if it is swapped in
    # between a check and the scan.
    flags = os.O_RDONLY | getattr(os, "O_DIRECTORY", 0) | _NOFOLLOW
    try:
        fd = os.open(base, flags)
    except OSError:
        return 0
    removed = 0
    try:
        info = os.fstat(fd)
        if not stat.S_ISDIR(info.st_mode) or (hasattr(os, "getuid") and info.st_uid != os.getuid()):
            return 0
        if not (os.scandir in os.supports_fd and shutil.rmtree.avoids_symlink_attacks):
            return 0
        for entry in list(os.scandir(fd)):
            if entry.name.isdigit():
                pid = int(entry.name)
                if pid != os.getpid() and _pid_alive(pid):
                    continue
            try:
                if entry.is_dir(follow_symlinks=False):
                    shutil.rmtree(entry.name, dir_fd=fd)
                else:
                    os.unlink(entry.name, dir_fd=fd)
                removed += 1
            except OSError:
                pass
    finally:
        os.close(fd)
    return removed
