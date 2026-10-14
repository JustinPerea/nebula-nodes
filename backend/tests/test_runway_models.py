"""Runway per-model limits, retired models, the upload flow and pricing.

Limits come from Runway's request schema (https://docs.dev.runwayml.com/openapi.json),
retirements from its changelog (llms-full.txt) and prices from guides/pricing.md,
all read 2026-10-14. No test reaches Runway: submits and uploads are mocked.
"""
from __future__ import annotations

import json
from pathlib import Path
from unittest.mock import AsyncMock, patch

import httpx
import pytest

import handlers.runway as runway
from handlers.runway import (
    DATA_URI_LIMIT,
    RUNWAY_API_BASE,
    RUNWAY_IMAGE_MODELS,
    RUNWAY_VIDEO_MODELS,
    handle_runway_aleph,
    handle_runway_image,
    handle_runway_video,
)
from models.graph import GraphNode, PortValueDict
from services.retired_nodes import migrate_node

REPO = Path(__file__).resolve().parents[2]
DEFS = json.loads((REPO / "backend" / "data" / "node_definitions.json").read_text())
KEY = {"RUNWAY_API_KEY": "rw-test"}
PNG = bytes.fromhex(
    "89504e470d0a1a0a0000000d4948445200000001000000010806000000"
    "1f15c4890000000d49444154789c63f8ffff3f0005fe02fea7d6a4c50000000049454e44ae426082"
)


def _node(def_id: str, **params):
    return GraphNode(id="rw", definitionId=def_id, params=params)


def _text(value: str) -> PortValueDict:
    return PortValueDict(type="Text", value=value)


def _image(tmp_path: Path) -> PortValueDict:
    path = tmp_path / "frame.png"
    path.write_bytes(PNG)
    return PortValueDict(type="Image", value=str(path))


def _visible(option: dict, model: str) -> bool:
    return model in option.get("visibleWhen", {}).get("model", [model])


def _param(def_id: str, key: str) -> dict:
    return next(p for p in DEFS[def_id]["params"] if p["key"] == key)


async def _video_body(node, inputs):
    with patch("handlers.runway.async_poll_execute", new_callable=AsyncMock) as poll, \
            patch("handlers.runway.save_video_from_url", new_callable=AsyncMock) as save:
        poll.return_value = {"id": "t", "status": "SUCCEEDED", "output": ["https://ex.com/v.mp4"]}
        save.return_value = Path("/tmp/v.mp4")
        await handle_runway_video(node, inputs, KEY)
    return poll.call_args.kwargs["submit_body"], poll.call_args.kwargs["config"].submit_url


async def _rejected_video(node, inputs, match):
    with patch("handlers.runway.async_poll_execute", new_callable=AsyncMock) as poll:
        with pytest.raises(ValueError, match=match):
            await handle_runway_video(node, inputs, KEY)
    poll.assert_not_called()


# -- definition <-> handler parity ---------------------------------------------


def test_video_definition_offers_exactly_what_each_model_takes():
    models = [o["value"] for o in _param("runway-video", "model")["options"]]
    assert sorted(models) == sorted(RUNWAY_VIDEO_MODELS)
    assert _param("runway-video", "model")["default"] == "gen4.5"
    for model, spec in RUNWAY_VIDEO_MODELS.items():
        ratios = {o["value"] for o in _param("runway-video", "ratio")["options"] if _visible(o, model)}
        assert ratios == set(spec["i2v_ratios"] or ()) | set(spec["t2v_ratios"] or ()), model
        durations = {o["value"] for o in _param("runway-video", "duration")["options"] if _visible(o, model)}
        assert durations == set(spec["durations"]) | ({"auto"} if spec["auto"] else set()), model
        assert _visible(_param("runway-video", "audio"), model) == spec["audio"], model
        assert _visible(_param("runway-video", "seed"), model) == spec["seed"], model
        assert _visible(_param("runway-video", "resolution"), model) == bool(spec["resolution"]), model


def test_video_definition_dropped_retired_models_and_kept_the_order():
    models = [o["value"] for o in _param("runway-video", "model")["options"]]
    assert models == ["gen4.5", "seedance2", "seedance2_fast", "happyhorse_1_0", "gen4_turbo",
                      "veo3.1", "veo3.1_fast", "seedance2_mini", "seedance2_5"]
    aleph = _param("runway-aleph", "model")
    assert aleph["default"] == "aleph2"
    assert [o["value"] for o in aleph["options"]] == ["aleph2"]


