"""Borrowing: integrity at call time, fidelity at output time (§7.4)."""
from __future__ import annotations

import json
import math
from pathlib import Path
from typing import Any

from commons import effective as eff_mod
from commons.colour import delta_e00, hex_to_lab
from commons.db import now_iso
from commons.ids import new_id
from commons.search import AXES

ENUM_ATTRS = {"type_style", "spacing_density", "layout", "medium"}
AXIS_ATTRS = {f"axes.{a}" for a in AXES}
TEXT_ATTRS = {"summary", "subject", "composition_notes"}
ATTRIBUTES = ENUM_ATTRS | AXIS_ATTRS | TEXT_ATTRS | {"palette", "region"}
PALETTE_TOLERANCE = 5.0
AXIS_TOLERANCE = 0.25
CONCENTRATION_THRESHOLD = 0.25
OUTPUTS_COLLECTION = "_outputs"
READER_FAILED = {"status": "unverifiable", "reason": "the reader failed on the output", "reader_failed": True}


class BorrowRejected(Exception):
    def __init__(self, reason: str) -> None:
        super().__init__(reason)
        self.reason = reason


def _reject(store, actor_id: str, asset_id: str, attribute: str, reason: str) -> None:
    with store.db.tx() as conn:
        store.emit(conn, "borrow_rejected", {"asset": asset_id, "attribute": attribute, "reason": reason}, actor_id)
    raise BorrowRejected(reason)


def check_integrity(store, *, asset_id: str, attribute: str, value: Any, region_id: str | None,
                    scope_ids: set[str], hide_quarantined: bool = False) -> dict:
    if attribute not in ATTRIBUTES:
        raise BorrowRejected(f"unknown attribute {attribute!r}")
    if store.get_asset(asset_id) is None:
        raise BorrowRejected("asset not found")
    if hide_quarantined:
        from commons import records

        if records.is_quarantined(store, asset_id):
            # Same answer as out-of-scope: an agent can't tell a held-out eval item exists (§11).
            raise BorrowRejected("asset is not in this brand scope")
    in_scope = [m for m in store.memberships_for_asset(asset_id) if m["collection"] in scope_ids]
    if not in_scope:
        raise BorrowRejected("asset is not in this brand scope")
    usable = [m for m in in_scope if m["role"] != "avoid" and not m["in_inbox"]]
    if not usable:
        raise BorrowRejected("asset is only an avoid or inbox reference here")
    membership = usable[0]
    checks = ["scope"]
    if region_id is not None or attribute == "region":
        from commons import records

        regions = {r["id"]: r for r in records.list_regions(store, asset_id)}
        if region_id not in regions:
            raise BorrowRejected("region not found on this asset")
        checks.append("region")
    fields = eff_mod.effective(store, asset_id)["fields"]
    try:
        return {"membership": membership, "stored_value": _check_value(fields, attribute, value), "checks":
                checks + ["value"]}
    except (TypeError, ValueError) as exc:
        raise BorrowRejected(f"malformed {attribute} value: {exc}") from exc


def _check_value(fields: dict, attribute: str, value: Any) -> Any:
    """The value to freeze on the borrowing, or BorrowRejected. A malformed value
    (bad hex, non-numeric axis) raises TypeError/ValueError for the caller."""
    stored: Any = value
    if attribute == "palette":
        target = hex_to_lab(str(value))
        best = min(((float(delta_e00(hex_to_lab(p["hex"]), target)), p["index"]) for p in fields.get("palette") or []),
                   default=(999.0, None))
        if best[0] > PALETTE_TOLERANCE:
            raise BorrowRejected("colour is not in the palette (dE00 > 5)")
        stored = {"hex": str(value).lower(), "matched_index": best[1], "delta_e": round(best[0], 2)}
    elif attribute in ENUM_ATTRS:
        current = eff_mod.get_path(fields, f"{attribute}.value")
        if current is None:
            raise BorrowRejected(f"{attribute} is not in the analysis")
        if current != value:
            raise BorrowRejected(f"{attribute} value does not match the analysis ({current})")
    elif attribute in AXIS_ATTRS:
        current = eff_mod.get_path(fields, f"{attribute}.value")
        if current is None:
            raise BorrowRejected(f"{attribute} is not in the analysis")
        if isinstance(value, bool) or not math.isfinite(float(value)):
            raise ValueError("axis value must be a finite number")
        if abs(float(current) - float(value)) > AXIS_TOLERANCE:
            raise BorrowRejected(f"{attribute} is outside ±0.25 of the analysis ({current})")
        stored = float(value)
    elif attribute in TEXT_ATTRS:
        if eff_mod.get_path(fields, f"{attribute}.value") is None:
            raise BorrowRejected(f"{attribute} is not in the analysis")
    return stored


