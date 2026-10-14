"""Nebula tokens handed over as private files, and a personal agent's in particular.

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

The helpers below (``write_private``, ``unlink_private``, ``sweep`` and the
one strict reader, ``read``) also keep connected apps' tokens
(services/app_token_file.py). Where the OS can, they work through a folder
descriptor opened without following symlinks, so a symlink planted in the
state dir (by any program running as this user, an agent included) can't
send a write, a delete or a sweep somewhere else, even if it is swapped in
between a check and the use. Elsewhere (Windows) they fall back to paths.
"""
from __future__ import annotations

import os
import re
import shutil
import stat
from pathlib import Path
from typing import Callable

DIR_NAME = "agent-tokens"
ENV_VAR = "NEBULA_AGENT_TOKEN_FILE"
MAX_FILE_BYTES = 512
# secrets.token_urlsafe output (commons/actors.py mints 43 characters; app
# tokens are nebula_app_ plus 43).
TOKEN_RE = re.compile(r"[A-Za-z0-9_-]{20,256}")
_NAME_RE = re.compile(r"[A-Za-z0-9_-]{1,128}")
_NOFOLLOW = getattr(os, "O_NOFOLLOW", 0)
_DIR_FLAGS = os.O_RDONLY | getattr(os, "O_DIRECTORY", 0) | _NOFOLLOW
# Folder descriptors need openat/mkdirat/unlinkat and O_DIRECTORY|O_NOFOLLOW (macOS, Linux).
_DIR_FD = (hasattr(os, "O_DIRECTORY") and _NOFOLLOW != 0
           and {os.open, os.mkdir, os.unlink} <= os.supports_dir_fd)


class TokenFileError(ValueError):
    """The token file is missing, unreadable, too open or malformed."""


def root(state_dir: Path) -> Path:
    return Path(state_dir) / DIR_NAME


def _check_private(info: os.stat_result, path: Path | str) -> None:
    if not stat.S_ISDIR(info.st_mode):
        raise OSError(f"{path} is not a directory")
    if hasattr(os, "getuid") and info.st_uid != os.getuid():
        raise OSError(f"{path} belongs to another user")


def _private_dir(path: Path) -> None:
    """Path-based: where folder descriptors aren't available."""
    path.mkdir(mode=0o700, exist_ok=True)
    _check_private(os.lstat(path), path)
    if os.name == "posix" and stat.S_IMODE(os.lstat(path).st_mode) != 0o700:
        os.chmod(path, 0o700)


def _open_private_dir(name: Path | str, dir_fd: int | None = None) -> int:
    """Make (0700) or open a folder this user owns, never through a symlink,
    tightening it to 0700. Returns its descriptor."""
    try:
        os.mkdir(name, 0o700, dir_fd=dir_fd)
    except FileExistsError:
        pass
    fd = os.open(name, _DIR_FLAGS, dir_fd=dir_fd)
    try:
        info = os.fstat(fd)
        _check_private(info, name)
        if stat.S_IMODE(info.st_mode) != 0o700:
            os.fchmod(fd, 0o700)
    except BaseException:
        os.close(fd)
        raise
    return fd


def _create(name: Path | str, token: str, dir_fd: int | None) -> None:
    fd = os.open(name, os.O_WRONLY | os.O_CREAT | os.O_EXCL | _NOFOLLOW, 0o600, dir_fd=dir_fd)
    try:
        if hasattr(os, "fchmod"):
            os.fchmod(fd, 0o600)
        data = token.encode("ascii")
        while data:
            data = data[os.write(fd, data):]
    except BaseException:
        os.close(fd)
        try:
            os.unlink(name, dir_fd=dir_fd)
        except OSError:
            pass
        raise
    os.close(fd)


