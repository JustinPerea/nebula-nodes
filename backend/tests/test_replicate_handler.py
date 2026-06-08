from __future__ import annotations

import asyncio
import json
from unittest.mock import AsyncMock, MagicMock, patch

import pytest

from handlers.replicate_universal import handle_replicate_universal, _infer_output_type
from models.graph import GraphNode, PortValueDict


def _make_node(params=None):
    return GraphNode(
        id="test-rep-1",
        definitionId="replicate-universal",
        params=params or {"model_id": "stability-ai/sdxl", "_version_id": "v123"},
    )


class _Resp:
    def __init__(self, status_code, payload):
        self.status_code = status_code
        self._payload = payload
        self.text = json.dumps(payload)

    def json(self):
        return self._payload


class _FakeClient:
    """Minimal stand-in for httpx.AsyncClient covering submit (POST) + poll (GET)."""

    def __init__(self, post_resp, get_resps=None):
        self._post_resp = post_resp
        self._get_resps = list(get_resps or [])
        self.posted = []
        self.getted = []

    async def __aenter__(self):
        return self

    async def __aexit__(self, *exc):
        return False

    async def post(self, url, headers=None, json=None):
        self.posted.append((url, headers, json))
        return self._post_resp

    async def get(self, url, headers=None):
        self.getted.append((url, headers))
        if self._get_resps:
            return self._get_resps.pop(0)
        return _Resp(200, {"status": "succeeded", "output": "done"})


def _patch_httpx(client):
    return patch("handlers.replicate_universal.httpx.AsyncClient", return_value=client)


def _patch_sleep():
    # poll_until_terminal awaits asyncio.sleep(poll_interval) in the runner module.
    return patch("execution.async_poll_runner.asyncio.sleep", new=AsyncMock())


# ----------------------------- output inference -----------------------------

class TestOutputTypeInference:
    def test_image_url(self) -> None:
        assert _infer_output_type("https://example.com/output.png")["image"]["type"] == "Image"

    def test_video_url(self) -> None:
        assert _infer_output_type("https://example.com/output.mp4")["video"]["type"] == "Video"

    def test_audio_url(self) -> None:
        assert _infer_output_type("https://example.com/output.wav")["audio"]["type"] == "Audio"

    def test_plain_text(self) -> None:
        assert _infer_output_type("Hello world")["text"]["type"] == "Text"

    def test_url_list(self) -> None:
        assert _infer_output_type(["https://example.com/a.png", "https://example.com/b.png"])["image"]["type"] == "Image"

    def test_generic_url_defaults_to_image(self) -> None:
        assert _infer_output_type("https://example.com/some-output")["image"]["type"] == "Image"


# ----------------------------- validation -----------------------------

@pytest.mark.asyncio
async def test_missing_api_key_raises():
    with pytest.raises(ValueError, match="REPLICATE_API_TOKEN"):
        await handle_replicate_universal(_make_node(), {}, {})


@pytest.mark.asyncio
async def test_invalid_model_id_raises():
    with pytest.raises(ValueError, match="[Mm]odel ID"):
        await handle_replicate_universal(
            _make_node({"model_id": "no-slash"}),
            {},
            {"REPLICATE_API_TOKEN": "r8_test"},
        )


# ----------------------------- non-streaming (poll) path -----------------------------

@pytest.mark.asyncio
async def test_submit_and_poll_returns_image():
    """No urls.stream in the submit response => fall back to polling (image/video/etc.)."""
    submit = _Resp(201, {"id": "pred-123", "status": "starting", "urls": {}})
    poll = _Resp(200, {"status": "succeeded", "output": ["https://replicate.delivery/output.png"]})
    client = _FakeClient(submit, [poll])
    with _patch_httpx(client), _patch_sleep():
        result = await handle_replicate_universal(
            _make_node(),
            {"prompt": PortValueDict(type="Text", value="A sunset")},
            {"REPLICATE_API_TOKEN": "r8_test"},
            emit=AsyncMock(),
        )
    assert result["image"]["type"] == "Image"
    assert "output.png" in result["image"]["value"]
    assert client.getted, "non-streaming path must poll"


@pytest.mark.asyncio
async def test_text_model_via_polling_returns_text():
    submit = _Resp(201, {"id": "pred-456", "status": "starting", "urls": {}})
    poll = _Resp(200, {"status": "succeeded", "output": "Once upon a time..."})
    client = _FakeClient(submit, [poll])
    with _patch_httpx(client), _patch_sleep():
        result = await handle_replicate_universal(
            _make_node({"model_id": "meta/llama-2-70b", "_version_id": "v789"}),
            {"prompt": PortValueDict(type="Text", value="Tell me a story")},
            {"REPLICATE_API_TOKEN": "r8_test"},
            emit=AsyncMock(),
        )
    assert result["text"]["type"] == "Text"
    assert "Once upon" in result["text"]["value"]


@pytest.mark.asyncio
async def test_auth_header_uses_bearer():
    """Submit POST must use the 'Bearer' prefix (Replicate HTTP reference)."""
    submit = _Resp(201, {"id": "p", "urls": {}})
    client = _FakeClient(submit, [_Resp(200, {"status": "succeeded", "output": "done"})])
    with _patch_httpx(client), _patch_sleep():
        await handle_replicate_universal(
            _make_node(),
            {"prompt": PortValueDict(type="Text", value="test")},
            {"REPLICATE_API_TOKEN": "r8_abc123"},
            emit=AsyncMock(),
        )
    _url, headers, _body = client.posted[0]
    assert headers["Authorization"] == "Bearer r8_abc123"


