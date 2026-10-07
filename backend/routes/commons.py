"""/api/commons: the smart moodboard (commons phase 1) API.

Handlers that touch SQLite are plain `def`, so FastAPI runs them in its
threadpool and the event loop never blocks (§9). Every write's actor comes
from `resolve_actor` (§4); response text for agents is wrapped as untrusted.
"""
from __future__ import annotations

import asyncio
import math
import os
import sqlite3
import tempfile
import zipfile
from pathlib import Path
from typing import Any

from fastapi import APIRouter, Depends, File, Form, HTTPException, Request, UploadFile
from fastapi.responses import FileResponse, Response
from pydantic import BaseModel, ConfigDict, Field
from starlette.background import BackgroundTask

from commons import activation
from commons import actors as actors_mod
from commons import evaluation, review, borrow, folders, intake, media, records, runtime, search, untrusted
from commons.effective import effective
from commons.reader import MODEL_ID, PROMPT_VERSION
from commons.store import _BLOB_KEY, CommonsStore

def activation_dep() -> None:
    """Reject before route dependencies can open the store or allocate workers."""
    if not activation.is_enabled():
        raise HTTPException(status_code=404, detail="Commons is disabled")


router = APIRouter(prefix="/api/commons", tags=["commons"],
                   dependencies=[Depends(activation_dep)])

TEXT_KEYS = {"summary", "why", "text", "page_title", "subject", "composition_notes", "note", "label",
             "collection", "name", "reason", "also_in", "collection_name", "original_name"}
ROLES = ("attract", "avoid", "evidence", "neutral")


def store_dep() -> CommonsStore:
    return runtime.get_store()


def actor_dep(request: Request) -> actors_mod.Actor:
    try:
        return actors_mod.resolve_actor(request.headers)
    except actors_mod.AuthError as exc:
        raise HTTPException(status_code=401, detail=str(exc)) from exc


def human_dep(actor: actors_mod.Actor = Depends(actor_dep)) -> actors_mod.Actor:
    if not actor.is_human:
        raise HTTPException(status_code=403, detail="only the human UI session can do this")
    return actor


def json_body(request: Request) -> None:
    ctype = request.headers.get("content-type", "")
    if not ctype.lower().startswith("application/json"):
        raise HTTPException(status_code=415, detail="Content-Type must be application/json")


def multipart_body(request: Request) -> None:
    ctype = request.headers.get("content-type", "")
    if not ctype.lower().startswith("multipart/form-data"):
        raise HTTPException(status_code=415, detail="Content-Type must be multipart/form-data")


def out(actor: actors_mod.Actor, payload: Any) -> Any:
    return payload if actor.is_human else untrusted.wrap_fields(payload, TEXT_KEYS)


def _effective_brand(actor, brand: str | None) -> str | None:
    # Only Nebula-issued workspace bindings carry authority. External clients
    # retain their existing explicit-brand behavior.
    if actor.workspace is not None:
        if brand is not None and brand != actor.brand:
            raise HTTPException(status_code=403, detail="brand conflicts with this agent's session")
        return actor.brand
    return brand


def _scope(store, actor, brand: str | None, all_scopes: bool = False) -> set[str]:
    if all_scopes and not actor.is_human:
        raise HTTPException(status_code=403, detail="all_scopes is only for the UI")
    return search.scope_collection_ids(store, _effective_brand(actor, brand),
                                       all_scopes=all_scopes or actor.is_human)


async def _read_capped(upload: UploadFile) -> bytes:
    """Read an upload without holding more than the largest accepted size (+1 byte) in memory."""
    data = await upload.read(media.VIDEO_CAP + 1)
    if len(data) > media.VIDEO_CAP:
        raise intake.IntakeError("file exceeds the size cap")
    return data


# -- session + status --------------------------------------------------------

def _worker_status() -> dict:
    return runtime.get_worker().status()


