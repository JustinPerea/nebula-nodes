"""The project catalog recovers from a damaged catalog.json (Justin, 2026-10-27).

catalog.json holds every project whole (name, dates, cover, pins, snapshot),
so a file that won't parse or validate used to answer 507 to every project
read and every run start, through restarts, with nothing the person could do.

Now every commit also keeps a last good copy (catalog.json.bak, and an
older generation catalog.json.bak.1), written atomically, and a read that
finds catalog.json damaged or missing:

1. keeps the damaged file (a hard link or copy named
   catalog.json.damaged-<time>-<id>; never deleted), and any damaged copy;
2. restores the newest copy that parses and validates;
3. adds back every complete project the damaged file still holds that the
   copy lacks, or holds newer (a commit whose copy never landed);
4. records the restore once for the person (the Projects home notice) and
   agents (GET /api/projects, start_here, a `project.catalogRestored` event).

With no good copy it rebuilds the list from what the damaged files still
hold; only when they hold no project at all does it refuse with the 507 as
before, changing nothing.
"""
from __future__ import annotations

import json
import os
import sys
import threading
from datetime import datetime, timedelta, timezone
from pathlib import Path
from unittest.mock import AsyncMock

import pytest
from fastapi import HTTPException
from fastapi.testclient import TestClient

sys.path.insert(0, str(Path(__file__).resolve().parent.parent))
import main as main_module  # noqa: E402
from services import project_store as store_module  # noqa: E402
from services.cli_graph import CLIGraph  # noqa: E402
from services.execution_runs import ExecutionRunRegistry  # noqa: E402
from services.project_store import (  # noqa: E402
    ProjectStore, ProjectStoreError, make_project, move_to_trash,
)
from services.provider_recovery import ProviderRecoveryStore  # noqa: E402
from services.provider_start_guard import ProviderStartGuard  # noqa: E402
from tests.conftest import PERSON  # noqa: E402


class Crash(BaseException):
    """The process dying at that point: nothing after it runs, no handler catches it."""


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


def _names(catalog: dict) -> set[str]:
    return {project["name"] for project in catalog["projects"].values()}


def _damaged_files(store: ProjectStore) -> list[Path]:
    return sorted(store.root.glob("catalog.json.damaged-*"))


def _records(store: ProjectStore) -> list[dict]:
    path = store.root / "catalog-restore.json"
    return json.loads(path.read_text())["restores"] if path.exists() else []


# -- the last good copy ----------------------------------------------------------


def test_every_commit_keeps_a_last_good_copy(tmp_path):
    store = _store(tmp_path)
    _add(store, "Alpha")
    assert store.backup_path.exists()
    assert store.backup_path.read_bytes() == store.path.read_bytes()
    assert oct(store.backup_path.stat().st_mode & 0o777) == "0o600"
    _add(store, "Beta")
    # .bak is the catalog each commit replaced (one commit behind, a hard
    # link: review 1 of PR #199, L6); the damaged file holds the newest.
    assert _names(json.loads(store.backup_path.read_text())) == {"Alpha"}
    # No temporary copy is left behind.
    assert not list(store.root.glob(".catalog-backup.*")) and not list(store.root.glob(".catalog-bak.*"))


def test_the_older_copy_rotates_at_most_once_an_interval(tmp_path):
    store = _store(tmp_path)
    _add(store, "Alpha")
    _add(store, "Beta")
    older = store.older_backup_path
    assert _names(json.loads(older.read_text())) == {"Alpha"}  # written by the first commit
    _add(store, "Gamma")
    assert _names(json.loads(older.read_text())) == {"Alpha"}  # still inside the interval
    stale = (datetime.now() - timedelta(hours=2)).timestamp()
    os.utime(older, (stale, stale))
    _add(store, "Delta")
    # Written from the commit that found it stale: a known good catalog, never
    # a rename of whatever the newer copy holds.
    assert _names(json.loads(older.read_text())) == {"Alpha", "Beta", "Gamma", "Delta"}


