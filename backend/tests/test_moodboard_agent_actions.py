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
from services.moodboard_actions import describe_update
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

    assert _said(sent) == ["Made moodboard “Dusk dunes” with 2 images", "Set aside 1 image in “Dusk dunes”",
                           "Analyzed “Dusk dunes”"]
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
    assert _said(sent) == ["Moved “Dusk dunes” to Global", "Deleted moodboard “Dusk dunes”"]


def test_an_agents_restore_from_recently_deleted_is_logged(api):
    # MCP restore_from_trash and `nebula trash restore` bring a board back.
    client, sent, _, _ = api
    board = _create(client)
    assert client.delete(f"/api/moodboards/{board['id']}").status_code == 200
    restored = client.post(f"/api/trash/moodboard/{board['id']}/restore", headers=AGENT)
    assert restored.status_code == 200, restored.text
    assert _said(sent) == ["Restored moodboard “Dusk dunes”"]


def test_a_refused_write_logs_nothing(api):
    client, sent, _, _ = api
    board = _create(client)
    # Turning notes on for generators is the person's call.
    refused = client.put(f"/api/moodboards/{board['id']}", headers=AGENT, json={"sendNotes": True})
    assert refused.status_code == 403
    assert _said(sent) == []


# -- the words ---------------------------------------------------------------

def _board(**fields) -> dict:
    images = [{"id": "a", "url": "/a.png", "weight": 1.0, "notes": "", "privateNote": "", "excluded": False},
              {"id": "b", "url": "/b.png", "weight": 1.0, "notes": "", "privateNote": "", "excluded": True}]
    return {"name": "Dusk", "images": images, "notes": "", "direction": "", "avoid": [], **fields}


def test_describe_update_names_each_kind_of_change():
    before = _board()
    after = _board()
    after["images"] = [
        {**before["images"][0], "excluded": True, "weight": 0.5},
        {**before["images"][1], "excluded": False, "notes": "the sky"},
        {"id": "c", "url": "/c.png", "weight": 1.0, "notes": "", "privateNote": "", "excluded": False},
    ]
    assert describe_update(before, after) == (
        "Set aside 1 image, used 1 image again, added 1 image, set the weight of 1 image, "
        "edited notes on 1 image in “Dusk”"
    )
    assert describe_update(before, _board(images=before["images"][:1])) == "Removed 1 image in “Dusk”"
    assert describe_update(before, _board(direction="warm dusk", avoid=["neon"])) == (
        "Set Direction, set Avoid in “Dusk”")
    assert describe_update(before, _board(name="Dawn")) == "Renamed “Dusk” to “Dawn”"
    assert describe_update(before, _board()) == "Updated “Dusk”"


def test_describe_update_never_quotes_what_the_person_wrote_privately():
    before = _board()
    after = _board()
    after["images"] = [{**before["images"][0], "privateNote": "my secret label"}, before["images"][1]]
    said = describe_update(before, after)
    assert said == "Edited private notes on 1 image in “Dusk”"
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
    assert _said(sent) == ["Set aside 1 image in “Dusk dunes”"]
