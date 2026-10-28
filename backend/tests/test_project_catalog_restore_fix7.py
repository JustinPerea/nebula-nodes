"""PR #199 review 7: what fix round 7 makes true (2026-10-28).

- M-1. Whether the live canvas waits is read from the canvas itself: an
  agent's write right after a catalog restore, before any listing, settles
  the canvas first, so at the limit it is refused and the person's canvas is
  the one saved. The guard runs again in the write step of a route that
  awaits (N-4). No route that changes cli_graph goes unmarked (N-3).
- M-2 / N-6. A held canvas's nodes and connections are checked item by item,
  each canvas is filed in its own try, and a damaged main copy loses to a
  good .bak.
- L-1. A canvas is held once, filed once, and named once.
- L-2. A cut canvas-held.json keeps its complete leading entries.
- L-3. One file per held canvas, no shared cap: the person's open always
  holds it; only an agent's write is refused past a project's size. The old
  canvas-held.json moves in once, a crash midway included.
- N-1 / N-2 / N-5: no false "may be lost", restoreRoom's deletes counted
  along the way, sizes measured once.
- GM: the person's own clear and load lines, the over-the-save-limit saved
  line's marker, the Agent log line after a restore.
"""
from __future__ import annotations

import ast
import asyncio
import json
import re
import sys
from pathlib import Path

import pytest

sys.path.insert(0, str(Path(__file__).resolve().parent.parent))
import main as main_module  # noqa: E402
import mcp_server  # noqa: E402
from nebula_api import NebulaAPI  # noqa: E402
from services import project_store as store_module  # noqa: E402
from services.cli_graph import CLIGraph  # noqa: E402
from services.project_store import ProjectStore  # noqa: E402
from tests.conftest import PERSON  # noqa: E402
from tests.test_project_catalog_restore_fix2 import _add_text, _create, _rev, _values, app  # noqa: E402,F401
from tests.test_project_catalog_restore_fix3 import _restart  # noqa: E402
from tests.test_project_catalog_restore_fix5 import (  # noqa: E402
    ONLY_W, _free_a_slot, _held, _held_values, _live_values, _make_room_without_listing, _projects_holding, _waiting,
)
from tests.test_project_catalog_restore_fix6 import _png  # noqa: E402

CODEX = {**PERSON, "X-Nebula-Agent": "Codex"}
_real_commit_prepared = ProjectStore.commit_prepared


def _events(change: str) -> list[dict]:
    sent = main_module.manager.broadcast_raw
    return [call.args[0] for call in sent.call_args_list
            if call.args and call.args[0].get("type") == "projectsChanged" and call.args[0].get("change") == change]


# -- M-1: an agent's write before the first listing after a restore -------------------


def _restored_with_the_open_project_gone(client, store, state, monkeypatch, limit: int) -> None:
    """Review 7's F10: Delta open with the person's nodes, catalog.json
    zeroed, its .bak from before Delta, then a restart. No listing since."""
    monkeypatch.setattr(store_module, "MAX_PROJECTS", 4)
    for name in ("A", "B", "C"):
        _create(client, name)
    client.get("/api/projects", headers=PERSON)
    older = store.path.read_bytes()
    _create(client, "Delta")
    _add_text(client, "delta-1")
    _add_text(client, ONLY_W)
    client.get("/api/projects", headers=PERSON)
    monkeypatch.setattr(store_module, "MAX_PROJECTS", limit)
    with open(store.path, "r+b") as handle:
        handle.write(b"\0" * store.path.stat().st_size)
    store.backup_path.write_bytes(older)
    store.older_backup_path.unlink(missing_ok=True)
    _restart(monkeypatch, state, store)
    assert main_module._canvas_not_filed_now() is None  # no settle has run


def _agent_first_write(client, how: str) -> list[int]:
    nodes = list(main_module.cli_graph.nodes)
    if how == "apply-remove-all":
        return [client.post("/api/graph/apply", headers=CODEX, json={"note": "fresh", "remove": nodes, "nodes": [
            {"ref": "+a", "definitionId": "text-input", "params": {"value": "codex-scratch"}}]}).status_code]
    if how == "delete-nodes":
        return [client.request("DELETE", f"/api/graph/node/{node}", headers=CODEX).status_code for node in nodes]
    if how == "clear":
        return [client.request("DELETE", "/api/graph?force=true", headers=CODEX).status_code]
    raise AssertionError(how)


