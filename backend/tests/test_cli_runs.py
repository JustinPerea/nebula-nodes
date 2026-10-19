"""CLI runs outlive the request: POST /api/graph/run with `wait` returns
"still running", GET /api/graph/runs/{id} collects the result, and
DELETE /api/executions/{id} (`nebula cancel`) stops it."""
from __future__ import annotations

import asyncio
import threading

import pytest
from fastapi.testclient import TestClient

from models.events import ExecutedEvent, SkippedEvent


@pytest.fixture
def harness(monkeypatch):
    import main

    release = threading.Event()
    started = threading.Event()

    async def slow_execute_graph(*, nodes, emit, run_id, **kwargs):
        first = nodes[0].id
        await emit(ExecutedEvent(node_id=first, outputs={"text": {"type": "Text", "value": "made"}}, run_id=run_id))
        started.set()
        while not release.is_set():
            await asyncio.sleep(0.01)

    monkeypatch.setattr(main, "execute_graph", slow_execute_graph)
    # Without `with`, TestClient ends its event loop after each request, and the run with it.
    with TestClient(main.app) as client:
        client.delete("/api/graph?force=true")
        node = client.post("/api/graph/node", json={"definitionId": "text-input", "params": {"value": "hi"}})
        assert node.status_code == 200, node.text
        yield client, node.json()["id"], release, started
        release.set()
        client.delete("/api/graph?force=true")


def test_without_wait_the_request_waits_for_the_result(harness):
    client, node_id, release, _ = harness
    release.set()
    response = client.post("/api/graph/run", json={"targetNodeId": node_id})
    assert response.status_code == 200, response.text
    body = response.json()
    assert body["status"] == "finished"
    assert body["results"][node_id]["text"]["value"] == "made"
    assert body["nodesExecuted"] == 1 and "duration" in body


def test_a_long_run_reports_still_running_then_its_result(harness):
    import main

    client, node_id, release, started = harness
    response = client.post("/api/graph/run", json={"targetNodeId": node_id, "wait": 0.1})
    assert response.status_code == 200, response.text
    body = response.json()
    assert body["status"] == "running"
    run_id = body["runId"]
    assert started.wait(5)

    # It still holds the project fence after the request returned.
    with pytest.raises(main.HTTPException) as fenced:
        main._project_replacement_guard()
    assert fenced.value.status_code == 409

    assert client.get(f"/api/graph/runs/{run_id}").json()["status"] == "running"
    release.set()
    done = client.get(f"/api/graph/runs/{run_id}", params={"wait": 5}).json()
    assert done["status"] == "finished"
    assert done["results"][node_id]["text"]["value"] == "made"
    # Its output reached the graph the canvas syncs from.
    graph = client.get("/api/graph").json()
    saved = next(node for node in graph["nodes"] if node["id"] == node_id)
    assert saved["outputs"]["text"]["value"] == "made"
    main._project_replacement_guard()  # fence released


def test_cancel_stops_a_cli_run_and_keeps_what_finished(harness):
    client, node_id, _, started = harness
    run_id = client.post("/api/graph/run", json={"targetNodeId": node_id, "wait": 0}).json()["runId"]
    assert started.wait(5)
    cancelled = client.delete(f"/api/executions/{run_id}")
    assert cancelled.status_code == 200, cancelled.text
    assert cancelled.json()["status"] in ("cancelling", "cancelled")
    outcome = client.get(f"/api/graph/runs/{run_id}", params={"wait": 5}).json()
    assert outcome["status"] == "cancelled"
    assert outcome["results"][node_id]["text"]["value"] == "made"


def test_unknown_run_and_bad_wait(harness):
    client, node_id, release, _ = harness
    release.set()
    assert client.get("/api/graph/runs/nope").status_code == 404
    bad = client.post("/api/graph/run", json={"targetNodeId": node_id, "wait": "soon"})
    assert bad.status_code == 400
    assert client.post("/api/graph/run", json={"targetNodeId": node_id, "wait": -1}).status_code == 400


def test_a_run_reports_the_nodes_a_gate_skipped(monkeypatch):
    import main
    from cli.formatter import format_run_results

    async def gated_execute_graph(*, nodes, emit, run_id, **kwargs):
        first, second = nodes[0].id, nodes[1].id
        await emit(ExecutedEvent(node_id=first, outputs={"text": {"type": "Text", "value": "made"}}, run_id=run_id))
        await emit(SkippedEvent(node_id=second, reason="Jev Decide failed (answered no, 0.12)",
                                gate_node_id=first, run_id=run_id))

    monkeypatch.setattr(main, "execute_graph", gated_execute_graph)
    with TestClient(main.app) as client:
        client.delete("/api/graph?force=true")
        ids = [client.post("/api/graph/node", json={"definitionId": "text-input", "params": {"value": v}}).json()["id"]
               for v in ("a", "b")]
        body = client.post("/api/graph/run", json={}).json()
        client.delete("/api/graph?force=true")
    assert body["status"] == "finished"
    assert body["skipped"] == {ids[1]: "Jev Decide failed (answered no, 0.12)"}
    assert body["nodesExecuted"] == 1  # a skipped node never ran
    assert f"{ids[1]}: skipped — Jev Decide failed (answered no, 0.12)" in format_run_results(body)
