"""PR #199 fix round 14 (GM r18).

- The limit wording: the agents' note past the limit is GM's sentence, with the real
  numbers: "The project list has 4 projects, over the limit of 3. Move 2 to
  Recently deleted to make room." (MCP and the CLI print the same note:
  test_project_catalog_restore_fix13).
- Records past the limit: a restore adds no record back past the project limit (reconcile).
  The readable records it left out because of the limit are counted in the
  record (`notAddedBackLimitCount`, with `projectLimit`), and agents read
  the same fact as the person, in plain text; "could not be added back"
  stays for the rest.
"""
from __future__ import annotations

import json
import sys
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent.parent))

import main as main_module  # noqa: E402
from services import project_store as store_module  # noqa: E402
from tests.conftest import PERSON  # noqa: E402
from tests.test_project_catalog_restore_fix2 import _add_text, _create, app  # noqa: E402,F401


def _record(left_out: list[str | None], other: int = 0, count: int | None = None) -> dict:
    rows = [{"id": f"{n:032x}", "reason": "limit", **({"name": name} if name else {})} for n, name in enumerate(left_out)]
    rows += [{"id": f"{100 + n:032x}", "reason": "unreadable"} for n in range(other)]
    total = count if count is not None else len(rows)
    return {"kind": "restored", "source": "catalog.json.bak", "reason": "corrupt", "notAddedBack": rows,
            "notAddedBackCount": total, "notAddedBackLimitCount": total - other, "projectLimit": 500,
            "setAside": ["/p/catalog.json.damaged-1"]}


def test_q4_the_note_is_gms_sentence_with_the_numbers():
    limit = store_module.MAX_PROJECTS
    note = main_module._canvas_not_filed_note("projects", deletes=2, projects=limit + 1)
    assert f"The project list has {limit + 1} projects, over the limit of {limit}. Move 2 to Recently deleted to make room." in note
    # Several canvases waiting at the limit itself: the same pattern, never "over".
    at = main_module._canvas_not_filed_note("projects", deletes=2, projects=limit)
    assert f"The project list is at its limit of {limit} projects. Move 2 to Recently deleted to make room." in at
    # One delete: as before.
    assert "Moving a project to Recently deleted frees a slot" in main_module._canvas_not_filed_note("projects", deletes=1, projects=limit)


def test_q5_agents_read_the_left_out_records_in_plain_text():
    note = main_module._catalog_restore_note(_record(["Alpha", "Beta"]))
    assert ('"Alpha" and "Beta" weren\'t added back because the project list is at its limit of 500 projects. '
            'They\'re still in the damaged file, which was kept (notAddedBack, reason "limit").') in note
    assert "could not be added back" not in note
    three = main_module._catalog_restore_note(_record(["Alpha", "Beta", "Gamma"]))
    assert '"Alpha", "Beta" and "Gamma" weren\'t added back' in three
    # Review 13 NIT-3 of PR #199: three are named, from four on they're counted.
    four = main_module._catalog_restore_note(_record(["Alpha", "Beta", "Gamma", "Delta"]))
    assert "4 projects weren't added back because the project list is at its limit of 500 projects." in four
    assert '"Delta"' not in four
    many = main_module._catalog_restore_note(_record(["A", "B", "C", "D", "E"]))
    assert "5 projects weren't added back because the project list is at its limit of 500 projects." in many
    one = main_module._catalog_restore_note(_record(["Alpha"]))
    assert '"Alpha" wasn\'t added back because' in one and "It's still in the damaged file" in one


def test_q5_a_mix_keeps_could_not_be_added_back_for_the_rest():
    note = main_module._catalog_restore_note(_record(["Alpha", "Beta"], other=1))
    assert "1 project in the damaged file could not be added back and stays only there (notAddedBack)." in note
    assert '"Alpha" and "Beta" weren\'t added back because the project list is at its limit of 500 projects.' in note


def test_q5_a_restore_at_the_limit_records_the_readable_records_it_left_out(app, monkeypatch):
    """The copy holds 3 projects (the limit); the damaged file, cut at its
    end, still holds Delta and Epsilon readable. Neither comes back past the
    limit; the record counts them, and the note names them."""
    client, store, graph, state = app
    for name in ("Alpha", "Beta", "Gamma"):
        _create(client, name)
    client.get("/api/projects", headers=PERSON)
    copy = store.path.read_bytes()
    for name in ("Delta", "Epsilon"):
        _create(client, name)
        _add_text(client, f"{name.lower()}-1")
    client.get("/api/projects", headers=PERSON)
    monkeypatch.setattr(store_module, "MAX_PROJECTS", 3)
    store.path.write_bytes(store.path.read_bytes()[:-3])
    store.backup_path.write_bytes(copy)
    store.older_backup_path.unlink(missing_ok=True)

    body = client.get("/api/projects", headers=PERSON).json()

    restore = body["catalogRestore"]
    assert sorted(p["name"] for p in body["projects"]) == ["Alpha", "Beta", "Gamma"]
    assert restore["notAddedBackLimitCount"] == 2 and restore["projectLimit"] == 3
    assert sorted(row["name"] for row in restore["notAddedBack"] if row["reason"] == "limit") == ["Delta", "Epsilon"]
    # Epsilon was open: the canvas's line owns it (GM r21 on PR #199, 4), so
    # the left-out line names only Delta, as the person's notice does.
    assert restore["openProjectMissing"] == next(row["id"] for row in restore["notAddedBack"] if row["name"] == "Epsilon")
    assert "\"Delta\" wasn't added back because the project list is at its limit of 3 projects" in restore["note"]
    assert "Epsilon" not in restore["note"]
    assert json.dumps(restore["note"]).count("could not be added back") == 0
