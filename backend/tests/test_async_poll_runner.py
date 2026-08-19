from __future__ import annotations

import asyncio
from unittest.mock import AsyncMock, MagicMock, patch

import pytest

from execution.async_poll_runner import AsyncPollConfig, async_poll_execute


def _runway_config() -> AsyncPollConfig:
    """Runway: cancel = DELETE the task URL (which is the poll URL). Uses the defaults."""
    return AsyncPollConfig(
        submit_url="https://api.dev.runwayml.com/v1/image_to_video",
        poll_url_template="https://api.dev.runwayml.com/v1/tasks/{task_id}",
        headers={"Authorization": "Bearer runway-key"},
        terminal_success={"SUCCEEDED"},
        terminal_failure={"FAILED"},
    )


def _replicate_config() -> AsyncPollConfig:
    """Replicate: cancel = POST .../predictions/{id}/cancel (NOT a DELETE on the poll URL)."""
    return AsyncPollConfig(
        submit_url="https://api.replicate.com/v1/predictions",
        poll_url_template="https://api.replicate.com/v1/predictions/{task_id}",
        headers={"Authorization": "Bearer rep-key"},
        terminal_success={"succeeded"},
        terminal_failure={"failed"},
        cancel_url_template="https://api.replicate.com/v1/predictions/{task_id}/cancel",
        cancel_method="POST",
    )


async def _cancel_call_args(config: AsyncPollConfig):
    """Submit returns a task id, then the first poll is cancelled; capture the args the
    runner would use to cancel the provider job."""
    submit = MagicMock()
    submit.status_code = 200
    submit.json.return_value = {"id": "task-abc"}

    def fake_sched(make_coro):
        make_coro()  # invoke the lambda -> calls the (patched) _cancel_async_poll

    with patch("execution.async_poll_runner.httpx.AsyncClient") as MockClient, \
         patch("execution.async_poll_runner._cancel_async_poll", new_callable=MagicMock) as mock_cancel, \
         patch("execution.async_poll_runner.schedule_detached_cancel", side_effect=fake_sched), \
         patch("execution.async_poll_runner.asyncio.sleep", new=AsyncMock(side_effect=asyncio.CancelledError())):
        mc = AsyncMock()
        mc.post.return_value = submit
        mc.__aenter__ = AsyncMock(return_value=mc)
        mc.__aexit__ = AsyncMock(return_value=False)
        MockClient.return_value = mc

        with pytest.raises(asyncio.CancelledError):
            await async_poll_execute(config, {"x": 1}, "node-1", AsyncMock())

    mock_cancel.assert_called_once()
    return mock_cancel.call_args.args


@pytest.mark.asyncio
async def test_runway_cancel_deletes_task_url() -> None:
    args = await _cancel_call_args(_runway_config())
    assert args == (
        "https://api.dev.runwayml.com/v1/tasks/task-abc",
        "DELETE",
        {"Authorization": "Bearer runway-key"},
    )


@pytest.mark.asyncio
async def test_replicate_cancel_posts_cancel_url() -> None:
    args = await _cancel_call_args(_replicate_config())
    assert args == (
        "https://api.replicate.com/v1/predictions/task-abc/cancel",
        "POST",
        {"Authorization": "Bearer rep-key"},
    )
