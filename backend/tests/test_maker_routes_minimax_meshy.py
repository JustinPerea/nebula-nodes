"""Krea's MiniMax and Meshy copies on the makers' own APIs.

Only the transport is mocked (respx): no provider is contacted and nothing is
billed. Covers route choice (maker key wins, Krea keeps what MiniMax can't
take, the Krea plan wins over both), the Krea -> MiniMax V1 / V2 and Krea ->
Meshy translations and request bodies, MiniMax's region fallback, the H3
plan hint, progress events, and the direct-route prices.
"""
from __future__ import annotations

import asyncio
import copy
import json
from unittest.mock import AsyncMock, patch

import httpx
import pytest
import respx

from execution import maker_routes_minimax_meshy as mm
from execution.missing_credential import MissingCredentialError
from execution.sync_runner import get_handler_registry
from handlers import minimax, minimax_v2
from models.events import ProgressEvent
from models.graph import GraphNode, PortValueDict
from services import model_pricing, node_route
from services.node_registry import NodeRegistry
from services.output import get_run_dir

DEFINITIONS = NodeRegistry().get_all()
MINIMAX = {"MINIMAX_API_KEY": "fixture-minimax"}
MESHY = {"MESHY_API_KEY": "fixture-meshy"}
KREA = {"KREA_API_TOKEN": "fixture-krea"}
MAINLAND, GLOBAL = minimax.MINIMAX_API_BASES
PROMPT = {"prompt": PortValueDict(type="Text", value="a lighthouse at dusk")}
START = PortValueDict(type="Image", value="https://example.com/start.png")
END = PortValueDict(type="Image", value="https://example.com/end.png")


def _defaults(definition_id):
    definition = DEFINITIONS[definition_id]
    return {p["key"]: p["default"] for name in ("params", "sharedParams", "falParams", "directParams")
            for p in definition.get(name) or [] if "default" in p}


async def _run(node, inputs, keys, emit=None):
    return await get_handler_registry(emit=emit or AsyncMock())[node.definition_id](node, inputs, keys)


@pytest.fixture(autouse=True)
def _fast_polls():
    with patch("handlers.minimax.asyncio.sleep", new=AsyncMock()), \
            patch("handlers.minimax_v2.asyncio.sleep", new=AsyncMock()), \
            patch("handlers.meshy.asyncio.sleep", new=AsyncMock()):
        yield


async def _fake_video(url, run_dir, extension="mp4"):
    path = get_run_dir() / f"{abs(hash(url))}.mp4"
    path.write_bytes(b"\x00\x00\x00\x18ftypmp42")
    return path


async def _fake_mesh(url, run_dir, extension="glb"):
    path = get_run_dir() / f"{abs(hash(url))}.glb"
    path.write_bytes(b"glTF")
    return path


def _v1_routes(router, base=MAINLAND):
    submit = router.post(f"{base}/v1/video_generation").mock(
        return_value=httpx.Response(200, json={"task_id": "t1", "base_resp": {"status_code": 0}}))
    router.get(f"{base}/v1/query/video_generation").mock(
        return_value=httpx.Response(200, json={"status": "Success", "file_id": "f1"}))
    router.get(f"{base}/v1/files/retrieve/f1").mock(
        return_value=httpx.Response(200, json={"file": {"download_url": "https://cdn.example.com/v.mp4"}}))
    return submit


# -- Hailuo on MiniMax V1 ----------------------------------------------------------


