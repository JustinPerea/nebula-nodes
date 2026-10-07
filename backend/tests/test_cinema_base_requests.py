"""Exercise Cinema's registered base adapters through the real HTTP payload builders.

No provider job is created: only the transport is mocked. These assertions cover
the outgoing endpoint/body, not image adherence to camera or reference guidance.
"""

from __future__ import annotations

from unittest.mock import AsyncMock, MagicMock, patch

import pytest
from PIL import Image

from execution.sync_runner import get_handler_registry
from handlers.cinema_scene import _build_base_node
from models.graph import GraphNode, PortValueDict


REFS = ["https://example.com/front.png", "https://example.com/side.png"]


async def _submit(node: GraphNode, inputs: dict[str, PortValueDict]):
    response = MagicMock()
    response.status_code = 200
    response.json.return_value = {"images": [{"url": "https://example.com/result.png"}]}
    client = AsyncMock()
    client.post.return_value = response
    client.__aenter__.return_value = client
    client.__aexit__.return_value = False
    with patch("handlers.fal_universal.httpx.AsyncClient", return_value=client):
        result = await get_handler_registry(emit=AsyncMock())[node.definition_id](
            node, inputs, {"FAL_KEY": "fixture-key"}
        )
    assert result["image"]["value"] == "https://example.com/result.png"
    return client.post.call_args.args[0], client.post.call_args.kwargs["json"]


@pytest.mark.asyncio
@pytest.mark.parametrize("model,route", [("4.5", "v4.5"), ("5.0-lite", "v5/lite")])
async def test_seedream_refs_select_edit_route_without_mutating_recipe(model, route):
    node = GraphNode(
        id="seedream", definitionId="seedream-4-5",
        params={"model": model, "image_size": "landscape_16_9", "num_images": 1},
    )
    inputs = {
        "prompt": PortValueDict(type="Text", value="A portrait by the window"),
        "images": PortValueDict(type="Image", value=REFS),
        "image": PortValueDict(type="Image", value=REFS[0]),
    }
    url, body = await _submit(node, inputs)
    assert url == f"https://queue.fal.run/fal-ai/bytedance/seedream/{route}/edit"
    assert body == {
        "prompt": "A portrait by the window", "image_urls": REFS,
        "image_size": "landscape_16_9", "num_images": 1,
    }
    assert node.params == {"model": model, "image_size": "landscape_16_9", "num_images": 1}
    assert inputs["image"].value == REFS[0]


@pytest.mark.asyncio
@pytest.mark.parametrize("model,route", [("4.5", "v4.5"), ("5.0-lite", "v5/lite")])
async def test_seedream_without_refs_keeps_original_text_route(model, route):
    node = GraphNode(
        id="seedream", definitionId="seedream-4-5",
        params={"model": model, "image_size": "square_hd", "num_images": 1},
    )
    url, body = await _submit(
        node, {"prompt": PortValueDict(type="Text", value="An empty landscape")}
    )
    assert url == f"https://queue.fal.run/fal-ai/bytedance/seedream/{route}/text-to-image"
    assert body == {"prompt": "An empty landscape", "image_size": "square_hd", "num_images": 1}


@pytest.mark.asyncio
@pytest.mark.parametrize("with_refs", [False, True])
async def test_seedream_5_lite_omits_unsupported_seed_without_rewriting_recipe(with_refs):
    node = GraphNode(
        id="seedream", definitionId="seedream-4-5", params={"model": "5.0-lite", "seed": 37},
    )
    inputs = {"prompt": PortValueDict(type="Text", value="A portrait")}
    if with_refs:
        inputs["images"] = PortValueDict(type="Image", value=REFS)
    _, body = await _submit(node, inputs)
    assert "seed" not in body
    assert node.params == {"model": "5.0-lite", "seed": 37}


@pytest.mark.asyncio
async def test_seedream_legacy_singular_image_uses_declared_plural_edit_field():
    node = GraphNode(id="seedream", definitionId="seedream-4-5", params={})
    url, body = await _submit(node, {
        "prompt": PortValueDict(type="Text", value="Edit this picture"),
        "image": PortValueDict(type="Image", value=REFS[0]),
    })
    assert url.endswith("/v4.5/edit")
    assert body == {"prompt": "Edit this picture", "image_urls": [REFS[0]]}


