"""Google lane of the direct maker routes (execution/maker_routes_google.py).

Only the transport is mocked: no provider is contacted and nothing is billed.
identity-edit and the Krea Nano Banana 2.1 / Veo 3.1 / Gemini Omni Flash 1.1
copies run on Google's own API when the person's Google key is set (Vertex for
Veo), on the copy otherwise, and on the Krea plan when it's chosen.
"""
from __future__ import annotations

import copy
from unittest.mock import AsyncMock, MagicMock, patch

import pytest

from execution import maker_routes_google
from execution.sync_runner import get_handler_registry
from models.graph import GraphNode, PortValueDict
from services import node_route
from services.node_registry import NodeRegistry

DEFINITIONS = NodeRegistry().get_all()
PNG_B64 = ("iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk"
           "+M8AAAMBAQDJ/pLvAAAAAElFTkSuQmCC")
PNG_DATA_URI = f"data:image/png;base64,{PNG_B64}"
GOOGLE = {"GOOGLE_API_KEY": "fixture-google"}
VERTEX = {"GOOGLE_VERTEX_CREDENTIALS": "{}"}
FAL = {"FAL_KEY": "fixture-fal"}
KREA = {"KREA_API_TOKEN": "fixture-krea"}
PROMPT = {"prompt": PortValueDict(type="Text", value="a lighthouse at dusk")}
BASE_IMAGE = "https://cdn.example.com/base.png"
REF_VIEWS = ["https://cdn.example.com/front.png", "https://cdn.example.com/side.png"]


def _client(json_body):
    response = MagicMock()
    response.status_code = 200
    response.json.return_value = json_body
    client = AsyncMock()
    client.post.return_value = response
    client.__aenter__.return_value = client
    client.__aexit__.return_value = False
    return client


async def _run(node, inputs, keys, emit=None):
    return await get_handler_registry(emit=emit or AsyncMock())[node.definition_id](node, inputs, keys)


def _defaults(definition_id):
    definition = DEFINITIONS[definition_id]
    return {p["key"]: p["default"] for name in ("sharedParams", "falParams", "directParams")
            for p in definition.get(name) or [] if "default" in p}


# -- identity-edit ---------------------------------------------------------------

def _gemini_image_client():
    return _client({"candidates": [{"content": {"parts": [
        {"inlineData": {"mimeType": "image/png", "data": PNG_B64}}]}}]})


def _bundle():
    return {"characterId": "c1", "name": "Nari", "referenceViews": list(REF_VIEWS),
            "frozenTraitString": "Nari, copper hair", "seed": 42, "consistencyStrength": 0.7}


@pytest.mark.asyncio
async def test_identity_edit_runs_on_gemini_with_the_google_key():
    node = GraphNode(id="i", definitionId="identity-edit",
                     params={**_defaults("identity-edit"), "resolution": "2048", "thinking_level": "medium",
                             "seed": 7})
    before = copy.deepcopy(node.params)
    inputs = {"image": PortValueDict(type="Image", value=BASE_IMAGE),
              "prompt": PortValueDict(type="Text", value="put her on a beach"),
              "character": PortValueDict(type="Character", value=_bundle())}
    client = _gemini_image_client()
    fal = AsyncMock()
    # One httpx module serves both handlers, so fal's handler itself is the spy.
    with patch("handlers.google_gemini.httpx.AsyncClient", return_value=client), \
            patch("handlers.fal_universal.handle_fal_universal", fal):
        result = await _run(node, inputs, {**GOOGLE, **FAL})
    fal.assert_not_called()
    assert node.params == before
    assert result["image"]["type"] == "Image"
    assert client.post.call_count == 1
    assert "models/gemini-3.1-flash-image:generateContent" in client.post.call_args.args[0]
    body = client.post.call_args.kwargs["json"]
    parts = body["contents"][0]["parts"]
    # The trait string leads the prompt; base image first, Character views after.
    assert parts[0]["text"].startswith("Nari, copper hair")
    assert [p["fileData"]["fileUri"] for p in parts[1:]] == [BASE_IMAGE, *REF_VIEWS]
    assert body["generationConfig"]["imageConfig"] == {"imageSize": "2K"}
    assert body["generationConfig"]["thinkingConfig"] == {"thinkingLevel": "HIGH"}
    # No image seed on the Gemini API; strength has no equivalent anywhere.
    assert "seed" not in str(body) and "identity_strength" not in str(body)


