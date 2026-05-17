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
        assert payload["input_image_url"] == "https://example.com/front.png"
        assert payload["back_image_url"] == "https://example.com/back.png"
        assert payload["left_image_url"] == "https://example.com/left.png"
        assert payload["right_image_url"] == "https://example.com/right.png"


# ---------------------------------------------------------------------------
# New tests: coverage gaps identified in the infrastructure audit 2026-05-17
# ---------------------------------------------------------------------------


class TestParseFalOutputSVG:
    def test_svg_content_type_returns_svg_port(self) -> None:
        """Recraft V4 text-to-vector returns images[0] with content_type image/svg+xml.
        Must return SVG port, not Image port."""
        result = _parse_fal_output({
            "images": [{"url": "https://fal.ai/output.svg", "content_type": "image/svg+xml"}]
        })
        assert result["svg"]["type"] == "SVG"
        assert result["svg"]["value"] == "https://fal.ai/output.svg"
        assert "image" not in result

    def test_png_content_type_returns_image_port(self) -> None:
        """Images with image/png content_type must still return Image port."""
        result = _parse_fal_output({
            "images": [{"url": "https://fal.ai/output.png", "content_type": "image/png"}]
        })
        assert result["image"]["type"] == "Image"
        assert "svg" not in result

    def test_no_content_type_returns_image_port(self) -> None:
        """Images without content_type (most endpoints) must return Image port."""
        result = _parse_fal_output({
            "images": [{"url": "https://fal.ai/output.jpg"}]
        })
        assert result["image"]["type"] == "Image"
        assert "svg" not in result

    def test_uppercase_svg_content_type_returns_svg_port(self) -> None:
        """Uppercase MIME types like IMAGE/SVG+XML must still route to SVG port."""
        result = _parse_fal_output({
            "images": [{"url": "https://fal.ai/output.svg", "content_type": "IMAGE/SVG+XML"}]
        })
        assert result["svg"]["type"] == "SVG"
        assert result["svg"]["value"] == "https://fal.ai/output.svg"
        assert "image" not in result


@pytest.mark.asyncio
async def test_endpoint_id_injection_wrapper_node():
    """Wrapper nodes inject endpoint_id via setdefault before calling handle_fal_universal.
    Verify the handler reads it correctly and submits to the right URL."""
    mock_submit = MagicMock()
    mock_submit.status_code = 200
    mock_submit.json.return_value = {"request_id": "req-wrap"}

    mock_status = MagicMock()
    mock_status.status_code = 200
    mock_status.json.return_value = {"status": "COMPLETED"}

    mock_result = MagicMock()
    mock_result.status_code = 200
    mock_result.json.return_value = {
        "images": [{"url": "https://fal.ai/flux-result.png", "content_type": "image/png"}]
    }

    # Simulate _flux_ultra_handler: setdefault injects endpoint_id then calls handler
    node = GraphNode(
        id="test-flux-wrapper",
        definitionId="flux-1-1-ultra",
        params={},  # no endpoint_id yet, like freshly-deserialized wrapper node
    )
    node.params.setdefault("endpoint_id", "fal-ai/flux-pro/v1.1-ultra")

    with patch("handlers.fal_universal.httpx.AsyncClient") as MockClient:
        mock_client = AsyncMock()
        mock_client.post.return_value = mock_submit
        mock_client.get.side_effect = [mock_status, mock_result]
        mock_client.__aenter__ = AsyncMock(return_value=mock_client)
        mock_client.__aexit__ = AsyncMock(return_value=False)
        MockClient.return_value = mock_client

        with patch("handlers.fal_universal.asyncio.sleep", new_callable=AsyncMock):
            result = await handle_fal_universal(
                node,
                {"prompt": PortValueDict(type="Text", value="test prompt")},
                {"FAL_KEY": "fal_test"},
                emit=AsyncMock(),
            )

    assert result["image"]["type"] == "Image"
    # Confirm the POST URL used the injected endpoint_id
    call_args = mock_client.post.call_args
    posted_url = call_args.args[0] if call_args.args else call_args.kwargs.get("url", "")
    assert "fal-ai/flux-pro/v1.1-ultra" in posted_url


