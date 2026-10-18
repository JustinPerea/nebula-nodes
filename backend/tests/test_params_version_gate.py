"""Tabs loaded before a one-time params upgrade can't save or run old values.

Justin, 2026-10-17 (round 2, item 3): "we should fix that shouldn't we?" A tab
whose canvas loaded before the upgrade (main's bundle, or any bundle built for
another ``PARAMS_VERSION``) is stale. The backend never accepts its writes and
never runs its params, and the tab reloads (services/saved_graph_upgrades.py,
``project_workspace_fence`` in main.py).

- The bundle sends ``X-Nebula-Params-Version`` on every request. A request
  with a lower or higher version, or with none when it carries the canvas's
  ``X-Nebula-Workspace-Revision`` or comes from a browser (``Origin`` or
  ``Sec-Fetch-Site``), gets 409 ``params_outdated`` before any route runs.
- Agents, the CLI, MCP and scripts send none of these and pass as sent.
- At boot, a catalog or state.json saved before the current version gives the
  workspace a new revision and is written at once.

The request bodies below are origin/main's, copied from its frontend
(lib/projects.ts, lib/api.ts, lib/createPresets.ts, store/graphStore.ts).
No network: stores live under tmp_path, provider HTTP is patched to fail.
"""
from __future__ import annotations

import copy
import importlib
import json
import os
import subprocess
import sys
from pathlib import Path
from unittest.mock import AsyncMock

import httpx
import pytest
from fastapi.testclient import TestClient

sys.path.insert(0, str(Path(__file__).resolve().parent.parent))
import main as main_module  # noqa: E402
from services.cli_graph import CLIGraph  # noqa: E402
from services.execution_runs import ExecutionRunRegistry  # noqa: E402
from services.project_store import ProjectStore  # noqa: E402
from services.provider_recovery import ProviderRecoveryStore  # noqa: E402
from services.provider_start_guard import ProviderStartGuard  # noqa: E402
from services.saved_graph_upgrades import PARAMS_VERSION, UPGRADED_MAX_TOKENS  # noqa: E402

BACKEND = Path(__file__).resolve().parent.parent
OLD = {"model": "claude-opus-4-6", "extended_thinking": True, "thinkingBudget": 2048, "max_tokens": 4096}


@pytest.fixture
def workspace(tmp_path, monkeypatch):
    graph = CLIGraph(persist_path=tmp_path / "state.json")
    store = ProjectStore(tmp_path / "projects")
    monkeypatch.setenv("NEBULA_PRESET_ROOT", str(tmp_path / "presets"))
    import services.preset_store as preset_module
    importlib.reload(preset_module)
    presets = preset_module.PresetStore()
    monkeypatch.setattr(main_module, "cli_graph", graph)
    monkeypatch.setattr(main_module, "project_store", store)
    monkeypatch.setattr(main_module, "preset_store", presets)
    monkeypatch.setattr(main_module, "provider_recovery_store", ProviderRecoveryStore(None))
    monkeypatch.setattr(main_module, "provider_start_guard", ProviderStartGuard(tmp_path / "paid-starts.json"))
    monkeypatch.setattr(main_module, "execution_runs", ExecutionRunRegistry())
    monkeypatch.setattr(main_module, "_graph_recovery_bootstrap_error", None)
    monkeypatch.setattr(main_module.manager, "broadcast_raw", AsyncMock())
    return TestClient(main_module.app), graph, store, presets


@pytest.fixture
def no_provider_calls(monkeypatch):
    """Any request that would leave the process fails the test (the
    TestClient uses its own in-process transport)."""
    calls = []

    def refuse(self, request, *args, **kwargs):
        calls.append(str(request.url))
        raise AssertionError(f"a provider request was sent: {request.url}")

    async def refuse_async(self, request, *args, **kwargs):
        return refuse(self, request)

    monkeypatch.setattr(httpx.HTTPTransport, "handle_request", refuse)
    monkeypatch.setattr(httpx.AsyncHTTPTransport, "handle_async_request", refuse_async)
    return calls


