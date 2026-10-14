"""Seedance on BytePlus ModelArk: the fal and Krea copies' direct routes.

Only the transport is mocked (httpx.MockTransport): no provider is contacted
and nothing is billed. Covers the task each copy sends (model, content roles,
ratio, duration, audio, seed only on 1.x, watermark off), what keeps a run on
the copy, polling to success or failure, cancelling a queued task with
DELETE, saving the video at once, and the prices, recomputed from BytePlus's
token formula and checked against BytePlus's own worked examples.
"""
from __future__ import annotations

import asyncio
import base64
import copy
import json
from typing import Any
from unittest.mock import AsyncMock, patch

import httpx
import pytest

from execution import byteplus_seedance_prices as prices
from execution import maker_routes_byteplus_seedance as seedance
from execution.missing_credential import MissingCredentialError
from execution.sync_runner import get_handler_registry
from handlers import byteplus
from models.graph import GraphNode, PortValueDict
from services import model_pricing, node_route
from services.node_registry import NodeRegistry

DEFINITIONS = NodeRegistry().get_all()
PRICING = model_pricing.load_pricing()["nodes"]
BYTEPLUS = {"BYTEPLUS_API_KEY": "fixture-byteplus"}
FAL = {"FAL_KEY": "fixture-fal"}
KREA = {"KREA_API_TOKEN": "fixture-krea"}
PROMPT = {"prompt": PortValueDict(type="Text", value="a lighthouse at dusk")}
TASKS_URL = "https://ark.ap-southeast.bytepluses.com/api/v3/contents/generations/tasks"
VIDEO_URL = "https://ark-content-generation-ap-southeast-1.example/out.mp4"
MP4 = b"\x00\x00\x00\x18ftypmp42\x00\x00\x00\x00mp42isom" + b"\x00" * 64
PNG = base64.b64decode(
    "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8/5+hHgAHggJ/PchI7wAAAABJRU5ErkJggg=="
)
FAL_NODES = ("seedance-2-t2v", "seedance-2-i2v", "seedance-2-r2v", "seedance-2-fast-t2v", "seedance-2-fast-i2v",
             "seedance-v1-5", "seedance-1-0-t2v")
KREA_NODES = ("krea-video-bytedance-seedance-1-0-pro", "krea-video-bytedance-seedance-1-0-pro-fast",
              "krea-video-bytedance-seedance-2", "krea-video-bytedance-seedance-2-fast",
              "krea-video-bytedance-seedance-2-mini", "krea-video-bytedance-seedance-2-5")
_REAL_CLIENT = httpx.AsyncClient


class ModelArk:
    """A fake ModelArk task API: POST makes a task, each GET answers the next
    of ``statuses``, the video URL serves MP4 bytes, DELETE is recorded."""

    def __init__(self, monkeypatch: pytest.MonkeyPatch, *statuses: dict[str, Any] | str):
        self.requests: list[httpx.Request] = []
        self.statuses = list(statuses) or ["queued", "running", "succeeded"]

        def factory(*args: Any, **kwargs: Any) -> httpx.AsyncClient:
            return _REAL_CLIENT(*args, transport=httpx.MockTransport(self._answer), **kwargs)

        monkeypatch.setattr(byteplus.httpx, "AsyncClient", factory)
        monkeypatch.setattr(byteplus, "POLL_INTERVAL", 0)
        # The fixture bytes aren't a playable video; output validation probes with ffprobe.
        monkeypatch.setattr("services.output.ffprobe_video", AsyncMock(return_value={}))

    def _answer(self, request: httpx.Request) -> httpx.Response:
        self.requests.append(request)
        if str(request.url) == VIDEO_URL:
            return httpx.Response(200, content=MP4, headers={"content-type": "video/mp4"})
        if request.method == "POST":
            return httpx.Response(200, json={"id": "cgt-fixture"})
        if request.method == "DELETE":
            return httpx.Response(200)
        status = self.statuses.pop(0) if len(self.statuses) > 1 else self.statuses[0]
        task = status if isinstance(status, dict) else {"id": "cgt-fixture", "status": status}
        if task.get("status") == "succeeded":
            task = {**task, "content": {"video_url": VIDEO_URL}, "usage": {"completion_tokens": 108900}}
        return httpx.Response(200, json=task)

    @property
    def bodies(self) -> list[dict[str, Any]]:
        return [json.loads(request.content) for request in self.requests if request.method == "POST"]

    def methods(self) -> list[str]:
        return [request.method for request in self.requests if str(request.url).startswith(TASKS_URL)]


