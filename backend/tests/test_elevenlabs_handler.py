from __future__ import annotations

import json
from pathlib import Path
from unittest.mock import AsyncMock, MagicMock, patch

import pytest

from handlers.elevenlabs import (
    handle_elevenlabs_dubbing,
    handle_elevenlabs_isolation,
    handle_elevenlabs_sfx,
    handle_elevenlabs_sts,
    handle_elevenlabs_stt,
    handle_elevenlabs_tts,
)
from models.graph import GraphNode, PortValueDict


# ---------------------------------------------------------------------------
# Helpers
# ---------------------------------------------------------------------------

def _make_tts_node(params: dict | None = None) -> GraphNode:
    return GraphNode(
        id="tts-1",
        definitionId="elevenlabs-tts",
        params=params
        or {
            "voice_id": "voice-test",
            "model_id": "eleven_multilingual_v2",
            "stability": 0.4,
            "similarity_boost": 0.8,
            "style": 0.2,
            "use_speaker_boost": False,
            "speed": 1.1,
            "output_format": "mp3_44100_128",
            "seed": 123,
        },
    )


def _make_sfx_node(params: dict | None = None) -> GraphNode:
    return GraphNode(
        id="sfx-1",
        definitionId="elevenlabs-sfx",
        params=params
        or {
            "duration_seconds": 5.0,
            "prompt_influence": 0.4,
            "loop": False,
            "output_format": "mp3_44100_128",
        },
    )


def _make_sts_node(params: dict | None = None) -> GraphNode:
    return GraphNode(
        id="sts-1",
        definitionId="elevenlabs-sts",
        params=params
        or {
            "voice_id": "voice-test",
            "model_id": "eleven_english_sts_v2",
            "stability": 0.5,
            "similarity_boost": 0.75,
            "remove_background_noise": False,
            "seed": 42,
            "output_format": "mp3_44100_128",
        },
    )


def _make_isolation_node() -> GraphNode:
    return GraphNode(
        id="iso-1",
        definitionId="elevenlabs-isolation",
        params={},
    )


def _make_dubbing_node(params: dict | None = None) -> GraphNode:
    return GraphNode(
        id="dub-1",
        definitionId="elevenlabs-dubbing",
        params=params
        or {
            "target_lang": "fr",
            "source_lang": "en",
            "num_speakers": 2,
            "drop_background_audio": False,
            "disable_voice_cloning": False,
        },
    )


def _mock_audio_input(tmp_path: Path) -> tuple[Path, PortValueDict]:
    audio_file = tmp_path / "test.mp3"
    audio_file.write_bytes(b"fake audio")
    return audio_file, PortValueDict(type="Audio", value=str(audio_file))


def _make_http_response(status: int = 200, content: bytes = b"fake audio") -> MagicMock:
    r = MagicMock()
    r.status_code = status
    r.content = content
    r.text = content.decode(errors="replace")
    r.json.return_value = {}
    return r


# ---------------------------------------------------------------------------
# TTS tests
# ---------------------------------------------------------------------------

@pytest.mark.asyncio
async def test_tts_speed_inside_voice_settings() -> None:
    """speed must be nested in voice_settings, not at top-level body."""
    response = _make_http_response(content=b"fake mp3")

    with patch("handlers.elevenlabs.httpx.AsyncClient") as MockClient:
        mock_client = AsyncMock()
        mock_client.post.return_value = response
        mock_client.__aenter__ = AsyncMock(return_value=mock_client)
        mock_client.__aexit__ = AsyncMock(return_value=False)
        MockClient.return_value = mock_client

        await handle_elevenlabs_tts(
            _make_tts_node(),
            {"text": PortValueDict(type="Text", value="hello")},
            {"ELEVENLABS_API_KEY": "el-test"},
        )

    body = mock_client.post.call_args.kwargs["json"]
    # speed MUST be inside voice_settings
    assert "speed" in body["voice_settings"], "speed must be inside voice_settings"
    # speed must NOT be a top-level body key
    assert "speed" not in {k for k in body if k != "voice_settings"}, \
        "speed must not appear at top level of body"
    assert body["voice_settings"]["speed"] == 1.1


