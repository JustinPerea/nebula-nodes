"""Fal and Krea copies that run on the maker's API with the person's key.

Only the transport is mocked: no provider is contacted and nothing is billed.
Covers route selection (maker key wins, fallback, the Krea plan wins over a
maker key), that no route receives another's params, that the persisted node
is never mutated, and the fal/Krea -> Gemini API translation.
"""
from __future__ import annotations

import copy
from unittest.mock import AsyncMock, MagicMock, patch

import pytest

from execution import maker_routes
from execution.missing_credential import MissingCredentialError
from execution.sync_runner import get_handler_registry
from models.graph import GraphNode, PortValueDict
from services import node_route
from services.node_registry import NodeRegistry

DEFINITIONS = NodeRegistry().get_all()
RED_PIXEL_B64 = (
    "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR4"
    "2mP8/5+hHgAHggJ/PchI7wAAAABJRU5ErkJggg=="
)
GOOGLE = {"GOOGLE_API_KEY": "fixture-google"}
FAL = {"FAL_KEY": "fixture-fal"}
KREA = {"KREA_API_TOKEN": "fixture-krea"}
PROMPT = {"prompt": PortValueDict(type="Text", value="a lighthouse at dusk")}
MAKER_ROUTED = {
    "nano-banana-fal", "nano-banana-fal-edit", "meshy-text-to-3d", "meshy-image-to-3d",
    "krea-image-google-nano-banana-2", "krea-image-google-nano-banana-pro",
    "krea-image-google-nano-banana-flash-lite", "krea-image-google-nano-banana",
    # Google lane (execution/maker_routes_google.py)
    "identity-edit", "krea-image-google-nano-banana-2-1", "krea-video-google-veo-3-1",
    "krea-video-google-veo-3-1-fast", "krea-video-google-veo-3-1-lite", "krea-video-google-gemini-omni-flash-1-1",
    # OpenAI lane (execution/maker_routes_openai.py)
    "gpt-image-1-5", "gpt-image-1-5-edit", "gpt-image-2-fal-generate", "gpt-image-2-fal-edit",
    "krea-image-openai-gpt-image-2", "krea-image-openai-gpt-image-2-5-flare",
    "krea-image-openai-gpt-image-2-5-sunburst",
    # xAI (execution/maker_routes_xai.py)
    "grok-imagine-image", "grok-imagine-image-edit", "krea-image-xai-grok-imagine-2",
    "krea-image-xai-grok-imagine-2-edit", "krea-video-xai-grok-video", "krea-video-xai-grok-video-1-5",
    # Ideogram and Runway (tests/test_maker_routes_ideogram_runway.py)
    "krea-image-ideogram-ideogram-4-5-precise", "krea-image-ideogram-ideogram-3",
    "krea-image-ideogram-ideogram-2-turbo", "krea-image-runway-gen-4-image", "krea-video-runway-gen-4-5",
    "krea-enhance-runway-ruby",
    # MiniMax and Meshy copies (tests/test_maker_routes_minimax_meshy.py)
    "krea-video-minimax-hailuo-02", "krea-video-minimax-hailuo-2-3", "krea-video-minimax-hailuo-2-3-fast",
    "krea-video-minimax-hailuo-3", "krea-3d-meshy-meshy-7",
    # ElevenLabs (test_maker_routes_elevenlabs.py)
    "elevenlabs-music", "krea-audio-elevenlabs-music", "krea-audio-elevenlabs-music-v2",
    "krea-audio-elevenlabs-music-v2-5", "krea-audio-elevenlabs-tts", "runway-tts", "runway-sts", "runway-dubbing",
    # BytePlus ModelArk: Seedream (execution/maker_routes_byteplus.py).
    "seedream-4-5", "krea-image-bytedance-seedream-4", "krea-image-bytedance-seedream-5-lite",
    "krea-image-bytedance-seedream-5-pro",
    # Seedance on BytePlus ModelArk (execution/maker_routes_byteplus_seedance.py).
    "seedance-2-t2v", "seedance-2-i2v", "seedance-2-r2v", "seedance-2-fast-t2v", "seedance-2-fast-i2v",
    "seedance-v1-5", "seedance-1-0-t2v", "krea-video-bytedance-seedance-1-0-pro",
    "krea-video-bytedance-seedance-1-0-pro-fast", "krea-video-bytedance-seedance-2",
    "krea-video-bytedance-seedance-2-fast", "krea-video-bytedance-seedance-2-mini",
    "krea-video-bytedance-seedance-2-5",
}