@pytest.mark.asyncio
async def test_empty_optional_params_omitted_from_request():
    """Params with empty-string values must NOT be sent to FAL.
    Sending empty strings for optional params causes API validation errors."""
    mock_submit = MagicMock()
    mock_submit.status_code = 200
    mock_submit.json.return_value = {"request_id": "req-empty"}

    mock_status = MagicMock()
    mock_status.status_code = 200
    mock_status.json.return_value = {"status": "COMPLETED"}

    mock_result = MagicMock()
    mock_result.status_code = 200
    mock_result.json.return_value = {
        "images": [{"url": "https://fal.ai/result.png"}]
    }

    node = _make_node({
        "endpoint_id": "fal-ai/flux-pro/v1.1-ultra",
        "negative_prompt": "",       # empty — must be omitted
        "seed": None,                # None — must be omitted
        "num_images": 1,             # has value — must be sent
    })

    with patch("handlers.fal_universal.httpx.AsyncClient") as MockClient:
        mock_client = AsyncMock()
        mock_client.post.return_value = mock_submit
        mock_client.get.side_effect = [mock_status, mock_result]
        mock_client.__aenter__ = AsyncMock(return_value=mock_client)
        mock_client.__aexit__ = AsyncMock(return_value=False)
        MockClient.return_value = mock_client

        with patch("handlers.fal_universal.asyncio.sleep", new_callable=AsyncMock):
            await handle_fal_universal(
                node,
                {"prompt": PortValueDict(type="Text", value="test")},
                {"FAL_KEY": "fal_test"},
                emit=AsyncMock(),
            )

    call_args = mock_client.post.call_args
    payload = call_args.kwargs.get("json") or call_args[1].get("json")
    assert "negative_prompt" not in payload, "empty string param must be omitted"
    assert "seed" not in payload, "None param must be omitted"
    assert payload.get("num_images") == 1, "non-empty param must be sent"


@pytest.mark.asyncio
async def test_images_multi_port_sends_image_urls():
    """Nodes with a multi-image 'images' port (gpt-image-1-5-edit, seedance-2-r2v)
    must map to image_urls list in the FAL request body."""
    mock_submit = MagicMock()
    mock_submit.status_code = 200
    mock_submit.json.return_value = {"request_id": "req-multi"}

    mock_status = MagicMock()
    mock_status.status_code = 200
    mock_status.json.return_value = {"status": "COMPLETED"}

    mock_result = MagicMock()
    mock_result.status_code = 200
    mock_result.json.return_value = {
        "images": [{"url": "https://fal.ai/edited.png", "content_type": "image/png"}]
    }

    node = _make_node({"endpoint_id": "fal-ai/gpt-image-1.5/edit"})

    with patch("handlers.fal_universal.httpx.AsyncClient") as MockClient:
        mock_client = AsyncMock()
        mock_client.post.return_value = mock_submit
        mock_client.get.side_effect = [mock_status, mock_result]
        mock_client.__aenter__ = AsyncMock(return_value=mock_client)
        mock_client.__aexit__ = AsyncMock(return_value=False)
        MockClient.return_value = mock_client

        with patch("handlers.fal_universal.asyncio.sleep", new_callable=AsyncMock):
            result = await handle_fal_universal(
                node,
                {
                    "prompt": PortValueDict(type="Text", value="make it blue"),
                    "images": PortValueDict(type="Image", value=[
                        "https://example.com/a.png",
                        "https://example.com/b.png",
                    ]),
                },
                {"FAL_KEY": "fal_test"},
                emit=AsyncMock(),
            )

    assert result["image"]["type"] == "Image"
    call_args = mock_client.post.call_args
    payload = call_args.kwargs.get("json") or call_args[1].get("json")
    assert payload["image_urls"] == [
        "https://example.com/a.png",
        "https://example.com/b.png",
    ]
    assert "image_url" not in payload  # singular form must not appear


@pytest.mark.asyncio
async def test_gpt_image_1_5_edit_missing_image_raises_value_error():
    """gpt-image-1.5/edit requires at least one reference image."""
    node = _make_node({"endpoint_id": "fal-ai/gpt-image-1.5/edit"})

    with pytest.raises(ValueError, match="image"):
        await handle_fal_universal(
            node,
            {"prompt": PortValueDict(type="Text", value="make it blue")},
            {"FAL_KEY": "fal_test"},
            emit=AsyncMock(),
        )