@pytest.mark.asyncio
async def test_hailuo_02_runs_on_minimax_with_first_and_last_frame():
    node = GraphNode(id="h", definitionId="krea-video-minimax-hailuo-02",
                     params={**_defaults("krea-video-minimax-hailuo-02"), "expand_prompt": False})
    before = copy.deepcopy(node.params)
    gateway = AsyncMock()
    with respx.mock(assert_all_called=True) as router, \
            patch("handlers.minimax.save_video_from_url", _fake_video), \
            patch("handlers.krea_gateway.handle_krea_gateway", gateway):
        submit = _v1_routes(router)
        result = await _run(node, {**PROMPT, "start_image": START, "end_image": END}, {**MINIMAX, **KREA})
    gateway.assert_not_called()
    assert node.params == before
    assert set(result) == {"video", "videos", "artifacts"}
    assert result["videos"]["value"][0].startswith("/api/outputs/")
    body = json.loads(submit.calls.last.request.content)
    assert body == {"prompt": "a lighthouse at dusk", "model": "MiniMax-Hailuo-02",
                    "first_frame_image": "https://example.com/start.png",
                    "last_frame_image": "https://example.com/end.png",
                    "duration": 6, "resolution": "768P", "prompt_optimizer": False}
    assert submit.calls.last.request.headers["Authorization"] == "Bearer fixture-minimax"


@pytest.mark.asyncio
async def test_a_global_key_is_tried_on_the_global_host_and_polled_there():
    node = GraphNode(id="h", definitionId="krea-video-minimax-hailuo-2-3",
                     params=_defaults("krea-video-minimax-hailuo-2-3"))
    with respx.mock(assert_all_called=True) as router, patch("handlers.minimax.save_video_from_url", _fake_video):
        mainland = router.post(f"{MAINLAND}/v1/video_generation").mock(return_value=httpx.Response(
            200, json={"base_resp": {"status_code": 2049, "status_msg": "invalid api key"}}))
        submit = _v1_routes(router, GLOBAL)
        await _run(node, PROMPT, MINIMAX)
    assert mainland.call_count == 1 and submit.call_count == 1
    body = json.loads(submit.calls.last.request.content)
    assert body["model"] == "MiniMax-Hailuo-2.3" and body["prompt_optimizer"] is True
    assert "first_frame_image" not in body


@pytest.mark.asyncio
@pytest.mark.parametrize("definition_id,params", [
    ("krea-video-minimax-hailuo-02", {"duration": 8}),
    ("krea-video-minimax-hailuo-02", {"resolution": "1080p", "duration": 10}),
    ("krea-video-minimax-hailuo-2-3", {"resolution": "1080p", "duration": 10}),
    ("krea-video-minimax-hailuo-2-3", {"end_image": "https://example.com/end.png"}),
    ("krea-video-minimax-hailuo-2-3-fast", {"end_image": "https://example.com/end.png"}),
    ("krea-video-minimax-hailuo-3", {"reference_video_seconds": 4}),
])
async def test_what_minimax_cant_take_stays_on_krea(definition_id, params):
    node = GraphNode(id="h", definitionId=definition_id, params={**_defaults(definition_id), **params})
    gateway = AsyncMock(return_value={"video": {"type": "Video", "value": "https://example.com/k.mp4"}})
    with respx.mock() as router, patch("handlers.krea_gateway.handle_krea_gateway", gateway):
        await _run(node, {**PROMPT, "start_image": START}, {**MINIMAX, **KREA})
    gateway.assert_awaited_once()
    assert not router.calls
    sent = gateway.call_args.args[0].params
    for key, value in params.items():
        assert sent[key] == value
    # With only the MiniMax key there is no route that takes it.
    with pytest.raises(MissingCredentialError):
        await _run(node, PROMPT, MINIMAX)


@pytest.mark.asyncio
@pytest.mark.parametrize("definition_id,inputs,params,message", [
    ("krea-video-minimax-hailuo-2-3", {"end_image": END}, {}, "Hailuo 02 only"),
    ("krea-video-minimax-hailuo-2-3-fast", {}, {}, "image-to-video only"),
    ("krea-video-minimax-hailuo-02", {}, {"resolution": "512p"}, "512P only from a start image"),
    ("krea-video-minimax-hailuo-02", {"start_image": START, "end_image": END}, {"resolution": "512p"},
     "without an end image"),
])
async def test_wired_inputs_minimax_cant_take_are_refused_before_any_call(definition_id, inputs, params, message):
    node = GraphNode(id="h", definitionId=definition_id, params={**_defaults(definition_id), **params})
    with respx.mock() as router:
        with pytest.raises(ValueError, match=message):
            await _run(node, {**PROMPT, **inputs}, {**MINIMAX, **KREA})
    assert not router.calls


