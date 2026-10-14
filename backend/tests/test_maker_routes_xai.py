"""Grok Imagine's fal and Krea copies on xAI's own API (execution/maker_routes_xai.py).

Only the transport is mocked: no provider is contacted and nothing is billed.
Covers route choice (xAI key wins, the Krea plan wins over it, Krea-only
settings keep a run on Krea whether saved or wired), the fal/Krea -> xAI
translation and request shapes, and the xAI route's price.
"""
from __future__ import annotations

import copy
import json
from pathlib import Path
from unittest.mock import AsyncMock, MagicMock, patch

import pytest

from execution.missing_credential import MissingCredentialError
from execution.sync_runner import get_handler_registry
from models.graph import GraphNode, PortValueDict
from services import model_pricing, node_route
from services.node_registry import NodeRegistry
from services.output import get_run_dir

DEFINITIONS = NodeRegistry().get_all()
PRICING = model_pricing.load_pricing()
RED_PIXEL_B64 = (
    "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR4"
    "2mP8/5+hHgAHggJ/PchI7wAAAABJRU5ErkJggg=="
)
XAI = {"XAI_API_KEY": "fixture-xai"}
FAL = {"FAL_KEY": "fixture-fal"}
KREA = {"KREA_API_TOKEN": "fixture-krea"}
PROMPT = {"prompt": PortValueDict(type="Text", value="a lighthouse at dusk")}


def _image_client(count=1):
    response = MagicMock()
    response.status_code = 200
    response.json.return_value = {"data": [{"b64_json": RED_PIXEL_B64, "mime_type": "image/png"}] * count}
    client = AsyncMock()
    client.post.return_value = response
    client.__aenter__.return_value = client
    client.__aexit__.return_value = False
    return client


def _video_client():
    submit = MagicMock(status_code=200)
    submit.json.return_value = {"request_id": "req-1"}
    poll = MagicMock(status_code=200)
    poll.json.return_value = {"status": "done", "video": {"url": "https://vidgen.x.ai/v.mp4", "duration": 6}}
    download = MagicMock()
    download.content = b"\x00\x00\x00\x18ftypmp42"
    client = AsyncMock()
    client.post.return_value = submit
    client.get.side_effect = [poll, download]
    client.__aenter__.return_value = client
    client.__aexit__.return_value = False
    return client


async def _run(node, inputs, keys, emit=None):
    return await get_handler_registry(emit=emit or AsyncMock())[node.definition_id](node, inputs, keys)


async def _run_video(node, inputs, keys, emit=None):
    client = _video_client()
    with patch("handlers.grok_video.httpx.AsyncClient", return_value=client), \
            patch("handlers.grok_video.asyncio.sleep", new_callable=AsyncMock):
        result = await _run(node, inputs, keys, emit)
    return result, client


def _krea_gateway_spy():
    seen: dict = {}

    async def gateway(node, inputs, api_keys, emit=None):
        seen["params"] = dict(node.params)
        seen["inputs"] = set(inputs)
        return {"image": {"type": "Image", "value": "https://example.com/k.png"}}

    return gateway, seen


# -- fal copies -----------------------------------------------------------------

@pytest.mark.asyncio
async def test_fal_grok_image_runs_on_xai_with_the_maker_key_and_translates():
    node = GraphNode(id="g", definitionId="grok-imagine-image",
                     params={"num_images": 2, "aspect_ratio": "16:9", "resolution": "2k", "output_format": "jpeg"})
    before = copy.deepcopy(node.params)
    client = _image_client(2)
    with patch("handlers.xai_image.httpx.AsyncClient", return_value=client), \
            patch("handlers.fal_universal.handle_fal_universal") as fal:
        result = await _run(node, PROMPT, {**XAI, **FAL})
    fal.assert_not_called()
    assert node.params == before
    assert set(result) == {"image"} and Path(result["image"]["value"]).is_file()
    assert client.post.call_args.args[0] == "https://api.x.ai/v1/images/generations"
    assert client.post.call_args.kwargs["headers"]["Authorization"] == "Bearer fixture-xai"
    # output_format is fal-only (falParams): xAI has no such field.
    assert client.post.call_args.kwargs["json"] == {
        "model": "grok-imagine-image", "prompt": "a lighthouse at dusk", "response_format": "b64_json",
        "n": 2, "aspect_ratio": "16:9", "resolution": "2k"}


