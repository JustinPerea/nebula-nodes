"""An autosave must not stall the backend: Accept's run waited on it.

Live check, 2026-10-20 (isolated backend, 16 Accepts): after a few runs an
Accept took up to 24 s to answer and its run started only once the canvas's
autosave (PUT /api/projects/{id}) finished. That save checked every string in
the project for protected file paths (validate_file_references) on the event
loop: 2,505 strings, 125 of them distinct, about 4 ms each, 10 to 35 s with a
40-node canvas and 15 run records. Every request and every canvas event
waited behind it.
"""
from __future__ import annotations

import asyncio
import sys
import time
from pathlib import Path
from unittest.mock import AsyncMock

import httpx
import pytest

sys.path.insert(0, str(Path(__file__).resolve().parent.parent))
import main as main_module
from services import file_access
from services.cli_graph import CLIGraph
from services.execution_runs import ExecutionRunRegistry
from services.node_errors import NodeErrors
from services.project_store import ProjectStore
from services.provider_recovery import ProviderRecoveryStore
from services.provider_start_guard import ProviderStartGuard


def test_each_distinct_string_is_checked_once(monkeypatch):
    checked: list[str] = []
    monkeypatch.setattr(file_access, "require_allowed_path", lambda value: checked.append(str(value)) or Path(value))
    run = {"nodes": [{"id": "n1", "type": "model-node", "data": {"label": "Prompt", "params": {"value": "a dune"}}}]}
    file_access.validate_file_references({"runHistory": [run] * 50, "nodes": run["nodes"] * 20})
    assert sorted(checked) == sorted({"n1", "model-node", "Prompt", "a dune"})


def test_a_protected_path_is_still_refused_wherever_it_repeats(tmp_path, monkeypatch):
    secret = tmp_path / "settings.json"
    secret.write_text("{}", encoding="utf-8")

    def refuse(value):
        if str(value) == str(secret):
            raise file_access.ProtectedPathError("Protected file access is not allowed")
        return Path(value)

    monkeypatch.setattr(file_access, "require_allowed_path", refuse)
    with pytest.raises(file_access.ProtectedPathError):
        file_access.validate_file_references({"a": ["fine"] * 10, "b": [{"filePath": str(secret)}] * 3})


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


@pytest.mark.asyncio
async def test_an_autosave_does_not_hold_up_other_requests(workspace, person, monkeypatch):
    """While the save checks its snapshot, the loop keeps serving (a stand-in
    check that takes 0.6 s of blocking work, as the real one did with more)."""
    graph, _store = workspace
    transport = httpx.ASGITransport(app=main_module.app)
    async with httpx.AsyncClient(transport=transport, base_url="http://127.0.0.1") as client:
        made = (await client.post("/api/projects", json={"name": "Dunes"}, headers=person.headers)).json()
        graph.add_node("text-input", {"value": "a dune"})
        snapshot = (await client.get(f"/api/projects/{made['project']['id']}")).json()["snapshot"]

        real = main_module.validate_file_references

        def slow(value):
            if isinstance(value, dict) and "runHistory" in value:
                time.sleep(0.6)
            return real(value)

        monkeypatch.setattr(main_module, "validate_file_references", slow)
        gaps: list[float] = []
        stop = asyncio.Event()

        async def ticker():
            last = time.monotonic()
            while not stop.is_set():
                await asyncio.sleep(0.01)
                now = time.monotonic()
                gaps.append(now - last)
                last = now

        ticking = asyncio.create_task(ticker())
        saved = await client.put(f"/api/projects/{made['project']['id']}",
                                 json={"snapshot": snapshot, "workspaceRevision": made["workspaceRevision"]},
                                 headers=person.headers)
        stop.set()
        await ticking
    assert saved.status_code == 200, saved.text
    assert max(gaps) < 0.3, f"the event loop stalled {max(gaps):.2f}s during the save"


def test_the_open_project_and_revision_are_read_without_copying_the_catalog(tmp_path, monkeypatch):
    """Every canvas event names the open project and revision (_workspace_context).
    Reading them used to parse, upgrade and deep-copy the whole catalog, every
    project's snapshot and run history, once per event."""
    from services.project_store import make_project

    store = ProjectStore(tmp_path / "projects")
    assert store.workspace() == {"activeProjectId": None, "workspaceRevision": store.read()["workspaceRevision"]}
    with store.transaction() as catalog:
        project = make_project("Dunes")
        catalog["projects"][project["id"]] = project
        catalog["activeProjectId"] = project["id"]
        store.commit(catalog)
    full = store.read()
    reads: list[bool] = []
    real = store._read
    monkeypatch.setattr(store, "_read", lambda **kw: reads.append(True) or real(**kw))
    for _ in range(20):
        assert store.workspace() == {"activeProjectId": project["id"], "workspaceRevision": full["workspaceRevision"]}
    assert len(reads) <= 1
    # A commit (here or in another process) is seen at once.
    with store.transaction() as catalog:
        catalog["workspaceRevision"] = "next"
        store.commit(catalog)
    assert store.workspace()["workspaceRevision"] == "next"


def test_canvas_events_do_not_read_the_whole_catalog(workspace, person, monkeypatch):
    _graph, store = workspace
    from fastapi.testclient import TestClient
    client = TestClient(main_module.app)
    made = client.post("/api/projects", json={"name": "Dunes"}, headers=person.headers).json()
    monkeypatch.setattr(store, "read", lambda: pytest.fail("a canvas event read the whole project catalog"))
    context = main_module._workspace_context()
    assert context["activeProjectId"] == made["project"]["id"]
    assert context["workspaceRevision"] == made["workspaceRevision"]
