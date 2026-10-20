"""Opening, recovering and importing a project must not stall the backend.

Found by #99's follow-up review, 2026-10-20: opening a project (POST
/api/projects/{id}/open) checked its whole saved snapshot for protected file
paths (validate_file_references) on the event loop, about 0.5-0.7 s per open
on the test project and growing with the project (3.2 s on a 1.9 MB one in the
live check), and every request and canvas event waited behind it. The autosave
already ran that check in a worker thread (test_project_save_event_loop.py);
open, recover (a stale tab's copy) and import (a .nebula file) did not.

The check still decides on exactly what is committed: a project whose saved
data changes between the threaded check and the commit is checked again, and
its refusals keep their order (a 404 or a stale revision still answers first).
"""
from __future__ import annotations

import asyncio
import json
import sys
import time
from pathlib import Path
from unittest.mock import AsyncMock
from uuid import uuid4

import httpx
import pytest

sys.path.insert(0, str(Path(__file__).resolve().parent.parent))
import main as main_module
from services.cli_graph import CLIGraph
from services.execution_runs import ExecutionRunRegistry
from services.node_errors import NodeErrors
from services.project_store import ProjectStore, make_project
from services.provider_recovery import ProviderRecoveryStore
from services.provider_start_guard import ProviderStartGuard

AGENT = {"X-Nebula-Agent": "Claude Code"}
SLOW = "slow-check-marker"
DELAY = 0.6


@pytest.fixture
def workspace(tmp_path, monkeypatch):
    graph = CLIGraph(persist_path=tmp_path / "state.json")
    store = ProjectStore(tmp_path / "projects")
    monkeypatch.setattr(main_module, "cli_graph", graph)
    monkeypatch.setattr(main_module, "project_store", store)
    monkeypatch.setattr(main_module, "node_errors", NodeErrors(tmp_path / "node-errors.json"))
    monkeypatch.setattr(main_module, "provider_recovery_store", ProviderRecoveryStore(None))
    monkeypatch.setattr(main_module, "provider_start_guard", ProviderStartGuard(tmp_path / "paid-starts.json"))
    monkeypatch.setattr(main_module, "execution_runs", ExecutionRunRegistry())
    monkeypatch.setattr(main_module, "_graph_recovery_bootstrap_error", None)
    monkeypatch.setattr(main_module.manager, "broadcast_raw", AsyncMock())
    return graph, store


@pytest.fixture
def slow_check(monkeypatch):
    """The check takes DELAY seconds of blocking work on any whole graph that
    holds SLOW (a stand-in for a large project's real check), and records the
    thread each whole-graph check ran on."""
    real = main_module.validate_file_references
    threads: list[bool] = []

    def slow(value):
        if isinstance(value, dict) and ("nodes" in value or "snapshot" in value):
            import threading
            threads.append(threading.current_thread() is threading.main_thread())
            if SLOW in json.dumps(value, default=str):
                time.sleep(DELAY)
        return real(value)

    monkeypatch.setattr(main_module, "validate_file_references", slow)
    return threads


def _rf(node_id, value="v"):
    return {"id": node_id, "type": "model-node", "position": {"x": 0, "y": 0},
            "data": {"definitionId": "text-input", "label": "Prompt", "params": {"value": value},
                     "outputs": {"text": {"type": "Text", "value": value}}}}


def _snapshot(*values, history=()):
    nodes = [_rf(f"n{index}", value) for index, value in enumerate(values, start=1)]
    return {"nodes": nodes, "edges": [], "viewport": {"x": 0, "y": 0, "zoom": 1},
            "runHistory": [{"id": run_id, "status": "complete", "startedAt": 1,
                            "snapshot": {"nodes": [], "edges": []}} for run_id in history]}


def _seed(store, name, snapshot):
    """A project written straight into the catalog (as an older build, another
    process or a hand edit could have left it), not through a route."""
    with store.transaction() as catalog:
        project = make_project(name, snapshot)
        catalog["projects"][project["id"]] = project
        store.commit(catalog)
    return project["id"]


def _secret() -> str:
    from services.agent_profiles import default_secret_paths
    return str(default_secret_paths()[0])


async def _client():
    return httpx.AsyncClient(transport=httpx.ASGITransport(app=main_module.app), base_url="http://127.0.0.1")


