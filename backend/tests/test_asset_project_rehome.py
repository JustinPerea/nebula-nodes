"""The one-time re-home of project assets saved under the old install-wide id
(services/asset_project_rehome.py), rule R1: by use, else Global."""
from __future__ import annotations

import json
from pathlib import Path

import pytest

from services import asset_project_rehome as rehome
from services.asset_project_rehome import AssetRoot, rehome_legacy_assets
from services.project_store import ProjectStore, make_project, move_to_trash

OLD = "nebula_nodes"


@pytest.fixture
def env(tmp_path, monkeypatch):
    monkeypatch.setenv("NEBULA_MOODBOARD_ROOT", str(tmp_path / "moodboards"))
    monkeypatch.setenv("NEBULA_CHARACTER_ROOT", str(tmp_path / "characters"))
    monkeypatch.setenv("NEBULA_PRESET_ROOT", str(tmp_path / "presets"))

    class Env:
        state = tmp_path / "state"
        store = ProjectStore(tmp_path / "state" / "projects")
        boards = tmp_path / "moodboards"
        characters = tmp_path / "characters"
        presets = tmp_path / "presets"
        roots = [AssetRoot("moodboard", tmp_path / "moodboards", True),
                 AssetRoot("character", tmp_path / "characters", True),
                 AssetRoot("preset", tmp_path / "presets", False)]

        def projects(self, *specs, active=None, trashed=()):
            """Make canvas projects: each spec is (name, [board ids], [character ids])."""
            ids = {}
            with self.store.transaction() as catalog:
                for name, boards, characters in specs:
                    nodes = [{"id": f"m{i}", "type": "moodboard", "data": {"definitionId": "nebula-moodboard",
                                                                           "params": {"moodboard": b}}}
                             for i, b in enumerate(boards)]
                    nodes += [{"id": f"c{i}", "type": "character", "data": {"definitionId": "character",
                                                                            "params": {"character": c}}}
                              for i, c in enumerate(characters)]
                    project = make_project(name, {"nodes": nodes, "edges": [], "runHistory": [], "viewport": None,
                                                  "createSessionId": None})
                    catalog["projects"][project["id"]] = project
                    ids[name] = project["id"]
                for name in trashed:
                    move_to_trash(catalog, ids[name])
                catalog["activeProjectId"] = ids[active] if active else None
                self.store.commit(catalog)
            return ids

        def run(self, live_nodes=()):
            return rehome_legacy_assets(
                lambda: self.store.read() if self.store.path.exists() else None, self.state,
                live_nodes=live_nodes, roots=self.roots)

    return Env()


def _board(project_id=OLD, name="Board"):
    from services.moodboard_store import MoodboardStore
    return MoodboardStore().create(name=name, images=[{"url": "/api/outputs/a.png"}], projectId=project_id)


def _character(project_id=OLD, name="Nari"):
    from services.character_store import CharacterStore
    return CharacterStore().create(name=name, subjectType="human", referenceViews=["a", "b", "c"],
                                   frozenTraitString="silver hair", seed=1, consistencyStrength=0.8,
                                   projectId=project_id)


def _style(project_id=OLD, name="Warm"):
    from services.preset_store import preset_store
    return preset_store.create(name=name, category="My Styles", prompt="warm", params={}, modelId=None,
                               refImages=[], scope="project", projectId=project_id, params_version=0)


def _read(path: Path) -> dict:
    return json.loads(path.read_text(encoding="utf-8"))


