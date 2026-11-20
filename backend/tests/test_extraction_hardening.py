"""Corrections to a reading keep its shape, the store writes only what it can read back, writers take turns,
and an agent can't undo a person's choice."""
from __future__ import annotations

import copy
import hashlib
import json
import os
import threading
import time
from datetime import datetime, timezone

import pytest

from extraction import reader, store
from extraction import record as rec
from extraction.errors import StoreRefused
from extraction.intake import intake, rendering_png
from tests.extraction_fakes import LANDING, answering, block_real_spawn, landing_structured  # noqa: F401

CLOCK = lambda: datetime(2026, 11, 19, 12, 30, 5, tzinfo=timezone.utc)  # noqa: E731
pytestmark = pytest.mark.usefixtures("block_real_spawn")


@pytest.fixture(scope="module")
def item():
    return intake(LANDING.read_bytes(), name="landing.png", kind="drop")


@pytest.fixture
def read_record(item):
    record = rec.build_record(item, clock=CLOCK)
    return reader.apply_read(record, item.image, landing_structured(), model="fake-reader")


@pytest.fixture
def folder(tmp_path):
    path = tmp_path / "records"
    path.mkdir()
    return path


@pytest.fixture
def saved(folder, item, read_record):
    """A record on disk with a reading."""
    store.save(rec.build_record(item, clock=CLOCK), rendering_png(item.image), item.data, item.ext, folder)
    directory = folder / read_record["id"]
    store.write(directory, read_record)
    return directory


def _fix(record, corrections, actor="person"):
    return rec.add_corrections(record, corrections, actor, clock=CLOCK)


# -- M1: a correction can't break the reading's shape -------------------------------------------------


@pytest.mark.parametrize("actor", ["person", "agent"])
def test_setting_a_whole_region_is_refused_and_the_record_is_unchanged(read_record, actor):
    # The case that used to be accepted and blank the page.
    before = copy.deepcopy(read_record)
    with pytest.raises(rec.RecordInvalid, match="What can be"):
        _fix(read_record, [{"path": "structure.read.regions.r1", "op": "set", "value": {"role": "hero"}}], actor)
    assert read_record == before


@pytest.mark.parametrize("path, op, value", [
    ("structure.read.regions", "set", {}),
    ("structure.read.regions.r1", "set", None),
    ("structure.read.regions.r1.box", "set", [0, 0, 1, 1]),
    ("structure.read.regions.r1.box_px", "set", "x"),
    ("structure.read.regions.r1.order", "set", 3),
    ("structure.read.regions.r1.role.x", "set", "hero"),
    ("structure.read.regions.r1.role", "add", "hero"),
    ("structure.read.regions.r99.role", "set", "hero"),  # no such region
    ("structure.read.text.t1", "set", {"content": "x"}),
    ("structure.read.text.t1.box", "set", None),
    ("structure.read.text.t1.size_px", "set", 3),
    ("structure.read.text.t99.content", "set", "x"),
    ("structure.read.text.t1.region", "set", "r1"),
    ("structure.read.spacing", "set", {}),
    ("structure.read.spacing.gaps", "set", []),
    ("structure.read.reader_1", "set", {}),
    ("structure.read.reader_1.summary", "set", "x"),
    ("structure.read.reader_1.summary.why", "set", "x"),
    ("structure.read.reader_1.axes.warm_cool.value", "set", 0.5),
    ("structure.read.reader_1.keywords", "set", ["minimal"]),
    ("structure.read.reader_1.palette_roles", "set", []),
    ("structure.read.model", "set", "x"),
    ("structure.read.read_at", "set", "x"),
    ("structure.read.origin", "set", "person"),
    ("structure.read.prompt_version", "set", "x"),
    ("structure.read.something_new", "set", 1),
])
def test_paths_off_the_list_are_refused(read_record, path, op, value):
    with pytest.raises(rec.RecordInvalid):
        _fix(read_record, [{"path": path, "op": op, "value": value}])


def test_the_refusal_names_what_can_be_corrected(read_record):
    with pytest.raises(rec.RecordInvalid) as caught:
        _fix(read_record, [{"path": "structure.read.regions.r1.box", "op": "set", "value": [0, 0, 1, 1]}])
    message = str(caught.value)
    for name in ("role", "label", "content", "weight", "type_style", "reader_1", "keywords"):
        assert name in message


