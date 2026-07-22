"""Golden SSE fixtures for FAL stream handlers."""

from __future__ import annotations

from pathlib import Path

import pytest
import respx
from httpx import Response

from execution.stream_runner import StreamConfig, stream_execute_image
from models.events import StreamPartialImageEvent

REPO_ROOT = Path(__file__).resolve().parents[2]
FIXTURES = REPO_ROOT / "contracts" / "fixtures" / "handlers" / "fal"


@pytest.mark.asyncio
@respx.mock
async def test_gpt_image_2_fal_edit_sse_fixture_emits_partial_and_final(tmp_path: Path) -> None:
    """contracts/fixtures/handlers/fal/gpt-image-2-fal-edit-sse.txt → 1 partial + final."""
    sse_bytes = (FIXTURES / "gpt-image-2-fal-edit-sse.txt").read_bytes()
    respx.post("https://queue.fal.run/openai/gpt-image-2/edit/stream").mock(
        return_value=Response(200, content=sse_bytes, headers={"content-type": "text/event-stream"})
    )

    emitted: list[object] = []

    async def emit(event: object) -> None:
        emitted.append(event)

    final_path = await stream_execute_image(
        config=StreamConfig(
            url="https://queue.fal.run/openai/gpt-image-2/edit/stream",
            headers={"Authorization": "Key test"},
        ),
        request_body={"prompt": "make it night", "image_urls": ["https://example.com/img.png"]},
        node_id="sse-fixture-fal-edit",
        emit=emit,
        run_dir=tmp_path,
        provider="fal",
    )

    partials = [e for e in emitted if isinstance(e, StreamPartialImageEvent)]
    assert len(partials) == 1
    assert partials[0].partial_index == 0
    assert Path(final_path).exists()
