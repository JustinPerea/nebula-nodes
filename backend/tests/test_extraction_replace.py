"""Replacing a record measures it again and keeps everything else.

Structural on purpose: every top-level and structure key of a fully populated
record must survive a replace with its value, unless it is on the list of
fields replace recomputes (record.REPLACE_RECOMPUTES_*). A field added later
fails this test until someone decides whether replace keeps it.
"""
from __future__ import annotations

import copy

import pytest

from extraction import reader, store
from extraction import record as rec
from extraction.errors import StoreRefused
from extraction.intake import intake, rendering_png
from tests.extraction_fakes import LANDING, landing_structured

MEASURED_FROM_BOXES = set(rec.REGION_MEASURES)


def _item():
    return intake(LANDING.read_bytes(), name="landing.png", kind="drop")


def _populated(folder):
    item = _item()
    record = rec.build_record(item)
    store.save(record, rendering_png(item.image), item.data, item.ext, folder)
    record = reader.apply_read(record, item.image, landing_structured(), model="fake-reader")
    record = rec.add_corrections(record, [
        {"path": "brand", "op": "set", "value": "acme"},
        {"path": "shows.person1", "op": "set", "value": {"statement": "Warm paper ground", "evidence": ["P0"]}},
        {"path": "structure.read.regions.r1.label", "op": "set", "value": "Top bar, dark"},
    ], "person")
    record = rec.add_corrections(record, [
        {"path": "shows.agent1", "op": "set", "value": {"statement": "One accent, on the button", "evidence": ["r6"]}},
    ], "agent")
    record = rec.add_read_request(record, "Read it again after the palette change.")
    store.write(folder / record["id"], record)
    return item, store.load(folder / record["id"])


@pytest.fixture
def folder(tmp_path):
    path = tmp_path / "records"
    path.mkdir()
    return path


def test_every_kept_key_survives_a_replace(folder):
    item, before = _populated(folder)
    origins = {s["origin"] for s in rec.effective(before)["shows"].values()}
    assert {"model", "person", "agent"} <= origins and before["read_requests"] and before["structure"]["read"]

    saved = store.save(rec.build_record(_item()), rendering_png(item.image), item.data, item.ext, folder,
                       replace=True, image=item.image)
    after = saved["record"]
    assert saved["existed"] is True and saved["dropped_shows"] == []

    for key, value in before.items():
        if key in rec.REPLACE_RECOMPUTES_TOP or key == "structure":
            continue
        assert key in after and after[key] == value, f"replace lost or changed top-level {key!r}"
    for key, value in before["structure"].items():
        if key in rec.REPLACE_RECOMPUTES_STRUCTURE:
            continue
        assert key in after["structure"] and after["structure"][key] == value, f"replace lost structure.{key}"
    for key in rec.REPLACE_RECOMPUTES_TOP:
        assert key in after, f"replace dropped the recomputed {key!r}"
    for key in before["structure"]["measured"]:
        assert key in after["structure"]["measured"], f"replace dropped structure.measured.{key}"
    for key in MEASURED_FROM_BOXES:
        assert after["structure"]["measured"][key] == before["structure"]["measured"][key]

    view = rec.effective(after)
    assert view.get("corrections_skipped", []) == []
    assert view["brand"] == "acme"
    assert view["structure"]["read"]["regions"]["r1"]["label"] == "Top bar, dark"
    assert store.load(folder / after["id"]) == after


def test_the_recompute_lists_name_only_what_the_image_gives():
    # Widening these lists drops data on every replace; it needs a reason.
    assert rec.REPLACE_RECOMPUTES_TOP == {"rendering", "source"}
    assert rec.REPLACE_RECOMPUTES_STRUCTURE == {"measured"}


def test_a_show_whose_evidence_is_gone_is_dropped_and_listed(folder):
    item, before = _populated(folder)
    gone = copy.deepcopy(before)
    gone["shows"]["ghost"] = {"statement": "Cites a color that won't exist", "evidence": ["P99"],
                              "origin": "agent", "status": "proposal", "decision_ref": None, "order": 99}
    gone["shows"]["mixed"] = {"statement": "Cites one color that exists and one that won't", "evidence": ["P0", "P98"],
                              "origin": "person", "status": "proposal", "decision_ref": None, "order": 98}
    fresh = rec.build_record(_item())
    out, dropped = rec.carry_over(fresh, gone)
    assert [d["id"] for d in dropped] == ["ghost"] and "ghost" not in out["shows"]
    assert out["shows"]["mixed"]["evidence"] == ["P0"]


def test_a_show_added_by_a_correction_loses_evidence_that_no_longer_exists(folder):
    _, before = _populated(folder)
    stale = copy.deepcopy(before)
    for item in stale["corrections"]:
        if item["path"] == "shows.agent1":
            item["value"]["evidence"] = ["P97"]
    view = rec.effective(stale)
    assert "agent1" not in view["shows"]
    assert {"path": "shows.agent1", "error": "none of its evidence exists now"} in view["corrections_skipped"]


def test_without_the_image_the_old_region_measures_stay(folder):
    item, before = _populated(folder)
    out, _ = rec.carry_over(rec.build_record(_item()), before)
    for key in MEASURED_FROM_BOXES:
        assert out["structure"]["measured"][key] == before["structure"]["measured"][key]


def test_an_approved_record_is_not_replaced(folder):
    item, before = _populated(folder)
    before["status"], before["approved_by"], before["approved_at"] = "approved", "person", "2026-11-19T12:00:00Z"
    store.write(folder / before["id"], before)
    with pytest.raises(StoreRefused, match="approved"):
        store.save(rec.build_record(_item()), rendering_png(item.image), item.data, item.ext, folder, replace=True)
