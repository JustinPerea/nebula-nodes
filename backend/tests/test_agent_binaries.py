"""agent_binaries: absolute paths without a shell, for a Dock-launched backend."""
from __future__ import annotations

import os
from pathlib import Path

import pytest

from services import agent_binaries


def make_exe(path: Path, body: str = "#!/bin/sh\necho v22.11.0\n") -> Path:
    path.parent.mkdir(parents=True, exist_ok=True)
    path.write_text(body)
    path.chmod(0o755)
    return path


@pytest.fixture(autouse=True)
def no_login_shell(monkeypatch):
    agent_binaries.login_shell_path.cache_clear()
    agent_binaries.node_major.cache_clear()
    monkeypatch.setattr(agent_binaries, "login_shell_path", lambda: "")
    # Keep the machine's own /opt/homebrew/bin and /usr/local/bin out of it.
    monkeypatch.setattr(agent_binaries, "_FIXED_DIRS", (".local/bin", ".npm-global/bin", ".volta/bin"))
    yield


def test_resolves_from_fixed_dirs_with_minimal_path(tmp_path):
    home = tmp_path / "home"
    gemini = make_exe(home / ".local" / "bin" / "gemini")
    assert agent_binaries.resolve("gemini", home=home, path_env="/usr/bin:/bin") == gemini
    assert agent_binaries.resolve("missing-tool", home=home, path_env="/usr/bin") is None


def test_newest_nvm_node_wins(tmp_path):
    home = tmp_path / "home"
    make_exe(home / ".nvm/versions/node/v18.2.0/bin/npx")
    newest = make_exe(home / ".nvm/versions/node/v22.11.0/bin/npx")
    make_exe(home / ".nvm/versions/node/v9.0.0/bin/npx")
    assert agent_binaries.resolve("npx", home=home, path_env="") == newest


def test_absolute_paths_must_be_executable_files(tmp_path):
    exe = make_exe(tmp_path / "agent")
    plain = tmp_path / "plain"
    plain.write_text("x")
    assert agent_binaries.resolve(str(exe)) == exe
    assert agent_binaries.resolve(str(plain)) is None
    assert agent_binaries.resolve(str(tmp_path)) is None
    assert agent_binaries.resolve("../agent") is None
    assert agent_binaries.resolve("a\x00b") is None


def test_login_shell_is_a_last_resort(tmp_path, monkeypatch):
    shell_dir = tmp_path / "shellbin"
    found = make_exe(shell_dir / "hermes")
    monkeypatch.setattr(agent_binaries, "login_shell_path", lambda: f"relative/dir{os.pathsep}{shell_dir}")
    assert agent_binaries.resolve("hermes", home=tmp_path / "home", path_env="") == found
    assert agent_binaries.resolve("hermes", home=tmp_path / "home", path_env="", use_login_shell=False) is None


def test_child_path_puts_the_binary_dir_first(tmp_path):
    home = tmp_path / "home"
    npx = make_exe(home / ".nvm/versions/node/v22.11.0/bin/npx")
    path = agent_binaries.child_path(npx, home=home, path_env="/usr/bin").split(os.pathsep)
    assert path[0] == str(npx.parent)
    assert "/usr/bin" in path and "/bin" in path


def test_node_major_reads_the_sibling_node(tmp_path):
    bin_dir = tmp_path / "bin"
    npx = make_exe(bin_dir / "npx")
    make_exe(bin_dir / "node", "#!/bin/sh\necho v22.11.0\n")
    assert agent_binaries.node_major(str(npx)) == 22
    lonely = make_exe(tmp_path / "other" / "npx")
    assert agent_binaries.node_major(str(lonely)) is None