def _client(json_body):
    response = MagicMock()
    response.status_code = 200
    response.json.return_value = json_body
    client = AsyncMock()
    client.post.return_value = response
    client.__aenter__.return_value = client
    client.__aexit__.return_value = False
    return client


def _gemini_client():
    return _client({"candidates": [{"content": {"parts": [
        {"inlineData": {"mimeType": "image/png", "data": RED_PIXEL_B64}}]}}]})


async def _run(node, inputs, keys):
    return await get_handler_registry(emit=AsyncMock())[node.definition_id](node, inputs, keys)


def _fal_defaults(definition_id):
    definition = DEFINITIONS[definition_id]
    return {p["key"]: p["default"] for name in ("sharedParams", "falParams", "directParams")
            for p in definition.get(name) or [] if "default" in p}


def test_every_maker_routed_node_has_a_router():
    registry = get_handler_registry(emit=AsyncMock())
    # Route-table routers say dual_route too; test_every_route_table_node_has_a_multi_router has them.
    routed = {node_id for node_id, handler in registry.items()
              if getattr(handler, "dual_route", False) and not getattr(handler, "multi_route", False)}
    assert routed == MAKER_ROUTED
    for node_id in MAKER_ROUTED:
        assert node_route.direct_keys(DEFINITIONS[node_id]), node_id


@pytest.mark.asyncio
async def test_nano_banana_fal_runs_on_google_with_the_maker_key_and_translates():
    params = {**_fal_defaults("nano-banana-fal"), "model": "nano-banana-2", "aspect_ratio": "4:1",
              "resolution": "2K", "thinking_level": "high", "enable_web_search": True, "seed": 7,
              "output_format": "jpeg"}
    node = GraphNode(id="n", definitionId="nano-banana-fal", params=params)
    before = copy.deepcopy(node.params)
    client = _gemini_client()
    # One httpx module serves both handlers: the only call made is Google's.
    with patch("handlers.google_gemini.httpx.AsyncClient", return_value=client):
        result = await _run(node, PROMPT, {**GOOGLE, **FAL})
    assert client.post.call_count == 1
    assert node.params == before
    assert result["image"]["type"] == "Image"
    url = client.post.call_args.args[0]
    body = client.post.call_args.kwargs["json"]
    assert "models/gemini-3.1-flash-image:generateContent" in url
    config = body["generationConfig"]
    assert config["imageConfig"] == {"aspectRatio": "4:1", "imageSize": "2K"}
    assert config["thinkingConfig"] == {"thinkingLevel": "HIGH"}
    assert body["tools"] == [{"googleSearch": {}}]
    # fal-only params never reach Google.
    assert "seed" not in str(body) and "jpeg" not in str(body)


@pytest.mark.asyncio
async def test_nano_banana_fal_num_images_makes_that_many_google_calls():
    node = GraphNode(id="n", definitionId="nano-banana-fal",
                     params={**_fal_defaults("nano-banana-fal"), "model": "nano-banana-pro", "num_images": 3,
                             "aspect_ratio": "1:8", "resolution": "0.5K", "thinking_level": "high"})
    client = _gemini_client()
    with patch("handlers.google_gemini.httpx.AsyncClient", return_value=client):
        await _run(node, PROMPT, GOOGLE)
    assert client.post.call_count == 3
    body = client.post.call_args.kwargs["json"]
    assert "models/gemini-3-pro-image:generateContent" in client.post.call_args.args[0]
    # Pro: an extreme ratio is omitted (fal sends 'auto'), no thinking control.
    assert "aspectRatio" not in body["generationConfig"].get("imageConfig", {})
    assert "thinkingConfig" not in body["generationConfig"]


@pytest.mark.parametrize("fal_model,expected", [
    ("nano-banana", {"model": "gemini-2.5-flash-image", "aspect_ratio": "1:1", "num_images": 1}),
    ("nano-banana-2", {"model": "gemini-3.1-flash-image", "num_images": 1}),
])
def test_translation_drops_settings_a_model_ignores(fal_model, expected):
    aspect = "1:4" if fal_model == "nano-banana" else "auto"
    node = GraphNode(id="n", definitionId="nano-banana-fal", params={
        "model": fal_model, "aspect_ratio": aspect, "resolution": "4K" if fal_model == "nano-banana" else "",
        "thinking_level": "", "enable_web_search": False, "num_images": 1})
    routed, _ = maker_routes.nano_banana_fal_to_google(node, {})
    assert routed.params == expected


