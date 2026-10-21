"""A Style's and a Character's images are Nebula's own files.

``refImages`` and ``thumbnail`` on a Style (``/api/presets``) and
``referenceViews`` on a Character (``/api/characters``) are loaded by the app
as images. An outside link there makes the person's app fetch it (their
address and timing go to that host) and puts a picture they never chose on
screen. So every write, an agent's, the CLI's, an unnamed caller's and the
person's own, takes only a file Nebula serves: an output or an upload
(``/api/outputs/...``, a loopback URL to it, or its path inside the output
folder) or a shipped Style thumbnail (``/api/presets/thumbnails/<slug>``).
Anything else is a 422 that says what is allowed, and nothing is written.

A value the asset already holds is not checked again, so a Style or
Character saved before this check keeps loading and saving for the person.
"""
from __future__ import annotations

import importlib
import re
import json

import pytest
from fastapi.testclient import TestClient

from tests.conftest import PERSON

AGENT = {"X-Nebula-Agent": "Claude Code"}
OUTSIDE = "https://images.example.com/face.png"


@pytest.fixture
def local_images():
    """Three small files in Nebula's uploads folder, as /api/uploads leaves them."""
    from services.output import OUTPUT_ROOT

    folder = OUTPUT_ROOT / "chat-uploads"
    folder.mkdir(parents=True, exist_ok=True)
    paths = []
    for index in range(3):
        path = folder / f"stored-image-ref-{index}.png"
        path.write_bytes(b"\x89PNG\r\n\x1a\n" + bytes([index]) * 16)
        paths.append(path)
    yield [f"/api/outputs/chat-uploads/{p.name}" for p in paths], [str(p.resolve()) for p in paths]
    for path in paths:
        path.unlink(missing_ok=True)


@pytest.fixture
def client(tmp_path, monkeypatch):
    monkeypatch.setenv("NEBULA_CHARACTER_ROOT", str(tmp_path / "characters"))
    monkeypatch.setenv("NEBULA_PRESET_ROOT", str(tmp_path / "presets"))
    import main as main_module
    import services.preset_store as ps

    importlib.reload(ps)
    monkeypatch.setattr(main_module, "preset_store", ps.PresetStore())

    async def quiet(_data):
        return None

    monkeypatch.setattr(main_module.manager, "broadcast_raw", quiet)
    return TestClient(main_module.app)


def _character(views: list[str]) -> dict:
    return {"name": "Rina", "subjectType": "human", "referenceViews": views,
            "frozenTraitString": "late 20s", "seed": 7, "consistencyStrength": 0.9}


def _style(**fields) -> dict:
    return {"name": "Noir", "category": "My Styles", "prompt": "noir", "params": {},
            "modelId": "nano-banana", "refImages": [], "scope": "global", **fields}


def _detail(response) -> str:
    return str(response.json().get("detail"))


# ---------------------------------------------------------------- Characters

@pytest.mark.parametrize("headers", [AGENT, {}, PERSON], ids=["agent", "unnamed", "person"])
def test_a_character_with_an_outside_link_is_refused_and_not_saved(client, local_images, headers):
    urls, _ = local_images
    response = client.post("/api/characters", json=_character([urls[0], OUTSIDE, urls[2]]), headers=headers)

    assert response.status_code == 422, response.text
    detail = _detail(response)
    assert "referenceViews[1]" in detail
    assert "outside Nebula" in detail
    assert "/api/outputs/" in detail and "/api/uploads" in detail
    assert client.get("/api/characters").json() == []


def test_a_character_of_nebulas_own_files_saves_in_every_local_form(client, local_images):
    urls, paths = local_images
    views = [urls[0], paths[1], f"http://127.0.0.1:8000{urls[2]}"]
    response = client.post("/api/characters", json=_character(views), headers=AGENT)

    assert response.status_code == 200, response.text
    assert response.json()["referenceViews"] == views  # stored verbatim, in order
    assert response.json()["thumbnail"] == urls[0]


@pytest.mark.parametrize("bad", [
    "https://images.example.com/a.png",
    "http://192.168.1.20/a.png",
    "//images.example.com/a.png",
    "data:image/png;base64,iVBORw0KGgo=",
    "http://localhost:8000/api/moodboards/x",
    "/api/outputs/chat-uploads/not-there.png",
    "/api/outputs/../settings.json",
    "url_a",
    "",
], ids=["https", "lan", "protocol-relative", "data", "loopback-not-an-output", "missing", "traversal",
        "text", "empty"])
