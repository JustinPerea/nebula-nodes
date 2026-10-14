"""BytePlus ModelArk: the client's errors and Seedream's direct routes.

Only the transport is mocked (httpx.MockTransport): no provider is contacted
and nothing is billed. Covers the error messages a person sees (activation,
key, quota), route choice for the fal and Krea Seedream copies (maker key
wins; a seed, Krea style images or a size ModelArk can't render keep the run
on the copy; the Krea plan wins over a maker key), the request each route
sends, and that the persisted node is never mutated.
"""
from __future__ import annotations

import base64
import copy
import json
from typing import Any
from unittest.mock import AsyncMock, patch

import httpx
import pytest

from execution import maker_routes_byteplus
from execution.missing_credential import MissingCredentialError
from execution.sync_runner import get_handler_registry
from handlers import byteplus
from models.graph import GraphNode, PortValueDict
from services import model_pricing, node_route
from services.node_registry import NodeRegistry

DEFINITIONS = NodeRegistry().get_all()
PNG = base64.b64decode(
    "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8/5+hHgAHggJ/PchI7wAAAABJRU5ErkJggg=="
)
BYTEPLUS = {"BYTEPLUS_API_KEY": "fixture-byteplus"}
FAL = {"FAL_KEY": "fixture-fal"}
KREA = {"KREA_API_TOKEN": "fixture-krea"}
PROMPT = {"prompt": PortValueDict(type="Text", value="a lighthouse at dusk")}
IMAGES_URL = "https://ark.ap-southeast.bytepluses.com/api/v3/images/generations"
_REAL_CLIENT = httpx.AsyncClient


def _ok(count: int = 1) -> httpx.Response:
    item = {"b64_json": base64.b64encode(PNG).decode("ascii"), "size": "2048x2048"}
    return httpx.Response(200, json={"model": "m", "created": 1, "data": [item] * count,
                                     "usage": {"generated_images": count}})


class ModelArk:
    """A fake ModelArk: records requests, answers with ``responses`` in turn."""

    def __init__(self, monkeypatch: pytest.MonkeyPatch, *responses: httpx.Response):
        self.requests: list[httpx.Request] = []
        self.responses = list(responses) or [_ok()]
        def factory(*args: Any, **kwargs: Any) -> httpx.AsyncClient:
            return _REAL_CLIENT(*args, transport=httpx.MockTransport(self._answer), **kwargs)

        monkeypatch.setattr(byteplus.httpx, "AsyncClient", factory)

    def _answer(self, request: httpx.Request) -> httpx.Response:
        self.requests.append(request)
        return self.responses.pop(0) if len(self.responses) > 1 else self.responses[0]

    @property
    def bodies(self) -> list[dict[str, Any]]:
        return [json.loads(request.content) for request in self.requests]


async def _run(node: GraphNode, inputs: dict[str, PortValueDict], keys: dict[str, str]) -> dict[str, Any]:
    return await get_handler_registry(emit=AsyncMock())[node.definition_id](node, inputs, keys)


def _defaults(definition_id: str) -> dict[str, Any]:
    definition = DEFINITIONS[definition_id]
    return {p["key"]: p["default"] for name in ("params", "sharedParams", "falParams", "directParams")
            for p in definition.get(name) or [] if "default" in p}


# -- the client ----------------------------------------------------------------

@pytest.mark.asyncio
async def test_request_sends_the_bearer_key_to_the_asia_pacific_endpoint(monkeypatch):
    ark = ModelArk(monkeypatch)
    await byteplus.request("POST", "/images/generations", "fixture-key", json={"model": "m"})
    request = ark.requests[0]
    assert str(request.url) == IMAGES_URL
    assert request.headers["Authorization"] == "Bearer fixture-key"


@pytest.mark.asyncio
@pytest.mark.parametrize("status,code,expected", [
    (404, "ModelNotOpen", "hasn't activated seedream-4-5-251128"),
    (404, "ModelNotOpen", "USD 30"),
    (404, "InvalidEndpointOrModel.NotFound", "Model activation page"),
    (401, "AuthenticationError", "check BYTEPLUS_API_KEY"),
    (401, "AuthenticationError", "ap-southeast-1"),
    (429, "QuotaExceeded", "free-trial quota"),
    (429, "ModelAccountIpmRateLimitExceeded", "rate limit"),
    (403, "AccountOverdueError", "overdue balance"),
    (400, "InputTextSensitiveContentDetected", "sensitive content"),
])
async def test_errors_say_what_to_do(monkeypatch, status, code, expected):
    ModelArk(monkeypatch, httpx.Response(status, json={"error": {"code": code, "message": "vendor text"}}))
    with pytest.raises(byteplus.BytePlusError) as raised:
        await byteplus.generate_images("k", {"model": "seedream-4-5-251128"})
    assert raised.value.status == status and raised.value.code == code
    assert expected in str(raised.value) and "vendor text" in str(raised.value)