@pytest.mark.parametrize("how", ["apply-remove-all", "delete-nodes", "clear"])
def test_m1_at_the_limit_an_agents_first_write_after_a_restore_is_refused(app, monkeypatch, how):
    client, store, _graph, state = app
    _restored_with_the_open_project_gone(client, store, state, monkeypatch, limit=3)
    before = _live_values(main_module.cli_graph)
    assert ONLY_W in before
    statuses = _agent_first_write(client, how)
    assert statuses and all(status == 409 for status in statuses), statuses
    assert _live_values(main_module.cli_graph) == before
    assert main_module._canvas_not_filed_now()["reason"] == "projects"
    listing = client.get("/api/projects", headers=PERSON).json()
    assert listing["canvasNotFiled"]["live"] is True
    catalog = json.loads(store.path.read_text())
    _free_a_slot(client, next(iter(catalog["projects"])))
    assert _projects_holding(client, store, ONLY_W) == ["Recovered canvas"]
    assert _projects_holding(client, store, "codex-scratch") == []


def test_m1_the_refusal_after_a_restore_is_codex_s_agent_log_line(app, monkeypatch):
    """GM's answer 1 to review 7: the usual "Codex tried to change the canvas
    you had open…" line, as Codex's row."""
    client, store, _graph, state = app
    _restored_with_the_open_project_gone(client, store, state, monkeypatch, limit=3)
    main_module.manager.broadcast_raw.reset_mock()
    response = client.post("/api/graph/node", headers=CODEX, json={"definitionId": "text-input", "params": {"value": "x"}})
    assert response.status_code == 409 and response.json()["code"] == main_module.CANVAS_WAITING_CODE
    assert response.json()["detail"] == main_module.CANVAS_CHANGE_REFUSAL
    refused = _events("canvasHoldRefused")
    assert len(refused) == 1 and refused[0]["canvasHeld"]["agent"] == "Codex"
    assert refused[0]["canvasHeld"]["action"] == "change"


def test_m1_below_the_limit_the_persons_canvas_is_saved_first_then_the_write_goes_on(app, monkeypatch):
    """Room for the canvas: the guard files the person's canvas untouched as
    its own project, never opened, and the agent's write goes on a copy (GM's
    rule (a), fix round 8, replacing "lands on it"); the agent's own undo
    works on the copy and never reaches the filed project."""
    client, store, _graph, state = app
    _restored_with_the_open_project_gone(client, store, state, monkeypatch, limit=5)
    before = _live_values(main_module.cli_graph)
    main_module.manager.broadcast_raw.reset_mock()
    nodes = list(main_module.cli_graph.nodes)
    applied = client.post("/api/graph/apply", headers=CODEX, json={"note": "fresh", "remove": nodes, "nodes": [
        {"ref": "+a", "definitionId": "text-input", "params": {"value": "codex-scratch"}}]})
    assert applied.status_code == 200, applied.text
    filed = _events("canvasFiled")
    assert len(filed) == 1
    restore = client.get("/api/projects", headers=PERSON).json()["catalogRestore"]
    assert restore["recoveredCanvas"]["id"] == filed[0]["projectId"]
    undone = client.post("/api/graph/apply/undo", headers=CODEX, json={"token": applied.json()["undo"]["token"]})
    assert undone.status_code == 200, undone.text
    client.get("/api/projects", headers=PERSON)
    catalog = json.loads(store.path.read_text())
    original = catalog["projects"][filed[0]["projectId"]]
    assert sorted(_values(original)) == sorted(before)
    assert _projects_holding(client, store, "codex-scratch") == []


def test_m1_mcp_and_the_cli_say_the_refusal_after_a_restore(app, monkeypatch, capsys):
    client, store, _graph, state = app
    _restored_with_the_open_project_gone(client, store, state, monkeypatch, limit=3)
    monkeypatch.setattr(mcp_server, "_api", lambda: NebulaAPI("http://testserver", client=client))
    monkeypatch.setenv("NEBULA_AGENT_NAME", "Codex")
    with pytest.raises(Exception) as raised:
        asyncio.run(mcp_server.mcp.call_tool("remove_from_canvas", {"node_ids": list(main_module.cli_graph.nodes)}))
    assert main_module.CANVAS_CHANGE_REFUSAL in str(raised.value) and "(409, canvas_waiting)" in str(raised.value)
    assert ONLY_W in _live_values(main_module.cli_graph)


