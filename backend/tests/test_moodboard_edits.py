"""Checked board edits (moodboard canvas PR3): ``POST /api/moodboards/{id}/edits``.

A batch of ops lands whole or not at all, with ``version + 1``; ``baseVersion``
(on ``/edits`` and on ``PUT``) refuses a write made against an older board
with a 409 that carries the current one; every batch returns ``undo``, a
``restore`` of before-slices with ``expect`` after-slices, so undoing it
skips what changed since (docs/moodboard-canvas-plan.md sections 5.1, 5.2,
4.7, 4.9). The journal gets one ``board.*`` event per batch, and so do PUTs
that change images, so older clients' edits show up too.
"""
from __future__ import annotations

import copy
import json
from pathlib import Path

import pytest
from fastapi.testclient import TestClient

import moodboard_client as boards
from tests.conftest import PERSON
from tests.test_moodboard_board_model import (
    BOARD_ID,
    LABEL,
    _digest,
    _image_url,
    fixture_board,
    write_board,
)

AGENT = {"X-Nebula-Agent": "Claude Code"}
TAB = "tab-0123456789abcdef"


@pytest.fixture
def root(tmp_path, monkeypatch) -> Path:
    moodboards = tmp_path / "moodboards"
    monkeypatch.setenv("NEBULA_MOODBOARD_ROOT", str(moodboards))
    return moodboards


@pytest.fixture
def journal(monkeypatch):
    import main as main_module
    from services.canvas_events import CanvasEventJournal

    fresh = CanvasEventJournal()
    monkeypatch.setattr(main_module, "canvas_events", fresh)
    return fresh


@pytest.fixture
def sent(monkeypatch) -> list[dict]:
    import main as main_module

    messages: list[dict] = []

    async def capture(data):
        messages.append(data)

    async def ignore(data):
        return None

    monkeypatch.setattr(main_module.manager, "broadcast_raw", capture)
    monkeypatch.setattr(main_module.manager, "broadcast_browser", ignore)
    return messages


@pytest.fixture
def client(root, journal, sent, canvas_project):
    import main as main_module

    return TestClient(main_module.app)


@pytest.fixture
def app(client, monkeypatch):
    """The CLI and MCP client, talking to the test app."""
    import mcp_server
    from cli.client import NebulaClient
    from nebula_api import NebulaAPI

    monkeypatch.delenv("NEBULA_AGENT_TOKEN", raising=False)
    monkeypatch.delenv("NEBULA_AGENT_NAME", raising=False)
    cli = NebulaClient("http://testserver")
    cli._client = client
    monkeypatch.setattr(mcp_server, "_api", lambda: NebulaAPI("http://testserver", client=client))
    return cli


def _edit(client, ops, *, base=None, headers=None, board_id=BOARD_ID, say=None):
    body: dict = {"ops": ops}
    if base is not None:
        body["baseVersion"] = base
    if say is not None:
        body["say"] = say
    return client.post(f"/api/moodboards/{board_id}/edits", json=body, headers=headers or {})


def _ok(response) -> dict:
    assert response.status_code == 200, response.text
    return response.json()


def _layout(board: dict) -> dict:
    """What an undo must give back: every image (in order) and frame, less
    what a write stamps or clears (version, time, the analysis)."""
    return {"images": board["images"], "frames": board.get("frames") or []}


def _board_events(journal) -> list[dict]:
    return journal.read(after=0, kinds={"board"}, limit=100)["events"]


def _changes(sent) -> list[dict]:
    return [m for m in sent if m.get("type") == "storedAssetChanged"]


# -- fail on main first --------------------------------------------------------

def test_a_stale_base_version_returns_409(client, root):
    path = write_board(root, fixture_board())  # saved at version 3
    before = _digest(path)

    put = client.put(f"/api/moodboards/{BOARD_ID}", json={"name": "Renamed", "baseVersion": 2})
    assert put.status_code == 409, put.text
    assert put.json()["code"] == "version_conflict"
    assert put.json()["version"] == 3
    assert put.json()["board"]["name"] == "Placed"
    edits = _edit(client, [{"op": "weight", "image": 1, "value": 0.5}], base=2)
    assert edits.status_code == 409 and edits.json()["version"] == 3
    assert _digest(path) == before

    assert _ok(client.put(f"/api/moodboards/{BOARD_ID}", json={"name": "Renamed", "baseVersion": 3}))["version"] == 4
    assert _ok(_edit(client, [{"op": "weight", "image": 1, "value": 0.5}], base=4))["version"] == 5


def test_a_cli_add_racing_a_studio_weight_edit_keeps_both(app, client, root, tmp_path):
    write_board(root, fixture_board())
    studio = client.get(f"/api/moodboards/{BOARD_ID}", headers=PERSON).json()  # the Studio's read, version 3
    extra = _image_url("racer.png", (20, 20), (90, 200, 90))

    # The CLI adds an image while the Studio holds its weight edit.
    added, count, _skipped, _undo = boards.add_to_board(app.api, BOARD_ID, [extra])
    assert count == 1 and added["version"] == 4

    # The Studio sends its edit against the board it read: refused, with the
    # board as it is now, so it rebases and sends again.
    refused = _edit(client, [{"op": "weight", "image": "img-b", "value": 0.4}], base=studio["version"],
                    headers=PERSON)
    assert refused.status_code == 409
    current = refused.json()["version"]
    saved = _ok(_edit(client, [{"op": "weight", "image": "img-b", "value": 0.4}], base=current, headers=PERSON))

    images = saved["board"]["images"]
    assert [image["id"] for image in images][:2] == ["img-a", "img-b"] and len(images) == 3
    assert images[1]["weight"] == 0.4
    assert images[2]["url"] == extra


# -- the route -------------------------------------------------------------------

def test_a_batch_lands_whole_or_not_at_all(client, root):
    path = write_board(root, fixture_board())
    before = _digest(path)
    bad = _edit(client, [{"op": "weight", "image": 1, "value": 0.5},
                         {"op": "place", "placement": "pl-a", "x": "left", "y": 0}])
    assert bad.status_code == 422
    assert "ops[1]" in bad.json()["detail"]
    assert _digest(path) == before

    unknown = _edit(client, [{"op": "arrange", "by": "look"}])
    assert unknown.status_code == 422 and "arrange" in unknown.json()["detail"]
    assert _edit(client, []).status_code == 422
    too_many = _edit(client, [{"op": "place", "placement": "pl-a", "x": i, "y": 0} for i in range(501)])
    assert too_many.status_code == 422 and "500" in too_many.json()["detail"]
    assert _digest(path) == before

    done = _ok(_edit(client, [{"op": "weight", "image": 1, "value": 0.5},
                              {"op": "place", "placement": "pl-b", "x": 600, "y": 10}]))
    assert done["version"] == 4
    assert [entry["status"] for entry in done["applied"]] == ["applied", "applied"]
    saved = json.loads(path.read_text(encoding="utf-8"))
    assert saved["version"] == 4 and saved["images"][0]["weight"] == 0.5
    assert saved["images"][1]["placements"][0]["x"] == 600


def test_an_unknown_board_and_a_trashed_one_are_404(client, root):
    assert _edit(client, [{"op": "weight", "image": 1, "value": 0.5}], board_id="nosuchboard1").status_code == 404
    write_board(root, fixture_board())
    assert client.delete(f"/api/moodboards/{BOARD_ID}").status_code == 200
    gone = _edit(client, [{"op": "weight", "image": 1, "value": 0.5}])
    assert gone.status_code == 404 and gone.json()["code"] == "in_trash"


