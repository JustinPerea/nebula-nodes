"""Q123 a (Justin, 2026-10-24): "Yes: `nebula load` and an MCP tool open a
bundle, restoring its files, as Load graph does. A big one opens as a new
project."

graph_file_client.py is the one module behind `nebula load <file>` and MCP
load_graph_file(path), as upload_client.py is behind `nebula upload` and
upload_file. It opens a plain .nebula / .json or a .nebula.zip as the
person's Load graph does (frontend/src/components/GraphFileActions.tsx):
a bundle's files are restored and its links rewritten (the restore's
rewriteLinks), the canvas-shaped file becomes the import body the tab sends,
and Q120's rule decides where it lands: with a project open the import asks
to be refused when the file is over the save limit on its own; on that 413 a
project named after the file is made (projectNameForFile's port) and the
file loads there. The open project is never emptied or overwritten for a
file over the limit.
"""
from __future__ import annotations

import io
import json
import zipfile
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

AGENT = {"X-Nebula-Agent": "Claude Code"}
LIMIT = 8 * 1024
PNG = b"\x89PNG\r\n\x1a\n" + b"\x00" * 32


@pytest.fixture
def api(tmp_path, monkeypatch):
    import main as main_module
    from nebula_api import NebulaAPI

    graph = CLIGraph(persist_path=tmp_path / "state.json")
    store = ProjectStore(tmp_path / "projects")
    with store.transaction() as catalog:
        project = make_project("Glass campaign")
        catalog["projects"][project["id"]] = project
        catalog["activeProjectId"] = project["id"]
        store.commit(catalog)

    async def capture(data):
        return None

    output_root = tmp_path / "output"
    output_root.mkdir()
    monkeypatch.setattr(main_module, "OUTPUT_ROOT", output_root)
    monkeypatch.setattr(main_module, "cli_graph", graph)
    monkeypatch.setattr(main_module, "project_store", store)
    monkeypatch.setattr(main_module, "canvas_pins", CanvasPins(lambda: main_module.project_store))
    monkeypatch.setattr(main_module, "canvas_proposals", ProposalBook())
    monkeypatch.setattr(main_module, "canvas_arrange", ArrangeBook())
    monkeypatch.setattr(main_module, "agent_presence", AgentPresence())
    monkeypatch.setattr(main_module, "canvas_events", CanvasEventJournal())
    monkeypatch.setattr(main_module.manager, "broadcast_raw", capture)
    monkeypatch.setattr(main_module.manager, "broadcast_browser", capture)
    monkeypatch.setattr(main_module, "MAX_PROJECT_BYTES", LIMIT)

    class Ctx:
        pass

    ctx = Ctx()
    ctx.client = TestClient(main_module.app)
    ctx.http = NebulaAPI("http://testserver", client=ctx.client)
    ctx.graph = graph
    ctx.store = store
    ctx.project_id = project["id"]
    ctx.output_root = output_root
    ctx.main = main_module
    return ctx


def _canvas_file(nodes: list[dict], edges: list[dict] | None = None, **extra) -> dict:
    """A .nebula as the tab's serializeGraph writes it."""
    return {"version": 3, "paramsVersion": 1, "name": "Glass", "createdAt": "2026-10-24T00:00:00.000Z",
            "nodes": nodes, "edges": edges or [], **extra}


def _node(node_id: str, definition_id: str, params: dict, outputs: dict | None = None, *, y: float = 0) -> dict:
    data = {"label": node_id.title(), "definitionId": definition_id, "params": params,
            "state": "complete" if outputs else "idle"}
    if outputs:
        data["outputs"] = outputs
    return {"id": node_id, "type": "model-node", "position": {"x": 0, "y": y}, "data": data}