def test_translation_refuses_an_unknown_model():
    node = GraphNode(id="n", definitionId="nano-banana-fal", params={"model": "nano-banana-9"})
    with pytest.raises(ValueError, match="no Gemini API route"):
        maker_routes.nano_banana_fal_to_google(node, {})


@pytest.mark.asyncio
async def test_nano_banana_fal_stays_on_fal_without_the_maker_key():
    params = {**_fal_defaults("nano-banana-fal-edit"), "model": "nano-banana-2", "seed": 3}
    node = GraphNode(id="n", definitionId="nano-banana-fal-edit", params=params)
    before = copy.deepcopy(node.params)
    client = _client({"images": [{"url": "https://example.com/out.png"}]})
    inputs = {**PROMPT, "images": PortValueDict(type="Image", value=["https://example.com/in.png"])}
    with patch("handlers.fal_universal.httpx.AsyncClient", return_value=client):
        result = await _run(node, inputs, {**FAL, "GOOGLE_API_KEY": "  "})
    assert client.post.call_count == 1
    assert node.params == before
    assert result["image"]["value"] == "https://example.com/out.png"
    assert client.post.call_args.args[0] == "https://queue.fal.run/fal-ai/nano-banana-2/edit"
    body = client.post.call_args.kwargs["json"]
    assert body["seed"] == 3
    assert set(body) <= {"prompt", "image_urls", *node_route.route_param_keys(
        DEFINITIONS["nano-banana-fal-edit"], node_route.FALLBACK)} - {"model"}


@pytest.mark.asyncio
async def test_a_dual_route_node_with_no_key_names_every_key():
    node = GraphNode(id="n", definitionId="nano-banana-fal", params={})
    with pytest.raises(MissingCredentialError, match="GOOGLE_API_KEY or FAL_KEY"):
        await _run(node, PROMPT, {})


@pytest.mark.asyncio
async def test_meshy_on_fal_gets_no_direct_only_params():
    """fal used to receive ai_model, hd_texture, remove_lighting and target_formats."""
    definition = DEFINITIONS["meshy-text-to-3d"]
    params = _fal_defaults("meshy-text-to-3d")
    direct_only = {p["key"] for p in definition.get("directParams") or []}
    assert direct_only & set(params), "the test needs a direct-only default"
    node = GraphNode(id="n", definitionId="meshy-text-to-3d", params=params)
    before = copy.deepcopy(node.params)
    client = _client({"model_mesh": {"url": "https://example.com/m.glb"}})
    with patch("handlers.fal_universal.httpx.AsyncClient", return_value=client):
        try:
            await _run(node, PROMPT, FAL)
        except Exception:  # noqa: BLE001 - only the outgoing request matters here
            pass
    assert node.params == before
    body = client.post.call_args.kwargs["json"]
    assert "meshy/v6/text-to-3d" in client.post.call_args.args[0]
    assert not direct_only & set(body)


@pytest.mark.asyncio
async def test_meshy_direct_gets_no_fal_only_params():
    definition = DEFINITIONS["meshy-image-to-3d"]
    fal_only = {p["key"] for p in definition.get("falParams") or []}
    seen = {}

    async def fake_direct(node, inputs, api_keys, emit=None):
        seen.update(node.params)
        return {"model": {"type": "Mesh", "value": "x.glb"}}

    node = GraphNode(id="n", definitionId="meshy-image-to-3d", params=_fal_defaults("meshy-image-to-3d"))
    with patch("handlers.meshy.handle_meshy_image_to_3d", fake_direct):
        await _run(node, {}, {"MESHY_API_KEY": "fixture-meshy", **FAL})
    assert seen and not fal_only & set(seen)


