"""Tests for the OpenAI Audio handler (STT, Translate, TTS).

Structural-assertion pattern: pin the exact form-data fields sent to
/v1/audio/transcriptions and /v1/audio/translations, and the JSON body
sent to /v1/audio/speech, including the file extension written to disk.

Source verified against openai-python SDK type stubs fetched 2026-05-16:
  https://raw.githubusercontent.com/openai/openai-python/main/src/openai/types/audio/transcription_create_params.py
  https://raw.githubusercontent.com/openai/openai-python/main/src/openai/types/audio/translation_create_params.py
  https://raw.githubusercontent.com/openai/openai-python/main/src/openai/types/audio/speech_create_params.py
"""
from __future__ import annotations

from pathlib import Path
from typing import Any
from unittest.mock import AsyncMock, MagicMock, patch

import pytest

from handlers.openai_audio import (
    OPENAI_AUDIO_BASE,
    handle_openai_stt,
    handle_openai_translate,
    handle_openai_tts,
)
from models.graph import GraphNode, PortValueDict

_API_KEYS = {"OPENAI_API_KEY": "sk-test"}


def _node(definition_id: str, params: dict[str, Any] | None = None) -> GraphNode:
    return GraphNode(
        id=f"{definition_id}-test",
        definitionId=definition_id,
        params=params or {},
    )


def _mock_http_response(status: int = 200, json_body: dict | None = None, content: bytes = b"") -> MagicMock:
    resp = MagicMock()
    resp.status_code = status
    resp.text = "ok"
    resp.json.return_value = json_body or {}
    resp.content = content
    return resp


def _mock_client(response: MagicMock) -> AsyncMock:
    client = AsyncMock()
    client.post.return_value = response
    client.__aenter__ = AsyncMock(return_value=client)
    client.__aexit__ = AsyncMock(return_value=False)
    return client


# ---------------------------------------------------------------------------
# STT — form data shape
# ---------------------------------------------------------------------------


@pytest.mark.asyncio
async def test_stt_form_data_includes_model_and_format(tmp_path: Path) -> None:
    """STT must POST multipart with model and response_format in the data dict."""
    audio_file = tmp_path / "clip.mp3"
    audio_file.write_bytes(b"fake-audio")

    resp = _mock_http_response(json_body={"text": "hello world"})
    mock_client = _mock_client(resp)

    with patch("handlers.openai_audio.httpx.AsyncClient", return_value=mock_client):
        result = await handle_openai_stt(
            _node("openai-stt", {"model": "whisper-1", "response_format": "json"}),
            {"audio": PortValueDict(type="Audio", value=str(audio_file))},
            _API_KEYS,
        )

    call_kwargs = mock_client.post.call_args.kwargs
    assert call_kwargs["data"]["model"] == "whisper-1"
    assert call_kwargs["data"]["response_format"] == "json"
    assert "file" in call_kwargs["files"]
    assert result["text"]["type"] == "Text"
    assert result["text"]["value"] == "hello world"


@pytest.mark.asyncio
async def test_stt_posts_to_transcriptions_endpoint(tmp_path: Path) -> None:
    """STT must POST to /v1/audio/transcriptions."""
    audio_file = tmp_path / "clip.mp3"
    audio_file.write_bytes(b"fake-audio")

    mock_client = _mock_client(_mock_http_response(json_body={"text": "hi"}))

    with patch("handlers.openai_audio.httpx.AsyncClient", return_value=mock_client):
        await handle_openai_stt(
            _node("openai-stt", {"model": "whisper-1", "response_format": "json"}),
            {"audio": PortValueDict(type="Audio", value=str(audio_file))},
            _API_KEYS,
        )

    url = mock_client.post.call_args.args[0]
    assert url == f"{OPENAI_AUDIO_BASE}/transcriptions"


