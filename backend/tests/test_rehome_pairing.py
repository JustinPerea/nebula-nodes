"""The start-up re-home runs only on a store that is this catalog's (the purge's
pairing rule, ``roots_paired``), and the purge's follow-up rules: a linked part
of a store keeps the id listed, an empty folder isn't proof of a store, a stray
catalog is logged, a store on another device is unpaired, ``goesWithProject``
doesn't over-promise.

Every path here is under pytest's tmp_path (HOME and the NEBULA_* roots are
set to it); nothing touches the person's own ~/.nebula."""
from __future__ import annotations

import json
from pathlib import Path

import pytest

from services import asset_project_rehome as rehome
from services import project_asset_purge as purge
from services.asset_project_rehome import AssetRoot, default_roots, rehome_legacy_assets
from services.project_store import ProjectStore, make_project
from tests.test_project_asset_purge import ws  # noqa: F401  (the API fixture)

PENDING = purge.PENDING_KEY
LIVE = "a1" * 16          # a project the real catalog has
GONE = "b2" * 16          # a project the copy's catalog lacks
OLD = "nebula_nodes"      # an old-style folder name


@pytest.fixture(autouse=True)
def _fresh_start(monkeypatch):
    for module, name in ((purge, "_WAITING_LOGGED"), (purge, "_OTHER_CATALOG_LOGGED"),
                         (purge, "_UNRESOLVED_LOGGED"), (rehome, "_UNPAIRED_LOGGED")):
        monkeypatch.setattr(module, name, set())


@pytest.fixture
def home(tmp_path, monkeypatch):
    """A temp HOME with no NEBULA_*_ROOT: the real-layout defaults land here."""
    monkeypatch.setenv("HOME", str(tmp_path))
    for env in purge.ROOT_ENV.values():
        monkeypatch.delenv(env, raising=False)
    return tmp_path


def _asset(root: Path, folder: str, asset_id: str, project_id: str | None = "same") -> Path:
    path = root / folder / f"{asset_id}.json"
    path.parent.mkdir(parents=True, exist_ok=True)
    path.write_text(json.dumps({"id": asset_id, "name": asset_id,
                                "projectId": folder if project_id == "same" else project_id}))
    return path


def _trashed(root: Path, asset_id: str, project_id: str) -> tuple[Path, Path]:
    trash = root / ".trash"
    trash.mkdir(parents=True, exist_ok=True)
    asset = trash / f"{asset_id}.json"
    asset.write_text(json.dumps({"id": asset_id, "name": asset_id, "projectId": project_id}))
    record = trash / f"{asset_id}.trash.json"
    record.write_text(json.dumps({"id": asset_id, "name": asset_id, "projectId": project_id,
                                  "scopeDir": project_id}))
    return asset, record


def _catalog(state: Path, *project_ids: str, purging: tuple[str, ...] = ()) -> ProjectStore:
    store = ProjectStore(state / "projects")
    with store.transaction() as catalog:
        for pid in project_ids:
            catalog["projects"][pid] = {**make_project(pid[:4]), "id": pid}
        if purging:
            catalog[PENDING] = list(purging)
        store.commit(catalog)
    return store


def _rehome(store: ProjectStore, state: Path, roots=None):
    return rehome_legacy_assets(lambda: store.read() if store.path.exists() else None, state,
                                roots=roots if roots is not None else default_roots())


def _snapshot(root: Path) -> dict[str, str]:
    return {str(p.relative_to(root)): p.read_text() for p in sorted(root.rglob("*")) if p.is_file()}


# -- A: only a paired store is re-homed -------------------------------------------

def test_a_copied_catalog_with_the_real_home_leaves_every_real_board_in_place(home, caplog):
    """The review's scenario: NEBULA_STATE_DIR names a copy whose catalog lacks
    a project the real one has, HOME is real, the stores are the defaults.
    Before this, the copy's start moved the real board to Global."""
    real = home / ".nebula"
    boards = real / "moodboards"
    _asset(boards, LIVE, "b-live")
    _asset(boards, GONE, "b-other")
    _trashed(boards, "b-binned", GONE)
    _asset(boards, OLD, "b-old")  # a true orphan in the real store: not the copy's to move either
    before = _snapshot(boards)
    copy_state = home / "elsewhere" / "state"
    store = _catalog(copy_state, LIVE)  # the copy lacks GONE
    with caplog.at_level("WARNING", logger="services.asset_project_rehome"):
        report = _rehome(store, copy_state)
    assert report["status"] == "nothing to do" and report["moved"] == 0
    assert _snapshot(boards) == before
    assert not (real / "moodboard-backups").exists() and not (boards / "_global").exists()
    lines = [r.getMessage() for r in caplog.records if "stay where they are" in r.getMessage()]
    assert len(lines) == 1 and lines[0].startswith("3 moodboard asset(s)")
    assert str(home) not in lines[0] and GONE not in lines[0]


