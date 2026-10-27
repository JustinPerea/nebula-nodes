"""Private, disk-backed canvas projects and their active workspace identity.

A single catalog commit keeps metadata, snapshots and the active revision
together. Callers stage graph validation before preparing a catalog commit.

Every project lives whole in catalog.json; there are no per-project folders.
So every commit that writes a catalog _check accepts also keeps a last good
copy of it (catalog.json.bak, and catalog.json.bak.1 at most an hour old),
each written atomically, and a read that finds catalog.json damaged (it
won't parse or validate) or missing while a copy exists restores it
(_recover): the damaged file is kept beside it, never deleted, the newest
good copy comes back with every newer project the damaged file still holds
(services/catalog_recovery.py), and the restore is recorded once for the
person and agents (catalog-restore.json, restore_notice). With no good copy
the list is rebuilt from what the damaged files hold; only when they hold no
project at all does the read refuse, as before (2026-10-27).
"""
from __future__ import annotations

import copy
import fcntl
import hashlib
import json
import os
import re
import shutil
import threading
import time
from contextlib import contextmanager
from datetime import datetime, timedelta, timezone
from pathlib import Path
from typing import Any, Callable, Iterator, NamedTuple
from uuid import uuid4

from services import catalog_recovery, project_cover
from services.saved_graph_upgrades import PARAMS_VERSION, catalog_params_behind, upgrade_catalog

MAX_PROJECT_BYTES = 16 * 1024 * 1024
MAX_CATALOG_BYTES = 128 * 1024 * 1024
MAX_PROJECTS = 500
# Deleted projects wait this long in Recently deleted before they go for good.
TRASH_RETENTION = timedelta(days=30)
_ID = re.compile(r"^[a-f0-9]{32}$")
# The last good copies of catalog.json (ProjectStore._write_backup): the
# newest after every commit, and an older one rewritten at most once an hour,
# for when the newest is damaged too. Two full copies, so a third would add
# disk for an hour-older state the damaged files can't add to.
BACKUP_NAME = "catalog.json.bak"
OLDER_BACKUP_NAME = "catalog.json.bak.1"
OLDER_BACKUP_SECONDS = 3600
# Restores, newest last, for the notice and support (ProjectStore._record_restore).
RESTORE_RECORD_NAME = "catalog-restore.json"
RESTORES_KEPT = 10
RECORD_ROWS = 100  # names listed per restore; the counts are whole
# The fields prepare writes first, so a cut file still says which project was open.
_HEAD_KEYS = ("version", "activeProjectId", "workspaceRevision", "migratedProjectId")
UNREADABLE = "Project catalog could not be read; the existing file was preserved"


class ProjectStoreError(Exception):
    pass


class _Damaged(Exception):
    """catalog.json won't parse or validate (``raw`` holds what it does
    hold), or is missing while a copy exists. ``reason``: "corrupt" (not
    JSON), "invalid" (JSON of the wrong shape) or "missing"."""

    def __init__(self, reason: str, detail: str, raw: bytes | None = None) -> None:
        super().__init__(detail)
        self.reason = reason
        self.raw = raw


