"""Current runner behavior survives clean Commons authority composition."""
from __future__ import annotations

import json
import tomllib
from unittest.mock import AsyncMock, MagicMock, Mock, patch

import httpx
import pytest

from cli.client import NebulaClient
from services.agent_workspaces import create_workspace
from services import chat_session, codex_session, hermes_session


def _process(lines=()):
    proc = MagicMock()
    proc.stdout.readline = AsyncMock(side_effect=[*lines, b""])
    proc.stderr.read = AsyncMock(return_value=b"")
    proc.wait = AsyncMock(return_value=0)
    proc.returncode = 0
    proc.stdin.drain = AsyncMock()
    return proc


def _value(args, flag):
    return args[args.index(flag) + 1]


@pytest.mark.parametrize("enabled", [False, True])
@pytest.mark.asyncio
async def test_claude_private_profile_keeps_only_krea_and_never_opens_store(tmp_path, monkeypatch, enabled):
    monkeypatch.setenv("NEBULA_COMMONS_ENABLED", "1" if enabled else "0")
    monkeypatch.setenv("NEBULA_STATE_DIR", str(tmp_path / "state"))
    monkeypatch.setenv("NEBULA_URL", "http://127.0.0.1:8000")
    monkeypatch.setenv("NEBULA_CONNECTOR_ENCRYPTION_KEY", "synthetic-vault")
    monkeypatch.setenv("NEBULA_INJECTED_KEYS", "synthetic-credentials")
    monkeypatch.setenv("NEBULA_AGENT_TOKEN", "stale-identity")
    workspace = create_workspace(tmp_path / "state", "brand-a")
    output = tmp_path / "output"
    output.mkdir()
    proc = _process([b'{"type":"system","subtype":"init","session_id":"provider-a","model":"claude-sonnet-test"}\n'])
    spawn = AsyncMock(return_value=proc)
    with patch("services.chat_session.asyncio.create_subprocess_exec", spawn), \
         patch("commons.runtime.get_store", side_effect=AssertionError("profile must not open store")):
        events = [event async for event in chat_session.run_claude(
            "inspect", "provider-a", "sonnet", autonomy="step", provider="ignored",
            effort="high", backend_url="http://127.0.0.1:54321", extra_dirs=[output],
            workdir=workspace, agent_token="bound-identity",
        )]
    args, options = spawn.call_args.args, spawn.call_args.kwargs
    assert options["cwd"] == str(workspace)
    assert options["env"]["NEBULA_AGENT_TOKEN"] == "bound-identity"
    assert options["env"]["NEBULA_URL"] == "http://127.0.0.1:54321"
    assert "NEBULA_CONNECTOR_ENCRYPTION_KEY" not in options["env"]
    assert "NEBULA_INJECTED_KEYS" not in options["env"]
    assert "--restricted" in args and "--strict-mcp-config" in args
    assert "--disable-slash-commands" in args
    assert "--dangerously-skip-permissions" not in args
    servers = json.loads(_value(args, "--mcp-config"))["mcpServers"]
    assert set(servers) == {"nebula_krea"}
    assert servers["nebula_krea"]["args"][-1] == "http://127.0.0.1:54321"
    settings = json.loads(_value(args, "--settings"))
    assert "mcp__nebula_krea__list_models" in settings["permissions"]["allow"]
    assert "mcp__nebula_krea__get_model_schema" in settings["permissions"]["allow"]
    assert any(str(tmp_path / "state" / "krea") in rule for rule in settings["permissions"]["deny"])
    assert _value(args, "--resume") == "provider-a"
    prompt = _value(args, "--append-system-prompt")
    assert ("Using the commons" in prompt) is enabled
    assert "list_models and get_model_schema" in prompt
    assert "Repo-backed Nebula skills" in prompt
    assert (workspace / ".agents/skills/krea/SKILL.md").is_file()
    assert (workspace / "docs/model-providers/krea/krea-gateway.md").is_file()
    assert not (workspace / "settings.json").exists()
    assert events[0]["model"] == "claude-sonnet-test" and events[0]["effort"] == "high"
    assert events[-1] == {"type": "done"}