@pytest.mark.parametrize("path, value", [
    ("structure.read.regions.r1.role", "not_a_role"),
    ("structure.read.regions.r1.role", None),
    ("structure.read.regions.r1.role", 5),
    ("structure.read.regions.r1.label", "x" * 121),
    ("structure.read.regions.r1.label", {"a": 1}),
    ("structure.read.text.t1.content", ""),
    ("structure.read.text.t1.content", "x" * 301),
    ("structure.read.text.t1.content", ["x"]),
    ("structure.read.text.t1.weight", "heavy"),
    ("structure.read.text.t1.type_style", "comic"),
    ("structure.read.reader_1.type_style.value", "comic"),
    ("structure.read.reader_1.layout.value", 3),
    ("structure.read.reader_1.summary.value", ""),
    ("structure.read.reader_1.summary.value", {"a": 1}),
    ("structure.read.reader_1.summary.value", "x" * 2001),
])
def test_a_leaf_with_the_wrong_type_or_value_is_refused(read_record, path, value):
    with pytest.raises(rec.RecordInvalid):
        _fix(read_record, [{"path": path, "op": "set", "value": value}])


def test_the_leaf_fields_can_be_corrected_and_show_in_the_effective_view(read_record):
    updated = _fix(read_record, [
        {"path": "structure.read.regions.r1.role", "op": "set", "value": "hero"},
        {"path": "structure.read.regions.r1.label", "op": "set", "value": "Top bar, dark"},
        {"path": "structure.read.text.t1.content", "op": "set", "value": "Make the thing, well"},
        {"path": "structure.read.text.t1.weight", "op": "set", "value": "light"},
        {"path": "structure.read.text.t1.type_style", "op": "set", "value": "serif"},
        {"path": "structure.read.reader_1.summary.value", "op": "set", "value": "A landing page."},
        {"path": "structure.read.reader_1.layout.value", "op": "set", "value": "grid"},
        {"path": "structure.read.reader_1.keywords", "op": "add", "value": "minimal"},
    ])
    view = rec.effective(updated)
    assert "corrections_skipped" not in view
    read = view["structure"]["read"]
    assert read["regions"]["r1"]["role"] == "hero" and read["regions"]["r1"]["label"] == "Top bar, dark"
    assert read["regions"]["r1"]["box"] == read_record["structure"]["read"]["regions"]["r1"]["box"]
    assert read["text"]["t1"]["content"] == "Make the thing, well" and read["text"]["t1"]["weight"] == "light"
    assert read["text"]["t1"]["type_style"] == "serif"
    assert read["reader_1"]["summary"]["value"] == "A landing page." and read["reader_1"]["layout"]["value"] == "grid"
    assert rec.read_malformed(read) is None


def test_keywords_add_and_remove_take_one_word_from_the_vocabulary(read_record):
    present = read_record["structure"]["read"]["reader_1"]["keywords"][0]
    updated = _fix(read_record, [{"path": "structure.read.reader_1.keywords", "op": "remove", "value": present}])
    assert present not in rec.effective(updated)["structure"]["read"]["reader_1"]["keywords"]
    for value in ("not-a-vocabulary-word-at-all", 5, ["minimal"], None):
        with pytest.raises(rec.RecordInvalid, match="vocabulary"):
            _fix(read_record, [{"path": "structure.read.reader_1.keywords", "op": "add", "value": value}])


