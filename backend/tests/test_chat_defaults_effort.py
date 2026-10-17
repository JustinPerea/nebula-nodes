"""New chat-node defaults (2026-10-16) and Claude Opus 4.7/4.8 on Effort.

- claude-chat defaults to Claude Opus 5.5 with Effort "medium".
- gpt-4o-chat defaults to GPT-6.1 Sol with reasoning effort "medium".
- gemini-chat defaults to Gemini 4 Argon with Thinking Level "medium".
- Claude Opus 4.7 and 4.8 take Effort, no thinking budget and no sampling
  params; the Extended Thinking toggle turns on adaptive thinking there.
- Justin's answers 2026-10-16, items 2-6: Opus 4.6 / Sonnet 4.6 move to Effort
  (no X-High) and adaptive thinking but keep sampling; Opus 4.6-4.8 and Sonnet
  4.6 default to 64,000 Max Tokens; a 2.5 Gemini node sends a Thinking Level
  only when it isn't the default; deprecated Gemini 3.5 Flash sends no sampling.

A default only reaches new nodes (the canvas writes every default into a new
node's params). Saved graphs keep their own values; the bodies they send are
pinned in test_chat_model_catalog.py. Every test mocks the HTTP client.
"""
from __future__ import annotations

import re
from pathlib import Path
from typing import Any

import pytest

from handlers.anthropic_chat import EFFORT_LEVELS, EFFORT_MODELS, MODEL_EFFORT_LEVELS
from handlers.google_gemini import GEMINI_CHAT_NO_SAMPLING, GEMINI_CHAT_THINKING_LEVELS
from handlers.openai_chat import REASONING_EFFORTS
from tests.test_chat_model_catalog import (
    USER_TURN_CLAUDE,
    USER_TURN_GEMINI,
    USER_TURN_OPENAI,
    _claude,
    _defaults,
    _fresh,
    _gemini,
    _gemini_url,
    _openai,
    _param,
    _saved_defaults,
)

ROOT = Path(__file__).resolve().parents[2]
FRONTEND_DEFS = (ROOT / "frontend" / "src" / "constants" / "nodeDefinitions.ts").read_text()
OPUS_47_48 = ["claude-opus-4-8", "claude-opus-4-7"]
CLAUDE_46 = ["claude-opus-4-6", "claude-sonnet-4-6"]
CLAUDE_OLDER = ["claude-fable-5", "claude-haiku-4-5-20251001"]


def _visible(option: dict[str, Any], model: str) -> bool:
    return "visibleWhen" not in option or model in option["visibleWhen"]["model"]


def _frontend_block(node_id: str) -> str:
    start = FRONTEND_DEFS.index(f"\n  '{node_id}': {{\n")
    end = FRONTEND_DEFS.index("\n  },\n", start)
    return FRONTEND_DEFS[start:end]


def _frontend_param(node_id: str, key: str) -> str:
    block = _frontend_block(node_id)
    start = block.index(f"key: '{key}',")
    end = block.find("\n      },", start)
    return block[start:end]


# --------------------------------------------------------------------------
# Defaults, in both definition files
# --------------------------------------------------------------------------

@pytest.mark.parametrize(("node_id", "model", "key", "level"), [
    ("claude-chat", "claude-opus-5-5", "effort", "medium"),
    ("gpt-4o-chat", "gpt-6.1-sol", "reasoning_effort", "medium"),
    ("gemini-chat", "gemini-4-argon", "thinkingLevel", "medium"),
])
def test_new_defaults_in_both_definition_files(node_id, model, key, level):
    assert _param(node_id, "model")["default"] == model
    assert _param(node_id, key)["default"] == level
    assert f"default: '{model}'," in _frontend_param(node_id, "model")
    assert f"default: '{level}'," in _frontend_param(node_id, key)


def test_default_levels_are_offered_for_the_default_models():
    # Each default level is a visible option on the card for the default model,
    # and the param itself is visible for that model.
    for node_id, model, key in [("claude-chat", "claude-opus-5-5", "effort"),
                                ("gpt-4o-chat", "gpt-6.1-sol", "reasoning_effort"),
                                ("gemini-chat", "gemini-4-argon", "thinkingLevel")]:
        param = _param(node_id, key)
        assert model in param["visibleWhen"]["model"]
        option = next(o for o in param["options"] if o["value"] == param["default"])
        assert _visible(option, model)


