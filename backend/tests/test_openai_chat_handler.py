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
        params=params or {"model": "gpt-4o", "max_completion_tokens": 1024, "temperature": 1.0},
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
            _make_node({"model": "gpt-4o-mini", "max_completion_tokens": 512, "temperature": 0.5}),
            {"messages": PortValueDict(type="Text", value="test")},
            {"OPENAI_API_KEY": "sk-test-key"},
        )

    body = mock_client.stream.call_args.kwargs.get("json") or mock_client.stream.call_args[1].get("json")
    assert body["model"] == "gpt-4o-mini"
    assert body["stream"] is True
    assert body["temperature"] == 0.5
    assert body["max_completion_tokens"] == 512
    assert "max_tokens" not in body, "max_tokens is deprecated; handler must use max_completion_tokens"
    assert body["messages"][0]["role"] == "user"
    assert "top_p" not in body
    assert "frequency_penalty" not in body
    assert "presence_penalty" not in body


@pytest.mark.asyncio
async def test_optional_params_forwarded():
    """top_p, frequency_penalty, presence_penalty are forwarded when set."""
    fake_response = FakeStreamResponse(_make_openai_sse_lines(["ok"]))

    with patch("execution.stream_runner.httpx.AsyncClient") as MockClient:
        mock_client = AsyncMock()
        mock_client.stream = MagicMock(return_value=fake_response)
        mock_client.__aenter__ = AsyncMock(return_value=mock_client)
        mock_client.__aexit__ = AsyncMock(return_value=False)
        MockClient.return_value = mock_client

        await handle_openai_chat(
            _make_node({
                "model": "gpt-4o",
                "top_p": 0.9,
                "frequency_penalty": 0.5,
                "presence_penalty": -0.3,
            }),
            {"messages": PortValueDict(type="Text", value="test")},
            {"OPENAI_API_KEY": "sk-test-key"},
        )

    body = mock_client.stream.call_args.kwargs.get("json") or mock_client.stream.call_args[1].get("json")
    assert body["top_p"] == 0.9
    assert body["frequency_penalty"] == 0.5
    assert body["presence_penalty"] == -0.3


@pytest.mark.asyncio
async def test_response_format_json_forwarded():
    """response_format=json_object is forwarded as {type: json_object}; text is omitted."""
    fake_response = FakeStreamResponse(_make_openai_sse_lines(["{}"]  ))

    with patch("execution.stream_runner.httpx.AsyncClient") as MockClient:
        mock_client = AsyncMock()
        mock_client.stream = MagicMock(return_value=fake_response)
        mock_client.__aenter__ = AsyncMock(return_value=mock_client)
        mock_client.__aexit__ = AsyncMock(return_value=False)
        MockClient.return_value = mock_client

        await handle_openai_chat(
            _make_node({"model": "gpt-4o", "response_format": "json_object"}),
            {"messages": PortValueDict(type="Text", value="Return JSON")},
            {"OPENAI_API_KEY": "sk-test-key"},
        )

    body = mock_client.stream.call_args.kwargs.get("json") or mock_client.stream.call_args[1].get("json")
    assert body["response_format"] == {"type": "json_object"}


@pytest.mark.asyncio
async def test_response_format_text_not_forwarded():
    """response_format=text (registry default) is NOT sent to the API."""
    fake_response = FakeStreamResponse(_make_openai_sse_lines(["hi"]))

    with patch("execution.stream_runner.httpx.AsyncClient") as MockClient:
        mock_client = AsyncMock()
        mock_client.stream = MagicMock(return_value=fake_response)
        mock_client.__aenter__ = AsyncMock(return_value=mock_client)
        mock_client.__aexit__ = AsyncMock(return_value=False)
        MockClient.return_value = mock_client

        await handle_openai_chat(
            _make_node({"model": "gpt-4o", "response_format": "text"}),
            {"messages": PortValueDict(type="Text", value="hi")},
            {"OPENAI_API_KEY": "sk-test-key"},
        )

    body = mock_client.stream.call_args.kwargs.get("json") or mock_client.stream.call_args[1].get("json")
    assert "response_format" not in body


@pytest.mark.asyncio
async def test_registry_model_list():
    """All models in the registry enum are valid identifiers (no stale gpt-4-32k etc.)."""
    import json, pathlib
    defs_path = pathlib.Path(__file__).parent.parent / "data" / "node_definitions.json"
    defs = json.loads(defs_path.read_text())
    node_def = defs["gpt-4o-chat"]
    model_param = next(p for p in node_def["params"] if p["key"] == "model")
    model_values = [opt["value"] for opt in model_param["options"]]

    # Must contain the current flagship models
    assert "gpt-4o" in model_values
    assert "gpt-4o-mini" in model_values
    assert "gpt-4.1" in model_values
    assert "gpt-4.1-mini" in model_values
    assert "gpt-4.1-nano" in model_values

    # Must NOT contain deprecated legacy models
    deprecated = {"gpt-4-32k", "gpt-4-32k-0314", "gpt-4-32k-0613", "gpt-3.5-turbo"}
    assert not deprecated & set(model_values), f"Deprecated models found: {deprecated & set(model_values)}"

    # Reasoning models not in registry (no temperature guards needed)
    reasoning = {"o1", "o1-mini", "o3", "o3-mini", "o4-mini"}
    assert not reasoning & set(model_values), f"Reasoning models in registry require temperature guard: {reasoning & set(model_values)}"


@pytest.mark.asyncio
async def test_max_completion_tokens_not_sent_when_absent():
    """When max_completion_tokens is not set, the key is absent from the request body."""
    fake_response = FakeStreamResponse(_make_openai_sse_lines(["ok"]))

    with patch("execution.stream_runner.httpx.AsyncClient") as MockClient:
        mock_client = AsyncMock()
        mock_client.stream = MagicMock(return_value=fake_response)
        mock_client.__aenter__ = AsyncMock(return_value=mock_client)
        mock_client.__aexit__ = AsyncMock(return_value=False)
        MockClient.return_value = mock_client

        await handle_openai_chat(
            _make_node({"model": "gpt-4o"}),
            {"messages": PortValueDict(type="Text", value="hi")},
            {"OPENAI_API_KEY": "sk-test-key"},
        )

    body = mock_client.stream.call_args.kwargs.get("json") or mock_client.stream.call_args[1].get("json")
    assert "max_completion_tokens" not in body
    assert "max_tokens" not in body
