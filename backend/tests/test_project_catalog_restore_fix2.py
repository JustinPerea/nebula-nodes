"""PR #199 review 2: a restore never reverts a project because a key was
damaged, the strict read stays off the hot path, and the bookkeeping around
a restored list is right (2026-10-27).

- M1. A catalog this process committed is decoded the fast way (its
  signature says it validated); only a file changed elsewhere gets the
  strict read.
- M2. Salvage takes a record's id from the record, checked against its key
  and the copy: a damaged key, id or section name never files a record
  under the wrong id or reads as "deleted, came back".
- L1. A tombstone decides only against older evidence: a project re-created
  with the same id after a delete for good survives a restore.
- L2. A reader on the event loop never restores or waits for a restore.
- L3. Without hard links .bak still follows every commit, and a restore
  takes the newest valid copy by what it holds.
- L4. Filing the live canvas at a limit never makes the listing fail.
- L5. A filing attaches to the restore it came from, and is journaled.
- L7. Damaged files age by when they were kept.
- Naming: the filed canvas is "<project> (recovered)", numbered.
"""
from __future__ import annotations

import asyncio
import json
import os
import sys
import threading
import time
from datetime import datetime, timedelta, timezone
from pathlib import Path
from unittest.mock import AsyncMock

import pytest
from fastapi.testclient import TestClient

sys.path.insert(0, str(Path(__file__).resolve().parent.parent))
import main as main_module  # noqa: E402
from services import catalog_recovery  # noqa: E402
from services import project_store as store_module  # noqa: E402
from services.cli_graph import CLIGraph, OWNER_UNPROVEN  # noqa: E402
from services.execution_runs import ExecutionRunRegistry  # noqa: E402
from services.project_store import ProjectStore, make_project  # noqa: E402
from services.provider_recovery import ProviderRecoveryStore  # noqa: E402
from services.provider_start_guard import ProviderStartGuard  # noqa: E402
from tests.conftest import PERSON  # noqa: E402


def _store(tmp_path: Path) -> ProjectStore:
    return ProjectStore(tmp_path / "projects")


def _add(store: ProjectStore, *names: str, project_id: str | None = None) -> list[str]:
    ids = []
    with store.transaction() as catalog:
        for name in names:
            project = make_project(name)
            if project_id is not None:
                project["id"] = project_id
            catalog["projects"][project["id"]] = project
            ids.append(project["id"])
        store.commit(catalog)
    return ids


def _rename(store: ProjectStore, project_id: str, name: str) -> None:
    time.sleep(0.002)
    with store.transaction() as catalog:
        catalog["projects"][project_id]["name"] = name
        catalog["projects"][project_id]["updatedAt"] = store_module.now()
        store.commit(catalog)


def _record(store: ProjectStore) -> dict:
    return json.loads(store.record_path.read_text())["restores"][-1]


def _flip(project_id: str, *, hex_valid: bool) -> str:
    """``project_id`` with one character changed the way one bit flip does:
    to another hex digit ('0' <-> '1') or out of hex ('f' -> 'g')."""
    last = project_id[-1]
    if hex_valid:
        other = "1" if last == "0" else "0"
    else:
        other = "g"
    return project_id[:-1] + other


# -- M1: the strict read stays off the hot path -----------------------------------


def test_m1_a_catalog_this_process_committed_is_read_the_fast_way(tmp_path, monkeypatch):
    """An id holding "1e123" (a digit, e, three digits) made every read of
    dcaafb82 strict: a Python callback per float and a full re-encode."""
    store = _store(tmp_path)
    [project_id] = _add(store, "Dunes", project_id="ab1e123" + "0" * 25)
    calls = []
    monkeypatch.setattr(catalog_recovery, "writable", lambda value: calls.append("writable") or True)
    real_loads = catalog_recovery.loads
    monkeypatch.setattr(catalog_recovery, "loads", lambda text: calls.append("strict") or real_loads(text))
    for _ in range(3):
        with store.transaction() as catalog:
            catalog["projects"][project_id]["snapshot"]["nodes"].append(
                {"id": f"n{len(catalog['projects'][project_id]['snapshot']['nodes'])}", "position": {"x": 1.5, "y": 2.5},
                 "data": {}})
            store.commit(catalog)
    with store.transaction():
        pass
    assert calls == []


def test_m1_a_file_changed_elsewhere_still_gets_the_strict_read(tmp_path):
    store = _store(tmp_path)
    [project_id] = _add(store, "Dunes")
    raw = store.path.read_text()
    # Written behind the store's back: a value it can't write back.
    store.path.write_text(raw.replace('"nodeCount":0', '"nodeCount":1e999', 1), encoding="utf-8")
    catalog = store.read()
    assert catalog["projects"][project_id]["nodeCount"] == 0
    assert _record(store)["reason"] == "corrupt"


