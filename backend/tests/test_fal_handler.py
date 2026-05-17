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


# ---------------------------------------------------------------------------
# LTX wrapper structural tests (audit 2026-05-17)
# ---------------------------------------------------------------------------


# --- ltx-video-2 ---

@pytest.mark.asyncio
async def test_ltx_video2_endpoint_injected():
    """_ltx_video2_handler injects fal-ai/ltx-2/image-to-video."""
    mock_submit, mock_status, mock_result = _make_video_poll_mocks()

    node = GraphNode(id="ltx2", definitionId="ltx-video-2", params={})
    node.params.setdefault("endpoint_id", "fal-ai/ltx-2/image-to-video")

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
                    "image": PortValueDict(type="Image", value="https://example.com/frame.png"),
                    "prompt": PortValueDict(type="Text", value="animate"),
                },
                {"FAL_KEY": "fal_test"},
                emit=AsyncMock(),
            )

    assert result["video"]["type"] == "Video"
    posted_url = mock_client.post.call_args.args[0] if mock_client.post.call_args.args else mock_client.post.call_args.kwargs.get("url", "")
    assert "ltx-2/image-to-video" in posted_url


@pytest.mark.asyncio
async def test_ltx_video2_image_maps_to_image_url():
    """ltx-video-2 image port maps to image_url; fps and generate_audio forwarded."""
    mock_submit, mock_status, mock_result = _make_video_poll_mocks()

    node = GraphNode(
        id="ltx2-params",
        definitionId="ltx-video-2",
        params={
            "endpoint_id": "fal-ai/ltx-2/image-to-video",
            "duration": "8",
            "resolution": "1440p",
            "fps": "50",
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
                {
                    "image": PortValueDict(type="Image", value="https://example.com/src.png"),
                    "prompt": PortValueDict(type="Text", value="gentle waves"),
                },
                {"FAL_KEY": "fal_test"},
                emit=AsyncMock(),
            )

    payload = mock_client.post.call_args.kwargs.get("json") or mock_client.post.call_args[1].get("json")
    assert payload["image_url"] == "https://example.com/src.png"
    assert payload["duration"] == "8"
    assert payload["resolution"] == "1440p"
    assert payload["fps"] == "50"
    assert payload["generate_audio"] is True


@pytest.mark.asyncio
async def test_ltx_video2_generate_audio_false_omitted_when_empty():
    """ltx-video-2: when generate_audio is not set, it must not appear in payload."""
    mock_submit, mock_status, mock_result = _make_video_poll_mocks()

    node = GraphNode(
        id="ltx2-no-audio",
        definitionId="ltx-video-2",
        params={"endpoint_id": "fal-ai/ltx-2/image-to-video"},
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
                    "image": PortValueDict(type="Image", value="https://example.com/src.png"),
                    "prompt": PortValueDict(type="Text", value="slow pan"),
                },
                {"FAL_KEY": "fal_test"},
                emit=AsyncMock(),
            )

    payload = mock_client.post.call_args.kwargs.get("json") or mock_client.post.call_args[1].get("json")
    # generate_audio not in params dict → must not appear in request
    assert "generate_audio" not in payload


# --- ltx-2-3 ---

@pytest.mark.asyncio
async def test_ltx_23_endpoint_injected():
    """_ltx_23_handler injects fal-ai/ltx-2.3/image-to-video."""
    mock_submit, mock_status, mock_result = _make_video_poll_mocks()

    node = GraphNode(id="ltx23", definitionId="ltx-2-3", params={})
    node.params.setdefault("endpoint_id", "fal-ai/ltx-2.3/image-to-video")

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
                {"prompt": PortValueDict(type="Text", value="ocean at dawn")},
                {"FAL_KEY": "fal_test"},
                emit=AsyncMock(),
            )

    assert result["video"]["type"] == "Video"
    posted_url = mock_client.post.call_args.args[0] if mock_client.post.call_args.args else mock_client.post.call_args.kwargs.get("url", "")
    assert "ltx-2.3/image-to-video" in posted_url


@pytest.mark.asyncio
async def test_ltx_23_key_params_forwarded():
    """ltx-2-3: duration, aspect_ratio, fps, generate_audio all forwarded correctly."""
    mock_submit, mock_status, mock_result = _make_video_poll_mocks()

    node = GraphNode(
        id="ltx23-params",
        definitionId="ltx-2-3",
        params={
            "endpoint_id": "fal-ai/ltx-2.3/image-to-video",
            "duration": "8",
            "resolution": "1080p",
            "aspect_ratio": "9:16",
            "fps": "24",
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
                {"prompt": PortValueDict(type="Text", value="portrait walk")},
                {"FAL_KEY": "fal_test"},
                emit=AsyncMock(),
            )

    payload = mock_client.post.call_args.kwargs.get("json") or mock_client.post.call_args[1].get("json")
    assert payload["duration"] == "8"
    assert payload["resolution"] == "1080p"
    assert payload["aspect_ratio"] == "9:16"
    assert payload["fps"] == "24"
    assert payload["generate_audio"] is True


@pytest.mark.asyncio
async def test_ltx_23_end_image_maps_to_end_image_url():
    """ltx-2-3 end_image port maps to end_image_url (transition generation)."""
    mock_submit, mock_status, mock_result = _make_video_poll_mocks()

    node = GraphNode(
        id="ltx23-end",
        definitionId="ltx-2-3",
        params={"endpoint_id": "fal-ai/ltx-2.3/image-to-video"},
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
                    "prompt": PortValueDict(type="Text", value="transition"),
                    "image": PortValueDict(type="Image", value="https://example.com/start.png"),
                    "end_image": PortValueDict(type="Image", value="https://example.com/end.png"),
                },
                {"FAL_KEY": "fal_test"},
                emit=AsyncMock(),
            )

    payload = mock_client.post.call_args.kwargs.get("json") or mock_client.post.call_args[1].get("json")
    assert payload["image_url"] == "https://example.com/start.png"
    assert payload["end_image_url"] == "https://example.com/end.png"


@pytest.mark.asyncio
async def test_ltx_23_audio_port_maps_to_audio_url():
    """ltx-2-3 audio port maps to audio_url (audio-driven generation)."""
    mock_submit, mock_status, mock_result = _make_video_poll_mocks()

    node = GraphNode(
        id="ltx23-audio",
        definitionId="ltx-2-3",
        params={"endpoint_id": "fal-ai/ltx-2.3/image-to-video"},
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
                    "prompt": PortValueDict(type="Text", value="music video"),
                    "audio": PortValueDict(type="Audio", value="https://example.com/track.mp3"),
                },
                {"FAL_KEY": "fal_test"},
                emit=AsyncMock(),
            )

    payload = mock_client.post.call_args.kwargs.get("json") or mock_client.post.call_args[1].get("json")
    assert payload["audio_url"] == "https://example.com/track.mp3"


# ---------------------------------------------------------------------------
# Wan 2.6 wrapper structural tests (audit 2026-05-17)
# ---------------------------------------------------------------------------


# --- wan-2-6-t2v ---

@pytest.mark.asyncio
async def test_wan26_t2v_endpoint_injected():
    """_wan26_t2v_handler injects wan/v2.6/text-to-video (no fal-ai/ prefix)."""
    mock_submit, mock_status, mock_result = _make_video_poll_mocks()

    node = GraphNode(id="wan-t2v", definitionId="wan-2-6-t2v", params={})
    node.params.setdefault("endpoint_id", "wan/v2.6/text-to-video")

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
                {"prompt": PortValueDict(type="Text", value="a futuristic city")},
                {"FAL_KEY": "fal_test"},
                emit=AsyncMock(),
            )

    assert result["video"]["type"] == "Video"
    posted_url = mock_client.post.call_args.args[0] if mock_client.post.call_args.args else mock_client.post.call_args.kwargs.get("url", "")
    assert "wan/v2.6/text-to-video" in posted_url
    assert "fal-ai" not in posted_url


@pytest.mark.asyncio
async def test_wan26_t2v_key_params_forwarded():
    """wan-2-6-t2v: duration (integer), resolution, generate_audio, enable_prompt_expansion forwarded."""
    mock_submit, mock_status, mock_result = _make_video_poll_mocks()

    node = GraphNode(
        id="wan-t2v-params",
        definitionId="wan-2-6-t2v",
        params={
            "endpoint_id": "wan/v2.6/text-to-video",
            "duration": 10,
            "resolution": "1080p",
            "generate_audio": True,
            "enable_prompt_expansion": False,
            "multi_shots": False,
            "enable_safety_checker": True,
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
                {"prompt": PortValueDict(type="Text", value="test")},
                {"FAL_KEY": "fal_test"},
                emit=AsyncMock(),
            )

    payload = mock_client.post.call_args.kwargs.get("json") or mock_client.post.call_args[1].get("json")
    assert payload["duration"] == 10, "duration must be integer, not '10s'"
    assert payload["resolution"] == "1080p"
    assert payload["generate_audio"] is True
    assert payload["enable_prompt_expansion"] is False
    assert payload["multi_shots"] is False
    assert payload["enable_safety_checker"] is True
    assert "endpoint_id" not in payload, "endpoint_id must not be forwarded to FAL"


# --- wan-2-6-i2v ---

@pytest.mark.asyncio
async def test_wan26_i2v_endpoint_injected():
    """_wan26_i2v_handler injects wan/v2.6/image-to-video (no fal-ai/ prefix)."""
    mock_submit, mock_status, mock_result = _make_video_poll_mocks()

    node = GraphNode(id="wan-i2v", definitionId="wan-2-6-i2v", params={})
    node.params.setdefault("endpoint_id", "wan/v2.6/image-to-video")

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
                    "image": PortValueDict(type="Image", value="https://example.com/frame.png"),
                    "prompt": PortValueDict(type="Text", value="animate the character"),
                },
                {"FAL_KEY": "fal_test"},
                emit=AsyncMock(),
            )

    assert result["video"]["type"] == "Video"
    posted_url = mock_client.post.call_args.args[0] if mock_client.post.call_args.args else mock_client.post.call_args.kwargs.get("url", "")
    assert "wan/v2.6/image-to-video" in posted_url
    assert "fal-ai" not in posted_url


