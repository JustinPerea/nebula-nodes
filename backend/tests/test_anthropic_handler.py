from __future__ import annotations

import json
from unittest.mock import AsyncMock, MagicMock, patch

import pytest

from handlers.anthropic_chat import handle_claude_chat, ANTHROPIC_VERSION
from models.graph import GraphNode, PortValueDict
from models.events import StreamDeltaEvent


def _make_node(params=None):
    return GraphNode(id="test-claude-1", definitionId="claude-chat", params=params or {"model": "claude-sonnet-4-6", "max_tokens": 1024, "temperature": 0.7})


class FakeStreamResponse:
    def __init__(self, sse_lines, status_code=200):
        self.status_code = status_code
        self._lines = sse_lines

    async def aiter_lines(self):
        for line in self._lines:
            yield line

    async def aiter_text(self):
        yield "error body"

    async def __aenter__(self):
        return self

    async def __aexit__(self, *args):
        pass


def _make_sse_lines(text_chunks):
    lines = []
    lines.append("event: message_start")
    lines.append('data: {"type":"message_start","message":{"id":"msg_test","type":"message","role":"assistant","content":[],"model":"claude-sonnet-4-6"}}')
    lines.append("")
    lines.append("event: content_block_start")
    lines.append('data: {"type":"content_block_start","index":0,"content_block":{"type":"text","text":""}}')
    lines.append("")
    for chunk in text_chunks:
        lines.append("event: content_block_delta")
        lines.append(f'data: {json.dumps({"type": "content_block_delta", "index": 0, "delta": {"type": "text_delta", "text": chunk}})}')
        lines.append("")
    lines.append("event: content_block_stop")
    lines.append('data: {"type":"content_block_stop","index":0}')
    lines.append("")
    lines.append("event: message_stop")
    lines.append('data: {"type":"message_stop"}')
    lines.append("")
    return lines


@pytest.mark.asyncio
async def test_streams_text_and_returns_accumulated():
    chunks = ["Hello", " world", "!"]
    fake_response = FakeStreamResponse(_make_sse_lines(chunks))
    collected = []

    async def capture_emit(event):
        if isinstance(event, StreamDeltaEvent):
            collected.append(event)

    with patch("execution.stream_runner.httpx.AsyncClient") as MockClient:
        mock_client = AsyncMock()
        mock_client.stream = MagicMock(return_value=fake_response)
        mock_client.__aenter__ = AsyncMock(return_value=mock_client)
        mock_client.__aexit__ = AsyncMock(return_value=False)
        MockClient.return_value = mock_client

        result = await handle_claude_chat(
            _make_node(), {"messages": PortValueDict(type="Text", value="Tell me a joke")},
            {"ANTHROPIC_API_KEY": "sk-ant-test"}, emit=capture_emit
        )

    assert result["text"]["value"] == "Hello world!"
    assert len(collected) == 3
    assert collected[2].accumulated == "Hello world!"

    headers = mock_client.stream.call_args.kwargs.get("headers") or mock_client.stream.call_args[1].get("headers")
    assert headers["x-api-key"] == "sk-ant-test"
    assert headers["anthropic-version"] == ANTHROPIC_VERSION


@pytest.mark.asyncio
async def test_missing_messages_raises():
    with pytest.raises(ValueError, match="[Mm]essages.*required"):
        await handle_claude_chat(_make_node(), {}, {"ANTHROPIC_API_KEY": "sk-ant-test"})


@pytest.mark.asyncio
async def test_missing_api_key_raises():
    with pytest.raises(ValueError, match="ANTHROPIC_API_KEY"):
        await handle_claude_chat(
            _make_node(), {"messages": PortValueDict(type="Text", value="hi")}, {}
        )


@pytest.mark.asyncio
async def test_includes_temperature_in_request():
    fake_response = FakeStreamResponse(_make_sse_lines(["ok"]))
    with patch("execution.stream_runner.httpx.AsyncClient") as MockClient:
        mock_client = AsyncMock()
        mock_client.stream = MagicMock(return_value=fake_response)
        mock_client.__aenter__ = AsyncMock(return_value=mock_client)
        mock_client.__aexit__ = AsyncMock(return_value=False)
        MockClient.return_value = mock_client

        await handle_claude_chat(
            _make_node({"model": "claude-sonnet-4-6", "max_tokens": 1024, "temperature": 0.3}),
            {"messages": PortValueDict(type="Text", value="test")},
            {"ANTHROPIC_API_KEY": "sk-ant-test"},
        )

    body = mock_client.stream.call_args.kwargs.get("json") or mock_client.stream.call_args[1].get("json")
    assert body["temperature"] == 0.3
    assert body["stream"] is True


