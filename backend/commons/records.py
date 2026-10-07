"""Analyses, corrections, regions, comments, quarantine, few-shots, meter."""
from __future__ import annotations

import json
from datetime import datetime, timedelta, timezone
from typing import Any

from commons.db import now_iso
from commons.ids import new_id
from commons.measure import phash_distance

DEFAULT_DAILY_CAP = 20
QUARANTINE_DISTANCE = 8
_TS = "%Y-%m-%dT%H:%M:%S.%fZ"


def _iso(dt: datetime) -> str:
    return dt.strftime(_TS)


def validate_box(box: Any) -> list[float]:
    if not isinstance(box, (list, tuple)) or len(box) != 4:
        raise ValueError("box must be [x, y, w, h]")
    x, y, w, h = (float(v) for v in box)
    if not (0 <= x <= 1 and 0 <= y <= 1 and 0 < w <= 1 and 0 < h <= 1 and x + w <= 1.0001 and y + h <= 1.0001):
        raise ValueError("box must lie within 0-1 with positive size")
    return [x, y, w, h]


def _iou(a: list[float], b: list[float]) -> float:
    ax2, ay2, bx2, by2 = a[0] + a[2], a[1] + a[3], b[0] + b[2], b[1] + b[3]
    iw = max(0.0, min(ax2, bx2) - max(a[0], b[0]))
    ih = max(0.0, min(ay2, by2) - max(a[1], b[1]))
    inter = iw * ih
    union = a[2] * a[3] + b[2] * b[3] - inter
    return inter / union if union else 0.0


def _reindex(store, asset_id: str) -> None:
    from commons import search  # local import: search imports records

    search.reindex_asset(store, asset_id)


# -- analyses ---------------------------------------------------------------

def latest_analysis(store, asset_id: str) -> dict | None:
    with store.db.read() as conn:
        row = conn.execute("SELECT * FROM analyses WHERE asset = ? AND status = 'ok' "
                           "ORDER BY created_at DESC LIMIT 1", (asset_id,)).fetchone()
    if row is None:
        return None
    out = dict(row)
    out["fields"] = json.loads(out["fields"]) if out["fields"] else {}
    out["fewshot_ids"] = json.loads(out["fewshot_ids"])
    return out


def write_analysis_ok(store, asset_id: str, *, fields: dict, raw_output: str, fewshot_ids: list[str],
                      prompt_version: str, model_id: str, vocab_version: str, candidates: list[str],
                      proposed_regions: list[dict], duration_ms: int | None,
                      code_version: str = "measure-1") -> dict:
    aid = new_id("ana")
    now = now_iso()
    with store.db.tx() as conn:
        conn.execute(
            "INSERT INTO analyses(id, asset, status, prompt_version, model_id, code_version, vocab_version, "
            "fields, raw_output, fewshot_ids, duration_ms, created_at) "
            "VALUES (?, ?, 'ok', ?, ?, ?, ?, ?, ?, ?, ?, ?)",
            (aid, asset_id, prompt_version, model_id, code_version, vocab_version, json.dumps(fields),
             raw_output, json.dumps(fewshot_ids), duration_ms, now),
        )
        conn.execute("UPDATE assets SET analysis_state = 'ready', last_error = NULL, next_attempt_at = NULL "
                     "WHERE id = ?", (asset_id,))
        existing = [json.loads(r["box"]) for r in conn.execute(
            "SELECT box FROM regions WHERE asset = ? AND status != 'deleted'", (asset_id,))]
        for region in proposed_regions:
            box = validate_box(region["box"])
            if any(_iou(box, other) > 0.8 for other in existing):
                continue
            conn.execute(
                "INSERT INTO regions(id, asset, box, label, status, actor, analysis, created_at, updated_at) "
                "VALUES (?, ?, ?, ?, 'proposed', ?, ?, ?, ?)",
                (new_id("reg"), asset_id, json.dumps(box), str(region["label"])[:120],
                 f"model:{model_id}", aid, now, now),
            )
            existing.append(box)
        for term in candidates[:3]:
            conn.execute("INSERT OR IGNORE INTO vocab_candidates(term, asset, analysis, created_at) "
                         "VALUES (?, ?, ?, ?)", (term, asset_id, aid, now))
        store.emit(conn, "analysis_written", {"asset": asset_id, "analysis": aid, "model": model_id,
                                              "prompt_version": prompt_version}, "worker:analysis")
    _reindex(store, asset_id)
    from commons import borrow  # local import: borrow imports effective/search, which import records

    borrow.resolve_pending_fidelity(store, asset_id)
    return latest_analysis(store, asset_id)