@pytest.fixture
def route_calls(monkeypatch):
    """Records every run route that got past the fence (each one captures the
    workspace first) and every params list a run would send."""
    calls: list[tuple[str, object]] = []
    capture = main_module._capture_execution_workspace
    normalize = main_module._normalize_execute_nodes

    def captured():
        calls.append(("run", None))
        return capture()

    def normalized(nodes):
        result = normalize(nodes)
        calls.append(("params", [copy.deepcopy(node.params) for node in result]))
        return result

    monkeypatch.setattr(main_module, "_capture_execution_workspace", captured)
    monkeypatch.setattr(main_module, "_normalize_execute_nodes", normalized)
    return calls


def rf_node(node_id: str, params: dict) -> dict:
    return {"id": node_id, "type": "model-node", "position": {"x": 0, "y": 0},
            "data": {"definitionId": "claude-chat", "label": "Claude", "params": dict(params), "outputs": {}}}


def open_project(client, graph) -> tuple[str, str]:
    """A project open on the canvas, its live node n1 holding 64,000."""
    response = client.post("/api/projects", json={"name": "Open"})
    assert response.status_code == 200, response.text
    project_id, revision = response.json()["project"]["id"], response.json()["workspaceRevision"]
    node_id = graph.add_node("claude-chat", {**OLD, "max_tokens": UPGRADED_MAX_TOKENS})
    snapshot = {"nodes": [rf_node(node_id, {**OLD, "max_tokens": UPGRADED_MAX_TOKENS})], "edges": [],
                "runHistory": [], "viewport": None, "createSessionId": None}
    saved = client.put(f"/api/projects/{project_id}", json={"snapshot": snapshot, "workspaceRevision": revision})
    assert saved.status_code == 200, saved.text
    return project_id, revision


def main_requests(project_id: str, revision: str, node_id: str) -> list[tuple[str, str, dict | None]]:
    """Every request origin/main's canvas sends that stores or runs params (or
    replaces the project), with its body as main builds it."""
    flat = [{"id": node_id, "definitionId": "claude-chat", "params": dict(OLD), "outputs": {}}]
    snapshot = {  # projectStore.ts captureProjectSnapshot
        "nodes": [rf_node(node_id, OLD), rf_node("4f1c5c1e-0000-4000-8000-000000000001", OLD)],
        "edges": [], "runHistory": [], "viewport": {"x": 0, "y": 0, "zoom": 1},
        "createSessionId": f"project:{project_id}:create",
        "createDraft": {"modelId": "claude-chat", "prompt": "hi", "params": dict(OLD)},
    }
    return [
        # lib/projects.ts
        ("put", f"/api/projects/{project_id}", {"snapshot": snapshot, "workspaceRevision": revision}),
        ("put", f"/api/projects/{project_id}", {"name": "Renamed"}),
        ("post", "/api/projects", {"name": "New", "workspaceRevision": revision}),
        ("post", f"/api/projects/{project_id}/open", {"workspaceRevision": revision}),
        ("delete", f"/api/projects/{project_id}", {"workspaceRevision": revision}),
        ("post", "/api/projects/trash/empty", None),
        # lib/api.ts
        ("post", "/api/execute", {"nodes": flat, "edges": [], "runId": "run-main"}),
        ("post", "/api/execute-node", {"nodes": flat, "edges": [], "targetNodeId": node_id, "runId": "run-main-node"}),
        ("post", "/api/cinema/generate-shot", {"nodes": flat, "edges": [], "nodeId": node_id, "shotId": "s1",
                                               "seed": 1, "variations": 1, "runId": "run-shot"}),
        # store/graphStore.ts: param push, node create, cluster (Create replays)
        ("put", f"/api/graph/node/{node_id}", {"params": dict(OLD)}),
        ("post", "/api/graph/node", {"definitionId": "claude-chat", "params": dict(OLD), "position": {"x": 0, "y": 0}}),
        ("post", "/api/graph/cluster", {"nodes": [{"key": "a", "definitionId": "claude-chat", "params": dict(OLD)}],
                                        "edges": []}),
        ("post", "/api/quick", {"definitionId": "claude-chat", "params": dict(OLD)}),
        # lib/createPresets.ts (no paramsVersion on main)
        ("post", "/api/presets", {"name": "Style", "category": "My Styles", "prompt": "", "params": dict(OLD),
                                  "modelId": "claude-chat", "refImages": [], "scope": "global"}),
        ("delete", "/api/presets/some-preset", None),
    ]