@pytest.mark.asyncio
async def test_max_tokens_always_sent():
    """max_tokens is REQUIRED by Anthropic API — must always be present in request body."""
    fake_response = FakeStreamResponse(_make_sse_lines(["ok"]))
    with patch("execution.stream_runner.httpx.AsyncClient") as MockClient:
        mock_client = AsyncMock()
        mock_client.stream = MagicMock(return_value=fake_response)
        mock_client.__aenter__ = AsyncMock(return_value=mock_client)
        mock_client.__aexit__ = AsyncMock(return_value=False)
        MockClient.return_value = mock_client

        # No max_tokens param — should fall back to default 4096
        await handle_claude_chat(
            _make_node({"model": "claude-sonnet-4-6"}),
            {"messages": PortValueDict(type="Text", value="test")},
            {"ANTHROPIC_API_KEY": "sk-ant-test"},
        )

    body = mock_client.stream.call_args.kwargs.get("json") or mock_client.stream.call_args[1].get("json")
    assert "max_tokens" in body, "max_tokens must always be sent (Anthropic API requires it)"
    assert body["max_tokens"] == 4096


@pytest.mark.asyncio
async def test_system_prompt_sent_as_top_level_field():
    """Anthropic uses a top-level 'system' field, not a role in the messages array."""
    fake_response = FakeStreamResponse(_make_sse_lines(["ok"]))
    with patch("execution.stream_runner.httpx.AsyncClient") as MockClient:
        mock_client = AsyncMock()
        mock_client.stream = MagicMock(return_value=fake_response)
        mock_client.__aenter__ = AsyncMock(return_value=mock_client)
        mock_client.__aexit__ = AsyncMock(return_value=False)
        MockClient.return_value = mock_client

        await handle_claude_chat(
            _make_node({"model": "claude-sonnet-4-6", "max_tokens": 1024, "system": "You are a pirate."}),
            {"messages": PortValueDict(type="Text", value="hello")},
            {"ANTHROPIC_API_KEY": "sk-ant-test"},
        )

    body = mock_client.stream.call_args.kwargs.get("json") or mock_client.stream.call_args[1].get("json")
    assert body.get("system") == "You are a pirate."
    # system must NOT appear as a role in the messages array
    for msg in body["messages"]:
        assert msg.get("role") != "system", "system prompt must not be injected as a messages role"


@pytest.mark.asyncio
async def test_top_p_forwarded():
    fake_response = FakeStreamResponse(_make_sse_lines(["ok"]))
    with patch("execution.stream_runner.httpx.AsyncClient") as MockClient:
        mock_client = AsyncMock()
        mock_client.stream = MagicMock(return_value=fake_response)
        mock_client.__aenter__ = AsyncMock(return_value=mock_client)
        mock_client.__aexit__ = AsyncMock(return_value=False)
        MockClient.return_value = mock_client

        await handle_claude_chat(
            _make_node({"model": "claude-sonnet-4-6", "max_tokens": 1024, "top_p": 0.9}),
            {"messages": PortValueDict(type="Text", value="test")},
            {"ANTHROPIC_API_KEY": "sk-ant-test"},
        )

    body = mock_client.stream.call_args.kwargs.get("json") or mock_client.stream.call_args[1].get("json")
    assert body.get("top_p") == 0.9


@pytest.mark.asyncio
async def test_top_p_absent_when_not_set():
    fake_response = FakeStreamResponse(_make_sse_lines(["ok"]))
    with patch("execution.stream_runner.httpx.AsyncClient") as MockClient:
        mock_client = AsyncMock()
        mock_client.stream = MagicMock(return_value=fake_response)
        mock_client.__aenter__ = AsyncMock(return_value=mock_client)
        mock_client.__aexit__ = AsyncMock(return_value=False)
        MockClient.return_value = mock_client

        await handle_claude_chat(
            _make_node({"model": "claude-sonnet-4-6", "max_tokens": 1024}),
            {"messages": PortValueDict(type="Text", value="test")},
            {"ANTHROPIC_API_KEY": "sk-ant-test"},
        )

    body = mock_client.stream.call_args.kwargs.get("json") or mock_client.stream.call_args[1].get("json")
    assert "top_p" not in body


