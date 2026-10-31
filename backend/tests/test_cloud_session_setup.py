"""The cloud-session setup hook (.claude/settings.json runs
scripts/cloud-session-setup.sh whenever a session starts, resumes, clears,
compacts or forks).

Outside a Claude Code cloud session it must do nothing at all: every local
session in this repo runs the hook. Inside one it installs what CI installs at
start and resume, skipping each install while its inputs and the script are
unchanged, and on a clear, compaction or fork only puts the venv back on PATH.
These
tests run the real script on a PATH of stand-in commands (`uname`, `python3.12`,
`uv`, the venv's `python`, `npm`, `node`, `apt-get`) that only record how they
were called, plus the few real tools the script needs.
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
BASH = shutil.which("bash")
REAL_TOOLS = ("sha256sum", "mktemp", "tail", "dirname", "basename", "rm", "mkdir", "cp", "touch", "cat", "env", "flock", "sleep", "grep", "seq")
NPM_CI = "npm ci --no-audit --no-fund --loglevel=error (in frontend)"

pytestmark = pytest.mark.skipif(
    BASH is None or shutil.which("sha256sum") is None,
    reason="needs bash and sha256sum",
)


def _stub(path: Path, body: str) -> None:
    path.parent.mkdir(parents=True, exist_ok=True)
    path.write_text("#!" + BASH + "\n" + body, encoding="utf-8")
    path.chmod(path.stat().st_mode | stat.S_IXUSR)


def _venv_python(path: Path, calls: Path, cairo_after: Path | None = None) -> None:
    """A venv's python that records its calls. With `cairo_after`, importing
    cairosvg fails until that file exists (the stand-in apt-get makes it)."""
    cairo = f'if [ "$1" = "-c" ] && [ ! -e "{cairo_after}" ]; then exit 1; fi\n' if cairo_after else ""
    _stub(
        path,
        f'echo "python $*" >> "{calls}"\n'
        + cairo
        + 'if [ "$1" = "--version" ]; then echo "Python 3.12.9"; fi\n',
    )


class Project:
    def __init__(self, tmp_path: Path, *, venv: bool = True, os_name: str = "Linux", name: str = "repo"):
        self.tmp = tmp_path
        self.root = tmp_path / name
        self.bin = tmp_path / "bin"
        self.calls = tmp_path / "calls.log"
        self.env_file = tmp_path / "env"
        (self.root / "scripts").mkdir(parents=True)
        shutil.copy2(SCRIPT, self.root / "scripts" / SCRIPT.name)
        (self.root / "backend").mkdir()
        (self.root / "backend" / "requirements.txt").write_text("fastapi==0.115.12\n", encoding="utf-8")
        (self.root / "frontend").mkdir()
        (self.root / "frontend" / "package.json").write_text('{"name": "f"}\n', encoding="utf-8")
        (self.root / "frontend" / "package-lock.json").write_text('{"lockfileVersion": 3}\n', encoding="utf-8")
        for tool in REAL_TOOLS:
            if (found := shutil.which(tool)) is not None:
                (self.bin / tool).parent.mkdir(parents=True, exist_ok=True)
                (self.bin / tool).symlink_to(found)
        _stub(self.bin / "uname", f'echo {os_name}\n')
        _stub(self.bin / "node", 'echo v22.0.0\n')
        self.npm(f'if [ "$1" = "ci" ]; then mkdir -p node_modules; fi\n')
        if venv:
            _venv_python(self.root / "backend" / ".venv" / "bin" / "python", self.calls)

    def npm(self, body: str) -> None:
        _stub(self.bin / "npm", f'echo "npm $* (in $(basename "$PWD"))" >> "{self.calls}"\n' + body)

    def maker(self, name: str, *, venv_fails: bool = False, partial: bool = False,
              cairo_after: Path | None = None) -> None:
        """A python that makes a venv (whose python records its calls), or
        fails to; with `partial`, it leaves bin/python behind and then fails,
        as Ubuntu's python3 does without ensurepip."""
        venv_python = self.tmp / f"venv-python-{name.replace('/', '_')}"
        _venv_python(venv_python, self.calls, cairo_after)
        make = ('if [ "$1" = "-m" ] && [ "$2" = "venv" ]; then mkdir -p "$3/bin"; '
                f'cp "{venv_python}" "$3/bin/python"; fi\n')
        _stub(
            self.bin / name if "/" not in name else Path(name),
            f'echo "{name} $*" >> "{self.calls}"\n'
            + ('exit 1\n' if venv_fails else make + ('exit 1\n' if partial else '')),
        )

    def uv(self, *, finds: str | None) -> None:
        venv_python = self.tmp / "venv-python-uv"
        _venv_python(venv_python, self.calls)
        found = f'if [ "$1" = "python" ] && [ "$2" = "find" ]; then echo "{finds}"; exit 0; fi\n' if finds else \
            'if [ "$1" = "python" ]; then exit 1; fi\n'
        _stub(
            self.bin / "uv",
            f'echo "uv $*" >> "{self.calls}"\n' + found
            + 'if [ "$1" = "venv" ]; then d="${@: -1}"; mkdir -p "$d/bin"; '
            f'cp "{venv_python}" "$d/bin/python"; fi\n',
        )

    def run(self, remote: str | None = "true", *, source: str | None = "startup",
            env_file: bool = True) -> subprocess.CompletedProcess:
        """Runs the script as the hook does: the hook's JSON on stdin (none
        for `source=None`, a run by hand) and CLAUDE_ENV_FILE set. The script
        finds the checkout from its own path, so CLAUDE_PROJECT_DIR isn't set."""
        env = {k: v for k, v in os.environ.items() if not k.startswith("CLAUDE_")}
        env["PATH"] = str(self.bin)
        env["TMPDIR"] = str(self.tmp)
        if env_file:
            env["CLAUDE_ENV_FILE"] = str(self.env_file)
        if remote is not None:
            env["CLAUDE_CODE_REMOTE"] = remote
        stdin = json.dumps({"hook_event_name": "SessionStart", "source": source}) if source else ""
        return subprocess.run(
            [BASH, str(self.root / "scripts" / SCRIPT.name)],
            cwd=self.tmp, env=env, input=stdin, capture_output=True, text=True, timeout=60,
        )

    def export_line(self) -> str:
        return f'export PATH={self.root}/backend/.venv/bin:"$PATH"'

    def made(self) -> list[str]:
        calls = self.calls.read_text(encoding="utf-8").splitlines() if self.calls.exists() else []
        self.calls.unlink(missing_ok=True)
        return calls

    def files(self) -> list[Path]:
        return sorted(p.relative_to(self.root) for p in self.root.rglob("*"))


