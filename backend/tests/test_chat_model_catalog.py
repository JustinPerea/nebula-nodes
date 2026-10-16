"""Request bodies for the chat models added 2026-10-16, and proof that the
models already on the menus still send exactly what they sent before.

Every test mocks the HTTP client; nothing reaches the network. Params are
seeded the way the canvas seeds a new node (every param default from
node_definitions.json), because that is what a real node sends: hidden params
such as temperature still sit in node.params with their defaults.
"""
from __future__ import annotations

import json
from pathlib import Path
from typing import Any
from unittest.mock import AsyncMock, MagicMock, patch

import pytest

from handlers.anthropic_chat import handle_claude_chat
from handlers.google_gemini import handle_gemini_chat
from handlers.openai_chat import handle_openai_chat
from models.graph import GraphNode, PortValueDict

DEFS = json.loads((Path(__file__).resolve().parents[1] / "data" / "node_definitions.json").read_text())
MESSAGES = {"messages": PortValueDict(type="Text", value="Say hi")}


def _defaults(node_id: str) -> dict[str, Any]:
    """Mirror frontend graphStore.buildDefaultParams for a fresh node."""
    return {p["key"]: p["default"] for p in DEFS[node_id]["params"] if "default" in p}


# The defaults a node created before 2026-10-16's default change was saved
# with. Saved graphs keep these values, so they must send what they sent before.
_SAVED_BEFORE = {
    "claude-chat": {"model": "claude-sonnet-4-6", "effort": ""},
    "gpt-4o-chat": {"model": "gpt-5.4"},
    "gemini-chat": {"model": "gemini-3.6-flash", "thinkingLevel": ""},
}


def _saved_defaults(node_id: str) -> dict[str, Any]:
    return {**_defaults(node_id), **_SAVED_BEFORE[node_id]}


def _options(node_id: str, key: str) -> list[dict[str, Any]]:
    return next(p for p in DEFS[node_id]["params"] if p["key"] == key)["options"]


def _param(node_id: str, key: str) -> dict[str, Any]:
    return next(p for p in DEFS[node_id]["params"] if p["key"] == key)


class _FakeStream:
    def __init__(self, lines: list[str]):
        self.status_code = 200
        self._lines = lines

    async def aiter_lines(self):
        for line in self._lines:
            yield line

    async def aiter_text(self):
        yield ""

    async def __aenter__(self):
        return self

    async def __aexit__(self, *args):
        return None


def _anthropic_lines(text: str, with_thinking: bool = False) -> list[str]:
    lines: list[str] = []
    if with_thinking:
        # Claude 5.x always think; the thinking block streams as
        # content_block_delta with delta.thinking (no delta.text).
        lines += [
            "event: content_block_start",
            'data: {"type":"content_block_start","index":0,"content_block":{"type":"thinking","thinking":""}}',
            "",
            "event: content_block_delta",
            'data: {"type":"content_block_delta","index":0,"delta":{"type":"thinking_delta","thinking":"Let me think."}}',
            "",
            "event: content_block_delta",
            'data: {"type":"content_block_delta","index":0,"delta":{"type":"signature_delta","signature":"sig"}}',
            "",
        ]
    lines += [
        "event: content_block_delta",
        "data: " + json.dumps({"type": "content_block_delta", "index": 1, "delta": {"type": "text_delta", "text": text}}),
        "",
        "event: message_stop",
        'data: {"type":"message_stop"}',
        "",
    ]
    return lines


def _openai_lines(text: str) -> list[str]:
    return ["data: " + json.dumps({"choices": [{"delta": {"content": text}}]}), "", "data: [DONE]", ""]


def _gemini_lines(text: str) -> list[str]:
    return ["data: " + json.dumps({"candidates": [{"content": {"parts": [{"text": text}]}}]}), ""]


async def _run(handler, node_id: str, params: dict[str, Any], key: str, lines: list[str]):
    with patch("execution.stream_runner.httpx.AsyncClient") as client_cls:
        client = AsyncMock()
        client.stream = MagicMock(return_value=_FakeStream(lines))
        client.__aenter__ = AsyncMock(return_value=client)
        client.__aexit__ = AsyncMock(return_value=False)
        client_cls.return_value = client
        result = await handler(GraphNode(id="n1", definitionId=node_id, params=params), MESSAGES, {key: "test-key"})
    call = client.stream.call_args
    return result, call.args[1], call.kwargs["json"]


