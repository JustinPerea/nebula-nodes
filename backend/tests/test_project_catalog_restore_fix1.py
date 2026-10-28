"""PR #199 review 1: a restored project list never puts one project's canvas
into another, says what an older copy decided, and stays cheap and bounded
(2026-10-27).

- H1. The live canvas (state.json) records which project it is
  (``projectId``). A restore opens that project only when it came back, and
  otherwise none; the listing then files the canvas as its own "Recovered
  canvas" project. Every path that saves the canvas into a project (the
  listing, a project read, a switch, a create, a delete) saves it only into
  the project it is.
- M1. What an older copy decided is reported: an edit reverted, a project
  deleted that came back, a restore from Recently deleted undone. A delete
  for good is remembered (``purged``) so a later restore honours it.
- L1-L7. A rebuild past the size limit changes nothing; NaN, Infinity and the
  like never make every request a 500; a nested transaction fails loudly; a
  catalog from a newer Nebula is not ours; salvage is linear and the restore
  runs off the event loop; .bak is a hard link of the validated catalog;
  damaged files and orphaned temporary files are pruned.
"""
from __future__ import annotations

import asyncio
import json
import os
import sys
import time
from datetime import datetime, timedelta, timezone
from pathlib import Path
from unittest.mock import AsyncMock

import pytest
from fastapi.testclient import TestClient

sys.path.insert(0, str(Path(__file__).resolve().parent.parent))
import main as main_module  # noqa: E402
from services import catalog_recovery  # noqa: E402
from services import cli_graph as cli_graph_module  # noqa: E402
from services import project_store as store_module  # noqa: E402
from services.cli_graph import CLIGraph  # noqa: E402
from services.execution_runs import ExecutionRunRegistry  # noqa: E402
from services.project_store import (  # noqa: E402
    ProjectStore, ProjectStoreError, make_project, move_to_trash, restore_from_trash,
)
from services.provider_recovery import ProviderRecoveryStore  # noqa: E402
from services.provider_start_guard import ProviderStartGuard  # noqa: E402
from tests.conftest import PERSON  # noqa: E402


class Crash(BaseException):
    """The process dying at that point."""


def _store(tmp_path: Path) -> ProjectStore:
    return ProjectStore(tmp_path / "projects")


def _add(store: ProjectStore, *names: str, open_last: bool = False) -> list[str]:
    ids = []
    with store.transaction() as catalog:
        for name in names:
            project = make_project(name)
            catalog["projects"][project["id"]] = project
            ids.append(project["id"])
        if open_last and ids:
            catalog["activeProjectId"] = ids[-1]
        store.commit(catalog)
    return ids


def _edit(store: ProjectStore, mutate) -> None:
    with store.transaction() as catalog:
        mutate(catalog)
        store.commit(catalog)


def _records(store: ProjectStore) -> list[dict]:
    path = store.root / "catalog-restore.json"
    return json.loads(path.read_text())["restores"] if path.exists() else []


def _ids(rows) -> list[str]:
    return [row["id"] for row in rows]


def _later() -> str:
    time.sleep(0.002)
    return datetime.now(timezone.utc).isoformat()


# -- the app ---------------------------------------------------------------------


@pytest.fixture
def app(tmp_path, monkeypatch, person):
    graph = CLIGraph(persist_path=tmp_path / "state.json")
    store = ProjectStore(tmp_path / "projects")
    monkeypatch.setattr(main_module, "cli_graph", graph)
    monkeypatch.setattr(main_module, "project_store", store)
    store.on_restore = main_module._on_catalog_restore
    store.canvas_owner = main_module._canvas_owner_for_restore
    store.protect_after_restore = getattr(main_module, "_protect_after_restore", None)
    monkeypatch.setattr(main_module, "provider_recovery_store", ProviderRecoveryStore(None))
    monkeypatch.setattr(main_module, "provider_start_guard", ProviderStartGuard(tmp_path / "paid-starts.json"))
    monkeypatch.setattr(main_module, "execution_runs", ExecutionRunRegistry())
    monkeypatch.setattr(main_module, "_graph_recovery_bootstrap_error", None)
    monkeypatch.setattr(main_module.manager, "broadcast_raw", AsyncMock())
    return TestClient(main_module.app), store, graph, tmp_path / "state.json"


def _rev(client) -> str:
    return client.get("/api/projects", headers=PERSON).json()["workspaceRevision"]


def _add_text(client, value: str) -> None:
    response = client.post("/api/graph/node", json={"definitionId": "text-input", "params": {"value": value}},
                           headers={**PERSON, "X-Nebula-Workspace-Revision": _rev(client)})
    assert response.status_code == 200, response.text


