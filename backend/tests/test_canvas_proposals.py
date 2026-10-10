from __future__ import annotations

import argparse
import asyncio
import io
import json

import httpx
import pytest
from fastapi.testclient import TestClient

from cli.commands import proposals as proposals_cmd
from cli.formatter import format_event, format_proposal, format_proposal_outcome, format_snapshot
from services.agent_presence import AgentIdentity, AgentPresence
from services.canvas_events import CanvasEventJournal
from services.canvas_pins import CanvasPins
from services.canvas_proposals import (
    MAX_NODES,
    MAX_OPEN_PER_AGENT,
    PROPOSAL_TTL_SECONDS,
    ProposalBook,
    ProposalError,
    cost_for,
    parse_spec,
    place_new_nodes,
)
from services.cli_graph import CLIGraph
from services.execution_runs import ExecutionRunRegistry
from services.project_store import ProjectStore, make_project
from services.provider_recovery import ProviderRecoveryStore
from services.provider_start_guard import ProviderStartGuard
from services.selection_context import SelectionContextStore

BROWSER = {"Origin": "http://localhost:5173"}
CLAUDE = {"X-Nebula-Agent": "Claude Code"}
CODEX = {"X-Nebula-Agent": "Codex"}
KEY = "X-Nebula-Proposal-Key"


class Clock:
    def __init__(self) -> None:
        self.now = 1_760_000_000.0

    def __call__(self) -> float:
        return self.now


@pytest.fixture
def api(tmp_path, monkeypatch):
    import main as main_module

    graph = CLIGraph(persist_path=tmp_path / "state.json")
    store = ProjectStore(tmp_path / "projects")
    with store.transaction() as catalog:
        project = make_project("Active")
        catalog["projects"][project["id"]] = project
        catalog["activeProjectId"] = project["id"]
        store.commit(catalog)
    clock = Clock()
    book = ProposalBook(clock)
    journal = CanvasEventJournal()
    sent: list[dict] = []
    browser: list[dict] = []

    async def capture(data):
        sent.append(data)

    async def capture_browser(data):
        browser.append(data)

    monkeypatch.setattr(main_module, "cli_graph", graph)
    monkeypatch.setattr(main_module, "project_store", store)
    monkeypatch.setattr(main_module, "canvas_pins", CanvasPins(lambda: main_module.project_store))
    monkeypatch.setattr(main_module, "canvas_proposals", book)
    monkeypatch.setattr(main_module, "agent_presence", AgentPresence())
    monkeypatch.setattr(main_module, "selection_context", SelectionContextStore())
    monkeypatch.setattr(main_module, "canvas_events", journal)
    monkeypatch.setattr(main_module, "provider_recovery_store", ProviderRecoveryStore(None))
    monkeypatch.setattr(main_module, "provider_start_guard", ProviderStartGuard(tmp_path / "paid-starts.json"))
    monkeypatch.setattr(main_module, "execution_runs", ExecutionRunRegistry())
    monkeypatch.setattr(main_module, "_graph_recovery_bootstrap_error", None)
    monkeypatch.setattr(main_module.manager, "broadcast_raw", capture)
    monkeypatch.setattr(main_module.manager, "broadcast_browser", capture_browser)

    class Api:
        pass

    ctx = Api()
    ctx.client = TestClient(main_module.app)
    ctx.main = main_module
    ctx.graph = graph
    ctx.book = book
    ctx.clock = clock
    ctx.journal = journal
    ctx.sent = sent
    ctx.browser = browser
    ctx.project_id = project["id"]
    return ctx


def _key(api, proposal_id: str) -> str:
    """The accept key, read the way the canvas reads it: from a browser-only message."""
    for message in api.browser:
        if message.get("type") == "proposalOpened" and message["proposal"]["id"] == proposal_id:
            return message["acceptKey"]
    raise AssertionError("no proposalOpened message for the browser")


def _upscale_body(source: str = "n1") -> dict:
    return {
        "note": "Generate from the prompt",
        "nodes": [{"ref": "+img", "definitionId": "nano-banana", "params": {"aspect_ratio": "16:9"}}],
        "edges": [{"source": source, "sourceHandle": "text", "target": "+img", "targetHandle": "prompt"}],
        "run": ["+img"],
    }


def _propose(api, body, headers=CLAUDE):
    return api.client.post("/api/canvas/proposals", headers=headers, json=body)


# -- request shape ------------------------------------------------------------

