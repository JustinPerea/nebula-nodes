"""The person's launch token: where it comes from, and where it must never go."""
from __future__ import annotations

import asyncio
import io
import logging
import os
import pickle
import secrets
import subprocess
from pathlib import Path
from unittest.mock import AsyncMock, patch

import pytest

from services import person_session
from services.child_env import SECRET_ENV_KEYS, scrubbed_env

SECRETS = {
    "NEBULA_PERSON_TOKEN": "person-fixture",
    "NEBULA_CONNECTOR_ENCRYPTION_KEY": "vault-fixture",
    "NEBULA_INJECTED_KEYS": '{"OPENAI_API_KEY": "injected-fixture"}',
    "NEBULA_CONNECTOR_SESSION": "old-nonce-fixture",
    "NEBULA_APP_TOKEN": "nebula_app_fixture",
    "NEBULA_APP_TOKEN_FILE": "/tmp/app-tokens/fixture.token",
}


# -- the session ---------------------------------------------------------------

def test_session_is_validated_set_once_and_compared_exactly():
    session = person_session.PersonSession()
    for bad in ("", "short", secrets.token_urlsafe(33), "!" * 43, None):
        with pytest.raises(ValueError):
            session.set(bad)
    token = secrets.token_urlsafe(32)
    assert not session.verify(token)
    session.set(token)
    with pytest.raises(RuntimeError):
        session.set(secrets.token_urlsafe(32))
    assert session.verify(token)
    for wrong in ("", None, 42, token[:-1], token + "x", token.upper() if token != token.upper() else "x" * 43):
        assert not session.verify(wrong)


@pytest.mark.parametrize("name", ["NEBULA_PERSON_TOKEN_STDIN", "NEBULA_UI_TOKEN_STDIN"])
def test_desktop_stdin_sets_the_token_without_logging_it(fresh_person_session, monkeypatch, caplog, name):
    monkeypatch.delenv("NEBULA_PERSON_TOKEN_STDIN", raising=False)
    monkeypatch.delenv("NEBULA_UI_TOKEN_STDIN", raising=False)
    monkeypatch.setenv(name, "1")
    token = secrets.token_urlsafe(32)
    out = io.StringIO()
    person_session.initialize(stdin=io.StringIO(token + "\n"), stdout=out)
    assert fresh_person_session.verify(token)
    assert token not in caplog.text and token not in out.getvalue()


@pytest.mark.parametrize("line", ["", "invalid\n", "x" * 43])
def test_stdin_failure_leaves_no_person_at_all(fresh_person_session, monkeypatch, caplog, line):
    monkeypatch.setenv("NEBULA_PERSON_TOKEN_STDIN", "1")
    person_session.initialize(stdin=io.StringIO(line))
    if line == "x" * 43:
        # No newline from StringIO still parses; a real pipe needs one (below).
        assert fresh_person_session.is_set
        return
    assert not fresh_person_session.is_set
    assert "Person session unavailable" in caplog.text


def test_stdin_eof_or_timeout_fails_closed(fresh_person_session, monkeypatch):
    monkeypatch.setenv("NEBULA_PERSON_TOKEN_STDIN", "1")
    # EOF with a whole token but no newline (Electron closed stdin early).
    read, write = os.pipe()
    os.write(write, secrets.token_urlsafe(32).encode())
    os.close(write)
    with os.fdopen(read) as stdin:
        person_session.initialize(stdin=stdin, timeout=0.5)
    assert not fresh_person_session.is_set
    # A partial line that never finishes.
    read, write = os.pipe()
    try:
        os.write(write, b"partial")
        with os.fdopen(read) as stdin:
            person_session.initialize(stdin=stdin, timeout=0.03)
        assert not fresh_person_session.is_set
    finally:
        os.close(write)


def test_stdin_mode_never_falls_back_to_a_generated_token(fresh_person_session, monkeypatch):
    monkeypatch.setenv("NEBULA_PERSON_TOKEN_STDIN", "1")
    person_session.provide(secrets.token_urlsafe(32))
    out = io.StringIO()
    out.isatty = lambda: True
    person_session.initialize(stdin=io.StringIO(""), stdout=out)
    assert not fresh_person_session.is_set and out.getvalue() == ""


def test_a_provided_dev_token_is_used_as_is(fresh_person_session, monkeypatch):
    monkeypatch.delenv("NEBULA_PERSON_TOKEN_STDIN", raising=False)
    monkeypatch.delenv("NEBULA_UI_TOKEN_STDIN", raising=False)
    token = secrets.token_urlsafe(32)
    person_session.provide(token)
    out = io.StringIO()
    out.isatty = lambda: True
    person_session.initialize(stdout=out)
    assert fresh_person_session.verify(token)
    assert out.getvalue() == ""  # the launcher printed the link once, not each reload
    with pytest.raises(ValueError):
        person_session.provide("short")