def test_the_unpaired_line_is_logged_once_per_start(home, caplog):
    boards = home / ".nebula" / "moodboards"
    _asset(boards, GONE, "b1")
    copy_state = home / "copy"
    store = _catalog(copy_state, LIVE)
    with caplog.at_level("WARNING", logger="services.asset_project_rehome"):
        _rehome(store, copy_state)
        _rehome(store, copy_state)
    assert len([r for r in caplog.records if "stay where they are" in r.getMessage()]) == 1


def test_a_copy_whose_store_links_to_the_real_one_is_never_rehomed(home):
    real_boards = home / "real" / ".nebula" / "moodboards"
    board = _asset(real_boards, GONE, "b1")
    record = _trashed(real_boards, "b-binned", GONE)[1]
    iso = home / "iso" / ".nebula"
    iso.mkdir(parents=True)
    (iso / "moodboards").symlink_to(real_boards, target_is_directory=True)
    store = _catalog(iso, LIVE)
    before = (board.read_text(), record.read_text())
    report = rehome_legacy_assets(lambda: store.read(), iso, roots=[AssetRoot("moodboard", iso / "moodboards", True)])
    assert report["moved"] == 0
    assert (board.read_text(), record.read_text()) == before
    assert not (real_boards / "_global").exists()


def test_the_real_nebula_layout_still_rehomes_a_true_orphan(home):
    """~/.nebula holds the catalog's projects/ and the stores: paired."""
    real = home / ".nebula"
    boards = real / "moodboards"
    _asset(boards, OLD, "b-old")
    _asset(boards, LIVE, "b-live")
    store = _catalog(real, LIVE)
    report = _rehome(store, real)
    assert report["moved"] == 1 and report["global"] == 1
    assert (boards / "_global" / "b-old.json").is_file() and (boards / LIVE / "b-live.json").is_file()


def test_the_desktop_layout_still_rehomes_a_true_orphan(home, monkeypatch):
    """<data>/state holds the catalog; the stores are beside it, their roots set."""
    data = home / "data"
    monkeypatch.setenv("NEBULA_MOODBOARD_ROOT", str(data / "moodboards"))
    monkeypatch.setenv("NEBULA_CHARACTER_ROOT", str(data / "characters"))
    monkeypatch.setenv("NEBULA_PRESET_ROOT", str(data / "presets"))
    _asset(data / "moodboards", OLD, "b-old")
    store = _catalog(data / "state", LIVE)
    report = _rehome(store, data / "state")
    assert report["moved"] == 1 and (data / "moodboards" / "_global" / "b-old.json").is_file()


def test_default_roots_say_which_ones_were_set(home, monkeypatch):
    monkeypatch.setenv("NEBULA_CHARACTER_ROOT", str(home / "c"))
    assert {spec.kind: spec.explicit for spec in default_roots()} == {
        "moodboard": False, "character": True, "preset": False}
    monkeypatch.setenv("NEBULA_PRESET_ROOT", str(home / "p"))
    assert {spec.kind: spec.explicit for spec in default_roots()}["preset"] is True


def test_a_root_beside_another_catalog_is_not_rehomed(home):
    real = home / ".nebula"
    _asset(real / "moodboards", OLD, "b-old")
    store = _catalog(real, LIVE)
    stray = _catalog(real / "state", GONE)  # another catalog beside the stores
    assert stray.path.exists()
    assert _rehome(store, real)["moved"] == 0
    assert (real / "moodboards" / OLD / "b-old.json").is_file()


# -- B: a linked part of a paired store keeps the id listed -------------------------

