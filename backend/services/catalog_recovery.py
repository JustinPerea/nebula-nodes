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
  - a project deleted for good (``purged``, in a file's head, and in
    catalog-purged.json beside it, written before every commit's rename
    with its commit number and the layer before, so a damaged head doesn't
    lose the last delete and a crash between leaves it true of a commit:
    review 4, L-3; review 5, L-1/L-3; each layer is placed in the files'
    order by its commit number, ``side_layers``) stays deleted when
    that file is the newest that says anything of it: a record in a newer
    file (the same id made again) wins over an older file's tombstone. File
    order decides, never a record's createdAt (a clock that ran ahead
    writes one later than the delete), except that a file whose newest date
    is older than the tombstone can't bring it back (an older damaged
    catalog.json: review 4, L-2);
  - a date ahead of the restore's own clock (``until``) is judged by file
    order (review 5, M-2): in the newer file it counts as now
    (FUTURE_IS_NOW: a clock that ran ahead and was corrected wrote the
    newest files), in the older it never counts (FUTURE_DROPS: a copy
    saved ahead is never "newer": review 4, M-3); a whole record that loses
    to an older copy by dates is reported (``reverted``, by "dates");
  - everything else the copy holds stays, and what that decided is
    reported: a record the damage cut off goes back to the copy's version
    (``reverted``), unless what is left of it shows it unchanged; one the
    damaged file had in the other group comes back from it (``came_back``:
    deleted after the copy, ``back_in_trash``: restored after the copy).

Every pattern matches JSON's own whitespace (space, tab, newline, return:
``_WS``), never ``\\s``, which also takes the bytes 0x1c-0x1f and 0x85 that
one flipped bit makes of a structural byte (review 5, M-1).

