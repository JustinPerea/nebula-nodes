from __future__ import annotations

from pathlib import Path
from typing import Any

import pytest
import respx
from httpx import Response

from execution.stream_runner import StreamConfig, stream_execute_image
from models.events import ExecutionEvent, StreamPartialImageEvent


FIXTURE = Path(__file__).parent / "fixtures" / "openai_image_v2_sse.txt"


@pytest.mark.asyncio
@respx.mock
async def test_image_stream_emits_partials_and_returns_final(tmp_path: Path) -> None:
    sse_bytes = FIXTURE.read_bytes()
    respx.post("https://api.openai.com/v1/images/generations").mock(
        return_value=Response(200, content=sse_bytes, headers={"content-type": "text/event-stream"})
    )

    emitted: list[ExecutionEvent] = []

    async def emit(event: ExecutionEvent) -> None:
        emitted.append(event)

    config = StreamConfig(
        url="https://api.openai.com/v1/images/generations",
        headers={"Authorization": "Bearer test"},
    )
    final_path = await stream_execute_image(
        config=config,
        request_body={"model": "gpt-image-2", "prompt": "hi", "stream": True, "partial_images": 2},
        node_id="n1",
        emit=emit,
        run_dir=tmp_path,
        provider="openai",
    )

    partials = [e for e in emitted if isinstance(e, StreamPartialImageEvent)]
    assert [p.partial_index for p in partials] == [0, 1]
    assert all(Path(p.src).exists() for p in partials)
    assert all(not p.is_final for p in partials)
    assert Path(final_path).exists()
    assert final_path.endswith(".png")
