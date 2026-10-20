from __future__ import annotations

import argparse
import copy
import asyncio
import io
import json

import httpx
import pytest
from fastapi.testclient import TestClient

from cli.commands import proposals as proposals_cmd
from cli.formatter import format_event, format_proposal, format_proposal_outcome, format_snapshot
from services import model_pricing
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
from services.run_approvals import APPROVAL_TTL_SECONDS, RunApprovals
from services.selection_context import SelectionContextStore
from tests.conftest import FORGED_ORIGIN, PERSON, PERSON_HELLO

CLAUDE = {"X-Nebula-Agent": "Claude Code"}
CODEX = {"X-Nebula-Agent": "Codex"}
KEY = "X-Nebula-Proposal-Key"


class Clock:
    def __init__(self) -> None:
        self.now = 1_760_000_000.0

    def __call__(self) -> float:
        return self.now


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
    approvals = RunApprovals(clock)
    monkeypatch.setattr(main_module, "run_approvals", approvals)
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
    ctx.approvals = approvals
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
    # A local node whose mode calls a vision model is paid, with no list price.
    import json
    from pathlib import Path
    qc = json.loads((Path(__file__).resolve().parent.parent / "data" / "node_definitions.json").read_text())["qc-frame-review"]
    assert cost_for(qc, {"mode": "vision-llm"}) == {
        "kind": "paid", "provider": "vision", "label": "paid · vision model, no list price"}
    assert cost_for(qc, {"mode": ""})["kind"] == "paid"
    assert cost_for(qc, {"mode": "heuristic"}) == cost_for(qc, {}) == {
        "kind": "free", "provider": None, "label": "free · runs locally"}


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
    refused = _propose(api, _upscale_body(), headers=PERSON)
    assert refused.status_code == 403 and "edit directly" in refused.json()["detail"]
    # A forged Origin is not the person; it still has to name itself.
    assert _propose(api, _upscale_body(), headers=FORGED_ORIGIN).status_code == 400


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
    assert paid["paidRuns"] == 1 and paid["providers"] == ["google"]
    # Nano Banana's default (3.1 Flash Image at 1K) has a list price.
    import main as main_module
    expected = model_pricing.estimate_node(
        model_pricing.load_pricing()["nodes"]["nano-banana"],
        main_module.node_registry.get_all()["nano-banana"], {"aspect_ratio": "16:9"})
    assert paid["estimate"] == {"currency": "usd", "low": expected["low"], "high": expected["high"],
                                "open": False, "unpriced": [], "plan": [], "plus": []}
    assert {node["ref"]: node["price"] for node in paid["nodes"]}["+img"] == {
        "low": expected["low"], "high": expected["high"]}
    # n1 has no output yet, so it may run too: "up to".
    assert paid["upTo"] is True and {node["ref"] for node in paid["nodes"]} == {"+img", n1}
    assert "list prices" in paid["note"]

    api.graph.nodes[n1]["outputs"] = {"text": {"type": "Text", "value": "a cat"}}
    cached = _propose(api, _upscale_body(n1)).json()["proposal"]["cost"]
    assert cached["upTo"] is False and [node["ref"] for node in cached["nodes"]] == ["+img"]


