"""The Black Forest Labs client (handlers/bfl.py): submit, poll, download.

Only the transport is mocked (httpx.MockTransport): no provider is contacted
and nothing is billed. Covers the x-key header going only to https *.bfl.ai
hosts (never to a polling URL elsewhere, never to the delivery URL), reading a
task's status from the body even on a 503 or 404, moderation and failure
messages, 402 and a bounded 429 retry on submit, saving the result as soon as
the task is Ready, and the settled cost.
"""
from __future__ import annotations

import base64
import json
from pathlib import Path
from typing import Any, Callable
from unittest.mock import AsyncMock

import httpx
import pytest

from execution import poll_retry
from execution.missing_credential import MissingCredentialError
from handlers import bfl
from models.events import ProgressEvent

KEY = "fixture-bfl-key"
SUBMIT_URL = "https://api.bfl.ai/v1/flux-3-image"
POLL_URL = "https://api.eu.bfl.ai/v1/get_result?id=task-1"
SAMPLE_URL = "https://delivery-eu1.bfl.ai/results/abc/sample.png?se=2026-10-15&sig=fixture"
VIDEO_SAMPLE_URL = "https://delivery-us1.bfl.ai/results/abc/sample.mp4?sig=fixture"
PNG = base64.b64decode(
    "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8/5+hHgAHggJ/PchI7wAAAABJRU5ErkJggg=="
)
MP4 = b"\x00\x00\x00\x18ftypmp42\x00\x00\x00\x00mp42isom" + b"\x00" * 64
BODY = {"prompt": "a lighthouse at dusk", "resolution": "1k"}
_REAL_CLIENT = httpx.AsyncClient

Answer = httpx.Response | Callable[[httpx.Request], httpx.Response]


def task(status: str, **extra: Any) -> dict[str, Any]:
    return {"id": "task-1", "status": status, "result": None, "progress": None, "details": None,
            "preview": None, **extra}


def ready(sample: str = SAMPLE_URL, cost: float | None = 4.8) -> dict[str, Any]:
    body = task("Ready", result={"sample": sample, "prompt": "expanded", "duration": 3.1})
    if cost is not None:
        body["cost"] = cost
    return body


class FakeBFL:
    """A fake BFL API: each POST answers the next of ``submits``, each poll the
    next of ``polls`` (the last one repeats), the sample URLs serve bytes."""

    def __init__(self, monkeypatch: pytest.MonkeyPatch, polls: list[Answer] | None = None,
                 submits: list[Answer] | None = None):
        self.requests: list[httpx.Request] = []
        self.polls = list(polls) if polls is not None else [
            httpx.Response(200, json=task("Pending")), httpx.Response(200, json=task("Generating")),
            httpx.Response(200, json=ready())]
        self.submits = list(submits) if submits is not None else [httpx.Response(200, json={
            "id": "task-1", "polling_url": POLL_URL, "cost": 4.8, "input_mp": 0, "output_mp": 1.05})]

        def factory(*args: Any, **kwargs: Any) -> httpx.AsyncClient:
            return _REAL_CLIENT(*args, transport=httpx.MockTransport(self._answer), **kwargs)

        monkeypatch.setattr(bfl.httpx, "AsyncClient", factory)
        monkeypatch.setattr(poll_retry, "POLL_RETRY_DELAYS", (0.0, 0.0))
        # The fixture bytes aren't a playable video; output validation probes with ffprobe.
        monkeypatch.setattr("services.output.ffprobe_video", AsyncMock(return_value={}))

    @staticmethod
    def _next(queue: list[Answer], request: httpx.Request) -> httpx.Response:
        answer = queue.pop(0) if len(queue) > 1 else queue[0]
        return answer(request) if callable(answer) else answer

    def _answer(self, request: httpx.Request) -> httpx.Response:
        self.requests.append(request)
        url = str(request.url)
        if url == SAMPLE_URL:
            return httpx.Response(200, content=PNG, headers={"content-type": "image/png"})
        if url == VIDEO_SAMPLE_URL:
            return httpx.Response(200, content=MP4, headers={"content-type": "video/mp4"})
        if request.method == "POST":
            return self._next(self.submits, request)
        if url == POLL_URL:
            return self._next(self.polls, request)
        raise AssertionError(f"unexpected request to {url}")

    def urls(self, method: str | None = None) -> list[str]:
        return [str(r.url) for r in self.requests if method is None or r.method == method]


