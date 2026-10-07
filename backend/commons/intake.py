"""Every way in ends here (§5): hash the bytes into an asset once, then add
a membership (role, why, adder) and a sighting (where it was seen)."""
from __future__ import annotations

import asyncio
import hashlib
import json
from dataclasses import dataclass
from pathlib import Path
from typing import Any, Callable
from urllib.parse import unquote, urlsplit

from commons import media, net
from commons import page as page_mod
from commons.db import now_iso
from commons.measure import CODE_VERSION, measure_image, phash
from commons.store import CommonsStore


class IntakeError(Exception):
    pass


@dataclass
class IntakeResult:
    asset: dict
    membership: dict
    sighting: dict
    created_asset: bool
    created_membership: bool


_SOURCE_FIELDS = ("url", "page_url", "page_title", "original_path", "original_name", "folder_link",
                  "rel_path", "file_id", "size", "mtime", "source_date", "fetched_at")


def _image_columns(data: bytes, sniffed: media.Sniffed) -> dict[str, Any]:
    img = media.load_image(data, sniffed.mime)
    return {"media": "image", "mime": sniffed.mime, "width": img.width, "height": img.height,
            "phash": phash(img), "measurements": measure_image(img), "code_version": CODE_VERSION}


def _add_keyframes(store: CommonsStore, video_path: Path, parent_id: str, info: dict,
                   made_by: str) -> tuple[list[dict], float]:
    cuts = media.scene_cuts(video_path)
    frames = []
    for t in media.keyframe_times(info["duration"], cuts):
        png = media.extract_frame(video_path, t)
        sha, key = store.put_blob(png, "png")
        cols = _image_columns(png, media.Sniffed("image", "image/png", "png"))
        with store.db.tx() as conn:
            row = conn.execute("SELECT * FROM assets WHERE sha256 = ?", (sha,)).fetchone()
            if row is None:
                child = store.insert_asset(conn, sha256=sha, blob_key=key, parent_asset=parent_id,
                                           keyframe_t=t, made_by=made_by, analysis_state="queued", **cols)
            else:
                child = dict(row)
        frames.append({"t": t, "asset_id": child["id"]})
    minutes = info["duration"] / 60.0 if info["duration"] else 0.0
    return frames, (round(len(cuts) / minutes, 2) if minutes else 0.0)