@pytest.mark.asyncio
async def test_tts_maps_voice_settings_and_query_params() -> None:
    response = _make_http_response(content=b"fake mp3")

    with patch("handlers.elevenlabs.httpx.AsyncClient") as MockClient:
        mock_client = AsyncMock()
        mock_client.post.return_value = response
        mock_client.__aenter__ = AsyncMock(return_value=mock_client)
        mock_client.__aexit__ = AsyncMock(return_value=False)
        MockClient.return_value = mock_client

        result = await handle_elevenlabs_tts(
            _make_tts_node(),
            {"text": PortValueDict(type="Text", value="read this")},
            {"ELEVENLABS_API_KEY": "el-test"},
        )

    call = mock_client.post.call_args
    url = call.args[0]
    body = call.kwargs["json"]
    headers = call.kwargs["headers"]

    assert url.endswith("/voice-test?output_format=mp3_44100_128")
    assert body["text"] == "read this"
    assert body["model_id"] == "eleven_multilingual_v2"
    assert body["voice_settings"]["stability"] == 0.4
    assert body["voice_settings"]["similarity_boost"] == 0.8
    assert body["voice_settings"]["use_speaker_boost"] is False
    assert body["voice_settings"]["style"] == 0.2
    assert body["voice_settings"]["speed"] == 1.1
    assert body["seed"] == 123
    assert headers["xi-api-key"] == "el-test"
    assert result["audio"]["type"] == "Audio"
    assert Path(result["audio"]["value"]).exists()


@pytest.mark.asyncio
async def test_tts_defaults_speaker_boost_to_true() -> None:
    response = _make_http_response(content=b"fake mp3")

    with patch("handlers.elevenlabs.httpx.AsyncClient") as MockClient:
        mock_client = AsyncMock()
        mock_client.post.return_value = response
        mock_client.__aenter__ = AsyncMock(return_value=mock_client)
        mock_client.__aexit__ = AsyncMock(return_value=False)
        MockClient.return_value = mock_client

        await handle_elevenlabs_tts(
            _make_tts_node({"voice_id": "voice-test"}),
            {"text": PortValueDict(type="Text", value="read this")},
            {"ELEVENLABS_API_KEY": "el-test"},
        )

    body = mock_client.post.call_args.kwargs["json"]
    assert body["voice_settings"]["use_speaker_boost"] is True


@pytest.mark.asyncio
async def test_tts_pcm_format_saves_as_pcm() -> None:
    """pcm_* output_format returns raw PCM bytes (no WAV header), so the file
    extension must be .pcm. Saving as .wav produced a broken file that any
    media player rejected — caught by live smoke testing on 2026-05-17."""
    response = _make_http_response(content=b"fake pcm")

    with patch("handlers.elevenlabs.httpx.AsyncClient") as MockClient:
        mock_client = AsyncMock()
        mock_client.post.return_value = response
        mock_client.__aenter__ = AsyncMock(return_value=mock_client)
        mock_client.__aexit__ = AsyncMock(return_value=False)
        MockClient.return_value = mock_client

        result = await handle_elevenlabs_tts(
            _make_tts_node({"voice_id": "v", "output_format": "pcm_44100"}),
            {"text": PortValueDict(type="Text", value="hello")},
            {"ELEVENLABS_API_KEY": "el-test"},
        )

    assert Path(result["audio"]["value"]).suffix == ".pcm"


# ---------------------------------------------------------------------------
# SFX tests
# ---------------------------------------------------------------------------

@pytest.mark.asyncio
async def test_sfx_sends_correct_body_and_url(tmp_path: Path) -> None:
    response = _make_http_response(content=b"fake sfx")

    with patch("handlers.elevenlabs.httpx.AsyncClient") as MockClient:
        mock_client = AsyncMock()
        mock_client.post.return_value = response
        mock_client.__aenter__ = AsyncMock(return_value=mock_client)
        mock_client.__aexit__ = AsyncMock(return_value=False)
        MockClient.return_value = mock_client

        result = await handle_elevenlabs_sfx(
            _make_sfx_node(),
            {"text": PortValueDict(type="Text", value="thunder crack")},
            {"ELEVENLABS_API_KEY": "el-test"},
        )

    call = mock_client.post.call_args
    url = call.args[0]
    body = call.kwargs["json"]
    headers = call.kwargs["headers"]

    assert "sound-generation" in url
    assert "output_format=mp3_44100_128" in url
    assert body["text"] == "thunder crack"
    assert body["duration_seconds"] == 5.0
    assert body["prompt_influence"] == 0.4
    assert headers["xi-api-key"] == "el-test"
    assert result["audio"]["type"] == "Audio"
    assert Path(result["audio"]["value"]).suffix == ".mp3"