@pytest.mark.asyncio
async def test_submit_body_uses_version_field():
    submit = _Resp(201, {"id": "p", "urls": {}})
    client = _FakeClient(submit, [_Resp(200, {"status": "succeeded", "output": "result"})])
    with _patch_httpx(client), _patch_sleep():
        await handle_replicate_universal(
            _make_node({"model_id": "stability-ai/sdxl", "_version_id": "abc-v1"}),
            {"prompt": PortValueDict(type="Text", value="a dog")},
            {"REPLICATE_API_TOKEN": "r8_test"},
            emit=AsyncMock(),
        )
    _url, _headers, body = client.posted[0]
    assert body["version"] == "abc-v1"
    assert "input" in body


@pytest.mark.asyncio
async def test_resolves_version_when_not_cached():
    submit = _Resp(201, {"id": "p", "urls": {}})
    client = _FakeClient(submit, [_Resp(200, {"status": "succeeded", "output": "done"})])
    with patch("handlers.replicate_universal._resolve_version", new_callable=AsyncMock) as mock_resolve, \
         _patch_httpx(client), _patch_sleep():
        mock_resolve.return_value = "resolved-v1"
        await handle_replicate_universal(
            _make_node({"model_id": "owner/model", "_version_id": ""}),
            {"prompt": PortValueDict(type="Text", value="test")},
            {"REPLICATE_API_TOKEN": "r8_test"},
            emit=AsyncMock(),
        )
    mock_resolve.assert_called_once_with("owner", "model", "r8_test")


# ----------------------------- streaming path -----------------------------

@pytest.mark.asyncio
async def test_streams_when_urls_stream_present():
    """A streaming-capable model returns urls.stream => consume SSE, return Text, skip polling."""
    submit = _Resp(201, {"id": "pred-s", "status": "starting",
                         "urls": {"stream": "https://stream.replicate.com/v1/files/xyz"}})
    client = _FakeClient(submit, [])
    with _patch_httpx(client), \
         patch("handlers.replicate_universal.stream_execute_replicate", new_callable=AsyncMock) as mock_stream:
        mock_stream.return_value = "streamed words"
        result = await handle_replicate_universal(
            _make_node({"model_id": "meta/meta-llama-3-8b-instruct", "_version_id": "v1"}),
            {"prompt": PortValueDict(type="Text", value="hi")},
            {"REPLICATE_API_TOKEN": "r8_test"},
            emit=AsyncMock(),
        )
    assert result == {"text": {"type": "Text", "value": "streamed words"}}
    mock_stream.assert_called_once()
    assert mock_stream.call_args.kwargs["stream_url"] == "https://stream.replicate.com/v1/files/xyz"
    assert not client.getted, "streaming path must NOT poll"


@pytest.mark.asyncio
async def test_no_streaming_when_emit_is_none():
    """Even if urls.stream is present, with no emit there's nowhere to send deltas => poll."""
    submit = _Resp(201, {"id": "pred-s", "urls": {"stream": "https://stream.replicate.com/v1/files/xyz"}})
    poll = _Resp(200, {"status": "succeeded", "output": "done"})
    client = _FakeClient(submit, [poll])
    with _patch_httpx(client), _patch_sleep(), \
         patch("handlers.replicate_universal.stream_execute_replicate", new_callable=AsyncMock) as mock_stream:
        await handle_replicate_universal(
            _make_node({"model_id": "meta/meta-llama-3-8b-instruct", "_version_id": "v1"}),
            {"prompt": PortValueDict(type="Text", value="hi")},
            {"REPLICATE_API_TOKEN": "r8_test"},
            emit=None,
        )
    mock_stream.assert_not_called()
    assert client.getted, "must fall back to polling when emit is None"


@pytest.mark.asyncio
async def test_cancel_during_stream_cancels_upstream():
    """CancelledError mid-stream must POST .../predictions/{id}/cancel before re-raising."""
    submit = _Resp(201, {"id": "pred-c", "urls": {"stream": "https://stream.replicate.com/v1/files/xyz"}})
    client = _FakeClient(submit, [])

    def _run_make_coro(make_coro):
        make_coro()  # invoke the lambda -> calls the (patched) _cancel_async_poll

    with _patch_httpx(client), \
         patch("handlers.replicate_universal.stream_execute_replicate",
               new=AsyncMock(side_effect=asyncio.CancelledError())), \
         patch("handlers.replicate_universal._cancel_async_poll", new_callable=MagicMock) as mock_cancel, \
         patch("handlers.replicate_universal.schedule_detached_cancel", side_effect=_run_make_coro):
        with pytest.raises(asyncio.CancelledError):
            await handle_replicate_universal(
                _make_node({"model_id": "meta/meta-llama-3-8b-instruct", "_version_id": "v1"}),
                {"prompt": PortValueDict(type="Text", value="hi")},
                {"REPLICATE_API_TOKEN": "r8_test"},
                emit=AsyncMock(),
            )
    mock_cancel.assert_called_once()
    args = mock_cancel.call_args.args
    assert args[0] == "https://api.replicate.com/v1/predictions/pred-c/cancel"
    assert args[1] == "POST"
