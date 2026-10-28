"""Round 20 of PR #195 (review 19): the handoff keeps the person's typing,
every route that writes the graph is fenced by a marker, the canvas revision
survives a restart, and a run admitted before a clear never writes back onto
the new node that reuses its id.

- H1. The handoff save after an agent's switch (``PUT /api/projects/{id}``
  with the switch's revision) names the keys the tab knows Nebula may not
  have (``pendingParams: {nodeId: {key: value}}``) and renames it hadn't sent
  (``pendingLabels: {nodeId: name | null}``). Those keys, taken from the
  staged snapshot node, are merged onto the stored copy; everything else keeps
  the stored copy. A merge Nebula can't make refuses the whole handoff (409).
- H2. The fence reads a marker on the matched route (``graph_write``), not a
  path prefix. /api/uploads is fenced when it creates a node, with the check
  in the same step as the add. Every non-GET route is marked or on the
  allowlist below, each with why it doesn't touch the graph.
- M2. The canvas revision (``canvas_undo_book.epoch``) is kept in the state
  dir (canvas-revisions.json), written before the canvas changes.
- L3. A run notes its canvas at admission; its params and outputs write-backs
  are dropped when that canvas was cleared or replaced since.
"""
from __future__ import annotations

import asyncio
import json
import os
import subprocess
import sys
from pathlib import Path

import pytest
from fastapi.routing import APIRoute
from fastapi.testclient import TestClient

from models import GraphNode
from models.events import ExecutedEvent
from models.graph import ExecuteNodeRequest, ExecuteRequest
from services.agent_presence import AgentPresence
from services.canvas_events import CanvasEventJournal
from services.canvas_pins import CanvasPins
from services.canvas_proposals import ProposalBook
from services.canvas_undo import CanvasUndoBook
from services.cli_graph import CLIGraph
from services.project_store import ProjectStore, make_project
from services.provider_recovery import ProviderRecoveryStore
from services.provider_start_guard import ProviderStartGuard
from tests.conftest import PERSON

AGENT = {"X-Nebula-Agent": "Claude"}
TAB = "tab-0123456789abcdef"
STALE = "This canvas is out of date. Open the current project before editing or running it."
BACKEND = Path(__file__).resolve().parents[1]


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

    book = CanvasUndoBook(persist_path=tmp_path / "canvas-revisions.json")
    monkeypatch.setattr(main_module, "cli_graph", graph)
    monkeypatch.setattr(main_module, "canvas_undo_book", book)
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
    chat = tmp_path / "chat-uploads"
    chat.mkdir()
    monkeypatch.setattr(main_module, "CHAT_UPLOADS_DIR", chat)

    class Api:
        pass

    ctx = Api()
    ctx.main = main_module
    ctx.client = TestClient(main_module.app)
    ctx.graph = graph
    ctx.book = book
    ctx.store = store
    ctx.sent = sent
    ctx.tmp = tmp_path
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


# ---------------------------------------------------------------------------
# H1: the handoff save keeps the person's typing


def _switch_away(api) -> tuple[str, dict]:
    """An agent opens the other project; the project left as Nebula stored it."""
    old_revision = _revision(api)
    opened = api.client.post(f"/api/projects/{api.second}/open", headers=AGENT, json={"workspaceRevision": old_revision})
    assert opened.status_code == 200, opened.text
    return old_revision, api.client.get(f"/api/projects/{api.first}").json()["snapshot"]


def _with(snapshot: dict, node_id: str, *, params: dict | None = None, label: object = ...,
          definition: str | None = None) -> dict:
    nodes = []
    for node in snapshot["nodes"]:
        if node["id"] == node_id:
            data = {**node["data"]}
            if params is not None:
                data["params"] = {**data["params"], **params}
            if label is not ...:
                data["label"] = label
            if definition is not None:
                data["definitionId"] = definition
            node = {**node, "data": data}
        nodes.append(node)
    return {**snapshot, "nodes": nodes}


def _handoff(api, old_revision: str, snapshot: dict, **extra):
    return api.client.put(f"/api/projects/{api.first}", headers={**PERSON, "X-Nebula-Tab": TAB,
                          "X-Nebula-Workspace-Revision": old_revision},
                          json={"snapshot": snapshot, "workspaceRevision": old_revision, **extra})


def _stored(api, node_id: str) -> dict:
    nodes = api.client.get(f"/api/projects/{api.first}").json()["snapshot"]["nodes"]
    return next(node for node in nodes if node["id"] == node_id)


def test_H1_the_handoff_keeps_typing_on_a_node_nebula_had(api):
    node = api.graph.add_node("text-input", {"value": "a"}, position={"x": 0, "y": 0})
    old_revision, saved = _switch_away(api)
    answer = _handoff(api, old_revision, _with(saved, node, params={"value": "typed"}),
                      pendingParams={node: {"value": "typed"}})
    assert answer.status_code == 200, answer.text
    assert answer.json()["handoff"] is True
    assert _stored(api, node)["data"]["params"]["value"] == "typed"


def test_H1_reopening_the_project_puts_the_typing_on_the_live_graph(api):
    node = api.graph.add_node("text-input", {"value": "a"}, position={"x": 0, "y": 0})
    old_revision, saved = _switch_away(api)
    assert _handoff(api, old_revision, _with(saved, node, params={"value": "typed"}),
                    pendingParams={node: {"value": "typed"}}).status_code == 200
    back = api.client.post(f"/api/projects/{api.first}/open", headers=PERSON, json={"workspaceRevision": _revision(api)})
    assert back.status_code == 200, back.text
    assert api.graph.nodes[node]["params"]["value"] == "typed"


