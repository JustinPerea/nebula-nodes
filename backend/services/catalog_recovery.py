"""Rebuilding a damaged project catalog: the pure part (no files).

services/project_store.py keeps every project whole inside catalog.json
(name, dates, cover, pins, Updates, questions, snapshot), plus two copies:
catalog.json.bak, the catalog as it was before the latest commit (a hard
link of the file that commit replaced, so one commit behind), and
catalog.json.bak.1, an older real copy. There are no per-project folders to
rebuild from: what is "on disk" for a project is its record in one of those
files. So when catalog.json won't parse or validate, ProjectStore._restore
asks this module:

- ``salvage(raw)``: every complete, valid project record a damaged file
  still holds (a truncated file keeps every record before the cut, garbage
  in the middle loses only the records it touches), the records it started
  but can't finish (with the group they sat in and the top-level fields
  read before the damage), and what its head says (version, which project
  was open, the projects deleted for good). Linear in the file's size;
- ``reconcile(base, salvages)``: the restored catalog. ``base`` is the
  newest copy that parses and validates (or an empty catalog, a rebuild).
  A copy is never newer than the damaged file, so:
  - a record the damaged file holds whole wins over the copy's, unless the
    copy's is strictly newer by its dates (updatedAt, lastOpenedAt,
    deletedAt, restoredAt): a file older than its copy (a sync tool) never
    rolls a project back;
  - a record the copy lacks is added back (to Recently deleted when it
    carries deletedAt);
  - a project the damaged file says was deleted for good (``purged``, in
    its head) stays deleted, even though the copy still has it;
  - everything else the copy holds stays, and what that decided is
    reported: a record the damage cut off goes back to the copy's version
    (``reverted``), unless what is left of it shows it unchanged; one the
    damaged file had in the other group comes back from it (``came_back``:
    deleted after the copy, ``back_in_trash``: restored after the copy).

Nothing here writes; nothing here decides wording.
"""
from __future__ import annotations

import json
import math
import re
from dataclasses import dataclass, field
from datetime import datetime
from typing import Any, Iterable

_ID = re.compile(r"^[a-f0-9]{32}$")
# A record's key in a catalog file: a project id, then the record's object.
_ENTRY_KEY = re.compile(r'"([a-f0-9]{32})"\s*:\s*(?=\{)')
# The two groups a record sits in, right before the first record of each.
_GROUP_OPEN = re.compile(r'"(projects|trash)"\s*:\s*\{\s*$')
_SPACE = re.compile(r"\s*")
# Every field metadata() reads without a default, so a record without one
# would break the listing.
_REQUIRED = ("name", "createdAt", "updatedAt", "lastOpenedAt", "nodeCount", "edgeCount", "thumbnail")
# Dates on a record that say when it last changed (freshness).
_STAMPS = ("updatedAt", "lastOpenedAt", "deletedAt", "restoredAt")
# What a record costs in a catalog besides its own bytes: `"<32 hex>":` and a comma.
RECORD_OVERHEAD = 36
UNKNOWN: Any = type("Unknown", (), {"__repr__": lambda self: "UNKNOWN"})()
_UNKNOWN = UNKNOWN


def _reject_constant(name: str) -> Any:
    raise ValueError(f"{name} is not a value a catalog can hold")


def _finite(text: str) -> float:
    number = float(text)
    if not math.isfinite(number):
        raise ValueError(f"{text} is not a value a catalog can hold")
    return number


# json accepts NaN, Infinity and 1e999; the store writes with allow_nan=False
# and can't write them back (review 1, L2). Read strictly, so a file holding
# them is damage, not a catalog every write then fails on.
_DECODER = json.JSONDecoder(parse_constant=_reject_constant, parse_float=_finite)


def loads(text: str) -> Any:
    """json.loads, refusing what the store can't write back (ValueError)."""
    try:
        return _DECODER.decode(text)
    except RecursionError as exc:  # nested past what Python decodes
        raise ValueError("nested too deeply") from exc


def writable(value: Any) -> bool:
    """Whether the store can write ``value`` back (a lone surrogate in a
    string decodes, then can't be encoded as UTF-8)."""
    try:
        json.dumps(value, ensure_ascii=False, allow_nan=False, separators=(",", ":")).encode("utf-8")
    except (ValueError, RecursionError):
        return False
    return True


