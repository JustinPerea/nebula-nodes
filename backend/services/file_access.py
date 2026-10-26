"""Protected-file exclusion for general graph and media operations.

Commons has its own authenticated, brand-scoped blob API. General file features
must never substitute for that API. Store and credential exclusions apply to
humans and agents alike. Private workspace access additionally requires the
current conversation capability verified by the backend.

This is an application path check, not a sandbox for arbitrary native code or
filesystem mutation between a check and an open. Decoder-specific secondary
resource checks belong at the decoder boundary.
"""
from __future__ import annotations

import os
import stat
import unicodedata
from pathlib import Path
from typing import Any
from urllib.parse import unquote, urlsplit

from services.input_file_name import PARAM as KEPT_NAME_PARAM


class ProtectedPathError(ValueError):
    """A general file operation attempted to bypass protected storage."""


def _comparison_path(path: Path) -> Path:
    # macOS volumes commonly alias case and Unicode normalization. Conservatively
    # reserve those spellings on every volume, including not-yet-created paths.
    return Path(unicodedata.normalize("NFD", str(path)).casefold())


def _identity_contains(candidate: Path, protected: Path) -> bool:
    """Cover mount/firmlink aliases, including nonexistent protected children."""
    anchor = protected
    tail: list[str] = []
    while True:
        try:
            info = anchor.stat()
            break
        except (FileNotFoundError, NotADirectoryError):
            if anchor == anchor.parent:
                return False
            tail.insert(0, _comparison_path(Path(anchor.name)).name)
            anchor = anchor.parent
    for ancestor in (candidate, *candidate.parents):
        try:
            other = ancestor.stat()
        except (FileNotFoundError, NotADirectoryError):
            continue
        if (other.st_dev, other.st_ino) == (info.st_dev, info.st_ino):
            remaining = _comparison_path(candidate.relative_to(ancestor)).parts
            return tuple(remaining[:len(tail)]) == tuple(tail)
    return False


def access_scope() -> str:
    """What ``require_allowed_path``'s answer depends on besides the path and
    the file: the active agent workspace ("" for none). Code that keeps an
    answer for a file (services/moodboard_layout.file_aspect) keys it on this."""
    from services.agent_workspaces import active_workspace

    return str(active_workspace() or "")


def require_allowed_path(value: str | Path) -> Path:
    """Return a canonical path, rejecting protected names and file aliases.

    Multi-link regular files are refused: resolving a pathname cannot establish
    that another hard link is not inside the protected store. No store inventory
    or file contents are read to make this decision. Copy a normal reference to
    a standalone file before importing it if it has multiple hard links.
    """
    from services.agent_profiles import default_secret_paths, protected_agent_dirs
    from services.agent_workspaces import active_workspace, workspace_deny_roots

    raw = str(value)
    if raw.lower().startswith("file:"):
        uri = urlsplit(raw)
        if uri.netloc not in {"", "localhost"} or uri.query or uri.fragment:
            raise ProtectedPathError("Unsupported local file reference")
        raw = unquote(uri.path)
    path = Path(raw).expanduser()
    lexical = Path(os.path.abspath(path))
    resolved = path.resolve()
    for candidate in map(_comparison_path, (lexical, resolved)):
        if any(candidate == root or candidate.is_relative_to(root)
               for root in (Path("/dev"), Path("/proc"), Path("/sys"), Path("/.vol"))):
            raise ProtectedPathError("Protected file aliases and device paths cannot be used through graph or media operations")
    for protected in [*protected_agent_dirs(), *default_secret_paths()]:
        roots = (Path(os.path.abspath(protected.expanduser())), protected.expanduser().resolve())
        if any(candidate == root or candidate.is_relative_to(root)
               for candidate in map(_comparison_path, (lexical, resolved))
               for root in map(_comparison_path, roots)):
            raise ProtectedPathError("Protected file access is not allowed through graph or media operations; use the scoped Commons API for references")
        if _identity_contains(resolved, protected.expanduser().resolve()):
            raise ProtectedPathError("Protected file identity cannot be used through graph or media operations")
    current = active_workspace()
    for root in workspace_deny_roots(current):
        roots = (Path(os.path.abspath(root)), root.resolve())
        lexical_inside = any(_comparison_path(lexical).is_relative_to(_comparison_path(item)) for item in roots)
        resolved_inside = any(_comparison_path(resolved).is_relative_to(_comparison_path(item)) for item in roots)
        if lexical_inside or resolved_inside or _identity_contains(resolved, root.resolve()):
            permitted = current is not None and (
                _comparison_path(resolved).is_relative_to(_comparison_path(current))
                or _identity_contains(resolved, current)
            )
            if lexical_inside and current is not None:
                permitted = permitted and _comparison_path(lexical).is_relative_to(_comparison_path(current))
            if not permitted:
                raise ProtectedPathError("Private agent workspace belongs to a different chat or has no authenticated session")
    try:
        info = resolved.stat()
    except FileNotFoundError:
        return resolved
    if stat.S_ISREG(info.st_mode) and info.st_nlink > 1:
        raise ProtectedPathError("Protected file alias check: files with multiple hard links cannot be used through graph or media operations")
    return resolved


def validate_file_references(value: Any) -> None:
    """Check nested graph values before dispatch, cache use, or asset copying.

    Graph ports permit Any and dynamic parameter names, so do not trust declared
    media types or a fixed filePath-key list. Strings remain unchanged: prose,
    provider handles and remote/data references are not converted into paths.

    Each distinct reference is checked once per call. A project snapshot
    repeats the same labels, ids and output paths in every run record (2,505
    strings, 125 distinct, in a 40-node project), and each check stats the
    protected roots, so checking repeats made one autosave take 10-35 s.
    """
    seen: set[str] = set()
    stack: list[Any] = [value]
    while stack:
        current = stack.pop()
        if isinstance(current, dict):
            # An upload's kept name (`_fileName`) is text for its card to show,
            # never read as a file: a name like a protected file's must not
            # make the node unrunnable. Its stored file's own path is still
            # checked where it sits (filePath).
            stack.extend(item for key, item in current.items() if key != KEPT_NAME_PARAM)
        elif isinstance(current, (list, tuple)):
            stack.extend(current)
        elif isinstance(current, str) and current:
            reference = _path_reference(current)
            if reference is None or reference in seen:
                continue
            seen.add(reference)
            try:
                require_allowed_path(reference)
            except ProtectedPathError:
                raise
            except (OSError, RuntimeError, ValueError):
                # Prose may contain ~, NUL or exceed pathname limits. Final file
                # consumers still use the strict guard after their own conversion.
                continue


def _path_reference(value: str) -> str | None:
    """The local path a graph string may stand for, or None for one that can't be a file."""
    if value.startswith("data:"):
        return None
    if value.startswith(("http://", "https://")):
        # Some provider adapters map served output URLs directly to disk.
        # Apply the same checks regardless of their hostname spelling.
        try:
            remote_path = urlsplit(value).path
        except ValueError:
            return None  # Plain text can contain an illustrative, invalid URL.
        if not remote_path.startswith("/api/outputs/"):
            return None
        value = remote_path
    if value.startswith("/api/outputs/"):
        from services.output import OUTPUT_ROOT
        value = str(OUTPUT_ROOT / unquote(value[len("/api/outputs/"):]))
    return value
