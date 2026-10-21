"""An agent's moodboard writes reach the canvas's Agent log.

The log is fed by the same `agentPresence` events that move an agent's cursor
(frontend store/agentLogStore.ts). Graph edits always sent one; a board write
over MCP or the CLI (Set aside, Analyze, ...) sent none, so the person never
saw it. A board has no place on the canvas, so these events carry no
`target`: the log lists them and no cursor moves.
"""
from __future__ import annotations

from uuid import uuid4

import pytest
from fastapi.testclient import TestClient
from PIL import Image

from services.agent_presence import AgentPresence, identify
from services.moodboard_actions import describe_change
from services.moodboard_edits import diff
from services.output import OUTPUT_ROOT

AGENT = {"X-Nebula-Agent": "Claude Code"}


@pytest.fixture
def api(tmp_path, monkeypatch, canvas_project):
    import main as main_module

    monkeypatch.setenv("NEBULA_MOODBOARD_ROOT", str(tmp_path / "moodboards"))
    presence = AgentPresence()
    sent: list[dict] = []

    async def capture(data):
        sent.append(data)

    async def ignore(data):
        return None

    monkeypatch.setattr(main_module, "agent_presence", presence)
    monkeypatch.setattr(main_module.manager, "broadcast_raw", capture)
    monkeypatch.setattr(main_module.manager, "broadcast_browser", ignore)
    return TestClient(main_module.app), sent, presence, canvas_project


def _url(color=(200, 80, 40)) -> str:
    path = OUTPUT_ROOT / "moodboard-agent-action-tests" / f"{uuid4().hex[:10]}.png"
    path.parent.mkdir(parents=True, exist_ok=True)
    Image.new("RGB", (32, 24), color).save(path)
    return f"/api/outputs/{path.resolve().relative_to(OUTPUT_ROOT.resolve()).as_posix()}"


def _said(sent: list[dict]) -> list[str]:
    return [event["say"] for event in sent if event.get("type") == "agentPresence"]


def _create(client, headers=None, **body) -> dict:
    response = client.post("/api/moodboards", headers=headers or {},
                           json={"name": "Dusk dunes", "images": [{"url": _url()}, {"url": _url((20, 40, 200))}],
                                 **body})
    assert response.status_code == 200, response.text
    return response.json()


def test_an_agents_set_aside_and_analyze_are_named_in_the_log(api):
    client, sent, presence, _ = api
    board = _create(client, AGENT)
    first, second = board["images"]

    # The list is the board's images (moodboard_client sends every one).
    aside = client.put(f"/api/moodboards/{board['id']}", headers=AGENT, json={"images": [
        {"id": first["id"], "url": first["url"], "excluded": True},
        {"id": second["id"], "url": second["url"]},
    ]})
    assert aside.status_code == 200, aside.text
    assert client.post(f"/api/moodboards/{board['id']}/analyze", headers=AGENT).status_code == 200

    assert _said(sent) == ["Made board Dusk dunes with 2 images", "Set aside #1 on board Dusk dunes",
                           "Analyzed board Dusk dunes"]
    events = [event for event in sent if event.get("type") == "agentPresence"]
    # Who, in the cursor's own name and colour, and when.
    assert {event["agent"]["name"] for event in events} == {"Claude Code"}
    assert events[0]["agent"] == identify(AGENT).as_dict()
    assert all(isinstance(event["at"], int) for event in events)
    # No place on the canvas: no target, and no cursor is drawn or listed.
    assert all("target" not in event for event in events)
    assert presence.active() == []


def test_the_persons_own_board_writes_send_nothing(api):
    client, sent, _, _ = api
    board = _create(client)
    first = board["images"][0]
    client.put(f"/api/moodboards/{board['id']}",
               json={"images": [{"id": first["id"], "url": first["url"], "excluded": True}]})
    client.post(f"/api/moodboards/{board['id']}/analyze")
    client.delete(f"/api/moodboards/{board['id']}")
    assert _said(sent) == []


def test_a_dry_run_writes_nothing_so_it_logs_nothing(api):
    client, sent, _, _ = api
    board = _create(client)
    assert client.post(f"/api/moodboards/{board['id']}/analyze/dry-run", headers=AGENT).status_code == 200
    assert _said(sent) == []