@pytest.mark.asyncio
async def test_wan26_i2v_image_maps_to_image_url():
    """wan-2-6-i2v: image port maps to image_url; duration sent as integer."""
    mock_submit, mock_status, mock_result = _make_video_poll_mocks()

    node = GraphNode(
        id="wan-i2v-img",
        definitionId="wan-2-6-i2v",
        params={
            "endpoint_id": "wan/v2.6/image-to-video",
            "duration": 5,
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
                {
                    "image": PortValueDict(type="Image", value="https://example.com/char.png"),
                    "prompt": PortValueDict(type="Text", value="wave at camera"),
                },
                {"FAL_KEY": "fal_test"},
                emit=AsyncMock(),
            )

    payload = mock_client.post.call_args.kwargs.get("json") or mock_client.post.call_args[1].get("json")
    assert payload["image_url"] == "https://example.com/char.png"
    assert "image" not in payload, "raw 'image' key must not appear — only image_url"
    assert payload["duration"] == 5, "duration must be integer 5, not '5s'"
    assert payload["generate_audio"] is True


# --- wan-2-6-r2v ---

@pytest.mark.asyncio
async def test_wan26_r2v_endpoint_injected():
    """_wan26_r2v_handler injects wan/v2.6/reference-to-video (no fal-ai/ prefix)."""
    mock_submit, mock_status, mock_result = _make_video_poll_mocks()

    node = GraphNode(id="wan-r2v", definitionId="wan-2-6-r2v", params={})
    node.params.setdefault("endpoint_id", "wan/v2.6/reference-to-video")
    # Simulate the handler collating video ports into video_urls
    node.params["video_urls"] = ["https://example.com/ref1.mp4"]

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
                {"prompt": PortValueDict(type="Text", value="@Video1 dancing")},
                {"FAL_KEY": "fal_test"},
                emit=AsyncMock(),
            )

    assert result["video"]["type"] == "Video"
    posted_url = mock_client.post.call_args.args[0] if mock_client.post.call_args.args else mock_client.post.call_args.kwargs.get("url", "")
    assert "wan/v2.6/reference-to-video" in posted_url
    assert "fal-ai" not in posted_url


@pytest.mark.asyncio
async def test_wan26_r2v_video_ports_collated_into_video_urls():
    """_wan26_r2v_handler must collate video1/video2/video3 input ports into
    a video_urls array on node.params before calling handle_fal_universal.
    Without this, all reference videos are silently dropped."""
    from execution.sync_runner import get_handler_registry

    mock_submit, mock_status, mock_result = _make_video_poll_mocks()

    with patch("handlers.fal_universal.httpx.AsyncClient") as MockClient:
        mock_client = AsyncMock()
        mock_client.post.return_value = mock_submit
        mock_client.get.side_effect = [mock_status, mock_result]
        mock_client.__aenter__ = AsyncMock(return_value=mock_client)
        mock_client.__aexit__ = AsyncMock(return_value=False)
        MockClient.return_value = mock_client

        with patch("handlers.fal_universal.asyncio.sleep", new_callable=AsyncMock):
            async def fake_emit(_e):
                pass

            handlers = get_handler_registry(emit=fake_emit)
            handler = handlers["wan-2-6-r2v"]

            node = GraphNode(id="wan-r2v-collate", definitionId="wan-2-6-r2v", params={})
            result = await handler(
                node,
                {
                    "prompt": PortValueDict(type="Text", value="@Video1 running @Video2 jumping"),
                    "video1": PortValueDict(type="Video", value="https://example.com/ref1.mp4"),
                    "video2": PortValueDict(type="Video", value="https://example.com/ref2.mp4"),
                    # video3 not connected
                },
                {"FAL_KEY": "fal_test"},
            )

    assert result["video"]["type"] == "Video"
    payload = mock_client.post.call_args.kwargs.get("json") or mock_client.post.call_args[1].get("json")
    assert "video_urls" in payload, "video_urls must be present — reference videos were silently dropped"
    assert payload["video_urls"] == [
        "https://example.com/ref1.mp4",
        "https://example.com/ref2.mp4",
    ]
    assert "video1" not in payload, "raw video1 key must not appear in FAL payload"
    assert "video2" not in payload


@pytest.mark.asyncio
async def test_wan26_r2v_single_video_collated():
    """R2V with only video1 connected still produces video_urls with one entry."""
    from execution.sync_runner import get_handler_registry

    mock_submit, mock_status, mock_result = _make_video_poll_mocks()

    with patch("handlers.fal_universal.httpx.AsyncClient") as MockClient:
        mock_client = AsyncMock()
        mock_client.post.return_value = mock_submit
        mock_client.get.side_effect = [mock_status, mock_result]
        mock_client.__aenter__ = AsyncMock(return_value=mock_client)
        mock_client.__aexit__ = AsyncMock(return_value=False)
        MockClient.return_value = mock_client

        with patch("handlers.fal_universal.asyncio.sleep", new_callable=AsyncMock):
            async def fake_emit(_e):
                pass

            handlers = get_handler_registry(emit=fake_emit)
            handler = handlers["wan-2-6-r2v"]

            node = GraphNode(id="wan-r2v-one", definitionId="wan-2-6-r2v", params={})
            await handler(
                node,
                {
                    "prompt": PortValueDict(type="Text", value="@Video1 walks forward"),
                    "video1": PortValueDict(type="Video", value="https://example.com/only.mp4"),
                },
                {"FAL_KEY": "fal_test"},
            )

    payload = mock_client.post.call_args.kwargs.get("json") or mock_client.post.call_args[1].get("json")
    assert payload["video_urls"] == ["https://example.com/only.mp4"]


@pytest.mark.asyncio
async def test_wan26_r2v_duration_is_integer():
    """R2V duration must be sent as integer (5 or 10), not string '5s'."""
    from execution.sync_runner import get_handler_registry

    mock_submit, mock_status, mock_result = _make_video_poll_mocks()

    with patch("handlers.fal_universal.httpx.AsyncClient") as MockClient:
        mock_client = AsyncMock()
        mock_client.post.return_value = mock_submit
        mock_client.get.side_effect = [mock_status, mock_result]
        mock_client.__aenter__ = AsyncMock(return_value=mock_client)
        mock_client.__aexit__ = AsyncMock(return_value=False)
        MockClient.return_value = mock_client

        with patch("handlers.fal_universal.asyncio.sleep", new_callable=AsyncMock):
            async def fake_emit(_e):
                pass

            handlers = get_handler_registry(emit=fake_emit)
            handler = handlers["wan-2-6-r2v"]

            node = GraphNode(
                id="wan-r2v-dur",
                definitionId="wan-2-6-r2v",
                params={"duration": 10},
            )
            await handler(
                node,
                {
                    "prompt": PortValueDict(type="Text", value="@Video1 jumps"),
                    "video1": PortValueDict(type="Video", value="https://example.com/ref.mp4"),
                },
                {"FAL_KEY": "fal_test"},
            )

    payload = mock_client.post.call_args.kwargs.get("json") or mock_client.post.call_args[1].get("json")
    assert payload["duration"] == 10, f"duration must be integer 10, got {payload.get('duration')!r}"
    assert payload["duration"] != "10s", "duration must not use '10s' string format"
    assert "audio" not in payload  # raw port name must not leak into request


# ---------------------------------------------------------------------------
# Luma Ray 2 wrapper structural tests (audit 2026-05-17)
# ---------------------------------------------------------------------------


# --- luma-ray2-t2v ---

@pytest.mark.asyncio
async def test_luma_ray2_t2v_endpoint_injected():
    """_luma_ray2_handler injects fal-ai/luma-dream-machine/ray-2."""
    mock_submit, mock_status, mock_result = _make_video_poll_mocks()

    node = GraphNode(id="luma-t2v", definitionId="luma-ray2-t2v", params={})
    node.params.setdefault("endpoint_id", "fal-ai/luma-dream-machine/ray-2")

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
                {"prompt": PortValueDict(type="Text", value="a cinematic sunrise")},
                {"FAL_KEY": "fal_test"},
                emit=AsyncMock(),
            )

    assert result["video"]["type"] == "Video"
    posted_url = mock_client.post.call_args.args[0] if mock_client.post.call_args.args else mock_client.post.call_args.kwargs.get("url", "")
    assert "luma-dream-machine/ray-2" in posted_url


@pytest.mark.asyncio
async def test_luma_ray2_t2v_key_params_forwarded():
    """luma-ray2-t2v: aspect_ratio, duration, resolution, loop all forwarded correctly."""
    mock_submit, mock_status, mock_result = _make_video_poll_mocks()

    node = GraphNode(
        id="luma-t2v-params",
        definitionId="luma-ray2-t2v",
        params={
            "endpoint_id": "fal-ai/luma-dream-machine/ray-2",
            "aspect_ratio": "9:16",
            "duration": "9s",
            "resolution": "540p",
            "loop": True,
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
                {"prompt": PortValueDict(type="Text", value="sunset over the ocean")},
                {"FAL_KEY": "fal_test"},
                emit=AsyncMock(),
            )

    payload = mock_client.post.call_args.kwargs.get("json") or mock_client.post.call_args[1].get("json")
    assert payload["aspect_ratio"] == "9:16"
    assert payload["duration"] == "9s"
    assert payload["resolution"] == "540p"
    assert payload["loop"] is True
    assert "endpoint_id" not in payload, "endpoint_id must not be forwarded to FAL"


@pytest.mark.asyncio
async def test_luma_ray2_t2v_ultrawide_aspect_ratios_forwarded():
    """luma-ray2-t2v accepts 21:9 and 9:21 ultrawide aspect ratios."""
    mock_submit, mock_status, mock_result = _make_video_poll_mocks()

    node = GraphNode(
        id="luma-t2v-ultrawide",
        definitionId="luma-ray2-t2v",
        params={
            "endpoint_id": "fal-ai/luma-dream-machine/ray-2",
            "aspect_ratio": "21:9",
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
                {"prompt": PortValueDict(type="Text", value="cinematic widescreen")},
                {"FAL_KEY": "fal_test"},
                emit=AsyncMock(),
            )

    payload = mock_client.post.call_args.kwargs.get("json") or mock_client.post.call_args[1].get("json")
    assert payload["aspect_ratio"] == "21:9"


# --- luma-ray2-i2v ---

@pytest.mark.asyncio
async def test_luma_ray2_i2v_endpoint_injected():
    """_luma_ray2_i2v_handler injects fal-ai/luma-dream-machine/ray-2/image-to-video."""
    mock_submit, mock_status, mock_result = _make_video_poll_mocks()

    node = GraphNode(id="luma-i2v", definitionId="luma-ray2-i2v", params={})
    node.params.setdefault("endpoint_id", "fal-ai/luma-dream-machine/ray-2/image-to-video")

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
                    "image": PortValueDict(type="Image", value="https://example.com/frame.png"),
                    "prompt": PortValueDict(type="Text", value="pan left slowly"),
                },
                {"FAL_KEY": "fal_test"},
                emit=AsyncMock(),
            )

    assert result["video"]["type"] == "Video"
    posted_url = mock_client.post.call_args.args[0] if mock_client.post.call_args.args else mock_client.post.call_args.kwargs.get("url", "")
    assert "luma-dream-machine/ray-2/image-to-video" in posted_url


