"""The cloud-session setup hook (.claude/settings.json runs
scripts/cloud-session-setup.sh on every session start and resume).

Outside a Claude Code cloud session it must do nothing at all: every local
session in this repo runs the hook. Inside one it installs what CI installs,
and skips each install while its inputs and the script are unchanged. These
tests run the real script with stand-in `python`, `npm` and `node` commands
that only record how they were called.
"""
from __future__ import annotations

import json
import os
import shutil
import stat
import subprocess
from pathlib import Path

import pytest

REPO = Path(__file__).resolve().parents[2]
SCRIPT = REPO / "scripts" / "cloud-session-setup.sh"
SETTINGS = REPO / ".claude" / "settings.json"

pytestmark = pytest.mark.skipif(
    shutil.which("bash") is None or shutil.which("sha256sum") is None,
    reason="needs bash and sha256sum",
)


def _stub(path: Path, body: str) -> None:
    path.parent.mkdir(parents=True, exist_ok=True)
    path.write_text("#!/bin/bash\n" + body, encoding="utf-8")
    path.chmod(path.stat().st_mode | stat.S_IXUSR)


def _project(tmp_path: Path) -> tuple[Path, Path, Path]:
    """A copy of the files the script reads, a venv whose python only records
    its calls, and stand-in npm/node on PATH. Returns (root, bin, calls)."""
    root = tmp_path / "repo"
    (root / "scripts").mkdir(parents=True)
    shutil.copy2(SCRIPT, root / "scripts" / SCRIPT.name)
    (root / "backend").mkdir()
    (root / "backend" / "requirements.txt").write_text("fastapi==0.115.12\n", encoding="utf-8")
    (root / "frontend").mkdir()
    (root / "frontend" / "package.json").write_text('{"name": "f"}\n', encoding="utf-8")
    (root / "frontend" / "package-lock.json").write_text('{"lockfileVersion": 3}\n', encoding="utf-8")
    calls = tmp_path / "calls.log"
    _stub(
        root / "backend" / ".venv" / "bin" / "python",
        f'echo "python $*" >> "{calls}"\n'
        'if [ "$1" = "--version" ]; then echo "Python 3.12.9"; fi\n',
    )
    bin_dir = tmp_path / "bin"
    _stub(
        bin_dir / "npm",
        f'echo "npm $* (in $(basename "$PWD"))" >> "{calls}"\n'
        'if [ "$1" = "ci" ]; then mkdir -p node_modules; fi\n',
    )
    _stub(bin_dir / "node", 'echo v22.0.0\n')
    return root, bin_dir, calls


def _run(root: Path, bin_dir: Path, remote: str | None, env_file: Path | None = None):
    env = {k: v for k, v in os.environ.items() if not k.startswith("CLAUDE_")}
    env["PATH"] = f"{bin_dir}{os.pathsep}{env.get('PATH', '')}"
    env["CLAUDE_PROJECT_DIR"] = str(root)
    if remote is not None:
        env["CLAUDE_CODE_REMOTE"] = remote
    if env_file is not None:
        env["CLAUDE_ENV_FILE"] = str(env_file)
    return subprocess.run(
        ["bash", str(root / "scripts" / SCRIPT.name)],
        cwd=root, env=env, capture_output=True, text=True, timeout=60,
    )


def _calls(calls: Path) -> list[str]:
    return calls.read_text(encoding="utf-8").splitlines() if calls.exists() else []


def test_settings_run_the_script_on_start_and_resume():
    hooks = json.loads(SETTINGS.read_text(encoding="utf-8"))["hooks"]
    assert list(hooks) == ["SessionStart"]
    [entry] = hooks["SessionStart"]
    assert set(entry["matcher"].split("|")) == {"startup", "resume"}
    [hook] = entry["hooks"]
    assert hook["type"] == "command"
    assert hook["command"] == 'bash "$CLAUDE_PROJECT_DIR"/scripts/cloud-session-setup.sh'
    # Claude Code cancels a SessionStart command after 600 s unless this says
    # otherwise; a cold install of both halves needs the headroom.
    assert 600 < hook["timeout"] <= 1800
    assert SCRIPT.is_file()


@pytest.mark.parametrize("remote", [None, "", "false", "1", "TRUE", "yes"])
def test_outside_the_cloud_it_does_nothing(tmp_path, remote):
    root, bin_dir, calls = _project(tmp_path)
    before = sorted(p.relative_to(root) for p in root.rglob("*"))
    result = _run(root, bin_dir, remote)
    assert result.returncode == 0
    assert result.stdout == "" and result.stderr == ""
    assert _calls(calls) == []
    assert sorted(p.relative_to(root) for p in root.rglob("*")) == before


