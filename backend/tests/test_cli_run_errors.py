"""A run's failures show on the node and reach the agent, whoever started it.

An agent's run (POST /api/graph/run: run_nodes, `nebula run`) used to keep its
per-node events to itself and skip the canvas Run's pre-call check. A node
with no key then failed inside its handler, the agent got status "finished"
with an error beside it, and the card stayed idle. Now the run checks first,
broadcasts every node's state as a canvas run does, reports "failed", and
agents can read each node's last error (look_at_canvas, view_output, `nebula
look`, `nebula path`).
"""
from __future__ import annotations

import io
from contextlib import redirect_stderr, redirect_stdout
from unittest.mock import AsyncMock

import pytest
from fastapi.testclient import TestClient

from models.events import ErrorEvent, ExecutedEvent, ExecutingEvent
from services.canvas_events import CanvasEventJournal
from services.node_errors import NodeErrors

CLAUDE = {"X-Nebula-Agent": "Claude Code"}
GPT_IMAGE_2 = "gpt-image-2-generate"


@pytest.fixture
def canvas(monkeypatch):
    """The app with no keys, and every message a canvas would receive."""
    import main

    sent: list[dict] = []

    async def capture(data):
        sent.append(data)

    monkeypatch.setattr(main.manager, "broadcast_raw", capture)
    monkeypatch.setattr(main, "canvas_events", CanvasEventJournal())
    monkeypatch.setattr(main, "node_errors", NodeErrors(), raising=False)
    monkeypatch.setattr(main, "load_settings", lambda: {"apiKeys": {}})
    with TestClient(main.app) as client:
        client.delete("/api/graph?force=true")
        prompt = client.post("/api/graph/node", json={"definitionId": "text-input", "params": {"value": "a dune"}}).json()["id"]
        image = client.post("/api/graph/node", json={"definitionId": GPT_IMAGE_2, "params": {}}).json()["id"]
        wired = client.post("/api/graph/connect", json={"source": prompt, "sourceHandle": "text",
                                                        "target": image, "targetHandle": "prompt"})
        assert wired.status_code == 200, wired.text
        sent.clear()
        yield client, main, sent, prompt, image
        client.delete("/api/graph?force=true")


def _node(client, node_id: str) -> dict:
    snapshot = client.get("/api/canvas/snapshot").json()
    return next(node for node in snapshot["nodes"] if node["id"] == node_id)


def test_an_agent_run_a_node_cannot_start_fails_on_its_card_before_anything_runs(canvas, monkeypatch):
    client, main, sent, _prompt, image = canvas
    engine = AsyncMock()
    monkeypatch.setattr(main, "execute_graph", engine)

    body = client.post("/api/graph/run", json={"targetNodeId": image}, headers=CLAUDE).json()

    assert body["status"] == "failed"
    assert body["errors"] == {image: "Missing API key: OPENAI_API_KEY"}
    assert body["error"].startswith("Nothing ran, so nothing was spent.") and "OPENAI_API_KEY" in body["error"]
    assert body["results"] == {} and body["nodesExecuted"] == 0
    engine.assert_not_awaited()
    # The canvas gets the same event a refused click on Run sends, so the card shows it.
    refused = [m for m in sent if m.get("type") == "validationError"]
    assert refused and refused[0]["runId"] == body["runId"]
    # Error copy round 3e: the event also carries the card's line, beside the agents' text.
    assert {"nodeId": image, "portId": "", "message": "Missing API key: OPENAI_API_KEY",
            "person": "Add your OpenAI API key in Settings, then run the node again."} in refused[0]["errors"]
    # Agents read it too, and the journal says whose run failed where.
    assert _node(client, image)["error"] == "Missing API key: OPENAI_API_KEY"
    failed = [e for e in main.canvas_events.read(after=0)["events"] if e["kind"] == "run.failed"]
    assert [(e["nodeId"], e["actor"]["name"]) for e in failed] == [(image, "Claude Code")]
    assert failed[0]["data"]["error"] == "Missing API key: OPENAI_API_KEY"
    # get_run and `nebula result` say the same thing later.
    assert client.get(f"/api/graph/runs/{body['runId']}").json() == body


