"""Tests for backend credential injection — NEBULA_INJECTED_KEYS env var.

Covers validation contract assertions:
- VAL-INJECT-001: Desktop startup injects decrypted credentials
- VAL-INJECT-002: Missing injection leaves the in-memory store empty
- VAL-INJECT-003: Desktop settings merge gives injected keys precedence
- VAL-INJECT-004: Injected credentials work without a settings-file read
- VAL-INJECT-006: Credential updates take effect without restart
- VAL-INJECT-007: Desktop settings masks injected credentials
- VAL-INJECT-008: Desktop settings PUT cannot overwrite credentials
- VAL-INJECT-009: Browser mode resolves credentials from settings.json
- VAL-INJECT-010: Browser mode masks file-based credentials
- VAL-INJECT-011: Backend logs never contain API keys
"""

from __future__ import annotations

import importlib
import io
import json
import logging
import sys
from pathlib import Path

import pytest

sys.path.insert(0, str(Path(__file__).resolve().parent.parent))

# The 16-key allowlist (must match architecture.md / environment.md).
ALLOWED_PROVIDERS = {
    "ANTHROPIC_API_KEY",
    "ELEVENLABS_API_KEY",
    "FAL_KEY",
    "GOOGLE_API_KEY",
    "HIGGSFIELD_API_KEY",
    "IDEOGRAM_API_KEY",
    "KREA_API_TOKEN",
    "MESHY_API_KEY",
    "MINIMAX_API_KEY",
    "OPENAI_API_KEY",
    "OPENROUTER_API_KEY",
    "QUIVER_API_KEY",
    "REPLICATE_API_TOKEN",
    "RUNWAY_API_KEY",
    "XAI_API_KEY",
    "WORLDLABS_API_KEY",
}


# ---------------------------------------------------------------------------
# Autouse fixture: restore settings module after each test
# ---------------------------------------------------------------------------

@pytest.fixture(autouse=True)
def _restore_settings_module(monkeypatch):
    """Reload settings module with a clean env after each test so the
    module-level _INJECTED_KEYS and SETTINGS_PATH are restored."""
    yield
    monkeypatch.delenv("NEBULA_INJECTED_KEYS", raising=False)
    monkeypatch.delenv("NEBULA_SETTINGS_PATH", raising=False)
    import services.settings as _s
    importlib.reload(_s)


# ---------------------------------------------------------------------------
# Helpers
# ---------------------------------------------------------------------------

def _reload_settings(monkeypatch, *, injected=None, settings_path=None):
    """Reload the settings module with the given env vars, returning the
    freshly-imported module."""
    if injected is not None:
        monkeypatch.setenv("NEBULA_INJECTED_KEYS", json.dumps(injected))
    else:
        monkeypatch.delenv("NEBULA_INJECTED_KEYS", raising=False)
    if settings_path is not None:
        monkeypatch.setenv("NEBULA_SETTINGS_PATH", str(settings_path))
    else:
        monkeypatch.delenv("NEBULA_SETTINGS_PATH", raising=False)
    import services.settings as settings_mod
    importlib.reload(settings_mod)
    return settings_mod


def _write_settings(path: Path, data: dict) -> None:
    path.parent.mkdir(parents=True, exist_ok=True)
    path.write_text(json.dumps(data))


# ===================================================================
# Part 1: Injection parsing at import time
# ===================================================================

