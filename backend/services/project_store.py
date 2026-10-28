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
from typing import Any, Callable, Iterable, Iterator, Mapping, NamedTuple
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
# The projects deleted for good as the latest commit that changed them left
# them (its `purged`): .bak is one commit behind, so a delete for good as the
# last commit, then a catalog.json damaged past its head, brought the project
# back to Recently deleted with no line (review 4 of PR #199, L-3). Read by a
# restore only. {version, commit, purged, previous: {commit, purged}}:
# `commit` is the catalog's `commitSeq` it is true of, `previous` the
# tombstones that commit took away, true of the commit before. Written
# before the catalog's rename (review 5, L-3): a crash between the two
# leaves it one commit ahead, which its layers say, never a landed delete
# without it. A write that fails leaves it at its older commit; the copies
# numbered later than it then decide the ids they hold (review 5, L-1).
PURGED_NAME = "catalog-purged.json"
# The live canvases held aside while they wait to be saved as their own
# projects (main._hold_live_canvas: an open, a create, or below the limit an
# agent's write replaced it; review 5 of PR #199, M-3; GM's held model,
# 2026-10-28). Each canvas in its own file (review 7, L-3: one shared file,
# capped, refused the person's open once it was full), in two copies:
# canvas-held/<projectId>.json and its .bak, {version: 2, entry, check},
# each written whole and fsynced, then the folder. ``check`` is a digest of
# the entry, so a flip that still parses loses to the other copy (review 7,
# M-2). The canvas-held.json of fix rounds 5-6 is moved in once
# (_migrate_legacy_held) and kept aside as canvas-held.json.migrated-<UTC>.
CANVAS_HELD_DIR_NAME = "canvas-held"
CANVAS_HELD_NAME = "canvas-held.json"
CANVAS_HELD_BACKUP_NAME = CANVAS_HELD_NAME + ".bak"
CANVAS_HELD_NOTE_NAME = "unreadable.json"
_HELD_FILE = re.compile(r"^([0-9a-f]{32})\.json(\.bak)?$")
# No shared cap (review 7, L-3). A held canvas is capped like a project
# (main: MAX_PROJECT_BYTES, for agents only; the person's open always holds
# it). A file past the catalog's own cap isn't one Nebula wrote: it can't
# be saved as a project, so it is kept aside as damaged.
CANVAS_HELD_READ_MAX_BYTES = 128 * 1024 * 1024 + 1024 * 1024
# How long the person is told a held canvas couldn't be read (review 6, L-1).
HELD_UNREADABLE_SECONDS = 7 * 24 * 3600
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
_HEAD_KEYS = ("version", "commitSeq", "commitCheck", "activeProjectId", "workspaceRevision", "migratedProjectId", "purged")
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
# The held canvases' kept files (review 8 of PR #199, N-1): damaged copies,
# canvases that couldn't be filed, and the moved canvas-held.json.
_HELD_KEPT = re.compile(r"\.(damaged|unfileable|migrated)-(\d{8}T\d{6}Z)-[0-9a-f]{8}$")


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


def duplicate_name(source_name: str, catalog: Mapping[str, Any], taken: Iterable[str] = ()) -> str:
    """Nebula's duplicate naming (GM r10, 1; the Mac Finder convention):
    "<name> copy", then "<name> copy 2", 3 and so on, one past the highest
    in the list, Recently deleted or ``taken`` (names already promised to
    copies not yet filed). The one helper for every duplicate: an agent's
    copy of the person's canvas (PR #199) and a future Duplicate project."""
    stem = f"{source_name[:100]} copy"
    pattern = re.compile(re.escape(stem) + r"(?: (\d+))?")
    highest = 0
    names = [str((project or {}).get("name") or "") for listing in (catalog.get("projects") or {}, catalog.get("trash") or {})
             for project in listing.values()]
    for name in [*names, *taken]:
        match = pattern.fullmatch(name)
        if match:
            highest = max(highest, int(match.group(1) or 1))
    return stem if highest == 0 else f"{stem} {highest + 1}"


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
            record = {"id": saved["id"], "name": saved["name"], "at": saved["at"],
                      **({"overSaveLimit": True} if saved.get("overSaveLimit") is True else {}),
                      # After a restore notice named a canvas (GM's answer 1 to review 8).
                      **({"another": True} if saved.get("another") is True else {})}
            # Every canvas filed together (review 6 of PR #199, N-2), each
            # marked when it is over the save limit (GM, review 7).
            filed = saved.get("filed")
            if isinstance(filed, list) and all(isinstance(row, dict) and isinstance(row.get("id"), str)
                                               and isinstance(row.get("name"), str) for row in filed):
                record["filed"] = [{"id": row["id"], "name": row["name"],
                                    **({"overSaveLimit": True} if row.get("overSaveLimit") is True else {})}
                                   for row in filed]
            return {"saved": record}
        return None
    owner = found.get("from")
    if found.get("reason") not in ("projects", "storage") or not catalog_recovery.dated(found.get("since")) \
            or not isinstance(found.get("journaled"), bool) or not (owner is None or isinstance(owner, str)):
        return None
    return {"reason": found["reason"], "from": owner, "since": found["since"], "journaled": found["journaled"]}


# What main keeps in the catalog about the person's canvas once it was
# filed from waiting (review 8 of PR #199, HIGH-1, GM's rule (a); review 9,
# M-1: in the same commit as the filing, so no failed write or crash can
# leave a filed project open and unprotected). ``fresh``: the project filed
# from the person's waiting canvas, with that canvas's digest; until the
# canvas changes or one of the person's tabs is open on it (GM r11, 2), an
# agent's write closes it first and works elsewhere. ``copies``: the copies
# an agent's change was made on, by the id each is filed under: the name it
# takes, the agent, and the undo book's mark and boot when it was made.
CANVAS_PENDING_FIELD = "canvasPending"