def test_parse_spec_shapes_refs_and_caps():
    spec = parse_spec({
        "note": "  warmer\n please ",
        "nodes": [{"ref": "+a", "definitionId": "text-input", "position": {"x": 1, "y": 2}}],
        "edges": [{"source": "+a", "sourceHandle": "text", "target": "n4", "targetHandle": "prompt"}],
        "params": [{"nodeId": "n4", "params": {"prompt": "x"}}],
        "run": ["n4"],
    })
    assert spec.note == "warmer please"
    assert spec.references == {"n4"} and spec.refs == {"+a"}
    bad_bodies = [
        {"note": ""},
        {"note": "x"},  # nothing proposed
        {"note": "x" * 161, "run": ["n1"]},
        {"note": "x", "extra": 1, "run": ["n1"]},
        {"note": "x", "nodes": [{"ref": "up", "definitionId": "text-input"}]},
        {"note": "x", "nodes": [{"ref": "+a", "definitionId": "text-input"}] * 2},
        {"note": "x", "nodes": [{"ref": f"+n{i}", "definitionId": "text-input"} for i in range(MAX_NODES + 1)]},
        {"note": "x", "edges": [{"source": "+ghost", "sourceHandle": "a", "target": "n1", "targetHandle": "b"}]},
        {"note": "x", "edges": [{"source": "abc", "sourceHandle": "a", "target": "n1", "targetHandle": "b"}]},
        {"note": "x", "params": [{"nodeId": "n1", "params": {"_previewUrl": "x"}}]},
        {"note": "x", "params": [{"nodeId": "n1", "params": {}}]},
        {"note": "x", "run": ["+nope"]},
        {"note": "x", "run": ["n1", "n1"]},
        {"note": "x", "nodes": [{"ref": "+a", "definitionId": "text-input", "position": {"x": float("nan"), "y": 0}}]},
    ]
    for body in bad_bodies:
        with pytest.raises(ProposalError) as exc:
            parse_spec(body)
        assert exc.value.status in {400, 422}, body


def test_cost_never_has_numbers():
    assert cost_for({"apiProvider": "utility"}) == {"kind": "free", "provider": None, "label": "free · runs locally"}
    assert cost_for({"apiProvider": "fal"}) == {"kind": "paid", "provider": "fal", "label": "paid · fal"}


def test_new_nodes_land_right_of_the_rightmost_referenced_node():
    spec = parse_spec({
        "note": "x",
        "nodes": [{"ref": "+a", "definitionId": "t"}, {"ref": "+b", "definitionId": "t", "position": {"x": 5, "y": 6}},
                  {"ref": "+c", "definitionId": "t"}],
        "edges": [{"source": "n1", "sourceHandle": "o", "target": "+a", "targetHandle": "i"},
                  {"source": "n2", "sourceHandle": "o", "target": "+c", "targetHandle": "i"}],
    })
    placed = place_new_nodes(spec, {"n1": {"x": 0, "y": 0}, "n2": {"x": 500, "y": 100, "width": 280}})
    assert placed["+b"] == {"x": 5.0, "y": 6.0}
    assert placed["+a"]["x"] >= 500 + 380 and placed["+a"]["y"] == 100
    assert placed["+c"]["y"] == 100 + 260
    centred = place_new_nodes(parse_spec({"note": "x", "nodes": [{"ref": "+a", "definitionId": "t"}]}), {},
                              {"x": 0, "y": 0, "width": 1000, "height": 800})
    assert centred["+a"] == {"x": 380.0, "y": 300.0}
    # A ghost never lands on a real node: it moves right until clear.
    crowded = place_new_nodes(
        parse_spec({"note": "x", "nodes": [{"ref": "+a", "definitionId": "t"}],
                    "edges": [{"source": "n1", "sourceHandle": "o", "target": "+a", "targetHandle": "i"}]}),
        {"n1": {"x": 0, "y": 0, "width": 300, "height": 200}, "n2": {"x": 400, "y": 50, "width": 300, "height": 200}},
    )
    assert crowded["+a"] == {"x": 760.0, "y": 0.0}


# -- submit -------------------------------------------------------------------

def test_only_named_agents_propose(api):
    api.graph.add_node("text-input", {"value": "a cat"})
    assert _propose(api, _upscale_body(), headers={}).status_code == 400
    refused = _propose(api, _upscale_body(), headers=BROWSER)
    assert refused.status_code == 403 and "edit directly" in refused.json()["detail"]


def test_a_proposal_is_validated_like_direct_edits_and_changes_nothing(api):
    n1 = api.graph.add_node("text-input", {"value": "a cat"})
    n2 = api.graph.add_node("nano-banana", {})
    before = json.dumps(api.graph.get_state(), sort_keys=True)
    cases = {
        "unknown definition": {"note": "x", "nodes": [{"ref": "+a", "definitionId": "no-such-node"}]},
        "bad param key": {"note": "x", "nodes": [{"ref": "+a", "definitionId": "nano-banana", "params": {"aspectRatio": "1:1"}}]},
        "bad param on existing": {"note": "x", "params": [{"nodeId": n2, "params": {"nope": 1}}]},
        "incompatible handles": {"note": "x", "edges": [{"source": n2, "sourceHandle": "image", "target": n1, "targetHandle": "value"}]},
        "unknown port": {"note": "x", "nodes": [{"ref": "+a", "definitionId": "nano-banana"}],
                         "edges": [{"source": n1, "sourceHandle": "text", "target": "+a", "targetHandle": "nope"}]},
        "cycle": {"note": "x", "nodes": [{"ref": "+a", "definitionId": "combine-text"}, {"ref": "+b", "definitionId": "combine-text"}],
                  "edges": [{"source": "+a", "sourceHandle": "text", "target": "+b", "targetHandle": "text1"},
                            {"source": "+b", "sourceHandle": "text", "target": "+a", "targetHandle": "text1"}]},
        "unknown edge ref": {"note": "x", "edges": [{"source": "+ghost", "sourceHandle": "text", "target": n2, "targetHandle": "prompt"}]},
        "unknown run ref": {"note": "x", "run": ["+ghost"]},
        "missing node": {"note": "x", "run": ["n99"]},
        "too many runs": {"note": "x", "run": [f"n{i}" for i in range(1, 9)]},
    }
    for name, body in cases.items():
        response = _propose(api, body)
        assert response.status_code in {400, 422}, (name, response.status_code, response.text)
    assert json.dumps(api.graph.get_state(), sort_keys=True) == before
    assert api.book.open_list() == []
    assert api.browser == []


