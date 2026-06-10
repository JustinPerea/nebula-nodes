"""
Runway handler tests — Phase 2 audit 2026-05-17.

Covers all 7 handlers:
  handle_runway_video, handle_runway_aleph, handle_runway_image,
  handle_runway_act_two, handle_runway_tts, handle_runway_speech_to_speech,
  handle_runway_voice_dubbing

API fundamentals verified:
  Base URL  : https://api.dev.runwayml.com/v1
  Version   : X-Runway-Version: 2024-11-06
  Auth      : Authorization: Bearer {key}
  Poll URL  : /v1/tasks/{id}
  Success   : status == "SUCCEEDED"
  Output    : result["output"][0]

Sources: https://docs.dev.runwayml.com/api/ (2026-05-17),
         https://github.com/runwayml/sdk-python (2026-05-17)
"""

from __future__ import annotations

import base64
import shutil
from pathlib import Path
from unittest.mock import AsyncMock, MagicMock, patch

import pytest

from handlers.runway import (
    RUNWAY_API_BASE,
    RUNWAY_HEADERS_BASE,
    TEXT_TO_VIDEO_MODELS,
    _runway_headers,
    _runway_poll_config,
    handle_runway_act_two,
    handle_runway_image,
    handle_runway_image_upscale,
    handle_runway_speech_to_speech,
    handle_runway_tts,
    handle_runway_video,
    handle_runway_voice_dubbing,
    handle_runway_aleph,
)
from models.graph import GraphNode, PortValueDict

# ---------------------------------------------------------------------------
# Fixtures / helpers
# ---------------------------------------------------------------------------

RED_PIXEL_B64 = (
    "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR4"
    "2mP8/5+hHgAHggJ/PchI7wAAAABJRU5ErkJggg=="
)
FAKE_VIDEO_BYTES = b"\x00\x00\x00\x20ftypisom\x00\x00\x02\x00"
FAKE_AUDIO_BYTES = b"ID3\x03\x00\x00\x00\x00\x00"


def _make_node(def_id: str, params=None):
    return GraphNode(id="test-runway-1", definitionId=def_id, params=params or {})


def _video_node(params=None):
    return _make_node("runway-video", params or {"model": "gen4.5", "duration": 5})


def _aleph_node(params=None):
    return _make_node("runway-aleph", params or {})


def _image_node(params=None):
    return _make_node("runway-image", params or {"model": "gen4_image", "ratio": "1360:768"})


def _act_two_node(params=None):
    return _make_node("runway-act-two", params or {})


def _tts_node(params=None):
    return _make_node("runway-tts", params or {"voiceId": "Maya"})


def _sts_node(params=None):
    return _make_node("runway-sts", params or {"voiceId": "Maya"})


def _dubbing_node(params=None):
    return _make_node("runway-dubbing", params or {"targetLang": "es"})


def _create_test_image(tmp_path) -> Path:
    img_path = tmp_path / "test_input.png"
    img_path.write_bytes(base64.b64decode(RED_PIXEL_B64))
    return img_path


def _create_test_video(tmp_path) -> Path:
    v = tmp_path / "test_input.mp4"
    v.write_bytes(FAKE_VIDEO_BYTES)
    return v


def _create_test_audio(tmp_path) -> Path:
    a = tmp_path / "test_input.mp3"
    a.write_bytes(FAKE_AUDIO_BYTES)
    return a


@pytest.fixture(autouse=True)
def cleanup_output():
    """OUTPUT_ROOT is sandboxed via NEBULA_OUTPUT_ROOT in tests/conftest.py."""
    yield


# ---------------------------------------------------------------------------
# API contract constants
# ---------------------------------------------------------------------------


def test_base_url_is_api_dev_runwayml():
    """Base URL must be api.dev.runwayml.com — not api.runwayml.com."""
    assert RUNWAY_API_BASE == "https://api.dev.runwayml.com/v1"


def test_version_header_value():
    """X-Runway-Version must be 2024-11-06 per SDK _client.py."""
    assert RUNWAY_HEADERS_BASE["X-Runway-Version"] == "2024-11-06"


def test_auth_header_format():
    """Authorization header must use Bearer scheme."""
    headers = _runway_headers("test-key")
    assert headers["Authorization"] == "Bearer test-key"
    assert headers["X-Runway-Version"] == "2024-11-06"


def test_poll_url_template():
    """Poll URL must reference /v1/tasks/{task_id}."""
    config = _runway_poll_config("key", f"{RUNWAY_API_BASE}/image_to_video")
    assert "/v1/tasks/" in config.poll_url_template
    assert "{task_id}" in config.poll_url_template


def test_poll_config_terminal_states():
    """SUCCEEDED/FAILED are the only terminal states."""
    config = _runway_poll_config("key", f"{RUNWAY_API_BASE}/image_to_video")
    assert "SUCCEEDED" in config.terminal_success
    assert "FAILED" in config.terminal_failure