def _claude(params):
    return _run(handle_claude_chat, "claude-chat", params, "ANTHROPIC_API_KEY", _anthropic_lines("hi", with_thinking=True))


def _openai(params):
    return _run(handle_openai_chat, "gpt-4o-chat", params, "OPENAI_API_KEY", _openai_lines("hi"))


def _gemini(params):
    return _run(handle_gemini_chat, "gemini-chat", params, "GOOGLE_API_KEY", _gemini_lines("hi"))


USER_TURN_CLAUDE = [{"role": "user", "content": [{"type": "text", "text": "Say hi"}]}]
USER_TURN_OPENAI = [{"role": "user", "content": [{"type": "text", "text": "Say hi"}]}]
USER_TURN_GEMINI = [{"role": "user", "parts": [{"text": "Say hi"}]}]


# --------------------------------------------------------------------------
# Menus and defaults
# --------------------------------------------------------------------------

def test_claude_menu_lists_new_models_first_and_keeps_every_old_value():
    values = [o["value"] for o in _options("claude-chat", "model")]
    assert values == [
        "claude-fable-5-1", "claude-opus-5-5", "claude-sonnet-5-5", "claude-haiku-5-5",
        "claude-fable-5", "claude-opus-4-8", "claude-sonnet-4-6", "claude-haiku-4-5-20251001",
        "claude-opus-4-7", "claude-opus-4-6",
    ]
    labels = {o["value"]: o["label"] for o in _options("claude-chat", "model")}
    assert labels["claude-fable-5-1"] == "Claude Fable 5.1 (flagship)"
    assert labels["claude-opus-5-5"] == "Claude Opus 5.5"
    assert labels["claude-sonnet-5-5"] == "Claude Sonnet 5.5"
    assert labels["claude-haiku-5-5"] == "Claude Haiku 5.5"
    assert labels["claude-fable-5"] == "Claude Fable 5"
    assert _param("claude-chat", "model")["default"] == "claude-opus-5-5"


def test_openai_menu_lists_gpt6_first_with_retirement_notes():
    options = _options("gpt-4o-chat", "model")
    values = [o["value"] for o in options]
    assert values == [
        "gpt-6-astra", "gpt-6.1-sol", "gpt-6-luna", "gpt-5.5", "gpt-5.4", "gpt-5.4-mini", "gpt-5.4-nano",
        "gpt-4o", "gpt-4o-mini", "gpt-4.1", "gpt-4.1-mini", "gpt-4.1-nano",
    ]
    labels = {o["value"]: o["label"] for o in options}
    assert labels["gpt-6-astra"] == "GPT-6 Astra (flagship)"
    assert labels["gpt-6.1-sol"] == "GPT-6.1 Sol"
    assert labels["gpt-6-luna"] == "GPT-6 Luna"
    assert labels["gpt-4.1-nano"].endswith("retiring 2026-10-23)")
    for value in ("gpt-4o", "gpt-4o-mini", "gpt-4.1", "gpt-4.1-mini"):
        assert labels[value].endswith("retiring 2027-01-14)")
    assert labels["gpt-5.4-nano"].endswith("(retiring 2027-04-01)")
    assert _param("gpt-4o-chat", "model")["default"] == "gpt-6.1-sol"


def test_openai_effort_options_follow_each_model():
    effort = _param("gpt-4o-chat", "reasoning_effort")
    assert {"gpt-6-astra", "gpt-6.1-sol", "gpt-6-luna"} <= set(effort["visibleWhen"]["model"])
    by_value = {o["value"]: o for o in effort["options"]}
    none_models = set(by_value["none"]["visibleWhen"]["model"])
    assert "gpt-6-astra" not in none_models and "gpt-6.1-sol" not in none_models
    assert {"gpt-6-luna", "gpt-5.5", "gpt-5.4", "gpt-5.4-mini", "gpt-5.4-nano"} == none_models
    assert set(by_value["max"]["visibleWhen"]["model"]) == {"gpt-6-astra", "gpt-6.1-sol", "gpt-6-luna"}
    assert effort["default"] == "medium"


