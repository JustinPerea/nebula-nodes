from __future__ import annotations

import pytest
from fastapi.testclient import TestClient

from cli.formatter import format_snapshot
from services.agent_presence import (
    PRESENCE_TTL_SECONDS,
    AgentPresence,
    PresenceError,
    clean_agent_name,
    identify,
    parse_target,
)
from services.cli_graph import CLIGraph
from services.node_registry import NodeRegistry
from services.selection_context import SelectionContextStore


class Clock:
    def __init__(self) -> None:
        self.now = 1_000.0

    def __call__(self) -> float:
        return self.now


def _lookup(token: str) -> dict | None:
    return {"runner": "codex"} if token == "good" else None


# -- identity -------------------------------------------------------------

def test_browser_and_anonymous_requests_have_no_cursor():
    assert identify(None) is None
    assert identify({}) is None
    assert identify({"Authorization": "Bearer ui-session"}, token_lookup=_lookup) is None
    assert identify({"X-Nebula-Client": "nebula-cli"}, token_lookup=_lookup) is None


def test_agent_token_names_the_runner_and_wins_over_a_self_reported_name():
    identity = identify({"Authorization": "Agent good", "X-Nebula-Agent": "Imposter"}, token_lookup=_lookup)
    assert identity is not None
    assert (identity.id, identity.name, identity.verified) == ("codex", "Codex", True)


def test_unknown_agent_token_falls_back_to_the_self_reported_name():
    identity = identify({"Authorization": "Agent stale", "X-Nebula-Agent": "Claude Code"}, token_lookup=_lookup)
    assert identity is not None
    assert (identity.id, identity.name, identity.verified) == ("ext:claude-code", "Claude Code", False)


def test_daedalus_header_is_named_daedalus():
    identity = identify({"x-daedalus-caller": "1"}, token_lookup=_lookup)
    assert identity is not None and identity.name == "Daedalus"


def test_self_reported_names_are_cleaned_and_colours_are_stable():
    assert clean_agent_name("  <script>Claude\n\tCode</script> ") == "scriptClaude Codescript"
    assert clean_agent_name("x" * 80) == "x" * 32
    assert identify({"X-Nebula-Agent": "<<>>"}) is None
    first = identify({"X-Nebula-Agent": "Cursor"})
    second = identify({"X-Nebula-Agent": "cursor"})
    assert first is not None and second is not None
    assert first.id == second.id and first.color == second.color


# -- targets and cursor events ---------------------------------------------

def test_targets_must_name_a_live_node_or_finite_coordinates():
    nodes = {"n1": {}}
    assert parse_target({"nodeId": "n1", "handle": "prompt"}, nodes) == {"nodeId": "n1", "handle": "prompt"}
    assert parse_target({"x": 10, "y": -4.5}, nodes) == {"x": 10.0, "y": -4.5}
    for bad in (
        {"nodeId": "n9"},
        {"nodeId": "n1", "handle": "bad handle"},
        {"x": float("nan"), "y": 0},
        {"x": True, "y": 0},
        {"y": 1},
        "n1",
    ):
        with pytest.raises(PresenceError):
            parse_target(bad, nodes)


def test_point_builds_a_broadcast_event_and_trims_narration():
    presence = AgentPresence(clock=Clock())
    identity = identify({"X-Nebula-Agent": "Claude Code"})
    event = presence.point(identity, target={"nodeId": "n1"}, origin={"nodeId": "n0"}, action="drag",
                           say="  Wiring \n the prompt  " + "x" * 300)
    assert event["type"] == "agentPresence"
    assert event["agent"]["name"] == "Claude Code"
    assert event["from"] == {"nodeId": "n0"}
    assert event["say"].startswith("Wiring the prompt x")
    assert len(event["say"]) == 140
    with pytest.raises(PresenceError):
        presence.point(identity, target={"nodeId": "n1"}, action="teleport")


def test_cursors_expire_and_deleted_nodes_re_anchor_to_where_they_were():
    clock = Clock()
    presence = AgentPresence(clock=clock)
    presence.report_view({"viewport": {"x": 0, "y": 0, "zoom": 1},
                          "nodes": [{"id": "n1", "x": 100, "y": 50, "width": 200, "height": 100}]})
    claude = identify({"X-Nebula-Agent": "Claude Code"})
    other = identify({"X-Nebula-Agent": "Cursor"})
    presence.point(claude, target={"nodeId": "n1"})
    presence.point(other, target={"nodeId": "n2"})

    presence.forget_node("n1")
    presence.forget_node("n2")
    active = presence.active()
    assert [agent["name"] for agent in active] == ["Claude Code"]
    assert active[0]["target"] == {"x": 200.0, "y": 100.0}

    clock.now += PRESENCE_TTL_SECONDS + 1
    assert presence.active() == []