def test_n4_a_restore_between_the_fence_and_the_write_is_caught_in_the_write_step(app, monkeypatch):
    """The upload passes the fence on a settled canvas; while the route
    reads the file the open project goes from the list (as a restore leaves
    it). The write step's guard settles it and refuses at the limit."""
    client, store, graph, state = app
    monkeypatch.setattr(store_module, "MAX_PROJECTS", 3)
    for name in ("A", "B", "C"):
        _create(client, name)
    _add_text(client, ONLY_W)
    client.get("/api/projects", headers=PERSON)
    real = main_module._sniff_image_type

    def restore_lands(head):
        graph.owner = "e" * 32  # the open project isn't in the list any more
        main_module._forget_canvas_waiting_cache()
        return real(head)
    monkeypatch.setattr(main_module, "_sniff_image_type", restore_lands)
    response = client.post("/api/uploads", headers=CODEX, files={"file": ("a.png", _png(), "image/png")},
                           data={"create_node": "true"})
    assert response.status_code == 409, response.text
    assert response.json()["code"] == main_module.CANVAS_WAITING_CODE
    assert _live_values(graph) == ["None", ONLY_W] or ONLY_W in _live_values(graph)
    assert not any(node.get("definitionId") == "image-input" for node in graph.nodes.values())


# -- N-3: no unmarked route reaches a cli_graph mutation ---------------------------------

# Review 7's static scan (probes/mutators.py), as a test: every HTTP route in
# main.py whose body reaches (through main.py's own functions) a call that
# changes cli_graph must be marked graph_write, or listed here with why the
# waiting-canvas guard doesn't need to see it.
_MUTATORS = {"add_node", "connect", "update_params", "set_params", "set_label", "update_positions", "remove_node",
             "remove_edge", "clear", "replace_with", "load", "_save_state", "save", "_maybe_persist"}
_UNMARKED_ALLOWED = {
    "websocket_endpoint": "the socket accepts only hello; it reads the graph for its first sync",
    "withdraw_canvas_proposal": "withdraws a proposal; never changes the canvas",
    "accept_canvas_proposal": "the person's accept only (person-gated), as the person's own write",
    "create_asset_proposal": "stages a proposal; changes nothing until the person accepts",
    "create_canvas_proposal": "stages a proposal; changes nothing until the person accepts",
    "accept_asset_proposal": "the person's accept only (person-gated)",
    "reject_asset_proposal": "rejects a proposal; never changes the canvas",
    "cancel_execution": "stops a run; the graph sync it sends only reads",
    "acknowledge_execution_cancellation": "clears a run's cancellation record; reads the graph",
    "acknowledge_provider_start_ambiguity": "clears a paid start's record; reads the graph",
    "create_saved_project": "settles and holds the waiting canvas itself (_hold_if_waiting)",
    "open_saved_project": "settles and holds the waiting canvas itself (_hold_if_waiting)",
    "save_project": "a tab's save of the open project, fenced by its revision (404/409 while one waits)",
    "pin_project_cover": "a project's cover only",
    "delete_saved_project": "settles the canvas itself before it deletes",
}


def _unmarked_mutating_routes() -> set[str]:
    tree = ast.parse(Path(main_module.__file__).read_text(encoding="utf-8"))
    functions: dict[str, ast.AST] = {}
    for node in ast.walk(tree):
        if isinstance(node, (ast.FunctionDef, ast.AsyncFunctionDef)):
            functions.setdefault(node.name, node)
    direct: dict[str, bool] = {}
    calls: dict[str, set[str]] = {}
    for name, function in functions.items():
        mutates, called = False, set()
        for item in ast.walk(function):
            if isinstance(item, ast.Call):
                target = item.func
                if isinstance(target, ast.Attribute) and isinstance(target.value, ast.Name) \
                        and target.value.id == "cli_graph" and target.attr in _MUTATORS:
                    mutates = True
                if isinstance(target, ast.Attribute) and target.attr in {"append", "pop", "update", "clear", "remove",
                                                                         "extend", "setdefault"}:
                    if ast.unparse(target.value).startswith(("cli_graph.nodes", "cli_graph.edges")):
                        mutates = True
                if isinstance(target, ast.Name) and target.id in functions:
                    called.add(target.id)
            if isinstance(item, (ast.Assign, ast.AugAssign)):
                for written in (item.targets if isinstance(item, ast.Assign) else [item.target]):
                    if ast.unparse(written).startswith("cli_graph."):
                        mutates = True
            if isinstance(item, ast.Delete) and any(ast.unparse(t).startswith("cli_graph") for t in item.targets):
                mutates = True
        direct[name], calls[name] = mutates, called
    memo: dict[str, bool] = {}

    def reaches(name: str, stack: tuple[str, ...] = ()) -> bool:
        if name in memo:
            return memo[name]
        if name in stack:
            return False
        found = direct.get(name, False) or any(reaches(call, (*stack, name)) for call in calls.get(name, ()))
        memo[name] = found
        return found

    unmarked = set()
    for name, function in functions.items():
        decorators = [ast.unparse(decorator) for decorator in function.decorator_list]
        if not any(re.match(r"(app|router)\.(post|put|delete|patch|websocket|api_route)", d) for d in decorators):
            continue
        if any(d.startswith("graph_write") for d in decorators):
            continue
        if reaches(name):
            unmarked.add(name)
    return unmarked


