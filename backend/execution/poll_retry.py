"""Polling a maker's long-running task without abandoning it on one bad answer.

A video task keeps running, and billing, on the maker's side while Nebula polls
it. One 502 or a dropped connection on a poll used to fail the run and leave the
task running with nobody waiting for it. Every async video poller (the shared
async_poll_runner used by Runway and Replicate, BytePlus Seedance, MiniMax H3,
xAI video, Veo on the Gemini API and on Vertex, Gemini Omni) uses the two pieces
here:

- :func:`poll_request` retries a transient poll error: a transport error
  (connect, read or write failure, timeout, protocol error) or an HTTP 5xx. The
  waits are POLL_RETRY_DELAYS, about 30 s in all, so a short outage doesn't
  cost the run and a long one still fails in bounded time. A 4xx is never
  retried: it is the maker's answer (bad key, unknown task, rate limit), and the
  same request gets the same answer.
- :class:`UpstreamTask` cancels the task upstream (best effort, on a detached
  task) when polling ends without the task reaching a terminal state: the run
  was cancelled, a poll error survived the retries, the maker answered 4xx, or
  Nebula stopped waiting. A task that succeeded or failed on its own isn't
  cancelled. Makers without a cancel endpoint (xAI) pass ``cancel=None``.
"""
from __future__ import annotations

import asyncio
from typing import Any, Awaitable, Callable, TypeVar

import httpx

T = TypeVar("T")

# Waits between attempts of one poll (seconds). Four retries, 30 s in all.
POLL_RETRY_DELAYS: tuple[float, ...] = (2.0, 4.0, 8.0, 16.0)


def _status_of(value: Any) -> int | None:
    """The HTTP status of a response, an httpx.HTTPStatusError, or an error
    that carries ``status`` (BytePlusError)."""
    if isinstance(value, httpx.HTTPStatusError):
        return value.response.status_code
    for name in ("status_code", "status"):
        status = getattr(value, name, None)
        if isinstance(status, int) and not isinstance(status, bool):
            return status
    return None


def is_transient(value: Any) -> bool:
    """True for a poll failure worth retrying: a transport error or an HTTP 5xx."""
    if isinstance(value, httpx.TransportError):
        return True
    status = _status_of(value)
    return status is not None and status >= 500


async def poll_request(send: Callable[[], Awaitable[T]], *, delays: tuple[float, ...] | None = None) -> T:
    """Run one poll, retrying a transient failure (see the module docstring).

    ``send`` is called again for each attempt. A 5xx response that is still a
    5xx after the last retry is returned, so the caller's own error message (the
    status and body) reports it; a transport error after the last retry is
    raised. Cancellation is never swallowed: CancelledError isn't an Exception."""
    waits = POLL_RETRY_DELAYS if delays is None else delays
    for attempt in range(len(waits) + 1):
        last = attempt == len(waits)
        try:
            result = await send()
        except Exception as exc:
            if last or not is_transient(exc):
                raise
        else:
            if last or not is_transient(result):
                return result
        await asyncio.sleep(waits[attempt])
    raise AssertionError("unreachable")  # pragma: no cover


class UpstreamTask:
    """``with UpstreamTask(cancel, schedule) as task:`` around a poll loop.

    Set ``task.finished = True`` once the maker reports a terminal state. If
    the block exits with any exception (including CancelledError) before that,
    ``schedule(cancel)`` runs, normally services.cancellation's
    schedule_detached_cancel. ``schedule`` is passed in by the caller so each
    handler's own module-level name is the one used (tests patch it there)."""

    def __init__(self, cancel: Callable[[], Awaitable[None]] | None,
                 schedule: Callable[[Callable[[], Awaitable[None]]], None]):
        self._cancel = cancel
        self._schedule = schedule
        self.finished = False

    def __enter__(self) -> "UpstreamTask":
        return self

    def __exit__(self, exc_type: Any, exc: Any, tb: Any) -> bool:
        if exc_type is not None and not self.finished and self._cancel is not None:
            self._schedule(self._cancel)
        return False