@pytest.fixture
def agent_log():
    """The in-app chat turn's Agent Log lines (publish_action's `thinking`
    events, which the canvas's Agent Log panel shows as they are)."""
    from services.chat_actions import register_action_handler, unregister_action_handler

    lines: list[str] = []
    register_action_handler(lambda event: lines.append(event["text"]) if event.get("type") == "thinking" else None)
    yield lines
    unregister_action_handler()


def test_a_refused_run_tells_the_agent_log_the_persons_line(canvas, monkeypatch, agent_log):
    """Error copy round 3e review: the Agent Log is on the person's canvas, so
    a refused run reads the card's line there, never the key or the node id.
    The agent's answer keeps both (`error`, `errors`)."""
    client, main, _sent, _prompt, image = canvas
    monkeypatch.setattr(main, "execute_graph", AsyncMock())

    body = client.post("/api/graph/run", json={"targetNodeId": image}, headers=CLAUDE).json()

    assert "OPENAI_API_KEY" in body["error"] and image in body["error"]
    # GM, PR #203 r29 item 3: the card's heading and the bar's reason.
    [line] = [text for text in agent_log if text.startswith("Nebula couldn’t start the run.")]
    assert line == (f"Nebula couldn’t start the run. “{main._node_label(image)}” needs your OpenAI API key. "
                    "Add it in Settings, then run the node again.")
    assert "OPENAI_API_KEY" not in line and image not in line and "Missing API key" not in line


def test_a_graph_wide_refusal_tells_the_agent_log_in_words(canvas, monkeypatch, agent_log):
    client, main, _sent, _prompt, image = canvas
    monkeypatch.setattr(main, "execute_graph", AsyncMock())
    monkeypatch.setattr(main, "validate_graph", lambda *args, **kwargs: [])

    def loop(*_args, **_kwargs):
        raise main.CycleError("nodes are in a cycle", [image, image])

    monkeypatch.setattr(main, "topological_sort", loop)
    body = client.post("/api/graph/run", json={"targetNodeId": image}, headers=CLAUDE).json()

    assert "Graph contains a cycle" in body["error"]
    [line] = [text for text in agent_log if text.startswith("Nebula couldn’t start the run.")]
    assert line == "Nebula couldn’t start the run."


def test_every_node_of_an_agent_run_shows_on_the_canvas_and_a_failure_fails_the_run(canvas, monkeypatch):
    client, main, sent, prompt, image = canvas
    # Past the check (a key that the handler then finds wanting), into the run.
    monkeypatch.setattr(main, "validate_graph", lambda *args, **kwargs: [])

    async def one_fails(*, nodes, emit, run_id, **kwargs):
        await emit(ExecutingEvent(node_id=prompt, run_id=run_id))
        await emit(ExecutedEvent(node_id=prompt, outputs={"text": {"type": "Text", "value": "a dune"}}, run_id=run_id))
        await emit(ExecutingEvent(node_id=image, run_id=run_id))
        await emit(ErrorEvent(node_id=image, error="OPENAI_API_KEY is required", run_id=run_id,
                              missing_credential=True))

    monkeypatch.setattr(main, "execute_graph", one_fails)
    body = client.post("/api/graph/run", json={"targetNodeId": image}, headers=CLAUDE).json()

    assert body["status"] == "failed"
    assert body["error"] == f"{image} failed: OPENAI_API_KEY is required"
    assert body["errors"] == {image: "OPENAI_API_KEY is required"}
    assert body["results"][prompt]["text"]["value"] == "a dune"  # what finished is kept
    shown = [(m["type"], m["nodeId"]) for m in sent if m.get("type") in {"executing", "executed", "error"}]
    assert shown == [("executing", prompt), ("executed", prompt), ("executing", image), ("error", image)]
    assert all(m["runId"] == body["runId"] for m in sent if m.get("type") in {"executing", "executed", "error"})

    assert _node(client, image)["error"] == "OPENAI_API_KEY is required"
    assert "error" not in _node(client, prompt)
    # view_output and `nebula path` answer with the error instead of "no output yet".
    preview = client.get(f"/api/graph/node/{image}/preview")
    assert preview.status_code == 409
    assert preview.json()["detail"] == f"{image} has no output: its last run failed: OPENAI_API_KEY is required"
    path = client.get(f"/api/graph/node/{image}/path")
    assert path.status_code == 409 and "OPENAI_API_KEY is required" in path.json()["detail"]

    async def both_finish(*, nodes, emit, run_id, **kwargs):
        await emit(ExecutingEvent(node_id=image, run_id=run_id))
        await emit(ExecutedEvent(node_id=image, outputs={"text": {"type": "Text", "value": "x"}}, run_id=run_id))

    monkeypatch.setattr(main, "execute_graph", both_finish)
    again = client.post("/api/graph/run", json={"targetNodeId": image}, headers=CLAUDE).json()
    assert again["status"] == "finished" and "error" not in again
    assert "error" not in _node(client, image)