@pytest.mark.asyncio
async def test_sfx_omits_duration_when_not_set() -> None:
    """duration_seconds is optional; omit it when not provided."""
    response = _make_http_response(content=b"fake sfx")

    with patch("handlers.elevenlabs.httpx.AsyncClient") as MockClient:
        mock_client = AsyncMock()
        mock_client.post.return_value = response
        mock_client.__aenter__ = AsyncMock(return_value=mock_client)
        mock_client.__aexit__ = AsyncMock(return_value=False)
        MockClient.return_value = mock_client

        await handle_elevenlabs_sfx(
            _make_sfx_node({"output_format": "mp3_44100_128"}),
            {"text": PortValueDict(type="Text", value="rain")},
            {"ELEVENLABS_API_KEY": "el-test"},
        )

    body = mock_client.post.call_args.kwargs["json"]
    assert "duration_seconds" not in body


@pytest.mark.asyncio
async def test_sfx_loop_flag_forwarded() -> None:
    response = _make_http_response(content=b"fake sfx")

    with patch("handlers.elevenlabs.httpx.AsyncClient") as MockClient:
        mock_client = AsyncMock()
        mock_client.post.return_value = response
        mock_client.__aenter__ = AsyncMock(return_value=mock_client)
        mock_client.__aexit__ = AsyncMock(return_value=False)
        MockClient.return_value = mock_client

        await handle_elevenlabs_sfx(
            _make_sfx_node({"loop": True, "output_format": "mp3_44100_128"}),
            {"text": PortValueDict(type="Text", value="ambient loop")},
            {"ELEVENLABS_API_KEY": "el-test"},
        )

    body = mock_client.post.call_args.kwargs["json"]
    assert body["loop"] is True


@pytest.mark.asyncio
async def test_sfx_pcm_format_saves_as_pcm() -> None:
    """pcm_* output returns raw PCM bytes — must save as .pcm not .wav."""
    response = _make_http_response(content=b"fake pcm")

    with patch("handlers.elevenlabs.httpx.AsyncClient") as MockClient:
        mock_client = AsyncMock()
        mock_client.post.return_value = response
        mock_client.__aenter__ = AsyncMock(return_value=mock_client)
        mock_client.__aexit__ = AsyncMock(return_value=False)
        MockClient.return_value = mock_client

        result = await handle_elevenlabs_sfx(
            _make_sfx_node({"output_format": "pcm_44100"}),
            {"text": PortValueDict(type="Text", value="bloop")},
            {"ELEVENLABS_API_KEY": "el-test"},
        )

    assert Path(result["audio"]["value"]).suffix == ".pcm"


# ---------------------------------------------------------------------------
# STS tests
# ---------------------------------------------------------------------------

@pytest.mark.asyncio
async def test_sts_sends_multipart_with_voice_settings(tmp_path: Path) -> None:
    """voice_settings must be forwarded as a JSON-encoded string in multipart."""
    audio_file, audio_port = _mock_audio_input(tmp_path)
    response = _make_http_response(content=b"fake sts audio")

    with patch("handlers.elevenlabs.httpx.AsyncClient") as MockClient:
        mock_client = AsyncMock()
        mock_client.post.return_value = response
        mock_client.__aenter__ = AsyncMock(return_value=mock_client)
        mock_client.__aexit__ = AsyncMock(return_value=False)
        MockClient.return_value = mock_client

        result = await handle_elevenlabs_sts(
            _make_sts_node(),
            {"audio": audio_port},
            {"ELEVENLABS_API_KEY": "el-test"},
        )

    call = mock_client.post.call_args
    url = call.args[0]
    files = call.kwargs["files"]
    data = call.kwargs["data"]
    headers = call.kwargs["headers"]

    assert "speech-to-speech/voice-test" in url
    assert "output_format=mp3_44100_128" in url
    assert "audio" in files
    assert data["model_id"] == "eleven_english_sts_v2"
    assert headers["xi-api-key"] == "el-test"

    # voice_settings must be a JSON-encoded string in the multipart data
    assert "voice_settings" in data
    vs = json.loads(data["voice_settings"])
    assert vs["stability"] == 0.5
    assert vs["similarity_boost"] == 0.75

    # seed must be forwarded as string in multipart
    assert data["seed"] == "42"

    assert result["audio"]["type"] == "Audio"
    assert Path(result["audio"]["value"]).suffix == ".mp3"


