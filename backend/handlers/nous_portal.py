"""Nous Portal handler.

Mirrors the OpenRouter handler but pulls auth from `~/.hermes/auth.json`
instead of an env-supplied API key, and points at whatever `base_url`
Hermes recorded for the user (defaults to the production Nous inference
URL if missing).

The Nous Portal API is OpenAI-compatible: `/v1/chat/completions`, SSE
streaming with `choices[0].delta.content`, and standard multimodal
`image_url` content blocks. So we can reuse `stream_execute` directly.
"""
from __future__ import annotations

import base64
from pathlib import Path
from typing import Any, Awaitable, Callable

from models.graph import GraphNode, PortValueDict
from models.events import ExecutionEvent
from execution.stream_runner import StreamConfig, stream_execute
from services.nous_auth import NousNotAuthenticatedError, load_nous_credential


def _image_to_content_block(value: Any) -> dict[str, Any] | None:
    """Convert an image input value into a `{"type": "image_url", "image_url": {...}}` block.

    Accepts http(s) URLs, data URIs, and local filesystem paths (which we
    base64-encode before passing). Returns None on anything we can't handle.
    """
    s = str(value)
    if s.startswith(("http://", "https://", "data:")):
        return {"type": "image_url", "image_url": {"url": s}}
    p = Path(s)
    if p.exists() and p.is_file():
        b64 = base64.b64encode(p.read_bytes()).decode("ascii")
        suffix = p.suffix.lstrip(".").lower()
        mime = {
            "png": "image/png",
            "jpg": "image/jpeg",
            "jpeg": "image/jpeg",
            "webp": "image/webp",
            "gif": "image/gif",
        }.get(suffix, "image/png")
        return {"type": "image_url", "image_url": {"url": f"data:{mime};base64,{b64}"}}
    return None


async def handle_nous_portal_universal(
    node: GraphNode,
    inputs: dict[str, PortValueDict],
    api_keys: dict[str, str],  # unused — auth lives in ~/.hermes/auth.json
    emit: Callable[[ExecutionEvent], Awaitable[None]] | None = None,
) -> dict[str, Any]:
    try:
        cred = load_nous_credential()
    except NousNotAuthenticatedError as exc:
        raise RuntimeError(str(exc)) from exc

    model = node.params.get("model", "")
    if not model:
        raise ValueError("No model selected — choose one from the Inspector panel")

    messages_input = inputs.get("messages")
    if not messages_input or not messages_input.value:
        raise ValueError("Messages input is required")

    text_part = str(messages_input.value)
    content: list[dict[str, Any]] = [{"type": "text", "text": text_part}]

    images_input = inputs.get("images")
    if images_input and images_input.value:
        values = images_input.value if isinstance(images_input.value, list) else [images_input.value]
        for v in values:
            block = _image_to_content_block(v)
            if block is not None:
                content.append(block)

    request_body: dict[str, Any] = {
        "model": str(model),
        "messages": [{"role": "user", "content": content}],
        "stream": True,
    }

    max_tokens = node.params.get("max_tokens")
    if max_tokens:
        request_body["max_tokens"] = int(max_tokens)

    temperature = node.params.get("temperature")
    if temperature is not None:
        request_body["temperature"] = float(temperature)

    config = StreamConfig(
        url=f"{cred.base_url.rstrip('/')}/chat/completions",
        headers={
            "Authorization": f"Bearer {cred.access_token}",
            "Content-Type": "application/json",
            "X-Title": "Nebula Nodes",
        },
        event_type_filter=None,
        delta_path="choices.0.delta.content",
        timeout=60.0,
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
