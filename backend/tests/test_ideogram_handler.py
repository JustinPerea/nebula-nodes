"""Ideogram direct-API handler tests (api.ideogram.ai).

Body-shape tests pin the multipart request envelopes against the OpenAPI specs
fetched from developer.ideogram.ai on 2026-06-10:
  /v1/ideogram-v4/generate, /v1/ideogram-v4/remix, /v1/ideogram-v3/inpaint,
  /v1/ideogram-v3/reframe, /v1/ideogram-v3/replace-background,
  /v1/ideogram-v3/generate (character refs), /upscale.
"""

from __future__ import annotations

import base64
import json
from pathlib import Path
from unittest.mock import AsyncMock, MagicMock, patch

import pytest

from handlers.ideogram import (
    IDEOGRAM_API_BASE,
    expand_character_inputs,
    handle_ideogram_character,
    handle_ideogram_edit,
    handle_ideogram_reframe,
    handle_ideogram_remix,
    handle_ideogram_replace_background,
    handle_ideogram_upscale,
    handle_ideogram_v4_generate,
)
from models.graph import GraphNode, PortValueDict

RED_PIXEL_B64 = (
    "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR4"
    "2mP8/5+hHgAHggJ/PchI7wAAAABJRU5ErkJggg=="
)
RED_PIXEL_URI = f"data:image/png;base64,{RED_PIXEL_B64}"

_KEYS = {"IDEOGRAM_API_KEY": "ideo-test-key"}


def _make_node(definition_id: str, params: dict | None = None) -> GraphNode:
    return GraphNode(id=f"test-{definition_id}", definitionId=definition_id, params=params or {})


def _ideogram_response() -> MagicMock:
    resp = MagicMock()
    resp.status_code = 200
    resp.json.return_value = {
        "created": "2026-06-10T00:00:00+00:00",
        "data": [{"url": "https://ideogram.ai/api/images/ephemeral/abc.png", "seed": 7}],
    }
    return resp


def _download_response() -> MagicMock:
    resp = MagicMock()
    resp.status_code = 200
    resp.content = base64.b64decode(RED_PIXEL_B64)
    resp.headers = {"content-type": "image/png"}
    resp.raise_for_status = MagicMock()
    return resp


def _patch_client(post_resp: MagicMock):
    """One mocked AsyncClient: POST returns the API response, GET the download."""
    mock_client = AsyncMock()
    mock_client.post = AsyncMock(return_value=post_resp)
    mock_client.get = AsyncMock(return_value=_download_response())
    mock_client.__aenter__ = AsyncMock(return_value=mock_client)
    mock_client.__aexit__ = AsyncMock(return_value=False)
    return patch("handlers.ideogram.httpx.AsyncClient", return_value=mock_client), mock_client


def _post_kwargs(mock_client) -> dict:
    return mock_client.post.call_args.kwargs


@pytest.mark.asyncio
async def test_v4_generate_body_shape(tmp_path):
    with patch("handlers.ideogram.get_run_dir", return_value=tmp_path):
        patcher, client = _patch_client(_ideogram_response())
        with patcher:
            result = await handle_ideogram_v4_generate(
                _make_node("ideogram-v4", {"resolution": "2048x2048", "rendering_speed": "QUALITY"}),
                {"prompt": PortValueDict(type="Text", value="a poster that says OPEN")},
                _KEYS,
            )

    url = client.post.call_args.args[0]
    assert url == f"{IDEOGRAM_API_BASE}/v1/ideogram-v4/generate"
    kwargs = _post_kwargs(client)
    assert kwargs["headers"] == {"Api-Key": "ideo-test-key"}
    assert kwargs["data"]["text_prompt"] == "a poster that says OPEN"
    assert kwargs["data"]["resolution"] == "2048x2048"
    assert kwargs["data"]["rendering_speed"] == "QUALITY"
    assert not kwargs["files"]
    assert result["image"]["type"] == "Image"
    assert Path(result["image"]["value"]).exists()


@pytest.mark.asyncio
async def test_v4_generate_requires_key():
    with pytest.raises(ValueError, match="IDEOGRAM_API_KEY"):
        await handle_ideogram_v4_generate(
            _make_node("ideogram-v4"),
            {"prompt": PortValueDict(type="Text", value="x")},
            {},
        )


