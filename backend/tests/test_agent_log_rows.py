"""The Agent log has one row per agent action, under the agent that acted, in
canvas words (design).

Before, a route also sent a line to the running in-app chat turn
(``publish_action``), labelled with the chat's runner ("claude"), with ids and
counts in it, for the person's own tab edits too. Those lines are gone where
the agent's own row exists, and the actions that had only that line now have a
row of their own, through the same path the cursor rows use.

The log's two sources are read as the canvas reads them: the chat turn's
``thinking`` lines and each agent cursor event's ``log``, else its ``say``
(frontend agentLogStore.agentActionEntry). A test fails when any row an agent
action makes holds a node id or a definition id.
"""
from __future__ import annotations

import asyncio
import re
from typing import Any

import pytest

from services.chat_actions import register_action_handler, unregister_action_handler
from tests.conftest import PERSON
from tests.test_canvas_undo import AGENT, OTHER, _agent_rows, _apply, _seed, _undone, api  # noqa: F401 - fixture

NODE_ID = re.compile(r"\bn\d+\b")


@pytest.fixture
def chat_lines():
    """The lines an in-app chat turn would send to the Agent log."""
    lines: list[str] = []
    register_action_handler(lambda event: lines.append(event["text"]) if event.get("type") == "thinking" else None)
    yield lines
    unregister_action_handler()


def _rows(api) -> list[tuple[str, str]]:  # noqa: F811 - the imported fixture
    return _agent_rows(api)


def _events(api) -> list[dict[str, Any]]:  # noqa: F811
    return [event for event in api.sent if event.get("type") == "agentPresence" and event.get("agent")]


# -- the removed rows ---------------------------------------------------------------------------------

def _walk(api, headers) -> None:  # noqa: F811
    """One of each route that used to publish a line, called as ``headers``."""
    client, graph = api.client, api.graph
    node = client.post("/api/graph/node", headers=headers, json={"definitionId": "text-input", "params": {"value": "a"}})
    assert node.status_code == 200, node.text
    text = node.json()["id"]
    both = client.post("/api/graph/node-and-connect", headers=headers, json={
        "definitionId": "gpt-image-2-5-generate", "params": {},
        "connect": {"source": text, "sourceHandle": "text", "target": "", "targetHandle": "prompt",
                    "newNodeIs": "target"}})
    assert both.status_code == 200, both.text
    other = graph.add_node("text-input", {"value": "b"})
    spare = graph.add_node("gpt-image-2-5-generate", {})
    edge = {"source": other, "sourceHandle": "text", "target": spare, "targetHandle": "prompt"}
    assert client.post("/api/graph/connect", headers=headers, json=edge).status_code == 200
    assert client.request("DELETE", "/api/graph/edge", headers=headers, json=edge).status_code == 200
    assert client.put(f"/api/graph/node/{text}", headers=headers, json={"params": {"value": "b"}}).status_code == 200
    assert client.put(f"/api/graph/node/{text}/label", headers=headers, json={"label": "Hero prompt"}).status_code == 200
    assert client.put("/api/graph/layout", headers=headers,
                      json={"positions": {text: {"x": 900, "y": 640}}}).status_code == 200
    assert client.delete(f"/api/graph/node/{other}", headers=headers).status_code == 200


def test_the_runner_labelled_rows_are_gone_for_an_agents_calls(api, chat_lines):  # noqa: F811
    _walk(api, AGENT)
    assert chat_lines == []
    assert _rows(api), "the agent's own rows are still there"


def test_the_persons_own_edits_make_no_agent_log_row_during_a_chat_turn(api, chat_lines):  # noqa: F811
    _walk(api, PERSON)
    assert chat_lines == []
    assert _events(api) == []


def test_an_edit_an_agents_undo_and_a_persons_undo_leave_no_runner_row(api, chat_lines):  # noqa: F811
    prompt, _image = _seed(api)
    applied = _apply(api, {"params": [{"nodeId": prompt, "params": {"value": "a fort"}}]})
    assert chat_lines == []
    _undone(api, applied["undo"]["token"])
    assert chat_lines == []
    restore = api.client.post("/api/graph/restore", headers=PERSON, json={
        "action": "undo", "nodes": [], "remove": [], "wire": [], "unwire": []})
    assert restore.status_code == 200, restore.text
    assert chat_lines == []


