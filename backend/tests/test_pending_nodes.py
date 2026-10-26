"""Placeholders (Q125 item 3): nodes an agent is still setting up.

Justin, 2026-10-24, merge-oks Q125 ("Yes, all four, in that order"), item 3:
"A node an agent is about to fill shows as a placeholder in its colour ...
edit_canvas gains pending: true." GM - Design, 2026-10-25: "Run skips pending
nodes, along with any node downstream that needs their output ... The person
running a pending node directly counts as their edit: it turns normal and
runs ... turns normal on run, on pending false, after 10 min idle, or on any
edit by the person. Nothing is ever deleted."

These tests pin the flag's life on every path, who may change it, that it
is saved with the graph, and that every way to run skips it.
"""
from __future__ import annotations

import pytest

from models.events import ErrorEvent, ExecutedEvent, ExecutingEvent, SkippedEvent
from services.agent_status import AgentStatusBook
from services import pending_nodes
from tests.conftest import PERSON
from tests.test_canvas_proposals import CLAUDE, CODEX, KEY, _key, api  # noqa: F401 - fixture

CLAUDE_ID = "ext:claude-code"
CODEX_ID = "ext:codex"


@pytest.fixture
def pend(api, monkeypatch):  # noqa: F811 - the imported fixture
    """The canvas app with a fake engine (no provider is ever called), the
    spend check recording what it was asked to price, and one clock."""
    main = api.main
    statuses = AgentStatusBook(api.clock)
    monkeypatch.setattr(main, "agent_status", statuses)
    monkeypatch.setattr(main, "agent_runs", main.AgentRunBook(api.clock))
    priced: list[list[str]] = []
    ran: list[list[str]] = []
    fail: set[str] = set()

    def record_spend(nodes, edges, **kwargs):
        priced.append(sorted(node.id for node in nodes))

    async def no_measure(*args, **kwargs):
        return {}

    async def fake_execute_graph(*, nodes, edges, emit, run_id, **kwargs):
        ran.append(sorted(node.id for node in nodes))
        broken: set[str] = set()
        for node_id in main.topological_sort(nodes, edges):
            # As the engine does: a node downstream of a failure never starts.
            if any(edge.target == node_id and edge.source in broken for edge in edges):
                broken.add(node_id)
                continue
            await emit(ExecutingEvent(node_id=node_id, run_id=run_id))
            if node_id in fail:
                broken.add(node_id)
                await emit(ErrorEvent(node_id=node_id, error="it broke", run_id=run_id))
            else:
                await emit(ExecutedEvent(node_id=node_id, outputs={"text": {"type": "Text", "value": "made"}},
                                         run_id=run_id))

    monkeypatch.setattr(main, "_require_spend_approval", record_spend)
    monkeypatch.setattr(main, "_measure_run_inputs", no_measure)
    monkeypatch.setattr(main, "validate_graph", lambda *args, **kwargs: [])
    monkeypatch.setattr(main, "execute_graph", fake_execute_graph)
    api.statuses = statuses
    api.priced = priced
    api.ran = ran
    api.fail = fail
    return api


def _apply(api, body, headers=CLAUDE):
    return api.client.post("/api/graph/apply", headers=headers, json=body)


def _chain(api, *, headers=CLAUDE, pending=True) -> dict[str, str]:
    """+p (text) → +a (combine) → +b (combine), added by one agent's edit."""
    body = {
        "note": "set up the hero chain",
        "nodes": [{"ref": "+p", "definitionId": "text-input", "params": {"value": "a lighthouse"}},
                  {"ref": "+a", "definitionId": "combine-text"},
                  {"ref": "+b", "definitionId": "combine-text"}],
        "edges": [{"source": "+p", "sourceHandle": "text", "target": "+a", "targetHandle": "text1"},
                  {"source": "+a", "sourceHandle": "text", "target": "+b", "targetHandle": "text1"}],
        "rename": {"+p": "Hero prompt"},
        **({"pending": True} if pending else {}),
    }
    response = _apply(api, body, headers)
    assert response.status_code == 200, response.text
    return response.json()["idMap"]


def _owner(api, node_id):
    return pending_nodes.owner(api.graph.nodes[node_id])


def _last_sync(api) -> dict:
    return next(message for message in reversed(api.sent) if message.get("type") == "graphSync")


def _synced_pending(api, node_id):
    node = next(n for n in _last_sync(api)["nodes"] if n["id"] == node_id)
    return node["data"].get("pending")


# -- marking ---------------------------------------------------------------------------

def test_pending_true_marks_the_new_nodes_with_the_agents_identity(pend):
    ids = _chain(pend)
    for ref in ("+p", "+a", "+b"):
        who = _owner(pend, ids[ref])
        assert who == {"id": CLAUDE_ID, "name": "Claude Code", "color": who["color"], "verified": False}
        assert who["color"].startswith("#")
    # The reply says which nodes it made placeholders.
    # The canvas gets it on the node's data.
    assert _synced_pending(pend, ids["+a"])["agent"]["name"] == "Claude Code"


def test_the_reply_lists_the_placeholders(pend):
    body = {"nodes": [{"ref": "+p", "definitionId": "text-input"}], "pending": True}
    reply = _apply(pend, body).json()
    assert reply["pending"] == [reply["idMap"]["+p"]]


