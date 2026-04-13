from __future__ import annotations

from typing import Any

import httpx

from models.graph import GraphNode, PortValueDict
from services.output import get_run_dir, save_base64_image

OPENAI_API_URL = "https://api.openai.com/v1/images/generations"


async def handle_openai_image_generate(
    node: GraphNode,
    inputs: dict[str, PortValueDict],
    api_keys: dict[str, str],
) -> dict[str, Any]:
    prompt_input = inputs.get("prompt")
    if not prompt_input or not prompt_input.value:
        raise ValueError("Prompt input is required but was not provided")

    prompt_text = str(prompt_input.value)

    api_key = api_keys.get("OPENAI_API_KEY")
    if not api_key:
        raise ValueError("OPENAI_API_KEY is required")

    body: dict[str, Any] = {
        "model": node.params.get("model", "gpt-image-1"),
        "prompt": prompt_text,
        "response_format": "b64_json",
    }

    size = node.params.get("size")
    if size and size != "auto":
        body["size"] = size

    quality = node.params.get("quality")
    if quality and quality != "auto":
        body["quality"] = quality

    n = node.params.get("n", 1)
    if n and int(n) > 1:
        body["n"] = int(n)

    async with httpx.AsyncClient(timeout=120.0) as client:
        response = await client.post(
            OPENAI_API_URL,
            headers={
                "Authorization": f"Bearer {api_key}",
                "Content-Type": "application/json",
            },
            json=body,
        )
        response.raise_for_status()

    data = response.json()
    b64_data = data["data"][0]["b64_json"]

    run_dir = get_run_dir()
    file_path = save_base64_image(b64_data, run_dir, extension="png")

    return {
        "image": {
            "type": "Image",
            "value": str(file_path),
        }
    }
