from __future__ import annotations

import asyncio
import copy
import errno
import json
import os
import re
import stat
import sys
import tempfile
import time
from dataclasses import dataclass
from datetime import datetime, timezone
from pathlib import Path
from typing import Any, Callable

import httpx

# Where settings.json lives when NEBULA_SETTINGS_PATH isn't set: the repo
# root (browser mode).
_DEFAULT_SETTINGS_PATH = Path(__file__).resolve().parent.parent.parent / "settings.json"


def settings_path() -> Path:
    """The settings file's path as configured, read from the environment at
    each call: NEBULA_SETTINGS_PATH when it is set, with "~" expanded to the
    home folder (never a folder named "~"), else the repo's settings.json.
    Read at call time, so a test sets the variable (monkeypatch.setenv) and
    nothing reloads this module (review 13 of PR #203, LOW-2). An empty
    value is unset, as paper_export_path reads it, never the working folder
    (review 14, settings-gate NIT-3)."""
    raw = os.environ.get("NEBULA_SETTINGS_PATH")
    return (Path(raw) if raw else _DEFAULT_SETTINGS_PATH).expanduser()


def settings_file() -> Path:
    """settings_path resolved: the one file every reader and writer uses
    (agent_profiles' deny rules read settings_path too; review 12 of PR
    #203, LOW-2). A symlink loop on the way is SettingsUnreadable, as any
    file Nebula can't read, for reads, writes and start_here alike (review
    14, settings-gate LOW-3: resolve() raised outside every handler)."""
    try:
        return settings_path().resolve()
    except (RuntimeError, OSError) as exc:  # 3.12 raises RuntimeError for a loop, 3.13 OSError
        raise SettingsUnreadable(str(settings_path())) from exc


class SettingsUnreadable(ValueError):
    """The settings file is there but Nebula can't read it as settings: cut
    short, hand-edited, not text, not readable for this user, or a folder. A ValueError, as json.load's own error is, so
    every reader that failed closed on it still does; the settings routes
    answer it with the 409 (main.SETTINGS_UNREADABLE; review 12, LOW-3;
    review 13, HIGH-1 and LOW-3)."""


class SettingsUnwritable(PermissionError):
    """Nebula can read the settings file but can't write it either way a
    save may (save_settings: atomically, or in place where atomic isn't
    safe). ``cause`` says what stops it, for the 409's line (GM, PR #203 r28
    item 4; r31 items 1 and 2):

    - "file": the file is read-only for this user (or the disk is);
    - "folder": its folder takes no new file and the file can't be written
      in place (it isn't there yet, or it is read-only too);
    - "not_a_folder": a folder on the way to it is a file, so nothing can be
      saved there.

    ``where`` is the path the line names: the file, its folder, or the file
    that is in the way. The settings routes answer it with a 409, never a
    500."""

    def __init__(self, err: int, message: str, where: str | Path, cause: str = "file") -> None:
        super().__init__(err, message, str(where))
        self.cause = cause
        self.where = Path(where)


# The OSErrors that mean "not allowed" rather than "something broke": no
# permission, an operation the filesystem refuses, a read-only filesystem.
_NOT_ALLOWED_ERRNOS = frozenset({errno.EACCES, errno.EPERM, errno.EROFS})


def settings_write_block() -> SettingsUnwritable | None:
    """What stops a save from writing the settings file, or None when one
    of the ways save_settings writes can (review 15 of PR #203,
    settings-keychain MEDIUM-1 and LOW-1). Asked before a write changes
    anything (main._saved_settings_or_409); save_settings asks again, so a
    file that turned read-only in between is still refused.

    - A folder on the way that is a file: "not_a_folder", naming that file.
    - Folders that aren't there yet are made (a fresh install) when the
      nearest one that is takes a new folder; else "folder".
    - A file that is there: writable for this user is enough (in place when
      its folder takes no temp file); read-only is "file".
    - No file yet: its folder must take one ("folder")."""
    path = settings_file()
    folder = path.parent
    nearest = folder
    while not os.path.lexists(nearest) and nearest != nearest.parent:
        nearest = nearest.parent
    if not nearest.is_dir():
        return SettingsUnwritable(errno.ENOTDIR, "a folder on the way is a file", nearest, "not_a_folder")
    if nearest != folder:
        if os.access(nearest, os.W_OK | os.X_OK):
            return None
        return SettingsUnwritable(errno.EACCES, "settings folder can't be made", folder, "folder")
    if path.exists():
        if os.access(path, os.W_OK):
            return None
        return SettingsUnwritable(errno.EACCES, "settings file is read-only", path, "file")
    if os.access(folder, os.W_OK | os.X_OK):
        return None
    return SettingsUnwritable(errno.EACCES, "settings folder is read-only", folder, "folder")


def settings_writable() -> bool:
    """Whether a save may write the settings file (settings_write_block)."""
    return settings_write_block() is None


# The OSErrors that say there is no settings file: not found, and a folder
# on the way that is a file (ENOTDIR: nothing can be there, and before round
# 14 exists() said False for it; review 14, settings-gate HIGH-1). Every
# other OSError is a file Nebula can't read.
_NO_FILE_ERRORS = (FileNotFoundError, NotADirectoryError)


# No settings file yet: _read_settings_file's answer, told apart from a file
# whose JSON is ``null`` (review 13 of PR #203, HIGH-1).
_MISSING: Any = object()


def _read_settings_file() -> Any:
    """The file's JSON, or _MISSING when there is no file yet (not found, a
    broken symlink, a folder on the way that is a file: _NO_FILE_ERRORS). A
    file that is there and can't be read (not JSON, not text, no
    permission, a folder, a symlink loop) raises SettingsUnreadable: every
    other OSError (review 13 of PR #203, LOW-3; review 14, HIGH-1)."""
    path = settings_file()
    try:
        with open(path, "r", encoding="utf-8") as f:
            return json.load(f)
    except _NO_FILE_ERRORS:
        return _MISSING
    except (json.JSONDecodeError, UnicodeDecodeError, OSError) as exc:
        raise SettingsUnreadable(str(path)) from exc


