"""A project deleted for good takes its moodboards, characters and styles with
it (services/project_asset_purge.py): Delete forever, both Empties and the
30-day expiry; crash safety; only stores beside the catalog; an id the
catalog merely doesn't know is never deleted (the re-home moves it to Global);
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
    done, removed = purge.finish(catalog, state_dir=tmp_path, stores=_stores(roots))
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
    assert purge.names(pid, state_dir=tmp_path, stores=_stores(roots)) == {"moodboards": ["Rivers", "Tide"], "characters": [], "styles": ["Dusk"]}
    assert purge.names("not-an-id", state_dir=tmp_path, stores=_stores(roots)) == {"moodboards": [], "characters": [], "styles": []}


# -- which stores are the catalog's ------------------------------------------------


def test_the_desktop_layout_counts_as_paired(tmp_path):
    data = tmp_path / "Nebula"
    assert purge.roots_paired(data / "state", data / "characters")
    assert purge.roots_paired(tmp_path / ".nebula", tmp_path / ".nebula" / "presets")
    assert not purge.roots_paired(tmp_path / "x", tmp_path / ".nebula" / "moodboards")
    assert not purge.roots_paired(data / "other", data / "moodboards")


def test_an_asset_changed_before_its_lock_is_left(tmp_path):
    """Read again under the asset's lock: a write that landed after the
    folder was listed and no longer names the project keeps the asset. (A
    move to Global holds the same lock and writes ``_global/<id>.json``
    before it unlinks the old file, so the purge either finds the file still
    the project's or doesn't find it: moodboard_store.move, character_store.move.)"""
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


# -- an id the catalog doesn't know is the re-home's, never deleted -----------------


def test_a_desktop_migration_with_a_new_catalog_moves_to_global_and_deletes_nothing(tmp_path, monkeypatch):
    """The desktop migration copies the stores but not ``projects/``. First
    start: no catalog; the open canvas becomes "Recovered canvas". Second
    start: every asset filed under a project of the old catalog goes to
    Global with a backup, as on main. Nothing is deleted."""
    from types import SimpleNamespace

    from services import project_store as project_store_module

    data = tmp_path / "Nebula"
    roots = {"moodboard": data / "moodboards", "character": data / "characters", "style": data / "presets"}
    for kind, env in (("moodboard", "NEBULA_MOODBOARD_ROOT"), ("character", "NEBULA_CHARACTER_ROOT"),
                      ("style", "NEBULA_PRESET_ROOT")):
        monkeypatch.setenv(env, str(roots[kind]))
    monkeypatch.delenv("NEBULA_NO_ASSET_REHOME", raising=False)
    store = ProjectStore(data / "state" / "projects")
    monkeypatch.setattr(main_module, "project_store", store)
    monkeypatch.setattr(main_module, "_STATE_DIR", data / "state")
    old = "7" * 32
    copied = {kind: _raw(root, old, f"{kind}-mine", name=f"Mine {kind}") for kind, root in roots.items()}
    notes = _notes(roots["moodboard"], "moodboard-mine")
    # First start: no catalog yet, and the open canvas isn't a project yet.
    monkeypatch.setattr(main_module, "cli_graph", SimpleNamespace(nodes={"n1": {"id": "n1"}}))
    asyncio.run(main_module._project_asset_purge_startup())
    asyncio.run(main_module._asset_project_rehome_startup())
    assert all(path.is_file() for path in copied.values())
    # The first listing files the canvas as "Recovered canvas".
    with store.transaction() as catalog:
        recovered = project_store_module.make_project("Recovered canvas")
        catalog["projects"][recovered["id"]] = recovered
        catalog["activeProjectId"] = recovered["id"]
        store.commit(catalog)
    # Second start.
    monkeypatch.setattr(main_module, "cli_graph", SimpleNamespace(nodes={}))
    asyncio.run(main_module._project_asset_purge_startup())
    asyncio.run(main_module._asset_project_rehome_startup())
    for kind, root in roots.items():
        assert (root / "_global" / f"{kind}-mine.json").is_file(), kind
        assert not copied[kind].exists()
        backup_kind = "preset" if kind == "style" else kind  # the re-home's kind names
        assert list((data / f"{backup_kind}-backups").rglob(f"{kind}-mine.json")), kind
    assert notes.is_file()
    assert PENDING not in store.read()


def test_the_startup_never_deletes_what_an_unknown_project_holds(ws, monkeypatch):
    """Absent from the catalog is no proof: only ids on the catalog's own
    list are purged (the startup replay finishes those and nothing else)."""
    client, store, roots, _ = ws
    keep, other, _revision = _two_projects(client)
    unknown = "8" * 32
    left = {kind: _raw(root, unknown, f"{kind}-x") for kind, root in roots.items()}
    binned = _raw_trashed(roots["character"], "c-binned", unknown)
    monkeypatch.delenv("NEBULA_NO_ASSET_REHOME", raising=False)
    asyncio.run(main_module._project_asset_purge_startup())
    assert all(path.is_file() for path in left.values()) and binned.is_file()


# -- only the stores beside the catalog ------------------------------------------------


def _trashed_entry(pid: str, deleted_at: str) -> dict:
    from services.project_store import make_project

    return {**make_project(pid[:2]), "id": pid, "deletedAt": deleted_at}


def _half_isolated(tmp_path, monkeypatch):
    """A backend on a copy of the person's catalog (its own state folder)
    whose store roots are still the person's defaults (HOME left real)."""
    real = tmp_path / "realhome"
    monkeypatch.setenv("HOME", str(real))
    for env in ("NEBULA_MOODBOARD_ROOT", "NEBULA_CHARACTER_ROOT", "NEBULA_PRESET_ROOT"):
        monkeypatch.delenv(env, raising=False)
    roots = {"moodboard": real / ".nebula" / "moodboards", "character": real / ".nebula" / "characters",
             "style": real / ".nebula" / "presets"}
    assert [s.root for s in purge.default_stores()] == list(roots.values())
    store = ProjectStore(tmp_path / "copy" / "state" / "projects")
    monkeypatch.setattr(main_module, "project_store", store)
    monkeypatch.setattr(purge, "_UNPAIRED_LOGGED", set())
    return store, roots


