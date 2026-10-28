"""PR #198 fix round 3 (review 3 and GM's round-3 rulings, gm-pr198-r3.md).

- H1: only an agent-authored write (create, edit_canvas, a proposal, an
  agent's PUT) may be refused for a malformed Cinema scene. Every other path
  (a project's open, every save and autosave, the handoff save, a recovered
  copy, import, the person's own PUT, the person's undo) converts what it can
  and fills the rest with the defaults, so a saved project always opens and
  saves, and its paid results stay reachable.
- M1: a run that renders two scenes protects both.
- L1: a render is protected from the start of its run's admission.
- L2: only the shots a run actually renders are protected.
- L3: a shot that adopts a late image gets a consistent variations list.
- G1 (GM: yes): a scene can't be deleted while one of its shots renders.
- M2: the person's undo or redo that would remove a rendering shot gets
  GM's line; agents keep the specific detail.
- L5: money never raises on a float denormal and never prints 300 digits.
"""
from __future__ import annotations

import json
import math
import sys
import random

import pytest

import main as main_module
from cli.commands import spend as spend_command
from services import agent_spend, cinema_scene_spec, money
from services.cli_graph import CLIGraph
from tests.conftest import PERSON
from tests.test_agent_presence import _presence_events, api  # noqa: F401 - fixture
from tests.test_params_version_gate import workspace  # noqa: F401 - fixture

AGENT = {"X-Nebula-Agent": "Codex"}
BASE = {"version": 1, "base": {"model": "seedream-4-5"}, "aspectRatio": "16:9"}

# Every malformed shape review 3 found (and a few more of the same kind), by
# what a lenient read makes of it: (scene as saved, check on the result).
SHAPES = {
    "base as a string": {**BASE, "base": "nano-banana", "shots": [{"id": "s1", "prompt": "a"}]},
    "prompt a number": {**BASE, "shots": [{"id": "s1", "prompt": 5}]},
    "prompt a list": {**BASE, "shots": [{"id": "s1", "prompt": ["x"]}]},
    "version a string": {**BASE, "version": "1", "shots": [{"id": "s1", "prompt": "a"}]},
    "version a float": {**BASE, "version": 1.0, "shots": [{"id": "s1", "prompt": "a"}]},
    "aspect a number": {**BASE, "aspectRatio": 1.5, "shots": [{"id": "s1", "prompt": "a"}]},
    "duplicate shot ids": {**BASE, "shots": [{"id": "s1", "prompt": "a"}, {"id": "s1", "prompt": "b"}]},
    "shot without an id": {**BASE, "shots": [{"prompt": "a"}]},
    "shot null": {**BASE, "shots": [None, {"id": "s1", "prompt": "a"}]},
    "shots a string": {**BASE, "shots": "s1"},
    "scene a string": "a scene",
    "scene as JSON text": json.dumps({"shots": [{"id": "s1", "prompt": "a"}]}),
}


def _check_scene(scene):
    """What every lenient read leaves: a scene the studio and the handler can read."""
    assert isinstance(scene, dict)
    assert scene["version"] == 1
    assert isinstance(scene["base"], dict) and isinstance(scene["base"]["model"], str) and scene["base"]["model"]
    assert isinstance(scene["aspectRatio"], str) and scene["aspectRatio"]
    assert isinstance(scene["shots"], list)
    ids = [shot["id"] for shot in scene["shots"]]
    assert all(isinstance(shot, dict) for shot in scene["shots"])
    assert all(isinstance(shot_id, str) and shot_id for shot_id in ids)
    assert len(set(ids)) == len(ids)
    assert all(isinstance(shot["prompt"], str) for shot in scene["shots"])


# -- H1: the normalizer converts what it can --------------------------------------


@pytest.mark.parametrize("name", list(SHAPES))
def test_a_lenient_read_converts_every_malformed_shape(name):
    scene = cinema_scene_spec.normalize_scene(SHAPES[name], strict=False)
    _check_scene(scene)
    # Converting again changes nothing: the ids an open gave are the ones the next save keeps.
    assert cinema_scene_spec.normalize_scene(scene, strict=False) == scene
    assert cinema_scene_spec.normalize_scene(SHAPES[name], strict=False) == scene


