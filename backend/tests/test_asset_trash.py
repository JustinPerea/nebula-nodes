"""Deleted moodboards, characters and projects go to Recently deleted.

Design-canvas answer D5 lets agents delete moodboards, on Justin's terms: "As
long as we have undo an agent can do anything." A delete used to unlink the
file, so nothing could undo it. Now a delete moves the asset to a trash
(services/asset_trash.py) with who deleted it and when; anyone may restore it
with the same id and contents; deleting for good is the person's alone.
"""
from __future__ import annotations

import io
import json
import unicodedata
from contextlib import redirect_stdout

import pytest

from handlers.character_node import handle_character_node
from handlers.moodboard import handle_moodboard_node
from models.graph import GraphNode
from services import asset_trash
from services.canvas_events import actor_record
from services.character_store import CharacterStore
from services.moodboard_store import MoodboardStore
from tests.conftest import FORGED_ORIGIN, PERSON
from tests.test_asset_reference_params import AGENT, CHARACTER, MCP, _board, _changed, api  # noqa: F401



# -- the store ------------------------------------------------------------------

def test_delete_moves_the_file_untouched_and_restore_puts_it_back(tmp_path, monkeypatch):
    monkeypatch.setenv("NEBULA_MOODBOARD_ROOT", str(tmp_path))
    store = MoodboardStore()
    board = store.create(name="Warm", images=[{"url": "/api/outputs/a.png"}], projectId="proj1")
    live = tmp_path / "proj1" / f"{board['id']}.json"
    original = live.read_bytes()

    record = store.delete(board["id"], deleted_by=actor_record({"kind": "agent", "name": "GM - Design", "id": "x"}))

    assert not live.exists()
    assert (tmp_path / ".trash" / f"{board['id']}.json").read_bytes() == original
    assert record["deletedBy"] == {"kind": "agent", "name": "GM - Design"}
    assert record["projectId"] == "proj1" and record["scopeDir"] == "proj1" and record["name"] == "Warm"
    # Gone from every live lookup, but the trash knows it.
    assert store.get(board["id"]) is None
    assert store.list(scope="project", projectId="proj1") == []
    assert store.trashed(board["id"])["id"] == board["id"]
    assert [item["id"] for item in store.list_trash(scope="project", projectId="proj1")] == [board["id"]]
    assert store.list_trash(scope="global") == []

    restored = store.restore(board["id"])

    assert restored == board
    assert live.read_bytes() == original
    assert store.trashed(board["id"]) is None
    assert not (tmp_path / ".trash" / f"{board['id']}{asset_trash.RECORD_SUFFIX}").exists()


def test_purge_removes_it_for_good(tmp_path, monkeypatch):
    monkeypatch.setenv("NEBULA_CHARACTER_ROOT", str(tmp_path))
    store = CharacterStore()
    character = store.create(**{k: v for k, v in CHARACTER.items()})
    store.delete(character["id"])
    store.purge(character["id"])
    assert store.trashed(character["id"]) is None and store.get(character["id"]) is None
    assert list((tmp_path / ".trash").iterdir()) == []
    with pytest.raises(KeyError):
        store.restore(character["id"])
    with pytest.raises(KeyError):
        store.purge(character["id"])


def test_a_record_without_its_file_is_ignored(tmp_path, monkeypatch):
    """A crash between writing the record and moving the file leaves the board live."""
    monkeypatch.setenv("NEBULA_MOODBOARD_ROOT", str(tmp_path))
    store = MoodboardStore()
    board = store.create(name="Half", images=[{"url": "/api/outputs/a.png"}])
    (tmp_path / ".trash").mkdir()
    (tmp_path / ".trash" / f"{board['id']}{asset_trash.RECORD_SUFFIX}").write_text(json.dumps({"id": board["id"]}))
    assert store.trashed(board["id"]) is None
    assert store.list_trash() == []
    assert store.get(board["id"]) == board


def test_restore_refuses_when_the_id_is_live_again(tmp_path, monkeypatch):
    monkeypatch.setenv("NEBULA_MOODBOARD_ROOT", str(tmp_path))
    store = MoodboardStore()
    board = store.create(name="Twice", images=[{"url": "/api/outputs/a.png"}])
    store.delete(board["id"])
    (tmp_path / "_global" / f"{board['id']}.json").write_text(json.dumps(board))
    with pytest.raises(asset_trash.AlreadyLive):
        store.restore(board["id"])
    assert store.trashed(board["id"]) is not None


