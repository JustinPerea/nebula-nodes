"""Managed discovery config boundaries; no account login or provider execution."""
from __future__ import annotations

import json
import tomllib

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
    # A devserver.py reload worker inherits its parent's argv.
    assert config.resolve_nebula_url({}, ["backend/devserver.py", "--port", "8131"]) == "http://127.0.0.1:8131"
    assert config.resolve_nebula_url({}, ["devserver.py"]) == "http://127.0.0.1:8000"


def test_child_environment_keeps_agent_auth_and_removes_connector_secrets():
    child = config.agent_child_env({
        "NEBULA_URL": "http://127.0.0.1:8033",
        "NEBULA_CONNECTOR_ENCRYPTION_KEY": "vault-fixture",
        "NEBULA_INJECTED_KEYS": "injected-fixture",
        "ANTHROPIC_API_KEY": "existing-agent-auth",
    })
    assert child["ANTHROPIC_API_KEY"] == "existing-agent-auth"
    assert all(key not in child for key in config.CONNECTOR_SECRET_ENV_KEYS)


def test_child_environment_drops_the_person_token_and_the_old_desktop_nonce():
    # The person token is what lets a request count as the person
    # (person_gate). An agent that inherited it could accept its own proposals.
    child = config.agent_child_env({
        "NEBULA_DESKTOP_MODE": "1",
        "NEBULA_PERSON_TOKEN": "person-token-fixture",
        "NEBULA_CONNECTOR_SESSION": "launch-nonce-fixture",
    })
    assert "NEBULA_PERSON_TOKEN" not in child
    assert "NEBULA_CONNECTOR_SESSION" not in child
    assert child["NEBULA_DESKTOP_MODE"] == "1"


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


def test_nebula_server_env_names_the_token_by_reference():
    # Claude Code expands `${NEBULA_AGENT_TOKEN}` from its own environment, so
    # the MCP config never holds the token's value.
    refs = config.nebula_server_env_refs("http://127.0.0.1:8033")
    assert refs == {"NEBULA_AGENT_TOKEN": "${NEBULA_AGENT_TOKEN}", "NEBULA_URL": "http://127.0.0.1:8033"}