@router.get("/status")
def status(store: CommonsStore = Depends(store_dep)) -> dict:
    with store.db.read() as conn:
        counts = {r[0]: r[1] for r in conn.execute(
            "SELECT analysis_state, count(*) FROM assets GROUP BY analysis_state")}
        evaluation_waiting = records.evaluation_open(conn)
        batch = conn.execute("SELECT sealed, closed FROM evaluation_batch WHERE id=1").fetchone()
        evaluation_assisted = conn.execute("SELECT 1 FROM assisted_reviews").fetchone() is not None
    evaluation_state = ("none" if batch is None else "sealed" if batch["sealed"]
                        else "closed" if batch["closed"] else "open")
    return {"evaluation_waiting": evaluation_waiting, "evaluation_state": evaluation_state,
            "evaluation_assisted": evaluation_assisted,
            "worker": _worker_status(), "meter": records.meter_today(store),
            "agent_adds": records.meter_today(store, "agent_add", cap_key="agent_add_daily_cap",
                                              cap_default=intake.AGENT_ADD_DAILY_CAP_DEFAULT),
            "queue": {k: counts.get(k, 0) for k in ("queued", "analyzing", "analysis_failed", "held", "ready")},
            "load": round(os.getloadavg()[0], 1),
            "load_threshold": store.get_setting("load_threshold", SETTING_DEFAULTS["load_threshold"])}


# -- collections ---------------------------------------------------------------

class CollectionIn(BaseModel):
    name: str
    brand: str | None = None


class CollectionPatch(BaseModel):
    name: str | None = None
    brand: str | None = None


@router.get("/collections")
def list_collections(brand: str | None = None, actor=Depends(actor_dep), store=Depends(store_dep)) -> list:
    scope = _scope(store, actor, brand)
    return out(actor, [c for c in store.list_collections() if c["id"] in scope])


@router.post("/collections", dependencies=[Depends(json_body)])
def create_collection(body: CollectionIn, actor=Depends(human_dep), store=Depends(store_dep)) -> dict:
    name = body.name.strip()
    if not name or name.startswith("_"):
        raise HTTPException(status_code=422, detail="a collection needs a name (names starting with _ are reserved)")
    return store.ensure_collection(name, "manual", brand=(body.brand or "").strip() or None, actor=actor.id)


@router.patch("/collections/{collection_id}", dependencies=[Depends(json_body)])
def patch_collection(collection_id: str, body: CollectionPatch, actor=Depends(human_dep),
                     store=Depends(store_dep)) -> dict:
    existing = store.get_collection(collection_id)
    if existing is None or existing["kind"] == "system":
        raise HTTPException(status_code=404, detail="collection not found")
    fields = body.model_dump(exclude_unset=True)
    kwargs: dict[str, Any] = {"name": (fields.get("name") or "").strip() or None}
    if "brand" in fields:
        kwargs["brand"] = (fields["brand"] or "").strip() or None
    try:
        return store.update_collection(collection_id, actor=actor.id, **kwargs)
    except KeyError as exc:
        raise HTTPException(status_code=404, detail="collection not found") from exc


# -- search + detail -------------------------------------------------------------

class SearchIn(BaseModel):
    query: str = ""
    filters: dict | None = None
    brand: str | None = None
    limit: int = 20
    all_scopes: bool = False


@router.post("/search", dependencies=[Depends(json_body)])
def do_search(body: SearchIn, actor=Depends(actor_dep), store=Depends(store_dep)) -> dict:
    if body.all_scopes and not actor.is_human:
        raise HTTPException(status_code=403, detail="all_scopes is only for the UI")
    try:
        filters = search.Filters.from_dict(body.filters)
    except (ValueError, KeyError, TypeError) as exc:
        raise HTTPException(status_code=422, detail=f"bad filters: {exc}") from exc
    rows = search.search(store, query=body.query, filters=filters, brand=_effective_brand(actor, body.brand), limit=body.limit,
                         all_scopes=body.all_scopes)
    return out(actor, {"results": rows})


def _asset_access(store, actor, asset_id: str, brand: str | None):
    """Shared asset visibility gate, including scope and quarantine."""
    asset = store.get_asset(asset_id)
    if asset is None:
        raise HTTPException(status_code=404, detail="asset not found")
    scope = _scope(store, actor, brand)
    memberships = [m for m in store.memberships_for_asset(asset_id) if actor.is_human or m["collection"] in scope]
    quarantined = records.is_quarantined(store, asset_id)
    if not actor.is_human and (not memberships or quarantined):
        raise HTTPException(status_code=404, detail="asset not found")
    return asset, memberships, quarantined


