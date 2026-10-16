from __future__ import annotations

import asyncio
import json as _json
import re
from pathlib import Path
from typing import Any
from urllib.parse import quote
from uuid import uuid4

import httpx

from models.graph import GraphNode, PortValueDict
from services.file_access import require_allowed_path
from services.media_input import checked_local_file, read_local_media
from services.cancellation import schedule_detached_cancel
from services.output import get_run_dir
from execution.missing_credential import MissingCredentialError

ELEVENLABS_API_BASE = "https://api.elevenlabs.io/v1/text-to-speech"
DEFAULT_VOICE_ID = "21m00Tcm4TlvDq8ikWAM"  # Rachel

# The voice id is one URL path segment ("POST
# https://api.elevenlabs.io/v1/text-to-speech/{voice_id}", "ID of the voice to
# be used"; the same for /v1/speech-to-speech/{voice_id}). ElevenLabs' ids are
# letters and digits (21m00Tcm4TlvDq8ikWAM). A pasted value with "/", "..",
# "?" or "%" would send the request, on the person's key, to another endpoint
# ("../../music" resolves to /music), so anything else is refused before any
# call, and the id is still percent-quoted as one segment. The Krea and Runway copies routed here
# (execution/maker_routes_elevenlabs.py) take voice_id as free text.
_VOICE_ID = re.compile(r"[A-Za-z0-9]{1,64}")
# output_format is a query value "Formatted as codec_sample_rate_bitrate"
# (mp3_44100_128, pcm_16000, wav_44100, ulaw_8000; text-to-speech reference,
# read 2026-10-14). A saved recipe's value is not limited to the node's enum.
_OUTPUT_FORMAT = re.compile(r"[a-z0-9]+(?:_[a-z0-9]+){0,3}")
# Speech-to-speech: "Maximum segment length: 5 minutes" (voice-changer docs),
# no byte limit given, so this is Nebula's own bound on one file read into
# memory. Dubbing: "3 GB per source file via the API" (dubbing docs, read
# 2026-10-14); that file is streamed from disk, never read whole.
MAX_STS_AUDIO_BYTES = 250_000_000
MAX_DUBBING_FILE_BYTES = 3_000_000_000
# The dubbed track Nebula downloads: its own bound (the public fetcher's 1 GB, as for Krea media).
MAX_DUBBED_AUDIO_BYTES = 1_000_000_000


def _voice_id(node: GraphNode) -> str:
    """The voice id, checked and escaped as one URL path segment."""
    voice = str(node.params.get("voice_id") or DEFAULT_VOICE_ID).strip()
    if not _VOICE_ID.fullmatch(voice):
        raise ValueError(f"voice_id must be an ElevenLabs voice ID (letters and digits), received {voice!r}")
    return quote(voice, safe="")


def _with_output_format(url: str, output_format: Any) -> str:
    if not output_format:
        return url
    value = str(output_format)
    if not _OUTPUT_FORMAT.fullmatch(value):
        raise ValueError(f"output_format must be an ElevenLabs format like mp3_44100_128, received {value!r}")
    return f"{url}?output_format={quote(value, safe='')}"