def test_clearing_or_replacing_the_graph_drops_node_anchors():
    presence = AgentPresence()
    presence.point(identify({"X-Nebula-Agent": "Claude Code"}), target={"nodeId": "n2"})
    presence.point(identify({"X-Nebula-Agent": "Cursor"}), target={"x": 4, "y": 5},
                   origin={"nodeId": "n1"}, action="drag")

    presence.forget_graph()
    active = presence.active()
    assert [agent["name"] for agent in active] == ["Cursor"]
    assert "from" not in active[0]


# -- view reports and snapshot ---------------------------------------------

def test_view_reports_are_validated():
    presence = AgentPresence(clock=Clock())
    for bad in (
        None,
        {"viewport": {"x": 0, "y": 0, "zoom": 0}},
        {"viewport": {"x": float("inf"), "y": 0, "zoom": 1}},
        {"viewport": {"x": 0, "y": 0, "zoom": 1}, "nodes": [{"id": "n1", "x": 0, "y": 0, "state": "melting"}]},
        {"viewport": {"x": 0, "y": 0, "zoom": 1}, "nodes": [{"id": "bad id", "x": 0, "y": 0}]},
        {"viewport": {"x": 0, "y": 0, "zoom": 1}, "screen": {"width": -1, "height": 10}},
    ):
        with pytest.raises(PresenceError):
            presence.report_view(bad)


def test_snapshot_merges_the_browser_view_with_the_graph_and_redacts():
    clock = Clock()
    presence = AgentPresence(clock=clock)
    graph = CLIGraph()
    first = graph.add_node("text-input", {"value": "orb", "api_token": "nope"})
    second = graph.add_node(
        "gpt-image-2-5-generate",
        {"quality": "low"},
        outputs={"image": {"type": "Image", "value": "https://cdn.example/x.png?signature=secret"}},
    )
    graph.connect(first, "text", second, "prompt")

    before = presence.snapshot(graph, NodeRegistry())
    assert before["view"]["reported"] is False and before["view"]["stale"] is True
    assert before["nodes"][0]["state"] == "unknown"

    presence.report_view({
        "viewport": {"x": -100, "y": 0, "zoom": 2},
        "screen": {"width": 800, "height": 600},
        "nodes": [
            {"id": first, "x": 60, "y": 20, "width": 100, "height": 80, "state": "idle"},
            {"id": second, "x": 2000, "y": 0, "width": 120, "height": 90, "state": "complete"},
        ],
    })
    presence.point(identify({"X-Nebula-Agent": "Claude Code"}), target={"nodeId": second}, say="Done")
    clock.now += 3
    snap = presence.snapshot(graph, NodeRegistry(), selected_ids=[second, "n404"])

    assert snap["view"]["visibleArea"] == {"x": 50.0, "y": -0.0, "width": 400.0, "height": 300.0}
    assert snap["view"]["secondsAgo"] == 3.0 and snap["view"]["stale"] is False
    text_node, image_node = snap["nodes"]
    assert text_node["onScreen"] is True and image_node["onScreen"] is False
    assert text_node["params"]["api_token"] == "<redacted>"
    assert image_node["name"] == "GPT Image 2.5"
    assert image_node["state"] == "complete"
    assert image_node["outputs"] == {"image": {"type": "Image", "available": True}}
    assert "signature" not in str(snap)
    assert image_node["inputsFrom"] == [f"{first}.text→prompt"]
    assert snap["selection"] == [second]
    assert snap["agents"][0]["say"] == "Done"

    text = format_snapshot(snap)
    assert "zoom 2.00" in text
    assert "GPT Image 2.5 [complete]" in text
    assert "off-screen" in text
    assert f"{first}.text → {second}.prompt" in text
    assert 'Claude Code at n2 "Done"' in text


# -- HTTP ------------------------------------------------------------------

@pytest.fixture
def api(monkeypatch):
    import main as main_module

    graph = CLIGraph()
    presence = AgentPresence()
    sent: list[dict] = []

    async def capture(data):
        sent.append(data)

    monkeypatch.setattr(main_module, "cli_graph", graph)
    monkeypatch.setattr(main_module, "agent_presence", presence)
    monkeypatch.setattr(main_module, "selection_context", SelectionContextStore())
    monkeypatch.setattr(main_module.manager, "broadcast_raw", capture)
    monkeypatch.setattr(main_module, "_check_workspace_revision", lambda: None)
    return TestClient(main_module.app), graph, sent


def _presence_events(sent: list[dict]) -> list[dict]:
    return [event for event in sent if event.get("type") == "agentPresence"]


