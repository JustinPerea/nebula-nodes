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
from typing import Any, Iterator, NamedTuple
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
    """A limit the store keeps. ``limit`` says which: "projects" (how many
    there may be) or "storage" (how big the catalog may grow). The answer
    carries it beside ``detail`` (main._storage_error_body), so the Projects
    screen can tell a full store from a copy that is itself too large without
    reading the words (Q116 a)."""

    def __init__(self, message: str, limit: str) -> None:
        super().__init__(message)
        self.limit = limit


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
    # Who pinned the cover ({kind, name}); a pin from before it was recorded
    # has none and is the person's (main._cover_owner). A pin whose image left
    # the project no longer counts (Q90 a): the card is automatic, and
    # `coverLostPin` names the old pin so a screen can say why.
    pin = project.get("coverPin")
    if pin and (project.get("cover") or {}).get("source") == "pinned":
        if isinstance(project.get("coverBy"), dict):
            found["coverBy"] = copy.deepcopy(project["coverBy"])
    elif pin and "cover" in project:
        found["coverLostPin"] = {"url": pin, "by": recorded_cover_owner(project)}
    return found


def recorded_cover_owner(project: dict[str, Any]) -> dict[str, str] | None:
    """Who the stored pin says pinned the cover, whether or not it counts now.
    A pin saved before ``coverBy`` existed is the person's: only they could pin."""
    if not project.get("coverPin"):
        return None
    by = project.get("coverBy")
    return copy.deepcopy(dict(by)) if isinstance(by, dict) and by.get("kind") else {"kind": "person", "name": "You"}


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


class Projection(NamedTuple):
    """The open project as catalog.json holds it, for readers that need only
    that (ProjectStore.projection): which project is open, the workspace
    revision, the open project's name and its pins. Shared, not copied:
    read it, never change it (CanvasPins copies the pins it hands out)."""
    signature: tuple[int, int, int] | None  # the catalog file it describes
    project_id: str | None
    revision: str
    name: str                               # "" with no project open
    pins: tuple[dict[str, Any], ...]        # the open project's pins, as stored


def _projection(catalog: dict[str, Any], signature: tuple[int, int, int] | None) -> Projection:
    project_id = catalog.get("activeProjectId")
    project = catalog["projects"].get(project_id) if project_id else None
    pins = tuple(pin for pin in (project or {}).get("pins") or [] if isinstance(pin, dict))
    return Projection(signature, project_id, catalog["workspaceRevision"], str((project or {}).get("name") or ""), pins)