def test_default_levels_are_ones_the_handlers_accept():
    # Anthropic effort page: Opus 5.5 supports all five levels; medium is its default.
    assert "claude-opus-5-5" in EFFORT_MODELS and "medium" in EFFORT_LEVELS
    # OpenAI gpt-6.1-sol page: low, medium (default), high, xhigh, max; no none/minimal.
    assert "medium" in REASONING_EFFORTS["gpt-6.1-sol"]
    assert "none" not in REASONING_EFFORTS["gpt-6.1-sol"] and "minimal" not in REASONING_EFFORTS["gpt-6.1-sol"]
    # Google thinking table: gemini-4-argon low, medium, high (default medium).
    assert GEMINI_CHAT_THINKING_LEVELS["gemini-4-argon"] == ("low", "medium", "high")


@pytest.mark.asyncio
async def test_fresh_claude_node_sends_opus_55_at_medium():
    _, url, body = await _claude(_fresh("claude-chat", "claude-opus-5-5"))
    assert url == "https://api.anthropic.com/v1/messages"
    assert body == {"model": "claude-opus-5-5", "messages": USER_TURN_CLAUDE, "max_tokens": 64000,
                    "stream": True, "output_config": {"effort": "medium"}}


@pytest.mark.asyncio
async def test_fresh_openai_node_sends_gpt_61_sol_at_medium():
    _, url, body = await _openai(_fresh("gpt-4o-chat", "gpt-6.1-sol"))
    assert url == "https://api.openai.com/v1/chat/completions"
    assert body == {"model": "gpt-6.1-sol", "messages": USER_TURN_OPENAI, "stream": True,
                    "max_completion_tokens": 25000, "reasoning_effort": "medium"}


@pytest.mark.asyncio
async def test_fresh_gemini_node_sends_argon_at_medium():
    _, url, body = await _gemini(_fresh("gemini-chat", "gemini-4-argon"))
    assert url == _gemini_url("gemini-4-argon")
    assert body["contents"] == USER_TURN_GEMINI
    assert body["generationConfig"]["maxOutputTokens"] == 65536
    assert body["generationConfig"]["thinkingConfig"] == {"thinkingLevel": "medium"}
    assert "temperature" not in body["generationConfig"]


@pytest.mark.asyncio
async def test_handler_fallbacks_match_the_new_defaults():
    # A node an agent created without a model param.
    _, _, body = await _claude({})
    assert body["model"] == "claude-opus-5-5"
    # No effort key: nothing sent, which Anthropic documents as identical to medium on Opus 5.5.
    assert "output_config" not in body
    _, _, body = await _openai({})
    assert body["model"] == "gpt-6.1-sol" and "reasoning_effort" not in body
    _, url, body = await _gemini({})
    assert url == _gemini_url("gemini-4-argon") and "generationConfig" not in body


# --------------------------------------------------------------------------
# A new node switched to an older model doesn't send the new defaults
# --------------------------------------------------------------------------

@pytest.mark.asyncio
@pytest.mark.parametrize("model", CLAUDE_OLDER)
async def test_new_claude_node_on_older_model_sends_no_effort(model):
    _, _, new_body = await _claude(_fresh("claude-chat", model))
    _, _, saved_body = await _claude({**_saved_defaults("claude-chat"), "model": model})
    assert "output_config" not in new_body
    assert new_body == saved_body


@pytest.mark.asyncio
@pytest.mark.parametrize("model", ["gpt-5.5", "gpt-5.4", "gpt-4o", "gpt-4.1-nano"])
async def test_new_openai_node_on_older_model_matches_a_saved_node(model):
    _, _, new_body = await _openai(_fresh("gpt-4o-chat", model))
    _, _, saved_body = await _openai({**_saved_defaults("gpt-4o-chat"), "model": model})
    assert new_body == saved_body


@pytest.mark.asyncio
@pytest.mark.parametrize("model", ["gemini-2.5-pro", "gemini-2.5-flash", "gemini-2.5-flash-lite"])
async def test_gemini_25_sends_the_budget_not_a_leftover_level(model):
    # A new node starts with thinkingLevel "medium"; the 2.5 card hides it and
    # shows Thinking Budget, so a set budget is what goes out.
    _, _, body = await _gemini({**_fresh("gemini-chat", model), "thinkingBudget": 2048})
    assert body["generationConfig"]["thinkingConfig"] == {"thinkingBudget": 2048}
    _, _, body = await _gemini({**_saved_defaults("gemini-chat"), "model": model,
                                "thinkingLevel": "high", "thinkingBudget": 0})
    assert body["generationConfig"]["thinkingConfig"] == {"thinkingBudget": 0}


