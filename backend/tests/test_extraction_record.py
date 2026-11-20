"""The record's shape, its id, corrections and the effective view."""
from __future__ import annotations

import copy
from datetime import datetime, timezone
from pathlib import Path

import pytest

from extraction import record as rec
from extraction.intake import intake

FIXTURES = Path(__file__).parent / "fixtures" / "extraction"
CLOCK = lambda: datetime(2026, 11, 19, 12, 30, 5, tzinfo=timezone.utc)  # noqa: E731


def _build(name="gradient_accent.png", **kwargs):
    data = (FIXTURES / name).read_bytes()
    return rec.build_record(intake(data, name=name, kind="drop"), clock=CLOCK, **kwargs)


def test_the_record_has_the_planned_shape():
    record = _build()
    assert record["schema"] == "extracted-example/1" and record["schema_status"] == "draft"
    assert record["status"] == "proposal"
    assert record["approved_by"] is None and record["approved_at"] is None and record["brand"] is None
    assert record["structure"]["given"] is None and record["structure"]["given_reason"]
    assert record["structure"]["read"] is None
    assert record["shows"] == {} and record["corrections"] == []
    assert record["rendering"]["file"] == "rendering.png"
    assert (record["rendering"]["width"], record["rendering"]["height"]) == (96, 64)
    assert len(record["rendering"]["sha256"]) == 64 and len(record["rendering"]["phash"]) == 16
    source = record["source"]
    assert source["kind"] == "drop" and source["name"] == "gradient_accent.png"
    assert source["path"] is None and source["mtime"] is None and source["tool"] is None
    assert source["frame_or_address"] is None
    assert source["size"] == (FIXTURES / "gradient_accent.png").stat().st_size
    assert source["version"] == "sha256:" + record["rendering"]["sha256"]
    assert source["read_at"] == "2026-11-19T12:30:05Z"
    assert record["structure"]["measured"]["origin"] == "code"
    rec.validate(record)


def test_the_same_image_gives_the_same_id_and_another_does_not():
    first, again, other = _build(), _build(), _build("one_pixel.png")
    assert first["id"] == again["id"] == "ex_" + first["rendering"]["sha256"][:16]
    assert other["id"] != first["id"]


def test_shows_without_evidence_are_dropped_by_the_builder():
    record = _build(shows=[
        {"statement": "One accent, on the button", "evidence": ["P7"]},
        {"statement": "No evidence given", "evidence": []},
        {"statement": "Evidence that doesn’t exist", "evidence": ["P99", "r9"]},
        {"statement": "   ", "evidence": ["P0"]},
        {"statement": "Two ids", "evidence": ["P0", "P1"]},
    ])
    assert list(record["shows"]) == ["s1", "s2"]
    assert record["shows"]["s1"] == {"statement": "One accent, on the button", "evidence": ["P7"], "origin": "model",
                                      "status": "proposal", "decision_ref": None, "order": 0}
    assert record["shows"]["s2"]["order"] == 1


@pytest.mark.parametrize("change, message", [
    (lambda r: r.update(schema="other/1"), "schema"),
    (lambda r: r.update(id="ex_zz"), "id"),
    (lambda r: r.update(status="done"), "status"),
    (lambda r: r.update(approved_by="justin"), "approval"),
    (lambda r: r["rendering"].update(width=0), "rendering.width"),
    (lambda r: r["rendering"].update(sha256="abc"), "rendering.sha256"),
    (lambda r: r["source"].update(kind="url"), "source.kind"),
    (lambda r: r["structure"].update(given_reason=""), "given_reason"),
    (lambda r: r["structure"]["measured"].update(origin="model"), "structure.measured"),
    (lambda r: r.update(shows=[]), "shows"),
    (lambda r: r.update(corrections={}), "corrections"),
    (lambda r: r.pop("rendering"), "rendering"),
])
def test_validate_says_where_it_broke(change, message):
    record = _build()
    change(record)
    with pytest.raises(rec.RecordInvalid, match=message):
        rec.validate(record)


def test_validate_wants_evidence_on_every_show():
    record = _build()
    record["shows"] = {"s1": {"statement": "x", "evidence": [], "order": 0}}
    with pytest.raises(rec.RecordInvalid, match=r"shows\.s1\.evidence"):
        rec.validate(record)


