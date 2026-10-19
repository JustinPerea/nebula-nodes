from __future__ import annotations

import pytest
from PIL import Image

from handlers.moodboard import handle_moodboard_node
from models.graph import GraphNode
from services.moodboard_analysis import analyze_moodboard
from services.moodboard_store import MoodboardStore
from services.output import OUTPUT_ROOT


def _write_test_image(name: str, color: tuple[int, int, int]) -> str:
    path = OUTPUT_ROOT / "moodboard-tests" / name
    path.parent.mkdir(parents=True, exist_ok=True)
    Image.new("RGB", (32, 24), color).save(path)
    rel = path.resolve().relative_to(OUTPUT_ROOT.resolve())
    return f"/api/outputs/{rel.as_posix()}"


def test_analyze_moodboard_extracts_palette_and_brief() -> None:
    url = _write_test_image("warm.png", (210, 90, 30))
    moodboard = {
        "id": "m1",
        "name": "Warm board",
        "images": [{"id": "i1", "url": url, "weight": 1.0, "notes": "", "excluded": False}],
        "notes": "editorial warmth",
        "mode": "look",
        "strength": 0.75,
    }

    analysis = analyze_moodboard(moodboard)

    assert analysis["palette"]
    assert analysis["representativeImages"] == [url]
    assert "Warm board" in analysis["styleBrief"]
    assert analysis["providerHints"]["krea"]["strategy"] == "image_style_references"


@pytest.mark.asyncio
async def test_moodboard_node_emits_typed_bundle(tmp_path, monkeypatch) -> None:
    monkeypatch.setenv("NEBULA_MOODBOARD_ROOT", str(tmp_path))
    url = _write_test_image("bundle.png", (20, 140, 190))
    created = MoodboardStore().create(
        name="Blue board",
        images=[{"url": url}],
        notes="cool glass",
        mode="world",
    )

    result = await handle_moodboard_node(
        GraphNode(id="n1", definitionId="nebula-moodboard", params={"moodboard": created["id"]}),
        {},
        {},
    )

    assert result["moodboard"]["type"] == "Moodboard"
    assert result["moodboard"]["value"]["kind"] == "nebula_moodboard"
    assert result["style_brief"]["type"] == "Text"
    assert result["representative_images"]["value"] == [url]


@pytest.mark.asyncio
async def test_moodboard_node_without_a_board_says_how_to_choose_one(tmp_path, monkeypatch) -> None:
    monkeypatch.setenv("NEBULA_MOODBOARD_ROOT", str(tmp_path))
    with pytest.raises(ValueError, match=r"No moodboard chosen: set moodboard to a board id \(GET /api/moodboards"):
        await handle_moodboard_node(GraphNode(id="n1", definitionId="nebula-moodboard", params={}), {}, {})


@pytest.mark.asyncio
@pytest.mark.parametrize("board_id", ["4df26f93ff63", "not an id/.."])
async def test_moodboard_node_names_a_missing_board(tmp_path, monkeypatch, board_id) -> None:
    monkeypatch.setenv("NEBULA_MOODBOARD_ROOT", str(tmp_path))
    with pytest.raises(ValueError, match="not found; it may have been deleted"):
        await handle_moodboard_node(
            GraphNode(id="n1", definitionId="nebula-moodboard", params={"moodboard": board_id}), {}, {})


def _node(board_id: str) -> GraphNode:
    return GraphNode(id="n1", definitionId="nebula-moodboard", params={"moodboard": board_id})


@pytest.mark.asyncio
async def test_moodboard_node_analyzes_again_when_the_board_changed(tmp_path, monkeypatch) -> None:
    monkeypatch.setenv("NEBULA_MOODBOARD_ROOT", str(tmp_path))
    first, second = _write_test_image("first.png", (30, 40, 90)), _write_test_image("second.png", (235, 225, 205))
    store = MoodboardStore()
    board = store.create(name="Board", images=[{"url": first, "weight": 1.0}, {"url": second, "weight": 0.3}])
    store.update(board["id"], analysis=analyze_moodboard(store.get(board["id"])))
    # An agent re-weights the board through the API and doesn't analyze it again.
    store.update(board["id"], images=[{"url": first, "weight": 0.3}, {"url": second, "weight": 1.0}])

    result = await handle_moodboard_node(_node(board["id"]), {}, {})

    assert result["representative_images"]["value"] == [second, first]
    bundle = result["moodboard"]["value"]
    assert bundle["analysis"]["warnings"][-1].startswith("The board changed after its saved analysis")
    assert bundle["palette"] == bundle["analysis"]["palette"] and bundle["accents"] == []
    assert store.get(board["id"])["analysis"]["representativeImages"] == [first, second]


@pytest.mark.asyncio
async def test_moodboard_node_keeps_a_current_analysis_and_its_hand_edits(tmp_path, monkeypatch) -> None:
    monkeypatch.setenv("NEBULA_MOODBOARD_ROOT", str(tmp_path))
    store = MoodboardStore()
    board = store.create(name="Board", images=[{"url": _write_test_image("kept.png", (210, 90, 30))}])
    store.update(board["id"], analysis=analyze_moodboard(store.get(board["id"])),
                 briefOverride={"text": "Edited by hand"})
    store.update(board["id"], name="Renamed")

    def must_not_run(moodboard):
        raise AssertionError("a current analysis is used as saved")

    monkeypatch.setattr("handlers.moodboard.analyze_moodboard", must_not_run)
    result = await handle_moodboard_node(_node(board["id"]), {}, {})

    assert result["style_brief"]["value"] == "Edited by hand"
    # A rename isn't a change to the board, so the edit isn't flagged.
    assert result["moodboard"]["value"]["briefOverride"] == {"active": True, "stale": False}


