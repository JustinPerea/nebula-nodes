"""Nebula says connected, never wired (GM - Design, 2026-10-25).

The agent's cursor bubbles name nodes by their label in curly quotes, as the
Agents panel does, falling back to the node type's name when a node has no
label: Connecting “A” to “B”, Added “X” and connected it, Disconnected “A”
from “B”, and the same quotes on Added, Renamed, Moved, Removed, Running and
Updated. The Agent log (publish_action) is the technical record: it keeps
port ids and the arrow and swaps only the verb (Connected a:b → c:d,
Disconnected a:b → c:d). Neither ever says wired.
"""
from __future__ import annotations

import pytest

from tests.test_agent_presence import _presence_events, api  # noqa: F401 - fixture

AGENT = {"X-Nebula-Agent": "Claude Code"}


@pytest.fixture
def logged(api, monkeypatch):  # noqa: F811 - the imported fixture
    import main as main_module

    lines: list[str] = []
    monkeypatch.setattr(main_module, "publish_action", lines.append)
    client, graph, sent = api
    return client, graph, sent, lines


def _says(sent: list[dict]) -> list[str]:
    return [event.get("say") for event in _presence_events(sent)]


def _no_wired(sent: list[dict], lines: list[str]) -> None:
    for text in [*_says(sent), *lines]:
        assert "wir" not in str(text).lower(), text


def _pair(graph, *, label: str | None = "Hero prompt"):
    text = graph.add_node("text-input", {"value": "a cat"})
    if label:
        graph.set_label(text, label)
    image = graph.add_node("gpt-image-2-5-generate", {})
    return text, image


def test_connecting_names_both_nodes_in_quotes_and_the_log_says_connected(logged):
    client, graph, sent, lines = logged
    text, image = _pair(graph)
    response = client.post("/api/graph/connect", headers=AGENT, json={
        "source": text, "sourceHandle": "text", "target": image, "targetHandle": "prompt"})
    assert response.status_code == 200, response.text
    # The unlabeled image node falls back to its type's name.
    assert _says(sent)[-1] == "Connecting “Hero prompt” to “GPT Image 2.5”"
    assert lines[-1] == f"Connected {text}:text → {image}:prompt"
    _no_wired(sent, lines)


def test_connecting_two_unlabeled_nodes_uses_their_type_names(logged):
    client, graph, sent, lines = logged
    text, image = _pair(graph, label=None)
    client.post("/api/graph/connect", headers=AGENT, json={
        "source": text, "sourceHandle": "text", "target": image, "targetHandle": "prompt"})
    assert _says(sent)[-1] == "Connecting “Text Input” to “GPT Image 2.5”"


def test_disconnecting_names_both_nodes_and_the_log_says_disconnected(logged):
    client, graph, sent, lines = logged
    text, image = _pair(graph)
    graph.connect(text, "text", image, "prompt")
    response = client.request("DELETE", "/api/graph/edge", headers=AGENT, json={
        "source": text, "sourceHandle": "text", "target": image, "targetHandle": "prompt"})
    assert response.json()["status"] == "deleted"
    assert _says(sent)[-1] == "Disconnected “Hero prompt” from “GPT Image 2.5”"
    assert lines[-1] == f"Disconnected {text}:text → {image}:prompt"
    _no_wired(sent, lines)


def test_adding_and_connecting_in_one_call_says_connected(logged):
    client, graph, sent, lines = logged
    text = graph.add_node("text-input", {"value": "a cat"})
    response = client.post("/api/graph/node-and-connect", headers=AGENT, json={
        "definitionId": "gpt-image-2-5-generate", "params": {},
        "connect": {"source": text, "sourceHandle": "text", "target": "", "targetHandle": "prompt",
                    "newNodeIs": "target"}})
    assert response.status_code == 200, response.text
    new_id = response.json()["id"]
    assert _says(sent)[-1] == "Added “GPT Image 2.5” and connected it"
    assert lines[-1] == f"Connected {text}:text → {new_id}:prompt"
    _no_wired(sent, lines)


