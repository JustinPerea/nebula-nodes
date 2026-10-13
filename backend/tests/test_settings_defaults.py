"""load_settings() fills in defaults for keys a settings.json leaves out.

A settings.json holding ``{}`` (hand-written, or older than a setting) made
GET /api/settings return no ``apiKeys``, and the Settings panel showed
"Settings couldn't load". Loading must merge DEFAULT_SETTINGS under the
saved values, keep every saved value, and never write the file.
"""
from __future__ import annotations

import json
import os
from pathlib import Path

import pytest

from services import settings as settings_mod


@pytest.fixture
def settings_file(tmp_path: Path, monkeypatch: pytest.MonkeyPatch) -> Path:
    path = tmp_path / "settings.json"
    monkeypatch.setattr(settings_mod, "SETTINGS_PATH", path)
    monkeypatch.setattr(settings_mod, "_INJECTED_KEYS", {})
    return path


def _write(path: Path, data: object) -> tuple[bytes, int]:
    path.write_text(json.dumps(data))
    os.utime(path, ns=(1_000_000_000_000_000_000, 1_000_000_000_000_000_000))
    return path.read_bytes(), path.stat().st_mtime_ns


def test_an_empty_settings_file_loads_every_default(settings_file: Path) -> None:
    _write(settings_file, {})
    loaded = settings_mod.load_settings()
    assert loaded == settings_mod.DEFAULT_SETTINGS
    assert loaded["apiKeys"] == {}


def test_saved_values_win_over_defaults(settings_file: Path) -> None:
    _write(settings_file, {
        "apiKeys": {"FAL_KEY": "fal-saved"},
        "executionMode": "auto",
        "outputPath": "/tmp/out",
        "somethingNewer": 3,
    })
    loaded = settings_mod.load_settings()
    assert loaded["apiKeys"] == {"FAL_KEY": "fal-saved"}
    assert loaded["executionMode"] == "auto"
    assert loaded["outputPath"] == "/tmp/out"
    assert loaded["somethingNewer"] == 3
    # Keys the file leaves out come from the defaults.
    assert loaded["batchSizeCap"] == settings_mod.DEFAULT_SETTINGS["batchSizeCap"]
    assert loaded["routing"] == {}


def test_loading_never_writes_the_file(settings_file: Path) -> None:
    before_bytes, before_mtime = _write(settings_file, {"executionMode": "auto"})
    settings_mod.load_settings()
    settings_mod.load_settings()
    assert settings_file.read_bytes() == before_bytes
    assert settings_file.stat().st_mtime_ns == before_mtime


def test_a_missing_file_still_loads_defaults_without_creating_it(settings_file: Path) -> None:
    assert settings_mod.load_settings() == settings_mod.DEFAULT_SETTINGS
    assert not settings_file.exists()


def test_changing_loaded_settings_never_changes_the_defaults(settings_file: Path) -> None:
    _write(settings_file, {})
    loaded = settings_mod.load_settings()
    loaded["apiKeys"]["FAL_KEY"] = "leak"
    loaded["routing"]["x"] = "y"
    assert settings_mod.DEFAULT_SETTINGS["apiKeys"] == {}
    assert settings_mod.DEFAULT_SETTINGS["routing"] == {}
    assert settings_mod.load_settings()["apiKeys"] == {}


def test_get_api_settings_answers_for_an_empty_file(settings_file: Path) -> None:
    from fastapi.testclient import TestClient
    from main import app

    before_bytes, before_mtime = _write(settings_file, {})
    response = TestClient(app).get("/api/settings")
    assert response.status_code == 200
    body = response.json()
    assert body["apiKeys"] == {}
    assert body["executionMode"] == settings_mod.DEFAULT_SETTINGS["executionMode"]
    assert settings_file.read_bytes() == before_bytes
    assert settings_file.stat().st_mtime_ns == before_mtime