@pytest.mark.asyncio
async def test_video_input_port_sends_video_url():
    """luma-ray2-flash-modify has a video input port that must map to video_url."""
    mock_submit = MagicMock()
    mock_submit.status_code = 200
    mock_submit.json.return_value = {"request_id": "req-video-in"}

    mock_status = MagicMock()
    mock_status.status_code = 200
    mock_status.json.return_value = {"status": "COMPLETED"}

    mock_result = MagicMock()
    mock_result.status_code = 200
    mock_result.json.return_value = {
        "video": {"url": "https://fal.ai/modified.mp4"}
    }

    node = _make_node({"endpoint_id": "fal-ai/luma-dream-machine/ray-2-flash/modify"})

    with patch("handlers.fal_universal.httpx.AsyncClient") as MockClient:
        mock_client = AsyncMock()
        mock_client.post.return_value = mock_submit
        mock_client.get.side_effect = [mock_status, mock_result]
        mock_client.__aenter__ = AsyncMock(return_value=mock_client)
        mock_client.__aexit__ = AsyncMock(return_value=False)
        MockClient.return_value = mock_client

        with patch("handlers.fal_universal.asyncio.sleep", new_callable=AsyncMock):
            result = await handle_fal_universal(
                node,
                {
                    "prompt": PortValueDict(type="Text", value="make it cinematic"),
                    "video": PortValueDict(type="Video", value="https://example.com/clip.mp4"),
                },
                {"FAL_KEY": "fal_test"},
                emit=AsyncMock(),
            )

    assert result["video"]["type"] == "Video"
    call_args = mock_client.post.call_args
    payload = call_args.kwargs.get("json") or call_args[1].get("json")
    assert payload["video_url"] == "https://example.com/clip.mp4"


@pytest.mark.asyncio
async def test_audio_input_port_sends_audio_url():
    """ltx-2-3 has an audio input port that must map to audio_url."""
    mock_submit = MagicMock()
    mock_submit.status_code = 200
    mock_submit.json.return_value = {"request_id": "req-audio-in"}

    mock_status = MagicMock()
    mock_status.status_code = 200
    mock_status.json.return_value = {"status": "COMPLETED"}

    mock_result = MagicMock()
    mock_result.status_code = 200
    mock_result.json.return_value = {
        "video": {"url": "https://fal.ai/ltx-output.mp4"}
    }

    node = _make_node({"endpoint_id": "fal-ai/ltx-2.3/image-to-video"})

    with patch("handlers.fal_universal.httpx.AsyncClient") as MockClient:
        mock_client = AsyncMock()
        mock_client.post.return_value = mock_submit
        mock_client.get.side_effect = [mock_status, mock_result]
        mock_client.__aenter__ = AsyncMock(return_value=mock_client)
        mock_client.__aexit__ = AsyncMock(return_value=False)
        MockClient.return_value = mock_client

        with patch("handlers.fal_universal.asyncio.sleep", new_callable=AsyncMock):
            result = await handle_fal_universal(
                node,
                {
                    "prompt": PortValueDict(type="Text", value="animate"),
                    "audio": PortValueDict(type="Audio", value="https://example.com/track.mp3"),
                },
                {"FAL_KEY": "fal_test"},
                emit=AsyncMock(),
            )

    assert result["video"]["type"] == "Video"
    call_args = mock_client.post.call_args
    payload = call_args.kwargs.get("json") or call_args[1].get("json")
    assert payload["audio_url"] == "https://example.com/track.mp3"


# ---------------------------------------------------------------------------
# Kling wrapper structural tests (audit 2026-05-17)
# ---------------------------------------------------------------------------


def _make_video_poll_mocks():
    """Return (mock_submit, mock_status, mock_result) for a standard video job."""
    mock_submit = MagicMock()
    mock_submit.status_code = 200
    mock_submit.json.return_value = {"request_id": "req-kling"}

    mock_status = MagicMock()
    mock_status.status_code = 200
    mock_status.json.return_value = {"status": "COMPLETED"}

    mock_result = MagicMock()
    mock_result.status_code = 200
    mock_result.json.return_value = {"video": {"url": "https://fal.ai/kling-out.mp4"}}

    return mock_submit, mock_status, mock_result


# --- kling-v2-1 ---

