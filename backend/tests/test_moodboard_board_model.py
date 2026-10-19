"""Moodboard board model v2 (item 6, PR1): lossless writes and a layout.

Each image may carry ``placements``: where its card sits on the board
(docs/moodboard-canvas-plan.md section 4). Writes must keep them, and keep
every key a client leaves out. Old boards read with a layout (a grid in
number order) without their files changing; the first write saves it.

``FIXTURE_BOARD`` is a board file as this version saves it, with
placements, written straight to disk: what an older client meets once a
board has a layout.
"""
from __future__ import annotations

import copy
import hashlib
import json
from pathlib import Path

import pytest
from fastapi.testclient import TestClient
from PIL import Image

import moodboard_client as boards
from services.output import OUTPUT_ROOT

# A label no analysis, brief or prompt would ever make up on its own.
LABEL = "ZQXPRIVATE painterly (liked)"
BOARD_ID = "placedboard01"
PLACED_AT = "2026-10-19T00:00:00+00:00"


def _image_url(name: str, size: tuple[int, int], color: tuple[int, int, int]) -> str:
    path = OUTPUT_ROOT / "moodboard-board-model" / name
    path.parent.mkdir(parents=True, exist_ok=True)
    Image.new("RGB", size, color).save(path)
    return f"/api/outputs/{path.resolve().relative_to(OUTPUT_ROOT.resolve()).as_posix()}"


def _placement(pid: str, x: int, y: int, w: int, h: int, weight: float = 1.0) -> dict:
    return {"id": pid, "frameId": None, "x": x, "y": y, "w": w, "h": h, "weight": weight,
            "placedBy": "person", "placedAt": PLACED_AT}


def fixture_board() -> dict:
    """A board with a saved layout: a 16:9 card and a 4:3 card, side by side."""
    from services.moodboard_brief import BRIEF_FIELDS_VERSION

    a = _image_url("wide-16x9.png", (32, 18), (210, 90, 30))
    b = _image_url("photo-4x3.png", (32, 24), (20, 140, 190))
    return {
        "id": BOARD_ID, "name": "Placed", "version": 3, "layoutVersion": 1,
        "images": [
            {"id": "img-a", "url": a, "weight": 1.0, "notes": "the orange accent", "privateNote": LABEL,
             "excluded": False, "placements": [_placement("pl-a", 0, 0, 480, 270)]},
            {"id": "img-b", "url": b, "weight": 1.0, "notes": "", "privateNote": "", "excluded": False,
             "placements": [_placement("pl-b", 504, 0, 416, 312)]},
        ],
        "notes": "editorial warmth", "mode": "look", "strength": 0.7, "analysis": None,
        "direction": "", "avoid": [], "pinnedColors": {"include": [], "exclude": []}, "briefOverride": None,
        "briefVersion": BRIEF_FIELDS_VERSION, "frames": [], "suggestions": [], "readings": {},
        "thumbnail": a, "projectId": None,
        "createdAt": "2026-10-19T00:00:00+00:00", "updatedAt": "2026-10-19T00:00:00+00:00",
    }


def write_board(root: Path, board: dict) -> Path:
    path = root / (board.get("projectId") or "_global") / f"{board['id']}.json"
    path.parent.mkdir(parents=True, exist_ok=True)
    path.write_text(json.dumps(board, ensure_ascii=False, indent=2), encoding="utf-8")
    return path


def _digest(path: Path) -> str:
    return hashlib.sha256(path.read_bytes()).hexdigest()


@pytest.fixture
def root(tmp_path, monkeypatch) -> Path:
    moodboards = tmp_path / "moodboards"
    monkeypatch.setenv("NEBULA_MOODBOARD_ROOT", str(moodboards))
    return moodboards


@pytest.fixture
def client(root, monkeypatch, canvas_project):
    import main as main_module

    async def ignore(data):
        return None

    monkeypatch.setattr(main_module.manager, "broadcast_raw", ignore)
    monkeypatch.setattr(main_module.manager, "broadcast_browser", ignore)
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


def _placements(board: dict) -> dict[str, list[dict]]:
    return {image["id"]: image.get("placements") for image in board["images"]}


# -- fail on main first --------------------------------------------------------