@pytest.mark.asyncio
async def test_stt_language_auto_not_forwarded(tmp_path: Path) -> None:
    """The 'auto' language sentinel must NOT be sent as the language field."""
    audio_file = tmp_path / "clip.mp3"
    audio_file.write_bytes(b"fake-audio")

    mock_client = _mock_client(_mock_http_response(json_body={"text": ""}))

    with patch("handlers.openai_audio.httpx.AsyncClient", return_value=mock_client):
        await handle_openai_stt(
            _node("openai-stt", {"language": "auto", "response_format": "json"}),
            {"audio": PortValueDict(type="Audio", value=str(audio_file))},
            _API_KEYS,
        )

    data = mock_client.post.call_args.kwargs["data"]
    assert "language" not in data


@pytest.mark.asyncio
async def test_stt_language_iso_code_forwarded(tmp_path: Path) -> None:
    """An explicit ISO language code must be forwarded in form data."""
    audio_file = tmp_path / "clip.mp3"
    audio_file.write_bytes(b"fake-audio")

    mock_client = _mock_client(_mock_http_response(json_body={"text": ""}))

    with patch("handlers.openai_audio.httpx.AsyncClient", return_value=mock_client):
        await handle_openai_stt(
            _node("openai-stt", {"language": "fr", "response_format": "json"}),
            {"audio": PortValueDict(type="Audio", value=str(audio_file))},
            _API_KEYS,
        )

    data = mock_client.post.call_args.kwargs["data"]
    assert data["language"] == "fr"


@pytest.mark.asyncio
async def test_stt_temperature_forwarded_as_string(tmp_path: Path) -> None:
    """temperature must be cast to str for multipart form data."""
    audio_file = tmp_path / "clip.mp3"
    audio_file.write_bytes(b"fake-audio")

    mock_client = _mock_client(_mock_http_response(json_body={"text": ""}))

    with patch("handlers.openai_audio.httpx.AsyncClient", return_value=mock_client):
        await handle_openai_stt(
            _node("openai-stt", {"temperature": 0.4, "response_format": "json"}),
            {"audio": PortValueDict(type="Audio", value=str(audio_file))},
            _API_KEYS,
        )

    data = mock_client.post.call_args.kwargs["data"]
    assert data["temperature"] == "0.4"


@pytest.mark.asyncio
async def test_stt_text_format_returns_raw_response_text(tmp_path: Path) -> None:
    """When response_format is 'text', return response.text directly."""
    audio_file = tmp_path / "clip.mp3"
    audio_file.write_bytes(b"fake-audio")

    resp = _mock_http_response()
    resp.text = "transcribed text"
    mock_client = _mock_client(resp)

    with patch("handlers.openai_audio.httpx.AsyncClient", return_value=mock_client):
        result = await handle_openai_stt(
            _node("openai-stt", {"response_format": "text"}),
            {"audio": PortValueDict(type="Audio", value=str(audio_file))},
            _API_KEYS,
        )

    assert result["text"]["value"] == "transcribed text"


@pytest.mark.asyncio
async def test_stt_missing_audio_raises() -> None:
    with pytest.raises(ValueError, match="Audio input is required"):
        await handle_openai_stt(_node("openai-stt"), {}, _API_KEYS)


@pytest.mark.asyncio
async def test_stt_missing_api_key_raises(tmp_path: Path) -> None:
    audio_file = tmp_path / "clip.mp3"
    audio_file.write_bytes(b"x")
    with pytest.raises(ValueError, match="OPENAI_API_KEY"):
        await handle_openai_stt(
            _node("openai-stt"),
            {"audio": PortValueDict(type="Audio", value=str(audio_file))},
            {},
        )


