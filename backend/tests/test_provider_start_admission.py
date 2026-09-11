from __future__ import annotations

import asyncio
from pathlib import Path
from typing import Any
from unittest.mock import AsyncMock

import httpx
import pytest
from fastapi import HTTPException
from starlette.requests import Request

import main as main_module
from models import (
    ExecuteNodeRequest,
    ExecuteRequest,
    GenerateShotRequest,
    GraphEdge,
    GraphNode,
)
from models.events import ExecutedEvent, ProviderStartAmbiguousEvent
from services.execution_runs import ExecutionRunRegistry
from services.provider_recovery import ProviderRecoveryStore
from services.provider_start_guard import ProviderStartConflictError, ProviderStartGuard


ENVIRONMENT = "worldlabs-environment"
EXPORT = "worldlabs-world-export"


@pytest.fixture(autouse=True)
def isolated_paid_start_state(monkeypatch, tmp_path: Path):
    guard = ProviderStartGuard(tmp_path / "provider-starts.json")
    recoveries = ProviderRecoveryStore(tmp_path / "provider-recoveries.json")
    monkeypatch.setattr(main_module, "provider_start_guard", guard)
    monkeypatch.setattr(main_module, "provider_recovery_store", recoveries)
    main_module.execution_runs.clear()
    main_module.cli_graph.clear()
    yield
    main_module.execution_runs.clear()
    main_module.cli_graph.clear()


def _world_node(
    node_id: str = "world-node", params: dict[str, Any] | None = None
) -> GraphNode:
    return GraphNode(
        id=node_id,
        definitionId=ENVIRONMENT,
        params=params or {},
        outputs={},
    )


def _export_node(params: dict[str, Any]) -> GraphNode:
    return GraphNode(
        id="export-node", definitionId=EXPORT, params=params, outputs={}
    )


def _malicious_cinema_node(node_id: str = "cinema") -> GraphNode:
    return GraphNode(
        id=node_id,
        definitionId="cinema-scene",
        params={
            "scene": {
                "version": 1,
                "base": {"model": ENVIRONMENT},
                "shots": [{"id": "shot-1", "prompt": "unsafe"}],
            }
        },
        outputs={},
    )


def test_paid_claim_classification_excludes_recovery_and_free_ply() -> None:
    nodes = [
        _world_node("fresh"),
        _world_node("resume", {"resume_operation_id": "operation-1"}),
        _world_node("existing", {"existing_world_id": "world-1"}),
        _export_node({"format": "ply"}),
        GraphNode(
            id="fresh-glb",
            definitionId=EXPORT,
            params={"format": "glb"},
            outputs={},
        ),
        GraphNode(
            id="resume-glb",
            definitionId=EXPORT,
            params={"format": "glb", "resume_operation_id": "export-op"},
            outputs={},
        ),
    ]

    assert main_module._fresh_paid_worldlabs_claims(nodes) == [
        (ENVIRONMENT, "fresh"),
        (EXPORT, "fresh-glb"),
    ]


@pytest.mark.asyncio
async def test_stop_arriving_before_execute_admission_blocks_paid_start() -> None:
    run_id = "cancel-before-paid-admission"
    assert await main_module.cancel_execution(run_id) == {
        "runId": run_id,
        "status": "cancelled",
        "pendingAdmission": True,
    }

    with pytest.raises(HTTPException) as exc_info:
        await main_module.execute(
            ExecuteRequest(nodes=[_world_node()], edges=[], runId=run_id)
        )

    assert exc_info.value.status_code == 409
    assert "cancelled before it started" in str(exc_info.value.detail)
    assert main_module.provider_start_guard.has_active() is False
    # The exact tombstone is compacted immediately, but the durable Bloom
    # filter permanently denies the delayed run ID.
    assert main_module.execution_runs.list_statuses() == []


@pytest.mark.asyncio
@pytest.mark.parametrize(
    ("definition_id", "recovery_params", "fresh_params"),
    [
        (ENVIRONMENT, {"resume_operation_id": "operation-old"}, {}),
        (ENVIRONMENT, {"existing_world_id": "world-old"}, {}),
        (EXPORT, {"format": "glb", "resume_operation_id": "export-old"}, {"format": "glb"}),
        # The supplied operation identity is authoritative even when a stale
        # graph labels it PLY. Only a truly fresh PLY conversion is free.
        (EXPORT, {"format": "ply", "resume_operation_id": "export-old-ply"}, {"format": "glb"}),
    ],
)
async def test_recovery_admission_blocks_immediate_stale_fresh_payload(
    monkeypatch,
    definition_id: str,
    recovery_params: dict[str, Any],
    fresh_params: dict[str, Any],
) -> None:
    monkeypatch.setattr(main_module, "validate_graph", lambda *_args: [])
    node_id = "shared-world-node"
    recovery_node = GraphNode(
        id=node_id,
        definitionId=definition_id,
        params=recovery_params,
        outputs={},
    )
    started = await main_module.execute_node(
        ExecuteNodeRequest(
            nodes=[recovery_node],
            edges=[],
            targetNodeId=node_id,
            runId="recovery-run",
        )
    )

    with pytest.raises(HTTPException) as stale_error:
        await main_module.execute_node(
            ExecuteNodeRequest(
                nodes=[
                    GraphNode(
                        id=node_id,
                        definitionId=definition_id,
                        params=fresh_params,
                        outputs={},
                    )
                ],
                edges=[],
                targetNodeId=node_id,
                runId="stale-fresh-run",
            )
        )

    assert stale_error.value.status_code == 409
    record = main_module.execution_runs.get(started["runId"])
    assert record is not None
    record.task.cancel()
    await asyncio.gather(record.task, return_exceptions=True)
    await asyncio.sleep(0)
    await asyncio.sleep(0)
    assert main_module.provider_start_guard.has_active() is False