@pytest.mark.asyncio
async def test_sts_remove_background_noise_forwarded(tmp_path: Path) -> None:
    audio_file, audio_port = _mock_audio_input(tmp_path)
    response = _make_http_response(content=b"fake sts audio")

    with patch("handlers.elevenlabs.httpx.AsyncClient") as MockClient:
        mock_client = AsyncMock()
        mock_client.post.return_value = response
        mock_client.__aenter__ = AsyncMock(return_value=mock_client)
        mock_client.__aexit__ = AsyncMock(return_value=False)
        MockClient.return_value = mock_client

        await handle_elevenlabs_sts(
            _make_sts_node({
                "voice_id": "v",
                "model_id": "eleven_english_sts_v2",
                "remove_background_noise": True,
                "output_format": "mp3_44100_128",
            }),
            {"audio": audio_port},
            {"ELEVENLABS_API_KEY": "el-test"},
        )

    data = mock_client.post.call_args.kwargs["data"]
    assert data["remove_background_noise"] == "true"


@pytest.mark.asyncio
async def test_sts_no_voice_settings_when_not_provided(tmp_path: Path) -> None:
    """If stability/similarity_boost not in params, voice_settings should not be sent."""
    audio_file, audio_port = _mock_audio_input(tmp_path)
    response = _make_http_response(content=b"fake sts audio")

    with patch("handlers.elevenlabs.httpx.AsyncClient") as MockClient:
        mock_client = AsyncMock()
        mock_client.post.return_value = response
        mock_client.__aenter__ = AsyncMock(return_value=mock_client)
        mock_client.__aexit__ = AsyncMock(return_value=False)
        MockClient.return_value = mock_client

        await handle_elevenlabs_sts(
            _make_sts_node({"voice_id": "v", "model_id": "eleven_english_sts_v2",
                            "output_format": "mp3_44100_128"}),
            {"audio": audio_port},
            {"ELEVENLABS_API_KEY": "el-test"},
        )

    data = mock_client.post.call_args.kwargs["data"]
    assert "voice_settings" not in data


@pytest.mark.asyncio
async def test_sts_pcm_format_saves_as_pcm(tmp_path: Path) -> None:
    """pcm_* output returns raw PCM bytes — must save as .pcm not .wav."""
    audio_file, audio_port = _mock_audio_input(tmp_path)
    response = _make_http_response(content=b"fake pcm")

    with patch("handlers.elevenlabs.httpx.AsyncClient") as MockClient:
        mock_client = AsyncMock()
        mock_client.post.return_value = response
        mock_client.__aenter__ = AsyncMock(return_value=mock_client)
        mock_client.__aexit__ = AsyncMock(return_value=False)
        MockClient.return_value = mock_client

        result = await handle_elevenlabs_sts(
            _make_sts_node({"voice_id": "v", "output_format": "pcm_44100"}),
            {"audio": audio_port},
            {"ELEVENLABS_API_KEY": "el-test"},
        )

    assert Path(result["audio"]["value"]).suffix == ".pcm"


# ---------------------------------------------------------------------------
# Isolation tests
# ---------------------------------------------------------------------------

@pytest.mark.asyncio
async def test_isolation_sends_audio_multipart(tmp_path: Path) -> None:
    audio_file, audio_port = _mock_audio_input(tmp_path)
    response = _make_http_response(content=b"isolated audio")

    with patch("handlers.elevenlabs.httpx.AsyncClient") as MockClient:
        mock_client = AsyncMock()
        mock_client.post.return_value = response
        mock_client.__aenter__ = AsyncMock(return_value=mock_client)
        mock_client.__aexit__ = AsyncMock(return_value=False)
        MockClient.return_value = mock_client

        result = await handle_elevenlabs_isolation(
            _make_isolation_node(),
            {"audio": audio_port},
            {"ELEVENLABS_API_KEY": "el-test"},
        )

    call = mock_client.post.call_args
    url = call.args[0]
    files = call.kwargs["files"]
    headers = call.kwargs["headers"]

    assert "audio-isolation" in url
    assert "audio" in files
    assert headers["xi-api-key"] == "el-test"
    assert result["audio"]["type"] == "Audio"
    # isolation always returns MP3
    assert Path(result["audio"]["value"]).suffix == ".mp3"


