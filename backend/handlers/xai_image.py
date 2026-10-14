"""Grok Imagine images on xAI's own API (XAI_API_KEY).

POST https://api.x.ai/v1/images/generations (text to image) and
POST https://api.x.ai/v1/images/edits (image edit, JSON body, not multipart),
per xAI's REST reference (https://docs.x.ai/developers/rest-api-reference/inference/images,
checked 2026-10-14):

- ``model``, ``prompt`` (required on edits), ``n`` ("Generate multiple images
  in a single request with the `n` parameter (`1`-`10`)", images/generation
  guide), ``aspect_ratio`` ("1:1" | "3:4" | ... | "21:9" | "5:2" | "auto"),
  ``resolution`` ("1k" | "2k" | "1.5k"), ``response_format`` ("url or b64_json").
- ``quality`` ("Allowed values are `low`, `medium`, and `auto` ... The
  parameter is only supported for `grok-imagine-image-2.0`", same guide).
- Edits take ``image`` (one) or ``images`` ("List of input images for
  multi-reference editing. Mutually exclusive with `image`"), each
  ``{"url": ...}`` with "Public URL or base64-encoded data URL of the image
  (JPEG, PNG, or WebP)". "Use up to five source images for a single image
  edit" (multi-image-editing guide).
- Each response item carries ``b64_json`` and ``mime_type`` ("The MIME type of
  the generated image (e.g. `image/png`, `image/jpeg`, `image/webp`)"); xAI has
  no output-format request field.

Used by the dual-route fal and Krea Grok Imagine copies
(execution/maker_routes_xai.py). This module never decides the route.
"""
from __future__ import annotations

import base64
import sys
from pathlib import Path
from typing import Any

import httpx

from execution.missing_credential import MissingCredentialError
from models.graph import GraphNode, PortValueDict
from services.image_input import is_remote_or_data_uri, load_local_image
from services.output import get_run_dir, resolve_output_ref, save_base64_image

XAI_API_BASE = "https://api.x.ai/v1"
GENERATIONS_URL = f"{XAI_API_BASE}/images/generations"
EDITS_URL = f"{XAI_API_BASE}/images/edits"
MAX_EDIT_IMAGES = 5
MAX_IMAGES_PER_REQUEST = 10
# Only grok-imagine-image-2.0 takes `quality` (images/generation guide).
QUALITY_MODELS = {"grok-imagine-image-2.0"}
_EXTENSIONS = {"image/png": "png", "image/jpeg": "jpg", "image/webp": "webp"}


def _log(message: str) -> None:
    print(f"[xai-image] {message}", file=sys.stderr, flush=True)


def xai_image_url(value: Any) -> str:
    """An image input as xAI takes it: a public URL or data URI as is, a local
    file or served /api/outputs ref as a base64 data URI. Raises on a missing
    or unsupported file (services.image_input) instead of dropping it."""
    text = str(value or "").strip()
    if not text:
        raise ValueError("Image input is empty")
    if is_remote_or_data_uri(text):
        return text
    mime, data = load_local_image(resolve_output_ref(text))
    return f"data:{mime};base64,{data}"


def xai_video_url(value: Any) -> str:
    """A video input as xAI takes it: a public URL or data URI as is, a local
    .mp4 (or served /api/outputs ref) as a base64 data URL. xAI: "The video
    must have the `.mp4` file extension" (videos REST reference)."""
    from services.file_access import require_allowed_path

    text = str(value or "").strip()
    if not text:
        raise ValueError("Video input is empty")
    if is_remote_or_data_uri(text):
        return text
    path = Path(require_allowed_path(resolve_output_ref(text)))
    if not path.is_file():
        raise ValueError(f"Video input not found: {text!r}. It was NOT sent to xAI.")
    if path.suffix.lower() != ".mp4":
        raise ValueError(f"xAI takes .mp4 video input, not {path.suffix or 'a file without an extension'} ({text!r})")
    return "data:video/mp4;base64," + base64.b64encode(path.read_bytes()).decode("ascii")


