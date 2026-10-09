"""Tests for the clean launch profiles of Nebula's chat agents."""
from __future__ import annotations

import json
import sys
from pathlib import Path
from unittest.mock import AsyncMock, MagicMock, patch

import pytest

sys.path.insert(0, str(Path(__file__).resolve().parent.parent))

from services import agent_profiles
from services.agent_profiles import (
    claude_profile_args,
    codex_default_model,
    codex_profile_args,
    normalize_claude_model,
    normalize_effort,
)
from services.chat_session import run_claude


def _flag_value(args: list[str], flag: str) -> str:
    return args[args.index(flag) + 1]


@pytest.mark.parametrize("raw,expected", [
    (None, "medium"),
    ("", "medium"),
    ("HIGH", "high"),
    ("xhigh", "xhigh"),
    ("max", "max"),
    ("ultra", "medium"),
])
def test_normalize_effort(raw, expected):
    assert normalize_effort(raw) == expected


@pytest.mark.parametrize("raw,expected", [
    (None, "opus"),
    ("Opus", "opus"),
    ("sonnet", "sonnet"),
    ("haiku", "haiku"),
    ("claude-opus-5-5", "claude-opus-5-5"),
    ("fable", "opus"),
    ("claude-fable-5-1", "opus"),
    ("gpt-6-astra", "opus"),
])
def test_normalize_claude_model_passes_aliases_and_never_fable(raw, expected):
    assert normalize_claude_model(raw) == expected


def test_claude_profile_is_restricted_with_explicit_permissions(tmp_path):
    args = claude_profile_args(extra_dirs=[tmp_path])

    assert "--dangerously-skip-permissions" not in args
    assert "--bare" not in args  # --bare would also skip the capture hooks
    assert "--restricted" in args
    assert "--disable-slash-commands" in args
    assert "--strict-mcp-config" in args
    assert json.loads(_flag_value(args, "--mcp-config")) == {"mcpServers": {}}
    assert _flag_value(args, "--tools") == "Bash,Read,Glob,Grep"
    assert _flag_value(args, "--permission-mode") == "dontAsk"
    assert _flag_value(args, "--add-dir") == str(tmp_path)

    settings = json.loads(_flag_value(args, "--settings"))
    assert settings["autoMemoryEnabled"] is False
    assert "Bash(nebula *)" in settings["permissions"]["allow"]
    assert "Bash(dm approve*)" in settings["permissions"]["deny"]
    assert not any(rule == "Bash" or rule == "Bash(*)" for rule in settings["permissions"]["allow"])


def test_codex_profile_ignores_user_config_and_memories():
    args = codex_profile_args(effort="high")
    assert "--ignore-user-config" in args
    assert "--ignore-rules" in args
    assert _flag_value(args, "--disable") == "memories"
    assert 'model_reasoning_effort="high"' in args


def test_codex_default_model_reads_only_the_model_key(tmp_path):
    config = tmp_path / "config.toml"
    config.write_text('model = "gpt-6-astra"\n\n[mcp_servers.paper]\ncommand = "paper"\n')
    assert codex_default_model(config) == "gpt-6-astra"
    assert codex_default_model(tmp_path / "missing.toml") is None
    (tmp_path / "bad.toml").write_text("model = [")
    assert codex_default_model(tmp_path / "bad.toml") is None


def _claude_proc(lines: list[bytes]):
    proc = MagicMock()
    proc.stdout = MagicMock()
    proc.stdout.readline = AsyncMock(side_effect=[*lines, b""])
    proc.stderr = MagicMock()
    proc.stderr.read = AsyncMock(return_value=b"")
    proc.wait = AsyncMock(return_value=0)
    proc.returncode = 0
    return proc


