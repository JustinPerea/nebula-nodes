from __future__ import annotations

import base64
import json
import shutil
from pathlib import Path
from unittest.mock import AsyncMock, patch, MagicMock

import pytest

from handlers.openai_image import handle_openai_image_generate
from models.graph import GraphNode, PortValueDict
from services.output import OUTPUT_ROOT

RED_PIXEL_B64 = (
    "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR4"
    "2mP8/5+hHgAHggJ/PchI7wAAAABJRU5ErkJggg=="
)

# Format-accurate fixtures for output_format tests: the real API honours
# output_format, so a jpeg/webp request returns jpeg/webp bytes. F-31 output
# validation corrects extensions that disagree with the actual bytes, so these
# fixtures must carry the right magic bytes for the asserted extension.
JPEG_PIXEL_B64 = base64.b64encode(
    b"\xff\xd8\xff\xe0\x00\x10JFIF\x00\x01\x01\x00\x00\x01\x00\x01\x00\x00"
    b"\xff\xd9"
).decode()
WEBP_PIXEL_B64 = base64.b64encode(
    b"RIFF" + (20).to_bytes(4, "little") + b"WEBPVP8 " + b"\x00" * 8
).decode()

_API_KEYS = {"OPENAI_API_KEY": "sk-test-key"}


def _make_node(definition_id: str = "gpt-image-1-generate", params: dict | None = None) -> GraphNode:
    return GraphNode(
        id="test-node-1",
        definitionId=definition_id,
        params=params or {"model": "gpt-image-1", "size": "1024x1024", "quality": "auto", "n": 1},
    )


def _mock_response(b64_data: str) -> MagicMock:
    resp = MagicMock()
    resp.status_code = 200
    resp.raise_for_status = MagicMock()
    resp.json.return_value = {
        "created": 1234567890,
        "data": [{"b64_json": b64_data}],
    }
    return resp


def _patch_client(mock_resp: MagicMock):
    """Context manager that patches httpx.AsyncClient inside the handler."""
    mock_client = AsyncMock()
    mock_client.post.return_value = mock_resp
    mock_client.__aenter__ = AsyncMock(return_value=mock_client)
    mock_client.__aexit__ = AsyncMock(return_value=False)
    return patch("handlers.openai_image.httpx.AsyncClient", return_value=mock_client), mock_client


@pytest.fixture(autouse=True)
def cleanup_output():
    """OUTPUT_ROOT is sandboxed to a tmp dir by tests/conftest.py
    (NEBULA_OUTPUT_ROOT env var), so the whole-tree rmtree that previously
    lived here is no longer necessary — and is dangerous without the
    sandbox, because it would wipe the user's real output/. Left as a
    no-op hook in case per-test isolation is needed later."""
    yield


# ---------------------------------------------------------------------------
# Basic happy-path
# ---------------------------------------------------------------------------


@pytest.mark.asyncio
async def test_generates_image_and_saves_file() -> None:
    mock_resp = _mock_response(RED_PIXEL_B64)

    with patch("handlers.openai_image.httpx.AsyncClient") as MockClient:
        mock_client_instance = AsyncMock()
        mock_client_instance.post.return_value = mock_resp
        mock_client_instance.__aenter__ = AsyncMock(return_value=mock_client_instance)
        mock_client_instance.__aexit__ = AsyncMock(return_value=False)
        MockClient.return_value = mock_client_instance

        node = _make_node()
        inputs = {"prompt": PortValueDict(type="Text", value="a red pixel")}

        result = await handle_openai_image_generate(node, inputs, _API_KEYS)

    assert "image" in result
    assert result["image"]["type"] == "Image"
    file_path = Path(result["image"]["value"])
    assert file_path.suffix == ".png"

    call_kwargs = mock_client_instance.post.call_args
    body = call_kwargs.kwargs.get("json") or call_kwargs[1].get("json")
    assert body["model"] == "gpt-image-1"
    assert body["prompt"] == "a red pixel"
    # gpt-image-1 returns b64_json by default — response_format is omitted for non-DALL-E models
    assert "response_format" not in body