def test_H1_an_agents_edit_of_another_key_on_the_same_node_survives(api):
    node = api.graph.add_node("combine-text", {"separator": ",", "template": "x"}, position={"x": 0, "y": 0})
    assert api.client.put(f"/api/graph/node/{node}", headers=AGENT, json={"params": {"template": "AG"}}).status_code == 200
    old_revision, saved = _switch_away(api)
    # The tab never heard the agent's edit: its copy still says "x".
    tab = _with(saved, node, params={"separator": ";", "template": "x"})
    assert _handoff(api, old_revision, tab, pendingParams={node: {"separator": ";"}}).status_code == 200
    params = _stored(api, node)["data"]["params"]
    assert params["separator"] == ";"
    assert params["template"] == "AG"


def test_H1_values_come_from_the_staged_snapshot_not_the_side_list(api):
    node = api.graph.add_node("text-input", {"value": "a"}, position={"x": 0, "y": 0})
    old_revision, saved = _switch_away(api)
    answer = _handoff(api, old_revision, _with(saved, node, params={"value": "typed"}),
                      pendingParams={node: {"value": "something else"}})
    assert answer.status_code == 200, answer.text
    assert _stored(api, node)["data"]["params"]["value"] == "typed"


def test_H1_a_key_the_staged_node_lacks_refuses_the_save(api):
    """Round 21 (GM's G4): a key that isn't a setting of the node refuses the
    save with its own form, so the tab keeps it as a copy (it was dropped
    silently before)."""
    node = api.graph.add_node("combine-text", {"separator": ",", "template": "x"}, position={"x": 0, "y": 0})
    old_revision, saved = _switch_away(api)
    tab = _with(saved, node, params={"separator": ";"})
    answer = _handoff(api, old_revision, tab, pendingParams={node: {"separator": ";", "nothere": "v"}})
    assert answer.status_code == 409, answer.text
    assert answer.json()["detail"] == ("Nebula couldn't keep this save's unsent changes in the project because "
                                       "“nothere” isn't a setting on that node, so nothing was saved.")
    assert _stored(api, node)["data"]["params"]["separator"] == ","


def test_H1_without_pending_keys_the_stored_copy_wins_as_before(api):
    node = api.graph.add_node("text-input", {"value": "a"}, position={"x": 0, "y": 0})
    old_revision, saved = _switch_away(api)
    assert _handoff(api, old_revision, _with(saved, node, params={"value": "dropped undo"})).status_code == 200
    assert _stored(api, node)["data"]["params"]["value"] == "a"


def test_H1_a_rename_it_hadnt_sent_is_kept_and_null_goes_back_to_the_models_name(api):
    node = api.graph.add_node("text-input", {"value": "a"}, position={"x": 0, "y": 0})
    other = api.graph.add_node("text-input", {"value": "b"}, position={"x": 0, "y": 200})
    api.graph.set_label(other, "Old name")
    old_revision, saved = _switch_away(api)
    tab = _with(_with(saved, node, label="Hero prompt"), other, label="Text Input")
    answer = _handoff(api, old_revision, tab, pendingLabels={node: "Hero prompt", other: None})
    assert answer.status_code == 200, answer.text
    assert _stored(api, node)["data"]["label"] == "Hero prompt"
    assert _stored(api, other)["data"].get("label") in (None, "Text Input")
    back = api.client.post(f"/api/projects/{api.first}/open", headers=PERSON, json={"workspaceRevision": _revision(api)})
    assert back.status_code == 200, back.text
    assert api.graph.nodes[node].get("label") == "Hero prompt"
    assert "label" not in api.graph.nodes[other]


def test_H1_a_node_only_the_tab_had_is_added_as_before(api):
    api.graph.add_node("text-input", {"value": "a"}, position={"x": 0, "y": 0})
    old_revision, saved = _switch_away(api)
    extra = {**saved["nodes"][0], "id": "tab-only", "data": {**saved["nodes"][0]["data"], "params": {"value": "mine"}}}
    snapshot = {**saved, "nodes": [*saved["nodes"], extra]}
    answer = _handoff(api, old_revision, snapshot, pendingParams={"tab-only": {"value": "mine"}})
    assert answer.status_code == 200, answer.text
    assert _stored(api, "tab-only")["data"]["params"]["value"] == "mine"


@pytest.mark.parametrize("case", ["missing-node", "definition", "not-object", "bad-entry", "bad-label"])
def test_H1_a_merge_nebula_cant_make_refuses_the_whole_handoff(api, case):
    node = api.graph.add_node("text-input", {"value": "a"}, position={"x": 0, "y": 0})
    old_revision, saved = _switch_away(api)
    snapshot = _with(saved, node, params={"value": "typed"})
    extra: dict = {"pendingParams": {node: {"value": "typed"}}}
    if case == "missing-node":
        extra = {"pendingParams": {"n99": {"value": "typed"}}}
    elif case == "definition":
        snapshot = _with(saved, node, definition="combine-text")
        snapshot["nodes"][0]["data"]["params"] = {"separator": ";"}
        extra = {"pendingParams": {node: {"separator": ";"}}}
    elif case == "not-object":
        extra = {"pendingParams": [node]}
    elif case == "bad-entry":
        extra = {"pendingParams": {node: "typed"}}
    elif case == "bad-label":
        extra = {"pendingLabels": {node: 7}}
    answer = _handoff(api, old_revision, snapshot, **extra)
    assert answer.status_code == 409, answer.text
    assert isinstance(answer.json()["detail"], str) and answer.json()["detail"]
    # Nothing was saved: the project keeps what Nebula stored at the switch.
    assert _stored(api, node)["data"]["params"]["value"] == "a"
    # And the handoff is still open for a save that Nebula can merge.
    retry = _handoff(api, old_revision, _with(saved, node, params={"value": "typed"}),
                     pendingParams={node: {"value": "typed"}})
    assert retry.status_code == 200, retry.text