def test_a_proposal_names_the_run_nodes_that_cannot_run_here(api, monkeypatch):
    """A missing key shows before Accept: in the cost the canvas draws from,
    and as a warning the agent gets back, in find_nodes' words."""
    keys: dict = {}
    monkeypatch.setattr(api.main, "load_settings", lambda: {"apiKeys": dict(keys)})
    n1 = api.graph.add_node("text-input", {"value": "a dune"})
    body = {"note": "Hero shot", "nodes": [{"ref": "+img", "definitionId": "gpt-image-2-generate"}],
            "edges": [{"source": n1, "sourceHandle": "text", "target": "+img", "targetHandle": "prompt"}],
            "run": ["+img"]}
    response = _propose(api, body).json()
    cost = response["proposal"]["cost"]
    need = "needs OPENAI_API_KEY in Settings > Providers"
    assert cost["notReady"] == [{"ref": "+img", "nodeId": None, "name": "GPT Image 2", "missing": need}]
    assert {node["ref"]: node.get("missing") for node in cost["nodes"]} == {"+img": need, n1: None}
    assert response["warning"] == (
        "If the person accepts, the run fails: 1 node can't run here as set up. "
        f"+img (GPT Image 2) {need}. Tell the person what to set up, or propose a node that runs here "
        "(find_nodes lists them).")
    # The person's canvas gets the same cost, so the bar can say it too.
    opened = [m for m in api.browser if m["type"] == "proposalOpened"][-1]
    assert opened["proposal"]["cost"]["notReady"] == cost["notReady"]
    assert "can't  +img  GPT Image 2: " + need in format_proposal(response["proposal"])

    keys["OPENAI_API_KEY"] = "sk-test"
    ready = _propose(api, body).json()
    assert ready["proposal"]["cost"]["notReady"] == [] and "warning" not in ready
    nothing_runs = _propose(api, {**body, "run": []}).json()
    assert nothing_runs["proposal"]["cost"]["notReady"] == [] and "warning" not in nothing_runs


def test_a_vision_llm_qc_run_is_paid_and_unpriced_on_the_card_and_in_the_view(api):
    body = {"note": "check the loop", "nodes": [{"ref": "+qc", "definitionId": "qc-loop-safety",
                                                  "params": {"mode": "vision-llm"}}], "run": ["+qc"]}
    view = _propose(api, body).json()["proposal"]
    assert view["nodes"][0]["cost"]["kind"] == "paid"
    cost = view["cost"]
    assert cost["paidRuns"] == 1 and cost["nodes"][0]["kind"] == "paid" and cost["nodes"][0]["price"] is None
    local = _propose(api, {**body, "nodes": [{**body["nodes"][0], "params": {"mode": "heuristic"}}]}).json()
    assert local["proposal"]["cost"]["paidRuns"] == 0
    assert local["proposal"]["nodes"][0]["cost"]["kind"] == "free"


def test_a_wired_krea_kling_multi_prompt_leaves_the_estimate_open(api):
    n1 = api.graph.add_node("text-input", {"value": '[{"prompt": "a", "duration": 10}]'})
    n1_out = {"text": {"type": "Text", "value": "x"}}
    api.graph.nodes[n1]["outputs"] = n1_out
    body = {"note": "multi-shot", "nodes": [{"ref": "+k", "definitionId": "krea-video-kling-kling-3-0",
                                              "params": {"prompt": "a", "mode": "std", "duration": 5}}],
            "edges": [{"source": n1, "sourceHandle": "text", "target": "+k", "targetHandle": "multi_prompt"}],
            "run": ["+k"]}
    cost = _propose(api, body).json()["proposal"]["cost"]
    assert cost["estimate"] is None or "+k" in cost["estimate"]["unpriced"]
    assert {node["ref"]: node["price"] for node in cost["nodes"]}["+k"] is None
    unwired = _propose(api, {**body, "edges": []}).json()["proposal"]["cost"]
    assert {node["ref"]: node["price"] for node in unwired["nodes"]}["+k"] == {"low": 0.42, "high": 0.42}


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
    assert api.client.delete(f"/api/graph/node/{n1}", headers=PERSON).status_code == 200
    assert api.book.get(first).status == "invalidated" and "was deleted" in api.book.get(first).reason
    assert api.book.get(second).status == "open"
    assert api.client.delete("/api/graph?force=true", headers=PERSON).status_code == 200
    assert api.book.get(second).status == "invalidated" and "cleared" in api.book.get(second).reason

    n3 = api.graph.add_node("text-input", {"value": "again"})
    third = _propose(api, _upscale_body(n3)).json()["proposal"]["id"]
    imported = api.client.post("/api/graph/import", headers=PERSON, json={"nodes": [], "edges": []})
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


