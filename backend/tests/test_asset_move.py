"""Move a Moodboard or a Character between Global and a canvas project
(Justin's call P4, 2026-10-19): POST /api/{moodboards|characters}/{id}/move,
`nebula moodboard move`, `nebula character move`, and the MCP's
moodboard_move / character_move. Contract 07, 1.10."""
from __future__ import annotations

import asyncio
import json
from pathlib import Path

import pytest
from fastapi.testclient import TestClient

import mcp_server
from cli.__main__ import build_parser
from cli.client import NebulaClient
from cli.commands import character as character_cmd
from cli.commands import moodboard as moodboard_cmd
from nebula_api import NebulaAPI
from services.project_store import ProjectStore, make_project, move_to_trash
from tests.conftest import stored_image_urls

CHARACTER = {"name": "Rina", "subjectType": "human", "referenceViews": stored_image_urls(),
             "frozenTraitString": "warm", "seed": 7, "consistencyStrength": 0.9}
KINDS = {"moodboard": ("/api/moodboards", "moodboards"), "character": ("/api/characters", "characters")}

@pytest.fixture(autouse=True)
def _stored_views():
    """The Character's views must be files Nebula serves (services/stored_image_refs.py)."""
    stored_image_urls()



@pytest.fixture
def env(tmp_path, monkeypatch):
    import main

    monkeypatch.setenv("NEBULA_MOODBOARD_ROOT", str(tmp_path / "moodboards"))
    monkeypatch.setenv("NEBULA_CHARACTER_ROOT", str(tmp_path / "characters"))
    monkeypatch.delenv("NEBULA_AGENT_TOKEN", raising=False)
    monkeypatch.delenv("NEBULA_AGENT_NAME", raising=False)
    store = ProjectStore(tmp_path / "projects")
    monkeypatch.setattr(main, "project_store", store)
    sent: list[dict] = []

    async def record(data):
        sent.append(data)

    async def ignore(data):
        return None

    monkeypatch.setattr(main.manager, "broadcast_raw", record)
    monkeypatch.setattr(main.manager, "broadcast_browser", ignore)
    http = TestClient(main.app)
    monkeypatch.setattr(mcp_server, "_api", lambda: NebulaAPI("http://testserver", client=http))

    class Env:
        client = http
        broadcasts = sent
        root = tmp_path

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

        def close_all(self):
            with store.transaction() as data:
                data["activeProjectId"] = None
                store.commit(data)

        def create(self, kind, project_id=None, name=None):
            body = ({"name": name or "Warm", "images": [{"url": stored_image_urls(1, name="move")[0]}]} if kind == "moodboard"
                    else {**CHARACTER, "name": name or "Rina"})
            made = self.client.post(KINDS[kind][0], json={**body, **({"projectId": project_id} if project_id else {})})
            assert made.status_code == 200, made.text
            return made.json()

        def file(self, kind, folder, asset_id) -> Path:
            return self.root / KINDS[kind][1] / folder / f"{asset_id}.json"

        def listed(self, kind, project_id=None):
            params = {"scope": "project", "projectId": project_id} if project_id else {"scope": "global"}
            return [item["id"] for item in self.client.get(KINDS[kind][0], params=params).json()]

        def cli_client(self):
            client = NebulaClient("http://testserver")
            client._client = http
            return client

    return Env()


def _move(env, kind, asset_id, project_id, **kwargs):
    return env.client.post(f"{KINDS[kind][0]}/{asset_id}/move", json={"projectId": project_id}, **kwargs)


# -- routes -------------------------------------------------------------------