def test_H1_an_ordinary_autosave_ignores_the_fields(api):
    node = api.graph.add_node("text-input", {"value": "a"}, position={"x": 0, "y": 0})
    snapshot = api.client.get(f"/api/projects/{api.first}").json()["snapshot"]
    saved = api.client.put(f"/api/projects/{api.first}", headers=_tab(api), json={
        "snapshot": {**snapshot, "nodes": api.client.get("/api/graph/export").json()["nodes"]},
        "workspaceRevision": _revision(api), "pendingParams": "not checked here", "pendingLabels": 3})
    assert saved.status_code == 200, saved.text
    assert "handoff" not in saved.json()
    assert node in api.graph.nodes


# ---------------------------------------------------------------------------
# H2: every route that writes the graph is fenced, by a marker on the route

# Non-GET routes that are neither fenced nor change the canvas's graph. Each
# says why. A new route that writes cli_graph or starts work on the canvas
# gets main.graph_write instead (this test fails until it is one or the other).
ALLOWLIST: dict[tuple[str, str], str] = {
    # Krea connection (routes/krea_connector.py): the account link and its MCP tools; no cli_graph access.
    ("POST", "/api/krea/connection/connect"): "links the Krea account; no graph",
    ("POST", "/api/krea/connection/check"): "checks the Krea link; no graph",
    ("DELETE", "/api/krea/connection"): "unlinks the Krea account; no graph",
    ("POST", "/api/krea/tools/call"): "proxies a Krea MCP tool for Settings; the module never touches cli_graph",
    ("POST", "/api/krea/trial"): "starts a Krea trial checkout; no graph",
    # Outputs on disk.
    ("POST", "/api/outputs/archive"): "moves output files to the archive; no node changes",
    ("POST", "/api/outputs/restore"): "moves archived files back; no node changes",
    # Renders (routes/video_edit_preview.py, routes/render_exports.py): render jobs from the request body.
    ("POST", "/api/video-edit/preview-render"): "renders a preview file from the request body; writes no node",
    ("POST", "/api/video-edit/export"): "starts an export job from the request body; writes no node",
    ("POST", "/api/remotion-render"): "starts a render job from the request body; writes no node",
    ("DELETE", "/api/render-jobs/{job_id}"): "cancels a render job; no graph",
    # Paper sources (services/paper_routes.py): the linked-file store; the node reads it, nothing writes the node.
    ("POST", "/api/paper/sources"): "links a Paper file in the source store; no graph",
    ("POST", "/api/paper/sources/{source_id}/open"): "opens the Paper file in Paper; no graph",
    ("POST", "/api/paper/sources/{source_id}/refresh"): "re-reads the Paper file into the source store; no graph",
    ("POST", "/api/paper/sources/{source_id}/reconnect"): "relinks the Paper file; no graph",
    # Commons (routes/commons.py): the references library; the module never touches cli_graph.
    ("POST", "/api/commons/collections"): "Commons library; no graph",
    ("PATCH", "/api/commons/collections/{collection_id}"): "Commons library; no graph",
    ("POST", "/api/commons/search"): "Commons search; no graph",
    ("POST", "/api/commons/intake/files"): "Commons intake; no graph",
    ("POST", "/api/commons/intake/url"): "Commons intake; no graph",
    ("POST", "/api/commons/intake/moodboards"): "Commons intake; no graph",
    ("POST", "/api/commons/add"): "Commons add; no graph",
    ("POST", "/api/commons/add/upload"): "Commons add; no graph",
    ("POST", "/api/commons/folders"): "Commons folder link; no graph",
    ("PATCH", "/api/commons/folders/{link_id}"): "Commons folder link; no graph",
    ("POST", "/api/commons/folders/{link_id}/rescan"): "Commons folder rescan; no graph",
    ("PATCH", "/api/commons/memberships/{membership_id}"): "Commons membership; no graph",
    ("POST", "/api/commons/memberships/{membership_id}/accept"): "Commons membership; no graph",
    ("POST", "/api/commons/assets/{asset_id}/corrections"): "Commons asset notes; no graph",
    ("POST", "/api/commons/assets/{asset_id}/regions"): "Commons asset regions; no graph",
    ("PATCH", "/api/commons/regions/{region_id}"): "Commons asset regions; no graph",
    ("POST", "/api/commons/assets/{asset_id}/reanalyze"): "Commons analysis; no graph",
    ("POST", "/api/commons/reanalyze-stale"): "Commons analysis; no graph",
    ("DELETE", "/api/commons/assets/{asset_id}"): "Commons purge; no graph",
    ("POST", "/api/commons/comments"): "Commons comments; no graph",
    ("POST", "/api/commons/borrow"): "records a borrowing and returns references; the canvas adds nodes through graph routes",
    ("POST", "/api/commons/borrowings/{borrowing_id}/fidelity"): "Commons borrowing notes; no graph",
    ("PATCH", "/api/commons/settings"): "Commons settings; no graph",
    ("POST", "/api/commons/worker/start"): "Commons worker; no graph",
    ("POST", "/api/commons/worker/stop"): "Commons worker; no graph",
    ("POST", "/api/commons/evaluation/prepare"): "Commons evaluation; no graph",
    ("POST", "/api/commons/evaluation/items/{position}/accents"): "Commons evaluation; no graph",
    ("PUT", "/api/commons/evaluation/items/{position}/labels"): "Commons evaluation; no graph",
    ("POST", "/api/commons/evaluation/seal"): "Commons evaluation; no graph",
    ("POST", "/api/commons/evaluation/close"): "Commons evaluation; no graph",
    ("POST", "/api/commons/review/items/{position}/propose"): "Commons review; no graph",
    ("PUT", "/api/commons/review/items/{position}"): "Commons review; no graph",
    # Agents and their settings.
    ("POST", "/api/personal-agents"): "personal agent settings; no graph",
    ("PUT", "/api/personal-agents/{agent_id}"): "personal agent settings; no graph",
    ("DELETE", "/api/personal-agents/{agent_id}"): "personal agent settings; no graph",
    ("POST", "/api/personal-agents/antigravity/install"): "installs a local agent; no graph",
    ("DELETE", "/api/personal-agents/antigravity/install"): "removes a local agent; no graph",
    ("POST", "/api/personal-agents/antigravity/sign-in"): "agent sign-in; no graph",
    ("DELETE", "/api/personal-agents/antigravity/sign-in"): "agent sign-in; no graph",
    ("POST", "/api/personal-agents/antigravity/sign-out"): "agent sign-out; no graph",
    ("POST", "/api/personal-agents/acknowledge-warning"): "agent warning notice; no graph",
    ("POST", "/api/agent/spend/apps"): "agent spending apps; no graph",
    ("PUT", "/api/agent/spend/apps/{app_id}"): "agent spending apps; no graph",
    ("DELETE", "/api/agent/spend/apps/{app_id}"): "agent spending apps; no graph",
    ("POST", "/api/agents/codex/login/chatgpt"): "agent sign-in; no graph",
    # Presence and notes beside the canvas: never the graph.
    ("POST", "/api/canvas/selection"): "publishes which nodes are selected (ephemeral); no graph write",
    ("POST", "/api/canvas/cursor"): "an agent's cursor; no graph",
    ("POST", "/api/canvas/status"): "an agent's status line; no graph",
    ("POST", "/api/canvas/view"): "the canvas's viewport report; no graph",
    ("POST", "/api/canvas/agent-notes"): "Updates on the project record; no graph",
    ("POST", "/api/canvas/agent-notes/read"): "Updates read state; no graph",
    ("POST", "/api/canvas/agent-notes/{note_id}/dismiss"): "Updates dismiss; no graph",
    ("POST", "/api/moodboards/{moodboard_id}/agent-notes"): "a board's Updates; no graph",
    ("POST", "/api/moodboards/{moodboard_id}/agent-notes/read"): "a board's Updates; no graph",
    ("POST", "/api/moodboards/{moodboard_id}/agent-notes/{note_id}/dismiss"): "a board's Updates; no graph",
    # Proposals: agents propose; accept is bound to the project and canvas it was made on.
    ("POST", "/api/canvas/proposals"): "an agent proposes; nothing changes until the person accepts",
    ("DELETE", "/api/canvas/proposals/{proposal_id}"): "an agent withdraws its proposal; no graph",
    ("POST", "/api/canvas/proposals/{proposal_id}/accept"): (
        "project-bound: refused unless its own project is open and its canvas revision hasn't moved "
        "since it was made (_ensure_still_decidable, proposal.canvas_revision)"),
    ("POST", "/api/canvas/proposals/{proposal_id}/reject"): "closes the proposal; no graph",
    ("DELETE", "/api/canvas/approvals/{approval_id}"): "releases a run approval; no graph",
    ("POST", "/api/canvas/questions"): "an agent's questions; no graph",
    ("DELETE", "/api/canvas/questions/{set_id}"): "an agent's questions; no graph",
    ("POST", "/api/canvas/questions/{set_id}/answer"): "the person's answers; no graph",
    ("POST", "/api/canvas/questions/{set_id}/dismiss"): "the person's answers; no graph",
    ("POST", "/api/asset-proposals"): "moodboard and cover proposals; no graph",
    ("POST", "/api/asset-proposals/{proposal_id}/accept"): "changes a moodboard or a cover; no graph",
    ("POST", "/api/asset-proposals/{proposal_id}/reject"): "closes the proposal; no graph",
    # Settings and keys.
    ("POST", "/api/zoom-manifest/init"): "dev zoom recorder file; no graph",
    ("POST", "/api/zoom-manifest/entry"): "dev zoom recorder file; no graph",
    ("PUT", "/api/settings"): "settings; no graph",
    ("DELETE", "/api/settings/api-keys/{provider}"): "settings; no graph",
    ("POST", "/api/credentials/update"): "settings; no graph",
    # Runs already going: Stop must work while the tab follows an agent's switch.
    ("DELETE", "/api/executions/{run_id}"): "Stop: cancels a run by its id, works while following a switch",
    ("DELETE", "/api/execution-cancellations/{run_id}"): "acknowledges a Stop by run id; no new write",
    ("DELETE", "/api/provider-start-ambiguities/{kind}/{node_id}/{run_id}"): (
        "unlocks a paid-start hold in the provider guard (status bar, any screen); writes no node"),
    ("POST", "/api/pricing/input-sizes"): "measures inputs for a price; reads only",
    ("POST", "/api/universal/ports"): "a model's ports without a node; reads only",
    # Projects: each names its project by id or checks the body's workspaceRevision (_project_revision).
    ("POST", "/api/projects/recover"): "saves a recovered copy as a new project; never the live graph",
    ("POST", "/api/projects"): "the person's or an agent's create: checked by the body's workspaceRevision",
    ("POST", "/api/projects/{project_id}/open"): "the person's or an agent's open: checked by the body's workspaceRevision",
    ("PUT", "/api/projects/{project_id}"): (
        "saves by project id, checked by the body's workspaceRevision; the handoff after an agent's switch "
        "must land, and on a reopen writes the tab's own unsent keys to the live graph (person's tab only)"),
    ("PUT", "/api/projects/{project_id}/cover"): "the project card's picture; no graph",
    ("DELETE", "/api/projects/{project_id}"): "moves a project to the trash: checked by its own revision rule",
    ("POST", "/api/projects/{project_id}/restore"): "restores a trashed project to the list; no live graph",
    ("DELETE", "/api/projects/trash/{project_id}"): "purges a trashed project; no live graph",
    ("POST", "/api/projects/trash/empty"): "purges the trash; no live graph",
    ("POST", "/api/enhance-prompt"): "returns enhanced text; the canvas writes it through PUT /api/graph/node",
    # Characters, moodboards, presets, trash: their own stores.
    ("POST", "/api/characters"): "character store; no graph",
    ("PUT", "/api/characters/{char_id}"): "character store; no graph",
    ("DELETE", "/api/characters/{char_id}"): "character store; no graph",
    ("POST", "/api/characters/{char_id}/move"): "character store; no graph",
    ("POST", "/api/moodboards"): "moodboard store; no graph",
    ("PUT", "/api/moodboards/{moodboard_id}"): "moodboard store; no graph",
    ("POST", "/api/moodboards/{moodboard_id}/edits"): "moodboard store; no graph",
    ("POST", "/api/moodboards/{moodboard_id}/brief-override/keep"): "moodboard store; no graph",
    ("POST", "/api/moodboards/{moodboard_id}/analyze"): "moodboard analysis; no graph",
    ("POST", "/api/moodboards/{moodboard_id}/analyze/dry-run"): "moodboard analysis estimate; no graph",
    ("POST", "/api/moodboards/{moodboard_id}/read/estimate"): "moodboard read estimate; no graph",
    ("POST", "/api/moodboards/{moodboard_id}/read"): "moodboard read; no graph",
    ("DELETE", "/api/moodboards/{moodboard_id}"): "moodboard store; no graph",
    ("POST", "/api/moodboards/{moodboard_id}/move"): "moodboard store; no graph",
    ("POST", "/api/trash/{kind}/{item_id}/restore"): "boards and characters trash; no graph",
    ("DELETE", "/api/trash/{kind}/{item_id}"): "boards and characters trash; no graph",
    ("POST", "/api/trash/empty"): "boards and characters trash; no graph",
    ("POST", "/api/presets"): "preset store; no graph",
    ("PUT", "/api/presets/{preset_id}"): "preset store; no graph",
    ("DELETE", "/api/presets/{preset_id}"): "preset store; no graph",
    # Files.
    ("POST", "/api/reveal"): "shows a file in Finder; no graph",
    ("POST", "/api/export"): "copies a file out; no graph",
    ("POST", "/api/transcode-image"): "converts an image file; no graph",
}


