from __future__ import annotations

import argparse
import io
import json
from unittest.mock import AsyncMock

import httpx
import pytest
from fastapi.testclient import TestClient

from cli.commands import pins as pins_cmd
from cli.formatter import format_event, format_pin, format_snapshot
from services.agent_presence import AgentIdentity, AgentPresence
from services.canvas_events import CanvasEventJournal
from services.canvas_pins import MAX_OPEN_PINS, MAX_PIN_TEXT, MAX_PINS, CanvasPins, PinError, clean_text
from services.cli_graph import CLIGraph
from services.execution_runs import ExecutionRunRegistry
from services.person_gate import PersonGateError, require_person
from services.project_store import ProjectStore, make_project
from services.provider_recovery import ProviderRecoveryStore
from services.provider_start_guard import ProviderStartGuard
from services.selection_context import SelectionContextStore

BROWSER = {"Origin": "http://localhost:5173"}
AGENT = {"X-Nebula-Agent": "Claude Code"}
CODEX = AgentIdentity(id="codex", name="Codex", color="#5B9DFF", verified=True)


class Clock:
    def __init__(self) -> None:
        self.now = 1_760_000_000.0

    def __call__(self) -> float:
        return self.now


def _store_with_projects(tmp_path, *names: str) -> tuple[ProjectStore, list[str]]:
    store = ProjectStore(tmp_path / "projects")
    ids = []
    with store.transaction() as catalog:
        for name in names:
            project = make_project(name)
            catalog["projects"][project["id"]] = project
            ids.append(project["id"])
        catalog["activeProjectId"] = ids[0] if ids else None
        store.commit(catalog)
    return store, ids


def _activate(store: ProjectStore, project_id: str) -> None:
    with store.transaction() as catalog:
        catalog["activeProjectId"] = project_id
        store.commit(catalog)


# -- text and caps ----------------------------------------------------------

def test_text_is_plain_single_line_and_capped():
    assert clean_text("  warmer\n\tplease\x00\x1b[31m ‮ ", limit=280) == "warmer please[31m"
    assert clean_text("x" * MAX_PIN_TEXT, limit=MAX_PIN_TEXT) == "x" * MAX_PIN_TEXT
    for bad in ("", "   \n", None, 42, "x" * (MAX_PIN_TEXT + 1)):
        with pytest.raises(PinError) as exc:
            clean_text(bad, limit=MAX_PIN_TEXT)
        assert exc.value.status == 422


def test_pins_need_exactly_one_anchor_and_a_live_node(tmp_path):
    store, _ = _store_with_projects(tmp_path, "One")
    pins = CanvasPins(store)
    nodes = {"n1": {"position": {"x": 10, "y": 20}}}
    pin = pins.add("warmer", node_id="n1", graph_nodes=nodes)
    assert pin["id"].startswith("pin_") and len(pin["id"]) == 12
    assert pin["anchor"] == {"nodeId": "n1"} and pin["position"] == {"x": 10.0, "y": 20.0}
    spot = pins.add("something here?", position={"x": 420, "y": -80}, graph_nodes=nodes)
    assert spot["anchor"] == {"x": 420.0, "y": -80.0}
    for kwargs in ({}, {"node_id": "n1", "position": {"x": 1, "y": 1}}):
        with pytest.raises(PinError):
            pins.add("x", graph_nodes=nodes, **kwargs)
    with pytest.raises(PinError) as exc:
        pins.add("x", node_id="n9", graph_nodes=nodes)
    assert exc.value.status == 404
    for bad in ({"x": float("nan"), "y": 0}, {"x": True, "y": 0}, {"x": 1e8, "y": 0}, {"y": 1}):
        with pytest.raises(PinError):
            pins.add("x", position=bad, graph_nodes=nodes)


