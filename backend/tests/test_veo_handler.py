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
async def test_extension_rejected_on_lite():
    with pytest.raises(ValueError, match="[Ee]xtension|[Vv]ideo"):
        await handle_veo(
            _make_node({"model": "veo-3.1-lite-generate-preview"}),
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


# ----------------------------- Vertex AI -----------------------------

class _VertexMock:
    def __init__(self, video=None):
        self.posts = []
        self._video = video or {"bytesBase64Encoded": "RkFLRU1QNA==", "mimeType": "video/mp4"}

    async def __aenter__(self):
        return self

    async def __aexit__(self, *exc):
        return False

    async def post(self, url, json=None, headers=None):
        self.posts.append({"url": url, "json": json, "headers": headers})
        if url.endswith(":fetchPredictOperation"):
            return _Resp(200, {"done": True, "response": {"videos": [self._video]}})
        return _Resp(200, {"name": "projects/p/locations/us-central1/publishers/google/models/m/operations/op1"})


def _vertex_patches(mock, tmp_path):
    return (
        patch("handlers.veo.httpx.AsyncClient", return_value=mock),
        patch("handlers.veo.asyncio.sleep", new=AsyncMock()),
        patch("handlers.veo.get_run_dir", return_value=tmp_path),
        patch("handlers.veo.access_token", new=AsyncMock(return_value=("tok", "my-proj"))),
    )


@pytest.mark.asyncio
async def test_vertex_route_wins_and_maps_to_ga_model(tmp_path):
    mock = _VertexMock()
    a, b, c, d = _vertex_patches(mock, tmp_path)
    with a, b, c, d:
        result = await handle_veo(
            _make_node({"model": "veo-3.1-generate-preview", "duration": "4", "seed": "7"}),
            {
                "prompt": PortValueDict(type="Text", value="a fox"),
                "image": PortValueDict(type="Image", value=PNG_DATA_URI),
                "last_frame": PortValueDict(type="Image", value=PNG_DATA_URI),
            },
            {"GOOGLE_VERTEX_CREDENTIALS": "{}", "GOOGLE_API_KEY": "k"},
        )
    submit, poll = mock.posts
    assert submit["url"] == (
        "https://us-central1-aiplatform.googleapis.com/v1/projects/my-proj/locations/us-central1"
        "/publishers/google/models/veo-3.1-generate-001:predictLongRunning"
    )
    assert submit["headers"]["Authorization"] == "Bearer tok"
    instance = submit["json"]["instances"][0]
    assert instance["image"] == {"bytesBase64Encoded": PNG_B64, "mimeType": "image/png"}
    assert instance["lastFrame"] == {"bytesBase64Encoded": PNG_B64, "mimeType": "image/png"}
    params = submit["json"]["parameters"]
    assert params["durationSeconds"] == 4 and params["seed"] == 7
    assert params["generateAudio"] is True and params["sampleCount"] == 1
    assert poll["url"].endswith("veo-3.1-generate-001:fetchPredictOperation")
    assert poll["json"] == {"operationName": "projects/p/locations/us-central1/publishers/google/models/m/operations/op1"}
    saved = result["video"]["value"]
    assert open(saved, "rb").read() == b"FAKEMP4"
    assert result["source_uri"]["value"] == saved, "Vertex extends from the saved bytes"


@pytest.mark.asyncio
async def test_vertex_extension_sends_saved_clip_bytes(tmp_path):
    clip = tmp_path / "clip.mp4"
    clip.write_bytes(b"CLIP")
    mock = _VertexMock()
    a, b, c, d = _vertex_patches(mock, tmp_path)
    with a, b, c, d, patch("handlers.veo.require_allowed_path", side_effect=lambda p: p):
        await handle_veo(
            _make_node({"model": "veo-3.1-fast-generate-preview", "resolution": "1080p"}),
            {"prompt": PortValueDict(type="Text", value="go on"), "video": PortValueDict(type="Video", value=str(clip))},
            {"GOOGLE_VERTEX_CREDENTIALS": "{}"},
        )
    body = mock.posts[0]["json"]
    assert mock.posts[0]["url"].endswith("veo-3.1-fast-generate-001:predictLongRunning")
    assert body["instances"][0]["video"] == {"bytesBase64Encoded": "Q0xJUA==", "mimeType": "video/mp4"}
    assert body["parameters"]["resolution"] == "1080p", "Vertex doesn't lock extensions to 720p"


@pytest.mark.asyncio
async def test_vertex_rejects_gemini_files_uri_for_extension(tmp_path):
    mock = _VertexMock()
    a, b, c, d = _vertex_patches(mock, tmp_path)
    with a, b, c, d, pytest.raises(ValueError, match="Gemini API"):
        await handle_veo(
            _make_node(),
            {"prompt": PortValueDict(type="Text", value="x"), "video": PortValueDict(type="Video", value=FILES_URI)},
            {"GOOGLE_VERTEX_CREDENTIALS": "{}"},
        )
    assert mock.posts == []


@pytest.mark.asyncio
async def test_vertex_lite_is_text_only(tmp_path):
    with pytest.raises(ValueError, match="Lite"):
        await handle_veo(
            _make_node({"model": "veo-3.1-lite-generate-preview"}),
            {"prompt": PortValueDict(type="Text", value="x"), "image": PortValueDict(type="Image", value=PNG_DATA_URI)},
            {"GOOGLE_VERTEX_CREDENTIALS": "{}"},
        )


@pytest.mark.asyncio
async def test_vertex_filtered_video_reports_reason(tmp_path):
    class _Filtered(_VertexMock):
        async def post(self, url, json=None, headers=None):
            if url.endswith(":fetchPredictOperation"):
                return _Resp(200, {"done": True, "response": {"raiMediaFilteredReasons": ["unsafe"]}})
            return await super().post(url, json, headers)

    mock = _Filtered()
    a, b, c, d = _vertex_patches(mock, tmp_path)
    with a, b, c, d, pytest.raises(RuntimeError, match="filtered.*unsafe"):
        await handle_veo(_make_node(), {"prompt": PortValueDict(type="Text", value="x")}, {"GOOGLE_VERTEX_CREDENTIALS": "{}"})


@pytest.mark.asyncio
async def test_veo_flf_on_vertex_maps_fal_shaped_params(tmp_path):
    from handlers.veo import handle_veo_flf_vertex

    mock = _VertexMock()
    a, b, c, d = _vertex_patches(mock, tmp_path)
    with a, b, c, d:
        await handle_veo_flf_vertex(
            GraphNode(id="flf", definitionId="veo-3-flf", params={
                "aspect_ratio": "auto", "duration": "6s", "resolution": "1080p",
                "generate_audio": False, "negative_prompt": "blur", "safety_tolerance": "2",
            }),
            {
                "prompt": PortValueDict(type="Text", value="morph"),
                "image": PortValueDict(type="Image", value=PNG_DATA_URI),
                "end_image": PortValueDict(type="Image", value=PNG_DATA_URI),
            },
            {"GOOGLE_VERTEX_CREDENTIALS": "{}"},
        )
    body = mock.posts[0]["json"]
    assert mock.posts[0]["url"].endswith("veo-3.1-generate-001:predictLongRunning")
    assert set(body["instances"][0]) == {"prompt", "image", "lastFrame"}
    assert body["parameters"] == {
        "durationSeconds": 6, "resolution": "1080p", "generateAudio": False,
        "negativePrompt": "blur", "sampleCount": 1,
    }


# ----------------------------- fal route + retirement -----------------------------

def test_fal_route_picks_endpoint_and_renames_params():
    from handlers.veo import fal_veo_route

    node = _make_node({
        "model": "veo-3.1-fast-generate-preview", "aspectRatio": "9:16", "duration": "6",
        "resolution": "1080p", "personGeneration": "allow_all", "seed": 3,
    })
    routed, inputs = fal_veo_route(node, {
        "prompt": PortValueDict(type="Text", value="x"),
        "image": PortValueDict(type="Image", value="https://example.com/a.png"),
    })
    assert routed.params == {
        "seed": 3, "aspect_ratio": "9:16", "duration": "6s", "resolution": "1080p",
        "image_url": "https://example.com/a.png", "endpoint_id": "fal-ai/veo3.1/fast/image-to-video",
    }
    assert set(inputs) == {"prompt"}
    assert node.params["model"] == "veo-3.1-fast-generate-preview", "the saved node is not mutated"

    routed, _ = fal_veo_route(_make_node({"model": "veo-3.1-generate-preview"}), {
        "image": PortValueDict(type="Image", value="https://example.com/a.png"),
        "last_frame": PortValueDict(type="Image", value="https://example.com/b.png"),
    })
    assert routed.params["endpoint_id"] == "fal-ai/veo3.1/first-last-frame-to-video"
    assert routed.params["last_frame_url"] == "https://example.com/b.png"

    routed, _ = fal_veo_route(_make_node({"model": "veo-3.1-generate-preview"}), {})
    assert routed.params["endpoint_id"] == "fal-ai/veo3.1"


def test_fal_route_refuses_extension():
    from handlers.veo import fal_veo_route

    with pytest.raises(ValueError, match="Google route"):
        fal_veo_route(_make_node(), {"video": PortValueDict(type="Video", value=FILES_URI)})


def test_vertex_hint_only_after_previews_end():
    from datetime import date

    from handlers.veo import with_vertex_hint

    assert with_vertex_hint("boom", date(2026, 10, 21)) == "boom"
    hinted = with_vertex_hint("boom", date(2026, 10, 22))
    assert hinted.startswith("boom") and "GOOGLE_VERTEX_CREDENTIALS" in hinted


@pytest.mark.asyncio
async def test_gemini_submit_error_points_at_vertex_after_previews_end(tmp_path):
    class _Failing(_VeoMock):
        async def post(self, url, json=None, headers=None):
            return _Resp(404, {"error": "model not found"})

    mock = _Failing()
    p_httpx, p_sleep, p_dir = _patches(mock, tmp_path)
    with p_httpx, p_sleep, p_dir, patch("handlers.veo.previews_retired", return_value=True):
        with pytest.raises(RuntimeError, match="Vertex"):
            await handle_veo(_make_node(), {"prompt": PortValueDict(type="Text", value="x")}, {"GOOGLE_API_KEY": "k"})


@pytest.mark.asyncio
async def test_missing_any_google_credential_names_both():
    with pytest.raises(ValueError, match="GOOGLE_VERTEX_CREDENTIALS.*GOOGLE_API_KEY"):
        await handle_veo(_make_node(), {"prompt": PortValueDict(type="Text", value="x")}, {})


@pytest.mark.asyncio
async def test_vertex_extends_with_lite(tmp_path):
    clip = tmp_path / "clip.mp4"
    clip.write_bytes(b"CLIP")
    mock = _VertexMock()
    a, b, c, d = _vertex_patches(mock, tmp_path)
    with a, b, c, d, patch("handlers.veo.require_allowed_path", side_effect=lambda p: p):
        await handle_veo(
            _make_node({"model": "veo-3.1-lite-generate-preview"}),
            {"prompt": PortValueDict(type="Text", value="go on"), "video": PortValueDict(type="Video", value=str(clip))},
            {"GOOGLE_VERTEX_CREDENTIALS": "{}"},
        )
    assert mock.posts[0]["url"].endswith("veo-3.1-lite-generate-001:predictLongRunning")


@pytest.mark.asyncio
async def test_vertex_refuses_4k_on_fast(tmp_path):
    mock = _VertexMock()
    a, b, c, d = _vertex_patches(mock, tmp_path)
    with a, b, c, d, pytest.raises(ValueError, match="4K"):
        await handle_veo(
            _make_node({"model": "veo-3.1-fast-generate-preview", "resolution": "4k"}),
            {"prompt": PortValueDict(type="Text", value="x")},
            {"GOOGLE_VERTEX_CREDENTIALS": "{}"},
        )
    assert mock.posts == []


@pytest.mark.asyncio
async def test_vertex_converts_webp_frames_to_png(tmp_path):
    import base64 as _b64
    import io as _io

    from PIL import Image

    buf = _io.BytesIO()
    Image.new("RGB", (4, 4), "red").save(buf, format="WEBP")
    webp_uri = "data:image/webp;base64," + _b64.b64encode(buf.getvalue()).decode()
    mock = _VertexMock()
    a, b, c, d = _vertex_patches(mock, tmp_path)
    with a, b, c, d:
        await handle_veo(
            _make_node(),
            {"prompt": PortValueDict(type="Text", value="x"), "image": PortValueDict(type="Image", value=webp_uri)},
            {"GOOGLE_VERTEX_CREDENTIALS": "{}"},
        )
    frame = mock.posts[0]["json"]["instances"][0]["image"]
    assert frame["mimeType"] == "image/png"
    assert _b64.b64decode(frame["bytesBase64Encoded"]).startswith(b"\x89PNG")


@pytest.mark.asyncio
async def test_frame_urls_must_be_public(tmp_path):
    with pytest.raises(RuntimeError, match="will not fetch"):
        await handle_veo(
            _make_node(),
            {"prompt": PortValueDict(type="Text", value="x"),
             "image": PortValueDict(type="Image", value="http://127.0.0.1:8000/secret.png")},
            {"GOOGLE_API_KEY": "k"},
        )
