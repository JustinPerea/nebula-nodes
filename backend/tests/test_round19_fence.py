"""Round 19 of PR #195 (review 18, H-A and H-B): the write fence moves to
the backend.

- A canvas tab's graph write (any request with ``X-Nebula-Tab`` on the
  guarded routes: /api/graph, /api/execute, /api/cinema, /api/quick) must
  carry the workspace revision. Without it Nebula answers 409 with the
  canvas's out-of-date line. Agents, the CLI and MCP send no tab header and
  are unchanged.
- Nebula keeps a canvas revision (the open project's id epoch, the one
  #114's ``_graph_fence`` reads), new on every clear and every import. A tab
  sends the one it had when the person acted (``X-Nebula-Canvas-Revision``);
  a write made for a canvas that was cleared or replaced since is refused
  with the same line, so a held write never lands on a new node that reuses
  an old id.
- The tab learns the revision from every graphSync, from GET
  /api/graph/export, and from the answers to a clear, an import, an open
  and a create.
- A save addressed to a named project (the handoff save after an agent's
  switch) is not a guarded route: the header rule never blocks it.
- A param write merges the keys it carries (key-level): a person's write of
  one key leaves an agent's edit of another key as it is.
"""
from __future__ import annotations

import pytest
from fastapi.testclient import TestClient

from services.agent_presence import AgentPresence
from services.canvas_events import CanvasEventJournal
from services.canvas_pins import CanvasPins
from services.canvas_proposals import ProposalBook
from services.cli_graph import CLIGraph
from services.project_store import ProjectStore, make_project
from services.provider_recovery import ProviderRecoveryStore
from services.provider_start_guard import ProviderStartGuard
from tests.conftest import PERSON

AGENT = {"X-Nebula-Agent": "Claude"}
TAB = "tab-0123456789abcdef"
STALE = "This canvas is out of date. Open the current project before editing or running it."


@pytest.fixture
def api(tmp_path, monkeypatch, person):
    import main as main_module

    graph = CLIGraph(persist_path=tmp_path / "state.json")
    store = ProjectStore(tmp_path / "projects")
    with store.transaction() as catalog:
        first = make_project("Active")
        second = make_project("Other")
        catalog["projects"][first["id"]] = first
        catalog["projects"][second["id"]] = second
        catalog["activeProjectId"] = first["id"]
        store.commit(catalog)
    sent: list[dict] = []

    async def capture(data):
        sent.append(data)

    monkeypatch.setattr(main_module, "cli_graph", graph)
    monkeypatch.setattr(main_module, "project_store", store)
    monkeypatch.setattr(main_module, "canvas_pins", CanvasPins(lambda: main_module.project_store))
    monkeypatch.setattr(main_module, "canvas_proposals", ProposalBook())
    monkeypatch.setattr(main_module, "agent_presence", AgentPresence())
    monkeypatch.setattr(main_module, "canvas_events", CanvasEventJournal())
    monkeypatch.setattr(main_module, "provider_recovery_store", ProviderRecoveryStore(None))
    monkeypatch.setattr(main_module, "provider_start_guard", ProviderStartGuard(tmp_path / "paid-starts.json"))
    monkeypatch.setattr(main_module, "_graph_recovery_bootstrap_error", None)
    monkeypatch.setattr(main_module.manager, "broadcast_raw", capture)
    monkeypatch.setattr(main_module.manager, "broadcast_browser", capture)

    class Api:
        pass

    ctx = Api()
    ctx.main = main_module
    ctx.client = TestClient(main_module.app)
    ctx.graph = graph
    ctx.store = store
    ctx.sent = sent
    ctx.first = first["id"]
    ctx.second = second["id"]
    return ctx


def _revision(api) -> str:
    return api.store.workspace()["workspaceRevision"]


def _canvas(api) -> str:
    return api.client.get("/api/graph/export").json()["canvasRevision"]


def _tab(api, canvas: str | None = None, revision: str | None = None) -> dict[str, str]:
    headers = {**PERSON, "X-Nebula-Tab": TAB, "X-Nebula-Workspace-Revision": revision or _revision(api)}
    if canvas is not None:
        headers["X-Nebula-Canvas-Revision"] = canvas
    return headers


def _syncs(api) -> list[dict]:
    return [event for event in api.sent if event.get("type") == "graphSync"]


