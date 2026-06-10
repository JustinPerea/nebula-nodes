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

    model = node.params.get("model", "gpt-image-1")

    body: dict[str, Any] = {
        "model": model,
        "prompt": prompt_text,
    }

    # gpt-image models always return b64_json by default — no response_format needed.

    size = node.params.get("size")
    if size and size != "auto":
        body["size"] = size

    quality = node.params.get("quality")
    if quality and quality != "auto":
        body["quality"] = quality

    n = node.params.get("n", 1)
    if n and int(n) > 1:
        body["n"] = int(n)

    # GPT image models support output_format (png/jpeg/webp).
    # Capture output_format here so we can use it for the saved file extension below.
    output_format: str | None = node.params.get("output_format")
    if output_format and output_format != "png":
        body["output_format"] = output_format

    background = node.params.get("background")
    if background and background != "auto":
        body["background"] = background

    async with httpx.AsyncClient(timeout=120.0) as client:
        response = await client.post(
            OPENAI_API_URL,
            headers={
                "Authorization": f"Bearer {api_key}",
                "Content-Type": "application/json",
            },
            json=body,
        )
        if response.status_code != 200:
            error_detail = response.text
            raise RuntimeError(f"OpenAI API error {response.status_code}: {error_detail}")
        response.raise_for_status()

    data = response.json()
    b64_data = data["data"][0]["b64_json"]

    # Match the saved file extension to the format actually returned by the API.
    # GPT image models honour output_format, so jpeg/webp need the matching extension
    # so that downstream MIME inference (e.g. image_to_data_uri) is correct.
    extension = output_format if output_format in ("png", "jpeg", "webp") else "png"

    run_dir = get_run_dir()
    file_path = save_base64_image(b64_data, run_dir, extension=extension)

    return {
        "image": {
            "type": "Image",
            "value": str(file_path),
        }
    }