def test_submit_returns_a_view_broadcasts_the_key_to_browsers_only_and_journals(api):
    n1 = api.graph.add_node("text-input", {"value": "a cat"}, position={"x": 100, "y": 50})
    response = _propose(api, _upscale_body(n1))
    assert response.status_code == 201, response.text
    view = response.json()["proposal"]
    assert view["status"] == "open" and view["agent"]["name"] == "Claude Code"
    assert view["nodes"][0]["name"] and view["nodes"][0]["cost"]["kind"] == "paid"
    assert view["nodes"][0]["ports"]["inputs"] == [{"id": "prompt", "label": "Prompt", "dataType": "Text"}] or \
        view["nodes"][0]["ports"]["inputs"][0]["id"] == "prompt"
    assert view["nodes"][0]["position"]["x"] >= 100 + 380
    assert view["references"] == [n1]
    assert view["expiresAt"] - view["createdAt"] == PROPOSAL_TTL_SECONDS * 1000
    assert "acceptKey" not in json.dumps(view) and "accept_key" not in json.dumps(view)

    opened = [m for m in api.browser if m["type"] == "proposalOpened"]
    assert len(opened) == 1 and len(opened[0]["acceptKey"]) >= 24
    assert all(m.get("type") != "proposalOpened" for m in api.sent)
    event = api.journal.read(after=0)["events"][-1]
    assert event["kind"] == "proposal.created" and event["actor"]["name"] == "Claude Code"
    assert event["data"]["paidRuns"] == 1 and event["data"]["adds"] == 1
    # The agent's cursor moves to what it is talking about.
    presence = [m for m in api.sent if m.get("type") == "agentPresence"]
    assert presence and presence[-1]["target"] == {"nodeId": n1}


def test_cost_counts_paid_free_and_ancestors_without_outputs(api):
    n1 = api.graph.add_node("text-input", {"value": "a cat"})
    free = _propose(api, {"note": "free", "nodes": [{"ref": "+t", "definitionId": "text-input"}], "run": ["+t"]})
    cost = free.json()["proposal"]["cost"]
    assert (cost["paidRuns"], cost["freeRuns"], cost["estimate"]) == (0, 1, None)

    paid = _propose(api, _upscale_body(n1)).json()["proposal"]["cost"]
    assert paid["paidRuns"] == 1 and paid["estimate"] is None and paid["providers"] == ["google"]
    # n1 has no output yet, so it may run too: "up to".
    assert paid["upTo"] is True and {node["ref"] for node in paid["nodes"]} == {"+img", n1}
    assert "no price list" in paid["note"]

    api.graph.nodes[n1]["outputs"] = {"text": {"type": "Text", "value": "a cat"}}
    cached = _propose(api, _upscale_body(n1)).json()["proposal"]["cost"]
    assert cached["upTo"] is False and [node["ref"] for node in cached["nodes"]] == ["+img"]


def test_open_limits_and_expiry(api):
    n1 = api.graph.add_node("text-input", {"value": "a cat"})
    for _ in range(MAX_OPEN_PER_AGENT):
        assert _propose(api, _upscale_body(n1)).status_code == 201
    too_many = _propose(api, _upscale_body(n1))
    assert too_many.status_code == 429 and "withdraw or wait" in too_many.json()["detail"]
    assert _propose(api, _upscale_body(n1), headers=CODEX).status_code == 201

    api.clock.now += PROPOSAL_TTL_SECONDS + 1
    listed = api.client.get("/api/canvas/proposals").json()
    assert listed == {"proposals": []}
    expired = [e for e in api.journal.read(after=0, limit=100)["events"] if e["kind"] == "proposal.expired"]
    assert len(expired) == MAX_OPEN_PER_AGENT + 1 and expired[0]["actor"] == {"kind": "system"}
    closed = [m for m in api.sent if m.get("type") == "proposalClosed"]
    assert {m["status"] for m in closed} == {"expired"}
    # A slot is free again.
    assert _propose(api, _upscale_body(n1)).status_code == 201


