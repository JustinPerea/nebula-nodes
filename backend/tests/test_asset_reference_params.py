"""The Moodboard and Character nodes name their saved asset in a public param.

Gap 13 in the Good Machines design-canvas log: an agent couldn't point a
Moodboard node at a board. The id lived in the internal ``_moodboardId``,
which /api/graph/apply refused, and the public ``moodboard`` param was hidden
and read only as an embedded dict. ``nebula set`` took the internal key,
so apply and set disagreed on what an agent may write.

Now ``moodboard`` / ``character`` are the reference (services/agent_params.py),
saved nodes move over (retired_nodes.migrate_params), and every agent path
refuses internal keys with the same message.
"""
from __future__ import annotations

import pytest
from fastapi.testclient import TestClient
from PIL import Image

from execution.engine import _with_current_params
from handlers.moodboard import handle_moodboard_node
from models.graph import GraphNode
from services.agent_presence import AgentPresence
from services.canvas_events import CanvasEventJournal
from services.canvas_pins import CanvasPins
from services.canvas_proposals import ProposalBook
from services.cli_graph import CLIGraph
from services.output import OUTPUT_ROOT
from services.project_store import ProjectStore, make_project
from services.provider_recovery import ProviderRecoveryStore
from services.provider_start_guard import ProviderStartGuard
from services.retired_nodes import migrate_params
from tests.conftest import PERSON

AGENT = {"X-Nebula-Agent": "GM - Design"}
MCP = {"X-Nebula-Client": "nebula-mcp"}

CHARACTER = {
    "name": "Rina", "subjectType": "human",
    "referenceViews": ["/api/outputs/c/a.png", "/api/outputs/c/b.png", "/api/outputs/c/c.png"],
    "frozenTraitString": "short silver hair", "seed": 7, "consistencyStrength": 0.6,
}


@pytest.fixture
def api(tmp_path, monkeypatch, person):
    import main as main_module

    monkeypatch.setenv("NEBULA_MOODBOARD_ROOT", str(tmp_path / "moodboards"))
    monkeypatch.setenv("NEBULA_CHARACTER_ROOT", str(tmp_path / "characters"))
    graph = CLIGraph(persist_path=tmp_path / "state.json")
    store = ProjectStore(tmp_path / "projects")
    with store.transaction() as catalog:
        project = make_project("Active")
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
    ctx.client = TestClient(main_module.app)
    ctx.project_id = project["id"]
    ctx.graph = graph
    ctx.sent = sent
    return ctx


def _image_url(name: str) -> str:
    path = OUTPUT_ROOT / "asset-ref-tests" / name
    path.parent.mkdir(parents=True, exist_ok=True)
    Image.new("RGB", (32, 24), (200, 80, 40)).save(path)
    return f"/api/outputs/{path.resolve().relative_to(OUTPUT_ROOT.resolve()).as_posix()}"


def _board(api, name="Good Machines") -> dict:
    response = api.client.post("/api/moodboards", json={"name": name, "images": [{"url": _image_url("a.png")}]})
    assert response.status_code == 200, response.text
    return response.json()


def _changed(api) -> list[dict]:
    return [message for message in api.sent if message.get("type") == "storedAssetChanged"]


# -- saved graphs ---------------------------------------------------------------

def test_a_saved_internal_id_moves_to_the_public_param_and_the_copies_go():
    assert migrate_params("nebula-moodboard", {
        "_moodboardId": "4df26f93ff63", "_moodboardName": "Old name", "_moodboardThumbnail": "/t.png",
        "_moodboardImageCount": 3, "_moodboardMode": "look",
    }) == {"moodboard": "4df26f93ff63"}
    assert migrate_params("character", {"_characterId": "c1", "_characterName": "R", "_characterThumbnail": "/t.png",
                                        "override_prompt": "smiling"}) == {"character": "c1", "override_prompt": "smiling"}


def test_a_public_value_already_set_wins_over_a_stale_internal_one():
    assert migrate_params("nebula-moodboard", {"moodboard": "new", "_moodboardId": "old"}) == {"moodboard": "new"}
    assert migrate_params("nebula-moodboard", {"moodboard": "", "_moodboardId": "old"}) == {"moodboard": "old"}