def test_n3_every_route_that_can_change_the_graph_is_marked_or_says_why():
    unmarked = _unmarked_mutating_routes()
    assert unmarked, "the scan finds the known unmarked routes (it reads main.py)"
    assert unmarked <= set(_UNMARKED_ALLOWED), sorted(unmarked - set(_UNMARKED_ALLOWED))


# -- M-2 / N-6: a held canvas's items, and filing each on its own ----------------------


def _held_one(client, store, graph, state, monkeypatch) -> list[str]:
    ids = _waiting(client, store, graph, state, monkeypatch)
    opened = client.post(f"/api/projects/{ids[1]}/open", headers=PERSON, json={"workspaceRevision": _rev(client)})
    assert opened.status_code == 200, opened.text
    assert len(_held(store)) == 1
    return ids


def _held_file(store) -> tuple[Path, Path]:
    (project_id,) = store._held_ids_on_disk()
    return store.held_paths(project_id)


@pytest.mark.parametrize("flip", [("\"id\"", "\"hd\""), ("\"id\"", "\"ad\"")])
def test_m2_a_flip_in_the_main_copy_loses_to_the_bak_and_the_listing_works(app, monkeypatch, flip):
    client, store, graph, state = app
    ids = _held_one(client, store, graph, state, monkeypatch)
    main_copy, _backup = _held_file(store)
    text = main_copy.read_text()
    first_node = text.index("\"nodes\":[{") + len("\"nodes\":[{")
    main_copy.write_text(text[:first_node] + text[first_node:].replace(flip[0], flip[1], 1))
    _restart(monkeypatch, state, store)
    for _ in range(2):
        listing = client.get("/api/projects", headers=PERSON)
        assert listing.status_code == 200
        assert "canvasHeldUnreadable" not in listing.json()
    _free_a_slot(client, ids[0])
    assert _projects_holding(client, store, ONLY_W) == ["Recovered canvas"]


def test_m2_a_flip_that_still_parses_loses_to_the_bak_by_its_check(app, monkeypatch):
    client, store, graph, state = app
    ids = _held_one(client, store, graph, state, monkeypatch)
    main_copy, _backup = _held_file(store)
    main_copy.write_text(main_copy.read_text().replace(ONLY_W, ONLY_W[:-1] + "X", 1))
    _restart(monkeypatch, state, store)
    _free_a_slot(client, ids[0])
    assert _projects_holding(client, store, ONLY_W) == ["Recovered canvas"]


@pytest.mark.parametrize("damage", ["node-no-id", "node-id-int", "node-int", "node-data-str", "edge-no-source"])
def test_m2_n6_typed_damage_in_both_copies_is_said_and_never_fails_a_listing(app, monkeypatch, damage):
    client, store, graph, state = app
    ids = _held_one(client, store, graph, state, monkeypatch)
    for path in _held_file(store):
        body = json.loads(path.read_text())
        nodes = body["entry"]["nodes"]
        if damage == "node-no-id":
            nodes[0].pop("id")
        elif damage == "node-id-int":
            nodes[0]["id"] = 7
        elif damage == "node-int":
            nodes.append(5)
        elif damage == "node-data-str":
            nodes[0]["data"] = "x"
        else:
            body["entry"]["edges"] = [{"id": "e1", "target": nodes[0]["id"]}]
        body["check"] = store_module.held_entry_check(body["entry"])
        path.write_text(json.dumps(body))
    _restart(monkeypatch, state, store)
    listing = client.get("/api/projects", headers=PERSON)
    assert listing.status_code == 200
    assert listing.json()["canvasHeldUnreadable"]["count"] == 1
    after = _free_a_slot(client, ids[0])
    assert after["canvasHeldUnreadable"]["count"] == 1
    assert _projects_holding(client, store, ONLY_W) == []
    catalog = json.loads(store.path.read_text())
    for project in catalog["projects"].values():
        assert all(isinstance(node, dict) and isinstance(node.get("id"), str) for node in project["snapshot"]["nodes"])
    assert sorted(store.held_dir.glob("*.damaged-*"))  # both copies kept as they were