@pytest.mark.asyncio
async def test_many_pre_admission_stops_compact_without_reenabling_old_ids(
    monkeypatch,
) -> None:
    registry = ExecutionRunRegistry(max_records=2)
    monkeypatch.setattr(main_module, "execution_runs", registry)
    for index in range(260):
        response = await main_module.cancel_execution(f"stopped-{index}")
        assert response["status"] == "cancelled"
    assert main_module.provider_start_guard.list_cancel_intents() == []
    assert registry.list_statuses() == []

    with pytest.raises(HTTPException) as victim_error:
        await main_module.execute(
            ExecuteRequest(
                nodes=[_world_node()],
                edges=[],
                runId="stopped-0",
            )
        )
    assert victim_error.value.status_code == 409
    assert main_module.provider_start_guard.has_active() is False

    # A genuinely new run remains admissible after more than the old exact
    # 256-record ceiling.
    main_module.provider_start_guard.assert_run_admissible("fresh-run")
    registry.assert_admissible("fresh-run")


@pytest.mark.asyncio
async def test_cancel_compaction_recovers_capacity_but_old_run_stays_denied(
    monkeypatch,
) -> None:
    registry = ExecutionRunRegistry(max_records=1)
    monkeypatch.setattr(main_module, "execution_runs", registry)
    main_module.provider_start_guard.record_cancel_intent("delayed-old-run")
    registry.cancel("delayed-old-run")

    compacted = await main_module.acknowledge_execution_cancellation(
        "delayed-old-run"
    )
    assert compacted == {
        "status": "compacted",
        "runId": "delayed-old-run",
        "removed": True,
    }
    assert registry.cancel_requested_before_start("delayed-old-run") is False
    assert main_module.provider_start_guard.list_cancel_intents() == []

    with pytest.raises(HTTPException) as delayed_error:
        await main_module.execute(
            ExecuteRequest(
                nodes=[_world_node()],
                edges=[],
                runId="delayed-old-run",
            )
        )
    assert delayed_error.value.status_code == 409

    # Exact inspection capacity is available for a different Stop intent.
    assert await main_module.cancel_execution("new-stop") == {
        "runId": "new-stop",
        "status": "cancelled",
        "pendingAdmission": True,
    }


@pytest.mark.asyncio
async def test_more_than_256_tracked_stop_cycles_do_not_brick_admission() -> None:
    for index in range(260):
        run_id = f"tracked-stop-{index}"

        async def wait_forever() -> None:
            await asyncio.Event().wait()

        task = asyncio.create_task(wait_forever())
        main_module.execution_runs.register(run_id, task)
        response = await main_module.cancel_execution(run_id)
        assert response["status"] in {"cancelling", "cancelled"}
        await asyncio.gather(task, return_exceptions=True)
        for _attempt in range(10):
            if run_id not in main_module.provider_start_guard.list_cancel_intents():
                break
            await asyncio.sleep(0)
        assert run_id not in main_module.provider_start_guard.list_cancel_intents()

    assert main_module.provider_start_guard.list_cancel_intents() == []
    with pytest.raises(HTTPException) as old_run_error:
        await main_module.execute(
            ExecuteRequest(
                nodes=[_world_node()],
                edges=[],
                runId="tracked-stop-0",
            )
        )
    assert old_run_error.value.status_code == 409
    main_module.provider_start_guard.assert_run_admissible("brand-new-run")


@pytest.mark.asyncio
async def test_active_owner_observes_stop_from_second_backend(
    monkeypatch,
) -> None:
    monkeypatch.setattr(main_module, "validate_graph", lambda *_args: [])
    started = asyncio.Event()
    cancelled = asyncio.Event()

    async def blocking_execution(**_kwargs) -> None:
        started.set()
        try:
            await asyncio.Event().wait()
        except asyncio.CancelledError:
            cancelled.set()
            raise

    monkeypatch.setattr(main_module, "execute_graph", blocking_execution)
    response = await main_module.execute_node(
        ExecuteNodeRequest(
            nodes=[_world_node()],
            edges=[],
            targetNodeId="world-node",
            runId="cross-backend-active",
        )
    )
    record = main_module.execution_runs.get(response["runId"])
    assert record is not None
    await asyncio.wait_for(started.wait(), timeout=1)

    second_backend = ProviderStartGuard(main_module.provider_start_guard._path)
    second_backend.record_cancel_intent("cross-backend-active")

    await asyncio.wait_for(cancelled.wait(), timeout=2)
    await asyncio.gather(record.task, return_exceptions=True)
    await asyncio.sleep(0)
    assert record.status == "cancelled"
    assert main_module.provider_start_guard.has_active() is False
    second_backend.close()


def test_stale_blank_payload_is_blocked_by_recovery_journal() -> None:
    main_module.provider_recovery_store.set(
        run_id="accepted-run",
        node_id="world-node",
        resume_operation_id="accepted-operation",
        existing_world_id=None,
    )

    with pytest.raises(HTTPException) as exc_info:
        main_module._claim_fresh_paid_worldlabs_starts(
            run_id="stale-tab", nodes=[_world_node()]
        )

    assert exc_info.value.status_code == 409
    assert "already has a recovery checkpoint" in str(exc_info.value.detail)
    # An explicit recovery payload is safe and bypasses the fresh-start claim.
    main_module._claim_fresh_paid_worldlabs_starts(
        run_id="safe-recovery",
        nodes=[_world_node(params={"resume_operation_id": "accepted-operation"})],
    )
    assert main_module.provider_start_guard.has_active() is True
    main_module.provider_start_guard.release_run("safe-recovery")
    assert main_module.provider_start_guard.has_active() is False


def test_multi_node_paid_start_reserves_recovery_capacity_before_traffic(
    monkeypatch, tmp_path: Path
) -> None:
    constrained = ProviderRecoveryStore(
        tmp_path / "constrained-recoveries.json", max_records=1
    )
    monkeypatch.setattr(main_module, "provider_recovery_store", constrained)

    with pytest.raises(HTTPException) as exc_info:
        main_module._claim_fresh_paid_worldlabs_starts(
            run_id="two-worlds",
            nodes=[_world_node("world-a"), _world_node("world-b")],
        )

    assert exc_info.value.status_code == 409
    assert "at capacity" in str(exc_info.value.detail)
    assert main_module.provider_start_guard.has_active() is False