def test_a_copied_catalog_with_default_roots_never_deletes_the_real_stores(ws, monkeypatch, tmp_path, caplog):
    client, _store, _roots, _ = ws
    store, roots = _half_isolated(tmp_path, monkeypatch)
    expired, shown = "a1" * 16, "b2" * 16
    real = {}
    for kind, root in roots.items():
        for pid in (expired, shown):
            real[(kind, pid)] = _raw(root, pid, f"{kind}-{pid[:2]}")
        real[(kind, "binned")] = _raw_trashed(root, f"{kind}-binned", expired)
    long_ago = (datetime.now(timezone.utc) - timedelta(days=40)).isoformat()
    recent = datetime.now(timezone.utc).isoformat()
    with store.transaction() as catalog:
        for pid, when in ((expired, long_ago), (shown, recent)):
            catalog.setdefault("trash", {})[pid] = _trashed_entry(pid, when)
        store.commit(catalog)
    with caplog.at_level("WARNING", logger="services.project_asset_purge"):
        listed = client.get("/api/projects")
        assert listed.status_code == 200, listed.text
        assert client.get("/api/trash").status_code == 200
    # The expiry ran, and the real stores are untouched.
    assert all(path.is_file() for path in real.values())
    catalog = store.read()
    assert expired not in catalog["trash"] and catalog[PENDING] == [expired]
    # Nothing promised: the line can only name what would go.
    entry = next(entry for entry in listed.json()["trash"] if entry["id"] == shown)
    assert entry["goesWith"] == {"moodboards": [], "characters": [], "styles": []}
    # Logged once per start, a count and no names.
    lines = [r.getMessage() for r in caplog.records if "isn't beside" in r.getMessage()]
    assert len(lines) == 1 and lines[0].startswith("1 project(s)") and "a1" not in lines[0]
    # The re-home still sees the listed id: it never moves those to Global.
    from services.asset_project_rehome import AssetRoot, rehome_legacy_assets
    report = rehome_legacy_assets(store.read, tmp_path / "copy" / "state",
                                  roots=[AssetRoot("moodboard", roots["moodboard"], True)])
    assert report["status"] == "nothing to do"
    assert real[("moodboard", expired)].is_file()


