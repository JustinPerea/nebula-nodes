"""Rebuilding a damaged project catalog: the pure part (no files).

services/project_store.py keeps every project whole inside catalog.json
(name, dates, cover, pins, Updates, questions, snapshot), plus a last good
copy after every commit (catalog.json.bak, and an older generation
catalog.json.bak.1). There are no per-project folders to rebuild from: what
is "on disk" for a project is its record in one of those files. So when
catalog.json won't parse or validate, ProjectStore._restore asks this module:

- ``salvage(raw)``: every complete, valid project record a damaged file
  still holds (a truncated file keeps every record before the cut, garbage
  in the middle loses only the records it touches), the ids of records it
  started but can't finish, and which project it had open when that can be
  read;
- ``reconcile(base, salvages)``: the restored catalog. ``base`` is the
  newest copy that parses and validates (or an empty catalog, a rebuild).
  A record the copy lacks is added back; a record the damaged file holds
  newer than the copy (a commit whose copy never landed, so a later edit or
  a move to Recently deleted) replaces it; an older or equal one never does,
  since the copy is known good and the damaged file may carry the damage.
  Nothing the copy holds is ever dropped: a record missing from the damaged
  file proves nothing.

Nothing here writes; nothing here decides wording.
"""
from __future__ import annotations

import copy
import json
import re
from dataclasses import dataclass, field
from datetime import datetime
from typing import Any, Iterable

_ID = re.compile(r"^[a-f0-9]{32}$")
# A record's key in a catalog file: a project id, then the record's object.
_ENTRY_KEY = re.compile(r'"([a-f0-9]{32})"\s*:\s*(?=\{)')
# The two groups a record sits in, right before the first record of each.
_GROUP_OPEN = re.compile(r'"(?:projects|trash)"\s*:\s*\{\s*$')
# The head ProjectStore.prepare writes first (and files saved before it
# don't have): which project was open, readable even when the rest is cut.
_HEAD = re.compile(r'^\s*\{\s*"version"\s*:\s*1\s*,\s*"activeProjectId"\s*:\s*(null|"([a-f0-9]{32})")')
# Every field metadata() reads without a default, so a record without one
# would break the listing.
_REQUIRED = ("name", "createdAt", "updatedAt", "lastOpenedAt", "nodeCount", "edgeCount", "thumbnail")
_UNKNOWN = object()


@dataclass
class Salvage:
    """What one damaged file still holds."""
    entries: dict[str, dict[str, Any]] = field(default_factory=dict)  # in file order
    failed: dict[str, str] = field(default_factory=dict)  # id -> "incomplete" | "invalid"
    active: Any = _UNKNOWN  # a project id, None (nothing open), or _UNKNOWN

    @property
    def active_known(self) -> bool:
        return self.active is not _UNKNOWN


def entry_ok(entry_id: Any, entry: Any) -> bool:
    """A record that can go into a catalog as it is: ProjectStore._check's
    rules for one record, plus the fields the listing reads."""
    if not isinstance(entry_id, str) or not _ID.fullmatch(entry_id):
        return False
    if not isinstance(entry, dict) or entry.get("id") != entry_id:
        return False
    snapshot = entry.get("snapshot")
    if not isinstance(snapshot, dict) or not isinstance(snapshot.get("nodes"), list) \
            or not isinstance(snapshot.get("edges"), list):
        return False
    if any(key not in entry for key in _REQUIRED) or not isinstance(entry.get("name"), str):
        return False
    if "deletedAt" in entry:
        deleted = entry["deletedAt"]
        try:
            if not isinstance(deleted, str) or datetime.fromisoformat(deleted).tzinfo is None:
                return False
        except ValueError:
            return False
    return True


def trashed(entry: dict[str, Any]) -> bool:
    """A record in Recently deleted carries when it was deleted; a live one
    never does (restore_from_trash takes it off)."""
    return "deletedAt" in entry


def salvage(raw: bytes) -> Salvage:
    found = Salvage()
    text = raw.decode("utf-8", errors="replace")
    try:
        whole = json.loads(text)
    except ValueError:
        whole = _UNKNOWN
    if isinstance(whole, dict):
        # It parses, so the shape is what's wrong: take each record on its own.
        for group in ("projects", "trash"):
            records = whole.get(group)
            if not isinstance(records, dict):
                continue
            for entry_id, entry in records.items():
                if entry_ok(entry_id, entry):
                    found.entries.setdefault(entry_id, entry)
                elif isinstance(entry_id, str) and _ID.fullmatch(entry_id):
                    found.failed.setdefault(entry_id, "invalid")
        active = whole.get("activeProjectId")
        if active is None or (isinstance(active, str) and _ID.fullmatch(active)):
            found.active = active
        return found
    head = _HEAD.match(text)
    if head:
        found.active = head.group(2)  # None for null
    decoder = json.JSONDecoder()
    position = 0
    last_end: int | None = None
    while (match := _ENTRY_KEY.search(text, position)) is not None:
        entry_id = match.group(1)
        # A key where a record belongs (first in its group, or right after a
        # complete record) that doesn't hold one is a project the damage cut
        # off. A key anywhere else (inside a cut record) is not counted.
        expected = ((last_end is not None and text[last_end:match.start()].strip() == ",")
                    or _GROUP_OPEN.search(text, max(0, match.start() - 40), match.start()) is not None)
        try:
            entry, end = decoder.raw_decode(text, match.end())
        except ValueError:
            if expected and entry_id not in found.entries:
                found.failed[entry_id] = "incomplete"
            position = match.start() + 1
            continue
        if entry_ok(entry_id, entry):
            found.entries.setdefault(entry_id, entry)
            found.failed.pop(entry_id, None)
            last_end = position = end
            continue
        if expected and entry_id not in found.entries:
            found.failed[entry_id] = "invalid"
        position = match.start() + 1
    return found