def test_image_definition_offers_exactly_what_each_model_takes():
    models = [o["value"] for o in _param("runway-image", "model")["options"]]
    assert models == list(RUNWAY_IMAGE_MODELS)
    for model, spec in RUNWAY_IMAGE_MODELS.items():
        ratios = [o["value"] for o in _param("runway-image", "ratio")["options"] if _visible(o, model)]
        assert set(ratios) == set(spec["ratios"]), model
        assert _visible(_param("runway-image", "seed"), model) == spec["seed"], model
        assert _visible(_param("runway-image", "grounding"), model) == spec["grounding"], model


# -- runway-video validation and bodies ---------------------------------------


@pytest.mark.asyncio
async def test_veo31_rejects_the_old_defaults_before_submitting():
    node = _node("runway-video", model="veo3.1", duration=5, ratio="1280:720")
    await _rejected_video(node, {"prompt": _text("rain")}, r"Veo 3\.1 takes a duration of 4, 6, 8 s; got 5")
    node = _node("runway-video", model="veo3.1_fast", duration=8, ratio="1104:832")
    await _rejected_video(node, {"prompt": _text("rain")}, "Ratio '1104:832' isn't available for Veo 3.1 Fast")


@pytest.mark.asyncio
async def test_veo31_text_to_video_sends_1080p_and_audio_off():
    body, url = await _video_body(
        _node("runway-video", model="veo3.1", duration=8, ratio="1920:1080", audio=False, seed=7),
        {"prompt": _text("rain")},
    )
    assert url == f"{RUNWAY_API_BASE}/text_to_video"
    assert body == {"model": "veo3.1", "promptText": "rain", "ratio": "1920:1080", "duration": 8,
                    "audio": False, "seed": 7}


@pytest.mark.asyncio
async def test_seedance_durations_ratios_and_auto():
    await _rejected_video(_node("runway-video", model="seedance2_mini", duration=3),
                          {"prompt": _text("x")}, "4-15 s or auto")
    await _rejected_video(_node("runway-video", model="seedance2_fast", duration=8, ratio="1920:1080"),
                          {"prompt": _text("x")}, "isn't available for Seedance 2.0 Fast")
    body, _ = await _video_body(_node("runway-video", model="seedance2", duration="auto", ratio="3840:2160"),
                                {"prompt": _text("x")})
    assert body["duration"] == "auto" and body["ratio"] == "3840:2160"
    body, _ = await _video_body(_node("runway-video", model="seedance2_5", duration="30", ratio="854:480"),
                                {"prompt": _text("x" * 20000)})
    assert body["duration"] == 30 and len(body["promptText"]) == 15000
    await _rejected_video(_node("runway-video", model="gen4.5", duration="auto"),
                          {"prompt": _text("x")}, "no automatic duration")


@pytest.mark.asyncio
async def test_seedance_image_to_video_carries_ratio_audio_and_seed(tmp_path):
    body, url = await _video_body(
        _node("runway-video", model="seedance2_mini", duration=6, ratio="640:640", audio=True, seed=3),
        {"image": _image(tmp_path)},
    )
    assert url.endswith("/image_to_video")
    assert body["ratio"] == "640:640" and body["audio"] is True and body["seed"] == 3
    assert body["promptImage"].startswith("data:image/png;base64,")


@pytest.mark.asyncio
async def test_happyhorse_image_to_video_sends_resolution_not_ratio_or_seed(tmp_path):
    body, _ = await _video_body(
        _node("runway-video", model="happyhorse_1_0", duration=12, ratio="1104:832", resolution="1080p", seed=9),
        {"image": _image(tmp_path)},
    )
    assert body["resolution"] == "1080p"
    assert "ratio" not in body and "seed" not in body and "audio" not in body
    body, _ = await _video_body(_node("runway-video", model="happyhorse_1_0", duration=3, ratio="1920:1080"),
                                {"prompt": _text("gallop")})
    assert body["ratio"] == "1920:1080" and "resolution" not in body
    await _rejected_video(_node("runway-video", model="happyhorse_1_0", duration=2),
                          {"prompt": _text("gallop")}, "3-15 s")


@pytest.mark.asyncio
async def test_gen45_image_to_video_needs_a_prompt(tmp_path):
    await _rejected_video(_node("runway-video", model="gen4.5", duration=5), {"image": _image(tmp_path)},
                          "needs a text prompt")


@pytest.mark.asyncio
@pytest.mark.parametrize("model", ["gen3a_turbo", "veo3"])
async def test_retired_video_models_say_what_to_use(model):
    await _rejected_video(_node("runway-video", model=model), {"prompt": _text("x")}, "Runway")


