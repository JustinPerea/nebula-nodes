from __future__ import annotations

from typing import Any, Awaitable, Callable

from models.graph import GraphNode, PortValueDict
from models.events import ExecutionEvent
from execution.stream_runner import StreamConfig, stream_execute
from services.image_input import load_local_image

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

    caching = bool(node.params.get("prompt_caching"))

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
                # Local path. load_local_image raises (rather than silently
                # skipping) if the file is missing/unreadable/unsupported, so a
                # misconfigured reference fails the node instead of producing a
                # "success" that quietly analyzed zero of the wired-up images.
                media_type, b64_data = load_local_image(img_str)
                content.append({"type": "image", "source": {"type": "base64", "media_type": media_type, "data": b64_data}})

    if caching:
        # Cache breakpoint on the last content block — caches the whole user-turn
        # prefix. Anthropic ignores prefixes under ~1024 tokens, so this is a no-op
        # (no cache-write premium) on short prompts.
        content[-1] = {**content[-1], "cache_control": {"type": "ephemeral"}}

    messages = [{"role": "user", "content": content}]

    model = node.params.get("model", "claude-sonnet-4-6")
    max_tokens = int(node.params.get("max_tokens", 4096))

    request_body: dict[str, Any] = {"model": model, "messages": messages, "max_tokens": max_tokens, "stream": True}

    temperature = node.params.get("temperature")
    if temperature is not None:
        request_body["temperature"] = float(temperature)

    top_p = node.params.get("top_p")
    if top_p is not None and "temperature" not in request_body:
        request_body["top_p"] = float(top_p)

    stop_sequences_raw = node.params.get("stop_sequences")
    if stop_sequences_raw:
        sequences = [s.strip() for s in str(stop_sequences_raw).split(",") if s.strip()]
        if sequences:
            request_body["stop_sequences"] = sequences

    system_prompt = node.params.get("system")
    if system_prompt:
        if caching:
            # Send system as a content-block array so the cache_control breakpoint
            # caches the (often-repeated) system prefix.
            request_body["system"] = [
                {"type": "text", "text": str(system_prompt), "cache_control": {"type": "ephemeral"}}
            ]
        else:
            request_body["system"] = str(system_prompt)

    # Claude Fable/Mythos 5 use always-on adaptive thinking and reject the
    # extended-thinking param; only pre-5 models accept a thinking budget.
    supports_extended_thinking = not model.startswith(("claude-fable", "claude-mythos"))
    if node.params.get("extended_thinking") and supports_extended_thinking:
        budget = int(node.params.get("thinkingBudget", 10000))
        budget = max(1024, budget)
        request_body["thinking"] = {"type": "enabled", "budget_tokens": budget}
        # thinking mode requires temperature=1 (API constraint)
        request_body["temperature"] = 1

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
