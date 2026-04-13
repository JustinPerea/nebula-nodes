from __future__ import annotations

import json
from unittest.mock import AsyncMock, MagicMock, patch

import pytest

from handlers.openai_chat import handle_openai_chat
from models.graph import GraphNode, PortValueDict
from models.events import StreamDeltaEvent


def _make_node(params=None):
    return GraphNode(
        id="test-gpt4o-1",
        definitionId="gpt-4o-chat",
        params=params or {"model": "gpt-4o", "max_tokens": 1024, "temperature": 1.0},
    )


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


def _make_openai_sse_lines(text_chunks):
    """Build OpenAI-style SSE lines (no event: lines, uses [DONE] sentinel)."""
    lines = []
    for chunk in text_chunks:
        data = {
            "id": "chatcmpl-test",
            "object": "chat.completion.chunk",
            "choices": [{"delta": {"content": chunk}, "finish_reason": None, "index": 0}],
        }
        lines.append(f"data: {json.dumps(data)}")
        lines.append("")
    lines.append("data: [DONE]")
    lines.append("")
    return lines


@pytest.mark.asyncio
async def test_streams_text_and_returns_accumulated():
    chunks = ["Hello", ", ", "world!"]
    fake_response = FakeStreamResponse(_make_openai_sse_lines(chunks))
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

        result = await handle_openai_chat(
            _make_node(),
            {"messages": PortValueDict(type="Text", value="Say hello")},
            {"OPENAI_API_KEY": "sk-test-key"},
            emit=capture_emit,
        )

    assert result["text"]["value"] == "Hello, world!"
    assert len(collected) == 3
    assert collected[2].accumulated == "Hello, world!"

    headers = mock_client.stream.call_args.kwargs.get("headers") or mock_client.stream.call_args[1].get("headers")
    assert "Bearer sk-test-key" in headers["Authorization"]


@pytest.mark.asyncio
async def test_missing_messages_raises():
    with pytest.raises(ValueError, match="[Mm]essages.*required"):
        await handle_openai_chat(_make_node(), {}, {"OPENAI_API_KEY": "sk-test-key"})


@pytest.mark.asyncio
async def test_missing_api_key_raises():
    with pytest.raises(ValueError, match="OPENAI_API_KEY"):
        await handle_openai_chat(
            _make_node(),
            {"messages": PortValueDict(type="Text", value="hi")},
            {},
        )


@pytest.mark.asyncio
async def test_request_body_includes_model_and_stream():
    fake_response = FakeStreamResponse(_make_openai_sse_lines(["ok"]))

    with patch("execution.stream_runner.httpx.AsyncClient") as MockClient:
        mock_client = AsyncMock()
        mock_client.stream = MagicMock(return_value=fake_response)
        mock_client.__aenter__ = AsyncMock(return_value=mock_client)
        mock_client.__aexit__ = AsyncMock(return_value=False)
        MockClient.return_value = mock_client

        await handle_openai_chat(
            _make_node({"model": "gpt-4o-mini", "max_tokens": 512, "temperature": 0.5}),
            {"messages": PortValueDict(type="Text", value="test")},
            {"OPENAI_API_KEY": "sk-test-key"},
        )

    body = mock_client.stream.call_args.kwargs.get("json") or mock_client.stream.call_args[1].get("json")
    assert body["model"] == "gpt-4o-mini"
    assert body["stream"] is True
    assert body["temperature"] == 0.5
    assert body["max_tokens"] == 512
    assert body["messages"][0]["role"] == "user"