def _paired_store_with_link(tmp_path: Path, what: str):
    state = tmp_path / ".nebula"
    root = state / "moodboards"
    other = tmp_path / "other" / "moodboards"
    _asset(root, LIVE, "b-keep")  # gives the store its evidence
    real_asset, real_record = _trashed(other, "b-real", GONE)
    real_side = other / ".notes" / "b-real.json"
    real_side.parent.mkdir(parents=True, exist_ok=True)
    real_side.write_text("{}")
    if what == "trash":
        (root / ".trash").symlink_to(other / ".trash", target_is_directory=True)
    elif what == "side":
        (root / ".notes").symlink_to(other / ".notes", target_is_directory=True)
    elif what == "folder":
        (root / GONE).symlink_to(other / ".trash", target_is_directory=True)
    store = purge.AssetStore("moodboard", root, (".notes",))
    return state, store, real_asset, real_record, real_side


@pytest.mark.parametrize("what", ["trash", "side", "folder"])
def test_a_linked_part_of_a_paired_store_keeps_the_id_listed(tmp_path, what, caplog):
    state, store, real_asset, real_record, real_side = _paired_store_with_link(tmp_path, what)
    assert purge.roots_paired(state, store.root)
    catalog = {"projects": {}, "trash": {}, PENDING: [GONE]}
    with caplog.at_level("WARNING", logger="services.project_asset_purge"):
        done, _removed = purge.finish(catalog, state_dir=state, stores=[store])
    assert done == [] and purge.pending(catalog) == [GONE]
    assert real_asset.is_file() and real_record.is_file() and real_side.is_file()
    lines = [r.getMessage() for r in caplog.records if "linked folder" in r.getMessage()]
    assert len(lines) == 1 and str(tmp_path) not in lines[0] and GONE not in lines[0]


def test_the_rehome_then_leaves_a_linked_trash_alone(tmp_path):
    """The review's chain: the purge keeps the id, so the re-home (which follows
    a linked .trash) doesn't move the real trashed board to Global."""
    state, store, real_asset, real_record, _side = _paired_store_with_link(tmp_path, "trash")
    catalog_store = _catalog(state, LIVE, purging=(GONE,))
    done, _ = purge.finish(catalog_store.read(), state_dir=state, stores=[store])
    assert done == []  # so the id is still listed in the catalog the re-home reads
    before = (real_asset.read_text(), real_record.read_text())
    report = _rehome(catalog_store, state, roots=[AssetRoot("moodboard", store.root, True)])
    assert report["moved"] == 0 and (real_asset.read_text(), real_record.read_text()) == before


def test_without_a_link_the_same_id_is_done(tmp_path):
    state, store, *_ = _paired_store_with_link(tmp_path, "none")
    done, _ = purge.finish({"projects": {}, "trash": {}, PENDING: [GONE]}, state_dir=state, stores=[store])
    assert done == [GONE]


# -- C: an empty folder is not proof of a store -------------------------------------

def test_an_empty_folder_where_the_store_should_be_keeps_the_id_listed(tmp_path, caplog):
    state = tmp_path / ".nebula"
    root = state / "moodboards"
    root.mkdir(parents=True)  # the mount point of a disk that is out
    store = purge.AssetStore("moodboard", root)
    (root / ".DS_Store").write_text("")  # a file isn't a sign of a store
    catalog = {"projects": {}, "trash": {}, PENDING: [GONE]}
    with caplog.at_level("WARNING", logger="services.project_asset_purge"):
        done, _ = purge.finish(catalog, state_dir=state, stores=[store])
    assert done == [] and purge.pending(catalog) == [GONE]
    assert not (root / "_global").exists()  # nothing is made in an unproven folder
    assert any("nothing to show it ever held assets" in r.getMessage() for r in caplog.records)
    # The disk comes back: its boards are purged, not moved to Global.
    board = _asset(root, GONE, "b1")
    done, removed = purge.finish(catalog, state_dir=state, stores=[store])
    assert done == [GONE] and not board.exists() and len(removed["moodboard"]) == 1


def test_the_rehome_does_not_move_boards_while_the_id_waits_on_an_empty_folder(tmp_path):
    state = tmp_path / ".nebula"
    root = state / "moodboards"
    root.mkdir(parents=True)
    catalog_store = _catalog(state, LIVE, purging=(GONE,))
    purge.finish(catalog_store.read(), state_dir=state, stores=[purge.AssetStore("moodboard", root)])
    board = _asset(root, GONE, "b1")  # the disk is back
    report = _rehome(catalog_store, state, roots=[AssetRoot("moodboard", root, False)])
    assert report["moved"] == 0 and board.is_file()


