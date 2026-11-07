"""PR #199 fix round 8 (review 8 and GM r9, with GM's rule (a)).

HIGH-1 and GM's rule (a): while the person's canvas waits to be saved as a
project, every agent write first files it untouched, never opened, and the
write goes on a new canvas (clear, load) or a copy of it (any other write).
The matrix: every agent route (HTTP, MCP, CLI; clear, load and five edits)
from each way the canvas can be waiting: its slot freed with no listing, a
restore that left it unsettled, and a listing that filed and opened it just
before the agent's write (the load client lists first).
"""
from __future__ import annotations

import asyncio
import json
import sys
from pathlib import Path

import pytest

sys.path.insert(0, str(Path(__file__).resolve().parent.parent))

import graph_file_client  # noqa: E402
import main as main_module  # noqa: E402
import mcp_server  # noqa: E402
from cli.client import NebulaClient  # noqa: E402
from nebula_api import NebulaAPI  # noqa: E402
from services import project_store as store_module  # noqa: E402
from tests.conftest import PERSON  # noqa: E402
from tests.test_project_catalog_restore_fix2 import _add_text, _create, _rev, _values, app  # noqa: E402,F401
from tests.test_project_catalog_restore_fix3 import _restart  # noqa: E402
from tests.test_project_catalog_restore_fix5 import (  # noqa: E402
    ONLY_W, _live_values, _make_room_without_listing, _waiting,
)

CODEX = {**PERSON, "X-Nebula-Agent": "Codex"}
AGENT_LOAD = "agent-load"
AGENT_EDIT = "agent-edit"


def _restored_unsettled(client, store, state, monkeypatch) -> None:
    """Delta (open, holding the person's canvas) is missing from the restored
    .bak; the limit has room (10)."""
    monkeypatch.setattr(store_module, "MAX_PROJECTS", 4)
    for name in ("A", "B", "C"):
        _create(client, name)
    client.get("/api/projects", headers=PERSON)
    copy = store.path.read_bytes()
    _create(client, "Delta")
    _add_text(client, "delta-1")
    _add_text(client, ONLY_W)
    client.get("/api/projects", headers=PERSON)
    monkeypatch.setattr(store_module, "MAX_PROJECTS", 10)
    with open(store.path, "r+b") as handle:
        handle.write(b"\0" * store.path.stat().st_size)
    store.backup_path.write_bytes(copy)
    store.older_backup_path.unlink(missing_ok=True)
    _restart(monkeypatch, state, store)


def _start(start, client, store, graph, state, monkeypatch) -> None:
    if start == "restore-unsettled":
        _restored_unsettled(client, store, state, monkeypatch)
        return
    ids = _waiting(client, store, graph, state, monkeypatch)
    _make_room_without_listing(client, store, ids[0])
    # Room for the person's canvas and the copy an edit is made on (the copy
    # waiting at the limit has its own test).
    monkeypatch.setattr(store_module, "MAX_PROJECTS", 10)
    if start == "listed-first":
        # A listing (the load client's own, or the person's) files the
        # waiting canvas and opens it, just before the agent's write.
        listing = client.get("/api/projects", headers=PERSON).json()
        assert listing["canvasSaved"]["name"] == "Recovered canvas"


def _graph_file(tmp_path) -> Path:
    path = tmp_path / "agent.nebula"
    path.write_text(json.dumps({"nodes": [{"id": "u1", "definitionId": "text-input", "params": {"value": AGENT_LOAD},
                                           "position": {"x": 0, "y": 0}}], "edges": []}))
    return path