def test_put_keeps_private_note_when_omitted(client, root):
    write_board(root, fixture_board())
    stored = client.get(f"/api/moodboards/{BOARD_ID}").json()
    # A client that doesn't know private notes (or sends only what it changed).
    images = [{key: image[key] for key in ("id", "url", "weight", "notes", "excluded")} for image in stored["images"]]
    images[1]["notes"] = "cool shadows"

    response = client.put(f"/api/moodboards/{BOARD_ID}", json={"images": images})

    assert response.status_code == 200, response.text
    saved = client.get(f"/api/moodboards/{BOARD_ID}").json()
    assert saved["images"][0]["privateNote"] == LABEL
    assert saved["images"][1]["notes"] == "cool shadows"


def test_put_keeps_placements_from_a_stale_client(client, root):
    expected = _placements(fixture_board())
    write_board(root, fixture_board())
    stored = client.get(f"/api/moodboards/{BOARD_ID}").json()

    # A Studio draft loaded before the layout existed: no placements at all.
    old_draft = [{key: image[key] for key in ("id", "url", "weight", "notes", "privateNote", "excluded")}
                 for image in stored["images"]]
    response = client.put(f"/api/moodboards/{BOARD_ID}", json={"images": old_draft, "notes": "one"})
    assert response.status_code == 200, response.text
    assert _placements(client.get(f"/api/moodboards/{BOARD_ID}").json()) == expected

    # A tab that read the board before someone moved a card sends the old spot back.
    stale = copy.deepcopy(stored["images"])
    stale[0]["placements"][0].update(x=9000, y=9000)
    response = client.put(f"/api/moodboards/{BOARD_ID}", json={"images": stale, "notes": "two"})
    assert response.status_code == 200, response.text
    assert _placements(client.get(f"/api/moodboards/{BOARD_ID}").json()) == expected


def test_cli_set_on_a_board_with_placements(app, root):
    expected = _placements(fixture_board())
    write_board(root, fixture_board())

    updated, _, _ = boards.update_board(app.api, BOARD_ID, images=[{"image": 2, "notes": "cool shadows"}])

    assert updated["images"][1]["notes"] == "cool shadows"
    assert updated["images"][0]["privateNote"] == LABEL
    assert _placements(updated) == expected


def test_cli_layout_change_keeps_analysis():
    """`nebula moodboard set` clears the analysis only when what it reads
    changed (`_steering`). A card moved or resized changes no steering key,
    so a layout change must never count as a content change."""
    before = fixture_board()["images"]
    after = copy.deepcopy(before)
    after[0]["placements"][0].update(x=1200, y=-300, w=240, h=135, weight=0.25)
    after[1]["placements"].append(_placement("pl-b2", 0, 400, 416, 312))

    assert boards._steering(after) == boards._steering(before)
    # Changing a steering key still counts.
    after[1]["notes"] = "cool shadows"
    assert boards._steering(after) != boards._steering(before)


@pytest.mark.asyncio
async def test_bundle_images_have_only_output_keys(root):
    from handlers.moodboard import handle_moodboard_node
    from models.graph import GraphNode

    board = fixture_board()
    board["images"][1]["excluded"] = True
    board["images"].append({"id": "img-c", "url": board["images"][0]["url"], "weight": 0.5, "notes": "",
                            "privateNote": "", "excluded": False, "placements": [_placement("pl-c", 0, 300, 339, 191, 0.5)],
                            # A key a later Nebula may add: never an output either.
                            "futureKey": {"x": 1}})
    write_board(root, board)

    result = await handle_moodboard_node(
        GraphNode(id="n1", definitionId="nebula-moodboard", params={"moodboard": BOARD_ID}), {}, {})

    images = result["moodboard"]["value"]["images"]
    assert [image["id"] for image in images] == ["img-a", "img-c"]
    assert all(set(image) == {"id", "url", "weight", "notes", "excluded"} for image in images)


# -- old boards: a layout on read, nothing written --------------------------------

# Sizes (w, h) and colours of an old board's images, in number order: two
# rows of the grid. Image 3 has weight 0, image 4 is excluded, image 8 is a
# link Nebula can't read (it lays out at 4:3).
OLD_IMAGES = [((32, 18), 1.0), ((24, 32), 0.5), ((32, 32), 0.0), ((18, 32), 1.0), ((32, 24), 0.4),
              ((40, 10), 0.25), ((32, 18), 1.0), (None, 1.0)]