# -- corrections --------------------------------------------------------------------------------


def _with_show():
    return _build(shows=[{"statement": "One accent", "evidence": ["P7"]}])


def test_a_correction_to_a_show_is_applied_in_the_effective_view():
    record = _with_show()
    updated = rec.add_corrections(record, [{"path": "shows.s1.statement", "op": "set", "value": "One red accent",
                                            "reason": "it is red"}], "person", clock=CLOCK)
    assert record["corrections"] == []                         # the input is not changed
    assert updated["corrections"] == [{"path": "shows.s1.statement", "op": "set", "value": "One red accent",
                                       "actor": "person", "at": "2026-11-19T12:30:05Z", "reason": "it is red"}]
    assert updated["shows"]["s1"]["statement"] == "One accent"   # the stored value stays
    assert rec.effective(updated)["shows"]["s1"]["statement"] == "One red accent"
    assert "corrections_skipped" not in rec.effective(updated)


def test_brand_can_be_set_and_a_show_added_whole():
    record = _with_show()
    updated = rec.add_corrections(record, [
        {"path": "brand", "op": "set", "value": "acme"},
        {"path": "shows.s2", "op": "set", "value": {"statement": "Quiet grey ground", "evidence": ["P0"]}},
        {"path": "shows.s2.evidence", "op": "add", "value": "P1"},
    ], "agent", clock=CLOCK)
    view = rec.effective(updated)
    assert view["brand"] == "acme" and updated["brand"] is None
    assert view["shows"]["s2"]["origin"] == "agent" and view["shows"]["s2"]["order"] == 1
    assert view["shows"]["s2"]["status"] == "proposal" and view["shows"]["s2"]["decision_ref"] is None
    assert view["shows"]["s2"]["evidence"] == ["P0", "P1"]


def test_a_show_can_be_removed_in_the_effective_view():
    updated = rec.add_corrections(_with_show(), [{"path": "shows.s1", "op": "set", "value": None}], "person")
    assert rec.effective(updated)["shows"] == {}


@pytest.mark.parametrize("path", [
    "status", "approved_by", "approved_at",
    "structure.measured", "structure.measured.palette", "structure.measured.palette.0.hex",
    "rendering", "rendering.width", "source", "source.name", "source.path",
    "schema", "schema_status", "id", "schemas",
    "structure.given", "structure.given_reason", "corrections", "something_else",
])
@pytest.mark.parametrize("actor", ["person", "agent"])
def test_the_refused_paths(path, actor):
    record = _with_show()
    with pytest.raises(rec.RecordInvalid):
        rec.add_corrections(record, [{"path": path, "op": "set", "value": "x"}], actor)


def test_an_agent_cant_approve_and_the_message_says_so():
    for path, value in (("status", "approved"), ("approved_by", "claude"), ("approved_at", "2026-11-19T00:00:00Z")):
        with pytest.raises(rec.RecordInvalid, match="Approval isn’t a correction"):
            rec.add_corrections(_build(), [{"path": path, "op": "set", "value": value}], "agent")


def test_code_measured_values_say_they_are_facts():
    with pytest.raises(rec.RecordInvalid, match="fact, not a correction"):
        rec.add_corrections(_build(), [{"path": "structure.measured.palette", "op": "set", "value": []}], "person")


def test_the_model_read_is_not_there_to_correct():
    with pytest.raises(rec.RecordInvalid, match="no model read"):
        rec.add_corrections(_build(), [{"path": "structure.read.regions.r1.role", "op": "set", "value": "hero"}], "person")


def test_read_paths_work_once_a_read_exists_but_its_provenance_stays():
    record = _build()
    record["structure"]["read"] = {"origin": "model", "model": "m", "prompt_version": "extract-1", "read_at": "t",
                                   "regions": {"r1": {"role": "header", "order": 0, "box": [0, 0, 1, 1]}}}
    updated = rec.add_corrections(record, [{"path": "structure.read.regions.r1.role", "op": "set", "value": "hero"}], "person")
    assert rec.effective(updated)["structure"]["read"]["regions"]["r1"]["role"] == "hero"
    with pytest.raises(rec.RecordInvalid, match="who read the image"):
        rec.add_corrections(record, [{"path": "structure.read.model", "op": "set", "value": "x"}], "person")