def test_in_the_cloud_it_installs_once_then_skips(tmp_path):
    root, bin_dir, calls = _project(tmp_path)
    env_file = tmp_path / "env"

    first = _run(root, bin_dir, "true", env_file)
    assert first.returncode == 0, first.stderr
    made = _calls(calls)
    assert any(c.startswith("python -m pip install") and "backend/requirements.txt" in c for c in made)
    assert "python -c import cairosvg" in made
    assert "npm ci --no-audit --no-fund --loglevel=error (in frontend)" in made
    assert "backend: installed (Python 3.12.9)" in first.stdout
    assert "frontend: installed (node v22.0.0)" in first.stdout
    # `python -m pytest`, CI's command, finds the venv's python.
    assert f'export PATH="{root}/backend/.venv/bin:$PATH"' in env_file.read_text(encoding="utf-8")

    calls.unlink()
    again = _run(root, bin_dir, "true", env_file)
    assert again.returncode == 0, again.stderr
    assert [c for c in _calls(calls) if "pip install" in c or c.startswith("npm")] == []
    assert "backend: up to date" in again.stdout
    assert "frontend: up to date" in again.stdout

    # A changed lockfile reinstalls the frontend only.
    (root / "frontend" / "package-lock.json").write_text('{"lockfileVersion": 3, "x": 1}\n', encoding="utf-8")
    calls.unlink(missing_ok=True)
    changed = _run(root, bin_dir, "true", env_file)
    assert changed.returncode == 0, changed.stderr
    made = _calls(calls)
    assert [c for c in made if c.startswith("npm")] == ["npm ci --no-audit --no-fund --loglevel=error (in frontend)"]
    assert not any("pip install" in c for c in made)


@pytest.mark.skipif(shutil.which("git") is None or not (REPO / ".git").exists(), reason="needs a git checkout")
def test_only_claude_codes_settings_file_is_tracked():
    """The hook's settings.json is tracked; Nebula's own settings.json (API
    keys) stays ignored wherever it is, and so do Claude Code's local ones."""
    def ignored(path: str) -> bool:
        return subprocess.run(
            ["git", "-c", "core.excludesFile=/dev/null", "check-ignore", "-q", "--no-index", path],
            cwd=REPO,
        ).returncode == 0

    assert not ignored(".claude/settings.json")
    for path in ("settings.json", "backend/settings.json", "frontend/.claude/settings.json",
                 ".claude/settings.local.json"):
        assert ignored(path), path


def test_a_failed_pip_install_says_so_and_skips_nothing_next_time(tmp_path):
    root, bin_dir, calls = _project(tmp_path)
    _stub(
        root / "backend" / ".venv" / "bin" / "python",
        f'echo "python $*" >> "{calls}"\n'
        'if [ "$2" = "pip" ] && [ "$3" = "install" ]; then echo "ERROR: no matching distribution" >&2; exit 1; fi\n',
    )
    env_file = tmp_path / "env"

    first = _run(root, bin_dir, "true", env_file)
    assert first.returncode == 0
    assert "backend: FAILED (exit 1)" in first.stdout
    assert "no matching distribution" in first.stdout
    assert "frontend: installed" in first.stdout
    assert not (root / "backend" / ".venv" / ".cloud-setup.sha256").exists()
    # A broken venv isn't put first on PATH.
    assert not env_file.exists() or "backend/.venv" not in env_file.read_text(encoding="utf-8")

    calls.unlink()
    second = _run(root, bin_dir, "true")
    assert any("pip install" in c for c in _calls(calls))
    assert "backend: FAILED" in second.stdout
    assert "frontend: up to date" in second.stdout


def test_a_failed_install_says_so_and_runs_again_next_time(tmp_path):
    root, bin_dir, calls = _project(tmp_path)
    _stub(bin_dir / "npm", f'echo "npm $*" >> "{calls}"\necho "npm ERR! network" >&2\nexit 1\n')

    first = _run(root, bin_dir, "true")
    assert first.returncode == 0
    assert "frontend: FAILED (exit 1)" in first.stdout
    assert "npm ERR! network" in first.stdout
    assert not (root / "frontend" / "node_modules" / ".cloud-setup.sha256").exists()

    calls.unlink()
    second = _run(root, bin_dir, "true")
    assert any(c.startswith("npm ci") for c in _calls(calls))
    assert "frontend: FAILED" in second.stdout
