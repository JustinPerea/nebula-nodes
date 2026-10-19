"""nebula skill install [--copy] [--for claude|codex|all]

Puts this checkout's `nebula` skill (skills/nebula) where agent apps load
skills from:

- Claude Code: ~/.claude/skills/nebula
- Codex: ~/.agents/skills/nebula. Codex's user skill folder is
  $HOME/.agents/skills, and it follows symlinked skill folders (checked on
  learn.chatgpt.com/docs/build-skills, 2026-10-18).

By default it's a symlink, so `git pull` keeps the skill current. --copy
copies the folder instead, for a setup where the checkout may move or isn't
there (the copy then records where it came from in `.installed-from`).

Whatever is already at that path is moved, never deleted, to
<app folder>/skill-backups/nebula.backup-YYYYMMDD-HHMMSS. The backups sit
outside the skills folder on purpose: a backup inside it would load as a
second skill named "nebula".
"""
from __future__ import annotations

import filecmp
import os
import shutil
import sys
from dataclasses import dataclass
from datetime import datetime
from pathlib import Path

SKILL_NAME = "nebula"
STAMP = ".installed-from"


@dataclass(frozen=True)
class App:
    id: str
    label: str
    skills_dir: str      # relative to HOME
    markers: tuple[str, ...]  # any of these under HOME means the app is set up here


APPS = {
    "claude": App("claude", "Claude Code", ".claude/skills", (".claude",)),
    "codex": App("codex", "Codex", ".agents/skills", (".codex", ".agents")),
}


def checkout_root() -> Path:
    # backend/cli/commands/skill.py -> the checkout
    return Path(__file__).resolve().parents[3]


def skill_source(root: Path | None = None) -> Path:
    return (root or checkout_root()) / "skills" / SKILL_NAME


def _home() -> Path:
    return Path(os.path.expanduser("~"))


def _same_tree(left: Path, right: Path) -> bool:
    """True when two skill folders hold the same files with the same bytes."""
    compare = filecmp.dircmp(left, right, ignore=[STAMP, "__pycache__", ".DS_Store"])
    if compare.left_only or compare.right_only or compare.funny_files:
        return False
    _, mismatch, errors = filecmp.cmpfiles(left, right, compare.common_files, shallow=False)
    if mismatch or errors:
        return False
    return all(_same_tree(left / name, right / name) for name in compare.common_dirs)


def _backup_path(app_root: Path, now: datetime) -> Path:
    folder = app_root / "skill-backups"
    base = f"{SKILL_NAME}.backup-{now.strftime('%Y%m%d-%H%M%S')}"
    candidate = folder / base
    counter = 2
    while candidate.exists() or candidate.is_symlink():
        candidate = folder / f"{base}-{counter}"
        counter += 1
    return candidate


def install_one(app: App, source: Path, *, copy: bool, home: Path, now: datetime | None = None) -> str:
    """Install for one app; returns one line saying what happened."""
    skills_dir = home / app.skills_dir
    target = skills_dir / SKILL_NAME
    if target.is_symlink() or target.exists():
        if not copy and target.is_symlink() and target.resolve() == source.resolve():
            return f"{app.label}: already linked ({target} -> {source})"
        if copy and target.is_dir() and not target.is_symlink() and _same_tree(source, target):
            return f"{app.label}: the copy at {target} is already current"
    skills_dir.mkdir(parents=True, exist_ok=True)
    moved = ""
    if target.is_symlink() or target.exists():
        backup = _backup_path(skills_dir.parent, now or datetime.now())
        backup.parent.mkdir(parents=True, exist_ok=True)
        # os.rename moves a symlink itself, not what it points at.
        os.rename(target, backup)
        moved = f" (the old one is at {backup})"
    if copy:
        shutil.copytree(source, target, symlinks=False, ignore=shutil.ignore_patterns("__pycache__", ".DS_Store"))
        # source is <checkout>/skills/nebula.
        (target / STAMP).write_text(f"{source.parents[1]}\n", encoding="utf-8")
        return f"{app.label}: copied the skill to {target}{moved}"
    target.symlink_to(source, target_is_directory=True)
    return f"{app.label}: linked {target} -> {source}{moved}"


def run_install(args) -> int:
    source = skill_source()
    if not (source / "SKILL.md").is_file():
        print(f"error: this checkout has no nebula skill at {source}", file=sys.stderr)
        return 1
    home = _home()
    chosen = args.apps or "auto"
    if chosen == "all":
        apps = list(APPS.values())
    elif chosen == "auto":
        apps = [app for app in APPS.values() if any((home / marker).is_dir() for marker in app.markers)]
        if not apps:
            print("error: found no Claude Code (~/.claude) or Codex (~/.codex, ~/.agents) folder. "
                  "Pass --for claude or --for codex to install anyway.", file=sys.stderr)
            return 1
    else:
        apps = [APPS[chosen]]
    for app in apps:
        try:
            print(install_one(app, source, copy=args.copy, home=home))
        except OSError as exc:
            print(f"error: {app.label}: {exc}", file=sys.stderr)
            return 1
    print("Start a new session in the app to load it.")
    return 0


def add_parser(sub) -> None:
    skill_p = sub.add_parser("skill", help="Install the nebula skill for Claude Code and Codex")
    skill_sub = skill_p.add_subparsers(dest="skill_cmd", required=True)
    install_p = skill_sub.add_parser(
        "install", help="Link (or copy) this checkout's nebula skill into the apps' skill folders",
        description=("Links ~/.claude/skills/nebula (Claude Code) and ~/.agents/skills/nebula (Codex) to this "
                     "checkout's skills/nebula, so updates arrive with git pull. Anything already there "
                     "is moved to skill-backups/nebula.backup-<date-time> next to the skills folder."))
    install_p.add_argument("--copy", action="store_true",
                           help="Copy the skill instead of linking it (for when the checkout may move)")
    install_p.add_argument("--for", dest="apps", choices=["claude", "codex", "all"], default=None,
                           help="Which app (default: each one set up on this machine)")
