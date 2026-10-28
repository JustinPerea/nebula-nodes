"""Rebuilding a damaged project catalog: the pure part (no files).

services/project_store.py keeps every project whole inside catalog.json
(name, dates, cover, pins, Updates, questions, snapshot), plus two copies:
catalog.json.bak, the catalog as it was before the latest commit (a hard
link of the file that commit replaced, so one commit behind; a real copy of
each commit where links fail), and
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
  valid copy holding the newest catalog by its own dates
  (``catalog_freshness``), or an empty catalog (a rebuild).
  A copy is never newer than the damaged file, so:
  - a record the damaged file holds whole wins over the copy's, unless the
    copy's is strictly newer by its dates (updatedAt, lastOpenedAt,
    deletedAt, restoredAt): a file older than its copy (a sync tool) never
    rolls a project back;
  - a record the copy lacks is added back (to Recently deleted when it
    carries deletedAt);
  - a project deleted for good (``purged``, in a file's head) stays
    deleted when that file is the newest that says anything of it: a
    record in a newer file (the same id made again) wins over an older
    file's tombstone. File order decides, never a record's createdAt (a
    clock that ran ahead writes one later than the delete);
  - everything else the copy holds stays, and what that decided is
    reported: a record the damage cut off goes back to the copy's version
    (``reverted``), unless what is left of it shows it unchanged; one the
    damaged file had in the other group comes back from it (``came_back``:
    deleted after the copy, ``back_in_trash``: restored after the copy).

A record's id is what the record says (its ``id``), checked against its key
and the copy (review 2 of PR #199, M2): a bit flip in a key, an id or a
section name leaves the file valid JSON, and trusting the structure filed a
record under the wrong id and called the real one deleted. In a file that
doesn't parse, a record whose key the damage broke is found by its own
leading ``{"id":"<hex>"`` (review 3, M-A), and nothing nested deeper than a
record is ever counted as one (review 3, L-2).

Nothing here writes; nothing here decides wording.
"""
from __future__ import annotations

import bisect
import itertools
import json
import math
import re
from dataclasses import dataclass, field
from datetime import datetime
from typing import Any, Iterable

_ID = re.compile(r"^[a-f0-9]{32}$")
# A record's key in a catalog file: a project id, then the record's object.
_ENTRY_KEY = re.compile(r'"([a-f0-9]{32})"\s*:\s*(?=\{)')
# A record's own first member (make_project writes "id" first): how salvage
# finds a record whose key the damage broke (review 3 of PR #199, M-A).
_RECORD_OPEN = re.compile(r'\{\s*"id"\s*:\s*"([a-f0-9]{32})"')
# The members every project record opens with, in this order (make_project;
# a rename or a move to Recently deleted keeps their places).
_RECORD_HEAD = ("id", "name", "createdAt")
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


def reject_constant(name: str) -> Any:
    """json's parse_constant: NaN, Infinity and -Infinity are damage."""
    raise ValueError(f"{name} is not a value a catalog can hold")


_reject_constant = reject_constant


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
    # Never when a key, an id or a section name was damaged (review 2, M2):
    # what it lacks is then not proven gone.
    complete: bool = False
    holds: set[str] = field(default_factory=set)  # every id it holds, when complete
    sizes: dict[str, int] = field(default_factory=dict)  # each entry's encoded size
    # Whole records whose key and own id disagree (or whose key isn't an
    # id): (the key as an id or None, the record's id, the record, its
    # group). reconcile decides which id is theirs, with the copy's ids.
    misfiled: list[tuple[str | None, str, dict[str, Any], str | None]] = field(default_factory=list)

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


# The top-level fields a catalog holds (ProjectStore.prepare, _HEAD_KEYS).
CATALOG_FIELDS = frozenset(("version", "activeProjectId", "workspaceRevision", "migratedProjectId", "purged",
                            "projects", "trash"))


def holds_records(value: Any) -> bool:
    """Whether ``value`` is a map of project records (each an object, one
    at least with a snapshot): a section whose name was damaged."""
    if not isinstance(value, dict) or not value:
        return False
    return all(isinstance(entry, dict) for entry in value.values()) \
        and any("snapshot" in entry for entry in value.values())