# -- the API ----------------------------------------------------------------------

@pytest.mark.asyncio
async def test_an_agent_deletes_a_board_and_restores_it_and_the_node_runs_again(api):
    board = _board(api, "Agent board")
    node = GraphNode(id="n1", definitionId="nebula-moodboard", params={"moodboard": board["id"]})

    deleted = api.client.delete(f"/api/moodboards/{board['id']}", headers=AGENT)
    assert deleted.status_code == 200, deleted.text
    assert deleted.json()["status"] == "trashed"
    assert deleted.json()["trashed"]["deletedBy"] == {"kind": "agent", "name": "GM - Design"}

    gone = api.client.get(f"/api/moodboards/{board['id']}")
    assert gone.status_code == 404
    assert gone.json()["code"] == "in_trash"
    assert gone.json()["trashed"]["name"] == "Agent board"
    with pytest.raises(ValueError, match="is in Recently deleted"):
        await handle_moodboard_node(node, {}, {})

    listed = api.client.get("/api/trash", params={"kind": "moodboard"}, headers=AGENT).json()["items"]
    assert [(item["kind"], item["id"]) for item in listed] == [("moodboard", board["id"])]

    restored = api.client.post(f"/api/trash/moodboard/{board['id']}/restore", headers=AGENT)
    assert restored.status_code == 200, restored.text
    assert restored.json()["asset"] == board
    assert api.client.get(f"/api/moodboards/{board['id']}").json() == board
    result = await handle_moodboard_node(node, {}, {})
    assert result["moodboard"]["value"]["moodboardId"] == board["id"]
    # Cards hear about the delete and the restore.
    assert [m["deleted"] for m in _changed(api) if m["id"] == board["id"]][-2:] == [True, False]


@pytest.mark.asyncio
async def test_a_character_goes_to_the_trash_and_comes_back(api):
    character = api.client.post("/api/characters", json=CHARACTER).json()
    node = GraphNode(id="n1", definitionId="character", params={"character": character["id"]})
    assert api.client.delete(f"/api/characters/{character['id']}", headers=PERSON).status_code == 200
    record = api.client.get(f"/api/characters/{character['id']}").json()
    assert record["code"] == "in_trash" and record["trashed"]["deletedBy"] == {"kind": "person", "name": "You"}
    with pytest.raises(ValueError, match="is in Recently deleted"):
        await handle_character_node(node, {}, {})
    assert api.client.post(f"/api/trash/character/{character['id']}/restore", headers=MCP).status_code == 200
    assert api.client.get(f"/api/characters/{character['id']}").json() == character
    result = await handle_character_node(node, {}, {})
    assert result["character"]["value"]["characterId"] == character["id"]


def test_an_agent_pointing_a_node_at_a_trashed_board_is_told_to_restore_it(api):
    board = _board(api)
    api.client.delete(f"/api/moodboards/{board['id']}")
    node_id = api.graph.add_node("nebula-moodboard", {})
    response = api.client.put(f"/api/graph/node/{node_id}", headers=AGENT, json={"params": {"moodboard": board["id"]}})
    assert response.status_code == 400
    assert "is in Recently deleted; restore it first" in response.json()["detail"]
    assert f"nebula trash restore moodboard {board['id']}" in response.json()["detail"]


def test_saving_a_board_or_character_someone_trashed_says_it_is_in_recently_deleted(api):
    """The person has a board open in Studio and an agent deletes it. Their
    next save must say where it went (so they can restore and save again),
    not a bare "not found", and must not bring it back on its own."""
    board = _board(api, "Open in Studio")
    api.client.delete(f"/api/moodboards/{board['id']}", headers=AGENT)
    saved = api.client.put(f"/api/moodboards/{board['id']}", headers=PERSON, json={"name": "Edited"})
    assert saved.status_code == 404
    assert saved.json()["code"] == "in_trash"
    assert saved.json()["trashed"]["deletedBy"]["name"] == "GM - Design"
    assert MoodboardStore().get(board["id"]) is None
    api.client.post(f"/api/trash/moodboard/{board['id']}/restore", headers=PERSON)
    again = api.client.put(f"/api/moodboards/{board['id']}", headers=PERSON, json={"name": "Edited"})
    assert again.status_code == 200 and again.json()["name"] == "Edited"

    character = api.client.post("/api/characters", json=CHARACTER).json()
    api.client.delete(f"/api/characters/{character['id']}", headers=AGENT)
    saved = api.client.put(f"/api/characters/{character['id']}", headers=PERSON, json={"name": "Edited"})
    assert saved.status_code == 404 and saved.json()["code"] == "in_trash"
    missing = api.client.put("/api/characters/nope", headers=PERSON, json={"name": "Edited"})
    assert missing.status_code == 404 and "code" not in missing.json()