@pytest.mark.asyncio
async def test_krea_copy_runs_on_google_with_the_maker_key():
    node = GraphNode(id="k", definitionId="krea-image-google-nano-banana-2", params={
        "_kreaAuth": "api-token", "aspect_ratio": "16:9", "resolution": "4K", "width": None, "height": "",
        "image_urls": '["https://example.com/ref.png"]'})
    before = copy.deepcopy(node.params)
    client = _gemini_client()
    gateway = AsyncMock()
    with patch("handlers.google_gemini.httpx.AsyncClient", return_value=client), \
            patch("handlers.krea_gateway.handle_krea_gateway", gateway):
        result = await _run(node, PROMPT, {**GOOGLE, **KREA})
    gateway.assert_not_called()
    assert node.params == before
    assert set(result) == {"image", "images", "artifacts"}
    url = client.post.call_args.args[0]
    body = client.post.call_args.kwargs["json"]
    assert "models/gemini-3.1-flash-image:generateContent" in url
    assert body["generationConfig"]["imageConfig"] == {"aspectRatio": "16:9", "imageSize": "4K"}
    # The reference goes to Google as a public HTTPS URL (fileData.fileUri).
    assert {"fileData": {"fileUri": "https://example.com/ref.png"}} in body["contents"][0]["parts"]


@pytest.mark.asyncio
async def test_krea_plan_wins_over_a_maker_key_and_krea_gets_its_own_params():
    seen = {}

    async def gateway(node, inputs, api_keys, emit=None):
        seen.update(node.params)
        return {"image": {"type": "Image", "value": "https://example.com/k.png"}}

    params = {"_kreaAuth": "mcp", "aspect_ratio": "1:1", "width": 512, "height": 512, "resolution": "1K"}
    node = GraphNode(id="k", definitionId="krea-image-google-nano-banana-pro", params=params)
    with patch("handlers.krea_gateway.handle_krea_gateway", gateway), \
            patch("handlers.google_gemini.httpx.AsyncClient") as google:
        await _run(node, PROMPT, {**GOOGLE, **KREA})
    google.assert_not_called()
    assert seen == params


@pytest.mark.asyncio
async def test_an_explicit_krea_size_keeps_the_run_on_krea():
    """Google can't render an exact width/height; dropping them on the direct
    route would silently change a saved 16:9 recipe to Google's default."""
    seen = {}

    async def gateway(node, inputs, api_keys, emit=None):
        seen.update(node.params)
        return {"image": {"type": "Image", "value": "https://example.com/k.png"}}

    params = {"_kreaAuth": "api-token", "prompt": "p", "width": 1920, "height": 1080, "resolution": "2K"}
    node = GraphNode(id="k", definitionId="krea-image-google-nano-banana-2", params=params)
    with patch("handlers.krea_gateway.handle_krea_gateway", gateway), \
            patch("handlers.google_gemini.httpx.AsyncClient") as google:
        await _run(node, PROMPT, {**GOOGLE, **KREA})
    google.assert_not_called()
    assert seen["width"] == 1920 and seen["height"] == 1080
    # Without the Krea token there is no route that honors the size.
    with pytest.raises(MissingCredentialError):
        await _run(node, PROMPT, GOOGLE)


@pytest.mark.asyncio
@pytest.mark.parametrize("today,on_google", [("2027-03-14", True), ("2027-03-15", False)])
async def test_nano_banana_25_leaves_google_on_its_shutdown_date(monkeypatch, today, on_google):
    monkeypatch.setattr(node_route, "_today", lambda: today)
    fal = AsyncMock(return_value={"image": {"type": "Image", "value": "https://example.com/f.png"}})
    client = _gemini_client()
    node = GraphNode(id="n", definitionId="nano-banana-fal", params={"model": "nano-banana", "num_images": 1})
    with patch("handlers.google_gemini.httpx.AsyncClient", return_value=client), \
            patch("handlers.fal_universal.handle_fal_universal", fal):
        await _run(node, PROMPT, {**GOOGLE, **FAL})
    assert client.post.called is on_google
    assert fal.called is not on_google