def test_m1_nan_is_refused_on_every_read(tmp_path):
    """parse_constant always runs: NaN is damage, whoever wrote it."""
    store = _store(tmp_path)
    [project_id] = _add(store, "Dunes")
    raw = store.path.read_text()
    store.path.write_text(raw.replace('"nodeCount":0', '"nodeCount":NaN', 1), encoding="utf-8")
    assert store.read()["projects"][project_id]["nodeCount"] == 0


# -- M2: a damaged key never reverts a project or calls it deleted ------------------


@pytest.mark.parametrize("hex_valid", [False, True], ids=["non-hex flip", "hex flip"])
def test_m2_a_flip_in_a_records_key_keeps_its_latest_version(tmp_path, hex_valid):
    """Review 2's test_d (non-hex) and live2 (hex): the record parses whole
    under a damaged key. It keeps its newer version under its own id, and is
    never reported as deleted and back."""
    store = _store(tmp_path)
    [project_id] = _add(store, "Logo")
    _rename(store, project_id, "Logo v2")
    raw = store.path.read_text()
    key = f'"{project_id}":'
    assert raw.count(key) == 1
    store.path.write_text(raw.replace(key, f'"{_flip(project_id, hex_valid=hex_valid)}":'), encoding="utf-8")

    catalog = store.read()
    record = _record(store)
    assert catalog["projects"][project_id]["name"] == "Logo v2"
    assert _flip(project_id, hex_valid=True) not in catalog["projects"]
    assert record["cameBack"] == [] and record["reverted"] == []
    assert record["notAddedBack"] == []
    # The keys themselves were damaged: a project the file lacks is not
    # proven deleted, and nobody may say nothing was lost.
    assert record["damagedReadWhole"] is False


def test_m2_a_flip_in_a_records_id_files_it_under_the_key_the_copy_agrees_with(tmp_path):
    store = _store(tmp_path)
    [project_id] = _add(store, "Logo")
    _rename(store, project_id, "Logo v2")
    raw = store.path.read_text()
    field = f'"id":"{project_id}"'
    assert raw.count(field) == 1
    flipped = _flip(project_id, hex_valid=True)
    store.path.write_text(raw.replace(field, f'"id":"{flipped}"'), encoding="utf-8")

    catalog = store.read()
    record = _record(store)
    assert catalog["projects"][project_id]["name"] == "Logo v2"
    assert catalog["projects"][project_id]["id"] == project_id
    assert flipped not in catalog["projects"]
    assert record["cameBack"] == [] and record["notAddedBack"] == []


def test_m2_a_flipped_key_on_a_project_newer_than_the_copy_files_it_under_its_own_id(tmp_path):
    store = _store(tmp_path)
    _add(store, "Logo")
    [new_id] = _add(store, "New")  # .bak (one commit behind) lacks it
    raw = store.path.read_text()
    store.path.write_text(raw.replace(f'"{new_id}":', f'"{_flip(new_id, hex_valid=True)}":'), encoding="utf-8")

    catalog = store.read()
    record = _record(store)
    assert catalog["projects"][new_id]["name"] == "New"
    assert _flip(new_id, hex_valid=True) not in catalog["projects"]
    assert record["cameBack"] == []


def test_m2_a_flip_in_a_records_key_in_a_cut_file_keeps_its_latest_version(tmp_path):
    store = _store(tmp_path)
    [logo, dunes] = _add(store, "Logo", "Dunes")
    _rename(store, logo, "Logo v2")
    _rename(store, dunes, "Dunes v2")
    raw = store.path.read_text()
    first, second = sorted([(raw.index(f'"{logo}":'), logo), (raw.index(f'"{dunes}":'), dunes)])
    # The first record's key flipped (still hex), and the file cut inside the second.
    damaged = raw.replace(f'"{first[1]}":', f'"{_flip(first[1], hex_valid=True)}":')
    cut = damaged.index(f'"{second[1]}":') + 60
    store.path.write_text(damaged[:cut], encoding="utf-8")

    catalog = store.read()
    record = _record(store)
    names = {catalog["projects"][first[1]]["name"], catalog["projects"][second[1]]["name"]}
    assert f"{'Logo' if first[1] == logo else 'Dunes'} v2" in names
    assert _flip(first[1], hex_valid=True) not in catalog["projects"]
    assert [row["id"] for row in record["notAddedBack"]] == []
    assert [row["id"] for row in record["reverted"]] == [second[1]]


