"""PR #199 review 5: what fix round 5 makes true (2026-10-28).

- M-1. Salvage reads JSON's whitespace only (space, tab, LF, CR), never
  Python's ``\\s``: one bit turning an earlier record's ``]`` into 0x1d no
  longer hides every record after it. The structural sweep runs with the
  changed record first, in the middle and last.
- M-2. Future dates are judged by file order: in the newer file a date
  ahead of the clock counts as now, in the older file it is left out. A
  whole record that still loses to the copy by its dates gets a
  ``reverted`` row, and its newer version is in the kept damaged file.
- M-3. The waiting canvas is held aside (``canvas-held.json``) before
  anything replaces it: opening a project works for the person and agents
  while it waits; an agent's clear or graph load at the limit is refused
  (409 ``canvas_waiting``) and below it holds the canvas first. Only the
  held copy is ever filed as the person's canvas.
- L-1. catalog-purged.json says which commit it is of (``commit``, the
  catalog's ``commitSeq``): a side file that couldn't be rewritten is older
  than the copies that hold a project made again, and they decide it.
- L-2. MCP's restore_from_trash says the 413, the limit and its number.
- L-3. The side file is written before the catalog's rename, so no crash
  leaves a landed delete-for-good without it.
"""
from __future__ import annotations

import asyncio
import hashlib
import json
import os
import shutil
import sys
import time
from datetime import datetime, timedelta, timezone
from pathlib import Path

import pytest

sys.path.insert(0, str(Path(__file__).resolve().parent.parent))
import main as main_module  # noqa: E402
import mcp_server  # noqa: E402
from nebula_api import NebulaAPI  # noqa: E402
from services import catalog_recovery  # noqa: E402
from services import project_store as store_module  # noqa: E402
from services.cli_graph import CLIGraph  # noqa: E402
from services.project_store import ProjectStore, make_project, move_to_trash  # noqa: E402
from tests.conftest import PERSON  # noqa: E402
from tests.test_project_catalog_restore_fix2 import _add_text, _create, _rev, _values, app  # noqa: E402,F401
from tests.test_project_catalog_restore_fix3 import _restart, _unfiled_at_the_limit  # noqa: E402
from tests.test_project_catalog_restore_fix4 import _flip, _fuzz_base, _restore_with, _structural, _verdict  # noqa: E402

AGENT = {**PERSON, "X-Nebula-Agent": "Probe"}
ONLY_W = "only-on-the-waiting-canvas"


def _record(store: ProjectStore) -> dict:
    return json.loads(store.record_path.read_text())["restores"][-1]


@pytest.fixture
def quick_disk(monkeypatch):
    monkeypatch.setattr(store_module.os, "fsync", lambda fd: None)


def _zero(store: ProjectStore) -> None:
    with open(store.path, "r+b") as handle:
        handle.write(b"\0" * store.path.stat().st_size)


def _where(catalog: dict, project_id: str) -> str:
    if project_id in catalog["projects"]:
        return "list"
    return "trash" if project_id in (catalog.get("trash") or {}) else "gone"


# -- M-1: JSON's whitespace, never Python's \s ------------------------------------------


def test_m1_no_salvage_pattern_uses_pythons_whitespace_class():
    """Every regex in catalog_recovery that means JSON whitespace says so:
    ``\\s`` also matches 0x1c-0x1f, 0x0b, 0x0c, 0x85 and Unicode spaces."""
    patterns = {name: value.pattern for name, value in vars(catalog_recovery).items()
                if isinstance(value, type(catalog_recovery._ID))}
    assert len(patterns) >= 10
    assert {name: source for name, source in patterns.items() if "\\s" in source or "\\S" in source} == {}
    assert catalog_recovery._SPACE.match("\x1d\x1c\x0b\x0c\x85 ").end() == 0
    assert catalog_recovery._SPACE.match(" \t\r\n{").end() == 4


@pytest.mark.parametrize("bit", range(8))
def test_m1_a_flipped_bracket_in_an_earlier_record_never_hides_a_later_ones_newest_version(tmp_path, bit):
    """Review 5's dbg_bracket and live B: Dunes, Middle, Logo; Logo renamed
    "Logo v2" after the copy; one bit of Middle's ``"nodes":[]``. Bit 6
    turns ``]`` into 0x1d, which ``\\s`` read as a space."""
    store = ProjectStore(tmp_path / "b")
    with store.transaction() as catalog:
        projects = [make_project(name) for name in ("Dunes", "Middle", "Logo")]
        for project in projects:
            catalog["projects"][project["id"]] = project
        store.commit(catalog)
    logo = projects[2]["id"]
    time.sleep(0.002)
    with store.transaction() as catalog:
        catalog["projects"][logo]["name"] = "Logo v2"
        catalog["projects"][logo]["updatedAt"] = store_module.now()
        store.commit(catalog)
    raw = store.path.read_bytes()
    at = raw.index(b'"nodes":[]', raw.index(projects[1]["id"].encode())) + 9
    damaged = _flip(raw, at, bit)
    try:
        json.loads(damaged)
        pytest.skip("this bit leaves the file valid JSON")
    except ValueError:
        pass
    found = catalog_recovery.salvage(damaged, None)
    assert logo in found.entries, (bit, sorted(e["name"] for e in found.entries.values()), found.failed)
    store.path.write_bytes(damaged)
    restored = ProjectStore(store.root).read()
    assert restored["projects"][logo]["name"] == "Logo v2"


