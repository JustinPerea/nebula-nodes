"""The follow-up to PR #114 (GM's r18 rulings and review 17's lows).

- The cursor bubble for an agent's param change names the card's label in
  quotes ("Set “Text”"), or says nothing when the field has no label. Never
  a param key (GM: Codex's bubble read "Set value").
- L2: a run's own write-backs are run output, not anyone's edit: the Cinema
  shot merge sync and the World Labs recovery/ambiguity syncs carry
  ``runParams`` (the run id), as _sync_params_to_cli_graph's sync does.
- L4: reusing the id of a run that started and was stopped is refused with
  a line that says what is known: "was already stopped", never "was
  cancelled before it started".
"""
from __future__ import annotations

import asyncio
from pathlib import Path
from unittest.mock import AsyncMock

import pytest
from fastapi import HTTPException

import main as main_module
from models import ExecuteRequest, GenerateShotRequest, GraphNode
from models.events import ProviderRecoveryEvent, ProviderStartAmbiguousEvent
from services.execution_runs import ExecutionRunRegistry
from services.provider_recovery import ProviderRecoveryStore
from services.provider_start_guard import ProviderStartGuard
from tests.test_agent_presence import _presence_events, api  # noqa: F401 - fixture

AGENT = {"X-Nebula-Agent": "Codex"}


def _says(sent: list[dict]) -> list[str]:
    return [event.get("say") for event in _presence_events(sent)]


# -- the cursor bubble names the field, never its key --------------------------


def test_a_param_change_names_the_fields_card_label_in_quotes(api):  # noqa: F811
    client, graph, sent = api
    node = graph.add_node("text-input", {"value": "a"})
    assert client.put(f"/api/graph/node/{node}", headers=AGENT, json={"params": {"value": "b"}}).status_code == 200
    assert _says(sent)[-1] == "Set “Text”"


def test_a_field_with_no_label_is_not_named_and_its_key_never_shows(api):  # noqa: F811
    client, graph, sent = api
    # A universal node takes the provider's own params, which the node
    # definition doesn't list, so they have no card label.
    node = graph.add_node("fal-universal", {})
    response = client.put(f"/api/graph/node/{node}", headers=AGENT, json={"params": {"guidance_scale": 3}})
    assert response.status_code == 200, response.text
    said = _says(sent)[-1]
    assert said == ""
    assert "guidance" not in said


def test_several_fields_name_only_the_labeled_ones(api):  # noqa: F811
    client, graph, sent = api
    node = graph.add_node("fal-universal", {})
    response = client.put(f"/api/graph/node/{node}", headers=AGENT,
                          json={"params": {"endpoint_id": "fal-ai/flux/dev", "guidance_scale": 3}})
    assert response.status_code == 200, response.text
    assert _says(sent)[-1] == "Set “Endpoint”"
    assert all("guidance" not in str(text) for text in _says(sent))


# -- L2: a run's write-backs are marked as run output --------------------------


@pytest.fixture
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


def _syncs(broadcast: AsyncMock) -> list[dict]:
    return [call.args[0] for call in broadcast.await_args_list
            if call.args and isinstance(call.args[0], dict) and call.args[0].get("type") == "graphSync"]


@pytest.mark.asyncio
@pytest.mark.usefixtures("isolated_run_state")
async def test_a_world_labs_recovery_checkpoint_sync_carries_the_run_id(monkeypatch) -> None:
    assert main_module.cli_graph.add_node("text-input", {"value": "before"}) == "n1"
    raw = AsyncMock()
    monkeypatch.setattr(main_module.manager, "broadcast", AsyncMock())
    monkeypatch.setattr(main_module.manager, "broadcast_raw", raw)
    await main_module._emit_and_sync(ProviderRecoveryEvent(run_id="paid-run", node_id="n1",
                                                           resume_operation_id="operation-1"))
    assert main_module.cli_graph.nodes["n1"]["params"]["resume_operation_id"] == "operation-1"
    syncs = _syncs(raw)
    assert syncs and syncs[-1].get("runParams") == "paid-run"
    assert "edit" not in syncs[-1]


@pytest.mark.asyncio
@pytest.mark.usefixtures("isolated_run_state")
async def test_a_start_ambiguity_sync_carries_the_run_id(monkeypatch) -> None:
    assert main_module.cli_graph.add_node("text-input", {"value": "before"}) == "n1"
    raw = AsyncMock()
    monkeypatch.setattr(main_module.manager, "broadcast", AsyncMock())
    monkeypatch.setattr(main_module.manager, "broadcast_raw", raw)
    await main_module._emit_and_sync(ProviderStartAmbiguousEvent(run_id="paid-run", node_id="n1",
                                                                 kind="worldlabs-environment", message="Unclear."))
    syncs = _syncs(raw)
    assert syncs and syncs[-1].get("runParams") == "paid-run"