def old_board(name: str = "Old") -> dict:
    """A board as Nebula saved it before layouts: no placements, no
    layoutVersion, no frames."""
    images = []
    for index, (size, weight) in enumerate(OLD_IMAGES):
        url = (_image_url(f"old-{index}.png", size, (40 * index, 90, 200 - 20 * index)) if size
               else "https://images.example.com/far-away.png")
        images.append({"id": f"old{index:02d}", "url": url, "weight": weight, "notes": "", "privateNote": "",
                       "excluded": index == 3})
    return {"id": "oldboard0001", "name": name, "version": 4, "images": images, "notes": "", "mode": "look",
            "strength": 0.7, "analysis": None, "direction": "", "avoid": [],
            "pinnedColors": {"include": [], "exclude": []}, "briefOverride": None, "briefVersion": 1,
            "thumbnail": images[0]["url"], "projectId": None,
            "createdAt": "2026-09-01T00:00:00+00:00", "updatedAt": "2026-09-02T00:00:00+00:00"}


def _rects(board: dict) -> list[tuple[int, int, int, int]]:
    return [(p["x"], p["y"], p["w"], p["h"]) for image in board["images"] for p in image["placements"]]


def _overlaps(a, b, gap: int = 0) -> bool:
    return (a[0] < b[0] + b[2] + gap and b[0] < a[0] + a[2] + gap
            and a[1] < b[1] + b[3] + gap and b[1] < a[1] + a[3] + gap)


def test_an_old_board_reads_with_a_grid_in_number_order(root):
    from services.moodboard_layout import FULL_AREA, MIN_WEIGHT
    from services.moodboard_store import MoodboardStore

    path = write_board(root, old_board())
    before = _digest(path)
    board = MoodboardStore().get("oldboard0001")

    assert "layoutVersion" not in board and board["frames"] == [] and board["suggestions"] == []
    assert board["readings"] == {}
    cards = [image["placements"] for image in board["images"]]
    assert all(len(c) == 1 and c[0]["frameId"] is None and c[0]["placedBy"] == "person" for c in cards)
    rects = _rects(board)
    # Six to a row, in number order; nothing overlaps (40 px between cells).
    first, second = rects[:6], rects[6:]
    assert all(a[0] < b[0] for a, b in zip(first, first[1:]))
    assert all(a[1] + a[3] <= b[1] - 40 for a in first for b in second)
    assert second[0][0] < second[1][0]
    assert not any(_overlaps(a, b, 39) for i, a in enumerate(rects) for b in rects[i + 1:])
    # Area is the weight (weight 0 shows at full size, MIN_WEIGHT is the floor); aspect is the file's.
    for (size, weight), (x, y, w, h), card in zip(OLD_IMAGES, rects, cards):
        shown = 1.0 if weight == 0 else max(weight, MIN_WEIGHT)
        assert card[0]["weight"] == shown
        assert abs(w * h - shown * FULL_AREA) <= w + h
        aspect = size[0] / size[1] if size else 4 / 3
        assert abs(w / h - aspect) < 0.02
    # Reading wrote nothing.
    assert _digest(path) == before


def test_the_layout_is_the_same_on_every_read(client, root):
    from services.moodboard_store import MoodboardStore

    write_board(root, old_board())
    one = MoodboardStore().get("oldboard0001")
    two = client.get("/api/moodboards/oldboard0001").json()
    assert _placements(one) == _placements(two)


def test_reading_an_old_board_everywhere_leaves_its_file_unchanged(app, client, root):
    import mcp_server
    from services.moodboard_store import MoodboardStore

    path = write_board(root, old_board("Old by name"))
    before = _digest(path)
    MoodboardStore().get("oldboard0001")
    MoodboardStore().list("global")
    client.get("/api/moodboards/oldboard0001")
    client.get("/api/moodboards?scope=global")
    boards.get_board(app.api, "Old by name")
    mcp_server.moodboard_get("Old by name")

    assert _digest(path) == before
    assert sorted(p.name for p in path.parent.iterdir()) == [path.name]


def test_an_old_board_keeps_its_hash_and_brief_basis(root):
    from services.moodboard_analysis import analyze_moodboard, analysis_is_current, source_hash
    from services.moodboard_brief import brief_basis
    from services.moodboard_store import MoodboardStore

    raw = old_board()
    raw["analysis"] = analyze_moodboard(raw)
    write_board(root, raw)
    store = MoodboardStore()

    read = store.get("oldboard0001")
    assert source_hash(read) == source_hash(raw) and brief_basis(read) == brief_basis(raw)
    assert analysis_is_current(read, read["analysis"])

    # The first write (a rename) saves the layout it read: nothing moves, and
    # the analysis still describes the board.
    saved = store.update("oldboard0001", name="Renamed")
    on_disk = json.loads((root / "_global" / "oldboard0001.json").read_text(encoding="utf-8"))
    assert on_disk["layoutVersion"] == 1 and saved["layoutVersion"] == 1
    assert _placements(on_disk) == _placements(read)
    assert source_hash(on_disk) == source_hash(raw) and brief_basis(on_disk) == brief_basis(raw)
    assert analysis_is_current(on_disk, on_disk["analysis"])
    assert _placements(store.get("oldboard0001")) == _placements(read)