def test_what_a_lenient_read_keeps():
    convert = lambda scene: cinema_scene_spec.normalize_scene(scene, strict=False)  # noqa: E731
    assert convert(SHAPES["base as a string"])["base"] == {"model": "nano-banana"}
    assert convert(SHAPES["prompt a number"])["shots"][0]["prompt"] == "5"
    assert convert(SHAPES["prompt a list"])["shots"][0]["prompt"] == ""
    assert convert(SHAPES["version a string"])["version"] == 1
    assert convert(SHAPES["aspect a number"])["aspectRatio"] == "16:9"
    dup = convert(SHAPES["duplicate shot ids"])["shots"]
    assert dup[0] == {"id": "s1", "prompt": "a"} and dup[1]["prompt"] == "b" and dup[1]["id"] != "s1"
    assert convert(SHAPES["shot without an id"])["shots"][0]["prompt"] == "a"
    assert [shot["id"] for shot in convert(SHAPES["shot null"])["shots"]] == ["s1"]
    assert convert(SHAPES["shots a string"])["shots"] == []
    assert convert(SHAPES["scene a string"])["shots"] == []
    assert convert(SHAPES["scene as JSON text"])["shots"] == [{"id": "s1", "prompt": "a"}]
    # A new id never takes one a later shot already has (its port and wires stay its own).
    later = convert({**BASE, "shots": [{"id": "s1"}, {"id": "s1"}, {"id": "s2"}, {"prompt": "x"}]})["shots"]
    assert [shot["id"] for shot in later][:3] == ["s1", later[1]["id"], "s2"]
    assert later[1]["id"] not in {"s1", "s2"} and later[3]["id"] not in {"s1", "s2", later[1]["id"]}
    # base.params that isn't an object, a model that isn't text, an output that isn't one.
    odd = convert({**BASE, "base": {"model": 7, "params": ["x"]}, "shots": [
        {"id": "s1", "prompt": "a", "output": "done", "variations": "x", "selectedVariation": "0"}]})
    assert odd["base"] == {"model": "seedream-4-5"}
    assert odd["shots"][0] == {"id": "s1", "prompt": "a"}


def test_a_valid_scene_is_left_exactly_as_it_is():
    scene = {"version": 1, "base": {"model": "nano-banana", "params": {"guidance": 3}}, "aspectRatio": "2.39:1",
             "character": {"refImageUrls": ["/api/outputs/a.png"], "strength": 0.6}, "look": {"grain": 0.2},
             "shots": [{"id": "s1", "prompt": "a", "camera": "dolly",
                        "output": {"imageUrl": "/x.png", "status": "done", "hash": "h"},
                        "variations": [{"url": "/x.png", "seed": 1}], "selectedVariation": 0}]}
    for strict in (True, False):
        assert cinema_scene_spec.normalize_scene(scene, strict=strict) == scene
    assert cinema_scene_spec.normalize_scene({**scene, "version": 2}, strict=False)["version"] == 2


@pytest.mark.parametrize("name,named", [
    ("base as a string", "scene.base must be an object"),
    ("prompt a number", "scene.shots[0].prompt must be text"),
    ("version a string", "scene.version must be a whole number"),
    ("aspect a number", "scene.aspectRatio must be text"),
    ("duplicate shot ids", "used twice"),
    ("shot without an id", "scene.shots[0].id"),
    ("shot null", "scene.shots[0] must be an object"),
    ("shots a string", "scene.shots must be a list"),
    ("scene a string", "scene must be an object"),
])
def test_an_agents_create_is_still_refused_with_the_field_named(api, name, named):  # noqa: F811
    client, graph, _sent = api
    before = len(graph.nodes)
    response = client.post("/api/graph/node", headers=AGENT,
                           json={"definitionId": "cinema-scene", "params": {"scene": SHAPES[name]}})
    assert response.status_code == 400, response.text
    assert named in response.json()["detail"]
    assert len(graph.nodes) == before