@pytest.mark.asyncio
async def test_concurrent_same_node_execute_sends_exactly_one_provider_post(
    monkeypatch,
) -> None:
    monkeypatch.setattr(
        main_module,
        "load_settings",
        lambda: {"apiKeys": {"WORLDLABS_API_KEY": "test-key"}},
    )
    post_started = asyncio.Event()
    release_post = asyncio.Event()
    post_count = 0

    async def delayed_post(
        _client: httpx.AsyncClient, url: str, **_kwargs: Any
    ) -> httpx.Response:
        nonlocal post_count
        post_count += 1
        post_started.set()
        await release_post.wait()
        return httpx.Response(
            200,
            json={"operation_id": "accepted-operation", "done": False},
            request=httpx.Request("POST", url),
        )

    monkeypatch.setattr(
        "handlers.worldlabs.httpx.AsyncClient.post", delayed_post
    )

    prompt = GraphNode(
        id="prompt", definitionId="text-input", params={"value": "a place"}, outputs={}
    )
    world = _world_node()
    edge = GraphEdge(
        id="prompt-world",
        source="prompt",
        sourceHandle="text",
        target="world-node",
        targetHandle="prompt",
    )
    first = await main_module.execute_node(
        ExecuteNodeRequest(
            nodes=[prompt, world],
            edges=[edge],
            targetNodeId="world-node",
            runId="first-run",
        )
    )
    await asyncio.wait_for(post_started.wait(), timeout=2)

    with pytest.raises(HTTPException) as exc_info:
        await main_module.execute_node(
            ExecuteNodeRequest(
                nodes=[prompt, world],
                edges=[edge],
                targetNodeId="world-node",
                runId="second-run",
            )
        )
    assert exc_info.value.status_code == 409
    assert post_count == 1

    record = main_module.execution_runs.get(first["runId"])
    assert record is not None
    await main_module.cancel_execution(first["runId"])
    release_post.set()
    with pytest.raises(asyncio.CancelledError):
        await record.task
    assert post_count == 1
    assert main_module.provider_start_guard.has_active() is False


@pytest.mark.asyncio
@pytest.mark.parametrize("status_code", [307, 308, 408])
async def test_uncertain_provider_status_durably_blocks_subsequent_fresh_start(
    monkeypatch,
    status_code: int,
) -> None:
    monkeypatch.setattr(
        main_module,
        "load_settings",
        lambda: {"apiKeys": {"WORLDLABS_API_KEY": "test-key"}},
    )
    post_count = 0

    async def timeout_post(
        _client: httpx.AsyncClient, url: str, **_kwargs: Any
    ) -> httpx.Response:
        nonlocal post_count
        post_count += 1
        return httpx.Response(
            status_code,
            text="uncertain response",
            request=httpx.Request("POST", url),
        )

    monkeypatch.setattr("handlers.worldlabs.httpx.AsyncClient.post", timeout_post)
    prompt = GraphNode(
        id="prompt", definitionId="text-input", params={"value": "a place"}, outputs={}
    )
    world = _world_node()
    edge = GraphEdge(
        id="prompt-world",
        source="prompt",
        sourceHandle="text",
        target="world-node",
        targetHandle="prompt",
    )
    response = await main_module.execute_node(
        ExecuteNodeRequest(
            nodes=[prompt, world],
            edges=[edge],
            targetNodeId="world-node",
            runId=f"uncertain-{status_code}",
        )
    )
    record = main_module.execution_runs.get(response["runId"])
    assert record is not None
    await record.task
    await asyncio.sleep(0)

    assert post_count == 1
    assert main_module.provider_start_guard.list()[0]["durable"] is True
    with pytest.raises(HTTPException) as retry_error:
        await main_module.execute_node(
            ExecuteNodeRequest(
                nodes=[prompt, _world_node("different-world-node")],
                edges=[
                    GraphEdge(
                        id="prompt-world-two",
                        source="prompt",
                        sourceHandle="text",
                        target="different-world-node",
                        targetHandle="prompt",
                    )
                ],
                targetNodeId="different-world-node",
                runId="unsafe-retry",
            )
        )
    assert retry_error.value.status_code == 409
    assert post_count == 1


@pytest.mark.asyncio
async def test_ambiguity_event_persists_and_emits_while_cancelling(
    monkeypatch,
) -> None:
    main_module.provider_start_guard.claim(
        run_id="paid-run", claims=[(ENVIRONMENT, "world-node")]
    )

    class CancellingRecord:
        status = "cancelling"

    monkeypatch.setattr(
        main_module.execution_runs, "get", lambda _run_id: CancellingRecord()
    )
    broadcast = AsyncMock()
    raw_broadcast = AsyncMock()
    monkeypatch.setattr(main_module.manager, "broadcast", broadcast)
    monkeypatch.setattr(main_module.manager, "broadcast_raw", raw_broadcast)

    event = ProviderStartAmbiguousEvent(
        run_id="paid-run",
        node_id="world-node",
        kind=ENVIRONMENT,
        message="untrusted response",
    )
    await main_module._emit_and_sync(event)

    published = broadcast.await_args.args[0]
    assert isinstance(published, ProviderStartAmbiguousEvent)
    assert published.run_id == "paid-run"
    assert published.durable is True
    assert main_module._event_to_camel(published) == {
        "runId": "paid-run",
        "type": "providerStartAmbiguous",
        "nodeId": "world-node",
        "kind": ENVIRONMENT,
        "message": main_module.provider_start_guard.list()[0]["message"],
        "durable": True,
    }
    assert raw_broadcast.await_args.args[0]["type"] == "graphSync"
    assert raw_broadcast.await_args.args[0]["providerStartAmbiguities"] == (
        main_module.provider_start_guard.list()
    )


