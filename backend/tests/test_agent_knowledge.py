"""Provider snapshots expose tracked text without adopting aliases or secrets."""
import os
import json

import pytest

from services import agent_knowledge as knowledge


def _sources(tmp_path, monkeypatch, entries):
    source, workspace = tmp_path / "repo", tmp_path / "workspace"
    source.mkdir()
    monkeypatch.setattr(knowledge, "_tracked_files", lambda root: entries)
    return source, workspace


def _write(root, relative, text):
    path = root / relative
    path.parent.mkdir(parents=True, exist_ok=True)
    path.write_text(text)
    return path


def test_snapshot_is_bounded_trusted_text_and_never_clobbers_a_resumed_session(tmp_path, monkeypatch):
    entries = [".agents/skills/provider/SKILL.md", "docs/model-providers/provider/guide.md",
               "docs/api-guides/provider.md", "settings.json", "output/image.png",
               ".agents/skills/provider/tool.py", "../outside.md", "/absolute.md"]
    source, workspace = _sources(tmp_path, monkeypatch, entries)
    skill = _write(source, entries[0], "provider instructions")
    _write(source, entries[1], "provider schema")
    _write(source, entries[2], "recipe")
    _write(source, "settings.json", "synthetic secret")
    _write(source, ".agents/skills/provider/tool.py", "unsafe executable")
    assert knowledge.snapshot_provider_knowledge(source, workspace) == 3
    assert (workspace / entries[0]).read_text() == "provider instructions"
    assert not (workspace / "settings.json").exists()
    assert not (workspace / ".agents/skills/provider/tool.py").exists()
    skill.write_text("later revision")
    assert knowledge.snapshot_provider_knowledge(source, workspace) == 3
    assert (workspace / entries[0]).read_text() == "provider instructions"


@pytest.mark.parametrize("alias", ["symlink", "hardlink", "parent_symlink"])
def test_snapshot_rejects_source_alias_before_creating_workspace(tmp_path, monkeypatch, alias):
    entry = ".agents/skills/provider/SKILL.md"
    source, workspace = _sources(tmp_path, monkeypatch, [entry])
    outside = _write(tmp_path, "outside/SKILL.md", "synthetic private text")
    if alias == "parent_symlink":
        (source / ".agents/skills").mkdir(parents=True)
        (source / ".agents/skills/provider").symlink_to(outside.parent)
    else:
        (source / ".agents/skills/provider").mkdir(parents=True)
        if alias == "symlink":
            (source / entry).symlink_to(outside)
        else:
            os.link(outside, source / entry)
    with pytest.raises(knowledge.KnowledgeSnapshotError, match="alias"):
        knowledge.snapshot_provider_knowledge(source, workspace)
    assert not workspace.exists()


@pytest.mark.parametrize("alias", ["file_symlink", "parent_symlink", "file_hardlink"])
def test_snapshot_rejects_existing_destination_alias_and_preserves_target(tmp_path, monkeypatch, alias):
    entry = ".agents/skills/provider/SKILL.md"
    source, workspace = _sources(tmp_path, monkeypatch, [entry])
    _write(source, entry, "provider instructions")
    outside = _write(tmp_path, "outside/SKILL.md", "keep this")
    (workspace / ".agents/skills").mkdir(parents=True)
    if alias == "parent_symlink":
        (workspace / ".agents/skills/provider").symlink_to(outside.parent)
    else:
        (workspace / ".agents/skills/provider").mkdir()
        if alias == "file_symlink":
            (workspace / entry).symlink_to(outside)
        else:
            os.link(outside, workspace / entry)
    with pytest.raises(knowledge.KnowledgeSnapshotError, match="alias"):
        knowledge.snapshot_provider_knowledge(source, workspace)
    assert outside.read_text() == "keep this"


@pytest.mark.parametrize("limit", ["MAX_KNOWLEDGE_FILE_BYTES", "MAX_KNOWLEDGE_BYTES", "MAX_KNOWLEDGE_FILES"])
def test_snapshot_excess_limits_reject_before_destination_writes(tmp_path, monkeypatch, limit):
    entries = [".agents/skills/a/SKILL.md", ".agents/skills/b/SKILL.md"]
    source, workspace = _sources(tmp_path, monkeypatch, entries)
    for entry in entries:
        _write(source, entry, "12345")
    monkeypatch.setattr(knowledge, limit, 1)
    with pytest.raises(knowledge.KnowledgeSnapshotError, match="limit"):
        knowledge.snapshot_provider_knowledge(source, workspace)
    assert not workspace.exists()


def test_aggregate_cap_uses_bytes_after_a_source_grows_during_open(tmp_path, monkeypatch):
    entries = [".agents/skills/a/SKILL.md", ".agents/skills/b/SKILL.md"]
    source, workspace = _sources(tmp_path, monkeypatch, entries)
    for entry in entries:
        _write(source, entry, "1")
    monkeypatch.setattr(knowledge, "MAX_KNOWLEDGE_BYTES", 8)
    original_open = knowledge.os.open
    def grow_then_open(path, flags, *args, **kwargs):
        if path == source / entries[1]:
            path.write_text("12345678")
        return original_open(path, flags, *args, **kwargs)
    monkeypatch.setattr(knowledge.os, "open", grow_then_open)
    with pytest.raises(knowledge.KnowledgeSnapshotError, match="snapshot limit"):
        knowledge.snapshot_provider_knowledge(source, workspace)
    assert not workspace.exists()


