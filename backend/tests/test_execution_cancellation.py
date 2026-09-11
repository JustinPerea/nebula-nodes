from __future__ import annotations

import asyncio
from unittest.mock import AsyncMock

import pytest

import main as main_module
from execution.engine import execute_graph
from models import ExecuteNodeRequest, ExecuteRequest, GraphNode
from models.events import (
    ErrorEvent,
    GraphCancelledEvent,
    GraphCompleteEvent,
    ProviderRecoveryEvent,
)
from services.execution_runs import ExecutionRunRegistry
from services.provider_recovery import ProviderRecoveryPersistenceError


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
async def test_registry_marks_event_only_engine_failure_as_failed(monkeypatch) -> None:
    main_module.execution_runs.clear()
    broadcast_raw = AsyncMock()
    monkeypatch.setattr(main_module.manager, "broadcast_raw", broadcast_raw)

    async def fake_execute_graph(**kwargs) -> None:
        await kwargs["emit"](
            ErrorEvent(
                node_id="n1",
                error="provider rejected input",
                run_id="event-failure",
            )
        )

    monkeypatch.setattr(main_module, "execute_graph", fake_execute_graph)
    response = await main_module.execute(
        ExecuteRequest(
            nodes=[
                GraphNode(
                    id="n1",
                    definitionId="text-input",
                    params={"value": "hi"},
                    outputs={},
                )
            ],
            edges=[],
            runId="event-failure",
        )
    )
    record = main_module.execution_runs.get(response["runId"])
    assert record is not None
    await record.task
    await asyncio.sleep(0)
    await asyncio.sleep(0)

    assert main_module.execution_runs.get("event-failure").status == "failed"  # type: ignore[union-attr]
    assert main_module.execution_runs.list_statuses() == [
        {"runId": "event-failure", "status": "failed"}
    ]
    assert {
        "type": "executionStatus",
        "runId": "event-failure",
        "status": "failed",
    } in [call.args[0] for call in broadcast_raw.await_args_list]
    main_module.execution_runs.clear()


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
async def test_canvas_stop_syncs_recovery_params_before_cancelled_event(
    monkeypatch, single_node: bool,
) -> None:
    """A stopped paid operation must remain resumable in the visible graph."""
    main_module.execution_runs.clear()
    main_module.cli_graph.clear()
    assert main_module.cli_graph.add_node("text-input", {"value": "before"}) == "n1"

    started = asyncio.Event()

    async def fake_execute_graph(**kwargs) -> None:
        kwargs["nodes"][0].params["resume_operation_id"] = "paid-operation-mobile"
        started.set()
        await asyncio.Event().wait()

    sequence: list[str] = []

    async def capture_raw(payload) -> None:
        sequence.append(str(payload.get("type")))

    async def capture_event(event) -> None:
        sequence.append(str(event.type))

    monkeypatch.setattr(main_module, "execute_graph", fake_execute_graph)
    monkeypatch.setattr(main_module.manager, "broadcast_raw", capture_raw)
    monkeypatch.setattr(main_module.manager, "broadcast", capture_event)

    node = GraphNode(
        id="n1",
        definitionId="text-input",
        params={"value": "before"},
        outputs={},
    )
    run_id = "recovery-sync-node" if single_node else "recovery-sync-graph"
    if single_node:
        response = await main_module.execute_node(
            ExecuteNodeRequest(
                nodes=[node],
                edges=[],
                targetNodeId="n1",
                runId=run_id,
            )
        )
    else:
        response = await main_module.execute(
            ExecuteRequest(nodes=[node], edges=[], runId=run_id)
        )

    record = main_module.execution_runs.get(response["runId"])
    assert record is not None
    await asyncio.wait_for(started.wait(), timeout=1)
    await main_module.cancel_execution(run_id)
    with pytest.raises(asyncio.CancelledError):
        await record.task

    assert (
        main_module.cli_graph.nodes["n1"]["params"]["resume_operation_id"]
        == "paid-operation-mobile"
    )
    assert sequence.count("graphSync") == 1
    assert sequence.count("graph_cancelled") == 1
    assert sequence.index("graphSync") < sequence.index("graph_cancelled")

    main_module.execution_runs.clear()
    main_module.cli_graph.clear()