@pytest.mark.asyncio
async def test_graph_run_participates_in_paid_admission(monkeypatch) -> None:
    main_module.cli_graph.add_node(ENVIRONMENT, {})
    started = asyncio.Event()
    release = asyncio.Event()
    calls = 0

    async def fake_execute_graph(**_kwargs: Any) -> None:
        nonlocal calls
        calls += 1
        started.set()
        await release.wait()

    monkeypatch.setattr(main_module, "execute_graph", fake_execute_graph)
    request = Request({"type": "http", "method": "POST", "path": "/api/graph/run", "headers": []})
    first = asyncio.create_task(main_module.run_graph(request, {}))
    await asyncio.wait_for(started.wait(), timeout=1)

    with pytest.raises(HTTPException) as exc_info:
        main_module._claim_fresh_paid_worldlabs_starts(
            run_id="parallel", nodes=[_world_node("n1")]
        )
    assert exc_info.value.status_code == 409
    assert calls == 1
    release.set()
    await first
    assert main_module.provider_start_guard.has_active() is False


@pytest.mark.asyncio
@pytest.mark.parametrize("definition_id", [ENVIRONMENT, EXPORT])
async def test_quick_rejects_worldlabs_before_execution(
    monkeypatch, definition_id: str
) -> None:
    execute_graph = AsyncMock()
    monkeypatch.setattr(main_module, "execute_graph", execute_graph)

    with pytest.raises(HTTPException) as exc_info:
        await main_module.quick_execute(
            {"definitionId": definition_id, "inputs": {}, "params": {}}
        )

    assert exc_info.value.status_code == 409
    assert "cannot run through /api/quick" in str(exc_info.value.detail)
    execute_graph.assert_not_awaited()


@pytest.mark.asyncio
async def test_cinema_nested_dispatch_cannot_reach_worldlabs_from_any_route(
    monkeypatch,
) -> None:
    cinema = _malicious_cinema_node()
    execute_graph = AsyncMock()
    world_post = AsyncMock()
    monkeypatch.setattr(main_module, "execute_graph", execute_graph)
    monkeypatch.setattr(
        "handlers.worldlabs.httpx.AsyncClient.post",
        world_post,
    )

    with pytest.raises(HTTPException) as execute_error:
        await main_module.execute(
            ExecuteRequest(nodes=[cinema], edges=[], runId="nested-canvas")
        )
    assert execute_error.value.status_code == 400

    with pytest.raises(HTTPException) as node_error:
        await main_module.execute_node(
            ExecuteNodeRequest(
                nodes=[cinema],
                edges=[],
                targetNodeId="cinema",
                runId="nested-node",
            )
        )
    assert node_error.value.status_code == 400

    main_module.cli_graph.add_node("cinema-scene", cinema.params)
    request = Request(
        {
            "type": "http",
            "method": "POST",
            "path": "/api/graph/run",
            "headers": [],
        }
    )
    with pytest.raises(HTTPException) as graph_run_error:
        await main_module.run_graph(request, {})
    assert graph_run_error.value.status_code == 400

    with pytest.raises(HTTPException) as quick_error:
        await main_module.quick_execute(
            {
                "definitionId": "cinema-scene",
                "inputs": {},
                "params": cinema.params,
            }
        )
    assert quick_error.value.status_code == 400

    with pytest.raises(HTTPException) as shot_error:
        await main_module.generate_cinema_shot(
            GenerateShotRequest(
                nodes=[cinema],
                edges=[],
                nodeId="cinema",
                shotId="shot-1",
            )
        )
    assert shot_error.value.status_code == 400
    assert "Unsupported cinema base model" in str(shot_error.value.detail)
    execute_graph.assert_not_awaited()
    world_post.assert_not_awaited()


@pytest.mark.asyncio
async def test_graph_clear_import_and_bundle_restore_reject_active_paid_start() -> None:
    main_module.cli_graph.add_node("text-input", {"value": "preserve"})
    main_module.provider_start_guard.claim(
        run_id="active", claims=[(ENVIRONMENT, "world-node")]
    )

    with pytest.raises(HTTPException) as clear_error:
        await main_module.clear_graph()
    assert clear_error.value.status_code == 409
    assert main_module.cli_graph.nodes

    with pytest.raises(HTTPException) as import_error:
        await main_module.import_graph({"nodes": [], "edges": []})
    assert import_error.value.status_code == 409
    assert main_module.cli_graph.nodes

    request = Request(
        {
            "type": "http",
            "method": "POST",
            "path": "/api/outputs/restore",
            "headers": [],
        }
    )
    with pytest.raises(HTTPException) as restore_error:
        await main_module.restore_outputs(request)
    assert restore_error.value.status_code == 409


@pytest.mark.asyncio
async def test_ack_route_and_export_schema(monkeypatch) -> None:
    main_module.provider_start_guard.mark_ambiguous(
        run_id="ambiguous", node_id="world-node", kind=ENVIRONMENT
    )
    monkeypatch.setattr(main_module.manager, "broadcast_raw", AsyncMock())

    exported = await main_module.export_graph_for_frontend()
    assert exported["providerStartAmbiguities"] == (
        main_module.provider_start_guard.list()
    )
    result = await main_module.acknowledge_provider_start_ambiguity(
        ENVIRONMENT, "world-node", "ambiguous"
    )
    assert result == {
        "status": "acknowledged",
        "kind": ENVIRONMENT,
        "nodeId": "world-node",
        "runId": "ambiguous",
        "removed": True,
    }
    assert main_module.provider_start_guard.list() == []

    repeated = await main_module.acknowledge_provider_start_ambiguity(
        ENVIRONMENT,
        "world-node",
        "ambiguous",
    )
    assert repeated["removed"] is False


@pytest.mark.asyncio
async def test_stale_route_ack_cannot_delete_newer_same_node_hold() -> None:
    main_module.provider_start_guard.mark_ambiguous(
        run_id="new-run", node_id="world-node", kind=ENVIRONMENT
    )

    with pytest.raises(HTTPException) as stale_error:
        await main_module.acknowledge_provider_start_ambiguity(
            ENVIRONMENT,
            "world-node",
            "old-run",
        )

    assert stale_error.value.status_code == 409
    assert main_module.provider_start_guard.list()[0]["runId"] == "new-run"