def test_without_pending_new_nodes_are_normal(pend):
    ids = _chain(pend, pending=False)
    assert all(_owner(pend, node_id) is None for node_id in ids.values())


def test_pending_needs_new_nodes_and_never_marks_an_existing_one(pend):
    existing = pend.graph.add_node("text-input", {"value": "the person's"})
    refused = _apply(pend, {"params": [{"nodeId": existing, "params": {"value": "x"}}], "pending": True})
    assert refused.status_code == 422
    assert "new nodes" in refused.json()["detail"]
    assert _owner(pend, existing) is None
    # nodeIds name nodes to make ready; they never mark one.
    refused = _apply(pend, {"pending": True, "nodeIds": [existing],
                            "nodes": [{"ref": "+q", "definitionId": "text-input"}]})
    assert refused.status_code == 422
    assert _owner(pend, existing) is None
    assert len(pend.graph.nodes) == 1
    # pending must be true or false.
    assert _apply(pend, {"nodes": [{"ref": "+q", "definitionId": "text-input"}], "pending": "yes"}).status_code == 422


def test_pending_false_makes_the_agents_own_nodes_ready(pend):
    ids = _chain(pend)
    reply = _apply(pend, {"pending": False, "nodeIds": [ids["+p"], ids["+a"]]})
    assert reply.status_code == 200, reply.text
    body = reply.json()
    assert sorted(body["ready"]) == sorted([ids["+p"], ids["+a"]])
    assert _owner(pend, ids["+p"]) is None and _owner(pend, ids["+a"]) is None
    assert _owner(pend, ids["+b"])["id"] == CLAUDE_ID
    assert _synced_pending(pend, ids["+p"]) is None
    # Again: nothing to do, and it says so.
    again = _apply(pend, {"pending": False, "nodeIds": [ids["+p"]]}).json()
    assert again["ready"] == [] and again["notPending"] == [ids["+p"]]
    # nodeIds alone (without pending: false) is refused.
    assert _apply(pend, {"nodeIds": [ids["+b"]]}).status_code == 422


def test_another_agent_cant_clear_or_claim_a_placeholder(pend):
    ids = _chain(pend)
    refused = _apply(pend, {"pending": False, "nodeIds": [ids["+b"]]}, headers=CODEX)
    assert refused.status_code == 403
    assert "Claude Code" in refused.json()["detail"]
    assert _owner(pend, ids["+b"])["id"] == CLAUDE_ID
    # All or nothing: one of its own beside one that isn't changes neither.
    mine = _apply(pend, {"nodes": [{"ref": "+c", "definitionId": "text-input"}], "pending": True},
                  headers=CODEX).json()["idMap"]["+c"]
    refused = _apply(pend, {"pending": False, "nodeIds": [mine, ids["+b"]]}, headers=CODEX)
    assert refused.status_code == 403
    assert _owner(pend, mine)["id"] == CODEX_ID
    # Another agent's edit to it leaves it pending, and its owner unchanged.
    changed = _apply(pend, {"params": [{"nodeId": ids["+p"], "params": {"value": "dusk"}}]}, headers=CODEX)
    assert changed.status_code == 200, changed.text
    assert _owner(pend, ids["+p"])["id"] == CLAUDE_ID
    # So does its owner's own edit: it is still setting it up.
    _apply(pend, {"params": [{"nodeId": ids["+p"], "params": {"value": "dawn"}}]})
    assert _owner(pend, ids["+p"])["id"] == CLAUDE_ID


def test_the_person_and_anonymous_callers_cant_use_the_agent_route(pend):
    assert _apply(pend, {"nodes": [{"ref": "+q", "definitionId": "text-input"}], "pending": True},
                  headers=PERSON).status_code == 403


# -- the person's edits ---------------------------------------------------------------------

def test_the_persons_model_pick_turns_it_normal(pend):
    """The canvas's model picker (POST /api/graph/node/{id}/model) is the
    person editing the node: it turns normal, even when the params come out
    the same (the person chose the model)."""
    from tests.test_universal_ports import _warm_openrouter

    _warm_openrouter()
    eye = _apply(pend, {"nodes": [{"ref": "+eye", "definitionId": "openrouter-universal",
                                   "params": {"model": "openai/gpt-4o"}}], "pending": True}).json()["idMap"]["+eye"]
    assert _owner(pend, eye)["id"] == CLAUDE_ID
    response = pend.client.post(f"/api/graph/node/{eye}/model", headers=PERSON,
                                json={"model": "anthropic/claude-sonnet-4.5"})
    assert response.status_code == 200, response.text
    assert _owner(pend, eye) is None
    assert _synced_pending(pend, eye) is None
    # The same model again on another placeholder: still the person's edit.
    again = _apply(pend, {"nodes": [{"ref": "+eye", "definitionId": "openrouter-universal",
                                     "params": {"model": "openai/gpt-4o"}}], "pending": True}).json()["idMap"]["+eye"]
    assert pend.client.post(f"/api/graph/node/{again}/model", headers=PERSON,
                            json={"model": "openai/gpt-4o"}).status_code == 200
    assert _owner(pend, again) is None