def test_text_to_video_models_set():
    """Text-only-capable models per docs.dev.runwayml.com/guides/models (2026-06)."""
    assert "gen4.5" in TEXT_TO_VIDEO_MODELS
    assert "veo3.1" in TEXT_TO_VIDEO_MODELS
    assert "veo3.1_fast" in TEXT_TO_VIDEO_MODELS
    assert "veo3" in TEXT_TO_VIDEO_MODELS
    assert "seedance2" in TEXT_TO_VIDEO_MODELS
    assert "seedance2_fast" in TEXT_TO_VIDEO_MODELS
    assert "happyhorse_1_0" in TEXT_TO_VIDEO_MODELS
    # gen4_turbo requires an image per SDK image_to_video_create_params
    assert "gen4_turbo" not in TEXT_TO_VIDEO_MODELS
    assert "gen3a_turbo" not in TEXT_TO_VIDEO_MODELS


# ---------------------------------------------------------------------------
# handle_runway_video — image_to_video path
# ---------------------------------------------------------------------------


@pytest.mark.asyncio
async def test_video_image_to_video_submits_prompt_image(tmp_path):
    """promptImage field must be a data URI when a local file is provided."""
    img_path = _create_test_image(tmp_path)
    mock_result = {"id": "task-abc", "status": "SUCCEEDED", "output": ["https://example.com/v.mp4"]}

    with patch("handlers.runway.async_poll_execute", new_callable=AsyncMock) as mock_poll:
        mock_poll.return_value = mock_result
        with patch("handlers.runway.save_video_from_url", new_callable=AsyncMock) as mock_save:
            out_path = tmp_path / "out.mp4"
            out_path.write_bytes(FAKE_VIDEO_BYTES)
            mock_save.return_value = out_path

            result = await handle_runway_video(
                _video_node(),
                {"image": PortValueDict(type="Image", value=str(img_path))},
                {"RUNWAY_API_KEY": "rw-test"},
                emit=AsyncMock(),
            )

    assert result["video"]["type"] == "Video"
    body = mock_poll.call_args.kwargs.get("submit_body") or mock_poll.call_args[1]["submit_body"]
    assert body["promptImage"].startswith("data:image/png;base64,")
    # Endpoint must be image_to_video when image is provided
    config = mock_poll.call_args.kwargs.get("config") or mock_poll.call_args[1]["config"]
    assert config.submit_url.endswith("/image_to_video")


@pytest.mark.asyncio
async def test_video_includes_prompt_text(tmp_path):
    """promptText is forwarded when provided alongside an image."""
    img_path = _create_test_image(tmp_path)
    with patch("handlers.runway.async_poll_execute", new_callable=AsyncMock) as mock_poll:
        mock_poll.return_value = {"id": "t1", "status": "SUCCEEDED", "output": ["https://ex.com/v.mp4"]}
        with patch("handlers.runway.save_video_from_url", new_callable=AsyncMock) as mock_save:
            mock_save.return_value = tmp_path / "v.mp4"
            (tmp_path / "v.mp4").write_bytes(FAKE_VIDEO_BYTES)
            await handle_runway_video(
                _video_node(),
                {
                    "image": PortValueDict(type="Image", value=str(img_path)),
                    "prompt": PortValueDict(type="Text", value="Zoom in slowly"),
                },
                {"RUNWAY_API_KEY": "rw-test"},
            )
    body = mock_poll.call_args.kwargs.get("submit_body") or mock_poll.call_args[1]["submit_body"]
    assert body["promptText"] == "Zoom in slowly"


@pytest.mark.asyncio
async def test_video_missing_image_and_prompt_raises():
    """Must raise when neither image nor prompt is provided."""
    with pytest.raises(ValueError, match="[Ii]mage|prompt"):
        await handle_runway_video(_video_node(), {}, {"RUNWAY_API_KEY": "rw-test"})


@pytest.mark.asyncio
async def test_video_missing_api_key_raises(tmp_path):
    """Must raise ValueError with RUNWAY_API_KEY when key absent."""
    img_path = _create_test_image(tmp_path)
    with pytest.raises(ValueError, match="RUNWAY_API_KEY"):
        await handle_runway_video(
            _video_node(),
            {"image": PortValueDict(type="Image", value=str(img_path))},
            {},
        )


@pytest.mark.asyncio
async def test_video_poll_failure_propagates(tmp_path):
    """Async poll errors must bubble up to the caller."""
    img_path = _create_test_image(tmp_path)
    with patch("handlers.runway.async_poll_execute", new_callable=AsyncMock) as mock_poll:
        mock_poll.side_effect = RuntimeError("Async job failed: moderation")
        with pytest.raises(RuntimeError, match="moderation"):
            await handle_runway_video(
                _video_node(),
                {"image": PortValueDict(type="Image", value=str(img_path))},
                {"RUNWAY_API_KEY": "rw-test"},
            )


# ---------------------------------------------------------------------------
# handle_runway_video — text_to_video path
# ---------------------------------------------------------------------------


@pytest.mark.asyncio
async def test_video_text_only_routes_to_text_to_video():
    """Text-only with a supported model must POST to /text_to_video."""
    with patch("handlers.runway.async_poll_execute", new_callable=AsyncMock) as mock_poll:
        mock_poll.return_value = {"id": "t2", "status": "SUCCEEDED", "output": ["https://ex.com/v.mp4"]}
        with patch("handlers.runway.save_video_from_url", new_callable=AsyncMock) as mock_save:
            mock_save.return_value = Path("/tmp/fake.mp4")
            await handle_runway_video(
                _video_node({"model": "gen4.5", "duration": 5, "ratio": "1280:720"}),
                {"prompt": PortValueDict(type="Text", value="A city at night")},
                {"RUNWAY_API_KEY": "rw-test"},
            )
    config = mock_poll.call_args.kwargs.get("config") or mock_poll.call_args[1]["config"]
    assert config.submit_url.endswith("/text_to_video")