async def _run(**kwargs: Any) -> bfl.BFLResult:
    options = {"media_type": "Image", "poll_interval": 0, "retry_delays": (0.0, 0.0)}
    return await bfl.run_task(KEY, "flux-3-image", BODY, **{**options, **kwargs})


# -- polling host allowlist ---------------------------------------------------

@pytest.mark.parametrize(("url", "allowed"), [
    ("https://api.bfl.ai/v1/get_result?id=1", True),
    ("https://api.eu.bfl.ai/v1/get_result?id=1", True),
    ("https://api.us.bfl.ai/v1/get_result?id=1", True),
    ("https://API.BFL.AI/v1/get_result?id=1", True),
    ("https://api.bfl.ai:443/v1/get_result?id=1", True),
    ("http://api.bfl.ai/v1/get_result?id=1", False),
    ("https://evil.com/v1/get_result?id=1", False),
    ("https://bfl.ai.evil.com/v1/get_result?id=1", False),
    ("https://evilbfl.ai/v1/get_result?id=1", False),
    ("https://api.bfl.ai.evil.com/v1/get_result?id=1", False),
    ("https://api.bfl.ai@evil.com/v1/get_result?id=1", False),
    ("https://user:pass@api.bfl.ai/v1/get_result?id=1", False),
    ("https://api.bfl.ai:8443/v1/get_result?id=1", False),
    ("https://api.bfl.ai:notaport/", False),
    ("ftp://api.bfl.ai/x", False),
    ("/v1/get_result?id=1", False),
    ("", False),
    (None, False),
])
def test_polling_url_allowlist(url, allowed):
    assert bfl.polling_url_allowed(url) is allowed


@pytest.mark.asyncio
@pytest.mark.parametrize("polling_url", [
    "http://api.bfl.ai/v1/get_result?id=task-1",
    "https://evil.com/v1/get_result?id=task-1",
    "https://bfl.ai.evil.com/v1/get_result?id=task-1",
])
async def test_a_polling_url_off_bfl_never_gets_the_key(monkeypatch, polling_url):
    fake = FakeBFL(monkeypatch, submits=[httpx.Response(200, json={"id": "task-1", "polling_url": polling_url})])

    with pytest.raises(RuntimeError, match=r"outside https://\*\.bfl\.ai"):
        await _run()

    assert fake.urls() == [SUBMIT_URL]


@pytest.mark.asyncio
async def test_get_result_refuses_an_off_host_url_without_a_request(monkeypatch):
    fake = FakeBFL(monkeypatch)
    async with httpx.AsyncClient() as client:
        with pytest.raises(RuntimeError, match="didn't send the key"):
            await bfl.get_result(KEY, "https://evil.com/poll", client=client)
    assert fake.requests == []


# -- the happy path -----------------------------------------------------------

@pytest.mark.asyncio
async def test_image_task_submits_polls_and_saves_at_once(monkeypatch):
    fake = FakeBFL(monkeypatch)
    events: list[ProgressEvent] = []

    async def emit(event):
        events.append(event)

    result = await _run(node_id="n1", emit=emit)

    post, *polls, download = fake.requests
    assert str(post.url) == SUBMIT_URL
    assert post.headers["x-key"] == KEY
    assert json.loads(post.content) == BODY
    # The returned polling_url is used as given (here a regional host), with the key.
    assert [str(r.url) for r in polls] == [POLL_URL] * 3
    assert all(r.headers["x-key"] == KEY for r in polls)
    # Downloaded right after the Ready poll, without the key, and nothing after.
    assert str(download.url) == SAMPLE_URL
    assert "x-key" not in download.headers
    saved = Path(result.path)
    assert saved.suffix == ".png" and saved.read_bytes() == PNG
    assert result.media_type == "Image" and result.task_id == "task-1"
    assert result.result["prompt"] == "expanded"
    assert [event.node_id for event in events] == ["n1", "n1"]
    assert all(0 < event.value < 1 for event in events)


@pytest.mark.asyncio
async def test_settled_cost_is_recorded_in_credits_and_usd(monkeypatch):
    FakeBFL(monkeypatch, polls=[httpx.Response(200, json=ready(cost=7))])

    result = await _run()

    assert result.cost_credits == 7.0
    assert result.cost_settled is True
    assert result.cost_usd == pytest.approx(0.07)


@pytest.mark.asyncio
async def test_submit_cost_stands_in_when_the_poll_has_none(monkeypatch):
    FakeBFL(monkeypatch, polls=[httpx.Response(200, json=ready(cost=None))])

    result = await _run()

    assert result.cost_credits == 4.8
    assert result.cost_settled is False
    assert result.cost_usd == pytest.approx(0.048)