@pytest.mark.asyncio
async def test_edit_posts_inpaint_with_image_and_mask(tmp_path):
    """Edit hits /v1/ideogram-v3/inpaint with image+mask binaries and the prompt."""
    with patch("handlers.ideogram.get_run_dir", return_value=tmp_path):
        patcher, client = _patch_client(_ideogram_response())
        with patcher:
            await handle_ideogram_edit(
                _make_node("ideogram-edit", {"magic_prompt": "OFF", "num_images": 2}),
                {
                    "prompt": PortValueDict(type="Text", value="make the sign neon"),
                    "image": PortValueDict(type="Image", value=RED_PIXEL_URI),
                    "mask": PortValueDict(type="Image", value=RED_PIXEL_URI),
                    "images": PortValueDict(type="Image", value=[RED_PIXEL_URI]),
                },
                _KEYS,
            )

    url = client.post.call_args.args[0]
    assert url.endswith("/v1/ideogram-v3/inpaint")
    kwargs = _post_kwargs(client)
    assert kwargs["data"]["prompt"] == "make the sign neon"
    assert kwargs["data"]["magic_prompt"] == "OFF"
    assert kwargs["data"]["num_images"] == "2"
    field_names = [f[0] for f in kwargs["files"]]
    assert field_names == ["image", "mask", "style_reference_images"]


@pytest.mark.asyncio
async def test_remix_rides_v4_endpoint(tmp_path):
    """Direct remix routes through the V4 model with text_prompt + image_weight."""
    with patch("handlers.ideogram.get_run_dir", return_value=tmp_path):
        patcher, client = _patch_client(_ideogram_response())
        with patcher:
            await handle_ideogram_remix(
                _make_node("ideogram-remix", {"image_weight": 70}),
                {
                    "prompt": PortValueDict(type="Text", value="same scene at night"),
                    "image": PortValueDict(type="Image", value=RED_PIXEL_URI),
                },
                _KEYS,
            )

    url = client.post.call_args.args[0]
    assert url.endswith("/v1/ideogram-v4/remix")
    kwargs = _post_kwargs(client)
    assert kwargs["data"]["text_prompt"] == "same scene at night"
    assert kwargs["data"]["image_weight"] == "70"
    assert [f[0] for f in kwargs["files"]] == ["image"]


@pytest.mark.asyncio
async def test_reframe_requires_resolution(tmp_path):
    with pytest.raises(ValueError, match="resolution"):
        await handle_ideogram_reframe(
            _make_node("ideogram-reframe"),
            {"image": PortValueDict(type="Image", value=RED_PIXEL_URI)},
            _KEYS,
        )


@pytest.mark.asyncio
async def test_reframe_body_shape(tmp_path):
    with patch("handlers.ideogram.get_run_dir", return_value=tmp_path):
        patcher, client = _patch_client(_ideogram_response())
        with patcher:
            await handle_ideogram_reframe(
                _make_node("ideogram-reframe", {"resolution": "1280x800"}),
                {"image": PortValueDict(type="Image", value=RED_PIXEL_URI)},
                _KEYS,
            )

    url = client.post.call_args.args[0]
    assert url.endswith("/v1/ideogram-v3/reframe")
    kwargs = _post_kwargs(client)
    assert kwargs["data"]["resolution"] == "1280x800"
    assert "prompt" not in kwargs["data"]  # reframe takes no prompt


@pytest.mark.asyncio
async def test_replace_background_body_shape(tmp_path):
    with patch("handlers.ideogram.get_run_dir", return_value=tmp_path):
        patcher, client = _patch_client(_ideogram_response())
        with patcher:
            await handle_ideogram_replace_background(
                _make_node("ideogram-replace-background", {"magic_prompt": "AUTO"}),
                {
                    "prompt": PortValueDict(type="Text", value="a beach at golden hour"),
                    "image": PortValueDict(type="Image", value=RED_PIXEL_URI),
                },
                _KEYS,
            )

    url = client.post.call_args.args[0]
    assert url.endswith("/v1/ideogram-v3/replace-background")
    kwargs = _post_kwargs(client)
    assert kwargs["data"]["prompt"] == "a beach at golden hour"
    assert [f[0] for f in kwargs["files"]] == ["image"]