async def _run(node: GraphNode, inputs: dict[str, PortValueDict], keys: dict[str, str]) -> dict[str, Any]:
    return await get_handler_registry(emit=AsyncMock())[node.definition_id](node, inputs, keys)


def _defaults(definition_id: str) -> dict[str, Any]:
    definition = DEFINITIONS[definition_id]
    return {p["key"]: p["default"] for name in ("params", "sharedParams", "falParams", "directParams")
            for p in definition.get(name) or [] if "default" in p}


def _local_files(monkeypatch):
    from pathlib import Path

    monkeypatch.setattr("services.file_access.require_allowed_path", lambda path: Path(path))


# -- fal copies ------------------------------------------------------------------

@pytest.mark.asyncio
async def test_seedance_2_on_fal_runs_on_byteplus_with_the_maker_key(monkeypatch):
    ark = ModelArk(monkeypatch)
    node = GraphNode(id="s", definitionId="seedance-2-t2v", params=_defaults("seedance-2-t2v"))
    before = copy.deepcopy(node.params)
    fal = AsyncMock()
    with patch("handlers.fal_universal.handle_fal_universal", fal):
        result = await _run(node, PROMPT, {**BYTEPLUS, **FAL})
    fal.assert_not_called()
    assert node.params == before
    assert ark.bodies == [{
        "model": "dreamina-seedance-2-0-260128", "duration": -1, "resolution": "720p", "ratio": "adaptive",
        "generate_audio": True, "content": [{"type": "text", "text": "a lighthouse at dusk"}],
        "watermark": False, "execution_expires_after": 3600,
    }]
    assert ark.methods() == ["POST", "GET", "GET", "GET"]
    # The video is saved at once (BytePlus's URL lasts 24 hours).
    assert result["video"]["type"] == "Video" and result["video"]["value"].endswith(".mp4")
    assert open(result["video"]["value"], "rb").read() == MP4


@pytest.mark.asyncio
async def test_frames_and_references_get_their_roles(monkeypatch, tmp_path):
    _local_files(monkeypatch)
    local = tmp_path / "first.png"
    local.write_bytes(PNG)
    ark = ModelArk(monkeypatch)
    inputs = {**PROMPT, "image": PortValueDict(type="Image", value=str(local)),
              "end_image": PortValueDict(type="Image", value="https://example.com/last.png")}
    await _run(GraphNode(id="s", definitionId="seedance-2-fast-i2v",
                         params={"aspect_ratio": "9:16", "duration": "8", "resolution": "480p"}), inputs, BYTEPLUS)
    body = ark.bodies[0]
    assert body["model"] == "dreamina-seedance-2-0-fast-260128"
    assert (body["ratio"], body["duration"], body["resolution"]) == ("9:16", 8, "480p")
    assert body["content"][1:] == [
        {"type": "image_url", "image_url": {"url": "data:image/png;base64," + base64.b64encode(PNG).decode()},
         "role": "first_frame"},
        {"type": "image_url", "image_url": {"url": "https://example.com/last.png"}, "role": "last_frame"},
    ]
    ark2 = ModelArk(monkeypatch)
    refs = {**PROMPT, "images": PortValueDict(type="Image", value=["https://e.com/a.png", "https://e.com/b.png"])}
    await _run(GraphNode(id="r", definitionId="seedance-2-r2v", params={}), refs, BYTEPLUS)
    assert [item.get("role") for item in ark2.bodies[0]["content"]] == [None, "reference_image", "reference_image"]