def test_retired_direct_routes_cover_every_route_to_the_retiring_model():
    """DIRECT_RETIRES names every saved choice that calls gemini-2.5-flash-image."""
    fal_values = sorted(value for value, model in maker_routes.NANO_BANANA_FAL_GOOGLE_MODELS.items()
                        if model == maker_routes.GEMINI_25_FLASH_IMAGE)
    for node_id in ("nano-banana-fal", "nano-banana-fal-edit"):
        assert sorted(node_route.DIRECT_RETIRES[node_id]["values"]) == fal_values
    krea = {node_id for node_id, definition in DEFINITIONS.items()
            if (definition.get("directRoute") or {}).get("model") == maker_routes.GEMINI_25_FLASH_IMAGE}
    assert krea and krea <= set(node_route.DIRECT_RETIRES)
    assert {node_route.DIRECT_RETIRES[node_id]["on"] for node_id in ("nano-banana-fal", "nano-banana-fal-edit", *krea)} == {
        "2027-03-15"}


@pytest.mark.asyncio
async def test_meshy_direct_gets_a_saved_texture_prompt():
    """Meshy's own API takes texture_prompt ("Provide a text prompt to guide the
    texturing process", docs.meshy.ai/en/api/image-to-3d), so both routes send it."""
    seen = {}

    async def fake_direct(node, inputs, api_keys, emit=None):
        seen.update(node.params)
        return {"model": {"type": "Mesh", "value": "x.glb"}}

    params = {"texture_prompt": "red brick", "topology": "quad", "ai_model": "latest", "seed": 7}
    node = GraphNode(id="n", definitionId="meshy-image-to-3d", params=params)
    with patch("handlers.meshy.handle_meshy_image_to_3d", fake_direct):
        await _run(node, {}, {"MESHY_API_KEY": "fixture-meshy", **FAL})
    assert seen == {"texture_prompt": "red brick", "topology": "quad", "ai_model": "latest"}


@pytest.mark.asyncio
async def test_krea_copy_stays_on_krea_without_the_maker_key():
    gateway = AsyncMock(return_value={"image": {"type": "Image", "value": "https://example.com/k.png"}})
    node = GraphNode(id="k", definitionId="krea-image-google-nano-banana", params={"aspect_ratio": "1:1"})
    with patch("handlers.krea_gateway.handle_krea_gateway", gateway):
        await _run(node, PROMPT, KREA)
    gateway.assert_awaited_once()


def test_krea_translation_reads_prompt_and_references_from_params_when_unwired():
    translate = maker_routes.krea_nano_banana_to_google("gemini-3.1-flash-lite-image")
    node = GraphNode(id="k", definitionId="krea-image-google-nano-banana-flash-lite", params={
        "prompt": "from params", "image_urls": '["https://example.com/a.png", ""]',
        "aspect_ratio": "3:2", "resolution": "2K"})
    routed, inputs = translate(node, {})
    # Flash-Lite is 1K only: no imageSize.
    assert routed.params == {"model": "gemini-3.1-flash-lite-image", "aspect_ratio": "3:2"}
    assert inputs["prompt"].value == "from params"
    assert inputs["images"].value == ["https://example.com/a.png"]


def test_route_node_copies_and_never_shares_values():
    node = GraphNode(id="n", definitionId="nano-banana-fal", params={"a": [1], "b": 2})
    routed = maker_routes.route_node(node, {"a"})
    routed.params["a"].append(9)
    assert node.params == {"a": [1], "b": 2} and routed.params == {"a": [1, 9]}


# -- route-table nodes (definition `routes`, maker_routes.multi_route) ----------

import json  # noqa: E402
from pathlib import Path  # noqa: E402

ROUTE_FIXTURES = json.loads((Path(__file__).parent / "fixtures" / "route_cases.json").read_text())["definitions"]
# Route-table nodes in the registry (routing series PR 3).
MULTI_ROUTED: set[str] = {
    "flux-3-image", "flux-3-image-klein", "flux-3-image-klein-base", "flux-3-video", "flux-video-edit",
    "flux-video-upscale", "krea-3",
    # PR 4: FLUX.2 (BFL first, then the fal route it always ran on).
    "flux-2-pro",
}


def test_every_route_table_node_has_a_multi_router():
    registry = get_handler_registry(emit=AsyncMock())
    multi = {node_id for node_id, handler in registry.items() if getattr(handler, "multi_route", False)}
    assert multi == MULTI_ROUTED == {node_id for node_id, d in DEFINITIONS.items() if node_route.has_routes(d)}


def _clients(*route_ids):
    """A stub client per route id: records the node it got, returns an image."""
    return {route_id: AsyncMock(return_value={"image": {"type": "Image", "value": f"{route_id}.png"}})
            for route_id in route_ids}


