"""GPT Image's fal and Krea copies on OpenAI's own Images API (execution/maker_routes_openai.py).

No real provider calls: OpenAI is mocked with respx (an unmocked request
fails the test), fal and the Krea gateway with AsyncMocks.
"""
from __future__ import annotations

import copy
import json
from fractions import Fraction
from pathlib import Path
from unittest.mock import AsyncMock, patch

import pytest
import respx
from httpx import Response

from execution import maker_routes_openai as openai_routes
from execution.sync_runner import get_handler_registry
from models.graph import GraphNode, PortValueDict
from services import model_pricing, node_route
from services.node_registry import NodeRegistry

DEFINITIONS = NodeRegistry().get_all()
PRICING = model_pricing.load_pricing()
OPENAI = {"OPENAI_API_KEY": "fixture-openai"}
FAL = {"FAL_KEY": "fixture-fal"}
KREA = {"KREA_API_TOKEN": "fixture-krea"}
PROMPT = {"prompt": PortValueDict(type="Text", value="a lighthouse at dusk")}
GENERATIONS = "https://api.openai.com/v1/images/generations"
EDITS = "https://api.openai.com/v1/images/edits"
FIXTURES = Path(__file__).resolve().parents[2] / "contracts" / "fixtures" / "handlers" / "openai"


def _sse(name: str) -> Response:
    return Response(200, content=(FIXTURES / name).read_bytes(), headers={"content-type": "text/event-stream"})


def _defaults(definition_id: str) -> dict:
    definition = DEFINITIONS[definition_id]
    return {p["key"]: p["default"] for name in ("params", "sharedParams", "falParams", "directParams")
            for p in definition.get(name) or [] if "default" in p}


async def _run(node, inputs, keys):
    return await get_handler_registry(emit=AsyncMock())[node.definition_id](node, inputs, keys)


def _form(request) -> str:
    return request.content.decode("latin-1")


def _png(path: Path) -> str:
    path.write_bytes(b"\x89PNG\r\n\x1a\n" + b"\x00" * 16)
    return str(path)


# -- fal copies ------------------------------------------------------------------

@pytest.mark.asyncio
@respx.mock
async def test_gpt_image_15_fal_copy_runs_on_openai_and_makes_count_calls():
    route = respx.post(GENERATIONS).mock(side_effect=[_sse("gpt-image-2-generate-sse.txt"),
                                                      _sse("gpt-image-2-generate-sse.txt")])
    params = {**_defaults("gpt-image-1-5"), "image_size": "1536x1024", "quality": "low",
              "background": "transparent", "output_format": "webp", "num_images": 2}
    node = GraphNode(id="n", definitionId="gpt-image-1-5", params=params)
    before = copy.deepcopy(node.params)
    fal = AsyncMock()
    with patch("handlers.fal_universal.handle_fal_universal", fal):
        result = await _run(node, PROMPT, {**OPENAI, **FAL})
    fal.assert_not_awaited()
    assert node.params == before
    assert route.call_count == 2
    body = json.loads(route.calls[0].request.content)
    assert body["model"] == "gpt-image-1.5" and body["size"] == "1536x1024" and body["quality"] == "low"
    assert body["background"] == "transparent" and body["output_format"] == "webp"
    assert "n" not in body and "image_size" not in body and "num_images" not in body
    assert route.calls[0].request.headers["authorization"] == "Bearer fixture-openai"
    assert set(result) == {"image"} and result["image"]["type"] == "Image"


@pytest.mark.asyncio
async def test_gpt_image_15_runs_on_fal_without_the_openai_key():
    fal = AsyncMock(return_value={"image": {"type": "Image", "value": "https://example.com/f.png"}})
    node = GraphNode(id="n", definitionId="gpt-image-1-5", params=_defaults("gpt-image-1-5"))
    with patch("handlers.fal_universal.handle_fal_universal", fal):
        await _run(node, PROMPT, FAL)
    fal.assert_awaited_once()
    assert fal.await_args.args[0].params["endpoint_id"] == "fal-ai/gpt-image-1.5"