def test_the_environment_is_never_a_source(fresh_person_session, monkeypatch):
    monkeypatch.delenv("NEBULA_PERSON_TOKEN_STDIN", raising=False)
    monkeypatch.delenv("NEBULA_UI_TOKEN_STDIN", raising=False)
    planted = secrets.token_urlsafe(32)
    monkeypatch.setenv("NEBULA_PERSON_TOKEN", planted)
    person_session.initialize(stdout=io.StringIO())
    assert fresh_person_session.is_set and not fresh_person_session.verify(planted)


@pytest.mark.parametrize("tty", [True, False])
def test_link_is_printed_only_on_a_terminal(fresh_person_session, monkeypatch, caplog, tty):
    monkeypatch.delenv("NEBULA_PERSON_TOKEN_STDIN", raising=False)
    monkeypatch.delenv("NEBULA_UI_TOKEN_STDIN", raising=False)
    monkeypatch.setenv("NEBULA_DEV_UI_ORIGIN", "http://localhost:5199")
    token = secrets.token_urlsafe(32)
    monkeypatch.setattr(person_session, "new_token", lambda: token)
    output = io.StringIO()
    output.isatty = lambda: tty
    with caplog.at_level(logging.INFO):
        person_session.initialize(stdout=output, backend_origin="http://127.0.0.1:8011")
    assert fresh_person_session.verify(token)
    expected = f"http://localhost:5199/#nebula-person={token}&backend=http://127.0.0.1:8011"
    assert (expected in output.getvalue()) is tty
    assert token not in caplog.text


@pytest.mark.parametrize("ui,backend", [
    ("https://evil.example", "http://127.0.0.1:8000"),
    ("http://localhost:5173", "http://evil.example:8000"),
    ("http://user:pw@localhost:5173", "http://127.0.0.1:8000"),
    ("http://localhost:5173/path", "http://127.0.0.1:8000"),
    ("javascript:alert(1)", "http://127.0.0.1:8000"),
])
def test_the_link_never_points_off_this_machine(ui, backend):
    assert person_session.person_link("t" * 43, backend, ui) is None


# -- the dev launcher ------------------------------------------------------------

def test_devserver_hands_the_token_to_the_worker_in_the_pickled_server(fresh_person_session, monkeypatch):
    import uvicorn

    import devserver

    token = secrets.token_urlsafe(32)
    server = devserver.PersonServer(uvicorn.Config("main:app"), token)
    # uvicorn's reload supervisor pickles the target (server.run) for the worker;
    # this round-trips our own object, never untrusted data.
    clone = pickle.loads(pickle.dumps(server.run)).__self__
    assert clone.person_token == token
    seen = []
    monkeypatch.setattr(uvicorn.Server, "run", lambda self, sockets=None: seen.append(person_session._provided))
    clone.run()
    assert seen == [token]
    assert token not in "".join(f"{k}={v}" for k, v in os.environ.items())


def test_devserver_main_builds_a_real_config_for_both_modes(monkeypatch):
    import uvicorn

    import devserver

    printed = []
    monkeypatch.setattr(devserver, "announce", lambda token, origin, **kw: printed.append((token, origin, kw)))
    monkeypatch.setattr(uvicorn.Config, "bind_socket", lambda self: "socket")
    supervised = []

    class FakeReload:
        def __init__(self, config, target, sockets):
            supervised.append((config, target, sockets))

        def run(self):
            pass

    monkeypatch.setattr(devserver, "ChangeReload", FakeReload)
    monkeypatch.setenv("NEBULA_URL", "http://127.0.0.1:8000")  # restored after the test
    for name in devserver.INHERITED_CREDENTIAL_ENV_KEYS:  # main() scrubs these; restore after
        monkeypatch.delenv(name, raising=False)
    devserver.main(["--port", "8123", "--ui", "http://localhost:5251"])
    (config, target, sockets), = supervised
    # Agent children (and the reload workers that start them) point at this backend, not 8000.
    from services.krea_agent_mcp import agent_child_env, resolve_nebula_url
    assert os.environ["NEBULA_URL"] == "http://127.0.0.1:8123"
    assert resolve_nebula_url() == "http://127.0.0.1:8123"
    assert agent_child_env()["NEBULA_URL"] == "http://127.0.0.1:8123"
    assert (config.app, config.host, config.port, config.should_reload) == ("main:app", "127.0.0.1", 8123, True)
    assert sockets == ["socket"]
    assert isinstance(target.__self__, devserver.PersonServer)
    assert target.__self__.person_token == printed[0][0]
    assert printed[0][1] == "http://127.0.0.1:8123"
    assert printed[0][2] == {"ui": "http://localhost:5251", "open_browser": False}

    ran = []
    monkeypatch.setattr(devserver.PersonServer, "run", lambda self, sockets=None: ran.append(self.config.should_reload))
    devserver.main(["--port", "8124", "--no-reload", "--open"])
    assert ran == [False]
    assert printed[1][2]["open_browser"] is True
    assert printed[1][0] != printed[0][0]  # a new token every launch