@pytest.mark.parametrize("section, flipped", [("projects", "projectr"), ("trash", "trasi")])
def test_m2_a_flip_in_a_section_name_keeps_what_the_section_held(tmp_path, section, flipped):
    store = _store(tmp_path)
    [logo, old] = _add(store, "Logo", "Old")
    with store.transaction() as catalog:
        store_module.move_to_trash(catalog, old)
        store.commit(catalog)
    time.sleep(0.002)
    with store.transaction() as catalog:
        catalog["projects"][logo]["name"] = "Logo v2"
        catalog["projects"][logo]["updatedAt"] = store_module.now()
        catalog["trash"][old]["name"] = "Old v2"
        catalog["trash"][old]["deletedAt"] = store_module.now()
        store.commit(catalog)
    raw = store.path.read_text()
    assert raw.count(f'"{section}":') == 1
    store.path.write_text(raw.replace(f'"{section}":', f'"{flipped}":'), encoding="utf-8")

    catalog = store.read()
    record = _record(store)
    assert catalog["projects"][logo]["name"] == "Logo v2"
    assert catalog["trash"][old]["name"] == "Old v2"
    assert record["cameBack"] == [] and record["reverted"] == [] and record["backInTrash"] == []
    assert record["damagedReadWhole"] is False


def test_m2_a_damaged_open_project_id_in_a_whole_file_is_not_reported_missing(tmp_path):
    """activeProjectId names a project the file doesn't hold: the value is
    damaged, not a project that didn't come back."""
    store = _store(tmp_path)
    [logo] = _add(store, "Logo")
    with store.transaction() as catalog:
        catalog["activeProjectId"] = logo
        store.commit(catalog)
    raw = store.path.read_text()
    field = f'"activeProjectId":"{logo}"'
    assert raw.count(field) == 1
    store.path.write_text(raw.replace(field, f'"activeProjectId":"{_flip(logo, hex_valid=True)}"'), encoding="utf-8")
    store.read()
    assert _record(store)["openProjectMissing"] is None


def test_m2_salvage_never_files_a_whole_record_under_a_key_that_differs_from_its_id():
    good = make_project("Logo")
    flipped = _flip(good["id"], hex_valid=True)
    catalog = {"version": 1, "activeProjectId": None, "workspaceRevision": "r",
               "projects": {flipped: good}, "trash": {}}
    raw = json.dumps(catalog).encode()
    found = catalog_recovery.salvage(raw, catalog)
    assert flipped not in found.entries and flipped not in found.failed
    assert found.complete is False


# -- L1: a tombstone decides only against older evidence ----------------------------


@pytest.fixture
def app(tmp_path, monkeypatch, person):
    graph = CLIGraph(persist_path=tmp_path / "state.json")
    store = ProjectStore(tmp_path / "projects")
    monkeypatch.setattr(main_module, "cli_graph", graph)
    monkeypatch.setattr(main_module, "project_store", store)
    store.on_restore = main_module._on_catalog_restore
    store.canvas_owner = main_module._canvas_owner_for_restore
    store.hand_off_restore = getattr(main_module, "_hand_off_catalog_restore", None)
    store.read_in_flight = getattr(main_module, "_catalog_read_in_flight", None)
    monkeypatch.setattr(main_module, "provider_recovery_store", ProviderRecoveryStore(None))
    monkeypatch.setattr(main_module, "provider_start_guard", ProviderStartGuard(tmp_path / "paid-starts.json"))
    monkeypatch.setattr(main_module, "execution_runs", ExecutionRunRegistry())
    monkeypatch.setattr(main_module, "_graph_recovery_bootstrap_error", None)
    monkeypatch.setattr(main_module.manager, "broadcast_raw", AsyncMock())
    return TestClient(main_module.app), store, graph, tmp_path / "state.json"


def _rev(client) -> str:
    return client.get("/api/projects", headers=PERSON).json()["workspaceRevision"]


def _create(client, name: str) -> str:
    response = client.post("/api/projects", json={"name": name, "workspaceRevision": _rev(client)}, headers=PERSON)
    assert response.status_code == 200, response.text
    return response.json()["project"]["id"]


def _add_text(client, value: str) -> None:
    response = client.post("/api/graph/node", json={"definitionId": "text-input", "params": {"value": value}},
                           headers={**PERSON, "X-Nebula-Workspace-Revision": _rev(client)})
    assert response.status_code == 200, response.text


def _values(project: dict) -> list[str]:
    return sorted(str((node.get("data") or {}).get("params", {}).get("value")) for node in project["snapshot"]["nodes"])