def _values(project: dict) -> list[str]:
    return sorted(str((node.get("data") or {}).get("params", {}).get("value")) for node in project["snapshot"]["nodes"])


def _create(client, name: str) -> str:
    response = client.post("/api/projects", json={"name": name, "workspaceRevision": _rev(client)}, headers=PERSON)
    assert response.status_code == 200, response.text
    return response.json()["project"]["id"]


def test_h1_the_review_probe_never_saves_betas_canvas_into_alpha(app):
    """Review 1's probe: Alpha (two nodes), then Beta opened with one node.
    The older copy has Alpha open. catalog.json is zero-filled and .bak
    overwritten with zeros: the restore comes from .bak.1."""
    client, store, graph, state = app
    alpha = _create(client, "Alpha")
    _add_text(client, "alpha-1")
    _add_text(client, "alpha-2")
    client.get("/api/projects", headers=PERSON)  # Alpha's canvas saved into Alpha
    snap = json.loads(store.path.read_text())
    snap["activeProjectId"] = alpha  # the older copy: an hour ago, Alpha open with its two nodes
    store.older_backup_path.write_text(json.dumps(snap), encoding="utf-8")
    beta = _create(client, "Beta")
    _add_text(client, "beta-1")
    client.get("/api/projects", headers=PERSON)
    assert json.loads(state.read_text())["projectId"] == beta
    store.path.write_bytes(b"\0" * store.path.stat().st_size)
    store.backup_path.write_bytes(b"\0" * 100)

    listing = client.get("/api/projects", headers=PERSON)

    assert listing.status_code == 200, listing.text
    body = listing.json()
    after = json.loads(store.path.read_text())
    assert body["catalogRestore"]["source"] == "catalog.json.bak.1"
    assert _values(after["projects"][alpha]) == ["alpha-1", "alpha-2"]  # never Beta's canvas
    recovered = [project for project in after["projects"].values() if project["name"] == "Recovered canvas"]
    assert len(recovered) == 1
    assert _values(recovered[0]) == ["beta-1"]
    assert after["activeProjectId"] == recovered[0]["id"]
    assert json.loads(state.read_text())["projectId"] == recovered[0]["id"]
    saved = dict(body["catalogRestore"]["recoveredCanvas"])
    assert saved.pop("filedAt") == recovered[0]["createdAt"]  # GM r10's order
    assert saved == {"id": recovered[0]["id"], "name": "Recovered canvas"}
    assert "Recovered canvas" in body["catalogRestore"]["note"]
    # Listing again files nothing more.
    again = client.get("/api/projects", headers=PERSON).json()
    assert sum(1 for project in again["projects"] if project["name"] == "Recovered canvas") == 1


def test_h1_a_restore_opens_the_canvas_own_project_when_it_came_back(app):
    client, store, graph, state = app
    alpha = _create(client, "Alpha")
    _add_text(client, "alpha-1")
    beta = _create(client, "Beta")
    _add_text(client, "beta-1")
    client.get("/api/projects", headers=PERSON)
    snap = json.loads(store.path.read_text())
    snap["activeProjectId"] = alpha  # a copy from before the switch to Beta
    store.older_backup_path.write_text(json.dumps(snap), encoding="utf-8")
    store.path.write_bytes(b"\0" * 64)
    store.backup_path.write_bytes(b"\0" * 64)

    body = client.get("/api/projects", headers=PERSON).json()
    after = json.loads(store.path.read_text())

    assert after["activeProjectId"] == beta
    assert body["catalogRestore"]["openFrom"] == "canvas"
    assert _values(after["projects"][beta]) == ["beta-1"]
    assert _values(after["projects"][alpha]) == ["alpha-1"]
    assert not [project for project in after["projects"].values() if project["name"] == "Recovered canvas"]


def test_h1_a_project_read_never_saves_a_canvas_that_isnt_the_projects(app):
    client, store, graph, _state = app
    alpha = _create(client, "Alpha")
    _add_text(client, "alpha-1")
    client.get("/api/projects", headers=PERSON)
    graph.owner = "f" * 32  # the canvas is another project's
    before = json.loads(store.path.read_text())["projects"][alpha]["snapshot"]
    assert main_module._overlay_live_project(json.loads(json.dumps(store.read()["projects"][alpha])),
                                             {"nodes": [], "edges": []}) is False
    client.get(f"/api/projects/{alpha}", headers=PERSON)
    assert json.loads(store.path.read_text())["projects"][alpha]["snapshot"] == before