def write_analysis_failed(store, asset_id: str, *, error: str, raw_output: str | None, prompt_version: str,
                          model_id: str, vocab_version: str, fewshot_ids: list[str],
                          max_attempts: int = 3, code_version: str = "measure-1") -> dict:
    aid = new_id("ana")
    now = datetime.now(timezone.utc)
    with store.db.tx() as conn:
        conn.execute(
            "INSERT INTO analyses(id, asset, status, prompt_version, model_id, code_version, vocab_version, "
            "raw_output, fewshot_ids, error, created_at) VALUES (?, ?, 'failed', ?, ?, ?, ?, ?, ?, ?, ?)",
            (aid, asset_id, prompt_version, model_id, code_version, vocab_version, raw_output,
             json.dumps(fewshot_ids), error[:2000], _iso(now)),
        )
        attempts = conn.execute("SELECT attempts FROM assets WHERE id = ?", (asset_id,)).fetchone()[0]
        if attempts < max_attempts:
            due = _iso(now + timedelta(seconds=30 * 2 ** attempts))
            conn.execute("UPDATE assets SET analysis_state = 'queued', next_attempt_at = ?, last_error = ? "
                         "WHERE id = ?", (due, error[:500], asset_id))
        else:
            conn.execute("UPDATE assets SET analysis_state = 'analysis_failed', last_error = ? WHERE id = ?",
                         (error[:500], asset_id))
        store.emit(conn, "analysis_failed", {"asset": asset_id, "analysis": aid, "error": error[:200]},
                   "worker:analysis")
        terminal = attempts >= max_attempts
    if terminal:
        from commons import borrow  # local import: borrow imports effective -> records

        borrow.fail_pending_fidelity(store, asset_id)
    return {"id": aid, "status": "failed"}


def evaluation_open(conn) -> bool:
    """A held-out batch exists that is neither sealed nor closed.

    While one is open, blind human truth may still be recorded, so no import
    analysis may run (it would anchor the labels and tune the prompt toward
    them). Sealing or an explicit close ends that; quarantine applies either way.
    """
    return conn.execute(
        "SELECT 1 FROM evaluation_batch WHERE sealed IS NULL AND closed IS NULL").fetchone() is not None


def claim_next(store, *, now_iso: str) -> dict | None:
    with store.db.tx() as conn:
        if evaluation_open(conn):
            return None
        banned = _quarantined_ids(conn)
        rows = conn.execute(
            "SELECT id FROM assets WHERE analysis_state = 'queued' AND media = 'image' "
            "AND (next_attempt_at IS NULL OR next_attempt_at <= ?) ORDER BY created_at",
            (now_iso,)).fetchall()
        row = next((r for r in rows if r["id"] not in banned), None)
        if row is None:
            return None
        conn.execute("UPDATE assets SET analysis_state = 'analyzing', attempts = attempts + 1 WHERE id = ?",
                     (row["id"],))
    return store.get_asset(row["id"])


def requeue_stale_analyzing(store) -> int:
    with store.db.tx() as conn:
        return conn.execute("UPDATE assets SET analysis_state = 'queued' WHERE analysis_state = 'analyzing'"
                            ).rowcount


def requeue(store, asset_id: str, *, actor: str) -> None:
    with store.db.tx() as conn:
        conn.execute("UPDATE assets SET analysis_state = 'queued', attempts = 0, next_attempt_at = NULL "
                     "WHERE id = ? AND media = 'image'", (asset_id,))
        store.emit(conn, "analysis_requeued", {"asset": asset_id}, actor)


def stale_asset_ids(store, *, prompt_version: str, model_id: str, collection_id: str | None = None) -> list[str]:
    """Assets whose latest ok analysis used another prompt or model (§6.5).
    A vocabulary bump does not make an analysis stale (§6.3)."""
    sql = ("SELECT a.id FROM assets a JOIN analyses an ON an.asset = a.id AND an.status = 'ok' "
           "AND an.created_at = (SELECT max(created_at) FROM analyses WHERE asset = a.id AND status = 'ok') "
           "WHERE (an.prompt_version != ? OR an.model_id != ?)")
    args: list[Any] = [prompt_version, model_id]
    if collection_id:
        sql += " AND a.id IN (SELECT asset FROM memberships WHERE collection = ?)"
        args.append(collection_id)
    with store.db.read() as conn:
        return [r[0] for r in conn.execute(sql, args)]


