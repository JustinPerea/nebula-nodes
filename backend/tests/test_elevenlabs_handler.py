from __future__ import annotations

from pathlib import Path
from unittest.mock import AsyncMock, MagicMock, patch

import pytest

from handlers.elevenlabs import handle_elevenlabs_tts
from models.graph import GraphNode, PortValueDict


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


@pytest.mark.asyncio
async def test_tts_maps_voice_settings_and_query_params() -> None:
    response = MagicMock()
    response.status_code = 200
    response.content = b"fake mp3"

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

    assert url.endswith("/voice-test?output_format=mp3_44100_128")
    assert body["text"] == "read this"
    assert body["model_id"] == "eleven_multilingual_v2"
    assert body["voice_settings"] == {
        "stability": 0.4,
        "similarity_boost": 0.8,
        "use_speaker_boost": False,
        "style": 0.2,
    }
    assert body["speed"] == 1.1
    assert body["seed"] == 123
    assert result["audio"]["type"] == "Audio"
    assert Path(result["audio"]["value"]).exists()


@pytest.mark.asyncio
async def test_tts_defaults_speaker_boost_to_true() -> None:
    response = MagicMock()
    response.status_code = 200
    response.content = b"fake mp3"

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