@pytest.mark.asyncio
@pytest.mark.parametrize("model", ["gemini-2.5-pro", "gemini-2.5-flash", "gemini-2.5-flash-lite"])
@pytest.mark.parametrize("level", ["low", "high"])
async def test_gemini_25_level_only_saved_node_is_unchanged(model, level):
    # Without a budget, a saved 2.5 node with a non-default level keeps sending
    # it, byte for byte what 30109694 sent.
    _, _, body = await _gemini({**_saved_defaults("gemini-chat"), "model": model, "thinkingLevel": level})
    assert body["generationConfig"]["thinkingConfig"] == {"thinkingLevel": level}


@pytest.mark.asyncio
@pytest.mark.parametrize("model", ["gemini-2.5-pro", "gemini-2.5-flash", "gemini-2.5-flash-lite"])
async def test_gemini_25_default_level_not_sent(model):
    # Justin's item 2 (2026-10-16): the 2.5 card hides Thinking Level, so the
    # default "medium" a new node carries is not a choice. Sending it turned
    # thinking on for 2.5 Flash-Lite, which doesn't think by default.
    assert _param("gemini-chat", "thinkingLevel")["default"] == "medium"
    _, _, body = await _gemini(_fresh("gemini-chat", model))
    assert body == {"contents": USER_TURN_GEMINI,
                    "generationConfig": {"temperature": 1.0, "maxOutputTokens": 8192}}
    # A saved 2.5 node holding exactly the default level now sends none either.
    _, _, body = await _gemini({**_saved_defaults("gemini-chat"), "model": model, "thinkingLevel": "medium"})
    assert "thinkingConfig" not in body["generationConfig"]


@pytest.mark.asyncio
async def test_gemini_3_still_sends_the_default_level():
    # The 2.5 rule doesn't touch models whose card shows Thinking Level.
    _, _, body = await _gemini(_fresh("gemini-chat", "gemini-3.6-flash"))
    assert body["generationConfig"]["thinkingConfig"] == {"thinkingLevel": "medium"}


def test_gemini_35_flash_hides_and_drops_sampling():
    # Justin's item 6 (2026-10-16): Google routes gemini-3.5-flash to 3.6 Flash,
    # which ignores temperature, top_p and top_k.
    assert "gemini-3.5-flash" in GEMINI_CHAT_NO_SAMPLING
    for key in ("temperature", "top_p", "top_k"):
        assert "gemini-3.5-flash" not in _param("gemini-chat", key)["visibleWhen"]["model"], key
        assert "'gemini-3.5-flash'" not in _frontend_param("gemini-chat", key), key
    assert "gemini-3.5-flash" in _param("gemini-chat", "thinkingLevel")["visibleWhen"]["model"]


@pytest.mark.asyncio
async def test_gemini_35_flash_new_node_sends_no_sampling():
    _, url, body = await _gemini({**_fresh("gemini-chat", "gemini-3.5-flash"), "temperature": 0.3})
    assert url == _gemini_url("gemini-3.5-flash")
    assert body == {"contents": USER_TURN_GEMINI,
                    "generationConfig": {"maxOutputTokens": 8192, "thinkingConfig": {"thinkingLevel": "medium"}}}


@pytest.mark.asyncio
@pytest.mark.parametrize("model", ["gemini-3.6-flash", "gemini-3.1-pro-preview", "gemini-3-flash-preview"])
async def test_gemini_3_saved_default_level_still_sends_nothing(model):
    _, _, body = await _gemini({**_saved_defaults("gemini-chat"), "model": model})
    assert "thinkingConfig" not in body.get("generationConfig", {})


# --------------------------------------------------------------------------
# Claude Opus 4.7 / 4.8 on Effort
# --------------------------------------------------------------------------

