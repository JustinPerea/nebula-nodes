from __future__ import annotations

from typing import Any, Awaitable, Callable

import httpx

from models.graph import GraphNode, PortValueDict
from models.events import ExecutionEvent
from execution.stream_runner import StreamConfig, stream_execute
from services.output import get_run_dir, save_base64_image

OPENROUTER_API_URL = "https://openrouter.ai/api/v1/chat/completions"


async def handle_openrouter_universal(
    node: GraphNode,
    inputs: dict[str, PortValueDict],
    api_keys: dict[str, str],
    emit: Callable[[ExecutionEvent], Awaitable[None]] | None = None,
) -> dict[str, Any]:
    api_key = api_keys.get("OPENROUTER_API_KEY")
    if not api_key:
        raise ValueError("OPENROUTER_API_KEY is required")

    model = node.params.get("model", "")
    if not model:
        raise ValueError("No model selected — choose a model from the Inspector panel")

    # Build messages from input
    messages_input = inputs.get("messages")
    if not messages_input or not messages_input.value:
        raise ValueError("Messages input is required")

    messages_text = str(messages_input.value)
    content: list[dict[str, Any]] = [{"type": "text", "text": messages_text}]

    # Handle image inputs for vision models
    images_input = inputs.get("images")
    if images_input and images_input.value:
        image_values = images_input.value if isinstance(images_input.value, list) else [images_input.value]
        for img_val in image_values:
            img_str = str(img_val)
            if img_str.startswith(("http://", "https://")):
                content.append({"type": "image_url", "image_url": {"url": img_str}})
            elif img_str.startswith("data:"):
                content.append({"type": "image_url", "image_url": {"url": img_str}})
            else:
                from pathlib import Path
                import base64
                img_path = Path(img_str)
                if img_path.exists():
                    b64 = base64.b64encode(img_path.read_bytes()).decode("ascii")
                    suffix = img_path.suffix.lstrip(".").lower()
                    mime_map = {"png": "image/png", "jpg": "image/jpeg", "jpeg": "image/jpeg", "webp": "image/webp"}
                    data_uri = f"data:{mime_map.get(suffix, 'image/png')};base64,{b64}"
                    content.append({"type": "image_url", "image_url": {"url": data_uri}})

    messages = [{"role": "user", "content": content}]

    # Check if this is an image generation model
    wants_image = node.params.get("_output_image", False)

    request_body: dict[str, Any] = {
        "model": str(model),
        "messages": messages,
    }

    max_tokens = node.params.get("max_tokens")
    if max_tokens:
        request_body["max_tokens"] = int(max_tokens)

    temperature = node.params.get("temperature")
    if temperature is not None:
        request_body["temperature"] = float(temperature)

    if wants_image:
        # Image generation via chat/completions
        request_body["modalities"] = ["text", "image"]
        # Non-streaming for image generation
        return await _handle_image_generation(request_body, api_key, node)
    else:
        # Text generation — stream
        request_body["stream"] = True
        return await _handle_text_streaming(request_body, api_key, node, emit)


async def _handle_text_streaming(
    request_body: dict[str, Any],
    api_key: str,
    node: GraphNode,
    emit: Callable[[ExecutionEvent], Awaitable[None]] | None,
) -> dict[str, Any]:
    config = StreamConfig(
        url=OPENROUTER_API_URL,
        headers={
            "Authorization": f"Bearer {api_key}",
            "Content-Type": "application/json",
            "HTTP-Referer": "http://localhost:5173",
            "X-Title": "Nebula Nodes",
        },
        event_type_filter=None,  # OpenRouter sends standard SSE without event types
        delta_path="choices.0.delta.content",
        timeout=30.0,
        extra_stop_events=set(),
    )

    async def noop_emit(event: ExecutionEvent) -> None:
        pass

    full_text = await stream_execute(
        config=config,
        request_body=request_body,
        node_id=node.id,
        emit=emit or noop_emit,
    )

    return {"text": {"type": "Text", "value": full_text}}


async def _handle_image_generation(
    request_body: dict[str, Any],
    api_key: str,
    node: GraphNode,
) -> dict[str, Any]:
    """Handle image generation models via OpenRouter chat/completions.

    Image output is in choices[0].message.images[] — NOT the standard
    data[].b64_json location. Each entry is a base64-encoded image.
    """
    async with httpx.AsyncClient(timeout=120.0) as client:
        resp = await client.post(
            OPENROUTER_API_URL,
            headers={
                "Authorization": f"Bearer {api_key}",
                "Content-Type": "application/json",
                "HTTP-Referer": "http://localhost:5173",
                "X-Title": "Nebula Nodes",
            },
            json=request_body,
        )
        if resp.status_code != 200:
            raise RuntimeError(f"OpenRouter API error {resp.status_code}: {resp.text}")

    data = resp.json()

    # Check for images in the non-standard location
    message = data.get("choices", [{}])[0].get("message", {})
    images = message.get("images", [])

    if images:
        # Save first image
        b64_data = images[0]
        run_dir = get_run_dir()
        file_path = save_base64_image(b64_data, run_dir, extension="png")
        return {"image": {"type": "Image", "value": str(file_path)}}

    # Fallback: return text content
    text_content = message.get("content", "")
    return {"text": {"type": "Text", "value": text_content}}
