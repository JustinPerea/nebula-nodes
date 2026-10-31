"""PR #199 review 3: what fix round 3 makes true (2026-10-27).

- M1 (agents' half). The restore's rows that no longer hold (the project
  moved since) are marked and left out of the agents' note.
- M2. Salvage also finds a record by its own leading ``{"id":"<hex>"``, so
  a broken key never silently drops a record that still holds its id.
- L1. A bit flip in a copy's ``version`` is damage, not a newer Nebula's,
  when catalog.json's own head says version 1 or another copy can do the
  restore; a file this process committed whose version changed in place is
  damage too; a real newer catalog still refuses.
- L2. A nested object inside a snapshot is never counted as a project.
- L3. A tombstone is decided by file order, never by a creation time a
  skewed clock wrote, and a record it drops always has a row.
- L4. Create one below the limit never files the canvas and then refuses;
  state.json never owns a project that doesn't exist.
- L5. The unfiled canvas is said outside the restore notice (the listing,
  start_here, `nebula context`), with its own agents' note; ``since`` and
  the journal event hold across restarts.
- L6. An in-place rewrite that keeps the file's signature is read strictly.
- L7. The cover follow never reads the catalog on the event loop.
"""
from __future__ import annotations

import asyncio
import json
import os
import shutil
import sys
import threading
import time
from datetime import datetime, timedelta, timezone
from pathlib import Path

import pytest

sys.path.insert(0, str(Path(__file__).resolve().parent.parent))
import main as main_module  # noqa: E402
from cli.formatter import format_start  # noqa: E402
from services import catalog_recovery  # noqa: E402
from services import project_store as store_module  # noqa: E402
from services.cli_graph import CLIGraph, OWNER_UNPROVEN  # noqa: E402
from services.project_store import ProjectStore, ProjectStoreError, make_project, move_to_trash  # noqa: E402
from tests.conftest import PERSON  # noqa: E402
from tests.test_project_catalog_restore_fix2 import _add_text, _create, _rev, _values, app  # noqa: E402,F401


def _record(store: ProjectStore) -> dict:
    return json.loads(store.record_path.read_text())["restores"][-1]


# -- M2: a broken key never drops a record that holds its own id ---------------------


def _logo_renamed_after_the_copy(tmp_path: Path):
    """Review 3's fuzz base: four projects and one in Recently deleted; Logo
    renamed "Logo v2" after the copy (.bak still says "Logo")."""
    store = ProjectStore(tmp_path / "base")
    with store.transaction() as catalog:
        logo, hero, dunes, old = (make_project(name) for name in ("Logo", "Hero", "Dunes", "Old"))
        for project in (logo, hero, dunes, old):
            catalog["projects"][project["id"]] = project
        dunes["snapshot"]["nodes"] = [{"id": "n1", "data": {"params": {"refs": {hero["id"]: {"url": "/x.png"}}}}}]
        catalog["activeProjectId"] = logo["id"]
        store.commit(catalog)
    with store.transaction() as catalog:
        move_to_trash(catalog, old["id"])
        store.commit(catalog)
    time.sleep(0.002)
    with store.transaction() as catalog:
        catalog["projects"][logo["id"]]["name"] = "Logo v2"
        catalog["projects"][logo["id"]]["updatedAt"] = store_module.now()
        store.commit(catalog)
    return store, {"logo": logo["id"], "hero": hero["id"], "dunes": dunes["id"], "old": old["id"]}


def _restore_with(base: ProjectStore, root: Path, damaged: bytes) -> tuple[ProjectStore, dict]:
    if root.exists():
        shutil.rmtree(root)
    root.mkdir(parents=True)
    for name in (store_module.BACKUP_NAME, store_module.OLDER_BACKUP_NAME):
        if (base.root / name).exists():
            shutil.copy2(base.root / name, root / name)
    (root / "catalog.json").write_bytes(damaged)
    store = ProjectStore(root)
    return store, store.read()


