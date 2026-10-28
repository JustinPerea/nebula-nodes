"""PR #198 fix round 5 (review 5, backend lane).

- Item 1 (GM question 3): a scene write refused for removing a rendering shot
  (``PUT /api/graph/node/{id}``, and the canvas's undo/redo restore) carries
  ``code: "rendering_shots"`` and ``rendering: {shotIds, shots, stoppable}``,
  the same shape as the scene DELETE's, so the canvas can put back only those
  shots and send the rest of the save again.
- Item 2: the other whole-save refusals of that PUT carry a ``code``:
  ``paid_start``, ``approved_run``, ``workspace_moved`` (with ``project`` and
  ``switchedBy``); ``params_outdated`` already had one.
- M2: the money fuzz parity reads its amounts from the shared file (CI is
  Linux); a last-ulp log10 error never changes what money.py writes.
- N4: money has a ceiling ($10 trillion) and never raises up to float max.
- L3: a stray ``shot_<id>`` port a renumbered shot owned is re-keyed to that
  shot with its wires; every port or wire that is still dropped is reported
  (warnings, journal, Agent log); a restore keeps a removed shot's late image.
"""
from __future__ import annotations

import contextlib
import json
import math
import sys
from pathlib import Path
from types import SimpleNamespace

import pytest

import main as main_module
from services import money
from services.cli_graph import CLIGraph
from services.provider_start_guard import ProviderStartConflictError
from tests.conftest import PERSON
from tests.test_agent_presence import api  # noqa: F401 - fixture
from tests.test_params_version_gate import workspace  # noqa: F401 - fixture

AGENT = {"X-Nebula-Agent": "Codex"}
BASE = {"version": 1, "base": {"model": "seedream-4-5"}, "aspectRatio": "16:9"}
PAID = "/api/outputs/paid-s2.png"
FIXTURES = Path(__file__).resolve().parents[2] / "contracts" / "fixtures" / "money"


def _scene(*ids):
    return {**BASE, "shots": [{"id": shot_id, "prompt": shot_id} for shot_id in ids]}


@pytest.fixture
def rendering(monkeypatch):
    active: set[str] = set()
    monkeypatch.setattr(main_module, "_run_is_active", lambda run_id: run_id in active)
    main_module._cinema_renders.clear()
    main_module._cinema_admitting.clear()
    yield active
    main_module._cinema_renders.clear()
    main_module._cinema_admitting.clear()


# -- Item 1: the rendering-shot refusal of a scene write is pinned to its shots ---------


def test_the_persons_scene_put_names_the_rendering_shots_by_id(api, rendering, person):  # noqa: F811
    client, graph, _sent = api
    node = graph.add_node("cinema-scene", {"scene": _scene("s1", "s2", "s3")})
    main_module._note_cinema_render("run-r", node, "s2")
    rendering.add("run-r")
    reply = client.put(f"/api/graph/node/{node}", headers=PERSON, json={"params": {"scene": _scene("s1", "s3")}})
    assert reply.status_code == 409
    body = reply.json()
    assert body["detail"] == "Couldn't remove “Shot 2”. It's still running. Stop the run first."
    assert body["code"] == "rendering_shots"
    assert body["rendering"] == {"shotIds": ["s2"], "shots": [2], "stoppable": True}


def test_an_agents_scene_put_carries_the_same_shape(api, rendering):  # noqa: F811
    client, graph, _sent = api
    node = graph.add_node("cinema-scene", {"scene": _scene("s1", "s2", "s3")})
    main_module._note_cinema_render("run-r", node, None)  # the whole scene
    rendering.add("run-r")
    reply = client.put(f"/api/graph/node/{node}", headers=AGENT, json={"params": {"scene": _scene("s1")}})
    assert reply.status_code == 409
    body = reply.json()
    assert body["detail"].startswith("Shot 2 (s2) of ")
    assert body["code"] == "rendering_shots"
    assert body["rendering"] == {"shotIds": ["s2", "s3"], "shots": [2, 3], "stoppable": True}


