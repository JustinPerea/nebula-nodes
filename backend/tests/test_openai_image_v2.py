from __future__ import annotations

from pathlib import Path
from typing import Any

import pytest
import respx
from httpx import Response

from handlers.openai_image_v2 import handle_gpt_image_2_generate, build_generate_body, handle_gpt_image_2_edit
from models.graph import GraphNode, PortValueDict


def _node(params: dict[str, Any]) -> GraphNode:
    return GraphNode(
        id="n1",
        definitionId="gpt-image-2-generate",
        params=params,
    )


def test_build_generate_body_minimal() -> None:
    node = _node({})
    body = build_generate_body(node, prompt_text="hello")
    assert body["model"] == "gpt-image-2"
    assert body["prompt"] == "hello"
    assert body["stream"] is True
    assert body["partial_images"] == 0  # default — node def no longer exposes this param


def test_build_generate_body_omits_unsupported_params() -> None:
    # background and input_fidelity must be stripped defensively even if present.
    node = _node({"background": "transparent", "input_fidelity": "high", "size": "1024x1024"})
    body = build_generate_body(node, prompt_text="x")
    assert "background" not in body
    assert "input_fidelity" not in body
    assert body["size"] == "1024x1024"


def test_build_generate_body_passes_quality_format_moderation() -> None:
    # n=2 is silently dropped — OpenAI streaming requires n=1.
    node = _node({
        "size": "3840x2160", "quality": "high", "output_format": "jpeg",
        "output_compression": 80, "moderation": "low", "n": 2, "partial_images": 3,
    })
    body = build_generate_body(node, prompt_text="x")
    assert body["size"] == "3840x2160"
    assert body["quality"] == "high"
    assert body["output_format"] == "jpeg"
    assert body["output_compression"] == 80
    assert body["moderation"] == "low"
    assert "n" not in body
    assert body["partial_images"] == 3


def test_build_generate_body_drops_output_compression_for_png() -> None:
    node = _node({"output_format": "png", "output_compression": 50})
    body = build_generate_body(node, prompt_text="x")
    assert "output_compression" not in body


@pytest.mark.asyncio
async def test_handle_generate_requires_prompt_input() -> None:
    node = _node({})
    with pytest.raises(ValueError, match="Prompt input is required"):
        await handle_gpt_image_2_generate(node, inputs={}, api_keys={"OPENAI_API_KEY": "k"}, emit=None, run_dir=Path("/tmp"))


@pytest.mark.asyncio
async def test_handle_generate_requires_api_key() -> None:
    node = _node({})
    inputs = {"prompt": PortValueDict(type="Text", value="hi")}
    with pytest.raises(ValueError, match="OPENAI_API_KEY"):
        await handle_gpt_image_2_generate(node, inputs=inputs, api_keys={}, emit=None, run_dir=Path("/tmp"))


@pytest.mark.asyncio
@respx.mock
async def test_handle_generate_org_verification_error_returns_friendly_message() -> None:
    respx.post("https://api.openai.com/v1/images/generations").mock(
        return_value=Response(403, json={"error": {"code": "organization_must_be_verified", "message": "verify"}})
    )
    node = _node({})
    inputs = {"prompt": PortValueDict(type="Text", value="hi")}
    with pytest.raises(RuntimeError, match="org isn't verified"):
        await handle_gpt_image_2_generate(
            node, inputs=inputs, api_keys={"OPENAI_API_KEY": "k"}, emit=None,
            run_dir=Path("/tmp"),
        )


@pytest.mark.asyncio
async def test_edit_rejects_more_than_10_images(tmp_path: Path) -> None:
    # 11 image values
    img_paths = []
    for i in range(11):
        p = tmp_path / f"in{i}.png"
        p.write_bytes(b"x")
        img_paths.append(str(p))
    node = _node({})
    inputs = {
        "images": PortValueDict(type="Image", value=img_paths),
        "prompt": PortValueDict(type="Text", value="edit please"),
    }
    with pytest.raises(ValueError, match="up to 10"):
        await handle_gpt_image_2_edit(
            node, inputs=inputs, api_keys={"OPENAI_API_KEY": "k"},
            emit=None, run_dir=tmp_path,
        )


@pytest.mark.asyncio
async def test_edit_requires_at_least_one_image() -> None:
    node = _node({})
    inputs = {"prompt": PortValueDict(type="Text", value="hi")}
    with pytest.raises(ValueError, match="Image input is required"):
        await handle_gpt_image_2_edit(
            node, inputs=inputs, api_keys={"OPENAI_API_KEY": "k"},
            emit=None, run_dir=Path("/tmp"),
        )