def test_gemini_menu_lists_new_models_first():
    options = _options("gemini-chat", "model")
    values = [o["value"] for o in options]
    assert values[:5] == ["gemini-4-argon", "gemini-3.8-flash", "gemini-3.6-flash", "gemini-3.5-flash-lite", "gemini-3.5-flash"]
    assert {"gemini-3.1-pro-preview", "gemini-3-flash-preview", "gemini-3.1-flash-lite",
            "gemini-2.5-pro", "gemini-2.5-flash", "gemini-2.5-flash-lite"} <= set(values)
    labels = {o["value"]: o["label"] for o in options}
    assert labels["gemini-4-argon"] == "Gemini 4 Argon"
    assert labels["gemini-3.5-flash-lite"] == "Gemini 3.5 Flash-Lite"
    assert "deprecated" in labels["gemini-3.5-flash"]
    assert labels["gemini-3.1-flash-lite"].endswith("(retiring 2027-05-07)")
    assert _param("gemini-chat", "model")["default"] == "gemini-4-argon"


def test_gemini_minimal_hidden_for_argon_and_38_flash():
    level = _param("gemini-chat", "thinkingLevel")
    assert {"gemini-4-argon", "gemini-3.8-flash", "gemini-3.6-flash", "gemini-3.5-flash-lite"} <= set(level["visibleWhen"]["model"])
    minimal = next(o for o in level["options"] if o["value"] == "minimal")
    assert "gemini-4-argon" not in minimal["visibleWhen"]["model"]
    assert "gemini-3.8-flash" not in minimal["visibleWhen"]["model"]
    # Google's "Controlling thinking" table: gemini-3.1-pro-preview takes low, medium, high.
    assert "gemini-3.1-pro-preview" not in minimal["visibleWhen"]["model"]
    for key in ("temperature", "top_p", "top_k"):
        visible = set(_param("gemini-chat", key)["visibleWhen"]["model"])
        assert not visible & {"gemini-4-argon", "gemini-3.8-flash", "gemini-3.6-flash", "gemini-3.5-flash-lite"}
        assert "gemini-2.5-pro" in visible


# --------------------------------------------------------------------------
# Claude
# --------------------------------------------------------------------------

@pytest.mark.asyncio
@pytest.mark.parametrize("model", ["claude-fable-5-1", "claude-opus-5-5", "claude-sonnet-5-5", "claude-haiku-5-5"])
async def test_claude_5_body_drops_sampling_and_thinking_budget(model):
    params = {**_saved_defaults("claude-chat"), "model": model, "temperature": 0.4, "top_p": 0.5,
              "extended_thinking": True, "thinkingBudget": 20000}
    result, url, body = await _claude(params)
    assert url == "https://api.anthropic.com/v1/messages"
    assert body == {"model": model, "messages": USER_TURN_CLAUDE, "max_tokens": 4096, "stream": True}
    # Thinking deltas are skipped; only the answer text comes back.
    assert result["text"]["value"] == "hi"


@pytest.mark.asyncio
async def test_claude_5_effort_goes_in_output_config():
    params = {**_defaults("claude-chat"), "model": "claude-opus-5-5", "effort": "xhigh", "max_tokens": 64000}
    _, _, body = await _claude(params)
    assert body == {"model": "claude-opus-5-5", "messages": USER_TURN_CLAUDE, "max_tokens": 64000,
                    "stream": True, "output_config": {"effort": "xhigh"}}


@pytest.mark.asyncio
async def test_claude_5_max_tokens_capped_at_sync_limit():
    params = {**_defaults("claude-chat"), "model": "claude-sonnet-5-5", "max_tokens": 200000}
    _, _, body = await _claude(params)
    assert body["max_tokens"] == 128000


@pytest.mark.asyncio
async def test_claude_5_unknown_effort_refused_before_request():
    params = {**_defaults("claude-chat"), "model": "claude-haiku-5-5", "effort": "extreme"}
    with pytest.raises(ValueError, match="Effort"):
        await _claude(params)