def test_a_scene_put_while_admitting_is_not_stoppable(api, rendering, person):  # noqa: F811
    client, graph, _sent = api
    node = graph.add_node("cinema-scene", {"scene": _scene("s1", "s2")})
    with main_module._cinema_admission_scope():
        main_module._note_cinema_render("admitting", node, "s1")
        reply = client.put(f"/api/graph/node/{node}", headers=PERSON, json={"params": {"scene": _scene("s2")}})
    assert reply.status_code == 409
    assert reply.json()["rendering"] == {"shotIds": ["s1"], "shots": [1], "stoppable": False}
    assert reply.json()["detail"].endswith("Wait for it to finish.")


@pytest.mark.parametrize("action", ["undo", "redo"])
def test_the_persons_undo_or_redo_carries_the_shots_too(api, rendering, person, action):  # noqa: F811
    client, graph, _sent = api
    node = graph.add_node("cinema-scene", {"scene": _scene("s1", "s2")})
    main_module._note_cinema_render("run-r", node, "s2")
    rendering.add("run-r")
    reply = client.post("/api/graph/restore", headers=PERSON, json={"action": action, "nodes": [
        {"id": node, "definitionId": "cinema-scene", "params": {"scene": _scene("s1")}}],
        "remove": [], "wire": [], "unwire": []})
    assert reply.status_code == 409
    body = reply.json()
    assert body["detail"] == f"Couldn't {action}. It would remove “Shot 2”, which is still running. Stop the run first."
    assert body["code"] == "rendering_shots"
    assert body["rendering"] == {"shotIds": ["s2"], "shots": [2], "stoppable": True}


def test_the_scene_delete_has_the_same_shape(api, rendering, person):  # noqa: F811
    client, graph, _sent = api
    node = graph.add_node("cinema-scene", {"scene": _scene("s1", "s2", "s3")})
    main_module._note_cinema_render("run-r", node, "s3")
    rendering.add("run-r")
    for headers in (PERSON, AGENT):
        reply = client.delete(f"/api/graph/node/{node}", headers=headers)
        assert reply.status_code == 409
        assert reply.json()["code"] == "rendering_shots"
        assert reply.json()["rendering"] == {"shotIds": ["s3"], "shots": [3], "stoppable": True}


# -- Item 2: the other whole-save refusals carry a code ---------------------------------


def test_a_paid_start_refusal_has_its_code(api, person, monkeypatch):  # noqa: F811
    client, graph, _sent = api
    node = graph.add_node("text-input", {"value": "a"})

    @contextlib.contextmanager
    def busy():
        raise ProviderStartConflictError("a start is settling")
        yield  # pragma: no cover

    monkeypatch.setattr(main_module.provider_start_guard, "exclusive_lifecycle", busy)
    for headers in (PERSON, AGENT):
        reply = client.put(f"/api/graph/node/{node}", headers=headers, json={"params": {"value": "b"}})
        assert reply.status_code == 409, reply.text
        assert reply.json()["code"] == "paid_start"
    assert client.put(f"/api/graph/node/{node}", headers=PERSON,
                      json={"params": {"value": "b"}}).json()["detail"] == main_module.WORLD_LABS_STARTING_PERSON


def test_an_approved_run_refusal_has_its_code(api, monkeypatch):  # noqa: F811
    client, graph, _sent = api
    node = graph.add_node("text-input", {"value": "a"})
    approval = SimpleNamespace(run_node_ids=[node], fingerprint={}, agent_name="Claude", proposal_id="pr_1")
    monkeypatch.setattr(main_module.run_approvals, "open_list", lambda: [approval])
    monkeypatch.setattr(main_module.approvals, "changed_nodes", lambda before, now: [node])
    reply = client.put(f"/api/graph/node/{node}", headers=AGENT, json={"params": {"value": "b"}})
    assert reply.status_code == 409, reply.text
    assert reply.json()["code"] == "approved_run"
    assert "in a run the person approved" in reply.json()["detail"]


