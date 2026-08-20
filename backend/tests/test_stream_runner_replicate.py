from __future__ import annotations

from unittest.mock import AsyncMock, patch

import pytest

from execution.stream_runner import stream_execute_replicate
from handlers.replicate_universal import _classify_stream_output_prefix
from models.events import StreamDeltaEvent


class _FakeStreamResponse:
    def __init__(self, lines, status_code=200):
        self._lines = lines
        self.status_code = status_code

    async def __aenter__(self):
        return self

    async def __aexit__(self, *exc):
        return False

    async def aiter_lines(self):
        for ln in self._lines:
            yield ln

    async def aiter_text(self):
        yield ""


class _FakeClient:
    def __init__(self, response):
        self._response = response
        self.stream_calls = []

    async def __aenter__(self):
        return self

    async def __aexit__(self, *exc):
        return False

    def stream(self, method, url, headers=None):
        self.stream_calls.append((method, url, headers))
        return self._response


def _patch_client(lines, status_code=200):
    resp = _FakeStreamResponse(lines, status_code=status_code)
    client = _FakeClient(resp)
    return patch("execution.stream_runner.httpx.AsyncClient", return_value=client), client


@pytest.mark.asyncio
async def test_output_events_accumulate_as_text_and_emit_deltas():
    """Replicate `output` SSE events are plain-text token deltas: concatenate them,
    emit one StreamDeltaEvent per event, and stop on `done`."""
    lines = [
        "event: output",
        "data: Hello",
        "",
        "event: output",
        "data:  world",
        "",
        "event: done",
        "data: {}",
        "",
    ]
    cm, _client = _patch_client(lines)
    emit = AsyncMock()
    with cm:
        result = await stream_execute_replicate(
            stream_url="https://stream.replicate.com/v1/files/abc",
            headers={"Authorization": "Bearer r8_test"},
            node_id="node-1",
            emit=emit,
        )

    assert result == "Hello world"
    deltas = [c.args[0].delta for c in emit.call_args_list]
    assert deltas == ["Hello", " world"]
    assert all(isinstance(c.args[0], StreamDeltaEvent) for c in emit.call_args_list)
    assert emit.call_args_list[-1].args[0].accumulated == "Hello world"


@pytest.mark.asyncio
async def test_classified_text_retains_original_delta_events():
    """The media guard must not coalesce, delay beyond classification, or drop text deltas."""
    lines = [
        "event: output",
        "data: Hello",
        "",
        "event: output",
        "data:  world",
        "",
        "event: done",
        "data: {}",
        "",
    ]
    cm, _client = _patch_client(lines)
    emit = AsyncMock()
    with cm:
        result = await stream_execute_replicate(
            stream_url="https://stream.replicate.com/v1/files/text",
            headers={"Authorization": "Bearer r8_test"},
            node_id="node-text",
            emit=emit,
            classify_output_prefix=_classify_stream_output_prefix,
        )

    assert result == "Hello world"
    events = [call.args[0] for call in emit.call_args_list]
    assert [(event.delta, event.accumulated) for event in events] == [
        ("Hello", "Hello"),
        (" world", "Hello world"),
    ]


@pytest.mark.asyncio
async def test_split_media_data_uri_is_buffered_without_stream_events():
    """No header fragment or base64 chunk may escape through text telemetry."""
    chunks = ["da", "ta:image/webp;", "base64,UklGRgAA", "AABXRUJQ"]
    lines: list[str] = []
    for chunk in chunks:
        lines.extend(["event: output", f"data: {chunk}", ""])
    lines.extend(["event: done", "data: {}", ""])

    cm, _client = _patch_client(lines)
    emit = AsyncMock()
    with cm:
        result = await stream_execute_replicate(
            stream_url="https://stream.replicate.com/v1/files/image",
            headers={"Authorization": "Bearer r8_test"},
            node_id="node-image",
            emit=emit,
            classify_output_prefix=_classify_stream_output_prefix,
        )

    assert result == "".join(chunks)
    assert "base64," in result
    assert emit.await_count == 0


@pytest.mark.asyncio
async def test_ambiguous_data_prefix_flushes_as_text_with_original_boundaries():
    """Text beginning like a data URI stays lossless once it is no longer ambiguous."""
    lines = [
        "event: output",
        "data: da",
        "",
        "event: output",
        "data: ylight",
        "",
        "event: output",
        "data:  remains",
        "",
        "event: done",
        "data: {}",
        "",
    ]
    cm, _client = _patch_client(lines)
    emit = AsyncMock()
    with cm:
        result = await stream_execute_replicate(
            stream_url="https://stream.replicate.com/v1/files/ambiguous-text",
            headers={"Authorization": "Bearer r8_test"},
            node_id="node-ambiguous",
            emit=emit,
            classify_output_prefix=_classify_stream_output_prefix,
        )

    assert result == "daylight remains"
    events = [call.args[0] for call in emit.call_args_list]
    assert [(event.delta, event.accumulated) for event in events] == [
        ("da", "da"),
        ("ylight", "daylight"),
        (" remains", "daylight remains"),
    ]