@pytest.mark.asyncio
async def test_stop_sequences_forwarded_as_list():
    fake_response = FakeStreamResponse(_make_sse_lines(["ok"]))
    with patch("execution.stream_runner.httpx.AsyncClient") as MockClient:
        mock_client = AsyncMock()
        mock_client.stream = MagicMock(return_value=fake_response)
        mock_client.__aenter__ = AsyncMock(return_value=mock_client)
        mock_client.__aexit__ = AsyncMock(return_value=False)
        MockClient.return_value = mock_client

        await handle_claude_chat(
            _make_node({"model": "claude-sonnet-4-6", "max_tokens": 1024, "stop_sequences": "END, STOP"}),
            {"messages": PortValueDict(type="Text", value="test")},
            {"ANTHROPIC_API_KEY": "sk-ant-test"},
        )

    body = mock_client.stream.call_args.kwargs.get("json") or mock_client.stream.call_args[1].get("json")
    assert body.get("stop_sequences") == ["END", "STOP"]


@pytest.mark.asyncio
async def test_extended_thinking_sends_thinking_block():
    fake_response = FakeStreamResponse(_make_sse_lines(["ok"]))
    with patch("execution.stream_runner.httpx.AsyncClient") as MockClient:
        mock_client = AsyncMock()
        mock_client.stream = MagicMock(return_value=fake_response)
        mock_client.__aenter__ = AsyncMock(return_value=mock_client)
        mock_client.__aexit__ = AsyncMock(return_value=False)
        MockClient.return_value = mock_client

        await handle_claude_chat(
            _make_node({"model": "claude-sonnet-4-6", "max_tokens": 16000, "extended_thinking": True, "thinkingBudget": 5000}),
            {"messages": PortValueDict(type="Text", value="think hard")},
            {"ANTHROPIC_API_KEY": "sk-ant-test"},
        )

    body = mock_client.stream.call_args.kwargs.get("json") or mock_client.stream.call_args[1].get("json")
    assert body.get("thinking") == {"type": "enabled", "budget_tokens": 5000}
    # Anthropic requires temperature=1 when thinking is enabled
    assert body.get("temperature") == 1


@pytest.mark.asyncio
async def test_extended_thinking_budget_clamps_to_minimum():
    """budget_tokens must be clamped to exactly 1024 when user sets a value below the floor."""
    fake_response = FakeStreamResponse(_make_sse_lines(["ok"]))
    with patch("execution.stream_runner.httpx.AsyncClient") as MockClient:
        mock_client = AsyncMock()
        mock_client.stream = MagicMock(return_value=fake_response)
        mock_client.__aenter__ = AsyncMock(return_value=mock_client)
        mock_client.__aexit__ = AsyncMock(return_value=False)
        MockClient.return_value = mock_client

        await handle_claude_chat(
            _make_node({"model": "claude-sonnet-4-6", "max_tokens": 8000, "extended_thinking": True, "thinkingBudget": 100}),
            {"messages": PortValueDict(type="Text", value="test")},
            {"ANTHROPIC_API_KEY": "sk-ant-test"},
        )

    body = mock_client.stream.call_args.kwargs.get("json") or mock_client.stream.call_args[1].get("json")
    assert body["thinking"]["budget_tokens"] == 1024


@pytest.mark.asyncio
async def test_extended_thinking_overrides_user_temperature():
    """When extended_thinking is enabled, temperature=1 must be forced regardless of user-set value."""
    fake_response = FakeStreamResponse(_make_sse_lines(["ok"]))
    with patch("execution.stream_runner.httpx.AsyncClient") as MockClient:
        mock_client = AsyncMock()
        mock_client.stream = MagicMock(return_value=fake_response)
        mock_client.__aenter__ = AsyncMock(return_value=mock_client)
        mock_client.__aexit__ = AsyncMock(return_value=False)
        MockClient.return_value = mock_client

        await handle_claude_chat(
            _make_node({"model": "claude-sonnet-4-6", "max_tokens": 16000, "temperature": 0.5, "extended_thinking": True, "thinkingBudget": 5000}),
            {"messages": PortValueDict(type="Text", value="think hard")},
            {"ANTHROPIC_API_KEY": "sk-ant-test"},
        )

    body = mock_client.stream.call_args.kwargs.get("json") or mock_client.stream.call_args[1].get("json")
    assert body["temperature"] == 1, "temperature must be forced to 1 when extended_thinking is on, overriding user value"
    assert body["thinking"] == {"type": "enabled", "budget_tokens": 5000}