@pytest.mark.asyncio
@pytest.mark.parametrize("output_format", ["png", "webp"])
async def test_a_fal_grok_recipe_that_asks_for_png_or_webp_stays_on_fal(output_format):
    """xAI has no output-format field and returns JPEG, so a recipe that asks
    fal for another format runs on fal (directRoute.accepts) instead of
    silently coming back as JPEG from xAI."""
    node = GraphNode(id="g", definitionId="grok-imagine-image",
                     params={"num_images": 1, "output_format": output_format})
    client = _image_client(1)
    with patch("handlers.xai_image.httpx.AsyncClient", return_value=client), \
            patch("handlers.fal_universal.handle_fal_universal",
                  return_value={"image": {"type": "Image", "value": "fal.png"}}) as fal:
        await _run(node, PROMPT, {**XAI, **FAL})
    client.post.assert_not_called()
    fal.assert_called_once()
    assert fal.call_args.args[0].params["output_format"] == output_format
    with pytest.raises(MissingCredentialError, match=f"FAL_KEY is required: .*output_format {output_format}"):
        await _run(node, PROMPT, XAI)


@pytest.mark.asyncio
async def test_fal_grok_edit_sends_local_sources_as_data_urls_and_caps_at_five(tmp_path):
    source = get_run_dir() / "grok-src.png"
    import base64
    source.write_bytes(base64.b64decode(RED_PIXEL_B64))
    node = GraphNode(id="g", definitionId="grok-imagine-image-edit", params={"num_images": 1, "resolution": "1k"})
    client = _image_client()
    images = {"images": PortValueDict(type="Image", value=[str(source), "https://example.com/b.png"])}
    with patch("handlers.xai_image.httpx.AsyncClient", return_value=client):
        await _run(node, {**PROMPT, **images}, XAI)
    body = client.post.call_args.kwargs["json"]
    assert client.post.call_args.args[0] == "https://api.x.ai/v1/images/edits"
    assert body["model"] == "grok-imagine-image" and "n" not in body
    assert body["images"][0]["url"].startswith("data:image/png;base64,")
    assert body["images"][1] == {"url": "https://example.com/b.png"}
    six = {"images": PortValueDict(type="Image", value=["https://example.com/x.png"] * 6)}
    with patch("handlers.xai_image.httpx.AsyncClient", return_value=_image_client()), \
            pytest.raises(ValueError, match="up to 5"):
        await _run(node, {**PROMPT, **six}, XAI)


@pytest.mark.asyncio
async def test_fal_grok_edit_single_source_uses_image():
    node = GraphNode(id="g", definitionId="grok-imagine-image-edit", params={})
    client = _image_client()
    with patch("handlers.xai_image.httpx.AsyncClient", return_value=client):
        await _run(node, {**PROMPT, "images": PortValueDict(type="Image", value="https://example.com/a.png")}, XAI)
    body = client.post.call_args.kwargs["json"]
    assert body["image"] == {"url": "https://example.com/a.png"} and "images" not in body


@pytest.mark.asyncio
async def test_fal_grok_image_without_the_xai_key_stays_on_fal_and_with_none_names_both():
    node = GraphNode(id="g", definitionId="grok-imagine-image", params={"output_format": "png"})
    fal = AsyncMock(return_value={"image": {"type": "Image", "value": "https://fal.ai/x.png"}})
    with patch("handlers.fal_universal.handle_fal_universal", fal), \
            patch("handlers.xai_image.httpx.AsyncClient") as xai:
        await _run(node, PROMPT, FAL)
    xai.assert_not_called()
    assert fal.call_args.args[0].params["endpoint_id"] == "xai/grok-imagine-image"
    with pytest.raises(MissingCredentialError, match="XAI_API_KEY or FAL_KEY"):
        await _run(node, PROMPT, {})


# -- Krea image copies -----------------------------------------------------------

