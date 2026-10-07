"""Validate the local PNG returned by Paper's native export tool.

This boundary reads one exported image only. Paper-specific format checks
compose with the application's protected-store and workspace path policy.
"""
from __future__ import annotations

import os
from pathlib import Path
import stat
import unicodedata

from services.file_access import require_allowed_path as require_media_path


PNG_SIGNATURE = b"\x89PNG\r\n\x1a\n"
MAX_PAPER_EXPORT_BYTES = 32 * 1024 * 1024


def _comparison_path(path: Path) -> Path:
    # Conservatively reject case and Unicode aliases on macOS volumes.
    return Path(unicodedata.normalize("NFD", str(path)).casefold())


def _protected_roots() -> list[Path]:
    home = Path.home()
    roots = [home / name for name in (".codex", ".claude", ".ssh", ".aws", ".config", ".nebula")]
    roots.append(Path(os.environ.get("NEBULA_STATE_DIR", home / ".nebula")))
    return roots


def require_allowed_path(value: str | Path) -> Path:
    """Accept an absolute, regular PNG export; reject protected files/aliases.

    System path aliases such as /var → /private/var remain usable for Paper
    temporary exports. Both lexical and resolved names are checked; final
    symlinks and multiply-linked files are rejected. PaperSources separately
    decodes the returned PNG and checks its immutable artwork attribution.
    """
    raw = str(value)
    if not raw or any(ord(character) < 32 for character in raw):
        raise ValueError("Invalid Paper export path")
    lexical = Path(raw)
    if not lexical.is_absolute() or lexical.suffix.lower() != ".png" or lexical.is_symlink():
        raise ValueError("Paper export must be an absolute PNG file")
    resolved = lexical.resolve(strict=True)
    names = [_comparison_path(Path(os.path.abspath(lexical))), _comparison_path(resolved)]
    if resolved.suffix.lower() != ".png":
        raise ValueError("Paper export must resolve to a PNG file")
    for root in [Path("/dev"), Path("/proc"), Path("/sys"), Path("/.vol"), *_protected_roots()]:
        protected = [_comparison_path(Path(os.path.abspath(root.expanduser()))), _comparison_path(root.expanduser().resolve())]
        if any(candidate == denied or candidate.is_relative_to(denied) for candidate in names for denied in protected):
            raise ValueError("Protected storage cannot be used as a Paper export")
    settings = os.environ.get("NEBULA_SETTINGS_PATH")
    if settings and _comparison_path(Path(settings).expanduser().resolve()) in names:
        raise ValueError("Settings cannot be used as a Paper export")
    info = resolved.stat()
    if not stat.S_ISREG(info.st_mode) or info.st_nlink != 1:
        raise ValueError("Paper export must be a standalone regular file")
    if info.st_size > MAX_PAPER_EXPORT_BYTES:
        raise ValueError("Paper export exceeds 32 MiB")
    # Custom Commons roots and authenticated peer workspaces can live outside
    # Paper's historical state/secret namespaces. Check them before opening PNG.
    resolved = require_media_path(lexical)
    with resolved.open("rb") as stream:
        if stream.read(len(PNG_SIGNATURE)) != PNG_SIGNATURE:
            raise ValueError("Paper export is not a PNG image")
    return resolved