def test_h1_a_crash_between_the_canvas_and_the_catalog_in_a_switch_opens_the_canvas_project(app, monkeypatch):
    """A switch writes state.json, then the catalog. A crash between them
    leaves Beta's canvas with Alpha open in the catalog: the next listing opens
    Beta, and Alpha keeps its own nodes."""
    client, store, graph, state = app
    alpha = _create(client, "Alpha")
    _add_text(client, "alpha-1")
    beta = _create(client, "Beta")
    _add_text(client, "beta-1")
    revision = _rev(client)
    client.post(f"/api/projects/{alpha}/open", json={"workspaceRevision": revision}, headers=PERSON)
    real = store.commit_prepared

    def crash(_temporary):
        raise Crash()

    monkeypatch.setattr(store, "commit_prepared", crash)
    with pytest.raises(BaseException):  # the crash, through the test client's task group
        client.post(f"/api/projects/{beta}/open", json={"workspaceRevision": _rev(client)}, headers=PERSON)
    monkeypatch.setattr(store, "commit_prepared", real)
    assert json.loads(store.path.read_text())["activeProjectId"] == alpha
    graph.load(state)  # the restart
    assert graph.owner == beta

    client.get("/api/projects", headers=PERSON)
    after = json.loads(store.path.read_text())

    assert after["activeProjectId"] == beta
    assert _values(after["projects"][alpha]) == ["alpha-1"]
    assert _values(after["projects"][beta]) == ["beta-1"]


def test_h1_a_crash_while_creating_a_project_never_empties_the_open_one(app, monkeypatch):
    client, store, graph, state = app
    alpha = _create(client, "Alpha")
    _add_text(client, "alpha-1")
    client.get("/api/projects", headers=PERSON)
    real = store.commit_prepared
    monkeypatch.setattr(store, "commit_prepared", lambda _t: (_ for _ in ()).throw(Crash()))
    with pytest.raises(BaseException):  # the crash, through the test client's task group
        client.post("/api/projects", json={"name": "Beta", "workspaceRevision": _rev(client)}, headers=PERSON)
    monkeypatch.setattr(store, "commit_prepared", real)
    graph.load(state)  # the restart: an empty canvas that is a project never committed

    client.get("/api/projects", headers=PERSON)
    after = json.loads(store.path.read_text())

    assert _values(after["projects"][alpha]) == ["alpha-1"]
    assert after["activeProjectId"] is None


def test_h1_the_canvas_records_its_project_in_state_json(app):
    client, store, graph, state = app
    alpha = _create(client, "Alpha")
    assert json.loads(state.read_text())["projectId"] == alpha
    response = client.request("DELETE", f"/api/projects/{alpha}", headers=PERSON,
                              json={"workspaceRevision": _rev(client)})
    assert response.status_code == 200, response.text
    assert json.loads(state.read_text())["projectId"] is None


def test_h1_a_canvas_saved_before_it_recorded_its_project_is_resolved_at_boot(tmp_path):
    store = _store(tmp_path)
    [alpha] = _add(store, "Alpha", open_last=True)
    graph = CLIGraph()
    assert graph.owner is cli_graph_module.OWNER_UNKNOWN
    main_module._resolve_canvas_owner_at_boot(graph, store, state_loaded=True)
    assert graph.owner == alpha
    # The catalog damaged at boot: ownership is unproven, never the copy's open project.
    graph = CLIGraph()
    store.path.write_bytes(b"\0" * 16)
    main_module._resolve_canvas_owner_at_boot(graph, store, state_loaded=True)
    assert graph.owner is cli_graph_module.OWNER_UNPROVEN
    # No state.json with a catalog present: the canvas is empty and no project's.
    store2 = _store(tmp_path / "b")
    _add(store2, "Beta", open_last=True)
    graph = CLIGraph()
    main_module._resolve_canvas_owner_at_boot(graph, store2, state_loaded=False)
    assert graph.owner is None


def test_h1_state_json_round_trips_the_owner(tmp_path):
    path = tmp_path / "state.json"
    graph = CLIGraph(persist_path=path)
    graph.owner = "a" * 32
    graph.add_node("text-input", {"value": "x"})
    loaded = CLIGraph()
    loaded.load(path)
    assert loaded.owner == "a" * 32
    assert loaded.clone().owner == "a" * 32
    legacy = json.loads(path.read_text())
    legacy.pop("projectId")
    path.write_text(json.dumps(legacy))
    loaded.load(path)
    assert loaded.owner is cli_graph_module.OWNER_UNKNOWN