def _moment(value: Any) -> datetime | None:
    try:
        moment = datetime.fromisoformat(value) if isinstance(value, str) else None
    except ValueError:
        return None
    return moment if moment is not None and moment.tzinfo is not None else None


def freshness(entry: dict[str, Any]) -> datetime | None:
    """When a record last changed, as far as it says: its edit, its last
    open, or its move to Recently deleted, whichever is latest."""
    moments = [moment for moment in (_moment(entry.get(key)) for key in ("updatedAt", "lastOpenedAt", "deletedAt"))
               if moment is not None]
    return max(moments) if moments else None


def newer(candidate: dict[str, Any], current: dict[str, Any]) -> bool:
    found, kept = freshness(candidate), freshness(current)
    return found is not None and kept is not None and found > kept


@dataclass
class Reconciled:
    catalog: dict[str, Any]
    added: list[dict[str, Any]]      # {id, name, trashed}: records the copy lacked
    updated: list[dict[str, Any]]    # {id, name, trashed}: records the damaged file held newer
    not_added: list[dict[str, Any]]  # {id, reason}: records found but not put in
    active_from: str                 # "damaged file", "copy" or "none"
    open_project_missing: str | None  # the damaged file's open project, when it couldn't come back


def _row(entry: dict[str, Any]) -> dict[str, Any]:
    return {"id": entry["id"], "name": entry["name"], "trashed": trashed(entry)}


def reconcile(base: dict[str, Any], salvages: Iterable[Salvage], *, max_projects: int,
              room_bytes: int) -> Reconciled:
    """``base`` (validated, not changed) with what ``salvages`` hold, newest
    first. ``max_projects`` bounds the live list (ProjectStore's limit) and
    ``room_bytes`` how many encoded bytes may be added; a record past either
    is left out and reported (it stays in the damaged file)."""
    result = copy.deepcopy(base)
    projects: dict[str, Any] = result["projects"]
    trash: dict[str, Any] = result.setdefault("trash", {})
    added: list[dict[str, Any]] = []
    updated: list[dict[str, Any]] = []
    not_added: dict[str, str] = {}
    seen: set[str] = set()
    failed: dict[str, str] = {}
    salvages = list(salvages)
    newest = salvages[0] if salvages else None
    for found in salvages:
        for entry_id, reason in found.failed.items():
            failed.setdefault(entry_id, reason)
        for entry_id, entry in found.entries.items():
            if entry_id in seen:
                continue  # a newer file already decided it
            seen.add(entry_id)
            current = projects.get(entry_id) or trash.get(entry_id)
            if current is not None and not newer(entry, current):
                continue
            size = len(json.dumps(entry, ensure_ascii=False, allow_nan=False, separators=(",", ":")).encode("utf-8"))
            if current is None and size > room_bytes:
                not_added[entry_id] = "size"
                continue
            if not trashed(entry) and entry_id not in projects and len(projects) >= max_projects:
                not_added[entry_id] = "limit"
                continue
            projects.pop(entry_id, None)
            trash.pop(entry_id, None)
            (trash if trashed(entry) else projects)[entry_id] = copy.deepcopy(entry)
            (added if current is None else updated).append(_row(entry))
            if current is None:
                room_bytes -= size
    for entry_id, reason in failed.items():
        if entry_id not in projects and entry_id not in trash:
            not_added.setdefault(entry_id, reason)
    # Which project is open: the damaged file's, when it says and it came
    # back live; otherwise the copy's. Never a project other than the one
    # the damaged file had open: the live canvas (state.json) is that
    # project's, and the next listing would save it into whichever is open.
    open_missing = None
    if newest is not None and newest.active_known:
        wanted = newest.active
        if wanted is None or wanted in projects:
            result["activeProjectId"], active_from = wanted, "damaged file"
        else:
            result["activeProjectId"], active_from, open_missing = None, "none", wanted
    elif result.get("activeProjectId") in projects:
        active_from = "copy"
    else:
        result["activeProjectId"], active_from = None, "none"
    if result.get("migratedProjectId") not in projects:
        result.pop("migratedProjectId", None)
    return Reconciled(result, added, updated, [{"id": key, "reason": value} for key, value in not_added.items()],
                      active_from, open_missing)
