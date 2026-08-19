"""Bounded multi-provider vision requests for Video QC advisory analysis."""

from __future__ import annotations

import asyncio
import base64
import io
import json
import mimetypes
from dataclasses import dataclass
from pathlib import Path
from typing import Any, Sequence

import httpx
from PIL import Image, ImageOps

VISION_TIMEOUT_SECONDS = 45.0
MAX_VISION_IMAGES = 13  # 12 sampled frames plus one optional reference image.
MAX_VISION_IMAGE_EDGE = 768
# Google's inline request limit is 20 MB including prompts and JSON. Keep the
# base64 image portion below 16 MiB so headers/instructions retain headroom.
MAX_VISION_BASE64_CHARS = 16 * 1024 * 1024


class NoVisionProviderError(ValueError):
    pass


class VisionProviderError(RuntimeError):
    pass


@dataclass(frozen=True)
class VisionProvider:
    name: str
    key_name: str
    model: str


VISION_PROVIDERS = (
    VisionProvider("anthropic", "ANTHROPIC_API_KEY", "claude-sonnet-4-6"),
    VisionProvider("openai", "OPENAI_API_KEY", "gpt-4o-mini"),
    VisionProvider("google", "GOOGLE_API_KEY", "gemini-3-flash-preview"),
)


def available_vision_providers(api_keys: dict[str, str]) -> list[VisionProvider]:
    return [provider for provider in VISION_PROVIDERS if api_keys.get(provider.key_name)]


def _encoded_images(paths: Sequence[Path]) -> list[tuple[str, str]]:
    if not paths:
        raise ValueError("At least one vision image is required")
    if len(paths) > MAX_VISION_IMAGES:
        raise ValueError(f"Vision requests support at most {MAX_VISION_IMAGES} images")

    encoded: list[tuple[str, str]] = []
    encoded_chars = 0
    for path in paths:
        mime = mimetypes.guess_type(path.name)[0] or "image/png"
        if mime not in {"image/png", "image/jpeg", "image/webp", "image/gif"}:
            raise ValueError(f"Unsupported vision image type: {path.suffix}")
        # Provider limits apply to the JSON request after base64 expansion, not
        # to the source file. Normalize every advisory frame to a bounded JPEG
        # in memory; the source artifact remains untouched on disk.
        with Image.open(path) as source:
            image = ImageOps.exif_transpose(source).convert("RGB")
            image.thumbnail(
                (MAX_VISION_IMAGE_EDGE, MAX_VISION_IMAGE_EDGE),
                Image.Resampling.LANCZOS,
            )
            buffer = io.BytesIO()
            image.save(buffer, format="JPEG", quality=78, optimize=True)
        data = base64.b64encode(buffer.getvalue()).decode("ascii")
        encoded_chars += len(data)
        if encoded_chars > MAX_VISION_BASE64_CHARS:
            raise ValueError(
                "Vision image payload exceeds the bounded inline request size"
            )
        encoded.append(("image/jpeg", data))
    return encoded


def build_vision_request(
    provider: VisionProvider,
    api_key: str,
    *,
    system_prompt: str,
    images: Sequence[Path],
    user_prompt: str,
) -> tuple[str, dict[str, str], dict[str, Any]]:
    encoded = _encoded_images(images)
    json_instruction = "Respond with one JSON object and no markdown. "
    prompt = json_instruction + user_prompt

    if provider.name == "anthropic":
        content: list[dict[str, Any]] = [
            {
                "type": "image",
                "source": {"type": "base64", "media_type": mime, "data": data},
            }
            for mime, data in encoded
        ]
        content.append({"type": "text", "text": prompt})
        return (
            "https://api.anthropic.com/v1/messages",
            {
                "x-api-key": api_key,
                "anthropic-version": "2023-06-01",
                "content-type": "application/json",
            },
            {
                "model": provider.model,
                "max_tokens": 1200,
                "system": system_prompt,
                "messages": [{"role": "user", "content": content}],
            },
        )

    if provider.name == "openai":
        content = [
            {
                "type": "image_url",
                "image_url": {"url": f"data:{mime};base64,{data}", "detail": "low"},
            }
            for mime, data in encoded
        ]
        content.append({"type": "text", "text": prompt})
        return (
            "https://api.openai.com/v1/chat/completions",
            {"authorization": f"Bearer {api_key}", "content-type": "application/json"},
            {
                "model": provider.model,
                "messages": [
                    {"role": "system", "content": system_prompt},
                    {"role": "user", "content": content},
                ],
                "response_format": {"type": "json_object"},
                "max_tokens": 1200,
                "temperature": 0,
            },
        )

    if provider.name == "google":
        parts: list[dict[str, Any]] = [
            {"inline_data": {"mime_type": mime, "data": data}}
            for mime, data in encoded
        ]
        parts.append({"text": prompt})
        return (
            f"https://generativelanguage.googleapis.com/v1beta/models/{provider.model}:generateContent",
            {"x-goog-api-key": api_key, "content-type": "application/json"},
            {
                "systemInstruction": {"parts": [{"text": system_prompt}]},
                "contents": [{"role": "user", "parts": parts}],
                "generationConfig": {
                    "responseMimeType": "application/json",
                    "temperature": 1.0,
                    "maxOutputTokens": 1200,
                },
            },
        )
    raise ValueError(f"Unsupported vision provider: {provider.name}")


