"""A project deleted for good takes its moodboards with it
(services/project_board_purge.py): Delete forever, both Empties and the
30-day expiry; crash safety; the one-time sweep of boards earlier purges
left; the re-home never moves a purge's boards to Global."""
from __future__ import annotations

import asyncio
import json
import sys
from datetime import datetime, timedelta, timezone
from pathlib import Path
from unittest.mock import AsyncMock

import pytest
from fastapi.testclient import TestClient

sys.path.insert(0, str(Path(__file__).resolve().parent.parent))
import main as main_module
from services import project_board_purge
from services.cli_graph import CLIGraph
from services.execution_runs import ExecutionRunRegistry
from services.moodboard_store import MoodboardStore
from services.project_store import ProjectStore
from services.provider_recovery import ProviderRecoveryStore
from services.provider_start_guard import ProviderStartGuard


@pytest.fixture
def ws(tmp_path, monkeypatch):
    boards = tmp_path / "moodboards"
    monkeypatch.setenv("NEBULA_MOODBOARD_ROOT", str(boards))
    graph = CLIGraph(persist_path=tmp_path / "state.json")
    store = ProjectStore(tmp_path / "projects")
    monkeypatch.setattr(main_module, "cli_graph", graph)
    monkeypatch.setattr(main_module, "project_store", store)
    monkeypatch.setattr(main_module, "provider_recovery_store", ProviderRecoveryStore(None))
    monkeypatch.setattr(main_module, "provider_start_guard", ProviderStartGuard(tmp_path / "paid-starts.json"))
    monkeypatch.setattr(main_module, "execution_runs", ExecutionRunRegistry())
    monkeypatch.setattr(main_module, "_graph_recovery_bootstrap_error", None)
    broadcast = AsyncMock()
    monkeypatch.setattr(main_module.manager, "broadcast_raw", broadcast)
    return TestClient(main_module.app), store, boards, broadcast


def _create(client, name, revision=None):
    body = {"name": name, **({"workspaceRevision": revision} if revision else {})}
    response = client.post("/api/projects", json=body)
    assert response.status_code == 200, response.text
    return response.json()


def _trash(client, project_id, revision):
    response = client.request("DELETE", f"/api/projects/{project_id}", json={"workspaceRevision": revision})
    assert response.status_code == 200, response.text


def _board(project_id, name="Board"):
    return MoodboardStore().create(name=name, images=[], projectId=project_id)


def _notes(boards: Path, board_id: str) -> Path:
    path = boards / ".notes" / f"{board_id}.json"
    path.parent.mkdir(parents=True, exist_ok=True)
    path.write_text(json.dumps({"boardId": board_id, "notes": []}))
    return path


def _two_projects(client):
    a = _create(client, "A")
    b = _create(client, "B", a["workspaceRevision"])
    return a["project"]["id"], b["project"]["id"], b["workspaceRevision"]


def _gone(client, board_id):
    """A board deleted for good answers as one that never existed: 404, no in_trash."""
    response = client.get(f"/api/moodboards/{board_id}")
    return response.status_code == 404 and response.json().get("code") is None


def test_delete_forever_takes_the_projects_boards_and_nothing_else(ws, person):
    client, store, boards, broadcast = ws
    doomed, other, revision = _two_projects(client)
    mine = _board(doomed, "Mine")
    trashed = _board(doomed, "Trashed")
    MoodboardStore().delete(trashed["id"])
    keep_project = _board(other, "Other project's")
    keep_global = _board(None, "Global")
    notes = _notes(boards, mine["id"])
    _trash(client, doomed, revision)
    # In Recently deleted the boards are still there (restoring brings them back).
    assert client.get(f"/api/moodboards/{mine['id']}").status_code == 200

    response = client.request("DELETE", f"/api/projects/trash/{doomed}", headers=person.headers)
    assert response.status_code == 200, response.text
    assert _gone(client, mine["id"]) and _gone(client, trashed["id"])
    assert not notes.exists()
    assert not (boards / doomed).exists()
    assert all(item["id"] != trashed["id"] for item in client.get("/api/trash").json()["items"])
    for kept in (keep_project, keep_global):
        assert client.get(f"/api/moodboards/{kept['id']}").status_code == 200
    # The journal is cleared once the boards are gone.
    assert project_board_purge.PENDING_KEY not in store.read()
    # Each board's gone event goes out before projectsChanged.
    sent = [call.args[0] for call in broadcast.await_args_list]
    gone = [i for i, m in enumerate(sent) if m.get("type") == "storedAssetChanged" and m.get("deleted")
            and m.get("id") in (mine["id"], trashed["id"])]
    changed = [i for i, m in enumerate(sent) if m.get("type") == "projectsChanged" and m.get("change") == "purged"]
    assert len(gone) == 2 and changed and max(gone) < changed[-1]