def test_m2_a_canvas_that_cant_be_filed_is_set_aside_and_the_others_are_saved(app, monkeypatch):
    client, store, graph, state = app
    ids = _held_one(client, store, graph, state, monkeypatch)
    good = _held(store)[0]
    other = {**good, "projectId": "f" * 32, "digest": "other", "heldAt": "2026-10-28T00:00:01+00:00"}
    main_module._add_held(other)
    real = main_module.make_project

    def make_project(name, snapshot):
        if any((node.get("data") or {}).get("params", {}).get("value") == ONLY_W for node in snapshot["nodes"]) \
                and make_project.calls == 0:
            make_project.calls += 1
            raise ValueError("boom")
        return real(name, snapshot)
    make_project.calls = 0
    monkeypatch.setattr(main_module, "make_project", make_project)
    monkeypatch.setattr(store_module, "MAX_PROJECTS", 5)
    listing = client.get("/api/projects", headers=PERSON)
    assert listing.status_code == 200, listing.text
    assert listing.json()["canvasHeldUnreadable"]["count"] == 1
    assert [entry["projectId"] for entry in _held(store)] == []
    assert sorted(store.held_dir.glob(f"{good['projectId']}.json*.unfileable-*"))
    assert len(_projects_holding(client, store, ONLY_W)) == 1  # the other copy, filed
    assert ids


# -- L-1: held once, filed once, named once ---------------------------------------------


def _fail_open(client, monkeypatch, project_id):
    real_save = CLIGraph.save
    calls = {"n": 0}

    def save(self, path, *args, **kwargs):
        calls["n"] += 1
        if calls["n"] >= 2:
            raise OSError("disk went away")
        return real_save(self, path, *args, **kwargs)

    def boom(self, temporary):
        raise OSError("rename failed")
    monkeypatch.setattr(ProjectStore, "commit_prepared", boom)
    monkeypatch.setattr(CLIGraph, "save", save)
    try:
        return client.post(f"/api/projects/{project_id}/open", headers=PERSON, json={"workspaceRevision": _rev(client)})
    finally:
        monkeypatch.setattr(ProjectStore, "commit_prepared", _real_commit_prepared)
        monkeypatch.setattr(CLIGraph, "save", real_save)


def test_l1_failed_opens_hold_the_canvas_once_and_it_is_filed_once(app, monkeypatch):
    client, store, graph, state = app
    ids = _waiting(client, store, graph, state, monkeypatch)
    for _ in range(3):
        assert _fail_open(client, monkeypatch, ids[1]).status_code == 507
    assert len(_held(store)) == 1
    waiting = client.get("/api/projects", headers=PERSON).json()["canvasNotFiled"]
    assert waiting["live"] is True and waiting["held"] == 0  # one canvas, said once
    assert len(waiting["canvases"]) == 1
    after = _free_a_slot(client, ids[0])
    assert "canvasNotFiled" not in after  # never "isn't saved as a project yet" once it is
    assert [row["name"] for row in after["canvasSaved"]["filed"]] == ["Recovered canvas"]
    assert _held(store) == []
    catalog = json.loads(store.path.read_text())
    other = next(pid for pid in catalog["projects"] if pid != catalog["activeProjectId"])
    _free_a_slot(client, other)
    assert _projects_holding(client, store, ONLY_W) == ["Recovered canvas"]  # one project, never two
    assert after.get("restoreRoom") is None or after["restoreRoom"]["waiting"] == 0


# -- L-3: one file per canvas, no shared cap, agents capped like a project --------------


def test_l3_the_persons_open_always_holds_even_past_a_projects_size(app, monkeypatch):
    client, store, graph, state = app
    ids = _waiting(client, store, graph, state, monkeypatch)
    monkeypatch.setattr(main_module, "MAX_PROJECT_BYTES", 200)
    opened = client.post(f"/api/projects/{ids[1]}/open", headers=PERSON, json={"workspaceRevision": _rev(client)})
    assert opened.status_code == 200, opened.text
    assert len(_held(store)) == 1
    created = client.post("/api/projects", headers=PERSON, json={"name": "New", "workspaceRevision": _rev(client)})
    assert created.status_code != 409 or created.json().get("code") != main_module.CANVAS_HELD_FULL_CODE
    # Filed over the save limit: the saved line's marker (GM).
    after = _free_a_slot(client, ids[0])
    rows = after["canvasSaved"]["filed"]
    assert rows[0]["overSaveLimit"] is True and after["canvasSaved"]["overSaveLimit"] is True
    assert _projects_holding(client, store, ONLY_W) == ["Recovered canvas"]


@pytest.mark.parametrize("route", ["clear", "load"])
def test_l3_the_persons_clear_or_load_below_the_limit_always_holds(app, monkeypatch, route):
    client, store, graph, state = app
    ids = _waiting(client, store, graph, state, monkeypatch)
    _make_room_without_listing(client, store, ids[0])
    monkeypatch.setattr(main_module, "MAX_PROJECT_BYTES", 200)
    headers = PERSON
    if route == "clear":
        response = client.request("DELETE", "/api/graph?force=true", headers=headers)
    else:
        response = client.post("/api/graph/import", headers=headers, json={"nodes": [], "edges": []})
    assert response.status_code == 200, response.text
    assert any(ONLY_W in _held_values(entry) for entry in _held(store))


