"""Krea's Ideogram and Runway copies on the makers' own APIs (execution/maker_routes_ideogram_runway.py).

Only the transport is mocked: nothing reaches Ideogram, Runway or Krea, and
nothing is billed. Covers which route runs (maker key, Krea plan, Krea
token), what each maker request carries, and the prices each route shows.
"""
from __future__ import annotations

import base64
import copy
import json
from unittest.mock import AsyncMock, patch

import httpx
import pytest
import respx

from execution import maker_routes_ideogram_runway as ir
from execution.missing_credential import MissingCredentialError
from execution.sync_runner import get_handler_registry
from models.graph import GraphNode, PortValueDict
from services import model_pricing, node_route
from services.node_registry import NodeRegistry
from services.output import OUTPUT_ROOT

DEFINITIONS = NodeRegistry().get_all()
PRICING = model_pricing.load_pricing()["nodes"]
IDEOGRAM = {"IDEOGRAM_API_KEY": "fixture-ideogram"}
RUNWAY = {"RUNWAY_API_KEY": "fixture-runway"}
KREA = {"KREA_API_TOKEN": "fixture-krea"}
PNG = base64.b64decode(
    "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8/5+hHgAHggJ/PchI7wAAAABJRU5ErkJggg=="
)
ROUTED = {
    "krea-image-ideogram-ideogram-4-5-precise": "IDEOGRAM_API_KEY",
    "krea-image-ideogram-ideogram-3": "IDEOGRAM_API_KEY",
    "krea-image-ideogram-ideogram-2-turbo": "IDEOGRAM_API_KEY",
    "krea-image-runway-gen-4-image": "RUNWAY_API_KEY",
    "krea-video-runway-gen-4-5": "RUNWAY_API_KEY",
    "krea-enhance-runway-ruby": "RUNWAY_API_KEY",
}


def _output_file(name: str, data: bytes = PNG) -> str:
    path = OUTPUT_ROOT / "test-ideogram-runway" / name
    path.parent.mkdir(parents=True, exist_ok=True)
    path.write_bytes(data)
    return str(path)


async def _run(node, inputs, keys):
    return await get_handler_registry(emit=AsyncMock())[node.definition_id](node, inputs, keys)


def _gateway():
    return AsyncMock(return_value={"image": {"type": "Image", "value": "https://example.com/k.png"}})


class _Ideogram:
    """Records Ideogram posts; the saved image is a real file in the output root."""

    def __init__(self):
        self.calls = []

    async def multipart(self, path, api_key, fields, files):
        self.calls.append({"path": path, "key": api_key, "fields": fields,
                           "files": [(field, part[0]) for field, part in files]})
        return {"data": [{"url": "https://ideogram.example/ephemeral.png"}]}

    async def json(self, path, api_key, body):
        self.calls.append({"path": path, "key": api_key, "json": body})
        return {"data": [{"url": "https://ideogram.example/ephemeral.png"}]}

    async def save(self, result):
        assert result["data"][0]["url"]
        return {"image": {"type": "Image", "value": _output_file("ideogram.png")}}

    def patches(self):
        return (patch("handlers.ideogram._post_multipart", self.multipart),
                patch("handlers.ideogram._post_json", self.json),
                patch("handlers.ideogram._save_first_image", self.save))


def test_each_copy_routes_on_its_makers_key():
    registry = get_handler_registry(emit=AsyncMock())
    for node_id, key in ROUTED.items():
        definition = DEFINITIONS[node_id]
        assert getattr(registry[node_id], "dual_route", False), node_id
        assert definition["envKeyName"] == [key, "KREA_API_TOKEN"]
        assert node_route.select_route(definition, {}, {key: "k", **KREA}).kind == node_route.DIRECT
        assert node_route.select_route(definition, {"_kreaAuth": "mcp"}, {key: "k"}).kind == node_route.PLAN
        assert node_route.select_route(definition, {}, KREA).provider == "krea"
    # Not routed: Ideogram 4.5 text-to-image presets and Krea's Gen-4 upstream are unconfirmed.
    for node_id in ("krea-image-ideogram-ideogram-4-5", "krea-video-runway-gen-4-video"):
        assert "directKeyName" not in DEFINITIONS[node_id]
        assert not getattr(registry[node_id], "dual_route", False)