# ---------------------------------------------------------------------------
# Request body shape — gpt-image-1
# ---------------------------------------------------------------------------


@pytest.mark.asyncio
async def test_gpt_image_1_forwards_output_format_jpeg() -> None:
    """output_format=jpeg must appear in the request body for gpt-image-1."""
    mock_resp = _mock_response(RED_PIXEL_B64)
    patcher, mock_client = _patch_client(mock_resp)

    with patcher:
        node = _make_node(params={"model": "gpt-image-1", "output_format": "jpeg"})
        inputs = {"prompt": PortValueDict(type="Text", value="test")}
        await handle_openai_image_generate(node, inputs, _API_KEYS)

    body = mock_client.post.call_args.kwargs["json"]
    assert body["output_format"] == "jpeg"
    assert "response_format" not in body


@pytest.mark.asyncio
async def test_gpt_image_1_omits_output_format_png_default() -> None:
    """output_format=png is the API default; we skip it to keep requests minimal."""
    mock_resp = _mock_response(RED_PIXEL_B64)
    patcher, mock_client = _patch_client(mock_resp)

    with patcher:
        node = _make_node(params={"model": "gpt-image-1", "output_format": "png"})
        inputs = {"prompt": PortValueDict(type="Text", value="test")}
        await handle_openai_image_generate(node, inputs, _API_KEYS)

    body = mock_client.post.call_args.kwargs["json"]
    assert "output_format" not in body


@pytest.mark.asyncio
async def test_gpt_image_1_forwards_background_transparent() -> None:
    """background=transparent must appear in the request body for gpt-image-1."""
    mock_resp = _mock_response(RED_PIXEL_B64)
    patcher, mock_client = _patch_client(mock_resp)

    with patcher:
        node = _make_node(params={"model": "gpt-image-1", "background": "transparent"})
        inputs = {"prompt": PortValueDict(type="Text", value="test")}
        await handle_openai_image_generate(node, inputs, _API_KEYS)

    body = mock_client.post.call_args.kwargs["json"]
    assert body["background"] == "transparent"


@pytest.mark.asyncio
async def test_gpt_image_1_omits_background_auto() -> None:
    """background=auto is the API default; omit it."""
    mock_resp = _mock_response(RED_PIXEL_B64)
    patcher, mock_client = _patch_client(mock_resp)

    with patcher:
        node = _make_node(params={"model": "gpt-image-1", "background": "auto"})
        inputs = {"prompt": PortValueDict(type="Text", value="test")}
        await handle_openai_image_generate(node, inputs, _API_KEYS)

    body = mock_client.post.call_args.kwargs["json"]
    assert "background" not in body


@pytest.mark.asyncio
async def test_gpt_image_1_does_not_send_response_format() -> None:
    """GPT image models always return b64_json — response_format must not be sent."""
    mock_resp = _mock_response(RED_PIXEL_B64)
    patcher, mock_client = _patch_client(mock_resp)

    with patcher:
        node = _make_node(params={"model": "gpt-image-1"})
        inputs = {"prompt": PortValueDict(type="Text", value="test")}
        await handle_openai_image_generate(node, inputs, _API_KEYS)

    body = mock_client.post.call_args.kwargs["json"]
    assert "response_format" not in body


@pytest.mark.asyncio
async def test_gpt_image_1_does_not_send_style() -> None:
    """style was a dall-e-3-only param; must never appear for gpt-image models."""
    mock_resp = _mock_response(RED_PIXEL_B64)
    patcher, mock_client = _patch_client(mock_resp)

    with patcher:
        node = _make_node(params={"model": "gpt-image-1", "style": "vivid"})
        inputs = {"prompt": PortValueDict(type="Text", value="test")}
        await handle_openai_image_generate(node, inputs, _API_KEYS)

    body = mock_client.post.call_args.kwargs["json"]
    assert "style" not in body


# ---------------------------------------------------------------------------
# Error handling
# ---------------------------------------------------------------------------


@pytest.mark.asyncio
async def test_missing_prompt_raises() -> None:
    node = _make_node()
    inputs: dict[str, PortValueDict] = {}

    with pytest.raises(ValueError, match="[Pp]rompt"):
        await handle_openai_image_generate(node, inputs, _API_KEYS)


