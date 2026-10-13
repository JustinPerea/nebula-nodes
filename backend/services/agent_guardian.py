"""Kill in-app agent CLIs when the backend dies without stopping them.

Every agent turn (``claude``/``codex`` and their preflights) runs in its own
session (``agent_process.agent_process_group_options``), so signals aimed at
the backend never reach it. On a normal shutdown that's fine: uvicorn closes
``/ws/chat``, the turn's task is cancelled and ``terminate_agent_process_tree``
kills the whole tree (checked live: SIGTERM to the backend mid-turn leaves
nothing behind). But when the backend itself is killed outright (Electron's
SIGKILL after its 5 s grace, parent_watch's ``os._exit`` fallback, a crash, a
``kill -9``), no Python code runs, and the agent and everything it started
kept running, with tool access, spending money. macOS has no
parent-death signal, so the only reliable observer is another process.

The guardian is that process. The backend starts one lazily, on the first
agent spawn, in its own session and holding the read end of a pipe whose
write end only the backend has. The backend writes ``+<pid>`` when it starts
an agent and ``-<pid>`` when that agent exits. The kernel closes the write
end when the backend exits, however it exits; the guardian then reads EOF,
kills the tree of every agent still registered, and exits. After a normal
shutdown nothing is registered and it just exits.

Safety: the guardian only kills a pid it accepted at registration, and it
accepts one only if that process leads its own process group
(``start_new_session``) and is a child of the backend (or of launchd, when
the backend died before the guardian read the line). It checks the group
again before killing. A fake process in a unit test (any pid) is never
accepted. What remains is pid reuse inside the instant between an agent
exiting and its ``-pid`` line arriving, by an unrelated process that also
leads its own group; that is accepted as negligible.

Run as a script, this file is the guardian itself:
``python -I agent_guardian.py <backend pid>``.
"""
from __future__ import annotations

import asyncio
import logging
import os
import signal
import subprocess
import sys
import threading
from pathlib import Path
from typing import Any

log = logging.getLogger(__name__)

_BACKEND_DIR = Path(__file__).resolve().parent.parent

_lock = threading.Lock()
_guardian: subprocess.Popen[bytes] | None = None
_tracked: set[int] = set()
_waiters: set[asyncio.Task[None]] = set()


# --------------------------------------------------------------------------
# Backend side
# --------------------------------------------------------------------------

def _start_guardian() -> subprocess.Popen[bytes] | None:
    from services.child_env import scrubbed_env

    try:
        return subprocess.Popen(
            [sys.executable, "-I", str(Path(__file__).resolve()), str(os.getpid())],
            stdin=subprocess.PIPE,
            stdout=subprocess.DEVNULL,
            # Not the backend's stderr: in the desktop app that is a pipe to
            # Electron, and writing to it after Electron is gone would kill
            # the guardian with SIGPIPE before it has done its job.
            stderr=subprocess.DEVNULL,
            cwd=str(_BACKEND_DIR),
            env=scrubbed_env(),
            # Its own session, so a signal to the backend's group (Ctrl-C in
            # a terminal, a group kill) doesn't take the guardian with it.
            start_new_session=True,
            close_fds=True,
        )
    except OSError as exc:
        log.warning("Could not start the agent guardian: %s", exc)
        return None


def _send(line: str) -> None:
    """Write one line to the guardian, starting (or restarting) it if needed."""
    global _guardian
    with _lock:
        for _ in range(2):
            if _guardian is None or _guardian.poll() is not None:
                _guardian = _start_guardian()
                if _guardian is None:
                    return
                # A restarted guardian knows nothing yet.
                line = "".join(f"+{pid}\n" for pid in sorted(_tracked)) + line
            assert _guardian.stdin is not None
            try:
                _guardian.stdin.write(line.encode("ascii"))
                _guardian.stdin.flush()
                return
            except (BrokenPipeError, OSError):
                _guardian = None


def _forget(pid: int) -> None:
    with _lock:
        if pid not in _tracked:
            return
        _tracked.discard(pid)
    _send(f"-{pid}\n")