@pytest.mark.asyncio
async def test_luma_ray2_i2v_image_maps_to_image_url():
    """luma-ray2-i2v image port maps to image_url; end_image maps to end_image_url."""
    mock_submit, mock_status, mock_result = _make_video_poll_mocks()

    node = GraphNode(
        id="luma-i2v-img",
        definitionId="luma-ray2-i2v",
        params={
            "endpoint_id": "fal-ai/luma-dream-machine/ray-2/image-to-video",
            "aspect_ratio": "9:21",
            "duration": "5s",
            "resolution": "720p",
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
                    "image": PortValueDict(type="Image", value="https://example.com/start.jpg"),
                    "end_image": PortValueDict(type="Image", value="https://example.com/end.jpg"),
                    "prompt": PortValueDict(type="Text", value="smooth transition"),
                },
                {"FAL_KEY": "fal_test"},
                emit=AsyncMock(),
            )

    payload = mock_client.post.call_args.kwargs.get("json") or mock_client.post.call_args[1].get("json")
    assert payload["image_url"] == "https://example.com/start.jpg"
    assert payload["end_image_url"] == "https://example.com/end.jpg"
    assert payload["aspect_ratio"] == "9:21"
    assert payload["duration"] == "5s"
    assert payload["resolution"] == "720p"


# --- luma-ray2-flash-modify ---

@pytest.mark.asyncio
async def test_luma_ray2_flash_modify_endpoint_injected():
    """_luma_ray2_flash_modify_handler injects fal-ai/luma-dream-machine/ray-2-flash/modify."""
    mock_submit, mock_status, mock_result = _make_video_poll_mocks()

    node = GraphNode(id="luma-fm", definitionId="luma-ray2-flash-modify", params={})
    node.params.setdefault("endpoint_id", "fal-ai/luma-dream-machine/ray-2-flash/modify")

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
                    "video": PortValueDict(type="Video", value="https://example.com/clip.mp4"),
                    "prompt": PortValueDict(type="Text", value="make it cinematic"),
                },
                {"FAL_KEY": "fal_test"},
                emit=AsyncMock(),
            )

    assert result["video"]["type"] == "Video"
    posted_url = mock_client.post.call_args.args[0] if mock_client.post.call_args.args else mock_client.post.call_args.kwargs.get("url", "")
    assert "luma-dream-machine/ray-2-flash/modify" in posted_url


@pytest.mark.asyncio
async def test_luma_ray2_flash_modify_video_maps_to_video_url():
    """luma-ray2-flash-modify video port maps to video_url; mode param forwarded."""
    mock_submit, mock_status, mock_result = _make_video_poll_mocks()

    node = GraphNode(
        id="luma-fm-mode",
        definitionId="luma-ray2-flash-modify",
        params={
            "endpoint_id": "fal-ai/luma-dream-machine/ray-2-flash/modify",
            "mode": "reimagine_2",
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
                    "video": PortValueDict(type="Video", value="https://example.com/source.mp4"),
                    "prompt": PortValueDict(type="Text", value="restyle as anime"),
                },
                {"FAL_KEY": "fal_test"},
                emit=AsyncMock(),
            )

    payload = mock_client.post.call_args.kwargs.get("json") or mock_client.post.call_args[1].get("json")
    assert payload["video_url"] == "https://example.com/source.mp4"
    assert payload["mode"] == "reimagine_2"
    # aspect_ratio, resolution, duration must NOT appear — they are not API params
    assert "aspect_ratio" not in payload, "aspect_ratio must not be sent to flash-modify API"
    assert "resolution" not in payload, "resolution must not be sent to flash-modify API"
    assert "duration" not in payload, "duration must not be sent to flash-modify API"


@pytest.mark.asyncio
async def test_luma_ray2_flash_modify_reference_image_maps_to_image_url():
    """luma-ray2-flash-modify optional reference image port maps to image_url."""
    mock_submit, mock_status, mock_result = _make_video_poll_mocks()

    node = GraphNode(
        id="luma-fm-ref",
        definitionId="luma-ray2-flash-modify",
        params={
            "endpoint_id": "fal-ai/luma-dream-machine/ray-2-flash/modify",
            "mode": "flex_1",
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
                    "video": PortValueDict(type="Video", value="https://example.com/clip.mp4"),
                    "image": PortValueDict(type="Image", value="https://example.com/style.jpg"),
                },
                {"FAL_KEY": "fal_test"},
                emit=AsyncMock(),
            )

    payload = mock_client.post.call_args.kwargs.get("json") or mock_client.post.call_args[1].get("json")
    assert payload["video_url"] == "https://example.com/clip.mp4"
    assert payload["image_url"] == "https://example.com/style.jpg"
    assert payload["mode"] == "flex_1"


@pytest.mark.asyncio
async def test_luma_ray2_flash_modify_without_prompt_still_works():
    """luma-ray2-flash-modify prompt is optional — omitting it must not raise."""
    mock_submit, mock_status, mock_result = _make_video_poll_mocks()

    node = GraphNode(
        id="luma-fm-no-prompt",
        definitionId="luma-ray2-flash-modify",
        params={
            "endpoint_id": "fal-ai/luma-dream-machine/ray-2-flash/modify",
            "mode": "adhere_1",
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
            result = await handle_fal_universal(
                node,
                {
                    "video": PortValueDict(type="Video", value="https://example.com/clip.mp4"),
                    # no prompt connected
                },
                {"FAL_KEY": "fal_test"},
                emit=AsyncMock(),
            )

    assert result["video"]["type"] == "Video"
    payload = mock_client.post.call_args.kwargs.get("json") or mock_client.post.call_args[1].get("json")
    assert payload["video_url"] == "https://example.com/clip.mp4"
    assert "prompt" not in payload, "prompt must not appear in payload when not connected"


# ---------------------------------------------------------------------------
# Recraft V4 wrapper tests (audit 2026-05-17)
# Source: fal.ai/models/fal-ai/recraft/v4/text-to-image/api  (fetched 2026-05-17)
#         fal.ai/models/fal-ai/recraft/v4/text-to-vector/api  (fetched 2026-05-17)
# ---------------------------------------------------------------------------

from execution.sync_runner import _apply_recraft_color_params, _parse_recraft_color


def _make_image_poll_mocks_recraft():
    """Return (mock_submit, mock_status, mock_result) for a standard raster image job."""
    mock_submit = MagicMock()
    mock_submit.status_code = 200
    mock_submit.json.return_value = {"request_id": "req-recraft"}

    mock_status = MagicMock()
    mock_status.status_code = 200
    mock_status.json.return_value = {"status": "COMPLETED"}

    mock_result = MagicMock()
    mock_result.status_code = 200
    mock_result.json.return_value = {
        "images": [{"url": "https://fal.ai/recraft-out.png", "content_type": "image/png"}]
    }
    return mock_submit, mock_status, mock_result


def _make_svg_poll_mocks():
    """Return (mock_submit, mock_status, mock_result) for a Recraft SVG job."""
    mock_submit = MagicMock()
    mock_submit.status_code = 200
    mock_submit.json.return_value = {"request_id": "req-recraft-svg"}

    mock_status = MagicMock()
    mock_status.status_code = 200
    mock_status.json.return_value = {"status": "COMPLETED"}

    mock_result = MagicMock()
    mock_result.status_code = 200
    mock_result.json.return_value = {
        "images": [{"url": "https://fal.ai/recraft-out.svg", "content_type": "image/svg+xml"}]
    }
    return mock_submit, mock_status, mock_result


# --- _parse_recraft_color unit tests ---


class TestParseRecraftColor:
    def test_hex_with_hash(self):
        assert _parse_recraft_color("#FF0000") == {"r": 255, "g": 0, "b": 0}

    def test_hex_without_hash(self):
        assert _parse_recraft_color("00FF00") == {"r": 0, "g": 255, "b": 0}

    def test_hex_lowercase(self):
        assert _parse_recraft_color("#0000ff") == {"r": 0, "g": 0, "b": 255}

    def test_rgb_dict_passthrough(self):
        assert _parse_recraft_color({"r": 128, "g": 64, "b": 32}) == {"r": 128, "g": 64, "b": 32}

    def test_invalid_hex_returns_none(self):
        assert _parse_recraft_color("ZZZZZZ") is None

    def test_short_hex_returns_none(self):
        assert _parse_recraft_color("#FFF") is None

    def test_empty_string_returns_none(self):
        assert _parse_recraft_color("") is None

    def test_dict_missing_keys_returns_none(self):
        assert _parse_recraft_color({"r": 255}) is None


# --- _apply_recraft_color_params unit tests ---


class TestApplyRecraftColorParams:
    def test_hex_csv_colors_converted_to_rgb_list(self):
        node = GraphNode(id="r", definitionId="recraft-v4-raster",
                         params={"endpoint_id": "fal-ai/recraft/v4/text-to-image",
                                 "colors": "#FF0000,#00FF00,#0000FF"})
        _apply_recraft_color_params(node)
        assert node.params["colors"] == [
            {"r": 255, "g": 0, "b": 0},
            {"r": 0, "g": 255, "b": 0},
            {"r": 0, "g": 0, "b": 255},
        ]

    def test_json_array_colors_converted(self):
        node = GraphNode(id="r", definitionId="recraft-v4-raster",
                         params={"endpoint_id": "fal-ai/recraft/v4/text-to-image",
                                 "colors": '[{"r":255,"g":0,"b":0}]'})
        _apply_recraft_color_params(node)
        assert node.params["colors"] == [{"r": 255, "g": 0, "b": 0}]

    def test_empty_colors_dropped(self):
        node = GraphNode(id="r", definitionId="recraft-v4-raster",
                         params={"endpoint_id": "fal-ai/recraft/v4/text-to-image",
                                 "colors": ""})
        _apply_recraft_color_params(node)
        assert "colors" not in node.params

    def test_invalid_colors_dropped(self):
        node = GraphNode(id="r", definitionId="recraft-v4-raster",
                         params={"endpoint_id": "fal-ai/recraft/v4/text-to-image",
                                 "colors": "not-a-color"})
        _apply_recraft_color_params(node)
        assert "colors" not in node.params

    def test_hex_background_color_converted(self):
        node = GraphNode(id="r", definitionId="recraft-v4-raster",
                         params={"endpoint_id": "fal-ai/recraft/v4/text-to-image",
                                 "background_color": "#FFFFFF"})
        _apply_recraft_color_params(node)
        assert node.params["background_color"] == {"r": 255, "g": 255, "b": 255}

    def test_json_object_background_color_converted(self):
        node = GraphNode(id="r", definitionId="recraft-v4-raster",
                         params={"endpoint_id": "fal-ai/recraft/v4/text-to-image",
                                 "background_color": '{"r":0,"g":0,"b":0}'})
        _apply_recraft_color_params(node)
        assert node.params["background_color"] == {"r": 0, "g": 0, "b": 0}

    def test_empty_background_color_dropped(self):
        node = GraphNode(id="r", definitionId="recraft-v4-raster",
                         params={"endpoint_id": "fal-ai/recraft/v4/text-to-image",
                                 "background_color": ""})
        _apply_recraft_color_params(node)
        assert "background_color" not in node.params

    def test_no_color_params_unchanged(self):
        node = GraphNode(id="r", definitionId="recraft-v4-raster",
                         params={"endpoint_id": "fal-ai/recraft/v4/text-to-image",
                                 "enable_safety_checker": True})
        _apply_recraft_color_params(node)
        assert node.params == {"endpoint_id": "fal-ai/recraft/v4/text-to-image",
                               "enable_safety_checker": True}


# --- recraft-v4-raster endpoint injection and port mapping ---


@pytest.mark.asyncio
async def test_recraft_raster_endpoint_injected():
    """_recraft_raster_handler injects fal-ai/recraft/v4/text-to-image."""
    mock_submit, mock_status, mock_result = _make_image_poll_mocks_recraft()

    node = GraphNode(id="rr", definitionId="recraft-v4-raster", params={})
    node.params.setdefault("endpoint_id", "fal-ai/recraft/v4/text-to-image")

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
                {"prompt": PortValueDict(type="Text", value="a dragon")},
                {"FAL_KEY": "fal_test"},
                emit=AsyncMock(),
            )

    assert result["image"]["type"] == "Image"
    posted_url = mock_client.post.call_args.args[0] if mock_client.post.call_args.args \
        else mock_client.post.call_args.kwargs.get("url", "")
    assert "recraft/v4/text-to-image" in posted_url


@pytest.mark.asyncio
async def test_recraft_raster_colors_hex_csv_sent_as_rgb_list():
    """recraft-v4-raster: comma-sep hex colors must arrive at FAL as [{r,g,b}] list."""
    mock_submit, mock_status, mock_result = _make_image_poll_mocks_recraft()

    node = GraphNode(
        id="rr-colors",
        definitionId="recraft-v4-raster",
        params={
            "endpoint_id": "fal-ai/recraft/v4/text-to-image",
            "colors": "#FF0000,#0000FF",
        },
    )
    _apply_recraft_color_params(node)

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
                {"prompt": PortValueDict(type="Text", value="colorful art")},
                {"FAL_KEY": "fal_test"},
                emit=AsyncMock(),
            )

    payload = mock_client.post.call_args.kwargs.get("json") or mock_client.post.call_args[1].get("json")
    assert payload["colors"] == [{"r": 255, "g": 0, "b": 0}, {"r": 0, "g": 0, "b": 255}]
    assert "style" not in payload, "style param must not be sent to FAL V4 (removed from definition)"