@pytest.mark.asyncio
async def test_identity_edit_refuses_a_mask_on_the_google_route_too():
    inputs = {"image": PortValueDict(type="Image", value=BASE_IMAGE), **PROMPT,
              "mask": PortValueDict(type="Mask", value="https://cdn.example.com/mask.png")}
    with patch("handlers.google_gemini.httpx.AsyncClient") as google:
        with pytest.raises(ValueError, match="does not support masks"):
            await _run(GraphNode(id="i", definitionId="identity-edit", params={}), inputs, GOOGLE)
    google.assert_not_called()


@pytest.mark.asyncio
async def test_identity_edit_stays_on_fal_without_the_google_key():
    fal = AsyncMock(return_value={"image": {"type": "Image", "value": "https://fal.ai/out.png"}})
    node = GraphNode(id="i", definitionId="identity-edit", params={"resolution": "1024", "seed": 7})
    inputs = {"image": PortValueDict(type="Image", value=BASE_IMAGE), **PROMPT}
    with patch("handlers.fal_universal.handle_fal_universal", fal), \
            patch("handlers.google_gemini.httpx.AsyncClient") as google:
        await _run(node, inputs, {**FAL, "GOOGLE_API_KEY": " "})
    google.assert_not_called()
    sent = fal.call_args.args[0].params
    assert sent["endpoint_id"] == "fal-ai/nano-banana-2/edit"
    assert sent["resolution"] == "1K" and sent["seed"] == 7


# -- Krea Nano Banana 2.1 ---------------------------------------------------------

def _interaction_client():
    return _client({"steps": [{"type": "model_output", "content": [
        {"type": "image", "mime_type": "image/png", "data": PNG_B64}]}]})


@pytest.mark.asyncio
async def test_krea_nano_banana_21_runs_on_the_interactions_api_with_thinking():
    node = GraphNode(id="k", definitionId="krea-image-google-nano-banana-2-1", params={
        "_kreaAuth": "api-token", "aspect_ratio": "4:1", "resolution": "2K", "thinking_level": "high",
        "image_urls": '["https://example.com/ref.png"]'})
    client = _interaction_client()
    gateway = AsyncMock()
    with patch("handlers.google_gemini.httpx.AsyncClient", return_value=client), \
            patch("handlers.krea_gateway.handle_krea_gateway", gateway):
        result = await _run(node, PROMPT, {**GOOGLE, **KREA})
    gateway.assert_not_called()
    assert set(result) == {"image", "images", "artifacts"}
    assert client.post.call_args.args[0].endswith("/v1beta/interactions")
    body = client.post.call_args.kwargs["json"]
    assert body["model"] == "gemini-nano-banana-2.1"
    assert body["response_format"] == {"type": "image", "aspect_ratio": "4:1", "image_size": "2K"}
    assert body["generation_config"] == {"thinking_level": "high"}
    assert {"type": "image", "uri": "https://example.com/ref.png"} in body["input"]


@pytest.mark.asyncio
async def test_krea_nano_banana_21_default_sends_googles_default_thinking():
    node = GraphNode(id="k", definitionId="krea-image-google-nano-banana-2-1",
                     params=_defaults("krea-image-google-nano-banana-2-1"))
    client = _interaction_client()
    with patch("handlers.google_gemini.httpx.AsyncClient", return_value=client):
        await _run(node, PROMPT, GOOGLE)
    body = client.post.call_args.kwargs["json"]
    assert body["generation_config"] == {"thinking_level": "medium"}
    assert body["response_format"]["image_size"] == "1K"


@pytest.mark.asyncio
async def test_krea_nano_banana_21_with_a_size_stays_on_krea():
    gateway = AsyncMock(return_value={"image": {"type": "Image", "value": "https://example.com/k.png"}})
    node = GraphNode(id="k", definitionId="krea-image-google-nano-banana-2-1",
                     params={"_kreaAuth": "api-token", "width": 1920, "height": 1080})
    with patch("handlers.krea_gateway.handle_krea_gateway", gateway), \
            patch("handlers.google_gemini.httpx.AsyncClient") as google:
        await _run(node, PROMPT, {**GOOGLE, **KREA})
    google.assert_not_called()
    gateway.assert_awaited_once()


# -- Krea Veo 3.1 on Vertex ---------------------------------------------------------

class _Resp:
    def __init__(self, payload):
        self.status_code = 200
        self._payload = payload
        self.text = str(payload)

    def json(self):
        return self._payload