def encoded_size(value: Any) -> int | None:
    try:
        return len(json.dumps(value, ensure_ascii=False, allow_nan=False, separators=(",", ":")).encode("utf-8"))
    except (ValueError, RecursionError):
        return None


@dataclass
class Salvage:
    """What one damaged file still holds."""
    entries: dict[str, dict[str, Any]] = field(default_factory=dict)  # in file order
    failed: dict[str, str] = field(default_factory=dict)  # id -> "incomplete" | "invalid"
    # For each failed record: the group its key sat in ("projects", "trash"
    # or None when it can't be told) and its top-level fields read before
    # the damage (scalars only).
    groups: dict[str, str | None] = field(default_factory=dict)
    partial: dict[str, dict[str, Any]] = field(default_factory=dict)
    active: Any = _UNKNOWN  # a project id, None (nothing open), or UNKNOWN
    version: Any = _UNKNOWN
    purged: dict[str, str] = field(default_factory=dict)  # deleted for good: id -> when
    # The file parsed and both groups read whole, so a project it lacks is
    # one it doesn't hold (deleted after the copy, or by the damage itself).
    complete: bool = False
    holds: set[str] = field(default_factory=set)  # every id it holds, when complete
    sizes: dict[str, int] = field(default_factory=dict)  # each entry's encoded size

    def take(self, entry_id: str, entry: dict[str, Any]) -> bool:
        """Keep ``entry`` (entry_ok) unless the store couldn't write it back."""
        if entry_id in self.entries:
            return True
        size = encoded_size(entry)
        if size is None:
            return False
        self.entries[entry_id] = entry
        self.sizes[entry_id] = size
        self.failed.pop(entry_id, None)
        return True

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


def purged_map(value: Any) -> dict[str, str]:
    """A catalog's ``purged`` (id -> when it was deleted for good), the
    entries that read as such."""
    if not isinstance(value, dict):
        return {}
    return {key: at for key, at in value.items()
            if isinstance(key, str) and _ID.fullmatch(key) and _moment(at) is not None}


def _members(text: str, start: int, *, stop_at: tuple[str, ...] = ()) -> tuple[dict[str, Any], int | None, int]:
    """The members of the object opening at ``text[start]`` ("{"), as far
    as they decode: (members, the object's end or None, where decoding
    stopped). Stops before a key in ``stop_at`` without decoding its value."""
    found: dict[str, Any] = {}
    index = _SPACE.match(text, start + 1).end()
    if text.startswith("}", index):
        return found, index + 1, index + 1
    while True:
        if not text.startswith('"', index):
            return found, None, index
        try:
            key, index = _DECODER.raw_decode(text, index)
        except (ValueError, RecursionError):
            return found, None, index
        index = _SPACE.match(text, index).end()
        if not text.startswith(":", index):
            return found, None, index
        if key in stop_at:
            return found, None, index
        index = _SPACE.match(text, index + 1).end()
        try:
            value, after = _DECODER.raw_decode(text, index)
        except ValueError as exc:
            return found, None, max(getattr(exc, "pos", index) or index, index)
        except RecursionError:
            return found, None, index
        found[key] = value
        index = _SPACE.match(text, after).end()
        if text.startswith(",", index):
            index = _SPACE.match(text, index + 1).end()
            continue
        if text.startswith("}", index):
            return found, index + 1, index + 1
        return found, None, index


_TOKEN = re.compile(r'["{}\[\]]')
_IN_STRING = re.compile(r'["\\]')


def _complete_keyed_objects(text: str, start: int, stop: int) -> list[tuple[str, int]]:
    """The outermost objects in ``text[start:stop]`` that sit after a
    project-id key and close before ``stop``: (id, where the object opens).
    One pass, for the span a record's decode failed in (review 1, L5: each
    nested key used to be decoded again to the end of the file)."""
    keys = {match.end(): match.group(1) for match in _ENTRY_KEY.finditer(text, start, stop)}
    if not keys:
        return []
    stack: list[tuple[int, str | None]] = []
    spans: list[tuple[int, int, str]] = []
    index = start
    while True:
        match = _TOKEN.search(text, index, stop)
        if match is None:
            break
        char, index = match.group(), match.end()
        if char == '"':
            while True:
                inner = _IN_STRING.search(text, index, stop)
                if inner is None:
                    index = stop
                    break
                index = inner.end() + (1 if inner.group() == "\\" else 0)
                if inner.group() == '"':
                    break
        elif char in "{[":
            stack.append((match.start(), keys.get(match.start()) if char == "{" else None))
        elif stack:
            opened, key = stack.pop()
            if key is not None and char == "}":
                spans.append((opened, index, key))
    spans.sort()
    outermost: list[tuple[str, int]] = []
    reach = -1
    for opened, closed, key in spans:
        if opened >= reach:
            outermost.append((key, opened))
            reach = closed
    return outermost