def test_a_store_that_showed_evidence_keeps_it_after_the_last_folder_goes(tmp_path):
    """A purge that deleted everything then crashed before clearing the id:
    the retry reads an emptied store, and still finishes."""
    state = tmp_path / ".nebula"
    root = state / "moodboards"
    _asset(root, GONE, "b1")
    store = purge.AssetStore("moodboard", root)
    catalog = {"projects": {}, "trash": {}, PENDING: [GONE]}
    assert purge.finish(catalog, state_dir=state, stores=[store])[0] == [GONE]
    assert (root / "_global").is_dir() and not (root / GONE).exists()
    assert purge.finish(catalog, state_dir=state, stores=[store])[0] == [GONE]


def test_a_store_folder_that_does_not_exist_yet_is_done(tmp_path):
    state = tmp_path / ".nebula"
    state.mkdir()
    store = purge.AssetStore("moodboard", state / "moodboards")
    assert purge.finish({"projects": {}, "trash": {}, PENDING: [GONE]}, state_dir=state, stores=[store])[0] == [GONE]
    assert not (state / "moodboards").exists()


def test_evidence_is_taken_before_anything_is_deleted(tmp_path):
    """Two ids on one list: the first one's pass empties the store, the second
    still counts as a real store."""
    state = tmp_path / ".nebula"
    root = state / "moodboards"
    other = "c3" * 16
    _asset(root, GONE, "b1")
    store = purge.AssetStore("moodboard", root)
    catalog = {"projects": {}, "trash": {}, PENDING: sorted([GONE, other])}
    assert purge.finish(catalog, state_dir=state, stores=[store])[0] == sorted([GONE, other])


# -- D: a stray catalog is named once, never removed --------------------------------

def test_a_stray_catalog_is_logged_once_with_what_to_do_and_never_deleted(tmp_path, caplog):
    state = tmp_path / ".nebula"
    root = state / "moodboards"
    _asset(root, GONE, "b1")
    stray = _catalog(state / "state", LIVE).path  # state/projects/catalog.json
    store = purge.AssetStore("moodboard", root)
    with caplog.at_level("WARNING", logger="services.project_asset_purge"):
        for _ in range(3):
            assert not purge.roots_paired(state, root)
    lines = [r.getMessage() for r in caplog.records if "Another project catalog" in r.getMessage()]
    assert len(lines) == 1
    assert "remove it by hand" in lines[0] and str(tmp_path) not in lines[0]
    assert stray.is_file() and purge.finish({"projects": {}, "trash": {}, PENDING: [GONE]},
                                           state_dir=state, stores=[store])[0] == []
    assert stray.is_file()


def test_the_rehome_logs_the_stray_catalog_too(home, caplog):
    real = home / ".nebula"
    _asset(real / "moodboards", OLD, "b-old")
    store = _catalog(real, LIVE)
    _catalog(real / "state", GONE)
    with caplog.at_level("WARNING", logger="services.project_asset_purge"):
        _rehome(store, real)
    assert any("Another project catalog" in r.getMessage() for r in caplog.records)


# -- E: a mounted store -------------------------------------------------------------

def test_a_store_on_another_device_than_its_folder_is_unpaired(tmp_path, monkeypatch):
    state = tmp_path / ".nebula"
    root = state / "moodboards"
    root.mkdir(parents=True)
    assert purge.roots_paired(state, root)
    real_ident = purge._ident

    def other_device(path):
        dev, ino = real_ident(path)
        return (dev + 1, ino) if Path(path) == root else (dev, ino)

    monkeypatch.setattr(purge, "_ident", other_device)
    assert purge._pairing(state, root, False) == "mounted elsewhere"
    assert not purge.roots_paired(state, root)