def test_exact_aggregate_boundary_is_allowed_after_growth(tmp_path, monkeypatch):
    entries = [".agents/skills/a/SKILL.md", ".agents/skills/b/SKILL.md"]
    source, workspace = _sources(tmp_path, monkeypatch, entries)
    for entry in entries:
        _write(source, entry, "1")
    monkeypatch.setattr(knowledge, "MAX_KNOWLEDGE_BYTES", 8)
    original_open = knowledge.os.open
    def grow_then_open(path, flags, *args, **kwargs):
        if path == source / entries[1]:
            path.write_text("1234567")
        return original_open(path, flags, *args, **kwargs)
    monkeypatch.setattr(knowledge.os, "open", grow_then_open)
    assert knowledge.snapshot_provider_knowledge(source, workspace) == 2
    assert sum((workspace / entry).stat().st_size for entry in entries) == 8


def test_bootstrap_reads_only_limit_plus_one_characters(tmp_path, monkeypatch):
    from services.codex_session import _read_text
    path = _write(tmp_path, "large.md", "x" * 10000)
    original_open = type(path).open
    seen = []
    class ObservedStream:
        def __init__(self, stream):
            self.stream = stream
        def __enter__(self):
            self.stream.__enter__()
            return self
        def __exit__(self, *args):
            return self.stream.__exit__(*args)
        def read(self, size):
            seen.append(size)
            return self.stream.read(size)
    def observed_open(current, *args, **kwargs):
        return ObservedStream(original_open(current, *args, **kwargs))
    monkeypatch.setattr(type(path), "open", observed_open)
    text = _read_text(path, limit=8)
    assert seen == [9]
    assert text == "xxxxxxxx\n\n[truncated]"


def test_snapshot_fails_without_git_index_instead_of_reading_an_untracked_tree(tmp_path):
    with pytest.raises(knowledge.KnowledgeSnapshotError, match="indexed"):
        knowledge.snapshot_provider_knowledge(tmp_path, tmp_path / "workspace")


def test_source_zip_uses_portable_inventory_without_adopting_untracked_files(tmp_path, monkeypatch):
    source, workspace = tmp_path / "source-zip", tmp_path / "workspace"
    entry = ".agents/skills/provider/SKILL.md"
    _write(source, entry, "tracked provider knowledge")
    _write(source, "docs/api-guides/untracked.md", "do not adopt")
    _write(source, "backend/data/provider_knowledge_manifest.json",
           json.dumps({"version": 1, "paths": [entry]}))
    def no_git(*args, **kwargs):
        raise FileNotFoundError("git is unavailable")
    monkeypatch.setattr(knowledge.subprocess, "run", no_git)
    assert knowledge.snapshot_provider_knowledge(source, workspace) == 1
    assert (workspace / entry).read_text() == "tracked provider knowledge"
    assert not (workspace / "docs/api-guides/untracked.md").exists()


@pytest.mark.parametrize("paths", [["../private.md"], ["settings.json"], ["/absolute.md"], [1]])
def test_portable_inventory_rejects_invalid_paths(tmp_path, monkeypatch, paths):
    source = tmp_path / "source-zip"
    _write(source, "backend/data/provider_knowledge_manifest.json", json.dumps({"version": 1, "paths": paths}))
    def no_git(*args, **kwargs):
        raise FileNotFoundError("git is unavailable")
    monkeypatch.setattr(knowledge.subprocess, "run", no_git)
    with pytest.raises(knowledge.KnowledgeSnapshotError, match="indexed"):
        knowledge.snapshot_provider_knowledge(source, tmp_path / "workspace")


def test_bootstrap_ignores_untracked_skills_and_tracked_aliases(tmp_path, monkeypatch):
    from services import codex_session
    root = tmp_path / "repo"
    _write(root, ".agents/skills/tracked/SKILL.md", "---\nname: tracked\n---\ntracked instructions")
    _write(root, ".agents/skills/untracked/SKILL.md", "---\nname: untracked\n---\nuntracked instructions")
    outside = _write(tmp_path, "outside/SKILL.md", "---\nname: private\n---\nprivate text")
    alias = root / ".agents/skills/aliased/SKILL.md"
    alias.parent.mkdir()
    alias.symlink_to(outside)
    monkeypatch.setattr(codex_session, "PROJECT_ROOT", root)
    monkeypatch.setattr(codex_session, "SKILL_ROOT", root / ".agents/skills")
    monkeypatch.setattr(knowledge, "_tracked_files", lambda project: [
        ".agents/skills/tracked/SKILL.md", ".agents/skills/aliased/SKILL.md",
    ])
    bootstrap = codex_session._build_skill_bootstrap("tracked provider")
    assert "tracked instructions" in bootstrap
    assert "untracked instructions" not in bootstrap
    assert "private text" not in bootstrap
