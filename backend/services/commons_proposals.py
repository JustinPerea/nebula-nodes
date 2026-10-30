"""Commons curation as asset proposals (Justin's Q63 b, 2026-10-20; audit U13).

Curating the Commons is the person's: correcting a reference's reading,
drawing, renaming, confirming or deleting a region, and a reference's role,
why or inbox place in a collection. The routes that do it are person-only
(routes/commons.py ``human_dep``) and stay so. An agent asks for them with an
asset proposal of kind ``commons`` (services/asset_proposals.py): the target
is one reference (an asset id) and ``change`` holds one edit or up to
``MAX_EDITS`` of them, all on that reference, accepted or rejected together
in the Commons, on the reference's detail.

An edit has the shape the Commons route it goes through takes:

- ``{"correction": {field_path, op, value, reason?}}``: ``POST
  /api/commons/assets/{id}/corrections``. Only the fields the Commons
  detail lets the person correct: the text fields, the four enums, the five
  axes (``op`` set) and keywords (``op`` add or remove). ``"summary"`` and
  ``"summary.value"`` are the same path.
- ``{"region": {box, label}}``: a new region (``POST .../regions``);
  ``{"region": {id, label?, note?, status?, box?}}``: one of the
  reference's regions (``PATCH /api/commons/regions/{id}``; ``status``
  confirmed or deleted, which the person can undo).
- ``{"membership": {id, role?, why?, accept?}}``: one of the reference's
  memberships the agent can see (``PATCH /api/commons/memberships/{id}``,
  ``accept: true`` is ``POST .../accept``, out of the inbox).

Parts of an edit that are already so are dropped; an edit with nothing left
is refused (409). Each edit records its target as it was (``before``): the
current value, the region, the membership. That state is Commons text, so it
goes only to the person's screen (``person_before``), never to agents.
Accept applies the edits in order through the route functions themselves, as
the person; if one no longer fits, the proposal closes as invalidated.

Evaluation (blind labeling) and the agent review stay the person's only, with
no proposal: Justin's answer changed only when agents get the Commons.
"""
from __future__ import annotations

import contextvars
import copy
import math
from typing import Any

from services.canvas_proposals import ProposalError, clean_note

MAX_EDITS = 8
EDIT_KINDS = ("correction", "region", "membership")
TEXT_FIELDS = ("summary", "subject", "composition_notes")
AXES = ("quiet_loud", "warm_cold", "geometric_humanist", "dense_airy", "polished_raw")
MEMBERSHIP_ROLES = ("attract", "avoid", "evidence", "neutral")
REGION_STATUSES = ("confirmed", "deleted")
MAX_TEXT = 2000
MAX_REASON = 300
MAX_LABEL = 120
MAX_WHY = 500
MAX_KEYWORD = 60
MAX_ID = 64

# Set while Accept applies a proposal, so the journal line for each write
# says whose proposal it was ("... (accepted from Claude)").
accepted_from: contextvars.ContextVar[str] = contextvars.ContextVar("commons_accepted_from", default="")


def _enums() -> dict[str, tuple[str, ...]]:
    from commons.reader import LAYOUTS, MEDIA, SPACING, TYPE_STYLES

    return {"type_style": TYPE_STYLES, "spacing_density": SPACING, "layout": LAYOUTS, "medium": MEDIA}


def _refuse(detail: str, status: int = 422) -> ProposalError:
    return ProposalError(status, detail)


def _text(raw: Any, *, limit: int, label: str) -> str:
    return clean_note(raw, limit=limit, label=label)


def _object(raw: Any, label: str, allowed: set[str]) -> dict[str, Any]:
    if not isinstance(raw, dict):
        raise _refuse(f"{label} must be an object")
    extra = sorted(set(raw) - allowed)
    if extra:
        raise _refuse(f"{label} has no field '{str(extra[0])[:40]}' (it takes {', '.join(sorted(allowed))})")
    return raw


def _ref_id(raw: Any, label: str) -> str:
    if not isinstance(raw, str) or not raw.strip() or len(raw) > MAX_ID:
        raise _refuse(f"{label} needs the id of one of the reference's {label}s (commons_get lists them)")
    return raw.strip()


def field_path(raw: Any) -> str:
    """The correction's path in the form the Commons stores (``summary.value``)."""
    if not isinstance(raw, str):
        raise _refuse("correction.field_path must be text")
    path = raw.strip()
    leaf = path[:-len(".value")] if path.endswith(".value") else path
    if leaf == "keywords":
        return "keywords"
    if leaf in TEXT_FIELDS or leaf in _enums():
        return f"{leaf}.value"
    if leaf.startswith("axes.") and leaf[5:] in AXES:
        return f"{leaf}.value"
    names = [*TEXT_FIELDS, *_enums(), *(f"axes.{a}" for a in AXES), "keywords"]
    raise _refuse(f"correction.field_path '{path[:60]}' can't be corrected; it must be one of: {', '.join(names)}")