@pytest.mark.asyncio
async def test_seedream_rejects_excess_refs_before_transport():
    node = GraphNode(id="seedream", definitionId="seedream-4-5", params={})
    with patch("handlers.fal_universal.httpx.AsyncClient") as transport:
        with pytest.raises(ValueError, match="at most 10.*received 11"):
            await get_handler_registry(emit=AsyncMock())["seedream-4-5"](node, {
                "prompt": PortValueDict(type="Text", value="A group portrait"),
                "images": PortValueDict(type="Image", value=[f"https://example.com/{n}.png" for n in range(11)]),
            }, {"FAL_KEY": "fixture-key"})
        transport.assert_not_called()


@pytest.mark.asyncio
@pytest.mark.parametrize("model", [None, "4.5"])
@pytest.mark.parametrize("with_refs", [False, True])
async def test_seedream_4_5_rejects_retained_auto_3k_before_transport(model, with_refs):
    params = {"image_size": "auto_3K"}
    if model is not None:
        params["model"] = model
    node = GraphNode(id="seedream", definitionId="seedream-4-5", params=params)
    inputs = {"prompt": PortValueDict(type="Text", value="A portrait")}
    if with_refs:
        inputs["images"] = PortValueDict(type="Image", value=REFS)
    with patch("handlers.fal_universal.httpx.AsyncClient") as transport:
        with pytest.raises(ValueError, match="does not support image_size auto_3K"):
            await get_handler_registry(emit=AsyncMock())["seedream-4-5"](node, inputs, {"FAL_KEY": "fixture-key"})
        transport.assert_not_called()
    assert node.params == params


@pytest.mark.asyncio
@pytest.mark.parametrize("with_refs", [False, True])
async def test_seedream_5_lite_preserves_supported_auto_3k_request(with_refs):
    node = GraphNode(
        id="seedream", definitionId="seedream-4-5",
        params={"model": "5.0-lite", "image_size": "auto_3K"},
    )
    inputs = {"prompt": PortValueDict(type="Text", value="A portrait")}
    if with_refs:
        inputs["images"] = PortValueDict(type="Image", value=REFS)
    url, body = await _submit(node, inputs)
    assert "/v5/lite/" in url
    assert body["image_size"] == "auto_3K"


@pytest.mark.asyncio
@pytest.mark.parametrize("model,route", [("4.5", "v4.5"), ("5.0-lite", "v5/lite")])
async def test_cinema_seedream_payload_uses_refs_and_schema_image_size(model, route):
    node, inputs = _build_base_node(
        "seedream-4-5", "A cinematic portrait", REFS, "16:9", {"model": model, "seed": 7}, "scene",
    )
    url, body = await _submit(node, inputs)
    assert url.endswith(f"/{route}/edit")
    expected = {
        "prompt": "A cinematic portrait", "image_urls": REFS,
        "image_size": "landscape_16_9",
    }
    if model == "4.5":
        expected["seed"] = 7
    assert body == expected


@pytest.mark.asyncio
async def test_cinema_character_seed_is_not_injected_into_seedream_5_lite_request():
    """Exercise Character expansion, Cinema dispatch and the actual FAL body together."""
    node = GraphNode(id="scene", definitionId="cinema-scene", params={"scene": {
        "version": 1,
        "base": {"model": "seedream-4-5", "params": {"model": "5.0-lite", "seed": 37}},
        "aspectRatio": "16:9", "shots": [{"id": "one", "prompt": "By the window"}],
    }})
    bundle = {
        "characterId": "fixture-character", "name": "Ada", "referenceViews": REFS,
        "frozenTraitString": "Ada, copper hair", "seed": 42, "consistencyStrength": 0.8,
    }
    response = MagicMock()
    response.status_code = 200
    response.json.return_value = {"images": [{"url": "https://example.com/result.png"}]}
    client = AsyncMock()
    client.post.return_value = response
    client.__aenter__.return_value = client
    client.__aexit__.return_value = False
    with patch("handlers.fal_universal.httpx.AsyncClient", return_value=client), patch(
        "handlers.cinema_scene._load_image", new=AsyncMock(return_value=Image.new("RGB", (24, 24)))
    ):
        result = await get_handler_registry(emit=AsyncMock())["cinema-scene"](
            node, {"character": PortValueDict(type="Character", value=bundle)}, {"FAL_KEY": "fixture-key"},
        )
    assert result["shot_one"]["type"] == "Image"
    assert node.params["scene"]["shots"][0]["output"]["status"] == "done"
    body = client.post.call_args.kwargs["json"]
    assert client.post.call_args.args[0].endswith("/v5/lite/edit")
    assert body["image_urls"] == REFS
    assert body["prompt"] == "Ada, copper hair. By the window"
    assert "seed" not in body
    assert node.params["scene"]["base"]["params"]["seed"] == 37
    assert bundle["seed"] == 42