@pytest.mark.asyncio
async def test_gpt_image_15_leaves_openai_on_its_shutdown_date(monkeypatch):
    monkeypatch.setattr(node_route, "_today", lambda: "2026-12-01")
    fal = AsyncMock(return_value={"image": {"type": "Image", "value": "https://example.com/f.png"}})
    node = GraphNode(id="n", definitionId="gpt-image-1-5-edit", params=_defaults("gpt-image-1-5-edit"))
    with respx.mock, patch("handlers.fal_universal.handle_fal_universal", fal):
        await _run(node, {**PROMPT, "images": PortValueDict(type="Image", value=["https://example.com/a.png"])},
                   {**OPENAI, **FAL})
    fal.assert_awaited_once()


@pytest.mark.asyncio
@respx.mock
async def test_gpt_image_15_edit_sends_every_reference_and_input_fidelity(tmp_path):
    route = respx.post(EDITS).mock(return_value=_sse("gpt-image-2-edit-sse.txt"))
    params = {**_defaults("gpt-image-1-5-edit"), "input_fidelity": "high", "quality": "medium"}
    node = GraphNode(id="n", definitionId="gpt-image-1-5-edit", params=params)
    images = [_png(tmp_path / "a.png"), _png(tmp_path / "b.png")]
    result = await _run(node, {**PROMPT, "images": PortValueDict(type="Image", value=images)}, {**OPENAI, **FAL})
    form = _form(route.calls[0].request)
    assert form.count('name="image[]"') == 2
    assert 'name="model"\r\n\r\ngpt-image-1.5' in form
    assert 'name="input_fidelity"\r\n\r\nhigh' in form
    assert 'name="quality"\r\n\r\nmedium' in form
    assert 'name="size"' not in form  # 'auto' is OpenAI's own default
    assert result["image"]["type"] == "Image"


@pytest.mark.asyncio
@respx.mock
async def test_gpt_image_2_fal_copy_maps_its_preset_and_preview_frames():
    route = respx.post(GENERATIONS).mock(return_value=_sse("gpt-image-2-generate-sse.txt"))
    node = GraphNode(id="n", definitionId="gpt-image-2-fal-generate", params=_defaults("gpt-image-2-fal-generate"))
    await _run(node, PROMPT, {**OPENAI, **FAL})
    body = json.loads(route.calls[0].request.content)
    assert body["model"] == "gpt-image-2"
    assert body["size"] == "1024x768"  # landscape_4_3, as its label promises
    assert body["quality"] == "high" and body["partial_images"] == 2
    assert "background" not in body and "input_fidelity" not in body


@pytest.mark.asyncio
async def test_a_fal_size_openai_cant_render_stays_on_fal():
    fal = AsyncMock(return_value={"image": {"type": "Image", "value": "https://example.com/f.png"}})
    params = {**_defaults("gpt-image-2-fal-edit"), "image_size": "portrait_16_9"}
    node = GraphNode(id="n", definitionId="gpt-image-2-fal-edit", params=params)
    with respx.mock, patch("handlers.fal_universal.handle_fal_universal", fal):
        await _run(node, {**PROMPT, "images": PortValueDict(type="Image", value=["https://example.com/a.png"])},
                   {**OPENAI, **FAL})
    fal.assert_awaited_once()
    assert fal.await_args.args[0].params["image_size"] == "portrait_16_9"


@pytest.mark.asyncio
async def test_a_fal_size_with_only_the_openai_key_says_why():
    """The saved OpenAI key can't take a fal-only preset: the error names the
    fal key and the size, not just "OPENAI_API_KEY or FAL_KEY is required"."""
    from execution.missing_credential import MissingCredentialError
    node = GraphNode(id="n", definitionId="gpt-image-2-fal-generate",
                     params={**_defaults("gpt-image-2-fal-generate"), "image_size": "square"})
    with respx.mock as router, pytest.raises(
            MissingCredentialError, match="^FAL_KEY is required: .*doesn't take image_size square$"):
        await _run(node, PROMPT, OPENAI)
    assert not router.calls