def _agent(how, client, monkeypatch, tmp_path):
    """The agent's call; its reply as a dict (or text for MCP and the CLI load)."""
    monkeypatch.setenv("NEBULA_AGENT_NAME", "Codex")
    path = _graph_file(tmp_path)
    if how == "http-clear":
        return client.request("DELETE", "/api/graph?force=true", headers=CODEX)
    if how == "http-load":
        return client.post("/api/graph/import", headers=CODEX, json=json.loads(path.read_text()))
    if how == "mcp-load":
        monkeypatch.setattr(mcp_server, "_api", lambda: NebulaAPI("http://testserver", client=client))
        return asyncio.run(mcp_server.mcp.call_tool("load_graph_file", {"path": str(path)}))
    if how == "cli-clear":
        cli = NebulaClient("http://testserver")
        cli._client = client
        return cli.clear_graph(force=True)
    if how == "cli-load":
        return graph_file_client.load(NebulaAPI("http://testserver", client=client), str(path), via="cli")
    graph = client.get("/api/graph/export", headers=CODEX).json()
    first = graph["nodes"][0]["id"]
    if how == "apply":
        return client.post("/api/graph/apply", headers=CODEX, json={
            "note": "start fresh", "remove": [node["id"] for node in graph["nodes"]],
            "nodes": [{"ref": "+a", "definitionId": "text-input", "params": {"value": AGENT_EDIT}}]})
    if how == "add":
        return client.post("/api/graph/node", headers=CODEX, json={"definitionId": "text-input",
                                                                   "params": {"value": AGENT_EDIT}})
    if how == "delete":
        return client.request("DELETE", f"/api/graph/node/{first}", headers=CODEX)
    if how == "params":
        return client.put(f"/api/graph/node/{first}", headers=CODEX, json={"params": {"value": AGENT_EDIT}})
    if how == "run":
        return client.post("/api/graph/run", headers=CODEX, json={"wait": 30})
    raise AssertionError(how)


def _catalog(store) -> dict:
    return json.loads(store.path.read_text())


EDITS = ["apply", "add", "delete", "params", "run"]
LOADS = ["http-load", "mcp-load", "cli-load"]
CLEARS = ["http-clear", "cli-clear"]


@pytest.mark.parametrize("start", ["waiting-slot-freed", "restore-unsettled", "listed-first"])
@pytest.mark.parametrize("how", [*CLEARS, *LOADS, *EDITS])
def test_high1_an_agent_write_files_the_persons_canvas_untouched_first(app, monkeypatch, tmp_path, start, how):
    client, store, graph, state = app
    _start(start, client, store, graph, state, monkeypatch)
    before = _live_values(main_module.cli_graph)
    assert ONLY_W in before
    reply = _agent(how, client, monkeypatch, tmp_path)
    if hasattr(reply, "status_code"):
        assert reply.status_code == 200, reply.text
        said = reply.json()["savedCanvas"]["message"]
    else:
        said = str(reply)
    # The agent's write is on a canvas that is no project.
    catalog = _catalog(store)
    assert catalog["activeProjectId"] is None
    keepers = [p for p in catalog["projects"].values() if _values(p) == before]
    assert len(keepers) == 1, [(p["name"], _values(p)) for p in catalog["projects"].values()]
    original = keepers[0]["name"]
    assert original == "Recovered canvas"
    if how in CLEARS:
        assert _live_values(main_module.cli_graph) == []
        assert f"Nebula saved the open canvas as its own project, “{original}”, and cleared a new canvas." in said
    elif how in LOADS:
        assert _live_values(main_module.cli_graph) == [AGENT_LOAD]
        if how == "http-load":
            assert said == (f"Nebula saved the open canvas as its own project, “{original}”, "
                            "and loaded the graph into a new canvas.")
        else:
            assert (f"Nebula saved the open canvas as its own project, “{original}”, "
                    "and loaded “agent.nebula” into a new canvas.") in said
    else:
        assert said == (f"Nebula saved the open canvas as its own project, “{original}”, "
                        "and made your change on a copy of it.")
    # The person lists, then opens another project: the original is still
    # exactly the person's canvas, and filed once.
    listing = client.get("/api/projects", headers=PERSON).json()
    assert listing.get("canvasNotFiled") is None
    catalog = _catalog(store)
    other = next(pid for pid, p in catalog["projects"].items() if p["name"] in ("A", "B", "C"))
    opened = client.post(f"/api/projects/{other}/open", headers=PERSON, json={"workspaceRevision": _rev(client)})
    assert opened.status_code == 200, opened.text
    catalog = _catalog(store)
    keepers = [p["name"] for p in catalog["projects"].values() if _values(p) == before]
    # A run changes no param: its copy holds the same values, under its own name.
    assert keepers == ([original, f"{original} copy"] if how == "run" else [original]), keepers
    if how in EDITS and how != "run":
        # The copy the change was made on is filed under the copy's name.
        copies = [p for p in catalog["projects"].values() if p["name"] == f"{original} copy"]
        assert len(copies) == 1, [p["name"] for p in catalog["projects"].values()]
        assert _values(copies[0]) != before


