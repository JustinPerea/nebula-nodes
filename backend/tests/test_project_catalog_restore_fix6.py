"""PR #199 review 6: what fix round 6 makes true (2026-10-28).

- M-1. One guard at the graph-write fence covers every agent write while
  the live canvas waits to be saved as a project: at the limit refused (409
  ``canvas_waiting``, GM's line), below it the canvas is held aside first.
  The person's own writes pass. Every route marked ``graph_write`` goes
  through it, checked by sending each one a request (N-6).
- L-1. canvas-held.json is read entry by entry; a damaged copy is kept aside
  before anything rewrites it, and a canvas that may be lost is said.
- L-2. A failed open never gives its hold back, even when its rollback
  failed too; the digest check drops a copy only while state.json is that
  canvas too.
- L-3. The listing carries the backend's own restore verdict, held canvases
  counted, and how many deletes really free a place (GM's answer 3).
- L-5. A commit number carries a CRC (``commitCheck``): a flipped digit is
  unproven and never outranks the side file.
- N-1 / N-2 / N-3 / N-5: the agents' "room now" note, every canvas named,
  the Agent log row's agent, the held file's cap.
"""
from __future__ import annotations

import asyncio
import json
import re
import struct
import sys
import zlib
from pathlib import Path

import pytest
from fastapi.routing import APIRoute

sys.path.insert(0, str(Path(__file__).resolve().parent.parent))
import main as main_module  # noqa: E402
import mcp_server  # noqa: E402
from nebula_api import NebulaAPI  # noqa: E402
from services import catalog_recovery  # noqa: E402
from services import project_store as store_module  # noqa: E402
from services.cli_graph import CLIGraph  # noqa: E402
from services.project_store import ProjectStore  # noqa: E402
from tests.conftest import PERSON  # noqa: E402
from tests.test_project_catalog_restore_fix2 import _rev, app  # noqa: E402,F401
from tests.test_project_catalog_restore_fix3 import _restart  # noqa: E402
from tests.test_project_catalog_restore_fix5 import (  # noqa: E402
    AGENT, ONLY_W, _free_a_slot, _held, _held_values, _live_values, _make_room_without_listing, _projects_holding,
    _purge, _purge_setup, _record, _side, _waiting, _where, _zero,
)

CODEX = {**PERSON, "X-Nebula-Agent": "Codex"}
_real_commit_prepared = ProjectStore.commit_prepared


def _events(change: str) -> list[dict]:
    sent = main_module.manager.broadcast_raw
    return [call.args[0] for call in sent.call_args_list
            if call.args and call.args[0].get("type") == "projectsChanged" and call.args[0].get("change") == change]


def _png() -> bytes:
    def chunk(kind: bytes, data: bytes) -> bytes:
        return struct.pack(">I", len(data)) + kind + data + struct.pack(">I", zlib.crc32(kind + data))
    raw = b"\x00\xff\x00\x00"
    return (b"\x89PNG\r\n\x1a\n" + chunk(b"IHDR", struct.pack(">IIBBBBB", 1, 1, 8, 2, 0, 0, 0))
            + chunk(b"IDAT", zlib.compress(raw)) + chunk(b"IEND", b""))


# -- M-1: every agent write while the canvas waits -----------------------------------


def _agent_writes(graph) -> dict[str, tuple[str, str, dict]]:
    node_ids = list(graph.nodes)
    edge = {"source": node_ids[0], "sourceHandle": "text", "target": node_ids[-1], "targetHandle": "text"}
    return {
        "delete a node": ("DELETE", f"/api/graph/node/{node_ids[0]}", {}),
        "apply with remove": ("POST", "/api/graph/apply", {"json": {"note": "tidy", "remove": node_ids,
                                                                    "nodes": [{"ref": "+n", "definitionId": "text-input",
                                                                               "params": {"value": "codex-scratch"}}]}}),
        "restore with remove": ("POST", "/api/graph/restore", {"json": {
            "action": "undo", "remove": node_ids,
            "nodes": [{"id": "n9", "definitionId": "text-input", "params": {"value": "restored-by-agent"}}]}}),
        "add a node": ("POST", "/api/graph/node", {"json": {"definitionId": "text-input", "params": {"value": "added"}}}),
        "delete a wire": ("DELETE", "/api/graph/edge", {"json": edge}),
        "clear": ("DELETE", "/api/graph?force=true", {}),
        "load": ("POST", "/api/graph/import", {"json": {"nodes": [{"id": "x1", "definitionId": "text-input",
                                                                   "params": {"value": "imported"}}], "edges": []}}),
    }