async def handle_elevenlabs_tts(
    node: GraphNode,
    inputs: dict[str, PortValueDict],
    api_keys: dict[str, str],
    *,
    voice_settings: bool = True,
) -> dict[str, Any]:
    """POST /v1/text-to-speech/{voice_id}.

    ``voice_settings=False`` leaves the request's ``voice_settings`` out, so
    ElevenLabs uses the voice's stored settings (the API reference: voice
    settings "overriding stored settings for the given voice"). The Krea and
    Runway copies routed here (execution/maker_routes_elevenlabs.py) expose no
    voice settings, so they don't override the voice either."""
    text_input = inputs.get("text")
    if not text_input or not text_input.value:
        raise ValueError("Text input is required but was not provided")

    text = str(text_input.value)

    api_key = api_keys.get("ELEVENLABS_API_KEY")
    if not api_key:
        raise MissingCredentialError("ELEVENLABS_API_KEY is required")

    voice_id = _voice_id(node)
    model_id = node.params.get("model_id", "eleven_multilingual_v2")
    stability = float(node.params.get("stability", 0.5))
    similarity_boost = float(node.params.get("similarity_boost", 0.75))
    style = float(node.params.get("style", 0))
    use_speaker_boost = bool(node.params.get("use_speaker_boost", True))
    speed = float(node.params.get("speed", 1.0))
    output_format = node.params.get("output_format", "mp3_44100_128")

    settings: dict[str, Any] = {
        "stability": stability,
        "similarity_boost": similarity_boost,
        "use_speaker_boost": use_speaker_boost,
        "speed": speed,
    }
    if style > 0:
        settings["style"] = style

    body: dict[str, Any] = {"text": text, "model_id": model_id}
    if voice_settings:
        body["voice_settings"] = settings

    seed = node.params.get("seed")
    if seed is not None and seed != "":
        body["seed"] = int(seed)

    url = _with_output_format(f"{ELEVENLABS_API_BASE}/{voice_id}", output_format)

    async with httpx.AsyncClient(timeout=60.0) as client:
        response = await client.post(
            url,
            headers={
                "xi-api-key": api_key,
                "Content-Type": "application/json",
            },
            json=body,
        )
        if response.status_code != 200:
            error_detail = response.text
            raise RuntimeError(f"ElevenLabs API error {response.status_code}: {error_detail}")

    run_dir = get_run_dir()
    ext = _audio_extension(output_format)
    filename = f"{uuid4().hex[:12]}.{ext}"
    file_path = run_dir / filename
    file_path.write_bytes(response.content)

    return {
        "audio": {
            "type": "Audio",
            "value": str(file_path),
        }
    }


# ---------------------------------------------------------------------------
# Text to Dialogue (POST /v1/text-to-dialogue)
# ---------------------------------------------------------------------------
# Sources, all read 2026-10-16:
# - https://elevenlabs.io/docs/api-reference/text-to-dialogue/convert: body
#   ``inputs`` (list of {text, voice_id}, max 10 unique voice ids), ``model_id``
#   (default eleven_v3), ``language_code``, ``settings`` ({stability,
#   similarity}), ``seed`` (0 to 4294967295); ``output_format`` is a query
#   value. "For reliable generation, keep the total character count across all
#   inputs[].text values at or below 2,000 characters per request. Longer
#   requests can terminate early in streaming responses or return a validation
#   error."
# - https://elevenlabs.io/docs/overview/models: "Eleven v4 is available via the
#   Text to Dialogue API". The same page lists a 10,000 character limit for
#   eleven_v4; the endpoint's 2,000 figure is the one this node enforces.
ELEVENLABS_DIALOGUE_URL = "https://api.elevenlabs.io/v1/text-to-dialogue"
DIALOGUE_MODELS = ("eleven_v4", "eleven_v3")
DIALOGUE_DEFAULT_MODEL = "eleven_v4"
# The node's speaker slots: voice_1 .. voice_4 (node_definitions.json). The
# endpoint allows 10 unique voices; four keeps the card short.
DIALOGUE_SPEAKERS = 4
DIALOGUE_MAX_CHARS = 2000
DIALOGUE_SEED_MAX = 4_294_967_295
# A turn: "1: text" or "Speaker 1: text" (any case, spaces around the colon).
_DIALOGUE_LINE = re.compile(r"\s*(?:speaker\s*)?(\d+)\s*:\s*(.*)", re.IGNORECASE | re.DOTALL)
# ISO 639-1, or ISO 639-3 for ast, yue, ceb, fil (models page, Eleven v4).
_LANGUAGE_CODE = re.compile(r"[a-z]{2,3}")