def _verdict(store: ProjectStore, catalog: dict, ids: dict) -> str:
    restore = store.restore_notice()
    if restore is None:
        held = set(catalog["projects"]) | set(catalog.get("trash") or {})
        return "no-restore" if held == set(ids.values()) else "IDS-DIFFER"
    problems = []
    if (set(catalog["projects"]) | set(catalog.get("trash") or {})) - set(ids.values()):
        problems.append("WRONG-ID")
    for key in ("logo", "hero", "dunes"):
        if ids[key] not in catalog["projects"]:
            problems.append(f"{key}-NOT-IN-LIST")
    if ids["old"] not in (catalog.get("trash") or {}):
        problems.append("old-NOT-IN-TRASH")
    said = {row["id"] for row in [*restore["reverted"], *restore["notAddedBack"]]}
    logo = catalog["projects"].get(ids["logo"])
    if logo is not None and logo["name"] != "Logo v2" and ids["logo"] not in said:
        problems.append("SILENT-REVERT")
    for key in ("cameBack", "backInTrash", "keptDeleted", "addedBack"):
        if restore.get(key):
            problems.append(f"FALSE-{key}")
    return ";".join(problems) or "ok"


@pytest.mark.parametrize("change", [
    pytest.param(lambda raw, at: raw[:at] + b"#" + raw[at + 1:], id="opening quote -> #"),
    pytest.param(lambda raw, at: raw[:at + 1] + b"\x13" + raw[at + 2:], id="first hex digit -> control byte"),
    pytest.param(lambda raw, at: raw[:at + 1] + bytes([raw[at + 1] | 0x80]) + raw[at + 2:], id="high bit (not UTF-8)"),
    pytest.param(lambda raw, at: raw[:at + 33] + b"#" + raw[at + 34:], id="closing quote -> #"),
    pytest.param(lambda raw, at: raw[:at + 34] + b";" + raw[at + 35:], id="colon -> ;"),
])
def test_m2_a_broken_key_keeps_the_records_latest_version(tmp_path, change):
    """Review 3's M-A (test_r3_debug): the file no longer parses, the record
    behind the key is whole and holds its own id. Its newest version stays."""
    base, ids = _logo_renamed_after_the_copy(tmp_path)
    raw = base.path.read_bytes()
    at = raw.index(f'"{ids["logo"]}":{{'.encode())
    damaged = change(raw, at)
    with pytest.raises(ValueError):
        json.loads(damaged.decode("utf-8"))
    store, catalog = _restore_with(base, tmp_path / "t", damaged)
    assert catalog["projects"][ids["logo"]]["name"] == "Logo v2"
    assert _verdict(store, catalog, ids) == "ok"
    assert _record(store)["damagedReadWhole"] is False


def test_m2_the_reviews_272_flips_in_a_changed_records_key_never_revert_it_silently(tmp_path):
    """Review 3's fuzz, the region that failed (69 of 272 silent reverts):
    every bit of every byte of the key of the project changed since the copy."""
    base, ids = _logo_renamed_after_the_copy(tmp_path)
    raw = base.path.read_bytes()
    at = raw.index(f'"{ids["logo"]}":{{'.encode())
    tally: dict[str, int] = {}
    for position in range(at, at + 34):
        for bit in range(8):
            flipped = bytearray(raw)
            flipped[position] ^= 1 << bit
            store, catalog = _restore_with(base, tmp_path / "t", bytes(flipped))
            verdict = _verdict(store, catalog, ids)
            tally[verdict] = tally.get(verdict, 0) + 1
    assert sum(tally.values()) == 272
    assert set(tally) <= {"ok", "no-restore"}, tally


def test_m2_the_id_field_and_section_flips_still_hold(tmp_path):
    base, ids = _logo_renamed_after_the_copy(tmp_path)
    raw = base.path.read_bytes()
    text = raw.decode()
    regions = [text.index(f'"id":"{ids["logo"]}"'), text.index('"projects"'), text.index('"trash"')]
    bad = {}
    for start in regions:
        for position in range(start, start + 10):
            for bit in range(8):
                flipped = bytearray(raw)
                flipped[position] ^= 1 << bit
                store, catalog = _restore_with(base, tmp_path / "t", bytes(flipped))
                verdict = _verdict(store, catalog, ids)
                if verdict not in ("ok", "no-restore"):
                    bad[(position - start, bit)] = verdict
    assert bad == {}


