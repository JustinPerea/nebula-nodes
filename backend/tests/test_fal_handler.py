from __future__ import annotations

from unittest.mock import AsyncMock, patch, MagicMock

import pytest

from handlers.fal_universal import handle_fal_universal, _parse_fal_output
from models.graph import GraphNode, PortValueDict


def _make_node(params=None):
    return GraphNode(
        id="test-fal-1",
        definitionId="fal-universal",
        params=params or {"endpoint_id": "fal-ai/flux-pro/v1.1-ultra"},
    )


class TestParseFalOutput:
    def test_images_list(self) -> None:
        result = _parse_fal_output({"images": [{"url": "https://fal.ai/output.png", "content_type": "image/png"}]})
        assert result["image"]["type"] == "Image"
        assert "output.png" in result["image"]["value"]

    def test_single_image_dict(self) -> None:
        result = _parse_fal_output({"image": {"url": "https://fal.ai/img.jpg"}})
        assert result["image"]["type"] == "Image"

    def test_audio_url(self) -> None:
        result = _parse_fal_output({"audio_url": "https://fal.ai/audio.mp3"})
        assert result["audio"]["type"] == "Audio"

    def test_video_output(self) -> None:
        result = _parse_fal_output({"video": {"url": "https://fal.ai/vid.mp4"}})
        assert result["video"]["type"] == "Video"

    def test_text_fallback(self) -> None:
        result = _parse_fal_output({"text": "Hello from FAL"})
        assert result["text"]["type"] == "Text"

    def test_raw_json_last_resort(self) -> None:
        result = _parse_fal_output({"some_unknown_field": 42})
        assert result["text"]["type"] == "Text"
        assert "some_unknown_field" in result["text"]["value"]

    def test_mesh_model_urls_glb(self) -> None:
        """Meshy 6 pattern: model_urls dict with glb key."""
        result = _parse_fal_output({
            "model_urls": {"glb": "https://fal.ai/model.glb", "fbx": "https://fal.ai/model.fbx"}
        })
        assert result["mesh"]["type"] == "Mesh"
        assert result["mesh"]["value"] == "https://fal.ai/model.glb"

    def test_mesh_glb_dict(self) -> None:
        """Hunyuan3D pattern: glb as dict with url."""
        result = _parse_fal_output({"glb": {"url": "https://fal.ai/output.glb"}})
        assert result["mesh"]["type"] == "Mesh"
        assert result["mesh"]["value"] == "https://fal.ai/output.glb"

    def test_mesh_glb_string(self) -> None:
        """Direct glb URL string."""
        result = _parse_fal_output({"glb": "https://fal.ai/output.glb"})
        assert result["mesh"]["type"] == "Mesh"
        assert result["mesh"]["value"] == "https://fal.ai/output.glb"

    def test_mesh_model_mesh_url(self) -> None:
        """model_mesh dict pattern."""
        result = _parse_fal_output({"model_mesh": {"url": "https://fal.ai/mesh.glb"}})
        assert result["mesh"]["type"] == "Mesh"
        assert result["mesh"]["value"] == "https://fal.ai/mesh.glb"

    def test_mesh_model_glb_dict(self) -> None:
        """model_glb dict pattern (spec-mentioned field)."""
        result = _parse_fal_output({"model_glb": {"url": "https://fal.ai/output.glb"}})
        assert result["mesh"]["type"] == "Mesh"
        assert result["mesh"]["value"] == "https://fal.ai/output.glb"


@pytest.mark.asyncio
async def test_missing_api_key_raises():
    with pytest.raises(ValueError, match="FAL_KEY"):
        await handle_fal_universal(_make_node(), {}, {})


@pytest.mark.asyncio
async def test_missing_endpoint_raises():
    with pytest.raises(ValueError, match="endpoint"):
        await handle_fal_universal(
            _make_node({"endpoint_id": ""}),
            {},
            {"FAL_KEY": "fal_test"},
        )