async def _ping_during(request, *, after=0.1):
    """Send ``request`` and, ``after`` seconds in, a ping. Returns (response,
    ping latency measured from when it was due, whether the request was still
    in flight when the ping answered)."""
    started = time.monotonic()
    task = asyncio.ensure_future(request)

    async def ping(client):
        await asyncio.sleep(after)
        response = await client.get("/api/health")
        assert response.status_code == 200
        return time.monotonic() - started - after, not task.done()

    async with await _client() as pinger:
        latency, in_flight = await ping(pinger)
    return await task, latency, in_flight


# -- the loop keeps serving ------------------------------------------------------

@pytest.mark.asyncio
async def test_a_ping_answers_while_a_large_project_opens(workspace, slow_check):
    _graph, store = workspace
    async with await _client() as client:
        small = (await client.post("/api/projects", json={"name": "Small"})).json()
        big = _seed(store, "Big", _snapshot(SLOW, "a dune"))
        response, latency, in_flight = await _ping_during(
            client.post(f"/api/projects/{big}/open", json={"workspaceRevision": small["workspaceRevision"]}))
    assert response.status_code == 200, response.text
    assert latency < 0.3, f"a ping waited {latency:.2f}s behind the open"
    assert in_flight, "the open finished before the ping, so it proves nothing"
    assert store.read()["activeProjectId"] == big
    assert slow_check and not any(slow_check), "the whole-snapshot check ran on the event loop"


@pytest.mark.asyncio
async def test_a_ping_answers_while_the_open_project_is_reopened(workspace, slow_check):
    """Reopening the open project (an agent does) checks what the live canvas
    makes of it: the threaded check sees the same merge the commit does."""
    graph, store = workspace
    async with await _client() as client:
        made = (await client.post("/api/projects", json={"name": "Open"})).json()
        graph.add_node("text-input", {"value": SLOW})
        response, latency, in_flight = await _ping_during(
            client.post(f"/api/projects/{made['project']['id']}/open", json={"workspaceRevision": made["workspaceRevision"]},
                        headers=AGENT))
    assert response.status_code == 200, response.text
    assert in_flight and latency < 0.3, f"a ping waited {latency:.2f}s behind the reopen"
    assert not any(slow_check), "the whole-snapshot check ran on the event loop"
    assert [node["params"]["value"] for node in graph.nodes.values()] == [SLOW]


@pytest.mark.asyncio
async def test_a_ping_answers_while_a_stale_tab_is_recovered(workspace, slow_check):
    _graph, store = workspace
    async with await _client() as client:
        made = (await client.post("/api/projects", json={"name": "Dunes"})).json()
        response, latency, in_flight = await _ping_during(client.post("/api/projects/recover", json={
            "sourceProjectId": made["project"]["id"], "recoveryId": uuid4().hex,
            "snapshot": _snapshot(SLOW), "paramsVersion": main_module.PARAMS_VERSION}))
    assert response.status_code == 200, response.text
    assert in_flight and latency < 0.3, f"a ping waited {latency:.2f}s behind the recovery"
    assert not any(slow_check), "the whole-snapshot check ran on the event loop"
    assert len(store.read()["projects"]) == 2


@pytest.mark.asyncio
async def test_a_ping_answers_while_a_graph_file_is_imported(workspace, slow_check):
    graph, _store = workspace
    async with await _client() as client:
        await client.post("/api/projects", json={"name": "Dunes"})
        response, latency, in_flight = await _ping_during(client.post("/api/graph/import", json={
            "nodes": [{"id": "a", "definitionId": "text-input", "params": {"value": SLOW}}], "edges": []}))
    assert response.status_code == 200, response.text
    assert in_flight and latency < 0.3, f"a ping waited {latency:.2f}s behind the import"
    assert not any(slow_check), "the whole-graph check ran on the event loop"
    assert [node["params"]["value"] for node in graph.nodes.values()] == [SLOW]


# -- the check still refuses, on every route ---------------------------------------

@pytest.mark.asyncio
async def test_open_still_refuses_a_saved_protected_reference(workspace):
    graph, store = workspace
    async with await _client() as client:
        current = (await client.post("/api/projects", json={"name": "Current"})).json()
        graph.add_node("text-input", {"value": "keep me"})
        bad = _seed(store, "Bad", _snapshot(_secret()))
        before = store.path.read_bytes()
        response = await client.post(f"/api/projects/{bad}/open", json={"workspaceRevision": current["workspaceRevision"]})
    assert response.status_code == 400, response.text
    assert store.path.read_bytes() == before
    assert [node["params"]["value"] for node in graph.nodes.values()] == ["keep me"]