def _own_id(entry: Any) -> str | None:
    own = entry.get("id") if isinstance(entry, dict) else None
    return own if isinstance(own, str) and _ID.fullmatch(own) else None


def _whole_active(whole: dict[str, Any], held: set[str]) -> Any:
    """A parsed catalog's open project, when it is one the file holds (or
    None): otherwise the value itself is damaged, so UNKNOWN."""
    active = whole.get("activeProjectId", _UNKNOWN)
    if active is None or (isinstance(active, str) and active in held):
        return active
    return _UNKNOWN


def _salvage_whole(found: Salvage, whole: dict[str, Any]) -> None:
    """Salvage of a file that parsed: every record, by its own id."""
    found.version = whole.get("version", _UNKNOWN)
    keys_whole = isinstance(whole.get("projects"), dict) \
        and isinstance(whole.get("trash", {}), dict)
    sections: list[tuple[str | None, dict[str, Any]]] = []
    for name, value in whole.items():
        if name in ("projects", "trash"):
            if isinstance(value, dict):
                sections.append((name, value))
        elif name not in CATALOG_FIELDS and holds_records(value):
            # A section whose name was damaged ("projectr"): its records
            # still say their own group (only Recently deleted's carry
            # deletedAt; reconcile files each by it).
            sections.append((None, value))
            keys_whole = False
    held: set[str] = set()
    for group, records in sections:
        for key, entry in records.items():
            key_id = key if isinstance(key, str) and _ID.fullmatch(key) else None
            own = _own_id(entry)
            if key_id is None and own is None:
                keys_whole = False  # a record nothing identifies
                continue
            if own is not None and own != key_id:
                # The key or the record's id was damaged: which is the
                # project's is decided with the copy (reconcile).
                found.misfiled.append((key_id, own, entry, group))
                held.update(x for x in (key_id, own) if x is not None)
                keys_whole = False
                continue
            # The key identifies it (its own id agrees, or is unreadable).
            held.add(key_id)
            if not (entry_ok(key_id, entry) and found.take(key_id, entry)):
                found.failed.setdefault(key_id, "invalid")
                found.groups.setdefault(key_id, group)
                found.partial.setdefault(key_id, _scalars(entry) if isinstance(entry, dict) else {})
    found.holds = held
    found.complete = keys_whole
    found.active = _whole_active(whole, held)
    found.purged = purged_map(whole.get("purged"))


def head_active(raw: bytes | None, parsed: Any = None) -> Any:
    """Which project a damaged catalog's head says was open: a project id,
    None (none), or UNKNOWN when it can't be read. Only the head is read
    (cheap at any size), or ``parsed`` when the file decoded."""
    if isinstance(parsed, dict):
        held = {key for section in ("projects", "trash") if isinstance(parsed.get(section), dict)
                for key in parsed[section]}
        held |= {own for section in ("projects", "trash") if isinstance(parsed.get(section), dict)
                 for own in map(_own_id, parsed[section].values()) if own}
        return _whole_active(parsed, held)
    if raw is None:
        return _UNKNOWN
    text = raw.decode("utf-8", errors="replace")
    opening = _SPACE.match(text).end()
    if not text.startswith("{", opening):
        return _UNKNOWN
    head, _end, _stop = _members(text, opening, stop_at=("projects", "trash"))
    active = head.get("activeProjectId", _UNKNOWN)
    if active is None or (isinstance(active, str) and _ID.fullmatch(active)):
        return active
    return _UNKNOWN


def _record_shaped(members: dict[str, Any]) -> bool:
    """Whether what was read of an object opens as a project record does:
    ``id``, ``name`` (a string) and ``createdAt`` (a dated time), first and
    in that order. A nested object that only shares a record's id and name
    ({"id", "name", "kind"}: a reference, an output map) doesn't (review 3,
    L-2)."""
    head = list(members)[:len(_RECORD_HEAD)]
    return head == list(_RECORD_HEAD) and isinstance(members.get("name"), str) \
        and _moment(members.get("createdAt")) is not None