@pytest.mark.asyncio
async def test_video_task_saves_an_mp4(monkeypatch):
    fake = FakeBFL(monkeypatch, polls=[httpx.Response(200, json=task("Reasoning")),
                                      httpx.Response(200, json=ready(sample=VIDEO_SAMPLE_URL, cost=120))])

    result = await bfl.run_task(KEY, "flux-3-video", {"prompt": "a wave", "mode": "t2v"}, media_type="Video",
                                poll_interval=0)

    assert fake.urls("POST") == ["https://api.bfl.ai/v1/flux-3-video"]
    assert Path(result.path).suffix == ".mp4"
    assert result.cost_usd == pytest.approx(1.2)


@pytest.mark.asyncio
async def test_unknown_output_type_is_refused_before_any_request(monkeypatch):
    fake = FakeBFL(monkeypatch)
    with pytest.raises(ValueError, match="Audio"):
        await _run(media_type="Audio")
    assert fake.requests == []


def test_a_missing_key_names_the_setting():
    with pytest.raises(MissingCredentialError, match="BFL_API_KEY"):
        bfl.api_key({"BFL_API_KEY": "  "})
    assert bfl.api_key({"BFL_API_KEY": f" {KEY} "}) == KEY


# -- statuses read from the body ----------------------------------------------

@pytest.mark.asyncio
async def test_a_503_with_a_task_body_is_the_answer_not_an_outage(monkeypatch):
    fake = FakeBFL(monkeypatch, polls=[httpx.Response(503, json=task("Error", details={"error": "worker died"}))])

    with pytest.raises(RuntimeError, match="reported an error for this task.*worker died"):
        await _run()

    # Read from the body once, not retried as a transient 5xx.
    assert fake.urls("GET") == [POLL_URL]


@pytest.mark.asyncio
async def test_a_503_without_a_status_is_retried_then_succeeds(monkeypatch):
    fake = FakeBFL(monkeypatch, polls=[httpx.Response(503, text="upstream unavailable"),
                                      httpx.Response(200, json=ready())])

    result = await _run()

    assert fake.urls("GET") == [POLL_URL, POLL_URL, SAMPLE_URL]
    assert Path(result.path).exists()


@pytest.mark.asyncio
async def test_a_503_that_outlasts_the_retries_fails_with_the_status(monkeypatch):
    FakeBFL(monkeypatch, polls=[httpx.Response(503, text="upstream unavailable")])

    with pytest.raises(bfl.BFLError, match="error 503: upstream unavailable"):
        await _run()


@pytest.mark.asyncio
@pytest.mark.parametrize(("status", "said"), [
    ("Request Moderated", "blocked the prompt or an input image before it ran"),
    ("Content Moderated", "blocked the generated result"),
    ("No Card Generated", "returned no result"),
])
async def test_moderation_names_the_reasons(monkeypatch, status, said):
    reasons = {"Moderation Reasons": ["Violence", "Self Harm"]}
    fake = FakeBFL(monkeypatch, polls=[httpx.Response(200, json=task(status, details=reasons))])

    with pytest.raises(RuntimeError) as caught:
        await _run()

    assert said in str(caught.value)
    assert "(Violence, Self Harm)" in str(caught.value)
    assert SAMPLE_URL not in fake.urls()


@pytest.mark.asyncio
async def test_moderation_without_reasons_still_reads_plainly(monkeypatch):
    FakeBFL(monkeypatch, polls=[httpx.Response(200, json=task("Content Moderated"))])

    with pytest.raises(RuntimeError, match=r"blocked the generated result\. Change"):
        await _run()


@pytest.mark.asyncio
async def test_task_not_found_on_a_404_body_is_an_error(monkeypatch):
    FakeBFL(monkeypatch, polls=[httpx.Response(404, json=task("Task not found"))])

    with pytest.raises(RuntimeError, match="Task not found"):
        await _run()


@pytest.mark.asyncio
async def test_a_poll_without_a_status_is_an_error(monkeypatch):
    FakeBFL(monkeypatch, polls=[httpx.Response(403, json={"detail": "Not authenticated"})])

    with pytest.raises(bfl.BFLError, match="check BFL_API_KEY"):
        await _run()


