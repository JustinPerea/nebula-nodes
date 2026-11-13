"""PR #203 round 26, item 2: the settings temp folder's two refusals, by cause
(GM's strings, verbatim), and a folder at a file's name keeping its own line."""
from __future__ import annotations

import errno
import os
from pathlib import Path

import pytest

import main
from services import settings

CANT_USE = ("Nebula couldn’t save your settings because it can’t use the folder “.settings-nebula-tmp” next to "
            "them. Check that folder’s permissions, then try again.")
OTHER_DISK = ("Nebula couldn’t save your settings because “.settings-nebula-tmp” is on a different disk from "
              "them. Remove that folder, then try again.")


def _raised(tmp_path: Path, monkeypatch, real_stat_fails: bool) -> settings.SettingsUnwritable:
    target = tmp_path / "settings.json"
    folder = tmp_path / settings.TEMP_FOLDER
    folder.mkdir()
    temp = str(folder / "t")
    real = os.stat

    def stat(path, *args, **kwargs):
        if real_stat_fails:
            raise OSError(errno.EACCES, "denied")
        if Path(path) == target.parent:
            return os.stat_result((0,) * 2 + (999,) + (0,) * 7)  # a different st_dev
        return real(path, *args, **kwargs)

    with monkeypatch.context() as patch:
        patch.setattr(settings.os, "stat", stat)
        with pytest.raises(settings.SettingsUnwritable) as raised:
            settings._require_same_device(temp, target)
    return raised.value


def test_a_temp_folder_that_cant_be_checked_says_it_cant_be_used(tmp_path, monkeypatch):
    monkeypatch.setattr(main, "_settings_audience", lambda: "person")
    block = _raised(tmp_path, monkeypatch, True)
    assert block.cause == "temp_folder"
    refusal = main._unwritable_refusal(block)
    assert refusal.detail == CANT_USE and refusal.fields["code"] == "settings_unwritable"


def test_a_temp_folder_on_another_disk_says_so(tmp_path, monkeypatch):
    monkeypatch.setattr(main, "_settings_audience", lambda: "person")
    block = _raised(tmp_path, monkeypatch, False)
    assert block.cause == "temp_disk"
    assert main._unwritable_refusal(block).detail == OTHER_DISK


def test_the_agents_form_carries_the_same_cause(monkeypatch):
    monkeypatch.setattr(main, "_settings_audience", lambda: "agent")
    assert "Ask the person to check that folder’s permissions." in str(
        vars(main._unwritable_refusal(settings.SettingsUnwritable(errno.EPERM, "x", "/x", "temp_folder"))))
    assert "Ask the person to remove that folder." in str(
        vars(main._unwritable_refusal(settings.SettingsUnwritable(errno.EXDEV, "x", "/x", "temp_disk"))))


def test_a_real_folder_at_a_files_name_keeps_the_folder_in_the_way_line(monkeypatch):
    monkeypatch.setattr(main, "_settings_audience", lambda: "person")
    block = settings.SettingsUnwritable(errno.EEXIST, "x", "/h/.nebula/settings.json", "in_the_way")
    assert "is a folder, and Nebula needs to put a file there" in str(vars(main._unwritable_refusal(block)))