def _correction(raw: Any) -> dict[str, Any]:
    body = _object(raw, "correction", {"field_path", "op", "value", "reason"})
    path = field_path(body.get("field_path"))
    leaf = path[:-len(".value")]
    op = body.get("op", "set")
    value = body.get("value")
    if path == "keywords":
        if op not in ("add", "remove"):
            raise _refuse("a keywords correction takes op add or remove, one keyword at a time")
        value = _text(value, limit=MAX_KEYWORD, label="keyword").lower()
    else:
        if op != "set":
            raise _refuse(f"a {leaf} correction takes op set")
        if leaf in TEXT_FIELDS:
            value = _text(value, limit=MAX_TEXT, label=leaf)
        elif leaf in _enums():
            if value not in _enums()[leaf]:
                raise _refuse(f"{leaf} must be one of: {', '.join(_enums()[leaf])}")
        else:
            if isinstance(value, bool) or not isinstance(value, (int, float)) or not math.isfinite(value) \
                    or not -1 <= value <= 1:
                raise _refuse(f"{leaf} must be a number from -1 to 1")
            value = round(float(value), 4)
    reason = body.get("reason")
    if reason not in (None, ""):
        reason = _text(reason, limit=MAX_REASON, label="correction.reason")
    else:
        reason = None
    return {"field_path": path, "op": op, "value": value, "reason": reason}


def _box(raw: Any) -> list[float]:
    from commons.records import validate_box

    try:
        if isinstance(raw, (list, tuple)) and any(isinstance(v, bool) for v in raw):
            raise ValueError("box must be numbers")
        return [round(v, 4) for v in validate_box(raw)]
    except (TypeError, ValueError) as exc:
        raise _refuse(f"region.box: {exc} (fractions of the image: [x, y, width, height])") from exc


def _region(raw: Any) -> dict[str, Any]:
    body = _object(raw, "region", {"id", "box", "label", "note", "status"})
    if "id" not in body:
        if set(body) - {"box", "label"}:
            raise _refuse("a new region takes box and label only (to change one, give its id)")
        if "label" not in body:
            raise _refuse("a new region needs a label")
        return {"box": _box(body.get("box")), "label": _text(body.get("label"), limit=MAX_LABEL, label="region.label")}
    edit: dict[str, Any] = {"id": _ref_id(body.get("id"), "region")}
    if "label" in body:
        edit["label"] = _text(body["label"], limit=MAX_LABEL, label="region.label")
    if "note" in body:
        edit["note"] = _text(body["note"], limit=MAX_WHY, label="region.note")
    if "status" in body:
        if body["status"] not in REGION_STATUSES:
            raise _refuse("region.status must be confirmed or deleted (deleting a region can be undone)")
        edit["status"] = body["status"]
    if "box" in body:
        edit["box"] = _box(body["box"])
    if len(edit) == 1:
        raise _refuse("a region edit needs label, note, status or box")
    return edit


def _membership(raw: Any) -> dict[str, Any]:
    body = _object(raw, "membership", {"id", "role", "why", "accept"})
    edit: dict[str, Any] = {"id": _ref_id(body.get("id"), "membership")}
    if "role" in body:
        if body["role"] not in MEMBERSHIP_ROLES:
            raise _refuse(f"membership.role must be one of: {', '.join(MEMBERSHIP_ROLES)}")
        edit["role"] = body["role"]
    if "why" in body:
        edit["why"] = _text(body["why"], limit=MAX_WHY, label="membership.why")
    if "accept" in body:
        if body["accept"] is not True:
            raise _refuse("membership.accept must be true (take the reference out of the inbox)")
        edit["accept"] = True
    if len(edit) == 1:
        raise _refuse("a membership edit needs role, why or accept")
    return edit


_PARSERS = {"correction": _correction, "region": _region, "membership": _membership}


def parse_edit(raw: Any) -> dict[str, Any]:
    if not isinstance(raw, dict) or len(raw) != 1 or next(iter(raw)) not in _PARSERS:
        raise _refuse("each edit is one of {\"correction\": {...}}, {\"region\": {...}}, {\"membership\": {...}}")
    what, body = next(iter(raw.items()))
    return {what: _PARSERS[what](body)}


def _edit_key(edit: dict[str, Any]) -> tuple[str, str] | None:
    """What one edit changes: a field, a keyword, a region, a membership (a new region is its own)."""
    what, body = next(iter(edit.items()))
    if what == "correction":
        return ("keyword", body["value"]) if body["field_path"] == "keywords" else ("field", body["field_path"])
    return (what, body["id"]) if "id" in body else None