def _scalars(members: dict[str, Any]) -> dict[str, Any]:
    return {key: value for key, value in members.items() if isinstance(value, (str, int, float, bool)) or value is None}


def salvage(raw: bytes, parsed: Any = _UNKNOWN) -> Salvage:
    """What ``raw`` (a damaged catalog file) still holds. ``parsed``: what
    the store already decoded it to, or None when it already failed to
    decode, so it isn't decoded twice (review 1, L5)."""
    found = Salvage()
    text = raw.decode("utf-8", errors="replace")
    whole = parsed
    if whole is _UNKNOWN:
        try:
            whole = loads(text)
        except ValueError:
            whole = None
    if isinstance(whole, dict):
        # It parses, so the shape is what's wrong: take each record on its own.
        found.version = whole.get("version", _UNKNOWN)
        groups_whole = True
        for group in ("projects", "trash"):
            records = whole.get(group, {} if group == "trash" else None)
            if not isinstance(records, dict):
                groups_whole = False
                continue
            for entry_id, entry in records.items():
                if not isinstance(entry_id, str) or not _ID.fullmatch(entry_id):
                    continue
                found.holds.add(entry_id)
                if not (entry_ok(entry_id, entry) and found.take(entry_id, entry)):
                    found.failed.setdefault(entry_id, "invalid")
                    found.groups.setdefault(entry_id, group)
                    found.partial.setdefault(entry_id, _scalars(entry) if isinstance(entry, dict) else {})
        found.complete = groups_whole
        active = whole.get("activeProjectId", _UNKNOWN)
        if active is None or (isinstance(active, str) and _ID.fullmatch(active)):
            found.active = active
        found.purged = purged_map(whole.get("purged"))
        return found
    # The head ProjectStore.prepare writes first (files saved before it put
    # activeProjectId last): readable even when the rest is cut.
    opening = _SPACE.match(text).end()
    if text.startswith("{", opening):
        head, _end, _stop = _members(text, opening, stop_at=("projects", "trash"))
        found.version = head.get("version", _UNKNOWN)
        if "activeProjectId" in head:
            active = head["activeProjectId"]
            if active is None or (isinstance(active, str) and _ID.fullmatch(active)):
                found.active = active
        found.purged = purged_map(head.get("purged"))
    position = 0
    last_end: int | None = None
    last_group: str | None = None
    while (match := _ENTRY_KEY.search(text, position)) is not None:
        entry_id = match.group(1)
        # A key where a record belongs (first in its group, or right after a
        # complete record) that doesn't hold one is a project the damage cut
        # off. A key anywhere else (inside a cut record) is not counted.
        opener = _GROUP_OPEN.search(text, max(0, match.start() - 40), match.start())
        if opener is not None:
            expected, group = True, opener.group(1)
        elif last_end is not None and text[last_end:match.start()].strip() == ",":
            expected, group = True, last_group
        else:
            expected, group = False, None
        members, end, stopped = _members(text, match.end())
        # A record that lost its closing brace holds the records after it as
        # its own members (a project id for a key): they are records.
        for inner_id in [key for key in members if _ID.fullmatch(key) and key != entry_id]:
            if entry_ok(inner_id, members[inner_id]) and found.take(inner_id, members[inner_id]):
                del members[inner_id]
        entry = members if end is not None else None
        if entry is not None and entry_ok(entry_id, entry) and found.take(entry_id, entry):
            # A whole record says its own group (only Recently deleted's carry
            # deletedAt), so a record the damage cut right after it gets the
            # right one even when no group opener was read before it (a
            # record found past an earlier cut).
            last_end, position = end, end
            last_group = group or ("trash" if trashed(entry) else "projects")
            continue
        if expected and entry_id not in found.entries:
            found.failed[entry_id] = "incomplete" if entry is None else "invalid"
            found.groups[entry_id] = group
            found.partial[entry_id] = _scalars(members)
        if entry is not None:
            # A whole object that isn't a record: what it holds is part of it.
            position = end
            continue
        # The decode stopped at ``stopped``: every key before it is inside
        # this record, so it is never decoded again from each of them. A
        # record swallowed whole (its neighbour's closing brace lost) is
        # still found, in one pass over that span.
        stop = max(stopped, match.end())
        for inner_id, opened in _complete_keyed_objects(text, match.end() + 1, stop):
            members, inner_end, _ = _members(text, opened)
            if inner_end is not None and entry_ok(inner_id, members):
                found.take(inner_id, members)
        position = stop if stop > match.start() else match.start() + 1
    return found