def _events(since: int, kind: str) -> list[dict]:
    return [event for event in main_module.canvas_events.read(after=since)["events"] if event["kind"] == kind]


def test_l1_a_recover_retry_after_a_delete_for_good_survives_a_restore(app):
    """Review 2's test_c: the stale tab's retry re-creates the copy with the
    same id after the person deleted it for good. .bak (one commit behind)
    still has the tombstone; the newer record wins."""
    client, store, _graph, _state = app
    alpha = _create(client, "Alpha")
    recovery_id = "c" * 32
    snapshot = client.get(f"/api/projects/{alpha}", headers=PERSON).json()["snapshot"]
    body = {"recoveryId": recovery_id, "sourceProjectId": alpha, "snapshot": snapshot, "name": "Alpha (recovered)"}
    assert client.post("/api/projects/recover", json=body, headers=PERSON).status_code == 200
    client.request("DELETE", f"/api/projects/{recovery_id}", headers=PERSON, json={"workspaceRevision": _rev(client)})
    assert client.delete(f"/api/projects/trash/{recovery_id}", headers=PERSON).status_code == 200
    assert client.post("/api/projects/recover", json=body, headers=PERSON).status_code == 200  # the retry
    assert recovery_id in (json.loads(store.backup_path.read_text()).get("purged") or {})
    raw = store.path.read_bytes()
    store.path.write_bytes(raw[:-2])  # torn at the very end: every record reads whole

    listing = client.get("/api/projects", headers=PERSON).json()
    after = json.loads(store.path.read_text())
    assert recovery_id in after["projects"]
    assert recovery_id not in (after.get("purged") or {})
    assert listing["catalogRestore"]["keptDeleted"] == []


def _salvage(**fields) -> catalog_recovery.Salvage:
    found = catalog_recovery.Salvage()
    for key, value in fields.items():
        setattr(found, key, value)
    return found


def _base(*records: dict) -> dict:
    return {"version": 1, "activeProjectId": None, "workspaceRevision": "r",
            "projects": {record["id"]: record for record in records}, "trash": {}}


def test_l1_a_tombstone_newer_than_a_record_drops_it_with_a_row():
    old = make_project("Old")
    at = datetime.now(timezone.utc).isoformat()
    newest = _salvage(purged={old["id"]: at})
    older = _salvage(entries={old["id"]: old}, sizes={old["id"]: 100})
    merged = catalog_recovery.reconcile(_base(), [newest, older], max_projects=500, room_bytes=10**9)
    assert old["id"] not in merged.catalog["projects"]
    assert merged.kept_deleted == [{"id": old["id"], "name": "Old"}]
    assert old["id"] in merged.catalog["purged"]


def test_l1_a_tombstone_only_in_the_copy_never_drops_a_newer_record():
    again = make_project("Again")
    base = _base()
    base["purged"] = {again["id"]: (datetime.now(timezone.utc) - timedelta(minutes=5)).isoformat()}
    newest = _salvage(entries={again["id"]: again}, sizes={again["id"]: 100}, complete=True, holds={again["id"]})
    merged = catalog_recovery.reconcile(base, [newest], max_projects=500, room_bytes=10**9)
    assert again["id"] in merged.catalog["projects"]
    assert again["id"] not in (merged.catalog.get("purged") or {})
    assert merged.kept_deleted == []


def test_l1_a_tombstone_in_a_newer_file_decides_even_against_a_later_created_at():
    # Fix round 3 (review 3, L-3) replaced this test's rule: the tombstone
    # sits in a newer file and the record, only in an older one, says it was
    # made after it. That is a clock that ran ahead, not another project:
    # file order decides, and the row says so.
    again = make_project("Again")
    purged_at = (datetime.fromisoformat(again["createdAt"]) - timedelta(hours=1)).isoformat()
    newest = _salvage(purged={again["id"]: purged_at})
    older = _salvage(entries={again["id"]: again}, sizes={again["id"]: 100})
    merged = catalog_recovery.reconcile(_base(), [newest, older], max_projects=500, room_bytes=10**9)
    assert again["id"] not in merged.catalog["projects"]
    assert merged.kept_deleted == [{"id": again["id"], "name": "Again", "createdAfterDelete": True}]


# -- L2: a reader on the event loop never restores or waits for one ------------------


