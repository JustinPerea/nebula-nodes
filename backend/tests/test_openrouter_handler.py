from __future__ import annotations

import json
from unittest.mock import AsyncMock, patch, MagicMock

import pytest

from handlers.openrouter import handle_openrouter_universal
from models.graph import GraphNode, PortValueDict


def _make_node(params=None):
    return GraphNode(
        id="test-or-1",
        definitionId="openrouter-universal",
        params=params or {"model": "openai/gpt-4o", "max_tokens": 100},
    )


@pytest.mark.asyncio
async def test_missing_api_key_raises():
    with pytest.raises(ValueError, match="OPENROUTER_API_KEY"):
        await handle_openrouter_universal(
            _make_node(),
            {"messages": PortValueDict(type="Text", value="Hello")},
            {},
        )


@pytest.mark.asyncio
async def test_missing_model_raises():
    with pytest.raises(ValueError, match="[Nn]o model"):
        await handle_openrouter_universal(
            _make_node({"model": ""}),
            {"messages": PortValueDict(type="Text", value="Hello")},
            {"OPENROUTER_API_KEY": "sk-or-test"},
        )


@pytest.mark.asyncio
async def test_missing_messages_raises():
    with pytest.raises(ValueError, match="[Mm]essages"):
        await handle_openrouter_universal(
            _make_node(),
            {},
            {"OPENROUTER_API_KEY": "sk-or-test"},
        )


@pytest.mark.asyncio
async def test_text_streaming_calls_stream_execute():
    with patch("handlers.openrouter.stream_execute", new_callable=AsyncMock) as mock_stream:
        mock_stream.return_value = "Hello from GPT-4o!"
        result = await handle_openrouter_universal(
            _make_node(),
            {"messages": PortValueDict(type="Text", value="Hi there")},
            {"OPENROUTER_API_KEY": "sk-or-test"},
            emit=AsyncMock(),
        )

    assert result["text"]["type"] == "Text"
    assert result["text"]["value"] == "Hello from GPT-4o!"
    # Verify the request body
    call_kwargs = mock_stream.call_args.kwargs
    body = call_kwargs.get("request_body") or mock_stream.call_args[1].get("request_body")
    assert body["model"] == "openai/gpt-4o"
    assert body["stream"] is True


@pytest.mark.asyncio
async def test_image_generation_mode():
    """When _output_image is set, should use non-streaming and parse images."""
    node = _make_node({"model": "openai/dall-e-3", "_output_image": True})

    mock_response = MagicMock()
    mock_response.status_code = 200
    mock_response.json.return_value = {
        "choices": [{"message": {"images": ["aWFtYmFzZTY0ZGF0YQ=="], "content": ""}}]
    }

    with patch("handlers.openrouter.httpx.AsyncClient") as MockClient:
        mock_client = AsyncMock()
        mock_client.post.return_value = mock_response
        mock_client.__aenter__ = AsyncMock(return_value=mock_client)
        mock_client.__aexit__ = AsyncMock(return_value=False)
        MockClient.return_value = mock_client

        with patch("handlers.openrouter.save_base64_image") as mock_save:
            mock_save.return_value = "/tmp/output/test.png"
            with patch("handlers.openrouter.get_run_dir") as mock_dir:
                mock_dir.return_value = "/tmp/output"
                result = await handle_openrouter_universal(
                    node,
                    {"messages": PortValueDict(type="Text", value="A cat")},
                    {"OPENROUTER_API_KEY": "sk-or-test"},
                )

    assert result["image"]["type"] == "Image"