def test_m2_a_whole_record_shaped_object_nested_in_a_torn_snapshot_is_not_a_project():
    """The record anchor finds objects by their leading id: one nested in a
    snapshot (a node holding a copy of a project, after a torn page) sits
    deeper than any record, and is never taken."""
    alpha = make_project("Alpha")
    ghost = make_project("Ghost")
    alpha["snapshot"]["nodes"] = [{"id": "n1", "data": {"params": {"pad": "x" * 300}}},
                                  {"id": "n2", "data": {"params": {"copy": ghost}}}]
    catalog = {"version": 1, "activeProjectId": None, "workspaceRevision": "r",
               "projects": {alpha["id"]: alpha}, "trash": {}}
    text = json.dumps(catalog, separators=(",", ":"))
    at = text.index('"pad"')
    torn = text[:at] + "\x00" * 16 + text[at + 16:]
    found = catalog_recovery.salvage(torn.encode())
    assert ghost["id"] not in found.entries and ghost["id"] not in found.failed
    assert not any(own == ghost["id"] for _key, own, _entry, _group in found.misfiled)
    assert set(found.failed) == {alpha["id"]}


def test_m2_a_whole_record_after_a_torn_one_with_a_broken_key_is_found_by_its_id():
    first, second = make_project("Logo"), make_project("Hero")
    catalog = {"version": 1, "activeProjectId": None, "workspaceRevision": "r",
               "projects": {first["id"]: first, second["id"]: second}, "trash": {}}
    text = json.dumps(catalog, separators=(",", ":"))
    at = text.index('"snapshot"', text.index(f'"{first["id"]}":{{')) + 12
    text = text[:at] + "\x00" * 8 + text[at + 8:]
    key = text.index(f'"{second["id"]}":{{')
    text = text[:key] + "#" + text[key + 1:]
    found = catalog_recovery.salvage(text.encode())
    assert second["id"] not in found.entries
    merged = catalog_recovery.reconcile(
        {"version": 1, "activeProjectId": None, "workspaceRevision": "r", "projects": {}, "trash": {}},
        [found], max_projects=500, room_bytes=10**9)
    assert second["id"] in merged.catalog["projects"]


# -- L2: the torn-after-torn rule never counts a nested object -----------------------


def test_l2_a_nested_record_shaped_object_after_a_cut_is_not_a_project():
    """Review 3's probe: {"<id>": {"id": "<id>", "name": "Shadow", "kind": ...}}
    in the tail of a torn snapshot read as "“Shadow”, a newer project,
    couldn't be added back"."""
    alpha, beta = make_project("Alpha"), make_project("Beta")
    shadow = "a" * 32
    alpha["snapshot"]["nodes"] = [
        {"id": "n1", "data": {"params": {"pad": "x" * 200}}},
        {"id": "n2", "data": {"params": {"library": {shadow: {"id": shadow, "name": "Shadow", "kind": "moodboard"},
                                                     beta["id"]: {"id": beta["id"], "name": "Beta"}}}}}]
    catalog = {"version": 1, "activeProjectId": alpha["id"], "workspaceRevision": "r",
               "projects": {alpha["id"]: alpha, beta["id"]: beta}, "trash": {}}
    text = json.dumps(catalog, separators=(",", ":"))
    at = text.index('"pad"')
    torn = text[:at] + "\x00" * 16 + text[at + 16:]
    found = catalog_recovery.salvage(torn.encode())
    assert shadow not in found.failed and shadow not in found.entries
    merged = catalog_recovery.reconcile(json.loads(json.dumps(catalog)), [found], max_projects=500, room_bytes=10**9)
    assert [row.get("name") for row in merged.not_added] == []


# -- L1: a flipped version bit is damage when something says so ----------------------


