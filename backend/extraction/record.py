"""The ``extracted-example/1`` record: build it, check it, correct it.

The schema is a draft (``schema_status: "draft"``). A record keeps three
layers apart: what code measured (``structure.measured``), what a model read
(``structure.read``, null until a reader exists) and what a person or an agent
corrected (``corrections``, applied in order by ``effective``).

Lists a correction can reach (``shows``, and later regions and text runs) are
objects keyed by id, each item with an ``order`` int, so a path such as
``shows.s1.statement`` works with ``commons.effective.apply_op``.

Code-measured values are facts, not corrections, and approval is a separate
act: neither can be written through ``add_corrections``, and an agent can
never approve.
"""
from __future__ import annotations

import copy
import hashlib
import json
import re
import textwrap
from datetime import datetime, timezone
from typing import Any, Callable, Iterable

from commons.effective import apply_op, get_path
from extraction.intake import Intake, rendering_png  # noqa: F401 - rendering_png is re-exported for callers
from extraction.measure import measure

SCHEMA = "extracted-example/1"
SCHEMA_STATUS = "draft"
GIVEN_REASON = "the source has no structure of its own"
ACTORS = ("person", "agent")
OPS = ("set", "add", "remove")
STATUSES = ("proposal", "approved")
SHOW_FIELDS = frozenset({"statement", "evidence"})
MAX_CORRECTIONS_PER_CALL = 50
MAX_CORRECTIONS_PER_RECORD = 1000
# The limits fit together: a stored correction is at most MAX_CORRECTION_BYTES as it sits in record.json
# (indentation included), so 1000 of them take about 4 MB and the largest valid record stays under the
# 5 MB the store reads back (store.MAX_RECORD_BYTES). The store also refuses any write over that size.
MAX_VALUE_CHARS = 2_000
MAX_VALUE_DEPTH = 4
MAX_REASON_CHARS = 500
MAX_PATH_CHARS = 200
MAX_CORRECTION_BYTES = 4_096
MAX_BRAND_CHARS = 200
MAX_READ_TEXT_CHARS = 2_000
MAX_READ_REQUESTS = 20
MAX_READ_REQUEST_CHARS = 300

_ID = re.compile(r"^ex_[0-9a-f]{16}$")
_HEX64 = re.compile(r"^[0-9a-f]{64}$")
_HEX16 = re.compile(r"^[0-9a-f]{16}$")
_SEGMENT = re.compile(r"^[A-Za-z0-9_-]{1,64}$")
_READ_PROVENANCE = {"origin", "model", "prompt_version", "read_at"}
# Refused with their own reason; anything else outside the allowed paths gets the general one.
_FACTS = ("structure.measured", "rendering", "source")

Clock = Callable[[], datetime]


class RecordInvalid(ValueError):
    """The record (or a correction) breaks the schema. The message says where."""


def _now() -> datetime:
    return datetime.now(timezone.utc)


def _stamp(clock: Clock | None) -> str:
    return (clock or _now)().astimezone(timezone.utc).strftime("%Y-%m-%dT%H:%M:%SZ")


def record_id(sha256_hex: str) -> str:
    """The same bytes always give the same id."""
    return "ex_" + sha256_hex[:16]


def evidence_ids(record: dict[str, Any]) -> set[str]:
    """The ids a show can cite: P0..Pn from the measured palette, and the read's region ids."""
    structure = record.get("structure") or {}
    ids = {f"P{e['index']}" for e in (structure.get("measured") or {}).get("palette") or [] if "index" in e}
    regions = ((structure.get("read") or {}).get("regions")) or {}
    if isinstance(regions, dict):
        ids.update(k for k, v in regions.items() if v is not None)
    return ids


def _shows(entries: Iterable[dict[str, Any]] | None, known: set[str]) -> dict[str, Any]:
    """Key the model's (or a person's) entries as s1, s2, ... and drop any with no evidence id that exists."""
    out: dict[str, Any] = {}
    for entry in entries or ():
        evidence = [e for e in (entry.get("evidence") or []) if isinstance(e, str) and e in known]
        statement = entry.get("statement")
        if not evidence or not isinstance(statement, str) or not statement.strip():
            continue
        key = f"s{len(out) + 1}"
        out[key] = {
            "statement": statement, "evidence": evidence, "origin": entry.get("origin", "model"),
            "status": "proposal", "decision_ref": None, "order": len(out),
        }
    return out