@pytest.mark.asyncio
async def test_missing_api_key_raises_openai_api_key() -> None:
    """Error message must name OPENAI_API_KEY so the user knows which env var to set."""
    node = _make_node()
    inputs = {"prompt": PortValueDict(type="Text", value="test")}

    with pytest.raises(ValueError, match="OPENAI_API_KEY"):
        await handle_openai_image_generate(node, inputs, {})


@pytest.mark.asyncio
async def test_api_error_propagates() -> None:
    with patch("handlers.openai_image.httpx.AsyncClient") as MockClient:
        mock_client_instance = AsyncMock()
        mock_client_instance.post.side_effect = RuntimeError("API connection failed")
        mock_client_instance.__aenter__ = AsyncMock(return_value=mock_client_instance)
        mock_client_instance.__aexit__ = AsyncMock(return_value=False)
        MockClient.return_value = mock_client_instance

        node = _make_node()
        inputs = {"prompt": PortValueDict(type="Text", value="test")}

        with pytest.raises(RuntimeError, match="API connection failed"):
            await handle_openai_image_generate(node, inputs, _API_KEYS)


@pytest.mark.asyncio
async def test_non_200_response_raises_runtime_error() -> None:
    """A non-200 HTTP status must raise RuntimeError with the status code."""
    with patch("handlers.openai_image.httpx.AsyncClient") as MockClient:
        mock_client_instance = AsyncMock()
        bad_resp = MagicMock()
        bad_resp.status_code = 429
        bad_resp.text = '{"error": {"message": "rate limited"}}'
        mock_client_instance.post.return_value = bad_resp
        mock_client_instance.__aenter__ = AsyncMock(return_value=mock_client_instance)
        mock_client_instance.__aexit__ = AsyncMock(return_value=False)
        MockClient.return_value = mock_client_instance

        node = _make_node()
        inputs = {"prompt": PortValueDict(type="Text", value="test")}

        with pytest.raises(RuntimeError, match="429"):
            await handle_openai_image_generate(node, inputs, _API_KEYS)


# ---------------------------------------------------------------------------
# Output contract
# ---------------------------------------------------------------------------


@pytest.mark.asyncio
async def test_output_returns_image_type() -> None:
    """Handler must return {'image': {'type': 'Image', 'value': <path>}}."""
    mock_resp = _mock_response(RED_PIXEL_B64)
    patcher, mock_client = _patch_client(mock_resp)

    with patcher:
        node = _make_node()
        inputs = {"prompt": PortValueDict(type="Text", value="test")}
        result = await handle_openai_image_generate(node, inputs, _API_KEYS)

    assert set(result.keys()) == {"image"}
    assert result["image"]["type"] == "Image"
    assert isinstance(result["image"]["value"], str)
    # Default model (gpt-image-1) with no output_format → PNG
    assert result["image"]["value"].endswith(".png")


# ---------------------------------------------------------------------------
# File extension follows output_format
# ---------------------------------------------------------------------------


@pytest.mark.asyncio
async def test_gpt_image_1_saves_jpeg_extension() -> None:
    """When output_format=jpeg the saved file must have a .jpeg extension."""
    mock_resp = _mock_response(JPEG_PIXEL_B64)
    patcher, mock_client = _patch_client(mock_resp)

    with patcher:
        node = _make_node(params={"model": "gpt-image-1", "output_format": "jpeg"})
        inputs = {"prompt": PortValueDict(type="Text", value="test")}
        result = await handle_openai_image_generate(node, inputs, _API_KEYS)

    assert result["image"]["value"].endswith(".jpeg")


@pytest.mark.asyncio
async def test_gpt_image_1_saves_webp_extension() -> None:
    """When output_format=webp the saved file must have a .webp extension."""
    mock_resp = _mock_response(WEBP_PIXEL_B64)
    patcher, mock_client = _patch_client(mock_resp)

    with patcher:
        node = _make_node(params={"model": "gpt-image-1", "output_format": "webp"})
        inputs = {"prompt": PortValueDict(type="Text", value="test")}
        result = await handle_openai_image_generate(node, inputs, _API_KEYS)

    assert result["image"]["value"].endswith(".webp")


