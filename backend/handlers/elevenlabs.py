from __future__ import annotations

from typing import Any
from uuid import uuid4

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

    body: dict[str, Any] = {
        "text": text,
        "model_id": model_id,
        "voice_settings": {
            "stability": stability,
            "similarity_boost": 0.75,
        },
    }

    url = f"{ELEVENLABS_API_BASE}/{voice_id}"

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
        response.raise_for_status()

    run_dir = get_run_dir()
    filename = f"{uuid4().hex[:12]}.mp3"
    file_path = run_dir / filename
    file_path.write_bytes(response.content)

    return {
        "audio": {
            "type": "Audio",
            "value": str(file_path),
        }
    }