@pytest.mark.asyncio
@pytest.mark.parametrize("single_node", [False, True])
@pytest.mark.parametrize("settled_outcome", ["return", "raise"])
async def test_stop_stays_terminal_when_paid_handshake_absorbs_cancellation(
    monkeypatch, single_node: bool, settled_outcome: str,
) -> None:
    """A settled provider failure cannot turn Stop into success or a stuck run."""
    main_module.execution_runs.clear()
    main_module.cli_graph.clear()
    started = asyncio.Event()
    cancellation_absorbed = asyncio.Event()
    release_handshake = asyncio.Event()

    async def fake_execute_graph(**_kwargs) -> None:
        started.set()
        try:
            await release_handshake.wait()
        except asyncio.CancelledError:
            # Model the World Labs paid POST shield: record Stop, settle the
            # request, then either return through the engine or surface an
            # ordinary parsing/HTTP error.
            cancellation_absorbed.set()
            await release_handshake.wait()
            if settled_outcome == "raise":
                raise RuntimeError("settled provider response was malformed")

    broadcast = AsyncMock()
    monkeypatch.setattr(main_module, "execute_graph", fake_execute_graph)
    monkeypatch.setattr(main_module.manager, "broadcast", broadcast)

    node = GraphNode(
        id="n1",
        definitionId="text-input",
        params={"value": "paid"},
        outputs={},
    )
    run_id = f"settled-{settled_outcome}-{'node' if single_node else 'graph'}"
    if single_node:
        response = await main_module.execute_node(
            ExecuteNodeRequest(
                nodes=[node], edges=[], targetNodeId="n1", runId=run_id
            )
        )
    else:
        response = await main_module.execute(
            ExecuteRequest(nodes=[node], edges=[], runId=run_id)
        )

    record = main_module.execution_runs.get(response["runId"])
    assert record is not None
    await asyncio.wait_for(started.wait(), timeout=1)
    await main_module.cancel_execution(run_id)
    await asyncio.wait_for(cancellation_absorbed.wait(), timeout=1)
    release_handshake.set()
    with pytest.raises(asyncio.CancelledError):
        await record.task
    await asyncio.sleep(0)

    cancelled = [
        call.args[0]
        for call in broadcast.await_args_list
        if isinstance(call.args[0], GraphCancelledEvent)
    ]
    assert len(cancelled) == 1
    assert cancelled[0].run_id == run_id
    assert not any(
        isinstance(call.args[0], GraphCompleteEvent)
        for call in broadcast.await_args_list
    )
    assert main_module.execution_runs.get(run_id).status == "cancelled"  # type: ignore[union-attr]

    main_module.execution_runs.clear()


