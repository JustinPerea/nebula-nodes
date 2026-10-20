"""A failed node still shows its error after a reload, a project switch and a restart.

Before, the card lost its error on a reload (it showed complete or idle)
while look_at_canvas still reported it: the graph the page loads (graphSync,
GET /api/projects/{id}) carried no error state. The person's own failed
canvas runs behaved the same. Now each node's last error (services/
node_errors.py) is kept per project, on disk, and every graph the page loads
says it: state "error" with the card's error, errorFriendly and errorCategory.
"""
from __future__ import annotations

import asyncio
import json
import sys
from pathlib import Path
from unittest.mock import AsyncMock

import pytest
from fastapi.testclient import TestClient

sys.path.insert(0, str(Path(__file__).resolve().parent.parent))
import main as main_module
from models.events import ErrorEvent, ExecutedEvent, ExecutingEvent
from services.cli_graph import CLIGraph
from services.execution_runs import ExecutionRunRegistry
from services.node_errors import NodeErrors
from services.project_store import ProjectStore
from services.provider_recovery import ProviderRecoveryStore
from services.provider_start_guard import ProviderStartGuard

GPT_IMAGE_2 = "gpt-image-2-generate"
MISSING = "Missing API key: OPENAI_API_KEY"


# -- the service ------------------------------------------------------------------

def test_errors_survive_a_restart_and_stay_with_their_project(tmp_path):
    path = tmp_path / "node-errors.json"
    errors = NodeErrors(path)
    errors.use_project("p1")
    errors.observe(ErrorEvent(node_id="n2", error="HTTP 401 from OpenAI", category="auth",
                              friendly="OpenAI didn't accept the key"))
    # Node ids restart in each project: p2's n2 is another node.
    errors.use_project("p2")
    assert errors.get("n2") is None
    errors.record("n2", "something else")

    restarted = NodeErrors(path)
    restarted.use_project("p1")
    assert restarted.get("n2") == {"error": "HTTP 401 from OpenAI", "hint": "OpenAI didn't accept the key"}
    assert restarted.card("n2") == {"state": "error", "error": "HTTP 401 from OpenAI",
                                    "errorFriendly": "OpenAI didn't accept the key", "errorCategory": "auth"}
    # Running it again clears it, on disk too.
    restarted.observe(ExecutingEvent(node_id="n2"))
    again = NodeErrors(path)
    again.use_project("p1")
    assert again.get("n2") is None and again.card("n2") is None
    again.use_project("p2")
    assert again.get("n2") == {"error": "something else"}
    # A project deleted for good takes its errors with it.
    again.keep_projects({"p1"})
    assert NodeErrors(path).projects() == []


def test_an_unreadable_file_starts_empty_and_a_failed_write_never_breaks_a_run(tmp_path):
    path = tmp_path / "node-errors.json"
    path.write_text("{not json", encoding="utf-8")
    errors = NodeErrors(path)
    errors.use_project("p1")
    assert errors.get("n1") is None
    (tmp_path / "node-errors.json").unlink()
    (tmp_path / "node-errors.json").mkdir()  # the write now fails
    errors.record("n1", "HTTP 500")
    assert errors.get("n1") == {"error": "HTTP 500"}


def test_the_file_is_private_like_the_other_state_files(tmp_path):
    """Provider error bodies can echo a prompt or part of a request; every
    other file in the state dir is written 0600 (provider_recovery,
    provider_start_guard)."""
    path = tmp_path / "node-errors.json"
    errors = NodeErrors(path)
    errors.use_project("p1")
    errors.record("n1", "HTTP 400: the prompt 'a private brief' was refused")
    assert path.stat().st_mode & 0o777 == 0o600
    assert [entry.name for entry in tmp_path.iterdir()] == ["node-errors.json"]


# -- the graph the page loads ------------------------------------------------------

@pytest.fixture
def workspace(tmp_path, monkeypatch):
    graph = CLIGraph(persist_path=tmp_path / "state.json")
    store = ProjectStore(tmp_path / "projects")
    monkeypatch.setattr(main_module, "cli_graph", graph)
    monkeypatch.setattr(main_module, "project_store", store)
    monkeypatch.setattr(main_module, "node_errors", NodeErrors(tmp_path / "node-errors.json"))
    monkeypatch.setattr(main_module, "provider_recovery_store", ProviderRecoveryStore(None))
    monkeypatch.setattr(main_module, "provider_start_guard", ProviderStartGuard(tmp_path / "paid-starts.json"))
    monkeypatch.setattr(main_module, "execution_runs", ExecutionRunRegistry())
    monkeypatch.setattr(main_module, "_graph_recovery_bootstrap_error", None)
    monkeypatch.setattr(main_module, "load_settings", lambda: {"apiKeys": {}})
    broadcast = AsyncMock()
    monkeypatch.setattr(main_module.manager, "broadcast_raw", broadcast)
    return TestClient(main_module.app), graph, store, broadcast, tmp_path


def _create(client, name, revision=None, headers=None):
    body = {"name": name, **({"workspaceRevision": revision} if revision else {})}
    response = client.post("/api/projects", json=body, headers=headers or {})
    assert response.status_code == 200, response.text
    return response.json()