# -- M1: what an older copy decided ------------------------------------------------


def test_m1_an_edit_the_damage_cut_off_is_reported_as_reverted(tmp_path):
    """Probe P1: Beta renamed with a node added; its record in catalog.json is
    cut. .bak is one commit behind, so Beta goes back to its version there."""
    store = _store(tmp_path)
    alpha, beta = _add(store, "Alpha", "Beta")

    def edit(catalog):
        project = catalog["projects"][beta]
        project["name"] = "Beta EDITED"
        project["snapshot"]["nodes"] = [{"id": "n1"}]
        store_module.refresh_metadata(project)

    _edit(store, edit)
    raw = store.path.read_bytes()
    store.path.write_bytes(raw[:raw.index(b'"snapshot"', raw.index(beta.encode())) + 20])

    catalog = store.read()

    assert catalog["projects"][beta]["name"] == "Beta"
    [record] = _records(store)
    assert _ids(record["reverted"]) == [beta]
    assert record["reverted"][0]["name"] == "Beta"
    assert record["revertedCount"] == 1
    assert alpha not in _ids(record["reverted"])  # untouched since the copy
    assert record["copyAt"]


def test_m1_an_unchanged_record_cut_by_the_damage_is_not_reported(tmp_path):
    store = _store(tmp_path)
    alpha, beta = _add(store, "Alpha", "Beta")
    _add(store, "Gamma")  # a later commit that leaves Beta as it was
    raw = store.path.read_bytes()
    store.path.write_bytes(raw[:raw.index(b'"snapshot"', raw.index(beta.encode())) + 20])

    store.read()

    [record] = _records(store)
    assert record["reverted"] == []


def test_m1_a_project_deleted_for_good_is_remembered_and_stays_deleted(tmp_path):
    """Probe P5: "Gone" deleted for good, .bak damaged, .bak.1 (which still
    has Gone) is the base. The purge is in the damaged file's head."""
    store = _store(tmp_path)
    keep, gone = _add(store, "Keep", "Gone")
    _edit(store, lambda catalog: move_to_trash(catalog, gone))
    _edit(store, lambda catalog: catalog["trash"].pop(gone))
    assert gone in json.loads(store.path.read_text())["purged"]
    store.backup_path.write_text("{bad", encoding="utf-8")
    store.path.write_bytes(store.path.read_bytes()[:-1])

    catalog = store.read()

    assert gone not in catalog["projects"] and gone not in catalog["trash"]
    [record] = _records(store)
    assert _ids(record["keptDeleted"]) == [gone]
    assert record["cameBack"] == []


def test_m1_a_delete_the_damaged_file_cant_prove_comes_back_and_is_reported(tmp_path):
    """A parseable damaged file that lacks the project and has no tombstone
    (saved before tombstones): the copy's project comes back, and says so."""
    store = _store(tmp_path)
    keep, gone = _add(store, "Keep", "Gone")
    damaged = json.loads(store.path.read_text())
    damaged["projects"].pop(gone)
    damaged.pop("purged", None)
    damaged["workspaceRevision"] = 7  # the wrong shape: damaged, but it parses
    store.path.write_text(json.dumps(damaged), encoding="utf-8")

    catalog = store.read()

    assert gone in catalog["projects"]
    [record] = _records(store)
    assert record["cameBack"] == [{"id": gone, "name": "Gone", "how": "deleted", "trashed": False}]


def test_m1_a_move_to_recently_deleted_the_damage_cut_off_is_reported_back(tmp_path):
    store = _store(tmp_path)
    keep, gone = _add(store, "Keep", "Gone")
    _edit(store, lambda catalog: move_to_trash(catalog, gone))
    raw = store.path.read_bytes()
    store.path.write_bytes(raw[:raw.index(b'"snapshot"', raw.index(gone.encode())) + 20])

    catalog = store.read()

    assert gone in catalog["projects"]
    [record] = _records(store)
    assert record["cameBack"] == [{"id": gone, "name": "Gone", "how": "trashed", "trashed": False}]


def test_m1_a_restore_from_recently_deleted_is_kept_when_the_record_reads(tmp_path):
    """Probe P6: Alpha restored from Recently deleted after the copy. Its
    record reads whole, and the restore is newer than the delete."""
    store = _store(tmp_path)
    [alpha] = _add(store, "Alpha")
    _edit(store, lambda catalog: move_to_trash(catalog, alpha))
    _edit(store, lambda catalog: restore_from_trash(catalog, alpha))
    store.path.write_bytes(store.path.read_bytes()[:-1])

    catalog = store.read()

    assert alpha in catalog["projects"] and alpha not in catalog["trash"]
    [record] = _records(store)
    assert record["backInTrash"] == []