@pytest.mark.asyncio
async def test_stt_http_error_raises_runtime_error(tmp_path: Path) -> None:
    audio_file = tmp_path / "clip.mp3"
    audio_file.write_bytes(b"x")
    mock_client = _mock_client(_mock_http_response(status=400))
    with patch("handlers.openai_audio.httpx.AsyncClient", return_value=mock_client):
        with pytest.raises(RuntimeError, match="OpenAI STT error 400"):
            await handle_openai_stt(
                _node("openai-stt"),
                {"audio": PortValueDict(type="Audio", value=str(audio_file))},
                _API_KEYS,
            )


@pytest.mark.asyncio
async def test_stt_temperature_zero_is_omitted(tmp_path: Path) -> None:
    """temperature=0 (registry default) must NOT be forwarded in form data."""
    audio_file = tmp_path / "clip.mp3"
    audio_file.write_bytes(b"fake-audio")

    mock_client = _mock_client(_mock_http_response(json_body={"text": ""}))

    with patch("handlers.openai_audio.httpx.AsyncClient", return_value=mock_client):
        await handle_openai_stt(
            _node("openai-stt", {"temperature": 0, "response_format": "json"}),
            {"audio": PortValueDict(type="Audio", value=str(audio_file))},
            _API_KEYS,
        )

    data = mock_client.post.call_args.kwargs["data"]
    assert "temperature" not in data


@pytest.mark.asyncio
async def test_stt_temperature_nonzero_is_forwarded(tmp_path: Path) -> None:
    """An explicit non-zero temperature must be forwarded as a string."""
    audio_file = tmp_path / "clip.mp3"
    audio_file.write_bytes(b"fake-audio")

    mock_client = _mock_client(_mock_http_response(json_body={"text": ""}))

    with patch("handlers.openai_audio.httpx.AsyncClient", return_value=mock_client):
        await handle_openai_stt(
            _node("openai-stt", {"temperature": 0.4, "response_format": "json"}),
            {"audio": PortValueDict(type="Audio", value=str(audio_file))},
            _API_KEYS,
        )

    data = mock_client.post.call_args.kwargs["data"]
    assert data["temperature"] == "0.4"


# ---------------------------------------------------------------------------
# Translate — form data shape
# ---------------------------------------------------------------------------


@pytest.mark.asyncio
async def test_translate_model_hardcoded_to_whisper1(tmp_path: Path) -> None:
    """Translation endpoint only accepts whisper-1; handler must hardcode it."""
    audio_file = tmp_path / "clip.mp3"
    audio_file.write_bytes(b"fake-audio")

    mock_client = _mock_client(_mock_http_response(json_body={"text": "hello"}))

    with patch("handlers.openai_audio.httpx.AsyncClient", return_value=mock_client):
        await handle_openai_translate(
            _node("openai-translate", {"response_format": "json"}),
            {"audio": PortValueDict(type="Audio", value=str(audio_file))},
            _API_KEYS,
        )

    data = mock_client.post.call_args.kwargs["data"]
    assert data["model"] == "whisper-1"


@pytest.mark.asyncio
async def test_translate_posts_to_translations_endpoint(tmp_path: Path) -> None:
    """Translate must POST to /v1/audio/translations."""
    audio_file = tmp_path / "clip.mp3"
    audio_file.write_bytes(b"fake-audio")

    mock_client = _mock_client(_mock_http_response(json_body={"text": "hi"}))

    with patch("handlers.openai_audio.httpx.AsyncClient", return_value=mock_client):
        await handle_openai_translate(
            _node("openai-translate", {"response_format": "json"}),
            {"audio": PortValueDict(type="Audio", value=str(audio_file))},
            _API_KEYS,
        )

    url = mock_client.post.call_args.args[0]
    assert url == f"{OPENAI_AUDIO_BASE}/translations"


