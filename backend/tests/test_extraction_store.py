"""The store: safe folders, atomic writes, reload, and saving twice."""
from __future__ import annotations

import json
import os
from datetime import datetime, timezone
from pathlib import Path

import pytest

from extraction import record as rec
from extraction import store
from extraction.errors import StoreRefused
from extraction.intake import intake, rendering_png

FIXTURES = Path(__file__).parent / "fixtures" / "extraction"
CLOCK = lambda: datetime(2026, 11, 19, 12, 30, 5, tzinfo=timezone.utc)  # noqa: E731


def _made(name="gradient_accent.png"):
    item = intake((FIXTURES / name).read_bytes(), name=name)
    return rec.build_record(item, clock=CLOCK), rendering_png(item.image), item.data, item.ext


def _save(folder, name="gradient_accent.png", **kwargs):
    record, png, data, ext = _made(name)
    return store.save(record, png, data, ext, folder, **kwargs)


@pytest.fixture
def folder(tmp_path):
    path = tmp_path / "records"
    path.mkdir()
    return path


def test_save_and_reload_round_trip(folder):
    saved = _save(folder)
    assert saved["existed"] is False
    directory = folder / saved["record"]["id"]
    assert sorted(p.name for p in directory.iterdir()) == ["record.json", "rendering.png", "source.png"]
    assert (directory / "source.png").read_bytes() == (FIXTURES / "gradient_accent.png").read_bytes()
    assert json.loads((directory / "record.json").read_text()) == saved["record"]
    assert store.load(directory) == saved["record"] == store.load(directory / "record.json")
    assert [r["id"] for r in store.list_records(folder)] == [saved["record"]["id"]]


def test_nothing_is_left_behind_by_the_atomic_writes(folder):
    saved = _save(folder)
    store.correct(folder / saved["record"]["id"], [{"path": "brand", "op": "set", "value": "acme"}], "person")
    names = sorted(p.name for p in (folder / saved["record"]["id"]).iterdir())
    assert names == ["record.json", "rendering.png", "source.png"]


def test_a_failed_write_leaves_the_old_record_and_no_temp_file(folder, monkeypatch):
    saved = _save(folder)
    directory = folder / saved["record"]["id"]
    before = (directory / "record.json").read_bytes()
    monkeypatch.setattr(os, "replace", lambda *a, **k: (_ for _ in ()).throw(OSError("disk full")))
    with pytest.raises(OSError):
        store.correct(directory, [{"path": "brand", "op": "set", "value": "acme"}], "person")
    monkeypatch.undo()
    assert (directory / "record.json").read_bytes() == before
    assert [p.name for p in directory.iterdir() if p.name.startswith(".tmp")] == []


def test_saving_twice_keeps_the_record_and_its_corrections(folder):
    first = _save(folder)
    directory = folder / first["record"]["id"]
    store.correct(directory, [{"path": "brand", "op": "set", "value": "acme", "reason": "mine"}], "person", clock=CLOCK)
    again = _save(folder)
    assert again["existed"] is True
    assert again["record"]["corrections"][0]["value"] == "acme"
    assert store.load(directory)["corrections"][0]["actor"] == "person"


def test_replace_measures_again_but_keeps_corrections(folder):
    first = _save(folder)
    directory = folder / first["record"]["id"]
    store.correct(directory, [{"path": "brand", "op": "set", "value": "acme"}], "agent")
    record, png, data, ext = _made()
    record["source"]["name"] = "renamed.png"
    replaced = store.save(record, png, data, ext, folder, replace=True)
    assert replaced["existed"] is True and replaced["record"]["source"]["name"] == "renamed.png"
    assert [c["value"] for c in store.load(directory)["corrections"]] == ["acme"]


def test_an_approved_record_is_not_replaced(folder):
    first = _save(folder)
    path = folder / first["record"]["id"] / "record.json"
    approved = json.loads(path.read_text())
    approved.update(status="approved", approved_by="justin", approved_at="2026-11-19T00:00:00Z")
    path.write_text(json.dumps(approved))
    with pytest.raises(StoreRefused, match="approved"):
        _save(folder, replace=True)


def test_list_orders_newest_first_and_ignores_other_entries(folder):
    a = _save(folder, "one_pixel.png")["record"]
    b = _save(folder, "gradient_accent.png")["record"]
    (folder / "notes.txt").write_text("hi")
    (folder / "ex_not_a_record").mkdir()
    rows = store.list_records(folder)
    assert {r["id"] for r in rows} == {a["id"], b["id"]}
    assert rows[0]["read_at"] >= rows[1]["read_at"]
    assert rows[0]["colors"] >= 1 and "corrections" in rows[0]


# -- refusals -----------------------------------------------------------------------------------


def test_a_missing_folder_is_refused(tmp_path):
    with pytest.raises(StoreRefused, match="doesn't exist"):
        _save(tmp_path / "nope")
    assert not (tmp_path / "nope").exists()