@pytest.mark.asyncio
async def test_recraft_raster_background_color_sent_as_rgb_object():
    """recraft-v4-raster: hex background_color must arrive at FAL as {r,g,b} object."""
    mock_submit, mock_status, mock_result = _make_image_poll_mocks_recraft()

    node = GraphNode(
        id="rr-bg",
        definitionId="recraft-v4-raster",
        params={
            "endpoint_id": "fal-ai/recraft/v4/text-to-image",
            "background_color": "#FFFFFF",
        },
    )
    _apply_recraft_color_params(node)

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
                {"prompt": PortValueDict(type="Text", value="white background")},
                {"FAL_KEY": "fal_test"},
                emit=AsyncMock(),
            )

    payload = mock_client.post.call_args.kwargs.get("json") or mock_client.post.call_args[1].get("json")
    assert payload["background_color"] == {"r": 255, "g": 255, "b": 255}


# --- recraft-v4-svg endpoint injection and SVG output port ---


@pytest.mark.asyncio
async def test_recraft_svg_endpoint_injected():
    """_recraft_svg_handler injects fal-ai/recraft/v4/text-to-vector."""
    mock_submit, mock_status, mock_result = _make_svg_poll_mocks()

    node = GraphNode(id="rs", definitionId="recraft-v4-svg", params={})
    node.params.setdefault("endpoint_id", "fal-ai/recraft/v4/text-to-vector")

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
                {"prompt": PortValueDict(type="Text", value="a logo")},
                {"FAL_KEY": "fal_test"},
                emit=AsyncMock(),
            )

    assert result["svg"]["type"] == "SVG", "recraft-v4-svg must return SVG port, not Image"
    assert result["svg"]["value"] == "https://fal.ai/recraft-out.svg"
    posted_url = mock_client.post.call_args.args[0] if mock_client.post.call_args.args \
        else mock_client.post.call_args.kwargs.get("url", "")
    assert "recraft/v4/text-to-vector" in posted_url


@pytest.mark.asyncio
async def test_recraft_svg_colors_hex_csv_sent_as_rgb_list():
    """recraft-v4-svg: comma-sep hex colors must arrive at FAL as [{r,g,b}] list."""
    mock_submit, mock_status, mock_result = _make_svg_poll_mocks()

    node = GraphNode(
        id="rs-colors",
        definitionId="recraft-v4-svg",
        params={
            "endpoint_id": "fal-ai/recraft/v4/text-to-vector",
            "colors": "#123456,#ABCDEF",
        },
    )
    _apply_recraft_color_params(node)

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
                {"prompt": PortValueDict(type="Text", value="icon")},
                {"FAL_KEY": "fal_test"},
                emit=AsyncMock(),
            )

    assert result["svg"]["type"] == "SVG"
    payload = mock_client.post.call_args.kwargs.get("json") or mock_client.post.call_args[1].get("json")
    assert payload["colors"] == [{"r": 0x12, "g": 0x34, "b": 0x56}, {"r": 0xAB, "g": 0xCD, "b": 0xEF}]
    assert "style" not in payload, "style param must not be sent to FAL V4 (removed from definition)"


@pytest.mark.asyncio
async def test_recraft_svg_output_port_is_svg_not_image():
    """_parse_fal_output must return svg port (not image) for image/svg+xml content_type.
    This is the core routing test for the recraft-v4-svg node."""
    result = _parse_fal_output({
        "images": [{"url": "https://fal.ai/vector.svg", "content_type": "image/svg+xml"}]
    })
    assert "svg" in result, "SVG content_type must route to svg port"
    assert "image" not in result, "SVG content_type must not route to image port"
    assert result["svg"]["type"] == "SVG"
    assert result["svg"]["value"] == "https://fal.ai/vector.svg"


# ---------------------------------------------------------------------------
# FLUX family wrapper tests (flux-1-1-ultra, flux-schnell, fast-sdxl,
# flux-kontext, flux-2-pro)  — Phase 2 audit 2026-05-17
# ---------------------------------------------------------------------------


def _make_image_poll_mocks_flux():
    """Standard poll-cycle mocks returning a single image."""
    mock_submit = MagicMock()
    mock_submit.status_code = 200
    mock_submit.json.return_value = {"request_id": "flux-req-1"}

    mock_status = MagicMock()
    mock_status.status_code = 200
    mock_status.json.return_value = {"status": "COMPLETED"}

    mock_result = MagicMock()
    mock_result.status_code = 200
    mock_result.json.return_value = {
        "images": [{"url": "https://fal.ai/flux-out.png", "content_type": "image/png"}]
    }
    return mock_submit, mock_status, mock_result


def _make_image_direct_mocks_flux():
    """Mock FAL returning the result directly (no request_id — sync response)."""
    mock_submit = MagicMock()
    mock_submit.status_code = 200
    mock_submit.json.return_value = {
        "images": [{"url": "https://fal.ai/fast-sdxl-out.jpeg", "content_type": "image/jpeg"}]
    }
    return mock_submit


# --- flux-1-1-ultra ---


@pytest.mark.asyncio
async def test_flux_ultra_endpoint_injected():
    """_flux_ultra_handler injects fal-ai/flux-pro/v1.1-ultra."""
    mock_submit, mock_status, mock_result = _make_image_poll_mocks_flux()

    node = GraphNode(id="fu1", definitionId="flux-1-1-ultra", params={})
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
                {"prompt": PortValueDict(type="Text", value="a mountain lake")},
                {"FAL_KEY": "fal_test"},
                emit=AsyncMock(),
            )

    assert result["image"]["type"] == "Image"
    posted_url = mock_client.post.call_args.args[0] if mock_client.post.call_args.args \
        else mock_client.post.call_args.kwargs.get("url", "")
    assert "flux-pro/v1.1-ultra" in posted_url