@pytest.mark.asyncio
async def test_run_claude_launches_clean_profile_and_reports_resolved_model(tmp_path):
    captured: dict = {}
    init = json.dumps({
        "type": "system", "subtype": "init",
        "session_id": "sess-1", "model": "claude-opus-5-5",
    }).encode() + b"\n"
    proc = _claude_proc([init])

    async def fake_create(*args, **kwargs):
        captured["args"] = list(args)
        captured["env"] = kwargs["env"]
        captured["cwd"] = kwargs["cwd"]
        return proc

    with patch("services.chat_session.asyncio.create_subprocess_exec", side_effect=fake_create):
        events = [e async for e in run_claude(
            "hi", None, "", effort="high",
            backend_url="http://127.0.0.1:54321", extra_dirs=[tmp_path],
            workdir=tmp_path / "ws",
        )]

    args = captured["args"]
    assert "--dangerously-skip-permissions" not in args
    assert "--restricted" in args
    assert _flag_value(args, "--model") == "opus"
    assert _flag_value(args, "--effort") == "high"
    # Never the repo root, which holds plaintext keys in settings.json.
    assert captured["cwd"] == str(tmp_path / "ws")
    assert captured["env"]["NEBULA_URL"] == "http://127.0.0.1:54321"
    assert captured["env"]["CLAUDE_CODE_DISABLE_AUTO_MEMORY"] == "1"
    assert captured["env"]["NEBULA_DISABLE_QUICK"] == "1"
    assert events[0] == {
        "type": "session", "sessionId": "sess-1",
        "model": "claude-opus-5-5", "effort": "high",
    }
    assert events[-1] == {"type": "done"}


def test_clean_mcp_servers_default_empty():
    # Static defaults admit no user servers; the explicit invocation bridge is
    # built separately by clean_mcp_servers().
    assert agent_profiles.CLEAN_MCP_SERVERS == {}


@pytest.mark.parametrize("effort", [None, "max"])
@pytest.mark.asyncio
async def test_catalog_validated_claude_alias_and_effort_are_preserved(tmp_path, effort):
    captured = []
    proc = _claude_proc([])
    async def create(*args, **kwargs):
        captured.extend(args)
        return proc
    with patch("services.chat_session.asyncio.create_subprocess_exec", side_effect=create):
        events = [event async for event in run_claude("fixture", "old-provider-session", "default",
                    effort=effort, catalog_validated=True, workdir=tmp_path / "ws")]
    assert _flag_value(captured, "--model") == "default"
    assert _flag_value(captured, "--resume") == "old-provider-session"
    if effort is None:
        assert "--effort" not in captured
    else:
        assert _flag_value(captured, "--effort") == "max"
    assert events[-1] == {"type": "done"}


def test_secret_files_are_denied_by_absolute_path(tmp_path):
    secret = tmp_path / "settings.json"
    args = claude_profile_args(extra_dirs=[], secret_paths=[secret])
    settings = json.loads(_flag_value(args, "--settings"))
    assert f"Read(/{secret.resolve()})" in settings["permissions"]["deny"]
    assert f"Read(/{secret.resolve()})".startswith("Read(//")


def test_default_secret_paths_cover_settings_and_env():
    from services.agent_profiles import default_secret_paths
    from services.settings import SETTINGS_PATH

    paths = default_secret_paths()
    assert SETTINGS_PATH in paths
    assert any(p.name == ".env" for p in paths)


def test_agent_workspace_is_outside_the_repo(tmp_path):
    from services.agent_profiles import agent_workspace

    workspace = agent_workspace(tmp_path)
    assert workspace.is_dir()
    repo_root = Path(__file__).resolve().parent.parent.parent
    assert not workspace.resolve().is_relative_to(repo_root)


def test_unbound_agent_workspace_never_reuses_previous_downloads(tmp_path):
    legacy = tmp_path / "agent-workspace"
    legacy.mkdir()
    (legacy / "reference.png").write_bytes(b"old reference")
    first = agent_profiles.agent_workspace(tmp_path)
    (first / "reference.png").write_bytes(b"session reference")
    second = agent_profiles.agent_workspace(tmp_path)
    assert first != second
    assert list(second.iterdir()) == []
    assert (legacy / "reference.png").read_bytes() == b"old reference"


def test_paths_overlap_detects_equal_ancestor_descendant_and_symlink(tmp_path):
    a, inner, other = tmp_path / "a", tmp_path / "a" / "b", tmp_path / "c"
    inner.mkdir(parents=True); other.mkdir()
    link = tmp_path / "link"
    link.symlink_to(inner)
    assert agent_profiles.paths_overlap(a, a)
    assert agent_profiles.paths_overlap(a, inner) and agent_profiles.paths_overlap(inner, a)
    assert agent_profiles.paths_overlap(link, a)
    assert not agent_profiles.paths_overlap(a, other)