def test_an_agents_scene_sent_as_json_text_is_read_as_the_object(api):  # noqa: F811
    """The CLI sends every --param as text (`nebula add cinema-scene --param scene='{…}'`)."""
    client, graph, _sent = api
    response = client.post("/api/graph/node", headers=AGENT, json={"definitionId": "cinema-scene", "params": {
        "scene": json.dumps({"shots": [{"id": "s1", "prompt": "x"}]})}})
    assert response.status_code == 200, response.text
    node = next(node for node in graph.nodes.values() if node["definitionId"] == "cinema-scene")
    assert node["params"]["scene"]["shots"] == [{"id": "s1", "prompt": "x"}]
    assert node["params"]["scene"]["base"] == {"model": "seedream-4-5"}


@pytest.mark.parametrize("name", ["base as a string", "prompt a number", "duplicate shot ids"])
def test_edit_canvas_and_an_agents_put_stay_strict(api, name):  # noqa: F811
    client, graph, _sent = api
    response = client.post("/api/graph/apply", headers=AGENT, json={"nodes": [
        {"ref": "+c", "definitionId": "cinema-scene", "params": {"scene": SHAPES[name]}}]})
    assert response.status_code == 400, response.text
    node = graph.add_node("cinema-scene", {"scene": {"shots": [{"id": "s1", "prompt": "a"}]}})
    response = client.put(f"/api/graph/node/{node}", headers=AGENT, json={"params": {"scene": SHAPES[name]}})
    assert response.status_code == 400, response.text


# -- H1: every person-side and saved-data path is lenient ----------------------------


def _scene_node(scene):
    return {"id": "n1", "type": "cinemaSceneNode", "position": {"x": 0, "y": 0},
            "data": {"definitionId": "cinema-scene", "label": "Opening", "params": {"scene": scene}, "outputs": {}}}


def _snapshot(scene):
    return {"nodes": [_scene_node(scene)], "edges": [], "runHistory": [], "viewport": None, "createSessionId": None}


@pytest.mark.parametrize("name", list(SHAPES))
def test_a_project_holding_a_malformed_scene_opens_and_autosaves(workspace, name):  # noqa: F811
    client, graph, store, _ = workspace
    a = client.post("/api/projects", json={"name": "A"}).json()
    b = client.post("/api/projects", json={"name": "B", "workspaceRevision": a["workspaceRevision"]}).json()
    with store.transaction() as catalog:
        catalog["projects"][a["project"]["id"]]["snapshot"] = _snapshot(SHAPES[name])
        store.commit(catalog)
    opened = client.post(f"/api/projects/{a['project']['id']}/open", json={"workspaceRevision": b["workspaceRevision"]})
    assert opened.status_code == 200, opened.text
    _check_scene(graph.nodes["n1"]["params"]["scene"])
    rev = opened.json()["workspaceRevision"]
    # The canvas autosaves what it holds, the malformed scene included, by the person and by an agent's tab.
    for headers in (PERSON, AGENT):
        saved = client.put(f"/api/projects/{a['project']['id']}", headers=headers,
                           json={"snapshot": _snapshot(SHAPES[name]), "workspaceRevision": rev})
        assert saved.status_code == 200, saved.text
    with store.transaction() as catalog:
        stored = catalog["projects"][a["project"]["id"]]["snapshot"]
    if stored["nodes"]:
        _check_scene(stored["nodes"][0]["data"]["params"]["scene"])


@pytest.mark.parametrize("name", ["base as a string", "prompt a number", "duplicate shot ids", "shot null"])
def test_a_live_canvas_holding_a_malformed_scene_autosaves(workspace, name):  # noqa: F811
    client, graph, _store, _ = workspace
    a = client.post("/api/projects", json={"name": "A"}).json()
    graph.add_node("cinema-scene", {"scene": SHAPES[name]})
    saved = client.put(f"/api/projects/{a['project']['id']}", headers=PERSON,
                       json={"snapshot": _snapshot(SHAPES[name]), "workspaceRevision": a["workspaceRevision"]})
    assert saved.status_code == 200, saved.text