def test_m1_a_restore_from_recently_deleted_saved_before_restoredAt_is_reported(tmp_path):
    store = _store(tmp_path)
    [alpha] = _add(store, "Alpha")
    _edit(store, lambda catalog: move_to_trash(catalog, alpha))

    def restore_old_way(catalog):
        entry = restore_from_trash(catalog, alpha)
        entry.pop("restoredAt", None)

    _edit(store, restore_old_way)
    store.path.write_bytes(store.path.read_bytes()[:-1])

    catalog = store.read()

    assert alpha in catalog["trash"]
    [record] = _records(store)
    assert record["backInTrash"] == [{"id": alpha, "name": "Alpha"}]


def test_m1_a_restore_from_recently_deleted_the_damage_cut_off_is_reported(tmp_path):
    store = _store(tmp_path)
    keep, alpha = _add(store, "Keep", "Alpha")
    _edit(store, lambda catalog: move_to_trash(catalog, alpha))
    _edit(store, lambda catalog: restore_from_trash(catalog, alpha))
    raw = store.path.read_bytes()
    store.path.write_bytes(raw[:raw.index(b'"snapshot"', raw.index(alpha.encode())) + 20])

    store.read()

    [record] = _records(store)
    assert record["backInTrash"] == [{"id": alpha, "name": "Alpha"}]


def _zero_inside(raw: bytes, entry_id: str) -> bytes:
    """A torn page: zeros inside the record's snapshot."""
    at = raw.index(b'"snapshot"', raw.index(entry_id.encode())) + 12
    return raw[:at] + b"\0" * 32 + raw[at + 32:]


def test_m1_several_records_cut_in_one_file_each_get_their_group(tmp_path):
    """Live check of fix round 1: three torn pages in one file. The record cut
    after a whole record that followed an earlier cut lost its group, so a
    restore from Recently deleted the copy didn't have went unreported."""
    store = _store(tmp_path)
    logo, keep, revived, draft = _add(store, "Logo", "Keep", "Revived", "Draft")
    _edit(store, lambda catalog: move_to_trash(catalog, revived))
    store.older_backup_path.write_bytes(store.path.read_bytes())

    def edit(catalog):
        project = catalog["projects"][logo]
        project["snapshot"]["nodes"] = [{"id": "n1"}]
        store_module.refresh_metadata(project)

    _edit(store, edit)
    _edit(store, lambda catalog: restore_from_trash(catalog, revived))
    _edit(store, lambda catalog: move_to_trash(catalog, draft))
    raw = store.path.read_bytes()
    for entry_id in (logo, revived, draft):
        raw = _zero_inside(raw, entry_id)
    store.path.write_bytes(raw)
    store.backup_path.write_bytes(b"\0" * 64)

    catalog = store.read()

    [record] = _records(store)
    assert record["source"] == "catalog.json.bak.1"
    assert _ids(record["reverted"]) == [logo]
    assert record["backInTrash"] == [{"id": revived, "name": "Revived"}]
    assert record["cameBack"] == [{"id": draft, "name": "Draft", "how": "trashed", "trashed": False}]
    assert revived in catalog["trash"] and draft in catalog["projects"]


def test_m1_the_agents_note_says_what_the_older_copy_decided():
    note = main_module._catalog_restore_note({
        "kind": "restored", "reason": "corrupt", "source": "catalog.json.bak.1", "addedBackCount": 0,
        "notAddedBackCount": 0, "setAside": ["/s/catalog.json.damaged-x"],
        "reverted": [{"id": "a" * 32, "name": "Logo", "trashed": False}], "revertedCount": 1,
        "cameBack": [{"id": "b" * 32, "name": "Draft", "how": "deleted"}], "cameBackCount": 1,
        "backInTrash": [{"id": "c" * 32, "name": "Hero"}], "backInTrashCount": 1,
        "updatedFromDiskCount": 2,
    })
    assert "1 project went back to its version in the copy (reverted)" in note
    assert "1 project deleted after the copy is back (cameBack)" in note
    assert "1 project restored from Recently deleted after the copy is in Recently deleted again (backInTrash)" in note
    assert "2 projects were brought up to date from the damaged file" in note


