"""Exit when the desktop app that started this backend is gone.

Electron starts the backend as a sidecar and stops it on quit (SIGTERM, then
SIGKILL). If Electron crashes or is force-killed, that never happens, and the
backend would keep its port and run on forever.

So Electron also hands the sidecar one end of a pipe as file descriptor
``NEBULA_PARENT_WATCH_FD`` (desktop/sidecar.mjs) and never writes to it. The
kernel closes Electron's end whenever Electron exits, however it exits, and a
read on ours then returns EOF. A daemon thread waits for that, sends this
process SIGTERM so uvicorn shuts down normally, and hard-exits after a grace
period if that hangs.

Without the variable (browser dev, tests, the CLI) nothing is watched.
"""
from __future__ import annotations

import logging
import os
import signal
import threading
from typing import Callable, Mapping

log = logging.getLogger(__name__)

WATCH_FD_ENV = "NEBULA_PARENT_WATCH_FD"
GRACE_SECONDS = 5.0

_started = False
_lock = threading.Lock()


def parse_fd(value: str | None) -> int | None:
    """The watch fd from the env value, or None when unset or malformed."""
    if value is None or not value.strip().isdigit():
        return None
    fd = int(value)
    return fd if fd > 2 else None


def wait_for_eof(fd: int) -> None:
    """Block until the other end of ``fd`` is closed (or ``fd`` breaks)."""
    while True:
        try:
            chunk = os.read(fd, 4096)
        except InterruptedError:
            continue
        except OSError:
            return
        if not chunk:
            return
        # Electron never writes; ignore anything that arrives.


def _shut_down(grace: float = GRACE_SECONDS) -> None:
    log.warning("Desktop app is gone (parent pipe closed); shutting the backend down")
    timer = threading.Timer(grace, lambda: os._exit(0))
    timer.daemon = True
    timer.start()
    os.kill(os.getpid(), signal.SIGTERM)


def start(fd: int, on_parent_gone: Callable[[], None] = _shut_down) -> threading.Thread | None:
    """Watch ``fd`` on a daemon thread; call ``on_parent_gone`` at EOF."""
    try:
        os.fstat(fd)
    except OSError:
        log.warning("%s=%d is not an open file descriptor; not watching the parent", WATCH_FD_ENV, fd)
        return None

    def run() -> None:
        wait_for_eof(fd)
        on_parent_gone()

    thread = threading.Thread(target=run, name="nebula-parent-watch", daemon=True)
    thread.start()
    return thread


def start_from_env(env: Mapping[str, str] | None = None) -> threading.Thread | None:
    """Start the watchdog once per process when the desktop app asked for it."""
    global _started
    source = os.environ if env is None else env
    fd = parse_fd(source.get(WATCH_FD_ENV))
    if fd is None:
        if source.get(WATCH_FD_ENV):
            log.warning("Ignoring malformed %s", WATCH_FD_ENV)
        return None
    with _lock:
        if _started:
            return None
        _started = True
    return start(fd)
