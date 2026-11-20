"""``python -m extraction read``: a person at a terminal types the word; there is no --yes."""
from __future__ import annotations

import builtins
import sys

import pytest

from extraction import cli, intake, record as rec, store
from tests.extraction_fakes import LANDING, answering, block_real_spawn

pytestmark = pytest.mark.usefixtures("block_real_spawn")


@pytest.fixture
def saved(tmp_path):
    folder = tmp_path / "records"
    folder.mkdir()
    item = intake.intake(LANDING.read_bytes(), name="landing.png", kind="file")
    return store.save(rec.build_record(item), rec.rendering_png(item.image), item.data, item.ext, str(folder))["dir"]


@pytest.fixture
def spawner(monkeypatch):
    fake = answering()
    monkeypatch.setattr(cli, "_SPAWN", fake)
    return fake


def test_without_a_terminal_it_refuses_in_one_sentence(saved, spawner, capsys):
    assert cli._interactive() is False  # pytest's streams are not a terminal
    assert cli.main(["read", saved]) == 2
    err = capsys.readouterr().err
    assert "extraction page" in err and err.count("\n") == 1
    assert spawner.calls == []
    assert store.load(saved)["structure"]["read"] is None


def test_either_stream_not_a_terminal_refuses(saved, spawner, monkeypatch):
    class Tty:
        def __init__(self, tty):
            self._tty = tty

        def isatty(self):
            return self._tty

    for stdin, stdout in ((True, False), (False, True)):
        monkeypatch.setattr(sys, "stdin", Tty(stdin))
        monkeypatch.setattr(sys, "stdout", Tty(stdout))
        assert cli._interactive() is False
    monkeypatch.setattr(sys, "stdin", Tty(True))
    monkeypatch.setattr(sys, "stdout", Tty(True))
    assert cli._interactive() is True


def test_there_is_no_yes_flag():
    with pytest.raises(SystemExit):
        cli.build_parser().parse_args(["read", "somewhere", "--yes"])
    with pytest.raises(SystemExit):
        cli.build_parser().parse_args(["read", "somewhere", "-y"])
    help_text = cli.build_parser()._subparsers._group_actions[0].choices["read"].format_help()
    assert "--yes" not in help_text


def test_typing_anything_but_the_word_reads_nothing(saved, spawner, monkeypatch, capsys):
    monkeypatch.setattr(cli, "_interactive", lambda: True)
    monkeypatch.setattr(builtins, "input", lambda prompt="": "yes")
    assert cli.main(["read", saved]) == 1
    assert "Not read." in capsys.readouterr().out
    assert spawner.calls == [] and store.load(saved)["structure"]["read"] is None


def test_typing_the_word_reads_through_the_fake_process(saved, spawner, monkeypatch, capsys):
    monkeypatch.setattr(cli, "_interactive", lambda: True)
    prompts = []
    monkeypatch.setattr(builtins, "input", lambda prompt="": prompts.append(prompt) or "read")
    assert cli.main(["read", saved]) == 0
    out = capsys.readouterr().out
    assert "uses your Claude usage" in out and "10 regions" in out
    assert len(spawner.calls) == 1
    record = store.load(saved)
    assert record["structure"]["read"]["prompt_version"] == "extract-1" and len(record["shows"]) == 3
    # a record that has a read needs --again, and still asks
    assert cli.main(["read", saved]) == 2 and len(spawner.calls) == 1
    assert cli.main(["read", saved, "--again"]) == 0 and len(spawner.calls) == 2


def test_a_failed_read_is_a_sentence_and_changes_nothing(saved, monkeypatch, capsys):
    from tests.extraction_fakes import failing

    monkeypatch.setattr(cli, "_SPAWN", failing())
    monkeypatch.setattr(cli, "_interactive", lambda: True)
    monkeypatch.setattr(builtins, "input", lambda prompt="": "read")
    assert cli.main(["read", saved]) == 2
    assert "didn’t answer" in capsys.readouterr().err
    assert store.load(saved)["structure"]["read"] is None