def test_deleting_a_referenced_node_import_and_clear_invalidate(api):
    n1 = api.graph.add_node("text-input", {"value": "a cat"})
    n2 = api.graph.add_node("text-input", {"value": "a dog"})
    first = _propose(api, _upscale_body(n1)).json()["proposal"]["id"]
    second = _propose(api, _upscale_body(n2)).json()["proposal"]["id"]
    assert api.client.delete(f"/api/graph/node/{n1}", headers=BROWSER).status_code == 200
    assert api.book.get(first).status == "invalidated" and "was deleted" in api.book.get(first).reason
    assert api.book.get(second).status == "open"
    assert api.client.delete("/api/graph", headers=BROWSER).status_code == 200
    assert api.book.get(second).status == "invalidated" and "cleared" in api.book.get(second).reason

    n3 = api.graph.add_node("text-input", {"value": "again"})
    third = _propose(api, _upscale_body(n3)).json()["proposal"]["id"]
    imported = api.client.post("/api/graph/import", headers=BROWSER, json={"nodes": [], "edges": []})
    assert imported.status_code == 200, imported.text
    assert api.book.get(third).status == "invalidated" and "replaced" in api.book.get(third).reason
    kinds = [e["kind"] for e in api.journal.read(after=0, limit=100)["events"]]
    assert kinds.count("proposal.invalidated") == 3


# -- the accept key never reaches an agent ------------------------------------

def test_accept_key_is_absent_from_every_agent_surface(api):
    n1 = api.graph.add_node("text-input", {"value": "a cat"})
    created = _propose(api, _upscale_body(n1))
    proposal_id = created.json()["proposal"]["id"]
    key = _key(api, proposal_id)
    surfaces = [
        created.text,
        api.client.get("/api/canvas/proposals").text,
        api.client.get(f"/api/canvas/proposals/{proposal_id}").text,
        api.client.get("/api/canvas/snapshot").text,
        api.client.get("/api/canvas/events?after=0&self=1").text,
        json.dumps(api.sent),
        format_proposal(created.json()["proposal"]),
        format_snapshot(api.client.get("/api/canvas/snapshot").json()),
    ]
    for surface in surfaces:
        assert key not in surface
        assert "acceptKey" not in surface
    snapshot = api.client.get("/api/canvas/snapshot").json()
    assert snapshot["proposals"][0]["id"] == proposal_id


def test_websocket_sync_sends_keys_only_to_browser_sockets(api):
    n1 = api.graph.add_node("text-input", {"value": "a cat"})
    proposal_id = _propose(api, _upscale_body(n1)).json()["proposal"]["id"]
    key = _key(api, proposal_id)
    with api.client.websocket_connect("/ws", headers=BROWSER) as ws:
        messages = [ws.receive_json() for _ in range(3)]
    assert [m["type"] for m in messages] == ["graphSync", "canvasPins", "proposalSync"]
    assert messages[2]["proposals"][0]["id"] == proposal_id
    assert messages[2]["proposals"][0]["acceptKey"] == key

    seen: list[dict] = []
    with api.client.websocket_connect("/ws") as ws:
        seen.append(ws.receive_json())
        seen.append(ws.receive_json())
    assert [m["type"] for m in seen] == ["graphSync", "canvasPins"]
    assert key not in json.dumps(seen)


def test_real_broadcast_browser_reaches_browser_sockets_only(api, monkeypatch):
    """Without the capture stub: a live CLI socket never receives proposalOpened."""
    from main import ConnectionManager

    manager = ConnectionManager()

    class Socket:
        def __init__(self, browser: bool) -> None:
            self.browser = browser
            self.received: list[str] = []

        async def send_text(self, text: str) -> None:
            self.received.append(text)

    browser, cli = Socket(True), Socket(False)
    manager.active_connections.extend([browser, cli])
    manager.browser_connections.add(browser)
    asyncio.run(manager.broadcast_browser({"type": "proposalOpened", "acceptKey": "secret"}))
    assert browser.received and cli.received == []


# -- accept and reject: the person only -----------------------------------------

def test_accept_and_reject_security_matrix(api):
    n1 = api.graph.add_node("text-input", {"value": "a cat"})
    proposal_id = _propose(api, _upscale_body(n1)).json()["proposal"]["id"]
    key = _key(api, proposal_id)
    url = f"/api/canvas/proposals/{proposal_id}"
    for action in ("accept", "reject"):
        for marker in ({"Authorization": "Agent bogus"}, {"X-Daedalus-Caller": "1"}, CLAUDE, {"X-Nebula-Client": "nebula-cli"}):
            refused = api.client.post(f"{url}/{action}", headers={**BROWSER, **marker, KEY: key}, json={})
            # An unknown agent token is refused (401) before the route runs.
            assert refused.status_code in {401, 403}, (action, marker)
        assert api.client.post(f"{url}/{action}", headers={KEY: key}, json={}).status_code == 403
        assert api.client.post(f"{url}/{action}", headers=BROWSER, json={}).status_code == 403
        assert api.client.post(f"{url}/{action}", headers={**BROWSER, KEY: "wrong"}, json={}).status_code == 403
    assert api.book.get(proposal_id).status == "open"
    assert len(api.graph.nodes) == 1

    accepted = api.client.post(f"{url}/accept", headers={**BROWSER, KEY: key}, json={})
    assert accepted.status_code == 200, accepted.text
    again = api.client.post(f"{url}/accept", headers={**BROWSER, KEY: key}, json={})
    assert again.status_code == 409 and "accepted" in again.json()["detail"]