def test_opus_47_48_card_shows_effort_and_hides_budget_and_sampling():
    for model in OPUS_47_48:
        assert model in _param("claude-chat", "effort")["visibleWhen"]["model"]
        assert model in _param("claude-chat", "extended_thinking")["visibleWhen"]["model"]
        for key in ("thinkingBudget", "temperature", "top_p"):
            assert model not in _param("claude-chat", key)["visibleWhen"]["model"], key
            assert f"'{model}'" not in _frontend_param("claude-chat", key), key
        assert f"'{model}'" in _frontend_param("claude-chat", "effort")
        assert f"'{model}'" in _frontend_param("claude-chat", "extended_thinking")
    # Only Haiku 4.5 keeps the budget (the 4.6 models moved to Effort 2026-10-16).
    assert _param("claude-chat", "thinkingBudget")["visibleWhen"]["model"] == ["claude-haiku-4-5-20251001"]
    assert "claude-haiku-4-5-20251001" not in _param("claude-chat", "effort")["visibleWhen"]["model"]


@pytest.mark.asyncio
@pytest.mark.parametrize("model", OPUS_47_48)
async def test_opus_47_48_new_node_sends_effort(model):
    # Max Tokens 64,000 since Justin's item 3 (2026-10-16); was 4096.
    _, _, body = await _claude(_fresh("claude-chat", model))
    assert body == {"model": model, "messages": USER_TURN_CLAUDE, "max_tokens": 64000, "stream": True,
                    "output_config": {"effort": "medium"}}


@pytest.mark.asyncio
@pytest.mark.parametrize("model", OPUS_47_48)
@pytest.mark.parametrize("effort", ["low", "medium", "high", "xhigh", "max"])
async def test_opus_47_48_thinking_on_sends_adaptive_and_effort(model, effort):
    params = {**_fresh("claude-chat", model), "effort": effort, "extended_thinking": True,
              "thinkingBudget": 5000, "temperature": 0.3, "top_p": 0.9, "max_tokens": 64000}
    _, _, body = await _claude(params)
    assert body == {"model": model, "messages": USER_TURN_CLAUDE, "max_tokens": 64000, "stream": True,
                    "thinking": {"type": "adaptive"}, "output_config": {"effort": effort}}


@pytest.mark.asyncio
@pytest.mark.parametrize("model", OPUS_47_48)
async def test_opus_47_48_saved_graph_with_extended_thinking(model):
    # Saved before this change: Effort "" and Extended Thinking on. It used to
    # send thinking.type "enabled" with budget_tokens, which Anthropic says
    # 4.7 and later reject with HTTP 400.
    params = {**_saved_defaults("claude-chat"), "model": model, "extended_thinking": True,
              "thinkingBudget": 2048, "temperature": 0.2}
    _, _, body = await _claude(params)
    assert body == {"model": model, "messages": USER_TURN_CLAUDE, "max_tokens": 4096, "stream": True,
                    "thinking": {"type": "adaptive"}}


@pytest.mark.asyncio
@pytest.mark.parametrize("model", OPUS_47_48)
async def test_opus_47_48_saved_graph_without_thinking(model):
    _, _, body = await _claude({**_saved_defaults("claude-chat"), "model": model})
    assert body == {"model": model, "messages": USER_TURN_CLAUDE, "max_tokens": 4096, "stream": True}


@pytest.mark.asyncio
async def test_opus_47_unknown_effort_refused_before_request():
    with pytest.raises(ValueError, match="Effort"):
        await _claude({**_defaults("claude-chat"), "model": "claude-opus-4-7", "effort": "extreme"})


def test_frontend_effort_options_match_backend():
    backend = [o["value"] for o in _param("claude-chat", "effort")["options"]]
    frontend = re.findall(r"value: '([a-z]*)'", _frontend_param("claude-chat", "effort"))
    assert frontend == backend == ["", "low", "medium", "high", "xhigh", "max"]


# --------------------------------------------------------------------------
# Claude Opus 4.6 / Sonnet 4.6 on Effort (Justin's item 5, 2026-10-16)
# --------------------------------------------------------------------------