@pytest.mark.asyncio
async def test_character_posts_v3_generate_with_character_refs(tmp_path):
    with patch("handlers.ideogram.get_run_dir", return_value=tmp_path):
        patcher, client = _patch_client(_ideogram_response())
        with patcher:
            await handle_ideogram_character(
                _make_node("ideogram-character", {"style_type": "FICTION", "aspect_ratio": "16x9"}),
                {
                    "prompt": PortValueDict(type="Text", value="the explorer at a campfire"),
                    "reference_images": PortValueDict(type="Image", value=[RED_PIXEL_URI, RED_PIXEL_URI]),
                },
                _KEYS,
            )

    url = client.post.call_args.args[0]
    assert url.endswith("/v1/ideogram-v3/generate")
    kwargs = _post_kwargs(client)
    assert kwargs["data"]["style_type"] == "FICTION"
    assert kwargs["data"]["aspect_ratio"] == "16x9"
    field_names = [f[0] for f in kwargs["files"]]
    assert field_names == ["character_reference_images", "character_reference_images"]


@pytest.mark.asyncio
async def test_character_requires_refs():
    with pytest.raises(ValueError, match="[Cc]haracter [Rr]efs"):
        await handle_ideogram_character(
            _make_node("ideogram-character"),
            {"prompt": PortValueDict(type="Text", value="x")},
            _KEYS,
        )


@pytest.mark.asyncio
async def test_upscale_sends_image_request_blob(tmp_path):
    with patch("handlers.ideogram.get_run_dir", return_value=tmp_path):
        patcher, client = _patch_client(_ideogram_response())
        with patcher:
            await handle_ideogram_upscale(
                _make_node("ideogram-upscale", {"resemblance": 70, "detail": 30}),
                {
                    "image": PortValueDict(type="Image", value=RED_PIXEL_URI),
                    "prompt": PortValueDict(type="Text", value="sharper text"),
                },
                _KEYS,
            )

    url = client.post.call_args.args[0]
    assert url.endswith("/upscale")
    kwargs = _post_kwargs(client)
    blob = json.loads(kwargs["data"]["image_request"])
    assert blob["resemblance"] == 70
    assert blob["detail"] == 30
    assert blob["prompt"] == "sharper text"
    assert [f[0] for f in kwargs["files"]] == ["image_file"]


@pytest.mark.asyncio
async def test_api_error_propagates(tmp_path):
    err = MagicMock()
    err.status_code = 422
    err.text = '{"error": "safety"}'
    patcher, _client = _patch_client(err)
    with patcher:
        with pytest.raises(RuntimeError, match="422"):
            await handle_ideogram_v4_generate(
                _make_node("ideogram-v4"),
                {"prompt": PortValueDict(type="Text", value="x")},
                _KEYS,
            )


# ---------------------------------------------------------------------------
# Character-bundle expansion (shared by both routes)
# ---------------------------------------------------------------------------


def _bundle() -> dict:
    return {
        "characterId": "ch-1",
        "name": "Stepling",
        "referenceViews": ["/refs/front.png", "/refs/side.png"],
        "frozenTraitString": "a small moss-green creature with copper goggles",
        "seed": 1234,
        "consistencyStrength": 0.7,
    }


def test_expand_character_prefixes_trait_and_merges_refs():
    node = _make_node("ideogram-character")
    inputs = {
        "prompt": PortValueDict(type="Text", value="crossing a rope bridge"),
        "character": PortValueDict(type="Character", value=_bundle()),
        "reference_images": PortValueDict(type="Image", value=["/extra/ref.png"]),
    }
    expanded = expand_character_inputs(node, inputs)
    # Trait VERBATIM first, then the base prompt (identity.py contract).
    assert expanded["prompt"].value == (
        "a small moss-green creature with copper goggles. crossing a rope bridge"
    )
    # Stored views first, then the port refs.
    assert expanded["reference_images"].value == [
        "/refs/front.png", "/refs/side.png", "/extra/ref.png",
    ]
    # Bundle seed lands in params when the user left seed unset.
    assert node.params["seed"] == 1234


def test_expand_character_keeps_user_seed():
    node = _make_node("ideogram-character", {"seed": 999})
    inputs = {
        "prompt": PortValueDict(type="Text", value="x"),
        "character": PortValueDict(type="Character", value=_bundle()),
    }
    expand_character_inputs(node, inputs)
    assert node.params["seed"] == 999


def test_expand_character_noop_without_bundle():
    node = _make_node("ideogram-character")
    inputs = {"prompt": PortValueDict(type="Text", value="plain")}
    assert expand_character_inputs(node, inputs) is inputs


# ---------------------------------------------------------------------------
# Dual-route registry behavior (direct preferred, FAL fallback)
# ---------------------------------------------------------------------------


