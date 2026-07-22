"""Golden SSE fixtures for OpenAI stream handlers."""

from __future__ import annotations

from pathlib import Path
from unittest.mock import AsyncMock, MagicMock, patch

import pytest
import respx
from httpx import Response

from execution.stream_runner import StreamConfig, stream_execute
from handlers.openai_image_v2 import handle_gpt_image_2_edit
from models.events import StreamDeltaEvent, StreamPartialImageEvent
from models.graph import GraphNode, PortValueDict

REPO_ROOT = Path(__file__).resolve().parents[2]
FIXTURES = REPO_ROOT / "contracts" / "fixtures" / "handlers" / "openai"

PNG_BYTES = b"\x89PNG\r\n\x1a\n" + b"\x00" * 16


@pytest.mark.asyncio
async def test_gpt_4o_chat_sse_fixture_accumulates_text() -> None:
    """contracts/fixtures/handlers/openai/gpt-4o-chat-sse.txt → Hello, world!"""
    sse_bytes = (FIXTURES / "gpt-4o-chat-sse.txt").read_bytes()
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

        text = await stream_execute(
            config=StreamConfig(
                url="https://api.openai.com/v1/chat/completions",
                headers={"Authorization": "Bearer test"},
                delta_path="choices.0.delta.content",
                timeout=30.0,
            ),
            request_body={"model": "gpt-4o", "messages": [], "stream": True},
            node_id="sse-fixture-chat",
            emit=capture_emit,
        )

    assert text == "Hello, world!"
    assert [e.delta for e in collected] == ["Hello", ", ", "world!"]


@pytest.mark.asyncio
@respx.mock
async def test_gpt_image_2_edit_sse_fixture_emits_partial_and_final(tmp_path: Path) -> None:
    """contracts/fixtures/handlers/openai/gpt-image-2-edit-sse.txt → 1 partial + final image."""
    sse_bytes = (FIXTURES / "gpt-image-2-edit-sse.txt").read_bytes()
    respx.post("https://api.openai.com/v1/images/edits").mock(
        return_value=Response(200, content=sse_bytes, headers={"content-type": "text/event-stream"})
    )

    img = tmp_path / "input.png"
    img.write_bytes(PNG_BYTES)
    emitted: list[object] = []

    async def emit(event: object) -> None:
        emitted.append(event)

    out = await handle_gpt_image_2_edit(
        GraphNode(id="sse-fixture-edit", definitionId="gpt-image-2-edit", params={}),
        {
            "images": PortValueDict(type="Image", value=[str(img)]),
            "prompt": PortValueDict(type="Text", value="make it blue"),
        },
        api_keys={"OPENAI_API_KEY": "sk-test"},
        emit=emit,
        run_dir=tmp_path,
    )

    assert out["image"]["type"] == "Image"
    assert Path(out["image"]["value"]).exists()
    partials = [e for e in emitted if isinstance(e, StreamPartialImageEvent)]
    assert len(partials) == 1
    assert partials[0].partial_index == 0