def _text(api, value: str = "a") -> str:
    return api.graph.add_node("text-input", {"value": value}, position={"x": 0, "y": 0})


# -- the header rule ----------------------------------------------------------

def test_a_tab_write_with_no_revision_is_refused_with_the_stale_line(api):
    node = _text(api)
    no_revision = {**PERSON, "X-Nebula-Tab": TAB}
    refused = api.client.put(f"/api/graph/node/{node}", headers=no_revision, json={"params": {"value": "B"}})
    assert refused.status_code == 409
    assert refused.json()["detail"] == STALE
    assert api.graph.nodes[node]["params"]["value"] == "a"
    gone = api.client.delete(f"/api/graph/node/{node}", headers=no_revision)
    assert gone.status_code == 409 and gone.json()["detail"] == STALE
    assert node in api.graph.nodes


@pytest.mark.parametrize("path,method,body", [
    ("/api/graph/node", "POST", {"definitionId": "text-input", "params": {}, "position": {"x": 0, "y": 0}}),
    ("/api/graph/restore", "POST", {"nodes": [], "remove": [], "wire": [], "unwire": []}),
    ("/api/graph?force=true", "DELETE", None),
    ("/api/execute", "POST", {"nodes": [], "edges": []}),
    ("/api/quick", "POST", {}),
    ("/api/cinema/generate-shot", "POST", {}),
])
def test_every_guarded_route_needs_the_revision_from_a_tab(api, path, method, body):
    response = api.client.request(method, path, headers={**PERSON, "X-Nebula-Tab": TAB}, json=body)
    assert response.status_code == 409, response.text
    assert response.json()["detail"] == STALE


def test_agents_and_scripts_send_no_tab_header_and_are_unchanged(api):
    node = _text(api)
    agent = api.client.put(f"/api/graph/node/{node}", headers=AGENT, json={"params": {"value": "AG"}})
    assert agent.status_code == 200, agent.text
    script = api.client.put(f"/api/graph/node/{node}", json={"params": {"value": "CLI"}})
    assert script.status_code == 200, script.text
    assert api.graph.nodes[node]["params"]["value"] == "CLI"


def test_a_tab_write_with_the_revision_passes(api):
    node = _text(api)
    response = api.client.put(f"/api/graph/node/{node}", headers=_tab(api, _canvas(api)), json={"params": {"value": "B"}})
    assert response.status_code == 200, response.text
    assert api.graph.nodes[node]["params"]["value"] == "B"


def test_reads_never_need_it(api):
    assert api.client.get("/api/graph/export", headers={**PERSON, "X-Nebula-Tab": TAB}).status_code == 200


def test_the_handoff_save_to_the_project_left_is_not_blocked_by_the_header_rule(api):
    # An agent's open: the tab still holds the first project's revision and
    # saves its canvas into that project by id (projectStore.followProjectSwitch).
    old_revision = _revision(api)
    opened = api.client.post(f"/api/projects/{api.second}/open", headers=AGENT, json={"workspaceRevision": old_revision})
    assert opened.status_code == 200, opened.text
    saved = api.client.get(f"/api/projects/{api.first}").json()
    snapshot = {**saved["snapshot"], "nodes": [{"id": "n1", "type": "model-node", "position": {"x": 0, "y": 0},
                                                "data": {"definitionId": "text-input", "label": "Text",
                                                         "params": {"value": "typed"}, "state": "idle", "outputs": {}}}]}
    handoff = api.client.put(f"/api/projects/{api.first}", headers={**PERSON, "X-Nebula-Tab": TAB,
                                                                    "X-Nebula-Workspace-Revision": old_revision},
                             json={"snapshot": snapshot, "workspaceRevision": old_revision})
    assert handoff.status_code == 200, handoff.text
    kept = api.client.get(f"/api/projects/{api.first}").json()["snapshot"]["nodes"]
    assert kept[0]["data"]["params"]["value"] == "typed"


# -- the canvas revision ------------------------------------------------------

def test_the_canvas_revision_rides_on_every_sync_and_on_the_export(api):
    node = _text(api)
    first = _canvas(api)
    assert isinstance(first, str)
    api.client.put(f"/api/graph/node/{node}", headers=AGENT, json={"params": {"value": "AG"}})
    assert _syncs(api)[-1]["canvasRevision"] == first


