"""Real gateway request/upload/poll/download loop with isolated mocked HTTP.

No provider credentials or paid jobs are used. Video artifacts are locally
encoded and decoded with the existing FFmpeg tools, when available.
"""
from __future__ import annotations

import asyncio
import base64
import copy
import io
import json
import shutil
import subprocess
from pathlib import Path
from unittest.mock import AsyncMock

import httpx
import pytest
import respx
from jsonschema import Draft202012Validator
from PIL import Image

from handlers import krea_gateway as gateway
from models.graph import GraphEdge, GraphNode, PortValueDict
from services import cancellation
from services import output as output_service


IMAGE_ID = "krea-image-openai-gpt-image-2"
VIDEO_ID = "krea-video-google-veo-3-1"
SEEDANCE_ID = "krea-video-bytedance-seedance-2"
MUSIC_ID = "krea-audio-elevenlabs-music-v2-5"
UPSCALE_ID = "krea-enhance-magnific-precise-enhance"
VIDEO_UPSCALE_ID = "krea-enhance-topaz-astra"
MESH_ID = "krea-3d-microsoft-trellis-2"
IMAGE_URL = "https://cdn.example.test/artwork.png"
API_KEY = "synthetic-krea-token"


def png(color=(25, 190, 210, 130)) -> bytes:
    out = io.BytesIO()
    Image.new("RGBA", (12, 8), color).save(out, format="PNG")
    return out.getvalue()


def node(definition_id=IMAGE_ID, params=None):
    return GraphNode(id="gateway-test", definitionId=definition_id, params=params or {})


def port(value, media_type="Text"):
    return PortValueDict(type=media_type, value=value)


def completed(urls=None):
    return {"job_id": "job-1", "status": "completed", "result": {"urls": urls or [IMAGE_URL]}}


def local_output(value):
    return Path(output_service.resolve_output_ref(value))


@pytest.fixture(autouse=True)
def isolated_files_and_fast_poll(monkeypatch, tmp_path):
    import execution.engine as engine
    import handlers.krea as legacy
    import services.cache as cache_service
    for module in (output_service, engine, legacy, cache_service):
        monkeypatch.setattr(module, "OUTPUT_ROOT", tmp_path)
    monkeypatch.setattr(gateway, "get_run_dir", lambda: tmp_path)
    monkeypatch.setattr(gateway, "POLL_INTERVAL", 0)
    return tmp_path


@pytest.fixture(scope="module")
def tiny_video(tmp_path_factory):
    if not shutil.which("ffmpeg") or not shutil.which("ffprobe"):
        pytest.skip("Video artifact validation needs the existing ffmpeg/ffprobe binaries")
    target = tmp_path_factory.mktemp("krea-video") / "fixture.mp4"
    subprocess.run(["ffmpeg", "-y", "-v", "error", "-f", "lavfi", "-i",
                    "color=cyan:size=16x16:rate=5", "-t", "0.2", "-pix_fmt", "yuv420p", str(target)],
                   check=True, capture_output=True)
    return target.read_bytes()


def submit(router, definition_id=IMAGE_ID, response=None):
    model = gateway.catalog_models()[definition_id]
    return router.post(gateway.KREA_BASE_URL + model["endpoint"]).mock(
        return_value=httpx.Response(200, json=response or completed()))


def download(router, url=IMAGE_URL, body=None, mime="image/png"):
    return router.get(url).mock(return_value=httpx.Response(200, content=body or png(), headers={"content-type": mime}))


async def drain_cancellations():
    tasks = tuple(cancellation._pending_cancel_tasks)
    if tasks:
        await asyncio.gather(*tasks)


def test_all_bundled_routes_have_valid_schemas_and_registered_handlers():
    from execution.sync_runner import get_handler_registry
    models = gateway.catalog_models()
    assert len(models) == 108
    handlers = get_handler_registry()
    for definition_id, model in models.items():
        Draft202012Validator.check_schema(model["requestSchema"])
        assert definition_id in handlers
        assert gateway._model(definition_id) is model
    assert "krea-2-generate" in get_handler_registry(emit=AsyncMock())
    assert "krea-style-train" in get_handler_registry(emit=AsyncMock())


@pytest.mark.asyncio
async def test_image_job_preserves_every_result_and_never_sends_token_to_cdn():
    urls = [IMAGE_URL, "https://cdn.example.test/artwork-2.png"]
    with respx.mock as router:
        posted = submit(router, response={"job_id": "job-1", "status": "queued"})
        polled = router.get(gateway.KREA_BASE_URL + "/jobs/job-1").mock(return_value=httpx.Response(200, json=completed(urls)))
        downloads = [download(router, url) for url in urls]
        result = await gateway.handle_krea_gateway(node(params={"prompt": "stale", "quality": "high"}),
            {"prompt": port("A cyan logo")}, {"KREA_API_TOKEN": API_KEY, "FAL_KEY": "unused"}, emit=AsyncMock())
    assert json.loads(posted.calls[0].request.content) == {"prompt": "A cyan logo", "quality": "high"}
    assert posted.calls[0].request.headers["Authorization"] == f"Bearer {API_KEY}"
    assert polled.calls[0].request.headers["Authorization"] == f"Bearer {API_KEY}"
    assert result["image"]["type"] == "Image"
    assert result["images"]["type"] == "Array"
    assert Path(result["image"]["value"]) == local_output(result["images"]["value"][0])
    assert len(result["images"]["value"]) == 2
    assert all(path.startswith("/api/outputs/") and local_output(path).read_bytes() == png() for path in result["images"]["value"])
    assert result["job"]["value"] == completed(urls)
    assert all("authorization" not in route.calls[0].request.headers for route in downloads)


