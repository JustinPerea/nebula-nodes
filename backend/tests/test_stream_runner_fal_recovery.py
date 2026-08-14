"""FAL streaming artifact recovery (N-04).

Covers:
- FAL request ID extraction (SSE event payload + response header) and persistence
- Expanded ``_parse_image_event()`` final-event schemas (images array, bare url,
  output/result wrappers, OpenAI-passthrough event types in the data payload)
- Retrieval fallback via ``GET {base}/requests/{request_id}/status`` when the
  stream ends without a recognized final image event
- Enriched error (request ID + raw event summary) when all recovery fails
"""

from __future__ import annotations

import base64
import json
from pathlib import Path

import pytest
import respx
from httpx import Response

from execution.stream_runner import StreamConfig, stream_execute_image
from models.events import ExecutionEvent, StreamPartialImageEvent

PNG_BYTES = b"\x89PNG\r\n\x1a\n-fake-image-bytes"
PNG_B64 = base64.b64encode(PNG_BYTES).decode()

STREAM_URL = "https://queue.fal.run/openai/gpt-image-2/stream"
STATUS_URL = "https://queue.fal.run/openai/gpt-image-2/requests/req-123/status"
RESULT_URL = "https://queue.fal.run/openai/gpt-image-2/requests/req-123"
CDN_URL = "https://v3.fal.media/files/x/final.png"
CDN_URL_WEBP = "https://v3.fal.media/files/z/final.webp"


def _sse(*events: object) -> bytes:
    lines: list[str] = []
    for ev in events:
        payload = ev if isinstance(ev, str) else json.dumps(ev)
        lines.append(f"data: {payload}")
        lines.append("")
    lines.append("data: [DONE]")
    lines.append("")
    return "\n".join(lines).encode()


def _config(url: str = STREAM_URL) -> StreamConfig:
    return StreamConfig(url=url, headers={"Authorization": "Key test"})


class _Emitter:
    def __init__(self) -> None:
        self.events: list[ExecutionEvent] = []

    async def __call__(self, event: ExecutionEvent) -> None:
        self.events.append(event)

    @property
    def partials(self) -> list[StreamPartialImageEvent]:
        return [e for e in self.events if isinstance(e, StreamPartialImageEvent)]


# ── Request ID extraction + retrieval fallback (VAL-INFRA-007 / VAL-INFRA-008) ──


@pytest.mark.asyncio
@respx.mock
async def test_request_id_extracted_from_sse_event_drives_retrieval(tmp_path: Path) -> None:
    """Stream carries request_id in status events but no final image → the runner
    must persist the ID and use it to poll .../requests/{request_id}/status, then
    fetch the result payload and return the image normally."""
    sse = _sse(
        {"status": "IN_QUEUE", "request_id": "req-123", "queue_position": 1},
        {"status": "IN_PROGRESS", "request_id": "req-123", "logs": []},
    )
    respx.post(STREAM_URL).mock(
        return_value=Response(200, content=sse, headers={"content-type": "text/event-stream"})
    )
    status_route = respx.get(STATUS_URL).mock(
        return_value=Response(200, json={
            "status": "COMPLETED",
            "request_id": "req-123",
            "response_url": RESULT_URL,
        })
    )
    result_route = respx.get(RESULT_URL).mock(
        return_value=Response(200, json={"images": [{"url": CDN_URL, "content_type": "image/png"}]})
    )
    cdn_route = respx.get(CDN_URL).mock(
        return_value=Response(200, content=PNG_BYTES, headers={"content-type": "image/png"})
    )

    emitter = _Emitter()
    final = await stream_execute_image(
        config=_config(),
        request_body={"prompt": "hi"},
        node_id="n1",
        emit=emitter,
        run_dir=tmp_path,
        provider="fal",
        recovery_poll_interval=0,
    )

    assert status_route.called, "retrieval must hit the status endpoint with the persisted request ID"
    assert result_route.called
    assert cdn_route.called
    assert Path(final).exists()
    assert final.endswith(".png")
    assert Path(final).read_bytes() == PNG_BYTES


@pytest.mark.asyncio
@respx.mock
async def test_request_id_extracted_from_response_header_drives_retrieval(tmp_path: Path) -> None:
    """When no event carries a request_id, the x-fal-request-id response header
    must be used. Image payload embedded directly in the COMPLETED status
    response is accepted without a separate result fetch."""
    sse = _sse({"status": "IN_PROGRESS", "logs": []})
    respx.post(STREAM_URL).mock(
        return_value=Response(
            200,
            content=sse,
            headers={"content-type": "text/event-stream", "x-fal-request-id": "req-123"},
        )
    )
    status_route = respx.get(STATUS_URL).mock(
        return_value=Response(200, json={
            "status": "COMPLETED",
            "request_id": "req-123",
            "images": [{"b64_json": PNG_B64, "content_type": "image/png"}],
        })
    )

    emitter = _Emitter()
    final = await stream_execute_image(
        config=_config(),
        request_body={"prompt": "hi"},
        node_id="n1",
        emit=emitter,
        run_dir=tmp_path,
        provider="fal",
        recovery_poll_interval=0,
    )

    assert status_route.called
    assert Path(final).exists()
    assert Path(final).read_bytes() == PNG_BYTES


