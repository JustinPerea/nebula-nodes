"""Durable source identity and immutable snapshots, independent of Paper transport."""
from __future__ import annotations

import asyncio
import copy
import hashlib
import io
import json
import re
import sqlite3
from datetime import datetime, timezone
from pathlib import Path
from uuid import uuid4

from PIL import Image
from services.paper_transport import PaperCLI, PaperError


def now():
    return datetime.now(timezone.utc).isoformat()


class SourceRefreshError(PaperError):
    def __init__(self, error: PaperError, source: dict):
        super().__init__(str(error), error.state)
        self.source = source


class PaperSources:
    def __init__(self, root: Path, transport=None):
        self.root = root / "paper-sources"
        self.root.mkdir(parents=True, exist_ok=True)
        self.transport = transport or PaperCLI()
        with self.db() as db:
            db.execute("CREATE TABLE IF NOT EXISTS sources (id TEXT PRIMARY KEY, record TEXT NOT NULL)")
            db.execute("CREATE TABLE IF NOT EXISTS snapshots (id TEXT PRIMARY KEY, record TEXT NOT NULL)")

    def db(self):
        return sqlite3.connect(self.root / "sources.sqlite3", timeout=10)

    def get(self, source_id):
        with self.db() as db:
            row = db.execute("SELECT record FROM sources WHERE id=?", (source_id,)).fetchone()
        if row is None:
            raise KeyError("Paper source not found")
        return json.loads(row[0])

    def _reserve(self, source_id):
        with self.db() as db:
            db.execute("BEGIN IMMEDIATE")
            row = db.execute("SELECT record FROM sources WHERE id=?", (source_id,)).fetchone()
            if row is None:
                raise KeyError("Paper source not found")
            record = json.loads(row[0])
            record["sequence"] += 1
            db.execute("UPDATE sources SET record=? WHERE id=?", (json.dumps(record), source_id))
        return record

    def _commit(self, record, snapshot=None):
        with self.db() as db:
            db.execute("BEGIN IMMEDIATE")
            row = db.execute("SELECT record FROM sources WHERE id=?", (record["id"],)).fetchone()
            current = json.loads(row[0])
            if current["sequence"] != record["sequence"]:
                return {**current, "changed": False, "superseded": True}
            if snapshot:
                db.execute("INSERT OR IGNORE INTO snapshots VALUES (?,?)", (snapshot["id"], json.dumps(snapshot)))
            db.execute("UPDATE sources SET record=? WHERE id=?", (json.dumps(record), record["id"]))
        return record

    async def link(self, identity, scale="1x"):
        record = {"id": uuid4().hex, "identity": copy.deepcopy(identity),
                  "exportSettings": {"format": "png", "scale": scale, "bounds": "object", "background": "artwork"},
                  "snapshots": [], "state": "unavailable", "sequence": 0}
        with self.db() as db:
            db.execute("INSERT INTO sources VALUES (?,?)", (record["id"], json.dumps(record)))
        return await self.refresh(record["id"])

    async def refresh(self, source_id, identity=None, scale=None):
        record = self._reserve(source_id)
        requested = copy.deepcopy(identity or record["identity"])
        # Paper has no background override in its export interface. Preserve
        # artwork alpha and record the actual PNG transparency separately.
        settings = {"format": "png", "scale": scale or record["exportSettings"]["scale"], "bounds": "object", "background": "artwork"}
        try:
            resolved, raw, bounds = await self.transport.capture(requested, settings)
            with Image.open(io.BytesIO(raw)) as image:
                if image.format != "PNG":
                    raise PaperError("Paper export was not a PNG")
                image.verify()
            with Image.open(io.BytesIO(raw)) as image:
                width, height = image.size
                has_alpha = "A" in image.getbands() or "transparency" in image.info
                alpha = image.convert("RGBA").getchannel("A")
                transparent = alpha.getextrema()[0] < 255
            content_hash = hashlib.sha256(raw).hexdigest()
            sid = hashlib.sha256(json.dumps({"identity": {k: resolved[k] for k in ("fileId", "pageId", "objectId")}, "settings": settings, "hash": content_hash}, sort_keys=True).encode()).hexdigest()
            previous = record.get("snapshot")
            changed = not previous or previous["id"] != sid
            stamp = now()
            if changed:
                path = self.root / f"{sid}.png"
                # Exclusive create: old bytes can never be overwritten by a refresh.
                try:
                    with path.open("xb") as out:
                        out.write(raw)
                except FileExistsError:
                    if hashlib.sha256(path.read_bytes()).hexdigest() != content_hash:
                        raise PaperError("Snapshot integrity check failed")
                snapshot = {"id": sid, "hash": content_hash, "capturedAt": stamp, "width": width, "height": height,
                            "hasAlpha": has_alpha, "hasTransparency": transparent, "bounds": bounds,
                            "filePath": str(path.resolve()), "previewUrl": f"/api/paper/snapshots/{sid}",
                            "identity": resolved, "exportSettings": settings}
                # The same snapshot may have existed before reconnecting back to it.
                with self.db() as db:
                    existing = db.execute("SELECT record FROM snapshots WHERE id=?", (sid,)).fetchone()
                if existing:
                    snapshot = json.loads(existing[0])
                if not any(s["id"] == sid for s in record["snapshots"]):
                    record["snapshots"].append(snapshot)
                record["snapshot"] = snapshot
            record.update(identity=resolved, exportSettings=settings, state="current", lastSuccessfulRefresh=stamp)
            record.pop("lastError", None)
            result = self._commit(record, record.get("snapshot"))
            return {**result, "changed": changed and not result.get("superseded", False)}
        except (PaperError, OSError, ValueError, Image.DecompressionBombError) as exc:
            error = exc if isinstance(exc, PaperError) else PaperError("Paper export could not be validated; last good snapshot retained")
            record.update(state=error.state, lastError=str(error))
            retained = self._commit(record)
            if retained.get("superseded"):
                return retained
            raise SourceRefreshError(error, retained) from exc

    def snapshot(self, snapshot_id, expected_hash=None):
        if not re.fullmatch(r"[a-f0-9]{64}", str(snapshot_id)):
            raise KeyError("Invalid snapshot")
        with self.db() as db:
            row = db.execute("SELECT record FROM snapshots WHERE id=?", (snapshot_id,)).fetchone()
        if row is None:
            raise KeyError("Snapshot not found; refresh or reconnect explicitly")
        record = json.loads(row[0])
        path = self.root / f"{snapshot_id}.png"
        if not path.is_file() or hashlib.sha256(path.read_bytes()).hexdigest() != record["hash"] or (expected_hash and expected_hash != record["hash"]):
            raise PaperError("Pinned snapshot is missing or damaged; execution stopped")
        return record