@pytest.mark.asyncio
async def test_music_job_returns_local_audio_and_never_sends_token_to_cdn():
    url = "https://cdn.example.test/track.mp3"
    track = b"ID3" + bytes(64)
    with respx.mock as router:
        posted = submit(router, MUSIC_ID, completed([url]))
        fetched = download(router, url, track, "audio/mpeg")
        result = await gateway.handle_krea_gateway(node(MUSIC_ID, {"music_length_ms": 40000, "force_instrumental": True}),
            {"prompt": port("Quiet ambient pulse")}, {"KREA_API_TOKEN": API_KEY})
    assert json.loads(posted.calls[0].request.content) == {
        "music_length_ms": 40000, "force_instrumental": True, "prompt": "Quiet ambient pulse"}
    assert result["audio"]["type"] == "Audio"
    assert Path(result["audio"]["value"]).suffix == ".mp3"
    assert Path(result["audio"]["value"]).read_bytes() == track
    assert result["audios"]["value"] == [output_service.portable_output_ref(result["audio"]["value"], require_file=True)]
    assert result["artifacts"]["value"][0]["type"] == "Audio"
    assert "authorization" not in fetched.calls[0].request.headers


@pytest.mark.asyncio
async def test_tagged_audio_result_on_video_route_is_not_mislabeled_as_video(tiny_video):
    urls = {"video": "https://cdn.example.test/movie.mp4", "audio": "https://cdn.example.test/score.mp3"}
    with respx.mock as router:
        submit(router, VIDEO_ID, completed(urls))
        download(router, urls["video"], tiny_video, "video/mp4")
        download(router, urls["audio"], b"ID3" + bytes(64), "audio/mpeg")
        result = await gateway.handle_krea_gateway(node(VIDEO_ID, {"prompt": "animate"}), {}, {"KREA_API_TOKEN": API_KEY})
    assert [artifact["type"] for artifact in result["artifacts"]["value"]] == ["Video", "Audio"]
    assert len(result["videos"]["value"]) == 1


@pytest.mark.asyncio
@pytest.mark.parametrize("served_ref", [False, True])
async def test_immutable_paper_png_upload_and_connected_array_override(tmp_path, monkeypatch, served_ref):
    import handlers.krea as legacy
    monkeypatch.setattr(legacy, "OUTPUT_ROOT", tmp_path)
    source = tmp_path / "paper-sources" / ("a" * 64 + ".png")
    source.parent.mkdir()
    source.write_bytes(png())
    reference = "/api/outputs/paper-sources/" + source.name if served_ref else str(source)
    with respx.mock as router:
        asset = router.post(gateway.KREA_BASE_URL + "/assets").mock(
            return_value=httpx.Response(200, json={"image_url": "https://assets.krea.ai/paper.png"}))
        posted = submit(router)
        download(router)
        result = await gateway.handle_krea_gateway(node(params={"prompt": "logo", "image_urls": "invalid stale JSON"}),
            {"image_urls": port(reference, "Image")}, {"KREA_API_TOKEN": API_KEY})
    body = json.loads(posted.calls[0].request.content)
    assert body["image_urls"] == ["https://assets.krea.ai/paper.png"]
    assert png() in asset.calls[0].request.content
    assert source.read_bytes() == png()
    assert result["image"]["value"] != str(source)


@pytest.mark.asyncio
async def test_nested_json_effect_media_is_uploaded_once(tmp_path, tiny_video):
    source = tmp_path / "reference.png"
    source.write_bytes(png())
    effect = {"id": "11111111-1111-4111-8111-111111111111", "name": "Cyan", "asset_url": str(source), "asset_type": "image"}
    video_url = "https://cdn.example.test/output.mp4"
    with respx.mock as router:
        asset = router.post(gateway.KREA_BASE_URL + "/assets").mock(
            return_value=httpx.Response(200, json={"image_url": "https://assets.krea.ai/cyan.png"}))
        posted = submit(router, SEEDANCE_ID, completed([video_url]))
        output = download(router, video_url, tiny_video, "video/mp4")
        result = await gateway.handle_krea_gateway(node(SEEDANCE_ID, {"prompt": "animate", "effects": json.dumps([effect]), "duration": 4}),
            {"start_image": port(str(source), "Image")}, {"KREA_API_TOKEN": API_KEY})
    body = json.loads(posted.calls[0].request.content)
    assert body["effects"][0]["asset_url"] == "https://assets.krea.ai/cyan.png"
    assert body["start_image"] == body["effects"][0]["asset_url"]
    assert asset.call_count == 1
    assert result["video"]["type"] == "Video"
    assert Path(result["video"]["value"]).suffix == ".mp4"
    assert Path(result["video"]["value"]).read_bytes() == tiny_video
    assert result["videos"]["value"] == [output_service.portable_output_ref(result["video"]["value"], require_file=True)]
    assert "authorization" not in output.calls[0].request.headers


@pytest.mark.asyncio
async def test_video_requests_use_current_snake_case_and_preserve_all_outputs(tiny_video):
    urls = ["https://cdn.example.test/movie-1.mp4", "https://cdn.example.test/movie-2.mp4"]
    with respx.mock as router:
        posted = submit(router, VIDEO_ID, completed(urls))
        for url in urls:
            download(router, url, tiny_video, "video/mp4")
        result = await gateway.handle_krea_gateway(node(VIDEO_ID, {"prompt": "animate", "duration": 4, "generate_audio": False,
            "aspect_ratio": "16:9", "end_image": None, "_sourceDuration": 8, "_sourceFps": 30, "_sourceIsVfr": False}),
            {"start_image": port("https://assets.example.test/start.png", "Image")}, {"KREA_API_TOKEN": API_KEY})
    assert json.loads(posted.calls[0].request.content) == {"prompt": "animate", "duration": 4, "generate_audio": False,
        "aspect_ratio": "16:9", "end_image": None, "start_image": "https://assets.example.test/start.png"}
    assert len(result["videos"]["value"]) == 2
    assert all(path.startswith("/api/outputs/") and local_output(path).read_bytes() == tiny_video for path in result["videos"]["value"])