def _at_record_depth(text: str, start: int) -> bool:
    """Whether the object opening at ``text[start]`` sits no deeper than a
    record does (inside the catalog and one of its groups). Read forward
    from it: past a record, what follows closes at most its group and the
    catalog, two levels; past an object nested in a record (a snapshot, a
    node's params), more closes before the file ends. A cut file closes
    fewer, so it never makes a record look nested. Read from the object
    itself, so damage before it (a broken key's stray quote, a torn page)
    can't throw the count."""
    depth = 0
    index = start
    while True:
        match = _TOKEN.search(text, index)
        if match is None:
            return True
        char, index = match.group(), match.end()
        if char == '"':
            while True:
                inner = _IN_STRING.search(text, index)
                if inner is None:
                    return True
                index = inner.end() + (1 if inner.group() == "\\" else 0)
                if inner.group() == '"':
                    break
        elif char in "{[":
            depth += 1
        else:
            depth -= 1
            if depth <= -3:
                return False


def _misfiled(found: Salvage, key_id: str | None, entry: dict[str, Any], group: str | None) -> bool:
    """Note a whole record whose own id isn't ``key_id`` (reconcile decides
    which is its). False when it isn't such a record."""
    own = _own_id(entry)
    if own is None or own == key_id or not entry_ok(own, entry):
        return False
    found.misfiled.append((key_id, own, entry, group))
    return True


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
        _salvage_whole(found, whole)
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
    # Where the key scan read an object from, and the spans it read (a whole
    # object, or a cut one up to where its decode stopped): a record anchor
    # inside one of them is that object's own member, never a record.
    read_from: set[int] = set()
    spans: list[tuple[int, int]] = []
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
        read_from.add(match.end())
        spans.append((match.end(), end if end is not None else max(stopped, match.end() + 1)))
        nested = not expected and end is not None and not _at_record_depth(text, match.end())
        if nested:
            # Whole, but deeper than a record sits: an object a record holds
            # (review 3, L-2), whatever its members say.
            position = end
            continue
        if not expected and members.get("id") == entry_id and _record_shaped(members):
            # No structure says a record belongs here (it follows a record
            # the damage cut), but its own members do: its id is its key and
            # it opens as a record does (id, name, createdAt). An object
            # nested in a record that shares only an id and a name (an output
            # map, a reference) is not counted (review 3, L-2; fix round 2's
            # live check: a torn open project after another torn record was
            # lost, and its canvas filed nameless). Its group is told only by
            # its own deletedAt; reconcile reads None as "can't be told".
            expected, group = True, ("trash" if isinstance(members.get("deletedAt"), str) else None)
        # A record that lost its closing brace holds the records after it as
        # its own members (a project id for a key): they are records.
        for inner_id in [key for key in members if _ID.fullmatch(key) and key != entry_id]:
            inner = members[inner_id]
            if (entry_ok(inner_id, inner) and found.take(inner_id, inner)) \
                    or (isinstance(inner, dict) and _misfiled(found, inner_id, inner, None)):
                del members[inner_id]
        entry = members if end is not None else None
        if entry is not None and ((entry_ok(entry_id, entry) and found.take(entry_id, entry))
                                  or _misfiled(found, entry_id, entry, group)):
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
            if inner_end is not None and not (entry_ok(inner_id, members) and found.take(inner_id, members)):
                _misfiled(found, inner_id, members, None)
        position = stop if stop > match.start() else match.start() + 1
    _salvage_by_own_id(found, text, read_from, spans)
    return found


