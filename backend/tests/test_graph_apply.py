"""POST /api/graph/apply: an agent's direct canvas edit, all of it or none of it.

The MCP server's edit_canvas and remove_from_canvas send these bodies. Same
shape as a proposal (nodes with +refs, edges, params) plus rename, move,
remove and unwire.
"""
from __future__ import annotations

import pytest
from fastapi.testclient import TestClient

from services.agent_presence import AgentPresence
from services.canvas_edits import parse_edit
from services.canvas_events import CanvasEventJournal
from services.canvas_pins import CanvasPins
from services.canvas_proposals import MAX_NODES, ProposalBook, ProposalError
from services.cli_graph import CLIGraph
from services.project_store import ProjectStore, make_project
from services.provider_recovery import ProviderRecoveryStore
from services.provider_start_guard import ProviderStartGuard
from tests.conftest import FORGED_ORIGIN, PERSON

AGENT = {"X-Nebula-Agent": "Claude Desktop"}


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
    guard = ProviderStartGuard(tmp_path / "paid-starts.json")
    book = ProposalBook()
    sent: list[dict] = []

    async def capture(data):
        sent.append(data)

    monkeypatch.setattr(main_module, "cli_graph", graph)
    monkeypatch.setattr(main_module, "project_store", store)
    monkeypatch.setattr(main_module, "canvas_pins", CanvasPins(lambda: main_module.project_store))
    monkeypatch.setattr(main_module, "canvas_proposals", book)
    monkeypatch.setattr(main_module, "agent_presence", AgentPresence())
    monkeypatch.setattr(main_module, "canvas_events", journal)
    monkeypatch.setattr(main_module, "provider_recovery_store", ProviderRecoveryStore(None))
    monkeypatch.setattr(main_module, "provider_start_guard", guard)
    monkeypatch.setattr(main_module, "_graph_recovery_bootstrap_error", None)
    monkeypatch.setattr(main_module.manager, "broadcast_raw", capture)
    monkeypatch.setattr(main_module.manager, "broadcast_browser", capture)

    class Api:
        pass

    ctx = Api()
    ctx.client = TestClient(main_module.app)
    ctx.graph = graph
    ctx.journal = journal
    ctx.guard = guard
    ctx.book = book
    ctx.sent = sent
    return ctx


def _apply(api, body, headers=AGENT):
    return api.client.post("/api/graph/apply", headers=headers, json=body)


def _seed(api) -> tuple[str, str]:
    """n1 text-input wired into n2 nano-banana."""
    prompt = api.graph.add_node("text-input", {"value": "a lighthouse"})
    image = api.graph.add_node("nano-banana", {})
    api.graph.connect(prompt, "text", image, "prompt")
    return prompt, image


def _state(api):
    return {"nodes": {k: dict(v) for k, v in api.graph.nodes.items()}, "edges": [dict(e) for e in api.graph.edges]}


def test_builds_a_cluster_in_one_call(api):
    response = _apply(api, {
        "note": "Prompt into an image",
        "nodes": [
            {"ref": "+prompt", "definitionId": "text-input", "params": {"value": "a red fox"}},
            {"ref": "+img", "definitionId": "nano-banana", "params": {"aspect_ratio": "16:9"}},
        ],
        "edges": [{"source": "+prompt", "sourceHandle": "text", "target": "+img", "targetHandle": "prompt"}],
        "rename": {"+img": "Fox"},
        "move": {"+prompt": {"x": 40, "y": 60}},
    })
    assert response.status_code == 200, response.text
    body = response.json()
    prompt, image = body["idMap"]["+prompt"], body["idMap"]["+img"]
    assert body["status"] == "applied"
    assert body["summary"] == "added 2, wired 1, renamed 1"
    assert [n["id"] for n in body["added"]] == [prompt, image]
    assert body["wired"][0]["source"] == prompt and body["wired"][0]["target"] == image
    assert api.graph.nodes[image]["label"] == "Fox"
    assert api.graph.nodes[image]["params"]["aspect_ratio"] == "16:9"
    assert api.graph.nodes[prompt]["position"] == {"x": 40.0, "y": 60.0}
    events = api.journal.read(after=0, limit=50)["events"]
    assert {e["kind"] for e in events} >= {"node.added", "edge.added"}
    assert all(e["actor"]["name"] == "Claude Desktop" for e in events)
    # The canvas got a sync and the agent's cursor moved.
    assert any(m.get("type") == "agentPresence" for m in api.sent)


def test_a_bad_part_leaves_the_canvas_unchanged(api):
    prompt, image = _seed(api)
    before = _state(api)
    response = _apply(api, {
        "remove": [image],
        "nodes": [{"ref": "+img", "definitionId": "nano-banana"}],
        "edges": [{"source": prompt, "sourceHandle": "text", "target": "+img", "targetHandle": "nope"}],
    })
    assert response.status_code == 400, response.text
    assert _state(api) == before
    assert api.journal.read(after=0)["events"] == []