@pytest.mark.asyncio
async def test_isolation_raises_on_api_error(tmp_path: Path) -> None:
    audio_file, audio_port = _mock_audio_input(tmp_path)
    response = _make_http_response(status=422, content=b"validation error")

    with patch("handlers.elevenlabs.httpx.AsyncClient") as MockClient:
        mock_client = AsyncMock()
        mock_client.post.return_value = response
        mock_client.__aenter__ = AsyncMock(return_value=mock_client)
        mock_client.__aexit__ = AsyncMock(return_value=False)
        MockClient.return_value = mock_client

        with pytest.raises(RuntimeError, match="422"):
            await handle_elevenlabs_isolation(
                _make_isolation_node(),
                {"audio": audio_port},
                {"ELEVENLABS_API_KEY": "el-test"},
            )


# ---------------------------------------------------------------------------
# Dubbing tests
# ---------------------------------------------------------------------------

@pytest.mark.asyncio
async def test_dubbing_full_flow(tmp_path: Path) -> None:
    """Submit → poll → download happy path."""
    audio_file, audio_port = _mock_audio_input(tmp_path)

    submit_resp = MagicMock()
    submit_resp.status_code = 200
    submit_resp.json.return_value = {"dubbing_id": "dub-xyz", "expected_duration_sec": 30.0}

    poll_resp = MagicMock()
    poll_resp.status_code = 200
    poll_resp.json.return_value = {"dubbing_id": "dub-xyz", "status": "dubbed"}

    download_resp = MagicMock()
    download_resp.status_code = 200
    download_resp.content = b"dubbed audio bytes"

    with patch("handlers.elevenlabs.httpx.AsyncClient") as MockClient:
        mock_client = AsyncMock()
        mock_client.post.return_value = submit_resp
        mock_client.get.side_effect = [poll_resp, download_resp]
        mock_client.__aenter__ = AsyncMock(return_value=mock_client)
        mock_client.__aexit__ = AsyncMock(return_value=False)
        MockClient.return_value = mock_client

        with patch("handlers.elevenlabs.asyncio.sleep", new_callable=AsyncMock):
            result = await handle_elevenlabs_dubbing(
                _make_dubbing_node(),
                {"audio": audio_port},
                {"ELEVENLABS_API_KEY": "el-test"},
            )

    # Verify submit call
    post_call = mock_client.post.call_args
    assert "dubbing" in post_call.args[0]
    assert post_call.kwargs["data"]["target_lang"] == "fr"
    assert post_call.kwargs["data"]["source_lang"] == "en"
    assert post_call.kwargs["data"]["num_speakers"] == "2"
    assert "file" in post_call.kwargs["files"]

    # Verify poll call URL
    get_calls = mock_client.get.call_args_list
    assert "dub-xyz" in get_calls[0].args[0]

    # Verify download URL contains dubbing_id and language
    assert "dub-xyz" in get_calls[1].args[0]
    assert "fr" in get_calls[1].args[0]

    assert result["audio"]["type"] == "Audio"
    assert Path(result["audio"]["value"]).suffix == ".mp3"


@pytest.mark.asyncio
async def test_dubbing_raises_on_failed_status(tmp_path: Path) -> None:
    audio_file, audio_port = _mock_audio_input(tmp_path)

    submit_resp = MagicMock()
    submit_resp.status_code = 200
    submit_resp.json.return_value = {"dubbing_id": "dub-fail"}

    poll_resp = MagicMock()
    poll_resp.status_code = 200
    poll_resp.json.return_value = {"dubbing_id": "dub-fail", "status": "failed",
                                    "error": "Codec not supported"}

    with patch("handlers.elevenlabs.httpx.AsyncClient") as MockClient:
        mock_client = AsyncMock()
        mock_client.post.return_value = submit_resp
        mock_client.get.return_value = poll_resp
        mock_client.__aenter__ = AsyncMock(return_value=mock_client)
        mock_client.__aexit__ = AsyncMock(return_value=False)
        MockClient.return_value = mock_client

        with patch("handlers.elevenlabs.asyncio.sleep", new_callable=AsyncMock):
            with pytest.raises(RuntimeError, match="Codec not supported"):
                await handle_elevenlabs_dubbing(
                    _make_dubbing_node(),
                    {"audio": audio_port},
                    {"ELEVENLABS_API_KEY": "el-test"},
                )