def test_desktop_session_header_stands_in_for_origin(api, monkeypatch):
    monkeypatch.setenv("NEBULA_DESKTOP_MODE", "1")
    monkeypatch.setenv("NEBULA_CONNECTOR_SESSION", "sess-123")
    n1 = api.graph.add_node("text-input", {"value": "a cat"})
    proposal_id = _propose(api, _upscale_body(n1)).json()["proposal"]["id"]
    key = _key(api, proposal_id)
    wrong = api.client.post(f"/api/canvas/proposals/{proposal_id}/reject",
                            headers={"X-Nebula-Connector-Session": "nope", KEY: key}, json={})
    assert wrong.status_code == 403
    ok = api.client.post(f"/api/canvas/proposals/{proposal_id}/reject",
                         headers={"X-Nebula-Connector-Session": "sess-123", KEY: key}, json={"reason": "not now"})
    assert ok.status_code == 200 and api.book.get(proposal_id).reason == "not now"


def test_accept_applies_everything_with_dragged_positions_and_never_runs(api, monkeypatch):
    def explode(*args, **kwargs):  # pragma: no cover - must never be reached
        raise AssertionError("accept must never execute")

    monkeypatch.setattr(api.main, "execute_graph", explode)
    n1 = api.graph.add_node("text-input", {"value": "a cat"}, position={"x": 0, "y": 0})
    n2 = api.graph.add_node("text-input", {"value": "old"}, position={"x": 0, "y": 200})
    body = {
        "note": "Generate and retitle",
        "nodes": [{"ref": "+img", "definitionId": "nano-banana"}, {"ref": "+t", "definitionId": "text-input",
                                                                    "params": {"value": "x"}}],
        "edges": [{"source": n1, "sourceHandle": "text", "target": "+img", "targetHandle": "prompt"}],
        "params": [{"nodeId": n2, "params": {"value": "new"}}],
        "run": ["+img"],
    }
    proposal_id = _propose(api, body).json()["proposal"]["id"]
    key = _key(api, proposal_id)
    api.sent.clear()
    response = api.client.post(
        f"/api/canvas/proposals/{proposal_id}/accept",
        headers={**BROWSER, KEY: key},
        json={"positions": {"+img": {"x": 900, "y": -40}}},
    )
    assert response.status_code == 200, response.text
    result = response.json()
    new_img, new_t = result["idMap"]["+img"], result["idMap"]["+t"]
    assert result["runNodeIds"] == [new_img]
    assert api.graph.nodes[new_img]["position"] == {"x": 900.0, "y": -40.0}
    assert api.graph.nodes[new_t]["position"] != {"x": 900.0, "y": -40.0}
    assert api.graph.nodes[n2]["params"]["value"] == "new"
    assert {edge["target"] for edge in api.graph.edges} == {new_img}
    assert {node["id"] for node in result["nodes"]} == {new_img, new_t}
    assert [edge["target"] for edge in result["edges"]] == [new_img]
    assert [node["id"] for node in result["updatedNodes"]] == [n2]
    assert result["updatedNodes"][0]["data"]["params"]["value"] == "new"

    assert api.book.get(proposal_id).status == "accepted"
    closed = [m for m in api.sent if m.get("type") == "proposalClosed"]
    assert closed[-1]["status"] == "accepted" and closed[-1]["idMap"]["+img"] == new_img
    presence = [m for m in api.sent if m.get("type") == "agentPresence"]
    assert presence[-1]["agent"]["name"] == "Claude Code" and presence[-1]["say"] == "Accepted"
    events = api.journal.read(after=0, limit=100)["events"]
    accepted = [e for e in events if e["kind"] == "proposal.accepted"][0]
    assert accepted["actor"] == {"kind": "person"} and accepted["data"]["runNodeIds"] == [new_img]
    added = [e for e in events if e["kind"] == "node.added"]
    assert {e["nodeId"] for e in added} == {new_img, new_t}
    assert all(e["actor"] == {"kind": "person"} and "accepted from Claude Code" in e["summary"] for e in added)
    assert [e for e in events if e["kind"] == "node.params"][0]["nodeId"] == n2
    assert not any(e["kind"].startswith("run.") for e in events)


def test_accept_is_all_or_nothing(api):
    n1 = api.graph.add_node("text-input", {"value": "a cat"})
    n2 = api.graph.add_node("nano-banana", {})
    n3 = api.graph.add_node("text-input", {"value": "a dog"})
    body = {
        "note": "Feed the cat prompt in",
        "nodes": [{"ref": "+t", "definitionId": "text-input"}],
        "edges": [{"source": n1, "sourceHandle": "text", "target": n2, "targetHandle": "prompt"}],
    }
    proposal_id = _propose(api, body).json()["proposal"]["id"]
    key = _key(api, proposal_id)
    # Meanwhile the person wires something else into that single input.
    wired = api.client.post("/api/graph/connect", headers=BROWSER,
                            json={"source": n3, "sourceHandle": "text", "target": n2, "targetHandle": "prompt"})
    assert wired.status_code == 200, wired.text
    before = json.dumps(api.graph.get_state(), sort_keys=True)
    response = api.client.post(f"/api/canvas/proposals/{proposal_id}/accept", headers={**BROWSER, KEY: key}, json={})
    assert response.status_code == 409 and "no longer fits" in response.json()["detail"]
    assert json.dumps(api.graph.get_state(), sort_keys=True) == before
    assert api.book.get(proposal_id).status == "invalidated"
    assert [e for e in api.journal.read(after=0, limit=100)["events"] if e["kind"] == "proposal.invalidated"]