# ---------------------------------------------------------------------------
# gpt-image-1 retirement (shuts down 2026-10-23) and the edit node's Count
# ---------------------------------------------------------------------------


@pytest.mark.asyncio
async def test_generate_defaults_to_gpt_image_2_5_flare_and_sends_max_quality() -> None:
    patcher, client = _patch_client(_mock_response(RED_PIXEL_B64))
    with patcher:
        await handle_openai_image_generate(
            GraphNode(id="g", definitionId="gpt-image-1-generate", params={"quality": "max"}),
            {"prompt": PortValueDict(type="Text", value="x")}, _API_KEYS,
        )
    body = client.post.call_args.kwargs["json"]
    assert body["model"] == "gpt-image-2.5-flare"
    assert body["quality"] == "max"


@pytest.mark.asyncio
async def test_transparent_background_needs_png_or_webp() -> None:
    patcher, client = _patch_client(_mock_response(RED_PIXEL_B64))
    with patcher, pytest.raises(ValueError, match="PNG or WebP"):
        await handle_openai_image_generate(
            _make_node(params={"model": "gpt-image-2.5-flare", "background": "transparent", "output_format": "jpeg"}),
            {"prompt": PortValueDict(type="Text", value="x")}, _API_KEYS,
        )
    client.post.assert_not_called()


def _edit_client(images: list[str]):
    resp = MagicMock(status_code=200, raise_for_status=MagicMock())
    resp.json.return_value = {"data": [{"b64_json": b64} for b64 in images]}
    client = AsyncMock()
    client.post.return_value = resp
    client.__aenter__ = AsyncMock(return_value=client)
    client.__aexit__ = AsyncMock(return_value=False)
    return patch("handlers.openai_image_edit.httpx.AsyncClient", return_value=client), client


@pytest.mark.asyncio
async def test_edit_keeps_every_image_count_asks_for(tmp_path) -> None:
    from handlers.openai_image_edit import handle_openai_image_edit
    from services.output import resolve_output_ref

    source = OUTPUT_ROOT / "edit-source.png"
    source.parent.mkdir(parents=True, exist_ok=True)
    source.write_bytes(base64.b64decode(RED_PIXEL_B64))
    patcher, client = _edit_client([RED_PIXEL_B64, RED_PIXEL_B64, RED_PIXEL_B64])
    with patcher:
        result = await handle_openai_image_edit(
            GraphNode(id="e", definitionId="gpt-image-1-edit", params={"n": 3}),
            {"image": PortValueDict(type="Image", value=str(source)),
             "prompt": PortValueDict(type="Text", value="make it blue")},
            _API_KEYS,
        )
    fields = dict((k, v[1]) for k, v in client.post.call_args.kwargs["files"] if k != "image")
    assert fields["model"] == "gpt-image-2.5-sunburst", "the edit node's new default"
    assert fields["n"] == "3"
    assert result["images"]["type"] == "Array"
    assert len(result["images"]["value"]) == 3
    saved = [Path(resolve_output_ref(ref)) for ref in result["images"]["value"]]
    assert len(set(saved)) == 3 and all(path.exists() for path in saved)
    assert Path(result["image"]["value"]) == saved[0]


@pytest.mark.asyncio
async def test_edit_with_no_image_in_the_reply_says_so() -> None:
    from handlers.openai_image_edit import handle_openai_image_edit

    source = OUTPUT_ROOT / "edit-source-empty.png"
    source.parent.mkdir(parents=True, exist_ok=True)
    source.write_bytes(base64.b64decode(RED_PIXEL_B64))
    patcher, _ = _edit_client([])
    with patcher, pytest.raises(RuntimeError, match="no image"):
        await handle_openai_image_edit(
            GraphNode(id="e", definitionId="gpt-image-1-edit", params={}),
            {"image": PortValueDict(type="Image", value=str(source)),
             "prompt": PortValueDict(type="Text", value="x")},
            _API_KEYS,
        )
