"""Add a local image, clip, sound or document to Nebula: the client side of
MCP `upload_file` and `nebula upload`.

Nebula's spending check prices a node from its input's size only when that
input is a file in Nebula's output folder (or an inline image): a file
anywhere else could change between the check and the run
(services/input_sizes.py). This puts a copy there. It reads the file with
this process's permissions (`require_allowed_path`; with an in-app chat's
turn token, only files in that turn's workspace), checks again when it
opens the file and follows no links on the way (moodboard_client's
`_open_no_follow`), and sends the bytes through `POST /api/uploads`, the
route the canvas's own upload uses. That route checks the bytes (PNG, JPEG,
GIF, WebP, MP4, MOV, WebM, WAV, MP3, M4A, AAC, FLAC, Ogg, PDF or text; 20 MB
for an image or document, 500 MB for a clip or sound), stores them under
their sha256 and puts an Image Input, Video Input, Audio Input or Document
Input holding the copy on the canvas, at `position` when one is given.

Nothing here runs in the backend.
"""
from __future__ import annotations

import errno
import math
import os
import stat
from pathlib import Path
from typing import Any
from urllib.parse import unquote, urlsplit

from nebula_api import NebulaAPI, NebulaAPIError

# /api/uploads' own cap (main.MAX_VIDEO_UPLOAD_BYTES): nothing larger is sent.
MAX_UPLOAD_BYTES = 500 * 1024 * 1024
_KINDS = {"image-input": "Image", "video-input": "Video", "audio-input": "Audio", "document-input": "Document"}


class UploadError(RuntimeError):
    """A file that wasn't added, in words an agent can act on."""


def _local_path(source: str, *, error: type[Exception] = UploadError) -> Path:
    """The local file `source` names, under `nebula upload`'s rules, which
    `nebula load` shares (graph_file_client.py): refused with `error`."""
    from services.agent_workspaces import active_workspace
    from services.file_access import ProtectedPathError, require_allowed_path

    if not isinstance(source, str) or not source.strip():
        raise error("Name a local file to add")
    if source.startswith(("http://", "https://", "data:")):
        raise error(f"{source[:80]}: not a local file. Download it first, then add the local copy.")
    workspace = active_workspace()
    raw = source
    if raw.lower().startswith("file:"):
        parts = urlsplit(raw)
        if parts.netloc not in ("", "localhost") or parts.query or parts.fragment:
            raise error(f"{source}: not a local file link")
        raw = unquote(parts.path)
    path = Path(raw).expanduser()
    if workspace is not None and not path.is_absolute():
        # An in-app agent's relative path means its workspace, not this process's cwd.
        path = workspace / path
    try:
        resolved = require_allowed_path(path)
    except ProtectedPathError as exc:
        raise error(f"{source}: {exc}") from exc
    if workspace is not None and not resolved.is_relative_to(workspace.resolve()):
        # Same rule as Commons and moodboards: a chat's turn reads only its own files.
        raise error(f"{source}: outside this chat's workspace. Copy the file there first.")
    return resolved


def _read(path: Path, shown: str) -> bytes:
    from moodboard_client import _open_no_follow

    # Checked again at read time, on the path as it resolves now.
    path = _local_path(str(path))
    try:
        descriptor = _open_no_follow(path)
    except OSError as exc:
        if exc.errno in (errno.ELOOP, errno.ENOTDIR):
            raise UploadError(f"{shown}: the file changed while it was being read (a link took its place). "
                              "Add it again.") from exc
        raise UploadError(f"{shown}: can't read the file ({exc.strerror})") from exc
    with os.fdopen(descriptor, "rb") as handle:
        info = os.fstat(handle.fileno())
        if not stat.S_ISREG(info.st_mode):
            raise UploadError(f"{shown}: not a file")
        if info.st_size > MAX_UPLOAD_BYTES:
            raise UploadError(f"{shown}: over Nebula's 500 MB upload limit")
        data = handle.read(MAX_UPLOAD_BYTES + 1)
    if len(data) > MAX_UPLOAD_BYTES:
        raise UploadError(f"{shown}: over Nebula's 500 MB upload limit")
    return data


def _position_fields(position: Any) -> dict[str, str]:
    """The /api/uploads form fields for `position` ({x, y}, finite numbers),
    or none for no position. Refused here, before the file is read."""
    if position is None:
        return {}
    if not isinstance(position, dict) or set(position) != {"x", "y"}:
        raise UploadError('position must be {"x": <number>, "y": <number>}, or left out')
    spot = []
    for axis in ("x", "y"):
        value = position[axis]
        if isinstance(value, bool) or not isinstance(value, (int, float)) or not math.isfinite(value):
            raise UploadError(f"position {axis} must be a finite number")
        spot.append(repr(float(value)))
    return {"x": spot[0], "y": spot[1]}


def upload(api: NebulaAPI, source: str, *, headers: dict[str, str] | None = None,
           position: dict[str, float] | None = None) -> dict[str, Any]:
    """Copy a local file into Nebula's output folder with an input node
    holding it on the canvas, at `position` ({x, y} in canvas coordinates)
    or, without one, right of the other nodes. Returns {nodeId, kind (Image,
    Video, Audio or Document), url (/api/outputs/...), filePath, filename}."""
    fields = _position_fields(position)
    path = _local_path(source)
    data = _read(path, source)
    try:
        result = api.request("POST", "/api/uploads", headers=headers, timeout=300.0,
                             files={"file": (path.name, data)}, data={"create_node": "true", **fields})
    except NebulaAPIError as exc:
        raise UploadError(f"{source}: {exc.detail}") from exc
    if not isinstance(result, dict) or not result.get("url"):
        raise UploadError(f"{source}: Nebula didn't say where it stored the file")
    return {"nodeId": result.get("nodeId"), "kind": _KINDS.get(str(result.get("nodeType") or ""), "File"),
            "url": result["url"], "filePath": result.get("filePath"),
            "filename": result.get("filename") or path.name}
