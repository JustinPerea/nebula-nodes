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
from services.canvas_arrange import ArrangeBook
from services.canvas_proposals import MAX_NODES, ProposalBook, ProposalError, parse_spec
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
    arrange = ArrangeBook()
    monkeypatch.setattr(main_module, "canvas_arrange", arrange)
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
    ctx.arrange = arrange
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
    assert body["summary"] == "added 2, connected 1, renamed 1"
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



def _last_sync(api) -> dict:
    return [event for event in api.sent if event.get("type") == "graphSync"][-1]


def test_a_move_tells_open_canvases_which_nodes_moved(api):
    # A canvas keeps its own position for nodes it already shows, so without
    # the list an agent's move didn't show on an open canvas until it reloaded.
    prompt, image = _seed(api)
    response = _apply(api, {
        "nodes": [{"ref": "+up", "definitionId": "text-input"}],
        "move": {image: {"x": 900, "y": 300}, "+up": {"x": 40, "y": 40}},
        "params": [{"nodeId": prompt, "params": {"value": "a castle"}}],
    })
    assert response.status_code == 200, response.text
    assert _last_sync(api)["moved"] == [image]

    _apply(api, {"params": [{"nodeId": prompt, "params": {"value": "a fort"}}]})
    assert "moved" not in _last_sync(api)


def test_a_layout_write_tells_open_canvases_which_nodes_moved(api):
    prompt, image = _seed(api)
    response = api.client.put("/api/graph/layout", headers=PERSON,
                              json={"positions": {image: {"x": 10, "y": 20}, prompt: {"x": 0, "y": 0}}})
    assert response.status_code == 200, response.text
    assert _last_sync(api)["moved"] == sorted([prompt, image])

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
    assert "There's no connection" in missing.json()["detail"]


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
    ok = _apply(api, {"nodes": [{"ref": "+k", "definitionId": "krea-2-generate", "params": {"_kreaAuth": "api-token"}}]})
    assert ok.status_code == 200, ok.text
    node_id = ok.json()["idMap"]["+k"]
    bad = _apply(api, {"params": [{"nodeId": node_id, "params": {"_kreaAuth": "free"}}]})
    assert bad.status_code == 400 and "api-token, mcp" in bad.json()["detail"]
    not_krea = _apply(api, {"nodes": [{"ref": "+t", "definitionId": "text-input", "params": {"_kreaAuth": "mcp"}}]})
    assert not_krea.status_code == 400 and "isn't a Krea node" in not_krea.json()["detail"]
    internal = _apply(api, {"nodes": [{"ref": "+t", "definitionId": "text-input", "params": {"_previewUrl": "x"}}]})
    assert internal.status_code == 422


# -- Krea billing is the person's call ---------------------------------------------

def _refused_for_billing(response) -> bool:
    return response.status_code == 403 and "propose_change" in response.json()["detail"] and \
        "_kreaAuth" in response.json()["detail"]


def test_an_agent_cant_switch_a_krea_node_to_the_plan(api):
    node_id = api.graph.add_node("krea-2-generate", {"_kreaAuth": "api-token"})
    before = _state(api)
    switched = _apply(api, {"params": [{"nodeId": node_id, "params": {"_kreaAuth": "mcp"}}]})
    assert _refused_for_billing(switched), switched.text
    assert _state(api) == before
    # Not through `nebula set` (PUT /api/graph/node) either, nor back again.
    put = api.client.put(f"/api/graph/node/{node_id}", headers=AGENT, json={"params": {"_kreaAuth": "mcp"}})
    assert _refused_for_billing(put)
    on_plan = api.graph.add_node("krea-2-generate", {"_kreaAuth": "mcp"})
    back = api.client.put(f"/api/graph/node/{on_plan}", headers=AGENT, json={"params": {"_kreaAuth": "api-token"}})
    assert _refused_for_billing(back)
    # A forged Origin is still an agent.
    forged = api.client.put(f"/api/graph/node/{node_id}", headers=FORGED_ORIGIN, json={"params": {"_kreaAuth": "mcp"}})
    assert _refused_for_billing(forged)
    # Setting the mode it already has, or other params, isn't a change.
    same = _apply(api, {"params": [{"nodeId": on_plan, "params": {"_kreaAuth": "mcp", "seed": 7}}]})
    assert same.status_code == 200, same.text
    # The person may switch it.
    mine = api.client.put(f"/api/graph/node/{node_id}", headers=PERSON, json={"params": {"_kreaAuth": "mcp"}})
    assert mine.status_code == 200, mine.text
    assert api.graph.nodes[node_id]["params"]["_kreaAuth"] == "mcp"


