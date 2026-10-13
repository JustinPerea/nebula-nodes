"""The agent guardian kills agent trees that outlive a killed backend.

Agent CLIs run in their own session, so when the backend is SIGKILLed (the
desktop app's escalation after its 5 s grace, parent_watch's os._exit, a
crash) nothing in the backend can stop them. These tests run a small stand-in
backend in a subprocess that starts a fake agent through
``spawn_agent_process``, then SIGKILL it, and check what survives.
"""
from __future__ import annotations

import json
import os
import re
import signal
import subprocess
import sys
import time
from pathlib import Path

import pytest

BACKEND_DIR = Path(__file__).resolve().parent.parent

pytestmark = pytest.mark.skipif(os.name != "posix", reason="POSIX process groups")

# A fake agent CLI: starts a descendant in a session of its own (as agent
# tools do), reports its pid, then idles like a model turn would.
FAKE_AGENT = """
import subprocess, sys, time
child = subprocess.Popen([sys.executable, "-c", "import time; time.sleep(120)"], start_new_session=True)
print(child.pid, flush=True)
time.sleep(120)
"""

STAND_IN_BACKEND = """
import asyncio, json, sys
sys.path.insert(0, sys.argv[1])
from services import agent_guardian
from services.agent_process import spawn_agent_process

async def main():
    proc = await spawn_agent_process(sys.executable, "-c", sys.argv[2], stdout=asyncio.subprocess.PIPE)
    child = int((await proc.stdout.readline()).decode())
    stranger = int(sys.argv[3]) if len(sys.argv) > 3 else None
    if stranger:
        # A pid the backend did not start must never be killed, even if a
        # registration for it arrives.
        agent_guardian._send(f"+{stranger}\\n")
    print(json.dumps({"agent": proc.pid, "child": child, "guardian": agent_guardian._guardian.pid}), flush=True)
    await asyncio.sleep(120)

asyncio.run(main())
"""


def _alive(pid: int) -> bool:
    try:
        os.kill(pid, 0)
    except ProcessLookupError:
        return False
    except PermissionError:
        return True
    # A zombie still answers kill(0); count it as gone.
    stat = subprocess.run(["ps", "-o", "stat=", "-p", str(pid)], capture_output=True, text=True).stdout.strip()
    return bool(stat) and not stat.startswith("Z")


def _wait_gone(pids: list[int], timeout: float = 10.0) -> list[int]:
    deadline = time.monotonic() + timeout
    while time.monotonic() < deadline:
        left = [pid for pid in pids if _alive(pid)]
        if not left:
            return []
        time.sleep(0.1)
    return [pid for pid in pids if _alive(pid)]


def _kill_all(pids: list[int]) -> None:
    for pid in pids:
        try:
            os.kill(pid, signal.SIGKILL)
        except (ProcessLookupError, PermissionError):
            pass


def _start_backend(*extra: str) -> tuple[subprocess.Popen[str], dict[str, int]]:
    backend = subprocess.Popen(
        [sys.executable, "-c", STAND_IN_BACKEND, str(BACKEND_DIR), FAKE_AGENT, *extra],
        cwd=str(BACKEND_DIR), stdout=subprocess.PIPE, text=True,
    )
    assert backend.stdout is not None
    line = backend.stdout.readline()
    assert line, "stand-in backend printed nothing"
    return backend, json.loads(line)


def test_sigkilled_backend_leaves_no_agent_or_descendant_behind() -> None:
    backend, pids = _start_backend()
    survivors: list[int] = []
    try:
        assert _alive(pids["agent"]) and _alive(pids["child"])
        time.sleep(0.3)  # the guardian has read the registration by now
        backend.kill()
        backend.wait(10)
        survivors = _wait_gone([pids["agent"], pids["child"], pids["guardian"]])
        assert survivors == [], f"still running after the backend was killed: {survivors}"
    finally:
        if backend.poll() is None:
            backend.kill()
        _kill_all([pids["agent"], pids["child"], pids["guardian"]])


def test_registration_racing_the_backend_kill_is_still_reaped() -> None:
    # SIGKILL right after the spawn: the guardian may read "+pid" only after
    # the agent was reparented to launchd.
    backend, pids = _start_backend()
    try:
        backend.kill()
        backend.wait(10)
        assert _wait_gone([pids["agent"], pids["child"], pids["guardian"]]) == []
    finally:
        _kill_all([pids["agent"], pids["child"], pids["guardian"]])


def test_guardian_never_kills_a_process_the_backend_did_not_start() -> None:
    stranger = subprocess.Popen([sys.executable, "-c", "import time; time.sleep(120)"], start_new_session=True)
    backend, pids = _start_backend(str(stranger.pid))
    try:
        time.sleep(0.3)
        backend.kill()
        backend.wait(10)
        assert _wait_gone([pids["agent"], pids["guardian"]]) == []
        assert stranger.poll() is None, "the guardian killed a process the backend never started"
    finally:
        stranger.kill()
        stranger.wait()
        _kill_all([pids["agent"], pids["child"], pids["guardian"]])


def test_every_agent_spawn_goes_through_spawn_agent_process() -> None:
    # agent_process_group_options() without the guardian would bring the
    # orphan problem back for that call site.
    offenders = []
    for path in [*BACKEND_DIR.glob("services/*.py"), *BACKEND_DIR.glob("commons/*.py"), BACKEND_DIR / "main.py"]:
        if path.name in ("agent_process.py", "agent_guardian.py"):
            continue
        if re.search(r"agent_process_group_options\(\)|start_new_session=True", path.read_text()):
            offenders.append(path.name)
    assert offenders == [], f"spawn agents with spawn_agent_process instead: {offenders}"