def test_cli_add_on_an_old_board_saves_the_grid_with_the_new_image_last(app, root, tmp_path):
    from services.moodboard_layout import FULL_AREA, PLACE_GAP
    from services.moodboard_store import MoodboardStore

    write_board(root, old_board())
    read = MoodboardStore().get("oldboard0001")
    png = tmp_path / "new.png"
    Image.new("RGB", (32, 18), (10, 200, 10)).save(png)

    board, added, _ = boards.add_to_board(app.api, "oldboard0001", [str(png)])

    assert added == 1
    assert _placements({"images": board["images"][:-1]}) == _placements(read)
    card = board["images"][-1]["placements"][0]
    last = read["images"][-1]["placements"][0]
    # Right after the last card, in its row (it has room), 24 px away.
    assert (card["x"], card["y"]) == (last["x"] + last["w"] + PLACE_GAP, last["y"])
    assert (card["w"], card["h"]) == (480, 270) and card["w"] * card["h"] == FULL_AREA
    assert card["placedBy"] == "agent" and card["frameId"] is None
    rects = _rects(board)
    assert not any(_overlaps(rects[-1], other, PLACE_GAP - 1) for other in rects[:-1])
    on_disk = json.loads((root / "_global" / "oldboard0001.json").read_text(encoding="utf-8"))
    assert on_disk["layoutVersion"] == 1 and _placements(on_disk) == _placements(board)


def test_new_images_fill_the_row_then_start_a_new_one(client):
    from services.moodboard_layout import PLACE_GAP, ROW_LIMIT

    urls = [_image_url(f"row-{n}.png", (32, 18), (n * 20, 50, 50)) for n in range(9)]
    created = client.post("/api/moodboards", json={"name": "Rows", "images": [{"url": u} for u in urls[:1]]}).json()
    for count in range(2, 10):
        images = [{key: image[key] for key in ("id", "url")} for image in created["images"]]
        created = client.put(f"/api/moodboards/{created['id']}",
                             json={"images": images + [{"url": urls[count - 1]}]}).json()

    rects = _rects(created)
    assert rects[0] == (0, 0, 480, 270)
    in_row = [r for r in rects if r[1] == 0]
    assert len(in_row) == (ROW_LIMIT + PLACE_GAP) // (480 + PLACE_GAP)
    assert all(b[0] == a[0] + a[2] + PLACE_GAP for a, b in zip(in_row, in_row[1:]))
    next_row = rects[len(in_row)]
    assert next_row == (0, 270 + PLACE_GAP, 480, 270)
    assert not any(_overlaps(a, b, PLACE_GAP - 1) for i, a in enumerate(rects) for b in rects[i + 1:])


# -- what a write may and may not set ---------------------------------------------

def test_a_new_image_takes_the_spot_it_asks_for(client, person):
    from services.moodboard_layout import FULL_AREA

    url = _image_url("asked.png", (32, 24), (90, 90, 200))
    created = client.post("/api/moodboards", headers=person.headers, json={"name": "Drop", "images": [
        {"url": url, "placements": [{"x": 300.4, "y": -120, "w": 999, "h": 1, "placedBy": "analyze"}]},
        {"url": url, "weight": 0.5, "placements": [{"x": 0, "y": 900, "weight": 1.0}]}]})
    assert created.status_code == 200, created.text
    first, second = (image["placements"][0] for image in created.json()["images"])
    # Where it asked; the size is written from the weight and the image's 4:3.
    assert (first["x"], first["y"]) == (300, -120)
    assert abs(first["w"] / first["h"] - 4 / 3) < 0.01
    assert abs(first["w"] * first["h"] - first["weight"] * FULL_AREA) <= first["w"] + first["h"]
    # Who placed it is the server's call, not the client's.
    assert first["placedBy"] == "person"
    # With no weight sent, the image weighs what its card shows; with one, the card follows it.
    assert created.json()["images"][0]["weight"] == first["weight"]
    assert second["weight"] == 0.5 and created.json()["images"][1]["weight"] == 0.5


