from __future__ import annotations

import base64
import json
import shutil
from pathlib import Path
from unittest.mock import AsyncMock, MagicMock, patch

import pytest

from handlers.google_gemini import handle_gemini_chat, handle_imagen4
from models.graph import GraphNode, PortValueDict
from models.events import StreamDeltaEvent
from services.output import OUTPUT_ROOT


RED_PIXEL_B64 = (
    "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR4"
    "2mP8/5+hHgAHggJ/PchI7wAAAABJRU5ErkJggg=="
)


def _make_gemini_node(params=None):
    return GraphNode(
        id="test-gemini-1",
        definitionId="gemini-chat",
        params=params or {"model": "gemini-2.5-flash", "max_tokens": 1024, "temperature": 1.0},
    )


def _make_imagen_node(params=None):
    return GraphNode(
        id="test-imagen-1",
        definitionId="imagen-4-generate",
        params=params or {"model": "imagen-4.0-generate-001", "aspectRatio": "1:1", "numberOfImages": 1},
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


def _make_gemini_sse_lines(text_chunks):
    """Build Gemini-style SSE lines (candidates array format)."""
    lines = []
    for chunk in text_chunks:
        data = {
            "candidates": [
                {
                    "content": {
                        "parts": [{"text": chunk}],
                        "role": "model",
                    },
                    "finishReason": None,
                    "index": 0,
                }
            ]
        }
        lines.append(f"data: {json.dumps(data)}")
        lines.append("")
    return lines


@pytest.fixture(autouse=True)
def cleanup_output():
    yield
    if OUTPUT_ROOT.exists():
        shutil.rmtree(OUTPUT_ROOT)


# --- Gemini chat tests ---

@pytest.mark.asyncio
async def test_gemini_streams_text_and_returns_accumulated():
    chunks = ["Gemini", " says", " hello!"]
    fake_response = FakeStreamResponse(_make_gemini_sse_lines(chunks))
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

        result = await handle_gemini_chat(
            _make_gemini_node(),
            {"messages": PortValueDict(type="Text", value="Say hello")},
            {"GOOGLE_API_KEY": "test-google-key"},
            emit=capture_emit,
        )

    assert result["text"]["value"] == "Gemini says hello!"
    assert len(collected) == 3

    # stream("POST", url, ...) — url is the second positional arg
    call_args = mock_client.stream.call_args
    pos_args = call_args.args if call_args.args else call_args[0]
    url = pos_args[1] if len(pos_args) > 1 else call_args.kwargs.get("url", "")
    assert "streamGenerateContent" in url
    assert "alt=sse" in url
    # Auth is via x-goog-api-key header, not query param
    headers = call_args.kwargs.get("headers", {})
    assert headers.get("x-goog-api-key") == "test-google-key"


@pytest.mark.asyncio
async def test_gemini_missing_messages_raises():
    with pytest.raises(ValueError, match="[Mm]essages.*required"):
        await handle_gemini_chat(_make_gemini_node(), {}, {"GOOGLE_API_KEY": "key"})


@pytest.mark.asyncio
async def test_gemini_missing_api_key_raises():
    with pytest.raises(ValueError, match="GOOGLE_API_KEY"):
        await handle_gemini_chat(
            _make_gemini_node(),
            {"messages": PortValueDict(type="Text", value="hi")},
            {},
        )


@pytest.mark.asyncio
async def test_gemini_request_body_structure():
    fake_response = FakeStreamResponse(_make_gemini_sse_lines(["ok"]))

    with patch("execution.stream_runner.httpx.AsyncClient") as MockClient:
        mock_client = AsyncMock()
        mock_client.stream = MagicMock(return_value=fake_response)
        mock_client.__aenter__ = AsyncMock(return_value=mock_client)
        mock_client.__aexit__ = AsyncMock(return_value=False)
        MockClient.return_value = mock_client

        await handle_gemini_chat(
            _make_gemini_node({"model": "gemini-2.5-pro", "temperature": 0.7, "max_tokens": 2048}),
            {"messages": PortValueDict(type="Text", value="test")},
            {"GOOGLE_API_KEY": "test-key"},
        )

    body = mock_client.stream.call_args.kwargs.get("json") or mock_client.stream.call_args[1].get("json")
    assert body["contents"][0]["role"] == "user"
    assert body["contents"][0]["parts"][0]["text"] == "test"
    assert body["generationConfig"]["temperature"] == 0.7
    assert body["generationConfig"]["maxOutputTokens"] == 2048


# --- Imagen 4 tests ---

@pytest.mark.asyncio
async def test_imagen4_generates_image_and_saves_file():
    mock_resp = MagicMock()
    mock_resp.status_code = 200
    mock_resp.json.return_value = {
        "predictions": [
            {"bytesBase64Encoded": RED_PIXEL_B64, "mimeType": "image/png"}
        ]
    }

    with patch("handlers.google_gemini.httpx.AsyncClient") as MockClient:
        mock_client_instance = AsyncMock()
        mock_client_instance.post.return_value = mock_resp
        mock_client_instance.__aenter__ = AsyncMock(return_value=mock_client_instance)
        mock_client_instance.__aexit__ = AsyncMock(return_value=False)
        MockClient.return_value = mock_client_instance

        result = await handle_imagen4(
            _make_imagen_node(),
            {"prompt": PortValueDict(type="Text", value="a red pixel")},
            {"GOOGLE_API_KEY": "test-google-key"},
        )

    assert "image" in result
    assert result["image"]["type"] == "Image"
    file_path = Path(result["image"]["value"])
    assert file_path.suffix == ".png"

    call_kwargs = mock_client_instance.post.call_args
    url = call_kwargs.args[0] if call_kwargs.args else call_kwargs.kwargs.get("url", "")
    assert "generateImages" in url
    # Auth is via x-goog-api-key header, not query param
    headers = call_kwargs.kwargs.get("headers", {})
    assert headers.get("x-goog-api-key") == "test-google-key"


@pytest.mark.asyncio
async def test_imagen4_missing_prompt_raises():
    with pytest.raises(ValueError, match="[Pp]rompt.*required"):
        await handle_imagen4(_make_imagen_node(), {}, {"GOOGLE_API_KEY": "key"})


@pytest.mark.asyncio
async def test_imagen4_missing_api_key_raises():
    with pytest.raises(ValueError, match="GOOGLE_API_KEY"):
        await handle_imagen4(
            _make_imagen_node(),
            {"prompt": PortValueDict(type="Text", value="test")},
            {},
        )


@pytest.mark.asyncio
async def test_imagen4_api_error_propagates():
    mock_resp = MagicMock()
    mock_resp.status_code = 403
    mock_resp.text = "Forbidden"

    with patch("handlers.google_gemini.httpx.AsyncClient") as MockClient:
        mock_client_instance = AsyncMock()
        mock_client_instance.post.return_value = mock_resp
        mock_client_instance.__aenter__ = AsyncMock(return_value=mock_client_instance)
        mock_client_instance.__aexit__ = AsyncMock(return_value=False)
        MockClient.return_value = mock_client_instance

        with pytest.raises(RuntimeError, match="Imagen 4 API error 403"):
            await handle_imagen4(
                _make_imagen_node(),
                {"prompt": PortValueDict(type="Text", value="test")},
                {"GOOGLE_API_KEY": "bad-key"},
            )