def _moment(value: Any) -> datetime | None:
    try:
        moment = datetime.fromisoformat(value) if isinstance(value, str) else None
    except ValueError:
        return None
    return moment if moment is not None and moment.tzinfo is not None else None


def freshness(entry: dict[str, Any]) -> datetime | None:
    """When a record last changed, as far as it says: its edit, its last
    open, its move to Recently deleted or back, whichever is latest."""
    moments = [moment for moment in (_moment(entry.get(key)) for key in _STAMPS) if moment is not None]
    return max(moments) if moments else None


def newer(candidate: dict[str, Any], current: dict[str, Any]) -> bool:
    found, kept = freshness(candidate), freshness(current)
    return found is not None and kept is not None and found > kept


def _unchanged(partial: dict[str, Any], current: dict[str, Any]) -> bool:
    """What is left of a cut record shows it as the copy has it: both its
    dates read, and every top-level value that read matches. Every change
    Nebula makes to a project moves one of them (refresh_metadata, an open,
    a move to or from Recently deleted)."""
    if "updatedAt" not in partial or "lastOpenedAt" not in partial:
        return False
    return all(current.get(key) == value for key, value in partial.items())


@dataclass
class Reconciled:
    catalog: dict[str, Any]
    added: list[dict[str, Any]]          # {id, name, trashed}: records the copy lacked
    updated: list[dict[str, Any]]        # {id, name, trashed}: records the damaged file held newer
    not_added: list[dict[str, Any]]      # {id, reason, name?, trashed?}: records found but not put in
    active_from: str                     # "canvas", "damaged file" or "none"
    open_project_missing: str | None     # the open project, when it couldn't come back
    reverted: list[dict[str, Any]] = field(default_factory=list)       # {id, name, trashed}: (a)
    came_back: list[dict[str, Any]] = field(default_factory=list)      # {id, name, how}: (b)
    back_in_trash: list[dict[str, Any]] = field(default_factory=list)  # {id, name}: (c)
    kept_deleted: list[dict[str, Any]] = field(default_factory=list)   # {id, name}: purges honoured


def _row(entry: dict[str, Any]) -> dict[str, Any]:
    return {"id": entry["id"], "name": entry["name"], "trashed": trashed(entry)}


