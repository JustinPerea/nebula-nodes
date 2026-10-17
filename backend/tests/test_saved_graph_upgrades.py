"""One-time param upgrades of saved graphs (services/saved_graph_upgrades.py).

Justin, 2026-10-17: a claude-chat node saved before 2026-10-16 on Opus 4.6,
Sonnet 4.6, Opus 4.7 or Opus 4.8 with Extended Thinking on holds Max Tokens
4,096 (main's only default). The handler used to send it as 64,000 while the
card showed 4,096. Now the saved graph holds 64,000 after it loads, once, and
a 4,096 set afterwards is kept and sent as set.

No network: projects and the live graph live under tmp_path, and runs go
through the handler with a mocked HTTP client.
"""
from __future__ import annotations

import copy
import json
import re
import sys
from pathlib import Path
from unittest.mock import AsyncMock
from uuid import uuid4

import pytest
from fastapi.testclient import TestClient

sys.path.insert(0, str(Path(__file__).resolve().parent.parent))
import main as main_module
from services.cli_graph import CLIGraph
from services.execution_runs import ExecutionRunRegistry
from services.project_store import ProjectStore, make_project
from services.provider_recovery import ProviderRecoveryStore
from services.provider_start_guard import ProviderStartGuard
from services.saved_graph_upgrades import (
    CLAUDE_THINKING_MODELS,
    PARAMS_VERSION,
    UPGRADED_MAX_TOKENS,
    upgrade_params,
)
from services.param_defaults import param_default
from tests.test_chat_model_catalog import _claude

OLD = {"model": "claude-opus-4-6", "extended_thinking": True, "thinkingBudget": 2048, "max_tokens": 4096}


@pytest.fixture
def workspace(tmp_path, monkeypatch):
    graph = CLIGraph(persist_path=tmp_path / "state.json")
    store = ProjectStore(tmp_path / "projects")
    monkeypatch.setattr(main_module, "cli_graph", graph)
    monkeypatch.setattr(main_module, "project_store", store)
    monkeypatch.setattr(main_module, "provider_recovery_store", ProviderRecoveryStore(None))
    monkeypatch.setattr(main_module, "provider_start_guard", ProviderStartGuard(tmp_path / "paid-starts.json"))
    monkeypatch.setattr(main_module, "execution_runs", ExecutionRunRegistry())
    monkeypatch.setattr(main_module, "_graph_recovery_bootstrap_error", None)
    monkeypatch.setattr(main_module.manager, "broadcast_raw", AsyncMock())
    return TestClient(main_module.app), graph, store


def rf_node(node_id: str, **params):
    return {"id": node_id, "type": "model-node", "position": {"x": 0, "y": 0},
            "data": {"definitionId": "claude-chat", "label": "Claude", "params": params, "outputs": {}}}


def saved_snapshot():
    """A canvas saved on main: one node per case the upgrade must get right."""
    return {
        "nodes": [
            rf_node("n1", **OLD),                                                 # upgraded
            rf_node("n2", **{**OLD, "model": "claude-opus-4-8", "max_tokens": "4096"}),  # upgraded
            rf_node("n3", **{**OLD, "extended_thinking": False}),               # thinking off
            rf_node("n4", **{**OLD, "max_tokens": 8192}),                       # another value
            rf_node("n5", **{**OLD, "model": "claude-haiku-4-5-20251001"}),     # budget thinking
            rf_node("n6", **{**OLD, "model": "claude-fable-5"}),                # always thinks
            rf_node("n7", **{**OLD, "model": "claude-opus-5-5"}),               # 5.x
        ],
        "edges": [],
        "runHistory": [{"id": "run-old", "status": "complete", "startedAt": 1,
                        "snapshot": {"nodes": [{"id": "n1", "definitionId": "claude-chat",
                                                "params": dict(OLD), "outputs": {}}], "edges": []}}],
        "viewport": None, "createSessionId": None,
    }


EXPECTED_MAX = {"n1": 64000, "n2": 64000, "n3": 4096, "n4": 8192, "n5": 4096, "n6": 4096, "n7": 4096}


def max_tokens(nodes) -> dict[str, object]:
    return {n["id"]: n["data"]["params"]["max_tokens"] for n in nodes}


def create(client, name, revision=None):
    body = {"name": name, **({"workspaceRevision": revision} if revision else {})}
    response = client.post("/api/projects", json=body)
    assert response.status_code == 200, response.text
    return response.json()