def _saved_or_default(saved: Any) -> Any:
    """DEFAULT_SETTINGS with the saved object over it, deep-copied (callers
    change the nested dicts, apiKeys and routing, which must never change
    DEFAULT_SETTINGS itself); with no file, the defaults. A file that holds
    something other than an object (``null``, a list, a string) comes back
    as it is, nothing to merge into, so every reader fails closed on it and
    every write gets the 409, as before round 13: ``null`` is no exception
    (review 13 of PR #203, HIGH-1)."""
    if saved is _MISSING:
        return copy.deepcopy(DEFAULT_SETTINGS)
    if isinstance(saved, dict):
        settings = copy.deepcopy(DEFAULT_SETTINGS)
        settings.update(saved)
        return settings
    return saved


# ---------------------------------------------------------------------------
# Injected credentials (desktop mode)
# ---------------------------------------------------------------------------
#
# When Electron launches the sidecar it decrypts API keys from the Keychain
# and sends them over the sidecar's stdin (services/launch_secrets.py calls
# set_injected_keys at startup). The NEBULA_INJECTED_KEYS env var (a JSON
# dict) is still read here for tests and hand-started backends; Electron no
# longer uses it, because a process's environment is readable with `ps -E`.
# The backend stores them in this module-level dict (memory only — never
# persisted to disk). load_settings() merges them into the apiKeys field, giving them
# precedence over any file-based values. Browser/dev mode (no env var) leaves
# this dict empty and the backend reads keys from settings.json as before.

def parse_injected_keys(raw: str) -> dict[str, str]:
    """NEBULA_INJECTED_KEYS' value as keys: a JSON object of names to keys,
    without the empty ones. Anything else (empty, not JSON, not an object)
    is no keys. Read once, at import; tests call this directly rather than
    reloading the module (review 13 of PR #203, LOW-2)."""
    if not raw:
        return {}
    try:
        parsed = json.loads(raw)
    except (json.JSONDecodeError, TypeError):
        return {}
    if not isinstance(parsed, dict):
        return {}
    return {str(k): str(v) for k, v in parsed.items() if v}


_INJECTED_KEYS: dict[str, str] = parse_injected_keys(os.environ.get("NEBULA_INJECTED_KEYS", ""))


def is_injected_mode() -> bool:
    """Return True when credential injection (desktop mode) is active."""
    return bool(_INJECTED_KEYS)


def set_injected_keys(keys: dict[str, str]) -> None:
    """Replace the injected keys (the desktop launch-secrets line). Memory only."""
    global _INJECTED_KEYS
    _INJECTED_KEYS = {str(k): str(v) for k, v in keys.items() if v}
    clear_provider_validation_cache()


def update_injected_keys(provider: str, key: str) -> None:
    """Update a single in-memory injected key.

    Called by the POST /api/credentials/update endpoint when Electron
    updates a key via the Settings panel credential IPC. Never persists
    to disk.
    """
    global _INJECTED_KEYS
    if key:
        _INJECTED_KEYS[provider] = key
    else:
        _INJECTED_KEYS.pop(provider, None)
    # A key change invalidates cached provider validation results.
    clear_provider_validation_cache()


DEFAULT_SETTINGS: dict[str, Any] = {
    "apiKeys": {},
    "routing": {},
    "outputPath": None,
    "executionMode": "manual",
    "batchSizeCap": 25,
    "exportFolder": None,
    "zoomTelemetryEnabled": False,
    "kreaConnectionMode": "api-token",
}


def load_settings() -> dict[str, Any]:
    """The saved settings, with a default for every key the file leaves out.

    A partial ``settings.json`` (a hand-written ``{}``, or one written before
    a setting existed) used to come back without ``apiKeys``, and the
    Settings panel then showed "Settings couldn't load". Values in the file
    always win; loading never writes the file.
    """
    settings = _saved_or_default(_read_settings_file())
    if not isinstance(settings, dict):
        # A file that holds something other than an object (null, [], "x"):
        # every reader fails closed on what it holds, as it is. Checked
        # first, so no step below meets a non-object (review 14,
        # settings-gate MEDIUM-1: the desktop's injected keys raised a
        # TypeError on it, a 500).
        return settings

    # Desktop mode: injected keys replace file-based apiKeys entirely.
    # Non-secret settings from the file (routing, outputPath, etc.) remain.
    if _INJECTED_KEYS:
        settings["apiKeys"] = dict(_INJECTED_KEYS)

    # Every key as Nebula reads it (node_route.key_text, the one key-state
    # function): trimmed, and one that is empty once trimmed (only spaces or
    # invisible marks, already stored that way) isn't set at all, for every
    # reader alike: the run gate, the handlers, describe_node, the masked
    # GET /api/settings the canvas reads (GM, PR #203 r17 item 1; review 8,
    # LOW-1).
    if isinstance(settings.get("apiKeys"), dict):
        settings["apiKeys"] = read_keys(settings["apiKeys"])
    else:
        # Keys Nebula can't read (an `apiKeys` that isn't an object): no key
        # is set, for every reader, as a key that is empty once trimmed
        # isn't. The file keeps them as saved: a write starts from
        # load_saved_settings and never replaces them with a guess (review
        # 10 of PR #203, NIT-6; main.KEYS_UNREADABLE).
        settings["apiKeys"] = {}

    return settings


def saved_keys_readable(saved: Any) -> bool:
    """Whether the saved settings' `apiKeys` (load_saved_settings) is an
    object a write can change key by key. A file that leaves it out has
    none yet, which a write may fill."""
    return isinstance(saved, dict) and isinstance(saved.get("apiKeys", {}), dict)