@pytest.fixture
def route_fixtures(monkeypatch):
    monkeypatch.setattr(maker_routes, "definition_for", lambda definition_id: ROUTE_FIXTURES[definition_id])
    return ROUTE_FIXTURES


IMAGE_ROUTES = ("bfl", "fal", "replicate", "openrouter", "krea")
IMAGE_DEFAULTS = {"_provider": "auto", "_kreaAuth": "api-token", "aspect_ratio": "auto", "resolution": "1k",
                  "safety_tolerance": 2, "grounding": False}


@pytest.mark.asyncio
async def test_multi_route_runs_auto_on_the_maker_with_only_its_params(route_fixtures):
    clients = _clients(*IMAGE_ROUTES)
    node = GraphNode(id="n", definitionId="routes-image", params=dict(IMAGE_DEFAULTS))
    before = copy.deepcopy(node.params)
    result = await maker_routes.multi_route(clients)(node, PROMPT, {"BFL_API_KEY": "b", "FAL_KEY": "f"})
    assert result["image"]["value"] == "bfl.png"
    sent = clients["bfl"].await_args.args[0]
    # The billing params never reach a provider; another route's never either.
    assert sent.params == {"aspect_ratio": "auto", "resolution": "1k", "safety_tolerance": 2, "grounding": False}
    assert all(not clients[other].await_count for other in IMAGE_ROUTES if other != "bfl")
    assert node.params == before


@pytest.mark.asyncio
async def test_multi_route_honors_an_explicit_choice_and_translates_values(route_fixtures):
    clients = _clients(*IMAGE_ROUTES)
    node = GraphNode(id="n", definitionId="routes-image",
                     params={**IMAGE_DEFAULTS, "_provider": "fal", "resolution": "768sq"})
    await maker_routes.multi_route(clients)(node, PROMPT, {"BFL_API_KEY": "b", "FAL_KEY": "f"})
    assert not clients["bfl"].await_count
    sent = clients["fal"].await_args.args[0]
    # fal's own value for 768sq (its valueMap); BFL-and-Replicate-only grounding dropped.
    assert sent.params == {"aspect_ratio": "auto", "resolution": "square", "safety_tolerance": 2}


@pytest.mark.asyncio
async def test_an_explicit_choice_with_a_missing_key_names_only_that_key(route_fixtures):
    clients = _clients(*IMAGE_ROUTES)
    node = GraphNode(id="n", definitionId="routes-image", params={**IMAGE_DEFAULTS, "_provider": "replicate"})
    with pytest.raises(MissingCredentialError) as raised:
        await maker_routes.multi_route(clients)(node, PROMPT, {"BFL_API_KEY": "b", "FAL_KEY": "f"})
    message = str(raised.value)
    assert "set to Replicate, which needs REPLICATE_API_TOKEN" in message
    assert "BFL_API_KEY" not in message and "FAL_KEY" not in message
    assert not any(client.await_count for client in clients.values())


@pytest.mark.asyncio
async def test_auto_stops_on_a_block_instead_of_billing_another_provider(route_fixtures):
    clients = _clients(*IMAGE_ROUTES)
    node = GraphNode(id="n", definitionId="routes-image", params={**IMAGE_DEFAULTS, "resolution": "1.5k"})
    with pytest.raises(MissingCredentialError, match="can't run on fal.ai: it doesn't take resolution 1.5k"):
        await maker_routes.multi_route(clients)(node, PROMPT, {"FAL_KEY": "f", "REPLICATE_API_TOKEN": "r"})
    assert not any(client.await_count for client in clients.values())


@pytest.mark.asyncio
async def test_wired_inputs_count_against_a_routes_port_limit(route_fixtures):
    clients = _clients(*IMAGE_ROUTES)
    node = GraphNode(id="n", definitionId="routes-image", params={**IMAGE_DEFAULTS, "_provider": "openrouter"})
    five = {**PROMPT, "images": PortValueDict(type="Image", value=[f"{i}.png" for i in range(5)])}
    with pytest.raises(MissingCredentialError, match="at most 4 wired images"):
        await maker_routes.multi_route(clients)(node, five, {"OPENROUTER_API_KEY": "o"})
    four = {**PROMPT, "images": PortValueDict(type="Image", value=[f"{i}.png" for i in range(4)])}
    await maker_routes.multi_route(clients)(node, four, {"OPENROUTER_API_KEY": "o"})
    assert clients["openrouter"].await_count == 1


