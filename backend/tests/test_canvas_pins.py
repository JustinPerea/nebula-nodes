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
from tests.conftest import FORGED_ORIGIN, PERSON, PERSON_HELLO

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
    {"X-Nebula-Agent": "Claude Code"},
    {"X-Nebula-Client": "nebula-cli"},
])
def test_gate_refuses_agent_markers_even_with_the_person_token(person, marker):
    with pytest.raises(PersonGateError) as exc:
        require_person({**PERSON, **marker})
    assert exc.value.status == 403 and exc.value.code == "agent_refused"


def test_gate_needs_this_launchs_person_token(person, monkeypatch):
    monkeypatch.delenv("NEBULA_DESKTOP_MODE", raising=False)
    # An Origin proves nothing: a forged browser Origin, file://, null, the
    # old desktop nonce, or a wrong token are all refused.
    monkeypatch.setenv("NEBULA_CONNECTOR_SESSION", "s3cret")
    for headers in ({}, {"Origin": "https://evil.example"}, {"Origin": "null"}, FORGED_ORIGIN,
                    {"origin": "file://"}, {"X-Nebula-Connector-Session": "s3cret", "Origin": "null"},
                    {**FORGED_ORIGIN, "X-Nebula-Person": "x" * 43}, {"X-Nebula-Person": ""}):
        with pytest.raises(PersonGateError) as exc:
            require_person(headers)
        assert exc.value.code == "person_required"
    monkeypatch.setenv("NEBULA_DESKTOP_MODE", "1")
    with pytest.raises(PersonGateError):
        require_person({"origin": "file://"})
    require_person(PERSON)
    require_person({"x-nebula-person": PERSON["X-Nebula-Person"]})


def test_gate_fails_closed_without_a_person_session(fresh_person_session):
    for headers in (PERSON, FORGED_ORIGIN, {}):
        with pytest.raises(PersonGateError):
            require_person(headers)


# -- API ----------------------------------------------------------------------

@pytest.fixture
def api(tmp_path, monkeypatch, person):
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
    for marker in ({"Authorization": "Agent x"}, AGENT, {"X-Nebula-Client": "nebula-cli"}):
        refused = client.post("/api/canvas/pins", headers={**PERSON, **marker}, json={"text": "x", "nodeId": node})
        # An unknown agent token is already refused (401) before the route runs.
        assert refused.status_code in {401, 403}
    assert client.post("/api/canvas/pins", json={"text": "x", "nodeId": node}).status_code == 403
    forged = client.post("/api/canvas/pins", headers=FORGED_ORIGIN, json={"text": "x", "nodeId": node})
    assert forged.status_code == 403 and forged.json()["code"] == "person_required"
    assert client.get("/api/canvas/pins").json() == {"projectId": active, "pins": []}

    created = client.post("/api/canvas/pins", headers=PERSON, json={"text": "warmer", "nodeId": node})
    assert created.status_code == 201, created.text
    pin = created.json()["pin"]
    assert pin["anchor"] == {"nodeId": node} and pin["status"] == "open"
    assert _pins_messages(sent)[-1]["pins"][0]["id"] == pin["id"]
    assert _pins_messages(sent)[-1]["projectId"] == active

    assert client.delete(f"/api/canvas/pins/{pin['id']}", headers=AGENT).status_code == 403
    assert client.delete(f"/api/canvas/pins/{pin['id']}").status_code == 403
    assert client.delete(f"/api/canvas/pins/{pin['id']}", headers=FORGED_ORIGIN).status_code == 403
    assert client.delete(f"/api/canvas/pins/{pin['id']}", headers=PERSON).json() == {"status": "deleted"}
    assert client.delete(f"/api/canvas/pins/{pin['id']}", headers=PERSON).status_code == 404
    assert _pins_messages(sent)[-1]["pins"] == []

    events = journal.read(after=0, kinds={"pin"})["events"]
    assert [(e["kind"], e["actor"]["kind"]) for e in events] == [("pin.added", "person"), ("pin.removed", "person")]
    assert events[0]["data"]["text"] == "warmer" and events[0]["nodeId"] == node


def test_bad_pin_bodies_are_refused(api):
    client, graph, *_ = api
    node = graph.add_node("text-input", {})
    for body in ({"text": "", "nodeId": node}, {"text": "x"}, {"text": "x", "nodeId": "n99"},
                 {"text": "x" * 281, "nodeId": node}, {"text": "x", "position": {"x": "a", "y": 0}}):
        response = client.post("/api/canvas/pins", headers=PERSON, json=body)
        assert response.status_code in {404, 422}, body


