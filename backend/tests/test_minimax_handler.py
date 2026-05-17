from __future__ import annotations

from unittest.mock import AsyncMock, MagicMock, patch

import pytest

from handlers.minimax import handle_minimax_video, MINIMAX_API_BASE
from models.graph import GraphNode, PortValueDict


def _make_node(definition_id: str, params: dict | None = None) -> GraphNode:
    return GraphNode(
        id=f"{definition_id}-test",
        definitionId=definition_id,
        params=params or {},
    )


def _mock_client(submit_json: dict, poll_json: dict, retrieve_json: dict) -> AsyncMock:
    """Return a mock AsyncClient pre-wired with three responses."""
    submit_resp = MagicMock()
    submit_resp.status_code = 200
    submit_resp.json.return_value = submit_json

    poll_resp = MagicMock()
    poll_resp.status_code = 200
    poll_resp.json.return_value = poll_json

    retrieve_resp = MagicMock()
    retrieve_resp.status_code = 200
    retrieve_resp.json.return_value = retrieve_json

    mock_client = AsyncMock()
    mock_client.post.return_value = submit_resp
    mock_client.get.side_effect = [poll_resp, retrieve_resp]
    mock_client.__aenter__ = AsyncMock(return_value=mock_client)
    mock_client.__aexit__ = AsyncMock(return_value=False)
    return mock_client


_SUBMIT_OK = {"task_id": "task-abc"}
_POLL_SUCCESS = {"status": "Success", "file_id": "file-xyz"}
_RETRIEVE_OK = {"file": {"download_url": "https://cdn.minimax.io/video.mp4"}}
_API_KEYS = {"MINIMAX_API_KEY": "mm-test-key"}


# ---------------------------------------------------------------------------
# T2V
# ---------------------------------------------------------------------------


@pytest.mark.asyncio
async def test_t2v_request_body_shape() -> None:
    """T2V sends model, prompt, duration, resolution — no image fields."""
    mock_client = _mock_client(_SUBMIT_OK, _POLL_SUCCESS, _RETRIEVE_OK)

    with patch("handlers.minimax.httpx.AsyncClient", return_value=mock_client), \
         patch("handlers.minimax.asyncio.sleep", new_callable=AsyncMock), \
         patch("handlers.minimax.save_video_from_url", new_callable=AsyncMock, return_value="/tmp/video.mp4"), \
         patch("handlers.minimax.get_run_dir", return_value="/tmp"):

        result = await handle_minimax_video(
            _make_node("minimax-t2v", {"model": "MiniMax-Hailuo-2.3", "duration": 6, "resolution": "768P"}),
            {"prompt": PortValueDict(type="Text", value="a cat walks through snow")},
            _API_KEYS,
        )

    body = mock_client.post.call_args.kwargs["json"]
    assert body["model"] == "MiniMax-Hailuo-2.3"
    assert body["prompt"] == "a cat walks through snow"
    assert body["duration"] == 6
    assert body["resolution"] == "768P"
    assert "first_frame_image" not in body
    assert "subject_reference" not in body
    assert "last_frame_image" not in body
    assert result["video"]["type"] == "Video"


@pytest.mark.asyncio
async def test_t2v_uses_correct_base_url() -> None:
    """Handler must POST to api.minimaxi.com, not api.minimaxi.chat."""
    mock_client = _mock_client(_SUBMIT_OK, _POLL_SUCCESS, _RETRIEVE_OK)

    with patch("handlers.minimax.httpx.AsyncClient", return_value=mock_client), \
         patch("handlers.minimax.asyncio.sleep", new_callable=AsyncMock), \
         patch("handlers.minimax.save_video_from_url", new_callable=AsyncMock, return_value="/tmp/video.mp4"), \
         patch("handlers.minimax.get_run_dir", return_value="/tmp"):

        await handle_minimax_video(
            _make_node("minimax-t2v", {"model": "MiniMax-Hailuo-2.3", "duration": 6, "resolution": "768P"}),
            {"prompt": PortValueDict(type="Text", value="time-lapse of a city")},
            _API_KEYS,
        )

    url = mock_client.post.call_args.args[0]
    assert "minimaxi.com" in url, f"Expected api.minimaxi.com, got: {url}"
    assert "minimaxi.chat" not in url, "Handler must not use deprecated minimaxi.chat domain"
    assert MINIMAX_API_BASE == "https://api.minimaxi.com"


