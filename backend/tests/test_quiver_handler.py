"""Tests for backend/handlers/quiver.py.

Covers handler-level concerns: input resolution (URL/data-uri/local
path), streaming consumption + StreamPartialSvgEvent emission, file
write to OUTPUT_ROOT, missing-API-key error path, and provider error
wrapping (Quiver typed exceptions -> user-facing ValueError messages).
"""

from __future__ import annotations

import base64
import json
from pathlib import Path
from typing import Any, AsyncIterator

import pytest
import respx
from httpx import Response

import handlers.quiver as quiver_handler
from handlers.quiver import (
    _coerce_references,
    _ref_to_quiver_string,
    _to_quiver_image_arg,
    handle_quiver_arrow_generate,
    handle_quiver_arrow_vectorize,
)
from models.events import ExecutionEvent, StreamPartialSvgEvent
from models.graph import GraphNode, PortValueDict
from services.quiver_client import (
    QuiverAuthError,
    QuiverEvent,
    QuiverInsufficientCreditsError,
)


# ---------- helpers ----------


def _node(definition_id: str, params: dict[str, Any] | None = None) -> GraphNode:
    return GraphNode(id="n1", definitionId=definition_id, params=params or {})


def _png_bytes() -> bytes:
    """A 1x1 PNG."""
    return bytes.fromhex(
        "89504e470d0a1a0a0000000d49484452000000010000000108060000001f15c4"
        "890000000d49444154789c6300010000000500010d0a2db40000000049454e44"
        "ae426082"
    )


def _sse_stream(events: list[dict[str, Any]], include_done: bool = True) -> bytes:
    lines: list[str] = []
    for ev in events:
        lines.append(f"event: {ev['type']}")
        lines.append(f"data: {json.dumps(ev)}")
        lines.append("")
    if include_done:
        lines.append("data: [DONE]")
    return ("\n".join(lines) + "\n").encode("utf-8")


@pytest.fixture
def output_root(tmp_path, monkeypatch) -> Path:
    """Redirect get_run_dir() so SVG writes land in a tmp directory."""
    run_dir = tmp_path / "run"
    run_dir.mkdir()
    monkeypatch.setattr(quiver_handler, "get_run_dir", lambda: run_dir)
    monkeypatch.setattr(quiver_handler, "OUTPUT_ROOT", tmp_path)
    return tmp_path


@pytest.fixture
def emit_collector():
    events: list[ExecutionEvent] = []

    async def _emit(e: ExecutionEvent) -> None:
        events.append(e)

    return events, _emit


# ---------- input resolution helpers ----------


def test_to_quiver_image_arg_passes_external_url() -> None:
    url, b64 = _to_quiver_image_arg("https://example.com/x.png")
    assert url == "https://example.com/x.png"
    assert b64 is None


def test_to_quiver_image_arg_strips_data_uri() -> None:
    url, b64 = _to_quiver_image_arg("data:image/png;base64,AAAAAA==")
    assert url is None
    assert b64 == "AAAAAA=="


def test_to_quiver_image_arg_reads_local_path_to_base64(tmp_path) -> None:
    f = tmp_path / "tiny.png"
    f.write_bytes(_png_bytes())
    url, b64 = _to_quiver_image_arg(str(f))
    assert url is None
    assert b64 == base64.b64encode(_png_bytes()).decode("ascii")


def test_to_quiver_image_arg_resolves_outputs_url(tmp_path, monkeypatch) -> None:
    monkeypatch.setattr(quiver_handler, "OUTPUT_ROOT", tmp_path)
    served = tmp_path / "served.png"
    served.write_bytes(_png_bytes())
    url, b64 = _to_quiver_image_arg("/api/outputs/served.png")
    assert url is None
    assert b64 == base64.b64encode(_png_bytes()).decode("ascii")


def test_to_quiver_image_arg_raises_on_unresolvable() -> None:
    with pytest.raises(ValueError, match="Cannot resolve"):
        _to_quiver_image_arg("/nonexistent/path/that/never/was.png")


def test_coerce_references_handles_string_and_list() -> None:
    assert _coerce_references(None) == []
    assert _coerce_references("https://a.png") == ["https://a.png"]
    assert _coerce_references(["https://a.png", "https://b.png"]) == [
        "https://a.png", "https://b.png",
    ]


def test_coerce_references_skips_empty_items() -> None:
    assert _coerce_references(["", "https://b.png", None]) == ["https://b.png"]


