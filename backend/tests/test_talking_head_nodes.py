"""The talking-head nodes: a still image and an audio track become a video.

OmniHuman 1.5 (fal.ai, Replicate), OmniHuman 2.0 (fal.ai) and Kling AI Avatar
v2 (fal.ai, Replicate). Every request goes to a mocked host (httpx.MockTransport
through FakeHosts): nothing here reaches a provider or bills anything.

Provider facts (fetched 2026-11-04, each from the vendor's own page; the
sources are in model_pricing.json and the notes file):

- fal: per-endpoint queue OpenAPI (fal.ai/api/openapi/queue/openapi.json) for
  fal-ai/bytedance/omnihuman/v1.5, .../v2 and
  fal-ai/kling-video/ai-avatar/v2/{standard,pro}: ``image_url`` and
  ``audio_url`` (required), ``prompt`` (optional); output ``{video: {url}}``.
- Replicate: bytedance/omni-human-1.5 (image, audio, prompt, fast_mode, seed)
  and kwaivgi/kling-avatar-v2 (image, audio, prompt, mode); output a URI.
"""
from __future__ import annotations

import base64
import asyncio
import json
import re
import shutil
import subprocess
from pathlib import Path
from typing import Any

import httpx
import pytest
from fastapi.testclient import TestClient

import main
from cli.formatter import format_node_detail
from execution import route_clients
from models.graph import PortValueDict
from services import agent_spend, input_sizes, model_pricing, node_route
from tests.test_first_turn_cli import _run, cli  # noqa: F401  (cli is a fixture)
from tests.test_flux3_nodes import AUDIO, CLIP, P, PRICING, REF, REGISTRY, defaults, hosts_for
from tests.test_route_clients import (  # noqa: F401  (quick is an autouse fixture)
    KEYS, MP4, PNG, SCHEMAS, FakeHosts, node, quick, registry_handler, validate,
)

NODES = ("omnihuman-1-5", "omnihuman-2", "kling-ai-avatar-v2")
FAL = "https://queue.fal.run/"
REP = "https://api.replicate.com/v1/"


def av_ports(**values: Any) -> dict[str, PortValueDict]:
    kinds = {"prompt": "Text", "audio": "Audio"}
    return {port: PortValueDict(type=kinds.get(port, "Image"), value=value) for port, value in values.items()}


async def run_node(monkeypatch, node_id: str, route_id: str, wired: dict[str, Any], **params: Any):
    """Run the node on one route against mocked hosts; (hosts, outputs)."""
    definition = REGISTRY[node_id]
    spec = node_route.route_by_id(definition, route_id)
    hosts = hosts_for(monkeypatch, spec["provider"], True)
    saved = {**defaults(definition), **params, "_provider": route_id}
    out = await registry_handler(node_id)(node(node_id, **saved), av_ports(**wired), dict(KEYS))
    return hosts, out


FAL_INIT = r"https://rest\.fal\.ai/storage/upload/initiate\?storage_type=gcs"
FAL_PUT = r"https://storage\.example/put/.*"


def fal_storage(hosts, *, init=None, put=None) -> None:
    """fal's storage on the mocked hosts: initiate answers an upload_url and a file_url named after the
    file; the PUT takes the bytes. ``init`` and ``put`` replace either answer."""
    def start(request: httpx.Request) -> httpx.Response:
        name = json.loads(request.content)["file_name"]
        return httpx.Response(200, json={"upload_url": f"https://storage.example/put/{name}",
                                         "file_url": f"https://v3b.fal.media/files/b/x/{name}"})

    hosts.routes[:0] = [("POST", FAL_INIT, init or start), ("PUT", FAL_PUT, put or httpx.Response(200))]


async def run_fal_local(monkeypatch, node_id: str, wired: dict[str, Any], *, init=None, put=None, **params: Any):
    definition = REGISTRY[node_id]
    hosts = hosts_for(monkeypatch, "fal", True)
    fal_storage(hosts, init=init, put=put)
    saved = {**defaults(definition), **params, "_provider": "fal"}
    out = await registry_handler(node_id)(node(node_id, **saved), av_ports(**wired), dict(KEYS))
    return hosts, out


# -- the definitions -----------------------------------------------------------

@pytest.mark.parametrize("node_id, name, routes", [
    ("omnihuman-1-5", "OmniHuman 1.5", ["fal", "replicate"]),
    ("omnihuman-2", "OmniHuman 2.0", ["fal"]),
    ("kling-ai-avatar-v2", "Kling AI Avatar v2", ["fal", "replicate"]),
])
def test_each_node_is_one_route_table_with_the_ports_the_other_audio_and_video_nodes_use(node_id, name, routes):
    definition = REGISTRY[node_id]
    assert definition["displayName"] == name
    assert definition["category"] == "video-gen"
    # Port ids and types, as sync-lipsync (audio, video) and the video nodes (prompt) name them.
    assert [(p["id"], p["dataType"], p["required"]) for p in definition["inputPorts"]] == [
        ("image", "Image", True), ("audio", "Audio", True), ("prompt", "Text", False)]
    assert [(p["id"], p["dataType"]) for p in definition["outputPorts"]] == [("video", "Video")]
    assert [r["id"] for r in definition["routes"]] == routes
    assert node_route.routes_problems(definition) == []
    # Only verified routes: no maker route (BytePlus signs OmniHuman with an access key and secret, and
    # Kling's own API needs a Kling key Nebula has no field for), so nothing is marked as the maker.
    assert not any(r.get("maker") for r in definition["routes"])
    assert "directKeyName" not in definition


def test_the_nodes_are_not_offered_on_providers_that_dont_host_them():
    """OpenRouter's video models list and Krea's API pricing page (read 2026-11-04)
    have no OmniHuman and no Kling avatar, and Replicate has no OmniHuman 2.0."""
    providers = {node_id: [r["provider"] for r in REGISTRY[node_id]["routes"]] for node_id in NODES}
    assert providers == {"omnihuman-1-5": ["fal", "replicate"], "omnihuman-2": ["fal"],
                         "kling-ai-avatar-v2": ["fal", "replicate"]}


def test_every_route_is_priced_with_its_source_and_date():
    for node_id in NODES:
        routes = PRICING["nodes"][node_id]["routes"]
        assert set(routes) == {r["id"] for r in REGISTRY[node_id]["routes"]}
        for route_id, entry in routes.items():
            assert entry["checked"] == "2026-11-04" and entry["per"] == "second"
            assert entry["sizing"]["port"] == "audio" and entry["multiplyBy"] == ["(source seconds)"]
            assert all(s["url"].startswith("https://") and "$" in s["quote"] for s in entry["sources"]), (node_id, route_id)
            assert not entry.get("unconfirmed")
    assert model_pricing.validate_pricing(PRICING, REGISTRY) == []


# -- the requests ----------------------------------------------------------------