def send(client, method: str, path: str, body, headers: dict[str, str]):
    return client.request(method.upper(), path, headers=headers, **({"json": body} if body is not None else {}))


def disk(tmp_path: Path) -> dict[str, bytes]:
    return {str(path.relative_to(tmp_path)): path.read_bytes()
            for path in sorted(tmp_path.rglob("*")) if path.is_file() and ".lock" not in path.name}


# --------------------------------------------------------------------------
# Main's bundle with a project open: every write refused before any route runs
# --------------------------------------------------------------------------

@pytest.mark.parametrize("which_revision", ["current", "before restart"])
def test_main_bundle_requests_are_refused_without_running_or_storing(
        workspace, tmp_path, route_calls, no_provider_calls, which_revision):
    """Current: main's tab re-applied the upgraded project (Retry) and holds
    today's revision. Before restart: its revision from before the boot step
    rotated it. Both send the revision header and no params version."""
    client, graph, store, presets = workspace
    project_id, revision = open_project(client, graph)
    node_id = next(iter(graph.nodes))
    tab_revision = revision if which_revision == "current" else "f" * 32
    before_graph = copy.deepcopy(graph.get_state())
    before_disk = disk(tmp_path)
    route_calls.clear()

    for method, path, body in main_requests(project_id, revision, node_id):
        response = send(client, method, path, body, {"X-Nebula-Workspace-Revision": tab_revision})
        assert response.status_code == 409, (method, path, response.text)
        payload = response.json()
        assert payload["code"] == "params_outdated", (method, path, payload)
        assert payload["paramsVersion"] == PARAMS_VERSION
        # Main's bundle prints `detail` as it is, so it says what to do.
        assert "Reload the tab" in payload["detail"] and "rebuild the frontend" in payload["detail"]

    assert route_calls == []
    assert no_provider_calls == []
    assert graph.get_state() == before_graph
    assert disk(tmp_path) == before_disk
    assert graph.nodes[node_id]["params"]["max_tokens"] == UPGRADED_MAX_TOKENS


def test_main_bundle_recovery_is_kept_and_upgraded(workspace, tmp_path):
    """Recovery is how a stale tab keeps its unsaved work. Main's body has no
    paramsVersion, so the copy is upgraded from 0."""
    client, graph, store, _ = workspace
    project_id, revision = open_project(client, graph)
    node_id = next(iter(graph.nodes))
    body = {"sourceProjectId": project_id, "recoveryId": "a" * 32,  # projects.ts recoverProject on main
            "snapshot": {"nodes": [rf_node(node_id, OLD)], "edges": [], "runHistory": [], "viewport": None,
                         "createSessionId": None}}
    response = client.post("/api/projects/recover", json=body, headers={"X-Nebula-Workspace-Revision": "f" * 32})
    assert response.status_code == 200, response.text
    assert response.json()["project"]["snapshot"]["nodes"][0]["data"]["params"]["max_tokens"] == UPGRADED_MAX_TOKENS


# --------------------------------------------------------------------------
# Main's bundle with no project context: a browser request, still refused
# --------------------------------------------------------------------------

# What a browser adds by itself. Every browser sends Origin on a request that
# isn't GET or HEAD. The packaged desktop renderer (a file: page) sends no
# Origin but does send Sec-Fetch-Site (checked 2026-10-17 against Electron
# 44.3: "sec-fetch-site: cross-site", "sec-fetch-mode: cors", no origin).
BROWSER_MARKERS = {
    "vite tab": {"Origin": "http://localhost:5173", "Sec-Fetch-Site": "same-site", "Sec-Fetch-Mode": "cors"},
    "safari before 16.4": {"Origin": "http://127.0.0.1:5173"},
    "desktop renderer": {"Sec-Fetch-Site": "cross-site", "Sec-Fetch-Mode": "cors", "Sec-Fetch-Dest": "empty"},
}


