"""Managed discovery config boundaries; no account login or provider execution."""
from __future__ import annotations

import json
import tomllib
from pathlib import Path

import pytest

from services import krea_agent_mcp as config


@pytest.mark.parametrize("url", [
    "https://api.krea.ai/mcp", "http://example.com:8000", "http://127.0.0.1:0",
    "http://user:secret@127.0.0.1:8000", "http://127.0.0.1:8000/path",
    "http://127.0.0.1:8000/?token=secret", "http://127.0.0.1:8000/#fragment",
])
def test_bridge_rejects_nonlocal_or_credential_bearing_origins(url):
    with pytest.raises(ValueError):
        config.loopback_backend_url(url)


def test_backend_url_tracks_sidecar_and_uvicorn_preview():
    assert config.resolve_nebula_url({"NEBULA_URL": "http://127.0.0.1:8033/"}, []) == "http://127.0.0.1:8033"
    assert config.resolve_nebula_url({}, ["uvicorn", "main:app", "--host", "0.0.0.0", "--port", "8033"]) == "http://127.0.0.1:8033"
    assert config.resolve_nebula_url({}, ["uvicorn", "main:app", "--host=::", "--port=8033"]) == "http://[::1]:8033"
    assert config.resolve_nebula_url({}, ["pytest", "--port", "9999"]) == config.DEFAULT_NEBULA_URL


def test_child_environment_keeps_agent_auth_and_removes_connector_secrets():
    child = config.agent_child_env({
        "NEBULA_URL": "http://127.0.0.1:8033",
        "NEBULA_CONNECTOR_ENCRYPTION_KEY": "vault-fixture",
        "NEBULA_INJECTED_KEYS": "injected-fixture",
        "ANTHROPIC_API_KEY": "existing-agent-auth",
        "HERMES_HOME": "/existing/profile",
    })
    assert child["ANTHROPIC_API_KEY"] == "existing-agent-auth"
    assert child["HERMES_HOME"] == "/existing/profile"
    assert all(key not in child for key in config.CONNECTOR_SECRET_ENV_KEYS)


def test_scoped_cli_configs_contain_only_bridge_executable_path_and_origin(monkeypatch):
    monkeypatch.setenv("NEBULA_URL", "http://127.0.0.1:8033")
    monkeypatch.setenv("NEBULA_CONNECTOR_ENCRYPTION_KEY", "vault-fixture")
    claude_args = config.claude_mcp_args()
    server = json.loads(claude_args[1])["mcpServers"][config.SERVER_NAME]
    assert set(server) == {"command", "args"}
    assert server["args"] == [str(config.BRIDGE_PATH), "--url", "http://127.0.0.1:8033"]
    codex_args = config.codex_mcp_args()
    assert codex_args[::2] == ["-c", "-c"]
    parsed = tomllib.loads("\n".join(codex_args[1::2]))
    assert parsed["mcp_servers"][config.SERVER_NAME] == server
    assert "vault-fixture" not in json.dumps([claude_args, codex_args])


def test_hermes_overlay_only_adds_mcp_leaf_preserves_profile_and_cleans_up(tmp_path, monkeypatch):
    monkeypatch.setattr(config, "HERMES_SYSTEM_MANAGED_DIR", tmp_path / "absent-system-policy")
    profile = tmp_path / "profile"
    profile.mkdir()
    user_config = {"model": {"provider": "nous"}, "mcp_servers": {"existing": {"command": "existing-cli"}}}
    user_path = profile / "config.yaml"
    user_path.write_text(json.dumps(user_config))
    before = user_path.read_bytes()
    env = {"NEBULA_URL": "http://127.0.0.1:8033", "HERMES_HOME": str(profile)}
    overlay = config.prepare_hermes_mcp(env)
    try:
        path = Path(env["HERMES_MANAGED_DIR"]) / "config.yaml"
        managed = json.loads(path.read_text())
        assert set(managed) == {"mcp_servers"}
        assert list(managed["mcp_servers"]) == [config.SERVER_NAME]
        assert env["HERMES_HOME"] == str(profile)
        assert user_path.read_bytes() == before
        # Hermes's canonical loader deep-merges this one leaf over the user
        # config; there is no replacement mcp_servers list or profile copy.
        assert "existing" not in managed["mcp_servers"]
    finally:
        overlay.cleanup()
    assert not path.parent.exists()


@pytest.mark.parametrize("explicit", [True, False])
def test_hermes_existing_admin_scope_is_never_replaced(tmp_path, monkeypatch, explicit):
    policy = tmp_path / "policy"
    policy.mkdir()
    monkeypatch.setattr(config, "HERMES_SYSTEM_MANAGED_DIR", policy if not explicit else tmp_path / "absent")
    env = {"NEBULA_URL": "http://127.0.0.1:8033"}
    if explicit:
        env["HERMES_MANAGED_DIR"] = str(policy)
    before = dict(env)
    overlay = config.prepare_hermes_mcp(env)
    assert overlay.directory is None
    assert "administrator" in overlay.limitation
    assert env == before
