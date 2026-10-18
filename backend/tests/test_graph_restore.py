"""Undo on the canvas reaches the backend graph (POST /api/graph/restore),
and graphSyncs from edit requests say who made the edit.

The canvas keeps its own undo history. An agent's edit reaches open canvases
as a graphSync; the canvas makes it one undo step, named after the agent, and
Cmd-Z sends what changed to /api/graph/restore so the backend graph (and with
it agents and the saved project) matches the canvas again.
"""
from __future__ import annotations

import pytest
from fastapi.testclient import TestClient

from services.agent_presence import AgentPresence
from services.canvas_events import CanvasEventJournal
from services.canvas_pins import CanvasPins
from services.canvas_proposals import ProposalBook
from services.cli_graph import CLIGraph
from services.project_store import ProjectStore, make_project
from services.provider_recovery import ProviderRecoveryStore
from services.provider_start_guard import ProviderStartGuard
from tests.conftest import PERSON

AGENT = {"X-Nebula-Agent": "Claude"}
TAB = "tab-0123456789abcdef"
CANVAS = {**PERSON, "X-Nebula-Tab": TAB}


@pytest.fixture
def api(tmp_path, monkeypatch, person):
    import main as main_module

    graph = CLIGraph(persist_path=tmp_path / "state.json")
    store = ProjectStore(tmp_path / "projects")
    with store.transaction() as catalog:
        project = make_project("Active")
        catalog["projects"][project["id"]] = project
        catalog["activeProjectId"] = project["id"]
        store.commit(catalog)
    journal = CanvasEventJournal()
    sent: list[dict] = []

    async def capture(data):
        sent.append(data)

    monkeypatch.setattr(main_module, "cli_graph", graph)
    monkeypatch.setattr(main_module, "project_store", store)
    monkeypatch.setattr(main_module, "canvas_pins", CanvasPins(lambda: main_module.project_store))
    monkeypatch.setattr(main_module, "canvas_proposals", ProposalBook())
    monkeypatch.setattr(main_module, "agent_presence", AgentPresence())
    monkeypatch.setattr(main_module, "canvas_events", journal)
    monkeypatch.setattr(main_module, "provider_recovery_store", ProviderRecoveryStore(None))
    monkeypatch.setattr(main_module, "provider_start_guard", ProviderStartGuard(tmp_path / "paid-starts.json"))
    monkeypatch.setattr(main_module, "_graph_recovery_bootstrap_error", None)
    monkeypatch.setattr(main_module.manager, "broadcast_raw", capture)
    monkeypatch.setattr(main_module.manager, "broadcast_browser", capture)

    class Api:
        pass

    ctx = Api()
    ctx.client = TestClient(main_module.app)
    ctx.graph = graph
    ctx.journal = journal
    ctx.sent = sent
    return ctx


def _seed(api) -> tuple[str, str]:
    """n1 text-input wired into n2 nano-banana."""
    prompt = api.graph.add_node("text-input", {"value": "a lighthouse"}, position={"x": 0, "y": 0})
    image = api.graph.add_node("nano-banana", {}, position={"x": 400, "y": 0})
    api.graph.connect(prompt, "text", image, "prompt")
    return prompt, image


def _syncs(api) -> list[dict]:
    return [event for event in api.sent if event.get("type") == "graphSync"]


def _restore(api, body, headers=CANVAS):
    return api.client.post("/api/graph/restore", headers=headers, json=body)


def _wires(api) -> set[tuple[str, str, str, str]]:
    return {(e["source"], e["sourceHandle"], e["target"], e["targetHandle"]) for e in api.graph.edges}


# -- who made the edit ------------------------------------------------------

def test_an_agent_edit_names_the_agent_on_the_sync(api):
    _seed(api)
    response = api.client.post("/api/graph/apply", headers=AGENT, json={
        "nodes": [{"ref": "+up", "definitionId": "text-input", "params": {"value": "fog"}}],
    })
    assert response.status_code == 200, response.text
    edit = _syncs(api)[-1]["edit"]
    assert edit["actor"]["kind"] == "agent"
    assert edit["actor"]["name"] == "Claude"
    assert "tab" not in edit


