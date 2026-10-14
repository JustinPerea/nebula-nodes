"""ElevenLabs' own API for its fal, Krea and Runway copies.

Only the transport is mocked: nothing is contacted and nothing is billed.
Covers the route each run takes (ElevenLabs key wins, the Krea plan wins over
it, Runway keeps recipes that only name a Runway voice preset), that each
route gets only its own params, that the saved node is never mutated, and the
requests sent to ElevenLabs.
"""
from __future__ import annotations

import copy
import json
from unittest.mock import AsyncMock, MagicMock, patch

import pytest

from execution import maker_routes_elevenlabs
from execution.missing_credential import MissingCredentialError
from execution.sync_runner import get_handler_registry
from models.graph import GraphNode, PortValueDict
from services import model_pricing, node_route
from services.node_registry import NodeRegistry
from services.output import get_run_dir

DEFINITIONS = NodeRegistry().get_all()
ELEVEN = {"ELEVENLABS_API_KEY": "fixture-eleven"}
FAL = {"FAL_KEY": "fixture-fal"}
KREA = {"KREA_API_TOKEN": "fixture-krea"}
RUNWAY = {"RUNWAY_API_KEY": "fixture-runway"}
PROMPT = {"prompt": PortValueDict(type="Text", value="a slow piano waltz")}
VOICE = "pNInz6obpgDQGcFmaJgB"


def _client(content=b"ID3fake-mp3", json_body=None):
    response = MagicMock()
    response.status_code = 200
    response.content = content
    response.json.return_value = json_body or {}
    client = AsyncMock()
    client.post.return_value = response
    client.__aenter__.return_value = client
    client.__aexit__.return_value = False
    return client


async def _run(node, inputs, keys):
    return await get_handler_registry(emit=AsyncMock())[node.definition_id](node, inputs, keys)


def _defaults(definition_id):
    definition = DEFINITIONS[definition_id]
    return {p["key"]: p["default"] for name in ("params", "sharedParams", "falParams", "directParams")
            for p in definition.get(name) or [] if "default" in p}


def _audio_file(name="in.mp3"):
    path = get_run_dir() / name
    path.write_bytes(b"ID3fake-input")
    return PortValueDict(type="Audio", value=str(path))


# -- Music ---------------------------------------------------------------------

@pytest.mark.asyncio
async def test_fal_music_runs_on_elevenlabs_with_the_key():
    node = GraphNode(id="m", definitionId="elevenlabs-music",
                     params={**_defaults("elevenlabs-music"), "force_instrumental": True, "model_id": "music_v2_5"})
    before = copy.deepcopy(node.params)
    client = _client()
    # One httpx module serves both handlers: the only call made is ElevenLabs'.
    with patch("handlers.elevenlabs.httpx.AsyncClient", return_value=client):
        result = await _run(node, PROMPT, {**ELEVEN, **FAL})
    assert client.post.call_count == 1
    assert node.params == before
    assert client.post.call_args.args[0] == "https://api.elevenlabs.io/v1/music"
    assert client.post.call_args.kwargs["headers"]["xi-api-key"] == "fixture-eleven"
    assert client.post.call_args.kwargs["json"] == {
        "prompt": "a slow piano waltz", "model_id": "music_v2_5", "music_length_ms": 30000,
        "force_instrumental": True}
    assert result["audio"]["value"].endswith(".mp3")


@pytest.mark.asyncio
async def test_fal_music_unset_settings_take_the_definition_defaults():
    """Pricing reads the definition default (30 s, music_v1); the run sends it."""
    node = GraphNode(id="m", definitionId="elevenlabs-music", params={})
    client = _client()
    with patch("handlers.elevenlabs.httpx.AsyncClient", return_value=client):
        await _run(node, PROMPT, ELEVEN)
    assert client.post.call_args.kwargs["json"] == {
        "prompt": "a slow piano waltz", "model_id": "music_v1", "music_length_ms": 30000}


@pytest.mark.asyncio
async def test_fal_music_stays_on_fal_and_fal_never_gets_model_id():
    node = GraphNode(id="m", definitionId="elevenlabs-music", params=_defaults("elevenlabs-music"))
    assert "model_id" in node.params, "the test needs the direct-only default seeded"
    before = copy.deepcopy(node.params)
    client = _client(json_body={"audio": {"url": "https://example.com/song.mp3"}})
    with patch("handlers.fal_universal.httpx.AsyncClient", return_value=client):
        try:
            await _run(node, PROMPT, {**FAL, "ELEVENLABS_API_KEY": "  "})
        except Exception:  # noqa: BLE001 - only the outgoing request matters
            pass
    assert node.params == before
    assert all("elevenlabs.io" not in str(call.args[0]) for call in client.post.call_args_list)
    assert "fal-ai/elevenlabs/music" in client.post.call_args.args[0]
    body = client.post.call_args.kwargs["json"]
    assert "model_id" not in body and body["music_length_ms"] == 30000