def _image_values(port: PortValueDict | None) -> list[Any]:
    if port is None or port.value in (None, ""):
        return []
    values = port.value if isinstance(port.value, list) else [port.value]
    return [value for value in values if value not in (None, "")]


def _count(value: Any) -> int:
    if value in (None, ""):
        return 1
    if isinstance(value, bool) or not isinstance(value, int) or not 1 <= value <= MAX_IMAGES_PER_REQUEST:
        raise ValueError(f"xAI makes 1 to {MAX_IMAGES_PER_REQUEST} images per request (received {value!r})")
    return value


def _error_text(response: httpx.Response) -> str:
    try:
        payload = response.json()
    except ValueError:
        return response.text[:500]
    if isinstance(payload, dict):
        error = payload.get("error")
        if isinstance(error, dict) and error.get("message"):
            return str(error["message"])
        if isinstance(error, str):
            return error
        if payload.get("message"):
            return str(payload["message"])
    return response.text[:500]


async def handle_xai_image(
    node: GraphNode,
    inputs: dict[str, PortValueDict],
    api_keys: dict[str, str],
) -> dict[str, Any]:
    """One xAI image request. Params (already in xAI's names): ``model``
    (required), ``n``, ``aspect_ratio``, ``resolution``, ``quality``. Inputs:
    ``prompt`` (Text) and optional ``images`` (Image, multiple), which make it
    an edit. Saves every returned image; ``image`` is the first, ``images``
    all of them (local paths)."""
    api_key = (api_keys.get("XAI_API_KEY") or "").strip()
    if not api_key:
        raise MissingCredentialError("XAI_API_KEY is required")
    params = node.params
    model = str(params.get("model") or "")
    if not model:
        raise ValueError("xAI image model is required")
    prompt_port = inputs.get("prompt")
    prompt = str(prompt_port.value).strip() if prompt_port and prompt_port.value not in (None, "") else ""
    if not prompt:
        raise ValueError("Prompt is required")

    body: dict[str, Any] = {"model": model, "prompt": prompt, "response_format": "b64_json"}
    count = _count(params.get("n"))
    if count != 1:
        body["n"] = count
    for key in ("aspect_ratio", "resolution"):
        if params.get(key):
            body[key] = str(params[key])
    if params.get("quality"):
        if model not in QUALITY_MODELS:
            raise ValueError(f"xAI takes quality only on {', '.join(sorted(QUALITY_MODELS))}, not {model}")
        body["quality"] = str(params["quality"])

    sources = _image_values(inputs.get("images"))
    if len(sources) > MAX_EDIT_IMAGES:
        raise ValueError(f"xAI edits take up to {MAX_EDIT_IMAGES} source images (received {len(sources)})")
    urls = [xai_image_url(value) for value in sources]
    if len(urls) == 1:
        body["image"] = {"url": urls[0]}
    elif urls:
        body["images"] = [{"url": url} for url in urls]
    endpoint = EDITS_URL if urls else GENERATIONS_URL

    _log(f"{'edit' if urls else 'generate'} {model} n={count}")
    async with httpx.AsyncClient(timeout=180.0) as client:
        response = await client.post(
            endpoint,
            headers={"Authorization": f"Bearer {api_key}", "Content-Type": "application/json"},
            json=body,
        )
    if response.status_code != 200:
        raise RuntimeError(f"xAI image request failed ({response.status_code}): {_error_text(response)}")
    items = (response.json() or {}).get("data") or []
    run_dir = get_run_dir()
    saved: list[str] = []
    for item in items:
        data = item.get("b64_json") if isinstance(item, dict) else None
        if not data:
            continue
        extension = _EXTENSIONS.get(str(item.get("mime_type") or "").lower(), "jpg")
        saved.append(str(save_base64_image(data, run_dir, extension=extension)))
    if not saved:
        raise RuntimeError("xAI returned no image (the request may have been filtered by moderation)")
    return {
        "image": {"type": "Image", "value": saved[0]},
        "images": {"type": "Array", "value": saved},
    }