def _non_get_routes(app) -> list[tuple[str, str, object]]:
    found = []
    for route in app.routes:
        if isinstance(route, APIRoute):
            for method in sorted(route.methods - {"GET", "HEAD", "OPTIONS"}):
                found.append((method, route.path, route.endpoint))
    return found


def test_H2_every_non_get_route_is_fenced_or_allowlisted():
    import main

    marked, unmarked = [], []
    for method, path, endpoint in _non_get_routes(main.app):
        fence = getattr(endpoint, main.GRAPH_FENCE_ATTR, None)
        if fence is not None:
            assert fence in {main.FENCE_BEFORE_ROUTE, main.FENCE_IN_ROUTE}, (method, path, fence)
            assert (method, path) not in ALLOWLIST, f"{method} {path} is fenced and allowlisted"
            marked.append((method, path))
        elif (method, path) not in ALLOWLIST:
            unmarked.append((method, path))
    assert unmarked == [], f"neither fenced (main.graph_write) nor allowlisted: {unmarked}"
    present = {(method, path) for method, path, _ in _non_get_routes(main.app)}
    assert sorted(set(ALLOWLIST) - present) == [], "allowlisted routes that no longer exist"
    assert all(reason.strip() for reason in ALLOWLIST.values())
    # The routes the old prefix list guarded are all still fenced, and the new ones.
    for expected in [("POST", "/api/execute"), ("POST", "/api/execute-node"), ("POST", "/api/quick"),
                     ("POST", "/api/cinema/generate-shot"), ("POST", "/api/cinema/promote-shot-variation"),
                     ("POST", "/api/cinema/send-to-motion"), ("DELETE", "/api/graph"),
                     ("POST", "/api/graph/run"), ("POST", "/api/graph/import"), ("PUT", "/api/graph/layout"),
                     ("POST", "/api/uploads"), ("DELETE", "/api/provider-recoveries/{run_id}/{node_id}")]:
        assert expected in marked, expected