def test_adding_a_node_names_it_in_quotes(logged):
    client, _graph, sent, _lines = logged
    client.post("/api/graph/node", headers=AGENT, json={"definitionId": "text-input", "params": {"value": "a"}})
    assert _says(sent)[-1] == "Added “Text Input”"


def test_renaming_moving_and_updating_name_the_node_in_quotes(logged):
    client, graph, sent, _lines = logged
    node = graph.add_node("text-input", {"value": "a"})
    assert client.put(f"/api/graph/node/{node}/label", headers=AGENT,
                      json={"label": "Hero shots"}).status_code == 200
    assert _says(sent)[-1] == "Renamed “Hero shots”"
    assert client.put("/api/graph/layout", headers=AGENT,
                      json={"positions": {node: {"x": 900, "y": 640}}}).status_code == 200
    assert _says(sent)[-1] == "Moved “Hero shots”"
    # A params update that names no param changes nothing, so it says nothing
    # (PR #198 review 2, N4): the last line is still the move.
    assert client.put(f"/api/graph/node/{node}", headers=AGENT, json={"params": {}}).status_code == 200
    assert [say for say in _says(sent) if say][-1] == "Moved “Hero shots”"
    # A params update that names params says which, by the card's label in
    # curly quotes (GM - Design, round 16 of PR #195; GM, r18 of PR #114):
    # no node, never the raw key.
    assert client.put(f"/api/graph/node/{node}", headers=AGENT, json={"params": {"value": "b"}}).status_code == 200
    assert _says(sent)[-1] == "Set “Text”"


def test_updating_an_unlabeled_node_falls_back_to_its_type_name(logged):
    client, graph, sent, lines = logged
    node = graph.add_node("text-input", {"value": "a"})
    assert client.put(f"/api/graph/node/{node}", headers=AGENT, json={"params": {"value": "b"}}).status_code == 200
    # The Agents panel's line names it by its type: Changed “Text Input”.
    assert (_presence_events(sent)[-1].get("did") or {}).get("label") == "Text Input"
    # An empty change says and logs nothing (PR #198 review 2, N4).
    before = (len(_presence_events(sent)), len(lines))
    assert client.put(f"/api/graph/node/{node}", headers=AGENT, json={"params": {}}).status_code == 200
    assert not any(event.get("say") or event.get("log") for event in _presence_events(sent)[before[0]:])
    assert lines[before[1]:] == []


def test_removing_a_node_names_it_by_the_label_read_before_removal(logged):
    client, _graph, sent, _lines = logged
    node = client.post("/api/graph/node", headers=AGENT,
                       json={"definitionId": "text-input", "params": {"value": "a"}}).json()["id"]
    client.put(f"/api/graph/node/{node}/label", headers=AGENT, json={"label": "Spare"})
    # The browser drew it, so the cursor has a place to point at once it's gone.
    client.post("/api/canvas/view", json={
        "viewport": {"x": 0, "y": 0, "zoom": 1}, "screen": {"width": 1000, "height": 700},
        "nodes": [{"id": node, "x": 10, "y": 10, "width": 200, "height": 120, "state": "idle"}]})
    assert client.delete(f"/api/graph/node/{node}", headers=AGENT).status_code == 200
    assert _says(sent)[-1] == "Removed “Spare”"


def test_running_one_node_names_it_in_quotes(logged):
    client, graph, sent, _lines = logged
    node = graph.add_node("text-input", {"value": "hi"})
    assert client.post("/api/graph/run", json={"wait": 5, "targetNodeId": node}, headers=AGENT).status_code == 200
    assert "Running “Text Input”" in _says(sent)


def test_a_refused_run_bubble_names_the_node_in_quotes(logged):
    # The bubble quotes the node like every other; the Agent log keeps its line.
    client, graph, sent, lines = logged
    node = graph.add_node("gpt-image-2-5-generate", {})
    body = client.post("/api/graph/run", json={"targetNodeId": node}, headers=AGENT).json()
    assert body["status"] == "failed"
    [said] = [say for say in _says(sent) if "can’t run" in str(say)]
    assert said.startswith("“GPT Image 2.5” can’t run.")
    assert any(line.startswith("Nebula couldn’t start the run. “GPT Image 2.5” needs") for line in lines)