def test_replaying_a_batch_changes_nothing(client, root):
    path = write_board(root, fixture_board())
    ops = [{"op": "place", "placement": "pl-a", "x": 12, "y": 34}, {"op": "note", "image": 2, "notes": "teal"},
           {"op": "add", "images": [{"id": "img-new", "url": _image_url("new.png", (30, 20), (1, 2, 3))}]}]
    first = _ok(_edit(client, ops))
    assert first["version"] == 4
    after = _digest(path)
    again = _ok(_edit(client, ops))
    assert again["version"] == 4
    assert [entry["status"] for entry in again["applied"]] == ["unchanged"] * 3
    assert again["undo"] == {"ops": []}
    assert _digest(path) == after


def test_the_inverse_round_trips(client, root):
    write_board(root, fixture_board())
    original = _layout(client.get(f"/api/moodboards/{BOARD_ID}").json())
    new_url = _image_url("third.png", (24, 24), (10, 10, 200))
    ops = [
        {"op": "frame.create", "id": "f00000000001", "name": "Dither", "x": 0, "y": 400, "w": 1200, "h": 600},
        {"op": "add", "urls": [new_url], "in": "Dither"},
        {"op": "link", "image": 1, "frameId": "Dither"},
        {"op": "place", "placement": "pl-b", "x": 900, "y": 20},
        {"op": "resize", "placement": "pl-b", "weight": 0.5},
        {"op": "weight", "image": 1, "value": 0.6},
        {"op": "note", "image": 1, "notes": "only the orange", "privateNote": "kept"},
        {"op": "setAside", "image": 2, "value": True},
    ]
    done = _ok(_edit(client, ops, headers=PERSON))
    assert len(done["board"]["images"]) == 3
    undo = done["undo"]["ops"]
    assert [op["op"] for op in undo] == ["restore"]

    undone = _ok(_edit(client, undo, headers=PERSON))
    assert _layout(undone["board"]) == original
    assert undone["applied"][0]["skipped"] == []
    # Undo never brings an analysis back, and redoing is the ops again.
    redone = _ok(_edit(client, undone["undo"]["ops"], headers=PERSON))
    assert _layout(redone["board"]) == _layout(done["board"])


def test_frame_ops_round_trip_and_keep_their_cards(client, root, person):
    write_board(root, fixture_board())
    original = _layout(client.get(f"/api/moodboards/{BOARD_ID}").json())
    made = _ok(_edit(client, [
        {"op": "frame.create", "id": "f00000000001", "name": "Warm", "around": ["pl-a"]},
        {"op": "frame.create", "id": "f00000000002", "name": "Cool", "x": 480, "y": -40, "w": 600, "h": 420},
    ], headers=PERSON))
    by_frame = {p["id"]: p["frameId"] for image in made["board"]["images"] for p in image["placements"]}
    # "around" takes the named card; drawing takes the cards fully inside it.
    assert by_frame == {"pl-a": "f00000000001", "pl-b": "f00000000002"}
    warm = next(f for f in made["board"]["frames"] if f["id"] == "f00000000001")
    assert warm["x"] <= 0 and warm["y"] <= 0 and warm["w"] >= 480 and warm["h"] >= 270
    assert warm["namedBy"] == "person" and warm["kind"] == "look"

    moved = _ok(_edit(client, [{"op": "frame.update", "frame": "Cool", "x": 580, "y": -40, "name": "Teal"}]))
    card = next(p for image in moved["board"]["images"] for p in image["placements"] if p["id"] == "pl-b")
    assert card["x"] == 604  # moved with its frame
    assert {f["name"] for f in moved["board"]["frames"]} == {"Warm", "Teal"}

    merged = _ok(_edit(client, [{"op": "frame.merge", "frame": "Teal", "into": "Warm"}]))
    assert [f["name"] for f in merged["board"]["frames"]] == ["Warm"]
    assert {p["frameId"] for image in merged["board"]["images"] for p in image["placements"]} == {"f00000000001"}
    deleted = _ok(_edit(client, [{"op": "frame.delete", "frame": "Warm"}]))
    assert deleted["board"]["frames"] == []
    assert {p["frameId"] for image in deleted["board"]["images"] for p in image["placements"]} == {None}

    for step in (deleted, merged, moved, made):
        _ok(_edit(client, step["undo"]["ops"]))
    assert _layout(client.get(f"/api/moodboards/{BOARD_ID}").json()) == original


def test_a_copy_into_a_frame_it_is_already_in_is_refused(client, root):
    write_board(root, fixture_board())
    _ok(_edit(client, [{"op": "frame.create", "id": "f00000000001", "name": "Dither", "around": ["pl-a"]}]))
    refused = _edit(client, [{"op": "link", "image": 1, "frameId": "Dither"}])
    assert refused.status_code == 422 and "Already in Dither" in refused.json()["detail"]
    _ok(_edit(client, [{"op": "frame.create", "id": "f00000000002", "name": "Glass", "x": 2000, "y": 0,
                        "w": 600, "h": 400},
                       {"op": "link", "image": 1, "frameId": "Glass"}]))
    dropped = _edit(client, [{"op": "place", "placement": "1@Glass", "x": 0, "y": 0, "frameId": "Dither"}])
    assert dropped.status_code == 422 and "Already in Dither" in dropped.json()["detail"]
    # Out of a frame onto empty canvas: the copy goes; the last card stays, loose.
    out = _ok(_edit(client, [{"op": "place", "placement": "1@Glass", "x": 0, "y": 900, "frameId": None}]))
    assert [p["frameId"] for p in out["board"]["images"][0]["placements"]] == ["f00000000001"]
    out = _ok(_edit(client, [{"op": "place", "placement": "1@Dither", "x": 0, "y": 900, "frameId": None}]))
    assert [(p["frameId"], p["y"]) for p in out["board"]["images"][0]["placements"]] == [(None, 900)]


def test_a_partial_restore_skips_what_changed_since(client, root):
    write_board(root, fixture_board())
    moved = _ok(_edit(client, [{"op": "place", "placement": "pl-a", "x": 100, "y": 500},
                               {"op": "place", "placement": "pl-b", "x": 700, "y": 500}], headers=PERSON))
    # Someone moves #2 again before the undo.
    _ok(_edit(client, [{"op": "place", "placement": "pl-b", "x": 1500, "y": 500}], headers=AGENT))

    undone = _ok(_edit(client, moved["undo"]["ops"], headers=PERSON))
    cards = {p["id"]: (p["x"], p["y"]) for image in undone["board"]["images"] for p in image["placements"]}
    assert cards == {"pl-a": (0, 0), "pl-b": (1500, 500)}
    skipped = undone["applied"][0]["skipped"]
    assert len(skipped) == 1 and skipped[0]["image"] == "img-b" and skipped[0]["number"] == 2
    assert skipped[0]["message"] == "#2 changed since, left as is"


def test_a_move_keeps_the_analysis_and_a_resize_sets_weight_from_area(client, root):
    from services.moodboard_analysis import analysis_is_current
    from services.moodboard_layout import FULL_AREA

    write_board(root, fixture_board())
    analyzed = _ok(client.post(f"/api/moodboards/{BOARD_ID}/analyze"))
    assert analysis_is_current(analyzed, analyzed["analysis"])

    moved = _ok(_edit(client, [{"op": "place", "placement": "pl-a", "x": 300, "y": 900}]))
    assert moved["board"]["analysis"] == analyzed["analysis"]
    assert analysis_is_current(moved["board"], moved["board"]["analysis"])
    private = _ok(_edit(client, [{"op": "note", "image": 1, "privateNote": "liked"}]))
    assert private["board"]["analysis"] == analyzed["analysis"]

    resized = _ok(_edit(client, [{"op": "resize", "placement": "pl-b", "w": 208, "h": 156}]))
    card = resized["board"]["images"][1]["placements"][0]
    weight = 208 * 156 / FULL_AREA
    assert card["weight"] == pytest.approx(weight)
    assert abs(card["w"] * card["h"] - weight * FULL_AREA) <= card["w"] + card["h"]
    assert card["w"] / card["h"] == pytest.approx(416 / 312, abs=0.02)  # the card's aspect is kept
    assert resized["board"]["images"][1]["weight"] == pytest.approx(weight)
    assert resized["board"]["analysis"] is None


