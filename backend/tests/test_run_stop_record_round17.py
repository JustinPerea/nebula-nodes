"""Round 17 of PR #114.

L1 (review 16): "stopped before it started, nothing was spent" only for a run
id whose start this process saw begin. A Stop for any other id Nebula has no
record of (a run that ran before a restart, one pruned from the registry, a
mistyped id) says so, and says nothing about spend.

L5 (review 16): a refused run start's 507 says which store failed: the
project store (``code: "project_store"``) or a run-safety store
(``code: "run_safeguards"``), so the canvas words each by its cause. A
project-store failure can no longer happen after a run's task exists: the
canvas a run registers on is read before the task is made.

L3 (review 16): a run's own param write-back sync carries ``runParams`` (the
run id), so the canvas never takes it for someone's edit.
"""
from __future__ import annotations

import asyncio
import json
from pathlib import Path
from typing import Any
from unittest.mock import AsyncMock

import pytest
from fastapi import HTTPException
from fastapi.testclient import TestClient

import main as main_module
from models import ExecuteNodeRequest, ExecuteRequest, GraphNode
from services.execution_runs import ExecutionRunRegistry
from services.project_store import ProjectStore, ProjectStoreError
from services.provider_recovery import ProviderRecoveryStore
from services.provider_start_guard import ProviderStartGuard, ProviderStartPersistenceError

pytestmark = pytest.mark.usefixtures("spending_limits_off")

NO_RECORD = ("Nebula has no record of run {id}. If it started before Nebula restarted, "
             "check Run History for what it did.")


@pytest.fixture(autouse=True)
def isolated_run_state(monkeypatch, tmp_path: Path):
    guard = ProviderStartGuard(tmp_path / "provider-starts.json")
    recoveries = ProviderRecoveryStore(tmp_path / "provider-recoveries.json")
    monkeypatch.setattr(main_module, "provider_start_guard", guard)
    monkeypatch.setattr(main_module, "provider_recovery_store", recoveries)
    main_module.execution_runs.clear()
    main_module.cli_graph.clear()
    yield
    main_module.execution_runs.clear()
    main_module.cli_graph.clear()


def _text(node_id: str = "n1") -> GraphNode:
    return GraphNode(id=node_id, definitionId="text-input", params={"value": "x"}, outputs={})


async def _ran_then_restarted(monkeypatch, run_id: str) -> None:
    """Review 16 T4: a run starts and completes, then the backend restarts
    (the registry and run reports are memory-only)."""
    from services.run_reports import run_reports

    ran = AsyncMock()
    monkeypatch.setattr(main_module, "execute_graph", ran)
    await main_module.execute(ExecuteRequest(nodes=[_text()], edges=[], runId=run_id))
    record = main_module.execution_runs.get(run_id)
    await asyncio.wait_for(asyncio.gather(record.task, return_exceptions=True), 5)
    assert ran.await_count == 1
    monkeypatch.setattr(main_module, "execution_runs", ExecutionRunRegistry())
    monkeypatch.setattr(run_reports, "_runs", type(run_reports._runs)())


# -- L1: the backend --------------------------------------------------------------


@pytest.mark.asyncio
async def test_a_stop_for_a_run_that_ran_before_a_restart_says_there_is_no_record(monkeypatch) -> None:
    await _ran_then_restarted(monkeypatch, "t4-run")
    stop = await main_module.cancel_execution("t4-run")
    assert stop == {"runId": "t4-run", "status": "cancelled", "pendingAdmission": True, "noRecord": True}
    # The id is still fenced, and its status says the same.
    assert await main_module.get_execution_status("t4-run") == stop
    got = await main_module.get_graph_run("t4-run")
    assert got == {"runId": "t4-run", "status": "unknown", "source": "canvas", "noRecord": True}
    assert "neverStarted" not in got


@pytest.mark.asyncio
async def test_a_stop_for_an_id_never_seen_says_there_is_no_record() -> None:
    stop = await main_module.cancel_execution("mistyped")
    assert stop["noRecord"] is True
    got = await main_module.get_graph_run("mistyped")
    assert got.get("neverStarted") is None and got["noRecord"] is True