def test_a_folder_that_is_not_the_one_expected_is_unpaired(tmp_path, monkeypatch):
    """Same path, a different folder by device and inode (a mount over it)."""
    state = tmp_path / ".nebula"
    root = state / "moodboards"
    root.mkdir(parents=True)
    real_ident = purge._ident
    calls: list[Path] = []

    def swapped(path):
        calls.append(Path(path))
        dev, ino = real_ident(path)
        # The first folder asked about (the store's parent) reads as another inode.
        return (dev, ino + 1) if len(calls) == 1 else (dev, ino)

    monkeypatch.setattr(purge, "_ident", swapped)
    assert not purge.roots_paired(state, root)


def test_a_bind_mounted_real_store_in_a_copy_is_not_purged(tmp_path, monkeypatch):
    """The review's LOW-4: a copy with the real store mounted into its home
    (a different device here, simulated: bind mounts need root)."""
    copy = tmp_path / "copy" / ".nebula"
    root = copy / "moodboards"
    board = _asset(root, GONE, "b-real")
    real_ident = purge._ident
    monkeypatch.setattr(purge, "_ident", lambda p: (real_ident(p)[0] + (1 if Path(p) == root else 0), real_ident(p)[1]))
    store = purge.AssetStore("moodboard", root)
    done, removed = purge.finish({"projects": {}, "trash": {}, PENDING: [GONE]}, state_dir=copy, stores=[store])
    assert done == [] and board.is_file() and not any(removed.values())


# -- F: goesWithProject doesn't over-promise ---------------------------------------

def _record(pid, scope=None, **extra):
    return {"id": "x", "projectId": pid, "scopeDir": scope if scope is not None else pid, **extra}


def test_goes_with_project_needs_a_catalog_shaped_id_and_a_purged_kind():
    going = {"moodboard"}
    assert purge.goes_with_project("moodboard", _record(GONE), going) is True
    assert purge.goes_with_project("moodboard", _record(OLD), going) is False       # old-style id
    assert purge.goes_with_project("moodboard", _record(None, "_global"), going) is False
    assert purge.goes_with_project("moodboard", _record(GONE, "_global"), going) is False
    assert purge.goes_with_project("character", _record(GONE), going) is False     # that kind isn't purged
    assert purge.goes_with_project("moodboard", {"projectId": 7, "scopeDir": 7}, going) is False


def test_the_trash_listing_does_not_promise_under_a_linked_trash(ws):  # noqa: F811
    client, _store, roots, _ = ws
    other = roots["moodboard"].parent / "other-boards"
    _trashed(other, "b-linked", GONE)
    _trashed(roots["character"], "c-own", GONE)
    roots["moodboard"].mkdir(parents=True, exist_ok=True)
    (roots["moodboard"] / ".trash").symlink_to(other / ".trash", target_is_directory=True)
    items = {item["id"]: item for item in client.get("/api/trash").json()["items"]}
    assert "goesWithProject" not in items["b-linked"]
    assert items["c-own"].get("goesWithProject") is True


def test_the_trash_listing_does_not_promise_for_an_old_style_id(ws):  # noqa: F811
    client, _store, roots, _ = ws
    _trashed(roots["moodboard"], "b-old", OLD)
    items = {item["id"]: item for item in client.get("/api/trash").json()["items"]}
    assert "goesWithProject" not in items["b-old"]


def test_evidence_taken_up_front_holds_when_the_marker_folder_cant_be_made(tmp_path):
    """``_global`` can't be made (a file stands there): the second id on the
    list is still judged on the store as it was before the first one's pass."""
    state = tmp_path / ".nebula"
    root = state / "moodboards"
    other = "c3" * 16
    _asset(root, GONE, "b1")
    (root / "_global").write_text("not a folder")
    store = purge.AssetStore("moodboard", root)
    catalog = {"projects": {}, "trash": {}, PENDING: sorted([GONE, other])}
    assert purge.finish(catalog, state_dir=state, stores=[store])[0] == sorted([GONE, other])


def test_a_folder_holding_only_a_link_is_not_evidence(tmp_path):
    state = tmp_path / ".nebula"
    root = state / "moodboards"
    root.mkdir(parents=True)
    (tmp_path / "elsewhere").mkdir()
    (root / "linked").symlink_to(tmp_path / "elsewhere", target_is_directory=True)
    store = purge.AssetStore("moodboard", root)
    assert not purge.has_evidence(store)
    assert purge.finish({"projects": {}, "trash": {}, PENDING: [GONE]}, state_dir=state, stores=[store])[0] == []