def _pip_installs(made: list[str]) -> list[str]:
    return [c for c in made if "pip install" in c]


def test_settings_run_the_script_on_every_session_start():
    hooks = json.loads(SETTINGS.read_text(encoding="utf-8"))["hooks"]
    assert list(hooks) == ["SessionStart"]
    [entry] = hooks["SessionStart"]
    # No matcher: /clear and forks start a new session id with an empty env
    # file, so the PATH export has to be written again then too.
    assert "matcher" not in entry
    [hook] = entry["hooks"]
    assert hook["type"] == "command"
    # Exec form, as the hooks docs advise for a path placeholder: no shell
    # (sh, Git Bash or PowerShell) parses the path.
    assert hook["command"] == "bash"
    assert hook["args"] == ["${CLAUDE_PROJECT_DIR}/scripts/cloud-session-setup.sh"]
    # Claude Code cancels a SessionStart command after 600 s unless this says
    # otherwise; a cold install of both halves needs the headroom.
    assert 600 < hook["timeout"] <= 1800
    assert SCRIPT.is_file()


@pytest.mark.parametrize("remote", [None, "", "false", "1", "TRUE", "yes"])
def test_outside_the_cloud_it_does_nothing(tmp_path, remote):
    project = Project(tmp_path)
    before = project.files()
    result = project.run(remote)
    assert result.returncode == 0
    assert result.stdout == "" and result.stderr == ""
    assert project.made() == []
    assert project.files() == before
    assert not project.env_file.exists()


def test_set_by_hand_on_a_mac_it_installs_nothing(tmp_path):
    project = Project(tmp_path, os_name="Darwin")
    before = project.files()
    result = project.run("true")
    assert result.returncode == 0
    assert result.stdout == "Cloud setup: this isn't a cloud machine (Darwin), so nothing was installed.\n"
    assert project.made() == []
    assert project.files() == before
    assert not project.env_file.exists()