def build_record(item: Intake, *, shows: Iterable[dict[str, Any]] | None = None, clock: Clock | None = None) -> dict[str, Any]:
    """A record for an accepted image: measured by code, nothing read, status "proposal"."""
    digest = hashlib.sha256(item.data).hexdigest()
    measured, perceptual = measure(item.image)
    record = {
        "schema": SCHEMA,
        "schema_status": SCHEMA_STATUS,
        "id": record_id(digest),
        "status": "proposal",
        "approved_by": None,
        "approved_at": None,
        "brand": None,
        "rendering": {
            "file": "rendering.png", "width": item.image.width, "height": item.image.height,
            "sha256": digest, "phash": perceptual,
        },
        "source": {
            "kind": item.kind, "name": item.name, "path": item.path, "mtime": item.mtime,
            "size": len(item.data), "tool": None, "frame_or_address": None,
            "version": f"sha256:{digest}", "read_at": _stamp(clock),
        },
        "structure": {"given": None, "given_reason": GIVEN_REASON, "measured": measured, "read": None},
        "shows": {},
        "corrections": [],
        "read_requests": [],
    }
    record["shows"] = _shows(shows, evidence_ids(record))
    validate(record)
    return record


# -- validation -------------------------------------------------------------------------------


def _need(ok: bool, where: str, what: str) -> None:
    if not ok:
        raise RecordInvalid(f"The record's {where} {what}.")


def _is_int(value: Any) -> bool:
    return isinstance(value, int) and not isinstance(value, bool)


def validate(record: Any) -> None:
    """Check the record's shape; raise ``RecordInvalid`` with a readable message."""
    _need(isinstance(record, dict), "top level", "must be an object")
    _need(record.get("schema") == SCHEMA, "schema", f"must be {SCHEMA}")
    _need(record.get("schema_status") in ("draft", "final"), "schema_status", "must be draft or final")
    _need(isinstance(record.get("id"), str) and bool(_ID.match(record["id"])), "id", "must look like ex_ and 16 hex digits")
    _need(record.get("status") in STATUSES, "status", f"must be one of {', '.join(STATUSES)}")
    approved = (record.get("approved_by"), record.get("approved_at"))
    _need((approved[0] is None) == (approved[1] is None), "approval", "needs approved_by and approved_at together")
    _need((record["status"] == "approved") == (approved[0] is not None), "status", "must match whether it is approved")
    _need(record.get("brand") is None or isinstance(record["brand"], str), "brand", "must be null or text")

    rendering = record.get("rendering")
    _need(isinstance(rendering, dict), "rendering", "must be an object")
    _need(rendering.get("file") == "rendering.png", "rendering.file", "must be rendering.png")
    _need(_is_int(rendering.get("width")) and rendering["width"] > 0, "rendering.width", "must be a positive whole number")
    _need(_is_int(rendering.get("height")) and rendering["height"] > 0, "rendering.height", "must be a positive whole number")
    _need(isinstance(rendering.get("sha256"), str) and bool(_HEX64.match(rendering["sha256"])), "rendering.sha256", "must be 64 hex digits")
    _need(isinstance(rendering.get("phash"), str) and bool(_HEX16.match(rendering["phash"])), "rendering.phash", "must be 16 hex digits")
    _need(record["id"] == record_id(rendering["sha256"]), "id", "must come from the rendering's sha256")

    source = record.get("source")
    _need(isinstance(source, dict), "source", "must be an object")
    _need(source.get("kind") in ("file", "paste", "drop"), "source.kind", "must be file, paste or drop")
    for key in ("name", "path", "mtime", "tool", "frame_or_address"):
        _need(source.get(key) is None or isinstance(source[key], str), f"source.{key}", "must be null or text")
    _need(_is_int(source.get("size")) and source["size"] >= 0, "source.size", "must be a whole number")
    _need(isinstance(source.get("version"), str) and source["version"].startswith("sha256:"), "source.version", "must start with sha256:")
    _need(isinstance(source.get("read_at"), str), "source.read_at", "must be a time")

    structure = record.get("structure")
    _need(isinstance(structure, dict), "structure", "must be an object")
    if structure.get("given") is None:
        _need(isinstance(structure.get("given_reason"), str) and bool(structure["given_reason"]),
              "structure.given_reason", "must say why there is no given structure")
    else:
        _need(isinstance(structure["given"], dict), "structure.given", "must be null or an object")
    measured = structure.get("measured")
    _need(isinstance(measured, dict) and measured.get("origin") == "code", "structure.measured", "must be an object with origin code")
    _need(isinstance(measured.get("palette"), list), "structure.measured.palette", "must be a list")
    _need(isinstance(measured.get("code_version"), str), "structure.measured.code_version", "must be text")
    _need(structure.get("read") is None or isinstance(structure["read"], dict), "structure.read", "must be null or an object")

    shows = record.get("shows")
    _need(isinstance(shows, dict), "shows", "must be an object keyed by id")
    for key, item in shows.items():
        _need(_SEGMENT.match(key) is not None, f"shows.{key}", "needs an id of letters, digits, - and _")
        _need(isinstance(item, dict), f"shows.{key}", "must be an object")
        _need(isinstance(item.get("statement"), str) and bool(item["statement"].strip()), f"shows.{key}.statement", "must be text")
        evidence = item.get("evidence")
        _need(isinstance(evidence, list) and bool(evidence) and all(isinstance(e, str) and e for e in evidence),
              f"shows.{key}.evidence", "must list at least one region or palette id")
        _need(_is_int(item.get("order")), f"shows.{key}.order", "must be a whole number")

    corrections = record.get("corrections")
    _need(isinstance(corrections, list), "corrections", "must be a list")
    for index, item in enumerate(corrections):
        where = f"corrections[{index}]"
        _need(isinstance(item, dict), where, "must be an object")
        _need(isinstance(item.get("path"), str) and bool(item["path"]), f"{where}.path", "must be text")
        _need(item.get("op") in OPS, f"{where}.op", "must be set, add or remove")
        _need(item.get("actor") in ACTORS, f"{where}.actor", "must be person or agent")
        _need(isinstance(item.get("at"), str), f"{where}.at", "must be a time")

    # Absent on records saved before reads existed.
    requests = record.get("read_requests", [])
    _need(isinstance(requests, list), "read_requests", "must be a list")
    for index, item in enumerate(requests):
        where = f"read_requests[{index}]"
        _need(isinstance(item, dict) and item.get("actor") == "agent", where, "must be an object from an agent")
        _need(isinstance(item.get("at"), str), f"{where}.at", "must be a time")
        _need(isinstance(item.get("reason"), str), f"{where}.reason", "must be text")