def test_H2_the_fence_reads_the_route_not_the_path(api):
    import main

    # The middleware finds the route the request matches and reads its marker.
    assert main._graph_fence_of("PUT", "/api/graph/node/n1") == main.FENCE_BEFORE_ROUTE
    assert main._graph_fence_of("POST", "/api/uploads") == main.FENCE_IN_ROUTE
    assert main._graph_fence_of("DELETE", "/api/executions/run-1") is None
    assert main._graph_fence_of("PUT", f"/api/projects/{api.first}") is None
    assert main._graph_fence_of("GET", "/api/graph/export") is None
    assert main._graph_fence_of("POST", "/api/graph/no-such-route") is None


def test_H2_stop_and_the_project_save_still_pass_from_a_tab_with_no_revision(api):
    no_revision = {**PERSON, "X-Nebula-Tab": TAB}
    stop = api.client.delete("/api/executions/no-such-run", headers=no_revision)
    assert stop.json().get("detail") != STALE, stop.text
    fenced = api.client.delete("/api/provider-recoveries/run-1/n1?resume_operation_id=op", headers=no_revision)
    assert fenced.status_code == 409 and fenced.json()["detail"] == STALE


def _png() -> bytes:
    return bytes.fromhex(
        "89504e470d0a1a0a0000000d49484452000000010000000108060000001f15c4"
        "890000000d49444154789c6300010000000500010d0a2db40000000049454e44"
        "ae426082"
    )