def test_an_agent_cant_add_a_dual_mode_krea_node_on_the_plan(api):
    added = _apply(api, {"nodes": [{"ref": "+k", "definitionId": "krea-2-generate", "params": {"_kreaAuth": "mcp"}}]})
    assert _refused_for_billing(added) and "+k" in added.json()["detail"]
    created = api.client.post("/api/graph/node", headers=AGENT,
                              json={"definitionId": "krea-2-generate", "params": {"_kreaAuth": "mcp"}})
    assert _refused_for_billing(created)
    cluster = api.client.post("/api/graph/cluster", headers=AGENT, json={
        "nodes": [{"tempId": "a", "definitionId": "krea-2-generate", "params": {"_kreaAuth": "mcp"}}], "edges": []})
    assert _refused_for_billing(cluster)
    imported = api.client.post("/api/graph/import", headers=AGENT, json={
        "nodes": [{"id": "a", "definitionId": "krea-2-generate", "params": {"_kreaAuth": "mcp"}}], "edges": []})
    assert _refused_for_billing(imported)
    assert api.graph.nodes == {}
    # Account-only nodes have no choice to change, and the default is the API token.
    allowed = _apply(api, {"nodes": [
        {"ref": "+f", "definitionId": "krea-files", "params": {"_kreaAuth": "mcp"}},
        {"ref": "+k", "definitionId": "krea-2-generate", "params": {}},
    ]})
    assert allowed.status_code == 200, allowed.text
    # The person may add one on the plan.
    mine = api.client.post("/api/graph/node", headers=PERSON,
                           json={"definitionId": "krea-2-generate", "params": {"_kreaAuth": "mcp"}})
    assert mine.status_code == 200, mine.text


def test_a_direct_edit_has_no_per_edit_caps_but_a_proposal_does():
    # Decision C1: an edit can be undone, so only the canvas's own size limit bounds it.
    many = [{"ref": f"+n{i}", "definitionId": "text-input"} for i in range(MAX_NODES * 4)]
    assert len(parse_edit({"nodes": many}).additions.nodes) == MAX_NODES * 4
    assert len(parse_edit({"remove": [f"n{i}" for i in range(80)]}).remove) == 80
    assert len(parse_edit({"move": {f"n{i}": {"x": i, "y": 0} for i in range(80)}}).move) == 80
    # The person reviews a proposal item by item, so it keeps its caps.
    with pytest.raises(ProposalError) as too_many:
        parse_spec({"note": "x", "nodes": many})
    assert too_many.value.status == 422
    with pytest.raises(ProposalError) as clash:
        parse_edit({"remove": ["n2"], "rename": {"n2": "x"}})
    assert "removed in this edit" in clash.value.detail
    with pytest.raises(ProposalError):
        parse_edit({})


def test_a_large_edit_lands_in_one_call(api):
    nodes = [{"ref": f"+t{i}", "definitionId": "text-input", "params": {"value": f"take {i}"}} for i in range(30)]
    nodes += [{"ref": f"+c{i}", "definitionId": "combine-text"} for i in range(15)]
    edges = [{"source": f"+t{2 * i + side}", "sourceHandle": "text", "target": f"+c{i}",
              "targetHandle": "text1" if side == 0 else "text2"} for i in range(15) for side in (0, 1)]
    response = _apply(api, {"nodes": nodes, "edges": edges})
    assert response.status_code == 200, response.text
    assert response.json()["summary"] == "added 45, connected 30"
    assert len(api.graph.nodes) == 45 and len(api.graph.edges) == 30