def test_open_pin_cap_and_resolved_pins_are_pruned_first(tmp_path):
    store, _ = _store_with_projects(tmp_path, "One")
    pins = CanvasPins(store)
    for index in range(MAX_OPEN_PINS):
        pins.add(f"note {index}", position={"x": index, "y": 0}, graph_nodes={})
    with pytest.raises(PinError) as exc:
        pins.add("one too many", position={"x": 0, "y": 0}, graph_nodes={})
    assert exc.value.status == 409
    # Resolve them all and keep adding: past MAX_PINS the oldest resolved pin goes.
    first = pins.list()["pins"]
    oldest = min(first, key=lambda pin: pin["createdAt"])
    for pin in first:
        pins.resolve(pin["id"], "done", CODEX)
    for index in range(MAX_PINS - MAX_OPEN_PINS):
        pins.add(f"later {index}", position={"x": 0, "y": index}, graph_nodes={})
    assert len(pins.list()["pins"]) == MAX_PINS
    pins.resolve(pins.list()["pins"][0]["id"], "done", CODEX)
    pins.add("one more", position={"x": 0, "y": 0}, graph_nodes={})
    listed = pins.list()["pins"]
    assert len(listed) == MAX_PINS
    assert oldest["id"] not in {pin["id"] for pin in listed}


def test_pins_persist_across_a_reload_and_stay_with_their_project(tmp_path):
    store, (first, second) = _store_with_projects(tmp_path, "First", "Second")
    pins = CanvasPins(store)
    added = pins.add("warmer", position={"x": 1, "y": 2}, graph_nodes={})

    reloaded = CanvasPins(ProjectStore(tmp_path / "projects"))
    assert [pin["id"] for pin in reloaded.list()["pins"]] == [added["id"]]
    assert reloaded.list()["projectId"] == first

    _activate(store, second)
    reloaded.forget_cache()
    assert reloaded.list() == {"projectId": second, "pins": []}
    reloaded.add("other project", position={"x": 0, "y": 0}, graph_nodes={})
    _activate(store, first)
    reloaded.forget_cache()
    assert [pin["text"] for pin in reloaded.list()["pins"]] == ["warmer"]


def test_no_active_project_means_no_pins(tmp_path):
    store, _ = _store_with_projects(tmp_path)
    pins = CanvasPins(store)
    assert pins.list() == {"projectId": None, "pins": []}
    with pytest.raises(PinError) as exc:
        pins.add("x", position={"x": 0, "y": 0}, graph_nodes={})
    assert exc.value.status == 409


def test_resolve_detach_and_agent_view(tmp_path):
    clock = Clock()
    store, _ = _store_with_projects(tmp_path, "One")
    pins = CanvasPins(store, clock=clock)
    nodes = {"n4": {"position": {"x": 5, "y": 6}}}
    pin = pins.add("warmer", node_id="n4", graph_nodes=nodes)
    other = pins.add("later", position={"x": 0, "y": 0}, graph_nodes=nodes)
    resolved = pins.resolve(pin["id"], "Warmed  the grade\non n7", CODEX)
    assert resolved["status"] == "resolved"
    assert resolved["reply"]["text"] == "Warmed the grade on n7"
    assert resolved["reply"]["agent"]["name"] == "Codex"
    again = pins.resolve(pin["id"], "Second answer", CODEX)
    assert again["reply"]["text"] == "Second answer"
    with pytest.raises(PinError):
        pins.resolve("pin_missing", "x", CODEX)

    assert [p["id"] for p in pins.for_agents()["pins"]] == [other["id"], pin["id"]]
    clock.now += 601
    assert [p["id"] for p in pins.for_agents()["pins"]] == [other["id"]]

    detached = pins.detach_node("n4", {"x": 99, "y": 100})
    assert detached[0]["anchor"] == {"x": 99.0, "y": 100.0}
    assert detached[0]["detached"] is True and detached[0]["detachedFrom"] == "n4"
    assert pins.detach_node("n4", None) == []


# -- person gate ------------------------------------------------------------

@pytest.mark.parametrize("marker", [
    {"Authorization": "Agent whatever"},
    {"X-Daedalus-Caller": "1"},
    {"X-Nebula-Agent": "Claude Code"},
    {"X-Nebula-Client": "nebula-cli"},
])
def test_gate_refuses_agent_markers_even_with_a_browser_origin(marker):
    with pytest.raises(PersonGateError) as exc:
        require_person({**BROWSER, **marker})
    assert exc.value.status == 403