@pytest.mark.parametrize("browser", BROWSER_MARKERS.values(), ids=BROWSER_MARKERS.keys())
def test_main_bundle_without_a_project_context_is_refused(
        workspace, tmp_path, route_calls, no_provider_calls, browser):
    """Review round 2: main's tab can reach the canvas with getProjectContext()
    null (conflict, then Try again while no project is active, then Open of
    the same project takes main's open() shortcut without applyProject), so
    it sends neither header. A browser request with no params version is
    from a bundle older than the gate: version 0."""
    client, graph, store, presets = workspace
    project_id, revision = open_project(client, graph)
    node_id = next(iter(graph.nodes))
    before_graph = copy.deepcopy(graph.get_state())
    before_disk = disk(tmp_path)
    route_calls.clear()

    for method, path, body in main_requests(project_id, revision, node_id):
        response = send(client, method, path, body, dict(browser))
        assert response.status_code == 409, (method, path, response.text)
        assert response.json()["code"] == "params_outdated", (method, path)

    assert route_calls == []
    assert no_provider_calls == []
    assert graph.get_state() == before_graph
    assert disk(tmp_path) == before_disk


# --------------------------------------------------------------------------
# Agents, CLI, MCP, scripts: no canvas or browser headers, values pass as sent
# --------------------------------------------------------------------------

# curl, Python (the CLI, MCP, agent tools) send none of these. Node's fetch
# sends Sec-Fetch-Mode but no Origin and no Sec-Fetch-Site (checked
# 2026-10-17, Node 22.16 undici).
NON_BROWSER = {"curl or python": {}, "node fetch": {"Sec-Fetch-Mode": "cors", "User-Agent": "node"}}


@pytest.mark.parametrize("caller", NON_BROWSER.values(), ids=NON_BROWSER.keys())
def test_requests_without_canvas_headers_pass_unchanged(workspace, route_calls, no_provider_calls, caller):
    client, graph, store, presets = workspace
    client.headers.update(caller)
    project_id, revision = open_project(client, graph)
    node_id = next(iter(graph.nodes))
    route_calls.clear()

    pushed = client.put(f"/api/graph/node/{node_id}", json={"params": dict(OLD)})
    assert pushed.status_code == 200, pushed.text
    assert graph.nodes[node_id]["params"]["max_tokens"] == 4096

    created = client.post("/api/graph/node", json={"definitionId": "claude-chat", "params": dict(OLD)})
    assert created.status_code == 200, created.text
    assert graph.nodes[created.json()["id"]]["params"]["max_tokens"] == 4096

    # No key in the test settings: the run stops at validation, after the
    # route read the params it would send.
    flat = [{"id": node_id, "definitionId": "claude-chat", "params": dict(OLD), "outputs": {}}]
    ran = client.post("/api/execute", json={"nodes": flat, "edges": [], "runId": "agent-run"})
    assert ran.status_code == 200, ran.text
    assert ("run", None) in route_calls
    assert [params[0]["max_tokens"] for kind, params in route_calls if kind == "params"] == [4096]

    snapshot = {"nodes": [rf_node(node_id, OLD)], "edges": [], "runHistory": [], "viewport": None,
                "createSessionId": None}
    saved = client.put(f"/api/projects/{project_id}", json={"snapshot": snapshot, "workspaceRevision": revision})
    assert saved.status_code == 200, saved.text
    assert store.read()["projects"][project_id]["snapshot"]["nodes"][0]["data"]["params"]["max_tokens"] == 4096

    preset = presets.create(name="Style", category="My Styles", prompt="", params={"x": 1}, modelId="claude-chat",
                            refImages=[], scope="global", projectId=None, params_version=PARAMS_VERSION)
    updated = client.put(f"/api/presets/{preset['id']}", json={"params": dict(OLD)})
    assert updated.status_code == 200, updated.text
    assert updated.json()["params"]["max_tokens"] == 4096
    assert no_provider_calls == []


# --------------------------------------------------------------------------
# This bundle: the header decides, with or without a project open
# --------------------------------------------------------------------------

