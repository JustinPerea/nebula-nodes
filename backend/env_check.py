"""Startup environment sanitization for the Nebula backend.

Imported at the very top of ``main.py`` — before fastapi/pydantic — so an
inherited ``PYTHONPATH`` pointing at another Python version's site-packages
(e.g. Hermes exporting Python 3.11 paths while Nebula runs under 3.12) is
cleaned before it can break ``pydantic_core`` at import time.

Two jobs:

1. ``sanitize_pythonpath()`` — strip PYTHONPATH entries that positively
   target a different CPython: either a ``pythonX.Y`` path segment that
   doesn't match the running interpreter, or native compiled extensions
   (``*.cpython-XY-*`` with a ``.so``/``.pyd``/``.dylib`` suffix) tagged
   for a different ABI. The extension scan walks each entry's directory
   tree down to a bounded depth (4 levels), so nested package layouts such
   as ``site-packages/numpy/core/_multiarray_umath.cpython-311-*.so`` are
   detected. Bytecode caches (``*.cpython-XY.pyc``) carry the same tag but
   are not native code — a mismatched interpreter just ignores them — so
   they never mark an entry incompatible. Stripped entries are also
   evicted from ``sys.path`` (the interpreter already copied PYTHONPATH
   there at startup) and a warning lists what was removed.
2. ``verify_runtime()`` — fail fast with a clear message when
   ``sys.version_info`` is below the minimum or ``sys.executable`` is
   missing/invalid.

Only stdlib is imported here — this module must stay import-safe before any
third-party package is resolvable.
"""
from __future__ import annotations

import logging
import os
import re
import sys
from collections.abc import Iterator
from pathlib import Path
from typing import MutableMapping

logger = logging.getLogger("nebula.env_check")

MIN_PYTHON = (3, 12)

# How far below a PYTHONPATH entry the compiled-extension scan descends.
# Depth 1 = files directly inside the entry; depth 4 covers common nested
# package layouts (e.g. site-packages/numpy/core/_multiarray_umath.*.so is
# depth 3) without walking huge site-packages trees unboundedly.
_MAX_EXTENSION_SCAN_DEPTH = 4

# Versioned interpreter segments: POSIX "python3.11" and Windows "Python311".
_VERSION_DOT_RE = re.compile(r"python(\d+)\.(\d+)", re.IGNORECASE)
_VERSION_NODOT_RE = re.compile(r"python(\d)(\d{1,2})(?![\d.])", re.IGNORECASE)
# Compiled-extension ABI tag, e.g. _pydantic_core.cpython-311-darwin.so
_ABI_TAG_RE = re.compile(r"cpython-(\d)(\d{1,2})", re.IGNORECASE)
# Only native-library suffixes can break extension-module imports across
# CPython versions. Bytecode (*.cpython-XY.pyc) carries the same ABI tag
# but is safely ignored by a mismatched interpreter, so it must not mark a
# PYTHONPATH entry incompatible.
_NATIVE_EXTENSION_SUFFIXES = (".so", ".pyd", ".dylib")

__all__ = [
    "MIN_PYTHON",
    "sanitize_pythonpath",
    "verify_runtime",
    "run_startup_checks",
]


def _iter_compiled_artifacts(
    root: Path, max_depth: int = _MAX_EXTENSION_SCAN_DEPTH
) -> Iterator[Path]:
    """Yield native libraries under ``root`` whose names carry a CPython ABI
    tag (``*.cpython-*`` with a ``.so``/``.pyd``/``.dylib`` suffix),
    walking at most ``max_depth`` levels below ``root``.

    Bytecode files (``*.cpython-XY.pyc``) are deliberately excluded: they
    are not native code and a mismatched interpreter ignores them, so they
    are no evidence of incompatibility.

    Depth 1 is files directly inside ``root``. The walk is bounded — it
    never descends into directories at ``max_depth`` or deeper — and does
    not follow symlinked directories, so a huge or cyclic tree cannot turn
    startup sanitization into an unbounded scan. Unreadable directories
    yield nothing (no evidence of incompatibility).
    """
    stack: list[tuple[Path, int]] = [(root, 0)]
    while stack:
        directory, depth = stack.pop()
        try:
            with os.scandir(directory) as it:
                entries = list(it)
        except OSError:
            continue  # unreadable → no evidence from this subtree
        for item in entries:
            try:
                if item.is_dir(follow_symlinks=False):
                    if depth + 1 < max_depth:
                        stack.append((Path(item.path), depth + 1))
                elif ".cpython-" in item.name and item.name.endswith(
                    _NATIVE_EXTENSION_SUFFIXES
                ):
                    yield Path(item.path)
            except OSError:
                continue