def saved_keys_hold_nothing(saved: Any) -> bool:
    """Whether the saved `apiKeys` is a value that holds no key at all
    (null, [], "", false, 0): a write may replace it, as it fills a file
    that leaves `apiKeys` out (GM, PR #203 r23; review 11, LOW-3). Content
    Nebula can't read (a list of keys, a string, a number) is never this."""
    if not isinstance(saved, dict) or "apiKeys" not in saved:
        return False
    value = saved["apiKeys"]
    return not isinstance(value, dict) and not value


def saved_keys_writable(saved: Any) -> bool:
    """Whether a key write may change the saved `apiKeys`: it is an object
    (saved_keys_readable), or a value that holds nothing, which the write
    replaces (saved_keys_hold_nothing). Anything else stays as saved and the
    write gets main.KEYS_UNREADABLE."""
    return saved_keys_readable(saved) or saved_keys_hold_nothing(saved)


def settings_file_path() -> str:
    """The settings file this backend reads and writes, as a full path:
    NEBULA_SETTINGS_PATH when it is set, resolved (settings_file; the 409
    lines name it; GM, PR #203 r22 item 3)."""
    return str(settings_file())


def settings_file_shown() -> str:
    """The settings file as the 409 lines show it, to the person and to
    agents alike: the path as configured (never what a symlink at it points
    to, which may be a folder; review 14, settings-gate NIT-2), made
    absolute. Under the home folder it starts "~", so it wraps less
    ("~/.nebula/settings.json"); anywhere else it stays absolute (GM, PR #203
    r24 item 7). Never raises: a symlink loop still gets its line."""
    return shown_path(Path(os.path.abspath(settings_path())))


def shown_path(path: Path) -> str:
    """``path`` (absolute) as the 409 lines show a path: from "~" when it is
    under the home folder, as written or resolved, else as it is. The folder
    lines name the real folder this way (GM, PR #203 r31 items 1 and 2:
    "~/.nebula")."""
    homes = _home_for_shown_paths()
    if homes is None:
        return str(path)
    for home, shown in ((homes[0], path), (homes[1], _resolved_or(path))):
        try:
            rest = shown.relative_to(home)
        except ValueError:
            continue
        return "~" if not rest.parts else f"~{os.sep}{rest}"
    return str(path)


def _resolved_or(path: Path) -> Path:
    """``path`` with its symlinks resolved, or as it is when they loop."""
    try:
        return path.resolve()
    except (RuntimeError, OSError):
        return path


def _home_for_shown_paths() -> tuple[Path, Path] | None:
    """The home folder a shown path may start "~" for, as written and
    resolved (a path through a symlinked home, or through the folder it
    points to, is under it either way): a real, absolute folder other than
    the filesystem's root. With HOME empty, relative or "/" (a launchd or
    sidecar environment can run that way), every path would be "under
    home", so none is (review 13 of PR #203, LOW-4)."""
    try:
        raw = Path.home()
    except (RuntimeError, KeyError):
        return None
    if not raw.is_absolute():
        return None
    home = _resolved_or(raw)
    if home == Path(home.anchor) or not home.is_dir():
        return None
    return Path(os.path.abspath(raw)), home


def load_saved_settings() -> dict[str, Any]:
    """The settings file as saved, with a default for every key it leaves
    out, and nothing else: no injected keys and no key read through
    node_route.key_text. What a write starts from (PUT /api/settings, a
    key's DELETE), so a save changes only what it was asked to: an entry the
    person didn't change, a padded key, an empty one or one that isn't text,
    is written back as it was (review 9 of PR #203, keys NIT-1). Readers use
    load_settings."""
    return _saved_or_default(_read_settings_file())


def read_keys(api_keys: dict[str, Any]) -> dict[str, str]:
    """``api_keys`` as Nebula reads them (load_settings): each key_text,
    without those that are empty once trimmed."""
    kept: dict[str, str] = {}
    for name, value in api_keys.items():
        text = _key_text(value)
        if text:
            kept[name] = text
    return kept


def save_settings(settings: dict[str, Any]) -> None:
    # Desktop mode: never persist injected keys to disk. The App Support
    # settings.json must keep apiKeys empty — keys live only in the
    # Keychain (via Electron) and in _INJECTED_KEYS (memory).
    #
    # The one exception to "a write keeps keys it can't read as saved"
    # (main.KEYS_UNREADABLE; review 11 of PR #203, NIT-5): in desktop mode
    # every save writes {} over the file's `apiKeys`, readable or not. Kept
    # on purpose: no reader uses the file's keys there (load_settings
    # replaces them with the injected ones), so nothing Nebula runs with is
    # lost, and a key found in the desktop file is plain text on disk that
    # this write removes. Writing them back as saved would keep it there.
    to_write = dict(settings)
    if _INJECTED_KEYS:
        to_write["apiKeys"] = {}
    text = json.dumps(to_write, indent=2) + "\n"

    # Whole or not at all where that is safe (PR #203 round 15): the new
    # settings go to a temp file beside the old one, then replace it in one
    # rename, so a save cut short never leaves a file Nebula can't read.
    # Where a rename would lose what an in-place write kept, or the folder
    # takes no temp file, the file is written in place as before round 15,
    # so no save that worked then is refused now (review 15, settings-keychain
    # MEDIUM-1 and NIT-1). Refused only when neither way can write
    # (settings_write_block); the file is then left as it was.
    block = settings_write_block()
    if block is not None:
        raise block
    path = settings_file()
    if not path.parent.is_dir():
        # A fresh install: its folder isn't there yet (review 15, LOW-1).
        path.parent.mkdir(mode=0o700, parents=True, exist_ok=True)
    try:
        before = path.stat()
    except FileNotFoundError:
        before = None
    if before is not None and not _replace_keeps_the_file(path, before):
        _write_in_place(path, text)
        return
    try:
        _write_atomically(path, text, before)
    except _InPlaceInstead:
        _write_in_place(path, text)


class _InPlaceInstead(Exception):
    """The atomic save can't keep what the file has (its group, its folder
    takes no temp file, or the rename is refused): write it in place."""