def test_websocket_sync_sends_keys_only_after_a_person_hello(api):
    n1 = api.graph.add_node("text-input", {"value": "a cat"})
    proposal_id = _propose(api, _upscale_body(n1)).json()["proposal"]["id"]
    key = _key(api, proposal_id)
    with api.client.websocket_connect("/ws", headers=FORGED_ORIGIN) as ws:
        messages = [ws.receive_json() for _ in range(2)]
        ws.send_json(PERSON_HELLO)
        messages.append(ws.receive_json())
    assert [m["type"] for m in messages] == ["graphSync", "canvasPins", "proposalSync"]
    assert messages[2]["proposals"][0]["id"] == proposal_id
    assert messages[2]["proposals"][0]["acceptKey"] == key

    # A forged Origin, no hello, or a wrong token never get the key.
    for headers, hello in ((FORGED_ORIGIN, None), ({}, None), (FORGED_ORIGIN, {"type": "hello", "personToken": "x" * 43})):
        seen: list[dict] = []
        with api.client.websocket_connect("/ws", headers=headers) as ws:
            seen.append(ws.receive_json())
            seen.append(ws.receive_json())
            if hello is not None:
                ws.send_json(hello)
                seen.append(ws.receive_json())
        assert [m["type"] for m in seen][:2] == ["graphSync", "canvasPins"]
        assert "proposalSync" not in [m["type"] for m in seen]
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
        for marker in ({"Authorization": "Agent bogus"}, CLAUDE, {"X-Nebula-Client": "nebula-cli"}):
            refused = api.client.post(f"{url}/{action}", headers={**PERSON, **marker, KEY: key}, json={})
            # An unknown agent token is refused (401) before the route runs.
            assert refused.status_code in {401, 403}, (action, marker)
        assert api.client.post(f"{url}/{action}", headers={KEY: key}, json={}).status_code == 403
        # A forged Origin with the right key is not the person.
        assert api.client.post(f"{url}/{action}", headers={**FORGED_ORIGIN, KEY: key}, json={}).status_code == 403
        assert api.client.post(f"{url}/{action}", headers=PERSON, json={}).status_code == 403
        assert api.client.post(f"{url}/{action}", headers={**PERSON, KEY: "wrong"}, json={}).status_code == 403
    assert api.book.get(proposal_id).status == "open"
    assert len(api.graph.nodes) == 1

    accepted = api.client.post(f"{url}/accept", headers={**PERSON, KEY: key}, json={})
    assert accepted.status_code == 200, accepted.text
    again = api.client.post(f"{url}/accept", headers={**PERSON, KEY: key}, json={})
    assert again.status_code == 409 and "accepted" in again.json()["detail"]


def test_the_person_token_works_without_an_origin_and_the_old_nonce_does_not(api, monkeypatch):
    # The packaged renderer's Origin is opaque; the person token is the proof.
    monkeypatch.setenv("NEBULA_DESKTOP_MODE", "1")
    monkeypatch.setenv("NEBULA_CONNECTOR_SESSION", "sess-123")
    n1 = api.graph.add_node("text-input", {"value": "a cat"})
    proposal_id = _propose(api, _upscale_body(n1)).json()["proposal"]["id"]
    key = _key(api, proposal_id)
    old = api.client.post(f"/api/canvas/proposals/{proposal_id}/reject",
                          headers={"X-Nebula-Connector-Session": "sess-123", KEY: key}, json={})
    assert old.status_code == 403
    ok = api.client.post(f"/api/canvas/proposals/{proposal_id}/reject",
                         headers={"X-Nebula-Person": PERSON["X-Nebula-Person"], KEY: key}, json={"reason": "not now"})
    assert ok.status_code == 200 and api.book.get(proposal_id).reason == "not now"