@pytest.mark.asyncio
async def test_a_stop_while_this_process_admits_the_start_still_says_it_never_started(monkeypatch) -> None:
    entered, release = asyncio.Event(), asyncio.Event()
    original = main_module._measure_run_inputs

    async def paused(*args: Any, **kwargs: Any):
        entered.set()
        await release.wait()
        return await original(*args, **kwargs)

    monkeypatch.setattr(main_module, "_measure_run_inputs", paused)
    monkeypatch.setattr(main_module, "execute_graph", AsyncMock())
    started = asyncio.create_task(main_module.execute(ExecuteRequest(nodes=[_text()], edges=[], runId="late")))
    await asyncio.wait_for(entered.wait(), 5)
    assert await main_module.cancel_execution("late") == {
        "runId": "late", "status": "cancelled", "pendingAdmission": True}
    release.set()
    with pytest.raises(HTTPException):
        await asyncio.wait_for(started, 5)
    got = await main_module.get_graph_run("late")
    assert got["neverStarted"] is True and "noRecord" not in got


@pytest.mark.asyncio
async def test_a_run_that_registered_and_was_pruned_has_no_record(monkeypatch) -> None:
    """The start-seen mark goes when the run registers, so a run that ran and
    then left the registry (256 newer runs) isn't called never-started."""
    monkeypatch.setattr(main_module, "execution_runs", ExecutionRunRegistry(max_records=1))
    monkeypatch.setattr(main_module, "execute_graph", AsyncMock())
    for run_id in ("old", "newer", "newest"):
        await main_module.execute(ExecuteRequest(nodes=[_text()], edges=[], runId=run_id))
        record = main_module.execution_runs.get(run_id)
        await asyncio.wait_for(asyncio.gather(record.task, return_exceptions=True), 5)
    assert main_module.execution_runs.get("old") is None
    assert (await main_module.cancel_execution("old"))["noRecord"] is True


def test_the_registry_bounds_what_it_saw_start() -> None:
    now = [0.0]
    registry = ExecutionRunRegistry(clock=lambda: now[0])
    for index in range(ExecutionRunRegistry.MAX_TOMBSTONES + 10):
        registry.note_start_begun(f"run-{index}")
    assert not registry.start_seen("run-0")
    assert registry.start_seen(f"run-{ExecutionRunRegistry.MAX_TOMBSTONES + 9}")
    now[0] += ExecutionRunRegistry.TOMBSTONE_TTL_SECONDS + 1
    assert not registry.start_seen(f"run-{ExecutionRunRegistry.MAX_TOMBSTONES + 9}")


# -- L1: what agents read (MCP and the CLI) --------------------------------------


def test_mcp_cancel_run_for_a_run_with_no_record(monkeypatch) -> None:
    import mcp_server

    monkeypatch.setattr(mcp_server, "_canvas_call", lambda *_a, **_k: {
        "runId": "t4-run", "status": "cancelled", "pendingAdmission": True, "noRecord": True})
    answer = mcp_server.cancel_run("t4-run")
    assert answer["next"] == NO_RECORD.format(id="t4-run")
    assert "spent" not in answer["next"]


def test_mcp_get_run_for_a_run_with_no_record() -> None:
    import mcp_server

    shown = json.loads(mcp_server._run_result(
        {"runId": "t4-run", "status": "unknown", "source": "canvas", "noRecord": True}, None)[0])
    assert shown["noRecord"] is True
    assert shown["next"] == NO_RECORD.format(id="t4-run")


def test_cli_cancel_and_result_for_a_run_with_no_record(capsys) -> None:
    from cli.commands import execute

    class Client:
        def cancel_run(self, run_id: str) -> dict[str, Any]:
            return {"runId": run_id, "status": "cancelled", "pendingAdmission": True, "noRecord": True}

        def get_run(self, run_id: str, wait: float = 0) -> dict[str, Any]:
            return {"runId": run_id, "status": "unknown", "source": "canvas", "noRecord": True}

    execute.run_cancel(Client(), "t4-run")  # type: ignore[arg-type]
    assert capsys.readouterr().out.strip() == NO_RECORD.format(id="t4-run")
    assert execute.run_result(Client(), "t4-run") == 1  # type: ignore[arg-type]
    assert capsys.readouterr().out.strip() == NO_RECORD.format(id="t4-run")


# -- L5: which store a 507 came from ---------------------------------------------


@pytest.fixture
def client_on(tmp_path, monkeypatch):
    store = ProjectStore(tmp_path / "projects")
    monkeypatch.setattr(main_module, "project_store", store)
    return TestClient(main_module.app), store


def test_the_project_stores_507_on_a_run_start_names_its_store(client_on, monkeypatch) -> None:
    client, store = client_on
    execute_graph = AsyncMock()
    monkeypatch.setattr(main_module, "execute_graph", execute_graph)
    store.root.mkdir(parents=True, exist_ok=True)
    store.path.write_text("{not json", encoding="utf-8")
    response = client.post("/api/execute", json={"nodes": [], "edges": [], "runId": "r507"},
                           headers={"X-Nebula-Workspace-Revision": "any",
                                    "X-Nebula-Params-Version": str(main_module.PARAMS_VERSION)})
    assert response.status_code == 507
    assert response.json()["code"] == "project_store"
    assert execute_graph.await_count == 0