@pytest.mark.asyncio
@respx.mock
async def test_edit_streams_partial_and_returns_final_image(tmp_path: Path) -> None:
    """Uses contracts/fixtures/handlers/openai/gpt-image-2-edit-sse.txt oracle bytes."""
    fixture = (
        Path(__file__).resolve().parents[2]
        / "contracts"
        / "fixtures"
        / "handlers"
        / "openai"
        / "gpt-image-2-edit-sse.txt"
    )
    respx.post("https://api.openai.com/v1/images/edits").mock(
        return_value=Response(200, content=fixture.read_bytes(), headers={"content-type": "text/event-stream"})
    )

    img = tmp_path / "input.png"
    img.write_bytes(b"\x89PNG\r\n\x1a\n" + b"\x00" * 16)

    emitted = []

    async def emit(event: object) -> None:
        emitted.append(event)

    node = _node({})
    inputs = {
        "images": PortValueDict(type="Image", value=[str(img)]),
        "prompt": PortValueDict(type="Text", value="make it blue"),
    }
    out = await handle_gpt_image_2_edit(
        node, inputs=inputs, api_keys={"OPENAI_API_KEY": "k"},
        emit=emit, run_dir=tmp_path,
    )
    assert out["image"]["type"] == "Image"
    assert Path(out["image"]["value"]).exists()
    assert out["image"]["value"].endswith(".png")
    partials = [e for e in emitted if e.__class__.__name__ == "StreamPartialImageEvent"]
    assert len(partials) == 1
    assert partials[0].partial_index == 0


@pytest.mark.asyncio
@respx.mock
async def test_edit_org_verification_error_returns_friendly_message(tmp_path: Path) -> None:
    respx.post("https://api.openai.com/v1/images/edits").mock(
        return_value=Response(
            403,
            json={"error": {"code": "organization_must_be_verified", "message": "verify"}},
        )
    )
    img = tmp_path / "input.png"
    img.write_bytes(b"x")
    node = _node({})
    inputs = {
        "images": PortValueDict(type="Image", value=[str(img)]),
        "prompt": PortValueDict(type="Text", value="hi"),
    }
    with pytest.raises(RuntimeError, match="org isn't verified"):
        await handle_gpt_image_2_edit(
            node, inputs=inputs, api_keys={"OPENAI_API_KEY": "k"},
            emit=None, run_dir=tmp_path,
        )


@pytest.mark.asyncio
@respx.mock
async def test_e2e_generate_emits_partials_and_returns_image(tmp_path: Path) -> None:
    fixture = (
        Path(__file__).resolve().parents[2]
        / "contracts"
        / "fixtures"
        / "handlers"
        / "openai"
        / "gpt-image-2-generate-sse.txt"
    )
    respx.post("https://api.openai.com/v1/images/generations").mock(
        return_value=Response(200, content=fixture.read_bytes(), headers={"content-type": "text/event-stream"})
    )

    emitted: list = []

    async def emit(event) -> None:
        emitted.append(event)

    node = _node({"size": "1024x1024", "quality": "low"})
    inputs = {"prompt": PortValueDict(type="Text", value="a cat")}
    out = await handle_gpt_image_2_generate(
        node, inputs=inputs, api_keys={"OPENAI_API_KEY": "k"},
        emit=emit, run_dir=tmp_path,
    )
    assert out["image"]["type"] == "Image"
    assert Path(out["image"]["value"]).exists()
    partials = [e for e in emitted if e.__class__.__name__ == "StreamPartialImageEvent"]
    assert len(partials) == 2
    assert [p.partial_index for p in partials] == [0, 1]


# ---------------------------------------------------------------------------
# GPT Image 2.5 (Flare / Sunburst, released 2026-09-08)
# ---------------------------------------------------------------------------

from handlers.openai_image_v2 import build_25_body, handle_gpt_image_25_edit, handle_gpt_image_25_generate

OPENAI_FIXTURES = Path(__file__).resolve().parents[2] / "contracts" / "fixtures" / "handlers" / "openai"


def _node_25(params: dict[str, Any], definition: str = "gpt-image-2-5-generate") -> GraphNode:
    return GraphNode(id="n25", definitionId=definition, params=params)


