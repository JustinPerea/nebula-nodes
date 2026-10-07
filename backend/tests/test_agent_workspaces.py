from pathlib import Path

import pytest

from services.agent_workspaces import (
    WorkspaceSessions, WorkspaceSessionError, active_workspace,
    create_workspace, workspace_scope,
)
from services.file_access import ProtectedPathError, require_allowed_path


def test_sessions_are_distinct_and_resume_is_server_bound(tmp_path):
    sessions = WorkspaceSessions()
    first = sessions.acquire(tmp_path, "claude", "brand-a", None)
    sessions.bind_provider(first, "provider-one")
    sessions.release(first)
    again = sessions.acquire(tmp_path, "claude", "brand-a", first.id)
    assert again.workspace == first.workspace
    assert again.provider_session_id == "provider-one"
    sessions.release(again)
    second = sessions.acquire(tmp_path, "claude", "brand-a", None)
    third = sessions.acquire(tmp_path, "claude", "brand-b", None)
    assert len({first.workspace, second.workspace, third.workspace}) == 3
    assert first.workspace.parent != third.workspace.parent
    assert first.id != "provider-one"


@pytest.mark.parametrize("runner,brand,identifier", [
    ("codex", "brand-a", "known"), ("claude", "brand-b", "known"),
    ("claude", "brand-a", "provider-id"), ("claude", "brand-a", "../escape"),
])
def test_unknown_and_mismatched_resumes_rejected(tmp_path, runner, brand, identifier):
    sessions = WorkspaceSessions()
    record = sessions.acquire(tmp_path, "claude", "brand-a", None)
    sessions.bind_provider(record, "provider-id")
    sessions.release(record)
    with pytest.raises(WorkspaceSessionError):
        sessions.acquire(tmp_path, runner, brand, record.id if identifier == "known" else identifier)


def test_one_turn_per_conversation_and_restart_is_fresh(tmp_path):
    sessions = WorkspaceSessions()
    record = sessions.acquire(tmp_path, "claude", None, None)
    with pytest.raises(WorkspaceSessionError):
        sessions.acquire(tmp_path, "claude", None, record.id)
    sessions.release(record)
    with pytest.raises(WorkspaceSessionError):
        WorkspaceSessions().acquire(tmp_path, "claude", None, record.id)


def test_workspace_policy_own_only_and_legacy_denied(tmp_path, monkeypatch):
    monkeypatch.setenv("NEBULA_STATE_DIR", str(tmp_path))
    own = create_workspace(tmp_path, "brand-a")
    other = create_workspace(tmp_path, "brand-a")
    legacy = tmp_path / "agent-workspace"
    legacy.mkdir()
    for folder in (own, other, legacy):
        (folder / "ref.png").write_bytes(b"fixture")
    for folder in (own, other, legacy):
        with pytest.raises(ProtectedPathError):
            require_allowed_path(folder / "ref.png")
    with workspace_scope(own):
        assert active_workspace() == own
        assert require_allowed_path(own / "ref.png") == own / "ref.png"
        for folder in (other, legacy):
            with pytest.raises(ProtectedPathError):
                require_allowed_path(folder / "ref.png")
        (own / "alias.png").symlink_to(other / "ref.png")
        with pytest.raises(ProtectedPathError):
            require_allowed_path(own / "alias.png")
    assert active_workspace() is None


@pytest.mark.asyncio
async def test_workspace_scope_is_task_local(tmp_path):
    import asyncio
    first, second = create_workspace(tmp_path), create_workspace(tmp_path)
    async def check(folder):
        with workspace_scope(folder):
            await asyncio.sleep(0)
            assert active_workspace() == folder
    await asyncio.gather(check(first), check(second))
    assert active_workspace() is None


@pytest.mark.parametrize("replacement", ["symlink-parent", "replacement-leaf"])
def test_resume_rejects_changed_workspace_ancestry(tmp_path, replacement):
    sessions = WorkspaceSessions()
    first = sessions.acquire(tmp_path, "claude", "A", None)
    second = sessions.acquire(tmp_path, "claude", "B", None)
    sessions.release(first)
    if replacement == "symlink-parent":
        (second.workspace.parent / first.workspace.name).mkdir()
        first.workspace.parent.rename(first.workspace.parent.with_name("moved"))
        first.workspace.parent.symlink_to(second.workspace.parent, target_is_directory=True)
    else:
        first.workspace.rename(first.workspace.with_name("old"))
        first.workspace.mkdir()
    with pytest.raises(WorkspaceSessionError):
        sessions.acquire(tmp_path, "claude", "A", first.id)


def test_bad_workspace_root_is_a_clear_session_error(tmp_path):
    (tmp_path / "agent-workspaces").write_text("not a directory")
    with pytest.raises(WorkspaceSessionError, match="Cannot create"):
        WorkspaceSessions().acquire(tmp_path, "claude", None, None)