class ProjectStore:
    def __init__(self, root: Path) -> None:
        self.root = root
        self.path = root / "catalog.json"
        self._initial_revision = uuid4().hex
        # The projection of the catalog file last read or committed here, and
        # the one a prepared commit will make (see projection()).
        self._projection: Projection | None = None
        self._prepared: tuple[Path, Projection] | None = None

    def _ensure_root(self) -> None:
        if self.root.is_symlink():
            raise ProjectStoreError("Project storage cannot be a symbolic link")
        self.root.mkdir(parents=True, exist_ok=True, mode=0o700)
        os.chmod(self.root, 0o700)

    @staticmethod
    def _check(result: Any, *, fill: bool = True) -> None:
        """Raise ValueError unless ``result`` is a catalog _read accepts.
        ``fill`` adds the empty trash a catalog from before the trash lacks
        (_read); without it nothing is changed (a commit's own catalog)."""
        if not isinstance(result, dict) or result.get("version") != 1 or not isinstance(result.get("projects"), dict):
            raise ValueError("Invalid catalog")
        if not isinstance(result.get("workspaceRevision"), str):
            raise ValueError("Invalid workspace revision")
        for project_id, project in result["projects"].items():
            validate_project_id(project_id)
            if not isinstance(project, dict) or project.get("id") != project_id or not isinstance(project.get("snapshot"), dict):
                raise ValueError("Invalid project document")
        trash = result.setdefault("trash", {}) if fill else result.get("trash", {})
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

    def _read(self, *, upgrade: bool = True) -> dict[str, Any]:
        if not self.path.exists():
            return {"version": 1, "projects": {}, "activeProjectId": None, "workspaceRevision": self._initial_revision}
        if self.path.is_symlink() or self.path.stat().st_size > MAX_CATALOG_BYTES:
            raise ProjectStoreError("Project catalog cannot be read safely")
        try:
            result = json.loads(self.path.read_text(encoding="utf-8"))
            self._check(result)
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
        history, which on the event loop held up runs as projects grew. They
        come from projection()."""
        view = self.projection()
        return {"activeProjectId": view.project_id, "workspaceRevision": view.revision}

    def projection(self) -> Projection:
        """The open project as catalog.json holds it now: its id, the
        workspace revision, its name and its pins (Projection).

        One projection per catalog file, shared by every reader that needs
        only these: the workspace (every canvas event), the pins listing
        (services/canvas_pins), the journal's project tag
        (services/canvas_events) and the open project's name. It is kept until
        catalog.json changes: every commit replaces the file (os.replace), so
        its (inode, mtime, size) signature says when, whichever route or
        process wrote it. A commit made here keeps the projection of what it
        wrote, so nothing is read back (review 5 of PR #114, M2: an autosave
        every 600 ms made the next pins listing parse, upgrade and deep-copy
        the whole catalog). A file written elsewhere is parsed once, without
        upgrading or copying it. No lock: a commit replaces the file whole,
        so a read sees one complete version; the signature is taken before
        and after it, and a projection is kept only when both agree (a commit
        between them makes a new inode). A writer that rewrote catalog.json in
        place keeping its size and mtime would not be seen; Nebula never
        writes it in place (commit_prepared)."""
        signature = self._signature()
        cached = self._projection
        if signature is not None and cached is not None and cached.signature == signature:
            return cached
        try:
            self._ensure_root()
        except OSError as exc:
            raise ProjectStoreError("Project storage is unavailable; the canvas was preserved") from exc
        before = self._signature()
        catalog = self._read(upgrade=False)
        after = self._signature()
        view = _projection(catalog, after if after == before else None)
        if view.signature is not None:
            self._projection = view
        return view

    def signature(self) -> tuple[int, int, int] | None:
        """catalog.json's (inode, mtime, size): it changes on every commit, so a
        caller can keep something it read until then (main._open_project_record)."""
        return self._signature()

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
            raise ProjectLimitError("Project limit reached", "projects")
        encoded = json.dumps(catalog, ensure_ascii=False, allow_nan=False, separators=(",", ":")).encode("utf-8")
        if len(encoded) > MAX_CATALOG_BYTES:
            raise ProjectLimitError("Project storage limit reached", "storage")
        temporary = self.root / f".catalog.{uuid4().hex}.tmp"
        try:
            fd = os.open(temporary, os.O_CREAT | os.O_EXCL | os.O_WRONLY, 0o600)
            with os.fdopen(fd, "wb") as handle:
                handle.write(encoded)
                handle.flush()
                os.fsync(handle.fileno())
        except Exception:
            temporary.unlink(missing_ok=True)
            raise
        self._prepared = None
        try:
            # What projection() would read back from this file, for
            # commit_prepared to keep. Only for a catalog _read accepts (one
            # it would refuse is read, and refused, as before); the pins go
            # through JSON as they are stored, so the caller can't change them.
            self._check(catalog, fill=False)
            view = _projection(catalog, None)
            stored = json.loads(json.dumps(view.pins, ensure_ascii=False, allow_nan=False))
            self._prepared = (temporary, view._replace(pins=tuple(stored)))
        except (ValueError, TypeError, KeyError):
            pass
        return temporary

    def commit_prepared(self, temporary: Path) -> None:
        prepared, self._prepared = self._prepared, None
        written = None
        if prepared is not None and prepared[0] == temporary:
            try:
                written = os.stat(temporary)
            except OSError:
                pass  # the rename below says what is wrong
        fd = os.open(self.root, os.O_RDONLY | getattr(os, "O_DIRECTORY", 0))
        # A successful atomic rename is the commit point. A post-commit
        # directory fsync warning must not report a failed, unadopted canvas.
        try:
            os.replace(temporary, self.path)
            if written is not None and prepared is not None:
                # The projection of what was just written, under the file's
                # signature (a rename keeps its inode, mtime and size), so
                # the next reader doesn't parse it back (projection()). Never
                # fails the commit: without it the next reader reads the file.
                try:
                    landed = self._signature()
                except ProjectStoreError:
                    landed = None
                if landed is not None and landed[0] == written.st_ino and landed[2] == written.st_size:
                    self._projection = prepared[1]._replace(signature=landed)
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