@pytest.mark.asyncio
@pytest.mark.usefixtures("isolated_run_state", "spending_limits_off")
async def test_the_cinema_shot_merge_sync_carries_the_run_id(monkeypatch) -> None:
    scene = GraphNode(id="n1", definitionId="cinema-scene",
                      params={"scene": {"shots": [{"id": "s1", "prompt": "a"}]}}, outputs={})
    main_module.cli_graph.nodes["n1"] = {"id": "n1", "definitionId": "cinema-scene",
                                         "params": {"scene": {"shots": [{"id": "s1", "prompt": "a"}]}},
                                         "outputs": {}}
    raw = AsyncMock()
    monkeypatch.setattr(main_module.manager, "broadcast", AsyncMock())
    monkeypatch.setattr(main_module.manager, "broadcast_raw", raw)
    monkeypatch.setattr(main_module, "_validate_cinema_base_models", lambda nodes: None)
    monkeypatch.setattr(main_module, "validate_graph", lambda *a, **k: [])
    monkeypatch.setattr(main_module, "_fresh_paid_worldlabs_claims", lambda nodes: [])

    async def shot_pass(*_args, **_kwargs):
        return scene, {"shot_s1": {"type": "Image", "value": "/api/outputs/shot.png"}}

    monkeypatch.setattr(main_module, "_execute_single_shot_pass", shot_pass)
    main_module._shot_merge_locks.clear()
    await main_module.generate_cinema_shot(GenerateShotRequest(nodes=[scene], edges=[], nodeId="n1",
                                                               shotId="s1", runId="shot-run"))
    record = main_module.execution_runs.get("shot-run")
    await asyncio.wait_for(asyncio.gather(record.task, return_exceptions=True), 5)
    syncs = _syncs(raw)
    assert syncs, "the shot's merge sends a graphSync"
    assert syncs[-1].get("runParams") == "shot-run"
    assert "edit" not in syncs[-1]


# -- L4: a stopped run's id, reused ----------------------------------------------


STOPPED = "run {id} was already stopped, so this id can’t start again. Start a new run with a new id."
RAN = "run {id} already ran, so this id can’t start again. Start a new run with a new id."
STOP_RECORDED = "run {id} was stopped, so this id can’t start again. Start a new run with a new id."


def _text() -> GraphNode:
    return GraphNode(id="n1", definitionId="text-input", params={"value": "x"}, outputs={})


async def _start_again(run_id: str) -> HTTPException:
    with pytest.raises(HTTPException) as refused:
        await main_module.execute(ExecuteRequest(nodes=[_text()], edges=[], runId=run_id))
    return refused.value


@pytest.mark.asyncio
@pytest.mark.usefixtures("isolated_run_state", "spending_limits_off")
async def test_reusing_the_id_of_a_run_that_started_and_was_stopped_says_it_was_already_stopped(monkeypatch) -> None:
    gate = asyncio.Event()

    async def slow(**_kwargs):
        await gate.wait()

    monkeypatch.setattr(main_module, "execute_graph", slow)
    await main_module.execute(ExecuteRequest(nodes=[_text()], edges=[], runId="t6-run"))
    await main_module.cancel_execution("t6-run")
    record = main_module.execution_runs.get("t6-run")
    await asyncio.gather(record.task, return_exceptions=True)
    refused = await _start_again("t6-run")
    assert refused.status_code == 409
    assert refused.detail == STOPPED.format(id="t6-run")
    assert "before it started" not in refused.detail


@pytest.mark.asyncio
@pytest.mark.usefixtures("isolated_run_state", "spending_limits_off")
async def test_reusing_the_id_of_a_run_that_finished_before_its_stop_says_it_already_ran(monkeypatch) -> None:
    monkeypatch.setattr(main_module, "execute_graph", AsyncMock())
    await main_module.execute(ExecuteRequest(nodes=[_text()], edges=[], runId="done-run"))
    record = main_module.execution_runs.get("done-run")
    await asyncio.wait_for(asyncio.gather(record.task, return_exceptions=True), 5)
    await main_module.cancel_execution("done-run")
    refused = await _start_again("done-run")
    assert refused.status_code == 409
    assert refused.detail == RAN.format(id="done-run")


@pytest.mark.asyncio
@pytest.mark.usefixtures("isolated_run_state", "spending_limits_off")
async def test_after_a_restart_a_stopped_id_is_refused_without_claiming_when_it_was_stopped(monkeypatch) -> None:
    gate = asyncio.Event()

    async def slow(**_kwargs):
        await gate.wait()

    monkeypatch.setattr(main_module, "execute_graph", slow)
    await main_module.execute(ExecuteRequest(nodes=[_text()], edges=[], runId="r-run"))
    await main_module.cancel_execution("r-run")
    await asyncio.gather(main_module.execution_runs.get("r-run").task, return_exceptions=True)
    # Restarted: the registry is memory-only; the durable Stop record stays.
    monkeypatch.setattr(main_module, "execution_runs", ExecutionRunRegistry())
    refused = await _start_again("r-run")
    assert refused.status_code == 409
    assert refused.detail == STOP_RECORDED.format(id="r-run")


@pytest.mark.asyncio
@pytest.mark.usefixtures("isolated_run_state", "spending_limits_off")
async def test_a_stop_that_beat_its_start_still_says_cancelled_before_it_started(monkeypatch) -> None:
    """The case the old line was written for keeps it: this process saw the
    start begin and it never registered."""
    monkeypatch.setattr(main_module, "execute_graph", AsyncMock())
    main_module.execution_runs.note_start_begun("early-run")
    await main_module.cancel_execution("early-run")
    refused = await _start_again("early-run")
    assert refused.status_code == 409
    assert refused.detail == "run early-run was cancelled before it started"