@pytest.mark.asyncio
async def test_a_rate_limited_poll_polls_again(monkeypatch):
    fake = FakeBFL(monkeypatch, polls=[httpx.Response(429, json={"detail": "Too many requests"}),
                                      httpx.Response(200, json=ready())])

    await _run()

    assert fake.urls("GET") == [POLL_URL, POLL_URL, SAMPLE_URL]


@pytest.mark.asyncio
async def test_polling_stops_at_the_timeout_and_says_bfl_has_no_cancel(monkeypatch):
    fake = FakeBFL(monkeypatch, polls=[httpx.Response(200, json=task("Pending"))])

    with pytest.raises(RuntimeError, match="still Pending.*no cancel endpoint"):
        await _run(timeout=0)

    assert fake.urls("POST") == [SUBMIT_URL]


@pytest.mark.asyncio
async def test_an_expired_sample_url_says_so(monkeypatch):
    fake = FakeBFL(monkeypatch, polls=[httpx.Response(200, json=ready(sample="https://delivery-eu1.bfl.ai/gone.png"))])
    original = fake._answer

    def answer(request):
        if str(request.url).endswith("/gone.png"):
            fake.requests.append(request)
            return httpx.Response(403, text="expired")
        return original(request)

    fake._answer = answer  # type: ignore[method-assign]
    with pytest.raises(RuntimeError, match="download failed \\(HTTP 403\\).*may have expired"):
        await _run()


# -- submit errors -------------------------------------------------------------

@pytest.mark.asyncio
async def test_402_says_credits_ran_out_and_is_not_retried(monkeypatch):
    fake = FakeBFL(monkeypatch, submits=[httpx.Response(402, json={"detail": "Insufficient credits"})])

    with pytest.raises(bfl.BFLError, match="Black Forest Labs credits ran out") as caught:
        await _run()

    assert caught.value.status == 402
    assert "dashboard.bfl.ai" in str(caught.value)
    assert fake.urls() == [SUBMIT_URL]


@pytest.mark.asyncio
async def test_429_is_retried_then_the_task_runs(monkeypatch):
    fake = FakeBFL(monkeypatch, submits=[
        httpx.Response(429, json={"detail": "too many active tasks"}),
        httpx.Response(200, json={"id": "task-1", "polling_url": POLL_URL, "cost": 4.8})])

    result = await _run()

    assert fake.urls("POST") == [SUBMIT_URL, SUBMIT_URL]
    assert result.cost_credits == 4.8


@pytest.mark.asyncio
async def test_429_that_persists_ends_with_a_clear_error(monkeypatch):
    fake = FakeBFL(monkeypatch, submits=[httpx.Response(429, json={"detail": "too many active tasks"})])

    with pytest.raises(bfl.BFLError, match="at most 5 FLUX 3 videos at once") as caught:
        await _run(retry_delays=(0.0, 0.0, 0.0))

    assert caught.value.status == 429
    # One try plus one per delay, then no more.
    assert fake.urls() == [SUBMIT_URL] * 4


@pytest.mark.asyncio
async def test_422_names_the_field_bfl_refused(monkeypatch):
    detail = [{"loc": ["body", "resolution"], "msg": "Input should be '768sq', '1k', '1.5k', '2k' or '4k'",
               "type": "literal_error"}]
    FakeBFL(monkeypatch, submits=[httpx.Response(422, json={"detail": detail})])

    with pytest.raises(bfl.BFLError, match="error 422: resolution: Input should be"):
        await _run()


@pytest.mark.asyncio
async def test_422_for_a_malformed_key_says_to_copy_it_again(monkeypatch):
    FakeBFL(monkeypatch, submits=[httpx.Response(422, json={"detail": "Invalid API key format"})])

    with pytest.raises(bfl.BFLError, match="isn't in the format BFL issues"):
        await _run()


@pytest.mark.asyncio
async def test_a_network_failure_on_submit_reads_plainly_and_is_not_resent(monkeypatch):
    fake = FakeBFL(monkeypatch, submits=[lambda request: (_ for _ in ()).throw(httpx.ConnectError("refused"))])

    with pytest.raises(RuntimeError, match="Couldn't reach Black Forest Labs to submit the task: ConnectError"):
        await _run()

    assert fake.urls() == [SUBMIT_URL]


@pytest.mark.asyncio
async def test_a_submit_without_a_task_id_fails(monkeypatch):
    FakeBFL(monkeypatch, submits=[httpx.Response(200, json={"polling_url": POLL_URL})])

    with pytest.raises(RuntimeError, match="returned no task id"):
        await _run()