class TestInjectionParsing:
    """VAL-INJECT-001: Desktop startup injects decrypted credentials."""

    def test_injected_keys_parsed_at_import_time(self, monkeypatch):
        """NEBULA_INJECTED_KEYS JSON dict is parsed into _INJECTED_KEYS."""
        injected = {
            "OPENAI_API_KEY": "sk-test-key-12345678",
            "FAL_KEY": "fal-test-key-87654321",
        }
        settings_mod = _reload_settings(monkeypatch, injected=injected)

        assert settings_mod._INJECTED_KEYS == injected
        assert settings_mod.is_injected_mode() is True

    def test_empty_env_var_yields_empty_dict(self, monkeypatch):
        """Empty JSON dict in NEBULA_INJECTED_KEYS → empty _INJECTED_KEYS."""
        settings_mod = _reload_settings(monkeypatch, injected={})
        assert settings_mod._INJECTED_KEYS == {}
        assert settings_mod.is_injected_mode() is False

    def test_malformed_json_ignored_safely(self, monkeypatch):
        """Malformed JSON in NEBULA_INJECTED_KEYS → empty dict, no crash."""
        monkeypatch.setenv("NEBULA_INJECTED_KEYS", "not-valid-json{{{")
        monkeypatch.delenv("NEBULA_SETTINGS_PATH", raising=False)
        import services.settings as settings_mod
        importlib.reload(settings_mod)

        assert settings_mod._INJECTED_KEYS == {}
        assert settings_mod.is_injected_mode() is False

    def test_non_dict_json_ignored_safely(self, monkeypatch):
        """A JSON list or scalar instead of a dict → empty _INJECTED_KEYS."""
        monkeypatch.setenv("NEBULA_INJECTED_KEYS", '["not", "a", "dict"]')
        monkeypatch.delenv("NEBULA_SETTINGS_PATH", raising=False)
        import services.settings as settings_mod
        importlib.reload(settings_mod)

        assert settings_mod._INJECTED_KEYS == {}

    def test_empty_string_values_filtered(self, monkeypatch):
        """Empty-string key values are filtered out of _INJECTED_KEYS."""
        injected = {"OPENAI_API_KEY": "sk-real-key", "FAL_KEY": ""}
        settings_mod = _reload_settings(monkeypatch, injected=injected)

        assert "OPENAI_API_KEY" in settings_mod._INJECTED_KEYS
        assert "FAL_KEY" not in settings_mod._INJECTED_KEYS
        assert settings_mod._INJECTED_KEYS["OPENAI_API_KEY"] == "sk-real-key"

    def test_no_file_substitution_for_missing_provider(self, monkeypatch, tmp_path):
        """VAL-INJECT-001: A provider in the file but NOT in the injection
        must not be silently substituted into _INJECTED_KEYS."""
        settings_file = tmp_path / "settings.json"
        _write_settings(settings_file, {
            "apiKeys": {"OPENAI_API_KEY": "file-key-should-not-appear"},
        })

        injected = {"FAL_KEY": "fal-injected-key"}
        settings_mod = _reload_settings(
            monkeypatch, injected=injected, settings_path=settings_file
        )

        # Only the injected key is in _INJECTED_KEYS
        assert settings_mod._INJECTED_KEYS == {"FAL_KEY": "fal-injected-key"}
        # The file-only key is NOT in _INJECTED_KEYS
        assert "OPENAI_API_KEY" not in settings_mod._INJECTED_KEYS


class TestEmptyInjection:
    """VAL-INJECT-002: Missing injection leaves the in-memory store empty."""

    def test_no_env_var_yields_empty_dict(self, monkeypatch):
        """With NEBULA_INJECTED_KEYS absent, _INJECTED_KEYS must be {}."""
        monkeypatch.delenv("NEBULA_INJECTED_KEYS", raising=False)
        monkeypatch.delenv("NEBULA_SETTINGS_PATH", raising=False)
        import services.settings as settings_mod
        importlib.reload(settings_mod)

        assert settings_mod._INJECTED_KEYS == {}
        assert settings_mod.is_injected_mode() is False

    def test_empty_string_env_var_yields_empty_dict(self, monkeypatch):
        """With NEBULA_INJECTED_KEYS set to empty string, _INJECTED_KEYS
        must be {}."""
        monkeypatch.setenv("NEBULA_INJECTED_KEYS", "")
        monkeypatch.delenv("NEBULA_SETTINGS_PATH", raising=False)
        import services.settings as settings_mod
        importlib.reload(settings_mod)

        assert settings_mod._INJECTED_KEYS == {}
        assert settings_mod.is_injected_mode() is False


# ===================================================================
# Part 2: load_settings merge behaviour
# ===================================================================