@pytest.mark.parametrize("name", ["base as a string", "prompt a number", "duplicate shot ids", "shot without an id"])
def test_a_recovered_copy_of_a_malformed_scene_is_saved(workspace, name):  # noqa: F811
    from uuid import uuid4
    client, _graph, _store, _ = workspace
    a = client.post("/api/projects", json={"name": "A"}).json()
    response = client.post("/api/projects/recover", headers=PERSON, json={
        "sourceProjectId": a["project"]["id"], "recoveryId": uuid4().hex, "snapshot": _snapshot(SHAPES[name])})
    assert response.status_code == 200, response.text


@pytest.mark.parametrize("name", list(SHAPES))
def test_the_shared_project_stager_never_refuses_a_scene(name):
    """Open, every save, the handoff save and recover all stage through _stage_project_snapshot."""
    staged, candidate = main_module._stage_project_snapshot(_snapshot(SHAPES[name]))
    _check_scene(staged["nodes"][0]["data"]["params"]["scene"])
    _check_scene(candidate.nodes["n1"]["params"]["scene"])


@pytest.mark.parametrize("name", list(SHAPES))
def test_a_saved_graph_file_and_state_json_load(tmp_path, name):
    path = tmp_path / "state.json"
    path.write_text(json.dumps({"nodes": [{"id": "n1", "definitionId": "cinema-scene", "params": {"scene": SHAPES[name]}}],
                                "edges": [], "counter": 1}))
    graph = CLIGraph()
    graph.load(path)
    _check_scene(graph.nodes["n1"]["params"]["scene"])
    main_module._validate_restore_graph({"version": 3, "name": "Saved", "createdAt": "2026-10-27T00:00:00Z",
                                         "nodes": [_scene_node(SHAPES[name])], "edges": []})


@pytest.mark.parametrize("headers", [PERSON, AGENT], ids=["person", "agent"])
@pytest.mark.parametrize("name", list(SHAPES))
def test_import_of_a_malformed_scene_converts_it(api, name, headers):  # noqa: F811
    client, graph, _sent = api
    response = client.post("/api/graph/import", headers=headers, json={"nodes": [
        {"id": "a", "definitionId": "cinema-scene", "params": {"scene": SHAPES[name]}}], "edges": []})
    assert response.status_code == 200, response.text
    scene = next(node for node in graph.nodes.values() if node["definitionId"] == "cinema-scene")["params"]["scene"]
    _check_scene(scene)


@pytest.mark.parametrize("name", list(SHAPES))
def test_the_persons_studio_put_of_a_malformed_scene_keeps_their_typing(api, person, name):  # noqa: F811
    client, graph, _sent = api
    node = graph.add_node("cinema-scene", {"scene": SHAPES[name]})  # as a load leaves it
    sent = json.loads(json.dumps(SHAPES[name]))
    typed = isinstance(sent, dict) and isinstance(sent.get("shots"), list) and isinstance(sent["shots"][-1], dict)
    if typed:
        sent["shots"][-1]["prompt"] = "typed by the person"
    response = client.put(f"/api/graph/node/{node}", headers=PERSON, json={"params": {"scene": sent}})
    assert response.status_code == 200, response.text
    scene = graph.nodes[node]["params"]["scene"]
    _check_scene(scene)
    if typed:
        assert scene["shots"][-1]["prompt"] == "typed by the person"


@pytest.mark.parametrize("name", list(SHAPES))
def test_the_persons_create_of_a_malformed_scene_converts_it(api, person, name):  # noqa: F811
    client, graph, _sent = api
    response = client.post("/api/graph/node", headers=PERSON,
                           json={"definitionId": "cinema-scene", "params": {"scene": SHAPES[name]}})
    assert response.status_code == 200, response.text
    _check_scene(next(node for node in graph.nodes.values() if node["definitionId"] == "cinema-scene")["params"]["scene"])