@pytest.mark.asyncio
@pytest.mark.parametrize("model,endpoint", [
    ("nano-banana-2", "fal-ai/nano-banana-2/edit"),
    ("nano-banana-pro", "fal-ai/nano-banana-pro/edit"),
    ("nano-banana", "fal-ai/nano-banana/edit"),
    ("gemini-25-flash-image", "fal-ai/gemini-25-flash-image/edit"),
    ("gemini-3-pro-image", "fal-ai/gemini-3-pro-image-preview/edit"),
])
async def test_cinema_nano_banana_fal_edit_payload_is_plural_only(model, endpoint):
    node, inputs = _build_base_node(
        "nano-banana-fal-edit", "A cinematic portrait", REFS, "16:9", {"model": model, "seed": 7}, "scene",
    )
    url, body = await _submit(node, inputs)
    assert url == f"https://queue.fal.run/{endpoint}"
    assert body == {
        "prompt": "A cinematic portrait", "image_urls": REFS,
        "aspect_ratio": "16:9", "seed": 7,
    }


@pytest.mark.asyncio
@pytest.mark.parametrize("model,suffix", [("base", "kontext"), ("max", "kontext/max")])
async def test_cinema_flux_payload_uses_only_declared_singular_reference(model, suffix):
    node, inputs = _build_base_node(
        "flux-kontext", "A cinematic portrait", [REFS[0]], "16:9", {"model": model, "seed": 7}, "scene",
    )
    url, body = await _submit(node, inputs)
    assert url == f"https://queue.fal.run/fal-ai/flux-pro/{suffix}"
    assert body == {
        "prompt": "A cinematic portrait", "image_url": REFS[0],
        "aspect_ratio": "16:9", "seed": 7,
    }


@pytest.mark.asyncio
@pytest.mark.parametrize("model", [
    "gemini-3.1-flash-image", "gemini-3.1-flash-lite-image", "gemini-3-pro-image", "gemini-2.5-flash-image",
])
async def test_cinema_direct_nano_banana_request_contains_all_references(model):
    node, inputs = _build_base_node(
        "nano-banana", "A cinematic portrait", REFS, "16:9", {"model": model}, "scene",
    )
    response = MagicMock()
    response.status_code = 200
    response.json.return_value = {"candidates": [{"content": {"parts": [{
        "inlineData": {"mimeType": "image/png", "data": "aGVsbG8="}
    }]}}]}
    client = AsyncMock()
    client.post.return_value = response
    client.__aenter__.return_value = client
    client.__aexit__.return_value = False
    with patch("handlers.google_gemini.httpx.AsyncClient", return_value=client), patch(
        "handlers.google_gemini.save_base64_image", return_value="/tmp/fixture.png"
    ):
        await get_handler_registry()["nano-banana"](node, inputs, {"GOOGLE_API_KEY": "fixture-key"})
    assert client.post.call_args.args[0] == f"https://generativelanguage.googleapis.com/v1beta/models/{model}:generateContent"
    body = client.post.call_args.kwargs["json"]
    assert body["contents"] == [{"parts": [
        {"text": "A cinematic portrait"},
        *[{"fileData": {"fileUri": ref}} for ref in REFS],
    ]}]
    assert body["generationConfig"]["imageConfig"] == {"aspectRatio": "16:9"}
    assert "input_fidelity" not in body