def test_devserver_drops_shell_credentials_before_any_worker_starts(monkeypatch, capsys):
    import uvicorn

    import devserver
    from services.credential_catalog import CREDENTIAL_PROVIDERS

    assert devserver.INHERITED_CREDENTIAL_ENV_KEYS == CREDENTIAL_PROVIDERS | {"NEBULA_APP_TOKEN", "NEBULA_AGENT_TOKEN"}
    for name in devserver.INHERITED_CREDENTIAL_ENV_KEYS:  # restored after the test
        monkeypatch.setenv(name, f"shell-fixture-{name}")
    monkeypatch.setenv("ANTHROPIC_DEFAULT_SONNET_MODEL", "kept-fixture")
    monkeypatch.setattr(devserver, "announce", lambda *a, **kw: None)
    seen = []

    class FakeReload:
        def __init__(self, config, target, sockets):
            # What a reload worker would inherit, captured when the supervisor is built.
            seen.append(dict(os.environ))

        def run(self):
            pass

    monkeypatch.setattr(uvicorn.Config, "bind_socket", lambda self: "socket")
    monkeypatch.setattr(devserver, "ChangeReload", FakeReload)
    devserver.main(["--port", "8125"])
    (worker_env,) = seen
    assert not devserver.INHERITED_CREDENTIAL_ENV_KEYS & set(worker_env)
    assert "shell-fixture" not in "".join(worker_env.values())
    assert worker_env["ANTHROPIC_DEFAULT_SONNET_MODEL"] == "kept-fixture"
    out = capsys.readouterr().out
    assert "OPENAI_API_KEY" in out and "shell-fixture" not in out  # names only, never values


def test_scrub_inherited_credentials_names_only_what_it_removed():
    import devserver

    env = {"FAL_KEY": "x", "PATH": "/bin", "NEBULA_AGENT_TOKEN": "y"}
    assert devserver.scrub_inherited_credentials(env) == ["FAL_KEY", "NEBULA_AGENT_TOKEN"]
    assert env == {"PATH": "/bin"}
    assert devserver.scrub_inherited_credentials(env) == []


def test_devserver_prints_or_opens_the_link_and_never_writes_it_elsewhere(monkeypatch, tmp_path):
    import devserver

    token = secrets.token_urlsafe(32)
    tty = io.StringIO()
    tty.isatty = lambda: True
    link = devserver.announce(token, "http://127.0.0.1:8123", ui="http://localhost:5251", open_browser=False, stdout=tty)
    assert link == f"http://localhost:5251/#nebula-person={token}&backend=http://127.0.0.1:8123"
    assert link in tty.getvalue()

    piped = io.StringIO()
    assert devserver.announce(token, "http://127.0.0.1:8123", ui=None, open_browser=False, stdout=piped) is None
    assert token not in piped.getvalue() and "--open" in piped.getvalue()

    opened = []
    monkeypatch.setattr(devserver.webbrowser, "open", opened.append)
    quiet = io.StringIO()
    devserver.announce(token, "http://127.0.0.1:8123", ui=None, open_browser=True, stdout=quiet)
    assert opened and token in opened[0] and token not in quiet.getvalue()


# -- every child loses the secrets ---------------------------------------------------

@pytest.fixture
def secret_env(monkeypatch):
    for key, value in SECRETS.items():
        monkeypatch.setenv(key, value)
    return SECRETS


def _assert_scrubbed(env):
    assert env is not None, "the child would inherit the backend's whole environment"
    assert not set(SECRET_ENV_KEYS) & set(env)
    assert "PATH" in env


def test_scrub_list_covers_every_secret():
    assert set(SECRETS) == set(SECRET_ENV_KEYS)
    assert scrubbed_env({"A": "1", **SECRETS}) == {"A": "1"}


def test_agent_children(secret_env):
    from services.krea_agent_mcp import agent_child_env
    _assert_scrubbed(agent_child_env())


