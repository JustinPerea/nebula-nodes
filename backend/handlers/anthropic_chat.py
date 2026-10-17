from __future__ import annotations

from typing import Any, Awaitable, Callable

from models.graph import GraphNode, PortValueDict
from models.events import ExecutionEvent
from execution.stream_runner import StreamConfig, stream_execute
from services.image_input import load_local_image
from execution.missing_credential import MissingCredentialError
from services.param_defaults import param_default

ANTHROPIC_API_URL = "https://api.anthropic.com/v1/messages"
ANTHROPIC_VERSION = "2023-06-01"

# Claude Fable 5.1 and the 5.5 generation always think. Per Anthropic's model
# pages (checked 2026-10-16) they return HTTP 400 for a manual
# thinking.budget_tokens and for non-default temperature/top_p/top_k, and take
# an effort level as output_config.effort instead. Their synchronous output cap
# is 128K tokens. Every other model keeps the request it sent before.
ADAPTIVE_EFFORT_MODELS = frozenset({
    "claude-fable-5-1",
    "claude-opus-5-5",
    "claude-sonnet-5-5",
    "claude-haiku-5-5",
})
ADAPTIVE_MAX_OUTPUT_TOKENS = 128_000
EFFORT_LEVELS = ("low", "medium", "high", "xhigh", "max")

# Claude Opus 4.7 and 4.8 take adaptive thinking only, and it is off until the
# request sets thinking: {"type": "adaptive"}. They return HTTP 400 for
# thinking.type "enabled" (a budget_tokens budget) and for non-default
# temperature/top_p/top_k, and they support all five effort levels (API default
# high). Sources, fetched 2026-10-16: platform.claude.com/docs/en/build-with-claude/
# thinking-troubleshooting (per-model table), /thinking ("Thinking and sampling
# parameters"), /effort (supportedModels, effort levels) and /extended-thinking.
OPTIONAL_ADAPTIVE_MODELS = frozenset({"claude-opus-4-8", "claude-opus-4-7"})

# Claude Opus 4.6 and Sonnet 4.6 moved to Effort on 2026-10-16 (Justin's
# answer, item 5). Thinking is off on them until the request sets
# thinking: {"type": "adaptive"}; enabled + budget_tokens still works but is
# deprecated (thinking-troubleshooting per-model table). They take effort with
# or without thinking, at low/medium/high/max but not xhigh (/effort, fetched
# 2026-10-16). Unlike 4.7/4.8 they still accept sampling params; while thinking
# is on, temperature is forced to 1 as it was for budget thinking.
SAMPLING_ADAPTIVE_MODELS = frozenset({"claude-opus-4-6", "claude-sonnet-4-6"})
EFFORT_MODELS = ADAPTIVE_EFFORT_MODELS | OPTIONAL_ADAPTIVE_MODELS | SAMPLING_ADAPTIVE_MODELS
MODEL_EFFORT_LEVELS = {
    **{model: EFFORT_LEVELS for model in ADAPTIVE_EFFORT_MODELS | OPTIONAL_ADAPTIVE_MODELS},
    **{model: ("low", "medium", "high", "max") for model in SAMPLING_ADAPTIVE_MODELS},
}

