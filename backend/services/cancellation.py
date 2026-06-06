from __future__ import annotations

import asyncio
from typing import Any, Awaitable, Callable

# Detached best-effort provider-cancellation tasks, kept referenced so the event loop
# does not garbage-collect them before they finish.
_pending_cancel_tasks: set[asyncio.Task[Any]] = set()


def schedule_detached_cancel(make_coro: Callable[[], Awaitable[None]]) -> None:
    """Run a best-effort provider-cancellation coroutine on a DETACHED task so it survives
    the cancellation of the calling node's task. No-op if no running loop.

    The detached task must open its own HTTP client: the poller's client is being torn
    down by the same cancellation that triggered this call.
    """
    try:
        loop = asyncio.get_running_loop()
    except RuntimeError:
        return
    task = loop.create_task(make_coro())
    _pending_cancel_tasks.add(task)
    task.add_done_callback(_pending_cancel_tasks.discard)
