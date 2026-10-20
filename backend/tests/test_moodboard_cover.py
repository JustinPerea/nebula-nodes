"""A board's cover: which image it opens on (Justin, 2026-10-20: "Go").

GM found that a board always opened on image #1 and nothing could change it.
The fix is a cover pick, not a reorder: C7 keeps image numbers fixed, and
every "#4" in notes, readings and agent messages depends on that. A board
saves ``coverImageId``, the cover image's own id; its ``thumbnail`` is that
image's url, else #1's, exactly as before. Nothing else moves: no image
changes number, and no notes, weights or analysis change. Removing the cover
image falls back to #1, and undoing the removal brings the cover back.

Presentation only: a generator, the reader and the Moodboard node's bundle
get exactly what they got before a cover was set.
"""
from __future__ import annotations

import asyncio
import copy
import json
from pathlib import Path

import pytest
from fastapi.testclient import TestClient

import moodboard_client as boards
from tests.conftest import PERSON
from tests.test_moodboard_board_model import BOARD_ID, _digest, _image_url, fixture_board, write_board

AGENT = {"X-Nebula-Agent": "Claude Code"}


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
    from services.agent_presence import AgentPresence

    messages: list[dict] = []

    async def capture(data):
        messages.append(data)

    monkeypatch.setattr(main_module, "agent_presence", AgentPresence())
    monkeypatch.setattr(main_module.manager, "broadcast_raw", capture)
    monkeypatch.setattr(main_module.manager, "broadcast_browser", capture)
    monkeypatch.setattr(main_module.manager, "broadcast_others", capture)
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


def three_image_board() -> dict:
    """The board model's fixture plus a third image (a space painting, say)."""
    board = fixture_board()
    c = _image_url("space-3x2.png", (30, 20), (12, 18, 60))
    board["images"].append({
        "id": "img-c", "url": c, "weight": 0.5, "notes": "the nebula", "privateNote": "", "excluded": False,
        "placements": [{"id": "pl-c", "frameId": None, "x": 944, "y": 0, "w": 294, "h": 196, "weight": 0.5,
                        "placedBy": "person", "placedAt": "2026-10-19T00:00:00+00:00"}]})
    return board


def _ok(response) -> dict:
    assert response.status_code == 200, response.text
    return response.json()


def _edit(client, ops, *, base=None, headers=None, say=None):
    body: dict = {"ops": ops}
    if base is not None:
        body["baseVersion"] = base
    if say is not None:
        body["say"] = say
    return client.post(f"/api/moodboards/{BOARD_ID}/edits", json=body, headers=headers or {})


def _get(client) -> dict:
    return _ok(client.get(f"/api/moodboards/{BOARD_ID}", headers=PERSON))


def _unmoved(before: dict, after: dict) -> None:
    """Nothing but the cover moved: every image in its place (C7), with its
    notes, weight, switch and cards, and the analysis kept."""
    keys = ("id", "url", "weight", "notes", "privateNote", "excluded", "placements")
    assert [{k: img.get(k) for k in keys} for img in after["images"]] == \
        [{k: img.get(k) for k in keys} for img in before["images"]]
    assert after["analysis"] == before["analysis"]
    assert after["notes"] == before["notes"] and after["frames"] == before["frames"]


def _said(sent: list[dict]) -> list[str]:
    return [event["say"] for event in sent if event.get("type") == "agentPresence"]


def _board_events(journal) -> list[dict]:
    return journal.read(after=0, kinds={"board"}, limit=100)["events"]


# -- old boards ------------------------------------------------------------------

def test_an_old_board_reads_with_no_cover_and_opens_on_image_1_unwritten(client, root):
    path = write_board(root, three_image_board())
    before = _digest(path)

    board = _get(client)
    assert board["coverImageId"] is None
    assert board["thumbnail"] == board["images"][0]["url"]
    listed = _ok(client.get("/api/moodboards", params={"scope": "global"}))
    assert [(b["coverImageId"], b["thumbnail"]) for b in listed] == [(None, board["images"][0]["url"])]
    # Reading writes nothing: no migration rewrites a saved board.
    assert _digest(path) == before


