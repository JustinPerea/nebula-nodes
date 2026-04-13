from __future__ import annotations

from unittest.mock import AsyncMock, patch

import pytest

from handlers.replicate_universal import handle_replicate_universal, _infer_output_type
from models.graph import GraphNode, PortValueDict


def _make_node(params=None):
    return GraphNode(
        id="test-rep-1",
        definitionId="replicate-universal",
        params=params or {"model_id": "stability-ai/sdxl", "_version_id": "v123"},
    )


class TestOutputTypeInference:
    def test_image_url(self) -> None:
        result = _infer_output_type("https://example.com/output.png")
        assert result["image"]["type"] == "Image"

    def test_video_url(self) -> None:
        result = _infer_output_type("https://example.com/output.mp4")
        assert result["video"]["type"] == "Video"

    def test_audio_url(self) -> None:
        result = _infer_output_type("https://example.com/output.wav")
        assert result["audio"]["type"] == "Audio"

    def test_plain_text(self) -> None:
        result = _infer_output_type("Hello world")
        assert result["text"]["type"] == "Text"

    def test_url_list(self) -> None:
        result = _infer_output_type(["https://example.com/a.png", "https://example.com/b.png"])
        assert result["image"]["type"] == "Image"

    def test_generic_url_defaults_to_image(self) -> None:
        result = _infer_output_type("https://example.com/some-output")
        assert result["image"]["type"] == "Image"


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


@pytest.mark.asyncio
async def test_submit_and_poll_returns_image():
    with patch("handlers.replicate_universal.async_poll_execute", new_callable=AsyncMock) as mock_poll:
        mock_poll.return_value = {
            "id": "pred-123",
            "status": "succeeded",
            "output": ["https://replicate.delivery/output.png"],
        }

        result = await handle_replicate_universal(
            _make_node(),
            {"prompt": PortValueDict(type="Text", value="A sunset")},
            {"REPLICATE_API_TOKEN": "r8_test"},
            emit=AsyncMock(),
        )

    assert result["image"]["type"] == "Image"
    assert "output.png" in result["image"]["value"]


@pytest.mark.asyncio
async def test_text_model_returns_text():
    with patch("handlers.replicate_universal.async_poll_execute", new_callable=AsyncMock) as mock_poll:
        mock_poll.return_value = {
            "id": "pred-456",
            "status": "succeeded",
            "output": "Once upon a time...",
        }

        result = await handle_replicate_universal(
            _make_node({"model_id": "meta/llama-2-70b", "_version_id": "v789"}),
            {"prompt": PortValueDict(type="Text", value="Tell me a story")},
            {"REPLICATE_API_TOKEN": "r8_test"},
            emit=AsyncMock(),
        )

    assert result["text"]["type"] == "Text"
    assert "Once upon" in result["text"]["value"]


@pytest.mark.asyncio
async def test_resolves_version_when_not_cached():
    """When _version_id is empty, handler should fetch it from Replicate API."""
    with patch("handlers.replicate_universal._resolve_version", new_callable=AsyncMock) as mock_resolve:
        mock_resolve.return_value = "resolved-v1"
        with patch("handlers.replicate_universal.async_poll_execute", new_callable=AsyncMock) as mock_poll:
            mock_poll.return_value = {"status": "succeeded", "output": "done"}

            result = await handle_replicate_universal(
                _make_node({"model_id": "owner/model", "_version_id": ""}),
                {"prompt": PortValueDict(type="Text", value="test")},
                {"REPLICATE_API_TOKEN": "r8_test"},
                emit=AsyncMock(),
            )

    mock_resolve.assert_called_once_with("owner", "model", "r8_test")