def test_gate_needs_a_browser_or_the_desktop_session(monkeypatch):
    monkeypatch.delenv("NEBULA_DESKTOP_MODE", raising=False)
    monkeypatch.delenv("NEBULA_CONNECTOR_SESSION", raising=False)
    for headers in ({}, {"Origin": "https://evil.example"}, {"Origin": "null"},
                    {"X-Nebula-Connector-Session": "s3cret"}):
        with pytest.raises(PersonGateError):
            require_person(headers)
    require_person(BROWSER)
    require_person({"origin": "file://"})
    monkeypatch.setenv("NEBULA_DESKTOP_MODE", "1")
    monkeypatch.setenv("NEBULA_CONNECTOR_SESSION", "s3cret")
    require_person({"X-Nebula-Connector-Session": "s3cret", "Origin": "null"})
    with pytest.raises(PersonGateError):
        require_person({"X-Nebula-Connector-Session": "wrong"})


# -- API ----------------------------------------------------------------------

@pytest.fixture
def api(tmp_path, monkeypatch):
    import main as main_module

    graph = CLIGraph(persist_path=tmp_path / "state.json")
    store, ids = _store_with_projects(tmp_path, "Active", "Other")
    journal = CanvasEventJournal()
    sent: list[dict] = []

    async def capture(data):
        sent.append(data)

    monkeypatch.setattr(main_module, "cli_graph", graph)
    monkeypatch.setattr(main_module, "project_store", store)
    monkeypatch.setattr(main_module, "canvas_pins", CanvasPins(lambda: main_module.project_store))
    monkeypatch.setattr(main_module, "agent_presence", AgentPresence())
    monkeypatch.setattr(main_module, "selection_context", SelectionContextStore())
    monkeypatch.setattr(main_module, "canvas_events", journal)
    monkeypatch.setattr(main_module, "provider_recovery_store", ProviderRecoveryStore(None))
    monkeypatch.setattr(main_module, "provider_start_guard", ProviderStartGuard(tmp_path / "paid-starts.json"))
    monkeypatch.setattr(main_module, "execution_runs", ExecutionRunRegistry())
    monkeypatch.setattr(main_module, "_graph_recovery_bootstrap_error", None)
    monkeypatch.setattr(main_module.manager, "broadcast_raw", capture)
    return TestClient(main_module.app), graph, journal, sent, store, ids


def _pins_messages(sent):
    return [message for message in sent if message.get("type") == "canvasPins"]


def test_person_creates_and_deletes_pins_and_agents_cannot(api):
    client, graph, journal, sent, _store, (active, _other) = api
    node = graph.add_node("text-input", {"value": "hi"}, position={"x": 40, "y": 50})
    for marker in ({"Authorization": "Agent x"}, {"X-Daedalus-Caller": "1"}, AGENT, {"X-Nebula-Client": "nebula-cli"}):
        refused = client.post("/api/canvas/pins", headers={**BROWSER, **marker}, json={"text": "x", "nodeId": node})
        # An unknown agent token is already refused (401) before the route runs.
        assert refused.status_code in {401, 403}
    assert client.post("/api/canvas/pins", json={"text": "x", "nodeId": node}).status_code == 403
    assert client.get("/api/canvas/pins").json() == {"projectId": active, "pins": []}

    created = client.post("/api/canvas/pins", headers=BROWSER, json={"text": "warmer", "nodeId": node})
    assert created.status_code == 201, created.text
    pin = created.json()["pin"]
    assert pin["anchor"] == {"nodeId": node} and pin["status"] == "open"
    assert _pins_messages(sent)[-1]["pins"][0]["id"] == pin["id"]
    assert _pins_messages(sent)[-1]["projectId"] == active

    assert client.delete(f"/api/canvas/pins/{pin['id']}", headers=AGENT).status_code == 403
    assert client.delete(f"/api/canvas/pins/{pin['id']}").status_code == 403
    assert client.delete(f"/api/canvas/pins/{pin['id']}", headers=BROWSER).json() == {"status": "deleted"}
    assert client.delete(f"/api/canvas/pins/{pin['id']}", headers=BROWSER).status_code == 404
    assert _pins_messages(sent)[-1]["pins"] == []

    events = journal.read(after=0, kinds={"pin"})["events"]
    assert [(e["kind"], e["actor"]["kind"]) for e in events] == [("pin.added", "person"), ("pin.removed", "person")]
    assert events[0]["data"]["text"] == "warmer" and events[0]["nodeId"] == node


