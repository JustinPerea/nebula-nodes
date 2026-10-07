from __future__ import annotations

import asyncio
import io
import os
from pathlib import Path
from types import SimpleNamespace

import numpy as np
import pytest
from PIL import Image

from commons import folders, icloud
from commons.db import CommonsDB
from commons.store import CommonsStore


@pytest.fixture()
def store(tmp_path):
    return CommonsStore(CommonsDB(tmp_path / "c.db"), tmp_path / "blobs")


def write_png(path: Path, seed: int) -> None:
    path.parent.mkdir(parents=True, exist_ok=True)
    rng = np.random.default_rng(seed)
    Image.fromarray(rng.integers(0, 255, (24, 32, 3), dtype=np.uint8), "RGB").save(path, "PNG")


@pytest.fixture()
def drop(tmp_path):
    root = tmp_path / "drop"
    write_png(root / "loose.png", 1)
    write_png(root / "ui-inspo" / "a.png", 2)
    write_png(root / "ui-inspo" / "deep" / "b.png", 3)
    write_png(root / "processed" / "old.png", 4)
    (root / "notes.md").write_text("# not an image")
    (root / ".DS_Store").write_bytes(b"\x00")
    (root / "README.html").write_text("<p>")
    (root / "Library.photoslibrary").mkdir()
    write_png(root / "Library.photoslibrary" / "inside.png", 5)
    os.symlink(tmp_path, root / "link-out")
    return root


def snapshot(root: Path) -> dict:
    out = {}
    for dirpath, _dirs, files in os.walk(root):
        for f in files:
            p = Path(dirpath) / f
            st = p.lstat()
            out[str(p.relative_to(root))] = (st.st_size, st.st_mtime)
    return out


def test_first_scan_maps_collections_and_honours_ignores(store, drop):
    before = snapshot(drop)
    link = folders.link_folder(store, str(drop), actor="human:justin")
    assert link["ignores"] == ["processed/**"]
    summary = folders.scan_folder(store, link["id"])
    assert summary["added"] == 3 and summary["truncated"] is False
    names = {c["name"] for c in store.list_collections()}
    assert {"drop", "ui-inspo", "ui-inspo/deep"} <= names
    assert snapshot(drop) == before  # C5: the folder is untouched


def test_rescan_reads_nothing_when_unchanged(store, drop, monkeypatch):
    link = folders.link_folder(store, str(drop), actor="human:justin")
    folders.scan_folder(store, link["id"])
    monkeypatch.setattr(Path, "read_bytes", lambda self: (_ for _ in ()).throw(AssertionError(f"read {self}")))
    summary = folders.scan_folder(store, link["id"])
    assert summary["unchanged"] == 3 and summary["added"] == 0


def test_changed_bytes_supersede_only_this_folders_sighting(store, drop):
    link = folders.link_folder(store, str(drop), actor="human:justin")
    folders.scan_folder(store, link["id"])
    old = store.active_sighting(link["id"], "ui-inspo/a.png")
    write_png(drop / "ui-inspo" / "a.png", 99)
    os.utime(drop / "ui-inspo" / "a.png", (1_900_000_000, 1_900_000_000))
    summary = folders.scan_folder(store, link["id"])
    assert summary["changed"] == 1
    new = store.active_sighting(link["id"], "ui-inspo/a.png")
    assert new["id"] != old["id"]
    states = {s["id"]: s["state"] for s in store.folder_sightings(link["id"], ("ok", "superseded"))}
    assert states[old["id"]] == "superseded"


def test_move_into_processed_archives_and_delete_marks_missing(store, drop):
    link = folders.link_folder(store, str(drop), actor="human:justin")
    folders.scan_folder(store, link["id"])
    os.rename(drop / "ui-inspo" / "a.png", drop / "processed" / "a.png")
    (drop / "loose.png").unlink()
    summary = folders.scan_folder(store, link["id"])
    assert summary["archived"] == 1 and summary["missing"] == 1
    write_png(drop / "loose.png", 1)  # same bytes come back
    summary = folders.scan_folder(store, link["id"])
    assert summary["restored"] + summary["unchanged"] >= 1