def test_a_reference_view_that_isnt_a_nebula_file_is_refused(client, local_images, bad):
    urls, _ = local_images
    response = client.post("/api/characters", json=_character([urls[0], urls[1], bad]), headers=AGENT)

    assert response.status_code == 422, response.text
    assert "referenceViews[2]" in _detail(response)


def test_a_local_file_outside_the_output_folder_is_refused(client, local_images, tmp_path):
    urls, _ = local_images
    elsewhere = tmp_path / "desktop.png"
    elsewhere.write_bytes(b"\x89PNG\r\n\x1a\n" + b"\0" * 16)
    response = client.post("/api/characters", json=_character([urls[0], urls[1], str(elsewhere)]), headers=AGENT)

    assert response.status_code == 422, response.text
    assert "referenceViews[2]" in _detail(response)


def test_a_character_put_with_an_outside_link_is_refused_and_writes_nothing(client, local_images):
    urls, _ = local_images
    made = client.post("/api/characters", json=_character(urls)).json()

    response = client.put(f"/api/characters/{made['id']}", json={"referenceViews": [*urls, OUTSIDE]}, headers=AGENT)

    assert response.status_code == 422, response.text
    assert "referenceViews[3]" in _detail(response)
    stored = client.get(f"/api/characters/{made['id']}").json()
    assert stored["referenceViews"] == urls and stored["version"] == 1


def _saved_before_the_check(tmp_path, record: dict, kind: str) -> None:
    """A file written by an older Nebula (or an agent before this check)."""
    folder = tmp_path / kind / "_global"
    folder.mkdir(parents=True, exist_ok=True)
    (folder / f"{record['id']}.json").write_text(json.dumps(record), encoding="utf-8")


def test_a_character_saved_before_the_check_still_loads_and_the_person_can_edit_it(client, local_images, tmp_path):
    urls, _ = local_images
    _saved_before_the_check(tmp_path, {
        "id": "oldchar00001", "name": "Old", "version": 1, "subjectType": "human",
        "referenceViews": [OUTSIDE, urls[0], urls[1]], "frozenTraitString": "x", "seed": 1,
        "consistencyStrength": 0.8, "thumbnail": OUTSIDE, "projectId": None,
        "createdAt": "2026-10-01T00:00:00+00:00", "updatedAt": "2026-10-01T00:00:00+00:00",
    }, "characters")

    got = client.get("/api/characters/oldchar00001")
    assert got.status_code == 200 and got.json()["referenceViews"][0] == OUTSIDE

    # The Studio sends the whole list when the person adds a view: the link
    # already on the Character is kept, a new one would be refused.
    kept = client.put("/api/characters/oldchar00001",
                      json={"referenceViews": [OUTSIDE, urls[0], urls[1], urls[2]], "baseVersion": 1}, headers=PERSON)
    assert kept.status_code == 200, kept.text
    added = client.put("/api/characters/oldchar00001",
                       json={"referenceViews": [OUTSIDE, urls[0], urls[1], "https://other.example/b.png"]},
                       headers=PERSON)
    assert added.status_code == 422, added.text
    assert "referenceViews[3]" in _detail(added)


# -------------------------------------------------------------------- Styles

@pytest.mark.parametrize("headers", [AGENT, {}, PERSON], ids=["agent", "unnamed", "person"])
def test_a_style_with_an_outside_ref_image_is_refused_and_not_saved(client, local_images, headers):
    urls, _ = local_images
    response = client.post("/api/presets", json=_style(refImages=[urls[0], OUTSIDE]), headers=headers)

    assert response.status_code == 422, response.text
    detail = _detail(response)
    assert "refImages[1]" in detail and "outside Nebula" in detail and "/api/outputs/" in detail
    assert client.get("/api/presets?scope=global").json() == []


def test_a_style_with_an_outside_thumbnail_is_refused(client, local_images):
    response = client.post("/api/presets", json=_style(thumbnail=OUTSIDE), headers=AGENT)

    assert response.status_code == 422, response.text
    assert "thumbnail" in _detail(response)


