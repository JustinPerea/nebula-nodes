"""FTS5 search over the commons, brand-scoped by default (§7.1)."""
from __future__ import annotations

import math
import re
from dataclasses import dataclass, field
from typing import Any

from commons import effective as eff_mod
from commons import records
from commons.colour import delta_e00, hex_to_lab
from commons.vocab import load_vocabulary

AXES = ("quiet_loud", "warm_cold", "geometric_humanist", "dense_airy", "polished_raw")
DEFAULT_BRAND_INHERITS = {"mitamaton": ["good-machines"]}
_COLUMNS = ("summary", "keywords", "notes", "subject", "collection", "why")
_TOKEN = re.compile(r"[a-z0-9]+")
_STOP = {"a", "an", "the", "and", "or", "of", "for", "to", "in", "on", "with", "that", "this", "is",
         "it", "me", "my", "we", "our", "some", "like", "looks", "look", "something", "want", "need"}
_ROLES = {"attract", "avoid", "evidence", "neutral"}


def _filter_number(value: Any, name: str) -> float:
    """Accept existing numeric strings while rejecting malformed/nonfinite values."""
    message = f"{name} must be a finite number"
    if isinstance(value, bool) or not isinstance(value, (int, float, str)):
        raise ValueError(message)
    try:
        number = float(value)
    except (ValueError, OverflowError) as exc:
        raise ValueError(message) from exc
    if not math.isfinite(number):
        raise ValueError(message)
    return number


@dataclass
class Filters:
    axes: dict[str, tuple[float, float]] = field(default_factory=dict)
    keywords: list[str] = field(default_factory=list)
    palette_near: dict | None = None
    collection: str | None = None
    media: str | None = None
    role: str | None = None
    made_by: str | None = None
    corrected_only: bool = False
    has_comments: bool = False
    inbox: bool = False

    @classmethod
    def from_dict(cls, d: dict | None) -> "Filters":
        if d is None:
            d = {}
        if not isinstance(d, dict):
            raise ValueError("filters must be an object")
        raw_axes = d.get("axes")
        if raw_axes is None:
            raw_axes = {}
        if not isinstance(raw_axes, dict):
            raise ValueError("axes must be an object")
        axes = {}
        for name, bounds in raw_axes.items():
            if name not in AXES:
                raise ValueError(f"unknown axis {name}")
            if not isinstance(bounds, (list, tuple)) or len(bounds) != 2:
                raise ValueError(f"axes.{name} must be a two-number range")
            lo = _filter_number(bounds[0], f"axes.{name} lower bound")
            hi = _filter_number(bounds[1], f"axes.{name} upper bound")
            if not (-1 <= lo <= hi <= 1):
                raise ValueError("axis range must be within -1..1")
            axes[name] = (lo, hi)
        near = d.get("palette_near")
        if near is not None:
            if not isinstance(near, dict):
                raise ValueError("palette_near must be an object")
            color = near.get("hex")
            if not isinstance(color, str):
                raise ValueError("palette_near.hex must be a #rrggbb string")
            try:
                hex_to_lab(color)
            except ValueError as exc:
                raise ValueError("palette_near.hex must be a #rrggbb string") from exc
            max_de = _filter_number(near.get("max_delta_e", 10), "palette_near.max_delta_e")
            if not 0 < max_de <= 10:
                raise ValueError("palette_near.max_delta_e must be in (0, 10]")
            near = {"hex": color, "max_delta_e": max_de}
        for name in ("collection", "media", "role", "made_by"):
            value = d.get(name)
            if value is not None and not isinstance(value, str):
                raise ValueError(f"{name} must be a string")
        role = d.get("role")
        if role is not None and role not in _ROLES:
            raise ValueError("bad role")
        raw_keywords = d.get("keywords")
        if raw_keywords is None:
            raw_keywords = []
        if not isinstance(raw_keywords, (list, tuple)) or any(not isinstance(k, str) for k in raw_keywords):
            raise ValueError("keywords must be a list of strings")
        vocab = load_vocabulary()
        keywords = [vocab.canonical(k) or k.lower() for k in raw_keywords]
        return cls(axes=axes, keywords=keywords, palette_near=near, collection=d.get("collection"),
                   media=d.get("media"), role=role, made_by=d.get("made_by"),
                   corrected_only=bool(d.get("corrected_only")), has_comments=bool(d.get("has_comments")),
                   inbox=bool(d.get("inbox")))


def scope_collection_ids(store, brand: str | None, *, all_scopes: bool = False) -> set[str]:
    collections = store.list_collections()  # excludes system
    if all_scopes:
        return {c["id"] for c in collections}
    inherits = store.get_setting("brand_inherits", DEFAULT_BRAND_INHERITS)
    allowed: set[str | None] = {None}
    if brand:
        allowed |= {brand, *inherits.get(brand, [])}
    return {c["id"] for c in collections if c["brand"] in allowed}


def _text(value: Any) -> str:
    if isinstance(value, dict):
        value = value.get("value")
    return "" if value is None else str(value)


def reindex_asset(store, asset_id: str) -> None:
    asset = store.get_asset(asset_id)
    with store.db.tx() as conn:
        conn.execute("DELETE FROM search_fts WHERE asset = ?", (asset_id,))
    if asset is None:
        return
    fields = eff_mod.effective(store, asset_id)["fields"]
    keywords = " ".join(k.replace("_", " ") for k in (fields.get("keywords") or []))
    labels = " ".join(r["label"] for r in records.list_regions(store, asset_id))
    rows = []
    for m in store.memberships_for_asset(asset_id):
        if m["collection_kind"] == "system":
            continue
        notes = " ".join(c["text"] for c in records.list_comments(store, m["id"]))
        rows.append((m["id"], asset_id, _text(fields.get("summary")), keywords, f"{notes} {labels}".strip(),
                     _text(fields.get("subject")), m["collection_name"], m["why"] or ""))
    with store.db.tx() as conn:
        conn.executemany("INSERT INTO search_fts(membership, asset, summary, keywords, notes, subject, "
                         "collection, why) VALUES (?, ?, ?, ?, ?, ?, ?, ?)", rows)