class TestMergePrecedence:
    """VAL-INJECT-003: Desktop settings merge gives injected keys precedence."""

    def test_injected_keys_override_file_based(self, monkeypatch, tmp_path):
        """When injected and file-based keys conflict, injected wins."""
        settings_file = tmp_path / "settings.json"
        _write_settings(settings_file, {
            "apiKeys": {"OPENAI_API_KEY": "file-key-should-be-ignored"},
            "outputPath": "/custom/output",
            "executionMode": "auto",
        })

        injected = {"OPENAI_API_KEY": "injected-key-wins"}
        settings_mod = _reload_settings(
            monkeypatch, injected=injected, settings_path=settings_file
        )

        loaded = settings_mod.load_settings()
        assert loaded["apiKeys"]["OPENAI_API_KEY"] == "injected-key-wins"
        # Non-secret settings from file remain available
        assert loaded["outputPath"] == "/custom/output"
        assert loaded["executionMode"] == "auto"

    def test_file_based_apikeys_fully_replaced_by_injected(self, monkeypatch, tmp_path):
        """In desktop mode, file-based apiKeys are entirely replaced — not
        merged — by the injected keys."""
        settings_file = tmp_path / "settings.json"
        _write_settings(settings_file, {
            "apiKeys": {
                "OPENAI_API_KEY": "file-key",
                "FAL_KEY": "file-fal-key",
            },
        })

        injected = {"ANTHROPIC_API_KEY": "injected-anthropic-key"}
        settings_mod = _reload_settings(
            monkeypatch, injected=injected, settings_path=settings_file
        )

        loaded = settings_mod.load_settings()
        # Only the injected key is present; file keys are gone
        assert loaded["apiKeys"] == {"ANTHROPIC_API_KEY": "injected-anthropic-key"}
        assert "OPENAI_API_KEY" not in loaded["apiKeys"]
        assert "FAL_KEY" not in loaded["apiKeys"]

    def test_non_secret_settings_preserved_from_file(self, monkeypatch, tmp_path):
        """Non-secret settings (routing, outputPath, etc.) are preserved from
        the file even in desktop mode."""
        settings_file = tmp_path / "settings.json"
        _write_settings(settings_file, {
            "apiKeys": {"OPENAI_API_KEY": "file-key"},
            "routing": {"OPENAI_API_KEY": "gpt-4o-chat"},
            "outputPath": "/app/support/output",
            "executionMode": "auto",
            "batchSizeCap": 50,
        })

        injected = {"OPENAI_API_KEY": "injected-key"}
        settings_mod = _reload_settings(
            monkeypatch, injected=injected, settings_path=settings_file
        )

        loaded = settings_mod.load_settings()
        assert loaded["routing"] == {"OPENAI_API_KEY": "gpt-4o-chat"}
        assert loaded["outputPath"] == "/app/support/output"
        assert loaded["executionMode"] == "auto"
        assert loaded["batchSizeCap"] == 50


class TestMissingFileFallback:
    """VAL-INJECT-004: Injected credentials work without a settings-file read."""

    def test_get_api_key_returns_injected_without_file(self, monkeypatch, tmp_path):
        """With NEBULA_INJECTED_KEYS populated and no settings file, get_api_key
        returns the injected key."""
        missing = tmp_path / "nonexistent" / "settings.json"
        injected = {"OPENAI_API_KEY": "sk-injected-without-file"}
        settings_mod = _reload_settings(
            monkeypatch, injected=injected, settings_path=missing
        )

        assert settings_mod.get_api_key("OPENAI_API_KEY") == "sk-injected-without-file"

    def test_load_settings_with_injected_and_missing_file(self, monkeypatch, tmp_path):
        """load_settings returns injected keys plus defaults when file is
        missing — no file read required."""
        missing = tmp_path / "no" / "such" / "settings.json"
        injected = {"FAL_KEY": "fal-injected-no-file"}
        settings_mod = _reload_settings(
            monkeypatch, injected=injected, settings_path=missing
        )

        loaded = settings_mod.load_settings()
        assert loaded["apiKeys"] == {"FAL_KEY": "fal-injected-no-file"}
        # Defaults for non-secret fields
        assert loaded["executionMode"] == "manual"

    def test_get_api_key_fallback_list_with_injection(self, monkeypatch, tmp_path):
        """get_api_key with a list of names finds the injected key."""
        missing = tmp_path / "missing.json"
        injected = {"FAL_KEY": "fal-injected-list-fallback"}
        settings_mod = _reload_settings(
            monkeypatch, injected=injected, settings_path=missing
        )

        result = settings_mod.get_api_key(
            ["NONEXISTENT_KEY", "FAL_KEY"]
        )
        assert result == "fal-injected-list-fallback"


# ===================================================================
# Part 3: Browser mode fallback
# ===================================================================