def record_borrow(store, *, actor_id: str, asset_id: str, attribute: str, value: Any, region_id: str | None,
                  used_in: dict, why: str, scope_ids: set[str], hide_quarantined: bool = False) -> dict:
    if not (why or "").strip():
        _reject(store, actor_id, asset_id, attribute, "why is required")
    if used_in.get("kind") not in ("nebula_output", "external") or not str(used_in.get("ref") or "").strip():
        _reject(store, actor_id, asset_id, attribute, "used_in needs kind nebula_output|external and a ref")
    # Only kind and ref are kept; anything else a caller sends (e.g. an actor) is dropped.
    used_in = {"kind": used_in["kind"], "ref": str(used_in["ref"]).strip()}
    try:
        result = check_integrity(store, asset_id=asset_id, attribute=attribute, value=value,
                                 region_id=region_id, scope_ids=scope_ids, hide_quarantined=hide_quarantined)
    except BorrowRejected as exc:
        _reject(store, actor_id, asset_id, attribute, exc.reason)
    membership = result["membership"]
    bid = new_id("bor")
    fidelity = ({"status": "pending"} if used_in["kind"] == "nebula_output"
                else {"status": "unverifiable", "reason": "external output"})
    with store.db.tx() as conn:
        conn.execute(
            "INSERT INTO borrowings(id, asset, membership, attribute, region, value, used_in, why, actor, integrity, "
            "fidelity, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)",
            (bid, asset_id, membership["id"], attribute, region_id, json.dumps(result["stored_value"]),
             json.dumps(used_in), why.strip(), actor_id, json.dumps({"ok": True, "checks": result["checks"]}),
             json.dumps(fidelity), now_iso()))
        store.emit(conn, "borrowed", {"borrowing": bid, "asset": asset_id, "attribute": attribute,
                                      "value": result["stored_value"], "used_in": used_in}, actor_id)
        if membership.get("brand"):
            store.emit(conn, "reference_add_pending", {"borrowing": bid, "brand": membership["brand"],
                                                       "status": "pending_design_memory"}, actor_id)
    if used_in["kind"] == "nebula_output":
        path = _output_file(used_in["ref"])
        if path is not None:
            from services.output import append_commons_borrowing

            append_commons_borrowing(path.parent, {"borrowing": bid, "asset": asset_id, "attribute": attribute,
                                                   "value": result["stored_value"], "why": why.strip(),
                                                   "file": path.name})
    return get_borrowing(store, bid)


def get_borrowing(store, borrowing_id: str) -> dict:
    with store.db.read() as conn:
        row = conn.execute("SELECT * FROM borrowings WHERE id = ?", (borrowing_id,)).fetchone()
    if row is None:
        raise KeyError(borrowing_id)
    out = dict(row)
    for key in ("value", "used_in", "integrity", "fidelity"):
        out[key] = json.loads(out[key]) if out[key] else None
    return out


def list_borrowings(store, *, asset_id: str | None = None) -> list[dict]:
    sql, args = "SELECT id FROM borrowings", ()
    if asset_id:
        sql, args = sql + " WHERE asset = ?", (asset_id,)
    with store.db.read() as conn:
        ids = [r[0] for r in conn.execute(sql + " ORDER BY created_at", args)]
    return [get_borrowing(store, i) for i in ids]


def _output_file(ref: str) -> Path | None:
    if not ref.startswith("/api/outputs/"):
        return None
    from commons.intake import _output_path

    return _output_path(ref)


def _set_fidelity(store, borrowing_id: str, fidelity: dict, fidelity_asset: str | None = None) -> dict:
    with store.db.tx() as conn:
        if fidelity_asset:
            conn.execute("UPDATE borrowings SET fidelity = ?, fidelity_asset = ? WHERE id = ?",
                         (json.dumps(fidelity), fidelity_asset, borrowing_id))
        else:
            conn.execute("UPDATE borrowings SET fidelity = ? WHERE id = ?", (json.dumps(fidelity), borrowing_id))
        store.emit(conn, "fidelity_checked", {"borrowing": borrowing_id, **fidelity}, "system:fidelity")
    return fidelity


def _compare(attribute: str, stored: Any, fields: dict) -> dict:
    current = eff_mod.get_path(fields, f"{attribute}.value")
    if current is None:
        return {"status": "fail", "reason": f"reader found no {attribute} in the output"}
    if attribute in AXIS_ATTRS:
        ok = abs(float(current) - float(stored)) <= AXIS_TOLERANCE
    else:
        ok = current == stored
    return {"status": "pass" if ok else "fail", "observed": current}


