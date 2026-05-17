"""Tests for the Nous Portal universal handler.

Auth model: Nous Portal uses Hermes OAuth credentials stored in
~/.hermes/profiles/daedalus/auth.json (and profile fallbacks). It does NOT
use a user-supplied environment variable key — envKeyName is [] intentionally.

The inference endpoint (https://inference-api.nousresearch.com/v1/chat/completions)
requires either:
  - Authorization: Bearer <agent_key>  (Hermes-managed OAuth agent key), OR
  - An x402 Solana micropayment header
Verified 2026-05-17: unauthenticated POST returns HTTP 402 with x402 payment challenge.

The handler calls load_nous_credential() which reads ~/.hermes/…/auth.json and
returns a NousCredential(access_token=agent_key, base_url=...). We mock that
throughout these tests.
"""
from __future__ import annotations

from unittest.mock import AsyncMock, patch, MagicMock

import pytest

from handlers.nous_portal import handle_nous_portal_universal
from models.graph import GraphNode, PortValueDict
from services.nous_auth import NousCredential, NousNotAuthenticatedError


_FAKE_CRED = NousCredential(
    access_token="sk-nous-agent-key-abc",
    base_url="https://inference-api.nousresearch.com/v1",
)


def _make_node(params=None):
    return GraphNode(
        id="test-nous-1",
        definitionId="nous-portal-universal",
        params=params or {"model": "nousresearch/hermes-4-70b", "max_tokens": 256},
    )


@pytest.mark.asyncio
async def test_raises_when_not_authenticated():
    """Handler must surface NousNotAuthenticatedError as RuntimeError with a clear message."""
    with patch(
        "handlers.nous_portal.load_nous_credential",
        side_effect=NousNotAuthenticatedError("Run hermes-daedalus model to authenticate"),
    ):
        with pytest.raises(RuntimeError, match="hermes"):
            await handle_nous_portal_universal(
                _make_node(),
                {"messages": PortValueDict(type="Text", value="Hello")},
                {},
            )


@pytest.mark.asyncio
async def test_raises_when_no_model():
    """Handler must raise ValueError when model param is empty."""
    with patch("handlers.nous_portal.load_nous_credential", return_value=_FAKE_CRED):
        with pytest.raises(ValueError, match="[Nn]o model"):
            await handle_nous_portal_universal(
                _make_node({"model": ""}),
                {"messages": PortValueDict(type="Text", value="Hello")},
                {},
            )


@pytest.mark.asyncio
async def test_raises_when_no_messages():
    """Handler must raise ValueError when messages input is missing."""
    with patch("handlers.nous_portal.load_nous_credential", return_value=_FAKE_CRED):
        with pytest.raises(ValueError, match="[Mm]essages"):
            await handle_nous_portal_universal(
                _make_node(),
                {},
                {},
            )


@pytest.mark.asyncio
async def test_text_streaming_returns_text():
    """Handler streams chat completions and returns Text output port value."""
    with patch("handlers.nous_portal.load_nous_credential", return_value=_FAKE_CRED):
        with patch("handlers.nous_portal.stream_execute", new_callable=AsyncMock) as mock_stream:
            mock_stream.return_value = "Hello from Hermes!"
            result = await handle_nous_portal_universal(
                _make_node(),
                {"messages": PortValueDict(type="Text", value="Hi")},
                {},
                emit=AsyncMock(),
            )

    assert result["text"]["type"] == "Text"
    assert result["text"]["value"] == "Hello from Hermes!"


@pytest.mark.asyncio
async def test_auth_header_uses_bearer_agent_key():
    """StreamConfig must send Authorization: Bearer <agent_key>.

    Verified 2026-05-17: Nous inference API returns HTTP 402 without auth.
    The agent_key from Hermes OAuth is the correct Bearer credential.
    envKeyName=[] is intentional — auth is Hermes-managed, not env-sourced.
    """
    with patch("handlers.nous_portal.load_nous_credential", return_value=_FAKE_CRED):
        with patch("handlers.nous_portal.stream_execute", new_callable=AsyncMock) as mock_stream:
            mock_stream.return_value = "ok"
            await handle_nous_portal_universal(
                _make_node(),
                {"messages": PortValueDict(type="Text", value="test")},
                {},
                emit=AsyncMock(),
            )

    call_kwargs = mock_stream.call_args.kwargs
    config = call_kwargs.get("config") or mock_stream.call_args[1].get("config")
    assert config.headers["Authorization"] == "Bearer sk-nous-agent-key-abc", (
        "Must use Bearer <agent_key> from Hermes credential, not any env var"
    )