class TestBrowserModeFallback:
    """VAL-INJECT-009: Browser mode resolves credentials from settings.json."""

    def test_browser_mode_reads_from_file(self, monkeypatch, tmp_path):
        """With no injected keys, get_api_key reads from the settings file."""
        settings_file = tmp_path / "settings.json"
        _write_settings(settings_file, {
            "apiKeys": {"OPENAI_API_KEY": "sk-from-file-browser-mode"},
        })

        settings_mod = _reload_settings(
            monkeypatch, injected=None, settings_path=settings_file
        )

        assert settings_mod.is_injected_mode() is False
        assert settings_mod.get_api_key("OPENAI_API_KEY") == "sk-from-file-browser-mode"

    def test_browser_mode_no_injected_keys_in_store(self, monkeypatch):
        """In browser mode, _INJECTED_KEYS is empty."""
        settings_mod = _reload_settings(monkeypatch, injected=None)
        assert settings_mod._INJECTED_KEYS == {}

    def test_browser_mode_load_settings_preserves_file_apikeys(self, monkeypatch, tmp_path):
        """In browser mode, load_settings preserves file-based apiKeys."""
        settings_file = tmp_path / "settings.json"
        _write_settings(settings_file, {
            "apiKeys": {"OPENAI_API_KEY": "sk-file", "FAL_KEY": "fal-file"},
            "executionMode": "auto",
        })

        settings_mod = _reload_settings(
            monkeypatch, injected=None, settings_path=settings_file
        )

        loaded = settings_mod.load_settings()
        assert loaded["apiKeys"] == {"OPENAI_API_KEY": "sk-file", "FAL_KEY": "fal-file"}
        assert loaded["executionMode"] == "auto"


# ===================================================================
# Part 4: save_settings never persists injected keys
# ===================================================================

class TestSaveSettingsStripsInjected:
    """Invariant: _INJECTED_KEYS is memory-only — never persisted to disk."""

    def test_save_strips_apikeys_in_desktop_mode(self, monkeypatch, tmp_path):
        """In desktop mode, save_settings writes apiKeys: {} to the file."""
        settings_file = tmp_path / "settings.json"
        _write_settings(settings_file, {"apiKeys": {}, "outputPath": "/old"})

        injected = {"OPENAI_API_KEY": "sk-should-not-be-persisted"}
        settings_mod = _reload_settings(
            monkeypatch, injected=injected, settings_path=settings_file
        )

        # Simulate a PUT /api/settings with non-secret change
        current = settings_mod.load_settings()
        current["outputPath"] = "/new/output"
        settings_mod.save_settings(current)

        saved = json.loads(settings_file.read_text())
        assert saved["apiKeys"] == {}
        assert saved["outputPath"] == "/new/output"
        # The injected key must NOT appear in the file
        assert "sk-should-not-be-persisted" not in settings_file.read_text()

    def test_save_preserves_apikeys_in_browser_mode(self, monkeypatch, tmp_path):
        """In browser mode, save_settings preserves file-based apiKeys."""
        settings_file = tmp_path / "settings.json"
        _write_settings(settings_file, {
            "apiKeys": {"OPENAI_API_KEY": "sk-browser-key"},
        })

        settings_mod = _reload_settings(
            monkeypatch, injected=None, settings_path=settings_file
        )

        current = settings_mod.load_settings()
        current["outputPath"] = "/new"
        settings_mod.save_settings(current)

        saved = json.loads(settings_file.read_text())
        assert saved["apiKeys"] == {"OPENAI_API_KEY": "sk-browser-key"}


# ===================================================================
# Part 5: update_injected_keys function
# ===================================================================

