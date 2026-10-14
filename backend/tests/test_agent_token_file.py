"""services/agent_token_file.py, services/app_token_file.py and backend/mcp_server.py's token file startup."""
from __future__ import annotations

import os
import stat
import subprocess
import sys
from pathlib import Path

import pytest

import mcp_server
from services import agent_token_file, app_token_file, app_tokens
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


def test_clear_stale_never_follows_a_symlinked_folder(tmp_path):
    """A symlink planted at <state>/agent-tokens must not turn the startup
    sweep loose on the folder it points to."""
    victim = tmp_path / "victim"
    (victim / "keepme").mkdir(parents=True)
    (victim / "12345678").mkdir()
    (victim / "file.txt").write_text("hi")
    state = tmp_path / "state"
    state.mkdir()
    agent_token_file.root(state).symlink_to(victim, target_is_directory=True)
    assert agent_token_file.clear_stale(state) == 0
    assert sorted(p.name for p in victim.iterdir()) == ["12345678", "file.txt", "keepme"]
    # A symlinked pid folder inside a real one is unlinked, not followed.
    agent_token_file.root(state).unlink()
    base = agent_token_file.root(state)
    base.mkdir()
    (base / "999999999").symlink_to(victim, target_is_directory=True)
    assert agent_token_file.clear_stale(state) == 1
    assert not (base / "999999999").exists() and (victim / "file.txt").exists()


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
    assert "NEBULA_AGENT_TOKEN_FILE" in done.stderr and "token file" in done.stderr


# -- connected apps' token files (services/app_token_file.py) -----------------------

APP_TOKEN = "nebula_app_" + "A" * 43
APP_ID = "0123456789ab"


def test_app_token_file_write_and_remove(tmp_path):
    path = app_token_file.write(tmp_path, APP_ID, APP_TOKEN)
    assert path == tmp_path / "app-tokens" / f"{APP_ID}.token" == app_token_file.path_for(tmp_path, APP_ID)
    assert stat.S_IMODE(path.stat().st_mode) == 0o600
    assert stat.S_IMODE(path.parent.stat().st_mode) == 0o700
    assert app_token_file.read(path) == APP_TOKEN
    # Never overwrites: a second write for the same app fails.
    with pytest.raises(FileExistsError):
        app_token_file.write(tmp_path, APP_ID, APP_TOKEN)
    assert app_token_file.remove(tmp_path, APP_ID) is True
    assert not path.exists() and app_token_file.remove(tmp_path, APP_ID) is False
    for bad_id in ("../x", "a/b", "", "."):
        with pytest.raises(ValueError):
            app_token_file.write(tmp_path, bad_id, APP_TOKEN)
    with pytest.raises(ValueError):
        app_token_file.write(tmp_path, APP_ID, "short")


def test_app_token_file_refuses_a_symlinked_folder_or_file(tmp_path):
    """A symlink planted at <state>/app-tokens (or at the file's own name)
    must not send the token anywhere else."""
    victim = tmp_path / "victim"
    victim.mkdir()
    state = tmp_path / "state"
    state.mkdir()
    app_token_file.root(state).symlink_to(victim, target_is_directory=True)
    with pytest.raises(OSError):
        app_token_file.write(state, APP_ID, APP_TOKEN)
    assert list(victim.iterdir()) == []
    # Nor can a delete follow it.
    (victim / f"{APP_ID}.token").write_text("keep")
    assert app_token_file.remove(state, APP_ID) is False and (victim / f"{APP_ID}.token").exists()
    app_token_file.root(state).unlink()
    app_token_file.root(state).mkdir(mode=0o700)
    (app_token_file.root(state) / f"{APP_ID}.token").symlink_to(victim / "planted")
    with pytest.raises(FileExistsError):
        app_token_file.write(state, APP_ID, APP_TOKEN)
    assert not (victim / "planted").exists()


def test_an_open_app_tokens_folder_is_tightened(tmp_path):
    base = app_token_file.root(tmp_path)
    base.mkdir(mode=0o755)
    os.chmod(base, 0o755)
    app_token_file.write(tmp_path, APP_ID, APP_TOKEN)
    assert stat.S_IMODE(base.stat().st_mode) == 0o700