def test_numbers_are_the_boards_before_the_batch(client, root):
    write_board(root, fixture_board())
    done = _ok(_edit(client, [{"op": "remove", "images": [1]}, {"op": "note", "image": 2, "notes": "still #2"}]))
    assert [(image["id"], image["notes"]) for image in done["board"]["images"]] == [("img-b", "still #2")]
    refused = _edit(client, [{"op": "remove", "images": [1]}, {"op": "note", "image": 1, "notes": "x"}])
    assert refused.status_code == 422 and "removed" in refused.json()["detail"]


def test_undoing_a_remove_puts_the_image_back_at_its_number(client, root):
    write_board(root, fixture_board())
    original = client.get(f"/api/moodboards/{BOARD_ID}").json()
    removed = _ok(_edit(client, [{"op": "remove", "images": ["img-a"]}]))
    assert removed["board"]["thumbnail"] == original["images"][1]["url"]
    back = _ok(_edit(client, removed["undo"]["ops"]))
    assert back["board"]["images"] == original["images"]
    assert back["board"]["thumbnail"] == original["thumbnail"]


def test_add_places_new_images_and_unique_skips_urls_on_the_board(client, root):
    write_board(root, fixture_board())
    board = client.get(f"/api/moodboards/{BOARD_ID}").json()
    on_board = board["images"][0]["url"]
    fresh = _image_url("fresh.png", (40, 20), (5, 6, 7))
    done = _ok(_edit(client, [{"op": "add", "urls": [on_board, fresh, fresh], "unique": True}], headers=AGENT))
    assert [image["url"] for image in done["board"]["images"]] == [image["url"] for image in board["images"]] + [fresh]
    entry = done["applied"][0]
    assert entry["added"] == [done["board"]["images"][2]["id"]] and entry["skipped"] == 2
    card = done["board"]["images"][2]["placements"][0]
    assert card["placedBy"] == "agent" and card["frameId"] is None
    assert done["board"]["analysis"] is None

    at = _ok(_edit(client, [{"op": "add", "urls": [_image_url("at.png", (20, 20), (9, 9, 9))],
                             "at": {"x": 5000, "y": 40}, "size": 0.25}]))
    card = at["board"]["images"][3]["placements"][0]
    assert (card["x"], card["y"], card["weight"]) == (5000, 40, 0.25)
    assert at["board"]["images"][3]["weight"] == 0.25


def test_set_aside_off_on_a_weight_zero_image_takes_its_card_weight(client, root):
    board = fixture_board()
    board["images"][1]["weight"] = 0.0
    board["images"][1]["placements"][0]["weight"] = 0.55
    write_board(root, board)
    done = _ok(_edit(client, [{"op": "setAside", "image": 2, "value": False},
                              {"op": "setAside", "image": 1, "value": True}]))
    assert [(i["excluded"], i["weight"]) for i in done["board"]["images"]] == [(True, 1.0), (False, 0.55)]


def test_a_weight_scales_every_copy(client, root):
    write_board(root, fixture_board())
    _ok(_edit(client, [{"op": "frame.create", "id": "f00000000001", "name": "Dither", "around": ["pl-a"]},
                       {"op": "frame.create", "id": "f00000000002", "name": "Glass", "x": 0, "y": 600,
                        "w": 1000, "h": 600},
                       {"op": "link", "image": 1, "frameId": "Glass", "weight": 0.5}]))
    done = _ok(_edit(client, [{"op": "weight", "image": 1, "value": 0.5}]))
    image = done["board"]["images"][0]
    assert image["weight"] == 0.5
    assert sorted(p["weight"] for p in image["placements"]) == [0.25, 0.5]


# -- broadcast -------------------------------------------------------------------

def test_the_broadcast_carries_version_edit_touched_and_undo(client, root, sent, person):
    write_board(root, fixture_board())
    done = _ok(_edit(client, [{"op": "place", "placement": "pl-b", "x": 900, "y": 0}],
                     headers={**PERSON, "X-Nebula-Tab": TAB}))
    message = _changes(sent)[-1]
    assert message["id"] == BOARD_ID and message["version"] == done["version"] == 4
    assert message["edit"]["actor"] == {"kind": "person"} and message["edit"]["tab"] == TAB
    assert message["touched"] == {"images": ["img-b"], "frames": [], "looks": []}
    assert message["undo"] == done["undo"]

    # A PUT says the same, with no undo.
    client.put(f"/api/moodboards/{BOARD_ID}", json={"name": "Renamed"}, headers={**PERSON, "X-Nebula-Tab": TAB})
    message = _changes(sent)[-1]
    assert message["version"] == 5 and message["edit"]["tab"] == TAB and message["undo"] is None

    # Over 200 ops, undo is left out of the broadcast (not the answer).
    big = _ok(_edit(client, [{"op": "place", "placement": "pl-a", "x": i * 10, "y": 0} for i in range(201)]))
    assert big["undo"]["ops"] and _changes(sent)[-1]["undo"] is None


def test_an_agent_cannot_send_a_tab(client, root, sent, person):
    write_board(root, fixture_board())
    _ok(_edit(client, [{"op": "place", "placement": "pl-b", "x": 900, "y": 0}],
              headers={**AGENT, "X-Nebula-Tab": TAB}))
    edit = _changes(sent)[-1]["edit"]
    assert "tab" not in edit and edit["actor"]["kind"] == "agent" and edit["actor"]["name"] == "Claude Code"
    # Nor can a script that leaves the agent header out: only the person's tab is a tab.
    _ok(_edit(client, [{"op": "place", "placement": "pl-b", "x": 950, "y": 0}], headers={"X-Nebula-Tab": TAB}))
    assert "tab" not in _changes(sent)[-1]["edit"]


# -- journal -----------------------------------------------------------------------

def test_journal_kinds_and_actors(client, root, journal, canvas_project, person):
    write_board(root, fixture_board())
    _ok(_edit(client, [{"op": "place", "placement": "pl-a", "x": 5, "y": 0}], headers=PERSON))
    assert _board_events(journal) == []  # under 8 px is not a move
    _ok(_edit(client, [{"op": "place", "placement": "pl-a", "x": 200, "y": 900}], headers=PERSON))
    _ok(_edit(client, [{"op": "setAside", "image": 2, "value": True}], headers=AGENT, say="Set #2 aside"))
    _ok(_edit(client, [{"op": "add", "urls": [_image_url("j.png", (20, 20), (3, 3, 3))]}], headers=AGENT))
    _ok(_edit(client, [{"op": "resize", "placement": "pl-b", "weight": 0.5}]))
    _ok(_edit(client, [{"op": "frame.create", "name": "Dither", "x": 0, "y": 2000, "w": 400, "h": 400}]))

    events = _board_events(journal)
    assert [(e["kind"], e["actor"]["kind"]) for e in events] == [
        ("board.moved", "person"), ("board.setAside", "agent"), ("board.added", "agent"),
        ("board.resized", "anonymous"), ("board.frame", "anonymous")]
    first = events[0]
    assert first["data"]["boardId"] == BOARD_ID and first["data"]["boardName"] == "Placed"
    assert first["data"]["scope"] == "global"
    assert first["data"]["refs"] == [{"number": 1, "id": "img-a"}]
    assert first["projectId"] == canvas_project
    assert events[1]["actor"]["name"] == "Claude Code" and events[1]["data"]["say"] == "Set #2 aside"
    assert "#2" in events[1]["summary"]
    # kinds=board reaches them through the group name.
    assert len(journal.read(after=0, kinds={"board.moved"})["events"]) == 1