def test_the_persons_cluster_and_clear_leave_no_row(api, chat_lines):  # noqa: F811
    body = {"nodes": [{"tempId": "t1", "definitionId": "text-input", "params": {}}], "edges": []}
    assert api.client.post("/api/graph/cluster", headers=PERSON, json=body).status_code == 200
    assert api.client.request("DELETE", "/api/graph?force=true", headers=PERSON).status_code == 200
    assert chat_lines == [] and _events(api) == []


# -- the lines that moved onto the acting agent's own row ----------------------------------------------

def test_an_agents_undo_is_its_own_row_without_its_name(api, chat_lines):  # noqa: F811
    prompt, _image = _seed(api)
    applied = _apply(api, {"params": [{"nodeId": prompt, "params": {"value": "a fort"}}]})
    _undone(api, applied["undo"]["token"])
    assert _rows(api)[-1] == ("Claude Code", "Undid its edit")
    assert chat_lines == []


def test_the_agent_that_undid_is_the_agent_named_not_the_one_whose_chat_is_open(api, chat_lines):  # noqa: F811
    prompt, _image = _seed(api)
    applied = _apply(api, {"params": [{"nodeId": prompt, "params": {"value": "a fort"}}]}, headers=OTHER)
    _undone(api, applied["undo"]["token"], headers=OTHER)
    assert _rows(api)[-1] == ("Codex", "Undid its edit")


def test_clear_is_the_agents_row(api, chat_lines):  # noqa: F811
    _seed(api)
    assert api.client.request("DELETE", "/api/graph?force=true", headers=AGENT).status_code == 200
    assert _rows(api)[-1] == ("Claude Code", "Cleared the canvas")
    assert chat_lines == []


def test_import_is_the_agents_row(api, chat_lines):  # noqa: F811
    body = {"nodes": [{"id": "a", "definitionId": "text-input", "params": {"value": "x"}}], "edges": []}
    response = api.client.post("/api/graph/import", headers=AGENT, json=body)
    assert response.status_code == 200, response.text
    assert _rows(api)[-1] == ("Claude Code", "Loaded a saved canvas")
    assert chat_lines == []


def _cluster_of(api, definitions: list[str]) -> dict:  # noqa: F811
    nodes = [{"tempId": f"t{index}", "definitionId": definition, "params": {}}
             for index, definition in enumerate(definitions)]
    response = api.client.post("/api/graph/cluster", headers=AGENT, json={"nodes": nodes, "edges": []})
    assert response.status_code == 200, response.text
    return response.json()["idMap"]


def test_a_cluster_names_up_to_three_nodes_and_counts_from_four(api, chat_lines):  # noqa: F811
    import main as main_module

    ids = _cluster_of(api, ["text-input", "image-input", "reroute"])
    names = [main_module._node_label(node_id) for node_id in ids.values()]
    assert len(set(names)) == 3
    assert _rows(api)[-1] == ("Claude Code", f"Grouped “{names[0]}”, “{names[1]}” and “{names[2]}”")
    _cluster_of(api, ["text-input", "image-input"])
    assert _rows(api)[-1] == ("Claude Code", f"Grouped “{names[0]}” and “{names[1]}”")
    _cluster_of(api, ["text-input", "image-input", "reroute", "text-input"])
    assert _rows(api)[-1] == ("Claude Code", "Grouped 4 nodes")
    assert chat_lines == []


def test_the_names_rule_names_three_and_counts_from_four(api):  # noqa: F811
    import main as main_module

    graph = api.graph
    ids = [graph.add_node("text-input", {"value": str(index)}) for index in range(5)]
    for node_id, label in zip(ids, ("A", "B", "C", "D", "E")):
        graph.set_label(node_id, label)
    assert main_module._named_nodes(ids[:1]) == "“A”"
    assert main_module._named_nodes(ids[:2]) == "“A” and “B”"
    assert main_module._named_nodes(ids[:3]) == "“A”, “B” and “C”"
    assert main_module._named_nodes(ids[:4]) == "4 nodes"


