"""Cursor Phase 3 ("Anywhere"), slice 3: what a board write does to the
agent's cursor, row by row (GM - Design's table, PR #233 r4).

Before this, a board write announced itself with no target: the Agent log
listed it and no cursor moved, and it skipped the session numbering. Now each
write sends the person's tabs a numbered cursor event with a surface anchor
and the table's action, through the same person form as any cursor.
"""
from __future__ import annotations

from uuid import uuid4

import pytest
from fastapi.testclient import TestClient
from PIL import Image

from services.agent_presence import AgentPresence
from services.output import OUTPUT_ROOT

AGENT = {"X-Nebula-Agent": "Claude Code"}
LANE_A = {**AGENT, "X-Nebula-Agent-Session": "lane-a"}
LANE_B = {**AGENT, "X-Nebula-Agent-Session": "lane-b"}


@pytest.fixture
def api(tmp_path, monkeypatch, canvas_project):
    import main as main_module

    monkeypatch.setenv("NEBULA_MOODBOARD_ROOT", str(tmp_path / "moodboards"))
    presence = AgentPresence()
    sent: list[tuple[dict, dict | None]] = []  # (what the person's tabs got, what everyone else got)

    async def capture(data, **kw):
        sent.append((data, kw.get("others")))

    async def ignore(data):
        return None

    monkeypatch.setattr(main_module, "agent_presence", presence)
    monkeypatch.setattr(main_module.manager, "broadcast_raw", capture)
    monkeypatch.setattr(main_module.manager, "broadcast_browser", ignore)
    return TestClient(main_module.app), sent, presence, canvas_project


def _url(color=(200, 80, 40)) -> str:
    path = OUTPUT_ROOT / "cursor-anywhere-write-tests" / f"{uuid4().hex[:10]}.png"
    path.parent.mkdir(parents=True, exist_ok=True)
    Image.new("RGB", (32, 24), color).save(path)
    return f"/api/outputs/{path.resolve().relative_to(OUTPUT_ROOT.resolve()).as_posix()}"


def _create(client, headers=None, count=3, **body) -> dict:
    colors = [(200, 80, 40), (20, 40, 200), (40, 200, 90), (90, 90, 90)]
    response = client.post("/api/moodboards", headers=headers or {},
                           json={"name": "Desert light", "images": [{"url": _url(colors[n])} for n in range(count)],
                                 **body})
    assert response.status_code == 200, response.text
    return response.json()


def _edit(client, board_id, ops, headers=None, **body):
    response = client.post(f"/api/moodboards/{board_id}/edits", headers=headers or {}, json={"ops": ops, **body})
    assert response.status_code == 200, response.text
    return response.json()


def _put(client, board_id, headers=None, **body):
    response = client.put(f"/api/moodboards/{board_id}", headers=headers or {}, json=body)
    assert response.status_code == 200, response.text
    return response.json()


def _cursor(sent, index=-1) -> dict:
    """The person's copy of the n-th agentPresence event."""
    return [person for person, _ in sent if person.get("type") == "agentPresence"][index]


def _where(event: dict) -> tuple:
    target = event.get("target") or {}
    return target.get("itemId"), target.get("part"), event["action"]


def _after(sent):
    """Run a write and return what it sent, as (itemId, part, action) of its one event."""
    return _where(_cursor(sent))


# -- the table, row by row ---------------------------------------------------------------

def test_create_is_the_board_click(api):
    client, sent, _, _ = api
    board = _create(client, LANE_A)
    event = _cursor(sent)
    assert _where(event) == (board["id"], None, "click")
    assert event["target"]["surface"] == "moodboard" and event["anchorNames"] == {"board": "Desert light"}
    assert event["say"] == "Made board Desert light with 3 images"


def test_move_and_restore_are_the_board_click(api):
    client, sent, _, project_id = api
    board = _create(client, projectId=project_id)
    moved = client.post(f"/api/moodboards/{board['id']}/move", headers=LANE_A, json={"projectId": None})
    assert moved.status_code == 200, moved.text
    assert _where(_cursor(sent)) == (board["id"], None, "click")
    assert client.delete(f"/api/moodboards/{board['id']}").status_code == 200
    assert client.post(f"/api/trash/moodboard/{board['id']}/restore", headers=LANE_A).status_code == 200
    assert _where(_cursor(sent)) == (board["id"], None, "click")
    assert _cursor(sent)["say"] == "Restored board Desert light"