@pytest.mark.asyncio
async def test_dubbing_raises_after_repeated_poll_errors(tmp_path: Path) -> None:
    """5 consecutive non-200 poll responses should raise, not loop forever."""
    audio_file, audio_port = _mock_audio_input(tmp_path)

    submit_resp = MagicMock()
    submit_resp.status_code = 200
    submit_resp.json.return_value = {"dubbing_id": "dub-err"}

    error_poll = MagicMock()
    error_poll.status_code = 503
    error_poll.text = "Service Unavailable"

    with patch("handlers.elevenlabs.httpx.AsyncClient") as MockClient:
        mock_client = AsyncMock()
        mock_client.post.return_value = submit_resp
        mock_client.get.return_value = error_poll
        mock_client.__aenter__ = AsyncMock(return_value=mock_client)
        mock_client.__aexit__ = AsyncMock(return_value=False)
        MockClient.return_value = mock_client

        with patch("handlers.elevenlabs.asyncio.sleep", new_callable=AsyncMock):
            with pytest.raises(RuntimeError, match="poll failed"):
                await handle_elevenlabs_dubbing(
                    _make_dubbing_node(),
                    {"audio": audio_port},
                    {"ELEVENLABS_API_KEY": "el-test"},
                )


@pytest.mark.asyncio
async def test_dubbing_source_lang_auto_omitted(tmp_path: Path) -> None:
    """source_lang='auto' must be omitted from the submit payload."""
    audio_file, audio_port = _mock_audio_input(tmp_path)

    submit_resp = MagicMock()
    submit_resp.status_code = 200
    submit_resp.json.return_value = {"dubbing_id": "dub-auto"}

    poll_resp = MagicMock()
    poll_resp.status_code = 200
    poll_resp.json.return_value = {"status": "dubbed"}

    dl_resp = MagicMock()
    dl_resp.status_code = 200
    dl_resp.content = b"audio"

    with patch("handlers.elevenlabs.httpx.AsyncClient") as MockClient:
        mock_client = AsyncMock()
        mock_client.post.return_value = submit_resp
        mock_client.get.side_effect = [poll_resp, dl_resp]
        mock_client.__aenter__ = AsyncMock(return_value=mock_client)
        mock_client.__aexit__ = AsyncMock(return_value=False)
        MockClient.return_value = mock_client

        with patch("handlers.elevenlabs.asyncio.sleep", new_callable=AsyncMock):
            await handle_elevenlabs_dubbing(
                _make_dubbing_node({
                    "target_lang": "es",
                    "source_lang": "auto",
                }),
                {"audio": audio_port},
                {"ELEVENLABS_API_KEY": "el-test"},
            )

    data = mock_client.post.call_args.kwargs["data"]
    assert "source_lang" not in data


@pytest.mark.asyncio
async def test_dubbing_optional_flags_forwarded(tmp_path: Path) -> None:
    """drop_background_audio and disable_voice_cloning must reach the submit payload."""
    audio_file, audio_port = _mock_audio_input(tmp_path)

    submit_resp = MagicMock()
    submit_resp.status_code = 200
    submit_resp.json.return_value = {"dubbing_id": "dub-flags"}

    poll_resp = MagicMock()
    poll_resp.status_code = 200
    poll_resp.json.return_value = {"status": "dubbed"}

    dl_resp = MagicMock()
    dl_resp.status_code = 200
    dl_resp.content = b"audio"

    with patch("handlers.elevenlabs.httpx.AsyncClient") as MockClient:
        mock_client = AsyncMock()
        mock_client.post.return_value = submit_resp
        mock_client.get.side_effect = [poll_resp, dl_resp]
        mock_client.__aenter__ = AsyncMock(return_value=mock_client)
        mock_client.__aexit__ = AsyncMock(return_value=False)
        MockClient.return_value = mock_client

        with patch("handlers.elevenlabs.asyncio.sleep", new_callable=AsyncMock):
            await handle_elevenlabs_dubbing(
                _make_dubbing_node({
                    "target_lang": "es",
                    "drop_background_audio": True,
                    "disable_voice_cloning": True,
                }),
                {"audio": audio_port},
                {"ELEVENLABS_API_KEY": "el-test"},
            )

    data = mock_client.post.call_args.kwargs["data"]
    assert data["drop_background_audio"] == "true"
    assert data["disable_voice_cloning"] == "true"