def test_a_read_seeds_the_copy_for_a_catalog_saved_before_copies(tmp_path):
    store = _store(tmp_path)
    _add(store, "Alpha")
    store.backup_path.unlink()
    store.older_backup_path.unlink(missing_ok=True)
    store.read()
    assert store.backup_path.read_bytes() == store.path.read_bytes()


# -- damaged catalogs ----------------------------------------------------------


def test_corrupt_json_restores_the_last_good_copy_and_keeps_the_damaged_file(tmp_path):
    store = _store(tmp_path)
    alpha, beta = _add(store, "Alpha", "Beta", open_last=True)
    revision = store.read()["workspaceRevision"]
    store.path.write_text("{not json", encoding="utf-8")

    catalog = store.read()

    assert _names(catalog) == {"Alpha", "Beta"}
    # The damaged file can't say which project was open, so none is: never
    # the copy's, which may not be the live canvas's (review 1, H1).
    assert catalog["activeProjectId"] is None
    # Open tabs hold the old list: a new revision makes them reload.
    assert catalog["workspaceRevision"] != revision
    [damaged] = _damaged_files(store)
    assert damaged.read_text() == "{not json"
    assert json.loads(store.path.read_text())["projects"].keys() == {alpha, beta}
    [record] = _records(store)
    assert record["kind"] == "restored"
    assert record["source"] == "catalog.json.bak"
    assert record["damagedFile"] == str(damaged)
    assert record["addedBack"] == [] and record["notAddedBack"] == []
    assert record["projectCount"] == 2
    # Told once: a second read restores nothing more.
    store.read()
    assert len(_records(store)) == 1 and len(_damaged_files(store)) == 1