@pytest.mark.asyncio
async def test_an_unparseable_error_keeps_the_raw_text(monkeypatch):
    ModelArk(monkeypatch, httpx.Response(502, text="<html>bad gateway</html>"))
    with pytest.raises(byteplus.BytePlusError, match="502.*bad gateway"):
        await byteplus.generate_images("k", {"model": "m"})


@pytest.mark.asyncio
async def test_a_batch_with_no_image_raises_and_skips_failed_items(monkeypatch):
    ModelArk(monkeypatch, httpx.Response(200, json={"data": [
        {"error": {"code": "OutputImageSensitiveContentDetected", "message": "x"}}]}))
    with pytest.raises(RuntimeError, match="OutputImageSensitiveContentDetected"):
        await byteplus.generate_images("k", {"model": "m"})
    ModelArk(monkeypatch, httpx.Response(200, json={"data": [
        {"error": {"code": "OutputImageSensitiveContentDetected"}},
        {"b64_json": base64.b64encode(PNG).decode("ascii")}]}))
    images = await byteplus.generate_images("k", {"model": "m"})
    assert images == [(PNG, "png")]


def test_a_missing_key_is_a_missing_credential():
    with pytest.raises(MissingCredentialError, match="BYTEPLUS_API_KEY"):
        byteplus.api_key({"BYTEPLUS_API_KEY": "  "})


# -- seedream-4-5 (fal) ---------------------------------------------------------

@pytest.mark.asyncio
async def test_seedream_runs_on_byteplus_with_the_maker_key(monkeypatch):
    ark = ModelArk(monkeypatch)
    node = GraphNode(id="s", definitionId="seedream-4-5", params={**_defaults("seedream-4-5"), "image_size": "landscape_16_9"})
    before = copy.deepcopy(node.params)
    fal = AsyncMock()
    with patch("handlers.fal_universal.handle_fal_universal", fal):
        result = await _run(node, PROMPT, {**BYTEPLUS, **FAL})
    fal.assert_not_called()
    assert node.params == before
    assert result["image"]["value"].endswith(".png")
    assert ark.bodies == [{
        "model": "seedream-4-5-251128", "prompt": "a lighthouse at dusk", "size": "2848x1600",
        "response_format": "b64_json", "watermark": False,
    }]


@pytest.mark.asyncio
@pytest.mark.parametrize("params,size", [
    ({"model": "5.0-lite", "image_size": "auto_3K"}, "3K"),
    ({"model": "4.5", "image_size": "auto_4K"}, "4K"),
    ({"model": "4.5"}, "2048x2048"),  # square_hd, the default
    ({"model": "4.5", "image_size": "portrait_4_3"}, "1728x2304"),
])
async def test_seedream_sizes_map_to_byteplus(monkeypatch, params, size):
    ark = ModelArk(monkeypatch)
    node = GraphNode(id="s", definitionId="seedream-4-5", params=params)
    await _run(node, PROMPT, BYTEPLUS)
    assert ark.bodies[0]["size"] == size
    assert ark.bodies[0]["model"] == maker_routes_byteplus.FAL_SEEDREAM_MODELS[params["model"]]


@pytest.mark.asyncio
async def test_generations_and_images_per_generation(monkeypatch):
    """num_images is that many requests; max_images asks for a sequential batch."""
    ark = ModelArk(monkeypatch, _ok(3), _ok(2))
    node = GraphNode(id="s", definitionId="seedream-4-5", params={"num_images": 2, "max_images": 3})
    result = await _run(node, PROMPT, BYTEPLUS)
    assert len(ark.requests) == 2
    assert all(body["sequential_image_generation"] == "auto"
               and body["sequential_image_generation_options"] == {"max_images": 3} for body in ark.bodies)
    assert set(result) == {"image"}


@pytest.mark.asyncio
async def test_references_go_as_urls_or_data_uris(monkeypatch, tmp_path):
    ark = ModelArk(monkeypatch)
    local = tmp_path / "ref.png"
    local.write_bytes(PNG)
    inputs = {**PROMPT, "images": PortValueDict(type="Image", value=["https://example.com/a.png", str(local)])}
    with patch("services.file_access.require_allowed_path", lambda path: __import__("pathlib").Path(path)):
        await _run(GraphNode(id="s", definitionId="seedream-4-5", params={}), inputs, BYTEPLUS)
    image = ark.bodies[0]["image"]
    assert image[0] == "https://example.com/a.png"
    assert image[1] == "data:image/png;base64," + base64.b64encode(PNG).decode("ascii")