def test_a_cover_naming_an_image_no_longer_on_the_board_reads_as_none(client, root):
    # An older Nebula keeps board keys it doesn't know but drops the image.
    saved = three_image_board()
    saved["coverImageId"] = "img-gone"
    path = write_board(root, saved)
    before = _digest(path)
    board = _get(client)
    assert board["coverImageId"] is None and board["thumbnail"] == board["images"][0]["url"]
    assert _digest(path) == before


# -- setting it through /edits -----------------------------------------------------

def test_the_cover_op_sets_the_cover_by_number_and_nothing_else_moves(client, root):
    write_board(root, {**three_image_board(), "analysis": {"version": 5, "summary": "kept", "palette": []}})
    before = _get(client)

    answer = _ok(_edit(client, [{"op": "cover", "image": 3}], base=before["version"], headers=PERSON))
    board = answer["board"]
    assert board["coverImageId"] == "img-c"
    assert board["thumbnail"] == board["images"][2]["url"]
    assert board["version"] == before["version"] + 1
    assert answer["applied"] == [{"index": 0, "op": "cover", "status": "applied"}]
    _unmoved(before, board)
    # Saved, and the next read agrees.
    again = _get(client)
    assert again["coverImageId"] == "img-c" and again["thumbnail"] == board["images"][2]["url"]


def test_the_cover_op_takes_an_id_and_null_goes_back_to_image_1(client, root):
    write_board(root, three_image_board())
    board = _ok(_edit(client, [{"op": "cover", "image": "img-b"}], headers=PERSON))["board"]
    assert board["coverImageId"] == "img-b" and board["thumbnail"] == board["images"][1]["url"]

    same = _ok(_edit(client, [{"op": "cover", "image": "img-b"}], headers=PERSON))
    assert same["applied"][0]["status"] == "unchanged" and same["version"] == board["version"]

    cleared = _ok(_edit(client, [{"op": "cover", "image": None}], headers=PERSON))["board"]
    assert cleared["coverImageId"] is None and cleared["thumbnail"] == cleared["images"][0]["url"]


def test_a_cover_that_names_no_image_on_the_board_is_refused_plainly(client, root):
    path = write_board(root, three_image_board())
    before = _digest(path)
    for ref, words in ((9, "no image #9 on this board (it has 3)"), ("img-zz", "no image 'img-zz' on this board")):
        refused = _edit(client, [{"op": "cover", "image": ref}], headers=PERSON)
        assert refused.status_code == 422 and words in refused.json()["detail"], refused.text
    bad_key = _edit(client, [{"op": "cover", "image": 2, "url": "x"}], headers=PERSON)
    assert bad_key.status_code == 422 and "cover takes image" in bad_key.json()["detail"]
    missing = _edit(client, [{"op": "cover"}], headers=PERSON)
    assert missing.status_code == 422 and "cover needs image" in missing.json()["detail"]
    assert _digest(path) == before


def test_a_batch_that_makes_an_image_the_cover_and_removes_it_is_refused(client, root):
    # The CLI and MCP refuse this before sending; a raw batch can't mean both either.
    path = write_board(root, three_image_board())
    before = _digest(path)
    refused = _edit(client, [{"op": "cover", "image": 2}, {"op": "remove", "images": [2]}], headers=PERSON)
    assert refused.status_code == 422, refused.text
    assert ("ops[0] (cover): image #2 can't be the cover and come off the board in one batch"
            in refused.json()["detail"])
    assert _digest(path) == before


def test_a_stale_base_version_refuses_a_cover_change(client, root):
    write_board(root, three_image_board())  # version 3
    edits = _edit(client, [{"op": "cover", "image": 2}], base=2, headers=PERSON)
    assert edits.status_code == 409 and edits.json()["code"] == "version_conflict"
    put = client.put(f"/api/moodboards/{BOARD_ID}", json={"coverImageId": "img-b", "baseVersion": 2}, headers=PERSON)
    assert put.status_code == 409
    assert _get(client)["coverImageId"] is None


