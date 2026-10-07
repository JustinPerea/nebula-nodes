"""The commons store: the only code that writes commons rows (§9).

API routes, folder scans and the in-process worker all call these methods,
so SQLite has one writer process. Every write emits a `commons_events` row
(§4 tap events) inside the same transaction.
"""
from __future__ import annotations

import hashlib
import json
import os
import re
import sqlite3
import tempfile
from pathlib import Path
from typing import Any

from commons.db import CommonsDB, now_iso
from commons.ids import new_id

_BLOB_KEY = re.compile(r"^[0-9a-f]{64}\.[a-z0-9]{2,5}$")
_UNCHANGED: Any = ...


def _row(row: sqlite3.Row | None) -> dict | None:
    if row is None:
        return None
    out = dict(row)
    for key in ("measurements", "ignores", "last_scan_summary", "box", "value", "used_in",
                "integrity", "fidelity", "payload", "fields", "fewshot_ids"):
        if key in out and isinstance(out[key], str):
            try:
                out[key] = json.loads(out[key])
            except json.JSONDecodeError:
                pass
    return out


class CommonsStore:
    def __init__(self, db: CommonsDB, blobs: Path) -> None:
        self.db = db
        self.blobs = blobs
        blobs.mkdir(parents=True, exist_ok=True)

    # -- blobs -------------------------------------------------------------
    def put_blob(self, data: bytes, ext: str) -> tuple[str, str]:
        sha = hashlib.sha256(data).hexdigest()
        key = f"{sha}.{ext.lower()}"
        path = self.blob_path(key)
        if not path.exists():
            fd, tmp = tempfile.mkstemp(dir=self.blobs, prefix=".tmp-")
            try:
                with os.fdopen(fd, "wb") as fh:
                    fh.write(data)
                    fh.flush()
                    os.fsync(fh.fileno())
                os.replace(tmp, path)
            except BaseException:
                Path(tmp).unlink(missing_ok=True)
                raise
        return sha, key

    def blob_path(self, blob_key: str) -> Path:
        if not _BLOB_KEY.fullmatch(blob_key or ""):
            raise ValueError(f"invalid blob key: {blob_key!r}")
        return self.blobs / blob_key

    # -- events + settings -------------------------------------------------
    def emit(self, conn: sqlite3.Connection, kind: str, payload: dict, actor: str) -> None:
        conn.execute(
            "INSERT INTO commons_events(id, kind, payload, actor, created_at) VALUES (?, ?, ?, ?, ?)",
            (new_id("evt"), kind, json.dumps(payload, default=str), actor, now_iso()),
        )

    def get_setting(self, key: str, default: Any) -> Any:
        with self.db.read() as conn:
            row = conn.execute("SELECT value FROM settings WHERE key = ?", (key,)).fetchone()
        return json.loads(row[0]) if row else default

    def set_setting(self, key: str, value: Any) -> None:
        with self.db.tx() as conn:
            conn.execute(
                "INSERT INTO settings(key, value) VALUES (?, ?) "
                "ON CONFLICT(key) DO UPDATE SET value = excluded.value",
                (key, json.dumps(value)),
            )

    # -- collections -------------------------------------------------------
    def ensure_collection(self, name: str, kind: str, *, brand: str | None = None,
                          folder_link: str | None = None, source_ref: str | None = None,
                          actor: str = "system") -> dict:
        with self.db.tx() as conn:
            row = None
            if folder_link is not None:
                row = conn.execute("SELECT * FROM collections WHERE folder_link = ? AND name = ?",
                                   (folder_link, name)).fetchone()
            elif source_ref is not None:
                row = conn.execute("SELECT * FROM collections WHERE kind = ? AND source_ref = ?",
                                   (kind, source_ref)).fetchone()
            elif kind in ("manual", "system"):
                row = conn.execute(
                    "SELECT * FROM collections WHERE kind = ? AND name = ? AND folder_link IS NULL "
                    "AND source_ref IS NULL AND brand IS ?", (kind, name, brand)).fetchone()
            if row is not None:
                return _row(row)
            cid = new_id("col")
            conn.execute(
                "INSERT INTO collections(id, name, kind, brand, folder_link, source_ref, created_at) "
                "VALUES (?, ?, ?, ?, ?, ?, ?)",
                (cid, name, kind, brand, folder_link, source_ref, now_iso()),
            )
            self.emit(conn, "collection_created", {"collection": cid, "name": name, "kind": kind,
                                                   "brand": brand}, actor)
            return _row(conn.execute("SELECT * FROM collections WHERE id = ?", (cid,)).fetchone())

    def get_collection(self, collection_id: str) -> dict | None:
        with self.db.read() as conn:
            return _row(conn.execute("SELECT * FROM collections WHERE id = ?", (collection_id,)).fetchone())

    def list_collections(self, *, include_system: bool = False) -> list[dict]:
        sql = "SELECT * FROM collections"
        if not include_system:
            sql += " WHERE kind != 'system'"
        with self.db.read() as conn:
            return [_row(r) for r in conn.execute(sql + " ORDER BY name")]

    def update_collection(self, collection_id: str, *, actor: str, name: str | None = None,
                          brand: Any = _UNCHANGED) -> dict:
        with self.db.tx() as conn:
            if name is not None:
                conn.execute("UPDATE collections SET name = ? WHERE id = ?", (name, collection_id))
            if brand is not _UNCHANGED:
                conn.execute("UPDATE collections SET brand = ? WHERE id = ?", (brand, collection_id))
            self.emit(conn, "collection_updated", {"collection": collection_id, "name": name,
                                                   "brand": None if brand is _UNCHANGED else brand}, actor)
            row = conn.execute("SELECT * FROM collections WHERE id = ?", (collection_id,)).fetchone()
        if row is None:
            raise KeyError(collection_id)
        from commons import search  # local import: search imports records, which imports measure

        with self.db.read() as conn:
            asset_ids = [r[0] for r in conn.execute(
                "SELECT DISTINCT asset FROM memberships WHERE collection = ?", (collection_id,))]
        for asset_id in asset_ids:
            search.reindex_asset(self, asset_id)
        return _row(row)

    # -- assets ------------------------------------------------------------
    def get_asset(self, asset_id: str) -> dict | None:
        with self.db.read() as conn:
            return _row(conn.execute("SELECT * FROM assets WHERE id = ?", (asset_id,)).fetchone())

    def asset_by_sha(self, sha: str) -> dict | None:
        with self.db.read() as conn:
            return _row(conn.execute("SELECT * FROM assets WHERE sha256 = ?", (sha,)).fetchone())

    def insert_asset(self, conn: sqlite3.Connection, **cols: Any) -> dict:
        cols.setdefault("id", new_id("ast"))
        cols.setdefault("created_at", now_iso())
        if isinstance(cols.get("measurements"), dict):
            cols["measurements"] = json.dumps(cols["measurements"])
        names = ", ".join(cols)
        marks = ", ".join("?" for _ in cols)
        conn.execute(f"INSERT INTO assets({names}) VALUES ({marks})", tuple(cols.values()))
        return _row(conn.execute("SELECT * FROM assets WHERE id = ?", (cols["id"],)).fetchone())

    def delete_asset(self, asset_id: str, *, actor: str) -> None:
        with self.db.tx() as conn:
            rows = conn.execute(
                "SELECT id, blob_key FROM assets WHERE id = ? OR parent_asset = ?", (asset_id, asset_id)
            ).fetchall()
            conn.execute("DELETE FROM search_fts WHERE asset IN (SELECT id FROM assets WHERE id = ? OR parent_asset = ?)",
                         (asset_id, asset_id))
            conn.execute("DELETE FROM assets WHERE id = ?", (asset_id,))
            self.emit(conn, "asset_purged", {"asset": asset_id}, actor)
        for row in rows:
            self.blob_path(row["blob_key"]).unlink(missing_ok=True)

    # -- memberships + sightings ------------------------------------------
    def get_membership(self, membership_id: str) -> dict | None:
        with self.db.read() as conn:
            return _row(conn.execute("SELECT * FROM memberships WHERE id = ?", (membership_id,)).fetchone())

    def memberships_for_asset(self, asset_id: str) -> list[dict]:
        with self.db.read() as conn:
            return [_row(r) for r in conn.execute(
                "SELECT m.*, c.name AS collection_name, c.brand AS brand, c.kind AS collection_kind "
                "FROM memberships m JOIN collections c ON c.id = m.collection "
                "WHERE m.asset = ? ORDER BY m.added_at", (asset_id,))]

    def update_membership(self, membership_id: str, *, actor: str, **changes: Any) -> dict:
        """Human edits of a membership's role or why. The caller reindexes search."""
        allowed = {k: v for k, v in changes.items() if k in ("role", "why")}
        with self.db.tx() as conn:
            for key, value in allowed.items():
                conn.execute(f"UPDATE memberships SET {key} = ? WHERE id = ?", (value, membership_id))
            self.emit(conn, "membership_updated", {"membership": membership_id, **allowed}, actor)
        return self.get_membership(membership_id)

    def accept_membership(self, membership_id: str, *, actor: str) -> dict:
        """Clear the inbox flag; an asset held by the agent-add cap becomes queued."""
        with self.db.tx() as conn:
            row = conn.execute("SELECT asset FROM memberships WHERE id = ?", (membership_id,)).fetchone()
            if row is None:
                raise KeyError(membership_id)
            conn.execute("UPDATE memberships SET in_inbox = 0 WHERE id = ?", (membership_id,))
            conn.execute("UPDATE assets SET analysis_state = 'queued' WHERE id = ? AND analysis_state = 'held'",
                         (row["asset"],))
            self.emit(conn, "inbox_accepted", {"membership": membership_id, "asset": row["asset"]}, actor)
        return self.get_membership(membership_id)

    def insert_membership(self, conn: sqlite3.Connection, *, asset: str, collection: str, actor: str,
                          role: str = "neutral", why: str | None = None,
                          in_inbox: bool = False) -> tuple[dict, bool]:
        existing = conn.execute("SELECT * FROM memberships WHERE asset = ? AND collection = ?",
                                (asset, collection)).fetchone()
        if existing is not None:
            return _row(existing), False
        mid = new_id("mem")
        conn.execute(
            "INSERT INTO memberships(id, asset, collection, role, why, actor, in_inbox, added_at) "
            "VALUES (?, ?, ?, ?, ?, ?, ?, ?)",
            (mid, asset, collection, role, why, actor, 1 if in_inbox else 0, now_iso()),
        )
        self.emit(conn, "membership_added", {"membership": mid, "asset": asset, "collection": collection,
                                             "role": role, "why": why, "in_inbox": in_inbox}, actor)
        return _row(conn.execute("SELECT * FROM memberships WHERE id = ?", (mid,)).fetchone()), True

    def insert_sighting(self, conn: sqlite3.Connection, *, membership: str, source_kind: str,
                        **fields: Any) -> dict:
        allowed = {"url", "page_url", "page_title", "original_path", "original_name", "folder_link",
                   "rel_path", "file_id", "size", "mtime", "source_date", "fetched_at", "state"}
        cols = {k: v for k, v in fields.items() if k in allowed}
        cols.update({"id": new_id("sig"), "membership": membership, "source_kind": source_kind,
                     "created_at": now_iso()})
        names = ", ".join(cols)
        conn.execute(f"INSERT INTO sightings({names}) VALUES ({', '.join('?' for _ in cols)})",
                     tuple(cols.values()))
        return _row(conn.execute("SELECT * FROM sightings WHERE id = ?", (cols["id"],)).fetchone())

    def list_sightings(self, membership_id: str) -> list[dict]:
        with self.db.read() as conn:
            return [_row(r) for r in conn.execute(
                "SELECT * FROM sightings WHERE membership = ? ORDER BY created_at", (membership_id,))]

    # -- folder links --------------------------------------------------------
    def create_folder_link(self, path: str, ignores: list[str], *, actor: str) -> dict:
        lid = new_id("lnk")
        with self.db.tx() as conn:
            conn.execute("INSERT INTO folder_links(id, path, ignores, created_at) VALUES (?, ?, ?, ?)",
                         (lid, path, json.dumps(ignores), now_iso()))
            self.emit(conn, "folder_linked", {"folder_link": lid, "path": path, "ignores": ignores}, actor)
        return self.get_folder_link(lid)

    def get_folder_link(self, link_id: str) -> dict | None:
        with self.db.read() as conn:
            return _row(conn.execute("SELECT * FROM folder_links WHERE id = ?", (link_id,)).fetchone())

    def list_folder_links(self) -> list[dict]:
        with self.db.read() as conn:
            return [_row(r) for r in conn.execute("SELECT * FROM folder_links ORDER BY created_at")]

    def update_folder_ignores(self, link_id: str, ignores: list[str], *, actor: str) -> dict:
        with self.db.tx() as conn:
            conn.execute("UPDATE folder_links SET ignores = ? WHERE id = ?", (json.dumps(ignores), link_id))
            self.emit(conn, "folder_ignores_updated", {"folder_link": link_id, "ignores": ignores}, actor)
        return self.get_folder_link(link_id)

    def active_sighting(self, folder_link: str, rel_path: str) -> dict | None:
        with self.db.read() as conn:
            return _row(conn.execute(
                "SELECT * FROM sightings WHERE folder_link = ? AND rel_path = ? AND state != 'superseded' "
                "ORDER BY created_at DESC LIMIT 1", (folder_link, rel_path)).fetchone())

    def folder_sightings(self, folder_link: str, states: tuple[str, ...]) -> list[dict]:
        marks = ", ".join("?" for _ in states)
        with self.db.read() as conn:
            return [_row(r) for r in conn.execute(
                f"SELECT * FROM sightings WHERE folder_link = ? AND state IN ({marks}) ORDER BY created_at",
                (folder_link, *states))]

    def set_sighting_state(self, sighting_id: str, state: str, *, actor: str) -> None:
        with self.db.tx() as conn:
            conn.execute("UPDATE sightings SET state = ? WHERE id = ?", (state, sighting_id))
            self.emit(conn, "sighting_state", {"sighting": sighting_id, "state": state}, actor)

    def update_sighting_stat(self, sighting_id: str, *, size: int, mtime: float, file_id: str) -> None:
        with self.db.tx() as conn:
            conn.execute("UPDATE sightings SET size = ?, mtime = ?, file_id = ?, state = 'ok' WHERE id = ?",
                         (size, mtime, file_id, sighting_id))

    def sighting_asset_sha(self, sighting_id: str) -> str:
        with self.db.read() as conn:
            return conn.execute(
                "SELECT a.sha256 FROM sightings s JOIN memberships m ON m.id = s.membership "
                "JOIN assets a ON a.id = m.asset WHERE s.id = ?", (sighting_id,)).fetchone()[0]

    def set_device_state(self, path: str, folder_link: str, state: str, error: str | None = None) -> None:
        with self.db.tx() as conn:
            conn.execute(
                "INSERT INTO device_state(path, folder_link, state, attempts, error, updated_at) "
                "VALUES (?, ?, ?, 1, ?, ?) ON CONFLICT(path) DO UPDATE SET state = excluded.state, "
                "attempts = device_state.attempts + 1, error = excluded.error, updated_at = excluded.updated_at",
                (path, folder_link, state, error, now_iso()))

    def clear_device_state(self, path: str) -> None:
        with self.db.tx() as conn:
            conn.execute("DELETE FROM device_state WHERE path = ?", (path,))

    def device_states(self, folder_link: str | None = None) -> list[dict]:
        sql, args = "SELECT * FROM device_state", ()
        if folder_link:
            sql, args = sql + " WHERE folder_link = ?", (folder_link,)
        with self.db.read() as conn:
            return [_row(r) for r in conn.execute(sql + " ORDER BY path", args)]

    def finish_scan(self, folder_link: str, summary: dict) -> None:
        with self.db.tx() as conn:
            conn.execute("UPDATE folder_links SET last_scan_at = ?, last_scan_summary = ? WHERE id = ?",
                         (now_iso(), json.dumps(summary), folder_link))
            self.emit(conn, "folder_scanned", {"folder_link": folder_link, **summary}, "import:folder")