def test_l1_a_flipped_version_in_the_older_copy_never_blocks_a_restore_the_copy_can_do(tmp_path):
    base, ids = _logo_renamed_after_the_copy(tmp_path)
    root = tmp_path / "bak1"
    shutil.copytree(base.root, root)
    older = (root / "catalog.json.bak.1").read_bytes()
    (root / "catalog.json.bak.1").write_bytes(older.replace(b'"version":1', b'"version":3', 1))
    (root / "catalog.json").write_bytes(base.path.read_bytes()[:-30])
    store = ProjectStore(root)
    catalog = store.read()
    assert ids["logo"] in catalog["projects"]
    assert _record(store)["source"] == store_module.BACKUP_NAME


def test_l1_a_copy_claiming_a_newer_version_beside_a_version_1_head_is_a_damaged_copy(tmp_path):
    base, ids = _logo_renamed_after_the_copy(tmp_path)
    root = tmp_path / "bak"
    shutil.copytree(base.root, root)
    (root / "catalog.json.bak.1").unlink()
    copy = (root / "catalog.json.bak").read_bytes()
    (root / "catalog.json.bak").write_bytes(copy.replace(b'"version":1', b'"version":5', 1))
    raw = base.path.read_bytes()
    assert raw.startswith(b'{"version":1,')
    (root / "catalog.json").write_bytes(raw[:-30])  # its head still reads: version 1
    store = ProjectStore(root)
    catalog = store.read()
    assert ids["logo"] in catalog["projects"]
    record = _record(store)
    assert any(".bak.damaged-" in path for path in record["setAside"])


def test_l1_a_version_changed_in_place_in_a_file_this_process_committed_is_damage(tmp_path):
    base, ids = _logo_renamed_after_the_copy(tmp_path)
    store = base
    with store.transaction():
        pass  # the projection is this file's
    info = os.stat(store.path)
    raw = store.path.read_bytes()
    with open(store.path, "r+b") as handle:  # in place: same inode and size
        handle.write(raw.replace(b'"version":1', b'"version":9', 1))
    os.utime(store.path, ns=(info.st_atime_ns, info.st_mtime_ns))
    catalog = store.read()
    assert catalog["projects"][ids["logo"]]["name"] in ("Logo", "Logo v2")
    assert _record(store)["reason"] in ("invalid", "corrupt")


def test_l1_a_real_newer_catalog_still_refuses(tmp_path):
    base, _ids = _logo_renamed_after_the_copy(tmp_path)
    root = tmp_path / "newer"
    shutil.copytree(base.root, root)
    raw = (root / "catalog.json").read_bytes()
    (root / "catalog.json").write_bytes(raw.replace(b'"version":1', b'"version":2', 1))
    for _ in range(2):
        with pytest.raises(ProjectStoreError, match="newer version of Nebula"):
            ProjectStore(root).read()
    assert (root / "catalog.json").read_bytes().startswith(b'{"version":2')
    assert not list(root.glob("*.damaged-*"))


def test_l1_a_newer_catalog_and_copy_still_refuse_when_nothing_contradicts_them(tmp_path):
    base, _ids = _logo_renamed_after_the_copy(tmp_path)
    root = tmp_path / "newer2"
    shutil.copytree(base.root, root)
    (root / "catalog.json.bak.1").unlink()
    copy = (root / "catalog.json.bak").read_bytes()
    (root / "catalog.json.bak").write_bytes(copy.replace(b'"version":1', b'"version":2', 1))
    (root / "catalog.json").write_bytes(b"{not json")  # no head to read
    with pytest.raises(ProjectStoreError, match="newer version of Nebula"):
        ProjectStore(root).read()


# -- L3: tombstones are decided by file order, never by a skewed clock --------------