def save(client, project_id, revision, snapshot):
    response = client.put(f"/api/projects/{project_id}", json={"workspaceRevision": revision, "snapshot": snapshot})
    assert response.status_code == 200, response.text
    return response.json()


def mark_saved_before_upgrade(store: ProjectStore, project_id: str, snapshot) -> None:
    """Rewrite the catalog on disk as main would have left it: the saved
    params and no version marker."""
    catalog = json.loads(store.path.read_text())
    project = catalog["projects"][project_id]
    project["snapshot"] = copy.deepcopy(snapshot)
    project.pop("_paramsVersion", None)
    store.path.write_text(json.dumps(catalog))


# --------------------------------------------------------------------------
# The rule
# --------------------------------------------------------------------------

def test_upgraded_value_is_the_current_definition_default():
    # Frozen in the module so a later default change can't change history,
    # but today it must match what the card shows for a new node.
    for model in CLAUDE_THINKING_MODELS:
        assert param_default("claude-chat", "max_tokens", {"model": model}) == UPGRADED_MAX_TOKENS


@pytest.mark.parametrize("model", sorted(CLAUDE_THINKING_MODELS))
@pytest.mark.parametrize("value", [4096, 4096.0, "4096", " 4096 "])
def test_rule_upgrades_the_old_default_with_thinking_on(model, value):
    assert upgrade_params("claude-chat", {**OLD, "model": model, "max_tokens": value}, 0) == {
        **OLD, "model": model, "max_tokens": 64000}


@pytest.mark.parametrize("params", [
    {**OLD, "extended_thinking": False},
    {k: v for k, v in OLD.items() if k != "extended_thinking"},
    {**OLD, "max_tokens": 8192},
    {**OLD, "max_tokens": 4095},
    {**OLD, "max_tokens": True},
    {**OLD, "model": "claude-haiku-4-5-20251001"},
    {**OLD, "model": "claude-fable-5"},
    {**OLD, "model": "claude-fable-5-1"},
    {**OLD, "model": "claude-opus-5-5"},
    {**OLD, "model": "claude-sonnet-5-5"},
    {**OLD, "model": "claude-haiku-5-5"},
    {k: v for k, v in OLD.items() if k != "model"},
])
def test_rule_leaves_everything_else(params):
    assert upgrade_params("claude-chat", params, 0) is None


def test_rule_runs_once_and_only_on_claude_chat():
    assert upgrade_params("claude-chat", OLD, PARAMS_VERSION) is None
    assert upgrade_params("gpt-4o-chat", {**OLD}, 0) is None


# --------------------------------------------------------------------------
# Projects: open, reopen, startup, recovery, new projects, trash
# --------------------------------------------------------------------------

def test_saved_project_opens_holding_64000_and_keeps_a_later_4096(workspace):
    client, graph, store = workspace
    first = create(client, "Saved on main")
    project_id = first["project"]["id"]
    second = create(client, "Other", first["workspaceRevision"])
    mark_saved_before_upgrade(store, project_id, saved_snapshot())

    opened = client.post(f"/api/projects/{project_id}/open", json={"workspaceRevision": second["workspaceRevision"]})
    assert opened.status_code == 200, opened.text
    snapshot = opened.json()["project"]["snapshot"]
    assert max_tokens(snapshot["nodes"]) == EXPECTED_MAX
    # The live graph that the CLI, agents and runs read holds the same.
    assert {nid: n["params"]["max_tokens"] for nid, n in graph.nodes.items()} == EXPECTED_MAX
    # A replay of a saved run sends its recipe, so the recipe is upgraded too.
    assert snapshot["runHistory"][0]["snapshot"]["nodes"][0]["params"]["max_tokens"] == 64000
    # Stored once, with the marker; nothing else about the nodes changed.
    on_disk = json.loads(store.path.read_text())["projects"][project_id]
    assert on_disk["_paramsVersion"] == PARAMS_VERSION
    assert max_tokens(on_disk["snapshot"]["nodes"]) == EXPECTED_MAX
    assert on_disk["snapshot"]["nodes"][0]["data"]["params"] == {**OLD, "max_tokens": 64000}
    assert "_paramsVersion" not in opened.json()["project"]

    # Justin types 4,096 on purpose: the Inspector edit updates the live
    # graph, and the canvas autosaves the project.
    revision = opened.json()["workspaceRevision"]
    edited = client.put("/api/graph/node/n1", json={"params": {"max_tokens": 4096}})
    assert edited.status_code == 200, edited.text
    snapshot["nodes"][0]["data"]["params"]["max_tokens"] = 4096
    save(client, project_id, revision, snapshot)
    away = client.post(f"/api/projects/{second['project']['id']}/open", json={"workspaceRevision": revision})
    back = client.post(f"/api/projects/{project_id}/open", json={"workspaceRevision": away.json()["workspaceRevision"]})
    assert back.status_code == 200, back.text
    assert back.json()["project"]["snapshot"]["nodes"][0]["data"]["params"]["max_tokens"] == 4096
    assert graph.nodes["n1"]["params"]["max_tokens"] == 4096
    # A fresh process reading the same files keeps it too.
    assert ProjectStore(store.root).read()["projects"][project_id]["snapshot"]["nodes"][0]["data"]["params"][
        "max_tokens"] == 4096


