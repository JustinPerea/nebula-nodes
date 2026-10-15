"""Transient poll errors are retried, and a task Nebula stops waiting for is cancelled.

execution/poll_retry.py is shared by every async video poller. These tests
cover the helper itself and then each poller that uses it: the shared
async_poll_runner (Runway, Replicate), BytePlus Seedance, MiniMax H3, xAI
video, Veo (Gemini API and Vertex) and Gemini Omni.

Only the transport is mocked (httpx.MockTransport): no provider is contacted.
A scripted answer can be an httpx.Response, a status/payload, or an exception
the transport raises (a dropped connection or a timeout).
"""
from __future__ import annotations

import asyncio
import ssl
from typing import Any, Callable
from unittest.mock import AsyncMock

import httpx
import pytest

from execution import poll_retry
from execution.async_poll_runner import AsyncPollConfig, async_poll_execute
from execution.poll_retry import UpstreamTask, is_transient, poll_request
from handlers import byteplus
from models.graph import GraphNode, PortValueDict

_REAL_CLIENT = httpx.AsyncClient
_REAL_SLEEP = asyncio.sleep
PROMPT = {"prompt": PortValueDict(type="Text", value="a lighthouse at dusk")}
MP4 = b"\x00\x00\x00\x18ftypmp42" + b"\x00" * 32


@pytest.fixture(autouse=True)
def fast_sleep(monkeypatch):
    """Every wait (poll interval and retry backoff) is recorded and skipped."""
    waits: list[float] = []

    async def sleep(delay: float, *args: Any, **kwargs: Any) -> None:
        waits.append(delay)
        await _REAL_SLEEP(0)

    monkeypatch.setattr(asyncio, "sleep", sleep)
    return waits


class Maker:
    """A fake maker API. ``polls`` scripts the answers to poll requests, in
    order; the last one repeats. Anything ``other`` matches answers first."""

    def __init__(self, monkeypatch: pytest.MonkeyPatch, poll: Callable[[httpx.Request], bool], polls: list[Any],
                 other: Callable[[httpx.Request], httpx.Response | None]):
        self.requests: list[httpx.Request] = []
        self._poll, self._polls, self._other = poll, list(polls), other

        def factory(*args: Any, **kwargs: Any) -> httpx.AsyncClient:
            kwargs.pop("transport", None)
            return _REAL_CLIENT(*args, transport=httpx.MockTransport(self._answer), **kwargs)

        monkeypatch.setattr(httpx, "AsyncClient", factory)

    def _answer(self, request: httpx.Request) -> httpx.Response:
        self.requests.append(request)
        if self._poll(request):
            answer = self._polls.pop(0) if len(self._polls) > 1 else self._polls[0]
            if isinstance(answer, BaseException):
                raise answer
            if isinstance(answer, httpx.Response):
                return answer
            status, payload = answer
            return httpx.Response(status, json=payload)
        answer = self._other(request)
        if answer is None:
            raise AssertionError(f"unexpected request {request.method} {request.url}")
        return answer

    def calls(self, method: str, url_part: str = "") -> int:
        return sum(1 for r in self.requests if r.method == method and url_part in str(r.url))

    def polls(self) -> int:
        return sum(1 for r in self.requests if self._poll(r))


async def _drain_cancels() -> None:
    from services import cancellation

    await asyncio.gather(*list(cancellation._pending_cancel_tasks))


def _dropped() -> httpx.ConnectError:
    return httpx.ConnectError("connection reset")


def _bad_record_mac() -> ssl.SSLError:
    # A TLS error mid-response reaches the poller raw, not as an httpx error
    # (services/http_errors.py). Seen live 2026-10-15.
    return ssl.SSLError(1, "[SSL: SSLV3_ALERT_BAD_RECORD_MAC] ssl/tls alert bad record mac (_ssl.c:2559)")


# -- the helper ------------------------------------------------------------------

