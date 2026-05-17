from __future__ import annotations

from unittest.mock import AsyncMock, MagicMock, patch

import pytest

from handlers.grok_video import handle_grok_video
from models.graph import GraphNode, PortValueDict


def _make_node(params: dict | None = None) -> GraphNode:
    return GraphNode(
        id="grok-video-test",
        definitionId="grok-imagine-video",
        params=params or {},
    )


def _mock_client(submit_json: dict, poll_json: dict) -> AsyncMock:
    """Return a mock AsyncClient wired with submit + one poll + one download response."""
    submit_resp = MagicMock()
    submit_resp.status_code = 200
    submit_resp.json.return_value = submit_json

    poll_resp = MagicMock()
    poll_resp.status_code = 200
    poll_resp.json.return_value = poll_json

    dl_resp = MagicMock()
    dl_resp.raise_for_status = MagicMock()
    dl_resp.content = b"fake-video-bytes"

    mock_client = AsyncMock()
    mock_client.post.return_value = submit_resp
    mock_client.get.side_effect = [poll_resp, dl_resp]
    mock_client.__aenter__ = AsyncMock(return_value=mock_client)
    mock_client.__aexit__ = AsyncMock(return_value=False)
    return mock_client


# xAI canonical response shapes (sourced from docs.x.ai/developers/model-capabilities/video/generation, 2026-05-16)
_SUBMIT_OK = {"request_id": "d97415a1-5796-b7ec-379f-4e6819e08fdf"}
_POLL_DONE = {
    "status": "done",
    "video": {"url": "https://vidgen.x.ai/result/video.mp4", "duration": 5},
    "model": "grok-imagine-video",
}
_API_KEYS = {"XAI_API_KEY": "xai-test-key"}


# ---------------------------------------------------------------------------
# Endpoint and model correctness
# ---------------------------------------------------------------------------


@pytest.mark.asyncio
async def test_submit_endpoint_is_videos_generations() -> None:
    """Must POST to /v1/videos/generations (plural), not /v1/video/generations."""
    mock_client = _mock_client(_SUBMIT_OK, _POLL_DONE)

    with patch("handlers.grok_video.httpx.AsyncClient", return_value=mock_client), \
         patch("handlers.grok_video.asyncio.sleep", new_callable=AsyncMock), \
         patch("handlers.grok_video.get_run_dir", return_value=__import__("pathlib").Path("/tmp")):

        await handle_grok_video(
            _make_node({"duration": 5}),
            {"prompt": PortValueDict(type="Text", value="a rocket launch")},
            _API_KEYS,
        )

    url = mock_client.post.call_args.args[0]
    assert url == "https://api.x.ai/v1/videos/generations", (
        f"Wrong endpoint: {url}. Must be /v1/videos/generations (plural 'videos')"
    )


@pytest.mark.asyncio
async def test_model_id_is_grok_imagine_video() -> None:
    """Body must set model='grok-imagine-video', not 'grok-2-video' or similar."""
    mock_client = _mock_client(_SUBMIT_OK, _POLL_DONE)

    with patch("handlers.grok_video.httpx.AsyncClient", return_value=mock_client), \
         patch("handlers.grok_video.asyncio.sleep", new_callable=AsyncMock), \
         patch("handlers.grok_video.get_run_dir", return_value=__import__("pathlib").Path("/tmp")):

        await handle_grok_video(
            _make_node(),
            {"prompt": PortValueDict(type="Text", value="sunset")},
            _API_KEYS,
        )

    body = mock_client.post.call_args.kwargs["json"]
    assert body["model"] == "grok-imagine-video", (
        f"Wrong model ID: {body['model']}. Must be 'grok-imagine-video'"
    )


# ---------------------------------------------------------------------------
# Request body
# ---------------------------------------------------------------------------


@pytest.mark.asyncio
async def test_request_body_shape() -> None:
    """Body must include model, prompt, duration, aspect_ratio, resolution."""
    mock_client = _mock_client(_SUBMIT_OK, _POLL_DONE)

    with patch("handlers.grok_video.httpx.AsyncClient", return_value=mock_client), \
         patch("handlers.grok_video.asyncio.sleep", new_callable=AsyncMock), \
         patch("handlers.grok_video.get_run_dir", return_value=__import__("pathlib").Path("/tmp")):

        await handle_grok_video(
            _make_node({"duration": 8, "aspect_ratio": "9:16", "resolution": "720p"}),
            {"prompt": PortValueDict(type="Text", value="a dancer on stage")},
            _API_KEYS,
        )

    body = mock_client.post.call_args.kwargs["json"]
    assert body["model"] == "grok-imagine-video"
    assert body["prompt"] == "a dancer on stage"
    assert body["duration"] == 8
    assert body["aspect_ratio"] == "9:16"
    assert body["resolution"] == "720p"


