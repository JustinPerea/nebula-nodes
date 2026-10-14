from __future__ import annotations

import base64
import json
import shutil
from pathlib import Path
from unittest.mock import AsyncMock, MagicMock, patch

import pytest

from handlers.google_gemini import (
    handle_gemini_chat,
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


@pytest.mark.asyncio
async def test_gemini_chat_json_sets_response_mime_type() -> None:
    """response_format=application/json must set generationConfig.responseMimeType.
    The param existed in the node but the handler ignored it (silent no-op)."""
    with patch("handlers.google_gemini.stream_execute", new_callable=AsyncMock) as mock_stream:
        mock_stream.return_value = '{"ok": true}'
        await handle_gemini_chat(
            _make_gemini_node({"model": "gemini-2.5-flash", "response_format": "application/json"}),
            {"messages": PortValueDict(type="Text", value="Return JSON")},
            {"GOOGLE_API_KEY": "g-test"},
            emit=AsyncMock(),
        )
    body = mock_stream.call_args.kwargs["request_body"]
    assert body["generationConfig"]["responseMimeType"] == "application/json"


@pytest.mark.asyncio
async def test_gemini_chat_text_omits_response_mime_type() -> None:
    with patch("handlers.google_gemini.stream_execute", new_callable=AsyncMock) as mock_stream:
        mock_stream.return_value = "plain"
        await handle_gemini_chat(
            _make_gemini_node({"model": "gemini-2.5-flash", "response_format": "text/plain"}),
            {"messages": PortValueDict(type="Text", value="Hi")},
            {"GOOGLE_API_KEY": "g-test"},
            emit=AsyncMock(),
        )
    body = mock_stream.call_args.kwargs["request_body"]
    assert "responseMimeType" not in body.get("generationConfig", {})


@pytest.mark.asyncio
async def test_gemini_chat_missing_image_path_raises(tmp_path) -> None:
    """A wired image whose local path doesn't exist must surface as an error, not
    be silently dropped — otherwise the node 'succeeds' having sent zero of the
    references the user connected."""
    missing = tmp_path / "gone.png"
    with pytest.raises(ValueError, match="not found"):
        await handle_gemini_chat(
            _make_gemini_node(),
            {
                "messages": PortValueDict(type="Text", value="describe this"),
                "images": PortValueDict(type="Image", value=str(missing)),
            },
            {"GOOGLE_API_KEY": "g-test"},
            emit=AsyncMock(),
        )


@pytest.mark.asyncio
async def test_gemini_chat_data_uri_image_preserved() -> None:
    """data: URIs keep their existing behavior — parsed into an inline_data part, no file I/O."""
    with patch("handlers.google_gemini.stream_execute", new_callable=AsyncMock) as mock_stream:
        mock_stream.return_value = "ok"
        await handle_gemini_chat(
            _make_gemini_node(),
            {
                "messages": PortValueDict(type="Text", value="describe"),
                "images": PortValueDict(type="Image", value="data:image/png;base64,QUJD"),
            },
            {"GOOGLE_API_KEY": "g-test"},
            emit=AsyncMock(),
        )
    body = mock_stream.call_args.kwargs["request_body"]
    inline = [p for p in body["contents"][0]["parts"] if "inline_data" in p]
    assert len(inline) == 1
    assert inline[0]["inline_data"] == {"mime_type": "image/png", "data": "QUJD"}


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


# --- Nano Banana tests (generationConfig.imageConfig) ---

def _make_nano_node(params=None):
    return GraphNode(
        id="test-nano-1",
        definitionId="nano-banana",
        params=params or {"model": "gemini-3.1-flash-image"},
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
            _make_nano_node({"model": "gemini-3.1-flash-image", "aspect_ratio": "16:9", "imageSize": "2K"}),
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


@pytest.mark.asyncio
async def test_nano_banana_normalizes_hidden_stale_model_params():
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

        await handle_nano_banana(
            _make_nano_node({
                "model": "gemini-3.1-flash-lite-image",
                "aspect_ratio": "1:8",
                "imageSize": "4K",
            }),
            {"prompt": PortValueDict(type="Text", value="a blue circle")},
            {"GOOGLE_API_KEY": "test-key"},
        )

    body = mock_client_instance.post.call_args.kwargs.get("json") or mock_client_instance.post.call_args[1].get("json")
    assert body["generationConfig"]["imageConfig"] == {
        "aspectRatio": "1:1",
        "imageSize": "1K",
    }


# --- Lyria 3 tests (responseMimeType → responseFormat.audio fix) ---

def _interaction_client(payload):
    mock_resp = MagicMock()
    mock_resp.status_code = 200
    mock_resp.json.return_value = payload
    client = AsyncMock()
    client.post.return_value = mock_resp
    client.__aenter__ = AsyncMock(return_value=client)
    client.__aexit__ = AsyncMock(return_value=False)
    return client


@pytest.mark.asyncio
async def test_nano_banana_21_uses_interactions_api():
    """Nano Banana 2.1 is documented only on the Interactions API."""
    client = _interaction_client({
        "steps": [{"type": "model_output", "content": [
            {"type": "image", "mime_type": "image/png", "data": RED_PIXEL_B64},
            {"type": "text", "text": "here you go"},
        ]}],
    })
    with patch("handlers.google_gemini.httpx.AsyncClient", return_value=client):
        result = await handle_nano_banana(
            _make_nano_node({"model": "gemini-nano-banana-2.1", "aspect_ratio": "8:1", "imageSize": "4K"}),
            {
                "prompt": PortValueDict(type="Text", value="a long banner"),
                "images": PortValueDict(type="Image", value=[
                    "https://example.com/ref.png", "data:image/png;base64,QUJD",
                ]),
            },
            {"GOOGLE_API_KEY": "test-key"},
        )

    url = client.post.call_args.args[0]
    body = client.post.call_args.kwargs["json"]
    assert url.endswith("/v1beta/interactions")
    assert body["model"] == "gemini-nano-banana-2.1"
    assert body["store"] is False
    assert body["response_format"] == {"type": "image", "aspect_ratio": "8:1", "image_size": "4K"}
    # URLs go to Google as-is; the backend never fetches them.
    assert body["input"][1] == {"type": "image", "uri": "https://example.com/ref.png"}
    assert body["input"][2] == {"type": "image", "mime_type": "image/png", "data": "QUJD"}
    assert Path(result["image"]["value"]).suffix == ".png"
    assert result["text"]["value"] == "here you go"


@pytest.mark.asyncio
async def test_nano_banana_21_renders_unsupported_size_at_1k_and_text_only_input():
    client = _interaction_client({"output_image": {"mime_type": "image/png", "data": RED_PIXEL_B64}})
    with patch("handlers.google_gemini.httpx.AsyncClient", return_value=client):
        result = await handle_nano_banana(
            _make_nano_node({"model": "gemini-nano-banana-2.1", "imageSize": "512"}),
            {"prompt": PortValueDict(type="Text", value="a cat")},
            {"GOOGLE_API_KEY": "test-key"},
        )
    body = client.post.call_args.kwargs["json"]
    assert body["input"] == "a cat"
    assert body["response_format"]["image_size"] == "1K"
    assert "image" in result


@pytest.mark.asyncio
async def test_nano_banana_21_without_image_raises():
    client = _interaction_client({"steps": []})
    with patch("handlers.google_gemini.httpx.AsyncClient", return_value=client):
        with pytest.raises(RuntimeError, match="no image"):
            await handle_nano_banana(
                _make_nano_node({"model": "gemini-nano-banana-2.1"}),
                {"prompt": PortValueDict(type="Text", value="a cat")},
                {"GOOGLE_API_KEY": "test-key"},
            )


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


def _tts_client(inline_data):
    mock_resp = MagicMock()
    mock_resp.status_code = 200
    mock_resp.json.return_value = {"candidates": [{"content": {"parts": [{"inlineData": inline_data}]}}]}
    client = AsyncMock()
    client.post.return_value = mock_resp
    client.__aenter__ = AsyncMock(return_value=client)
    client.__aexit__ = AsyncMock(return_value=False)
    return client


@pytest.mark.asyncio
async def test_gemini_3_8_tts_wav_is_saved_as_is(tmp_path):
    """3.8 TTS returns a whole WAV file; wrapping it again would put a header inside the audio."""
    import io, wave
    buf = io.BytesIO()
    with wave.open(buf, "wb") as wf:
        wf.setnchannels(1); wf.setsampwidth(2); wf.setframerate(24000); wf.writeframes(b"\x01\x00" * 10)
    wav = buf.getvalue()
    client = _tts_client({"mimeType": "audio/wav", "data": base64.b64encode(wav).decode()})

    with patch("handlers.google_gemini.httpx.AsyncClient", return_value=client), \
            patch("handlers.google_gemini.get_run_dir", return_value=tmp_path):
        result = await handle_gemini_tts(
            _make_tts_node({"voiceName": "Kore"}),
            {"text": PortValueDict(type="Text", value="Hello")},
            {"GOOGLE_API_KEY": "test-key"},
        )

    assert Path(result["audio"]["value"]).read_bytes() == wav
    url = client.post.call_args.args[0]
    assert url.endswith("/gemini-3.8-flash-tts:generateContent"), "the default is 3.8 Flash TTS"


@pytest.mark.asyncio
async def test_gemini_legacy_tts_pcm_gets_a_header_at_its_rate(tmp_path):
    import wave
    pcm = b"\x01\x00" * 8
    client = _tts_client({"mimeType": "audio/L16;codec=pcm;rate=16000", "data": base64.b64encode(pcm).decode()})

    with patch("handlers.google_gemini.httpx.AsyncClient", return_value=client), \
            patch("handlers.google_gemini.get_run_dir", return_value=tmp_path):
        result = await handle_gemini_tts(
            _make_tts_node(),
            {"text": PortValueDict(type="Text", value="Hello")},
            {"GOOGLE_API_KEY": "test-key"},
        )

    with wave.open(result["audio"]["value"], "rb") as wf:
        assert wf.getframerate() == 16000
        assert wf.readframes(8) == pcm
