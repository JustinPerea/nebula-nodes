"""Q118 (Justin, 2026-10-23, option a): "Let Load graph open bigger .nebula
files (up to the 512 MiB it already allows for a bundle) as a new project. A
project over 16 MiB still can't be saved, so the canvas says so, and you
remove what you don't need until it saves."

The backend half:
- one measure of a project's size, the bytes the save check counts
  (services/project_size.py), pinned with the frontend's to the same shared
  cases (tests/fixtures/project_size_cases.json);
- a save over the limit says it was the size, and how big, beside the same
  `detail` agents read (`limit: "size"`, `sizeBytes`, `limitBytes`);
- GET /api/projects/{id}/size: the project's size and what is large, for
  agents (MCP project_size, `nebula project size`), the open one with the
  live canvas in it;
- an agent's edit that would leave the open project over the limit, larger
  than it was, is refused with the agents' own text naming project_size;
  edits that make it smaller go through, and the person's own Load graph is
  never refused;
- a project that was stored over the limit (a switch keeps the live canvas
  in the project it leaves) still opens: the canvas then pauses its saving
  instead of the project being stuck.
"""
from __future__ import annotations

import json
from pathlib import Path

import pytest
from fastapi.testclient import TestClient

from services.agent_presence import AgentPresence
from services.canvas_arrange import ArrangeBook
from services.canvas_events import CanvasEventJournal
from services.canvas_pins import CanvasPins
from services.canvas_proposals import ProposalBook
from services.cli_graph import CLIGraph
from services.project_store import ProjectStore, make_project
from services.provider_recovery import ProviderRecoveryStore
from services.provider_start_guard import ProviderStartGuard
from tests.conftest import PERSON

AGENT = {"X-Nebula-Agent": "Claude Desktop"}
CASES = json.loads((Path(__file__).resolve().parent / "fixtures" / "project_size_cases.json").read_text(encoding="utf-8"))
# Small enough that a few kilobytes of text is "over" in these tests.
LIMIT = 8 * 1024


def _plain_bytes(snapshot: dict) -> int:
    """The save check's own expression, as it was written before the measure
    had a name (main._stage_project_snapshot)."""
    return len(json.dumps(snapshot, allow_nan=False, ensure_ascii=False).encode("utf-8"))


@pytest.fixture
def api(tmp_path, monkeypatch, person):
    import main as main_module

    graph = CLIGraph(persist_path=tmp_path / "state.json")
    store = ProjectStore(tmp_path / "projects")
    with store.transaction() as catalog:
        project = make_project("Glass campaign")
        catalog["projects"][project["id"]] = project
        catalog["activeProjectId"] = project["id"]
        store.commit(catalog)
    sent: list[dict] = []

    async def capture(data):
        sent.append(data)

    monkeypatch.setattr(main_module, "cli_graph", graph)
    monkeypatch.setattr(main_module, "project_store", store)
    monkeypatch.setattr(main_module, "canvas_pins", CanvasPins(lambda: main_module.project_store))
    monkeypatch.setattr(main_module, "canvas_proposals", ProposalBook())
    monkeypatch.setattr(main_module, "canvas_arrange", ArrangeBook())
    monkeypatch.setattr(main_module, "agent_presence", AgentPresence())
    monkeypatch.setattr(main_module, "canvas_events", CanvasEventJournal())
    monkeypatch.setattr(main_module, "provider_recovery_store", ProviderRecoveryStore(None))
    monkeypatch.setattr(main_module, "provider_start_guard", ProviderStartGuard(tmp_path / "paid-starts.json"))
    monkeypatch.setattr(main_module, "_graph_recovery_bootstrap_error", None)
    monkeypatch.setattr(main_module.manager, "broadcast_raw", capture)
    monkeypatch.setattr(main_module.manager, "broadcast_browser", capture)
    monkeypatch.setattr(main_module, "MAX_PROJECT_BYTES", LIMIT)

    class Api:
        pass

    ctx = Api()
    ctx.client = TestClient(main_module.app)
    ctx.graph = graph
    ctx.store = store
    ctx.project_id = project["id"]
    ctx.main = main_module
    return ctx


