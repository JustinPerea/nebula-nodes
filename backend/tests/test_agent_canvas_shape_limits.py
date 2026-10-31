"""Review 6 of PR #205 (lines-limits MEDIUM-1): an agent's write is refused
when it would leave the canvas past Save's own shape limits, measured as Save
measures them: depth from the file's root, values over the whole canvas.

Each write's body is checked on its own at the ingress (64 deep, 1,000,000
values), but the canvas's Save walks its whole file, where a param's value
sits 5 deep. A canvas Nebula accepts is one the person's Save accepts.
"""
from __future__ import annotations

import pytest
from fastapi.testclient import TestClient

from services.agent_presence import AgentPresence
from services.canvas_arrange import ArrangeBook
from services.canvas_events import CanvasEventJournal
from services.canvas_pins import CanvasPins
from services.canvas_proposals import ProposalBook
from services.cli_graph import CLIGraph
from services.project_store import ProjectStore, make_project
from services.provider_recovery import ProviderRecoveryStore
from services.provider_start_guard import ProviderStartGuard

AGENT = {"X-Nebula-Agent": "Claude Desktop"}
DEEP_MSG = ("This edit would leave the canvas nested more than 64 levels deep from its file's root, "
            "and the person's canvas can't save it. Nothing changed. Nest the value less deeply.")
MANY_MSG = ("This edit would leave the canvas holding more than 1,000,000 values, and the person's canvas "
            "can't save it. Nothing changed. Make the edit smaller, or remove what the canvas no longer needs "
            "(ask the person first).")


@pytest.fixture
def api(tmp_path, monkeypatch, person):
    """The real app on a throwaway graph and project store (as test_graph_apply.py builds it)."""
    import main as main_module

    graph = CLIGraph(persist_path=tmp_path / "state.json")
    store = ProjectStore(tmp_path / "projects")
    with store.transaction() as catalog:
        project = make_project("Active")
        catalog["projects"][project["id"]] = project
        catalog["activeProjectId"] = project["id"]
        store.commit(catalog)
    sent: list[dict] = []

    async def capture(data, **kw):
        sent.append(data)

    monkeypatch.setattr(main_module, "cli_graph", graph)
    monkeypatch.setattr(main_module, "project_store", store)
    monkeypatch.setattr(main_module, "canvas_pins", CanvasPins(lambda: main_module.project_store))
    monkeypatch.setattr(main_module, "canvas_proposals", ProposalBook())
    monkeypatch.setattr(main_module, "canvas_arrange", ArrangeBook())
    monkeypatch.setattr(main_module, "agent_presence", AgentPresence())
    monkeypatch.setattr(main_module, "canvas_events", CanvasEventJournal())
    monkeypatch.setattr(main_module, "provider_recovery_store", ProviderRecoveryStore(None))
    monkeypatch.setattr(main_module, "provider_start_guard", ProviderStartGuard(tmp_path / "paid-starts.json"))
    monkeypatch.setattr(main_module, "_graph_recovery_bootstrap_error", None)
    monkeypatch.setattr(main_module.manager, "broadcast_raw", capture)
    monkeypatch.setattr(main_module.manager, "broadcast_browser", capture)

    class Api:
        pass

    ctx = Api()
    ctx.main = main_module
    ctx.app = main_module.app
    ctx.client = TestClient(main_module.app)
    ctx.graph = graph
    return ctx


def _deep(levels: int) -> object:
    """A value ``levels`` deep below its own root (a leaf at depth ``levels``)."""
    nested: object = "leaf"
    for _ in range(levels):
        nested = {"next": nested}
    return nested


def _file_depth(api) -> tuple[int, int]:
    main = api.main
    return main._graph_shape_measure(main._canvas_save_file_view(main._graph_canvas_export(api.graph)))


def _canvas_file(api) -> dict:
    """The canvas's Save file as the frontend builds it (serializeGraph)."""
    export = api.main._graph_canvas_export(api.graph)
    return {"version": 3, "paramsVersion": 3, "name": "Active", "createdAt": "2026-10-31T00:00:00.000Z",
            "nodes": [{"id": node["id"], "type": node.get("type"), "position": {"x": 1, "y": 2},
                       "data": {"label": node["data"].get("label"), "definitionId": node["data"]["definitionId"],
                                "params": node["data"].get("params", {}), "state": "idle"}}
                      for node in export["nodes"]],
            "edges": export["edges"], "viewport": {"x": 0, "y": 0, "zoom": 1}}


def _save_depth(file: object) -> int:
    """Depth as the frontend's Save walk counts it (root 0)."""
    deepest = 0
    stack = [(file, 0)]
    while stack:
        value, depth = stack.pop()
        deepest = max(deepest, depth)
        if isinstance(value, dict):
            stack.extend((item, depth + 1) for item in value.values())
        elif isinstance(value, list):
            stack.extend((item, depth + 1) for item in value)
    return deepest


def test_a_param_value_sits_at_save_depth_five(api):
    node_id = api.graph.add_node("text-input", {"value": "x"})
    assert node_id
    depth, _count = _file_depth(api)
    assert depth == _save_depth(_canvas_file(api)) == 5