def _incompatibility_reason(entry: str, version: tuple[int, int]) -> str | None:
    """Return why ``entry`` is incompatible with the running interpreter,
    or ``None`` when there is no positive evidence of incompatibility."""
    for match in _VERSION_DOT_RE.finditer(entry):
        major, minor = int(match.group(1)), int(match.group(2))
        if (major, minor) != version:
            return (
                f"targets Python {major}.{minor} "
                f"(running {version[0]}.{version[1]})"
            )
    for match in _VERSION_NODOT_RE.finditer(entry):
        major, minor = int(match.group(1)), int(match.group(2))
        if (major, minor) != version:
            return (
                f"targets Python {major}.{minor} "
                f"(running {version[0]}.{version[1]})"
            )
    if not entry:
        return None
    path = Path(entry)
    try:
        if not path.is_dir():
            return None
    except OSError:
        return None  # unreadable → no evidence, leave it alone
    for candidate in _iter_compiled_artifacts(path):
        tag = _ABI_TAG_RE.search(candidate.name)
        if tag is None:
            continue
        major, minor = int(tag.group(1)), int(tag.group(2))
        if (major, minor) != version:
            return (
                f"contains {candidate.name} built for CPython {major}.{minor} "
                f"(running {version[0]}.{version[1]})"
            )
    return None


def sanitize_pythonpath(
    environ: MutableMapping[str, str] | None = None,
    version: tuple[int, int] | None = None,
    sys_path: list[str] | None = None,
    log: logging.Logger | None = None,
) -> list[str]:
    """Strip PYTHONPATH entries incompatible with the running interpreter.

    Mutates ``environ`` (default ``os.environ``) in place; when operating on
    the real environment, matching entries are also removed from
    ``sys.path``. Returns the stripped entries (empty list when PYTHONPATH
    is clean or absent).
    """
    if environ is None:
        environ = os.environ
    if version is None:
        version = (sys.version_info.major, sys.version_info.minor)
    if log is None:
        log = logger
    # Only touch the real sys.path when sanitizing the real environment.
    if sys_path is None and environ is os.environ:
        sys_path = sys.path

    raw = environ.get("PYTHONPATH")
    if not raw:
        return []

    entries = raw.split(os.pathsep)
    kept: list[str] = []
    stripped: list[str] = []
    reasons: list[str] = []
    for entry in entries:
        reason = _incompatibility_reason(entry, version)
        if reason is None:
            kept.append(entry)
        else:
            stripped.append(entry)
            reasons.append(f"{entry} ({reason})")

    if not stripped:
        return []

    if kept:
        environ["PYTHONPATH"] = os.pathsep.join(kept)
    else:
        environ.pop("PYTHONPATH", None)

    if sys_path is not None:
        doomed = {os.path.normpath(os.path.abspath(p)) for p in stripped}
        sys_path[:] = [
            p for p in sys_path
            if os.path.normpath(os.path.abspath(p or os.curdir)) not in doomed
        ]

    log.warning(
        "PYTHONPATH sanitization stripped %d incompatible path(s) before "
        "startup imports: %s",
        len(stripped),
        "; ".join(reasons),
    )
    return stripped


def verify_runtime(
    min_version: tuple[int, int] = MIN_PYTHON,
    version: tuple[int, ...] | None = None,
    executable: str | None = None,
    log: logging.Logger | None = None,
) -> None:
    """Fail fast (SystemExit) unless the interpreter meets requirements."""
    if version is None:
        version = tuple(sys.version_info[:3])
    if executable is None:
        executable = sys.executable
    if log is None:
        log = logger

    if tuple(version[:2]) < min_version:
        raise SystemExit(
            f"Nebula backend requires Python {min_version[0]}.{min_version[1]}+; "
            f"running {'.'.join(str(p) for p in version[:3])} via {executable}"
        )
    if not executable or not Path(executable).exists():
        raise SystemExit(
            f"sys.executable is missing or does not exist: {executable!r}"
        )
    log.info(
        "runtime check OK: Python %s at %s",
        ".".join(str(p) for p in version[:3]),
        executable,
    )


def run_startup_checks() -> None:
    """Entry point called from the top of main.py, before other imports."""
    verify_runtime()
    sanitize_pythonpath()
