"""Golden SSE fixtures for Google stream handlers."""

from __future__ import annotations

from pathlib import Path
from unittest.mock import AsyncMock, MagicMock, patch

import pytest

from handlers.google_gemini import handle_gemini_chat
from models.events import StreamDeltaEvent
from models.graph import GraphNode, PortValueDict

REPO_ROOT = Path(__file__).resolve().parents[2]
FIXTURES = REPO_ROOT / "contracts" / "fixtures" / "handlers" / "google"


@pytest.mark.asyncio
async def test_gemini_chat_sse_fixture_accumulates_text() -> None:
    """contracts/fixtures/handlers/google/gemini-chat-sse.txt → Gemini says hello!"""
    sse_bytes = (FIXTURES / "gemini-chat-sse.txt").read_bytes()
    collected: list[StreamDeltaEvent] = []

    async def capture_emit(event: StreamDeltaEvent) -> None:
        if isinstance(event, StreamDeltaEvent):
            collected.append(event)

    class FakeStreamResponse:
        status_code = 200

        def __init__(self, lines: list[str]) -> None:
            self._lines = lines

        async def aiter_lines(self):
            for line in self._lines:
                yield line

        async def aiter_text(self):
            yield ""

        async def __aenter__(self):
            return self

        async def __aexit__(self, *args):
            pass

    lines = sse_bytes.decode().splitlines()
    fake_response = FakeStreamResponse(lines)

    with patch("execution.stream_runner.httpx.AsyncClient") as MockClient:
        mock_client = AsyncMock()
        mock_client.stream = MagicMock(return_value=fake_response)
        mock_client.__aenter__ = AsyncMock(return_value=mock_client)
        mock_client.__aexit__ = AsyncMock(return_value=False)
        MockClient.return_value = mock_client

        result = await handle_gemini_chat(
            GraphNode(
                id="sse-fixture-gemini",
                definitionId="gemini-chat",
                params={"model": "gemini-2.5-flash", "max_tokens": 1024, "temperature": 1.0},
            ),
            {"messages": PortValueDict(type="Text", value="Say hello")},
            {"GOOGLE_API_KEY": "test-google-key"},
            emit=capture_emit,
        )

    assert result["text"]["value"] == "Gemini says hello!"
    assert [e.delta for e in collected] == ["Gemini", " says", " hello!"]

    call_args = mock_client.stream.call_args
    url = call_args.args[1] if len(call_args.args) > 1 else call_args.kwargs.get("url", "")
    assert "streamGenerateContent" in url
    assert "alt=sse" in url
