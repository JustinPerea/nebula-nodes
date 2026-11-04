"""A project deleted for good takes its moodboards, characters and styles with
it (services/project_asset_purge.py): Delete forever, both Empties and the
30-day expiry; crash safety; the one-time sweep of what earlier purges left;
the re-home never moves a purge's files to Global; the listing says what goes."""
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
from services import project_asset_purge as purge
from services.cli_graph import CLIGraph
from services.execution_runs import ExecutionRunRegistry
from services.moodboard_store import MoodboardStore
from services.project_store import ProjectStore
from services.provider_recovery import ProviderRecoveryStore
from services.provider_start_guard import ProviderStartGuard

PENDING = purge.PENDING_KEY


@pytest.fixture
def ws(tmp_path, monkeypatch):
    roots = {"moodboard": tmp_path / "moodboards", "character": tmp_path / "characters", "style": tmp_path / "presets"}
    monkeypatch.setenv("NEBULA_MOODBOARD_ROOT", str(roots["moodboard"]))
    monkeypatch.setenv("NEBULA_CHARACTER_ROOT", str(roots["character"]))
    monkeypatch.setenv("NEBULA_PRESET_ROOT", str(roots["style"]))
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
    return TestClient(main_module.app), store, roots, broadcast


def _create(client, name, revision=None):
    body = {"name": name, **({"workspaceRevision": revision} if revision else {})}
    response = client.post("/api/projects", json=body)
    assert response.status_code == 200, response.text
    return response.json()


def _trash(client, project_id, revision):
    response = client.request("DELETE", f"/api/projects/{project_id}", json={"workspaceRevision": revision})
    assert response.status_code == 200, response.text
    return response.json()


def _board(project_id, name="Board"):
    return MoodboardStore().create(name=name, images=[], projectId=project_id)


def _raw(root: Path, folder: str, asset_id: str, project_id: str | None = "same", name: str | None = None) -> Path:
    """An asset file as its store writes it (only the fields this reads)."""
    path = root / folder / f"{asset_id}.json"
    path.parent.mkdir(parents=True, exist_ok=True)
    path.write_text(json.dumps({"id": asset_id, "name": name or asset_id,
                                "projectId": folder if project_id == "same" else project_id}))
    return path


def _raw_trashed(root: Path, asset_id: str, project_id: str | None, name: str | None = None) -> Path:
    trash = root / ".trash"
    trash.mkdir(parents=True, exist_ok=True)
    (trash / f"{asset_id}.json").write_text(json.dumps({"id": asset_id, "name": name or asset_id,
                                                        "projectId": project_id}))
    record = trash / f"{asset_id}.trash.json"
    record.write_text(json.dumps({"id": asset_id, "name": name or asset_id, "projectId": project_id,
                                  "scopeDir": project_id or "_global"}))
    return record


def _notes(boards: Path, board_id: str) -> Path:
    path = boards / ".notes" / f"{board_id}.json"
    path.parent.mkdir(parents=True, exist_ok=True)
    path.write_text(json.dumps({"boardId": board_id, "notes": []}))
    return path


def _two_projects(client):
    a = _create(client, "A")
    b = _create(client, "B", a["workspaceRevision"])
    return a["project"]["id"], b["project"]["id"], b["workspaceRevision"]


def _gone(client, kind, asset_id):
    """Deleted for good answers as never existed: 404, no in_trash."""
    response = client.get(f"/api/{'moodboards' if kind == 'moodboard' else 'characters'}/{asset_id}")
    return response.status_code == 404 and response.json().get("code") is None


def _stores(roots):
    from services.character_store import _char_lock
    from services.moodboard_store import BOARD_SIDE_FOLDERS, _board_lock

    return [purge.AssetStore("moodboard", roots["moodboard"], BOARD_SIDE_FOLDERS, _board_lock),
            purge.AssetStore("character", roots["character"], (), _char_lock),
            purge.AssetStore("style", roots["style"])]


# -- every purge path --------------------------------------------------------------


