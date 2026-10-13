"""services/parent_watch.py: the desktop sidecar exits when Electron is gone."""
from __future__ import annotations

import os
import signal
import subprocess
import sys
import textwrap
import threading
import time
from pathlib import Path

import pytest

from services import parent_watch

BACKEND_DIR = Path(__file__).resolve().parents[1]


@pytest.mark.parametrize("value, expected", [
    (None, None), ("", None), ("abc", None), ("-3", None), ("0", None), ("2", None),
    ("3", 3), (" 7 ", 7),
])
def test_parse_fd(value, expected):
    assert parent_watch.parse_fd(value) == expected


def test_start_from_env_without_the_variable_watches_nothing():
    assert parent_watch.start_from_env({}) is None


def test_closed_fd_is_not_watched():
    read_fd, write_fd = os.pipe()
    os.close(read_fd)
    os.close(write_fd)
    called = []
    assert parent_watch.start(read_fd, lambda: called.append(1)) is None
    assert called == []


def test_eof_on_the_pipe_calls_back():
    read_fd, write_fd = os.pipe()
    gone = threading.Event()
    try:
        thread = parent_watch.start(read_fd, gone.set)
        assert thread is not None
        os.write(write_fd, b"ignored")
        assert not gone.wait(0.2), "data on the pipe is not EOF"
        os.close(write_fd)
        write_fd = -1
        assert gone.wait(5), "EOF did not trigger the callback"
        thread.join(5)
    finally:
        if write_fd >= 0:
            os.close(write_fd)
        os.close(read_fd)


def test_real_process_shuts_down_when_the_parent_end_closes():
    """A child watching an inherited pipe gets SIGTERM'd by its own watchdog."""
    read_fd, write_fd = os.pipe()
    script = textwrap.dedent(f"""
        import signal, sys, time
        sys.path.insert(0, {str(BACKEND_DIR)!r})
        from services import parent_watch
        signal.signal(signal.SIGTERM, lambda *_: (print("SIGTERM", flush=True), sys.exit(0)))
        parent_watch.start_from_env()
        print("READY", flush=True)
        time.sleep(30)
        print("TIMEOUT", flush=True)
    """)
    env = {**os.environ, parent_watch.WATCH_FD_ENV: str(read_fd)}
    proc = subprocess.Popen(
        [sys.executable, "-c", script], env=env, pass_fds=(read_fd,),
        stdout=subprocess.PIPE, text=True,
    )
    os.close(read_fd)
    try:
        assert proc.stdout.readline().strip() == "READY"
        started = time.monotonic()
        os.close(write_fd)
        write_fd = -1
        out, _ = proc.communicate(timeout=10)
        assert "SIGTERM" in out
        assert proc.returncode == 0
        assert time.monotonic() - started < 5
    finally:
        if write_fd >= 0:
            os.close(write_fd)
        if proc.poll() is None:
            proc.send_signal(signal.SIGKILL)
            proc.wait()


def test_start_from_env_removes_the_variable_from_this_process(monkeypatch):
    """Read once, then dropped, so nothing the backend starts inherits it."""
    read_fd, write_fd = os.pipe()
    seen = []
    monkeypatch.setattr(parent_watch, "_started", False)
    monkeypatch.setattr(parent_watch, "start", lambda fd: seen.append(fd))
    monkeypatch.setenv(parent_watch.WATCH_FD_ENV, str(read_fd))
    try:
        parent_watch.start_from_env()
        assert seen == [read_fd]
        assert parent_watch.WATCH_FD_ENV not in os.environ
    finally:
        os.close(read_fd)
        os.close(write_fd)


def test_malformed_variable_is_removed_too(monkeypatch):
    monkeypatch.setattr(parent_watch, "_started", False)
    monkeypatch.setenv(parent_watch.WATCH_FD_ENV, "nope")
    assert parent_watch.start_from_env() is None
    assert parent_watch.WATCH_FD_ENV not in os.environ