# -- Ideogram 4.5 Precise Edit -------------------------------------------------

@pytest.mark.asyncio
async def test_precise_edit_runs_on_ideogram_with_every_krea_field():
    ideogram = _Ideogram()
    image, mask, ref = _output_file("src.png"), _output_file("mask.png"), _output_file("ref.png")
    params = {"_kreaAuth": "api-token", "prompt": "make the shoes blue", "quality": "low", "seed": 9,
              "image_url": "", "mask_url": "", "reference_images": "[]"}
    node = GraphNode(id="n", definitionId="krea-image-ideogram-ideogram-4-5-precise", params=params)
    before = copy.deepcopy(node.params)
    inputs = {"image_url": PortValueDict(type="Image", value=image),
              "mask_url": PortValueDict(type="Mask", value=mask),
              "reference_images": PortValueDict(type="Image", value=[ref])}
    gateway = _gateway()
    a, b, c = ideogram.patches()
    with a, b, c, patch("handlers.krea_gateway.handle_krea_gateway", gateway):
        result = await _run(node, inputs, {**IDEOGRAM, **KREA})
    gateway.assert_not_called()
    assert node.params == before
    assert set(result) == {"image", "images", "artifacts"}
    [call] = ideogram.calls
    assert call["path"] == "/v2/image/precise-edit/ideogram-4-5" and call["key"] == "fixture-ideogram"
    assert call["fields"] == {"prompt": "make the shoes blue", "quality": "low", "num_images": 1, "seed": 9}
    assert [field for field, _ in call["files"]] == ["image", "mask", "reference_images"]


def test_precise_edit_defaults_quality_like_krea_and_caps_references_with_a_mask():
    fields, image, mask, refs = ir.ideogram_precise_edit_request({"prompt": "p", "image_url": "https://x/a.png"})
    assert fields["quality"] == "high" and mask is None and refs == []
    with pytest.raises(ValueError, match="up to 3 reference images with a mask"):
        ir.ideogram_precise_edit_request({"prompt": "p", "image_url": "https://x/a.png", "mask_url": "https://x/m.png",
                                          "reference_images": [f"https://x/{i}.png" for i in range(4)]})
    with pytest.raises(ValueError, match="Image is required"):
        ir.ideogram_precise_edit_request({"prompt": "p"})


@pytest.mark.asyncio
async def test_krea_plan_keeps_precise_edit_on_krea_with_an_ideogram_key():
    ideogram = _Ideogram()
    gateway = _gateway()
    node = GraphNode(id="n", definitionId="krea-image-ideogram-ideogram-4-5-precise",
                     params={"_kreaAuth": "mcp", "prompt": "p", "image_url": "https://example.com/a.png"})
    a, b, c = ideogram.patches()
    with a, b, c, patch("handlers.krea_gateway.handle_krea_gateway", gateway):
        await _run(node, {}, IDEOGRAM)
    gateway.assert_awaited_once()
    assert ideogram.calls == []


# -- Ideogram 3 and 2a ----------------------------------------------------------

@pytest.mark.asyncio
async def test_ideogram_3_runs_on_v1_generate_with_its_character_reference():
    ideogram = _Ideogram()
    character = _output_file("character.png")
    node = GraphNode(id="n", definitionId="krea-image-ideogram-ideogram-3", params={
        "_kreaAuth": "api-token", "prompt": "a hero", "width": 1920, "height": 1080, "seed": 1337.0})
    a, b, c = ideogram.patches()
    with a, b, c:
        await _run(node, {"character_reference_images": PortValueDict(type="Image", value=[character])},
                   {**IDEOGRAM, **KREA})
    [call] = ideogram.calls
    assert call["path"] == "/v1/ideogram-v3/generate"
    assert call["fields"] == {"prompt": "a hero", "aspect_ratio": "16x9", "rendering_speed": "DEFAULT",
                              "num_images": 1, "seed": 1337}
    assert [field for field, _ in call["files"]] == ["character_reference_images"]