@pytest.mark.asyncio
async def test_krea_grok_2_runs_on_xai_with_quality_and_lowercase_resolution():
    node = GraphNode(id="k", definitionId="krea-image-xai-grok-imagine-2", params={
        "_kreaAuth": "api-token", "prompt": "saved prompt", "quality": "low", "aspect_ratio": "19.5:9",
        "resolution": "2K", "style_images": ""})
    gateway, seen = _krea_gateway_spy()
    client = _image_client()
    with patch("handlers.xai_image.httpx.AsyncClient", return_value=client), \
            patch("handlers.krea_gateway.handle_krea_gateway", gateway):
        result = await _run(node, {}, {**XAI, **KREA})
    assert not seen
    assert set(result) == {"image", "images", "artifacts"}
    assert result["images"]["value"][0].startswith("/api/outputs/")
    assert client.post.call_args.kwargs["json"] == {
        "model": "grok-imagine-image-2.0", "prompt": "saved prompt", "response_format": "b64_json",
        "aspect_ratio": "19.5:9", "resolution": "2k", "quality": "low"}


@pytest.mark.asyncio
@pytest.mark.parametrize("how", ["saved", "wired"])
async def test_krea_style_images_keep_the_run_on_krea(how):
    """xAI has no style references: a run that sets or wires them stays on
    Krea, and the run estimate follows it."""
    params = {"_kreaAuth": "api-token", "prompt": "p", "aspect_ratio": "1:1", "resolution": "1K"}
    inputs = dict(PROMPT)
    if how == "saved":
        params["style_images"] = '[{"url": "https://example.com/s.png", "strength": 1}]'
    else:
        inputs["style_images"] = PortValueDict(type="Any", value=[{"url": "https://example.com/s.png", "strength": 1}])
    node = GraphNode(id="k", definitionId="krea-image-xai-grok-imagine-2", params=params)
    gateway, seen = _krea_gateway_spy()
    with patch("handlers.krea_gateway.handle_krea_gateway", gateway), \
            patch("handlers.xai_image.httpx.AsyncClient") as xai:
        await _run(node, inputs, {**XAI, **KREA})
    xai.assert_not_called()
    assert seen["params"]["resolution"] == "1K"
    item = {"id": "k", "definitionId": node.definition_id, "params": params}
    wired = {"k": {"style_images"}} if how == "wired" else None
    estimate = model_pricing.estimate_run([item], PRICING, DEFINITIONS, {**XAI, **KREA}, None, wired)
    # Krea doesn't price this model per reference count, so the Krea run is unpriced, not xAI-priced.
    assert estimate["unpriced"] == ["k"]


@pytest.mark.asyncio
async def test_krea_plan_wins_over_the_xai_key():
    node = GraphNode(id="k", definitionId="krea-image-xai-grok-imagine-2", params={
        "_kreaAuth": "mcp", "prompt": "p", "aspect_ratio": "1:1", "resolution": "1K"})
    gateway, seen = _krea_gateway_spy()
    with patch("handlers.krea_gateway.handle_krea_gateway", gateway), \
            patch("handlers.xai_image.httpx.AsyncClient") as xai:
        await _run(node, PROMPT, {**XAI, **KREA})
    xai.assert_not_called()
    assert seen["params"]["_kreaAuth"] == "mcp"


@pytest.mark.asyncio
async def test_krea_grok_2_edit_reads_image_urls_from_the_json_param_and_keeps_the_node_limit():
    node = GraphNode(id="k", definitionId="krea-image-xai-grok-imagine-2-edit", params={
        "_kreaAuth": "api-token", "prompt": "make it night", "quality": "medium", "resolution": "1K",
        "image_urls": '["https://example.com/a.png", "https://example.com/b.png"]'})
    client = _image_client()
    with patch("handlers.xai_image.httpx.AsyncClient", return_value=client):
        await _run(node, {}, XAI)
    assert client.post.call_args.args[0] == "https://api.x.ai/v1/images/edits"
    body = client.post.call_args.kwargs["json"]
    assert body["images"] == [{"url": "https://example.com/a.png"}, {"url": "https://example.com/b.png"}]
    assert body["quality"] == "medium" and body["resolution"] == "1k" and body["prompt"] == "make it night"
    node.params["image_urls"] = json.dumps([f"https://example.com/{n}.png" for n in range(4)])
    with pytest.raises(ValueError, match="up to 3"):
        await _run(node, {}, XAI)


