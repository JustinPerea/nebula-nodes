"""Linked folders (§5.2): scan on open plus a rescan button, no watcher."""
from __future__ import annotations

import asyncio
import fnmatch
import hashlib
import os
import threading
from dataclasses import dataclass
from datetime import datetime, timezone
from pathlib import Path
from typing import Callable

from commons import intake, media
from commons.icloud import SF_DATALESS, DatalessDownloader, is_dataless

MAX_FILES = 5000
MAX_DEPTH = 6
BUNDLE_SUFFIXES = {".photoslibrary", ".app", ".fcpbundle", ".imovielibrary", ".bundle"}
ALWAYS_IGNORED_SUFFIXES = {".md", ".html", ".htm"}
FOLDER_ACTOR = "import:folder"

# One scan per link at a time. scan_and_fetch rescans after each iCloud
# download (up to 4 at once, in threads); two overlapping scans could both see
# "no sighting yet" for the same file and record it twice.
_SCAN_LOCKS: dict[str, threading.Lock] = {}
_SCAN_LOCKS_GUARD = threading.Lock()


def _scan_lock(link_id: str) -> threading.Lock:
    with _SCAN_LOCKS_GUARD:
        return _SCAN_LOCKS.setdefault(link_id, threading.Lock())


@dataclass
class Entry:
    rel: str
    path: Path
    size: int
    mtime: float
    file_id: str
    dataless: bool
    ignored: bool


def default_ignores(path: Path) -> list[str]:
    return ["processed/**"] if path.name == "drop" else []


def is_ignored(rel: str, patterns: list[str]) -> bool:
    for pattern in patterns:
        if pattern.endswith("/**"):
            prefix = pattern[:-3]
            if rel == prefix or rel.startswith(prefix + "/"):
                return True
        elif fnmatch.fnmatchcase(rel, pattern):
            return True
    return False


def walk(root: Path, ignores: list[str], *, stat_fn: Callable | None = None) -> tuple[list[Entry], bool]:
    stat_of = stat_fn or (lambda e: e.stat(follow_symlinks=False))
    entries: list[Entry] = []
    stack: list[tuple[Path, str, int]] = [(root, "", 0)]
    while stack:
        directory, rel_dir, depth = stack.pop()
        try:
            children = sorted(os.scandir(directory), key=lambda e: e.name)
        except OSError:
            continue
        for entry in children:
            if entry.name.startswith(".") or entry.is_symlink():
                continue
            rel = f"{rel_dir}/{entry.name}" if rel_dir else entry.name
            suffix = Path(entry.name).suffix.lower()
            if entry.is_dir(follow_symlinks=False):
                if suffix not in BUNDLE_SUFFIXES and depth + 1 < MAX_DEPTH:
                    stack.append((Path(entry.path), rel, depth + 1))
                continue
            if not entry.is_file(follow_symlinks=False) or suffix in ALWAYS_IGNORED_SUFFIXES:
                continue
            if suffix.lstrip(".") not in media.ACCEPTED_EXT:
                continue
            if len(entries) >= MAX_FILES:
                return entries, True
            st = stat_of(entry)
            entries.append(Entry(rel, Path(entry.path), st.st_size, st.st_mtime, f"{st.st_dev}:{st.st_ino}",
                                 is_dataless(st), is_ignored(rel, ignores)))
    return entries, False


def link_folder(store, path: str, *, actor: str, ignores: list[str] | None = None) -> dict:
    raw = Path(path).expanduser()
    if raw.is_symlink():
        raise ValueError("linked folder may not be a symlink")
    real = raw.resolve()
    if not real.is_dir():
        raise ValueError(f"not a folder: {path}")
    for link in store.list_folder_links():
        if link["path"] == str(real):
            return link
    return store.create_folder_link(str(real), default_ignores(real) if ignores is None else ignores, actor=actor)


def _collection_name(root: Path, rel: str) -> str:
    parent = rel.rsplit("/", 1)[0] if "/" in rel else ""
    return parent or root.name


def _iso(ts: float) -> str:
    return datetime.fromtimestamp(ts, timezone.utc).strftime("%Y-%m-%dT%H:%M:%S.%fZ")


