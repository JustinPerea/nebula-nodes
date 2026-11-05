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


def _descendant_code(pid_file: Path, go: Path, sentinel: Path, *, setsid: bool = False) -> str:
    """A descendant that records its PID, then writes the sentinel as soon as
    `go` exists. Gating on a file, not a timer (it used to sleep 0.8 s), keeps
    these tests independent of how fast the machine is (CI flake of
    2026-11-02: a slow `ps` let the timer fire before Stop froze it)."""
    return (
        "import os,pathlib,time; "
        + ("os.setsid(); " if setsid else "")
        + f"pathlib.Path({str(pid_file)!r}).write_text(str(os.getpid())); "
        + f"go=pathlib.Path({str(go)!r}); "
        + "exec('while not go.exists(): time.sleep(0.01)'); "
        + f"pathlib.Path({str(sentinel)!r}).write_text('survived')"
    )


async def _start_tree(*codes: str) -> asyncio.subprocess.Process:
    """An agent root whose chain of descendants runs `codes`, outermost first."""
    code = codes[-1]
    for outer in reversed(codes[:-1]):
        code = outer + f"subprocess.Popen([sys.executable, '-c', {code!r}]); time.sleep(30)"
    return await asyncio.create_subprocess_exec(
        sys.executable, "-c", code,
        stdout=asyncio.subprocess.PIPE, stderr=asyncio.subprocess.PIPE,
        **agent_process_group_options(),
    )


async def _pid_from(pid_file: Path) -> int:
    """Wait for the descendant to start: a state (its PID file), not a sleep."""
    async def written() -> int:
        while not pid_file.exists() or not pid_file.read_text():
            await asyncio.sleep(0.01)
        return int(pid_file.read_text())
    return await asyncio.wait_for(written(), timeout=30)


async def _gone(process_id: int) -> bool:
    from services.agent_process import _read_posix_process_table

    table = await _read_posix_process_table()
    return process_id not in table or table[process_id][1].startswith("Z")


_LAUNCH = "import subprocess,sys,time; "


@pytest.mark.asyncio
@pytest.mark.skipif(os.name != "posix", reason="POSIX process-tree contract")
async def test_terminate_agent_process_tree_kills_descendant_sentinel(tmp_path: Path) -> None:
    """A grandchild must not outlive Stop and write its sentinel."""
    pid_file, go, sentinel = tmp_path / "descendant.pid", tmp_path / "go", tmp_path / "descendant-survived.txt"
    proc = await _start_tree(_LAUNCH, _descendant_code(pid_file, go, sentinel))
    descendant = await _pid_from(pid_file)

    await terminate_agent_process_tree(proc)
    go.touch()

    assert proc.returncode is not None
    assert await _gone(descendant), "agent descendant survived process-group cancellation"
    assert not sentinel.exists(), "agent descendant survived process-group cancellation"


@pytest.mark.asyncio
@pytest.mark.skipif(os.name != "posix", reason="POSIX process-tree contract")
async def test_stop_freezes_the_agent_group_before_the_first_slow_snapshot(tmp_path: Path, monkeypatch) -> None:
    """The agent's whole group is frozen in one signal before any `ps`
    snapshot, so a descendant cannot finish its work while a slow snapshot
    (a loaded machine) runs. The descendant is released right as Stop begins
    and given half a second; it must still never write."""
    import services.agent_process as agent_process

    pid_file, go, sentinel = tmp_path / "descendant.pid", tmp_path / "go", tmp_path / "descendant-survived.txt"
    proc = await _start_tree(_LAUNCH, _descendant_code(pid_file, go, sentinel))
    descendant = await _pid_from(pid_file)
    real = agent_process._read_posix_process_table
    calls: list[int] = []

    async def slow_first_snapshot():
        calls.append(1)
        if len(calls) == 1:
            go.touch()
            await asyncio.sleep(0.5)
        return await real()

    monkeypatch.setattr(agent_process, "_read_posix_process_table", slow_first_snapshot)
    await terminate_agent_process_tree(proc)

    assert await _gone(descendant)
    assert not sentinel.exists(), "a descendant ran while the first snapshot was slow"


@pytest.mark.asyncio
@pytest.mark.skipif(os.name != "posix", reason="setsid regression is POSIX-specific")
async def test_terminate_agent_process_tree_kills_setsid_grandchild(tmp_path: Path) -> None:
    """A grandchild in its own session cannot escape verified tree cleanup."""
    pid_file, go = tmp_path / "detached-descendant.pid", tmp_path / "go"
    sentinel = tmp_path / "detached-descendant-survived.txt"
    proc = await _start_tree(_LAUNCH, _LAUNCH, _descendant_code(pid_file, go, sentinel, setsid=True))
    detached_pid = await _pid_from(pid_file)

    await terminate_agent_process_tree(proc)
    go.touch()

    assert proc.returncode is not None
    assert await _gone(detached_pid), "setsid grandchild survived cancellation"
    assert not sentinel.exists(), "setsid grandchild survived cancellation"


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
