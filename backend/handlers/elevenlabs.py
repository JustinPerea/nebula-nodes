from __future__ import annotations

from pathlib import Path
from typing import Any
from uuid import uuid4

import base64
import httpx

from models.graph import GraphNode, PortValueDict
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
    speed = float(node.params.get("speed", 1.0))
    output_format = node.params.get("output_format", "mp3_44100_128")

    voice_settings: dict[str, Any] = {
        "stability": stability,
        "similarity_boost": similarity_boost,
    }
    if style > 0:
        voice_settings["style"] = style

    body: dict[str, Any] = {
        "text": text,
        "model_id": model_id,
        "voice_settings": voice_settings,
    }

    if speed != 1.0:
        body["speed"] = speed

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
    ext = "mp3" if "mp3" in output_format else "wav" if "pcm" in output_format else "mp3"
    filename = f"{uuid4().hex[:12]}.{ext}"
    file_path = run_dir / filename
    file_path.write_bytes(response.content)

    return {
        "audio": {
            "type": "Audio",
            "value": str(file_path),
        }
    }


def _save_audio(content: bytes, output_format: str = "mp3_44100_128") -> str:
    """Save audio bytes to a file and return the path."""
    run_dir = get_run_dir()
    ext = "mp3" if "mp3" in output_format else "wav" if "pcm" in output_format or "wav" in output_format else "mp3"
    filename = f"{uuid4().hex[:12]}.{ext}"
    file_path = run_dir / filename
    file_path.write_bytes(content)
    return str(file_path)


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

        # Step 2: Poll for completion
        import asyncio
        for _ in range(120):
            await asyncio.sleep(5)
            status_resp = await client.get(
                f"https://api.elevenlabs.io/v1/dubbing/{dubbing_id}",
                headers={"xi-api-key": api_key},
            )
            if status_resp.status_code != 200:
                continue
            status_data = status_resp.json()
            if status_data.get("status") == "dubbed":
                # Step 3: Download dubbed audio
                dl_resp = await client.get(
                    f"https://api.elevenlabs.io/v1/dubbing/{dubbing_id}/audio/{target_lang}",
                    headers={"xi-api-key": api_key},
                    follow_redirects=True,
                )
                if dl_resp.status_code == 200:
                    file_path = _save_audio(dl_resp.content, "mp3_44100_128")
                    return {"audio": {"type": "Audio", "value": file_path}}
                raise RuntimeError(f"ElevenLabs Dubbing download failed: {dl_resp.status_code}")
            elif status_data.get("status") == "failed":
                raise RuntimeError(f"ElevenLabs Dubbing failed: {status_data.get('error', 'Unknown')}")

        raise RuntimeError("ElevenLabs Dubbing timed out")