@pytest.mark.asyncio
@respx.mock
async def test_retrieval_polls_until_completed(tmp_path: Path) -> None:
    """If the stream drops while the job is still running, recovery polls the
    status endpoint until COMPLETED instead of giving up immediately."""
    sse = _sse({"status": "IN_PROGRESS", "request_id": "req-123", "logs": []})
    respx.post(STREAM_URL).mock(
        return_value=Response(200, content=sse, headers={"content-type": "text/event-stream"})
    )
    status_route = respx.get(STATUS_URL).mock(
        side_effect=[
            Response(200, json={"status": "IN_PROGRESS", "request_id": "req-123"}),
            Response(200, json={
                "status": "COMPLETED",
                "request_id": "req-123",
                "images": [{"b64_json": PNG_B64}],
            }),
        ]
    )

    emitter = _Emitter()
    final = await stream_execute_image(
        config=_config(),
        request_body={"prompt": "hi"},
        node_id="n1",
        emit=emitter,
        run_dir=tmp_path,
        provider="fal",
        recovery_poll_interval=0,
    )

    assert status_route.call_count == 2
    assert Path(final).exists()


@pytest.mark.asyncio
@respx.mock
async def test_partials_emitted_before_successful_recovery(tmp_path: Path) -> None:
    """Partial frames parsed before the stream breaks must still be emitted;
    the final image then comes from retrieval."""
    sse = _sse(
        {"type": "image.partial", "image": {"partial_index": 0, "b64_json": PNG_B64}},
        {"status": "IN_PROGRESS", "request_id": "req-123"},
    )
    respx.post(STREAM_URL).mock(
        return_value=Response(200, content=sse, headers={"content-type": "text/event-stream"})
    )
    respx.get(STATUS_URL).mock(
        return_value=Response(200, json={
            "status": "COMPLETED",
            "request_id": "req-123",
            "images": [{"b64_json": PNG_B64}],
        })
    )

    emitter = _Emitter()
    final = await stream_execute_image(
        config=_config(),
        request_body={"prompt": "hi"},
        node_id="n1",
        emit=emitter,
        run_dir=tmp_path,
        provider="fal",
        recovery_poll_interval=0,
    )

    assert [p.partial_index for p in emitter.partials] == [0]
    assert Path(emitter.partials[0].src).exists()
    assert Path(final).exists()


# ── Expanded final-event schemas ──────────────────────────────────────────────


@pytest.mark.asyncio
@respx.mock
async def test_final_event_images_array_url_schema(tmp_path: Path) -> None:
    """Standard FAL result shape as a stream event: {"images": [{"url": ...}]}."""
    sse = _sse(
        {"type": "image.partial", "image": {"partial_index": 0, "b64_json": PNG_B64}},
        {"images": [{"url": CDN_URL, "content_type": "image/png"}]},
    )
    respx.post(STREAM_URL).mock(
        return_value=Response(200, content=sse, headers={"content-type": "text/event-stream"})
    )
    cdn_route = respx.get(CDN_URL).mock(
        return_value=Response(200, content=PNG_BYTES, headers={"content-type": "image/png"})
    )

    emitter = _Emitter()
    final = await stream_execute_image(
        config=_config(),
        request_body={"prompt": "hi"},
        node_id="n1",
        emit=emitter,
        run_dir=tmp_path,
        provider="fal",
    )

    assert [p.partial_index for p in emitter.partials] == [0]
    assert cdn_route.called
    assert Path(final).exists()
    assert final.endswith(".png")


@pytest.mark.asyncio
@respx.mock
async def test_final_event_result_wrapper_schema(tmp_path: Path) -> None:
    """Result nested under a "result" key: {"result": {"image": {"url": ...}}}."""
    sse = _sse({"result": {"image": {"url": CDN_URL_WEBP}}})
    respx.post(STREAM_URL).mock(
        return_value=Response(200, content=sse, headers={"content-type": "text/event-stream"})
    )
    cdn_route = respx.get(CDN_URL_WEBP).mock(
        return_value=Response(200, content=b"webp-bytes", headers={"content-type": "image/webp"})
    )

    emitter = _Emitter()
    final = await stream_execute_image(
        config=_config(),
        request_body={"prompt": "hi"},
        node_id="n1",
        emit=emitter,
        run_dir=tmp_path,
        provider="fal",
    )

    assert cdn_route.called
    assert Path(final).exists()
    assert final.endswith(".webp")


@pytest.mark.asyncio
@respx.mock
async def test_final_event_output_field_schema(tmp_path: Path) -> None:
    """Result nested under an "output" key with b64 payload: {"output": {"images": [...]}}."""
    sse = _sse({"output": {"images": [{"b64_json": PNG_B64}]}})
    respx.post(STREAM_URL).mock(
        return_value=Response(200, content=sse, headers={"content-type": "text/event-stream"})
    )

    emitter = _Emitter()
    final = await stream_execute_image(
        config=_config(),
        request_body={"prompt": "hi"},
        node_id="n1",
        emit=emitter,
        run_dir=tmp_path,
        provider="fal",
    )

    assert Path(final).exists()
    assert Path(final).read_bytes() == PNG_BYTES


