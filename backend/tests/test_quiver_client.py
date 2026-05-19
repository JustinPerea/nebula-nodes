"""Tests for backend/services/quiver_client.py.

Covers the parse-don't-talk-to-the-network layer (body builders,
SSE parser, header parser, status mapping) plus end-to-end paths
mocked via respx (401 / 402 / 429 retry / non-stream success /
streaming success / models list)."""

from __future__ import annotations

import json
from typing import AsyncIterator

import httpx
import pytest
import respx
from httpx import Response

from services.quiver_client import (
    QuiverAuthError,
    QuiverClient,
    QuiverError,
    QuiverEvent,
    QuiverInsufficientCreditsError,
    QuiverRateLimitError,
    QuiverServerError,
    _parse_retry_after,
    _raise_for_status,
    _rate_limit_from_headers,
    event_from_payload,
    model_from_payload,
    parse_sse_lines,
    response_from_payload,
)


# ---------- body builders ----------


def test_build_generate_body_minimal() -> None:
    body = QuiverClient.build_generate_body(model="arrow-1.1", prompt="green triangle")
    assert body == {"model": "arrow-1.1", "prompt": "green triangle", "stream": True}


def test_build_generate_body_with_all_knobs() -> None:
    body = QuiverClient.build_generate_body(
        model="arrow-1.1-max",
        prompt="logo",
        references=["https://a.png", "data:image/png;base64,AAAA"],
        n=3,
        instructions="thin stroke",
        temperature=0.7,
        top_p=0.9,
        presence_penalty=-0.1,
        max_output_tokens=8192,
        stream=False,
    )
    assert body["model"] == "arrow-1.1-max"
    assert body["prompt"] == "logo"
    assert body["references"] == ["https://a.png", "data:image/png;base64,AAAA"]
    assert body["n"] == 3
    assert body["instructions"] == "thin stroke"
    assert body["temperature"] == 0.7
    assert body["top_p"] == 0.9
    assert body["presence_penalty"] == -0.1
    assert body["max_output_tokens"] == 8192
    assert body["stream"] is False


def test_build_vectorize_body_url_form() -> None:
    body = QuiverClient.build_vectorize_body(model="arrow-1.1", image_url="https://x.png")
    assert body["image"] == {"url": "https://x.png"}
    assert body["model"] == "arrow-1.1"


def test_build_vectorize_body_base64_form() -> None:
    body = QuiverClient.build_vectorize_body(model="arrow-1.1", image_base64="iVBORw0KGgo=")
    assert body["image"] == {"base64": "iVBORw0KGgo="}


def test_build_vectorize_body_rejects_both_or_neither() -> None:
    # Both — ambiguous
    with pytest.raises(ValueError, match="Exactly one"):
        QuiverClient.build_vectorize_body(model="arrow-1.1", image_url="x", image_base64="y")
    # Neither — incomplete
    with pytest.raises(ValueError, match="Exactly one"):
        QuiverClient.build_vectorize_body(model="arrow-1.1")


def test_build_vectorize_body_with_knobs() -> None:
    body = QuiverClient.build_vectorize_body(
        model="arrow-1.1",
        image_url="https://x.png",
        auto_crop=True,
        target_size=2048,
        temperature=0.5,
    )
    assert body["auto_crop"] is True
    assert body["target_size"] == 2048
    assert body["temperature"] == 0.5


# ---------- SSE parser ----------


async def _lines(strings: list[str]) -> AsyncIterator[str]:
    for s in strings:
        yield s


@pytest.mark.asyncio
async def test_parse_sse_lines_decodes_all_event_types() -> None:
    sse = [
        'event: generating',
        'data: {"type":"generating","id":"r1","index":0}',
        '',
        'event: reasoning',
        'data: {"type":"reasoning","id":"r1","text":"thinking..."}',
        '',
        'event: draft',
        'data: {"type":"draft","id":"r1","svg":"<svg>partial</svg>"}',
        '',
        'event: content',
        'data: {"type":"content","id":"r1","svg":"<svg>final</svg>","credits":1}',
        '',
        'data: [DONE]',
    ]
    events: list[QuiverEvent] = []
    async for ev in parse_sse_lines(_lines(sse)):
        events.append(ev)
    assert [e.type for e in events] == ["generating", "reasoning", "draft", "content"]
    assert events[2].svg == "<svg>partial</svg>"
    assert events[3].svg == "<svg>final</svg>"
    assert events[3].credits == 1


@pytest.mark.asyncio
async def test_parse_sse_lines_skips_malformed_json_and_unknown_types() -> None:
    sse = [
        'data: not-valid-json',
        'data: {"type":"surprise","svg":"<svg/>"}',
        'data: {"type":"draft","id":"r1","svg":"<svg>ok</svg>"}',
        'data: [DONE]',
    ]
    events = [e async for e in parse_sse_lines(_lines(sse))]
    assert len(events) == 1
    assert events[0].svg == "<svg>ok</svg>"