def _refuse_repeats(edits: list[dict[str, Any]]) -> None:
    """One edit per field, keyword, region or membership: two would each be
    checked against the reference as it is now, and the second would undo or
    blur the first."""
    seen: set[tuple[str, str]] = set()
    for edit in edits:
        key = _edit_key(edit)
        if key is None:
            continue
        if key in seen:
            raise _refuse(f"two edits change the same {key[0]} ({str(key[1])[:60]}); send one edit for it")
        seen.add(key)


def parse_change(raw: dict[str, Any]) -> dict[str, Any]:
    """``change`` for kind commons: one edit, or ``{"edits": [...]}`` (1 to 8)."""
    keys = set(raw)
    if keys == {"edits"}:
        edits = raw["edits"]
        if not isinstance(edits, list) or not edits:
            raise _refuse("change.edits must be a list of 1 to 8 edits")
        if len(edits) > MAX_EDITS:
            raise _refuse(f"one proposal carries at most {MAX_EDITS} edits; propose the rest after")
        parsed = [parse_edit(edit) for edit in edits]
        _refuse_repeats(parsed)
        return {"edits": parsed}
    if len(keys) == 1 and keys <= set(EDIT_KINDS):
        return {"edits": [parse_edit(raw)]}
    if len(keys) > 1 and keys <= set(EDIT_KINDS):
        raise _refuse("more than one edit goes in change.edits: {\"edits\": [{\"correction\": ...}, ...]}")
    raise _refuse("a commons proposal changes a correction, region or membership: "
                  "change = {\"correction\": {...}} or {\"edits\": [...]}")


# -- one line for the journal, the Agent log and the CLI -------------------------

# GM, PR #202 r4: how a Commons ask reads in the Agent log ("Asks to X") and
# its withdrawal ("Withdrew its request to X"), and in the journal. Agents read
# the log, so X names no reference by its id, filename, page title or
# collection, and carries no Commons text (a label, value, why or keyword):
# only the kind of change, a field's name and a role, which the log had.
COMMONS_REFERENCE = "an image in the Commons"


def _edit_words(edit: dict[str, Any]) -> str:
    ref = COMMONS_REFERENCE
    what, body = next(iter(edit.items()))
    if what == "correction":
        if body["field_path"] == "keywords":
            return f"add a keyword to {ref}" if body.get("op") == "add" else f"remove a keyword from {ref}"
        leaf = body["field_path"].removesuffix(".value").replace("axes.", "").replace("_", " ")
        return f"correct the {leaf} of {ref}"
    if what == "region":
        if "id" not in body:
            return f"add a region to {ref}"
        if body.get("status") == "confirmed" and len(body) == 2:
            return f"confirm a region of {ref}"
        if body.get("status") == "deleted":
            return f"delete a region of {ref}"
        return f"change a region of {ref}"
    if body.get("accept") and len(body) == 2:
        return f"take {ref} out of the inbox"
    if "role" in body:
        return f"set {ref} to {body['role']}"
    return f"change why {ref} is in a collection"


def summary(asset_id: str, change: dict[str, Any]) -> str:
    """X in "Asks to X" and "Withdrew its request to X" (GM, PR #202 r4).
    ``asset_id`` is never part of it."""
    edits = change.get("edits") or []
    if len(edits) == 1:
        return _edit_words(edits[0])
    return f"make {len(edits)} changes to {COMMONS_REFERENCE}"


# -- the reference as it is now --------------------------------------------------

def _current(store, asset_id: str, edit: dict[str, Any], memberships: list[dict] | None = None) -> Any:
    """What ``before`` records for this edit, read from the store now. Raises
    KeyError when the region or membership is gone (or isn't this reference's)."""
    from commons import records
    from commons.effective import effective, get_path

    what, body = next(iter(edit.items()))
    if what == "correction":
        fields = effective(store, asset_id)["fields"]
        if body["field_path"] == "keywords":
            return {"present": body["value"] in (fields.get("keywords") or [])}
        return {"value": copy.deepcopy(get_path(fields, body["field_path"]))}
    if what == "region":
        if "id" not in body:
            return None
        region = records._region(store, body["id"])
        if region["asset"] != asset_id:
            raise KeyError(body["id"])
        return {"label": region["label"], "note": region["note"], "status": region["status"], "box": region["box"]}
    rows = memberships if memberships is not None else store.memberships_for_asset(asset_id)
    row = next((m for m in rows if m["id"] == body["id"]), None)
    if row is None:
        raise KeyError(body["id"])
    return {"role": row["role"], "why": row["why"], "in_inbox": bool(row["in_inbox"])}