def test_restoring_twice_is_harmless(api):
    """Two tabs (or an agent and the person's Undo) restore the same board."""
    board = _board(api, "Twice")
    api.client.delete(f"/api/moodboards/{board['id']}")
    first = api.client.post(f"/api/trash/moodboard/{board['id']}/restore", headers=PERSON)
    second = api.client.post(f"/api/trash/moodboard/{board['id']}/restore", headers=AGENT)
    assert first.status_code == 200 and second.status_code == 200, second.text
    assert second.json()["alreadyRestored"] is True and second.json()["asset"] == board
    never = api.client.post("/api/trash/moodboard/neverexisted/restore", headers=AGENT)
    assert never.status_code == 404


# FORGED_ORIGIN: an Origin proves nothing; leaving the agent header off isn't the person either.
@pytest.mark.parametrize("headers", [AGENT, MCP, {}, FORGED_ORIGIN])
def test_only_the_person_deletes_for_good(api, headers):
    board = _board(api)
    api.client.delete(f"/api/moodboards/{board['id']}", headers=AGENT)
    for method, path in (("DELETE", f"/api/trash/moodboard/{board['id']}"), ("POST", "/api/trash/empty")):
        refused = api.client.request(method, path, headers=headers)
        assert refused.status_code == 403, refused.text
        assert "You can restore it instead" in refused.json()["detail"]
        assert "nebula trash restore" in refused.json()["detail"]
    assert MoodboardStore().trashed(board["id"]) is not None


def test_the_person_deletes_one_for_good_or_empties_a_scope(api):
    keep, purge, other = _board(api, "Keep"), _board(api, "Purge"), _board(api, "Other")
    project_board = api.client.post("/api/moodboards", json={
        "name": "In project", "images": [{"url": "/api/outputs/x.png"}], "projectId": api.project_id}).json()
    for board in (purge, other, project_board):
        api.client.delete(f"/api/moodboards/{board['id']}")

    assert api.client.delete(f"/api/trash/moodboard/{purge['id']}", headers=PERSON).json() == {
        "purged": "moodboard", "id": purge["id"]}
    assert api.client.delete(f"/api/trash/moodboard/{purge['id']}", headers=PERSON).status_code == 404
    # Deleting for good only reaches the trash, never a live board.
    assert api.client.delete(f"/api/trash/moodboard/{keep['id']}", headers=PERSON).status_code == 404

    emptied = api.client.post("/api/trash/empty", params={"kind": "moodboard", "scope": "global"}, headers=PERSON)
    assert emptied.json() == {"purged": 1}
    # The project's board wasn't in that scope.
    left = api.client.get("/api/trash", params={"kind": "moodboard"}).json()["items"]
    assert [item["id"] for item in left] == [project_board["id"]]
    assert api.client.get(f"/api/moodboards/{keep['id']}").status_code == 200
    # Cards that showed them "in Recently deleted" hear they're gone for good.
    gone = [m["id"] for m in _changed(api) if m["deleted"]][-2:]
    assert gone == [purge["id"], other["id"]]


@pytest.mark.parametrize("headers", [
    {**AGENT, **PERSON},
    {**MCP, **PERSON},
    {"Authorization": "Agent not-a-real-token", **PERSON},
])
def test_an_agent_holding_the_person_token_still_cannot_delete_for_good(api, headers):
    """Agent markers win over the person token: something that says it's an
    agent never counts as the person, so it can't purge or empty either."""
    board = _board(api)
    api.client.delete(f"/api/moodboards/{board['id']}", headers=AGENT)
    for method, path in (("DELETE", f"/api/trash/moodboard/{board['id']}"), ("POST", "/api/trash/empty")):
        # An agent token that doesn't check out is refused before the gate (401).
        assert api.client.request(method, path, headers=headers).status_code in (401, 403)
    assert MoodboardStore().trashed(board["id"]) is not None