def test_r1_by_use_else_global(env):
    one, both, unused, trashed_only = _board(name="One"), _board(name="Both"), _board(name="Unused"), _board(name="Gone")
    nari = _character()
    style = _style()
    ids = env.projects(("A", [one["id"], both["id"]], []), ("B", [both["id"]], [nari["id"]]),
                       ("Old", [trashed_only["id"]], []), active="A", trashed=["Old"])
    before = _read(env.boards / OLD / f"{one['id']}.json")

    report = env.run()

    assert report["status"] == "done" and report["moved"] == 6 and report["skipped"] == 0
    moved = _read(env.boards / ids["A"] / f"{one['id']}.json")
    # A re-home isn't an edit: only projectId changes.
    assert moved == {**before, "projectId": ids["A"]}
    assert _read(env.characters / ids["B"] / f"{nari['id']}.json")["projectId"] == ids["B"]
    for board in (both, unused, trashed_only):
        assert _read(env.boards / "_global" / f"{board['id']}.json")["projectId"] is None
    saved_style = _read(env.presets / "_global" / f"{style['id']}.json")
    assert saved_style["projectId"] is None and saved_style["scope"] == "global"
    assert saved_style["version"] == style["version"] and saved_style["updatedAt"] == style["updatedAt"]
    # Emptied old folders go.
    assert not (env.boards / OLD).exists() and not (env.characters / OLD).exists() and not (env.presets / OLD).exists()

    log = _read(Path(next(path for path in report["logs"] if "moodboard-backups" in path)))
    reasons = {item["name"]: (item["to"], item["reason"]) for item in log["moved"]}
    assert reasons["One"] == ({"projectId": ids["A"], "projectName": "A"}, "used only in A")
    assert reasons["Both"] == ("Global", "used in 2 projects")
    assert reasons["Unused"] == ("Global", "not used in any project")
    assert reasons["Gone"] == ("Global", "not used in any project")
    assert all(item["from"] == OLD for item in log["moved"])
    style_log = _read(Path(next(path for path in report["logs"] if "preset-backups" in path)))
    assert style_log["moved"][0]["reason"] == "styles go to Global"
    # Each moved file was backed up first, byte for byte.
    backup = Path(next(item for item in log["moved"] if item["name"] == "One")["backup"])
    assert backup.parent.name == OLD and _read(backup) == before
    assert backup.parent.parent.parent == env.boards.parent / "moodboard-backups"

    # What the Project tab lists now.
    from services.moodboard_store import MoodboardStore
    assert [b["id"] for b in MoodboardStore().list(scope="project", projectId=ids["A"])] == [one["id"]]


def test_the_open_projects_live_graph_counts_when_its_snapshot_is_behind(env):
    board = _board()
    ids = env.projects(("A", [], []), ("B", [], []), active="B")
    env.run(live_nodes=[{"id": "n1", "definitionId": "nebula-moodboard", "params": {"_moodboardId": board["id"]}}])
    assert (env.boards / ids["B"] / f"{board['id']}.json").exists()


def test_a_trashed_asset_and_its_record_move_and_restore_there(env):
    from services.moodboard_store import MoodboardStore
    from services.character_store import CharacterStore

    board, nari = _board(), _character()
    store = MoodboardStore()
    store.delete(board["id"])
    CharacterStore().delete(nari["id"])
    ids = env.projects(("A", [board["id"]], []), active="A")

    report = env.run()

    assert report["moved"] == 2
    record = _read(env.boards / ".trash" / f"{board['id']}.trash.json")
    assert record["projectId"] == ids["A"] and record["scopeDir"] == ids["A"]
    assert _read(env.boards / ".trash" / f"{board['id']}.json")["projectId"] == ids["A"]
    assert [item["id"] for item in store.list_trash(scope="project", projectId=ids["A"])] == [board["id"]]
    restored = store.restore(board["id"])
    assert restored["projectId"] == ids["A"] and (env.boards / ids["A"] / f"{board['id']}.json").exists()
    character_record = _read(env.characters / ".trash" / f"{nari['id']}.trash.json")
    assert character_record["scopeDir"] == "_global" and character_record["projectId"] is None
    log = _read(Path(next(path for path in report["logs"] if "moodboard-backups" in path)))
    assert log["moved"][0]["trashed"] is True and len(log["moved"][0]["backup"]) == 2


def test_canvas_project_folders_and_globals_are_untouched(env):
    ids = env.projects(("A", [], []), ("Old", [], []), active="A", trashed=["Old"])
    in_a, in_old, global_board = _board(ids["A"]), _board(ids["Old"]), _board(None)
    files = {path: path.read_bytes() for path in env.boards.rglob("*.json")}

    report = env.run()

    assert report["moved"] == 0 and report["logs"] == []
    assert {path: path.read_bytes() for path in env.boards.rglob("*.json")} == files
    assert not (env.boards.parent / "moodboard-backups").exists()
    assert (env.state / "migrations" / rehome.MARKER_NAME).exists()
    assert in_a and in_old and global_board