@pytest.mark.asyncio
async def test_request_body_shape():
    """Request body must be OpenAI-compatible: model, messages, stream=True.

    The Nous Portal API is OpenAI-compatible (choices[0].delta.content SSE).
    Verified 2026-05-17: POST /v1/chat/completions with standard OpenAI body shape.
    """
    with patch("handlers.nous_portal.load_nous_credential", return_value=_FAKE_CRED):
        with patch("handlers.nous_portal.stream_execute", new_callable=AsyncMock) as mock_stream:
            mock_stream.return_value = "ok"
            await handle_nous_portal_universal(
                _make_node({"model": "nousresearch/hermes-4-405b", "max_tokens": 512, "temperature": 0.7}),
                {"messages": PortValueDict(type="Text", value="What is 2+2?")},
                {},
                emit=AsyncMock(),
            )

    call_kwargs = mock_stream.call_args.kwargs
    body = call_kwargs.get("request_body") or mock_stream.call_args[1].get("request_body")
    assert body["model"] == "nousresearch/hermes-4-405b"
    assert body["stream"] is True
    assert body["max_tokens"] == 512
    assert abs(body["temperature"] - 0.7) < 1e-6
    msgs = body["messages"]
    assert isinstance(msgs, list) and len(msgs) == 1
    assert msgs[0]["role"] == "user"


@pytest.mark.asyncio
async def test_stream_delta_path_is_openai_compatible():
    """StreamConfig delta_path must be 'choices.0.delta.content' (OpenAI SSE format).

    Both OpenRouter and Nous Portal use the same OpenAI-compatible SSE shape.
    """
    with patch("handlers.nous_portal.load_nous_credential", return_value=_FAKE_CRED):
        with patch("handlers.nous_portal.stream_execute", new_callable=AsyncMock) as mock_stream:
            mock_stream.return_value = "ok"
            await handle_nous_portal_universal(
                _make_node(),
                {"messages": PortValueDict(type="Text", value="hi")},
                {},
                emit=AsyncMock(),
            )

    call_kwargs = mock_stream.call_args.kwargs
    config = call_kwargs.get("config") or mock_stream.call_args[1].get("config")
    assert config.delta_path == "choices.0.delta.content"


@pytest.mark.asyncio
async def test_endpoint_url_uses_credential_base_url():
    """StreamConfig URL must be built from the credential's base_url, not hardcoded.

    This ensures that if Hermes records a different inference URL (e.g. a staging
    or enterprise endpoint), the handler honours it.
    """
    custom_cred = NousCredential(
        access_token="sk-custom",
        base_url="https://custom-inference.example.com/v1",
    )
    with patch("handlers.nous_portal.load_nous_credential", return_value=custom_cred):
        with patch("handlers.nous_portal.stream_execute", new_callable=AsyncMock) as mock_stream:
            mock_stream.return_value = "ok"
            await handle_nous_portal_universal(
                _make_node(),
                {"messages": PortValueDict(type="Text", value="hi")},
                {},
                emit=AsyncMock(),
            )

    call_kwargs = mock_stream.call_args.kwargs
    config = call_kwargs.get("config") or mock_stream.call_args[1].get("config")
    assert config.url == "https://custom-inference.example.com/v1/chat/completions"


@pytest.mark.asyncio
async def test_image_input_converted_to_image_url_block():
    """Image inputs must be converted to image_url content blocks in the message."""
    with patch("handlers.nous_portal.load_nous_credential", return_value=_FAKE_CRED):
        with patch("handlers.nous_portal.stream_execute", new_callable=AsyncMock) as mock_stream:
            mock_stream.return_value = "ok"
            await handle_nous_portal_universal(
                _make_node(),
                {
                    "messages": PortValueDict(type="Text", value="Describe this image"),
                    "images": PortValueDict(type="Image", value="https://example.com/photo.jpg"),
                },
                {},
                emit=AsyncMock(),
            )

    call_kwargs = mock_stream.call_args.kwargs
    body = call_kwargs.get("request_body") or mock_stream.call_args[1].get("request_body")
    content = body["messages"][0]["content"]
    assert isinstance(content, list)
    text_blocks = [b for b in content if b.get("type") == "text"]
    image_blocks = [b for b in content if b.get("type") == "image_url"]
    assert len(text_blocks) == 1
    assert len(image_blocks) == 1
    assert image_blocks[0]["image_url"]["url"] == "https://example.com/photo.jpg"