@router.get("/assets/{asset_id}")
def get_asset(asset_id: str, brand: str | None = None, fields: str | None = None, actor=Depends(actor_dep),
              store=Depends(store_dep)) -> dict:
    asset, memberships, quarantined = _asset_access(store, actor, asset_id, brand)
    eff = effective(store, asset_id)
    eff["analysis"] = {k: v for k, v in (eff["analysis"] or {}).items() if k != "raw_output"} or None
    if fields:
        wanted = {f.strip() for f in fields.split(",") if f.strip()}
        eff["fields"] = {k: v for k, v in eff["fields"].items() if k in wanted}
    detail = {
        "asset": asset, "effective": eff, "corrections": records.list_corrections(store, asset_id),
        "regions": records.list_regions(store, asset_id, include_deleted=actor.is_human),
        "memberships": [{**m, "sightings": store.list_sightings(m["id"]),
                         "comments": records.list_comments(store, m["id"])} for m in memberships],
        "borrowings": borrow.list_borrowings(store, asset_id=asset_id),
        # No on-disk path, for anyone: agents fetch pixels through the gated
        # blob route, and the UI already uses blob_url.
        "blob_url": f"/api/commons/blobs/{asset['blob_key']}",
    }
    if asset["media"] == "video":
        detail["keyframes"] = _keyframes(store, asset)
    if actor.is_human:
        detail["quarantined"] = quarantined
        return detail
    if actor.workspace is not None:
        visible_memberships = {m["id"] for m in memberships}
        detail["borrowings"] = [b for b in detail["borrowings"] if b["membership"] in visible_memberships]
    for m in detail["memberships"]:
        for s in m["sightings"]:
            s.pop("original_path", None)  # §12: folder layout stays local to the user
    wrapped = out(actor, detail)
    # A membership's `collection` is an id the agent passes back (add, comment); only names are text.
    for raw, shown in zip(detail["memberships"], wrapped["memberships"]):
        shown["collection"] = raw["collection"]
    return wrapped


def _keyframes(store: CommonsStore, asset: dict) -> list[dict]:
    """A video's keyframe children in time order, each with the URL of its PNG blob."""
    frames = []
    for f in (asset.get("measurements") or {}).get("keyframes") or []:
        child = store.get_asset(f["asset_id"])
        if child is None:
            continue
        frames.append({"t": f["t"], "asset_id": child["id"], "blob_url": f"/api/commons/blobs/{child['blob_key']}"})
    return sorted(frames, key=lambda f: f["t"])


@router.get("/blobs/{blob_key}")
def get_blob(blob_key: str, brand: str | None = None, actor=Depends(actor_dep),
             store=Depends(store_dep)) -> FileResponse:
    brand = _effective_brand(actor, brand)
    try:
        path = store.blob_path(blob_key)
    except ValueError as exc:
        raise HTTPException(status_code=404, detail="not found") from exc
    if not actor.is_human:
        asset = store.asset_by_sha(blob_key.split(".", 1)[0])
        if asset is None or asset["blob_key"] != blob_key or records.is_quarantined(store, asset["id"]):
            raise HTTPException(status_code=404, detail="not found")
        # A keyframe inherits its parent's memberships; the parent must itself
        # pass the same gate as GET /assets/{id}, including quarantine.
        try:
            _asset_access(store, actor, asset.get("parent_asset") or asset["id"], brand)
        except HTTPException as exc:
            raise HTTPException(status_code=404, detail="not found") from exc
    if not path.is_file():
        raise HTTPException(status_code=404, detail="not found")
    return FileResponse(path)


# -- intake ------------------------------------------------------------------------

def _check_role(role: str) -> str:
    if role not in ROLES:
        raise HTTPException(status_code=422, detail=f"role must be one of {', '.join(ROLES)}")
    return role


@router.post("/intake/files", dependencies=[Depends(multipart_body)])
async def intake_files(collection_id: str = Form(...), role: str = Form("neutral"), why: str | None = Form(None),
                       files: list[UploadFile] = File(...), actor=Depends(human_dep),
                       store=Depends(store_dep)) -> dict:
    _check_role(role)
    results = []
    for upload in files:
        try:
            data = await _read_capped(upload)
            res = await asyncio.to_thread(
                intake.add_bytes, store, data, filename=upload.filename or "upload", collection_id=collection_id,
                actor=actor.id, role=role, why=(why or "").strip() or None,
                source={"kind": "file", "original_name": upload.filename})
            results.append({"filename": upload.filename, "ok": True, "asset_id": res.asset["id"],
                            "membership_id": res.membership["id"]})
        except intake.IntakeError as exc:
            results.append({"filename": upload.filename, "ok": False, "error": str(exc)})
    return {"results": results}


class UrlIn(BaseModel):
    url: str
    collection_id: str
    role: str = "neutral"
    why: str | None = None
    page_url: str | None = None
    page_title: str | None = None


