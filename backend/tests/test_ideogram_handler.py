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
    handle_ideogram_describe,
    handle_ideogram_edit,
    handle_ideogram_edit_prompt,
    handle_ideogram_layerize,
    handle_ideogram_magic_prompt,
    handle_ideogram_reframe,
    handle_ideogram_remix,
    handle_ideogram_remove_background,
    handle_ideogram_replace_background,
    handle_ideogram_train_model,
    handle_ideogram_transparent,
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


def _multipart_text_fields(kwargs: dict) -> dict[str, str]:
    """Scalar multipart fields encoded as ``(name, (None, value))``."""
    out: dict[str, str] = {}
    for name, part in kwargs.get("files") or []:
        if isinstance(part, tuple) and len(part) == 2 and part[0] is None:
            out[name] = part[1]
    return out


def _multipart_file_names(kwargs: dict) -> list[str]:
    """Binary file field names: ``(name, (filename, bytes, mime))``."""
    names: list[str] = []
    for name, part in kwargs.get("files") or []:
        if isinstance(part, tuple) and len(part) == 3:
            names.append(name)
    return names


@pytest.mark.asyncio
async def test_v4_generate_body_shape(tmp_path):
    with patch("handlers.ideogram.get_run_dir", return_value=tmp_path):
        patcher, client = _patch_client(_ideogram_response())
        with patcher:
            result = await handle_ideogram_v4_generate(
                _make_node(
                    "ideogram-v4",
                    {
                        "resolution": "2048x2048",
                        "rendering_speed": "QUALITY",
                        "enable_copyright_detection": True,
                        # FAL-only fields must not leak into direct multipart.
                        "num_images": 4,
                        "seed": 123,
                        "expansion_model": "Large",
                    },
                ),
                {"prompt": PortValueDict(type="Text", value="a poster that says OPEN")},
                _KEYS,
            )

    url = client.post.call_args.args[0]
    assert url == f"{IDEOGRAM_API_BASE}/v1/ideogram-v4/generate"
    kwargs = _post_kwargs(client)
    assert kwargs["headers"] == {"Api-Key": "ideo-test-key"}
    fields = _multipart_text_fields(kwargs)
    assert fields["text_prompt"] == "a poster that says OPEN"
    assert fields["resolution"] == "2048x2048"
    assert fields["rendering_speed"] == "QUALITY"
    assert fields["enable_copyright_detection"] == "true"
    assert "num_images" not in fields
    assert "seed" not in fields
    assert "expansion_model" not in fields
    assert not _multipart_file_names(kwargs)
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
async def test_v4_generate_rejects_fal_speed_before_request():
    with pytest.raises(ValueError, match="rendering_speed.*BALANCED"):
        await handle_ideogram_v4_generate(
            _make_node("ideogram-v4", {"rendering_speed": "BALANCED"}),
            {"prompt": PortValueDict(type="Text", value="x")},
            _KEYS,
        )