@pytest.mark.asyncio
async def test_kling_v2_1_endpoint_injected():
    """_kling_handler injects fal-ai/kling-video/v2.1/pro/image-to-video."""
    mock_submit, mock_status, mock_result = _make_video_poll_mocks()

    node = GraphNode(id="kv2", definitionId="kling-v2-1", params={})
    node.params.setdefault("endpoint_id", "fal-ai/kling-video/v2.1/pro/image-to-video")

    with patch("handlers.fal_universal.httpx.AsyncClient") as MockClient:
        mock_client = AsyncMock()
        mock_client.post.return_value = mock_submit
        mock_client.get.side_effect = [mock_status, mock_result]
        mock_client.__aenter__ = AsyncMock(return_value=mock_client)
        mock_client.__aexit__ = AsyncMock(return_value=False)
        MockClient.return_value = mock_client

        with patch("handlers.fal_universal.asyncio.sleep", new_callable=AsyncMock):
            result = await handle_fal_universal(
                node,
                {"image": PortValueDict(type="Image", value="https://example.com/frame.png")},
                {"FAL_KEY": "fal_test"},
                emit=AsyncMock(),
            )

    assert result["video"]["type"] == "Video"
    call_args = mock_client.post.call_args
    posted_url = call_args.args[0] if call_args.args else call_args.kwargs.get("url", "")
    assert "kling-video/v2.1/pro/image-to-video" in posted_url


@pytest.mark.asyncio
async def test_kling_v2_1_image_maps_to_image_url():
    """kling-v2-1 image port must map to image_url in FAL request body."""
    mock_submit, mock_status, mock_result = _make_video_poll_mocks()

    node = GraphNode(
        id="kv2-img",
        definitionId="kling-v2-1",
        params={"endpoint_id": "fal-ai/kling-video/v2.1/pro/image-to-video", "duration": "5"},
    )

    with patch("handlers.fal_universal.httpx.AsyncClient") as MockClient:
        mock_client = AsyncMock()
        mock_client.post.return_value = mock_submit
        mock_client.get.side_effect = [mock_status, mock_result]
        mock_client.__aenter__ = AsyncMock(return_value=mock_client)
        mock_client.__aexit__ = AsyncMock(return_value=False)
        MockClient.return_value = mock_client

        with patch("handlers.fal_universal.asyncio.sleep", new_callable=AsyncMock):
            await handle_fal_universal(
                node,
                {
                    "image": PortValueDict(type="Image", value="https://example.com/start.png"),
                    "prompt": PortValueDict(type="Text", value="cinematic motion"),
                },
                {"FAL_KEY": "fal_test"},
                emit=AsyncMock(),
            )

    payload = mock_client.post.call_args.kwargs.get("json") or mock_client.post.call_args[1].get("json")
    assert payload["image_url"] == "https://example.com/start.png"
    assert payload["duration"] == "5"
    assert "aspect_ratio" not in payload  # not a v2.1 param


@pytest.mark.asyncio
async def test_kling_v2_1_tail_image_maps_to_tail_image_url():
    """kling-v2-1 tail_image port (end frame) must map to tail_image_url."""
    mock_submit, mock_status, mock_result = _make_video_poll_mocks()

    node = GraphNode(
        id="kv2-tail",
        definitionId="kling-v2-1",
        params={"endpoint_id": "fal-ai/kling-video/v2.1/pro/image-to-video"},
    )

    with patch("handlers.fal_universal.httpx.AsyncClient") as MockClient:
        mock_client = AsyncMock()
        mock_client.post.return_value = mock_submit
        mock_client.get.side_effect = [mock_status, mock_result]
        mock_client.__aenter__ = AsyncMock(return_value=mock_client)
        mock_client.__aexit__ = AsyncMock(return_value=False)
        MockClient.return_value = mock_client

        with patch("handlers.fal_universal.asyncio.sleep", new_callable=AsyncMock):
            await handle_fal_universal(
                node,
                {
                    "image": PortValueDict(type="Image", value="https://example.com/start.png"),
                    "tail_image": PortValueDict(type="Image", value="https://example.com/end.png"),
                },
                {"FAL_KEY": "fal_test"},
                emit=AsyncMock(),
            )

    payload = mock_client.post.call_args.kwargs.get("json") or mock_client.post.call_args[1].get("json")
    assert payload["tail_image_url"] == "https://example.com/end.png"
    assert payload["image_url"] == "https://example.com/start.png"


# --- kling-v3 ---

