"""Tests for NEBULA_SETTINGS_PATH env var support in settings.py.

Covers VAL-MIG-003, VAL-MIG-011:
  - SETTINGS_PATH defaults to repo root when NEBULA_SETTINGS_PATH is not set
  - SETTINGS_PATH reads from NEBULA_SETTINGS_PATH env var when set
  - load_settings reads from the env-specified path
  - save_settings writes to the env-specified path
  - get_api_key uses the env-specified settings file
  - Browser mode (no env var) uses repo root settings.json
"""

from __future__ import annotations

import importlib
import json
from pathlib import Path

import pytest


# ---------------------------------------------------------------------------
# Autouse fixture: restore settings module after each test
# ---------------------------------------------------------------------------

@pytest.fixture(autouse=True)
def _restore_settings_module(monkeypatch):
    """Reload settings module with a clean env after each test so the
    module-level SETTINGS_PATH constant is restored to its repo-root default.
    Without this, a test that sets NEBULA_SETTINGS_PATH and reloads would
    leave the constant pointing at a temp path for subsequent tests.
    """
    yield
    monkeypatch.delenv("NEBULA_SETTINGS_PATH", raising=False)
    import services.settings as _s
    importlib.reload(_s)


# ---------------------------------------------------------------------------
# SETTINGS_PATH resolution
# ---------------------------------------------------------------------------

class TestSettingsPathResolution:
    """VAL-MIG-003, VAL-MIG-011: SETTINGS_PATH env var support."""

    def test_defaults_to_repo_root_without_env_var(self, monkeypatch):
        """Without NEBULA_SETTINGS_PATH, SETTINGS_PATH is the repo-root
        settings.json — the original hardcoded behaviour."""
        monkeypatch.delenv("NEBULA_SETTINGS_PATH", raising=False)
        import services.settings as settings_mod
        importlib.reload(settings_mod)

        # settings.py is at backend/services/settings.py → parent³ = repo root.
        # This test file is at backend/tests/test_settings_path.py → parent³
        # also = repo root, so the expected path matches.
        expected = (
            Path(__file__).resolve().parent.parent.parent / "settings.json"
        )
        assert settings_mod.SETTINGS_PATH == expected

    def test_uses_env_var_when_set(self, monkeypatch, tmp_path):
        """With NEBULA_SETTINGS_PATH set, SETTINGS_PATH follows it."""
        custom = tmp_path / "appsupport" / "settings.json"
        monkeypatch.setenv("NEBULA_SETTINGS_PATH", str(custom))

        import services.settings as settings_mod
        importlib.reload(settings_mod)

        assert settings_mod.SETTINGS_PATH == custom

    def test_env_var_path_is_not_repo_root(self, monkeypatch, tmp_path):
        """The env-specified path should not coincide with the repo-root
        fallback."""
        custom = tmp_path / "custom-settings.json"
        monkeypatch.setenv("NEBULA_SETTINGS_PATH", str(custom))

        import services.settings as settings_mod
        importlib.reload(settings_mod)

        repo_root = (
            Path(__file__).resolve().parent.parent.parent / "settings.json"
        )
        assert settings_mod.SETTINGS_PATH != repo_root

    def test_browser_mode_path_has_no_app_support(self, monkeypatch):
        """In browser mode the path must not contain 'Application Support'."""
        monkeypatch.delenv("NEBULA_SETTINGS_PATH", raising=False)
        import services.settings as settings_mod
        importlib.reload(settings_mod)

        assert "Application Support" not in str(settings_mod.SETTINGS_PATH)


# ---------------------------------------------------------------------------
# load_settings from env-specified path
# ---------------------------------------------------------------------------

class TestLoadSettingsFromEnvPath:
    """VAL-MIG-003: Desktop settings load from App Support."""

    def test_load_reads_from_env_path(self, monkeypatch, tmp_path):
        """load_settings reads the file at NEBULA_SETTINGS_PATH."""
        custom = tmp_path / "settings.json"
        custom_settings = {
            "apiKeys": {},
            "outputPath": "/custom/output",
            "executionMode": "auto",
        }
        custom.write_text(json.dumps(custom_settings))

        monkeypatch.setenv("NEBULA_SETTINGS_PATH", str(custom))
        import services.settings as settings_mod
        importlib.reload(settings_mod)

        loaded = settings_mod.load_settings()
        assert loaded["outputPath"] == "/custom/output"
        assert loaded["executionMode"] == "auto"

    def test_load_returns_defaults_when_env_path_missing(self, monkeypatch, tmp_path):
        """When the env-specified file does not exist, defaults are returned."""
        missing = tmp_path / "nonexistent" / "settings.json"
        monkeypatch.setenv("NEBULA_SETTINGS_PATH", str(missing))

        import services.settings as settings_mod
        importlib.reload(settings_mod)

        loaded = settings_mod.load_settings()
        assert loaded == settings_mod.DEFAULT_SETTINGS

    def test_load_ignores_legacy_repo_file_when_env_set(self, monkeypatch, tmp_path):
        """When NEBULA_SETTINGS_PATH is set, the legacy repo-root settings.json
        is NOT consulted — only the env-specified file is read."""
        custom = tmp_path / "appsupport-settings.json"
        custom_settings = {"apiKeys": {}, "outputPath": "/from-appsupport"}
        custom.write_text(json.dumps(custom_settings))

        monkeypatch.setenv("NEBULA_SETTINGS_PATH", str(custom))
        import services.settings as settings_mod
        importlib.reload(settings_mod)

        loaded = settings_mod.load_settings()
        assert loaded["outputPath"] == "/from-appsupport"

        # Verify the SETTINGS_PATH is not the repo root
        repo_root = (
            Path(__file__).resolve().parent.parent.parent / "settings.json"
        )
        assert settings_mod.SETTINGS_PATH != repo_root


