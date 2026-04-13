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