# Extended attributes every new file gets on its own, so a replace loses
# nothing by them: macOS stamps com.apple.provenance on files a process
# writes, and SELinux labels new files by policy.
_OWN_XATTRS = frozenset({"com.apple.provenance", "security.selinux"})


def _replace_keeps_the_file(path: Path, before: os.stat_result) -> bool:
    """Whether replacing ``path`` (resolved: never a symlink) with a new
    file keeps what an in-place write keeps: a regular file with one name
    (a hard link's other names would keep the old settings), owned by this
    user (a rename makes the file this user's), with no ACL and no extended
    attribute of its own (review 15, settings-keychain NIT-1). Unknown is
    no."""
    if not stat.S_ISREG(before.st_mode) or before.st_nlink != 1:
        return False
    if hasattr(os, "geteuid") and before.st_uid != os.geteuid():
        return False
    try:
        return not _has_own_metadata(path)
    except OSError:
        return False


def _has_own_metadata(path: Path) -> bool:
    """Whether ``path`` carries an ACL or an extended attribute a new file
    wouldn't get (_OWN_XATTRS). Linux lists ACLs as xattrs; macOS keeps its
    ACL apart (acl_get_file)."""
    if hasattr(os, "listxattr"):
        return bool(set(os.listxattr(path)) - _OWN_XATTRS)
    if sys.platform == "darwin":
        return _darwin_metadata(path)
    return False


def _darwin_metadata(path: Path) -> bool:
    import ctypes
    import ctypes.util

    libc = ctypes.CDLL(ctypes.util.find_library("c"), use_errno=True)
    raw = os.fsencode(path)
    libc.listxattr.argtypes = [ctypes.c_char_p, ctypes.c_char_p, ctypes.c_size_t, ctypes.c_int]
    libc.listxattr.restype = ctypes.c_ssize_t
    size = libc.listxattr(raw, None, 0, 0)
    if size < 0:
        raise OSError(ctypes.get_errno(), "listxattr failed", str(path))
    if size:
        buf = ctypes.create_string_buffer(size)
        got = libc.listxattr(raw, buf, size, 0)
        if got < 0:
            raise OSError(ctypes.get_errno(), "listxattr failed", str(path))
        names = {name.decode("utf-8", "replace") for name in buf.raw[:got].split(b"\0") if name}
        if names - _OWN_XATTRS:
            return True
    libc.acl_get_file.argtypes = [ctypes.c_char_p, ctypes.c_int]
    libc.acl_get_file.restype = ctypes.c_void_p
    acl = libc.acl_get_file(raw, 0x00000100)  # ACL_TYPE_EXTENDED
    if not acl:
        if ctypes.get_errno() in (errno.ENOENT, 0):
            return False
        raise OSError(ctypes.get_errno(), "acl_get_file failed", str(path))
    libc.acl_free.argtypes = [ctypes.c_void_p]
    libc.acl_free(acl)
    return True


def _write_atomically(path: Path, text: str, before: os.stat_result | None) -> None:
    """The temp file (this user's only from the start), written whole, given
    the old file's mode and group, then renamed over the file. It is removed
    on any failure, whatever was raised, so no copy of the keys is left
    beside the file (review 15, settings-keychain LOW-2); a folder that takes
    no temp file, or a rename that is refused, falls back to the in-place
    write (_InPlaceInstead)."""
    mode = before.st_mode & 0o7777 if before is not None else 0o600  # a new file holds keys
    try:
        fd, temp = tempfile.mkstemp(prefix=TEMP_PREFIX, suffix=TEMP_SUFFIX, dir=path.parent)  # 0600
    except OSError as exc:
        if before is not None and exc.errno in _NOT_ALLOWED_ERRNOS:
            raise _InPlaceInstead from exc
        if exc.errno in _NOT_ALLOWED_ERRNOS:
            raise SettingsUnwritable(exc.errno, "settings folder is read-only", path.parent, "folder") from exc
        if exc.errno == errno.ENOTDIR:  # the folder turned into a file after the check
            raise SettingsUnwritable(exc.errno, "a folder on the way is a file", path.parent, "not_a_folder") from exc
        raise
    done = False
    try:
        with os.fdopen(fd, "w", encoding="utf-8") as f:
            f.write(text)
            f.flush()
            os.fsync(f.fileno())
        if before is not None and os.stat(temp).st_gid != before.st_gid:
            try:
                os.chown(temp, -1, before.st_gid)
            except OSError as exc:
                raise _InPlaceInstead from exc
        os.chmod(temp, mode)
        try:
            _replace(temp, path)
        except OSError as exc:
            if before is not None and exc.errno in _NOT_ALLOWED_ERRNOS:
                raise _InPlaceInstead from exc  # an ACL that denies delete, say
            if exc.errno in _NOT_ALLOWED_ERRNOS:
                raise SettingsUnwritable(exc.errno, "settings file can't be changed", path, "file") from exc
            raise
        done = True
    finally:
        if not done:
            try:
                os.unlink(temp)
            except OSError:
                pass  # the folder turned read-only too: swept at the next start


def _write_in_place(path: Path, text: str) -> None:
    """The file written where it is, as every save was before round 15: its
    name, links, owner, ACL and attributes stay. Not atomic."""
    try:
        with open(path, "w", encoding="utf-8") as f:
            f.write(text)
            f.flush()
            os.fsync(f.fileno())
    except OSError as exc:
        if exc.errno in _NOT_ALLOWED_ERRNOS:
            raise SettingsUnwritable(exc.errno, "settings file can't be changed", path, "file") from exc
        raise


# The rename that puts a temp file in place: a seam tests patch by name, so
# no other os.replace in a request is touched (review 15, sockets-tests NIT-2).
_replace = os.replace

TEMP_PREFIX = ".settings-"
TEMP_SUFFIX = ".tmp"
# A temp file older than this is a save that never finished (killed between
# the write and the rename); a newer one may be another process's save.
STALE_TEMP_SECONDS = 60.0