def test_every_gpt_image_2_fal_size_is_mapped_or_kept_on_fal():
    for node_id in ("gpt-image-2-fal-generate", "gpt-image-2-fal-edit"):
        options = {o["value"] for p in DEFINITIONS[node_id]["params"] if p["key"] == "image_size" for o in p["options"]}
        blocked = set(DEFINITIONS[node_id]["directRoute"]["rejects"]["image_size"])
        mapped = set(openai_routes.FAL_GPT_IMAGE_2_SIZES) | {"auto"}
        assert options <= mapped | blocked and not mapped & blocked, node_id
        default = next(p["default"] for p in DEFINITIONS[node_id]["params"] if p["key"] == "image_size")
        assert default not in blocked, node_id
    for size in openai_routes.FAL_GPT_IMAGE_2_SIZES.values():
        _assert_openai_size(size)


def test_translation_refuses_a_size_with_no_openai_equivalent():
    node = GraphNode(id="n", definitionId="gpt-image-2-fal-generate", params={"image_size": "square"})
    with pytest.raises(ValueError, match="no OpenAI equivalent"):
        openai_routes.fal_gpt_image_to_openai(openai_routes.GPT_IMAGE_2)(node, {})


@pytest.mark.asyncio
async def test_a_transparent_jpeg_is_refused_before_any_request():
    params = {**_defaults("gpt-image-1-5"), "background": "transparent", "output_format": "jpeg"}
    node = GraphNode(id="n", definitionId="gpt-image-1-5", params=params)
    with respx.mock, pytest.raises(ValueError, match="PNG or WebP"):
        await _run(node, PROMPT, {**OPENAI, **FAL})


# -- Krea copies -----------------------------------------------------------------

@pytest.mark.asyncio
@respx.mock
async def test_krea_gpt_image_2_runs_on_openai_in_krea_ports():
    route = respx.post(GENERATIONS).mock(return_value=_sse("gpt-image-2-generate-sse.txt"))
    gateway = AsyncMock()
    node = GraphNode(id="k", definitionId="krea-image-openai-gpt-image-2",
                     params={**_defaults("krea-image-openai-gpt-image-2"), "aspect_ratio": "16:9", "resolution": "2K"})
    with patch("handlers.krea_gateway.handle_krea_gateway", gateway):
        result = await _run(node, PROMPT, {**OPENAI, **KREA})
    gateway.assert_not_awaited()
    body = json.loads(route.calls[0].request.content)
    assert body["model"] == "gpt-image-2" and body["size"] == "2048x1152" and body["quality"] == "high"
    assert "_kreaAuth" not in body and "aspect_ratio" not in body
    assert set(result) == {"image", "images", "artifacts"}
    assert result["images"]["value"][0].startswith("/api/outputs/")


@pytest.mark.asyncio
@respx.mock
async def test_krea_flare_sends_a_public_reference_to_openai_edits():
    route = respx.post(EDITS).mock(return_value=_sse("gpt-image-2-edit-sse.txt"))
    fetch = AsyncMock(return_value=(b"\x89PNG\r\n\x1a\n" + b"\x00" * 16, "image/png"))
    node = GraphNode(id="k", definitionId="krea-image-openai-gpt-image-2-5-flare", params={
        **_defaults("krea-image-openai-gpt-image-2-5-flare"), "prompt": "a cutout", "aspect_ratio": "1:1",
        "resolution": "1K", "quality": "xhigh", "background": "transparent",
        "image_urls": '["https://example.com/ref.png"]'})
    with patch("services.public_url.fetch_public_media", fetch):
        await _run(node, {}, {**OPENAI, **KREA})
    fetch.assert_awaited_once()
    assert fetch.await_args.args[0] == "https://example.com/ref.png"
    form = _form(route.calls[0].request)
    assert form.count('name="image[]"') == 1
    assert 'name="model"\r\n\r\ngpt-image-2.5-flare' in form
    assert 'name="size"\r\n\r\n1024x1024' in form
    assert 'name="quality"\r\n\r\nxhigh' in form and 'name="background"\r\n\r\ntransparent' in form
    assert 'name="prompt"\r\n\r\na cutout' in form