@pytest.mark.asyncio
async def test_a_node_saved_with_the_internal_id_still_runs(api):
    board = _board(api)
    saved = GraphNode(id="n2", definitionId="nebula-moodboard", params={"_moodboardId": board["id"]})
    result = await handle_moodboard_node(_with_current_params(saved), {}, {})
    assert result["moodboard"]["value"]["moodboardId"] == board["id"]
    assert "Good Machines" in result["style_brief"]["value"]


def test_the_canvas_dropping_a_node_with_old_keys_gets_the_public_param(api):
    board = _board(api)
    response = api.client.post("/api/graph/node", json={
        "definitionId": "nebula-moodboard",
        "params": {"_moodboardId": board["id"], "_moodboardName": "Good Machines", "_moodboardImageCount": 1},
    })
    assert response.status_code == 200, response.text
    assert response.json()["params"] == {"moodboard": board["id"]}


# -- agents point the node at a board -------------------------------------------

@pytest.mark.asyncio
async def test_an_agent_points_an_existing_node_at_a_board_and_it_runs(api):
    board = _board(api)
    node_id = api.graph.add_node("nebula-moodboard", {})
    response = api.client.put(f"/api/graph/node/{node_id}", headers=AGENT, json={"params": {"moodboard": board["id"]}})
    assert response.status_code == 200, response.text
    stored = api.graph.nodes[node_id]["params"]
    assert stored["moodboard"] == board["id"]
    result = await handle_moodboard_node(
        GraphNode(id=node_id, definitionId="nebula-moodboard", params=stored), {}, {})
    assert result["representative_images"]["value"] == [board["images"][0]["url"]]


def test_apply_builds_a_moodboard_node_wired_to_a_generator(api):
    board = _board(api)
    response = api.client.post("/api/graph/apply", headers=AGENT, json={
        "note": "Board into a prompt",
        "nodes": [{"ref": "+mood", "definitionId": "nebula-moodboard", "params": {"moodboard": board["id"]}},
                  {"ref": "+img", "definitionId": "nano-banana", "params": {}}],
        "edges": [{"source": "+mood", "sourceHandle": "style_brief", "target": "+img", "targetHandle": "prompt"}],
    })
    assert response.status_code == 200, response.text
    node_id = response.json()["idMap"]["+mood"]
    assert api.graph.nodes[node_id]["params"]["moodboard"] == board["id"]


@pytest.mark.parametrize("headers", [AGENT, MCP])
def test_an_agent_naming_a_board_that_does_not_exist_is_told_where_ids_come_from(api, headers):
    node_id = api.graph.add_node("nebula-moodboard", {})
    response = api.client.put(f"/api/graph/node/{node_id}", headers=headers, json={"params": {"moodboard": "nope"}})
    assert response.status_code == 400
    assert response.json()["detail"] == f"{node_id}.moodboard: there's no moodboard 'nope'; GET /api/moodboards lists them"
    assert api.graph.nodes[node_id]["params"] == {}


def test_apply_and_proposals_check_the_board_too(api):
    body = {"note": "x", "nodes": [{"ref": "+m", "definitionId": "nebula-moodboard", "params": {"moodboard": "nope"}}]}
    applied = api.client.post("/api/graph/apply", headers=AGENT, json=body)
    proposed = api.client.post("/api/canvas/proposals", headers=AGENT, json=body)
    for response in (applied, proposed):
        assert response.status_code == 400
        assert "there's no moodboard 'nope'" in response.json()["detail"]
    assert api.graph.nodes == {}


def test_a_character_node_is_pointed_the_same_way(api):
    character = api.client.post("/api/characters", json=CHARACTER).json()
    node_id = api.graph.add_node("character", {})
    ok = api.client.put(f"/api/graph/node/{node_id}", headers=AGENT, json={"params": {"character": character["id"]}})
    assert ok.status_code == 200, ok.text
    missing = api.client.put(f"/api/graph/node/{node_id}", headers=AGENT, json={"params": {"character": "nope"}})
    assert missing.status_code == 400
    assert "GET /api/characters lists them" in missing.json()["detail"]