@pytest.mark.asyncio
async def test_moodboard_node_analyzes_off_the_event_loop(tmp_path, monkeypatch) -> None:
    import asyncio

    monkeypatch.setenv("NEBULA_MOODBOARD_ROOT", str(tmp_path))
    board = MoodboardStore().create(name="Board", images=[{"url": _write_test_image("loop.png", (20, 140, 190))}])
    loops = []

    def record(moodboard):
        try:
            loops.append(asyncio.get_running_loop())
        except RuntimeError:
            loops.append(None)
        return analyze_moodboard(moodboard)

    monkeypatch.setattr("handlers.moodboard.analyze_moodboard", record)
    await handle_moodboard_node(_node(board["id"]), {}, {})

    assert loops == [None]


# -- gap 18: what the bundle sends (notes opt-in, left-out colours) -------------

def _clash_board(tmp_path, monkeypatch, **fields):
    """A board of orange and blue images whose Avoid list names orange, with
    board and image notes. Analyzed and saved, so the node uses the analysis."""
    monkeypatch.setenv("NEBULA_MOODBOARD_ROOT", str(tmp_path))
    store = MoodboardStore()
    orange, blue = _write_test_image("clash-orange.png", (240, 110, 30)), _write_test_image("clash-blue.png",
                                                                                              (20, 60, 200))
    board = store.create(name="Clash board", notes="liquid glass panels, quiet type",
                         images=[{"url": orange, "notes": "the orange accent"}, {"url": blue}],
                         avoid=["orange flowers"], **fields)
    store.update(board["id"], analysis=analyze_moodboard(store.get(board["id"])))
    return store.get(board["id"])


@pytest.mark.asyncio
async def test_the_bundle_carries_no_notes_and_no_left_out_colour(tmp_path, monkeypatch) -> None:
    board = _clash_board(tmp_path, monkeypatch)
    analysis = board["analysis"]
    orange = next(c["hex"] for c in analysis["colors"] if int(c["hex"][1:3], 16) > 200)
    result = await handle_moodboard_node(_node(board["id"]), {}, {})
    bundle = result["moodboard"]["value"]

    assert bundle["notesSent"] is False
    assert bundle["notes"] == "" and [image["notes"] for image in bundle["images"]] == ["", ""]
    view = bundle["analysis"]
    assert "liquid" not in view["keywords"] and "glass" not in view["keywords"]
    assert "Notes emphasize" not in view["summary"] and "liquid" not in view["summary"]
    assert "liquid" not in view["tasteProfile"] and "liquid" not in view["styleBrief"]
    assert view["subjectBias"] == [] and all(item.get("notes", "") == "" for item in view["images"])
    # The orange the person avoids is out of everything generators read.
    assert orange in [item["hex"] for item in bundle["leftOut"]]
    assert orange not in bundle["palette"] and orange not in result["palette"]["value"]
    assert bundle["providerHints"]["generic"]["palette"] == bundle["palette"]
    assert bundle["providerHints"]["generic"]["accents"] == bundle["accents"]
    for text in (bundle["styleBrief"], view["styleBrief"], view["summary"], view["tasteProfile"],
                 bundle["providerHints"]["generic"]["promptSuffix"]):
        assert orange not in text and "liquid" not in text
    assert {"leftOut", "mayClash", "pinnedClashes", "notesSent"} <= set(bundle)
    # The saved analysis is left as it was.
    assert "liquid" in MoodboardStore().get(board["id"])["analysis"]["keywords"]


@pytest.mark.asyncio
async def test_the_node_can_send_notes_or_hold_them_back(tmp_path, monkeypatch) -> None:
    board = _clash_board(tmp_path, monkeypatch)

    def node(choice):
        return GraphNode(id="n1", definitionId="nebula-moodboard",
                         params={"moodboard": board["id"], "send_notes": choice})

    sent = (await handle_moodboard_node(node("yes"), {}, {}))["moodboard"]["value"]
    assert sent["notesSent"] is True and sent["notes"] == "liquid glass panels, quiet type"
    assert sent["images"][0]["notes"] == "the orange accent"
    assert "Notes: liquid glass panels, quiet type." in sent["styleBrief"]
    assert "liquid" in sent["analysis"]["keywords"]

    MoodboardStore().update(board["id"], by="person", sendNotes=True)
    held = (await handle_moodboard_node(node("no"), {}, {}))["moodboard"]["value"]
    assert held["notesSent"] is False and held["notes"] == "" and "Notes:" not in held["styleBrief"]
    board_says = (await handle_moodboard_node(node("board"), {}, {}))["moodboard"]["value"]
    assert board_says["notesSent"] is True
    # A node saved before the param reads "board".
    assert (await handle_moodboard_node(_node(board["id"]), {}, {}))["moodboard"]["value"]["notesSent"] is True