@pytest.mark.asyncio
async def test_krea_style_images_keep_ideogram_3_on_krea():
    """Krea's style images carry a strength Ideogram's API has no field for."""
    ideogram = _Ideogram()
    gateway = _gateway()
    styles = json.dumps([{"url": "https://example.com/s.png", "strength": 1.5}])
    node = GraphNode(id="n", definitionId="krea-image-ideogram-ideogram-3",
                     params={"_kreaAuth": "api-token", "prompt": "p", "style_images": styles})
    a, b, c = ideogram.patches()
    with a, b, c, patch("handlers.krea_gateway.handle_krea_gateway", gateway):
        await _run(node, {}, {**IDEOGRAM, **KREA})
        gateway.assert_awaited_once()
        assert gateway.await_args.args[0].params["style_images"] == styles
        # With only the Ideogram key, no route honors the strengths.
        with pytest.raises(MissingCredentialError):
            await _run(node, {}, IDEOGRAM)
        # Wired style images can't be seen before the run; the direct route refuses them.
        wired = GraphNode(id="w", definitionId="krea-image-ideogram-ideogram-3",
                          params={"_kreaAuth": "api-token", "prompt": "p"})
        with pytest.raises(ValueError, match="no per-image style strength"):
            await _run(wired, {"style_images": PortValueDict(type="Any", value=[{"url": "https://x/s.png",
                                                                                   "strength": 1}])}, IDEOGRAM)
    assert ideogram.calls == []


def test_ideogram_3_takes_one_character_reference():
    with pytest.raises(ValueError, match="one character reference"):
        ir.ideogram_3_request({"prompt": "p", "character_reference_images": ["https://x/a.png", "https://x/b.png"]})


@pytest.mark.asyncio
async def test_ideogram_2_turbo_runs_as_2a_turbo():
    ideogram = _Ideogram()
    node = GraphNode(id="n", definitionId="krea-image-ideogram-ideogram-2-turbo",
                     params={"prompt": "a poster", "width": 1024, "height": 1536, "seed": 1337})
    a, b, c = ideogram.patches()
    with a, b, c:
        await _run(node, {}, IDEOGRAM)
    assert ideogram.calls == [{"path": "/v2/image/generate/ideogram-2a", "key": "fixture-ideogram", "json": {
        "prompt": "a poster", "aspect_ratio": "2x3", "rendering_speed": "turbo", "num_images": 1, "seed": 1337}}]


@pytest.mark.asyncio
@respx.mock
async def test_ideogram_2a_request_reaches_the_documented_endpoint():
    """The real post helper: JSON with the Api-Key header, then the ephemeral image is saved."""
    route = respx.post("https://api.ideogram.ai/v2/image/generate/ideogram-2a").mock(
        return_value=httpx.Response(200, json={"generation_id": "g", "seed": 1,
                                               "data": [{"url": "https://ideogram.example/i.png"}]}))
    respx.get("https://ideogram.example/i.png").mock(
        return_value=httpx.Response(200, content=PNG, headers={"content-type": "image/png"}))
    node = GraphNode(id="n", definitionId="krea-image-ideogram-ideogram-2-turbo", params={"prompt": "p"})
    result = await _run(node, {}, IDEOGRAM)
    request = route.calls.last.request
    assert request.headers["Api-Key"] == "fixture-ideogram"
    assert json.loads(request.content) == {"prompt": "p", "aspect_ratio": "1x1", "rendering_speed": "turbo",
                                           "num_images": 1}
    assert result["image"]["value"].endswith(".png")


def test_sizes_snap_to_the_nearest_maker_shape():
    assert ir.nearest_ratio(1024, 1024, ir.IDEOGRAM_ASPECT_RATIOS, "x") == "1x1"
    assert ir.nearest_ratio(3000, 1000, ir.IDEOGRAM_ASPECT_RATIOS, "x") == "3x1"
    assert ir.nearest_ratio(1000, 1250, ir.IDEOGRAM_ASPECT_RATIOS, "x") == "4x5"
    from handlers.runway import RUNWAY_IMAGE_MODELS

    ratios = RUNWAY_IMAGE_MODELS["gen4_image"]["ratios"]
    # Same shape, nearest pixel count: 1024x1024 is 1024:1024, not 720:720 or 1080:1080.
    assert ir.nearest_ratio(1024, 1024, ratios, ":") == "1024:1024"
    assert ir.nearest_ratio(1920, 1080, ratios, ":") == "1920:1080"
    assert ir.nearest_ratio(1280, 720, ratios, ":") == "1280:720"


