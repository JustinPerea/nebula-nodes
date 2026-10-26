"""Error copy, round 3b: the last World Labs refusals that used internal words.

GM - Design, on the round-3 delete line: "'settle' and 'start' are internal.
Write it as: 'This node is still waiting on World Labs. Check the job in
Marble, then {the node's actual button label} before you delete it.'" and the
pattern for new refusals: "say what's needed in plain words, give the count,
then what to do." GM again: "People get the written line and agents keep the
specific detail. Keep it that way."

Round 3 left "Checked Marble — unlock"'s refusals ("Cannot acknowledge a World
Labs paid-start ambiguity while that provider handshake is still active",
"World Labs paid-start ambiguity changed; refresh ...") and the run-start
refusals ("Fresh paid ... start is safety-locked after an ambiguous provider
response ...", "... already has a recovery checkpoint ...", the journals at
capacity). Each is raised with a code at its source (ProviderStartConflictError
.reason, the capacity errors' .limit), and the route words it for the person;
an agent, MCP, the CLI and scripts keep the exact text. Same checks, same
statuses.
"""
from __future__ import annotations

from contextlib import contextmanager
from pathlib import Path

import pytest
from fastapi import HTTPException

import main as main_module
from models import GraphNode
from services import agent_presence
from services.provider_recovery import (
    ProviderRecoveryCapacityError,
    ProviderRecoveryConflictError,
    ProviderRecoveryStore,
)
from services.provider_start_guard import ProviderStartConflictError, ProviderStartGuard
from tests.conftest import PERSON

AGENT = {"X-Nebula-Agent": "Claude"}
CLI = {"X-Nebula-Client": "nebula-cli"}
SCRIPT: dict[str, str] = {}
ENVIRONMENT = "worldlabs-environment"
EXPORT = "worldlabs-world-export"

UNLOCK = "“Checked Marble — unlock”"
FORGET = "“Checked Marble — forget”"
A_NODE = "A node is still waiting on World Labs."
THIS_NODE = "This node is still waiting on World Labs."


@contextmanager
def reading(headers):
    """The request's headers, as the middleware sets them for a route."""
    token = agent_presence._request_headers.set(headers)
    try:
        yield
    finally:
        agent_presence._request_headers.reset(token)


@pytest.fixture(autouse=True)
def isolated_paid_state(monkeypatch, tmp_path: Path):
    guard = ProviderStartGuard(tmp_path / "provider-starts.json")
    recoveries = ProviderRecoveryStore(tmp_path / "provider-recoveries.json")
    monkeypatch.setattr(main_module, "provider_start_guard", guard)
    monkeypatch.setattr(main_module, "provider_recovery_store", recoveries)
    monkeypatch.setattr(main_module, "_graph_recovery_bootstrap_error", None)
    main_module.execution_runs.clear()
    main_module.cli_graph.clear()

    async def quiet(*_args, **_kwargs):
        return None

    monkeypatch.setattr(main_module, "_broadcast_graph_sync", quiet)
    yield guard, recoveries
    main_module.execution_runs.clear()
    main_module.cli_graph.clear()


def _world(node_id: str = "world-node", params=None) -> GraphNode:
    return GraphNode(id=node_id, definitionId=ENVIRONMENT, params=params or {}, outputs={})


def _claim_refusal(headers, nodes, run_id="run-new") -> HTTPException:
    with reading(headers), pytest.raises(HTTPException) as refused:
        main_module._claim_fresh_paid_worldlabs_starts(run_id=run_id, nodes=nodes)
    assert refused.value.status_code == 409
    return refused.value


async def _ack_refusal(headers, kind, node_id, run_id) -> HTTPException:
    with reading(headers), pytest.raises(HTTPException) as refused:
        await main_module.acknowledge_provider_start_ambiguity(kind, node_id, run_id)
    assert refused.value.status_code == 409
    return refused.value


# -- Run start ---------------------------------------------------------------------

def test_a_start_held_for_an_unlock_names_the_unlock_button(isolated_paid_state):
    guard, _ = isolated_paid_state
    guard.mark_ambiguous(run_id="uncertain", node_id="world-old", kind=ENVIRONMENT)
    person = _claim_refusal(PERSON, [_world("world-new")])
    assert person.detail == f"{A_NODE} Check the job in Marble, then use {UNLOCK} before you try again."
    for headers in (AGENT, CLI, SCRIPT):
        agent = _claim_refusal(headers, [_world("world-new")])
        assert agent.detail == (f"Fresh paid {ENVIRONMENT} start is safety-locked after an ambiguous provider "
                                "response for node 'world-old'; check Marble and explicitly unlock that hold")