@pytest.mark.asyncio
@pytest.mark.parametrize("node_id,model", [
    ("krea-audio-elevenlabs-music", "music_v1"),
    ("krea-audio-elevenlabs-music-v2", "music_v2"),
    ("krea-audio-elevenlabs-music-v2-5", "music_v2_5"),
])
async def test_krea_music_runs_its_model_on_elevenlabs(node_id, model):
    node = GraphNode(id="k", definitionId=node_id, params={"_kreaAuth": "api-token", "prompt": "lofi rain"})
    client = _client()
    gateway = AsyncMock()
    with patch("handlers.elevenlabs.httpx.AsyncClient", return_value=client), \
            patch("handlers.krea_gateway.handle_krea_gateway", gateway):
        result = await _run(node, {}, {**ELEVEN, **KREA})
    gateway.assert_not_called()
    # No length set: ElevenLabs picks it, as on Krea ("Omit to let the model choose").
    assert client.post.call_args.kwargs["json"] == {"prompt": "lofi rain", "model_id": model}
    assert set(result) == {"audio", "audios", "artifacts"}
    assert result["artifacts"]["value"][0]["type"] == "Audio"


@pytest.mark.asyncio
async def test_krea_plan_wins_over_the_elevenlabs_key():
    seen = {}

    async def gateway(node, inputs, api_keys, emit=None):
        seen.update(node.params)
        return {"audio": {"type": "Audio", "value": "https://example.com/k.mp3"}}

    params = {"_kreaAuth": "mcp", "prompt": "p", "music_length_ms": 5000, "force_instrumental": False}
    node = GraphNode(id="k", definitionId="krea-audio-elevenlabs-music-v2", params=params)
    with patch("handlers.krea_gateway.handle_krea_gateway", gateway), \
            patch("handlers.elevenlabs.httpx.AsyncClient") as eleven:
        await _run(node, PROMPT, {**ELEVEN, **KREA})
    eleven.assert_not_called()
    assert seen == params


def test_music_handler_refuses_out_of_range_lengths_before_any_call():
    from handlers.elevenlabs import handle_elevenlabs_music
    import asyncio

    node = GraphNode(id="m", definitionId="elevenlabs-music", params={"music_length_ms": 700000})
    with patch("handlers.elevenlabs.httpx.AsyncClient") as eleven, pytest.raises(ValueError, match="600000"):
        asyncio.run(handle_elevenlabs_music(node, PROMPT, ELEVEN))
    eleven.assert_not_called()


# -- Krea TTS --------------------------------------------------------------------

@pytest.mark.asyncio
async def test_krea_tts_runs_on_elevenlabs_with_the_krea_voice_and_no_voice_override():
    node = GraphNode(id="t", definitionId="krea-audio-elevenlabs-tts", params={"_kreaAuth": "api-token"})
    client = _client()
    with patch("handlers.elevenlabs.httpx.AsyncClient", return_value=client):
        result = await _run(node, {"prompt": PortValueDict(type="Text", value="Hello there")}, {**ELEVEN, **KREA})
    url = client.post.call_args.args[0]
    # Krea's default voice is ElevenLabs' "Bella (hpp4J3VqNfWAUOO0d1Us)".
    assert url.startswith("https://api.elevenlabs.io/v1/text-to-speech/hpp4J3VqNfWAUOO0d1Us")
    assert client.post.call_args.kwargs["json"] == {"text": "Hello there", "model_id": "eleven_multilingual_v2"}
    assert set(result) == {"audio", "audios", "artifacts"}


@pytest.mark.asyncio
async def test_krea_tts_sends_a_saved_voice_and_model():
    node = GraphNode(id="t", definitionId="krea-audio-elevenlabs-tts",
                     params={"prompt": "From the param", "voice_id": VOICE, "model_id": "eleven_v4"})
    client = _client()
    with patch("handlers.elevenlabs.httpx.AsyncClient", return_value=client):
        await _run(node, {}, ELEVEN)
    assert f"/v1/text-to-speech/{VOICE}" in client.post.call_args.args[0]
    assert client.post.call_args.kwargs["json"] == {"text": "From the param", "model_id": "eleven_v4"}


@pytest.mark.asyncio
async def test_first_party_tts_still_sends_its_voice_settings():
    node = GraphNode(id="t", definitionId="elevenlabs-tts", params={})
    client = _client()
    with patch("handlers.elevenlabs.httpx.AsyncClient", return_value=client):
        await _run(node, {"text": PortValueDict(type="Text", value="hi")}, ELEVEN)
    assert client.post.call_args.kwargs["json"]["voice_settings"]["stability"] == 0.5


