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
async def test_missing_image_path_raises(tmp_path):
    """A wired image whose local path doesn't exist must surface as an error, not
    be silently dropped — otherwise the node 'succeeds' having sent zero of the
    references the user connected."""
    missing = tmp_path / "gone.png"
    with pytest.raises(ValueError, match="not found"):
        await handle_openrouter_universal(
            _make_node(),
            {
                "messages": PortValueDict(type="Text", value="describe this"),
                "images": PortValueDict(type="Image", value=str(missing)),
            },
            {"OPENROUTER_API_KEY": "sk-or-test"},
            emit=AsyncMock(),
        )


@pytest.mark.asyncio
async def test_data_uri_image_preserved():
    """data: URIs keep their existing behavior — forwarded verbatim as an image_url."""
    with patch("handlers.openrouter.stream_execute", new_callable=AsyncMock) as mock_stream:
        mock_stream.return_value = "ok"
        await handle_openrouter_universal(
            _make_node(),
            {
                "messages": PortValueDict(type="Text", value="describe"),
                "images": PortValueDict(type="Image", value="data:image/png;base64,QUJD"),
            },
            {"OPENROUTER_API_KEY": "sk-or-test"},
            emit=AsyncMock(),
        )
    body = mock_stream.call_args.kwargs.get("request_body") or mock_stream.call_args[1].get("request_body")
    image_blocks = [b for b in body["messages"][0]["content"] if b.get("type") == "image_url"]
    assert len(image_blocks) == 1
    assert image_blocks[0]["image_url"]["url"] == "data:image/png;base64,QUJD"


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
    # Verified 2026-05-17: OpenRouter image generation response shape is
    # choices[0].message.images[0] = {"type": "image_url", "image_url": {"url": "data:image/png;base64,<b64>"}}
    # Source: https://openrouter.ai/docs/guides/overview/multimodal/image-generation
    mock_response.json.return_value = {
        "choices": [{"message": {
            "images": [{"type": "image_url", "image_url": {"url": "data:image/png;base64,aWFtYmFzZTY0ZGF0YQ=="}}],
            "content": "",
        }}]
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
    # Verify correct base64 was extracted from the data URI
    mock_save.assert_called_once()
    b64_arg = mock_save.call_args[0][0]
    assert b64_arg == "aWFtYmFzZTY0ZGF0YQ==", (
        "save_base64_image must receive the raw base64 portion (after stripping 'data:...;base64,' prefix)"
    )


@pytest.mark.asyncio
async def test_streaming_uses_bearer_and_openrouter_title_header():
    """Auth header must be 'Bearer' and attribution header must be X-OpenRouter-Title.

    Verified 2026-05-17 against https://openrouter.ai/docs/api/reference/authentication
    (Bearer token) and https://openrouter.ai/docs/quickstart (X-OpenRouter-Title).
    """
    with patch("handlers.openrouter.stream_execute", new_callable=AsyncMock) as mock_stream:
        mock_stream.return_value = "ok"
        await handle_openrouter_universal(
            _make_node(),
            {"messages": PortValueDict(type="Text", value="hi")},
            {"OPENROUTER_API_KEY": "sk-or-abc"},
            emit=AsyncMock(),
        )

    call_kwargs = mock_stream.call_args.kwargs
    config = call_kwargs.get("config") or mock_stream.call_args[1].get("config")
    assert config.headers["Authorization"] == "Bearer sk-or-abc"
    assert "X-OpenRouter-Title" in config.headers, (
        "Header must be X-OpenRouter-Title (not legacy X-Title)"
    )
    assert "X-Title" not in config.headers, (
        "Legacy X-Title header must not be sent; use X-OpenRouter-Title"
    )


@pytest.mark.asyncio
async def test_image_generation_uses_bearer_header():
    """Image generation path must also use Bearer auth and X-OpenRouter-Title.

    Verified 2026-05-17 against https://openrouter.ai/docs/api/reference/authentication
    """
    node = _make_node({"model": "google/gemini-2.5-flash-image", "_output_image": True})

    mock_response = MagicMock()
    mock_response.status_code = 200
    mock_response.json.return_value = {
        "choices": [{"message": {"images": [], "content": "no image"}}]
    }

    captured_headers: dict = {}

    with patch("handlers.openrouter.httpx.AsyncClient") as MockClient:
        mock_client = AsyncMock()

        async def capture_post(url, headers=None, json=None, **kw):
            captured_headers.update(headers or {})
            return mock_response

        mock_client.post.side_effect = capture_post
        mock_client.__aenter__ = AsyncMock(return_value=mock_client)
        mock_client.__aexit__ = AsyncMock(return_value=False)
        MockClient.return_value = mock_client

        await handle_openrouter_universal(
            node,
            {"messages": PortValueDict(type="Text", value="A cat")},
            {"OPENROUTER_API_KEY": "sk-or-xyz"},
        )

    assert captured_headers.get("Authorization") == "Bearer sk-or-xyz"
    assert "X-OpenRouter-Title" in captured_headers
    assert "X-Title" not in captured_headers


@pytest.mark.asyncio
async def test_openrouter_json_sets_response_format():
    """response_format=json_object must be forwarded as {"type": "json_object"}."""
    with patch("handlers.openrouter.stream_execute", new_callable=AsyncMock) as mock_stream:
        mock_stream.return_value = '{"ok": true}'
        await handle_openrouter_universal(
            _make_node({"model": "openai/gpt-4o", "response_format": "json_object"}),
            {"messages": PortValueDict(type="Text", value="Return JSON")},
            {"OPENROUTER_API_KEY": "sk-or-test"},
            emit=AsyncMock(),
        )
    body = mock_stream.call_args.kwargs["request_body"]
    assert body["response_format"] == {"type": "json_object"}


@pytest.mark.asyncio
async def test_prompt_caching_on_marks_last_content_block():
    """When prompt_caching is on, the last user content block carries an ephemeral cache_control breakpoint."""
    with patch("handlers.openrouter.stream_execute", new_callable=AsyncMock) as mock_stream:
        mock_stream.return_value = "ok"
        await handle_openrouter_universal(
            _make_node({"model": "anthropic/claude-3.5-sonnet", "prompt_caching": True}),
            {"messages": PortValueDict(type="Text", value="hello")},
            {"OPENROUTER_API_KEY": "sk-or-test"},
            emit=AsyncMock(),
        )
    body = mock_stream.call_args.kwargs["request_body"]
    assert body["messages"][0]["content"][-1]["cache_control"] == {"type": "ephemeral"}, (
        "last content block must carry an ephemeral cache_control breakpoint when caching is on"
    )


@pytest.mark.asyncio
async def test_prompt_caching_off_by_default_has_no_cache_control():
    """Default (no prompt_caching): no content block carries cache_control."""
    with patch("handlers.openrouter.stream_execute", new_callable=AsyncMock) as mock_stream:
        mock_stream.return_value = "ok"
        await handle_openrouter_universal(
            _make_node({"model": "anthropic/claude-3.5-sonnet"}),
            {"messages": PortValueDict(type="Text", value="hello")},
            {"OPENROUTER_API_KEY": "sk-or-test"},
            emit=AsyncMock(),
        )
    body = mock_stream.call_args.kwargs["request_body"]
    for block in body["messages"][0]["content"]:
        assert "cache_control" not in block, "no content block may carry cache_control when caching is off"


@pytest.mark.asyncio
async def test_openrouter_text_omits_response_format():
    with patch("handlers.openrouter.stream_execute", new_callable=AsyncMock) as mock_stream:
        mock_stream.return_value = "plain"
        await handle_openrouter_universal(
            _make_node({"model": "openai/gpt-4o"}),
            {"messages": PortValueDict(type="Text", value="Hi")},
            {"OPENROUTER_API_KEY": "sk-or-test"},
            emit=AsyncMock(),
        )
    body = mock_stream.call_args.kwargs["request_body"]
    assert "response_format" not in body