@pytest.mark.parametrize("write", ["delete a node", "apply with remove", "restore with remove", "add a node",
                                   "delete a wire", "clear", "load"])
def test_m1_at_the_limit_every_agent_write_to_the_waiting_canvas_is_refused(app, monkeypatch, write):
    client, store, graph, state = app
    _waiting(client, store, graph, state, monkeypatch)
    before = _live_values(graph)
    method, path, kwargs = _agent_writes(graph)[write]
    main_module.manager.broadcast_raw.reset_mock()
    response = client.request(method, path, headers=CODEX, **kwargs)
    assert response.status_code == 409, response.text
    body = response.json()
    assert body["code"] == "canvas_waiting" and body["reason"] == "projects"
    if write in ("clear", "load"):
        assert body["detail"] == main_module.CANVAS_WAITING_REFUSAL
    else:
        assert body["detail"] == main_module.CANVAS_CHANGE_REFUSAL
        assert body["action"] == "change"
    assert _live_values(graph) == before and _held(store) == []
    assert client.get("/api/projects", headers=PERSON).json()["canvasNotFiled"]["live"] is True
    (event,) = _events("canvasHoldRefused")
    assert {"agent": "Codex", "agentId": "ext:codex"}.items() <= event["canvasHeld"].items()


def test_m1_gm_lines_verbatim():
    assert main_module.CANVAS_CHANGE_REFUSAL == (
        "The open canvas isn't saved as a project yet because the project limit is reached, so it can't be changed. "
        "Open an existing project to work in, or ask the person to delete a project.")
    assert main_module.CANVAS_CHANGE_REFUSAL_STORAGE.startswith(
        "The open canvas isn't saved as a project yet because Nebula's project list is full, so it can't be changed. ")
    assert main_module.CANVAS_WAITING_REFUSAL_STORAGE == (
        "Nebula's project list is full, so a new canvas can't be saved. Open an existing project to work in, or ask "
        "the person to permanently delete a project in Recently deleted.")


def test_m1_the_reviewers_repro_codex_empties_the_canvas_then_a_slot_frees(app, monkeypatch):
    """Review 6's WAITX: Codex's apply removes every node and adds its own;
    then the person deletes a project. The person's canvas is saved intact,
    and Codex's scratch node is nowhere."""
    client, store, graph, state = app
    ids = _waiting(client, store, graph, state, monkeypatch)
    method, path, kwargs = _agent_writes(graph)["apply with remove"]
    refused = client.request(method, path, headers=CODEX, **kwargs)
    assert refused.status_code == 409 and refused.json()["code"] == "canvas_waiting"
    after = _free_a_slot(client, ids[1])
    assert after["canvasSaved"]["name"] == "Recovered canvas"
    assert _projects_holding(client, store, ONLY_W) == ["Recovered canvas"]
    assert "Recovered canvas" in _projects_holding(client, store, "c1")
    assert _projects_holding(client, store, "codex-scratch") == []


@pytest.mark.parametrize("write", ["delete a node", "apply with remove", "restore with remove", "add a node"])
def test_m1_below_the_limit_an_agent_write_holds_the_canvas_first(app, monkeypatch, write):
    client, store, graph, state = app
    ids = _waiting(client, store, graph, state, monkeypatch)
    _make_room_without_listing(client, store, ids[0])
    method, path, kwargs = _agent_writes(graph)[write]
    main_module.manager.broadcast_raw.reset_mock()
    response = client.request(method, path, headers=CODEX, **kwargs)
    assert response.status_code == 200, response.text
    (held,) = _held(store)
    assert ONLY_W in _held_values(held) and "c1" in _held_values(held)
    (event,) = _events("canvasHeld")
    assert {"action": "changed", "agent": "Codex", "agentId": "ext:codex"}.items() <= event["canvasHeld"].items()
    listing = client.get("/api/projects", headers=PERSON).json()
    assert listing["canvasSaved"]["name"] == "Recovered canvas"
    assert _projects_holding(client, store, ONLY_W) == ["Recovered canvas"]
    for agents in ("codex-scratch", "restored-by-agent", "added"):
        assert _projects_holding(client, store, agents) == []
    assert _held(store) == []