@pytest.mark.asyncio
async def test_hailuo_fast_with_a_start_image_is_image_to_video():
    node = GraphNode(id="h", definitionId="krea-video-minimax-hailuo-2-3-fast",
                     params={**_defaults("krea-video-minimax-hailuo-2-3-fast"), "resolution": "1080p",
                             "start_image": "https://example.com/from-param.png"})
    with respx.mock(assert_all_called=True) as router, patch("handlers.minimax.save_video_from_url", _fake_video):
        submit = _v1_routes(router)
        await _run(node, PROMPT, MINIMAX)
    body = json.loads(submit.calls.last.request.content)
    assert body["model"] == "MiniMax-Hailuo-2.3-Fast" and body["resolution"] == "1080P"
    assert body["first_frame_image"] == "https://example.com/from-param.png"
    assert "last_frame_image" not in body


@pytest.mark.asyncio
async def test_the_krea_plan_wins_over_a_minimax_key():
    params = {**_defaults("krea-video-minimax-hailuo-02"), "_kreaAuth": "mcp"}
    node = GraphNode(id="h", definitionId="krea-video-minimax-hailuo-02", params=params)
    gateway = AsyncMock(return_value={"video": {"type": "Video", "value": "https://example.com/k.mp4"}})
    with respx.mock() as router, patch("handlers.krea_gateway.handle_krea_gateway", gateway):
        await _run(node, PROMPT, {**MINIMAX, **KREA})
    assert not router.calls
    assert gateway.call_args.args[0].params == params


@pytest.mark.asyncio
async def test_the_direct_route_reports_progress():
    emit = AsyncMock()
    node = GraphNode(id="h", definitionId="krea-video-minimax-hailuo-2-3",
                     params=_defaults("krea-video-minimax-hailuo-2-3"))
    with respx.mock() as router, patch("handlers.minimax.save_video_from_url", _fake_video):
        _v1_routes(router)
        await _run(node, PROMPT, MINIMAX, emit=emit)
    assert any(isinstance(call.args[0], ProgressEvent) for call in emit.await_args_list)


# -- MiniMax H3 on V2 ----------------------------------------------------------------


def _v2_routes(router, base=MAINLAND, submit=None):
    route = router.post(f"{base}/v2/video_generation").mock(
        return_value=submit or httpx.Response(200, json={"task_id": "v2"}))
    router.get(f"{base}/v2/query/video_generation/v2").mock(return_value=httpx.Response(200, json={
        "task": {"id": "v2", "status": "succeeded", "content": {"url": "https://cdn.example.com/h3.mp4"}}}))
    return route


@pytest.mark.asyncio
async def test_h3_text_to_video_body_on_v2():
    node = GraphNode(id="h", definitionId="krea-video-minimax-hailuo-3",
                     params={**_defaults("krea-video-minimax-hailuo-3"), "duration": 7})
    with respx.mock(assert_all_called=True) as router, \
            patch("handlers.minimax_v2.save_video_from_url", _fake_video):
        submit = _v2_routes(router)
        result = await _run(node, PROMPT, {**MINIMAX, **KREA})
    assert set(result) == {"video", "videos", "artifacts"}
    body = json.loads(submit.calls.last.request.content)
    assert body == {"model": "MiniMax-H3", "content": [{"type": "text", "text": "a lighthouse at dusk"}],
                    "resolution": "2K", "duration": 7, "ratio": "16:9"}