class TestUpdateInjectedKeys:
    """VAL-INJECT-006: Credential updates take effect without restart."""

    def test_update_adds_new_key(self, monkeypatch, tmp_path):
        """update_injected_keys adds a new provider/key pair."""
        settings_file = tmp_path / "settings.json"
        _write_settings(settings_file, {"apiKeys": {}})

        injected = {"OPENAI_API_KEY": "sk-initial"}
        settings_mod = _reload_settings(
            monkeypatch, injected=injected, settings_path=settings_file
        )

        settings_mod.update_injected_keys("FAL_KEY", "fal-new-key")

        assert settings_mod._INJECTED_KEYS["FAL_KEY"] == "fal-new-key"
        assert settings_mod.get_api_key("FAL_KEY") == "fal-new-key"

    def test_update_overwrites_existing_key(self, monkeypatch, tmp_path):
        """update_injected_keys overwrites an existing provider's key."""
        settings_file = tmp_path / "settings.json"
        _write_settings(settings_file, {"apiKeys": {}})

        injected = {"OPENAI_API_KEY": "sk-old"}
        settings_mod = _reload_settings(
            monkeypatch, injected=injected, settings_path=settings_file
        )

        settings_mod.update_injected_keys("OPENAI_API_KEY", "sk-new-replaced")

        assert settings_mod._INJECTED_KEYS["OPENAI_API_KEY"] == "sk-new-replaced"
        assert settings_mod.get_api_key("OPENAI_API_KEY") == "sk-new-replaced"

    def test_update_with_empty_key_removes_provider(self, monkeypatch, tmp_path):
        """update_injected_keys with an empty key removes the provider."""
        settings_file = tmp_path / "settings.json"
        _write_settings(settings_file, {"apiKeys": {}})

        injected = {"OPENAI_API_KEY": "sk-to-be-removed"}
        settings_mod = _reload_settings(
            monkeypatch, injected=injected, settings_path=settings_file
        )

        settings_mod.update_injected_keys("OPENAI_API_KEY", "")

        assert "OPENAI_API_KEY" not in settings_mod._INJECTED_KEYS
        assert settings_mod.get_api_key("OPENAI_API_KEY") is None


# ===================================================================
# Part 6: API endpoint tests (TestClient against main.py)
# ===================================================================

class TestCredentialUpdateEndpoint:
    """VAL-INJECT-006: POST /api/credentials/update updates in-memory keys."""

    def test_post_credentials_update_adds_key(self, monkeypatch, tmp_path):
        """POST /api/credentials/update adds a new key to _INJECTED_KEYS."""
        from fastapi.testclient import TestClient
        import services.settings as settings_mod
        import main as main_mod

        # Set up desktop mode
        settings_mod._INJECTED_KEYS = {"OPENAI_API_KEY": "sk-initial"}
        monkeypatch.setattr(
            main_mod, "is_injected_mode",
            lambda: bool(settings_mod._INJECTED_KEYS),
            raising=False,
        )

        client = TestClient(main_mod.app)
        resp = client.post("/api/credentials/update", json={
            "provider": "FAL_KEY",
            "key": "fal-new-via-endpoint",
        })

        assert resp.status_code == 200, resp.text
        assert settings_mod._INJECTED_KEYS["FAL_KEY"] == "fal-new-via-endpoint"
        # Existing key preserved
        assert settings_mod._INJECTED_KEYS["OPENAI_API_KEY"] == "sk-initial"

    def test_post_credentials_update_overwrites_key(self, monkeypatch):
        """POST /api/credentials/update overwrites an existing key."""
        from fastapi.testclient import TestClient
        import services.settings as settings_mod
        import main as main_mod

        settings_mod._INJECTED_KEYS = {"OPENAI_API_KEY": "sk-old"}
        monkeypatch.setattr(
            main_mod, "is_injected_mode",
            lambda: bool(settings_mod._INJECTED_KEYS),
            raising=False,
        )

        client = TestClient(main_mod.app)
        resp = client.post("/api/credentials/update", json={
            "provider": "OPENAI_API_KEY",
            "key": "sk-new-sentinel",
        })

        assert resp.status_code == 200
        assert settings_mod._INJECTED_KEYS["OPENAI_API_KEY"] == "sk-new-sentinel"
        # Subsequent get_api_key uses the new key
        assert settings_mod.get_api_key("OPENAI_API_KEY") == "sk-new-sentinel"

    def test_post_credentials_update_rejects_unknown_provider(self, monkeypatch):
        """POST /api/credentials/update rejects a provider not in the
        16-key allowlist."""
        from fastapi.testclient import TestClient
        import services.settings as settings_mod
        import main as main_mod

        settings_mod._INJECTED_KEYS = {}
        monkeypatch.setattr(
            main_mod, "is_injected_mode",
            lambda: bool(settings_mod._INJECTED_KEYS),
            raising=False,
        )

        client = TestClient(main_mod.app)
        resp = client.post("/api/credentials/update", json={
            "provider": "UNKNOWN_PROVIDER",
            "key": "some-key",
        })

        assert resp.status_code == 400
        assert "UNKNOWN_PROVIDER" not in settings_mod._INJECTED_KEYS

    def test_post_credentials_update_missing_fields(self, monkeypatch):
        """POST /api/credentials/update requires provider and key fields."""
        from fastapi.testclient import TestClient
        import services.settings as settings_mod
        import main as main_mod

        settings_mod._INJECTED_KEYS = {}
        monkeypatch.setattr(
            main_mod, "is_injected_mode",
            lambda: bool(settings_mod._INJECTED_KEYS),
            raising=False,
        )

        client = TestClient(main_mod.app)
        resp = client.post("/api/credentials/update", json={
            "provider": "OPENAI_API_KEY",
        })

        assert resp.status_code == 422  # FastAPI validation error