def add_bytes(store: CommonsStore, data: bytes, *, filename: str, collection_id: str, actor: str,
              source: dict, role: str = "neutral", why: str | None = None, made_by: str = "unknown",
              in_inbox: bool = False, analysis_state: str | None = None) -> IntakeResult:
    try:
        sniffed = media.sniff(data)
        media.check_size(sniffed.media, len(data))
    except media.MediaError as exc:
        raise IntakeError(str(exc)) from exc
    if store.get_collection(collection_id) is None:
        raise IntakeError(f"unknown collection {collection_id}")

    existing = store.asset_by_sha(hashlib.sha256(data).hexdigest())
    columns: dict[str, Any] | None = None
    video_path: Path | None = None
    if existing is None:
        try:
            if sniffed.media == "image":
                columns = _image_columns(data, sniffed)
            else:
                columns = {"media": "video", "mime": sniffed.mime}
        except media.MediaError as exc:
            raise IntakeError(str(exc)) from exc

    # A blob write failure raises here, before any row exists (§10).
    sha, key = store.put_blob(data, sniffed.ext)

    created_asset = False
    with store.db.tx() as conn:
        row = conn.execute("SELECT * FROM assets WHERE sha256 = ?", (sha,)).fetchone()
        if row is None:
            state = analysis_state or ("ready" if sniffed.media == "video" else "queued")
            asset = store.insert_asset(conn, sha256=sha, blob_key=key, made_by=made_by,
                                       analysis_state=state, **columns)
            store.emit(conn, "asset_added", {"asset": asset["id"], "media": asset["media"]}, actor)
            created_asset = True
        else:
            asset = dict(row)
        membership, created_membership = store.insert_membership(
            conn, asset=asset["id"], collection=collection_id, actor=actor, role=role, why=why,
            in_inbox=in_inbox)
        fields = {k: source.get(k) for k in _SOURCE_FIELDS if source.get(k) is not None}
        fields.setdefault("original_name", filename)
        sighting = store.insert_sighting(conn, membership=membership["id"],
                                         source_kind=source.get("kind", "file"), **fields)

    if created_asset and sniffed.media == "video":
        video_path = store.blob_path(key)
        try:
            info = media.probe_video(video_path)
            frames, cuts_per_min = _add_keyframes(store, video_path, asset["id"], info, made_by)
            measurements = {**info, "cuts_per_min": cuts_per_min, "keyframes": frames,
                            "code_version": CODE_VERSION}
            with store.db.tx() as conn:
                conn.execute("UPDATE assets SET measurements = ?, width = ?, height = ?, duration = ?, "
                             "code_version = ? WHERE id = ?",
                             (json.dumps(measurements), info["width"], info["height"],
                              info["duration"], CODE_VERSION, asset["id"]))
        except media.MediaError as exc:
            with store.db.tx() as conn:
                conn.execute("UPDATE assets SET analysis_state = 'analysis_failed', last_error = ? "
                             "WHERE id = ?", (f"video probe failed: {exc}", asset["id"]))

    from commons import search  # local import: search -> records -> measure; keeps intake import-light

    search.reindex_asset(store, asset["id"])
    return IntakeResult(store.get_asset(asset["id"]), store.get_membership(membership["id"]),
                        sighting, created_asset, created_membership)


async def add_url(store, url: str, *, collection_id: str, actor: str, role: str = "neutral",
                  why: str | None = None, page_url: str | None = None, page_title: str | None = None,
                  in_inbox: bool = False, made_by: str = "unknown", fetch=net.safe_fetch,
                  state_for: Callable[[bytes], str | None] | None = None):
    """Fetch a URL through the SSRF gate (§3.2, §5.3).

    A media URL becomes an asset; an HTML page returns its candidate images
    (with probed sizes for the first 12) for the caller to choose from.

    `state_for(data)` picks the new asset's initial analysis_state before the
    row exists, so an agent add past its daily cap is created `held` rather
    than created `queued` and flipped (the worker could claim it in between)."""
    try:
        fetched = await fetch(url, max_bytes=media.VIDEO_CAP, accept="image/*,video/*,text/html;q=0.8")
    except (net.FetchBlocked, net.FetchError) as exc:
        raise IntakeError(f"cannot fetch {url}: {exc}") from exc
    ctype = fetched.content_type.split(";")[0].strip().lower()
    if ctype in ("text/html", "application/xhtml+xml"):
        info = page_mod.parse_page(fetched.data[:2_000_000].decode("utf-8", errors="replace"), fetched.final_url)
        candidates = []
        for cand in info.candidates[:12]:
            size = await page_mod.probe_dimensions(cand, fetch=fetch)
            candidates.append({"url": cand, "width": size[0] if size else None,
                               "height": size[1] if size else None})
        candidates += [{"url": c, "width": None, "height": None} for c in info.candidates[12:]]
        return {"kind": "page", "page_url": fetched.final_url, "page_title": info.title, "candidates": candidates}

    def _store() -> IntakeResult:
        return add_bytes(
            store, fetched.data, filename=url.rsplit("/", 1)[-1][:200] or "download",
            collection_id=collection_id, actor=actor, role=role, why=why, made_by=made_by, in_inbox=in_inbox,
            analysis_state=state_for(fetched.data) if state_for else None,
            source={"kind": "url", "url": url, "page_url": page_url, "page_title": page_title,
                    "fetched_at": now_iso()},
        )

    return await asyncio.to_thread(_store)