@pytest.mark.asyncio
async def test_flux_ultra_aspect_ratio_and_safety_tolerance_sent():
    """flux-1-1-ultra: sharedParam aspect_ratio and falParam safety_tolerance forwarded."""
    mock_submit, mock_status, mock_result = _make_image_poll_mocks_flux()

    node = GraphNode(
        id="fu2",
        definitionId="flux-1-1-ultra",
        params={
            "endpoint_id": "fal-ai/flux-pro/v1.1-ultra",
            "aspect_ratio": "9:16",
            "safety_tolerance": "3",
            "num_images": 2,
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
                {"prompt": PortValueDict(type="Text", value="portrait")},
                {"FAL_KEY": "fal_test"},
                emit=AsyncMock(),
            )

    payload = mock_client.post.call_args.kwargs.get("json") or mock_client.post.call_args[1].get("json")
    assert payload["aspect_ratio"] == "9:16"
    assert payload["safety_tolerance"] == "3"
    assert payload["num_images"] == 2
    assert "endpoint_id" not in payload, "endpoint_id must not be forwarded to FAL"


@pytest.mark.asyncio
async def test_flux_ultra_image_port_maps_to_image_url():
    """flux-1-1-ultra image guide port maps to image_url."""
    mock_submit, mock_status, mock_result = _make_image_poll_mocks_flux()

    node = GraphNode(
        id="fu3",
        definitionId="flux-1-1-ultra",
        params={
            "endpoint_id": "fal-ai/flux-pro/v1.1-ultra",
            "image_prompt_strength": 0.3,
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
                    "prompt": PortValueDict(type="Text", value="style transfer"),
                    "image": PortValueDict(type="Image", value="https://example.com/guide.jpg"),
                },
                {"FAL_KEY": "fal_test"},
                emit=AsyncMock(),
            )

    payload = mock_client.post.call_args.kwargs.get("json") or mock_client.post.call_args[1].get("json")
    assert payload["image_url"] == "https://example.com/guide.jpg"
    assert payload["image_prompt_strength"] == 0.3


# --- flux-schnell ---


@pytest.mark.asyncio
async def test_flux_schnell_endpoint_injected():
    """_flux_schnell_handler injects fal-ai/flux/schnell."""
    mock_submit, mock_status, mock_result = _make_image_poll_mocks_flux()

    node = GraphNode(id="fs1", definitionId="flux-schnell", params={})
    node.params.setdefault("endpoint_id", "fal-ai/flux/schnell")

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
                {"prompt": PortValueDict(type="Text", value="a quick sketch")},
                {"FAL_KEY": "fal_test"},
                emit=AsyncMock(),
            )

    assert result["image"]["type"] == "Image"
    posted_url = mock_client.post.call_args.args[0] if mock_client.post.call_args.args \
        else mock_client.post.call_args.kwargs.get("url", "")
    assert "flux/schnell" in posted_url


@pytest.mark.asyncio
async def test_flux_schnell_image_size_param_forwarded():
    """flux-schnell: image_size param (not aspect_ratio) must be forwarded.
    The frontend previously sent aspect_ratio instead — this test pins the correct key."""
    mock_submit, mock_status, mock_result = _make_image_poll_mocks_flux()

    node = GraphNode(
        id="fs2",
        definitionId="flux-schnell",
        params={
            "endpoint_id": "fal-ai/flux/schnell",
            "image_size": "portrait_16_9",
            "num_images": 1,
            "output_format": "jpeg",
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
                {"prompt": PortValueDict(type="Text", value="fast image")},
                {"FAL_KEY": "fal_test"},
                emit=AsyncMock(),
            )

    payload = mock_client.post.call_args.kwargs.get("json") or mock_client.post.call_args[1].get("json")
    assert payload["image_size"] == "portrait_16_9", "image_size must be forwarded (not aspect_ratio)"
    assert "aspect_ratio" not in payload, "aspect_ratio is not a valid flux/schnell param"
    assert payload["output_format"] == "jpeg"


@pytest.mark.asyncio
async def test_flux_schnell_direct_response_no_poll():
    """flux-schnell: when FAL returns images directly (no request_id), no poll loop runs."""
    mock_submit = _make_image_direct_mocks_flux()
    # No GET calls should happen — direct response
    mock_submit.json.return_value = {
        "images": [{"url": "https://fal.ai/schnell-fast.png", "content_type": "image/png"}]
    }

    node = GraphNode(
        id="fs3",
        definitionId="flux-schnell",
        params={"endpoint_id": "fal-ai/flux/schnell"},
    )

    with patch("handlers.fal_universal.httpx.AsyncClient") as MockClient:
        mock_client = AsyncMock()
        mock_client.post.return_value = mock_submit
        mock_client.__aenter__ = AsyncMock(return_value=mock_client)
        mock_client.__aexit__ = AsyncMock(return_value=False)
        MockClient.return_value = mock_client

        result = await handle_fal_universal(
            node,
            {"prompt": PortValueDict(type="Text", value="instant output")},
            {"FAL_KEY": "fal_test"},
        )

    assert result["image"]["type"] == "Image"
    assert result["image"]["value"] == "https://fal.ai/schnell-fast.png"
    # GET (poll/result) was never called
    mock_client.get.assert_not_called()


# --- fast-sdxl ---


@pytest.mark.asyncio
async def test_fast_sdxl_endpoint_injected():
    """_fast_sdxl_handler injects fal-ai/fast-sdxl."""
    mock_submit, mock_status, mock_result = _make_image_poll_mocks_flux()

    node = GraphNode(id="fsdxl1", definitionId="fast-sdxl", params={})
    node.params.setdefault("endpoint_id", "fal-ai/fast-sdxl")

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
                {"prompt": PortValueDict(type="Text", value="a stylized portrait")},
                {"FAL_KEY": "fal_test"},
                emit=AsyncMock(),
            )

    assert result["image"]["type"] == "Image"
    posted_url = mock_client.post.call_args.args[0] if mock_client.post.call_args.args \
        else mock_client.post.call_args.kwargs.get("url", "")
    assert "fast-sdxl" in posted_url


@pytest.mark.asyncio
async def test_fast_sdxl_key_params_forwarded():
    """fast-sdxl: guidance_scale, negative_prompt, image_size, safety_checker_version forwarded."""
    mock_submit, mock_status, mock_result = _make_image_poll_mocks_flux()

    node = GraphNode(
        id="fsdxl2",
        definitionId="fast-sdxl",
        params={
            "endpoint_id": "fal-ai/fast-sdxl",
            "image_size": "landscape_16_9",
            "guidance_scale": 8.0,
            "negative_prompt": "blurry, low quality",
            "num_inference_steps": 30,
            "safety_checker_version": "v2",
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
                {"prompt": PortValueDict(type="Text", value="render")},
                {"FAL_KEY": "fal_test"},
                emit=AsyncMock(),
            )

    payload = mock_client.post.call_args.kwargs.get("json") or mock_client.post.call_args[1].get("json")
    assert payload["image_size"] == "landscape_16_9"
    assert payload["guidance_scale"] == 8.0
    assert payload["negative_prompt"] == "blurry, low quality"
    assert payload["num_inference_steps"] == 30
    assert payload["safety_checker_version"] == "v2"


@pytest.mark.asyncio
async def test_fast_sdxl_loras_json_string_parsed():
    """fast-sdxl: loras param stored as JSON string must be parsed to list before dispatch.
    Empty/invalid JSON must be dropped silently (handler pre-processes in sync_runner)."""
    from execution.sync_runner import get_handler_registry

    mock_submit, mock_status, mock_result = _make_image_poll_mocks_flux()

    with patch("handlers.fal_universal.httpx.AsyncClient") as MockClient:
        mock_client = AsyncMock()
        mock_client.post.return_value = mock_submit
        mock_client.get.side_effect = [mock_status, mock_result]
        mock_client.__aenter__ = AsyncMock(return_value=mock_client)
        mock_client.__aexit__ = AsyncMock(return_value=False)
        MockClient.return_value = mock_client

        with patch("handlers.fal_universal.asyncio.sleep", new_callable=AsyncMock):
            async def fake_emit(_e):
                pass

            handlers = get_handler_registry(emit=fake_emit)
            handler = handlers["fast-sdxl"]

            node = GraphNode(
                id="fsdxl3",
                definitionId="fast-sdxl",
                params={
                    "loras": '[{"path": "https://example.com/lora.safetensors", "scale": 0.8}]',
                    "embeddings": "",  # empty — must be dropped
                },
            )

            result = await handler(
                node,
                {"prompt": PortValueDict(type="Text", value="cyberpunk portrait")},
                {"FAL_KEY": "fal_test"},
            )

    assert result["image"]["type"] == "Image"
    payload = mock_client.post.call_args.kwargs.get("json") or mock_client.post.call_args[1].get("json")
    assert "loras" in payload, "loras must be present in FAL request"
    assert isinstance(payload["loras"], list), "loras must be parsed to list, not forwarded as JSON string"
    assert payload["loras"][0]["path"] == "https://example.com/lora.safetensors"
    assert payload["loras"][0]["scale"] == 0.8
    assert "embeddings" not in payload, "empty embeddings string must be dropped, not forwarded"


# --- flux-kontext ---


@pytest.mark.asyncio
async def test_flux_kontext_endpoint_injected():
    """_flux_kontext_handler injects fal-ai/flux-pro/kontext."""
    mock_submit, mock_status, mock_result = _make_image_poll_mocks_flux()

    node = GraphNode(id="fk1", definitionId="flux-kontext", params={})
    node.params.setdefault("endpoint_id", "fal-ai/flux-pro/kontext")

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
                    "prompt": PortValueDict(type="Text", value="make it sunset"),
                    "image": PortValueDict(type="Image", value="https://example.com/source.jpg"),
                },
                {"FAL_KEY": "fal_test"},
                emit=AsyncMock(),
            )

    assert result["image"]["type"] == "Image"
    posted_url = mock_client.post.call_args.args[0] if mock_client.post.call_args.args \
        else mock_client.post.call_args.kwargs.get("url", "")
    assert "flux-pro/kontext" in posted_url


@pytest.mark.asyncio
async def test_flux_kontext_image_port_maps_to_image_url():
    """flux-kontext: required image input port maps to image_url in FAL request."""
    mock_submit, mock_status, mock_result = _make_image_poll_mocks_flux()

    node = GraphNode(
        id="fk2",
        definitionId="flux-kontext",
        params={
            "endpoint_id": "fal-ai/flux-pro/kontext",
            "aspect_ratio": "16:9",
            "safety_tolerance": "2",
            "num_images": 1,
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
                    "prompt": PortValueDict(type="Text", value="change background to forest"),
                    "image": PortValueDict(type="Image", value="https://example.com/person.jpg"),
                },
                {"FAL_KEY": "fal_test"},
                emit=AsyncMock(),
            )

    payload = mock_client.post.call_args.kwargs.get("json") or mock_client.post.call_args[1].get("json")
    assert payload["image_url"] == "https://example.com/person.jpg", \
        "flux-kontext image port must map to image_url"
    assert payload["aspect_ratio"] == "16:9"
    assert payload["num_images"] == 1
    assert payload["safety_tolerance"] == "2"