async def _forget_when_done(proc: Any, pid: int) -> None:
    """Deregister ``pid`` once the agent has really exited, and only then.

    Not in a ``finally``: at shutdown ``asyncio.run`` cancels this task
    together with the chat turn that is still killing the agent's tree. If
    a cancelled wait deregistered the pid and the backend then hard-exited
    (parent_watch's ``os._exit``, Electron's SIGKILL) before the tree kill
    finished, the guardian would leave the agent running, which is the case
    it exists for. Staying registered is safe: the guardian re-checks that
    the pid still leads its own group under the dead backend before killing.
    """
    try:
        await proc.wait()
    except asyncio.CancelledError:
        if proc.returncode is None:
            raise
    except Exception:
        pass
    if proc.returncode is not None:
        _forget(pid)


def track(proc: Any) -> None:
    """Have the guardian kill ``proc``'s tree if the backend dies first.

    Only real asyncio subprocesses on POSIX are tracked; test doubles are
    skipped (and the guardian would refuse their pids anyway).
    """
    if os.name != "posix" or type(proc) is not asyncio.subprocess.Process:
        return
    pid = proc.pid
    if not isinstance(pid, int) or pid <= 0 or proc.returncode is not None:
        return
    with _lock:
        _tracked.add(pid)
    _send(f"+{pid}\n")
    task = asyncio.get_running_loop().create_task(_forget_when_done(proc, pid))
    _waiters.add(task)
    task.add_done_callback(_waiters.discard)


# --------------------------------------------------------------------------
# Guardian side
# --------------------------------------------------------------------------

def _parent_of(pid: int) -> int | None:
    try:
        out = subprocess.run(
            ["ps", "-o", "ppid=", "-p", str(pid)],
            capture_output=True, text=True, timeout=5,
        ).stdout.strip()
        return int(out) if out else None
    except (OSError, ValueError, subprocess.SubprocessError):
        return None


def _leads_own_group(pid: int) -> bool:
    try:
        return os.getpgid(pid) == pid
    except OSError:
        return False


def _alive(pid: int) -> bool:
    try:
        os.kill(pid, 0)
    except ProcessLookupError:
        return False
    except PermissionError:
        return True
    return True


def _accept(pid: int, backend_pid: int) -> bool:
    """A pid is an agent only if the backend started it in its own session.

    Its parent is the backend, or launchd (pid 1) when the backend was
    killed between writing the registration and the guardian reading it;
    launchd is accepted only once the backend is really gone.
    """
    if pid <= 1 or not _leads_own_group(pid):
        return False
    parent = _parent_of(pid)
    return parent == backend_pid or (parent == 1 and not _alive(backend_pid))


async def _reap(pids: set[int], backend_pid: int) -> None:
    from services.agent_process import _freeze_and_kill_posix_tree

    for pid in sorted(pids):
        # Re-check: still a group leader, and its parent is the (dead)
        # backend's or launchd, which adopts orphans.
        if not _leads_own_group(pid) or _parent_of(pid) not in (backend_pid, 1):
            continue
        try:
            await _freeze_and_kill_posix_tree(pid)
        except Exception:
            pass
        try:
            os.killpg(pid, signal.SIGKILL)
        except OSError:
            pass


def guardian_main(argv: list[str]) -> int:
    backend_pid = int(argv[1])
    accepted: set[int] = set()
    for raw in sys.stdin.buffer:
        line = raw.strip()
        if len(line) < 2 or line[:1] not in (b"+", b"-"):
            continue
        try:
            pid = int(line[1:])
        except ValueError:
            continue
        if line[:1] == b"+":
            if _accept(pid, backend_pid):
                accepted.add(pid)
        else:
            accepted.discard(pid)
    # EOF: the backend is gone. Whatever is still registered outlived it.
    if accepted:
        asyncio.run(_reap(accepted, backend_pid))
    return 0


if __name__ == "__main__":
    # -I leaves the script's directory off sys.path; services.* lives one up.
    sys.path.insert(0, str(_BACKEND_DIR))
    raise SystemExit(guardian_main(sys.argv))