def test_a_krea_billing_switch_goes_through_a_proposal(api):
    """Direct edits can't change _kreaAuth (tests/test_graph_apply.py); a
    proposal can ask, and the person's Accept applies it."""
    node_id = api.graph.add_node("krea-2-generate", {"_kreaAuth": "api-token"})
    bad = _propose(api, {"note": "Bill it to the plan", "params": [{"nodeId": node_id, "params": {"_kreaAuth": "free"}}]})
    assert bad.status_code == 400 and "api-token, mcp" in bad.json()["detail"]
    body = {"note": "Bill it to the plan", "params": [{"nodeId": node_id, "params": {"_kreaAuth": "mcp"}}],
            "nodes": [{"ref": "+k", "definitionId": "krea-2-generate", "params": {"_kreaAuth": "mcp"}}]}
    created = _propose(api, body)
    assert created.status_code == 201, created.text
    assert api.graph.nodes[node_id]["params"]["_kreaAuth"] == "api-token"
    proposal_id = created.json()["proposal"]["id"]
    accepted = api.client.post(f"/api/canvas/proposals/{proposal_id}/accept",
                               headers={**PERSON, KEY: _key(api, proposal_id)}, json={})
    assert accepted.status_code == 200, accepted.text
    assert api.graph.nodes[node_id]["params"]["_kreaAuth"] == "mcp"
    assert api.graph.nodes[accepted.json()["idMap"]["+k"]]["params"]["_kreaAuth"] == "mcp"
    # Other underscore params still can't be proposed.
    internal = _propose(api, {"note": "x", "params": [{"nodeId": node_id, "params": {"_previewUrl": "x"}}]})
    assert internal.status_code == 422


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
        headers={**PERSON, KEY: key},
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
    wired = api.client.post("/api/graph/connect", headers=PERSON,
                            json={"source": n3, "sourceHandle": "text", "target": n2, "targetHandle": "prompt"})
    assert wired.status_code == 200, wired.text
    before = json.dumps(api.graph.get_state(), sort_keys=True)
    response = api.client.post(f"/api/canvas/proposals/{proposal_id}/accept", headers={**PERSON, KEY: key}, json={})
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
    response = api.client.post(f"/api/canvas/proposals/{proposal_id}/accept", headers={**PERSON, KEY: key}, json={})
    assert response.status_code == 409 and f"{n1}.value changed" in response.json()["detail"]
    assert api.graph.nodes[n1]["params"]["value"] == "person's"
    assert api.book.get(proposal_id).status == "invalidated"


# -- what Accept approved is what runs ---------------------------------------------

CHEAP = {"model": "gemini-3.1-flash-lite-image"}
DEAR = {"model": "gemini-3-pro-image", "imageSize": "4K"}


@pytest.fixture
def runs(api, monkeypatch):
    """The canvas's run path without providers: records what would have run."""
    started: list[list[str]] = []

    async def fake_execute_graph(*, nodes, **kwargs):
        started.append(sorted(node.id for node in nodes))

    monkeypatch.setattr(api.main, "execute_graph", fake_execute_graph)
    monkeypatch.setattr(api.main, "validate_graph", lambda *args, **kwargs: [])
    return started


def _accept_cheap_image(api) -> tuple[str, str, dict]:
    """Claude proposes a cheap image from n1's prompt; the person accepts it."""
    n1 = api.graph.add_node("text-input", {"value": "a cat"}, position={"x": 0, "y": 0})
    body = {
        "note": "cheap image",
        "nodes": [{"ref": "+img", "definitionId": "nano-banana", "params": dict(CHEAP)}],
        "edges": [{"source": n1, "sourceHandle": "text", "target": "+img", "targetHandle": "prompt"}],
        "run": ["+img"],
    }
    proposal_id = _propose(api, body).json()["proposal"]["id"]
    accepted = api.client.post(f"/api/canvas/proposals/{proposal_id}/accept",
                               headers={**PERSON, KEY: _key(api, proposal_id)}, json={})
    assert accepted.status_code == 200, accepted.text
    result = accepted.json()
    return n1, result["runNodeIds"][0], result


def _graph_state(api) -> dict:
    return {"nodes": copy.deepcopy(api.graph.nodes), "edges": copy.deepcopy(api.graph.edges)}


def _canvas_run(api, target: str, approval_id: str | None, headers=PERSON, *, graph=None):
    """What the canvas sends for one node: its whole graph, the target, the approval."""
    state = graph or _graph_state(api)
    nodes = [{"id": node_id, "definitionId": node["definitionId"], "params": node.get("params") or {}, "outputs": {}}
             for node_id, node in state["nodes"].items()]
    edges = [{"id": edge["id"], "source": edge["source"], "sourceHandle": edge["sourceHandle"],
              "target": edge["target"], "targetHandle": edge["targetHandle"]} for edge in state["edges"]]
    body = {"nodes": nodes, "edges": edges, "targetNodeId": target}
    if approval_id is not None:
        body["approvalId"] = approval_id
    return api.client.post("/api/execute-node", headers=headers, json=body)


