"""Private, disk-backed canvas projects and their active workspace identity.

A single catalog commit keeps metadata, snapshots and the active revision
together. Callers stage graph validation before preparing a catalog commit.

Every project lives whole in catalog.json; there are no per-project folders.
So every commit keeps two copies (2026-10-27, PR #199):
- catalog.json.bak: the catalog the commit replaced, as a hard link made
  just before the rename, and only when it is the file this transaction
  read and validated. So it is one commit behind, and costs no bytes.
  Where hard links fail it is a real copy of each commit instead;
- catalog.json.bak.1: a real copy of a committed catalog, rewritten on the
  first commit after it is an hour old. So it is at least an hour behind
  .bak, and can be days old after a pause; a separate file, so damage to
  one inode can't take both.
A read that finds catalog.json damaged (it won't parse or validate) or
missing while a copy exists restores it (_recover): the damaged file is kept
beside it (a few are kept: _prune_damaged), the good copy holding the
newest catalog comes back with what the damaged file still holds that is
newer (services/
catalog_recovery.py), and the restore is recorded once for the person and
agents (catalog-restore.json, restore_notice), with what an older copy
decided (an edit reverted, a deleted project back). Projects deleted for
good are remembered for a week (``purged``) so a restore from an older copy
leaves them deleted. With no good copy the list is rebuilt from what the
damaged files hold; only when they hold no project at all does the read
refuse, as before. A catalog from a newer Nebula (version above 1) is not
damage: it refuses and nothing changes.

Reads stay cheap (review 2 of PR #199, M1): a file this process committed
(its signature is the projection's) is decoded by the C decoder, refusing
only NaN and the infinities; the strict read (a number past float's range,
a lone surrogate) runs only for a file changed elsewhere. A reader on the
event loop never restores or waits for one (hand_off_restore).
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
import zlib
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
# The last good copies of catalog.json: .bak, the catalog each commit
# replaced (a hard link, commit_prepared), and .bak.1, a real copy rewritten
# on the first commit after it is an hour old (_write_older_backup), for when
# .bak is damaged too. A third would add a full copy of an even older state.
BACKUP_NAME = "catalog.json.bak"
OLDER_BACKUP_NAME = "catalog.json.bak.1"
OLDER_BACKUP_SECONDS = 3600
# Damaged files kept beside the catalog (_prune_damaged). Each can be a whole
# catalog (128 MB), and a loop that keeps damaging it would keep one per
# restore. Kept: the one this restore made, the one the notice the person
# hasn't closed names, the newest DAMAGED_KEPT_MIN of each kind (for
# support, whatever their age), and any younger than DAMAGED_KEPT_DAYS (time
# for the person to see the notice and ask), DAMAGED_KEPT_MAX at most.
DAMAGED_KEPT_MIN = 3
DAMAGED_KEPT_DAYS = 14
DAMAGED_KEPT_MAX = 10
# Projects deleted for good (``purged``: id -> when), so a restore from a copy
# that predates the delete leaves them deleted. .bak is one commit behind and
# .bak.1 is rewritten on the first commit after an hour, so a week covers
# both with room for copies that failed to write; past a thousand the oldest go.
PURGED_KEPT_DAYS = 7
PURGED_KEPT_MAX = 1000
# Temporary files a crash left (a commit, a copy, a kept damaged file):
# swept at startup once they are a day old (sweep_orphans).
ORPHAN_SECONDS = 86400
_ORPHAN_PATTERNS = (".catalog.*.tmp", ".catalog-backup.*.tmp", ".catalog-bak.*.tmp", ".damaged.*.tmp")
# Restores, newest last, for the notice and support (ProjectStore._record_restore).
RESTORE_RECORD_NAME = "catalog-restore.json"
RESTORES_KEPT = 10
# The live canvas waiting to be filed (main._mark_canvas_not_filed), across
# restarts; a second copy (".bak") so a damaged or missing one keeps its
# `since` and its one journal event (review 4 of PR #199, N-1).
CANVAS_WAITING_NAME = "canvas-waiting.json"
CANVAS_WAITING_BACKUP_NAME = CANVAS_WAITING_NAME + ".bak"
# The projects deleted for good as the latest commit left them (its
# `purged`), written right after each commit that changes them: .bak is one
# commit behind, so a delete for good as the last commit, then a catalog.json
# damaged past its head, brought the project back to Recently deleted with no
# line (review 4 of PR #199, L-3). Read by a restore only.
PURGED_NAME = "catalog-purged.json"
PURGED_FILE_MAX_BYTES = 1024 * 1024
# Whether a restore from Recently deleted (the person's Undo, or Restore in
# the list) may take the list past MAX_PROJECTS. GM (r6) prefers yes, since
# the limit is for new projects; Justin hasn't decided, so it is refused
# with the limit's 413 (main._refuse_a_restore_past_the_limit). This is the
# one switch: with it on, that refusal goes, and prepare's cap counts only
# projects new to the list, so later saves of the list past the limit still
# land and a new project is still refused.
RESTORE_MAY_PASS_THE_PROJECT_LIMIT = False
RECORD_ROWS = 100  # names listed per restore; the counts are whole
# The fields prepare writes first, so a cut file still says which project was open.
_HEAD_KEYS = ("version", "activeProjectId", "workspaceRevision", "migratedProjectId", "purged")
# Every read refuses NaN, Infinity and -Infinity (parse_constant: free on the
# C decoder). A file this process didn't commit (or a copy) is also read
# strictly: a number past float's range and a lone surrogate are refused too
# (catalog_recovery.loads, writable), which costs a Python call per float and
# a re-encode, so never on the hot path (review 2 of PR #199, M1).
_DECODER = json.JSONDecoder(parse_constant=catalog_recovery.reject_constant)
# What a raw catalog holding an escaped lone surrogate must contain (the
# bytes decode as UTF-8, so a raw one is refused before this).
_ESCAPE = b"\\u"
# What projection() returns to a reader on the event loop while a restore it
# handed off runs, when nothing was read before (hand_off_restore).
RESTORING_REVISION = "restoring"
UNREADABLE = "Project catalog could not be read; the existing file was preserved"


class ProjectStoreError(Exception):
    pass


class _HandedOff(Exception):
    """projection(): the restore of a damaged catalog.json was handed off
    to a worker thread (hand_off_restore), so this reader answers the last
    projection instead of restoring or waiting."""


class _Damaged(Exception):
    """catalog.json won't parse or validate (``raw`` holds what it does
    hold), or is missing while a copy exists. ``reason``: "corrupt" (not
    JSON, or a value the store can't write back), "invalid" (JSON of the
    wrong shape) or "missing". ``parsed``: what it decoded to, or None when
    it didn't, so salvage doesn't decode it again."""

    def __init__(self, reason: str, detail: str, raw: bytes | None = None, parsed: Any = None,
                 *, ours: bool = False) -> None:
        super().__init__(detail)
        self.reason = reason
        self.raw = raw
        self.parsed = parsed
        # The file is the one this process last committed or read whole (its
        # signature): a version it now says above 1 was changed in place,
        # since a newer Nebula commits by rename (a new inode): damage.
        self.ours = ours


def _newer_version(result: Any) -> bool:
    """A catalog a newer Nebula wrote (an integer version above 1): not ours
    to restore or rewrite (review 1, L4)."""
    version = result.get("version") if isinstance(result, dict) else None
    return isinstance(version, int) and not isinstance(version, bool) and version > 1


NEWER_VERSION = ("The project list was saved by a newer version of Nebula, so this one won't read or change it. "
                 "Nothing changed. Open it with that version.")


def _log(message: str) -> None:
    print(f"[projects] {message}", flush=True)


# A kept damaged file's name says when it was kept: ``<name>.damaged-<UTC>-<id>``.
_STAMP_FORMAT = "%Y%m%dT%H%M%SZ"
_KEPT_AT = re.compile(r"\.damaged-(\d{8}T\d{6}Z)")


def _stamp(moment: datetime) -> str:
    return f"{moment.strftime(_STAMP_FORMAT)}-{uuid4().hex[:8]}"


def _kept_at(path: Path) -> float:
    """When a damaged file was kept: the time in its name. A hard link keeps
    the damaged file's own mtime, which can be weeks older (review 2, L7);
    only a name without a time falls back to it."""
    match = _KEPT_AT.search(path.name)
    if match:
        try:
            return datetime.strptime(match.group(1), _STAMP_FORMAT).replace(tzinfo=timezone.utc).timestamp()
        except ValueError:
            pass
    return path.stat().st_mtime


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
    # When it came back, so a restore of a damaged list knows this is newer
    # than the copy's record in Recently deleted (catalog_recovery.freshness).
    entry["restoredAt"] = now()
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


def recovered_name(source_name: str, catalog: dict[str, Any]) -> str:
    """A recovered copy's name (GM - Design, round 21 of PR #195, G5; and
    the live canvas filed after a restore, PR #199 GM r3): "<project>
    (recovered)", then "(recovered 2)", 3 and so on, one past the highest
    the project's copies have in the list or Recently deleted, so a new copy
    never takes an earlier one's name."""
    stem = f"{source_name[:100]} (recovered"
    pattern = re.compile(re.escape(stem) + r"(?: (\d+))?\)")
    highest = 0
    for listing in (catalog.get("projects") or {}, catalog.get("trash") or {}):
        for project in listing.values():
            match = pattern.fullmatch(str((project or {}).get("name") or ""))
            if match:
                highest = max(highest, int(match.group(1) or 1))
    return f"{stem})" if highest == 0 else f"{stem} {highest + 1})"