def test_a_stored_correction_that_would_break_a_region_is_skipped_and_listed(read_record):
    # Records written before the paths were limited can hold these; the view must still be drawable.
    broken = copy.deepcopy(read_record)
    entry = {"op": "set", "actor": "agent", "at": "2026-11-19T00:00:00Z"}
    broken["corrections"] = [
        dict(entry, path="structure.read.regions.r1", value={"role": "hero"}),
        dict(entry, path="structure.read.regions.r99.role", value="hero"),
        dict(entry, path="structure.read.text.t1", value=None),
        dict(entry, path="structure.read.regions.r2.box", value="oops"),
        dict(entry, path="structure.read.regions.r3.label", value="kept"),
    ]
    rec.validate(broken)
    view = rec.effective(broken)
    assert {s["path"] for s in view["corrections_skipped"]} == {
        "structure.read.regions.r1", "structure.read.regions.r99.role", "structure.read.text.t1",
        "structure.read.regions.r2.box"}
    assert all("would break the reading" in s["error"] for s in view["corrections_skipped"])
    read = view["structure"]["read"]
    assert rec.read_malformed(read) is None and set(read["regions"]) == set(read_record["structure"]["read"]["regions"])
    assert read["regions"]["r3"]["label"] == "kept" and "r99" not in read["regions"]
    assert read["regions"]["r1"]["box"] == read_record["structure"]["read"]["regions"]["r1"]["box"]


def test_brand_is_text_or_null(read_record):
    assert rec.effective(_fix(read_record, [{"path": "brand", "op": "set", "value": "acme"}]))["brand"] == "acme"
    for value in ({"a": 1}, ["x"], 3, "x" * 201):
        with pytest.raises(rec.RecordInvalid, match="brand"):
            _fix(read_record, [{"path": "brand", "op": "set", "value": value}])


def test_a_value_nested_too_deeply_is_refused(read_record):
    deep = "x"
    for _ in range(6):
        deep = [deep]
    with pytest.raises(rec.RecordInvalid, match="nested"):
        _fix(read_record, [{"path": "shows.s9", "op": "set", "value": {"statement": "x", "evidence": ["P0"], "d": deep}}])


# -- M2: the store writes only what it can read back ---------------------------------------------------


def _pad_to(record, size):
    """Set source.name so record.json is exactly ``size`` bytes."""
    record["source"]["name"] = ""
    base = len(_raw_dump(record))
    record["source"]["name"] = "n" * (size - base)
    assert len(_raw_dump(record)) == size
    return record


def _raw_dump(record):
    return (json.dumps(record, indent=2, ensure_ascii=False) + "\n").encode("utf-8")


def test_the_largest_valid_record_round_trips(folder, item, read_record):
    # One correction as large as the caps allow, kept as many times as a record may hold.
    big = {"path": "structure.read.reader_1.summary.value", "op": "set", "value": "w" * 1990, "reason": "€" * 500}
    one = rec.add_corrections(read_record, [big], "person", clock=CLOCK)["corrections"][0]
    with pytest.raises(rec.RecordInvalid, match="at most"):
        _fix(read_record, [dict(big, value="w" * 1990)] * 51)
    record = copy.deepcopy(read_record)
    record["corrections"] = [dict(one) for _ in range(rec.MAX_CORRECTIONS_PER_RECORD)]
    rec.validate(record)
    size = len(_raw_dump(record))
    assert size < store.MAX_RECORD_BYTES, f"the largest valid record is {size} bytes"
    store.save(rec.build_record(item, clock=CLOCK), rendering_png(item.image), item.data, item.ext, folder)
    store.write(folder / record["id"], record)
    assert store.load(folder / record["id"]) == record
    with pytest.raises(rec.RecordInvalid, match="at most 1000"):
        _fix(record, [big])


def test_a_correction_over_its_byte_cap_is_refused(read_record):
    # Whitespace-heavy values (a long list) take more bytes than their characters when indented.
    wide = {"path": "shows.s9", "op": "set", "reason": "€" * 500,
            "value": {"statement": "x" * 1000, "evidence": ["P0"] * 150}}
    with pytest.raises(rec.RecordInvalid):
        _fix(read_record, [wide])