class _VertexMock:
    def __init__(self):
        self.posts = []

    async def __aenter__(self):
        return self

    async def __aexit__(self, *exc):
        return False

    async def post(self, url, json=None, headers=None):
        self.posts.append({"url": url, "json": json})
        if url.endswith(":fetchPredictOperation"):
            return _Resp({"done": True, "response": {"videos": [
                {"bytesBase64Encoded": "RkFLRU1QNA==", "mimeType": "video/mp4"}]}})
        return _Resp({"name": "projects/p/locations/us-central1/publishers/google/models/m/operations/op1"})


def _vertex(mock):
    return (patch("handlers.veo.httpx.AsyncClient", return_value=mock),
            patch("handlers.veo.asyncio.sleep", new=AsyncMock()),
            patch("handlers.veo.access_token", new=AsyncMock(return_value=("tok", "my-proj"))))


@pytest.mark.asyncio
async def test_krea_veo_runs_on_vertex_with_audio_resolution_and_references():
    node = GraphNode(id="v", definitionId="krea-video-google-veo-3-1", params={
        **_defaults("krea-video-google-veo-3-1"), "generate_audio": True, "resolution": "1080p",
        "aspect_ratio": "9:16", "reference_images": f'["{PNG_DATA_URI}"]'})
    before = copy.deepcopy(node.params)
    mock = _VertexMock()
    gateway = AsyncMock()
    emit = AsyncMock()
    a, b, c = _vertex(mock)
    with a, b, c, patch("handlers.krea_gateway.handle_krea_gateway", gateway):
        result = await _run(node, PROMPT, {**VERTEX, **GOOGLE, **KREA}, emit=emit)
    gateway.assert_not_called()
    assert node.params == before
    assert set(result) == {"video", "videos", "artifacts"}
    submit = mock.posts[0]
    assert submit["url"].endswith("/publishers/google/models/veo-3.1-generate-001:predictLongRunning")
    instance = submit["json"]["instances"][0]
    assert instance["prompt"] == "a lighthouse at dusk"
    assert instance["referenceImages"] == [
        {"image": {"bytesBase64Encoded": PNG_B64, "mimeType": "image/png"}, "referenceType": "asset"}]
    assert submit["json"]["parameters"] == {"aspectRatio": "9:16", "durationSeconds": 8, "resolution": "1080p",
                                            "generateAudio": True, "sampleCount": 1}
    assert emit.await_count >= 1, "the Vertex poll reports progress"


@pytest.mark.asyncio
async def test_krea_veo_frames_and_4k_and_default_silence():
    node = GraphNode(id="v", definitionId="krea-video-google-veo-3-1", params={
        **_defaults("krea-video-google-veo-3-1"), "resolution": "4K", "duration": 6,
        "start_image": PNG_DATA_URI})
    inputs = {**PROMPT, "end_image": PortValueDict(type="Image", value=PNG_DATA_URI)}
    mock = _VertexMock()
    a, b, c = _vertex(mock)
    with a, b, c:
        await _run(node, inputs, VERTEX)
    instance = mock.posts[0]["json"]["instances"][0]
    assert set(instance) == {"prompt", "image", "lastFrame"}
    parameters = mock.posts[0]["json"]["parameters"]
    # Krea's generate_audio defaults to false; Vertex requires the field for Veo 3.
    assert parameters["generateAudio"] is False
    assert parameters["resolution"] == "4k" and parameters["durationSeconds"] == 6


@pytest.mark.asyncio
@pytest.mark.parametrize("params,inputs,message", [
    ({"duration": 4, "reference_images": f'["{PNG_DATA_URI}"]'}, {}, "8-second"),
    ({"reference_images": f'["{PNG_DATA_URI}"]', "resolution": "4K"}, {}, "4K with reference images"),
    ({"reference_images": f'["{PNG_DATA_URI}"]'}, {"start_image": PNG_DATA_URI}, "own mode"),
    ({"reference_images": "[" + ",".join([f'"{PNG_DATA_URI}"'] * 4) + "]"}, {}, "up to 3"),
    ({}, {"end_image": PNG_DATA_URI}, "start image too"),
])
async def test_krea_veo_refuses_what_vertex_documents_it_cant_do(params, inputs, message):
    node = GraphNode(id="v", definitionId="krea-video-google-veo-3-1",
                     params={**_defaults("krea-video-google-veo-3-1"), **params})
    wired = {**PROMPT, **{k: PortValueDict(type="Image", value=v) for k, v in inputs.items()}}
    mock = _VertexMock()
    a, b, c = _vertex(mock)
    with a, b, c:
        with pytest.raises(ValueError, match=message):
            await _run(node, wired, VERTEX)
    assert mock.posts == []