def _picture_graph() -> dict:
    return _canvas_file(
        [_node("pic", "image-input", {"filePath": "/api/outputs/old/pic.png"},
               {"image": {"type": "Image", "value": "http://localhost:8000/api/outputs/old/pic.png"}}),
         _node("out", "image-compare", {}, y=200)],
        [{"id": "e1", "source": "pic", "sourceHandle": "image", "target": "out", "targetHandle": "imageA",
          "type": "typed-edge", "data": {"dataType": "Image"}}])


def _big_graph() -> dict:
    return _canvas_file([_node("brief", "text-input", {"value": "b" * (LIMIT + 1)})])


def _bundle(path: Path, graph: dict, assets: dict[str, bytes]) -> Path:
    buffer = io.BytesIO()
    with zipfile.ZipFile(buffer, "w", zipfile.ZIP_STORED) as archive:
        archive.writestr("graph.json", json.dumps(graph))
        for name, data in assets.items():
            archive.writestr(f"assets/{name}", data)
    path.write_bytes(buffer.getvalue())
    return path


def _keep_a_node(api) -> str:
    return api.graph.add_node("text-input", {"value": "kept"})


def _stored(api, project_id: str) -> dict:
    return api.store.read()["projects"][project_id]


# -- a small file replaces the open project's canvas ------------------------------------

def test_a_small_bundle_replaces_the_open_canvas_and_its_picture_is_restored(api, tmp_path):
    import graph_file_client

    _keep_a_node(api)
    path = _bundle(tmp_path / "Glass.nebula.zip", _picture_graph(), {"old/pic.png": PNG})

    result = graph_file_client.load(api.http, str(path), headers=AGENT)

    assert result["openedAsNewProject"] is False
    assert result["project"] == {"id": api.project_id, "name": "Glass campaign"}
    assert result["nodeCount"] == 2 and result["edgeCount"] == 1 and result["filesRestored"] == 1
    assert result["savingPaused"] is False and "previousProject" not in result
    nodes = list(api.graph.nodes.values())
    assert [node["definitionId"] for node in nodes] == ["image-input", "image-compare"]
    served = nodes[0]["outputs"]["image"]["value"]
    assert served.startswith("/api/outputs/") and "restored-" in served
    assert (api.output_root / served.removeprefix("/api/outputs/")).read_bytes() == PNG
    # The import keeps an Image Input's file as its path on disk, as for the tab.
    assert Path(nodes[0]["params"]["filePath"]) == (api.output_root / served.removeprefix("/api/outputs/")).resolve()


def test_a_bundle_whose_files_are_missing_says_so_and_still_loads(api, tmp_path):
    import graph_file_client

    path = _bundle(tmp_path / "Glass.nebula.zip", _picture_graph(), {})
    result = graph_file_client.load(api.http, str(path), headers=AGENT)
    assert result["filesRestored"] == 0
    assert "Bundled asset unavailable: old/pic.png" in result["warnings"]
    picture = next(node for node in api.graph.nodes.values() if node["definitionId"] == "image-input")
    assert not picture["params"].get("filePath")


# -- a big file opens as a new project ----------------------------------------------------

def test_a_big_bundle_opens_as_a_new_project_named_after_the_file(api, tmp_path):
    import graph_file_client

    kept = _keep_a_node(api)
    path = _bundle(tmp_path / "Big campaign.nebula.zip", _big_graph(), {"old/pic.png": PNG})

    result = graph_file_client.load(api.http, str(path), headers=AGENT)

    assert result["openedAsNewProject"] is True
    assert result["project"]["name"] == "Big campaign" and result["project"]["id"] != api.project_id
    assert result["previousProject"] == {"id": api.project_id, "name": "Glass campaign"}
    assert result["savingPaused"] is True and result["size"]["overLimit"] is True
    assert result["filesRestored"] == 1
    note = result["note"]
    assert "Big campaign" in note and "project_size" in note and f"open_project('{api.project_id}')" in note
    listing = api.client.get("/api/projects").json()
    assert listing["activeProjectId"] == result["project"]["id"]
    assert [node["params"]["value"] for node in api.graph.nodes.values()] == ["b" * (LIMIT + 1)]
    # The project that was open is as it was: its node, nothing of the file.
    glass = _stored(api, api.project_id)["snapshot"]
    assert [node["data"]["params"]["value"] for node in glass["nodes"]] == ["kept"]
    assert kept not in api.graph.nodes or api.graph.nodes[kept]["params"]["value"] != "kept"


