"""Round 16 of PR #114, M2: a Stop for a run id the backend hasn't registered
yet is a tombstone, and a start still being admitted under that id is refused
at its last check before it registers: it never runs and is never billed.

The tab sends that Stop when its status check answers 404 for a run whose
start answer it lost (frontend graphStore reconcileWorldLabsExecutionStatus).
Before this round the Stop's exact record was compacted at once, and a start
that was already past its first admission check (awaiting the input
measurement) registered and ran anyway. Every run path with a client run id
is covered: /api/execute, /api/execute-node and /api/cinema/generate-shot,
for any provider, not only World Labs.
"""
from __future__ import annotations

import asyncio
from pathlib import Path
from typing import Any
from unittest.mock import AsyncMock

import pytest
from fastapi import HTTPException

import main as main_module
from models import ExecuteNodeRequest, ExecuteRequest, GenerateShotRequest, GraphNode
from services.execution_runs import (
    ExecutionCancelledBeforeStartError,
    ExecutionRunRegistry,
)
from services.provider_recovery import ProviderRecoveryStore
from services.provider_start_guard import ProviderStartGuard

pytestmark = pytest.mark.usefixtures("spending_limits_off")


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


class _Paused:
    """Holds every run start inside its input measurement (the await the
    review named: _measure_run_inputs, before _register_run)."""

    def __init__(self, monkeypatch) -> None:
        self.entered = asyncio.Event()
        self.release = asyncio.Event()
        original = main_module._measure_run_inputs

        async def paused(*args: Any, **kwargs: Any):
            self.entered.set()
            await self.release.wait()
            return await original(*args, **kwargs)

        monkeypatch.setattr(main_module, "_measure_run_inputs", paused)


async def _stop_during_admission(monkeypatch, start) -> tuple[pytest.ExceptionInfo | None, AsyncMock, list[str]]:
    paused = _Paused(monkeypatch)
    execute_graph = AsyncMock()
    monkeypatch.setattr(main_module, "execute_graph", execute_graph)
    returned: list[str] = []
    original_return = main_module._return_hold
    monkeypatch.setattr(main_module, "_return_hold", lambda run_id: (returned.append(run_id), original_return(run_id))[1])

    started = asyncio.create_task(start())
    await asyncio.wait_for(paused.entered.wait(), 5)
    # The tab's Stop, sent after its status check answered 404.
    assert await main_module.cancel_execution("late-run") == {
        "runId": "late-run", "status": "cancelled", "pendingAdmission": True}
    paused.release.set()
    error: pytest.ExceptionInfo | None = None
    try:
        await asyncio.wait_for(started, 5)
    except HTTPException as exc:
        error = exc  # type: ignore[assignment]
    for _ in range(5):
        await asyncio.sleep(0)
    return error, execute_graph, returned


@pytest.mark.asyncio
async def test_execute_refuses_a_start_stopped_while_it_was_being_admitted(monkeypatch) -> None:
    error, execute_graph, returned = await _stop_during_admission(
        monkeypatch, lambda: main_module.execute(ExecuteRequest(nodes=[_text()], edges=[], runId="late-run")))
    assert error is not None and error.status_code == 409
    assert "cancelled before it started" in str(error.detail)
    assert execute_graph.await_count == 0
    assert main_module.execution_runs.get("late-run") is None
    assert "late-run" in returned  # its spend hold goes back: nothing billed


@pytest.mark.asyncio
async def test_execute_node_refuses_a_start_stopped_while_it_was_being_admitted(monkeypatch) -> None:
    error, execute_graph, returned = await _stop_during_admission(
        monkeypatch, lambda: main_module.execute_node(
            ExecuteNodeRequest(nodes=[_text()], edges=[], targetNodeId="n1", runId="late-run")))
    assert error is not None and error.status_code == 409
    assert execute_graph.await_count == 0
    assert main_module.execution_runs.get("late-run") is None
    assert "late-run" in returned


@pytest.mark.asyncio
async def test_cinema_shot_refuses_a_start_stopped_while_it_was_being_admitted(monkeypatch) -> None:
    cinema = GraphNode(id="cinema", definitionId="cinema-scene",
                       params={"scene": {"shots": [{"id": "shot-1"}]}}, outputs={})
    monkeypatch.setattr(main_module, "get_subgraph", lambda _n, _e, _t: ([cinema], []))
    monkeypatch.setattr(main_module, "validate_graph", lambda *_args: [])
    error, execute_graph, returned = await _stop_during_admission(
        monkeypatch, lambda: main_module.generate_cinema_shot(GenerateShotRequest(
            nodes=[cinema], edges=[], nodeId="cinema", shotId="shot-1", runId="late-run")))
    assert error is not None and error.status_code == 409
    assert execute_graph.await_count == 0
    assert main_module.execution_runs.get("late-run") is None
    assert "late-run" in returned


@pytest.mark.asyncio
async def test_status_of_a_tombstoned_run_reads_cancelled_not_unknown() -> None:
    # Round 17 (review 16 L1): an id whose start this process never saw also
    # says it has no record of it, so nobody calls it never-started.
    await main_module.cancel_execution("never-arrived")
    assert await main_module.get_execution_status("never-arrived") == {
        "runId": "never-arrived", "status": "cancelled", "pendingAdmission": True, "noRecord": True}


@pytest.mark.asyncio
async def test_a_stop_for_an_unknown_run_never_starts_anything() -> None:
    # The tombstone only prevents: a Stop for an id nobody started registers
    # nothing and runs nothing.
    await main_module.cancel_execution("ghost")
    assert main_module.execution_runs.get("ghost") is None
    assert main_module.execution_runs.has_active() is False