@pytest.mark.asyncio
async def test_video_text_only_unsupported_model_raises():
    """gen4_turbo requires an image — text-only must raise ValueError."""
    with pytest.raises(ValueError, match="requires an image|gen4_turbo"):
        await handle_runway_video(
            _video_node({"model": "gen4_turbo", "duration": 5, "ratio": "1280:720"}),
            {"prompt": PortValueDict(type="Text", value="A mountain")},
            {"RUNWAY_API_KEY": "rw-test"},
        )


@pytest.mark.asyncio
async def test_video_text_only_invalid_ratio_raises():
    """Text-only mode only accepts 1280:720 and 720:1280 ratios per SDK."""
    with pytest.raises(ValueError, match="ratio|1280:720|720:1280"):
        await handle_runway_video(
            _video_node({"model": "gen4.5", "duration": 5, "ratio": "1104:832"}),
            {"prompt": PortValueDict(type="Text", value="A forest")},
            {"RUNWAY_API_KEY": "rw-test"},
        )


# ---------------------------------------------------------------------------
# handle_runway_aleph
# ---------------------------------------------------------------------------


@pytest.mark.asyncio
async def test_aleph_submits_correct_model_and_fields(tmp_path):
    """Model must be gen4_aleph; videoUri and promptText must be present."""
    video_path = _create_test_video(tmp_path)
    with patch("handlers.runway.async_poll_execute", new_callable=AsyncMock) as mock_poll:
        mock_poll.return_value = {"id": "t3", "status": "SUCCEEDED", "output": ["https://ex.com/v.mp4"]}
        with patch("handlers.runway.save_video_from_url", new_callable=AsyncMock) as mock_save:
            mock_save.return_value = tmp_path / "out.mp4"
            (tmp_path / "out.mp4").write_bytes(FAKE_VIDEO_BYTES)
            result = await handle_runway_aleph(
                _aleph_node(),
                {
                    "video": PortValueDict(type="Video", value=str(video_path)),
                    "prompt": PortValueDict(type="Text", value="Transform to night"),
                },
                {"RUNWAY_API_KEY": "rw-test"},
            )

    assert result["video"]["type"] == "Video"
    body = mock_poll.call_args.kwargs.get("submit_body") or mock_poll.call_args[1]["submit_body"]
    assert body["model"] == "gen4_aleph"
    assert "videoUri" in body
    assert body["videoUri"].startswith("data:video/mp4;base64,")
    assert body["promptText"] == "Transform to night"


@pytest.mark.asyncio
async def test_aleph_missing_video_raises():
    with pytest.raises(ValueError, match="[Vv]ideo"):
        await handle_runway_aleph(
            _aleph_node(),
            {"prompt": PortValueDict(type="Text", value="hi")},
            {"RUNWAY_API_KEY": "rw-test"},
        )


@pytest.mark.asyncio
async def test_aleph_missing_prompt_raises(tmp_path):
    video_path = _create_test_video(tmp_path)
    with pytest.raises(ValueError, match="[Pp]rompt"):
        await handle_runway_aleph(
            _aleph_node(),
            {"video": PortValueDict(type="Video", value=str(video_path))},
            {"RUNWAY_API_KEY": "rw-test"},
        )


@pytest.mark.asyncio
async def test_aleph_optional_reference_image(tmp_path):
    """Optional reference image must be sent as references array."""
    video_path = _create_test_video(tmp_path)
    img_path = _create_test_image(tmp_path)
    with patch("handlers.runway.async_poll_execute", new_callable=AsyncMock) as mock_poll:
        mock_poll.return_value = {"id": "t4", "status": "SUCCEEDED", "output": ["https://ex.com/v.mp4"]}
        with patch("handlers.runway.save_video_from_url", new_callable=AsyncMock) as mock_save:
            mock_save.return_value = tmp_path / "out2.mp4"
            (tmp_path / "out2.mp4").write_bytes(FAKE_VIDEO_BYTES)
            await handle_runway_aleph(
                _aleph_node(),
                {
                    "video": PortValueDict(type="Video", value=str(video_path)),
                    "prompt": PortValueDict(type="Text", value="Apply style"),
                    "reference": PortValueDict(type="Image", value=str(img_path)),
                },
                {"RUNWAY_API_KEY": "rw-test"},
            )
    body = mock_poll.call_args.kwargs.get("submit_body") or mock_poll.call_args[1]["submit_body"]
    assert "references" in body
    assert body["references"][0]["type"] == "image"
    assert body["references"][0]["uri"].startswith("data:")


@pytest.mark.asyncio
async def test_aleph_uses_correct_endpoint():
    """Aleph must POST to /video_to_video."""
    with patch("handlers.runway.async_poll_execute", new_callable=AsyncMock) as mock_poll:
        mock_poll.side_effect = RuntimeError("skip")
        try:
            await handle_runway_aleph(
                _aleph_node(),
                {
                    "video": PortValueDict(type="Video", value="https://example.com/v.mp4"),
                    "prompt": PortValueDict(type="Text", value="test"),
                },
                {"RUNWAY_API_KEY": "rw-test"},
            )
        except RuntimeError:
            pass
    config = mock_poll.call_args.kwargs.get("config") or mock_poll.call_args[1]["config"]
    assert config.submit_url.endswith("/video_to_video")