A record's id is what the record says (its ``id``), checked against its key
and the copy (review 2 of PR #199, M2): a bit flip in a key, an id or a
section name leaves the file valid JSON, and trusting the structure filed a
record under the wrong id and called the real one deleted. In a file that
doesn't parse, a record whose key the damage broke is found by its own
leading ``{"id":"<hex>"`` (review 3, M-A), or, when the flip took its
opening brace, by ``"<hex>":X"id":"<the same hex>"`` (review 4, M-2), and
nothing nested deeper than a record is ever counted as one (review 3, L-2):
its depth is counted both forward from it and from the last point known to
sit between records, and where damage makes neither readable it isn't taken
(review 4, L-5). A record whose key and id both changed and land one
character off a copy record keeps the copy's version (L-5's two-flip set),
and a record in Recently deleted's group without deletedAt (a changed key)
is never "in Recently deleted again" (review 4, L-4).

Nothing here writes; nothing here decides wording.
"""
from __future__ import annotations

import bisect
import itertools
import json
import math
import re
import zlib
from dataclasses import dataclass, field
from datetime import datetime
from typing import Any, Iterable

_ID = re.compile(r"^[a-f0-9]{32}$")
# JSON's whitespace: space, tab, LF and CR, nothing else. Never Python's
# ``\s``, which on a str also matches 0x1c-0x1f, 0x0b, 0x0c, 0x85 and the
# Unicode spaces: one bit turns "]" (0x5d) into 0x1d, and reading that as a
# space left a group's bracket open, so every record after it counted one
# level deep and lost to the copy's older version with no row (review 5 of
# PR #199, M-1). Every pattern below that means JSON whitespace uses _WS.
_WS = r"[ \t\n\r]"
_JSON_SPACE = " \t\n\r"
# A record's key in a catalog file: a project id, then the record's object.
_ENTRY_KEY = re.compile(rf'"([a-f0-9]{{32}})"{_WS}*:{_WS}*(?=\{{)')
# A record's own first member (make_project writes "id" first): how salvage
# finds a record whose key the damage broke (review 3 of PR #199, M-A).
_RECORD_OPEN = re.compile(rf'\{{{_WS}*"id"{_WS}*:{_WS}*"([a-f0-9]{{32}})"')
# A record whose own opening brace the damage changed (review 4 of PR #199,
# M-2: one bit turns "{" into "z", "y", "s", "k", "[", ";", 0x7f or a byte
# that isn't UTF-8, and both anchors above hang on that byte): its key, one
# byte that isn't a brace, then its own id, the same as the key. The second
# group is where the brace was.
_BROKEN_OPEN = re.compile(rf'"([a-f0-9]{{32}})"{_WS}*:{_WS}*([^ \t\n\r{{"]){_WS}*"id"{_WS}*:{_WS}*"\1"')
# The members every project record opens with, in this order (make_project;
# a rename or a move to Recently deleted keeps their places).
_RECORD_HEAD = ("id", "name", "createdAt")
# The two groups a record sits in, right before the first record of each.
_GROUP_OPEN = re.compile(rf'"(projects|trash)"{_WS}*:{_WS}*\{{{_WS}*$')
# A group's key, right before the colon the head's read stopped at.
_GROUP_KEY = re.compile(rf'"(projects|trash)"{_WS}*$')
# The same before a record whose key the damage broke (up to its colon).
_GROUP_BEFORE_KEY = re.compile(rf'"(projects|trash)"{_WS}*:{_WS}*\{{[^{{}}\[\]]{{0,40}}$')
_SPACE = re.compile(rf"{_WS}*")
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
    # The group each entry sat in, where the file says ("projects", "trash"),
    # so a record is said to be back in Recently deleted only when this file
    # had it in the list (review 4, L-4).
    entry_groups: dict[str, str] = field(default_factory=dict)
    # The file's commit number (its head's ``commitSeq``), when it reads.
    seq: int | None = None
    # Its ``canvasPending`` (what protects the person's canvas: written in
    # the head since review 10 of PR #199, HIGH-1), as read, or None.
    pending: Any = None

    def take(self, entry_id: str, entry: dict[str, Any], group: str | None = None) -> bool:
        """Keep ``entry`` (entry_ok) unless the store couldn't write it back."""
        if entry_id in self.entries:
            return True
        size = encoded_size(entry)
        if size is None:
            return False
        self.entries[entry_id] = entry
        self.sizes[entry_id] = size
        if group is not None:
            self.entry_groups[entry_id] = group
        self.failed.pop(entry_id, None)
        self.groups.pop(entry_id, None)
        self.partial.pop(entry_id, None)
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


def fits_group(entry: dict[str, Any], group: str | None) -> bool:
    """A record in Recently deleted's group carries when it was deleted
    (ProjectStore._check): one that lacks it there is damaged (a flipped
    bit in the key "deletedAt"), never a record restored since (review 4 of
    PR #199, L-4: it read as "is in Recently deleted again")."""
    return group != "trash" or "deletedAt" in entry


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
# What JSON allows between its tokens outside strings: a damaged quote reads
# the text around it inside out, and that text (a name, a key) isn't this.
_BETWEEN = re.compile(r'(?:[ \t\n\r,:0-9.eE+\-]|true|false|null)*')
# The same at a file's end, which a cut may leave inside a literal ("nu").
_BETWEEN_AT_END = re.compile(r'(?:[ \t\n\r,:0-9.eE+\-]|true|false|null)*(?:tru|tr|t|fals|fal|fa|f|nul|nu|n)?')
# Filler a torn page leaves (zeros, bytes that aren't UTF-8): it hides what
# was there, but isn't text read inside out.
_FILLER = re.compile(r'[\x00\ufffd]')
CLEAN, FILLER, BROKEN = 0, 1, 2


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
CATALOG_FIELDS = frozenset(("version", "commitSeq", "commitCheck", "activeProjectId", "workspaceRevision", "migratedProjectId",
                            "purged", "projects", "trash", "canvasPending"))


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
            if not (entry_ok(key_id, entry) and fits_group(entry, group) and found.take(key_id, entry, group)):
                found.failed.setdefault(key_id, "invalid")
                found.groups.setdefault(key_id, group)
                found.partial.setdefault(key_id, _scalars(entry) if isinstance(entry, dict) else {})
    found.holds = held
    found.complete = keys_whole
    found.active = _whole_active(whole, held)
    found.purged = purged_map(whole.get("purged"))
    found.seq = proven_commit(whole)
    found.pending = whole.get("canvasPending")


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


def _scan(text: str, start: int, stop: int | None = None, depth: int = 0) -> tuple[int, int, bool]:
    """Read the structure of ``text[start:stop]``: (its depth at the end,
    how the bytes between tokens outside strings read: CLEAN as JSON allows,
    FILLER with a torn page's zeros among them, BROKEN with text JSON
    doesn't allow there (a broken quote reads the text around it inside
    out), whether a string was still open at the end), from ``depth``.
    Stops early, with the depth so far, at -3 or where it is BROKEN, and at
    a torn page (two zeros in a row, which no single flip makes): past one
    the bytes are another page's, so nothing after it can be counted, and
    what was read up to it is FILLER (fix round 4's run: a torn record after
    a whole one read its leftover text as broken, so the whole record looked
    nested and was lost)."""
    index = start
    limit = len(text) if stop is None else stop
    torn = text.find("\x00\x00", start, limit)
    if torn != -1:
        limit = torn
    state = CLEAN if torn == -1 else FILLER
    while True:
        match = _TOKEN.search(text, index, limit)
        between = _BETWEEN_AT_END if match is None and (limit == len(text) or torn != -1) else _BETWEEN
        end = match.start() if match else limit
        if not between.fullmatch(text, index, end):
            if not between.fullmatch(_FILLER.sub("", text[index:end])):
                return depth, BROKEN, False
            state = FILLER
        if match is None:
            return depth, state, False
        char, index = match.group(), match.end()
        if char == '"':
            while True:
                inner = _IN_STRING.search(text, index, limit)
                if inner is None:
                    return depth, state, True
                index = inner.end() + (1 if inner.group() == "\\" else 0)
                if inner.group() == '"':
                    break
        elif char in "{[":
            depth += 1
        else:
            depth -= 1
            if depth <= -3:
                return depth, state, False


def _depth_after(text: str, start: int) -> bool | None:
    """Whether the object opening at ``text[start]`` sits no deeper than a
    record does, read forward from it: past a record, what follows closes
    at most its group and the catalog, two levels; past an object nested in
    a record (a snapshot, a node's params), more closes before the file
    ends. A cut file closes fewer, so it never makes a record look nested.
    None when it can't be told: text JSON doesn't allow between tokens comes
    first (a broken quote after the object reads every brace that closes it
    as text, and the text around it as structure: review 4 of PR #199, L-5).
    A torn page's zeros are read past, as before. ``text[start]`` may be the
    byte that took a record's opening brace (M-2): the scan then starts
    inside it."""
    opened = text.startswith(("{", "["), start)
    depth, state, _open_string = _scan(text, start, depth=0) if opened else _scan(text, start + 1, depth=1)
    if depth <= -3:
        return False
    return None if state == BROKEN else True


def _depth_before(text: str, start: int, anchors: list[int]) -> int | None:
    """How deep ``text[start]`` sits below the group a record sits in,
    counted from the nearest point before it known to be between two
    records (a group's opening, a record's key where one belongs, the end
    of a record taken whole). None when there is none, or when what lies
    between doesn't read as JSON (the damage is there: a broken key, a torn
    record) and so can't be counted."""
    at = bisect.bisect_right(anchors, start) - 1
    if at < 0:
        return None
    depth, state, open_string = _scan(text, anchors[at], start)
    if state != CLEAN or open_string:
        return None
    return depth


def _at_record_place(text: str, start: int, anchors: list[int]) -> bool:
    """Whether the object opening at ``text[start]`` sits where a record
    does, by both counts: forward from it (_depth_after) and from the last
    point before it known to be between records (_depth_before). Damage on
    one side of it can throw one count, never both (a single flip); when
    one can't be read, the other decides; when neither can, it isn't taken
    (review 4 of PR #199, L-5: a broken quote after a whole record-shaped
    object nested in a record made the forward count call it a record)."""
    after = _depth_after(text, start)
    if after is False:
        return False
    before = _depth_before(text, start, anchors)
    if before is not None and before != 0:
        return False
    return after is True or before == 0


def _misfiled(found: Salvage, key_id: str | None, entry: dict[str, Any], group: str | None) -> bool:
    """Note a whole record whose own id isn't ``key_id`` (reconcile decides
    which is its). False when it isn't such a record."""
    own = _own_id(entry)
    if own is None or own == key_id or not entry_ok(own, entry):
        return False
    found.misfiled.append((key_id, own, entry, group))
    return True


# What JSON allows outside strings: structure, whitespace and scalars' text.
_JSON_OUTSIDE = frozenset(' \t\r\n{}[]:,-+.0123456789eEtrufalsn')


def _projects_closed_before_damage(text: str) -> bool:
    """Whether ``text`` (a damaged catalog file) shows its "projects" group
    opened and closed inside the top-level object before its damage, so the
    damage cut no project record off (GM r19 on PR #199, 6a). A bracket and
    string tracker reads up to the first byte JSON doesn't allow there (or
    the end). What comes after the group closed doesn't count: a cut trash
    group isn't in the notice (GM: lost Recently deleted entries are logged,
    not in the notice). False for anything else (no top-level object, a cut
    inside the group or one of its records, the group key never seen or
    damaged): unsure is False."""
    index = len(text) - len(text.lstrip())
    if index >= len(text) or text[index] != "{":
        return False
    depth = 0
    in_string = escaped = False
    string_start = 0
    expect_key = False
    key: str | None = None
    opened_in: str | None = None
    for at in range(index, len(text)):
        char = text[at]
        if in_string:
            if escaped:
                escaped = False
            elif char == "\\":
                escaped = True
            elif char == '"':
                in_string = False
                if depth == 1 and expect_key:
                    key, expect_key = text[string_start:at], False
            elif char < " ":
                return False  # a control byte inside a string (a zeroed page): the damage
            continue
        if char == '"':
            in_string, string_start = True, at + 1
        elif char not in _JSON_OUTSIDE:
            return False  # the damage
        elif char in "{[":
            depth += 1
            if depth == 1:
                expect_key = True
            elif depth == 2:
                opened_in = key
        elif char in "}]":
            depth -= 1
            if depth <= 0:
                return False  # the top-level object closed without it
            if depth == 1:
                if opened_in == "projects":
                    return True
                opened_in = None
        elif char == "," and depth == 1:
            expect_key, key = True, None
    return False


def records_unread(raw: bytes | None, found: Salvage | None, read_whole: bool) -> bool:
    """Whether the damaged catalog.json held project records Nebula couldn't
    read (GM r19 on PR #199, 6a): the restore notice's "changes made after
    that copy may be missing" is true only then. The rule: read whole,
    False. Otherwise True when a record that failed sat in the projects
    group or in a group that can't be told, or when the "projects" member
    wasn't seen opened and closed at depth 1 before the damage
    (_projects_closed_before_damage); else False. A cut trash group, or any
    damage after the projects group closed, is False: lost Recently deleted
    entries are logged, not in the notice (GM)."""
    if read_whole:
        return False
    if raw is None or found is None:
        return True
    if any(found.groups.get(entry_id) in ("projects", None) for entry_id in found.failed):
        return True
    return not _projects_closed_before_damage(raw.decode("utf-8", errors="replace"))


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
    # Points known to sit between two records in a group (a group's opening,
    # a record's key where one belongs, the end of a record taken whole):
    # where _at_record_place counts a candidate's depth from (review 4, L-5).
    anchors: list[int] = []
    anchor_groups: dict[int, str | None] = {}  # the group each anchor sits in, where known
    if text.startswith("{", opening):
        head, _end, stop = _members(text, opening, stop_at=("projects", "trash"))
        group_at = _SPACE.match(text, stop + 1).end() if text.startswith(":", stop) else None
        if group_at is not None and text.startswith("{", group_at):
            anchors.append(group_at + 1)
            named = _GROUP_KEY.search(text, max(0, stop - 24), stop)
            anchor_groups[group_at + 1] = named.group(1) if named else None
        found.version = head.get("version", _UNKNOWN)
        if "activeProjectId" in head:
            active = head["activeProjectId"]
            if active is None or (isinstance(active, str) and _ID.fullmatch(active)):
                found.active = active
        found.purged = purged_map(head.get("purged"))
        found.seq = proven_commit(head)
        found.pending = head.get("canvasPending")
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
        elif last_end is not None and text[last_end:match.start()].strip(_JSON_SPACE) == ",":
            expected, group = True, last_group
        else:
            expected, group = False, None
        if expected:
            bisect.insort(anchors, match.start())
            anchor_groups[match.start()] = group
        members, end, stopped = _members(text, match.end())
        read_from.add(match.end())
        spans.append((match.end(), end if end is not None else max(stopped, match.end() + 1)))
        nested = not expected and end is not None and not _at_record_place(text, match.end(), anchors)
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
        # Where the structure puts it, for Recently deleted's rule (L-4).
        placed = group if group is not None else _group_at(text, match.start(), anchors, anchor_groups)
        if entry is not None and ((entry_ok(entry_id, entry) and fits_group(entry, placed)
                                   and found.take(entry_id, entry, group))
                                  or (fits_group(entry, placed) and _misfiled(found, entry_id, entry, group))):
            # A whole record says its own group (only Recently deleted's carry
            # deletedAt), so a record the damage cut right after it gets the
            # right one even when no group opener was read before it (a
            # record found past an earlier cut).
            last_end, position = end, end
            last_group = group or ("trash" if trashed(entry) else "projects")
            bisect.insort(anchors, end)
            anchor_groups[end] = last_group
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
    _salvage_by_own_id(found, text, read_from, spans, anchors, anchor_groups)
    return found


def _group_at(text: str, start: int, anchors: list[int], anchor_groups: dict[int, str | None]) -> str | None:
    """The group the structure says a record found by its own id sits in:
    the group opening right before its (broken) key, else the nearest point
    before it known to be in a group. None when neither says."""
    opener = _GROUP_BEFORE_KEY.search(text, max(0, start - 80), start)
    if opener is not None:
        return opener.group(1)
    at = bisect.bisect_right(anchors, start) - 1
    return anchor_groups.get(anchors[at]) if at >= 0 else None


def _salvage_by_own_id(found: Salvage, text: str, read_from: set[int], spans: list[tuple[int, int]],
                       anchors: list[int], anchor_groups: dict[int, str | None]) -> None:
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
    And each ``"<hex>":X"id":"<the same hex>"``, a record whose opening
    brace the damage changed into X (review 4, M-2): read as if the brace
    were there, under its key (key and id agree), by the same rules.
    Either is a record only where both depth counts allow (_at_record_place).
    Anything else (an object a record holds) is not a record."""
    starts = sorted(spans)
    opens = [start for start, _end in starts]
    reach = list(itertools.accumulate((end for _start, end in starts), max))

    def inside(position: int) -> bool:
        at = bisect.bisect_right(opens, position) - 1
        return at >= 0 and position < reach[at]

    claimed = set(found.entries) | set(found.failed) | {own for _key, own, _entry, _group in found.misfiled}
    taken: list[tuple[int, int]] = []
    candidates = sorted([(match.start(), match.group(1), False) for match in _RECORD_OPEN.finditer(text)]
                        + [(match.start(2), match.group(1), True) for match in _BROKEN_OPEN.finditer(text)])
    for start, own, keyed in candidates:
        if start in read_from or own in claimed or inside(start) \
                or any(opened < start < closed for opened, closed in taken):
            continue
        members, end, _stopped = _members(text, start)
        if end is not None:
            if not entry_ok(own, members) or not _at_record_place(text, start, anchors):
                continue
            placed = _group_at(text, start, anchors, anchor_groups)
            if not fits_group(members, placed):
                # In Recently deleted's group without deletedAt: a key the
                # damage changed ("d%letedAt"), never a restore (review 4, L-4).
                found.failed[own] = "invalid"
                found.groups[own] = placed
                found.partial[own] = _scalars(members)
                claimed.add(own)
                continue
            group = "trash" if trashed(members) else "projects"
            if keyed:
                if not found.take(own, members, group):
                    continue
            else:
                found.misfiled.append((None, own, members, group))
            taken.append((start, end))
        elif _record_shaped(members):
            found.failed[own] = "incomplete"
            found.groups[own] = "trash" if isinstance(members.get("deletedAt"), str) else None
            found.partial[own] = _scalars(members)
        else:
            continue
        claimed.add(own)


def dated(value: Any) -> bool:
    """Whether ``value`` is a time with its zone, as Nebula writes them."""
    return _moment(value) is not None


def _moment(value: Any) -> datetime | None:
    try:
        moment = datetime.fromisoformat(value) if isinstance(value, str) else None
    except ValueError:
        return None
    return moment if moment is not None and moment.tzinfo is not None else None


# What a date ahead of the restore's clock (``until``) counts as, by file
# order (review 5 of PR #199, M-2). A clock that ran ahead and was then
# corrected leaves future dates in whichever files were written meanwhile,
# and those are the newest files, not only an older copy.
# - FUTURE_DROPS, in the older file of a comparison (.bak.1 against .bak, a
#   copy's record against the damaged file's): left out, so a date from the
#   future never makes the older file win (review 4, M-3);
# - FUTURE_IS_NOW, in the newer file (catalog.json, then .bak): it counts as
#   ``until``, so the newer file's change made while the clock was ahead is
#   never older than the older file's (review 5's c1 and c2).
FUTURE_DROPS, FUTURE_IS_NOW = "drop", "now"


def _until(moment: datetime | None, until: datetime | None, future: str = FUTURE_DROPS) -> datetime | None:
    """``moment``, unless it is later than ``until`` (the restore's clock):
    then None (FUTURE_DROPS) or ``until`` (FUTURE_IS_NOW)."""
    if moment is None or until is None or moment <= until:
        return moment
    return until if future == FUTURE_IS_NOW else None


def freshness(entry: dict[str, Any], until: datetime | None = None, future: str = FUTURE_DROPS) -> datetime | None:
    """When a record last changed, as far as it says: its edit, its last
    open, its move to Recently deleted or back, whichever is latest. A date
    after ``until`` counts as ``future`` says."""
    moments = [moment for moment in (_until(_moment(entry.get(key)), until, future) for key in _STAMPS)
               if moment is not None]
    return max(moments) if moments else None


def catalog_freshness(catalog: dict[str, Any], until: datetime | None = None,
                      future: str = FUTURE_DROPS) -> datetime | None:
    """When a catalog last changed, by what it holds: the latest date on any
    record, or on a delete for good (ProjectStore._restore picks the newest
    copy by it, not by its name or mtime: review 2, L3), a date after
    ``until`` counted as ``future`` says (a clock that ran ahead: review 4,
    M-3; review 5, M-2)."""
    moments = [freshness(entry, until, future) for section in ("projects", "trash")
               for entry in (catalog.get(section) or {}).values() if isinstance(entry, dict)]
    moments.extend(_until(_moment(at), until, future) for at in purged_map(catalog.get("purged")).values())
    found = [moment for moment in moments if moment is not None]
    return max(found) if found else None


def salvage_freshness(found: Salvage, until: datetime | None = None, future: str = FUTURE_DROPS) -> datetime | None:
    """The latest date a damaged file still shows: on a record it holds
    whole, on what was read of one it couldn't finish, or on a delete for
    good in its head (a date after ``until`` counted as ``future`` says)."""
    moments = [freshness(entry, until, future) for source in (found.entries, found.partial) for entry in source.values()]
    moments.extend(_until(_moment(at), until, future) for at in found.purged.values())
    known = [moment for moment in moments if moment is not None]
    return max(known) if known else None


def newer(older_files: dict[str, Any], newer_files: dict[str, Any], until: datetime | None = None) -> bool:
    """Whether the record from the older file (a copy) is strictly newer by
    its dates than the newer file's (the damaged file): the older file's
    future dates are left out, the newer file's count as now (M-2)."""
    found = freshness(older_files, until, FUTURE_DROPS)
    kept = freshness(newer_files, until, FUTURE_IS_NOW)
    return found is not None and kept is not None and found > kept


def newer_copy(newer_copy_catalog: dict[str, Any], older_copy_catalog: dict[str, Any],
               until: datetime | None = None) -> bool:
    """Whether .bak.1 (``older_copy_catalog``, older by construction) holds
    a later catalog than .bak by the dates: its own future dates left out,
    .bak's counted as now (review 5, M-2: .bak written while the clock ran
    ahead lost to .bak.1, and the next commit erased a project only .bak
    held). Commit order decides beside it (ProjectStore._restore)."""
    older = catalog_freshness(older_copy_catalog, until, FUTURE_DROPS)
    newest = catalog_freshness(newer_copy_catalog, until, FUTURE_IS_NOW)
    return older is not None and (newest is None or older > newest)


def _unchanged(partial: dict[str, Any], current: dict[str, Any]) -> bool:
    """What is left of a cut record shows it as the copy has it: both its
    dates read, and every top-level value that read and that the copy's
    record has matches. Every change Nebula makes to a project moves one of
    them (refresh_metadata, an open, a move to or from Recently deleted),
    so a key the copy's record lacks is a key name the damage changed
    ("deletedQt": review 4, L-4), not a change."""
    if "updatedAt" not in partial or "lastOpenedAt" not in partial:
        return False
    return all(current.get(key) == value for key, value in partial.items() if key in current)


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
    # catalog-purged.json was older than a file that decided ids it names
    # (its write failed, or a crash: review 5, L-1).
    purged_file_behind: bool = False


def _row(entry: dict[str, Any]) -> dict[str, Any]:
    return {"id": entry["id"], "name": entry["name"], "trashed": trashed(entry)}


def _one_off_copy_id(found: Salvage, ids: set[str], copy_ids: set[str]) -> str | None:
    """The one copy id, not read from the damaged file, a single character
    away from one of ``ids``. Two random ids are never that close, so one
    that is was that record's id before a flip changed it. None when no
    single one is."""
    near = {copy_id for copy_id in copy_ids - set(found.entries) - set(found.failed) for one in ids
            if sum(a != b for a, b in zip(copy_id, one)) == 1}
    return near.pop() if len(near) == 1 else None


def _resolve_misfiled(found: Salvage, copy_ids: set[str]) -> list[dict[str, Any]]:
    """File each of ``found``'s misfiled records under the id that is its
    (changes ``found``): its own id, unless the copy holds the key's and not
    its own (then the id field was the damaged part, and the record takes
    the key's id). Both in the copy: which it is can't be told, so neither
    takes it (each keeps the copy's version, reported). Returns {id, key}
    for each record filed."""
    filed: list[dict[str, Any]] = []
    for key_id, own, entry, group in found.misfiled:
        if own not in copy_ids and (key_id is None or key_id not in copy_ids):
            damaged = _one_off_copy_id(found, {own, key_id} - {None}, copy_ids)
            if damaged is not None:
                # Neither id is the copy's, but one is a single character
                # off a copy record the damage left unread: the damage hit
                # both its key and its id (review 4, L-5's @2896/@2846 filed
                # "Old" under a new id as a project added back). Which bytes
                # are its own can't be told, so it keeps the copy's version.
                found.failed.setdefault(damaged, "invalid")
                found.groups.setdefault(damaged, group)
                found.partial.setdefault(damaged, _scalars({**entry, "id": damaged}))
                continue
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
        if entry_ok(true_id, record) and found.take(true_id, record, group):
            filed.append({"id": true_id, "key": key_id})
        else:
            found.failed.setdefault(true_id, "invalid")
            found.groups.setdefault(true_id, group)
            found.partial.setdefault(true_id, _scalars(entry))
    found.misfiled = []
    # A record that failed under a key the copy doesn't have, a single
    # character off a copy record the damage left unread: the damage hit its
    # key, and its own id too (else it was misfiled above), as in fix round
    # 5's gate run of review 4's two-flip set (Old's key "9311…" -> "1311…",
    # its id field "…9883=1f4…"). It is that copy record, unread: never a
    # project of its own nor one deleted after the copy (cameBack).
    for key_id in [key for key in found.failed if key not in copy_ids and key not in found.entries]:
        damaged = _one_off_copy_id(found, {key_id}, copy_ids)
        if damaged is None:
            continue
        found.failed.setdefault(damaged, found.failed.pop(key_id))
        found.groups.setdefault(damaged, found.groups.pop(key_id, None))
        found.partial.setdefault(damaged, {**found.partial.pop(key_id, {}), "id": damaged})
        found.holds = {*(found.holds or ()), damaged} - {key_id}
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


def _commit_of(value: Any) -> int | None:
    """A catalog's ``commitSeq`` (or a side file's ``commit``) when it reads
    as one: a whole number, not a bool."""
    return value if isinstance(value, int) and not isinstance(value, bool) and value >= 0 else None


def commit_check(seq: int) -> int:
    """The check written beside a commit number (``commitCheck``): a CRC-32
    of it, so a flipped digit reads as damage (review 6 of PR #199, L-5)."""
    return zlib.crc32(f"nebula-commit:{seq}".encode("ascii"))


def proven_commit(holder: Any, key: str = "commitSeq") -> int | None:
    """``holder[key]`` as a commit number only when its ``commitCheck`` is
    that number's (review 6 of PR #199, L-5). A number with no check, or a
    check that doesn't match (a flipped digit in either), is unproven: None,
    as for a file from before commits were numbered, so it never moves the
    side file's tombstones after that file, and never picks a copy as the
    later commit. Files of this PR before the check (unreleased) read as
    unnumbered, the cautious way."""
    if not isinstance(holder, dict):
        return None
    seq = _commit_of(holder.get(key))
    if seq is None:
        return None
    check = holder.get("commitCheck")
    if not isinstance(check, int) or isinstance(check, bool) or check != commit_check(seq):
        return None
    return seq


def reconcile(base: dict[str, Any], salvages: Iterable[Salvage], *, max_projects: int,
              room_bytes: int, open_project: Any = _UNKNOWN, until: datetime | None = None,
              side_purged: dict[str, str] | None = None, side_index: int = 1,
              side_layers: list[tuple[int | None, dict[str, str]]] | None = None) -> Reconciled:
    """``base`` (validated; changed in place and returned as ``catalog``)
    with what ``salvages`` hold, newest first. ``max_projects`` bounds the
    live list (ProjectStore's limit) and ``room_bytes`` how many encoded
    bytes may be added (each added record costs RECORD_OVERHEAD more); a
    record past either is left out and reported (it stays in the damaged
    file). ``open_project``: the project the live canvas is (main, from
    state.json), None for no project's, UNKNOWN when it isn't recorded.
    ``until``: the restore's clock; a date after it decides nothing (review
    4, M-3). ``side_purged``: catalog-purged.json's tombstones, the latest
    commit's (review 4, L-3), or ``side_layers``, its layers as
    (the commit each is true of, its tombstones), newest first (review 5,
    L-1 and L-3). A layer whose commit is unknown (a side file from before
    commits were numbered) goes right after the damaged catalog.json
    (``side_index`` 1; 0 when catalog.json is missing, so ``salvages`` are
    all damaged copies) and before every copy; a numbered one goes there
    too, then after every file numbered later than it (one whose side-file
    write failed, or one that a crash left a commit ahead), so those files
    decide the ids they hold. ``base``'s own number is its ``commitSeq``."""
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
    #
    # One exception keeps file order honest (review 4, L-2): a file whose own
    # newest date is older than a later file's tombstone for an id predates
    # that delete (a catalog.json a sync tool or a one-file restore rolled
    # back), so its record of the id doesn't decide; the tombstone does.
    # That mirrors newer() for records, and a record made again after the
    # delete (a recover retry) is newer than it, so it still wins.
    #
    # A file's own newest date counts a future date as now (it is the newer
    # file of that comparison), a later file's tombstone time leaves one out
    # (review 5, M-2).
    layers = list(side_layers) if side_layers is not None else [(None, side_purged or {})]
    layers = [(commit, purged_map(tombstones)) for commit, tombstones in layers]
    layers = [(commit, tombstones) for commit, tombstones in layers if tombstones]
    files: list[tuple[list[str], dict[str, str], datetime | None, int | None]] = [
        ([*found.entries, *found.failed], found.purged, salvage_freshness(found, until, FUTURE_IS_NOW), found.seq)
        for found in salvages]
    files.append((list(copy_ids), purged_map(result.get("purged")), None, proven_commit(result)))
    side_behind = False
    placed: list[tuple[int, int, tuple[list[str], dict[str, str], datetime | None, int | None]]] = []
    for rank, (commit, tombstones) in enumerate(layers):
        at = min(side_index, len(files) - 1)
        while commit is not None and at < len(files) and files[at][3] is not None and files[at][3] > commit:
            at += 1  # that file is a later commit than this layer: it decides what it holds
            side_behind = True
        placed.append((at, rank, ([], tombstones, None, commit)))
    sources = list(files)
    for at, _rank, layer in sorted(placed, key=lambda row: (row[0], row[1]), reverse=True):
        sources.insert(at, layer)
    decided: dict[str, str | None] = {}  # id -> the tombstone's time, or None for a record
    for index, (ids, tombstones, newest_date, _commit) in enumerate(sources):
        for entry_id in ids:
            if entry_id in decided:
                continue
            if newest_date is not None and any(
                    (when := _until(_moment(later.get(entry_id)), until)) is not None and when > newest_date
                    for _ids, later, _date, _seq in sources[index + 1:]):
                continue  # this file is older than that delete: the tombstone decides
            decided[entry_id] = None
        for entry_id, at in tombstones.items():
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
                if newer(current, entry, until):
                    # The copy's is newer by its dates (a damaged file older
                    # than its copy, a restore from Recently deleted saved
                    # before restores were dated, or a copy dated by a clock
                    # that ran ahead, its dates since past): the copy's
                    # stays, and says so. Never by a date from the future in
                    # the copy; the damaged file's count as now (review 4,
                    # M-3; review 5, M-2). The damaged file's version is in
                    # the kept damaged file.
                    if trashed(current) and not trashed(entry) and found.entry_groups.get(entry_id) != "trash":
                        back_in_trash.append({"id": entry_id, "name": current["name"]})
                    else:
                        reverted.append({**_row(current), "by": "dates"})
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
                      reverted, came_back, back_in_trash, kept_deleted, open_name, rekeyed, side_behind)


def restore_said_more(record: Any) -> bool:
    """Whether a catalog restore's record has anything to say besides "no
    project is missing": the frontend's ``saidAtFirst``
    (components/projects/catalogRestoreCopy.ts), as the restore found it, so
    agents' notes (main._catalog_restore_note, cli.formatter) say "no project
    is missing" only under the person's rule (GM r22 on PR #199, 1): projects
    added back, left out (at the limit or not), reverted (not the live
    canvas's or a deleted one's), back after a delete or in Recently deleted
    again, or a canvas filed or waiting on the limit."""
    from collections.abc import Mapping

    if not isinstance(record, Mapping):
        return False

    def rows(key: str) -> list[Any]:
        value = record.get(key)
        return value if isinstance(value, list) else []

    def total(key: str) -> int:
        value = record.get(f"{key}Count")
        count = value if isinstance(value, int) and not isinstance(value, bool) else 0
        return max(count, len(rows(key)))

    reverted_out = sum(1 for row in rows("reverted")
                       if isinstance(row, Mapping) and (row.get("liveCanvas") or row.get("trashed")))
    return (total("addedBack") > 0 or total("notAddedBack") > 0 or total("reverted") - reverted_out > 0
            or total("cameBack") > 0 or total("backInTrash") > 0
            or bool(record.get("recoveredCanvas")) or bool(record.get("canvasNotFiled"))
            or bool(rows("alsoFiled")) or bool(rows("agentCopies")))