@pytest.mark.parametrize("kind", ["moodboard", "character"])
def test_project_to_global_and_back_moves_the_file_and_only_projectId(env, kind):
    shoot_a = env.make("Shoot A", active=True)
    asset = env.create(kind, shoot_a)
    before = json.loads(env.file(kind, shoot_a, asset["id"]).read_text())
    assert env.listed(kind, shoot_a) == [asset["id"]] and env.listed(kind) == []
    env.broadcasts.clear()

    moved = _move(env, kind, asset["id"], None)

    assert moved.status_code == 200, moved.text
    body = moved.json()
    assert (body["status"], body["from"], body["to"], body["fromName"], body["toName"]) == (
        "moved", shoot_a, None, "Shoot A", "Global")
    assert body["asset"]["projectId"] is None and body["kind"] == kind and body["id"] == asset["id"]
    assert not env.file(kind, shoot_a, asset["id"]).exists()
    after = json.loads(env.file(kind, "_global", asset["id"]).read_text())
    # A move isn't an edit: only projectId changed; version and updatedAt stay.
    assert {**after, "projectId": shoot_a} == before
    assert after["version"] == before["version"] and after["updatedAt"] == before["updatedAt"]
    assert env.listed(kind, shoot_a) == [] and env.listed(kind) == [asset["id"]]
    # A move says where the asset lives now, so a Studio draft kept for it follows.
    assert env.broadcasts == [{"type": "storedAssetChanged", "kind": kind, "id": asset["id"], "deleted": False,
                               "projectId": None}]

    back = _move(env, kind, asset["id"], shoot_a)
    assert back.status_code == 200 and back.json()["status"] == "moved"
    assert env.broadcasts[-1]["projectId"] == shoot_a
    assert json.loads(env.file(kind, shoot_a, asset["id"]).read_text()) == before
    assert env.listed(kind, shoot_a) == [asset["id"]] and env.listed(kind) == []


@pytest.mark.parametrize("kind", ["moodboard", "character"])
def test_project_to_project_and_global_to_project(env, kind):
    shoot_a = env.make("Shoot A")
    shoot_b = env.make("Shoot B", active=True)
    in_a = env.create(kind, shoot_a, name="From A")
    everywhere = env.create(kind, None, name="House")

    to_b = _move(env, kind, in_a["id"], shoot_b).json()
    assert (to_b["from"], to_b["to"], to_b["toName"]) == (shoot_a, shoot_b, "Shoot B")
    from_global = _move(env, kind, everywhere["id"], shoot_b).json()
    assert (from_global["from"], from_global["to"]) == (None, shoot_b)

    assert sorted(env.listed(kind, shoot_b)) == sorted([in_a["id"], everywhere["id"]])
    assert env.listed(kind, shoot_a) == [] and env.listed(kind) == []
    assert env.client.get(f"{KINDS[kind][0]}/{in_a['id']}").json()["projectId"] == shoot_b


@pytest.mark.parametrize("kind", ["moodboard", "character"])
def test_already_there_is_a_200_that_changes_nothing(env, kind):
    shoot_a = env.make("Shoot A", active=True)
    asset = env.create(kind, shoot_a)
    path = env.file(kind, shoot_a, asset["id"])
    stat = path.stat()
    env.broadcasts.clear()

    same = _move(env, kind, asset["id"], shoot_a)

    assert same.status_code == 200
    body = same.json()
    assert body["status"] == "unchanged" and body["detail"].endswith("is already in Shoot A. Nothing changed.")
    assert "movedBy" not in body
    assert path.stat().st_mtime_ns == stat.st_mtime_ns and env.broadcasts == []
    global_asset = env.create(kind, None, name="G")
    env.broadcasts.clear()
    assert _move(env, kind, global_asset["id"], None).json()["detail"].endswith("is already Global. Nothing changed.")
    assert env.broadcasts == []