@pytest.mark.asyncio
async def test_h3_references_from_ports_and_json_params():
    params = {**_defaults("krea-video-minimax-hailuo-3"), "resolution": "768P", "aspect_ratio": "adaptive",
              "reference_audios": '["https://example.com/a.mp3"]'}
    node = GraphNode(id="h", definitionId="krea-video-minimax-hailuo-3", params=params)
    inputs = {**PROMPT, "reference_images": PortValueDict(type="Image", value=["https://example.com/r1.png",
                                                                               "https://example.com/r2.png"]),
              "reference_videos": PortValueDict(type="Video", value="https://example.com/v.mp4")}
    with respx.mock() as router, patch("handlers.minimax_v2.save_video_from_url", _fake_video):
        submit = _v2_routes(router)
        await _run(node, inputs, MINIMAX)
    body = json.loads(submit.calls.last.request.content)
    assert body["resolution"] == "768P" and body["ratio"] == "adaptive"
    assert body["content"][1:] == [
        {"type": "image_url", "image_url": {"url": "https://example.com/r1.png"}, "role": "reference_image"},
        {"type": "image_url", "image_url": {"url": "https://example.com/r2.png"}, "role": "reference_image"},
        {"type": "video_url", "video_url": {"url": "https://example.com/v.mp4"}, "role": "reference_video"},
        {"type": "audio_url", "audio_url": {"url": "https://example.com/a.mp3"}, "role": "reference_audio"},
    ]


@pytest.mark.asyncio
async def test_h3_frames_send_adaptive_and_roles():
    node = GraphNode(id="h", definitionId="krea-video-minimax-hailuo-3",
                     params={**_defaults("krea-video-minimax-hailuo-3"), "aspect_ratio": "1:1"})
    with respx.mock() as router, patch("handlers.minimax_v2.save_video_from_url", _fake_video):
        submit = _v2_routes(router)
        await _run(node, {**PROMPT, "start_image": START, "end_image": END}, MINIMAX)
    body = json.loads(submit.calls.last.request.content)
    assert body["ratio"] == "adaptive"
    assert [item.get("role") for item in body["content"]] == [None, "first_frame", "last_frame"]


@pytest.mark.asyncio
@pytest.mark.parametrize("params,inputs,message", [
    ({"aspect_ratio": "adaptive"}, {}, "needs a set aspect ratio"),
    ({}, {"start_image": START, "reference_images": PortValueDict(type="Image", value=["https://e.com/r.png"])},
     "not both"),
    ({}, {"reference_videos": PortValueDict(type="Video", value=[f"https://e.com/{i}.mp4" for i in range(4)])},
     "at most 3"),
])
async def test_h3_requests_minimax_rejects_are_refused_before_any_call(params, inputs, message):
    node = GraphNode(id="h", definitionId="krea-video-minimax-hailuo-3",
                     params={**_defaults("krea-video-minimax-hailuo-3"), **params})
    with respx.mock() as router:
        with pytest.raises(ValueError, match=message):
            await _run(node, {**PROMPT, **inputs}, MINIMAX)
    assert not router.calls


@pytest.mark.asyncio
async def test_h3_names_the_pay_as_you_go_rule_when_minimax_refuses_the_key():
    refused = httpx.Response(402, json={"type": "error", "error": {
        "type": "insufficient_balance_error", "message": "insufficient balance (1008)", "http_code": "402"}})
    node = GraphNode(id="h", definitionId="krea-video-minimax-hailuo-3", params=_defaults("krea-video-minimax-hailuo-3"))
    with respx.mock() as router:
        router.post(f"{MAINLAND}/v2/video_generation").mock(return_value=refused)
        with pytest.raises(RuntimeError, match="pay-as-you-go") as raised:
            await _run(node, PROMPT, MINIMAX)
    assert "insufficient balance (1008)" in str(raised.value) and "Video Packages" in str(raised.value)


@pytest.mark.asyncio
async def test_h3_rejected_on_both_regions_tries_global_and_explains():
    unauthorized = httpx.Response(401, json={"type": "error", "error": {"message": "login fail (1004)"}})
    node = GraphNode(id="h", definitionId="krea-video-minimax-hailuo-3", params=_defaults("krea-video-minimax-hailuo-3"))
    with respx.mock() as router:
        mainland = router.post(f"{MAINLAND}/v2/video_generation").mock(return_value=unauthorized)
        world = router.post(f"{GLOBAL}/v2/video_generation").mock(return_value=unauthorized)
        with pytest.raises(RuntimeError, match="401.*pay-as-you-go"):
            await _run(node, PROMPT, MINIMAX)
    assert mainland.call_count == world.call_count == 1