class _Sender:
    def __init__(self, *answers: Any):
        self.answers, self.calls = list(answers), 0

    async def __call__(self) -> Any:
        self.calls += 1
        answer = self.answers.pop(0) if len(self.answers) > 1 else self.answers[0]
        if isinstance(answer, BaseException):
            raise answer
        return answer


@pytest.mark.asyncio
async def test_a_5xx_or_a_dropped_connection_is_retried_with_backoff(fast_sleep):
    send = _Sender(httpx.Response(503), _dropped(), httpx.ReadTimeout("slow"), httpx.Response(200, json={"ok": 1}))
    result = await poll_request(send)
    assert result.status_code == 200 and send.calls == 4
    assert fast_sleep == list(poll_retry.POLL_RETRY_DELAYS[:3])


def test_a_raw_tls_error_is_transient():
    assert is_transient(_bad_record_mac())


@pytest.mark.asyncio
async def test_a_tls_error_mid_response_is_retried(fast_sleep):
    send = _Sender(_bad_record_mac(), httpx.Response(200, json={"ok": 1}))
    result = await poll_request(send)
    assert result.status_code == 200 and send.calls == 2
    assert fast_sleep == list(poll_retry.POLL_RETRY_DELAYS[:1])


@pytest.mark.asyncio
@pytest.mark.parametrize("status", [400, 401, 404, 429])
async def test_a_4xx_is_never_retried(status, fast_sleep):
    send = _Sender(httpx.Response(status), httpx.Response(200))
    result = await poll_request(send)
    assert result.status_code == status and send.calls == 1 and fast_sleep == []


@pytest.mark.asyncio
async def test_retries_are_bounded(fast_sleep):
    send = _Sender(httpx.Response(502))
    assert (await poll_request(send)).status_code == 502
    assert send.calls == len(poll_retry.POLL_RETRY_DELAYS) + 1
    assert sum(fast_sleep) == sum(poll_retry.POLL_RETRY_DELAYS) <= 60

    send = _Sender(_dropped())
    with pytest.raises(httpx.ConnectError):
        await poll_request(send)
    assert send.calls == len(poll_retry.POLL_RETRY_DELAYS) + 1


@pytest.mark.asyncio
async def test_other_errors_and_cancellation_are_not_retried():
    send = _Sender(ValueError("bad json"))
    with pytest.raises(ValueError):
        await poll_request(send)
    assert send.calls == 1
    send = _Sender(asyncio.CancelledError())
    with pytest.raises(asyncio.CancelledError):
        await poll_request(send)
    assert send.calls == 1


def test_byteplus_errors_are_transient_only_on_a_5xx():
    assert is_transient(byteplus.BytePlusError(503, "", "", "x"))
    assert not is_transient(byteplus.BytePlusError(429, "QuotaExceeded", "", "x"))
    assert not is_transient(byteplus.BytePlusError(200, "", "", "x"))
    assert not is_transient({"status": 500})


def test_upstream_task_cancels_only_when_polling_stops_early():
    scheduled: list[Any] = []

    async def cancel() -> None:
        pass

    for finished, error, expected in ((False, RuntimeError, 1), (False, asyncio.CancelledError, 1),
                                      (True, RuntimeError, 0), (False, None, 0)):
        scheduled.clear()
        try:
            with UpstreamTask(cancel, scheduled.append) as task:
                task.finished = finished
                if error is not None:
                    raise error()
        except BaseException:
            pass
        assert len(scheduled) == expected, (finished, error)
    with pytest.raises(RuntimeError):
        with UpstreamTask(None, scheduled.append):
            raise RuntimeError()


# -- the shared runner (Runway, Replicate) ---------------------------------------

RUNWAY_TASK = "https://api.dev.runwayml.com/v1/tasks/task-1"


def _runway(monkeypatch, *polls: Any) -> Maker:
    def other(request: httpx.Request) -> httpx.Response | None:
        if request.method == "POST":
            return httpx.Response(200, json={"id": "task-1"})
        if request.method == "DELETE":
            return httpx.Response(204)
        return None

    return Maker(monkeypatch, lambda r: r.method == "GET", list(polls), other)


