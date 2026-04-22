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
    assert body["partial_images"] == 2  # default


def test_build_generate_body_omits_unsupported_params() -> None:
    # background and input_fidelity must be stripped defensively even if present.
    node = _node({"background": "transparent", "input_fidelity": "high", "size": "1024x1024"})
    body = build_generate_body(node, prompt_text="x")
    assert "background" not in body
    assert "input_fidelity" not in body
    assert body["size"] == "1024x1024"


def test_build_generate_body_passes_quality_format_moderation() -> None:
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
    assert body["n"] == 2
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
        "image": PortValueDict(type="Image", value=img_paths),
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