def test_commons_reader_child(secret_env, monkeypatch):
    from commons import reader
    captured = {}
    monkeypatch.setattr(reader, "analysis_schema", lambda vocab, count: {})

    async def spawn(*cmd, **kwargs):
        captured.update(kwargs)
        raise OSError("stop here")

    result = asyncio.run(reader.read_image(b"", [], [], vocab=None, spawn=spawn))
    assert result.error and "cannot start claude" in result.error
    _assert_scrubbed(captured["env"])
    assert "NEBULA_AGENT_TOKEN" not in captured["env"]


def test_ffmpeg_and_ffprobe_children(secret_env, monkeypatch, tmp_path):
    from services import ffmpeg
    seen = []

    async def spawn(*cmd, **kwargs):
        seen.append(kwargs.get("env"))
        raise RuntimeError("stop here")

    monkeypatch.setattr(ffmpeg, "_spawn_subprocess", spawn)
    with pytest.raises(RuntimeError, match="stop here"):
        asyncio.run(ffmpeg.run_ffmpeg(["-f", "lavfi", "-i", "color=c=red:s=8x8:d=1", str(tmp_path / "x.mp4")]))
    source = tmp_path / "clip.mp4"
    source.write_bytes(b"x")
    monkeypatch.setattr(ffmpeg, "require_allowed_path", lambda path: Path(path))
    with pytest.raises(RuntimeError, match="stop here"):
        asyncio.run(ffmpeg.ffprobe_video(source))
    assert len(seen) == 2
    for env in seen:
        _assert_scrubbed(env)


def test_remotion_render_child(secret_env, monkeypatch, tmp_path):
    from services import remotion_render
    captured = {}

    async def spawn(*cmd, **kwargs):
        captured.update(kwargs)
        raise RuntimeError("stop here")

    monkeypatch.setattr(remotion_render, "_spawn_subprocess", spawn)
    monkeypatch.setattr(remotion_render, "require_allowed_path", lambda path: Path(path))
    with pytest.raises(RuntimeError, match="stop here"):
        asyncio.run(remotion_render.render_remotion_manifest({}, output_dir=tmp_path))
    _assert_scrubbed(captured["env"])


def test_reveal_in_finder_child(secret_env, monkeypatch, tmp_path):
    from fastapi.testclient import TestClient

    import main
    from services import output as output_mod

    monkeypatch.setattr(output_mod, "OUTPUT_ROOT", tmp_path)
    monkeypatch.setattr(main, "OUTPUT_ROOT", tmp_path)
    (tmp_path / "run1").mkdir()
    (tmp_path / "run1" / "clip.mp4").write_bytes(b"x")
    with patch("asyncio.create_subprocess_exec", return_value=AsyncMock()) as spawn:
        response = TestClient(main.app).post("/api/reveal", json={"url": "/api/outputs/run1/clip.mp4"})
    assert response.status_code == 200, response.text
    _assert_scrubbed(spawn.call_args.kwargs.get("env"))


def test_commons_media_children(secret_env, monkeypatch, tmp_path):
    from commons import media
    seen = []

    def run(args, **kwargs):
        seen.append(kwargs.get("env"))
        raise OSError("stop here")

    monkeypatch.setattr(media.subprocess, "run", run)
    with pytest.raises(media.MediaError):
        media.probe_video(tmp_path / "clip.mp4")
    with pytest.raises(media.MediaError):
        media._heic_to_png(b"heic")
    assert len(seen) == 2
    for env in seen:
        _assert_scrubbed(env)


def test_icloud_git_and_ps_children(secret_env, monkeypatch, tmp_path):
    from commons.icloud import DatalessDownloader
    from services import agent_knowledge, agent_process

    seen = []

    def run(args, **kwargs):
        seen.append(kwargs.get("env"))
        raise subprocess.SubprocessError("stop here")

    downloader = DatalessDownloader(timeout=0, run=run, stat=lambda path: os.stat(tmp_path))
    asyncio.run(downloader.download(tmp_path))
    monkeypatch.setattr(agent_knowledge.subprocess, "run", run)
    try:
        agent_knowledge._tracked_files(tmp_path)
    except Exception:  # noqa: BLE001 - only the spawn's env matters here
        pass

    async def spawn(*cmd, **kwargs):
        seen.append(kwargs.get("env"))
        raise OSError("stop here")

    monkeypatch.setattr(agent_process.asyncio, "create_subprocess_exec", spawn)
    with pytest.raises(OSError):
        asyncio.run(agent_process._read_posix_process_table())
    assert len(seen) == 3
    for env in seen:
        _assert_scrubbed(env)


def test_a_real_child_never_sees_the_secrets(secret_env):
    out = subprocess.run(["/usr/bin/env"], capture_output=True, text=True, env=scrubbed_env(), check=True).stdout
    for value in SECRETS.values():
        assert value not in out