def test_delete_forever_takes_the_projects_assets_and_nothing_else(ws, person):
    client, store, roots, broadcast = ws
    doomed, other, revision = _two_projects(client)
    mine = _board(doomed, "Mine")
    trashed = _board(doomed, "Trashed")
    MoodboardStore().delete(trashed["id"])
    keep_project = _board(other, "Other project's")
    keep_global = _board(None, "Global")
    notes = _notes(roots["moodboard"], mine["id"])
    character = _raw(roots["character"], doomed, "chr1", name="Mara")
    character_binned = _raw_trashed(roots["character"], "chr2", doomed)
    character_kept = _raw(roots["character"], other, "chr3")
    style = _raw(roots["style"], doomed, "sty1")
    style_global = _raw(roots["style"], "_global", "sty2", project_id=None)
    _trash(client, doomed, revision)
    # In Recently deleted they are all still there (restoring brings them back).
    assert client.get(f"/api/moodboards/{mine['id']}").status_code == 200

    response = client.request("DELETE", f"/api/projects/trash/{doomed}", headers=person.headers)
    assert response.status_code == 200, response.text
    assert _gone(client, "moodboard", mine["id"]) and _gone(client, "moodboard", trashed["id"])
    assert _gone(client, "character", "chr1") and _gone(client, "character", "chr2")
    assert not notes.exists() and not character.exists() and not character_binned.exists() and not style.exists()
    for kind in ("moodboard", "character", "style"):
        assert not (roots[kind] / doomed).exists()
    assert all(item["id"] not in (trashed["id"], "chr2") for item in client.get("/api/trash").json()["items"])
    for kept in (keep_project, keep_global):
        assert client.get(f"/api/moodboards/{kept['id']}").status_code == 200
    assert character_kept.is_file() and style_global.is_file()
    assert PENDING not in store.read()
    # Each one's gone event goes out before projectsChanged.
    sent = [call.args[0] for call in broadcast.await_args_list]
    gone = {(m["kind"], m["id"]): i for i, m in enumerate(sent)
            if m.get("type") == "storedAssetChanged" and m.get("deleted")}
    changed = [i for i, m in enumerate(sent) if m.get("type") == "projectsChanged" and m.get("change") == "purged"]
    expected = {("moodboard", mine["id"]), ("moodboard", trashed["id"]), ("character", "chr1"),
                ("character", "chr2"), ("style", "sty1")}
    assert expected <= set(gone) and changed and max(gone[key] for key in expected) < changed[-1]


@pytest.mark.parametrize("route", ["projects", "trash"])
def test_empty_takes_the_assets_of_what_it_deleted_only(ws, person, route):
    client, store, roots, _ = ws
    a = _create(client, "A")
    b = _create(client, "B", a["workspaceRevision"])
    c = _create(client, "C", b["workspaceRevision"])
    ida, idb = a["project"]["id"], b["project"]["id"]
    in_a, in_b = _board(ida), _board(idb)
    char_a, char_b = _raw(roots["character"], ida, "ca"), _raw(roots["character"], idb, "cb")
    style_a, style_b = _raw(roots["style"], ida, "sa"), _raw(roots["style"], idb, "sb")
    _trash(client, ida, c["workspaceRevision"])
    _trash(client, idb, c["workspaceRevision"])
    # The person's list showed only A: B (trashed after it loaded) stays, with everything.
    if route == "projects":
        response = client.post("/api/projects/trash/empty", json={"ids": [ida]}, headers=person.headers)
    else:
        response = client.post("/api/trash/empty", json={"items": [{"kind": "project", "id": ida}]},
                               headers=person.headers)
    assert response.status_code == 200, response.text
    assert _gone(client, "moodboard", in_a["id"]) and not char_a.exists() and not style_a.exists()
    assert client.get(f"/api/moodboards/{in_b['id']}").status_code == 200
    assert char_b.is_file() and style_b.is_file()


