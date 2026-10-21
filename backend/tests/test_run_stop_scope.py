"""Who may stop a run (Justin, 2026-10-20, Q61 a).

Agents stop only runs an agent started. A run the person started is theirs to
stop: an agent (or an unnamed script, the `nebula` CLI without
NEBULA_AGENT_NAME) that tries is refused with a message telling it to ask the
person to press Stop. Any agent may stop a run an agent or an unnamed script
started, and the person stops anything, as before. A refused Stop records
nothing: no durable Stop intent, so no other backend stops the run either.
"""
from __future__ import annotations

import asyncio
import threading
import time

import pytest
from fastapi.testclient import TestClient

import mcp_server
from nebula_api import NebulaAPI, NebulaAPIError
from services.execution_runs import ExecutionRunRegistry, stop_refusal

AGENT = {"X-Nebula-Agent": "Claude Code"}
OTHER_AGENT = {"X-Nebula-Agent": "Codex"}
# The `nebula` CLI by hand, or curl: no agent marker and no person token.
ANONYMOUS: dict[str, str] = {}


@pytest.fixture
def app(monkeypatch, person):
    """The app in-process; every run's engine waits until the test releases it."""
    import main

    release = threading.Event()

    async def blocking_execute_graph(**_kwargs):
        while not release.is_set():
            await asyncio.sleep(0.01)

    monkeypatch.delenv("NEBULA_AGENT_TOKEN", raising=False)
    monkeypatch.delenv("NEBULA_AGENT_NAME", raising=False)
    monkeypatch.setattr(main, "execute_graph", blocking_execute_graph)
    monkeypatch.setattr(main, "validate_graph", lambda *args, **kwargs: [])
    main.execution_runs.clear()
    with TestClient(main.app) as http:
        http.delete("/api/graph?force=true", headers=person.headers)
        yield http, person
        release.set()
    main.execution_runs.clear()


def _start(http, run_id: str, headers: dict[str, str]) -> None:
    body = {"nodes": [{"id": "n1", "definitionId": "text-input", "params": {"value": "hi"}, "outputs": {}}],
            "edges": [], "runId": run_id}
    response = http.post("/api/execute", json=body, headers=headers)
    assert response.status_code == 200, response.text
    assert response.json()["status"] == "started"


def _status(http, run_id: str) -> str:
    return http.get(f"/api/executions/{run_id}").json()["status"]


def _settled(http, run_id: str) -> str:
    deadline = time.monotonic() + 3
    while time.monotonic() < deadline:
        status = _status(http, run_id)
        if status not in {"running", "cancelling"}:
            return status
        time.sleep(0.02)
    return _status(http, run_id)


# -- the rule ---------------------------------------------------------------

def test_the_rule_in_one_place():
    person, agent, anonymous = {"kind": "person"}, {"kind": "agent", "name": "Codex"}, {"kind": "anonymous"}
    assert stop_refusal(person, caller_is_person=True) is None
    assert stop_refusal(agent, caller_is_person=True) is None
    assert stop_refusal(agent, caller_is_person=False) is None
    assert stop_refusal(anonymous, caller_is_person=False) is None
    refused = stop_refusal(person, caller_is_person=False)
    assert refused is not None and "press Stop" in refused


@pytest.mark.asyncio
async def test_the_registry_records_who_started_each_run():
    registry = ExecutionRunRegistry()

    async def work():
        await asyncio.Event().wait()

    by_person = asyncio.create_task(work())
    unnamed = asyncio.create_task(work())
    registry.register("r-person", by_person, started_by={"kind": "person"})
    registry.register("r-unnamed", unnamed)
    assert registry.get("r-person").started_by == {"kind": "person"}  # type: ignore[union-attr]
    assert registry.get("r-unnamed").started_by == {"kind": "anonymous"}  # type: ignore[union-attr]
    registry.clear()
    await asyncio.gather(by_person, unnamed, return_exceptions=True)


@pytest.mark.asyncio
async def test_the_registry_asks_its_starter_source_at_registration():
    registry = ExecutionRunRegistry()
    registry.set_starter_source(lambda: {"kind": "agent", "name": "Claude Code"})

    async def work():
        await asyncio.Event().wait()

    task = asyncio.create_task(work())
    registry.register("r-agent", task)
    assert registry.get("r-agent").started_by == {"kind": "agent", "name": "Claude Code"}  # type: ignore[union-attr]
    registry.clear()
    await asyncio.gather(task, return_exceptions=True)


# -- the route --------------------------------------------------------------

def test_the_backend_records_the_starter_of_a_canvas_run(app):
    import main

    http, person = app
    _start(http, "stop-scope-who", person.headers)
    _start(http, "stop-scope-who-agent", AGENT)
    _start(http, "stop-scope-who-cli", ANONYMOUS)
    assert main.execution_runs.get("stop-scope-who").started_by == {"kind": "person"}  # type: ignore[union-attr]
    agent = main.execution_runs.get("stop-scope-who-agent").started_by  # type: ignore[union-attr]
    assert agent["kind"] == "agent" and agent["name"] == "Claude Code"
    assert main.execution_runs.get("stop-scope-who-cli").started_by == {"kind": "anonymous"}  # type: ignore[union-attr]