@pytest.mark.asyncio
async def test_aleph_model_param_selects_aleph2(tmp_path):
    """The model param must flow through so Aleph 2.0 is selectable (default stays gen4_aleph)."""
    video_path = _create_test_video(tmp_path)
    with patch("handlers.runway.async_poll_execute", new_callable=AsyncMock) as mock_poll:
        mock_poll.return_value = {"id": "t3b", "status": "SUCCEEDED", "output": ["https://ex.com/v.mp4"]}
        with patch("handlers.runway.save_video_from_url", new_callable=AsyncMock) as mock_save:
            mock_save.return_value = tmp_path / "out.mp4"
            (tmp_path / "out.mp4").write_bytes(FAKE_VIDEO_BYTES)
            await handle_runway_aleph(
                _aleph_node({"model": "aleph2"}),
                {
                    "video": PortValueDict(type="Video", value=str(video_path)),
                    "prompt": PortValueDict(type="Text", value="Make it rain"),
                },
                {"RUNWAY_API_KEY": "rw-test"},
            )

    body = mock_poll.call_args.kwargs.get("submit_body") or mock_poll.call_args[1]["submit_body"]
    assert body["model"] == "aleph2"


# ---------------------------------------------------------------------------
# handle_runway_image
# ---------------------------------------------------------------------------


@pytest.mark.asyncio
async def test_image_submits_correct_fields():
    """Must send model, promptText, ratio to /text_to_image."""
    with patch("handlers.runway.async_poll_execute", new_callable=AsyncMock) as mock_poll:
        mock_poll.return_value = {"id": "t5", "status": "SUCCEEDED", "output": ["https://ex.com/img.png"]}
        with patch("handlers.runway.httpx.AsyncClient") as mock_client_cls:
            mock_resp = MagicMock()
            mock_resp.content = base64.b64decode(RED_PIXEL_B64)
            mock_resp.raise_for_status = MagicMock()
            mock_ctx = AsyncMock()
            mock_ctx.__aenter__ = AsyncMock(return_value=mock_ctx)
            mock_ctx.__aexit__ = AsyncMock(return_value=False)
            mock_ctx.get = AsyncMock(return_value=mock_resp)
            mock_client_cls.return_value = mock_ctx
            with patch("handlers.runway.save_base64_image") as mock_save_img:
                mock_save_img.return_value = Path("/tmp/fake.png")
                result = await handle_runway_image(
                    _image_node(),
                    {"prompt": PortValueDict(type="Text", value="A sunset")},
                    {"RUNWAY_API_KEY": "rw-test"},
                )

    assert result["image"]["type"] == "Image"
    body = mock_poll.call_args.kwargs.get("submit_body") or mock_poll.call_args[1]["submit_body"]
    assert body["model"] == "gen4_image"
    assert body["promptText"] == "A sunset"
    assert body["ratio"] == "1360:768"
    config = mock_poll.call_args.kwargs.get("config") or mock_poll.call_args[1]["config"]
    assert config.submit_url.endswith("/text_to_image")


@pytest.mark.asyncio
async def test_image_missing_prompt_raises():
    with pytest.raises(ValueError, match="[Pp]rompt"):
        await handle_runway_image(_image_node(), {}, {"RUNWAY_API_KEY": "rw-test"})


@pytest.mark.asyncio
async def test_image_reference_images_structure(tmp_path):
    """referenceImages must be list of {uri:...} objects (max 3)."""
    img_path = _create_test_image(tmp_path)
    with patch("handlers.runway.async_poll_execute", new_callable=AsyncMock) as mock_poll:
        mock_poll.return_value = {"id": "t6", "status": "SUCCEEDED", "output": ["https://ex.com/img.png"]}
        with patch("handlers.runway.httpx.AsyncClient") as mock_client_cls:
            mock_resp = MagicMock()
            mock_resp.content = base64.b64decode(RED_PIXEL_B64)
            mock_resp.raise_for_status = MagicMock()
            mock_ctx = AsyncMock()
            mock_ctx.__aenter__ = AsyncMock(return_value=mock_ctx)
            mock_ctx.__aexit__ = AsyncMock(return_value=False)
            mock_ctx.get = AsyncMock(return_value=mock_resp)
            mock_client_cls.return_value = mock_ctx
            with patch("handlers.runway.save_base64_image", return_value=Path("/tmp/fake.png")):
                await handle_runway_image(
                    _image_node(),
                    {
                        "prompt": PortValueDict(type="Text", value="Style transfer"),
                        "images": PortValueDict(type="Image", value=str(img_path)),
                    },
                    {"RUNWAY_API_KEY": "rw-test"},
                )
    body = mock_poll.call_args.kwargs.get("submit_body") or mock_poll.call_args[1]["submit_body"]
    assert "referenceImages" in body
    assert isinstance(body["referenceImages"], list)
    assert "uri" in body["referenceImages"][0]


@pytest.mark.asyncio
async def test_image_no_output_raises():
    with patch("handlers.runway.async_poll_execute", new_callable=AsyncMock) as mock_poll:
        mock_poll.return_value = {"id": "t7", "status": "SUCCEEDED", "output": []}
        with pytest.raises(RuntimeError, match="[Nn]o output"):
            await handle_runway_image(
                _image_node(),
                {"prompt": PortValueDict(type="Text", value="Sky")},
                {"RUNWAY_API_KEY": "rw-test"},
            )