@router.post("/intake/url", dependencies=[Depends(json_body)])
async def intake_url(body: UrlIn, actor=Depends(human_dep), store=Depends(store_dep)) -> dict:
    _check_role(body.role)
    try:
        res = await intake.add_url(store, body.url, collection_id=body.collection_id, actor=actor.id,
                                   role=body.role, why=body.why, page_url=body.page_url, page_title=body.page_title)
    except intake.IntakeError as exc:
        raise HTTPException(status_code=422, detail=str(exc)) from exc
    if isinstance(res, dict):
        return res
    return {"kind": "asset", "asset_id": res.asset["id"], "membership_id": res.membership["id"]}


@router.post("/intake/moodboards")
async def intake_moodboards(actor=Depends(human_dep), store=Depends(store_dep)) -> dict:
    return await asyncio.to_thread(intake.import_moodboards, store)


class AgentAddIn(BaseModel):
    source: str
    collection: str
    why: str
    made_by: str = "unknown"


def _check_made_by(made_by: str) -> str:
    if made_by not in ("human", "ai", "unknown"):
        raise HTTPException(status_code=422, detail="made_by must be human, ai or unknown")
    return made_by


def _added(res) -> dict:
    return {"asset_id": res.asset["id"], "membership_id": res.membership["id"],
            "in_inbox": bool(res.membership["in_inbox"]), "analysis_state": res.asset["analysis_state"]}


@router.post("/add", dependencies=[Depends(json_body)])
async def agent_add(body: AgentAddIn, actor=Depends(actor_dep), store=Depends(store_dep)) -> dict:
    _check_made_by(body.made_by)
    try:
        res = await intake.agent_add(store, actor=actor, source=body.source, collection_id=body.collection,
                                     why=body.why, made_by=body.made_by)
    except intake.PathNotAllowed as exc:
        raise HTTPException(status_code=403, detail=str(exc)) from exc
    except intake.IntakeError as exc:
        raise HTTPException(status_code=422, detail=str(exc)) from exc
    if isinstance(res, dict):
        raise HTTPException(status_code=422, detail="that URL is a page; add one of its images instead")
    return _added(res)


@router.post("/add/upload", dependencies=[Depends(multipart_body)])
async def agent_add_upload(collection: str = Form(...), why: str = Form(...), made_by: str = Form("unknown"),
                           file: UploadFile = File(...), actor=Depends(actor_dep), store=Depends(store_dep)) -> dict:
    _check_made_by(made_by)
    try:
        # Check scope before consuming uploaded pixels or charging intake work.
        intake._check_agent_target(store, actor, collection, why)
        data = await _read_capped(file)
        res = await asyncio.to_thread(intake.agent_add_bytes, store, actor=actor, data=data,
                                      filename=file.filename or "upload", collection_id=collection, why=why,
                                      made_by=made_by)
    except intake.PathNotAllowed as exc:
        raise HTTPException(status_code=403, detail=str(exc)) from exc
    except intake.IntakeError as exc:
        raise HTTPException(status_code=422, detail=str(exc)) from exc
    return _added(res)


# -- folders ---------------------------------------------------------------------

class FolderIn(BaseModel):
    path: str
    ignores: list[str] | None = None


class FolderPatch(BaseModel):
    ignores: list[str]


@router.get("/folders")
def list_folders(actor=Depends(human_dep), store=Depends(store_dep)) -> list:
    return [{**link, "device_states": store.device_states(link["id"])} for link in store.list_folder_links()]


@router.post("/folders", status_code=202, dependencies=[Depends(json_body)])
async def link_folder(body: FolderIn, actor=Depends(human_dep), store=Depends(store_dep)) -> dict:
    try:
        link = await asyncio.to_thread(folders.link_folder, store, body.path, actor=actor.id, ignores=body.ignores)
    except ValueError as exc:
        raise HTTPException(status_code=422, detail=str(exc)) from exc
    runtime.spawn(folders.scan_and_fetch(store, link["id"], downloader=runtime.get_downloader()))
    return link


@router.patch("/folders/{link_id}", dependencies=[Depends(json_body)])
def patch_folder(link_id: str, body: FolderPatch, actor=Depends(human_dep), store=Depends(store_dep)) -> dict:
    if store.get_folder_link(link_id) is None:
        raise HTTPException(status_code=404, detail="folder not linked")
    return store.update_folder_ignores(link_id, body.ignores, actor=actor.id)