def _image_node(graph) -> str:
    """A prompt wired into GPT Image 2; returns the image node's id."""
    prompt = graph.add_node("text-input", {"value": "a dune"})
    image = graph.add_node(GPT_IMAGE_2, {})
    graph.connect(prompt, "text", image, "prompt")
    return image


def _canvas_run_refused(client, graph, node_id: str) -> None:
    """The person clicks Run on a node with no key: the pre-call check refuses it."""
    state = graph.get_state()
    nodes = [{"id": n["id"], "definitionId": n["definitionId"], "params": n.get("params") or {}} for n in state["nodes"]]
    edges = [{"id": e["id"], "source": e["source"], "sourceHandle": e["sourceHandle"], "target": e["target"],
              "targetHandle": e["targetHandle"]} for e in state["edges"]]
    refused = client.post("/api/execute", json={"nodes": nodes, "edges": edges}).json()
    assert refused["status"] == "validation_error", refused


def _loaded(client, project_id: str, node_id: str) -> dict:
    """What a reloaded page puts on the card: GET /api/projects/{id} (loadWorkspace)."""
    snapshot = client.get(f"/api/projects/{project_id}").json()["snapshot"]
    return next(node["data"] for node in snapshot["nodes"] if node["id"] == node_id)


def _synced(node_id: str) -> dict:
    """What the socket's graphSync says about the node (on connect, and after any change)."""
    export = asyncio.run(main_module.export_graph_for_frontend())
    return next(node["data"] for node in export["nodes"] if node["id"] == node_id)


def test_a_reloaded_page_shows_a_failed_canvas_run_on_its_card(workspace, person):
    client, graph, _store, _broadcast, _tmp = workspace
    project = _create(client, "Dunes", headers=person.headers)["project"]["id"]
    image = _image_node(graph)
    _canvas_run_refused(client, graph, image)

    for data in (_loaded(client, project, image), _synced(image)):
        assert data["state"] == "error"
        assert data["error"] == MISSING
    # An agent reads the same thing.
    look = client.get("/api/canvas/snapshot").json()
    assert next(node for node in look["nodes"] if node["id"] == image)["error"] == MISSING


def test_an_old_output_does_not_hide_the_error_and_a_new_run_clears_it(workspace, person):
    client, graph, _store, _broadcast, _tmp = workspace
    project = _create(client, "Dunes", headers=person.headers)["project"]["id"]
    image = _image_node(graph)
    graph.nodes[image]["outputs"] = {"image": {"type": "Image", "value": "/api/outputs/old.png"}}
    asyncio.run(main_module._emit_and_sync(ErrorEvent(
        node_id=image, error="HTTP 429: rate limited", category="rate_limit", friendly="OpenAI is busy")))

    loaded = _loaded(client, project, image)
    assert loaded["state"] == "error"
    assert (loaded["error"], loaded["errorFriendly"], loaded["errorCategory"]) == (
        "HTTP 429: rate limited", "OpenAI is busy", "rate_limit")
    assert loaded["outputs"]["image"]["value"].endswith("/api/outputs/old.png")

    asyncio.run(main_module._emit_and_sync(ExecutingEvent(node_id=image)))
    asyncio.run(main_module._emit_and_sync(ExecutedEvent(
        node_id=image, outputs={"image": {"type": "Image", "value": "/api/outputs/new.png"}})))
    assert _synced(image)["state"] == "complete"
    assert _loaded(client, project, image)["state"] == "complete"


def test_the_error_comes_back_after_switching_projects_and_back(workspace, person):
    client, graph, _store, broadcast, _tmp = workspace
    first = _create(client, "Dunes", headers=person.headers)
    image = _image_node(graph)
    _canvas_run_refused(client, graph, image)

    second = _create(client, "Forests", first["workspaceRevision"], headers=person.headers)
    # The new project's first node has the same id, and no error.
    other = _image_node(graph)
    assert other == image
    assert _synced(other)["state"] == "idle" and "error" not in _synced(other)

    broadcast.reset_mock()
    opened = client.post(f"/api/projects/{first['project']['id']}/open",
                         json={"workspaceRevision": second["workspaceRevision"]}, headers=person.headers)
    assert opened.status_code == 200, opened.text
    node = next(n for n in opened.json()["project"]["snapshot"]["nodes"] if n["id"] == image)
    assert node["data"]["state"] == "error" and node["data"]["error"] == MISSING
    sync = [c.args[0] for c in broadcast.call_args_list if c.args[0].get("type") == "graphSync"][-1]
    assert sync["graphReplaced"] is True
    synced = next(n for n in sync["nodes"] if n["id"] == image)["data"]
    assert synced["state"] == "error" and synced["error"] == MISSING
    assert _loaded(client, first["project"]["id"], image)["state"] == "error"