def test_m1_start_here_and_the_cli_carry_the_older_copys_outcomes():
    from cli.formatter import format_start
    from services import agent_start

    view = {"id": "a" * 32, "kind": "restored", "source": "catalog.json.bak.1", "addedBack": [],
            "reverted": [{"id": "b" * 32, "name": "Logo", "trashed": False}], "revertedCount": 1,
            "cameBack": [], "cameBackCount": 0, "backInTrash": [], "backInTrashCount": 0,
            "copyAt": "2026-10-25T10:00:00+00:00", "note": "n"}
    part = agent_start.catalog_restore_part(view)
    assert part["reverted"] == [{"id": "b" * 32, "name": "Logo"}] and part["revertedCount"] == 1
    assert part["copyAt"] == "2026-10-25T10:00:00+00:00"
    text = format_start({"catalogRestore": {**part, "note": "n"}, "canvas": {}, "pins": {}, "proposals": {},
                         "boards": {}, "nodes": {}, "spend": {}, "next": {}})
    assert "Went back to the copy's version: Logo" in text


def test_m1_a_damaged_file_not_read_to_its_end_never_claims_nothing_was_lost(tmp_path):
    """Live check of fix round 1: catalog.json and .bak zero-filled, .bak.1 the
    base. What the damaged file held is unknown, and the record, the agents'
    note and the CLI say so (the notice then never says no projects were
    missing). A file that parses (only its shape wrong) was read whole."""
    from cli.formatter import catalog_restore_lines

    store = _store(tmp_path)
    _add(store, "Alpha")
    store.older_backup_path.write_bytes(store.path.read_bytes())
    _add(store, "Beta")
    for path in (store.path, store.backup_path):
        path.write_bytes(b"\0" * path.stat().st_size)

    store.read()

    [record] = _records(store)
    assert record["source"] == "catalog.json.bak.1"
    assert record["damagedReadWhole"] is False
    note = main_module._catalog_restore_note(record)
    assert "couldn't be read whole" in note and "damagedReadWhole: false" in note
    assert main_module._catalog_restore_view(record)["damagedReadWhole"] is False
    assert any("not read whole" in line for line in catalog_restore_lines(record))

    other = _store(tmp_path / "parsed")
    _add(other, "Gamma")
    shaped = json.loads(other.path.read_text())
    shaped["workspaceRevision"] = 7  # damaged, but it parses
    other.path.write_text(json.dumps(shaped), encoding="utf-8")
    other.read()
    [parsed] = _records(other)
    assert parsed["damagedReadWhole"] is True
    assert "couldn't be read whole" not in main_module._catalog_restore_note(parsed)


# -- L1-L7 ---------------------------------------------------------------------------


def test_l1_a_rebuild_past_the_size_limit_refuses_and_changes_nothing(tmp_path, monkeypatch):
    """Probe P2: prepare refuses the rebuilt catalog once."""
    store = _store(tmp_path)
    _add(store, "One", "Two", "Three")
    for path in (store.backup_path, store.older_backup_path):
        path.write_text("{garbage", encoding="utf-8")
    store.path.write_bytes(store.path.read_bytes()[:-3])
    before = store.path.read_bytes()
    real = store.prepare
    calls = {"n": 0}

    def limited(catalog):
        calls["n"] += 1
        if catalog["projects"]:
            raise store_module.ProjectLimitError("Project storage limit reached", "storage")
        return real(catalog)

    monkeypatch.setattr(store, "prepare", limited)
    with pytest.raises(ProjectStoreError):
        store.read()
    assert store.path.read_bytes() == before
    assert _records(store) == []
    assert not list(store.root.glob("*.damaged-*"))


def test_l1_room_counts_each_records_key_and_comma():
    base = {"version": 1, "projects": {}, "trash": {}, "activeProjectId": None, "workspaceRevision": "r"}
    entries = {}
    for index in range(3):
        project = make_project(f"P{index}")
        entries[project["id"]] = project
    sizes = [len(json.dumps(entry, ensure_ascii=False, separators=(",", ":")).encode()) for entry in entries.values()]
    found = catalog_recovery.Salvage(entries=entries)
    exact = sum(sizes) + 3 * catalog_recovery.RECORD_OVERHEAD
    merged = catalog_recovery.reconcile(json.loads(json.dumps(base)), [found], max_projects=10, room_bytes=exact)
    assert len(merged.added) == 3
    merged = catalog_recovery.reconcile(json.loads(json.dumps(base)), [found], max_projects=10, room_bytes=exact - 1)
    assert len(merged.added) == 2 and [row["reason"] for row in merged.not_added] == ["size"]