@pytest.mark.asyncio
async def test_seedance_2_takes_at_most_nine_reference_images(monkeypatch):
    ark = ModelArk(monkeypatch)
    refs = {**PROMPT, "images": PortValueDict(type="Image", value=[f"https://e.com/{i}.png" for i in range(10)])}
    with pytest.raises(ValueError, match="1 to 9 reference images"):
        await _run(GraphNode(id="r", definitionId="seedance-2-r2v", params={}), refs, BYTEPLUS)
    assert ark.requests == []


@pytest.mark.asyncio
async def test_a_seed_keeps_seedance_2_on_fal(monkeypatch):
    ark = ModelArk(monkeypatch)
    fal = AsyncMock(return_value={"video": {"type": "Video", "value": "x.mp4"}})
    node = GraphNode(id="s", definitionId="seedance-2-t2v", params={**_defaults("seedance-2-t2v"), "seed": 7})
    with patch("handlers.fal_universal.handle_fal_universal", fal):
        await _run(node, PROMPT, {**BYTEPLUS, **FAL})
    assert ark.requests == []
    sent = fal.call_args.args[0].params
    assert sent["seed"] == 7 and sent["endpoint_id"] == "bytedance/seedance-2.0/text-to-video"


@pytest.mark.asyncio
@pytest.mark.parametrize("choice,model,audio", [("1.5", "seedance-1-5-pro-251215", True),
                                                ("1.0", "seedance-1-0-pro-250528", None)])
async def test_seedance_1x_sends_seed_and_camera_and_audio_only_where_documented(monkeypatch, choice, model, audio):
    ark = ModelArk(monkeypatch)
    params = {**_defaults("seedance-v1-5"), "model": choice, "seed": 42, "camera_fixed": True, "aspect_ratio": "auto"}
    inputs = {**PROMPT, "image": PortValueDict(type="Image", value="https://example.com/a.png")}
    await _run(GraphNode(id="v", definitionId="seedance-v1-5", params=params), inputs, BYTEPLUS)
    body = ark.bodies[0]
    assert body["model"] == model and body["seed"] == 42 and body["camera_fixed"] is True
    assert body["ratio"] == "adaptive" and body["duration"] == 5
    assert body.get("generate_audio") == audio


@pytest.mark.asyncio
async def test_seedance_1_0_t2v_leaves_the_fal_safety_checker_behind(monkeypatch):
    ark = ModelArk(monkeypatch)
    await _run(GraphNode(id="t", definitionId="seedance-1-0-t2v", params=_defaults("seedance-1-0-t2v")),
               PROMPT, BYTEPLUS)
    body = ark.bodies[0]
    assert body["model"] == "seedance-1-0-pro-250528" and body["ratio"] == "16:9" and body["resolution"] == "1080p"
    assert "enable_safety_checker" not in body and "generate_audio" not in body


@pytest.mark.asyncio
async def test_the_fal_safety_checker_switched_off_keeps_seedance_1_0_on_fal(monkeypatch):
    # ModelArk always runs its own content filter, so it can't honor a recipe
    # that turned fal's checker off (directRoute.accepts).
    ark = ModelArk(monkeypatch)
    fal = AsyncMock(return_value={"video": {"type": "Video", "value": "x.mp4"}})
    node = GraphNode(id="t", definitionId="seedance-1-0-t2v",
                     params={**_defaults("seedance-1-0-t2v"), "enable_safety_checker": False})
    with patch("handlers.fal_universal.handle_fal_universal", fal):
        await _run(node, PROMPT, {**BYTEPLUS, **FAL})
    assert ark.requests == []
    assert fal.call_args.args[0].params["enable_safety_checker"] is False