@pytest.mark.asyncio
async def test_base64_media_is_uploaded_before_generate():
    reference = "data:image/png;base64," + base64.b64encode(png()).decode()
    with respx.mock as router:
        asset = router.post(gateway.KREA_BASE_URL + "/assets").mock(return_value=httpx.Response(200, json={"image_url": "https://assets.krea.ai/ref.png"}))
        posted = submit(router)
        download(router)
        await gateway.handle_krea_gateway(node(params={"prompt": "reference", "image_urls": json.dumps([reference])}), {}, {"KREA_API_TOKEN": API_KEY})
    assert png() in asset.calls[0].request.content
    assert json.loads(posted.calls[0].request.content)["image_urls"] == ["https://assets.krea.ai/ref.png"]


@pytest.mark.asyncio
@pytest.mark.parametrize("params,inputs,match", [
    ({"quality": "ultra"}, {}, "quality"),
    ({"width": True}, {}, "width"),
    ({"image_urls": "not JSON"}, {}, "expected JSON"),
    ({"image_urls": json.dumps(["https://example.test/a.png"] * 11)}, {}, "image_urls"),
    ({"endpoint_id": "https://attacker.test/generate"}, {}, "Unknown"),
    ({"anything": ""}, {}, "Unknown"),
    ({"_invented": 1}, {}, "Unknown"),
    ({"_variant": "create-cache-uuid", "_invented": 1}, {}, "Unknown"),
    ({}, {"unknown": port("oops")}, "Unknown"),
    ({"prompt": ""}, {}, "prompt"),
    ({"image_urls": json.dumps(["ftp://example.test/a.png"])}, {}, "HTTP"),
    ({"image_urls": json.dumps(["/missing/paper-snapshot.png"])}, {}, "readable"),
])
async def test_invalid_payload_fails_before_any_upload_or_paid_post(params, inputs, match):
    with respx.mock(assert_all_called=False) as router:
        with pytest.raises(ValueError, match=match):
            await gateway.handle_krea_gateway(node(params={"prompt": "valid", **params}), inputs, {"KREA_API_TOKEN": API_KEY})
        assert len(router.calls) == 0


@pytest.mark.asyncio
@pytest.mark.parametrize("params", [{"duration": 7}, {"duration": "4"}, {"generate_audio": "false"}, {"startImage": "https://example.test/a.png"}])
async def test_video_schema_constraints_fail_before_post(params):
    with respx.mock(assert_all_called=False) as router:
        with pytest.raises(ValueError):
            await gateway.handle_krea_gateway(node(VIDEO_ID, {"prompt": "animate", **params}), {}, {"KREA_API_TOKEN": API_KEY})
        assert len(router.calls) == 0


@pytest.mark.asyncio
async def test_missing_prompt_or_krea_token_never_uses_another_provider():
    with respx.mock(assert_all_called=False) as router:
        with pytest.raises(ValueError, match="KREA_API_TOKEN"):
            await gateway.handle_krea_gateway(node(params={"prompt": "valid"}), {}, {"FAL_KEY": "unused", "OPENAI_API_KEY": "unused"})
        with pytest.raises(ValueError, match="prompt"):
            await gateway.handle_krea_gateway(node(), {}, {"KREA_API_TOKEN": API_KEY})
        assert len(router.calls) == 0


@pytest.mark.asyncio
async def test_unknown_definition_is_not_an_arbitrary_endpoint():
    with respx.mock(assert_all_called=False) as router:
        with pytest.raises(ValueError, match="Unknown bundled"):
            await gateway.handle_krea_gateway(node("krea-image-attacker-custom", {"endpoint": "https://attacker.test"}), {}, {"KREA_API_TOKEN": API_KEY})
        assert len(router.calls) == 0


@pytest.mark.asyncio
@pytest.mark.parametrize("status", [402, 429, 401, 500])
async def test_submit_http_failure_is_explicit_and_never_retried(status):
    with respx.mock as router:
        posted = router.post(gateway.KREA_BASE_URL + gateway.catalog_models()[IMAGE_ID]["endpoint"]).mock(
            return_value=httpx.Response(status, json={"error": "fixture failure"}))
        with pytest.raises(RuntimeError, match=str(status)):
            await gateway.handle_krea_gateway(node(params={"prompt": "valid"}), {}, {"KREA_API_TOKEN": API_KEY})
        assert posted.call_count == 1
        assert len(router.calls) == 1


@pytest.mark.asyncio
@pytest.mark.parametrize("status", ["failed", "cancelled", "unknown-status"])
async def test_terminal_and_unknown_job_states_fail_without_download(status):
    with respx.mock as router:
        posted = submit(router, response={"job_id": "job-1", "status": "queued"})
        router.get(gateway.KREA_BASE_URL + "/jobs/job-1").mock(return_value=httpx.Response(200, json={"status": status, "error": "fixture failure"}))
        if status == "unknown-status":
            router.delete(gateway.KREA_BASE_URL + "/jobs/job-1").mock(return_value=httpx.Response(200))
        with pytest.raises(RuntimeError, match="failed|cancelled|unknown status"):
            await gateway.handle_krea_gateway(node(params={"prompt": "valid"}), {}, {"KREA_API_TOKEN": API_KEY})
        await drain_cancellations()
        assert posted.call_count == 1
        assert len(router.calls) == (3 if status == "unknown-status" else 2)