def _salvage_by_own_id(found: Salvage, text: str, read_from: set[int], spans: list[tuple[int, int]]) -> None:
    """The records the key scan couldn't anchor on: a bit flip in a key's
    quote, colon or brace, or a hex digit turned into a control byte, a
    quote or a byte that isn't UTF-8, makes the file fail to parse and hides
    the key, while the record behind it is whole and holds its own id
    (review 3 of PR #199, M-A: about a quarter of the flips in a changed
    record's key reverted it, and no row said so). Each ``{"id":"<hex>"``
    the key scan didn't read from or inside, whose id no record has yet:
    - whole and a record (entry_ok) no deeper than a record sits: taken by
      its own id (reconcile files it as a misfiled record with no key);
    - cut, but opening as a record does (id, name, createdAt): reported as
      a record the damage cut, its group told only by its deletedAt.
    Anything else (an object a record holds) is not a record."""
    starts = sorted(spans)
    opens = [start for start, _end in starts]
    reach = list(itertools.accumulate((end for _start, end in starts), max))

    def inside(position: int) -> bool:
        at = bisect.bisect_right(opens, position) - 1
        return at >= 0 and position < reach[at]

    claimed = set(found.entries) | set(found.failed) | {own for _key, own, _entry, _group in found.misfiled}
    taken: list[tuple[int, int]] = []
    for match in _RECORD_OPEN.finditer(text):
        start, own = match.start(), match.group(1)
        if start in read_from or own in claimed or inside(start) \
                or any(opened < start < closed for opened, closed in taken):
            continue
        members, end, _stopped = _members(text, start)
        if end is not None:
            if not entry_ok(own, members) or not _at_record_depth(text, start):
                continue
            found.misfiled.append((None, own, members, "trash" if trashed(members) else "projects"))
            taken.append((start, end))
        elif _record_shaped(members):
            found.failed[own] = "incomplete"
            found.groups[own] = "trash" if isinstance(members.get("deletedAt"), str) else None
            found.partial[own] = _scalars(members)
        else:
            continue
        claimed.add(own)


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


def catalog_freshness(catalog: dict[str, Any]) -> datetime | None:
    """When a catalog last changed, by what it holds: the latest date on any
    record, or on a delete for good (ProjectStore._restore picks the newest
    copy by it, not by its name or mtime: review 2, L3)."""
    moments = [freshness(entry) for section in ("projects", "trash")
               for entry in (catalog.get(section) or {}).values() if isinstance(entry, dict)]
    moments.extend(_moment(at) for at in purged_map(catalog.get("purged")).values())
    found = [moment for moment in moments if moment is not None]
    return max(found) if found else None


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
    open_project_name: str | None = None  # the missing open project's name, when a file has it
    # Records filed under their own id rather than a damaged key, or under
    # the key the copy agrees with when their id was damaged: {id, key}.
    rekeyed: list[dict[str, Any]] = field(default_factory=list)


def _row(entry: dict[str, Any]) -> dict[str, Any]:
    return {"id": entry["id"], "name": entry["name"], "trashed": trashed(entry)}


def _resolve_misfiled(found: Salvage, copy_ids: set[str]) -> list[dict[str, Any]]:
    """File each of ``found``'s misfiled records under the id that is its
    (changes ``found``): its own id, unless the copy holds the key's and not
    its own (then the id field was the damaged part, and the record takes
    the key's id). Both in the copy: which it is can't be told, so neither
    takes it (each keeps the copy's version, reported). Returns {id, key}
    for each record filed."""
    filed: list[dict[str, Any]] = []
    for key_id, own, entry, group in found.misfiled:
        if key_id is not None and key_id in copy_ids and own in copy_ids:
            for either in (own, key_id):
                if either not in found.entries:
                    found.failed.setdefault(either, "invalid")
                    found.groups.setdefault(either, group)
                    found.partial.setdefault(either, _scalars(entry))
            continue
        true_id = key_id if key_id is not None and key_id in copy_ids and own not in copy_ids else own
        if true_id in found.entries:
            continue  # a record whose key and id agree already holds it
        record = entry if entry.get("id") == true_id else {**entry, "id": true_id}
        if entry_ok(true_id, record) and found.take(true_id, record):
            filed.append({"id": true_id, "key": key_id})
        else:
            found.failed.setdefault(true_id, "invalid")
            found.groups.setdefault(true_id, group)
            found.partial.setdefault(true_id, _scalars(entry))
    found.misfiled = []
    return filed