def test_adding_one_image_is_that_image_and_several_are_the_board(api):
    client, sent, _, _ = api
    board = _create(client)
    _edit(client, board["id"], [{"op": "add", "images": [{"id": "newone", "url": _url((9, 9, 9))}]}], LANE_A)
    event = _cursor(sent)
    assert _where(event) == (f"{board['id']}/newone", None, "click")
    assert event["anchorNames"] == {"board": "Desert light", "image": 4}
    _edit(client, board["id"], [{"op": "add", "images": [{"url": _url((1, 1, 1))}, {"url": _url((2, 2, 2))}]}], LANE_A)
    assert _where(_cursor(sent)) == (board["id"], None, "click")


def test_removing_an_image_clicks_it_and_that_cursor_holds_the_spot(api):
    client, sent, presence, _ = api
    board = _create(client)
    gone = board["images"][1]
    # lane-b is looking at the same image; lane-a removes it.
    client.post("/api/canvas/cursor", headers=LANE_B, json={
        "target": {"surface": "moodboard", "board": board["id"], "image": 2}, "action": "look"})
    _edit(client, board["id"], [{"op": "remove", "images": [gone["id"]]}], LANE_A)
    event = _cursor(sent)
    assert _where(event) == (f"{board['id']}/{gone['id']}", None, "click")
    assert event["anchorNames"] == {"board": "Desert light", "image": 2}  # numbered as it was on the board
    by_session = {cursor["session"]["ordinal"]: cursor for cursor in presence.replay()}
    # The remover holds the image it clicked; the other cursor, made elsewhere, falls back to the board.
    assert by_session[event["session"]["ordinal"]]["target"]["itemId"] == f"{board['id']}/{gone['id']}"
    other = next(cursor for cursor in presence.replay() if cursor["session"]["key"] != event["session"]["key"])
    assert other["target"] == {"surface": "moodboard", "itemId": board["id"]}


def test_the_persons_removal_drops_every_cursor_on_the_image_to_the_board(api):
    client, sent, presence, _ = api
    board = _create(client)
    gone = board["images"][0]
    client.post("/api/canvas/cursor", headers=LANE_A, json={
        "target": {"surface": "moodboard", "board": board["id"], "image": 1}, "action": "look"})
    _edit(client, board["id"], [{"op": "remove", "images": [gone["id"]]}])  # the person's
    assert [cursor["target"] for cursor in presence.replay()] == [{"surface": "moodboard", "itemId": board["id"]}]


def test_placing_one_card_is_that_image_and_set_aside_too(api):
    client, sent, _, _ = api
    board = _create(client)
    first = board["images"][0]
    _edit(client, board["id"], [{"op": "place", "image": first["id"], "x": 700, "y": 40}], LANE_A)
    assert _after(sent) == (f"{board['id']}/{first['id']}", None, "click")
    _edit(client, board["id"], [{"op": "setAside", "image": first["id"], "value": True}], LANE_A)
    assert _after(sent) == (f"{board['id']}/{first['id']}", None, "click")


@pytest.mark.parametrize("field, value, part, action", [
    ("name", "Dune dawn", "name", "type"),
    ("direction", "Low sun, long shadows", "direction", "type"),
    ("avoid", ["neon"], "avoid", "type"),
    ("pinnedColors", {"include": ["#C8A27A"], "exclude": []}, "colors", "click"),
])
def test_a_field_is_its_control_typed_and_a_pin_is_a_click_on_colors(api, field, value, part, action):
    client, sent, _, _ = api
    board = _create(client)
    _put(client, board["id"], LANE_A, **{field: value})
    event = _cursor(sent)
    assert _where(event) == (board["id"], part, action), event
    assert event["anchorNames"]["part"] == {"name": "Name", "direction": "Direction", "avoid": "Avoid",
                                            "colors": "Colors"}[part]


def test_two_controls_in_one_write_are_the_board_not_a_control(api):
    client, sent, _, _ = api
    board = _create(client)
    _put(client, board["id"], LANE_A, direction="Low sun", avoid=["neon"])
    assert _after(sent) == (board["id"], None, "type")


def test_a_weight_is_a_click_and_a_note_is_typed(api):
    client, sent, _, _ = api
    board = _create(client)
    image = board["images"][2]
    _edit(client, board["id"], [{"op": "weight", "image": 3, "value": 0.5}], LANE_A)
    event = _cursor(sent)
    assert _where(event) == (f"{board['id']}/{image['id']}", "weight", "click")
    assert event["anchorNames"] == {"board": "Desert light", "image": 3, "part": "Weight"}
    _edit(client, board["id"], [{"op": "note", "image": 3, "notes": "warmer"}], LANE_A)
    event = _cursor(sent)
    assert _where(event) == (f"{board['id']}/{image['id']}", "note", "type")
    assert event["anchorNames"]["part"] == "Note"
    # A private note is the same control (its text is never in the line).
    _edit(client, board["id"], [{"op": "note", "image": 3, "privateNote": "secret"}], LANE_A)
    assert _where(_cursor(sent)) == (f"{board['id']}/{image['id']}", "note", "type")
    assert "secret" not in str(_cursor(sent))