def test_the_30_day_expiry_takes_the_assets(ws):
    client, store, roots, _ = ws
    old, keep, revision = _two_projects(client)
    board = _board(old)
    character, style = _raw(roots["character"], old, "c1"), _raw(roots["style"], old, "s1")
    _trash(client, old, revision)
    with store.transaction() as catalog:
        catalog["trash"][old]["deletedAt"] = (datetime.now(timezone.utc) - timedelta(days=31)).isoformat()
        store.commit(catalog)
    assert client.get(f"/api/moodboards/{board['id']}").status_code == 200
    assert client.get("/api/trash").status_code == 200  # any listing applies the expiry
    assert _gone(client, "moodboard", board["id"]) and not character.exists() and not style.exists()
    assert old not in store.read()["trash"]


def test_agents_still_cant_delete_for_good(ws):
    client, store, roots, _ = ws
    doomed, other, revision = _two_projects(client)
    board = _board(doomed)
    character = _raw(roots["character"], doomed, "c1")
    _trash(client, doomed, revision)
    for method, path in (("DELETE", f"/api/projects/trash/{doomed}"), ("POST", "/api/projects/trash/empty"),
                         ("DELETE", f"/api/trash/project/{doomed}"), ("POST", "/api/trash/empty")):
        assert client.request(method, path, headers={"X-Nebula-Agent": "Claude"}).status_code == 403
    assert client.get(f"/api/moodboards/{board['id']}").status_code == 200 and character.is_file()


def test_the_listing_says_what_goes_with_each_trashed_project(ws):
    client, store, roots, _ = ws
    doomed, other, revision = _two_projects(client)
    _board(doomed, "Tide")
    _board(doomed, "rivers")
    MoodboardStore().delete(_board(doomed, "Salt")["id"])  # trashed boards go too
    _raw(roots["character"], doomed, "c1", name="Mara")
    _raw(roots["character"], doomed, "c2", project_id=None, name="Not provably its")
    _board(other, "Elsewhere")
    deleted = _trash(client, doomed, revision)
    expected = {"moodboards": ["rivers", "Salt", "Tide"], "characters": ["Mara"], "styles": []}
    assert deleted["trashedProject"]["goesWith"] == expected
    listed = client.get("/api/projects").json()["trash"]
    assert [entry["goesWith"] for entry in listed] == [expected]
    item = next(item for item in client.get("/api/trash").json()["items"] if item["kind"] == "project")
    assert item["goesWith"] == expected


# -- what still names a deleted character ---------------------------------------------


def test_a_node_elsewhere_naming_a_purged_character_fails_clearly(ws, person):
    """A Character node in another project may point at a character filed in
    the purged one. It goes anyway (deleted for good means gone); the node's
    run says it can't be found, as for any character deleted for good."""
    from handlers.character_node import handle_character_node
    from models.graph import GraphNode

    client, store, roots, _ = ws
    doomed, other, revision = _two_projects(client)
    _raw(roots["character"], doomed, "chr1", name="Mara")
    _trash(client, doomed, revision)
    assert client.request("DELETE", f"/api/projects/trash/{doomed}", headers=person.headers).status_code == 200
    node = GraphNode(id="n1", definitionId="character", params={"character": "chr1"})
    with pytest.raises(ValueError) as refused:
        asyncio.run(handle_character_node(node, {}, {}))
    assert "not found; it may have been deleted for good" in str(refused.value)
    assert "in Recently deleted" not in str(refused.value)


# -- crash safety ----------------------------------------------------------------


def test_a_failed_commit_changes_nothing(ws, person, monkeypatch):
    client, store, roots, _ = ws
    doomed, other, revision = _two_projects(client)
    board = _board(doomed)
    character = _raw(roots["character"], doomed, "c1")
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
    # The project is still in Recently deleted, with everything filed under it.
    assert doomed in store.read()["trash"]
    assert (roots["moodboard"] / doomed / f"{board['id']}.json").is_file() and character.is_file()