def _runway_config() -> AsyncPollConfig:
    return AsyncPollConfig(submit_url="https://api.dev.runwayml.com/v1/image_to_video",
                           poll_url_template="https://api.dev.runwayml.com/v1/tasks/{task_id}",
                           headers={"Authorization": "Bearer fixture"}, terminal_success={"SUCCEEDED"},
                           terminal_failure={"FAILED"}, poll_interval=0)


@pytest.mark.asyncio
async def test_runner_rides_out_a_transient_poll_error(monkeypatch):
    maker = _runway(monkeypatch, (502, {}), _dropped(), (200, {"status": "RUNNING"}),
                    (200, {"status": "SUCCEEDED", "output": ["x"]}))
    result = await async_poll_execute(_runway_config(), {}, "n", AsyncMock())
    await _drain_cancels()
    assert result["output"] == ["x"] and maker.polls() == 4 and maker.calls("DELETE") == 0


@pytest.mark.asyncio
@pytest.mark.parametrize("polls", [[(404, {"error": "gone"})], [(503, {})], [_dropped()]],
                         ids=["4xx", "5xx-persists", "network-persists"])
async def test_runner_cancels_the_task_when_polling_gives_up(monkeypatch, polls):
    maker = _runway(monkeypatch, *polls)
    with pytest.raises((RuntimeError, httpx.ConnectError)):
        await async_poll_execute(_runway_config(), {}, "n", AsyncMock())
    await _drain_cancels()
    assert maker.calls("DELETE", RUNWAY_TASK) == 1


@pytest.mark.asyncio
async def test_runner_leaves_a_task_that_failed_on_its_own(monkeypatch):
    maker = _runway(monkeypatch, (200, {"status": "FAILED", "failure": "nope"}))
    with pytest.raises(RuntimeError, match="nope"):
        await async_poll_execute(_runway_config(), {}, "n", AsyncMock())
    await _drain_cancels()
    assert maker.calls("DELETE") == 0


@pytest.mark.asyncio
async def test_runner_cancels_when_it_stops_waiting(monkeypatch):
    maker = _runway(monkeypatch, (200, {"status": "RUNNING"}))
    config = _runway_config()
    config.max_polls = 2
    with pytest.raises(RuntimeError, match="timed out"):
        await async_poll_execute(config, {}, "n", AsyncMock())
    await _drain_cancels()
    assert maker.calls("DELETE", RUNWAY_TASK) == 1


# -- BytePlus Seedance -----------------------------------------------------------

def _modelark(monkeypatch, *polls: Any) -> Maker:
    monkeypatch.setattr(byteplus, "POLL_INTERVAL", 0)

    def other(request: httpx.Request) -> httpx.Response | None:
        if request.method == "POST":
            return httpx.Response(200, json={"id": "cgt-1"})
        if request.method == "DELETE":
            return httpx.Response(200)
        return None

    return Maker(monkeypatch, lambda r: r.method == "GET", list(polls), other)


@pytest.mark.asyncio
async def test_byteplus_rides_out_a_transient_poll_error(monkeypatch):
    maker = _modelark(monkeypatch, (500, {"error": {"code": "InternalServiceError", "message": "x"}}),
                      httpx.ReadTimeout("slow"), (200, {"status": "running"}), (200, {"status": "succeeded"}))
    task = await byteplus.run_video_task("fixture", {"model": "seedance"})
    await _drain_cancels()
    assert task["status"] == "succeeded" and maker.polls() == 4 and maker.calls("DELETE") == 0


