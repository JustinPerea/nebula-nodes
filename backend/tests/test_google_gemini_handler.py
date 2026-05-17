from __future__ import annotations

import base64
import json
import shutil
from pathlib import Path
from unittest.mock import AsyncMock, MagicMock, patch

import pytest

from handlers.google_gemini import (
    handle_gemini_chat,
    handle_imagen4,
    handle_nano_banana,
    handle_lyria3,
    handle_gemini_tts,
    handle_gemini_embeddings,
)
from models.graph import GraphNode, PortValueDict
from models.events import StreamDeltaEvent
from services.output import OUTPUT_ROOT


RED_PIXEL_B64 = (
    "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR4"
    "2mP8/5+hHgAHggJ/PchI7wAAAABJRU5ErkJggg=="
)


def _make_gemini_node(params=None):
    return GraphNode(
        id="test-gemini-1",
        definitionId="gemini-chat",
        params=params or {"model": "gemini-2.5-flash", "max_tokens": 1024, "temperature": 1.0},
    )


def _make_imagen_node(params=None):
    return GraphNode(
        id="test-imagen-1",
        definitionId="imagen-4-generate",
        params=params or {"model": "imagen-4.0-generate-001", "aspectRatio": "1:1", "numberOfImages": 1},
    )


class FakeStreamResponse:
    def __init__(self, sse_lines, status_code=200):
        self.status_code = status_code
        self._lines = sse_lines

    async def aiter_lines(self):
        for line in self._lines:
            yield line

    async def aiter_text(self):
        yield "error body"

    async def __aenter__(self):
        return self

    async def __aexit__(self, *args):
        pass


def _make_gemini_sse_lines(text_chunks):
    """Build Gemini-style SSE lines (candidates array format)."""
    lines = []
    for chunk in text_chunks:
        data = {
            "candidates": [
                {
                    "content": {
                        "parts": [{"text": chunk}],
                        "role": "model",
                    },
                    "finishReason": None,
                    "index": 0,
                }
            ]
        }
        lines.append(f"data: {json.dumps(data)}")
        lines.append("")
    return lines


@pytest.fixture(autouse=True)
def cleanup_output():
    """OUTPUT_ROOT is sandboxed via NEBULA_OUTPUT_ROOT in tests/conftest.py,
    so wholesale rmtree is both unnecessary and dangerous (it would wipe the
    user's real output/ if the env var ever got lost). No-op hook kept for
    future per-test isolation."""
    yield


# --- Gemini chat tests ---

@pytest.mark.asyncio
async def test_gemini_streams_text_and_returns_accumulated():
    chunks = ["Gemini", " says", " hello!"]
    fake_response = FakeStreamResponse(_make_gemini_sse_lines(chunks))
    collected = []

    async def capture_emit(event):
        if isinstance(event, StreamDeltaEvent):
            collected.append(event)

    with patch("execution.stream_runner.httpx.AsyncClient") as MockClient:
        mock_client = AsyncMock()
        mock_client.stream = MagicMock(return_value=fake_response)
        mock_client.__aenter__ = AsyncMock(return_value=mock_client)
        mock_client.__aexit__ = AsyncMock(return_value=False)
        MockClient.return_value = mock_client

        result = await handle_gemini_chat(
            _make_gemini_node(),
            {"messages": PortValueDict(type="Text", value="Say hello")},
            {"GOOGLE_API_KEY": "test-google-key"},
            emit=capture_emit,
        )

    assert result["text"]["value"] == "Gemini says hello!"
    assert len(collected) == 3

    # stream("POST", url, ...) — url is the second positional arg
    call_args = mock_client.stream.call_args
    pos_args = call_args.args if call_args.args else call_args[0]
    url = pos_args[1] if len(pos_args) > 1 else call_args.kwargs.get("url", "")
    assert "streamGenerateContent" in url
    assert "alt=sse" in url
    # Auth is via x-goog-api-key header, not query param
    headers = call_args.kwargs.get("headers", {})
    assert headers.get("x-goog-api-key") == "test-google-key"


@pytest.mark.asyncio
async def test_gemini_missing_messages_raises():
    with pytest.raises(ValueError, match="[Mm]essages.*required"):
        await handle_gemini_chat(_make_gemini_node(), {}, {"GOOGLE_API_KEY": "key"})


@pytest.mark.asyncio
async def test_gemini_missing_api_key_raises():
    with pytest.raises(ValueError, match="GOOGLE_API_KEY"):
        await handle_gemini_chat(
            _make_gemini_node(),
            {"messages": PortValueDict(type="Text", value="hi")},
            {},
        )