@pytest.mark.asyncio
async def test_translate_temperature_forwarded(tmp_path: Path) -> None:
    """temperature must be forwarded as a string in the form data."""
    audio_file = tmp_path / "clip.mp3"
    audio_file.write_bytes(b"fake-audio")

    mock_client = _mock_client(_mock_http_response(json_body={"text": ""}))

    with patch("handlers.openai_audio.httpx.AsyncClient", return_value=mock_client):
        await handle_openai_translate(
            _node("openai-translate", {"temperature": 0.2, "response_format": "json"}),
            {"audio": PortValueDict(type="Audio", value=str(audio_file))},
            _API_KEYS,
        )

    data = mock_client.post.call_args.kwargs["data"]
    assert data["temperature"] == "0.2"


@pytest.mark.asyncio
async def test_translate_verbose_json_response_format(tmp_path: Path) -> None:
    """verbose_json is a valid response_format for translation and must be forwarded."""
    audio_file = tmp_path / "clip.mp3"
    audio_file.write_bytes(b"fake-audio")

    mock_client = _mock_client(_mock_http_response(json_body={"text": "bonjour"}))

    with patch("handlers.openai_audio.httpx.AsyncClient", return_value=mock_client):
        result = await handle_openai_translate(
            _node("openai-translate", {"response_format": "verbose_json"}),
            {"audio": PortValueDict(type="Audio", value=str(audio_file))},
            _API_KEYS,
        )

    data = mock_client.post.call_args.kwargs["data"]
    assert data["response_format"] == "verbose_json"
    assert result["text"]["value"] == "bonjour"


@pytest.mark.asyncio
async def test_translate_missing_audio_raises() -> None:
    with pytest.raises(ValueError, match="Audio input is required"):
        await handle_openai_translate(_node("openai-translate"), {}, _API_KEYS)


@pytest.mark.asyncio
async def test_translate_missing_api_key_raises(tmp_path: Path) -> None:
    audio_file = tmp_path / "clip.mp3"
    audio_file.write_bytes(b"x")
    with pytest.raises(ValueError, match="OPENAI_API_KEY"):
        await handle_openai_translate(
            _node("openai-translate"),
            {"audio": PortValueDict(type="Audio", value=str(audio_file))},
            {},
        )


@pytest.mark.asyncio
async def test_translate_temperature_zero_is_omitted(tmp_path: Path) -> None:
    """temperature=0 (registry default) must NOT be forwarded in form data."""
    audio_file = tmp_path / "clip.mp3"
    audio_file.write_bytes(b"fake-audio")

    mock_client = _mock_client(_mock_http_response(json_body={"text": ""}))

    with patch("handlers.openai_audio.httpx.AsyncClient", return_value=mock_client):
        await handle_openai_translate(
            _node("openai-translate", {"temperature": 0, "response_format": "json"}),
            {"audio": PortValueDict(type="Audio", value=str(audio_file))},
            _API_KEYS,
        )

    data = mock_client.post.call_args.kwargs["data"]
    assert "temperature" not in data


@pytest.mark.asyncio
async def test_translate_temperature_nonzero_is_forwarded(tmp_path: Path) -> None:
    """An explicit non-zero temperature must be forwarded as a string."""
    audio_file = tmp_path / "clip.mp3"
    audio_file.write_bytes(b"fake-audio")

    mock_client = _mock_client(_mock_http_response(json_body={"text": ""}))

    with patch("handlers.openai_audio.httpx.AsyncClient", return_value=mock_client):
        await handle_openai_translate(
            _node("openai-translate", {"temperature": 0.6, "response_format": "json"}),
            {"audio": PortValueDict(type="Audio", value=str(audio_file))},
            _API_KEYS,
        )

    data = mock_client.post.call_args.kwargs["data"]
    assert data["temperature"] == "0.6"


@pytest.mark.asyncio
async def test_translate_http_error_raises_runtime_error(tmp_path: Path) -> None:
    audio_file = tmp_path / "clip.mp3"
    audio_file.write_bytes(b"x")
    mock_client = _mock_client(_mock_http_response(status=500))
    with patch("handlers.openai_audio.httpx.AsyncClient", return_value=mock_client):
        with pytest.raises(RuntimeError, match="OpenAI Translate error 500"):
            await handle_openai_translate(
                _node("openai-translate"),
                {"audio": PortValueDict(type="Audio", value=str(audio_file))},
                _API_KEYS,
            )