def test_a_start_already_in_flight_says_to_let_it_finish(isolated_paid_state):
    guard, _ = isolated_paid_state
    guard.claim(run_id="running", claims=[(ENVIRONMENT, "world-a")])
    try:
        person = _claim_refusal(PERSON, [_world("world-b")])
        assert person.detail == f"{A_NODE} Let its run finish, then try again."
        agent = _claim_refusal(AGENT, [_world("world-b")])
        assert agent.detail == f"Fresh paid {ENVIRONMENT} start is already active for node 'world-a' in run 'running'"
    finally:
        guard.release_run("running")


def test_a_recovery_record_for_the_node_names_forget_in_run_history(isolated_paid_state):
    _, recoveries = isolated_paid_state
    recoveries.set(run_id="accepted", node_id="world-node", resume_operation_id="op-1", existing_world_id=None)
    person = _claim_refusal(PERSON, [_world()])
    assert person.detail == f"{A_NODE} Check the job in Marble, then use {FORGET} in Run History before you try again."
    agent = _claim_refusal(CLI, [_world()])
    assert agent.detail == ("Fresh World Labs start blocked because Nebula already has a recovery checkpoint for "
                            "node(s): world-node. Restore or explicitly delete the checkpoint before starting new "
                            "paid work.")


def test_a_full_recovery_journal_says_the_limit_and_what_to_clear(monkeypatch, tmp_path):
    recoveries = ProviderRecoveryStore(tmp_path / "small.json", max_records=1)
    recoveries.set(run_id="older", node_id="world-other", resume_operation_id="op-9", existing_world_id=None)
    monkeypatch.setattr(main_module, "provider_recovery_store", recoveries)
    person = _claim_refusal(PERSON, [_world()])
    assert person.detail == (
        "Nebula is already waiting on 1 World Labs job, the most it can track. "
        "Check it in Marble and clear it in Run History, then try again.")
    agent = _claim_refusal(AGENT, [_world()])
    assert agent.detail == ("provider recovery journal is at capacity; resolve an existing checkpoint before "
                            "starting more paid work")


def test_a_full_start_journal_says_the_limit_too(monkeypatch, tmp_path):
    guard = ProviderStartGuard(tmp_path / "small-starts.json", max_records=2)
    guard.mark_ambiguous(run_id="held-1", node_id="export-1", kind=EXPORT)
    guard.mark_ambiguous(run_id="held-2", node_id="export-2", kind=EXPORT)
    monkeypatch.setattr(main_module, "provider_start_guard", guard)
    person = _claim_refusal(PERSON, [_world()])
    assert person.detail == (
        "Nebula is already waiting on 2 World Labs jobs, the most it can track. "
        "Check them in Marble and clear some in Run History, then try again.")
    agent = _claim_refusal(AGENT, [_world()])
    assert agent.detail == ("World Labs paid-start safety journal is at capacity; resolve an existing recovery "
                            "or ambiguity before starting more paid work")


def test_the_codes_are_raised_where_the_refusal_is_made(tmp_path):
    """The person's words come from a code, never from matching the text."""
    guard = ProviderStartGuard(tmp_path / "codes.json", max_records=1)
    guard.mark_ambiguous(run_id="held", node_id="world-old", kind=ENVIRONMENT)
    with pytest.raises(ProviderStartConflictError) as held:
        guard.claim(run_id="next", claims=[(ENVIRONMENT, "world-new")])
    assert held.value.reason == "ambiguity"
    with pytest.raises(ProviderStartConflictError) as full:
        guard.claim(run_id="next", claims=[(EXPORT, "export-new")])
    assert (full.value.reason, full.value.limit) == ("capacity", 1)
    recoveries = ProviderRecoveryStore(tmp_path / "codes-recoveries.json", max_records=1)
    recoveries.set(run_id="a", node_id="n1", resume_operation_id="op", existing_world_id=None)
    with pytest.raises(ProviderRecoveryCapacityError) as journal:
        recoveries.reserve(run_id="b", node_ids=["n2"])
    assert journal.value.limit == 1


# -- "Checked Marble — unlock" ---------------------------------------------------

@pytest.mark.asyncio
async def test_unlock_while_that_nodes_start_is_in_flight(isolated_paid_state):
    guard, _ = isolated_paid_state
    guard.claim(run_id="active", claims=[(ENVIRONMENT, "world-node")])
    guard.mark_ambiguous(run_id="active", node_id="world-node", kind=ENVIRONMENT)
    try:
        person = await _ack_refusal(PERSON, ENVIRONMENT, "world-node", "active")
        assert person.detail == f"{THIS_NODE} Let its run finish, then try again."
        agent = await _ack_refusal(AGENT, ENVIRONMENT, "world-node", "active")
        assert agent.detail == ("Cannot acknowledge a World Labs paid-start ambiguity while that provider "
                                "handshake is still active")
        assert guard.list()  # nothing was unlocked
    finally:
        guard.release_run("active")