def _revision(api) -> str:
    return api.client.get("/api/projects").json()["workspaceRevision"]


def _snapshot(text: str) -> dict:
    return {"nodes": [{"id": "n1", "type": "model-node", "position": {"x": 0, "y": 0},
                       "data": {"definitionId": "text-input", "label": "Brief", "params": {"value": text},
                                "state": "idle", "outputs": {}}}],
            "edges": [], "runHistory": [], "viewport": None, "createSessionId": None}


# -- one measure -------------------------------------------------------------------

@pytest.mark.parametrize("case", CASES["cases"], ids=lambda case: case["name"])
def test_the_measure_is_the_save_checks_bytes_on_the_shared_cases(case):
    from services.project_size import breakdown, snapshot_bytes

    assert CASES["limitBytes"] == 16 * 1024 * 1024
    assert snapshot_bytes(case["snapshot"]) == case["bytes"] == _plain_bytes(case["snapshot"])
    rows = breakdown(case["snapshot"])["rows"]
    keys = ("kind", "nodeId", "part", "count", "bytes")
    assert [{key: row[key] for key in keys if key in row} for row in rows] == case["rows"]
    # Every byte is in a row.
    assert sum(row["bytes"] for row in rows) == case["bytes"]


def test_the_limit_is_still_16_mib():
    import services.project_store as store_module

    assert store_module.MAX_PROJECT_BYTES == 16 * 1024 * 1024


# -- a save over the limit -----------------------------------------------------------

def test_a_save_over_the_limit_says_it_was_the_size_and_how_big(api):
    snapshot = _snapshot("x" * (LIMIT + 100))
    response = api.client.put(f"/api/projects/{api.project_id}", headers=PERSON,
                              json={"snapshot": snapshot, "workspaceRevision": _revision(api)})
    assert response.status_code == 413
    body = response.json()
    # Word for word, as agents and the CLI read it.
    assert body["detail"] == "Project snapshot exceeds the 16 MiB limit"
    assert body["limit"] == "size"
    assert body["sizeBytes"] == _plain_bytes(snapshot)
    assert body["limitBytes"] == LIMIT


def test_a_save_at_the_limit_saves(api):
    filler = "x" * (LIMIT - _plain_bytes(_snapshot("")))
    snapshot = _snapshot(filler)
    assert _plain_bytes(snapshot) == LIMIT
    response = api.client.put(f"/api/projects/{api.project_id}", headers=PERSON,
                              json={"snapshot": snapshot, "workspaceRevision": _revision(api)})
    assert response.status_code == 200, response.text


# -- the size, for agents --------------------------------------------------------------

def test_the_size_route_reads_the_open_project_with_the_live_canvas_in_it(api):
    big = api.graph.add_node("text-input", {"value": "y" * (LIMIT + 500)})
    api.graph.add_node("text-input", {"value": "small"})
    response = api.client.get(f"/api/projects/{api.project_id}/size", headers=AGENT)
    assert response.status_code == 200, response.text
    body = response.json()
    assert body["project"] == {"id": api.project_id, "name": "Glass campaign", "open": True}
    assert body["limitBytes"] == LIMIT and body["sizeBytes"] > LIMIT
    assert body["overLimit"] is True and body["savingPaused"] is True
    assert body["overByBytes"] == body["sizeBytes"] - LIMIT
    first = body["largest"][0]
    assert first["kind"] == "node" and first["nodeId"] == big and first["part"] == "Text"
    assert first["name"] == "Text Input" and first["definitionId"] == "text-input"
    assert sum(row["bytes"] for row in body["largest"]) + body["smaller"]["bytes"] == body["sizeBytes"]
    assert "project_size" not in body["note"] and "smaller" in body["note"]

    # The same number a listing then stores for it: the live canvas overlaid.
    api.client.get("/api/projects")
    stored = api.client.get(f"/api/projects/{api.project_id}", headers=PERSON).json()["snapshot"]
    assert body["sizeBytes"] == _plain_bytes(stored)