def test_a_private_note_is_never_journaled_with_its_text(client, root, journal):
    board = fixture_board()
    board["images"][0]["privateNote"] = ""
    write_board(root, board)
    _ok(_edit(client, [{"op": "note", "image": 1, "privateNote": LABEL}]))
    stored = client.get(f"/api/moodboards/{BOARD_ID}").json()
    image = {**stored["images"][1], "privateNote": LABEL + " too"}
    _ok(client.put(f"/api/moodboards/{BOARD_ID}", json={"images": [stored["images"][0], image]}))

    events = _board_events(journal)
    assert [e["kind"] for e in events] == ["board.noted", "board.noted"]
    assert all("private note changed" in e["summary"] for e in events)
    assert "ZQXPRIVATE" not in json.dumps(journal.read(after=0, limit=100), ensure_ascii=False)


def test_put_diffs_show_up_in_the_journal(client, root, journal):
    write_board(root, fixture_board())

    def put(change, **fields):
        images = client.get(f"/api/moodboards/{BOARD_ID}").json()["images"]
        body = {"images": change([{k: v for k, v in image.items() if k != "placements"} for image in images]),
                **fields}
        _ok(client.put(f"/api/moodboards/{BOARD_ID}", json=body))

    # An older client sends the whole image list.
    put(lambda images: [images[0], {**images[1], "weight": 0.3}])
    put(lambda images: [{**images[0], "excluded": True}, images[1]], notes="new board notes")
    put(lambda images: images[1:])
    _ok(client.put(f"/api/moodboards/{BOARD_ID}", json={"name": "Only a rename"}))
    kinds = [e["kind"] for e in _board_events(journal)]
    assert kinds == ["board.resized", "board.setAside", "board.removed"]
    assert _board_events(journal)[1]["data"]["kinds"] == ["board.setAside", "board.noted"]


def test_cli_set_journals_its_image_changes_as_board_edits(app, client, root, journal):
    write_board(root, fixture_board())
    boards.update_board(app.api, BOARD_ID, images=[{"image": 2, "weight": 0.3}])
    boards.update_board(app.api, BOARD_ID, images=[{"image": 1, "excluded": True}], notes="new board notes")
    boards.update_board(app.api, BOARD_ID, remove=[1])
    boards.update_board(app.api, BOARD_ID, name="Only a rename")
    # The image changes are one edit; the board's notes go with the PUT after it.
    kinds = [e["kind"] for e in _board_events(journal)]
    assert kinds == ["board.resized", "board.setAside", "board.noted", "board.removed"]


# -- old boards ----------------------------------------------------------------------

def test_every_pinned_board_keeps_its_outputs_after_a_layout_only_write(tmp_path, monkeypatch, journal, sent):
    from tests.test_moodboard_golden import EXPECTED, _client, board_outputs, seed

    root = tmp_path / "moodboards"
    monkeypatch.setenv("NEBULA_MOODBOARD_ROOT", str(root))
    files = seed(root)
    expected = json.loads(EXPECTED.read_text(encoding="utf-8"))
    client = _client()
    pinned = ("analysisIsCurrent", "sourceHash", "briefBasis", "compose", "node", "runNotes",
              "kreaStyleReferences", "generators")
    for label, path in files.items():
        board = client.get(f"/api/moodboards/{path.stem}").json()
        card = board["images"][0]["placements"][0]
        moved = _edit(client, [{"op": "place", "placement": card["id"], "x": card["x"] + 400, "y": card["y"]}],
                      board_id=path.stem)
        assert moved.status_code == 200, (label, moved.text)
        saved = json.loads(path.read_text(encoding="utf-8"))
        assert saved["layoutVersion"] == 1 and saved["images"][0]["placements"][0]["x"] == card["x"] + 400
        actual = json.loads(json.dumps(board_outputs(label, path, client)))
        for key in pinned:
            assert actual[key] == expected[label][key], (label, key)


def test_opening_a_board_and_reading_its_edits_writes_nothing(client, root):
    path = write_board(root, fixture_board())
    before = _digest(path)
    client.get(f"/api/moodboards/{BOARD_ID}")
    _ok(_edit(client, [{"op": "place", "placement": "pl-a", "x": 0, "y": 0}]))  # where it already is
    assert _digest(path) == before


def test_put_refuses_the_layout_and_names_the_edits_route(client, root):
    write_board(root, fixture_board())
    refused = client.put(f"/api/moodboards/{BOARD_ID}", json={"frames": []})
    assert refused.status_code == 422 and "/edits" in refused.json()["detail"]


# -- the CLI and MCP client ------------------------------------------------------------

def test_cli_add_uses_the_add_op_and_hands_back_its_undo(app, client, root):
    write_board(root, fixture_board())
    extra = _image_url("cli-add.png", (20, 30), (200, 10, 10))
    board, added, skipped, undo = boards.add_to_board(app.api, BOARD_ID, [extra])
    assert (added, skipped) == (1, 0) and len(board["images"]) == 3
    assert undo["ops"][0]["op"] == "restore"
    again = boards.add_to_board(app.api, BOARD_ID, [extra])
    assert again[1:3] == (0, 1)

    result = boards.edit_board(app.api, BOARD_ID, undo["ops"])
    assert [image["id"] for image in result["board"]["images"]] == ["img-a", "img-b"]
    with pytest.raises(boards.MoodboardError, match="changed since you read it"):
        boards.edit_board(app.api, BOARD_ID, [{"op": "weight", "image": 1, "value": 0.2}], base_version=1)


def test_mcp_moodboard_add_returns_the_added_ids_and_undo(app, client, root):
    import asyncio

    import mcp_server

    write_board(root, fixture_board())
    extra = _image_url("mcp-add.png", (20, 30), (10, 200, 10))
    data = asyncio.run(mcp_server.moodboard_add(board=BOARD_ID, sources=[extra]))
    assert data["added"] == 1 and len(data["addedIds"]) == 1
    assert data["undo"]["ops"][0]["op"] == "restore"


def test_concurrent_writes_on_threads_never_lose_an_image(root):
    """The store's read, change and write is one step per board, so two
    writers on other threads (the GET route lays out off the event loop)
    can't interleave."""
    import threading

    from services.moodboard_store import MoodboardStore

    write_board(root, fixture_board())
    store = MoodboardStore()
    urls = [_image_url(f"t{i}.png", (10, 10), (i, i, i)) for i in range(8)]
    errors: list[Exception] = []

    def add(url):
        try:
            store.apply_edits(BOARD_ID, [{"op": "add", "urls": [url]}], by="agent")
        except Exception as exc:  # noqa: BLE001 - reported below
            errors.append(exc)

    threads = [threading.Thread(target=add, args=(url,)) for url in urls]
    for thread in threads:
        thread.start()
    for thread in threads:
        thread.join()
    assert not errors
    saved = store.get(BOARD_ID)
    assert sorted(image["url"] for image in saved["images"][2:]) == sorted(urls)
    assert saved["version"] == 3 + len(urls)


def test_a_say_is_kept_short(client, root, journal):
    write_board(root, fixture_board())
    _ok(_edit(client, [{"op": "place", "placement": "pl-a", "x": 400, "y": 400}], headers=AGENT, say="x" * 400))
    assert len(_board_events(journal)[0]["data"]["say"]) <= 140


def test_op_shapes_are_checked(client, root):
    write_board(root, fixture_board())
    for op, needle in [
        ({"op": "weight", "image": 1, "value": 2}, "0 to 1"),
        ({"op": "weight", "image": 9, "value": 0.5}, "no image"),
        ({"op": "note", "image": 1}, "notes or privateNote"),
        ({"op": "note", "image": 1, "privateNote": "x" * 2001}, "2000"),
        ({"op": "place", "placement": "nope", "x": 0, "y": 0}, "no card"),
        ({"op": "place", "placement": "pl-a", "x": 0, "y": 0, "colour": "red"}, "colour"),
        ({"op": "frame.create", "name": "x" * 61, "x": 0, "y": 0, "w": 200, "h": 200}, "60"),
        ({"op": "frame.create", "name": "Tiny", "x": 0, "y": 0, "w": 100, "h": 200}, "160"),
        ({"op": "frame.delete", "frame": "Nowhere"}, "no frame"),
        ({"op": "resize", "placement": "pl-a"}, "weight"),
        ({"op": "add"}, "urls or images"),
        ({"op": "restore", "slices": [{"part": "elsewhere"}]}, "part"),
    ]:
        response = _edit(client, [op])
        assert response.status_code == 422, (op, response.text)
        assert needle in response.json()["detail"], (op, response.json()["detail"])
    assert client.post(f"/api/moodboards/{BOARD_ID}/edits", json={"ops": [], "colour": 1}).status_code == 422