@pytest.mark.asyncio
async def test_parse_sse_lines_stops_at_done() -> None:
    sse = [
        'data: {"type":"draft","id":"r1","svg":"a"}',
        'data: [DONE]',
        'data: {"type":"draft","id":"r1","svg":"should-not-be-seen"}',
    ]
    events = [e async for e in parse_sse_lines(_lines(sse))]
    assert [e.svg for e in events] == ["a"]


# ---------- Retry-After parser ----------


def test_parse_retry_after_integer_seconds() -> None:
    assert _parse_retry_after("5") == 5.0
    assert _parse_retry_after("0") == 0.0


def test_parse_retry_after_fallback_on_garbage() -> None:
    assert _parse_retry_after("not-a-date", fallback=2.5) == 2.5


def test_parse_retry_after_none_uses_fallback() -> None:
    assert _parse_retry_after(None, fallback=3.0) == 3.0


# ---------- header parser ----------


def test_rate_limit_from_headers_parses_all() -> None:
    headers = httpx.Headers({
        "X-RateLimit-Limit": "20",
        "X-RateLimit-Remaining": "7",
        "X-RateLimit-Reset": "1779126000000",
    })
    rl = _rate_limit_from_headers(headers)
    assert rl.limit == 20
    assert rl.remaining == 7
    assert rl.reset_ms == 1779126000000


def test_rate_limit_from_headers_handles_missing() -> None:
    rl = _rate_limit_from_headers(httpx.Headers({}))
    assert rl.limit is None and rl.remaining is None and rl.reset_ms is None


# ---------- status code mapping ----------


@pytest.mark.parametrize("status, exc", [
    (401, QuiverAuthError),
    (403, QuiverAuthError),
    (402, QuiverInsufficientCreditsError),
    (429, QuiverRateLimitError),
    (500, QuiverServerError),
    (502, QuiverServerError),
    (400, QuiverError),
    (404, QuiverError),
])
def test_raise_for_status_maps_codes(status: int, exc: type[BaseException]) -> None:
    with pytest.raises(exc):
        _raise_for_status(status, body_preview="x")


def test_raise_for_status_passes_through_2xx() -> None:
    _raise_for_status(200)
    _raise_for_status(204)


# ---------- payload mapping ----------


def test_event_from_payload_keeps_raw() -> None:
    raw = {"type": "content", "id": "r1", "svg": "<svg/>", "credits": 2, "index": 0}
    ev = event_from_payload(raw)
    assert ev.type == "content"
    assert ev.credits == 2
    assert ev.raw is raw


def test_event_from_payload_raises_on_unknown_type() -> None:
    with pytest.raises(ValueError, match="Unknown Quiver event type"):
        event_from_payload({"type": "panic"})


def test_response_from_payload_filters_invalid_data_items() -> None:
    payload = {
        "id": "resp_1",
        "created": 1700000000,
        "credits": 3,
        "data": [
            {"mime_type": "image/svg+xml", "svg": "<svg/>"},
            "not-a-dict",  # filtered
            {"mime_type": "image/svg+xml"},  # missing svg, filtered
        ],
        "usage": {"input_tokens": 10},
    }
    r = response_from_payload(payload)
    assert len(r.data) == 1
    assert r.data[0].svg == "<svg/>"
    assert r.credits == 3
    assert r.usage == {"input_tokens": 10}


def test_model_from_payload_handles_missing_optional_fields() -> None:
    m = model_from_payload({"id": "arrow-1.1"})
    assert m.id == "arrow-1.1"
    assert m.name is None
    assert m.input_modalities == []
    assert m.pricing_credits == {}


# ---------- constructor ----------


def test_quiver_client_rejects_empty_api_key() -> None:
    with pytest.raises(QuiverAuthError):
        QuiverClient("")


# ---------- end-to-end (respx-mocked HTTP) ----------


@respx.mock
@pytest.mark.asyncio
async def test_list_models_end_to_end() -> None:
    respx.get("https://api.quiver.ai/v1/models").mock(
        return_value=Response(200, json={
            "object": "list",
            "data": [
                {
                    "id": "arrow-1.1",
                    "object": "model",
                    "name": "Arrow 1.1",
                    "supported_operations": ["svg_generate", "svg_vectorize"],
                    "pricing_credits": {"svg_generate": 20, "svg_vectorize": 15},
                },
            ],
        })
    )
    client = QuiverClient("qvr-test")
    models = await client.list_models()
    assert len(models) == 1
    assert models[0].id == "arrow-1.1"
    assert models[0].pricing_credits == {"svg_generate": 20, "svg_vectorize": 15}


@respx.mock
@pytest.mark.asyncio
async def test_generate_non_stream_surfaces_rate_limit_headers() -> None:
    respx.post("https://api.quiver.ai/v1/svgs/generations").mock(
        return_value=Response(
            200,
            headers={"X-RateLimit-Limit": "20", "X-RateLimit-Remaining": "19", "X-RateLimit-Reset": "1779126000000"},
            json={
                "id": "resp_1",
                "created": 1700000000,
                "credits": 1,
                "data": [{"mime_type": "image/svg+xml", "svg": "<svg/>"}],
                "usage": {},
            },
        )
    )
    client = QuiverClient("qvr-test")
    resp = await client.generate(model="arrow-1.1", prompt="x")
    assert resp.data[0].svg == "<svg/>"
    assert resp.rate_limit is not None
    assert resp.rate_limit.limit == 20
    assert resp.rate_limit.remaining == 19