@pytest.mark.asyncio
async def test_unlock_of_a_hold_that_changed_says_to_reload_and_check_the_newer_job(isolated_paid_state):
    guard, _ = isolated_paid_state
    guard.mark_ambiguous(run_id="new-run", node_id="world-node", kind=ENVIRONMENT)
    person = await _ack_refusal(PERSON, ENVIRONMENT, "world-node", "old-run")
    assert person.detail == ("This node is waiting on a newer World Labs job. Reload to see it, check it in "
                             f"Marble, then use {UNLOCK}.")
    agent = await _ack_refusal(CLI, ENVIRONMENT, "world-node", "old-run")
    assert agent.detail == "World Labs paid-start ambiguity changed; refresh before acknowledging the newer hold"
    assert guard.list()[0]["runId"] == "new-run"


@pytest.mark.asyncio
async def test_unlock_while_another_start_holds_the_lifecycle(isolated_paid_state, monkeypatch):
    guard, _ = isolated_paid_state
    guard.mark_ambiguous(run_id="held", node_id="world-node", kind=ENVIRONMENT)
    monkeypatch.setattr(guard, "_lifecycle_fd", -1)
    monkeypatch.setattr(guard, "_lifecycle_run_id", "other-run")
    person = await _ack_refusal(PERSON, ENVIRONMENT, "world-node", "held")
    assert person.detail == f"{A_NODE} Let its run finish, then try again."
    agent = await _ack_refusal(AGENT, ENVIRONMENT, "world-node", "held")
    assert agent.detail == "Fresh paid World Labs start is already active in run 'other-run'"


# -- "Checked Marble — forget" ---------------------------------------------------

@pytest.mark.asyncio
async def test_forget_of_a_record_that_changed_says_to_reload_and_check_the_newer_job(isolated_paid_state):
    _, recoveries = isolated_paid_state
    recoveries.set(run_id="r1", node_id="world-node", resume_operation_id="op-new", existing_world_id=None)
    for headers, detail in (
        (PERSON, "This node is waiting on a newer World Labs job. Reload to see it, check it in Marble, then "
                 f"use {FORGET} in Run History."),
        (AGENT, "World Labs recovery checkpoint changed; refresh before deleting the newer checkpoint"),
    ):
        with reading(headers), pytest.raises(HTTPException) as refused:
            await main_module.delete_provider_recovery("r1", "world-node", resume_operation_id="op-old")
        assert (refused.value.status_code, refused.value.detail) == (409, detail)
    assert recoveries.list()


# -- Canvas edits that seed the shared journal ------------------------------------

def test_a_canvas_edit_at_journal_capacity_or_racing_a_change(monkeypatch):
    def full(**_kwargs):
        raise ProviderRecoveryCapacityError(
            "provider recovery journal is at capacity; resolve an existing checkpoint before importing more paid state",
            limit=256)

    def changed(**_kwargs):
        raise ProviderRecoveryConflictError("World Labs recovery checkpoint changed; use a new graph mutation identity")

    nodes = [{"id": "n1", "definitionId": ENVIRONMENT, "params": {"resume_operation_id": "op-1"}}]
    for fake, person, agent in (
        (full,
         "Nebula is already waiting on 256 World Labs jobs, the most it can track. "
         "Check them in Marble and clear some in Run History, then try again.",
         "provider recovery journal is at capacity; resolve an existing checkpoint before importing more paid state"),
        (changed,
         "A node's World Labs job changed while Nebula saved the canvas. Reload, then try again.",
         "World Labs recovery checkpoint changed; use a new graph mutation identity"),
    ):
        monkeypatch.setattr(main_module.provider_recovery_store, "ensure_many", fake)
        for headers, detail in ((PERSON, person), (AGENT, agent)):
            with reading(headers), pytest.raises(HTTPException) as refused:
                main_module._seed_shared_graph_recoveries_for_api(nodes, source="test")
            assert (refused.value.status_code, refused.value.detail) == (409, detail)


# -- One source of the words (item 5: the canvas's Delete key) ---------------------

def test_the_canvas_delete_notice_says_the_backends_words():
    """The canvas refuses a Delete on a node holding World Labs state itself,
    without a request (graphStore refuseHeldNodeDelete), so it can't read the
    backend's line. lib/worldLabsWaiting.ts writes the same lines; pin them
    equal so neither drifts."""
    ts = (Path(__file__).resolve().parents[2] / "frontend" / "src" / "lib" / "worldLabsWaiting.ts").read_text()
    person = main_module._paid_state_person
    assert f'NODE_WAITING_UNLOCK = "{person("ambiguity", subject="This node is", then="delete it")}"' in ts
    assert f'NODE_WAITING_FORGET = "{person("recovery", subject="This node is", then="delete it")}"' in ts
    assert f'SOME_NODE_WAITING_UNLOCK = "{person("ambiguity", subject="A node is", then="try again")}"' in ts
    assert f'SOME_NODE_WAITING_FORGET = "{person("recovery", subject="A node is", then="try again")}"' in ts