@router.post("/folders/{link_id}/rescan", status_code=202)
async def rescan(link_id: str, actor=Depends(human_dep), store=Depends(store_dep)) -> dict:
    if store.get_folder_link(link_id) is None:
        raise HTTPException(status_code=404, detail="folder not linked")
    runtime.spawn(folders.scan_and_fetch(store, link_id, downloader=runtime.get_downloader()))
    return {"status": "scanning"}


# -- human edits -----------------------------------------------------------------

class MembershipPatch(BaseModel):
    role: str | None = None
    why: str | None = None


@router.patch("/memberships/{membership_id}", dependencies=[Depends(json_body)])
def patch_membership(membership_id: str, body: MembershipPatch, actor=Depends(human_dep),
                     store=Depends(store_dep)) -> dict:
    m = store.get_membership(membership_id)
    if m is None:
        raise HTTPException(status_code=404, detail="membership not found")
    changes = body.model_dump(exclude_unset=True)
    if "role" in changes:
        _check_role(changes["role"] or "")
    if "why" in changes:
        changes["why"] = (changes["why"] or "").strip() or None
    updated = store.update_membership(membership_id, actor=actor.id, **changes)
    search.reindex_asset(store, m["asset"])  # role, why feed the index (Task 10 note)
    return updated


@router.post("/memberships/{membership_id}/accept")
def accept_membership(membership_id: str, actor=Depends(human_dep), store=Depends(store_dep)) -> dict:
    try:
        m = store.accept_membership(membership_id, actor=actor.id)
    except KeyError as exc:
        raise HTTPException(status_code=404, detail="membership not found") from exc
    search.reindex_asset(store, m["asset"])
    return m


class CorrectionIn(BaseModel):
    field_path: str
    op: str
    value: Any
    reason: str | None = None


@router.post("/assets/{asset_id}/corrections", dependencies=[Depends(json_body)])
def add_correction(asset_id: str, body: CorrectionIn, actor=Depends(human_dep), store=Depends(store_dep)) -> dict:
    if store.get_asset(asset_id) is None:
        raise HTTPException(status_code=404, detail="asset not found")
    try:
        return records.add_correction(store, asset_id, field_path=body.field_path, op=body.op, value=body.value,
                                      actor=actor.id, reason=body.reason)
    except ValueError as exc:
        raise HTTPException(status_code=422, detail=str(exc)) from exc


class RegionIn(BaseModel):
    box: list[float]
    label: str


class RegionPatch(BaseModel):
    label: str | None = None
    note: str | None = None
    status: str | None = None
    box: list[float] | None = None


@router.post("/assets/{asset_id}/regions", dependencies=[Depends(json_body)])
def add_region(asset_id: str, body: RegionIn, actor=Depends(human_dep), store=Depends(store_dep)) -> dict:
    if store.get_asset(asset_id) is None:
        raise HTTPException(status_code=404, detail="asset not found")
    try:
        return records.add_region(store, asset_id, box=body.box, label=body.label, actor=actor.id)
    except ValueError as exc:
        raise HTTPException(status_code=422, detail=str(exc)) from exc


@router.patch("/regions/{region_id}", dependencies=[Depends(json_body)])
def patch_region(region_id: str, body: RegionPatch, actor=Depends(human_dep), store=Depends(store_dep)) -> dict:
    try:
        return records.update_region(store, region_id, actor=actor.id, **body.model_dump(exclude_unset=True))
    except KeyError as exc:
        raise HTTPException(status_code=404, detail="region not found") from exc
    except ValueError as exc:
        raise HTTPException(status_code=422, detail=str(exc)) from exc


@router.post("/assets/{asset_id}/reanalyze")
def reanalyze(asset_id: str, actor=Depends(human_dep), store=Depends(store_dep)) -> dict:
    if store.get_asset(asset_id) is None:
        raise HTTPException(status_code=404, detail="asset not found")
    records.requeue(store, asset_id, actor=actor.id)
    return {"queued": True}


class StaleIn(BaseModel):
    collection_id: str | None = None


@router.post("/reanalyze-stale", dependencies=[Depends(json_body)])
def reanalyze_stale(body: StaleIn, actor=Depends(human_dep), store=Depends(store_dep)) -> dict:
    ids = records.stale_asset_ids(store, prompt_version=PROMPT_VERSION, model_id=MODEL_ID,
                                  collection_id=body.collection_id)
    for asset_id in ids:
        records.requeue(store, asset_id, actor=actor.id)
    return {"queued": len(ids)}