def test_seeds_become_whole_numbers_in_range():
    assert ir.whole_seed(1337.0, ir.IDEOGRAM_SEED_MAX) == 1337
    assert ir.whole_seed("", ir.IDEOGRAM_SEED_MAX) is None
    with pytest.raises(ValueError):
        ir.whole_seed(-1, ir.IDEOGRAM_SEED_MAX)
    with pytest.raises(ValueError):
        ir.whole_seed(True, ir.IDEOGRAM_SEED_MAX)


# -- Runway --------------------------------------------------------------------

@pytest.mark.asyncio
async def test_gen4_image_keeps_krea_reference_tags():
    submitted = {}

    async def poll(config, submit_body, node_id, emit):
        submitted.update(url=config.submit_url, body=submit_body)
        return {"output": ["https://runway.example/out.png"]}

    async def materialize(url, media_type, run_dir):
        from pathlib import Path
        return Path(_output_file("runway.png"))

    refs = json.dumps([{"url": "https://example.com/hero.png", "tag": "hero"}])
    node = GraphNode(id="n", definitionId="krea-image-runway-gen-4-image", params={
        "_kreaAuth": "api-token", "prompt": "@hero in the rain", "width": 1920, "height": 1080, "seed": 1337,
        "reference_images": refs})
    with patch("execution.async_poll_runner.async_poll_execute", poll), \
            patch("services.output.materialize_media_value", materialize):
        result = await _run(node, {}, {**RUNWAY, **KREA})
    assert submitted["url"] == "https://api.dev.runwayml.com/v1/text_to_image"
    assert submitted["body"] == {"model": "gen4_image", "promptText": "@hero in the rain", "ratio": "1920:1080",
                                 "seed": 1337, "referenceImages": [{"uri": "https://example.com/hero.png",
                                                                    "tag": "hero"}]}
    assert set(result) == {"image", "images", "artifacts"}


@pytest.mark.asyncio
async def test_gen4_5_runs_on_runway_with_whole_seconds():
    seen = {}

    async def video(node, inputs, api_keys, emit=None):
        seen.update(params=node.params, inputs={k: v.value for k, v in inputs.items()})
        return {"video": {"type": "Video", "value": _output_file("v.mp4", b"\x00\x00\x00\x18ftypmp42")}}

    node = GraphNode(id="n", definitionId="krea-video-runway-gen-4-5", params={
        "_kreaAuth": "api-token", "prompt": "waves", "aspect_ratio": "960:960", "duration": 5.6, "seed": 3})
    with patch("handlers.runway.handle_runway_video", video):
        result = await _run(node, {"start_image": PortValueDict(type="Image", value="https://example.com/a.png")},
                            {**RUNWAY, **KREA})
    assert seen["params"] == {"model": "gen4.5", "ratio": "960:960", "duration": 6, "seed": 3}
    assert seen["inputs"] == {"prompt": "waves", "image": "https://example.com/a.png"}
    assert set(result) == {"video", "videos", "artifacts"}


@pytest.mark.asyncio
@respx.mock(assert_all_called=False)
async def test_gen4_5_refuses_shapes_runway_lacks_before_submitting():
    # handle_runway_video binds async_poll_execute at import, so the submit is
    # patched where it is called; respx refuses any request that slips past.
    submit = AsyncMock(side_effect=AssertionError("submitted to Runway"))
    with patch("handlers.runway.async_poll_execute", submit):
        portrait = GraphNode(id="n", definitionId="krea-video-runway-gen-4-5",
                             params={"prompt": "p", "aspect_ratio": "672:1584"})
        with pytest.raises(ValueError, match="672:1584"):
            await _run(portrait, {"start_image": PortValueDict(type="Image", value="https://example.com/a.png")}, RUNWAY)
        text_only = GraphNode(id="n", definitionId="krea-video-runway-gen-4-5",
                              params={"prompt": "p", "aspect_ratio": "1104:832"})
        with pytest.raises(ValueError, match="text-to-video"):
            await _run(text_only, {}, RUNWAY)
    submit.assert_not_called()