@pytest.mark.parametrize("name", list(SHAPES))
def test_the_persons_undo_of_a_malformed_scene_converts_it(api, person, name):  # noqa: F811
    client, graph, _sent = api
    node = graph.add_node("cinema-scene", {"scene": {"shots": [{"id": "s1", "prompt": "a"}]}})
    response = client.post("/api/graph/restore", headers=PERSON, json={"action": "undo", "nodes": [
        {"id": node, "definitionId": "cinema-scene", "params": {"scene": SHAPES[name]}}],
        "remove": [], "wire": [], "unwire": []})
    assert response.status_code == 200, response.text
    _check_scene(graph.nodes[node]["params"]["scene"])
    # A node an undo brings back whole.
    graph.remove_node(node)
    response = client.post("/api/graph/restore", headers=PERSON, json={"action": "undo", "nodes": [
        {"id": node, "definitionId": "cinema-scene", "params": {"scene": SHAPES[name]}, "position": {"x": 0, "y": 0}}],
        "remove": [], "wire": [], "unwire": []})
    assert response.status_code == 200, response.text
    _check_scene(graph.nodes[node]["params"]["scene"])


# -- Renders a removal can't orphan (M1, L1, L2, G1, M2) ------------------------------


@pytest.fixture
def rendering(monkeypatch):
    """Runs this test says are active (the registry's own record needs a task)."""
    active: set[str] = set()
    monkeypatch.setattr(main_module, "_run_is_active", lambda run_id: run_id in active)
    main_module._cinema_renders.clear()
    main_module._cinema_admitting.clear()
    yield active
    main_module._cinema_renders.clear()
    main_module._cinema_admitting.clear()


class _Node:
    def __init__(self, node_id, definition_id):
        self.id = node_id
        self.definition_id = definition_id


def _scene(*ids):
    return {**BASE, "shots": [{"id": shot_id, "prompt": shot_id} for shot_id in ids]}


def test_a_run_rendering_two_scenes_protects_both(api, rendering):  # noqa: F811
    client, graph, _sent = api
    a = graph.add_node("cinema-scene", {"scene": _scene("a1", "a2")})
    b = graph.add_node("cinema-scene", {"scene": _scene("b1", "b2")})
    main_module._note_scene_renders("run-both", [_Node(a, "cinema-scene"), _Node(b, "cinema-scene")])
    rendering.add("run-both")
    for node, kept in ((a, "a1"), (b, "b1")):
        response = client.put(f"/api/graph/node/{node}", headers=AGENT, json={"params": {"scene": _scene(kept)}})
        assert response.status_code == 409, response.text
    assert [shot["id"] for shot in graph.nodes[a]["params"]["scene"]["shots"]] == ["a1", "a2"]


def test_a_shot_run_protects_only_its_shot(api, rendering):  # noqa: F811
    client, graph, _sent = api
    node = graph.add_node("cinema-scene", {"scene": _scene("s1", "s2", "s3")})
    main_module._note_scene_renders("shot-run", [_Node(node, "cinema-scene")], shot=(node, "s2"))
    rendering.add("shot-run")
    refused = client.put(f"/api/graph/node/{node}", headers=AGENT, json={"params": {"scene": _scene("s1", "s3")}})
    assert refused.status_code == 409, refused.text
    other = client.put(f"/api/graph/node/{node}", headers=AGENT, json={"params": {"scene": _scene("s1", "s2")}})
    assert other.status_code == 200, other.text


def test_a_scene_in_a_run_is_free_once_the_engine_is_done_with_it(api, rendering):  # noqa: F811
    """L2: a downstream video's long render doesn't hold the scene that fed it."""
    client, graph, _sent = api
    node = graph.add_node("cinema-scene", {"scene": _scene("s1", "s2", "s3")})
    main_module._note_scene_renders("video-run", [_Node(node, "cinema-scene")])
    rendering.add("video-run")
    assert client.put(f"/api/graph/node/{node}", headers=AGENT,
                      json={"params": {"scene": _scene("s1", "s2")}}).status_code == 409
    main_module._scene_render_done("video-run", node)
    response = client.put(f"/api/graph/node/{node}", headers=AGENT, json={"params": {"scene": _scene("s1", "s2")}})
    assert response.status_code == 200, response.text