def test_delete_forever_in_a_copied_catalog_leaves_the_real_stores(ws, person, monkeypatch, tmp_path):
    client, _store, _roots, _ = ws
    store, roots = _half_isolated(tmp_path, monkeypatch)
    pid = "c3" * 16
    when = datetime.now(timezone.utc).isoformat()
    with store.transaction() as catalog:
        catalog.setdefault("trash", {})[pid] = _trashed_entry(pid, when)
        store.commit(catalog)
    board = _raw(roots["moodboard"], pid, "b1")
    assert client.request("DELETE", f"/api/projects/trash/{pid}", headers=person.headers).status_code == 200
    assert board.is_file() and store.read()[PENDING] == [pid]


def test_a_store_not_beside_the_catalog_keeps_the_id_listed(tmp_path):
    state = tmp_path / ".nebula"
    pid = "d4" * 16
    roots = {k: state / k for k in ("moodboard", "character", "style")}
    stores = _stores(roots)
    elsewhere = tmp_path / "other" / "characters"
    stores[1] = purge.AssetStore("character", elsewhere)
    mine = _raw(roots["moodboard"], pid, "b1")
    theirs = _raw(elsewhere, pid, "c1")
    done, removed = purge.finish({"projects": {}, "trash": {}, PENDING: [pid]}, state_dir=state, stores=stores)
    assert done == [] and [item["id"] for item in removed["moodboard"]] == ["b1"]
    assert not mine.exists() and theirs.is_file()
    # With every store beside it, the same id is done.
    stores[1] = purge.AssetStore("character", roots["character"])
    assert purge.finish({"projects": {}, "trash": {}, PENDING: [pid]}, state_dir=state, stores=stores)[0] == [pid]


# -- the trash pass, under the lock -------------------------------------------------


def test_a_trash_record_replaced_before_its_lock_is_left(tmp_path):
    """Restored, then deleted again from Global, between the listing and the
    lock: the record no longer names the project, so the Global copy stays."""
    from contextlib import contextmanager

    root = tmp_path / "character"
    pid = "e5" * 16
    record = _raw_trashed(root, "c1", pid)

    @contextmanager
    def replaced_meanwhile(_asset_id):
        record.write_text(json.dumps({"id": "c1", "name": "c1", "projectId": None, "scopeDir": "_global"}))
        yield

    store = purge.AssetStore("character", root, (), replaced_meanwhile)
    assert purge.delete_store_assets(store, pid, keep=set()) == []
    assert record.is_file() and (root / ".trash" / "c1.json").is_file()


def test_a_board_trashed_or_restored_between_passes_still_goes(tmp_path):
    """Deleted for good means gone: a board moved to Recently deleted while
    the live pass runs, and one restored while the trash pass runs, both go."""
    from contextlib import contextmanager

    from services import asset_trash

    root = tmp_path / "moodboard"
    pid = "f6" * 16
    first = _raw(root, pid, "a-first")
    second = _raw(root, pid, "b-second")
    _raw_trashed(root, "c-binned", pid)
    (root / pid / "c-binned.json").unlink(missing_ok=True)
    done_once: set[str] = set()

    @contextmanager
    def busy_store(asset_id):
        if asset_id == "a-first" and "trash" not in done_once:
            done_once.add("trash")
            asset_trash.move_to_trash(root, second, kind="moodboard", deleted_by=None)
        if asset_id == "c-binned" and "restore" not in done_once:
            done_once.add("restore")
            asset_trash.restore(root, "c-binned")
        yield

    store = purge.AssetStore("moodboard", root, (), busy_store)
    removed = purge.delete_store_assets(store, pid, keep=set())
    assert sorted(item["id"] for item in removed) == ["a-first", "b-second", "c-binned"]
    assert not first.exists() and not (root / pid).exists()
    assert not any((root / ".trash").iterdir())


# -- guards pinned one by one ------------------------------------------------------


@pytest.mark.parametrize("record_project, scope_dir", [("same", "_global"), ("other", "same")])
def test_a_trash_record_must_name_the_project_twice(tmp_path, record_project, scope_dir):
    root = tmp_path / "style"
    pid, other = "1a" * 16, "2b" * 16
    trash = root / ".trash"
    trash.mkdir(parents=True)
    (trash / "s1.json").write_text(json.dumps({"id": "s1", "projectId": pid}))
    record = trash / "s1.trash.json"
    record.write_text(json.dumps({"id": "s1", "name": "s1",
                                  "projectId": pid if record_project == "same" else other,
                                  "scopeDir": pid if scope_dir == "same" else scope_dir}))
    assert purge.delete_store_assets(purge.AssetStore("style", root), pid, keep=set()) == []
    assert record.is_file() and (trash / "s1.json").is_file()
    assert purge.names(pid, state_dir=tmp_path, stores=[purge.AssetStore("style", root)])["styles"] == []


