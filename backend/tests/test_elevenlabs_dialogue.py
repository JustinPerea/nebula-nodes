"""ElevenLabs Text to Dialogue node (elevenlabs-dialogue). No network: HTTP is mocked."""
from __future__ import annotations

import json
from pathlib import Path
from unittest.mock import AsyncMock, MagicMock, Mock, patch

import pytest

from execution.sync_runner import SYNC_HANDLERS
from handlers import elevenlabs
from handlers.elevenlabs import (
    DIALOGUE_MAX_CHARS,
    build_dialogue_request,
    handle_elevenlabs_dialogue,
    parse_dialogue_script,
)
from models.graph import GraphNode, PortValueDict
from services import node_readiness

DEFS_PATH = Path(__file__).resolve().parents[1] / "data" / "node_definitions.json"
DEFINITIONS = json.loads(DEFS_PATH.read_text())
DIALOGUE = DEFINITIONS["elevenlabs-dialogue"]

VOICE_A = "21m00Tcm4TlvDq8ikWAM"
VOICE_B = "JBFqnCBsd6RMkjVDRZzb"
SCRIPT = "1: [cheerfully] Morning!\n\nSpeaker 2: Is it, though?\n1: It is now."


def _node(**params) -> GraphNode:
    base = {"voice_1": VOICE_A, "voice_2": VOICE_B}
    base.update(params)
    return GraphNode(id="dlg-1", definitionId="elevenlabs-dialogue", params=base)


def _mock_client(status: int = 200, content: bytes = b"ID3fake"):
    response = MagicMock()
    response.status_code = status
    response.content = content
    response.text = content.decode(errors="replace")
    client = AsyncMock()
    client.post.return_value = response
    client.__aenter__ = AsyncMock(return_value=client)
    client.__aexit__ = AsyncMock(return_value=False)
    return client


async def _run(node: GraphNode, script: str = SCRIPT):
    client = _mock_client()
    with patch("handlers.elevenlabs.httpx.AsyncClient", return_value=client):
        result = await handle_elevenlabs_dialogue(
            node, {"script": PortValueDict(type="Text", value=script)}, {"ELEVENLABS_API_KEY": "el-test"})
    return client.post.call_args, result


# -- request body per model -----------------------------------------------------

@pytest.mark.asyncio
@pytest.mark.parametrize("model_id", ["eleven_v4", "eleven_v3"])
async def test_body_per_model(model_id):
    call, result = await _run(_node(model_id=model_id, stability=0.3, similarity=0.9, seed=7,
                                    language_code="EN", output_format="mp3_22050_32"))
    url, body, headers = call.args[0], call.kwargs["json"], call.kwargs["headers"]
    assert url == "https://api.elevenlabs.io/v1/text-to-dialogue?output_format=mp3_22050_32"
    assert headers["xi-api-key"] == "el-test"
    assert body == {
        "inputs": [
            {"text": "[cheerfully] Morning!", "voice_id": VOICE_A},
            {"text": "Is it, though?", "voice_id": VOICE_B},
            {"text": "It is now.", "voice_id": VOICE_A},
        ],
        "model_id": model_id,
        "settings": {"stability": 0.3, "similarity": 0.9},
        "language_code": "en",
        "seed": 7,
    }
    assert result["audio"]["type"] == "Audio"
    saved = Path(result["audio"]["value"])
    assert saved.suffix == ".mp3" and saved.read_bytes() == b"ID3fake"


@pytest.mark.asyncio
async def test_defaults_send_eleven_v4_explicitly_and_nothing_tts_only():
    """The endpoint defaults to eleven_v3, so model_id is always sent. Speed,
    style and speaker boost have no field on this endpoint."""
    call, _ = await _run(GraphNode(id="d", definitionId="elevenlabs-dialogue", params={}), "1: Hello.")
    body = call.kwargs["json"]
    assert body["model_id"] == "eleven_v4"
    assert body["inputs"] == [{"text": "Hello.", "voice_id": VOICE_A}]
    assert body["settings"] == {"stability": 0.5, "similarity": 0.75}
    assert set(body) == {"inputs", "model_id", "settings"}
    flat = json.dumps(body)
    for key in ("speed", "style", "use_speaker_boost", "similarity_boost", "voice_settings"):
        assert f'"{key}"' not in flat
    assert call.args[0].endswith("?output_format=mp3_44100_128")


@pytest.mark.asyncio
async def test_pcm_output_is_saved_as_pcm():
    _, result = await _run(_node(output_format="pcm_24000"), "1: Hi.")
    assert result["audio"]["value"].endswith(".pcm")


@pytest.mark.asyncio
async def test_api_error_is_raised_with_status():
    client = _mock_client(status=422, content=b'{"detail":"bad"}')
    with patch("handlers.elevenlabs.httpx.AsyncClient", return_value=client):
        with pytest.raises(RuntimeError, match="Text to Dialogue error 422"):
            await handle_elevenlabs_dialogue(
                _node(), {"script": PortValueDict(type="Text", value="1: Hi.")}, {"ELEVENLABS_API_KEY": "k"})


# -- script parsing and validation ------------------------------------------------