def test_dataless_files_are_not_read_and_go_to_downloading(store, drop):
    link = folders.link_folder(store, str(drop), actor="human:justin")

    def stat_fn(entry):
        st = entry.stat(follow_symlinks=False)
        if entry.name == "a.png":
            return SimpleNamespace(st_size=st.st_size, st_mtime=st.st_mtime, st_dev=st.st_dev,
                                   st_ino=st.st_ino, st_flags=folders.SF_DATALESS)
        return st

    summary = folders.scan_folder(store, link["id"], stat_fn=stat_fn)
    assert summary["added"] == 2 and summary["downloading"] == 1
    assert summary["pending_downloads"] == [str((drop / "ui-inspo" / "a.png").resolve())]
    assert [d["state"] for d in store.device_states(link["id"])] == ["downloading"]


def test_eviction_alone_is_not_a_change(store, drop):
    link = folders.link_folder(store, str(drop), actor="human:justin")
    folders.scan_folder(store, link["id"])

    def evicted(entry):
        st = entry.stat(follow_symlinks=False)
        return SimpleNamespace(st_size=st.st_size, st_mtime=st.st_mtime, st_dev=st.st_dev,
                               st_ino=st.st_ino, st_flags=folders.SF_DATALESS)

    summary = folders.scan_folder(store, link["id"], stat_fn=evicted)
    assert summary["unchanged"] == 3 and summary["downloading"] == 0


def test_file_cap_truncates(store, drop, monkeypatch):
    monkeypatch.setattr(folders, "MAX_FILES", 2)
    link = folders.link_folder(store, str(drop), actor="human:justin")
    assert folders.scan_folder(store, link["id"])["truncated"] is True


def test_ignore_patterns():
    assert folders.is_ignored("processed/a.png", ["processed/**"])
    assert folders.is_ignored("processed/x/y.png", ["processed/**"])
    assert not folders.is_ignored("processed-not/a.png", ["processed/**"])
    assert folders.is_ignored("raw/a.heic", ["*.heic", "raw/*.heic"])


@pytest.mark.asyncio
async def test_downloader_polls_until_flag_clears(tmp_path):
    target = tmp_path / "f.png"
    target.write_bytes(b"x")
    flags = iter([folders.SF_DATALESS, folders.SF_DATALESS, 0])
    calls = []
    dl = icloud.DatalessDownloader(
        run=lambda args, **kw: calls.append(args),
        stat=lambda p: SimpleNamespace(st_flags=next(flags)),
        sleep=lambda s: asyncio.sleep(0), poll=0.01, timeout=5)
    assert await dl.download(target) is True
    assert calls == [["brctl", "download", str(target)]]


@pytest.mark.asyncio
async def test_downloader_times_out(tmp_path):
    ticks = iter(range(0, 1000, 50))
    dl = icloud.DatalessDownloader(
        run=lambda args, **kw: None,
        stat=lambda p: SimpleNamespace(st_flags=folders.SF_DATALESS),
        sleep=lambda s: asyncio.sleep(0), clock=lambda: next(ticks), timeout=120)
    assert await dl.download(tmp_path / "f.png") is False


def test_deleted_file_returning_with_new_mtime_counts_as_restored(store, drop):
    link = folders.link_folder(store, str(drop), actor="human:justin")
    folders.scan_folder(store, link["id"])
    (drop / "loose.png").unlink()
    assert folders.scan_folder(store, link["id"])["missing"] == 1
    write_png(drop / "loose.png", 1)  # same bytes, new mtime
    os.utime(drop / "loose.png", (1_900_000_000, 1_900_000_000))
    summary = folders.scan_folder(store, link["id"])
    assert summary["restored"] == 1 and summary["added"] == 0
    assert store.active_sighting(link["id"], "loose.png")["state"] == "ok"


def test_overlapping_scans_record_each_file_once(store, drop):
    from concurrent.futures import ThreadPoolExecutor

    link = folders.link_folder(store, str(drop), actor="human:justin")
    with ThreadPoolExecutor(4) as pool:
        list(pool.map(lambda _: folders.scan_folder(store, link["id"]), range(4)))
    rels = [s["rel_path"] for s in store.folder_sightings(link["id"], ("ok",))]
    assert sorted(rels) == sorted(set(rels)) and len(rels) == 3