@pytest.mark.asyncio
async def test_t2v_missing_api_key_raises() -> None:
    with pytest.raises(ValueError, match="MINIMAX_API_KEY"):
        await handle_minimax_video(
            _make_node("minimax-t2v"),
            {"prompt": PortValueDict(type="Text", value="some prompt")},
            {},
        )


@pytest.mark.asyncio
async def test_t2v_missing_prompt_raises() -> None:
    mock_client = _mock_client(_SUBMIT_OK, _POLL_SUCCESS, _RETRIEVE_OK)

    with patch("handlers.minimax.httpx.AsyncClient", return_value=mock_client):
        with pytest.raises(ValueError, match="Prompt"):
            await handle_minimax_video(
                _make_node("minimax-t2v"),
                {},
                _API_KEYS,
            )


# ---------------------------------------------------------------------------
# I2V
# ---------------------------------------------------------------------------


@pytest.mark.asyncio
async def test_i2v_request_body_shape() -> None:
    """I2V sends first_frame_image, no subject_reference, no last_frame_image."""
    mock_client = _mock_client(_SUBMIT_OK, _POLL_SUCCESS, _RETRIEVE_OK)

    with patch("handlers.minimax.httpx.AsyncClient", return_value=mock_client), \
         patch("handlers.minimax.asyncio.sleep", new_callable=AsyncMock), \
         patch("handlers.minimax.save_video_from_url", new_callable=AsyncMock, return_value="/tmp/video.mp4"), \
         patch("handlers.minimax.get_run_dir", return_value="/tmp"), \
         patch("handlers.minimax._resolve_image_url", return_value="https://cdn.test/frame.jpg"):

        result = await handle_minimax_video(
            _make_node("minimax-i2v", {"model": "MiniMax-Hailuo-2.3", "duration": 6, "resolution": "768P"}),
            {
                "first_frame_image": PortValueDict(type="Image", value="https://cdn.test/frame.jpg"),
                "prompt": PortValueDict(type="Text", value="the character waves"),
            },
            _API_KEYS,
        )

    body = mock_client.post.call_args.kwargs["json"]
    assert body["model"] == "MiniMax-Hailuo-2.3"
    assert body["first_frame_image"] == "https://cdn.test/frame.jpg"
    assert body["prompt"] == "the character waves"
    assert body["duration"] == 6
    assert body["resolution"] == "768P"
    assert "subject_reference" not in body
    assert "last_frame_image" not in body
    assert result["video"]["type"] == "Video"


@pytest.mark.asyncio
async def test_i2v_port_id_first_frame_image_is_used() -> None:
    """Confirm handler reads the 'first_frame_image' port id, not the old 'image' id."""
    mock_client = _mock_client(_SUBMIT_OK, _POLL_SUCCESS, _RETRIEVE_OK)

    with patch("handlers.minimax.httpx.AsyncClient", return_value=mock_client), \
         patch("handlers.minimax.asyncio.sleep", new_callable=AsyncMock), \
         patch("handlers.minimax.save_video_from_url", new_callable=AsyncMock, return_value="/tmp/video.mp4"), \
         patch("handlers.minimax.get_run_dir", return_value="/tmp"), \
         patch("handlers.minimax._resolve_image_url", return_value="https://cdn.test/frame.jpg"):

        await handle_minimax_video(
            _make_node("minimax-i2v", {"model": "MiniMax-Hailuo-2.3", "duration": 6, "resolution": "768P"}),
            {
                # Only provide the correctly-named port — old 'image' port absent
                "first_frame_image": PortValueDict(type="Image", value="https://cdn.test/frame.jpg"),
                "prompt": PortValueDict(type="Text", value="zoom in"),
            },
            _API_KEYS,
        )

    body = mock_client.post.call_args.kwargs["json"]
    # If the wrong port id were used, model would fall back to T2V and omit first_frame_image
    assert "first_frame_image" in body, "I2V must include first_frame_image in request body"