@pytest.mark.parametrize("edit", ["params", "rename", "move", "connect", "disconnect"])
def test_any_edit_by_the_person_turns_it_normal(pend, edit):
    ids = _chain(pend)
    node = ids["+a"]
    client = pend.client
    if edit == "params":
        response = client.put(f"/api/graph/node/{node}", headers=PERSON, json={"params": {"separator": " "}})
    elif edit == "rename":
        response = client.put(f"/api/graph/node/{node}/label", headers=PERSON, json={"label": "Mine now"})
    elif edit == "move":
        response = client.put("/api/graph/layout", headers=PERSON, json={"positions": {node: {"x": 900, "y": 40}}})
    elif edit == "connect":
        other = pend.graph.add_node("text-input", {"value": "more"})
        response = client.post("/api/graph/connect", headers=PERSON, json={
            "source": other, "sourceHandle": "text", "target": node, "targetHandle": "text2"})
    else:
        response = client.request("DELETE", "/api/graph/edge", headers=PERSON, json={
            "source": node, "sourceHandle": "text", "target": ids["+b"], "targetHandle": "text1"})
    assert response.status_code == 200, response.text
    assert _owner(pend, node) is None
    assert _synced_pending(pend, node) is None
    # Nothing else changed: the other placeholders stay, nothing was deleted.
    assert _owner(pend, ids["+p"])["id"] == CLAUDE_ID
    assert set(ids.values()) <= set(pend.graph.nodes)


def test_a_layout_write_that_moves_nothing_or_finishes_an_arrange_is_not_an_edit(pend):
    ids = _chain(pend)
    node = ids["+a"]
    where = dict(pend.graph.nodes[node].get("position") or {})
    if where:
        pend.client.put("/api/graph/layout", headers=PERSON, json={"positions": {node: where}})
        assert _owner(pend, node)["id"] == CLAUDE_ID


def test_an_agents_edit_by_the_single_edit_routes_leaves_it_pending(pend):
    ids = _chain(pend)
    node = ids["+a"]
    assert pend.client.put(f"/api/graph/node/{node}/label", headers=CODEX, json={"label": "Codex's"}).status_code == 200
    assert pend.client.put(f"/api/graph/node/{node}", headers=CLAUDE,
                           json={"params": {"separator": "-"}}).status_code == 200
    assert _owner(pend, node)["id"] == CLAUDE_ID


# -- the idle rule -------------------------------------------------------------------------------

def test_it_turns_normal_after_ten_idle_minutes_and_a_sign_keeps_it(pend):
    import asyncio

    ids = _chain(pend)
    start = pend.clock.now
    pend.clock.now = start + 500
    # Any identified request from the owner is a sign (a cursor move here).
    assert pend.client.post("/api/canvas/cursor", headers=CLAUDE,
                            json={"target": {"x": 1, "y": 1}}).status_code == 200
    pend.clock.now = start + 601
    asyncio.run(pend.main._sweep_pending_nodes())
    assert _owner(pend, ids["+a"])["id"] == CLAUDE_ID
    pend.clock.now = start + 500 + pending_nodes.IDLE_SECONDS + 1
    asyncio.run(pend.main._sweep_pending_nodes())
    assert all(_owner(pend, node_id) is None for node_id in ids.values())
    assert set(ids.values()) <= set(pend.graph.nodes)  # nothing deleted
    assert _synced_pending(pend, ids["+a"]) is None


def test_another_agents_signs_dont_keep_it(pend):
    import asyncio

    ids = _chain(pend)
    start = pend.clock.now
    pend.clock.now = start + 590
    pend.client.post("/api/canvas/cursor", headers=CODEX, json={"target": {"x": 1, "y": 1}})
    pend.clock.now = start + 601
    asyncio.run(pend.main._sweep_pending_nodes())
    assert _owner(pend, ids["+a"]) is None


def test_the_deadline_book_keeping():
    nodes = {"n1": {"pending": {"agent": {"id": "a", "name": "A", "color": "#112233", "verified": True},
                                "at": 1_000_000}}}
    assert pending_nodes.next_deadline(nodes, lambda _id: None) == 1000.0 + pending_nodes.IDLE_SECONDS
    assert pending_nodes.next_deadline(nodes, lambda _id: 1500.0) == 1500.0 + pending_nodes.IDLE_SECONDS
    assert pending_nodes.expired(nodes, lambda _id: None, 1000.0 + 601) == ["n1"]
    assert pending_nodes.expired(nodes, lambda _id: 1500.0, 1000.0 + 601) == []


def test_a_malformed_flag_is_not_a_placeholder():
    for raw in (True, {"agent": "Codex"}, {"agent": {"id": "x", "name": "X", "color": "red"}},
                {"agent": {"id": "", "name": "X", "color": "#112233"}}):
        assert pending_nodes.clean(raw) is None
        assert not pending_nodes.is_pending({"pending": raw})


# -- saved with the graph ------------------------------------------------------------------------------

def test_the_flag_is_saved_with_the_graph_and_the_project(pend, tmp_path):
    from services.cli_graph import CLIGraph

    ids = _chain(pend)
    # The persisted graph keeps it, so a restart does too.
    reloaded = CLIGraph()
    reloaded.load(pend.graph._persist_path)
    assert pending_nodes.owner(reloaded.nodes[ids["+a"]])["id"] == CLAUDE_ID
    # The canvas export carries it as data.pending.
    exported = pend.client.get("/api/graph/export", headers=PERSON).json()
    node = next(n for n in exported["nodes"] if n["id"] == ids["+a"])
    assert node["data"]["pending"]["agent"]["id"] == CLAUDE_ID