def _stale_put(client, revision):
    return client.put("/api/graph/node/n1", headers={**PERSON, "X-Nebula-Workspace-Revision": revision},
                      json={"params": {"value": "b"}})


def test_a_stale_tab_learns_which_project_is_open_and_who_opened_it(workspace, person):  # noqa: F811
    client, _graph, _store, _ = workspace
    a = client.post("/api/projects", headers=PERSON, json={"name": "A"}).json()
    b = client.post("/api/projects", headers=AGENT, json={"name": "B", "workspaceRevision": a["workspaceRevision"]})
    assert b.status_code == 200, b.text
    b = b.json()
    reply = _stale_put(client, a["workspaceRevision"])
    assert reply.status_code == 409
    assert reply.json() == {"detail": main_module.CANVAS_OUT_OF_DATE, "code": "workspace_moved",
                            "project": {"id": b["project"]["id"], "name": "B"},
                            "switchedBy": {"kind": "agent", "name": "Codex"}}
    opened = client.post(f"/api/projects/{a['project']['id']}/open", headers=PERSON,
                         json={"workspaceRevision": b["workspaceRevision"]})
    assert opened.status_code == 200, opened.text
    reply = _stale_put(client, b["workspaceRevision"])
    assert reply.json()["project"] == {"id": a["project"]["id"], "name": "A"}
    assert reply.json()["switchedBy"] == {"kind": "person", "name": "You"}


def test_who_switched_is_null_when_nebula_does_not_know(workspace, person, monkeypatch):  # noqa: F811
    client, _graph, _store, _ = workspace
    a = client.post("/api/projects", headers=PERSON, json={"name": "A"}).json()
    client.post("/api/projects", headers=PERSON, json={"name": "B", "workspaceRevision": a["workspaceRevision"]})
    monkeypatch.setattr(main_module, "_last_canvas_change", {})  # a backend restarted since
    reply = _stale_put(client, a["workspaceRevision"])
    assert reply.json()["code"] == "workspace_moved"
    assert reply.json()["switchedBy"] is None


def test_the_moved_and_restarted_refusals_have_the_code(workspace, person):  # noqa: F811
    client, graph, _store, _ = workspace
    a = client.post("/api/projects", headers=PERSON, json={"name": "A"}).json()
    fence = main_module._graph_fence()
    with pytest.raises(main_module.HTTPException) as moved:
        main_module._refuse_if_graph_moved(("another-revision", None, 0))
    assert moved.value.detail == main_module.GRAPH_MOVED_DETAIL
    assert moved.value.fields["code"] == "workspace_moved"
    assert moved.value.fields["project"] == {"id": a["project"]["id"], "name": "A"}
    graph.add_node("text-input", {"value": "a"})
    cleared = client.delete("/api/graph?force=true", headers=AGENT)
    assert cleared.status_code == 200, cleared.text
    with pytest.raises(main_module.HTTPException) as restarted:
        main_module._refuse_if_graph_moved(fence)
    assert restarted.value.detail == main_module.GRAPH_RESTARTED_DETAIL
    assert restarted.value.fields["code"] == "workspace_moved"
    assert restarted.value.fields["switchedBy"] == {"kind": "agent", "name": "Codex"}


def test_the_unfiled_canvas_has_no_project(workspace, person):  # noqa: F811
    client, _graph, _store, _ = workspace
    with pytest.raises(main_module.HTTPException) as moved:
        main_module._refuse_if_graph_moved(("another-revision", None, 0))
    assert moved.value.fields["project"] is None


def test_params_outdated_keeps_its_code(api, person):  # noqa: F811
    client, graph, _sent = api
    node = graph.add_node("text-input", {"value": "a"})
    reply = client.put(f"/api/graph/node/{node}", headers={**PERSON, "X-Nebula-Params-Version": "0"},
                       json={"params": {"value": "b"}})
    assert reply.status_code == 409
    assert reply.json()["code"] == "params_outdated"