@pytest.mark.asyncio
async def test_output_data_is_taken_verbatim_not_json_parsed():
    """Regression guard: unlike Anthropic/OpenAI deltas, Replicate `output` data is RAW
    text — it must NOT be json.loads'd (which would silently drop non-JSON tokens)."""
    lines = [
        "event: output",
        "data: {not valid json",
        "",
        "event: done",
        "data: {}",
        "",
    ]
    cm, _client = _patch_client(lines)
    emit = AsyncMock()
    with cm:
        result = await stream_execute_replicate(
            stream_url="https://stream.replicate.com/v1/files/abc",
            headers={"Authorization": "Bearer r8_test"},
            node_id="node-1",
            emit=emit,
        )

    assert result == "{not valid json"


@pytest.mark.asyncio
async def test_error_event_raises_with_detail():
    """An `error` SSE event surfaces its JSON `detail` as a RuntimeError."""
    lines = [
        "event: error",
        'data: {"detail": "boom"}',
        "",
    ]
    cm, _client = _patch_client(lines)
    emit = AsyncMock()
    with cm:
        with pytest.raises(RuntimeError, match="boom"):
            await stream_execute_replicate(
                stream_url="https://stream.replicate.com/v1/files/abc",
                headers={"Authorization": "Bearer r8_test"},
                node_id="node-1",
                emit=emit,
            )


@pytest.mark.asyncio
async def test_sends_accept_event_stream_header():
    """The stream GET must advertise Accept: text/event-stream alongside auth."""
    lines = ["event: done", "data: {}", ""]
    cm, client = _patch_client(lines)
    emit = AsyncMock()
    with cm:
        await stream_execute_replicate(
            stream_url="https://stream.replicate.com/v1/files/abc",
            headers={"Authorization": "Bearer r8_test"},
            node_id="node-1",
            emit=emit,
        )

    method, url, headers = client.stream_calls[0]
    assert method == "GET"
    assert headers.get("Accept") == "text/event-stream"
    assert headers.get("Authorization") == "Bearer r8_test"


@pytest.mark.asyncio
async def test_non_200_raises():
    lines = ["nope"]
    cm, _client = _patch_client(lines, status_code=404)
    emit = AsyncMock()
    with cm:
        with pytest.raises(RuntimeError, match="404"):
            await stream_execute_replicate(
                stream_url="https://stream.replicate.com/v1/files/abc",
                headers={"Authorization": "Bearer r8_test"},
                node_id="node-1",
                emit=emit,
            )


@pytest.mark.asyncio
async def test_multiline_data_joined_with_newline():
    """Multiple data: lines in one event are one delta, joined per the SSE spec."""
    lines = ["event: output", "data: a", "data: b", "", "event: done", "data: {}", ""]
    cm, _client = _patch_client(lines)
    emit = AsyncMock()
    with cm:
        result = await stream_execute_replicate(
            stream_url="https://stream.replicate.com/v1/files/abc",
            headers={"Authorization": "Bearer r8_test"}, node_id="n", emit=emit,
        )
    assert result == "a\nb"
    assert [c.args[0].delta for c in emit.call_args_list] == ["a\nb"]


@pytest.mark.asyncio
async def test_id_and_comment_lines_ignored():
    """`id:` reconnection cursors and `:` keepalive comments carry no payload."""
    lines = ["event: output", "id: 1690:0", "data: hi", ": 408 keepalive", "",
             "event: done", "data: {}", ""]
    cm, _client = _patch_client(lines)
    emit = AsyncMock()
    with cm:
        result = await stream_execute_replicate(
            stream_url="https://stream.replicate.com/v1/files/abc",
            headers={"Authorization": "Bearer r8_test"}, node_id="n", emit=emit,
        )
    assert result == "hi"
    assert [c.args[0].delta for c in emit.call_args_list] == ["hi"]


@pytest.mark.asyncio
async def test_premature_close_without_done_raises():
    """A stream that ends before `done` must FAIL, not report truncated text as success."""
    lines = ["event: output", "data: Hello", ""]  # no done event
    cm, _client = _patch_client(lines)
    emit = AsyncMock()
    with cm:
        with pytest.raises(RuntimeError, match="done"):
            await stream_execute_replicate(
                stream_url="https://stream.replicate.com/v1/files/abc",
                headers={"Authorization": "Bearer r8_test"}, node_id="n", emit=emit,
            )
    # the delta still surfaced live before the failure
    assert [c.args[0].delta for c in emit.call_args_list] == ["Hello"]


@pytest.mark.asyncio
async def test_trailing_output_without_blank_line_is_flushed_then_raises():
    """A final output event with no terminating blank line is still emitted, then the
    missing-done close fails loud (no silent token drop)."""
    lines = ["event: output", "data: World"]  # no blank, no done
    cm, _client = _patch_client(lines)
    emit = AsyncMock()
    with cm:
        with pytest.raises(RuntimeError, match="done"):
            await stream_execute_replicate(
                stream_url="https://stream.replicate.com/v1/files/abc",
                headers={"Authorization": "Bearer r8_test"}, node_id="n", emit=emit,
            )
    assert [c.args[0].delta for c in emit.call_args_list] == ["World"]


@pytest.mark.asyncio
async def test_bare_error_event_without_detail_raises():
    """An `error` event with no data line must still raise (not be swallowed as success)."""
    lines = ["event: error", ""]
    cm, _client = _patch_client(lines)
    emit = AsyncMock()
    with cm:
        with pytest.raises(RuntimeError, match="error"):
            await stream_execute_replicate(
                stream_url="https://stream.replicate.com/v1/files/abc",
                headers={"Authorization": "Bearer r8_test"}, node_id="n", emit=emit,
            )