def test_high1_room_for_the_persons_canvas_only_the_copy_waits(app, monkeypatch):
    """One place left: the person's canvas takes it; the agent's change is made
    on the copy, which then waits as any canvas does (filed as "<name> copy"
    once there is room), and the agent's next write is refused at the limit."""
    client, store, graph, state = app
    ids = _waiting(client, store, graph, state, monkeypatch)
    _make_room_without_listing(client, store, ids[0])
    before = _live_values(main_module.cli_graph)
    response = client.post("/api/graph/node", headers=CODEX, json={"definitionId": "text-input",
                                                                   "params": {"value": AGENT_EDIT}})
    assert response.status_code == 200, response.text
    catalog = _catalog(store)
    assert [p["name"] for p in catalog["projects"].values() if _values(p) == before] == ["Recovered canvas"]
    nxt = client.post("/api/graph/node", headers=CODEX, json={"definitionId": "text-input", "params": {"value": "e2"}})
    assert nxt.status_code == 409 and nxt.json()["code"] == "canvas_waiting"
    listing = client.get("/api/projects", headers=PERSON).json()
    assert listing["canvasNotFiled"]["reason"] == "projects"
    remaining = next(pid for pid, p in _catalog(store)["projects"].items() if p["name"] != "Recovered canvas")
    client.request("DELETE", f"/api/projects/{remaining}", headers=PERSON, json={"workspaceRevision": _rev(client)})
    listing = client.get("/api/projects", headers=PERSON).json()
    names = [p["name"] for p in _catalog(store)["projects"].values()]
    assert "Recovered canvas copy" in names, names


def test_high1_at_the_limit_an_agent_write_is_still_refused(app, monkeypatch):
    client, store, graph, state = app
    _waiting(client, store, graph, state, monkeypatch)
    response = client.post("/api/graph/node", headers=CODEX, json={"definitionId": "text-input", "params": {"value": "x"}})
    assert response.status_code == 409 and response.json()["code"] == "canvas_waiting"
    assert ONLY_W in _live_values(main_module.cli_graph)


def test_high1_the_agents_next_write_lands_on_its_copy(app, monkeypatch):
    """After the first edit, the copy is the agent's: its next write files it
    as "<name> copy", opened, and lands on it (never a copy of the copy)."""
    client, store, graph, state = app
    _restored_unsettled(client, store, state, monkeypatch)
    first = client.post("/api/graph/node", headers=CODEX, json={"definitionId": "text-input", "params": {"value": "e1"}})
    assert first.status_code == 200, first.text
    second = client.post("/api/graph/node", headers=CODEX, json={"definitionId": "text-input", "params": {"value": "e2"}})
    assert second.status_code == 200, second.text
    assert "savedCanvas" not in second.json()
    catalog = _catalog(store)
    names = sorted(p["name"] for p in catalog["projects"].values())
    assert "Recovered canvas copy" in names and "Recovered canvas copy 2" not in names
    copy_id = next(pid for pid, p in catalog["projects"].items() if p["name"] == "Recovered canvas copy")
    assert catalog["activeProjectId"] == copy_id
    assert sorted(_live_values(main_module.cli_graph)) == sorted(["delta-1", ONLY_W, "e1", "e2"])


def test_high1_the_agent_log_row_and_the_restore_notice(app, monkeypatch):
    client, store, graph, state = app
    _restored_unsettled(client, store, state, monkeypatch)
    sent: list[dict] = []
    real = main_module._broadcast_projects_changed

    async def capture(change, project_id, **extra):
        sent.append({"change": change, **extra})
        await real(change, project_id, **extra)
    monkeypatch.setattr(main_module, "_broadcast_projects_changed", capture)
    response = client.post("/api/graph/node", headers=CODEX, json={"definitionId": "text-input", "params": {"value": "e"}})
    assert response.status_code == 200, response.text
    held = [row for row in sent if row["change"] == "canvasHeld"]
    assert held and held[0]["canvasHeld"]["savedAs"] == "Recovered canvas" and held[0]["canvasHeld"]["copy"] is True
    assert held[0]["canvasHeld"]["action"] == "changed" and held[0]["canvasHeld"]["agent"] == "Codex"
    listing = client.get("/api/projects", headers=PERSON).json()
    assert listing["catalogRestore"]["recoveredCanvas"]["name"] == "Recovered canvas"