# -- corrections ------------------------------------------------------------

def add_correction(store, asset_id: str, *, field_path: str, op: str, value: Any, actor: str,
                   reason: str | None = None) -> dict:
    if op not in ("set", "add", "remove"):
        raise ValueError("op must be set, add or remove")
    cid = new_id("cor")
    with store.db.tx() as conn:
        conn.execute("INSERT INTO corrections(id, asset, field_path, op, value, actor, reason, at) "
                     "VALUES (?, ?, ?, ?, ?, ?, ?, ?)",
                     (cid, asset_id, field_path, op, json.dumps(value), actor, reason, now_iso()))
        store.emit(conn, "correction_added", {"asset": asset_id, "field_path": field_path, "op": op,
                                              "value": value, "reason": reason}, actor)
    _reindex(store, asset_id)
    return {"id": cid, "asset": asset_id, "field_path": field_path, "op": op, "value": value, "actor": actor}


def list_corrections(store, asset_id: str) -> list[dict]:
    with store.db.read() as conn:
        rows = conn.execute("SELECT * FROM corrections WHERE asset = ? ORDER BY at, id", (asset_id,)).fetchall()
    return [{**dict(r), "value": json.loads(r["value"])} for r in rows]


# -- regions + comments -----------------------------------------------------

def add_region(store, asset_id: str, *, box: list[float], label: str, actor: str, status: str = "confirmed",
               analysis_id: str | None = None) -> dict:
    rid = new_id("reg")
    now = now_iso()
    with store.db.tx() as conn:
        conn.execute("INSERT INTO regions(id, asset, box, label, status, actor, analysis, created_at, updated_at) "
                     "VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)",
                     (rid, asset_id, json.dumps(validate_box(box)), label[:120], status, actor, analysis_id, now, now))
        store.emit(conn, "region_added", {"asset": asset_id, "region": rid, "label": label}, actor)
    _reindex(store, asset_id)
    return _region(store, rid)


def update_region(store, region_id: str, *, actor: str, label: str | None = None, note: str | None = None,
                  status: str | None = None, box: list[float] | None = None) -> dict:
    sets, args = ["updated_at = ?"], [now_iso()]
    if label is not None:
        sets.append("label = ?"); args.append(label[:120])
    if note is not None:
        sets.append("note = ?"); args.append(note)
    if status is not None:
        if status not in ("proposed", "confirmed", "deleted"):
            raise ValueError("bad region status")
        sets.append("status = ?"); args.append(status)
    if box is not None:
        sets.append("box = ?"); args.append(json.dumps(validate_box(box)))
    with store.db.tx() as conn:
        conn.execute(f"UPDATE regions SET {', '.join(sets)} WHERE id = ?", (*args, region_id))
        store.emit(conn, "region_updated", {"region": region_id, "status": status, "label": label}, actor)
    region = _region(store, region_id)
    _reindex(store, region["asset"])
    return region


def _region(store, region_id: str) -> dict:
    with store.db.read() as conn:
        row = conn.execute("SELECT * FROM regions WHERE id = ?", (region_id,)).fetchone()
    if row is None:
        raise KeyError(region_id)
    return {**dict(row), "box": json.loads(row["box"])}


def list_regions(store, asset_id: str, *, include_deleted: bool = False) -> list[dict]:
    sql = "SELECT * FROM regions WHERE asset = ?" + ("" if include_deleted else " AND status != 'deleted'")
    with store.db.read() as conn:
        rows = conn.execute(sql + " ORDER BY created_at, id", (asset_id,)).fetchall()
    return [{**dict(r), "box": json.loads(r["box"])} for r in rows]


def add_comment(store, membership_id: str, *, text: str, actor: str, region_id: str | None = None,
                source_date: str | None = None) -> dict:
    text = text.strip()
    if not text:
        raise ValueError("comment text is empty")
    if region_id is not None:
        membership = store.get_membership(membership_id)
        with store.db.read() as conn:
            region = conn.execute("SELECT asset FROM regions WHERE id = ?", (region_id,)).fetchone()
        if membership is None or region is None or region["asset"] != membership["asset"]:
            raise ValueError("region not found on this asset")
    cid = new_id("cmt")
    with store.db.tx() as conn:
        conn.execute("INSERT INTO comments(id, membership, region, actor, text, source_date, created_at) "
                     "VALUES (?, ?, ?, ?, ?, ?, ?)",
                     (cid, membership_id, region_id, actor, text[:8000], source_date, now_iso()))
        store.emit(conn, "comment_added", {"membership": membership_id, "comment": cid, "text": text[:8000],
                                           "region": region_id}, actor)
    membership = store.get_membership(membership_id)
    if membership is not None:
        _reindex(store, membership["asset"])
    return {"id": cid, "membership": membership_id, "region": region_id, "actor": actor, "text": text}