def test_the_store_writes_the_file_and_revoke_deletes_it(tmp_path):
    store = app_tokens.AppTokens(tmp_path / "app-tokens.json", token_dir=tmp_path)
    view, token = store.create("Desk")
    path = store.token_file(view["id"])
    assert path.is_absolute() and app_token_file.read(path) == token
    assert store.lookup(token)["id"] == view["id"]
    assert store.revoke(view["id"]) is True
    assert not path.exists() and store.lookup(token) is None
    # Without a token_dir (budget tests) nothing is written.
    bare = app_tokens.AppTokens(tmp_path / "bare.json")
    assert bare.create("x") and bare.token_file("abc") is None and bare.clear_unknown_files() == 0


def test_a_token_file_that_cant_be_written_makes_no_app(tmp_path):
    (tmp_path / "app-tokens").write_text("not a folder")
    store = app_tokens.AppTokens(tmp_path / "app-tokens.json", token_dir=tmp_path)
    with pytest.raises(app_tokens.AppTokenError, match="token file"):
        store.create("Desk")
    assert store.list() == [] and not (tmp_path / "app-tokens.json").exists()


def test_a_failed_save_removes_the_new_file(tmp_path, monkeypatch):
    store = app_tokens.AppTokens(tmp_path / "app-tokens.json", token_dir=tmp_path)

    def broken():
        raise OSError("disk full")

    monkeypatch.setattr(store, "_save", broken)
    with pytest.raises(OSError):
        store.create("Desk")
    assert store.list() == [] and list(app_token_file.root(tmp_path).iterdir()) == []


def test_startup_removes_files_of_apps_no_longer_active(tmp_path):
    store = app_tokens.AppTokens(tmp_path / "app-tokens.json", token_dir=tmp_path)
    kept, _ = store.create("Kept")
    gone, _ = store.create("Gone")
    base = app_token_file.root(tmp_path)
    # Revoked while the delete failed: the store forgot it, the file stayed.
    store._apps = [app for app in store._apps if app["id"] != gone["id"]]
    store._save()
    (base / "stray.tmp").write_text("x")
    (base / "folder").mkdir()
    victim = tmp_path / "victim.txt"
    victim.write_text("keep")
    (base / "deadbeef0000.token").symlink_to(victim)
    reloaded = app_tokens.AppTokens(tmp_path / "app-tokens.json", token_dir=tmp_path)
    assert reloaded.clear_unknown_files() == 4
    assert sorted(p.name for p in base.iterdir()) == [f"{kept['id']}.token"] and victim.read_text() == "keep"
    # An active app's name on a symlink is not its file: it goes too, unfollowed.
    (base / f"{kept['id']}.token").unlink()
    (base / f"{kept['id']}.token").symlink_to(victim)
    assert reloaded.clear_unknown_files() == 1 and victim.exists()


@pytest.mark.parametrize("damage", ["unreadable", "corrupt", "wrong shape"])
def test_startup_keeps_every_file_when_the_store_cant_be_read(tmp_path, damage):
    # The store keeps only hashes, so a deleted file can't be made again:
    # an unreadable store means "apps unknown", never "no apps".
    store_path = tmp_path / "app-tokens.json"
    store = app_tokens.AppTokens(store_path, token_dir=tmp_path)
    first, token = store.create("First")
    store.create("Second")
    base = app_token_file.root(tmp_path)
    before = sorted(p.name for p in base.iterdir())
    original = store_path.read_text()
    if damage == "unreadable":
        store_path.chmod(0)
    elif damage == "corrupt":
        store_path.write_text("{not json")
    else:
        store_path.write_text('{"apps": {"x": 1}}')
    try:
        assert app_tokens.AppTokens(store_path, token_dir=tmp_path).clear_unknown_files() == 0
    finally:
        store_path.chmod(0o600)
    assert sorted(p.name for p in base.iterdir()) == before
    store_path.write_text(original)
    readable = app_tokens.AppTokens(store_path, token_dir=tmp_path)
    assert readable.lookup(token)["id"] == first["id"]
    assert app_token_file.read(readable.token_file(first["id"])) == token