def _record_name(entry_id: str, salvages: list[Salvage], *places: dict[str, Any]) -> str | None:
    """A project's name, from the first place that holds its record."""
    for place in places:
        entry = place.get(entry_id)
        if isinstance(entry, dict) and isinstance(entry.get("name"), str):
            return entry["name"]
    for found in salvages:
        for source in (found.entries, found.partial):
            entry = source.get(entry_id)
            if isinstance(entry, dict) and isinstance(entry.get("name"), str):
                return entry["name"]
    return None


def _made_after(entry_id: str, at: str, salvages: list[Salvage], *places: dict[str, Any]) -> bool:
    """Whether some record of ``entry_id`` says it was made after its
    tombstone's time ``at``. Never decides anything (a clock that ran ahead
    writes such a createdAt: review 3, L-3); it only marks the row of a
    tombstone that drops such a record (``createdAfterDelete``), so the
    skew is on record."""
    purged_at = _moment(at)
    if purged_at is None:
        return False
    records = [place.get(entry_id) for place in places]
    for found in salvages:
        records.extend((found.entries.get(entry_id), found.partial.get(entry_id)))
    for record in records:
        created = _moment(record.get("createdAt")) if isinstance(record, dict) else None
        if created is not None and created > purged_at:
            return True
    return False


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
    copy_ids = set(projects) | set(trash)
    rekeyed: list[dict[str, Any]] = []
    for found in salvages:
        rekeyed.extend(_resolve_misfiled(found, copy_ids))
    # Deleted for good (a tombstone): the person's own act, written by a
    # commit that validated, so honoured even though the copy (older) still
    # has the project. Decided by file order alone, newest first (the
    # damaged ones, then the copy): the newest file that says anything of
    # an id decides it. A record in a newer file is the same id made again
    # (a recover retry after the delete, review 2's L1): every commit that
    # makes a project follows the delete it comes after, so its file is
    # newer than the tombstone's. Never by comparing a record's createdAt
    # with the tombstone's time: a clock that ran ahead when the project was
    # made writes a createdAt after a later delete, and brought a project
    # deleted for good back with no row (review 3, L-3). Within one file a
    # record wins (a commit never holds both).
    decided: dict[str, str | None] = {}  # id -> the tombstone's time, or None for a record
    for found in salvages:
        for entry_id in (*found.entries, *found.failed):
            decided.setdefault(entry_id, None)
        for entry_id, at in found.purged.items():
            decided.setdefault(entry_id, at)
    for entry_id in copy_ids:
        decided.setdefault(entry_id, None)
    for entry_id, at in purged_map(result.get("purged")).items():
        decided.setdefault(entry_id, at)
    purged: dict[str, str] = {entry_id: at for entry_id, at in decided.items() if at is not None}
    if purged:
        result["purged"] = purged
    else:
        result.pop("purged", None)
    for entry_id, at in purged.items():
        name = _record_name(entry_id, salvages, projects, trash)
        skewed = _made_after(entry_id, at, salvages, projects, trash)
        gone = projects.pop(entry_id, None) or trash.pop(entry_id, None)
        held = any(entry_id in found.entries or entry_id in found.failed for found in salvages)
        if gone is not None or held:
            # Every record a tombstone drops gets a row (agents and the log),
            # and one that says it was made after the delete says so.
            row: dict[str, Any] = {"id": entry_id, "name": name}
            if skewed:
                row["createdAfterDelete"] = True
            kept_deleted.append(row)
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
                came_back.append({"id": entry_id, "name": current["name"], "how": "trashed", "trashed": False})
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
                came_back.append({"id": entry_id, "name": current["name"], "how": "deleted",
                                  "trashed": trashed(current)})
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
    open_name = _record_name(open_missing, salvages, trash) if open_missing else None
    return Reconciled(result, added, updated, list(not_added.values()), active_from, open_missing,
                      reverted, came_back, back_in_trash, kept_deleted, open_name, rekeyed)