@pytest.mark.asyncio
async def test_flux_kontext_safety_tolerance_max_is_6():
    """flux-kontext: safety_tolerance accepts values up to 6 (unlike flux-2-pro max of 5)."""
    mock_submit, mock_status, mock_result = _make_image_poll_mocks_flux()

    node = GraphNode(
        id="fk3",
        definitionId="flux-kontext",
        params={
            "endpoint_id": "fal-ai/flux-pro/kontext",
            "safety_tolerance": "6",
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
                    "prompt": PortValueDict(type="Text", value="test"),
                    "image": PortValueDict(type="Image", value="https://example.com/img.jpg"),
                },
                {"FAL_KEY": "fal_test"},
                emit=AsyncMock(),
            )

    payload = mock_client.post.call_args.kwargs.get("json") or mock_client.post.call_args[1].get("json")
    assert payload["safety_tolerance"] == "6"


# --- flux-2-pro ---


@pytest.mark.asyncio
async def test_flux2_pro_endpoint_injected():
    """_flux2_pro_handler injects fal-ai/flux-2-pro."""
    mock_submit, mock_status, mock_result = _make_image_poll_mocks_flux()

    node = GraphNode(id="f2p1", definitionId="flux-2-pro", params={})
    node.params.setdefault("endpoint_id", "fal-ai/flux-2-pro")

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
                {"prompt": PortValueDict(type="Text", value="a futuristic cityscape")},
                {"FAL_KEY": "fal_test"},
                emit=AsyncMock(),
            )

    assert result["image"]["type"] == "Image"
    posted_url = mock_client.post.call_args.args[0] if mock_client.post.call_args.args \
        else mock_client.post.call_args.kwargs.get("url", "")
    assert "flux-2-pro" in posted_url


@pytest.mark.asyncio
async def test_flux2_pro_key_params_forwarded():
    """flux-2-pro: image_size, safety_tolerance, enable_safety_checker, output_format forwarded.
    num_images must NOT be sent — it is not a documented API param for this model."""
    mock_submit, mock_status, mock_result = _make_image_poll_mocks_flux()

    node = GraphNode(
        id="f2p2",
        definitionId="flux-2-pro",
        params={
            "endpoint_id": "fal-ai/flux-2-pro",
            "image_size": "square_hd",
            "safety_tolerance": "3",
            "enable_safety_checker": True,
            "output_format": "png",
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
                {"prompt": PortValueDict(type="Text", value="portrait")},
                {"FAL_KEY": "fal_test"},
                emit=AsyncMock(),
            )

    payload = mock_client.post.call_args.kwargs.get("json") or mock_client.post.call_args[1].get("json")
    assert payload["image_size"] == "square_hd"
    assert payload["safety_tolerance"] == "3"
    assert payload["enable_safety_checker"] is True
    assert payload["output_format"] == "png"
    assert "num_images" not in payload, \
        "num_images is not documented for flux-2-pro and must not be in registry"


@pytest.mark.asyncio
async def test_flux2_pro_safety_tolerance_max_is_5():
    """flux-2-pro: safety_tolerance max is 5 (not 6 like flux-1-1-ultra and flux-kontext)."""
    mock_submit, mock_status, mock_result = _make_image_poll_mocks_flux()

    node = GraphNode(
        id="f2p3",
        definitionId="flux-2-pro",
        params={
            "endpoint_id": "fal-ai/flux-2-pro",
            "safety_tolerance": "5",
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
                {"prompt": PortValueDict(type="Text", value="test")},
                {"FAL_KEY": "fal_test"},
                emit=AsyncMock(),
            )

    payload = mock_client.post.call_args.kwargs.get("json") or mock_client.post.call_args[1].get("json")
    assert payload["safety_tolerance"] == "5"


# ---------------------------------------------------------------------------
# seedance-v1-5
# ---------------------------------------------------------------------------

@pytest.mark.asyncio
async def test_seedance_v1_5_endpoint_injected():
    """seedance-v1-5 must use fal-ai/bytedance/seedance/v1.5/pro/image-to-video (not the old
    fal-ai/seedance/v1.5/text-to-video endpoint that the frontend used to have)."""
    mock_submit, mock_status, mock_result = _make_video_poll_mocks()

    node = GraphNode(id="sd15-ep", definitionId="seedance-v1-5", params={})
    node.params.setdefault("endpoint_id", "fal-ai/bytedance/seedance/v1.5/pro/image-to-video")

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
                    "prompt": PortValueDict(type="Text", value="cinematic"),
                    "image": PortValueDict(type="Image", value="https://example.com/start.png"),
                },
                {"FAL_KEY": "fal_test"},
                emit=AsyncMock(),
            )

    assert result["video"]["type"] == "Video"
    posted_url = mock_client.post.call_args.args[0] if mock_client.post.call_args.args \
        else mock_client.post.call_args.kwargs.get("url", "")
    assert "bytedance/seedance/v1.5/pro/image-to-video" in posted_url


@pytest.mark.asyncio
async def test_seedance_v1_5_image_maps_to_image_url():
    """seedance-v1-5 image port must map to image_url; end_image port to end_image_url."""
    mock_submit, mock_status, mock_result = _make_video_poll_mocks()

    node = GraphNode(
        id="sd15-img",
        definitionId="seedance-v1-5",
        params={
            "endpoint_id": "fal-ai/bytedance/seedance/v1.5/pro/image-to-video",
            "duration": "5",
            "aspect_ratio": "16:9",
            "resolution": "720p",
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
                {
                    "prompt": PortValueDict(type="Text", value="slow pan"),
                    "image": PortValueDict(type="Image", value="https://example.com/start.png"),
                    "end_image": PortValueDict(type="Image", value="https://example.com/end.png"),
                },
                {"FAL_KEY": "fal_test"},
                emit=AsyncMock(),
            )

    payload = mock_client.post.call_args.kwargs.get("json") or mock_client.post.call_args[1].get("json")
    assert payload["image_url"] == "https://example.com/start.png"
    assert payload["end_image_url"] == "https://example.com/end.png"
    assert payload["duration"] == "5", "duration must be integer string, not '5s'"
    assert payload["generate_audio"] is True


# ---------------------------------------------------------------------------
# seedance-2-t2v
# ---------------------------------------------------------------------------

@pytest.mark.asyncio
async def test_seedance2_t2v_endpoint_injected():
    """seedance-2-t2v must route to bytedance/seedance-2.0/text-to-video (no fal-ai/ prefix)."""
    mock_submit, mock_status, mock_result = _make_video_poll_mocks()

    node = GraphNode(id="sd2t-ep", definitionId="seedance-2-t2v", params={})
    node.params.setdefault("endpoint_id", "bytedance/seedance-2.0/text-to-video")

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
                {"prompt": PortValueDict(type="Text", value="sunrise timelapse")},
                {"FAL_KEY": "fal_test"},
                emit=AsyncMock(),
            )

    assert result["video"]["type"] == "Video"
    posted_url = mock_client.post.call_args.args[0] if mock_client.post.call_args.args \
        else mock_client.post.call_args.kwargs.get("url", "")
    assert "bytedance/seedance-2.0/text-to-video" in posted_url
    assert posted_url.startswith("https://queue.fal.run/bytedance"), \
        "No fal-ai/ prefix — endpoint goes directly under queue.fal.run/bytedance"


@pytest.mark.asyncio
async def test_seedance2_t2v_key_params_forwarded():
    """seedance-2-t2v: aspect_ratio, duration (integer string), resolution, generate_audio forwarded."""
    mock_submit, mock_status, mock_result = _make_video_poll_mocks()

    node = GraphNode(
        id="sd2t-params",
        definitionId="seedance-2-t2v",
        params={
            "endpoint_id": "bytedance/seedance-2.0/text-to-video",
            "aspect_ratio": "16:9",
            "duration": "8",
            "resolution": "1080p",
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
                {"prompt": PortValueDict(type="Text", value="ocean waves")},
                {"FAL_KEY": "fal_test"},
                emit=AsyncMock(),
            )

    payload = mock_client.post.call_args.kwargs.get("json") or mock_client.post.call_args[1].get("json")
    assert payload["aspect_ratio"] == "16:9"
    assert payload["duration"] == "8", "duration must be integer string, not '8s'"
    assert payload["resolution"] == "1080p"
    assert payload["generate_audio"] is True


# ---------------------------------------------------------------------------
# seedance-2-i2v
# ---------------------------------------------------------------------------

@pytest.mark.asyncio
async def test_seedance2_i2v_endpoint_and_ports():
    """seedance-2-i2v: correct endpoint, image_url + end_image_url mapping."""
    mock_submit, mock_status, mock_result = _make_video_poll_mocks()

    node = GraphNode(
        id="sd2i-ep",
        definitionId="seedance-2-i2v",
        params={
            "endpoint_id": "bytedance/seedance-2.0/image-to-video",
            "duration": "auto",
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
            result = await handle_fal_universal(
                node,
                {
                    "prompt": PortValueDict(type="Text", value="zoom in"),
                    "image": PortValueDict(type="Image", value="https://example.com/frame.png"),
                    "end_image": PortValueDict(type="Image", value="https://example.com/last.png"),
                },
                {"FAL_KEY": "fal_test"},
                emit=AsyncMock(),
            )

    assert result["video"]["type"] == "Video"
    payload = mock_client.post.call_args.kwargs.get("json") or mock_client.post.call_args[1].get("json")
    assert payload["image_url"] == "https://example.com/frame.png"
    assert payload["end_image_url"] == "https://example.com/last.png"
    posted_url = mock_client.post.call_args.args[0] if mock_client.post.call_args.args \
        else mock_client.post.call_args.kwargs.get("url", "")
    assert "bytedance/seedance-2.0/image-to-video" in posted_url


# ---------------------------------------------------------------------------
# seedance-2-r2v
# ---------------------------------------------------------------------------

@pytest.mark.asyncio
async def test_seedance2_r2v_images_port_maps_to_image_urls():
    """seedance-2-r2v: multi-image 'images' port must map to image_urls list (not image_url)."""
    mock_submit, mock_status, mock_result = _make_video_poll_mocks()

    node = GraphNode(
        id="sd2r-imgs",
        definitionId="seedance-2-r2v",
        params={"endpoint_id": "bytedance/seedance-2.0/reference-to-video"},
    )

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
                    "prompt": PortValueDict(type="Text", value="@Image1 in motion"),
                    "images": PortValueDict(type="Image", value=[
                        "https://example.com/ref1.png",
                        "https://example.com/ref2.png",
                    ]),
                },
                {"FAL_KEY": "fal_test"},
                emit=AsyncMock(),
            )

    assert result["video"]["type"] == "Video"
    payload = mock_client.post.call_args.kwargs.get("json") or mock_client.post.call_args[1].get("json")
    assert payload["image_urls"] == [
        "https://example.com/ref1.png",
        "https://example.com/ref2.png",
    ], "multi-port images must arrive as image_urls list"
    assert "image_url" not in payload, "singular image_url must not appear for r2v"


@pytest.mark.asyncio
async def test_seedance2_r2v_endpoint_injected():
    """seedance-2-r2v routes to bytedance/seedance-2.0/reference-to-video."""
    mock_submit, mock_status, mock_result = _make_video_poll_mocks()

    node = GraphNode(id="sd2r-ep", definitionId="seedance-2-r2v", params={})
    node.params.setdefault("endpoint_id", "bytedance/seedance-2.0/reference-to-video")

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
                {"prompt": PortValueDict(type="Text", value="character walks")},
                {"FAL_KEY": "fal_test"},
                emit=AsyncMock(),
            )

    assert result["video"]["type"] == "Video"
    posted_url = mock_client.post.call_args.args[0] if mock_client.post.call_args.args \
        else mock_client.post.call_args.kwargs.get("url", "")
    assert "seedance-2.0/reference-to-video" in posted_url