CASES = [
    # node, route, params, wired, url, schema key, the body exactly
    ("omnihuman-1-5", "fal", {}, {"image": REF, "audio": AUDIO, "prompt": P},
     FAL + "fal-ai/bytedance/omnihuman/v1.5", "fal-ai/bytedance/omnihuman/v1.5",
     {"image_url": REF, "audio_url": AUDIO, "prompt": P, "turbo_mode": False, "resolution": "1080p"}),
    ("omnihuman-1-5", "fal", {"fast_mode": True, "resolution": "720p"}, {"image": REF, "audio": AUDIO},
     FAL + "fal-ai/bytedance/omnihuman/v1.5", "fal-ai/bytedance/omnihuman/v1.5",
     {"image_url": REF, "audio_url": AUDIO, "turbo_mode": True, "resolution": "720p"}),
    ("omnihuman-1-5", "replicate", {}, {"image": REF, "audio": AUDIO, "prompt": P},
     REP + "models/bytedance/omni-human-1.5/predictions", "bytedance/omni-human-1.5",
     {"input": {"image": REF, "audio": AUDIO, "prompt": P, "fast_mode": False}}),
    ("omnihuman-1-5", "replicate", {"fast_mode": True, "seed": 7}, {"image": REF, "audio": AUDIO},
     REP + "models/bytedance/omni-human-1.5/predictions", "bytedance/omni-human-1.5",
     {"input": {"image": REF, "audio": AUDIO, "fast_mode": True, "seed": 7}}),
    ("omnihuman-2", "fal", {}, {"image": REF, "audio": AUDIO, "prompt": P},
     FAL + "fal-ai/bytedance/omnihuman/v2", "fal-ai/bytedance/omnihuman/v2",
     {"image_url": REF, "audio_url": AUDIO, "prompt": P}),
    ("omnihuman-2", "fal", {}, {"image": REF, "audio": AUDIO},
     FAL + "fal-ai/bytedance/omnihuman/v2", "fal-ai/bytedance/omnihuman/v2",
     {"image_url": REF, "audio_url": AUDIO}),
    ("kling-ai-avatar-v2", "fal", {}, {"image": REF, "audio": AUDIO, "prompt": P},
     FAL + "fal-ai/kling-video/ai-avatar/v2/standard", "fal-ai/kling-video/ai-avatar/v2/standard",
     {"image_url": REF, "audio_url": AUDIO, "prompt": P}),
    ("kling-ai-avatar-v2", "fal", {"mode": "pro"}, {"image": REF, "audio": AUDIO},
     FAL + "fal-ai/kling-video/ai-avatar/v2/pro", "fal-ai/kling-video/ai-avatar/v2/pro",
     {"image_url": REF, "audio_url": AUDIO}),
    ("kling-ai-avatar-v2", "replicate", {}, {"image": REF, "audio": AUDIO, "prompt": P},
     REP + "models/kwaivgi/kling-avatar-v2/predictions", "kwaivgi/kling-avatar-v2",
     {"input": {"image": REF, "audio": AUDIO, "prompt": P, "mode": "std"}}),
    ("kling-ai-avatar-v2", "replicate", {"mode": "pro"}, {"image": REF, "audio": AUDIO},
     REP + "models/kwaivgi/kling-avatar-v2/predictions", "kwaivgi/kling-avatar-v2",
     {"input": {"image": REF, "audio": AUDIO, "mode": "pro"}}),
]


@pytest.mark.asyncio
@pytest.mark.parametrize("node_id, route_id, params, wired, url, schema, body", CASES,
                         ids=[f"{c[0]}-{c[1]}-{'-'.join(c[3])}-{'-'.join(map(str, c[2].values()))}" for c in CASES])
async def test_each_route_sends_the_exact_body_its_provider_takes_and_returns_a_video(
        monkeypatch, node_id, route_id, params, wired, url, schema, body):
    hosts, out = await run_node(monkeypatch, node_id, route_id, wired, **params)
    sent = hosts.json("POST", re.escape(url))
    assert sent == body
    provider = node_route.route_by_id(REGISTRY[node_id], route_id)["provider"]
    validate(SCHEMAS[provider][schema], sent["input"] if provider == "replicate" else sent)
    # The video comes back on the node's own port, typed Video.
    assert set(out) == {"video"} and out["video"]["type"] == "Video"
    assert isinstance(out["video"]["value"], str) and out["video"]["value"]
    # One provider per run: nothing else was called with a request body.
    host = httpx.URL(url).host
    assert {httpx.URL(str(r.url)).host for r in hosts.requests if r.method == "POST"} <= {host, "api.replicate.com"}


@pytest.mark.asyncio
async def test_fal_parses_the_video_output_and_the_billed_duration(monkeypatch):
    queue = "https://queue.fal.run/fal-ai/bytedance/omnihuman/requests/r1"
    FakeHosts(monkeypatch, [
        ("POST", FAL + r".*", httpx.Response(200, json={
            "request_id": "r1", "status_url": queue + "/status", "response_url": queue, "cancel_url": queue + "/cancel"})),
        ("GET", re.escape(queue + "/status"), httpx.Response(200, json={"status": "COMPLETED"})),
        ("GET", re.escape(queue), httpx.Response(200, json={
            "video": {"url": "https://v3.fal.media/files/penguin/out.mp4", "content_type": "video/mp4"},
            "duration": 12.5})),
    ])
    out = await registry_handler("omnihuman-2")(
        node("omnihuman-2", **{"_provider": "fal"}), av_ports(image=REF, audio=AUDIO), dict(KEYS))
    assert out == {"video": {"type": "Video", "value": "https://v3.fal.media/files/penguin/out.mp4"}}


@pytest.mark.asyncio
async def test_replicate_saves_its_uri_output_as_a_video(monkeypatch):
    hosts, out = await run_node(monkeypatch, "omnihuman-1-5", "replicate", {"image": REF, "audio": AUDIO})
    assert hosts.sent("GET", re.escape("https://replicate.delivery/x/out.mp4"))
    assert out["video"]["type"] == "Video" and str(out["video"]["value"]).endswith(".mp4")
    assert hosts.sent("POST", REP + "models/bytedance/omni-human-1.5/predictions")[0].headers[
        "authorization"] == "Bearer fixture-rep"


@pytest.fixture
def local_media():
    """A stored image and a stored audio file (Nebula's own outputs)."""
    from services.output import OUTPUT_ROOT

    folder = Path(OUTPUT_ROOT) / "talking-head-inputs"
    folder.mkdir(parents=True, exist_ok=True)
    image, voice = folder / "portrait.png", folder / "voice.mp3"
    image.write_bytes(PNG)
    voice.write_bytes(b"ID3\x03\x00\x00\x00\x00\x00\x00" + b"\x00" * 64)
    return str(image), str(voice)


@pytest.mark.asyncio
async def test_a_local_audio_file_goes_up_the_way_other_audio_inputs_do_on_each_route(monkeypatch, local_media):
    image, voice = local_media
    # fal: uploaded to fal's storage first (it refuses data: URLs on these endpoints); the details are
    # in test_fal_uploads_local_media_and_sends_the_https_url below.
    hosts, _ = await run_fal_local(monkeypatch, "kling-ai-avatar-v2", {"image": image, "audio": voice})
    body = hosts.json("POST", re.escape(FAL + "fal-ai/kling-video/ai-avatar/v2/standard"))
    assert body["audio_url"].startswith("https://") and body["image_url"].startswith("https://")
    validate(SCHEMAS["fal"]["fal-ai/kling-video/ai-avatar/v2/standard"], body)
    # Replicate: uploaded through its files API first, then the file URL is the input.
    hosts, _ = await run_node(monkeypatch, "kling-ai-avatar-v2", "replicate", {"image": image, "audio": voice})
    uploads = hosts.sent("POST", REP + "files")
    assert len(uploads) == 2
    assert any(b'filename="voice.mp3"' in r.content and b"audio/mpeg" in r.content for r in uploads)
    body = hosts.json("POST", REP + r"models/kwaivgi/kling-avatar-v2/predictions")["input"]
    assert body["audio"] == body["image"] == "https://api.replicate.com/v1/files/f1"