def test_the_scenes_executed_event_frees_it(api, rendering):  # noqa: F811
    import asyncio
    from models.events import ExecutedEvent

    _client, graph, _sent = api
    node = graph.add_node("cinema-scene", {"scene": _scene("s1", "s2")})
    main_module._note_scene_renders("graph-run", [_Node(node, "cinema-scene")])
    rendering.add("graph-run")
    assert main_module._rendering_runs(node)
    asyncio.run(main_module._emit_and_sync(ExecutedEvent(node_id=node, outputs={}, run_id="graph-run")))
    assert main_module._rendering_runs(node) == []


def test_a_render_is_protected_while_its_run_is_admitted(api, rendering, monkeypatch):  # noqa: F811
    """L1: between noting the render and registering the run (validation, the
    spending check's measuring), removing the shot is refused; a run refused
    there frees it again."""
    client, graph, _sent = api
    node = graph.add_node("cinema-scene", {"scene": _scene("s1", "s2")})
    seen: dict[str, object] = {}

    async def spend_check(run_id, *args, **kwargs):
        try:
            main_module._refuse_removing_rendering_shots(
                node, graph.nodes[node], {"s1": {}, "s2": {}}, {"s1"})
            seen["inside"] = "allowed"
        except main_module.HTTPException as exc:
            seen["inside"] = exc.status_code
        raise main_module.HTTPException(status_code=402, detail="over the limit")

    monkeypatch.setattr(main_module, "validate_graph", lambda *a, **k: [])
    monkeypatch.setattr(main_module, "_require_run_spend_approval", spend_check)
    nodes, edges = graph.to_execute_format()
    response = client.post("/api/cinema/generate-shot", headers=PERSON, json={
        "nodeId": node, "shotId": "s2", "nodes": nodes, "edges": edges, "runId": "cinema-shot-admit"})
    assert response.status_code == 402, response.text
    assert seen["inside"] == 409
    assert main_module._rendering_runs(node) == []


def test_the_persons_undo_that_removes_a_rendering_shot_reads_gms_line(api, rendering, person):  # noqa: F811
    client, graph, _sent = api
    node = graph.add_node("cinema-scene", {"scene": _scene("s1", "s2")})
    graph.set_label(node, "Opening")
    main_module._note_cinema_render("7f3c9a10-run", node, "s2")
    rendering.add("7f3c9a10-run")
    for action, verb in (("undo", "undo"), ("redo", "redo")):
        response = client.post("/api/graph/restore", headers=PERSON, json={"action": action, "nodes": [
            {"id": node, "definitionId": "cinema-scene", "params": {"scene": _scene("s1")}}],
            "remove": [], "wire": [], "unwire": []})
        assert response.status_code == 409, response.text
        assert response.json()["detail"] == (
            f"Couldn't {verb}. It would remove “Shot 2”, which is still running. Stop the run first.")
    # An agent's restore keeps the specific detail, run id and all.
    response = client.post("/api/graph/restore", headers=AGENT, json={"action": "undo", "nodes": [
        {"id": node, "definitionId": "cinema-scene", "params": {"scene": _scene("s1")}}],
        "remove": [], "wire": [], "unwire": []})
    assert response.status_code == 409
    assert "7f3c9a10-run" in response.json()["detail"] and "cancel_run" in response.json()["detail"]


def test_a_rendering_shot_in_admission_says_wait(api, rendering, person):  # noqa: F811
    client, graph, _sent = api
    node = graph.add_node("cinema-scene", {"scene": _scene("s1", "s2")})
    with main_module._cinema_admission_scope():
        main_module._note_cinema_render("admitting-run", node, "s2")
        response = client.post("/api/graph/restore", headers=PERSON, json={"action": "undo", "nodes": [
            {"id": node, "definitionId": "cinema-scene", "params": {"scene": _scene("s1")}}],
            "remove": [], "wire": [], "unwire": []})
    assert response.status_code == 409, response.text
    assert response.json()["detail"].endswith("Wait for it to finish.")


# -- G1: a scene can't be deleted while a shot renders ------------------------------