class TestGetSettingsMasking:
    """VAL-INJECT-007: Desktop settings masks injected credentials."""

    def test_get_settings_masks_injected_keys(self, monkeypatch):
        """GET /api/settings masks injected keys as *** + last 4 chars."""
        from fastapi.testclient import TestClient
        import services.settings as settings_mod
        import main as main_mod

        settings_mod._INJECTED_KEYS = {
            "OPENAI_API_KEY": "sk-1234567890abcdef",
        }
        monkeypatch.setattr(
            main_mod, "is_injected_mode",
            lambda: bool(settings_mod._INJECTED_KEYS),
            raising=False,
        )

        client = TestClient(main_mod.app)
        resp = client.get("/api/settings")

        assert resp.status_code == 200
        data = resp.json()
        masked = data["apiKeys"]["OPENAI_API_KEY"]
        # Must be masked
        assert masked == "***cdef"
        # Plaintext key must NOT appear in the response
        assert "sk-1234567890abcdef" not in resp.text

    def test_get_settings_masks_short_injected_key(self, monkeypatch):
        """A short injected key (≤4 chars) is masked as just ***."""
        from fastapi.testclient import TestClient
        import services.settings as settings_mod
        import main as main_mod

        settings_mod._INJECTED_KEYS = {
            "FAL_KEY": "abc",
        }
        monkeypatch.setattr(
            main_mod, "is_injected_mode",
            lambda: bool(settings_mod._INJECTED_KEYS),
            raising=False,
        )

        client = TestClient(main_mod.app)
        resp = client.get("/api/settings")

        assert resp.status_code == 200
        data = resp.json()
        masked = data["apiKeys"]["FAL_KEY"]
        assert masked == "***"
        assert "abc" not in resp.text

    def test_get_settings_no_plaintext_in_desktop_mode(self, monkeypatch):
        """The full response text must not contain any plaintext injected key."""
        from fastapi.testclient import TestClient
        import services.settings as settings_mod
        import main as main_mod

        plaintext_key = "sk-super-secret-key-9999"
        settings_mod._INJECTED_KEYS = {
            "OPENAI_API_KEY": plaintext_key,
            "FAL_KEY": "fal-another-secret-7777",
        }
        monkeypatch.setattr(
            main_mod, "is_injected_mode",
            lambda: bool(settings_mod._INJECTED_KEYS),
            raising=False,
        )

        client = TestClient(main_mod.app)
        resp = client.get("/api/settings")

        assert resp.status_code == 200
        body = resp.text
        assert plaintext_key not in body
        assert "fal-another-secret-7777" not in body