@pytest.mark.asyncio
async def test_h3_runs_on_global_when_the_mainland_host_has_no_v2_route():
    # MiniMax documents /v2 on api.minimax.io and api.minimax.cn, not on api.minimaxi.com: a 404 there
    # creates no task, so a Global key must still reach Global instead of failing on Mainland's 404.
    node = GraphNode(id="h", definitionId="krea-video-minimax-hailuo-3", params=_defaults("krea-video-minimax-hailuo-3"))
    with respx.mock(assert_all_called=True) as router, \
            patch("handlers.minimax_v2.save_video_from_url", _fake_video):
        mainland = router.post(f"{MAINLAND}/v2/video_generation").mock(return_value=httpx.Response(404, text="404 page not found"))
        world = router.post(f"{GLOBAL}/v2/video_generation").mock(return_value=httpx.Response(200, json={"task_id": "g"}))
        polled = router.get(f"{GLOBAL}/v2/query/video_generation/g").mock(return_value=httpx.Response(
            200, json={"task": {"status": "succeeded", "content": {"url": "https://cdn.example.com/h3.mp4"}}}))
        result = await _run(node, PROMPT, MINIMAX)
    assert mainland.call_count == world.call_count == polled.call_count == 1
    assert result["video"]["type"] == "Video"


@pytest.mark.asyncio
async def test_h3_cancel_asks_minimax_to_drop_a_queued_task():
    node = GraphNode(id="h", definitionId="krea-video-minimax-hailuo-3", params=_defaults("krea-video-minimax-hailuo-3"))
    cancels = []
    with respx.mock() as router, \
            patch("handlers.minimax_v2.asyncio.sleep", new=AsyncMock(side_effect=asyncio.CancelledError)), \
            patch("handlers.minimax_v2.schedule_detached_cancel", side_effect=cancels.append):
        router.post(f"{MAINLAND}/v2/video_generation").mock(return_value=httpx.Response(200, json={"task_id": "q"}))
        with pytest.raises(asyncio.CancelledError):
            await _run(node, PROMPT, MINIMAX)
        deleted = router.delete(f"{MAINLAND}/v2/video_generation/q").mock(return_value=httpx.Response(200, json={}))
        assert len(cancels) == 1
        await cancels[0]()
    assert deleted.call_count == 1


def test_h3_turns_local_media_into_data_uris(tmp_path):
    path = get_run_dir() / "ref.png"
    path.write_bytes(b"\x89PNG\r\n\x1a\n")
    assert minimax_v2.media_url(str(path), "image").startswith("data:image/png;base64,")
    assert minimax_v2.media_url("https://example.com/a.png", "image") == "https://example.com/a.png"


# -- Meshy 7 on Meshy's API -----------------------------------------------------------

MESHY = {"MESHY_API_KEY": "fixture-meshy"}
MESHY_BASE = "https://api.meshy.ai/openapi"


def _meshy_task(router, path, task_id):
    router.get(f"{MESHY_BASE}{path}/{task_id}").mock(return_value=httpx.Response(200, json={
        "status": "SUCCEEDED", "model_urls": {"glb": f"https://assets.example.com/{task_id}.glb"}}))


@pytest.mark.asyncio
async def test_meshy_7_text_mode_previews_then_refines_on_meshy():
    params = {**_defaults("krea-3d-meshy-meshy-7"), "input_mode": "text", "prompt": "a teapot", "seed": 42.0,
              "target_polycount": 20000.0, "enable_pbr": True}
    node = GraphNode(id="m", definitionId="krea-3d-meshy-meshy-7", params=params)
    before = copy.deepcopy(node.params)
    with respx.mock() as router, patch("services.output.save_mesh_from_url", _fake_mesh):
        submit = router.post(f"{MESHY_BASE}/v2/text-to-3d").mock(side_effect=[
            httpx.Response(200, json={"result": "p1"}), httpx.Response(200, json={"result": "r1"})])
        _meshy_task(router, "/v2/text-to-3d", "p1")
        _meshy_task(router, "/v2/text-to-3d", "r1")
        result = await _run(node, {}, {**MESHY, **KREA})
    assert node.params == before
    assert set(result) == {"mesh", "meshes", "artifacts"}
    preview, refine = (json.loads(call.request.content) for call in submit.calls)
    assert preview == {"mode": "preview", "prompt": "a teapot", "ai_model": "meshy-7", "target_polycount": 20000,
                       "seed": 42}
    assert refine == {"mode": "refine", "preview_task_id": "p1", "ai_model": "meshy-7",
                      "target_polycount": 20000, "enable_pbr": True}