def test_claude_46_card_shows_effort_without_xhigh_and_keeps_sampling():
    effort = _param("claude-chat", "effort")
    xhigh = next(o for o in effort["options"] if o["value"] == "xhigh")
    for model in CLAUDE_46:
        assert model in effort["visibleWhen"]["model"]
        assert f"'{model}'" in _frontend_param("claude-chat", "effort")
        # Anthropic /effort: xhigh isn't available on Opus 4.6 / Sonnet 4.6.
        assert not _visible(xhigh, model)
        assert [o["value"] for o in effort["options"] if _visible(o, model)] == ["", "low", "medium", "high", "max"]
        assert MODEL_EFFORT_LEVELS[model] == ("low", "medium", "high", "max")
        assert model in _param("claude-chat", "extended_thinking")["visibleWhen"]["model"]
        assert model not in _param("claude-chat", "thinkingBudget")["visibleWhen"]["model"]
        assert f"'{model}'" not in _frontend_param("claude-chat", "thinkingBudget")
        # Sampling params are still accepted without thinking on the 4.6 models.
        for key in ("temperature", "top_p"):
            assert model in _param("claude-chat", key)["visibleWhen"]["model"], key
            assert f"'{model}'" in _frontend_param("claude-chat", key), key
    # Every other effort model keeps X-High.
    for model in EFFORT_MODELS - set(CLAUDE_46):
        assert _visible(xhigh, model), model
        assert MODEL_EFFORT_LEVELS[model] == EFFORT_LEVELS
    assert "'xhigh', visibleWhen" in _frontend_param("claude-chat", "effort")


@pytest.mark.asyncio
@pytest.mark.parametrize("model", CLAUDE_46)
async def test_claude_46_new_node_sends_effort_and_sampling(model):
    _, _, body = await _claude(_fresh("claude-chat", model))
    assert body == {"model": model, "messages": USER_TURN_CLAUDE, "max_tokens": 64000, "stream": True,
                    "temperature": 1.0, "output_config": {"effort": "medium"}}
    _, _, body = await _claude({**_fresh("claude-chat", model), "temperature": 0.3, "effort": "max"})
    assert body["temperature"] == 0.3 and body["output_config"] == {"effort": "max"}
    _, _, body = await _claude({**_fresh("claude-chat", model), "temperature": None, "top_p": 0.9, "effort": ""})
    assert body == {"model": model, "messages": USER_TURN_CLAUDE, "max_tokens": 64000, "stream": True,
                    "top_p": 0.9}


@pytest.mark.asyncio
@pytest.mark.parametrize("model", CLAUDE_46)
@pytest.mark.parametrize("effort", ["low", "medium", "high", "max"])
async def test_claude_46_thinking_on_sends_adaptive_not_budget(model, effort):
    params = {**_fresh("claude-chat", model), "effort": effort, "extended_thinking": True,
              "thinkingBudget": 5000, "temperature": 0.3}
    _, _, body = await _claude(params)
    assert body == {"model": model, "messages": USER_TURN_CLAUDE, "max_tokens": 64000, "stream": True,
                    "temperature": 1, "thinking": {"type": "adaptive"}, "output_config": {"effort": effort}}


@pytest.mark.asyncio
@pytest.mark.parametrize("model", CLAUDE_46)
async def test_claude_46_saved_graph_with_extended_thinking(model):
    # Saved before 2026-10-16: Effort "" and Extended Thinking on. It used to
    # send thinking.type "enabled" with budget_tokens (deprecated on 4.6); now
    # adaptive thinking. Everything else is what it sent before.
    params = {**_saved_defaults("claude-chat"), "model": model, "extended_thinking": True,
              "thinkingBudget": 2048, "temperature": 0.2, "max_tokens": 200000}
    _, _, body = await _claude(params)
    assert body == {"model": model, "messages": USER_TURN_CLAUDE, "max_tokens": 200000, "stream": True,
                    "temperature": 1, "thinking": {"type": "adaptive"}}


@pytest.mark.asyncio
@pytest.mark.parametrize("model", CLAUDE_46)
async def test_claude_46_saved_graph_without_thinking_unchanged(model):
    _, _, body = await _claude({**_saved_defaults("claude-chat"), "model": model})
    assert body == {"model": model, "messages": USER_TURN_CLAUDE, "max_tokens": 4096, "stream": True,
                    "temperature": 1.0}


@pytest.mark.asyncio
@pytest.mark.parametrize("model", CLAUDE_46)
async def test_claude_46_saved_effort_now_sent(model):
    # A level left on a node switched from a 5.x model was ignored before; the
    # 4.6 card now shows Effort, so it goes out.
    _, _, body = await _claude({**_saved_defaults("claude-chat"), "model": model, "effort": "max"})
    assert body["output_config"] == {"effort": "max"}


@pytest.mark.asyncio
@pytest.mark.parametrize("model", CLAUDE_46)
async def test_claude_46_xhigh_refused_before_request(model):
    with pytest.raises(ValueError, match="Effort must be one of low, medium, high, max"):
        await _claude({**_saved_defaults("claude-chat"), "model": model, "effort": "xhigh"})