def test_bad_pin_bodies_are_refused(api):
    client, graph, *_ = api
    node = graph.add_node("text-input", {})
    for body in ({"text": "", "nodeId": node}, {"text": "x"}, {"text": "x", "nodeId": "n99"},
                 {"text": "x" * 281, "nodeId": node}, {"text": "x", "position": {"x": "a", "y": 0}}):
        response = client.post("/api/canvas/pins", headers=BROWSER, json=body)
        assert response.status_code in {404, 422}, body


def test_agent_resolves_a_pin_and_its_cursor_moves_there(api):
    client, graph, journal, sent, *_ = api
    node = graph.add_node("text-input", {})
    pin = client.post("/api/canvas/pins", headers=BROWSER, json={"text": "warmer", "nodeId": node}).json()["pin"]
    path = f"/api/canvas/pins/{pin['id']}/resolve"
    assert client.post(path, json={"reply": "done"}).status_code == 400
    assert client.post(path, headers=BROWSER, json={"reply": "done"}).status_code == 400
    assert client.post(path, headers=AGENT, json={"reply": ""}).status_code == 422
    assert client.post("/api/canvas/pins/pin_nope/resolve", headers=AGENT, json={"reply": "x"}).status_code == 404

    resolved = client.post(path, headers=AGENT, json={"reply": "Warmed the grade on n7"})
    assert resolved.status_code == 200
    body = resolved.json()["pin"]
    assert body["status"] == "resolved" and body["reply"]["agent"]["name"] == "Claude Code"
    presence = [m for m in sent if m.get("type") == "agentPresence"]
    assert presence[-1]["target"] == {"nodeId": node}
    assert presence[-1]["action"] == "click" and presence[-1]["say"] == "Warmed the grade on n7"
    event = journal.read(after=0, kinds={"pin.resolved"})["events"][0]
    assert event["actor"]["name"] == "Claude Code" and event["data"]["reply"] == "Warmed the grade on n7"
    assert "resolved by Claude Code" in format_pin(body)


def test_deleting_a_node_detaches_its_pins_where_it_stood(api):
    client, graph, journal, sent, *_ = api
    node = graph.add_node("text-input", {}, position={"x": 300, "y": 40})
    pin = client.post("/api/canvas/pins", headers=BROWSER, json={"text": "redo", "nodeId": node}).json()["pin"]
    graph.update_positions({node: {"x": 333, "y": 44}})
    assert client.delete(f"/api/graph/node/{node}", headers=BROWSER).status_code == 200
    listed = client.get("/api/canvas/pins").json()["pins"]
    assert listed[0]["id"] == pin["id"]
    assert listed[0]["anchor"] == {"x": 333.0, "y": 44.0} and listed[0]["detached"] is True
    detached = journal.read(after=0, kinds={"pin.detached"})["events"]
    assert detached and detached[0]["data"]["pinId"] == pin["id"]
    assert _pins_messages(sent)[-1]["pins"][0]["detached"] is True


def test_import_and_clear_detach_pins_whose_nodes_are_gone(api):
    client, graph, journal, _sent, *_ = api
    keep = graph.add_node("text-input", {})
    gone = graph.add_node("text-input", {}, position={"x": 5, "y": 5})
    for node in (keep, gone):
        client.post("/api/canvas/pins", headers=BROWSER, json={"text": f"on {node}", "nodeId": node})
    imported = client.post("/api/graph/import", headers=BROWSER, json={
        "nodes": [{"id": keep, "definitionId": "text-input", "params": {}}], "edges": []})
    assert imported.status_code == 200, imported.text
    surviving = set(graph.nodes)
    by_text = {pin["text"]: pin for pin in client.get("/api/canvas/pins").json()["pins"]}
    for text, pin in by_text.items():
        node_id = text.removeprefix("on ")
        if pin["anchor"].get("nodeId") is not None:
            assert pin["anchor"]["nodeId"] in surviving
        else:
            assert pin["detached"] is True and pin["detachedFrom"] == node_id
    assert client.delete("/api/graph", headers=BROWSER).status_code == 200
    assert all(pin["detached"] for pin in client.get("/api/canvas/pins").json()["pins"])
    assert journal.read(after=0, kinds={"pin.detached"})["events"]