def _checked_voice(value: Any, param: str) -> str:
    voice = str(value).strip()
    if not _VOICE_ID.fullmatch(voice):
        raise ValueError(f"{param} must be an ElevenLabs voice ID (letters and digits), received {voice!r}")
    return voice


def parse_dialogue_script(script: str, voices: dict[int, str]) -> list[dict[str, str]]:
    """Turn a script into Text to Dialogue ``inputs``.

    One turn per non-empty line, each starting with a speaker label: ``1:``
    (or ``Speaker 1:``) up to ``4:``. ``voices`` maps a speaker number to the
    voice id set on the card. Raises ValueError, before any call, for a line
    without a label, a label past the card's speakers, a speaker with no voice,
    an empty turn, or a script over the endpoint's 2,000-character guidance.
    """
    turns: list[dict[str, str]] = []
    for number, raw in enumerate(str(script).splitlines(), start=1):
        if not raw.strip():
            continue
        match = _DIALOGUE_LINE.fullmatch(raw)
        if not match:
            raise ValueError(
                f"Dialogue line {number} has no speaker label. Start each line with 1: to "
                f"{DIALOGUE_SPEAKERS}: (or Speaker 1:), e.g. '1: Hello there.' Received {raw.strip()[:60]!r}"
            )
        speaker = int(match.group(1))
        text = match.group(2).strip()
        if not 1 <= speaker <= DIALOGUE_SPEAKERS:
            raise ValueError(
                f"Dialogue line {number} uses unknown speaker label {match.group(1)!r}. "
                f"This node has speakers 1 to {DIALOGUE_SPEAKERS}."
            )
        voice = voices.get(speaker)
        if not voice:
            raise ValueError(
                f"Dialogue line {number} is spoken by speaker {speaker}, but Speaker {speaker} Voice ID is empty."
            )
        if not text:
            raise ValueError(f"Dialogue line {number} (speaker {speaker}) has no text after the label.")
        turns.append({"text": text, "voice_id": voice})
    if not turns:
        raise ValueError("The dialogue script is empty. Write one line per turn, e.g. '1: Hello.' then '2: Hi!'")
    total = sum(len(turn["text"]) for turn in turns)
    if total > DIALOGUE_MAX_CHARS:
        raise ValueError(
            f"The dialogue is {total:,} characters. ElevenLabs asks for at most {DIALOGUE_MAX_CHARS:,} "
            "characters per Text to Dialogue request for reliable generation (longer ones can stop early "
            "or be refused). Split the script across two nodes."
        )
    return turns


def build_dialogue_request(node: GraphNode, script: str) -> tuple[str, dict[str, Any]]:
    """The URL and JSON body for one Text to Dialogue call (no network)."""
    voices: dict[int, str] = {}
    for speaker in range(1, DIALOGUE_SPEAKERS + 1):
        key = f"voice_{speaker}"
        value = node.params.get(key)
        if value is None or str(value).strip() == "":
            if speaker != 1:
                continue
            value = DEFAULT_VOICE_ID  # Speaker 1 falls back to Rachel, as elevenlabs-tts does
        voices[speaker] = _checked_voice(value, key)
    turns = parse_dialogue_script(script, voices)

    model_id = str(node.params.get("model_id") or DIALOGUE_DEFAULT_MODEL)
    if model_id not in DIALOGUE_MODELS:
        raise ValueError(f"model_id must be one of {', '.join(DIALOGUE_MODELS)}, received {model_id!r}")

    # Always send model_id: the endpoint's own default is eleven_v3.
    body: dict[str, Any] = {
        "inputs": turns,
        "model_id": model_id,
        "settings": {
            "stability": float(node.params.get("stability", 0.5)),
            "similarity": float(node.params.get("similarity", 0.75)),
        },
    }

    language = node.params.get("language_code")
    if language is not None and str(language).strip():
        code = str(language).strip().lower()
        if not _LANGUAGE_CODE.fullmatch(code):
            raise ValueError(f"language_code must be an ISO 639-1 code like en or es, received {language!r}")
        body["language_code"] = code

    seed = node.params.get("seed")
    if seed is not None and seed != "":
        value = int(seed)
        if not 0 <= value <= DIALOGUE_SEED_MAX:
            raise ValueError(f"seed must be between 0 and {DIALOGUE_SEED_MAX}, received {value}")
        body["seed"] = value

    output_format = node.params.get("output_format", "mp3_44100_128")
    return _with_output_format(ELEVENLABS_DIALOGUE_URL, output_format), body