@pytest.mark.asyncio
async def test_gemini_request_body_structure():
    fake_response = FakeStreamResponse(_make_gemini_sse_lines(["ok"]))

    with patch("execution.stream_runner.httpx.AsyncClient") as MockClient:
        mock_client = AsyncMock()
        mock_client.stream = MagicMock(return_value=fake_response)
        mock_client.__aenter__ = AsyncMock(return_value=mock_client)
        mock_client.__aexit__ = AsyncMock(return_value=False)
        MockClient.return_value = mock_client

        await handle_gemini_chat(
            _make_gemini_node({"model": "gemini-2.5-pro", "temperature": 0.7, "max_tokens": 2048}),
            {"messages": PortValueDict(type="Text", value="test")},
            {"GOOGLE_API_KEY": "test-key"},
        )

    body = mock_client.stream.call_args.kwargs.get("json") or mock_client.stream.call_args[1].get("json")
    assert body["contents"][0]["role"] == "user"
    assert body["contents"][0]["parts"][0]["text"] == "test"
    assert body["generationConfig"]["temperature"] == 0.7
    assert body["generationConfig"]["maxOutputTokens"] == 2048


# --- Imagen 4 tests ---

@pytest.mark.asyncio
async def test_imagen4_generates_image_and_saves_file():
    mock_resp = MagicMock()
    mock_resp.status_code = 200
    mock_resp.json.return_value = {
        "predictions": [
            {"bytesBase64Encoded": RED_PIXEL_B64, "mimeType": "image/png"}
        ]
    }

    with patch("handlers.google_gemini.httpx.AsyncClient") as MockClient:
        mock_client_instance = AsyncMock()
        mock_client_instance.post.return_value = mock_resp
        mock_client_instance.__aenter__ = AsyncMock(return_value=mock_client_instance)
        mock_client_instance.__aexit__ = AsyncMock(return_value=False)
        MockClient.return_value = mock_client_instance

        result = await handle_imagen4(
            _make_imagen_node(),
            {"prompt": PortValueDict(type="Text", value="a red pixel")},
            {"GOOGLE_API_KEY": "test-google-key"},
        )

    assert "image" in result
    assert result["image"]["type"] == "Image"
    file_path = Path(result["image"]["value"])
    assert file_path.suffix == ".png"

    call_kwargs = mock_client_instance.post.call_args
    url = call_kwargs.args[0] if call_kwargs.args else call_kwargs.kwargs.get("url", "")
    assert ":predict" in url
    # Auth is via x-goog-api-key header, not query param
    headers = call_kwargs.kwargs.get("headers", {})
    assert headers.get("x-goog-api-key") == "test-google-key"


@pytest.mark.asyncio
async def test_imagen4_missing_prompt_raises():
    with pytest.raises(ValueError, match="[Pp]rompt.*required"):
        await handle_imagen4(_make_imagen_node(), {}, {"GOOGLE_API_KEY": "key"})


@pytest.mark.asyncio
async def test_imagen4_missing_api_key_raises():
    with pytest.raises(ValueError, match="GOOGLE_API_KEY"):
        await handle_imagen4(
            _make_imagen_node(),
            {"prompt": PortValueDict(type="Text", value="test")},
            {},
        )


@pytest.mark.asyncio
async def test_imagen4_api_error_propagates():
    mock_resp = MagicMock()
    mock_resp.status_code = 403
    mock_resp.text = "Forbidden"

    with patch("handlers.google_gemini.httpx.AsyncClient") as MockClient:
        mock_client_instance = AsyncMock()
        mock_client_instance.post.return_value = mock_resp
        mock_client_instance.__aenter__ = AsyncMock(return_value=mock_client_instance)
        mock_client_instance.__aexit__ = AsyncMock(return_value=False)
        MockClient.return_value = mock_client_instance

        with pytest.raises(RuntimeError, match="Imagen 4 API error 403"):
            await handle_imagen4(
                _make_imagen_node(),
                {"prompt": PortValueDict(type="Text", value="test")},
                {"GOOGLE_API_KEY": "bad-key"},
            )


# --- Nano Banana tests (generationConfig.imageConfig) ---

def _make_nano_node(params=None):
    return GraphNode(
        id="test-nano-1",
        definitionId="nano-banana",
        params=params or {"model": "gemini-3.1-flash-image-preview"},
    )