@pytest.mark.asyncio
async def test_reopening_still_refuses_a_protected_reference_only_the_saved_project_holds(workspace):
    """The open project keeps nodes the backend never had (a frontend-only
    node); reopening merges the live canvas into them, and checks the result."""
    graph, store = workspace
    async with await _client() as client:
        made = (await client.post("/api/projects", json={"name": "Open"})).json()
        project_id = made["project"]["id"]
        with store.transaction() as catalog:
            catalog["projects"][project_id]["snapshot"]["nodes"].append(_rf("frontend-only", _secret()))
            catalog["projects"][project_id]["_backendNodeIds"] = []
            store.commit(catalog)
        before = store.path.read_bytes()
        response = await client.post(f"/api/projects/{project_id}/open",
                                     json={"workspaceRevision": made["workspaceRevision"]}, headers=AGENT)
    assert response.status_code == 400, response.text
    assert store.path.read_bytes() == before
    assert graph.nodes == {}


@pytest.mark.asyncio
async def test_recover_still_refuses_a_protected_reference(workspace):
    _graph, store = workspace
    async with await _client() as client:
        made = (await client.post("/api/projects", json={"name": "Dunes"})).json()
        before = store.path.read_bytes()
        response = await client.post("/api/projects/recover", json={
            "sourceProjectId": made["project"]["id"], "recoveryId": uuid4().hex,
            "snapshot": _snapshot("fine", _secret())})
    assert response.status_code == 400, response.text
    assert store.path.read_bytes() == before


@pytest.mark.asyncio
async def test_import_still_refuses_a_protected_reference(workspace):
    graph, _store = workspace
    async with await _client() as client:
        await client.post("/api/projects", json={"name": "Dunes"})
        graph.add_node("text-input", {"value": "keep me"})
        response = await client.post("/api/graph/import", json={
            "nodes": [{"id": "a", "definitionId": "text-input", "params": {"value": "fine"},
                       "outputs": {"text": {"type": "Text", "value": _secret()}}}], "edges": []})
    assert response.status_code == 400, response.text
    assert [node["params"]["value"] for node in graph.nodes.values()] == ["keep me"]


@pytest.mark.asyncio
async def test_save_and_its_handoff_still_refuse_a_protected_reference(workspace):
    _graph, store = workspace
    async with await _client() as client:
        first = (await client.post("/api/projects", json={"name": "First"})).json()
        first_id = first["project"]["id"]
        response = await client.put(f"/api/projects/{first_id}", json={
            "workspaceRevision": first["workspaceRevision"], "snapshot": _snapshot(_secret())})
        assert response.status_code == 400, response.text
        # An agent switches away: the tab's last save lands as a handoff, checked the same way.
        await client.post("/api/projects", json={"name": "Agent's", "workspaceRevision": first["workspaceRevision"]},
                          headers=AGENT)
        assert store.read()["handoff"]["projectId"] == first_id
        before = store.path.read_bytes()
        response = await client.put(f"/api/projects/{first_id}", json={
            "workspaceRevision": first["workspaceRevision"], "snapshot": _snapshot(_secret())})
    assert response.status_code == 400, response.text
    assert store.path.read_bytes() == before


@pytest.mark.asyncio
async def test_a_refusal_keeps_its_place_behind_missing_and_stale(workspace):
    """The check's 400 still comes after the route's own 404 and 409, as when
    it ran inside the transaction."""
    _graph, store = workspace
    async with await _client() as client:
        made = (await client.post("/api/projects", json={"name": "Dunes"})).json()
        bad = _seed(store, "Bad", _snapshot(_secret()))
        stale = await client.post(f"/api/projects/{bad}/open", json={"workspaceRevision": "stale"})
        assert stale.status_code == 409, stale.text
        missing = await client.put(f"/api/projects/{uuid4().hex}", json={
            "workspaceRevision": made["workspaceRevision"], "snapshot": _snapshot(_secret())})
        assert missing.status_code == 404, missing.text
        stale_save = await client.put(f"/api/projects/{made['project']['id']}", json={
            "workspaceRevision": "stale", "snapshot": _snapshot(_secret())})
        assert stale_save.status_code == 409, stale_save.text