def test_scrubbed_env_strips_the_watch_fd():
    from services.child_env import scrubbed_env
    env = scrubbed_env({parent_watch.WATCH_FD_ENV: "3", "PATH": "/usr/bin"})
    assert env == {"PATH": "/usr/bin"}


def test_child_of_a_watched_process_does_not_inherit_the_variable():
    """A watched process's children (plain env inheritance, or scrubbed_env) never see it."""
    read_fd, write_fd = os.pipe()
    script = textwrap.dedent(f"""
        import os, subprocess, sys
        sys.path.insert(0, {str(BACKEND_DIR)!r})
        from services import parent_watch
        from services.child_env import scrubbed_env
        parent_watch.start_from_env()
        probe = [sys.executable, "-c",
                 "import os; print(os.environ.get({parent_watch.WATCH_FD_ENV!r}, 'absent'))"]
        inherited = subprocess.run(probe, capture_output=True, text=True).stdout.strip()
        scrubbed = subprocess.run(probe, capture_output=True, text=True, env=scrubbed_env()).stdout.strip()
        print(inherited, scrubbed, flush=True)
    """)
    env = {**os.environ, parent_watch.WATCH_FD_ENV: str(read_fd)}
    proc = subprocess.run(
        [sys.executable, "-c", script], env=env, pass_fds=(read_fd,),
        capture_output=True, text=True, timeout=30,
    )
    os.close(read_fd)
    os.close(write_fd)
    assert proc.returncode == 0, proc.stderr
    assert proc.stdout.split() == ["absent", "absent"]


def test_backend_app_started_by_a_watched_process_child_is_not_killed(tmp_path):
    """The reviewer's repro: a child that boots the FastAPI app (TestClient
    lifespan, as pytest does) used to inherit the variable, find some other
    file at that fd number, read EOF from it and SIGTERM itself (rc 143)."""
    read_fd, write_fd = os.pipe()
    child = textwrap.dedent(f"""
        import os, sys
        sys.path.insert(0, {str(BACKEND_DIR)!r})
        os.chdir({str(BACKEND_DIR)!r})
        # Whatever fd number the variable names (or 3 when it is gone), put a
        # file there that reads EOF at once, as an unrelated open file would.
        n = int(os.environ.get({parent_watch.WATCH_FD_ENV!r}, "3"))
        os.dup2(os.open(os.devnull, os.O_RDONLY), n)
        from fastapi.testclient import TestClient
        import main
        with TestClient(main.app) as client:
            print("STATUS", client.get("/api/health").status_code, flush=True)
            import time; time.sleep(1.0)
        print("SURVIVED", flush=True)
    """)
    parent = textwrap.dedent(f"""
        import subprocess, sys
        sys.path.insert(0, {str(BACKEND_DIR)!r})
        from services import parent_watch
        parent_watch.start_from_env()
        result = subprocess.run([sys.executable, "-c", {child!r}],
                                capture_output=True, text=True, timeout=120)
        print("RC", result.returncode, flush=True)
        print(result.stdout, flush=True)
        print(result.stderr[-2000:], file=sys.stderr, flush=True)
    """)
    env = {
        **os.environ,
        parent_watch.WATCH_FD_ENV: str(read_fd),
        "NEBULA_SETTINGS_PATH": str(tmp_path / "settings.json"),
        "NEBULA_STATE_DIR": str(tmp_path / "state"),
        "NEBULA_OUTPUT_ROOT": str(tmp_path / "output"),
    }
    proc = subprocess.run(
        [sys.executable, "-c", parent], env=env, pass_fds=(read_fd,),
        capture_output=True, text=True, timeout=180,
    )
    os.close(read_fd)
    os.close(write_fd)
    assert "RC 0" in proc.stdout, proc.stdout + proc.stderr
    assert "STATUS 200" in proc.stdout and "SURVIVED" in proc.stdout, proc.stdout + proc.stderr