# -- corrections ------------------------------------------------------------------------------


def _check_path(path: Any, record: dict[str, Any]) -> list[str]:
    if not isinstance(path, str) or not path:
        raise RecordInvalid("A correction needs a path.")
    if len(path) > MAX_PATH_CHARS:
        raise RecordInvalid(f"A correction's path is at most {MAX_PATH_CHARS} characters.")
    parts = path.split(".")
    if not all(_SEGMENT.match(p) for p in parts):
        raise RecordInvalid(f"The path {path!r} has a part that isn't letters, digits, - or _.")
    top = parts[0]
    if top in ("status", "approved_by", "approved_at"):
        raise RecordInvalid("Approval isn't a correction. A person approves a record separately, and an agent can't.")
    if top in ("id", "schema", "schema_status") or path.startswith("schema"):
        raise RecordInvalid(f"{path} is part of the record's identity and can't be corrected.")
    if any(path == f or path.startswith(f + ".") for f in _FACTS):
        raise RecordInvalid(f"{path} was measured or recorded by code. It's a fact, not a correction.")
    if path == "brand":
        return parts
    if path.startswith("structure.read."):
        if record["structure"].get("read") is None:
            raise RecordInvalid("There is no model read to correct yet.")
        if parts[2] in _READ_PROVENANCE and len(parts) == 3:
            raise RecordInvalid(f"{path} says who read the image and can't be corrected.")
        return parts
    if path.startswith("shows."):
        return parts
    raise RecordInvalid(f"{path} can't be corrected. Correct brand, structure.read.* or shows.*.")


# -- what a correction to the reading may change ------------------------------------------------