def parse_vision_response(provider: VisionProvider, payload: dict[str, Any]) -> str:
    try:
        if provider.name == "anthropic":
            return "".join(
                str(block.get("text", ""))
                for block in payload["content"]
                if block.get("type") == "text"
            ).strip()
        if provider.name == "openai":
            return str(payload["choices"][0]["message"]["content"]).strip()
        if provider.name == "google":
            return "".join(
                str(part.get("text", ""))
                for part in payload["candidates"][0]["content"]["parts"]
                if "text" in part
            ).strip()
    except (KeyError, IndexError, TypeError) as exc:
        raise VisionProviderError(
            f"Malformed {provider.name} vision response"
        ) from exc
    raise ValueError(f"Unsupported vision provider: {provider.name}")


def parse_json_object(text: str) -> dict[str, Any]:
    cleaned = text.strip()
    if cleaned.startswith("```"):
        cleaned = cleaned.removeprefix("```json").removeprefix("```")
        cleaned = cleaned.removesuffix("```").strip()
    try:
        parsed = json.loads(cleaned)
    except json.JSONDecodeError:
        return {"assessment": text[:4000], "provider_json_valid": False}
    if not isinstance(parsed, dict):
        return {"assessment": text[:4000], "provider_json_valid": False}
    parsed["provider_json_valid"] = True
    return parsed


async def call_vision_llm(
    api_keys: dict[str, str],
    *,
    system_prompt: str,
    images: Sequence[Path],
    user_prompt: str,
    client: httpx.AsyncClient | None = None,
) -> dict[str, Any]:
    providers = available_vision_providers(api_keys)
    if not providers:
        raise NoVisionProviderError(
            "vision-llm mode requires ANTHROPIC_API_KEY, OPENAI_API_KEY, or GOOGLE_API_KEY"
        )
    provider = providers[0]
    url, headers, body = build_vision_request(
        provider,
        api_keys[provider.key_name],
        system_prompt=system_prompt,
        images=images,
        user_prompt=user_prompt,
    )

    owns_client = client is None
    active_client = client or httpx.AsyncClient(timeout=VISION_TIMEOUT_SECONDS)
    try:
        try:
            # Enforce the deadline here as well as on the client. A caller may
            # inject a reusable client with no timeout; that must not weaken the
            # bounded-request contract or leave provider work running forever.
            response = await asyncio.wait_for(
                active_client.post(url, headers=headers, json=body),
                timeout=VISION_TIMEOUT_SECONDS,
            )
        except asyncio.TimeoutError as exc:
            raise VisionProviderError(
                f"{provider.name} vision request timed out after "
                f"{VISION_TIMEOUT_SECONDS:g} seconds"
            ) from exc
        if response.status_code != 200:
            raise VisionProviderError(
                f"{provider.name} vision request failed ({response.status_code}): "
                f"{response.text[-1024:]}"
            )
        try:
            payload = response.json()
        except (json.JSONDecodeError, ValueError) as exc:
            raise VisionProviderError(
                f"Malformed {provider.name} vision response"
            ) from exc
        parsed = parse_json_object(parse_vision_response(provider, payload))
        parsed["vision_provider"] = provider.name
        parsed["vision_model"] = provider.model
        return parsed
    except httpx.HTTPError as exc:
        raise VisionProviderError(f"{provider.name} vision request failed: {exc}") from exc
    finally:
        if owns_client:
            await active_client.aclose()