def test_a_cover_keeps_the_analysis_and_a_hand_written_brief_current(client, root):
    from services.moodboard_analysis import analyze_moodboard
    from services.moodboard_store import MoodboardStore

    write_board(root, three_image_board())
    store = MoodboardStore()
    analysed = store.update(BOARD_ID, by="person", analysis=analyze_moodboard(store.get(BOARD_ID)),
                            briefOverride={"text": "Deep space, painterly."})
    assert analysed["brief"] if "brief" in analysed else True
    before = _get(client)
    assert before["brief"]["override"] == {"active": True, "stale": False}

    after = _ok(_edit(client, [{"op": "cover", "image": 3}], headers=PERSON))["board"]
    assert after["analysis"] == before["analysis"]
    assert after["brief"] == before["brief"]
    assert after["briefOverride"]["basis"] == before["briefOverride"]["basis"]


def test_a_set_aside_or_weight_0_image_can_be_the_cover_and_keeps_it(client, root):
    write_board(root, three_image_board())
    board = _ok(_edit(client, [{"op": "setAside", "image": 3, "value": True}, {"op": "cover", "image": 3}],
                      headers=PERSON))["board"]
    assert board["coverImageId"] == "img-c" and board["images"][2]["excluded"] is True
    board = _ok(_edit(client, [{"op": "weight", "image": 2, "value": 0}, {"op": "cover", "image": 2}],
                      headers=PERSON))["board"]
    assert board["coverImageId"] == "img-b" and board["images"][1]["weight"] == 0
    # Setting the cover aside later doesn't take it off as cover.
    board = _ok(_edit(client, [{"op": "setAside", "image": 2, "value": True}], headers=PERSON))["board"]
    assert board["coverImageId"] == "img-b"


# -- removing the cover image, and undo ----------------------------------------------

def test_removing_the_cover_image_falls_back_to_1_and_undo_brings_both_back(client, root):
    write_board(root, three_image_board())
    covered = _ok(_edit(client, [{"op": "cover", "image": 3}], headers=PERSON))["board"]

    removed = _ok(_edit(client, [{"op": "remove", "images": [3]}], headers=PERSON))
    board = removed["board"]
    assert board["coverImageId"] is None
    assert board["thumbnail"] == board["images"][0]["url"]
    assert [img["id"] for img in board["images"]] == ["img-a", "img-b"]

    back = _ok(_edit(client, removed["undo"]["ops"], headers=PERSON))
    board = back["board"]
    assert back["applied"][0]["skipped"] == []
    assert [img["id"] for img in board["images"]] == ["img-a", "img-b", "img-c"]
    assert board["coverImageId"] == "img-c" and board["thumbnail"] == covered["images"][2]["url"]
    _unmoved(covered, board)


def test_removing_another_image_keeps_the_cover_on_its_image(client, root):
    write_board(root, three_image_board())
    _ok(_edit(client, [{"op": "cover", "image": 3}], headers=PERSON))
    board = _ok(_edit(client, [{"op": "remove", "images": [1]}], headers=PERSON))["board"]
    # #3 is #2 now (a removal renumbers, C7); the cover follows the image, not the number.
    assert board["coverImageId"] == "img-c" and board["thumbnail"] == board["images"][1]["url"]


def test_undo_of_a_cover_change_puts_the_old_cover_back(client, root):
    write_board(root, three_image_board())
    first = _ok(_edit(client, [{"op": "cover", "image": 2}], headers=PERSON))
    second = _ok(_edit(client, [{"op": "cover", "image": 3}], headers=PERSON))
    assert second["undo"]["ops"][0]["slices"] == [
        {"part": "fields", "before": {"coverImageId": "img-b"}, "expect": {"coverImageId": "img-c"}}]

    board = _ok(_edit(client, second["undo"]["ops"], headers=PERSON))["board"]
    assert board["coverImageId"] == "img-b"
    board = _ok(_edit(client, first["undo"]["ops"], headers=PERSON))["board"]
    assert board["coverImageId"] is None and board["thumbnail"] == board["images"][0]["url"]