def test_a_trash_record_without_its_file_is_left(tmp_path):
    root = tmp_path / "character"
    pid = "3c" * 16
    record = _raw_trashed(root, "c1", pid, name="Gone already")
    (root / ".trash" / "c1.json").unlink()
    store = purge.AssetStore("character", root)
    assert purge.names(pid, state_dir=tmp_path, stores=[store])["characters"] == []
    assert purge.delete_store_assets(store, pid, keep=set()) == []
    assert record.is_file()


def test_a_trashed_file_gone_before_its_lock_leaves_the_record(tmp_path):
    """Restored (the file moved back, the record not yet dropped) between
    the listing and the lock: the record isn't deleted from under it."""
    from contextlib import contextmanager

    root = tmp_path / "character"
    pid = "3d" * 16
    record = _raw_trashed(root, "c1", pid)

    @contextmanager
    def restored_meanwhile(_asset_id):
        (root / ".trash" / "c1.json").unlink()
        yield

    assert purge.delete_store_assets(purge.AssetStore("character", root, (), restored_meanwhile), pid, keep=set()) == []
    assert record.is_file()


@pytest.mark.parametrize("bad", ["../escape", "nebula_nodes", "A" * 32, "a" * 31])
def test_only_a_catalog_shaped_id_is_ever_purged(tmp_path, bad):
    root = tmp_path / "moodboard"
    _raw(root, "x", "b1", project_id=bad)
    with pytest.raises(ValueError):
        purge.delete_store_assets(purge.AssetStore("moodboard", root), bad, keep=set())


def test_a_symlinked_project_folder_is_never_followed(tmp_path):
    root = tmp_path / "moodboard"
    pid = "4d" * 16
    elsewhere = tmp_path / "elsewhere"
    target = _raw(elsewhere, "x", "b1", project_id=pid)
    root.mkdir()
    (root / pid).symlink_to(target.parent, target_is_directory=True)
    assert purge.delete_store_assets(purge.AssetStore("moodboard", root), pid, keep=set()) == []
    assert target.is_file()


def test_board_updates_stay_while_a_trashed_copy_of_the_id_is_waiting(tmp_path):
    from services.moodboard_store import BOARD_SIDE_FOLDERS

    root = tmp_path / "moodboard"
    pid = "5e" * 16
    _raw(root, pid, "shared")
    _raw_trashed(root, "shared", None)  # Global's copy, in Recently deleted
    notes = _notes(root, "shared")
    removed = purge.delete_store_assets(purge.AssetStore("moodboard", root, BOARD_SIDE_FOLDERS), pid, keep=set())
    assert [item["id"] for item in removed] == ["shared"]
    assert notes.is_file() and (root / ".trash" / "shared.json").is_file()


def test_only_catalog_shaped_ids_are_noted():
    catalog: dict = {}
    purge.note_purged(catalog, ["../escape", "nebula_nodes", "A" * 32, 12])
    assert PENDING not in catalog
    purge.note_purged(catalog, ["6f" * 16])
    assert catalog[PENDING] == ["6f" * 16]


def test_restoring_a_project_applies_the_expiry_to_the_others(ws, person):
    client, store, roots, _ = ws
    a = _create(client, "A")
    b = _create(client, "B", a["workspaceRevision"])
    c = _create(client, "C", b["workspaceRevision"])
    ida, idb = a["project"]["id"], b["project"]["id"]
    style_a = _raw(roots["style"], ida, "sa")
    _trash(client, ida, c["workspaceRevision"])
    _trash(client, idb, c["workspaceRevision"])
    with store.transaction() as catalog:
        catalog["trash"][ida]["deletedAt"] = (datetime.now(timezone.utc) - timedelta(days=31)).isoformat()
        store.commit(catalog)
    response = client.post(f"/api/projects/{idb}/restore")
    assert response.status_code == 200, response.text
    assert not style_a.exists() and PENDING not in store.read()