def sweep_stale_temp_files(now: float | None = None) -> list[Path]:
    """Remove temp files a save left beside settings.json when it was cut
    short (a kill, a power cut): each is a full copy of the settings, keys
    included (review 15, settings-keychain LOW-2). Run at startup. Only this
    module's names, only regular files, only ones older than
    STALE_TEMP_SECONDS. Never raises."""
    removed: list[Path] = []
    try:
        folder = settings_file().parent
        entries = list(folder.iterdir())
    except (SettingsUnreadable, OSError):
        return removed
    cutoff = (time.time() if now is None else now) - STALE_TEMP_SECONDS
    for entry in entries:
        name = entry.name
        if not (name.startswith(TEMP_PREFIX) and name.endswith(TEMP_SUFFIX)):
            continue
        try:
            info = entry.lstat()
            if not stat.S_ISREG(info.st_mode) or info.st_mtime > cutoff:
                continue
            entry.unlink()
            removed.append(entry)
        except OSError:
            continue
    return removed


def get_api_key(provider_key_name: str | list[str]) -> str | None:
    settings = load_settings()
    api_keys = settings.get("apiKeys", {})

    if isinstance(provider_key_name, str):
        names = [provider_key_name]
    else:
        names = provider_key_name

    for name in names:
        key = api_keys.get(name)
        # Spaces alone are no key (the router's _is_set reads them as unset).
        if key and (not isinstance(key, str) or key.strip()):
            return key
    return None


# ---------------------------------------------------------------------------
# Per-provider API key validation (GET /api/health/providers)
# ---------------------------------------------------------------------------
#
# get_api_key() only checks non-empty presence — a stale or revoked key still
# reads as "configured", which sends the agent down a generation path that is
# guaranteed to fail. validate_provider_keys() closes that gap: for every
# known provider it confirms a credential exists, then makes one minimal
# authenticated API call and classifies the outcome. Results are cached in
# memory with a 5-minute TTL so repeated health polls don't hammer providers.

PROVIDER_STATUS_NOT_CONFIGURED = "not_configured"
PROVIDER_STATUS_CONFIGURED_UNVERIFIED = "configured_unverified"
PROVIDER_STATUS_VALID = "valid"
PROVIDER_STATUS_INVALID = "invalid"
PROVIDER_STATUS_UNAUTHORIZED = "unauthorized"
PROVIDER_STATUS_INSUFFICIENT_CREDITS = "insufficient_credits"
PROVIDER_STATUS_RATE_LIMITED = "rate_limited"
PROVIDER_STATUS_ERROR = "error"

PROVIDER_CHECK_TTL_SECONDS = 300.0  # 5-minute cache TTL
PROVIDER_CHECK_TIMEOUT_SECONDS = 10.0


@dataclass(frozen=True)
class ProviderCheck:
    """How to validate one provider's credential.

    key_names: settings.json apiKeys entries to try, in order. Empty for
    providers whose credential does not live in settings.json (Nous reads an
    OAuth token from Hermes auth files instead).
    """

    key_names: tuple[str, ...]
    url: str
    auth_headers: Callable[[str], dict[str, str]]
    # Optional offline check for credentials that cannot be probed with a
    # single authenticated GET. Returns an error detail (never echoing the
    # secret) or None when the credential is well-formed.
    local_validator: Callable[[str], str | None] | None = None
    # Optional offline refusal ahead of the probe: a detail (never echoing the
    # secret) when the credential can't be sent as it is, so nothing is sent;
    # None lets the probe go out as usual.
    refuse_before_sending: Callable[[str], str | None] | None = None


def validate_google_service_account_json(raw: str) -> str | None:
    """Offline shape check for a Google Cloud service-account JSON key.

    A real check needs an OAuth token exchange, so health only confirms the
    pasted value parses and carries the fields the Vertex handler needs.
    Error details never include any part of the credential.
    """
    from services.google_vertex import VertexCredentialsError, parse_service_account

    try:
        parse_service_account(raw)
    except VertexCredentialsError as exc:
        return str(exc)
    return None