@pytest.mark.asyncio
async def test_exact_ack_keeps_volatile_live_recovery_params() -> None:
    node_id = main_module.cli_graph.add_node(
        ENVIRONMENT,
        {"resume_operation_id": "volatile-operation"},
    )
    main_module.provider_start_guard.mark_ambiguous(
        run_id="volatile-run", node_id=node_id, kind=ENVIRONMENT
    )

    await main_module.acknowledge_provider_start_ambiguity(
        ENVIRONMENT,
        node_id,
        "volatile-run",
    )

    assert (
        main_module.cli_graph.nodes[node_id]["params"]["resume_operation_id"]
        == "volatile-operation"
    )


@pytest.mark.asyncio
async def test_exact_ack_never_clears_durable_live_recovery_params() -> None:
    node_id = main_module.cli_graph.add_node(
        ENVIRONMENT,
        {"resume_operation_id": "durable-operation"},
    )
    main_module.provider_recovery_store.set(
        run_id="durable-run",
        node_id=node_id,
        resume_operation_id="durable-operation",
        existing_world_id=None,
    )
    main_module.provider_start_guard.mark_ambiguous(
        run_id="durable-run", node_id=node_id, kind=ENVIRONMENT
    )

    await main_module.acknowledge_provider_start_ambiguity(
        ENVIRONMENT,
        node_id,
        "durable-run",
    )

    assert (
        main_module.cli_graph.nodes[node_id]["params"]["resume_operation_id"]
        == "durable-operation"
    )


@pytest.mark.asyncio
async def test_ack_and_recovery_delete_reject_active_node() -> None:
    main_module.provider_start_guard.claim(
        run_id="active", claims=[(ENVIRONMENT, "world-node")]
    )
    main_module.provider_start_guard.mark_ambiguous(
        run_id="active", node_id="world-node", kind=ENVIRONMENT
    )
    main_module.provider_recovery_store.set(
        run_id="active",
        node_id="world-node",
        resume_operation_id="operation-live",
        existing_world_id=None,
    )

    with pytest.raises(HTTPException) as ack_error:
        await main_module.acknowledge_provider_start_ambiguity(
            ENVIRONMENT, "world-node", "active"
        )
    assert ack_error.value.status_code == 409
    assert main_module.provider_start_guard.list()

    with pytest.raises(HTTPException) as recovery_error:
        await main_module.delete_provider_recovery(
            "active",
            "world-node",
            resume_operation_id="operation-live",
        )
    assert recovery_error.value.status_code == 409
    assert main_module.provider_recovery_store.list()

    main_module.provider_start_guard.release_run("active")
    await main_module.acknowledge_provider_start_ambiguity(
        ENVIRONMENT, "world-node", "active"
    )
    await main_module.delete_provider_recovery(
        "active",
        "world-node",
        resume_operation_id="operation-live",
    )


@pytest.mark.asyncio
async def test_clear_refuses_unresolved_ambiguity_until_exact_ack() -> None:
    main_module.cli_graph.add_node("text-input", {"value": "preserve"})
    main_module.provider_start_guard.mark_ambiguous(
        run_id="ambiguous", node_id="world-node", kind=ENVIRONMENT
    )

    with pytest.raises(HTTPException) as clear_error:
        await main_module.clear_graph()
    assert clear_error.value.status_code == 409
    assert main_module.provider_start_guard.list()
    assert main_module.cli_graph.nodes

    await main_module.acknowledge_provider_start_ambiguity(
        ENVIRONMENT, "world-node", "ambiguous"
    )
    assert await main_module.clear_graph() == {"status": "cleared"}


def test_ambiguity_blocks_fresh_node_with_new_identity() -> None:
    main_module.provider_start_guard.mark_ambiguous(
        run_id="uncertain", node_id="world-old", kind=ENVIRONMENT
    )

    with pytest.raises(HTTPException) as exc_info:
        main_module._claim_fresh_paid_worldlabs_starts(
            run_id="new-tab", nodes=[_world_node("world-new")]
        )

    assert exc_info.value.status_code == 409
    assert "world-old" in str(exc_info.value.detail)


@pytest.mark.asyncio
async def test_imported_recovery_is_shared_across_backends_before_graph_commit(
    monkeypatch,
) -> None:
    imported = await main_module.import_graph(
        {
            "nodes": [
                {
                    "id": "saved-world",
                    "definitionId": ENVIRONMENT,
                    "params": {"resume_operation_id": "imported-operation"},
                    "outputs": {},
                }
            ],
            "edges": [],
        }
    )
    node_id = imported["idMap"]["saved-world"]
    second_backend_store = ProviderRecoveryStore(
        main_module.provider_recovery_store._path
    )
    assert second_backend_store.list()[0]["nodeId"] == node_id
    assert second_backend_store.list()[0]["resumeOperationId"] == (
        "imported-operation"
    )

    # Emulate an already-running worker whose process-local cli_graph never saw
    # the import. Shared recovery control state must still close the blank-start
    # admission path.
    stale_worker_graph = main_module.cli_graph.clone()
    stale_worker_graph.clear()
    second_backend_guard = ProviderStartGuard(main_module.provider_start_guard._path)
    with monkeypatch.context() as stale_worker:
        stale_worker.setattr(main_module, "cli_graph", stale_worker_graph)
        stale_worker.setattr(
            main_module, "provider_recovery_store", second_backend_store
        )
        stale_worker.setattr(
            main_module, "provider_start_guard", second_backend_guard
        )

        with pytest.raises(HTTPException) as stale_error:
            main_module._claim_fresh_paid_worldlabs_starts(
                run_id="stale-import-tab",
                nodes=[_world_node(node_id)],
            )

    assert stale_error.value.status_code == 409
    assert "recovery checkpoint" in str(stale_error.value.detail)
    assert second_backend_guard.has_active() is False
    second_backend_guard.close()