# -- `nebula trash list` -------------------------------------------------------------


def test_the_cli_names_only_the_kinds_a_project_has():
    import io

    from cli.commands import trash as trash_cli

    def line(goes):
        item = {"kind": "project", "id": "p1", "name": "P", "deletedAt": "2026-11-01T00:00:00+00:00",
                "deletedBy": {"kind": "person", "name": "You"}, "purgeAt": "2026-12-01T00:00:00+00:00"}
        if goes is not None:
            item["goesWith"] = goes
        client = type("C", (), {"shared": lambda self, *_a, **_k: {"items": [item]}})()
        out = io.StringIO()
        trash_cli.run_list(client, out=out)
        return out.getvalue().splitlines()[1]

    none = {"moodboards": [], "characters": [], "styles": []}
    assert "removed for good after 2026-12-01" in line(none)
    assert " with its" not in line(none) and " with its" not in line(None)
    assert "removed for good with its characters after 2026-12-01" in line({**none, "characters": ["Mara"]})
    assert "with its moodboards and styles after" in line({**none, "moodboards": ["a"], "styles": ["s"]})
    assert "with its moodboards, characters and styles after" in line(
        {"moodboards": ["a"], "characters": ["c"], "styles": ["s"]})


# -- each store holds the asset's lock while it moves, trashes, restores or purges -----


def _held_elsewhere(lock, asset_id):
    """Hold ``lock(asset_id)`` on another thread until the returned event is set."""
    import threading

    taken, release = threading.Event(), threading.Event()

    def hold():
        with lock(asset_id):
            taken.set()
            release.wait(5)

    thread = threading.Thread(target=hold, daemon=True)
    thread.start()
    assert taken.wait(5)
    return release, thread


def _blocks_until_released(lock, asset_id, action):
    import threading

    release, holder = _held_elsewhere(lock, asset_id)
    done = threading.Event()
    errors: list[BaseException] = []

    def run():
        try:
            action()
        except BaseException as exc:  # noqa: BLE001 - reported below
            errors.append(exc)
        finally:
            done.set()

    worker = threading.Thread(target=run, daemon=True)
    worker.start()
    waited = done.wait(0.3)
    release.set()
    holder.join(5)
    assert done.wait(5) and not errors, errors
    return not waited


@pytest.mark.parametrize("kind", ["moodboard", "character", "style"])
@pytest.mark.parametrize("step", ["delete", "restore", "purge", "move", "update"])
def test_the_stores_hold_the_assets_lock(ws, kind, step):
    from services import character_store, moodboard_store, preset_store

    if kind == "style" and step == "move":
        pytest.skip("styles don't move")
    if kind == "moodboard" and step == "update":
        pytest.skip("board updates held the lock before")
    client, store, roots, _ = ws
    pid, _other, _revision = _two_projects(client)
    if kind == "moodboard":
        asset_id = _board(pid)["id"]
        api, lock = MoodboardStore(), moodboard_store._board_lock
    elif kind == "character":
        asset_id = character_store.CharacterStore().create(
            name="Mara", subjectType="person", referenceViews=["/api/outputs/a.png", "/api/outputs/b.png", "/api/outputs/c.png"], frozenTraitString="", seed=1,
            consistencyStrength=0.5, projectId=pid)["id"]
        api, lock = character_store.CharacterStore(), character_store._char_lock
    else:
        asset_id = preset_store.PresetStore().create(
            name="Dusk", category="Style", prompt="", params={}, modelId=None, refImages=[], scope="project",
            projectId=pid, params_version=preset_store.PARAMS_VERSION)["id"]
        api, lock = preset_store.PresetStore(), preset_store._preset_lock
    if step in ("restore", "purge"):
        api.delete(asset_id)
    action = {
        "delete": lambda: api.delete(asset_id),
        "restore": lambda: api.restore(asset_id),
        "purge": lambda: api.purge(asset_id),
        "move": lambda: api.move(asset_id, None),
        "update": lambda: api.update(asset_id, name="Renamed"),
    }[step]
    assert _blocks_until_released(lock, asset_id, action)


def test_the_purge_takes_each_stores_own_lock():
    from services import character_store, moodboard_store, preset_store

    assert [store.lock for store in purge.default_stores()] == [
        moodboard_store._board_lock, character_store._char_lock, preset_store._preset_lock]