@pytest.mark.parametrize("kind", ["moodboard", "character"])
def test_refusals(env, kind):
    shoot_a = env.make("Shoot A", active=True)
    gone = env.make("Gone", trashed=True)
    asset = env.create(kind, shoot_a)
    stored = env.file(kind, shoot_a, asset["id"]).read_bytes()
    env.broadcasts.clear()

    unknown_target = _move(env, kind, asset["id"], "nebula_nodes")
    assert unknown_target.status_code == 422
    assert unknown_target.json()["detail"].startswith("No project has the id 'nebula_nodes'. Use the id of a project")
    trashed_target = _move(env, kind, asset["id"], gone)
    assert trashed_target.status_code == 422
    assert trashed_target.json()["detail"].startswith("The project “Gone” is in Recently deleted. Restore it first")
    for bad in ("../evil", ""):
        assert _move(env, kind, asset["id"], bad).status_code == 400
    # projectId is required: forgetting it never moves the asset to Global.
    assert env.client.post(f"{KINDS[kind][0]}/{asset['id']}/move", json={}).status_code == 422
    assert env.client.post(f"{KINDS[kind][0]}/{asset['id']}/move",
                           json={"projectId": None, "extra": 1}).status_code == 422
    assert _move(env, kind, "nope123", None).status_code == 404
    assert _move(env, kind, "../x", None).status_code in (404, 405)

    assert env.file(kind, shoot_a, asset["id"]).read_bytes() == stored and env.broadcasts == []

    assert env.client.delete(f"{KINDS[kind][0]}/{asset['id']}").status_code == 200
    env.broadcasts.clear()
    trashed = _move(env, kind, asset["id"], None)
    assert trashed.status_code == 409
    assert trashed.json()["code"] == "in_trash"
    assert "is in Recently deleted. Restore it first" in trashed.json()["detail"]
    assert env.broadcasts == []


@pytest.mark.parametrize("kind", ["moodboard", "character"])
def test_an_id_already_in_the_target_is_refused_and_nothing_changes(env, kind):
    shoot_a = env.make("Shoot A", active=True)
    asset = env.create(kind, shoot_a)
    source = env.file(kind, shoot_a, asset["id"])
    clash = env.file(kind, "_global", asset["id"])
    clash.parent.mkdir(parents=True, exist_ok=True)
    clash.write_text(json.dumps({**json.loads(source.read_text()), "name": "Someone else", "projectId": None}))
    stored = source.read_bytes(), clash.read_bytes()

    for target in (None, shoot_a):
        refused = _move(env, kind, asset["id"], target)
        assert refused.status_code == 409, refused.text
        assert "a copy with this id in each of" in refused.json()["detail"]
        assert "Nothing was changed" in refused.json()["detail"]
        assert (source.read_bytes(), clash.read_bytes()) == stored


def test_who_moved_it_is_in_the_answer(env):
    shoot_a = env.make("Shoot A", active=True)
    board = env.create("moodboard", shoot_a)

    by_agent = _move(env, "moodboard", board["id"], None, headers={"X-Nebula-Agent": "Claude"}).json()
    assert by_agent["movedBy"] == {"kind": "agent", "name": "Claude"}
    anonymous = _move(env, "moodboard", board["id"], shoot_a).json()
    assert anonymous["movedBy"]["kind"] == "anonymous"


def test_the_studio_saves_after_a_move_with_the_new_projectId(env):
    """The Studio sends the whole draft, projectId included, on every save. A
    board refuses a projectId change on PUT, so after a move the Studio's
    draft carries the new one (MoodboardStudioView), and that save lands."""
    shoot_a = env.make("Shoot A", active=True)
    board = env.create("moodboard", shoot_a)
    _move(env, "moodboard", board["id"], None)

    stale = env.client.put(f"/api/moodboards/{board['id']}", json={"name": "Edited", "projectId": shoot_a})
    assert stale.status_code == 422
    saved = env.client.put(f"/api/moodboards/{board['id']}", json={"name": "Edited"})
    assert saved.status_code == 200 and saved.json()["projectId"] is None
    assert saved.json()["version"] == board["version"] + 1