def test_a_reference_must_be_an_id_for_everyone(api):
    node_id = api.graph.add_node("nebula-moodboard", {})
    for headers in (AGENT, PERSON, {}):
        response = api.client.put(f"/api/graph/node/{node_id}", headers=headers,
                                  json={"params": {"moodboard": {"images": []}}})
        assert response.status_code == 400
        assert response.json()["detail"].endswith("must be a moodboard id; GET /api/moodboards lists them")


def test_a_node_whose_board_was_deleted_still_saves_its_other_params(api):
    board = _board(api)
    node_id = api.graph.add_node("nebula-moodboard", {"moodboard": board["id"]})
    assert api.client.delete(f"/api/moodboards/{board['id']}").status_code == 200
    # The canvas re-sends the dangling id with an unrelated change: not refused.
    response = api.client.put(f"/api/graph/node/{node_id}", headers=AGENT,
                              json={"params": {"moodboard": board["id"]}})
    assert response.status_code == 200, response.text


def test_the_canvas_and_the_person_are_not_checked_for_existence(api):
    # Pasting a node whose board is gone keeps the id; the card says it's missing.
    for headers in (PERSON, {}):
        response = api.client.post("/api/graph/node", headers=headers,
                                   json={"definitionId": "nebula-moodboard", "params": {"moodboard": "gone"}})
        assert response.status_code == 200, response.text


# -- one rule for internal params -----------------------------------------------

@pytest.mark.parametrize("headers", [AGENT, MCP])
def test_agents_cannot_write_internal_params_on_any_route(api, headers):
    node_id = api.graph.add_node("nebula-moodboard", {})
    set_response = api.client.put(f"/api/graph/node/{node_id}", headers=headers,
                                  json={"params": {"_moodboardId": "4df26f93ff63"}})
    create_response = api.client.post("/api/graph/node", headers=headers,
                                      json={"definitionId": "image-input", "params": {"_previewUrl": "/x.png"}})
    assert set_response.status_code == 422
    assert set_response.json()["detail"] == (
        f"{node_id}.params._moodboardId is internal (the canvas keeps it); set moodboard instead")
    assert create_response.status_code == 422
    assert "image-input.params._previewUrl is internal (the canvas keeps it)" in create_response.json()["detail"]
    assert api.graph.nodes[node_id]["params"] == {} and len(api.graph.nodes) == 1


def test_apply_gives_the_same_answer_as_set(api):
    node_id = api.graph.add_node("nebula-moodboard", {})
    response = api.client.post("/api/graph/apply", headers=AGENT, json={
        "note": "x", "params": [{"nodeId": node_id, "params": {"_moodboardId": "4df26f93ff63"}}]})
    assert response.status_code == 422
    assert response.json()["detail"] == (
        "params[0].params._moodboardId is internal (the canvas keeps it); set moodboard instead")


def test_the_canvas_still_keeps_its_own_bookkeeping(api):
    node_id = api.graph.add_node("image-input", {})
    for headers in (PERSON, {}):
        response = api.client.put(f"/api/graph/node/{node_id}", headers=headers,
                                  json={"params": {"_previewUrl": "/api/outputs/x.png"}})
        assert response.status_code == 200, response.text
    assert api.graph.nodes[node_id]["params"]["_previewUrl"] == "/api/outputs/x.png"


def test_billing_params_keep_their_own_rule(api):
    node_id = api.graph.add_node("krea-2-generate", {"_kreaAuth": "api-token"})
    response = api.client.put(f"/api/graph/node/{node_id}", headers=AGENT, json={"params": {"_kreaAuth": "mcp"}})
    # Not the internal-param 422: the billing refusal (403) answers it.
    assert response.status_code == 403