def test_cursor_endpoint_requires_an_identified_agent(api):
    client, graph, sent = api
    node_id = graph.add_node("text-input", {"value": "hi"})
    assert client.post("/api/canvas/cursor", json={"target": {"nodeId": node_id}}).status_code == 400
    bad = client.post("/api/canvas/cursor", json={"target": {"nodeId": "n404"}},
                      headers={"X-Nebula-Agent": "Claude Code"})
    assert bad.status_code == 422
    ok = client.post("/api/canvas/cursor",
                     json={"target": {"nodeId": node_id}, "say": "Looking here", "action": "look"},
                     headers={"X-Nebula-Agent": "Claude Code"})
    assert ok.status_code == 200
    (event,) = _presence_events(sent)
    assert event["agent"]["name"] == "Claude Code"
    assert event["target"] == {"nodeId": node_id} and event["action"] == "look"


def test_agent_graph_edits_move_the_cursor_but_browser_edits_do_not(api):
    client, graph, sent = api
    agent = {"X-Nebula-Agent": "Claude Code"}

    browser = client.post("/api/graph/node", json={"definitionId": "text-input", "params": {"value": "a"}})
    assert browser.status_code == 200
    assert _presence_events(sent) == []

    text = client.post("/api/graph/node", json={"definitionId": "text-input", "params": {"value": "b"}},
                       headers=agent).json()["id"]
    image = client.post("/api/graph/node", json={"definitionId": "gpt-image-2-5-generate", "params": {}},
                        headers=agent).json()["id"]
    wired = client.post("/api/graph/connect", headers=agent, json={
        "source": text, "sourceHandle": "text", "target": image, "targetHandle": "prompt"})
    assert wired.status_code == 200
    updated = client.put(f"/api/graph/node/{image}", headers=agent, json={"params": {"quality": "low"}})
    assert updated.status_code == 200

    events = _presence_events(sent)
    assert [event["say"] for event in events] == [
        "Added Text Input",
        "Added GPT Image 2.5",
        f"Wiring {text} → {image}",
        "Set quality",
    ]
    drag = events[2]
    assert drag["action"] == "drag"
    assert drag["from"] == {"nodeId": text, "handle": "text"}
    assert drag["target"] == {"nodeId": image, "handle": "prompt"}


def test_view_report_and_snapshot_round_trip(api):
    client, graph, _ = api
    node_id = graph.add_node("text-input", {"value": "hi"})
    assert client.post("/api/canvas/view", json={"viewport": {"x": 0, "y": 0, "zoom": 0}}).status_code == 422
    reported = client.post("/api/canvas/view", json={
        "viewport": {"x": 0, "y": 0, "zoom": 1},
        "screen": {"width": 1000, "height": 700},
        "nodes": [{"id": node_id, "x": 10, "y": 10, "width": 200, "height": 120, "state": "idle"}],
    })
    assert reported.json() == {"ok": True, "nodes": 1}
    snap = client.get("/api/canvas/snapshot").json()
    assert snap["nodes"][0]["onScreen"] is True
    assert snap["view"]["screen"] == {"width": 1000, "height": 700}


# -- MCP tools -------------------------------------------------------------

def test_mcp_point_at_and_look_name_the_cursor(monkeypatch):
    import httpx
    import mcp_server

    calls: list[dict] = []

    def fake_request(method, url, *, headers, timeout, **kwargs):
        calls.append({"method": method, "url": url, "headers": headers, **kwargs})
        return httpx.Response(200, json={"ok": True}, request=httpx.Request(method, url))

    monkeypatch.setattr(mcp_server.httpx, "request", fake_request)
    monkeypatch.delenv("NEBULA_AGENT_TOKEN", raising=False)
    monkeypatch.setenv("NEBULA_AGENT_NAME", "Claude Code")

    mcp_server.point_at(node_id="n2", port="prompt", from_node_id="n1", from_port="text",
                        action="drag", say="Wiring")
    mcp_server.look_at_canvas()
    point, look = calls
    assert point["url"].endswith("/api/canvas/cursor")
    assert point["headers"] == {"X-Nebula-Agent": "Claude Code"}
    assert point["json"] == {
        "target": {"nodeId": "n2", "handle": "prompt"},
        "from": {"nodeId": "n1", "handle": "text"},
        "say": "Wiring",
        "action": "drag",
    }
    assert look["method"] == "GET" and look["url"].endswith("/api/canvas/snapshot")

    monkeypatch.delenv("NEBULA_AGENT_NAME")
    assert mcp_server._cursor_name(None) == "MCP agent"
    with pytest.raises(ValueError):
        mcp_server.point_at(say="nowhere")


def test_clearing_the_canvas_forgets_cursors_anchored_to_its_nodes(api):
    client, _graph, _sent = api
    agent = {"X-Nebula-Agent": "Claude Code"}
    client.post("/api/graph/node", json={"definitionId": "text-input", "params": {"value": "a"}}, headers=agent)
    assert client.get("/api/canvas/snapshot").json()["agents"]

    assert client.delete("/api/graph").status_code == 200
    assert client.get("/api/canvas/snapshot").json()["agents"] == []