@pytest.mark.asyncio
@pytest.mark.parametrize("definition_id,params,inputs,expected", [
    # Saved by the CLI or an agent with only the model: the node's own
    # defaults (5 s, 16:9), not BytePlus's (-1 lets 1.5 pro run up to 12 s).
    ("seedance-v1-5", {"model": "1.5"}, {"image": PortValueDict(type="Image", value="https://e.com/a.png")},
     {"duration": 5, "ratio": "16:9", "resolution": "720p", "generate_audio": True}),
    # Seedance 1.0 text-to-video "Does not support adaptive"; -1 isn't a 1.0 duration.
    ("seedance-1-0-t2v", {}, {}, {"duration": 5, "ratio": "16:9", "resolution": "1080p"}),
])
async def test_unsaved_settings_use_the_node_defaults_the_price_reads(monkeypatch, definition_id, params, inputs,
                                                                      expected):
    ark = ModelArk(monkeypatch)
    await _run(GraphNode(id="d", definitionId=definition_id, params=params), {**PROMPT, **inputs}, BYTEPLUS)
    body = ark.bodies[0]
    assert {key: body.get(key) for key in expected} == expected
    # The spend gate's high bound covers the video BytePlus is asked for.
    estimate = _estimate(definition_id, params, BYTEPLUS)
    model = body["model"]
    one = prices.video_price(model, body["resolution"], str(body["duration"]), audio=body.get("generate_audio", True))
    assert estimate["high"] >= (one[1] if isinstance(one, list) else one) - 1e-9


# -- Krea copies -----------------------------------------------------------------

@pytest.mark.asyncio
async def test_krea_seedance_runs_on_byteplus_and_fills_the_krea_ports(monkeypatch):
    ark = ModelArk(monkeypatch)
    gateway = AsyncMock()
    node = GraphNode(id="k", definitionId="krea-video-bytedance-seedance-2",
                     params={**_defaults("krea-video-bytedance-seedance-2"), "_kreaAuth": "api-token",
                             "prompt": "a fox", "duration": 6.0, "resolution": "4k", "generate_audio": False,
                             "reference_videos": '["https://example.com/clip.mp4"]'})
    with patch("handlers.krea_gateway.handle_krea_gateway", gateway):
        result = await _run(node, {}, {**BYTEPLUS, **KREA})
    gateway.assert_not_called()
    body = ark.bodies[0]
    assert body["model"] == "dreamina-seedance-2-0-260128"
    assert (body["duration"], body["resolution"], body["ratio"], body["generate_audio"]) == (6, "4k", "16:9", False)
    assert body["content"] == [
        {"type": "text", "text": "a fox"},
        {"type": "video_url", "video_url": {"url": "https://example.com/clip.mp4"}, "role": "reference_video"},
    ]
    assert "upscale" not in body and "enhance_prompt" not in body and "seed" not in body
    assert set(result) == {"video", "videos", "artifacts"}
    assert result["artifacts"]["value"][0]["type"] == "Video"


@pytest.mark.asyncio
async def test_seedance_2_5_frame_runs_send_adaptive(monkeypatch):
    ark = ModelArk(monkeypatch)
    node = GraphNode(id="k", definitionId="krea-video-bytedance-seedance-2-5",
                     params={"prompt": "a fox", "aspect_ratio": "16:9", "duration": 12})
    inputs = {"start_image": PortValueDict(type="Image", value="https://example.com/a.png")}
    await _run(node, inputs, BYTEPLUS)
    body = ark.bodies[0]
    assert body["model"] == "dreamina-seedance-2-5-260628" and body["ratio"] == "adaptive"
    assert body["content"][1]["role"] == "first_frame"


@pytest.mark.asyncio
async def test_local_reference_audio_goes_as_base64(monkeypatch, tmp_path):
    _local_files(monkeypatch)
    clip = tmp_path / "voice.wav"
    clip.write_bytes(b"RIFF0000WAVE")
    ark = ModelArk(monkeypatch)
    inputs = {"reference_audios": PortValueDict(type="Audio", value=[str(clip)]),
              "reference_images": PortValueDict(type="Image", value=["https://example.com/a.png"])}
    await _run(GraphNode(id="k", definitionId="krea-video-bytedance-seedance-2-mini", params={"prompt": "x"}),
               inputs, BYTEPLUS)
    audio = ark.bodies[0]["content"][-1]
    assert audio == {"type": "audio_url", "role": "reference_audio",
                     "audio_url": {"url": "data:audio/wav;base64," + base64.b64encode(b"RIFF0000WAVE").decode()}}