@pytest.mark.asyncio
async def test_krea_width_keeps_gpt_image_2_on_krea():
    gateway = AsyncMock(return_value={"image": {"type": "Image", "value": "https://example.com/k.png"}})
    node = GraphNode(id="k", definitionId="krea-image-openai-gpt-image-2", params={"width": 1920, "height": 1080})
    with respx.mock, patch("handlers.krea_gateway.handle_krea_gateway", gateway):
        await _run(node, PROMPT, {**OPENAI, **KREA})
    gateway.assert_awaited_once()
    assert gateway.await_args.args[0].params["width"] == 1920


@pytest.mark.asyncio
async def test_the_krea_plan_keeps_sunburst_on_krea_with_an_openai_key():
    gateway = AsyncMock(return_value={"image": {"type": "Image", "value": "https://example.com/k.png"}})
    node = GraphNode(id="k", definitionId="krea-image-openai-gpt-image-2-5-sunburst",
                     params={"_kreaAuth": "mcp", "aspect_ratio": "1:1", "resolution": "1K"})
    with respx.mock, patch("handlers.krea_gateway.handle_krea_gateway", gateway):
        await _run(node, PROMPT, OPENAI)
    gateway.assert_awaited_once()


def _assert_openai_size(size: str) -> None:
    width, height = (int(edge) for edge in size.split("x"))
    assert width % 16 == 0 and height % 16 == 0, size
    assert max(width, height) <= 3840 and max(width, height) / min(width, height) <= 3, size
    assert 655_360 <= width * height <= 8_294_400, size


def test_every_krea_size_is_valid_on_openai_and_keeps_its_ratio():
    krea = json.loads((Path(__file__).resolve().parents[1] / "data" / "krea_gateway_models.json").read_text())
    for node_id in ("krea-image-openai-gpt-image-2", "krea-image-openai-gpt-image-2-5-flare",
                    "krea-image-openai-gpt-image-2-5-sunburst"):
        props = krea["models"][node_id]["requestSchema"]["properties"]
        assert set(props["aspect_ratio"]["enum"]) == set(openai_routes.KREA_OPENAI_SIZES), node_id
        for aspect, sizes in openai_routes.KREA_OPENAI_SIZES.items():
            assert set(sizes) == set(props["resolution"]["enum"]), node_id
            a, b = (int(part) for part in aspect.split(":"))
            pixels = []
            for resolution in ("1K", "2K", "4K"):
                _assert_openai_size(sizes[resolution])
                width, height = (int(edge) for edge in sizes[resolution].split("x"))
                assert Fraction(width, height) == Fraction(a, b), (aspect, resolution)
                pixels.append(width * height)
            assert pixels == sorted(pixels) and len(set(pixels)) == 3, aspect
    # OpenAI's standard sizes at 1K where the ratio has one.
    assert {openai_routes.KREA_OPENAI_SIZES[a]["1K"] for a in ("1:1", "3:2", "2:3")} == set(openai_routes.STANDARD_SIZES)


def test_krea_size_defaults_when_only_one_is_set():
    assert openai_routes.krea_openai_size({}) is None
    assert openai_routes.krea_openai_size({"resolution": "2K"}) == "2048x2048"
    assert openai_routes.krea_openai_size({"aspect_ratio": "9:16"}) == "720x1280"


# -- pricing follows the route -----------------------------------------------------