@pytest.mark.asyncio
async def test_meshy_7_without_texture_is_the_preview_alone():
    params = {**_defaults("krea-3d-meshy-meshy-7"), "input_mode": "text", "generate_texture": False}
    node = GraphNode(id="m", definitionId="krea-3d-meshy-meshy-7", params=params)
    with respx.mock() as router, patch("services.output.save_mesh_from_url", _fake_mesh):
        submit = router.post(f"{MESHY_BASE}/v2/text-to-3d").mock(return_value=httpx.Response(200, json={"result": "p"}))
        _meshy_task(router, "/v2/text-to-3d", "p")
        await _run(node, PROMPT, MESHY)
    assert submit.call_count == 1


@pytest.mark.asyncio
@pytest.mark.parametrize("images,path", [(["https://example.com/a.png"], "/v1/image-to-3d"),
                                         ([f"https://example.com/{i}.png" for i in range(3)],
                                          "/v1/multi-image-to-3d")])
async def test_meshy_7_image_mode_picks_single_or_multi_image(images, path):
    params = {**_defaults("krea-3d-meshy-meshy-7"), "seed": 5, "prompt": "ignored", "generate_texture": False}
    node = GraphNode(id="m", definitionId="krea-3d-meshy-meshy-7", params=params)
    with respx.mock() as router, patch("services.output.save_mesh_from_url", _fake_mesh):
        submit = router.post(f"{MESHY_BASE}{path}").mock(return_value=httpx.Response(200, json={"result": "i"}))
        _meshy_task(router, path, "i")
        await _run(node, {"image_urls": PortValueDict(type="Image", value=images)}, MESHY)
    body = json.loads(submit.calls.last.request.content)
    image_field = {"image_url": images[0]} if len(images) == 1 else {"image_urls": images}
    # No seed or prompt: Meshy's image routes document neither.
    assert body == {**image_field, "ai_model": "meshy-7", "should_texture": False}


@pytest.mark.asyncio
@pytest.mark.parametrize("count,path", [(1, "/v1/image-to-3d"), (2, "/v1/multi-image-to-3d")])
async def test_meshy_7_sends_saved_output_refs_as_data_uris(count, path):
    # A saved graph's image_urls JSON carries /api/outputs/... refs (the Krea route resolves them);
    # Meshy can't fetch those, and the Meshy handlers read only plain local paths.
    from services.output import portable_output_ref

    refs = []
    for index in range(count):
        image = get_run_dir() / f"meshy-ref-{index}.png"
        image.write_bytes(b"\x89PNG\r\n\x1a\n")
        refs.append(portable_output_ref(str(image)))
    assert all(ref.startswith("/api/outputs/") for ref in refs)
    params = {**_defaults("krea-3d-meshy-meshy-7"), "image_urls": json.dumps(refs)}
    node = GraphNode(id="m", definitionId="krea-3d-meshy-meshy-7", params=params)
    with respx.mock() as router, patch("services.output.save_mesh_from_url", _fake_mesh):
        submit = router.post(f"{MESHY_BASE}{path}").mock(return_value=httpx.Response(200, json={"result": "i"}))
        _meshy_task(router, path, "i")
        await _run(node, {}, MESHY)
    body = json.loads(submit.calls.last.request.content)
    sent = [body["image_url"]] if count == 1 else body["image_urls"]
    assert len(sent) == count and all(value.startswith("data:image/png;base64,") for value in sent)