@pytest.mark.parametrize("route", ["projects", "trash"])
def test_empty_takes_the_boards_of_what_it_deleted_only(ws, person, route):
    client, store, boards, _ = ws
    a = _create(client, "A")
    b = _create(client, "B", a["workspaceRevision"])
    c = _create(client, "C", b["workspaceRevision"])
    ida, idb = a["project"]["id"], b["project"]["id"]
    in_a, in_b = _board(ida), _board(idb)
    _trash(client, ida, c["workspaceRevision"])
    _trash(client, idb, c["workspaceRevision"])
    # The person's list showed only A: B (trashed after it loaded) stays, boards and all.
    if route == "projects":
        response = client.post("/api/projects/trash/empty", json={"ids": [ida]}, headers=person.headers)
    else:
        response = client.post("/api/trash/empty", json={"items": [{"kind": "project", "id": ida}]},
                               headers=person.headers)
    assert response.status_code == 200, response.text
    assert _gone(client, in_a["id"])
    assert client.get(f"/api/moodboards/{in_b['id']}").status_code == 200


def test_the_30_day_expiry_takes_the_boards(ws):
    client, store, boards, _ = ws
    old, keep, revision = _two_projects(client)
    board = _board(old)
    _trash(client, old, revision)
    with store.transaction() as catalog:
        catalog["trash"][old]["deletedAt"] = (datetime.now(timezone.utc) - timedelta(days=31)).isoformat()
        store.commit(catalog)
    assert client.get(f"/api/moodboards/{board['id']}").status_code == 200
    listed = client.get("/api/trash")  # any listing applies the expiry
    assert listed.status_code == 200
    assert _gone(client, board["id"])
    assert old not in store.read()["trash"]


def test_agents_still_cant_delete_for_good(ws):
    client, store, boards, _ = ws
    doomed, other, revision = _two_projects(client)
    board = _board(doomed)
    _trash(client, doomed, revision)
    for method, path in (("DELETE", f"/api/projects/trash/{doomed}"), ("POST", "/api/projects/trash/empty"),
                         ("DELETE", f"/api/trash/project/{doomed}"), ("POST", "/api/trash/empty")):
        assert client.request(method, path, headers={"X-Nebula-Agent": "Claude"}).status_code == 403
    assert client.get(f"/api/moodboards/{board['id']}").status_code == 200


# -- crash safety ----------------------------------------------------------------


def test_a_failed_commit_changes_nothing(ws, person, monkeypatch):
    client, store, boards, _ = ws
    doomed, other, revision = _two_projects(client)
    board = _board(doomed)
    _trash(client, doomed, revision)

    def broken(_temporary):
        raise OSError("disk full")
    real_commit = store.commit_prepared
    monkeypatch.setattr(store, "commit_prepared", broken)
    try:
        refused = client.request("DELETE", f"/api/projects/trash/{doomed}", headers=person.headers)
    except Exception:  # noqa: BLE001 - raised through the test client, or answered as an error
        refused = None
    assert refused is None or refused.status_code >= 500
    monkeypatch.setattr(store, "commit_prepared", real_commit)
    # The project is still in Recently deleted, with its board.
    assert doomed in store.read()["trash"]
    assert (boards / doomed / f"{board['id']}.json").is_file()


def test_a_purge_stopped_part_way_finishes_on_the_next_start(ws, person, monkeypatch, tmp_path):
    client, store, boards, _ = ws
    doomed, other, revision = _two_projects(client)
    first, second = _board(doomed, "First"), _board(doomed, "Second")
    _trash(client, doomed, revision)
    real_unlink = Path.unlink
    calls = {"n": 0}

    def flaky(self, *args, **kwargs):
        if self.parent.name == doomed and self.suffix == ".json":
            calls["n"] += 1
            if calls["n"] == 2:
                raise OSError("the disk went away")
        return real_unlink(self, *args, **kwargs)

    monkeypatch.setattr(Path, "unlink", flaky)
    response = client.request("DELETE", f"/api/projects/trash/{doomed}", headers=person.headers)
    monkeypatch.setattr(Path, "unlink", real_unlink)
    # The project went (its commit is the purge); one board is left, and the
    # catalog says its boards are still to go, so nothing points at a catalog
    # entry that isn't on that list.
    assert response.status_code == 200, response.text
    catalog = store.read()
    assert doomed not in catalog["trash"] and doomed not in catalog["projects"]
    assert catalog[project_board_purge.PENDING_KEY] == [doomed]
    left = [b for b in (first, second) if (boards / doomed / f"{b['id']}.json").exists()]
    assert len(left) == 1
    # A restart (the start-up step) finishes it.
    monkeypatch.delenv("NEBULA_NO_ASSET_REHOME", raising=False)
    monkeypatch.setattr(main_module, "_STATE_DIR", tmp_path / "state")
    asyncio.run(main_module._project_board_purge_startup())
    assert not (boards / doomed).exists()
    assert project_board_purge.PENDING_KEY not in store.read()
    assert _gone(client, left[0]["id"])