def _still_to_do(edit: dict[str, Any], now: Any) -> dict[str, Any] | None:
    """The edit without its parts that are already so, or None when nothing is left."""
    what, body = next(iter(edit.items()))
    if what == "correction":
        if body["field_path"] == "keywords":
            changes = now["present"] != (body["op"] == "add")
        else:
            changes = now["value"] != body["value"]
        return edit if changes else None
    if what == "region" and "id" not in body:
        return edit
    kept = {"id": body["id"]}
    for key, value in body.items():
        if key == "id":
            continue
        if what == "membership" and key == "accept":
            if now["in_inbox"]:
                kept[key] = value
        elif now.get(key) != value:
            kept[key] = value
    return {what: kept} if len(kept) > 1 else None


def _already_so(edit: dict[str, Any]) -> str:
    what, body = next(iter(edit.items()))
    if what == "correction":
        return f"the {body['field_path'].removesuffix('.value')} is already that"
    if what == "membership" and body.get("accept"):
        return "that reference is already out of the inbox"
    return f"that {what} is already that way"


def target(store, actor, asset_id: str, change: dict[str, Any], brand: str | None) -> tuple[dict, list]:
    """(the change with parts already so dropped, its ``before`` per edit) for a
    new proposal. Raises HTTPException as the Commons routes do: 404 for a
    reference or a region or membership the agent can't see, 409 when an edit
    is already so, 422 for a bad region box."""
    from fastapi import HTTPException

    from routes import commons as commons_routes

    _asset, memberships, _quarantined = commons_routes._asset_access(store, actor, asset_id, brand)
    edits, before = [], []
    for edit in change["edits"]:
        try:
            now = _current(store, asset_id, edit, memberships)
        except KeyError as exc:
            what = next(iter(edit))
            raise HTTPException(status_code=404, detail=(
                f"No {what} {str(exc.args[0])[:40]} on reference {asset_id} in your scope "
                "(commons_get lists its regions and memberships)")) from exc
        if next(iter(edit)) == "region" and now and now.get("status") == "deleted" and not actor.is_human:
            # commons_get doesn't list a deleted region to agents: it is gone for them.
            raise HTTPException(status_code=404, detail=(
                f"No region {edit['region']['id'][:40]} on reference {asset_id} in your scope "
                "(commons_get lists its regions and memberships)"))
        kept = _still_to_do(edit, now)
        if kept is None:
            raise HTTPException(status_code=409, detail=f"{_already_so(edit)}; nothing to propose")
        edits.append(kept)
        before.append(now)
    return {"edits": edits}, before


def misfit(store, asset_id: str, change: dict[str, Any], before: list) -> str | None:
    """Why the proposal no longer fits its reference, or None while it does."""
    if store.get_asset(asset_id) is None:
        return "the reference was deleted"
    for edit, was in zip(change["edits"], before):
        what, body = next(iter(edit.items()))
        try:
            now = _current(store, asset_id, edit)
        except KeyError:
            return "that region was removed" if what == "region" else "the reference left that collection"
        if now != was:
            if what == "correction":
                return f"the {body['field_path'].removesuffix('.value')} changed since it was proposed"
            return f"that {what} changed since it was proposed"
    return None


def apply(store, asset_id: str, change: dict[str, Any]) -> list[dict[str, str]]:
    """Make each edit through the Commons route the person's own click uses, as
    the person. Returns what was made (``{"correction": id}``, ...)."""
    from commons import actors
    from routes import commons as commons_routes

    person = actors.Actor(actors.HUMAN, "human")
    made: list[dict[str, str]] = []
    for edit in change["edits"]:
        what, body = next(iter(edit.items()))
        if what == "correction":
            row = commons_routes.add_correction(asset_id, commons_routes.CorrectionIn(**body), actor=person, store=store)
            made.append({"correction": row["id"]})
        elif what == "region" and "id" not in body:
            row = commons_routes.add_region(asset_id, commons_routes.RegionIn(**body), actor=person, store=store)
            made.append({"region": row["id"]})
        elif what == "region":
            fields = {k: v for k, v in body.items() if k != "id"}
            commons_routes.patch_region(body["id"], commons_routes.RegionPatch(**fields), actor=person, store=store)
            made.append({"region": body["id"]})
        else:
            fields = {k: v for k, v in body.items() if k in ("role", "why")}
            if fields:
                commons_routes.patch_membership(body["id"], commons_routes.MembershipPatch(**fields),
                                                actor=person, store=store)
            if body.get("accept"):
                commons_routes.accept_membership(body["id"], actor=person, store=store)
            made.append({"membership": body["id"]})
    return made
