from __future__ import annotations

from pathlib import Path
from typing import Any

import httpx

from models.graph import GraphNode, PortValueDict
from services.output import get_run_dir, save_base64_image

OPENAI_IMAGE_EDIT_URL = "https://api.openai.com/v1/images/edits"


def _resolve_image_bytes(value: Any) -> bytes:
    """Convert a filesystem path to raw bytes for multipart upload."""
    image_path = Path(str(value))
    if image_path.exists():
        return image_path.read_bytes()
    raise ValueError(f"Image file not found: {value}")


async def handle_openai_image_edit(
    node: GraphNode,
    inputs: dict[str, PortValueDict],
    api_keys: dict[str, str],
) -> dict[str, Any]:
    # --- required inputs ---
    image_input = inputs.get("image")
    if not image_input or not image_input.value:
        raise ValueError("Image input is required but was not provided")

    prompt_input = inputs.get("prompt")
    if not prompt_input or not prompt_input.value:
        raise ValueError("Prompt input is required but was not provided")

    api_key = api_keys.get("OPENAI_API_KEY")
    if not api_key:
        raise ValueError("OPENAI_API_KEY is required")

    # --- resolve image bytes ---
    image_bytes = _resolve_image_bytes(image_input.value)

    # --- optional mask ---
    mask_input = inputs.get("mask")
    mask_bytes: bytes | None = None
    if mask_input and mask_input.value:
        mask_bytes = _resolve_image_bytes(mask_input.value)

    # --- build multipart form data ---
    prompt_text = str(prompt_input.value)
    model = node.params.get("model", "gpt-image-1")

    files: list[tuple[str, Any]] = [
        ("image", ("image.png", image_bytes, "image/png")),
        ("prompt", (None, prompt_text)),
        ("model", (None, model)),
    ]

    if mask_bytes is not None:
        files.append(("mask", ("mask.png", mask_bytes, "image/png")))

    n = node.params.get("n", 1)
    if n and int(n) > 1:
        files.append(("n", (None, str(int(n)))))

    size = node.params.get("size")
    if size and size != "auto":
        files.append(("size", (None, size)))

    quality = node.params.get("quality")
    if quality and quality != "auto":
        files.append(("quality", (None, quality)))

    output_format = node.params.get("output_format")
    if output_format:
        files.append(("output_format", (None, output_format)))

    background = node.params.get("background")
    if background:
        files.append(("background", (None, background)))

    # --- POST to OpenAI ---
    async with httpx.AsyncClient(timeout=120.0) as client:
        response = await client.post(
            OPENAI_IMAGE_EDIT_URL,
            headers={"Authorization": f"Bearer {api_key}"},
            files=files,
        )
        if response.status_code != 200:
            error_detail = response.text
            raise RuntimeError(f"OpenAI API error {response.status_code}: {error_detail}")
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