def test_ref_to_quiver_string_passes_external_url() -> None:
    assert _ref_to_quiver_string("https://x.png") == "https://x.png"


def test_ref_to_quiver_string_passes_data_uri() -> None:
    assert _ref_to_quiver_string("data:image/png;base64,XXX") == "data:image/png;base64,XXX"


def test_ref_to_quiver_string_converts_local_to_data_uri(tmp_path) -> None:
    f = tmp_path / "ref.png"
    f.write_bytes(_png_bytes())
    result = _ref_to_quiver_string(str(f))
    assert result.startswith("data:image/png;base64,")
    encoded = result.split(",", 1)[1]
    assert encoded == base64.b64encode(_png_bytes()).decode("ascii")


# ---------- handler: missing key ----------


@pytest.mark.asyncio
async def test_generate_requires_api_key() -> None:
    with pytest.raises(ValueError, match="QUIVER_API_KEY is required"):
        await handle_quiver_arrow_generate(
            _node("quiver-arrow-generate"),
            {"prompt": PortValueDict(type="Text", value="hi")},
            api_keys={},
        )


@pytest.mark.asyncio
async def test_vectorize_requires_api_key() -> None:
    with pytest.raises(ValueError, match="QUIVER_API_KEY is required"):
        await handle_quiver_arrow_vectorize(
            _node("quiver-arrow-vectorize"),
            {"image": PortValueDict(type="Image", value="https://x.png")},
            api_keys={},
        )


@pytest.mark.asyncio
async def test_generate_requires_prompt_input() -> None:
    with pytest.raises(ValueError, match="Prompt input is required"):
        await handle_quiver_arrow_generate(
            _node("quiver-arrow-generate"),
            {},
            api_keys={"QUIVER_API_KEY": "qvr-test"},
        )


@pytest.mark.asyncio
async def test_vectorize_requires_image_input() -> None:
    with pytest.raises(ValueError, match="Image input is required"):
        await handle_quiver_arrow_vectorize(
            _node("quiver-arrow-vectorize"),
            {},
            api_keys={"QUIVER_API_KEY": "qvr-test"},
        )


# ---------- handler: streaming + file write ----------


@respx.mock
@pytest.mark.asyncio
async def test_generate_emits_drafts_then_writes_final_svg(output_root, emit_collector) -> None:
    events, emit = emit_collector
    sse = _sse_stream([
        {"type": "generating", "id": "r1", "index": 0},
        {"type": "draft", "id": "r1", "svg": "<svg>partial-1</svg>"},
        {"type": "draft", "id": "r1", "svg": "<svg>partial-2</svg>"},
        {"type": "content", "id": "r1", "svg": "<svg>FINAL</svg>", "credits": 1},
    ])
    respx.post("https://api.quiver.ai/v1/svgs/generations").mock(
        return_value=Response(200, headers={"Content-Type": "text/event-stream"}, content=sse)
    )

    result = await handle_quiver_arrow_generate(
        _node("quiver-arrow-generate", {"model": "arrow-1.1"}),
        {"prompt": PortValueDict(type="Text", value="a green triangle")},
        api_keys={"QUIVER_API_KEY": "qvr-test"},
        emit=emit,
    )

    # Output port shape matches what svg-rasterize and other SVG consumers expect.
    assert result["svg"]["type"] == "SVG"
    out_path = Path(result["svg"]["value"])
    assert out_path.exists()
    assert out_path.read_text(encoding="utf-8") == "<svg>FINAL</svg>"
    assert out_path.suffix == ".svg"

    # 2 drafts + 1 final = 3 StreamPartialSvgEvent emissions.
    partials = [e for e in events if isinstance(e, StreamPartialSvgEvent)]
    assert [p.svg for p in partials] == ["<svg>partial-1</svg>", "<svg>partial-2</svg>", "<svg>FINAL</svg>"]
    assert [p.is_final for p in partials] == [False, False, True]
    assert [p.partial_index for p in partials] == [0, 1, 2]


