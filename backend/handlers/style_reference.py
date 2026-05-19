"""Style Reference utility node.

A glue node that wraps existing style-application capability in the
catalog (nano-banana multi-ref, flux-kontext, seedream, gpt-image-2-edit)
behind one drop-in surface: drop a reference image, get back the image
+ a style-only text description that any downstream model can consume.

Three modes:
- `auto` — Gemini 2.5 Flash extracts a 30-40 word visual-style descriptor
  (palette, lighting, medium, mood, era — never subject content). Result
  is deterministic per (image, focus) via ExecutionCache.
- `manual` — user types the description; no API call.
- `passthrough` — emit empty text, only the image is useful. Best for
  downstream models that already accept an Image-typed style ref.

The Strength param (0-1) appends `(style strength: X)` to the description
as a soft signal. Models with explicit guidance_scale ignore it; for
prompt-only models it's a usable nudge.
"""

from __future__ import annotations

import base64
from pathlib import Path
from typing import Any, Awaitable, Callable

import httpx

from models.events import ExecutionEvent
from models.graph import GraphNode, PortValueDict
from services.output import OUTPUT_ROOT


GEMINI_BASE_URL = "https://generativelanguage.googleapis.com/v1beta/models"
DEFAULT_GEMINI_MODEL = "gemini-2.5-flash"
_OUTPUTS_URL_PREFIX = "/api/outputs/"


# Four fixed system prompts. Kept short — Gemini 2.5 Flash is cheap, but
# every word costs and shorter prompts are less likely to drift into
# describing subject content.
_STYLE_PROMPTS: dict[str, str] = {
    "all": (
        "In 30-40 words, describe the VISUAL STYLE of this image: palette, lighting, "
        "medium or texture, mood, era. Do not describe the subject or what is happening. "
        "Output a single comma-separated phrase suitable for appending to a generation prompt."
    ),
    "palette": (
        "In 15 words, describe the COLOR PALETTE of this image only. Do not describe the subject. "
        "Output a single comma-separated phrase suitable for appending to a generation prompt."
    ),
    "lighting": (
        "In 15 words, describe the LIGHTING of this image only. Do not describe the subject. "
        "Output a single comma-separated phrase suitable for appending to a generation prompt."
    ),
    "medium": (
        "In 15 words, describe the MEDIUM AND TEXTURE of this image only. Do not describe the subject. "
        "Output a single comma-separated phrase suitable for appending to a generation prompt."
    ),
}


def _resolve_local_path(value: str) -> Path | None:
    """Resolve a filePath param to a real filesystem path.

    Accepts:
    - `/api/outputs/<rel>` — served URL for an asset under OUTPUT_ROOT
    - absolute filesystem path — used as-is if it exists

    Returns None for anything unresolvable so the caller can raise a clear error.
    """
    if not value:
        return None
    if value.startswith(_OUTPUTS_URL_PREFIX):
        rel = value[len(_OUTPUTS_URL_PREFIX):]
        candidate = (OUTPUT_ROOT / rel).resolve()
        try:
            candidate.relative_to(OUTPUT_ROOT.resolve())
        except ValueError:
            return None
        return candidate if candidate.exists() else None
    candidate = Path(value).expanduser()
    if candidate.is_absolute() and candidate.exists():
        return candidate
    return None


def _mime_for_path(path: Path) -> str:
    suffix = path.suffix.lstrip(".").lower()
    return {
        "png": "image/png",
        "jpg": "image/jpeg",
        "jpeg": "image/jpeg",
        "webp": "image/webp",
        "gif": "image/gif",
    }.get(suffix, "image/png")


async def _describe_style(api_key: str, image_path: Path, system_prompt: str) -> str:
    """One-shot Gemini call to extract a style descriptor from an image.

    Uses the non-streaming `generateContent` endpoint — we want one
    short answer, not progressive text.
    """
    b64_data = base64.b64encode(image_path.read_bytes()).decode("ascii")
    mime_type = _mime_for_path(image_path)
    body: dict[str, Any] = {
        "contents": [
            {
                "role": "user",
                "parts": [
                    {"text": system_prompt},
                    {"inline_data": {"mime_type": mime_type, "data": b64_data}},
                ],
            }
        ],
        "generationConfig": {"temperature": 0.4, "maxOutputTokens": 200},
    }
    url = f"{GEMINI_BASE_URL}/{DEFAULT_GEMINI_MODEL}:generateContent"
    async with httpx.AsyncClient(timeout=60.0) as client:
        response = await client.post(
            url,
            headers={"Content-Type": "application/json", "x-goog-api-key": api_key},
            json=body,
        )
        if response.status_code != 200:
            raise RuntimeError(f"Gemini style extraction failed ({response.status_code}): {response.text[:300]}")
        payload = response.json()
    candidates = payload.get("candidates") or []
    if not candidates:
        raise RuntimeError(f"Gemini returned no candidates: {str(payload)[:300]}")
    parts = (candidates[0].get("content") or {}).get("parts") or []
    text_parts = [p.get("text", "") for p in parts if isinstance(p, dict) and p.get("text")]
    if not text_parts:
        raise RuntimeError(f"Gemini returned no text content: {str(payload)[:300]}")
    return " ".join(text_parts).strip()


def _apply_strength_suffix(description: str, strength: float) -> str:
    """Append a soft style-strength signal when description is non-empty and strength != 1.0."""
    if not description or strength == 1.0:
        return description
    return f"{description} (style strength: {strength:.2f})"


async def handle_style_reference(
    node: GraphNode,
    inputs: dict[str, PortValueDict],
    api_keys: dict[str, str],
    emit: Callable[[ExecutionEvent], Awaitable[None]] | None = None,
) -> dict[str, Any]:
    """Drop-in style reference. See module docstring."""
    params = node.params or {}
    file_path_value = params.get("filePath")
    if not file_path_value:
        raise ValueError("Style Reference needs a reference image (filePath param)")

    abs_path = _resolve_local_path(str(file_path_value))
    if abs_path is None:
        raise ValueError(f"Reference image not found: {file_path_value}")

    image_value: dict[str, Any] = {"type": "Image", "value": str(abs_path)}

    mode = str(params.get("mode", "auto"))
    try:
        strength = float(params.get("strength", 0.7))
    except (TypeError, ValueError):
        strength = 0.7

    if mode == "passthrough":
        return {
            "image": image_value,
            "style_description": {"type": "Text", "value": ""},
        }

    if mode == "manual":
        text = str(params.get("manual_description", "")).strip()
        text = _apply_strength_suffix(text, strength)
        return {
            "image": image_value,
            "style_description": {"type": "Text", "value": text},
        }

    # auto mode
    focus = str(params.get("focus", "all"))
    system_prompt = _STYLE_PROMPTS.get(focus, _STYLE_PROMPTS["all"])
    api_key = api_keys.get("GOOGLE_API_KEY")
    if not api_key:
        raise ValueError(
            "GOOGLE_API_KEY required for Auto mode. Switch the Mode param to Manual or "
            "Image only to use this node without a Gemini call."
        )

    description = await _describe_style(api_key, abs_path, system_prompt)
    description = _apply_strength_suffix(description, strength)
    return {
        "image": image_value,
        "style_description": {"type": "Text", "value": description},
    }