def run_fidelity(store, borrowing_id: str) -> dict:
    from commons import intake
    from commons.measure import measure_image
    from commons import media

    b = get_borrowing(store, borrowing_id)
    if b["used_in"]["kind"] != "nebula_output":
        return _set_fidelity(store, borrowing_id, {"status": "unverifiable", "reason": "external output"})
    path = _output_file(b["used_in"]["ref"])
    if path is None:
        return _set_fidelity(store, borrowing_id, {"status": "unverifiable", "reason": "output file not found"})
    attribute = b["attribute"]
    if attribute in TEXT_ATTRS or attribute == "region":
        return _set_fidelity(store, borrowing_id, {"status": "unverifiable", "reason": "free text is not checked"})
    data = path.read_bytes()
    try:
        sniffed = media.sniff(data)
        media.check_size(sniffed.media, len(data))
    except media.MediaError as exc:
        return _set_fidelity(store, borrowing_id, {"status": "unverifiable", "reason": f"output unreadable: {exc}"})
    if sniffed.media != "image":
        # The reader only analyzes images in phase 1, and a palette needs pixels.
        return _set_fidelity(store, borrowing_id, {"status": "unverifiable", "reason": "output is not an image"})
    if attribute == "palette":
        try:
            palette = measure_image(media.load_image(data, sniffed.mime))["palette"]
        except media.MediaError as exc:
            return _set_fidelity(store, borrowing_id,
                                 {"status": "unverifiable", "reason": f"output unreadable: {exc}"})
        target = hex_to_lab(b["value"]["hex"])
        best = min(float(delta_e00(hex_to_lab(p["hex"]), target)) for p in palette)
        return _set_fidelity(store, borrowing_id, {"status": "pass" if best <= PALETTE_TOLERANCE else "fail",
                                                   "delta_e": round(best, 2)})
    outputs = store.ensure_collection(OUTPUTS_COLLECTION, "system", actor="system:fidelity")
    try:
        res = intake.add_bytes(store, data, filename=path.name, collection_id=outputs["id"],
                               actor="system:fidelity", source={"kind": "output", "url": b["used_in"]["ref"]},
                               made_by="ai")
    except intake.IntakeError as exc:
        return _set_fidelity(store, borrowing_id, {"status": "unverifiable", "reason": f"output unreadable: {exc}"})
    if res.asset["analysis_state"] == "ready":
        fields = eff_mod.effective(store, res.asset["id"])["fields"]
        return _set_fidelity(store, borrowing_id, _compare(attribute, b["value"], fields), res.asset["id"])
    if res.asset["analysis_state"] == "analysis_failed":
        return _set_fidelity(store, borrowing_id, dict(READER_FAILED), res.asset["id"])
    return _set_fidelity(store, borrowing_id, {"status": "pending", "reason": "waiting for the reader"},
                         res.asset["id"])


def _awaiting_reader(fidelity: dict | None) -> bool:
    """Pending, or given up on because the reader failed (a later re-analysis may still succeed)."""
    fidelity = fidelity or {}
    return fidelity.get("status") == "pending" or bool(fidelity.get("reader_failed"))


def _awaiting_ids(store, asset_id: str) -> list[dict]:
    with store.db.read() as conn:
        ids = [r[0] for r in conn.execute("SELECT id FROM borrowings WHERE fidelity_asset = ?", (asset_id,))]
    return [b for b in (get_borrowing(store, i) for i in ids) if _awaiting_reader(b["fidelity"])]


def resolve_pending_fidelity(store, asset_id: str) -> int:
    waiting = _awaiting_ids(store, asset_id)
    if not waiting:
        return 0
    fields = eff_mod.effective(store, asset_id)["fields"]
    for b in waiting:
        _set_fidelity(store, b["id"], _compare(b["attribute"], b["value"], fields))
    return len(waiting)


def fail_pending_fidelity(store, asset_id: str) -> int:
    """The output's analysis failed for good: its borrowings stop waiting (they'd sit `pending` forever)."""
    waiting = [b for b in _awaiting_ids(store, asset_id) if (b["fidelity"] or {}).get("status") == "pending"]
    for b in waiting:
        _set_fidelity(store, b["id"], dict(READER_FAILED))
    return len(waiting)


def concentration(store) -> dict:
    with store.db.read() as conn:
        rows = conn.execute("SELECT asset, count(*) AS n FROM borrowings GROUP BY asset").fetchall()
    total = sum(r["n"] for r in rows)
    by_asset = {r["asset"]: round(r["n"] / total, 4) for r in rows} if total else {}
    return {"total": total, "by_asset": by_asset, "threshold": CONCENTRATION_THRESHOLD,
            "flagged": sorted(a for a, share in by_asset.items() if share > CONCENTRATION_THRESHOLD)}
