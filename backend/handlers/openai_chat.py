from __future__ import annotations

from typing import Any, Awaitable, Callable

from models.graph import GraphNode, PortValueDict
from models.events import ExecutionEvent
from execution.stream_runner import StreamConfig, stream_execute

OPENAI_CHAT_URL = "https://api.openai.com/v1/chat/completions"


async def handle_openai_chat(
    node: GraphNode,
    inputs: dict[str, PortValueDict],
    api_keys: dict[str, str],
    emit: Callable[[ExecutionEvent], Awaitable[None]] | None = None,
) -> dict[str, Any]:
    messages_input = inputs.get("messages")
    if not messages_input or not messages_input.value:
        raise ValueError("Messages input is required for GPT-4o chat")

    messages_text = str(messages_input.value)

    api_key = api_keys.get("OPENAI_API_KEY")
    if not api_key:
        raise ValueError("OPENAI_API_KEY is required")

    content: list[dict[str, Any]] = [{"type": "text", "text": messages_text}]

    images_input = inputs.get("images")
    if images_input and images_input.value:
        image_values = images_input.value if isinstance(images_input.value, list) else [images_input.value]
        for img_val in image_values:
            img_str = str(img_val)
            if img_str.startswith(("http://", "https://", "data:")):
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

    model = node.params.get("model", "gpt-4o")
    request_body: dict[str, Any] = {
        "model": model,
        "messages": messages,
        "stream": True,
    }

    max_tokens = node.params.get("max_tokens")
    if max_tokens:
        request_body["max_tokens"] = int(max_tokens)

    temperature = node.params.get("temperature")
    if temperature is not None:
        request_body["temperature"] = float(temperature)

    config = StreamConfig(
        url=OPENAI_CHAT_URL,
        headers={
            "Authorization": f"Bearer {api_key}",
            "Content-Type": "application/json",
        },
        event_type_filter=None,  # OpenAI sends standard SSE without event type lines
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