@pytest.mark.parametrize("bad", ["NaN", "Infinity", "-Infinity", "1e999"])
def test_l2_a_value_the_store_cant_write_never_makes_every_request_a_500(tmp_path, bad):
    """Probe P3, and the same value in an otherwise whole catalog."""
    store = _store(tmp_path)
    [alpha] = _add(store, "Alpha")
    _add(store, "Beta")
    text = store.path.read_text()
    text = text.replace('"nodes":[]', f'"nodes":[{{"id":"n","params":{{"x":{bad}}}}}]', 1)
    store.path.write_text(text, encoding="utf-8")
    for _attempt in range(2):
        catalog = store.read()  # restored from .bak, never a ValueError
        assert set(catalog["projects"]) >= {alpha}
    with store.transaction() as catalog:
        store.commit(catalog)  # and it can be written again


def test_l2_a_damaged_record_with_nan_is_left_out_and_reported(tmp_path):
    store = _store(tmp_path)
    [alpha] = _add(store, "Alpha")
    store.backup_path.unlink()
    store.older_backup_path.unlink()
    text = store.path.read_text().replace('"nodes":[]', '"nodes":[{"id":"n","params":{"x":NaN}}]', 1)
    store.path.write_text(text[:-2], encoding="utf-8")
    with pytest.raises(ProjectStoreError):
        store.read()  # nothing whole to rebuild from: the 507, not a 500
    with pytest.raises(ProjectStoreError):
        store.read()


def test_l2_a_lone_surrogate_never_makes_every_request_a_500(tmp_path):
    store = _store(tmp_path)
    [alpha] = _add(store, "Alpha")
    _add(store, "Beta")
    text = store.path.read_text().replace('"name":"Alpha"', '"name":"Al\\ud800pha"', 1)
    store.path.write_text(text, encoding="utf-8")
    catalog = store.read()
    assert catalog["projects"][alpha]["name"] == "Alpha"
    with store.transaction() as catalog:
        store.commit(catalog)


def test_l3_a_nested_transaction_fails_loudly(tmp_path):
    """Probe P8: the inner commit used to be lost silently."""
    store = _store(tmp_path)
    [alpha] = _add(store, "A")
    with pytest.raises(RuntimeError, match="nested"):
        with store.transaction() as outer:
            with store.transaction() as inner:
                inner["projects"][alpha]["name"] = "inner"
                store.commit(inner)
            store.commit(outer)
    assert store.read()["projects"][alpha]["name"] == "A"
    # The lock was let go: the next transaction goes ahead.
    with store.transaction() as catalog:
        store.commit(catalog)


def test_l4_a_catalog_from_a_newer_nebula_is_not_ours(tmp_path):
    """Probe P4: version 2 in the file and both copies."""
    store = _store(tmp_path)
    _add(store, "Alpha", "Beta")
    data = json.loads(store.path.read_text())
    data["version"] = 2
    encoded = json.dumps(data).encode()
    for path in (store.path, store.backup_path, store.older_backup_path):
        path.write_bytes(encoded)
    with pytest.raises(ProjectStoreError):
        store.read()
    assert store.path.read_bytes() == encoded
    assert _records(store) == []
    assert not list(store.root.glob("*.damaged-*"))


def test_l4_a_damaged_file_whose_head_says_a_newer_version_is_not_ours(tmp_path):
    store = _store(tmp_path)
    _add(store, "Alpha")
    raw = store.path.read_bytes().replace(b'{"version":1', b'{"version":3', 1)
    store.path.write_bytes(raw[:-2])
    with pytest.raises(ProjectStoreError):
        store.read()
    assert _records(store) == []


def test_l5_salvage_of_a_deep_cut_chain_is_linear(monkeypatch):
    """A 300-deep chain of hex-keyed objects with padding, cut at the
    innermost point: each enclosing decode used to rescan to the end."""
    depth, pad = 300, 2000
    keys = [f"{index:032x}" for index in range(depth)]
    head = '{"version":1,"activeProjectId":null,"workspaceRevision":"r","projects":{'
    body = "".join(f'"{key}":{{"pad":"{"x" * pad}","child":' for key in keys)
    text = head + body + '{"cut'
    rescanned = {"bytes": 0}
    real = catalog_recovery._DECODER.raw_decode

    def counting(source, idx=0):
        index = idx
        try:
            return real(source, idx)
        except ValueError:
            rescanned["bytes"] += len(source) - index
            raise

    monkeypatch.setattr(catalog_recovery._DECODER, "raw_decode", counting)
    found = catalog_recovery.salvage(text.encode())
    assert found.entries == {}
    assert rescanned["bytes"] <= 4 * len(text)