# -- Runway's ElevenLabs models ----------------------------------------------------

@pytest.mark.asyncio
async def test_runway_tts_with_only_a_runway_preset_stays_on_runway():
    node = GraphNode(id="r", definitionId="runway-tts", params=_defaults("runway-tts"))
    with patch("handlers.runway.async_poll_execute", new_callable=AsyncMock) as poll, \
            patch("handlers.runway._save_audio_from_url", new_callable=AsyncMock, return_value="/tmp/x.mp3"), \
            patch("handlers.elevenlabs.httpx.AsyncClient") as eleven:
        poll.return_value = {"output": ["https://example.com/a.mp3"]}
        await _run(node, {"text": PortValueDict(type="Text", value="hi")}, {**ELEVEN, **RUNWAY})
    eleven.assert_not_called()
    body = poll.call_args.kwargs["submit_body"]
    assert body["voice"] == {"type": "runway-preset", "presetId": "Maya"}
    assert "voice_id" not in json.dumps(body)


@pytest.mark.asyncio
async def test_runway_tts_with_an_elevenlabs_voice_runs_on_elevenlabs():
    node = GraphNode(id="r", definitionId="runway-tts", params={**_defaults("runway-tts"), "voice_id": VOICE})
    before = copy.deepcopy(node.params)
    client = _client()
    with patch("handlers.elevenlabs.httpx.AsyncClient", return_value=client), \
            patch("handlers.runway.async_poll_execute", new_callable=AsyncMock) as poll:
        await _run(node, {"text": PortValueDict(type="Text", value="x" * 1500)}, {**ELEVEN, **RUNWAY})
    poll.assert_not_called()
    assert node.params == before
    assert f"/v1/text-to-speech/{VOICE}" in client.post.call_args.args[0]
    body = client.post.call_args.kwargs["json"]
    assert body == {"text": "x" * 1500, "model_id": "eleven_multilingual_v2"}


@pytest.mark.asyncio
async def test_runway_tts_with_only_the_elevenlabs_key_says_what_is_missing():
    node = GraphNode(id="r", definitionId="runway-tts", params=_defaults("runway-tts"))
    with pytest.raises(MissingCredentialError, match="RUNWAY_API_KEY is required.*needs voice_id"):
        await _run(node, {"text": PortValueDict(type="Text", value="hi")}, ELEVEN)


@pytest.mark.asyncio
async def test_runway_sts_runs_on_elevenlabs_with_the_multilingual_voice_changer():
    node = GraphNode(id="s", definitionId="runway-sts",
                     params={**_defaults("runway-sts"), "voice_id": VOICE, "removeBackgroundNoise": True})
    client = _client()
    with patch("handlers.elevenlabs.httpx.AsyncClient", return_value=client):
        await _run(node, {"audio": _audio_file()}, {**ELEVEN, **RUNWAY})
    assert f"/v1/speech-to-speech/{VOICE}" in client.post.call_args.args[0]
    data = client.post.call_args.kwargs["data"]
    assert data == {"model_id": "eleven_multilingual_sts_v2", "remove_background_noise": "true"}
    assert "audio" in client.post.call_args.kwargs["files"]


@pytest.mark.asyncio
async def test_runway_sts_video_only_is_refused_before_any_elevenlabs_call():
    node = GraphNode(id="s", definitionId="runway-sts", params={"voice_id": VOICE})
    video = PortValueDict(type="Video", value="/tmp/in.mp4")
    with patch("handlers.elevenlabs.httpx.AsyncClient") as eleven, pytest.raises(ValueError, match="audio, not video"):
        await _run(node, {"video": video}, {**ELEVEN, **RUNWAY})
    eleven.assert_not_called()


@pytest.mark.asyncio
async def test_runway_dubbing_runs_on_elevenlabs_with_renamed_fields():
    node = GraphNode(id="d", definitionId="runway-dubbing", params={
        **_defaults("runway-dubbing"), "targetLang": "ja", "numSpeakers": 2, "dropBackgroundAudio": True,
        "disableVoiceCloning": True})
    before = copy.deepcopy(node.params)
    client = _client(json_body={"dubbing_id": "dub1", "expected_duration_sec": 3})
    status = MagicMock(status_code=200)
    status.json.return_value = {"status": "dubbed"}
    audio = MagicMock(status_code=200, content=b"ID3dub")
    client.get.side_effect = [status, audio]
    with patch("handlers.elevenlabs.httpx.AsyncClient", return_value=client), \
            patch("handlers.elevenlabs.asyncio.sleep", new_callable=AsyncMock), \
            patch("handlers.runway.async_poll_execute", new_callable=AsyncMock) as poll:
        result = await _run(node, {"audio": _audio_file("dub.mp3")}, {**ELEVEN, **RUNWAY})
    poll.assert_not_called()
    assert node.params == before
    assert client.post.call_args.args[0] == "https://api.elevenlabs.io/v1/dubbing"
    assert client.post.call_args.kwargs["data"] == {
        "target_lang": "ja", "num_speakers": "2", "drop_background_audio": "true", "disable_voice_cloning": "true"}
    assert client.get.call_args_list[-1].args[0] == "https://api.elevenlabs.io/v1/dubbing/dub1/audio/ja"
    assert result["audio"]["type"] == "Audio"