RECOVERED_CANVAS_NAME = "Recovered canvas"


def recovered_canvas_name(catalog: dict[str, Any]) -> str:
    """The name of a live canvas filed when which project it was isn't
    known (GM r5 of PR #199): "Recovered canvas", then "Recovered canvas 2",
    3 and so on, one past the highest in the list or Recently deleted, so two
    such filings are never named alike."""
    pattern = re.compile(re.escape(RECOVERED_CANVAS_NAME) + r"(?: (\d+))?")
    highest = 0
    for listing in (catalog.get("projects") or {}, catalog.get("trash") or {}):
        for project in listing.values():
            match = pattern.fullmatch(str((project or {}).get("name") or ""))
            if match:
                highest = max(highest, int(match.group(1) or 1))
    return RECOVERED_CANVAS_NAME if highest == 0 else f"{RECOVERED_CANVAS_NAME} {highest + 1}"


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
    # The file's bytes as read or written here (zlib.crc32), so a rewrite in
    # place that keeps (inode, mtime, size) still gets the strict read
    # (review 3 of PR #199, L-6). None when not known yet.
    digest: int | None = None


def file_signature(info: os.stat_result) -> tuple[int, int, int, int]:
    """A catalog file's (inode, mtime, size, ctime). Every commit replaces
    the file, so the inode says when; ctime is set by the kernel on every
    write and every change of times, so a rewrite in place that puts the
    mtime back (rsync --inplace -t, cp -p onto it) changes it too, and
    needs_reading() and projection() see it without reading the file
    (review 4 of PR #199, N-3). Bit rot changes none of them: _load's crc
    of the bytes catches it at the next read under the lock."""
    return (info.st_ino, info.st_mtime_ns, info.st_size, info.st_ctime_ns)


def _projection(catalog: dict[str, Any], signature: tuple[int, int, int] | None) -> Projection:
    project_id = catalog.get("activeProjectId")
    project = catalog["projects"].get(project_id) if project_id else None
    pins = tuple(pin for pin in (project or {}).get("pins") or [] if isinstance(pin, dict))
    return Projection(signature, project_id, catalog["workspaceRevision"], str((project or {}).get("name") or ""), pins)


def _waiting_record(found: Any) -> dict[str, Any] | None:
    """canvas-waiting.json's record when its fields are what main writes:
    {reason (projects | storage), from (an id or None), since (a dated
    time), journaled (a bool)}, or {saved: {id, name, at}}; else None."""
    if not isinstance(found, dict):
        return None
    saved = found.get("saved")
    if "saved" in found:
        if isinstance(saved, dict) and isinstance(saved.get("id"), str) and isinstance(saved.get("name"), str) \
                and catalog_recovery.dated(saved.get("at")):
            return {"saved": {"id": saved["id"], "name": saved["name"], "at": saved["at"]}}
        return None
    owner = found.get("from")
    if found.get("reason") not in ("projects", "storage") or not catalog_recovery.dated(found.get("since")) \
            or not isinstance(found.get("journaled"), bool) or not (owner is None or isinstance(owner, str)):
        return None
    return {"reason": found["reason"], "from": owner, "since": found["since"], "journaled": found["journaled"]}