def _save(api, nodes):
    catalog = api.main.project_store.read()
    snapshot = {"nodes": nodes, "edges": [], "viewport": {"x": 0, "y": 0, "zoom": 1}, "runHistory": []}
    return api.client.put(f"/api/projects/{api.project_id}", headers=PERSON,
                          json={"workspaceRevision": catalog["workspaceRevision"], "snapshot": snapshot})


def test_a_save_keeps_the_live_flag_and_never_one_the_tab_made_up(pend):
    ids = _chain(pend)
    exported = pend.client.get("/api/graph/export", headers=PERSON).json()["nodes"]
    forged = {"agent": {"id": CODEX_ID, "name": "Codex", "color": "#F2C14E", "verified": True}, "at": 1}
    for node in exported:
        if node["id"] == ids["+p"]:
            node["data"].pop("pending", None)  # a tab that lost it
        if node["id"] == ids["+a"]:
            node["data"]["pending"] = forged  # a tab that claims it for another agent
    saved = _save(pend, exported)
    assert saved.status_code == 200, saved.text
    stored = {n["id"]: n for n in pend.main.project_store.read()["projects"][pend.project_id]["snapshot"]["nodes"]}
    assert stored[ids["+p"]]["data"]["pending"]["agent"]["id"] == CLAUDE_ID
    assert stored[ids["+a"]]["data"]["pending"]["agent"]["id"] == CLAUDE_ID


def test_reopening_a_project_brings_its_placeholders_back(pend):
    ids = _chain(pend)
    exported = pend.client.get("/api/graph/export", headers=PERSON).json()["nodes"]
    assert _save(pend, exported).status_code == 200
    snapshot = pend.main.project_store.read()["projects"][pend.project_id]["snapshot"]
    staged, candidate = pend.main._stage_project_snapshot(snapshot, historical={})
    assert pending_nodes.owner(candidate.nodes[ids["+a"]])["id"] == CLAUDE_ID
    assert staged["nodes"][1]["data"]["pending"]["agent"]["name"] == "Claude Code"
    # A malformed flag in a stored project loads as a normal node.
    snapshot["nodes"][1]["data"]["pending"] = {"agent": "nobody"}
    staged, candidate = pend.main._stage_project_snapshot(snapshot, historical={})
    assert pending_nodes.owner(candidate.nodes[snapshot["nodes"][1]["id"]]) is None
    assert "pending" not in staged["nodes"][1]["data"]


def test_a_project_switch_never_brings_back_a_placeholder_made_ready_since_the_last_save(pend):
    """The switch stores the live canvas over the saved snapshot: the live
    graph decides the flag for every node it holds, so a flag cleared since
    the last save (pending: false, a run, the idle rule, the person's edit)
    doesn't come back from the old snapshot."""
    ids = _chain(pend)
    exported = pend.client.get("/api/graph/export", headers=PERSON).json()["nodes"]
    assert _save(pend, exported).status_code == 200
    assert _apply(pend, {"pending": False, "nodeIds": [ids["+a"]]}).status_code == 200
    assert _owner(pend, ids["+a"]) is None
    revision = pend.client.get("/api/projects", headers=PERSON).json()["workspaceRevision"]
    made = pend.client.post("/api/projects", headers=PERSON, json={"name": "Elsewhere", "workspaceRevision": revision})
    assert made.status_code == 200, made.text
    stored = {n["id"]: n for n in pend.main.project_store.read()["projects"][pend.project_id]["snapshot"]["nodes"]}
    assert "pending" not in stored[ids["+a"]]["data"]
    assert stored[ids["+b"]]["data"]["pending"]["agent"]["id"] == CLAUDE_ID  # still a placeholder: kept
    revision = pend.client.get("/api/projects", headers=PERSON).json()["workspaceRevision"]
    opened = pend.client.post(f"/api/projects/{pend.project_id}/open", headers=PERSON,
                              json={"workspaceRevision": revision})
    assert opened.status_code == 200, opened.text
    assert _owner(pend, ids["+a"]) is None
    assert _owner(pend, ids["+b"])["id"] == CLAUDE_ID


# -- undo and redo --------------------------------------------------------------------------------------

def _restore(api, body, headers=PERSON):
    return api.client.post("/api/graph/restore", headers=headers, json={"action": "undo", **body})


def test_the_persons_undo_and_redo_put_the_flag_back_as_the_step_had_it(pend):
    ids = _chain(pend)
    node = ids["+a"]
    flag = dict(pend.graph.nodes[node]["pending"])
    # The person moves it (it turns normal), then undoes the move.
    pend.client.put("/api/graph/layout", headers=PERSON, json={"positions": {node: {"x": 900, "y": 40}}})
    assert _owner(pend, node) is None
    undone = _restore(pend, {"nodes": [{"id": node, "definitionId": "combine-text", "position": {"x": 0, "y": 0},
                                        "pending": flag}], "remove": [], "wire": [], "unwire": []})
    assert undone.status_code == 200, undone.text
    assert _owner(pend, node)["id"] == CLAUDE_ID
    # Redo: the step had none.
    redone = pend.client.post("/api/graph/restore", headers=PERSON, json={
        "action": "redo", "nodes": [{"id": node, "definitionId": "combine-text", "position": {"x": 900, "y": 40},
                                     "pending": None}], "remove": [], "wire": [], "unwire": []})
    assert redone.status_code == 200, redone.text
    assert _owner(pend, node) is None