@pytest.mark.asyncio
async def test_a_missing_input_or_an_extra_one_stops_before_any_request(monkeypatch):
    hosts = hosts_for(monkeypatch, "replicate", True)
    handler = registry_handler("kling-ai-avatar-v2")
    saved = {**defaults(REGISTRY["kling-ai-avatar-v2"]), "_provider": "replicate"}
    with pytest.raises(ValueError, match="needs an audio"):
        await handler(node("kling-ai-avatar-v2", **saved), av_ports(image=REF), dict(KEYS))
    with pytest.raises(ValueError, match="can't take the connected video"):
        await handler(node("kling-ai-avatar-v2", **saved), av_ports(image=REF, audio=AUDIO, video=CLIP), dict(KEYS))
    with pytest.raises(ValueError, match="takes one audio, but 2 are connected"):
        await handler(node("kling-ai-avatar-v2", **saved), av_ports(image=REF, audio=[AUDIO, AUDIO]), dict(KEYS))
    assert not hosts.requests


def test_fal_takes_the_four_endpoints_media_under_image_url_and_audio_url():
    for endpoint in ("fal-ai/bytedance/omnihuman/v1.5", "fal-ai/bytedance/omnihuman/v2",
                     "fal-ai/kling-video/ai-avatar/v2/standard", "fal-ai/kling-video/ai-avatar/v2/pro"):
        fields = route_clients.fal_fields(endpoint, {}, av_ports(prompt=P, image=REF, audio=AUDIO))
        assert fields == {"image_url": REF, "audio_url": AUDIO}
        validate(SCHEMAS["fal"][endpoint], {"prompt": P, **fields})
    with pytest.raises(ValueError, match="can't take the connected start_video"):
        route_clients.fal_fields("fal-ai/bytedance/omnihuman/v2", {}, av_ports(image=REF, audio=AUDIO, start_video=CLIP))


def test_the_vendors_limits_are_in_the_node_text_the_person_reads():
    assert "30 s" in REGISTRY["omnihuman-1-5"]["description"] and "60 s" in REGISTRY["omnihuman-1-5"]["description"]
    assert "35 s" in REGISTRY["omnihuman-1-5"]["description"]
    assert "4 to 300 s" in REGISTRY["omnihuman-2"]["description"]
    assert "5 MB" in REGISTRY["kling-ai-avatar-v2"]["description"]


# -- the settings each route offers ---------------------------------------------------

def test_each_route_offers_only_its_own_settings():
    omni = REGISTRY["omnihuman-1-5"]
    assert [p["key"] for p in node_route.route_param_definitions(omni, "fal")] == ["fast_mode", "resolution"]
    assert [p["key"] for p in node_route.route_param_definitions(omni, "replicate")] == ["fast_mode", "seed"]
    kling = REGISTRY["kling-ai-avatar-v2"]
    for route in ("fal", "replicate"):
        assert [p["key"] for p in node_route.route_param_definitions(kling, route)] == ["mode"]


# -- prices --------------------------------------------------------------------------

def test_kling_is_never_priced_under_what_a_real_run_billed():
    """12.6 s of audio gave 12.8 s of video, $0.72 (fal, 2026-11-04)."""
    definition = REGISTRY["kling-ai-avatar-v2"]
    estimate = model_pricing.estimate_node(PRICING["nodes"]["kling-ai-avatar-v2"], definition,
                                           {**defaults(definition), "mode": "std"}, "fal", ["image", "audio"], {"seconds": 12.6})
    assert estimate["high"] >= 12.8 * 0.0562
    for route in PRICING["nodes"]["kling-ai-avatar-v2"]["routes"].values():
        assert route["sizing"]["addSeconds"] == 1


@pytest.mark.parametrize("node_id, route_id, params, seconds, expected", [
    ("omnihuman-1-5", "fal", {}, 12.3, 13 * 0.16),
    ("omnihuman-1-5", "replicate", {}, 30, 30 * 0.16),
    ("omnihuman-2", "fal", {}, 4.2, 5 * 0.105),
    # Kling bills the output's length, which runs a little longer than the audio: a real run on fal
    # (2026-11-04) made 12.8 s of video from 12.6 s of audio and billed $0.72 (= 12.8 x $0.0562), and 4 s
    # clips billed about 0.5 s over. A spend estimate must not understate, so the audio's length plus
    # one second is priced, rounded up (12.6 s -> 14 s = $0.7868, over the $0.72 billed).
    ("kling-ai-avatar-v2", "fal", {"mode": "std"}, 12.6, 14 * 0.0562),
    ("kling-ai-avatar-v2", "fal", {"mode": "std"}, 10, 11 * 0.0562),
    ("kling-ai-avatar-v2", "fal", {"mode": "std"}, 4, 5 * 0.0562),
    ("kling-ai-avatar-v2", "fal", {"mode": "pro"}, 10, 11 * 0.115),
    ("kling-ai-avatar-v2", "replicate", {"mode": "std"}, 10, 11 * 0.056),
    ("kling-ai-avatar-v2", "replicate", {"mode": "pro"}, 10, 11 * 0.11),
])
def test_the_estimate_is_the_vendors_per_second_price_times_the_audio_length(node_id, route_id, params, seconds, expected):
    definition = REGISTRY[node_id]
    provider = node_route.route_by_id(definition, route_id)["provider"]
    estimate = model_pricing.estimate_node(PRICING["nodes"][node_id], definition, {**defaults(definition), **params},
                                           provider, ["image", "audio"], {"seconds": seconds})
    assert estimate["low"] == estimate["high"] == pytest.approx(expected)
    # Without the audio's length it is unpriced, never a rate treated as a total.
    assert model_pricing.estimate_node(PRICING["nodes"][node_id], definition, {**defaults(definition), **params},
                                       provider, ["image", "audio"], None) is None


SIZE_NOTE_CASES = json.loads((Path(__file__).parent / "fixtures" / "pricing_cases.json").read_text())["sizeNoteCases"]


@pytest.mark.parametrize("case", SIZE_NOTE_CASES, ids=[c["name"] for c in SIZE_NOTE_CASES])
def test_the_size_note_matches_the_cases_the_frontend_runs(case):
    """pricing.test.ts runs the same cases (pricing_cases.json sizeNoteCases), so the person's
    Inspector line and the agent's describe_node line can't drift."""
    entry = PRICING["nodes"][case["nodeId"]]
    entry = entry["routes"][case["route"]] if case["route"] else entry
    assert model_pricing.size_note(entry, REGISTRY[case["nodeId"]]) == case["note"]


def test_the_size_note_says_the_price_comes_from_the_audio_length():
    entry = PRICING["nodes"]["omnihuman-2"]["routes"]["fal"]
    note = model_pricing.size_note(entry, REGISTRY["omnihuman-2"])
    assert note == ("$0.105 per second of audio, rounded up to a whole second. The video runs as long as the audio. "
                    "Priced from your audio\u2019s length when you run it")