# ---------------------------------------------------------------------------
# handle_runway_image_upscale
# ---------------------------------------------------------------------------


def _upscale_node(params=None):
    return _make_node("runway-upscale", params or {})


def _mock_image_download():
    """Patch context for the post-poll image download."""
    mock_resp = MagicMock()
    mock_resp.content = base64.b64decode(RED_PIXEL_B64)
    mock_resp.raise_for_status = MagicMock()
    mock_ctx = AsyncMock()
    mock_ctx.__aenter__ = AsyncMock(return_value=mock_ctx)
    mock_ctx.__aexit__ = AsyncMock(return_value=False)
    mock_ctx.get = AsyncMock(return_value=mock_resp)
    return mock_ctx


@pytest.mark.asyncio
async def test_upscale_submits_model_image_and_scale(tmp_path):
    """Body must pin magnific_precision_upscaler_v2 with imageUri (data URI) + scaleFactor."""
    img_path = _create_test_image(tmp_path)
    with patch("handlers.runway.async_poll_execute", new_callable=AsyncMock) as mock_poll:
        mock_poll.return_value = {"id": "t8", "status": "SUCCEEDED", "output": ["https://ex.com/up.png"]}
        with patch("handlers.runway.httpx.AsyncClient") as mock_client_cls:
            mock_client_cls.return_value = _mock_image_download()
            with patch("handlers.runway.save_base64_image") as mock_save_img:
                mock_save_img.return_value = Path("/tmp/fake.png")
                result = await handle_runway_image_upscale(
                    _upscale_node({"scaleFactor": 4, "flavor": "photo"}),
                    {"image": PortValueDict(type="Image", value=str(img_path))},
                    {"RUNWAY_API_KEY": "rw-test"},
                )

    assert result["image"]["type"] == "Image"
    body = mock_poll.call_args.kwargs.get("submit_body") or mock_poll.call_args[1]["submit_body"]
    assert body["model"] == "magnific_precision_upscaler_v2"
    assert body["imageUri"].startswith("data:image/")
    assert body["scaleFactor"] == 4
    assert body["flavor"] == "photo"
    config = mock_poll.call_args.kwargs.get("config") or mock_poll.call_args[1]["config"]
    assert config.submit_url.endswith("/image_upscale")


@pytest.mark.asyncio
async def test_upscale_optional_enhancers_forwarded(tmp_path):
    """sharpen/smartGrain/ultraDetail forwarded only when set."""
    img_path = _create_test_image(tmp_path)
    with patch("handlers.runway.async_poll_execute", new_callable=AsyncMock) as mock_poll:
        mock_poll.return_value = {"id": "t9", "status": "SUCCEEDED", "output": ["https://ex.com/up.png"]}
        with patch("handlers.runway.httpx.AsyncClient") as mock_client_cls:
            mock_client_cls.return_value = _mock_image_download()
            with patch("handlers.runway.save_base64_image") as mock_save_img:
                mock_save_img.return_value = Path("/tmp/fake.png")
                await handle_runway_image_upscale(
                    _upscale_node({"sharpen": 40, "ultraDetail": 60}),
                    {"image": PortValueDict(type="Image", value=str(img_path))},
                    {"RUNWAY_API_KEY": "rw-test"},
                )

    body = mock_poll.call_args.kwargs.get("submit_body") or mock_poll.call_args[1]["submit_body"]
    assert body["sharpen"] == 40
    assert body["ultraDetail"] == 60
    assert "smartGrain" not in body
    # default scale factor applies when unset
    assert body["scaleFactor"] == 2


@pytest.mark.asyncio
async def test_upscale_missing_image_raises():
    with pytest.raises(ValueError, match="[Ii]mage"):
        await handle_runway_image_upscale(_upscale_node(), {}, {"RUNWAY_API_KEY": "rw-test"})


@pytest.mark.asyncio
async def test_upscale_missing_api_key_raises(tmp_path):
    img_path = _create_test_image(tmp_path)
    with pytest.raises(ValueError, match="RUNWAY_API_KEY"):
        await handle_runway_image_upscale(
            _upscale_node(),
            {"image": PortValueDict(type="Image", value=str(img_path))},
            {},
        )


# ---------------------------------------------------------------------------
# handle_runway_act_two
# ---------------------------------------------------------------------------


@pytest.mark.asyncio
async def test_act_two_with_character_image(tmp_path):
    """character must be {type:image, uri:...} when character_image provided."""
    img_path = _create_test_image(tmp_path)
    ref_path = _create_test_video(tmp_path)
    with patch("handlers.runway.async_poll_execute", new_callable=AsyncMock) as mock_poll:
        mock_poll.return_value = {"id": "t8", "status": "SUCCEEDED", "output": ["https://ex.com/v.mp4"]}
        with patch("handlers.runway.save_video_from_url", new_callable=AsyncMock) as mock_save:
            mock_save.return_value = tmp_path / "out.mp4"
            (tmp_path / "out.mp4").write_bytes(FAKE_VIDEO_BYTES)
            result = await handle_runway_act_two(
                _act_two_node(),
                {
                    "character_image": PortValueDict(type="Image", value=str(img_path)),
                    "reference": PortValueDict(type="Video", value=str(ref_path)),
                },
                {"RUNWAY_API_KEY": "rw-test"},
            )
    assert result["video"]["type"] == "Video"
    body = mock_poll.call_args.kwargs.get("submit_body") or mock_poll.call_args[1]["submit_body"]
    assert body["model"] == "act_two"
    assert body["character"]["type"] == "image"
    assert body["character"]["uri"].startswith("data:")
    assert body["reference"]["type"] == "video"