# ---------------------------------------------------------------------------
# save_settings to env-specified path
# ---------------------------------------------------------------------------

class TestSaveSettingsToEnvPath:
    """VAL-MIG-003: save_settings writes to the env-specified path."""

    def test_save_writes_to_env_path(self, monkeypatch, tmp_path):
        """save_settings writes to NEBULA_SETTINGS_PATH, not repo root."""
        custom = tmp_path / "settings.json"
        monkeypatch.setenv("NEBULA_SETTINGS_PATH", str(custom))

        import services.settings as settings_mod
        importlib.reload(settings_mod)

        test_data = {"apiKeys": {}, "outputPath": "/saved/output"}
        settings_mod.save_settings(test_data)

        assert custom.exists()
        saved = json.loads(custom.read_text())
        assert saved["outputPath"] == "/saved/output"

    def test_save_does_not_write_to_repo_root(self, monkeypatch, tmp_path):
        """save_settings with env path must not touch the repo-root file."""
        custom = tmp_path / "appsupport" / "settings.json"
        custom.parent.mkdir(parents=True)
        monkeypatch.setenv("NEBULA_SETTINGS_PATH", str(custom))

        import services.settings as settings_mod
        importlib.reload(settings_mod)

        repo_root = (
            Path(__file__).resolve().parent.parent.parent / "settings.json"
        )
        # Read repo-root content before save (if it exists)
        repo_before = repo_root.read_text() if repo_root.exists() else None

        settings_mod.save_settings({"apiKeys": {}, "outputPath": "/test"})

        # Repo-root file should be unchanged
        repo_after = repo_root.read_text() if repo_root.exists() else None
        assert repo_before == repo_after


# ---------------------------------------------------------------------------
# get_api_key with env-specified path
# ---------------------------------------------------------------------------

class TestGetApiKeyFromEnvPath:
    """VAL-MIG-003: get_api_key reads from the env-specified settings file."""

    def test_get_api_key_reads_from_env_path(self, monkeypatch, tmp_path):
        """get_api_key returns a key stored in the env-specified settings file."""
        fake_key = "test-" + "key-value-12345678"
        custom = tmp_path / "settings.json"
        custom.write_text(json.dumps({"apiKeys": {"OPENAI_API_KEY": fake_key}}))

        monkeypatch.setenv("NEBULA_SETTINGS_PATH", str(custom))
        import services.settings as settings_mod
        importlib.reload(settings_mod)

        assert settings_mod.get_api_key("OPENAI_API_KEY") == fake_key

    def test_get_api_key_returns_none_for_missing_provider(self, monkeypatch, tmp_path):
        """get_api_key returns None when the provider is not in the env file."""
        custom = tmp_path / "settings.json"
        custom.write_text(json.dumps({"apiKeys": {}}))

        monkeypatch.setenv("NEBULA_SETTINGS_PATH", str(custom))
        import services.settings as settings_mod
        importlib.reload(settings_mod)

        assert settings_mod.get_api_key("OPENAI_API_KEY") is None

    def test_get_api_key_fallback_list_from_env_path(self, monkeypatch, tmp_path):
        """get_api_key tries a list of provider names from the env file."""
        fake_key = "test-" + "fallback-key-87654321"
        custom = tmp_path / "settings.json"
        custom.write_text(
            json.dumps({"apiKeys": {"FAL_KEY": fake_key}})
        )

        monkeypatch.setenv("NEBULA_SETTINGS_PATH", str(custom))
        import services.settings as settings_mod
        importlib.reload(settings_mod)

        # First name missing, second name found
        assert settings_mod.get_api_key(["NONEXISTENT_KEY", "FAL_KEY"]) == fake_key


# ---------------------------------------------------------------------------
# Browser mode fallback — VAL-MIG-011
# ---------------------------------------------------------------------------

class TestBrowserModeFallback:
    """VAL-MIG-011: Browser/dev mode uses repo-root settings.json."""

    def test_no_env_var_uses_repo_root(self, monkeypatch):
        """Without NEBULA_SETTINGS_PATH, SETTINGS_PATH is the repo-root path."""
        monkeypatch.delenv("NEBULA_SETTINGS_PATH", raising=False)
        import services.settings as settings_mod
        importlib.reload(settings_mod)

        expected = (
            Path(__file__).resolve().parent.parent.parent / "settings.json"
        )
        assert settings_mod.SETTINGS_PATH == expected

    def test_no_env_var_does_not_point_to_app_support(self, monkeypatch):
        """Browser mode path must not contain 'Application Support'."""
        monkeypatch.delenv("NEBULA_SETTINGS_PATH", raising=False)
        import services.settings as settings_mod
        importlib.reload(settings_mod)

        assert "Application Support" not in str(settings_mod.SETTINGS_PATH)