@router.delete("/assets/{asset_id}")
def purge(asset_id: str, actor=Depends(human_dep), store=Depends(store_dep)) -> dict:
    if store.get_asset(asset_id) is None:
        raise HTTPException(status_code=404, detail="asset not found")
    store.delete_asset(asset_id, actor=actor.id)
    return {"purged": asset_id}


# -- comments + borrowing -------------------------------------------------------

class CommentIn(BaseModel):
    asset_id: str
    text: str
    region_id: str | None = None
    membership_id: str | None = None
    brand: str | None = None


@router.post("/comments", dependencies=[Depends(json_body)])
def comment(body: CommentIn, actor=Depends(actor_dep), store=Depends(store_dep)) -> dict:
    scope = _scope(store, actor, body.brand)
    candidates = [m for m in store.memberships_for_asset(body.asset_id) if m["collection"] in scope]
    if body.membership_id:
        candidates = [m for m in candidates if m["id"] == body.membership_id]
    if not candidates or (not actor.is_human and records.is_quarantined(store, body.asset_id)):
        raise HTTPException(status_code=404, detail="asset not found in this scope")
    try:
        return out(actor, records.add_comment(store, candidates[0]["id"], text=body.text, actor=actor.id,
                                              region_id=body.region_id))
    except ValueError as exc:
        raise HTTPException(status_code=422, detail=str(exc)) from exc


class BorrowIn(BaseModel):
    id: str
    attribute: str
    value: Any
    used_in: dict
    why: str
    region_id: str | None = None
    brand: str | None = None


def _borrowing_out(actor, rows: Any) -> Any:
    """Borrowed text attributes (summary, subject, ...) carry commons text in `value`."""
    if actor.is_human:
        return rows
    single = isinstance(rows, dict)
    shown = []
    for row in [rows] if single else rows:
        row = untrusted.wrap_fields(row, TEXT_KEYS)
        if row.get("attribute") in borrow.TEXT_ATTRS | {"region"}:
            row["value"] = untrusted.wrap_fields({"v": row["value"]}, {"v"})["v"]
        shown.append(row)
    return shown[0] if single else shown


@router.post("/borrow", dependencies=[Depends(json_body)])
def do_borrow(body: BorrowIn, actor=Depends(actor_dep), store=Depends(store_dep)) -> dict:
    try:
        return _borrowing_out(actor, borrow.record_borrow(
            store, actor_id=actor.id, asset_id=body.id, attribute=body.attribute, value=body.value,
            region_id=body.region_id, used_in=body.used_in, why=body.why,
            scope_ids=_scope(store, actor, body.brand), hide_quarantined=not actor.is_human))
    except borrow.BorrowRejected as exc:
        raise HTTPException(status_code=422, detail=exc.reason) from exc


@router.get("/borrowings")
def borrowings(asset: str | None = None, brand: str | None = None, actor=Depends(actor_dep),
               store=Depends(store_dep)) -> list:
    rows = borrow.list_borrowings(store, asset_id=asset)
    if not actor.is_human:
        scope = _scope(store, actor, brand)
        rows = [r for r in rows if (store.get_membership(r["membership"]) or {}).get("collection") in scope]
    return _borrowing_out(actor, rows)


@router.post("/borrowings/{borrowing_id}/fidelity")
def fidelity(borrowing_id: str, brand: str | None = None, actor=Depends(actor_dep),
             store=Depends(store_dep)) -> dict:
    try:
        b = borrow.get_borrowing(store, borrowing_id)
        if not actor.is_human:
            # Same brand scope as GET /borrowings: another brand's borrowing looks like it doesn't exist.
            if (store.get_membership(b["membership"]) or {}).get("collection") not in _scope(store, actor, brand):
                raise KeyError(borrowing_id)
        return out(actor, borrow.run_fidelity(store, borrowing_id))
    except KeyError as exc:
        raise HTTPException(status_code=404, detail="borrowing not found") from exc


@router.get("/concentration")
def concentration(actor=Depends(actor_dep), store=Depends(store_dep)) -> dict:
    if actor.workspace is not None:
        from collections import Counter
        scope = _scope(store, actor, None)
        counts = Counter(row["asset"] for row in borrow.list_borrowings(store)
                         if (store.get_membership(row["membership"]) or {}).get("collection") in scope)
        total = sum(counts.values())
        shares = {asset: round(count / total, 4) for asset, count in counts.items()} if total else {}
        return {"total": total, "by_asset": shares, "threshold": borrow.CONCENTRATION_THRESHOLD,
                "flagged": sorted(asset for asset, share in shares.items() if share > borrow.CONCENTRATION_THRESHOLD)}
    return out(actor, borrow.concentration(store))