def test_undoing_the_agents_add_and_redoing_it_brings_the_placeholder_back(pend):
    ids = _chain(pend)
    node = ids["+b"]
    saved = dict(pend.graph.nodes[node])
    assert _restore(pend, {"nodes": [], "remove": [node], "wire": [], "unwire": []}).status_code == 200
    assert node not in pend.graph.nodes
    back = pend.client.post("/api/graph/restore", headers=PERSON, json={
        "action": "redo", "nodes": [{"id": node, "definitionId": "combine-text", "params": saved["params"],
                                     "position": saved.get("position") or {"x": 0, "y": 0},
                                     "outputs": {}, "pending": saved["pending"]}],
        "remove": [], "wire": [], "unwire": []})
    assert back.status_code == 200, back.text
    assert _owner(pend, node)["id"] == CLAUDE_ID


def test_an_agents_restore_cant_set_a_flag(pend):
    ids = _chain(pend, pending=False)
    node = ids["+a"]
    forged = {"agent": {"id": CODEX_ID, "name": "Codex", "color": "#F2C14E", "verified": False}, "at": 1}
    response = _restore(pend, {"nodes": [{"id": node, "definitionId": "combine-text", "pending": forged,
                                          "position": {"x": 5, "y": 5}}],
                               "remove": [], "wire": [], "unwire": []}, headers=CODEX)
    assert response.status_code == 200, response.text
    assert _owner(pend, node) is None


# -- runs skip placeholders ------------------------------------------------------------------------------

def _execute_body(api):
    nodes, edges = api.graph.to_execute_format()
    return {"nodes": nodes, "edges": edges}


def _skips(api) -> dict[str, str]:
    return {m["nodeId"]: m["reason"] for m in api.sent if m.get("type") == "skipped"}


def test_the_toolbar_run_skips_placeholders_and_whats_downstream(pend):
    ids = _chain(pend)
    other = pend.graph.add_node("text-input", {"value": "the person's"})
    response = pend.client.post("/api/execute", headers=PERSON, json={**_execute_body(pend), "runId": "r1"})
    assert response.status_code == 200, response.text
    body = response.json()
    assert body["status"] == "started"
    assert body["pendingSkipped"] == {"count": 3, "agents": ["Claude Code"]}
    assert set(body["skipped"]) == set(ids.values())
    assert pend.ran == [[other]]
    assert pend.priced == [[other]]  # nothing priced, nothing spent, on a skipped node
    skips = _skips(pend)
    assert set(skips) == set(ids.values())
    # Each of the chain is a placeholder itself (the downstream reason is pinned in test_run_skips_unit).
    assert all("Claude Code" in skips[node_id] for node_id in ids.values())
    # The run never changed them.
    assert all(_owner(pend, node_id)["id"] == CLAUDE_ID for node_id in ids.values())


def test_a_run_with_only_placeholders_runs_nothing(pend):
    ids = _chain(pend)
    body = pend.client.post("/api/execute", headers=PERSON, json=_execute_body(pend)).json()
    assert body["pendingSkipped"]["count"] == 3
    assert pend.ran in ([], [[]])
    assert pend.priced in ([], [[]])
    assert all(_owner(pend, node_id) for node_id in ids.values())


def test_the_person_running_a_placeholder_directly_turns_it_normal_and_runs_it(pend):
    ids = _chain(pend)
    target = ids["+p"]
    response = pend.client.post("/api/execute-node", headers=PERSON,
                                json={**_execute_body(pend), "targetNodeId": target})
    assert response.status_code == 200, response.text
    assert _owner(pend, target) is None
    assert pend.ran == [[target]]
    assert response.json().get("pendingSkipped") is None
    # The others stay the agent's.
    assert _owner(pend, ids["+a"])["id"] == CLAUDE_ID


def test_the_person_running_a_node_downstream_of_placeholders_runs_them_all(pend):
    """GM: "The person running a pending node directly counts as their edit:
    it turns normal and runs." Running +b directly runs what feeds it (the
    run's scope is the node and its ancestors), so the placeholders it needs
    are the person's run too: all turn normal and run, nothing is skipped."""
    ids = _chain(pend)
    other = pend.graph.add_node("text-input", {"value": "not in this run"})
    response = pend.client.post("/api/execute-node", headers=PERSON,
                                json={**_execute_body(pend), "targetNodeId": ids["+b"]})
    assert response.status_code == 200, response.text
    assert response.json().get("pendingSkipped") is None
    assert _skips(pend) == {}
    assert pend.ran == [sorted(ids.values())]
    assert all(_owner(pend, node_id) is None for node_id in ids.values())
    assert other in pend.graph.nodes


def test_the_persons_direct_run_leaves_placeholders_outside_its_scope(pend):
    ids = _chain(pend)
    pend.client.post("/api/execute-node", headers=PERSON, json={**_execute_body(pend), "targetNodeId": ids["+a"]})
    assert pend.ran == [sorted([ids["+p"], ids["+a"]])]
    assert _owner(pend, ids["+b"])["id"] == CLAUDE_ID  # downstream of the target: not this run