@pytest.mark.asyncio
@pytest.mark.parametrize("output_format,profile,expected,extension", [
    ("hdr_prores", "4444", {"outputFormat": "hdr_prores", "proresProfile": "4444"}, "mov"),
    ("hlg", "4444", {"outputFormat": "hlg"}, "mp4"),
    ("", None, {"outputFormat": "hdr10"}, "mp4"),
])
async def test_ruby_runs_on_video_to_hdr(output_format, profile, expected, extension):
    submitted, saved = {}, {}

    async def poll(config, submit_body, node_id, emit):
        submitted.update(url=config.submit_url, body=submit_body)
        return {"output": ["https://runway.example/hdr"]}

    async def save(url, run_dir, extension="mp4"):
        saved["extension"] = extension
        from pathlib import Path
        return Path(_output_file(f"hdr.{extension}", b"\x00\x00\x00\x18ftypqt  "))

    params = {"_kreaAuth": "api-token", "output_format": output_format}
    if profile:
        params["prores_profile"] = profile
    node = GraphNode(id="n", definitionId="krea-enhance-runway-ruby", params=params)
    video = _output_file("sdr.mp4", b"\x00\x00\x00\x18ftypmp42")
    with patch("execution.async_poll_runner.async_poll_execute", poll), \
            patch("services.output.save_video_from_url", save):
        result = await _run(node, {"video_url": PortValueDict(type="Video", value=video)}, {**RUNWAY, **KREA})
    assert submitted["url"] == "https://api.dev.runwayml.com/v1/video_to_hdr"
    body = dict(submitted["body"])
    assert body.pop("videoUri").startswith("data:video/mp4;base64,")
    assert body == {"model": "ruby", **expected}
    assert saved["extension"] == extension and set(result) == {"video", "videos", "artifacts"}


def test_maker_media_refs():
    assert ir.media_ref("https://example.com/a.png", "Image") == "https://example.com/a.png"
    with pytest.raises(ValueError, match="points at this machine"):
        ir.media_ref("http://127.0.0.1:8000/private", "Image")
    with pytest.raises(ValueError, match="required"):
        ir.media_ref("", "Image")


# -- prices --------------------------------------------------------------------

def _estimate(node_id, params, keys):
    definition = DEFINITIONS[node_id]
    return model_pricing.estimate_node(PRICING.get(node_id), definition, params,
                                       model_pricing.route_provider(definition, keys, params))


def test_each_route_shows_its_own_price():
    precise = "krea-image-ideogram-ideogram-4-5-precise"
    assert _estimate(precise, {"quality": "low"}, IDEOGRAM)["high"] == pytest.approx(0.03)
    assert _estimate(precise, {}, IDEOGRAM)["high"] == pytest.approx(0.22)  # Krea's default quality, high
    assert _estimate(precise, {"quality": "low"}, KREA)["high"] == pytest.approx(0.03)
    ideogram_3 = _estimate("krea-image-ideogram-ideogram-3", {}, IDEOGRAM)
    assert (ideogram_3["low"], ideogram_3["high"]) == pytest.approx((0.06, 0.15))
    assert _estimate("krea-image-ideogram-ideogram-2-turbo", {}, IDEOGRAM)["high"] == pytest.approx(0.025)
    gen4_image = _estimate("krea-image-runway-gen-4-image", {}, RUNWAY)
    assert (gen4_image["low"], gen4_image["high"]) == pytest.approx((0.05, 0.08))
    gen4_5 = "krea-video-runway-gen-4-5"
    assert _estimate(gen4_5, {"duration": 10}, RUNWAY)["high"] == pytest.approx(1.2)
    assert _estimate(gen4_5, {}, RUNWAY)["high"] == pytest.approx(0.6)
    # A fractional duration is rounded before the run, so it isn't priced as given.
    assert _estimate(gen4_5, {"duration": 5.5}, RUNWAY) is None
    # Ruby bills by the source's length and size, unknown before the run.
    assert _estimate("krea-enhance-runway-ruby", {}, RUNWAY) is None
    # Style images keep Ideogram 3 on Krea, which doesn't price it.
    assert _estimate("krea-image-ideogram-ideogram-3", {"style_images": "[{}]"}, {**IDEOGRAM, **KREA}) is None