def test_the_canvas_size_limit_still_bounds_an_edit(api, monkeypatch):
    import main as main_module

    monkeypatch.setattr(main_module, "RESTORE_MAX_GRAPH_NODES", 3)
    _seed(api)
    before = _state(api)
    response = _apply(api, {"nodes": [{"ref": "+a", "definitionId": "text-input"},
                                      {"ref": "+b", "definitionId": "text-input"}]})
    assert response.status_code == 413
    assert "at most 3 nodes" in response.json()["detail"] and "nothing changed" in response.json()["detail"]
    assert _state(api) == before


# -- arrange (decision C3) ------------------------------------------------------

def _arrange_plan(count: int = 3, **arrange) -> dict:
    return {
        "nodes": [{"ref": f"+i{n}", "definitionId": "image-input", "position": {"x": 1000, "y": 200 * n}}
                  for n in range(count)],
        "arrange": arrange or True,
    }


def test_an_edit_can_ask_the_canvas_to_arrange_its_new_nodes(api):
    prompt, image = _seed(api)
    response = _apply(api, _arrange_plan(direction="down", gap=80))
    assert response.status_code == 200, response.text
    body = response.json()
    new = [body["idMap"][f"+i{n}"] for n in range(3)]
    # No canvas is connected in the test, so the reply says the first one to open does it.
    assert body["arrange"]["status"] == "waiting-for-canvas"
    assert body["arrange"]["nodeIds"] == new
    assert (body["arrange"]["direction"], body["arrange"]["gap"]) == ("down", 80.0)
    assert "stay where they were placed" in body["arrange"]["message"]
    # Positions stay as placed until a canvas measures them.
    assert api.graph.nodes[new[1]]["position"] == {"x": 1000.0, "y": 200.0}
    # Every graphSync carries the request, so a canvas that opens later sees it too.
    assert _last_sync(api)["arrange"] == [{"id": body["arrange"]["id"], "nodeIds": new,
                                            "direction": "down", "gap": 80.0}]
    import asyncio
    import main as main_module
    assert asyncio.run(main_module.export_graph_for_frontend())["arrange"] == _last_sync(api)["arrange"]


def test_the_arrange_reply_counts_any_canvas_but_not_agent_listeners(api, monkeypatch):
    import main as main_module

    class Socket:
        def __init__(self, headers):
            self.headers = headers

    agent = Socket({"x-nebula-agent": "Codex"})
    monkeypatch.setattr(main_module.manager, "active_connections", [agent])
    monkeypatch.setattr(main_module.manager, "browser_connections", set())
    assert _apply(api, _arrange_plan(count=1)).json()["arrange"]["status"] == "waiting-for-canvas"
    # A tab opened without the person link still draws the graph and lays the nodes out.
    monkeypatch.setattr(main_module.manager, "active_connections", [agent, Socket({"origin": "http://localhost:5173"})])
    assert _apply(api, _arrange_plan(count=1)).json()["arrange"]["status"] == "waiting"