def test_the_size_route_on_a_project_under_the_limit(api):
    api.graph.add_node("text-input", {"value": "small"})
    body = api.client.get(f"/api/projects/{api.project_id}/size", headers=AGENT).json()
    assert body["overLimit"] is False and body["savingPaused"] is False and body["overByBytes"] == 0
    assert api.client.get("/api/projects/" + "f" * 32 + "/size", headers=AGENT).status_code == 404


def test_the_size_route_shows_ten_rows_and_counts_the_rest(api):
    for index in range(14):
        api.graph.add_node("text-input", {"value": "z" * (100 + index)})
    body = api.client.get(f"/api/projects/{api.project_id}/size", headers=AGENT).json()
    assert len(body["largest"]) == 10
    # Fourteen nodes and the project's own settings: five more rows.
    assert body["smaller"]["count"] == 5
    sizes = [row["bytes"] for row in body["largest"]]
    assert sizes == sorted(sizes, reverse=True)


# -- agents can't push a project past the limit -------------------------------------------

def _apply(api, body, headers=AGENT):
    return api.client.post("/api/graph/apply", headers=headers, json=body)


def test_an_agent_edit_that_would_push_the_project_over_is_refused_with_the_agents_text(api):
    before = {node_id: dict(node) for node_id, node in api.graph.nodes.items()}
    response = _apply(api, {"nodes": [{"ref": "+big", "definitionId": "text-input",
                                        "params": {"value": "q" * (LIMIT + 1)}}]})
    assert response.status_code == 413, response.text
    body = response.json()
    assert body["limit"] == "size" and body["limitBytes"] == LIMIT and body["sizeBytes"] > LIMIT
    assert "project_size" in body["detail"] and "nebula project size" in body["detail"]
    assert "Nothing changed" in body["detail"]
    assert {node_id: dict(node) for node_id, node in api.graph.nodes.items()} == before


def test_an_agent_can_shrink_a_paused_project_but_not_grow_it(api):
    # The person's Load graph put a big graph on the canvas: saving is paused.
    big = api.graph.add_node("text-input", {"value": "p" * (LIMIT + 400)})
    other = api.graph.add_node("text-input", {"value": "keep"})

    grows = _apply(api, {"nodes": [{"ref": "+n", "definitionId": "text-input", "params": {"value": "more"}}]})
    assert grows.status_code == 413
    assert "already over" in grows.json()["detail"] and "project_size" in grows.json()["detail"]

    shorter = _apply(api, {"params": [{"nodeId": big, "params": {"value": "p" * (LIMIT + 10)}}]})
    assert shorter.status_code == 200, shorter.text
    removed = _apply(api, {"remove": [big]})
    assert removed.status_code == 200, removed.text
    assert set(api.graph.nodes) == {other}


def test_the_other_agent_routes_refuse_growth_past_the_limit_too(api):
    node = api.graph.add_node("text-input", {"value": "short"})
    added = api.client.post("/api/graph/node", headers=AGENT,
                            json={"definitionId": "text-input", "params": {"value": "a" * (LIMIT + 1)}})
    assert added.status_code == 413 and added.json()["limit"] == "size"
    assert "project_size" in added.json()["detail"]
    changed = api.client.put(f"/api/graph/node/{node}", headers=AGENT, json={"params": {"value": "b" * (LIMIT + 1)}})
    assert changed.status_code == 413 and changed.json()["limit"] == "size"
    assert api.graph.nodes[node]["params"]["value"] == "short"
    imported = api.client.post("/api/graph/import", headers=AGENT, json={
        "nodes": [{"id": "x1", "definitionId": "text-input", "params": {"value": "c" * (LIMIT + 1)}}], "edges": []})
    assert imported.status_code == 413 and imported.json()["limit"] == "size"
    assert set(api.graph.nodes) == {node}


def test_the_persons_own_load_graph_and_edits_are_never_refused_for_size(api):
    imported = api.client.post("/api/graph/import", headers=PERSON, json={
        "nodes": [{"id": "x1", "definitionId": "text-input", "params": {"value": "d" * (LIMIT + 1)}}], "edges": []})
    assert imported.status_code == 200, imported.text
    [node] = api.graph.nodes
    changed = api.client.put(f"/api/graph/node/{node}", headers=PERSON, json={"params": {"value": "e" * (LIMIT + 9)}})
    assert changed.status_code == 200, changed.text


