from __future__ import annotations

import asyncio
import os
from pathlib import Path
import sys
from types import SimpleNamespace
from unittest.mock import AsyncMock, patch

import pytest

from services.agent_process import (
    agent_process_group_options,
    terminate_agent_process_tree,
)


def test_agent_process_group_options_isolate_posix_turns() -> None:
    if os.name == "posix":
        assert agent_process_group_options() == {"start_new_session": True}


@pytest.mark.asyncio
async def test_terminate_agent_process_tree_kills_descendant_sentinel(tmp_path: Path) -> None:
    """A grandchild must not outlive Stop and write its delayed sentinel."""
    sentinel = tmp_path / "descendant-survived.txt"
    child_code = (
        "import pathlib,time; "
        "time.sleep(0.8); "
        f"pathlib.Path({str(sentinel)!r}).write_text('survived')"
    )
    parent_code = (
        "import subprocess,sys,time; "
        f"subprocess.Popen([sys.executable, '-c', {child_code!r}]); "
        "print('ready', flush=True); "
        "time.sleep(30)"
    )
    proc = await asyncio.create_subprocess_exec(
        sys.executable,
        "-c",
        parent_code,
        stdout=asyncio.subprocess.PIPE,
        stderr=asyncio.subprocess.PIPE,
        **agent_process_group_options(),
    )
    assert proc.stdout is not None
    assert await asyncio.wait_for(proc.stdout.readline(), timeout=2) == b"ready\n"

    await terminate_agent_process_tree(proc)
    await asyncio.sleep(1.0)

    assert proc.returncode is not None
    assert not sentinel.exists(), "agent descendant survived process-group cancellation"


@pytest.mark.asyncio
@pytest.mark.skipif(os.name != "posix", reason="setsid regression is POSIX-specific")
async def test_terminate_agent_process_tree_kills_setsid_grandchild(tmp_path: Path) -> None:
    """A grandchild in its own session cannot escape verified tree cleanup."""
    sentinel = tmp_path / "detached-descendant-survived.txt"
    ready = tmp_path / "detached-descendant.pid"
    grandchild_code = (
        "import os,pathlib,time; "
        "os.setsid(); "
        f"pathlib.Path({str(ready)!r}).write_text(str(os.getpid())); "
        "time.sleep(0.8); "
        f"pathlib.Path({str(sentinel)!r}).write_text('survived')"
    )
    child_code = (
        "import subprocess,sys,time; "
        f"subprocess.Popen([sys.executable, '-c', {grandchild_code!r}]); "
        "time.sleep(30)"
    )
    parent_code = (
        "import subprocess,sys,time; "
        f"subprocess.Popen([sys.executable, '-c', {child_code!r}]); "
        "time.sleep(30)"
    )
    proc = await asyncio.create_subprocess_exec(
        sys.executable,
        "-c",
        parent_code,
        stdout=asyncio.subprocess.PIPE,
        stderr=asyncio.subprocess.PIPE,
        **agent_process_group_options(),
    )

    for _ in range(100):
        if ready.exists():
            break
        await asyncio.sleep(0.02)
    assert ready.exists(), "detached grandchild did not reach its new session"
    detached_pid = int(ready.read_text())

    await terminate_agent_process_tree(proc)
    await asyncio.sleep(1.0)

    assert proc.returncode is not None
    assert not sentinel.exists(), "setsid grandchild survived cancellation"
    with pytest.raises(ProcessLookupError):
        os.kill(detached_pid, 0)


@pytest.mark.asyncio
@pytest.mark.skipif(os.name != "posix", reason="POSIX verification contract")
async def test_posix_verification_failure_is_not_reported_as_cancelled() -> None:
    proc = SimpleNamespace(pid=424242, returncode=None, wait=AsyncMock(return_value=-9))

    with patch(
        "services.agent_process._freeze_and_kill_posix_tree",
        new=AsyncMock(return_value={424242, 424243}),
    ), patch(
        "services.agent_process._verify_posix_processes_gone",
        new=AsyncMock(side_effect=RuntimeError("424243 survived")),
    ), patch("services.agent_process.os.killpg"):
        with pytest.raises(RuntimeError, match="survived"):
            await terminate_agent_process_tree(proc)