@pytest.mark.asyncio
async def test_graph_create_update_and_cluster_seed_shared_recoveries() -> None:
    created = await main_module.create_graph_node(
        {
            "definitionId": ENVIRONMENT,
            "params": {"resume_operation_id": "created-operation"},
        }
    )
    text_id = main_module.cli_graph.add_node("text-input", {"value": "x"})
    world_id = main_module.cli_graph.add_node(ENVIRONMENT, {})
    request = Request(
        {
            "type": "http",
            "method": "PUT",
            "path": f"/api/graph/node/{world_id}",
            "headers": [],
        }
    )
    await main_module.update_graph_node(
        request,
        world_id,
        {"params": {"existing_world_id": "updated-world"}},
    )
    clustered = await main_module.add_graph_cluster(
        {
            "nodes": [
                {
                    "tempId": "saved-export",
                    "definitionId": EXPORT,
                    "params": {
                        "format": "ply",
                        "resume_operation_id": "paid-export-operation",
                    },
                }
            ],
            "edges": [],
        }
    )

    shared = ProviderRecoveryStore(main_module.provider_recovery_store._path)
    records = shared.list()
    assert {
        (record["nodeId"], record["resumeOperationId"], record["existingWorldId"])
        for record in records
    } >= {
        (created["id"], "created-operation", None),
        (world_id, None, "updated-world"),
        (clustered["nodes"][0]["id"], "paid-export-operation", None),
    }
    assert text_id in main_module.cli_graph.nodes


@pytest.mark.asyncio
async def test_graph_recovery_seed_failure_aborts_import_before_commit(
    monkeypatch,
) -> None:
    preserved_id = main_module.cli_graph.add_node(
        "text-input", {"value": "preserve"}
    )

    def fail_seed(**_kwargs) -> list[dict[str, Any]]:
        from services.provider_recovery import ProviderRecoveryPersistenceError

        raise ProviderRecoveryPersistenceError("disk unavailable")

    monkeypatch.setattr(
        main_module.provider_recovery_store,
        "ensure_many",
        fail_seed,
    )
    with pytest.raises(HTTPException) as import_error:
        await main_module.import_graph(
            {
                "nodes": [
                    {
                        "id": "saved-world",
                        "definitionId": ENVIRONMENT,
                        "params": {"resume_operation_id": "accepted-operation"},
                        "outputs": {},
                    }
                ],
                "edges": [],
            }
        )

    assert import_error.value.status_code == 507
    assert list(main_module.cli_graph.nodes) == [preserved_id]


@pytest.mark.asyncio
async def test_world_port_type_mismatch_is_rejected_by_connect_import_and_cluster() -> None:
    source_id = main_module.cli_graph.add_node(ENVIRONMENT, {})
    target_id = main_module.cli_graph.add_node(ENVIRONMENT, {})
    incompatible_edge = {
        "source": source_id,
        "sourceHandle": "world",
        "target": target_id,
        "targetHandle": "prompt",
    }
    with pytest.raises(HTTPException) as connect_error:
        await main_module.connect_graph_nodes(incompatible_edge)
    assert connect_error.value.status_code == 400
    assert "World" in str(connect_error.value.detail)
    assert "Text" in str(connect_error.value.detail)

    imported_body = {
        "nodes": [
            {"id": "source", "definitionId": ENVIRONMENT, "params": {}},
            {"id": "target", "definitionId": ENVIRONMENT, "params": {}},
        ],
        "edges": [
            {
                "source": "source",
                "sourceHandle": "world",
                "target": "target",
                "targetHandle": "prompt",
            }
        ],
    }
    existing_ids = set(main_module.cli_graph.nodes)
    with pytest.raises(HTTPException) as import_error:
        await main_module.import_graph(imported_body)
    assert import_error.value.status_code == 400
    assert set(main_module.cli_graph.nodes) == existing_ids

    cluster_body = {
        "nodes": [
            {"tempId": "source", "definitionId": ENVIRONMENT, "params": {}},
            {"tempId": "target", "definitionId": ENVIRONMENT, "params": {}},
        ],
        "edges": [
            {
                "source": "source",
                "sourceHandle": "world",
                "target": "target",
                "targetHandle": "prompt",
            }
        ],
    }
    with pytest.raises(HTTPException) as cluster_error:
        await main_module.add_graph_cluster(cluster_body)
    assert cluster_error.value.status_code == 400
    assert set(main_module.cli_graph.nodes) == existing_ids


@pytest.mark.asyncio
async def test_world_port_connects_to_world_or_any_only() -> None:
    source_id = main_module.cli_graph.add_node(ENVIRONMENT, {})
    export_id = main_module.cli_graph.add_node(EXPORT, {"format": "ply"})
    connected = await main_module.connect_graph_nodes(
        {
            "source": source_id,
            "sourceHandle": "world",
            "target": export_id,
            "targetHandle": "world",
        }
    )
    assert connected["connection"] == f"{source_id}:world -> {export_id}:world"


@pytest.mark.asyncio
async def test_deferred_bootstrap_seeds_legacy_checkpoint_before_clear(
    monkeypatch,
) -> None:
    node_id = main_module.cli_graph.add_node(
        ENVIRONMENT,
        {"resume_operation_id": "legacy-operation"},
    )
    monkeypatch.setattr(
        main_module,
        "_graph_recovery_bootstrap_error",
        "another backend held the paid lifecycle during boot",
    )

    with pytest.raises(HTTPException) as clear_error:
        await main_module.clear_graph()

    assert clear_error.value.status_code == 409
    assert node_id in main_module.cli_graph.nodes
    record = ProviderRecoveryStore(
        main_module.provider_recovery_store._path
    ).list()[0]
    assert record["nodeId"] == node_id
    assert record["resumeOperationId"] == "legacy-operation"
    assert main_module._graph_recovery_bootstrap_error is None


