"""`nebula skill install` (decisions D1, D2) and the repo's nebula skill (gap 1).

Every test runs against a temporary HOME; nothing touches the real
~/.claude or ~/.agents.
"""
from __future__ import annotations

import argparse
from datetime import datetime
from pathlib import Path

import pytest

from cli.commands import skill

REPO = Path(__file__).resolve().parents[2]
NOW = datetime(2026, 10, 18, 15, 4, 5)


@pytest.fixture
def home(tmp_path, monkeypatch):
    home = tmp_path / "home"
    home.mkdir()
    monkeypatch.setenv("HOME", str(home))
    return home


def _run(apps=None, copy=False) -> int:
    return skill.run_install(argparse.Namespace(apps=apps, copy=copy))


def test_the_repo_has_a_nebula_skill_without_the_old_mistakes():
    text = (REPO / "skills" / "nebula" / "SKILL.md").read_text()
    assert text.startswith("---\nname: nebula\n")
    # Gap 1: no one person's checkout path, and no `clear` as a first step.
    assert "/Users/" not in text and "Documents/Workspace" not in text
    assert "python -m nebula clear" not in text
    assert "Never run `nebula clear`" in text
    assert "nebula project new" in text
    for verb in ("new", "add", "set", "analyze", "list", "show", "delete"):
        assert f"nebula moodboard {verb}" in text
    assert ".env" not in text  # keys live in Nebula's Settings


def test_install_links_both_apps_and_backs_up_whats_there(home, capsys):
    (home / ".codex").mkdir()
    old = home / ".claude" / "skills" / "nebula"
    old.mkdir(parents=True)
    (old / "SKILL.md").write_text("old skill")

    assert skill.install_one(skill.APPS["claude"], skill.skill_source(), copy=False, home=home, now=NOW) \
        .startswith("Claude Code: linked")
    target = home / ".claude" / "skills" / "nebula"
    assert target.is_symlink() and target.resolve() == skill.skill_source().resolve()
    backup = home / ".claude" / "skill-backups" / "nebula.backup-20261018-150405"
    assert (backup / "SKILL.md").read_text() == "old skill"
    # The backup isn't in the skills folder, where it would load as a second "nebula".
    assert [p.name for p in (home / ".claude" / "skills").iterdir()] == ["nebula"]

    assert _run() == 0
    out = capsys.readouterr().out
    assert "Claude Code: already linked" in out
    assert "Codex: linked" in out
    codex = home / ".agents" / "skills" / "nebula"
    assert codex.is_symlink() and (codex / "SKILL.md").read_text() == (skill.skill_source() / "SKILL.md").read_text()


def test_a_link_somewhere_else_is_moved_as_a_link(home):
    elsewhere = home / "old-checkout" / "nebula"
    elsewhere.mkdir(parents=True)
    skills_dir = home / ".claude" / "skills"
    skills_dir.mkdir(parents=True)
    (skills_dir / "nebula").symlink_to(elsewhere, target_is_directory=True)
    (skills_dir / "dangling").symlink_to(home / "nothing")

    skill.install_one(skill.APPS["claude"], skill.skill_source(), copy=False, home=home, now=NOW)
    backup = home / ".claude" / "skill-backups" / "nebula.backup-20261018-150405"
    assert backup.is_symlink() and backup.resolve() == elsewhere.resolve()
    assert elsewhere.is_dir()  # what the old link pointed at is untouched

    # Same second again: a second backup, not an overwrite.
    skill.install_one(skill.APPS["claude"], skill.skill_source(), copy=True, home=home, now=NOW)
    assert (home / ".claude" / "skill-backups" / "nebula.backup-20261018-150405-2").is_symlink()


def test_copy_installs_a_real_folder_that_records_its_checkout(home, capsys):
    assert _run(apps="codex", copy=True) == 0
    target = home / ".agents" / "skills" / "nebula"
    assert target.is_dir() and not target.is_symlink()
    assert (target / "SKILL.md").read_text() == (skill.skill_source() / "SKILL.md").read_text()
    assert (target / ".installed-from").read_text().strip() == str(REPO.resolve())
    assert not (home / ".claude").exists()

    capsys.readouterr()
    assert _run(apps="codex", copy=True) == 0
    assert "already current" in capsys.readouterr().out
    assert not (home / ".agents" / "skill-backups").exists()


def test_a_broken_link_is_backed_up_too(home):
    skills_dir = home / ".claude" / "skills"
    skills_dir.mkdir(parents=True)
    (skills_dir / "nebula").symlink_to(home / "gone")
    skill.install_one(skill.APPS["claude"], skill.skill_source(), copy=False, home=home, now=NOW)
    assert (skills_dir / "nebula").resolve() == skill.skill_source().resolve()
    assert (home / ".claude" / "skill-backups" / "nebula.backup-20261018-150405").is_symlink()


def test_no_app_folders_means_no_guessing(home, capsys):
    assert _run() == 1
    assert "--for claude" in capsys.readouterr().err
    assert not (home / ".claude").exists()


def test_install_needs_no_backend(home, monkeypatch, capsys):
    import sys

    from cli.__main__ import main

    (home / ".claude").mkdir()
    monkeypatch.setattr(sys, "argv", ["nebula", "skill", "install"])
    monkeypatch.setenv("NEBULA_URL_FILE", str(home / "missing-url-file"))
    with pytest.raises(SystemExit) as exit_info:
        main()
    assert exit_info.value.code == 0
    assert (home / ".claude" / "skills" / "nebula").is_symlink()