def test_the_apps_save_current_style_body_saves(client, local_images):
    """Create's "Save current" sends the uploads' file paths and the latest
    result's /api/outputs URL (CreateView.handleSaveCurrentStyle)."""
    urls, paths = local_images
    response = client.post("/api/presets", json=_style(refImages=paths[:2], thumbnail=urls[2], scope="global"),
                           headers=PERSON)

    assert response.status_code == 200, response.text
    assert response.json()["refImages"] == paths[:2] and response.json()["thumbnail"] == urls[2]


def test_a_shipped_style_thumbnail_is_accepted_and_a_made_up_one_is_not(client):
    import main as main_module

    slug = sorted((main_module._PRESET_SEED_PATH.parent / "thumbnails").glob("*.webp"))[0].stem
    assert client.post("/api/presets", json=_style(thumbnail=f"/api/presets/thumbnails/{slug}"),
                       headers=AGENT).status_code == 200
    response = client.post("/api/presets", json=_style(thumbnail="/api/presets/thumbnails/not-a-shipped-one"),
                           headers=AGENT)
    assert response.status_code == 422, response.text


def test_a_style_put_with_an_outside_link_is_refused_and_writes_nothing(client, local_images):
    urls, _ = local_images
    made = client.post("/api/presets", json=_style(refImages=[urls[0]])).json()

    for body, field in (({"refImages": [urls[0], OUTSIDE]}, "refImages[1]"), ({"thumbnail": OUTSIDE}, "thumbnail")):
        response = client.put(f"/api/presets/{made['id']}", json=body, headers=AGENT)
        assert response.status_code == 422, response.text
        assert field in _detail(response)
    stored = client.get(f"/api/presets/{made['id']}").json()
    assert stored["refImages"] == [urls[0]] and stored["thumbnail"] == "" and stored["version"] == 1


def test_an_outside_link_in_a_styles_image_params_is_refused(client):
    response = client.post("/api/presets", json=_style(params={"_previewUrl": OUTSIDE}), headers=AGENT)

    assert response.status_code == 422, response.text
    assert "params._previewUrl" in _detail(response)


def test_a_style_saved_before_the_check_still_loads_and_saves_with_its_own_links(client, local_images, tmp_path):
    urls, _ = local_images
    _saved_before_the_check(tmp_path, {
        "id": "oldstyle0001", "name": "Old", "category": "My Styles", "prompt": "p", "params": {},
        "modelId": "nano-banana", "refImages": [OUTSIDE], "thumbnail": OUTSIDE, "version": 1,
        "paramsVersion": 0, "scope": "global", "projectId": None,
        "createdAt": "2026-10-01T00:00:00+00:00", "updatedAt": "2026-10-01T00:00:00+00:00",
    }, "presets")

    assert client.get("/api/presets/oldstyle0001").json()["refImages"] == [OUTSIDE]
    renamed = client.put("/api/presets/oldstyle0001",
                         json={"name": "Old 2", "refImages": [OUTSIDE, urls[0]], "thumbnail": OUTSIDE})
    assert renamed.status_code == 200, renamed.text
    swapped = client.put("/api/presets/oldstyle0001", json={"thumbnail": "https://other.example/t.png"})
    assert swapped.status_code == 422, swapped.text


# ------------------------------------------------------------------- Agents

def test_agents_are_told_which_image_references_a_character_or_style_takes():
    """Justin's rule: the agent-facing docs say what the routes accept."""
    import asyncio
    from pathlib import Path

    import mcp_server

    tools = {tool.name: tool for tool in asyncio.run(mcp_server.mcp.list_tools())}
    move = tools["character_move"].description
    assert "referenceViews" in move and "/api/outputs/" in move and "/api/uploads" in move and "refused" in move
    assert "Character or a" in tools["moodboard_create"].description
    root = Path(__file__).resolve().parents[2]
    for doc in (root / "docs" / "MCP-SETUP.md", root / "skills" / "nebula" / "SKILL.md"):
        text = doc.read_text(encoding="utf-8")
        assert "`referenceViews`" in text and "`refImages`" in text and "/api/presets/thumbnails/" in text, doc
        assert re.search(r"run\b.{0,30}leaves (such a|that) view out", " ".join(text.split())), doc  # review fix


# ------------------------------------------------------- Review (2026-10-20)

def _old_character(tmp_path, urls) -> None:
    _saved_before_the_check(tmp_path, {
        "id": "oldchar00002", "name": "Old hero", "version": 1, "subjectType": "human",
        "referenceViews": [OUTSIDE, urls[0], urls[1]], "frozenTraitString": "x", "seed": 1,
        "consistencyStrength": 0.8, "thumbnail": OUTSIDE, "projectId": None,
        "createdAt": "2026-10-01T00:00:00+00:00", "updatedAt": "2026-10-01T00:00:00+00:00",
    }, "characters")