def test_parse_accepts_both_label_forms_and_skips_blank_lines():
    turns = parse_dialogue_script("  1 : One\n\n SPEAKER 2: Two\nspeaker4:Four", {1: "a", 2: "b", 4: "d"})
    assert turns == [{"text": "One", "voice_id": "a"}, {"text": "Two", "voice_id": "b"},
                     {"text": "Four", "voice_id": "d"}]


@pytest.mark.parametrize("script,message", [
    ("Hello there", "no speaker label"),
    ("1: Hi\nNarrator: hello", "no speaker label"),
    ("5: Hi", "unknown speaker label '5'"),
    ("0: Hi", "unknown speaker label '0'"),
    ("3: Hi", "Speaker 3 Voice ID is empty"),
    ("1:   ", "has no text"),
    ("\n \n", "script is empty"),
])
def test_parse_refuses_bad_scripts(script, message):
    with pytest.raises(ValueError, match=message):
        parse_dialogue_script(script, {1: "a", 2: "b"})


def test_parse_refuses_past_the_reliable_total():
    at_limit = "1: " + "a" * DIALOGUE_MAX_CHARS
    assert len(parse_dialogue_script(at_limit, {1: "a"})[0]["text"]) == DIALOGUE_MAX_CHARS
    over = "1: " + "a" * 1000 + "\n2: " + "b" * (DIALOGUE_MAX_CHARS - 999)
    with pytest.raises(ValueError, match="2,001 characters.*2,000"):
        parse_dialogue_script(over, {1: "a", 2: "b"})


@pytest.mark.parametrize("params,message", [
    ({"model_id": "eleven_multilingual_v2"}, "model_id must be one of"),
    ({"language_code": "en-US"}, "language_code"),
    ({"seed": -1}, "seed must be between"),
    ({"seed": 4_294_967_296}, "seed must be between"),
    ({"voice_2": "../../music"}, "voice_2 must be an ElevenLabs voice ID"),
    ({"output_format": "mp3&enable_logging=false"}, "output_format"),
])
def test_build_refuses_bad_params(params, message):
    with pytest.raises(ValueError, match=message):
        build_dialogue_request(_node(**params), "1: Hi\n2: Yo")


@pytest.mark.asyncio
async def test_bad_script_never_reaches_the_network():
    network = Mock(side_effect=AssertionError("ElevenLabs must not be called"))
    with patch.object(elevenlabs.httpx, "AsyncClient", network):
        with pytest.raises(ValueError, match="unknown speaker label"):
            await handle_elevenlabs_dialogue(
                _node(), {"script": PortValueDict(type="Text", value="9: Hi")}, {"ELEVENLABS_API_KEY": "k"})
    network.assert_not_called()


@pytest.mark.asyncio
async def test_missing_script_and_missing_key():
    with pytest.raises(ValueError, match="Script input is required"):
        await handle_elevenlabs_dialogue(_node(), {}, {"ELEVENLABS_API_KEY": "k"})
    from execution.missing_credential import MissingCredentialError
    with pytest.raises(MissingCredentialError, match="ELEVENLABS_API_KEY"):
        await handle_elevenlabs_dialogue(_node(), {"script": PortValueDict(type="Text", value="1: Hi")}, {})


# -- definition, registration and key readiness -----------------------------------

def test_definition_matches_the_endpoint():
    assert DIALOGUE["apiProvider"] == "elevenlabs"
    assert DIALOGUE["apiEndpoint"] == "/v1/text-to-dialogue"
    assert DIALOGUE["executionPattern"] == "sync"
    params = {p["key"]: p for p in DIALOGUE["params"]}
    model = params["model_id"]
    assert model["default"] == "eleven_v4"
    assert [o["value"] for o in model["options"]] == ["eleven_v4", "eleven_v3"]
    assert set(params) == {"model_id", "voice_1", "voice_2", "voice_3", "voice_4", "stability",
                           "similarity", "language_code", "output_format", "seed"}
    tts_formats = next(p for p in DEFINITIONS["elevenlabs-tts"]["params"] if p["key"] == "output_format")
    assert params["output_format"]["options"] == tts_formats["options"]
    assert [p["id"] for p in DIALOGUE["inputPorts"]] == ["script"]
    assert [p["id"] for p in DIALOGUE["outputPorts"]] == ["audio"]
    assert SYNC_HANDLERS["elevenlabs-dialogue"] is handle_elevenlabs_dialogue


def test_tts_turbo_options_are_labelled_deprecated_but_kept():
    model = next(p for p in DEFINITIONS["elevenlabs-tts"]["params"] if p["key"] == "model_id")
    labels = {o["value"]: o["label"] for o in model["options"]}
    assert "deprecated" in labels["eleven_turbo_v2_5"]
    assert "deprecated" in labels["eleven_turbo_v2"]
    assert "deprecated" not in labels["eleven_flash_v2_5"]


def test_key_readiness_uses_the_elevenlabs_key():
    assert DIALOGUE["envKeyName"] == "ELEVENLABS_API_KEY"
    assert node_readiness.node_access(DIALOGUE, {"ELEVENLABS_API_KEY"}, False, DEFINITIONS) == "key"
    assert node_readiness.node_access(DIALOGUE, {"OPENAI_API_KEY", "FAL_KEY"}, False, DEFINITIONS) is None
    assert "ELEVENLABS_API_KEY" in str(node_readiness.missing(DIALOGUE, False, DEFINITIONS))