def test_a_purge_stopped_part_way_finishes_on_the_next_start(ws, person, monkeypatch, tmp_path):
    client, store, roots, _ = ws
    doomed, other, revision = _two_projects(client)
    first, second = _board(doomed, "First"), _board(doomed, "Second")
    character = _raw(roots["character"], doomed, "c1")
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
    # The project went (its commit is the purge); one board and the character
    # are left, and the catalog says they are still to go.
    assert response.status_code == 200, response.text
    catalog = store.read()
    assert doomed not in catalog["trash"] and doomed not in catalog["projects"]
    assert catalog[PENDING] == [doomed]
    left = [b for b in (first, second) if (roots["moodboard"] / doomed / f"{b['id']}.json").exists()]
    assert len(left) == 1 and character.is_file()
    # A restart (the start-up step) finishes it.
    monkeypatch.delenv("NEBULA_NO_ASSET_REHOME", raising=False)
    monkeypatch.setattr(main_module, "_STATE_DIR", tmp_path / "state")
    asyncio.run(main_module._project_asset_purge_startup())
    assert not (roots["moodboard"] / doomed).exists() and not character.exists()
    assert PENDING not in store.read()
    assert _gone(client, "moodboard", left[0]["id"])


def _failing(*_args, **_kwargs):
    raise OSError("busy")


def test_a_purge_stopped_part_way_finishes_on_the_next_purge(ws, person, monkeypatch):
    client, store, roots, _ = ws
    a = _create(client, "A")
    b = _create(client, "B", a["workspaceRevision"])
    c = _create(client, "C", b["workspaceRevision"])
    ida, idb = a["project"]["id"], b["project"]["id"]
    in_a, in_b = _board(ida), _board(idb)
    style_a = _raw(roots["style"], ida, "sa")
    _trash(client, ida, c["workspaceRevision"])
    _trash(client, idb, c["workspaceRevision"])
    real_delete = purge.delete_store_assets
    monkeypatch.setattr(purge, "delete_store_assets", _failing)
    assert client.request("DELETE", f"/api/projects/trash/{ida}", headers=person.headers).status_code == 200
    monkeypatch.setattr(purge, "delete_store_assets", real_delete)
    assert store.read()[PENDING] == [ida] and style_a.is_file()
    assert client.request("DELETE", f"/api/projects/trash/{idb}", headers=person.headers).status_code == 200
    assert _gone(client, "moodboard", in_a["id"]) and _gone(client, "moodboard", in_b["id"]) and not style_a.exists()
    assert PENDING not in store.read()


def test_the_rehome_never_moves_a_pending_purge_to_global(ws, person, monkeypatch, tmp_path):
    from services.asset_project_rehome import AssetRoot, rehome_legacy_assets

    client, store, roots, _ = ws
    doomed, other, revision = _two_projects(client)
    board = _board(doomed)
    character = _raw(roots["character"], doomed, "c1")
    _trash(client, doomed, revision)
    real_delete = purge.delete_store_assets
    monkeypatch.setattr(purge, "delete_store_assets", _failing)
    client.request("DELETE", f"/api/projects/trash/{doomed}", headers=person.headers)
    monkeypatch.setattr(purge, "delete_store_assets", real_delete)
    report = rehome_legacy_assets(store.read, tmp_path / "state", roots=[
        AssetRoot("moodboard", roots["moodboard"], True), AssetRoot("character", roots["character"], True)])
    assert report["status"] == "nothing to do"
    assert (roots["moodboard"] / doomed / f"{board['id']}.json").is_file() and character.is_file()
    assert not (roots["moodboard"] / "_global" / f"{board['id']}.json").exists()


# -- guards (unit) -----------------------------------------------------------------


@pytest.mark.parametrize("kind", ["moodboard", "character", "style"])
def test_never_deletes_what_a_project_the_catalog_still_has_holds(tmp_path, kind):
    roots = {k: tmp_path / k for k in ("moodboard", "character", "style")}
    store = next(s for s in _stores(roots) if s.kind == kind)
    pid = "a" * 32
    asset = _raw(roots[kind], pid, "x1")
    with pytest.raises(ValueError):
        purge.delete_store_assets(store, pid, keep={pid})
    assert asset.is_file()
    # finish() drops a listed id the catalog has again, without deleting.
    catalog = {"projects": {pid: {}}, "trash": {}, PENDING: [pid]}
    done, removed = purge.finish(catalog, _stores(roots))
    assert done == [pid] and not any(removed.values()) and asset.is_file()


