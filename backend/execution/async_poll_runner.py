from __future__ import annotations

import asyncio
from dataclasses import dataclass
from typing import Any, Awaitable, Callable

import httpx

from models.events import ExecutionEvent, ProgressEvent
from services.cancellation import schedule_detached_cancel


async def _cancel_async_poll(cancel_url: str, method: str, headers: dict[str, str]) -> None:
    """Best-effort: stop a running provider job upstream on cancellation. Method/URL vary by
    provider — Runway is ``DELETE`` on the task URL (= the poll URL); Replicate is
    ``POST .../cancel``. Swallow all errors — fire-and-forget on a detached task whose own
    client must be opened fresh (the poller's client is being torn down)."""
    try:
        async with httpx.AsyncClient(timeout=10.0) as client:
            await client.request(method, cancel_url, headers=headers)
    except Exception:
        pass


@dataclass
class AsyncPollConfig:
    submit_url: str
    poll_url_template: str
    headers: dict[str, str]
    terminal_success: set[str]
    terminal_failure: set[str]
    status_path: str = "status"
    task_id_path: str = "id"
    poll_interval: float = 2.0
    max_polls: int = 300
    timeout: float = 30.0
    # Cancellation (best-effort, fired on CancelledError). Default: DELETE the poll URL
    # (correct for Runway, whose cancel is DELETE /v1/tasks/{id} = the poll URL). Providers
    # whose cancel differs (e.g. Replicate's POST .../cancel) set these.
    cancel_url_template: str | None = None
    cancel_method: str = "DELETE"


def _get_nested(data: dict[str, Any], path: str) -> Any:
    current: Any = data
    for key in path.split("."):
        if isinstance(current, dict):
            current = current[key]
        elif isinstance(current, list):
            try:
                current = current[int(key)]
            except (ValueError, IndexError):
                raise KeyError(f"Cannot index list at '{key}' in path '{path}'")
        else:
            raise KeyError(f"Cannot traverse path '{path}' — hit non-dict at '{key}'")
    return current


async def async_poll_execute(
    config: AsyncPollConfig,
    submit_body: dict[str, Any],
    node_id: str,
    emit: Callable[[ExecutionEvent], Awaitable[None]],
) -> dict[str, Any]:
    async with httpx.AsyncClient(timeout=config.timeout) as client:
        submit_resp = await client.post(config.submit_url, headers=config.headers, json=submit_body)
        if submit_resp.status_code not in (200, 201):
            raise RuntimeError(f"Async submit failed ({submit_resp.status_code}): {submit_resp.text}")

        submit_data = submit_resp.json()
        task_id = str(_get_nested(submit_data, config.task_id_path))
        return await poll_until_terminal(client, config, task_id, node_id, emit)


async def poll_until_terminal(
    client: httpx.AsyncClient,
    config: AsyncPollConfig,
    task_id: str,
    node_id: str,
    emit: Callable[[ExecutionEvent], Awaitable[None]],
) -> dict[str, Any]:
    """Poll an already-submitted task to a terminal state on the caller's client.

    Split out of async_poll_execute so a handler that must inspect the submit
    response first (e.g. Replicate checking ``urls.stream``) can submit itself and
    still reuse the shared poll/cancel loop for the non-streaming path.
    """
    poll_url = config.poll_url_template.format(task_id=task_id)
    cancel_url = config.cancel_url_template.format(task_id=task_id) if config.cancel_url_template else poll_url

    for poll_num in range(1, config.max_polls + 1):
        try:
            await asyncio.sleep(config.poll_interval)
            poll_resp = await client.get(poll_url, headers=config.headers)
        except asyncio.CancelledError:
            # User/engine cancelled — stop the provider job upstream, then re-raise.
            schedule_detached_cancel(lambda: _cancel_async_poll(cancel_url, config.cancel_method, config.headers))
            raise
        if poll_resp.status_code != 200:
            raise RuntimeError(f"Poll request failed ({poll_resp.status_code}): {poll_resp.text}")

        poll_data = poll_resp.json()
        status = str(_get_nested(poll_data, config.status_path))

        progress = min(poll_num / config.max_polls, 0.99)
        await emit(ProgressEvent(node_id=node_id, value=progress))

        if status in config.terminal_success:
            return poll_data

        if status in config.terminal_failure:
            error_msg = poll_data.get("error", poll_data.get("failure", f"Job failed with status: {status}"))
            raise RuntimeError(f"Async job failed: {error_msg}")

    raise RuntimeError(f"Async job timed out after {config.max_polls} polls ({config.max_polls * config.poll_interval:.0f}s)")