async def handle_elevenlabs_dialogue(
    node: GraphNode,
    inputs: dict[str, PortValueDict],
    api_keys: dict[str, str],
) -> dict[str, Any]:
    """POST /v1/text-to-dialogue: a multi-speaker script in one audio file."""
    script_input = inputs.get("script")
    if not script_input or not script_input.value:
        raise ValueError("Script input is required but was not provided")

    api_key = api_keys.get("ELEVENLABS_API_KEY")
    if not api_key:
        raise MissingCredentialError("ELEVENLABS_API_KEY is required")

    url, body = build_dialogue_request(node, str(script_input.value))
    output_format = node.params.get("output_format", "mp3_44100_128")

    async with httpx.AsyncClient(timeout=180.0) as client:
        response = await client.post(
            url,
            headers={"xi-api-key": api_key, "Content-Type": "application/json"},
            json=body,
        )
        if response.status_code != 200:
            raise RuntimeError(f"ElevenLabs Text to Dialogue error {response.status_code}: {response.text}")

    return {"audio": {"type": "Audio", "value": _save_audio(response.content, output_format)}}


def _audio_extension(output_format: str) -> str:
    """Map an ElevenLabs output_format value to the file extension that matches the bytes.

    ElevenLabs returns RAW PCM bytes for pcm_* formats (no WAV header). Saving them as
    .wav produces a broken file. The extension must match the actual content so
    downstream consumers (which often infer MIME from extension) handle the bytes
    correctly.
    """
    if "mp3" in output_format:
        return "mp3"
    if "pcm" in output_format:
        return "pcm"
    if "wav" in output_format:
        return "wav"
    return "mp3"


def _save_audio(content: bytes, output_format: str = "mp3_44100_128") -> str:
    """Save audio bytes to a file and return the path."""
    run_dir = get_run_dir()
    ext = _audio_extension(output_format)
    filename = f"{uuid4().hex[:12]}.{ext}"
    file_path = run_dir / filename
    file_path.write_bytes(content)
    return str(file_path)


async def _cancel_dubbing(dubbing_id: str, api_key: str) -> None:
    """Best-effort cancellation/deletion of an in-progress dubbing project."""
    try:
        async with httpx.AsyncClient(timeout=15.0) as client:
            await client.delete(
                f"https://api.elevenlabs.io/v1/dubbing/{quote(str(dubbing_id), safe='')}",
                headers={"xi-api-key": api_key},
            )
    except Exception:
        pass