@pytest.mark.asyncio
@pytest.mark.parametrize("definition_id,inputs,params,error", [
    # BytePlus takes reference videos only at a public URL.
    ("krea-video-bytedance-seedance-2", {"reference_videos": PortValueDict(type="Video", value=["/tmp/clip.mp4"])},
     {}, "public URL"),
    ("krea-video-bytedance-seedance-2", {"reference_videos": PortValueDict(
        type="Video", value=["http://127.0.0.1:8000/api/outputs/clip.mp4"])}, {}, "public URL"),
    # Frame mode and reference mode "cannot be mixed".
    ("krea-video-bytedance-seedance-2-5", {"start_image": PortValueDict(type="Image", value="https://e.com/a.png")},
     {"reference_images": '["https://e.com/b.png"]'}, "can't mix"),
    # 2.0 rejects audio-only input; an end frame needs a start frame.
    ("krea-video-bytedance-seedance-2", {"reference_audios": PortValueDict(type="Audio", value=["https://e.com/a.mp3"])},
     {}, "audio-only"),
    ("krea-video-bytedance-seedance-2", {"end_image": PortValueDict(type="Image", value="https://e.com/a.png")},
     {}, "needs a start image"),
])
async def test_inputs_byteplus_cant_take_raise_before_any_request(monkeypatch, definition_id, inputs, params, error):
    ark = ModelArk(monkeypatch)
    node = GraphNode(id="k", definitionId=definition_id, params={"prompt": "x", **params})
    with pytest.raises(ValueError, match=error):
        await _run(node, inputs, BYTEPLUS)
    assert ark.requests == []


@pytest.mark.asyncio
@pytest.mark.parametrize("definition_id,port,value,error", [
    ("krea-video-bytedance-seedance-1-0-pro", "start_video", PortValueDict(type="Video", value="https://e.com/v.mp4"),
     "start video"),
    ("krea-video-bytedance-seedance-1-0-pro", "reference_images",
     PortValueDict(type="Image", value=["https://e.com/a.png"]), "takes no reference images"),
    ("krea-video-bytedance-seedance-2", "effects", PortValueDict(type="Any", value=[{"id": "x"}]), "effects"),
])
async def test_wired_krea_only_inputs_keep_seedance_on_krea(monkeypatch, definition_id, port, value, error):
    """Krea-only fields wired into a port keep the run on Krea, as saved ones do."""
    ark = ModelArk(monkeypatch)
    node = GraphNode(id="k", definitionId=definition_id, params={"prompt": "x"})
    with pytest.raises(MissingCredentialError, match=f"^KREA_API_TOKEN is required: {port}"):
        await _run(node, {port: value}, BYTEPLUS)
    gateway = AsyncMock(return_value={"video": {"type": "Video", "value": "https://e.com/k.mp4"}})
    with patch("handlers.krea_gateway.handle_krea_gateway", gateway):
        await _run(node, {port: value}, {**BYTEPLUS, **KREA})
    gateway.assert_awaited_once()
    assert ark.requests == []
    # The translator still refuses one if it ever reached it.
    with pytest.raises(ValueError, match=error):
        seedance.krea_to_byteplus(DEFINITIONS[definition_id]["directRoute"]["model"])(node, {port: value})