@pytest.mark.asyncio
async def test_kling_v3_endpoint_injected():
    """_kling_v3_handler injects fal-ai/kling-video/v3/standard/text-to-video."""
    mock_submit, mock_status, mock_result = _make_video_poll_mocks()

    node = GraphNode(id="kv3", definitionId="kling-v3", params={})
    node.params.setdefault("endpoint_id", "fal-ai/kling-video/v3/standard/text-to-video")

    with patch("handlers.fal_universal.httpx.AsyncClient") as MockClient:
        mock_client = AsyncMock()
        mock_client.post.return_value = mock_submit
        mock_client.get.side_effect = [mock_status, mock_result]
        mock_client.__aenter__ = AsyncMock(return_value=mock_client)
        mock_client.__aexit__ = AsyncMock(return_value=False)
        MockClient.return_value = mock_client

        with patch("handlers.fal_universal.asyncio.sleep", new_callable=AsyncMock):
            result = await handle_fal_universal(
                node,
                {"prompt": PortValueDict(type="Text", value="a cinematic shot")},
                {"FAL_KEY": "fal_test"},
                emit=AsyncMock(),
            )

    assert result["video"]["type"] == "Video"
    posted_url = mock_client.post.call_args.args[0] if mock_client.post.call_args.args else mock_client.post.call_args.kwargs.get("url", "")
    assert "kling-video/v3/standard/text-to-video" in posted_url


@pytest.mark.asyncio
async def test_kling_v3_aspect_ratio_and_duration_forwarded():
    """kling-v3 aspect_ratio and duration params are forwarded correctly."""
    mock_submit, mock_status, mock_result = _make_video_poll_mocks()

    node = GraphNode(
        id="kv3-params",
        definitionId="kling-v3",
        params={
            "endpoint_id": "fal-ai/kling-video/v3/standard/text-to-video",
            "aspect_ratio": "9:16",
            "duration": "10",
            "generate_audio": True,
        },
    )

    with patch("handlers.fal_universal.httpx.AsyncClient") as MockClient:
        mock_client = AsyncMock()
        mock_client.post.return_value = mock_submit
        mock_client.get.side_effect = [mock_status, mock_result]
        mock_client.__aenter__ = AsyncMock(return_value=mock_client)
        mock_client.__aexit__ = AsyncMock(return_value=False)
        MockClient.return_value = mock_client

        with patch("handlers.fal_universal.asyncio.sleep", new_callable=AsyncMock):
            await handle_fal_universal(
                node,
                {"prompt": PortValueDict(type="Text", value="sunset")},
                {"FAL_KEY": "fal_test"},
                emit=AsyncMock(),
            )

    payload = mock_client.post.call_args.kwargs.get("json") or mock_client.post.call_args[1].get("json")
    assert payload["aspect_ratio"] == "9:16"
    assert payload["duration"] == "10"
    assert payload["generate_audio"] is True
    assert "resolution" not in payload  # resolution is not a v3 param


@pytest.mark.asyncio
async def test_kling_v3_start_image_maps_to_image_url():
    """kling-v3 start image port maps to image_url."""
    mock_submit, mock_status, mock_result = _make_video_poll_mocks()

    node = GraphNode(
        id="kv3-img",
        definitionId="kling-v3",
        params={"endpoint_id": "fal-ai/kling-video/v3/standard/text-to-video"},
    )

    with patch("handlers.fal_universal.httpx.AsyncClient") as MockClient:
        mock_client = AsyncMock()
        mock_client.post.return_value = mock_submit
        mock_client.get.side_effect = [mock_status, mock_result]
        mock_client.__aenter__ = AsyncMock(return_value=mock_client)
        mock_client.__aexit__ = AsyncMock(return_value=False)
        MockClient.return_value = mock_client

        with patch("handlers.fal_universal.asyncio.sleep", new_callable=AsyncMock):
            await handle_fal_universal(
                node,
                {
                    "prompt": PortValueDict(type="Text", value="animate this"),
                    "image": PortValueDict(type="Image", value="https://example.com/start.jpg"),
                    "end_image": PortValueDict(type="Image", value="https://example.com/end.jpg"),
                },
                {"FAL_KEY": "fal_test"},
                emit=AsyncMock(),
            )

    payload = mock_client.post.call_args.kwargs.get("json") or mock_client.post.call_args[1].get("json")
    assert payload["image_url"] == "https://example.com/start.jpg"
    assert payload["end_image_url"] == "https://example.com/end.jpg"


# --- kling-o3 ---