def test_high1_clear_and_load_never_forget_the_filed_projects_undo(app, monkeypatch):
    """The just-filed project isn't the open one when the clear runs, so its
    undo book (and canvas revision) stays as it was."""
    client, store, graph, state = app
    _start("listed-first", client, store, graph, state, monkeypatch)
    project_id = _catalog(store)["activeProjectId"]
    forgotten: list = []
    real = main_module.canvas_undo_book.forget_project

    def spy(pid, why, **kwargs):
        forgotten.append(pid)
        return real(pid, why, **kwargs)
    monkeypatch.setattr(main_module.canvas_undo_book, "forget_project", spy)
    assert client.request("DELETE", "/api/graph?force=true", headers=CODEX).status_code == 200
    assert project_id not in forgotten


def test_n2_a_guard_inside_a_held_transaction_says_busy_not_the_limit(app, monkeypatch):
    client, store, graph, state = app
    _restored_unsettled(client, store, state, monkeypatch)
    with main_module.project_store.transaction():
        with pytest.raises(main_module.ProjectStoreError, match="busy"):
            main_module._settle_in_step()


# -- L-1 / N-3: the per-canvas reader under damage, itself (review 8's 600 cases) --

def _held_entry_for_fuzz(i: int, digest: bool) -> dict:
    nodes = [{"id": f"n{j}", "type": "x", "data": {"params": {"value": f"c{i}-{j}"}}, "position": {"x": j, "y": i}}
             for j in range(3)]
    entry = {"projectId": f"{i:032x}", "from": None, "unproven": False, "reason": "projects",
             "since": "2026-10-28T00:00:00Z", "heldAt": f"2026-10-28T00:00:0{i}Z", "digest": f"d{i}", "counter": 3,
             "nodes": nodes, "edges": [{"id": "e1", "source": "n0", "target": "n1"}]}
    if digest:
        entry["itemsDigest"] = store_module.held_items_digest(entry["nodes"], entry["edges"])
    return entry


@pytest.mark.parametrize("digest", [True, False], ids=["held-in-round-8", "held-before-round-8"])
def test_l1_n3_damage_never_files_a_canvas_with_other_content_unsaid(tmp_path, digest):
    """600 damages (flip, byte, cut, zero, typed garbage) to one canvas of
    three, on its main copy, its .bak or both: each canvas reads back exactly,
    or is said lost with its files kept; never filed with other content, and
    another canvas is never touched."""
    import random
    rng = random.Random(8)
    stats = {"exact": 0, "lost-said": 0, "wrong": 0, "unsaid": 0, "other": 0, "raised": 0}
    for case in range(600):
        root = tmp_path / f"r{case}"
        store = store_module.ProjectStore(root)
        entries = [_held_entry_for_fuzz(i, digest) for i in (1, 2, 3)]
        for entry in entries:
            store.hold_canvas(entry)
        victim = entries[1]
        main_copy, backup = store.held_paths(victim["projectId"])
        for path in rng.choice([[main_copy], [backup], [main_copy, backup]]):
            data = bytearray(path.read_bytes())
            kind = rng.choice(["flip", "cut", "zero", "garbage", "byte"])
            if kind == "flip":
                k = rng.randrange(len(data))
                data[k] ^= 1 << rng.randrange(8)
            elif kind == "byte":
                data[rng.randrange(len(data))] = rng.randrange(256)
            elif kind == "cut":
                data = data[: rng.randrange(len(data))]
            elif kind == "zero":
                data = bytearray(len(data))
            else:
                data = bytearray(json.dumps({"version": 2, "entry": {"projectId": victim["projectId"], "nodes": [1],
                                                                     "edges": []}, "check": "x"}).encode())
            path.write_bytes(bytes(data))
        fresh = store_module.ProjectStore(root)
        try:
            got = {entry["projectId"]: entry for entry in fresh.canvas_held()}
        except Exception:  # noqa: BLE001
            stats["raised"] += 1
            continue
        stats["other"] += sum(got.get(entry["projectId"]) != entry for entry in (entries[0], entries[2]))
        read = got.get(victim["projectId"])
        if read is None:
            stats["lost-said" if fresh.canvas_held_unreadable() else "unsaid"] += 1
        elif read["nodes"] == victim["nodes"] and read["edges"] == victim["edges"]:
            stats["exact"] += 1
        else:
            stats["wrong"] += 1
    assert stats["wrong"] == 0 and stats["unsaid"] == 0 and stats["other"] == 0 and stats["raised"] == 0, stats
    assert stats["exact"] > 300, stats


