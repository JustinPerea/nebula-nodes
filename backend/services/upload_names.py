"""The name a file param shows (GM r48 Q1 on #222), and the record of the
names files were uploaded with.

/api/uploads stores a file under its content hash ("3fa9…e1.png"), which
says nothing to a person or an agent. Each upload now records the name it
was sent with, keyed by that stored name, in a small index beside the
content-hash store (``upload-names.json`` in Nebula's state folder). The
same bytes sent again under another name record the newer name.

A file param's name, everywhere it shows (the Inspector row, the node face,
the dropped-upload line, the in-flight row, and agents' look_at_canvas and
get_project), is, in order:

1. the name the file was uploaded with: the node's own ``_fileName`` for
   ``filePath`` (services/input_file_name.py), else this index;
2. otherwise the path's base name;
3. a base name that is a bare content hash is never shown: "Uploaded file".

frontend/src/lib/fileName.ts ``fileParamName`` is the same rule; the
frontend reads this index through GET /api/uploads/names. A test keeps the
hash pattern and the label equal on both sides.
"""
from __future__ import annotations

import json
import os
import re
import threading
from pathlib import Path
from typing import Any, Iterable, Mapping

from services.input_file_name import MAX_NAME_CHARS, input_file_name

# A bare content hash, with or without an extension (frontend/src/lib/fileName.ts
# CONTENT_HASH_NAME is the same pattern).
CONTENT_HASH_NAME = re.compile(r"^[0-9a-f]{32,}(\.[a-z0-9]{1,8})?$", re.IGNORECASE)
UPLOADED_FILE = "Uploaded file"
# The index keeps the newest names; an old upload past this shows its base
# name rule (a hash: "Uploaded file").
MAX_RECORDS = 5000

_lock = threading.Lock()
_path: Path | None = None
_names: dict[str, str] | None = None


def _basename(path: str) -> str:
    return re.split(r"[\\/]", path)[-1]


def is_content_hash_name(name: str) -> bool:
    return bool(CONTENT_HASH_NAME.match(name))


def shown_file_name(name: str) -> str:
    """``name`` as a person or agent sees it: never a bare content hash."""
    return UPLOADED_FILE if is_content_hash_name(name) else name


def configure(path: Path | None) -> None:
    """Where the index lives (main.py: the state folder)."""
    global _path, _names
    with _lock:
        _path = path
        _names = None


def forget_for_tests() -> None:
    """Each test starts with an empty index (tests/conftest.py)."""
    global _names
    with _lock:
        _names = {}
        if _path is not None:
            try:
                _path.unlink()
            except OSError:
                pass


def _load() -> dict[str, str]:
    global _names
    if _names is None:
        loaded: dict[str, str] = {}
        if _path is not None:
            try:
                raw = json.loads(_path.read_text(encoding="utf-8"))
                if isinstance(raw, dict) and isinstance(raw.get("names"), dict):
                    loaded = {str(k): v for k, v in raw["names"].items() if isinstance(v, str) and v}
            except (OSError, ValueError):
                loaded = {}
        _names = loaded
    return _names


def _save(names: dict[str, str]) -> None:
    if _path is None:
        return
    _path.parent.mkdir(parents=True, exist_ok=True)
    tmp = _path.with_name(_path.name + ".tmp")
    with open(tmp, "w", encoding="utf-8") as handle:
        json.dump({"names": names}, handle, ensure_ascii=False)
    os.replace(tmp, _path)


def record(stored: str, name: str | None) -> None:
    """The file stored as ``stored`` (its path or name) was sent as ``name``.
    Only the sent name's last part is kept; a name that is itself a bare
    hash, or the stored name, records nothing."""
    key = _basename(stored)
    shown = _basename(name or "").strip()[:MAX_NAME_CHARS]
    if not key or not shown or shown in (".", "..") or shown == key or is_content_hash_name(shown):
        return
    with _lock:
        names = _load()
        if names.get(key) == shown:
            return
        names.pop(key, None)
        names[key] = shown
        while len(names) > MAX_RECORDS:
            names.pop(next(iter(names)))
        try:
            _save(names)
        except OSError:
            pass  # the name is display text: the upload itself stands


def recorded_name(path: str) -> str | None:
    """The name the file at ``path`` (by its stored name) was uploaded with."""
    key = _basename(path)
    if not key:
        return None
    with _lock:
        return _load().get(key)


def recorded_names(paths: Iterable[str]) -> dict[str, str]:
    """{stored name: uploaded name} for those of ``paths`` the index holds."""
    with _lock:
        names = _load()
        out: dict[str, str] = {}
        for path in paths:
            key = _basename(path)
            if key in names:
                out[key] = names[key]
        return out


def file_param_name(params: Mapping[str, Any], key: str) -> str | None:
    """The name the file param ``key`` shows, or None when it holds no file."""
    value = params.get(key)
    if not isinstance(value, str) or not value:
        return None
    kept = input_file_name(params) if key == "filePath" else None
    return shown_file_name(kept or recorded_name(value) or _basename(value) or value)