def _estimate(node_id, params, keys):
    definition = DEFINITIONS[node_id]
    provider = model_pricing.route_provider(definition, keys, params)
    return model_pricing.estimate_node(PRICING["nodes"].get(node_id), definition, params, provider)


def test_openai_route_prices_from_openais_per_image_table():
    both = {**OPENAI, **FAL}
    assert _estimate("gpt-image-1-5", {}, both) == {"currency": "usd", "low": 0.133, "high": 0.133}
    two = _estimate("gpt-image-1-5", {"num_images": 2, "image_size": "1024x1536", "quality": "low"}, both)
    assert two["low"] == pytest.approx(0.026)
    edit = _estimate("gpt-image-1-5-edit", {}, both)  # auto size, high quality
    assert (edit["low"], edit["high"], edit["plus"]) == (0.133, 0.2, "input images")
    # No fal list price for these copies, so the fal route is unpriced.
    assert _estimate("gpt-image-1-5", {}, FAL) is None
    # GPT Image 2's defaults (a 1024x768 preset; Krea's unset size) aren't in OpenAI's per-image
    # table, and 2.5 has none, so their OpenAI route stays unpriced.
    for node_id in ("gpt-image-2-fal-generate", "gpt-image-2-fal-edit", "krea-image-openai-gpt-image-2",
                    "krea-image-openai-gpt-image-2-5-flare", "krea-image-openai-gpt-image-2-5-sunburst"):
        assert node_id not in PRICING["nodes"], node_id


@pytest.mark.parametrize("keys,route,billed,at_defaults", [
    ({**OPENAI, **FAL}, "direct", "openai", [0.133, 0.133]),
    # The fal copy has no fal list price here, so nothing is billed-by yet.
    (FAL, "fal", None, None),
])
def test_describe_node_names_the_openai_route_and_its_price(monkeypatch, keys, route, billed, at_defaults):
    from fastapi.testclient import TestClient
    import main

    monkeypatch.setattr(main, "load_settings", lambda: {"apiKeys": keys})
    body = TestClient(main.app).get("/api/agent/nodes/gpt-image-1-5").json()
    assert body["route"] == route and body["fallback"] == "fal"
    assert body["price"]["billedBy"] == billed
    assert set(body["price"]["routes"]) == {"openai"}
    assert body["price"].get("atDefaultsUsd") == at_defaults


# -- review fixes ------------------------------------------------------------------

_ONE_PIXEL_PNG = ("iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNkYAAAAAYAAjCB0C8AAAAASUVORK5CYII=")


def _final_only_sse(payload: bytes) -> Response:
    import base64

    b64 = base64.b64encode(payload).decode()
    body = f'event: image_generation.completed\ndata: {{"b64_json": "{b64}"}}\n\ndata: [DONE]\n\n'
    return Response(200, content=body.encode(), headers={"content-type": "text/event-stream"})


@pytest.mark.asyncio
@respx.mock
async def test_count_keeps_every_paid_image_and_shows_the_first():
    """Each of Count's calls is billed by OpenAI; the handlers name the final
    file after the node id, so without a per-call name the second image
    overwrote the first and `image` showed the last one."""
    import base64

    first = base64.b64decode(_ONE_PIXEL_PNG) + b"first"
    second = base64.b64decode(_ONE_PIXEL_PNG) + b"second"
    respx.post(GENERATIONS).mock(side_effect=[_final_only_sse(first), _final_only_sse(second)])
    node = GraphNode(id="n", definitionId="gpt-image-1-5", params={"model": "gpt-image-1.5", "num_images": 2})
    result = await openai_routes.openai_image_direct()(node, PROMPT, OPENAI)
    assert len(result["paths"]) == 2 and len(set(result["paths"])) == 2
    assert [Path(path).read_bytes() for path in result["paths"]] == [first, second]
    assert result["image"]["value"] == result["paths"][0]