def test_in_the_cloud_it_installs_once_then_skips(tmp_path):
    project = Project(tmp_path)

    first = project.run()
    assert first.returncode == 0, first.stderr
    made = project.made()
    assert any("backend/requirements.txt" in c for c in _pip_installs(made))
    assert "python -c import cairosvg" in made
    assert NPM_CI in made
    assert "backend: installed (Python 3.12.9)" in first.stdout
    assert "frontend: installed (node v22.0.0)" in first.stdout
    # `python -m pytest`, CI's command, finds the venv's python.
    assert project.export_line() in project.env_file.read_text(encoding="utf-8").splitlines()
    # Logs go under TMPDIR, so nothing piles up in /tmp.
    assert list(tmp_path.glob("nebula-cloud-setup.*"))

    again = project.run()
    assert again.returncode == 0, again.stderr
    made = project.made()
    assert _pip_installs(made) == [] and [c for c in made if c.startswith("npm")] == []
    assert "backend: up to date" in again.stdout
    assert "frontend: up to date" in again.stdout

    # A changed lockfile reinstalls the frontend only.
    (project.root / "frontend" / "package-lock.json").write_text('{"lockfileVersion": 3, "x": 1}\n', encoding="utf-8")
    changed = project.run()
    assert changed.returncode == 0, changed.stderr
    made = project.made()
    assert [c for c in made if c.startswith("npm")] == [NPM_CI]
    assert _pip_installs(made) == []


def test_a_new_venv_uses_python_3_12(tmp_path):
    project = Project(tmp_path, venv=False)
    project.maker("python3.12")
    result = project.run()
    made = project.made()
    assert "python3.12 -m venv backend/.venv" in made
    assert _pip_installs(made), made
    assert "backend: installed (Python 3.12.9)" in result.stdout


def test_without_ensurepip_uv_seeds_the_venv(tmp_path):
    project = Project(tmp_path, venv=False)
    project.maker("python3.12", venv_fails=True)
    project.uv(finds=None)
    result = project.run()
    made = project.made()
    assert "uv venv --quiet --seed --python python3.12 backend/.venv" in made
    assert _pip_installs(made), made
    assert "backend: installed" in result.stdout


def test_without_python_3_12_on_path_uv_finds_it(tmp_path):
    project = Project(tmp_path, venv=False)
    uv_python = str(tmp_path / "uv-pythons" / "python3.12")
    project.maker(uv_python)
    project.uv(finds=uv_python)
    project.run()
    made = project.made()
    assert "uv python find 3.12" in made
    # A 3.12 uv already has isn't downloaded again.
    assert not any(c.startswith("uv python install") for c in made)
    assert f"{uv_python} -m venv backend/.venv" in made
    assert _pip_installs(made), made


def test_with_neither_it_falls_back_to_python3(tmp_path):
    project = Project(tmp_path, venv=False)
    project.maker("python3")
    result = project.run()
    made = project.made()
    assert "python3 -m venv backend/.venv" in made
    assert "backend: installed" in result.stdout


def test_a_missing_libcairo_is_installed_without_prompts(tmp_path):
    project = Project(tmp_path, venv=False)
    cairo = tmp_path / "libcairo-installed"
    project.maker("python3.12", cairo_after=cairo)
    _stub(
        project.bin / "apt-get",
        f'echo "apt-get DEBIAN_FRONTEND=$DEBIAN_FRONTEND $*" >> "{project.calls}"\n'
        f'if [ "$*" != "${{*%install*}}" ]; then touch "{cairo}"; fi\n',
    )
    result = project.run()
    apt = [c for c in project.made() if c.startswith("apt-get")]
    lock = "-o DPkg::Lock::Timeout=120 -qq"
    assert apt == [
        f"apt-get DEBIAN_FRONTEND=noninteractive {lock} update",
        f"apt-get DEBIAN_FRONTEND=noninteractive {lock} install -y --no-install-recommends libcairo2",
    ]
    assert "backend: installed" in result.stdout


def test_a_failed_pip_install_says_so_and_skips_nothing_next_time(tmp_path):
    project = Project(tmp_path)
    _stub(
        project.root / "backend" / ".venv" / "bin" / "python",
        f'echo "python $*" >> "{project.calls}"\n'
        'if [ "$2" = "pip" ] && [ "$3" = "install" ]; then echo "ERROR: no matching distribution" >&2; exit 1; fi\n',
    )

    first = project.run()
    assert first.returncode == 0
    assert "backend: FAILED (exit 1)" in first.stdout
    assert "no matching distribution" in first.stdout
    assert "frontend: installed" in first.stdout
    assert not (project.root / "backend" / ".venv" / ".cloud-setup.sha256").exists()
    # A broken venv isn't put first on PATH.
    assert not project.env_file.exists() or "backend/.venv" not in project.env_file.read_text(encoding="utf-8")

    project.made()
    second = project.run()
    assert _pip_installs(project.made())
    assert "backend: FAILED" in second.stdout
    assert "frontend: up to date" in second.stdout