def ingest_entry(store, link: dict, entry: Entry, existing: dict | None) -> str:
    """Read one non-dataless file and record it. Returns the outcome key."""
    root = Path(link["path"])
    size_cap = media.VIDEO_CAP if entry.path.suffix.lower() in (".mp4", ".mov") else media.IMAGE_CAP
    if entry.size > size_cap:
        raise intake.IntakeError("file exceeds the size cap")
    data = entry.path.read_bytes()
    if existing is not None:
        if hashlib.sha256(data).hexdigest() == store.sighting_asset_sha(existing["id"]):
            store.update_sighting_stat(existing["id"], size=entry.size, mtime=entry.mtime, file_id=entry.file_id)
            return "unchanged" if existing["state"] == "ok" else "restored"
    collection = store.ensure_collection(_collection_name(root, entry.rel), "folder", folder_link=link["id"],
                                         actor=FOLDER_ACTOR)
    intake.add_bytes(store, data, filename=entry.path.name, collection_id=collection["id"], actor=FOLDER_ACTOR,
                     source={"kind": "folder", "folder_link": link["id"], "rel_path": entry.rel,
                             "original_path": str(entry.path), "original_name": entry.path.name,
                             "file_id": entry.file_id, "size": entry.size, "mtime": entry.mtime,
                             "source_date": _iso(entry.mtime)})
    if existing is not None:
        store.set_sighting_state(existing["id"], "superseded", actor=FOLDER_ACTOR)
        return "changed"
    return "added"


def scan_folder(store, link_id: str, *, stat_fn: Callable | None = None) -> dict:
    with _scan_lock(link_id):
        return _scan_folder(store, link_id, stat_fn=stat_fn)


def _scan_folder(store, link_id: str, *, stat_fn: Callable | None = None) -> dict:
    link = store.get_folder_link(link_id)
    if link is None:
        raise KeyError(link_id)
    entries, truncated = walk(Path(link["path"]), link["ignores"], stat_fn=stat_fn)
    live = {e.rel: e for e in entries if not e.ignored}
    ignored_ids = {e.file_id for e in entries if e.ignored}
    summary = {"added": 0, "unchanged": 0, "changed": 0, "missing": 0, "archived": 0, "restored": 0,
               "downloading": 0, "failed": [], "pending_downloads": [], "truncated": truncated}

    for rel, entry in live.items():
        existing = store.active_sighting(link_id, rel)
        if existing is not None and existing["size"] == entry.size and existing["mtime"] == entry.mtime:
            if existing["state"] != "ok":
                store.set_sighting_state(existing["id"], "ok", actor=FOLDER_ACTOR)
                summary["restored"] += 1
            else:
                summary["unchanged"] += 1
            continue
        if entry.dataless:
            store.set_device_state(str(entry.path), link_id, "downloading")
            summary["downloading"] += 1
            summary["pending_downloads"].append(str(entry.path))
            continue
        try:
            summary[ingest_entry(store, link, entry, existing)] += 1
            store.clear_device_state(str(entry.path))
        except (intake.IntakeError, OSError) as exc:
            summary["failed"].append({"rel_path": rel, "error": str(exc)})

    for sighting in store.folder_sightings(link_id, ("ok", "missing_from_folder")):
        if sighting["rel_path"] in live:
            continue
        if sighting["file_id"] in ignored_ids:
            store.set_sighting_state(sighting["id"], "archived", actor=FOLDER_ACTOR)
            summary["archived"] += 1
        elif sighting["state"] == "ok":
            store.set_sighting_state(sighting["id"], "missing_from_folder", actor=FOLDER_ACTOR)
            summary["missing"] += 1

    store.finish_scan(link_id, {k: v for k, v in summary.items() if k != "pending_downloads"})
    return summary


async def scan_and_fetch(store, link_id: str, *, downloader: DatalessDownloader,
                         stat_fn: Callable | None = None) -> dict:
    summary = await asyncio.to_thread(scan_folder, store, link_id, stat_fn=stat_fn)

    async def fetch_one(path_str: str) -> None:
        if await downloader.download(Path(path_str)):
            store.clear_device_state(path_str)
            await asyncio.to_thread(scan_folder, store, link_id)
        else:
            store.set_device_state(path_str, link_id, "download_failed", "iCloud download timed out")

    await asyncio.gather(*(fetch_one(p) for p in summary["pending_downloads"]))
    return summary