def _drop(api, headers: dict, *, create: str = "true", name: str = "drop.png", content: bytes | None = None):
    return api.client.post("/api/uploads", headers=headers,
                           files={"file": (name, content if content is not None else _png(), "image/png")},
                           data={"create_node": create, "x": "10", "y": "10"})


def test_H2_U1_a_drop_made_for_the_project_left_is_refused(api):
    old, canvas = _revision(api), _canvas(api)
    assert api.client.post(f"/api/projects/{api.second}/open", headers=AGENT,
                           json={"workspaceRevision": old}).status_code == 200
    answer = _drop(api, _tab(api, canvas, revision=old))
    assert answer.status_code == 409, answer.text
    assert answer.json()["detail"] == STALE
    assert api.graph.nodes == {}


def test_H2_U2_a_drop_with_no_revision_from_a_tab_is_refused(api):
    answer = _drop(api, {**PERSON, "X-Nebula-Tab": TAB})
    assert answer.status_code == 409, answer.text
    assert answer.json()["detail"] == STALE
    assert api.graph.nodes == {}


def test_H2_an_upload_that_makes_no_node_needs_no_revision(api):
    answer = _drop(api, {**PERSON, "X-Nebula-Tab": TAB}, create="false")
    assert answer.status_code == 200, answer.text
    assert "nodeId" not in answer.json()


def test_H2_the_person_and_agents_still_drop_onto_the_open_canvas(api):
    mine = _drop(api, _tab(api, _canvas(api)))
    assert mine.status_code == 200, mine.text
    agent = _drop(api, AGENT, name="agent.png", content=_png() + b"\x00")
    assert agent.status_code == 200, agent.text
    assert sorted(api.graph.nodes) == ["n1", "n2"]


def test_H2_the_upload_checks_in_the_step_that_adds_the_node(api, monkeypatch):
    """The canvas is cleared while the upload awaits its video probe: the
    drop was made for the old canvas, so no node is added to the new one."""
    import main

    canvas = _canvas(api)

    class Probe:
        duration, fps, is_vfr = 1.0, 24.0, False

    async def probe_while_an_agent_clears(_path):
        main._forget_canvas_undo("the canvas was cleared since")
        return Probe()

    monkeypatch.setattr(main, "ffprobe_video", probe_while_an_agent_clears)
    video = b"\x00\x00\x00\x18ftypmp42" + b"\x00" * 64
    answer = api.client.post("/api/uploads", headers=_tab(api, canvas),
                             files={"file": ("clip.mp4", video, "video/mp4")}, data={"create_node": "true"})
    assert answer.status_code == 409, answer.text
    assert answer.json()["detail"] == STALE
    assert api.graph.nodes == {}


# ---------------------------------------------------------------------------
# M2: the canvas revision survives a restart


def test_M2_a_new_book_on_the_same_file_keeps_every_projects_revision(tmp_path):
    path = tmp_path / "canvas-revisions.json"
    book = CanvasUndoBook(persist_path=path)
    book.forget_project("p_one", "cleared")
    book.forget_project(None, "cleared")
    book.forget_project(None, "cleared")
    again = CanvasUndoBook(persist_path=path)
    assert again.epoch("p_one") == 1
    assert again.epoch(None) == 2
    assert again.epoch("p_other") == 0
    stored = json.loads(path.read_text())
    assert stored == {"version": 1, "projects": {"p_one": 1}, "unfiled": 2}


def test_M2_without_a_path_nothing_is_written(tmp_path):
    book = CanvasUndoBook()
    book.forget_project("p_one", "cleared")
    assert book.epoch("p_one") == 1
    assert list(tmp_path.iterdir()) == []


def test_M2_mains_book_lives_in_the_state_dir():
    import main

    assert main.canvas_undo_book.persist_path == main._STATE_DIR / "canvas-revisions.json"


def test_M2_a_storage_error_never_breaks_a_clear(tmp_path):
    blocker = tmp_path / "not-a-dir"
    blocker.write_text("")
    book = CanvasUndoBook(persist_path=blocker / "canvas-revisions.json")
    book.forget_project("p_one", "cleared")
    assert book.epoch("p_one") == 1


def test_M2_an_unreadable_file_starts_from_zero(tmp_path):
    path = tmp_path / "canvas-revisions.json"
    path.write_text("{not json")
    assert CanvasUndoBook(persist_path=path).epoch("p_one") == 0


def _disk_epoch(api, project_id) -> int:
    stored = json.loads((api.tmp / "canvas-revisions.json").read_text())
    return stored["unfiled"] if project_id is None else stored["projects"].get(project_id, 0)


def test_M2_a_clear_writes_the_new_revision_before_the_canvas_changes(api, monkeypatch):
    api.graph.add_node("text-input", {"value": "a"}, position={"x": 0, "y": 0})
    seen: list[int] = []
    real_clear = api.graph.clear

    def clear():
        seen.append(_disk_epoch(api, api.first))
        real_clear()

    monkeypatch.setattr(api.graph, "clear", clear)
    assert api.client.delete("/api/graph?force=true", headers=AGENT).status_code == 200
    assert seen == [1]


def test_M2_an_import_writes_the_new_revision_before_the_canvas_changes(api, monkeypatch):
    import main

    seen: list[int] = []
    real_commit = main._commit_graph_candidate_with_recoveries

    def commit(*args, **kwargs):
        seen.append(_disk_epoch(api, api.first))
        return real_commit(*args, **kwargs)

    monkeypatch.setattr(main, "_commit_graph_candidate_with_recoveries", commit)
    body = {"nodes": [{"id": "a", "definitionId": "text-input", "params": {"value": "x"}}], "edges": []}
    answer = api.client.post("/api/graph/import", headers=AGENT, json=body)
    assert answer.status_code == 200, answer.text
    assert seen == [1]
    assert answer.json()["canvasRevision"] == "1"