def test_m1_two_agent_writes_at_once_hold_the_canvas_once(app, monkeypatch):
    client, store, graph, state = app
    ids = _waiting(client, store, graph, state, monkeypatch)
    _make_room_without_listing(client, store, ids[0])
    for value in ("one", "two"):
        response = client.post("/api/graph/node", headers=CODEX,
                               json={"definitionId": "text-input", "params": {"value": value}})
        assert response.status_code == 200, response.text
    assert len(_held(store)) == 1


def test_m1_the_persons_own_writes_are_never_blocked(app, monkeypatch):
    client, store, graph, state = app
    _waiting(client, store, graph, state, monkeypatch)
    response = client.post("/api/graph/node", headers=PERSON,
                           json={"definitionId": "text-input", "params": {"value": "the-persons"}})
    assert response.status_code == 200, response.text
    assert "the-persons" in _live_values(graph) and _held(store) == []


def test_m1_a_plain_upload_isnt_a_canvas_write_but_one_that_adds_a_node_is(app, monkeypatch):
    client, store, graph, state = app
    _waiting(client, store, graph, state, monkeypatch)
    plain = client.post("/api/uploads", headers=CODEX, files={"file": ("a.png", _png(), "image/png")})
    assert plain.status_code == 200, plain.text
    adds = client.post("/api/uploads", headers=CODEX, files={"file": ("a.png", _png(), "image/png")},
                       data={"create_node": "true"})
    assert adds.status_code == 409, adds.text
    assert adds.json()["code"] == "canvas_waiting" and adds.json()["detail"] == main_module.CANVAS_CHANGE_REFUSAL


def _fill(path: str) -> str:
    return re.sub(r"\{[^}]+\}", "x", path)


def test_n6_every_graph_write_route_goes_through_the_guard(app, monkeypatch):
    """Review 6, N-6: every route marked graph_write, found from the router
    (so a new one is covered by construction), refuses an agent's request
    with canvas_waiting while the canvas waits at the limit, before its own
    checks run; the canvas stays as it was."""
    client, store, graph, state = app
    _waiting(client, store, graph, state, monkeypatch)
    before = _live_values(graph)
    seen = 0
    for route in main_module.app.router.routes:
        if not isinstance(route, APIRoute):
            continue
        fence = getattr(route.endpoint, main_module.GRAPH_FENCE_ATTR, None)
        if fence is None:
            continue
        if fence == main_module.FENCE_IN_ROUTE:
            # It writes for some requests only: the guard runs in the route's
            # write step (_refuse_tab_write_without_revision), proved for
            # /api/uploads above; each such route must call it.
            source = Path(main_module.__file__).read_text()
            body = source[source.index(f"async def {route.endpoint.__name__}("):]
            body = body[:body.index("\n@app.")]
            assert "_refuse_tab_write_without_revision()" in body, route.path
            continue
        for method in sorted(route.methods - {"GET", "HEAD", "OPTIONS"}):
            response = client.request(method, _fill(route.path), headers=CODEX)
            assert response.status_code == 409 and response.json().get("code") == "canvas_waiting", \
                (method, route.path, response.status_code, response.text[:200])
            seen += 1
    assert seen >= 20  # 26 at fix round 6
    assert _live_values(graph) == before and _held(store) == []


def test_m1_mcp_tools_say_the_refusal_with_its_code(app, monkeypatch):
    client, store, graph, state = app
    _waiting(client, store, graph, state, monkeypatch)
    monkeypatch.setattr(mcp_server, "_api", lambda: NebulaAPI("http://testserver", client=client))
    monkeypatch.setenv("NEBULA_AGENT_NAME", "Codex")
    with pytest.raises(Exception) as raised:
        asyncio.run(mcp_server.mcp.call_tool("remove_from_canvas", {"node_ids": list(graph.nodes)}))
    text = str(raised.value)
    assert main_module.CANVAS_CHANGE_REFUSAL in text and "(409, canvas_waiting)" in text
    assert ONLY_W in _live_values(graph)


# -- L-1 / N-5: canvas-held.json ------------------------------------------------------


def _held_one(client, store, graph, state, monkeypatch) -> list[str]:
    ids = _waiting(client, store, graph, state, monkeypatch)
    opened = client.post(f"/api/projects/{ids[1]}/open", headers=PERSON, json={"workspaceRevision": _rev(client)})
    assert opened.status_code == 200, opened.text
    assert len(store.canvas_held()) == 1
    return ids


def _paths(store):
    return store.root / store_module.CANVAS_HELD_NAME, store.root / store_module.CANVAS_HELD_BACKUP_NAME