@pytest.mark.asyncio
async def test_krea_veo_fast_at_4k_stays_on_krea():
    """Vertex lists Fast at 720p and 1080p only."""
    gateway = AsyncMock(return_value={"video": {"type": "Video", "value": "https://example.com/k.mp4"}})
    params = {**_defaults("krea-video-google-veo-3-1-fast"), "resolution": "4K"}
    node = GraphNode(id="v", definitionId="krea-video-google-veo-3-1-fast", params=params)
    with patch("handlers.krea_gateway.handle_krea_gateway", gateway), patch("handlers.veo.httpx.AsyncClient") as v:
        await _run(node, PROMPT, {**VERTEX, **KREA})
    v.assert_not_called()
    assert gateway.call_args.args[0].params["resolution"] == "4K"
    block = node_route.direct_block(DEFINITIONS["krea-video-google-veo-3-1-fast"], params)
    assert block == node_route.DirectBlock(node_route.UNSUPPORTED, "resolution")


@pytest.mark.asyncio
async def test_krea_veo_fast_and_lite_run_on_vertex():
    for node_id, model in (("krea-video-google-veo-3-1-fast", "veo-3.1-fast-generate-001"),
                           ("krea-video-google-veo-3-1-lite", "veo-3.1-lite-generate-001")):
        mock = _VertexMock()
        a, b, c = _vertex(mock)
        with a, b, c:
            await _run(GraphNode(id="v", definitionId=node_id, params=_defaults(node_id)), PROMPT, VERTEX)
        assert mock.posts[0]["url"].endswith(f"/models/{model}:predictLongRunning")
        # Lite's Krea copy has no audio choice and is priced as video only.
        assert mock.posts[0]["json"]["parameters"]["generateAudio"] is False


@pytest.mark.asyncio
async def test_krea_veo_on_a_gemini_api_key_alone_stays_on_krea():
    """The Gemini API's Veo previews end 2026-10-22, so the Krea copies' maker
    route is Vertex only."""
    gateway = AsyncMock(return_value={"video": {"type": "Video", "value": "https://example.com/k.mp4"}})
    node = GraphNode(id="v", definitionId="krea-video-google-veo-3-1", params={"_kreaAuth": "api-token"})
    with patch("handlers.krea_gateway.handle_krea_gateway", gateway), patch("handlers.veo.httpx.AsyncClient") as v:
        await _run(node, PROMPT, {**GOOGLE, **KREA})
    v.assert_not_called()
    gateway.assert_awaited_once()


@pytest.mark.asyncio
async def test_the_krea_plan_wins_over_vertex():
    seen = {}

    async def gateway(node, inputs, api_keys, emit=None):
        seen.update(node.params)
        return {"video": {"type": "Video", "value": "https://example.com/k.mp4"}}

    params = {"_kreaAuth": "mcp", "duration": 8, "generate_audio": True}
    node = GraphNode(id="v", definitionId="krea-video-google-veo-3-1", params=params)
    with patch("handlers.krea_gateway.handle_krea_gateway", gateway), patch("handlers.veo.httpx.AsyncClient") as v:
        await _run(node, PROMPT, {**VERTEX, **KREA})
    v.assert_not_called()
    assert seen == params


# -- Krea Gemini Omni Flash 1.1 ------------------------------------------------------

def _omni_client():
    return _client({"id": "int-1", "status": "completed", "steps": [{"type": "model_output", "content": [
        {"type": "video", "data": "RkFLRU1QNA=="}]}]})


@pytest.mark.asyncio
async def test_krea_omni_runs_on_the_gemini_api_with_duration_and_a_start_frame():
    node = GraphNode(id="o", definitionId="krea-video-google-gemini-omni-flash-1-1", params={
        **_defaults("krea-video-google-gemini-omni-flash-1-1"), "duration": 6, "aspect_ratio": "9:16",
        "start_image": PNG_DATA_URI})
    client = _omni_client()
    gateway = AsyncMock()
    with patch("handlers.gemini_omni.httpx.AsyncClient", return_value=client), \
            patch("handlers.krea_gateway.handle_krea_gateway", gateway):
        result = await _run(node, PROMPT, {**GOOGLE, **KREA})
    gateway.assert_not_called()
    assert set(result) == {"video", "videos", "artifacts"}
    body = client.post.call_args.kwargs["json"]
    assert body["model"] == "gemini-omni-1.1-flash"
    assert body["response_format"] == {"type": "video", "delivery": "uri", "aspect_ratio": "9:16", "duration": "6s"}
    assert body["generation_config"] == {"video_config": {"task": "image_to_video"}}
    assert [part["type"] for part in body["input"]] == ["image", "text"]


