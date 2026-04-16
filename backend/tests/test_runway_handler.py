from __future__ import annotations

import base64
import shutil
from pathlib import Path
from unittest.mock import AsyncMock, patch

import pytest

from handlers.runway import handle_runway_video
from models.graph import GraphNode, PortValueDict
from services.output import OUTPUT_ROOT

RED_PIXEL_B64 = (
    "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR4"
    "2mP8/5+hHgAHggJ/PchI7wAAAABJRU5ErkJggg=="
)
FAKE_VIDEO_BYTES = b"\x00\x00\x00\x20ftypisom\x00\x00\x02\x00"


def _make_node(params=None):
    return GraphNode(id="test-runway-1", definitionId="runway-video", params=params or {"model": "gen4.5", "duration": 5})


def _create_test_image(tmp_path):
    img_path = tmp_path / "test_input.png"
    img_path.write_bytes(base64.b64decode(RED_PIXEL_B64))
    return img_path


@pytest.fixture(autouse=True)
def cleanup_output():
    yield
    if OUTPUT_ROOT.exists():
        shutil.rmtree(OUTPUT_ROOT)


@pytest.mark.asyncio
async def test_submits_job_and_returns_video(tmp_path):
    img_path = _create_test_image(tmp_path)
    mock_result = {"id": "task-abc123", "status": "SUCCEEDED", "output": ["https://example.com/video.mp4"]}

    with patch("handlers.runway.async_poll_execute", new_callable=AsyncMock) as mock_poll:
        mock_poll.return_value = mock_result
        with patch("handlers.runway.save_video_from_url", new_callable=AsyncMock) as mock_save:
            video_path = tmp_path / "output.mp4"
            video_path.write_bytes(FAKE_VIDEO_BYTES)
            mock_save.return_value = video_path

            result = await handle_runway_video(
                _make_node(), {"image": PortValueDict(type="Image", value=str(img_path))},
                {"RUNWAY_API_KEY": "rw-test"}, emit=AsyncMock()
            )

    assert result["video"]["type"] == "Video"
    submit_body = mock_poll.call_args.kwargs.get("submit_body") or mock_poll.call_args[1].get("submit_body")
    assert submit_body["promptImage"].startswith("data:image/png;base64,")


@pytest.mark.asyncio
async def test_includes_text_prompt(tmp_path):
    img_path = _create_test_image(tmp_path)
    with patch("handlers.runway.async_poll_execute", new_callable=AsyncMock) as mock_poll:
        mock_poll.return_value = {"id": "t1", "status": "SUCCEEDED", "output": ["https://example.com/v.mp4"]}
        with patch("handlers.runway.save_video_from_url", new_callable=AsyncMock) as mock_save:
            mock_save.return_value = tmp_path / "v.mp4"
            (tmp_path / "v.mp4").write_bytes(FAKE_VIDEO_BYTES)
            await handle_runway_video(
                _make_node(),
                {"image": PortValueDict(type="Image", value=str(img_path)), "prompt": PortValueDict(type="Text", value="Zoom in")},
                {"RUNWAY_API_KEY": "rw-test"},
            )
    assert mock_poll.call_args.kwargs.get("submit_body", mock_poll.call_args[1].get("submit_body"))["promptText"] == "Zoom in"


@pytest.mark.asyncio
async def test_missing_image_and_prompt_raises():
    with pytest.raises(ValueError, match="[Ii]mage|prompt"):
        await handle_runway_video(_make_node(), {}, {"RUNWAY_API_KEY": "rw-test"})


@pytest.mark.asyncio
async def test_missing_api_key_raises(tmp_path):
    img_path = _create_test_image(tmp_path)
    with pytest.raises(ValueError, match="RUNWAY_API_KEY"):
        await handle_runway_video(_make_node(), {"image": PortValueDict(type="Image", value=str(img_path))}, {})


@pytest.mark.asyncio
async def test_poll_failure_propagates(tmp_path):
    img_path = _create_test_image(tmp_path)
    with patch("handlers.runway.async_poll_execute", new_callable=AsyncMock) as mock_poll:
        mock_poll.side_effect = RuntimeError("Async job failed: moderation")
        with pytest.raises(RuntimeError, match="moderation"):
            await handle_runway_video(
                _make_node(), {"image": PortValueDict(type="Image", value=str(img_path))}, {"RUNWAY_API_KEY": "rw-test"}
            )