def test_browser_gets_the_exact_values_accept_will_write(api):
    long_prompt = "a very long prompt " * 60  # past the agent sanitizer's 500 characters
    n1 = api.graph.add_node("text-input", {"value": "old"})
    body = {
        "note": "Retitle",
        "nodes": [{"ref": "+t", "definitionId": "text-input",
                   "params": {"value": "https://example.com/a.png?sig=abc"}}],
        "params": [{"nodeId": n1, "params": {"value": long_prompt}}],
    }
    proposal_id = _propose(api, body).json()["proposal"]["id"]
    opened = [m for m in api.browser if m.get("type") == "proposalOpened"][-1]
    values = opened["personValues"]
    assert values["nodes"]["+t"]["value"] == "https://example.com/a.png?sig=abc"
    assert values["params"][n1]["value"] == {"from": "old", "to": long_prompt}
    # Agents never get these values or the key.
    listed = api.client.get("/api/canvas/proposals", headers=CLAUDE).json()
    assert "personValues" not in json.dumps(listed)
    assert listed["proposals"][0]["id"] == proposal_id


def test_accept_refuses_to_overwrite_a_later_edit(api):
    n1 = api.graph.add_node("text-input", {"value": "old"})
    body = {"note": "Retitle", "params": [{"nodeId": n1, "params": {"value": "agent's"}}]}
    proposal_id = _propose(api, body).json()["proposal"]["id"]
    key = _key(api, proposal_id)
    api.graph.update_params(n1, {"value": "person's"})  # the person edits it meanwhile
    response = api.client.post(f"/api/canvas/proposals/{proposal_id}/accept", headers={**BROWSER, KEY: key}, json={})
    assert response.status_code == 409 and f"{n1}.value changed" in response.json()["detail"]
    assert api.graph.nodes[n1]["params"]["value"] == "person's"
    assert api.book.get(proposal_id).status == "invalidated"


@pytest.mark.parametrize("route", ["accept", "reject"])
def test_decision_rechecks_after_reading_the_body(api, monkeypatch, route):
    # The agent withdraws (or another tab decides) while the body is read.
    n1 = api.graph.add_node("text-input", {"value": "a cat"})
    proposal_id = _propose(api, _upscale_body(n1)).json()["proposal"]["id"]
    key = _key(api, proposal_id)
    real_body = api.main._proposal_body

    async def body_then_withdraw(request):
        body = await real_body(request)
        api.book.close(proposal_id, "withdrawn", reason="withdrawn by the agent")
        return body

    monkeypatch.setattr(api.main, "_proposal_body", body_then_withdraw)
    before = json.dumps(api.graph.get_state(), sort_keys=True)
    response = api.client.post(f"/api/canvas/proposals/{proposal_id}/{route}",
                               headers={**BROWSER, KEY: key}, json={})
    assert response.status_code == 409 and "already withdrawn" in response.json()["detail"]
    assert json.dumps(api.graph.get_state(), sort_keys=True) == before
    assert api.book.get(proposal_id).status == "withdrawn"


def test_accept_rejects_bad_positions(api):
    n1 = api.graph.add_node("text-input", {"value": "a cat"})
    proposal_id = _propose(api, _upscale_body(n1)).json()["proposal"]["id"]
    key = _key(api, proposal_id)
    for positions in ({"+nope": {"x": 1, "y": 1}}, {"+img": {"x": 1e8, "y": 0}}, {"+img": {"x": "1", "y": 0}}):
        response = api.client.post(f"/api/canvas/proposals/{proposal_id}/accept",
                                   headers={**BROWSER, KEY: key}, json={"positions": positions})
        assert response.status_code == 422, positions
    assert api.book.get(proposal_id).status == "open" and len(api.graph.nodes) == 1


def test_withdraw_is_for_the_proposing_agent_only(api):
    n1 = api.graph.add_node("text-input", {"value": "a cat"})
    proposal_id = _propose(api, _upscale_body(n1)).json()["proposal"]["id"]
    assert api.client.delete(f"/api/canvas/proposals/{proposal_id}", headers=CODEX).status_code == 403
    assert api.client.delete(f"/api/canvas/proposals/{proposal_id}").status_code == 400
    withdrawn = api.client.delete(f"/api/canvas/proposals/{proposal_id}", headers=CLAUDE)
    assert withdrawn.status_code == 200 and withdrawn.json()["proposal"]["status"] == "withdrawn"
    assert api.client.delete(f"/api/canvas/proposals/{proposal_id}", headers=CLAUDE).status_code == 409