@pytest.mark.asyncio
@pytest.mark.parametrize("params", [
    {"seed": 7},                     # ModelArk has no seed
    {"image_size": "square"},        # 512x512: below ModelArk's 3,686,400 pixels
    {"image_size": {"width": 1024, "height": 1024}},
    {"enable_safety_checker": False},  # ModelArk always runs its own content filter
])
async def test_settings_byteplus_cant_honor_keep_seedream_on_fal(monkeypatch, params):
    ark = ModelArk(monkeypatch)
    seen: dict[str, Any] = {}

    async def fal(node, inputs, api_keys, emit=None):
        seen.update(node.params)
        return {"image": {"type": "Image", "value": "https://example.com/f.png"}}

    node = GraphNode(id="s", definitionId="seedream-4-5", params={**_defaults("seedream-4-5"), **params})
    with patch("handlers.fal_universal.handle_fal_universal", fal):
        await _run(node, PROMPT, {**BYTEPLUS, **FAL})
    assert ark.requests == []
    assert seen["endpoint_id"].startswith("fal-ai/bytedance/seedream/v4.5/")
    # With only the BytePlus key there's no route that honors the setting.
    with pytest.raises(MissingCredentialError):
        await _run(node, PROMPT, BYTEPLUS)


@pytest.mark.asyncio
async def test_fal_gets_no_byteplus_and_byteplus_gets_no_fal_params(monkeypatch):
    ark = ModelArk(monkeypatch)
    seen: dict[str, Any] = {}

    async def fal(node, inputs, api_keys, emit=None):
        seen.update(node.params)
        return {"image": {"type": "Image", "value": "https://example.com/f.png"}}

    node = GraphNode(id="s", definitionId="seedream-4-5", params={**_defaults("seedream-4-5"), "stray": 1})
    with patch("handlers.fal_universal.handle_fal_universal", fal):
        await _run(node, PROMPT, FAL)
    assert "stray" not in seen and seen["enable_safety_checker"] is True
    await _run(node, PROMPT, BYTEPLUS)
    assert "enable_safety_checker" not in ark.bodies[0] and "seed" not in ark.bodies[0]


def test_translation_refuses_what_neither_route_takes():
    node = GraphNode(id="s", definitionId="seedream-4-5", params={"model": "4.5", "image_size": "auto_3K"})
    with pytest.raises(ValueError, match="auto_3K"):
        maker_routes_byteplus.seedream_fal_to_byteplus(node, PROMPT)
    refs = {"images": PortValueDict(type="Image", value=[f"https://e/{i}.png" for i in range(10)])}
    node = GraphNode(id="s", definitionId="seedream-4-5", params={"max_images": 6})
    with pytest.raises(ValueError, match="at most 15 images"):
        maker_routes_byteplus.seedream_fal_to_byteplus(node, {**PROMPT, **refs})


@pytest.mark.asyncio
async def test_a_cinema_scene_on_seedream_inherits_the_byteplus_route(monkeypatch):
    ark = ModelArk(monkeypatch)
    from handlers.cinema_scene import _build_base_node

    base, inputs = _build_base_node("seedream-4-5", "a wide street", [], "2.39:1", {}, "scene")
    result = await _run(base, inputs, BYTEPLUS)
    assert ark.bodies[0]["size"] == "4096x1714"
    assert result["image"]["value"]


# -- Krea copies -----------------------------------------------------------------

@pytest.mark.asyncio
@pytest.mark.parametrize("node_id,model,width,height", [
    ("krea-image-bytedance-seedream-4", "seedream-4-0-250828", 1024, 1024),
    ("krea-image-bytedance-seedream-5-lite", "seedream-5-0-lite-260128", 2560, 1440),
    ("krea-image-bytedance-seedream-5-pro", "dola-seedream-5-0-pro-260628", 2048.0, 2048.0),
])
async def test_krea_copy_runs_on_byteplus_with_the_maker_key(monkeypatch, node_id, model, width, height):
    ark = ModelArk(monkeypatch)
    params = {**_defaults(node_id), "prompt": "a lighthouse", "width": width, "height": height}
    node = GraphNode(id="k", definitionId=node_id, params=params)
    before = copy.deepcopy(node.params)
    gateway = AsyncMock()
    with patch("handlers.krea_gateway.handle_krea_gateway", gateway):
        result = await _run(node, {}, {**BYTEPLUS, **KREA})
    gateway.assert_not_called()
    assert node.params == before
    assert set(result) == {"image", "images", "artifacts"}
    # One image is BytePlus's default, and Seedream 5.0 pro doesn't take
    # sequential_image_generation at all, so a single-image request omits it.
    assert ark.bodies == [{"model": model, "prompt": "a lighthouse", "size": f"{int(width)}x{int(height)}",
                           "response_format": "b64_json", "watermark": False}]