def write_private(base: Path, subdirs: tuple[str, ...], name: str, token: str) -> Path:
    """Write ``token`` to a new 0600 file ``base/<subdirs...>/<name>`` and
    return its path. ``base`` and each subfolder are made 0700 and must be
    this user's real folders (not symlinks); the file must not exist yet.
    ``base``'s parent (the state dir) is trusted and made if missing."""
    if not TOKEN_RE.fullmatch(token or ""):
        raise ValueError("token is not in the expected format")
    for part in (*subdirs, name):
        if not _NAME_RE.fullmatch(part.removesuffix(".token")) or part in (".", ".."):
            raise ValueError("not a safe file name")
    base = Path(base)
    base.parent.mkdir(parents=True, exist_ok=True)
    path = base.joinpath(*subdirs, name)
    if not _DIR_FD:
        directory = base
        _private_dir(directory)
        for part in subdirs:
            directory = directory / part
            _private_dir(directory)
        _create(path, token, None)
        return path
    fds = [_open_private_dir(base)]
    try:
        for part in subdirs:
            fds.append(_open_private_dir(part, dir_fd=fds[-1]))
        _create(name, token, fds[-1])
    finally:
        for fd in fds:
            os.close(fd)
    return path


def unlink_private(base: Path, name: str) -> bool:
    """Delete ``base/<name>`` without following a symlink at ``base``.
    Returns whether a file went; never raises."""
    if not _NAME_RE.fullmatch(name.removesuffix(".token")):
        return False
    try:
        if not _DIR_FD:
            os.unlink(Path(base) / name)
            return True
        fd = os.open(base, _DIR_FLAGS)
        try:
            os.unlink(name, dir_fd=fd)
        finally:
            os.close(fd)
        return True
    except OSError:
        return False


def write(state_dir: Path, session_id: str, token: str) -> Path:
    """Write ``token`` to a new 0600 file for ``session_id`` and return its path."""
    if not _NAME_RE.fullmatch(session_id or ""):
        raise ValueError("session id is not a safe file name")
    return write_private(root(state_dir), (str(os.getpid()),), f"{session_id}.token", token)


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
        raise TokenFileError(f"can't open the token file ({exc.strerror or exc})") from exc
    try:
        info = os.fstat(fd)
        if not stat.S_ISREG(info.st_mode):
            raise TokenFileError("the token file is not a regular file")
        if info.st_size > MAX_FILE_BYTES:
            raise TokenFileError("the token file is too large")
        if os.name == "posix":
            if info.st_uid != os.getuid():
                raise TokenFileError("the token file belongs to another user")
            if stat.S_IMODE(info.st_mode) & 0o077:
                raise TokenFileError("the token file is readable by other users")
        data = os.read(fd, MAX_FILE_BYTES + 1)
    except OSError as exc:
        raise TokenFileError(f"can't read the token file ({exc.strerror or exc})") from exc
    finally:
        os.close(fd)
    if len(data) > MAX_FILE_BYTES:
        raise TokenFileError("the token file is too large")
    try:
        token = data.decode("ascii")
    except UnicodeDecodeError as exc:
        raise TokenFileError("the token file is malformed") from exc
    if not TOKEN_RE.fullmatch(token):
        raise TokenFileError("the token file is malformed")
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


def sweep(base: Path, keep: Callable[[os.DirEntry], bool]) -> int:
    """Delete every entry in ``base`` that ``keep`` doesn't want, folders
    included. Returns the number removed.

    Opens ``base`` itself without following a symlink, and works through
    that descriptor: a symlink planted at ``base`` must never turn the sweep
    loose on the folder it points to, even if it is swapped in between a
    check and the scan. A symlink inside is unlinked, never followed. Where
    the OS can't do this safely, it removes nothing."""
    try:
        fd = os.open(base, _DIR_FLAGS)
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
            if keep(entry):
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


def clear_stale(state_dir: Path) -> int:
    """At backend startup: delete token files left by backends that are gone.

    Skips the folder of any other backend still running. This backend's own
    pid folder can only be left over from a dead process that had the same
    pid, so it goes too; call this before any session starts. Returns the
    number of folders removed."""
    def live_backend(entry: os.DirEntry) -> bool:
        if not entry.name.isdigit():
            return False
        pid = int(entry.name)
        return pid != os.getpid() and _pid_alive(pid)

    return sweep(root(state_dir), live_backend)
