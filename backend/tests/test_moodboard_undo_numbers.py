"""An undo's kept lines number each image as the board is after the undo.

The person reads "Undid “Added 4 references” except images 5 and 6" after the
undo, so those numbers are the ones the cards show then; agents read the
backend's "Image 5 changed after that step, …" line and then read the board.
Both come from the skip entries' ``number``, so each is checked against the
image's 1-based place on the board the undo returns (design)."""

from __future__ import annotations

import copy
import re
from typing import Any

from services import moodboard_edits as edits

NOW = "2026-11-19T00:00:00Z"


def _board(count: int) -> dict[str, Any]:
    return {"images": [{"id": f"i{n}", "url": f"/files/{n}.png", "weight": 1.0} for n in range(1, count + 1)],
            "frames": []}


def _step(before: dict[str, Any], change) -> tuple[dict[str, Any], list[dict[str, Any]]]:
    after = copy.deepcopy(before)
    change(after)
    return after, edits.diff(before, after)["slices"]


def _undo(board: dict[str, Any], slices: list[dict[str, Any]]):
    result = edits.apply_edits(board, [{"op": "restore", "slices": slices}], by="agent", now=NOW)
    return result.board, result.applied[0]["skipped"]


def _place(board: dict[str, Any], image_id: str) -> int:
    return [img["id"] for img in board["images"]].index(image_id) + 1


def _says(message: str, number: int) -> bool:
    return re.search(rf"\b[Ii]mage {number}\b", message) is not None


def test_each_kept_image_is_numbered_by_the_board_after_the_undo_when_references_were_added():
    # Four references added, then images 6 and 8 changed by another actor.
    board = _board(4)
    after, slices = _step(board, lambda b: b["images"].extend(
        {"id": f"i{n}", "url": f"/files/{n}.png", "weight": 1.0} for n in range(5, 9)))
    after["images"][5]["weight"] = 2.0
    after["images"][7]["weight"] = 3.0
    undone, skipped = _undo(after, slices)
    assert [img["id"] for img in undone["images"]] == ["i1", "i2", "i3", "i4", "i6", "i8"]
    assert [(s["image"], s["number"]) for s in skipped] == [("i6", 5), ("i8", 6)]
    for entry in skipped:
        assert entry["number"] == _place(undone, entry["image"])
        assert _says(entry["message"], entry["number"])


def test_a_setting_kept_before_a_later_removal_is_numbered_after_it():
    # The step added an image at the top and resized image 2 (then 3, once the
    # new one is first); another actor resized it again. Undoing removes the
    # new image last, so the kept line must not count it.
    board = _board(3)

    def change(b: dict[str, Any]) -> None:
        b["images"].insert(0, {"id": "new", "url": "/files/new.png", "weight": 1.0})
        b["images"][2]["weight"] = 2.0

    after, slices = _step(board, change)
    after["images"][2]["weight"] = 5.0
    undone, skipped = _undo(after, slices)
    assert [img["id"] for img in undone["images"]] == ["i1", "i2", "i3"]
    settings = [s for s in skipped if s["part"] == "settings"]
    assert [(s["image"], s["number"]) for s in settings] == [("i2", 2)]
    for entry in skipped:
        assert entry["number"] == _place(undone, entry["image"])
        assert _says(entry["message"], entry["number"]) and not _says(entry["message"], 3)


def _added_three(before_count: int = 4):
    board = _board(before_count)
    after, slices = _step(board, lambda b: b["images"].extend(
        {"id": f"i{n}", "url": f"/files/{n}.png", "weight": 1.0} for n in range(before_count + 1, before_count + 4)))
    return after, slices


def test_a_kept_image_the_undo_renumbers_says_its_number_before_the_undo():
    # "Added images 5, 6 and 7", then another actor changes image 6: the undo
    # takes 5 and 7 off, so the kept card is image 6 before and image 5 after.
    after, slices = _added_three()
    after["images"][5]["weight"] = 2.0
    undone, skipped = _undo(after, slices)
    assert [(s["image"], s["number"], s["numberBefore"]) for s in skipped] == [("i6", 5, 6)]
    assert skipped[0]["number"] == _place(undone, "i6")


def test_a_kept_image_the_undo_leaves_in_place_has_the_same_number_both_ways():
    # Image 5 of 5, 6 and 7 changed: nothing before it comes off.
    after, slices = _added_three()
    after["images"][4]["weight"] = 2.0
    undone, skipped = _undo(after, slices)
    assert [(s["image"], s["number"], s["numberBefore"]) for s in skipped] == [("i5", 5, 5)]
    assert _place(undone, "i5") == 5