@pytest.mark.asyncio
async def test_a_krea_route_gets_the_billing_mode_explicitly(route_fixtures):
    clients = _clients(*IMAGE_ROUTES)
    router = maker_routes.multi_route(clients)
    plan = GraphNode(id="n", definitionId="routes-image", params={**IMAGE_DEFAULTS, "_provider": "krea", "_kreaAuth": "mcp"})
    await router(plan, PROMPT, {})
    assert clients["krea"].await_args.args[0].params["_kreaAuth"] == "mcp"
    token = GraphNode(id="n", definitionId="routes-image", params={**IMAGE_DEFAULTS, "_provider": "krea"})
    await router(token, PROMPT, {"KREA_API_TOKEN": "k"})
    assert clients["krea"].await_args.args[0].params["_kreaAuth"] == "api-token"
    assert "_provider" not in clients["krea"].await_args.args[0].params


@pytest.mark.asyncio
async def test_rename_sends_a_route_prefixed_param_under_the_providers_name(route_fixtures):
    clients = _clients("krea", "fal")
    node = GraphNode(id="n", definitionId="routes-krea",
                     params={"_provider": "fal", "resolution": "2K", "fal_seed": 7, "thinking_mode": "high"})
    await maker_routes.multi_route(clients)(node, PROMPT, {"FAL_KEY": "f"})
    assert clients["fal"].await_args.args[0].params == {"resolution": "2K", "seed": 7}


@pytest.mark.asyncio
async def test_multi_route_tells_the_client_the_endpoint_for_its_wired_ports(route_fixtures):
    clients = _clients(*IMAGE_ROUTES)
    node = GraphNode(id="n", definitionId="routes-image", params={**IMAGE_DEFAULTS, "_provider": "fal"})
    router = maker_routes.multi_route(clients)
    await router(node, PROMPT, {"FAL_KEY": "f"})
    assert clients["fal"].await_args.kwargs["endpoint"] == "blackforestlabs/flux-3/text-to-image"
    wired = {**PROMPT, "images": PortValueDict(type="Image", value=["a.png"])}
    await router(node, wired, {"FAL_KEY": "f"})
    # endpointWhen reads our names and the wired ports, before translation.
    assert clients["fal"].await_args.kwargs["endpoint"] == "blackforestlabs/flux-3/edit-image"


@pytest.mark.asyncio
async def test_register_route_nodes_builds_a_router_from_the_route_clients(route_fixtures, monkeypatch):
    from execution import route_clients

    run = AsyncMock(return_value={"image": {"type": "Image", "value": "x.png"}})
    monkeypatch.setattr(route_clients, "ROUTE_CLIENTS", {"fal": route_clients.RouteClient(run)})
    registry: dict = {"routes-image": object()}
    route_clients.register_route_nodes(registry, {**DEFINITIONS, **ROUTE_FIXTURES}, emit="emit")
    handler = registry["routes-image"]
    assert handler.multi_route and handler.dual_route
    assert {node_id for node_id, h in registry.items() if getattr(h, "multi_route", False)} == \
        set(ROUTE_FIXTURES) | MULTI_ROUTED
    node = GraphNode(id="n", definitionId="routes-image", params={**IMAGE_DEFAULTS, "_provider": "fal"})
    await handler(node, PROMPT, {"FAL_KEY": "f"})
    assert run.await_args.kwargs["route"]["id"] == "fal" and run.await_args.kwargs["emit"] == "emit"
    # A route whose client hasn't landed fails before any provider request.
    with pytest.raises(MissingCredentialError, match="can't run on Black Forest Labs in this version"):
        await handler(node.model_copy(update={"params": {**IMAGE_DEFAULTS, "_provider": "bfl"}}),
                      PROMPT, {"BFL_API_KEY": "b"})


def test_translate_params_renames_then_maps_values():
    route = {"rename": {"resolution": "image_size", "fal_seed": "seed"},
             "valueMap": {"resolution": {"1k": "square_hd"}, "draft": {"true": "on"}}}
    assert maker_routes.translate_params(route, {"resolution": "1k", "fal_seed": 3, "draft": True, "x": 1}) == {
        "image_size": "square_hd", "seed": 3, "draft": "on", "x": 1}