PROVIDER_CHECKS: dict[str, ProviderCheck] = {
    "FAL": ProviderCheck(
        ("FAL_KEY",),
        "https://api.fal.ai/v1/models?limit=1",
        lambda key: {"Authorization": f"Key {key}"},
    ),
    "OpenAI": ProviderCheck(
        ("OPENAI_API_KEY",),
        "https://api.openai.com/v1/models",
        lambda key: {"Authorization": f"Bearer {key}"},
    ),
    "Google": ProviderCheck(
        ("GOOGLE_API_KEY",),
        "https://generativelanguage.googleapis.com/v1beta/models?pageSize=1",
        lambda key: {"x-goog-api-key": key},
    ),
    "Ideogram": ProviderCheck(
        ("IDEOGRAM_API_KEY",),
        "https://api.ideogram.ai/models",
        lambda key: {"Api-Key": key},
    ),
    "Runway": ProviderCheck(
        ("RUNWAY_API_KEY",),
        "https://api.dev.runwayml.com/v1/organization",
        lambda key: {
            "Authorization": f"Bearer {key}",
            "X-Runway-Version": "2024-11-06",
        },
    ),
    "xAI": ProviderCheck(
        ("XAI_API_KEY",),
        "https://api.x.ai/v1/models",
        lambda key: {"Authorization": f"Bearer {key}"},
    ),
    "Replicate": ProviderCheck(
        ("REPLICATE_API_TOKEN",),
        "https://api.replicate.com/v1/models",
        lambda key: {"Authorization": f"Bearer {key}"},
    ),
    "ElevenLabs": ProviderCheck(
        ("ELEVENLABS_API_KEY",),
        "https://api.elevenlabs.io/v1/user",
        lambda key: {"xi-api-key": key},
    ),
    "Anthropic": ProviderCheck(
        ("ANTHROPIC_API_KEY",),
        "https://api.anthropic.com/v1/models?limit=1",
        lambda key: {
            "x-api-key": key,
            "anthropic-version": "2023-06-01",
        },
    ),
    "OpenRouter": ProviderCheck(
        ("OPENROUTER_API_KEY",),
        "https://openrouter.ai/api/v1/key",
        lambda key: {"Authorization": f"Bearer {key}"},
    ),
    "Meshy": ProviderCheck(
        ("MESHY_API_KEY",),
        "https://api.meshy.ai/openapi/v1/balance",
        lambda key: {"Authorization": f"Bearer {key}"},
    ),
    "MiniMax": ProviderCheck(
        ("MINIMAX_API_KEY",),
        "https://api.minimaxi.com/v1/models/MiniMax-M2.7",
        lambda key: {"Authorization": f"Bearer {key}"},
    ),
    "QuiverAI": ProviderCheck(
        ("QUIVER_API_KEY",),
        "https://api.quiver.ai/v1/models",
        lambda key: {"Authorization": f"Bearer {key}"},
    ),
    "Krea": ProviderCheck(
        ("KREA_API_TOKEN",),
        "https://api.krea.ai/styles",
        lambda key: {"Authorization": f"Bearer {key}"},
    ),
    # Read-only list of the workspace's metered jobs (default: last 7 days).
    # Krea refuses personal API tokens here, so a 2xx proves a service key.
    "Krea usage": ProviderCheck(
        ("KREA_USAGE_KEY",),
        "https://api.krea.ai/usage",
        lambda key: {"Authorization": f"Bearer {key}"},
    ),
    # Veo 3.1 on Vertex AI. Validating for real needs a JWT -> OAuth token
    # exchange, so health checks the service-account JSON offline only.
    "Google Vertex": ProviderCheck(
        ("GOOGLE_VERTEX_CREDENTIALS",),
        "",
        lambda key: {},
        local_validator=validate_google_service_account_json,
    ),
    # Black Forest Labs (FLUX). GET /v1/credits is free and needs the key
    # ({"credits": n} on 200). A bad key gets 403 or 422, read as invalid
    # below.
    "Black Forest Labs": ProviderCheck(
        ("BFL_API_KEY",),
        "https://api.bfl.ai/v1/credits",
        lambda key: {"x-key": key},
    ),
    # BytePlus ModelArk (Seedream, Seedance). BytePlus documents no free,
    # read-only data-plane call an API key can make (its management APIs use
    # AK/SK signing on another host), so the key is never probed: a check
    # would mean a paid generation. Status stays configured_unverified.
    "BytePlus": ProviderCheck(
        ("BYTEPLUS_API_KEY",),
        "",
        lambda key: {"Authorization": f"Bearer {key}"},
    ),
    "Higgsfield": ProviderCheck(
        ("HIGGSFIELD_API_KEY",),
        "",
        lambda key: {"Authorization": f"Key {key}"},
    ),
    # The model list is free and checks the key: a live probe (2026-10-14)
    # got 401 for a made-up key and 200 for a real one. System One calls are
    # billed, so health never sends one.
    "TypeSafe": ProviderCheck(
        ("TYPESAFE_API_KEY",),
        "https://api.typesafe.ai/v1/models",
        lambda key: {"Authorization": f"Bearer {key}"},
    ),
    # Authenticated, non-billable balance lookup. A successful response is a
    # CreditsResponse containing remaining_credits; provider health only needs
    # the status code to validate the credential and never starts generation.
    "World Labs": ProviderCheck(
        ("WORLDLABS_API_KEY",),
        "https://api.worldlabs.ai/marble/v1/credits",
        lambda key: {"WLT-Api-Key": key},
    ),
    # Hugging Face access token (the Idol node's Space route needs it). GET
    # /api/whoami-v2 is free and read-only, 200 for a valid token and 401 for
    # a bad one; it never starts a Space or spends quota. Leading and trailing
    # spaces and line breaks are trimmed, as Settings and the handler do; a
    # token with any other character a Hugging Face token can't have is
    # refused before anything is sent, with the Settings field's own line.
    "Hugging Face": ProviderCheck(
        ("HF_TOKEN",),
        "https://huggingface.co/api/whoami-v2",
        lambda key: {"Authorization": f"Bearer {_key_text(key)}"},
        refuse_before_sending=lambda key: hf_token_character_line(key),
    ),
    "Nous": ProviderCheck(
        (),
        "",  # resolved from the Hermes credential's inference base URL
        lambda key: {"Authorization": f"Bearer {key}"},
    ),
}

# provider name -> (monotonic expiry, result dict)
_provider_check_cache: dict[str, tuple[float, dict[str, Any]]] = {}
# Nous is refreshed outside settings.json, so its cached health result is also
# bound to the non-secret credential identity returned by nous_auth. This map
# remains separate to preserve the existing cache tuple contract for every
# other provider.
_provider_check_credential_identity: dict[str, str] = {}

# Cache generation counter, bumped by clear_provider_validation_cache().
# validate_provider_keys() snapshots the generation when it starts; if a clear
# lands while its provider HTTP calls are in flight, the snapshot no longer
# matches and the now-stale results are discarded instead of being cached —
# otherwise a settings save could be followed by pre-save results repopulating
# the cache and being served for up to the TTL.
_provider_cache_generation = 0

# Indirection so tests can drive cache expiry with a fake clock.
_monotonic = time.monotonic


def clear_provider_validation_cache() -> None:
    """Drop all cached validation results (used by tests and key updates)."""
    global _provider_cache_generation
    _provider_check_cache.clear()
    _provider_check_credential_identity.clear()
    _provider_cache_generation += 1


def _utc_now_iso() -> str:
    return datetime.now(timezone.utc).isoformat(timespec="seconds")