@pytest.mark.asyncio
@pytest.mark.parametrize("definition_id,params", [
    ("krea-video-bytedance-seedance-2", {"upscale": True}),
    ("krea-video-bytedance-seedance-2", {"seed": 3}),
    ("krea-video-bytedance-seedance-2-5", {"duration": 7.5}),
    ("krea-video-bytedance-seedance-2-5", {"draft": True}),
    ("krea-video-bytedance-seedance-1-0-pro", {"aspect_ratio": "9:21"}),
    ("krea-video-bytedance-seedance-1-0-pro-fast", {"start_video": "https://e.com/v.mp4"}),
    ("krea-video-bytedance-seedance-2", {"_kreaAuth": "mcp"}),
])
async def test_settings_only_krea_takes_keep_the_run_on_krea(monkeypatch, definition_id, params):
    ark = ModelArk(monkeypatch)
    gateway = AsyncMock(return_value={"video": {"type": "Video", "value": "x.mp4"}})
    node = GraphNode(id="k", definitionId=definition_id, params={"prompt": "x", **params})
    with patch("handlers.krea_gateway.handle_krea_gateway", gateway):
        await _run(node, {}, {**BYTEPLUS, **KREA})
    assert ark.requests == []
    gateway.assert_called_once()


# -- the task --------------------------------------------------------------------

@pytest.mark.asyncio
async def test_a_failed_task_says_why(monkeypatch):
    ModelArk(monkeypatch, {"id": "cgt-fixture", "status": "failed",
                           "error": {"code": "OutputVideoSensitiveContentDetected", "message": "blocked"}})
    with pytest.raises(byteplus.BytePlusError, match="sensitive content filter") as raised:
        await _run(GraphNode(id="s", definitionId="seedance-2-t2v", params={}), PROMPT, BYTEPLUS)
    assert raised.value.code == "OutputVideoSensitiveContentDetected"


@pytest.mark.asyncio
async def test_activation_errors_point_at_the_console(monkeypatch):
    def answer(request: httpx.Request) -> httpx.Response:
        return httpx.Response(404, json={"error": {"code": "ModelNotOpen", "message": "not activated"}})

    monkeypatch.setattr(byteplus.httpx, "AsyncClient",
                        lambda *a, **k: _REAL_CLIENT(*a, transport=httpx.MockTransport(answer), **k))
    with pytest.raises(byteplus.BytePlusError, match="USD 30"):
        await _run(GraphNode(id="s", definitionId="seedance-2-t2v", params={}), PROMPT, BYTEPLUS)


async def _drain_cancels() -> None:
    from services import cancellation

    await asyncio.gather(*list(cancellation._pending_cancel_tasks))


@pytest.mark.asyncio
async def test_cancelling_a_run_deletes_the_task(monkeypatch):
    ark = ModelArk(monkeypatch, "queued")
    run = asyncio.create_task(_run(GraphNode(id="s", definitionId="seedance-2-t2v", params={}), PROMPT, BYTEPLUS))
    while ark.methods().count("GET") < 2:
        await asyncio.sleep(0)
    run.cancel()
    with pytest.raises(asyncio.CancelledError):
        await run
    await _drain_cancels()
    assert ark.methods()[-1] == "DELETE"
    assert str(ark.requests[-1].url) == f"{TASKS_URL}/cgt-fixture"


@pytest.mark.asyncio
async def test_a_task_that_never_finishes_times_out_and_is_cancelled(monkeypatch):
    ark = ModelArk(monkeypatch, "queued")
    monkeypatch.setattr(byteplus, "POLL_TIMEOUT", -1)
    with pytest.raises(RuntimeError, match="stopped waiting"):
        await _run(GraphNode(id="s", definitionId="seedance-2-t2v", params={}), PROMPT, BYTEPLUS)
    await _drain_cancels()
    assert ark.methods() == ["POST", "GET", "DELETE"]


# -- prices ----------------------------------------------------------------------

