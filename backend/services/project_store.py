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

from services import project_cover
from services.saved_graph_upgrades import PARAMS_VERSION, catalog_params_behind, upgrade_catalog

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
    found = {key: copy.deepcopy(project[key]) for key in (
        "id", "name", "createdAt", "updatedAt", "lastOpenedAt", "nodeCount", "edgeCount", "thumbnail",
    )}
    # Saved before covers existed: refresh_metadata fills it on the next write
    # (the listing backfills it, see needs_cover).
    found["cover"] = copy.deepcopy(project.get("cover"))
    if project.get("createdBy"):
        found["createdBy"] = copy.deepcopy(project["createdBy"])
    return found


def needs_cover(project: dict[str, Any]) -> bool:
    return "cover" not in project


def public_project(project: dict[str, Any]) -> dict[str, Any]:
    return {**metadata(project), "snapshot": copy.deepcopy(project["snapshot"])}


def refresh_metadata(project: dict[str, Any], *, touch: bool = True) -> None:
    snapshot = project["snapshot"]
    project["nodeCount"] = len(snapshot["nodes"])
    project["edgeCount"] = len(snapshot["edges"])
    # The card's picture (services/project_cover.py). `thumbnail` stays its
    # first image for clients from before covers.
    project["cover"] = project_cover.cover(snapshot, project.get("coverPin"))
    project["thumbnail"] = project_cover.first_image(project["cover"])
    if touch:
        project["updatedAt"] = now()


def purge_at(entry: dict[str, Any]) -> str:
    deleted = datetime.fromisoformat(entry["deletedAt"])
    return (deleted + TRASH_RETENTION).isoformat()


def trash_metadata(entry: dict[str, Any]) -> dict[str, Any]:
    result = {**metadata(entry), "deletedAt": entry["deletedAt"], "purgeAt": purge_at(entry)}
    # Projects deleted before 2026-10-18 didn't record who deleted them.
    if isinstance(entry.get("deletedBy"), dict):
        result["deletedBy"] = entry["deletedBy"]
    return result


def move_to_trash(catalog: dict[str, Any], project_id: str,
                  deleted_by: dict[str, str] | None = None) -> dict[str, Any]:
    """Move a project, pins and all, out of the list and into the trash.
    ``deleted_by`` is who asked (services/canvas_events.actor_record)."""
    entry = catalog["projects"].pop(project_id)
    entry["deletedAt"] = now()
    if deleted_by:
        entry["deletedBy"] = dict(deleted_by)
    catalog.setdefault("trash", {})[project_id] = entry
    if catalog.get("migratedProjectId") == project_id:
        catalog.pop("migratedProjectId", None)
    return entry


def restore_from_trash(catalog: dict[str, Any], project_id: str) -> dict[str, Any]:
    """Put a trashed project back in the list. It comes back closed."""
    entry = catalog["trash"].pop(project_id)
    entry.pop("deletedAt", None)
    entry.pop("deletedBy", None)
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
        # Made by this code, so its params are current (saved_graph_upgrades).
        "_paramsVersion": PARAMS_VERSION,
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

    def _read(self, *, upgrade: bool = True) -> dict[str, Any]:
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
            # Every reader gets upgraded params (services/saved_graph_upgrades.py).
            # The version marker is set with them, so the first commit stores
            # both and a value set after that is never upgraded again.
            if upgrade:
                upgrade_catalog(result)
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

    def read_unlocked(self) -> dict[str, Any]:
        """The catalog as last committed, without taking the lock.

        For work done ahead of a transaction in a worker thread
        (main._open_ingress_verdict): the event loop takes the lock, so a
        thread holding it would stall the loop. Commits replace catalog.json
        whole (os.replace), so this reads one complete version, possibly one
        a transaction is about to replace: a caller compares what it read
        with what its transaction then holds, and never commits from it."""
        return self._read()

    def workspace(self) -> dict[str, Any]:
        """{activeProjectId, workspaceRevision} without copying the catalog.

        Every canvas event carries these two (main._workspace_context). read()
        parses, upgrades and deep-copies every project's snapshot and run
        history, which on the event loop held up runs as projects grew. The
        answer is kept until catalog.json changes: commits replace the file
        (os.replace), so its inode, mtime and size say when, whichever
        process wrote it."""
        signature = self._signature()
        cached = getattr(self, "_workspace_cache", None)
        if signature is not None and cached is not None and cached[0] == signature:
            return dict(cached[1])
        try:
            self._ensure_root()
            fd = os.open(self.root / ".lock", os.O_CREAT | os.O_RDWR | getattr(os, "O_NOFOLLOW", 0), 0o600)
            with os.fdopen(fd, "a+") as handle:
                os.fchmod(handle.fileno(), 0o600)
                fcntl.flock(handle.fileno(), fcntl.LOCK_EX)
                signature = self._signature()
                catalog = self._read(upgrade=False)
        except OSError as exc:
            raise ProjectStoreError("Project storage is unavailable; the canvas was preserved") from exc
        answer = {"activeProjectId": catalog.get("activeProjectId"), "workspaceRevision": catalog["workspaceRevision"]}
        if signature is not None:
            self._workspace_cache = (signature, dict(answer))
        return answer

    def _signature(self) -> tuple[int, int, int] | None:
        try:
            info = self.path.stat()
        except FileNotFoundError:
            return None
        except OSError as exc:
            raise ProjectStoreError("Project storage is unavailable; the canvas was preserved") from exc
        return (info.st_ino, info.st_mtime_ns, info.st_size)

    def advance_params_version(self, *, live_graph_advanced: bool) -> bool:
        """Boot step after a one-time params upgrade (main.py). When the
        catalog on disk holds an entry saved before ``PARAMS_VERSION``, or
        state.json did (``live_graph_advanced``), give the workspace a new
        revision and write the upgraded catalog now. A tab loaded before the
        restart then holds a revision the backend refuses, so it can't write
        its pre-upgrade values back, and the upgrade is on disk instead of
        waiting for the next commit (which could be that tab's autosave).
        Values alone don't decide it: a tab can hold values that were never
        saved. Returns whether it rotated. Without a catalog file there is
        nothing to write, and the revision is already new in each process."""
        if not self.path.exists():
            return False
        with self.transaction() as catalog:
            if not live_graph_advanced and not catalog_params_behind(self._read(upgrade=False)):
                return False
            catalog["workspaceRevision"] = uuid4().hex
            self.commit(catalog)
            return True

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