def test_m1_the_trimmed_text_between_records_is_json_whitespace_only():
    """salvage's "right after a complete record" test used str.strip(), which
    also strips 0x1c-0x1f: a comma with a group separator beside it is not
    what prepare writes."""
    a, b = make_project("A"), make_project("B")
    body = f'{{"version":1,"workspaceRevision":"r","projects":{{"{a["id"]}":{json.dumps(a)},\x1d"{b["id"]}":{json.dumps(b)}'
    found = catalog_recovery.salvage(body.encode(), None)
    # B is still found (its own id and key), but never as "a record that
    # belongs here" on the strength of a 0x1d the scan called whitespace.
    assert a["id"] in found.entries


def _with_logo_at(tmp_path: Path, where: str):
    """Review 4's fuzz base with Logo's record (the one changed after the
    copy) moved first, to the middle, or last, in the copy and catalog.json
    alike (prepare keeps key order), .bak.1 gone as in review 5's g1."""
    base, ids = _fuzz_base(tmp_path)
    for name in (store_module.BACKUP_NAME, "catalog.json"):
        path = base.root / name
        catalog = json.loads(path.read_text())
        records = list(catalog["projects"].items())
        logo = next(item for item in records if item[0] == ids["logo"])
        records.remove(logo)
        position = {"first": 0, "middle": len(records) // 2, "last": len(records)}[where]
        records.insert(position, logo)
        catalog["projects"] = dict(records)
        head = ("version", "commitSeq", "activeProjectId", "workspaceRevision", "migratedProjectId", "purged")
        ordered = {key: catalog[key] for key in head if key in catalog}
        ordered.update((key, value) for key, value in catalog.items() if key not in ordered)
        path.write_bytes(json.dumps(ordered, ensure_ascii=False, separators=(",", ":")).encode())
    (base.root / store_module.OLDER_BACKUP_NAME).unlink(missing_ok=True)
    return base, ids


@pytest.mark.parametrize("where", ["middle", "last"])
def test_m1_every_bit_of_every_structural_byte_with_the_changed_record_anywhere(tmp_path, quick_disk, where):
    """Review 5's g1 (16 silent reverts with Logo last), for every place the
    changed record can sit: 0 silent reverts. First is fix round 4's own
    sweep (test_m2_every_bit_of_every_structural_byte_never_reverts_silently:
    Logo is the first record of _fuzz_base)."""
    base, ids = _with_logo_at(tmp_path, where)
    raw = base.path.read_bytes()
    positions = _structural(raw)
    assert len(positions) > 600
    bad: dict[str, list[str]] = {}
    for at in positions:
        for bit in range(8):
            store, catalog, error = _restore_with(base, tmp_path / "t", _flip(raw, at, bit))
            verdict = _verdict(store, catalog, ids, error)
            if verdict not in ("ok", "no-restore"):
                bad.setdefault(verdict, []).append(f"@{at} {raw[at:at + 1]!r} bit{bit} ctx {raw[max(0, at - 12):at + 12]!r}")
    assert bad == {}, {verdict: (len(cases), cases[:4]) for verdict, cases in bad.items()}


def test_a_record_whose_key_and_unreadable_id_both_changed_is_never_deleted_after_the_copy(tmp_path):
    """Found by this round's gate run of review 4's 1,500 two-flip set (its
    ids are random, so a pair lands on new bytes each run): Old's key
    changed to another valid id one character off ("9311…" -> "1311…") and
    its own id field to one that isn't an id ("…9883=1f4…"). The file still
    parses; Old was reported as deleted after the copy and back (cameBack)."""
    base, ids = _fuzz_base(tmp_path)
    raw = base.path.read_bytes()
    old = ids["old"]
    key = raw.index(f'"{old}":{{"id"'.encode()) + 1
    own = raw.index(f'"id":"{old}"'.encode(), key) + 6
    damaged = bytearray(raw)
    damaged[key] = ord("1" if old[0] != "1" else "2")  # another valid id, one character off
    damaged[own + 13] = ord("=")  # its own id no longer an id
    json.loads(bytes(damaged))  # still valid JSON: only the shape is wrong
    store, catalog, error = _restore_with(base, tmp_path / "t", bytes(damaged))
    assert _verdict(store, catalog, ids, error) == "ok", store.restore_notice()


# -- M-2: future dates by file order ---------------------------------------------------


def _ahead(monkeypatch, hours: float) -> None:
    monkeypatch.setattr(store_module, "now", lambda: (datetime.now(timezone.utc) + timedelta(hours=hours)).isoformat())


def _edit(store: ProjectStore, project_id: str, name: str) -> None:
    with store.transaction() as catalog:
        catalog["projects"][project_id]["name"] = name
        store_module.refresh_metadata(catalog["projects"][project_id])
        store.commit(catalog)


def test_m2_the_newest_copy_written_while_ahead_still_wins_and_nothing_is_lost(tmp_path, monkeypatch):
    """Review 5's c1: .bak.1 with a correct clock, then the clock 3 h ahead
    (R edited again, Gamma made: only in .bak), then corrected and
    catalog.json zeroed. .bak must win; Gamma survives two more commits."""
    store = ProjectStore(tmp_path / "p")
    with store.transaction() as catalog:
        alpha, r = make_project("Alpha"), make_project("R")
        catalog["projects"][alpha["id"]] = alpha
        catalog["projects"][r["id"]] = r
        store.commit(catalog)
    hour_ago = (datetime.now(timezone.utc) - timedelta(hours=1)).isoformat()
    with store.transaction() as catalog:
        for project in catalog["projects"].values():
            for key in ("createdAt", "updatedAt", "lastOpenedAt"):
                project[key] = hour_ago
        store.commit(catalog)
    old = time.time() - 7200
    os.utime(store.older_backup_path, (old, old))
    _edit(store, r["id"], "R edited (correct clock)")  # rewrites .bak.1
    real_now = store_module.now
    _ahead(monkeypatch, 3)
    _edit(store, r["id"], "R edited while ahead")
    with store.transaction() as catalog:
        gamma = make_project("Gamma (made while ahead)")
        catalog["projects"][gamma["id"]] = gamma
        store.commit(catalog)
    with store.transaction() as catalog:
        store_module.refresh_metadata(catalog["projects"][gamma["id"]])
        store.commit(catalog)
    monkeypatch.setattr(store_module, "now", real_now)
    _zero(store)
    fresh = ProjectStore(store.root)
    restored = fresh.read()
    assert _record(fresh)["source"] == store_module.BACKUP_NAME
    assert gamma["id"] in restored["projects"]
    assert restored["projects"][r["id"]]["name"] == "R edited while ahead"
    for _ in range(2):
        with fresh.transaction() as catalog:
            fresh.commit(catalog)
    assert gamma["id"] in json.loads(fresh.path.read_text())["projects"]


def test_m2_a_whole_record_edited_while_ahead_beats_the_copys_older_version(tmp_path, monkeypatch):
    """Review 5's c2: catalog.json holds Alpha's edit made 3 h ahead, .bak the
    one before; the clock is corrected; catalog.json is torn by 2 bytes."""
    store = ProjectStore(tmp_path / "p")
    with store.transaction() as catalog:
        alpha, beta = make_project("Alpha"), make_project("Beta")
        catalog["projects"][alpha["id"]] = alpha
        catalog["projects"][beta["id"]] = beta
        store.commit(catalog)
    time.sleep(0.01)
    _edit(store, alpha["id"], "Alpha edited (correct clock)")
    real_now = store_module.now
    _ahead(monkeypatch, 3)
    _edit(store, alpha["id"], "Alpha edited while ahead")
    monkeypatch.setattr(store_module, "now", real_now)
    store.path.write_bytes(store.path.read_bytes()[:-2])
    fresh = ProjectStore(store.root)
    restored = fresh.read()
    assert restored["projects"][alpha["id"]]["name"] == "Alpha edited while ahead"
    assert [row["name"] for row in _record(fresh)["updatedFromDisk"]] == ["Alpha edited while ahead"]


def test_m2_a_whole_record_that_loses_by_its_dates_is_reverted_and_still_in_the_kept_file(tmp_path, monkeypatch):
    """The clock ran 3 h ahead when the copy's version was written, and that
    date is now in the past; the damaged file's whole record was written
    later with a corrected clock, so its date is earlier. The copy's
    version wins by the dates, so the row says it went back, and GM's
    "went back to its version in the copy" holds only because the newer
    version is still in the kept damaged file (GM round 5, 1)."""
    store = ProjectStore(tmp_path / "p")
    monkeypatch.setattr(store_module, "now", lambda: (datetime.now(timezone.utc) - timedelta(hours=3)).isoformat())
    with store.transaction() as catalog:
        alpha, beta = make_project("Alpha"), make_project("Beta")
        catalog["projects"][alpha["id"]] = alpha
        catalog["projects"][beta["id"]] = beta
        store.commit(catalog)
    monkeypatch.setattr(store_module, "now", lambda: (datetime.now(timezone.utc) - timedelta(hours=1)).isoformat())
    _edit(store, alpha["id"], "Alpha v1 (clock was ahead)")
    monkeypatch.setattr(store_module, "now", lambda: (datetime.now(timezone.utc) - timedelta(hours=2)).isoformat())
    _edit(store, alpha["id"], "Alpha v2 (newer, clock corrected)")
    monkeypatch.undo()
    store.path.write_bytes(store.path.read_bytes()[:-2])
    fresh = ProjectStore(store.root)
    restored = fresh.read()
    record = _record(fresh)
    assert restored["projects"][alpha["id"]]["name"] == "Alpha v1 (clock was ahead)"
    assert [(row["id"], row["name"]) for row in record["reverted"]] == [(alpha["id"], "Alpha v1 (clock was ahead)")]
    assert record["reverted"][0].get("by") == "dates"
    kept = Path(record["damagedFile"]).read_bytes()
    assert b"Alpha v2 (newer, clock corrected)" in kept


def test_m2_the_older_copy_needs_a_later_commit_too(tmp_path, monkeypatch):
    """.bak.1 wins over .bak only when both its dates (future ones left out)
    and its commit are later: a .bak.1 whose dates were written ahead and
    have since passed never beats a later .bak."""
    store = ProjectStore(tmp_path / "p")
    with store.transaction() as catalog:
        alpha = make_project("Alpha")
        catalog["projects"][alpha["id"]] = alpha
        store.commit(catalog)
    old = time.time() - 7200
    os.utime(store.older_backup_path, (old, old))
    monkeypatch.setattr(store_module, "now", lambda: (datetime.now(timezone.utc) - timedelta(minutes=10)).isoformat())
    _edit(store, alpha["id"], "Alpha in .bak.1 (dated ahead, now past)")  # .bak.1 is this commit
    monkeypatch.setattr(store_module, "now", lambda: (datetime.now(timezone.utc) - timedelta(hours=2)).isoformat())
    with store.transaction() as catalog:
        beta = make_project("Beta (only in .bak)")
        catalog["projects"][beta["id"]] = beta
        store.commit(catalog)
    _edit(store, alpha["id"], "Alpha later")
    monkeypatch.undo()
    assert beta["id"] in json.loads(store.backup_path.read_text())["projects"]
    _zero(store)
    fresh = ProjectStore(store.root)
    restored = fresh.read()
    assert _record(fresh)["source"] == store_module.BACKUP_NAME
    assert beta["id"] in restored["projects"]


# -- L-1 / L-3: catalog-purged.json knows its commit -----------------------------------


def _purge_setup(tmp_path: Path):
    store = ProjectStore(tmp_path / "p")
    with store.transaction() as catalog:
        alpha, x = make_project("Alpha"), make_project("Xgone")
        catalog["projects"][alpha["id"]] = alpha
        catalog["projects"][x["id"]] = x
        store.commit(catalog)
    with store.transaction() as catalog:
        move_to_trash(catalog, x["id"])
        store.commit(catalog)
    return store, alpha["id"], x["id"]


def _purge(store: ProjectStore, project_id: str) -> None:
    with store.transaction() as catalog:
        del catalog["trash"][project_id]
        store.commit(catalog)


def _side(store: ProjectStore) -> dict | None:
    path = store.root / store_module.PURGED_NAME
    return json.loads(path.read_text()) if path.exists() else None


def test_l1_every_commit_is_numbered_and_the_side_file_says_which_it_is_of(tmp_path):
    store, _alpha, x = _purge_setup(tmp_path)
    before = json.loads(store.path.read_text())["commitSeq"]
    _purge(store, x)
    after = json.loads(store.path.read_text())
    assert after["commitSeq"] == before + 1
    side = _side(store)
    assert side["commit"] == after["commitSeq"] and x in side["purged"]
    assert json.loads(store.backup_path.read_text())["commitSeq"] == before


def test_l1_a_side_file_that_cant_be_rewritten_never_drops_a_project_made_again(tmp_path, monkeypatch, capsys):
    """Review 5's s8: X deleted for good (side file written), then the side
    file can't be rewritten; the recover retry makes X again with its id;
    two commits follow, so .bak holds X live; catalog.json is zeroed."""
    store, _alpha, x = _purge_setup(tmp_path)
    _purge(store, x)
    real = ProjectStore._write_file

    def failing(self, target, encoded):
        if target.name == store_module.PURGED_NAME:
            raise OSError("the side file is locked")
        return real(self, target, encoded)
    monkeypatch.setattr(ProjectStore, "_write_file", failing)
    monkeypatch.setattr(Path, "unlink", lambda self, missing_ok=False: (_ for _ in ()).throw(OSError("locked"))
                        if self.name == store_module.PURGED_NAME else os.unlink(self) if self.exists() or not missing_ok else None)
    with store.transaction() as catalog:
        again = make_project("Xgone (made again)")
        again["id"] = x
        catalog["projects"][x] = again
        store.commit(catalog)
    for _ in range(2):
        with store.transaction() as catalog:
            store_module.refresh_metadata(catalog["projects"][x])
            store.commit(catalog)
    monkeypatch.undo()
    assert x in json.loads(store.backup_path.read_text())["projects"]
    assert x in _side(store)["purged"]  # stale: still says X is deleted for good
    assert "could not keep catalog-purged.json" in capsys.readouterr().out
    _zero(store)
    fresh = ProjectStore(store.root)
    restored = fresh.read()
    record = _record(fresh)
    assert _where(restored, x) == "list"
    assert record["keptDeleted"] == []
    assert record.get("purgedFileBehind") is True
    assert "catalog-purged.json is from commit" in capsys.readouterr().out


@pytest.mark.skipif(sys.platform != "darwin", reason="chflags is macOS's")
def test_l1_the_reviews_immutable_side_file(tmp_path):
    import stat
    store, _alpha, x = _purge_setup(tmp_path)
    _purge(store, x)
    side = store.root / store_module.PURGED_NAME
    os.chflags(side, stat.UF_IMMUTABLE)
    try:
        with store.transaction() as catalog:
            again = make_project("Xgone (made again)")
            again["id"] = x
            catalog["projects"][x] = again
            store.commit(catalog)
        for _ in range(2):
            with store.transaction() as catalog:
                store_module.refresh_metadata(catalog["projects"][x])
                store.commit(catalog)
        _zero(store)
        restored = ProjectStore(store.root).read()
        assert _where(restored, x) == "list"
    finally:
        os.chflags(side, 0)


def test_l3_the_side_file_is_written_before_the_catalogs_rename(tmp_path, monkeypatch):
    store, _alpha, x = _purge_setup(tmp_path)
    order: list[str] = []
    real = os.replace

    def spy(source, target, *args, **kwargs):
        order.append(Path(target).name)
        return real(source, target, *args, **kwargs)
    monkeypatch.setattr(store_module.os, "replace", spy)
    _purge(store, x)
    assert order.index(store_module.PURGED_NAME) < order.index("catalog.json")


def _crash_at_the_catalog_rename(monkeypatch):
    """The process dies at the catalog's rename: the side file already
    landed, the rename didn't, and nothing after it runs."""
    real = os.replace

    def dies(source, target, *args, **kwargs):
        if Path(target).name == "catalog.json":
            raise OSError("power lost")
        return real(source, target, *args, **kwargs)
    monkeypatch.setattr(store_module.os, "replace", dies)
    monkeypatch.setattr(ProjectStore, "_undo_side_file", lambda self, *args, **kwargs: None, raising=False)


def test_l3_a_crash_after_the_side_file_and_before_the_rename_of_a_delete_for_good(tmp_path, monkeypatch):
    """The person deleted X for good; the side file landed, catalog.json
    didn't (X still in Recently deleted). A zeroed catalog then keeps X
    deleted, as the person asked, with a row."""
    store, _alpha, x = _purge_setup(tmp_path)
    _crash_at_the_catalog_rename(monkeypatch)
    with pytest.raises(Exception):
        _purge(store, x)
    monkeypatch.undo()
    assert x in json.loads(store.path.read_text())["trash"]
    _zero(store)
    fresh = ProjectStore(store.root)
    restored = fresh.read()
    assert _where(restored, x) == "gone"
    assert [row["id"] for row in _record(fresh)["keptDeleted"]] == [x]


def test_l3_a_crash_before_a_remake_lands_keeps_the_delete_that_did_land(tmp_path, monkeypatch):
    """X was deleted for good (landed), then made again with its id; that
    commit's side file landed (X no longer purged), its catalog rename
    didn't. catalog.json is the delete's; zeroed, .bak still has X in
    Recently deleted: the side file's earlier layer keeps X deleted."""
    store, _alpha, x = _purge_setup(tmp_path)
    _purge(store, x)
    _crash_at_the_catalog_rename(monkeypatch)
    with pytest.raises(Exception):
        with store.transaction() as catalog:
            again = make_project("Xgone (made again)")
            again["id"] = x
            catalog["projects"][x] = again
            store.commit(catalog)
    monkeypatch.undo()
    assert x not in json.loads(store.path.read_text())["projects"]
    _zero(store)
    restored = ProjectStore(store.root).read()
    assert _where(restored, x) == "gone"


# -- L-2: MCP gets the whole refusal ---------------------------------------------------


def test_l2_mcp_restore_from_trash_says_the_413_the_limit_and_its_number(app, monkeypatch):
    client, store, graph, state = app
    ids = _unfiled_at_the_limit(client, store, graph, state, monkeypatch, "e" * 32)
    client.get("/api/projects", headers=PERSON)
    client.request("DELETE", f"/api/projects/{ids[0]}", headers=PERSON, json={"workspaceRevision": _rev(client)})
    client.get("/api/projects", headers=PERSON)  # the waiting canvas takes the slot
    http = client.post(f"/api/trash/project/{ids[0]}/restore", headers=AGENT)
    assert http.status_code == 413
    monkeypatch.setattr(mcp_server, "_api", lambda: NebulaAPI("http://testserver", client=client))
    with pytest.raises(Exception) as raised:
        asyncio.run(mcp_server.mcp.call_tool("restore_from_trash", {"kind": "project", "id": ids[0]}))
    text = str(raised.value)
    assert "413" in text and http.json()["detail"] in text
    assert '"limit": "projects"' in text and '"projectLimit": 3' in text


# -- M-3: the waiting canvas is held aside --------------------------------------------


_real_commit_prepared = ProjectStore.commit_prepared


def _waiting(client, store, graph, state, monkeypatch, owner="e" * 32) -> list[str]:
    """Three projects at a limit of 3, the live canvas unfiled and waiting,
    holding a node no project has. Added as the person's (no tab: the person
    can't reach a waiting canvas from one), since an agent's add at the
    limit is refused from fix round 6 on (review 6, M-1)."""
    ids = _unfiled_at_the_limit(client, store, graph, state, monkeypatch, owner)
    listing = client.get("/api/projects", headers=PERSON).json()
    assert listing["canvasNotFiled"]["reason"] == "projects"
    added = client.post("/api/graph/node", headers=PERSON, json={"definitionId": "text-input", "params": {"value": ONLY_W}})
    assert added.status_code == 200, added.text
    return ids


def _live_values(graph) -> list[str]:
    return sorted(str((node.get("params") or {}).get("value")) for node in graph.nodes.values())


def _held(store) -> list[dict]:
    return store.canvas_held()


def _held_values(entry: dict) -> list[str]:
    return sorted(str((node.get("data") or {}).get("params", {}).get("value")) for node in entry["nodes"])


def _free_a_slot(client, project_id: str) -> dict:
    response = client.request("DELETE", f"/api/projects/{project_id}", headers=PERSON,
                              json={"workspaceRevision": _rev(client)})
    assert response.status_code == 200, response.text
    return client.get("/api/projects", headers=PERSON).json()


def _projects_holding(client, store, value: str) -> list[str]:
    catalog = json.loads(store.path.read_text())
    return sorted(project["name"] for project in [*catalog["projects"].values(), *(catalog.get("trash") or {}).values()]
                  if value in _values(project))


def test_m3_opening_a_project_while_the_canvas_waits_holds_it_and_opens(app, monkeypatch):
    client, store, graph, state = app
    ids = _waiting(client, store, graph, state, monkeypatch)
    opened = client.post(f"/api/projects/{ids[1]}/open", headers=PERSON, json={"workspaceRevision": _rev(client)})
    assert opened.status_code == 200, opened.text
    assert json.loads(store.path.read_text())["activeProjectId"] == ids[1]
    (held,) = _held(store)
    assert ONLY_W in _held_values(held) and "c1" in _held_values(held)
    listing = client.get("/api/projects", headers=PERSON).json()
    assert listing["activeProjectId"] == ids[1]
    assert listing["canvasNotFiled"]["reason"] == "projects" and listing["canvasNotFiled"]["held"] == 1
    assert "held aside" in listing["canvasNotFiled"]["note"]
    # The person works in B; then room frees: only the held copy is filed.
    _add_text(client, "typed-in-B")
    after = _free_a_slot(client, ids[0])
    assert after["canvasSaved"]["name"] == "Recovered canvas"
    assert "canvasNotFiled" not in after
    assert _projects_holding(client, store, ONLY_W) == ["Recovered canvas"]
    assert "typed-in-B" not in _projects_holding(client, store, ONLY_W)
    assert _held(store) == []
    assert after["activeProjectId"] == ids[1]


def test_m3_an_agent_can_open_an_existing_project_while_the_canvas_waits(app, monkeypatch):
    """GM's refusal tells agents to open an existing project: it must work."""
    client, store, graph, state = app
    ids = _waiting(client, store, graph, state, monkeypatch)
    monkeypatch.setattr(mcp_server, "_api", lambda: NebulaAPI("http://testserver", client=client))
    result = asyncio.run(mcp_server.mcp.call_tool("open_project", {"project_id": ids[2]}))
    assert ids[2] in str(result)
    assert json.loads(store.path.read_text())["activeProjectId"] == ids[2]
    assert len(_held(store)) == 1


@pytest.mark.parametrize("route", ["import", "clear"])
@pytest.mark.parametrize("who", ["agent", "person"])
def test_m3_a_clear_or_graph_load_at_the_limit_is_refused_and_changes_nothing(app, monkeypatch, route, who):
    client, store, graph, state = app
    _waiting(client, store, graph, state, monkeypatch)
    before = _live_values(graph)
    headers = AGENT if who == "agent" else {**PERSON, "X-Nebula-Workspace-Revision": _rev(client)}
    if route == "import":
        response = client.post("/api/graph/import", headers=headers,
                               json={"nodes": [{"id": "x1", "definitionId": "text-input", "params": {"value": "imported"}}], "edges": []})
    else:
        response = client.request("DELETE", "/api/graph?force=true", headers=headers)
    assert response.status_code == 409, response.text
    body = response.json()
    assert body["code"] == "canvas_waiting" and body["reason"] == "projects"
    # GM r11 #3 (fix round 9): the person's own lines were dropped as
    # unreachable from the tab; a person request that gets here anyway is
    # still refused, in the one set of lines.
    assert body["detail"] == main_module.CANVAS_WAITING_REFUSAL
    assert _live_values(graph) == before and _held(store) == []


def test_m3_the_refusal_lines(app):
    assert main_module.CANVAS_WAITING_REFUSAL == ("The project limit is reached, so a new canvas can't be saved. "
                                                  "Open an existing project to work in, or ask the person to delete a project.")
    assert main_module.CANVAS_WAITING_REFUSAL_STORAGE == (
        "Nebula's project list is full, so a new canvas can't be saved. Open an existing project to work in, or ask "
        "the person to permanently delete a project in Recently deleted.")


def test_m3_an_agents_refused_clear_tells_the_person_in_the_agent_log(app, monkeypatch):
    client, store, graph, state = app
    _waiting(client, store, graph, state, monkeypatch)
    sent = main_module.manager.broadcast_raw
    sent.reset_mock()
    client.request("DELETE", "/api/graph?force=true", headers=AGENT)
    events = [call.args[0] for call in sent.call_args_list if call.args and call.args[0].get("type") == "projectsChanged"]
    assert events[-1]["change"] == "canvasHoldRefused"
    assert {"action": "clear", "agent": "Probe", "agentId": "ext:probe"}.items() <= events[-1]["canvasHeld"].items()


def _make_room_without_listing(client, store, project_id: str) -> None:
    """An agent's delete frees a slot; no listing has run since, so the
    canvas still waits (start_here's roomNow)."""
    response = client.request("DELETE", f"/api/projects/{project_id}", headers=AGENT,
                              json={"workspaceRevision": json.loads(store.path.read_text())["workspaceRevision"]})
    assert response.status_code == 200, response.text


@pytest.mark.parametrize("route", ["import", "clear"])
def test_m3_below_the_limit_a_clear_or_load_holds_the_canvas_first(app, monkeypatch, route):
    """Below the limit (room freed, no listing since) the agent's clear or
    load works after the hold; its new canvas is the ordinary unfiled one,
    never filed as the person's; the held copy is."""
    client, store, graph, state = app
    ids = _waiting(client, store, graph, state, monkeypatch)
    _make_room_without_listing(client, store, ids[0])
    sent = main_module.manager.broadcast_raw
    sent.reset_mock()
    if route == "import":
        response = client.post("/api/graph/import", headers=AGENT,
                               json={"nodes": [{"id": "x1", "definitionId": "text-input", "params": {"value": "agent-new"}}], "edges": []})
    else:
        response = client.request("DELETE", "/api/graph?force=true", headers=AGENT)
    assert response.status_code == 200, response.text
    # Fix round 8 (GM's rule (a)): filed untouched first, never opened.
    assert response.json()["savedCanvas"]["name"] == "Recovered canvas"
    assert _held(store) == []
    events = [call.args[0] for call in sent.call_args_list if call.args and call.args[0].get("type") == "projectsChanged"]
    action = "replaced" if route == "import" else "cleared"
    # The agent's own row from fix round 6 on (GM r7): its id and colour too.
    assert any(event.get("change") == "canvasHeld" and {"action": action, "agent": "Probe", "agentId": "ext:probe",
                                                        "savedAs": "Recovered canvas"}.items()
               <= (event.get("canvasHeld") or {}).items() for event in events)
    listing = client.get("/api/projects", headers=PERSON).json()
    assert listing["canvasSaved"]["name"] == "Recovered canvas"
    assert _projects_holding(client, store, ONLY_W) == ["Recovered canvas"]
    assert _projects_holding(client, store, "agent-new") == []
    assert listing["activeProjectId"] is None
    assert _held(store) == []


def test_m3_the_hold_is_on_disk_before_the_open_writes_the_canvas(app, monkeypatch):
    client, store, graph, state = app
    ids = _waiting(client, store, graph, state, monkeypatch)
    seen: list[bool] = []
    real = CLIGraph.save

    def save(self, path, *args, **kwargs):
        seen.append(any(ONLY_W in _held_values(entry) for entry in store.canvas_held()))
        return real(self, path, *args, **kwargs)
    monkeypatch.setattr(CLIGraph, "save", save)
    response = client.post(f"/api/projects/{ids[1]}/open", headers=PERSON, json={"workspaceRevision": _rev(client)})
    assert response.status_code == 200, response.text
    assert seen and all(seen)


def test_m3_a_failed_open_keeps_its_hold_and_the_next_settle_drops_it_by_digest(app, monkeypatch):
    """Fix round 6 (review 6, L-2): a failed open never gives its hold back;
    the next settle drops the copy because the live canvas, on disk too, is
    that canvas, so it is filed once."""
    client, store, graph, state = app
    ids = _waiting(client, store, graph, state, monkeypatch)

    def boom(self, temporary):
        raise OSError("rename failed")
    monkeypatch.setattr(ProjectStore, "commit_prepared", boom)
    response = client.post(f"/api/projects/{ids[1]}/open", headers=PERSON, json={"workspaceRevision": _rev(client)})
    monkeypatch.setattr(ProjectStore, "commit_prepared", _real_commit_prepared)
    assert response.status_code == 507
    assert len(_held(store)) == 1 and ONLY_W in _live_values(graph)
    client.get("/api/projects", headers=PERSON)
    assert _held(store) == []
    _free_a_slot(client, ids[0])
    assert _projects_holding(client, store, ONLY_W) == ["Recovered canvas"]


def test_m3_a_crash_between_the_hold_and_the_open_files_the_canvas_once(app, monkeypatch):
    """The process dies after the hold landed and before the open's commit:
    state.json still holds the waiting canvas, and canvas-held.json a copy
    of it. After the restart it is one canvas, filed once."""
    client, store, graph, state = app
    ids = _waiting(client, store, graph, state, monkeypatch)

    def dies(self, temporary):
        raise OSError("power lost")
    monkeypatch.setattr(ProjectStore, "commit_prepared", dies)
    client.post(f"/api/projects/{ids[1]}/open", headers=PERSON, json={"workspaceRevision": _rev(client)})
    monkeypatch.setattr(ProjectStore, "commit_prepared", _real_commit_prepared)
    assert len(_held(store)) == 1
    graph = _restart(monkeypatch, state, store)
    listing = client.get("/api/projects", headers=PERSON).json()
    assert listing["canvasNotFiled"].get("held", 0) == 0
    assert _held(store) == []
    after = _free_a_slot(client, ids[0])
    assert after["canvasSaved"]["name"] == "Recovered canvas"
    assert _projects_holding(client, store, ONLY_W) == ["Recovered canvas"]


def test_m3_a_crash_after_the_canvas_switched_and_before_the_catalog_files_the_held_copy_once(app, monkeypatch):
    """The process dies after state.json became B's and before the catalog
    said B is open: after the restart B is open (its canvas says so), and
    the held copy is filed once there is room."""
    client, store, graph, state = app
    ids = _waiting(client, store, graph, state, monkeypatch)
    real_prepare = ProjectStore.prepare

    class PowerLost(BaseException):
        pass

    def dies(self, temporary):
        raise PowerLost()
    monkeypatch.setattr(ProjectStore, "commit_prepared", dies)
    # Starlette's middleware hands a BaseException on in an exception group.
    with pytest.raises(BaseException) as raised:
        client.post(f"/api/projects/{ids[1]}/open", headers=PERSON, json={"workspaceRevision": _rev(client)})
    assert raised.group_contains(PowerLost) if isinstance(raised.value, BaseExceptionGroup) else raised.type is PowerLost
    monkeypatch.setattr(ProjectStore, "commit_prepared", _real_commit_prepared)
    monkeypatch.setattr(ProjectStore, "prepare", real_prepare)
    graph = _restart(monkeypatch, state, store)
    listing = client.get("/api/projects", headers=PERSON).json()
    assert listing["activeProjectId"] == ids[1]
    assert listing["canvasNotFiled"]["held"] == 1
    after = _free_a_slot(client, ids[0])
    assert _projects_holding(client, store, ONLY_W) == ["Recovered canvas"]
    assert after["activeProjectId"] == ids[1]


def test_m3_the_hold_survives_restarts(app, monkeypatch):
    client, store, graph, state = app
    ids = _waiting(client, store, graph, state, monkeypatch)
    client.post(f"/api/projects/{ids[1]}/open", headers=PERSON, json={"workspaceRevision": _rev(client)})
    since = client.get("/api/projects", headers=PERSON).json()["canvasNotFiled"]["since"]
    for _ in range(2):
        _restart(monkeypatch, state, store)
        waiting = client.get("/api/projects", headers=PERSON).json()["canvasNotFiled"]
        assert waiting["held"] == 1 and waiting["since"] == since
    _free_a_slot(client, ids[0])
    assert _projects_holding(client, store, ONLY_W) == ["Recovered canvas"]


def test_m3_two_windows_open_projects_one_hold(app, monkeypatch):
    client, store, graph, state = app
    ids = _waiting(client, store, graph, state, monkeypatch)
    first = client.post(f"/api/projects/{ids[1]}/open", headers=PERSON, json={"workspaceRevision": _rev(client)})
    second = client.post(f"/api/projects/{ids[2]}/open", headers=PERSON, json={"workspaceRevision": _rev(client)})
    assert first.status_code == 200 and second.status_code == 200
    assert len(_held(store)) == 1
    _free_a_slot(client, ids[0])
    assert _projects_holding(client, store, ONLY_W) == ["Recovered canvas"]


def test_m3_an_agent_opening_right_after_more_edits_holds_every_edit(app, monkeypatch):
    client, store, graph, state = app
    ids = _waiting(client, store, graph, state, monkeypatch)
    for value in ("typed-1", "typed-2"):
        client.post("/api/graph/node", headers=PERSON, json={"definitionId": "text-input", "params": {"value": value}})
    response = client.post(f"/api/projects/{ids[1]}/open", headers=AGENT, json={"workspaceRevision": _rev(client)})
    assert response.status_code == 200, response.text
    (held,) = _held(store)
    assert {"typed-1", "typed-2", ONLY_W} <= set(_held_values(held))


def test_m3_undo_across_the_hold_never_reaches_the_held_canvas(app, monkeypatch):
    """Below the limit an agent's apply holds the waiting canvas first (fix
    round 6, M-1), then lands on the canvas with no project; its undo then
    works there and never reaches the held copy."""
    client, store, graph, state = app
    ids = _waiting(client, store, graph, state, monkeypatch)
    _make_room_without_listing(client, store, ids[0])
    applied = client.post("/api/graph/apply", headers=AGENT,
                          json={"note": "x", "nodes": [{"ref": "+a", "definitionId": "text-input", "params": {"value": "applied"}}]})
    assert applied.status_code == 200, applied.text
    # Fix round 8 (GM's rule (a)): the person's canvas is filed first, and
    # the apply is on a copy (waiting: the free place went to the canvas).
    assert _held(store) == []
    assert _projects_holding(client, store, ONLY_W) == ["Recovered canvas"]
    token = applied.json()["undo"]["token"]
    client.post("/api/graph/apply/undo", headers=AGENT, json={"token": token})
    client.get("/api/projects", headers=PERSON)
    assert _projects_holding(client, store, ONLY_W) == ["Recovered canvas"]
    assert _projects_holding(client, store, "applied") == []


def test_m3_two_waiting_canvases_are_held_and_filed_separately(app, monkeypatch):
    client, store, graph, state = app
    ids = _waiting(client, store, graph, state, monkeypatch)
    client.post(f"/api/projects/{ids[1]}/open", headers=PERSON, json={"workspaceRevision": _rev(client)})
    # A second canvas waits (another restore at the limit left B's canvas unfiled).
    _add_text(client, "second-canvas")
    graph = main_module.cli_graph
    graph.owner = "d" * 32
    graph.save(state)
    client.get("/api/projects", headers=PERSON)
    client.post(f"/api/projects/{ids[2]}/open", headers=PERSON, json={"workspaceRevision": _rev(client)})
    assert len(_held(store)) == 2
    _free_a_slot(client, ids[0])
    _free_a_slot(client, ids[1])
    assert _projects_holding(client, store, ONLY_W) == ["Recovered canvas"]
    assert _projects_holding(client, store, "second-canvas") == ["Recovered canvas 2"]


def test_m3_create_at_the_limit_still_refuses_and_keeps_the_canvas(app, monkeypatch):
    client, store, graph, state = app
    _waiting(client, store, graph, state, monkeypatch)
    response = client.post("/api/projects", headers=PERSON, json={"name": "New", "workspaceRevision": _rev(client)})
    assert response.status_code == 413
    assert ONLY_W in _live_values(graph) and _held(store) == []


def test_m3_graph_load_from_the_cli_and_mcp_says_the_refusal(app, monkeypatch, tmp_path):
    import graph_file_client

    client, store, graph, state = app
    _waiting(client, store, graph, state, monkeypatch)
    path = tmp_path / "g.json"
    path.write_text(json.dumps({"nodes": [{"id": "x1", "definitionId": "text-input", "params": {"value": "file"}}], "edges": []}))
    api = NebulaAPI("http://testserver", client=client)
    with pytest.raises(graph_file_client.GraphFileError) as raised:
        graph_file_client.load(api, str(path), via="cli", headers={"X-Nebula-Agent": "Probe"})
    text = str(raised.value)
    assert main_module.CANVAS_WAITING_REFUSAL in text and "canvas_waiting" in text
    monkeypatch.setattr(mcp_server, "_api", lambda: api)
    with pytest.raises(Exception) as from_mcp:
        asyncio.run(mcp_server.mcp.call_tool("load_graph_file", {"path": str(path)}))
    assert main_module.CANVAS_WAITING_REFUSAL in str(from_mcp.value)
    assert ONLY_W in _live_values(main_module.cli_graph)


def test_m3_nothing_in_it_is_lost_on_every_path(app, monkeypatch):
    """Every route that replaces or clears the live canvas, taken while it
    waits at the limit: each refuses or holds it, and once room frees,
    exactly one project holds the waiting canvas."""
    client, store, graph, state = app
    ids = _waiting(client, store, graph, state, monkeypatch)
    import_body = {"nodes": [{"id": "x1", "definitionId": "text-input", "params": {"value": "imported"}}], "edges": []}
    for who in (PERSON, AGENT):
        rev = {**who, "X-Nebula-Workspace-Revision": _rev(client)}
        client.post("/api/graph/import", headers=rev, json=import_body)
        client.request("DELETE", "/api/graph?force=true", headers=rev)
        client.post("/api/projects", headers=who, json={"name": "N", "workspaceRevision": _rev(client)})
        client.get("/api/projects", headers=who)
    client.post(f"/api/projects/{ids[1]}/open", headers=AGENT, json={"workspaceRevision": _rev(client)})
    client.post(f"/api/projects/{ids[2]}/open", headers=PERSON, json={"workspaceRevision": _rev(client)})
    client.request("DELETE", "/api/graph?force=true", headers=AGENT)  # C's canvas, no longer the waiting one
    _free_a_slot(client, ids[0])
    assert _projects_holding(client, store, ONLY_W) == ["Recovered canvas"]
    assert _held(store) == []


# The route-coverage test (every canvas replacement) became fix round 6's
# fence-based one: tests/test_project_catalog_restore_fix6.py (review 6, N-6).
