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
    DIALOGUE_MAX_VOICES,
    ELEVENLABS_VOICES_URL,
    build_dialogue_request,
    handle_elevenlabs_dialogue,
    parse_dialogue_script,
)
from models.graph import GraphNode, PortValueDict
from services import node_readiness

DEFS_PATH = Path(__file__).resolve().parents[1] / "data" / "node_definitions.json"
DEFINITIONS = json.loads(DEFS_PATH.read_text())
DIALOGUE = DEFINITIONS["elevenlabs-dialogue"]

RACHEL = "21m00Tcm4TlvDq8ikWAM"
GEORGE = "JBFqnCBsd6RMkjVDRZzb"
ARIA = "Aw4FAjKCGjjNkVhN1Xmq"
CLONE_1 = "Cl0neAAAAAAAAAAAAAA1"
CLONE_2 = "Cl0neBBBBBBBBBBBBBB2"
VOICES = [
    {"voice_id": RACHEL, "name": "Rachel", "category": "premade"},
    {"voice_id": GEORGE, "name": "George", "category": "premade"},
    {"voice_id": ARIA, "name": "Dr. Aria O'Neil", "category": "generated"},
    {"voice_id": CLONE_1, "name": "Justin", "category": "cloned"},
    {"voice_id": CLONE_2, "name": "justin ", "category": "professional"},
]
SCRIPT = "Rachel: [cheerfully] Morning!\n\n  george : Is it, though?\nRachel: It is now."


def _node(**params) -> GraphNode:
    return GraphNode(id="dlg-1", definitionId="elevenlabs-dialogue", params=params)


def _response(status: int = 200, payload=None, content: bytes = b""):
    response = MagicMock()
    response.status_code = status
    response.content = content
    response.text = content.decode(errors="replace") if content else json.dumps(payload)
    response.json.return_value = payload
    return response


def _voices_page(voices, has_more=False, token=None):
    return _response(payload={"voices": voices, "has_more": has_more, "next_page_token": token,
                              "total_count": len(voices)})


def _search_result(voices):
    """A stand-in for GET /v2/voices?search=: matches name, description, labels, category."""
    def search(term):
        term = term.casefold()
        return [v for v in voices if term in v["name"].casefold() or term in v["category"]]
    return search


def _mock_client(voices=VOICES, pages=None, get_status: int = 200, get_payload=None,
                 post_status: int = 200, post_content: bytes = b"ID3fake"):
    """One AsyncClient for both calls: get = GET /v2/voices, post = the dialogue."""
    search = _search_result(voices)

    async def get(url, headers=None, params=None, timeout=None):
        assert url == ELEVENLABS_VOICES_URL
        if get_status != 200:
            return _response(get_status, get_payload or {"detail": {"message": "nope"}})
        if params and params.get("search"):
            return _voices_page(search(params["search"])[: params.get("page_size", 10)])
        if pages is not None:
            token = (params or {}).get("next_page_token")
            return pages[token]
        return _voices_page(voices)

    client = AsyncMock()
    client.get = AsyncMock(side_effect=get)
    client.post.return_value = _response(post_status, content=post_content)
    client.__aenter__ = AsyncMock(return_value=client)
    client.__aexit__ = AsyncMock(return_value=False)
    return client


async def _run(node: GraphNode, script: str = SCRIPT, client=None):
    client = client or _mock_client()
    with patch("handlers.elevenlabs.httpx.AsyncClient", return_value=client):
        result = await handle_elevenlabs_dialogue(
            node, {"script": PortValueDict(type="Text", value=script)}, {"ELEVENLABS_API_KEY": "el-test"})
    return client, result


async def _refused(script: str, client=None, match: str | None = None):
    client = client or _mock_client()
    with patch("handlers.elevenlabs.httpx.AsyncClient", return_value=client):
        with pytest.raises(ValueError, match=match) as info:
            await handle_elevenlabs_dialogue(
                _node(), {"script": PortValueDict(type="Text", value=script)}, {"ELEVENLABS_API_KEY": "el-test"})
    client.post.assert_not_called()  # the paid call never happens
    return client, str(info.value)


