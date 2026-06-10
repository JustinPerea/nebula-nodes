from __future__ import annotations

from unittest.mock import AsyncMock, patch

import pytest

from handlers.veo import handle_veo
from models.graph import GraphNode, PortValueDict

# 1x1 transparent PNG
PNG_B64 = ("iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk"
           "+M8AAAMBAQDJ/pLvAAAAAElFTkSuQmCC")
PNG_DATA_URI = f"data:image/png;base64,{PNG_B64}"
FILES_URI = "https://generativelanguage.googleapis.com/v1beta/files/g3d8:download?alt=media"


def _make_node(params=None):
    return GraphNode(
        id="test-veo-1",
        definitionId="veo-3",
        params=params or {"model": "veo-3.1-generate-preview"},
    )


class _Resp:
    def __init__(self, status_code, payload):
        self.status_code = status_code
        self._payload = payload
        self.text = str(payload)

    def json(self):
        return self._payload


class _BytesResp:
    def __init__(self, status_code, content):
        self.status_code = status_code
        self.content = content

    def raise_for_status(self):
        if self.status_code >= 400:
            raise RuntimeError(f"HTTP {self.status_code}")


class _VeoMock:
    """Mocks the predictLongRunning submit, the operation poll, and the video download."""

    def __init__(self, op_name="operations/abc",
                 video_uri="https://generativelanguage.googleapis.com/v1beta/files/out:download"):
        self.posts = []
        self.gets = []
        self._op_name = op_name
        self._video_uri = video_uri

    async def __aenter__(self):
        return self

    async def __aexit__(self, *exc):
        return False

    async def post(self, url, json=None, headers=None):
        self.posts.append({"url": url, "json": json, "headers": headers})
        return _Resp(200, {"name": self._op_name})

    async def get(self, url, headers=None, timeout=None, follow_redirects=None):
        self.gets.append(url)
        if url == self._video_uri:
            return _BytesResp(200, b"FAKEMP4")
        return _Resp(200, {
            "done": True,
            "response": {"generateVideoResponse": {"generatedSamples": [{"video": {"uri": self._video_uri}}]}},
        })


def _submit_body(mock: _VeoMock) -> dict:
    return mock.posts[0]["json"]


def _patches(mock, tmp_path):
    return (
        patch("handlers.veo.httpx.AsyncClient", return_value=mock),
        patch("handlers.veo.asyncio.sleep", new=AsyncMock()),
        patch("handlers.veo.get_run_dir", return_value=tmp_path),
    )


# ----------------------------- video extension -----------------------------

@pytest.mark.asyncio
async def test_extension_with_files_uri_sets_video_and_forces_720p(tmp_path):
    mock = _VeoMock()
    p_httpx, p_sleep, p_dir = _patches(mock, tmp_path)
    with p_httpx, p_sleep, p_dir:
        await handle_veo(
            _make_node({"model": "veo-3.1-generate-preview", "resolution": "1080p"}),
            {
                "prompt": PortValueDict(type="Text", value="continue the walk"),
                "video": PortValueDict(type="Video", value=FILES_URI),
            },
            {"GOOGLE_API_KEY": "k"},
        )
    body = _submit_body(mock)
    assert body["instances"][0]["video"] == {"uri": FILES_URI}
    assert body["parameters"]["resolution"] == "720p", "extension is locked to 720p"


@pytest.mark.asyncio
async def test_extension_with_non_uri_video_raises(tmp_path):
    """Veo only accepts its own files/... URI; a local/external clip must error with guidance."""
    with pytest.raises(ValueError, match="[Ss]ource URI|files"):
        await handle_veo(
            _make_node({"model": "veo-3.1-fast-generate-preview"}),
            {
                "prompt": PortValueDict(type="Text", value="continue"),
                "video": PortValueDict(type="Video", value="/tmp/local_clip.mp4"),
            },
            {"GOOGLE_API_KEY": "k"},
        )


@pytest.mark.asyncio
async def test_extension_rejected_on_veo2():
    with pytest.raises(ValueError, match="[Ee]xtension|[Vv]ideo"):
        await handle_veo(
            _make_node({"model": "veo-2.0-generate-001"}),
            {
                "prompt": PortValueDict(type="Text", value="x"),
                "video": PortValueDict(type="Video", value=FILES_URI),
            },
            {"GOOGLE_API_KEY": "k"},
        )


@pytest.mark.asyncio
async def test_extension_mutually_exclusive_with_first_frame():
    with pytest.raises(ValueError, match="combine|first|last"):
        await handle_veo(
            _make_node({"model": "veo-3.1-generate-preview"}),
            {
                "prompt": PortValueDict(type="Text", value="x"),
                "video": PortValueDict(type="Video", value=FILES_URI),
                "image": PortValueDict(type="Image", value=PNG_DATA_URI),
            },
            {"GOOGLE_API_KEY": "k"},
        )