def canvas_pending_of(catalog: Mapping[str, Any]) -> dict[str, Any]:
    """The catalog's ``canvasPending`` when its fields are what main writes;
    an empty record otherwise (a damaged one protects nothing, and names
    copies as any filed canvas)."""
    found = catalog.get(CANVAS_PENDING_FIELD)
    empty = {"fresh": None, "copies": {}}
    if not isinstance(found, dict):
        return empty
    fresh, copies = found.get("fresh"), found.get("copies")
    if fresh is not None and not (isinstance(fresh, dict) and _is_hex_id(fresh.get("projectId"))
                                  and isinstance(fresh.get("digest"), str) and len(fresh["digest"]) == 64):
        fresh = None
    kept: dict[str, dict[str, Any]] = {}
    for key, copy_record in (copies.items() if isinstance(copies, dict) else ()):
        if not (_is_hex_id(key) and isinstance(copy_record, dict)):
            continue
        name, agent = copy_record.get("name"), copy_record.get("agent")
        if not (isinstance(name, str) and 0 < len(name) <= 200) or not (agent is None or isinstance(agent, str)):
            continue
        mark, boot = copy_record.get("mark"), copy_record.get("boot")
        kept[key] = {"name": name, "agent": agent,
                     "mark": mark if isinstance(mark, int) and not isinstance(mark, bool) else None,
                     "boot": boot if isinstance(boot, str) else None}
    return {"fresh": None if fresh is None else {"projectId": fresh["projectId"], "digest": fresh["digest"]},
            "copies": kept}


def set_canvas_pending_in(catalog: dict[str, Any], value: Mapping[str, Any]) -> None:
    """Write ``canvasPending`` into ``catalog`` (the caller commits it):
    removed when it holds nothing."""
    fresh, copies = value.get("fresh"), dict(value.get("copies") or {})
    if not fresh and not copies:
        catalog.pop(CANVAS_PENDING_FIELD, None)
        return
    catalog[CANVAS_PENDING_FIELD] = {"fresh": fresh, "copies": copies}


def _is_hex_id(value: Any) -> bool:
    return isinstance(value, str) and len(value) == 32 and all(c in "0123456789abcdef" for c in value)


def _held_unreadable_note(found: Any) -> dict[str, Any] | None:
    """canvas-held.json's ``unreadable`` note ({count: int or None for
    unknown, kept: [file names], at}) when its fields are what this writes."""
    if not isinstance(found, dict) or not catalog_recovery.dated(found.get("at")):
        return None
    count, kept = found.get("count"), found.get("kept")
    if not (count is None or (isinstance(count, int) and not isinstance(count, bool) and count > 0)):
        return None
    if not isinstance(kept, list) or not all(isinstance(name, str) for name in kept):
        return None
    # The person closed its notice (×, GM r9): kept, but not shown again
    # until a new loss writes a new note.
    dismissed = {"dismissedAt": found["dismissedAt"]} if catalog_recovery.dated(found.get("dismissedAt")) else {}
    return {"count": count, "kept": list(kept), "at": found["at"], **dismissed}


def _held_id(found: Any) -> str | None:
    """An entry's projectId when it reads as one, damaged entry or not."""
    project_id = found.get("projectId") if isinstance(found, dict) else None
    if isinstance(project_id, str) and len(project_id) == 32 and all(c in "0123456789abcdef" for c in project_id):
        return project_id
    return None


def held_canvas_items_ok(nodes: Any, edges: Any) -> bool:
    """Whether a held canvas's nodes and connections are what a project
    stores (review 7 of PR #199, M-2 and N-6): lists of dicts, each node
    with a unique string ``id`` (and a dict ``data`` when it has one), each
    connection with a unique string ``id``, ``source`` and ``target``.
    Anything else is damage: filing it raised (a node without an id, mixed
    id types) or saved a project holding garbage nodes."""
    if not isinstance(nodes, list) or not isinstance(edges, list):
        return False
    seen: set[str] = set()
    for node in nodes:
        if not isinstance(node, dict):
            return False
        node_id = node.get("id")
        if not isinstance(node_id, str) or not node_id or node_id in seen:
            return False
        if "data" in node and not isinstance(node["data"], dict):
            return False
        seen.add(node_id)
    seen = set()
    for edge in edges:
        if not isinstance(edge, dict):
            return False
        edge_id = edge.get("id")
        if not isinstance(edge_id, str) or not edge_id or edge_id in seen:
            return False
        if not isinstance(edge.get("source"), str) or not isinstance(edge.get("target"), str):
            return False
        seen.add(edge_id)
    return True


def held_entry_check(entry: dict[str, Any]) -> str:
    """The digest a held canvas's file carries of its entry (review 7, M-2's
    option): a copy whose bytes still parse after a flip loses to the other."""
    return hashlib.sha256(json.dumps(entry, sort_keys=True, ensure_ascii=False, separators=(",", ":"),
                                     default=str).encode("utf-8")).hexdigest()


def held_items_digest(nodes: Any, edges: Any) -> str:
    """The digest of a held canvas's content, its nodes and connections as
    held (review 8 of PR #199, L-1): written with the canvas, so a copy
    salvaged when neither copy passes its whole check is filed only when its
    content is still exactly what was held."""
    return hashlib.sha256(json.dumps({"nodes": nodes, "edges": edges}, sort_keys=True, ensure_ascii=False,
                                     separators=(",", ":"), default=str).encode("utf-8")).hexdigest()


