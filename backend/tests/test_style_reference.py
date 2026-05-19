"""Tests for backend/handlers/style_reference.py.

Covers all three modes (auto/manual/passthrough), strength-suffix
application, path resolution, error paths, and the Gemini call shape
under auto mode. Auto-mode tests mock httpx via respx so no real
Gemini call is made."""

from __future__ import annotations

import base64
import json
from pathlib import Path
from typing import Any

import pytest
import respx
from httpx import Response

import handlers.style_reference as style_reference_handler
from handlers.style_reference import (
    _STYLE_PROMPTS,
    _apply_strength_suffix,
    _resolve_local_path,
    handle_style_reference,
)
from models.graph import GraphNode


# ---------- helpers ----------


def _png_bytes() -> bytes:
    """A minimal valid 1x1 PNG so the magic-bytes sniffer and base64 encoder are exercised."""
    return bytes.fromhex(
        "89504e470d0a1a0a0000000d49484452000000010000000108060000001f15c4"
        "890000000d49444154789c6300010000000500010d0a2db40000000049454e44"
        "ae426082"
    )


def _node(params: dict[str, Any]) -> GraphNode:
    return GraphNode(id="n1", definitionId="style-reference", params=params)


@pytest.fixture
def reference_image(tmp_path) -> Path:
    path = tmp_path / "ref.png"
    path.write_bytes(_png_bytes())
    return path


# ---------- pure helpers ----------


def test_apply_strength_suffix_appends_when_below_one() -> None:
    assert _apply_strength_suffix("a, b, c", 0.5) == "a, b, c (style strength: 0.50)"
    assert _apply_strength_suffix("a, b, c", 0.75) == "a, b, c (style strength: 0.75)"


def test_apply_strength_suffix_no_op_at_one() -> None:
    # Strength 1.0 is the no-op identity case — don't pollute the description.
    assert _apply_strength_suffix("a, b, c", 1.0) == "a, b, c"


def test_apply_strength_suffix_skips_empty_description() -> None:
    # Passthrough returns "" — don't append "(style strength: ...)" to nothing.
    assert _apply_strength_suffix("", 0.5) == ""


def test_resolve_local_path_absolute(reference_image: Path) -> None:
    resolved = _resolve_local_path(str(reference_image))
    assert resolved == reference_image


def test_resolve_local_path_outputs_url(monkeypatch, tmp_path) -> None:
    # When value is /api/outputs/<rel>, resolve against OUTPUT_ROOT.
    monkeypatch.setattr(style_reference_handler, "OUTPUT_ROOT", tmp_path)
    served = tmp_path / "served.png"
    served.write_bytes(_png_bytes())
    resolved = _resolve_local_path("/api/outputs/served.png")
    assert resolved == served


def test_resolve_local_path_returns_none_for_missing() -> None:
    assert _resolve_local_path("/nonexistent/file.png") is None
    assert _resolve_local_path("") is None


# ---------- handler: error paths ----------


@pytest.mark.asyncio
async def test_missing_file_path_raises() -> None:
    with pytest.raises(ValueError, match="needs a reference image"):
        await handle_style_reference(_node({}), inputs={}, api_keys={})


@pytest.mark.asyncio
async def test_unresolvable_file_path_raises() -> None:
    with pytest.raises(ValueError, match="not found"):
        await handle_style_reference(
            _node({"filePath": "/nope/missing.png"}),
            inputs={},
            api_keys={},
        )


@pytest.mark.asyncio
async def test_auto_without_google_key_errors_with_fallback_hint(reference_image: Path) -> None:
    with pytest.raises(ValueError, match="GOOGLE_API_KEY required"):
        await handle_style_reference(
            _node({"filePath": str(reference_image), "mode": "auto"}),
            inputs={},
            api_keys={},
        )


# ---------- handler: passthrough mode ----------


@pytest.mark.asyncio
async def test_passthrough_returns_empty_description(reference_image: Path) -> None:
    result = await handle_style_reference(
        _node({"filePath": str(reference_image), "mode": "passthrough"}),
        inputs={},
        api_keys={},
    )
    assert result["image"]["type"] == "Image"
    assert result["image"]["value"] == str(reference_image)
    assert result["style_description"] == {"type": "Text", "value": ""}


@pytest.mark.asyncio
async def test_passthrough_makes_no_network_calls(reference_image: Path) -> None:
    # If passthrough leaks to Gemini, respx's strict mode would catch it as unmocked.
    with respx.mock(assert_all_called=False) as router:
        router.post("https://generativelanguage.googleapis.com/").mock(
            return_value=Response(500, text="should not be called")
        )
        await handle_style_reference(
            _node({"filePath": str(reference_image), "mode": "passthrough"}),
            inputs={},
            api_keys={"GOOGLE_API_KEY": "should-not-be-used"},
        )


# ---------- handler: manual mode ----------