async def _poll_dubbing(
    client: httpx.AsyncClient,
    dubbing_id: str,
    target_lang: str,
    api_key: str,
) -> dict[str, Any]:
    """Poll and download one submitted dubbing job."""
    poll_errors = 0
    for _ in range(120):
        await asyncio.sleep(5)
        status_resp = await client.get(
            f"https://api.elevenlabs.io/v1/dubbing/{quote(str(dubbing_id), safe='')}",
            headers={"xi-api-key": api_key},
        )
        if status_resp.status_code != 200:
            poll_errors += 1
            if poll_errors >= 5:
                raise RuntimeError(
                    f"ElevenLabs Dubbing poll failed {poll_errors} times: "
                    f"{status_resp.status_code} {status_resp.text}"
                )
            continue
        # Reset on successful response; threshold of 5 requires CONSECUTIVE failures.
        poll_errors = 0
        status_data = status_resp.json()
        if status_data.get("status") == "dubbed":
            dl_resp = await client.get(
                f"https://api.elevenlabs.io/v1/dubbing/{quote(str(dubbing_id), safe='')}"
                f"/audio/{quote(str(target_lang), safe='')}",
                headers={"xi-api-key": api_key},
            )
            location = dl_resp.headers.get("location") if dl_resp.status_code in (301, 302, 303, 307, 308) else None
            if location:
                target = dl_resp.url.join(location)
                if target.scheme == "https" and target.host == "api.elevenlabs.io":
                    dl_resp = await client.get(target, headers={"xi-api-key": api_key})
                else:
                    # httpx keeps custom headers such as xi-api-key on a
                    # redirect to another host, so a file elsewhere is fetched
                    # without the key, and only from a public https host.
                    from services.public_url import fetch_public_media

                    content, _type = await fetch_public_media(
                        str(target), label="ElevenLabs dubbing audio", max_bytes=MAX_DUBBED_AUDIO_BYTES)
                    return {"audio": {"type": "Audio", "value": _save_audio(content, "mp3_44100_128")}}
            if dl_resp.status_code == 200:
                file_path = _save_audio(dl_resp.content, "mp3_44100_128")
                return {"audio": {"type": "Audio", "value": file_path}}
            raise RuntimeError(
                f"ElevenLabs Dubbing download failed: {dl_resp.status_code}"
            )
        if status_data.get("status") == "failed":
            raise RuntimeError(
                f"ElevenLabs Dubbing failed: {status_data.get('error', 'Unknown')}"
            )

    raise RuntimeError("ElevenLabs Dubbing timed out")


async def handle_elevenlabs_sfx(
    node: GraphNode,
    inputs: dict[str, PortValueDict],
    api_keys: dict[str, str],
) -> dict[str, Any]:
    text_input = inputs.get("text")
    if not text_input or not text_input.value:
        raise ValueError("Text input is required for sound effects")

    api_key = api_keys.get("ELEVENLABS_API_KEY")
    if not api_key:
        raise MissingCredentialError("ELEVENLABS_API_KEY is required")

    output_format = node.params.get("output_format", "mp3_44100_128")

    body: dict[str, Any] = {
        "text": str(text_input.value),
        "model_id": node.params.get("model_id", "eleven_text_to_sound_v2"),
    }

    duration = node.params.get("duration_seconds")
    if duration is not None and duration != "":
        body["duration_seconds"] = float(duration)

    prompt_influence = node.params.get("prompt_influence")
    if prompt_influence is not None and prompt_influence != "":
        body["prompt_influence"] = float(prompt_influence)

    loop = node.params.get("loop")
    if loop:
        body["loop"] = True

    url = _with_output_format("https://api.elevenlabs.io/v1/sound-generation", output_format)

    async with httpx.AsyncClient(timeout=120.0) as client:
        response = await client.post(
            url,
            headers={"xi-api-key": api_key, "Content-Type": "application/json"},
            json=body,
        )
        if response.status_code != 200:
            raise RuntimeError(f"ElevenLabs SFX error {response.status_code}: {response.text}")

    file_path = _save_audio(response.content, output_format)
    return {"audio": {"type": "Audio", "value": file_path}}


