"""Private, disk-backed canvas projects and their active workspace identity.

A single catalog commit keeps metadata, snapshots and the active revision
together. Callers stage graph validation before preparing a catalog commit.
"""
from __future__ import annotations

import copy
import fcntl
import json
import os
import re
from contextlib import contextmanager
from datetime import datetime, timedelta, timezone
from pathlib import Path
from typing import Any, Iterator
from uuid import uuid4

MAX_PROJECT_BYTES = 16 * 1024 * 1024
MAX_CATALOG_BYTES = 128 * 1024 * 1024
MAX_PROJECTS = 500
# Deleted projects wait this long in Recently deleted before they go for good.
TRASH_RETENTION = timedelta(days=30)
_ID = re.compile(r"^[a-f0-9]{32}$")


class ProjectStoreError(Exception):
    pass


class ProjectLimitError(ProjectStoreError):
    pass


def now() -> str:
    return datetime.now(timezone.utc).isoformat()


def validate_project_id(project_id: str) -> None:
    if not isinstance(project_id, str) or not _ID.fullmatch(project_id):
        raise ValueError("Invalid project ID")


def project_name(value: Any) -> str:
    if not isinstance(value, str):
        raise ValueError("Project name must be a string")
    result = value.strip()
    if not result or len(result) > 120 or any(ord(char) < 32 for char in result):
        raise ValueError("Project name must contain 1–120 characters without control characters")
    return result


def empty_snapshot() -> dict[str, Any]:
    return {"nodes": [], "edges": [], "runHistory": [], "viewport": None, "createSessionId": None}


def metadata(project: dict[str, Any]) -> dict[str, Any]:
    return {key: copy.deepcopy(project[key]) for key in (
        "id", "name", "createdAt", "updatedAt", "lastOpenedAt", "nodeCount", "edgeCount", "thumbnail",
    )}


def public_project(project: dict[str, Any]) -> dict[str, Any]:
    return {**metadata(project), "snapshot": copy.deepcopy(project["snapshot"])}


def refresh_metadata(project: dict[str, Any], *, touch: bool = True) -> None:
    snapshot = project["snapshot"]
    project["nodeCount"] = len(snapshot["nodes"])
    project["edgeCount"] = len(snapshot["edges"])
    project["thumbnail"] = None
    for node in reversed(snapshot["nodes"]):
        for port in (node.get("data", {}).get("outputs") or {}).values():
            if isinstance(port, dict) and port.get("type") == "Image":
                value = port.get("value")
                if isinstance(value, str) and len(value) <= 8192 and value.startswith(("/api/outputs/", "http://", "https://")):
                    project["thumbnail"] = value
                    break
        if project["thumbnail"]:
            break
    if touch:
        project["updatedAt"] = now()


def purge_at(entry: dict[str, Any]) -> str:
    deleted = datetime.fromisoformat(entry["deletedAt"])
    return (deleted + TRASH_RETENTION).isoformat()


def trash_metadata(entry: dict[str, Any]) -> dict[str, Any]:
    return {**metadata(entry), "deletedAt": entry["deletedAt"], "purgeAt": purge_at(entry)}


def move_to_trash(catalog: dict[str, Any], project_id: str) -> dict[str, Any]:
    """Move a project, pins and all, out of the list and into the trash."""
    entry = catalog["projects"].pop(project_id)
    entry["deletedAt"] = now()
    catalog.setdefault("trash", {})[project_id] = entry
    if catalog.get("migratedProjectId") == project_id:
        catalog.pop("migratedProjectId", None)
    return entry


def restore_from_trash(catalog: dict[str, Any], project_id: str) -> dict[str, Any]:
    """Put a trashed project back in the list. It comes back closed."""
    entry = catalog["trash"].pop(project_id)
    entry.pop("deletedAt", None)
    catalog["projects"][project_id] = entry
    return entry


def purge_expired_trash(catalog: dict[str, Any], *, at: datetime | None = None) -> bool:
    """Drop trash older than TRASH_RETENTION. Returns whether anything went."""
    moment = at or datetime.now(timezone.utc)
    trash = catalog.get("trash") or {}
    expired = [project_id for project_id, entry in trash.items()
               if datetime.fromisoformat(entry["deletedAt"]) + TRASH_RETENTION <= moment]
    for project_id in expired:
        del trash[project_id]
    return bool(expired)


def make_project(name: str, snapshot: dict[str, Any] | None = None) -> dict[str, Any]:
    timestamp = now()
    project = {
        "id": uuid4().hex, "name": project_name(name), "createdAt": timestamp,
        "updatedAt": timestamp, "lastOpenedAt": timestamp, "snapshot": copy.deepcopy(snapshot or empty_snapshot()),
    }
    refresh_metadata(project, touch=False)
    return project