@pytest.mark.asyncio
async def test_manual_returns_user_text_unchanged_at_full_strength(reference_image: Path) -> None:
    result = await handle_style_reference(
        _node({
            "filePath": str(reference_image),
            "mode": "manual",
            "manual_description": "wabi-sabi minimalism, warm tungsten",
            "strength": 1.0,
        }),
        inputs={},
        api_keys={},
    )
    assert result["style_description"]["value"] == "wabi-sabi minimalism, warm tungsten"


@pytest.mark.asyncio
async def test_manual_appends_strength_suffix(reference_image: Path) -> None:
    result = await handle_style_reference(
        _node({
            "filePath": str(reference_image),
            "mode": "manual",
            "manual_description": "wabi-sabi minimalism",
            "strength": 0.5,
        }),
        inputs={},
        api_keys={},
    )
    assert result["style_description"]["value"] == "wabi-sabi minimalism (style strength: 0.50)"


@pytest.mark.asyncio
async def test_manual_empty_description_stays_empty_even_with_strength(reference_image: Path) -> None:
    # An empty manual description with non-1.0 strength should NOT get "(style strength: ...)"
    # appended to nothing — that would produce a broken trailing suffix.
    result = await handle_style_reference(
        _node({
            "filePath": str(reference_image),
            "mode": "manual",
            "manual_description": "",
            "strength": 0.5,
        }),
        inputs={},
        api_keys={},
    )
    assert result["style_description"]["value"] == ""


# ---------- handler: auto mode (mocked Gemini) ----------


@respx.mock
@pytest.mark.asyncio
async def test_auto_calls_gemini_with_focus_specific_prompt(reference_image: Path) -> None:
    captured: dict = {}

    def _capture(request) -> Response:
        captured["body"] = json.loads(request.content)
        return Response(200, json={
            "candidates": [{
                "content": {"parts": [{"text": "muted earth palette, soft diffused light"}]},
            }],
        })

    respx.post(
        "https://generativelanguage.googleapis.com/v1beta/models/gemini-2.5-flash:generateContent"
    ).mock(side_effect=_capture)

    result = await handle_style_reference(
        _node({
            "filePath": str(reference_image),
            "mode": "auto",
            "focus": "palette",
            "strength": 1.0,
        }),
        inputs={},
        api_keys={"GOOGLE_API_KEY": "qvr-test"},
    )

    # The system prompt going on the wire matches the focus param.
    body = captured["body"]
    parts = body["contents"][0]["parts"]
    text_part = next(p for p in parts if "text" in p)
    assert text_part["text"] == _STYLE_PROMPTS["palette"]

    # The image is base64-encoded as inline_data.
    image_part = next(p for p in parts if "inline_data" in p)
    expected_b64 = base64.b64encode(_png_bytes()).decode("ascii")
    assert image_part["inline_data"]["data"] == expected_b64
    assert image_part["inline_data"]["mime_type"] == "image/png"

    # Gemini's response is propagated verbatim into style_description (strength=1.0 means no suffix).
    assert result["style_description"]["value"] == "muted earth palette, soft diffused light"


@respx.mock
@pytest.mark.asyncio
async def test_auto_applies_strength_suffix_to_gemini_response(reference_image: Path) -> None:
    respx.post(
        "https://generativelanguage.googleapis.com/v1beta/models/gemini-2.5-flash:generateContent"
    ).mock(return_value=Response(200, json={
        "candidates": [{
            "content": {"parts": [{"text": "warm tungsten, grainy 35mm"}]},
        }],
    }))

    result = await handle_style_reference(
        _node({
            "filePath": str(reference_image),
            "mode": "auto",
            "focus": "all",
            "strength": 0.6,
        }),
        inputs={},
        api_keys={"GOOGLE_API_KEY": "qvr-test"},
    )

    assert result["style_description"]["value"] == "warm tungsten, grainy 35mm (style strength: 0.60)"


@respx.mock
@pytest.mark.asyncio
async def test_auto_raises_on_gemini_http_error(reference_image: Path) -> None:
    respx.post(
        "https://generativelanguage.googleapis.com/v1beta/models/gemini-2.5-flash:generateContent"
    ).mock(return_value=Response(500, text="upstream blew up"))

    with pytest.raises(RuntimeError, match="Gemini style extraction failed"):
        await handle_style_reference(
            _node({"filePath": str(reference_image), "mode": "auto"}),
            inputs={},
            api_keys={"GOOGLE_API_KEY": "qvr-test"},
        )


@respx.mock
@pytest.mark.asyncio
async def test_auto_raises_on_empty_candidates(reference_image: Path) -> None:
    respx.post(
        "https://generativelanguage.googleapis.com/v1beta/models/gemini-2.5-flash:generateContent"
    ).mock(return_value=Response(200, json={"candidates": []}))

    with pytest.raises(RuntimeError, match="no candidates"):
        await handle_style_reference(
            _node({"filePath": str(reference_image), "mode": "auto"}),
            inputs={},
            api_keys={"GOOGLE_API_KEY": "qvr-test"},
        )