READ_CORRECTABLE = (
    "A region's role (structure.read.regions.<id>.role) or label (.label), a text run's content, weight or "
    "type_style (structure.read.text.<id>.content), one reader_1 field's value (structure.read.reader_1.<field>.value: "
    "summary, composition_notes, subject, type_style, spacing_density, layout or medium), or a keyword to add or remove "
    "(structure.read.reader_1.keywords). Regions, text runs, boxes, sizes and the provenance fields can't be set whole."
)


def _read_enums() -> dict[str, tuple[str, ...]]:
    from commons import reader as commons_reader
    from extraction import reader

    return {"role": reader.ROLES, "weight": reader.WEIGHTS, "type_style": commons_reader.TYPE_STYLES,
            "spacing_density": commons_reader.SPACING, "layout": commons_reader.LAYOUTS, "medium": commons_reader.MEDIA}


def _read_refusal(path: str) -> RecordInvalid:
    return RecordInvalid(f"{path} can't be corrected. What can be: {READ_CORRECTABLE}")


def _check_read(parts: list[str], op: str, value: Any, view: dict[str, Any]) -> Any:
    """A correction under ``structure.read``: leaf fields only, each with its type or enum.

    Setting a whole region, run, box or provenance field is refused, because the page and the effective
    view read those with a fixed shape. ``view`` is the effective record so far. Returns the value to store."""
    from extraction import reader

    path = ".".join(parts)
    read = (view.get("structure") or {}).get("read") or {}
    enums = _read_enums()
    kind, rest = parts[2], parts[3:]

    def need_set() -> None:
        if op != "set":
            raise RecordInvalid(f"{path} is one value, so it takes set, not {op}.")

    def need_text(limit: int, what: str) -> str:
        if not (isinstance(value, str) and value.strip() and len(value) <= limit):
            raise RecordInvalid(f"{path} is set as text of 1 to {limit} characters ({what}).")
        return value

    if kind == "regions" and len(rest) == 2 and rest[1] in ("role", "label"):
        if not isinstance(read.get("regions", {}).get(rest[0]), dict):
            raise RecordInvalid(f"There is no region {rest[0]} in the reading.")
        need_set()
        if rest[1] == "role":
            if value not in enums["role"]:
                raise RecordInvalid(f"{path} is one of {', '.join(enums['role'])}.")
            return value
        if not (isinstance(value, str) and len(value) <= reader.MAX_LABEL):
            raise RecordInvalid(f"{path} is set as text of at most {reader.MAX_LABEL} characters.")
        return value
    if kind == "text" and len(rest) == 2 and rest[1] in ("content", "weight", "type_style"):
        if not isinstance(read.get("text", {}).get(rest[0]), dict):
            raise RecordInvalid(f"There is no text run {rest[0]} in the reading.")
        need_set()
        if rest[1] == "content":
            return need_text(reader.MAX_CONTENT, "the words as written")
        if value not in enums[rest[1]]:
            raise RecordInvalid(f"{path} is one of {', '.join(enums[rest[1]])}.")
        return value
    if kind == "reader_1" and len(rest) == 2 and rest[1] == "value" and rest[0] in _READER_1_TEXT + _READER_1_ENUM:
        if not isinstance((read.get("reader_1") or {}).get(rest[0]), dict):
            raise RecordInvalid(f"The reading has no reader_1 field {rest[0]}.")
        need_set()
        if rest[0] in _READER_1_ENUM:
            if value not in enums[rest[0]]:
                raise RecordInvalid(f"{path} is one of {', '.join(enums[rest[0]])}.")
            return value
        return need_text(MAX_READ_TEXT_CHARS, "a sentence or two")
    if kind == "reader_1" and rest == ["keywords"]:
        if op not in ("add", "remove"):
            raise RecordInvalid(f"{path} takes add or remove, one keyword at a time.")
        from commons.vocab import load_vocabulary

        canon = load_vocabulary().canonical(value) if isinstance(value, str) else None
        if canon is None:
            raise RecordInvalid(f"{path} takes a keyword from the vocabulary; {value!r} isn't one.")
        return canon
    raise _read_refusal(path)


_READER_1_TEXT = ("summary", "composition_notes", "subject")
_READER_1_ENUM = ("type_style", "spacing_density", "layout", "medium")


def _finite_box(box: Any) -> bool:
    return (isinstance(box, (list, tuple)) and len(box) == 4
            and all(isinstance(n, (int, float)) and not isinstance(n, bool) and n == n and abs(n) != float("inf")
                    for n in box))