@respx.mock
@pytest.mark.asyncio
async def test_generate_bubbles_insufficient_credits_on_402() -> None:
    respx.post("https://api.quiver.ai/v1/svgs/generations").mock(
        return_value=Response(402, json={"error": "out of credits"})
    )
    client = QuiverClient("qvr-test")
    with pytest.raises(QuiverInsufficientCreditsError):
        await client.generate(model="arrow-1.1", prompt="x")


@respx.mock
@pytest.mark.asyncio
async def test_generate_bubbles_auth_on_401() -> None:
    respx.post("https://api.quiver.ai/v1/svgs/generations").mock(
        return_value=Response(401, json={"error": "bad key"})
    )
    client = QuiverClient("qvr-test")
    with pytest.raises(QuiverAuthError):
        await client.generate(model="arrow-1.1", prompt="x")


@respx.mock
@pytest.mark.asyncio
async def test_generate_retries_once_on_429_then_succeeds() -> None:
    # First call 429 with Retry-After: 0 (so test is fast), second call 200.
    route = respx.post("https://api.quiver.ai/v1/svgs/generations").mock(
        side_effect=[
            Response(429, headers={"Retry-After": "0"}, text="rate limited"),
            Response(200, json={
                "id": "resp_1", "created": 1, "credits": 1,
                "data": [{"mime_type": "image/svg+xml", "svg": "<svg/>"}], "usage": {},
            }),
        ]
    )
    client = QuiverClient("qvr-test")
    resp = await client.generate(model="arrow-1.1", prompt="x")
    assert resp.data[0].svg == "<svg/>"
    assert route.call_count == 2


@respx.mock
@pytest.mark.asyncio
async def test_generate_raises_rate_limit_after_retry_exhausted() -> None:
    respx.post("https://api.quiver.ai/v1/svgs/generations").mock(
        side_effect=[
            Response(429, headers={"Retry-After": "0"}, text="rate limited"),
            Response(429, headers={"Retry-After": "0"}, text="rate limited again"),
        ]
    )
    client = QuiverClient("qvr-test")
    with pytest.raises(QuiverRateLimitError):
        await client.generate(model="arrow-1.1", prompt="x")


@respx.mock
@pytest.mark.asyncio
async def test_generate_stream_yields_events_from_sse_body() -> None:
    sse_body = (
        b'event: generating\n'
        b'data: {"type":"generating","id":"r1","index":0}\n'
        b'\n'
        b'event: draft\n'
        b'data: {"type":"draft","id":"r1","svg":"<svg>partial</svg>"}\n'
        b'\n'
        b'event: content\n'
        b'data: {"type":"content","id":"r1","svg":"<svg>final</svg>","credits":1}\n'
        b'\n'
        b'data: [DONE]\n'
    )
    respx.post("https://api.quiver.ai/v1/svgs/generations").mock(
        return_value=Response(200, headers={"Content-Type": "text/event-stream"}, content=sse_body)
    )
    client = QuiverClient("qvr-test")
    events = [e async for e in client.generate_stream(model="arrow-1.1", prompt="x")]
    assert [e.type for e in events] == ["generating", "draft", "content"]
    assert events[1].svg == "<svg>partial</svg>"
    assert events[2].svg == "<svg>final</svg>"
    assert events[2].credits == 1


@respx.mock
@pytest.mark.asyncio
async def test_generate_stream_raises_on_non_200() -> None:
    respx.post("https://api.quiver.ai/v1/svgs/generations").mock(
        return_value=Response(402, text='{"error":"out"}')
    )
    client = QuiverClient("qvr-test")
    with pytest.raises(QuiverInsufficientCreditsError):
        async for _ in client.generate_stream(model="arrow-1.1", prompt="x"):
            pass


@respx.mock
@pytest.mark.asyncio
async def test_vectorize_sends_image_object_discriminator() -> None:
    capture: dict = {}

    def _capture(request: httpx.Request) -> Response:
        capture["body"] = json.loads(request.content)
        return Response(200, json={
            "id": "resp_1", "created": 1, "credits": 1,
            "data": [{"mime_type": "image/svg+xml", "svg": "<svg/>"}], "usage": {},
        })

    respx.post("https://api.quiver.ai/v1/svgs/vectorizations").mock(side_effect=_capture)
    client = QuiverClient("qvr-test")
    await client.vectorize(model="arrow-1.1", image_url="https://x.png", auto_crop=True)
    assert capture["body"]["image"] == {"url": "https://x.png"}
    assert capture["body"]["auto_crop"] is True
    assert capture["body"]["stream"] is False