def test_a_studio_save_of_an_old_character_an_agent_deleted_says_it_is_in_recently_deleted(client, local_images,
                                                                                            tmp_path):
    """The Studio sends every view, the held outside link too. When the
    Character went to Recently deleted meanwhile, the answer is the in_trash
    404 the Studio turns into Restore, not a 422 about that link."""
    urls, _ = local_images
    _old_character(tmp_path, urls)
    assert client.delete("/api/characters/oldchar00002", headers=AGENT).status_code == 200

    response = client.put("/api/characters/oldchar00002",
                          json={"referenceViews": [OUTSIDE, urls[0], urls[1], urls[2]], "baseVersion": 1},
                          headers=PERSON)

    assert response.status_code == 404, response.text
    assert response.json().get("code") == "in_trash"


def test_a_stale_studio_save_of_an_old_character_gets_the_version_conflict(client, local_images, tmp_path):
    """An agent took the outside view out; the person's Studio, a version
    behind, still sends it. That is the 409 carrying the Character (the
    Studio merges and resends), not a 422 about a link it no longer holds."""
    urls, _ = local_images
    _saved_before_the_check(tmp_path, {
        "id": "oldchar00004", "name": "Old side", "version": 1, "subjectType": "human",
        "referenceViews": [urls[0], OUTSIDE, urls[1]], "frozenTraitString": "x", "seed": 1,
        "consistencyStrength": 0.8, "thumbnail": urls[0], "projectId": None,
        "createdAt": "2026-10-01T00:00:00+00:00", "updatedAt": "2026-10-01T00:00:00+00:00",
    }, "characters")
    assert client.put("/api/characters/oldchar00004", json={"referenceViews": urls, "baseVersion": 1},
                      headers=AGENT).status_code == 200

    response = client.put("/api/characters/oldchar00004",
                          json={"referenceViews": [urls[0], OUTSIDE, urls[1], urls[2]], "baseVersion": 1},
                          headers=PERSON)

    assert response.status_code == 409, response.text
    assert response.json()["character"]["referenceViews"] == urls


def test_a_model_change_checks_the_params_the_style_keeps_under_its_new_model(client, tmp_path):
    """A held param is held for its model: under nano-banana `filePath` is no
    image, under style-reference it is one, so moving the Style there checks
    it (a change that sends no params included)."""
    _saved_before_the_check(tmp_path, {
        "id": "oldstyle0003", "name": "Swap", "category": "My Styles", "prompt": "p",
        "params": {"filePath": OUTSIDE}, "modelId": "nano-banana", "refImages": [], "thumbnail": "",
        "version": 1, "paramsVersion": 0, "scope": "global", "projectId": None,
        "createdAt": "2026-10-01T00:00:00+00:00", "updatedAt": "2026-10-01T00:00:00+00:00",
    }, "presets")

    moved = client.put("/api/presets/oldstyle0003", json={"modelId": "style-reference"}, headers=AGENT)
    assert moved.status_code == 422, moved.text
    assert "params.filePath" in _detail(moved)
    assert client.get("/api/presets/oldstyle0003").json()["modelId"] == "nano-banana"

    # Renaming it under its own model still saves: the value stays held there.
    assert client.put("/api/presets/oldstyle0003", json={"name": "Swap 2"}, headers=AGENT).status_code == 200


def test_a_stale_save_of_an_old_style_gets_the_version_conflict(client, local_images, tmp_path):
    """As for a Character: a write a version behind is the 409 the caller
    re-reads from, not a 422 about a link the Style no longer holds."""
    urls, _ = local_images
    _saved_before_the_check(tmp_path, {
        "id": "oldstyle0002", "name": "Old two", "category": "My Styles", "prompt": "p", "params": {},
        "modelId": "nano-banana", "refImages": [urls[0], OUTSIDE], "thumbnail": "", "version": 1,
        "paramsVersion": 0, "scope": "global", "projectId": None,
        "createdAt": "2026-10-01T00:00:00+00:00", "updatedAt": "2026-10-01T00:00:00+00:00",
    }, "presets")
    assert client.put("/api/presets/oldstyle0002", json={"refImages": [urls[0]], "baseVersion": 1},
                      headers=AGENT).status_code == 200

    response = client.put("/api/presets/oldstyle0002",
                          json={"refImages": [urls[0], OUTSIDE, urls[1]], "baseVersion": 1}, headers=AGENT)

    assert response.status_code == 409, response.text
    assert response.json()["style"]["refImages"] == [urls[0]]