def read_malformed(read: Any) -> str | None:
    """Why a reading would break the page's fixed shape, or None. Looks at each region and text run:
    an object with a box of four finite numbers and text where text belongs."""
    if not isinstance(read, dict):
        return "the reading isn't an object"
    for group, texts in (("regions", ("role", "label")), ("text", ("content", "weight", "type_style"))):
        items = read.get(group)
        if items is None:
            continue
        if not isinstance(items, dict):
            return f"{group} isn't an object"
        for key, item in items.items():
            if not isinstance(item, dict):
                return f"{group[:-1] if group == 'regions' else 'text run'} {key} isn't an object"
            if not _finite_box(item.get("box")):
                return f"{group} {key} has no valid box"
            if "box_px" in item and not _finite_box(item["box_px"]):
                return f"{group} {key} has no valid box_px"
            for name in texts:
                if name in item and not isinstance(item[name], str):
                    return f"{group} {key} {name} isn't text"
    return None


def _good_evidence(value: Any, known: set[str]) -> bool:
    return isinstance(value, list) and bool(value) and all(isinstance(e, str) and e in known for e in value)


def _check_shows(path: list[str], op: str, value: Any, view: dict[str, Any], actor: str) -> Any:
    """A show is added whole (set shows.<id> with evidence) or changed field by field.
    ``view`` is the effective record so far. Returns the value to store."""
    key = path[1]
    known = evidence_ids(view)
    if len(path) == 2:
        if op != "set":
            raise RecordInvalid(f"shows.{key} can only be set to a whole entry.")
        if value is None:
            if (view["shows"].get(key)) is None:
                raise RecordInvalid(f"There is no show {key} to remove.")
            return None  # an entry set to null drops out of the effective view
        if not (isinstance(value, dict) and isinstance(value.get("statement"), str) and value["statement"].strip()
                and _good_evidence(value.get("evidence"), known)):
            raise RecordInvalid(f"A show needs a statement and at least one evidence id that exists, such as P0 (shows.{key}).")
        extra = set(value) - SHOW_FIELDS
        if extra:
            raise RecordInvalid(f"A show added by a correction has only a statement and evidence "
                                f"(shows.{key} also has {', '.join(sorted(extra))}).")
        order = max([s.get("order", 0) for s in view["shows"].values() if s] + [-1]) + 1
        # Who added it, its status and its decision link are set here, never
        # taken from the value: a correction can't claim a person's origin or
        # an accepted decision.
        return {"statement": value["statement"], "evidence": list(value["evidence"]), "origin": actor,
                "status": "proposal", "decision_ref": None, "order": order}
    if not isinstance(view["shows"].get(key), dict):
        raise RecordInvalid(f"There is no show {key}. Add it whole with a statement and evidence.")
    field = path[2]
    if field not in SHOW_FIELDS:
        raise RecordInvalid(f"shows.{key}.{field} can't be corrected; a show's statement and evidence can. "
                            "Its status and decision are set when a person accepts it.")
    if field == "evidence" and len(path) == 3 and op == "set" and not _good_evidence(value, known):
        raise RecordInvalid(f"A show keeps at least one evidence id that exists (shows.{key}.evidence).")
    if field == "evidence" and (len(path) > 3 or (op != "set" and not (isinstance(value, str) and value in known))):
        raise RecordInvalid(f"Evidence is an id that exists, such as P0 (shows.{key}.evidence).")
    if field == "statement" and (len(path) > 3 or op != "set" or not (isinstance(value, str) and value.strip())):
        raise RecordInvalid(f"A show's statement is set as text (shows.{key}.statement).")
    return value


def _depth(value: Any) -> int:
    if isinstance(value, dict):
        return 1 + max((_depth(v) for v in value.values()), default=0)
    if isinstance(value, list):
        return 1 + max((_depth(v) for v in value), default=0)
    return 0


def _related(a: str, b: str) -> bool:
    return a == b or a.startswith(b + ".") or b.startswith(a + ".")