def test_undo_leaves_a_cover_someone_changed_since(client, root):
    write_board(root, three_image_board())
    agent = _ok(_edit(client, [{"op": "cover", "image": 2}], headers=AGENT))
    _ok(_edit(client, [{"op": "cover", "image": 3}], headers=PERSON))

    undone = _ok(_edit(client, agent["undo"]["ops"], headers=PERSON))
    assert undone["board"]["coverImageId"] == "img-c"
    assert undone["applied"][0]["skipped"] == [
        {"part": "fields", "field": "coverImageId", "reason": "changed since",
         "message": "The cover changed since, left as is"}]


def test_undoing_a_cover_whose_image_was_removed_since_is_left_as_is(client, root):
    write_board(root, three_image_board())
    _ok(_edit(client, [{"op": "cover", "image": 2}], headers=PERSON))
    second = _ok(_edit(client, [{"op": "cover", "image": 3}], headers=PERSON))
    _ok(_edit(client, [{"op": "remove", "images": ["img-b"]}], headers=PERSON))
    # The cover goes back to img-b, which isn't on the board any more.
    undone = _ok(_edit(client, second["undo"]["ops"], headers=PERSON))
    assert undone["board"]["coverImageId"] == "img-c"
    assert [s["message"] for s in undone["applied"][0]["skipped"]] == ["The cover can't go back, left as is"]


def test_a_restore_slice_with_a_bad_cover_is_refused(client, root):
    write_board(root, three_image_board())
    bad = _edit(client, [{"op": "restore", "slices": [
        {"part": "fields", "before": {"coverImageId": 7}, "expect": {"coverImageId": None}}]}], headers=PERSON)
    assert bad.status_code == 422 and "coverImageId" in bad.json()["detail"]


# -- PUT and create -------------------------------------------------------------------

def test_put_sets_and_clears_the_cover_by_id_and_refuses_an_unknown_one(client, root):
    path = write_board(root, three_image_board())
    before = _get(client)
    board = _ok(client.put(f"/api/moodboards/{BOARD_ID}", headers=PERSON,
                           json={"coverImageId": "img-c", "baseVersion": before["version"]}))
    assert board["coverImageId"] == "img-c" and board["thumbnail"] == board["images"][2]["url"]
    _unmoved(before, board)

    digest = _digest(path)
    refused = client.put(f"/api/moodboards/{BOARD_ID}", headers=PERSON, json={"coverImageId": "img-zz"})
    assert refused.status_code == 422
    assert refused.json()["detail"] == ("coverImageId names no image on this board: use an image's id "
                                        "(GET /api/moodboards/{id} lists them), or null for no cover")
    assert _digest(path) == digest

    cleared = _ok(client.put(f"/api/moodboards/{BOARD_ID}", headers=PERSON, json={"coverImageId": None}))
    assert cleared["coverImageId"] is None and cleared["thumbnail"] == cleared["images"][0]["url"]
    # Leaving it out keeps it.
    _ok(client.put(f"/api/moodboards/{BOARD_ID}", headers=PERSON, json={"coverImageId": "img-b"}))
    kept = _ok(client.put(f"/api/moodboards/{BOARD_ID}", headers=PERSON, json={"name": "Renamed"}))
    assert kept["coverImageId"] == "img-b"


def test_a_put_whose_images_drop_the_cover_falls_back_to_1(client, root):
    write_board(root, three_image_board())
    _ok(_edit(client, [{"op": "cover", "image": 3}], headers=PERSON))
    board = _get(client)
    kept = [{"id": img["id"], "url": img["url"]} for img in board["images"][:2]]
    after = _ok(client.put(f"/api/moodboards/{BOARD_ID}", headers=PERSON, json={"images": kept}))
    assert after["coverImageId"] is None and after["thumbnail"] == after["images"][0]["url"]
    # A PUT can't name a cover it takes off in the same request.
    refused = client.put(f"/api/moodboards/{BOARD_ID}", headers=PERSON,
                         json={"images": kept[:1], "coverImageId": "img-b"})
    assert refused.status_code == 422


