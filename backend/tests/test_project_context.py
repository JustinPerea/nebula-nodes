""""This project" for Characters, Moodboards and Styles is the canvas project
(GET /api/project), and new project assets must name one (main.py
_require_canvas_project)."""
from __future__ import annotations

import pytest
from fastapi.testclient import TestClient

from services.project_store import ProjectStore, make_project, move_to_trash

CHARACTER = {"name": "Rina", "subjectType": "human", "referenceViews": ["a", "b", "c"],
             "frozenTraitString": "warm", "seed": 7, "consistencyStrength": 0.9}
BOARD = {"name": "Warm", "images": [{"url": "/api/outputs/a.png"}]}
STYLE = {"name": "Warm", "category": "My Styles", "prompt": "warm", "params": {}, "modelId": None,
         "refImages": [], "scope": "project", "paramsVersion": 0}


@pytest.fixture
def catalog(tmp_path, monkeypatch):
    import main

    monkeypatch.setenv("NEBULA_MOODBOARD_ROOT", str(tmp_path / "moodboards"))
    monkeypatch.setenv("NEBULA_CHARACTER_ROOT", str(tmp_path / "characters"))
    monkeypatch.setenv("NEBULA_PRESET_ROOT", str(tmp_path / "presets"))
    store = ProjectStore(tmp_path / "projects")
    monkeypatch.setattr(main, "project_store", store)

    class Catalog:
        client = TestClient(main.app)

        def make(self, name, *, active=False, trashed=False):
            with store.transaction() as data:
                project = make_project(name)
                data["projects"][project["id"]] = project
                if active:
                    data["activeProjectId"] = project["id"]
                if trashed:
                    move_to_trash(data, project["id"])
                store.commit(data)
            return project["id"]

    return Catalog()


def test_project_is_the_open_canvas_project(catalog):
    catalog.make("Other")
    open_id = catalog.make("Nari shoot", active=True)

    response = catalog.client.get("/api/project")

    assert response.status_code == 200
    assert response.json() == {"id": open_id, "name": "Nari shoot"}


def test_no_open_project_is_a_404_that_says_so(catalog):
    catalog.make("Closed")
    response = catalog.client.get("/api/project")
    assert response.status_code == 404
    assert response.json()["detail"] == "No project is open."


@pytest.mark.parametrize("path,body", [
    ("/api/characters", CHARACTER), ("/api/moodboards", BOARD), ("/api/presets", STYLE)])
def test_a_new_project_asset_must_name_a_canvas_project(catalog, path, body):
    project_id = catalog.make("A", active=True)
    gone_id = catalog.make("Gone", trashed=True)

    made = catalog.client.post(path, json={**body, "projectId": project_id})
    assert made.status_code == 200, made.text
    assert made.json()["projectId"] == project_id

    unknown = catalog.client.post(path, json={**body, "projectId": "nebula_nodes"})
    assert unknown.status_code == 422
    assert unknown.json()["detail"].startswith("No project has the id 'nebula_nodes'. Use the id of a project from GET /api/projects")

    trashed = catalog.client.post(path, json={**body, "projectId": gone_id})
    assert trashed.status_code == 422
    assert trashed.json()["detail"].startswith("The project “Gone” is in Recently deleted. Restore it first")

    assert catalog.client.post(path, json={**body, "projectId": "../evil"}).status_code == 400


@pytest.mark.parametrize("path,body", [
    ("/api/characters", CHARACTER), ("/api/moodboards", BOARD), ("/api/presets", {**STYLE, "scope": "global"})])
def test_global_assets_need_no_project(catalog, path, body):
    made = catalog.client.post(path, json=body)
    assert made.status_code == 200, made.text
    assert made.json()["projectId"] is None


def test_lists_still_take_any_safe_id(catalog):
    for path in ("/api/characters", "/api/moodboards", "/api/presets"):
        listed = catalog.client.get(path, params={"scope": "project", "projectId": "nebula_nodes"})
        assert listed.status_code == 200 and listed.json() == []


@pytest.mark.asyncio
async def test_a_node_copied_into_another_project_still_runs_and_edits_its_asset(catalog):
    """Justin, 2026-10-19: "As long as we can copy the node moodboards live in
    to a different project". An asset lives in one project; a node that points
    at it by id works in any project, and edits from there keep it at home."""
    from handlers.character_node import handle_character_node
    from handlers.moodboard import handle_moodboard_node
    from models.graph import GraphNode
    from tests.test_asset_reference_params import _image_url

    home = catalog.make("Shoot A")
    image = _image_url("cross-project.png")
    board = catalog.client.post("/api/moodboards", json={
        "name": "A board", "images": [{"url": image}], "projectId": home}).json()
    hero = catalog.client.post("/api/characters", json={**CHARACTER, "projectId": home}).json()
    catalog.make("Shoot B", active=True)  # the node now sits on Shoot B's canvas

    ran = await handle_moodboard_node(GraphNode(id="n1", definitionId="nebula-moodboard",
                                                params={"moodboard": board["id"]}), {}, {})
    assert ran["moodboard"]["value"]["moodboardId"] == board["id"]
    assert ran["representative_images"]["value"] == [image]
    played = await handle_character_node(GraphNode(id="n2", definitionId="character",
                                                   params={"character": hero["id"]}), {}, {})
    assert played["character"]["value"]["characterId"] == hero["id"]

    # The Studio in Shoot B saves the whole draft, projectId and all: it stays in Shoot A.
    saved = catalog.client.put(f"/api/moodboards/{board['id']}", json={"name": "A board, edited", "projectId": home})
    assert saved.status_code == 200, saved.text
    renamed = catalog.client.put(f"/api/characters/{hero['id']}", json={"name": "Rina 2", "projectId": home})
    assert renamed.status_code == 200, renamed.text
    for path, asset in (("/api/moodboards", board), ("/api/characters", hero)):
        listed = catalog.client.get(path, params={"scope": "project", "projectId": home}).json()
        assert [item["id"] for item in listed] == [asset["id"]]
        assert catalog.client.get(f"{path}/{asset['id']}").json()["projectId"] == home