@pytest.mark.asyncio
async def test_optional_params_omitted_when_absent() -> None:
    """duration, aspect_ratio, resolution must not appear in body if not set."""
    mock_client = _mock_client(_SUBMIT_OK, _POLL_DONE)

    with patch("handlers.grok_video.httpx.AsyncClient", return_value=mock_client), \
         patch("handlers.grok_video.asyncio.sleep", new_callable=AsyncMock), \
         patch("handlers.grok_video.get_run_dir", return_value=__import__("pathlib").Path("/tmp")):

        await handle_grok_video(
            _make_node(),
            {"prompt": PortValueDict(type="Text", value="a still lake")},
            _API_KEYS,
        )

    body = mock_client.post.call_args.kwargs["json"]
    assert "duration" not in body
    assert "aspect_ratio" not in body
    assert "resolution" not in body


# ---------------------------------------------------------------------------
# Polling
# ---------------------------------------------------------------------------


@pytest.mark.asyncio
async def test_poll_endpoint_is_videos_request_id() -> None:
    """Poll must GET /v1/videos/{request_id}, not /v1/video/generations/{id}."""
    mock_client = _mock_client(_SUBMIT_OK, _POLL_DONE)

    with patch("handlers.grok_video.httpx.AsyncClient", return_value=mock_client), \
         patch("handlers.grok_video.asyncio.sleep", new_callable=AsyncMock), \
         patch("handlers.grok_video.get_run_dir", return_value=__import__("pathlib").Path("/tmp")):

        await handle_grok_video(
            _make_node(),
            {"prompt": PortValueDict(type="Text", value="test")},
            _API_KEYS,
        )

    poll_url = mock_client.get.call_args_list[0].args[0]
    assert poll_url == "https://api.x.ai/v1/videos/d97415a1-5796-b7ec-379f-4e6819e08fdf", (
        f"Wrong poll URL: {poll_url}"
    )


@pytest.mark.asyncio
async def test_reads_request_id_not_id_or_generation_id() -> None:
    """Handler must read 'request_id' from submit response, not 'id' or 'generation_id'."""
    submit_data = {"request_id": "specific-req-id"}
    mock_client = _mock_client(submit_data, _POLL_DONE)

    with patch("handlers.grok_video.httpx.AsyncClient", return_value=mock_client), \
         patch("handlers.grok_video.asyncio.sleep", new_callable=AsyncMock), \
         patch("handlers.grok_video.get_run_dir", return_value=__import__("pathlib").Path("/tmp")):

        await handle_grok_video(
            _make_node(),
            {"prompt": PortValueDict(type="Text", value="test")},
            _API_KEYS,
        )

    poll_url = mock_client.get.call_args_list[0].args[0]
    assert "specific-req-id" in poll_url


@pytest.mark.asyncio
async def test_done_status_triggers_video_download() -> None:
    """Status 'done' (not 'completed' or 'succeeded') must trigger download."""
    mock_client = _mock_client(_SUBMIT_OK, _POLL_DONE)

    with patch("handlers.grok_video.httpx.AsyncClient", return_value=mock_client), \
         patch("handlers.grok_video.asyncio.sleep", new_callable=AsyncMock), \
         patch("handlers.grok_video.get_run_dir", return_value=__import__("pathlib").Path("/tmp")):

        result = await handle_grok_video(
            _make_node(),
            {"prompt": PortValueDict(type="Text", value="test")},
            _API_KEYS,
        )

    assert result["video"]["type"] == "Video"
    assert result["video"]["value"].endswith(".mp4")


@pytest.mark.asyncio
async def test_reads_video_url_from_nested_video_object() -> None:
    """Video URL must come from poll_data['video']['url'], not top-level 'url'."""
    # Response has no top-level 'url' or 'video_url' — only nested video.url
    poll_data = {"status": "done", "video": {"url": "https://vidgen.x.ai/video.mp4"}}
    mock_client = _mock_client(_SUBMIT_OK, poll_data)

    with patch("handlers.grok_video.httpx.AsyncClient", return_value=mock_client), \
         patch("handlers.grok_video.asyncio.sleep", new_callable=AsyncMock), \
         patch("handlers.grok_video.get_run_dir", return_value=__import__("pathlib").Path("/tmp")):

        result = await handle_grok_video(
            _make_node(),
            {"prompt": PortValueDict(type="Text", value="test")},
            _API_KEYS,
        )

    assert result["video"]["type"] == "Video"