def test_l3_a_project_made_while_the_clock_was_ahead_stays_deleted_for_good(tmp_path):
    """Review 3's L-3 probe: created with the clock 3 h ahead, deleted for
    good after it was corrected, then a cut that keeps the head."""
    store = ProjectStore(tmp_path / "projects")
    ahead = (datetime.now(timezone.utc) + timedelta(hours=3)).isoformat()
    with store.transaction() as catalog:
        keep = make_project("Keep")
        doomed = make_project("Doomed")
        doomed["createdAt"] = doomed["updatedAt"] = doomed["lastOpenedAt"] = ahead
        catalog["projects"][keep["id"]] = keep
        catalog["projects"][doomed["id"]] = doomed
        store.commit(catalog)
    with store.transaction() as catalog:
        move_to_trash(catalog, doomed["id"])
        store.commit(catalog)
    with store.transaction() as catalog:
        del catalog["trash"][doomed["id"]]
        store.commit(catalog)
    assert doomed["id"] in (json.loads(store.backup_path.read_text()).get("trash") or {})
    store.path.write_bytes(store.path.read_bytes()[:-3])
    after = ProjectStore(tmp_path / "projects").read()
    assert doomed["id"] not in after["projects"] and doomed["id"] not in (after.get("trash") or {})
    rows = _record(store)["keptDeleted"]
    assert [row["id"] for row in rows] == [doomed["id"]]
    assert rows[0].get("createdAfterDelete") is True


# -- L4: create one below the limit ---------------------------------------------------


def test_l4_create_one_below_the_limit_never_files_the_canvas_then_refuses(app, monkeypatch):
    """Review 3's L-4 probe: limit 3, Alpha and Beta, and the open Gamma's
    canvas whose record is gone. A raw create (no listing first)."""
    client, store, _graph, state = app
    monkeypatch.setattr(store_module, "MAX_PROJECTS", 3)
    _create(client, "Alpha")
    _create(client, "Beta")
    gamma = _create(client, "Gamma")
    _add_text(client, "g1")
    client.get("/api/projects", headers=PERSON)
    with store.transaction() as catalog:
        del catalog["projects"][gamma]
        catalog["activeProjectId"] = next(iter(catalog["projects"]))
        store.commit(catalog)
    revision = json.loads(store.path.read_text())["workspaceRevision"]
    created = client.post("/api/projects", json={"name": "Delta", "workspaceRevision": revision}, headers=PERSON)
    assert created.status_code == 413 and created.json()["limit"] == "projects"
    catalog = json.loads(store.path.read_text())
    assert sorted(project["name"] for project in catalog["projects"].values()) == ["Alpha", "Beta"]
    assert json.loads(state.read_text())["projectId"] == gamma  # still its own canvas, no phantom owner
    listing = client.get("/api/projects", headers=PERSON).json()
    filed = [project for project in listing["projects"] if project["id"] == listing["activeProjectId"]]
    assert filed and filed[0]["name"] == "Recovered canvas"
    assert _values(json.loads(store.path.read_text())["projects"][filed[0]["id"]]) == ["g1"]


def test_l4_a_create_whose_commit_fails_after_filing_gives_the_canvas_its_owner_back(app, monkeypatch):
    client, store, _graph, state = app
    _create(client, "Alpha")
    gamma = _create(client, "Gamma")
    _add_text(client, "g1")
    client.get("/api/projects", headers=PERSON)
    with store.transaction() as catalog:
        del catalog["projects"][gamma]
        catalog["activeProjectId"] = next(iter(catalog["projects"]))
        store.commit(catalog)
    revision = json.loads(store.path.read_text())["workspaceRevision"]
    real = store.prepare

    def refuse_the_create(catalog):
        if any(project["name"] == "Delta" for project in catalog["projects"].values()):
            raise store_module.ProjectLimitError("Project storage limit reached", "storage")
        return real(catalog)

    monkeypatch.setattr(store, "prepare", refuse_the_create)
    created = client.post("/api/projects", json={"name": "Delta", "workspaceRevision": revision}, headers=PERSON)
    assert created.status_code == 413
    owner = json.loads(state.read_text())["projectId"]
    assert owner == gamma
    assert main_module.cli_graph.owner == gamma


# -- L5: the unfiled canvas, outside the notice and across restarts ------------------


def _journal_kinds(monkeypatch) -> list[str]:
    seen: list[str] = []
    real = main_module._journal

    def capture(kind, **kwargs):
        seen.append(kind)
        return real(kind, **kwargs)

    monkeypatch.setattr(main_module, "_journal", capture)
    return seen


def _restart(monkeypatch, state: Path, store: ProjectStore) -> CLIGraph:
    """A new process: state.json loaded again, module state empty."""
    graph = CLIGraph(persist_path=state)
    graph.load(state)
    monkeypatch.setattr(main_module, "cli_graph", graph)
    main_module._forget_canvas_waiting_cache()
    main_module._resolve_canvas_owner_at_boot(graph, store, state_loaded=True)
    return graph