def test_emptying_deletes_only_what_the_person_saw(api):
    """The person's list loaded, then an agent deleted another board before
    they pressed Empty. Emptying deletes for good only what they were shown;
    the agent's delete stays restorable."""
    seen = _board(api, "Seen")
    api.client.delete(f"/api/moodboards/{seen['id']}", headers=PERSON)
    shown = api.client.get("/api/trash", params={"kind": "moodboard", "scope": "global"}, headers=PERSON).json()["items"]
    late = _board(api, "Deleted after the list loaded")
    api.client.delete(f"/api/moodboards/{late['id']}", headers=AGENT)

    emptied = api.client.post("/api/trash/empty", params={"kind": "moodboard", "scope": "global"}, headers=PERSON,
                              json={"items": [{"kind": item["kind"], "id": item["id"]} for item in shown]})

    assert emptied.status_code == 200, emptied.text
    assert emptied.json() == {"purged": 1}
    assert MoodboardStore().trashed(seen["id"]) is None
    assert MoodboardStore().trashed(late["id"]) is not None
    bad = api.client.post("/api/trash/empty", headers=PERSON, json={"items": [{"kind": "moodboard", "id": "../x"}]})
    assert bad.status_code == 400


def test_emptying_project_trash_deletes_only_the_projects_the_person_saw(api):
    ids = []
    for name in ("Seen", "Deleted later"):
        created = api.client.post("/api/projects", json={"name": name}, headers=PERSON).json()
        ids.append(created["project"]["id"])
    revision = api.client.get("/api/projects").json()["workspaceRevision"]
    api.client.request("DELETE", f"/api/projects/{ids[0]}", headers=PERSON, json={"workspaceRevision": revision})
    revision = api.client.get("/api/projects").json()["workspaceRevision"]
    api.client.request("DELETE", f"/api/projects/{ids[1]}", headers=AGENT, json={"workspaceRevision": revision})

    for path, body in (("/api/projects/trash/empty", {"ids": [ids[0]]}),
                       ("/api/trash/empty", {"items": [{"kind": "project", "id": ids[0]}]})):
        emptied = api.client.post(path, headers=PERSON, json=body)
        assert emptied.status_code == 200, emptied.text
        listed = [item["id"] for item in api.client.get("/api/trash", params={"kind": "project"}).json()["items"]]
        assert listed == [ids[1]], path


LOOKALIKE_YOU = {
    "homoglyph": "Y\u043eu",            # Cyrillic o
    "zero-width": "Y\u200bo\u200du",
    "bidi-override": "\u202euoY\u202c",
    "fullwidth": "\uff39\uff4f\uff55",
    "plain": "You",
}


@pytest.mark.parametrize("name", LOOKALIKE_YOU.values(), ids=LOOKALIKE_YOU.keys())
def test_an_agent_named_like_the_person_is_still_recorded_as_an_agent(name):
    """Only ``kind`` says who did it; an agent named "You" (or something
    that renders as "You") stays an agent, with its name cleaned up."""
    by = actor_record({"kind": "agent", "id": "ext:x", "name": name})
    assert by["kind"] == "agent"
    assert not any(unicodedata.category(ch) in ("Cc", "Cf", "Co", "Cs") for ch in by["name"])
    assert by["name"] in ("You", "Y\u043eu", "uoY")
    assert actor_record({"kind": "person"}) == {"kind": "person", "name": "You"}
    assert actor_record({"kind": "agent", "name": "\u200b\u202e"})["name"] == "Agent"


def test_cli_labels_who_deleted_it_from_kind_not_name():
    from cli.commands.trash import _who

    assert _who({"deletedBy": {"kind": "agent", "name": "You"}}) == "You (agent)"
    assert _who({"deletedBy": {"kind": "person", "name": "You"}}) == "you"
    assert _who({"deletedBy": {"kind": "anonymous", "name": "You"}}) == "an unnamed client"