def test_create_takes_a_cover_among_its_images(client, root):
    a, b = _image_url("make-a.png", (8, 8), (1, 2, 3)), _image_url("make-b.png", (8, 8), (4, 5, 6))
    made = _ok(client.post("/api/moodboards", headers=PERSON, json={
        "name": "Made", "images": [{"id": "one", "url": a}, {"id": "two", "url": b}], "coverImageId": "two"}))
    assert made["coverImageId"] == "two" and made["thumbnail"] == b
    plain = _ok(client.post("/api/moodboards", headers=PERSON, json={"name": "Plain", "images": [{"url": a}]}))
    assert plain["coverImageId"] is None and plain["thumbnail"] == a
    refused = client.post("/api/moodboards", headers=PERSON, json={
        "name": "Bad", "images": [{"id": "one", "url": a}], "coverImageId": "two"})
    assert refused.status_code == 422 and "coverImageId names no image" in refused.json()["detail"]


# -- journal, Agent log, broadcast ------------------------------------------------------

def test_a_cover_change_is_journaled_said_in_the_agent_log_and_broadcast(client, root, journal, sent):
    write_board(root, three_image_board())
    set_ = _ok(_edit(client, [{"op": "cover", "image": 3}], headers=AGENT))
    cleared = _ok(_edit(client, [{"op": "cover", "image": None}], headers=AGENT))
    _ok(_edit(client, cleared["undo"]["ops"], headers=AGENT))

    events = _board_events(journal)
    assert [e["kind"] for e in events] == ["board.cover"] * 3
    assert events[0]["summary"] == "made #3 the cover of board Placed"
    assert events[0]["data"]["refs"] == [{"number": 3, "id": "img-c"}]
    assert events[1]["summary"] == "set the cover of board Placed back to #1"
    assert _said(sent) == ["Made #3 the cover of board Placed", "Set the cover of board Placed back to #1",
                           "Undo: Made #3 the cover of board Placed"]
    changed = [m for m in sent if m.get("type") == "storedAssetChanged"]
    assert changed[0]["version"] == set_["version"]
    assert set(changed[0]["touched"]["images"]) == {"img-c"}
    assert changed[0]["undo"] == set_["undo"]


def test_the_persons_cover_change_is_journaled_and_not_said(client, root, journal, sent):
    write_board(root, three_image_board())
    _ok(_edit(client, [{"op": "cover", "image": 2}], headers=PERSON))
    assert [e["kind"] for e in _board_events(journal)] == ["board.cover"]
    assert _said(sent) == []


def test_removing_the_cover_says_both(client, root, journal, sent):
    write_board(root, three_image_board())
    _ok(_edit(client, [{"op": "cover", "image": 3}], headers=PERSON))
    _ok(_edit(client, [{"op": "remove", "images": [3]}], headers=AGENT))
    removal = _board_events(journal)[-1]
    assert removal["kind"] == "board.removed" and removal["data"]["kinds"] == ["board.removed", "board.cover"]
    assert _said(sent) == ["Removed #3 from board Placed; the cover is #1 again"]


def test_a_put_cover_change_is_said_too(client, root, journal, sent):
    write_board(root, three_image_board())
    _ok(client.put(f"/api/moodboards/{BOARD_ID}", headers=AGENT, json={"coverImageId": "img-b"}))
    assert _board_events(journal)[-1]["summary"] == "made #2 the cover of board Placed"
    assert _said(sent) == ["Made #2 the cover of board Placed"]


def test_a_cover_picked_with_another_change_isnt_listed_as_that_change(client, root, journal, sent):
    # Review, 2026-10-20: the cover's image leaked into the other change's
    # list ("Removed #1, #2 from board Placed" when only #1 came off).
    write_board(root, three_image_board())
    _ok(_edit(client, [{"op": "remove", "images": [1]}, {"op": "cover", "image": "img-c"}], headers=AGENT))
    _ok(_edit(client, [{"op": "weight", "image": 1, "value": 0.3}, {"op": "cover", "image": None}], headers=AGENT))
    events = _board_events(journal)
    assert [e["summary"] for e in events] == ["removed #1 from board Placed", "resized #1 on board Placed"]
    # The refs still name the cover's image, for whatever lists the change.
    assert events[0]["data"]["refs"] == [{"number": 1, "id": "img-a"}, {"number": 2, "id": "img-c"}]
    assert _said(sent) == ["Removed #1 from board Placed; made #2 the cover",
                           "Resized #1 on board Placed; the cover is #1 again"]