@pytest.mark.asyncio
async def test_cancel_during_progress_reaches_real_delete_chain():
    async def cancel_on_progress(_event):
        raise asyncio.CancelledError()
    with respx.mock as router:
        submit(router, response={"job_id": "job-1", "status": "queued"})
        router.get(gateway.KREA_BASE_URL + "/jobs/job-1").mock(return_value=httpx.Response(200, json={"status": "processing"}))
        deleted = router.delete(gateway.KREA_BASE_URL + "/jobs/job-1").mock(return_value=httpx.Response(200))
        with pytest.raises(asyncio.CancelledError):
            await gateway.handle_krea_gateway(node(params={"prompt": "valid"}), {}, {"KREA_API_TOKEN": API_KEY}, cancel_on_progress)
        await drain_cancellations()
    assert deleted.call_count == 1
    assert deleted.calls[0].request.headers["Authorization"] == f"Bearer {API_KEY}"


@pytest.mark.asyncio
async def test_poll_timeout_cancels_job_without_resubmitting(monkeypatch):
    monkeypatch.setattr(gateway, "MAX_POLLS", 2)
    with respx.mock as router:
        posted = submit(router, response={"job_id": "job-1", "status": "queued"})
        polled = router.get(gateway.KREA_BASE_URL + "/jobs/job-1").mock(return_value=httpx.Response(200, json={"status": "queued"}))
        deleted = router.delete(gateway.KREA_BASE_URL + "/jobs/job-1").mock(return_value=httpx.Response(200))
        with pytest.raises(RuntimeError, match="timed out"):
            await gateway.handle_krea_gateway(node(params={"prompt": "valid"}), {}, {"KREA_API_TOKEN": API_KEY})
        await drain_cancellations()
    assert posted.call_count == 1
    assert polled.call_count == 2
    assert deleted.call_count == 1


@pytest.mark.asyncio
@pytest.mark.parametrize("urls", [{"first": IMAGE_URL, "second": "https://cdn.example.test/artwork-2.png"},
                                   [{"type": "preview", "url": IMAGE_URL}]])
async def test_result_url_maps_and_tagged_arrays_are_preserved(urls):
    with respx.mock as router:
        submit(router, response=completed(urls))
        download(router)
        if isinstance(urls, dict):
            download(router, urls["second"])
        result = await gateway.handle_krea_gateway(node(params={"prompt": "valid"}), {}, {"KREA_API_TOKEN": API_KEY})
    assert len(result["images"]["value"]) == len(urls)
    assert result["job"]["value"]["result"]["urls"] == urls


@pytest.mark.asyncio
@pytest.mark.parametrize("job", [completed(["file:///private/artwork.png"]), {"job_id": "job-1", "status": "completed", "result": {}},
                                 {"job_id": "../bad", "status": "completed", "result": {"urls": [IMAGE_URL]}}])
async def test_malformed_result_fails_closed(job):
    with respx.mock as router:
        submit(router, response=job)
        with pytest.raises(RuntimeError):
            await gateway.handle_krea_gateway(node(params={"prompt": "valid"}), {}, {"KREA_API_TOKEN": API_KEY})
        assert len(router.calls) == 1


@pytest.mark.asyncio
async def test_invalid_artwork_is_not_claimed_as_success():
    with respx.mock as router:
        submit(router)
        download(router, body=b"provider error document")
        with pytest.raises(RuntimeError, match="invalid image"):
            await gateway.handle_krea_gateway(node(params={"prompt": "valid"}), {}, {"KREA_API_TOKEN": API_KEY})


def test_gateway_required_prompt_param_fallback_at_graph_validation_boundary():
    from execution.engine import validate_graph
    errors = validate_graph([node(params={"prompt": "A cyan logo"})], [], {"KREA_API_TOKEN": API_KEY})
    assert not errors, [error.message for error in errors]
    prompt = GraphNode(id="prompt", definitionId="text-input", params={"value": "Connected prompt"})
    target = node()
    edge = GraphEdge(id="edge", source="prompt", sourceHandle="text", target=target.id, targetHandle="prompt")
    assert not validate_graph([prompt, target], [edge], {"KREA_API_TOKEN": API_KEY})


@pytest.mark.asyncio
async def test_cleared_optional_media_fields_are_omitted(tiny_video):
    video_url = "https://cdn.example.test/movie.mp4"
    with respx.mock as router:
        posted = submit(router, VIDEO_ID, completed([video_url]))
        download(router, video_url, tiny_video, "video/mp4")
        await gateway.handle_krea_gateway(node(VIDEO_ID, {"prompt": "animate", "start_image": "", "end_image": ""}),
            {}, {"KREA_API_TOKEN": API_KEY})
    assert json.loads(posted.calls[0].request.content) == {"prompt": "animate"}


@pytest.mark.asyncio
async def test_cleared_required_media_field_fails_before_post():
    with respx.mock(assert_all_called=False) as router:
        with pytest.raises(ValueError, match="readable|image_url"):
            await gateway.handle_krea_gateway(node("krea-image-bytedance-seededit", {"prompt": "edit", "image_url": ""}),
                {}, {"KREA_API_TOKEN": API_KEY})
        assert not router.calls