def test_l3_an_agents_write_past_a_projects_size_is_refused_with_gms_line(app, monkeypatch):
    client, store, graph, state = app
    ids = _waiting(client, store, graph, state, monkeypatch)
    _make_room_without_listing(client, store, ids[0])
    monkeypatch.setattr(main_module, "MAX_PROJECT_BYTES", 200)
    before = _live_values(graph)
    refused = client.post("/api/graph/node", headers=CODEX, json={"definitionId": "text-input", "params": {"value": "q"}})
    assert refused.status_code == 409, refused.text
    body = refused.json()
    assert body["code"] == main_module.CANVAS_HELD_FULL_CODE and body["limitBytes"] == 200
    assert body["detail"] == ("This canvas is too big for Nebula to keep aside, so nothing was changed. Work in an "
                              "existing project, or make the canvas smaller first.")
    assert _live_values(graph) == before and _held(store) == []
    monkeypatch.setattr(mcp_server, "_api", lambda: NebulaAPI("http://testserver", client=client))
    monkeypatch.setenv("NEBULA_AGENT_NAME", "Codex")
    with pytest.raises(Exception) as raised:
        asyncio.run(mcp_server.mcp.call_tool("remove_from_canvas", {"node_ids": list(graph.nodes)[:1]}))
    assert body["detail"] in str(raised.value) and "(409, canvas_held_full)" in str(raised.value)


def test_l3_the_shared_cap_is_gone():
    assert not hasattr(store_module, "CANVAS_HELD_MAX_BYTES")
    assert not hasattr(main_module, "CANVAS_HELD_FULL_DETAIL")


def test_l3_each_canvas_has_its_own_two_copies(app, monkeypatch):
    client, store, graph, state = app
    _held_one(client, store, graph, state, monkeypatch)
    main_copy, backup = _held_file(store)
    assert main_copy.read_bytes() == backup.read_bytes()
    body = json.loads(main_copy.read_text())
    assert body["version"] == 2 and body["check"] == store_module.held_entry_check(body["entry"])
    assert not (store.root / store_module.CANVAS_HELD_NAME).exists()


def _legacy(store, entries, *, note=None) -> bytes:
    body = {"version": 1, "held": entries, **({"unreadable": note} if note else {})}
    encoded = json.dumps(body, separators=(",", ":")).encode("utf-8")
    for name in (store_module.CANVAS_HELD_NAME, store_module.CANVAS_HELD_BACKUP_NAME):
        (store.root / name).write_bytes(encoded)
    return encoded


def _two_legacy(client, store, graph, state, monkeypatch) -> tuple[list[str], list[dict]]:
    ids = _held_one(client, store, graph, state, monkeypatch)
    good = _held(store)[0]
    other = {**good, "projectId": "f" * 32, "digest": "other", "heldAt": "2099-01-01T00:00:00+00:00"}
    import shutil
    shutil.rmtree(store.root / "canvas-held", ignore_errors=True)
    return ids, [good, other]


def test_l3_the_old_held_file_moves_in_once_and_is_kept_aside(app, monkeypatch):
    client, store, graph, state = app
    ids, entries = _two_legacy(client, store, graph, state, monkeypatch)
    old = _legacy(store, entries)
    _restart(monkeypatch, state, store)
    assert [entry["projectId"] for entry in _held(store)] == [entries[0]["projectId"], "f" * 32]
    assert store._held_ids_on_disk() == {entries[0]["projectId"], "f" * 32}
    assert not (store.root / store_module.CANVAS_HELD_NAME).exists()
    migrated = sorted(store.root.glob(f"{store_module.CANVAS_HELD_NAME}*.migrated-*"))
    assert len(migrated) == 2 and all(path.read_bytes() == old for path in migrated)
    _restart(monkeypatch, state, store)
    assert len(_held(store)) == 2
    monkeypatch.setattr(store_module, "MAX_PROJECTS", 5)
    client.get("/api/projects", headers=PERSON)
    assert len(_projects_holding(client, store, ONLY_W)) == 2  # each its own project, once
    assert ids