def test_a_canvas_edit_carries_its_tab_so_that_tab_skips_its_echo(api):
    prompt, _ = _seed(api)
    response = api.client.put(f"/api/graph/node/{prompt}", headers=CANVAS, json={"params": {"value": "a fort"}})
    assert response.status_code == 200, response.text
    edit = _syncs(api)[-1]["edit"]
    assert edit == {"actor": {"kind": "person"}, "tab": TAB}


def test_a_malformed_tab_header_is_left_out(api):
    prompt, _ = _seed(api)
    api.client.put(f"/api/graph/node/{prompt}", headers={**PERSON, "X-Nebula-Tab": "<script>"},
                   json={"params": {"value": "x"}})
    assert "tab" not in _syncs(api)[-1]["edit"]


def test_every_direct_edit_route_marks_its_sync_as_an_edit(api):
    prompt, image = _seed(api)
    calls = [
        lambda: api.client.post("/api/graph/node", headers=AGENT, json={"definitionId": "text-input"}),
        lambda: api.client.put(f"/api/graph/node/{prompt}/label", headers=AGENT, json={"label": "Hero"}),
        lambda: api.client.put("/api/graph/layout", headers=AGENT, json={"positions": {prompt: {"x": 5, "y": 5}}}),
        lambda: api.client.request("DELETE", "/api/graph/edge", headers=AGENT, json={
            "source": prompt, "sourceHandle": "text", "target": image, "targetHandle": "prompt"}),
        lambda: api.client.post("/api/graph/connect", headers=AGENT, json={
            "source": prompt, "sourceHandle": "text", "target": image, "targetHandle": "prompt"}),
        lambda: api.client.delete(f"/api/graph/node/{image}", headers=AGENT),
        lambda: api.client.delete("/api/graph", headers=AGENT),
    ]
    for call in calls:
        before = len(_syncs(api))
        response = call()
        assert response.status_code == 200, response.text
        assert len(_syncs(api)) == before + 1
        assert _syncs(api)[-1]["edit"]["actor"]["name"] == "Claude"


def test_a_project_switch_sync_is_not_an_edit(api):
    import asyncio

    import main as main_module

    asyncio.run(main_module._broadcast_graph_sync(graph_replaced=True, reason="project-open", edit=True))
    assert "edit" not in _syncs(api)[-1]
    asyncio.run(main_module._broadcast_graph_sync())
    assert "edit" not in _syncs(api)[-1]


# -- undo reaches the backend -------------------------------------------------

def test_undoing_an_agent_delete_brings_the_node_back_with_params_outputs_and_wires(api):
    prompt, image = _seed(api)
    api.graph.nodes[prompt]["outputs"] = {"text": {"type": "Text", "value": "a lighthouse"}}
    api.graph.set_label(prompt, "Hero prompt")
    assert api.client.post("/api/graph/apply", headers=AGENT, json={"remove": [prompt]}).status_code == 200
    assert prompt not in api.graph.nodes and api.graph.edges == []

    response = _restore(api, {
        "action": "undo",
        "nodes": [{"id": prompt, "definitionId": "text-input", "label": "Hero prompt",
                   "params": {"value": "a lighthouse"}, "position": {"x": 0, "y": 0},
                   "outputs": {"text": {"type": "Text", "value": "a lighthouse"}}}],
        "wire": [{"source": prompt, "sourceHandle": "text", "target": image, "targetHandle": "prompt"}],
    })
    assert response.status_code == 200, response.text
    assert response.json()["added"] == [prompt]
    node = api.graph.nodes[prompt]
    assert node["params"] == {"value": "a lighthouse"}
    assert node["outputs"]["text"]["value"] == "a lighthouse"
    assert node["label"] == "Hero prompt"
    assert node["position"] == {"x": 0.0, "y": 0.0}
    assert _wires(api) == {(prompt, "text", image, "prompt")}
    # The next new node can't reuse the restored id.
    assert api.graph.add_node("text-input", {}) not in {prompt, image}
    sync = _syncs(api)[-1]
    assert sync["edit"]["tab"] == TAB
    assert {n["id"] for n in sync["nodes"]} == {prompt, image}