@pytest.mark.asyncio
async def test_krea_omni_references_go_as_reference_to_video():
    node = GraphNode(id="o", definitionId="krea-video-google-gemini-omni-flash-1-1",
                     params=_defaults("krea-video-google-gemini-omni-flash-1-1"))
    inputs = {**PROMPT, "reference_images": PortValueDict(type="Image", value=[PNG_DATA_URI, PNG_DATA_URI]),
              "reference_videos": PortValueDict(type="Video", value=["data:video/mp4;base64,RkFLRQ=="])}
    client = _omni_client()
    with patch("handlers.gemini_omni.httpx.AsyncClient", return_value=client):
        await _run(node, inputs, GOOGLE)
    body = client.post.call_args.kwargs["json"]
    assert body["generation_config"] == {"video_config": {"task": "reference_to_video"}}
    assert [part["type"] for part in body["input"]] == ["video", "image", "image", "text"]
    assert body["response_format"]["duration"] == "8s"


@pytest.mark.asyncio
async def test_krea_omni_refuses_a_start_frame_with_references():
    node = GraphNode(id="o", definitionId="krea-video-google-gemini-omni-flash-1-1",
                     params={"start_image": PNG_DATA_URI, "reference_images": f'["{PNG_DATA_URI}"]'})
    with patch("handlers.gemini_omni.httpx.AsyncClient") as google:
        with pytest.raises(ValueError, match="start image and references"):
            await _run(node, PROMPT, GOOGLE)
    google.assert_not_called()


def test_google_lane_translations_are_registered():
    from execution import maker_routes

    for name in maker_routes_google.KREA_TRANSLATIONS:
        assert name in maker_routes.KREA_TRANSLATIONS
    for node_id in ("krea-image-google-nano-banana-2-1", "krea-video-google-veo-3-1",
                    "krea-video-google-veo-3-1-fast", "krea-video-google-veo-3-1-lite",
                    "krea-video-google-gemini-omni-flash-1-1"):
        spec = DEFINITIONS[node_id]["directRoute"]
        assert spec["translation"] in maker_routes_google.KREA_TRANSLATIONS, node_id


# -- prices follow the route ------------------------------------------------------

@pytest.mark.parametrize("node_id,params,keys,expected", [
    # 8 s at Vertex's video-only 720p rate ($0.20/s); Krea's own price is the same.
    ("krea-video-google-veo-3-1", {}, VERTEX, (1.6, 1.6, None)),
    ("krea-video-google-veo-3-1", {"generate_audio": True, "resolution": "4K", "duration": 4}, VERTEX,
     (2.4, 2.4, None)),
    ("krea-video-google-veo-3-1-fast", {"generate_audio": True, "resolution": "1080p"}, VERTEX, (0.96, 0.96, None)),
    ("krea-video-google-veo-3-1-lite", {"resolution": "1080p", "duration": 6}, VERTEX, (0.3, 0.3, None)),
    # 5,792 tokens/s of 720p video x $17.50 per 1M, 8 s; inputs and thinking are open.
    ("krea-video-google-gemini-omni-flash-1-1", {}, GOOGLE, (0.81088, 0.81088, "input media and thinking tokens")),
    ("krea-image-google-nano-banana-2-1", {"resolution": "4K"}, GOOGLE, (0.113, 0.13652, "thinking tokens")),
    ("identity-edit", {}, GOOGLE, (0.067, 0.07484, None)),
])
def test_google_route_prices(node_id, params, keys, expected):
    from services import model_pricing

    definition = DEFINITIONS[node_id]
    entry = model_pricing.load_pricing()["nodes"][node_id]
    provider = model_pricing.route_provider(definition, keys, params)
    assert provider == "google"
    estimate = model_pricing.estimate_node(entry, definition, params, provider)
    low, high, plus = expected
    assert estimate["low"] == pytest.approx(low) and estimate["high"] == pytest.approx(high)
    assert estimate.get("plus") == plus


def test_unpriced_google_settings_stay_unpriced():
    from services import model_pricing

    pricing = model_pricing.load_pricing()["nodes"]
    # Thinking medium/high on 3.1 Flash Image bills output tokens with no per-image figure.
    definition = DEFINITIONS["identity-edit"]
    assert model_pricing.estimate_node(pricing["identity-edit"], definition, {"thinking_level": "high"}, "google") is None
    # Fast at 4K never takes the Google route, so it has no Google row either.
    fast = DEFINITIONS["krea-video-google-veo-3-1-fast"]
    assert model_pricing.estimate_node(pricing["krea-video-google-veo-3-1-fast"], fast, {"resolution": "4K"},
                                       "google") is None