@pytest.mark.asyncio
@pytest.mark.parametrize("polls,error,attempts", [
    ([(503, {"error": {"code": "ServiceUnavailable", "message": "x"}})], byteplus.BytePlusError, 5),
    ([_dropped()], httpx.ConnectError, 5),
    ([_bad_record_mac()], ssl.SSLError, 5),
    ([(400, {"error": {"code": "InvalidParameter", "message": "x"}})], byteplus.BytePlusError, 1),
], ids=["5xx-persists", "network-persists", "tls-error-persists", "4xx"])
async def test_byteplus_deletes_the_task_when_polling_gives_up(monkeypatch, polls, error, attempts):
    assert len(poll_retry.POLL_RETRY_DELAYS) + 1 == 5
    maker = _modelark(monkeypatch, *polls)
    with pytest.raises(error):
        await byteplus.run_video_task("fixture", {"model": "seedance"})
    await _drain_cancels()
    assert maker.polls() == attempts
    assert maker.calls("DELETE", "/contents/generations/tasks/cgt-1") == 1


@pytest.mark.asyncio
async def test_byteplus_rides_out_a_tls_error_mid_poll(monkeypatch):
    maker = _modelark(monkeypatch, _bad_record_mac(), (200, {"status": "succeeded"}))
    task = await byteplus.run_video_task("fixture", {"model": "seedance"})
    await _drain_cancels()
    assert task["status"] == "succeeded" and maker.polls() == 2 and maker.calls("DELETE") == 0


@pytest.mark.asyncio
async def test_byteplus_leaves_a_task_that_failed_on_its_own(monkeypatch):
    maker = _modelark(monkeypatch, (200, {"status": "failed", "error": {"code": "X", "message": "no"}}))
    with pytest.raises(byteplus.BytePlusError):
        await byteplus.run_video_task("fixture", {"model": "seedance"})
    await _drain_cancels()
    assert maker.calls("DELETE") == 0


# -- MiniMax H3 ------------------------------------------------------------------

def _minimax(monkeypatch, tmp_path, *polls: Any) -> Maker:
    from handlers import minimax_v2

    async def fake_save(url: str, run_dir: Any, extension: str = "mp4") -> Any:
        path = tmp_path / "h3.mp4"
        path.write_bytes(MP4)
        return path

    monkeypatch.setattr(minimax_v2, "POLL_INTERVAL", 0)
    monkeypatch.setattr(minimax_v2, "save_video_from_url", fake_save)

    def other(request: httpx.Request) -> httpx.Response | None:
        if request.method == "POST":
            return httpx.Response(200, json={"task_id": "h3-1"})
        if request.method == "DELETE":
            return httpx.Response(200, json={})
        return None

    return Maker(monkeypatch, lambda r: "/v2/query/video_generation/" in str(r.url), list(polls), other)


def _h3_node() -> GraphNode:
    return GraphNode(id="h", definitionId="minimax-h3", params={"model": "MiniMax-H3", "ratio": "16:9"})


@pytest.mark.asyncio
async def test_minimax_h3_rides_out_a_transient_poll_error(monkeypatch, tmp_path):
    from handlers.minimax_v2 import handle_minimax_video_v2

    maker = _minimax(monkeypatch, tmp_path, (502, {}), _dropped(),
                     (200, {"task": {"status": "succeeded", "content": {"url": "https://cdn.example.com/h3.mp4"}}}))
    result = await handle_minimax_video_v2(_h3_node(), PROMPT, {"MINIMAX_API_KEY": "fixture"})
    await _drain_cancels()
    assert result["video"]["type"] == "Video" and maker.polls() == 3 and maker.calls("DELETE") == 0


@pytest.mark.asyncio
async def test_minimax_h3_cancels_the_task_when_polling_gives_up(monkeypatch, tmp_path):
    from handlers.minimax_v2 import handle_minimax_video_v2

    maker = _minimax(monkeypatch, tmp_path, (500, {}))
    with pytest.raises(RuntimeError, match="poll failed \\(500\\)"):
        await handle_minimax_video_v2(_h3_node(), PROMPT, {"MINIMAX_API_KEY": "fixture"})
    await _drain_cancels()
    assert maker.polls() == len(poll_retry.POLL_RETRY_DELAYS) + 1
    assert maker.calls("DELETE", "/v2/video_generation/h3-1") == 1


# -- xAI video (no cancel endpoint) -----------------------------------------------