def test_frames_named_twice_or_too_many_are_refused(client, root):
    write_board(root, fixture_board())
    _ok(_edit(client, [{"op": "frame.create", "name": "Dither", "x": 0, "y": 900, "w": 200, "h": 200}]))
    clash = _edit(client, [{"op": "frame.create", "name": "dither", "x": 400, "y": 900, "w": 200, "h": 200}])
    assert clash.status_code == 422 and "already" in clash.json()["detail"]
    many = [{"op": "frame.create", "name": f"F{i}", "x": i * 300, "y": 3000, "w": 200, "h": 200} for i in range(100)]
    assert _edit(client, many).status_code == 422


def test_copy_of_board_not_changed_by_a_refused_restore(client, root):
    path = write_board(root, fixture_board())
    before = _digest(path)
    stale = {"op": "restore", "slices": [{"part": "card", "image": "img-a", "placement": "pl-a",
                                          "before": {**fixture_board()["images"][0]["placements"][0], "x": 77},
                                          "expect": {**fixture_board()["images"][0]["placements"][0], "x": 99}}]}
    done = _ok(_edit(client, [stale]))
    assert done["applied"][0]["status"] == "unchanged" and len(done["applied"][0]["skipped"]) == 1
    assert done["version"] == 3 and _digest(path) == before
    assert copy.deepcopy(done["undo"]) == {"ops": []}


# -- review fixes -------------------------------------------------------------------

def test_cli_set_keeps_an_edit_saved_between_its_read_and_its_write(app, client, root, monkeypatch):
    write_board(root, fixture_board())
    extra = _image_url("between.png", (20, 20), (90, 200, 90))
    read = boards.get_board

    def read_then_race(api, ref, headers=None):
        board = read(api, ref, headers)
        # Another writer lands after `set` read the board: an add and a note on #2.
        _ok(_edit(client, [{"op": "add", "urls": [extra]}, {"op": "note", "image": "img-b", "notes": "studio"}],
                  headers=PERSON))
        return board

    monkeypatch.setattr(boards, "get_board", read_then_race)
    board, _removed, previous = boards.update_board(app.api, BOARD_ID, images=[{"image": 1, "weight": 0.5}],
                                                    name="Renamed")
    monkeypatch.setattr(boards, "get_board", read)
    images = board["images"]
    assert [image["url"] for image in images][2:] == [extra]
    assert images[0]["weight"] == 0.5 and images[1]["notes"] == "studio"
    assert board["name"] == "Renamed"
    assert previous["images"][0]["weight"] == 1.0

    # Removing goes by id too: #2 as `set` read it, whatever moved since.
    board, removed, _previous = boards.update_board(app.api, BOARD_ID, remove=[2])
    assert [image["id"] for image in board["images"]][:1] == ["img-a"] and len(board["images"]) == 2
    assert removed == [fixture_board()["images"][1]["url"]]


def test_a_restore_is_checked_like_the_ops(client, root):
    path = write_board(root, fixture_board())
    before = _digest(path)
    a = fixture_board()["images"][0]
    now = {"weight": 1.0, "privateNote": LABEL, "notes": a["notes"]}

    def settings(**values):
        keys = list(values)
        return {"op": "restore", "slices": [{"part": "settings", "image": "img-a", "before": values,
                                             "expect": {key: now.get(key, False) for key in keys}}]}

    for op, words in [
        (settings(weight="heavy"), "weight must be a number"),
        (settings(weight=2), "from 0 to 1"),
        (settings(notes={"a": 1}), "notes must be text"),
        (settings(privateNote="x" * 5000), "longer than 2000"),
        (settings(excluded="yes"), "true or false"),
        ({"op": "restore", "slices": [{"part": "image", "image": "nothere", "before": {**a, "url": "z.png"},
                                       "expect": None}]}, "another image"),
        ({"op": "restore", "slices": [{"part": "image", "image": "img-new",
                                       "before": {"id": "img-new", "weight": 1.0}, "expect": None}]}, "url"),
    ]:
        refused = _edit(client, [op])
        assert refused.status_code == 422, (op, refused.text)
        assert words in refused.json()["detail"], refused.json()["detail"]
    assert _digest(path) == before


def test_a_partial_restore_never_leaves_a_frame_smaller_than_its_cards(client, root):
    write_board(root, fixture_board())
    _ok(_edit(client, [{"op": "frame.create", "id": "f00000000001", "name": "Dither", "x": 0, "y": 400,
                        "w": 200, "h": 200}]))
    extra = _image_url("big.png", (32, 32), (9, 9, 9))
    added = _ok(_edit(client, [{"op": "add", "images": [{"id": "img-c", "url": extra}], "in": "Dither"}]))
    frame = added["board"]["frames"][0]
    assert frame["w"] > 200  # the frame grew to hold the card
    # Someone notes the new image, then the add is undone: its image slice is skipped.
    _ok(_edit(client, [{"op": "note", "image": "img-c", "notes": "keep me"}], headers=PERSON))
    undone = _ok(_edit(client, added["undo"]["ops"]))
    assert [s["part"] for s in undone["applied"][0]["skipped"]] == ["image"]
    board = undone["board"]
    frame = board["frames"][0]
    card = next(image for image in board["images"] if image["id"] == "img-c")["placements"][0]
    assert card["frameId"] == "f00000000001"
    assert frame["x"] <= card["x"] and frame["y"] <= card["y"]
    assert card["x"] + card["w"] <= frame["x"] + frame["w"] and card["y"] + card["h"] <= frame["y"] + frame["h"]


def test_a_private_note_reaches_only_the_persons_tabs(client, root, sent, monkeypatch):
    import main as main_module

    browser: list[dict] = []
    others: list[dict] = []

    async def to_browser(data):
        browser.append(data)

    async def to_others(data):
        others.append(data)

    monkeypatch.setattr(main_module.manager, "broadcast_browser", to_browser)
    monkeypatch.setattr(main_module.manager, "broadcast_others", to_others)
    write_board(root, fixture_board())
    secret = "PAINTERLY ZQXSECRET"
    done = _ok(_edit(client, [{"op": "note", "image": "img-b", "privateNote": secret}], headers=PERSON))
    assert secret in json.dumps(done["undo"])  # the writer's own answer keeps it
    assert not _changes(sent)
    assert browser[-1]["undo"] == done["undo"]
    assert others[-1]["undo"] is None and others[-1]["version"] == done["version"]
    assert secret not in json.dumps(others)

    # Removing an image with a private note (img-a has one) is the same.
    _ok(_edit(client, [{"op": "remove", "images": ["img-a"]}]))
    assert others[-1]["undo"] is None and LABEL not in json.dumps(others)
    # Nothing private: everyone gets the undo.
    _ok(_edit(client, [{"op": "place", "placement": "pl-b", "x": 900, "y": 0}]))
    assert _changes(sent)[-1]["undo"]["ops"]


def test_a_bug_inside_a_batch_is_not_a_missing_board(client, root, monkeypatch):
    from services import moodboard_edits

    write_board(root, fixture_board())

    def broken(*_args, **_kwargs):
        raise KeyError("url")

    monkeypatch.setattr(moodboard_edits, "apply_edits", broken)
    with pytest.raises(RuntimeError, match="a board edit failed"):
        _edit(client, [{"op": "weight", "image": 1, "value": 0.5}])