def test_a_run_safety_507_names_its_store(client_on, monkeypatch) -> None:
    client, _ = client_on

    def refuse(_run_id: str) -> None:
        raise ProviderStartPersistenceError("journal unreadable")

    monkeypatch.setattr(main_module.provider_start_guard, "assert_run_admissible", refuse)
    response = client.post("/api/execute", json={"nodes": [], "edges": [], "runId": "r-safety"})
    assert response.status_code == 507
    assert response.json()["code"] == "run_safeguards"


@pytest.mark.asyncio
@pytest.mark.parametrize("route", ["execute", "execute-node"])
async def test_a_project_store_failure_as_the_run_registers_starts_nothing(monkeypatch, route) -> None:
    """The canvas a run registers on was read after its task existed: a
    failing read there answered 507 ("nothing was started") while
    /api/execute-node's task, never cancelled, went on and ran."""
    execute_graph = AsyncMock()
    monkeypatch.setattr(main_module, "execute_graph", execute_graph)
    real = main_module._workspace_context
    calls = {"n": 0}

    def flaky() -> dict[str, Any]:
        # Every read before the registration answers; the registration's
        # own read of the canvas fails.
        frame = __import__("inspect").stack()[1]
        if frame.function == "_run_canvas_now":
            calls["n"] += 1
            raise ProjectStoreError("Project storage is unavailable; the canvas was preserved")
        return real()

    monkeypatch.setattr(main_module, "_workspace_context", flaky)
    returned: list[str] = []
    original_return = main_module._return_hold
    monkeypatch.setattr(main_module, "_return_hold", lambda run_id: (returned.append(run_id), original_return(run_id))[1])
    request = (ExecuteRequest(nodes=[_text()], edges=[], runId="flaky") if route == "execute"
               else ExecuteNodeRequest(nodes=[_text()], edges=[], targetNodeId="n1", runId="flaky"))
    with pytest.raises(ProjectStoreError):
        await (main_module.execute(request) if route == "execute" else main_module.execute_node(request))
    for _ in range(10):
        await asyncio.sleep(0)
    assert calls["n"] == 1
    assert execute_graph.await_count == 0
    assert main_module.execution_runs.get("flaky") is None
    assert "flaky" in returned


def test_a_restart_does_not_clear_an_unreadable_catalog_and_fixing_it_does(tmp_path) -> None:
    """GM's restart line for the project store's 507 holds only if a restart
    clears it. It doesn't: nothing about it is kept in memory, and a new
    process reads the same file. Fixing the file clears it with no restart."""
    root = tmp_path / "projects"
    running = ProjectStore(root)
    running.workspace()
    root.mkdir(parents=True, exist_ok=True)
    running.path.write_text("{not json", encoding="utf-8")
    with pytest.raises(ProjectStoreError):
        running.workspace()
    with pytest.raises(ProjectStoreError):
        ProjectStore(root).workspace()  # "restarted"
    running.path.write_text(json.dumps({"version": 1, "projects": {}, "activeProjectId": None,
                                        "workspaceRevision": "fixed"}), encoding="utf-8")
    assert running.workspace()["workspaceRevision"] == "fixed"


# -- L3: a run's param write-back is marked ---------------------------------------


@pytest.mark.asyncio
async def test_a_runs_param_write_back_sync_carries_its_run_id(monkeypatch) -> None:
    broadcast = AsyncMock()
    monkeypatch.setattr(main_module.manager, "broadcast_raw", broadcast)
    monkeypatch.setattr(main_module, "execute_graph", AsyncMock())
    monkeypatch.setattr(main_module, "_sync_params_to_cli_graph", lambda *_a, **_k: True)
    await main_module.execute(ExecuteRequest(nodes=[_text()], edges=[], runId="enriched"))
    record = main_module.execution_runs.get("enriched")
    await asyncio.wait_for(asyncio.gather(record.task, return_exceptions=True), 5)
    syncs = [call.args[0] for call in broadcast.call_args_list if call.args and call.args[0].get("type") == "graphSync"]
    assert syncs and syncs[-1]["runParams"] == "enriched"
    assert "edit" not in syncs[-1]


@pytest.mark.asyncio
async def test_an_ordinary_sync_carries_no_run_marker(monkeypatch) -> None:
    broadcast = AsyncMock()
    monkeypatch.setattr(main_module.manager, "broadcast_raw", broadcast)
    await main_module._broadcast_graph_sync()
    assert "runParams" not in broadcast.call_args.args[0]