# -- M2: the fuzz reads its amounts; a last-ulp log10 never matters -------------------


def _fuzz_amounts():
    return [row["amount"] for row in json.loads((FIXTURES / "fuzz.json").read_text())["rows"]]


@pytest.mark.parametrize("direction", [-1, 1])
def test_a_last_ulp_log10_error_never_changes_the_text(monkeypatch, direction):
    amounts = _fuzz_amounts() + [10.0 ** -k for k in range(1, 7)] + [
        math.nextafter(10.0 ** -k, side) for k in range(1, 7) for side in (0.0, 1.0)]
    expected = [(money.usd_amount(value), money.usd_spent(value)) for value in amounts]
    real = math.log10
    monkeypatch.setattr(math, "log10", lambda value: math.nextafter(real(value), direction * math.inf))
    got = [(money.usd_amount(value), money.usd_spent(value)) for value in amounts]
    diffs = [(value, want, have) for value, want, have in zip(amounts, expected, got) if want != have]
    assert diffs[:10] == []


# -- N4: a ceiling, and never a raise --------------------------------------------------


@pytest.mark.parametrize("amount", [1e13 * (1 + 1e-12), 1e15, 1e306, sys.float_info.max])
def test_an_absurd_amount_writes_the_ceiling(amount):
    assert money.usd_amount(amount) == ">$10,000,000,000,000"
    assert money.usd_spent(amount) == ">$10,000,000,000,000.00"


def test_the_ceiling_itself_is_written_in_figures():
    assert money.CEILING_USD == 1e13
    assert money.usd_amount(1e13) == "$10,000,000,000,000"
    assert money.usd_spent(1e13) == "$10,000,000,000,000.00"


def test_the_shared_table_has_the_ceiling_rows():
    table = json.loads((FIXTURES / "cases.json").read_text())
    for key in ("spent", "amount"):
        amounts = {case["amount"] for case in table[key]}
        assert {1e13, 1e13 * (1 + 1e-12), 1e15, 1e306, sys.float_info.max} <= amounts, key


# -- L3: stray ports --------------------------------------------------------------------


def _import(client, headers, scene, outputs, handle):
    params = {} if scene is None else {"scene": ({**BASE, **scene} if isinstance(scene, dict) else scene)}
    body = {"nodes": [{"id": "a", "definitionId": "cinema-scene", "label": "Opening", "params": params,
                       "outputs": outputs},
                      {"id": "b", "definitionId": "cinema-scene", "params": {"scene": _scene("t1")}}],
            "edges": [{"id": "e1", "source": "a", "sourceHandle": handle, "target": "b",
                       "targetHandle": "character_refs"}]}
    return client.post("/api/graph/import", headers=headers, json=body)


LOST_ID = {"shots": [{"id": "s1", "prompt": "a"}, {"prompt": "lost id", "output": {"status": "done", "imageUrl": PAID}}]}


@pytest.mark.parametrize("who", ["person", "agent"])
def test_a_renumbered_shot_keeps_its_port_and_wires(api, person, who):  # noqa: F811
    client, graph, _sent = api
    reply = _import(client, {"person": PERSON, "agent": AGENT}[who], LOST_ID,
                    {"shot_s2": {"type": "Image", "value": PAID}}, "shot_s2")
    assert reply.status_code == 200, reply.text
    node = graph.nodes[reply.json()["idMap"]["a"]]
    shots = node["params"]["scene"]["shots"]
    assert [(shot["id"], (shot.get("output") or {}).get("imageUrl")) for shot in shots] == [("s1", None), ("s3", PAID)]
    assert sorted(node["outputs"]) == ["shot_s3"]
    assert node["outputs"]["shot_s3"]["value"] == PAID
    assert [(edge["sourceHandle"], edge["targetHandle"]) for edge in graph.edges] == [("shot_s3", "character_refs")]
    assert reply.json()["edgeCount"] == 1
    assert reply.json()["warnings"] == []