def test_a_record_of_exactly_the_limit_is_written_and_one_more_byte_is_not(folder, item, read_record):
    store.save(rec.build_record(item, clock=CLOCK), rendering_png(item.image), item.data, item.ext, folder)
    directory = folder / read_record["id"]
    at_limit = _pad_to(copy.deepcopy(read_record), store.MAX_RECORD_BYTES)
    store.write(directory, at_limit)
    assert store.load(directory) == at_limit
    before = (directory / "record.json").read_bytes()
    stamp = os.stat(directory / "record.json").st_mtime_ns
    # One more byte, by a write, by a correction (which adds bytes) and by a request.
    over = _pad_to(copy.deepcopy(read_record), store.MAX_RECORD_BYTES)
    over["source"]["name"] += "n"
    with pytest.raises(StoreRefused, match="too large"):
        store.write(directory, over)
    with pytest.raises(StoreRefused, match="too large"):
        store.correct(directory, [{"path": "brand", "op": "set", "value": "acme"}], "person")
    with pytest.raises(StoreRefused, match="too large"):
        store.request_read(directory, "Please read it again.")
    assert (directory / "record.json").read_bytes() == before
    assert os.stat(directory / "record.json").st_mtime_ns == stamp
    assert store.load(directory) == at_limit  # still readable
    assert [p.name for p in directory.iterdir() if p.name.startswith(".tmp")] == []


def test_save_refuses_a_record_over_the_limit_and_leaves_no_folder(folder, item):
    record = rec.build_record(item, clock=CLOCK)
    record["source"]["name"] = "n" * store.MAX_RECORD_BYTES
    with pytest.raises(StoreRefused, match="too large"):
        store.save(record, rendering_png(item.image), item.data, item.ext, folder)
    assert list(folder.iterdir()) == []


def test_save_over_the_limit_leaves_an_existing_record_alone(folder, item):
    store.save(rec.build_record(item, clock=CLOCK), rendering_png(item.image), item.data, item.ext, folder)
    directory = folder / rec.record_id(hashlib.sha256(item.data).hexdigest())
    before = {p.name: p.read_bytes() for p in directory.iterdir() if p.name != store.LOCK_NAME}
    record = rec.build_record(item, clock=CLOCK)
    record["source"]["name"] = "n" * store.MAX_RECORD_BYTES
    with pytest.raises(StoreRefused, match="too large"):
        store.save(record, rendering_png(item.image), item.data, item.ext, folder, replace=True)
    assert {p.name: p.read_bytes() for p in directory.iterdir() if p.name != store.LOCK_NAME} == before


# -- M3: writers take turns -----------------------------------------------------------------------------


def test_two_threads_correcting_one_record_both_land(saved):
    start = threading.Barrier(8)
    errors: list[BaseException] = []

    def work(n: int) -> None:
        try:
            start.wait()
            store.correct(saved, [{"path": f"shows.w{n}", "op": "set",
                                   "value": {"statement": f"Show {n}", "evidence": ["P0"]}}], "person")
        except BaseException as exc:  # noqa: BLE001
            errors.append(exc)

    threads = [threading.Thread(target=work, args=(n,)) for n in range(8)]
    [t.start() for t in threads]
    [t.join() for t in threads]
    assert errors == []
    landed = {c["path"] for c in store.load(saved)["corrections"]}
    assert landed == {f"shows.w{n}" for n in range(8)}


def test_a_request_and_a_correction_at_once_both_land(saved):
    start = threading.Barrier(2)

    def request():
        start.wait()
        store.request_read(saved, "Look again.")

    def correct():
        start.wait()
        store.correct(saved, [{"path": "brand", "op": "set", "value": "acme"}], "agent")

    threads = [threading.Thread(target=request), threading.Thread(target=correct)]
    [t.start() for t in threads]
    [t.join() for t in threads]
    final = store.load(saved)
    assert len(final["read_requests"]) == 1 and [c["value"] for c in final["corrections"]] == ["acme"]


