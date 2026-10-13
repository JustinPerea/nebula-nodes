"""services/agent_token_file.py and backend/mcp_server.py's token file startup."""
from __future__ import annotations

import os
import stat
import subprocess
import sys
from pathlib import Path

import pytest

import mcp_server
from services import agent_token_file
from services.agent_token_file import TokenFileError

TOKEN = "fake-token-for-tests-0123456789abcdefghij"
BACKEND = Path(__file__).resolve().parent.parent


def test_write_read_remove(tmp_path):
    path = agent_token_file.write(tmp_path, "sess1", TOKEN)
    assert path.parent == tmp_path / "agent-tokens" / str(os.getpid())
    assert stat.S_IMODE(path.stat().st_mode) == 0o600
    assert stat.S_IMODE(path.parent.stat().st_mode) == 0o700
    assert stat.S_IMODE(path.parent.parent.stat().st_mode) == 0o700
    assert agent_token_file.read(path) == TOKEN
    with pytest.raises(FileExistsError):
        agent_token_file.write(tmp_path, "sess1", TOKEN)
    agent_token_file.remove(path)
    assert not path.exists()
    agent_token_file.remove(path)  # idempotent
    with pytest.raises(ValueError):
        agent_token_file.write(tmp_path, "../escape", TOKEN)


def test_an_existing_open_directory_is_tightened(tmp_path):
    base = tmp_path / "agent-tokens"
    base.mkdir(mode=0o755)
    os.chmod(base, 0o755)
    agent_token_file.write(tmp_path, "s", TOKEN)
    assert stat.S_IMODE(base.stat().st_mode) == 0o700


@pytest.mark.parametrize("problem", ["missing", "malformed", "too_large", "group_readable", "symlink", "directory",
                                     "empty"])
def test_read_fails_closed(tmp_path, problem):
    path = tmp_path / "t.token"
    if problem == "malformed":
        path.write_text("not a token!\n")
    elif problem == "too_large":
        path.write_text("a" * 600)
    elif problem == "empty":
        path.write_text("")
    elif problem == "group_readable":
        path.write_text(TOKEN)
        os.chmod(path, 0o640)
    elif problem == "symlink":
        real = tmp_path / "real.token"
        real.write_text(TOKEN)
        os.chmod(real, 0o600)
        path.symlink_to(real)
    elif problem == "directory":
        path.mkdir()
    if path.exists() and not path.is_symlink() and path.is_file() and problem != "group_readable":
        os.chmod(path, 0o600)
    with pytest.raises(TokenFileError):
        agent_token_file.read(path)


def test_clear_stale_keeps_live_backends(tmp_path):
    base = agent_token_file.root(tmp_path)
    dead = base / "999999999"
    live = base / str(os.getppid())  # a running process: another backend's folder
    for folder in (dead, live):
        folder.mkdir(parents=True)
        (folder / "x.token").write_text(TOKEN)
    (base / "stray-file").write_text("x")
    own = agent_token_file.write(tmp_path, "mine", TOKEN)  # a dead process with our pid, at startup
    assert agent_token_file.clear_stale(tmp_path) == 3
    assert live.exists() and not dead.exists() and not own.exists()
    assert agent_token_file.clear_stale(tmp_path / "nowhere") == 0


def test_mcp_server_loads_the_token_file(tmp_path):
    path = agent_token_file.write(tmp_path, "s", TOKEN)
    env = {"NEBULA_AGENT_TOKEN_FILE": str(path)}
    assert mcp_server.load_agent_token_file(env) is True
    assert env["NEBULA_AGENT_TOKEN"] == TOKEN
    # An in-app chat's token in the environment wins; no file needed.
    env = {"NEBULA_AGENT_TOKEN": "in-app", "NEBULA_AGENT_TOKEN_FILE": str(tmp_path / "missing")}
    assert mcp_server.load_agent_token_file(env) is False and env["NEBULA_AGENT_TOKEN"] == "in-app"
    assert mcp_server.load_agent_token_file({}) is False
    for bad in ({"NEBULA_AGENT_TOKEN_FILE": ""}, {"NEBULA_AGENT_TOKEN_FILE": str(tmp_path / "missing")}):
        with pytest.raises(ValueError):
            mcp_server.load_agent_token_file(bad)
        assert "NEBULA_AGENT_TOKEN" not in bad


@pytest.mark.parametrize("content", [None, "not a token!"])
def test_mcp_server_exits_when_the_token_file_is_bad(tmp_path, content):
    # Fail closed: never fall back to unauthenticated calls, which would land
    # on the shared outside budget with no workspace confinement.
    path = tmp_path / "t.token"
    if content is not None:
        path.write_text(content)
        os.chmod(path, 0o600)
    env = {k: v for k, v in os.environ.items() if k not in {"NEBULA_AGENT_TOKEN", "NEBULA_APP_TOKEN"}}
    env["NEBULA_AGENT_TOKEN_FILE"] = str(path)
    done = subprocess.run([sys.executable, str(BACKEND / "mcp_server.py"), "--url", "http://127.0.0.1:9"],
                          env=env, cwd=str(tmp_path), stdin=subprocess.DEVNULL, capture_output=True,
                          text=True, timeout=60)
    assert done.returncode != 0
    assert "agent token file" in done.stderr