def test_accept_returns_an_approval_only_the_canvas_sees(api):
    n1, new_img, result = _accept_cheap_image(api)
    approval_id = result["approvalId"]
    assert isinstance(approval_id, str) and len(approval_id) > 20
    assert approval_id not in json.dumps(api.sent) and approval_id not in json.dumps(api.browser)
    assert approval_id not in json.dumps(api.journal.read(after=0, limit=100))
    assert approval_id not in json.dumps(api.client.get("/api/canvas/proposals", headers=CLAUDE).json())
    # A proposal with no runs approves no run.
    other = api.graph.add_node("text-input", {"value": "old"})
    body = {"note": "Retitle", "params": [{"nodeId": other, "params": {"value": "new"}}]}
    proposal_id = _propose(api, body).json()["proposal"]["id"]
    plain = api.client.post(f"/api/canvas/proposals/{proposal_id}/accept",
                            headers={**PERSON, KEY: _key(api, proposal_id)}, json={})
    assert plain.status_code == 200 and plain.json()["approvalId"] is None


def test_an_agent_cannot_change_an_approved_run_before_the_canvas_starts_it(api, runs):
    """The scratch scenario from review: Claude swaps the model and size after Accept."""
    n1, new_img, result = _accept_cheap_image(api)
    edge = next(e for e in api.graph.edges if e["target"] == new_img)
    refused = [
        api.client.put(f"/api/graph/node/{new_img}", headers=CLAUDE, json={"params": DEAR}),
        api.client.put(f"/api/graph/node/{n1}", headers=CLAUDE, json={"params": {"value": "a 4K poster"}}),
        api.client.request("DELETE", "/api/graph/edge", headers=CLAUDE, json={
            "source": edge["source"], "sourceHandle": edge["sourceHandle"],
            "target": edge["target"], "targetHandle": edge["targetHandle"]}),
        api.client.delete(f"/api/graph/node/{n1}", headers=CLAUDE),
        api.client.post("/api/graph/apply", headers=CLAUDE, json={
            "note": "bigger", "params": [{"nodeId": new_img, "params": DEAR}]}),
        api.client.post("/api/graph/apply", headers=CLAUDE, json={
            "note": "a reference", "nodes": [{"ref": "+p", "definitionId": "image-input"}],
            "edges": [{"source": "+p", "sourceHandle": "image", "target": new_img, "targetHandle": "images"}]}),
        # A forged browser Origin is not the person either.
        api.client.put(f"/api/graph/node/{new_img}", headers=FORGED_ORIGIN, json={"params": DEAR}),
    ]
    for response in refused:
        assert response.status_code == 409, response.text
        assert "in a run the person approved" in response.json()["detail"]
    assert api.graph.nodes[new_img]["params"] == CHEAP
    assert api.graph.nodes[n1]["params"]["value"] == "a cat"
    assert len(api.graph.edges) == 1
    # Edits outside the run set still go through.
    other = api.graph.add_node("text-input", {"value": "elsewhere"})
    assert api.client.put(f"/api/graph/node/{other}", headers=CLAUDE,
                          json={"params": {"value": "fine"}}).status_code == 200
    # The canvas's run is exactly what was approved.
    started = _canvas_run(api, new_img, result["approvalId"])
    assert started.status_code == 200, started.text
    assert runs == [sorted([n1, new_img])]
    # Once it started, the locks lift (that run already has its values).
    assert api.client.put(f"/api/graph/node/{new_img}", headers=CLAUDE, json={"params": DEAR}).status_code == 200


def test_a_run_that_changed_since_accept_is_refused(api, runs):
    n1, new_img, result = _accept_cheap_image(api)
    # However it got there (here: written straight into the graph), the live
    # value no longer matches what the person accepted.
    api.graph.update_params(new_img, DEAR)
    refused = _canvas_run(api, new_img, result["approvalId"])
    assert refused.status_code == 409
    assert f"{new_img} changed since you accepted Claude Code's proposal" in refused.json()["detail"]
    assert runs == []
    # The approval is used up: no retry with it, and the locks are gone.
    again = _canvas_run(api, new_img, result["approvalId"])
    assert again.status_code == 409 and "expired or was already started" in again.json()["detail"]
    assert runs == []