def test_a_correction_made_while_a_slow_read_is_applied_survives_with_the_reading(folder, item, monkeypatch):
    # The read's apply step runs inside the record's lock; a correction that arrives meanwhile waits for it,
    # then lands on the new reading (it names a region only the reading has).
    store.save(rec.build_record(item, clock=CLOCK), rendering_png(item.image), item.data, item.ext, folder)
    directory = folder / rec.record_id(hashlib.sha256(item.data).hexdigest())
    applying = threading.Event()
    real = reader.apply_read

    def slow(*args, **kwargs):
        applying.set()
        time.sleep(0.4)
        return real(*args, **kwargs)

    monkeypatch.setattr(reader, "apply_read", slow)
    outcome: dict[str, object] = {}

    def correct_meanwhile() -> None:
        applying.wait()
        try:
            outcome["record"] = store.correct(
                directory, [{"path": "structure.read.regions.r6.label", "op": "set", "value": "Main action"}], "person")
        except BaseException as exc:  # noqa: BLE001
            outcome["error"] = exc

    thread = threading.Thread(target=correct_meanwhile)
    thread.start()
    store.modify(directory, lambda fresh: reader.apply_read(fresh, item.image, landing_structured(), model="fake-reader"))
    thread.join()
    assert "error" not in outcome, outcome.get("error")
    final = store.load(directory)
    assert final["structure"]["read"] is not None
    assert [c["path"] for c in final["corrections"]] == ["structure.read.regions.r6.label"]
    assert rec.effective(final)["structure"]["read"]["regions"]["r6"]["label"] == "Main action"


def test_the_lock_file_is_made_beside_the_record_and_not_listed(saved, folder):
    store.correct(saved, [{"path": "brand", "op": "set", "value": "acme"}], "person")
    assert (saved / store.LOCK_NAME).is_file()
    rows = store.list_records(folder)
    assert [r["id"] for r in rows] == [saved.name] and "error" not in rows[0]


def test_a_symlink_in_place_of_the_lock_file_is_refused(saved, tmp_path):
    target = tmp_path / "elsewhere"
    target.write_text("keep")
    (saved / store.LOCK_NAME).unlink()
    (saved / store.LOCK_NAME).symlink_to(target)
    before = (saved / "record.json").read_bytes()
    with pytest.raises(StoreRefused, match="lock"):
        store.correct(saved, [{"path": "brand", "op": "set", "value": "acme"}], "person")
    assert target.read_text() == "keep" and (saved / "record.json").read_bytes() == before


def test_a_failed_change_inside_the_lock_leaves_the_record_and_releases_the_lock(saved):
    before = (saved / "record.json").read_bytes()
    with pytest.raises(rec.RecordInvalid):
        store.correct(saved, [{"path": "status", "op": "set", "value": "approved"}], "agent")
    assert (saved / "record.json").read_bytes() == before
    store.correct(saved, [{"path": "brand", "op": "set", "value": "acme"}], "person")  # the lock was released


# -- L4: an agent can't undo a person's choice ---------------------------------------------------------


@pytest.fixture
def with_person_show(read_record):
    return _fix(read_record, [
        {"path": "shows.p1", "op": "set", "value": {"statement": "Warm paper ground", "evidence": ["P0"]}},
        {"path": "brand", "op": "set", "value": "acme"},
    ], "person")


@pytest.mark.parametrize("correction", [
    {"path": "shows.p1", "op": "set", "value": None},
    {"path": "shows.p1", "op": "set", "value": {"statement": "Mine now", "evidence": ["P1"]}},
    {"path": "shows.p1.statement", "op": "set", "value": "Rewritten by an agent"},
    {"path": "shows.p1.evidence", "op": "add", "value": "P1"},
])
def test_an_agent_cant_remove_or_rewrite_a_persons_show(with_person_show, correction):
    before = copy.deepcopy(with_person_show)
    with pytest.raises(rec.RecordInvalid, match="person") as caught:
        _fix(with_person_show, [correction], "agent")
    assert "extraction_request_read" in str(caught.value) and "another id" in str(caught.value)
    assert with_person_show == before
    assert rec.effective(with_person_show)["shows"]["p1"]["statement"] == "Warm paper ground"


def test_an_agent_cant_override_a_path_a_person_corrected_last(with_person_show):
    with pytest.raises(rec.RecordInvalid, match="A person corrected brand"):
        _fix(with_person_show, [{"path": "brand", "op": "set", "value": "beta"}], "agent")
    # A model's show a person edited is the person's on that path too.
    edited = _fix(with_person_show, [{"path": "shows.p1", "op": "set", "value": None}], "person")
    with pytest.raises(rec.RecordInvalid, match="person"):
        _fix(edited, [{"path": "shows.p1", "op": "set", "value": {"statement": "x", "evidence": ["P0"]}}], "agent")