# -- Q133: a paid placeholder in the person's direct run needs their confirmation ----------

def _paid_chain(api, headers=CLAUDE) -> dict[str, str]:
    """+p (free text) → +i (a paid image model), both the agent's placeholders."""
    body = {
        "note": "set up the hero still",
        "nodes": [{"ref": "+p", "definitionId": "text-input", "params": {"value": "a lighthouse"}},
                  {"ref": "+i", "definitionId": "nano-banana"}],
        "edges": [{"source": "+p", "sourceHandle": "text", "target": "+i", "targetHandle": "prompt"}],
        "rename": {"+i": "Hero still"},
        "pending": True,
    }
    response = _apply(api, body, headers)
    assert response.status_code == 200, response.text
    return response.json()["idMap"]


def _direct(pend, target, confirmed=None, headers=PERSON):
    body = {**_execute_body(pend), "targetNodeId": target}
    if confirmed is not None:
        body["confirmedPlaceholders"] = confirmed
    return pend.client.post("/api/execute-node", headers=headers, json=body)


@pytest.mark.parametrize("confirmed", [None, [], ["+p"], ["+i", "+p"], ["+i", "other"]])
def test_the_persons_direct_run_of_a_paid_placeholder_needs_their_confirmation(pend, confirmed):
    """Justin, Q133 b: "ALWAYS ask first when any of them is a paid model".
    The backend holds it too: a run that would make a paid placeholder normal
    runs only when the request names exactly those placeholders, so a missed
    dialog, a stale tab or another client can't skip it. Nothing runs, is
    priced or changes."""
    ids = _paid_chain(pend)
    named = None if confirmed is None else [ids.get(ref, ref) for ref in confirmed]
    response = _direct(pend, ids["+i"], named)
    assert response.status_code == 409, response.text
    detail = response.json()["detail"]
    assert detail["code"] == "placeholder_confirm_required"
    assert detail["placeholders"] == [ids["+i"]]
    assert "Claude Code is still setting up" in detail["message"]
    assert pend.ran == [] and pend.priced == []
    assert all(_owner(pend, node_id)["id"] == CLAUDE_ID for node_id in ids.values())


def test_the_confirmed_direct_run_runs_them_and_turns_them_normal(pend):
    ids = _paid_chain(pend)
    response = _direct(pend, ids["+i"], [ids["+i"]])
    assert response.status_code == 200, response.text
    assert pend.ran == [sorted(ids.values())]
    assert all(_owner(pend, node_id) is None for node_id in ids.values())


def test_free_placeholders_need_no_confirmation(pend):
    ids = _chain(pend)  # text-input and combine-text: free
    assert _direct(pend, ids["+b"]).status_code == 200


def test_an_agents_run_of_its_own_paid_placeholder_is_unchanged(pend):
    ids = _paid_chain(pend)
    response = _direct(pend, ids["+i"], headers=CLAUDE)
    assert response.status_code == 200, response.text
    assert _owner(pend, ids["+i"]) is None


# -- a refused run changes nothing ------------------------------------------------------------

def _refuse(pend, monkeypatch, refusal, node_id):
    from fastapi import HTTPException
    from models.events import ValidationErrorDetail

    if refusal == "precheck":
        monkeypatch.setattr(pend.main, "validate_graph", lambda *args, **kwargs: [ValidationErrorDetail(
            node_id=node_id, port_id="text2", message="Required input port 'text2' is not connected")])
    else:
        def over_the_limit(*args, **kwargs):
            raise HTTPException(status_code=403, detail="This run needs the person's OK")
        monkeypatch.setattr(pend.main, "_require_spend_approval", over_the_limit)


def _run_as(pend, route, headers, target):
    if route == "cli":
        return pend.client.post("/api/graph/run", headers=headers, json={"targetNodeId": target})
    if route == "execute":
        return pend.client.post("/api/execute", headers=headers, json=_execute_body(pend))
    return pend.client.post("/api/execute-node", headers=headers, json={**_execute_body(pend), "targetNodeId": target})


@pytest.mark.parametrize("refusal", ["precheck", "spend"])
@pytest.mark.parametrize("route", ["cli", "execute", "execute-node"])
def test_the_owning_agents_refused_run_leaves_its_placeholders_pending(pend, monkeypatch, route, refusal):
    """"Turns normal when the owning agent runs it": a run refused before it
    starts (the pre-call check, a cycle, the spend check) ran nothing, so the
    placeholders stay; the person's next Run still skips them."""
    ids = _chain(pend)
    _refuse(pend, monkeypatch, refusal, ids["+b"])
    response = _run_as(pend, route, CLAUDE, ids["+b"])
    assert pend.ran == []
    if refusal == "spend":
        assert response.status_code == 403, response.text
    assert all(_owner(pend, node_id)["id"] == CLAUDE_ID for node_id in ids.values())
    assert all(_synced_pending(pend, node_id) for node_id in ids.values())


@pytest.mark.parametrize("refusal", ["precheck", "spend"])
def test_the_persons_refused_direct_run_leaves_it_pending(pend, monkeypatch, refusal):
    ids = _chain(pend)
    _refuse(pend, monkeypatch, refusal, ids["+p"])
    _run_as(pend, "execute-node", PERSON, ids["+p"])
    assert pend.ran == []
    assert _owner(pend, ids["+p"])["id"] == CLAUDE_ID