def test_the_run_must_start_exactly_the_approved_nodes(api, runs):
    n1, new_img, result = _accept_cheap_image(api)
    extra = _graph_state(api)
    extra["nodes"]["n99"] = {"definitionId": "image-input", "params": {}}
    extra["edges"].append({"id": "e99", "source": "n99", "sourceHandle": "image",
                           "target": new_img, "targetHandle": "images"})
    refused = _canvas_run(api, new_img, result["approvalId"], graph=extra)
    assert refused.status_code == 409 and "changed since you accepted" in refused.json()["detail"]
    assert runs == []


def test_only_the_person_can_use_or_release_an_approval(api, runs):
    n1, new_img, result = _accept_cheap_image(api)
    approval_id = result["approvalId"]
    for headers in (CLAUDE, FORGED_ORIGIN, {**PERSON, **CLAUDE}):
        used = _canvas_run(api, new_img, approval_id, headers=headers)
        assert used.status_code == 403, used.text
        released = api.client.delete(f"/api/canvas/approvals/{approval_id}", headers=headers)
        assert released.status_code == 403
    assert runs == []
    # Still waiting, still locked.
    assert api.client.put(f"/api/graph/node/{new_img}", headers=CLAUDE, json={"params": DEAR}).status_code == 409
    released = api.client.delete(f"/api/canvas/approvals/{approval_id}", headers=PERSON)
    assert released.json() == {"status": "released"}
    assert api.client.put(f"/api/graph/node/{new_img}", headers=CLAUDE, json={"params": DEAR}).status_code == 200
    gone = _canvas_run(api, new_img, approval_id)
    assert gone.status_code == 409 and runs == []


def test_the_person_can_still_edit_and_an_approval_expires(api, runs):
    n1, new_img, result = _accept_cheap_image(api)
    edited = api.client.put(f"/api/graph/node/{n1}", headers=PERSON, json={"params": {"value": "a dog"}})
    assert edited.status_code == 200
    api.clock.now += APPROVAL_TTL_SECONDS + 1
    assert api.client.put(f"/api/graph/node/{new_img}", headers=CLAUDE, json={"params": DEAR}).status_code == 200
    expired = _canvas_run(api, new_img, result["approvalId"])
    assert expired.status_code == 409 and "expired" in expired.json()["detail"]
    assert runs == []


def test_replacing_or_clearing_the_canvas_drops_approvals(api):
    _n1, _img, _result = _accept_cheap_image(api)
    assert api.approvals.open_list()
    assert api.client.delete("/api/graph?force=true", headers=PERSON).status_code == 200
    assert api.approvals.open_list() == []


def test_a_run_of_several_approved_nodes_goes_through_execute(api, runs):
    n1 = api.graph.add_node("text-input", {"value": "a cat"})
    body = {
        "note": "two images",
        "nodes": [{"ref": "+a", "definitionId": "nano-banana", "params": dict(CHEAP)},
                  {"ref": "+b", "definitionId": "nano-banana", "params": dict(CHEAP)}],
        "edges": [{"source": n1, "sourceHandle": "text", "target": "+a", "targetHandle": "prompt"},
                  {"source": n1, "sourceHandle": "text", "target": "+b", "targetHandle": "prompt"}],
        "run": ["+a", "+b"],
    }
    proposal_id = _propose(api, body).json()["proposal"]["id"]
    result = api.client.post(f"/api/canvas/proposals/{proposal_id}/accept",
                             headers={**PERSON, KEY: _key(api, proposal_id)}, json={}).json()
    state = _graph_state(api)
    request = {
        "nodes": [{"id": node_id, "definitionId": node["definitionId"], "params": node["params"], "outputs": {}}
                  for node_id, node in state["nodes"].items()],
        "edges": [{"id": e["id"], "source": e["source"], "sourceHandle": e["sourceHandle"],
                   "target": e["target"], "targetHandle": e["targetHandle"]} for e in state["edges"]],
        "approvalId": result["approvalId"],
    }
    started = api.client.post("/api/execute", headers=PERSON, json=request)
    assert started.status_code == 200, started.text
    assert runs == [sorted([n1, *result["runNodeIds"]])]