def list_comments(store, membership_id: str) -> list[dict]:
    with store.db.read() as conn:
        return [dict(r) for r in conn.execute(
            "SELECT * FROM comments WHERE membership = ? ORDER BY coalesce(source_date, created_at), id",
            (membership_id,))]


# -- quarantine + few-shots -------------------------------------------------

def quarantine_add(store, phashes: list[tuple[str, str | None]]) -> int:
    with store.db.tx() as conn:
        for ph, rel in phashes:
            conn.execute("INSERT OR IGNORE INTO quarantine(phash, source_rel_path, created_at) VALUES (?, ?, ?)",
                         (ph, rel, now_iso()))
    return len(phashes)


def _quarantine_hashes(store) -> list[str]:
    with store.db.read() as conn:
        return [r[0] for r in conn.execute("SELECT phash FROM quarantine")]


def _quarantined_ids(conn) -> set[str]:
    hashes = {r[0] for r in conn.execute("SELECT phash FROM quarantine")}
    if not hashes:
        return set()
    rows = conn.execute("SELECT id, phash, parent_asset FROM assets").fetchall()
    banned = set()
    changed = True
    while changed:
        changed = False
        for r in rows:
            if r["id"] in banned:
                continue
            if r["parent_asset"] in banned or (r["phash"] and any(
                    phash_distance(r["phash"], h) <= QUARANTINE_DISTANCE for h in hashes)):
                banned.add(r["id"])
                if r["parent_asset"]:
                    banned.add(r["parent_asset"])
                if r["phash"]:
                    hashes.add(r["phash"])
                changed = True
    return banned


def is_quarantined(store, asset_id: str) -> bool:
    return asset_id in quarantined_asset_ids(store)


def quarantined_asset_ids(store) -> set[str]:
    with store.db.read() as conn:
        return _quarantined_ids(conn)


def pick_fewshots(store, *, limit: int = 8) -> list[dict]:
    """Recent human corrections as worked examples, spread across fields.

    Never from quarantined assets or their phash near-duplicates (§6.4)."""
    banned = quarantined_asset_ids(store)
    with store.db.read() as conn:
        rows = conn.execute("SELECT * FROM corrections WHERE actor LIKE 'human:%' ORDER BY at DESC, id DESC"
                            ).fetchall()
    by_field: dict[str, list[dict]] = {}
    for r in rows:
        if r["asset"] in banned:
            continue
        top = r["field_path"].split(".")[0]
        by_field.setdefault(top, []).append({**dict(r), "value": json.loads(r["value"])})
    picked: list[dict] = []
    while len(picked) < limit and any(by_field.values()):
        for top in list(by_field):
            if by_field[top] and len(picked) < limit:
                picked.append(by_field[top].pop(0))
    return picked


# -- meter ------------------------------------------------------------------

def meter_today(store, kind: str = "analysis", *, cap_key: str = "daily_cap",
                cap_default: int = DEFAULT_DAILY_CAP) -> dict:
    now = datetime.now(timezone.utc)
    day = now.strftime("%Y-%m-%d")
    cap = int(store.get_setting(cap_key, cap_default))
    with store.db.read() as conn:
        row = conn.execute("SELECT calls FROM meter WHERE day = ? AND kind = ?", (day, kind)).fetchone()
    calls = row[0] if row else 0
    resets = datetime(now.year, now.month, now.day, tzinfo=timezone.utc) + timedelta(days=1)
    return {"day": day, "calls": calls, "cap": cap, "remaining": max(0, cap - calls), "resets_at": _iso(resets)}


def meter_increment(store, kind: str = "analysis") -> int:
    day = datetime.now(timezone.utc).strftime("%Y-%m-%d")
    with store.db.tx() as conn:
        conn.execute("INSERT INTO meter(day, kind, calls) VALUES (?, ?, 1) "
                     "ON CONFLICT(day, kind) DO UPDATE SET calls = calls + 1", (day, kind))
        return conn.execute("SELECT calls FROM meter WHERE day = ? AND kind = ?", (day, kind)).fetchone()[0]
