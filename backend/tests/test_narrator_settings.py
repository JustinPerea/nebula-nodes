from __future__ import annotations

import json

from services import narrator


def test_narrator_uses_nebula_settings_credential_first(monkeypatch, tmp_path) -> None:
    missing_auth = tmp_path / "missing-auth.json"
    monkeypatch.setattr(narrator, "HERMES_AUTH_PATH", missing_auth)
    monkeypatch.setattr(narrator, "get_api_key", lambda name: "settings-key")

    assert narrator._resolve_openrouter_key() == "settings-key"


def test_narrator_falls_back_to_hermes_credential(monkeypatch, tmp_path) -> None:
    auth_path = tmp_path / "auth.json"
    auth_path.write_text(
        json.dumps(
            {
                "credential_pool": {
                    "openrouter": [
                        {"access_token": ""},
                        {"access_token": "hermes-key"},
                    ]
                }
            }
        )
    )
    monkeypatch.setattr(narrator, "HERMES_AUTH_PATH", auth_path)
    monkeypatch.setattr(narrator, "get_api_key", lambda name: None)

    assert narrator._resolve_openrouter_key() == "hermes-key"


def test_narrator_returns_none_without_configured_credential(monkeypatch, tmp_path) -> None:
    monkeypatch.setattr(narrator, "HERMES_AUTH_PATH", tmp_path / "missing.json")
    monkeypatch.setattr(narrator, "get_api_key", lambda name: None)

    assert narrator._resolve_openrouter_key() is None