@pytest.mark.asyncio
async def test_gen4_turbo_without_an_image_says_so():
    await _rejected_video(_node("runway-video", model="gen4_turbo", duration=5), {"prompt": _text("x")},
                          "requires an image input.*Gen-3a Turbo now use Gen-4 Turbo")


@pytest.mark.asyncio
async def test_retired_aleph_model_is_refused():
    with patch("handlers.runway.async_poll_execute", new_callable=AsyncMock) as poll:
        with pytest.raises(ValueError, match="aleph2"):
            await handle_runway_aleph(_node("runway-aleph", model="gen4_aleph"),
                                      {"video": PortValueDict(type="Video", value="https://ex.com/v.mp4"),
                                       "prompt": _text("x")}, KEY)
    poll.assert_not_called()


# -- runway-image -------------------------------------------------------------


async def _image_body(node, inputs):
    with patch("handlers.runway.async_poll_execute", new_callable=AsyncMock) as poll, \
            patch("handlers.runway.httpx.AsyncClient") as client_cls, \
            patch("handlers.runway.save_base64_image", return_value=Path("/tmp/i.png")):
        poll.return_value = {"id": "t", "status": "SUCCEEDED", "output": ["https://ex.com/i.png"]}
        client = AsyncMock()
        client.__aenter__.return_value = client
        client.get.return_value = httpx.Response(200, content=PNG, request=httpx.Request("GET", "https://ex.com"))
        client_cls.return_value = client
        await handle_runway_image(node, inputs, KEY)
    return poll.call_args.kwargs["submit_body"]


async def _rejected_image(node, inputs, match):
    with patch("handlers.runway.async_poll_execute", new_callable=AsyncMock) as poll:
        with pytest.raises(ValueError, match=match):
            await handle_runway_image(node, inputs, KEY)
    poll.assert_not_called()


@pytest.mark.asyncio
async def test_image_models_reject_ratios_they_dont_take():
    for model in ("gpt_image_2", "gemini_image3_pro", "gemini_2.5_flash", "seedream5_pro", "seedream5_lite"):
        await _rejected_image(_node("runway-image", model=model, ratio="1360:768"), {"prompt": _text("cat")},
                              "Ratio '1360:768' isn't available")


@pytest.mark.asyncio
async def test_gpt_image_2_leaves_out_a_stale_seed():
    body = await _image_body(_node("runway-image", model="gpt_image_2", ratio="auto", seed=4),
                             {"prompt": _text("cat")})
    assert body == {"model": "gpt_image_2", "promptText": "cat", "ratio": "auto"}


@pytest.mark.asyncio
async def test_seedream_pro_sends_grounding_and_up_to_ten_references(tmp_path):
    refs = PortValueDict(type="Image", value=[_image(tmp_path).value] * 10)
    body = await _image_body(_node("runway-image", model="seedream5_pro", ratio="auto_2k", grounding=True),
                             {"prompt": _text("poster"), "images": refs})
    assert body["grounding"] is True and len(body["referenceImages"]) == 10 and "seed" not in body
    too_many = PortValueDict(type="Image", value=[_image(tmp_path).value] * 11)
    await _rejected_image(_node("runway-image", model="seedream5_pro", ratio="auto_2k"),
                          {"prompt": _text("poster"), "images": too_many}, "up to 10 reference images")


@pytest.mark.asyncio
async def test_seedream_lite_takes_its_2k_sizes():
    body = await _image_body(_node("runway-image", model="seedream5_lite", ratio="4704:2016"),
                             {"prompt": _text("wide")})
    assert body["ratio"] == "4704:2016" and "grounding" not in body


@pytest.mark.asyncio
async def test_gen4_image_turbo_needs_a_reference():
    await _rejected_image(_node("runway-image", model="gen4_image_turbo", ratio="1360:768"),
                          {"prompt": _text("cat")}, "at least 1 reference image")


# -- local media: data URI under 5MB, ephemeral upload above --------------------


def _upload_transport(calls: list[httpx.Request]):
    def handler(request: httpx.Request) -> httpx.Response:
        calls.append(request)
        if request.url == httpx.URL(f"{RUNWAY_API_BASE}/uploads"):
            return httpx.Response(200, json={"uploadUrl": "https://uploads.example/bucket",
                                             "fields": {"key": "abc", "policy": "p"},
                                             "runwayUri": "runway://upload-token"})
        if request.url.host == "uploads.example":
            return httpx.Response(204)
        raise AssertionError(f"unexpected request {request.url}")
    return httpx.MockTransport(handler)