@pytest.mark.asyncio
@pytest.mark.parametrize("refusal", ["stale", "run-active"])
async def test_an_open_that_will_be_refused_does_not_wait_for_the_check(workspace, slow_check, monkeypatch, refusal):
    """A stale revision or an active run refuses the open (409) before staging,
    so it answered at once when the check ran inside the transaction. Checking
    a large project first, in the thread, only to refuse it, made that 409
    wait the whole check (seconds) and spent a worker on nothing."""
    _graph, store = workspace
    async with await _client() as client:
        current = (await client.post("/api/projects", json={"name": "Current"})).json()
        big = _seed(store, "Big", _snapshot(SLOW, "a dune"))
        revision = "stale" if refusal == "stale" else current["workspaceRevision"]
        if refusal == "run-active":
            monkeypatch.setattr(main_module, "_synchronous_workspace_runs", {"run-1"})
        started = time.monotonic()
        response = await client.post(f"/api/projects/{big}/open", json={"workspaceRevision": revision})
        took = time.monotonic() - started
    assert response.status_code == 409, response.text
    assert took < DELAY / 2, f"the refusal waited {took:.2f}s for a check it didn't need"
    assert not slow_check, "the whole snapshot was checked for an open that was refused"
    assert store.read()["activeProjectId"] == current["project"]["id"]


@pytest.mark.asyncio
async def test_an_open_refused_ahead_but_then_allowed_is_still_checked(workspace, monkeypatch):
    """The early refusal only skips the thread: if the run ends (or the state
    changes) before the transaction, the open goes ahead and is checked
    inline, so a protected reference is still refused."""
    graph, store = workspace
    async with await _client() as client:
        current = (await client.post("/api/projects", json={"name": "Current"})).json()
        bad = _seed(store, "Bad", _snapshot(_secret()))
        runs = {"run-1"}
        monkeypatch.setattr(main_module, "_synchronous_workspace_runs", runs)
        real = main_module._projects_live_export

        async def run_ends_then_export():
            runs.clear()
            return await real()

        monkeypatch.setattr(main_module, "_projects_live_export", run_ends_then_export)
        response = await client.post(f"/api/projects/{bad}/open", json={"workspaceRevision": current["workspaceRevision"]})
    assert response.status_code == 400, response.text
    assert store.read()["activeProjectId"] == current["project"]["id"]
    assert graph.nodes == {}


# -- the check decides on what is committed -------------------------------------

def _change_before_commit(monkeypatch, store, project_id, value):
    """Between the open's threaded check and its commit: another writer (a
    handoff save, another process) changes the project being opened. The
    open's live export runs right before its transaction, so a write there
    lands after any check made before it."""
    real = main_module._projects_live_export

    async def export_then_change():
        exported = await real()
        with store.transaction() as catalog:
            catalog["projects"][project_id]["snapshot"]["nodes"][0]["data"]["params"]["value"] = value
            store.commit(catalog)
        return exported

    monkeypatch.setattr(main_module, "_projects_live_export", export_then_change)


@pytest.mark.asyncio
async def test_a_project_changed_after_the_check_is_checked_again(workspace, monkeypatch):
    _graph, store = workspace
    async with await _client() as client:
        current = (await client.post("/api/projects", json={"name": "Current"})).json()
        target = _seed(store, "Target", _snapshot("fine at check time"))
        _change_before_commit(monkeypatch, store, target, _secret())
        response = await client.post(f"/api/projects/{target}/open", json={"workspaceRevision": current["workspaceRevision"]})
    assert response.status_code == 400, response.text
    catalog = store.read()
    assert catalog["activeProjectId"] == current["project"]["id"]


@pytest.mark.asyncio
async def test_a_project_changed_after_the_check_opens_as_changed(workspace, monkeypatch):
    graph, store = workspace
    async with await _client() as client:
        current = (await client.post("/api/projects", json={"name": "Current"})).json()
        target = _seed(store, "Target", _snapshot("before"))
        _change_before_commit(monkeypatch, store, target, "after")
        response = await client.post(f"/api/projects/{target}/open", json={"workspaceRevision": current["workspaceRevision"]})
    assert response.status_code == 200, response.text
    assert [node["params"]["value"] for node in graph.nodes.values()] == ["after"]


# -- an open and an autosave at once ---------------------------------------------