# -- the registry's own tombstone: bounded and expiring -----------------------


def _task() -> asyncio.Task[None]:
    return asyncio.get_running_loop().create_task(asyncio.sleep(3600))


@pytest.mark.asyncio
async def test_registry_tombstone_survives_compaction_and_refuses_register() -> None:
    registry = ExecutionRunRegistry()
    assert registry.cancel("late") is None
    # The durable journal compacts its exact record (main.py does this at
    # once for an unknown run); the registry's tombstone stays.
    registry.compact_cancel_intent("late")
    task = _task()
    with pytest.raises(ExecutionCancelledBeforeStartError):
        registry.register("late", task)
    await asyncio.gather(task, return_exceptions=True)
    assert task.cancelled()


@pytest.mark.asyncio
async def test_registry_tombstones_expire() -> None:
    now = [1000.0]
    registry = ExecutionRunRegistry(clock=lambda: now[0])
    registry.cancel("late")
    registry.compact_cancel_intent("late")
    now[0] += ExecutionRunRegistry.TOMBSTONE_TTL_SECONDS + 1
    task = _task()
    registry.register("late", task)  # expired: the durable guard is the long-term deny
    task.cancel()
    await asyncio.gather(task, return_exceptions=True)


@pytest.mark.asyncio
async def test_registry_tombstones_are_bounded_and_never_refuse_new_work() -> None:
    registry = ExecutionRunRegistry()
    for index in range(ExecutionRunRegistry.MAX_TOMBSTONES + 50):
        registry.cancel(f"stopped-{index}")
        registry.compact_cancel_intent(f"stopped-{index}")
    assert registry.tombstone_count() == ExecutionRunRegistry.MAX_TOMBSTONES
    # The newest are kept; a brand-new id still registers.
    with pytest.raises(ExecutionCancelledBeforeStartError):
        registry.assert_admissible(f"stopped-{ExecutionRunRegistry.MAX_TOMBSTONES + 49}")
    task = _task()
    registry.register("brand-new", task)
    task.cancel()
    await asyncio.gather(task, return_exceptions=True)


@pytest.mark.asyncio
async def test_durable_deny_still_refuses_after_the_registry_tombstone_expired(monkeypatch) -> None:
    now = [1000.0]
    registry = ExecutionRunRegistry(clock=lambda: now[0])
    monkeypatch.setattr(main_module, "execution_runs", registry)
    await main_module.cancel_execution("old-stop")
    now[0] += ExecutionRunRegistry.TOMBSTONE_TTL_SECONDS + 1
    with pytest.raises(HTTPException) as exc_info:
        await main_module.execute(ExecuteRequest(nodes=[_text()], edges=[], runId="old-stop"))
    assert exc_info.value.status_code == 409


# -- what agents see (MCP and the `nebula` CLI) ------------------------------

STOPPED_BEFORE_START = ("Stopped before it started. Nebula won't start a run with this id, "
                        "so nothing ran and nothing was spent.")


@pytest.mark.asyncio
async def test_get_run_reads_a_tombstoned_run_as_stopped_before_it_started() -> None:
    # Its start reached this process (round 17: only then is it "never started").
    main_module.execution_runs.note_start_begun("ghost-run")
    await main_module.cancel_execution("ghost-run")
    answer = await main_module.get_graph_run("ghost-run")
    assert answer["status"] == "cancelled"
    assert answer["runId"] == "ghost-run"
    assert answer["neverStarted"] is True


def test_mcp_run_result_says_a_tombstoned_run_never_started() -> None:
    import json

    import mcp_server

    parts = mcp_server._run_result({"runId": "ghost-run", "status": "cancelled", "neverStarted": True}, None)
    shown = json.loads(parts[0])
    assert shown["neverStarted"] is True
    assert shown["next"] == STOPPED_BEFORE_START


def test_mcp_cancel_run_says_when_the_stop_beat_the_start(monkeypatch) -> None:
    import mcp_server

    monkeypatch.setattr(mcp_server, "_canvas_call", lambda *_a, **_k: {
        "runId": "ghost-run", "status": "cancelled", "pendingAdmission": True})
    answer = mcp_server.cancel_run("ghost-run")
    assert answer["pendingAdmission"] is True
    assert answer["next"] == ("Nebula hadn't started this run yet. The stop is recorded, and Nebula "
                              "won't start a run with this id, so nothing runs and nothing is spent.")


def test_cli_cancel_says_when_the_stop_beat_the_start(capsys) -> None:
    from cli.commands import execute

    class Client:
        def cancel_run(self, run_id: str) -> dict[str, Any]:
            return {"runId": run_id, "status": "cancelled", "pendingAdmission": True}

    execute.run_cancel(Client(), "ghost-run")  # type: ignore[arg-type]
    assert capsys.readouterr().out.strip() == (
        "Run ghost-run hadn't started yet. Nebula won't start it now, so nothing runs and nothing is spent.")


def test_cli_result_says_a_never_started_run_spent_nothing(capsys) -> None:
    from cli.commands import execute

    class Client:
        def get_run(self, run_id: str, wait: float = 0) -> dict[str, Any]:
            return {"runId": run_id, "status": "cancelled", "source": "canvas", "neverStarted": True}

    code = execute.run_result(Client(), "ghost-run")  # type: ignore[arg-type]
    assert code == execute.EXIT_CANCELLED
    assert capsys.readouterr().out.strip() == (
        "Run ghost-run was stopped before it started, so nothing ran and nothing was spent.")
