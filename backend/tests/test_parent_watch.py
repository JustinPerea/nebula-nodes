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