def test_a_purge_stopped_part_way_finishes_on_the_next_purge(ws, person, monkeypatch):
    client, store, boards, _ = ws
    a = _create(client, "A")
    b = _create(client, "B", a["workspaceRevision"])
    c = _create(client, "C", b["workspaceRevision"])
    ida, idb = a["project"]["id"], b["project"]["id"]
    in_a, in_b = _board(ida), _board(idb)
    _trash(client, ida, c["workspaceRevision"])
    _trash(client, idb, c["workspaceRevision"])
    real_delete = project_board_purge.delete_project_boards
    monkeypatch.setattr(project_board_purge, "delete_project_boards",
                        lambda *a, **k: (_ for _ in ()).throw(OSError("busy")))
    assert client.request("DELETE", f"/api/projects/trash/{ida}", headers=person.headers).status_code == 200
    monkeypatch.setattr(project_board_purge, "delete_project_boards", real_delete)
    assert store.read()[project_board_purge.PENDING_KEY] == [ida]
    assert client.request("DELETE", f"/api/projects/trash/{idb}", headers=person.headers).status_code == 200
    assert _gone(client, in_a["id"]) and _gone(client, in_b["id"])
    assert project_board_purge.PENDING_KEY not in store.read()


def test_the_rehome_never_moves_a_pending_purge_to_global(ws, person, monkeypatch, tmp_path):
    from services.asset_project_rehome import AssetRoot, rehome_legacy_assets

    client, store, boards, _ = ws
    doomed, other, revision = _two_projects(client)
    board = _board(doomed)
    _trash(client, doomed, revision)
    real_delete = project_board_purge.delete_project_boards
    monkeypatch.setattr(project_board_purge, "delete_project_boards",
                        lambda *a, **k: (_ for _ in ()).throw(OSError("busy")))
    client.request("DELETE", f"/api/projects/trash/{doomed}", headers=person.headers)
    monkeypatch.setattr(project_board_purge, "delete_project_boards", real_delete)
    report = rehome_legacy_assets(store.read, tmp_path / "state", roots=[AssetRoot("moodboard", boards, True)])
    assert report["status"] == "nothing to do"
    assert (boards / doomed / f"{board['id']}.json").is_file()
    assert not (boards / "_global" / f"{board['id']}.json").exists()


# -- guards (unit) -----------------------------------------------------------------


def test_never_deletes_the_boards_of_a_project_the_catalog_still_has(tmp_path, monkeypatch):
    monkeypatch.setenv("NEBULA_MOODBOARD_ROOT", str(tmp_path))
    pid = "a" * 32
    board = _board_raw(tmp_path, pid, "b1")
    with pytest.raises(ValueError):
        project_board_purge.delete_project_boards(tmp_path, pid, keep={pid})
    assert board.is_file()
    # finish() drops a listed id the catalog has again, without deleting.
    catalog = {"projects": {pid: {}}, "trash": {}, project_board_purge.PENDING_KEY: [pid]}
    done, removed = project_board_purge.finish(tmp_path, catalog)
    assert done == [pid] and removed == [] and board.is_file()


def _board_raw(root: Path, folder: str, board_id: str, project_id: str | None = "same") -> Path:
    path = root / folder / f"{board_id}.json"
    path.parent.mkdir(parents=True, exist_ok=True)
    path.write_text(json.dumps({"id": board_id, "name": board_id,
                                "projectId": folder if project_id == "same" else project_id}))
    return path


def test_side_files_stay_while_another_copy_of_the_board_lives(tmp_path, monkeypatch):
    monkeypatch.setenv("NEBULA_MOODBOARD_ROOT", str(tmp_path))
    pid = "b" * 32
    _board_raw(tmp_path, pid, "shared")
    _board_raw(tmp_path, "_global", "shared", project_id=None)  # a re-home collision left a copy
    _board_raw(tmp_path, pid, "alone")
    shared_notes, alone_notes = _notes(tmp_path, "shared"), _notes(tmp_path, "alone")
    removed = project_board_purge.delete_project_boards(tmp_path, pid, keep=set())
    assert sorted(removed) == ["alone", "shared"]
    assert shared_notes.exists() and not alone_notes.exists()
    assert (tmp_path / "_global" / "shared.json").is_file()


def test_a_board_that_names_another_project_is_left(tmp_path, monkeypatch):
    monkeypatch.setenv("NEBULA_MOODBOARD_ROOT", str(tmp_path))
    pid = "c" * 32
    stray = _board_raw(tmp_path, pid, "stray", project_id=None)
    (tmp_path / pid / "broken.json").write_text("{not json")
    mine = _board_raw(tmp_path, pid, "mine")
    assert project_board_purge.delete_project_boards(tmp_path, pid, keep=set()) == ["mine"]
    assert stray.is_file() and (tmp_path / pid / "broken.json").is_file() and not mine.exists()