# -- settings, vocabulary, worker, export ---------------------------------------

SETTING_DEFAULTS = {"daily_cap": records.DEFAULT_DAILY_CAP, "agent_add_daily_cap": intake.AGENT_ADD_DAILY_CAP_DEFAULT,
                    "brand_inherits": search.DEFAULT_BRAND_INHERITS,
                    "load_threshold": max(32, 4 * (os.cpu_count() or 8))}


def _valid_setting(key: str, value: Any) -> bool:
    if key in ("daily_cap", "agent_add_daily_cap"):
        return isinstance(value, int) and not isinstance(value, bool) and 0 <= value <= 10_000
    if key == "load_threshold":
        return (isinstance(value, (int, float)) and not isinstance(value, bool) and math.isfinite(value)
                and value > 0)
    if key == "brand_inherits":
        return isinstance(value, dict) and all(
            isinstance(k, str) and isinstance(v, list) and all(isinstance(x, str) for x in v)
            for k, v in value.items())
    return False


def _settings(store) -> dict:
    return {k: store.get_setting(k, v) for k, v in SETTING_DEFAULTS.items()}


@router.get("/settings")
def get_settings(actor=Depends(human_dep), store=Depends(store_dep)) -> dict:
    return _settings(store)


@router.patch("/settings", dependencies=[Depends(json_body)])
async def patch_settings(request: Request, actor=Depends(human_dep), store=Depends(store_dep)) -> dict:
    body = await request.json()
    if not isinstance(body, dict):
        raise HTTPException(status_code=422, detail="expected an object of settings")
    for key, value in body.items():
        if key not in SETTING_DEFAULTS:
            raise HTTPException(status_code=422, detail=f"unknown setting {key}")
        if not _valid_setting(key, value):
            raise HTTPException(status_code=422, detail=f"bad value for {key}")
    for key, value in body.items():
        await asyncio.to_thread(store.set_setting, key, value)
    return await asyncio.to_thread(_settings, store)


@router.get("/vocabulary/candidates")
def vocab_candidates(actor=Depends(human_dep), store=Depends(store_dep)) -> list:
    with store.db.read() as conn:
        rows = conn.execute("SELECT term, count(*) AS n, group_concat(asset) AS assets FROM vocab_candidates "
                            "GROUP BY term ORDER BY n DESC, term").fetchall()
    return [{"term": r["term"], "count": r["n"], "assets": (r["assets"] or "").split(",")} for r in rows]


@router.post("/worker/start")
async def worker_start(actor=Depends(human_dep)) -> dict:
    worker = runtime.get_worker()
    worker.start()
    return worker.status()


@router.post("/worker/stop")
async def worker_stop(actor=Depends(human_dep)) -> dict:
    worker = runtime.get_worker()
    await worker.stop()
    return worker.status()


def _build_export(store) -> Path:
    """Write the export zip to a temp file (blobs can be large; nothing is held in memory)."""
    tmp = Path(tempfile.mkdtemp(prefix="commons-export-"))
    snapshot = tmp / "commons.db"
    dest = sqlite3.connect(snapshot)
    try:
        with store.db.read() as conn:
            conn.backup(dest)
    finally:
        dest.close()
    archive = tmp / "commons-export.zip"
    with zipfile.ZipFile(archive, "w", zipfile.ZIP_DEFLATED) as zf:
        zf.write(snapshot, "commons.db")
        for blob in sorted(store.blobs.iterdir()):
            if _BLOB_KEY.fullmatch(blob.name) and blob.is_file():
                zf.write(blob, f"blobs/{blob.name}", compress_type=zipfile.ZIP_STORED)
    snapshot.unlink()
    return archive


def _cleanup(path: Path) -> None:
    path.unlink(missing_ok=True)
    try:
        path.parent.rmdir()
    except OSError:
        pass


@router.get("/export")
def export(actor=Depends(human_dep), store=Depends(store_dep)) -> FileResponse:
    archive = _build_export(store)
    return FileResponse(archive, media_type="application/zip", filename="commons-export.zip",
                        background=BackgroundTask(_cleanup, archive))

# -- blind C1/C2 labeling: human session only, never exposed to agents ----------