@pytest.mark.asyncio
@pytest.mark.parametrize("with_effort_key", [False, True])
async def test_claude_existing_model_body_unchanged(with_effort_key):
    params = _saved_defaults("claude-chat")
    if with_effort_key:
        params["effort"] = "max"  # a stale effort left from a 5.x model is ignored
    else:
        params.pop("effort")  # graphs saved before this change have no effort key
    _, _, body = await _claude(params)
    assert body == {"model": "claude-sonnet-4-6", "messages": USER_TURN_CLAUDE, "max_tokens": 4096,
                    "stream": True, "temperature": 1.0}


@pytest.mark.asyncio
async def test_claude_existing_model_thinking_body_unchanged():
    params = {**_saved_defaults("claude-chat"), "model": "claude-opus-4-6", "extended_thinking": True,
              "thinkingBudget": 2048, "temperature": 0.2, "max_tokens": 200000}
    _, _, body = await _claude(params)
    assert body == {"model": "claude-opus-4-6", "messages": USER_TURN_CLAUDE, "max_tokens": 200000,
                    "stream": True, "temperature": 1, "thinking": {"type": "enabled", "budget_tokens": 2048}}


@pytest.mark.asyncio
async def test_claude_fable_5_body_unchanged():
    params = {**_defaults("claude-chat"), "model": "claude-fable-5", "extended_thinking": True, "temperature": 0.5}
    _, _, body = await _claude(params)
    assert body == {"model": "claude-fable-5", "messages": USER_TURN_CLAUDE, "max_tokens": 4096,
                    "stream": True, "temperature": 0.5}


# --------------------------------------------------------------------------
# OpenAI
# --------------------------------------------------------------------------

@pytest.mark.asyncio
@pytest.mark.parametrize("model", ["gpt-6-astra", "gpt-6.1-sol", "gpt-6-luna"])
async def test_gpt6_body_sends_effort_and_no_samplers(model):
    params = {**_defaults("gpt-4o-chat"), "model": model, "temperature": 0.3, "top_p": 0.9,
              "frequency_penalty": 0.5, "presence_penalty": 0.5}
    result, url, body = await _openai(params)
    assert url == "https://api.openai.com/v1/chat/completions"
    assert body == {"model": model, "messages": USER_TURN_OPENAI, "stream": True,
                    "max_completion_tokens": 4096, "reasoning_effort": "medium"}
    assert result["text"]["value"] == "hi"


@pytest.mark.asyncio
@pytest.mark.parametrize("model", ["gpt-6-astra", "gpt-6.1-sol", "gpt-6-luna"])
async def test_gpt6_accepts_max_effort(model):
    _, _, body = await _openai({**_defaults("gpt-4o-chat"), "model": model, "reasoning_effort": "max"})
    assert body["reasoning_effort"] == "max"


@pytest.mark.asyncio
@pytest.mark.parametrize("model", ["gpt-6-astra", "gpt-6.1-sol"])
async def test_gpt6_none_effort_refused_where_rejected(model):
    with pytest.raises(ValueError, match="isn't available"):
        await _openai({**_defaults("gpt-4o-chat"), "model": model, "reasoning_effort": "none"})


@pytest.mark.asyncio
async def test_gpt6_luna_accepts_none_effort():
    _, _, body = await _openai({**_defaults("gpt-4o-chat"), "model": "gpt-6-luna", "reasoning_effort": "none"})
    assert body["reasoning_effort"] == "none"


@pytest.mark.asyncio
@pytest.mark.parametrize("model", ["gpt-5.5", "gpt-5.4", "gpt-5.4-mini", "gpt-5.4-nano"])
async def test_gpt5_max_effort_refused_before_request(model):
    with pytest.raises(ValueError, match="Reasoning effort 'max' isn't available for " + model):
        await _openai({**_defaults("gpt-4o-chat"), "model": model, "reasoning_effort": "max"})


@pytest.mark.asyncio
@pytest.mark.parametrize("effort", ["none", "low", "medium", "high", "xhigh"])
async def test_gpt5_existing_efforts_still_forwarded(effort):
    _, _, body = await _openai({**_defaults("gpt-4o-chat"), "model": "gpt-5.5", "reasoning_effort": effort})
    assert body["reasoning_effort"] == effort


@pytest.mark.asyncio
async def test_gpt5_body_unchanged():
    params = {**_saved_defaults("gpt-4o-chat"), "reasoning_effort": "none"}
    _, _, body = await _openai(params)
    assert body == {"model": "gpt-5.4", "messages": USER_TURN_OPENAI, "stream": True,
                    "max_completion_tokens": 4096, "reasoning_effort": "none"}