# -- Krea video copies -----------------------------------------------------------

@pytest.mark.asyncio
async def test_krea_grok_video_generates_with_the_krea_defaults_and_object_images():
    """Unset duration/resolution take the Krea node's defaults (6 s, 720p),
    not xAI's (8 s, 480p), so the run matches its price."""
    emit = AsyncMock()
    node = GraphNode(id="v", definitionId="krea-video-xai-grok-video", params={
        "_kreaAuth": "api-token", "prompt": "waves", "aspect_ratio": "9:16"})
    inputs = {**PROMPT, "start_image": PortValueDict(type="Image", value="https://example.com/f.png")}
    result, client = await _run_video(node, inputs, {**XAI, **KREA}, emit)
    assert client.post.call_args.args[0] == "https://api.x.ai/v1/videos/generations"
    assert client.post.call_args.kwargs["json"] == {
        "model": "grok-imagine-video", "duration": 6, "resolution": "720p", "aspect_ratio": "9:16",
        "prompt": "a lighthouse at dusk", "image": {"url": "https://example.com/f.png"}}
    assert set(result) == {"video", "videos", "artifacts"}
    assert result["videos"]["value"][0].startswith("/api/outputs/")
    emit.assert_awaited()  # polling progress reaches the run


@pytest.mark.asyncio
async def test_krea_grok_video_references_and_edits():
    refs = {"reference_images": PortValueDict(type="Image", value=["https://example.com/r1.png"] * 2)}
    node = GraphNode(id="v", definitionId="krea-video-xai-grok-video", params={"prompt": "p", "duration": 8})
    _, client = await _run_video(node, {**PROMPT, **refs}, XAI)
    body = client.post.call_args.kwargs["json"]
    assert body["reference_images"] == [{"url": "https://example.com/r1.png"}] * 2 and "image" not in body

    node = GraphNode(id="v", definitionId="krea-video-xai-grok-video",
                     params={"prompt": "add snow", "edit_video": "https://example.com/in.mp4", "duration": 6})
    _, client = await _run_video(node, {}, XAI)
    assert client.post.call_args.args[0] == "https://api.x.ai/v1/videos/edits"
    assert client.post.call_args.kwargs["json"] == {
        "model": "grok-imagine-video", "prompt": "add snow", "video": {"url": "https://example.com/in.mp4"}}



@pytest.mark.asyncio
async def test_krea_grok_video_refuses_what_xai_cannot_run():
    """References run up to 10 seconds on xAI; a longer run fails before any request."""
    node = GraphNode(id="v", definitionId="krea-video-xai-grok-video",
                     params={"prompt": "p", "duration": 12, "reference_images": '["https://e.com/r.png"]'})
    with patch("handlers.grok_video.httpx.AsyncClient") as xai, pytest.raises(ValueError, match="up to 10 seconds"):
        await _run(node, {}, XAI)
    xai.assert_not_called()


IMAGE = "https://e.com/i.png"
REFS = '["https://e.com/r.png"]'
EDIT = "https://e.com/v.mp4"


@pytest.mark.asyncio
@pytest.mark.parametrize("params,wired,detail", [
    ({"duration": 6.5}, {}, "duration 6.5"),
    ({"edit_video": EDIT, "start_image": IMAGE}, {}, "an edit video with a start image"),
    ({"edit_video": EDIT}, {"reference_images": PortValueDict(type="Image", value=["https://e.com/r.png"])},
     "an edit video with reference images"),
    ({"start_image": IMAGE, "reference_images": REFS}, {}, "a start image with reference images"),
    ({}, {"start_image": PortValueDict(type="Image", value=IMAGE),
          "reference_images": PortValueDict(type="Image", value=["https://e.com/r.png"])},
     "a start image with reference images"),
])
async def test_what_xai_cannot_run_stays_on_krea_saved_or_wired(params, wired, detail):
    """directRoute.accepts (whole seconds, 1-15) and rejectsWhen (what xAI
    doesn't document on one request): the run goes to Krea, or, with only the
    xAI key saved, says why it can't use it."""
    gateway, seen = _krea_gateway_spy()
    node = GraphNode(id="v", definitionId="krea-video-xai-grok-video", params={"prompt": "p", **params})
    with patch("handlers.krea_gateway.handle_krea_gateway", gateway), \
            patch("handlers.grok_video.httpx.AsyncClient") as xai:
        await _run(node, {**PROMPT, **wired}, {**XAI, **KREA})
        with pytest.raises(MissingCredentialError, match=f"KREA_API_TOKEN is required: .*doesn't take {detail}$"):
            await _run(node, {**PROMPT, **wired}, XAI)
    xai.assert_not_called()
    assert seen