def test_pins_follow_the_project_switch(api):
    client, _graph, _journal, sent, store, (active, other) = api
    client.post("/api/canvas/pins", headers=BROWSER, json={"text": "first project", "position": {"x": 0, "y": 0}})
    revision = store.read()["workspaceRevision"]
    opened = client.post(f"/api/projects/{other}/open", json={"workspaceRevision": revision})
    assert opened.status_code == 200, opened.text
    assert _pins_messages(sent)[-1] == {"type": "canvasPins", "projectId": other, "pins": []}
    revision = opened.json()["workspaceRevision"]
    back = client.post(f"/api/projects/{active}/open", json={"workspaceRevision": revision})
    assert [pin["text"] for pin in _pins_messages(sent)[-1]["pins"]] == ["first project"]
    # Autosave replaces only the snapshot; the pins stay.
    saved = client.put(f"/api/projects/{active}", json={
        "workspaceRevision": back.json()["workspaceRevision"], "snapshot": {"nodes": [], "edges": []}})
    assert saved.status_code == 200, saved.text
    assert [pin["text"] for pin in client.get("/api/canvas/pins").json()["pins"]] == ["first project"]
    assert "pins" not in saved.json()["project"]


def test_snapshot_lists_pins_and_look_shows_them_before_nodes(api):
    client, graph, *_ = api
    node = graph.add_node("text-input", {})
    client.post("/api/canvas/pins", headers=BROWSER, json={"text": "warmer", "nodeId": node})
    client.post("/api/canvas/pins", headers=BROWSER, json={"text": "something here?", "position": {"x": 420, "y": -80}})
    snapshot = client.get("/api/canvas/snapshot").json()
    assert [pin["text"] for pin in snapshot["pins"]] == ["something here?", "warmer"]
    text = format_snapshot(snapshot)
    assert "PINS (2 open) — notes from the person:" in text
    assert text.index("PINS") < text.index("NODES")
    assert f'on {node}: "warmer"' in text and 'at (420,-80): "something here?"' in text


def test_websocket_sends_pins_after_graph_sync(api):
    client, graph, *_ = api
    client.post("/api/canvas/pins", headers=BROWSER, json={"text": "hello", "position": {"x": 1, "y": 1}})
    with client.websocket_connect("/ws", headers=BROWSER) as ws:
        assert ws.receive_json()["type"] == "graphSync"
        message = ws.receive_json()
    assert message["type"] == "canvasPins" and message["pins"][0]["text"] == "hello"


def test_browser_sockets_are_tracked_separately(api, monkeypatch):
    import main as main_module

    client, *_ = api
    seen: list[bool] = []
    original = main_module.manager.connect

    async def spy(websocket):
        await original(websocket)
        seen.append(main_module.manager.is_browser(websocket))

    monkeypatch.setattr(main_module.manager, "connect", spy)
    with client.websocket_connect("/ws", headers=BROWSER) as ws:
        ws.receive_json()
    with client.websocket_connect("/ws") as ws:
        ws.receive_json()
    monkeypatch.setenv("NEBULA_DESKTOP_MODE", "1")
    monkeypatch.setenv("NEBULA_CONNECTOR_SESSION", "sess")
    with client.websocket_connect("/ws?connectorSession=sess") as ws:
        ws.receive_json()
    with client.websocket_connect("/ws?connectorSession=nope") as ws:
        ws.receive_json()
    assert seen == [True, False, True, False]
    assert not main_module.manager.browser_connections


def test_broadcast_browser_skips_cli_sockets():
    import asyncio

    import main as main_module

    manager = main_module.ConnectionManager()
    browser, cli = AsyncMock(), AsyncMock()
    manager.active_connections = [browser, cli]
    manager.browser_connections = {browser}
    asyncio.run(manager.broadcast_browser({"type": "x"}))
    browser.send_text.assert_awaited_once()
    cli.send_text.assert_not_awaited()


# -- formatter, CLI, MCP ------------------------------------------------------