def _terms(query: str) -> list[str]:
    vocab = load_vocabulary()
    out: list[str] = []
    for tok in _TOKEN.findall(query.lower()):
        if len(tok) < 2 or tok in _STOP:
            continue
        for form in vocab.expand(tok):
            if form not in out:
                out.append(form)
    return out


def _passes(filters: Filters, eff: dict, asset: dict, membership: dict, comment_count: int) -> tuple[bool, int]:
    fields = eff["fields"]
    if filters.media and asset["media"] != filters.media:
        return False, 0
    if filters.made_by and asset["made_by"] != filters.made_by:
        return False, 0
    if filters.corrected_only and not eff["corrected_paths"]:
        return False, 0
    if filters.has_comments and comment_count == 0:
        return False, 0
    for name, (lo, hi) in filters.axes.items():
        value = eff_mod.get_path(fields, f"axes.{name}.value")
        if value is None or not (lo <= float(value) <= hi):
            return False, 0
    have = set(fields.get("keywords") or [])
    hits = sum(1 for k in filters.keywords if k in have)
    if filters.keywords and hits == 0:
        return False, 0
    if filters.palette_near:
        target = hex_to_lab(filters.palette_near["hex"])
        palette = fields.get("palette") or []
        if not any(float(delta_e00(hex_to_lab(p["hex"]), target)) <= filters.palette_near["max_delta_e"]
                   for p in palette):
            return False, 0
    return True, hits


def search(store, *, query: str = "", filters: Filters | None = None, brand: str | None = None,
           limit: int = 20, all_scopes: bool = False, include_quarantined: bool = False) -> list[dict]:
    filters = filters or Filters()
    limit = max(1, min(int(limit), 20))
    scope = scope_collection_ids(store, brand, all_scopes=all_scopes)
    if filters.collection:
        scope &= {filters.collection}
    banned = set() if include_quarantined else records.quarantined_asset_ids(store)
    terms = _terms(query)
    if not scope:
        return []
    # Scope is applied in SQL so out-of-scope matches can't crowd in-scope ones out of the candidate cap.
    scope_sql = "m.collection IN (" + ", ".join("?" for _ in scope) + ")"
    scope_args = tuple(sorted(scope))
    with store.db.read() as conn:
        if terms:
            match = " OR ".join('"' + t.replace('"', "") + '"' for t in terms)
            hits = conn.execute(
                "SELECT f.membership, f.asset, f.summary, f.keywords, f.notes, f.subject, f.collection, f.why, "
                "bm25(search_fts, 0, 0, 3.0, 2.0, 1.0, 1.5, 1.0, 1.0) AS rank "
                "FROM search_fts f JOIN memberships m ON m.id = f.membership "
                f"WHERE search_fts MATCH ? AND {scope_sql} ORDER BY rank LIMIT 500",
                (match, *scope_args)).fetchall()
        else:
            hits = conn.execute(
                "SELECT f.membership, f.asset, f.summary, f.keywords, f.notes, f.subject, f.collection, f.why, "
                "0.0 AS rank FROM search_fts f JOIN memberships m ON m.id = f.membership "
                f"WHERE {scope_sql} ORDER BY m.added_at DESC LIMIT 2000", scope_args).fetchall()

    results: dict[str, dict] = {}
    cache: dict[str, dict] = {}
    for hit in hits:
        membership = store.get_membership(hit["membership"])
        if membership is None or membership["collection"] not in scope or hit["asset"] in banned:
            continue
        if filters.role:
            if membership["role"] != filters.role:
                continue
        elif membership["role"] == "avoid":
            continue
        if bool(membership["in_inbox"]) != filters.inbox:
            continue
        asset = store.get_asset(hit["asset"])
        eff = cache.setdefault(hit["asset"], eff_mod.effective(store, hit["asset"]))
        comments = len(records.list_comments(store, membership["id"]))
        ok, kw_hits = _passes(filters, eff, asset, membership, comments)
        if not ok:
            continue
        score = -float(hit["rank"]) + (0.5 if eff["corrected_paths"] else 0.0) + 0.25 * kw_hits
        matched = [col for col in _COLUMNS if terms and any(t in (hit[col] or "").lower() for t in terms)]
        row = {"id": hit["asset"], "membership_id": membership["id"], "collection_id": membership["collection"],
               "collection": hit["collection"], "summary": hit["summary"] or None, "role": membership["role"],
               "media": asset["media"], "made_by": asset["made_by"], "analysis_state": asset["analysis_state"],
               "in_inbox": bool(membership["in_inbox"]), "comment_count": comments, "matched": matched,
               "score": round(score, 4), "blob_key": asset["blob_key"], "also_in": []}
        best = results.get(hit["asset"])
        if best is None:
            results[hit["asset"]] = row
        elif row["score"] > best["score"]:
            row["also_in"] = best["also_in"] + [best["collection"]]
            results[hit["asset"]] = row
        else:
            best["also_in"].append(row["collection"])
    ordered = sorted(results.values(), key=lambda r: (-r["score"], r["id"]))
    return ordered[:limit]