class ProjectStore:
    def __init__(self, root: Path) -> None:
        self.root = root
        self.path = root / "catalog.json"
        self._initial_revision = uuid4().hex
        # The projection of the catalog file last read or committed here, and
        # the one a prepared commit will make (see projection()).
        self._projection: Projection | None = None
        # What prepare wrote, for commit_prepared: the temporary file, its
        # projection and its bytes (the older copy is written from them).
        self._prepared: tuple[Path, Projection, bytes] | None = None
        self.backup_path = root / BACKUP_NAME
        self.older_backup_path = root / OLDER_BACKUP_NAME
        self.record_path = root / RESTORE_RECORD_NAME
        # Called once per restore with its record, after the lock is let go
        # (main._on_catalog_restore journals it and tells open tabs).
        self.on_restore: Callable[[dict[str, Any]], None] | None = None
        # Which project the live canvas is (main._canvas_owner_for_restore): a
        # restore opens that one, or none, never the copy's (review 1, H1).
        # catalog_recovery.UNKNOWN, or no callback, when it isn't recorded.
        self.canvas_owner: Callable[[], Any] | None = None
        # A reader that finds catalog.json damaged asks this first (main's
        # _hand_off_catalog_restore): True when the restore was handed to a
        # worker thread (the reader is on the event loop), and projection()
        # then answers the last projection rather than restore or wait for
        # the lock (review 2 of PR #199, L2).
        self.hand_off_restore: Callable[[], bool] | None = None
        # Whether a worker thread is reading this catalog file (its
        # signature) for a reader on the event loop: projection() then
        # answers the last projection instead of parsing the file itself
        # (fix round 2, L2: a damaged 102 MB file held the loop 1.6 s in the
        # parse that finds the damage, before any hand-off could start).
        self.read_in_flight: Callable[[tuple[int, int, int]], bool] | None = None
        # The catalog file projection() last found damaged (its signature):
        # while a hand-off for it runs, a reader skips parsing it again (at
        # 100 MB a failed parse alone holds the loop for a second).
        self._damaged_signature: tuple[int, int, int] | None = None
        # The catalog file _load last parsed and validated, and its bytes'
        # crc32: projection() keeps it with the projection it makes.
        self._verified: tuple[tuple[int, int, int], int] | None = None
        # The catalog file this process last committed or read whole, as
        # version 1 (its signature): a version above 1 in that very file was
        # written in place, which a newer Nebula never does (review 3, L-1).
        self._own_signature: tuple[int, int, int] | None = None
        # The purged map the commit being prepared carries (its temporary
        # file, the map), and catalog-purged.json as last read or written
        # here (its signature, its map): kept in step after each commit.
        self._prepared_purged: tuple[Path, dict[str, str]] | None = None
        self._side_purged: tuple[Any, dict[str, str]] | None = None
        # This thread's hold on .lock: its depth (only _recover reads inside
        # a hold: flock from a second descriptor would wait on itself), the
        # restores to announce once it is let go, the catalog file this hold
        # read and validated (its signature: .bak links only that), and the
        # project ids it read (a commit that drops one remembers it, purged).
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
        for key, value in result.items():
            # A section whose name was damaged ("trasi"): its projects would
            # vanish from the list unseen (review 2, M2).
            if key not in catalog_recovery.CATALOG_FIELDS and catalog_recovery.holds_records(value):
                raise ValueError(f"Invalid catalog: projects outside the list, under {key!r}")

    def _empty(self) -> dict[str, Any]:
        return {"version": 1, "projects": {}, "activeProjectId": None, "workspaceRevision": self._initial_revision}

    @staticmethod
    def _parse(raw: bytes, *, committed_here: bool = False) -> Any:
        """``raw`` decoded as a catalog may hold it. Raises ValueError for
        anything else, including a value the store reads but can't write
        back (NaN, Infinity, 1e999, a lone surrogate: review 1, L2): those
        would make every later commit fail.

        ``committed_here``: a file this process committed or already read
        whole (its signature is the projection's): prepare encoded it with
        allow_nan=False as UTF-8, so only NaN and the infinities are checked
        (no cost). Any other file is read strictly (review 2, M1)."""
        text = raw.decode("utf-8")
        try:
            if committed_here:
                return _DECODER.decode(text)
        except RecursionError as exc:
            raise ValueError("nested too deeply") from exc
        result = catalog_recovery.loads(text)
        if _ESCAPE in raw and not catalog_recovery.writable(result):
            raise ValueError("holds a value that can't be written back")
        return result

    def _load(self, *, upgrade: bool) -> tuple[dict[str, Any], bytes | None]:
        """catalog.json as _check accepts it, and its bytes (None for the
        empty catalog of a fresh install). Raises _Damaged for a file that
        won't parse or validate, or that is missing while a copy exists, and
        ProjectStoreError for one that can't be read at all (a symbolic
        link, too large, an I/O error) or is a newer Nebula's, as before:
        those are not restored."""
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
            with open(self.path, "rb") as handle:
                info = os.fstat(handle.fileno())
                raw = handle.read()
        except FileNotFoundError:
            raise _Damaged("missing", "catalog.json is missing") from None
        except OSError as exc:
            raise ProjectStoreError(UNREADABLE) from exc
        cached = self._projection
        signature = file_signature(info)
        # This process's own file, rewritten in place or not: ctime (the
        # signature's last part) changes with any write, so it is left out.
        ours = self._own_signature is not None and self._own_signature[:3] == signature[:3]
        digest = zlib.crc32(raw)
        # The fast read only for the very bytes this process wrote or read:
        # a rewrite in place that kept the signature (rsync --inplace -t,
        # cp -p onto it, bit rot) is read strictly, and the projection,
        # which may no longer describe it, is dropped (review 3, L-6).
        committed_here = cached is not None and cached.signature == signature and cached.digest == digest
        if cached is not None and cached.signature == signature and cached.digest is not None \
                and cached.digest != digest:
            _log("catalog.json changed in place since this process read it; reading it strictly")
            self._projection = None
        try:
            result = self._parse(raw, committed_here=committed_here)
        except ValueError as exc:
            raise _Damaged("corrupt", f"not JSON: {exc}", raw, ours=ours) from exc
        if _newer_version(result):
            if ours:
                # This process wrote (or read) this file as version 1, and a
                # newer Nebula commits by rename: its version changed in place
                # (a bit flip: 1 -> 3, 5 or 9). Damage, not a newer Nebula's
                # (review 3, L-1).
                _log(f"catalog.json says version {result.get('version')}, but this process saved it as version 1 "
                     "and it was changed in place: damaged")
                raise _Damaged("invalid", f"version {result.get('version')} written in place", raw, result, ours=True)
            _log(f"catalog.json is version {result.get('version')}, from a newer Nebula: not reading it"
                 + self._older_copy_hint())
            raise ProjectStoreError(NEWER_VERSION)
        try:
            self._check(result)
        except (ValueError, TypeError, AttributeError) as exc:
            raise _Damaged("invalid", f"not a catalog: {exc}", raw, result, ours=ours) from exc
        if cached is not None and cached.signature == signature and cached.digest is None:
            # Read strictly once: now its bytes are known, later reads are fast.
            self._projection = cached._replace(digest=digest)
        self._verified = (signature, digest)
        self._own_signature = signature
        if getattr(self._local, "depth", 0):
            # Read and validated under this hold: .bak may become this file.
            self._local.validated = signature
            self._local.ids = set(result["projects"]) | set(result.get("trash") or {})
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

    def _read(self, *, upgrade: bool = True, hand_off: bool = False,
              signature: tuple[int, int, int] | None = None) -> dict[str, Any]:
        """catalog.json, restored first when it is damaged. ``hand_off``
        (projection()): a damaged file is noted by ``signature``, the one
        taken before reading it (None: missing), and when hand_off_restore
        takes its restore (a reader on the event loop), _HandedOff is raised
        instead of restoring."""
        try:
            return self._load(upgrade=upgrade)[0]
        except _Damaged as damage:
            if hand_off:
                self._damaged_signature = signature
                if self._handed_off():
                    raise _HandedOff from None
            return self._recover(damage, upgrade=upgrade)[0]

    @contextmanager
    def _locked(self, *, nested: bool = False) -> Iterator[None]:
        """Hold .lock (serializes catalog commits across requests and
        processes). Restores made while it was held are announced once it
        lets go. Raises OSError.

        Only ``nested`` holds (_recover's read inside a transaction that
        finds the file damaged) may sit inside another hold of this thread.
        A nested transaction() would commit, then the outer one would commit
        over it from what it read before: it raises instead (review 1, L3)."""
        depth = getattr(self._local, "depth", 0)
        if depth:
            if not nested:
                raise RuntimeError("ProjectStore: a nested transaction would lose the inner one's commit; "
                                   "this thread already holds the catalog lock")
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
                    self._local.validated = None
                    self._local.ids = None
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

    def needs_reading(self) -> bool:
        """Whether catalog.json changed since this store last read or wrote
        it (no projection for its signature): the next reader parses it, and
        restores it if it is damaged. main reads it in a worker thread first,
        so a long restore doesn't hold up the event loop (review 1, L5)."""
        try:
            signature = self._signature()
        except ProjectStoreError:
            return False
        if signature is None:
            return not self.path.exists() and (self.backup_path.exists() or self.older_backup_path.exists())
        cached = self._projection
        return cached is None or cached.signature != signature

    # -- recovering a damaged catalog -------------------------------------------

    def _recover(self, damage: _Damaged, *, upgrade: bool) -> tuple[dict[str, Any], bytes | None]:
        """catalog.json after restoring it, under the lock. A reader that
        waited for the lock reads the file again first: another request (or
        process) may have restored it meanwhile, and one restore is enough."""
        try:
            with self._locked(nested=True):
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
        holds that the copy lacks or holds newer, and records the restore
        with what the copy decided. Raises ProjectStoreError, changing
        nothing, when there is nothing to put back, when what it would put
        back is past a limit and there is no copy to fall back on, or when a
        file is a newer Nebula's."""
        _log(f"catalog.json can't be used ({damage.reason}: {damage}); restoring it")
        # This restore's commit drops nothing the person deleted: projects it
        # can't bring back are not "deleted for good".
        self._local.ids = None
        base: dict[str, Any] | None = None
        base_raw: bytes | None = None
        source: str | None = None
        copy_at: str | None = None
        damaged_copies: list[tuple[Path, bytes, Any]] = []
        # Every copy is read: the base is .bak, the newer by construction (a
        # link of the catalog the last commit replaced, or a copy of every
        # commit where links fail), unless .bak.1 holds later dates (a .bak a
        # sync tool or a person put back: review 2, L3). Dates are the
        # copies' own (catalog_recovery.catalog_freshness; every change
        # Nebula makes moves one), never one after this restore's clock: a
        # clock that ran ahead when .bak.1 was written made it the base, and
        # the next commit erased a project only .bak held (review 4, M-3).
        # Not by mtime: a copy made by hand or a sync tool has a new one.
        clock = datetime.now(timezone.utc)
        valid: list[tuple[Any, float, int, Path, bytes, dict[str, Any]]] = []
        newer_copies: list[tuple[Path, bytes, Any]] = []
        mtimes: dict[Path, float] = {}
        for order, path in enumerate((self.backup_path, self.older_backup_path)):
            raw = self._copy_bytes(path)
            if raw is None:
                continue
            try:
                mtimes[path] = path.stat().st_mtime
            except OSError:
                mtimes[path] = 0.0
            try:
                candidate = self._parse(raw)
            except ValueError as exc:
                _log(f"{path.name} is damaged too ({exc})")
                damaged_copies.append((path, raw, None))
                continue
            if _newer_version(candidate):
                # Decided below, with catalog.json's own head and the other
                # copy (review 3, L-1): a bit flip in "version" reads as a
                # newer Nebula's.
                newer_copies.append((path, raw, candidate))
                continue
            try:
                self._check(candidate)
            except (ValueError, TypeError, AttributeError) as exc:
                _log(f"{path.name} is damaged too ({exc})")
                damaged_copies.append((path, raw, candidate))
                continue
            freshest = catalog_recovery.catalog_freshness(candidate, until=clock)
            valid.append((freshest.timestamp() if freshest else float("-inf"), -order, path, raw, candidate))
        if valid:
            *_order, chosen, base_raw, base = max(valid, key=lambda row: row[:2])
            source = chosen.name
            if len(valid) > 1:
                _log(f"both copies are good; {source} holds the newer catalog")
            # When the copy's catalog was committed: .bak keeps the replaced
            # file's own time (a hard link), .bak.1 is written right after
            # its commit.
            copy_at = datetime.fromtimestamp(mtimes[chosen], timezone.utc).isoformat() if mtimes[chosen] else None
        # Newest first: the damaged catalog, then the copies that failed and
        # are no older than the base (an older one would add back what was
        # deleted since; it is still kept below).
        salvages = []
        head = catalog_recovery.salvage(damage.raw, damage.parsed) if damage.raw is not None else None
        if head is not None:
            salvages.append(head)
        head_version = head.version if head is not None else catalog_recovery.UNKNOWN
        if head is not None and _newer_version({"version": head_version}) and not damage.ours:
            _log("the damaged catalog.json says it is from a newer Nebula: not restoring over it"
                 + self._older_copy_hint())
            raise ProjectStoreError(NEWER_VERSION)
        # A copy that says a newer version is damage, not a newer Nebula's,
        # when something contradicts it (review 3, L-1: one bit makes
        # version 1 read 3, 5 or 9): catalog.json's own head says version 1
        # (a newer Nebula writes catalog.json first, and the copies after
        # it), catalog.json is this process's own file, or another copy can
        # do the restore (a bad version in one copy never blocks a restore
        # the other can do). Only with none of those does it refuse.
        contradicted = head_version == 1 or damage.ours or bool(valid)
        for path, raw, candidate in newer_copies:
            if not contradicted:
                _log(f"{path.name} is from a newer Nebula: not restoring over it")
                raise ProjectStoreError(NEWER_VERSION)
            _log(f"{path.name} says version {candidate.get('version')}, which "
                 f"{'catalog.json says it is not' if head_version == 1 else 'the other copy contradicts'}: "
                 "damaged too")
            damaged_copies.append((path, raw, candidate))
        version_damaged = {path for path, _raw, _candidate in newer_copies}
        base_mtime = mtimes.get(self.root / source) if source else None
        copy_salvages = [(path, catalog_recovery.salvage(raw, parsed)) for path, raw, parsed in
                         sorted(damaged_copies, key=lambda row: -mtimes.get(row[0], 0.0))
                         if base_mtime is None or mtimes.get(path, 0.0) >= base_mtime]
        salvages.extend(found for _path, found in copy_salvages)
        for path, found in copy_salvages:
            version = found.version
            if path in version_damaged:
                continue
            if isinstance(version, int) and not isinstance(version, bool) and version > 1 and not contradicted:
                _log(f"the damaged {path.name} says it is from a newer Nebula: not restoring over it")
                raise ProjectStoreError(NEWER_VERSION)
        kind = "restored" if base is not None else "rebuilt"
        moment = clock
        stamp = _stamp(moment)
        if base is None and not any(found.entries for found in salvages):
            if damage.raw is None:
                # catalog.json is gone and every copy is damaged and empty of
                # projects: keep the copies, then start from an empty list as
                # a missing catalog always did (a refusal would last forever).
                for path, _raw, _parsed in damaged_copies:
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
            base_bytes = len(json.dumps(base, separators=(",", ":")).encode("utf-8"))
            _log("no good copy: rebuilding the list from the projects the damaged files still hold")
        else:
            # The copy was written compact by prepare, so its own size is
            # what it encodes to (no second encoding of a large catalog).
            base_bytes = len(base_raw or b"")
            _log(f"restoring from {source}")
        owner = catalog_recovery.UNKNOWN
        if self.canvas_owner is not None:
            try:
                owner = self.canvas_owner()
            except Exception as exc:  # noqa: BLE001 - unknown, so nothing is opened on its say
                _log(f"which project the live canvas is couldn't be read ({exc})")
                owner = None
        fallback = copy.deepcopy(base) if kind == "restored" else None
        # Room for what is added back: the limit less the copy, its head
        # (purged, at most PURGED_KEPT_MAX short entries) and a margin.
        room = MAX_CATALOG_BYTES - base_bytes - PURGED_KEPT_MAX * 80 - 4096
        merged = catalog_recovery.reconcile(base, salvages, max_projects=MAX_PROJECTS, room_bytes=room,
                                            open_project=owner, until=clock,
                                            side_purged=self._read_purged_file(), side_index=1 if head is not None else 0)
        catalog = merged.catalog
        catalog["version"] = 1
        # Open tabs hold the list as it was: a new revision makes them reload.
        catalog["workspaceRevision"] = uuid4().hex
        try:
            self._check(catalog)
        except (ValueError, TypeError) as exc:  # a bug in reconcile: change nothing
            _log(f"the restored catalog doesn't validate ({exc}); nothing changed")
            raise ProjectStoreError(UNREADABLE) from exc
        # Written to a temporary file first: past a limit, nothing has changed.
        try:
            temporary = self.prepare(catalog)
        except ProjectLimitError as exc:
            if fallback is None or not (merged.added or merged.updated):
                # A rebuild has no copy to fall back on (review 1, L1): the
                # 507, and nothing is kept, written or recorded.
                _log(f"the {'rebuilt' if fallback is None else 'restored'} catalog is past a limit ({exc}); "
                     "nothing changed")
                raise
            # Past a limit with what was added back: the copy alone, and
            # every record added back is reported (it stays in the damaged file).
            _log(f"the restored catalog is past a limit ({exc}); restoring the copy alone")
            merged.not_added.extend({"id": row["id"], "reason": "size", "name": row["name"],
                                     "trashed": row["trashed"]} for row in [*merged.added, *merged.updated])
            merged.added, merged.updated = [], []
            catalog = fallback
            catalog["version"] = 1
            catalog["workspaceRevision"] = uuid4().hex
            purged = merged.catalog.get("purged") or {}
            for project_id in purged:  # deleted for good stays so
                catalog["projects"].pop(project_id, None)
                (catalog.get("trash") or {}).pop(project_id, None)
            if purged:
                catalog["purged"] = purged
            # The same open project as reconcile chose, if the copy alone has it.
            wanted = merged.catalog.get("activeProjectId")
            catalog["activeProjectId"] = wanted if wanted in catalog["projects"] else None
            if catalog["activeProjectId"] is None:
                merged.active_from = "none"
            if catalog.get("migratedProjectId") not in catalog["projects"]:
                catalog.pop("migratedProjectId", None)
            temporary = self.prepare(catalog)
        # Every damaged file is kept before anything replaces it.
        set_aside: list[str] = []
        damaged_file: str | None = None
        kept_copies: list[tuple[Path, Path]] = []
        try:
            if damage.raw is not None:
                damaged_file = str(self._set_aside(self.path, stamp))
                set_aside.append(damaged_file)
                _log(f"kept the damaged catalog as {damaged_file}")
            for path, _raw, _parsed in damaged_copies:
                kept = self._set_aside(path, stamp)
                kept_copies.append((path, kept))
                set_aside.append(str(kept))
                _log(f"kept the damaged copy {path.name} as {kept}")
            self.commit_prepared(temporary)
        finally:
            temporary.unlink(missing_ok=True)
        for path, kept in kept_copies:
            # A damaged copy goes, so it is never read again; its bytes stay
            # in the kept file. The next transaction seeds a good .bak.
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
            _log(f"could not add back {row['id']} ({row['reason']}){' from Recently deleted' if row.get('trashed') else ''}; "
                 "it stays in the damaged file")
        for row in merged.reverted:
            _log(f"{row['id']} \"{row['name']}\" went back to its version in {source}: its record in the damaged "
                 "file couldn't be read whole")
        for row in merged.came_back:
            _log(f"{row['id']} \"{row['name']}\" was deleted after {source} ({row['how']}) and is back from it")
        for row in merged.back_in_trash:
            _log(f"{row['id']} \"{row['name']}\" was restored after {source} and is in Recently deleted again")
        for row in merged.kept_deleted:
            _log(f"{row['id']} \"{row['name']}\" was deleted for good after {source}: it stays deleted"
                 + (" (its record says it was made after that delete: the clock was ahead when it was made)"
                    if row.get("createdAfterDelete") else ""))
        for row in merged.rekeyed:
            _log(f"{row['id']}'s record sat under a damaged key ({row['key'] or 'not an id'}): "
                 "filed under the id it and the copy agree on")
        if merged.open_project_missing:
            _log(f"the open project {merged.open_project_missing} didn't come back; no project is open")
        _log(f"{kind} the project list: {len(catalog['projects'])} projects, "
             f"{len(catalog.get('trash') or {})} in Recently deleted; open: "
             f"{catalog.get('activeProjectId') or 'none'} ({merged.active_from})")
        open_id = catalog.get("activeProjectId")
        for row in merged.reverted:
            if row["id"] == open_id and merged.active_from == "canvas":
                # Its nodes and wires come back from the live canvas, which is
                # this project's (main saves it into it on the next listing).
                row["liveCanvas"] = True

        def rows(found: list[dict[str, Any]]) -> list[dict[str, Any]]:
            return found[:RECORD_ROWS]

        record = {
            "id": uuid4().hex, "at": moment.isoformat(), "kind": kind, "reason": damage.reason,
            "detail": str(damage)[:300], "source": source, "copyAt": copy_at, "damagedFile": damaged_file,
            "setAside": set_aside,
            "addedBack": rows(merged.added), "addedBackCount": len(merged.added),
            "updatedFromDisk": rows(merged.updated), "updatedFromDiskCount": len(merged.updated),
            "notAddedBack": rows(merged.not_added), "notAddedBackCount": len(merged.not_added),
            "reverted": rows(merged.reverted), "revertedCount": len(merged.reverted),
            "cameBack": rows(merged.came_back), "cameBackCount": len(merged.came_back),
            "backInTrash": rows(merged.back_in_trash), "backInTrashCount": len(merged.back_in_trash),
            "keptDeleted": rows(merged.kept_deleted), "keptDeletedCount": len(merged.kept_deleted),
            "projectCount": len(catalog["projects"]), "trashCount": len(catalog.get("trash") or {}),
            "openProject": open_id, "openFrom": merged.active_from,
            "openProjectMissing": merged.open_project_missing, "openProjectName": merged.open_project_name,
            # Which project the live canvas was when this restore ran: a
            # project id, None (no project's, or unproven) or "unknown" (never
            # recorded). A filing of the canvas goes in this record only when
            # it is this restore's doing (main._note_canvas_settled).
            "canvasOwner": owner if isinstance(owner, str) else None if owner is None else "unknown",
            "recoveredCanvas": None, "dismissedAt": None,
            # Whether the damaged catalog.json was read to its end (it parsed;
            # only its shape was wrong). When it wasn't (cut, zeroed, a key
            # destroyed), what it held past the damage is unknown, so nobody
            # may say nothing was lost (live check of fix round 1).
            "damagedReadWhole": bool(damage.raw is not None and salvages and salvages[0].complete),
        }
        try:
            self._record_restore(record)
        except Exception as exc:  # noqa: BLE001 - the catalog is restored; the notice is what's lost
            _log(f"the restore could not be recorded for the notice: {exc}")
        try:
            self._prune_damaged(keep={Path(path) for path in set_aside})
        except Exception as exc:  # noqa: BLE001 - pruning is housekeeping
            _log(f"could not prune old damaged files: {exc}")
        pending = getattr(self._local, "announce", None)
        if pending is None:
            pending = self._local.announce = []
        pending.append(record)

    def _prune_damaged(self, *, keep: set[Path]) -> None:
        """Delete kept damaged files past the bound (DAMAGED_KEPT_*), never
        one in ``keep`` (this restore's) or one the notice the person hasn't
        closed names. Ages each by when it was kept (_kept_at). Under the lock."""
        notice = self.restore_notice()
        named = {Path(path) for path in (notice or {}).get("setAside") or [] if isinstance(path, str)}
        protected = {path.name for path in keep | named}
        cutoff = time.time() - DAMAGED_KEPT_DAYS * 86400
        for prefix in (self.path.name, self.backup_path.name, self.older_backup_path.name, self.record_path.name):
            found: list[tuple[float, Path]] = []
            for path in self.root.glob(f"{prefix}.damaged-*"):
                if path.name[len(prefix):].startswith(".damaged-") and not path.is_symlink():
                    try:
                        found.append((_kept_at(path), path))
                    except OSError:
                        continue
            found.sort(reverse=True)  # newest first
            for index, (kept_at, path) in enumerate(found):
                if path.name in protected:
                    continue
                if index < DAMAGED_KEPT_MIN or (kept_at >= cutoff and index < DAMAGED_KEPT_MAX):
                    continue
                try:
                    path.unlink()
                    _log(f"deleted the old damaged file {path.name}")
                except OSError as exc:
                    _log(f"could not delete the old damaged file {path.name}: {exc}")

    def sweep_orphans(self) -> int:
        """Delete temporary files a crash left behind (a commit's, a copy's,
        a kept damaged file's) once they are ORPHAN_SECONDS old, under the
        lock. Startup calls it (main); returns how many went."""
        if not self.root.exists():
            return 0
        swept = 0
        cutoff = time.time() - ORPHAN_SECONDS
        try:
            with self._locked():
                for pattern in _ORPHAN_PATTERNS:
                    for path in self.root.glob(pattern):
                        try:
                            if path.is_symlink() or path.stat().st_mtime >= cutoff:
                                continue
                            path.unlink()
                            swept += 1
                        except OSError:
                            continue
        except OSError as exc:
            _log(f"could not sweep temporary files: {exc}")
        if swept:
            _log(f"deleted {swept} temporary file{'s' if swept != 1 else ''} a crash left behind")
        return swept

    def note_restore(self, record_id: str, **fields: Any) -> None:
        """Add ``fields`` to the restore ``record_id`` (main files the live
        canvas as its own project after a restore: ``recoveredCanvas``)."""
        try:
            with self._locked(nested=True):
                restores = self._records()
                for entry in restores:
                    if entry.get("id") == record_id:
                        entry.update(fields)
                        self._write_records(restores)
                        return
        except OSError as exc:
            _log(f"could not add to the restore record: {exc}")

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
            try:  # unreadable: keep it, as every damaged file is kept (named by when, for pruning)
                self._set_aside(self.record_path, _stamp(datetime.now(timezone.utc)))
            except OSError:
                pass
        self._write_records([*self._records(), record])

    def latest_restore(self) -> dict[str, Any] | None:
        """The newest restore, as recorded, dismissed or not."""
        restores = self._records()
        return restores[-1] if restores else None

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

    # -- the live canvas that couldn't be filed ------------------------------------

    def canvas_waiting(self) -> dict[str, Any] | None:
        """main's record of the live canvas that isn't a project and couldn't
        be filed as one (the list at a limit), or of the one filed last after
        waiting: {reason, from, since, journaled} or {saved: {id, name, at}}.
        Kept beside the catalog so it outlives a restart (review 3, L-5), in
        two copies: a missing or damaged one, or one whose fields have the
        wrong types, is passed over for the other (review 4, N-1). Within a
        process main keeps it in memory, so only a restart reads it; with
        both copies gone the wait starts again (a new process's journal
        never had its event)."""
        for name in (CANVAS_WAITING_NAME, CANVAS_WAITING_BACKUP_NAME):
            path = self.root / name
            try:
                found = json.loads(path.read_text(encoding="utf-8"))
            except FileNotFoundError:
                continue
            except (OSError, ValueError) as exc:
                _log(f"{name} could not be read ({exc})")
                continue
            record = _waiting_record(found)
            if record is None:
                _log(f"{name} doesn't hold a waiting canvas's record; not using it")
                continue
            return record
        return None

    def set_canvas_waiting(self, value: dict[str, Any] | None) -> None:
        """Write (or, for None, remove) canvas_waiting's record, both
        copies. Raises OSError."""
        paths = (self.root / CANVAS_WAITING_NAME, self.root / CANVAS_WAITING_BACKUP_NAME)
        if value is None:
            for path in paths:
                path.unlink(missing_ok=True)
            return
        self._ensure_root()
        encoded = json.dumps(value, ensure_ascii=False, indent=1).encode("utf-8")
        for path in paths:
            self._write_file(path, encoded)

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

    def _keep_purged(self, purged: dict[str, str]) -> None:
        """catalog-purged.json as the commit that just landed left
        ``purged`` (written only when it changes: a delete for good, a
        project made again, a tombstone aged out). Never fails the commit."""
        path = self.root / PURGED_NAME
        try:
            try:
                signature: Any = file_signature(path.stat())
            except FileNotFoundError:
                signature = None
            cached = self._side_purged
            held = cached[1] if cached is not None and cached[0] == signature else self._read_purged_file()
            if held == purged:
                self._side_purged = (signature, held)
                return
            if purged:
                self._write_file(path, json.dumps({"version": 1, "purged": purged}, separators=(",", ":")).encode("utf-8"))
            else:
                path.unlink(missing_ok=True)
            try:
                self._side_purged = (file_signature(path.stat()), dict(purged))
            except FileNotFoundError:
                self._side_purged = (None, {})
        except OSError as exc:
            self._side_purged = None
            _log(f"could not keep {PURGED_NAME}: {exc}")

    def _read_purged_file(self) -> dict[str, str]:
        """catalog-purged.json's tombstones, or {} (missing, damaged: logged)."""
        path = self.root / PURGED_NAME
        try:
            if path.is_symlink() or path.stat().st_size > PURGED_FILE_MAX_BYTES:
                _log(f"{PURGED_NAME} is not a file Nebula wrote; not using it")
                return {}
            found = json.loads(path.read_text(encoding="utf-8"))
        except FileNotFoundError:
            return {}
        except (OSError, ValueError) as exc:
            _log(f"{PURGED_NAME} could not be read ({exc}); not using it")
            return {}
        return catalog_recovery.purged_map(found.get("purged") if isinstance(found, dict) else None)

    def _write_older_backup(self, encoded: bytes) -> None:
        """Keep ``encoded`` (a catalog _check accepted, as committed) as the
        older copy when that is missing or over an hour old: a real copy, so
        it never shares an inode with .bak or catalog.json. Called after the
        commit's rename; raises OSError."""
        try:
            age = time.time() - self.older_backup_path.stat().st_mtime
        except FileNotFoundError:
            age = None
        if age is None or age >= OLDER_BACKUP_SECONDS:
            self._write_file(self.older_backup_path, encoded)

    def _seed_backup(self, raw: bytes) -> None:
        """A first .bak (a real copy) for a catalog saved before copies were
        kept, or after a restore took a damaged one out of use."""
        try:
            self._write_file(self.backup_path, raw)
            self._write_older_backup(raw)
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
        writes it in place (commit_prepared). A damaged file is restored
        here, unless hand_off_restore takes it (a reader on the event loop):
        then the last projection is answered, never a wait. A reader on the
        loop also answers the last projection while the shared worker read
        of the same file runs (read_in_flight), rather than parse it again;
        with no projection yet it reads the file itself."""
        signature = self._signature()
        cached = self._projection
        if signature is not None and cached is not None and cached.signature == signature:
            return cached
        if signature is not None and signature == self._damaged_signature and self._handed_off():
            return cached or Projection(None, None, RESTORING_REVISION, "", ())
        if signature is not None and cached is not None and self._read_elsewhere(signature):
            # The shared worker read of this very file is running: its result
            # replaces this answer the moment it lands.
            return cached
        try:
            self._ensure_root()
        except OSError as exc:
            raise ProjectStoreError("Project storage is unavailable; the canvas was preserved") from exc
        before = self._signature()
        try:
            catalog = self._read(upgrade=False, hand_off=True, signature=before)
        except _HandedOff:
            # A restore runs in a worker thread (or another process holds
            # the lock for one): the last projection, never a wait.
            return cached or Projection(None, None, RESTORING_REVISION, "", ())
        after = self._signature()
        view = _projection(catalog, after if after == before else None)
        verified = self._verified
        if view.signature is not None and verified is not None and verified[0] == view.signature:
            view = view._replace(digest=verified[1])
        if view.signature is not None:
            self._projection = view
        return view

    def _older_copy_hint(self) -> str:
        """For the log beside a newer Nebula's catalog.json: where a copy
        this version wrote is, so a person (or support) can go back to it by
        hand if the newer version is gone. Never read automatically."""
        try:
            raw = self._copy_bytes(self.backup_path)
            if raw is None:
                return ""
            older = self._parse(raw)
            if isinstance(older, dict) and older.get("version") == 1:
                return f" ({BACKUP_NAME}, a version-1 copy, is at {self.backup_path})"
        except (ValueError, OSError):
            pass
        return ""

    def _read_elsewhere(self, signature: tuple[int, int, int]) -> bool:
        """Whether a worker thread is already reading this catalog file for
        this reader (read_in_flight), so it needn't parse it too."""
        if self.read_in_flight is None or getattr(self._local, "depth", 0):
            return False
        try:
            return bool(self.read_in_flight(signature))
        except Exception:  # noqa: BLE001 - the reader then reads it itself, as before
            return False

    def _handed_off(self) -> bool:
        """Whether the restore of a damaged catalog.json was handed off from
        this reader (hand_off_restore), so it doesn't restore or wait."""
        if self.hand_off_restore is None or getattr(self._local, "depth", 0):
            return False
        try:
            return bool(self.hand_off_restore())
        except Exception as exc:  # noqa: BLE001 - the reader then restores, as before
            _log(f"could not hand the restore off: {exc}")
            return False

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
        return file_signature(info)

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

    def _remember_purged(self, catalog: dict[str, Any]) -> None:
        """Note in ``catalog["purged"]`` every project this hold read that the
        commit no longer holds (deleted for good, by any route or the trash's
        expiry), so a restore from an older copy leaves it deleted
        (catalog_recovery.reconcile). Kept PURGED_KEPT_DAYS, PURGED_KEPT_MAX
        at most."""
        holds = set(catalog["projects"]) | set(catalog.get("trash") or {})
        purged = catalog_recovery.purged_map(catalog.get("purged"))
        known = getattr(self._local, "ids", None)
        if known:
            moment = now()
            for project_id in known - holds:
                purged.setdefault(project_id, moment)
        cutoff = datetime.now(timezone.utc) - timedelta(days=PURGED_KEPT_DAYS)
        kept = sorted(((at, project_id) for project_id, at in purged.items()
                       if project_id not in holds and datetime.fromisoformat(at) >= cutoff), reverse=True)
        if kept:
            catalog["purged"] = {project_id: at for at, project_id in kept[:PURGED_KEPT_MAX]}
        else:
            catalog.pop("purged", None)
        if getattr(self._local, "depth", 0):
            self._local.pending_ids = holds

    def _past_the_limit_by_restores_only(self, catalog: dict[str, Any]) -> bool:
        """With RESTORE_MAY_PASS_THE_PROJECT_LIMIT on: whether every project
        in ``catalog`` is one this hold read (in the list or in Recently
        deleted), so a list past the limit got there by restores, and the
        commit adds no new project. Off (today): never."""
        if not RESTORE_MAY_PASS_THE_PROJECT_LIMIT:
            return False
        known = getattr(self._local, "ids", None)
        return bool(known) and set(catalog["projects"]) <= known

    def prepare(self, catalog: dict[str, Any]) -> Path:
        """Write/fsync a private temporary catalog before any live graph edit.

        Refuses (ProjectStoreError, nothing written) a catalog _read would
        refuse: it would read back as damage and be "restored", hiding the
        bug behind the person's restore notice (review 1, L7), or one that
        can't be encoded."""
        self._ensure_root()
        if len(catalog["projects"]) > MAX_PROJECTS and not self._past_the_limit_by_restores_only(catalog):
            raise ProjectLimitError("Project limit reached", "projects")
        try:
            self._check(catalog, fill=False)
        except (ValueError, TypeError, KeyError, AttributeError) as exc:
            _log(f"refusing to write a catalog that wouldn't read back ({exc})")
            raise ProjectStoreError("Project catalog could not be saved: it wouldn't read back. Nothing changed.") from exc
        self._remember_purged(catalog)
        # Which project is open goes first, so a file cut short still says
        # (services/catalog_recovery.py); the rest keep their order.
        ordered = {key: catalog[key] for key in _HEAD_KEYS if key in catalog}
        ordered.update((key, value) for key, value in catalog.items() if key not in ordered)
        try:
            encoded = json.dumps(ordered, ensure_ascii=False, allow_nan=False, separators=(",", ":")).encode("utf-8")
        except (ValueError, TypeError, RecursionError) as exc:
            _log(f"refusing to write a catalog that can't be encoded ({exc}); the next read is strict")
            # The catalog read for it may have come from the fast read of a
            # file that isn't what this process wrote (review 3, L-6): the
            # next read checks it whole and restores it if it is damaged.
            self._projection = None
            raise ProjectStoreError("Project catalog could not be saved: it holds a value that can't be written. "
                                    "Nothing changed.") from exc
        if len(encoded) > MAX_CATALOG_BYTES:
            raise ProjectLimitError("Project storage limit reached", "storage")
        temporary = self.root / f".catalog.{uuid4().hex}.tmp"
        self._prepared_purged = (temporary, catalog_recovery.purged_map(catalog.get("purged")))
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
            # commit_prepared to keep; the pins go through JSON as they are
            # stored, so the caller can't change them.
            view = _projection(catalog, None)
            stored = json.loads(json.dumps(view.pins, ensure_ascii=False, allow_nan=False))
            self._prepared = (temporary, view._replace(pins=tuple(stored)), encoded)
        except (ValueError, TypeError, KeyError):
            pass
        return temporary

    def _link_backup(self) -> tuple[Path | None, bool]:
        """Before a commit's rename: a hard link of catalog.json under a
        temporary name, when it is the file this hold read and validated
        (its signature), else None. The commit then renames it to .bak, so
        .bak is the catalog that commit replaced, never unvalidated bytes,
        and no byte is copied (review 1, L6). The second value says the link
        itself failed (a file system without hard links: exFAT, FAT, some
        network and FUSE mounts): the commit then writes .bak as a real copy
        of what it commits, every time (review 2, L3)."""
        validated = getattr(self._local, "validated", None)
        if validated is None:
            return None, False
        try:
            if self._signature() != validated:
                return None, False
        except ProjectStoreError:
            return None, False
        link = self.root / f".catalog-bak.{uuid4().hex}.tmp"
        try:
            os.link(self.path, link, follow_symlinks=False)
        except OSError as exc:
            if not getattr(self, "_told_no_links", False):
                self._told_no_links = True
                _log(f"hard links don't work here ({exc}); {BACKUP_NAME} is a full copy of each commit instead")
            return None, True
        return link, False

    def commit_prepared(self, temporary: Path) -> None:
        prepared, self._prepared = self._prepared, None
        written = None
        if prepared is not None and prepared[0] == temporary:
            try:
                written = os.stat(temporary)
            except OSError:
                pass  # the rename below says what is wrong
        fd = os.open(self.root, os.O_RDONLY | getattr(os, "O_DIRECTORY", 0))
        link, link_failed = self._link_backup()
        # A successful atomic rename is the commit point. A post-commit
        # directory fsync warning must not report a failed, unadopted canvas.
        try:
            os.replace(temporary, self.path)
            self._local.validated = None
            if link is not None:
                # The catalog just replaced becomes .bak. Never fails the
                # commit. When .bak is already that file, rename(2) does
                # nothing and leaves the temporary name, so it is unlinked.
                try:
                    os.replace(link, self.backup_path)
                except OSError as exc:
                    _log(f"could not keep the replaced catalog as {BACKUP_NAME}: {exc}")
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
                    self._projection = prepared[1]._replace(signature=landed, digest=zlib.crc32(prepared[2]))
                    self._own_signature = landed
                    if getattr(self._local, "depth", 0):
                        # prepare validated it: the next commit in this hold may keep it as .bak.
                        self._local.validated = landed
                        self._local.ids = getattr(self._local, "pending_ids", None)
            purged, self._prepared_purged = self._prepared_purged, None
            if purged is not None and purged[0] == temporary:
                # After the rename, never before: a tombstone written for a
                # commit that didn't land would drop a project that exists.
                self._keep_purged(purged[1])
            try:
                os.fsync(fd)
            except OSError as exc:
                print(f"[projects] directory fsync failed after commit: {exc}", flush=True)
            if written is not None and prepared is not None:
                # The commit is made; now the copies that need bytes: the
                # first .bak (none yet to link), .bak on every commit where
                # links fail (a copy of this commit: never a .bak that stops
                # following), and the hourly older copy. Never fails the
                # commit: the next one tries again.
                try:
                    if link_failed or (link is None and not self.backup_path.exists()):
                        self._write_file(self.backup_path, prepared[2])
                    self._write_older_backup(prepared[2])
                    os.fsync(fd)
                except Exception as exc:  # noqa: BLE001 - the commit itself landed
                    _log(f"could not keep a copy of catalog.json: {exc}")
        finally:
            if link is not None:
                link.unlink(missing_ok=True)
            os.close(fd)

    def commit(self, catalog: dict[str, Any]) -> None:
        temporary = self.prepare(catalog)
        try:
            self.commit_prepared(temporary)
        finally:
            temporary.unlink(missing_ok=True)