def test_an_agent_calling_itself_you_is_recorded_as_an_agent(api):
    board = _board(api)
    by = api.client.delete(f"/api/moodboards/{board['id']}", headers={"X-Nebula-Agent": "You"}).json()["trashed"]["deletedBy"]
    assert by == {"kind": "agent", "name": "You"}
    other = _board(api)
    by = api.client.delete(f"/api/moodboards/{other['id']}", headers=PERSON).json()["trashed"]["deletedBy"]
    assert by == {"kind": "person", "name": "You"}


def test_projects_share_the_listing_and_record_who_deleted_them(api):
    created = api.client.post("/api/projects", json={"name": "Old idea"}, headers=PERSON)
    assert created.status_code == 200, created.text
    project_id = created.json()["project"]["id"]
    revision = created.json()["workspaceRevision"]
    deleted = api.client.request("DELETE", f"/api/projects/{project_id}", headers=PERSON,
                                 json={"workspaceRevision": revision})
    assert deleted.status_code == 200, deleted.text
    assert deleted.json()["trashedProject"]["deletedBy"] == {"kind": "person", "name": "You"}
    board = _board(api)
    api.client.delete(f"/api/moodboards/{board['id']}", headers=AGENT)

    items = api.client.get("/api/trash").json()["items"]
    assert [(item["kind"], item["id"]) for item in items] == [("moodboard", board["id"]), ("project", project_id)]
    assert "purgeAt" in items[1]

    restored = api.client.post(f"/api/trash/project/{project_id}/restore", headers=AGENT)
    assert restored.status_code == 200, restored.text
    assert restored.json()["project"]["name"] == "Old idea"
    assert [item["kind"] for item in api.client.get("/api/trash").json()["items"]] == ["moodboard"]


def test_bad_kinds_and_ids_are_refused(api):
    assert api.client.get("/api/trash", params={"kind": "preset"}).status_code == 400
    assert api.client.get("/api/trash", params={"scope": "project"}).status_code == 400
    assert api.client.post("/api/trash/moodboard/..%2Fx/restore").status_code in (400, 404)
    assert api.client.post("/api/trash/moodboard/nothere/restore").status_code == 404


# -- CLI and MCP ------------------------------------------------------------------

def test_cli_lists_and_restores(api, monkeypatch):
    from cli.client import NebulaClient
    from cli.commands import trash

    board = _board(api, "CLI board")
    api.client.delete(f"/api/moodboards/{board['id']}", headers=AGENT)
    client = NebulaClient("http://testserver")
    monkeypatch.setattr(client, "_request", lambda method, path, **kw: api.client.request(
        method, path, headers=AGENT, params=kw.get("params")).json())

    out = io.StringIO()
    with redirect_stdout(out):
        assert trash.run_list(client) == 0
    text = out.getvalue()
    assert f"moodboard {board['id']}  CLI board  [global]" in text and "by GM - Design" in text
    assert f"nebula trash restore moodboard {board['id']}" in text

    out = io.StringIO()
    with redirect_stdout(out):
        assert trash.run_restore(client, [board["id"]]) == 0  # the kind is looked up
    assert "Restored moodboard" in out.getvalue()
    assert api.client.get(f"/api/moodboards/{board['id']}").status_code == 200


def test_cli_parser_has_trash_list_and_restore_only():
    from cli.__main__ import build_parser

    parser = build_parser()
    assert parser.parse_args(["trash", "list", "--kind", "moodboard"]).trash_cmd == "list"
    assert parser.parse_args(["trash", "restore", "moodboard", "abc"]).target == ["moodboard", "abc"]
    with pytest.raises(SystemExit):
        parser.parse_args(["trash", "purge", "abc"])


def test_mcp_tools_list_and_restore(api, monkeypatch):
    import mcp_server

    board = _board(api)
    api.client.delete(f"/api/moodboards/{board['id']}")
    calls = []

    def fake_call(method, path, ctx, **kwargs):
        calls.append((method, path, kwargs))
        return api.client.request(method, path, headers=AGENT, params=kwargs.get("params")).json()

    monkeypatch.setattr(mcp_server, "_canvas_call", fake_call)
    assert mcp_server.list_trash("moodboard")["items"][0]["id"] == board["id"]
    assert mcp_server.restore_from_trash("moodboard", board["id"])["restored"] == "moodboard"
    assert calls[-1][:2] == ("POST", f"/api/trash/moodboard/{board['id']}/restore")
    assert not any(name in dir(mcp_server) for name in ("purge_trash", "empty_trash", "delete_forever"))