@pytest.mark.asyncio
async def test_nano_banana_aspect_ratio_uses_image_config():
    """Verifies aspect_ratio is sent as generationConfig.imageConfig.aspectRatio.

    An earlier audit changed this to responseFormat.image based on the public
    docs, but the live v1beta API rejects "1:1" through that path (the proto
    enum doesn't accept the natural string form). The pre-audit imageConfig
    path accepts the natural values — confirmed via direct curl 2026-05-17.
    """
    nano_resp = {
        "candidates": [{
            "content": {
                "parts": [{"inlineData": {"mimeType": "image/png", "data": RED_PIXEL_B64}}]
            }
        }]
    }
    mock_resp = MagicMock()
    mock_resp.status_code = 200
    mock_resp.json.return_value = nano_resp

    with patch("handlers.google_gemini.httpx.AsyncClient") as MockClient:
        mock_client_instance = AsyncMock()
        mock_client_instance.post.return_value = mock_resp
        mock_client_instance.__aenter__ = AsyncMock(return_value=mock_client_instance)
        mock_client_instance.__aexit__ = AsyncMock(return_value=False)
        MockClient.return_value = mock_client_instance

        result = await handle_nano_banana(
            _make_nano_node({"model": "gemini-3.1-flash-image-preview", "aspect_ratio": "16:9", "imageSize": "2K"}),
            {"prompt": PortValueDict(type="Text", value="a sunset")},
            {"GOOGLE_API_KEY": "test-key"},
        )

    assert "image" in result
    body = mock_client_instance.post.call_args.kwargs.get("json") or mock_client_instance.post.call_args[1].get("json")
    gen_cfg = body.get("generationConfig", {})
    # Must use imageConfig (responseFormat.image accepts the field but rejects natural value strings)
    assert "responseFormat" not in gen_cfg, "responseFormat.image rejects '1:1'/'16:9'; use imageConfig"
    assert gen_cfg.get("imageConfig", {}).get("aspectRatio") == "16:9"
    assert gen_cfg.get("imageConfig", {}).get("imageSize") == "2K"


# --- Lyria 3 tests (responseMimeType → responseFormat.audio fix) ---

def _make_lyria_node(params=None):
    return GraphNode(
        id="test-lyria-1",
        definitionId="lyria-3",
        params=params or {"model": "lyria-3-clip-preview"},
    )


@pytest.mark.asyncio
async def test_lyria3_wav_uses_response_format():
    """Verifies WAV output uses generationConfig.responseFormat.audio.mimeType with
    the proto enum value "AUDIO_WAV" — verified via direct curl 2026-05-17. The pre-audit
    code used `responseMimeType` (only accepts text mimes); an interim audit used
    `responseFormat.audio.mimeType = "audio/wav"` (path right, value rejected by proto)."""
    SILENCE_MP3_B64 = base64.b64encode(b"\xff\xfb" + b"\x00" * 26).decode()
    lyria_resp = {
        "candidates": [{
            "content": {
                "parts": [{"inlineData": {"mimeType": "audio/wav", "data": SILENCE_MP3_B64}}]
            }
        }]
    }
    mock_resp = MagicMock()
    mock_resp.status_code = 200
    mock_resp.json.return_value = lyria_resp

    with patch("handlers.google_gemini.httpx.AsyncClient") as MockClient:
        mock_client_instance = AsyncMock()
        mock_client_instance.post.return_value = mock_resp
        mock_client_instance.__aenter__ = AsyncMock(return_value=mock_client_instance)
        mock_client_instance.__aexit__ = AsyncMock(return_value=False)
        MockClient.return_value = mock_client_instance

        result = await handle_lyria3(
            _make_lyria_node({"model": "lyria-3-pro-preview", "outputFormat": "wav"}),
            {"prompt": PortValueDict(type="Text", value="upbeat jazz")},
            {"GOOGLE_API_KEY": "test-key"},
        )

    assert "audio" in result
    body = mock_client_instance.post.call_args.kwargs.get("json") or mock_client_instance.post.call_args[1].get("json")
    gen_cfg = body.get("generationConfig", {})
    # Must use responseFormat.audio with proto enum value AUDIO_WAV
    assert "responseMimeType" not in gen_cfg, "responseMimeType only accepts text mimes; use responseFormat.audio"
    assert gen_cfg.get("responseFormat", {}).get("audio", {}).get("mimeType") == "AUDIO_WAV"


# --- Gemini TTS tests ---

def _make_tts_node(params=None):
    return GraphNode(
        id="test-tts-1",
        definitionId="gemini-tts",
        params=params or {"model": "gemini-2.5-flash-preview-tts", "voiceName": "Kore"},
    )