@pytest.mark.parametrize("params,inputs,match", [
    ({"prompt": "p", "duration": 6.5}, {}, "whole number"),
    ({"prompt": "p", "edit_video": EDIT, "start_image": IMAGE}, {}, "on its own"),
    ({"prompt": "p", "start_image": IMAGE}, {"reference_images": PortValueDict(type="Image", value=[IMAGE])},
     "not both"),
])
def test_the_translator_still_refuses_what_xai_cannot_run(params, inputs, match):
    """The router keeps these on Krea; the translator refuses them too
    rather than silently dropping one input if it is ever called directly."""
    from execution.maker_routes_xai import GROK_VIDEO, krea_grok_video_to_xai
    node = GraphNode(id="v", definitionId="krea-video-xai-grok-video", params=params)
    with pytest.raises(ValueError, match=match):
        krea_grok_video_to_xai(GROK_VIDEO)(node, inputs)


@pytest.mark.asyncio
@pytest.mark.parametrize("node_id", ["krea-video-xai-grok-video", "krea-video-xai-grok-video-1-5"])
async def test_a_krea_start_video_saved_or_wired_stays_on_krea(node_id):
    """Krea doesn't say what start_video does, so it is never guessed onto
    xAI's extension endpoint."""
    gateway, seen = _krea_gateway_spy()
    video = "https://e.com/v.mp4"
    for params, inputs in (({"prompt": "p", "start_video": video}, PROMPT),
                           ({"prompt": "p"}, {**PROMPT, "start_video": PortValueDict(type="Video", value=video)})):
        seen.clear()
        node = GraphNode(id="v", definitionId=node_id, params=params)
        with patch("handlers.krea_gateway.handle_krea_gateway", gateway), \
                patch("handlers.grok_video.httpx.AsyncClient") as xai:
            await _run(node, inputs, {**XAI, **KREA})
        xai.assert_not_called()
        assert seen


@pytest.mark.asyncio
async def test_krea_grok_video_1_5_uses_its_model():
    node = GraphNode(id="v", definitionId="krea-video-xai-grok-video-1-5",
                     params={"prompt": "p", "resolution": "1080p", "duration": 10})
    _, client = await _run_video(node, PROMPT, {**XAI, **KREA})
    body = client.post.call_args.kwargs["json"]
    assert body["model"] == "grok-imagine-video-1.5" and body["resolution"] == "1080p" and body["duration"] == 10
    assert body["aspect_ratio"] == "16:9"  # the node's default


# -- route rule and price ----------------------------------------------------------

def test_wired_blockers_mark_only_blocking_ports_that_have_no_saved_value():
    definition = DEFINITIONS["krea-video-xai-grok-video-1-5"]
    assert node_route.with_wired_blockers(definition, {"prompt": "p"}, {"start_video", "start_image"}) == {
        "prompt": "p", "start_video": node_route.WIRED}
    assert node_route.with_wired_blockers(definition, {"start_video": "x"}, {"start_video"}) == {"start_video": "x"}
    assert node_route.with_wired_blockers(DEFINITIONS["grok-imagine-image"], {}, {"prompt"}) == {}
    route = node_route.select_route(definition, node_route.with_wired_blockers(definition, {}, {"start_video"}),
                                    {**XAI, **KREA})
    assert route == node_route.Route(node_route.FALLBACK, "krea", "KREA_API_TOKEN")