def test_the_first_arrange_write_wins_and_a_second_tab_changes_nothing(api):
    prompt, image = _seed(api)
    api.client.put("/api/graph/layout", headers=PERSON, json={"positions": {prompt: {"x": 0, "y": 0}}})
    body = _apply(api, _arrange_plan()).json()
    arrange_id, new = body["arrange"]["id"], body["arrange"]["nodeIds"]
    first = {node_id: {"x": 1000, "y": 300 * n} for n, node_id in enumerate(new)}
    response = api.client.put("/api/graph/layout", headers=PERSON, json={"positions": first, "arrangeId": arrange_id})
    assert response.status_code == 200, response.text
    assert response.json()["status"] == "arranged"
    sync = _last_sync(api)
    assert sync["moved"] == sorted(new) and sync["arrange"] == []
    # Another open tab measured too and sends its own result: it is told it lost, and nothing moves.
    second = {node_id: {"x": 5, "y": 5} for node_id in new}
    again = api.client.put("/api/graph/layout", headers=PERSON, json={"positions": second, "arrangeId": arrange_id})
    assert again.json() == {"status": "already-arranged", "count": 0}
    assert {node_id: api.graph.nodes[node_id]["position"] for node_id in new} == {
        node_id: {"x": float(point["x"]), "y": float(point["y"])} for node_id, point in first.items()}
    assert api.graph.nodes[prompt]["position"] == {"x": 0.0, "y": 0.0}
    arranged = [e for e in api.journal.read(after=0, limit=50)["events"] if e["kind"] == "node.moved"][-1]
    assert arranged["summary"].startswith("arranged") and arranged["actor"]["name"] == "Claude Desktop"


def test_the_canvas_finishing_an_arrange_is_not_a_new_edit(api):
    body = _apply(api, _arrange_plan(count=2)).json()
    arrange_id, new = body["arrange"]["id"], body["arrange"]["nodeIds"]
    tab = {**PERSON, "X-Nebula-Tab": "tab_arranging01"}
    positions = {node_id: {"x": 1200, "y": 300 * n} for n, node_id in enumerate(new)}
    assert api.client.put("/api/graph/layout", headers=tab,
                          json={"positions": positions, "arrangeId": arrange_id}).json()["status"] == "arranged"
    sync = _last_sync(api)
    # Part of the agent's edit: no new undo step anywhere, and every tab folds the
    # positions into the step that added these nodes.
    assert "edit" not in sync
    assert sync["arranged"] == {"id": arrange_id, "nodeIds": sorted(new)}
    assert sync["moved"] == sorted(new)
    # The journal still credits the agent that asked for it.
    arranged = [e for e in api.journal.read(after=0, limit=50)["events"] if e["kind"] == "node.moved"][-1]
    assert arranged["actor"]["name"] == "Claude Desktop"

    # A plain layout write (a drag) is still an edit.
    api.client.put("/api/graph/layout", headers=tab, json={"positions": {new[0]: {"x": 5, "y": 5}}})
    sync = _last_sync(api)
    assert sync["edit"]["tab"] == "tab_arranging01" and "arranged" not in sync


def test_an_arrange_written_by_anyone_but_the_person_stays_an_edit(api):
    # An agent or a script can read the arrangeId off a graphSync. Its write is a
    # normal edit, credited to it, so it can't keep a move off the person's undo stack.
    for headers in ({"X-Nebula-Agent": "Codex"}, FORGED_ORIGIN):
        body = _apply(api, _arrange_plan(count=1)).json()
        arrange_id, new = body["arrange"]["id"], body["arrange"]["nodeIds"]
        response = api.client.put("/api/graph/layout", headers=headers, json={
            "positions": {new[0]: {"x": 3000, "y": 3000}}, "arrangeId": arrange_id})
        assert response.json()["status"] == "arranged"
        sync = _last_sync(api)
        assert "edit" in sync and "tab" not in sync["edit"] and "arranged" not in sync
    assert sync["edit"]["actor"]["kind"] != "agent"


def test_another_agent_finishing_an_arrange_is_journaled_as_itself(api):
    body = _apply(api, _arrange_plan(count=2)).json()
    arrange_id, new = body["arrange"]["id"], body["arrange"]["nodeIds"]
    # Codex read the arrangeId off a graphSync and wrote positions of its own.
    response = api.client.put("/api/graph/layout", headers={"X-Nebula-Agent": "Codex"}, json={
        "positions": {node_id: {"x": 3000, "y": 3000 + n} for n, node_id in enumerate(new)},
        "arrangeId": arrange_id})
    assert response.json()["status"] == "arranged"
    arranged = [e for e in api.journal.read(after=0, limit=50)["events"] if e["kind"] == "node.moved"][-1]
    assert arranged["actor"]["name"] == "Codex"