def _keep_persons_choices(record: dict[str, Any], view: dict[str, Any], parts: list[str], op: str, value: Any) -> None:
    """An agent's correction never removes, replaces or overrides what a person chose.

    Refused: anything under a show whose origin is "person" (stored, or added by a person's correction), and
    any correction a person's correction bears on, whoever wrote last: a person's set covers its path, parents
    and children; an agent's add or remove of an item a person added or removed is refused too. The agent can add its own show under another id, or ask for a read."""
    path = ".".join(parts)
    way_out = "Add your own show under another id, or use extraction_request_read to ask the person."
    if parts[0] == "shows" and len(parts) >= 2:
        show = view["shows"].get(parts[1])
        if isinstance(show, dict) and show.get("origin") == "person":
            raise RecordInvalid(f"{path} belongs to a show a person wrote or kept, and a person's show stays as it is. {way_out}")
    # Any person's correction that bears on this one blocks it, whoever wrote
    # last: only a person releases a person's choice. A person's set covers its
    # path, its parents and its children; for an agent's set, so does any person
    # correction on a related path; for an add or remove, a person's add or
    # remove of the same item.
    for item in record["corrections"]:
        if item.get("actor") != "person":
            continue
        other = str(item.get("path"))
        if item.get("op") == "set" and _related(other, path):
            blocked = True
        elif op == "set":
            blocked = _related(other, path)
        else:
            blocked = other == path and item.get("value") == value
        if blocked:
            raise RecordInvalid(f"A person corrected {other}, and a person's correction stays. {way_out}")


def add_corrections(record: dict[str, Any], corrections: Iterable[dict[str, Any]], actor: str, *,
                    clock: Clock | None = None) -> dict[str, Any]:
    """A copy of ``record`` with ``corrections`` appended, each ``{path, op, value, reason?}``.

    All are checked first; one refusal adds none. Allowed paths: ``brand``,
    anything under ``structure.read.`` and ``shows.``.
    """
    if actor not in ACTORS:
        raise RecordInvalid("A correction's actor is a person or an agent.")
    validate(record)
    if record["status"] == "approved":
        # An approved record is what a person accepted; changing it would
        # change what they approved. It is replaced only through a new proposal.
        raise RecordInvalid("That record is approved, so it can't be corrected.")
    incoming = list(corrections)
    if not incoming:
        raise RecordInvalid("There are no corrections to add.")
    if len(incoming) > MAX_CORRECTIONS_PER_CALL:
        raise RecordInvalid(f"Add at most {MAX_CORRECTIONS_PER_CALL} corrections at a time.")
    if len(record["corrections"]) + len(incoming) > MAX_CORRECTIONS_PER_RECORD:
        raise RecordInvalid(f"A record keeps at most {MAX_CORRECTIONS_PER_RECORD} corrections.")
    at = _stamp(clock)
    updated = copy.deepcopy(record)
    for raw in incoming:
        if not isinstance(raw, dict):
            raise RecordInvalid("Each correction is an object with path, op and value.")
        op = raw.get("op")
        if op not in OPS:
            raise RecordInvalid("A correction's op is set, add or remove.")
        parts = _check_path(raw.get("path"), updated)
        value = raw.get("value")
        try:
            encoded = json.dumps(value)
        except (TypeError, ValueError):
            raise RecordInvalid("A correction's value must be plain JSON.") from None
        if len(encoded) > MAX_VALUE_CHARS:
            raise RecordInvalid(f"A correction's value is over {MAX_VALUE_CHARS} characters.")
        reason = raw.get("reason")
        if reason is not None and (not isinstance(reason, str) or len(reason) > MAX_REASON_CHARS):
            raise RecordInvalid(f"A correction's reason is text of at most {MAX_REASON_CHARS} characters.")
        if _depth(value) > MAX_VALUE_DEPTH:
            raise RecordInvalid(f"A correction's value is nested at most {MAX_VALUE_DEPTH} levels deep.")
        view = effective(updated)
        if parts[0] == "brand":
            if op != "set" or not (value is None or (isinstance(value, str) and len(value) <= MAX_BRAND_CHARS)):
                raise RecordInvalid(f"brand is set to text of at most {MAX_BRAND_CHARS} characters, or to null.")
        if parts[0] == "shows":
            value = _check_shows(parts, op, value, view, actor)
        elif parts[:2] == ["structure", "read"]:
            value = _check_read(parts, op, value, view)
        if actor == "agent":
            # After the checks above, which store a value in its canonical form (a keyword's spelling): the
            # comparison with a person's stored correction has to see the value as it would be stored.
            _keep_persons_choices(updated, view, parts, op, value)
        if op in ("add", "remove"):
            current = get_path(view, raw["path"])
            if current is not None and not isinstance(current, list):
                raise RecordInvalid(f"{raw['path']} isn't a list, so it takes set, not {op}.")
        entry: dict[str, Any] = {"path": raw["path"], "op": op, "value": value, "actor": actor, "at": at}
        if reason:
            entry["reason"] = reason
        if len(textwrap.indent(json.dumps(entry, indent=2, ensure_ascii=False), "    ").encode("utf-8")) > MAX_CORRECTION_BYTES:
            raise RecordInvalid(f"A correction takes at most {MAX_CORRECTION_BYTES} bytes in the record; "
                                f"{raw['path']} is larger. Shorten its value or reason.")
        # Later corrections in this call see the earlier ones (add a show, then change it).
        if effective(dict(updated, corrections=[*updated["corrections"], entry])).get("corrections_skipped"):
            raise RecordInvalid(f"{raw['path']} can't take that correction here.")
        updated["corrections"].append(entry)
    validate(updated)
    return updated