@pytest.mark.parametrize("crash", ["after-first-canvas", "before-keeping-aside"])
def test_l3_a_crash_midway_through_the_move_loses_nothing_and_files_nothing_twice(app, monkeypatch, crash):
    client, store, graph, state = app
    _ids, entries = _two_legacy(client, store, graph, state, monkeypatch)
    _legacy(store, entries)
    _restart(monkeypatch, state, store)
    if crash == "after-first-canvas":
        real = ProjectStore._write_held_pair

        def write(self, entry):
            if entry["projectId"] == "f" * 32:
                raise OSError("power lost")
            return real(self, entry)
        monkeypatch.setattr(ProjectStore, "_write_held_pair", write)
        held = store.canvas_held()
        # The one it couldn't write stays in memory, and in the old file.
        assert {entry["projectId"] for entry in held} == {entries[0]["projectId"], "f" * 32}
        assert store._held_ids_on_disk() == {entries[0]["projectId"]}
        assert (store.root / store_module.CANVAS_HELD_NAME).exists()
        monkeypatch.setattr(ProjectStore, "_write_held_pair", real)
    else:
        real_replace = store_module.os.replace

        def replace(src, dst, *args, **kwargs):
            if ".migrated-" in str(dst):
                raise OSError("power lost")
            return real_replace(src, dst, *args, **kwargs)
        monkeypatch.setattr(store_module.os, "replace", replace)
        store.canvas_held()
        monkeypatch.setattr(store_module.os, "replace", real_replace)
    _restart(monkeypatch, state, store)
    assert sorted(entry["projectId"] for entry in _held(store)) == sorted([entries[0]["projectId"], "f" * 32])
    assert not (store.root / store_module.CANVAS_HELD_NAME).exists()
    monkeypatch.setattr(store_module, "MAX_PROJECTS", 5)
    client.get("/api/projects", headers=PERSON)
    _restart(monkeypatch, state, store)
    client.get("/api/projects", headers=PERSON)
    assert len(_projects_holding(client, store, ONLY_W)) == 2


# -- L-2 / N-1: the old file cut, or one copy's id flipped --------------------------------


def test_l2_both_old_copies_cut_keep_their_complete_leading_entries(app, monkeypatch):
    client, store, graph, state = app
    _ids, entries = _two_legacy(client, store, graph, state, monkeypatch)
    whole = _legacy(store, entries)
    second = whole.index(b'{"projectId":"' + b"f" * 32)
    for name, cut in ((store_module.CANVAS_HELD_NAME, second + 40), (store_module.CANVAS_HELD_BACKUP_NAME, second + 90)):
        (store.root / name).write_bytes(whole[:cut])
    _restart(monkeypatch, state, store)
    listing = client.get("/api/projects", headers=PERSON).json()
    assert [entry["projectId"] for entry in _held(store)] == [entries[0]["projectId"]]
    assert listing["canvasHeldUnreadable"]["count"] is None  # how many were past the cut is unknown: said


def test_n1_an_entry_the_bak_supplies_is_never_said_lost(app, monkeypatch):
    client, store, graph, state = app
    _ids, entries = _two_legacy(client, store, graph, state, monkeypatch)
    _legacy(store, entries)
    main_copy = store.root / store_module.CANVAS_HELD_NAME
    main_copy.write_bytes(main_copy.read_bytes().replace(b'"projectId"', b'"projectYd"', 1))
    _restart(monkeypatch, state, store)
    listing = client.get("/api/projects", headers=PERSON).json()
    assert len(_held(store)) == 2
    assert "canvasHeldUnreadable" not in listing


def test_l1_a_per_canvas_pair_both_cut_costs_only_that_canvas_and_is_said(app, monkeypatch):
    client, store, graph, state = app
    ids = _held_one(client, store, graph, state, monkeypatch)
    good = _held(store)[0]
    main_module._add_held({**good, "projectId": "f" * 32, "digest": "other"})
    for path in store.held_paths(good["projectId"]):
        path.write_bytes(path.read_bytes()[:200])
    _restart(monkeypatch, state, store)
    listing = client.get("/api/projects", headers=PERSON).json()
    assert [entry["projectId"] for entry in _held(store)] == ["f" * 32]
    assert listing["canvasHeldUnreadable"]["count"] == 1
    assert len(sorted(store.held_dir.glob(f"{good['projectId']}.json*.damaged-*"))) == 2
    assert ids


def test_l2_a_damaged_note_still_says_a_canvas_may_be_lost(app, monkeypatch):
    """The note of canvases that may be lost is written whole, but if it is
    damaged on disk later, the person is still told (count unknown), and the
    damaged note is kept aside."""
    client, store, graph, state = app
    _held_one(client, store, graph, state, monkeypatch)
    good = _held(store)[0]
    for path in store.held_paths(good["projectId"]):
        path.write_bytes(path.read_bytes()[:200])
    _restart(monkeypatch, state, store)
    assert client.get("/api/projects", headers=PERSON).json()["canvasHeldUnreadable"]["count"] == 1
    note = store.held_dir / store_module.CANVAS_HELD_NOTE_NAME
    note.write_bytes(note.read_bytes()[:20])
    _restart(monkeypatch, state, store)
    store._held_note = None
    said = client.get("/api/projects", headers=PERSON).json()["canvasHeldUnreadable"]
    assert said["count"] is None
    assert any(".damaged-" in name and store_module.CANVAS_HELD_NOTE_NAME in name for name in said["kept"])
    _restart(monkeypatch, state, store)
    store._held_note = None
    assert client.get("/api/projects", headers=PERSON).json()["canvasHeldUnreadable"]["count"] is None