# -- measuring the audio ---------------------------------------------------------------

needs_ffmpeg = pytest.mark.skipif(not (shutil.which("ffmpeg") and shutil.which("ffprobe")), reason="needs ffmpeg and ffprobe")


def _ffmpeg(*args: str) -> None:
    subprocess.run(["ffmpeg", "-v", "error", "-y", *args], check=True, timeout=60)


def _stored(name: str) -> Path:
    from services.output import OUTPUT_ROOT

    path = Path(OUTPUT_ROOT) / "talking-head-sizes" / name
    path.parent.mkdir(parents=True, exist_ok=True)
    return path


@needs_ffmpeg
@pytest.mark.parametrize("suffix", [".wav", ".mp3", ".m4a"])
def test_an_audio_file_in_nebulas_folder_is_measured_by_its_length(suffix):
    path = _stored("voice" + suffix)
    _ffmpeg("-f", "lavfi", "-i", "sine=frequency=440:duration=2.5", str(path))
    size = input_sizes.measure(str(path), "Audio")
    assert size is not None and size["seconds"] == pytest.approx(2.5, abs=0.15)
    assert set(size) == {"seconds"}


@needs_ffmpeg
def test_a_clip_with_video_or_two_audio_tracks_is_not_measured_as_audio():
    clip = _stored("with-video.mp4")
    _ffmpeg("-f", "lavfi", "-i", "testsrc=size=64x48:rate=10:duration=2", "-f", "lavfi", "-i", "sine=duration=2",
            "-pix_fmt", "yuv420p", "-shortest", str(clip))
    assert input_sizes.measure(str(clip), "Audio") is None
    two = _stored("two-tracks.mka")
    _ffmpeg("-f", "lavfi", "-i", "sine=frequency=440:duration=2", "-f", "lavfi", "-i", "sine=frequency=880:duration=2",
            "-map", "0", "-map", "1", str(two))
    assert input_sizes.measure(str(two), "Audio") is None


@needs_ffmpeg
def test_cover_art_on_an_mp3_is_not_a_video_stream():
    art = _stored("cover.png")
    _ffmpeg("-f", "lavfi", "-i", "color=c=red:s=32x32:d=1", "-frames:v", "1", str(art))
    voice = _stored("covered.mp3")
    _ffmpeg("-f", "lavfi", "-i", "sine=duration=2", "-i", str(art), "-map", "0", "-map", "1", "-c:a", "libmp3lame",
            "-c:v", "png", "-disposition:v", "attached_pic", str(voice))
    size = input_sizes.measure(str(voice), "Audio")
    assert size is not None and size["seconds"] == pytest.approx(2.0, abs=0.15)


def test_audio_outside_nebulas_folder_or_on_another_host_is_never_measured(tmp_path):
    outside = tmp_path / "voice.wav"
    outside.write_bytes(b"RIFF")
    assert input_sizes.measure(str(outside), "Audio") is None
    assert input_sizes.measure("https://example.com/voice.mp3", "Audio") is None
    assert input_sizes.measure("data:audio/wav;base64,UklGRg==", "Audio") is None


def test_an_audio_input_node_gives_its_file_and_the_port_is_measured_as_audio():
    assert input_sizes.INPUT_NODES["audio-input"] == "Audio"
    assert input_sizes._port_kind(REGISTRY["omnihuman-2"], "audio") == "Audio"
    assert input_sizes._port_kind(REGISTRY["omnihuman-2"], "image") == "Image"
    source = {"definitionId": "audio-input", "params": {"filePath": "/out/voice.mp3"}}
    assert input_sizes.source_ref(source, "audio", True) == "/out/voice.mp3"


@needs_ffmpeg
def test_a_run_is_priced_from_the_wired_audio_input_and_waits_when_it_cant_be_measured():
    path = _stored("run.wav")
    _ffmpeg("-f", "lavfi", "-i", "sine=duration=3.2", str(path))
    items = [{"id": "a", "definitionId": "audio-input", "params": {"filePath": str(path)}},
             {"id": "n", "definitionId": "omnihuman-2", "params": {}}]
    edges = [("a", "audio", "n", "audio")]
    reasons: dict[str, str] = {}
    sizes = input_sizes.run_input_sizes(items, edges, PRICING, REGISTRY, reasons=reasons)
    assert sizes["n"]["seconds"] == pytest.approx(3.2, abs=0.15) and reasons == {}
    priced = model_pricing.estimate_run([items[1]], PRICING, REGISTRY, {"FAL_KEY": "set"}, None,
                                        {"n": {"image": 1, "audio": 1}}, sizes)
    assert priced["priced"]["n"]["low"] == pytest.approx(round(0.105 * 4, 6)) and not priced["awaitingInput"]
    # An audio file on another host is never downloaded: unpriced, and the reason says so.
    far = [{"id": "a", "definitionId": "audio-input", "params": {"filePath": "https://example.com/v.mp3"}}, items[1]]
    reasons = {}
    assert input_sizes.run_input_sizes(far, edges, PRICING, REGISTRY, reasons=reasons) == {}
    assert reasons == {"n": input_sizes.REMOTE}


@pytest.mark.parametrize("reason, must_say, must_not_say", [
    (input_sizes.REMOTE, ("length of its audio", "Audio Input"), ("Image Input", "nebula quick")),
    (input_sizes.OUTSIDE, ("length of its audio", "Audio Input"), ("clip over 500 MB", "nebula quick")),
    (input_sizes.UNREADABLE, ("couldn't read that file's length", "readable audio file"), ("image or video",)),
    (input_sizes.UNWIRED, ("an Audio Input holding the file",), ("Image Input",)),
    (input_sizes.PENDING, ("that audio doesn't exist yet", "an Audio Input holding the file"), ("Image Input", "nebula quick")),
])
def test_the_spend_gate_says_what_to_do_about_audio_it_cant_measure(reason, must_say, must_not_say):
    text = " ".join(agent_spend._awaiting_reasons(
        ["n"], {"n": reason}, {"n": "OmniHuman 2.0"}, {"n": "omnihuman-2"}, PRICING, REGISTRY))
    for phrase in must_say:
        assert phrase in text, (reason, phrase, text)
    for phrase in must_not_say:
        assert phrase not in text, (reason, phrase, text)


def test_the_spend_refusal_words_each_node_by_its_own_port_in_a_mixed_graph():
    """An audio node and a video node refused for the same reason each get their
    own wording, whichever comes first (the audio wording once leaked onto the
    nodes after it, and one sentence served both)."""
    for order in (["a", "v"], ["v", "a"]):
        sentences = agent_spend._awaiting_reasons(
            order, {"a": input_sizes.REMOTE, "v": input_sizes.REMOTE}, {"a": "OmniHuman 2.0", "v": "SeedVR Video Upscale"},
            {"a": "omnihuman-2", "v": "seedvr-video-upscale"}, PRICING, REGISTRY)
        assert len(sentences) == 2, sentences
        audio = next(text for text in sentences if "OmniHuman 2.0" in text)
        video = next(text for text in sentences if "SeedVR Video Upscale" in text)
        assert "length of its audio" in audio and "Audio Input" in audio and "Image Input" not in audio
        assert "size of its input" in video and "Image Input or Video Input" in video
        assert "audio" not in video.lower() and "OmniHuman" not in video and "SeedVR" not in audio


