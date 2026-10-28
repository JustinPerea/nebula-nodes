"""PR #198 fix round 4 (review 4 and GM's round-4 rulings, gm-pr198-r4.md, gm-pr198-r5.md).

- M2: a Cinema shot run with variations renders its upstream scenes again in
  every pass. Each upstream scene stays protected for the whole shot run and
  is released when the run ends, stops or fails (review 4's probe
  "variation pass 2 re-renders an upstream scene unprotected").
- L1: a shot id made up for a shot that had none never takes over a port a
  removed shot left on the node (review 4's probe "H1 lenient id meets a
  dangling port").
- M1 (the canvas's half): the person's refused scene delete carries which
  shots are rendering (``rendering``), so a multi-select delete can say
  "Deleted 2 nodes." and GM's kept line instead of a second refusal line.
- N2: an import refused while a run is active reads as a line for the person.
"""
from __future__ import annotations

import asyncio
import threading
import time

import pytest
from fastapi.testclient import TestClient

import main as main_module
from services import cinema_scene_spec
from services.agent_presence import AgentPresence
from services.cli_graph import CLIGraph
from services.selection_context import SelectionContextStore
from tests.conftest import PERSON
from tests.test_agent_presence import api  # noqa: F401 - fixture
from tests.test_params_version_gate import workspace  # noqa: F401 - fixture

AGENT = {"X-Nebula-Agent": "Codex"}
BASE = {"version": 1, "base": {"model": "seedream-4-5"}, "aspectRatio": "16:9"}


def _scene(*ids):
    return {**BASE, "shots": [{"id": shot_id, "prompt": shot_id} for shot_id in ids]}


def _wait(predicate, seconds=8.0):
    deadline = time.monotonic() + seconds
    while time.monotonic() < deadline:
        if predicate():
            return True
        time.sleep(0.02)
    return False


# -- M2: an upstream scene is held for the whole shot run -----------------------------


@pytest.fixture
def engine(monkeypatch, person):
    """The real engine with a fake cinema-scene handler (nothing paid). A node
    id in ``hold`` makes its Nth call (``hold[id] = N``) wait for ``release``;
    a node id in ``fail`` makes that held call raise."""
    graph = CLIGraph()
    monkeypatch.setattr(main_module, "cli_graph", graph)
    monkeypatch.setattr(main_module, "agent_presence", AgentPresence())
    monkeypatch.setattr(main_module, "selection_context", SelectionContextStore())
    monkeypatch.setattr(main_module, "_check_workspace_revision", lambda: None)
    monkeypatch.setattr(main_module, "validate_graph", lambda *a, **k: [])
    calls: list[str] = []
    hold: dict[str, int] = {}
    fail: set[str] = set()
    release = threading.Event()
    real = main_module.get_handler_registry

    def registry(**kwargs):
        handlers = real(**kwargs)

        async def scene(node, inputs, api_keys, *rest, **kw):
            calls.append(node.id)
            if hold.get(node.id) == calls.count(node.id):
                while not release.is_set():
                    await asyncio.sleep(0.01)
                if node.id in fail:
                    raise RuntimeError("fake handler failure")
            return {}

        handlers["cinema-scene"] = scene
        return handlers

    monkeypatch.setattr(main_module, "get_handler_registry", registry)
    main_module._cinema_renders.clear()
    main_module._cinema_admitting.clear()
    main_module.execution_cache.clear()
    with TestClient(main_module.app) as http:
        yield http, graph, calls, hold, fail, release
        release.set()
        time.sleep(0.2)
    main_module._cinema_renders.clear()
    main_module._cinema_admitting.clear()


def _status(http, run_id):
    return http.get(f"/api/executions/{run_id}").json().get("status")


