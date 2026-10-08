"""Settings mutation contracts with synthetic credentials and temporary files."""
from __future__ import annotations

import json
import re
from pathlib import Path
from unittest.mock import Mock

import pytest
from fastapi.testclient import TestClient

import main
import services.settings as settings


@pytest.fixture
def settings_client(tmp_path, monkeypatch):
    path = tmp_path / "settings.json"
    initial = {
        "apiKeys": {
            "OPENAI_API_KEY": "synthetic-openai-1234",
            "FAL_KEY": "synthetic-fal-5678",
            "KREA_API_TOKEN": "synthetic-krea-9012",
        },
        "routing": {"example": "unchanged"},
        "outputPath": "/synthetic/output",
        "exportFolder": "/synthetic/export",
        "executionMode": "manual",
        "batchSizeCap": 25,
        "favorites": ["nano-banana"],
        "zoomTelemetryEnabled": False,
        "kreaConnectionMode": "mcp",
        "futureSetting": {"preserve": True},
    }
    path.write_text(json.dumps(initial))
    monkeypatch.setattr(settings, "SETTINGS_PATH", path)
    monkeypatch.setattr(settings, "_INJECTED_KEYS", {})
    # Resolve the patched module directly even after other tests reload it.
    monkeypatch.setattr(main, "load_settings", settings.load_settings)
    monkeypatch.setattr(main, "save_settings", settings.save_settings)
    monkeypatch.setattr(main, "is_injected_mode", settings.is_injected_mode)
    clear = Mock()
    monkeypatch.setattr(main, "clear_provider_validation_cache", clear)
    return TestClient(main.app), path, initial, clear


def test_remove_provider_persists_and_reopening_returns_only_masked_other_keys(settings_client):
    client, path, initial, clear = settings_client

    response = client.delete("/api/settings/api-keys/OPENAI_API_KEY")

    assert response.status_code == 200
    assert response.json() == {"status": "removed"}
    expected = {**initial, "apiKeys": {key: value for key, value in initial["apiKeys"].items()
                                      if key != "OPENAI_API_KEY"}}
    assert json.loads(path.read_text()) == expected
    assert settings.get_api_key("OPENAI_API_KEY") is None
    assert settings.get_api_key("FAL_KEY") == initial["apiKeys"]["FAL_KEY"]
    reopened = TestClient(main.app).get("/api/settings")
    assert reopened.status_code == 200
    assert reopened.json()["apiKeys"] == {"FAL_KEY": "***5678", "KREA_API_TOKEN": "***9012"}
    assert all(value not in reopened.text for value in initial["apiKeys"].values())
    assert all(value not in response.text for value in initial["apiKeys"].values())
    clear.assert_called_once_with()


def test_remove_invalidates_cached_readiness_and_inflight_cache_generation(settings_client, monkeypatch):
    client, _, _, _ = settings_client
    monkeypatch.setattr(settings, "_provider_check_cache", {
        "OpenAI": (999999999, {"configured": True, "status": "valid"}),
    })
    monkeypatch.setattr(settings, "_provider_check_credential_identity", {})
    generation = settings._provider_cache_generation
    monkeypatch.setattr(settings, "_provider_cache_generation", generation)
    monkeypatch.setattr(main, "clear_provider_validation_cache", settings.clear_provider_validation_cache)
    assert client.delete("/api/settings/api-keys/OPENAI_API_KEY").status_code == 200
    assert settings._provider_check_cache == {}
    assert settings._provider_cache_generation == generation + 1


def test_remove_already_absent_provider_is_idempotent(settings_client):
    client, path, initial, clear = settings_client
    for _ in range(2):
        response = client.delete("/api/settings/api-keys/WORLDLABS_API_KEY")
        assert response.status_code == 200
        assert response.json() == {"status": "removed"}
    assert json.loads(path.read_text()) == initial
    assert clear.call_count == 2


@pytest.mark.parametrize("provider", sorted(main._CREDENTIAL_PROVIDER_ALLOWLIST))
def test_each_catalog_provider_can_be_removed_without_touching_other_providers(settings_client, provider):
    client, path, initial, _ = settings_client
    initial["apiKeys"][provider] = "synthetic-target-value"
    path.write_text(json.dumps(initial))
    assert client.delete(f"/api/settings/api-keys/{provider}").status_code == 200
    saved = json.loads(path.read_text())
    assert provider not in saved["apiKeys"]
    assert saved == {**initial, "apiKeys": {key: value for key, value in initial["apiKeys"].items()
                                          if key != provider}}


def test_removal_provider_catalog_matches_settings_ui_and_registry_example():
    root = Path(__file__).resolve().parents[2]
    ui = (root / "frontend/src/components/panels/Settings.tsx").read_text()
    ui_providers = set(re.findall(r"\{ key: '([A-Z0-9_]+)'", ui))
    example_providers = set(json.loads((root / "settings.example.json").read_text())["apiKeys"])
    assert main._CREDENTIAL_PROVIDER_ALLOWLIST == ui_providers == example_providers