@respx.mock
@pytest.mark.asyncio
async def test_vectorize_sends_image_object_and_writes_svg(output_root, emit_collector) -> None:
    events, emit = emit_collector
    captured: dict = {}

    def _capture(request):
        captured["body"] = json.loads(request.content)
        sse = _sse_stream([
            {"type": "content", "id": "r1", "svg": "<svg>VECTOR</svg>", "credits": 1},
        ])
        return Response(200, headers={"Content-Type": "text/event-stream"}, content=sse)

    respx.post("https://api.quiver.ai/v1/svgs/vectorizations").mock(side_effect=_capture)

    result = await handle_quiver_arrow_vectorize(
        _node("quiver-arrow-vectorize", {"model": "arrow-1.1", "auto_crop": True, "target_size": 1024}),
        {"image": PortValueDict(type="Image", value="https://example.com/logo.png")},
        api_keys={"QUIVER_API_KEY": "qvr-test"},
        emit=emit,
    )

    assert result["svg"]["value"].endswith(".svg")
    assert Path(result["svg"]["value"]).read_text(encoding="utf-8") == "<svg>VECTOR</svg>"

    # Verify the on-the-wire body has the image OBJECT discriminator, not a string,
    # and that auto_crop/target_size were forwarded.
    assert captured["body"]["image"] == {"url": "https://example.com/logo.png"}
    assert captured["body"]["auto_crop"] is True
    assert captured["body"]["target_size"] == 1024
    assert captured["body"]["stream"] is True  # handler always streams


@respx.mock
@pytest.mark.asyncio
async def test_generate_forwards_all_optional_params_when_set(output_root) -> None:
    captured: dict = {}

    def _capture(request):
        captured["body"] = json.loads(request.content)
        return Response(200, headers={"Content-Type": "text/event-stream"},
                        content=_sse_stream([{"type": "content", "id": "r1", "svg": "<svg/>"}]))

    respx.post("https://api.quiver.ai/v1/svgs/generations").mock(side_effect=_capture)

    await handle_quiver_arrow_generate(
        _node("quiver-arrow-generate", {
            "model": "arrow-1.1-max",
            "n": 2,
            "instructions": "thin stroke",
            "temperature": 0.7,
            "top_p": 0.9,
            "presence_penalty": -0.1,
            "max_output_tokens": 8192,
        }),
        {
            "prompt": PortValueDict(type="Text", value="logo"),
            "references": PortValueDict(type="Image", value=["https://a.png", "https://b.png"]),
        },
        api_keys={"QUIVER_API_KEY": "qvr-test"},
    )

    body = captured["body"]
    assert body["model"] == "arrow-1.1-max"
    assert body["prompt"] == "logo"
    assert body["references"] == ["https://a.png", "https://b.png"]
    assert body["n"] == 2
    assert body["instructions"] == "thin stroke"
    assert body["temperature"] == 0.7
    assert body["top_p"] == 0.9
    assert body["presence_penalty"] == -0.1
    assert body["max_output_tokens"] == 8192


@respx.mock
@pytest.mark.asyncio
async def test_generate_stream_without_content_event_raises(output_root) -> None:
    sse = _sse_stream([
        {"type": "generating", "id": "r1", "index": 0},
        {"type": "draft", "id": "r1", "svg": "<svg>partial</svg>"},
    ])
    respx.post("https://api.quiver.ai/v1/svgs/generations").mock(
        return_value=Response(200, headers={"Content-Type": "text/event-stream"}, content=sse)
    )
    with pytest.raises(ValueError, match="without a final `content` event"):
        await handle_quiver_arrow_generate(
            _node("quiver-arrow-generate"),
            {"prompt": PortValueDict(type="Text", value="x")},
            api_keys={"QUIVER_API_KEY": "qvr-test"},
        )


# ---------- handler: provider error wrapping ----------


@respx.mock
@pytest.mark.asyncio
async def test_generate_wraps_402_as_friendly_message() -> None:
    respx.post("https://api.quiver.ai/v1/svgs/generations").mock(
        return_value=Response(402, json={"error": "out of credits"})
    )
    with pytest.raises(ValueError, match="Insufficient QuiverAI credits"):
        await handle_quiver_arrow_generate(
            _node("quiver-arrow-generate"),
            {"prompt": PortValueDict(type="Text", value="x")},
            api_keys={"QUIVER_API_KEY": "qvr-test"},
        )


@respx.mock
@pytest.mark.asyncio
async def test_generate_wraps_401_as_friendly_message() -> None:
    respx.post("https://api.quiver.ai/v1/svgs/generations").mock(
        return_value=Response(401, json={"error": "bad key"})
    )
    with pytest.raises(ValueError, match="QuiverAI auth failed"):
        await handle_quiver_arrow_generate(
            _node("quiver-arrow-generate"),
            {"prompt": PortValueDict(type="Text", value="x")},
            api_keys={"QUIVER_API_KEY": "qvr-bad"},
        )