# -- what generators, the reader and the node get: unchanged -----------------------------

def test_the_nodes_bundle_is_the_same_with_any_cover(client, root):
    from handlers.moodboard import handle_moodboard_node
    from models.graph import GraphNode
    from services.moodboard_analysis import analyze_moodboard
    from services.moodboard_store import MoodboardStore

    write_board(root, three_image_board())
    store = MoodboardStore()
    store.update(BOARD_ID, by="person", analysis=analyze_moodboard(store.get(BOARD_ID)))

    def bundle() -> str:
        node = GraphNode(id="mb", definitionId="nebula-moodboard", params={"moodboard": BOARD_ID})
        out = asyncio.run(handle_moodboard_node(node, {}, {}))
        return json.dumps(out, sort_keys=True)

    before = bundle()
    _ok(_edit(client, [{"op": "cover", "image": 3}], headers=PERSON))
    assert bundle() == before
    _ok(_edit(client, [{"op": "setAside", "image": 2, "value": True}, {"op": "cover", "image": 2}], headers=PERSON))
    after_aside = bundle()
    _ok(_edit(client, [{"op": "cover", "image": None}], headers=PERSON))
    assert bundle() == after_aside


def test_the_readers_tasks_are_the_same_with_any_cover(client, root):
    from services import moodboard_reader as reader
    from services.moodboard_store import MoodboardStore

    write_board(root, three_image_board())

    def task() -> str:
        board = MoodboardStore().get(BOARD_ID, laid_out=False)
        targets = reader.select_targets(board)
        images = [reader.encode_image(target.path) for target in targets]
        built = reader.build_read_task(board, targets, images, batch=1, attempt=1)
        return repr((built, [target.ref() for target in targets], reader.phase1_instructions(board, len(targets))))

    before = task()
    _ok(_edit(client, [{"op": "cover", "image": 3}], headers=PERSON))
    assert task() == before


# -- CLI and MCP ------------------------------------------------------------------------

def _cli(app, *argv: str) -> None:
    from cli.__main__ import build_parser
    from cli.commands import moodboard as moodboard_cmd

    moodboard_cmd.run(app, build_parser().parse_args(["moodboard", *argv]))


def test_cli_set_cover_by_number_and_clear_it(app, client, root, capsys):
    write_board(root, three_image_board())
    _cli(app, "set", BOARD_ID, "--cover", "3", "--json")
    printed = json.loads(capsys.readouterr().out)
    assert printed["cover"] == {"number": 3, "id": "img-c"}
    assert printed["previous"]["cover"] == ""
    assert printed["previous"]["undo"]["ops"][0]["slices"] == [
        {"part": "fields", "before": {"coverImageId": None}, "expect": {"coverImageId": "img-c"}}]
    assert _get(client)["coverImageId"] == "img-c"

    _cli(app, "set", BOARD_ID, "--cover", "#2")
    assert "Updated Placed" in capsys.readouterr().out
    assert _get(client)["coverImageId"] == "img-b"
    _cli(app, "set", BOARD_ID, "--cover", "img-c")
    capsys.readouterr()
    assert _get(client)["coverImageId"] == "img-c"

    _cli(app, "set", BOARD_ID, "--clear-cover", "--json")
    printed = json.loads(capsys.readouterr().out)
    assert "cover" not in printed  # none chosen: the board opens on #1
    assert printed["previous"]["cover"] == "img-c"
    assert _get(client)["coverImageId"] is None


def test_cli_restore_puts_the_cover_back(app, client, root, capsys):
    write_board(root, three_image_board())
    _cli(app, "set", BOARD_ID, "--cover", "3", "--json")
    saved = root / "previous.json"
    saved.write_text(capsys.readouterr().out)
    _cli(app, "set", BOARD_ID, "--restore", str(saved))
    capsys.readouterr()
    assert _get(client)["coverImageId"] is None