async def handle_elevenlabs_sts(
    node: GraphNode,
    inputs: dict[str, PortValueDict],
    api_keys: dict[str, str],
) -> dict[str, Any]:
    audio_input = inputs.get("audio")
    if not audio_input or not audio_input.value:
        raise ValueError("Audio input is required for speech-to-speech")

    api_key = api_keys.get("ELEVENLABS_API_KEY")
    if not api_key:
        raise MissingCredentialError("ELEVENLABS_API_KEY is required")

    voice_id = _voice_id(node)
    output_format = node.params.get("output_format", "mp3_44100_128")

    url = _with_output_format(f"https://api.elevenlabs.io/v1/speech-to-speech/{voice_id}", output_format)

    # Read audio file
    audio_path = Path(str(audio_input.value))
    if not audio_path.exists():
        raise ValueError(f"Audio file not found: {audio_path}")
    _checked, audio_bytes = read_local_media(audio_path, label="Speech-to-speech audio", max_bytes=MAX_STS_AUDIO_BYTES)

    # STS uses multipart/form-data
    files = {"audio": (audio_path.name, audio_bytes, "audio/mpeg")}
    data: dict[str, str] = {
        "model_id": node.params.get("model_id", "eleven_english_sts_v2"),
    }

    remove_noise = node.params.get("remove_background_noise")
    if remove_noise:
        data["remove_background_noise"] = "true"

    # voice_settings must be sent as a JSON-encoded string in the multipart form
    stability = node.params.get("stability")
    similarity_boost = node.params.get("similarity_boost")
    if stability is not None or similarity_boost is not None:
        vs: dict[str, Any] = {}
        if stability is not None:
            vs["stability"] = float(stability)
        if similarity_boost is not None:
            vs["similarity_boost"] = float(similarity_boost)
        style = node.params.get("style")
        if style is not None and float(style) > 0:
            vs["style"] = float(style)
        use_speaker_boost = node.params.get("use_speaker_boost")
        if use_speaker_boost is not None:
            vs["use_speaker_boost"] = bool(use_speaker_boost)
        data["voice_settings"] = _json.dumps(vs)

    seed = node.params.get("seed")
    if seed is not None and seed != "":
        data["seed"] = str(int(seed))

    async with httpx.AsyncClient(timeout=120.0) as client:
        response = await client.post(
            url,
            headers={"xi-api-key": api_key},
            files=files,
            data=data,
        )
        if response.status_code != 200:
            raise RuntimeError(f"ElevenLabs STS error {response.status_code}: {response.text}")

    file_path = _save_audio(response.content, output_format)
    return {"audio": {"type": "Audio", "value": file_path}}


async def handle_elevenlabs_isolation(
    node: GraphNode,
    inputs: dict[str, PortValueDict],
    api_keys: dict[str, str],
) -> dict[str, Any]:
    audio_input = inputs.get("audio")
    if not audio_input or not audio_input.value:
        raise ValueError("Audio input is required for audio isolation")

    api_key = api_keys.get("ELEVENLABS_API_KEY")
    if not api_key:
        raise MissingCredentialError("ELEVENLABS_API_KEY is required")

    audio_path = Path(str(audio_input.value))
    if not audio_path.exists():
        raise ValueError(f"Audio file not found: {audio_path}")
    audio_bytes = require_allowed_path(audio_path).read_bytes()

    files = {"audio": (audio_path.name, audio_bytes, "audio/mpeg")}

    async with httpx.AsyncClient(timeout=120.0) as client:
        response = await client.post(
            "https://api.elevenlabs.io/v1/audio-isolation",
            headers={"xi-api-key": api_key},
            files=files,
        )
        if response.status_code != 200:
            raise RuntimeError(f"ElevenLabs Isolation error {response.status_code}: {response.text}")

    file_path = _save_audio(response.content, "mp3_44100_128")
    return {"audio": {"type": "Audio", "value": file_path}}