@pytest.mark.asyncio
async def test_codex_private_profile_preserves_mcp_events_and_billing(tmp_path, monkeypatch):
    monkeypatch.setenv("NEBULA_COMMONS_ENABLED", "1")
    monkeypatch.setenv("NEBULA_STATE_DIR", str(tmp_path / "state"))
    monkeypatch.setenv("OPENAI_API_KEY", "synthetic-api")
    monkeypatch.setenv("NEBULA_CONNECTOR_ENCRYPTION_KEY", "synthetic-vault")
    workspace = create_workspace(tmp_path / "state", "brand-a")
    proc = _process([
        b'{"type":"thread.started","thread_id":"provider-codex"}\n',
        b'{"type":"item.started","item":{"type":"mcp_tool_call","id":"tool-a","server":"nebula_krea","tool":"list_models","arguments":{}}}\n',
        b'{"type":"item.completed","item":{"type":"mcp_tool_call","id":"tool-a","status":"completed","result":{"content":[{"type":"text","text":"models"}]}}}\n',
    ])
    spawn = AsyncMock(return_value=proc)
    with patch("services.codex_session._require_codex_chatgpt_login", AsyncMock(return_value=None)), \
         patch("services.codex_session.asyncio.create_subprocess_exec", spawn), \
         patch("commons.runtime.get_store", side_effect=AssertionError("profile must not open store")):
        events = [event async for event in codex_session.run_codex(
            "Krea models", "provider-codex", "gpt-test", autonomy="step", provider="ignored",
            effort="xhigh", backend_url="http://127.0.0.1:54321", workdir=workspace,
            agent_token="bound-codex",
        )]
    args, options = spawn.call_args.args, spawn.call_args.kwargs
    assert "--sandbox" not in args
    assert "--ignore-user-config" in args and "--ignore-rules" in args
    assert "--strict-config" in args
    assert _value(args, "--model") == "gpt-test"
    assert args[-3:] == ("resume", "provider-codex", "-")
    config = tomllib.loads("\n".join(value for flag, value in zip(args, args[1:]) if flag == "-c"))
    assert set(config["mcp_servers"]) == {"nebula_krea"}
    assert config["mcp_servers"]["nebula_krea"]["args"][-1] == "http://127.0.0.1:54321"
    filesystem = config["permissions"]["nebula-agent"]["filesystem"]
    assert filesystem[str(workspace)] == "write"
    assert filesystem[str(tmp_path / "state" / "krea")] == "deny"
    assert options["cwd"] == str(workspace)
    assert options["env"]["NEBULA_AGENT_TOKEN"] == "bound-codex"
    assert "OPENAI_API_KEY" not in options["env"] and "NEBULA_CONNECTOR_ENCRYPTION_KEY" not in options["env"]
    assert events[0]["model"] == "gpt-test" and events[0]["effort"] == "xhigh"
    assert any(event.get("tool") == "mcp__nebula_krea__list_models" for event in events)
    assert any(event.get("type") == "tool_result" and event["content"] == "models" for event in events)
    assert events[-1] == {"type": "done"}


@pytest.mark.parametrize("flag,token", [("1", None), ("0", "bound-token")])
@pytest.mark.asyncio
async def test_daedalus_refuses_unverified_scoped_access_before_process(monkeypatch, flag, token):
    monkeypatch.setenv("NEBULA_COMMONS_ENABLED", flag)
    spawn = AsyncMock()
    with patch("services.hermes_session.asyncio.create_subprocess_exec", spawn), \
         patch("services.hermes_session.prepare_hermes_mcp", Mock()) as overlay:
        events = [event async for event in hermes_session.run_hermes("hello", None, agent_token=token)]
    spawn.assert_not_called()
    overlay.assert_not_called()
    assert events[0]["type"] == "error" and "has not been verified" in events[0]["message"]
    assert events[-1] == {"type": "done"}
    assert chat_session.AGENT_RUNNERS["daedalus"] is hermes_session.run_hermes


@pytest.mark.parametrize("payload,expected", [({"enabled": True}, True), ({"enabled": False}, False),
                                             ({"enabled": 1}, False), ({"enabled": "1"}, False),
                                             ({}, False), (None, False)])
def test_cli_capability_requires_literal_boolean(payload, expected):
    client = NebulaClient()
    try:
        with patch.object(client, "_request", return_value=payload):
            assert client.commons_enabled() is expected
    finally:
        client._client.close()


def test_cli_identity_keeps_daedalus_guard_and_overrides_forged_auth(monkeypatch):
    monkeypatch.setenv("NEBULA_AGENT_TOKEN", "bound-token")
    monkeypatch.setenv("DAEDALUS_APPROVAL", "step")
    client = NebulaClient()
    seen = []
    def respond(request):
        seen.append(request)
        return httpx.Response(200, json={})
    client._client.close()
    client._client = httpx.Client(base_url=client.base_url, transport=httpx.MockTransport(respond))
    try:
        client._request("POST", "/api/graph/run", headers={"authorization": "Bearer forged"})
        client.get_node_image_path("n1")
    finally:
        client._client.close()
    assert all(request.headers["Authorization"] == "Agent bound-token" for request in seen)
    assert all(request.headers["X-Daedalus-Caller"] == "1" for request in seen)