def test_side_files_stay_while_another_copy_of_the_board_lives(tmp_path):
    roots = {k: tmp_path / k for k in ("moodboard", "character", "style")}
    boards = roots["moodboard"]
    pid = "b" * 32
    _raw(boards, pid, "shared")
    _raw(boards, "_global", "shared", project_id=None)  # a re-home collision left a copy
    _raw(boards, pid, "alone")
    shared_notes, alone_notes = _notes(boards, "shared"), _notes(boards, "alone")
    removed = purge.delete_store_assets(_stores(roots)[0], pid, keep=set())
    assert sorted(item["id"] for item in removed) == ["alone", "shared"]
    assert shared_notes.exists() and not alone_notes.exists()
    assert (boards / "_global" / "shared.json").is_file()


@pytest.mark.parametrize("kind", ["moodboard", "character", "style"])
def test_an_asset_that_names_another_project_is_left(tmp_path, kind):
    roots = {k: tmp_path / k for k in ("moodboard", "character", "style")}
    store = next(s for s in _stores(roots) if s.kind == kind)
    pid = "c" * 32
    stray = _raw(roots[kind], pid, "stray", project_id=None)
    (roots[kind] / pid / "broken.json").write_text("{not json")
    mine = _raw(roots[kind], pid, "mine")
    assert [item["id"] for item in purge.delete_store_assets(store, pid, keep=set())] == ["mine"]
    assert stray.is_file() and (roots[kind] / pid / "broken.json").is_file() and not mine.exists()


@pytest.mark.parametrize("kind", ["moodboard", "character", "style"])
def test_only_the_projects_own_trashed_assets_go(tmp_path, kind):
    roots = {k: tmp_path / k for k in ("moodboard", "character", "style")}
    store = next(s for s in _stores(roots) if s.kind == kind)
    pid, other = "d" * 32, "e" * 32
    for asset_id, project_id in (("mine", pid), ("theirs", other), ("global", None)):
        _raw_trashed(roots[kind], asset_id, project_id)
    assert [item["id"] for item in purge.delete_store_assets(store, pid, keep={other})] == ["mine"]
    trash = roots[kind] / ".trash"
    assert not (trash / "mine.json").exists() and not (trash / "mine.trash.json").exists()
    for kept in ("theirs", "global"):
        assert (trash / f"{kept}.json").is_file() and (trash / f"{kept}.trash.json").is_file()


def test_names_lists_only_what_would_go(tmp_path):
    roots = {k: tmp_path / k for k in ("moodboard", "character", "style")}
    pid = "f" * 32
    _raw(roots["moodboard"], pid, "b1", name="Tide")
    _raw_trashed(roots["moodboard"], "b2", pid, name="Rivers")
    _raw(roots["moodboard"], pid, "b3", project_id=None, name="Stray")
    _raw(roots["style"], pid, "s1", name="Dusk")
    _raw_trashed(roots["character"], "c9", "0" * 32, name="Elsewhere")
    assert purge.names(pid, _stores(roots)) == {"moodboards": ["Rivers", "Tide"], "characters": [], "styles": ["Dusk"]}
    assert purge.names("not-an-id", _stores(roots)) == {"moodboards": [], "characters": [], "styles": []}


# -- the one-time sweep ------------------------------------------------------------


def _sweep_setup(tmp_path):
    state = tmp_path / ".nebula"
    roots = {"moodboard": state / "moodboards", "character": state / "characters", "style": state / "presets"}
    live, trashed, purged = "1" * 32, "2" * 32, "3" * 32
    catalog = {"projects": {live: {}}, "trash": {trashed: {}}}
    paths = {}
    for kind, root in roots.items():
        paths[(kind, "live")] = _raw(root, live, f"{kind}-live")
        paths[(kind, "trashed")] = _raw(root, trashed, f"{kind}-intrash")
        paths[(kind, "purged")] = _raw(root, purged, f"{kind}-orphan")
        paths[(kind, "global")] = _raw(root, "_global", f"{kind}-g", project_id=None)
        paths[(kind, "old_style")] = _raw(root, "nebula_nodes", f"{kind}-legacy")
        # One deleted from the purged project, waiting in that store's trash.
        paths[(kind, "binned")] = _raw_trashed(root, f"{kind}-binned", purged)
    return state, roots, catalog, paths


