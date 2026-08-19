from __future__ import annotations

import asyncio
from unittest.mock import AsyncMock

import pytest

import main as main_module
from execution.engine import execute_graph
from models import ExecuteNodeRequest, ExecuteRequest, GraphNode
from models.events import GraphCancelledEvent, GraphCompleteEvent
from services.execution_runs import ExecutionRunRegistry


@pytest.mark.asyncio
async def test_engine_parent_cancellation_cancels_and_awaits_node_tasks() -> None:
    started = asyncio.Event()
    handler_cancelled = asyncio.Event()
    emitted: list[object] = []

    async def blocking_handler(_node, _inputs, _keys):
        started.set()
        try:
            await asyncio.Event().wait()
        except asyncio.CancelledError:
            handler_cancelled.set()
            raise

    async def emit(event) -> None:
        emitted.append(event)

    task = asyncio.create_task(execute_graph(
        nodes=[GraphNode(id="n1", definitionId="blocking", params={}, outputs={})],
        edges=[],
        api_keys={},
        handler_registry={"blocking": blocking_handler},
        emit=emit,
        run_id="cancel-engine",
    ))
    await asyncio.wait_for(started.wait(), timeout=1)
    task.cancel()

    with pytest.raises(asyncio.CancelledError):
        await task
    assert handler_cancelled.is_set()
    assert not any(isinstance(event, GraphCompleteEvent) for event in emitted)


@pytest.mark.asyncio
async def test_registry_cancellation_is_idempotent_and_terminal() -> None:
    registry = ExecutionRunRegistry()
    started = asyncio.Event()

    async def work() -> None:
        started.set()
        await asyncio.Event().wait()

    task = asyncio.create_task(work())
    registry.register("run-1", task)
    await started.wait()

    first = registry.cancel("run-1")
    second = registry.cancel("run-1")
    assert first is second
    assert first is not None and first.status == "cancelling"
    with pytest.raises(asyncio.CancelledError):
        await task
    await asyncio.sleep(0)
    assert registry.get("run-1").status == "cancelled"  # type: ignore[union-attr]
    assert registry.cancel("run-1").status == "cancelled"  # type: ignore[union-attr]


@pytest.mark.asyncio
async def test_execute_cancel_endpoint_stops_backend_task_and_emits_terminal_event(monkeypatch) -> None:
    main_module.execution_runs.clear()
    started = asyncio.Event()
    stopped = asyncio.Event()

    async def fake_execute_graph(**_kwargs) -> None:
        started.set()
        try:
            await asyncio.Event().wait()
        except asyncio.CancelledError:
            stopped.set()
            raise

    broadcast = AsyncMock()
    monkeypatch.setattr(main_module, "execute_graph", fake_execute_graph)
    monkeypatch.setattr(main_module.manager, "broadcast", broadcast)

    request = ExecuteRequest(
        nodes=[GraphNode(id="n1", definitionId="text-input", params={"value": "hi"}, outputs={})],
        edges=[],
        runId="api-cancel-1",
    )
    started_response = await main_module.execute(request)
    assert started_response == {"status": "started", "runId": "api-cancel-1"}
    await asyncio.wait_for(started.wait(), timeout=1)

    cancelled_response = await main_module.cancel_execution("api-cancel-1")
    assert cancelled_response["status"] in {"cancelling", "cancelled"}
    await asyncio.wait_for(stopped.wait(), timeout=1)
    await asyncio.sleep(0)
    assert main_module.execution_runs.get("api-cancel-1").status == "cancelled"  # type: ignore[union-attr]
    assert any(
        isinstance(call.args[0], GraphCancelledEvent)
        and call.args[0].run_id == "api-cancel-1"
        for call in broadcast.await_args_list
    )

    repeated = await main_module.cancel_execution("api-cancel-1")
    assert repeated["status"] == "cancelled"
    main_module.execution_runs.clear()


@pytest.mark.asyncio
@pytest.mark.parametrize("single_node", [False, True])
async def test_canvas_execution_broadcasts_handler_mutated_params(
    monkeypatch, single_node: bool,
) -> None:
    """Canvas execution must hydrate handler-owned editor state immediately.

    ExecutedEvent synchronizes outputs, but video-edit also seeds clips and
    probe metadata on GraphNode.params. Before the regression fix those params
    reached persisted cli_graph only; the open editor remained at 0 clips
    until a browser reload.
    """
    main_module.execution_runs.clear()
    main_module.cli_graph.clear()
    main_module.cli_graph.add_node("text-input", {"value": "before"})

    async def fake_execute_graph(**kwargs) -> None:
        kwargs["nodes"][0].params["value"] = "after"

    raw_broadcast = AsyncMock()
    monkeypatch.setattr(main_module, "execute_graph", fake_execute_graph)
    monkeypatch.setattr(main_module.manager, "broadcast_raw", raw_broadcast)

    node = GraphNode(
        id="n1",
        definitionId="text-input",
        params={"value": "before"},
        outputs={},
    )
    if single_node:
        response = await main_module.execute_node(ExecuteNodeRequest(
            nodes=[node],
            edges=[],
            targetNodeId="n1",
            runId="param-sync-node",
        ))
    else:
        response = await main_module.execute(ExecuteRequest(
            nodes=[node],
            edges=[],
            runId="param-sync-graph",
        ))

    record = main_module.execution_runs.get(response["runId"])
    assert record is not None
    await record.task

    assert main_module.cli_graph.nodes["n1"]["params"]["value"] == "after"
    raw_broadcast.assert_awaited()
    assert any(
        call.args[0].get("type") == "graphSync"
        and call.args[0]["nodes"][0]["data"]["params"]["value"] == "after"
        for call in raw_broadcast.await_args_list
    )
    main_module.execution_runs.clear()