# -- board fields: the PUT sends baseVersion too --------------------------------

def _studio_put(client, fields):
    """A Studio-style PUT: only the changed fields, against the board as it is."""
    version = client.get(f"/api/moodboards/{BOARD_ID}", headers=PERSON).json()["version"]
    return _ok(client.put(f"/api/moodboards/{BOARD_ID}", json={**fields, "baseVersion": version},
                          headers=PERSON))


def _race_reads(monkeypatch, writes):
    """`set` reads the board, then the next of `writes` lands before it writes.
    Returns the list of boards `set` read."""
    read = boards.get_board
    reads: list[dict] = []
    pending = list(writes)

    def read_then_race(api, ref, headers=None):
        board = read(api, ref, headers)
        reads.append(board)
        if pending:
            pending.pop(0)()
        return board

    monkeypatch.setattr(boards, "get_board", read_then_race)
    return reads


def test_cli_set_direction_racing_a_studio_put_of_another_field_keeps_both(app, client, root, monkeypatch):
    write_board(root, {**fixture_board(), "avoid": ["glare"]})
    reads = _race_reads(monkeypatch, [lambda: _studio_put(client, {"name": "Studio name",
                                                                   "avoid": ["glare", "lens flare"]})])
    board, _removed, previous = boards.update_board(app.api, BOARD_ID, direction="moody dusk",
                                                    avoid_add=["neon"])
    assert len(reads) == 2  # the 409 read the board again
    assert board["direction"] == "moody dusk" and board["name"] == "Studio name"
    # `avoid_add` is a change to the list, so it goes on the list as it is now.
    assert board["avoid"] == ["glare", "lens flare", "neon"]
    # `previous` undoes only what this write changed, from the board it
    # replaced: the Studio's name isn't in it, and its Avoid list comes back.
    undo = previous.pop("undo")
    assert previous == {"direction": "", "avoid": ["glare", "lens flare"]}
    assert undo["ops"][0]["slices"] == [{"part": "fields", "before": previous,
                                         "expect": {"direction": "moody dusk", "avoid": board["avoid"]}}]


def test_cli_set_direction_racing_a_put_of_direction_overwrites_only_through_a_fresh_read(
        app, client, root, monkeypatch):
    # The rule: a field `set` gives an absolute value is re-sent on a fresh
    # baseVersion only while the board still holds the value `set` read for
    # it. Someone else changed that same field since: nothing more is written
    # and the error names it; running `set` again (a fresh read) then wins.
    path = write_board(root, fixture_board())
    _race_reads(monkeypatch, [lambda: _studio_put(client, {"direction": "bright noon", "name": "Studio name"})])
    with pytest.raises(boards.MoodboardError, match="Direction was changed") as raised:
        boards.update_board(app.api, BOARD_ID, direction="moody dusk", mode="world")
    assert "Nothing more was written" in str(raised.value)
    saved = json.loads(path.read_text())
    assert saved["direction"] == "bright noon" and saved["name"] == "Studio name"
    assert saved["mode"] == "look" and saved["version"] == 4

    # The later explicit write wins once it has read the new value.
    board, _removed, previous = boards.update_board(app.api, BOARD_ID, direction="moody dusk")
    assert board["direction"] == "moody dusk" and board["version"] == 5
    assert previous["direction"] == "bright noon"

    # The same value set by both is no conflict.
    _race_reads(monkeypatch, [lambda: _studio_put(client, {"direction": "same words"})])
    board, _removed, _previous = boards.update_board(app.api, BOARD_ID, direction="same words", mode="world")
    assert board["direction"] == "same words" and board["mode"] == "world"


def test_cli_set_refuses_a_field_changed_between_its_read_and_its_image_edits(app, client, root, monkeypatch):
    # The image edits land first (absolute ops); the board they answer holds
    # the Studio's Direction, so the PUT stops and hands back the undo.
    path = write_board(root, fixture_board())
    _race_reads(monkeypatch, [lambda: _studio_put(client, {"direction": "bright noon"})])
    with pytest.raises(boards.MoodboardError, match="Direction was changed") as raised:
        boards.update_board(app.api, BOARD_ID, direction="moody dusk", images=[{"image": 1, "weight": 0.5}])
    assert "image changes were saved" in str(raised.value)
    assert raised.value.previous["images"][0]["weight"] == 1.0
    saved = json.loads(path.read_text())
    assert saved["direction"] == "bright noon" and saved["images"][0]["weight"] == 0.5


def test_cli_set_gives_up_after_three_conflicts(app, client, root, monkeypatch):
    path = write_board(root, fixture_board())
    reads = _race_reads(monkeypatch, [lambda n=n: _studio_put(client, {"name": f"Studio {n}"}) for n in range(5)])
    with pytest.raises(boards.MoodboardError, match="kept changing") as raised:
        boards.update_board(app.api, BOARD_ID, direction="moody dusk")
    assert "3 tries" in str(raised.value) and "Nothing more was written" in str(raised.value)
    assert len(reads) == 3
    saved = json.loads(path.read_text())
    assert saved["direction"] == "" and saved["name"] == "Studio 2"


class _OlderNebula:
    """A Nebula from before checked edits: no /edits route, and a PUT whose
    model forbids keys it doesn't know (baseVersion among them)."""

    def __init__(self, board):
        self.board = board
        self.calls: list[tuple[str, str, dict | None]] = []

    def request(self, method, path, json=None, headers=None, **_kwargs):
        from nebula_api import NebulaAPIError

        self.calls.append((method, path, json))
        if method == "GET":
            return copy.deepcopy(self.board)
        if path.endswith("/edits"):
            raise NebulaAPIError("Not Found", status=404)
        if "baseVersion" in (json or {}):
            raise NebulaAPIError(str([{"type": "extra_forbidden", "loc": ["body", "baseVersion"],
                                       "msg": "Extra inputs are not permitted"}]), status=422)
        self.board = {**self.board, **json, "version": self.board["version"] + 1}
        return copy.deepcopy(self.board)


def test_cli_set_on_an_older_nebula_writes_as_before():
    old = _OlderNebula(fixture_board())
    board, _removed, _previous = boards.update_board(old, BOARD_ID, direction="moody dusk")
    puts = [body for method, _path, body in old.calls if method == "PUT"]
    assert puts == [{"direction": "moody dusk", "baseVersion": 3}, {"direction": "moody dusk"}]
    assert board["direction"] == "moody dusk"

    # With image changes the missing /edits route already says it is older:
    # one whole-list PUT, no baseVersion.
    old = _OlderNebula(fixture_board())
    boards.update_board(old, BOARD_ID, name="Renamed", images=[{"image": 1, "weight": 0.5}])
    puts = [body for method, _path, body in old.calls if method == "PUT"]
    assert len(puts) == 1 and "baseVersion" not in puts[0] and puts[0]["images"][0]["weight"] == 0.5


# -- second review: after a 409, Analyze, undo, a removed image ---------------------

def test_cli_set_after_a_409_with_nothing_left_to_send_returns_the_board_as_it_is(app, client, root, monkeypatch):
    write_board(root, {**fixture_board(), "sendNotes": True})
    _race_reads(monkeypatch, [lambda: _studio_put(client, {"sendNotes": False, "name": "Studio name"})])
    board, _removed, previous = boards.update_board(app.api, BOARD_ID, send_notes=False)
    # The Studio already turned it off: nothing is sent, and the answer is the
    # board as the second read found it, not the first read.
    assert board["version"] == 4 and board["name"] == "Studio name" and board["sendNotes"] is False
    assert previous == {}