async def handle_elevenlabs_dubbing(
    node: GraphNode,
    inputs: dict[str, PortValueDict],
    api_keys: dict[str, str],
    emit=None,
) -> dict[str, Any]:
    audio_input = inputs.get("audio")
    if not audio_input or not audio_input.value:
        raise ValueError("Audio input is required for dubbing")

    api_key = api_keys.get("ELEVENLABS_API_KEY")
    if not api_key:
        raise MissingCredentialError("ELEVENLABS_API_KEY is required")

    target_lang = node.params.get("target_lang", "es")

    audio_path = Path(str(audio_input.value))
    if not audio_path.exists():
        raise ValueError(f"Audio file not found: {audio_path}")
    checked = checked_local_file(audio_path, label="Dubbing audio", max_bytes=MAX_DUBBING_FILE_BYTES)

    data: dict[str, str] = {
        "target_lang": target_lang,
    }

    source_lang = node.params.get("source_lang")
    if source_lang and source_lang != "auto":
        data["source_lang"] = source_lang

    num_speakers = node.params.get("num_speakers")
    if num_speakers is not None and num_speakers != "" and int(num_speakers) > 0:
        data["num_speakers"] = str(int(num_speakers))

    drop_bg = node.params.get("drop_background_audio")
    if drop_bg:
        data["drop_background_audio"] = "true"

    disable_cloning = node.params.get("disable_voice_cloning")
    if disable_cloning:
        data["disable_voice_cloning"] = "true"

    async with httpx.AsyncClient(timeout=300.0) as client:
        # Step 1: Submit dubbing job (the file streams from disk)
        with checked.open("rb") as handle:
            resp = await client.post(
                "https://api.elevenlabs.io/v1/dubbing",
                headers={"xi-api-key": api_key},
                files={"file": (audio_path.name, handle, "audio/mpeg")},
                data=data,
            )
        if resp.status_code != 200:
            raise RuntimeError(f"ElevenLabs Dubbing submit error {resp.status_code}: {resp.text}")

        dub_data = resp.json()
        dubbing_id = dub_data.get("dubbing_id")
        if not dubbing_id:
            raise RuntimeError(f"ElevenLabs Dubbing returned no ID: {dub_data}")

        try:
            return await _poll_dubbing(client, dubbing_id, target_lang, api_key)
        except asyncio.CancelledError:
            schedule_detached_cancel(lambda: _cancel_dubbing(dubbing_id, api_key))
            raise


async def handle_elevenlabs_stt(
    node: GraphNode,
    inputs: dict[str, PortValueDict],
    api_keys: dict[str, str],
) -> dict[str, Any]:
    """Transcribe audio to text via ElevenLabs Scribe (POST /v1/speech-to-text).

    Returns plain transcript text by default. When ``transcript_format`` is
    "srt" or "vtt", requests that subtitle format via ``additional_formats`` and
    returns the generated subtitle content instead of the plain transcript.
    """
    audio_input = inputs.get("audio")
    if not audio_input or not audio_input.value:
        raise ValueError("Audio input is required for transcription")

    api_key = api_keys.get("ELEVENLABS_API_KEY")
    if not api_key:
        raise MissingCredentialError("ELEVENLABS_API_KEY is required")

    audio_path = Path(str(audio_input.value))
    if not audio_path.exists():
        raise ValueError(f"Audio file not found: {audio_path}")

    model_id = node.params.get("model_id", "scribe_v1") or "scribe_v1"

    files = {"file": (audio_path.name, require_allowed_path(audio_path).read_bytes(), "audio/mpeg")}
    data: dict[str, str] = {"model_id": model_id}

    language_code = node.params.get("language_code")
    if language_code and language_code != "auto":
        data["language_code"] = str(language_code)

    if node.params.get("diarize"):
        data["diarize"] = "true"

    num_speakers = node.params.get("num_speakers")
    if num_speakers is not None and num_speakers != "" and int(num_speakers) > 0:
        data["num_speakers"] = str(int(num_speakers))

    # tag_audio_events defaults to true on the API — only send it to disable.
    if node.params.get("tag_audio_events", True) is False:
        data["tag_audio_events"] = "false"

    transcript_format = node.params.get("transcript_format", "text")
    if transcript_format in ("srt", "vtt"):
        # Multipart form fields must be strings; JSON-encode the array.
        data["additional_formats"] = _json.dumps([{"format": transcript_format}])
        # ElevenLabs rejects additional_formats (HTTP 400 invalid_parameters)
        # unless diarization AND timestamps are enabled, so force both on here.
        data["diarize"] = "true"
        data["timestamps_granularity"] = "word"

    async with httpx.AsyncClient(timeout=120.0) as client:
        response = await client.post(
            "https://api.elevenlabs.io/v1/speech-to-text",
            headers={"xi-api-key": api_key},
            files=files,
            data=data,
        )
        if response.status_code != 200:
            raise RuntimeError(f"ElevenLabs STT error {response.status_code}: {response.text}")

    result_data = response.json()
    text = result_data.get("text", "")

    if transcript_format in ("srt", "vtt"):
        for fmt in result_data.get("additional_formats") or []:
            if transcript_format in (fmt.get("requested_format"), fmt.get("format")):
                content = fmt.get("content")
                if content:
                    text = content
                    break

    return {"text": {"type": "Text", "value": text}}