# ---------------------------------------------------------------------------
# Status values
# ---------------------------------------------------------------------------


@pytest.mark.asyncio
async def test_expired_status_raises() -> None:
    """'expired' status must raise RuntimeError."""
    poll_data = {"status": "expired"}
    mock_client = _mock_client(_SUBMIT_OK, poll_data)

    with patch("handlers.grok_video.httpx.AsyncClient", return_value=mock_client), \
         patch("handlers.grok_video.asyncio.sleep", new_callable=AsyncMock):

        with pytest.raises(RuntimeError, match="Grok failed"):
            await handle_grok_video(
                _make_node(),
                {"prompt": PortValueDict(type="Text", value="test")},
                _API_KEYS,
            )


@pytest.mark.asyncio
async def test_failed_status_raises() -> None:
    poll_data = {"status": "failed", "error": {"code": "invalid_argument", "message": "bad prompt"}}
    mock_client = _mock_client(_SUBMIT_OK, poll_data)

    with patch("handlers.grok_video.httpx.AsyncClient", return_value=mock_client), \
         patch("handlers.grok_video.asyncio.sleep", new_callable=AsyncMock):

        with pytest.raises(RuntimeError, match="bad prompt"):
            await handle_grok_video(
                _make_node(),
                {"prompt": PortValueDict(type="Text", value="test")},
                _API_KEYS,
            )


# ---------------------------------------------------------------------------
# Error cases
# ---------------------------------------------------------------------------


@pytest.mark.asyncio
async def test_missing_api_key_raises() -> None:
    with pytest.raises(ValueError, match="XAI_API_KEY"):
        await handle_grok_video(
            _make_node(),
            {"prompt": PortValueDict(type="Text", value="test")},
            {},
        )


@pytest.mark.asyncio
async def test_missing_prompt_raises() -> None:
    with pytest.raises(ValueError, match="Prompt"):
        await handle_grok_video(
            _make_node(),
            {},
            _API_KEYS,
        )


@pytest.mark.asyncio
async def test_missing_request_id_in_response_raises() -> None:
    """If submit response lacks 'request_id', handler must raise RuntimeError."""
    bad_submit = {"id": "old-style-id"}  # old field name — must be rejected
    mock_client = _mock_client(bad_submit, _POLL_DONE)

    with patch("handlers.grok_video.httpx.AsyncClient", return_value=mock_client), \
         patch("handlers.grok_video.asyncio.sleep", new_callable=AsyncMock):

        with pytest.raises(RuntimeError, match="unexpected response"):
            await handle_grok_video(
                _make_node(),
                {"prompt": PortValueDict(type="Text", value="test")},
                _API_KEYS,
            )


# ---------------------------------------------------------------------------
# Image field name (I2V)
# ---------------------------------------------------------------------------


@pytest.mark.asyncio
async def test_i2v_request_body_uses_image_field() -> None:
    """I2V mode maps the image port to `image` in the request body (not `image_url`)."""
    mock_client = _mock_client(_SUBMIT_OK, _POLL_DONE)

    with patch("handlers.grok_video.httpx.AsyncClient", return_value=mock_client), \
         patch("handlers.grok_video.asyncio.sleep", new_callable=AsyncMock), \
         patch("handlers.grok_video.get_run_dir", return_value=__import__("pathlib").Path("/tmp")):

        await handle_grok_video(
            _make_node(),
            {
                "prompt": PortValueDict(type="Text", value="a slow pan"),
                "image": PortValueDict(type="Image", value="https://example.com/frame.jpg"),
            },
            _API_KEYS,
        )

    body = mock_client.post.call_args.kwargs["json"]
    assert "image" in body, "Expected 'image' key in body for Grok I2V"
    assert body["image"] == "https://example.com/frame.jpg"
    assert "image_url" not in body, "Body must not contain 'image_url' — Grok uses 'image'"


# ---------------------------------------------------------------------------
# Output contract
# ---------------------------------------------------------------------------


@pytest.mark.asyncio
async def test_output_port_id_is_video() -> None:
    """Handler must return {'video': {'type': 'Video', ...}}."""
    mock_client = _mock_client(_SUBMIT_OK, _POLL_DONE)

    with patch("handlers.grok_video.httpx.AsyncClient", return_value=mock_client), \
         patch("handlers.grok_video.asyncio.sleep", new_callable=AsyncMock), \
         patch("handlers.grok_video.get_run_dir", return_value=__import__("pathlib").Path("/tmp")):

        result = await handle_grok_video(
            _make_node(),
            {"prompt": PortValueDict(type="Text", value="test")},
            _API_KEYS,
        )

    assert "video" in result
    assert result["video"]["type"] == "Video"