def test_l1_a_held_canvas_whose_content_changed_is_kept_aside_at_filing_and_said(app, monkeypatch):
    client, store, graph, state = app
    ids = _waiting(client, store, graph, state, monkeypatch)
    opened = client.post(f"/api/projects/{ids[1]}/open", headers=PERSON, json={"workspaceRevision": _rev(client)})
    assert opened.status_code == 200, opened.text
    (entry,) = store.canvas_held()
    assert store_module.held_items_intact(entry) is True
    # In memory, as if read from a copy whose bytes changed after the read.
    main_module._canvas_held_cache = (main_module.project_store, [{**entry, "nodes": entry["nodes"][:1]}])
    _make_room_without_listing(client, store, ids[0])
    listing = client.get("/api/projects", headers=PERSON).json()
    assert listing["canvasHeldUnreadable"]["count"] == 1
    assert not any(ONLY_W in _values(p) for p in _catalog(store)["projects"].values() if p["name"].startswith("Recov"))


# -- L-2: a restore from Recently deleted counts the live waiting canvas --

def test_l2_a_restore_never_takes_the_place_the_live_canvas_waits_on(app, monkeypatch):
    """Fix round 12 (Justin, 2026-10-29: a restore may pass the limit): the
    waiting canvas takes the freed place first, as the listing after a
    delete does, and the restore then passes the limit (4 of 3)."""
    client, store, graph, state = app
    ids = _waiting(client, store, graph, state, monkeypatch)
    _make_room_without_listing(client, store, ids[0])
    restored = client.post(f"/api/projects/{ids[0]}/restore", headers=CODEX, json={})
    assert restored.status_code == 200, restored.text
    listing = client.get("/api/projects", headers=PERSON).json()
    assert listing.get("canvasNotFiled") is None
    assert len(listing["projects"]) == 4 and ids[0] in [p["id"] for p in listing["projects"]]
    assert [p["name"] for p in _catalog(store)["projects"].values() if ONLY_W in _values(p)] == ["Recovered canvas"]


# -- N-1: the held canvases' kept files are pruned, never one the note names --

def test_n1_old_kept_held_files_are_pruned_by_the_catalogs_bound(tmp_path):
    store = store_module.ProjectStore(tmp_path / "projects")
    store._ensure_held_dir()
    old = [f"{i:032x}.json.damaged-20260101T00000{i}Z-0000000{i}" for i in range(6)]
    for name in old:
        (store.held_dir / name).write_text("x")
    (store.held_dir / ("f" * 32)).write_text("not kept: no stamp")
    unfileable = store.held_dir / f"{'a' * 32}.json.unfileable-20260101T000000Z-aaaaaaaa"
    unfileable.write_text("x")
    migrated = store.root / "canvas-held.json.migrated-20260101T000000Z-bbbbbbbb"
    migrated.write_text("x")
    named = f"canvas-held/{old[0]}"
    store.held_dir.joinpath(store_module.CANVAS_HELD_NOTE_NAME).write_text(json.dumps(
        {"count": 1, "kept": [named], "at": "2026-10-28T00:00:00+00:00"}))
    store.canvas_held()
    left = sorted(path.name for path in store.held_dir.iterdir())
    # The newest 3 damaged copies, and the one the note names, stay; the
    # only kept file of each other kind stays (the newest few of its kind).
    assert [name for name in left if ".damaged-" in name] == sorted([old[0], *old[3:]])
    assert unfileable.exists() and migrated.exists()


# -- GM r9: the held canvases' notice is closed with × (the person's only) --