# ---------------------------------------------------------------------------
# TTS — JSON body shape and file extension
# ---------------------------------------------------------------------------


@pytest.mark.asyncio
async def test_tts_request_body_shape() -> None:
    """TTS must POST JSON with model, input, voice, speed, response_format."""
    mock_client = _mock_client(_mock_http_response(content=b"audio-bytes"))

    with patch("handlers.openai_audio.httpx.AsyncClient", return_value=mock_client), \
         patch("handlers.openai_audio.get_run_dir", return_value=Path("/tmp")):
        result = await handle_openai_tts(
            _node("openai-tts", {
                "model": "tts-1",
                "voice": "nova",
                "speed": 1.5,
                "response_format": "mp3",
            }),
            {"text": PortValueDict(type="Text", value="Hello world")},
            _API_KEYS,
        )

    body = mock_client.post.call_args.kwargs["json"]
    assert body["model"] == "tts-1"
    assert body["input"] == "Hello world"
    assert body["voice"] == "nova"
    assert body["speed"] == 1.5
    assert body["response_format"] == "mp3"
    assert result["audio"]["type"] == "Audio"


@pytest.mark.asyncio
async def test_tts_posts_to_speech_endpoint() -> None:
    """TTS must POST to /v1/audio/speech."""
    mock_client = _mock_client(_mock_http_response(content=b"audio"))

    with patch("handlers.openai_audio.httpx.AsyncClient", return_value=mock_client), \
         patch("handlers.openai_audio.get_run_dir", return_value=Path("/tmp")):
        await handle_openai_tts(
            _node("openai-tts", {"model": "tts-1", "voice": "alloy", "response_format": "mp3"}),
            {"text": PortValueDict(type="Text", value="hi")},
            _API_KEYS,
        )

    url = mock_client.post.call_args.args[0]
    assert url == f"{OPENAI_AUDIO_BASE}/speech"


@pytest.mark.asyncio
@pytest.mark.parametrize("fmt,expected_ext", [
    ("mp3", ".mp3"),
    ("wav", ".wav"),
    ("flac", ".flac"),
    ("opus", ".opus"),
    ("aac", ".aac"),
    ("pcm", ".pcm"),
])
async def test_tts_file_extension_matches_response_format(
    fmt: str, expected_ext: str, tmp_path: Path
) -> None:
    """Saved file extension must match the selected response_format — not hardcoded to .mp3."""
    mock_client = _mock_client(_mock_http_response(content=b"audio-data"))

    with patch("handlers.openai_audio.httpx.AsyncClient", return_value=mock_client), \
         patch("handlers.openai_audio.get_run_dir", return_value=tmp_path):
        result = await handle_openai_tts(
            _node("openai-tts", {"model": "tts-1", "voice": "alloy", "response_format": fmt}),
            {"text": PortValueDict(type="Text", value="test")},
            _API_KEYS,
        )

    saved_path = result["audio"]["value"]
    assert saved_path.endswith(expected_ext), (
        f"Expected extension {expected_ext} for format '{fmt}', got: {saved_path}"
    )
    assert Path(saved_path).exists()


@pytest.mark.asyncio
async def test_tts_instructions_forwarded_for_gpt4o_mini_tts() -> None:
    """instructions param must be included in the JSON body when provided."""
    mock_client = _mock_client(_mock_http_response(content=b"audio"))

    with patch("handlers.openai_audio.httpx.AsyncClient", return_value=mock_client), \
         patch("handlers.openai_audio.get_run_dir", return_value=Path("/tmp")):
        await handle_openai_tts(
            _node("openai-tts", {
                "model": "gpt-4o-mini-tts",
                "voice": "alloy",
                "response_format": "mp3",
                "instructions": "Speak slowly with warmth",
            }),
            {"text": PortValueDict(type="Text", value="hello")},
            _API_KEYS,
        )

    body = mock_client.post.call_args.kwargs["json"]
    assert body["instructions"] == "Speak slowly with warmth"