@pytest.mark.asyncio
async def test_act_two_missing_character_raises(tmp_path):
    ref_path = _create_test_video(tmp_path)
    with pytest.raises(ValueError, match="[Cc]haracter"):
        await handle_runway_act_two(
            _act_two_node(),
            {"reference": PortValueDict(type="Video", value=str(ref_path))},
            {"RUNWAY_API_KEY": "rw-test"},
        )


@pytest.mark.asyncio
async def test_act_two_missing_reference_raises(tmp_path):
    img_path = _create_test_image(tmp_path)
    with pytest.raises(ValueError, match="[Rr]eference"):
        await handle_runway_act_two(
            _act_two_node(),
            {"character_image": PortValueDict(type="Image", value=str(img_path))},
            {"RUNWAY_API_KEY": "rw-test"},
        )


@pytest.mark.asyncio
async def test_act_two_uses_correct_endpoint(tmp_path):
    img_path = _create_test_image(tmp_path)
    ref_path = _create_test_video(tmp_path)
    with patch("handlers.runway.async_poll_execute", new_callable=AsyncMock) as mock_poll:
        mock_poll.side_effect = RuntimeError("skip")
        try:
            await handle_runway_act_two(
                _act_two_node(),
                {
                    "character_image": PortValueDict(type="Image", value=str(img_path)),
                    "reference": PortValueDict(type="Video", value=str(ref_path)),
                },
                {"RUNWAY_API_KEY": "rw-test"},
            )
        except RuntimeError:
            pass
    config = mock_poll.call_args.kwargs.get("config") or mock_poll.call_args[1]["config"]
    assert config.submit_url.endswith("/character_performance")


@pytest.mark.asyncio
async def test_act_two_optional_params_forwarded(tmp_path):
    """expressionIntensity and bodyControl must be sent when set."""
    img_path = _create_test_image(tmp_path)
    ref_path = _create_test_video(tmp_path)
    with patch("handlers.runway.async_poll_execute", new_callable=AsyncMock) as mock_poll:
        mock_poll.return_value = {"id": "t9", "status": "SUCCEEDED", "output": ["https://ex.com/v.mp4"]}
        with patch("handlers.runway.save_video_from_url", new_callable=AsyncMock) as mock_save:
            mock_save.return_value = tmp_path / "out.mp4"
            (tmp_path / "out.mp4").write_bytes(FAKE_VIDEO_BYTES)
            await handle_runway_act_two(
                _act_two_node({"expressionIntensity": 5, "bodyControl": True}),
                {
                    "character_image": PortValueDict(type="Image", value=str(img_path)),
                    "reference": PortValueDict(type="Video", value=str(ref_path)),
                },
                {"RUNWAY_API_KEY": "rw-test"},
            )
    body = mock_poll.call_args.kwargs.get("submit_body") or mock_poll.call_args[1]["submit_body"]
    assert body["expressionIntensity"] == 5
    assert body["bodyControl"] is True


# ---------------------------------------------------------------------------
# handle_runway_tts
# ---------------------------------------------------------------------------


@pytest.mark.asyncio
async def test_tts_submits_correct_model_and_voice():
    """Must send eleven_multilingual_v2 and voice.presetId via /text_to_speech."""
    with patch("handlers.runway.async_poll_execute", new_callable=AsyncMock) as mock_poll:
        mock_poll.return_value = {"id": "ta", "status": "SUCCEEDED", "output": ["https://ex.com/audio.mp3"]}
        with patch("handlers.runway._save_audio_from_url", new_callable=AsyncMock) as mock_audio:
            mock_audio.return_value = "/tmp/audio.mp3"
            result = await handle_runway_tts(
                _tts_node(),
                {"text": PortValueDict(type="Text", value="Hello world")},
                {"RUNWAY_API_KEY": "rw-test"},
            )

    assert result["audio"]["type"] == "Audio"
    body = mock_poll.call_args.kwargs.get("submit_body") or mock_poll.call_args[1]["submit_body"]
    assert body["model"] == "eleven_multilingual_v2"
    assert body["promptText"] == "Hello world"
    assert body["voice"]["type"] == "runway-preset"
    assert body["voice"]["presetId"] == "Maya"
    config = mock_poll.call_args.kwargs.get("config") or mock_poll.call_args[1]["config"]
    assert config.submit_url.endswith("/text_to_speech")


@pytest.mark.asyncio
async def test_tts_missing_text_raises():
    with pytest.raises(ValueError, match="[Tt]ext"):
        await handle_runway_tts(_tts_node(), {}, {"RUNWAY_API_KEY": "rw-test"})


@pytest.mark.asyncio
async def test_tts_missing_api_key_raises():
    with pytest.raises(ValueError, match="RUNWAY_API_KEY"):
        await handle_runway_tts(
            _tts_node(),
            {"text": PortValueDict(type="Text", value="hi")},
            {},
        )