@pytest.mark.parametrize("who", ["person", "agent"])
def test_a_clear_moves_the_canvas_revision_and_its_answer_says_the_new_one(api, who):
    _text(api)
    before = _canvas(api)
    headers = _tab(api, before) if who == "person" else AGENT
    cleared = api.client.delete("/api/graph?force=true", headers=headers)
    assert cleared.status_code == 200, cleared.text
    after = _canvas(api)
    assert after != before
    assert cleared.json()["canvasRevision"] == after
    # The clear's own sync already carries the new one.
    assert _syncs(api)[-1]["canvasRevision"] == after


def test_an_import_moves_the_canvas_revision(api):
    _text(api)
    before = _canvas(api)
    imported = api.client.post("/api/graph/import", headers=AGENT, json={
        "nodes": [{"id": "x", "definitionId": "text-input", "params": {"value": "i"}, "position": {"x": 0, "y": 0}}],
        "edges": []})
    assert imported.status_code == 200, imported.text
    assert _canvas(api) != before
    assert imported.json()["canvasRevision"] == _canvas(api)
    assert _syncs(api)[-1]["canvasRevision"] == _canvas(api)


def test_a_write_held_across_an_agent_clear_never_reaches_the_new_node_with_the_old_id(api):
    """C1: the held PUT names n2; after the clear an agent's n2 is a new node."""
    _text(api, "n1")
    old_n2 = _text(api, "n2")
    held = _canvas(api)
    api.client.delete("/api/graph?force=true", headers=AGENT)
    _text(api, "AG1")
    new_n2 = _text(api, "AG2")
    assert new_n2 == old_n2
    refused = api.client.put(f"/api/graph/node/{new_n2}", headers=_tab(api, held), json={"params": {"value": "B"}})
    assert refused.status_code == 409
    assert refused.json()["detail"] == STALE
    assert api.graph.nodes[new_n2]["params"]["value"] == "AG2"


def test_a_restore_held_across_an_import_is_refused(api):
    node = _text(api, "x")
    held = _canvas(api)
    api.client.post("/api/graph/import", headers=AGENT, json={
        "nodes": [{"id": "a", "definitionId": "text-input", "params": {"value": "AG1"}, "position": {"x": 0, "y": 0}}],
        "edges": []})
    restore = api.client.post("/api/graph/restore", headers=_tab(api, held), json={
        "nodes": [{"id": node, "definitionId": "text-input", "params": {"value": "old"}, "position": {"x": 0, "y": 0}}],
        "remove": [], "wire": [], "unwire": []})
    assert restore.status_code == 409 and restore.json()["detail"] == STALE
    assert api.graph.nodes[node]["params"]["value"] == "AG1"


def test_a_tab_that_sends_no_canvas_revision_is_checked_on_the_workspace_revision_only(api):
    node = _text(api)
    response = api.client.put(f"/api/graph/node/{node}", headers=_tab(api), json={"params": {"value": "B"}})
    assert response.status_code == 200, response.text


def test_open_and_create_answers_carry_the_canvas_revision(api):
    opened = api.client.post(f"/api/projects/{api.second}/open", headers=PERSON,
                             json={"workspaceRevision": _revision(api)})
    assert opened.status_code == 200, opened.text
    assert opened.json()["canvasRevision"] == _canvas(api)
    created = api.client.post("/api/projects", headers=PERSON, json={"name": "New", "workspaceRevision": _revision(api)})
    assert created.status_code == 200, created.text
    assert created.json()["canvasRevision"] == _canvas(api)


# -- key-level param writes (M-C, L-C) ----------------------------------------

def test_a_param_write_merges_only_the_keys_it_carries(api):
    node = api.graph.add_node("combine-text", {"separator": ",", "template": "x"}, position={"x": 0, "y": 0})
    agent = api.client.put(f"/api/graph/node/{node}", headers=AGENT, json={"params": {"template": "AG"}})
    assert agent.status_code == 200, agent.text
    person = api.client.put(f"/api/graph/node/{node}", headers=_tab(api, _canvas(api)), json={"params": {"separator": ";"}})
    assert person.status_code == 200, person.text
    assert api.graph.nodes[node]["params"]["separator"] == ";"
    assert api.graph.nodes[node]["params"]["template"] == "AG"