def _upstream_shot_run(http, graph, run_id, hold, fail_upstream=False, fail=None):
    """An upstream scene wired into a scene, and a two-pass shot run of the
    downstream scene whose second pass waits inside the upstream render."""
    up = graph.add_node("cinema-scene", {"scene": _scene("u1", "u2")})
    graph.set_label(up, "Upstream")
    down = graph.add_node("cinema-scene", {"scene": _scene("s1")})
    wired = http.post("/api/graph/connect", headers=PERSON, json={
        "source": up, "sourceHandle": "shot_u1", "target": down, "targetHandle": "character_refs"})
    assert wired.status_code == 200, wired.text
    hold[up] = 2
    if fail_upstream:
        fail.add(up)
    nodes, edges = graph.to_execute_format()
    started = http.post("/api/cinema/generate-shot", headers=PERSON, json={
        "nodeId": down, "shotId": "s1", "nodes": nodes, "edges": edges, "runId": run_id, "variations": 2})
    assert started.status_code == 200, started.text
    return up, down


def test_variation_pass_2_keeps_the_upstream_scene_protected(engine):
    http, graph, calls, hold, fail, release = engine
    up, _down = _upstream_shot_run(http, graph, "fix4-var", hold)
    assert _wait(lambda: calls.count(up) >= 2), calls
    # Pass 2 renders the upstream scene again: it is held, as in pass 1.
    dropped = http.put(f"/api/graph/node/{up}", headers=AGENT, json={"params": {"scene": _scene("u1")}})
    assert dropped.status_code == 409, dropped.text
    deleted = http.delete(f"/api/graph/node/{up}", headers=AGENT)
    assert deleted.status_code == 409, deleted.text
    assert "fix4-var" in deleted.json()["detail"]
    person_delete = http.delete(f"/api/graph/node/{up}", headers=PERSON)
    assert person_delete.status_code == 409
    assert person_delete.json()["detail"] == (
        "Couldn't delete “Upstream”. “Shot 1” and “Shot 2” are still running. Stop the run first.")
    assert up in graph.nodes
    release.set()
    assert _wait(lambda: _status(http, "fix4-var") not in ("running", "cancelling", None))
    # The run is over: the scene is free, and nothing of the run is left noted.
    assert http.put(f"/api/graph/node/{up}", headers=AGENT,
                    json={"params": {"scene": _scene("u1")}}).status_code == 200
    assert "fix4-var" not in main_module._cinema_renders or main_module._rendering_runs(up) == []
    assert http.delete(f"/api/graph/node/{up}", headers=AGENT).status_code == 200


def test_between_passes_the_upstream_scene_is_still_held(engine):
    """After pass 1's upstream Executed (the L2 release point for a canvas
    run), a shot run still holds its upstream scene: pass 2 will render it."""
    http, graph, calls, hold, fail, release = engine
    up = graph.add_node("cinema-scene", {"scene": _scene("u1", "u2")})
    down = graph.add_node("cinema-scene", {"scene": _scene("s1")})
    assert http.post("/api/graph/connect", headers=PERSON, json={
        "source": up, "sourceHandle": "shot_u1", "target": down, "targetHandle": "character_refs"}).status_code == 200
    # Pass 1's downstream render waits: the upstream is done with in pass 1.
    hold[down] = 1
    nodes, edges = graph.to_execute_format()
    assert http.post("/api/cinema/generate-shot", headers=PERSON, json={
        "nodeId": down, "shotId": "s1", "nodes": nodes, "edges": edges, "runId": "fix4-between",
        "variations": 2}).status_code == 200
    assert _wait(lambda: calls.count(down) >= 1), calls
    assert calls.count(up) == 1
    assert http.put(f"/api/graph/node/{up}", headers=AGENT,
                    json={"params": {"scene": _scene("u1")}}).status_code == 409
    release.set()
    assert _wait(lambda: _status(http, "fix4-between") not in ("running", "cancelling", None))
    assert http.put(f"/api/graph/node/{up}", headers=AGENT,
                    json={"params": {"scene": _scene("u1")}}).status_code == 200