def test_deleting_a_scene_while_its_shot_renders_is_refused(api, rendering, person):  # noqa: F811
    client, graph, sent = api
    node = graph.add_node("cinema-scene", {"scene": _scene("s1", "s2")})
    graph.set_label(node, "Scene")
    main_module._note_cinema_render("run-x", node, "s2")
    rendering.add("run-x")
    agent = client.delete(f"/api/graph/node/{node}", headers=AGENT)
    assert agent.status_code == 409, agent.text
    line = f"Couldn't delete “Scene”, node {node}. “Shot 2” is still running, run run-x."
    assert agent.json()["detail"] == line
    # GM: the Agent log says the same, under the agent's name.
    assert [event.get("say") for event in _presence_events(sent)].count(line) == 1
    sent.clear()
    person_reply = client.delete(f"/api/graph/node/{node}", headers=PERSON)
    assert person_reply.status_code == 409
    assert person_reply.json()["detail"] == (
        "Couldn't delete “Scene”. “Shot 2” is still running. Stop the run first.")
    assert _presence_events(sent) == []
    applied = client.post("/api/graph/apply", headers=AGENT, json={"remove": [node]})
    assert applied.status_code == 409, applied.text
    # The person's undo of the scene's add.
    undo = client.post("/api/graph/restore", headers=PERSON, json={"action": "undo", "nodes": [],
                                                                  "remove": [node], "wire": [], "unwire": []})
    assert undo.status_code == 409
    assert undo.json()["detail"] == (
        "Couldn't undo. It would remove “Shot 2”, which is still running. Stop the run first.")
    assert node in graph.nodes
    rendering.discard("run-x")
    assert client.delete(f"/api/graph/node/{node}", headers=AGENT).status_code == 200


@pytest.mark.parametrize("ids,line", [
    (("s1", "s2"), "“Shot 1” and “Shot 2” are still running"),
    (("s1", "s2", "s3"), "“Shot 1”, “Shot 2” and “Shot 3” are still running"),
    (("s1", "s2", "s3", "s4"), "4 shots are still running"),
])
def test_a_scene_rendering_several_shots_names_or_counts_them(api, rendering, person, ids, line):  # noqa: F811
    client, graph, _sent = api
    node = graph.add_node("cinema-scene", {"scene": _scene(*ids)})
    graph.set_label(node, "Scene")
    main_module._note_scene_renders("whole", [_Node(node, "cinema-scene")])
    rendering.add("whole")
    response = client.delete(f"/api/graph/node/{node}", headers=PERSON)
    assert response.status_code == 409
    assert response.json()["detail"] == f"Couldn't delete “Scene”. {line}. Stop the run first."


# -- L3: a shot that adopts a late image ---------------------------------------------


def _restore_shots(client, node, shots):
    return client.post("/api/graph/restore", headers=PERSON, json={"action": "undo", "nodes": [
        {"id": node, "definitionId": "cinema-scene", "params": {"scene": {**BASE, "shots": shots}}}],
        "remove": [], "wire": [], "unwire": []})


def test_a_returning_shot_adopting_a_late_variation_batch_gets_the_batch(api, person):  # noqa: F811
    import asyncio
    client, graph, _sent = api
    node = graph.add_node("cinema-scene", {"scene": _scene("s1")})
    batch = [{"url": "/api/outputs/new-v0.png", "seed": 11}, {"url": "/api/outputs/new-v1.png", "seed": 12}]
    asyncio.run(main_module._merge_shot_variations(node, "s2", batch))
    response = _restore_shots(client, node, [{"id": "s1", "prompt": "s1"}, {
        "id": "s2", "prompt": "b", "output": {"imageUrl": "/api/outputs/old-v1.png", "status": "done"},
        "variations": [{"url": "/api/outputs/old-v0.png", "seed": 1}, {"url": "/api/outputs/old-v1.png", "seed": 2}],
        "selectedVariation": 1}])
    assert response.status_code == 200, response.text
    s2 = next(shot for shot in graph.nodes[node]["params"]["scene"]["shots"] if shot["id"] == "s2")
    assert s2["output"] == {"imageUrl": "/api/outputs/new-v0.png", "status": "done"}
    assert s2["variations"] == batch and s2["selectedVariation"] == 0