def test_the_owning_agents_admitted_run_still_turns_them_normal_and_tells_the_canvas(pend):
    ids = _chain(pend)
    response = _run_as(pend, "execute-node", CLAUDE, ids["+b"])
    assert response.status_code == 200, response.text
    assert response.json().get("pendingSkipped") is None
    assert pend.ran == [sorted(ids.values())]
    assert all(_owner(pend, node_id) is None for node_id in ids.values())
    assert all(_synced_pending(pend, node_id) is None for node_id in ids.values())


def test_an_agents_run_skips_another_agents_placeholders(pend):
    ids = _chain(pend)
    other = pend.graph.add_node("text-input", {"value": "free"})
    result = pend.client.post("/api/graph/run", headers=CODEX, json={}).json()
    assert result["status"] == "finished"
    assert set(result["skipped"]) == set(ids.values())
    assert "Claude Code" in result["skipped"][ids["+p"]]
    assert set(result["results"]) == {other}
    assert pend.priced == [[other]]
    assert all(_owner(pend, node_id)["id"] == CLAUDE_ID for node_id in ids.values())
    # get_run reads the same skips: the run's kept result (each TestClient
    # request has its own event loop, so the route can't await the old task).
    kept = pend.main._cli_runs.get(result["runId"])["task"].result()
    assert set(kept["skipped"]) == set(ids.values())


def test_the_owning_agents_run_turns_its_placeholders_normal(pend):
    ids = _chain(pend)
    result = pend.client.post("/api/graph/run", headers=CLAUDE, json={"targetNodeId": ids["+b"]}).json()
    assert result["status"] == "finished", result
    assert result["skipped"] == {}
    assert set(result["results"]) == set(ids.values())
    assert all(_owner(pend, node_id) is None for node_id in ids.values())


def test_a_target_another_agent_holds_is_skipped_with_the_reason(pend):
    ids = _chain(pend)
    result = pend.client.post("/api/graph/run", headers=CODEX, json={"targetNodeId": ids["+a"]}).json()
    assert set(result["skipped"]) == {ids["+p"], ids["+a"]}
    assert result["nodesExecuted"] == 0
    assert pend.ran in ([], [[]])


def test_the_cli_prints_the_skips_like_a_gates(pend):
    from cli.formatter import format_run_results

    ids = _chain(pend)
    pend.graph.add_node("text-input", {"value": "free"})
    result = pend.client.post("/api/graph/run", headers=CODEX, json={}).json()
    text = format_run_results(result)
    assert f"{ids['+p']}: skipped" in text and "Claude Code" in text


def test_an_accepted_proposals_run_skips_a_placeholder_it_needs(pend):
    """The canvas runs an accepted proposal's nodes with the approval; a
    placeholder upstream is skipped (with what needs it), not run, and the
    approval still matches what the person accepted."""
    ids = _chain(pend, headers=CODEX)
    source = ids["+p"]
    body = {
        "note": "combine it",
        "nodes": [{"ref": "+c", "definitionId": "combine-text"}],
        "edges": [{"source": source, "sourceHandle": "text", "target": "+c", "targetHandle": "text1"}],
        "run": ["+c"],
    }
    proposal = pend.client.post("/api/canvas/proposals", headers=CLAUDE, json=body)
    assert proposal.status_code == 201, proposal.text
    proposal_id = proposal.json()["proposal"]["id"]
    accepted = pend.client.post(f"/api/canvas/proposals/{proposal_id}/accept",
                                headers={**PERSON, KEY: _key(pend, proposal_id)}, json={})
    assert accepted.status_code == 200, accepted.text
    made = accepted.json()
    run = pend.client.post("/api/execute-node", headers=PERSON, json={
        **_execute_body(pend), "targetNodeId": made["idMap"]["+c"], "approvalId": made["approvalId"]})
    assert run.status_code == 200, run.text
    assert set(run.json()["skipped"]) == {source, made["idMap"]["+c"]}
    assert _owner(pend, source)["id"] == CODEX_ID  # not the person running it directly
    assert pend.ran in ([], [[]])


def test_run_skips_unit():
    owner = {"id": "ext:codex", "name": "Codex", "color": "#F2C14E", "verified": False}
    nodes = {"n1": {"pending": {"agent": owner, "at": 0}}, "n2": {}, "n3": {}, "n4": {}}
    skips = pending_nodes.run_skips(["n1", "n2", "n3", "n4"], [("n1", "n2"), ("n2", "n3")], nodes,
                                    label=lambda node_id: "Hero" if node_id == "n1" else node_id)
    assert set(skips) == {"n1", "n2", "n3"}
    assert skips["n3"]["root"] == "n1" and "“Hero”" in skips["n3"]["reason"]
    assert pending_nodes.skip_summary(skips) == {"count": 3, "agents": ["Codex"]}
    assert pending_nodes.skip_summary({}) is None


# -- GM - Design's rulings of 2026-10-25, round 3 ------------------------------------------------------