def test_stopping_the_shot_run_releases_its_upstream_scene(engine):
    http, graph, calls, hold, fail, release = engine
    up, _down = _upstream_shot_run(http, graph, "fix4-stop", hold)
    assert _wait(lambda: calls.count(up) >= 2), calls
    assert http.put(f"/api/graph/node/{up}", headers=AGENT,
                    json={"params": {"scene": _scene("u1")}}).status_code == 409
    assert http.delete("/api/executions/fix4-stop", headers=PERSON).status_code in (200, 202)
    release.set()
    assert _wait(lambda: _status(http, "fix4-stop") not in ("running", "cancelling", None))
    assert http.put(f"/api/graph/node/{up}", headers=AGENT,
                    json={"params": {"scene": _scene("u1")}}).status_code == 200
    assert main_module._rendering_runs(up) == []


def test_a_failed_shot_run_releases_its_upstream_scene(engine):
    http, graph, calls, hold, fail, release = engine
    up, _down = _upstream_shot_run(http, graph, "fix4-fail", hold, fail_upstream=True, fail=fail)
    assert _wait(lambda: calls.count(up) >= 2), calls
    assert http.put(f"/api/graph/node/{up}", headers=AGENT,
                    json={"params": {"scene": _scene("u1")}}).status_code == 409
    release.set()
    assert _wait(lambda: _status(http, "fix4-fail") not in ("running", "cancelling", None))
    assert http.put(f"/api/graph/node/{up}", headers=AGENT,
                    json={"params": {"scene": _scene("u1")}}).status_code == 200
    assert main_module._rendering_runs(up) == []


class _Node:
    def __init__(self, node_id, definition_id):
        self.id = node_id
        self.definition_id = definition_id


@pytest.fixture
def rendering(monkeypatch):
    active: set[str] = set()
    monkeypatch.setattr(main_module, "_run_is_active", lambda run_id: run_id in active)
    main_module._cinema_renders.clear()
    main_module._cinema_admitting.clear()
    yield active
    main_module._cinema_renders.clear()
    main_module._cinema_admitting.clear()


def test_a_canvas_run_still_frees_a_scene_once_the_engine_is_done_with_it(api, rendering):  # noqa: F811
    """Review 3's L2 stays for a run of the graph: only a shot run holds its
    upstream scenes to the end (its passes render them again)."""
    client, graph, _sent = api
    node = graph.add_node("cinema-scene", {"scene": _scene("s1", "s2")})
    main_module._note_scene_renders("graph-run", [_Node(node, "cinema-scene")])
    rendering.add("graph-run")
    main_module._scene_render_done("graph-run", node)
    assert client.put(f"/api/graph/node/{node}", headers=AGENT,
                      json={"params": {"scene": _scene("s1")}}).status_code == 200


def test_a_shot_runs_upstream_scene_is_not_freed_by_its_executed_event(api, rendering):  # noqa: F811
    from models.events import ExecutedEvent

    client, graph, _sent = api
    up = graph.add_node("cinema-scene", {"scene": _scene("u1", "u2")})
    down = graph.add_node("cinema-scene", {"scene": _scene("s1")})
    main_module._note_scene_renders("shot-run", [_Node(up, "cinema-scene"), _Node(down, "cinema-scene")],
                                    shot=(down, "s1"))
    rendering.add("shot-run")
    asyncio.run(main_module._emit_and_sync(ExecutedEvent(node_id=up, outputs={}, run_id="shot-run")))
    assert client.put(f"/api/graph/node/{up}", headers=AGENT,
                      json={"params": {"scene": _scene("u1")}}).status_code == 409
    rendering.discard("shot-run")
    assert client.put(f"/api/graph/node/{up}", headers=AGENT,
                      json={"params": {"scene": _scene("u1")}}).status_code == 200
    assert main_module._rendering_runs(up) == []


# -- M1: the refusal says which shots are rendering ------------------------------------


def test_the_persons_refused_scene_delete_names_the_rendering_shots(api, rendering, person):  # noqa: F811
    client, graph, _sent = api
    node = graph.add_node("cinema-scene", {"scene": _scene("s1", "s2", "s3")})
    graph.set_label(node, "Agent scene")
    main_module._note_cinema_render("run-r", node, "s2")
    rendering.add("run-r")
    reply = client.delete(f"/api/graph/node/{node}", headers=PERSON)
    assert reply.status_code == 409
    body = reply.json()
    assert body["detail"] == "Couldn't delete “Agent scene”. “Shot 2” is still running. Stop the run first."
    assert body["rendering"] == {"shots": [2], "stoppable": True}
    agent = client.delete(f"/api/graph/node/{node}", headers=AGENT)
    assert agent.status_code == 409
    assert agent.json()["rendering"] == {"shots": [2], "stoppable": True}
    assert "run-r" in agent.json()["detail"]