@pytest.mark.asyncio
async def test_gpt4o_body_unchanged():
    params = {**_defaults("gpt-4o-chat"), "model": "gpt-4o", "top_p": 0.8, "response_format": "json_object"}
    _, _, body = await _openai(params)
    assert body == {"model": "gpt-4o", "messages": USER_TURN_OPENAI, "stream": True,
                    "max_completion_tokens": 4096, "temperature": 1.0, "top_p": 0.8,
                    "frequency_penalty": 0.0, "presence_penalty": 0.0,
                    "response_format": {"type": "json_object"}}


# --------------------------------------------------------------------------
# Gemini
# --------------------------------------------------------------------------

def _gemini_url(model: str) -> str:
    return f"https://generativelanguage.googleapis.com/v1beta/models/{model}:streamGenerateContent?alt=sse"


@pytest.mark.asyncio
@pytest.mark.parametrize("model", ["gemini-4-argon", "gemini-3.8-flash", "gemini-3.6-flash", "gemini-3.5-flash-lite"])
async def test_new_gemini_body_drops_temperature(model):
    params = {**_defaults("gemini-chat"), "model": model, "temperature": 0.2, "thinkingLevel": "high"}
    result, url, body = await _gemini(params)
    assert url == _gemini_url(model)
    assert body == {"contents": USER_TURN_GEMINI,
                    "generationConfig": {"maxOutputTokens": 8192, "thinkingConfig": {"thinkingLevel": "high"}}}
    assert result["text"]["value"] == "hi"


@pytest.mark.asyncio
async def test_gemini_node_saved_on_36_flash_body_unchanged():
    _, url, body = await _gemini(_saved_defaults("gemini-chat"))
    assert url == _gemini_url("gemini-3.6-flash")
    assert body == {"contents": USER_TURN_GEMINI, "generationConfig": {"maxOutputTokens": 8192}}


@pytest.mark.asyncio
@pytest.mark.parametrize("model", ["gemini-4-argon", "gemini-3.8-flash"])
async def test_minimal_thinking_refused_where_rejected(model):
    with pytest.raises(ValueError, match="isn't available"):
        await _gemini({**_defaults("gemini-chat"), "model": model, "thinkingLevel": "minimal"})


@pytest.mark.asyncio
@pytest.mark.parametrize("model", ["gemini-3.6-flash", "gemini-3.5-flash-lite"])
async def test_minimal_thinking_kept_where_supported(model):
    _, _, body = await _gemini({**_defaults("gemini-chat"), "model": model, "thinkingLevel": "minimal"})
    assert body["generationConfig"]["thinkingConfig"] == {"thinkingLevel": "minimal"}


@pytest.mark.asyncio
async def test_argon_max_output_capped_at_sync_limit():
    _, _, body = await _gemini({**_defaults("gemini-chat"), "model": "gemini-4-argon", "max_tokens": 200000})
    assert body["generationConfig"]["maxOutputTokens"] == 65536


@pytest.mark.asyncio
async def test_gemini_35_flash_body_unchanged():
    params = {**_defaults("gemini-chat"), "model": "gemini-3.5-flash", "thinkingLevel": "minimal",
              "system": "Be brief", "response_format": "application/json"}
    _, url, body = await _gemini(params)
    assert url == _gemini_url("gemini-3.5-flash")
    assert body == {"contents": USER_TURN_GEMINI,
                    "generationConfig": {"temperature": 1.0, "maxOutputTokens": 8192,
                                         "responseMimeType": "application/json",
                                         "thinkingConfig": {"thinkingLevel": "minimal"}},
                    "systemInstruction": {"parts": [{"text": "Be brief"}]}}


@pytest.mark.asyncio
async def test_gemini_25_body_unchanged():
    params = {**_defaults("gemini-chat"), "model": "gemini-2.5-pro", "thinkingBudget": 1024, "temperature": 0.7,
              "max_tokens": 100000}
    _, _, body = await _gemini(params)
    assert body == {"contents": USER_TURN_GEMINI,
                    "generationConfig": {"temperature": 0.7, "maxOutputTokens": 100000,
                                         "thinkingConfig": {"thinkingBudget": 1024}}}