def test_active_project_and_live_graph_upgrade_at_startup(workspace, tmp_path):
    """The project open when the app quit isn't reopened at startup: the
    canvas lists projects and reads the active one, and the CLI reads the live
    graph. Both files are upgraded where they are read."""
    client, graph, store = workspace
    created = create(client, "Open at quit")
    project_id = created["project"]["id"]
    mark_saved_before_upgrade(store, project_id, saved_snapshot())
    state = {"nodes": [{"id": n["id"], "definitionId": "claude-chat", "params": n["data"]["params"],
                        "outputs": {}, "position": n["position"]} for n in saved_snapshot()["nodes"]],
             "edges": [], "counter": 7}
    (tmp_path / "state.json").write_text(json.dumps(state))  # written by main: no paramsVersion

    restarted = CLIGraph(persist_path=tmp_path / "state.json")
    restarted.load(tmp_path / "state.json")
    assert restarted.upgraded_on_load == 2
    assert {nid: n["params"]["max_tokens"] for nid, n in restarted.nodes.items()} == EXPECTED_MAX
    graph.nodes, graph.edges, graph._counter = restarted.nodes, restarted.edges, restarted._counter

    listing = client.get("/api/projects").json()
    assert listing["activeProjectId"] == project_id
    document = client.get(f"/api/projects/{project_id}").json()
    assert max_tokens(document["snapshot"]["nodes"]) == EXPECTED_MAX
    assert client.get("/api/projects").json()["workspaceRevision"] == created["workspaceRevision"]

    # Saving writes the marker; a 4,096 set afterwards survives a restart.
    graph.update_params("n1", {"max_tokens": 4096})
    assert json.loads((tmp_path / "state.json").read_text())["paramsVersion"] == PARAMS_VERSION
    again = CLIGraph(persist_path=tmp_path / "state.json")
    again.load(tmp_path / "state.json")
    assert again.upgraded_on_load == 0
    assert again.nodes["n1"]["params"]["max_tokens"] == 4096


def test_boot_writes_the_upgraded_live_graph(tmp_path, monkeypatch):
    """main's boot step persists an upgraded state.json right away."""
    path = tmp_path / "state.json"
    path.write_text(json.dumps({"nodes": [{"id": "n1", "definitionId": "claude-chat", "params": dict(OLD),
                                           "outputs": {}}], "edges": [], "counter": 1}))
    graph = CLIGraph(persist_path=path)
    graph.load(path)
    assert graph.upgraded_on_load == 1
    graph._maybe_persist()
    written = json.loads(path.read_text())
    assert written["paramsVersion"] == PARAMS_VERSION
    assert written["nodes"][0]["params"]["max_tokens"] == 64000
    source = (Path(main_module.__file__)).read_text()
    assert re.search(r"cli_graph\.load\(_STATE_PATH\)[\s\S]{0,400}if cli_graph\.upgraded_on_load:\s+[\s\S]{0,300}"
                     r"cli_graph\._maybe_persist\(\)", source)


def test_new_projects_start_current():
    project = make_project("New")
    assert project["_paramsVersion"] == PARAMS_VERSION


def test_trashed_project_is_upgraded_when_read(workspace):
    client, _, store = workspace
    first = create(client, "Trashed")
    project_id = first["project"]["id"]
    second = create(client, "Other", first["workspaceRevision"])
    mark_saved_before_upgrade(store, project_id, saved_snapshot())
    deleted = client.request("DELETE", f"/api/projects/{project_id}", json={"workspaceRevision": second["workspaceRevision"]})
    assert deleted.status_code == 200, deleted.text
    restored = client.post(f"/api/projects/{project_id}/restore")
    assert restored.status_code == 200, restored.text
    entry = store.read()["projects"][project_id]
    assert max_tokens(entry["snapshot"]["nodes"]) == EXPECTED_MAX


