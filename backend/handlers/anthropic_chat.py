from __future__ import annotations

from typing import Any, Awaitable, Callable

from models.graph import GraphNode, PortValueDict
from models.events import ExecutionEvent
from execution.stream_runner import StreamConfig, stream_execute

ANTHROPIC_API_URL = "https://api.anthropic.com/v1/messages"
ANTHROPIC_VERSION = "2023-06-01"


async def handle_claude_chat(
    node: GraphNode,
    inputs: dict[str, PortValueDict],
    api_keys: dict[str, str],
    emit: Callable[[ExecutionEvent], Awaitable[None]] | None = None,
) -> dict[str, Any]:
    messages_input = inputs.get("messages")
    if not messages_input or not messages_input.value:
        raise ValueError("Messages input is required for Claude chat")

    messages_text = str(messages_input.value)

    api_key = api_keys.get("ANTHROPIC_API_KEY")
    if not api_key:
        raise ValueError("ANTHROPIC_API_KEY is required")

    content: list[dict[str, Any]] = [{"type": "text", "text": messages_text}]

    images_input = inputs.get("images")
    if images_input and images_input.value:
        image_values = images_input.value if isinstance(images_input.value, list) else [images_input.value]
        for img_val in image_values:
            img_str = str(img_val)
            if img_str.startswith("data:"):
                parts = img_str.split(",", 1)
                media_type = parts[0].split(":")[1].split(";")[0] if len(parts) > 1 else "image/png"
                b64_data = parts[1] if len(parts) > 1 else img_str
                content.append({"type": "image", "source": {"type": "base64", "media_type": media_type, "data": b64_data}})
            elif img_str.startswith(("http://", "https://")):
                content.append({"type": "image", "source": {"type": "url", "url": img_str}})
            else:
                from pathlib import Path
                import base64
                img_path = Path(img_str)
                if img_path.exists():
                    b64_data = base64.b64encode(img_path.read_bytes()).decode("ascii")
                    suffix = img_path.suffix.lstrip(".").lower()
                    mime_map = {"png": "image/png", "jpg": "image/jpeg", "jpeg": "image/jpeg", "webp": "image/webp"}
                    content.append({"type": "image", "source": {"type": "base64", "media_type": mime_map.get(suffix, "image/png"), "data": b64_data}})

    messages = [{"role": "user", "content": content}]

    model = node.params.get("model", "claude-sonnet-4-6")
    max_tokens = int(node.params.get("max_tokens", 4096))

    request_body: dict[str, Any] = {"model": model, "messages": messages, "max_tokens": max_tokens, "stream": True}

    temperature = node.params.get("temperature")
    if temperature is not None:
        request_body["temperature"] = float(temperature)

    system_prompt = node.params.get("system")
    if system_prompt:
        request_body["system"] = str(system_prompt)

    config = StreamConfig(
        url=ANTHROPIC_API_URL,
        headers={"x-api-key": api_key, "anthropic-version": ANTHROPIC_VERSION, "Content-Type": "application/json"},
        event_type_filter="content_block_delta",
        delta_path="delta.text",
        timeout=30.0,
    )

    async def noop_emit(event: ExecutionEvent) -> None:
        pass

    full_text = await stream_execute(config=config, request_body=request_body, node_id=node.id, emit=emit or noop_emit)

    return {"text": {"type": "Text", "value": full_text}}