def test_an_agents_move_names_every_node_that_moved(api):  # noqa: F811
    graph = api.graph
    ids = [graph.add_node("text-input", {"value": str(index)}, position={"x": 0, "y": 0}) for index in range(4)]
    for node_id, label in zip(ids, ("A", "B", "C", "D")):
        graph.set_label(node_id, label)

    shift = [0]

    def move(chosen):
        shift[0] += 1000  # every call puts each node somewhere new, so each counts as moved
        return api.client.put("/api/graph/layout", headers=AGENT, json={
            "positions": {node_id: {"x": shift[0] + index * 300, "y": 640} for index, node_id in enumerate(chosen)}})

    assert move(ids[:1]).status_code == 200
    assert _rows(api)[-1] == ("Claude Code", "Moved “A”")
    assert move(ids[:2]).status_code == 200
    assert _rows(api)[-1] == ("Claude Code", "Moved “A” and “B”")
    assert move(ids[:3]).status_code == 200
    assert _rows(api)[-1] == ("Claude Code", "Moved “A”, “B” and “C”")
    assert move(ids).status_code == 200
    assert _rows(api)[-1] == ("Claude Code", "Moved 4 nodes")


# -- a run's row ---------------------------------------------------------------------------------------

def test_the_run_row_forms_and_their_periods(api):  # noqa: F811
    import main as main_module

    graph = api.graph
    ids = [graph.add_node("text-input", {"value": str(index)}) for index in range(5)]
    for node_id, label in zip(ids, ("Hero shot", "Sky", "C", "D", "E")):
        graph.set_label(node_id, label)
    line = main_module._cli_run_line
    hero, sky, c, d, e = ids
    # One sentence has no period; two or more end each with one.
    assert line({hero: {}, sky: {}}, {}, [], 12.2, None) == "Ran “Hero shot” and “Sky” in 12 s"
    assert line({hero: {}}, {}, [], 0.2, None) == "Ran “Hero shot” in under 1 s"
    assert line({}, {}, [], 3, None) == "Nothing ran"
    assert line({hero: {}, sky: {}, c: {}}, {d: "boom"}, [], 12.4, None) == "Ran 4 nodes in 12 s. “D” failed."
    assert line({hero: {}}, {sky: "boom"}, [], 12, None) == "Ran “Hero shot” and “Sky” in 12 s. “Sky” failed."
    assert line({hero: {}}, {}, [sky], 1, None) == "Ran “Hero shot” in 1 s. “Sky” was skipped by a gate."
    assert line({hero: {}}, {}, [sky, c, d, e], 2, None) == "Ran “Hero shot” in 2 s. 4 nodes were skipped by a gate."
    assert line({hero: {}}, {}, [], 1, "Skipped 3 nodes Claude Code is still setting up.") == (
        "Ran “Hero shot” in 1 s. Skipped 3 nodes Claude Code is still setting up.")


def test_a_clean_run_is_the_agents_row_and_the_runner_row_is_gone(api, chat_lines):  # noqa: F811
    node = api.graph.add_node("text-input", {"value": "hi"})
    api.graph.set_label(node, "Hero shot")
    response = api.client.post("/api/graph/run", json={"wait": 5, "targetNodeId": node}, headers=AGENT)
    assert response.status_code == 200, response.text
    assert _rows(api) == [("Claude Code", "Running “Hero shot”"), ("Claude Code", "Ran “Hero shot” in under 1 s")]
    assert chat_lines == []
    # The cursor row carries the node for the zoom manifest; the finished row has no failure to zoom to.
    assert [event.get("nodeIds") for event in _events(api)] == [[node], None]


def test_a_failed_run_row_carries_the_failed_nodes_for_the_zoom_manifest(api, monkeypatch, chat_lines):  # noqa: F811
    import main as main_module
    from models.events import ErrorEvent, ExecutedEvent

    ok = api.graph.add_node("text-input", {"value": "hi"})
    bad = api.graph.add_node("text-input", {"value": "hi"})
    api.graph.set_label(ok, "Hero shot")
    api.graph.set_label(bad, "Sky")

    async def fake(**kwargs):
        await kwargs["emit"](ExecutedEvent(node_id=ok, outputs={}))
        await kwargs["emit"](ErrorEvent(node_id=bad, error="boom"))

    monkeypatch.setattr(main_module, "_run_graph", fake)
    response = api.client.post("/api/graph/run", json={"wait": 5}, headers=AGENT)
    assert response.status_code == 200, response.text
    assert _rows(api)[-1] == ("Claude Code", "Ran “Hero shot” and “Sky” in under 1 s. “Sky” failed.")
    assert _events(api)[-1]["nodeIds"] == [bad]
    assert chat_lines == []