def test_the_sweep_removes_only_provable_orphans_once(tmp_path, caplog):
    state, roots, catalog, paths = _sweep_setup(tmp_path)
    stores = _stores(roots)
    with caplog.at_level("INFO", logger="services.project_asset_purge"):
        report = purge.sweep_orphans(catalog, state_dir=state, stores=stores)
    assert report == {"status": "done", "removed": {"moodboard": 2, "character": 2, "style": 2}}
    for kind in roots:
        assert not paths[(kind, "purged")].exists() and not paths[(kind, "binned")].exists()
        for kept in ("live", "trashed", "global", "old_style"):
            assert paths[(kind, kept)].is_file(), (kind, kept)
    # Counts, never a name.
    assert "2 moodboards, 2 characters, 2 styles removed" in caplog.text
    assert "orphan" not in caplog.text and "binned" not in caplog.text
    # Once: one orphaned later (an older Nebula's purge) is left to the re-home.
    again = _raw(roots["character"], "4" * 32, "later")
    assert purge.sweep_orphans(catalog, state_dir=state, stores=stores)["status"] == "done before"
    assert again.is_file()


@pytest.mark.parametrize("case", ["no catalog", "empty catalog", "unpaired roots", "pending"])
def test_the_sweep_does_nothing_without_proof(tmp_path, case):
    state, roots, catalog, paths = _sweep_setup(tmp_path)
    if case == "no catalog":
        catalog = None
    elif case == "empty catalog":
        catalog = {"projects": {}, "trash": {}}
    elif case == "unpaired roots":
        state = tmp_path / "elsewhere"  # a backend pointed at another catalog
    else:
        catalog[PENDING] = ["3" * 32]  # finish() owns it, not the sweep
    report = purge.sweep_orphans(catalog, state_dir=state, stores=_stores(roots))
    for kind in roots:
        assert paths[(kind, "purged")].is_file()
    if case == "pending":
        assert report["status"] == "done" and not any(report["removed"].values())
    else:
        assert report["status"].startswith("skipped") and not (state / "migrations").exists()


def test_the_sweep_skips_a_store_that_isnt_this_catalogs(tmp_path):
    state, roots, catalog, paths = _sweep_setup(tmp_path)
    stores = _stores(roots)
    elsewhere = tmp_path / "other" / "characters"
    elsewhere.mkdir(parents=True)
    foreign = _raw(elsewhere, "3" * 32, "theirs")
    stores[1] = purge.AssetStore("character", elsewhere)
    report = purge.sweep_orphans(catalog, state_dir=state, stores=stores)
    assert report["removed"] == {"moodboard": 2, "character": 0, "style": 2}
    assert foreign.is_file()


def test_the_desktop_layout_counts_as_paired(tmp_path):
    data = tmp_path / "Nebula"
    assert purge.roots_paired(data / "state", data / "characters")
    assert purge.roots_paired(tmp_path / ".nebula", tmp_path / ".nebula" / "presets")
    assert not purge.roots_paired(tmp_path / "x", tmp_path / ".nebula" / "moodboards")
    assert not purge.roots_paired(data / "other", data / "moodboards")


def test_an_asset_moved_away_before_its_lock_is_left(tmp_path):
    """Read again under the asset's lock: a move to Global that landed after
    the folder was listed (it rewrites projectId first) keeps the asset."""
    from contextlib import contextmanager

    roots = {k: tmp_path / k for k in ("moodboard", "character", "style")}
    pid = "9" * 32
    path = _raw(roots["character"], pid, "moving")

    @contextmanager
    def moved_meanwhile(_asset_id):
        path.write_text(json.dumps({"id": "moving", "name": "moving", "projectId": None}))
        yield

    store = purge.AssetStore("character", roots["character"], (), moved_meanwhile)
    assert purge.delete_store_assets(store, pid, keep=set()) == []
    assert path.is_file()
