from __future__ import annotations

import asyncio

import pytest

from services.cancellation import schedule_detached_cancel


@pytest.mark.asyncio
async def test_schedule_detached_cancel_runs_the_coroutine() -> None:
    """The scheduled coroutine runs on the loop (detached from the caller)."""
    ran = asyncio.Event()

    async def _coro() -> None:
        ran.set()

    schedule_detached_cancel(_coro)

    # The task is detached — let the loop run so it gets a chance to execute.
    await asyncio.sleep(0)
    await asyncio.sleep(0)

    assert ran.is_set()


def test_schedule_detached_cancel_no_running_loop_is_noop() -> None:
    """With no running event loop, scheduling is a silent no-op (does not raise)."""
    called = False

    async def _coro() -> None:
        nonlocal called
        called = True

    # Called outside any running loop — must not raise and must not run the coro.
    schedule_detached_cancel(_coro)
    assert called is False