# ----------------------------- source URI passthrough -----------------------------

@pytest.mark.asyncio
async def test_returns_source_uri_for_chaining(tmp_path):
    """The handler exposes the generation's Veo files URI so a downstream node can extend it."""
    mock = _VeoMock(video_uri="https://generativelanguage.googleapis.com/v1beta/files/abc:download")
    p_httpx, p_sleep, p_dir = _patches(mock, tmp_path)
    with p_httpx, p_sleep, p_dir:
        result = await handle_veo(
            _make_node({"model": "veo-3.1-generate-preview"}),
            {"prompt": PortValueDict(type="Text", value="a sunset")},
            {"GOOGLE_API_KEY": "k"},
        )
    assert result["video"]["type"] == "Video"
    assert result["source_uri"]["type"] == "Video"
    assert result["source_uri"]["value"] == "https://generativelanguage.googleapis.com/v1beta/files/abc:download"
    # `video` (the playable local file) MUST come before `source_uri` (an auth-gated API URL):
    # the frontend preview/download picks the first Video-typed output by insertion order.
    assert list(result.keys()) == ["video", "source_uri"]


# ----------------------------- regression (existing modes) -----------------------------

@pytest.mark.asyncio
async def test_text_to_video_unchanged(tmp_path):
    mock = _VeoMock()
    p_httpx, p_sleep, p_dir = _patches(mock, tmp_path)
    with p_httpx, p_sleep, p_dir:
        result = await handle_veo(
            _make_node({"model": "veo-3.1-generate-preview", "aspectRatio": "16:9"}),
            {"prompt": PortValueDict(type="Text", value="a sunset")},
            {"GOOGLE_API_KEY": "k"},
        )
    body = _submit_body(mock)
    assert body["instances"][0]["prompt"] == "a sunset"
    assert "video" not in body["instances"][0]
    assert result["video"]["type"] == "Video"


@pytest.mark.asyncio
async def test_image_to_video_still_uses_bytesbase64(tmp_path):
    mock = _VeoMock()
    p_httpx, p_sleep, p_dir = _patches(mock, tmp_path)
    with p_httpx, p_sleep, p_dir:
        await handle_veo(
            _make_node({"model": "veo-3.1-generate-preview"}),
            {
                "prompt": PortValueDict(type="Text", value="animate"),
                "image": PortValueDict(type="Image", value=PNG_DATA_URI),
            },
            {"GOOGLE_API_KEY": "k"},
        )
    img = _submit_body(mock)["instances"][0]["image"]
    assert img["bytesBase64Encoded"] == PNG_B64
    assert img["mimeType"] == "image/png"


@pytest.mark.asyncio
async def test_missing_api_key_raises():
    with pytest.raises(ValueError, match="GOOGLE_API_KEY"):
        await handle_veo(_make_node(), {"prompt": PortValueDict(type="Text", value="x")}, {})

# ----------------------------- cancellation -----------------------------

@pytest.mark.asyncio
async def test_cancellation_fires_detached_upstream_cancel(tmp_path):
    """On CancelledError mid-poll, the handler must schedule a detached best-effort
    operation cancel (google.longrunning :cancel) and re-raise."""
    import asyncio as _asyncio

    class _CancellingMock(_VeoMock):
        async def get(self, url, headers=None, timeout=None, follow_redirects=None):
            raise _asyncio.CancelledError()

    mock = _CancellingMock()
    p_httpx, p_sleep, p_dir = _patches(mock, tmp_path)
    with p_httpx, p_sleep, p_dir:
        with patch("handlers.veo.schedule_detached_cancel") as mock_sched:
            with pytest.raises(_asyncio.CancelledError):
                await handle_veo(
                    _make_node(),
                    {"prompt": PortValueDict(type="Text", value="a fox")},
                    {"GOOGLE_API_KEY": "k"},
                )

    mock_sched.assert_called_once()


@pytest.mark.asyncio
async def test_cancel_helper_posts_operation_cancel():
    """_cancel_veo_operation must POST {op_name}:cancel with the API key header."""
    from handlers.veo import _cancel_veo_operation

    posted = {}

    class _CancelClient:
        async def __aenter__(self):
            return self

        async def __aexit__(self, *exc):
            return False

        async def post(self, url, headers=None, json=None):
            posted["url"] = url
            posted["headers"] = headers
            return _Resp(200, {})

    with patch("handlers.veo.httpx.AsyncClient", return_value=_CancelClient()):
        await _cancel_veo_operation("operations/abc", "test-key")

    assert posted["url"].endswith("operations/abc:cancel")
    assert posted["headers"]["x-goog-api-key"] == "test-key"