def _unfiled_at_the_limit(client, store, graph, state, monkeypatch, owner):
    monkeypatch.setattr(store_module, "MAX_PROJECTS", 3)
    ids = [_create(client, name) for name in ("A", "B", "C")]
    _add_text(client, "c1")
    client.get("/api/projects", headers=PERSON)
    graph.owner = owner
    graph.save(state)
    return ids


@pytest.mark.parametrize("owner", ["e" * 32, OWNER_UNPROVEN], ids=["missing-id", "unproven"])
def test_l5_since_and_the_journal_event_hold_across_restarts(app, monkeypatch, owner):
    client, store, graph, state = app
    kinds = _journal_kinds(monkeypatch)
    _unfiled_at_the_limit(client, store, graph, state, monkeypatch, owner)
    first = client.get("/api/projects", headers=PERSON).json()["canvasNotFiled"]
    for _ in range(3):
        _restart(monkeypatch, state, store)
        again = client.get("/api/projects", headers=PERSON).json()["canvasNotFiled"]
        assert again["since"] == first["since"]
        assert again["reason"] == "projects"
    assert kinds.count("project.canvasNotFiled") == 1


def test_l5_the_listing_and_start_here_carry_the_unfiled_canvas_with_an_agents_note(app, monkeypatch):
    client, store, graph, state = app
    _unfiled_at_the_limit(client, store, graph, state, monkeypatch, "e" * 32)
    waiting = client.get("/api/projects", headers=PERSON).json()["canvasNotFiled"]
    assert waiting["reason"] == "projects" and waiting["projectLimit"] == 3
    assert "Recently deleted" in waiting["note"] and "Nothing in it is lost" in waiting["note"]
    start = client.get("/api/agent/start", headers=PERSON).json()
    assert start["canvasNotFiled"]["reason"] == "projects"
    assert start["canvasNotFiled"]["note"] == waiting["note"]
    printed = format_start(start)
    assert "CANVAS NOT SAVED AS A PROJECT" in printed and waiting["note"] in printed


def test_l5_storage_says_to_delete_for_good(app, monkeypatch):
    client, store, graph, state = app
    _create(client, "A")
    _add_text(client, "a1")
    client.get("/api/projects", headers=PERSON)
    graph.owner = "e" * 32
    graph.save(state)
    monkeypatch.setattr(main_module, "_filing_room", lambda catalog, exported: "storage")
    waiting = client.get("/api/projects", headers=PERSON).json()["canvasNotFiled"]
    assert waiting["reason"] == "storage"
    assert "for good" in waiting["note"]


def test_l5_a_saved_canvas_is_listed_once_with_its_name(app, monkeypatch):
    """The person's "saved" toast needs the filed project's name: the
    listing carries `canvasSaved` after a waiting canvas is filed."""
    client, store, graph, state = app
    ids = _unfiled_at_the_limit(client, store, graph, state, monkeypatch, "e" * 32)
    assert "canvasNotFiled" in client.get("/api/projects", headers=PERSON).json()
    client.request("DELETE", f"/api/projects/{ids[0]}", headers=PERSON, json={"workspaceRevision": _rev(client)})
    listing = client.get("/api/projects", headers=PERSON).json()
    assert "canvasNotFiled" not in listing
    saved = listing["canvasSaved"]
    assert saved["name"] == "Recovered canvas" and saved["id"] == listing["activeProjectId"]


# -- L6: an in-place rewrite that keeps the signature --------------------------------