@pytest.mark.asyncio
async def test_stale_node_put_cannot_erase_server_owned_recovery(
    monkeypatch,
) -> None:
    node_id = main_module.cli_graph.add_node(
        ENVIRONMENT,
        {
            "model": "marble-1.1",
            "resume_operation_id": "operation-new",
        },
    )
    monkeypatch.setattr(main_module.manager, "broadcast_raw", AsyncMock())
    request = Request(
        {
            "type": "http",
            "method": "PUT",
            "path": f"/api/graph/node/{node_id}",
            "headers": [],
        }
    )

    updated = await main_module.update_graph_node(
        request,
        node_id,
        {
            "params": {
                "model": "marble-1.1-plus",
                "resume_operation_id": "",
                "existing_world_id": "",
            }
        },
    )

    assert updated["params"]["model"] == "marble-1.1-plus"
    assert updated["params"]["resume_operation_id"] == "operation-new"
    assert "existing_world_id" not in updated["params"]


@pytest.mark.asyncio
async def test_exact_recovery_delete_clears_only_matching_live_checkpoint(
    monkeypatch,
) -> None:
    node_id = main_module.cli_graph.add_node(
        ENVIRONMENT, {"resume_operation_id": "operation-current"}
    )
    main_module.provider_recovery_store.set(
        run_id="paid-run",
        node_id=node_id,
        resume_operation_id="operation-current",
        existing_world_id=None,
    )
    monkeypatch.setattr(main_module.manager, "broadcast_raw", AsyncMock())

    await main_module.delete_provider_recovery(
        "paid-run",
        node_id,
        resume_operation_id="operation-current",
    )

    assert "resume_operation_id" not in main_module.cli_graph.nodes[node_id]["params"]
    assert "existing_world_id" not in main_module.cli_graph.nodes[node_id]["params"]


@pytest.mark.asyncio
async def test_stale_recovery_delete_cannot_remove_reused_run_node_record() -> None:
    node_id = main_module.cli_graph.add_node(
        ENVIRONMENT, {"resume_operation_id": "new-operation"}
    )
    main_module.provider_recovery_store.set(
        run_id="reused-run",
        node_id=node_id,
        resume_operation_id="new-operation",
        existing_world_id=None,
    )

    with pytest.raises(HTTPException) as stale_error:
        await main_module.delete_provider_recovery(
            "reused-run",
            node_id,
            resume_operation_id="old-operation",
        )
    assert stale_error.value.status_code == 409
    assert (
        main_module.provider_recovery_store.list()[0]["resumeOperationId"]
        == "new-operation"
    )
    assert (
        main_module.cli_graph.nodes[node_id]["params"]["resume_operation_id"]
        == "new-operation"
    )


@pytest.mark.asyncio
async def test_missing_exact_recovery_delete_is_idempotent() -> None:
    response = await main_module.delete_provider_recovery(
        "already-deleted",
        "old-node",
        resume_operation_id="old-operation",
    )
    assert response == {
        "status": "deleted",
        "runId": "already-deleted",
        "nodeId": "old-node",
        "removed": False,
    }


@pytest.mark.asyncio
async def test_node_delete_rejects_active_and_journaled_paid_state() -> None:
    node_id = main_module.cli_graph.add_node(ENVIRONMENT, {})
    main_module.provider_start_guard.claim(
        run_id="active", claims=[(ENVIRONMENT, node_id)]
    )

    with pytest.raises(HTTPException) as active_error:
        await main_module.delete_graph_node(node_id)
    assert active_error.value.status_code == 409
    assert node_id in main_module.cli_graph.nodes

    main_module.provider_start_guard.mark_ambiguous(
        run_id="active", node_id=node_id, kind=ENVIRONMENT
    )
    main_module.provider_start_guard.release_run("active")
    with pytest.raises(HTTPException) as held_error:
        await main_module.delete_graph_node(node_id)
    assert held_error.value.status_code == 409
    assert node_id in main_module.cli_graph.nodes


@pytest.mark.asyncio
@pytest.mark.parametrize("operation", ["clear", "import", "cluster"])
async def test_graph_replacement_commit_holds_cross_backend_paid_fence(
    monkeypatch,
    operation: str,
) -> None:
    competing = ProviderStartGuard(main_module.provider_start_guard._path)
    blocked: list[bool] = []

    if operation == "clear":
        original = main_module.cli_graph.clear

        def commit() -> None:
            # The autouse fixture clears once more during teardown after the
            # route has released its fence; only probe the actual route commit.
            if not blocked:
                with pytest.raises(ProviderStartConflictError):
                    competing.claim(
                        run_id="other-backend",
                        claims=[(ENVIRONMENT, "old-world")],
                    )
                blocked.append(True)
            original()

        monkeypatch.setattr(main_module.cli_graph, "clear", commit)
        await main_module.clear_graph()
    else:
        original = main_module.cli_graph.replace_with

        def commit(candidate) -> None:
            with pytest.raises(ProviderStartConflictError):
                competing.claim(
                    run_id="other-backend",
                    claims=[(ENVIRONMENT, "old-world")],
                )
            blocked.append(True)
            original(candidate)

        monkeypatch.setattr(main_module.cli_graph, "replace_with", commit)
        if operation == "import":
            await main_module.import_graph({"nodes": [], "edges": []})
        else:
            await main_module.add_graph_cluster({"nodes": [], "edges": []})

    assert blocked == [True]
    competing.close()


@pytest.mark.asyncio
@pytest.mark.parametrize("operation", ["update", "delete"])
async def test_node_destructive_commit_holds_cross_backend_paid_fence(
    monkeypatch,
    operation: str,
) -> None:
    node_id = main_module.cli_graph.add_node("text-input", {"value": "old"})
    competing = ProviderStartGuard(main_module.provider_start_guard._path)
    blocked: list[bool] = []

    if operation == "update":
        original = main_module.cli_graph.update_params

        def commit(target_id: str, params: dict[str, Any]) -> None:
            with pytest.raises(ProviderStartConflictError):
                competing.claim(
                    run_id="other-backend",
                    claims=[(ENVIRONMENT, "old-world")],
                )
            blocked.append(True)
            original(target_id, params)

        monkeypatch.setattr(main_module.cli_graph, "update_params", commit)
        request = Request(
            {
                "type": "http",
                "method": "PUT",
                "path": f"/api/graph/node/{node_id}",
                "headers": [],
            }
        )
        await main_module.update_graph_node(
            request,
            node_id,
            {"params": {"value": "new"}},
        )
    else:
        original = main_module.cli_graph.remove_node

        def commit(target_id: str) -> None:
            with pytest.raises(ProviderStartConflictError):
                competing.claim(
                    run_id="other-backend",
                    claims=[(ENVIRONMENT, "old-world")],
                )
            blocked.append(True)
            original(target_id)

        monkeypatch.setattr(main_module.cli_graph, "remove_node", commit)
        await main_module.delete_graph_node(node_id)

    assert blocked == [True]
    competing.close()