def test_l2_a_loop_reader_never_restores_on_the_loop_or_waits_for_a_restore(app, monkeypatch):
    client, store, _graph, _state = app
    _create(client, "Alpha")
    before = main_module._workspace_context()
    threads = []
    real = store._restore

    def spy(damage):
        threads.append(threading.get_ident())
        return real(damage)

    monkeypatch.setattr(store, "_restore", spy)
    store.path.write_text("{not json", encoding="utf-8")

    async def scenario():
        loop_thread = threading.get_ident()
        # Another holder of the lock for 1.5 s (a restore in another thread).
        held, release = threading.Event(), threading.Event()

        def holder():
            with store._locked():
                held.set()
                release.wait(5)

        worker = threading.Thread(target=holder)
        worker.start()
        held.wait(5)
        threading.Timer(1.5, release.set).start()
        started = time.perf_counter()
        context = main_module._workspace_context()
        waited = time.perf_counter() - started
        await asyncio.to_thread(worker.join)
        reading = getattr(main_module, "_catalog_reading", None)
        if reading is not None:
            await asyncio.shield(reading[1])
        return loop_thread, waited, context, main_module._workspace_context()

    loop_thread, waited, during, after = asyncio.run(scenario())
    assert waited < 0.5, f"a loop reader waited {waited:.2f} s for the restore"
    assert during["activeProjectId"] == before["activeProjectId"]
    assert threads and loop_thread not in threads
    assert after["workspaceRevision"] != before["workspaceRevision"]


# -- L3: no hard links, and the newest valid copy ------------------------------------


def test_l3_without_hard_links_bak_follows_every_commit(tmp_path, monkeypatch):
    store = _store(tmp_path)

    def no_link(*args, **kwargs):
        raise OSError(1, "Operation not permitted")

    monkeypatch.setattr(store_module.os, "link", no_link)
    [logo] = _add(store, "Logo")
    for index in range(5):
        _rename(store, logo, f"Logo v{index}")
    assert json.loads(store.backup_path.read_text())["projects"][logo]["name"] == "Logo v4"


def test_l3_a_restore_takes_the_newest_valid_copy_by_what_it_holds(tmp_path):
    store = _store(tmp_path)
    [logo] = _add(store, "Logo")
    stale = store.path.read_bytes()
    _rename(store, logo, "Logo v2")
    _rename(store, logo, "Logo v3")
    # .bak stale (a state dir where it stopped following), .bak.1 newer.
    store.older_backup_path.write_bytes(store.path.read_bytes())
    store.backup_path.unlink()
    store.backup_path.write_bytes(stale)
    store.path.write_text("{not json", encoding="utf-8")

    catalog = store.read()
    assert catalog["projects"][logo]["name"] == "Logo v3"
    assert _record(store)["source"] == "catalog.json.bak.1"


# -- L4: filing the canvas at a limit never fails the listing ------------------------


def test_l4_filing_the_canvas_at_the_project_limit_never_fails_the_listing(app, monkeypatch):
    """Review 2's test_f: the canvas's project isn't in the list, which is full."""
    client, store, graph, state = app
    monkeypatch.setattr(store_module, "MAX_PROJECTS", 3)
    first = _create(client, "A")
    _create(client, "B")
    _create(client, "C")
    _add_text(client, "c1")
    client.get("/api/projects", headers=PERSON)
    graph.owner = "e" * 32  # a project the list lacks
    graph.save(state)

    codes = [client.get("/api/projects", headers=PERSON).status_code for _ in range(3)]
    assert codes == [200, 200, 200]
    assert json.loads(state.read_text())["projectId"] == "e" * 32  # nothing re-owned it
    listing = client.get("/api/projects", headers=PERSON).json()
    assert listing["canvasNotFiled"]["reason"] == "projects"
    assert listing["activeProjectId"] is None
    assert [node["params"]["value"] for node in main_module.cli_graph.get_state()["nodes"]] == ["c1"]
    # Opening another project would replace it: refused, nothing lost.
    opened = client.post(f"/api/projects/{first}/open", json={"workspaceRevision": listing["workspaceRevision"]},
                         headers=PERSON)
    assert opened.status_code == 413 and opened.json()["limit"] == "projects"
    assert len(main_module.cli_graph.nodes) == 1
    # A slot freed: the next listing files it.
    client.request("DELETE", f"/api/projects/{first}", headers=PERSON, json={"workspaceRevision": _rev(client)})
    listing = client.get("/api/projects", headers=PERSON).json()
    assert "canvasNotFiled" not in listing
    filed = [project for project in listing["projects"] if project["id"] == listing["activeProjectId"]]
    assert filed and filed[0]["name"] == "Recovered canvas"


# -- L5: a filing attaches to the restore it came from, and is journaled -------------