@pytest.mark.asyncio
async def test_xai_video_rides_out_a_transient_poll_error(monkeypatch, tmp_path):
    from handlers import grok_video

    monkeypatch.setattr(grok_video, "POLL_INTERVAL", 0)
    monkeypatch.setattr(grok_video, "get_run_dir", lambda: tmp_path)

    def other(request: httpx.Request) -> httpx.Response | None:
        if request.method == "POST":
            return httpx.Response(200, json={"request_id": "x-1"})
        if str(request.url) == "https://cdn.example.com/x.mp4":
            return httpx.Response(200, content=MP4)
        return None

    maker = Maker(monkeypatch, lambda r: r.method == "GET" and "/videos/x-1" in str(r.url),
                  [(503, {}), httpx.ReadTimeout("slow"),
                   (200, {"status": "done", "video": {"url": "https://cdn.example.com/x.mp4"}})], other)
    path = await grok_video.run_xai_video(node_id="g", api_key="fixture", endpoint="generations",
                                          body={"model": "grok-imagine-video", "prompt": "p"})
    assert path.endswith(".mp4") and maker.polls() == 3


# -- Veo (Gemini API and Vertex) ---------------------------------------------------

VEO_OP = "operations/op-1"
VEO_FILE = "https://generativelanguage.googleapis.com/v1beta/files/out:download"


def _veo(monkeypatch, tmp_path, *polls: Any) -> Maker:
    from handlers import veo

    monkeypatch.setattr(veo, "get_run_dir", lambda: tmp_path)
    monkeypatch.setattr(veo, "previews_retired", lambda *_: False)

    def other(request: httpx.Request) -> httpx.Response | None:
        if request.url.path.endswith(":predictLongRunning"):
            return httpx.Response(200, json={"name": VEO_OP})
        if request.url.path.endswith(":cancel"):
            return httpx.Response(200, json={})
        if str(request.url) == VEO_FILE:
            return httpx.Response(200, content=MP4)
        return None

    return Maker(monkeypatch, lambda r: r.method == "GET" and r.url.path.endswith(VEO_OP), list(polls), other)


_VEO_DONE = (200, {"done": True, "response": {"generateVideoResponse": {
    "generatedSamples": [{"video": {"uri": VEO_FILE}}]}}})


@pytest.mark.asyncio
async def test_veo_rides_out_a_transient_poll_error(monkeypatch, tmp_path):
    from handlers.veo import handle_veo

    maker = _veo(monkeypatch, tmp_path, (500, {}), _dropped(), (200, {"done": False}), _VEO_DONE)
    result = await handle_veo(GraphNode(id="v", definitionId="veo-3", params={"model": "veo-3.1-generate-001"}),
                              PROMPT, {"GOOGLE_API_KEY": "fixture"})
    await _drain_cancels()
    assert result["source_uri"]["value"] == VEO_FILE and maker.polls() == 4 and maker.calls("POST", ":cancel") == 0


@pytest.mark.asyncio
async def test_veo_cancels_the_operation_when_polling_gives_up(monkeypatch, tmp_path):
    from handlers.veo import handle_veo

    maker = _veo(monkeypatch, tmp_path, (403, {"error": "denied"}))
    with pytest.raises(RuntimeError, match="poll failed \\(403\\)"):
        await handle_veo(GraphNode(id="v", definitionId="veo-3", params={"model": "veo-3.1-generate-001"}),
                         PROMPT, {"GOOGLE_API_KEY": "fixture"})
    await _drain_cancels()
    assert maker.polls() == 1 and maker.calls("POST", f"{VEO_OP}:cancel") == 1