class TestPutSettingsDesktopGuard:
    """VAL-INJECT-008: Desktop settings PUT cannot overwrite credentials."""

    def test_put_ignores_apikeys_in_desktop_mode(self, monkeypatch):
        """In desktop mode, PUT /api/settings with apiKeys is ignored."""
        from fastapi.testclient import TestClient
        import services.settings as settings_mod
        import main as main_mod

        settings_mod._INJECTED_KEYS = {
            "OPENAI_API_KEY": "sk-injected-original",
        }
        monkeypatch.setattr(
            main_mod, "is_injected_mode",
            lambda: bool(settings_mod._INJECTED_KEYS),
            raising=False,
        )

        client = TestClient(main_mod.app)

        # Verify the key before PUT
        assert settings_mod.get_api_key("OPENAI_API_KEY") == "sk-injected-original"

        # Attempt to overwrite via PUT
        resp = client.put("/api/settings", json={
            "apiKeys": {"OPENAI_API_KEY": "sk-attacker-tries-to-overwrite"},
        })
        assert resp.status_code == 200

        # The injected key must remain unchanged
        assert settings_mod._INJECTED_KEYS["OPENAI_API_KEY"] == "sk-injected-original"
        assert settings_mod.get_api_key("OPENAI_API_KEY") == "sk-injected-original"

        # GET /api/settings should still show the original masked key
        get_resp = client.get("/api/settings")
        masked = get_resp.json()["apiKeys"]["OPENAI_API_KEY"]
        assert masked == "***inal"  # last 4 of sk-injected-original

    def test_put_allows_non_secret_in_desktop_mode(self, monkeypatch, tmp_path):
        """In desktop mode, non-secret settings still update via PUT."""
        from fastapi.testclient import TestClient
        import services.settings as settings_mod
        import main as main_mod

        # Use a temp settings file so we don't clobber the repo file
        settings_file = tmp_path / "settings.json"
        _write_settings(settings_file, {
            "apiKeys": {},
            "outputPath": "/old",
            "executionMode": "manual",
        })
        monkeypatch.setenv("NEBULA_SETTINGS_PATH", str(settings_file))
        importlib.reload(settings_mod)
        importlib.reload(main_mod)

        settings_mod._INJECTED_KEYS = {"OPENAI_API_KEY": "sk-injected"}
        monkeypatch.setattr(
            main_mod, "is_injected_mode",
            lambda: bool(settings_mod._INJECTED_KEYS),
            raising=False,
        )

        client = TestClient(main_mod.app)
        resp = client.put("/api/settings", json={
            "outputPath": "/new/output",
            "executionMode": "auto",
        })

        assert resp.status_code == 200
        # Non-secret setting was updated
        loaded = settings_mod.load_settings()
        assert loaded["outputPath"] == "/new/output"
        assert loaded["executionMode"] == "auto"
        # Injected key still present
        assert loaded["apiKeys"]["OPENAI_API_KEY"] == "sk-injected"

    def test_put_does_not_persist_injected_keys_to_file(self, monkeypatch, tmp_path):
        """In desktop mode, PUT must not write injected keys to the settings
        file — only non-secret settings are persisted."""
        from fastapi.testclient import TestClient
        import services.settings as settings_mod
        import main as main_mod

        settings_file = tmp_path / "settings.json"
        _write_settings(settings_file, {
            "apiKeys": {},
            "outputPath": "/old",
        })
        monkeypatch.setenv("NEBULA_SETTINGS_PATH", str(settings_file))
        importlib.reload(settings_mod)
        importlib.reload(main_mod)

        settings_mod._INJECTED_KEYS = {"OPENAI_API_KEY": "sk-must-not-persist"}
        monkeypatch.setattr(
            main_mod, "is_injected_mode",
            lambda: bool(settings_mod._INJECTED_KEYS),
            raising=False,
        )

        client = TestClient(main_mod.app)
        client.put("/api/settings", json={"outputPath": "/new"})

        file_content = settings_file.read_text()
        assert "sk-must-not-persist" not in file_content
        saved = json.loads(file_content)
        assert saved["apiKeys"] == {}