@pytest.mark.parametrize("link", [
    "https:/images.example.com/a.png",
    "https:images.example.com/a.png",
    "https:\\\\images.example.com\\a.png",
    "/\\images.example.com/a.png",
    "\\\\images.example.com/a.png",
], ids=["one-slash", "no-slash", "backslashes", "slash-backslash", "two-backslashes"])
def test_links_a_browser_reads_as_another_host_are_outside_links(client, link):
    """A browser reads each of these as https://images.example.com/... (or a
    protocol-relative link), so in a Style's image params they are refused."""
    from services.stored_image_refs import is_outside_link

    assert is_outside_link(link)
    response = client.post("/api/presets", json=_style(params={"_previewUrl": link}), headers=AGENT)
    assert response.status_code == 422, response.text
    assert "params._previewUrl" in _detail(response)


@pytest.mark.parametrize("local", ["/api/outputs/a.png", "/Users/me/output/a.png", "C:\\Users\\me\\output\\a.png",
                                   "http://127.0.0.1:8000/api/outputs/a.png", "a photo of a cat"])
def test_local_references_and_text_are_not_outside_links(local):
    from services.stored_image_refs import is_outside_link

    assert not is_outside_link(local)


@pytest.mark.asyncio
async def test_a_run_of_an_old_character_leaves_its_outside_views_out_and_says_so(monkeypatch, tmp_path):
    """The Character node's bundle is what a run sends and what the
    Inspector's Last output draws: an outside view stays on the Character but
    goes in neither, and the run says so."""
    from handlers.character_node import handle_character_node
    from models.events import execution_notes
    from models.graph import GraphNode

    monkeypatch.setenv("NEBULA_CHARACTER_ROOT", str(tmp_path / "characters"))
    _old_character(tmp_path, ["/api/outputs/a.png", "/api/outputs/b.png"])
    notes: list[str] = []
    token = execution_notes.set(notes)
    try:
        result = await handle_character_node(GraphNode(id="c1", definitionId="character",
                                                       params={"character": "oldchar00002"}), {}, {})
    finally:
        execution_notes.reset(token)

    assert result["character"]["value"]["referenceViews"] == ["/api/outputs/a.png", "/api/outputs/b.png"]
    assert len(notes) == 1 and "outside Nebula" in notes[0] and "Old hero" in notes[0]


@pytest.mark.asyncio
async def test_a_run_of_a_character_whose_views_are_all_outside_links_stops_with_what_to_do(monkeypatch, tmp_path):
    from handlers.character_node import handle_character_node
    from models.graph import GraphNode

    monkeypatch.setenv("NEBULA_CHARACTER_ROOT", str(tmp_path / "characters"))
    _saved_before_the_check(tmp_path, {
        "id": "oldchar00003", "name": "All web", "version": 1, "subjectType": "human",
        "referenceViews": [OUTSIDE, "https://images.example.com/b.png", "data:image/png;base64,iVBORw0KGgo="],
        "frozenTraitString": "x", "seed": 1, "consistencyStrength": 0.8, "thumbnail": OUTSIDE, "projectId": None,
        "createdAt": "2026-10-01T00:00:00+00:00", "updatedAt": "2026-10-01T00:00:00+00:00",
    }, "characters")

    with pytest.raises(ValueError, match="Character Studio"):
        await handle_character_node(GraphNode(id="c1", definitionId="character",
                                              params={"character": "oldchar00003"}), {}, {})


def test_a_loopback_looking_link_a_browser_sends_to_another_host_is_refused(client, local_images):
    """Python reads the host after the last "@" (127.0.0.1); a browser ends
    the host at the backslash and fetches images.example.com."""
    urls, _ = local_images
    sneaky = f"http://images.example.com\\@127.0.0.1:8000{urls[2]}"

    response = client.post("/api/characters", json=_character([urls[0], urls[1], sneaky]), headers=AGENT)

    assert response.status_code == 422, response.text
    assert "referenceViews[2]" in _detail(response)