@pytest.mark.asyncio
async def test_gemini_tts_returns_audio_file():
    """Verifies TTS returns a .wav file path at audio port."""
    import wave, io, struct
    # Build a minimal valid PCM payload (1 sample = 2 bytes)
    pcm_bytes = struct.pack("<h", 0)
    pcm_b64 = base64.b64encode(pcm_bytes).decode()

    tts_resp = {
        "candidates": [{
            "content": {
                "parts": [{"inlineData": {"mimeType": "audio/pcm", "data": pcm_b64}}]
            }
        }]
    }
    mock_resp = MagicMock()
    mock_resp.status_code = 200
    mock_resp.json.return_value = tts_resp

    with patch("handlers.google_gemini.httpx.AsyncClient") as MockClient:
        mock_client_instance = AsyncMock()
        mock_client_instance.post.return_value = mock_resp
        mock_client_instance.__aenter__ = AsyncMock(return_value=mock_client_instance)
        mock_client_instance.__aexit__ = AsyncMock(return_value=False)
        MockClient.return_value = mock_client_instance

        result = await handle_gemini_tts(
            _make_tts_node(),
            {"text": PortValueDict(type="Text", value="Hello world")},
            {"GOOGLE_API_KEY": "test-key"},
        )

    assert "audio" in result
    assert result["audio"]["type"] == "Audio"
    assert Path(result["audio"]["value"]).suffix == ".wav"

    body = mock_client_instance.post.call_args.kwargs.get("json") or mock_client_instance.post.call_args[1].get("json")
    gen_cfg = body.get("generationConfig", {})
    assert gen_cfg.get("responseModalities") == ["AUDIO"]
    assert gen_cfg["speechConfig"]["voiceConfig"]["prebuiltVoiceConfig"]["voiceName"] == "Kore"


# --- Gemini Embeddings tests (outputDimensionality camelCase fix) ---

def _make_embeddings_node(params=None):
    return GraphNode(
        id="test-emb-1",
        definitionId="gemini-embeddings",
        params=params or {"model": "gemini-embedding-001", "taskType": "SEMANTIC_SIMILARITY"},
    )


@pytest.mark.asyncio
async def test_gemini_embeddings_returns_vector():
    """Verifies embeddings returns JSON-serialised vector at embedding port."""
    emb_resp = {"embedding": {"values": [0.1, 0.2, 0.3]}}
    mock_resp = MagicMock()
    mock_resp.status_code = 200
    mock_resp.json.return_value = emb_resp

    with patch("handlers.google_gemini.httpx.AsyncClient") as MockClient:
        mock_client_instance = AsyncMock()
        mock_client_instance.post.return_value = mock_resp
        mock_client_instance.__aenter__ = AsyncMock(return_value=mock_client_instance)
        mock_client_instance.__aexit__ = AsyncMock(return_value=False)
        MockClient.return_value = mock_client_instance

        result = await handle_gemini_embeddings(
            _make_embeddings_node(),
            {"text": PortValueDict(type="Text", value="hello")},
            {"GOOGLE_API_KEY": "test-key"},
        )

    assert result["embedding"]["type"] == "Text"
    assert json.loads(result["embedding"]["value"]) == [0.1, 0.2, 0.3]
    assert result["dimensions"]["value"] == "3"


@pytest.mark.asyncio
async def test_gemini_embeddings_output_dimensionality_camelcase():
    """Verifies outputDimensionality is sent as camelCase, not output_dimensionality (2026-05-17 fix)."""
    emb_resp = {"embedding": {"values": [0.1, 0.2]}}
    mock_resp = MagicMock()
    mock_resp.status_code = 200
    mock_resp.json.return_value = emb_resp

    with patch("handlers.google_gemini.httpx.AsyncClient") as MockClient:
        mock_client_instance = AsyncMock()
        mock_client_instance.post.return_value = mock_resp
        mock_client_instance.__aenter__ = AsyncMock(return_value=mock_client_instance)
        mock_client_instance.__aexit__ = AsyncMock(return_value=False)
        MockClient.return_value = mock_client_instance

        await handle_gemini_embeddings(
            _make_embeddings_node({"model": "gemini-embedding-001", "outputDimensionality": "768"}),
            {"text": PortValueDict(type="Text", value="hello")},
            {"GOOGLE_API_KEY": "test-key"},
        )

    body = mock_client_instance.post.call_args.kwargs.get("json") or mock_client_instance.post.call_args[1].get("json")
    assert "output_dimensionality" not in body, "snake_case key is wrong; API requires camelCase outputDimensionality"
    assert body.get("outputDimensionality") == 768
