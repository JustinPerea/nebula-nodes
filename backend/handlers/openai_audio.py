from __future__ import annotations

from pathlib import Path
from typing import Any
from uuid import uuid4

import httpx

from models.graph import GraphNode, PortValueDict
from services.output import get_run_dir

OPENAI_AUDIO_BASE = "https://api.openai.com/v1/audio"

# All formats the TTS endpoint can return. Used to derive the saved file
# extension. Anything outside this set falls back to "mp3" defensively.
_TTS_VALID_FORMATS = {"mp3", "opus", "aac", "flac", "wav", "pcm"}


async def handle_openai_stt(
    node: GraphNode,
    inputs: dict[str, PortValueDict],
    api_keys: dict[str, str],
) -> dict[str, Any]:
    audio_input = inputs.get("audio")
    if not audio_input or not audio_input.value:
        raise ValueError("Audio input is required for transcription")

    api_key = api_keys.get("OPENAI_API_KEY")
    if not api_key:
        raise ValueError("OPENAI_API_KEY is required")

    audio_path = Path(str(audio_input.value))
    if not audio_path.exists():
        raise ValueError(f"Audio file not found: {audio_path}")

    model = node.params.get("model", "whisper-1")
    response_format = node.params.get("response_format", "text")

    files = {"file": (audio_path.name, audio_path.read_bytes(), "audio/mpeg")}
    data: dict[str, str] = {"model": model}

    if response_format:
        data["response_format"] = response_format

    language = node.params.get("language")
    if language and language != "auto":
        data["language"] = language

    prompt = node.params.get("prompt")
    if prompt:
        data["prompt"] = str(prompt)

    # temperature is respected by whisper-1; gpt-4o-* models silently ignore it
    temperature = node.params.get("temperature")
    if temperature is not None and temperature != "":
        data["temperature"] = str(float(temperature))

    async with httpx.AsyncClient(timeout=120.0) as client:
        response = await client.post(
            f"{OPENAI_AUDIO_BASE}/transcriptions",
            headers={"Authorization": f"Bearer {api_key}"},
            files=files,
            data=data,
        )
        if response.status_code != 200:
            raise RuntimeError(f"OpenAI STT error {response.status_code}: {response.text}")

    # Response structure depends on format
    if response_format in ("json", "verbose_json"):
        result_data = response.json()
        text = result_data.get("text", "")
    else:
        text = response.text

    return {"text": {"type": "Text", "value": text}}


async def handle_openai_translate(
    node: GraphNode,
    inputs: dict[str, PortValueDict],
    api_keys: dict[str, str],
) -> dict[str, Any]:
    audio_input = inputs.get("audio")
    if not audio_input or not audio_input.value:
        raise ValueError("Audio input is required for translation")

    api_key = api_keys.get("OPENAI_API_KEY")
    if not api_key:
        raise ValueError("OPENAI_API_KEY is required")

    audio_path = Path(str(audio_input.value))
    if not audio_path.exists():
        raise ValueError(f"Audio file not found: {audio_path}")

    files = {"file": (audio_path.name, audio_path.read_bytes(), "audio/mpeg")}
    # Only whisper-1 supports the translation endpoint; model is fixed.
    data: dict[str, str] = {"model": "whisper-1"}

    response_format = node.params.get("response_format", "text")
    if response_format:
        data["response_format"] = response_format

    prompt = node.params.get("prompt")
    if prompt:
        data["prompt"] = str(prompt)

    temperature = node.params.get("temperature")
    if temperature is not None and temperature != "":
        data["temperature"] = str(float(temperature))

    async with httpx.AsyncClient(timeout=120.0) as client:
        response = await client.post(
            f"{OPENAI_AUDIO_BASE}/translations",
            headers={"Authorization": f"Bearer {api_key}"},
            files=files,
            data=data,
        )
        if response.status_code != 200:
            raise RuntimeError(f"OpenAI Translate error {response.status_code}: {response.text}")

    if response_format in ("json", "verbose_json"):
        result_data = response.json()
        text = result_data.get("text", "")
    else:
        text = response.text

    return {"text": {"type": "Text", "value": text}}


async def handle_openai_tts(
    node: GraphNode,
    inputs: dict[str, PortValueDict],
    api_keys: dict[str, str],
) -> dict[str, Any]:
    text_input = inputs.get("text")
    if not text_input or not text_input.value:
        raise ValueError("Text input is required for TTS")

    api_key = api_keys.get("OPENAI_API_KEY")
    if not api_key:
        raise ValueError("OPENAI_API_KEY is required")

    model = node.params.get("model", "tts-1")
    voice = node.params.get("voice", "alloy")
    speed = float(node.params.get("speed", 1.0))
    response_format = node.params.get("response_format", "mp3")

    body: dict[str, Any] = {
        "model": model,
        "input": str(text_input.value),
        "voice": voice,
        "speed": speed,
        "response_format": response_format,
    }

    # instructions is only supported by gpt-4o-mini-tts; tts-1/tts-1-hd ignore it
    instructions = node.params.get("instructions")
    if instructions:
        body["instructions"] = str(instructions)

    async with httpx.AsyncClient(timeout=60.0) as client:
        response = await client.post(
            f"{OPENAI_AUDIO_BASE}/speech",
            headers={
                "Authorization": f"Bearer {api_key}",
                "Content-Type": "application/json",
            },
            json=body,
        )
        if response.status_code != 200:
            raise RuntimeError(f"OpenAI TTS error {response.status_code}: {response.text}")

    run_dir = get_run_dir()
    # Use the selected format as the file extension. Defensively fall back to
    # "mp3" only for values outside the known format set (should never happen
    # given the registry enums, but guards against future registry drift).
    ext = response_format if response_format in _TTS_VALID_FORMATS else "mp3"
    filename = f"{uuid4().hex[:12]}.{ext}"
    file_path = run_dir / filename
    file_path.write_bytes(response.content)

    return {"audio": {"type": "Audio", "value": str(file_path)}}