@pytest.mark.asyncio
async def test_extended_thinking_not_sent_when_disabled():
    """No thinking block when extended_thinking is False; user temperature is preserved."""
    fake_response = FakeStreamResponse(_make_sse_lines(["ok"]))
    with patch("execution.stream_runner.httpx.AsyncClient") as MockClient:
        mock_client = AsyncMock()
        mock_client.stream = MagicMock(return_value=fake_response)
        mock_client.__aenter__ = AsyncMock(return_value=mock_client)
        mock_client.__aexit__ = AsyncMock(return_value=False)
        MockClient.return_value = mock_client

        await handle_claude_chat(
            _make_node({"model": "claude-sonnet-4-6", "max_tokens": 4096, "extended_thinking": False, "temperature": 0.3}),
            {"messages": PortValueDict(type="Text", value="test")},
            {"ANTHROPIC_API_KEY": "sk-ant-test"},
        )

    body = mock_client.stream.call_args.kwargs.get("json") or mock_client.stream.call_args[1].get("json")
    assert "thinking" not in body, "thinking block must not be sent when extended_thinking is False"
    assert body.get("temperature") == 0.3, "user-set temperature must be preserved when thinking is disabled"


@pytest.mark.asyncio
async def test_fable5_never_sends_thinking_block():
    """Claude Fable/Mythos 5 use always-on adaptive thinking and reject the extended-thinking
    param — the thinking block must be suppressed even when the node has it enabled."""
    fake_response = FakeStreamResponse(_make_sse_lines(["ok"]))
    with patch("execution.stream_runner.httpx.AsyncClient") as MockClient:
        mock_client = AsyncMock()
        mock_client.stream = MagicMock(return_value=fake_response)
        mock_client.__aenter__ = AsyncMock(return_value=mock_client)
        mock_client.__aexit__ = AsyncMock(return_value=False)
        MockClient.return_value = mock_client

        await handle_claude_chat(
            _make_node({"model": "claude-fable-5", "max_tokens": 16000, "temperature": 0.5, "extended_thinking": True, "thinkingBudget": 5000}),
            {"messages": PortValueDict(type="Text", value="think hard")},
            {"ANTHROPIC_API_KEY": "sk-ant-test"},
        )

    body = mock_client.stream.call_args.kwargs.get("json") or mock_client.stream.call_args[1].get("json")
    assert body["model"] == "claude-fable-5"
    assert "thinking" not in body, "Fable 5 must never receive an extended-thinking block"
    assert body.get("temperature") == 0.5, "user temperature must not be overridden for Fable 5"


@pytest.mark.asyncio
async def test_registry_claude_model_list():
    """Registry must carry the current Anthropic lineup (June 2026)."""
    import json, pathlib
    defs_path = pathlib.Path(__file__).parent.parent / "data" / "node_definitions.json"
    defs = json.loads(defs_path.read_text())
    model_param = next(p for p in defs["claude-chat"]["params"] if p["key"] == "model")
    model_values = [opt["value"] for opt in model_param["options"]]
    assert "claude-fable-5" in model_values
    assert "claude-opus-4-8" in model_values
    assert "claude-sonnet-4-6" in model_values
    # extended-thinking params must be hidden for Fable/Mythos models
    for key in ("extended_thinking", "thinkingBudget"):
        prm = next(p for p in defs["claude-chat"]["params"] if p["key"] == key)
        visible_models = prm.get("visibleWhen", {}).get("model", [])
        assert visible_models, f"{key} must declare visibleWhen.model"
        assert not any(m.startswith(("claude-fable", "claude-mythos")) for m in visible_models)


@pytest.mark.asyncio
async def test_top_p_omitted_when_temperature_set():
    """Anthropic API requires temperature OR top_p, not both — top_p drops when both are set."""
    fake_response = FakeStreamResponse(_make_sse_lines(["ok"]))
    with patch("execution.stream_runner.httpx.AsyncClient") as MockClient:
        mock_client = AsyncMock()
        mock_client.stream = MagicMock(return_value=fake_response)
        mock_client.__aenter__ = AsyncMock(return_value=mock_client)
        mock_client.__aexit__ = AsyncMock(return_value=False)
        MockClient.return_value = mock_client

        await handle_claude_chat(
            _make_node({"model": "claude-sonnet-4-6", "max_tokens": 1024, "temperature": 0.5, "top_p": 0.9}),
            {"messages": PortValueDict(type="Text", value="test")},
            {"ANTHROPIC_API_KEY": "sk-ant-test"},
        )

    body = mock_client.stream.call_args.kwargs.get("json") or mock_client.stream.call_args[1].get("json")
    assert body.get("temperature") == 0.5
    assert "top_p" not in body, "top_p must be omitted when temperature is also set (Anthropic API constraint)"