# ---------------------------------------------------------------------------
# seedance-2-fast-t2v
# ---------------------------------------------------------------------------

@pytest.mark.asyncio
async def test_seedance2_fast_t2v_endpoint_injected():
    """seedance-2-fast-t2v routes to bytedance/seedance-2.0/fast/text-to-video."""
    mock_submit, mock_status, mock_result = _make_video_poll_mocks()

    node = GraphNode(id="sd2ft-ep", definitionId="seedance-2-fast-t2v", params={})
    node.params.setdefault("endpoint_id", "bytedance/seedance-2.0/fast/text-to-video")

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
                {"prompt": PortValueDict(type="Text", value="quick pan")},
                {"FAL_KEY": "fal_test"},
                emit=AsyncMock(),
            )

    assert result["video"]["type"] == "Video"
    posted_url = mock_client.post.call_args.args[0] if mock_client.post.call_args.args \
        else mock_client.post.call_args.kwargs.get("url", "")
    assert "seedance-2.0/fast/text-to-video" in posted_url


@pytest.mark.asyncio
async def test_seedance2_fast_t2v_duration_is_string_not_int():
    """seedance-2-fast-t2v: duration param is string enum ('auto', '4'..'15'), not integer."""
    mock_submit, mock_status, mock_result = _make_video_poll_mocks()

    node = GraphNode(
        id="sd2ft-dur",
        definitionId="seedance-2-fast-t2v",
        params={
            "endpoint_id": "bytedance/seedance-2.0/fast/text-to-video",
            "duration": "auto",
            "aspect_ratio": "auto",
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
                {"prompt": PortValueDict(type="Text", value="test")},
                {"FAL_KEY": "fal_test"},
                emit=AsyncMock(),
            )

    payload = mock_client.post.call_args.kwargs.get("json") or mock_client.post.call_args[1].get("json")
    assert payload["duration"] == "auto"
    assert isinstance(payload["duration"], str), "duration must be a string, not int"
    assert payload["aspect_ratio"] == "auto"


# ---------------------------------------------------------------------------
# seedance-2-fast-i2v
# ---------------------------------------------------------------------------

@pytest.mark.asyncio
async def test_seedance2_fast_i2v_endpoint_and_ports():
    """seedance-2-fast-i2v: correct endpoint, image_url + end_image_url mapping."""
    mock_submit, mock_status, mock_result = _make_video_poll_mocks()

    node = GraphNode(
        id="sd2fi-ep",
        definitionId="seedance-2-fast-i2v",
        params={
            "endpoint_id": "bytedance/seedance-2.0/fast/image-to-video",
            "duration": "auto",
            "aspect_ratio": "auto",
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
            result = await handle_fal_universal(
                node,
                {
                    "prompt": PortValueDict(type="Text", value="fast dolly"),
                    "image": PortValueDict(type="Image", value="https://example.com/start.png"),
                    "end_image": PortValueDict(type="Image", value="https://example.com/end.png"),
                },
                {"FAL_KEY": "fal_test"},
                emit=AsyncMock(),
            )

    assert result["video"]["type"] == "Video"
    payload = mock_client.post.call_args.kwargs.get("json") or mock_client.post.call_args[1].get("json")
    assert payload["image_url"] == "https://example.com/start.png"
    assert payload["end_image_url"] == "https://example.com/end.png"
    posted_url = mock_client.post.call_args.args[0] if mock_client.post.call_args.args \
        else mock_client.post.call_args.kwargs.get("url", "")
    assert "seedance-2.0/fast/image-to-video" in posted_url


# ---------------------------------------------------------------------------
# FAL OpenAI passthrough node tests — audit 2026-05-17
# Covers: gpt-image-2-fal-generate, gpt-image-2-fal-edit,
#         gpt-image-1-5, gpt-image-1-5-edit, seedream-4-5
# ---------------------------------------------------------------------------


def _make_poll_mocks(result_payload: dict):
    """Return (mock_submit, mock_status, mock_result) for a standard poll flow."""
    mock_submit = MagicMock()
    mock_submit.status_code = 200
    mock_submit.json.return_value = {"request_id": "req-test"}

    mock_status = MagicMock()
    mock_status.status_code = 200
    mock_status.json.return_value = {"status": "COMPLETED"}

    mock_result = MagicMock()
    mock_result.status_code = 200
    mock_result.json.return_value = result_payload

    return mock_submit, mock_status, mock_result


def _image_result(url: str = "https://fal.ai/out.png") -> dict:
    return {"images": [{"url": url, "content_type": "image/png"}]}


# ── gpt-image-2-fal-generate ────────────────────────────────────────────────

@pytest.mark.asyncio
async def test_gpt_image_2_fal_generate_endpoint_injection():
    """Wrapper must inject openai/gpt-image-2 as endpoint_id and route through
    the FAL streaming path (not the async-poll queue)."""
    from execution.stream_runner import StreamConfig

    node = GraphNode(
        id="test-gpt2-fal-gen",
        definitionId="gpt-image-2-fal-generate",
        params={},
    )
    node.params.setdefault("endpoint_id", "openai/gpt-image-2")

    # stream_execute_image is imported lazily inside handle_fal_universal;
    # patch it at the source module so the local import picks up the mock.
    with patch("execution.stream_runner.stream_execute_image", new_callable=AsyncMock) as mock_stream:
        mock_stream.return_value = "https://fal.ai/streamed.png"
        result = await handle_fal_universal(
            node,
            {"prompt": PortValueDict(type="Text", value="a red cube")},
            {"FAL_KEY": "fal_test"},
            emit=AsyncMock(),
        )

    assert result["image"]["type"] == "Image"
    assert result["image"]["value"] == "https://fal.ai/streamed.png"
    mock_stream.assert_called_once()
    call_kwargs = mock_stream.call_args.kwargs
    config: StreamConfig = call_kwargs["config"]
    assert "openai/gpt-image-2/stream" in config.url


@pytest.mark.asyncio
async def test_gpt_image_2_fal_generate_key_params_forwarded():
    """image_size preset name and quality must reach the FAL request body."""
    node = GraphNode(
        id="test-gpt2-fal-gen-params",
        definitionId="gpt-image-2-fal-generate",
        params={
            "endpoint_id": "openai/gpt-image-2",
            "image_size": "square_hd",
            "quality": "high",
            "num_images": 2,
            "output_format": "jpeg",
        },
    )

    with patch("execution.stream_runner.stream_execute_image", new_callable=AsyncMock) as mock_stream:
        mock_stream.return_value = "https://fal.ai/out.png"
        await handle_fal_universal(
            node,
            {"prompt": PortValueDict(type="Text", value="test")},
            {"FAL_KEY": "fal_test"},
            emit=AsyncMock(),
        )

    body = mock_stream.call_args.kwargs["request_body"]
    assert body["image_size"] == "square_hd"
    assert body["quality"] == "high"
    assert body["num_images"] == 2
    assert body["output_format"] == "jpeg"
    # FAL-specific param names — must not use OpenAI-direct names
    assert "size" not in body
    assert "n" not in body


# ── gpt-image-2-fal-edit ────────────────────────────────────────────────────

@pytest.mark.asyncio
async def test_gpt_image_2_fal_edit_endpoint_injection():
    """Wrapper must inject openai/gpt-image-2/edit and stream via SSE."""
    node = GraphNode(
        id="test-gpt2-fal-edit",
        definitionId="gpt-image-2-fal-edit",
        params={},
    )
    node.params.setdefault("endpoint_id", "openai/gpt-image-2/edit")

    with patch("execution.stream_runner.stream_execute_image", new_callable=AsyncMock) as mock_stream:
        mock_stream.return_value = "https://fal.ai/edited.png"
        result = await handle_fal_universal(
            node,
            {
                "prompt": PortValueDict(type="Text", value="add snow"),
                "images": PortValueDict(type="Image", value=["https://example.com/ref.png"]),
            },
            {"FAL_KEY": "fal_test"},
            emit=AsyncMock(),
        )

    assert result["image"]["type"] == "Image"
    mock_stream.assert_called_once()
    config = mock_stream.call_args.kwargs["config"]
    assert "openai/gpt-image-2/edit/stream" in config.url


@pytest.mark.asyncio
async def test_gpt_image_2_fal_edit_images_map_to_image_urls():
    """The 'images' multi-port must map to image_urls list in the stream body."""
    node = GraphNode(
        id="test-gpt2-fal-edit-imgs",
        definitionId="gpt-image-2-fal-edit",
        params={"endpoint_id": "openai/gpt-image-2/edit", "image_size": "auto"},
    )

    with patch("execution.stream_runner.stream_execute_image", new_callable=AsyncMock) as mock_stream:
        mock_stream.return_value = "https://fal.ai/out.png"
        await handle_fal_universal(
            node,
            {
                "prompt": PortValueDict(type="Text", value="make it night"),
                "images": PortValueDict(type="Image", value=[
                    "https://example.com/img1.png",
                    "https://example.com/img2.png",
                ]),
            },
            {"FAL_KEY": "fal_test"},
            emit=AsyncMock(),
        )

    body = mock_stream.call_args.kwargs["request_body"]
    assert body["image_urls"] == [
        "https://example.com/img1.png",
        "https://example.com/img2.png",
    ]
    assert "image_url" not in body  # singular must not appear


@pytest.mark.asyncio
async def test_gpt_image_2_fal_edit_missing_images_raises():
    """Edit endpoint must raise ValueError when no reference images are provided."""
    node = GraphNode(
        id="test-gpt2-fal-edit-no-imgs",
        definitionId="gpt-image-2-fal-edit",
        params={"endpoint_id": "openai/gpt-image-2/edit"},
    )

    with pytest.raises(ValueError, match="image"):
        await handle_fal_universal(
            node,
            {"prompt": PortValueDict(type="Text", value="add snow")},
            {"FAL_KEY": "fal_test"},
            emit=AsyncMock(),
        )


@pytest.mark.asyncio
async def test_gpt_image_2_fal_edit_image_size_preset_forwarded():
    """image_size must be sent as a preset string (e.g. 'square_hd'), not a WxH string."""
    node = GraphNode(
        id="test-gpt2-fal-edit-size",
        definitionId="gpt-image-2-fal-edit",
        params={"endpoint_id": "openai/gpt-image-2/edit", "image_size": "portrait_4_3"},
    )

    with patch("execution.stream_runner.stream_execute_image", new_callable=AsyncMock) as mock_stream:
        mock_stream.return_value = "https://fal.ai/out.png"
        await handle_fal_universal(
            node,
            {
                "prompt": PortValueDict(type="Text", value="test"),
                "images": PortValueDict(type="Image", value=["https://example.com/img.png"]),
            },
            {"FAL_KEY": "fal_test"},
            emit=AsyncMock(),
        )

    body = mock_stream.call_args.kwargs["request_body"]
    assert body["image_size"] == "portrait_4_3"
    # WxH string format must not appear — FAL schema uses preset names
    assert body["image_size"] != "768x1024"


# ── gpt-image-1-5 ───────────────────────────────────────────────────────────

@pytest.mark.asyncio
async def test_gpt_image_1_5_endpoint_injection():
    """Wrapper must inject fal-ai/gpt-image-1.5 and POST to the queue."""
    mock_submit, mock_status, mock_result = _make_poll_mocks(_image_result())

    node = GraphNode(
        id="test-gpt15",
        definitionId="gpt-image-1-5",
        params={},
    )
    node.params.setdefault("endpoint_id", "fal-ai/gpt-image-1.5")

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
                {"prompt": PortValueDict(type="Text", value="a blue sphere")},
                {"FAL_KEY": "fal_test"},
                emit=AsyncMock(),
            )

    assert result["image"]["type"] == "Image"
    posted_url = mock_client.post.call_args.args[0] if mock_client.post.call_args.args \
        else mock_client.post.call_args.kwargs.get("url", "")
    assert "fal-ai/gpt-image-1.5" in posted_url


@pytest.mark.asyncio
async def test_gpt_image_1_5_key_params_forwarded():
    """image_size, quality, background, num_images, output_format all forwarded."""
    mock_submit, mock_status, mock_result = _make_poll_mocks(_image_result())

    node = GraphNode(
        id="test-gpt15-params",
        definitionId="gpt-image-1-5",
        params={
            "endpoint_id": "fal-ai/gpt-image-1.5",
            "image_size": "1024x1024",
            "quality": "medium",
            "background": "transparent",
            "num_images": 3,
            "output_format": "webp",
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
                {"prompt": PortValueDict(type="Text", value="test")},
                {"FAL_KEY": "fal_test"},
                emit=AsyncMock(),
            )

    payload = mock_client.post.call_args.kwargs.get("json") or mock_client.post.call_args[1].get("json")
    assert payload["image_size"] == "1024x1024"
    assert payload["quality"] == "medium"
    assert payload["background"] == "transparent"
    assert payload["num_images"] == 3
    assert payload["output_format"] == "webp"
    # Must not send OpenAI-direct param names
    assert "size" not in payload
    assert "n" not in payload


# ── gpt-image-1-5-edit ──────────────────────────────────────────────────────

@pytest.mark.asyncio
async def test_gpt_image_1_5_edit_endpoint_injection():
    """Wrapper must inject fal-ai/gpt-image-1.5/edit and POST to queue."""
    mock_submit, mock_status, mock_result = _make_poll_mocks(_image_result())

    node = GraphNode(
        id="test-gpt15-edit",
        definitionId="gpt-image-1-5-edit",
        params={},
    )
    node.params.setdefault("endpoint_id", "fal-ai/gpt-image-1.5/edit")

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
                    "prompt": PortValueDict(type="Text", value="add a hat"),
                    "images": PortValueDict(type="Image", value=["https://example.com/cat.png"]),
                },
                {"FAL_KEY": "fal_test"},
                emit=AsyncMock(),
            )

    assert result["image"]["type"] == "Image"
    posted_url = mock_client.post.call_args.args[0] if mock_client.post.call_args.args \
        else mock_client.post.call_args.kwargs.get("url", "")
    assert "fal-ai/gpt-image-1.5/edit" in posted_url


@pytest.mark.asyncio
async def test_gpt_image_1_5_edit_images_map_to_image_urls():
    """Multi-image 'images' port must map to image_urls list in the request body."""
    mock_submit, mock_status, mock_result = _make_poll_mocks(_image_result())

    node = GraphNode(
        id="test-gpt15-edit-imgs",
        definitionId="gpt-image-1-5-edit",
        params={
            "endpoint_id": "fal-ai/gpt-image-1.5/edit",
            "input_fidelity": "high",
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
                    "prompt": PortValueDict(type="Text", value="make it winter"),
                    "images": PortValueDict(type="Image", value=[
                        "https://example.com/a.png",
                        "https://example.com/b.png",
                    ]),
                },
                {"FAL_KEY": "fal_test"},
                emit=AsyncMock(),
            )

    payload = mock_client.post.call_args.kwargs.get("json") or mock_client.post.call_args[1].get("json")
    assert payload["image_urls"] == [
        "https://example.com/a.png",
        "https://example.com/b.png",
    ]
    assert "image_url" not in payload
    assert payload["input_fidelity"] == "high"


@pytest.mark.asyncio
async def test_gpt_image_1_5_edit_missing_images_raises():
    """fal-ai/gpt-image-1.5/edit must raise ValueError when no images provided."""
    node = GraphNode(
        id="test-gpt15-edit-no-imgs",
        definitionId="gpt-image-1-5-edit",
        params={"endpoint_id": "fal-ai/gpt-image-1.5/edit"},
    )

    with pytest.raises(ValueError, match="image"):
        await handle_fal_universal(
            node,
            {"prompt": PortValueDict(type="Text", value="add a hat")},
            {"FAL_KEY": "fal_test"},
            emit=AsyncMock(),
        )


# ── seedream-4-5 ────────────────────────────────────────────────────────────

@pytest.mark.asyncio
async def test_seedream_4_5_endpoint_injection():
    """Wrapper must inject fal-ai/bytedance/seedream/v4.5/text-to-image."""
    mock_submit, mock_status, mock_result = _make_poll_mocks(_image_result())

    node = GraphNode(
        id="test-seedream45",
        definitionId="seedream-4-5",
        params={},
    )
    node.params.setdefault("endpoint_id", "fal-ai/bytedance/seedream/v4.5/text-to-image")

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
                {"prompt": PortValueDict(type="Text", value="a futuristic city")},
                {"FAL_KEY": "fal_test"},
                emit=AsyncMock(),
            )

    assert result["image"]["type"] == "Image"
    posted_url = mock_client.post.call_args.args[0] if mock_client.post.call_args.args \
        else mock_client.post.call_args.kwargs.get("url", "")
    assert "fal-ai/bytedance/seedream/v4.5/text-to-image" in posted_url