def test_format_event_for_pin_kinds():
    added = {"seq": 3, "kind": "pin.added", "actor": {"kind": "person"}, "summary": 'pinned "warmer" on n4',
             "data": {"pinId": "pin_8c41d2aa", "text": "warmer"}}
    assert format_event(added).startswith('[3] --:--:--  Person  pinned "warmer" on n4')
    assert "nebula pin resolve pin_8c41d2aa" in format_event(added)
    resolved = {"seq": 4, "kind": "pin.resolved", "actor": {"kind": "agent", "name": "Codex"},
                "data": {"pinId": "pin_8c41d2aa", "reply": "Done, see n7"}}
    assert format_event(resolved).endswith("Codex  answered note pin_8c41d2aa: Done, see n7")


def test_format_pin_variants():
    now = 1_760_000_000.0
    from datetime import datetime, timezone
    created = datetime.fromtimestamp(now - 720, timezone.utc).isoformat()
    assert format_pin({"id": "pin_1", "anchor": {"nodeId": "n4"}, "text": "warmer", "status": "open",
                       "createdAt": created}, now=now) == 'pin_1 on n4: "warmer" (12m ago)'
    assert format_pin({"id": "pin_2", "anchor": {"x": 420, "y": -80}, "text": "here?", "status": "open",
                       "detached": True, "detachedFrom": "n3"}) == 'pin_2 at (420,-80) (its node n3 was removed): "here?"'


class FakeClient:
    def __init__(self) -> None:
        self.calls: list[tuple] = []

    def resolve_pin(self, pin_id, reply, agent_name=None):
        self.calls.append((pin_id, reply, agent_name))
        return {"pin": {"id": pin_id, "anchor": {"nodeId": "n4"}, "text": "warmer", "status": "resolved",
                        "reply": {"agent": {"name": agent_name or "Codex"}, "text": reply}}}

    def list_pins(self):
        return {"pins": [{"id": "pin_1", "anchor": {"nodeId": "n4"}, "text": "warmer", "status": "open"}]}


def test_cli_pin_resolve_and_pins_list():
    client = FakeClient()
    out = io.StringIO()
    args = argparse.Namespace(pin_cmd="resolve", pin_id="pin_1", say="  Warmer  now ", agent_name="Codex")
    assert pins_cmd.run_pin(client, args) == 0
    assert client.calls == [("pin_1", "Warmer now", "Codex")]
    assert pins_cmd.run_resolve(client, "pin_1", say="x" * 281) == 1
    assert pins_cmd.run_resolve(client, "pin_1", say="   ") == 1
    assert pins_cmd.run_list(client, out=out) == 0
    assert 'pin_1 on n4: "warmer"' in out.getvalue()
    assert "nebula pin resolve pin_1" in out.getvalue()


def test_cli_parser_knows_pin_commands():
    from cli.__main__ import build_parser

    args = build_parser().parse_args(["pin", "resolve", "pin_1", "--say", "done", "--as", "Codex"])
    assert (args.command, args.pin_cmd, args.pin_id, args.say, args.agent_name) == ("pin", "resolve", "pin_1", "done", "Codex")
    with pytest.raises(SystemExit):
        build_parser().parse_args(["pin", "resolve", "pin_1"])  # --say is required
    assert build_parser().parse_args(["pins"]).command == "pins"


def test_mcp_resolve_pin_sends_a_named_request(monkeypatch):
    import mcp_server

    calls: list[dict] = []

    def fake_request(method, url, *, headers, timeout, **kwargs):
        calls.append({"method": method, "url": url, "headers": headers, **kwargs})
        return httpx.Response(200, json={"pin": {"id": "pin_1"}}, request=httpx.Request(method, url))

    monkeypatch.setattr(mcp_server.httpx, "request", fake_request)
    monkeypatch.delenv("NEBULA_AGENT_TOKEN", raising=False)
    monkeypatch.setenv("NEBULA_AGENT_NAME", "Claude Code")
    assert mcp_server.resolve_pin("pin_1", "Done") == {"pin": {"id": "pin_1"}}
    assert calls[0]["method"] == "POST"
    assert calls[0]["url"].endswith("/api/canvas/pins/pin_1/resolve")
    assert calls[0]["json"] == {"reply": "Done"}
    assert calls[0]["headers"]["X-Nebula-Agent"]
    assert json.dumps(calls[0]).count("Origin") == 0