def test_the_spend_refusal_for_an_image_node_after_an_audio_node_keeps_the_image_wording():
    sentences = agent_spend._awaiting_reasons(
        ["a", "s"], {"a": input_sizes.REMOTE, "s": input_sizes.OUTSIDE}, {"a": "OmniHuman 2.0", "s": "SeedVR2 Upscale"},
        {"a": "omnihuman-2", "s": "seedvr2-upscale"}, PRICING, REGISTRY)
    image = next(text for text in sentences if "SeedVR2 Upscale" in text)
    assert "Audio Input" not in image and "Image Input or Video Input" in image


# -- the missing-input refusals, on both routes (GM r118) ----------------------------------

def _person(exc: BaseException) -> str:
    from execution.person_line import person_line

    return person_line(exc) or ""


@pytest.mark.asyncio
@pytest.mark.parametrize("route_id", ["fal", "replicate"])
@pytest.mark.parametrize("node_id, name", [("omnihuman-1-5", "OmniHuman 1.5"), ("kling-ai-avatar-v2", "Kling AI Avatar v2")])
@pytest.mark.parametrize("wired, what", [({"audio": AUDIO}, "an image"), ({"image": REF}, "an audio track")])
async def test_a_missing_image_or_audio_stops_before_any_request_in_the_same_words_on_both_routes(
        monkeypatch, route_id, node_id, name, wired, what):
    hosts = hosts_for(monkeypatch, "fal" if route_id == "fal" else "replicate", True)
    saved = {**defaults(REGISTRY[node_id]), "_provider": route_id}
    with pytest.raises(ValueError) as caught:
        await registry_handler(node_id)(node(node_id, **saved), av_ports(**wired), dict(KEYS))
    assert _person(caught.value) == (
        f"Nebula couldn\u2019t run \u201c{name}\u201d because it needs {what}. Connect one, then run it again.")
    assert f"needs {what}" in str(caught.value)
    assert not hosts.requests


def test_fal_refuses_a_missing_image_or_audio_for_all_four_endpoints():
    for endpoint in ("fal-ai/bytedance/omnihuman/v1.5", "fal-ai/bytedance/omnihuman/v2",
                     "fal-ai/kling-video/ai-avatar/v2/standard", "fal-ai/kling-video/ai-avatar/v2/pro"):
        for wired, what in (({"audio": AUDIO}, "an image"), ({"image": REF}, "an audio track"), ({}, "an image")):
            with pytest.raises(ValueError, match=f"needs {what}") as caught:
                route_clients.fal_fields(endpoint, {}, av_ports(**wired), "OmniHuman 2.0")
            assert _person(caught.value).startswith("Nebula couldn\u2019t run \u201cOmniHuman 2.0\u201d because it needs")


# -- local media to fal as a data URI: a size cap before it is read ----------------------------

def _stored_blob(name: str, size: int) -> Path:
    path = _stored(name)
    with path.open("wb") as out:
        out.truncate(size)
    return path


def test_a_local_file_over_the_cap_is_refused_before_it_is_read(monkeypatch):
    big = _stored_blob("big.wav", 16 * 1024 * 1024)

    def never_read(self, *args, **kwargs):
        raise AssertionError("the file was read into memory")

    monkeypatch.setattr(Path, "read_bytes", never_read)
    # OmniHuman 2.0 publishes 15 MB for audio on fal's page.
    with pytest.raises(ValueError, match="takes audio up to 15 MB, and this file is 16 MB") as caught:
        route_clients.fal_fields("fal-ai/bytedance/omnihuman/v2", {}, av_ports(image=REF, audio=str(big)), "OmniHuman 2.0")
    assert _person(caught.value) == (
        "Nebula couldn\u2019t run \u201cOmniHuman 2.0\u201d because its audio file is too large at 16 MB, and fal.ai "
        "takes up to 15 MB. Use a smaller file, then run it again.")
    assert ":" not in _person(caught.value)
    # No published limit: the fixed cap.
    bigger = _stored_blob("bigger.wav", 21 * 1024 * 1024)
    with pytest.raises(ValueError, match="up to 20 MB"):
        route_clients.fal_fields("fal-ai/kling-video/ai-avatar/v2/pro", {}, av_ports(image=REF, audio=str(bigger)),
                                 "Kling AI Avatar v2")


@pytest.mark.asyncio
@pytest.mark.parametrize("node_id, params, endpoint", [
    ("omnihuman-1-5", {}, "fal-ai/bytedance/omnihuman/v1.5"),
    ("omnihuman-2", {}, "fal-ai/bytedance/omnihuman/v2"),
    ("kling-ai-avatar-v2", {}, "fal-ai/kling-video/ai-avatar/v2/standard"),
    ("kling-ai-avatar-v2", {"mode": "pro"}, "fal-ai/kling-video/ai-avatar/v2/pro"),
])
async def test_fal_uploads_local_media_and_sends_the_https_url(monkeypatch, local_media, node_id, params, endpoint):
    """fal answers a data: URL on these endpoints with 422 "Failed to download the file" (a real run,
    2026-11-04). The local file goes to fal's storage (fal-client's flow: initiate, then PUT) and the request
    carries the file_url."""
    image, voice = local_media
    hosts, out = await run_fal_local(monkeypatch, node_id, {"image": image, "audio": voice}, **params)
    body = hosts.json("POST", re.escape(FAL + endpoint))
    assert body["image_url"] == "https://v3b.fal.media/files/b/x/portrait.png"
    assert body["audio_url"] == "https://v3b.fal.media/files/b/x/voice.mp3"
    assert "data:" not in json.dumps(body)
    # Each file: one initiate with the fal key, its name and type, and one PUT of its bytes, no key on the PUT.
    starts = hosts.sent("POST", FAL_INIT)
    assert [json.loads(r.content) for r in starts] == [
        {"file_name": "portrait.png", "content_type": "image/png"}, {"file_name": "voice.mp3", "content_type": "audio/mpeg"}]
    assert all(r.headers["authorization"] == "Key fixture-fal" for r in starts)
    puts = hosts.sent("PUT", FAL_PUT)
    assert [r.content for r in puts] == [Path(image).read_bytes(), Path(voice).read_bytes()]
    assert all("authorization" not in r.headers for r in puts)
    validate(SCHEMAS["fal"][endpoint], body)
    assert out["video"]["type"] == "Video"


@pytest.mark.asyncio
async def test_a_data_uri_input_is_uploaded_too_never_sent_inline(monkeypatch):
    """A pasted image or a data: URI from upstream gets the same 422 from fal as a local file would."""
    voice = b"ID3\x03\x00\x00\x00\x00\x00\x00" + b"\x01" * 64
    wired = {"image": "data:image/png;base64," + base64.b64encode(PNG).decode(),
             "audio": "data:audio/mpeg;base64," + base64.b64encode(voice).decode()}
    hosts, _ = await run_fal_local(monkeypatch, "omnihuman-2", wired)
    body = hosts.json("POST", re.escape(FAL + "fal-ai/bytedance/omnihuman/v2"))
    assert "data:" not in json.dumps(body)
    assert body["image_url"].startswith("https://") and body["audio_url"].startswith("https://")
    assert [json.loads(r.content)["content_type"] for r in hosts.sent("POST", FAL_INIT)] == ["image/png", "audio/mpeg"]
    assert [r.content for r in hosts.sent("PUT", FAL_PUT)] == [PNG, voice]