# -- moodboard import (§5.5) and agent adds (§5.6, §3.2) -----------------------

AGENT_ADD_DAILY_CAP_DEFAULT = 20
MOODBOARD_ACTOR = "import:moodboard"


class PathNotAllowed(IntakeError):
    pass


def _output_path(url: str) -> Path | None:
    from services.output import _resolve_output_root

    root = _resolve_output_root().resolve()
    rel = unquote(urlsplit(url).path[len("/api/outputs/"):])
    candidate = (root / rel).resolve()
    if not candidate.is_relative_to(root) or not candidate.is_file():
        return None
    return candidate


def _moodboards() -> list[dict]:
    from services.moodboard_store import MoodboardStore, _moodboard_root

    mb = MoodboardStore()
    boards = list(mb.list(scope="global"))
    root = _moodboard_root()
    if root.exists():
        for sub in sorted(root.iterdir()):
            if sub.is_dir() and sub.name != "_global":
                try:
                    boards.extend(mb.list(scope="project", projectId=sub.name))
                except ValueError:
                    continue
    return boards


def _imported_membership(store, collection_id: str, url: str) -> dict | None:
    """The membership a previous import already made for this moodboard image."""
    with store.db.read() as conn:
        row = conn.execute(
            "SELECT m.* FROM sightings s JOIN memberships m ON m.id = s.membership "
            "WHERE m.collection = ? AND s.source_kind = 'moodboard' AND s.url = ? LIMIT 1",
            (collection_id, url)).fetchone()
    return dict(row) if row else None


def import_moodboards(store, *, fetch=None) -> dict:
    """Idempotent: an image a previous run imported into the board's collection
    is neither re-read, re-fetched nor re-sighted. Calls asyncio.run for remote
    URLs, so it must run in a worker thread, never on the event loop."""
    from commons import records

    fetch = fetch or net.safe_fetch
    summary: dict[str, Any] = {"collections": 0, "added": 0, "skipped": [], "comments": 0}
    for board in _moodboards():
        collection = store.ensure_collection(board.get("name") or board["id"], "moodboard",
                                             source_ref=board["id"], actor=MOODBOARD_ACTOR)
        summary["collections"] += 1
        memberships = []
        for image in board.get("images") or []:
            url = str(image.get("url") or "")
            previous = _imported_membership(store, collection["id"], url) if url else None
            if previous is not None:
                memberships.append(previous)
                continue
            source = {"kind": "moodboard", "url": url, "source_date": board.get("createdAt")}
            try:
                if url.startswith("/api/outputs/"):
                    path = _output_path(url)
                    if path is None:
                        summary["skipped"].append({"url": url, "reason": "output file missing"})
                        continue
                    made_by = "unknown" if url.startswith("/api/outputs/chat-uploads/") else "ai"
                    res = add_bytes(store, path.read_bytes(), filename=path.name, collection_id=collection["id"],
                                    actor=MOODBOARD_ACTOR, source=source, made_by=made_by)
                elif url.startswith(("http://", "https://")):
                    fetched = asyncio.run(fetch(url, max_bytes=media.IMAGE_CAP, accept="image/*"))
                    res = add_bytes(store, fetched.data, filename=url.rsplit("/", 1)[-1][:200] or "image",
                                    collection_id=collection["id"], actor=MOODBOARD_ACTOR,
                                    source={**source, "fetched_at": now_iso()})
                else:
                    summary["skipped"].append({"url": url, "reason": "unsupported url"})
                    continue
            except (IntakeError, net.FetchBlocked, net.FetchError, OSError) as exc:
                summary["skipped"].append({"url": url, "reason": str(exc)})
                continue
            memberships.append(res.membership)
            if res.created_membership:
                summary["added"] += 1
        notes = str(board.get("notes") or "").strip()
        if notes and memberships:
            target = memberships[0]["id"]
            already = any(c["actor"] == MOODBOARD_ACTOR and c["text"] == notes
                          for c in records.list_comments(store, target))
            if not already:
                records.add_comment(store, target, text=notes, actor=MOODBOARD_ACTOR,
                                    source_date=board.get("createdAt"))
                summary["comments"] += 1
    return summary