@pytest.mark.parametrize("correction, message", [
    ({"path": "shows.s1.statement", "op": "set", "value": "  "}, "statement"),
    ({"path": "shows.s9.statement", "op": "set", "value": "x"}, "no show s9"),
    ({"path": "shows.s2", "op": "set", "value": {"statement": "x", "evidence": []}}, "evidence"),
    ({"path": "shows.s2", "op": "set", "value": {"statement": "x", "evidence": ["P99"]}}, "evidence"),
    ({"path": "shows.s1.evidence", "op": "set", "value": []}, "evidence"),
    ({"path": "shows.s1.decision_ref", "op": "set", "value": "d1"}, "when a person accepts it"),
    ({"path": "shows.s1.statement", "op": "add", "value": "x"}, "statement is set as text"),
    ({"path": "shows.s1", "op": "add", "value": {}}, "whole entry"),
    ({"path": "shows..x", "op": "set", "value": 1}, "isn’t letters"),
    ({"path": "shows.s1.statement", "op": "clear", "value": 1}, "op is"),
    ({"path": "shows.s1.statement", "op": "set", "value": {1, 2}}, "plain JSON"),
    ({"path": "shows.s1.statement", "op": "set", "value": "x" * 30000}, "characters"),
    ({"path": "shows.s1.statement", "op": "set", "value": "x", "reason": 5}, "reason"),
    ("not an object", "object"),
])
def test_bad_corrections_are_refused_whole(correction, message):
    record = _with_show()
    good = {"path": "brand", "op": "set", "value": "acme"}
    with pytest.raises(rec.RecordInvalid, match=message):
        rec.add_corrections(record, [good, correction], "person")
    assert record["corrections"] == []


def test_the_actor_and_the_count_are_checked():
    with pytest.raises(rec.RecordInvalid, match="actor"):
        rec.add_corrections(_build(), [{"path": "brand", "op": "set", "value": "a"}], "model")
    with pytest.raises(rec.RecordInvalid, match="no corrections"):
        rec.add_corrections(_build(), [], "person")
    with pytest.raises(rec.RecordInvalid, match="at most"):
        rec.add_corrections(_build(), [{"path": "brand", "op": "set", "value": "a"}] * 51, "person")


def test_effective_skips_a_stored_correction_that_no_longer_fits():
    record = _with_show()
    record["corrections"] = [{"path": "shows.s7.statement", "op": "set", "value": "x", "actor": "person", "at": "t"},
                             {"path": "brand", "op": "set", "value": "acme", "actor": "person", "at": "t"}]
    view = rec.effective(record)
    assert view["brand"] == "acme"
    assert view["corrections_skipped"][0]["path"] == "shows.s7.statement"
    assert copy.deepcopy(record)["brand"] is None


@pytest.mark.parametrize("claimed", [
    {"origin": "person"}, {"status": "approved"}, {"decision_ref": "dec_1"}, {"order": -5},
])
def test_a_whole_show_cant_claim_its_own_provenance(claimed):
    value = {"statement": "Quiet grey ground", "evidence": ["P0"], **claimed}
    with pytest.raises(rec.RecordInvalid, match="only a statement and evidence"):
        rec.add_corrections(_with_show(), [{"path": "shows.s2", "op": "set", "value": value}], "agent", clock=CLOCK)


@pytest.mark.parametrize("path", [
    "shows.s1.status.x", "shows.s1.origin", "shows.s1.decision_ref", "shows.s1.order", "shows.s1.extra",
    "shows.s1.statement.x",
])
def test_a_show_keeps_its_provenance_at_any_depth(path):
    with pytest.raises(rec.RecordInvalid):
        rec.add_corrections(_with_show(), [{"path": path, "op": "set", "value": "x"}], "agent", clock=CLOCK)


@pytest.mark.parametrize("actor", ["agent", "person"])
def test_an_approved_record_cant_be_corrected(actor):
    record = _with_show()
    record["status"], record["approved_by"], record["approved_at"] = "approved", "person", "2026-11-19T12:00:00Z"
    with pytest.raises(rec.RecordInvalid, match="approved"):
        rec.add_corrections(record, [{"path": "brand", "op": "set", "value": "acme"}], actor, clock=CLOCK)