@pytest.mark.parametrize("node_id,params,keys,expected", [
    ("grok-imagine-image", {"num_images": 3}, XAI, (0.06, 0.06)),
    ("grok-imagine-image", {"num_images": 3}, FAL, (0.06, 0.06)),
    ("grok-imagine-image-edit", {"num_images": 2}, XAI, (0.04, 0.06)),
    ("grok-imagine-image-edit", {"num_images": 2}, FAL, (0.044, 0.044)),
    ("krea-image-xai-grok-imagine-2", {"quality": "medium", "resolution": "2K", "aspect_ratio": "1:1"}, XAI,
     (0.08, 0.08)),
    ("krea-image-xai-grok-imagine-2-edit", {"quality": "low", "resolution": "1K"}, XAI, (0.05, 0.07)),
    ("krea-video-xai-grok-video", {"resolution": "720p", "duration": 10}, XAI, (0.7, 0.714)),
    ("krea-video-xai-grok-video", {"resolution": "480p"}, XAI, (0.3, 0.314)),
    ("krea-video-xai-grok-video-1-5", {"resolution": "1080p", "duration": 4}, XAI, (1.0, 1.01)),
])
def test_xai_route_prices(node_id, params, keys, expected):
    item = {"id": "n", "definitionId": node_id, "params": params}
    result = model_pricing.estimate_run([item], PRICING, DEFINITIONS, keys)
    assert (result["low"], result["high"]) == pytest.approx(expected)


@pytest.mark.parametrize("params,wired", [
    ({"edit_video": "https://e.com/v.mp4"}, None),
    ({}, {"n": {"edit_video"}}),
    ({"duration": 6.5}, None),
])
def test_xai_video_edits_and_fractional_durations_are_unpriced(params, wired):
    item = {"id": "n", "definitionId": "krea-video-xai-grok-video", "params": params}
    assert model_pricing.estimate_run([item], PRICING, DEFINITIONS, XAI, None, wired)["unpriced"] == ["n"]


# -- review fixes ------------------------------------------------------------------

@pytest.mark.asyncio
@pytest.mark.parametrize("images", [None, PortValueDict(type="Image", value=[]), PortValueDict(type="Image", value="")])
async def test_fal_grok_edit_without_a_source_never_bills_a_generation_on_xai(images):
    """handle_xai_image picks /images/edits only when sources arrive; an edit
    node with none must fail, not silently run (and bill) text-to-image."""
    node = GraphNode(id="g", definitionId="grok-imagine-image-edit", params={"num_images": 1})
    inputs = dict(PROMPT)
    if images is not None:
        inputs["images"] = images
    with patch("handlers.xai_image.httpx.AsyncClient") as xai, pytest.raises(ValueError, match="source image"):
        await _run(node, inputs, XAI)
    xai.assert_not_called()


def test_cache_tag_follows_a_wired_krea_only_blocker():
    """The cache key names the route the router takes: a wired start video
    runs on Krea, so its result is never filed under the xAI route."""
    from execution.engine import _cache_route_tag

    definition = DEFINITIONS["krea-video-xai-grok-video-1-5"]
    node = GraphNode(id="v", definitionId=definition["id"], params={"prompt": "p"})
    keys = {**XAI, **KREA}
    assert _cache_route_tag(node, definition, keys) == "direct:xai"
    wired = {"start_video": PortValueDict(type="Video", value="https://e.com/v.mp4")}
    assert _cache_route_tag(node, definition, keys, wired) == "fallback:krea"
    empty = {"start_video": PortValueDict(type="Video", value="")}
    assert _cache_route_tag(node, definition, keys, empty) == "direct:xai"


@pytest.mark.asyncio
async def test_a_wired_blocker_with_only_the_xai_key_names_the_krea_token():
    """xAI is saved but the start video can only run on Krea: the error says
    so instead of asking for the xAI key the person already saved."""
    node = GraphNode(id="v", definitionId="krea-video-xai-grok-video-1-5", params={"prompt": "p"})
    inputs = {**PROMPT, "start_video": PortValueDict(type="Video", value="https://e.com/v.mp4")}
    with patch("handlers.grok_video.httpx.AsyncClient") as xai, \
            pytest.raises(MissingCredentialError, match=r"^KREA_API_TOKEN is required: start_video"):
        await _run(node, inputs, XAI)
    xai.assert_not_called()
    with pytest.raises(MissingCredentialError, match=r"^XAI_API_KEY or KREA_API_TOKEN is required$"):
        await _run(node, PROMPT, {})