# -- the one-time sweep ------------------------------------------------------------


def _sweep_setup(tmp_path):
    state = tmp_path / ".nebula"
    root = state / "moodboards"
    live, trashed, purged = "1" * 32, "2" * 32, "3" * 32
    catalog = {"projects": {live: {}}, "trash": {trashed: {}}}
    paths = {
        "live": _board_raw(root, live, "inlive"),
        "trashed": _board_raw(root, trashed, "intrash"),
        "purged": _board_raw(root, purged, "orphan"),
        "global": _board_raw(root, "_global", "g", project_id=None),
        "old_style": _board_raw(root, "nebula_nodes", "legacy"),
    }
    # A board deleted from the purged project, waiting in the boards' trash.
    trash = root / ".trash"
    trash.mkdir()
    (trash / "binned.json").write_text(json.dumps({"id": "binned", "projectId": purged}))
    (trash / "binned.trash.json").write_text(json.dumps({"id": "binned", "projectId": purged, "scopeDir": purged}))
    return state, root, catalog, paths


def test_the_sweep_removes_only_provable_orphans_once(tmp_path, monkeypatch, caplog):
    state, root, catalog, paths = _sweep_setup(tmp_path)
    monkeypatch.setenv("NEBULA_MOODBOARD_ROOT", str(root))
    with caplog.at_level("INFO", logger="services.project_board_purge"):
        report = project_board_purge.sweep_orphans(root, catalog, state_dir=state)
    assert report == {"status": "done", "boards": 2}
    assert not paths["purged"].exists() and not (root / ".trash" / "binned.json").exists()
    for kept in ("live", "trashed", "global", "old_style"):
        assert paths[kept].is_file(), kept
    # The count, never a name.
    assert "2 removed" in caplog.text and "orphan" not in caplog.text and "binned" not in caplog.text
    # Once: a board orphaned later (an older Nebula's purge) is left to the re-home.
    again = _board_raw(root, "4" * 32, "later")
    assert project_board_purge.sweep_orphans(root, catalog, state_dir=state)["status"] == "done before"
    assert again.is_file()


@pytest.mark.parametrize("case", ["no catalog", "empty catalog", "unpaired root", "pending"])
def test_the_sweep_does_nothing_without_proof(tmp_path, monkeypatch, case):
    state, root, catalog, paths = _sweep_setup(tmp_path)
    monkeypatch.setenv("NEBULA_MOODBOARD_ROOT", str(root))
    if case == "no catalog":
        catalog = None
    elif case == "empty catalog":
        catalog = {"projects": {}, "trash": {}}
    elif case == "unpaired root":
        state = tmp_path / "elsewhere"  # a backend pointed at another catalog
    else:
        catalog[project_board_purge.PENDING_KEY] = ["3" * 32]  # finish() owns it, not the sweep
    report = project_board_purge.sweep_orphans(root, catalog, state_dir=state)
    assert paths["purged"].is_file()
    if case == "pending":
        assert report["status"] == "done" and report["boards"] == 0
    else:
        assert report["status"].startswith("skipped") and not (state / "migrations").exists()


def test_the_desktop_layout_counts_as_paired(tmp_path):
    data = tmp_path / "Nebula"
    assert project_board_purge.roots_paired(data / "state", data / "moodboards")
    assert project_board_purge.roots_paired(tmp_path / ".nebula", tmp_path / ".nebula" / "moodboards")
    assert not project_board_purge.roots_paired(tmp_path / "x", tmp_path / ".nebula" / "moodboards")
    assert not project_board_purge.roots_paired(data / "other", data / "moodboards")


def test_only_the_projects_own_trashed_boards_go(tmp_path, monkeypatch):
    monkeypatch.setenv("NEBULA_MOODBOARD_ROOT", str(tmp_path))
    pid, other = "d" * 32, "e" * 32
    trash = tmp_path / ".trash"
    trash.mkdir()
    for board_id, project_id, scope in (("mine", pid, pid), ("theirs", other, other), ("global", None, "_global")):
        (trash / f"{board_id}.json").write_text(json.dumps({"id": board_id, "projectId": project_id}))
        (trash / f"{board_id}.trash.json").write_text(json.dumps({"id": board_id, "projectId": project_id,
                                                                  "scopeDir": scope}))
    assert project_board_purge.delete_project_boards(tmp_path, pid, keep={other}) == ["mine"]
    assert not (trash / "mine.json").exists() and not (trash / "mine.trash.json").exists()
    for kept in ("theirs", "global"):
        assert (trash / f"{kept}.json").is_file() and (trash / f"{kept}.trash.json").is_file()