@pytest.mark.asyncio
@pytest.mark.parametrize("host", ["127.0.0.1:8000", "localhost:8000", "[::1]:8000"])
async def test_owned_loopback_output_urls_are_uploaded_locally(tmp_path, monkeypatch, host):
    import handlers.krea as legacy
    monkeypatch.setattr(legacy, "OUTPUT_ROOT", tmp_path)
    source = tmp_path / "paper source.png"
    source.write_bytes(png())
    reference = f"http://{host}/api/outputs/paper%20source.png"
    with respx.mock as router:
        asset = router.post(gateway.KREA_BASE_URL + "/assets").mock(return_value=httpx.Response(200, json={"image_url": "https://assets.krea.ai/ref.png"}))
        posted = submit(router)
        download(router)
        await gateway.handle_krea_gateway(node(params={"prompt": "reference"}),
            {"image_urls": port(reference, "Image")}, {"KREA_API_TOKEN": API_KEY})
    assert png() in asset.calls[0].request.content
    assert json.loads(posted.calls[0].request.content)["image_urls"] == ["https://assets.krea.ai/ref.png"]
    assert source.read_bytes() == png()


@pytest.mark.asyncio
@pytest.mark.parametrize("reference", ["http://localhost:5173/logo.png", "http://127.0.0.1:8000/private.png",
    "http://[::1]/api/outputs/../../private.png", "http://localhost./api/outputs/missing.png",
    "http://127.0.0.1/api/outputs/reference.png?key=secret"])
async def test_unowned_loopback_urls_never_reach_krea(reference):
    with respx.mock(assert_all_called=False) as router:
        with pytest.raises(ValueError, match="local URL|readable"):
            await gateway.handle_krea_gateway(node(params={"prompt": "reference"}),
                {"image_urls": port(reference, "Image")}, {"KREA_API_TOKEN": API_KEY})
        assert not router.calls


@pytest.mark.asyncio
async def test_mixed_video_result_keeps_preview_artifact_and_primary_video(tiny_video, tmp_path, monkeypatch):
    urls = [{"type": "preview", "url": IMAGE_URL}, {"type": "model", "url": "https://cdn.example.test/movie.mp4"}]
    run_directory = tmp_path / "single-run"
    run_directory.mkdir()
    calls = []
    def run_dir():
        calls.append(True)
        return run_directory
    monkeypatch.setattr(gateway, "get_run_dir", run_dir)
    with respx.mock as router:
        submit(router, VIDEO_ID, completed(urls))
        image_download = download(router)
        video_download = download(router, urls[1]["url"], tiny_video, "video/mp4")
        result = await gateway.handle_krea_gateway(node(VIDEO_ID, {"prompt": "animate"}), {}, {"KREA_API_TOKEN": API_KEY})
    assert calls == [True]
    assert result["artifacts"]["type"] == "Array"
    preview, video = result["artifacts"]["value"]
    assert preview["type"] == "Image" and local_output(preview["value"]).read_bytes() == png()
    assert video["type"] == "Video" and local_output(video["value"]).read_bytes() == tiny_video
    assert Path(result["video"]["value"]) == local_output(video["value"])
    assert result["video"]["type"] == video["type"]
    assert result["videos"]["value"] == [video["value"]]
    assert all(item["value"].startswith("/api/outputs/") and local_output(item["value"]).parent == run_directory
               for item in result["artifacts"]["value"])
    assert all("authorization" not in item.calls[0].request.headers for item in [image_download, video_download])
    assert result["job"]["value"] == completed(urls)


@pytest.mark.asyncio
@pytest.mark.parametrize("extension", ["m4v", "avi"])
async def test_supported_video_container_extensions_survive_real_probe(tiny_video, extension):
    url = f"https://cdn.example.test/movie.{extension}"
    with respx.mock as router:
        submit(router, VIDEO_ID, completed([url]))
        download(router, url, tiny_video, "application/octet-stream")
        result = await gateway.handle_krea_gateway(node(VIDEO_ID, {"prompt": "animate"}), {}, {"KREA_API_TOKEN": API_KEY})
    assert Path(result["video"]["value"]).suffix == f".{extension}"
    assert Path(result["video"]["value"]).read_bytes() == tiny_video


@pytest.mark.asyncio
@pytest.mark.parametrize("body,match", [(b"provider error document", "failed validation"), (png(), "image rather")])
async def test_video_output_bytes_must_contain_actual_video(body, match):
    with respx.mock as router:
        submit(router, VIDEO_ID, completed(["https://cdn.example.test/movie.mp4"]))
        download(router, "https://cdn.example.test/movie.mp4", body, "video/mp4")
        with pytest.raises(RuntimeError, match=match):
            await gateway.handle_krea_gateway(node(VIDEO_ID, {"prompt": "animate"}), {}, {"KREA_API_TOKEN": API_KEY})


@pytest.mark.asyncio
async def test_submit_network_timeout_never_creates_another_job():
    with respx.mock as router:
        posted = router.post(gateway.KREA_BASE_URL + gateway.catalog_models()[IMAGE_ID]["endpoint"]).mock(side_effect=httpx.ReadTimeout("fixture timeout"))
        with pytest.raises(httpx.ReadTimeout):
            await gateway.handle_krea_gateway(node(params={"prompt": "valid"}), {}, {"KREA_API_TOKEN": API_KEY})
        assert posted.call_count == 1
        assert len(router.calls) == 1


@pytest.mark.asyncio
@pytest.mark.parametrize("http_failure", [True, False])
async def test_poll_network_or_http_failure_requests_cancel_without_resubmit(http_failure):
    with respx.mock as router:
        posted = submit(router, response={"job_id": "job-1", "status": "queued"})
        polled = router.get(gateway.KREA_BASE_URL + "/jobs/job-1")
        if http_failure:
            polled.mock(return_value=httpx.Response(429, json={"error": "fixture rate limit"}))
        else:
            polled.mock(side_effect=httpx.ReadTimeout("fixture timeout"))
        deleted = router.delete(gateway.KREA_BASE_URL + "/jobs/job-1").mock(return_value=httpx.Response(200))
        with pytest.raises((RuntimeError, httpx.ReadTimeout)):
            await gateway.handle_krea_gateway(node(params={"prompt": "valid"}), {}, {"KREA_API_TOKEN": API_KEY})
        await drain_cancellations()
    assert posted.call_count == polled.call_count == deleted.call_count == 1