def test_move_and_delete_by_an_agent_are_logged(api):
    client, sent, _, project_id = api
    board = _create(client, projectId=project_id)
    moved = client.post(f"/api/moodboards/{board['id']}/move", headers=AGENT, json={"projectId": None})
    assert moved.status_code == 200, moved.text
    assert client.delete(f"/api/moodboards/{board['id']}", headers=AGENT).status_code == 200
    assert _said(sent) == ["Moved board Dusk dunes to Global", "Deleted board Dusk dunes"]


def test_an_agents_restore_from_recently_deleted_is_logged(api):
    # MCP restore_from_trash and `nebula trash restore` bring a board back.
    client, sent, _, _ = api
    board = _create(client)
    assert client.delete(f"/api/moodboards/{board['id']}").status_code == 200
    restored = client.post(f"/api/trash/moodboard/{board['id']}/restore", headers=AGENT)
    assert restored.status_code == 200, restored.text
    assert _said(sent) == ["Restored board Dusk dunes"]


def test_a_refused_write_logs_nothing(api):
    client, sent, _, _ = api
    board = _create(client)
    # Turning notes on for generators is the person's call.
    refused = client.put(f"/api/moodboards/{board['id']}", headers=AGENT, json={"sendNotes": True})
    assert refused.status_code == 403
    assert _said(sent) == []


# -- the words ---------------------------------------------------------------
# One set of words for a board change: the journal's (moodboard_edits.journal_entry),
# with the board fields it leaves out named by moodboard_edits.FIELD_LABELS.

def _board(**fields) -> dict:
    images = [{"id": "a", "url": "/a.png", "weight": 1.0, "notes": "", "privateNote": "", "excluded": False},
              {"id": "b", "url": "/b.png", "weight": 1.0, "notes": "", "privateNote": "", "excluded": True}]
    return {"id": "mb1", "name": "Dusk", "images": images, "notes": "", "direction": "", "avoid": [], **fields}


def _describe(before: dict, after: dict) -> str:
    return describe_change(diff(before, after), before, after)


def test_describe_change_is_the_journal_summary_with_the_fields_it_leaves_out():
    before = _board()
    aside = _board()
    aside["images"] = [{**before["images"][0], "excluded": True}, before["images"][1]]
    assert _describe(before, aside) == "Set aside #1 on board Dusk"
    added = _board()
    added["images"] = [*before["images"], {"id": "c", "url": "/c.png", "weight": 1.0}]
    assert _describe(before, added) == "Added #3 to board Dusk"
    assert _describe(before, _board(images=before["images"][:1])) == "Removed #2 from board Dusk"
    assert _describe(before, _board(direction="warm dusk", avoid=["neon"])) == (
        "Changed Direction and the Avoid list on board Dusk")
    assert _describe(before, _board(name="Dawn")) == "Changed the name on board Dawn"
    both = _board(direction="warm dusk")
    both["images"] = aside["images"]
    assert _describe(before, both) == "Set aside #1 on board Dusk; changed Direction"
    # The board's notes are a field, named as the board.fields event names them (Q91).
    assert _describe(before, _board(notes="calm")) == "Changed the board's notes on board Dusk"
    # ...and named after the journal's summary when it is about something else.
    added_and_noted = _board(notes="calm")
    added_and_noted["images"] = added["images"]
    assert _describe(before, added_and_noted) == "Added #3 to board Dusk; changed the board's notes"
    noted_image = _board(notes="calm")
    noted_image["images"] = [{**before["images"][0], "notes": "warm"}, before["images"][1]]
    assert _describe(before, noted_image) == "Changed the notes on #1 on board Dusk; changed the board's notes"


def test_every_line_names_the_board_as_the_journal_does():
    # One set of words: the journal's summary and the Agent log's other lines
    # both name a board through moodboard_edits.board_where.
    from services.moodboard_actions import describe_create, describe_write
    from services.moodboard_edits import board_where, journal_entry

    long_name = "Dusk " + "dunes " * 20
    before = _board(name=long_name)
    after = _board(name=long_name)
    after["images"] = [{**before["images"][0], "excluded": True}, before["images"][1]]
    where = board_where(after)
    assert where.startswith("board Dusk dunes") and where.endswith("…") and len(where) <= len("board ") + 60
    assert journal_entry(diff(before, after), before, after)["summary"] == f"set aside #1 on {where}"
    assert describe_write("analyzed", after) == f"Analyzed {where}"
    assert describe_write("moved", after, "to Global") == f"Moved {where} to Global"
    assert describe_create(after) == f"Made {where} with 2 images"
    assert board_where({"id": "mb1"}) == "board mb1"
    assert board_where({"id": "mb1", "name": ""}, {"name": "Old"}) == "board Old"