def test_cli_refuses_a_cover_it_cant_set(app, client, root, capsys):
    path = write_board(root, three_image_board())
    before = _digest(path)
    for argv, words in ((["--cover", "9"], "no image '9' on this board"),
                        (["--cover", "2", "--clear-cover"], "--cover and --clear-cover can't go together"),
                        (["--cover", "2", "--remove", "2"], "can't be the cover and come off the board")):
        with pytest.raises(SystemExit):
            _cli(app, "set", BOARD_ID, *argv)
        assert words in capsys.readouterr().err
    assert _digest(path) == before


def test_cli_show_and_list_say_which_image_is_the_cover(app, client, root, capsys):
    write_board(root, three_image_board())
    _cli(app, "show", BOARD_ID)
    out = capsys.readouterr().out
    assert "  Cover: #1, the first image (none chosen)" in out
    _ok(_edit(client, [{"op": "cover", "image": 3}], headers=PERSON))
    _cli(app, "show", BOARD_ID)
    out = capsys.readouterr().out
    assert "  Cover: #3 (img-c)" in out
    row = next(line for line in out.splitlines() if "img-c" in line and "weight" in line)
    assert row.rstrip().endswith('"the nebula"') and "  cover  " in row
    _cli(app, "list", "--global")
    assert "cover #3" in capsys.readouterr().out
    _cli(app, "show", BOARD_ID, "--json")
    assert json.loads(capsys.readouterr().out)["cover"] == {"number": 3, "id": "img-c"}


def test_mcp_moodboard_update_sets_and_clears_the_cover_through_fastmcp(app, client, root):
    import mcp_server

    write_board(root, three_image_board())
    result = asyncio.run(mcp_server.mcp._tool_manager.call_tool("moodboard_update", {"board": BOARD_ID, "cover": 3}))
    assert result["cover"] == {"number": 3, "id": "img-c"}
    assert _get(client)["coverImageId"] == "img-c"
    # `previous` undoes it, passed back as the same call's arguments.
    asyncio.run(mcp_server.mcp._tool_manager.call_tool("moodboard_update", {"board": BOARD_ID, **result["previous"]}))
    assert _get(client)["coverImageId"] is None

    asyncio.run(mcp_server.mcp._tool_manager.call_tool("moodboard_update", {"board": BOARD_ID, "cover": "img-b"}))
    cleared = asyncio.run(mcp_server.mcp._tool_manager.call_tool("moodboard_update", {"board": BOARD_ID, "cover": ""}))
    assert "cover" not in cleared and _get(client)["coverImageId"] is None
    asyncio.run(mcp_server.mcp._tool_manager.call_tool("moodboard_update", {"board": BOARD_ID, "cover": "#2"}))
    got = asyncio.run(mcp_server.mcp._tool_manager.call_tool("moodboard_get", {"board": BOARD_ID}))
    assert got["cover"] == {"number": 2, "id": "img-b"}


def test_mcp_lists_the_cover_argument(app):
    import mcp_server

    tools = {tool.name: tool for tool in asyncio.run(mcp_server.mcp.list_tools())}
    schema = tools["moodboard_update"].inputSchema["properties"]
    assert "cover" in schema
    assert "cover" in (tools["moodboard_update"].description or "")


def test_an_agent_cover_change_over_mcp_is_its_log_line(app, client, root, sent, monkeypatch):
    import mcp_server

    write_board(root, three_image_board())
    monkeypatch.setattr(mcp_server, "_board_headers", lambda ctx=None: dict(AGENT))
    mcp_server.moodboard_update(BOARD_ID, cover=2)
    assert _said(sent) == ["Made #2 the cover of board Placed"]


def test_the_client_view_has_no_cover_on_a_nebula_without_covers():
    view = boards.brief({"id": "x", "name": "Old", "images": [{"id": "a", "url": "/a.png"}]})
    assert "cover" not in view


def test_update_board_refuses_a_cover_on_a_nebula_without_covers(monkeypatch):
    class Older:
        def request(self, method, path, **kwargs):
            assert method == "GET", "nothing may be sent"
            return copy.deepcopy({"id": "old", "name": "Old", "version": 1,
                                  "images": [{"id": "a", "url": "/a.png"}, {"id": "b", "url": "/b.png"}]})

    with pytest.raises(boards.MoodboardError, match="no board cover"):
        boards.update_board(Older(), "old", cover=2)