@pytest.mark.parametrize("provider", ["UNKNOWN_PROVIDER", "apiKeys", "synthetic-target-value"])
def test_invalid_removal_provider_cannot_change_settings_or_echo_input(settings_client, provider):
    client, path, _, clear = settings_client
    before = path.read_bytes()
    response = client.delete(f"/api/settings/api-keys/{provider}")
    assert response.status_code == 400
    assert response.json() == {"detail": "Unknown credential provider"}
    assert provider not in response.text
    assert path.read_bytes() == before
    clear.assert_not_called()


def test_browser_removal_cannot_modify_injected_credentials(settings_client, monkeypatch):
    client, path, _, clear = settings_client
    before = path.read_bytes()
    injected = {"OPENAI_API_KEY": "synthetic-injected-value"}
    monkeypatch.setattr(settings, "_INJECTED_KEYS", injected)
    response = client.delete("/api/settings/api-keys/OPENAI_API_KEY")
    assert response.status_code == 409
    assert injected == {"OPENAI_API_KEY": "synthetic-injected-value"}
    assert path.read_bytes() == before
    assert "synthetic-injected-value" not in response.text
    clear.assert_not_called()


def test_removing_krea_api_key_preserves_mcp_connection_and_oauth_vault(settings_client, tmp_path, monkeypatch):
    from services.krea_connector import ISSUER, SERVER, KreaConnector

    monkeypatch.delenv("NEBULA_CONNECTOR_ENCRYPTION_KEY", raising=False)
    monkeypatch.delenv("NEBULA_DESKTOP_MODE", raising=False)
    connection = KreaConnector(tmp_path / "krea")
    connection.vault.write({
        "issuer": ISSUER, "resource": SERVER, "connection_revision": "synthetic-revision",
        "tokens": {"access_token": "synthetic-access", "refresh_token": "synthetic-refresh"},
    })
    before = connection.vault.path.read_bytes()
    client, path, initial, _ = settings_client

    response = client.delete("/api/settings/api-keys/KREA_API_TOKEN")

    assert response.status_code == 200
    saved = json.loads(path.read_text())
    assert "KREA_API_TOKEN" not in saved["apiKeys"]
    assert saved["kreaConnectionMode"] == initial["kreaConnectionMode"] == "mcp"
    assert connection.status() == {"status": "connected"}
    assert connection.connection_revision() == "synthetic-revision"
    assert connection.vault.path.read_bytes() == before


def test_legacy_empty_and_masked_put_values_do_not_remove_keys(settings_client):
    client, path, initial, _ = settings_client
    response = client.put("/api/settings", json={
        "apiKeys": {"OPENAI_API_KEY": "", "FAL_KEY": "***5678"},
    })
    assert response.status_code == 200
    assert response.json() == {"status": "saved"}
    assert json.loads(path.read_text()) == initial


@pytest.mark.parametrize("api_keys", [None, [], "key", {"OPENAI_API_KEY": 123},
                                      {"FAL_KEY": "synthetic-new", "OPENAI_API_KEY": None}])
def test_invalid_key_updates_cannot_partly_mutate_any_settings(settings_client, api_keys):
    client, path, _, clear = settings_client
    before = path.read_bytes()
    response = client.put("/api/settings", json={
        "apiKeys": api_keys, "outputPath": "/changed", "kreaConnectionMode": "api-token",
    })
    assert response.status_code == 400
    assert response.json() == {"detail": "apiKeys must be an object of string values"}
    assert path.read_bytes() == before
    assert "synthetic-new" not in response.text
    clear.assert_not_called()


def test_invalid_nonsecret_setting_does_not_mutate_shared_loaded_keys(settings_client, monkeypatch):
    client, path, initial, clear = settings_client
    before = path.read_bytes()
    monkeypatch.setattr(main, "load_settings", lambda: initial)
    response = client.put("/api/settings", json={
        "apiKeys": {"OPENAI_API_KEY": "synthetic-new"}, "zoomTelemetryEnabled": "yes",
    })
    assert response.status_code == 400
    assert initial["apiKeys"]["OPENAI_API_KEY"] == "synthetic-openai-1234"
    assert path.read_bytes() == before
    clear.assert_not_called()


def test_successful_key_update_copies_loaded_settings_and_preserves_other_providers(settings_client, monkeypatch):
    client, path, initial, clear = settings_client
    monkeypatch.setattr(main, "load_settings", lambda: initial)
    response = client.put("/api/settings", json={"apiKeys": {"OPENAI_API_KEY": "synthetic-new"}})
    assert response.status_code == 200
    assert initial["apiKeys"]["OPENAI_API_KEY"] == "synthetic-openai-1234"
    assert json.loads(path.read_text()) == {**initial, "apiKeys": {
        **initial["apiKeys"], "OPENAI_API_KEY": "synthetic-new",
    }}
    clear.assert_called_once_with()