# -- N-2 / N-5: restoreRoom ---------------------------------------------------------------


def test_n2_restore_room_counts_the_canvases_filed_along_the_way(app, monkeypatch):
    """Review 7's case: the live canvas and two held at a limit of 3. The
    deletes the listing says, done for real, let a restore through, and one
    fewer doesn't."""
    client, store, graph, state = app
    ids = _held_one(client, store, graph, state, monkeypatch)
    good = _held(store)[0]
    main_module._add_held({**good, "projectId": "f" * 32, "digest": "other"})
    catalog = json.loads(store.path.read_text())
    assert len(catalog["projects"]) == 3
    # The live canvas waits again (a canvas from a project the list lacks).
    _add_text(client, "b-node")
    graph.owner = "d" * 32
    graph.save(state)
    listing = client.get("/api/projects", headers=PERSON).json()
    room = listing["restoreRoom"]
    assert room["waiting"] == 3 and isinstance(room["deletes"], int)
    deletes = room["deletes"]
    trashed = []
    for _ in range(deletes):
        catalog = json.loads(store.path.read_text())
        victim = next(pid for pid in catalog["projects"] if pid != catalog["activeProjectId"]) \
            if len(catalog["projects"]) > 1 else next(iter(catalog["projects"]))
        trashed.append(victim)
        _free_a_slot(client, victim)
        if len(trashed) == deletes - 1:
            refused = client.post(f"/api/projects/{trashed[0]}/restore", headers=PERSON)
            assert refused.status_code == 413, refused.text
    restored = client.post(f"/api/projects/{trashed[0]}/restore", headers=PERSON)
    assert restored.status_code == 200, restored.text
    assert ids


def test_n5_restore_room_measures_each_canvas_once(app, monkeypatch):
    client, store, graph, state = app
    _held_one(client, store, graph, state, monkeypatch)
    good = _held(store)[0]
    for n in range(4):
        main_module._add_held({**good, "projectId": f"{n:x}" * 32, "digest": f"other{n}"})
    catalog = store.read()
    calls = {"n": 0}
    real = main_module.json.dumps

    def counted(*args, **kwargs):
        calls["n"] += 1
        return real(*args, **kwargs)
    monkeypatch.setattr(main_module.json, "dumps", counted)
    room = main_module._restore_room(catalog)
    monkeypatch.setattr(main_module.json, "dumps", real)
    assert room is not None
    assert calls["n"] <= 5 + 2  # one per held canvas (and the digest), not one per canvas per delete


# -- GM answer 7: the person's own clear and load ----------------------------------------


@pytest.mark.parametrize("route", ["clear", "load"])
def test_gm7_the_persons_own_clear_or_load_at_the_limit_says_why_and_the_way_out(app, monkeypatch, route):
    client, store, graph, state = app
    _waiting(client, store, graph, state, monkeypatch)
    if route == "clear":
        response = client.request("DELETE", "/api/graph?force=true", headers=PERSON)
    else:
        response = client.post("/api/graph/import", headers=PERSON, json={"nodes": [], "edges": []})
    assert response.status_code == 409
    body = response.json()
    assert body["code"] == "canvas_waiting" and body["audience"] == "person"
    assert body["detail"] == ("It isn't saved as a project yet because you've reached the limit of 3 projects. "
                              "Delete a project and Nebula will save it, or open an existing project to work in.")
    agent = client.request("DELETE", "/api/graph?force=true", headers=CODEX)
    assert agent.json()["detail"] == main_module.CANVAS_WAITING_REFUSAL and "audience" not in agent.json()


def test_gm7_the_size_cap_forms():
    assert main_module.canvas_waiting_person_reason("storage", trash_has_items=True) == (
        "It isn't saved as a project yet because Nebula's project list is full. Permanently delete a project in "
        "Recently deleted and Nebula will save it, or open an existing project to work in.")
    # GM r9 (3), fix round 8: the empty-Recently-deleted form, verbatim.
    assert main_module.canvas_waiting_person_reason("storage", trash_has_items=False) == (
        "It isn't saved as a project yet because Nebula's project list is full. Delete a project, then remove it "
        "from Recently deleted too, and Nebula will save it. You can also open an existing project to work in.")