ELEVENLABS_MUSIC_URL = "https://api.elevenlabs.io/v1/music"
# POST /v1/music (https://elevenlabs.io/docs/api-reference/music/compose,
# checked 2026-10-14): "`model_id` ... default: music_v1 ... Allowed values:
# `music_v1`, `music_v2`, `music_v2_5`"; `music_length_ms` "between 3000ms and
# 600000ms" and only with `prompt`; output_format "auto" (the default when
# omitted) gives mp3_44100_128 on v1 and mp3_48000_192 on v2, so the saved
# file is always mp3.
MUSIC_MODELS = ("music_v1", "music_v2", "music_v2_5")
MUSIC_LENGTH_MS = (3000, 600000)


async def handle_elevenlabs_music(
    node: GraphNode,
    inputs: dict[str, PortValueDict],
    api_keys: dict[str, str],
) -> dict[str, Any]:
    """Compose a track with ElevenLabs Music from a text prompt.

    Params: ``model_id`` (music_v1 / music_v2 / music_v2_5, default
    music_v1), ``music_length_ms`` (3000-600000; omitted lets the model pick
    the length) and ``force_instrumental``."""
    prompt_input = inputs.get("prompt")
    if not prompt_input or prompt_input.value in (None, ""):
        raise ValueError("Prompt input is required for ElevenLabs Music")

    api_key = api_keys.get("ELEVENLABS_API_KEY")
    if not api_key or not str(api_key).strip():
        raise MissingCredentialError("ELEVENLABS_API_KEY is required")

    model_id = node.params.get("model_id") or "music_v1"
    if model_id not in MUSIC_MODELS:
        raise ValueError(f"ElevenLabs Music model_id must be one of {', '.join(MUSIC_MODELS)} (received {model_id!r})")
    body: dict[str, Any] = {"prompt": str(prompt_input.value), "model_id": model_id}

    length = node.params.get("music_length_ms")
    if length is not None and length != "":
        if isinstance(length, bool):
            raise ValueError("music_length_ms must be a whole number of milliseconds")
        try:
            length_ms = int(length)
        except (TypeError, ValueError) as exc:
            raise ValueError("music_length_ms must be a whole number of milliseconds") from exc
        low, high = MUSIC_LENGTH_MS
        if not low <= length_ms <= high:
            raise ValueError(f"music_length_ms must be between {low} and {high} (received {length_ms})")
        body["music_length_ms"] = length_ms

    if node.params.get("force_instrumental"):
        body["force_instrumental"] = True

    # A long track takes a while to compose; the response is the audio file.
    timeout = httpx.Timeout(connect=30.0, read=600.0, write=60.0, pool=30.0)
    async with httpx.AsyncClient(timeout=timeout) as client:
        response = await client.post(
            ELEVENLABS_MUSIC_URL,
            headers={"xi-api-key": api_key, "Content-Type": "application/json"},
            json=body,
        )
        if response.status_code != 200:
            raise RuntimeError(f"ElevenLabs Music error {response.status_code}: {response.text}")

    file_path = _save_audio(response.content, "mp3_44100_128")
    return {"audio": {"type": "Audio", "value": file_path}}