@pytest.mark.asyncio
async def test_kling_o3_endpoint_injected():
    """_kling_o3_handler injects fal-ai/kling-video/o3/standard/image-to-video."""
    mock_submit, mock_status, mock_result = _make_video_poll_mocks()

    node = GraphNode(id="ko3", definitionId="kling-o3", params={})
    node.params.setdefault("endpoint_id", "fal-ai/kling-video/o3/standard/image-to-video")

    with patch("handlers.fal_universal.httpx.AsyncClient") as MockClient:
        mock_client = AsyncMock()
        mock_client.post.return_value = mock_submit
        mock_client.get.side_effect = [mock_status, mock_result]
        mock_client.__aenter__ = AsyncMock(return_value=mock_client)
        mock_client.__aexit__ = AsyncMock(return_value=False)
        MockClient.return_value = mock_client

        with patch("handlers.fal_universal.asyncio.sleep", new_callable=AsyncMock):
            result = await handle_fal_universal(
                node,
                {"image": PortValueDict(type="Image", value="https://example.com/frame.png")},
                {"FAL_KEY": "fal_test"},
                emit=AsyncMock(),
            )

    assert result["video"]["type"] == "Video"
    posted_url = mock_client.post.call_args.args[0] if mock_client.post.call_args.args else mock_client.post.call_args.kwargs.get("url", "")
    assert "kling-video/o3/standard/image-to-video" in posted_url


@pytest.mark.asyncio
async def test_kling_o3_image_maps_to_image_url():
    """kling-o3 image port maps to image_url."""
    mock_submit, mock_status, mock_result = _make_video_poll_mocks()

    node = GraphNode(
        id="ko3-img",
        definitionId="kling-o3",
        params={
            "endpoint_id": "fal-ai/kling-video/o3/standard/image-to-video",
            "duration": "5",
            "generate_audio": False,
        },
    )

    with patch("handlers.fal_universal.httpx.AsyncClient") as MockClient:
        mock_client = AsyncMock()
        mock_client.post.return_value = mock_submit
        mock_client.get.side_effect = [mock_status, mock_result]
        mock_client.__aenter__ = AsyncMock(return_value=mock_client)
        mock_client.__aexit__ = AsyncMock(return_value=False)
        MockClient.return_value = mock_client

        with patch("handlers.fal_universal.asyncio.sleep", new_callable=AsyncMock):
            await handle_fal_universal(
                node,
                {
                    "image": PortValueDict(type="Image", value="https://example.com/subject.png"),
                    "prompt": PortValueDict(type="Text", value="walk forward"),
                },
                {"FAL_KEY": "fal_test"},
                emit=AsyncMock(),
            )

    payload = mock_client.post.call_args.kwargs.get("json") or mock_client.post.call_args[1].get("json")
    assert payload["image_url"] == "https://example.com/subject.png"
    assert payload["duration"] == "5"
    assert "resolution" not in payload  # resolution is not an o3 param
    assert "ref_video1" not in payload  # removed port must not appear


@pytest.mark.asyncio
async def test_kling_o3_end_image_maps_to_end_image_url():
    """kling-o3 end_image port maps to end_image_url."""
    mock_submit, mock_status, mock_result = _make_video_poll_mocks()

    node = GraphNode(
        id="ko3-end",
        definitionId="kling-o3",
        params={"endpoint_id": "fal-ai/kling-video/o3/standard/image-to-video"},
    )

    with patch("handlers.fal_universal.httpx.AsyncClient") as MockClient:
        mock_client = AsyncMock()
        mock_client.post.return_value = mock_submit
        mock_client.get.side_effect = [mock_status, mock_result]
        mock_client.__aenter__ = AsyncMock(return_value=mock_client)
        mock_client.__aexit__ = AsyncMock(return_value=False)
        MockClient.return_value = mock_client

        with patch("handlers.fal_universal.asyncio.sleep", new_callable=AsyncMock):
            await handle_fal_universal(
                node,
                {
                    "image": PortValueDict(type="Image", value="https://example.com/start.png"),
                    "end_image": PortValueDict(type="Image", value="https://example.com/end.png"),
                },
                {"FAL_KEY": "fal_test"},
                emit=AsyncMock(),
            )

    payload = mock_client.post.call_args.kwargs.get("json") or mock_client.post.call_args[1].get("json")
    assert payload["image_url"] == "https://example.com/start.png"
    assert payload["end_image_url"] == "https://example.com/end.png"
