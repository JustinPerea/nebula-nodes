"""PR #199 fix round 11 (review 11, GM r14 and r15).

- MEDIUM-1: the person's canvas a restore left unsettled is filed in a
  commit of its own before an agent's clear, load or edit commits, so a
  second damage right after that write still restores it.
- HIGH-1: a restore while Nebula runs reaches open tabs as a graphSync with
  the restore notice's id (and `projectsChanged{catalogRestored}`).
- LOW-1 and nit 4: a restore during the import (the boot read) is journaled
  at startup, and the protection it sets carries the canvas's real digest.
- GM r15: a project protected again after a restore already was a
  project, so the agent's replies and the person's log row say "kept".
- GM r14, 4: one naming rule for the three families ("Recovered canvas N",
  "Recovered X N", "X copy N"): never stacked, the next free number, a
  lost row's own name reused when it is free.
- nit 3: a protection for a project the restored list doesn't have goes.
"""
from __future__ import annotations

import asyncio
import json
import os
import subprocess
import sys
from pathlib import Path

import httpx
import pytest

sys.path.insert(0, str(Path(__file__).resolve().parent.parent))

import graph_file_client  # noqa: E402
import main as main_module  # noqa: E402
import mcp_server  # noqa: E402
from cli.client import NebulaClient  # noqa: E402
from nebula_api import NebulaAPI  # noqa: E402
from services import project_store as store_module  # noqa: E402
from tests.conftest import PERSON  # noqa: E402
from tests.test_project_catalog_restore_fix2 import _add_text, _create, _values, app  # noqa: E402,F401
from tests.test_project_catalog_restore_fix3 import _restart  # noqa: E402
from tests.test_project_catalog_restore_fix5 import _live_values  # noqa: E402
from tests.test_project_catalog_restore_fix8 import _restored_unsettled  # noqa: E402

CODEX = {**PERSON, "X-Nebula-Agent": "Codex"}
BACKEND = Path(__file__).resolve().parent.parent


def _catalog(store) -> dict:
    return json.loads(store.path.read_text())


def _listed_with(store, values: list[str]) -> list[str]:
    """The listed projects whose nodes are exactly ``values``."""
    return [p["name"] for p in _catalog(store)["projects"].values() if _values(p) == sorted(values)]


# -- MEDIUM-1: a second damage right after the agent's write ------------------------------

WRITES = {
    "clear": ("DELETE", "/api/graph?force=true", None),
    "load": ("POST", "/api/graph/import",
             {"nodes": [{"id": "x1", "definitionId": "text-input", "params": {"value": "imported"}}], "edges": []}),
    "add": ("POST", "/api/graph/node", {"definitionId": "text-input", "params": {"value": "codex-x"}}),
}


