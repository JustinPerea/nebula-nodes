from __future__ import annotations

import asyncio
import json as _json
from pathlib import Path
from typing import Any
from uuid import uuid4

import httpx

from models.graph import GraphNode, PortValueDict
from services.cancellation import schedule_detached_cancel
from services.output import get_run_dir

ELEVENLABS_API_BASE = "https://api.elevenlabs.io/v1/text-to-speech"
DEFAULT_VOICE_ID = "21m00Tcm4TlvDq8ikWAM"  # Rachel


async def handle_elevenlabs_tts(
    node: GraphNode,
    inputs: dict[str, PortValueDict],
    api_keys: dict[str, str],
) -> dict[str, Any]:
    text_input = inputs.get("text")
    if not text_input or not text_input.value:
        raise ValueError("Text input is required but was not provided")

    text = str(text_input.value)

    api_key = api_keys.get("ELEVENLABS_API_KEY")
    if not api_key:
        raise ValueError("ELEVENLABS_API_KEY is required")

    voice_id = node.params.get("voice_id", DEFAULT_VOICE_ID) or DEFAULT_VOICE_ID
    model_id = node.params.get("model_id", "eleven_multilingual_v2")
    stability = float(node.params.get("stability", 0.5))
    similarity_boost = float(node.params.get("similarity_boost", 0.75))
    style = float(node.params.get("style", 0))
    use_speaker_boost = bool(node.params.get("use_speaker_boost", True))
    speed = float(node.params.get("speed", 1.0))
    output_format = node.params.get("output_format", "mp3_44100_128")

    voice_settings: dict[str, Any] = {
        "stability": stability,
        "similarity_boost": similarity_boost,
        "use_speaker_boost": use_speaker_boost,
        "speed": speed,
    }
    if style > 0:
        voice_settings["style"] = style

    body: dict[str, Any] = {
        "text": text,
        "model_id": model_id,
        "voice_settings": voice_settings,
    }

    seed = node.params.get("seed")
    if seed is not None and seed != "":
        body["seed"] = int(seed)

    url = f"{ELEVENLABS_API_BASE}/{voice_id}"

    # Append output_format as query param
    if output_format:
        url += f"?output_format={output_format}"

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
                f"https://api.elevenlabs.io/v1/dubbing/{dubbing_id}",
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
            f"https://api.elevenlabs.io/v1/dubbing/{dubbing_id}",
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
                f"https://api.elevenlabs.io/v1/dubbing/{dubbing_id}/audio/{target_lang}",
                headers={"xi-api-key": api_key},
                follow_redirects=True,
            )
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
        raise ValueError("ELEVENLABS_API_KEY is required")

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

    url = f"https://api.elevenlabs.io/v1/sound-generation"
    if output_format:
        url += f"?output_format={output_format}"

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
        raise ValueError("ELEVENLABS_API_KEY is required")

    voice_id = node.params.get("voice_id", DEFAULT_VOICE_ID) or DEFAULT_VOICE_ID
    output_format = node.params.get("output_format", "mp3_44100_128")

    # Read audio file
    audio_path = Path(str(audio_input.value))
    if not audio_path.exists():
        raise ValueError(f"Audio file not found: {audio_path}")
    audio_bytes = audio_path.read_bytes()

    url = f"https://api.elevenlabs.io/v1/speech-to-speech/{voice_id}"
    if output_format:
        url += f"?output_format={output_format}"

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
        raise ValueError("ELEVENLABS_API_KEY is required")

    audio_path = Path(str(audio_input.value))
    if not audio_path.exists():
        raise ValueError(f"Audio file not found: {audio_path}")
    audio_bytes = audio_path.read_bytes()

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
        raise ValueError("ELEVENLABS_API_KEY is required")

    target_lang = node.params.get("target_lang", "es")

    audio_path = Path(str(audio_input.value))
    if not audio_path.exists():
        raise ValueError(f"Audio file not found: {audio_path}")
    audio_bytes = audio_path.read_bytes()

    files = {"file": (audio_path.name, audio_bytes, "audio/mpeg")}
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
        # Step 1: Submit dubbing job
        resp = await client.post(
            "https://api.elevenlabs.io/v1/dubbing",
            headers={"xi-api-key": api_key},
            files=files,
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
        raise ValueError("ELEVENLABS_API_KEY is required")

    audio_path = Path(str(audio_input.value))
    if not audio_path.exists():
        raise ValueError(f"Audio file not found: {audio_path}")

    model_id = node.params.get("model_id", "scribe_v1") or "scribe_v1"

    files = {"file": (audio_path.name, audio_path.read_bytes(), "audio/mpeg")}
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