def test_a_collision_is_skipped_never_overwritten(env):
    board = _board()
    env.projects(("A", [], []), active="A")
    existing = env.boards / "_global" / f"{board['id']}.json"
    existing.parent.mkdir(parents=True, exist_ok=True)
    existing.write_text(json.dumps({"id": board["id"], "name": "Someone else"}), encoding="utf-8")

    report = env.run()

    assert report["moved"] == 0 and report["skipped"] == 1
    assert _read(existing)["name"] == "Someone else"
    assert (env.boards / OLD / f"{board['id']}.json").exists()
    log = _read(Path(report["logs"][0]))
    assert "already exists" in log["skipped"][0]["reason"]


def test_runs_once_and_is_a_no_op_after(env):
    board = _board()
    env.projects(("A", [board["id"]], []), active="A")
    assert env.run()["moved"] == 1
    # An old folder that shows up later (or a project deleted after the
    # re-home) isn't touched again.
    late = _board(name="Late")
    again = env.run()
    assert again == {"status": "already done", "moved": 0, "global": 0, "skipped": 0, "logs": []}
    assert (env.boards / OLD / f"{late['id']}.json").exists()


def test_an_unreadable_catalog_changes_nothing_and_writes_no_marker(env):
    board = _board()
    env.projects(("A", [board["id"]], []), active="A")
    env.store.path.write_text("{not json", encoding="utf-8")

    report = env.run()

    assert report["status"].startswith("skipped: the project catalog could not be read")
    assert (env.boards / OLD / f"{board['id']}.json").exists()
    assert not (env.state / "migrations" / rehome.MARKER_NAME).exists()


def test_waits_while_the_open_canvas_is_not_a_project_yet(env):
    board = _board()
    report = env.run(live_nodes=[{"id": "n1", "definitionId": "nebula-moodboard", "params": {"moodboard": board["id"]}}])
    assert report["status"] == "skipped: the open canvas isn't a project yet"
    assert (env.boards / OLD / f"{board['id']}.json").exists()
    assert not (env.state / "migrations" / rehome.MARKER_NAME).exists()


def test_a_fresh_install_gets_only_the_marker(env):
    report = env.run()
    assert report["moved"] == 0 and report["logs"] == []
    assert not env.boards.exists() and not env.characters.exists() and not env.presets.exists()
    assert sorted(path.name for path in env.state.rglob("*")) == sorted(["migrations", rehome.MARKER_NAME])


def test_finishes_a_move_an_earlier_run_left_half_done(env):
    """The new file was written but the old one wasn't removed yet."""
    board = _board()
    ids = env.projects(("A", [board["id"]], []), active="A")
    source = env.boards / OLD / f"{board['id']}.json"
    target = env.boards / ids["A"] / source.name
    target.parent.mkdir(parents=True)
    target.write_text(json.dumps({**_read(source), "projectId": ids["A"]}), encoding="utf-8")

    report = env.run()

    assert report["moved"] == 1 and report["skipped"] == 0
    assert not source.exists() and _read(target)["projectId"] == ids["A"]


def test_the_startup_hook_logs_one_line(env, monkeypatch, capsys):
    import asyncio
    import main

    board = _board()
    ids = env.projects(("A", [board["id"]], []), active="A")
    monkeypatch.delenv("NEBULA_NO_ASSET_REHOME")
    monkeypatch.setattr(main, "project_store", env.store)
    monkeypatch.setattr(main, "_STATE_DIR", env.state)
    monkeypatch.setattr(main.cli_graph, "nodes", {})

    asyncio.run(main._asset_project_rehome_startup())

    out = capsys.readouterr().out
    assert "[main] project asset re-home (done): 1 moved (0 to Global), 0 skipped; logs: " in out
    assert (env.boards / ids["A"] / f"{board['id']}.json").exists()
    asyncio.run(main._asset_project_rehome_startup())
    assert "re-home" not in capsys.readouterr().out