def test_a_big_plain_file_opens_as_a_new_project_too(api, tmp_path):
    import graph_file_client

    _keep_a_node(api)
    path = tmp_path / "Big campaign.nebula"
    path.write_text(json.dumps(_big_graph()), encoding="utf-8")

    result = graph_file_client.load(api.http, str(path), headers=AGENT, via="cli")

    assert result["openedAsNewProject"] is True and result["project"]["name"] == "Big campaign"
    assert result["filesRestored"] == 0 and result["savingPaused"] is True
    assert "nebula project size" in result["note"] and f"nebula project open {api.project_id}" in result["note"]
    glass = _stored(api, api.project_id)["snapshot"]
    assert [node["data"]["params"]["value"] for node in glass["nodes"]] == ["kept"]


def test_a_file_that_would_take_the_open_project_over_opens_as_a_new_project(api, tmp_path):
    # Under the limit on its own, but the open project's run history takes
    # it over: an agent can't leave the open project over the limit, so the
    # file opens in a new project, which then saves normally.
    import graph_file_client

    with api.store.transaction() as catalog:
        catalog["projects"][api.project_id]["snapshot"]["runHistory"] = [{"note": "r" * (LIMIT // 2)}]
        api.store.commit(catalog)
    path = tmp_path / "Half.nebula"
    path.write_text(json.dumps(_canvas_file([_node("brief", "text-input", {"value": "h" * (LIMIT // 2)})])))

    result = graph_file_client.load(api.http, str(path), headers=AGENT)

    assert result["openedAsNewProject"] is True and result["project"]["name"] == "Half"
    assert result["savingPaused"] is False
    assert "Glass campaign" in result["note"]


def test_no_project_open_loads_into_the_canvas_whatever_its_size(api, tmp_path):
    import graph_file_client

    with api.store.transaction() as catalog:
        catalog["projects"].clear()
        catalog["activeProjectId"] = None
        api.store.commit(catalog)
    path = tmp_path / "Big campaign.nebula"
    path.write_text(json.dumps(_big_graph()))
    result = graph_file_client.load(api.http, str(path), headers=AGENT)
    assert result["openedAsNewProject"] is False and result["project"] is None
    assert [node["params"]["value"] for node in api.graph.nodes.values()] == ["b" * (LIMIT + 1)]


# -- the import body is the tab's ---------------------------------------------------------

def test_a_canvas_shaped_file_becomes_the_body_the_tab_sends():
    import graph_file_client

    graph = _canvas_file(
        [_node("a", "text-input", {"value": "hi", "sourceDuration": 3.5, "_sourceFps": 24, "sourceFps": 30},
               {"text": {"type": "Text", "value": "hi"}}),
         _node("b", "text-input", {"value": "x"}, y=120)],
        [{"id": "e1", "source": "a", "sourceHandle": None, "target": "b", "targetHandle": None, "type": "typed-edge"}])
    graph.pop("paramsVersion")

    body = graph_file_client.import_body(graph, declared_params=lambda definition_id: {"value"})

    assert body == {
        "nodes": [
            {"id": "a", "definitionId": "text-input", "label": "A",
             "params": {"value": "hi", "_sourceFps": 24, "_sourceDuration": 3.5},
             "outputs": {"text": {"type": "Text", "value": "hi"}}, "position": {"x": 0, "y": 0}},
            {"id": "b", "definitionId": "text-input", "label": "B", "params": {"value": "x"}, "outputs": {},
             "position": {"x": 0, "y": 120}},
        ],
        "edges": [{"source": "a", "sourceHandle": "", "target": "b", "targetHandle": ""}],
        # 0 for a file saved before the marker: the backend upgrades it once.
        "paramsVersion": 0,
    }


def test_a_file_nebula_save_wrote_loads_as_it_always_did(api, tmp_path):
    import graph_file_client

    saved = CLIGraph()
    saved.add_node("text-input", {"value": "one"})
    saved.add_node("text-input", {"value": "two"})
    path = tmp_path / "export.json"
    path.write_text(json.dumps(saved.get_state()))
    assert graph_file_client.import_body(saved.get_state(), declared_params=lambda _id: set()) == saved.get_state()
    result = graph_file_client.load(api.http, str(path), headers=AGENT)
    assert result["nodeCount"] == 2
    assert sorted(node["params"]["value"] for node in api.graph.nodes.values()) == ["one", "two"]


def test_an_unsafe_world_in_a_plain_file_is_left_out_with_the_canvas_line(api, tmp_path):
    import graph_file_client

    world = {"type": "World", "value": {"assets": {"splats": {"100k": "https://evil.example/s.spz"}}}}
    path = tmp_path / "World.nebula"
    path.write_text(json.dumps(_canvas_file([_node("t", "text-input", {"value": "x"}, {"world": world})])))
    result = graph_file_client.load(api.http, str(path), headers=AGENT)
    assert ("1 external World asset reference was omitted; only Nebula output assets can be loaded."
            in result["warnings"])
    assert all("world" not in (node.get("outputs") or {}) for node in api.graph.nodes.values())


# -- what is refused ----------------------------------------------------------------------

def test_a_zip_that_isnt_a_graph_is_refused_and_nothing_changes(api, tmp_path):
    import graph_file_client

    kept = _keep_a_node(api)
    path = tmp_path / "photos.zip"
    with zipfile.ZipFile(path, "w") as archive:
        archive.writestr("photo.png", PNG)
    with pytest.raises(graph_file_client.GraphFileError, match="graph.json"):
        graph_file_client.load(api.http, str(path), headers=AGENT)
    assert list(api.graph.nodes) == [kept]
    assert list(api.output_root.iterdir()) == []


@pytest.mark.parametrize("text,words", [
    ("not json at all", "isn't a Nebula graph"),
    ('{"nodes": "nope"}', "isn't a Nebula graph"),
    ('{"version": 9, "name": "x", "createdAt": "x", "nodes": [], "edges": []}', "newer Nebula"),
    ('{"nodes": [], "edges": [], "x": NaN}', "isn't a Nebula graph"),
])
def test_a_file_that_isnt_a_graph_is_refused_before_any_request(tmp_path, text, words):
    import graph_file_client
    from unittest.mock import Mock

    path = tmp_path / "x.nebula"
    path.write_text(text)
    http = Mock()
    with pytest.raises(graph_file_client.GraphFileError, match=words):
        graph_file_client.load(http, str(path), headers=AGENT)
    assert http.mock_calls == []


def test_a_protected_path_is_refused_before_any_request(tmp_path, monkeypatch):
    import graph_file_client
    from unittest.mock import Mock

    root = tmp_path / "commons"
    root.mkdir()
    monkeypatch.setenv("NEBULA_COMMONS_ROOT", str(root))
    private = _bundle(root / "private.nebula.zip", _picture_graph(), {})
    http = Mock()
    with pytest.raises(graph_file_client.GraphFileError):
        graph_file_client.load(http, str(private), headers=AGENT)
    assert http.mock_calls == []


def test_a_file_naming_a_protected_path_is_refused_before_any_request(tmp_path, monkeypatch):
    import graph_file_client
    from unittest.mock import Mock

    root = tmp_path / "commons"
    root.mkdir()
    monkeypatch.setenv("NEBULA_COMMONS_ROOT", str(root))
    path = tmp_path / "graph.nebula"
    path.write_text(json.dumps(_canvas_file([_node("p", "image-input", {"filePath": str(root / "a.png")})])))
    http = Mock()
    with pytest.raises(graph_file_client.GraphFileError):
        graph_file_client.load(http, str(path), headers=AGENT)
    assert http.mock_calls == []


def test_a_chat_turn_reads_only_its_own_workspace(tmp_path):
    import graph_file_client
    from unittest.mock import Mock
    from services.agent_workspaces import create_workspace, workspace_scope

    workspace = create_workspace(tmp_path / "state", brand="b")
    outside = tmp_path / "elsewhere.nebula"
    outside.write_text(json.dumps(_canvas_file([])))
    http = Mock()
    with workspace_scope(workspace):
        with pytest.raises(graph_file_client.GraphFileError, match="outside this chat's workspace"):
            graph_file_client.load(http, str(outside), headers=AGENT)
    assert http.mock_calls == []


def test_a_file_past_the_bundle_ceiling_is_refused_before_any_request(tmp_path, monkeypatch):
    import graph_file_client
    from unittest.mock import Mock

    monkeypatch.setattr(graph_file_client, "MAX_GRAPH_FILE_BYTES", 64)
    path = tmp_path / "big.nebula"
    path.write_text(json.dumps(_canvas_file([_node("t", "text-input", {"value": "x" * 100})])))
    http = Mock()
    with pytest.raises(graph_file_client.GraphFileError, match="Nebula opens graphs up to"):
        graph_file_client.load(http, str(path), headers=AGENT)
    assert http.mock_calls == []


def test_the_requests_carry_the_agents_own_headers_and_never_the_persons_token(api, tmp_path):
    import graph_file_client
    from services.person_gate import PERSON_HEADER

    seen: list[tuple[str, str, dict]] = []
    real = api.http.send

    def spy(method, path, *, headers=None, **kwargs):
        seen.append((method, path, dict(headers or {})))
        return real(method, path, headers=headers, **kwargs)

    api.http.send = spy  # type: ignore[method-assign]
    path = _bundle(tmp_path / "Big campaign.nebula.zip", _big_graph(), {"old/pic.png": PNG})
    graph_file_client.load(api.http, str(path), headers=AGENT)
    paths = [entry[1] for entry in seen]
    assert any(entry.startswith("/api/outputs/restore") for entry in paths)
    assert paths.index(next(p for p in paths if p.startswith("/api/outputs/restore"))) < paths.index("/api/projects") \
        or "/api/projects" not in paths[:1]
    for _method, _path, headers in seen:
        assert headers.get("X-Nebula-Agent") == "Claude Code"
        assert PERSON_HEADER.lower() not in {key.lower() for key in headers}


def test_without_a_name_the_cli_still_says_its_an_agent(api, tmp_path, monkeypatch):
    # The CLI without NEBULA_AGENT_NAME sends no cursor name; the load still
    # carries an agent marker, so a big file gets the agents' size answer
    # (and opens as a new project), not the person gate's reconnect refusal.
    import graph_file_client

    monkeypatch.delenv("NEBULA_AGENT_NAME", raising=False)
    path = tmp_path / "Big campaign.nebula"
    path.write_text(json.dumps(_big_graph()))
    result = graph_file_client.load(api.http, str(path), headers={})
    assert result["openedAsNewProject"] is True


# -- the import route: a new project made for an over-limit file ---------------------------

def test_an_agent_may_load_a_file_over_the_limit_into_an_empty_project_made_for_it(api):
    body = {"nodes": [{"id": "x1", "definitionId": "text-input", "params": {"value": "d" * (LIMIT + 1)}}], "edges": []}
    refused = api.client.post("/api/graph/import", headers=AGENT, json=body)
    assert refused.status_code == 413 and refused.json()["limit"] == "size"
    loaded = api.client.post("/api/graph/import", headers=AGENT, json={**body, "newProjectForFile": True})
    assert loaded.status_code == 200, loaded.text
    assert [node["params"]["value"] for node in api.graph.nodes.values()] == ["d" * (LIMIT + 1)]


def test_the_new_project_flag_never_replaces_a_canvas_that_has_nodes(api):
    kept = _keep_a_node(api)
    body = {"nodes": [{"id": "x1", "definitionId": "text-input", "params": {"value": "small"}}], "edges": [],
            "newProjectForFile": True}
    refused = api.client.post("/api/graph/import", headers=AGENT, json=body)
    assert refused.status_code == 409, refused.text
    assert "new_project" in refused.json()["detail"]
    assert list(api.graph.nodes) == [kept]


def test_the_on_its_own_refusal_says_it_was_the_file(api):
    body = {"nodes": [{"id": "x1", "definitionId": "text-input", "params": {"value": "d" * (LIMIT + 1)}}], "edges": [],
            "refuseOverSaveLimit": True}
    refused = api.client.post("/api/graph/import", headers=AGENT, json=body)
    assert refused.status_code == 413 and refused.json()["scope"] == "graph"


# -- the CLI and the MCP tool ---------------------------------------------------------------

def test_nebula_load_says_what_happened(api, tmp_path, capsys, monkeypatch):
    from cli.commands.graph import run_load

    class Client:
        api = None
        base_url = "http://testserver"

        def _identity_headers(self, headers=None):
            return {**(headers or {}), "X-Nebula-Agent": "Codex"}

    client = Client()
    client.api = api.http
    _keep_a_node(api)
    path = tmp_path / "Big campaign.nebula"
    path.write_text(json.dumps(_big_graph()))
    run_load(client, str(path))
    out = capsys.readouterr().out
    assert "Big campaign" in out and "new project" in out and "nebula project size" in out
    assert f"nebula project open {api.project_id}" in out


def test_nebula_load_refuses_cleanly(tmp_path, capsys):
    from unittest.mock import Mock
    from cli.commands.graph import run_load

    path = tmp_path / "photos.zip"
    path.write_bytes(b"PK\x03\x04 not really a zip")
    client = Mock()
    client._identity_headers.return_value = {}
    client.api.request.side_effect = __import__("nebula_api").NebulaAPIError("Not a valid zip bundle: bad", status=400)
    client.api.send.side_effect = client.api.request.side_effect
    with pytest.raises(SystemExit) as exc:
        run_load(client, str(path))
    assert exc.value.code == 1
    err = capsys.readouterr().err
    assert err.startswith("error: ") and "Traceback" not in err


def test_the_mcp_tool_loads_a_file_and_is_listed_and_documented(api, tmp_path, monkeypatch):
    import mcp_server
    from cli.__main__ import build_parser
    from services.krea_agent_mcp import NEBULA_MCP_TOOLS

    assert "load_graph_file" in NEBULA_MCP_TOOLS
    monkeypatch.setattr(mcp_server, "_api", lambda: api.http)
    path = _bundle(tmp_path / "Glass.nebula.zip", _picture_graph(), {"old/pic.png": PNG})
    result = mcp_server.load_graph_file(str(path))
    assert result["nodeCount"] == 2 and result["filesRestored"] == 1
    with pytest.raises(RuntimeError, match="graph.json"):
        bad = tmp_path / "photos.zip"
        with zipfile.ZipFile(bad, "w") as archive:
            archive.writestr("photo.png", PNG)
        mcp_server.load_graph_file(str(bad))
    args = build_parser().parse_args(["load", "Big campaign.nebula.zip"])
    assert args.command == "load" and args.file == "Big campaign.nebula.zip"
    root = Path(__file__).resolve().parents[2]
    for doc in ("docs/MCP-SETUP.md", "skills/nebula/SKILL.md"):
        text = (root / doc).read_text()
        assert "load_graph_file" in text and "nebula load" in text and ".nebula.zip" in text
    skill = (root / "skills/nebula/SKILL.md").read_text()
    assert "Ask the person to open it with Load graph" not in skill and "ask the person to open one" not in skill