@pytest.mark.parametrize("model,resolution,expected", [
    # BytePlus's "pricing examples" (model-pricing, 16:9, 5 s, input without video).
    (prices.SEEDANCE_2_5, "480p", 0.514), (prices.SEEDANCE_2_5, "720p", 1.156), (prices.SEEDANCE_2_5, "1080p", 2.843),
    (prices.SEEDANCE_2_0, "480p", 0.35), (prices.SEEDANCE_2_0, "720p", 0.76), (prices.SEEDANCE_2_0, "1080p", 1.87),
    (prices.SEEDANCE_2_0, "4k", 3.89), (prices.SEEDANCE_2_0_FAST, "720p", 0.60), (prices.SEEDANCE_2_0_MINI, "720p", 0.38),
    (prices.SEEDANCE_1_5_PRO, "1080p", 0.58), (prices.SEEDANCE_1_0_PRO, "1080p", 0.61),
    (prices.SEEDANCE_1_0_PRO_FAST, "480p", 0.05),
])
def test_the_token_formula_reproduces_byteplus_examples(model, resolution, expected):
    low, _ = prices.per_second(model, resolution, "16:9")
    assert round(low * 5, 3 if expected * 1000 % 10 else 2) == expected


def test_fal_prices_are_the_formula_for_every_choice():
    for node_id in FAL_NODES:
        assert PRICING[node_id] == {"routes": {"bytedance": seedance.fal_price_entry(DEFINITIONS[node_id])}}, node_id
        assert not model_pricing.validate_pricing({"nodes": {node_id: PRICING[node_id]}}, DEFINITIONS)


def _estimate(node_id: str, params: dict[str, Any], keys: dict[str, str], wired=()) -> dict[str, Any] | None:
    definition = DEFINITIONS[node_id]
    return model_pricing.estimate_node(PRICING.get(node_id), definition, params,
                                       model_pricing.route_provider(definition, keys, params), wired)


def test_estimates_follow_the_route():
    # fal's copy has no list price; BytePlus's does.
    assert _estimate("seedance-2-t2v", {}, FAL) is None
    auto = _estimate("seedance-2-t2v", {}, {**BYTEPLUS, **FAL})
    assert auto["low"] == pytest.approx(921600 * 24 / 1024 * 7.0 / 1e6 * 4)
    assert auto["high"] == pytest.approx(927408 * 24 / 1024 * 7.0 / 1e6 * 15, abs=1e-6)
    five = _estimate("seedance-2-t2v", {"duration": "5"}, BYTEPLUS)
    assert five["low"] == pytest.approx(0.756)
    silent = _estimate("seedance-v1-5", {"generate_audio": False}, BYTEPLUS)
    assert silent["low"] == pytest.approx(_estimate("seedance-v1-5", {}, BYTEPLUS)["low"] / 2)
    krea = _estimate("krea-video-bytedance-seedance-2", {"duration": 10}, {**BYTEPLUS, **KREA})
    assert krea["low"] == pytest.approx(0.1512 * 10)
    # A reference video bills another rate plus a minimum: unpriced, set or wired.
    assert _estimate("krea-video-bytedance-seedance-2", {"reference_videos": '["https://e.com/v.mp4"]'}, BYTEPLUS) is None
    assert _estimate("krea-video-bytedance-seedance-2", {}, BYTEPLUS, wired=("reference_videos",)) is None


def test_every_seedance_copy_routes_to_byteplus_with_the_maker_key():
    for node_id in (*FAL_NODES, *KREA_NODES):
        definition = DEFINITIONS[node_id]
        assert node_route.direct_keys(definition) == ["BYTEPLUS_API_KEY"], node_id
        assert definition["directRoute"]["setup"] == "fallback", node_id
        assert node_route.select_route(definition, {}, BYTEPLUS).kind == node_route.DIRECT, node_id
        # Each route only sends its own params.
        direct = node_route.route_param_keys(definition, node_route.DIRECT)
        assert "seed" not in direct or node_id in ("seedance-v1-5", "seedance-1-0-t2v"), node_id
        assert {"effects", "upscale", "enhance_prompt", "draft", "start_video"}.isdisjoint(direct), node_id


def test_the_translator_never_sends_seed_or_camera_to_seedance_2():
    """Route filtering already drops fal's seed on 2.x; the translator doesn't rely on it."""
    node = GraphNode(id="s", definitionId="seedance-2-t2v", params={"seed": 7, "camera_fixed": True})
    translated, _ = seedance.fal_to_byteplus(node, dict(PROMPT))
    assert "seed" not in translated.params and "camera_fixed" not in translated.params