def test_l5_a_later_filing_is_not_pinned_on_an_older_restore_notice(app):
    """Review 2's test_h: a restore that brought everything back, then a
    crash-window filing while its notice is still open."""
    client, store, graph, state = app
    _create(client, "Alpha")
    _add_text(client, "a1")
    client.get("/api/projects", headers=PERSON)
    raw = store.path.read_bytes()
    store.path.write_bytes(raw[:-1])
    first = client.get("/api/projects", headers=PERSON).json()["catalogRestore"]
    assert first["recoveredCanvas"] is None
    graph.owner = "d" * 32
    graph.save(state)
    since = main_module.canvas_events.latest

    after = client.get("/api/projects", headers=PERSON).json()["catalogRestore"]
    assert after["id"] == first["id"] and after["recoveredCanvas"] is None
    filed = _events(since, "project.canvasFiled")
    assert len(filed) == 1 and filed[0]["data"]["name"] == "Recovered canvas"


@pytest.mark.parametrize("route", ["create", "open"])
def test_l5_a_filing_from_create_or_open_is_journaled(app, route):
    client, store, graph, state = app
    alpha = _create(client, "Alpha")
    _add_text(client, "a1")
    graph.owner = "d" * 32  # a crash between the two files left a canvas no project in the list is
    graph.save(state)
    since = main_module.canvas_events.latest
    revision = json.loads(store.path.read_text())["workspaceRevision"]
    if route == "create":
        response = client.post("/api/projects", json={"name": "Beta", "workspaceRevision": revision}, headers=PERSON)
    else:
        response = client.post(f"/api/projects/{alpha}/open", json={"workspaceRevision": revision}, headers=PERSON)
    assert response.status_code == 200, response.text
    filed = _events(since, "project.canvasFiled")
    assert len(filed) == 1
    after = json.loads(store.path.read_text())
    assert _values(after["projects"][filed[0]["data"]["projectId"]]) == ["a1"]


def test_l5_a_filing_right_after_its_restore_goes_in_that_restores_record(app):
    client, store, graph, state = app
    _create(client, "Alpha")
    beta = _create(client, "Beta")
    _add_text(client, "b1")
    client.get("/api/projects", headers=PERSON)
    # Beta's record cut off after its name, and no good copy: Beta can't come back.
    raw = store.path.read_text()
    store.path.write_text(raw[: raw.index('"createdAt"', raw.index(f'"{beta}":'))], encoding="utf-8")
    store.backup_path.unlink()
    store.older_backup_path.unlink()
    listing = client.get("/api/projects", headers=PERSON).json()
    restore = listing["catalogRestore"]
    assert restore["openProjectMissing"] == beta
    assert restore["recoveredCanvas"]["name"] == "Beta (recovered)"



def _tear_inside(text: str, project_id: str, length: int = 48) -> str:
    """``text`` with a torn page inside ``project_id``'s snapshot (zeros)."""
    at = text.index('"snapshot"', text.index(f'"{project_id}":{{')) + len('"snapshot"') + 2
    return text[:at] + "\x00" * length + text[at + length:]


def test_m2_salvage_finds_a_record_torn_right_after_another_torn_record():
    # The live check's B: a record cut right after another cut record sits
    # where no structure says a record belongs (no group opener, no whole
    # record before it), but its own members say what it is.
    first, second = make_project("Logo"), make_project("Scratch")
    catalog = {"version": 1, "activeProjectId": second["id"], "workspaceRevision": "r",
               "projects": {first["id"]: first, second["id"]: second}, "trash": {}}
    text = _tear_inside(_tear_inside(json.dumps(catalog, separators=(",", ":")), first["id"]), second["id"])
    found = catalog_recovery.salvage(text.encode())
    assert set(found.failed) == {first["id"], second["id"]}
    assert found.partial[second["id"]]["name"] == "Scratch"


def test_m2_a_key_nested_in_a_torn_record_is_never_taken_for_a_record():
    # The content rule needs the record's own id and name: a project-id key
    # inside a snapshot (an output map, say) is still not counted.
    project = make_project("Logo")
    inner = "a" * 32
    project["snapshot"]["nodes"] = [{"id": "n1", "data": {"outputs": {inner: {"url": "/x.png"}}}}]
    catalog = {"version": 1, "activeProjectId": None, "workspaceRevision": "r",
               "projects": {project["id"]: project}, "trash": {}}
    text = json.dumps(catalog, separators=(",", ":"))
    assert f'"{inner}":{{' in text
    torn = text.index('"nodes"')
    text = text[:torn] + "\x00" * 8 + text[torn + 8:]
    found = catalog_recovery.salvage(text.encode())
    assert inner not in found.failed and inner not in found.entries
    assert set(found.failed) == {project["id"]}