def test_a_scene_delete_while_admitting_says_wait(api, rendering, person):  # noqa: F811
    client, graph, _sent = api
    node = graph.add_node("cinema-scene", {"scene": _scene("s1", "s2")})
    with main_module._cinema_admission_scope():
        main_module._note_cinema_render("admitting", node, None)
        reply = client.delete(f"/api/graph/node/{node}", headers=PERSON)
    assert reply.status_code == 409
    assert reply.json()["rendering"] == {"shots": [1, 2], "stoppable": False}
    assert reply.json()["detail"].endswith("Wait for it to finish.")


# -- L1: a made-up shot id never takes over a removed shot's port -------------------


LEFTOVER = {"shot_s2": {"type": "Image", "value": "/api/outputs/old-removed-shot.png"}}
NO_ID = {**BASE, "shots": [{"id": "s1", "prompt": "a"}, {"prompt": "new, no id"}]}


def _new_shot_id(scene):
    ids = [shot["id"] for shot in scene["shots"]]
    assert ids[0] == "s1" and len(ids) == 2
    return ids[1]


def test_the_lenient_read_skips_reserved_ids():
    scene = cinema_scene_spec.normalize_scene(NO_ID, strict=False, reserved={"s2"})
    assert _new_shot_id(scene) == "s3"
    assert cinema_scene_spec.shot_port_ids(LEFTOVER) == {"s2"}
    assert cinema_scene_spec.shot_port_ids({"image": {}, "shot_": {}, "shot_x": {}}) == {"x"}
    assert cinema_scene_spec.shot_port_ids(None) == set()


def test_a_project_open_never_gives_a_new_shot_a_leftover_port(workspace):  # noqa: F811
    client, graph, store, _ = workspace
    a = client.post("/api/projects", json={"name": "A"}).json()
    b = client.post("/api/projects", json={"name": "B", "workspaceRevision": a["workspaceRevision"]}).json()
    scene_node = {"id": "n1", "type": "cinemaSceneNode", "position": {"x": 0, "y": 0},
                  "data": {"definitionId": "cinema-scene", "label": "Opening", "params": {"scene": NO_ID},
                           "outputs": LEFTOVER}}
    with store.transaction() as catalog:
        catalog["projects"][a["project"]["id"]]["snapshot"] = {
            "nodes": [scene_node], "edges": [], "runHistory": [], "viewport": None, "createSessionId": None}
        store.commit(catalog)
    opened = client.post(f"/api/projects/{a['project']['id']}/open", json={"workspaceRevision": b["workspaceRevision"]})
    assert opened.status_code == 200, opened.text
    new_id = _new_shot_id(graph.nodes["n1"]["params"]["scene"])
    assert new_id != "s2"
    assert f"shot_{new_id}" not in (graph.nodes["n1"].get("outputs") or {})


def test_an_import_never_gives_a_new_shot_a_leftover_port(api):  # noqa: F811
    client, graph, _sent = api
    reply = client.post("/api/graph/import", headers=PERSON, json={"nodes": [
        {"id": "n1", "definitionId": "cinema-scene", "params": {"scene": NO_ID}, "outputs": LEFTOVER}], "edges": []})
    assert reply.status_code == 200, reply.text
    (node,) = graph.nodes.values()
    assert _new_shot_id(node["params"]["scene"]) != "s2"


def test_the_persons_put_never_gives_a_new_shot_a_leftover_port(api, person):  # noqa: F811
    client, graph, _sent = api
    node = graph.add_node("cinema-scene", {"scene": _scene("s1")})
    graph.nodes[node]["outputs"] = dict(LEFTOVER)
    reply = client.put(f"/api/graph/node/{node}", headers=PERSON, json={"params": {"scene": NO_ID}})
    assert reply.status_code == 200, reply.text
    assert _new_shot_id(graph.nodes[node]["params"]["scene"]) != "s2"


