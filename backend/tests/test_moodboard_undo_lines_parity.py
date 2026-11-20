"""The kept-undo sentences are worded on two sides: one line per kept slice by
the backend (services/moodboard_edits.py) and one line for the whole undo by
the Studio (components/moodboard-studio/undoLines.ts). One shared fixture
(tests/fixtures/moodboard_undo_lines.json) pins both, so a join or a quote
that drifts on one side fails here or in
frontend/tests/moodboardUndoLinesParity.test.ts. Each case also pins the shape
of the entries the backend sends, which the Studio reads by key."""

from __future__ import annotations

import json
from pathlib import Path
from typing import Any

import pytest

from services import moodboard_edits as edits

SHARED = json.loads((Path(__file__).resolve().parent / "fixtures" / "moodboard_undo_lines.json")
                    .read_text(encoding="utf-8"))
CASES = SHARED["cases"]


def _batch(case: dict[str, Any], numbers: int = 6) -> edits._Batch:
    board = {"images": [{"id": f"i{n}", "url": f"/files/{n}.png"} for n in range(1, numbers + 1)],
             "frames": [{"id": "f1", "name": case.get("frameName", "Look"), "x": 0, "y": 0, "w": 10, "h": 10}]}
    return edits._Batch(board, by="agent", now="2026-11-17T00:00:00Z")


def _build(case: dict[str, Any], entry: dict[str, Any]) -> dict[str, Any]:
    """The entry the backend sends for ``entry``'s inputs, by the real functions."""
    part, reason = entry["part"], entry["reason"]
    if part == "fields":
        return edits._Batch._field_skip(entry["field"], reason, case.get("expect"))
    batch = _batch(case)
    if part == "frame":
        return batch._skip_report({"part": "frame", "frame": "f1"}, reason)
    image_id = f"i{entry['number']}"
    item: dict[str, Any] = {"part": part, "image": image_id}
    if reason == "removed since":
        batch.board["images"] = [img for img in batch.images if img["id"] != image_id]
    if part == "settings" and reason == "changed since":
        # Each setting is neither as it was before the step nor as the step left it.
        item["before"] = {key: "before" for key in entry["settings"]}
        item["expect"] = {key: "step" for key in entry["settings"]}
        batch.find(image_id).update({key: "later" for key in entry["settings"]})
        skipped: list[dict[str, Any]] = []
        assert batch._restore_settings(item, skipped) == "skipped"
        return skipped[0]
    return batch._skip_report(item, reason)


@pytest.mark.parametrize("case", CASES, ids=[c["name"] for c in CASES])
def test_the_backend_says_each_kept_slice_as_the_shared_case_does(case):
    built = [_build(case, entry) for entry in case["skipped"]]
    # The keys the Studio reads are the ones the backend sends, as the case says.
    for entry, report in zip(case["skipped"], built):
        assert {key: report.get(key) for key in entry} == entry
    assert [report["message"] for report in built] == case["backendLines"]


def test_the_cases_cover_every_reason_the_backend_sends():
    seen = {(entry["part"], entry["reason"]) for case in CASES for entry in case["skipped"]}
    assert {("fields", "changed since"), ("fields", "is the person’s to change"), ("fields", "is the person’s to turn on"),
            ("fields", "can’t go back"), ("fields", "would undo a colour choice made since"),
            ("image", "changed since"), ("card", "changed since"), ("settings", "changed since"), ("frame", "changed since"),
            ("settings", "removed since"), ("card", "removed since"), ("card", "can’t go back there"),
            ("image", "isn’t one of Nebula’s own files"), ("image", "is an image link from outside Nebula")} <= seen
    assert edits.FIELD_NOUNS["sendNotes"] == "“Moodboard notes to generators”"


@pytest.mark.parametrize("quote", SHARED["quotes"], ids=[q["label"] for q in SHARED["quotes"]])
def test_a_label_in_quotes_never_nests_double_quotes(quote):
    assert edits.in_quotes(quote["label"]) == quote["quoted"]


def test_a_look_named_with_quotes_is_said_in_one_pair_of_quotes():
    assert edits.quoted("Say “hi”") == "“Say ‘hi’”"
    with pytest.raises(edits.EditError, match="no frame “Say ‘hi’”"):
        _batch({}).frame("Say “hi”")


def test_an_image_with_no_number_is_kept_in_the_same_form():
    """Design: "An image changed after that step, so Nebula left it as it is.\""""
    report = _batch({})._skip_report({"part": "image", "image": "gone"}, "changed since")
    assert report["message"] == "An image changed after that step, so Nebula left it as it is."
    assert report["reason"] == "changed since" and "number" not in report