def _log(message: str) -> None:
    print(f"[projects] {message}", flush=True)


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
        # What prepare wrote, for commit_prepared: the temporary file, its
        # projection and its bytes (the last good copy is written from them).
        self._prepared: tuple[Path, Projection, bytes] | None = None
        self.backup_path = root / BACKUP_NAME
        self.older_backup_path = root / OLDER_BACKUP_NAME
        self.record_path = root / RESTORE_RECORD_NAME
        # Called once per restore with its record, after the lock is let go
        # (main._on_catalog_restore journals it and tells open tabs).
        self.on_restore: Callable[[dict[str, Any]], None] | None = None
        # This thread's hold on .lock (a count, for a read inside a
        # transaction that finds the file damaged: flock from a second
        # descriptor would wait on itself), and the restores to announce
        # once it is let go.
        self._local = threading.local()

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

    def _empty(self) -> dict[str, Any]:
        return {"version": 1, "projects": {}, "activeProjectId": None, "workspaceRevision": self._initial_revision}

    def _load(self, *, upgrade: bool) -> tuple[dict[str, Any], bytes | None]:
        """catalog.json as _check accepts it, and its bytes (None for the
        empty catalog of a fresh install). Raises _Damaged for a file that
        won't parse or validate, or that is missing while a copy exists, and
        ProjectStoreError for one that can't be read at all (a symbolic
        link, too large, an I/O error), as before: those are not restored."""
        if self.path.is_symlink():
            raise ProjectStoreError("Project catalog cannot be read safely")
        try:
            size = self.path.stat().st_size
        except FileNotFoundError:
            if self.backup_path.exists() or self.older_backup_path.exists():
                raise _Damaged("missing", "catalog.json is missing") from None
            return self._empty(), None
        except OSError as exc:
            raise ProjectStoreError(UNREADABLE) from exc
        if size > MAX_CATALOG_BYTES:
            raise ProjectStoreError("Project catalog cannot be read safely")
        try:
            raw = self.path.read_bytes()
        except FileNotFoundError:
            raise _Damaged("missing", "catalog.json is missing") from None
        except OSError as exc:
            raise ProjectStoreError(UNREADABLE) from exc
        try:
            result = json.loads(raw.decode("utf-8"))
        except ValueError as exc:
            raise _Damaged("corrupt", f"not JSON: {exc}", raw) from exc
        try:
            self._check(result)
        except (ValueError, TypeError, AttributeError) as exc:
            raise _Damaged("invalid", f"not a catalog: {exc}", raw) from exc
        # Every reader gets upgraded params (services/saved_graph_upgrades.py).
        # The version marker is set with them, so the first commit stores
        # both and a value set after that is never upgraded again. A failing
        # upgrade is a bug, not damage: it refuses, and restores nothing.
        if upgrade:
            try:
                upgrade_catalog(result)
            except ValueError as exc:
                raise ProjectStoreError(UNREADABLE) from exc
        return result, raw

    def _read(self, *, upgrade: bool = True) -> dict[str, Any]:
        try:
            return self._load(upgrade=upgrade)[0]
        except _Damaged as damage:
            return self._recover(damage, upgrade=upgrade)[0]

    @contextmanager
    def _locked(self) -> Iterator[None]:
        """Hold .lock (serializes catalog commits across requests and
        processes). Re-entrant in one thread. Restores made while it was held
        are announced once the outermost hold lets go. Raises OSError."""
        depth = getattr(self._local, "depth", 0)
        if depth:
            self._local.depth = depth + 1
            try:
                yield
            finally:
                self._local.depth = depth
            return
        try:
            self._ensure_root()
            fd = os.open(self.root / ".lock", os.O_CREAT | os.O_RDWR | getattr(os, "O_NOFOLLOW", 0), 0o600)
            with os.fdopen(fd, "a+") as handle:
                os.fchmod(handle.fileno(), 0o600)
                fcntl.flock(handle.fileno(), fcntl.LOCK_EX)
                self._local.depth = 1
                try:
                    yield
                finally:
                    self._local.depth = 0
        finally:
            self._announce()

    @contextmanager
    def transaction(self) -> Iterator[dict[str, Any]]:
        """Serialize catalog mutations across API requests and processes."""
        try:
            with self._locked():
                try:
                    catalog, raw = self._load(upgrade=True)
                except _Damaged as damage:
                    catalog, raw = self._recover(damage, upgrade=True)
                if raw is not None and not self.backup_path.exists():
                    # A catalog saved before copies were kept: keep one now.
                    self._seed_backup(raw)
                yield copy.deepcopy(catalog)
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

    # -- recovering a damaged catalog -------------------------------------------

    def _recover(self, damage: _Damaged, *, upgrade: bool) -> tuple[dict[str, Any], bytes | None]:
        """catalog.json after restoring it, under the lock. A reader that
        waited for the lock reads the file again first: another request (or
        process) may have restored it meanwhile, and one restore is enough."""
        try:
            with self._locked():
                try:
                    return self._load(upgrade=upgrade)
                except _Damaged as current:
                    damage = current
                self._restore(damage)
                try:
                    return self._load(upgrade=upgrade)
                except _Damaged as still:  # what it just wrote doesn't read back
                    _log(f"the restored catalog doesn't read back ({still}); refusing")
                    raise ProjectStoreError(UNREADABLE) from still
        except OSError as exc:
            raise ProjectStoreError("Project storage is unavailable; the canvas was preserved") from exc

    def _copy_bytes(self, path: Path) -> bytes | None:
        """A last good copy's bytes, or None when there is none to use."""
        try:
            if path.is_symlink():
                _log(f"{path.name} is a symbolic link; not using it")
                return None
            if path.stat().st_size > MAX_CATALOG_BYTES:
                _log(f"{path.name} is larger than a catalog may be; not using it")
                return None
            return path.read_bytes()
        except FileNotFoundError:
            return None
        except OSError as exc:
            _log(f"{path.name} could not be read ({exc}); not using it")
            return None

    def _already_kept(self, path: Path) -> Path | None:
        """A kept file that already holds ``path`` as it is now (the same
        file, or the same bytes), so a restore that is tried again after a
        failure doesn't keep it twice."""
        try:
            info = path.stat()
        except OSError:
            return None
        digest: str | None = None
        for kept in sorted(self.root.glob(f"{path.name}.damaged-*")):
            try:
                other = kept.stat()
                if (other.st_dev, other.st_ino) == (info.st_dev, info.st_ino):
                    return kept
                if other.st_size != info.st_size:
                    continue
                if digest is None:
                    digest = hashlib.sha256(path.read_bytes()).hexdigest()
                if hashlib.sha256(kept.read_bytes()).hexdigest() == digest:
                    return kept
            except OSError:
                continue
        return None

    def _set_aside(self, path: Path, stamp: str) -> Path:
        """Keep ``path`` as it is now under a new name beside it, before
        anything replaces it: a hard link (the bytes stay where they are), or
        a copy where links aren't possible. Never deleted by Nebula."""
        existing = self._already_kept(path)
        if existing is not None:
            return existing  # a restore that failed after keeping it: keep one
        target = self.root / f"{path.name}.damaged-{stamp}"
        try:
            os.link(path, target, follow_symlinks=False)
        except OSError:
            temporary = self.root / f".damaged.{uuid4().hex}.tmp"
            try:
                shutil.copyfile(path, temporary, follow_symlinks=False)
                with open(temporary, "rb+") as handle:
                    os.fsync(handle.fileno())
                os.replace(temporary, target)
            finally:
                temporary.unlink(missing_ok=True)
        os.chmod(target, 0o600, follow_symlinks=False)
        return target

    def _restore(self, damage: _Damaged) -> None:
        """Put back a catalog _check accepts, holding the lock. Keeps every
        damaged file it finds, restores the newest good copy (or rebuilds
        from the damaged files' records), adds back what the damaged file
        holds that the copy lacks, and records the restore. Raises
        ProjectStoreError, changing nothing, when there is nothing to put
        back."""
        _log(f"catalog.json can't be used ({damage.reason}: {damage}); restoring it")
        base: dict[str, Any] | None = None
        source: str | None = None
        damaged_copies: list[tuple[Path, bytes]] = []
        for path in (self.backup_path, self.older_backup_path):
            raw = self._copy_bytes(path)
            if raw is None:
                continue
            try:
                candidate = json.loads(raw.decode("utf-8"))
                self._check(candidate)
            except (ValueError, TypeError, AttributeError) as exc:
                _log(f"{path.name} is damaged too ({exc})")
                damaged_copies.append((path, raw))
                continue
            base, source = candidate, path.name
            break
        # Newest first: the damaged catalog, then the copies that failed.
        salvages = [catalog_recovery.salvage(raw)
                    for raw in ([damage.raw] if damage.raw is not None else []) + [raw for _, raw in damaged_copies]]
        kind = "restored" if base is not None else "rebuilt"
        moment = datetime.now(timezone.utc)
        stamp = f"{moment.strftime('%Y%m%dT%H%M%SZ')}-{uuid4().hex[:8]}"
        if base is None and not any(found.entries for found in salvages):
            if damage.raw is None:
                # catalog.json is gone and every copy is damaged and empty of
                # projects: keep the copies, then start from an empty list as
                # a missing catalog always did (a refusal would last forever).
                for path, _raw in damaged_copies:
                    kept = self._set_aside(path, stamp)
                    _log(f"kept the damaged copy {path.name} as {kept}; it holds no complete project")
                    if path.exists() and os.path.samefile(path, kept):
                        path.unlink()
                _log("catalog.json is missing and no copy holds a project: starting from an empty list")
                return
            _log("no good copy, and the damaged files hold no complete project: nothing to restore; "
                 "catalog.json is left as it is")
            raise ProjectStoreError(UNREADABLE)
        if base is None:
            base = {"version": 1, "projects": {}, "activeProjectId": None,
                    "workspaceRevision": uuid4().hex, "trash": {}}
            _log("no good copy: rebuilding the list from the projects the damaged files still hold")
        else:
            _log(f"restoring from {source}")
        base_bytes = len(json.dumps(base, ensure_ascii=False, allow_nan=False, separators=(",", ":")).encode("utf-8"))
        merged = catalog_recovery.reconcile(base, salvages, max_projects=MAX_PROJECTS,
                                            room_bytes=MAX_CATALOG_BYTES - base_bytes - 4096)
        catalog = merged.catalog
        catalog["version"] = 1
        # Open tabs hold the list as it was: a new revision makes them reload.
        catalog["workspaceRevision"] = uuid4().hex
        try:
            self._check(catalog)
        except (ValueError, TypeError) as exc:  # a bug in reconcile: change nothing
            _log(f"the restored catalog doesn't validate ({exc}); nothing changed")
            raise ProjectStoreError(UNREADABLE) from exc
        # Every damaged file is kept before anything replaces it.
        set_aside: list[str] = []
        damaged_file: str | None = None
        if damage.raw is not None:
            damaged_file = str(self._set_aside(self.path, stamp))
            set_aside.append(damaged_file)
            _log(f"kept the damaged catalog as {damaged_file}")
        kept_copies: list[tuple[Path, Path]] = []
        for path, _raw in damaged_copies:
            kept = self._set_aside(path, stamp)
            kept_copies.append((path, kept))
            set_aside.append(str(kept))
            _log(f"kept the damaged copy {path.name} as {kept}")
        try:
            temporary = self.prepare(catalog)
        except ProjectLimitError as exc:
            if not (merged.added or merged.updated) or base is None:
                raise
            # Past a limit with what was added back: the copy alone, and
            # every record added back is reported (it stays in the damaged file).
            _log(f"the restored catalog is past a limit ({exc}); restoring the copy alone")
            merged.not_added.extend({"id": row["id"], "reason": "size"} for row in [*merged.added, *merged.updated])
            merged.added, merged.updated = [], []
            catalog = copy.deepcopy(base)
            catalog["workspaceRevision"] = uuid4().hex
            if catalog.get("activeProjectId") not in catalog["projects"]:
                catalog["activeProjectId"] = None
            temporary = self.prepare(catalog)
        try:
            self.commit_prepared(temporary)
        finally:
            temporary.unlink(missing_ok=True)
        for path, kept in kept_copies:
            # A damaged copy the commit didn't replace (the older one) goes,
            # so it is never read again; its bytes stay in the kept file.
            try:
                if path.exists() and os.path.samefile(path, kept):
                    path.unlink()
            except OSError as exc:
                _log(f"could not take the damaged {path.name} out of use: {exc}")
        for row in merged.added:
            _log(f"added back {row['id']} \"{row['name']}\"{' (in Recently deleted)' if row['trashed'] else ''}")
        for row in merged.updated:
            _log(f"took the damaged file's newer {row['id']} \"{row['name']}\""
                 f"{' (in Recently deleted)' if row['trashed'] else ''}")
        for row in merged.not_added:
            _log(f"could not add back {row['id']} ({row['reason']}); it stays in the damaged file")
        if merged.open_project_missing:
            _log(f"the open project {merged.open_project_missing} didn't come back; no project is open")
        _log(f"{kind} the project list: {len(catalog['projects'])} projects, "
             f"{len(catalog.get('trash') or {})} in Recently deleted")
        record = {
            "id": uuid4().hex, "at": moment.isoformat(), "kind": kind, "reason": damage.reason,
            "detail": str(damage)[:300], "source": source, "damagedFile": damaged_file, "setAside": set_aside,
            "addedBack": merged.added[:RECORD_ROWS], "addedBackCount": len(merged.added),
            "updatedFromDisk": merged.updated[:RECORD_ROWS], "updatedFromDiskCount": len(merged.updated),
            "notAddedBack": merged.not_added[:RECORD_ROWS], "notAddedBackCount": len(merged.not_added),
            "projectCount": len(catalog["projects"]), "trashCount": len(catalog.get("trash") or {}),
            "openProject": catalog.get("activeProjectId"), "openFrom": merged.active_from,
            "openProjectMissing": merged.open_project_missing, "dismissedAt": None,
        }
        try:
            self._record_restore(record)
        except Exception as exc:  # noqa: BLE001 - the catalog is restored; the notice is what's lost
            _log(f"the restore could not be recorded for the notice: {exc}")
        pending = getattr(self._local, "announce", None)
        if pending is None:
            pending = self._local.announce = []
        pending.append(record)

    def _announce(self) -> None:
        pending, self._local.announce = getattr(self._local, "announce", None) or [], []
        for record in pending:
            if self.on_restore is None:
                continue
            try:
                self.on_restore(copy.deepcopy(record))
            except Exception as exc:  # noqa: BLE001 - telling is decoration on a restore that happened
                _log(f"announcing the restore failed: {exc}")

    def _records(self) -> list[dict[str, Any]]:
        try:
            found = json.loads(self.record_path.read_text(encoding="utf-8"))
        except FileNotFoundError:
            return []
        except (OSError, ValueError) as exc:
            _log(f"{RESTORE_RECORD_NAME} could not be read ({exc})")
            return []
        restores = found.get("restores") if isinstance(found, dict) else None
        return [entry for entry in restores if isinstance(entry, dict)] if isinstance(restores, list) else []

    def _write_records(self, restores: list[dict[str, Any]]) -> None:
        encoded = json.dumps({"version": 1, "restores": restores[-RESTORES_KEPT:]}, ensure_ascii=False,
                             indent=1).encode("utf-8")
        self._write_file(self.record_path, encoded)

    def _record_restore(self, record: dict[str, Any]) -> None:
        if self.record_path.exists() and not self._records():
            try:  # unreadable: keep it, as every damaged file is kept
                self._set_aside(self.record_path, uuid4().hex[:8])
            except OSError:
                pass
        self._write_records([*self._records(), record])

    def restore_notice(self) -> dict[str, Any] | None:
        """The newest restore, as recorded, while the person hasn't dismissed
        it (an older one is behind it: the notice is about the latest)."""
        restores = self._records()
        return restores[-1] if restores and not restores[-1].get("dismissedAt") else None

    def dismiss_restore(self, record_id: str) -> bool:
        """The person closed the notice: it isn't shown again. False when
        ``record_id`` isn't the restore the notice shows."""
        try:
            with self._locked():
                restores = self._records()
                if not restores or restores[-1].get("id") != record_id or restores[-1].get("dismissedAt"):
                    return False
                restores[-1]["dismissedAt"] = now()
                self._write_records(restores)
                return True
        except OSError as exc:
            raise ProjectStoreError("Project storage is unavailable; the canvas was preserved") from exc

    # -- the last good copy -------------------------------------------------------

    def _write_file(self, target: Path, encoded: bytes) -> None:
        """Write ``target`` whole: a private temporary file, fsync, rename."""
        temporary = self.root / f".catalog-backup.{uuid4().hex}.tmp"
        try:
            fd = os.open(temporary, os.O_CREAT | os.O_EXCL | os.O_WRONLY, 0o600)
            with os.fdopen(fd, "wb") as handle:
                handle.write(encoded)
                handle.flush()
                os.fsync(handle.fileno())
            os.replace(temporary, target)
        finally:
            temporary.unlink(missing_ok=True)

    def _write_backup(self, encoded: bytes) -> None:
        """Keep ``encoded`` (a catalog _check accepted, as committed) as the
        last good copy, and as the older copy too when that is missing or
        over an hour old. Called after the commit's rename; raises OSError."""
        self._write_file(self.backup_path, encoded)
        try:
            age = time.time() - self.older_backup_path.stat().st_mtime
        except FileNotFoundError:
            age = None
        if age is None or age >= OLDER_BACKUP_SECONDS:
            self._write_file(self.older_backup_path, encoded)

    def _seed_backup(self, raw: bytes) -> None:
        try:
            self._write_backup(raw)
            _log("kept a first copy of catalog.json")
        except Exception as exc:  # noqa: BLE001 - a read never fails for its copy
            _log(f"could not keep a copy of catalog.json: {exc}")

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
        # Which project is open goes first, so a file cut short still says
        # (services/catalog_recovery.py); the rest keep their order.
        ordered = {key: catalog[key] for key in _HEAD_KEYS if key in catalog}
        ordered.update((key, value) for key, value in catalog.items() if key not in ordered)
        encoded = json.dumps(ordered, ensure_ascii=False, allow_nan=False, separators=(",", ":")).encode("utf-8")
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
            # The same check decides that these bytes may become the last good
            # copy: one _read would refuse never replaces it.
            self._check(catalog, fill=False)
            view = _projection(catalog, None)
            stored = json.loads(json.dumps(view.pins, ensure_ascii=False, allow_nan=False))
            self._prepared = (temporary, view._replace(pins=tuple(stored)), encoded)
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
            if written is not None and prepared is not None:
                # The commit is made; now its last good copy. A process that
                # dies here leaves the copy one commit behind, which a restore
                # makes up from the damaged file (catalog_recovery). Never
                # fails the commit: the next one writes the copy again.
                try:
                    self._write_backup(prepared[2])
                    os.fsync(fd)
                except Exception as exc:  # noqa: BLE001 - the commit itself landed
                    _log(f"could not keep the last good copy of catalog.json: {exc}")
        finally:
            os.close(fd)

    def commit(self, catalog: dict[str, Any]) -> None:
        temporary = self.prepare(catalog)
        try:
            self.commit_prepared(temporary)
        finally:
            temporary.unlink(missing_ok=True)