def test_undoing_an_agent_create_removes_its_nodes_and_wires(api):
    prompt, image = _seed(api)
    applied = api.client.post("/api/graph/apply", headers=AGENT, json={
        "nodes": [{"ref": "+alt", "definitionId": "text-input", "params": {"value": "fog"}}],
        "edges": [{"source": "+alt", "sourceHandle": "text", "target": image, "targetHandle": "prompt"}],
        "unwire": [{"source": prompt, "sourceHandle": "text", "target": image, "targetHandle": "prompt"}],
    })
    assert applied.status_code == 200, applied.text
    alt = applied.json()["idMap"]["+alt"]

    response = _restore(api, {
        "action": "undo",
        "remove": [alt],
        "wire": [{"source": prompt, "sourceHandle": "text", "target": image, "targetHandle": "prompt"}],
    })
    assert response.status_code == 200, response.text
    assert set(api.graph.nodes) == {prompt, image}
    assert _wires(api) == {(prompt, "text", image, "prompt")}

    # Redo puts the agent's edit back, same ids.
    redo = _restore(api, {
        "action": "redo",
        "nodes": [{"id": alt, "definitionId": "text-input", "params": {"value": "fog"}}],
        "unwire": [{"source": prompt, "sourceHandle": "text", "target": image, "targetHandle": "prompt"}],
        "wire": [{"source": alt, "sourceHandle": "text", "target": image, "targetHandle": "prompt"}],
    })
    assert redo.status_code == 200, redo.text
    assert set(api.graph.nodes) == {prompt, image, alt}
    assert _wires(api) == {(alt, "text", image, "prompt")}


def test_restored_params_replace_rather_than_merge(api):
    _, image = _seed(api)
    api.graph.update_params(image, {"aspect_ratio": "16:9"})
    response = _restore(api, {"nodes": [{"id": image, "definitionId": "nano-banana", "params": {}}]})
    assert response.status_code == 200, response.text
    assert response.json()["changed"] == [image]
    assert "aspect_ratio" not in api.graph.nodes[image]["params"]


def test_restore_keeps_current_outputs_of_nodes_that_still_exist(api):
    prompt, _ = _seed(api)
    api.graph.nodes[prompt]["outputs"] = {"text": {"type": "Text", "value": "newer"}}
    response = _restore(api, {"nodes": [{"id": prompt, "definitionId": "text-input",
                                         "params": {"value": "older"},
                                         "outputs": {"text": {"type": "Text", "value": "stale"}}}]})
    assert response.status_code == 200, response.text
    assert api.graph.nodes[prompt]["outputs"]["text"]["value"] == "newer"
    assert api.graph.nodes[prompt]["params"]["value"] == "older"


def test_a_restored_position_reaches_other_canvases(api):
    prompt, _ = _seed(api)
    response = _restore(api, {"nodes": [{"id": prompt, "definitionId": "text-input",
                                         "params": {"value": "a lighthouse"}, "position": {"x": 300, "y": 90}}]})
    assert response.status_code == 200, response.text
    assert api.graph.nodes[prompt]["position"] == {"x": 300.0, "y": 90.0}
    assert _syncs(api)[-1]["moved"] == [prompt]


def test_two_tabs_undoing_the_same_step_agree(api):
    prompt, image = _seed(api)
    spare = api.graph.add_node("text-input", {})
    body = {"remove": [spare], "unwire": [{"source": prompt, "sourceHandle": "text",
                                           "target": image, "targetHandle": "prompt"}]}
    assert _restore(api, body).status_code == 200
    again = _restore(api, body)
    assert again.status_code == 200, again.text
    assert again.json()["removed"] == [] and again.json()["unwired"] == []