@pytest.mark.asyncio
async def test_a_node_in_any_project_still_resolves_a_moved_asset(env):
    from handlers.character_node import handle_character_node
    from handlers.moodboard import handle_moodboard_node
    from models.graph import GraphNode
    from tests.test_asset_reference_params import _image_url

    shoot_a = env.make("Shoot A", active=True)
    image = _image_url("moved-board.png")
    board = env.client.post("/api/moodboards", json={"name": "A", "images": [{"url": image}],
                                                      "projectId": shoot_a}).json()
    hero = env.create("character", None)
    shoot_b = env.make("Shoot B", active=True)  # the nodes now sit on Shoot B's canvas

    _move(env, "moodboard", board["id"], None)
    _move(env, "character", hero["id"], shoot_a)

    for _ in range(2):
        ran = await handle_moodboard_node(GraphNode(id="n1", definitionId="nebula-moodboard",
                                                    params={"moodboard": board["id"]}), {}, {})
        assert ran["moodboard"]["value"]["moodboardId"] == board["id"]
        assert ran["representative_images"]["value"] == [image]
        played = await handle_character_node(GraphNode(id="n2", definitionId="character",
                                                       params={"character": hero["id"]}), {}, {})
        assert played["character"]["value"]["characterId"] == hero["id"]
        _move(env, "moodboard", board["id"], shoot_b)
        _move(env, "character", hero["id"], shoot_b)


# -- CLI ------------------------------------------------------------------------

def _cli(env, argv, capsys):
    args = build_parser().parse_args(argv)
    module = moodboard_cmd if argv[0] == "moodboard" else character_cmd
    module.run(env.cli_client(), args)
    return capsys.readouterr().out


def _cli_error(env, argv, capsys) -> str:
    with pytest.raises(SystemExit):
        _cli(env, argv, capsys)
    return capsys.readouterr().err


def test_cli_moodboard_move_to_current_global_and_by_name(env, capsys):
    shoot_a = env.make("Shoot A", active=True)
    board = env.create("moodboard", None, name="House style")

    out = _cli(env, ["moodboard", "move", "house style", "--to", "current"], capsys)
    assert out.splitlines() == [
        f"Moved House style ({board['id']}) from Global to Shoot A. It's in Shoot A's Project tab now.",
        "Nodes that use it keep working in every project.",
        f"Move it back: nebula moodboard move {board['id']} --to global",
    ]
    assert env.listed("moodboard", shoot_a) == [board["id"]]

    out = _cli(env, ["moodboard", "move", board["id"], "--to", "global"], capsys)
    assert out.splitlines()[0] == (f"Moved House style ({board['id']}) from Shoot A to Global. "
                                   "Every project's Global tab lists it now.")
    assert out.splitlines()[-1] == f"Move it back: nebula moodboard move {board['id']} --to {shoot_a}"

    out = _cli(env, ["moodboard", "move", board["id"], "--to", "shoot a"], capsys)  # a project's exact name
    assert "from Global to Shoot A" in out
    out = _cli(env, ["moodboard", "move", board["id"], "--to", shoot_a], capsys)
    assert out.strip() == f"House style ({board['id']}) is already in Shoot A. Nothing changed."


def test_cli_moodboard_move_json(env, capsys):
    shoot_a = env.make("Shoot A", active=True)
    board = env.create("moodboard", shoot_a)

    data = json.loads(_cli(env, ["moodboard", "move", board["id"], "--to", "global", "--json"], capsys))

    assert (data["status"], data["from"], data["to"], data["fromName"], data["toName"]) == (
        "moved", shoot_a, None, "Shoot A", "Global")
    assert data["asset"]["id"] == board["id"] and data["asset"]["projectId"] is None
    assert "brief" in data["asset"]  # the board as `show --json` gives it


def test_cli_move_refusals_say_what_to_do(env, capsys):
    env.make("Twin")
    env.make("Twin")
    gone = env.make("Old shoot", trashed=True)
    board = env.create("moodboard", None)

    assert "no project is open on the canvas" in _cli_error(env, ["moodboard", "move", board["id"], "--to", "current"], capsys)
    assert "2 projects are named 'Twin'" in _cli_error(env, ["moodboard", "move", board["id"], "--to", "twin"], capsys)
    assert "no project 'Nowhere'" in _cli_error(env, ["moodboard", "move", board["id"], "--to", "Nowhere"], capsys)
    err = _cli_error(env, ["moodboard", "move", board["id"], "--to", "Old shoot"], capsys)
    assert "is in Recently deleted. Restore it first" in err and gone in err
    assert "no board 'Missing'" in _cli_error(env, ["moodboard", "move", "Missing", "--to", "global"], capsys)

    env.client.delete(f"/api/moodboards/{board['id']}")
    err = _cli_error(env, ["moodboard", "move", board["id"], "--to", "global"], capsys)
    assert "is in Recently deleted" in err and "Then move it." in err
    with pytest.raises(SystemExit):
        build_parser().parse_args(["moodboard", "move", board["id"]])  # --to is required