def _registry():
    from execution.sync_runner import get_handler_registry

    async def fake_emit(_e):
        pass

    return get_handler_registry(emit=fake_emit)


@pytest.mark.asyncio
async def test_router_uses_direct_when_ideogram_key_present(tmp_path):
    with patch("handlers.ideogram.get_run_dir", return_value=tmp_path):
        patcher, client = _patch_client(_ideogram_response())
        with patcher:
            handler = _registry()["ideogram-v4"]
            await handler(
                _make_node("ideogram-v4"),
                {"prompt": PortValueDict(type="Text", value="x")},
                {"IDEOGRAM_API_KEY": "ideo", "FAL_KEY": "fal"},
            )
    assert client.post.call_args.args[0].endswith("/v1/ideogram-v4/generate")


@pytest.mark.asyncio
async def test_router_falls_back_to_fal_without_ideogram_key():
    submit = MagicMock()
    submit.status_code = 200
    submit.json.return_value = {"images": [{"url": "https://fal.ai/out.png"}]}
    with patch("handlers.fal_universal.httpx.AsyncClient") as MockClient:
        mock_client = AsyncMock()
        mock_client.post.return_value = submit
        mock_client.__aenter__ = AsyncMock(return_value=mock_client)
        mock_client.__aexit__ = AsyncMock(return_value=False)
        MockClient.return_value = mock_client

        handler = _registry()["ideogram-v4"]
        node = _make_node("ideogram-v4")
        await handler(
            node,
            {"prompt": PortValueDict(type="Text", value="x")},
            {"FAL_KEY": "fal"},
        )
    assert node.params["endpoint_id"] == "ideogram/v4"


@pytest.mark.asyncio
async def test_reframe_router_falls_back_to_fal_when_resolution_unset():
    """Direct reframe REQUIRES resolution; without it the router must take FAL
    (which sizes via image_size) instead of failing the direct call."""
    submit = MagicMock()
    submit.status_code = 200
    submit.json.return_value = {"images": [{"url": "https://fal.ai/out.png"}]}
    with patch("handlers.fal_universal.httpx.AsyncClient") as MockClient:
        mock_client = AsyncMock()
        mock_client.post.return_value = submit
        mock_client.__aenter__ = AsyncMock(return_value=mock_client)
        mock_client.__aexit__ = AsyncMock(return_value=False)
        MockClient.return_value = mock_client

        handler = _registry()["ideogram-reframe"]
        node = _make_node("ideogram-reframe", {"image_size": "landscape_16_9"})
        await handler(
            node,
            {"image": PortValueDict(type="Image", value=RED_PIXEL_URI)},
            {"IDEOGRAM_API_KEY": "ideo", "FAL_KEY": "fal"},
        )
    assert node.params["endpoint_id"] == "fal-ai/ideogram/v3/reframe"


@pytest.mark.asyncio
async def test_character_router_expands_bundle_for_fal_route():
    """The Character bundle expansion applies on the FAL route too: trait-prefixed
    prompt + referenceViews flow into the FAL payload."""
    submit = MagicMock()
    submit.status_code = 200
    submit.json.return_value = {"images": [{"url": "https://fal.ai/out.png"}]}
    with patch("handlers.fal_universal.httpx.AsyncClient") as MockClient:
        mock_client = AsyncMock()
        mock_client.post.return_value = submit
        mock_client.__aenter__ = AsyncMock(return_value=mock_client)
        mock_client.__aexit__ = AsyncMock(return_value=False)
        MockClient.return_value = mock_client

        handler = _registry()["ideogram-character"]
        node = _make_node("ideogram-character")
        await handler(
            node,
            {
                "prompt": PortValueDict(type="Text", value="at a campfire"),
                "character": PortValueDict(type="Character", value=_bundle()),
            },
            {"FAL_KEY": "fal"},
        )

    payload = mock_client.post.call_args.kwargs["json"]
    assert payload["prompt"].startswith("a small moss-green creature with copper goggles. ")
    assert payload["reference_image_urls"] == ["/refs/front.png", "/refs/side.png"]
    assert payload["seed"] == 1234


@pytest.mark.asyncio
async def test_character_router_requires_refs_or_character():
    handler = _registry()["ideogram-character"]
    with pytest.raises(ValueError, match="[Cc]haracter"):
        await handler(
            _make_node("ideogram-character"),
            {"prompt": PortValueDict(type="Text", value="x")},
            {"FAL_KEY": "fal"},
        )