@pytest.mark.asyncio
async def test_asset_http_failure_stops_before_billable_request(tmp_path):
    source = tmp_path / "reference.png"
    source.write_bytes(png())
    with respx.mock as router:
        uploaded = router.post(gateway.KREA_BASE_URL + "/assets").mock(return_value=httpx.Response(413, json={"error": "fixture asset limit"}))
        with pytest.raises(RuntimeError, match="413"):
            await gateway.handle_krea_gateway(node(params={"prompt": "valid"}),
                {"image_urls": port(str(source), "Image")}, {"KREA_API_TOKEN": API_KEY})
        assert uploaded.call_count == len(router.calls) == 1


@pytest.mark.asyncio
@pytest.mark.parametrize("connected", [False, True])
async def test_execute_http_admits_param_prompt_and_connected_prompt(monkeypatch, connected):
    import main as main_module
    from services.cli_graph import CLIGraph
    from services.execution_runs import ExecutionRunRegistry
    registry = ExecutionRunRegistry()
    execute = AsyncMock()
    monkeypatch.setattr(main_module, "execution_runs", registry)
    monkeypatch.setattr(main_module, "cli_graph", CLIGraph())
    monkeypatch.setattr(main_module, "load_settings", lambda: {"apiKeys": {"KREA_API_TOKEN": API_KEY}})
    monkeypatch.setattr(main_module, "execute_graph", execute)
    monkeypatch.setattr(main_module, "_watch_for_cross_process_stop", lambda *_: None)
    monkeypatch.setattr(main_module.manager, "broadcast_raw", AsyncMock())
    target = node(params={"_variant": "create-cache-uuid", **({} if connected else {"prompt": "A cyan logo"})})
    nodes = [target]
    edges = []
    if connected:
        nodes.insert(0, GraphNode(id="prompt", definitionId="text-input", params={"value": "A cyan logo"}))
        edges.append(GraphEdge(id="edge", source="prompt", sourceHandle="text", target=target.id, targetHandle="prompt"))
    body = {"nodes": [item.model_dump(by_alias=True) for item in nodes],
            "edges": [item.model_dump(by_alias=True) for item in edges], "runId": f"krea-http-{connected}"}
    async with httpx.AsyncClient(transport=httpx.ASGITransport(app=main_module.app), base_url="http://127.0.0.1") as client:
        response = await client.post("/api/execute", json=body)
    assert response.status_code == 200 and response.json()["status"] == "started"
    record = registry.get(body["runId"])
    await record.task
    await asyncio.sleep(0)
    execute.assert_awaited_once()
    assert execute.call_args.kwargs["nodes"][-1].params == target.params
    assert execute.call_args.kwargs["edges"] == edges


@pytest.mark.asyncio
async def test_create_cache_discriminator_is_ignored_without_mutating_graph_params():
    original = node(params={"prompt": "A cyan logo", "_variant": "create-cache-uuid", "quality": "high"})
    with respx.mock as router:
        posted = submit(router)
        download(router)
        await gateway.handle_krea_gateway(original, {}, {"KREA_API_TOKEN": API_KEY})
    assert json.loads(posted.calls[0].request.content) == {"prompt": "A cyan logo", "quality": "high"}
    assert original.params["_variant"] == "create-cache-uuid"


@pytest.mark.asyncio
async def test_cleared_optional_enum_uses_provider_default():
    with respx.mock as router:
        posted = submit(router)
        download(router)
        await gateway.handle_krea_gateway(node(params={"prompt": "A cyan logo", "quality": ""}), {}, {"KREA_API_TOKEN": API_KEY})
    assert json.loads(posted.calls[0].request.content) == {"prompt": "A cyan logo"}


@pytest.mark.asyncio
@pytest.mark.parametrize("schema,expected", [
    ({"type": "string", "enum": ["", "high"]}, {"prompt": "A cyan logo", "quality": ""}),
    ({"type": "string", "anyOf": [{"const": "high"}, {"const": "low"}]}, {"prompt": "A cyan logo"}),
])
async def test_empty_enum_value_is_preserved_only_when_schema_accepts_it(schema, expected):
    model = copy.deepcopy(gateway.catalog_models()[IMAGE_ID])
    model["requestSchema"]["properties"]["quality"] = schema
    body = await gateway._request_body(node(params={"prompt": "A cyan logo", "quality": ""}), {}, model)
    assert body == expected
    gateway._validate(body, model["requestSchema"])


@pytest.mark.asyncio
async def test_cleared_required_enum_remains_an_error_before_requests():
    with respx.mock(assert_all_called=False) as router:
        with pytest.raises(ValueError, match="aspect_ratio"):
            await gateway.handle_krea_gateway(node("krea-image-krea-krea-2-medium", {
                "prompt": "A cyan logo", "aspect_ratio": "", "resolution": "1K"}), {}, {"KREA_API_TOKEN": API_KEY})
        assert not router.calls


@pytest.mark.asyncio
@pytest.mark.parametrize("reference", ["https://foo bar/a.png", "https://images.example.test/a\nb.png",
    "https:///a.png", "https://:443/a.png", "https://images.example.test:abc/a.png",
    "https://images.example.test:65536/a.png", "https://images.example.test:0/a.png",
    "https://[invalid/a.png", "https://[::1]junk/a.png", "https://images.example.test\\bad/a.png"])