def test_l6_an_in_place_rewrite_with_the_same_signature_is_read_strictly(tmp_path):
    store = ProjectStore(tmp_path / "projects")
    with store.transaction() as catalog:
        project = make_project("Logo")
        project["snapshot"]["viewport"] = {"x": 1.5, "y": 2.5, "zoom": 1.0}
        catalog["projects"][project["id"]] = project
        store.commit(catalog)
    with store.transaction():
        pass
    info = os.stat(store.path)
    raw = store.path.read_bytes()
    bad = raw.replace(b'"zoom":1.0', b'"zoom":1e999').replace(b'"name":"Logo"', b'"name":"Lo"', 1)
    assert len(bad) == len(raw)
    with open(store.path, "r+b") as handle:
        handle.write(bad)
    os.utime(store.path, ns=(info.st_atime_ns, info.st_mtime_ns))
    after = os.stat(store.path)
    assert (after.st_ino, after.st_mtime_ns, after.st_size) == (info.st_ino, info.st_mtime_ns, info.st_size)
    for name in ("Logo v2", "Logo v3"):
        with store.transaction() as catalog:
            catalog["projects"][project["id"]]["name"] = name
            store.commit(catalog)
    assert json.loads(store.path.read_text())["projects"][project["id"]]["name"] == "Logo v3"


def test_l6_a_save_that_cant_be_encoded_clears_the_projection(tmp_path):
    store = ProjectStore(tmp_path / "projects")
    with store.transaction() as catalog:
        project = make_project("Logo")
        catalog["projects"][project["id"]] = project
        store.commit(catalog)
    assert store._projection is not None
    with store.transaction() as catalog:
        catalog["projects"][project["id"]]["snapshot"]["viewport"] = {"zoom": float("inf")}
        with pytest.raises(ProjectStoreError):
            store.commit(catalog)
    assert store._projection is None


# -- L7: the cover follow never reads the catalog on the event loop ------------------


def test_l7_the_cover_follow_reads_the_open_project_off_the_loop(app, monkeypatch):
    client, store, _graph, _state = app
    project_id = _create(client, "Alpha")
    from services.agent_presence import AgentIdentity
    from services.asset_proposals import AssetProposal

    proposal = AssetProposal(id="ap_1", agent=AgentIdentity(id="a", name="Agent", color="#fff", verified=True),
                             kind="project", target_id=project_id, target_name="Alpha", change={"cover": None},
                             before={"cover": None, "coverBy": None}, note="", created_at=time.time(),
                             expires_at=time.time() + 600)
    monkeypatch.setattr(main_module.asset_proposals, "open_list", lambda: [proposal])
    monkeypatch.setattr(main_module, "_open_project_cache", None)
    threads: list[bool] = []
    real = store.read

    def watched():
        threads.append(threading.current_thread() is threading.main_thread())
        return real()

    monkeypatch.setattr(store, "read", watched)
    asyncio.run(main_module._follow_cover_proposals({"nodes": [], "edges": []}))
    assert threads and not any(threads)


# -- M1, agents' half: rows that no longer hold ---------------------------------------


def test_m1_a_row_that_no_longer_holds_is_marked_and_left_out_of_the_agents_note(app):
    """Hero was added back into Recently deleted; the person (or an agent)
    restores it: its "in Recently deleted" row isn't true any more."""
    client, store, _graph, _state = app
    _create(client, "Alpha")
    client.get("/api/projects", headers=PERSON)
    copy = store.path.read_bytes()
    hero = _create(client, "Hero")
    client.request("DELETE", f"/api/projects/{hero}", headers=PERSON, json={"workspaceRevision": _rev(client)})
    client.get("/api/projects", headers=PERSON)
    store.path.write_bytes(store.path.read_bytes()[:-2])
    store.backup_path.write_bytes(copy)
    store.older_backup_path.unlink(missing_ok=True)
    restore = client.get("/api/projects", headers=PERSON).json()["catalogRestore"]
    [row] = restore["addedBack"]
    assert row["id"] == hero and row["trashed"] is True and row.get("current", True) is True
    assert "1 project the copy lacked was added back" in restore["note"]
    assert client.post(f"/api/projects/{hero}/restore", headers=PERSON).status_code == 200
    listing = client.get("/api/projects", headers=PERSON).json()
    restore = listing["catalogRestore"]
    [row] = restore["addedBack"]
    assert row["current"] is False
    assert "the copy lacked" not in restore["note"]
    assert "no longer hold" in restore["note"]
    start = client.get("/api/agent/start", headers=PERSON).json()["catalogRestore"]
    assert start["addedBack"] == []