def test_m2_the_open_project_torn_after_another_torn_record_is_filed_under_its_name(app):
    client, store, _graph, _state = app
    logo = _create(client, "Logo")
    _add_text(client, "l1")
    client.get("/api/projects", headers=PERSON)
    copy = store.path.read_bytes()
    scratch = _create(client, "Scratch")
    _add_text(client, "s1")
    client.get("/api/projects", headers=PERSON)
    text = store.path.read_text()
    assert text.index(f'"{logo}":') < text.index(f'"{scratch}":')
    store.path.write_text(_tear_inside(_tear_inside(text, logo), scratch), encoding="utf-8")
    store.backup_path.write_bytes(copy)
    store.older_backup_path.unlink(missing_ok=True)
    listing = client.get("/api/projects", headers=PERSON).json()
    restore = listing["catalogRestore"]
    assert restore["openProjectMissing"] == scratch
    assert restore["openProjectName"] == "Scratch"
    assert restore["recoveredCanvas"]["name"] == "Scratch (recovered)"


# -- naming: "<project> (recovered)", numbered ---------------------------------------


def test_naming_the_filed_canvas_takes_its_projects_name_and_numbers_a_second_copy(app):
    client, store, graph, state = app
    alpha = _create(client, "Alpha")
    _add_text(client, "a1")
    client.get("/api/projects", headers=PERSON)
    for expected in ("Alpha (recovered)", "Alpha (recovered 2)"):
        with store.transaction() as catalog:
            entry = catalog["projects"].pop(alpha, None) or catalog["trash"][alpha]
            catalog["trash"][alpha] = {**entry, "deletedAt": store_module.now()}
            catalog["trash"][alpha].pop("restoredAt", None)
            catalog["activeProjectId"] = None
            store.commit(catalog)
        graph.owner = alpha  # the canvas is Alpha's, which isn't in the list
        graph.save(state)
        listing = client.get("/api/projects", headers=PERSON).json()
        open_card = [project for project in listing["projects"] if project["id"] == listing["activeProjectId"]]
        assert open_card and open_card[0]["name"] == expected


def test_upgrade_day_a_damaged_catalog_whose_head_reads_opens_the_project_with_the_live_canvas(app):
    """Review 2's test_b (L8): a pre-PR state.json beside a catalog damaged
    at boot whose head still reads. The head says which project was open,
    as an intact catalog would: the live canvas goes back into it, not into
    a second project."""
    client, store, graph, state = app
    alpha = _create(client, "Alpha")
    _add_text(client, "a1")
    _add_text(client, "a2")
    client.get("/api/projects", headers=PERSON)
    _add_text(client, "a3")
    legacy = json.loads(state.read_text())
    legacy.pop("projectId")
    state.write_text(json.dumps(legacy))
    raw = store.path.read_bytes()
    store.path.write_bytes(raw[: len(raw) - 40])
    graph.load(state)
    main_module._resolve_canvas_owner_at_boot(graph, store, state_loaded=True)
    assert graph.owner == alpha

    body = client.get("/api/projects", headers=PERSON).json()
    after = json.loads(store.path.read_text())
    assert after["activeProjectId"] == alpha
    assert _values(after["projects"][alpha]) == ["a1", "a2", "a3"]
    assert not [project for project in after["projects"].values() if "recovered" in project["name"].lower()]
    assert body["catalogRestore"]["openFrom"] == "canvas"


def test_upgrade_day_a_head_that_doesnt_read_leaves_the_canvas_unproven(app):
    client, store, graph, state = app
    _create(client, "Alpha")
    _add_text(client, "a1")
    legacy = json.loads(state.read_text())
    legacy.pop("projectId")
    state.write_text(json.dumps(legacy))
    store.path.write_bytes(b"\0" * 64)
    graph.load(state)
    main_module._resolve_canvas_owner_at_boot(graph, store, state_loaded=True)
    assert graph.owner is OWNER_UNPROVEN


# -- L7: damaged files age by when they were kept -------------------------------------


def test_l7_a_damaged_file_kept_today_is_young_whatever_its_mtime(tmp_path):
    store = _store(tmp_path)
    _add(store, "Alpha")
    long_ago = (datetime.now() - timedelta(days=60)).timestamp()
    stamp = datetime.now(timezone.utc).strftime("%Y%m%dT%H%M%SZ")
    kept_today = []
    for index in range(6):
        path = store.root / f"catalog.json.damaged-{stamp}-{index:08x}"
        path.write_bytes(b"x")
        os.utime(path, (long_ago, long_ago))  # a link keeps the damaged file's old mtime
        kept_today.append(path)
    store.path.write_text("{not json", encoding="utf-8")
    store.read()
    assert all(path.exists() for path in kept_today)