# ---------------------------------------------------------------------------
# S2V
# ---------------------------------------------------------------------------


@pytest.mark.asyncio
async def test_s2v_request_body_shape() -> None:
    """S2V sends subject_reference array with type/image, no duration/resolution."""
    mock_client = _mock_client(_SUBMIT_OK, _POLL_SUCCESS, _RETRIEVE_OK)

    with patch("handlers.minimax.httpx.AsyncClient", return_value=mock_client), \
         patch("handlers.minimax.asyncio.sleep", new_callable=AsyncMock), \
         patch("handlers.minimax.save_video_from_url", new_callable=AsyncMock, return_value="/tmp/video.mp4"), \
         patch("handlers.minimax.get_run_dir", return_value="/tmp"), \
         patch("handlers.minimax._resolve_image_url", return_value="https://cdn.test/subject.jpg"):

        result = await handle_minimax_video(
            _make_node("minimax-s2v", {"model": "S2V-01"}),
            {
                "subject_reference": PortValueDict(type="Image", value="https://cdn.test/subject.jpg"),
                "prompt": PortValueDict(type="Text", value="she waves at the camera"),
            },
            _API_KEYS,
        )

    body = mock_client.post.call_args.kwargs["json"]
    assert body["model"] == "S2V-01"
    assert body["prompt"] == "she waves at the camera"
    # subject_reference must be array of {type, image:[url]}
    assert isinstance(body["subject_reference"], list)
    assert len(body["subject_reference"]) == 1
    sr = body["subject_reference"][0]
    assert sr["type"] == "character"
    assert isinstance(sr["image"], list)
    assert sr["image"][0] == "https://cdn.test/subject.jpg"
    # S2V API does not accept duration or resolution
    assert "duration" not in body
    assert "resolution" not in body
    assert "first_frame_image" not in body
    assert result["video"]["type"] == "Video"


@pytest.mark.asyncio
async def test_s2v_port_id_subject_reference_is_used() -> None:
    """Confirm handler reads 'subject_reference' port id, not the old 'image' id."""
    mock_client = _mock_client(_SUBMIT_OK, _POLL_SUCCESS, _RETRIEVE_OK)

    with patch("handlers.minimax.httpx.AsyncClient", return_value=mock_client), \
         patch("handlers.minimax.asyncio.sleep", new_callable=AsyncMock), \
         patch("handlers.minimax.save_video_from_url", new_callable=AsyncMock, return_value="/tmp/video.mp4"), \
         patch("handlers.minimax.get_run_dir", return_value="/tmp"), \
         patch("handlers.minimax._resolve_image_url", return_value="https://cdn.test/subject.jpg"):

        await handle_minimax_video(
            _make_node("minimax-s2v", {"model": "S2V-01"}),
            {
                "subject_reference": PortValueDict(type="Image", value="https://cdn.test/subject.jpg"),
                "prompt": PortValueDict(type="Text", value="dance"),
            },
            _API_KEYS,
        )

    body = mock_client.post.call_args.kwargs["json"]
    assert "subject_reference" in body, "S2V must include subject_reference in request body"


# ---------------------------------------------------------------------------
# Poll / output
# ---------------------------------------------------------------------------