@pytest.mark.asyncio
async def test_meshy_7_refuses_more_images_than_meshy_takes():
    node = GraphNode(id="m", definitionId="krea-3d-meshy-meshy-7", params=_defaults("krea-3d-meshy-meshy-7"))
    images = PortValueDict(type="Image", value=[f"https://example.com/{i}.png" for i in range(5)])
    with respx.mock() as router:
        with pytest.raises(ValueError, match="1 to 4 images"):
            await _run(node, {"image_urls": images}, MESHY)
    assert not router.calls


@pytest.mark.asyncio
async def test_meshy_7_names_the_entitlement_rule_when_meshy_refuses():
    node = GraphNode(id="m", definitionId="krea-3d-meshy-meshy-7", params=_defaults("krea-3d-meshy-meshy-7"))
    with respx.mock() as router:
        router.post(f"{MESHY_BASE}/v1/image-to-3d").mock(return_value=httpx.Response(403, json={"message": "no"}))
        with pytest.raises(RuntimeError, match="entitlement"):
            await _run(node, {"image_urls": START}, MESHY)


# -- route rules and prices -----------------------------------------------------------


def test_unsupported_rules_read_defaults_and_saved_values():
    definition = DEFINITIONS["krea-video-minimax-hailuo-02"]
    assert node_route.direct_block(definition, {}) is None  # 768p, 6 s by default
    block = node_route.direct_block(definition, {"duration": 7.5})
    assert block == node_route.DirectBlock(node_route.UNSUPPORTED, "duration", None,
                                           "durations other than 6 or 10 seconds")
    assert node_route.direct_block(definition, {"duration": 10.0}) is None
    assert node_route.direct_block(definition, {"resolution": "1080p", "duration": 10}).detail == "1080p at 10 seconds"


@pytest.mark.parametrize("definition_id,params,expected", [
    ("krea-video-minimax-hailuo-02", {"resolution": "768p", "duration": 10}, (0.56, 0.56)),
    ("krea-video-minimax-hailuo-02", {"resolution": "512p", "duration": 6}, (0.10, 0.10)),
    ("krea-video-minimax-hailuo-2-3-fast", {}, (0.19, 0.19)),
    ("krea-video-minimax-hailuo-3", {}, (0.65, 2.76)),
    ("krea-video-minimax-hailuo-3", {"resolution": "768P", "duration": 15}, (1.2, 2.56)),
])
def test_direct_route_prices_are_minimax_list_prices(definition_id, params, expected):
    pricing = model_pricing.load_pricing()
    definition = DEFINITIONS[definition_id]
    values = {**_defaults(definition_id), **params}
    provider = model_pricing.route_provider(definition, {**MINIMAX, **KREA}, values)
    assert provider == "minimax"
    estimate = model_pricing.estimate_node(pricing["nodes"][definition_id], definition, values, provider)
    assert (round(estimate["low"], 4), round(estimate["high"], 4)) == expected
    # The Krea plan bills workspace compute units, unpriced.
    plan = {**values, "_kreaAuth": "mcp"}
    assert model_pricing.estimate_node(pricing["nodes"][definition_id], definition, plan,
                                       model_pricing.route_provider(definition, {**MINIMAX, **KREA}, plan)) is None


def test_every_translation_is_registered_and_pinned_to_a_documented_model():
    from execution import maker_routes

    routed = {node_id: definition["directRoute"] for node_id, definition in DEFINITIONS.items()
              if (definition.get("directRoute") or {}).get("translation") in mm.TRANSLATIONS}
    assert {node_id: spec["model"] for node_id, spec in routed.items()} == {
        "krea-video-minimax-hailuo-02": "MiniMax-Hailuo-02",
        "krea-video-minimax-hailuo-2-3": "MiniMax-Hailuo-2.3",
        "krea-video-minimax-hailuo-2-3-fast": "MiniMax-Hailuo-2.3-Fast",
        "krea-video-minimax-hailuo-3": "MiniMax-H3",
        "krea-3d-meshy-meshy-7": "meshy-7",
    }
    for translation in mm.TRANSLATIONS:
        assert maker_routes.KREA_TRANSLATIONS[translation] == mm.TRANSLATIONS[translation]