def test_a_failed_npm_install_says_so_and_runs_again_next_time(tmp_path):
    project = Project(tmp_path)
    project.npm('echo "npm ERR! network" >&2\nexit 1\n')

    first = project.run()
    assert first.returncode == 0
    assert "frontend: FAILED (exit 1)" in first.stdout
    assert "npm ERR! network" in first.stdout
    assert not (project.root / "frontend" / "node_modules" / ".cloud-setup.sha256").exists()

    project.made()
    second = project.run()
    assert NPM_CI in project.made()
    assert "frontend: FAILED" in second.stdout


@pytest.mark.parametrize("source", ["clear", "compact", "fork"])
def test_mid_session_it_only_puts_the_venv_back_on_path(tmp_path, source):
    project = Project(tmp_path)
    project.run()
    project.made()
    project.env_file.unlink()
    # The agent changed the lockfile since: no npm ci under its feet now.
    (project.root / "frontend" / "package-lock.json").write_text('{"lockfileVersion": 3, "x": 1}\n', encoding="utf-8")

    result = project.run(source=source)
    made = project.made()
    assert _pip_installs(made) == [] and [c for c in made if c.startswith("npm")] == []
    assert project.env_file.read_text(encoding="utf-8").splitlines() == [project.export_line()]
    assert result.stdout.startswith(f"Nebula cloud setup ({source}): backend/.venv is on PATH, but the dependencies changed")

    (project.root / "frontend" / "package-lock.json").write_text('{"lockfileVersion": 3}\n', encoding="utf-8")
    assert project.run(source=source).stdout == (
        f"Nebula cloud setup ({source}): backend/.venv is on PATH; dependencies are up to date.\n"
    )


def test_mid_session_without_a_venv_it_says_to_run_setup(tmp_path):
    project = Project(tmp_path, venv=False)
    result = project.run(source="compact")
    assert project.made() == []
    assert not project.env_file.exists()
    assert "there's no backend/.venv yet" in result.stdout


def test_a_run_by_hand_prints_the_path_line(tmp_path):
    """A Bash command gets no CLAUDE_ENV_FILE, so the script can't set PATH
    for later commands itself."""
    project = Project(tmp_path)
    result = project.run(source=None, env_file=False)
    assert "backend: installed" in result.stdout
    assert f"Start each command that runs CI's backend steps with `{project.export_line()} &&`" in result.stdout


def test_the_venv_is_on_path_before_the_frontend_finishes(tmp_path):
    """A hook timeout while npm ci still runs mustn't lose the backend."""
    project = Project(tmp_path)
    project.npm(
        f'for i in $(seq 1 50); do grep -q "backend/.venv/bin" "{project.env_file}" 2>/dev/null && break; sleep 0.1; done\n'
        f'if grep -q "backend/.venv/bin" "{project.env_file}" 2>/dev/null; then echo "export: seen" >> "{project.calls}"; '
        f'else echo "export: not yet" >> "{project.calls}"; fi\n'
        'mkdir -p node_modules\n'
    )
    project.run()
    assert "export: seen" in project.made()


def test_the_path_line_survives_odd_characters(tmp_path):
    project = Project(tmp_path, name='re po$(touch pwned)"q')
    project.run()
    sourced = subprocess.run(
        [BASH, "-c", f'PATH=/usr/bin:/bin; . "{project.env_file}"; printf %s "${{PATH%%:*}}"'],
        capture_output=True, text=True, cwd=tmp_path,
    )
    assert sourced.stdout == f"{project.root}/backend/.venv/bin"
    assert not (tmp_path / "pwned").exists()


def test_someone_elses_venv_without_pip_is_never_deleted(tmp_path):
    project = Project(tmp_path, venv=False)
    venv = project.root / "backend" / ".venv"
    _stub(
        venv / "bin" / "python",
        f'echo "python $*" >> "{project.calls}"\n'
        'if [ "$1 $2" = "-m pip" ] && [ "$3" = "--version" ]; then exit 1; fi\n',
    )
    (venv / "their-file").write_text("kept\n", encoding="utf-8")
    project.maker("python3.12")
    project.run()
    made = project.made()
    assert "python -m ensurepip --upgrade" in made
    assert not any(c.startswith("python3.12 -m venv") for c in made)
    assert (venv / "their-file").read_text(encoding="utf-8") == "kept\n"


def test_its_own_venv_without_pip_is_made_again(tmp_path):
    project = Project(tmp_path, venv=False)
    project.maker("python3.12")
    project.run()
    venv = project.root / "backend" / ".venv"
    assert (venv / ".cloud-setup-owned").exists()
    # Later pip goes missing, and requirements.txt changes.
    _stub(venv / "bin" / "python", 'if [ "$1 $2" = "-m pip" ]; then exit 1; fi\n')
    (project.root / "backend" / "requirements.txt").write_text("fastapi==0.115.13\n", encoding="utf-8")
    project.made()
    project.run()
    made = project.made()
    assert "python3.12 -m venv backend/.venv" in made
    assert _pip_installs(made), made