@pytest.mark.asyncio
async def test_vertex_veo_rides_out_a_transient_poll_error_and_cancels_on_give_up(monkeypatch, tmp_path):
    from handlers import veo

    def other(request: httpx.Request) -> httpx.Response | None:
        if request.url.path.endswith(":predictLongRunning"):
            return httpx.Response(200, json={"name": "projects/p/operations/vx"})
        if request.url.path.endswith(":cancel"):
            return httpx.Response(200, json={})
        return None

    done = (200, {"done": True, "response": {"videos": [{"bytesBase64Encoded": "AAAA", "mimeType": "video/mp4"}]}})
    is_poll = lambda r: r.url.path.endswith(":fetchPredictOperation")  # noqa: E731
    monkeypatch.setattr(veo, "access_token", AsyncMock(return_value=("token", "p")))
    monkeypatch.setattr(veo, "get_run_dir", lambda: tmp_path)
    node = GraphNode(id="v", definitionId="veo-3", params={})

    maker = Maker(monkeypatch, is_poll, [(503, {}), _dropped(), done], other)
    await veo.run_vertex_veo(node, "{}", "veo-3.1-generate-001", {"prompt": "p"}, {})
    await _drain_cancels()
    assert maker.polls() == 3 and maker.calls("POST", ":cancel") == 0

    maker = Maker(monkeypatch, is_poll, [(503, {})], other)
    with pytest.raises(RuntimeError, match="poll failed \\(503\\)"):
        await veo.run_vertex_veo(node, "{}", "veo-3.1-generate-001", {"prompt": "p"}, {})
    await _drain_cancels()
    assert maker.polls() == len(poll_retry.POLL_RETRY_DELAYS) + 1 and maker.calls("POST", "vx:cancel") == 1


# -- Gemini Omni -------------------------------------------------------------------

def _omni(monkeypatch, tmp_path, *polls: Any) -> Maker:
    from handlers import gemini_omni

    monkeypatch.setattr(gemini_omni, "get_run_dir", lambda: tmp_path)

    def other(request: httpx.Request) -> httpx.Response | None:
        if request.method == "POST" and request.url.path.endswith("/cancel"):
            return httpx.Response(200, json={})
        if request.method == "POST":
            return httpx.Response(200, json={"id": "om-1", "status": "processing"})
        return None

    return Maker(monkeypatch, lambda r: r.method == "GET" and r.url.path.endswith("/om-1"), list(polls), other)


_OMNI_DONE = (200, {"id": "om-1", "status": "completed", "steps": [{"type": "model_output", "content": [
    {"type": "video", "mime_type": "video/mp4", "data": "ZmFrZQ=="}]}]})


@pytest.mark.asyncio
async def test_gemini_omni_rides_out_a_transient_poll_error(monkeypatch, tmp_path):
    from handlers.gemini_omni import handle_gemini_omni

    maker = _omni(monkeypatch, tmp_path, (502, {}), httpx.ReadTimeout("slow"), _OMNI_DONE)
    result = await handle_gemini_omni(GraphNode(id="o", definitionId="gemini-omni-flash", params={"delivery": "inline"}),
                                      PROMPT, {"GOOGLE_API_KEY": "fixture"})
    await _drain_cancels()
    assert result["video"]["type"] == "Video" and maker.polls() == 3 and maker.calls("POST", "/cancel") == 0


@pytest.mark.asyncio
async def test_gemini_omni_cancels_the_interaction_when_polling_gives_up(monkeypatch, tmp_path):
    from handlers.gemini_omni import handle_gemini_omni

    maker = _omni(monkeypatch, tmp_path, (404, {"error": "unknown"}))
    with pytest.raises(RuntimeError, match="poll failed \\(404\\)"):
        await handle_gemini_omni(GraphNode(id="o", definitionId="gemini-omni-flash", params={"delivery": "inline"}),
                                 PROMPT, {"GOOGLE_API_KEY": "fixture"})
    await _drain_cancels()
    assert maker.polls() == 1 and maker.calls("POST", "/om-1/cancel") == 1


def test_every_async_video_poller_uses_the_shared_retry():
    """A new poller added beside these should use poll_request too."""
    import inspect

    from execution import async_poll_runner
    from handlers import gemini_omni, grok_video, minimax_v2, veo

    for module in (async_poll_runner, byteplus, minimax_v2, grok_video, veo, gemini_omni):
        assert "poll_request(" in inspect.getsource(module), module.__name__
