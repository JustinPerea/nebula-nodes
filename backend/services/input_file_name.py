"""The name a person or agent gave a file an input node holds.

/api/uploads stores a file under its content hash ("3fa9...e1.pdf"), which
says nothing on a card. A node it creates keeps the original name in the
private param `_fileName` = {"file": <basename of filePath>, "name": <name>}.
The pair names the stored file, not the node: when filePath later points at
another file (edit_canvas, a script), the old name is not shown. The canvas
reads it the same way (frontend/src/lib/fileName.ts).
"""
from __future__ import annotations

import re
from typing import Any, Mapping

PARAM = "_fileName"
# A name longer than this is cut: it is display text, never a path.
MAX_NAME_CHARS = 255


def _basename(path: str) -> str:
    return re.split(r"[\\/]", path)[-1]


def file_name_param(file_path: str, name: str | None) -> dict[str, str] | None:
    """The `_fileName` value for `file_path` called `name` (only its last
    part: a sent "C:\\me\\a.pdf" or "../a.pdf" is "a.pdf"), or None."""
    shown = _basename(name or "").strip()[:MAX_NAME_CHARS]
    if not shown or shown in (".", ".."):
        return None
    return {"file": _basename(file_path), "name": shown}


def input_file_name(params: Mapping[str, Any]) -> str | None:
    """The kept name of the file `params["filePath"]` holds, or None."""
    file_path = params.get("filePath")
    kept = params.get(PARAM)
    if not isinstance(file_path, str) or not file_path or not isinstance(kept, Mapping):
        return None
    name = kept.get("name")
    if kept.get("file") != _basename(file_path) or not isinstance(name, str) or not name:
        return None
    return name
