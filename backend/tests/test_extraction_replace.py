"""Replacing a record measures it again and keeps everything else.

Structural on purpose, and not built from the same image on both sides: every top-level and
structure key that build_record makes must be on the keep list or the recompute list
(record.REPLACE_KEEPS_* / REPLACE_RECOMPUTES_*), never both. A field added later fails
test_every_field_build_record_makes_is_kept_or_recomputed until someone decides which. The old record is
changed before replacing (sentinels in kept keys, stale values in recomputed ones), so a recomputed key that
isn't refreshed, or a kept key that is overwritten, shows up.
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


# -- L5: the lists are complete, and replace does what they say --------------------------------------


def test_every_field_build_record_makes_is_kept_or_recomputed():
    made = rec.build_record(_item())
    assert not rec.REPLACE_KEEPS_TOP & rec.REPLACE_RECOMPUTES_TOP
    assert not rec.REPLACE_KEEPS_STRUCTURE & rec.REPLACE_RECOMPUTES_STRUCTURE
    top = set(made)
    assert top == rec.REPLACE_KEEPS_TOP | rec.REPLACE_RECOMPUTES_TOP, (
        f"decide whether replace keeps or recomputes: {top ^ (rec.REPLACE_KEEPS_TOP | rec.REPLACE_RECOMPUTES_TOP)}")
    structure = set(made["structure"])
    assert structure == rec.REPLACE_KEEPS_STRUCTURE | rec.REPLACE_RECOMPUTES_STRUCTURE, (
        f"decide for structure: {structure ^ (rec.REPLACE_KEEPS_STRUCTURE | rec.REPLACE_RECOMPUTES_STRUCTURE)}")


def test_replace_refreshes_what_it_recomputes_and_holds_what_it_keeps(folder):
    item, populated = _populated(folder)
    fresh = rec.build_record(_item())
    old = copy.deepcopy(populated)
    # Stale values in the recomputed keys.
    old["rendering"].update(width=1, height=1, phash="0" * 16)
    old["source"].update(size=1, name="stale.png", read_at="2020-01-01T00:00:00Z")
    old["structure"]["measured"].update(palette=[], lightness=-5, units={"lightness": "stale"}, aspect="stale",
                                        value_range={"low": -1, "high": -1})
    # Sentinels in the kept keys that can hold one.
    sentinels = {"schema_status": "final", "brand": "SENTINEL brand"}
    structure_sentinels = {"given": {"sentinel": True}, "given_reason": "SENTINEL reason"}
    old.update(sentinels)
    old["structure"].update(structure_sentinels)
    old["shows"]["keepme"] = {"statement": "SENTINEL show", "evidence": ["r6"], "origin": "person", "status": "proposal",
                              "decision_ref": None, "order": 77}
    old["read_requests"].append({"actor": "agent", "at": "t", "reason": "SENTINEL request"})
    old["corrections"].append({"path": "brand", "op": "set", "value": "SENTINEL correction", "actor": "person", "at": "t"})
    rec.validate(old)
    # Every kept key is covered by a sentinel or by a value the populated record already holds.
    covered = set(sentinels) | {"shows", "read_requests", "corrections", "id", "status", "approved_by", "approved_at",
                                "schema", "structure"}
    assert covered == rec.REPLACE_KEEPS_TOP, "a new kept top-level key needs a sentinel here"
    assert set(structure_sentinels) | {"read"} == rec.REPLACE_KEEPS_STRUCTURE, "a new kept structure key needs a sentinel here"

    out, dropped = rec.carry_over(fresh, old)
    for key in rec.REPLACE_RECOMPUTES_TOP:
        assert out[key] == fresh[key] != old[key], f"replace did not refresh {key!r}"
    measured_old, measured_new = old["structure"]["measured"], out["structure"]["measured"]
    for key in ("palette", "lightness", "units", "aspect", "value_range"):
        assert measured_new[key] == fresh["structure"]["measured"][key] != measured_old[key], f"measured.{key} is stale"
    for key, value in {**sentinels, **structure_sentinels}.items():
        held = out["structure"][key] if key in structure_sentinels else out[key]
        assert held == value, f"replace overwrote the kept {key!r}"
    for key in ("shows", "read_requests", "corrections"):
        assert out[key] == old[key] or key == "shows", f"replace changed the kept {key!r}"
    assert out["shows"]["keepme"]["statement"] == "SENTINEL show"
    assert out["structure"]["read"] == old["structure"]["read"]
    assert dropped == []


def test_replace_moves_an_old_record_to_the_new_scale(folder):
    # A record saved before measured.units existed: lightness 0-255, no units. A replace measures again.
    item, populated = _populated(folder)
    old = copy.deepcopy(populated)
    old["structure"]["measured"].pop("units")
    old["structure"]["measured"].update(lightness=200, saturation=20)
    store.write(folder / old["id"], old)
    assert "units" not in store.load(folder / old["id"])["structure"]["measured"]
    saved = store.save(rec.build_record(_item()), rendering_png(item.image), item.data, item.ext, folder,
                       replace=True, image=item.image)
    measured = saved["record"]["structure"]["measured"]
    assert measured["units"] == {"value_range": "L* 0-100", "lightness": "L* 0-100", "saturation": "HSV saturation 0-100"}
    assert 0 <= measured["lightness"] <= 100 and measured["lightness"] != 200
    assert 0 <= measured["saturation"] <= 100
    assert store.load(folder / old["id"])["structure"]["measured"]["units"] == measured["units"]


# -- L6: dropped_shows includes shows corrections added ------------------------------------------------


def test_dropped_shows_lists_correction_added_shows_and_the_corrections_aimed_at_dropped_shows(folder):
    _, before = _populated(folder)
    old = copy.deepcopy(before)
    # A color the new measurement won't have.
    extra = dict(old["structure"]["measured"]["palette"][0], index=98)
    old["structure"]["measured"]["palette"].append(extra)
    for item in old["corrections"]:
        if item["path"] == "shows.agent1":
            item["value"]["evidence"] = ["P98"]
    old["shows"]["stored"] = {"statement": "Stored, cites P98 only", "evidence": ["P98"], "origin": "model",
                              "status": "proposal", "decision_ref": None, "order": 50}
    old["corrections"].append({"path": "shows.stored.statement", "op": "set", "value": "Reworded", "actor": "person", "at": "t"})
    old["corrections"].append({"path": "shows.agent1.statement", "op": "set", "value": "Sharper", "actor": "agent", "at": "t"})
    rec.validate(old)
    assert "agent1" in rec.effective(old)["shows"] and "person1" in rec.effective(old)["shows"]

    out, dropped = rec.carry_over(rec.build_record(_item()), old)
    by_id = {d["id"]: d for d in dropped}
    assert set(by_id) == {"stored", "agent1"}, "person1 cites P0 and stays"
    assert by_id["agent1"]["statement"] == "Sharper"
    assert {(c["path"], c["actor"]) for c in by_id["agent1"]["corrections"]} == {
        ("shows.agent1", "agent"), ("shows.agent1.statement", "agent")}
    assert [(c["path"], c["actor"]) for c in by_id["stored"]["corrections"]] == [("shows.stored.statement", "person")]
    assert all(d["why"] for d in dropped)
    view = rec.effective(out)
    assert "agent1" not in view["shows"] and "stored" not in view["shows"] and "person1" in view["shows"]
    assert out["corrections"][-1]["path"] == "shows.agent1.statement"  # the corrections themselves stay