def test_current_bundle_passes_and_other_versions_are_refused(workspace, route_calls):
    client, graph, _, _ = workspace
    project_id, revision = open_project(client, graph)
    node_id = next(iter(graph.nodes))
    canvas = {"X-Nebula-Workspace-Revision": revision}

    ok = client.put(f"/api/graph/node/{node_id}", json={"params": dict(OLD)},
                    headers={**canvas, "X-Nebula-Params-Version": str(PARAMS_VERSION)})
    assert ok.status_code == 200, ok.text

    for version in (str(PARAMS_VERSION - 1), str(PARAMS_VERSION + 1), "", "one"):
        for headers in ({**canvas, "X-Nebula-Params-Version": version}, {"X-Nebula-Params-Version": version}):
            refused = client.put(f"/api/graph/node/{node_id}", json={"params": {"max_tokens": 8192}}, headers=headers)
            assert refused.status_code == 409, (version, headers)
            assert refused.json()["code"] == "params_outdated"
    assert graph.nodes[node_id]["params"]["max_tokens"] == 4096

    # Reads are never gated: a stale tab still loads what it needs to reload.
    assert client.get("/api/projects", headers={"X-Nebula-Params-Version": "0"}).status_code == 200


def test_listing_and_graph_sync_carry_the_params_version(workspace):
    client, graph, _, _ = workspace
    project_id, _ = open_project(client, graph)
    assert client.get("/api/projects").json()["paramsVersion"] == PARAMS_VERSION
    # Create and open replies too: the canvas applies a project only from a
    # backend at its own version (a backend from before the gate sends none).
    created = client.post("/api/projects", json={"name": "Second"})
    assert created.json()["paramsVersion"] == PARAMS_VERSION
    opened = client.post(f"/api/projects/{project_id}/open",
                         json={"workspaceRevision": created.json()["workspaceRevision"]})
    assert opened.status_code == 200, opened.text
    assert opened.json()["paramsVersion"] == PARAMS_VERSION
    assert client.get("/api/graph/export").json()["paramsVersion"] == PARAMS_VERSION
    with client.websocket_connect("/ws") as socket:
        first = json.loads(socket.receive_text())
    assert first["type"] == "graphSync"
    assert first["paramsVersion"] == PARAMS_VERSION


def test_health_reports_the_params_version_and_keeps_its_identity():
    # The desktop app reads this at launch to catch a frontend built for
    # another version (desktop/frontend-build.mjs). Health stays open: no
    # person token, no params header.
    body = TestClient(main_module.app).get("/api/health").json()
    assert body == {"status": "ok", "app": "nebula", "version": "0.1.0", "paramsVersion": PARAMS_VERSION}


def test_desktop_renderer_may_send_the_params_version_header():
    assert "X-Nebula-Params-Version" in main_module._DESKTOP_CORS_HEADERS


# --------------------------------------------------------------------------
# Boot: a version advance rotates the revision once and writes the catalog
# --------------------------------------------------------------------------

def _catalog(revision: str, *, marked: bool) -> dict:
    project_id = "b" * 32
    project = {
        "id": project_id, "name": "Saved on main", "createdAt": "2026-10-01T00:00:00+00:00",
        "updatedAt": "2026-10-01T00:00:00+00:00", "lastOpenedAt": None, "nodeCount": 1, "edgeCount": 0,
        "thumbnail": None,
        "snapshot": {"nodes": [rf_node("n1", OLD)], "edges": [], "runHistory": [], "viewport": None,
                     "createSessionId": None},
    }
    if marked:
        project["_paramsVersion"] = PARAMS_VERSION
    return {"version": 1, "projects": {project_id: project}, "trash": {}, "activeProjectId": project_id,
            "workspaceRevision": revision}


def _state(*, marked: bool, nodes: bool = True) -> dict:
    data = {"nodes": [{"id": "n1", "definitionId": "claude-chat", "params": dict(OLD), "outputs": {}}] if nodes else [],
            "edges": [], "counter": 1}
    if marked:
        data["paramsVersion"] = PARAMS_VERSION
    return data