def test_M2_an_import_that_fails_to_commit_leaves_the_revision_as_it_was(api, monkeypatch):
    import main

    def fail(*_args, **_kwargs):
        raise main.HTTPException(status_code=507, detail="disk full")

    monkeypatch.setattr(main, "_commit_graph_candidate_with_recoveries", fail)
    body = {"nodes": [{"id": "a", "definitionId": "text-input", "params": {"value": "x"}}], "edges": []}
    assert api.client.post("/api/graph/import", headers=AGENT, json=body).status_code == 507
    assert _canvas(api) == "0"
    assert CanvasUndoBook(persist_path=api.tmp / "canvas-revisions.json").epoch(api.first) == 0


def _restart(api, monkeypatch) -> None:
    """What a backend restart keeps: the graph file and the revision file."""
    import main

    graph = CLIGraph(persist_path=api.tmp / "state.json")
    graph.load(api.tmp / "state.json")
    monkeypatch.setattr(main, "cli_graph", graph)
    monkeypatch.setattr(main, "canvas_undo_book", CanvasUndoBook(persist_path=api.tmp / "canvas-revisions.json"))
    api.graph = graph


def test_M2_a_restart_keeps_the_revision_and_a_held_write_still_lands(api, monkeypatch):
    api.graph.add_node("text-input", {"value": "a"}, position={"x": 0, "y": 0})
    cleared = api.client.delete("/api/graph?force=true", headers=_tab(api, _canvas(api)))
    assert cleared.json()["canvasRevision"] == "1"
    node = api.client.post("/api/graph/node", headers=_tab(api, "1"),
                           json={"definitionId": "text-input", "params": {"value": "b"}}).json()["id"]
    _restart(api, monkeypatch)
    assert _canvas(api) == "1"
    sync = api.client.get("/api/graph/export").json()
    assert [n["id"] for n in sync["nodes"]] == [node]
    held = api.client.put(f"/api/graph/node/{node}", headers=_tab(api, "1"), json={"params": {"value": "typed"}})
    assert held.status_code == 200, held.text
    assert api.graph.nodes[node]["params"]["value"] == "typed"
    again = api.client.delete("/api/graph?force=true", headers=AGENT)
    assert again.json()["canvasRevision"] == "2"
    stale = api.client.put(f"/api/graph/node/{node}", headers=_tab(api, "1"), json={"params": {"value": "x"}})
    assert stale.status_code == 409


def _boot(state: Path, code: str) -> str:
    env = {**os.environ, "NEBULA_STATE_DIR": str(state)}
    result = subprocess.run([sys.executable, "-c", code], cwd=BACKEND, env=env, capture_output=True, text=True,
                            timeout=240)
    assert result.returncode == 0, result.stderr[-2000:]
    return result.stdout.strip().splitlines()[-1]


def test_M2_a_real_restart_keeps_the_unfiled_canvas_revision(tmp_path):
    state = tmp_path / "state"
    first = _boot(state, (
        "import main\n"
        "from fastapi.testclient import TestClient\n"
        "client = TestClient(main.app)\n"
        "assert client.delete('/api/graph?force=true').status_code == 200\n"
        "print(client.get('/api/graph/export').json()['canvasRevision'])\n"))
    assert first == "1"
    assert _boot(state, "import main\nprint(main._canvas_revision())") == "1"


def test_M2_a_boot_whose_graph_file_fails_to_load_moves_the_revision(tmp_path):
    state = tmp_path / "state"
    state.mkdir()
    (state / "canvas-revisions.json").write_text(json.dumps({"version": 1, "projects": {}, "unfiled": 3}))
    (state / "state.json").write_text("{broken")
    assert _boot(state, "import main\nprint(main._canvas_revision())") == "4"


# ---------------------------------------------------------------------------
# L3: a run admitted before a clear never writes back onto the new node


@pytest.fixture
def run_gate(api, monkeypatch):
    """execute_graph stands in for a handler that changes its node's params
    and reports outputs, once the test lets it go."""
    import main

    gate = {"started": asyncio.Event(), "go": asyncio.Event()}

    async def fake_execute_graph(*, nodes, emit, run_id, **_kwargs):
        gate["started"].set()
        await gate["go"].wait()
        for node in nodes:
            node.params["value"] = "changed by the old run"
            await emit(ExecutedEvent(run_id=run_id, node_id=node.id,
                                     outputs={"text": {"type": "Text", "value": "old run"}}))

    monkeypatch.setattr(main, "execute_graph", fake_execute_graph)
    monkeypatch.setattr(main, "validate_graph", lambda *args, **kwargs: [])
    return gate


async def _agent_clears_and_adds(api) -> str:
    """An agent's Clear while the run is registered: PR #114 refuses it
    (_project_replacement_guard, round 11), so nothing replaces the canvas
    under the run and its write-back lands on the node it ran."""
    import main

    with pytest.raises(main.HTTPException) as refused:
        await main.clear_graph(force=True)
    assert refused.value.status_code == 409
    assert "while a run is active" in str(refused.value.detail)
    return "n1"


def _canvas_replaced_under_the_run(api) -> str:
    """The canvas cleared under a registered run anyway (the guard above
    refuses every route that does it; a damaged state or a later path might
    not): the epoch moves and n1 is a new node. The run's write-backs check
    the canvas it registered on (_register_run(canvas=), _run_canvas_moved)
    and drop themselves."""
    import main

    main._forget_canvas_undo("test: the canvas was cleared under the run")
    api.graph.clear()
    new = api.graph.add_node("text-input", {"value": "AG"}, position={"x": 0, "y": 0})
    assert new == "n1"
    return new


def _node_body() -> list[GraphNode]:
    return [GraphNode(id="n1", definition_id="text-input", params={"value": "a"}, outputs={})]