def held_items_intact(entry: Mapping[str, Any]) -> bool | None:
    """Whether a held entry's content matches its ``itemsDigest``; None when
    it carries none (held before fix round 8)."""
    digest = entry.get("itemsDigest")
    if not isinstance(digest, str):
        return None
    return digest == held_items_digest(entry.get("nodes"), entry.get("edges"))


def _held_salvage_choice(candidates: list[dict[str, Any]]) -> dict[str, Any] | None:
    """Which salvaged copy of one held canvas may be filed (review 8, L-1):
    one whose content matches the items digest it was held with; with no
    digest to check (an entry held before fix round 8), only when both
    copies salvage to the same content. Else None: the canvas is said lost
    and its files kept, never filed with altered content unsaid."""
    for candidate in candidates:
        if held_items_intact(candidate) is True:
            return candidate
    if any(held_items_intact(candidate) is False for candidate in candidates):
        return None
    if len(candidates) == 2 and held_items_digest(candidates[0]["nodes"], candidates[0]["edges"]) \
            == held_items_digest(candidates[1]["nodes"], candidates[1]["edges"]):
        return candidates[0]
    return None


def _held_entry_salvaged(found: Any) -> dict[str, Any] | None:
    """A damaged entry whose canvas is still there (its id, and nodes and
    connections that pass held_canvas_items_ok): its other fields made good,
    so the canvas is still saved. Its digest is unknown, so it is never
    taken for the live canvas."""
    project_id = _held_id(found)
    if project_id is None or not held_canvas_items_ok(found.get("nodes"), found.get("edges")):
        return None
    owner, counter = found.get("from"), found.get("counter")
    stamp = now()
    return {**found, "projectId": project_id,
            "from": owner if isinstance(owner, str) else None,
            "unproven": found["unproven"] if isinstance(found.get("unproven"), bool) else not isinstance(owner, str),
            "reason": found["reason"] if found.get("reason") in ("projects", "storage") else "projects",
            "since": found["since"] if catalog_recovery.dated(found.get("since")) else stamp,
            "heldAt": found["heldAt"] if catalog_recovery.dated(found.get("heldAt")) else stamp,
            "digest": found["digest"] if isinstance(found.get("digest"), str) else "",
            "counter": int(counter) if isinstance(counter, (int, float)) and not isinstance(counter, bool)
            and counter == counter and abs(counter) < 2 ** 53 else 0}


def _held_entry(found: Any) -> dict[str, Any] | None:
    """One held canvas's entry when its fields are what main writes, its
    nodes and connections included (held_canvas_items_ok), else None."""
    if not isinstance(found, dict):
        return None
    project_id, owner = found.get("projectId"), found.get("from")
    if not (isinstance(project_id, str) and len(project_id) == 32 and all(c in "0123456789abcdef" for c in project_id)):
        return None
    if not held_canvas_items_ok(found.get("nodes"), found.get("edges")):
        return None
    if found.get("reason") not in ("projects", "storage") or not catalog_recovery.dated(found.get("since")) \
            or not catalog_recovery.dated(found.get("heldAt")) or not (owner is None or isinstance(owner, str)) \
            or not isinstance(found.get("unproven"), bool) or not isinstance(found.get("digest"), str) \
            or not isinstance(found.get("counter"), int) or isinstance(found.get("counter"), bool):
        return None
    return dict(found)


_HELD_ARRAY = re.compile(r'"held"[ \t\n\r]*:[ \t\n\r]*\[')


