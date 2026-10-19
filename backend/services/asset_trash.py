"""Recently deleted, for saved moodboards and characters.

Deleting a board or a character used to unlink its JSON file, so a delete
(an agent may delete one, design-canvas answer D5) could not be undone. Now a
delete moves the file, untouched, into the store's trash folder and writes a
small record beside it saying who deleted it and when:

    <store root>/.trash/<id>.json        the asset, byte for byte as it was
    <store root>/.trash/<id>.trash.json  {kind, id, name, thumbnail, projectId,
                                          scopeDir, deletedAt, deletedBy}

Restore moves the file back to the folder it came from (``scopeDir``), so the
asset comes back with the same id and contents, and a node that points at it
works again. Deleting for good removes both files; only the person may do
that (main.py checks the person gate).

``.trash`` can't clash with a scope folder: project ids never start with a
dot, and the stores skip dot folders when they look an id up.

Nothing is purged on a timer. Items stay until the person deletes them for
good or empties the trash (a choice recorded in implementation-notes.md that
Justin can change).

Crash safety: delete writes the record first and then moves the file;
restore moves the file back first and then drops the record. A record
without its file is ignored (and replaced on the next delete), so a crash
in between never shows a trashed asset that isn't there.
"""
from __future__ import annotations

import json
import os
import re
from datetime import datetime, timezone
from pathlib import Path
from typing import Any, Mapping

TRASH_DIR = ".trash"
RECORD_SUFFIX = ".trash.json"
_ID_RE = re.compile(r"^[A-Za-z0-9_-]{1,64}$")


class AlreadyLive(Exception):
    """Restore found a live asset with the same id; nothing was moved."""


def validate_id(asset_id: str) -> str:
    """A board or character id (the stores' own id shape); ValueError otherwise."""
    if not isinstance(asset_id, str) or not _ID_RE.fullmatch(asset_id):
        raise ValueError(f"invalid id: {asset_id!r}")
    return asset_id



def trash_dir(root: Path) -> Path:
    return root / TRASH_DIR


def _now_iso() -> str:
    return datetime.now(timezone.utc).isoformat()


def _deleted_by(record: Mapping[str, Any] | None) -> dict[str, str]:
    """Keep only ``{kind, name}`` (services/canvas_events.actor_record makes
    it). A caller that says nothing is an unnamed client."""
    record = record or {}
    kind = str(record.get("kind") or "anonymous")[:16]
    name = str(record.get("name") or "Unnamed client")[:64]
    return {"kind": kind, "name": name}


def _write_json(path: Path, data: dict[str, Any]) -> None:
    tmp = path.with_name(path.name + ".tmp")
    tmp.write_text(json.dumps(data, ensure_ascii=False, indent=2), encoding="utf-8")
    tmp.replace(path)


def move_to_trash(root: Path, live_path: Path, *, kind: str,
                  deleted_by: Mapping[str, Any] | None) -> dict[str, Any]:
    """Move ``live_path`` (``<root>/<scope>/<id>.json``) into the trash and
    return its record. The file itself is moved, not rewritten.
    ``deleted_by`` is ``{kind, name}`` from canvas_events.actor_record."""
    asset_id = validate_id(live_path.stem)
    asset = json.loads(live_path.read_text(encoding="utf-8"))
    folder = trash_dir(root)
    folder.mkdir(parents=True, exist_ok=True)
    record = {
        "kind": kind,
        "id": asset_id,
        "name": str(asset.get("name") or ""),
        "thumbnail": str(asset.get("thumbnail") or ""),
        "projectId": asset.get("projectId"),
        "scopeDir": live_path.parent.name,
        "deletedAt": _now_iso(),
        "deletedBy": _deleted_by(deleted_by),
    }
    _write_json(folder / f"{asset_id}{RECORD_SUFFIX}", record)
    os.replace(live_path, folder / f"{asset_id}.json")
    return record


def trashed(root: Path, asset_id: str) -> dict[str, Any] | None:
    """The trash record for ``asset_id``, or None when it isn't in the trash."""
    validate_id(asset_id)
    folder = trash_dir(root)
    record_path = folder / f"{asset_id}{RECORD_SUFFIX}"
    if not record_path.is_file() or not (folder / f"{asset_id}.json").is_file():
        return None
    try:
        record = json.loads(record_path.read_text(encoding="utf-8"))
    except (json.JSONDecodeError, OSError):
        return None
    return record if isinstance(record, dict) else None


def list_trashed(root: Path, *, project_id: str | None = None, scope: str | None = None) -> list[dict[str, Any]]:
    """Records in the trash, newest first. ``scope='global'`` keeps global
    assets, ``scope='project'`` with ``project_id`` keeps that project's;
    no scope keeps everything."""
    folder = trash_dir(root)
    if not folder.is_dir():
        return []
    results: list[dict[str, Any]] = []
    for path in folder.glob(f"*{RECORD_SUFFIX}"):
        asset_id = path.name[: -len(RECORD_SUFFIX)]
        if not _ID_RE.fullmatch(asset_id):
            continue
        record = trashed(root, asset_id)
        if record is None:
            continue
        if scope == "global" and record.get("projectId"):
            continue
        if scope == "project" and record.get("projectId") != project_id:
            continue
        results.append(record)
    results.sort(key=lambda record: str(record.get("deletedAt") or ""), reverse=True)
    return results


def restore(root: Path, asset_id: str) -> dict[str, Any]:
    """Move the asset back where it was deleted from and return it as saved.

    Raises KeyError when it isn't in the trash, AlreadyLive when an asset with
    that id is live again (nothing moves then)."""
    record = trashed(root, asset_id)
    if record is None:
        raise KeyError(asset_id)
    scope_dir = str(record.get("scopeDir") or "_global")
    if not _ID_RE.fullmatch(scope_dir):
        raise ValueError(f"invalid scope folder in trash record: {scope_dir!r}")
    for sub in root.iterdir():
        if sub.is_dir() and not sub.name.startswith(".") and (sub / f"{asset_id}.json").exists():
            raise AlreadyLive(asset_id)
    target_dir = root / scope_dir
    target_dir.mkdir(parents=True, exist_ok=True)
    folder = trash_dir(root)
    target = target_dir / f"{asset_id}.json"
    os.replace(folder / f"{asset_id}.json", target)
    (folder / f"{asset_id}{RECORD_SUFFIX}").unlink(missing_ok=True)
    return json.loads(target.read_text(encoding="utf-8"))


def purge(root: Path, asset_id: str) -> None:
    """Delete a trashed asset for good. Raises KeyError when it isn't there."""
    if trashed(root, asset_id) is None:
        raise KeyError(asset_id)
    folder = trash_dir(root)
    (folder / f"{asset_id}.json").unlink(missing_ok=True)
    (folder / f"{asset_id}{RECORD_SUFFIX}").unlink(missing_ok=True)


def is_trash_folder(path: Path) -> bool:
    """True for the trash folder (and any dot folder) under a store root."""
    return path.name.startswith(".")