@pytest.mark.asyncio
async def test_tts_no_output_raises():
    with patch("handlers.runway.async_poll_execute", new_callable=AsyncMock) as mock_poll:
        mock_poll.return_value = {"id": "tb", "status": "SUCCEEDED", "output": []}
        with pytest.raises(RuntimeError, match="[Nn]o output"):
            await handle_runway_tts(
                _tts_node(),
                {"text": PortValueDict(type="Text", value="hi")},
                {"RUNWAY_API_KEY": "rw-test"},
            )


# ---------------------------------------------------------------------------
# handle_runway_speech_to_speech
# ---------------------------------------------------------------------------


@pytest.mark.asyncio
async def test_sts_audio_input_submits_correct_fields(tmp_path):
    """Must send eleven_multilingual_sts_v2, media.type=audio, voice.presetId."""
    audio_path = _create_test_audio(tmp_path)
    with patch("handlers.runway.async_poll_execute", new_callable=AsyncMock) as mock_poll:
        mock_poll.return_value = {"id": "tc", "status": "SUCCEEDED", "output": ["https://ex.com/a.mp3"]}
        with patch("handlers.runway._save_audio_from_url", new_callable=AsyncMock) as mock_audio:
            mock_audio.return_value = "/tmp/out.mp3"
            result = await handle_runway_speech_to_speech(
                _sts_node(),
                {"audio": PortValueDict(type="Audio", value=str(audio_path))},
                {"RUNWAY_API_KEY": "rw-test"},
            )

    assert result["audio"]["type"] == "Audio"
    body = mock_poll.call_args.kwargs.get("submit_body") or mock_poll.call_args[1]["submit_body"]
    assert body["model"] == "eleven_multilingual_sts_v2"
    assert body["media"]["type"] == "audio"
    assert body["media"]["uri"].startswith("data:audio/mpeg;base64,")
    assert body["voice"]["type"] == "runway-preset"
    assert body["voice"]["presetId"] == "Maya"
    config = mock_poll.call_args.kwargs.get("config") or mock_poll.call_args[1]["config"]
    assert config.submit_url.endswith("/speech_to_speech")


@pytest.mark.asyncio
async def test_sts_video_input_sets_media_type_video(tmp_path):
    """When video is provided instead of audio, media.type must be 'video'."""
    video_path = _create_test_video(tmp_path)
    with patch("handlers.runway.async_poll_execute", new_callable=AsyncMock) as mock_poll:
        mock_poll.return_value = {"id": "td", "status": "SUCCEEDED", "output": ["https://ex.com/a.mp3"]}
        with patch("handlers.runway._save_audio_from_url", new_callable=AsyncMock) as mock_audio:
            mock_audio.return_value = "/tmp/out.mp3"
            await handle_runway_speech_to_speech(
                _sts_node(),
                {"video": PortValueDict(type="Video", value=str(video_path))},
                {"RUNWAY_API_KEY": "rw-test"},
            )
    body = mock_poll.call_args.kwargs.get("submit_body") or mock_poll.call_args[1]["submit_body"]
    assert body["media"]["type"] == "video"
    assert body["media"]["uri"].startswith("data:video/mp4;base64,")


@pytest.mark.asyncio
async def test_sts_remove_background_noise_forwarded(tmp_path):
    """removeBackgroundNoise must be in body when set to True."""
    audio_path = _create_test_audio(tmp_path)
    with patch("handlers.runway.async_poll_execute", new_callable=AsyncMock) as mock_poll:
        mock_poll.return_value = {"id": "te", "status": "SUCCEEDED", "output": ["https://ex.com/a.mp3"]}
        with patch("handlers.runway._save_audio_from_url", new_callable=AsyncMock) as mock_audio:
            mock_audio.return_value = "/tmp/out.mp3"
            await handle_runway_speech_to_speech(
                _sts_node({"voiceId": "Maya", "removeBackgroundNoise": True}),
                {"audio": PortValueDict(type="Audio", value=str(audio_path))},
                {"RUNWAY_API_KEY": "rw-test"},
            )
    body = mock_poll.call_args.kwargs.get("submit_body") or mock_poll.call_args[1]["submit_body"]
    assert body["removeBackgroundNoise"] is True


@pytest.mark.asyncio
async def test_sts_missing_input_raises():
    with pytest.raises(ValueError, match="[Aa]udio|[Vv]ideo"):
        await handle_runway_speech_to_speech(_sts_node(), {}, {"RUNWAY_API_KEY": "rw-test"})


# ---------------------------------------------------------------------------
# handle_runway_voice_dubbing
# ---------------------------------------------------------------------------


@pytest.mark.asyncio
async def test_dubbing_submits_correct_fields(tmp_path):
    """Must send audioUri, targetLang to /voice_dubbing."""
    audio_path = _create_test_audio(tmp_path)
    with patch("handlers.runway.async_poll_execute", new_callable=AsyncMock) as mock_poll:
        mock_poll.return_value = {"id": "tf", "status": "SUCCEEDED", "output": ["https://ex.com/a.mp3"]}
        with patch("handlers.runway._save_audio_from_url", new_callable=AsyncMock) as mock_audio:
            mock_audio.return_value = "/tmp/out.mp3"
            result = await handle_runway_voice_dubbing(
                _dubbing_node(),
                {"audio": PortValueDict(type="Audio", value=str(audio_path))},
                {"RUNWAY_API_KEY": "rw-test"},
            )

    assert result["audio"]["type"] == "Audio"
    body = mock_poll.call_args.kwargs.get("submit_body") or mock_poll.call_args[1]["submit_body"]
    assert "audioUri" in body
    assert body["audioUri"].startswith("data:audio/mpeg;base64,")
    assert body["targetLang"] == "es"
    config = mock_poll.call_args.kwargs.get("config") or mock_poll.call_args[1]["config"]
    assert config.submit_url.endswith("/voice_dubbing")