@pytest.mark.asyncio
async def test_seedream_4_5_key_params_forwarded():
    """image_size preset, num_images, max_images, enable_safety_checker, seed all forwarded."""
    mock_submit, mock_status, mock_result = _make_poll_mocks(_image_result())

    node = GraphNode(
        id="test-seedream45-params",
        definitionId="seedream-4-5",
        params={
            "endpoint_id": "fal-ai/bytedance/seedream/v4.5/text-to-image",
            "image_size": "square_hd",
            "num_images": 2,
            "max_images": 3,
            "enable_safety_checker": True,
            "seed": 42,
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
                {"prompt": PortValueDict(type="Text", value="test")},
                {"FAL_KEY": "fal_test"},
                emit=AsyncMock(),
            )

    payload = mock_client.post.call_args.kwargs.get("json") or mock_client.post.call_args[1].get("json")
    assert payload["image_size"] == "square_hd"
    assert payload["num_images"] == 2
    assert payload["max_images"] == 3
    assert payload["enable_safety_checker"] is True
    assert payload["seed"] == 42


@pytest.mark.asyncio
async def test_seedream_4_5_auto_2k_size_preset():
    """auto_2K is a valid image_size preset for Seedream 4.5 — must be forwarded as-is."""
    mock_submit, mock_status, mock_result = _make_poll_mocks(_image_result())

    node = GraphNode(
        id="test-seedream45-auto2k",
        definitionId="seedream-4-5",
        params={
            "endpoint_id": "fal-ai/bytedance/seedream/v4.5/text-to-image",
            "image_size": "auto_2K",
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
                {"prompt": PortValueDict(type="Text", value="test")},
                {"FAL_KEY": "fal_test"},
                emit=AsyncMock(),
            )

    payload = mock_client.post.call_args.kwargs.get("json") or mock_client.post.call_args[1].get("json")
    assert payload["image_size"] == "auto_2K"


@pytest.mark.asyncio
async def test_seedream_4_5_null_seed_omitted():
    """A null/None seed must not be sent to FAL (would cause API validation error)."""
    mock_submit, mock_status, mock_result = _make_poll_mocks(_image_result())

    node = GraphNode(
        id="test-seedream45-noseed",
        definitionId="seedream-4-5",
        params={
            "endpoint_id": "fal-ai/bytedance/seedream/v4.5/text-to-image",
            "seed": None,
            "num_images": 1,
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
                {"prompt": PortValueDict(type="Text", value="test")},
                {"FAL_KEY": "fal_test"},
                emit=AsyncMock(),
            )

    payload = mock_client.post.call_args.kwargs.get("json") or mock_client.post.call_args[1].get("json")
    assert "seed" not in payload, "null seed must be omitted from request"
    assert payload.get("num_images") == 1