def _kept(store) -> list[Path]:
    return sorted(store.root.glob(f"{store_module.CANVAS_HELD_NAME}*.damaged-*"))


def test_l1_both_copies_unreadable_are_kept_aside_and_said(app, monkeypatch):
    client, store, graph, state = app
    ids = _held_one(client, store, graph, state, monkeypatch)
    zeroed = {}
    for path in _paths(store):
        zeroed[path.name] = b"\0" * path.stat().st_size
        path.write_bytes(zeroed[path.name])
    _restart(monkeypatch, state, store)
    listing = client.get("/api/projects", headers=PERSON).json()
    unreadable = listing["canvasHeldUnreadable"]
    assert unreadable["count"] is None and len(unreadable["kept"]) == 2
    assert sorted(path.read_bytes() for path in _kept(store)) == sorted(zeroed.values())
    # The next hold doesn't touch the evidence.
    _free_a_slot(client, ids[0])
    assert sorted(path.read_bytes() for path in _kept(store)) == sorted(zeroed.values())
    assert client.get("/api/projects", headers=PERSON).json()["canvasHeldUnreadable"]["count"] is None


def test_l1_one_entry_with_a_changed_field_type_is_still_saved(app, monkeypatch):
    client, store, graph, state = app
    ids = _held_one(client, store, graph, state, monkeypatch)
    data = json.loads(_paths(store)[0].read_text())
    data["held"][0]["counter"] = float(data["held"][0]["counter"])
    for path in _paths(store):
        path.write_text(json.dumps(data))
    _restart(monkeypatch, state, store)
    listing = client.get("/api/projects", headers=PERSON).json()
    assert listing["canvasNotFiled"]["held"] == 1 and "canvasHeldUnreadable" not in listing
    assert len(_kept(store)) == 2
    _free_a_slot(client, ids[0])
    assert _projects_holding(client, store, ONLY_W) == ["Recovered canvas"]


def test_l1_an_entry_whose_canvas_cant_be_read_is_counted_and_the_others_kept(app, monkeypatch):
    client, store, graph, state = app
    _held_one(client, store, graph, state, monkeypatch)
    data = json.loads(_paths(store)[0].read_text())
    good = dict(data["held"][0])
    lost = {**good, "projectId": "f" * 32, "nodes": "garbled"}
    data["held"] = [good, lost]
    for path in _paths(store):
        path.write_text(json.dumps(data))
    _restart(monkeypatch, state, store)
    kinds: list[str] = []
    real = main_module._journal
    monkeypatch.setattr(main_module, "_journal", lambda kind, **kw: (kinds.append(kind), real(kind, **kw))[1])
    listing = client.get("/api/projects", headers=PERSON).json()
    assert listing["canvasNotFiled"]["held"] == 1
    assert listing["canvasNotFiled"]["heldUnreadable"]["count"] == 1
    assert listing["canvasHeldUnreadable"]["count"] == 1
    assert "project.canvasHeldUnreadable" in kinds
    # Healed on disk: both copies read whole now, the note kept.
    for path in _paths(store):
        healed = json.loads(path.read_text())
        assert [entry["projectId"] for entry in healed["held"]] == [good["projectId"]]
        assert healed["unreadable"]["count"] == 1


def test_l1_main_copy_damaged_and_the_bak_whole_loses_nothing_and_says_nothing(app, monkeypatch):
    client, store, graph, state = app
    ids = _held_one(client, store, graph, state, monkeypatch)
    main_copy = _paths(store)[0]
    main_copy.write_bytes(b"\0" * main_copy.stat().st_size)
    _restart(monkeypatch, state, store)
    listing = client.get("/api/projects", headers=PERSON).json()
    assert listing["canvasNotFiled"]["held"] == 1 and "canvasHeldUnreadable" not in listing
    assert len(_kept(store)) == 1
    _free_a_slot(client, ids[0])
    assert _projects_holding(client, store, ONLY_W) == ["Recovered canvas"]