def test_a_tab_without_the_persons_token_is_asked_to_reconnect_not_shown_the_agents_text(api):
    # A canvas tab whose person token is from before Nebula restarted carries
    # no agent marker and no current token: the person gate's refusal, so the
    # tab shows GM's reconnect line (the detail stays behind Details), not a
    # pause or the agents' text as its reason. Reconnected, it goes through.
    node = api.graph.add_node("text-input", {"value": "short"})
    imported = api.client.post("/api/graph/import", json={
        "nodes": [{"id": "x1", "definitionId": "text-input", "params": {"value": "c" * (LIMIT + 1)}}], "edges": []})
    assert imported.status_code == 403, imported.text
    assert imported.json()["code"] == "person_required"
    assert "project_size" in imported.json()["detail"]
    cluster = api.client.post("/api/graph/cluster", json={
        "nodes": [{"tempId": "t1", "definitionId": "text-input", "params": {"value": "c" * (LIMIT + 1)}}], "edges": []})
    assert cluster.status_code == 403 and cluster.json()["code"] == "person_required"
    assert set(api.graph.nodes) == {node}
    # An agent still gets the size refusal it reads, with no code.
    by_agent = api.client.post("/api/graph/cluster", headers=AGENT, json={
        "nodes": [{"tempId": "t1", "definitionId": "text-input", "params": {"value": "c" * (LIMIT + 1)}}], "edges": []})
    assert by_agent.status_code == 413 and by_agent.json()["limit"] == "size" and "code" not in by_agent.json()


# -- a project stored over the limit still opens -------------------------------------------

def test_a_project_stored_over_the_limit_opens_instead_of_being_stuck(api):
    big = api.graph.add_node("text-input", {"value": "s" * (LIMIT + 300)})
    # Switching away keeps the live canvas in the project it leaves.
    made = api.client.post("/api/projects", headers=PERSON, json={"name": "Other", "workspaceRevision": _revision(api)})
    assert made.status_code == 200, made.text
    stored = api.store.read()["projects"][api.project_id]["snapshot"]
    assert _plain_bytes(stored) > LIMIT
    opened = api.client.post(f"/api/projects/{api.project_id}/open", headers=PERSON,
                             json={"workspaceRevision": _revision(api)})
    assert opened.status_code == 200, opened.text
    assert any(node["id"] == big for node in opened.json()["project"]["snapshot"]["nodes"])
    # It still can't be saved as it is.
    snapshot = opened.json()["project"]["snapshot"]
    saved = api.client.put(f"/api/projects/{api.project_id}", headers=PERSON,
                           json={"snapshot": snapshot, "workspaceRevision": opened.json()["workspaceRevision"]})
    assert saved.status_code == 413 and saved.json()["limit"] == "size"


# -- review (2026-10-23): every agent path, and the shortcut's bound ---------------------

def _size(api) -> int:
    return api.client.get(f"/api/projects/{api.project_id}/size", headers=AGENT).json()["sizeBytes"]


def _fill_to(api, node: str, target: int) -> None:
    """Set ``node``'s text so the open project measures exactly ``target``."""
    value = api.graph.nodes[node]["params"]["value"]
    api.graph.set_params(node, {"value": value + "f" * (target - _size(api))})
    assert _size(api) == target


def test_a_stored_history_full_of_separators_doesnt_slip_past_the_shortcut(api):
    """The catalog is written compact; the save check measures with ", " and
    ": " spacing, up to 1.5x as many bytes for a history of short values. An
    agent's edit that leaves the project over is refused even when the
    catalog file plus the new canvas is under the limit."""
    from services import project_size

    with api.store.transaction() as catalog:
        catalog["projects"][api.project_id]["snapshot"]["runHistory"] = [[0] * 1400]
        api.store.commit(catalog)
    catalog_bytes = api.store.path.stat().st_size
    base = _size(api)
    probe = api.graph.add_node("text-input", {"value": ""})
    overhead = _size(api) - base
    api.graph.remove_node(probe)
    value = "v" * (LIMIT + 50 - base - overhead)
    # The case the shortcut let through: catalog plus canvas under the limit,
    # the measured project over it.
    after = api.graph.clone()
    after.add_node("text-input", {"value": value})
    assert catalog_bytes + project_size.json_bytes(api.main._graph_canvas_export(after)) <= LIMIT
    response = _apply(api, {"nodes": [{"ref": "+big", "definitionId": "text-input", "params": {"value": value}}]})
    assert response.status_code == 413, response.text
    # Just over (the new node's position spells a digit or two differently).
    assert response.json()["limit"] == "size" and LIMIT < response.json()["sizeBytes"] <= LIMIT + 100
    assert api.graph.nodes == {}