def test_accept_refuses_when_what_it_runs_changed_after_it_was_proposed(api):
    """Before Accept too: the card showed the runs and cost at proposal time."""
    n1 = api.graph.add_node("text-input", {"value": "a cat"})
    n2 = api.graph.add_node("nano-banana", dict(CHEAP))
    api.graph.connect(n1, "text", n2, "prompt")
    body = {"note": "run the cheap one", "run": [n2]}
    proposal_id = _propose(api, body).json()["proposal"]["id"]
    key = _key(api, proposal_id)
    # No approval exists yet, so this edit lands; Accept must notice it.
    assert api.client.put(f"/api/graph/node/{n2}", headers=CLAUDE, json={"params": DEAR}).status_code == 200
    response = api.client.post(f"/api/canvas/proposals/{proposal_id}/accept", headers={**PERSON, KEY: key}, json={})
    assert response.status_code == 409
    assert f"what it runs changed after it was proposed ({n2})" in response.json()["detail"]
    assert api.book.get(proposal_id).status == "invalidated"
    assert api.approvals.open_list() == []


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
                               headers={**PERSON, KEY: key}, json={})
    assert response.status_code == 409 and "already withdrawn" in response.json()["detail"]
    assert json.dumps(api.graph.get_state(), sort_keys=True) == before
    assert api.book.get(proposal_id).status == "withdrawn"


def test_accept_rejects_bad_positions(api):
    n1 = api.graph.add_node("text-input", {"value": "a cat"})
    proposal_id = _propose(api, _upscale_body(n1)).json()["proposal"]["id"]
    key = _key(api, proposal_id)
    for positions in ({"+nope": {"x": 1, "y": 1}}, {"+img": {"x": 1e8, "y": 0}}, {"+img": {"x": "1", "y": 0}}):
        response = api.client.post(f"/api/canvas/proposals/{proposal_id}/accept",
                                   headers={**PERSON, KEY: key}, json={"positions": positions})
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
                                       headers={**PERSON, KEY: key}, json={"reason": "too pricey"})

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


def test_cli_propose_prints_the_readiness_warning():
    class Warned(FakeClient):
        def propose(self, body, agent_name=None):
            return {**super().propose(body, agent_name), "warning": "If the person accepts, the run fails: ..."}

    out = io.StringIO()
    assert proposals_cmd.run_propose(Warned([]), _propose_args(wait=False), out=out) == 0
    assert "warning: If the person accepts, the run fails: ..." in out.getvalue()
    out = io.StringIO()
    proposals_cmd.run_propose(Warned([]), _propose_args(wait=False, json=True), out=out)
    assert json.loads(out.getvalue())["warning"].startswith("If the person accepts")


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
        "  runs   +up — up to 1 paid run (fal) — no list price",
        "Check the outcome: nebula proposal p_9a1c3e02 --wait",
    ]
    priced = {**view, "cost": {**view["cost"], "estimate": {"low": 0.0047, "high": 0.43, "open": True}}}
    assert "— $0.0047–0.43+ at list prices" in format_proposal(priced, now_ms=1_000_000)
    exact = {**view, "cost": {**view["cost"], "estimate": {"low": 0.067, "high": 0.067, "open": False}}}
    assert "— $0.067 at list prices" in format_proposal(exact, now_ms=1_000_000)
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


def test_a_cinema_scene_is_paid_by_its_base_model():
    from services.canvas_proposals import cost_for

    definitions = {"nano-banana": {"id": "nano-banana", "apiProvider": "google"}}
    scene = {"id": "cinema-scene", "apiProvider": "utility"}
    params = {"scene": {"base": {"model": "nano-banana"}, "shots": [{"id": "a"}]}}
    assert cost_for(scene, params, definitions) == {
        "kind": "paid", "provider": "google", "label": "paid · google, per shot"}
    assert cost_for(scene, {"scene": "unreadable"}, definitions)["kind"] == "paid"