def test_l7_an_unreadable_restore_record_is_kept_with_a_time_in_its_name(tmp_path):
    store = _store(tmp_path)
    _add(store, "Alpha")
    store.record_path.write_text("{not json", encoding="utf-8")
    store.path.write_text("{not json", encoding="utf-8")
    store.read()
    [kept] = list(store.root.glob(f"{store_module.RESTORE_RECORD_NAME}.damaged-*"))
    datetime.strptime(kept.name.split(".damaged-")[1][:16], "%Y%m%dT%H%M%SZ")


def test_l4_a_commit_past_a_limit_the_room_check_missed_still_lists(app, monkeypatch):
    """The backstop: prepare refuses the filing after the estimate let it
    through. The filing is undone (state.json too) and the listing answers."""
    client, store, graph, state = app
    monkeypatch.setattr(store_module, "MAX_PROJECTS", 2)
    _create(client, "A")
    _create(client, "B")
    _add_text(client, "b1")
    client.get("/api/projects", headers=PERSON)
    graph.owner = "e" * 32
    graph.save(state)
    monkeypatch.setattr(main_module, "_filing_room", lambda catalog, exported: None)

    response = client.get("/api/projects", headers=PERSON)
    assert response.status_code == 200, response.text
    assert response.json()["canvasNotFiled"]["reason"] == "projects"
    assert json.loads(state.read_text())["projectId"] == "e" * 32
    assert len(json.loads(store.path.read_text())["projects"]) == 2


def test_l2_a_loop_reader_doesnt_parse_a_damaged_file_again_while_its_restore_runs(app, monkeypatch):
    client, store, _graph, _state = app
    _create(client, "Alpha")
    store.path.write_text("{not json", encoding="utf-8")
    parses = []
    real = ProjectStore._parse

    def counting(raw, **kwargs):
        parses.append(threading.get_ident())
        return real(raw, **kwargs)

    monkeypatch.setattr(ProjectStore, "_parse", staticmethod(counting))
    held, release = threading.Event(), threading.Event()

    def holder():
        with store._locked():
            held.set()
            release.wait(5)

    async def scenario():
        loop_thread = threading.get_ident()
        worker = threading.Thread(target=holder)
        worker.start()
        held.wait(5)
        for _ in range(5):
            main_module._workspace_context()
        on_loop = parses.count(loop_thread)
        release.set()
        await asyncio.to_thread(worker.join)
        await asyncio.shield(main_module._catalog_reading[1])
        return on_loop

    assert asyncio.run(scenario()) == 1


@pytest.mark.parametrize("change", ["damaged", "changed elsewhere"])
def test_l2_a_loop_reader_never_parses_a_file_the_worker_is_already_reading(app, monkeypatch, change):
    # The live measure: a 102 MB file cut in half held the loop 1.6 s with
    # the hand-off, in the parse that finds the damage while the worker's
    # own read of the same file was still running.
    client, store, _graph, _state = app
    _create(client, "Alpha")
    before = main_module._workspace_context()
    if change == "damaged":
        store.path.write_text("{not json", encoding="utf-8")
    else:
        catalog = json.loads(store.path.read_text())
        catalog["workspaceRevision"] = "elsewhere-1"
        store.path.write_text(json.dumps(catalog), encoding="utf-8")
    parses = []
    entered, go = threading.Event(), threading.Event()
    real = ProjectStore._parse
    loop_thread = threading.get_ident()  # asyncio.run's loop runs on this thread

    def held_in_the_worker(raw, **kwargs):
        parses.append(threading.get_ident())
        if threading.get_ident() != loop_thread:
            entered.set()
            go.wait(5)
        return real(raw, **kwargs)

    monkeypatch.setattr(ProjectStore, "_parse", staticmethod(held_in_the_worker))

    async def scenario():
        reading = main_module._start_catalog_read(asyncio.get_running_loop())
        await asyncio.to_thread(entered.wait, 5)
        answers = [main_module._workspace_context() for _ in range(5)]
        on_loop = parses.count(loop_thread)
        go.set()
        await asyncio.shield(reading)
        return on_loop, answers

    on_loop, answers = asyncio.run(scenario())
    assert on_loop == 0, f"the loop parsed the file {on_loop} times while the worker read it"
    assert all(answer == before for answer in answers)
    after = main_module._workspace_context()
    assert after["workspaceRevision"] != before["workspaceRevision"]
    if change == "changed elsewhere":
        assert after["workspaceRevision"] == "elsewhere-1"