def test_recovered_copy_takes_the_source_version(workspace):
    client, _, store = workspace
    source = create(client, "Source")
    snapshot = {**saved_snapshot(), "runHistory": []}
    snapshot["nodes"][0]["data"]["params"]["max_tokens"] = 4096  # set on purpose, after the upgrade
    body = {"sourceProjectId": source["project"]["id"], "recoveryId": uuid4().hex, "snapshot": snapshot,
            "workspaceRevision": source["workspaceRevision"]}
    kept = client.post("/api/projects/recover", json=body)
    assert kept.status_code == 200, kept.text
    assert kept.json()["project"]["snapshot"]["nodes"][0]["data"]["params"]["max_tokens"] == 4096
    assert store.read()["projects"][body["recoveryId"]]["snapshot"]["nodes"][0]["data"]["params"]["max_tokens"] == 4096

    # A tab whose project is gone entirely: nothing says when it was saved,
    # so it is treated like any project saved before the upgrade.
    orphan = {**body, "sourceProjectId": uuid4().hex, "recoveryId": uuid4().hex}
    upgraded = client.post("/api/projects/recover", json=orphan)
    assert upgraded.status_code == 200, upgraded.text
    assert max_tokens(upgraded.json()["project"]["snapshot"]["nodes"])["n1"] == 64000


# --------------------------------------------------------------------------
# Graph-file import
# --------------------------------------------------------------------------

def import_body(**extra):
    return {"nodes": [{"id": n["id"], "definitionId": "claude-chat", "label": "Claude",
                       "params": n["data"]["params"], "outputs": {}, "position": n["position"]}
                      for n in saved_snapshot()["nodes"]], "edges": [], **extra}


def imported_max(client, body):
    response = client.post("/api/graph/import", json=body)
    assert response.status_code == 200, response.text
    by_old = {old: new for old, new in response.json()["idMap"].items()}
    return {old: main_module.cli_graph.nodes[new]["params"]["max_tokens"] for old, new in by_old.items()}


def test_import_upgrades_a_file_saved_before_the_marker(workspace):
    client, _, _ = workspace
    assert imported_max(client, import_body(paramsVersion=0)) == EXPECTED_MAX


def test_import_keeps_values_of_a_current_file_or_a_body_without_the_key(workspace):
    client, _, _ = workspace
    as_saved = {"n1": 4096, "n2": "4096", "n3": 4096, "n4": 8192, "n5": 4096, "n6": 4096, "n7": 4096}
    current = imported_max(client, import_body(paramsVersion=PARAMS_VERSION))
    assert {k: int(v) for k, v in current.items()} == {k: int(v) for k, v in as_saved.items()}
    agent = imported_max(client, import_body())
    assert {k: int(v) for k, v in agent.items()} == {k: int(v) for k, v in as_saved.items()}


@pytest.mark.parametrize("bad", ["0", -1, 1.5, True, None])
def test_import_refuses_a_malformed_version(workspace, bad):
    client, _, _ = workspace
    response = client.post("/api/graph/import", json=import_body(paramsVersion=bad))
    assert response.status_code == 400
    assert "paramsVersion" in response.json()["detail"]


def test_frontend_file_version_matches_backend():
    source = (Path(__file__).resolve().parents[2] / "frontend" / "src" / "lib" / "graphFile.ts").read_text()
    match = re.search(r"export const GRAPH_PARAMS_VERSION = (\d+);", source)
    assert match and int(match.group(1)) == PARAMS_VERSION


# --------------------------------------------------------------------------
# Runs
# --------------------------------------------------------------------------

@pytest.mark.asyncio
async def test_run_of_an_upgraded_node_sends_64000_and_a_later_4096_sends_4096(workspace):
    client, graph, store = workspace
    first = create(client, "Saved on main")
    project_id = first["project"]["id"]
    second = create(client, "Other", first["workspaceRevision"])
    mark_saved_before_upgrade(store, project_id, saved_snapshot())
    opened = client.post(f"/api/projects/{project_id}/open", json={"workspaceRevision": second["workspaceRevision"]})
    assert opened.status_code == 200, opened.text

    _, _, body = await _claude(graph.nodes["n1"]["params"])
    assert body["max_tokens"] == 64000
    assert body["thinking"] == {"type": "adaptive"}

    graph.update_params("n1", {"max_tokens": 4096})
    _, _, body = await _claude(graph.nodes["n1"]["params"])
    assert body["max_tokens"] == 4096