# ---------------------------------------------------------------------------
# STT (Speech-to-Text / Scribe) tests
# ---------------------------------------------------------------------------

def _make_stt_node(params: dict | None = None) -> GraphNode:
    return GraphNode(
        id="stt-1",
        definitionId="elevenlabs-stt",
        params=params
        or {
            "model_id": "scribe_v1",
            "language_code": "auto",
            "diarize": False,
            "tag_audio_events": True,
            "transcript_format": "text",
        },
    )


def _stt_response(payload: dict) -> MagicMock:
    r = MagicMock()
    r.status_code = 200
    r.json.return_value = payload
    r.text = ""
    return r


@pytest.mark.asyncio
async def test_stt_sends_multipart_file_and_model(tmp_path: Path) -> None:
    audio_file, audio_port = _mock_audio_input(tmp_path)
    resp = _stt_response({"text": "hello world", "language_code": "eng"})

    with patch("handlers.elevenlabs.httpx.AsyncClient") as MockClient:
        mock_client = AsyncMock()
        mock_client.post.return_value = resp
        mock_client.__aenter__ = AsyncMock(return_value=mock_client)
        mock_client.__aexit__ = AsyncMock(return_value=False)
        MockClient.return_value = mock_client

        result = await handle_elevenlabs_stt(
            _make_stt_node(),
            {"audio": audio_port},
            {"ELEVENLABS_API_KEY": "el-test"},
        )

    call = mock_client.post.call_args
    url = call.args[0]
    files = call.kwargs["files"]
    data = call.kwargs["data"]
    headers = call.kwargs["headers"]

    assert "speech-to-text" in url
    assert "file" in files
    assert data["model_id"] == "scribe_v1"
    assert headers["xi-api-key"] == "el-test"
    assert result["text"]["type"] == "Text"
    assert result["text"]["value"] == "hello world"


@pytest.mark.asyncio
async def test_stt_language_auto_omitted(tmp_path: Path) -> None:
    audio_file, audio_port = _mock_audio_input(tmp_path)
    resp = _stt_response({"text": "hi"})

    with patch("handlers.elevenlabs.httpx.AsyncClient") as MockClient:
        mock_client = AsyncMock()
        mock_client.post.return_value = resp
        mock_client.__aenter__ = AsyncMock(return_value=mock_client)
        mock_client.__aexit__ = AsyncMock(return_value=False)
        MockClient.return_value = mock_client

        await handle_elevenlabs_stt(
            _make_stt_node({"model_id": "scribe_v1", "language_code": "auto"}),
            {"audio": audio_port},
            {"ELEVENLABS_API_KEY": "el-test"},
        )

    data = mock_client.post.call_args.kwargs["data"]
    assert "language_code" not in data


@pytest.mark.asyncio
async def test_stt_explicit_language_forwarded(tmp_path: Path) -> None:
    audio_file, audio_port = _mock_audio_input(tmp_path)
    resp = _stt_response({"text": "bonjour"})

    with patch("handlers.elevenlabs.httpx.AsyncClient") as MockClient:
        mock_client = AsyncMock()
        mock_client.post.return_value = resp
        mock_client.__aenter__ = AsyncMock(return_value=mock_client)
        mock_client.__aexit__ = AsyncMock(return_value=False)
        MockClient.return_value = mock_client

        await handle_elevenlabs_stt(
            _make_stt_node({"model_id": "scribe_v1", "language_code": "fr"}),
            {"audio": audio_port},
            {"ELEVENLABS_API_KEY": "el-test"},
        )

    data = mock_client.post.call_args.kwargs["data"]
    assert data["language_code"] == "fr"