@pytest.mark.asyncio
async def test_submit_poll_and_result():
    """Test the full submit -> poll -> fetch result flow."""
    mock_submit = MagicMock()
    mock_submit.status_code = 200
    mock_submit.json.return_value = {"request_id": "req-123"}

    mock_status = MagicMock()
    mock_status.status_code = 200
    mock_status.json.return_value = {"status": "COMPLETED"}

    mock_result = MagicMock()
    mock_result.status_code = 200
    mock_result.json.return_value = {
        "images": [{"url": "https://fal.ai/output.png", "content_type": "image/png"}]
    }

    with patch("handlers.fal_universal.httpx.AsyncClient") as MockClient:
        mock_client = AsyncMock()
        mock_client.post.return_value = mock_submit
        mock_client.get.side_effect = [mock_status, mock_result]
        mock_client.__aenter__ = AsyncMock(return_value=mock_client)
        mock_client.__aexit__ = AsyncMock(return_value=False)
        MockClient.return_value = mock_client

        with patch("handlers.fal_universal.asyncio.sleep", new_callable=AsyncMock):
            result = await handle_fal_universal(
                _make_node(),
                {"prompt": PortValueDict(type="Text", value="A mountain landscape")},
                {"FAL_KEY": "fal_test"},
                emit=AsyncMock(),
            )

    assert result["image"]["type"] == "Image"
    assert "output.png" in result["image"]["value"]


@pytest.mark.asyncio
async def test_job_failure_propagates():
    mock_submit = MagicMock()
    mock_submit.status_code = 200
    mock_submit.json.return_value = {"request_id": "req-fail"}

    mock_status = MagicMock()
    mock_status.status_code = 200
    mock_status.json.return_value = {"status": "FAILED", "error": "Model crashed"}

    with patch("handlers.fal_universal.httpx.AsyncClient") as MockClient:
        mock_client = AsyncMock()
        mock_client.post.return_value = mock_submit
        mock_client.get.return_value = mock_status
        mock_client.__aenter__ = AsyncMock(return_value=mock_client)
        mock_client.__aexit__ = AsyncMock(return_value=False)
        MockClient.return_value = mock_client

        with patch("handlers.fal_universal.asyncio.sleep", new_callable=AsyncMock):
            with pytest.raises(RuntimeError, match="Model crashed"):
                await handle_fal_universal(
                    _make_node(),
                    {"prompt": PortValueDict(type="Text", value="test")},
                    {"FAL_KEY": "fal_test"},
                    emit=AsyncMock(),
                )


@pytest.mark.asyncio
async def test_multi_image_inputs_mapped():
    """Hunyuan3D V3 Image-to-3D sends front/back/left/right images."""
    mock_submit = MagicMock()
    mock_submit.status_code = 200
    mock_submit.json.return_value = {"request_id": "req-3d"}

    mock_status = MagicMock()
    mock_status.status_code = 200
    mock_status.json.return_value = {"status": "COMPLETED"}

    mock_result = MagicMock()
    mock_result.status_code = 200
    mock_result.json.return_value = {
        "model_urls": {"glb": "https://fal.ai/model.glb"}
    }

    with patch("handlers.fal_universal.httpx.AsyncClient") as MockClient:
        mock_client = AsyncMock()
        mock_client.post.return_value = mock_submit
        mock_client.get.side_effect = [mock_status, mock_result]
        mock_client.__aenter__ = AsyncMock(return_value=mock_client)
        mock_client.__aexit__ = AsyncMock(return_value=False)
        MockClient.return_value = mock_client

        with patch("handlers.fal_universal.asyncio.sleep", new_callable=AsyncMock):
            result = await handle_fal_universal(
                _make_node({"endpoint_id": "fal-ai/hunyuan3d-v3/image-to-3d"}),
                {
                    "front_image": PortValueDict(type="Image", value="https://example.com/front.png"),
                    "back_image": PortValueDict(type="Image", value="https://example.com/back.png"),
                    "left_image": PortValueDict(type="Image", value="https://example.com/left.png"),
                    "right_image": PortValueDict(type="Image", value="https://example.com/right.png"),
                },
                {"FAL_KEY": "fal_test"},
                emit=AsyncMock(),
            )

        # Verify the submit payload included all images
        call_args = mock_client.post.call_args
        payload = call_args.kwargs.get("json") or call_args[1].get("json")
        assert payload["image_url"] == "https://example.com/front.png"
        assert payload["back_image_url"] == "https://example.com/back.png"
        assert payload["left_image_url"] == "https://example.com/left.png"
        assert payload["right_image_url"] == "https://example.com/right.png"
