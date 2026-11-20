"""``python -m extraction``, through ``main(argv)``."""
from __future__ import annotations

import json
from pathlib import Path

import pytest

from extraction.cli import main

FIXTURES = Path(__file__).parent / "fixtures" / "extraction"
IMAGE = str(FIXTURES / "gradient_accent.png")


@pytest.fixture
def folder(tmp_path):
    path = tmp_path / "records"
    path.mkdir()
    return path


def test_measure_list_and_show(folder, capsys):
    assert main(["measure", IMAGE, "--out", str(folder)]) == 0
    out = capsys.readouterr().out.splitlines()
    assert out[0].startswith("ex_") and "96x64" in out[0] and "1 accent" in out[0]
    assert out[1].startswith("saved: ") and len(out) == 2
    record_id = out[0].split()[0]

    assert main(["list", str(folder)]) == 0
    assert capsys.readouterr().out.split()[:2] == [record_id, "96x64"]

    assert main(["show", str(folder / record_id)]) == 0
    shown = capsys.readouterr().out
    assert "source: file gradient_accent.png" in shown and "#e61e28" in shown

    assert main(["list", str(folder), "--json"]) == 0
    assert json.loads(capsys.readouterr().out)[0]["id"] == record_id
    assert main(["show", str(folder / record_id / "record.json"), "--json"]) == 0
    record = json.loads(capsys.readouterr().out)
    assert record["id"] == record_id and record["source"]["path"] == str(Path(IMAGE).resolve())
    assert record["source"]["mtime"].endswith("Z") and record["status"] == "proposal"


def test_measure_json_twice_and_replace(folder, capsys):
    assert main(["measure", IMAGE, "--out", str(folder), "--json"]) == 0
    first = json.loads(capsys.readouterr().out)
    assert first["existed"] is False and first["record"]["id"].startswith("ex_")
    assert main(["measure", IMAGE, "--out", str(folder), "--json"]) == 0
    assert json.loads(capsys.readouterr().out)["existed"] is True
    assert main(["measure", IMAGE, "--out", str(folder), "--replace"]) == 0
    assert "replaced" in capsys.readouterr().out


def test_show_effective_applies_corrections(folder, capsys):
    from extraction import store

    main(["measure", IMAGE, "--out", str(folder)])
    record_id = capsys.readouterr().out.split()[0]
    store.correct(folder / record_id, [{"path": "brand", "op": "set", "value": "acme"}], "person")
    assert main(["show", str(folder / record_id), "--json", "--effective"]) == 0
    assert json.loads(capsys.readouterr().out)["brand"] == "acme"
    assert main(["show", str(folder / record_id), "--json"]) == 0
    assert json.loads(capsys.readouterr().out)["brand"] is None


def test_an_empty_folder_says_so(folder, capsys):
    assert main(["list", str(folder)]) == 0
    assert capsys.readouterr().out.strip() == "No records in that folder."


@pytest.mark.parametrize("argv_for", [
    lambda t, f: ["measure", str(t / "missing.png"), "--out", str(f)],
    lambda t, f: ["measure", IMAGE, "--out", str(t / "missing-folder")],
    lambda t, f: ["measure", str(t / "clip.mp4"), "--out", str(f)],
    lambda t, f: ["show", str(f / "ex_0000000000000000")],
    lambda t, f: ["list", str(t / "missing-folder")],
])
def test_refusals_print_one_line_and_exit_2(tmp_path, folder, capsys, argv_for):
    (tmp_path / "clip.mp4").write_bytes(b"\x00\x00\x00\x18ftypmp42" + b"\x00" * 64)
    assert main(argv_for(tmp_path, folder)) == 2
    captured = capsys.readouterr()
    assert captured.out == "" and captured.err.startswith("extraction: ") and captured.err.count("\n") == 1