def test_a_truncated_file_restores_the_last_good_copy(tmp_path):
    store = _store(tmp_path)
    _add(store, "Alpha", "Beta")
    data = store.path.read_bytes()
    store.path.write_bytes(data[: len(data) // 2])

    assert _names(store.read()) == {"Alpha", "Beta"}
    assert _damaged_files(store)[0].read_bytes() == data[: len(data) // 2]
    assert _records(store)[0]["addedBack"] == []


@pytest.mark.parametrize("shape", [
    [1, 2, 3],
    {"version": 1, "projects": {}, "workspaceRevision": 7},
    {"version": 1, "projects": [], "workspaceRevision": "x"},
    {"version": 1, "projects": {"not-an-id": {}}, "workspaceRevision": "x"},
])
def test_the_wrong_shape_restores_the_last_good_copy(tmp_path, shape):
    store = _store(tmp_path)
    _add(store, "Alpha")
    store.path.write_text(json.dumps(shape), encoding="utf-8")

    assert _names(store.read()) == {"Alpha"}
    assert json.loads(_damaged_files(store)[0].read_text()) == shape


def test_a_missing_catalog_with_a_copy_present_is_restored(tmp_path):
    store = _store(tmp_path)
    _add(store, "Alpha", "Beta")
    store.path.unlink()

    assert _names(store.read()) == {"Alpha", "Beta"}
    [record] = _records(store)
    assert record["reason"] == "missing" and record["damagedFile"] is None
    assert not _damaged_files(store)


def test_a_fresh_install_has_no_copy_and_restores_nothing(tmp_path):
    store = _store(tmp_path)
    assert store.read()["projects"] == {}
    assert not store.path.exists() and _records(store) == []


def test_a_corrupt_copy_falls_back_to_the_older_copy_and_keeps_both_damaged_files(tmp_path):
    store = _store(tmp_path)
    _add(store, "Alpha")
    _add(store, "Beta")  # the older copy now holds Alpha
    store.path.write_text("{not json", encoding="utf-8")
    store.backup_path.write_text("also not json", encoding="utf-8")

    catalog = store.read()

    assert "Alpha" in _names(catalog)
    [record] = _records(store)
    assert record["source"] == "catalog.json.bak.1"
    kept = {path.read_text() for path in store.root.glob("catalog.json*damaged-*")}
    assert kept == {"{not json", "also not json"}


def test_with_every_copy_corrupt_it_rebuilds_from_what_the_damaged_files_hold(tmp_path):
    store = _store(tmp_path)
    _add(store, "Alpha")
    _add(store, "Beta")
    whole = store.path.read_bytes()
    store.path.write_bytes(whole[:-5])  # every project still complete
    store.backup_path.write_text("garbage", encoding="utf-8")
    store.older_backup_path.write_text("garbage", encoding="utf-8")

    catalog = store.read()

    assert _names(catalog) == {"Alpha", "Beta"}
    [record] = _records(store)
    assert record["kind"] == "rebuilt" and record["source"] is None
    assert {entry["name"] for entry in record["addedBack"]} == {"Alpha", "Beta"}


def test_with_nothing_to_rebuild_from_it_refuses_as_before_and_changes_nothing(tmp_path):
    store = _store(tmp_path)
    store.root.mkdir(parents=True)
    store.path.write_text("{not json", encoding="utf-8")

    with pytest.raises(ProjectStoreError, match="could not be read"):
        store.read()
    with pytest.raises(ProjectStoreError):
        store.projection()
    assert store.path.read_text() == "{not json"
    assert not _damaged_files(store) and _records(store) == []


# -- reconciling the copy with what is on disk ------------------------------------


def _commit_without_copy(store: ProjectStore, monkeypatch, mutate) -> None:
    """A commit whose change is in catalog.json only. .bak is the catalog a
    commit replaced (review 1, L6), so every commit is one: the latest change
    is only in the file that may then be damaged."""
    with store.transaction() as catalog:
        mutate(catalog)
        store.commit(catalog)


def test_a_crash_between_the_catalog_write_and_the_copy_write_loses_nothing(tmp_path, monkeypatch):
    store = _store(tmp_path)
    _add(store, "Alpha")

    def add_beta(catalog):
        project = make_project("Beta")
        catalog["projects"][project["id"]] = project

    _commit_without_copy(store, monkeypatch, add_beta)
    # The catalog is the newer file and reads as it is.
    assert _names(store.read()) == {"Alpha", "Beta"}
    assert _names(json.loads(store.backup_path.read_text())) == {"Alpha"}
    assert _records(store) == []
    # The next commit keeps this one as the copy.
    _add(store, "Gamma")
    assert _names(json.loads(store.backup_path.read_text())) == {"Alpha", "Beta"}


def test_projects_created_after_the_copy_are_added_back_from_the_damaged_file(tmp_path, monkeypatch):
    store = _store(tmp_path)
    _add(store, "Alpha")
    made = {}

    def add_two(catalog):
        for name in ("Beta", "Gamma"):
            project = make_project(name)
            catalog["projects"][project["id"]] = project
            made[name] = project["id"]
        catalog["activeProjectId"] = made["Gamma"]

    _commit_without_copy(store, monkeypatch, add_two)
    whole = store.path.read_bytes()
    store.path.write_bytes(whole[:-4])  # damaged after the last project

    catalog = store.read()

    assert _names(catalog) == {"Alpha", "Beta", "Gamma"}
    # The damaged file still says which project was open.
    assert catalog["activeProjectId"] == made["Gamma"]
    [record] = _records(store)
    assert record["kind"] == "restored"
    assert [entry["name"] for entry in record["addedBack"]] == ["Beta", "Gamma"]
    assert all(entry["trashed"] is False for entry in record["addedBack"])


def test_a_project_cut_off_by_the_damage_is_reported_not_added(tmp_path, monkeypatch):
    store = _store(tmp_path)
    _add(store, "Alpha")
    made = {}

    def add_beta(catalog):
        project = make_project("Beta")
        catalog["projects"][project["id"]] = project
        made["Beta"] = project["id"]

    _commit_without_copy(store, monkeypatch, add_beta)
    text = store.path.read_text()
    cut = text.index(f'"{made["Beta"]}":') + 50  # inside Beta's record
    store.path.write_text(text[:cut], encoding="utf-8")

    catalog = store.read()

    assert _names(catalog) == {"Alpha"}
    [record] = _records(store)
    assert record["addedBack"] == []
    [row] = record["notAddedBack"]
    assert (row["id"], row["reason"], row["trashed"]) == (made["Beta"], "incomplete", False)


def test_a_project_moved_to_recently_deleted_after_the_copy_stays_there(tmp_path, monkeypatch):
    store = _store(tmp_path)
    alpha, beta = _add(store, "Alpha", "Beta", open_last=True)

    def delete_beta(catalog):
        move_to_trash(catalog, beta)
        catalog["activeProjectId"] = None  # as the delete route leaves it

    _commit_without_copy(store, monkeypatch, delete_beta)
    whole = store.path.read_bytes()
    store.path.write_bytes(whole[:-1])

    catalog = store.read()

    assert set(catalog["projects"]) == {alpha}
    assert set(catalog["trash"]) == {beta}
    assert catalog["activeProjectId"] is None  # it can't stay open in the trash
    [record] = _records(store)
    assert record["updatedFromDisk"] == [{"id": beta, "name": "Beta", "trashed": True}]


def test_a_project_deleted_for_good_after_the_copy_stays_deleted_by_the_side_file(tmp_path, monkeypatch):
    """A delete for good as the latest commit, then a catalog.json that can't
    be read at all: catalog-purged.json, written right after that commit,
    proves it (review 4 of PR #199, L-3), so it stays deleted and says so.
    Before it, nothing proved it and the project came back from the copy."""
    store = _store(tmp_path)
    _alpha, beta = _add(store, "Alpha", "Beta")

    _commit_without_copy(store, monkeypatch, lambda catalog: catalog["projects"].pop(beta))
    store.path.write_text("{not json", encoding="utf-8")

    assert _names(store.read()) == {"Alpha"}
    assert [row["id"] for row in _records(store)[-1]["keptDeleted"]] == [beta]


def test_a_project_deleted_for_good_comes_back_when_nothing_proves_it(tmp_path, monkeypatch):
    """Every project's data lives in the catalog itself, so a project the copy
    holds is never "gone". With catalog.json unreadable and the side file
    gone too, nothing proves the purge, so it comes back (to delete again)
    instead of being dropped. (A readable head remembers the purge, and it
    stays deleted: test_project_catalog_restore_fix1.py.)"""
    store = _store(tmp_path)
    _alpha, beta = _add(store, "Alpha", "Beta")

    _commit_without_copy(store, monkeypatch, lambda catalog: catalog["projects"].pop(beta))
    store.path.write_text("{not json", encoding="utf-8")
    (store.root / store_module.PURGED_NAME).unlink()

    assert _names(store.read()) == {"Alpha", "Beta"}


def test_an_older_copy_of_a_project_in_the_damaged_file_never_replaces_the_good_copy(tmp_path):
    """A damaged file older than its copy (a sync tool put an old one back):
    a record dated before the copy's never rolls the project back."""
    store = _store(tmp_path)
    [alpha] = _add(store, "Alpha")
    with store.transaction() as catalog:
        catalog["projects"][alpha]["name"] = "Alpha, renamed"
        catalog["projects"][alpha]["updatedAt"] = datetime.now(timezone.utc).isoformat()
        store.commit(catalog)
    _add(store, "Beta")  # .bak now holds the rename
    stale = json.loads(store.path.read_text())
    stale["projects"][alpha]["name"] = "Alpha, damaged"
    for key in ("updatedAt", "lastOpenedAt", "createdAt"):
        stale["projects"][alpha][key] = "2020-01-01T00:00:00+00:00"
    stale["workspaceRevision"] = 7  # the wrong shape: damaged
    store.path.write_text(json.dumps(stale), encoding="utf-8")

    assert _names(store.read()) == {"Alpha, renamed", "Beta"}


# -- concurrency ---------------------------------------------------------------


def test_concurrent_readers_restore_once_and_all_see_the_restored_list(tmp_path):
    store = _store(tmp_path)
    _add(store, "Alpha", "Beta")
    store.path.write_text("{not json", encoding="utf-8")
    readers = 12
    barrier = threading.Barrier(readers)
    seen: list[object] = []
    lock = threading.Lock()

    def read(index: int) -> None:
        mine = ProjectStore(store.root)  # another request, or another process's store
        barrier.wait()
        try:
            if index % 3 == 0:
                result = mine.projection().revision
            elif index % 3 == 1:
                result = _names(mine.read_unlocked())
            else:
                result = _names(mine.read())
        except Exception as exc:  # noqa: BLE001 - every reader must succeed
            result = exc
        with lock:
            seen.append(result)

    threads = [threading.Thread(target=read, args=(i,)) for i in range(readers)]
    for thread in threads:
        thread.start()
    for thread in threads:
        thread.join(30)

    assert not [result for result in seen if isinstance(result, Exception)], seen
    assert all(result == {"Alpha", "Beta"} for result in seen if isinstance(result, set))
    assert len(_records(store)) == 1
    assert len(_damaged_files(store)) == 1


def test_a_reader_inside_a_transaction_recovers_without_waiting_for_its_own_lock(tmp_path):
    store = _store(tmp_path)
    _add(store, "Alpha")
    done = threading.Event()

    def nested() -> None:
        with store.transaction():
            store.path.write_text("{not json", encoding="utf-8")  # damaged while held
            store.projection()
        done.set()

    worker = threading.Thread(target=nested)
    worker.start()
    worker.join(10)
    assert done.is_set(), "a recovery inside the lock's own holder deadlocked"


# -- the notice --------------------------------------------------------------------


def test_the_notice_lasts_until_the_person_dismisses_it(tmp_path):
    store = _store(tmp_path)
    _add(store, "Alpha")
    store.path.write_text("{not json", encoding="utf-8")
    store.read()
    notice = store.restore_notice()
    assert notice is not None and notice["kind"] == "restored"
    assert store.dismiss_restore("not-that-one") is False
    assert store.dismiss_restore(notice["id"]) is True
    assert store.restore_notice() is None


def test_the_store_announces_each_restore_once(tmp_path):
    store = _store(tmp_path)
    _add(store, "Alpha")
    heard: list[dict] = []
    store.on_restore = heard.append
    store.path.write_text("{not json", encoding="utf-8")
    store.read()
    store.read()
    assert [record["kind"] for record in heard] == ["restored"]


# -- the app -------------------------------------------------------------------------


@pytest.fixture
def workspace(tmp_path, monkeypatch, person):
    graph = CLIGraph(persist_path=tmp_path / "state.json")
    store = ProjectStore(tmp_path / "projects")
    monkeypatch.setattr(main_module, "cli_graph", graph)
    monkeypatch.setattr(main_module, "project_store", store)
    store.on_restore = main_module._on_catalog_restore
    monkeypatch.setattr(main_module, "provider_recovery_store", ProviderRecoveryStore(None))
    monkeypatch.setattr(main_module, "provider_start_guard", ProviderStartGuard(tmp_path / "paid-starts.json"))
    monkeypatch.setattr(main_module, "execution_runs", ExecutionRunRegistry())
    monkeypatch.setattr(main_module, "_graph_recovery_bootstrap_error", None)
    broadcast = AsyncMock()
    monkeypatch.setattr(main_module.manager, "broadcast_raw", broadcast)
    return TestClient(main_module.app), store, broadcast


def test_the_listing_carries_the_restore_until_the_person_dismisses_it(workspace):
    client, store, broadcast = workspace
    created = client.post("/api/projects", json={"name": "Alpha"}, headers=PERSON).json()
    store.path.write_text("{not json", encoding="utf-8")

    listing = client.get("/api/projects", headers=PERSON)

    assert listing.status_code == 200
    body = listing.json()
    assert [project["name"] for project in body["projects"]] == ["Alpha"]
    restore = body["catalogRestore"]
    assert restore["kind"] == "restored" and restore["source"] == "catalog.json.bak"
    assert restore["damagedFile"].endswith(_damaged_files(store)[0].name)
    assert restore["addedBack"] == [] and restore["addedBackCount"] == 0
    assert "note" in restore  # what agents read
    # Agents can't dismiss the person's notice.
    agent = client.post("/api/projects/catalog-restore/dismiss", json={"id": restore["id"]},
                        headers={"X-Nebula-Agent": "Codex"})
    assert agent.status_code == 403
    assert client.get("/api/projects", headers=PERSON).json()["catalogRestore"]["id"] == restore["id"]
    dismissed = client.post("/api/projects/catalog-restore/dismiss", json={"id": restore["id"]}, headers=PERSON)
    assert dismissed.status_code == 200
    assert "catalogRestore" not in client.get("/api/projects", headers=PERSON).json()
    assert created["project"]["id"] in store.read()["projects"]


def test_a_restore_is_journaled_for_agents_with_its_source_and_damaged_file(workspace):
    client, store, _ = workspace
    client.post("/api/projects", json={"name": "Alpha"}, headers=PERSON)
    store.path.write_text("{not json", encoding="utf-8")
    since = main_module.canvas_events.latest
    client.get("/api/projects", headers=PERSON)
    events = [event for event in main_module.canvas_events.read(after=since)["events"]
              if event["kind"] == "project.catalogRestored"]
    assert len(events) == 1
    data = events[0]["data"]
    assert data["source"] == "catalog.json.bak" and data["damagedFile"].endswith(_damaged_files(store)[0].name)


def test_a_restore_while_a_run_is_starting_refuses_the_start_as_out_of_date(workspace, monkeypatch):
    """A run start that read the workspace before the restore can't run on
    the restored list it never saw: it is refused as out of date (409, the
    tab reloads), never a 507, and nothing starts."""
    client, store, _ = workspace
    created = client.post("/api/projects", json={"name": "Alpha"}, headers=PERSON).json()
    revision = created["workspaceRevision"]
    execute_graph = AsyncMock()
    monkeypatch.setattr(main_module, "execute_graph", execute_graph)
    fence = main_module._graph_fence()
    store.path.write_text("{not json", encoding="utf-8")

    # A start already past its first check, then the restore lands.
    with pytest.raises(HTTPException) as refused:
        main_module._refuse_if_graph_moved(fence)
    assert refused.value.status_code == 409
    # A start that arrives with the old revision.
    response = client.post("/api/execute", json={"nodes": [], "edges": [], "runId": "after-restore"},
                           headers={**PERSON, "X-Nebula-Workspace-Revision": revision})
    assert response.status_code == 409
    assert execute_graph.await_count == 0
    # The reloaded tab's start goes ahead on the restored list.
    current = client.get("/api/projects", headers=PERSON).json()["workspaceRevision"]
    response = client.post("/api/execute", json={"nodes": [], "edges": [], "runId": "reloaded"},
                           headers={**PERSON, "X-Nebula-Workspace-Revision": current})
    assert response.status_code == 200, response.text


def test_start_here_tells_agents_about_an_undismissed_restore(workspace):
    from services import agent_start

    part = agent_start.catalog_restore_part({
        "id": "a" * 32, "at": "2026-10-27T10:00:00+00:00", "kind": "restored", "source": "catalog.json.bak",
        "damagedFile": "/x/projects/catalog.json.damaged-1", "addedBack": [{"id": "b" * 32, "name": "Beta", "trashed": False}],
        "addedBackCount": 1, "notAddedBack": [], "notAddedBackCount": 0, "projectCount": 3, "note": "n",
    })
    built = agent_start.build(catalogRestore=part, **{name: {} for name in agent_start.BUDGETS})
    assert list(built)[0] == "catalogRestore"
    assert built["catalogRestore"]["addedBack"] == [{"id": "b" * 32, "name": "Beta"}]
    assert "catalogRestore" not in agent_start.build(**{name: {} for name in agent_start.BUDGETS})


def test_list_projects_and_nebula_context_carry_the_restore_for_agents():
    import project_client
    from cli.formatter import format_start

    restore = {"id": "a" * 32, "kind": "restored", "note": "Nebula found its project list (catalog.json) corrupt."}

    class Api:
        base_url = "http://127.0.0.1:8799"

        def request(self, method, path, **_kwargs):
            return {"projects": [], "activeProjectId": None, "workspaceRevision": "r", "catalogRestore": restore}

    assert project_client.list_projects(Api())["catalogRestore"] == restore
    text = format_start({"catalogRestore": restore, "canvas": {}, "pins": {}, "proposals": {}, "boards": {},
                         "nodes": {}, "spend": {}, "next": {}})
    assert text.splitlines()[0] == f"PROJECT LIST RESTORED: {restore['note']}"


def test_the_agents_note_names_the_source_what_came_back_and_where_the_damaged_file_is():
    note = main_module._catalog_restore_note({
        "kind": "restored", "reason": "corrupt", "source": "catalog.json.bak", "addedBackCount": 2,
        "notAddedBackCount": 1, "setAside": ["/s/projects/catalog.json.damaged-x"], "openProjectMissing": None,
    })
    assert note == (
        "Nebula found its project list (catalog.json) corrupt and restored it from catalog.json.bak. "
        "2 projects the copy lacked were added back from the damaged file. "
        "1 project in the damaged file could not be added back and stays only there (notAddedBack). "
        "The damaged file is kept at /s/projects/catalog.json.damaged-x. "
        "Project ids read before it may be stale: list the projects again (list_projects, `nebula projects`).")


def test_a_missing_catalog_whose_copies_are_all_damaged_and_empty_starts_empty_and_keeps_them(tmp_path):
    """Before copies, a missing catalog.json was an empty list. With only
    damaged copies holding no project, that stays so (a refusal would never
    end), and the damaged copies are kept."""
    store = _store(tmp_path)
    _add(store, "Alpha")
    store.path.unlink()
    store.backup_path.write_text("", encoding="utf-8")
    store.older_backup_path.write_text("{", encoding="utf-8")

    assert store.read()["projects"] == {}
    kept = sorted(path.read_text() for path in store.root.glob("catalog.json.bak*.damaged-*"))
    assert kept == ["", "{"]
    assert not store.backup_path.exists() or store.backup_path.read_text() != ""


def test_a_restore_tried_again_after_a_failure_keeps_the_damaged_file_once(tmp_path, monkeypatch):
    store = _store(tmp_path)
    _add(store, "Alpha")
    store.path.write_text("{not json", encoding="utf-8")
    real = store.commit_prepared

    def fail(_temporary):
        raise OSError("disk went away")

    monkeypatch.setattr(store, "commit_prepared", fail)
    with pytest.raises(ProjectStoreError):
        store.read()
    monkeypatch.setattr(store, "commit_prepared", real)
    assert _names(store.read()) == {"Alpha"}
    assert len(_damaged_files(store)) == 1
    assert store.restore_notice() is not None


def test_a_catalog_past_the_project_limit_with_what_was_added_back_restores_the_copy_alone(tmp_path, monkeypatch):
    from services import project_store as module

    store = _store(tmp_path)
    _add(store, "Alpha")

    def add_beta(catalog):
        project = make_project("Beta")
        catalog["projects"][project["id"]] = project

    _commit_without_copy(store, monkeypatch, add_beta)
    store.path.write_bytes(store.path.read_bytes()[:-2])
    monkeypatch.setattr(module, "MAX_PROJECTS", 1)

    assert _names(store.read()) == {"Alpha"}
    [record] = _records(store)
    assert record["addedBack"] == [] and [row["reason"] for row in record["notAddedBack"]] == ["limit"]