def test_a_weight_and_a_set_aside_together_are_the_image_not_a_control(api):
    client, sent, _, _ = api
    board = _create(client)
    image = board["images"][0]
    _edit(client, board["id"], [{"op": "weight", "image": 1, "value": 0.4},
                                {"op": "setAside", "image": 1, "value": True}], LANE_A)
    assert _after(sent) == (f"{board['id']}/{image['id']}", None, "click")


def test_analyze_looks_at_the_colors_and_keeping_the_brief_clicks_the_direction(api):
    client, sent, _, _ = api
    board = _create(client)
    assert client.post(f"/api/moodboards/{board['id']}/analyze", headers=LANE_A).status_code == 200
    assert _where(_cursor(sent)) == (board["id"], "colors", "look")
    assert _cursor(sent)["say"] == "Analyzed board Desert light"
    # The agent keeps a hand-written brief of its own.
    _put(client, board["id"], LANE_A, briefOverride={"text": "My own brief."})
    kept = client.post(f"/api/moodboards/{board['id']}/brief-override/keep", headers=LANE_A)
    assert kept.status_code == 200, kept.text
    assert _where(_cursor(sent)) == (board["id"], "direction", "click")
    assert _cursor(sent)["say"] == "Kept the brief on board Desert light"


def test_delete_sends_no_cursor_and_every_cursor_on_the_board_leaves(api):
    client, sent, presence, _ = api
    board = _create(client)
    other = _create(client, name="Dusk", count=1)
    for headers, ref in ((LANE_A, board["id"]), (LANE_B, board["id"])):
        client.post("/api/canvas/cursor", headers=headers, json={"target": {"surface": "moodboard", "board": ref}})
    client.post("/api/canvas/cursor", headers={**AGENT, "X-Nebula-Agent-Session": "lane-c"},
                json={"target": {"surface": "moodboard", "board": other["id"]}})
    sent.clear()
    assert client.delete(f"/api/moodboards/{board['id']}", headers=LANE_A).status_code == 200
    event = _cursor(sent)
    assert "target" not in event and event["say"] == "Deleted board Desert light"  # the Agent log only
    assert [cursor["target"]["itemId"] for cursor in presence.replay()] == [other["id"]]
    # The numbers on the board are free again: the next new session takes the lowest.
    again = client.post("/api/canvas/cursor", headers={**AGENT, "X-Nebula-Agent-Session": "lane-d"},
                        json={"target": {"surface": "moodboard", "board": other["id"]}})
    assert again.status_code == 200
    assert _cursor(sent)["session"]["ordinal"] == 1


# -- how it is sent ------------------------------------------------------------------------

def test_a_write_is_the_sessions_numbered_cursor_and_agents_get_the_agent_form(api):
    client, sent, _, _ = api
    board = _create(client)
    _edit(client, board["id"], [{"op": "weight", "image": 1, "value": 0.5}], LANE_A)
    _edit(client, board["id"], [{"op": "weight", "image": 2, "value": 0.5}], LANE_B)
    person, agent_form = [(person, others) for person, others in sent if person.get("type") == "agentPresence"][-1]
    assert person["session"]["ordinal"] == 2 and "session" not in agent_form
    assert agent_form["target"] == person["target"] and agent_form["action"] == person["action"]
    sessions = {event["session"]["ordinal"] for event, _ in sent if event.get("type") == "agentPresence"}
    assert sessions == {1, 2}  # never a second, unnumbered cursor displacing session 1


def test_the_persons_own_writes_move_no_cursor_and_send_nothing(api):
    client, sent, presence, _ = api
    board = _create(client)
    _edit(client, board["id"], [{"op": "weight", "image": 1, "value": 0.5}])
    _put(client, board["id"], name="Mine")
    client.post(f"/api/moodboards/{board['id']}/analyze")
    client.delete(f"/api/moodboards/{board['id']}")
    assert [event for event, _ in sent if event.get("type") == "agentPresence"] == []
    assert presence.active() == []


def test_the_agent_log_line_is_still_the_writes_own_words(api):
    client, sent, _, _ = api
    board = _create(client)
    _edit(client, board["id"], [{"op": "weight", "image": 1, "value": 0.5}], LANE_A)
    assert _cursor(sent)["say"] == "Resized #1 on board Desert light"
    _edit(client, board["id"], [{"op": "weight", "image": 2, "value": 0.5}], LANE_A, say="Eased the blue")
    assert _cursor(sent)["say"] == "Eased the blue"