def test_changes_params_renames_moves_and_journals_each(api):
    prompt, image = _seed(api)
    response = _apply(api, {
        "params": [{"nodeId": prompt, "params": {"value": "a castle"}}],
        "rename": {prompt: "Hero prompt", image: ""},
        "move": {image: {"x": 900, "y": 300}},
    })
    assert response.status_code == 200, response.text
    body = response.json()
    assert body["changed"] == [prompt] and body["moved"] == [image]
    assert body["renamed"][prompt] == "Hero prompt"
    assert "label" not in api.graph.nodes[image]  # '' restores the model's name
    assert api.graph.nodes[prompt]["params"]["value"] == "a castle"
    assert api.graph.nodes[image]["position"] == {"x": 900.0, "y": 300.0}
    kinds = [e["kind"] for e in api.journal.read(after=0, limit=50)["events"]]
    assert "node.params" in kinds and "node.renamed" in kinds


def test_remove_and_unwire(api):
    prompt, image = _seed(api)
    spare = api.graph.add_node("text-input", {"value": "spare"})
    response = _apply(api, {
        "unwire": [{"source": prompt, "sourceHandle": "text", "target": image, "targetHandle": "prompt"}],
        "remove": [spare],
    })
    assert response.status_code == 200, response.text
    assert response.json()["removed"] == [spare]
    assert api.graph.edges == []
    assert set(api.graph.nodes) == {prompt, image}
    kinds = [e["kind"] for e in api.journal.read(after=0, limit=50)["events"]]
    assert "edge.removed" in kinds and "node.removed" in kinds

    missing = _apply(api, {"unwire": [{"source": prompt, "sourceHandle": "text", "target": image, "targetHandle": "prompt"}]})
    assert missing.status_code == 404
    assert "no wire" in missing.json()["detail"]


def test_removing_a_node_invalidates_proposals_that_use_it(api):
    prompt, image = _seed(api)
    proposed = api.client.post("/api/canvas/proposals", headers={"X-Nebula-Agent": "Codex"}, json={
        "note": "warmer", "params": [{"nodeId": prompt, "params": {"value": "warm light"}}],
    })
    assert proposed.status_code == 201, proposed.text
    assert _apply(api, {"remove": [prompt]}).status_code == 200
    assert api.book.open_list() == []


def test_a_node_with_paid_state_cant_be_removed(api, monkeypatch):
    prompt, image = _seed(api)
    before = _state(api)
    monkeypatch.setattr(api.guard, "has_active_node", lambda node_id: node_id == image)
    response = _apply(api, {"remove": [prompt, image]})
    assert response.status_code == 409
    assert "World Labs" in response.json()["detail"]
    assert _state(api) == before


def test_unknown_nodes_and_identity(api):
    prompt, _ = _seed(api)
    assert _apply(api, {"remove": ["n99"]}).status_code == 404
    assert _apply(api, {"move": {"n99": {"x": 0, "y": 0}}}).status_code == 404
    assert _apply(api, {"params": [{"nodeId": "n99", "params": {"value": "x"}}]}).status_code == 404
    assert _apply(api, {"rename": {prompt: "x"}}, headers={}).status_code == 400
    assert _apply(api, {"rename": {prompt: "x"}}, headers=PERSON).status_code == 403
    # A forged Origin is not the person: it still has to name itself.
    assert _apply(api, {"rename": {prompt: "x"}}, headers=FORGED_ORIGIN).status_code == 400


def test_krea_billing_choice_is_checked_per_node(api):
    ok = _apply(api, {"nodes": [{"ref": "+k", "definitionId": "krea-2-generate", "params": {"_kreaAuth": "mcp"}}]})
    assert ok.status_code == 200, ok.text
    node_id = ok.json()["idMap"]["+k"]
    assert api.graph.nodes[node_id]["params"]["_kreaAuth"] == "mcp"
    bad = _apply(api, {"params": [{"nodeId": node_id, "params": {"_kreaAuth": "free"}}]})
    assert bad.status_code == 400 and "api-token, mcp" in bad.json()["detail"]
    not_krea = _apply(api, {"nodes": [{"ref": "+t", "definitionId": "text-input", "params": {"_kreaAuth": "mcp"}}]})
    assert not_krea.status_code == 400 and "isn't a Krea node" in not_krea.json()["detail"]
    internal = _apply(api, {"nodes": [{"ref": "+t", "definitionId": "text-input", "params": {"_previewUrl": "x"}}]})
    assert internal.status_code == 422


def test_limits_match_proposals():
    with pytest.raises(ProposalError) as too_many:
        parse_edit({"nodes": [{"ref": f"+n{i}", "definitionId": "text-input"} for i in range(MAX_NODES + 1)]})
    assert too_many.value.status == 422
    with pytest.raises(ProposalError):
        parse_edit({"remove": [f"n{i}" for i in range(30)]})
    with pytest.raises(ProposalError) as clash:
        parse_edit({"remove": ["n2"], "rename": {"n2": "x"}})
    assert "removed in this edit" in clash.value.detail
    with pytest.raises(ProposalError):
        parse_edit({})