def test_a_person_run_the_check_refuses_is_readable_by_agents(canvas):
    client, _main, _sent, prompt, image = canvas
    nodes = [{"id": prompt, "definitionId": "text-input", "params": {"value": "a dune"}},
             {"id": image, "definitionId": GPT_IMAGE_2, "params": {}}]
    edges = [{"id": "e1", "source": prompt, "sourceHandle": "text", "target": image, "targetHandle": "prompt"}]
    refused = client.post("/api/execute", json={"nodes": nodes, "edges": edges}).json()
    assert refused["status"] == "validation_error"
    assert _node(client, image)["error"] == "Missing API key: OPENAI_API_KEY"


def test_the_cli_prints_each_failed_node():
    from cli.commands.execute import _report
    from cli.formatter import format_snapshot

    out, err = io.StringIO(), io.StringIO()
    with redirect_stdout(out), redirect_stderr(err):
        code = _report({"status": "failed", "runId": "r1", "error": "Nothing ran, so nothing was spent. n3 ...",
                        "results": {}, "errors": {"n3": "Missing API key: OPENAI_API_KEY"}, "nodesExecuted": 0})
    assert code == 1
    assert "error: run r1 failed: Nothing ran" in err.getvalue()
    assert "n3: ERROR — Missing API key: OPENAI_API_KEY" in out.getvalue()
    assert "Completed in" not in out.getvalue()

    look = format_snapshot({"view": {}, "nodes": [{"id": "n3", "name": "GPT Image 2", "state": "error",
                                                   "error": "Missing API key: OPENAI_API_KEY"}]})
    assert "        error: Missing API key: OPENAI_API_KEY" in look


def test_node_errors_follow_the_card():
    errors = NodeErrors()
    errors.observe(ErrorEvent(node_id="n1", error="HTTP 500 from provider", friendly="The provider had a problem"))
    assert errors.get("n1") == {"error": "HTTP 500 from provider", "hint": "The provider had a problem"}
    errors.observe(ExecutingEvent(node_id="n1"))  # running again clears it, as on the card
    assert errors.get("n1") is None
    errors.record("n2", "x" * 5000)
    assert len(errors.get("n2")["error"]) == 2000
    # An undo that swaps another node in under the id forgets it.
    errors.forget("n2")
    assert errors.get("n2") is None


def test_a_hint_that_only_repeats_the_error_is_left_out():
    # classify_error's fallback hint is the message less its full stop (live
    # check: look_at_canvas showed the Moodboard error twice).
    errors = NodeErrors()
    errors.observe(ErrorEvent(node_id="n1", error="Moodboard 'b1' is in Recently deleted. Restore it.",
                              friendly="Moodboard 'b1' is in Recently deleted. Restore it"))
    assert errors.get("n1") == {"error": "Moodboard 'b1' is in Recently deleted. Restore it."}