def test_the_persons_undo_never_gives_a_new_shot_a_leftover_port(api, person):  # noqa: F811
    client, graph, _sent = api
    node = graph.add_node("cinema-scene", {"scene": _scene("s1")})
    graph.nodes[node]["outputs"] = dict(LEFTOVER)
    reply = client.post("/api/graph/restore", headers=PERSON, json={"action": "undo", "nodes": [
        {"id": node, "definitionId": "cinema-scene", "params": {"scene": NO_ID}}],
        "remove": [], "wire": [], "unwire": []})
    assert reply.status_code == 200, reply.text
    assert _new_shot_id(graph.nodes[node]["params"]["scene"]) != "s2"


def test_a_saved_graph_loads_without_a_new_shot_taking_a_leftover_port(tmp_path):
    graph = CLIGraph()
    node = graph.add_node("cinema-scene", {"scene": NO_ID}, outputs=LEFTOVER)
    assert _new_shot_id(graph.nodes[node]["params"]["scene"]) != "s2"
    import json
    path = tmp_path / "state.json"
    path.write_text(json.dumps({"nodes": [{"id": "n1", "definitionId": "cinema-scene",
                                           "params": {"scene": NO_ID}, "outputs": LEFTOVER}],
                                "edges": [], "counter": 1}))
    loaded = CLIGraph()
    loaded.load(path)
    assert _new_shot_id(loaded.nodes["n1"]["params"]["scene"]) != "s2"


# -- N2: an import refused during a run, in the person's words ------------------------


def test_an_import_during_a_run_reads_as_a_line_for_the_person(api, person, monkeypatch):  # noqa: F811
    client, _graph, _sent = api
    monkeypatch.setattr(main_module.execution_runs, "has_active", lambda: True)
    reply = client.post("/api/graph/import", headers=PERSON, json={"nodes": [], "edges": []})
    assert reply.status_code == 409
    assert reply.json()["detail"] == "A run is still going. Wait for it to finish or stop it first."
    agent = client.post("/api/graph/import", headers=AGENT, json={"nodes": [], "edges": []})
    assert agent.status_code == 409
    assert agent.json()["detail"].startswith("Cannot replace the graph while a run is active.")


def test_a_project_with_a_leftover_port_and_its_wire_still_opens(workspace):  # noqa: F811
    """Saved data is converted, never refused (review 3, H1): a port no shot
    owns (and a wire from it) is left out, and the project opens."""
    client, graph, store, _ = workspace
    a = client.post("/api/projects", json={"name": "A"}).json()
    b = client.post("/api/projects", json={"name": "B", "workspaceRevision": a["workspaceRevision"]}).json()
    scene_node = {"id": "n1", "type": "cinemaSceneNode", "position": {"x": 0, "y": 0},
                  "data": {"definitionId": "cinema-scene", "label": "Opening",
                           "params": {"scene": {**BASE, "shots": [{"id": "s1", "prompt": "a"}]}}, "outputs": LEFTOVER}}
    sink = {"id": "n2", "type": "cinemaSceneNode", "position": {"x": 400, "y": 0},
            "data": {"definitionId": "cinema-scene", "label": "Next", "params": {"scene": _scene("t1")}, "outputs": {}}}
    wire = {"id": "e1", "source": "n1", "sourceHandle": "shot_s2", "target": "n2", "targetHandle": "character_refs"}
    with store.transaction() as catalog:
        catalog["projects"][a["project"]["id"]]["snapshot"] = {
            "nodes": [scene_node, sink], "edges": [wire], "runHistory": [], "viewport": None, "createSessionId": None}
        store.commit(catalog)
    opened = client.post(f"/api/projects/{a['project']['id']}/open", json={"workspaceRevision": b["workspaceRevision"]})
    assert opened.status_code == 200, opened.text
    assert "shot_s2" not in (graph.nodes["n1"].get("outputs") or {})