@pytest.mark.asyncio
@pytest.mark.parametrize("by", ["person", "agent"])
async def test_an_open_lands_while_an_autosave_is_still_checking(workspace, slow_check, person, by):
    """As before: the open answers without waiting for the save. When the
    person switched (another of their tabs), the save then finds the project
    switched and is refused (409); when an agent did, it lands as the tab's
    handoff (_save_handoff). Either way the live canvas went into the project
    the switch left."""
    graph, store = workspace
    async with await _client() as client:
        first = (await client.post("/api/projects", json={"name": "First"}, headers=person.headers)).json()
        first_id = first["project"]["id"]
        graph.add_node("text-input", {"value": "live"})
        second = _seed(store, "Second", _snapshot("second"))
        save = asyncio.ensure_future(client.put(f"/api/projects/{first_id}", json={
            "workspaceRevision": first["workspaceRevision"], "snapshot": _snapshot("tab", history=[SLOW])},
            headers=person.headers))
        await asyncio.sleep(0.1)
        opened = await client.post(f"/api/projects/{second}/open", json={"workspaceRevision": first["workspaceRevision"]},
                                   headers=person.headers if by == "person" else AGENT)
        assert not save.done()
        saved = await save
    assert opened.status_code == 200, opened.text
    if by == "person":
        assert saved.status_code == 409, saved.text
    else:
        assert saved.status_code == 200 and saved.json()["handoff"] is True, saved.text
        assert [record["id"] for record in store.read()["projects"][first_id]["snapshot"]["runHistory"]] == [SLOW]
    catalog = store.read()
    assert catalog["activeProjectId"] == second
    assert [node["data"]["params"]["value"] for node in catalog["projects"][first_id]["snapshot"]["nodes"]] == ["live"]
    assert [node["params"]["value"] for node in graph.nodes.values()] == ["second"]


@pytest.mark.asyncio
async def test_an_autosave_lands_while_an_open_is_still_checking(workspace, slow_check, person):
    """The other order: the save the tab sent during a slow open is no longer
    held up behind it. It lands first (the project is still the open one),
    then the open merges the live canvas over it and switches. Before, the
    save waited out the open and was refused (409), dropping what only the tab
    held (here its run record)."""
    graph, store = workspace
    async with await _client() as client:
        first = (await client.post("/api/projects", json={"name": "First"}, headers=person.headers)).json()
        first_id = first["project"]["id"]
        graph.add_node("text-input", {"value": "live"})
        second = _seed(store, "Second", _snapshot(SLOW))
        opening = asyncio.ensure_future(client.post(f"/api/projects/{second}/open",
                                                    json={"workspaceRevision": first["workspaceRevision"]},
                                                    headers=person.headers))
        await asyncio.sleep(0.1)
        exported = await main_module.export_graph_for_frontend()
        tab = {**_snapshot(), "nodes": exported["nodes"],
               "runHistory": [{"id": "tab-run", "status": "complete", "startedAt": 1, "snapshot": {"nodes": [], "edges": []}}]}
        saved = await client.put(f"/api/projects/{first_id}", json={"workspaceRevision": first["workspaceRevision"], "snapshot": tab},
                                 headers=person.headers)
        assert not opening.done()
        opened = await opening
    assert saved.status_code == 200, saved.text
    assert opened.status_code == 200, opened.text
    catalog = store.read()
    assert catalog["activeProjectId"] == second
    left = catalog["projects"][first_id]["snapshot"]
    assert [record["id"] for record in left["runHistory"]] == ["tab-run"]
    assert [node["data"]["params"]["value"] for node in left["nodes"]] == ["live"]
    assert [node["params"]["value"] for node in graph.nodes.values()] == [SLOW]


@pytest.mark.asyncio
async def test_a_reopen_checks_the_live_canvas_it_commits(workspace, slow_check):
    """Reopening merges the live canvas in; an edit that lands while the
    threaded check runs is in what gets committed, so that is checked too (a
    stand-in for any value the check would refuse, put straight on the graph)."""
    graph, store = workspace
    async with await _client() as client:
        made = (await client.post("/api/projects", json={"name": "Open"})).json()
        graph.add_node("text-input", {"value": SLOW})
        before = store.path.read_bytes()
        reopening = asyncio.ensure_future(client.post(f"/api/projects/{made['project']['id']}/open",
                                                      json={"workspaceRevision": made["workspaceRevision"]}, headers=AGENT))
        await asyncio.sleep(0.1)
        assert not reopening.done()
        graph.add_node("text-input", {"value": _secret()})
        response = await reopening
    assert response.status_code == 400, response.text
    assert store.path.read_bytes() == before


def test_the_unlocked_read_does_not_wait_for_the_catalog_lock(tmp_path):
    """The open's threaded check reads the catalog without its lock, which the
    loop takes: a thread holding it would stall the loop."""
    import threading

    store = ProjectStore(tmp_path / "projects")
    project_id = _seed(store, "Dunes", _snapshot("a dune"))
    held, release = threading.Event(), threading.Event()

    def hold():
        with store.transaction():
            held.set()
            release.wait(5)

    holder = threading.Thread(target=hold)
    holder.start()
    try:
        assert held.wait(5)
        started = time.monotonic()
        catalog = store.read_unlocked()
        assert time.monotonic() - started < 1
        assert project_id in catalog["projects"]
    finally:
        release.set()
        holder.join()