@pytest.mark.parametrize("form", ["uppercase", "nfd", "uppercase-nfd"])
def test_paths_overlap_reserves_case_and_unicode_aliases(tmp_path, form):
    import unicodedata

    protected = tmp_path / "références"
    name = protected.name.upper() if "uppercase" in form else protected.name
    if "nfd" in form:
        name = unicodedata.normalize("NFD", name)
    alias = protected.with_name(name) / "future" / "reference.png"
    assert agent_profiles.paths_overlap(protected, alias)
    assert agent_profiles.paths_overlap(alias, protected)


def test_paths_overlap_detects_same_identity_alias_and_future_children(tmp_path, monkeypatch):
    protected = tmp_path / "protected"
    protected.mkdir()
    alias = tmp_path / "mount-alias"
    alias.mkdir()
    original_stat = Path.stat
    identity = protected.stat()

    def aliased_stat(path, *args, **kwargs):
        return identity if path == alias else original_stat(path, *args, **kwargs)

    monkeypatch.setattr(Path, "stat", aliased_stat)
    assert agent_profiles.paths_overlap(alias / "future.png", protected)
    assert agent_profiles.paths_overlap(protected / "future.png", alias)


def test_agent_read_grants_never_include_the_state_dir_or_commons(tmp_path):
    state, output = tmp_path / "state", tmp_path / "output"
    workdir, commons = state / "agent-workspace", state / "commons"
    for d in (workdir, commons, output):
        d.mkdir(parents=True)
    grants = agent_profiles.agent_read_grants(output_root=output, workdir=workdir, protected=[commons])
    assert grants == [output]
    assert not any(agent_profiles.paths_overlap(g, commons) for g in grants)


@pytest.mark.parametrize("layout", ["commons_in_output", "output_in_commons", "workdir_in_commons"])
def test_agent_read_grants_fail_closed_when_a_grant_overlaps_commons(tmp_path, layout):
    output, workdir, commons = tmp_path / "output", tmp_path / "work", tmp_path / "commons"
    if layout == "commons_in_output":
        commons = output / "commons"
    elif layout == "output_in_commons":
        output = commons / "output"
    else:
        workdir = commons / "work"
    for d in (output, workdir, commons):
        d.mkdir(parents=True, exist_ok=True)
    with pytest.raises(agent_profiles.GrantOverlapsProtectedDir):
        agent_profiles.agent_read_grants(output_root=output, workdir=workdir, protected=[commons])


def test_claude_profile_denies_protected_dirs_and_blocks_reads_outside_grants(tmp_path):
    output, commons = tmp_path / "output", tmp_path / "commons"
    output.mkdir(); commons.mkdir()
    args = claude_profile_args(extra_dirs=[output], deny_read_dirs=[commons])
    settings = json.loads(_flag_value(args, "--settings"))
    root = commons.resolve()
    # `//` is the absolute-path form; a single leading slash would anchor at the workdir.
    assert f"Read(//{str(root).lstrip('/')})" in settings["permissions"]["deny"]
    assert f"Read(//{str(root).lstrip('/')}/**)" in settings["permissions"]["deny"]
    assert settings["permissions"]["blockReadsOutsideWorkingDirectories"] is True
    assert all(not agent_profiles.paths_overlap(Path(v), commons)
               for flag, v in zip(args, args[1:]) if flag == "--add-dir")


def test_protected_agent_dirs_follow_the_commons_root(tmp_path, monkeypatch):
    monkeypatch.delenv("NEBULA_COMMONS_ROOT", raising=False)
    monkeypatch.setenv("NEBULA_STATE_DIR", str(tmp_path / "state"))
    assert agent_profiles.protected_agent_dirs() == [tmp_path / "state" / "commons", tmp_path / "state" / "krea"]


def _toml_overrides(args):
    import tomllib
    return tomllib.loads('\n'.join(value for flag, value in zip(args, args[1:]) if flag == '-c'))


def test_codex_filesystem_profile_denies_real_and_symlink_store_paths(tmp_path):
    work = tmp_path / 'state' / 'agent-workspace'
    store = tmp_path / 'state' / 'commons'
    work.mkdir(parents=True); store.mkdir()
    alias = tmp_path / 'store-alias'
    alias.symlink_to(store, target_is_directory=True)
    secret = tmp_path / 'Brand 🧪 settings "quoted".json'
    args = agent_profiles.codex_filesystem_args(workdir=work, deny_paths=[alias, secret])
    config = _toml_overrides(args)
    assert config['default_permissions'] == 'nebula-agent'
    profile = config['permissions']['nebula-agent']
    assert profile['extends'] == ':workspace'
    assert profile['network']['enabled'] is True
    for path in [alias.absolute(), store.resolve(), secret.resolve()]:
        assert profile['filesystem'][str(path)] == 'deny'
    assert 'sandbox_mode' not in config
    assert 'sandbox_workspace_write' not in config