@pytest.mark.asyncio
async def test_prompt_caching_on_marks_system_and_last_content_block():
    """When prompt_caching is on, system is sent as a content-block array with an
    ephemeral cache_control breakpoint, and the last user content block also carries one."""
    fake_response = FakeStreamResponse(_make_sse_lines(["ok"]))
    with patch("execution.stream_runner.httpx.AsyncClient") as MockClient:
        mock_client = AsyncMock()
        mock_client.stream = MagicMock(return_value=fake_response)
        mock_client.__aenter__ = AsyncMock(return_value=mock_client)
        mock_client.__aexit__ = AsyncMock(return_value=False)
        MockClient.return_value = mock_client

        await handle_claude_chat(
            _make_node({"model": "claude-sonnet-4-6", "max_tokens": 1024, "system": "You are a pirate.", "prompt_caching": True}),
            {"messages": PortValueDict(type="Text", value="hello")},
            {"ANTHROPIC_API_KEY": "sk-ant-test"},
        )

    body = mock_client.stream.call_args.kwargs.get("json") or mock_client.stream.call_args[1].get("json")
    assert body["system"] == [
        {"type": "text", "text": "You are a pirate.", "cache_control": {"type": "ephemeral"}}
    ], "system must be a content-block array with an ephemeral cache_control breakpoint when caching is on"
    assert body["messages"][0]["content"][-1]["cache_control"] == {"type": "ephemeral"}, (
        "last user content block must carry an ephemeral cache_control breakpoint when caching is on"
    )


@pytest.mark.asyncio
async def test_prompt_caching_off_by_default_keeps_string_system_and_no_cache_control():
    """Default (no prompt_caching): system stays a plain string and no content block has cache_control."""
    fake_response = FakeStreamResponse(_make_sse_lines(["ok"]))
    with patch("execution.stream_runner.httpx.AsyncClient") as MockClient:
        mock_client = AsyncMock()
        mock_client.stream = MagicMock(return_value=fake_response)
        mock_client.__aenter__ = AsyncMock(return_value=mock_client)
        mock_client.__aexit__ = AsyncMock(return_value=False)
        MockClient.return_value = mock_client

        await handle_claude_chat(
            _make_node({"model": "claude-sonnet-4-6", "max_tokens": 1024, "system": "You are a pirate."}),
            {"messages": PortValueDict(type="Text", value="hello")},
            {"ANTHROPIC_API_KEY": "sk-ant-test"},
        )

    body = mock_client.stream.call_args.kwargs.get("json") or mock_client.stream.call_args[1].get("json")
    assert body["system"] == "You are a pirate.", "system must remain a plain string when caching is off"
    for block in body["messages"][0]["content"]:
        assert "cache_control" not in block, "no content block may carry cache_control when caching is off"


def test_model_lineup_current():
    """Pin: registry model values must match the current Anthropic model lineup.

    Canonical source: https://platform.claude.com/docs/en/docs/about-claude/models/all-models
    Verified: 2026-05-16

    Current models (flagship tier):
      claude-opus-4-7         — most capable, 1M context, 128k output
      claude-sonnet-4-6       — speed+intelligence, 1M context, 64k output
      claude-haiku-4-5-20251001 — fastest, 200k context, 64k output

    Legacy (still available, not deprecated):
      claude-opus-4-6

    Deprecated (retiring 2026-06-15, must NOT appear):
      claude-opus-4-20250514  (Claude Opus 4 — original)
      claude-sonnet-4-20250514 (Claude Sonnet 4 — original)

    Removed (never existed in current lineup):
      claude-haiku-3-5-20241022 — was Claude 3.5 Haiku, superseded by claude-haiku-4-5
    """
    import json, pathlib
    registry_path = pathlib.Path(__file__).parent.parent / "data" / "node_definitions.json"
    data = json.loads(registry_path.read_text())
    node = data["claude-chat"]
    model_param = next(p for p in node["params"] if p["key"] == "model")
    values = {opt["value"] for opt in model_param["options"]}

    # Current models must be present
    assert "claude-opus-4-7" in values, "claude-opus-4-7 missing from model list"
    assert "claude-sonnet-4-6" in values, "claude-sonnet-4-6 missing"
    assert "claude-haiku-4-5-20251001" in values, "claude-haiku-4-5-20251001 missing"

    # Deprecated/wrong models must not appear
    assert "claude-opus-4-20250514" not in values, "claude-opus-4-20250514 is deprecated (retires 2026-06-15)"
    assert "claude-haiku-3-5-20241022" not in values, "claude-haiku-3-5-20241022 does not exist (superseded by haiku-4-5)"
