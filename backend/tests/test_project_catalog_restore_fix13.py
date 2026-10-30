"""PR #199 fix round 13 (GM r17).

- Past the limit (an Undo that passed it, then a canvas waiting): the count
  is named. The listing's `deletes` (per canvas and in total) and the agents'
  `note` that MCP (start_here, list_projects) and the CLI (`nebula projects`,
  `nebula context`) print say, GM r18 (Q4), "The project list has 4
  projects, over the limit of 3. Move 2 to Recently deleted to make room.";
  at the limit itself
  the line is as before ("Moving a project …").
- Q4: MCP new_project past the limit carries the limit and its number, as
  the HTTP body does; the 409 canvas_kept_in_tab detail uses ’.
"""
from __future__ import annotations

import asyncio
import re
import sys
from pathlib import Path

import pytest

sys.path.insert(0, str(Path(__file__).resolve().parent.parent))

import main as main_module  # noqa: E402
import mcp_server  # noqa: E402
from cli.commands import projects as projects_cli  # noqa: E402
from cli.formatter import format_start  # noqa: E402
from nebula_api import NebulaAPI  # noqa: E402
from services import project_store as store_module  # noqa: E402
from tests.conftest import PERSON  # noqa: E402
from tests.test_project_catalog_restore_fix2 import _add_text, _create, app  # noqa: E402,F401

AGENT = {**PERSON, "X-Nebula-Agent": "Codex"}


def _waiting_with(client, graph, state, monkeypatch, projects: int, limit: int = 3) -> list[str]:
    """`projects` projects, then the limit set to `limit` (a list past it, as
    an Undo that passed it leaves one) and the live canvas waiting: a canvas
    from a project the list lacks, with a node."""
    ids = [_create(client, f"P{n}") for n in range(projects)]
    _add_text(client, "waits")
    client.get("/api/projects", headers=PERSON)
    monkeypatch.setattr(store_module, "MAX_PROJECTS", limit)
    graph.owner = "e" * 32
    graph.save(state)
    return ids


def test_past_the_limit_the_listing_counts_and_the_agents_note_names_the_number(app, monkeypatch):
    client, store, graph, state = app
    _waiting_with(client, graph, state, monkeypatch, projects=4)
    waiting = client.get("/api/projects", headers=PERSON).json()["canvasNotFiled"]
    assert waiting["reason"] == "projects"
    assert waiting["deletes"] == 2
    assert [row["deletes"] for row in waiting["canvases"]] == [2]
    assert "The project list has 4 projects, over the limit of 3. Move 2 to Recently deleted to make room." in waiting["note"]
    assert "Moving a project" not in waiting["note"]


def test_at_the_limit_the_line_is_as_before(app, monkeypatch):
    client, store, graph, state = app
    _waiting_with(client, graph, state, monkeypatch, projects=3)
    waiting = client.get("/api/projects", headers=PERSON).json()["canvasNotFiled"]
    assert waiting["deletes"] == 1
    assert "at its limit of 3 projects. Moving a project to Recently deleted frees a slot" in waiting["note"]


def test_mcp_and_the_cli_say_the_number(app, monkeypatch, capsys):
    client, store, graph, state = app
    _waiting_with(client, graph, state, monkeypatch, projects=5)
    client.get("/api/projects", headers=PERSON)  # the listing marks it waiting
    monkeypatch.setattr(mcp_server, "_api", lambda: NebulaAPI("http://testserver", client=client))
    started = asyncio.run(mcp_server.mcp.call_tool("start_here", {}))
    text = str(started)
    assert "The project list has 5 projects, over the limit of 3. Move 3 to Recently deleted to make room." in text
    listed = asyncio.run(mcp_server.mcp.call_tool("list_projects", {}))
    assert "The project list has 5 projects, over the limit of 3. Move 3 to Recently deleted to make room." in str(listed)

    class Client:
        def list_projects(self):
            return client.get("/api/projects", headers=AGENT).json()
    projects_cli.run_list(Client())  # type: ignore[arg-type]
    assert "The project list has 5 projects, over the limit of 3. Move 3 to Recently deleted to make room." in capsys.readouterr().out
    start = client.get("/api/agent/start", headers=AGENT).json()
    assert "The project list has 5 projects, over the limit of 3. Move 3 to Recently deleted to make room." in format_start(start)


def test_q4_mcp_new_project_past_the_limit_carries_the_limit_and_its_number(app, monkeypatch):
    client, store, graph, state = app
    for name in ("A", "B", "C"):
        _create(client, name)
    monkeypatch.setattr(store_module, "MAX_PROJECTS", 3)
    monkeypatch.setattr(mcp_server, "_api", lambda: NebulaAPI("http://testserver", client=client))
    with pytest.raises(Exception) as raised:
        asyncio.run(mcp_server.mcp.call_tool("new_project", {"name": "Fourth"}))
    assert 'Project limit reached (413, {"limit": "projects", "projectLimit": 3})' in str(raised.value)


def test_q4_the_kept_detail_uses_curly_apostrophes():
    detail = main_module.CANVAS_KEPT_IN_TAB_DETAIL
    assert "’" in detail
    assert not re.search(r"[A-Za-z]'[A-Za-z]", detail)
    assert detail.startswith("The person’s tab is keeping edits Nebula couldn’t save")


def test_a_copy_past_the_limit_restores_and_the_canvas_waits_on_two_deletes(app, monkeypatch):
    """Found by round 13's live check: a list an Undo took past the limit (4
    of 3), then catalog.json damaged. The restore from .bak (Nebula's own
    copy of that list) was refused as "past a limit" and every listing then
    answered 413. A restore adds no new project, so it may pass the limit:
    the list comes back whole and the open canvas, missing from the copy,
    waits on 4 + 1 - 3 = 2 deletes."""
    client, store, graph, state = app
    ids = [_create(client, name) for name in ("Alpha", "Beta", "Gamma", "Epsilon")]
    _add_text(client, "epsilon-1")
    client.get("/api/projects", headers=PERSON)
    copy = store.path.read_bytes()
    _create(client, "Delta")
    _add_text(client, "delta-1")
    client.get("/api/projects", headers=PERSON)
    monkeypatch.setattr(store_module, "MAX_PROJECTS", 3)
    store.path.write_bytes(b"\0" * store.path.stat().st_size)
    store.backup_path.write_bytes(copy)
    store.older_backup_path.unlink(missing_ok=True)

    listing = client.get("/api/projects", headers=PERSON)

    assert listing.status_code == 200, listing.text
    body = listing.json()
    assert body["catalogRestore"]["source"] == "catalog.json.bak"
    assert sorted(p["id"] for p in body["projects"]) == sorted(ids)
    waiting = body["canvasNotFiled"]
    assert waiting["reason"] == "projects" and waiting["deletes"] == 2
    assert [row["deletes"] for row in waiting["canvases"]] == [2]
    # The next listing reads it again (the restored list commits past the limit).
    again = client.get("/api/projects", headers=PERSON)
    assert again.status_code == 200 and len(again.json()["projects"]) == 4
    # A new project is still refused.
    created = client.post("/api/projects", json={"name": "Sixth", "workspaceRevision": again.json()["workspaceRevision"]},
                          headers=PERSON)
    assert created.status_code == 413 and created.json()["projectLimit"] == 3