@pytest.mark.asyncio
async def test_output_returns_video_type() -> None:
    """Handler must return {'video': {'type': 'Video', 'value': ...}}."""
    mock_client = _mock_client(_SUBMIT_OK, _POLL_SUCCESS, _RETRIEVE_OK)

    with patch("handlers.minimax.httpx.AsyncClient", return_value=mock_client), \
         patch("handlers.minimax.asyncio.sleep", new_callable=AsyncMock), \
         patch("handlers.minimax.save_video_from_url", new_callable=AsyncMock, return_value="/tmp/out.mp4"), \
         patch("handlers.minimax.get_run_dir", return_value="/tmp"):

        result = await handle_minimax_video(
            _make_node("minimax-t2v", {"model": "MiniMax-Hailuo-2.3", "duration": 6, "resolution": "768P"}),
            {"prompt": PortValueDict(type="Text", value="sunrise over mountains")},
            _API_KEYS,
        )

    assert result == {"video": {"type": "Video", "value": "/tmp/out.mp4"}}


@pytest.mark.asyncio
async def test_poll_fail_status_raises() -> None:
    """A 'Fail' poll status must raise RuntimeError."""
    poll_fail = {"status": "Fail", "message": "content policy violation"}
    mock_client = _mock_client(_SUBMIT_OK, poll_fail, _RETRIEVE_OK)

    with patch("handlers.minimax.httpx.AsyncClient", return_value=mock_client), \
         patch("handlers.minimax.asyncio.sleep", new_callable=AsyncMock):

        with pytest.raises(RuntimeError, match="MiniMax task failed"):
            await handle_minimax_video(
                _make_node("minimax-t2v", {"model": "MiniMax-Hailuo-2.3", "duration": 6, "resolution": "768P"}),
                {"prompt": PortValueDict(type="Text", value="test")},
                _API_KEYS,
            )


@pytest.mark.asyncio
async def test_i2v_missing_prompt_raises() -> None:
    """I2V handler must raise ValueError when prompt input is absent."""
    mock_client = _mock_client(_SUBMIT_OK, _POLL_SUCCESS, _RETRIEVE_OK)

    with patch("handlers.minimax.httpx.AsyncClient", return_value=mock_client), \
         patch("handlers.minimax._resolve_image_url", return_value="https://cdn.test/frame.jpg"):

        with pytest.raises(ValueError, match="(?i)MINIMAX|Prompt"):
            await handle_minimax_video(
                _make_node("minimax-i2v", {"model": "MiniMax-Hailuo-2.3", "duration": 6, "resolution": "768P"}),
                {"first_frame_image": PortValueDict(type="Image", value="https://cdn.test/frame.jpg")},
                _API_KEYS,
            )


@pytest.mark.asyncio
async def test_t2v_poll_times_out_after_max_polls() -> None:
    """Polling loop must raise RuntimeError with 'timed out' after max_polls exhausted."""
    max_polls = 300
    queueing_resp = MagicMock()
    queueing_resp.status_code = 200
    queueing_resp.json.return_value = {"status": "Queueing"}

    submit_resp = MagicMock()
    submit_resp.status_code = 200
    submit_resp.json.return_value = _SUBMIT_OK

    mock_client = AsyncMock()
    mock_client.post.return_value = submit_resp
    mock_client.get.side_effect = [queueing_resp] * (max_polls + 1)
    mock_client.__aenter__ = AsyncMock(return_value=mock_client)
    mock_client.__aexit__ = AsyncMock(return_value=False)

    with patch("handlers.minimax.httpx.AsyncClient", return_value=mock_client), \
         patch("handlers.minimax.asyncio.sleep", new_callable=AsyncMock):

        with pytest.raises(RuntimeError, match="timed out"):
            await handle_minimax_video(
                _make_node("minimax-t2v", {"model": "MiniMax-Hailuo-2.3", "duration": 6, "resolution": "768P"}),
                {"prompt": PortValueDict(type="Text", value="a stormy sea")},
                _API_KEYS,
            )