def test_an_agent_can_still_add_its_own_show_and_correct_what_no_person_touched(with_person_show):
    updated = _fix(with_person_show, [
        {"path": "shows.a1", "op": "set", "value": {"statement": "One accent, on the button", "evidence": ["r6"]}},
        {"path": "structure.read.regions.r2.label", "op": "set", "value": "Nav"}], "agent")
    view = rec.effective(updated)
    assert view["shows"]["a1"]["origin"] == "agent" and view["shows"]["p1"]["origin"] == "person"
    again = _fix(updated, [{"path": "shows.a1.statement", "op": "set", "value": "One accent"}], "agent")
    assert rec.effective(again)["shows"]["a1"]["statement"] == "One accent"


def test_a_person_can_still_change_what_an_agent_did(with_person_show):
    agent = _fix(with_person_show, [
        {"path": "shows.a1", "op": "set", "value": {"statement": "From an agent", "evidence": ["P0"]}}], "agent")
    person = _fix(agent, [{"path": "shows.a1.statement", "op": "set", "value": "Fixed by a person"}], "person")
    assert rec.effective(person)["shows"]["a1"]["statement"] == "Fixed by a person"
    with pytest.raises(rec.RecordInvalid, match="person"):
        _fix(person, [{"path": "shows.a1.statement", "op": "set", "value": "Back again"}], "agent")


def test_an_agent_cant_reverse_a_persons_keyword(read_record):
    word = read_record["structure"]["read"]["reader_1"]["keywords"][0]
    person = _fix(read_record, [{"path": "structure.read.reader_1.keywords", "op": "remove", "value": word}], "person")
    with pytest.raises(rec.RecordInvalid, match="person"):
        _fix(person, [{"path": "structure.read.reader_1.keywords", "op": "add", "value": word}], "agent")
    other = read_record["structure"]["read"]["reader_1"]["keywords"][1]
    _fix(person, [{"path": "structure.read.reader_1.keywords", "op": "remove", "value": other}], "agent")


def test_a_record_approved_while_it_is_read_keeps_its_approval_and_gets_no_reading(folder, item):
    # The server checks approval before the model call; this is the check under the lock, after it.
    store.save(rec.build_record(item, clock=CLOCK), rendering_png(item.image), item.data, item.ext, folder)
    directory = folder / rec.record_id(hashlib.sha256(item.data).hexdigest())
    approved = store.load(directory)
    approved["status"], approved["approved_by"], approved["approved_at"] = "approved", "person", "2026-11-19T12:00:00Z"
    store.write(directory, approved)
    with pytest.raises(rec.RecordInvalid, match="approved while it was being read"):
        store.modify(directory, lambda fresh: reader.apply_read(fresh, item.image, landing_structured(), model="fake-reader"))
    after = store.load(directory)
    assert after["status"] == "approved" and after["structure"]["read"] is None



def test_a_persons_set_on_a_list_blocks_an_agents_add_or_remove_there(read_record):
    # Written straight into the record: the whitelist doesn't offer a set on keywords today, but a person's
    # set on a list or a parent path must still cover an agent's later add or remove under it.
    word = read_record["structure"]["read"]["reader_1"]["keywords"][0]
    record = copy.deepcopy(read_record)
    record["corrections"].append({"path": "structure.read.reader_1.keywords", "op": "set", "value": [word],
                                  "actor": "person", "at": "2026-11-19T12:00:00Z"})
    for op in ("add", "remove"):
        with pytest.raises(rec.RecordInvalid, match="A person corrected"):
            _fix(record, [{"path": "structure.read.reader_1.keywords", "op": op, "value": word}], "agent")


def test_an_agents_own_later_entry_doesnt_release_a_persons_choice(read_record):
    record = copy.deepcopy(read_record)
    record["corrections"] += [
        {"path": "brand", "op": "set", "value": "acme", "actor": "person", "at": "2026-11-19T12:00:00Z"},
        {"path": "brand", "op": "set", "value": "beta", "actor": "agent", "at": "2026-11-19T12:01:00Z"},
    ]
    with pytest.raises(rec.RecordInvalid, match="A person corrected brand"):
        _fix(record, [{"path": "brand", "op": "set", "value": "gamma"}], "agent")
