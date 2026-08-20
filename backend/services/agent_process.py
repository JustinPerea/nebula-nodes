"""Process-lifecycle helpers for interactive agent CLI turns.

Agent CLIs can spawn shells and other descendants while operating Nebula's
graph.  Killing only the direct ``claude``/``codex``/``hermes`` process leaves
those descendants running after the user presses Stop.  Every interactive
turn therefore starts in an isolated process group and cancellation terminates
the whole tree before the WebSocket confirms it to the client.
"""
from __future__ import annotations

import asyncio
import os
import signal
import subprocess
from typing import Any


_POSIX_DISCOVERY_ROUNDS = 20
_POSIX_STABLE_ROUNDS = 2
_POSIX_VERIFY_TIMEOUT_SECONDS = 3.0
_POSIX_VERIFY_INTERVAL_SECONDS = 0.05


def agent_process_group_options() -> dict[str, Any]:
    """Keyword arguments that isolate one agent turn and all descendants."""
    if os.name == "posix":
        return {"start_new_session": True}
    if os.name == "nt":
        return {"creationflags": subprocess.CREATE_NEW_PROCESS_GROUP}
    return {}


async def terminate_agent_process_tree(proc: Any) -> None:
    """Kill an agent subprocess and every process it spawned, then reap it.

    Fake subprocesses in unit tests (and unusual event-loop implementations)
    may not expose a numeric ``pid``.  In that case, retain the direct-child
    fallback instead of making cleanup itself fail.
    """
    if proc.returncode is not None:
        return

    pid = getattr(proc, "pid", None)
    has_pid = isinstance(pid, int) and not isinstance(pid, bool) and pid > 0

    if os.name == "posix" and has_pid:
        try:
            discovered = await _freeze_and_kill_posix_tree(pid)
            await proc.wait()
            await _verify_posix_processes_gone(discovered)
            return
        except Exception:
            # Keep the original process-group kill as a best-effort fallback,
            # but propagate the discovery/verification failure. The WebSocket
            # must report cancellation failed rather than falsely confirming.
            try:
                os.killpg(pid, signal.SIGKILL)
            except ProcessLookupError:
                pass
            try:
                await proc.wait()
            except ProcessLookupError:
                pass
            raise
    elif os.name == "nt" and has_pid:
        try:
            tree_killer = await asyncio.create_subprocess_exec(
                "taskkill",
                "/PID",
                str(pid),
                "/T",
                "/F",
                stdout=asyncio.subprocess.DEVNULL,
                stderr=asyncio.subprocess.DEVNULL,
            )
            await tree_killer.wait()
        except (FileNotFoundError, ProcessLookupError):
            proc.kill()
    else:
        try:
            proc.kill()
        except ProcessLookupError:
            pass

    try:
        await proc.wait()
    except ProcessLookupError:
        pass


async def _read_posix_process_table() -> dict[int, tuple[int, str]]:
    """Return ``pid -> (ppid, stat)`` from the platform's canonical ps."""
    snapshot = await asyncio.create_subprocess_exec(
        "ps",
        "-axo",
        "pid=,ppid=,stat=",
        stdout=asyncio.subprocess.PIPE,
        stderr=asyncio.subprocess.PIPE,
    )
    stdout, stderr = await snapshot.communicate()
    if snapshot.returncode != 0:
        detail = stderr.decode("utf-8", errors="replace").strip()
        raise RuntimeError(f"Could not inspect agent descendants: {detail or 'ps failed'}")

    table: dict[int, tuple[int, str]] = {}
    for raw_line in stdout.decode("utf-8", errors="replace").splitlines():
        fields = raw_line.split(None, 2)
        if len(fields) < 2:
            continue
        try:
            process_id = int(fields[0])
            parent_id = int(fields[1])
        except ValueError:
            continue
        table[process_id] = (parent_id, fields[2] if len(fields) > 2 else "")
    return table


def _descendant_closure(
    roots: set[int],
    table: dict[int, tuple[int, str]],
) -> set[int]:
    """Find descendants by PPID, independent of process group or session."""
    children: dict[int, set[int]] = {}
    for process_id, (parent_id, _stat) in table.items():
        children.setdefault(parent_id, set()).add(process_id)

    found = set(roots)
    pending = list(roots)
    while pending:
        parent_id = pending.pop()
        for child_id in children.get(parent_id, ()):
            if child_id in found:
                continue
            found.add(child_id)
            pending.append(child_id)
    return found


def _signal_processes(process_ids: set[int], sig: signal.Signals) -> None:
    failures: list[str] = []
    for process_id in process_ids:
        try:
            os.kill(process_id, sig)
        except ProcessLookupError:
            continue
        except PermissionError as exc:
            failures.append(f"{process_id}: {exc}")
    if failures:
        raise RuntimeError(
            f"Could not signal agent descendant(s): {', '.join(failures)}"
        )


async def _freeze_and_kill_posix_tree(root_pid: int) -> set[int]:
    """Freeze a stable descendant closure, then kill every captured PID.

    Descendants are discovered through PPID links, not PGID, because agent
    tools commonly start a new process group (and may call ``setsid``). The
    root is stopped first; each newly discovered generation is stopped before
    another snapshot, closing the spawn race before any parent is killed and
    reparented to PID 1.
    """
    discovered = {root_pid}
    try:
        # Freeze the root before the first snapshot so it cannot add another
        # direct child while the existing descendant closure is discovered.
        _signal_processes({root_pid}, signal.SIGSTOP)
        initial_table = await _read_posix_process_table()
        discovered = _descendant_closure(discovered, initial_table)
        _signal_processes(discovered - {root_pid}, signal.SIGSTOP)

        stable_rounds = 0
        for _ in range(_POSIX_DISCOVERY_ROUNDS):
            table = await _read_posix_process_table()
            expanded = _descendant_closure(discovered, table)
            new_processes = expanded - discovered
            if new_processes:
                # Retain the PIDs before signaling so exceptional cleanup can
                # still kill every process the snapshot exposed.
                discovered.update(new_processes)
                _signal_processes(new_processes, signal.SIGSTOP)
                stable_rounds = 0
                continue
            stable_rounds += 1
            if stable_rounds >= _POSIX_STABLE_ROUNDS:
                break
        else:
            raise RuntimeError("Agent descendant tree did not stabilize for cancellation")

        # All captured processes are frozen, so none can fork or move into
        # another session while the individual-PID kill is applied.
        _signal_processes(discovered, signal.SIGKILL)
    except BaseException:
        # Never leave a partially discovered tree frozen if inspection fails
        # or cleanup itself receives another cancellation.
        try:
            _signal_processes(discovered, signal.SIGKILL)
        except Exception:
            pass
        raise
    return discovered


async def _verify_posix_processes_gone(process_ids: set[int]) -> None:
    deadline = asyncio.get_running_loop().time() + _POSIX_VERIFY_TIMEOUT_SECONDS
    while True:
        table = await _read_posix_process_table()
        survivors = sorted(process_ids.intersection(table))
        if not survivors:
            return
        if asyncio.get_running_loop().time() >= deadline:
            details = ", ".join(
                f"{process_id}({table[process_id][1] or '?'})"
                for process_id in survivors
            )
            raise RuntimeError(
                f"Agent cancellation could not verify descendant exit: {details}"
            )
        await asyncio.sleep(_POSIX_VERIFY_INTERVAL_SECONDS)