class EvaluationPrepareIn(BaseModel):
    model_config = ConfigDict(extra='forbid')
    path: str = Field(min_length=1, max_length=4096)


class EvaluationRevisionIn(BaseModel):
    model_config = ConfigDict(extra='forbid')
    revision: int = Field(ge=0, strict=True)


class EvaluationAccentsIn(EvaluationRevisionIn):
    points: list[dict] = Field(max_length=100)
    no_accents: bool = Field(strict=True)


class EvaluationLabelsIn(EvaluationRevisionIn):
    labels: dict


def _eval_call(fn, *args, **kwargs):
    try:
        return fn(*args, **kwargs)
    except evaluation.EvaluationError as exc:
        raise HTTPException(status_code=409, detail=str(exc)) from exc


@router.get('/evaluation')
def evaluation_view(response: Response, actor=Depends(human_dep), store=Depends(store_dep)):
    response.headers['Cache-Control'] = 'no-store'
    return evaluation.view(store)


@router.post('/evaluation/prepare', dependencies=[Depends(json_body)])
async def evaluation_prepare(body: EvaluationPrepareIn, response: Response,
                             actor=Depends(human_dep), store=Depends(store_dep)):
    response.headers['Cache-Control'] = 'no-store'
    try:
        return await evaluation.prepare(store, body.path, downloader=runtime.get_downloader())
    except (evaluation.EvaluationError, OSError) as exc:
        raise HTTPException(status_code=409, detail=str(exc)) from exc


@router.get('/evaluation/items/{position}/image')
def evaluation_image(position: int, actor=Depends(human_dep), store=Depends(store_dep)):
    return Response(_eval_call(evaluation.image_bytes, store, position), media_type='image/png',
                    headers={'Cache-Control':'no-store', 'X-Content-Type-Options':'nosniff'})


@router.post('/evaluation/items/{position}/accents', dependencies=[Depends(json_body)])
def evaluation_accents(position: int, body: EvaluationAccentsIn, response: Response,
                       actor=Depends(human_dep), store=Depends(store_dep)):
    response.headers['Cache-Control'] = 'no-store'
    return _eval_call(evaluation.lock_accents, store, position, body.revision, body.points, body.no_accents)


@router.put('/evaluation/items/{position}/labels', dependencies=[Depends(json_body)])
def evaluation_labels(position: int, body: EvaluationLabelsIn, response: Response,
                      actor=Depends(human_dep), store=Depends(store_dep)):
    response.headers['Cache-Control'] = 'no-store'
    return _eval_call(evaluation.save_labels, store, position, body.revision, body.labels)


@router.post('/evaluation/seal', dependencies=[Depends(json_body)])
def evaluation_seal(body: EvaluationRevisionIn, response: Response, actor=Depends(human_dep), store=Depends(store_dep)):
    response.headers['Cache-Control'] = 'no-store'
    return _eval_call(evaluation.seal, store, body.revision)


class EvaluationCloseIn(EvaluationRevisionIn):
    acknowledge_not_blind: bool = Field(strict=True)


@router.post('/evaluation/close', dependencies=[Depends(json_body)])
def evaluation_close(body: EvaluationCloseIn, response: Response, actor=Depends(human_dep), store=Depends(store_dep)):
    """Close the held-out batch as assisted review (never blind truth); releases the analysis gate."""
    response.headers['Cache-Control'] = 'no-store'
    return _eval_call(evaluation.close, store, body.revision, actor=actor.id, acknowledge=body.acknowledge_not_blind)


@router.get('/review')
def review_view(response: Response, actor=Depends(human_dep), store=Depends(store_dep)):
    response.headers['Cache-Control'] = 'no-store'
    return review.view(store)


@router.post('/review/items/{position}/propose', dependencies=[Depends(json_body)])
async def review_propose(position: int, response: Response, actor=Depends(human_dep), store=Depends(store_dep)):
    response.headers['Cache-Control'] = 'no-store'
    try:
        return await review.propose(store, position)
    except evaluation.EvaluationError as exc:
        raise HTTPException(status_code=409, detail=str(exc)) from exc


@router.put('/review/items/{position}', dependencies=[Depends(json_body)])
def review_accept(position: int, body: EvaluationLabelsIn, response: Response, actor=Depends(human_dep), store=Depends(store_dep)):
    response.headers['Cache-Control'] = 'no-store'
    return _eval_call(review.accept, store, position, body.revision, body.labels)