def _dropped_line(connections, node_id="n1", loading=False):
    # GM's line (pr198 r8; test_pr198_fix6 has the forms).
    return main_module.stray_shot_line("Opening", node_id, ["shot_s2"], connections, loading=loading)


@pytest.mark.parametrize("who", ["person", "agent"])
def test_a_port_no_shot_can_claim_is_dropped_and_said(api, person, who):  # noqa: F811
    client, graph, sent = api
    sent.clear()
    start = main_module.canvas_events.read(after=None)["cursor"]
    reply = _import(client, {"person": PERSON, "agent": AGENT}[who], {"shots": [{"id": "S2", "prompt": "a"}]},
                    {"shot_s2": {"type": "Image", "value": PAID}}, "shot_s2")
    assert reply.status_code == 200, reply.text
    assert graph.edges == []
    assert reply.json()["warnings"] == [_dropped_line(1, reply.json()["idMap"]["a"])]
    replaced = [event for event in main_module.canvas_events.read(after=start, limit=100)["events"]
                if event["kind"] == "canvas.replaced"][-1]
    assert replaced["data"]["droppedPorts"] == [
        {"nodeId": reply.json()["idMap"]["a"], "handle": "shot_s2", "port": True, "connections": 1}]
    said = [event.get("say") for event in sent if event.get("type") == "agentPresence"]
    if who == "agent":
        assert _dropped_line(1, reply.json()["idMap"]["a"]) in said
    else:
        assert _dropped_line(1, reply.json()["idMap"]["a"]) not in said


def test_a_wire_from_a_port_that_isnt_there_is_said_too(api, person):  # noqa: F811
    client, graph, _sent = api
    reply = _import(client, PERSON, {"shots": [{"id": "s1", "prompt": "a"}]}, {}, "shot_s9")
    assert reply.status_code == 200, reply.text
    assert graph.edges == []
    assert reply.json()["warnings"] == [main_module.stray_shot_line("Opening", reply.json()["idMap"]["a"], ["shot_s9"], 1)]


def test_an_unreadable_scene_reports_every_port_it_drops(api, person):  # noqa: F811
    client, _graph, _sent = api
    reply = _import(client, PERSON, "not json", {"shot_s1": {"type": "Image", "value": PAID}}, "shot_s1")
    assert reply.status_code == 200, reply.text
    assert reply.json()["warnings"] == [main_module.stray_shot_line("Opening", reply.json()["idMap"]["a"], ["shot_s1"], 1)]


def _saved_project(workspace, nodes, edges):  # noqa: F811
    client, _graph, store, _ = workspace
    a = client.post("/api/projects", headers=PERSON, json={"name": "A"}).json()
    b = client.post("/api/projects", headers=PERSON, json={"name": "B", "workspaceRevision": a["workspaceRevision"]}).json()
    with store.transaction() as catalog:
        catalog["projects"][a["project"]["id"]]["snapshot"] = {
            "nodes": nodes, "edges": edges, "runHistory": [], "viewport": None, "createSessionId": None}
        store.commit(catalog)
    return client.post(f"/api/projects/{a['project']['id']}/open", headers=PERSON,
                       json={"workspaceRevision": b["workspaceRevision"]})


def _rf_scene(node_id, label, scene, outputs):
    return {"id": node_id, "type": "cinemaSceneNode", "position": {"x": 0, "y": 0},
            "data": {"definitionId": "cinema-scene", "label": label, "params": {"scene": scene}, "outputs": outputs}}


WIRE = {"id": "e1", "source": "n1", "sourceHandle": "shot_s2", "target": "n2", "targetHandle": "character_refs"}