def test_a_stopped_run_names_what_finished(api, monkeypatch, chat_lines):  # noqa: F811
    import main as main_module
    from models.events import ExecutedEvent

    ok = api.graph.add_node("text-input", {"value": "hi"})
    api.graph.add_node("text-input", {"value": "hi"})
    api.graph.set_label(ok, "Hero shot")

    async def fake(**kwargs):
        await kwargs["emit"](ExecutedEvent(node_id=ok, outputs={}))
        raise asyncio.CancelledError

    monkeypatch.setattr(main_module, "_run_graph", fake)
    # The task is cancelled from inside, as a stopped run is.
    api.client.post("/api/graph/run", json={"wait": 5}, headers=AGENT)
    assert _rows(api)[-1] == ("Claude Code", "Stopped after “Hero shot” ran")
    assert chat_lines == []


def test_a_run_with_no_agent_name_shows_no_row(api, chat_lines):  # noqa: F811
    node = api.graph.add_node("text-input", {"value": "hi"})
    response = api.client.post("/api/graph/run", json={"wait": 5, "targetNodeId": node})
    assert response.status_code == 200, response.text
    assert _events(api) == [] and chat_lines == []


# -- projects --------------------------------------------------------------------------------------------

def _revision() -> str:
    import main as main_module

    return main_module.project_store.workspace()["workspaceRevision"]


def test_an_agents_project_switch_is_its_own_row(api, chat_lines):  # noqa: F811
    opened = api.client.post(f"/api/projects/{api.other_project_id}/open", headers=AGENT,
                             json={"workspaceRevision": _revision()})
    assert opened.status_code == 200, opened.text
    assert _rows(api)[-1] == ("Claude Code", "Opened “Other”")
    made = api.client.post("/api/projects", headers=AGENT,
                           json={"name": "Spring campaign", "workspaceRevision": _revision()})
    assert made.status_code in (200, 201), made.text
    assert _rows(api)[-1] == ("Claude Code", "Made “Spring campaign”")
    assert chat_lines == []


def test_the_persons_own_project_switch_says_nothing(api, chat_lines):  # noqa: F811
    opened = api.client.post(f"/api/projects/{api.other_project_id}/open", headers=PERSON,
                             json={"workspaceRevision": _revision()})
    assert opened.status_code == 200, opened.text
    assert _rows(api) == [] and chat_lines == []


# -- no id in any row ---------------------------------------------------------------------------------------

def test_no_agent_log_row_an_agent_action_makes_holds_a_node_id_or_a_definition_id(api, chat_lines):  # noqa: F811
    import main as main_module

    _walk(api, AGENT)
    prompt, _image = _seed(api)
    applied = _apply(api, {"nodes": [{"ref": "+a", "definitionId": "text-input", "params": {"value": "x"}}],
                           "params": [{"nodeId": prompt, "params": {"value": "a fort"}}]})
    _undone(api, applied["undo"]["token"])
    _cluster_of(api, ["text-input", "image-input", "reroute", "text-input"])
    node = api.graph.add_node("text-input", {"value": "hi"})
    api.client.post("/api/graph/run", json={"wait": 5, "targetNodeId": node}, headers=AGENT)
    api.client.request("DELETE", "/api/graph?force=true", headers=AGENT)
    api.client.post("/api/graph/import", headers=AGENT, json={"nodes": [], "edges": []})
    rows = [text for _name, text in _rows(api)]
    assert len(rows) > 10
    definitions = {str(definition_id) for definition_id in main_module.node_registry.get_all()}
    for text in [*rows, *chat_lines]:
        assert not NODE_ID.search(text), text
        assert not any(re.search(rf"(?<![\w-]){re.escape(definition)}(?![\w-])", text) for definition in definitions), text