def _held_entries_cut(text: str) -> tuple[list[Any], bool] | None:
    """The complete leading entries of a cut canvas-held.json (review 7 of PR
    #199, L-2: truncating both copies lost every canvas), and whether the
    array's end was reached (its length is then known): each element of its
    "held" array decoded in turn, separated by JSON's own whitespace only
    (as catalog_recovery's salvage), up to the first that doesn't decode.
    None when the array isn't found."""
    match = _HELD_ARRAY.search(text)
    if match is None:
        return None
    decoder = json.JSONDecoder()
    space = catalog_recovery._JSON_SPACE
    position, found = match.end(), []
    while True:
        while position < len(text) and text[position] in space:
            position += 1
        if position < len(text) and text[position] == "]":
            return found, True
        if position >= len(text) or text[position] not in '{"[':
            return found, False
        try:
            value, position = decoder.raw_decode(text, position)
        except ValueError:
            return found, False
        found.append(value)
        while position < len(text) and text[position] in space:
            position += 1
        if position < len(text) and text[position] == ",":
            position += 1
        elif not (position < len(text) and text[position] == "]"):
            return found, False


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
        # canvas-held.json's unreadable note (canvas_held), and one just made
        # that main hasn't journaled yet (take_held_damage).
        self._held_note: dict[str, Any] | None = None
        self._held_damage_new: dict[str, Any] | None = None
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
        self._prepared_purged: tuple[Path, dict[str, str], int] | None = None
        self._side_purged: tuple[Any, dict[str, Any]] | None = None
        # The highest commit number this store wrote or a restore saw
        # (commitSeq): every commit's is above it.
        self._last_seq = 0
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
        # sync tool or a person put back: review 2, L3) and, when both are
        # numbered, a later commit. Dates are the copies' own
        # (catalog_recovery.newer_copy; every change Nebula makes moves one),
        # judged by file order: a date ahead of this restore's clock is left
        # out in .bak.1 and counts as now in .bak, so neither a .bak.1 nor a
        # .bak written while the clock ran ahead loses the newer copy (review
        # 4, M-3; review 5, M-2's c1). Never by mtime: a copy made by hand or
        # a sync tool has a new one. Two signals, so one flipped digit in a
        # valid copy's dates or number never makes the older copy the base.
        clock = datetime.now(timezone.utc)
        valid: list[tuple[int, Path, bytes, dict[str, Any]]] = []
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
            valid.append((order, path, raw, candidate))
        if valid:
            pick = valid[0]
            if len(valid) > 1:
                (_o, _p, _r, newest_copy), (_o1, _p1, _r1, older_copy) = valid[0], valid[1]
                newer_seq = catalog_recovery.proven_commit(newest_copy)
                older_seq = catalog_recovery.proven_commit(older_copy)
                later_commit = older_seq is not None and (newer_seq is None or older_seq > newer_seq) \
                    or (older_seq is None and newer_seq is None)
                if later_commit and catalog_recovery.newer_copy(newest_copy, older_copy, until=clock):
                    pick = valid[1]
            _order, chosen, base_raw, base = pick
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
        # Commit numbers go on above every number this restore saw (the
        # damaged head's when it reads, the side file's, the copies').
        seen_seqs = [found.seq for found in salvages if found.seq is not None]
        seen_seqs += [catalog_recovery._commit_of(row[3].get("commitSeq")) or 0 for row in valid]
        self._last_seq = max([self._last_seq, *seen_seqs])
        merged = catalog_recovery.reconcile(base, salvages, max_projects=MAX_PROJECTS, room_bytes=room,
                                            open_project=owner, until=clock,
                                            side_layers=self._purged_layers(), side_index=1 if head is not None else 0)
        if merged.purged_file_behind:
            side_commit = self._side_file().get("commit")
            _log(f"{PURGED_NAME} is from commit {side_commit}, older than a file of a later commit: that file decides "
                 "the projects it holds (the side file couldn't be rewritten, or a crash came between)")
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
            why = ("its record in the damaged file is older by its dates (the damaged file keeps it)"
                   if row.get("by") == "dates" else "its record in the damaged file couldn't be read whole")
            _log(f"{row['id']} \"{row['name']}\" went back to its version in {source}: {why}")
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
            # catalog-purged.json was older than a file that decided ids it
            # names (review 5, L-1): its write had failed, or a crash.
            "purgedFileBehind": merged.purged_file_behind,
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

    # -- the canvases held aside (one file per canvas: review 7 of PR #199, L-3) --

    @property
    def held_dir(self) -> Path:
        return self.root / CANVAS_HELD_DIR_NAME

    def _ensure_held_dir(self) -> None:
        self._ensure_root()
        if self.held_dir.is_symlink():
            raise OSError(f"{CANVAS_HELD_DIR_NAME} is a symbolic link")
        self.held_dir.mkdir(exist_ok=True, mode=0o700)

    @staticmethod
    def _fsync_dir(path: Path) -> None:
        fd = os.open(path, os.O_RDONLY | getattr(os, "O_DIRECTORY", 0))
        try:
            os.fsync(fd)
        finally:
            os.close(fd)

    def held_paths(self, project_id: str) -> tuple[Path, Path]:
        """A held canvas's two copies."""
        return self.held_dir / f"{project_id}.json", self.held_dir / f"{project_id}.json.bak"

    @staticmethod
    def _held_file_bytes(entry: dict[str, Any]) -> bytes:
        return json.dumps({"version": 2, "check": held_entry_check(entry), "entry": entry}, ensure_ascii=False,
                          separators=(",", ":"), default=str).encode("utf-8")

    def _write_held_pair(self, entry: dict[str, Any]) -> None:
        """Both copies of one held canvas, each written whole and fsynced
        (the folder is fsynced by the caller). Raises OSError."""
        encoded = self._held_file_bytes(entry)
        for path in self.held_paths(entry["projectId"]):
            self._write_file(path, encoded)

    def _held_ids_on_disk(self) -> set[str]:
        try:
            names = os.listdir(self.held_dir)
        except FileNotFoundError:
            return set()
        return {match.group(1) for name in names if (match := _HELD_FILE.match(name))}

    def _read_held_file(self, path: Path, project_id: str) -> tuple[str, Any]:
        """("missing" | "read" | "damaged", the entry: valid for "read", the
        raw one, if any, for "damaged")."""
        try:
            if path.is_symlink() or path.stat().st_size > CANVAS_HELD_READ_MAX_BYTES:
                _log(f"{CANVAS_HELD_DIR_NAME}/{path.name} is not a file Nebula wrote; not using it")
                return "damaged", None
            found = json.loads(path.read_text(encoding="utf-8"))
        except FileNotFoundError:
            return "missing", None
        except (OSError, ValueError) as exc:
            _log(f"{CANVAS_HELD_DIR_NAME}/{path.name} could not be read ({exc})")
            return "damaged", None
        entry = found.get("entry") if isinstance(found, dict) else None
        valid = _held_entry(entry)
        if valid is None or valid["projectId"] != project_id or found.get("version") != 2 \
                or found.get("check") != held_entry_check(entry):
            _log(f"{CANVAS_HELD_DIR_NAME}/{path.name} doesn't read whole")
            return "damaged", entry
        return "read", valid

    def _keep_held_aside(self, paths: list[Path], kind: str = "damaged") -> list[str]:
        """Keep each file as it is now beside itself (``<name>.<kind>-<UTC>-<id>``,
        a hard link or a copy), before anything rewrites or removes it; the
        names it is kept under (relative to the project folder)."""
        kept: list[str] = []
        for path in paths:
            try:
                if path.is_symlink() or not path.exists():
                    continue
                target = path.with_name(f"{path.name}.{kind}-{_stamp(datetime.now(timezone.utc))}")
                try:
                    os.link(path, target, follow_symlinks=False)
                except OSError:
                    shutil.copyfile(path, target, follow_symlinks=False)
                os.chmod(target, 0o600, follow_symlinks=False)
                kept.append(str(target.relative_to(self.root)))
            except OSError as exc:
                _log(f"could not keep {path.name} aside: {exc}")
        return kept

    def _read_held_note(self) -> dict[str, Any] | None:
        """The note of held canvases that may be lost. A note that is there
        but doesn't read still says that something may be lost (count
        unknown), with the damaged note kept aside, so damage to the note
        never silences it."""
        path = self.held_dir / CANVAS_HELD_NOTE_NAME
        try:
            if path.is_symlink() or not path.exists():
                return None
            found = None
            if path.stat().st_size <= 1024 * 1024:
                try:
                    found = _held_unreadable_note(json.loads(path.read_text(encoding="utf-8")))
                except ValueError:
                    found = None
            if found is not None:
                return found
            # Which files the person was told were kept is in the note that
            # didn't read, so every kept file there is now is named (review
            # 9 of PR #199, L-3): pruning never deletes one of them.
            own = self._keep_held_aside([path])
            kept = [*own, *[name for name in self._held_kept_files() if name not in own]]
            note = {"count": None, "kept": kept, "at": now()}
            self._write_file(path, json.dumps(note, ensure_ascii=False).encode("utf-8"))
            return note
        except OSError:
            return None

    def _note_held_lost(self, count: int | None, kept: list[str]) -> None:
        """Held canvases that may be lost (``count``, None: unknown): added to
        the note the person and agents are told, kept on disk. After the
        person closed the note, a new loss is counted on its own (review 9,
        nit 2); the files kept before stay named, so none is pruned."""
        previous = self._held_note
        if previous is not None and previous.get("dismissedAt"):
            kept = [*previous["kept"], *[name for name in kept if name not in previous["kept"]]]
        elif previous is not None:
            count = None if count is None or previous["count"] is None else count + previous["count"]
            kept = [*previous["kept"], *[name for name in kept if name not in previous["kept"]]]
        self._held_note = {"count": count, "kept": kept, "at": now()}
        self._held_damage_new = dict(self._held_note)
        try:
            self._ensure_held_dir()
            self._write_file(self.held_dir / CANVAS_HELD_NOTE_NAME,
                             json.dumps(self._held_note, ensure_ascii=False).encode("utf-8"))
        except OSError as exc:
            _log(f"could not keep the note of the held canvases that couldn't be read: {exc}")

    def _held_kept_files(self) -> list[str]:
        """Every held canvases' kept file there is now (relative names)."""
        candidates = [*(self.held_dir.iterdir() if self.held_dir.is_dir() else []),
                      *self.root.glob(f"{CANVAS_HELD_NAME}*")]
        return sorted(str(path.relative_to(self.root)) for path in candidates
                      if _HELD_KEPT.search(path.name) is not None and not path.is_symlink())

    def _prune_held_kept(self) -> None:
        """Delete the held canvases' kept files past the catalog's own bound
        (DAMAGED_KEPT_*: the newest DAMAGED_KEPT_MIN of each kind always, up
        to DAMAGED_KEPT_MAX within DAMAGED_KEPT_DAYS), by when each was kept
        (its name); never one the note of lost canvases names while it is
        said. Each kind on its own: damaged copies, unfileable canvases, and
        the moved canvas-held.json (review 8 of PR #199, N-1)."""
        named = set((self._held_note or {}).get("kept") or [])
        cutoff = datetime.now(timezone.utc) - timedelta(days=DAMAGED_KEPT_DAYS)
        found: dict[str, list[tuple[datetime, Path]]] = {}
        candidates = [*(self.held_dir.iterdir() if self.held_dir.is_dir() else []),
                      *self.root.glob(f"{CANVAS_HELD_NAME}*")]
        for path in candidates:
            match = _HELD_KEPT.search(path.name)
            if match is None or path.is_symlink():
                continue
            try:
                kept_at = datetime.strptime(match.group(2), _STAMP_FORMAT).replace(tzinfo=timezone.utc)
            except ValueError:
                continue
            found.setdefault(match.group(1), []).append((kept_at, path))
        for kind, files in found.items():
            files.sort(reverse=True)  # newest first
            for index, (kept_at, path) in enumerate(files):
                if str(path.relative_to(self.root)) in named:
                    continue
                if index < DAMAGED_KEPT_MIN or (kept_at >= cutoff and index < DAMAGED_KEPT_MAX):
                    continue
                try:
                    path.unlink()
                    _log(f"deleted the old kept file {path.name}")
                except OSError as exc:
                    _log(f"could not delete the old kept file {path.name}: {exc}")

    def canvas_held(self) -> list[dict[str, Any]]:
        """The live canvases held aside while they wait to be saved as their
        own projects (main._hold_live_canvas), oldest first. [] for none.

        Each canvas is read on its own (review 7 of PR #199, L-3/M-2): its
        file when it reads whole (its entry valid, nodes and connections
        included, and its check matching), else its .bak, else either copy's
        entry whose canvas is still there, its other fields made good. A
        copy that doesn't read is kept aside (``.damaged-<UTC>-<id>``) and
        the canvas's two copies written again from the one that read. A
        canvas neither copy yields is said (``unreadable``: {count, kept,
        at}; canvas_held_unreadable) and its files kept aside: one damaged
        canvas never costs another. canvas-held.json from before is moved in
        first (_migrate_legacy_held)."""
        self._held_note = self._read_held_note()
        self._prune_held_kept()
        entries = self._migrate_legacy_held()
        on_disk = {entry["projectId"] for entry in entries}
        lost: list[str] = []
        kept: list[str] = []
        for project_id in sorted(self._held_ids_on_disk()):
            main, backup = self.held_paths(project_id)
            (main_status, main_found), (backup_status, backup_found) = (
                self._read_held_file(main, project_id), self._read_held_file(backup, project_id))
            entry = main_found if main_status == "read" else backup_found if backup_status == "read" else None
            if entry is None:
                # Neither copy passes its whole check: a copy's content is
                # filed only when it is exactly what was held (L-1).
                candidates = [salvaged for found in (main_found, backup_found) if isinstance(found, dict)
                              if (salvaged := _held_entry_salvaged({**found, "projectId": project_id})) is not None]
                entry = _held_salvage_choice(candidates)
            damaged = [path for path, status in ((main, main_status), (backup, backup_status)) if status == "damaged"]
            if entry is None:
                kept += self._keep_held_aside(damaged)
                for path in (main, backup):
                    path.unlink(missing_ok=True)
                lost.append(project_id)
                continue
            if project_id not in on_disk:
                entries.append(entry)
            if damaged or "missing" in (main_status, backup_status) or main_status != "read":
                kept += self._keep_held_aside(damaged)
                try:
                    self._write_held_pair(entry)
                except OSError as exc:
                    _log(f"could not write back the held canvas {project_id}: {exc}")
        if lost:
            _log(f"{len(lost)} held canvas{'' if len(lost) == 1 else 'es'} couldn't be read from either copy "
                 f"(kept as {', '.join(kept) or 'nothing'}); {len(entries)} still read")
            self._note_held_lost(len(lost), kept)
        if lost or kept:
            try:
                self._fsync_dir(self.held_dir)
            except OSError:
                pass
        entries.sort(key=lambda entry: entry["heldAt"])
        return entries

    # The canvas-held.json of fix rounds 5-6 (one file, both copies), read once
    # and moved in (review 7 of PR #199, L-3).

    def _legacy_held_read(self) -> tuple[list[dict[str, Any]], list[str], int | None, dict[str, Any] | None]:
        """canvas-held.json and its .bak read entry by entry: (the entries,
        the damaged copies' names, how many canvases may be lost (None:
        unknown), its unreadable note). A cut copy gives its complete leading
        entries (L-2). An entry is counted lost only when no copy yields it
        (N-1)."""
        copies: list[tuple[str, str, list[Any] | None, bool]] = []
        note = None
        for name in (CANVAS_HELD_NAME, CANVAS_HELD_BACKUP_NAME):
            path = self.root / name
            try:
                if path.is_symlink() or path.stat().st_size > CANVAS_HELD_READ_MAX_BYTES:
                    copies.append((name, "damaged", None, False))
                    continue
                text = path.read_text(encoding="utf-8", errors="replace")
            except FileNotFoundError:
                copies.append((name, "missing", None, False))
                continue
            except OSError as exc:
                _log(f"{name} could not be read ({exc})")
                copies.append((name, "damaged", None, False))
                continue
            try:
                found = json.loads(text)
            except ValueError:
                cut = _held_entries_cut(text)
                _log(f"{name} could not be read whole; {len(cut[0]) if cut else 0} of its entries still read")
                copies.append((name, "damaged", cut[0] if cut else None, bool(cut and cut[1])))
                continue
            raw = found.get("held") if isinstance(found, dict) else None
            note = note or (_held_unreadable_note(found.get("unreadable")) if isinstance(found, dict) else None)
            if not isinstance(raw, list):
                copies.append((name, "damaged", None, False))
                continue
            whole = all(_held_entry(entry) is not None for entry in raw)
            copies.append((name, "read" if whole else "damaged", raw, True))
        if all(status == "missing" for _name, status, _raw, _known in copies):
            return [], [], 0, note
        entries: list[dict[str, Any]] = []
        seen: set[str] = set()
        for salvage in (_held_entry, _held_entry_salvaged):
            for _name, _status, raw, _known in copies:
                for found in raw or []:
                    entry = salvage(found)
                    if entry is not None and entry["projectId"] not in seen:
                        seen.add(entry["projectId"])
                        entries.append(entry)
        lost_ids = {project_id for _name, _status, raw, _known in copies for found in raw or []
                    if (project_id := _held_id(found)) is not None and project_id not in seen}
        listed = [len(raw or []) for _name, _status, raw, known in copies if known]
        count: int | None = None
        if listed:
            count = len(lost_ids) + max(0, max(listed) - len(entries) - len(lost_ids))
        damaged = [name for name, status, _raw, _known in copies if status == "damaged"]
        return entries, damaged, count, note

    def _migrate_legacy_held(self) -> list[dict[str, Any]]:
        """Move canvas-held.json's canvases into their own files, once: each
        canvas not already there written (both copies), the folder fsynced,
        then the old files kept aside as ``.migrated-<UTC>-<id>`` (a
        crash anywhere before that runs it again: canvases already there are
        left as they are). Returns the canvases it couldn't write, which
        stay in memory and in the old file until the next try."""
        legacy = [self.root / CANVAS_HELD_NAME, self.root / CANVAS_HELD_BACKUP_NAME]
        if not any(path.exists() or path.is_symlink() for path in legacy):
            return []
        entries, damaged, count, note = self._legacy_held_read()
        unwritten: list[dict[str, Any]] = []
        try:
            self._ensure_held_dir()
            present = self._held_ids_on_disk()
            for entry in entries:
                if entry["projectId"] not in present:
                    self._write_held_pair(entry)
            self._fsync_dir(self.held_dir)
        except OSError as exc:
            _log(f"could not move {CANVAS_HELD_NAME} into {CANVAS_HELD_DIR_NAME}/ ({exc}); it is tried again")
            present = self._held_ids_on_disk()
            return [entry for entry in entries if entry["projectId"] not in present]
        if note is not None and self._held_note is None:
            self._held_note = note
            try:
                self._write_file(self.held_dir / CANVAS_HELD_NOTE_NAME, json.dumps(note).encode("utf-8"))
            except OSError:
                pass
        # A damaged copy is kept as it was, whatever was saved from it.
        kept = self._keep_held_aside([self.root / name for name in damaged])
        if count != 0:
            self._note_held_lost(count, kept)
        stamp = _stamp(datetime.now(timezone.utc))
        try:
            for path in legacy:
                if path.exists() or path.is_symlink():
                    os.replace(path, path.with_name(f"{path.name}.migrated-{stamp}"))
            self._fsync_dir(self.root)
        except OSError as exc:
            _log(f"could not keep the old {CANVAS_HELD_NAME} aside after moving it ({exc}); it is moved again")
        _log(f"moved {len(entries)} held canvas{'' if len(entries) == 1 else 'es'} from {CANVAS_HELD_NAME} into "
             f"{CANVAS_HELD_DIR_NAME}/")
        return unwritten

    def canvas_held_unreadable(self) -> dict[str, Any] | None:
        """Whether held canvases couldn't be read (canvas_held keeps the note
        it found or made): {count (None: unknown), kept, at} while recent
        (HELD_UNREADABLE_SECONDS), else None. Read canvas_held first."""
        note = getattr(self, "_held_note", None)
        if note is None:
            return None
        try:
            age = (datetime.now(timezone.utc) - datetime.fromisoformat(note["at"])).total_seconds()
        except (TypeError, ValueError):
            return None
        if note.get("dismissedAt"):
            return None
        return {key: note[key] for key in ("count", "kept", "at")} if 0 <= age <= HELD_UNREADABLE_SECONDS else None

    def dismiss_held_unreadable(self, at: str) -> bool:
        """The person closed the notice that held canvases may be lost (×,
        GM r9): it isn't shown again. False when ``at`` isn't the note shown
        (already closed, or a newer loss came). Read canvas_held first."""
        note = getattr(self, "_held_note", None)
        if note is None or note.get("at") != at or note.get("dismissedAt"):
            return False
        closed = {**note, "dismissedAt": now()}
        try:
            with self._locked():
                self._ensure_held_dir()
                self._write_file(self.held_dir / CANVAS_HELD_NOTE_NAME, json.dumps(closed, ensure_ascii=False).encode("utf-8"))
        except OSError as exc:
            raise ProjectStoreError("Project storage is unavailable; the canvas was preserved") from exc
        self._held_note = closed
        return True

    def take_held_damage(self) -> dict[str, Any] | None:
        """The unreadable note canvas_held just made (once), for main's journal."""
        found, self._held_damage_new = getattr(self, "_held_damage_new", None), None
        return found

    def hold_canvas(self, entry: dict[str, Any]) -> None:
        """Keep one canvas aside: its two copies, then the folder, fsynced.
        Raises OSError: a hold that isn't on disk must not let anything
        replace the canvas."""
        self._ensure_held_dir()
        self._write_held_pair(entry)
        self._fsync_dir(self.held_dir)

    def drop_held(self, project_ids: list[str] | set[str]) -> None:
        """The canvases filed (or found to be the live one) leave: both copies,
        then the folder fsynced. Raises OSError."""
        if not project_ids or not self.held_dir.exists():
            return
        for project_id in project_ids:
            for path in self.held_paths(project_id):
                path.unlink(missing_ok=True)
        self._fsync_dir(self.held_dir)

    def set_canvas_held(self, entries: list[dict[str, Any]]) -> None:
        """Make the held canvases on disk ``entries``: those not there are
        written, those not in it removed. Raises OSError."""
        self._ensure_held_dir()
        present = self._held_ids_on_disk()
        wanted = {entry["projectId"]: entry for entry in entries}
        for project_id, entry in wanted.items():
            if project_id not in present:
                self._write_held_pair(entry)
        for project_id in present - set(wanted):
            for path in self.held_paths(project_id):
                path.unlink(missing_ok=True)
        self._fsync_dir(self.held_dir)

    def set_aside_unfileable_held(self, project_id: str) -> list[str]:
        """A held canvas whose entry read but couldn't be saved as a project
        (review 7 of PR #199, M-2): its copies kept aside as
        ``.unfileable-<UTC>-<id>``, removed from the held canvases, and
        counted in the note the person and agents are told."""
        paths = [path for path in self.held_paths(project_id) if path.exists()]
        kept = self._keep_held_aside(paths, "unfileable")
        for path in paths:
            path.unlink(missing_ok=True)
        try:
            self._fsync_dir(self.held_dir)
        except OSError:
            pass
        self._note_held_lost(1, kept)
        return kept

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

    def _side_file(self) -> dict[str, Any]:
        """catalog-purged.json as {commit, purged, previous: {commit,
        purged}} (commit None for a file from before commits were numbered),
        cached by its signature; {} when missing or damaged (logged)."""
        path = self.root / PURGED_NAME
        try:
            signature: Any = file_signature(path.stat())
        except FileNotFoundError:
            signature = None
        except OSError:
            signature = False
        cached = self._side_purged
        if cached is not None and signature is not False and cached[0] == signature:
            return cached[1]
        found = self._read_side_file() if signature is not None else {}
        if signature is not False:
            self._side_purged = (signature, found)
        return found

    def _read_side_file(self) -> dict[str, Any]:
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
        if not isinstance(found, dict):
            return {}
        previous = found.get("previous") if isinstance(found.get("previous"), dict) else {}
        return {"commit": catalog_recovery.proven_commit(found, "commit"),
                "purged": catalog_recovery.purged_map(found.get("purged")),
                "previous": {"commit": catalog_recovery.proven_commit(previous, "commit"),
                             "purged": catalog_recovery.purged_map(previous.get("purged"))}}

    def _read_purged_file(self) -> dict[str, str]:
        """catalog-purged.json's tombstones (its latest layer), or {}."""
        return dict(self._side_file().get("purged") or {})

    def _purged_layers(self) -> list[tuple[int | None, dict[str, str]]]:
        """The side file's layers for a restore (catalog_recovery.reconcile's
        ``side_layers``), newest first."""
        side = self._side_file()
        if not side:
            return []
        layers = [(side.get("commit"), dict(side.get("purged") or {}))]
        previous = side.get("previous") or {}
        if previous.get("purged"):
            layers.append((previous.get("commit"), dict(previous["purged"])))
        return layers

    def _write_side_ahead(self, purged: dict[str, str], seq: int) -> bytes | None | bool:
        """Before a commit's rename: catalog-purged.json as that commit
        (``seq``) leaves the projects deleted for good, with the tombstones
        it takes away as the layer before it, when that changes the file.
        Returns the bytes it replaced (None: there was none), for
        _undo_side_file if the rename then fails, or False when nothing was
        written. Never fails the commit: a failed write is logged, and the
        file stays at its older commit, which a restore can tell (L-1)."""
        side = self._side_file()
        held = dict(side.get("purged") or {})
        if held == purged:
            return False
        path = self.root / PURGED_NAME
        try:
            try:
                before: bytes | None = path.read_bytes()
            except FileNotFoundError:
                before = None
            taken = {project_id: at for project_id, at in held.items() if project_id not in purged}
            body: dict[str, Any] = {"version": 1, "commit": seq, "commitCheck": catalog_recovery.commit_check(seq),
                                    "purged": purged}
            if taken:
                before_commit = side.get("commit")
                body["previous"] = {"commit": before_commit, "purged": taken,
                                    **({"commitCheck": catalog_recovery.commit_check(before_commit)}
                                       if before_commit is not None else {})}
            self._write_file(path, json.dumps(body, separators=(",", ":")).encode("utf-8"))
            self._side_purged = None
            return before
        except OSError as exc:
            self._side_purged = None
            _log(f"could not keep {PURGED_NAME}: {exc}; it stays at commit {side.get('commit')}, and a restore lets "
                 "the copies of later commits decide the projects they hold")
            return False

    def _undo_side_file(self, before: bytes | None | bool) -> None:
        """The rename the side file was written ahead of failed: put back
        what it held (best effort; if this fails too, the file is one commit
        ahead, which its own commit number says)."""
        if before is False:
            return
        path = self.root / PURGED_NAME
        try:
            if before is None:
                path.unlink(missing_ok=True)
            else:
                self._write_file(path, before)
        except OSError as exc:
            _log(f"could not put {PURGED_NAME} back after a failed commit: {exc}")
        self._side_purged = None

    def _side_after_commit(self, purged: dict[str, str]) -> None:
        """After the rename landed: a side file left with no tombstones goes."""
        if purged:
            return
        try:
            (self.root / PURGED_NAME).unlink(missing_ok=True)
        except OSError as exc:
            _log(f"could not remove the empty {PURGED_NAME}: {exc}")
        self._side_purged = None

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
        # Every commit is numbered, above every number this store wrote or
        # its restore saw and the side file's: the copies and the side file
        # then say which commit each is of (review 5, L-1).
        seq = catalog_recovery._commit_of(catalog.get("commitSeq")) or 0
        side_seq = self._side_file().get("commit") or 0
        catalog["commitSeq"] = max(seq, self._last_seq, side_seq) + 1
        catalog["commitCheck"] = catalog_recovery.commit_check(catalog["commitSeq"])
        self._last_seq = catalog["commitSeq"]
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
        self._prepared_purged = (temporary, catalog_recovery.purged_map(catalog.get("purged")), catalog["commitSeq"])
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
        purged, self._prepared_purged = self._prepared_purged, None
        if purged is not None and purged[0] != temporary:
            purged = None
        # The side file first, before the commit point (review 5, L-3): a
        # crash after it leaves it one commit ahead (its own number says so,
        # and each of its layers is true of a commit), never a delete for
        # good that landed without it.
        side_before = self._write_side_ahead(purged[1], purged[2]) if purged is not None else False
        # A successful atomic rename is the commit point. A post-commit
        # directory fsync warning must not report a failed, unadopted canvas.
        try:
            try:
                os.replace(temporary, self.path)
            except BaseException:
                self._undo_side_file(side_before)
                raise
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
            if purged is not None and side_before is not False:
                self._side_after_commit(purged[1])
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