def test_undoing_a_set_keeps_later_edits_to_what_it_didnt_change(app, client, root):
    write_board(root, fixture_board())
    _board, _removed, previous = boards.update_board(app.api, BOARD_ID, name="CLI name",
                                                     images=[{"image": 1, "weight": 0.5}])
    undo = previous.pop("undo")
    assert previous == {"name": "Placed", "images": [{"image": "img-a", "weight": 1.0}]}
    assert {item["part"] for item in undo["ops"][0]["slices"]} == {"settings", "card", "fields"}
    previous["undo"] = undo
    # Others edit what the set didn't change: the Direction, #2's weight, #1's notes.
    _studio_put(client, {"direction": "studio dusk"})
    _ok(_edit(client, [{"op": "weight", "image": "img-b", "value": 0.3},
                       {"op": "note", "image": "img-a", "notes": "studio"}], headers=PERSON))
    restored, _removed, _previous = boards.update_board(app.api, BOARD_ID, **previous)
    assert restored["name"] == "Placed" and restored["direction"] == "studio dusk"
    a, b = restored["images"][:2]
    assert a["weight"] == 1.0 and a["notes"] == "studio" and b["weight"] == 0.3


def test_cli_set_on_an_image_someone_took_off_says_so(app, client, root, monkeypatch):
    path = write_board(root, fixture_board())
    _race_reads(monkeypatch, [lambda: _ok(_edit(client, [{"op": "remove", "images": ["img-b"]}],
                                                headers=PERSON))])
    with pytest.raises(boards.MoodboardError) as raised:
        boards.update_board(app.api, BOARD_ID, images=[{"image": 2, "weight": 0.5}], name="X")
    message = str(raised.value)
    assert message.startswith("Image 2 was taken off the board by someone else after this call read it")
    assert "nothing was changed" in message and f"nebula moodboard show {BOARD_ID}" in message
    assert raised.value.previous is None
    saved = json.loads(path.read_text())
    assert saved["name"] == "Placed" and [image["id"] for image in saved["images"]] == ["img-a"]


def _racing_analysis(monkeypatch, edit):
    """Analyze, with `edit` landing while its first run reads the images.
    Returns each run's board weights."""
    from services import moodboard_analysis

    real = moodboard_analysis.analyze_moodboard
    runs: list[list[float]] = []

    def racing(board):
        runs.append([image["weight"] for image in board["images"]])
        if len(runs) == 1:
            edit()
        return real(board)

    monkeypatch.setattr(moodboard_analysis, "analyze_moodboard", racing)
    return runs


def test_analyze_never_saves_an_analysis_of_the_board_before_an_edit(client, root, monkeypatch):
    from services.moodboard_analysis import analysis_is_current
    from services.moodboard_store import MoodboardStore

    write_board(root, fixture_board())
    runs = _racing_analysis(monkeypatch, lambda: MoodboardStore().apply_edits(
        BOARD_ID, [{"op": "weight", "image": "img-a", "value": 0.1}], by="person"))
    done = _ok(client.post(f"/api/moodboards/{BOARD_ID}/analyze"))
    # The weight changed what Analyze reads, so it ran again on the new board.
    assert [weights[0] for weights in runs] == [1.0, 0.1]
    assert done["images"][0]["weight"] == 0.1 and done["version"] == 5
    assert analysis_is_current(done, done["analysis"])


def test_analyze_keeps_its_analysis_over_an_edit_it_doesnt_read(client, root, monkeypatch):
    from services.moodboard_store import MoodboardStore

    write_board(root, fixture_board())
    runs = _racing_analysis(monkeypatch, lambda: MoodboardStore().update(BOARD_ID, name="Renamed", by="person"))
    done = _ok(client.post(f"/api/moodboards/{BOARD_ID}/analyze"))
    assert len(runs) == 1 and done["name"] == "Renamed" and done["analysis"]["palette"]


def test_analyze_on_a_board_that_keeps_changing_is_a_409(client, root, monkeypatch):
    from services import moodboard_analysis
    from services.moodboard_store import MoodboardStore

    path = write_board(root, fixture_board())
    real = moodboard_analysis.analyze_moodboard
    weights = iter([0.1, 0.2, 0.3])

    def racing(board):
        MoodboardStore().apply_edits(BOARD_ID, [{"op": "weight", "image": "img-a", "value": next(weights)}],
                                     by="person")
        return real(board)

    monkeypatch.setattr(moodboard_analysis, "analyze_moodboard", racing)
    refused = client.post(f"/api/moodboards/{BOARD_ID}/analyze")
    assert refused.status_code == 409 and refused.json()["code"] == "version_conflict"
    assert json.loads(path.read_text()).get("analysis") is None


# -- undoing a set skips what changed since (plan section 5.4) ----------------------

def _undo(app, previous):
    """Undo a set the way the CLI and MCP do: its `undo`, with the rest of
    `previous` as what an older Nebula puts back instead."""
    rest = {key: value for key, value in previous.items() if key != "undo"}
    return boards.undo_board(app.api, BOARD_ID, previous["undo"], fallback=rest)


def test_undoing_a_set_skips_a_field_changed_since_and_says_so(app, client, root):
    write_board(root, fixture_board())
    _board, _removed, previous = boards.update_board(app.api, BOARD_ID, direction="cli dusk")
    assert previous["direction"] == "" and previous["undo"]["ops"][0]["op"] == "restore"
    _studio_put(client, {"direction": "studio dawn"})
    board, removed, redo, skipped = _undo(app, previous)
    assert board["direction"] == "studio dawn" and removed == []
    assert skipped == ["Direction changed since, left as is"]
    assert redo == {}  # it put nothing back, so there is nothing to redo
    # The same through update_board(**previous), as an older caller replays it.
    restored, _removed, _previous = boards.update_board(app.api, BOARD_ID, **previous)
    assert restored["direction"] == "studio dawn"


def test_undoing_a_set_restores_its_field_and_keeps_another_changed_since(app, client, root):
    write_board(root, fixture_board())
    _board, _removed, previous = boards.update_board(app.api, BOARD_ID, direction="cli dusk", name="CLI name")
    _studio_put(client, {"avoid": ["glare"], "name": "Studio name"})
    board, _removed, redo, skipped = _undo(app, previous)
    assert board["direction"] == "" and board["avoid"] == ["glare"] and board["name"] == "Studio name"
    assert skipped == ["The name changed since, left as is"]
    # The undo has its own undo: it puts the call's Direction back.
    again, _removed, _redo, skipped = _undo(app, redo)
    assert again["direction"] == "cli dusk" and again["name"] == "Studio name" and skipped == []


def test_undoing_a_set_skips_an_image_setting_changed_since(app, client, root):
    write_board(root, fixture_board())
    _board, _removed, previous = boards.update_board(app.api, BOARD_ID, images=[
        {"image": 1, "weight": 0.5}, {"image": 2, "notes": "cli note"}])
    _ok(_edit(client, [{"op": "weight", "image": "img-a", "value": 0.3}], headers=PERSON))
    board, _removed, _redo, skipped = _undo(app, previous)
    a, b = board["images"]
    assert a["weight"] == 0.3 and b["notes"] == ""
    assert skipped == ["#1's weight changed since, left as is"]


def test_an_untouched_undo_of_a_set_puts_everything_back(app, client, root):
    path = write_board(root, fixture_board())
    before = json.loads(path.read_text())
    _board, removed, previous = boards.update_board(
        app.api, BOARD_ID, name="CLI name", direction="cli dusk", avoid_add=["neon"], images=[
            {"image": 1, "weight": 0.5, "notes": "cli", "excluded": True}], remove=[2])
    assert len(removed) == 1
    board, removed, _redo, skipped = _undo(app, previous)
    assert skipped == [] and removed == []
    for key in ("name", "direction", "avoid", "notes", "mode", "strength"):
        assert board[key] == before[key], key
    assert _layout(board) == _layout(before)