@pytest.mark.asyncio
@respx.mock
async def test_final_event_image_completed_with_url(tmp_path: Path) -> None:
    """Recognized completed type carrying a URL instead of b64_json."""
    sse = _sse({"type": "image.completed", "image": {"url": CDN_URL}})
    respx.post(STREAM_URL).mock(
        return_value=Response(200, content=sse, headers={"content-type": "text/event-stream"})
    )
    respx.get(CDN_URL).mock(
        return_value=Response(200, content=PNG_BYTES, headers={"content-type": "image/png"})
    )

    emitter = _Emitter()
    final = await stream_execute_image(
        config=_config(),
        request_body={"prompt": "hi"},
        node_id="n1",
        emit=emitter,
        run_dir=tmp_path,
        provider="fal",
    )

    assert Path(final).exists()
    assert Path(final).read_bytes() == PNG_BYTES


@pytest.mark.asyncio
@respx.mock
async def test_openai_passthrough_event_types_in_data_payload(tmp_path: Path) -> None:
    """FAL may pass OpenAI's event shapes through verbatim in the data payload
    (type field inside JSON rather than nested image.* schema)."""
    sse = _sse(
        {"type": "image_generation.partial_image", "b64_json": PNG_B64, "partial_image_index": 0},
        {"type": "image_generation.completed", "b64_json": PNG_B64},
    )
    respx.post(STREAM_URL).mock(
        return_value=Response(200, content=sse, headers={"content-type": "text/event-stream"})
    )

    emitter = _Emitter()
    final = await stream_execute_image(
        config=_config(),
        request_body={"prompt": "hi"},
        node_id="n1",
        emit=emitter,
        run_dir=tmp_path,
        provider="fal",
    )

    assert [p.partial_index for p in emitter.partials] == [0]
    assert Path(final).exists()
    assert Path(final).read_bytes() == PNG_BYTES


# ── Enriched errors when recovery fails (VAL-INFRA-008) ───────────────────────


@pytest.mark.asyncio
@respx.mock
async def test_retrieval_failure_error_includes_request_id_and_event_summary(tmp_path: Path) -> None:
    sse = _sse(
        {"status": "IN_PROGRESS", "request_id": "req-123"},
        {"unexpected": "payload"},
    )
    respx.post(STREAM_URL).mock(
        return_value=Response(200, content=sse, headers={"content-type": "text/event-stream"})
    )
    respx.get(STATUS_URL).mock(return_value=Response(404, json={"detail": "not found"}))

    emitter = _Emitter()
    with pytest.raises(RuntimeError) as excinfo:
        await stream_execute_image(
            config=_config(),
            request_body={"prompt": "hi"},
            node_id="n1",
            emit=emitter,
            run_dir=tmp_path,
            provider="fal",
            recovery_poll_interval=0,
        )

    msg = str(excinfo.value)
    assert "req-123" in msg, "error must include the FAL request ID"
    assert "unexpected" in msg, "error must include a raw event summary"


@pytest.mark.asyncio
@respx.mock
async def test_no_request_id_error_includes_event_summary(tmp_path: Path) -> None:
    sse = _sse({"mystery": "event"})
    respx.post(STREAM_URL).mock(
        return_value=Response(200, content=sse, headers={"content-type": "text/event-stream"})
    )

    emitter = _Emitter()
    with pytest.raises(RuntimeError) as excinfo:
        await stream_execute_image(
            config=_config(),
            request_body={"prompt": "hi"},
            node_id="n1",
            emit=emitter,
            run_dir=tmp_path,
            provider="fal",
            recovery_poll_interval=0,
        )

    msg = str(excinfo.value)
    assert "without a final image event" in msg
    assert "unavailable" in msg  # request ID placeholder when none was captured
    assert "mystery" in msg


@pytest.mark.asyncio
@respx.mock
async def test_failed_job_status_surfaces_in_error(tmp_path: Path) -> None:
    sse = _sse({"status": "IN_PROGRESS", "request_id": "req-123"})
    respx.post(STREAM_URL).mock(
        return_value=Response(200, content=sse, headers={"content-type": "text/event-stream"})
    )
    respx.get(STATUS_URL).mock(
        return_value=Response(200, json={
            "status": "FAILED",
            "request_id": "req-123",
            "error": "content policy violation",
        })
    )

    emitter = _Emitter()
    with pytest.raises(RuntimeError) as excinfo:
        await stream_execute_image(
            config=_config(),
            request_body={"prompt": "hi"},
            node_id="n1",
            emit=emitter,
            run_dir=tmp_path,
            provider="fal",
            recovery_poll_interval=0,
        )

    msg = str(excinfo.value)
    assert "req-123" in msg
    assert "content policy violation" in msg