@pytest.mark.asyncio
async def test_runway_dubbing_without_the_elevenlabs_key_stays_on_runway():
    node = GraphNode(id="d", definitionId="runway-dubbing", params=_defaults("runway-dubbing"))
    with patch("handlers.runway.async_poll_execute", new_callable=AsyncMock) as poll, \
            patch("handlers.runway._local_media_uri", new_callable=AsyncMock, return_value="data:audio/mpeg;base64,AA"), \
            patch("handlers.runway._save_audio_from_url", new_callable=AsyncMock, return_value="/tmp/x.mp3"):
        poll.return_value = {"output": ["https://example.com/a.mp3"]}
        await _run(node, {"audio": PortValueDict(type="Audio", value="/tmp/in.mp3")}, RUNWAY)
    assert poll.call_args.kwargs["submit_body"]["targetLang"] == "es"


def test_every_runway_dubbing_language_is_an_elevenlabs_dubbing_language():
    """Dubbing v1 languages (ElevenLabs help center, read 2026-10-14)."""
    v1 = set("af ar hy as ast az be bn bs bg my yue ca ceb ny zh hr cs da nl en et fil fi fr gl ka de el gu ha he hi "
             "hu is id ga it ja jv kn kk ko ky lv ln lt lb mk ms ml mt mi mr mn ne no oc or ps fa pl pt pa ro ru sr "
             "sd sk sl so es sw sv tl tg ta te th tr uk ur uz vi cy yo".split())
    target = next(p for p in DEFINITIONS["runway-dubbing"]["sharedParams"] if p["key"] == "targetLang")
    assert {o["value"] for o in target["options"]} <= v1


# -- Route and price --------------------------------------------------------------

def test_runway_is_the_named_fallback():
    for node_id in ("runway-tts", "runway-sts", "runway-dubbing"):
        assert node_route.fallback_provider(DEFINITIONS[node_id]) == "runway"
    route = node_route.select_route(DEFINITIONS["runway-tts"], {"voice_id": VOICE}, {**ELEVEN, **RUNWAY})
    assert route == node_route.Route(node_route.DIRECT, "elevenlabs", "ELEVENLABS_API_KEY")


@pytest.mark.parametrize("node_id,params,keys,expected", [
    ("elevenlabs-music", {}, ELEVEN, (0.075, 0.075)),
    ("elevenlabs-music", {"music_length_ms": 60000}, ELEVEN, (0.15, 0.15)),
    ("elevenlabs-music", {}, FAL, None),  # the fal route has no list price here
    ("krea-audio-elevenlabs-music-v2", {}, ELEVEN, (0.0075, 1.5)),  # the model picks the length
    ("krea-audio-elevenlabs-music-v2", {"music_length_ms": 120000}, ELEVEN, (0.3, 0.3)),
    ("krea-audio-elevenlabs-music-v2", {"_kreaAuth": "mcp"}, ELEVEN, None),
    ("krea-audio-elevenlabs-tts", {}, ELEVEN, None),  # billed per character of the prompt
    ("runway-tts", {"voice_id": VOICE}, ELEVEN, None),
])
def test_elevenlabs_route_prices(node_id, params, keys, expected):
    definition = DEFINITIONS[node_id]
    entry = (model_pricing.load_pricing().get("nodes") or {}).get(node_id)
    estimate = model_pricing.estimate_node(
        entry, definition, params, model_pricing.route_provider(definition, keys, params))
    if expected is None:
        assert estimate is None
    else:
        assert estimate["currency"] == "usd"
        assert (round(estimate["low"], 6), round(estimate["high"], 6)) == expected


def test_registered_routes_cover_exactly_the_lane():
    registry = get_handler_registry(emit=AsyncMock())
    for node_id in ("elevenlabs-music", "runway-tts", "runway-sts", "runway-dubbing", "krea-audio-elevenlabs-tts",
                    "krea-audio-elevenlabs-music", "krea-audio-elevenlabs-music-v2", "krea-audio-elevenlabs-music-v2-5"):
        assert getattr(registry[node_id], "dual_route", False), node_id
    assert set(maker_routes_elevenlabs.KREA_TRANSLATIONS) == {"krea-elevenlabs-music", "krea-elevenlabs-tts"}