@pytest.mark.asyncio
async def test_v4_generate_rejects_unknown_resolution_before_request():
    with pytest.raises(ValueError, match="V4 resolution.*1280x720"):
        await handle_ideogram_v4_generate(
            _make_node("ideogram-v4", {"resolution": "1280x720"}),
            {"prompt": PortValueDict(type="Text", value="x")},
            _KEYS,
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
    fields = _multipart_text_fields(kwargs)
    assert fields["prompt"] == "make the sign neon"
    assert fields["magic_prompt"] == "OFF"
    assert fields["num_images"] == "2"
    assert _multipart_file_names(kwargs) == ["image", "mask", "style_reference_images"]


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
    fields = _multipart_text_fields(kwargs)
    assert fields["text_prompt"] == "same scene at night"
    assert fields["image_weight"] == "70"
    assert _multipart_file_names(kwargs) == ["image"]


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
    fields = _multipart_text_fields(kwargs)
    assert fields["resolution"] == "1280x800"
    assert "prompt" not in fields  # reframe takes no prompt


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
    fields = _multipart_text_fields(kwargs)
    assert fields["prompt"] == "a beach at golden hour"
    assert _multipart_file_names(kwargs) == ["image"]


@pytest.mark.asyncio
async def test_character_posts_v3_generate_with_character_refs(tmp_path):
    with patch("handlers.ideogram.get_run_dir", return_value=tmp_path):
        patcher, client = _patch_client(_ideogram_response())
        with patcher:
            await handle_ideogram_character(
                _make_node("ideogram-character", {"style_type": "FICTION", "aspect_ratio": "16x9"}),
                {
                    "prompt": PortValueDict(type="Text", value="the explorer at a campfire"),
                    "reference_images": PortValueDict(type="Image", value=[RED_PIXEL_URI]),
                },
                _KEYS,
            )

    url = client.post.call_args.args[0]
    assert url.endswith("/v1/ideogram-v3/generate")
    kwargs = _post_kwargs(client)
    fields = _multipart_text_fields(kwargs)
    assert fields["style_type"] == "FICTION"
    assert fields["aspect_ratio"] == "16x9"
    assert _multipart_file_names(kwargs) == ["character_reference_images"]


@pytest.mark.asyncio
async def test_character_rejects_multiple_refs_before_request():
    with pytest.raises(ValueError, match="exactly one.*received 2"):
        await handle_ideogram_character(
            _make_node("ideogram-character"),
            {
                "prompt": PortValueDict(type="Text", value="x"),
                "reference_images": PortValueDict(
                    type="Image", value=[RED_PIXEL_URI, RED_PIXEL_URI]
                ),
            },
            _KEYS,
        )


@pytest.mark.asyncio
async def test_character_rejects_unsupported_style_before_request():
    with pytest.raises(ValueError, match="style_type.*GENERAL"):
        await handle_ideogram_character(
            _make_node("ideogram-character", {"style_type": "GENERAL"}),
            {
                "prompt": PortValueDict(type="Text", value="x"),
                "reference_images": PortValueDict(type="Image", value=[RED_PIXEL_URI]),
            },
            _KEYS,
        )


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
    fields = _multipart_text_fields(kwargs)
    blob = json.loads(fields["image_request"])
    assert blob["resemblance"] == 70
    assert blob["detail"] == 30
    assert blob["prompt"] == "sharper text"
    assert _multipart_file_names(kwargs) == ["image_file"]


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
        "referenceViews": ["/refs/front.png"],
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
        "/refs/front.png", "/extra/ref.png",
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
        original_params = dict(node.params)
        await handler(
            node,
            {"prompt": PortValueDict(type="Text", value="x")},
            {"FAL_KEY": "fal"},
        )
    assert node.params == original_params


@pytest.mark.asyncio
async def test_fal_router_rejects_direct_speed_before_submit():
    handler = _registry()["ideogram-v4"]
    with pytest.raises(ValueError, match="FAL rendering_speed.*DEFAULT"):
        await handler(
            _make_node("ideogram-v4", {"rendering_speed": "DEFAULT"}),
            {"prompt": PortValueDict(type="Text", value="x")},
            {"FAL_KEY": "fal"},
        )


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
        original_params = dict(node.params)
        await handler(
            node,
            {"image": PortValueDict(type="Image", value=RED_PIXEL_URI)},
            {"IDEOGRAM_API_KEY": "ideo", "FAL_KEY": "fal"},
        )
    assert node.params == original_params


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
        original_params = dict(node.params)
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
    assert payload["reference_image_urls"] == ["/refs/front.png"]
    assert payload["seed"] == 1234
    assert node.params == original_params


@pytest.mark.asyncio
async def test_character_router_rejects_multiple_refs_on_fal_route():
    handler = _registry()["ideogram-character"]
    with pytest.raises(ValueError, match="exactly one.*received 2"):
        await handler(
            _make_node("ideogram-character"),
            {
                "prompt": PortValueDict(type="Text", value="x"),
                "reference_images": PortValueDict(
                    type="Image", value=["https://x/a.png", "https://x/b.png"]
                ),
            },
            {"FAL_KEY": "fal"},
        )


@pytest.mark.asyncio
async def test_character_router_requires_refs_or_character():
    handler = _registry()["ideogram-character"]
    with pytest.raises(ValueError, match="[Cc]haracter"):
        await handler(
            _make_node("ideogram-character"),
            {"prompt": PortValueDict(type="Text", value="x")},
            {"FAL_KEY": "fal"},
        )


# ---------------------------------------------------------------------------
# Direct-only capabilities: describe, magic prompt, transparent, remove-bg,
# layerize, prompt edit, custom model training
# ---------------------------------------------------------------------------


def test_direct_execution_patterns_match_handler_lifecycle():
    definitions = json.loads(
        (Path(__file__).resolve().parents[1] / "data" / "node_definitions.json").read_text()
    )

    # These handlers wait for the final 200 response and download any
    # ephemeral result URL directly. They do not submit a job id or poll.
    for node_id in (
        "ideogram-describe",
        "ideogram-magic-prompt",
        "ideogram-transparent",
        "ideogram-remove-background",
        "ideogram-layerize",
        "ideogram-edit-prompt",
    ):
        assert definitions[node_id]["executionPattern"] == "sync"

    # Training is the one direct Ideogram handler that really submits and
    # polls a long-running provider task.
    assert definitions["ideogram-train-model"]["executionPattern"] == "async-poll"


def _json_prompt_response() -> MagicMock:
    resp = MagicMock()
    resp.status_code = 200
    resp.json.return_value = {
        "json_prompt": {
            "high_level_description": "A neon diner sign at dusk",
            "style_description": "retro photographic, warm tungsten palette",
            "compositional_deconstruction": {"background": "dusk sky", "elements": []},
        },
        "aspect_ratio": "16x9",
    }
    return resp


@pytest.mark.asyncio
async def test_describe_returns_description_and_json_prompt():
    patcher, client = _patch_client(_json_prompt_response())
    with patcher:
        result = await handle_ideogram_describe(
            _make_node("ideogram-describe", {"include_bbox": True}),
            {"image": PortValueDict(type="Image", value=RED_PIXEL_URI)},
            _KEYS,
        )

    url = client.post.call_args.args[0]
    assert url.endswith("/v1/ideogram-v4/describe")
    kwargs = _post_kwargs(client)
    fields = _multipart_text_fields(kwargs)
    assert fields["include_bbox"] == "true"
    assert _multipart_file_names(kwargs) == ["image_file"]
    assert result["description"]["value"] == (
        "A neon diner sign at dusk. retro photographic, warm tungsten palette"
    )
    parsed = json.loads(result["json_prompt"]["value"])
    assert parsed["high_level_description"] == "A neon diner sign at dusk"


@pytest.mark.asyncio
async def test_magic_prompt_posts_json():
    patcher, client = _patch_client(_json_prompt_response())
    with patcher:
        result = await handle_ideogram_magic_prompt(
            _make_node("ideogram-magic-prompt", {"aspect_ratio": "16x9"}),
            {"prompt": PortValueDict(type="Text", value="diner sign")},
            _KEYS,
        )

    url = client.post.call_args.args[0]
    assert url.endswith("/v1/ideogram-v4/magic-prompt")
    body = _post_kwargs(client)["json"]
    assert body == {"text_prompt": "diner sign", "aspect_ratio": "16x9"}
    assert "neon diner" in result["description"]["value"]


@pytest.mark.asyncio
async def test_transparent_body_shape(tmp_path):
    with patch("handlers.ideogram.get_run_dir", return_value=tmp_path):
        patcher, client = _patch_client(_ideogram_response())
        with patcher:
            await handle_ideogram_transparent(
                _make_node("ideogram-transparent", {"upscale_factor": "X2", "aspect_ratio": "1x1"}),
                {"prompt": PortValueDict(type="Text", value="a sticker of a fox")},
                _KEYS,
            )

    url = client.post.call_args.args[0]
    assert url.endswith("/v1/ideogram-v3/generate-transparent")
    kwargs = _post_kwargs(client)
    fields = _multipart_text_fields(kwargs)
    assert fields["prompt"] == "a sticker of a fox"
    assert fields["upscale_factor"] == "X2"
    assert not _multipart_file_names(kwargs)


@pytest.mark.asyncio
async def test_remove_background_body_shape(tmp_path):
    with patch("handlers.ideogram.get_run_dir", return_value=tmp_path):
        patcher, client = _patch_client(_ideogram_response())
        with patcher:
            await handle_ideogram_remove_background(
                _make_node("ideogram-remove-background"),
                {"image": PortValueDict(type="Image", value=RED_PIXEL_URI)},
                _KEYS,
            )

    url = client.post.call_args.args[0]
    assert url.endswith("/v1/remove-background")
    assert _multipart_file_names(_post_kwargs(client)) == ["image"]


@pytest.mark.asyncio
async def test_layerize_downloads_base_plate(tmp_path):
    resp = MagicMock()
    resp.status_code = 200
    resp.json.return_value = {
        "base_image_url": "https://ideogram.ai/api/images/ephemeral/base.png",
        "original_image_url": None,
        "seed": 11,
    }
    with patch("handlers.ideogram.get_run_dir", return_value=tmp_path):
        patcher, client = _patch_client(resp)
        with patcher:
            result = await handle_ideogram_layerize(
                _make_node("ideogram-layerize"),
                {"image": PortValueDict(type="Image", value=RED_PIXEL_URI)},
                _KEYS,
            )

    url = client.post.call_args.args[0]
    assert url.endswith("/v1/ideogram-v3/layerize-text")
    assert result["image"]["type"] == "Image"
    # the base plate URL is what gets downloaded
    assert client.get.call_args.args[0].endswith("base.png")


@pytest.mark.asyncio
async def test_edit_prompt_accepts_single_or_multi_images(tmp_path):
    with patch("handlers.ideogram.get_run_dir", return_value=tmp_path):
        patcher, client = _patch_client(_ideogram_response())
        with patcher:
            await handle_ideogram_edit_prompt(
                _make_node("ideogram-edit-prompt", {"transparent_background": True}),
                {
                    "prompt": PortValueDict(type="Text", value="remove the lamp post"),
                    "image": PortValueDict(type="Image", value=RED_PIXEL_URI),
                    "images": PortValueDict(type="Image", value=[RED_PIXEL_URI]),
                },
                _KEYS,
            )

    url = client.post.call_args.args[0]
    assert url.endswith("/v1/edit")
    kwargs = _post_kwargs(client)
    fields = _multipart_text_fields(kwargs)
    assert fields["prompt"] == "remove the lamp post"
    assert fields["transparent_background"] == "true"
    # single `image` port leads, then the multi `images` port
    assert _multipart_file_names(kwargs) == ["images", "images"]


@pytest.mark.asyncio
async def test_edit_prompt_requires_an_image():
    with pytest.raises(ValueError, match="[Ii]mage"):
        await handle_ideogram_edit_prompt(
            _make_node("ideogram-edit-prompt"),
            {"prompt": PortValueDict(type="Text", value="x")},
            _KEYS,
        )


@pytest.mark.asyncio
async def test_train_model_full_flow(tmp_path):
    """dataset create -> asset upload -> train -> poll to COMPLETED -> outputs."""
    create_resp = MagicMock(status_code=200)
    create_resp.json.return_value = {"dataset_id": "ds-1", "name": "my-style"}
    upload_resp = MagicMock(status_code=200)
    upload_resp.json.return_value = {"total_count": 2, "success_count": 2, "failure_count": 0}
    train_resp = MagicMock(status_code=200)
    train_resp.json.return_value = {"model_id": "mdl-1", "dataset_id": "ds-1", "training_status": "TRAINING"}
    poll_training = MagicMock(status_code=200)
    poll_training.json.return_value = {"model": {"model_id": "mdl-1", "status": "TRAINING"}}
    poll_done = MagicMock(status_code=200)
    poll_done.json.return_value = {
        "model": {
            "model_id": "mdl-1", "status": "COMPLETED",
            "is_available_for_generation": True,
            "custom_model_uri": "ideogram://models/mdl-1",
        }
    }

    mock_client = AsyncMock()
    mock_client.post = AsyncMock(side_effect=[create_resp, upload_resp, train_resp])
    mock_client.get = AsyncMock(side_effect=[poll_training, poll_done])
    mock_client.__aenter__ = AsyncMock(return_value=mock_client)
    mock_client.__aexit__ = AsyncMock(return_value=False)

    with patch("handlers.ideogram.httpx.AsyncClient", return_value=mock_client):
        with patch("asyncio.sleep", new_callable=AsyncMock):
            result = await handle_ideogram_train_model(
                _make_node("ideogram-train-model", {"model_name": "my-style"}),
                {"images": PortValueDict(type="Image", value=[RED_PIXEL_URI, RED_PIXEL_URI])},
                _KEYS,
            )

    assert result["model_id"]["value"] == "mdl-1"
    assert result["custom_model_uri"]["value"] == "ideogram://models/mdl-1"
    # call order: create dataset, upload assets, start training
    urls = [c.args[0] for c in mock_client.post.call_args_list]
    assert urls[0].endswith("/datasets")
    assert urls[1].endswith("/datasets/ds-1/upload_assets")
    assert urls[2].endswith("/v1/ideogram-v3/train-model")


@pytest.mark.asyncio
async def test_train_model_errored_status_raises():
    create_resp = MagicMock(status_code=200)
    create_resp.json.return_value = {"dataset_id": "ds-1"}
    upload_resp = MagicMock(status_code=200)
    upload_resp.json.return_value = {"success_count": 1}
    train_resp = MagicMock(status_code=200)
    train_resp.json.return_value = {"model_id": "mdl-1"}
    poll_err = MagicMock(status_code=200)
    poll_err.json.return_value = {"model": {"status": "ERRORED"}}

    mock_client = AsyncMock()
    mock_client.post = AsyncMock(side_effect=[create_resp, upload_resp, train_resp])
    mock_client.get = AsyncMock(return_value=poll_err)
    mock_client.__aenter__ = AsyncMock(return_value=mock_client)
    mock_client.__aexit__ = AsyncMock(return_value=False)

    with patch("handlers.ideogram.httpx.AsyncClient", return_value=mock_client):
        with patch("asyncio.sleep", new_callable=AsyncMock):
            with pytest.raises(RuntimeError, match="ERRORED"):
                await handle_ideogram_train_model(
                    _make_node("ideogram-train-model", {"model_name": "x"}),
                    {"images": PortValueDict(type="Image", value=[RED_PIXEL_URI])},
                    _KEYS,
                )


@pytest.mark.asyncio
async def test_character_forwards_custom_model_uri(tmp_path):
    """A trained model URI flows into the v3 generate call (fine-tuned character gen)."""
    with patch("handlers.ideogram.get_run_dir", return_value=tmp_path):
        patcher, client = _patch_client(_ideogram_response())
        with patcher:
            await handle_ideogram_character(
                _make_node("ideogram-character", {"custom_model_uri": "ideogram://models/mdl-1"}),
                {
                    "prompt": PortValueDict(type="Text", value="x"),
                    "reference_images": PortValueDict(type="Image", value=[RED_PIXEL_URI]),
                },
                _KEYS,
            )
        assert _multipart_text_fields(_post_kwargs(client))["custom_model_uri"] == "ideogram://models/mdl-1"