def test_an_arrange_write_can_only_move_that_edits_new_nodes(api):
    prompt, image = _seed(api)
    api.client.put("/api/graph/layout", headers=PERSON, json={"positions": {image: {"x": 50, "y": 50}}})
    body = _apply(api, _arrange_plan(count=2)).json()
    arrange_id, new = body["arrange"]["id"], body["arrange"]["nodeIds"]
    response = api.client.put("/api/graph/layout", headers=PERSON, json={
        "positions": {new[0]: {"x": 1, "y": 1}, image: {"x": 900, "y": 900}}, "arrangeId": arrange_id})
    assert response.status_code == 400
    assert "never moves other nodes" in response.json()["detail"]
    assert api.graph.nodes[image]["position"] == {"x": 50.0, "y": 50.0}
    assert api.arrange.get(arrange_id) is not None  # still open for a correct write


def test_an_explicit_position_wins_over_a_waiting_arrange(api):
    body = _apply(api, _arrange_plan(count=3)).json()
    arrange_id, new = body["arrange"]["id"], body["arrange"]["nodeIds"]
    # The person drags one before any canvas arranged them.
    api.client.put("/api/graph/layout", headers=PERSON, json={"positions": {new[0]: {"x": 7, "y": 7}}})
    # An agent moves another.
    _apply(api, {"move": {new[1]: {"x": 9, "y": 9}}})
    assert _last_sync(api)["arrange"][0]["nodeIds"] == [new[2]]
    refused = api.client.put("/api/graph/layout", headers=PERSON,
                             json={"positions": {new[0]: {"x": 0, "y": 0}}, "arrangeId": arrange_id})
    assert refused.status_code == 400
    assert api.graph.nodes[new[0]]["position"] == {"x": 7.0, "y": 7.0}


def test_arrange_needs_new_nodes_and_a_known_shape(api):
    prompt, image = _seed(api)
    for body, words in (
        ({"move": {image: {"x": 1, "y": 1}}, "arrange": True}, "adds none"),
        ({**_arrange_plan(), "arrange": {"direction": "left"}}, "direction"),
        ({**_arrange_plan(), "arrange": {"gap": -5}}, "gap"),
        ({**_arrange_plan(), "arrange": {"spacing": 5}}, "unknown arrange field"),
        ({**_arrange_plan(), "arrange": "yes"}, "arrange must be"),
    ):
        response = _apply(api, body)
        assert response.status_code == 422, body
        assert words in response.json()["detail"]
    assert len(api.arrange) == 0
    # Asking for no arrange is the same as leaving it out.
    plain = _apply(api, {**_arrange_plan(count=1), "arrange": False}).json()
    assert "arrange" not in plain and len(api.arrange) == 0


def test_a_replaced_or_cleared_canvas_drops_waiting_arranges(api):
    import asyncio
    import main as main_module

    _apply(api, _arrange_plan(count=2))
    assert len(api.arrange) == 1
    asyncio.run(main_module._broadcast_graph_sync(graph_replaced=True, reason="project-open"))
    assert len(api.arrange) == 0 and _last_sync(api).get("arrange", []) == []

    body = _apply(api, _arrange_plan(count=1)).json()
    assert body["arrange"]["nodeIds"]
    api.graph.clear()
    # An empty canvas's export has no arrange list (the canvas clears its own).
    assert "arrange" not in asyncio.run(main_module.export_graph_for_frontend())
    assert len(api.arrange) == 0


def test_the_arrange_book_keeps_only_live_nodes():
    book = ArrangeBook()
    entry = book.add(["n1", "n2"], direction="right", gap=120)
    assert book.pending({"n1", "n2"})[0]["nodeIds"] == ["n1", "n2"]
    assert book.pending({"n2"})[0]["nodeIds"] == ["n2"]
    assert book.pending(set()) == [] and book.get(entry.id) is None
    other = book.add(["n3"], direction="down", gap=0)
    assert book.complete(other.id) is other and book.complete(other.id) is None