def _boot(tmp_path: Path) -> subprocess.CompletedProcess:
    """Import main in a fresh process against isolated state, as a restart does."""
    home = tmp_path / "home"
    home.mkdir(exist_ok=True)
    env = {
        "PATH": os.environ.get("PATH", "/usr/bin:/bin"), "HOME": str(home),
        "NEBULA_STATE_DIR": str(tmp_path / "state"), "NEBULA_OUTPUT_ROOT": str(tmp_path / "output"),
        "NEBULA_SETTINGS_PATH": str(tmp_path / "settings.json"), "NEBULA_PRESET_ROOT": str(tmp_path / "presets"),
        "NEBULA_CHARACTER_ROOT": str(tmp_path / "characters"), "NEBULA_COMMONS_ROOT": str(tmp_path / "commons"),
        "NEBULA_COMMONS_NO_STARTUP_SCAN": "1",
    }
    result = subprocess.run([sys.executable, "-c", "import main"], cwd=BACKEND, env=env,
                            capture_output=True, text=True, timeout=120)
    assert result.returncode == 0, result.stderr[-2000:]
    return result


def _write_state(tmp_path: Path, catalog: dict | None, state: dict | str | None) -> Path:
    root = tmp_path / "state"
    (root / "projects").mkdir(parents=True, exist_ok=True)
    if catalog is not None:
        (root / "projects" / "catalog.json").write_text(json.dumps(catalog))
    if state is not None:
        (root / "state.json").write_text(state if isinstance(state, str) else json.dumps(state))
    return root


def test_boot_after_an_upgrade_rotates_the_revision_and_writes_the_catalog(tmp_path):
    root = _write_state(tmp_path, _catalog("c" * 32, marked=False), _state(marked=False))
    _boot(tmp_path)
    catalog = json.loads((root / "projects" / "catalog.json").read_text())
    assert catalog["workspaceRevision"] != "c" * 32
    project = catalog["projects"]["b" * 32]
    assert project["_paramsVersion"] == PARAMS_VERSION
    assert project["snapshot"]["nodes"][0]["data"]["params"]["max_tokens"] == UPGRADED_MAX_TOKENS
    state = json.loads((root / "state.json").read_text())
    assert state["paramsVersion"] == PARAMS_VERSION
    assert state["nodes"][0]["params"]["max_tokens"] == UPGRADED_MAX_TOKENS

    # Once: the next restart finds everything current and keeps the revision.
    rotated = catalog["workspaceRevision"]
    before = (root / "projects" / "catalog.json").read_bytes()
    _boot(tmp_path)
    assert (root / "projects" / "catalog.json").read_bytes() == before
    assert json.loads(before)["workspaceRevision"] == rotated


def test_boot_rotates_when_only_the_live_graph_advanced_even_with_no_value_changed(tmp_path):
    """The tab may hold values that were never saved, so the version decides,
    not whether a saved value changed."""
    root = _write_state(tmp_path, _catalog("c" * 32, marked=True), _state(marked=False, nodes=False))
    _boot(tmp_path)
    assert json.loads((root / "projects" / "catalog.json").read_text())["workspaceRevision"] != "c" * 32
    assert json.loads((root / "state.json").read_text())["paramsVersion"] == PARAMS_VERSION


def test_boot_with_everything_current_changes_nothing(tmp_path):
    root = _write_state(tmp_path, _catalog("c" * 32, marked=True), _state(marked=True))
    before = (root / "projects" / "catalog.json").read_bytes()
    _boot(tmp_path)
    assert (root / "projects" / "catalog.json").read_bytes() == before


def test_boot_skips_the_step_when_state_json_fails_to_load(tmp_path):
    root = _write_state(tmp_path, _catalog("c" * 32, marked=False), "{not json")
    before = (root / "projects" / "catalog.json").read_bytes()
    _boot(tmp_path)
    assert (root / "projects" / "catalog.json").read_bytes() == before


def test_boot_without_a_catalog_writes_none(tmp_path):
    root = _write_state(tmp_path, None, _state(marked=False))
    _boot(tmp_path)
    assert not (root / "projects" / "catalog.json").exists()
