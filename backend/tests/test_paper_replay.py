"""Saved replay executes accepted settings without replacing edited canvas params."""
from __future__ import annotations

import asyncio
import copy
from unittest.mock import AsyncMock

import pytest

import main as main_module
from models.graph import ExecuteNodeRequest, ExecuteRequest, GraphNode
from models.events import ExecutedEvent, GraphCancelledEvent, ProviderRecoveryEvent
from services.cli_graph import CLIGraph
from services.execution_runs import ExecutionRunRegistry
from services.provider_recovery import ProviderRecoveryStore
from services.provider_start_guard import ProviderStartGuard


@pytest.fixture
def replay_runtime(monkeypatch, tmp_path):
    graph = CLIGraph()
    graph.add_node("text-input", {"value": "edited canvas prompt", "seed": 99})
    registry = ExecutionRunRegistry()
    broadcast = AsyncMock()
    monkeypatch.setattr(main_module, "cli_graph", graph)
    monkeypatch.setattr(main_module, "execution_runs", registry)
    monkeypatch.setattr(main_module, "provider_recovery_store", ProviderRecoveryStore(tmp_path / "recovery.json"))
    monkeypatch.setattr(main_module, "provider_start_guard", ProviderStartGuard(tmp_path / "start-guard.json"))
    monkeypatch.setattr(main_module.manager, "broadcast", broadcast)
    monkeypatch.setattr(main_module.manager, "broadcast_raw", AsyncMock())
    monkeypatch.setattr(main_module, "load_settings", lambda: {"apiKeys": {}})
    monkeypatch.setattr(main_module, "_watch_for_cross_process_stop", lambda *_args: None)
    monkeypatch.setattr(main_module, "_claim_fresh_paid_worldlabs_starts", lambda **_kwargs: None)
    monkeypatch.setattr(main_module, "_release_paid_worldlabs_starts", AsyncMock())
    return graph, registry, broadcast


async def start_request(single_node, run_id, preserve, node):
    values = {"nodes": [node], "edges": [], "runId": run_id}
    if preserve:
        values["preserveGraphParams"] = True
    if single_node:
        return await main_module.execute_node(ExecuteNodeRequest(**values, targetNodeId="n1"))
    return await main_module.execute(ExecuteRequest(**values))


@pytest.mark.parametrize("request_type", [ExecuteRequest, ExecuteNodeRequest])
def test_preserve_params_wire_alias_is_optional_and_defaults_to_false(request_type):
    values = {"nodes": [], "edges": []}
    if request_type is ExecuteNodeRequest:
        values["targetNodeId"] = "n1"
    assert request_type(**values).preserve_graph_params is False
    preserved = request_type(**values, preserveGraphParams=True)
    assert preserved.preserve_graph_params is True
    assert preserved.model_dump(by_alias=True)["preserveGraphParams"] is True


@pytest.mark.asyncio
@pytest.mark.parametrize("single_node", [False, True])
@pytest.mark.parametrize("preserve", [False, True])
@pytest.mark.parametrize("outcome", ["success", "cancel", "absorbed-return", "absorbed-error"])
async def test_replay_preserves_live_params_and_ordinary_runs_still_sync_metadata(
    replay_runtime, monkeypatch, single_node, preserve, outcome,
):
    graph, registry, broadcast = replay_runtime
    before = copy.deepcopy(graph.nodes["n1"]["params"])
    started = asyncio.Event()
    accepted = []

    async def fake_execute_graph(**kwargs):
        node = kwargs["nodes"][0]
        accepted.append(copy.deepcopy(node.params))
        node.params["_sourceDuration"] = 1.2
        await kwargs["emit"](ExecutedEvent(node_id="n1", run_id=kwargs["run_id"], outputs={
            "text": {"type": "Text", "value": "saved recipe result"},
        }))
        started.set()
        if outcome == "success":
            return
        try:
            await asyncio.Event().wait()
        except asyncio.CancelledError:
            if outcome == "absorbed-return":
                return
            if outcome == "absorbed-error":
                raise RuntimeError("settled provider response failed")
            raise

    monkeypatch.setattr(main_module, "execute_graph", fake_execute_graph)
    node = GraphNode(id="n1", definitionId="text-input", params={"value": "saved prompt", "seed": 7})
    response = await start_request(single_node, "replay-param-contract", preserve, node)
    record = registry.get(response["runId"])
    assert record is not None
    await asyncio.wait_for(started.wait(), timeout=1)
    if outcome != "success":
        registry.cancel(response["runId"])
        with pytest.raises(asyncio.CancelledError):
            await record.task
        assert sum(isinstance(call.args[0], GraphCancelledEvent) for call in broadcast.await_args_list) == 1
    else:
        await record.task
    assert accepted == [{"value": "saved prompt", "seed": 7}]
    assert graph.nodes["n1"]["params"] == (before if preserve else {
        "value": "saved prompt", "seed": 7, "_sourceDuration": 1.2,
    })
    assert graph.nodes["n1"]["outputs"] == {"text": {"type": "Text", "value": "saved recipe result"}}


@pytest.mark.asyncio
@pytest.mark.parametrize("single_node", [False, True])
async def test_preserved_replay_still_records_late_provider_recovery_after_stop(
    replay_runtime, monkeypatch, single_node,
):
    graph, registry, broadcast = replay_runtime
    before = copy.deepcopy(graph.nodes["n1"]["params"])
    started = asyncio.Event()

    async def fake_execute_graph(**kwargs):
        started.set()
        try:
            await asyncio.Event().wait()
        except asyncio.CancelledError:
            await kwargs["emit"](ProviderRecoveryEvent(
                node_id="n1", run_id=kwargs["run_id"], resume_operation_id="accepted-operation",
            ))
            raise

    monkeypatch.setattr(main_module, "execute_graph", fake_execute_graph)
    node = GraphNode(id="n1", definitionId="text-input", params={"value": "old recipe", "seed": 7})
    response = await start_request(single_node, "replay-recovery-contract", True, node)
    record = registry.get(response["runId"])
    assert record is not None
    await asyncio.wait_for(started.wait(), timeout=1)
    registry.cancel(response["runId"])
    with pytest.raises(asyncio.CancelledError):
        await record.task
    assert graph.nodes["n1"]["params"] == {**before, "resume_operation_id": "accepted-operation"}
    assert main_module.provider_recovery_store.list()[0]["resumeOperationId"] == "accepted-operation"
    assert any(isinstance(call.args[0], ProviderRecoveryEvent) for call in broadcast.await_args_list)
    assert any(isinstance(call.args[0], GraphCancelledEvent) for call in broadcast.await_args_list)