@pytest.mark.parametrize("levels, accepted", [(59, True), (60, False)])
def test_an_agents_param_write_at_and_past_saves_depth(api, levels, accepted):
    """A param value 59 below the param sits at 64 in the file (5 + 59): the
    edge Save accepts. One more is past it: refused with the engine's reason,
    though the body alone (61 deep) is within the per-write limit."""
    node_id = api.graph.add_node("text-input", {"value": "x"})
    response = api.client.put(f"/api/graph/node/{node_id}", headers=AGENT, json={"params": {"value": _deep(levels)}})
    if accepted:
        assert response.status_code == 200, response.text
        assert _save_depth(_canvas_file(api)) == 64
        assert _file_depth(api)[0] == 64
    else:
        assert (response.status_code, response.json()["detail"]) == (400, DEEP_MSG)
        assert api.graph.nodes[node_id]["params"]["value"] == "x"


def test_the_review_case_62_below_a_param_is_refused(api):
    node_id = api.graph.add_node("text-input", {"value": "x"})
    response = api.client.put(f"/api/graph/node/{node_id}", headers=AGENT, json={"params": {"value": _deep(62)}})
    assert (response.status_code, response.json()["detail"]) == (400, DEEP_MSG)


def test_the_person_is_never_refused_for_the_canvas_shape(api, person):
    node_id = api.graph.add_node("text-input", {"value": "x"})
    response = api.client.put(f"/api/graph/node/{node_id}", headers=person.headers,
                              json={"params": {"value": _deep(62)}})
    assert response.status_code == 200, response.text


def test_values_over_the_whole_canvas_add_up_across_writes(api, monkeypatch):
    """Each write is small; the canvas they leave is counted whole, as Save counts it."""
    monkeypatch.setattr(api.main, "RESTORE_MAX_GRAPH_VALUES", 400)
    ids = [api.graph.add_node("text-input", {"value": "x"}) for _ in range(3)]
    _depth, base = _file_depth(api)
    room = 400 - base
    first = api.client.put(f"/api/graph/node/{ids[0]}", headers=AGENT, json={"params": {"value": list(range(room))}})
    assert first.status_code == 200, first.text
    # A list of room items in place of one value: room more, at the edge exactly.
    assert _file_depth(api)[1] == 400
    second = api.client.put(f"/api/graph/node/{ids[1]}", headers=AGENT, json={"params": {"value": [1, 2]}})
    assert second.status_code == 413, second.text
    assert second.json()["detail"] == MANY_MSG.replace("1,000,000", "400")
    assert api.graph.nodes[ids[1]]["params"]["value"] == "x"


def test_an_edit_that_leaves_an_over_limit_canvas_no_worse_goes_through(api, person):
    node_id = api.graph.add_node("text-input", {"value": "x"})
    other = api.graph.add_node("text-input", {"value": "y"})
    # The person's own deep value (theirs is never refused).
    assert api.client.put(f"/api/graph/node/{node_id}", headers=person.headers,
                          json={"params": {"value": _deep(62)}}).status_code == 200
    # An agent's edit elsewhere doesn't make it deeper: it goes through.
    response = api.client.put(f"/api/graph/node/{other}", headers=AGENT, json={"params": {"value": "z"}})
    assert response.status_code == 200, response.text
    # One that makes it shallower helps trim it.
    response = api.client.put(f"/api/graph/node/{node_id}", headers=AGENT, json={"params": {"value": _deep(10)}})
    assert response.status_code == 200, response.text


def test_an_agents_apply_is_measured_the_same_way(api):
    response = api.client.post("/api/graph/apply", headers=AGENT,
                               json={"nodes": [{"ref": "+a", "definitionId": "text-input", "params": {"value": _deep(60)}}]})
    assert (response.status_code, response.json()["detail"]) == (400, DEEP_MSG)


@pytest.mark.parametrize("levels, accepted", [(59, True), (60, False)])
def test_a_recovered_copy_is_measured_from_its_snapshots_root(api, person, levels, accepted):
    """The recover route measures the snapshot from its own root, as the
    project's save and the canvas's Save do: a canvas at Save's edge (a param
    value 59 below the param, 64 from the root) recovers, one more doesn't."""
    project_id = api.main.project_store.workspace()["activeProjectId"]
    snapshot = api.client.get(f"/api/projects/{project_id}", headers=person.headers).json()["snapshot"]
    snapshot["nodes"] = [{"id": "n1", "type": "model-node", "position": {"x": 0, "y": 0},
                          "data": {"label": "Deep", "definitionId": "text-input",
                                   "params": {"value": _deep(levels)}, "state": "idle"}}]
    response = api.client.post("/api/projects/recover", headers=person.headers,
                               json={"sourceProjectId": project_id, "snapshot": snapshot, "recoveryId": f"{levels:032x}"})
    if accepted:
        assert response.status_code == 200, response.text
    else:
        assert (response.status_code, response.json()["detail"]) == (400, "graph payload is nested too deeply")