def test_a_returning_shot_adopting_a_late_single_image_keeps_a_consistent_selection(api, person):  # noqa: F811
    client, graph, _sent = api
    node = graph.add_node("cinema-scene", {"scene": _scene("s1")})
    graph.nodes[node]["outputs"] = {"shot_s2": {"type": "Image", "value": "/api/outputs/new.png"}}
    response = _restore_shots(client, node, [{"id": "s1", "prompt": "s1"}, {
        "id": "s2", "prompt": "b", "output": {"imageUrl": "/api/outputs/old-v1.png", "status": "done"},
        "variations": [{"url": "/api/outputs/old-v0.png", "seed": 1}, {"url": "/api/outputs/old-v1.png", "seed": 2}],
        "selectedVariation": 1}])
    assert response.status_code == 200, response.text
    s2 = next(shot for shot in graph.nodes[node]["params"]["scene"]["shots"] if shot["id"] == "s2")
    assert s2["output"] == {"imageUrl": "/api/outputs/new.png", "status": "done"}
    # The old variations stay (paid images), and none of them is selected: the shown image isn't one.
    assert [variation["url"] for variation in s2["variations"]] == ["/api/outputs/old-v0.png", "/api/outputs/old-v1.png"]
    assert "selectedVariation" not in s2
    # A late image that is one of its variations selects it.
    graph.nodes[node]["params"]["scene"]["shots"] = [{"id": "s1", "prompt": "s1"}]
    graph.nodes[node]["outputs"] = {"shot_s2": {"type": "Image", "value": "/api/outputs/old-v0.png"}}
    _restore_shots(client, node, [{"id": "s1", "prompt": "s1"}, {
        "id": "s2", "prompt": "b", "output": {"imageUrl": "/api/outputs/old-v1.png", "status": "done"},
        "variations": [{"url": "/api/outputs/old-v0.png", "seed": 1}, {"url": "/api/outputs/old-v1.png", "seed": 2}],
        "selectedVariation": 1}])
    s2 = next(shot for shot in graph.nodes[node]["params"]["scene"]["shots"] if shot["id"] == "s2")
    assert s2["selectedVariation"] == 0 and s2["output"]["imageUrl"] == "/api/outputs/old-v0.png"


# -- L5: money edges ------------------------------------------------------------------


@pytest.mark.parametrize("amount", [5e-324, 1e-300, 1e-12, 1e-7, 2.2250738585072014e-308])
def test_a_float_denormal_or_a_tiny_amount_never_raises_or_sprawls(amount):
    for formatter in (money.usd_amount, money.usd_spent, spend_command._usd, agent_spend._usd):
        text = formatter(amount)
        assert len(text) <= 12, text
        assert text not in ("$0", "$0.00")


def test_an_amount_never_raises_and_never_lies_about_nothing():
    rng = random.Random(198_3)
    # Past 1e9 to the largest float (review 5, N4): above $10 trillion both
    # forms write the ceiling (">$10,000,000,000,000", 20 characters, and
    # ">$10,000,000,000,000.00", 23), never an OverflowError.
    samples = [10 ** rng.uniform(-330, 308.25) for _ in range(20_000)] + [
        rng.uniform(-1, 1) for _ in range(2_000)] + [math.nan, math.inf, -math.inf, 0.0, -0.0, True, None, "3"] + [
        sys.float_info.max, math.nextafter(sys.float_info.max, 0.0), 1e308, 1e13, math.nextafter(1e13, math.inf)]
    for value in samples:
        amount = money.usd_amount(value)
        spent = money.usd_spent(value)
        assert len(amount) <= 20 and len(spent) <= 23, (value, amount, spent)
        positive = isinstance(value, float) and math.isfinite(value) and value > 0
        assert (amount == "$0") == (not positive), (value, amount)
        assert (spent == "$0.00") == (not positive), (value, spent)