@pytest.mark.parametrize("cut", ["f10", "f50", "f90", "zeroed"])
@pytest.mark.parametrize("write", list(WRITES))
def test_medium1_a_damage_right_after_the_agents_write_still_restores_the_persons_canvas(
        app, monkeypatch, write, cut):
    """Review 11's A5 (restored-unsettled): the first restore left the
    person's canvas live and unfiled; Codex's write files it and changes the
    canvas; catalog.json is damaged before any later commit. The restore's
    .bak must hold the person's canvas, exactly, as a listed project (on
    df8384f8 the filing and the write were one commit: 12 of 12 lost or
    mixed with Codex's change)."""
    client, store, _graph, state = app
    _restored_unsettled(client, store, state, monkeypatch)
    before = _live_values(main_module.cli_graph)
    method, url, body = WRITES[write]
    reply = client.request(method, url, headers=CODEX, **({"json": body} if body is not None else {}))
    assert reply.status_code == 200, reply.text
    assert reply.json()["savedCanvas"]["name"] == "Recovered canvas"
    # The .bak this write rotated holds the filing, open and protected.
    bak = json.loads(store.backup_path.read_bytes())
    assert [p["name"] for p in bak["projects"].values() if _values(p) == sorted(before)] == ["Recovered canvas"]
    raw = store.path.read_bytes()
    store.path.write_bytes(b"\0" * len(raw) if cut == "zeroed" else raw[: len(raw) * int(cut[1:]) // 100])
    _restart(monkeypatch, state, store)
    client.get("/api/projects", headers=PERSON)
    assert _listed_with(store, before) == ["Recovered canvas"]


def test_medium1_the_filing_and_the_agents_write_are_two_commits(app, monkeypatch):
    """The filing commits on its own first: right after it (before the
    agent's change commits) the catalog holds it open and protected."""
    client, store, _graph, state = app
    _restored_unsettled(client, store, state, monkeypatch)
    before = _live_values(main_module.cli_graph)
    seen: list[dict] = []
    commit = store.commit

    def watching(catalog):
        seen.append(json.loads(json.dumps(catalog, default=str)))
        return commit(catalog)

    monkeypatch.setattr(store, "commit", watching)
    reply = client.request("DELETE", "/api/graph?force=true", headers=CODEX)
    assert reply.status_code == 200, reply.text
    filing = next(i for i, c in enumerate(seen)
                  if any(_values(p) == sorted(before) for p in c["projects"].values()))
    first = seen[filing]
    filed = next(pid for pid, p in first["projects"].items() if _values(p) == sorted(before))
    assert first["activeProjectId"] == filed
    assert store_module.canvas_pending_of(first)["fresh"] == {
        "projectId": filed, "digest": store_module.canvas_pending_of(first)["fresh"]["digest"], "filed": True}
    # The agent's change is a later commit: the project closed there.
    assert any(c["activeProjectId"] is None and filed in c["projects"] for c in seen[filing + 1:])


# -- HIGH-1: a restore while Nebula runs reaches the tabs ---------------------------------

def test_high1_a_runtime_restore_sends_a_graphsync_with_its_id(app, monkeypatch):
    client, store, _graph, _state = app
    for name in ("Alpha", "Beta", "Gamma"):
        _create(client, name)
    client.get("/api/projects", headers=PERSON)
    copy = store.path.read_bytes()
    _create(client, "Delta")
    _add_text(client, "delta-1")
    client.get("/api/projects", headers=PERSON)
    held = _catalog(store)["workspaceRevision"]
    since = main_module.canvas_events.latest
    broadcast = main_module.manager.broadcast_raw
    broadcast.reset_mock()
    with open(store.path, "r+b") as handle:
        handle.write(b"\0" * store.path.stat().st_size)
    store.backup_path.write_bytes(copy)
    store.older_backup_path.unlink(missing_ok=True)
    # On a loop that keeps running after the listing's answer, as the
    # server's does: the tell is scheduled on it (call_soon).

    async def listed():
        # The serving loop (startup records it), for a restore made in a
        # worker thread.
        monkeypatch.setattr(main_module, "_main_loop", asyncio.get_running_loop())
        transport = httpx.ASGITransport(app=main_module.app)
        async with httpx.AsyncClient(transport=transport, base_url="http://testserver") as session:
            answer = (await session.get("/api/projects", headers=PERSON)).json()
            for _ in range(50):
                await asyncio.sleep(0)
        return answer

    listing = asyncio.run(listed())
    restore_id = listing["catalogRestore"]["id"]
    sent = [call.args[0] for call in broadcast.await_args_list]
    syncs = [msg for msg in sent if msg.get("type") == "graphSync"]
    # With the restored list's revision, not the one the tab holds.
    assert any(msg.get("catalogRestore") == restore_id and msg.get("workspaceRevision") not in (None, held)
               for msg in syncs), [(m.get("type"), m.get("catalogRestore"), m.get("change")) for m in sent]
    assert any(msg.get("type") == "projectsChanged" and msg.get("change") == "catalogRestored" for msg in sent)
    # And the journal says it, as before.
    events = main_module.canvas_events.read(after=since)["events"]
    assert any(event["kind"] == "project.catalogRestored" and event["data"]["id"] == restore_id for event in events)


def test_high1_tell_catalog_restore_broadcasts_on_a_running_loop(monkeypatch):
    sent: list[dict] = []

    async def capture(message):
        sent.append(message)

    async def changed(change, *args, **kwargs):
        sent.append({"type": "projectsChanged", "change": change})

    monkeypatch.setattr(main_module.manager, "broadcast_raw", capture)
    monkeypatch.setattr(main_module, "_broadcast_projects_changed", changed)

    async def run():
        main_module._tell_catalog_restore({"id": "r1", "note": "restored"})
        for _ in range(20):
            await asyncio.sleep(0)

    asyncio.run(run())
    assert [m["type"] for m in sent].count("graphSync") == 1
    assert {"type": "projectsChanged", "change": "catalogRestored"} in sent


# -- LOW-1 and nit 4: a restore at boot ---------------------------------------------------

BOOT_SCRIPT = r'''
import asyncio, json, sys
from uuid import uuid4
phase = sys.argv[1]
token = "boot-person-token-" + "0" * 25
import main
from services import person_session, project_store as store_module
from fastapi.testclient import TestClient
store = main.project_store
if phase == "make":
    person_session._session.set(token)
    client = TestClient(main.app)
    person = {"Origin": "http://localhost:5173", "X-Nebula-Person": token,
              "X-Nebula-Params-Version": str(main.PARAMS_VERSION)}
    rev = lambda: client.get("/api/projects", headers=person).json()["workspaceRevision"]
    made = client.post("/api/projects", json={"name": "Film", "workspaceRevision": rev()}, headers=person)
    assert made.status_code == 200, made.text
    added = client.post("/api/graph/node", json={"definitionId": "text-input", "params": {"value": "film-1"}},
                        headers={**person, "X-Nebula-Workspace-Revision": rev()})
    assert added.status_code == 200, added.text
    for _ in range(2):
        with store.transaction() as catalog:
            store.commit(catalog)
    print(json.dumps({"film": made.json()["project"]["id"]}))
    sys.exit(0)
# boot: the import above read the damaged catalog and restored it.
before = [e["kind"] for e in main.canvas_events.read(after=0, limit=500)["events"]]
catalog = json.loads(store.path.read_text())
fresh = store_module.canvas_pending_of(catalog)["fresh"]
asyncio.run(main._journal_boot_restores())
after = [e["kind"] for e in main.canvas_events.read(after=0, limit=500)["events"]]
print(json.dumps({"before": before, "after": after, "fresh": fresh, "digest": main._fresh_digest(),
                  "active": catalog["activeProjectId"], "queued": len(main._boot_restores),
                  "startup": main._journal_boot_restores in main.app.router.on_startup}))
'''


def test_low1_a_restore_at_boot_is_journaled_at_startup_with_a_real_digest(tmp_path):
    script = tmp_path / "boot.py"
    script.write_text(BOOT_SCRIPT)
    env = {**os.environ, "HOME": str(tmp_path / "home"), "NEBULA_STATE_DIR": str(tmp_path / "state"),
           "NEBULA_SETTINGS_PATH": str(tmp_path / "settings.json"), "NEBULA_OUTPUT_ROOT": str(tmp_path / "output"),
           "NEBULA_MOODBOARD_ROOT": str(tmp_path / "moodboards"), "NEBULA_CHARACTER_ROOT": str(tmp_path / "characters"),
           "NEBULA_PRESET_ROOT": str(tmp_path / "presets"), "PYTHONPATH": str(BACKEND), "PYTHONDONTWRITEBYTECODE": "1"}
    (tmp_path / "home").mkdir()

    def run(phase):
        done = subprocess.run([sys.executable, str(script), phase], cwd=BACKEND, env=env, capture_output=True,
                              text=True, timeout=240)
        assert done.returncode == 0, done.stdout[-2000:] + done.stderr[-4000:]
        return json.loads(done.stdout.strip().splitlines()[-1]), done.stdout + done.stderr

    made, _ = run("make")
    catalog_path = tmp_path / "state" / "projects" / "catalog.json"
    raw = catalog_path.read_bytes()
    # Torn past its head: the damaged file isn't read whole, so the restore
    # protects the reopened project again (_protect_after_restore) at boot.
    catalog_path.write_bytes(raw[: len(raw) // 2])
    booted, output = run("boot")
    assert "announcing the restore failed" not in output
    assert "project.catalogRestored" not in booted["before"]
    assert "project.catalogRestored" in booted["after"]
    assert booted["queued"] == 0 and booted["startup"] is True
    assert booted["active"] == made["film"]
    assert booted["fresh"]["projectId"] == made["film"]
    # nit 4: the canvas's own digest, not zeros.
    assert booted["fresh"]["digest"] == booted["digest"] != "0" * 64
    assert "filed" not in booted["fresh"]


# -- GM r15: "kept" for a project that already was one --------------------------------

def _graph_file(tmp_path) -> Path:
    path = tmp_path / "file.json"
    path.write_text(json.dumps({"nodes": [{"id": "u1", "definitionId": "text-input", "params": {"value": "loaded"},
                                           "position": {"x": 0, "y": 0}}], "edges": []}))
    return path


def _protected_again(client, store) -> str:
    """"My film", open with the person's nodes, protected again as a restore
    that couldn't read the damaged file whole does (_protect_after_restore)."""
    film = _create(client, "My film")
    _add_text(client, "film-1")
    client.get("/api/projects", headers=PERSON)
    with store.transaction() as catalog:
        main_module._protect_after_restore(catalog)
        store.commit(catalog)
    fresh = store_module.canvas_pending_of(_catalog(store))["fresh"]
    assert fresh is not None and fresh["projectId"] == film and "filed" not in fresh
    return film


KEPT = {
    "http-clear": "Nebula kept “My film” as it was and cleared a new canvas.",
    "cli-clear": "Nebula kept “My film” as it was and cleared a new canvas.",
    "http-load": "Nebula kept “My film” as it was and loaded the graph into a new canvas.",
    "mcp-load": "Nebula kept “My film” as it was and loaded “file.json” into a new canvas.",
    "cli-load": "Nebula kept “My film” as it was and loaded “file.json” into a new canvas.",
    "http-add": "Nebula kept “My film” as it was and made your change on a copy of it.",
}


@pytest.mark.parametrize("how", list(KEPT))
def test_q10_an_existing_project_protected_again_is_said_as_kept(app, monkeypatch, tmp_path, how):
    client, store, _graph, _state = app
    film = _protected_again(client, store)
    monkeypatch.setenv("NEBULA_AGENT_NAME", "Codex")
    broadcast = main_module.manager.broadcast_raw
    broadcast.reset_mock()
    path = _graph_file(tmp_path)
    if how == "http-clear":
        reply = client.request("DELETE", "/api/graph?force=true", headers=CODEX)
    elif how == "http-load":
        reply = client.post("/api/graph/import", headers=CODEX, json=json.loads(path.read_text()))
    elif how == "http-add":
        reply = client.post("/api/graph/node", headers=CODEX, json={"definitionId": "text-input",
                                                                   "params": {"value": "codex-x"}})
    elif how == "cli-clear":
        cli = NebulaClient("http://testserver")
        cli._client = client
        reply = cli.clear_graph(force=True)
    elif how == "mcp-load":
        monkeypatch.setattr(mcp_server, "_api", lambda: NebulaAPI("http://testserver", client=client))
        reply = asyncio.run(mcp_server.mcp.call_tool("load_graph_file", {"path": str(path)}))
    else:
        reply = graph_file_client.load(NebulaAPI("http://testserver", client=client), str(path), via="cli")
    if hasattr(reply, "status_code"):
        assert reply.status_code == 200, reply.text
        saved = reply.json()["savedCanvas"]
        assert saved["kept"] is True and saved["id"] == film
        assert saved["message"] == KEPT[how]
    else:
        assert KEPT[how] in str(reply)
        assert "saved the open canvas as its own project" not in str(reply)
    # The person's Agent log row's payload says kept too.
    held = [call.args[0] for call in broadcast.await_args_list
            if call.args[0].get("type") == "projectsChanged" and call.args[0].get("change") == "canvasHeld"]
    assert held and held[-1]["canvasHeld"].get("kept") is True and held[-1]["canvasHeld"]["savedAs"] == "My film"
    # The project is exactly the person's canvas, closed; the export says
    # which project an agent's write closed, how, and who.
    catalog = _catalog(store)
    assert catalog["activeProjectId"] is None and _values(catalog["projects"][film]) == ["film-1"]
    exported = client.get("/api/graph/export", headers=PERSON).json()
    note = exported["personsCanvasSaved"]
    assert note["projectId"] == film and note["name"] == "My film" and note["agent"] == "Codex"
    assert note["action"] == ("clear" if how.endswith("clear") else "replace" if how.endswith("load") else "change")
    assert isinstance(note["id"], str) and len(note["id"]) == 32


def test_q10_the_persons_waiting_canvas_filed_by_a_listing_is_still_said_as_saved(app, monkeypatch):
    """The other side of "kept": a canvas that wasn't a project before this
    protection (filed from the person's waiting canvas) says "saved"."""
    client, store, _graph, state = app
    _restored_unsettled(client, store, state, monkeypatch)
    client.get("/api/projects", headers=PERSON)
    fresh = store_module.canvas_pending_of(_catalog(store))["fresh"]
    assert fresh is not None and fresh.get("filed") is True
    reply = client.request("DELETE", "/api/graph?force=true", headers=CODEX)
    assert reply.status_code == 200, reply.text
    saved = reply.json()["savedCanvas"]
    assert "kept" not in saved
    assert saved["message"] == "Nebula saved the open canvas as its own project, “Recovered canvas”, and cleared a new canvas."


# -- GM r14, 4: the naming families -------------------------------------------------------

def _named(*names: str, trash: tuple[str, ...] = ()) -> dict:
    return {"projects": {f"{i:032x}": {"name": name} for i, name in enumerate(names)},
            "trash": {f"{i + 100:032x}": {"name": name} for i, name in enumerate(trash)}}


@pytest.mark.parametrize(("source", "names", "want"), [
    # GM r29, 2: "Recovered <name>", then " copy", " copy 2"; no number read.
    ("Alpha", (), "Recovered Alpha"),
    ("Alpha", ("Recovered Alpha",), "Recovered Alpha copy"),
    ("Recovered Alpha", ("Recovered Alpha",), "Recovered Alpha copy"),
    ("Recovered Alpha 2", ("Recovered Alpha", "Recovered Alpha 2"), "Recovered Alpha 2 copy"),
    ("Recovered canvas", ("Recovered canvas",), "Recovered canvas copy"),
    ("Recovered canvas 2", ("Recovered canvas", "Recovered canvas 2"), "Recovered canvas 2 copy"),
    # The lowest free: a freed one is used again.
    ("Alpha", ("Recovered Alpha 2",), "Recovered Alpha"),
    ("Alpha", ("Recovered Alpha", "Recovered Alpha copy 2"), "Recovered Alpha copy"),
])
def test_r14_4_recovered_names_never_stack(source, names, want):
    assert store_module.recovered_name(source, _named(*names)) == want


@pytest.mark.parametrize(("source", "names", "want"), [
    ("Alpha", (), "Alpha copy"),
    ("Alpha", ("Alpha copy",), "Alpha copy 2"),
    ("Alpha copy", ("Alpha copy",), "Alpha copy 2"),
    ("Alpha copy 2", ("Alpha copy", "Alpha copy 2"), "Alpha copy 3"),
    ("Recovered canvas", ("Recovered canvas copy",), "Recovered canvas copy 2"),
])
def test_r14_4_copy_names_follow_the_same_rule(source, names, want):
    assert store_module.duplicate_name(source, _named(*names)) == want


def test_r14_4_recovered_canvas_takes_the_next_free_number_and_counts_the_trash():
    assert store_module.recovered_canvas_name(_named()) == "Recovered canvas"
    assert store_module.recovered_canvas_name(_named("Recovered canvas")) == "Recovered canvas 2"
    assert store_module.recovered_canvas_name(_named(trash=("Recovered canvas",))) == "Recovered canvas 2"
    assert store_module.recovered_canvas_name(_named("Recovered canvas 2")) == "Recovered canvas"


@pytest.mark.parametrize(("lost", "names", "want"), [
    # Review 11, nit 2: no "Recovered Recovered canvas".
    ("Recovered canvas", (), "Recovered canvas"),
    ("Recovered canvas", ("Recovered canvas",), "Recovered canvas copy"),  # GM r29, 2
    ("Alpha", (), "Alpha"),
    ("Alpha", ("Alpha",), "Recovered Alpha"),
    ("Recovered Alpha", ("Recovered Alpha",), "Recovered Alpha copy"),
    # GM r16, 1: a recovered copy of a copy names its source.
    ("Alpha copy", ("Alpha copy",), "Recovered Alpha copy"),
])
def test_r14_4_a_lost_rows_own_name_is_reused_when_free(lost, names, want):
    assert store_module.lost_row_name(lost, _named(*names)) == want


def test_r14_4_the_recover_endpoint_names_a_copy_of_an_unlisted_project_by_its_name(app):
    """[Save as a project] after a restore took the tab's project away: the
    tab sends the name it knew, so the copy isn't "Deleted project"."""
    client, store, _graph, _state = app
    _create(client, "Alpha")
    snapshot = _catalog(store)["projects"][_catalog(store)["activeProjectId"]]["snapshot"]
    gone = "f" * 32
    reply = client.post("/api/projects/recover", headers=PERSON, json={
        "sourceProjectId": gone, "snapshot": snapshot, "recoveryId": "e" * 32,
        "paramsVersion": main_module.PARAMS_VERSION, "sourceName": "Delta"})
    assert reply.status_code == 200, reply.text
    assert reply.json()["project"]["name"] == "Recovered Delta"
    again = client.post("/api/projects/recover", headers=PERSON, json={
        "sourceProjectId": gone, "snapshot": snapshot, "recoveryId": "d" * 32,
        "paramsVersion": main_module.PARAMS_VERSION, "sourceName": "Delta"})
    assert again.json()["project"]["name"] == "Recovered Delta copy"  # GM r29, 2
    nameless = client.post("/api/projects/recover", headers=PERSON, json={
        "sourceProjectId": gone, "snapshot": snapshot, "recoveryId": "c" * 32,
        "paramsVersion": main_module.PARAMS_VERSION})
    assert nameless.json()["project"]["name"] == "Recovered Deleted project"


# -- nit 3: a protection for an unlisted project goes -------------------------------------

def test_nit3_a_carried_protection_for_an_unlisted_project_goes(tmp_path):
    store = store_module.ProjectStore(tmp_path / "projects")
    listed, gone = "a" * 32, "b" * 32
    catalog = {"projects": {listed: {"name": "A"}}, "trash": {}, "activeProjectId": listed}
    store_module.set_canvas_pending_in(catalog, {"fresh": {"projectId": gone, "digest": "1" * 64}, "copies": {}})
    store._carry_protection(catalog, [], True)
    assert store_module.canvas_pending_of(catalog)["fresh"] is None
    store_module.set_canvas_pending_in(catalog, {"fresh": {"projectId": listed, "digest": "1" * 64, "filed": True},
                                                 "copies": {}})
    store._carry_protection(catalog, [], True)
    assert store_module.canvas_pending_of(catalog)["fresh"] == {"projectId": listed, "digest": "1" * 64, "filed": True}