async def test_invalid_http_media_fails_without_uri_format_extras(monkeypatch, reference):
    from jsonschema import FormatChecker
    monkeypatch.setattr(gateway, "FormatChecker", lambda: FormatChecker(formats=()))
    with respx.mock(assert_all_called=False) as router:
        with pytest.raises(ValueError, match="media HTTP URL"):
            await gateway.handle_krea_gateway(node(params={"prompt": "reference"}),
                {"image_urls": port(reference, "Image")}, {"KREA_API_TOKEN": API_KEY})
        assert not router.calls


@pytest.mark.asyncio
async def test_valid_public_media_url_is_preserved_without_uri_format_extras(monkeypatch):
    from jsonschema import FormatChecker
    monkeypatch.setattr(gateway, "FormatChecker", lambda: FormatChecker(formats=()))
    reference = "https://images.example.test:8443/asset.png?signature=a%2Fb&expiry=123"
    with respx.mock as router:
        posted = submit(router)
        download(router)
        await gateway.handle_krea_gateway(node(params={"prompt": "reference"}),
            {"image_urls": port(reference, "Image")}, {"KREA_API_TOKEN": API_KEY})
        assert len(router.calls) == 2
    assert json.loads(posted.calls[0].request.content)["image_urls"] == [reference]


@pytest.mark.asyncio
async def test_invalid_asset_response_url_stops_before_generation(tmp_path, monkeypatch):
    from jsonschema import FormatChecker
    monkeypatch.setattr(gateway, "FormatChecker", lambda: FormatChecker(formats=()))
    source = tmp_path / "reference.png"
    source.write_bytes(png())
    with respx.mock as router:
        uploaded = router.post(gateway.KREA_BASE_URL + "/assets").mock(return_value=httpx.Response(200,
            json={"image_url": "https://images.example.test:broken/reference.png"}))
        with pytest.raises(RuntimeError, match="valid image_url"):
            await gateway.handle_krea_gateway(node(params={"prompt": "reference"}),
                {"image_urls": port(str(source), "Image")}, {"KREA_API_TOKEN": API_KEY})
        assert uploaded.call_count == len(router.calls) == 1


@pytest.mark.asyncio
async def test_executor_emits_portable_arrays_and_uploads_selected_portable_result(monkeypatch, tiny_video):
    from execution.engine import execute_graph, validate_graph
    from execution.sync_runner import get_handler_registry
    from models.events import ErrorEvent, ExecutedEvent
    monkeypatch.setattr(gateway, "get_run_dir", output_service.get_run_dir)
    source = GraphNode(id="source", definitionId=IMAGE_ID, params={"prompt": "Cyan source"})
    selector = GraphNode(id="selector", definitionId="array-selector", params={"mode": "last"})
    downstream = GraphNode(id="downstream", definitionId=IMAGE_ID, params={"prompt": "Use selected artwork"})
    video = GraphNode(id="video", definitionId=VIDEO_ID, params={"prompt": "Animate cyan artwork"})
    nodes = [source, selector, downstream, video]
    edges = [GraphEdge(id="select", source=source.id, sourceHandle="images", target=selector.id, targetHandle="array"),
             GraphEdge(id="use", source=selector.id, sourceHandle="item", target=downstream.id, targetHandle="image_urls")]
    keys = {"KREA_API_TOKEN": API_KEY}
    assert not validate_graph(nodes, edges, keys)
    image_urls = [IMAGE_URL, "https://cdn.example.test/selected.png"]
    final_url = "https://cdn.example.test/final.png"
    movie_url = "https://cdn.example.test/movie.mp4"
    video_urls = [{"type": "preview", "url": IMAGE_URL}, {"type": "model", "url": movie_url}]
    selected_bytes = png((80, 90, 230, 255))
    events = []
    async def emit(event):
        events.append(event)
    with respx.mock as router:
        posted = router.post(gateway.KREA_BASE_URL + gateway.catalog_models()[IMAGE_ID]["endpoint"]).mock(side_effect=[
            httpx.Response(200, json=completed(image_urls)), httpx.Response(200, json=completed([final_url]))])
        submit(router, VIDEO_ID, completed(video_urls))
        asset = router.post(gateway.KREA_BASE_URL + "/assets").mock(return_value=httpx.Response(200,
            json={"image_url": "https://assets.krea.ai/selected.png"}))
        download(router)
        download(router, image_urls[1], selected_bytes)
        download(router, final_url)
        download(router, movie_url, tiny_video, "video/mp4")
        await execute_graph(nodes, edges, keys, get_handler_registry(), emit, run_id="krea-portable-downstream", max_parallel_nodes=1)
    assert not any(isinstance(event, ErrorEvent) for event in events)
    outputs = {event.node_id: event.outputs for event in events if isinstance(event, ExecutedEvent)}
    assert set(outputs) == {item.id for item in nodes}
    source_output = outputs[source.id]
    assert Path(source_output["image"]["value"]).is_absolute()
    assert all(ref.startswith("/api/outputs/") and local_output(ref).is_file() for ref in source_output["images"]["value"])
    selected_ref = source_output["images"]["value"][-1]
    assert outputs[selector.id]["item"]["value"] == selected_ref
    assert local_output(selected_ref).read_bytes() == selected_bytes
    assert selected_bytes in asset.calls[0].request.content
    assert json.loads(posted.calls[1].request.content)["image_urls"] == ["https://assets.krea.ai/selected.png"]
    video_output = outputs[video.id]
    assert Path(video_output["video"]["value"]).is_absolute()
    assert all(ref.startswith("/api/outputs/") for ref in video_output["videos"]["value"])
    assert [item["type"] for item in video_output["artifacts"]["value"]] == ["Image", "Video"]
    assert all(item["value"].startswith("/api/outputs/") and local_output(item["value"]).is_file()
               for item in video_output["artifacts"]["value"])
    assert video_output["job"]["value"]["result"]["urls"] == video_urls