def test_cli_character_move(env, capsys):
    env.make("Shoot A")
    shoot_b = env.make("Shoot B", active=True)
    hero = env.create("character", None, name="Nari")

    out = _cli(env, ["character", "move", "nari", "--to", "Shoot B"], capsys)
    assert out.splitlines()[0] == f"Moved Nari ({hero['id']}) from Global to Shoot B. It's in Shoot B's Project tab now."
    assert out.splitlines()[-1] == f"Move it back: nebula character move {hero['id']} --to global"
    assert env.listed("character", shoot_b) == [hero["id"]]

    data = json.loads(_cli(env, ["character", "move", hero["id"], "--to", "global", "--json"], capsys))
    assert (data["status"], data["from"], data["to"]) == ("moved", shoot_b, None)
    assert data["asset"]["projectId"] is None
    assert "no Character 'Nobody'" in _cli_error(env, ["character", "move", "Nobody", "--to", "global"], capsys)


def test_cli_on_a_nebula_without_move_says_so(env, capsys, monkeypatch):
    import moodboard_client as boards
    from nebula_api import NebulaAPIError

    board = env.create("moodboard", None)
    real = NebulaAPI.request

    def old_backend(self, method, path, **kwargs):
        if path.endswith("/move"):
            raise NebulaAPIError("Not Found", status=404)
        return real(self, method, path, **kwargs)

    monkeypatch.setattr(NebulaAPI, "request", old_backend)
    assert boards.MOVE_UNSUPPORTED.format(noun="board") in _cli_error(
        env, ["moodboard", "move", board["id"], "--to", "global"], capsys)


# -- MCP ------------------------------------------------------------------------

def test_mcp_moodboard_move_and_character_move(env):
    shoot_a = env.make("Shoot A", active=True)
    board = env.create("moodboard", shoot_a)
    hero = env.create("character", None)

    moved = mcp_server.moodboard_move(board["id"], "global")
    assert (moved["status"], moved["from"], moved["to"]) == ("moved", shoot_a, None)
    assert moved["asset"]["projectId"] is None and "brief" in moved["asset"]
    assert moved["movedBy"]["kind"] == "agent"  # the MCP names itself (X-Nebula-Agent)
    assert mcp_server.character_move("Rina", "current")["to"] == shoot_a
    assert env.listed("character", shoot_a) == [hero["id"]]

    env.close_all()
    with pytest.raises(RuntimeError, match="no project is open on the canvas"):
        mcp_server.moodboard_move(board["id"], "current")

    tools = {tool.name: tool for tool in asyncio.run(mcp_server.mcp.list_tools())}
    for name in ("moodboard_move", "character_move"):
        annotations = tools[name].annotations
        assert annotations.readOnlyHint is False and annotations.destructiveHint is False
        assert annotations.idempotentHint is True and annotations.openWorldHint is False
    # The instructions send agents to moodboard_get, whose description names them (plan v2.7, PR26).
    assert "moodboard_get" in mcp_server.INSTRUCTIONS
    assert "moodboard_move" in tools["moodboard_get"].description and "character_move" in tools["moodboard_get"].description


def test_in_app_claude_may_call_the_move_tools():
    from services.agent_profiles import CLAUDE_ALLOW_RULES

    assert "mcp__nebula__moodboard_move" in CLAUDE_ALLOW_RULES
    assert "mcp__nebula__character_move" in CLAUDE_ALLOW_RULES