def test_the_error_survives_a_backend_restart(workspace, person, monkeypatch):
    client, graph, _store, _broadcast, tmp = workspace
    project = _create(client, "Dunes", headers=person.headers)["project"]["id"]
    image = _image_node(graph)
    _canvas_run_refused(client, graph, image)

    # A new process: the store is read back from disk and pointed at the open project.
    monkeypatch.setattr(main_module, "node_errors", NodeErrors(tmp / "node-errors.json"))
    main_module._restore_node_errors()

    assert _loaded(client, project, image)["state"] == "error"
    look = client.get("/api/canvas/snapshot").json()
    assert next(node for node in look["nodes"] if node["id"] == image)["error"] == MISSING


def test_loading_a_graph_over_the_project_forgets_its_errors(workspace, person):
    client, graph, _store, _broadcast, _tmp = workspace
    _create(client, "Dunes", headers=person.headers)
    image = _image_node(graph)
    _canvas_run_refused(client, graph, image)

    cleared = client.delete("/api/graph?force=true", headers=person.headers)
    assert cleared.status_code == 200, cleared.text
    again = _image_node(graph)
    assert "error" not in _synced(again) and main_module.node_errors.get(again) is None


def test_a_project_deleted_for_good_takes_its_errors(workspace, person):
    client, graph, _store, _broadcast, tmp = workspace
    first = _create(client, "Dunes", headers=person.headers)
    image = _image_node(graph)
    _canvas_run_refused(client, graph, image)
    second = _create(client, "Forests", first["workspaceRevision"], headers=person.headers)
    gone = client.request("DELETE", f"/api/projects/{first['project']['id']}",
                          json={"workspaceRevision": second["workspaceRevision"]}, headers=person.headers)
    assert gone.status_code == 200, gone.text
    # In Recently deleted it can come back, errors and all.
    assert first["project"]["id"] in NodeErrors(tmp / "node-errors.json").projects()
    purged = client.delete(f"/api/projects/trash/{first['project']['id']}", headers=person.headers)
    assert purged.status_code == 200, purged.text
    assert first["project"]["id"] not in NodeErrors(tmp / "node-errors.json").projects()
    saved = json.loads((tmp / "node-errors.json").read_text(encoding="utf-8"))
    assert first["project"]["id"] not in saved["projects"]


# -- undo puts a failed node back as it was -----------------------------------------

def test_undoing_the_delete_of_a_failed_node_brings_its_error_back(workspace, person):
    """Review, 2026-10-20: deleting a failed node and pressing Cmd-Z showed the
    error on that tab's card again (from its undo history) while
    look_at_canvas, other tabs and a reload said idle: the export had pruned
    the error. Node ids aren't handed out again in a project (the counter
    moves past them), so the error can wait with the deleted node."""
    client, graph, _store, _broadcast, _tmp = workspace
    project = _create(client, "Dunes", headers=person.headers)["project"]["id"]
    image = _image_node(graph)
    _canvas_run_refused(client, graph, image)

    assert client.delete(f"/api/graph/node/{image}", headers=person.headers).status_code == 200
    assert image not in {node["id"] for node in client.get("/api/canvas/snapshot").json()["nodes"]}
    undone = client.post("/api/graph/restore", headers=person.headers, json={
        "action": "undo", "nodes": [{"id": image, "definitionId": GPT_IMAGE_2, "params": {}}]})
    assert undone.status_code == 200, undone.text

    assert _synced(image)["state"] == "error" and _synced(image)["error"] == MISSING
    assert _loaded(client, project, image)["state"] == "error"
    look = client.get("/api/canvas/snapshot").json()
    assert next(node for node in look["nodes"] if node["id"] == image)["error"] == MISSING


def test_deleting_every_node_one_by_one_keeps_errors_for_an_undo(workspace, person):
    """Only clearing the canvas restarts node ids (CLIGraph.clear); an empty
    canvas reached by deleting nodes keeps them for the undo."""
    client, graph, _store, _broadcast, _tmp = workspace
    _create(client, "Dunes", headers=person.headers)
    image = _image_node(graph)
    _canvas_run_refused(client, graph, image)
    for node_id in list(graph.nodes):
        assert client.delete(f"/api/graph/node/{node_id}", headers=person.headers).status_code == 200
    assert asyncio.run(main_module.export_graph_for_frontend())["empty"] is True

    undone = client.post("/api/graph/restore", headers=person.headers, json={
        "action": "undo", "nodes": [{"id": image, "definitionId": GPT_IMAGE_2, "params": {}}]})
    assert undone.status_code == 200, undone.text
    assert _synced(image)["state"] == "error"


def test_an_undo_that_swaps_an_id_for_another_node_does_not_hand_it_the_error(workspace, person):
    """An id in both `remove` and `nodes` swaps one node for another (undoing
    an import that gave ids out again): the node coming back never failed."""
    client, graph, _store, _broadcast, _tmp = workspace
    _create(client, "Dunes", headers=person.headers)
    image = _image_node(graph)
    _canvas_run_refused(client, graph, image)

    swapped = client.post("/api/graph/restore", headers=person.headers, json={
        "action": "undo", "remove": [image], "nodes": [{"id": image, "definitionId": "text-input",
                                                       "params": {"value": "the node before"}}]})
    assert swapped.status_code == 200, swapped.text
    assert graph.nodes[image]["definitionId"] == "text-input"
    assert "error" not in _synced(image) and main_module.node_errors.get(image) is None