async def _finish(api, gate, run_id: str) -> None:
    import main

    gate["go"].set()
    record = main.execution_runs.get(run_id)
    await asyncio.wait_for(asyncio.gather(record.task, return_exceptions=True), timeout=10)


def _start(main, route):
    if route == "execute":
        return main.execute(ExecuteRequest(nodes=_node_body(), edges=[]))
    return main.execute_node(ExecuteNodeRequest(nodes=_node_body(), edges=[], targetNodeId="n1"))


@pytest.mark.asyncio
@pytest.mark.parametrize("route", ["execute", "execute-node"])
async def test_L3_a_canvas_run_registers_its_canvas_and_a_clear_waits_for_it(api, run_gate, route):
    import main

    node = api.graph.add_node("text-input", {"value": "a"}, position={"x": 0, "y": 0})
    started = await asyncio.create_task(_start(main, route))
    await asyncio.wait_for(run_gate["started"].wait(), timeout=10)
    assert main.execution_runs.get(started["runId"]).canvas == main._run_canvas_now()
    await _agent_clears_and_adds(api)
    await _finish(api, run_gate, started["runId"])
    assert api.graph.nodes[node]["params"]["value"] == "changed by the old run"


@pytest.mark.asyncio
@pytest.mark.parametrize("route", ["execute", "execute-node"])
async def test_L3_a_canvas_run_whose_canvas_is_replaced_under_it_leaves_the_new_node_alone(api, run_gate, route):
    import main

    api.graph.add_node("text-input", {"value": "a"}, position={"x": 0, "y": 0})
    started = await asyncio.create_task(_start(main, route))
    await asyncio.wait_for(run_gate["started"].wait(), timeout=10)
    new = _canvas_replaced_under_the_run(api)
    await _finish(api, run_gate, started["runId"])
    assert api.graph.nodes[new]["params"] == {"value": "AG"}
    assert api.graph.nodes[new]["outputs"] == {}


@pytest.mark.asyncio
@pytest.mark.parametrize("route", ["execute", "execute-node"])
async def test_L3_without_a_clear_the_run_still_writes_back(api, run_gate, route):
    import main

    node = api.graph.add_node("text-input", {"value": "a"}, position={"x": 0, "y": 0})
    started = await asyncio.create_task(_start(main, route))
    await asyncio.wait_for(run_gate["started"].wait(), timeout=10)
    await _finish(api, run_gate, started["runId"])
    assert api.graph.nodes[node]["params"]["value"] == "changed by the old run"
    assert api.graph.nodes[node]["outputs"]["text"]["value"] == "old run"


@pytest.mark.asyncio
async def test_L3_an_agents_graph_run_leaves_a_node_made_on_a_canvas_replaced_under_it_alone(api, run_gate):
    import main
    from starlette.requests import Request

    api.graph.add_node("text-input", {"value": "a"}, position={"x": 0, "y": 0})
    request = Request({"type": "http", "method": "POST", "path": "/api/graph/run", "headers": []})
    run = asyncio.create_task(main.run_graph(request, {}))
    await asyncio.wait_for(run_gate["started"].wait(), timeout=10)
    await _agent_clears_and_adds(api)  # refused while it runs
    new = _canvas_replaced_under_the_run(api)
    run_gate["go"].set()
    await asyncio.wait_for(asyncio.gather(run, return_exceptions=True), timeout=10)
    assert api.graph.nodes[new]["params"] == {"value": "AG"}
    assert api.graph.nodes[new]["outputs"] == {}


@pytest.mark.asyncio
async def test_L3_a_stopped_run_whose_canvas_was_replaced_leaves_the_new_node_alone(api, monkeypatch):
    import main

    started = asyncio.Event()

    async def changes_then_waits(*, nodes, **_kwargs):
        for node in nodes:
            node.params["value"] = "changed by the old run"
        started.set()
        await asyncio.Event().wait()

    monkeypatch.setattr(main, "execute_graph", changes_then_waits)
    monkeypatch.setattr(main, "validate_graph", lambda *args, **kwargs: [])
    api.graph.add_node("text-input", {"value": "a"}, position={"x": 0, "y": 0})
    reply = await asyncio.create_task(main.execute(ExecuteRequest(nodes=_node_body(), edges=[])))
    await asyncio.wait_for(started.wait(), timeout=10)
    await _agent_clears_and_adds(api)  # refused while it runs
    new = _canvas_replaced_under_the_run(api)
    record = main.execution_runs.get(reply["runId"])
    record.task.cancel()
    await asyncio.wait_for(asyncio.gather(record.task, return_exceptions=True), timeout=10)
    assert api.graph.nodes[new]["params"] == {"value": "AG"}


@pytest.mark.asyncio
async def test_L3_cinema_merges_and_recovery_params_check_the_runs_canvas(api):
    import main

    api.graph.add_node("text-input", {"value": "a"}, position={"x": 0, "y": 0})
    holder = asyncio.create_task(asyncio.Event().wait())
    main._register_run("cinema-run", holder, main._run_canvas_now())
    try:
        _canvas_replaced_under_the_run(api)
        api.graph.nodes["n1"]["definitionId"] = "cinema-scene"
        api.graph.nodes["n1"]["params"] = {"scene": {"shots": [{"id": "s1", "output": {"status": "AG"}}]}}
        await main._merge_shot_result("n1", "s1", None, {}, terminal_error="old run failed", run_id="cinema-run")
        await main._merge_shot_variations("n1", "s1", [{"url": "/old.png", "seed": 1}], run_id="cinema-run")
    finally:
        holder.cancel()
        await asyncio.gather(holder, return_exceptions=True)
    assert api.graph.nodes["n1"]["params"]["scene"]["shots"][0] == {"id": "s1", "output": {"status": "AG"}}
    assert api.graph.nodes["n1"]["outputs"] == {}