# -- request body per model: the resolved IDs reach the dialogue call -------------

@pytest.mark.asyncio
@pytest.mark.parametrize("model_id", ["eleven_v4", "eleven_v3"])
async def test_body_uses_resolved_voice_ids(model_id):
    client, result = await _run(_node(model_id=model_id, stability=0.3, similarity=0.9, seed=7,
                                      language_code="EN", output_format="mp3_22050_32"))
    call = client.post.call_args
    url, body, headers = call.args[0], call.kwargs["json"], call.kwargs["headers"]
    assert url == "https://api.elevenlabs.io/v1/text-to-dialogue?output_format=mp3_22050_32"
    assert headers["xi-api-key"] == "el-test"
    assert body == {
        "inputs": [
            {"text": "[cheerfully] Morning!", "voice_id": RACHEL},
            {"text": "Is it, though?", "voice_id": GEORGE},
            {"text": "It is now.", "voice_id": RACHEL},
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
async def test_voices_are_listed_once_with_the_same_key_and_a_timeout():
    client, _ = await _run(_node())
    assert client.get.await_count == 1  # one page, two speakers: one lookup for the run
    kwargs = client.get.call_args.kwargs
    assert kwargs["headers"] == {"xi-api-key": "el-test"}
    assert kwargs["params"]["page_size"] == 100
    assert kwargs["timeout"] and kwargs["timeout"] <= 30


@pytest.mark.asyncio
async def test_defaults_send_eleven_v4_explicitly_and_nothing_tts_only():
    """The endpoint defaults to eleven_v3, so model_id is always sent. Speed,
    style and speaker boost have no field on this endpoint."""
    client, _ = await _run(_node(), "Rachel: Hello.")
    call = client.post.call_args
    body = call.kwargs["json"]
    assert body["model_id"] == "eleven_v4"
    assert body["inputs"] == [{"text": "Hello.", "voice_id": RACHEL}]
    assert body["settings"] == {"stability": 0.5, "similarity": 0.75}
    assert set(body) == {"inputs", "model_id", "settings"}
    flat = json.dumps(body)
    for key in ("speed", "style", "use_speaker_boost", "similarity_boost", "voice_settings"):
        assert f'"{key}"' not in flat
    assert call.args[0].endswith("?output_format=mp3_44100_128")


@pytest.mark.asyncio
async def test_pcm_output_is_saved_as_pcm():
    _, result = await _run(_node(output_format="pcm_24000"), "Rachel: Hi.")
    assert result["audio"]["value"].endswith(".pcm")


@pytest.mark.asyncio
async def test_api_error_is_raised_with_status():
    client = _mock_client(post_status=422, post_content=b'{"detail":"bad"}')
    with patch("handlers.elevenlabs.httpx.AsyncClient", return_value=client):
        with pytest.raises(RuntimeError, match="Text to Dialogue error 422"):
            await handle_elevenlabs_dialogue(
                _node(), {"script": PortValueDict(type="Text", value="Rachel: Hi.")}, {"ELEVENLABS_API_KEY": "k"})


# -- script parsing ---------------------------------------------------------------

def test_parse_takes_everything_before_the_first_colon_as_the_speaker():
    turns = parse_dialogue_script(
        "  Dr. Aria O'Neil : One: two\n\n Mary-Kate (narrator):Two\nR2-D2 #1: Beep. Time: 3:15")
    assert turns == [
        ("Dr. Aria O'Neil", "One: two"),
        ("Mary-Kate (narrator)", "Two"),
        ("R2-D2 #1", "Beep. Time: 3:15"),
    ]


@pytest.mark.parametrize("script,message", [
    ("Hello there", "no speaker"),
    ("Rachel: Hi\nand then she left", "line 2 has no speaker"),
    (": Hi", "no speaker"),
    ("Rachel:   ", r"\(Rachel\) has no text"),
    ("\n \n", "script is empty"),
])
def test_parse_refuses_bad_scripts(script, message):
    with pytest.raises(ValueError, match=message):
        parse_dialogue_script(script)


def test_parse_refuses_past_the_reliable_total():
    at_limit = "A: " + "a" * DIALOGUE_MAX_CHARS
    assert len(parse_dialogue_script(at_limit)[0][1]) == DIALOGUE_MAX_CHARS
    over = "A: " + "a" * 1000 + "\nB: " + "b" * (DIALOGUE_MAX_CHARS - 999)
    with pytest.raises(ValueError, match="2,001 characters.*2,000"):
        parse_dialogue_script(over)


def test_distinct_voice_limit():
    assert DIALOGUE_MAX_VOICES == 10  # "The maximum number of unique voice IDs is 10"
    ten = "\n".join(f"Voice {n}: Hi." for n in range(10))
    assert len(parse_dialogue_script(ten)) == 10
    # The same speaker written in another case counts once.
    assert len(parse_dialogue_script(ten + "\nvoice 3: Again.")) == 11
    with pytest.raises(ValueError, match="11 speakers.*at most 10 different voices"):
        parse_dialogue_script(ten + "\nVoice 10: One too many.")


@pytest.mark.asyncio
async def test_over_the_voice_limit_stops_before_the_lookup():
    script = "\n".join(f"Voice {n}: Hi." for n in range(11))
    client, _ = await _refused(script, match="at most 10 different voices")
    client.get.assert_not_called()


@pytest.mark.parametrize("params,message", [
    ({"model_id": "eleven_multilingual_v2"}, "model_id must be one of"),
    ({"language_code": "en-US"}, "language_code"),
    ({"seed": -1}, "seed must be between"),
    ({"seed": 4_294_967_296}, "seed must be between"),
    ({"output_format": "mp3&enable_logging=false"}, "output_format"),
])
def test_build_refuses_bad_params(params, message):
    with pytest.raises(ValueError, match=message):
        build_dialogue_request(_node(**params), "Rachel: Hi\nGeorge: Yo")


@pytest.mark.asyncio
@pytest.mark.parametrize("script,params", [
    ("9 Hi", {}),
    ("Rachel: Hi", {"model_id": "eleven_multilingual_v2"}),
    ("Rachel: Hi", {"seed": -1}),
])
async def test_local_checks_never_reach_the_network(script, params):
    network = Mock(side_effect=AssertionError("ElevenLabs must not be called"))
    with patch.object(elevenlabs.httpx, "AsyncClient", network):
        with pytest.raises(ValueError):
            await handle_elevenlabs_dialogue(
                _node(**params), {"script": PortValueDict(type="Text", value=script)}, {"ELEVENLABS_API_KEY": "k"})
    network.assert_not_called()


@pytest.mark.asyncio
async def test_missing_script_and_missing_key():
    with pytest.raises(ValueError, match="Script input is required"):
        await handle_elevenlabs_dialogue(_node(), {}, {"ELEVENLABS_API_KEY": "k"})
    from execution.missing_credential import MissingCredentialError
    with pytest.raises(MissingCredentialError, match="ELEVENLABS_API_KEY"):
        await handle_elevenlabs_dialogue(_node(), {"script": PortValueDict(type="Text", value="Rachel: Hi")}, {})


# -- resolving speakers to voice IDs ----------------------------------------------

@pytest.mark.asyncio
async def test_names_match_ignoring_case_and_surrounding_spaces():
    client, _ = await _run(_node(), "RACHEL: One.\n  dr. aria o'neil  : Two.")
    assert [i["voice_id"] for i in client.post.call_args.kwargs["json"]["inputs"]] == [RACHEL, ARIA]


@pytest.mark.asyncio
async def test_a_voice_id_can_stand_in_for_a_name():
    client, _ = await _run(_node(), f"{GEORGE}: One.\nRachel: Two.")
    assert [i["voice_id"] for i in client.post.call_args.kwargs["json"]["inputs"]] == [GEORGE, RACHEL]


@pytest.mark.asyncio
async def test_a_voice_id_resolves_even_when_names_are_ambiguous():
    client, _ = await _run(_node(), f"{CLONE_2}: Mine.")
    assert client.post.call_args.kwargs["json"]["inputs"] == [{"text": "Mine.", "voice_id": CLONE_2}]


# 20 letters, no digit: the ID shape Nebula accepts doesn't require one.
DIGIT_FREE_ID = "AbCdEfGhIjKlMnOpQrSt"


@pytest.mark.asyncio
@pytest.mark.parametrize("label", ["ZZZZZZZZZZZZZZZZZZZ9", DIGIT_FREE_ID])
async def test_an_id_shaped_label_not_in_their_voices_passes_through(label):
    client, _ = await _run(_node(), f"{label}: Hi.\nRachel: Hello.")
    assert [i["voice_id"] for i in client.post.call_args.kwargs["json"]["inputs"]] == [label, RACHEL]


@pytest.mark.asyncio
async def test_a_label_that_is_both_a_name_and_id_shaped_resolves_as_the_name():
    voices = VOICES + [{"voice_id": "NamedLikeAnId0000001", "name": DIGIT_FREE_ID, "category": "cloned"}]
    client, _ = await _run(_node(), f"{DIGIT_FREE_ID}: Hi.", client=_mock_client(voices=voices))
    assert client.post.call_args.kwargs["json"]["inputs"] == [{"text": "Hi.", "voice_id": "NamedLikeAnId0000001"}]


@pytest.mark.asyncio
@pytest.mark.parametrize("label", ["ZZZZZZZZZZZZZZZZZZ9", "ZZZZZZZZZZZZZZZZZZZZ9", "ZZZZZZZZZZ ZZZZZZZZZ"])
async def test_a_label_off_the_id_shape_and_no_name_is_refused(label):
    _, message = await _refused(f"{label}: Hi.", match="isn't the name of any of your ElevenLabs voices")
    assert "exactly 20 letters and digits is used as a voice ID" in message


@pytest.mark.asyncio
async def test_no_match_lists_close_matches_with_ids():
    _, message = await _refused("Rach: Hi.\nGeorge: Hello.", match="'Rach' isn't the name")
    assert f"Rachel (premade): {RACHEL}" in message
    assert "write a voice ID in place of the name" in message
    assert "Nothing was generated" in message
    assert "George" not in message.split("Close matches")[0]  # only the failing speaker is reported


@pytest.mark.asyncio
async def test_no_match_falls_back_to_near_spellings_when_search_is_empty():
    _, message = await _refused("Gorge: Hi.", match="'Gorge' isn't the name")
    assert f"George (premade): {GEORGE}" in message


@pytest.mark.asyncio
@pytest.mark.parametrize("failure", ["status", "exception"])
async def test_a_failing_search_still_gives_the_main_error(failure):
    """The suggestion search is a courtesy: a 500 or a network error during it
    must not replace the 'isn't the name' error."""
    listing = _mock_client()

    async def get(url, headers=None, params=None, timeout=None):
        if params and params.get("search"):
            if failure == "exception":
                raise elevenlabs.httpx.ConnectTimeout("search timed out")
            return _response(500, {"detail": "boom"})
        return await listing.get(url, headers=headers, params=params, timeout=timeout)

    client = _mock_client()
    client.get = AsyncMock(side_effect=get)
    _, message = await _refused("Gorge: Hi.", client=client, match="'Gorge' isn't the name")
    assert f"George (premade): {GEORGE}" in message  # near spellings from the full list still offered
    assert any((c.kwargs.get("params") or {}).get("search") == "Gorge" for c in client.get.call_args_list)


@pytest.mark.asyncio
async def test_no_match_and_nothing_close():
    _, message = await _refused("Zebulon: Hi.", match="No similar names found")
    assert "voice ID in place of the name" in message


@pytest.mark.asyncio
async def test_an_ambiguous_name_lists_each_match_with_category_and_id():
    _, message = await _refused("Justin: Hi.", match="'Justin' matches 2 of your voices")
    assert f"Justin (cloned): {CLONE_1}" in message
    assert f"justin  (professional): {CLONE_2}" in message


@pytest.mark.asyncio
async def test_every_unresolved_speaker_is_reported_at_once():
    _, message = await _refused("Justin: Hi.\nNobody: Hello.\nRachel: Hey.")
    assert "'Justin' matches 2" in message and "'Nobody' isn't the name" in message


@pytest.mark.asyncio
async def test_pagination_follows_next_page_token_until_has_more_is_false():
    pages = {
        None: _voices_page(VOICES[:2], has_more=True, token="p2"),
        "p2": _voices_page(VOICES[2:4], has_more=True, token="p3"),
        "p3": _voices_page([{"voice_id": "LastPageVoice0000009", "name": "Late", "category": "cloned"}]),
    }
    client = _mock_client(pages=pages)
    client, _ = await _run(_node(), "Late: Last.\nRachel: First.", client=client)
    tokens = [c.kwargs["params"].get("next_page_token") for c in client.get.call_args_list]
    assert tokens == [None, "p2", "p3"]
    assert [i["voice_id"] for i in client.post.call_args.kwargs["json"]["inputs"]] == ["LastPageVoice0000009", RACHEL]


@pytest.mark.asyncio
async def test_pagination_stops_on_a_repeated_token():
    pages = {None: _voices_page(VOICES[:1], has_more=True, token="same"),
             "same": _voices_page(VOICES[1:2], has_more=True, token="same")}
    client, _ = await _run(_node(), "George: Hi.", client=_mock_client(pages=pages))
    assert client.get.await_count == 2


@pytest.mark.asyncio
async def test_pagination_stops_on_a_token_cycle():
    pages = {None: _voices_page(VOICES[:1], has_more=True, token="A"),
             "A": _voices_page(VOICES[1:2], has_more=True, token="B"),
             "B": _voices_page(VOICES[2:3], has_more=True, token="A")}
    client, _ = await _run(_node(), "George: Hi.", client=_mock_client(pages=pages))
    tokens = [c.kwargs["params"].get("next_page_token") for c in client.get.call_args_list]
    assert tokens == [None, "A", "B"]


@pytest.mark.asyncio
async def test_pagination_gives_up_at_the_page_limit(monkeypatch):
    monkeypatch.setattr(elevenlabs, "VOICES_MAX_PAGES", 3)

    class Endless(dict):
        def __missing__(self, token):
            n = 0 if token is None else int(token[1:])
            return _voices_page([], has_more=True, token=f"p{n + 1}")

    client = _mock_client(pages=Endless())
    with patch("handlers.elevenlabs.httpx.AsyncClient", return_value=client):
        with pytest.raises(RuntimeError, match="more than 300 voices.*voice IDs in the script"):
            await handle_elevenlabs_dialogue(
                _node(), {"script": PortValueDict(type="Text", value="Rachel: Hi.")}, {"ELEVENLABS_API_KEY": "k"})
    assert client.get.await_count == 3
    client.post.assert_not_called()


@pytest.mark.asyncio
async def test_permission_error_says_to_grant_voices_read_or_use_ids():
    client = _mock_client(get_status=403, get_payload={"detail": {
        "type": "authorization_error", "code": "insufficient_permissions",
        "message": "You do not have the required permissions for this action."}})
    _, message = await _refused("Rachel: Hi.", client=client, match="can't list your voices")
    assert "voices_read" in message and "voice's ID in place of its name" in message
    assert "required permissions" in message


@pytest.mark.asyncio
async def test_permission_error_still_runs_a_script_written_with_voice_ids():
    client = _mock_client(get_status=403)
    client, _ = await _run(_node(), f"{RACHEL}: One.\n{GEORGE}: Two.", client=client)
    assert [i["voice_id"] for i in client.post.call_args.kwargs["json"]["inputs"]] == [RACHEL, GEORGE]


@pytest.mark.asyncio
async def test_permission_error_passes_a_digit_free_id_through():
    client, _ = await _run(_node(), f"{DIGIT_FREE_ID}: One.\n{RACHEL}: Two.", client=_mock_client(get_status=403))
    assert [i["voice_id"] for i in client.post.call_args.kwargs["json"]["inputs"]] == [DIGIT_FREE_ID, RACHEL]


@pytest.mark.asyncio
@pytest.mark.parametrize("detail", [
    {"status": "missing_permissions", "message": "The API key you used is missing the permission voices_read."},
    {"status": "missing_permissions"},
    {"message": "This key lacks the voices_read permission."},
])
async def test_a_401_for_a_missing_permission_is_a_permission_problem(detail):
    client = _mock_client(get_status=401, get_payload={"detail": detail})
    _, message = await _refused("Rachel: Hi.", client=client, match="can't list your voices")
    assert "voices_read" in message
    client = _mock_client(get_status=401, get_payload={"detail": detail})
    client, _ = await _run(_node(), f"{RACHEL}: Hi.", client=client)
    assert client.post.call_args.kwargs["json"]["inputs"] == [{"text": "Hi.", "voice_id": RACHEL}]


@pytest.mark.asyncio
async def test_a_rejected_key_is_not_reported_as_a_permission_problem():
    client = _mock_client(get_status=401, get_payload={"detail": {"message": "Invalid API key"}})
    with patch("handlers.elevenlabs.httpx.AsyncClient", return_value=client):
        with pytest.raises(RuntimeError, match="rejected the API key.*Invalid API key"):
            await handle_elevenlabs_dialogue(
                _node(), {"script": PortValueDict(type="Text", value="Rachel: Hi.")}, {"ELEVENLABS_API_KEY": "k"})
    client.post.assert_not_called()


@pytest.mark.asyncio
async def test_a_failed_listing_stops_before_the_dialogue_call():
    client = _mock_client(get_status=500, get_payload={"detail": "boom"})
    with patch("handlers.elevenlabs.httpx.AsyncClient", return_value=client):
        with pytest.raises(RuntimeError, match="couldn't list your voices.*500"):
            await handle_elevenlabs_dialogue(
                _node(), {"script": PortValueDict(type="Text", value="Rachel: Hi.")}, {"ELEVENLABS_API_KEY": "k"})
    client.post.assert_not_called()


# -- definition, registration and key readiness -----------------------------------

def test_definition_matches_the_endpoint():
    assert DIALOGUE["apiProvider"] == "elevenlabs"
    assert DIALOGUE["apiEndpoint"] == "/v1/text-to-dialogue"
    assert DIALOGUE["executionPattern"] == "sync"
    params = {p["key"]: p for p in DIALOGUE["params"]}
    model = params["model_id"]
    assert model["default"] == "eleven_v4"
    assert [o["value"] for o in model["options"]] == ["eleven_v4", "eleven_v3"]
    assert set(params) == {"model_id", "stability", "similarity", "language_code", "output_format", "seed"}
    tts_formats = next(p for p in DEFINITIONS["elevenlabs-tts"]["params"] if p["key"] == "output_format")
    assert params["output_format"]["options"] == tts_formats["options"]
    assert [p["id"] for p in DIALOGUE["inputPorts"]] == ["script"]
    assert [p["id"] for p in DIALOGUE["outputPorts"]] == ["audio"]
    assert SYNC_HANDLERS["elevenlabs-dialogue"] is handle_elevenlabs_dialogue


def test_wording_tells_people_and_agents_to_write_voice_names():
    for text in (DIALOGUE["capabilityNote"], DIALOGUE["description"]):
        assert "Rachel: H" in text
        assert "ElevenLabs voice" in text
        assert "voice ID" in text
        assert "10" in text and "2,000" in text


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
