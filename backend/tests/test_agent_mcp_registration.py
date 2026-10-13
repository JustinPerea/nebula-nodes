"""How the in-app agents get Nebula's MCP server, and what each one may do with it."""
from __future__ import annotations

import json
import sys
from pathlib import Path
from unittest.mock import AsyncMock, MagicMock, patch

import pytest

sys.path.insert(0, str(Path(__file__).resolve().parent.parent))

import mcp_server
from services import agent_profiles, krea_agent_mcp
from services.agent_profiles import CLAUDE_ALLOW_RULES, claude_profile_args


def _flag_value(args: list[str], flag: str) -> str:
    return args[args.index(flag) + 1]


def test_the_listed_tools_are_exactly_the_servers_tools():
    # NEBULA_MCP_TOOLS feeds Claude's allow-list; a tool added to the server
    # must be listed (and so reviewed) before in-app Claude can call it.
    registered = [tool.name for tool in mcp_server.mcp._tool_manager.list_tools()]
    assert sorted(registered) == sorted(krea_agent_mcp.NEBULA_MCP_TOOLS)
    assert len(set(krea_agent_mcp.NEBULA_MCP_TOOLS)) == len(krea_agent_mcp.NEBULA_MCP_TOOLS)


def test_claude_allows_every_nebula_tool_by_exact_name_and_no_wildcards():
    registered = {tool.name for tool in mcp_server.mcp._tool_manager.list_tools()}
    allowed = {rule for rule in CLAUDE_ALLOW_RULES if rule.startswith("mcp__")}
    assert {f"mcp__nebula__{name}" for name in registered} <= allowed
    assert {f"mcp__nebula_krea__{name}" for name in krea_agent_mcp.KREA_READONLY_TOOLS} <= allowed
    assert allowed == {f"mcp__nebula__{name}" for name in registered} | {
        f"mcp__nebula_krea__{name}" for name in krea_agent_mcp.KREA_READONLY_TOOLS}
    assert not any(rule.endswith("*") or rule.count("__") < 2 for rule in allowed)


def test_claude_mcp_config_names_the_token_instead_of_holding_it(monkeypatch):
    monkeypatch.setenv("NEBULA_AGENT_TOKEN", "turn-token-fixture")
    args = claude_profile_args(extra_dirs=[], backend_url="http://127.0.0.1:8033", with_servers=True)
    servers = json.loads(_flag_value(args, "--mcp-config"))["mcpServers"]
    assert set(servers) == {"nebula", "nebula_krea"}
    nebula = servers["nebula"]
    assert nebula["args"] == [str(krea_agent_mcp.NEBULA_MCP_PATH), "--url", "http://127.0.0.1:8033"]
    assert nebula["env"] == {"NEBULA_AGENT_TOKEN": "${NEBULA_AGENT_TOKEN}", "NEBULA_URL": "http://127.0.0.1:8033"}
    assert "turn-token-fixture" not in " ".join(args)
    settings = json.loads(_flag_value(args, "--settings"))
    assert "Bash(ps *)" in settings["permissions"]["deny"]


@pytest.mark.asyncio
async def test_run_claude_registers_the_server_and_gives_claude_the_token_by_env(tmp_path):
    from services.chat_session import run_claude

    captured: dict = {}
    proc = MagicMock()
    proc.stdout.readline = AsyncMock(side_effect=[b""])
    proc.stderr.read = AsyncMock(return_value=b"")
    proc.wait = AsyncMock(return_value=0)
    proc.returncode = 0

    async def fake(*args, **kwargs):
        captured["args"], captured["env"] = list(args), kwargs["env"]
        return proc

    with patch("services.chat_session.asyncio.create_subprocess_exec", side_effect=fake):
        [e async for e in run_claude("hi", None, "", backend_url="http://127.0.0.1:8033",
                                     extra_dirs=[tmp_path], workdir=tmp_path, agent_token="tok-123")]
    args = captured["args"]
    servers = json.loads(_flag_value(args, "--mcp-config"))["mcpServers"]
    assert servers["nebula"]["env"]["NEBULA_AGENT_TOKEN"] == "${NEBULA_AGENT_TOKEN}"
    assert captured["env"]["NEBULA_AGENT_TOKEN"] == "tok-123"
    assert "tok-123" not in " ".join(args)
    prompt = _flag_value(args, "--append-system-prompt")
    assert "mcp__nebula__" in prompt and "view_output" in prompt
    # Claude's shell still reaches Nebula, so it keeps the CLI for what the tools lack.
    assert "`nebula save`" in prompt