def test_the_startup_sweep_never_follows_a_symlinked_folder(tmp_path):
    victim = tmp_path / "victim"
    victim.mkdir()
    (victim / "precious.token").write_text("x")
    state = tmp_path / "state"
    state.mkdir()
    app_token_file.root(state).symlink_to(victim, target_is_directory=True)
    assert app_token_file.clear_unknown(state, []) == 0
    assert (victim / "precious.token").exists()


def test_main_startup_sweeps_app_token_files(monkeypatch, tmp_path):
    import asyncio

    import main

    store = app_tokens.AppTokens(tmp_path / "app-tokens.json", token_dir=tmp_path)
    view, _ = store.create("Kept")
    leftover = app_token_file.write(tmp_path, "ffffffffffff", APP_TOKEN)
    monkeypatch.setattr(main, "app_token_store", store)
    asyncio.run(main._personal_agents_startup())
    assert not leftover.exists() and store.token_file(view["id"]).exists()


def test_mcp_server_loads_the_app_token_file(tmp_path):
    path = app_token_file.write(tmp_path, APP_ID, APP_TOKEN)
    env = {"NEBULA_APP_TOKEN_FILE": str(path)}
    assert mcp_server.load_app_token_file(env) is True and env["NEBULA_APP_TOKEN"] == APP_TOKEN
    # The file replaces a raw token from an older config.
    env = {"NEBULA_APP_TOKEN_FILE": str(path), "NEBULA_APP_TOKEN": "nebula_app_old"}
    assert mcp_server.load_app_token_file(env) is True and env["NEBULA_APP_TOKEN"] == APP_TOKEN
    # An older config's raw token alone keeps working.
    env = {"NEBULA_APP_TOKEN": "nebula_app_old"}
    assert mcp_server.load_app_token_file(env) is False and env["NEBULA_APP_TOKEN"] == "nebula_app_old"
    # An agent token (in-app chat, or a personal agent's file) wins: the app file isn't read.
    for agent in ({"NEBULA_AGENT_TOKEN": "in-app"}, {"NEBULA_AGENT_TOKEN_FILE": str(tmp_path / "a.token")}):
        env = {**agent, "NEBULA_APP_TOKEN_FILE": str(tmp_path / "missing")}
        assert mcp_server.load_app_token_file(env) is False and "NEBULA_APP_TOKEN" not in env


@pytest.mark.parametrize("problem", ["missing", "empty_var", "group_readable", "symlink", "malformed"])
def test_a_bad_app_token_file_fails_closed(tmp_path, problem):
    path = tmp_path / "t.token"
    if problem == "group_readable":
        path.write_text(APP_TOKEN)
        os.chmod(path, 0o640)
    elif problem == "symlink":
        real = app_token_file.write(tmp_path, APP_ID, APP_TOKEN)
        path.symlink_to(real)
    elif problem == "malformed":
        path.write_text("nope nope")
        os.chmod(path, 0o600)
    env = {"NEBULA_APP_TOKEN_FILE": "" if problem == "empty_var" else str(path),
           "NEBULA_APP_TOKEN": "nebula_app_from_an_old_config"}
    with pytest.raises(ValueError, match="NEBULA_APP_TOKEN_FILE"):
        mcp_server.load_app_token_file(env)
    # Not even the raw token beside it survives: the server must exit, not fall back.
    assert "NEBULA_APP_TOKEN" not in env or problem == "empty_var"


@pytest.mark.parametrize("content", [None, "not a token!"])
def test_mcp_server_exits_when_the_app_token_file_is_bad(tmp_path, content):
    path = tmp_path / "t.token"
    if content is not None:
        path.write_text(content)
        os.chmod(path, 0o600)
    env = {k: v for k, v in os.environ.items() if not k.startswith("NEBULA_")}
    env["NEBULA_APP_TOKEN_FILE"] = str(path)
    env["NEBULA_APP_TOKEN"] = "nebula_app_from_an_old_config_0123456789"
    done = subprocess.run([sys.executable, str(BACKEND / "mcp_server.py"), "--url", "http://127.0.0.1:9"],
                          env=env, cwd=str(tmp_path), stdin=subprocess.DEVNULL, capture_output=True,
                          text=True, timeout=60)
    assert done.returncode != 0
    assert "NEBULA_APP_TOKEN_FILE" in done.stderr and "token file" in done.stderr