def test_mcp_and_cli_restore_say_what_changed_since(app, client, root, capsys):
    import asyncio

    import mcp_server
    from cli.__main__ import build_parser
    from cli.commands import moodboard as moodboard_cmd

    write_board(root, fixture_board())
    updated = mcp_server.moodboard_update(BOARD_ID, direction="agent dusk", notes="agent notes")
    _studio_put(client, {"direction": "studio dawn"})
    restored = mcp_server.moodboard_update(BOARD_ID, **updated["previous"])
    assert restored["direction"] == "studio dawn" and restored["notes"] == "editorial warmth"
    assert restored["skipped"] == ["Direction changed since, left as is"]
    # The tool takes `previous` as its arguments, `undo` included.
    again = mcp_server.moodboard_update(BOARD_ID, mode="world")
    asyncio.run(mcp_server.mcp.call_tool("moodboard_update", {"board": BOARD_ID, **again["previous"]}))
    assert boards.get_board(app.api, BOARD_ID)["mode"] == "look"

    moodboard_cmd.run(app, build_parser().parse_args(["moodboard", "set", BOARD_ID, "--json", "--name", "CLI"]))
    printed = json.loads(capsys.readouterr().out)
    _studio_put(client, {"name": "Studio"})
    saved = root / "previous.json"
    saved.write_text(json.dumps(printed))
    moodboard_cmd.run(app, build_parser().parse_args(["moodboard", "set", BOARD_ID, "--restore", str(saved)]))
    out = capsys.readouterr().out
    assert "The name changed since, left as is." in out
    assert boards.get_board(app.api, BOARD_ID)["name"] == "Studio"
    moodboard_cmd.run(app, build_parser().parse_args(["moodboard", "set", BOARD_ID, "--json", "--restore",
                                                      str(saved)]))
    assert json.loads(capsys.readouterr().out)["skipped"] == ["The name changed since, left as is"]


def test_an_undo_on_an_older_nebula_puts_back_what_previous_holds():
    old = _OlderNebula({**fixture_board(), "direction": "moody dusk"})
    previous = {"direction": "", "undo": {"ops": [{"op": "restore", "slices": [
        {"part": "fields", "before": {"direction": ""}, "expect": {"direction": "moody dusk"}}]}]}}
    board, _removed, _redo, skipped = boards.undo_board(old, BOARD_ID, previous["undo"],
                                                        fallback={"direction": ""})
    assert board["direction"] == "" and skipped == []
    assert [method for method, _path, _body in old.calls].count("PUT") >= 1
    # An older Nebula's own set hands back no undo (it has no /edits to take one).
    _board, _removed, previous = boards.update_board(_OlderNebula(fixture_board()), BOARD_ID, direction="x")
    assert "undo" not in previous


def test_a_fields_restore_is_checked_and_skips_what_only_the_person_may_turn_on(client, root, person):
    write_board(root, {**fixture_board(), "sendNotes": False, "direction": "now"})
    stale = {"op": "restore", "slices": [{"part": "fields", "before": {"sendNotes": True, "direction": "was"},
                                          "expect": {"sendNotes": False, "direction": "now"}}]}
    done = _ok(_edit(client, [stale], headers=AGENT))
    assert done["board"]["direction"] == "was" and done["board"]["sendNotes"] is False
    assert [s["message"] for s in done["applied"][0]["skipped"]] == [
        "Send notes to generators is the person's to turn on, left as is"]
    # As the person, the same slice turns it on.
    write_board(root, {**fixture_board(), "sendNotes": False, "direction": "now"})
    assert _ok(_edit(client, [stale], headers=PERSON))["board"]["sendNotes"] is True
    bad = {"op": "restore", "slices": [{"part": "fields", "before": {"mode": "nope"}, "expect": {"mode": "look"}}]}
    assert _edit(client, [bad]).status_code == 422
    odd = {"op": "restore", "slices": [{"part": "fields", "before": {"version": 1}, "expect": {"version": 2}}]}
    assert _edit(client, [odd]).status_code == 422
    # Board notes are an analysis input: putting them back clears the analysis.
    write_board(root, {**fixture_board(), "analysis": {"styleBrief": "x", "sourceHash": "y"}, "notes": "new"})
    notes = {"op": "restore", "slices": [{"part": "fields", "before": {"notes": "old"}, "expect": {"notes": "new"}}]}
    assert _ok(_edit(client, [notes]))["board"]["analysis"] is None


def _colors(board):
    from services.moodboard_edits import field_value

    return field_value(board, "pinnedColors"), field_value(board, "colorChoices")["keep"]


def test_undoing_a_keep_out_brings_back_the_keep_anyway_it_dropped(app, client, root):
    write_board(root, {**fixture_board(), "colorChoices": {"keep": ["#ff0000"], "leaveOut": []}})
    board, _removed, previous = boards.update_board(app.api, BOARD_ID, keep_out_colors=["#ff0000"])
    assert _colors(board) == ({"include": [], "exclude": ["#ff0000"]}, [])
    # The PUT dropped the colour from Keep anyway too, so the undo covers that.
    board, _removed, _redo, skipped = _undo(app, previous)
    assert _colors(board) == ({"include": [], "exclude": []}, ["#ff0000"]) and skipped == []


def test_undoing_an_unpin_leaves_a_keep_anyway_chosen_since(app, client, root):
    write_board(root, {**fixture_board(), "pinnedColors": {"include": [], "exclude": ["#ff0000"]}})
    _board, _removed, previous = boards.update_board(app.api, BOARD_ID, unpin_colors=["#ff0000"])
    _studio_put(client, {"colorChoices": {"keep": ["#ff0000"], "leaveOut": []}})
    # Pinning it out again would drop the person's Keep anyway, which the
    # undo doesn't own: the pins are left as they are, and it says so.
    board, _removed, redo, skipped = _undo(app, previous)
    assert _colors(board) == ({"include": [], "exclude": []}, ["#ff0000"])
    assert skipped == ["The pinned colours would undo a colour choice made since, left as is"]
    assert redo == {}


def test_a_redo_reports_only_the_images_it_took_off(app, client, root):
    write_board(root, fixture_board())
    _board, removed, previous = boards.update_board(app.api, BOARD_ID, remove=[2])
    url = removed[0]
    board, removed, redo, _skipped = _undo(app, previous)
    assert removed == [] and [image["id"] for image in board["images"]] == ["img-a", "img-b"]
    # Untouched, the redo takes #2 off again and says so.
    _board, removed, again, _skipped = _undo(app, redo)
    assert removed == [url]
    _undo(app, again)
    # Once the person took it off themselves, the redo has nothing to take off.
    _ok(_edit(client, [{"op": "remove", "images": ["img-b"]}], headers=PERSON))
    board, removed, _redo, skipped = _undo(app, redo)
    assert removed == [] and skipped == [] and [image["id"] for image in board["images"]] == ["img-a"]


def test_the_fields_go_back_last_so_a_brief_is_stamped_with_the_board_as_it_ends_up(app, client, root):
    write_board(root, fixture_board())
    boards.update_board(app.api, BOARD_ID, brief_override="Agent text.")
    _board, _removed, previous = boards.update_board(app.api, BOARD_ID, brief_override="", remove=[2])
    board, *_ = _undo(app, previous)
    assert board["brief"]["styleBrief"] == "Agent text." and board["brief"]["override"]["stale"] is False


def test_mcp_undo_refuses_a_second_change_beside_it(app, client, root):
    import mcp_server

    write_board(root, fixture_board())
    updated = mcp_server.moodboard_update(BOARD_ID, direction="agent dusk")
    with pytest.raises(RuntimeError, match="can't go with remove, avoid_add"):
        mcp_server.moodboard_update(BOARD_ID, **updated["previous"], remove=["1"], avoid_add=["neon"])
    board = boards.get_board(app.api, BOARD_ID)
    assert board["direction"] == "agent dusk" and len(board["images"]) == 2