# Max Tokens on every node saved before 2026-10-16 (main's only default). On
# Opus 4.6-4.8 and Sonnet 4.6 with Extended Thinking on, the toggle now sends
# adaptive thinking with no budget, and "thinking tokens count toward
# max_tokens, so a long thinking pass can consume the budget before the text
# response completes" (Anthropic, thinking-troubleshooting, fetched
# 2026-10-16). A saved 4096 there is read as the old untouched default and
# sent as the model's current one (64,000), the same move the Inspector makes
# on a model switch. A 4096 typed on purpose can't be told apart; see
# implementation-notes.md.
LEGACY_MAX_TOKENS = 4096


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
        raise MissingCredentialError("ANTHROPIC_API_KEY is required")

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

    model = node.params.get("model", "claude-opus-5-5")
    # A node an agent made without max_tokens gets its model's default: 64K for
    # the 5.x models and Opus 4.6-4.8 / Sonnet 4.6, 4096 for Fable 5 and Haiku 4.5.
    raw_max_tokens = node.params.get("max_tokens")
    if raw_max_tokens is None or raw_max_tokens == "":
        raw_max_tokens = param_default("claude-chat", "max_tokens", {**node.params, "model": model}) or 4096
    max_tokens = int(raw_max_tokens)
    adaptive = model in ADAPTIVE_EFFORT_MODELS
    optional_adaptive = model in OPTIONAL_ADAPTIVE_MODELS
    sampling_adaptive = model in SAMPLING_ADAPTIVE_MODELS
    if adaptive:
        max_tokens = min(max_tokens, ADAPTIVE_MAX_OUTPUT_TOKENS)
    if (
        node.params.get("extended_thinking") and (optional_adaptive or sampling_adaptive)
        and max_tokens == LEGACY_MAX_TOKENS
    ):
        max_tokens = int(param_default("claude-chat", "max_tokens", {**node.params, "model": model}) or max_tokens)

    request_body: dict[str, Any] = {"model": model, "messages": messages, "max_tokens": max_tokens, "stream": True}

    if not adaptive and not optional_adaptive:
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

    # Claude Fable/Mythos 5 and the ADAPTIVE_EFFORT_MODELS use always-on
    # thinking and reject the extended-thinking param; only older models accept
    # a thinking budget. A stale extended_thinking=True left from another model
    # is dropped here rather than sent.
    supports_extended_thinking = (
        not adaptive and not optional_adaptive and not sampling_adaptive
        and not model.startswith(("claude-fable", "claude-mythos"))
    )
    if node.params.get("extended_thinking") and (optional_adaptive or sampling_adaptive):
        # Opus 4.6-4.8 / Sonnet 4.6: the toggle turns on adaptive thinking. A
        # saved thinkingBudget is not sent; Effort controls the depth instead.
        request_body["thinking"] = {"type": "adaptive"}
        if sampling_adaptive:
            # Same rule the 4.6 models had with budget thinking: temperature 1.
            request_body["temperature"] = 1
            # The handler never sends top_p next to temperature, and with
            # thinking on "top_p is allowed at values between 0.95 and 1"
            # (Anthropic, thinking page, sampling section, fetched 2026-10-16).
            request_body.pop("top_p", None)
    elif node.params.get("extended_thinking") and supports_extended_thinking:
        budget = int(node.params.get("thinkingBudget", 10000))
        budget = max(1024, budget)
        request_body["thinking"] = {"type": "enabled", "budget_tokens": budget}
        # thinking mode requires temperature=1 (API constraint)
        request_body["temperature"] = 1
        request_body.pop("top_p", None)  # see the adaptive branch above

    if model in EFFORT_MODELS:
        effort = str(node.params.get("effort") or "").strip().lower()
        if effort:
            levels = MODEL_EFFORT_LEVELS[model]
            if effort not in levels:
                raise ValueError(f"Effort must be one of {', '.join(levels)} for {model}, got {effort!r}")
            request_body["output_config"] = {"effort": effort}

    stop: dict[str, str] = {}
    config = StreamConfig(
        url=ANTHROPIC_API_URL,
        headers={"x-api-key": api_key, "anthropic-version": ANTHROPIC_VERSION, "Content-Type": "application/json"},
        event_type_filter="content_block_delta",
        delta_path="delta.text",
        timeout=30.0,
        on_event=_record_stop_reason(stop),
    )

    async def noop_emit(event: ExecutionEvent) -> None:
        pass

    full_text = await stream_execute(config=config, request_body=request_body, node_id=node.id, emit=emit or noop_emit)

    if stop.get("reason") == "max_tokens" and not full_text.strip():
        # Thinking used the whole Max Tokens and no answer came back. Before
        # 2026-10-16 this returned an empty "success".
        raise RuntimeError(
            f"Claude ran out of Max Tokens ({max_tokens:,}) before it wrote an answer "
            "(stop_reason max_tokens). Raise Max Tokens or lower Effort."
        )

    return {"text": {"type": "Text", "value": full_text}}


def _record_stop_reason(stop: dict[str, str]) -> Callable[[dict[str, Any]], None]:
    """Keep the stop_reason from the stream's message_delta event:
    {"type": "message_delta", "delta": {"stop_reason": "end_turn", ...}}."""
    def record(data: dict[str, Any]) -> None:
        if data.get("type") == "message_delta":
            reason = (data.get("delta") or {}).get("stop_reason")
            if reason:
                stop["reason"] = str(reason)
    return record