class ProjectStore:
    def __init__(self, root: Path) -> None:
        self.root = root
        self.path = root / "catalog.json"
        self._initial_revision = uuid4().hex

    def _ensure_root(self) -> None:
        if self.root.is_symlink():
            raise ProjectStoreError("Project storage cannot be a symbolic link")
        self.root.mkdir(parents=True, exist_ok=True, mode=0o700)
        os.chmod(self.root, 0o700)

    def _read(self) -> dict[str, Any]:
        if not self.path.exists():
            return {"version": 1, "projects": {}, "activeProjectId": None, "workspaceRevision": self._initial_revision}
        if self.path.is_symlink() or self.path.stat().st_size > MAX_CATALOG_BYTES:
            raise ProjectStoreError("Project catalog cannot be read safely")
        try:
            result = json.loads(self.path.read_text(encoding="utf-8"))
            if not isinstance(result, dict) or result.get("version") != 1 or not isinstance(result.get("projects"), dict):
                raise ValueError("Invalid catalog")
            if not isinstance(result.get("workspaceRevision"), str):
                raise ValueError("Invalid workspace revision")
            for project_id, project in result["projects"].items():
                validate_project_id(project_id)
                if not isinstance(project, dict) or project.get("id") != project_id or not isinstance(project.get("snapshot"), dict):
                    raise ValueError("Invalid project document")
            trash = result.setdefault("trash", {})
            if not isinstance(trash, dict):
                raise ValueError("Invalid trash")
            for project_id, entry in trash.items():
                validate_project_id(project_id)
                if (not isinstance(entry, dict) or entry.get("id") != project_id
                        or not isinstance(entry.get("snapshot"), dict) or project_id in result["projects"]):
                    raise ValueError("Invalid trashed project")
                deleted_at = entry.get("deletedAt")
                if not isinstance(deleted_at, str) or datetime.fromisoformat(deleted_at).tzinfo is None:
                    raise ValueError("Invalid trashed project")
            active = result.get("activeProjectId")
            if active is not None and active not in result["projects"]:
                raise ValueError("Invalid active project")
            return result
        except (ValueError, OSError) as exc:
            raise ProjectStoreError("Project catalog could not be read; the existing file was preserved") from exc

    @contextmanager
    def transaction(self) -> Iterator[dict[str, Any]]:
        """Serialize catalog mutations across API requests and processes."""
        try:
            self._ensure_root()
            fd = os.open(self.root / ".lock", os.O_CREAT | os.O_RDWR | getattr(os, "O_NOFOLLOW", 0), 0o600)
            with os.fdopen(fd, "a+") as handle:
                os.fchmod(handle.fileno(), 0o600)
                fcntl.flock(handle.fileno(), fcntl.LOCK_EX)
                yield copy.deepcopy(self._read())
        except OSError as exc:
            raise ProjectStoreError("Project storage is unavailable; the canvas was preserved") from exc

    def read(self) -> dict[str, Any]:
        with self.transaction() as catalog:
            return catalog

    def prepare(self, catalog: dict[str, Any]) -> Path:
        """Write/fsync a private temporary catalog before any live graph edit."""
        self._ensure_root()
        if len(catalog["projects"]) > MAX_PROJECTS:
            raise ProjectLimitError("Project limit reached")
        encoded = json.dumps(catalog, ensure_ascii=False, allow_nan=False, separators=(",", ":")).encode("utf-8")
        if len(encoded) > MAX_CATALOG_BYTES:
            raise ProjectLimitError("Project storage limit reached")
        temporary = self.root / f".catalog.{uuid4().hex}.tmp"
        try:
            fd = os.open(temporary, os.O_CREAT | os.O_EXCL | os.O_WRONLY, 0o600)
            with os.fdopen(fd, "wb") as handle:
                handle.write(encoded)
                handle.flush()
                os.fsync(handle.fileno())
            return temporary
        except Exception:
            temporary.unlink(missing_ok=True)
            raise

    def commit_prepared(self, temporary: Path) -> None:
        fd = os.open(self.root, os.O_RDONLY | getattr(os, "O_DIRECTORY", 0))
        # A successful atomic rename is the commit point. A post-commit
        # directory fsync warning must not report a failed, unadopted canvas.
        try:
            os.replace(temporary, self.path)
            try:
                os.fsync(fd)
            except OSError as exc:
                print(f"[projects] directory fsync failed after commit: {exc}", flush=True)
        finally:
            os.close(fd)

    def commit(self, catalog: dict[str, Any]) -> None:
        temporary = self.prepare(catalog)
        try:
            self.commit_prepared(temporary)
        finally:
            temporary.unlink(missing_ok=True)