def test_a_half_made_venv_is_removed_and_made_again(tmp_path):
    project = Project(tmp_path, venv=False)
    project.maker("python3.12", partial=True)
    # uv gets as far as a folder, then fails (a proxy blip while it fetches pip).
    _stub(project.bin / "uv", f'echo "uv $*" >> "{project.calls}"\n'
          'if [ "$1" = "venv" ]; then mkdir -p "${@: -1}/bin"; fi\nexit 1\n')
    first = project.run()
    assert "backend: FAILED" in first.stdout
    assert not (project.root / "backend" / ".venv").exists()

    assert any(c.startswith("uv venv") for c in project.made())
    project.maker("python3.12")
    second = project.run()
    assert "python3.12 -m venv backend/.venv" in project.made()
    assert "backend: installed" in second.stdout


def test_its_own_venv_starts_clean_when_requirements_change(tmp_path):
    """CI installs into a fresh environment, so a package dropped from
    requirements.txt mustn't linger here."""
    project = Project(tmp_path, venv=False)
    project.maker("python3.12")
    project.run()
    leftover = project.root / "backend" / ".venv" / "lib" / "dropped_pkg"
    leftover.mkdir(parents=True)
    (project.root / "backend" / "requirements.txt").write_text("fastapi==0.115.13\n", encoding="utf-8")
    project.made()
    project.run()
    assert "python3.12 -m venv backend/.venv" in project.made()
    assert not leftover.exists()


def test_mid_session_a_failed_backend_stays_off_path(tmp_path):
    project = Project(tmp_path)
    _stub(
        project.root / "backend" / ".venv" / "bin" / "python",
        'if [ "$2" = "pip" ] && [ "$3" = "install" ]; then exit 1; fi\n',
    )
    project.run()
    assert not project.env_file.exists()
    result = project.run(source="compact")
    assert not project.env_file.exists()
    assert result.stdout.startswith("Nebula cloud setup (compact): the last backend install didn't finish, so backend/.venv isn't on PATH.")


def test_mid_session_a_failed_frontend_is_named(tmp_path):
    project = Project(tmp_path)
    project.npm('exit 1\n')
    project.run()
    project.env_file.unlink()
    result = project.run(source="clear")
    assert project.env_file.read_text(encoding="utf-8").splitlines() == [project.export_line()]
    assert "but the last frontend install didn't finish" in result.stdout


@pytest.mark.skipif(shutil.which("flock") is None, reason="flock is Linux-only (util-linux)")
def test_installs_hold_the_checkout_lock(tmp_path):
    project = Project(tmp_path)
    lock = project.root / ".cloud-setup.lock"
    project.npm(
        f'if flock -n "{lock}" true; then echo "lock: free" >> "{project.calls}"; '
        f'else echo "lock: held" >> "{project.calls}"; fi\n'
        'if [ "$1" = "ci" ]; then mkdir -p node_modules; fi\n'
    )
    project.run()
    assert "lock: held" in project.made()


@pytest.mark.skipif(shutil.which("git") is None, reason="needs git")
def test_only_claude_codes_settings_file_is_tracked(tmp_path):
    """The hook's settings.json is tracked; Nebula's own settings.json (API
    keys) stays ignored wherever it is, and so do Claude Code's local ones.
    Read from the repo's .gitignore alone, in a scratch repo, so nobody's
    global excludes or .git/info/exclude decide it."""
    # Under a git hook GIT_DIR and friends point at the real repository.
    env = {k: v for k, v in os.environ.items() if not k.startswith("GIT_")}
    subprocess.run(["git", "init", "-q", str(tmp_path)], check=True, env=env)
    shutil.copy2(REPO / ".gitignore", tmp_path / ".gitignore")

    def ignored(path: str) -> bool:
        rc = subprocess.run(
            ["git", "-c", "core.excludesFile=/dev/null", "check-ignore", "-q", "--no-index", path],
            cwd=tmp_path, env=env,
        ).returncode
        assert rc in (0, 1), f"git check-ignore failed ({rc}) on {path}"
        return rc == 0

    assert not ignored(".claude/settings.json")
    for path in ("settings.json", "backend/settings.json", "frontend/.claude/settings.json",
                 ".claude/settings.local.json", "backend/.claude/settings.local.json",
                 ".cloud-setup.lock"):
        assert ignored(path), path