@pytest.mark.asyncio
@pytest.mark.parametrize("node_id,params", [
    ("krea-image-bytedance-seedream-5-lite", {"width": 1024, "height": 1024}),   # under 3,686,400 px
    ("krea-image-bytedance-seedream-5-pro", {"width": 4096, "height": 4096}),    # over 4,624,220 px
    ("krea-image-bytedance-seedream-4", {"width": 4096, "height": 200}),         # ratio over 16
    ("krea-image-bytedance-seedream-4", {"width": 1024.5, "height": 1024}),      # not whole pixels
    ("krea-image-bytedance-seedream-4", {"width": 1024, "height": 1024,
                                         "style_images": '[{"url": "https://e/s.png", "strength": 1}]'}),
    ("krea-image-bytedance-seedream-4", {"width": 1024, "height": 1024, "_kreaAuth": "mcp"}),
])
async def test_what_byteplus_cant_render_stays_on_krea(monkeypatch, node_id, params):
    ark = ModelArk(monkeypatch)
    seen: dict[str, Any] = {}

    async def gateway(node, inputs, api_keys, emit=None):
        seen.update(node.params)
        return {"image": {"type": "Image", "value": "https://example.com/k.png"}}

    node = GraphNode(id="k", definitionId=node_id, params={"_kreaAuth": "api-token", "prompt": "p", **params})
    with patch("handlers.krea_gateway.handle_krea_gateway", gateway):
        await _run(node, {}, {**BYTEPLUS, **KREA})
    assert ark.requests == []
    assert seen["width"] == params["width"]


@pytest.mark.asyncio
async def test_wired_krea_style_images_are_refused_on_byteplus(monkeypatch):
    ark = ModelArk(monkeypatch)
    node = GraphNode(id="k", definitionId="krea-image-bytedance-seedream-4",
                     params={"prompt": "p", "width": 1024, "height": 1024})
    inputs = {"style_images": PortValueDict(type="Any", value=[{"url": "https://e/s.png", "strength": 1}])}
    with pytest.raises(ValueError, match="style images"):
        await _run(node, inputs, BYTEPLUS)
    assert ark.requests == []


# -- pricing and readiness follow the route ---------------------------------------

def _estimate(node_id: str, params: dict[str, Any], keys: dict[str, str]) -> Any:
    pricing = model_pricing.load_pricing()
    return model_pricing.estimate_run([{"id": "n", "definitionId": node_id, "params": params, "name": "n"}],
                                      pricing, DEFINITIONS, keys)


def test_seedream_is_priced_on_byteplus_by_generated_images():
    estimate = _estimate("seedream-4-5", {"num_images": 2, "max_images": 3}, BYTEPLUS)
    priced = estimate["priced"]["n"]
    assert (priced["low"], priced["high"]) == (pytest.approx(0.08), pytest.approx(0.24))
    lite = _estimate("seedream-4-5", {"model": "5.0-lite"}, BYTEPLUS)["priced"]["n"]
    assert lite["low"] == lite["high"] == pytest.approx(0.035)
    # The fal route has no list price: unpriced, never free.
    assert "n" not in _estimate("seedream-4-5", {}, FAL)["priced"]


def test_krea_seedream_prices_follow_the_route():
    on_byteplus = _estimate("krea-image-bytedance-seedream-5-pro", {"width": 2048, "height": 2048},
                            {**BYTEPLUS, **KREA})["priced"]["n"]
    assert (on_byteplus["low"], on_byteplus["high"]) == (0.045, 0.09)
    on_krea = _estimate("krea-image-bytedance-seedream-4", {"width": 512, "height": 512, "_kreaAuth": "api-token"},
                        {**BYTEPLUS, **KREA})["priced"]["n"]
    assert on_krea["low"] == 0.03 and node_route.select_route(
        DEFINITIONS["krea-image-bytedance-seedream-4"], {"width": 512, "height": 512}, BYTEPLUS).kind == "unset"


def test_size_fits_reads_the_documented_window():
    limits = {"minPixels": 3_686_400, "maxPixels": 16_777_216, "maxAspect": 16}
    assert node_route.size_fits(2560, 1440, limits) and node_route.size_fits(4096, 4096, limits)
    assert not node_route.size_fits(2559, 1440, limits) and not node_route.size_fits(4097, 4096, limits)
    assert not node_route.size_fits(True, 4096, limits) and not node_route.size_fits("2560", 1440, limits)