def reconcile(base: dict[str, Any], salvages: Iterable[Salvage], *, max_projects: int,
              room_bytes: int, open_project: Any = _UNKNOWN) -> Reconciled:
    """``base`` (validated; changed in place and returned as ``catalog``)
    with what ``salvages`` hold, newest first. ``max_projects`` bounds the
    live list (ProjectStore's limit) and ``room_bytes`` how many encoded
    bytes may be added (each added record costs RECORD_OVERHEAD more); a
    record past either is left out and reported (it stays in the damaged
    file). ``open_project``: the project the live canvas is (main, from
    state.json), None for no project's, UNKNOWN when it isn't recorded."""
    result = base
    projects: dict[str, Any] = result["projects"]
    trash: dict[str, Any] = result.setdefault("trash", {})
    added: list[dict[str, Any]] = []
    updated: list[dict[str, Any]] = []
    not_added: dict[str, dict[str, Any]] = {}
    reverted: list[dict[str, Any]] = []
    came_back: list[dict[str, Any]] = []
    back_in_trash: list[dict[str, Any]] = []
    kept_deleted: list[dict[str, Any]] = []
    salvages = list(salvages)
    newest = salvages[0] if salvages else None
    # Deleted for good, as the copy and every damaged file remember it: the
    # person's own act, written by a commit that validated. Honoured even
    # though the copy (older) still has the project.
    purged = purged_map(result.get("purged"))
    for found in salvages:
        for entry_id, at in found.purged.items():
            purged.setdefault(entry_id, at)
    if purged:
        result["purged"] = purged
    for entry_id in purged:
        gone = projects.pop(entry_id, None) or trash.pop(entry_id, None)
        if gone is not None:
            kept_deleted.append({"id": entry_id, "name": gone.get("name")})
    copy_ids = set(projects) | set(trash)
    seen: set[str] = set()
    for found in salvages:
        for entry_id, entry in found.entries.items():
            if entry_id in seen or entry_id in purged:
                continue  # a newer file already decided it, or it was deleted for good
            seen.add(entry_id)
            current = projects.get(entry_id) or trash.get(entry_id)
            if current is not None:
                if entry == current:
                    continue
                if newer(current, entry):
                    # The copy's is newer by its dates (a damaged file older
                    # than its copy, or a restore from Recently deleted saved
                    # before restores were dated): the copy's stays.
                    if trashed(current) and not trashed(entry):
                        back_in_trash.append({"id": entry_id, "name": current["name"]})
                    continue
            size = found.sizes.get(entry_id)
            if size is None:
                size = encoded_size(entry)
            if size is None:
                not_added[entry_id] = {"id": entry_id, "reason": "invalid"}
                continue
            if current is None and size + RECORD_OVERHEAD > room_bytes:
                not_added[entry_id] = {"id": entry_id, "reason": "size", "name": entry["name"],
                                       "trashed": trashed(entry)}
                continue
            if not trashed(entry) and entry_id not in projects and len(projects) >= max_projects:
                not_added[entry_id] = {"id": entry_id, "reason": "limit", "name": entry["name"],
                                       "trashed": trashed(entry)}
                continue
            projects.pop(entry_id, None)
            trash.pop(entry_id, None)
            (trash if trashed(entry) else projects)[entry_id] = entry
            (added if current is None else updated).append(_row(entry))
            if current is None:
                room_bytes -= size + RECORD_OVERHEAD
        for entry_id, reason in found.failed.items():
            if entry_id in seen or entry_id in purged:
                continue
            seen.add(entry_id)
            current = projects.get(entry_id) or trash.get(entry_id)
            group = found.groups.get(entry_id)
            partial = found.partial.get(entry_id) or {}
            if current is None:
                row: dict[str, Any] = {"id": entry_id, "reason": reason}
                if isinstance(partial.get("name"), str):
                    row["name"] = partial["name"]
                if group is not None:
                    row["trashed"] = group == "trash"
                not_added.setdefault(entry_id, row)
            elif group == "trash" and not trashed(current):
                came_back.append({"id": entry_id, "name": current["name"], "how": "trashed"})
            elif group == "projects" and trashed(current):
                back_in_trash.append({"id": entry_id, "name": current["name"]})
            elif not _unchanged(partial, current):
                reverted.append(_row(current))
    # A complete file (it parsed; only its shape was wrong) that lacks a
    # project the copy has and doesn't say it was deleted for good: it was
    # deleted after the copy (or the damage dropped it). It stays, and says so.
    if newest is not None and newest.complete:
        for entry_id in sorted(copy_ids - newest.holds - set(purged),
                               key=lambda key: (projects.get(key) or trash.get(key) or {}).get("name", "")):
            current = projects.get(entry_id) or trash.get(entry_id)
            if current is not None:
                came_back.append({"id": entry_id, "name": current["name"], "how": "deleted"})
    # Which project is open. Never one the live canvas isn't: the next
    # listing saves the canvas into whichever is open (H1 of review 1).
    # - The canvas says which project it is: that one, if it came back live.
    # - It isn't recorded: the damaged file's, when its head says one and it
    #   came back live (the canvas is the latest commit's open project).
    # - Otherwise none: never the copy's, which may be another project.
    open_missing = None
    if open_project is not _UNKNOWN:
        wanted, source = open_project, "canvas"
    elif newest is not None and newest.active_known:
        wanted, source = newest.active, "damaged file"
    else:
        wanted, source = None, "none"
    if wanted is None:
        result["activeProjectId"], active_from = None, "none" if source != "damaged file" else source
    elif wanted in projects:
        result["activeProjectId"], active_from = wanted, source
    else:
        result["activeProjectId"], active_from, open_missing = None, "none", wanted
    if result.get("migratedProjectId") not in projects:
        result.pop("migratedProjectId", None)
    return Reconciled(result, added, updated, list(not_added.values()), active_from, open_missing,
                      reverted, came_back, back_in_trash, kept_deleted)