@pytest.mark.parametrize("placements, message", [
    ([{"x": 0, "y": 0, "frameId": "abcdefabcdef"}], "frameId names no frame"),
    ([{"x": 0, "y": 0}] * 9, "1 to 8 placements"),
    ([{"x": 0, "y": 0}, {"x": 9, "y": 9}], "at most one loose card"),
    ([{"x": 2_000_000, "y": 0}], "within 1,000,000 px"),
    ([{"x": 0, "y": 0, "id": "pl-a"}], "already a card on this board"),
])
def test_a_new_image_asking_for_a_bad_spot_is_refused(client, root, placements, message):
    write_board(root, fixture_board())
    images = client.get(f"/api/moodboards/{BOARD_ID}").json()["images"]
    response = client.put(f"/api/moodboards/{BOARD_ID}", json={
        "images": [*images, {"url": images[0]["url"], "placements": placements}]})
    assert response.status_code == 422 and message in response.json()["detail"], response.text


@pytest.mark.parametrize("field, value", [("frames", []), ("suggestions", []), ("readings", {}),
                                          ("layoutVersion", 1), ("lastRead", None)])
def test_put_and_create_refuse_the_board_layout(client, root, field, value):
    write_board(root, fixture_board())
    for response in (client.put(f"/api/moodboards/{BOARD_ID}", json={"name": "x", field: value}),
                     client.post("/api/moodboards", json={"name": "x", field: value})):
        assert response.status_code == 422
        assert response.json()["detail"].startswith(f"{field} can't be set with PUT")
    assert client.get(f"/api/moodboards/{BOARD_ID}").json()["name"] == "Placed"


def test_studio_sending_back_what_it_read_changes_nothing_but_the_edit(client, root):
    write_board(root, fixture_board())
    read = client.get(f"/api/moodboards/{BOARD_ID}").json()
    draft = {key: read[key] for key in ("name", "notes", "mode", "strength", "analysis", "direction", "avoid",
                                        "pinnedColors", "projectId")}
    draft["images"] = [{**image} for image in read["images"]]
    draft["images"][0]["privateNote"] = "edited"
    response = client.put(f"/api/moodboards/{BOARD_ID}", json=draft)
    assert response.status_code == 200, response.text
    saved = response.json()
    assert saved["images"][0]["privateNote"] == "edited"
    assert _placements(saved) == _placements(read)


def test_a_weight_set_by_the_cli_resizes_the_card(app, root):
    from services.moodboard_layout import FULL_AREA

    write_board(root, fixture_board())
    updated, _, _ = boards.update_board(app.api, BOARD_ID, images=[{"image": 1, "weight": 0.25}])

    image = updated["images"][0]
    card = image["placements"][0]
    assert image["weight"] == 0.25 and card["weight"] == 0.25
    assert (card["x"], card["y"]) == (0, 0) and (card["w"], card["h"]) == (240, 135)
    assert card["w"] * card["h"] == 0.25 * FULL_AREA
    # The other image's card is untouched.
    assert updated["images"][1]["placements"] == fixture_board()["images"][1]["placements"]


def test_an_image_left_out_is_removed_with_its_cards(client, root):
    write_board(root, fixture_board())
    images = client.get(f"/api/moodboards/{BOARD_ID}").json()["images"]
    saved = client.put(f"/api/moodboards/{BOARD_ID}", json={"images": images[1:]}).json()
    assert [image["id"] for image in saved["images"]] == ["img-b"]
    assert saved["thumbnail"] == images[1]["url"]


def test_a_photo_turned_by_exif_lays_out_upright(root):
    from services.moodboard_store import MoodboardStore

    path = OUTPUT_ROOT / "moodboard-board-model" / "turned.jpg"
    path.parent.mkdir(parents=True, exist_ok=True)
    exif = Image.Exif()
    exif[0x0112] = 6  # stored landscape, shown portrait
    Image.new("RGB", (32, 18), (120, 40, 40)).save(path, exif=exif)
    board = old_board()
    board["images"] = [{**board["images"][0], "url": f"/api/outputs/moodboard-board-model/{path.name}"}]
    write_board(root, board)

    card = MoodboardStore().get("oldboard0001")["images"][0]["placements"][0]
    assert card["h"] > card["w"]


# -- every other writer keeps the layout --------------------------------------------

