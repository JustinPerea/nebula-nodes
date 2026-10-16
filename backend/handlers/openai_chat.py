from __future__ import annotations

from typing import Any, Awaitable, Callable

from models.graph import GraphNode, PortValueDict
from models.events import ExecutionEvent
from execution.stream_runner import StreamConfig, stream_execute
from services.image_input import load_local_image
from execution.missing_credential import MissingCredentialError

OPENAI_CHAT_URL = "https://api.openai.com/v1/chat/completions"

# GPT-6 family (OpenAI model pages, checked 2026-10-16). All three are reasoning
# models on Chat Completions: they take reasoning_effort and Nebula never sends
# them sampler params. Effort "max" is new with this family. GPT-6 Astra and
# GPT-6.1 Sol return HTTP 400 for "none" (6.1 Sol also rejects "minimal").
GPT6_MODELS = frozenset({"gpt-6-astra", "gpt-6.1-sol", "gpt-6-luna"})
GPT6_EFFORTS = {
    "gpt-6-astra": ("low", "medium", "high", "xhigh", "max"),
    "gpt-6.1-sol": ("low", "medium", "high", "xhigh", "max"),
    "gpt-6-luna": ("none", "low", "medium", "high", "xhigh", "max"),
}


async def handle_openai_chat(
    node: GraphNode,
    inputs: dict[str, PortValueDict],
    api_keys: dict[str, str],
    emit: Callable[[ExecutionEvent], Awaitable[None]] | None = None,
) -> dict[str, Any]:
    messages_input = inputs.get("messages")
    if not messages_input or not messages_input.value:
        raise ValueError("Messages input is required for OpenAI chat")

    messages_text = str(messages_input.value)

    api_key = api_keys.get("OPENAI_API_KEY")
    if not api_key:
        raise MissingCredentialError("OPENAI_API_KEY is required")

    content: list[dict[str, Any]] = [{"type": "text", "text": messages_text}]

    images_input = inputs.get("images")
    if images_input and images_input.value:
        image_values = images_input.value if isinstance(images_input.value, list) else [images_input.value]
        for img_val in image_values:
            img_str = str(img_val)
            if img_str.startswith(("http://", "https://", "data:")):
                content.append({"type": "image_url", "image_url": {"url": img_str}})
            else:
                # Local path. load_local_image raises (rather than silently
                # skipping) if the file is missing/unreadable/unsupported, so a
                # misconfigured reference fails the node instead of producing a
                # "success" that quietly analyzed zero of the wired-up images.
                mime_type, b64 = load_local_image(img_str)
                data_uri = f"data:{mime_type};base64,{b64}"
                content.append({"type": "image_url", "image_url": {"url": data_uri}})

    messages = [{"role": "user", "content": content}]

    model = node.params.get("model", "gpt-6.1-sol")
    request_body: dict[str, Any] = {
        "model": model,
        "messages": messages,
        "stream": True,
    }

    max_completion_tokens = node.params.get("max_completion_tokens")
    if max_completion_tokens:
        request_body["max_completion_tokens"] = int(max_completion_tokens)

    # GPT-5.x are reasoning models: they accept reasoning_effort and reject
    # non-default sampler params (temperature/top_p/penalties), so those are
    # only forwarded for legacy gpt-4o/gpt-4.1 models.
    is_gpt5 = model.startswith("gpt-5")
    if model in GPT6_MODELS:
        reasoning_effort = node.params.get("reasoning_effort")
        if reasoning_effort:
            request_body["reasoning_effort"] = _gpt6_effort(model, str(reasoning_effort))
    elif is_gpt5:
        reasoning_effort = node.params.get("reasoning_effort")
        if reasoning_effort == "max":
            # "max" is offered only for GPT-6, but a node switched over from a
            # GPT-6 model can still hold it. OpenAI's gpt-5.5 page lists none,
            # low, medium, high and xhigh, so refuse it before a paid HTTP 400.
            raise ValueError(f"Reasoning effort 'max' isn't available for {model}.")
        if reasoning_effort:
            request_body["reasoning_effort"] = reasoning_effort
    else:
        temperature = node.params.get("temperature")
        if temperature is not None:
            request_body["temperature"] = float(temperature)

        top_p = node.params.get("top_p")
        if top_p is not None:
            request_body["top_p"] = float(top_p)

        frequency_penalty = node.params.get("frequency_penalty")
        if frequency_penalty is not None:
            request_body["frequency_penalty"] = float(frequency_penalty)

        presence_penalty = node.params.get("presence_penalty")
        if presence_penalty is not None:
            request_body["presence_penalty"] = float(presence_penalty)

    response_format = node.params.get("response_format")
    if response_format and response_format != "text":
        request_body["response_format"] = {"type": response_format}

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


def _gpt6_effort(model: str, effort: str) -> str:
    """Return the saved effort if this GPT-6 model accepts it; refuse it otherwise.

    The card hides "none" for GPT-6 Astra and GPT-6.1 Sol, but a node switched
    over from a GPT-5.x model can still hold it. The Inspector then shows it as
    "(unavailable for selected model)". Refusing before the request matches
    that, and matches how the Runway handler treats a saved ratio the new model
    lacks, instead of paying for an HTTP 400 or silently picking another level.
    """
    allowed = GPT6_EFFORTS[model]
    if effort in allowed:
        return effort
    raise ValueError(
        f"Reasoning effort '{effort}' isn't available for {model}. Pick one of: {', '.join(allowed)}."
    )