def test_l5_a_record_swallowed_by_a_lost_brace_is_still_found():
    """Records after a record whose closing brace was lost decode as nested:
    salvage still finds them, without rescanning."""
    first, second = make_project("First"), make_project("Second")
    catalog = {"version": 1, "activeProjectId": None, "workspaceRevision": "r",
               "projects": {first["id"]: first, second["id"]: second}, "trash": {}}
    text = json.dumps(catalog, separators=(",", ":"))
    close = text.index(f',"{second["id"]}"')
    damaged = text[:close - 1] + text[close:]  # first's closing brace gone
    found = catalog_recovery.salvage(damaged.encode())
    assert second["id"] in found.entries


def test_l5_the_listing_restores_off_the_event_loop(app, monkeypatch):
    client, store, _graph, _state = app
    _create(client, "Alpha")
    seen = {}
    real = store._restore

    def spy(damage):
        try:
            asyncio.get_running_loop()
            seen["loop"] = True
        except RuntimeError:
            seen["loop"] = False
        return real(damage)

    monkeypatch.setattr(store, "_restore", spy)
    store.path.write_text("{not json", encoding="utf-8")
    assert client.get("/api/projects", headers=PERSON).status_code == 200
    assert seen == {"loop": False}


def test_l6_bak_is_a_hard_link_of_the_validated_catalog_and_bak1_a_real_copy(tmp_path):
    store = _store(tmp_path)
    _add(store, "Alpha")
    before = store.path.stat().st_ino
    _add(store, "Beta")
    assert store.backup_path.stat().st_ino == before  # the catalog the commit replaced
    assert store.path.stat().st_ino != before
    assert store.older_backup_path.stat().st_ino not in (before, store.path.stat().st_ino)
    assert oct(store.backup_path.stat().st_mode & 0o777) == "0o600"
    assert not list(store.root.glob(".catalog*.tmp"))


def test_l6_no_temporary_name_is_left_when_bak_is_already_the_same_file(tmp_path):
    store = _store(tmp_path)
    _add(store, "Alpha")
    os.unlink(store.backup_path)
    os.link(store.path, store.backup_path)  # .bak already the catalog itself
    _add(store, "Beta")
    assert not list(store.root.glob(".catalog*.tmp"))


def test_l6_bak_never_takes_a_catalog_that_wasnt_validated(tmp_path):
    store = _store(tmp_path)
    _add(store, "Alpha")
    good = store.backup_path.read_bytes()
    with store.transaction() as catalog:
        store.path.write_bytes(b"{written behind the store's back")
        store.commit(catalog)
    assert store.backup_path.read_bytes() == good


def test_l7_damaged_files_are_pruned_to_a_bound_and_the_new_one_kept(tmp_path):
    store = _store(tmp_path)
    _add(store, "Alpha")
    old = (datetime.now() - timedelta(days=60)).timestamp()
    for index in range(12):
        path = store.root / f"catalog.json.damaged-2026010{index % 10}T000000Z-{index:08x}"
        path.write_bytes(b"x")
        os.utime(path, (old + index, old + index))
    store.path.write_text("{not json", encoding="utf-8")
    store.read()
    [record] = _records(store)
    kept = sorted(store.root.glob("catalog.json.damaged-*"))
    assert Path(record["damagedFile"]) in kept
    assert len(kept) <= store_module.DAMAGED_KEPT_MIN + 1


def test_l7_orphaned_temporary_files_are_swept(tmp_path):
    store = _store(tmp_path)
    _add(store, "Alpha")
    day_old = time.time() - 2 * 86400
    names = [".catalog.0.tmp", ".catalog-backup.1.tmp", ".damaged.2.tmp", ".catalog-bak.3.tmp"]
    for name in names:
        path = store.root / name
        path.write_bytes(b"x")
        os.utime(path, (day_old, day_old))
    fresh = store.root / ".catalog.fresh.tmp"
    fresh.write_bytes(b"x")
    store.sweep_orphans()
    assert not any((store.root / name).exists() for name in names)
    assert fresh.exists()


def test_l9_a_purge_tombstone_is_bounded(tmp_path):
    store = _store(tmp_path)
    ids = _add(store, *[f"P{index}" for index in range(3)])

    def purge(catalog):
        for project_id in ids:
            catalog["projects"].pop(project_id)
        catalog["purged"] = {f"{index:032x}": "2020-01-01T00:00:00+00:00" for index in range(5)}

    _edit(store, purge)
    purged = json.loads(store.path.read_text())["purged"]
    assert set(purged) == set(ids)  # the stale ones went, the new ones stay