# The Settings field's line for a Hugging Face token with a character no
# token has (frontend/src/lib/settingsWrites.ts HF_TOKEN_CHARACTER_LINE, word
# for word). A token is printable ASCII with no space once node_route.key_text
# has trimmed it (handlers/speridlabs_idol.py clean_token reads the same).
HF_TOKEN_CHARACTER_LINE = ("This token has a character Hugging Face tokens can’t have. "
                           "Copy it again from Hugging Face, then paste it here.")
_HF_TOKEN_CHARACTERS = re.compile(r"[\x21-\x7e]+")


def _key_text(key: Any) -> str:
    """The key as every surface reads it (node_route.key_text: trimmed of
    spaces, line breaks and invisible marks; review 7 of PR #203, NIT-4)."""
    from services import node_route

    return node_route.key_text(key)


def hf_token_character_line(key: str) -> str | None:
    """The field's line when the trimmed token can't be sent as it is, or None."""
    return None if _HF_TOKEN_CHARACTERS.fullmatch(_key_text(key)) else HF_TOKEN_CHARACTER_LINE


@dataclass(frozen=True)
class _ResolvedCheck:
    url: str
    headers: dict[str, str]
    credential_identity: str | None = None
    preflight_status: str | None = None
    preflight_configured: bool = False
    preflight_detail: str | None = None


def _resolve_check(name: str, check: ProviderCheck) -> _ResolvedCheck | None:
    """Return the request to make for a provider, or None if unconfigured."""
    if check.key_names:
        key = get_api_key(list(check.key_names))
        if not key:
            return None
        if check.local_validator is not None:
            error = check.local_validator(key)
            return _ResolvedCheck(
                url="",
                headers={},
                preflight_status=(
                    PROVIDER_STATUS_INVALID
                    if error
                    else PROVIDER_STATUS_CONFIGURED_UNVERIFIED
                ),
                preflight_configured=True,
                preflight_detail=error
                or "credential is well-formed; not verified with the provider",
            )
        refused = check.refuse_before_sending(key) if check.refuse_before_sending else None
        if refused:
            return _ResolvedCheck(
                url="",
                headers={},
                preflight_status=PROVIDER_STATUS_INVALID,
                preflight_configured=True,
                preflight_detail=refused,
            )
        return _ResolvedCheck(url=check.url, headers=check.auth_headers(key))

    if name == "Nous":
        # Imported lazily so the patched module attribute is picked up at call
        # time and settings.py stays importable without Hermes present.
        from services.nous_auth import (
            NousCredentialExpiredError,
            NousCredentialInvalidError,
            NousNotAuthenticatedError,
            load_nous_credential,
        )

        try:
            cred = load_nous_credential()
        except NousCredentialExpiredError as exc:
            return _ResolvedCheck(
                url="",
                headers={},
                credential_identity="nous:expired",
                preflight_status=PROVIDER_STATUS_INVALID,
                preflight_configured=True,
                preflight_detail=str(exc),
            )
        except NousCredentialInvalidError as exc:
            return _ResolvedCheck(
                url="",
                headers={},
                credential_identity="nous:invalid",
                preflight_status=PROVIDER_STATUS_INVALID,
                preflight_configured=True,
                preflight_detail=str(exc),
            )
        except NousNotAuthenticatedError:
            return _ResolvedCheck(
                url="",
                headers={},
                credential_identity="nous:not-configured",
                preflight_status=PROVIDER_STATUS_NOT_CONFIGURED,
            )
        except Exception as exc:
            return _ResolvedCheck(
                url="",
                headers={},
                credential_identity="nous:credential-error",
                preflight_status=PROVIDER_STATUS_ERROR,
                preflight_detail=(
                    f"credential lookup failed: {type(exc).__name__}: {exc}"
                )[:200],
            )
        base = cred.base_url.rstrip("/")
        return _ResolvedCheck(
            url=f"{base}/models",
            headers=check.auth_headers(cred.access_token),
            credential_identity=f"nous:{cred.cache_identity}",
        )

    return None


_USE_NORMAL_RESOLUTION = object()


def _probe_error_detail(exc: Exception, headers: dict[str, str]) -> str:
    """Why a probe couldn't be sent, never with the credential in it.

    A key saved with a line break or a space (pasted from a file) can't go in
    a header, and httpx's error then quotes the whole header, key and all;
    this detail reaches the Settings panel and agents (MCP provider_status).
    """
    text = f"{type(exc).__name__}: {exc}"
    if isinstance(exc, (httpx.LocalProtocolError, UnicodeEncodeError)) or _quotes_credential(text, headers):
        return (f"{type(exc).__name__}: the saved key can't be sent as it is (it may hold a line break, "
                "a space or another character a request header can't carry); paste it again in Settings")
    return text[:200]


def _quotes_credential(text: str, headers: dict[str, str]) -> bool:
    """True when `text` holds 8 characters in a row of any header value's words."""
    for value in headers.values():
        for word in str(value).split():
            if len(word) >= 8 and any(word[start:start + 8] in text for start in range(len(word) - 7)):
                return True
    return False