def test_codex_disables_every_feature_the_review_named_and_allows_none_of_them():
    named = {"hooks", "skill_mcp_dependency_install", "plugins", "remote_plugin", "plugin_sharing", "apps",
             "workspace_dependencies", "computer_use", "browser_use", "browser_use_external",
             "browser_use_full_cdp_access", "in_app_browser", "in_app_local_automation", "memories"}
    assert named <= set(agent_profiles.CODEX_DISABLED_FEATURES)
    assert not agent_profiles.CODEX_ALLOWED_FEATURES & set(agent_profiles.CODEX_DISABLED_FEATURES)
    assert not any(name.startswith(("in_app_", "browser_use")) for name in agent_profiles.CODEX_ALLOWED_FEATURES)
    args = agent_profiles.codex_profile_args(effort=None)
    disabled = [value for flag, value in zip(args, args[1:]) if flag == "--disable"]
    assert disabled == list(agent_profiles.CODEX_DISABLED_FEATURES)


def test_codex_workspace_cannot_hold_project_config(tmp_path):
    import tomllib
    from services.agent_workspaces import create_workspace

    current = create_workspace(tmp_path, brand=None)
    args = agent_profiles.codex_filesystem_args(workdir=current, deny_paths=[])
    profile = tomllib.loads("\n".join(v for f, v in zip(args, args[1:]) if f == "-c"))["permissions"]["nebula-agent"]
    assert profile["filesystem"][str(current.resolve())] == "write"
    for name in (".codex", ".agents"):
        assert profile["filesystem"][str(current.resolve() / name)] == "deny"
    assert profile["network"]["enabled"] is False
    # --ignore-user-config is what keeps any project layer out (checked live);
    # it must stay on every Codex turn.
    assert "--ignore-user-config" in agent_profiles.codex_profile_args(effort=None)


# -- the MCP server inside a chat turn --------------------------------------------

def test_mcp_server_without_a_token_has_no_workspace_scope(monkeypatch):
    from services.agent_workspaces import active_workspace

    monkeypatch.delenv("NEBULA_AGENT_TOKEN", raising=False)
    with mcp_server.agent_workspace_scope():
        assert active_workspace() is None


def test_mcp_server_with_a_token_takes_the_workspace_from_the_backend(tmp_path, monkeypatch):
    from services.agent_workspaces import active_workspace, create_workspace

    workspace = create_workspace(tmp_path, brand="acme")
    monkeypatch.setenv("NEBULA_AGENT_TOKEN", "turn-token-fixture")
    seen = {}

    def fake_request(self, method, path, **kwargs):
        seen["call"] = (method, path)
        return {"workspace": str(workspace), "brand": "acme"}

    monkeypatch.setattr(mcp_server.NebulaAPI, "request", fake_request)
    with mcp_server.agent_workspace_scope():
        assert active_workspace() == workspace
    assert seen["call"] == ("GET", "/api/agent/context")


@pytest.mark.parametrize("payload", [{}, {"workspace": "relative/dir"}, {"workspace": ""}, ["x"]])
def test_mcp_server_refuses_a_workspace_it_cannot_trust(monkeypatch, payload):
    monkeypatch.setenv("NEBULA_AGENT_TOKEN", "turn-token-fixture")
    monkeypatch.setattr(mcp_server.NebulaAPI, "request", lambda self, *a, **k: payload)
    with pytest.raises(mcp_server.NebulaAPIError):
        mcp_server.agent_workspace_scope()


def test_mcp_commons_add_reads_relative_paths_from_the_turns_workspace(tmp_path, monkeypatch):
    from services.agent_workspaces import create_workspace, workspace_scope

    workspace = create_workspace(tmp_path, brand=None)
    monkeypatch.setenv("NEBULA_AGENT_TOKEN", "turn-token-fixture")
    sent = []

    def fake_call(method, path, client_name, **kwargs):
        if path == "/api/capabilities/commons":
            return {"enabled": True}
        sent.append(kwargs["json"]["source"])
        return {"ok": True}

    monkeypatch.setattr(mcp_server, "_commons_call", fake_call)
    with workspace_scope(workspace):
        mcp_server._commons_add_impl("ref.png", "inbox", "why", "agent", client_name="claude")
    assert sent == [str((workspace / "ref.png").resolve())]