def test_a_file_is_not_a_folder(tmp_path):
    path = tmp_path / "file.txt"
    path.write_text("x")
    with pytest.raises(StoreRefused, match="file, not a folder"):
        _save(path)


def test_the_state_folder_is_refused(tmp_path, monkeypatch):
    state = tmp_path / "fake-state"
    (state / "inside").mkdir(parents=True)
    monkeypatch.setenv("NEBULA_STATE_DIR", str(state))
    for target in (state, state / "inside"):
        with pytest.raises(StoreRefused, match="state folder"):
            _save(target)
    with pytest.raises(StoreRefused, match="state folder"):
        store.list_records(state)


def test_the_state_folder_is_refused_in_another_case(tmp_path, monkeypatch):
    # APFS ignores case, so a differently cased path names the same folder.
    state = tmp_path / "fake-state"
    state.mkdir()
    monkeypatch.setenv("NEBULA_STATE_DIR", str(state))
    assert store._inside(str(tmp_path / "FAKE-State" / "x"), state.resolve())


def test_a_dot_nebula_folder_in_the_home_is_refused(tmp_path, monkeypatch):
    home = tmp_path / "home"
    (home / ".nebula" / "x").mkdir(parents=True)
    monkeypatch.setenv("HOME", str(home))
    with pytest.raises(StoreRefused, match="state folder"):
        _save(home / ".nebula" / "x")


def test_the_repo_is_refused():
    with pytest.raises(StoreRefused, match="source folder"):
        _save(store.REPO_ROOT / "backend")
    with pytest.raises(StoreRefused, match="source folder"):
        store.list_records(store.REPO_ROOT)


def test_a_symlinked_folder_into_a_refused_place_is_refused(tmp_path, monkeypatch):
    state = tmp_path / "state"
    state.mkdir()
    monkeypatch.setenv("NEBULA_STATE_DIR", str(state))
    link = tmp_path / "link"
    link.symlink_to(state)
    with pytest.raises(StoreRefused, match="state folder"):
        _save(link)


def test_a_record_directory_that_is_a_symlink_is_refused(tmp_path, folder):
    record = _made()[0]
    outside = tmp_path / "outside"
    outside.mkdir()
    (folder / record["id"]).symlink_to(outside)
    with pytest.raises(StoreRefused, match="symlink"):
        _save(folder)
    assert list(outside.iterdir()) == []
    with pytest.raises(StoreRefused, match="symlink"):
        store.load(folder / record["id"])
    assert store.list_records(folder) == [{"id": record["id"], "error": "That record's folder is a symlink, so it won't be used."}]


def test_a_record_json_symlink_is_refused_on_read_and_write(tmp_path, folder):
    saved = _save(folder)
    directory = folder / saved["record"]["id"]
    real = tmp_path / "real.json"
    real.write_text((directory / "record.json").read_text())
    (directory / "record.json").unlink()
    (directory / "record.json").symlink_to(real)
    with pytest.raises(StoreRefused, match="symlink"):
        store.load(directory)
    with pytest.raises(StoreRefused, match="symlink"):
        store.correct(directory, [{"path": "brand", "op": "set", "value": "a"}], "person")
    with pytest.raises(StoreRefused, match="symlink"):
        _save(folder, replace=True)
    assert json.loads(real.read_text())["corrections"] == []


def test_a_symlinked_rendering_is_not_followed_out(tmp_path, folder):
    record = _made()[0]
    directory = folder / record["id"]
    directory.mkdir()
    victim = tmp_path / "victim.txt"
    victim.write_text("keep")
    (directory / "rendering.png").symlink_to(victim)
    with pytest.raises(StoreRefused, match="symlink"):
        _save(folder)
    assert victim.read_text() == "keep"


def test_a_record_whose_folder_name_isnt_its_id_is_refused(folder):
    saved = _save(folder)
    directory = folder / saved["record"]["id"]
    other = folder / "ex_0000000000000000"
    directory.rename(other)
    with pytest.raises(StoreRefused, match="doesn't match"):
        store.load(other)


def test_bad_json_and_bad_records_are_refused(folder):
    saved = _save(folder)
    path = folder / saved["record"]["id"] / "record.json"
    path.write_text("{ not json")
    with pytest.raises(StoreRefused, match="JSON"):
        store.load(path)
    path.write_text(json.dumps({"schema": "x"}))
    with pytest.raises(StoreRefused, match="schema"):
        store.load(path)
    rows = store.list_records(folder)
    assert rows[0]["id"] == saved["record"]["id"] and "error" in rows[0]


def test_a_folder_is_not_a_record_and_bad_inputs_to_save(folder):
    with pytest.raises(StoreRefused, match="isn't a record id"):
        store.load(folder)
    record, png, data, ext = _made()
    with pytest.raises(StoreRefused, match="file type"):
        store.save(record, png, data, "svg", folder)
    with pytest.raises(StoreRefused, match="PNG"):
        store.save(record, b"not a png", data, ext, folder)
    with pytest.raises(rec.RecordInvalid):
        store.save({"schema": "x"}, png, data, ext, folder)