async def _check_one(
    client: httpx.AsyncClient,
    name: str,
    check: ProviderCheck,
    resolved_override: object = _USE_NORMAL_RESOLUTION,
) -> dict[str, Any]:
    """Validate a single provider; never raises."""
    if resolved_override is _USE_NORMAL_RESOLUTION:
        try:
            resolved = _resolve_check(name, check)
        except Exception as exc:  # unexpected credential-store failure
            return {
                "configured": False,
                "status": PROVIDER_STATUS_ERROR,
                "last_checked": _utc_now_iso(),
                "detail": (
                    f"credential lookup failed: {type(exc).__name__}: {exc}"
                )[:200],
            }
    else:
        resolved = resolved_override

    if resolved is None:
        return {
            "configured": False,
            "status": PROVIDER_STATUS_NOT_CONFIGURED,
            "last_checked": _utc_now_iso(),
        }

    if not isinstance(resolved, _ResolvedCheck):
        raise TypeError("resolved provider check has an unexpected type")

    if resolved.preflight_status is not None:
        result: dict[str, Any] = {
            "configured": resolved.preflight_configured,
            "status": resolved.preflight_status,
            "last_checked": _utc_now_iso(),
        }
        if resolved.preflight_detail:
            result["detail"] = resolved.preflight_detail
        return result

    # Higgsfield documents authenticated generation and per-request polling,
    # but no non-billable account/model probe. Presence is still useful health
    # information; do not submit a generation merely to label the key valid.
    if not resolved.url:
        return {
            "configured": True,
            "status": PROVIDER_STATUS_CONFIGURED_UNVERIFIED,
            "last_checked": _utc_now_iso(),
            "detail": "configured; provider exposes no safe validation probe",
        }

    try:
        resp = await client.get(resolved.url, headers=resolved.headers)
    except Exception as exc:  # timeout, DNS, connection refused, ...
        return {
            "configured": True,
            "status": PROVIDER_STATUS_ERROR,
            "last_checked": _utc_now_iso(),
            "detail": _probe_error_detail(exc, resolved.headers),
        }

    result: dict[str, Any] = {
        "configured": True,
        "last_checked": _utc_now_iso(),
    }
    if 200 <= resp.status_code < 300:
        result["status"] = PROVIDER_STATUS_VALID
    elif resp.status_code == 401:
        result["status"] = PROVIDER_STATUS_INVALID
        result["detail"] = f"authentication rejected (HTTP {resp.status_code})"
    elif name == "Black Forest Labs" and resp.status_code in (403, 422):
        # BFL answers a made-up key with 403 "Not authenticated" and a
        # malformed one with 422 "Invalid API key format"; /v1/credits has no
        # other permission to lack, so either one means the key is wrong.
        result["status"] = PROVIDER_STATUS_INVALID
        result["detail"] = f"authentication rejected (HTTP {resp.status_code})"
    elif resp.status_code == 403:
        result["status"] = PROVIDER_STATUS_UNAUTHORIZED
        result["detail"] = "credential is not authorized for the validation endpoint (HTTP 403)"
    elif name == "World Labs" and resp.status_code == 404:
        # The credits endpoint documents 404 when the authenticated caller is
        # not an API-enabled user. The credential was not necessarily malformed,
        # so report the actionable authorization state rather than "invalid".
        result["status"] = PROVIDER_STATUS_UNAUTHORIZED
        result["detail"] = "credential belongs to an account that is not API-enabled (HTTP 404)"
    elif resp.status_code == 402:
        result["status"] = PROVIDER_STATUS_INSUFFICIENT_CREDITS
        result["detail"] = "credential accepted but the account has insufficient credits (HTTP 402)"
    elif resp.status_code == 429:
        result["status"] = PROVIDER_STATUS_RATE_LIMITED
        result["detail"] = "validation request was rate limited (HTTP 429)"
    else:
        result["status"] = PROVIDER_STATUS_ERROR
        result["detail"] = f"unexpected response (HTTP {resp.status_code})"
    return result


async def validate_provider_keys(
    *,
    force_refresh: bool = False,
    ttl_seconds: float = PROVIDER_CHECK_TTL_SECONDS,
) -> dict[str, dict[str, Any]]:
    """Validate every known provider's API key, cached with a TTL.

    Returns {provider: {"configured": bool, "status": str, "last_checked": str}}
    where status distinguishes not configured, configured but safely
    unverified, valid, invalid, unauthorized, insufficient-credit,
    rate-limited, and provider/network errors. Within the
    TTL the cached dict is returned unchanged (identical last_checked); expired
    or forced entries are re-checked with one minimal API call per provider.

    If clear_provider_validation_cache() runs while this call's provider
    requests are in flight (e.g. a concurrent settings save), the freshly
    computed results are still returned to the caller but are NOT written to
    the cache — they predate the clear and would otherwise repopulate it with
    stale status.
    """
    now = _monotonic()
    generation = _provider_cache_generation
    results: dict[str, dict[str, Any]] = {}
    pending: list[str] = []
    resolved_overrides: dict[str, _ResolvedCheck | None] = {}

    for name in PROVIDER_CHECKS:
        credential_identity: str | None = None
        if name == "Nous":
            # Hermes refreshes these files outside Nebula. Resolve the cheap
            # local credential state on every health poll before considering a
            # cached provider response, then bind any cache hit to that state.
            # No provider request is made unless the identity changed or the
            # ordinary TTL expired.
            resolved = _resolve_check(name, PROVIDER_CHECKS[name])
            resolved_overrides[name] = resolved
            credential_identity = (
                resolved.credential_identity if resolved is not None else None
            )

        if not force_refresh:
            cached = _provider_check_cache.get(name)
            if cached is not None and cached[0] > now:
                if (
                    name == "Nous"
                    and _provider_check_credential_identity.get(name)
                    != credential_identity
                ):
                    _provider_check_cache.pop(name, None)
                    _provider_check_credential_identity.pop(name, None)
                else:
                    results[name] = cached[1]
                    continue
        pending.append(name)

    if pending:
        async with httpx.AsyncClient(timeout=PROVIDER_CHECK_TIMEOUT_SECONDS) as client:
            checked = await asyncio.gather(
                *(
                    _check_one(
                        client,
                        name,
                        PROVIDER_CHECKS[name],
                        resolved_overrides.get(name, _USE_NORMAL_RESOLUTION),
                    )
                    for name in pending
                )
            )
        cache_current = _provider_cache_generation == generation
        for name, result in zip(pending, checked):
            if cache_current:
                _provider_check_cache[name] = (now + ttl_seconds, result)
                if name == "Nous":
                    resolved = resolved_overrides.get(name)
                    if resolved is not None and resolved.credential_identity is not None:
                        _provider_check_credential_identity[name] = (
                            resolved.credential_identity
                        )
            results[name] = result

    return results