class TestBrowserModeEndpoints:
    """VAL-INJECT-010: Browser mode masks file-based credentials."""

    def test_browser_get_settings_masks_file_keys(self, monkeypatch, tmp_path):
        """In browser mode, GET /api/settings masks file-based keys."""
        from fastapi.testclient import TestClient
        import services.settings as settings_mod
        import main as main_mod

        settings_file = tmp_path / "settings.json"
        _write_settings(settings_file, {
            "apiKeys": {"OPENAI_API_KEY": "sk-browser-key-12345"},
            "executionMode": "manual",
        })
        monkeypatch.setenv("NEBULA_SETTINGS_PATH", str(settings_file))
        importlib.reload(settings_mod)
        importlib.reload(main_mod)

        # Ensure no injected keys
        settings_mod._INJECTED_KEYS = {}
        monkeypatch.setattr(
            main_mod, "is_injected_mode",
            lambda: bool(settings_mod._INJECTED_KEYS),
            raising=False,
        )

        client = TestClient(main_mod.app)
        resp = client.get("/api/settings")

        assert resp.status_code == 200
        data = resp.json()
        masked = data["apiKeys"]["OPENAI_API_KEY"]
        assert masked == "***2345"
        assert "sk-browser-key-12345" not in resp.text

    def test_browser_put_updates_apikeys(self, monkeypatch, tmp_path):
        """In browser mode, PUT /api/settings can update apiKeys normally."""
        from fastapi.testclient import TestClient
        import services.settings as settings_mod
        import main as main_mod

        settings_file = tmp_path / "settings.json"
        _write_settings(settings_file, {
            "apiKeys": {"OPENAI_API_KEY": "sk-old-key"},
            "executionMode": "manual",
        })
        monkeypatch.setenv("NEBULA_SETTINGS_PATH", str(settings_file))
        importlib.reload(settings_mod)
        importlib.reload(main_mod)

        settings_mod._INJECTED_KEYS = {}
        monkeypatch.setattr(
            main_mod, "is_injected_mode",
            lambda: bool(settings_mod._INJECTED_KEYS),
            raising=False,
        )

        client = TestClient(main_mod.app)
        resp = client.put("/api/settings", json={
            "apiKeys": {"OPENAI_API_KEY": "sk-new-browser-key"},
        })
        assert resp.status_code == 200

        # Verify the key was updated in the file
        saved = json.loads(settings_file.read_text())
        assert saved["apiKeys"]["OPENAI_API_KEY"] == "sk-new-browser-key"


# ===================================================================
# Part 7: Log redaction — no API keys in stdout/stderr
# ===================================================================

class TestLogRedaction:
    """VAL-INJECT-011: Backend logs never contain API keys."""

    def test_no_api_keys_in_settings_logging(self, monkeypatch, tmp_path, caplog):
        """load_settings and get_api_key do not log plaintext keys."""
        import logging as _logging

        settings_file = tmp_path / "settings.json"
        _write_settings(settings_file, {
            "apiKeys": {"OPENAI_API_KEY": "sk-secret-never-log-1234"},
        })

        injected = {"FAL_KEY": "fal-secret-never-log-5678"}
        settings_mod = _reload_settings(
            monkeypatch, injected=injected, settings_path=settings_file
        )

        caplog.set_level(_logging.DEBUG, logger="services.settings")

        # Exercise the code paths
        settings_mod.load_settings()
        settings_mod.get_api_key("OPENAI_API_KEY")
        settings_mod.get_api_key("FAL_KEY")

        # Check that no plaintext key appears in captured log output
        for record in caplog.records:
            msg = record.getMessage()
            assert "sk-secret-never-log-1234" not in msg
            assert "fal-secret-never-log-5678" not in msg

    def test_no_api_keys_in_stdout_stderr(self, monkeypatch, tmp_path, capsys):
        """Importing and using the settings module does not print keys to
        stdout or stderr."""
        settings_file = tmp_path / "settings.json"
        _write_settings(settings_file, {
            "apiKeys": {"OPENAI_API_KEY": "sk-stdout-secret-9999"},
        })

        injected = {"FAL_KEY": "fal-stdout-secret-1111"}
        settings_mod = _reload_settings(
            monkeypatch, injected=injected, settings_path=settings_file
        )

        settings_mod.load_settings()
        settings_mod.get_api_key("OPENAI_API_KEY")
        settings_mod.get_api_key("FAL_KEY")

        captured = capsys.readouterr()
        assert "sk-stdout-secret-9999" not in captured.out
        assert "sk-stdout-secret-9999" not in captured.err
        assert "fal-stdout-secret-1111" not in captured.out
        assert "fal-stdout-secret-1111" not in captured.err

    def test_credential_update_endpoint_no_key_in_response(self, monkeypatch):
        """POST /api/credentials/update response body does not contain the
        plaintext key."""
        from fastapi.testclient import TestClient
        import services.settings as settings_mod
        import main as main_mod

        settings_mod._INJECTED_KEYS = {}
        monkeypatch.setattr(
            main_mod, "is_injected_mode",
            lambda: bool(settings_mod._INJECTED_KEYS),
            raising=False,
        )

        client = TestClient(main_mod.app)
        new_key = "sk-never-in-response-body-7777"
        resp = client.post("/api/credentials/update", json={
            "provider": "OPENAI_API_KEY",
            "key": new_key,
        })

        assert resp.status_code == 200
        assert new_key not in resp.text
        assert new_key not in str(resp.json())