@pytest.mark.asyncio
async def test_stt_diarize_and_num_speakers_forwarded(tmp_path: Path) -> None:
    audio_file, audio_port = _mock_audio_input(tmp_path)
    resp = _stt_response({"text": "two people talking"})

    with patch("handlers.elevenlabs.httpx.AsyncClient") as MockClient:
        mock_client = AsyncMock()
        mock_client.post.return_value = resp
        mock_client.__aenter__ = AsyncMock(return_value=mock_client)
        mock_client.__aexit__ = AsyncMock(return_value=False)
        MockClient.return_value = mock_client

        await handle_elevenlabs_stt(
            _make_stt_node({"model_id": "scribe_v1", "diarize": True, "num_speakers": 2}),
            {"audio": audio_port},
            {"ELEVENLABS_API_KEY": "el-test"},
        )

    data = mock_client.post.call_args.kwargs["data"]
    assert data["diarize"] == "true"
    assert data["num_speakers"] == "2"


@pytest.mark.asyncio
async def test_stt_tag_audio_events_disabled_forwarded(tmp_path: Path) -> None:
    """tag_audio_events defaults true on the API; only send when disabled."""
    audio_file, audio_port = _mock_audio_input(tmp_path)
    resp = _stt_response({"text": "no events"})

    with patch("handlers.elevenlabs.httpx.AsyncClient") as MockClient:
        mock_client = AsyncMock()
        mock_client.post.return_value = resp
        mock_client.__aenter__ = AsyncMock(return_value=mock_client)
        mock_client.__aexit__ = AsyncMock(return_value=False)
        MockClient.return_value = mock_client

        await handle_elevenlabs_stt(
            _make_stt_node({"model_id": "scribe_v1", "tag_audio_events": False}),
            {"audio": audio_port},
            {"ELEVENLABS_API_KEY": "el-test"},
        )

    data = mock_client.post.call_args.kwargs["data"]
    assert data["tag_audio_events"] == "false"


@pytest.mark.asyncio
async def test_stt_srt_format_requests_and_returns_subtitles(tmp_path: Path) -> None:
    """transcript_format=srt requests additional_formats and returns the SRT content."""
    audio_file, audio_port = _mock_audio_input(tmp_path)
    srt = "1\n00:00:00,000 --> 00:00:01,000\nhello world\n"
    resp = _stt_response({
        "text": "hello world",
        "additional_formats": [
            {"requested_format": "srt", "file_extension": "srt",
             "content_type": "text/plain", "is_base64_encoded": False, "content": srt},
        ],
    })

    with patch("handlers.elevenlabs.httpx.AsyncClient") as MockClient:
        mock_client = AsyncMock()
        mock_client.post.return_value = resp
        mock_client.__aenter__ = AsyncMock(return_value=mock_client)
        mock_client.__aexit__ = AsyncMock(return_value=False)
        MockClient.return_value = mock_client

        result = await handle_elevenlabs_stt(
            _make_stt_node({"model_id": "scribe_v1", "transcript_format": "srt"}),
            {"audio": audio_port},
            {"ELEVENLABS_API_KEY": "el-test"},
        )

    data = mock_client.post.call_args.kwargs["data"]
    assert json.loads(data["additional_formats"]) == [{"format": "srt"}]
    # ElevenLabs rejects additional_formats unless diarization + timestamps are
    # enabled (HTTP 400 invalid_parameters). Caught by live smoke 2026-06-05.
    assert data["diarize"] == "true"
    assert data["timestamps_granularity"] == "word"
    assert result["text"]["value"] == srt


@pytest.mark.asyncio
async def test_stt_raises_on_api_error(tmp_path: Path) -> None:
    audio_file, audio_port = _mock_audio_input(tmp_path)
    err = MagicMock()
    err.status_code = 422
    err.text = "validation error"

    with patch("handlers.elevenlabs.httpx.AsyncClient") as MockClient:
        mock_client = AsyncMock()
        mock_client.post.return_value = err
        mock_client.__aenter__ = AsyncMock(return_value=mock_client)
        mock_client.__aexit__ = AsyncMock(return_value=False)
        MockClient.return_value = mock_client

        with pytest.raises(RuntimeError, match="422"):
            await handle_elevenlabs_stt(
                _make_stt_node(),
                {"audio": audio_port},
                {"ELEVENLABS_API_KEY": "el-test"},
            )

