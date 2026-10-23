from __future__ import annotations

from pathlib import Path
from typing import Any

import httpx

from models.graph import GraphNode, PortValueDict
from services.edit_masks import image_size, openai_edit_mask
from services.media_input import read_local_media
from services.output import get_run_dir, portable_output_ref, save_base64_image
from execution.missing_credential import MissingCredentialError
from services.retired_nodes import GPT_IMAGE_1_SHUTDOWN, default_until
from handlers.openai_image import check_background
from execution.person_line import as_person_line, missing_file_line, with_api_status, with_person_line

OPENAI_IMAGE_EDIT_URL = "https://api.openai.com/v1/images/edits"
# gpt-image-1 shuts down 2026-10-23; OpenAI names gpt-image-2.5-sunburst or
# -flare as the replacement and recommends Sunburst "for workflows where editing
# precision matters most" (https://developers.openai.com/api/docs/deprecations,
# .../guides/image-generation, checked 2026-10-14).
DEFAULT_MODEL = "gpt-image-2.5-sunburst"


# "less than 50MB in size" (OpenAI images reference, as in handlers/openai_image_v2.py).
MAX_IMAGE_BYTES = 50_000_000


def _resolve_image_bytes(value: Any) -> bytes:
    """Convert a filesystem path to raw bytes for multipart upload (file policy, then the size cap)."""
    image_path = Path(str(value))
    if image_path.exists():
        return read_local_media(image_path, label="Image input", max_bytes=MAX_IMAGE_BYTES)[1]
    raise with_person_line(ValueError(f"Image file not found: {value}"), missing_file_line("image file"))


async def handle_openai_image_edit(
    node: GraphNode,
    inputs: dict[str, PortValueDict],
    api_keys: dict[str, str],
) -> dict[str, Any]:
    # --- required inputs ---
    image_input = inputs.get("image")
    if not image_input or not image_input.value:
        raise as_person_line(ValueError("Image input is required but was not provided"))

    prompt_input = inputs.get("prompt")
    if not prompt_input or not prompt_input.value:
        raise as_person_line(ValueError("Prompt input is required but was not provided"))

    api_key = api_keys.get("OPENAI_API_KEY")
    if not api_key:
        raise MissingCredentialError("OPENAI_API_KEY is required")

    check_background(node.params)

    # --- resolve image bytes ---
    image_bytes = _resolve_image_bytes(image_input.value)

    # --- optional mask ---
    mask_input = inputs.get("mask")
    mask_bytes: bytes | None = None
    if mask_input and mask_input.value:
        # OpenAI edits only where the mask is transparent; Nebula's masks are
        # white-on-black. openai_edit_mask converts (services/edit_masks.py).
        mask_bytes = openai_edit_mask(_resolve_image_bytes(mask_input.value), image_size(str(image_input.value)))

    # --- build multipart form data ---
    prompt_text = str(prompt_input.value)
    # A node with no stored model keeps gpt-image-1 until it shuts down.
    model = node.params.get("model") or default_until(GPT_IMAGE_1_SHUTDOWN, "gpt-image-1", DEFAULT_MODEL)

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
    if background and background != "auto":
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
            raise with_api_status(
                RuntimeError(f"OpenAI API error {response.status_code}: {error_detail}"), response.status_code)
        response.raise_for_status()

    data = response.json()
    images = [item["b64_json"] for item in data.get("data") or [] if isinstance(item, dict) and item.get("b64_json")]
    if not images:
        raise RuntimeError(f"OpenAI returned no image: {str(data)[:300]}")

    # Match the saved file extension to the format the API returns.
    # output_format controls the actual bytes returned, so jpeg/webp requests
    # must be saved with the matching extension for correct MIME inference downstream.
    extension = output_format if output_format in ("png", "jpeg", "webp") else "png"

    run_dir = get_run_dir()
    # Count (n) asks for several edits; every one is kept, the first on "image".
    paths = [str(save_base64_image(b64, run_dir, extension=extension)) for b64 in images]

    return {
        "image": {
            "type": "Image",
            "value": paths[0],
        },
        "images": {
            "type": "Array",
            "value": [portable_output_ref(path, require_file=True) for path in paths],
        },
    }