def test_agent_resolves_a_pin_and_its_cursor_moves_there(api):
    client, graph, journal, sent, *_ = api
    node = graph.add_node("text-input", {})
    pin = client.post("/api/canvas/pins", headers=PERSON, json={"text": "warmer", "nodeId": node}).json()["pin"]
    path = f"/api/canvas/pins/{pin['id']}/resolve"
    assert client.post(path, json={"reply": "done"}).status_code == 400
    assert client.post(path, headers=PERSON, json={"reply": "done"}).status_code == 400
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
    pin = client.post("/api/canvas/pins", headers=PERSON, json={"text": "redo", "nodeId": node}).json()["pin"]
    graph.update_positions({node: {"x": 333, "y": 44}})
    assert client.delete(f"/api/graph/node/{node}", headers=PERSON).status_code == 200
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
        client.post("/api/canvas/pins", headers=PERSON, json={"text": f"on {node}", "nodeId": node})
    imported = client.post("/api/graph/import", headers=PERSON, json={
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
    assert client.delete("/api/graph?force=true", headers=PERSON).status_code == 200
    assert all(pin["detached"] for pin in client.get("/api/canvas/pins").json()["pins"])
    assert journal.read(after=0, kinds={"pin.detached"})["events"]


def test_pins_follow_the_project_switch(api):
    client, _graph, _journal, sent, store, (active, other) = api
    client.post("/api/canvas/pins", headers=PERSON, json={"text": "first project", "position": {"x": 0, "y": 0}})
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
    client.post("/api/canvas/pins", headers=PERSON, json={"text": "warmer", "nodeId": node})
    client.post("/api/canvas/pins", headers=PERSON, json={"text": "something here?", "position": {"x": 420, "y": -80}})
    snapshot = client.get("/api/canvas/snapshot").json()
    assert [pin["text"] for pin in snapshot["pins"]] == ["something here?", "warmer"]
    text = format_snapshot(snapshot)
    assert "PINS (2 open) — notes from the person:" in text
    assert text.index("PINS") < text.index("NODES")
    assert f'on {node}: "warmer"' in text and 'at (420,-80): "something here?"' in text


def test_websocket_sends_pins_after_graph_sync(api):
    client, graph, *_ = api
    client.post("/api/canvas/pins", headers=PERSON, json={"text": "hello", "position": {"x": 1, "y": 1}})
    with client.websocket_connect("/ws", headers=PERSON) as ws:
        assert ws.receive_json()["type"] == "graphSync"
        message = ws.receive_json()
    assert message["type"] == "canvasPins" and message["pins"][0]["text"] == "hello"


def test_only_a_person_hello_makes_a_browser_socket(api, monkeypatch):
    import main as main_module

    client, *_ = api
    sockets: list = []
    original = main_module.manager.connect

    async def spy(websocket):
        await original(websocket)
        sockets.append(websocket)

    def receive_until_closed_or(ws, kind):
        message = ws.receive_json()
        while message["type"] != kind:
            message = ws.receive_json()
        return message

    monkeypatch.setattr(main_module.manager, "connect", spy)
    # A forged Origin, a socket with no hello, and the old desktop query
    # parameter are not the person; a wrong token gets personRequired.
    monkeypatch.setenv("NEBULA_DESKTOP_MODE", "1")
    monkeypatch.setenv("NEBULA_CONNECTOR_SESSION", "sess")
    for path, headers in (("/ws", FORGED_ORIGIN), ("/ws", {}), ("/ws?connectorSession=sess", {})):
        with client.websocket_connect(path, headers=headers) as ws:
            ws.receive_json()
            ws.send_json({"type": "hello", "personToken": "wrong"})
            assert receive_until_closed_or(ws, "personRequired")["type"] == "personRequired"
            assert not main_module.manager.is_browser(sockets[-1])
    # An agent-marked handshake never qualifies, even with the token.
    with client.websocket_connect("/ws", headers={**FORGED_ORIGIN, "X-Nebula-Agent": "Codex"}) as ws:
        ws.receive_json()
        ws.send_json(PERSON_HELLO)
        assert receive_until_closed_or(ws, "personRequired")["type"] == "personRequired"
        assert not main_module.manager.is_browser(sockets[-1])
    with client.websocket_connect("/ws", headers=FORGED_ORIGIN) as ws:
        ws.receive_json()
        ws.send_json(PERSON_HELLO)
        assert receive_until_closed_or(ws, "proposalSync")["type"] == "proposalSync"
        assert main_module.manager.is_browser(sockets[-1])
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


# -- Review 4 of PR #114: the listing names the project open at that moment ---------
# The pins cache was cleared only at the end of _broadcast_graph_sync, so a
# GET /api/canvas/pins landing while a switch awaited its export and
# broadcast answered with the old project's pins (its pin still open), and
# the --channel listener confirmed that pin. The cache now holds only while
# catalog.json is the file it was read from: every commit, by any route or
# process, replaces it.

def _listing_mid_switch(monkeypatch, store, journal) -> dict:
    """GET /api/canvas/pins as it answers while a switch awaits its export
    and broadcast: the catalog already names the new project, canvas.replaced
    isn't journaled yet."""
    import main as main_module

    seen: dict = {}
    original = main_module._broadcast_graph_sync

    async def spy(**kwargs):
        if kwargs.get("graph_replaced"):
            seen["listing"] = await main_module.list_canvas_pins()
            seen["active"] = store.read()["activeProjectId"]
            seen["journaled"] = bool(journal.read(after=0, kinds={"canvas.replaced"})["events"])
        return await original(**kwargs)

    monkeypatch.setattr(main_module, "_broadcast_graph_sync", spy)
    return seen


@pytest.mark.parametrize("path", ["open", "create", "delete-open"])
def test_the_pins_listing_names_the_open_project_all_through_a_switch(api, monkeypatch, path):
    import mcp_channel

    client, _graph, journal, _sent, store, (active, other) = api
    made = client.post("/api/canvas/pins", headers=PERSON,
                       json={"text": "make it say hello", "position": {"x": 0, "y": 0}})
    assert made.status_code == 201, made.text
    pin_id = made.json()["pin"]["id"]
    assert client.get("/api/canvas/pins").json()["pins"][0]["status"] == "open"  # read, so cached
    seen = _listing_mid_switch(monkeypatch, store, journal)
    revision = store.read()["workspaceRevision"]
    if path == "open":
        answer = client.post(f"/api/projects/{other}/open", json={"workspaceRevision": revision})
    elif path == "create":
        answer = client.post("/api/projects", json={"workspaceRevision": revision, "name": "Third"})
    else:
        answer = client.request("DELETE", f"/api/projects/{active}", json={"workspaceRevision": revision})
    assert answer.status_code == 200, answer.text
    now_open = store.read()["activeProjectId"]
    assert now_open != active and seen["active"] == now_open and not seen["journaled"]
    assert seen["listing"]["projectId"] == now_open
    assert pin_id not in {pin["id"] for pin in seen["listing"]["pins"]}

    # The --channel listener with that pin waiting and a held edit: the
    # check answered mid-switch confirms nothing, so the batch goes gated.
    state = mcp_channel.ChannelState(now=0.0)
    state.observe({"journal": "j", "cursor": 2, "projectId": active, "events": [
        {"seq": 1, "kind": "pin.added", "actor": {"kind": "person"}, "projectId": active, "summary": "",
         "data": {"pinId": pin_id, "text": "make it say hello", "anchor": {"x": 0, "y": 0}}},
        {"seq": 2, "kind": "node.params", "actor": {"kind": "person"}, "projectId": active, "nodeId": "n8",
         "data": {"keys": ["prompt"]}, "summary": "set prompt on n8"}]}, now=100.0)
    checked = state.pins_to_check(110.0)
    assert checked == [pin_id]
    state.confirm_pins(checked, seen["listing"])
    push = state.take_push(110.0)
    assert push is not None and push.gate and push.wake != "pin" and "<pin" not in push.content


def test_a_recovered_canvas_shows_in_the_pins_listing_at_once(api):
    # GET /api/projects files a live canvas with no catalog project as
    # "Recovered canvas" and opens it, with no graph broadcast: nothing
    # cleared the cache there.
    client, graph, _journal, _sent, store, _ids = api
    with store.transaction() as catalog:
        catalog["projects"] = {}
        catalog["activeProjectId"] = None
        store.commit(catalog)
    graph.add_node("text-input", {"value": "hi"}, position={"x": 0, "y": 0})
    assert client.get("/api/canvas/pins").json() == {"projectId": None, "pins": []}
    listing = client.get("/api/projects").json()
    recovered = listing["migratedProjectId"]
    assert listing["activeProjectId"] == recovered
    assert client.get("/api/canvas/pins").json() == {"projectId": recovered, "pins": []}


def test_any_commit_to_the_catalog_shows_in_the_next_listing(tmp_path):
    # Another writer (a second process, or a route that never clears the
    # cache) switches the project, then changes its pins.
    store, (first, second) = _store_with_projects(tmp_path, "First", "Second")
    pins = CanvasPins(store)
    pins.add("warmer", position={"x": 1, "y": 2}, graph_nodes={})
    assert pins.list()["projectId"] == first
    elsewhere = ProjectStore(tmp_path / "projects")
    _activate(elsewhere, second)
    assert pins.list() == {"projectId": second, "pins": []}
    other = CanvasPins(elsewhere)
    added = other.add("cooler", position={"x": 0, "y": 0}, graph_nodes={})
    assert [(pin["id"], pin["status"]) for pin in pins.list()["pins"]] == [(added["id"], "open")]
    other.resolve(added["id"], "done", CODEX)
    assert [pin["status"] for pin in pins.list()["pins"]] == ["resolved"]
    other.remove(added["id"])
    assert pins.list()["pins"] == []
    _activate(elsewhere, first)
    assert [pin["text"] for pin in pins.list()["pins"]] == ["warmer"]