def test_a_project_open_re_keys_a_renumbered_shots_port(workspace, person):  # noqa: F811
    _client, graph, _store, _ = workspace
    opened = _saved_project(workspace, [
        _rf_scene("n1", "Opening", {**BASE, **LOST_ID}, {"shot_s2": {"type": "Image", "value": PAID}}),
        _rf_scene("n2", "Next", _scene("t1"), {})], [WIRE])
    assert opened.status_code == 200, opened.text
    assert sorted(graph.nodes["n1"]["outputs"]) == ["shot_s3"]
    assert [(edge["source"], edge["sourceHandle"]) for edge in graph.edges] == [("n1", "shot_s3")]
    assert opened.json()["warnings"] == []


def test_a_project_open_says_what_it_dropped(workspace, person):  # noqa: F811
    _client, graph, _store, _ = workspace
    opened = _saved_project(workspace, [
        _rf_scene("n1", "Opening", _scene("s1"), {"shot_s2": {"type": "Image", "value": PAID}}),
        _rf_scene("n2", "Next", _scene("t1"), {})], [WIRE])
    assert opened.status_code == 200, opened.text
    assert graph.edges == []
    assert opened.json()["warnings"] == [_dropped_line(1, loading=True)]


def test_a_saved_graph_load_re_keys_a_renumbered_shots_port(tmp_path):
    path = tmp_path / "state.json"
    path.write_text(json.dumps({"nodes": [
        {"id": "n1", "definitionId": "cinema-scene", "params": {"scene": {**BASE, **LOST_ID}},
         "outputs": {"shot_s2": {"type": "Image", "value": PAID}}},
        {"id": "n2", "definitionId": "cinema-scene", "params": {"scene": _scene("t1")}, "outputs": {}}],
        "edges": [{**WIRE}], "counter": 2}))
    loaded = CLIGraph()
    loaded.load(path)
    assert [shot["id"] for shot in loaded.nodes["n1"]["params"]["scene"]["shots"]] == ["s1", "s3"]
    assert sorted(loaded.nodes["n1"]["outputs"]) == ["shot_s3"]
    assert [edge["sourceHandle"] for edge in loaded.edges] == ["shot_s3"]


def test_an_undo_of_a_scene_delete_keeps_a_removed_shots_late_image(api, person):  # noqa: F811
    """The shape _adopt_late_image exists for: the scene comes back with its
    leftover port, so a further undo that brings the shot back takes it."""
    client, graph, _sent = api
    late = "/api/outputs/late-s2.png"
    back = client.post("/api/graph/restore", headers=PERSON, json={"action": "undo", "nodes": [
        {"id": "n1", "definitionId": "cinema-scene", "params": {"scene": _scene("s1")},
         "outputs": {"shot_s2": {"type": "Image", "value": late}}}], "remove": [], "wire": [], "unwire": []})
    assert back.status_code == 200, back.text
    assert graph.nodes["n1"]["outputs"]["shot_s2"]["value"] == late
    shot = {"id": "s2", "prompt": "s2", "output": {"status": "done", "imageUrl": "/api/outputs/old-s2.png"}}
    again = client.post("/api/graph/restore", headers=PERSON, json={"action": "undo", "nodes": [
        {"id": "n1", "definitionId": "cinema-scene", "params": {"scene": {**_scene("s1"), "shots": [
            {"id": "s1", "prompt": "s1"}, shot]}}}], "remove": [], "wire": [], "unwire": []})
    assert again.status_code == 200, again.text
    s2 = graph.nodes["n1"]["params"]["scene"]["shots"][1]
    assert s2["output"]["imageUrl"] == late


def test_nebula_project_open_prints_what_opening_dropped(capsys):
    from cli.commands import projects

    class Client:
        def list_projects(self):
            return {"activeProjectId": "p1", "projects": [{"id": "p1"}, {"id": "p2"}], "workspaceRevision": "r"}

        def open_project(self, project_id, revision):
            return {"project": {"name": "B"}, "warnings": [_dropped_line(1)]}

    projects.run_open(Client(), "p2")
    assert f"note: {_dropped_line(1)}" in capsys.readouterr().err