@pytest.mark.asyncio
async def test_provider_recovery_event_persists_even_while_run_is_cancelling(
    monkeypatch,
) -> None:
    main_module.cli_graph.clear()
    main_module.provider_recovery_store.clear()
    assert main_module.cli_graph.add_node("text-input", {"value": "before"}) == "n1"

    class CancellingRecord:
        status = "cancelling"

    monkeypatch.setattr(
        main_module.execution_runs,
        "get",
        lambda _run_id: CancellingRecord(),
    )
    broadcast = AsyncMock()
    raw_broadcast = AsyncMock()
    monkeypatch.setattr(main_module.manager, "broadcast", broadcast)
    monkeypatch.setattr(main_module.manager, "broadcast_raw", raw_broadcast)

    operation_event = ProviderRecoveryEvent(
        run_id="paid-run",
        node_id="n1",
        resume_operation_id="operation-accepted",
    )
    await main_module._emit_and_sync(operation_event)
    assert (
        main_module.cli_graph.nodes["n1"]["params"]["resume_operation_id"]
        == "operation-accepted"
    )
    assert "existing_world_id" not in main_module.cli_graph.nodes["n1"]["params"]

    world_event = ProviderRecoveryEvent(
        run_id="paid-run",
        node_id="n1",
        existing_world_id="world-complete",
    )
    await main_module._emit_and_sync(world_event)
    params = main_module.cli_graph.nodes["n1"]["params"]
    assert "resume_operation_id" not in params
    assert params["existing_world_id"] == "world-complete"

    assert main_module._event_to_camel(operation_event) == {
        "runId": "paid-run",
        "type": "providerRecovery",
        "nodeId": "n1",
        "resumeOperationId": "operation-accepted",
        "existingWorldId": None,
        "durable": True,
        "warning": None,
    }
    assert broadcast.await_count == 2
    assert raw_broadcast.await_count == 2
    assert all(
        call.args[0]["type"] == "graphSync"
        for call in raw_broadcast.await_args_list
    )
    main_module.cli_graph.clear()
    main_module.provider_recovery_store.clear()


@pytest.mark.asyncio
async def test_unknown_uuid_recovery_survives_in_export_without_graph_insertion(
    monkeypatch,
) -> None:
    main_module.cli_graph.clear()
    main_module.provider_recovery_store.clear()
    broadcast = AsyncMock()
    monkeypatch.setattr(main_module.manager, "broadcast", broadcast)

    event = ProviderRecoveryEvent(
        run_id="uuid-run",
        node_id="7bc8d72d-0000-4000-8000-000000000000",
        resume_operation_id="uuid-paid-operation",
    )
    await main_module._emit_and_sync(event)

    assert main_module.cli_graph.get_state() == {"nodes": [], "edges": []}
    exported = await main_module.export_graph_for_frontend()
    assert exported == {
        "nodes": [],
        "edges": [],
        "empty": True,
        "providerRecoveries": [
            {
                "runId": "uuid-run",
                "nodeId": "7bc8d72d-0000-4000-8000-000000000000",
                "resumeOperationId": "uuid-paid-operation",
                "existingWorldId": None,
            }
        ],
        "providerStartAmbiguities": [],
        "executionStatuses": [],
        "executionCancellationIntents": [],
    }
    broadcast.assert_awaited_once_with(event)
    main_module.provider_recovery_store.clear()


@pytest.mark.asyncio
async def test_recovery_write_failure_keeps_live_id_and_surfaces_warning(
    monkeypatch,
) -> None:
    main_module.cli_graph.clear()
    broadcast = AsyncMock()
    raw_broadcast = AsyncMock()
    monkeypatch.setattr(main_module.manager, "broadcast", broadcast)
    monkeypatch.setattr(main_module.manager, "broadcast_raw", raw_broadcast)
    monkeypatch.setattr(
        main_module.provider_recovery_store,
        "set",
        lambda **_kwargs: (_ for _ in ()).throw(
            ProviderRecoveryPersistenceError("disk full")
        ),
    )

    event = ProviderRecoveryEvent(
        run_id="paid-run",
        node_id="uuid-not-in-cli-graph",
        resume_operation_id="operation-visible-only",
    )
    await main_module._emit_and_sync(event)

    broadcast.assert_awaited_once()
    published = broadcast.await_args.args[0]
    assert isinstance(published, ProviderRecoveryEvent)
    assert published.resume_operation_id == "operation-visible-only"
    assert published.durable is False
    assert published.warning is not None
    assert "copy the ID before reloading" in published.warning
    wire = main_module._event_to_camel(published)
    assert wire["type"] == "providerRecovery"
    assert wire["resumeOperationId"] == "operation-visible-only"
    assert wire["durable"] is False
    assert "copy the ID before reloading" in wire["warning"]
    raw_broadcast.assert_not_awaited()


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