def test_waiting_for_a_decision_returns_when_the_person_rejects(api):
    import main as main_module

    n1 = api.graph.add_node("text-input", {"value": "a cat"})
    proposal_id = _propose(api, _upscale_body(n1)).json()["proposal"]["id"]
    key = _key(api, proposal_id)

    async def scenario():
        transport = httpx.ASGITransport(app=main_module.app)
        async with httpx.AsyncClient(transport=transport, base_url="http://testserver") as http:
            async def later():
                await asyncio.sleep(0.1)
                return await http.post(f"/api/canvas/proposals/{proposal_id}/reject",
                                       headers={**BROWSER, KEY: key}, json={"reason": "too pricey"})

            task = asyncio.create_task(later())
            waited = await http.get(f"/api/canvas/proposals/{proposal_id}?wait=5", headers=CLAUDE)
            await task
            return waited, task.result()

    waited, rejected = asyncio.run(scenario())
    assert rejected.status_code == 200
    view = waited.json()["proposal"]
    assert view["status"] == "rejected" and view["reason"] == "too pricey"
    assert format_proposal_outcome(view) == 'Rejected: "too pricey"'


def test_waiting_times_out_while_open(api):
    n1 = api.graph.add_node("text-input", {"value": "a cat"})
    proposal_id = _propose(api, _upscale_body(n1)).json()["proposal"]["id"]
    view = api.client.get(f"/api/canvas/proposals/{proposal_id}?wait=0.2", headers=CLAUDE).json()["proposal"]
    assert view["status"] == "open"
    assert api.client.get("/api/canvas/proposals/p_nope").status_code == 404
    assert api.client.get(f"/api/canvas/proposals/{proposal_id}?wait=abc").status_code == 422


# -- CLI ------------------------------------------------------------------------

def test_cli_builder_turns_flags_into_a_body():
    body = proposals_cmd.build_body(
        note="Upscale it",
        add=["+up=topaz-image-upscale"],
        param=[["+up.upscale_factor=2"], ["+up.mode=x=1"]],
        set_params=["n4.prompt=warmer light"],
        wire=[["n4:image", "+up:image"]],
        run=["+up"],
        at=["+up=820,140"],
    )
    assert body == {
        "note": "Upscale it",
        "nodes": [{"ref": "+up", "definitionId": "topaz-image-upscale", "params": {"upscale_factor": "2", "mode": "x=1"},
                   "position": {"x": 820.0, "y": 140.0}}],
        "edges": [{"source": "n4", "sourceHandle": "image", "target": "+up", "targetHandle": "image"}],
        "params": [{"nodeId": "n4", "params": {"prompt": "warmer light"}}],
        "run": ["+up"],
    }
    for kwargs in ({"add": ["up=x"]}, {"param": [["+ghost.k=v"]]}, {"set_params": ["+up.k=v"]},
                   {"wire": [["n4", "+up:image"]]}, {"at": ["+up=1,2"]}):
        with pytest.raises(proposals_cmd.BuildError):
            proposals_cmd.build_body(note="x", **kwargs)


def test_documented_examples_are_real_proposals(api):
    """The MCP-SETUP builder and JSON examples must validate against node_definitions.json."""
    from pathlib import Path

    docs = (Path(__file__).resolve().parents[2] / "docs" / "MCP-SETUP.md").read_text()
    block = next(chunk for chunk in docs.split("```json")[1:] if '"definitionId"' in chunk)
    documented = json.loads(block.split("```")[0])
    built = proposals_cmd.build_body(
        note=documented["note"],
        add=["+up=topaz-image-upscale"],
        param=[["+up.upscale_factor=2"]],
        set_params=["n4.aspect_ratio=16:9"],
        wire=[["n4:image", "+up:image"]],
        run=["+up"],
    )
    for _ in range(3):
        api.graph.add_node("text-input", {"value": "x"})
    assert api.graph.add_node("nano-banana", {}) == "n4"
    for body in (documented, built):
        response = _propose(api, body)
        assert response.status_code == 201, response.text
        api.book.close(response.json()["proposal"]["id"], "withdrawn")


class FakeClient:
    def __init__(self, outcomes: list[dict]) -> None:
        self.outcomes = outcomes
        self.bodies: list[dict] = []
        self.waits: list[float] = []

    def propose(self, body, agent_name=None):
        self.bodies.append(body)
        return {"proposal": {"id": "p_1", "status": "open", "note": body["note"], "expiresAt": 0,
                             "nodes": [], "edges": [], "params": [], "run": [], "cost": {}}}

    def get_proposal(self, proposal_id, wait=0.0, agent_name=None):
        self.waits.append(wait)
        return {"proposal": self.outcomes.pop(0) if self.outcomes else {"id": proposal_id, "status": "open"}}


def _propose_args(**overrides) -> argparse.Namespace:
    values = dict(file=None, note="Do it", add=["+t=text-input"], param=[], set_params=[], wire=[], run=[],
                  at=[], wait=True, timeout=60.0, json=False, agent_name=None)
    values.update(overrides)
    return argparse.Namespace(**values)


@pytest.mark.parametrize("outcome,code", [
    ({"id": "p_1", "status": "accepted", "idMap": {"+t": "n7"}, "runNodeIds": ["n7"]}, 0),
    ({"id": "p_1", "status": "rejected", "reason": "no"}, 3),
    ({"id": "p_1", "status": "expired"}, 4),
    ({"id": "p_1", "status": "invalidated", "reason": "n4 was deleted"}, 4),
    ({"id": "p_1", "status": "withdrawn"}, 4),
])
def test_cli_propose_wait_exit_codes(outcome, code):
    client = FakeClient([outcome])
    out = io.StringIO()
    assert proposals_cmd.run_propose(client, _propose_args(), out=out) == code
    assert client.bodies[0]["nodes"][0]["ref"] == "+t"
    text = out.getvalue()
    assert "p_1" in text
    if code == 0:
        assert "Accepted by the person: +t → n7. They will run n7 from the canvas." in text