@pytest.mark.asyncio
async def test_cinema_shot_rejects_fresh_paid_world_ancestor(
    monkeypatch,
) -> None:
    world = _world_node()
    cinema = GraphNode(
        id="cinema",
        definitionId="cinema-scene",
        params={"scene": {"shots": [{"id": "shot-1"}]}},
        outputs={},
    )
    monkeypatch.setattr(
        main_module,
        "get_subgraph",
        lambda _nodes, _edges, _target: ([world, cinema], []),
    )
    execute_graph = AsyncMock()
    monkeypatch.setattr(main_module, "execute_graph", execute_graph)

    with pytest.raises(HTTPException) as exc_info:
        await main_module.generate_cinema_shot(
            GenerateShotRequest(
                nodes=[world, cinema],
                edges=[],
                nodeId="cinema",
                shotId="shot-1",
            )
        )

    assert exc_info.value.status_code == 409
    assert "Run those World nodes on the Canvas first" in str(exc_info.value.detail)
    execute_graph.assert_not_awaited()


@pytest.mark.asyncio
async def test_cinema_shot_recovery_ancestor_holds_lease_until_terminal(
    monkeypatch,
) -> None:
    world = _world_node(
        params={"resume_operation_id": "shot-recovery-operation"}
    )
    cinema = GraphNode(
        id="cinema",
        definitionId="cinema-scene",
        params={"scene": {"shots": [{"id": "shot-1"}]}},
        outputs={},
    )
    monkeypatch.setattr(
        main_module,
        "get_subgraph",
        lambda _nodes, _edges, _target: ([world, cinema], []),
    )
    monkeypatch.setattr(main_module, "validate_graph", lambda *_args: [])
    started = asyncio.Event()
    release = asyncio.Event()

    async def delayed_execute_graph(**kwargs: Any) -> None:
        started.set()
        await release.wait()
        await kwargs["emit"](
            ExecutedEvent(
                node_id="cinema",
                outputs={
                    "shot_shot-1": {
                        "type": "Image",
                        "value": "/api/outputs/generated-shot.png",
                    }
                },
            )
        )

    monkeypatch.setattr(main_module, "execute_graph", delayed_execute_graph)

    response = await main_module.generate_cinema_shot(
        GenerateShotRequest(
            nodes=[world, cinema],
            edges=[],
            nodeId="cinema",
            shotId="shot-1",
            runId="cinema-recovery-run",
        )
    )

    assert response["status"] == "started"
    assert response["runId"] == "cinema-recovery-run"
    assert main_module.provider_start_guard.has_active_node("world-node") is True

    with pytest.raises(HTTPException) as delete_error:
        await main_module.delete_provider_recovery(
            "cinema-recovery-run",
            "world-node",
            resume_operation_id="shot-recovery-operation",
        )
    assert delete_error.value.status_code == 409

    with pytest.raises(HTTPException) as fresh_error:
        main_module._claim_fresh_paid_worldlabs_starts(
            run_id="stale-blank-run",
            nodes=[_world_node("other-world")],
        )
    assert fresh_error.value.status_code == 409

    release.set()
    await asyncio.wait_for(started.wait(), timeout=1)
    for _attempt in range(20):
        if not main_module.provider_start_guard.has_active_node("world-node"):
            break
        await asyncio.sleep(0)
    assert main_module.provider_start_guard.has_active_node("world-node") is False

    deleted = await main_module.delete_provider_recovery(
        "cinema-recovery-run",
        "world-node",
        resume_operation_id="shot-recovery-operation",
    )
    assert deleted["removed"] is True


@pytest.mark.asyncio
async def test_cinema_shot_pre_first_turn_cancel_releases_recovery_lease(
    monkeypatch,
) -> None:
    world = _world_node(
        params={"resume_operation_id": "pre-turn-recovery-operation"}
    )
    cinema = GraphNode(
        id="cinema",
        definitionId="cinema-scene",
        params={"scene": {"shots": [{"id": "shot-1"}]}},
        outputs={},
    )
    monkeypatch.setattr(
        main_module,
        "get_subgraph",
        lambda _nodes, _edges, _target: ([world, cinema], []),
    )
    monkeypatch.setattr(main_module, "validate_graph", lambda *_args: [])
    execute_graph = AsyncMock()
    monkeypatch.setattr(main_module, "execute_graph", execute_graph)

    response = await main_module.generate_cinema_shot(
        GenerateShotRequest(
            nodes=[world, cinema],
            edges=[],
            nodeId="cinema",
            shotId="shot-1",
            runId="cinema-cancel-before-turn",
        )
    )
    record = main_module.execution_runs.get(response["runId"])
    assert record is not None
    assert main_module.provider_start_guard.has_active_node("world-node") is True

    # generate_cinema_shot does not yield after create_task/register, so this
    # cancellation lands before _run's first bytecode turn and its finally is
    # never entered. The registry terminal callback is the required fallback.
    record.task.cancel()
    await asyncio.gather(record.task, return_exceptions=True)
    for _attempt in range(20):
        if not main_module.provider_start_guard.has_active_node("world-node"):
            break
        await asyncio.sleep(0)

    assert record.task.cancelled() is True
    assert execute_graph.await_count == 0
    assert main_module.provider_start_guard.has_active_node("world-node") is False

    # The leaked-lease failure mode would make this fresh admission 409.
    main_module._claim_fresh_paid_worldlabs_starts(
        run_id="fresh-after-cinema-cancel",
        nodes=[_world_node("fresh-world")],
    )
    await main_module._release_paid_worldlabs_starts(
        "fresh-after-cinema-cancel"
    )