@pytest.mark.asyncio
async def test_dubbing_optional_params_forwarded(tmp_path):
    """disableVoiceCloning, dropBackgroundAudio, numSpeakers must be forwarded when set."""
    audio_path = _create_test_audio(tmp_path)
    with patch("handlers.runway.async_poll_execute", new_callable=AsyncMock) as mock_poll:
        mock_poll.return_value = {"id": "tg", "status": "SUCCEEDED", "output": ["https://ex.com/a.mp3"]}
        with patch("handlers.runway._save_audio_from_url", new_callable=AsyncMock) as mock_audio:
            mock_audio.return_value = "/tmp/out.mp3"
            await handle_runway_voice_dubbing(
                _dubbing_node({
                    "targetLang": "fr",
                    "disableVoiceCloning": True,
                    "dropBackgroundAudio": True,
                    "numSpeakers": 2,
                }),
                {"audio": PortValueDict(type="Audio", value=str(audio_path))},
                {"RUNWAY_API_KEY": "rw-test"},
            )
    body = mock_poll.call_args.kwargs.get("submit_body") or mock_poll.call_args[1]["submit_body"]
    assert body["disableVoiceCloning"] is True
    assert body["dropBackgroundAudio"] is True
    assert body["numSpeakers"] == 2
    assert body["targetLang"] == "fr"


@pytest.mark.asyncio
async def test_dubbing_missing_audio_raises():
    with pytest.raises(ValueError, match="[Aa]udio"):
        await handle_runway_voice_dubbing(_dubbing_node(), {}, {"RUNWAY_API_KEY": "rw-test"})


@pytest.mark.asyncio
async def test_dubbing_missing_api_key_raises(tmp_path):
    audio_path = _create_test_audio(tmp_path)
    with pytest.raises(ValueError, match="RUNWAY_API_KEY"):
        await handle_runway_voice_dubbing(
            _dubbing_node(),
            {"audio": PortValueDict(type="Audio", value=str(audio_path))},
            {},
        )


@pytest.mark.asyncio
async def test_dubbing_no_output_raises(tmp_path):
    audio_path = _create_test_audio(tmp_path)
    with patch("handlers.runway.async_poll_execute", new_callable=AsyncMock) as mock_poll:
        mock_poll.return_value = {"id": "th", "status": "SUCCEEDED", "output": []}
        with pytest.raises(RuntimeError, match="[Nn]o output"):
            await handle_runway_voice_dubbing(
                _dubbing_node(),
                {"audio": PortValueDict(type="Audio", value=str(audio_path))},
                {"RUNWAY_API_KEY": "rw-test"},
            )


# ---------------------------------------------------------------------------
# URL-passed inputs (https:// bypass local file path logic)
# ---------------------------------------------------------------------------


@pytest.mark.asyncio
async def test_aleph_accepts_https_video_uri():
    """Remote HTTPS video URL must be passed through without base64 encoding."""
    with patch("handlers.runway.async_poll_execute", new_callable=AsyncMock) as mock_poll:
        mock_poll.return_value = {"id": "ti", "status": "SUCCEEDED", "output": ["https://ex.com/v.mp4"]}
        with patch("handlers.runway.save_video_from_url", new_callable=AsyncMock) as mock_save:
            mock_save.return_value = Path("/tmp/fake.mp4")
            await handle_runway_aleph(
                _aleph_node(),
                {
                    "video": PortValueDict(type="Video", value="https://example.com/input.mp4"),
                    "prompt": PortValueDict(type="Text", value="Style"),
                },
                {"RUNWAY_API_KEY": "rw-test"},
            )
    body = mock_poll.call_args.kwargs.get("submit_body") or mock_poll.call_args[1]["submit_body"]
    assert body["videoUri"] == "https://example.com/input.mp4"


@pytest.mark.asyncio
async def test_sts_accepts_https_audio_uri():
    """Remote HTTPS audio URL must be passed through without base64 encoding."""
    with patch("handlers.runway.async_poll_execute", new_callable=AsyncMock) as mock_poll:
        mock_poll.return_value = {"id": "tj", "status": "SUCCEEDED", "output": ["https://ex.com/a.mp3"]}
        with patch("handlers.runway._save_audio_from_url", new_callable=AsyncMock) as mock_audio:
            mock_audio.return_value = "/tmp/out.mp3"
            await handle_runway_speech_to_speech(
                _sts_node(),
                {"audio": PortValueDict(type="Audio", value="https://example.com/voice.mp3")},
                {"RUNWAY_API_KEY": "rw-test"},
            )
    body = mock_poll.call_args.kwargs.get("submit_body") or mock_poll.call_args[1]["submit_body"]
    assert body["media"]["uri"] == "https://example.com/voice.mp3"