def test_gm_r9_the_held_canvases_notice_is_closed_by_the_person_only(app, monkeypatch):
    client, store, graph, state = app
    ids = _waiting(client, store, graph, state, monkeypatch)
    opened = client.post(f"/api/projects/{ids[1]}/open", headers=PERSON, json={"workspaceRevision": _rev(client)})
    assert opened.status_code == 200, opened.text
    (entry,) = store.canvas_held()
    main_module._canvas_held_cache = (main_module.project_store, [{**entry, "nodes": entry["nodes"][:1]}])
    _make_room_without_listing(client, store, ids[0])
    note = client.get("/api/projects", headers=PERSON).json()["canvasHeldUnreadable"]
    assert note["count"] == 1 and note["at"]
    agent = client.post("/api/projects/canvas-held-unreadable/dismiss", headers=CODEX, json={"at": note["at"]})
    assert agent.status_code == 403
    assert client.post("/api/projects/canvas-held-unreadable/dismiss", headers=PERSON, json={"at": "2020-01-01T00:00:00+00:00"}).json() == {"dismissed": False}
    assert client.post("/api/projects/canvas-held-unreadable/dismiss", headers=PERSON, json={"at": note["at"]}).json() == {"dismissed": True}
    assert client.get("/api/projects", headers=PERSON).json().get("canvasHeldUnreadable") is None
    # Closed for good: a restart reads the note's file, still closed, and
    # the kept files stay on disk.
    _restart(monkeypatch, state, store)
    assert client.get("/api/projects", headers=PERSON).json().get("canvasHeldUnreadable") is None
    assert json.loads((store.held_dir / store_module.CANVAS_HELD_NOTE_NAME).read_text())["kept"]
    # A new loss is a new note, shown again, counting only itself (review 9,
    # nit 2, fix round 9: the person closed the one before).
    store._note_held_lost(1, ["x"])
    assert client.get("/api/projects", headers=PERSON).json()["canvasHeldUnreadable"]["count"] == 1


# -- GM's answer 1 to review 8: the restore notice names every canvas filed --

def test_gm_answer1_a_canvas_filed_while_the_notice_shows_joins_it_with_no_toast(app, monkeypatch):
    """The restore's own canvas is its recoveredCanvas; the copy an agent's
    edit made, filed while the notice shows, is the agent's (GM r11, 4:
    `agentCopies`, never `alsoFiled`) and gets no toast. Once the notice is
    closed, a later filing's toast says "Another"."""
    client, store, graph, state = app
    _restored_unsettled(client, store, state, monkeypatch)
    first = client.post("/api/graph/node", headers=CODEX, json={"definitionId": "text-input", "params": {"value": "e1"}})
    assert first.status_code == 200, first.text
    listing = client.get("/api/projects", headers=PERSON).json()
    restore = listing["catalogRestore"]
    assert restore["recoveredCanvas"]["name"] == "Recovered canvas"
    assert listing.get("canvasSaved") is None
    # The agent's next write files its copy while the notice shows.
    second = client.post("/api/graph/node", headers=CODEX, json={"definitionId": "text-input", "params": {"value": "e2"}})
    assert second.status_code == 200, second.text
    listing = client.get("/api/projects", headers=PERSON).json()
    assert listing["catalogRestore"].get("alsoFiled") in (None, [])
    assert [(row["name"], row["agentCopy"]) for row in listing["catalogRestore"]["agentCopies"]] == [
        ("Recovered canvas copy", {"agent": "Codex"})]
    assert listing.get("canvasSaved") is None
    assert client.post("/api/projects/catalog-restore/dismiss", headers=PERSON, json={"id": restore["id"]}).json() == {"dismissed": True}
    # A later filing on its own: the toast's record carries `another`.
    main_module._note_canvases_saved([{"id": "e" * 32, "name": "Recovered canvas 2"}])
    saved = client.get("/api/projects", headers=PERSON).json().get("canvasSaved")
    assert saved and saved["name"] == "Recovered canvas 2" and saved.get("another") is True


def test_high1_a_copy_the_agent_emptied_takes_no_number(app, monkeypatch):
    """An agent's apply that removes every node right after a listing filed
    and opened the person's canvas: the person's canvas stays exact in
    “Recovered canvas”, the empty copy is never filed, and the next copy is
    "Recovered canvas copy", not "copy 2"."""
    client, store, graph, state = app
    _start("listed-first", client, store, graph, state, monkeypatch)
    before = _live_values(main_module.cli_graph)
    nodes = [node["id"] for node in client.get("/api/graph/export", headers=CODEX).json()["nodes"]]
    emptied = client.post("/api/graph/apply", headers=CODEX, json={"note": "fresh", "remove": nodes})
    assert emptied.status_code == 200, emptied.text
    assert emptied.json()["savedCanvas"]["copy"] == "Recovered canvas copy"
    assert _live_values(main_module.cli_graph) == []
    client.get("/api/projects", headers=PERSON)
    names = [p["name"] for p in _catalog(store)["projects"].values()]
    assert "Recovered canvas copy" not in names
    assert [p["name"] for p in _catalog(store)["projects"].values() if _values(p) == before] == ["Recovered canvas"]
    assert main_module._canvas_copy_name("Recovered canvas", _catalog(store)) == "Recovered canvas copy"