def test_trash_and_restore_keep_the_file_as_it_was(client, root):
    path = write_board(root, fixture_board())
    before = path.read_bytes()
    assert client.delete(f"/api/moodboards/{BOARD_ID}").status_code == 200
    assert client.post(f"/api/trash/moodboard/{BOARD_ID}/restore").status_code == 200
    assert path.read_bytes() == before


def test_a_move_keeps_the_layout_and_writes_none_for_an_old_board(client, root, canvas_project):
    placed = write_board(root, fixture_board())
    old = write_board(root, old_board())
    for path, board_id in ((placed, BOARD_ID), (old, "oldboard0001")):
        before = json.loads(path.read_text(encoding="utf-8"))
        response = client.post(f"/api/moodboards/{board_id}/move", json={"projectId": canvas_project})
        assert response.status_code == 200, response.text
        after = json.loads((root / canvas_project / f"{board_id}.json").read_text(encoding="utf-8"))
        assert after == {**before, "projectId": canvas_project}
        assert response.json()["asset"]["images"][0]["placements"]


def test_the_brief_migration_keeps_the_layout(root):
    from services.moodboard_store import migrate_brief_fields

    board = fixture_board()
    del board["briefVersion"]
    path = write_board(root, board)
    migrate_brief_fields()
    migrated = json.loads(path.read_text(encoding="utf-8"))
    assert migrated["briefVersion"] and _placements(migrated) == _placements(board)
    assert migrated["layoutVersion"] == 1 and migrated["frames"] == []


def test_an_analysis_save_keeps_the_layout(client, root):
    write_board(root, fixture_board())
    read = client.get(f"/api/moodboards/{BOARD_ID}").json()
    analyzed = client.post(f"/api/moodboards/{BOARD_ID}/analyze").json()
    assert analyzed["analysis"]["palette"]
    assert _placements(analyzed) == _placements(read)
    assert analyzed["images"][0]["privateNote"] == LABEL


# -- what agents see -----------------------------------------------------------------

def test_show_json_and_moodboard_get_list_the_layout(app, root, capsys):
    import mcp_server
    from cli.__main__ import build_parser
    from cli.commands import moodboard as moodboard_cmd

    write_board(root, old_board("Shown"))
    moodboard_cmd.run(app, build_parser().parse_args(["moodboard", "show", "Shown", "--json"]))
    shown = json.loads(capsys.readouterr().out)
    got = mcp_server.moodboard_get("Shown")

    for view in (shown, got):
        assert view["frames"] == []
        assert all(len(image["placements"]) == 1 for image in view["images"])
        assert [image["number"] for image in view["images"]] == list(range(1, len(OLD_IMAGES) + 1))
    # Lists stay short: no layout.
    assert "placements" not in mcp_server.moodboard_list(project_id="none")[0]["images"][0]


# -- the aspect cache ----------------------------------------------------------------

def test_an_image_aspect_is_read_once_until_its_file_changes(monkeypatch):
    import os

    import services.moodboard_analysis as analysis_module
    from services import moodboard_layout as layout

    url = _image_url("cached.png", (32, 18), (1, 2, 3))
    layout.clear_aspect_cache()
    real = analysis_module.resolve_moodboard_image_path
    calls = []
    monkeypatch.setattr(analysis_module, "resolve_moodboard_image_path", lambda value: calls.append(value) or real(value))

    assert layout.file_aspect(url) == 32 / 18
    assert layout.file_aspect(url) == 32 / 18
    assert len(calls) == 1, "a second read of the same file skips the path check"

    # Another agent workspace runs the check again (its answer depends on it).
    monkeypatch.setattr("services.file_access.access_scope", lambda: "/some/workspace")
    assert layout.file_aspect(url) == 32 / 18 and len(calls) == 2
    monkeypatch.undo()
    monkeypatch.setattr(analysis_module, "resolve_moodboard_image_path", lambda value: calls.append(value) or real(value))

    # A changed file is checked and read again.
    path = OUTPUT_ROOT / "moodboard-board-model" / "cached.png"
    Image.new("RGB", (20, 40), (1, 2, 3)).save(path)
    os.utime(path, ns=(path.stat().st_atime_ns, path.stat().st_mtime_ns + 1_000_000))
    assert layout.file_aspect(url) == 0.5 and len(calls) == 3

    # A second hard link is refused by the path check, so a cached answer isn't reused.
    link = path.with_name("cached-link.png")
    os.link(path, link)
    try:
        assert layout.file_aspect(url) is None and len(calls) == 4
    finally:
        link.unlink()