def test_25_body_defaults_to_flare_and_leaves_auto_settings_to_openai() -> None:
    body = build_25_body(_node_25({}), "hello")
    assert body["model"] == "gpt-image-2.5-flare"
    assert "quality" not in body and "background" not in body and "size" not in body


def test_25_body_forwards_sunburst_new_qualities_and_transparency() -> None:
    body = build_25_body(_node_25({"model": "gpt-image-2.5-sunburst", "quality": "max", "background": "transparent",
                                   "output_format": "webp", "output_compression": 70, "size": "2560x1440"}), "x")
    assert body["model"] == "gpt-image-2.5-sunburst"
    assert body["quality"] == "max"
    assert body["background"] == "transparent"
    assert body["output_format"] == "webp" and body["output_compression"] == 70
    assert body["size"] == "2560x1440"
    assert build_25_body(_node_25({"quality": "xhigh", "background": "opaque"}), "x")["background"] == "opaque"


@pytest.mark.parametrize("params,match", [
    ({"model": "gpt-image-2"}, "Flare or Sunburst"),
    ({"quality": "ultra"}, "quality must be"),
    ({"background": "transparent", "output_format": "jpeg"}, "PNG or WebP"),
    ({"background": "clear"}, "auto, opaque or transparent"),
])
def test_25_body_refuses_what_openai_would_reject(params, match) -> None:
    with pytest.raises(ValueError, match=match):
        build_25_body(_node_25(params), "x")


def test_gpt_image_2_still_never_sends_background_or_25_qualities_model() -> None:
    body = build_generate_body(_node({"background": "transparent", "model": "gpt-image-2.5-sunburst"}), "x")
    assert body["model"] == "gpt-image-2" and "background" not in body


@pytest.mark.asyncio
@respx.mock
async def test_25_generate_streams_with_the_chosen_model(tmp_path: Path) -> None:
    route = respx.post("https://api.openai.com/v1/images/generations").mock(return_value=Response(
        200, content=(OPENAI_FIXTURES / "gpt-image-2-generate-sse.txt").read_bytes(),
        headers={"content-type": "text/event-stream"}))
    out = await handle_gpt_image_25_generate(
        _node_25({"model": "gpt-image-2.5-sunburst", "quality": "xhigh"}),
        inputs={"prompt": PortValueDict(type="Text", value="a lighthouse")},
        api_keys={"OPENAI_API_KEY": "k"}, emit=None, run_dir=tmp_path)
    sent = __import__("json").loads(route.calls[0].request.content)
    assert sent["model"] == "gpt-image-2.5-sunburst" and sent["quality"] == "xhigh" and sent["stream"] is True
    assert Path(out["image"]["value"]).exists()


@pytest.mark.asyncio
@respx.mock
async def test_25_edit_sends_model_and_background_in_the_form(tmp_path: Path) -> None:
    route = respx.post("https://api.openai.com/v1/images/edits").mock(return_value=Response(
        200, content=(OPENAI_FIXTURES / "gpt-image-2-edit-sse.txt").read_bytes(),
        headers={"content-type": "text/event-stream"}))
    img = tmp_path / "input.png"
    img.write_bytes(b"\x89PNG\r\n\x1a\n" + b"\x00" * 16)
    out = await handle_gpt_image_25_edit(
        _node_25({"background": "transparent"}, "gpt-image-2-5-edit"),
        inputs={"images": PortValueDict(type="Image", value=[str(img)]),
                "prompt": PortValueDict(type="Text", value="cut it out")},
        api_keys={"OPENAI_API_KEY": "k"}, emit=None, run_dir=tmp_path)
    form = route.calls[0].request.content
    assert b'name="model"\r\n\r\ngpt-image-2.5-flare' in form
    assert b'name="background"\r\n\r\ntransparent' in form
    assert Path(out["image"]["value"]).exists()


@pytest.mark.asyncio
@respx.mock
async def test_25_org_verification_message_names_the_model() -> None:
    respx.post("https://api.openai.com/v1/images/generations").mock(
        return_value=Response(403, json={"error": {"code": "organization_must_be_verified", "message": "verify"}}))
    with pytest.raises(RuntimeError, match="verified for gpt-image-2.5-flare"):
        await handle_gpt_image_25_generate(_node_25({}), inputs={"prompt": PortValueDict(type="Text", value="hi")},
                                          api_keys={"OPENAI_API_KEY": "k"}, emit=None, run_dir=Path("/tmp"))