@pytest.mark.asyncio
async def test_tts_instructions_omitted_when_not_set() -> None:
    """instructions must NOT appear in the body when param is absent."""
    mock_client = _mock_client(_mock_http_response(content=b"audio"))

    with patch("handlers.openai_audio.httpx.AsyncClient", return_value=mock_client), \
         patch("handlers.openai_audio.get_run_dir", return_value=Path("/tmp")):
        await handle_openai_tts(
            _node("openai-tts", {"model": "tts-1", "voice": "alloy", "response_format": "mp3"}),
            {"text": PortValueDict(type="Text", value="hello")},
            _API_KEYS,
        )

    body = mock_client.post.call_args.kwargs["json"]
    assert "instructions" not in body


@pytest.mark.asyncio
async def test_tts_missing_text_raises() -> None:
    with pytest.raises(ValueError, match="Text input is required"):
        await handle_openai_tts(_node("openai-tts"), {}, _API_KEYS)


@pytest.mark.asyncio
async def test_tts_missing_api_key_raises() -> None:
    with pytest.raises(ValueError, match="OPENAI_API_KEY"):
        await handle_openai_tts(
            _node("openai-tts"),
            {"text": PortValueDict(type="Text", value="hi")},
            {},
        )


@pytest.mark.asyncio
async def test_tts_http_error_raises_runtime_error() -> None:
    mock_client = _mock_client(_mock_http_response(status=400))
    with patch("handlers.openai_audio.httpx.AsyncClient", return_value=mock_client):
        with pytest.raises(RuntimeError, match="OpenAI TTS error 400"):
            await handle_openai_tts(
                _node("openai-tts", {"model": "tts-1", "voice": "alloy", "response_format": "mp3"}),
                {"text": PortValueDict(type="Text", value="hi")},
                _API_KEYS,
            )


@pytest.mark.asyncio
async def test_tts_unknown_format_falls_back_to_mp3(tmp_path: Path) -> None:
    """An unrecognised response_format (e.g. 'ogg') must fall back to .mp3 extension."""
    mock_client = _mock_client(_mock_http_response(content=b"audio-bytes"))

    with patch("handlers.openai_audio.httpx.AsyncClient", return_value=mock_client), \
         patch("handlers.openai_audio.get_run_dir", return_value=tmp_path):
        result = await handle_openai_tts(
            _node("openai-tts", {"model": "tts-1", "voice": "alloy", "response_format": "ogg"}),
            {"text": PortValueDict(type="Text", value="test")},
            _API_KEYS,
        )

    assert result["audio"]["value"].endswith(".mp3"), (
        f"Expected .mp3 fallback for unknown format 'ogg', got: {result['audio']['value']}"
    )


@pytest.mark.asyncio
async def test_tts_output_returns_audio_type(tmp_path: Path) -> None:
    """Handler must return {'audio': {'type': 'Audio', 'value': <path>}}."""
    mock_client = _mock_client(_mock_http_response(content=b"audio-bytes"))

    with patch("handlers.openai_audio.httpx.AsyncClient", return_value=mock_client), \
         patch("handlers.openai_audio.get_run_dir", return_value=tmp_path):
        result = await handle_openai_tts(
            _node("openai-tts", {"model": "tts-1", "voice": "alloy", "response_format": "wav"}),
            {"text": PortValueDict(type="Text", value="test")},
            _API_KEYS,
        )

    assert result["audio"]["type"] == "Audio"
    assert Path(result["audio"]["value"]).suffix == ".wav"
    assert Path(result["audio"]["value"]).read_bytes() == b"audio-bytes"