def test_an_agents_undo_that_would_put_the_project_back_over_is_refused(api):
    big = api.graph.add_node("text-input", {"value": "u" * (LIMIT + 400)})
    removed = _apply(api, {"remove": [big]})
    assert removed.status_code == 200, removed.text
    assert _size(api) <= LIMIT
    token = removed.json()["undo"]["token"]
    undone = api.client.post("/api/graph/apply/undo", headers=AGENT, json={"token": token})
    assert undone.status_code == 413, undone.text
    body = undone.json()
    assert body["limit"] == "size" and "project_size" in body["detail"] and "Nothing changed" in body["detail"]
    assert big not in api.graph.nodes
    # Still usable once there is room (the refusal changed nothing, the token included).
    with pytest.MonkeyPatch.context() as patch:
        patch.setattr(api.main, "MAX_PROJECT_BYTES", LIMIT * 4)
        again = api.client.post("/api/graph/apply/undo", headers=AGENT, json={"token": token})
    assert again.status_code == 200, again.text
    assert again.json()["status"] == "undone" and big in api.graph.nodes


def test_an_agents_restore_is_refused_too_but_the_persons_undo_never_is(api):
    item = {"id": "n9", "definitionId": "text-input", "params": {"value": "r" * (LIMIT + 1)}}
    by_agent = api.client.post("/api/graph/restore", headers=AGENT, json={"action": "undo", "nodes": [item]})
    assert by_agent.status_code == 413 and by_agent.json()["limit"] == "size"
    assert "n9" not in api.graph.nodes
    by_person = api.client.post("/api/graph/restore", headers=PERSON, json={"action": "undo", "nodes": [item]})
    assert by_person.status_code == 200, by_person.text
    assert "n9" in api.graph.nodes


def test_the_clis_connect_and_rename_refuse_growth_past_the_limit(api):
    text = api.graph.add_node("text-input", {"value": "x"})
    image = api.graph.add_node("gpt-image-2-5-generate", {})
    _fill_to(api, text, LIMIT - 20)
    wire = {"source": text, "sourceHandle": "text", "target": image, "targetHandle": "prompt"}
    wired = api.client.post("/api/graph/connect", headers=AGENT, json=wire)
    assert wired.status_code == 413 and wired.json()["limit"] == "size", wired.text
    assert api.graph.edges == []
    renamed = api.client.put(f"/api/graph/node/{text}/label", headers=AGENT, json={"label": "A much longer name " * 3})
    assert renamed.status_code == 413 and renamed.json()["limit"] == "size", renamed.text
    assert "label" not in api.graph.nodes[text]
    # The person's own are never refused.
    assert api.client.post("/api/graph/connect", headers=PERSON, json=wire).status_code == 200
    assert api.client.put(f"/api/graph/node/{text}/label", headers=PERSON,
                          json={"label": "A much longer name " * 3}).status_code == 200


def test_each_rows_size_is_the_panels_nearest_tenth(api):
    """The panel shows a row to the nearest tenth of a MB, halves up
    (lib/projectSize.ts rowSize); the tool says the same for the same row."""
    from services.project_size import row_size

    for case in CASES["rowSizes"]:
        assert row_size(case["bytes"]) == case["size"], case
    api.graph.add_node("text-input", {"value": "w" * 40_000})  # 0.04 MB: "0.0", not rounded up
    body = api.client.get(f"/api/projects/{api.project_id}/size", headers=AGENT).json()
    for row in body["largest"]:
        assert row["size"] == row_size(row["bytes"]), row
    assert body["largest"][0]["size"] == "0.0 MB"