def test_n5_a_hold_past_the_cap_is_refused_and_changes_nothing(app, monkeypatch):
    client, store, graph, state = app
    ids = _waiting(client, store, graph, state, monkeypatch)
    monkeypatch.setattr(store_module, "CANVAS_HELD_MAX_BYTES", 200)
    response = client.post(f"/api/projects/{ids[1]}/open", headers=PERSON, json={"workspaceRevision": _rev(client)})
    assert response.status_code == 409, response.text
    assert response.json()["code"] == main_module.CANVAS_HELD_FULL_CODE
    assert ONLY_W in _live_values(graph) and _held(store) == []
    assert json.loads(store.path.read_text())["activeProjectId"] is None
    _make_room_without_listing(client, store, ids[0])
    refused = client.post("/api/graph/node", headers=CODEX, json={"definitionId": "text-input", "params": {"value": "x"}})
    assert refused.status_code == 409 and refused.json()["code"] == main_module.CANVAS_HELD_FULL_CODE
    assert "x" not in _live_values(graph)


# -- L-2: a failed open keeps its hold ------------------------------------------------


def test_l2_an_open_whose_rollback_fails_too_keeps_the_hold_and_files_it_after_a_restart(app, monkeypatch):
    """Review 6's H5: the rename fails and so does the rollback's save
    (507): state.json holds B, memory the waiting canvas, the hold is the
    only copy of it on disk. It stays, a listing before the restart doesn't
    drop it (state.json isn't that canvas), and once a slot frees it is saved."""
    client, store, graph, state = app
    ids = _waiting(client, store, graph, state, monkeypatch)
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
    response = client.post(f"/api/projects/{ids[1]}/open", headers=PERSON, json={"workspaceRevision": _rev(client)})
    monkeypatch.setattr(ProjectStore, "commit_prepared", _real_commit_prepared)
    monkeypatch.setattr(CLIGraph, "save", real_save)
    assert response.status_code == 507
    on_disk = CLIGraph()
    on_disk.load(state)
    assert ONLY_W not in _live_values(on_disk) and ONLY_W in _live_values(main_module.cli_graph)
    assert len(_held(store)) == 1
    client.get("/api/projects", headers=PERSON)
    assert len(_held(store)) == 1
    _restart(monkeypatch, state, store)
    client.get("/api/projects", headers=PERSON)
    _free_a_slot(client, ids[0])
    assert _projects_holding(client, store, ONLY_W) == ["Recovered canvas"]


def test_l2_no_hold_is_ever_released_by_name():
    source = Path(main_module.__file__).read_text()
    assert "_release_hold" not in source


# -- L-3: the restore verdict ------------------------------------------------------


def test_l3_a_held_canvas_in_the_last_place_greys_restore_and_one_delete_frees_it(app, monkeypatch):
    """Review 6's H8: the size cap keeps the held canvas held, so the list
    shows 2 of 3 and a restore is refused. The listing says so, and one
    delete really frees a place for the restore (the held canvas can't take
    it: the size cap holds it)."""
    client, store, graph, state = app
    ids = _held_one(client, store, graph, state, monkeypatch)
    monkeypatch.setattr(main_module, "_held_room", lambda *args, **kwargs: "storage")
    listing = _free_a_slot(client, ids[2])
    assert len(listing["projects"]) == 2 and listing["canvasNotFiled"]["held"] == 1
    assert listing["restoreRoom"] == {"refused": "projects", "deletes": 1, "heldTakesPlace": True, "waiting": 1}
    assert client.post(f"/api/projects/{ids[2]}/restore", headers=PERSON).status_code == 413
    _free_a_slot(client, ids[0])
    assert client.post(f"/api/projects/{ids[2]}/restore", headers=PERSON).status_code == 200


def test_l3_when_the_held_canvas_takes_the_freed_place_two_deletes_are_needed(app, monkeypatch):
    """GM's answer 3: at 3 of 3 with a canvas held, the first delete's place
    goes to the held canvas (the next listing saves it there), so the verdict
    says 2, and that is what really happens."""
    client, store, graph, state = app
    ids = _held_one(client, store, graph, state, monkeypatch)
    _make_room_without_listing(client, store, ids[0])
    trashed = ids[0]
    # Fill the place again without a listing: the person makes nothing, an agent can't, so put a project back.
    with store.transaction() as catalog:
        extra = store_module.make_project("D")
        catalog["projects"][extra["id"]] = extra
        store.commit(catalog)
    listing = client.get("/api/projects", headers=PERSON).json()
    assert len(listing["projects"]) == 3 and listing["canvasNotFiled"]["held"] == 1
    assert listing["restoreRoom"]["deletes"] == 2 and listing["restoreRoom"]["heldTakesPlace"] is False
    after = _free_a_slot(client, ids[2])
    assert after["canvasSaved"]["name"] == "Recovered canvas"
    assert len(after["projects"]) == 3
    assert after["restoreRoom"]["deletes"] == 1
    assert client.post(f"/api/projects/{trashed}/restore", headers=PERSON).status_code == 413
    _free_a_slot(client, extra["id"])
    assert client.post(f"/api/projects/{trashed}/restore", headers=PERSON).status_code == 200