@pytest.mark.parametrize('layout', ['same','parent','child','symlink'])
def test_codex_profile_rejects_workdir_overlapping_protected_paths(tmp_path, layout):
    store = tmp_path / 'state' / 'commons'
    store.mkdir(parents=True)
    work = {'same':store,'parent':store.parent,'child':store/'work','symlink':tmp_path/'alias'}[layout]
    if layout == 'symlink':work.symlink_to(store, target_is_directory=True)
    with pytest.raises(agent_profiles.GrantOverlapsProtectedDir):
        agent_profiles.codex_filesystem_args(workdir=work, deny_paths=[store])


def test_codex_workspace_policy_denies_namespace_and_reopens_only_current_session(tmp_path):
    from services.agent_workspaces import create_workspace, workspace_deny_roots

    current = create_workspace(tmp_path, brand="brand-a")
    other = create_workspace(tmp_path, brand="brand-a")
    filesystem = _toml_overrides(agent_profiles.codex_filesystem_args(
        workdir=current, deny_paths=[]))["permissions"]["nebula-agent"]["filesystem"]
    assert filesystem[str(current.resolve())] == "write"
    assert str(other.resolve()) not in filesystem
    for root in workspace_deny_roots(current):
        assert filesystem[str(root.resolve())] == "deny"


@pytest.mark.parametrize("grant_location", ["root", "parent", "sibling", "legacy", "symlink"])
def test_read_grant_cannot_expose_managed_or_legacy_workspaces(tmp_path, grant_location):
    from services.agent_workspaces import create_workspace, workspace_deny_roots

    current = create_workspace(tmp_path, brand="brand-a")
    roots = workspace_deny_roots(current)
    grant = {"root": roots[0], "parent": tmp_path, "sibling": roots[0] / "future-session",
             "legacy": roots[1], "symlink": tmp_path / "alias"}[grant_location]
    if grant_location == "symlink":
        grant.symlink_to(roots[0], target_is_directory=True)
    with pytest.raises(agent_profiles.GrantOverlapsProtectedDir):
        agent_profiles.agent_read_grants(output_root=grant, workdir=current, protected=[])


def test_codex_rejects_legacy_or_parent_workdir(tmp_path, monkeypatch):
    from services.agent_workspaces import workspace_root, legacy_workspace_root

    monkeypatch.setenv("NEBULA_STATE_DIR", str(tmp_path))
    for current in (tmp_path, workspace_root(), legacy_workspace_root()):
        with pytest.raises(agent_profiles.GrantOverlapsProtectedDir):
            agent_profiles.codex_filesystem_args(workdir=current, deny_paths=[])


def test_workspace_cli_environment_matches_managed_state_root(tmp_path, monkeypatch):
    from services.agent_workspaces import create_workspace

    monkeypatch.setenv("NEBULA_STATE_DIR", str(tmp_path / "other-state"))
    current = create_workspace(tmp_path / "backend-state", brand="brand-a")
    assert agent_profiles.agent_workspace_env(current) == {"NEBULA_STATE_DIR": str((tmp_path / "backend-state").resolve())}


@pytest.mark.parametrize("namespace", ["agent-workspaces", "agent-workspace"])
def test_uppercase_workspace_output_grant_is_denied(tmp_path, namespace):
    from services.agent_workspaces import create_workspace

    current = create_workspace(tmp_path, brand="brand-a")
    with pytest.raises(agent_profiles.GrantOverlapsProtectedDir):
        agent_profiles.agent_read_grants(
            output_root=tmp_path / namespace.upper(), workdir=current, protected=[])


def test_uppercase_legacy_workspace_cwd_is_denied(tmp_path, monkeypatch):
    monkeypatch.setenv("NEBULA_STATE_DIR", str(tmp_path))
    with pytest.raises(agent_profiles.GrantOverlapsProtectedDir):
        agent_profiles.codex_filesystem_args(workdir=tmp_path / "AGENT-WORKSPACE", deny_paths=[])