def test_the_skip_line_names_the_agent_when_every_skip_is_one_agents():
    """GM: "The Run skip line names the agent when every skipped node belongs
    to one agent (downstream nodes count toward the agent whose pending node
    blocked them), and says "agents" only when they come from more than one"."""
    assert pending_nodes.skip_line({"count": 1, "agents": ["Codex"]}) == "Skipped 1 node Codex is still setting up."
    assert pending_nodes.skip_line({"count": 3, "agents": ["Codex"]}) == "Skipped 3 nodes Codex is still setting up."
    assert pending_nodes.skip_line({"count": 3, "agents": ["Codex", "Claude Code"]}) == (
        "Skipped 3 nodes agents are still setting up.")
    assert pending_nodes.skip_line(None) is None


def test_a_skipped_placeholders_reason_is_gms_tooltip_line(pend):
    """GM: the Skipped badge's tooltip on a skipped placeholder reads
    "Skipped: Codex is still setting this up." (the canvas puts "Skipped: "
    before the reason, lib/gating.ts skippedLabel)."""
    ids = _chain(pend, headers=CODEX)
    response = pend.client.post("/api/execute", headers=PERSON, json={**_execute_body(pend), "runId": "r-gm"})
    assert response.status_code == 200, response.text
    assert response.json()["skipped"][ids["+p"]] == "Codex is still setting this up."
    assert _skips(pend)[ids["+p"]] == "Codex is still setting this up."


def test_the_agent_log_line_counts_placeholder_skips(pend, monkeypatch):
    """The run's line in the Agent log (publish_action) counted a gate's skips
    only; a run that skipped placeholders says so in GM's skip line."""
    said: list[str] = []
    monkeypatch.setattr(pend.main, "publish_action", said.append)
    _chain(pend)  # Claude Code's three placeholders
    pend.graph.add_node("text-input", {"value": "free"})
    result = pend.client.post("/api/graph/run", headers=CODEX, json={}).json()
    assert result["nodesExecuted"] == 1
    ran = [line for line in said if line.startswith("Ran ")]
    assert len(ran) == 1, said
    assert ran[0].endswith(". Skipped 3 nodes Claude Code is still setting up."), ran[0]


def test_a_proposals_cost_leaves_out_what_its_run_will_skip(pend):
    """GM: every place the person sees a cost before a run matches what will
    actually run. An accepted proposal's run skips placeholders and what
    needs them (it isn't the person's direct run), so its cost leaves them out."""
    ids = _chain(pend, headers=CODEX)
    body = {
        "note": "combine it",
        "nodes": [{"ref": "+c", "definitionId": "combine-text"}, {"ref": "+free", "definitionId": "text-input",
                                                                   "params": {"value": "x"}}],
        "edges": [{"source": ids["+p"], "sourceHandle": "text", "target": "+c", "targetHandle": "text1"}],
        "run": ["+c", "+free"],
    }
    proposal = pend.client.post("/api/canvas/proposals", headers=CLAUDE, json=body)
    assert proposal.status_code == 201, proposal.text
    cost = proposal.json()["proposal"]["cost"]
    assert [entry["ref"] for entry in cost["nodes"]] == ["+free"]
    assert cost["freeRuns"] == 1 and cost["paidRuns"] == 0
    assert cost["pendingSkipped"] == {"count": 2, "agents": ["Codex"]}


def _undo(api, token, headers=CLAUDE):
    return api.client.post("/api/graph/apply/undo", headers=headers, json={"token": token})


def test_an_agents_undo_of_its_removal_brings_the_placeholder_back(pend):
    """The agent's own undo puts a removed placeholder back as the person's
    Cmd+Z does: with its flag, as the canvas had it."""
    ids = _chain(pend)
    node = ids["+b"]
    flag = dict(pend.graph.nodes[node]["pending"])
    removed = _apply(pend, {"note": "drop it", "remove": [node]})
    assert removed.status_code == 200, removed.text
    assert node not in pend.graph.nodes
    undone = _undo(pend, removed.json()["undo"]["token"])
    assert undone.status_code == 200, undone.text
    assert undone.json()["status"] == "undone"
    assert pend.graph.nodes[node]["pending"] == flag
    assert _synced_pending(pend, node)["agent"]["name"] == "Claude Code"


def test_an_agents_undo_of_pending_false_makes_them_placeholders_again(pend):
    ids = _chain(pend)
    node = ids["+a"]
    flag = dict(pend.graph.nodes[node]["pending"])
    ready = _apply(pend, {"note": "ready", "pending": False, "nodeIds": [node]})
    assert ready.status_code == 200, ready.text
    assert _owner(pend, node) is None
    assert ready.json()["undo"] is not None
    undone = _undo(pend, ready.json()["undo"]["token"])
    assert undone.status_code == 200, undone.text
    assert pend.graph.nodes[node]["pending"] == flag
    assert undone.json()["placeholders"] == [node]
    assert undone.json()["message"].startswith("Undone: made pending 1.")


def test_an_agents_undo_never_puts_a_flag_on_a_node_someone_else_ran_since(pend):
    ids = _chain(pend)
    node = ids["+p"]
    ready = _apply(pend, {"note": "ready", "pending": False, "nodeIds": [node]})
    token = ready.json()["undo"]["token"]
    run = pend.client.post("/api/execute-node", headers=PERSON, json={**_execute_body(pend), "targetNodeId": node})
    assert run.status_code == 200, run.text
    undone = _undo(pend, token)
    assert undone.status_code == 200, undone.text
    assert _owner(pend, node) is None