def test_l3_no_verdict_below_the_limit(app, monkeypatch):
    client, store, graph, state = app
    monkeypatch.setattr(store_module, "MAX_PROJECTS", 3)
    assert "restoreRoom" not in client.get("/api/projects", headers=PERSON).json()


# -- L-5: a flipped commit digit -----------------------------------------------------


def _flip_digit(path: Path, key: bytes, value: int, to: int) -> None:
    raw = path.read_bytes()
    old = key + b":" + str(value).encode()
    assert old in raw
    path.write_bytes(raw.replace(old, key + b":" + str(to).encode(), 1))


def test_l5_a_flipped_commit_digit_in_bak_never_brings_a_purged_project_back(tmp_path):
    store, _alpha, x = _purge_setup(tmp_path)
    _purge(store, x)
    bak = json.loads(store.backup_path.read_text())
    assert x in bak["trash"] and _side(store)["commit"] > bak["commitSeq"]
    _flip_digit(store.backup_path, b'"commitSeq"', bak["commitSeq"], bak["commitSeq"] ^ 0x04)
    _zero(store)
    fresh = ProjectStore(store.root)
    restored = fresh.read()
    assert _where(restored, x) == "gone"
    assert [row["id"] for row in _record(fresh)["keptDeleted"]] == [x]


def test_l5_a_flipped_commit_digit_in_the_side_file_never_lets_an_older_copy_decide(tmp_path):
    store, _alpha, x = _purge_setup(tmp_path)
    _purge(store, x)
    side = _side(store)
    path = store.root / store_module.PURGED_NAME
    _flip_digit(path, b'"commit"', side["commit"], 1)
    _zero(store)
    restored = ProjectStore(store.root).read()
    assert _where(restored, x) == "gone"


def test_l5_the_control_and_every_commit_carries_its_check(tmp_path):
    store, _alpha, x = _purge_setup(tmp_path)
    _purge(store, x)
    for copy in (store.path, store.backup_path):
        found = json.loads(copy.read_text())
        assert found["commitCheck"] == catalog_recovery.commit_check(found["commitSeq"])
        assert catalog_recovery.proven_commit(found) == found["commitSeq"]
    side = json.loads((store.root / store_module.PURGED_NAME).read_text())
    assert side["commitCheck"] == catalog_recovery.commit_check(side["commit"])
    assert catalog_recovery.proven_commit({"commitSeq": 6, "commitCheck": catalog_recovery.commit_check(2)}) is None
    assert catalog_recovery.proven_commit({"commitSeq": 6}) is None
    _zero(store)
    assert _where(ProjectStore(store.root).read(), x) == "gone"


# -- N-1 / N-2 ---------------------------------------------------------------------


def test_n1_the_room_now_note_says_only_a_listing_saves_them(app, monkeypatch):
    note = main_module._canvas_not_filed_note("projects", room_now=True, live=True, held=1)
    assert "the next listing (the person's Projects home, `nebula projects`, list_projects) saves each" in note
    assert "open or create" not in note
    plain = main_module._canvas_not_filed_note("projects")
    assert "every change to it is refused (409, code canvas_waiting)" in plain


def test_n2_every_waiting_canvas_is_listed_and_one_toast_names_each_filed(app, monkeypatch):
    client, store, graph, state = app
    ids = _held_one(client, store, graph, state, monkeypatch)
    # A second canvas waits: B's canvas loses its project to a restore at the limit.
    graph = main_module.cli_graph
    client.post("/api/graph/node", headers=PERSON, json={"definitionId": "text-input", "params": {"value": "second"}})
    graph.owner = "d" * 32
    graph.save(state)
    waiting = client.get("/api/projects", headers=PERSON).json()["canvasNotFiled"]
    assert waiting["live"] is True and waiting["held"] == 1 and len(waiting["canvases"]) == 2
    _make_room_without_listing(client, store, ids[0])
    _make_room_without_listing(client, store, ids[2])
    saved = client.get("/api/projects", headers=PERSON).json()["canvasSaved"]
    assert sorted(row["name"] for row in saved["filed"]) == ["Recovered canvas", "Recovered canvas 2"]