def add_read_request(record: dict[str, Any], reason: Any, *, clock: Clock | None = None) -> dict[str, Any]:
    """A copy of ``record`` with an agent's request for a reading appended.

    An agent can't start a read; it asks, and the person reads from the page. Refused when the reason is
    empty or over 300 characters, when 20 requests are already waiting, or when the record is approved.
    """
    validate(record)
    if record["status"] == "approved":
        raise RecordInvalid("That record is approved, so it can't be changed.")
    if not isinstance(reason, str) or not reason.strip():
        raise RecordInvalid("A read request needs a reason, in a sentence.")
    reason = reason.strip()
    if len(reason) > MAX_READ_REQUEST_CHARS:
        raise RecordInvalid(f"A read request's reason is at most {MAX_READ_REQUEST_CHARS} characters.")
    updated = copy.deepcopy(record)
    pending = updated.setdefault("read_requests", [])
    if len(pending) >= MAX_READ_REQUESTS:
        raise RecordInvalid(f"{MAX_READ_REQUESTS} read requests are already waiting for the person.")
    pending.append({"actor": "agent", "at": _stamp(clock), "reason": reason})
    validate(updated)
    return updated


# What a replace measures again from the image, and what it keeps. Every top-level key and every key of
# ``structure`` that build_record makes is on one list or the other, and tests/test_extraction_replace.py
# fails when a key is on neither, on both, or when a recomputed key doesn't refresh or a kept key doesn't
# hold. A new field therefore needs a decision here. The id is the image's hash, so the image is the same
# one and its reading still describes it.
REPLACE_RECOMPUTES_TOP = frozenset({"rendering", "source"})
REPLACE_RECOMPUTES_STRUCTURE = frozenset({"measured"})
REPLACE_KEEPS_TOP = frozenset({"schema", "schema_status", "id", "status", "approved_by", "approved_at", "brand",
                               "structure", "shows", "corrections", "read_requests"})
REPLACE_KEEPS_STRUCTURE = frozenset({"given", "given_reason", "read"})
# Under structure.measured, these come from the reading's boxes, so they are
# kept from the old record unless the caller measures them again.
REGION_MEASURES = ("region_measures", "region_gaps")


def _target(path: Any, key: str) -> bool:
    return isinstance(path, str) and (path == f"shows.{key}" or path.startswith(f"shows.{key}."))