def test_describe_change_never_quotes_what_the_person_wrote_privately():
    before = _board()
    after = _board()
    after["images"] = [{**before["images"][0], "privateNote": "my secret label"}, before["images"][1]]
    said = _describe(before, after)
    assert said == "Private note changed on #1 on board Dusk"
    assert "secret" not in said


def test_an_old_boards_unsaved_defaults_are_not_named_as_the_agents_change(api, tmp_path):
    # Images saved before weights and notes were written read without them;
    # the PUT saves their defaults. Only the agent's own change is named.
    import json

    client, sent, _, _ = api
    board = _create(client)
    path = next((tmp_path / "moodboards").rglob(f"{board['id']}.json"))
    saved = json.loads(path.read_text(encoding="utf-8"))
    for image in saved["images"]:
        for key in ("weight", "notes", "privateNote", "excluded"):
            image.pop(key, None)
    path.write_text(json.dumps(saved), encoding="utf-8")
    first, second = board["images"]
    aside = client.put(f"/api/moodboards/{board['id']}", headers=AGENT, json={"images": [
        {"id": first["id"], "url": first["url"], "excluded": True},
        {"id": second["id"], "url": second["url"]},
    ]})
    assert aside.status_code == 200, aside.text
    assert _said(sent) == ["Set aside #1 on board Dusk dunes"]


# -- checked board edits (POST /edits): moodboard_add, `nebula moodboard add`, undo ----

def _edit(client, board_id, ops, headers=None, **body):
    response = client.post(f"/api/moodboards/{board_id}/edits", headers=headers or {}, json={"ops": ops, **body})
    assert response.status_code == 200, response.text
    return response.json()


def test_an_agents_edit_batch_logs_one_line_in_its_own_words(api):
    client, sent, presence, _ = api
    board = _create(client)
    first, second = board["images"]
    _edit(client, board["id"], [{"op": "setAside", "image": first["id"], "value": True},
                                {"op": "weight", "image": second["id"], "value": 0.5}],
          AGENT, say="Set aside the red one, eased the blue")
    events = [event for event in sent if event.get("type") == "agentPresence"]
    assert [event["say"] for event in events] == ["Set aside the red one, eased the blue"]
    assert "target" not in events[0] and events[0]["agent"] == identify(AGENT).as_dict()
    assert presence.active() == []


def test_an_agents_edit_batch_without_say_logs_the_journal_summary(api):
    client, sent, _, _ = api
    board = _create(client)
    added = _edit(client, board["id"], [{"op": "add", "images": [{"url": _url((90, 200, 90))}]}], AGENT)
    # Its undo is a batch like any other (undo_board, `set --restore`).
    _edit(client, board["id"], added["undo"]["ops"], AGENT)
    assert _said(sent) == ["Added #3 to board Dusk dunes", "Undo: Removed #3 from board Dusk dunes"]


def test_the_persons_edit_batch_and_a_batch_that_changes_nothing_send_nothing(api):
    client, sent, _, _ = api
    board = _create(client)
    first = board["images"][0]
    _edit(client, board["id"], [{"op": "setAside", "image": first["id"], "value": True}], say="mine")
    # The agent sets aside what is already set aside: unchanged, nothing written.
    _edit(client, board["id"], [{"op": "setAside", "image": first["id"], "value": True}], AGENT)
    assert _said(sent) == []


def test_an_agents_put_takes_before_from_the_write_itself(api, monkeypatch):
    # The line compares the board the store changed (update_with_before) with
    # the result: no second read of the board, which another write could
    # change between the read and the save.
    from services.moodboard_store import MoodboardStore

    client, sent, _, _ = api
    board = _create(client)
    calls: list[str] = []
    real_get = MoodboardStore.get

    def counted_get(self, *args, **kwargs):
        calls.append("get")
        return real_get(self, *args, **kwargs)

    monkeypatch.setattr(MoodboardStore, "get", counted_get)
    response = client.put(f"/api/moodboards/{board['id']}", headers=AGENT,
                          json={"direction": "warm dusk", "baseVersion": board["version"]})
    assert response.status_code == 200, response.text
    assert calls == []
    assert _said(sent) == ["Changed Direction on board Dusk dunes"]