def test_a_loaded_graph_still_meets_the_file_and_billing_guards(api):
    """`nebula load` now sends the saved file to /api/graph/import, outputs
    and `_` bookkeeping included, instead of recreating nodes one by one.
    The import checks every value against protected paths before staging
    anything, and a billing key still gets the billing refusal."""
    from services import settings as settings_module

    api.graph.add_node("text-input", {"text": "keep"})
    before = api.graph.get_state()
    secret = str(settings_module.SETTINGS_PATH)
    planted_output = {"nodes": [{"id": "a", "definitionId": "image-input", "params": {},
                                 "outputs": {"image": {"type": "Image", "value": secret}}}], "edges": []}
    planted_param = {"nodes": [{"id": "a", "definitionId": "image-input",
                                "params": {"filePath": secret, "_previewUrl": secret}}], "edges": []}
    billing = {"nodes": [{"id": "a", "definitionId": "krea-2-generate", "params": {"_kreaAuth": "mcp"}}],
               "edges": []}
    for body, status, says in ((planted_output, 400, "Protected"), (planted_param, 400, "Protected"),
                               (billing, 403, "")):
        response = api.client.post("/api/graph/import", headers=AGENT, json=body)
        assert response.status_code == status, response.text
        assert says in response.json()["detail"]
    assert api.graph.get_state() == before


def test_cli_refuses_internal_params_before_sending(monkeypatch, capsys):
    from cli.client import NebulaClient

    client = NebulaClient("http://127.0.0.1:9")
    sent: list[tuple] = []
    monkeypatch.setattr(client, "_request", lambda *args, **kwargs: sent.append(args) or {"id": "n1"})
    with pytest.raises(SystemExit) as exc:
        client.update_node("n2", {"_moodboardId": "4df26f93ff63"})
    assert exc.value.code == 1
    assert capsys.readouterr().err.strip() == (
        "error: n2._moodboardId is internal (the canvas keeps it); set moodboard instead")
    assert sent == []
    # The public param and the billing params go to the backend, which decides.
    client.update_node("n2", {"moodboard": "4df26f93ff63"})
    client.create_node("flux-2-pro", {"_provider": "bfl"})
    assert [call[0] for call in sent] == ["PUT", "POST"]


# -- agents can see the param ---------------------------------------------------

@pytest.mark.parametrize(("definition_id", "key", "route"), [
    ("nebula-moodboard", "moodboard", "GET /api/moodboards"),
    ("character", "character", "GET /api/characters"),
])
def test_describe_lists_the_reference_and_where_its_ids_come_from(api, definition_id, key, route):
    response = api.client.get(f"/api/agent/nodes/{definition_id}", headers=AGENT)
    assert response.status_code == 200, response.text
    params = {param["key"]: param for param in response.json()["params"]}
    assert params[key] == {"key": key, "type": key, "required": True, "idsFrom": route}


# -- the canvas hears about changes ----------------------------------------------

def test_moodboard_changes_reach_the_canvas(api):
    board = _board(api)
    api.client.put(f"/api/moodboards/{board['id']}", json={"name": "Renamed"})
    api.client.post(f"/api/moodboards/{board['id']}/analyze")
    api.client.delete(f"/api/moodboards/{board['id']}")
    assert _changed(api) == [
        {"type": "storedAssetChanged", "kind": "moodboard", "id": board["id"], "deleted": False},
        {"type": "storedAssetChanged", "kind": "moodboard", "id": board["id"], "deleted": False},
        {"type": "storedAssetChanged", "kind": "moodboard", "id": board["id"], "deleted": False},
        {"type": "storedAssetChanged", "kind": "moodboard", "id": board["id"], "deleted": True},
    ]


def test_character_changes_reach_the_canvas(api):
    character = api.client.post("/api/characters", json=CHARACTER).json()
    api.client.put(f"/api/characters/{character['id']}", json={"name": "Rina Vane"})
    api.client.delete(f"/api/characters/{character['id']}")
    assert [(m["kind"], m["id"], m["deleted"]) for m in _changed(api)] == [
        ("character", character["id"], False), ("character", character["id"], False),
        ("character", character["id"], True)]


def test_nebula_info_says_where_the_ids_come_from():
    import json
    from pathlib import Path

    from cli.formatter import format_node_detail

    definitions = json.loads((Path(__file__).parents[1] / "data" / "node_definitions.json").read_text())
    text = format_node_detail(definitions["nebula-moodboard"])
    assert "moodboard           moodboard   (a moodboard id; GET /api/moodboards lists them)" in text