def test_cli_propose_wait_times_out():
    times = iter([0.0, 0.0, 100.0, 100.0])
    client = FakeClient([])
    out = io.StringIO()
    code = proposals_cmd.run_propose(client, _propose_args(timeout=50.0), out=out, clock=lambda: next(times))
    assert code == 2 and "No decision yet" in out.getvalue()


def test_cli_proposal_json_and_formatting():
    view = {
        "id": "p_9a1c3e02", "status": "open", "agent": {"name": "Codex"}, "note": "Upscale",
        "expiresAt": 1_000_000 + 900_000,
        "nodes": [{"ref": "+up", "name": "Topaz Upscale", "cost": {"label": "paid · fal"}, "position": {"x": 820, "y": 140}}],
        "edges": [{"source": "n4", "sourceHandle": "image", "target": "+up", "targetHandle": "image"}],
        "params": [{"nodeId": "n4", "changes": {"prompt": {"from": "a", "to": "b"}}}],
        "run": ["+up"],
        "cost": {"paidRuns": 1, "freeRuns": 0, "upTo": True, "providers": ["fal"]},
    }
    text = format_proposal(view, created=True, now_ms=1_000_000)
    assert text.splitlines() == [
        "Proposal p_9a1c3e02 is on the canvas for the person (expires in 15 min).",
        "  adds   +up  Topaz Upscale  [paid · fal]  @(820,140)",
        "  wires  n4.image → +up.image",
        "  sets   n4: prompt",
        "  runs   +up — up to 1 paid run (fal) — Nebula has no price list",
        "Check the outcome: nebula proposal p_9a1c3e02 --wait",
    ]
    event = {"seq": 3, "at": 0, "kind": "proposal.created", "actor": {"kind": "agent", "name": "Codex"},
             "data": {"proposalId": "p_9a1c3e02"}, "summary": 'proposed p_9a1c3e02: "Upscale"'}
    assert "nebula proposal p_9a1c3e02 --wait" in format_event(event)
    expired = {"seq": 4, "at": 0, "kind": "proposal.expired", "actor": {"kind": "system"},
               "data": {"proposalId": "p_1"}, "summary": "expired"}
    assert "Nebula" in format_event(expired)
    snapshot = {"view": {}, "nodes": [], "proposals": [{"id": "p_1", "agent": "Codex", "note": "Upscale",
                                                         "status": "open", "expiresInSeconds": 600}]}
    assert 'p_1 by Codex: "Upscale" (expires in 10 min)' in format_snapshot(snapshot)


def test_cli_has_no_accept_or_reject_command():
    from cli.__main__ import build_parser

    parser = build_parser()
    with pytest.raises(SystemExit):
        parser.parse_args(["accept", "p_1"])
    args = parser.parse_args(["proposal", "accept", "p_1"])
    out = io.StringIO()
    assert proposals_cmd.run_proposal(FakeClient([]), args, out=out) == 1


# -- MCP ------------------------------------------------------------------------

def test_mcp_propose_and_wait_send_named_requests(monkeypatch):
    import mcp_server

    calls: list[dict] = []
    statuses = iter(["open", "accepted"])

    def fake_request(method, url, *, headers, timeout, **kwargs):
        calls.append({"method": method, "url": url, "headers": headers, "timeout": timeout, **kwargs})
        if method == "POST":
            payload = {"proposal": {"id": "p_1", "status": "open"}}
        else:
            payload = {"proposal": {"id": "p_1", "status": next(statuses)}}
        return httpx.Response(200, json=payload, request=httpx.Request(method, url))

    monkeypatch.setattr(mcp_server.httpx, "request", fake_request)
    monkeypatch.delenv("NEBULA_AGENT_TOKEN", raising=False)
    monkeypatch.setenv("NEBULA_AGENT_NAME", "Claude Code")
    created = mcp_server.propose_change("Upscale", nodes=[{"ref": "+up", "definitionId": "x"}], run=["+up"])
    assert created["proposal"]["id"] == "p_1"
    assert calls[0]["method"] == "POST" and calls[0]["url"].endswith("/api/canvas/proposals")
    assert calls[0]["headers"]["X-Nebula-Agent"] == "Claude Code"
    assert calls[0]["json"] == {"note": "Upscale", "nodes": [{"ref": "+up", "definitionId": "x"}], "run": ["+up"]}

    decided = mcp_server.get_proposal("p_1", wait_seconds=60)
    assert decided["proposal"]["status"] == "accepted"
    gets = [call for call in calls if call["method"] == "GET"]
    assert len(gets) == 2 and all(call["params"]["wait"] <= 25 for call in gets)
    assert all(call["timeout"] >= call["params"]["wait"] for call in gets)
    assert not any(name in dir(mcp_server) for name in ("accept_proposal", "reject_proposal"))
    assert "agents cannot accept" in mcp_server.mcp.instructions