@pytest.mark.asyncio
async def test_aleph_uploads_a_local_video_over_the_data_uri_cap(tmp_path):
    video = tmp_path / "clip.mp4"
    with video.open("wb") as handle:
        handle.truncate(DATA_URI_LIMIT)  # base64 makes this ~6.7MB, over the cap
    calls: list[httpx.Request] = []
    real_client = httpx.AsyncClient
    transport = _upload_transport(calls)
    with patch("handlers.runway.async_poll_execute", new_callable=AsyncMock) as poll, \
            patch("handlers.runway.save_video_from_url", new_callable=AsyncMock, return_value=Path("/tmp/v.mp4")), \
            patch.object(runway.httpx, "AsyncClient", side_effect=lambda **kw: real_client(transport=transport, **kw)):
        poll.return_value = {"id": "t", "status": "SUCCEEDED", "output": ["https://ex.com/v.mp4"]}
        await handle_runway_aleph(_node("runway-aleph"),
                                  {"video": PortValueDict(type="Video", value=str(video)), "prompt": _text("snow")},
                                  KEY)
    body = poll.call_args.kwargs["submit_body"]
    assert body["videoUri"] == "runway://upload-token"
    start, upload = calls
    assert json.loads(start.content) == {"filename": "clip.mp4", "type": "ephemeral"}
    assert start.headers["Authorization"] == "Bearer rw-test"
    assert start.headers["X-Runway-Version"] == "2024-11-06"
    assert "Authorization" not in upload.headers, "the storage URL never gets the API key"
    form = upload.read()
    assert b'name="key"' in form and b"abc" in form and b'name="file"; filename="clip.mp4"' in form


@pytest.mark.asyncio
async def test_small_local_video_stays_a_data_uri_and_https_passes_through(tmp_path):
    video = tmp_path / "small.mp4"
    video.write_bytes(b"\x00" * 2048)
    network = AsyncMock(side_effect=AssertionError("no upload for a small file"))
    assert (await runway._local_media_uri(str(video), "video/mp4", "k")).startswith("data:video/mp4;base64,")
    with patch.object(runway, "_upload_ephemeral", network):
        assert await runway._local_media_uri("https://cdn.example/v.mp4", "video/mp4", "k") == "https://cdn.example/v.mp4"
        assert await runway._local_media_uri("runway://abc", "video/mp4", "k") == "runway://abc"
    network.assert_not_called()


def test_data_uri_cap_counts_the_encoded_length():
    # The largest file whose data URI still fits, and the first that doesn't.
    header = len("data:video/mp4;base64,")
    fits = (DATA_URI_LIMIT - header) // 4 * 3
    assert runway._data_uri_length(fits, "video/mp4") <= DATA_URI_LIMIT
    assert runway._data_uri_length(fits + 1, "video/mp4") > DATA_URI_LIMIT


@pytest.mark.asyncio
async def test_uploads_over_200mb_are_refused_before_any_request(tmp_path):
    video = tmp_path / "huge.mp4"
    with video.open("wb") as handle:
        handle.truncate(runway.UPLOAD_LIMIT + 1)
    with patch.object(runway.httpx, "AsyncClient", side_effect=AssertionError("no request")):
        with pytest.raises(ValueError, match="up to 200MB"):
            await runway._local_media_uri(str(video), "video/mp4", "k")


# -- saved graphs ---------------------------------------------------------------


@pytest.mark.parametrize("params,expected", [
    ({"model": "gen3a_turbo", "duration": 10, "ratio": "1280:720"},
     {"model": "gen4_turbo", "duration": 10, "ratio": "1280:720"}),
    ({"model": "veo3", "duration": 5}, {"model": "veo3.1", "duration": 6}),
    ({"model": "veo3", "duration": "10"}, {"model": "veo3.1", "duration": 8}),
    ({"model": "veo3", "duration": 2}, {"model": "veo3.1", "duration": 4}),
    ({"model": "veo3"}, {"model": "veo3.1"}),
    ({"model": "gen4.5", "duration": 5}, {"model": "gen4.5", "duration": 5}),
    ({}, {}),
])
def test_saved_runway_video_nodes_leave_retired_models(params, expected):
    assert migrate_node("runway-video", params, "My clip") == ("runway-video", expected, "My clip")


def test_saved_runway_aleph_nodes_move_to_aleph2():
    assert migrate_node("runway-aleph", {"model": "gen4_aleph", "seed": 1}) == (
        "runway-aleph", {"model": "aleph2", "seed": 1}, None)
    assert migrate_node("runway-aleph", {})[1] == {}