def test_a_node_that_became_something_else_is_refused_and_nothing_changes(api):
    prompt, image = _seed(api)
    before = {k: dict(v) for k, v in api.graph.nodes.items()}
    response = _restore(api, {
        "remove": [image],
        "nodes": [{"id": prompt, "definitionId": "nano-banana", "params": {}}],
    })
    assert response.status_code == 409
    assert {k: dict(v) for k, v in api.graph.nodes.items()} == before


def test_a_wire_to_a_missing_node_is_refused(api):
    prompt, _ = _seed(api)
    response = _restore(api, {"wire": [{"source": prompt, "sourceHandle": "text",
                                        "target": "n99", "targetHandle": "prompt"}]})
    assert response.status_code == 409
    assert "n99" in response.json()["detail"]


def test_bad_bodies_are_refused(api):
    _seed(api)
    assert _restore(api, {"action": "rewind"}).status_code == 400
    assert _restore(api, {"nodes": [{"id": "abc", "definitionId": "text-input"}]}).status_code == 400
    assert _restore(api, {"remove": "n1"}).status_code == 400
    assert _restore(api, {"nodes": [{"id": "n1", "definitionId": "text-input"}], "remove": ["n1"]}).status_code == 400


def test_the_journal_records_the_undo_as_the_person(api):
    prompt, image = _seed(api)
    api.client.post("/api/graph/apply", headers=AGENT, json={"remove": [prompt]})
    cursor = api.journal.latest
    response = _restore(api, {
        "action": "undo",
        "nodes": [{"id": prompt, "definitionId": "text-input", "params": {"value": "a lighthouse"}}],
        "wire": [{"source": prompt, "sourceHandle": "text", "target": image, "targetHandle": "prompt"}],
    })
    assert response.status_code == 200, response.text
    events = api.journal.read(after=cursor, limit=50)["events"]
    assert [e["kind"] for e in events] == ["node.added", "edge.added"]
    assert all(e["actor"] == {"kind": "person"} for e in events)
    assert all(e["summary"].endswith("(undo)") for e in events)


def test_an_agent_cannot_use_restore_to_change_who_bills_a_node(api):
    _seed(api)
    body = {"nodes": [{"id": "n7", "definitionId": "flux-2-pro", "params": {"_provider": "fal"}}]}
    response = _restore(api, body, headers=AGENT)
    assert response.status_code == 403
    assert "n7" not in api.graph.nodes
    # The person's canvas can: it is putting back a node they had.
    assert _restore(api, body).status_code == 200
    assert api.graph.nodes["n7"]["params"]["_provider"] == "fal"


def test_an_item_changes_only_what_it_sends(api):
    prompt, _ = _seed(api)
    api.graph.set_label(prompt, "Hero prompt")
    response = _restore(api, {"nodes": [{"id": prompt, "definitionId": "text-input",
                                         "position": {"x": 80, "y": 40}}]})
    assert response.status_code == 200, response.text
    node = api.graph.nodes[prompt]
    assert node["params"] == {"value": "a lighthouse"}
    assert node["label"] == "Hero prompt"
    assert node["position"] == {"x": 80.0, "y": 40.0}
    assert response.json()["changed"] == [] and response.json()["renamed"] == []


def test_an_item_can_clear_a_custom_name(api):
    prompt, _ = _seed(api)
    api.graph.set_label(prompt, "Hero prompt")
    # The canvas shows the model's name for a node without a custom one.
    response = _restore(api, {"nodes": [{"id": prompt, "definitionId": "text-input", "label": "Text Input"}]})
    assert response.status_code == 200, response.text
    assert not api.graph.nodes[prompt].get("label")
    assert response.json()["renamed"] == [prompt]


def test_the_packaged_app_may_send_the_tab_header():
    import main as main_module

    assert "X-Nebula-Tab" in main_module._DESKTOP_CORS_HEADERS