def carry_over(new: dict[str, Any], old: dict[str, Any], *,
               remeasure: Callable[[dict[str, Any]], tuple[dict[str, Any], list[dict[str, Any]]]] | None = None,
               ) -> tuple[dict[str, Any], list[dict[str, Any]]]:
    """``new``'s fresh measurement with everything else kept from ``old``.

    ``remeasure(regions)`` measures the reading's regions again (the image's
    crops and the gaps between boxes); without it the old region measures stay.
    A show keeps only evidence ids that still exist (palette entries can change
    with the measurement). A show left with none is dropped, whether it is stored or was added by a
    correction, and returned with the corrections that target it (they stay in the record, skipped when the
    record is viewed), so the caller can say so. Returns ``(record, dropped_shows)``.
    """
    if old["id"] != new["id"]:
        raise RecordInvalid("A replace keeps the same image, so the ids must match.")
    out = copy.deepcopy(old)
    for key in REPLACE_RECOMPUTES_TOP:
        out[key] = copy.deepcopy(new[key])
    for key in REPLACE_RECOMPUTES_STRUCTURE:
        out["structure"][key] = copy.deepcopy(new["structure"][key])
    measured = out["structure"]["measured"]
    old_measured = old["structure"].get("measured") or {}
    read = out["structure"].get("read")
    if read and remeasure is not None:
        measured["region_measures"], measured["region_gaps"] = remeasure(read.get("regions") or {})
    else:
        for key in REGION_MEASURES:
            if key in old_measured:
                measured[key] = copy.deepcopy(old_measured[key])
    known = evidence_ids(out)
    dropped: list[dict[str, Any]] = []
    for key, show in list((out.get("shows") or {}).items()):
        if not isinstance(show, dict):
            continue
        kept = [e for e in show.get("evidence") or [] if e in known]
        if kept:
            show["evidence"] = kept
        else:
            dropped.append({"id": key, "statement": show.get("statement"),
                            "why": "none of its evidence exists after measuring again"})
            del out["shows"][key]
    # Shows that corrections added: the same rule, read off the view the page and agents see.
    was = effective(old)["shows"]
    for item in effective(out).get("corrections_skipped", []):
        path = str(item.get("path"))
        key = path.split(".")[1] if path.startswith("shows.") and path.count(".") == 1 else None
        if key is None or item.get("error") != "none of its evidence exists now" or any(d["id"] == key for d in dropped):
            continue
        dropped.append({"id": key, "statement": (was.get(key) or {}).get("statement"),
                        "why": "none of its evidence exists after measuring again"})
    for entry in dropped:
        entry["corrections"] = [{"path": c["path"], "op": c["op"], "actor": c["actor"]}
                                for c in out["corrections"] if _target(c.get("path"), entry["id"])]
    validate(out)
    return out, dropped


def effective(record: dict[str, Any]) -> dict[str, Any]:
    """A deep copy with ``corrections`` applied in order through ``commons.effective.apply_op``.

    A stored correction that no longer fits the record is skipped and listed
    under ``corrections_skipped``, so a bad one can't hide the record.
    """
    view = copy.deepcopy(record)
    skipped: list[dict[str, Any]] = []
    for item in record.get("corrections") or []:
        parts = str(item.get("path")).split(".")
        if parts[0] == "shows" and len(parts) > 2 and not isinstance((view.get("shows") or {}).get(parts[1]), dict):
            skipped.append({"path": item.get("path"), "error": f"there is no show {parts[1]}"})
            continue
        on_read = str(item.get("path")).startswith("structure.read.")
        before = copy.deepcopy((view.get("structure") or {}).get("read")) if on_read else None
        try:
            apply_op(view, item["path"], item["op"], copy.deepcopy(item.get("value")))
        except (AttributeError, TypeError, ValueError, KeyError) as exc:
            skipped.append({"path": item.get("path"), "error": str(exc)})
            if on_read:
                view["structure"]["read"] = before
            continue
        if on_read:
            # Defence in depth, for corrections stored before the paths were limited: one that would leave a
            # region or text run without its box is skipped, so the page can still draw the record.
            why = read_malformed((view.get("structure") or {}).get("read"))
            if why:
                view["structure"]["read"] = before
                skipped.append({"path": item.get("path"), "error": f"it would break the reading ({why})"})
    # An entry set to null is a removal; the shows dict has only live items.
    view["shows"] = {k: v for k, v in (view.get("shows") or {}).items() if v is not None}
    # A show cites only evidence that exists now: measuring again can change the
    # palette. A show left with none is left out and listed with the reason.
    known = evidence_ids(view)
    for key, show in list(view["shows"].items()):
        if not isinstance(show, dict) or not isinstance(show.get("evidence"), list):
            continue
        kept = [e for e in show["evidence"] if e in known]
        if kept:
            show["evidence"] = kept
        else:
            del view["shows"][key]
            skipped.append({"path": f"shows.{key}", "error": "none of its evidence exists now"})
    if skipped:
        view["corrections_skipped"] = skipped
    return view