@pytest.mark.asyncio
async def test_a_data_uri_that_isnt_base64_or_is_too_large_stops_before_any_upload(monkeypatch, local_media):
    image, _voice = local_media
    hosts = hosts_for(monkeypatch, "fal", True)
    fal_storage(hosts)
    saved = {**defaults(REGISTRY["omnihuman-2"]), "_provider": "fal"}
    run = registry_handler("omnihuman-2")
    with pytest.raises(ValueError) as caught:
        await run(node("omnihuman-2", **saved), av_ports(image=image, audio="data:audio/mpeg,not-base64"), dict(KEYS))
    assert _person(caught.value) == (
        "Nebula couldn\u2019t run \u201cOmniHuman 2.0\u201d because its audio file couldn\u2019t be read. "
        "Connect it again, then run it again.")
    big = "data:audio/mpeg;base64," + "A" * (16 * 1024 * 1024 * 4 // 3 + 4)  # 16 MB decoded, over fal's 15 MB
    with pytest.raises(ValueError) as caught:
        await run(node("omnihuman-2", **saved), av_ports(image=image, audio=big), dict(KEYS))
    assert "its audio file is too large at 16 MB, and fal.ai takes up to 15 MB" in _person(caught.value)
    assert not hosts.sent("PUT", FAL_PUT)
    assert not hosts.sent("POST", re.escape(FAL + "fal-ai/bytedance/omnihuman/v2"))


@pytest.mark.asyncio
async def test_a_url_input_is_not_uploaded(monkeypatch):
    hosts, _ = await run_fal_local(monkeypatch, "omnihuman-2", {"image": REF, "audio": AUDIO})
    assert not hosts.sent("POST", FAL_INIT) and not hosts.sent("PUT", FAL_PUT)
    assert hosts.json("POST", re.escape(FAL + "fal-ai/bytedance/omnihuman/v2"))["audio_url"] == AUDIO


@pytest.mark.asyncio
@pytest.mark.parametrize("failure, person", [
    ("init-401", "fal.ai wouldn\u2019t store its image file. Check your fal.ai API key in Settings, then run it again."),
    ("init-no-url", "fal.ai wouldn\u2019t store its image file. Run it again."),
    ("init-http-upload-url", "fal.ai wouldn\u2019t store its image file. Run it again."),
    ("put-500", "fal.ai wouldn\u2019t store its image file. Run it again."),
    ("put-307", "fal.ai wouldn\u2019t store its image file. Run it again."),
    ("unreachable", "fal.ai couldn\u2019t be reached to upload its image file. Check your connection, then run it again."),
])
async def test_a_failed_upload_stops_the_run_with_a_clear_line_and_no_job(monkeypatch, local_media, failure, person):
    image, voice = local_media

    def unreachable(request: httpx.Request) -> httpx.Response:
        raise httpx.ConnectError("no route", request=request)

    kwargs = {"init-401": {"init": httpx.Response(401, json={"detail": "bad key"})},
              "init-no-url": {"init": httpx.Response(200, json={"file_url": "http://insecure"})},
              # the file's bytes never go to a plain-http upload_url
              "init-http-upload-url": {"init": httpx.Response(200, json={
                  "upload_url": "http://storage.example/put", "file_url": "https://v3.fal.media/files/x.png"})},
              "put-500": {"put": httpx.Response(500)},
              # httpx doesn't follow redirects: a 3xx stored nothing, so the file_url would 404 at fal
              "put-307": {"put": httpx.Response(307, headers={"location": "https://elsewhere.example/"})},
              "unreachable": {"init": unreachable}}[failure]
    hosts = hosts_for(monkeypatch, "fal", True)
    fal_storage(hosts, **kwargs)
    saved = {**defaults(REGISTRY["omnihuman-2"]), "_provider": "fal"}
    with pytest.raises(RuntimeError) as caught:
        await registry_handler("omnihuman-2")(node("omnihuman-2", **saved), av_ports(image=image, audio=voice), dict(KEYS))
    assert _person(caught.value) == f"Nebula couldn\u2019t run \u201cOmniHuman 2.0\u201d because {person}"
    assert ":" not in _person(caught.value)
    assert not hosts.sent("POST", re.escape(FAL + "fal-ai/bytedance/omnihuman/v2"))  # no job was submitted
    assert not hosts.sent("PUT", re.escape("http://storage.example") + ".*")  # no bytes to a plain-http URL


@pytest.mark.asyncio
async def test_the_size_cap_stops_the_run_before_any_upload(monkeypatch):
    big = _stored_blob("cap-before-upload.wav", 16 * 1024 * 1024)
    hosts = hosts_for(monkeypatch, "fal", True)
    fal_storage(hosts)
    saved = {**defaults(REGISTRY["omnihuman-2"]), "_provider": "fal"}
    with pytest.raises(ValueError, match="takes audio up to 15 MB"):
        await registry_handler("omnihuman-2")(node("omnihuman-2", **saved), av_ports(image=REF, audio=str(big)), dict(KEYS))
    assert not hosts.requests


def test_a_local_file_under_the_cap_still_goes_as_a_data_uri():
    small = _stored_blob("small.wav", 1024)
    fields = route_clients.fal_fields("fal-ai/bytedance/omnihuman/v2", {}, av_ports(image=REF, audio=str(small)))
    assert fields["audio_url"].startswith("data:audio/") and fields["image_url"] == REF


# -- OmniHuman 2.0's 4 second minimum ----------------------------------------------------------
# fal's page says "Duration between 4 and 300 seconds" and bills "Duration of audio input/video
# output", and nothing of padding a shorter clip, so a shorter clip is refused, not priced.

@needs_ffmpeg
@pytest.mark.asyncio
async def test_audio_under_four_seconds_is_refused_before_the_request_and_four_is_not(monkeypatch):
    hosts = hosts_for(monkeypatch, "fal", True)
    saved = {**defaults(REGISTRY["omnihuman-2"]), "_provider": "fal"}
    short = _stored("short.wav")
    _ffmpeg("-f", "lavfi", "-i", "sine=duration=2", str(short))
    with pytest.raises(ValueError) as caught:
        await registry_handler("omnihuman-2")(node("omnihuman-2", **saved), av_ports(image=REF, audio=str(short)), dict(KEYS))
    assert "needs audio of at least 4 s" in str(caught.value)
    assert _person(caught.value) == ("Nebula couldn\u2019t run \u201cOmniHuman 2.0\u201d because it needs audio of at "
                                     "least 4 s. Use a longer audio track, then run it again.")
    assert not hosts.requests


@pytest.mark.asyncio
async def test_audio_that_cant_be_measured_is_left_to_fal_and_other_endpoints_have_no_minimum(monkeypatch):
    hosts = hosts_for(monkeypatch, "fal", True)
    # A remote URL is never measured here: no refusal of ours (fal checks it).
    await route_clients.refuse_short_audio("fal-ai/bytedance/omnihuman/v2", av_ports(audio=AUDIO), "OmniHuman 2.0")
    await route_clients.refuse_short_audio("fal-ai/bytedance/omnihuman/v1.5", av_ports(audio=AUDIO), "OmniHuman 1.5")
    assert not hosts.requests


# -- long jobs: a poll budget of at least 30 minutes, and a clear refusal when it runs out ------
# A real run (2026-11-04): OmniHuman 2.0 was still IN_PROGRESS after 15 min, Kling took 3.5 to 6.6 min.

THIRTY_MINUTES = 30 * 60


@pytest.mark.asyncio
@pytest.mark.parametrize("node_id, params", [("omnihuman-1-5", {}), ("omnihuman-2", {}), ("kling-ai-avatar-v2", {}),
                                             ("kling-ai-avatar-v2", {"mode": "pro"})])
async def test_fal_waits_at_least_30_minutes_for_a_talking_head_and_says_so_when_it_gives_up(monkeypatch, node_id, params):
    from execution.person_line import slow_job_line
    from handlers import fal_universal

    budgets: list[tuple[int, float]] = []
    real = fal_universal.handle_fal_universal

    async def spy(*args, **kwargs):
        budgets.append((kwargs["max_polls"], kwargs["poll_interval"]))
        return await real(*args, **kwargs)

    monkeypatch.setattr(fal_universal, "handle_fal_universal", spy)
    definition = REGISTRY[node_id]
    hosts = hosts_for(monkeypatch, "fal", True)
    queue = "https://queue.fal.run/q/requests/r1"
    hosts.routes[:0] = [("GET", re.escape(f"{queue}/status"), httpx.Response(200, json={"status": "IN_PROGRESS"})),
                        ("PUT", re.escape(f"{queue}/cancel"), httpx.Response(202, json={}))]
    saved = {**defaults(definition), **params, "_provider": "fal"}
    with pytest.raises(RuntimeError, match="timed out after 600 polls") as caught:
        await registry_handler(node_id)(node(node_id, **saved), av_ports(image=REF, audio=AUDIO), dict(KEYS))
    assert budgets and budgets[0][0] * budgets[0][1] >= THIRTY_MINUTES
    assert _person(caught.value) == slow_job_line("fal.ai")
    from services import cancellation

    await asyncio.gather(*list(cancellation._pending_cancel_tasks))
    assert hosts.sent("PUT", re.escape(f"{queue}/cancel"))  # the job is stopped upstream, not left to bill


@pytest.mark.asyncio
@pytest.mark.parametrize("node_id", ["omnihuman-1-5", "kling-ai-avatar-v2"])
async def test_replicate_waits_at_least_30_minutes_for_a_talking_head_and_says_so_when_it_gives_up(monkeypatch, node_id):
    from execution.person_line import slow_job_line
    from handlers import replicate_model

    assert replicate_model.MAX_POLLS * 3.0 < THIRTY_MINUTES  # the default (15 min) is not enough: the nodes pass their own
    budgets: list[int] = []
    real = replicate_model.run_model

    async def spy(*args, **kwargs):
        budgets.append(kwargs["max_polls"])
        return await real(*args, **kwargs)

    monkeypatch.setattr(replicate_model, "run_model", spy)
    hosts = replicate_hosts_forever(monkeypatch)
    saved = {**defaults(REGISTRY[node_id]), "_provider": "replicate"}
    with pytest.raises(RuntimeError, match="timed out after 600 polls") as caught:
        await registry_handler(node_id)(node(node_id, **saved), av_ports(image=REF, audio=AUDIO), dict(KEYS))
    assert budgets == [600] and 600 * 3.0 >= THIRTY_MINUTES  # at Replicate's 3 s poll interval
    assert _person(caught.value) == slow_job_line("Replicate")
    from services import cancellation

    await asyncio.gather(*list(cancellation._pending_cancel_tasks))
    assert hosts.sent("POST", REP + r"predictions/p1/cancel")


def replicate_hosts_forever(monkeypatch) -> FakeHosts:
    return FakeHosts(monkeypatch, [
        ("POST", REP + r"models/[^/]+/[^/]+/predictions", httpx.Response(201, json={"id": "p1", "status": "starting"})),
        ("GET", REP + r"predictions/p1", httpx.Response(200, json={"id": "p1", "status": "processing"})),
        ("POST", REP + r"predictions/p1/cancel", httpx.Response(200, json={})),
    ])


# -- a WAV whose header understates its length ---------------------------------------------------

def _wav_bytes(seconds: float, *, declared: float | None = None, trailing: bytes = b"", rate: int = 16000) -> bytes:
    import struct

    frames = int(rate * seconds)
    data = b"\x01\x00" * frames
    declared_bytes = len(data) if declared is None else int(rate * declared) * 2
    fmt = struct.pack("<HHIIHH", 1, 1, rate, rate * 2, 2, 16)
    body = b"WAVE" + b"fmt " + struct.pack("<I", 16) + fmt + b"data" + struct.pack("<I", declared_bytes) + data + trailing
    return b"RIFF" + struct.pack("<I", len(body)) + body


@needs_ffmpeg
def test_a_wav_whose_data_chunk_understates_its_bytes_is_left_unmeasured():
    honest = _stored("honest.wav")
    honest.write_bytes(_wav_bytes(10))
    assert input_sizes.measure(str(honest), "Audio")["seconds"] == pytest.approx(10, abs=0.1)
    lied = _stored("lied.wav")
    lied.write_bytes(_wav_bytes(10, declared=1))
    assert input_sizes.measure(str(lied), "Audio") is None


@needs_ffmpeg
def test_a_wav_with_a_metadata_chunk_after_the_data_is_still_measured():
    import struct

    path = _stored("tagged.wav")
    tag = b"LIST" + struct.pack("<I", 4000) + b"x" * 4000
    path.write_bytes(_wav_bytes(10, trailing=tag))
    assert input_sizes.measure(str(path), "Audio")["seconds"] == pytest.approx(10, abs=0.1)


@needs_ffmpeg
def test_a_big_fake_metadata_chunk_after_the_data_does_not_hide_audio_from_the_measure():
    """The reviewer's case: 1 s of data, then a 160 KB LIST chunk that spans the rest of the file.
    A provider may read the "metadata" as audio, so the file is left unmeasured; a small LIST is not."""
    import struct

    path = _stored("fake-list.wav")
    path.write_bytes(_wav_bytes(1, trailing=b"LIST" + struct.pack("<I", 160 * 1024) + b"\x01" * (160 * 1024)))
    assert input_sizes.measure(str(path), "Audio") is None
    small = _stored("small-list.wav")
    small.write_bytes(_wav_bytes(1, trailing=b"LIST" + struct.pack("<I", 4000) + b"x" * 4000))
    assert input_sizes.measure(str(small), "Audio")["seconds"] == pytest.approx(1, abs=0.1)
    # More trailing bytes than the audio itself is also unmeasured, even under the byte bound.
    tiny = _stored("longer-than-data.wav")
    tiny.write_bytes(_wav_bytes(0.1, trailing=b"LIST" + struct.pack("<I", 4000) + b"x" * 4000))
    assert input_sizes.measure(str(tiny), "Audio") is None


@needs_ffmpeg
def test_a_wav_with_thousands_of_empty_chunks_is_left_unmeasured():
    import struct

    junk = (b"JUNK" + struct.pack("<I", 0)) * (input_sizes.WAV_MAX_CHUNKS + 100)
    after = _stored("junk-after.wav")
    after.write_bytes(_wav_bytes(1, trailing=junk))
    assert input_sizes.measure(str(after), "Audio") is None
    # The same count before the audio.
    plain = _wav_bytes(1)
    head, data = plain[:36], plain[36:]
    body = head[8:] + junk + data
    before = _stored("junk-before.wav")
    before.write_bytes(b"RIFF" + struct.pack("<I", len(body)) + body)
    assert input_sizes.measure(str(before), "Audio") is None
    # A handful of them is fine.
    few = _stored("junk-few.wav")
    few.write_bytes(_wav_bytes(1, trailing=(b"JUNK" + struct.pack("<I", 0)) * 10))
    assert input_sizes.measure(str(few), "Audio")["seconds"] == pytest.approx(1, abs=0.1)


# -- a node priced by audio length is never priced from a size ---------------------------------

@pytest.mark.parametrize("node_id", ["omnihuman-1-5", "omnihuman-2", "kling-ai-avatar-v2"])
@pytest.mark.parametrize("keys", [{"FAL_KEY": "set"}, {"REPLICATE_API_TOKEN": "set"}])
@pytest.mark.parametrize("size", [None, {}, {"width": 1000, "height": 1000}, {"seconds": 0}, {"frames": 300}])
def test_audio_length_priced_node_with_unreadable_audio_has_no_price_at_all(node_id, keys, size):
    """Unreadable audio (size None, or one without a usable length) leaves the node unpriced and
    awaiting its input: no price of any kind, least of all one from a size or a count of one second."""
    if node_id == "omnihuman-2" and "REPLICATE_API_TOKEN" in keys:
        pytest.skip("OmniHuman 2.0 is not on Replicate")
    item = {"id": "n", "definitionId": node_id, "params": {}, "name": "Talker"}
    sizes = {"n": size}
    result = model_pricing.estimate_run([item], PRICING, REGISTRY, keys, None, {"n": {"image": 1, "audio": 1}}, sizes)
    assert result["priced"] == {} and result["unpriced"] == ["n"]
    # Unreadable audio is "awaiting its input" (the spend gate names the cause); a size with no usable length
    # is just unpriced.
    assert result["awaitingInput"] == (["n"] if size is None else [])
    assert result["low"] is None and result["high"] is None
    for entry in (PRICING["nodes"][node_id]["routes"] or {}).values():
        assert model_pricing.estimate_node(entry, REGISTRY[node_id], {}, wired=["image", "audio"], size=size) is None


def test_the_spend_gate_treats_audio_it_cant_read_as_unpriced_never_as_a_guessed_price():
    item = {"id": "n", "definitionId": "kling-ai-avatar-v2", "params": {}, "name": "Kling AI Avatar v2"}
    estimate = model_pricing.estimate_run([item], PRICING, REGISTRY, {"FAL_KEY": "set"}, None,
                                          {"n": {"image": 1, "audio": 1}}, {"n": None})
    assert "n" in estimate["unpriced"] and "n" not in estimate["priced"]
    text = " ".join(agent_spend._awaiting_reasons(
        ["n"], {"n": input_sizes.UNREADABLE}, {"n": "Kling AI Avatar v2"}, {"n": "kling-ai-avatar-v2"}, PRICING, REGISTRY))
    assert "couldn't read that file's length" in text and "size" not in text.replace("such as", "")


# -- agents and the CLI ------------------------------------------------------------------

@pytest.fixture
def agent_keys(cli, monkeypatch):  # noqa: F811
    """fal and Replicate keys set (fake), nothing else."""
    real = main.load_settings
    monkeypatch.setattr(main, "load_settings", lambda: {**real(), "apiKeys": {"FAL_KEY": "fake", "REPLICATE_API_TOKEN": "fake"}})
    return cli


def test_mcp_find_nodes_and_describe_node_show_the_nodes_ports_routes_and_prices(agent_keys):
    http = TestClient(main.app)
    rows = {row["id"]: row for row in http.get("/api/agent/nodes", params={"query": "omnihuman"}).json()["nodes"]}
    assert set(rows) == {"omnihuman-1-5", "omnihuman-2"}
    assert rows["omnihuman-1-5"]["providers"] == ["fal", "replicate"]
    # An agent reads the price kind: these are priced by their audio's length, not a file size.
    assert all(row["price"] == "by audio length" for row in rows.values())
    assert all("audio\u2019s length" in row["priceNote"] for row in rows.values())
    avatar = {row["id"] for row in http.get("/api/agent/nodes", params={"query": "kling avatar"}).json()["nodes"]}
    assert "kling-ai-avatar-v2" in avatar
    body = http.get("/api/agent/nodes/omnihuman-1-5").json()
    assert [(p["id"], p["type"], p.get("required", False)) for p in body["inputs"]] == [
        ("image", "Image", True), ("audio", "Audio", True), ("prompt", "Text", False)]
    assert [(p["id"], p["type"]) for p in body["outputs"]] == [("video", "Video")]
    assert [r["id"] for r in body["routes"]] == ["fal", "replicate"]
    assert all(r["keySet"] for r in body["routes"]) and not any(r.get("maker") for r in body["routes"])
    assert body["providerChoice"] == {"param": "_provider", "value": "auto", "resolved": "fal"}
    # The price is per second of the audio, known once the audio is.
    assert "Priced from your audio\u2019s length when you run it" in json.dumps(body["price"], ensure_ascii=False)


def test_nebula_nodes_info_and_apply_work_for_the_nodes(agent_keys):
    code, out, err = _run(["nodes", "omnihuman"])
    assert code == 0, err
    assert "omnihuman-1-5" in out and "omnihuman-2" in out
    code, out, err = _run(["info", "kling-ai-avatar-v2"])
    assert code == 0, err
    assert "Kling AI Avatar v2" in out and "ROUTES" in out and "fal" in out and "replicate" in out
    assert "image" in out and "audio" in out and "prompt" in out and "video" in out
    # The other session's graph: an image and an audio file into the node, applied in one step.
    code, out, err = _run(["apply", "--note", "talking head", "--add", "+i=image-input", "--add", "+a=audio-input",
                           "--add", "+t=text-input", "--add", "+n=omnihuman-1-5",
                           "--wire", "+i:image", "+n:image", "--wire", "+a:audio", "+n:audio",
                           "--wire", "+t:text", "+n:prompt"])
    assert code == 0, err
    assert "Applied: added 4, connected 3" in out
    code, out, err = _run(["apply", "--note", "bad", "--add", "+n=omnihuman-2", "--add", "+v=video-input",
                           "--wire", "+v:video", "+n:audio"])
    assert code == 1 and "audio" in err  # a Video can't feed the Audio port


def test_nebula_info_text_lists_each_route_and_its_settings():
    text = format_node_detail(REGISTRY["omnihuman-1-5"])
    assert "ROUTES (_provider" in text
    assert "turbo_mode" not in text  # fal's own spelling is the route's `rename`, not a setting
    for key in ("fast_mode", "resolution", "seed"):
        assert f"  {key}" in text, key