def _agent_state(store, data: bytes) -> str | None:
    """Initial analysis_state for an agent add: None (keep) when the bytes are
    already an asset, else `queued` while today's agent_add meter is under the
    cap and `held` past it. The meter counts attempts that reach a new asset,
    so a later sniff failure still uses one (errs on the conservative side)."""
    from commons import records

    if store.asset_by_sha(hashlib.sha256(data).hexdigest()) is not None:
        return None
    cap = int(store.get_setting("agent_add_daily_cap", AGENT_ADD_DAILY_CAP_DEFAULT))
    used = records.meter_increment(store, "agent_add")
    return "queued" if used <= cap else "held"


def _check_agent_target(store, actor, collection_id: str, why: str) -> None:
    if actor.is_human:
        raise IntakeError("humans add through the intake routes, not agent_add")
    if not (why or "").strip():
        raise IntakeError("why is required for agent adds")
    collection = store.get_collection(collection_id)
    if collection is None or collection["kind"] == "system":
        raise IntakeError("unknown collection")
    if actor.workspace is not None:
        from commons.search import scope_collection_ids
        if collection_id not in scope_collection_ids(store, actor.brand):
            raise PathNotAllowed("collection is outside this agent's brand scope")


def agent_add_bytes(store, *, actor, data: bytes, filename: str, collection_id: str, why: str,
                    made_by: str = "unknown") -> IntakeResult:
    _check_agent_target(store, actor, collection_id, why)
    return add_bytes(store, data, filename=filename, collection_id=collection_id, actor=actor.id,
                     source={"kind": "agent", "original_name": filename}, why=why.strip(), made_by=made_by,
                     in_inbox=True, analysis_state=_agent_state(store, data))


async def agent_add(store, *, actor, source: str, collection_id: str, why: str, made_by: str = "unknown",
                    fetch=None):
    """An agent's add goes to the collection's inbox. A URL goes through the
    SSRF gate; a local path is read only when its realpath is under one of the
    actor's allowed dirs (Nebula's own runners). MCP clients and token-less CLI
    calls have none, so they upload bytes via agent_add_bytes instead."""
    _check_agent_target(store, actor, collection_id, why)
    if source.startswith(("http://", "https://")):
        return await add_url(store, source, collection_id=collection_id, actor=actor.id, why=why.strip(),
                             in_inbox=True, made_by=made_by, fetch=fetch or net.safe_fetch,
                             state_for=lambda data: _agent_state(store, data))
    real = Path(source).expanduser().resolve()
    allowed = [Path(d).resolve() for d in actor.allowed_dirs]
    if not allowed or not any(real.is_relative_to(d) for d in allowed):
        raise PathNotAllowed("path is outside this agent's permitted directories")
    from services.agent_workspaces import WorkspaceSessionError, validate_workspace, workspace_scope
    from services.file_access import ProtectedPathError, require_allowed_path
    try:
        if actor.workspace is not None:
            validate_workspace(actor.workspace, actor.workspace_identity)
        with workspace_scope(actor.workspace):
            real = require_allowed_path(source)
    except (ProtectedPathError, WorkspaceSessionError) as exc:
        raise PathNotAllowed(str(exc)) from exc
    if not real.is_file():
        raise IntakeError("no such file")
    if real.stat().st_size > media.VIDEO_CAP:
        raise IntakeError("file exceeds the size cap")
    data = await asyncio.to_thread(real.read_bytes)
    return await asyncio.to_thread(agent_add_bytes, store, actor=actor, data=data,
                                   filename=real.name, collection_id=collection_id, why=why, made_by=made_by)