@pytest.mark.parametrize("caller", [AGENT, ANONYMOUS], ids=["agent", "unnamed-cli"])
def test_an_agent_or_unnamed_caller_cannot_stop_the_persons_run(app, caller):
    import main

    http, person = app
    run_id = f"stop-scope-person-{'agent' if caller else 'cli'}"
    _start(http, run_id, person.headers)
    refused = http.delete(f"/api/executions/{run_id}", headers=caller)
    assert refused.status_code == 403
    detail = refused.json()["detail"]
    assert "press Stop" in detail and "the person" in detail.lower()
    # Nothing was recorded: the run goes on, here and on any other backend.
    assert _status(http, run_id) == "running"
    assert not main.provider_start_guard.is_run_cancelled(run_id)


def test_the_person_stops_their_own_run_as_before(app):
    http, person = app
    _start(http, "stop-scope-own", person.headers)
    stopped = http.delete("/api/executions/stop-scope-own", headers=person.headers)
    assert stopped.status_code == 200
    assert _settled(http, "stop-scope-own") == "cancelled"


@pytest.mark.parametrize("starter,stopper", [
    (AGENT, AGENT), (AGENT, OTHER_AGENT), (AGENT, ANONYMOUS), (ANONYMOUS, AGENT), (ANONYMOUS, ANONYMOUS),
], ids=["own", "other-agent", "unnamed-stops-agent", "agent-stops-unnamed", "unnamed-own"])
def test_any_agent_stops_a_run_an_agent_started(app, starter, stopper):
    http, _ = app
    run_id = f"stop-scope-{len(starter)}-{stopper.get('X-Nebula-Agent', 'cli').replace(' ', '')}"
    _start(http, run_id, starter)
    assert http.delete(f"/api/executions/{run_id}", headers=stopper).status_code == 200
    assert _settled(http, run_id) == "cancelled"


def test_the_person_stops_an_agents_run_and_the_journal_says_who_stopped_it(app):
    http, person = app
    cursor = http.get("/api/canvas/events", headers=person.headers).json()["cursor"]
    _start(http, "stop-scope-agent-run", AGENT)
    assert http.delete("/api/executions/stop-scope-agent-run", headers=person.headers).status_code == 200
    assert _settled(http, "stop-scope-agent-run") == "cancelled"
    # The agent that started it sees the person's Stop (its own events are skipped).
    events = http.get("/api/canvas/events", params={"after": cursor, "kinds": "run.cancelled"},
                      headers=AGENT).json()["events"]
    stop = next(event for event in events if event["data"].get("runId") == "stop-scope-agent-run")
    assert stop["actor"]["kind"] == "person"
    assert stop["data"]["startedBy"]["kind"] == "agent"


def test_a_stop_before_the_persons_run_is_admitted_is_refused_too(app):
    """The journal notes the starter before the registry holds the run."""
    import main

    http, _ = app
    main.canvas_events.note_run("stop-scope-early", {"kind": "person"})
    refused = http.delete("/api/executions/stop-scope-early", headers=AGENT)
    assert refused.status_code == 403
    assert not main.execution_runs.cancel_requested_before_start("stop-scope-early")


def test_an_unknown_run_id_still_takes_a_stop_intent(app):
    """Nobody's run: the pre-admission tombstone works for agents as before."""
    http, _ = app
    response = http.delete("/api/executions/stop-scope-never-started", headers=AGENT)
    assert response.status_code == 200
    assert response.json()["pendingAdmission"] is True


# -- MCP --------------------------------------------------------------------

def test_cancel_run_over_mcp_tells_the_agent_to_ask_the_person(app, monkeypatch):
    http, person = app
    monkeypatch.setattr(mcp_server, "_api", lambda: NebulaAPI("http://testserver", client=http))
    _start(http, "stop-scope-mcp", person.headers)
    with pytest.raises(NebulaAPIError) as refused:
        mcp_server.cancel_run("stop-scope-mcp")
    assert refused.value.status == 403 and "press Stop" in refused.value.detail
    assert _status(http, "stop-scope-mcp") == "running"
    assert "press Stop" in (mcp_server.cancel_run.__doc__ or "")


@pytest.mark.asyncio
async def test_a_finished_persons_run_answers_its_status_not_a_refusal():
    """Nothing is left to stop, so `nebula cancel` says it had already ended."""
    import main
    from services.agent_presence import request_headers_scope

    main.execution_runs.clear()

    async def done():
        return None

    task = asyncio.create_task(done())
    main.execution_runs.register("stop-scope-finished", task, started_by={"kind": "person"})
    await task
    await asyncio.sleep(0)
    with request_headers_scope(AGENT):
        answer = await main.cancel_execution("stop-scope-finished")
    assert answer["status"] == "completed"
    main.execution_runs.clear()