@pytest.mark.asyncio
async def test_executor_cache_hit_rebinds_all_artifacts_and_preserves_portable_arrays(monkeypatch, tiny_video):
    from execution.engine import execute_graph
    from execution.sync_runner import get_handler_registry
    from models.events import ErrorEvent, ExecutedEvent
    from services.cache import ExecutionCache
    monkeypatch.setattr(gateway, "get_run_dir", output_service.get_run_dir)
    cache = ExecutionCache()
    image_urls = [IMAGE_URL, "https://cdn.example.test/second.png"]
    video_urls = [{"type": "preview", "url": "https://cdn.example.test/preview.png"},
                  {"type": "model", "url": "https://cdn.example.test/movie.mp4"}]
    async def run(run_id):
        nodes = [GraphNode(id="image", definitionId=IMAGE_ID, params={"prompt": "Cyan artwork"}),
                 GraphNode(id="video", definitionId=VIDEO_ID, params={"prompt": "Cyan motion"})]
        events = []
        async def emit(event):
            events.append(event)
        await execute_graph(nodes, [], {"KREA_API_TOKEN": API_KEY}, get_handler_registry(), emit,
                            cache=cache, run_id=run_id)
        assert not any(isinstance(event, ErrorEvent) for event in events)
        return {event.node_id: event.outputs for event in events if isinstance(event, ExecutedEvent)}
    with respx.mock as router:
        image_posted = submit(router, IMAGE_ID, completed(image_urls))
        video_posted = submit(router, VIDEO_ID, completed(video_urls))
        for url in image_urls + [video_urls[0]["url"]]:
            download(router, url)
        download(router, video_urls[1]["url"], tiny_video, "video/mp4")
        first = await run("krea-cache-first")
        first_copy = copy.deepcopy(first)
        first_paths = {local_output(item["value"]) for ports in first.values() for item in ports["artifacts"]["value"]}
        original_bytes = {path: path.read_bytes() for path in first_paths}
        second = await run("krea-cache-second")
        assert image_posted.call_count == video_posted.call_count == 1
    second_paths = {local_output(item["value"]) for ports in second.values() for item in ports["artifacts"]["value"]}
    assert first == first_copy
    assert first_paths.isdisjoint(second_paths)
    assert len(first_paths) == len(second_paths) == 4
    assert len({path.parent for path in first_paths}) == len({path.parent for path in second_paths}) == 1
    assert next(iter(first_paths)).parent != next(iter(second_paths)).parent
    assert {path.read_bytes() for path in second_paths} == set(original_bytes.values())
    assert all(path.read_bytes() == payload for path, payload in original_bytes.items())
    for node_id, primary in [("image", "image"), ("video", "video")]:
        ports = second[node_id]
        assert Path(ports[primary]["value"]).is_absolute()
        assert local_output(ports[f"{primary}s"]["value"][0]) == Path(ports[primary]["value"])
        assert all(ref.startswith("/api/outputs/") and local_output(ref) in second_paths for ref in ports[f"{primary}s"]["value"])
        assert all(item["value"].startswith("/api/outputs/") and local_output(item["value"]) in second_paths
                   for item in ports["artifacts"]["value"])
        assert ports["job"] == first[node_id]["job"]
    manifest = output_service.read_manifest(next(iter(second_paths)).parent)
    assert {record["output_path"] for record in manifest["outputs"]} == {path.name for path in second_paths}


@pytest.mark.asyncio
async def test_image_enhance_uploads_source_and_returns_image():
    with respx.mock as router:
        posted = submit(router, UPSCALE_ID, completed([IMAGE_URL]))
        download(router)
        result = await gateway.handle_krea_gateway(node(UPSCALE_ID, {"width": 2048, "height": 2048}),
            {"image_url": port("https://assets.example.test/source.png", "Image")}, {"KREA_API_TOKEN": API_KEY})
    assert json.loads(posted.calls[0].request.content) == {
        "width": 2048, "height": 2048, "image_url": "https://assets.example.test/source.png"}
    assert result["image"]["type"] == "Image"
    assert len(result["images"]["value"]) == 1


@pytest.mark.asyncio
async def test_video_enhance_returns_video(tiny_video):
    url = "https://cdn.example.test/upscaled.mp4"
    with respx.mock as router:
        submit(router, VIDEO_UPSCALE_ID, completed([url]))
        download(router, url, tiny_video, "video/mp4")
        result = await gateway.handle_krea_gateway(node(VIDEO_UPSCALE_ID),
            {"video_url": port("https://assets.example.test/clip.mp4", "Video")}, {"KREA_API_TOKEN": API_KEY})
    assert result["video"]["type"] == "Video"
    assert local_output(result["videos"]["value"][0]).read_bytes() == tiny_video


@pytest.mark.asyncio
async def test_3d_job_returns_local_mesh_and_keeps_preview_artifact():
    mesh_url = "https://cdn.example.test/model.glb"
    glb = b"glTF" + bytes(32)
    urls = [{"type": "model", "url": mesh_url}, {"type": "preview", "url": IMAGE_URL}]
    with respx.mock as router:
        submit(router, MESH_ID, completed(urls))
        download(router, mesh_url, glb, "model/gltf-binary")
        download(router)
        result = await gateway.handle_krea_gateway(node(MESH_ID, {"prompt": "a ceramic fox", "input_mode": "text"}),
            {}, {"KREA_API_TOKEN": API_KEY})
    assert result["mesh"]["type"] == "Mesh"
    assert Path(result["mesh"]["value"]).suffix == ".glb"
    assert Path(result["mesh"]["value"]).read_bytes() == glb
    assert len(result["meshes"]["value"]) == 1
    assert [artifact["type"] for artifact in result["artifacts"]["value"]] == ["Mesh", "Image"]
