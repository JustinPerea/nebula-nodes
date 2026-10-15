"""The route clients (execution/route_clients.py ROUTE_CLIENTS): BFL, fal,
Replicate official models, OpenRouter images and videos, and the Krea catalog.

Only the transport is mocked (httpx.MockTransport): no provider is contacted
and nothing is billed. Each request body is checked against the provider's
own schema, copied into fixtures/provider_schemas/ from the provider's docs
(additionalProperties false, so a stray param fails here, not on a billed
call). The fixture nodes in fixtures/route_client_definitions.json are shaped
like the FLUX 3 nodes and run end to end through multi_route.
"""
from __future__ import annotations

import asyncio
import base64
import json
import re
from pathlib import Path
from types import SimpleNamespace
from typing import Any, Callable
from unittest.mock import AsyncMock

import httpx
import pytest
from jsonschema import Draft202012Validator

from execution import maker_routes, poll_retry, route_clients
from execution.missing_credential import MissingCredentialError
from models.graph import GraphNode, PortValueDict

FIXTURES = Path(__file__).parent / "fixtures"
DEFINITIONS = json.loads((FIXTURES / "route_client_definitions.json").read_text())["definitions"]
SCHEMAS = {name: json.loads((FIXTURES / "provider_schemas" / f"{name}.json").read_text())["schemas"]
           for name in ("bfl", "fal", "replicate", "openrouter")}
PNG = base64.b64decode(
    "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8/5+hHgAHggJ/PchI7wAAAABJRU5ErkJggg==")
MP4 = b"\x00\x00\x00\x18ftypmp42\x00\x00\x00\x00mp42isom" + b"\x00" * 64
PNG_URI = "data:image/png;base64," + base64.b64encode(PNG).decode()
KEYS = {"BFL_API_KEY": "fixture-bfl", "FAL_KEY": "fixture-fal", "REPLICATE_API_TOKEN": "fixture-rep",
        "OPENROUTER_API_KEY": "fixture-or", "KREA_API_TOKEN": "fixture-krea"}
_REAL_CLIENT = httpx.AsyncClient
_REAL_SLEEP = asyncio.sleep


def validate(schema: dict[str, Any], body: dict[str, Any]) -> None:
    """The body against the provider's schema, unknown fields refused."""
    strict = {**schema, "additionalProperties": False} if "properties" in schema else schema
    errors = [e.message for e in Draft202012Validator(strict).iter_errors(body)]
    assert not errors, errors


class FakeHosts:
    """Every httpx client answers from ``routes``: (method, url regex) ->
    a response or a callable. Records each request."""

    def __init__(self, monkeypatch: pytest.MonkeyPatch, routes: list[tuple[str, str, Any]]):
        self.routes = routes
        self.requests: list[httpx.Request] = []

        answer = self._answer

        class Client(_REAL_CLIENT):  # a class, so annotations reading httpx.AsyncClient still work
            def __init__(self, *args: Any, **kwargs: Any) -> None:
                kwargs.pop("transport", None)
                super().__init__(*args, transport=httpx.MockTransport(answer), **kwargs)

        monkeypatch.setattr(httpx, "AsyncClient", Client)

    def _answer(self, request: httpx.Request) -> httpx.Response:
        self.requests.append(request)
        for method, pattern, answer in self.routes:
            if request.method == method and re.fullmatch(pattern, str(request.url)):
                if isinstance(answer, list):
                    answer = answer.pop(0) if len(answer) > 1 else answer[0]
                return answer(request) if callable(answer) else answer
        return httpx.Response(599, text=f"unexpected {request.method} {request.url}")

    def sent(self, method: str, pattern: str) -> list[httpx.Request]:
        return [r for r in self.requests if r.method == method and re.fullmatch(pattern, str(r.url))]

    def json(self, method: str, pattern: str) -> dict[str, Any]:
        found = self.sent(method, pattern)
        assert found, f"no {method} {pattern} in {[str(r.url) for r in self.requests]}"
        return json.loads(found[-1].content)


async def _fast_sleep(_seconds: float = 0, *args: Any) -> None:
    await _REAL_SLEEP(0)


@pytest.fixture(autouse=True)
def quick(monkeypatch):
    """No waiting between polls, video bytes accepted without ffprobe, the
    fixture definitions in place of the registry's."""
    from handlers import bfl, fal_universal, krea_gateway, openrouter_media, replicate_model

    monkeypatch.setattr(bfl, "POLL_INTERVAL", {"Image": 0.0, "Video": 0.0})
    monkeypatch.setattr(fal_universal, "asyncio",
                        SimpleNamespace(sleep=_fast_sleep, CancelledError=asyncio.CancelledError))
    monkeypatch.setattr(replicate_model, "POLL_INTERVAL", 0.0)
    monkeypatch.setattr(openrouter_media, "VIDEO_POLL_INTERVAL", 0.0)
    monkeypatch.setattr(krea_gateway, "POLL_INTERVAL", 0.0)
    monkeypatch.setattr(poll_retry, "POLL_RETRY_DELAYS", (0.0, 0.0))
    monkeypatch.setattr("services.output.ffprobe_video", AsyncMock(return_value={}))
    monkeypatch.setattr(maker_routes, "definition_for", lambda definition_id: DEFINITIONS[definition_id])


@pytest.fixture
def local_png():
    from services.output import OUTPUT_ROOT

    folder = Path(OUTPUT_ROOT) / "route-client-inputs"
    folder.mkdir(parents=True, exist_ok=True)
    path = folder / "frame.png"
    path.write_bytes(PNG)
    return str(path)


def node(definition_id: str, **params: Any) -> GraphNode:
    return GraphNode(id="n1", definitionId=definition_id, params=params)


def ports(**values: Any) -> dict[str, PortValueDict]:
    kinds = {"prompt": "Text", "start_video": "Video", "video": "Video"}
    return {port: PortValueDict(type=kinds.get(port, "Image"), value=value) for port, value in values.items()}


def route(definition_id: str, route_id: str) -> dict[str, Any]:
    return next(r for r in DEFINITIONS[definition_id]["routes"] if r["id"] == route_id)


async def run(handler: str, definition_id: str, route_id: str, params: dict[str, Any], inputs, endpoint=None,
              keys=KEYS):
    client = route_clients.ROUTE_CLIENTS[handler]
    spec = route(definition_id, route_id)
    return await client.run(node(definition_id, **params), inputs, dict(keys), route=spec, emit=None,
                            endpoint=endpoint if endpoint is not None else spec.get("endpoint"))


# -- BFL ------------------------------------------------------------------------

BFL_POLL = "https://api.us1.bfl.ai/v1/get_result?id=t1"
BFL_SAMPLE = "https://delivery-us1.bfl.ai/results/t1/sample"


def bfl_hosts(monkeypatch, sample: bytes = PNG) -> FakeHosts:
    return FakeHosts(monkeypatch, [
        ("POST", r"https://api\.bfl\.ai/v1/.*", httpx.Response(200, json={"id": "t1", "polling_url": BFL_POLL, "cost": 4.8})),
        ("GET", re.escape(BFL_POLL), [httpx.Response(200, json={"id": "t1", "status": "Pending"}),
                                      httpx.Response(200, json={"id": "t1", "status": "Ready", "cost": 4.8,
                                                                "result": {"sample": BFL_SAMPLE}})]),
        ("GET", re.escape(BFL_SAMPLE), httpx.Response(200, content=sample,
                                                      headers={"content-type": "image/png" if sample is PNG else "video/mp4"})),
    ])


@pytest.mark.asyncio
async def test_bfl_image_sends_the_schema_body_with_images_and_saves_the_image(monkeypatch, local_png):
    hosts = bfl_hosts(monkeypatch)
    out = await run("bfl", "clients-image", "bfl", {"resolution": "1.5k", "aspect_ratio": "9:21",
                                                     "safety_tolerance": 2, "grounding": False},
                    ports(prompt="a lighthouse", images=[local_png, "https://example.com/b.png"]))
    body = hosts.json("POST", r"https://api\.bfl\.ai/v1/flux-3-image")
    validate(SCHEMAS["bfl"]["flux-3-image"], body)
    assert body == {"prompt": "a lighthouse", "resolution": "1.5k", "aspect_ratio": "9:21", "safety_tolerance": 2,
                    "grounding": False, "images": [PNG_URI, "https://example.com/b.png"]}
    assert hosts.sent("POST", r".*")[0].headers["x-key"] == "fixture-bfl"
    assert "x-key" not in hosts.sent("GET", re.escape(BFL_SAMPLE))[0].headers
    assert out["image"]["type"] == "Image" and Path(out["image"]["value"]).read_bytes() == PNG


@pytest.mark.asyncio
@pytest.mark.parametrize("wired, expected", [
    ({}, {"mode": "t2v"}),
    ({"start_image": "https://e.com/s.png"}, {"mode": "i2v", "keyframes": ["https://e.com/s.png"]}),
    ({"start_image": "https://e.com/s.png", "keyframes": ["https://e.com/k.png"], "end_image": "https://e.com/e.png"},
     {"mode": "i2v", "keyframes": ["https://e.com/s.png", "https://e.com/k.png", "https://e.com/e.png"]}),
    ({"start_video": "https://e.com/v.mp4"}, {"mode": "v2v", "start_video": "https://e.com/v.mp4"}),
])
async def test_bfl_video_picks_its_mode_from_the_wired_ports(monkeypatch, wired, expected):
    hosts = bfl_hosts(monkeypatch, sample=MP4)
    out = await run("bfl", "clients-video", "bfl", {"duration": 8, "resolution": "fhd", "aspect_ratio": "16:9",
                                                     "generate_audio": True},
                    ports(prompt="a fox in the mist", **wired))
    body = hosts.json("POST", r"https://api\.bfl\.ai/v1/flux-3-video")
    validate(SCHEMAS["bfl"]["flux-3-video"], body)
    assert body == {"prompt": "a fox in the mist", "duration": 8, "resolution": "fhd", "aspect_ratio": "16:9",
                    "generate_audio": True, **expected}
    assert out["video"]["type"] == "Video"


@pytest.mark.asyncio
@pytest.mark.parametrize("wired, message", [
    ({"start_video": "https://e.com/v.mp4", "start_image": "https://e.com/s.png"}, "not both"),
    ({"end_image": "https://e.com/e.png"}, "needs a start image"),
    ({"video": "https://e.com/v.mp4"}, "can't take the wired video"),
])
async def test_bfl_refuses_a_recipe_it_cant_send_before_any_request(monkeypatch, wired, message):
    hosts = bfl_hosts(monkeypatch)
    with pytest.raises(ValueError, match=message):
        await run("bfl", "clients-video", "bfl", {"duration": 8}, ports(prompt="p", **wired))
    assert not hosts.requests


END_ONLY = {"end_image": "https://e.com/e.png"}


@pytest.mark.asyncio
@pytest.mark.parametrize("handler, route_id, hosts_for", [
    ("fal", "fal", lambda mp: fal_hosts(mp, {"video": {"url": "https://fal.media/x.mp4"}})),
    ("replicate-model", "replicate", lambda mp: FakeHosts(mp, [])),
    ("openrouter-videos", "openrouter", lambda mp: FakeHosts(mp, [])),
    ("krea", "krea", lambda mp: krea_hosts(mp)),
])
async def test_every_video_route_refuses_an_end_image_alone_before_any_request(monkeypatch, handler, route_id,
                                                                                hosts_for):
    # The rule BFL's test above pins, on every route: no provider may open
    # the clip on the frame meant to close it, or bill a run that would.
    hosts = hosts_for(monkeypatch)
    spec = route("clients-video", route_id)
    params = {"_kreaAuth": "api-token", "duration": 5} if route_id == "krea" else {"duration": 5}
    endpoint = None
    if route_id == "fal":  # the endpoint the router picks for a wired end_image
        from services import node_route

        definition = DEFINITIONS["clients-video"]
        endpoint = node_route.route_endpoint(definition, spec, node_route.with_wired_blockers(
            definition, params, {"end_image": 1}))
        assert endpoint == "blackforestlabs/flux-3/first-last-frame-to-video"
    with pytest.raises(ValueError, match="needs a start image"):
        await run(handler, "clients-video", route_id, params, ports(prompt="p", **END_ONLY), endpoint=endpoint)
    assert not hosts.requests


@pytest.mark.asyncio
async def test_bfl_path_without_a_request_shape_is_refused(monkeypatch):
    hosts = bfl_hosts(monkeypatch)
    with pytest.raises(ValueError, match="no request shape for Black Forest Labs' flux-2-pro"):
        await run("bfl", "clients-image", "bfl", {}, ports(prompt="p"), endpoint="/v1/flux-2-pro")
    assert not hosts.requests


def test_bfl_video_tools_take_the_source_under_their_own_field():
    edit = route_clients.bfl_body("flux-tools/video-edit-v1", {"safety_tolerance": 2},
                                  ports(prompt="remove the cars", start_video="https://e.com/v.mp4"))
    validate(SCHEMAS["bfl"]["flux-tools/video-edit-v1"], edit)
    assert edit == {"safety_tolerance": 2, "prompt": "remove the cars", "video": "https://e.com/v.mp4"}
    upscale = route_clients.bfl_body("flux-tools/video-upscale-v1", {"creativity": 0, "upscale_factor": 2.0},
                                     ports(video="https://e.com/v.mp4"))
    validate(SCHEMAS["bfl"]["flux-tools/video-upscale-v1"], upscale)
    assert upscale == {"creativity": 0, "upscale_factor": 2.0, "input_video": "https://e.com/v.mp4"}


# -- fal ------------------------------------------------------------------------

FAL = r"https://queue\.fal\.run/"


def fal_hosts(monkeypatch, result: dict[str, Any], statuses: list[str] | None = None) -> FakeHosts:
    queue = "https://queue.fal.run/blackforestlabs/flux-3/requests/r1"
    return FakeHosts(monkeypatch, [
        ("POST", FAL + r"blackforestlabs/.*", httpx.Response(200, json={
            "request_id": "r1", "status_url": f"{queue}/status", "response_url": queue, "cancel_url": f"{queue}/cancel"})),
        ("GET", re.escape(f"{queue}/status"), [httpx.Response(200, json={"status": s})
                                               for s in (statuses or ["IN_PROGRESS", "COMPLETED"])]),
        ("GET", re.escape(queue), httpx.Response(200, json=result)),
        ("PUT", re.escape(f"{queue}/cancel"), httpx.Response(202, json={})),
    ])


@pytest.mark.asyncio
async def test_fal_text_to_image_sends_only_the_routes_params_and_keys_the_output_by_port(monkeypatch):
    hosts = fal_hosts(monkeypatch, {"images": [{"url": "https://fal.media/x.png", "content_type": "image/png"}]})
    out = await run("fal", "clients-image", "fal", {"resolution": "2k", "aspect_ratio": "16:9", "safety_tolerance": 3},
                    ports(prompt="a lighthouse"))
    body = hosts.json("POST", FAL + r"blackforestlabs/flux-3/text-to-image")
    validate(SCHEMAS["fal"]["blackforestlabs/flux-3/text-to-image"], body)
    assert body == {"prompt": "a lighthouse", "resolution": "2k", "aspect_ratio": "16:9", "safety_tolerance": 3}
    assert hosts.sent("POST", r".*")[0].headers["authorization"] == "Key fixture-fal"
    assert out == {"image": {"type": "Image", "value": "https://fal.media/x.png"}}


@pytest.mark.parametrize("endpoint, params, wired, expected", [
    ("blackforestlabs/flux-3/edit-image", {"resolution": "1k"}, {"images": ["https://e.com/a.png", "https://e.com/b.png"]},
     {"image_urls": ["https://e.com/a.png", "https://e.com/b.png"]}),
    ("blackforestlabs/flux-3/image-to-video", {"resolution": "720p"}, {"start_image": "https://e.com/s.png"},
     {"image_url": "https://e.com/s.png"}),
    ("blackforestlabs/flux-3/first-last-frame-to-video", {"duration": 6},
     {"start_image": "https://e.com/s.png", "end_image": "https://e.com/e.png"},
     {"start_image_url": "https://e.com/s.png", "end_image_url": "https://e.com/e.png"}),
    ("blackforestlabs/flux-3/keyframes-to-video", {"duration": 5},
     {"start_image": "https://e.com/s.png", "keyframes": ["https://e.com/k.png"], "end_image": "https://e.com/e.png"},
     {"keyframes": [{"image_url": "https://e.com/s.png", "frame_index": 0},
                    {"image_url": "https://e.com/k.png", "frame_index": 60},
                    {"image_url": "https://e.com/e.png", "frame_index": 120}]}),
    ("blackforestlabs/flux-3/extend-video", {"duration": 5}, {"start_video": "https://e.com/v.mp4"},
     {"video_url": "https://e.com/v.mp4"}),
    ("blackforestlabs/flux-3/extend-video/draft", {"duration": 5}, {"start_video": "https://e.com/v.mp4"},
     {"video_url": "https://e.com/v.mp4"}),
    ("blackforestlabs/flux-3/edit-video", {}, {"start_video": "https://e.com/v.mp4"}, {"video_url": "https://e.com/v.mp4"}),
])
def test_fal_media_fields_match_each_endpoints_schema(endpoint, params, wired, expected):
    fields = route_clients.fal_fields(endpoint, params, ports(prompt="p", **wired))
    assert fields == expected
    validate(SCHEMAS["fal"][endpoint], {"prompt": "p", **params, **fields})


def test_fal_refuses_what_an_endpoint_cant_take():
    with pytest.raises(ValueError, match="can't take the wired start_image"):
        route_clients.fal_fields("blackforestlabs/flux-3/text-to-video", {}, ports(prompt="p", start_image="a.png"))
    with pytest.raises(ValueError, match="needs a set duration"):
        route_clients.fal_fields("blackforestlabs/flux-3/keyframes-to-video", {"duration": "auto"},
                                 ports(prompt="p", keyframes=["a.png"]))
    with pytest.raises(ValueError, match="no request shape for fal.ai's blackforestlabs/flux-3/draft-enhance"):
        route_clients.fal_fields("blackforestlabs/flux-3/draft-enhance", {}, ports(prompt="p"))


def test_keyframes_spread_evenly_over_the_clip():
    assert route_clients.keyframe_indexes(1, 5) == [0]
    assert route_clients.keyframe_indexes(2, 8) == [0, 192]
    assert route_clients.keyframe_indexes(4, 5) == [0, 40, 80, 120]


@pytest.mark.asyncio
async def test_fal_failure_raises_and_cancel_stops_the_request_upstream(monkeypatch):
    fal_hosts(monkeypatch, {}, statuses=["FAILED"])
    with pytest.raises(RuntimeError, match="FAL job failed"):
        await run("fal", "clients-image", "fal", {}, ports(prompt="p"))

    hosts = fal_hosts(monkeypatch, {}, statuses=["IN_PROGRESS"])
    from handlers import fal_universal

    polled = asyncio.Event()

    async def sleep(_seconds: float = 0) -> None:
        if hosts.sent("GET", r".*/status"):
            polled.set()
            await _REAL_SLEEP(3600)
        await _REAL_SLEEP(0)

    monkeypatch.setattr(fal_universal, "asyncio", SimpleNamespace(sleep=sleep, CancelledError=asyncio.CancelledError))
    task = asyncio.ensure_future(run("fal", "clients-image", "fal", {}, ports(prompt="p")))
    await asyncio.wait_for(polled.wait(), 5)
    task.cancel()
    with pytest.raises(asyncio.CancelledError):
        await task
    from services import cancellation

    await asyncio.gather(*list(cancellation._pending_cancel_tasks))
    assert hosts.sent("PUT", r".*/r1/cancel")


# -- Replicate --------------------------------------------------------------------

REP = r"https://api\.replicate\.com/v1/"
REP_OUT = "https://replicate.delivery/xezq/abc/out.webp"


def replicate_hosts(monkeypatch, polls: list[dict[str, Any]], output_url: str = REP_OUT,
                    content: bytes = PNG) -> FakeHosts:
    return FakeHosts(monkeypatch, [
        ("POST", REP + r"files", httpx.Response(201, json={"id": "f1", "urls": {"get": "https://api.replicate.com/v1/files/f1"}})),
        ("POST", REP + r"models/[^/]+/[^/]+/predictions", httpx.Response(201, json={"id": "p1", "status": "starting"})),
        ("GET", REP + r"predictions/p1", [httpx.Response(200, json=p) for p in polls]),
        ("POST", REP + r"predictions/p1/cancel", httpx.Response(200, json={})),
        ("GET", re.escape(output_url), httpx.Response(200, content=content)),
    ])


@pytest.mark.asyncio
async def test_replicate_runs_the_official_model_uploads_local_images_and_saves_by_port_type(monkeypatch, local_png):
    hosts = replicate_hosts(monkeypatch, [{"id": "p1", "status": "processing"},
                                          {"id": "p1", "status": "succeeded", "output": REP_OUT}])
    out = await run("replicate-model", "clients-image", "replicate",
                    {"resolution": "1k", "aspect_ratio": "auto", "safety_tolerance": 2, "grounding": True},
                    ports(prompt="a lighthouse", images=[local_png, "https://e.com/b.png"]))
    upload = hosts.sent("POST", REP + "files")
    assert len(upload) == 1 and b'name="content"; filename="frame.png"' in upload[0].content
    body = hosts.json("POST", REP + r"models/black-forest-labs/flux-3-image/predictions")
    assert set(body) == {"input"}
    validate(SCHEMAS["replicate"]["black-forest-labs/flux-3-image"], body["input"])
    assert body["input"]["images"] == ["https://api.replicate.com/v1/files/f1", "https://e.com/b.png"]
    assert body["input"]["prompt"] == "a lighthouse"
    # The output URL says .webp; the port says Image, and the bytes are a PNG.
    assert hosts.sent("GET", re.escape(REP_OUT))[0].headers["authorization"] == "Bearer fixture-rep"
    assert out["image"]["type"] == "Image" and Path(out["image"]["value"]).read_bytes() == PNG


@pytest.mark.asyncio
async def test_replicate_video_puts_frames_in_order_and_saves_a_video(monkeypatch):
    url = "https://replicate.delivery/xezq/abc/tmp.mp4"
    hosts = replicate_hosts(monkeypatch, [{"id": "p1", "status": "succeeded", "output": url}], url, MP4)
    out = await run("replicate-model", "clients-video", "replicate",
                    {"resolution": "720p", "duration": "8", "aspect_ratio": "16:9", "generate_audio": True},
                    ports(prompt="p", start_image="https://e.com/s.png", end_image="https://e.com/e.png"))
    body = hosts.json("POST", REP + r"models/black-forest-labs/flux-3/predictions")["input"]
    validate(SCHEMAS["replicate"]["black-forest-labs/flux-3"], body)
    assert body["images"] == ["https://e.com/s.png", "https://e.com/e.png"]
    assert out["video"]["type"] == "Video"


@pytest.mark.asyncio
async def test_replicate_sends_the_token_only_to_its_delivery_hosts(monkeypatch):
    other = "https://cdn.example.com/out.png"
    hosts = replicate_hosts(monkeypatch, [{"id": "p1", "status": "succeeded", "output": [other]}], other)
    await run("replicate-model", "clients-image", "replicate", {}, ports(prompt="p"))
    assert "authorization" not in hosts.sent("GET", re.escape(other))[0].headers
    assert not route_clients_delivery("https://replicate.delivery.evil.com/x")
    assert route_clients_delivery("https://pbxt.replicate.delivery/x")


def route_clients_delivery(url: str) -> bool:
    from handlers.replicate_model import delivery_host

    return delivery_host(url)


@pytest.mark.asyncio
async def test_replicate_failure_raises_and_a_stopped_run_cancels_the_prediction(monkeypatch):
    replicate_hosts(monkeypatch, [{"id": "p1", "status": "failed", "error": "NSFW"}])
    with pytest.raises(RuntimeError, match="NSFW"):
        await run("replicate-model", "clients-image", "replicate", {}, ports(prompt="p"))

    hosts = replicate_hosts(monkeypatch, [{"id": "p1", "status": "processing"}])
    from handlers import replicate_model

    monkeypatch.setattr(replicate_model, "MAX_POLLS", 2)
    with pytest.raises(RuntimeError, match="timed out"):
        await run("replicate-model", "clients-image", "replicate", {}, ports(prompt="p"))
    from services import cancellation

    await asyncio.gather(*list(cancellation._pending_cancel_tasks))
    assert hosts.sent("POST", REP + r"predictions/p1/cancel")


@pytest.mark.asyncio
async def test_replicate_refuses_a_video_and_images_together_and_bad_model_names(monkeypatch):
    hosts = replicate_hosts(monkeypatch, [])
    with pytest.raises(ValueError, match="not both"):
        await run("replicate-model", "clients-video", "replicate", {},
                  ports(prompt="p", start_video="https://e.com/v.mp4", start_image="https://e.com/s.png"))
    with pytest.raises(ValueError, match="owner/name"):
        await run("replicate-model", "clients-image", "replicate", {}, ports(prompt="p"), endpoint="a/b/../c")
    assert not hosts.requests


# -- OpenRouter -------------------------------------------------------------------

OR = r"https://openrouter\.ai/api/v1/"


@pytest.mark.asyncio
async def test_openrouter_images_body_passthrough_references_and_saved_image(monkeypatch, local_png):
    hosts = FakeHosts(monkeypatch, [("POST", OR + "images", httpx.Response(200, json={
        "data": [{"b64_json": base64.b64encode(PNG).decode(), "media_type": "image/png"}], "usage": {"cost": 0.048}}))])
    out = await run("openrouter-images", "clients-image", "openrouter",
                    {"resolution": "1K", "aspect_ratio": "auto", "safety_tolerance": 2},
                    ports(prompt="a lighthouse", images=[local_png]))
    body = hosts.json("POST", OR + "images")
    validate(SCHEMAS["openrouter"]["images/black-forest-labs/flux-3-image"], body)
    assert body == {"model": "black-forest-labs/flux-3-image", "prompt": "a lighthouse", "resolution": "1K",
                    "aspect_ratio": "auto", "provider": {"options": {"black-forest-labs": {"safety_tolerance": 2}}},
                    "input_references": [{"type": "image_url", "image_url": {"url": PNG_URI}}]}
    assert hosts.requests[0].headers["authorization"] == "Bearer fixture-or"
    assert out["image"]["type"] == "Image" and Path(out["image"]["value"]).read_bytes() == PNG


@pytest.mark.asyncio
async def test_openrouter_images_errors_say_what_to_do(monkeypatch):
    FakeHosts(monkeypatch, [("POST", OR + "images", httpx.Response(402, json={"error": {"message": "Insufficient credits"}}))])
    with pytest.raises(RuntimeError, match="credits ran out"):
        await run("openrouter-images", "clients-image", "openrouter", {}, ports(prompt="p"))


@pytest.mark.asyncio
async def test_openrouter_videos_submit_poll_and_download_with_frames(monkeypatch):
    content = "https://openrouter.ai/api/v1/videos/job-1/content?index=0"
    hosts = FakeHosts(monkeypatch, [
        ("POST", OR + "videos", httpx.Response(202, json={"id": "job-1", "polling_url": "https://evil.example/poll",
                                                         "status": "pending"})),
        ("GET", OR + "videos/job-1", [httpx.Response(200, json={"id": "job-1", "status": "in_progress"}),
                                      httpx.Response(200, json={"id": "job-1", "status": "completed",
                                                                "unsigned_urls": [content], "usage": {"cost": 0.85}})]),
        ("GET", re.escape(content), httpx.Response(200, content=MP4, headers={"content-type": "video/mp4"})),
    ])
    out = await run("openrouter-videos", "clients-video", "openrouter",
                    {"duration": 5, "resolution": "720p", "aspect_ratio": "16:9", "generate_audio": True},
                    ports(prompt="a fox", start_image="https://e.com/s.png", end_image="https://e.com/e.png"))
    body = hosts.json("POST", OR + "videos")
    validate(SCHEMAS["openrouter"]["videos/black-forest-labs/flux-3-video"], body)
    assert body["frame_images"] == [
        {"type": "image_url", "image_url": {"url": "https://e.com/s.png"}, "frame_type": "first_frame"},
        {"type": "image_url", "image_url": {"url": "https://e.com/e.png"}, "frame_type": "last_frame"}]
    # Polled at the documented path, never the answer's polling_url; the key reaches only openrouter.ai.
    assert not [r for r in hosts.requests if "evil" in str(r.url)]
    assert hosts.sent("GET", re.escape(content))[0].headers["authorization"] == "Bearer fixture-or"
    assert out["video"]["type"] == "Video"


@pytest.mark.asyncio
async def test_openrouter_videos_failures_and_unsupported_inputs(monkeypatch):
    hosts = FakeHosts(monkeypatch, [
        ("POST", OR + "videos", httpx.Response(202, json={"id": "job-1", "status": "pending"})),
        ("GET", OR + "videos/job-1", httpx.Response(200, json={"id": "job-1", "status": "failed",
                                                               "error": "Content policy violation"})),
    ])
    with pytest.raises(RuntimeError, match="Content policy violation"):
        await run("openrouter-videos", "clients-video", "openrouter", {}, ports(prompt="p"))
    before = len(hosts.requests)
    with pytest.raises(ValueError, match="can't take the wired start_video"):
        await run("openrouter-videos", "clients-video", "openrouter", {},
                  ports(prompt="p", start_video="https://e.com/v.mp4"))
    assert len(hosts.requests) == before


# -- Krea catalog ---------------------------------------------------------------

KREA = r"https://api\.krea\.ai"
KREA_RESULT = "https://gen.krea.ai/out/video.mp4"


def krea_hosts(monkeypatch) -> FakeHosts:
    return FakeHosts(monkeypatch, [
        ("POST", KREA + "/assets", httpx.Response(200, json={"image_url": "https://gen.krea.ai/in/frame.png"})),
        ("POST", KREA + "/generate/video/black-forest-labs/flux-3-video",
         httpx.Response(200, json={"job_id": "job1", "status": "queued"})),
        ("GET", KREA + "/jobs/job1", httpx.Response(200, json={"job_id": "job1", "status": "completed",
                                                                 "result": {"urls": [KREA_RESULT]}})),
        ("GET", re.escape(KREA_RESULT), httpx.Response(200, content=MP4, headers={"content-type": "video/mp4"})),
    ])


@pytest.mark.asyncio
async def test_krea_runs_the_named_catalog_model_on_the_api_token(monkeypatch, local_png):
    hosts = krea_hosts(monkeypatch)
    out = await run("krea", "clients-video", "krea",
                    {"_kreaAuth": "api-token", "duration": 5, "resolution": "720p", "aspect_ratio": "16:9"},
                    ports(prompt="a fox", start_image=local_png))
    body = hosts.json("POST", KREA + "/generate/video/black-forest-labs/flux-3-video")
    assert body == {"prompt": "a fox", "duration": 5, "resolution": "720p", "aspect_ratio": "16:9",
                    "start_image": "https://gen.krea.ai/in/frame.png"}
    assert hosts.sent("POST", KREA + "/assets")[0].headers["authorization"] == "Bearer fixture-krea"
    assert "authorization" not in hosts.sent("GET", re.escape(KREA_RESULT))[0].headers
    assert out["video"]["type"] == "Video" and set(out) == {"video"}


@pytest.mark.asyncio
async def test_krea_plan_runs_through_the_account_path(monkeypatch):
    from services import krea_mcp_generation

    seen: dict[str, Any] = {}

    async def generate(node, body, model, assets, map_body, validate_, emit, **kwargs):
        seen.update(body=body, endpoint=model["endpoint"])
        return {"status": "completed", "result": {"urls": [KREA_RESULT]}}

    monkeypatch.setattr(krea_mcp_generation, "generate", generate)
    hosts = krea_hosts(monkeypatch)
    out = await run("krea", "clients-video", "krea", {"_kreaAuth": "mcp", "duration": 5},
                    ports(prompt="a fox"), keys={})
    assert seen == {"body": {"prompt": "a fox", "duration": 5}, "endpoint": "/generate/video/black-forest-labs/flux-3-video"}
    assert not hosts.sent("POST", r".*")
    assert out["video"]["type"] == "Video"


@pytest.mark.asyncio
async def test_krea_needs_the_billing_mode_and_a_known_catalog_model(monkeypatch):
    hosts = krea_hosts(monkeypatch)
    with pytest.raises(ValueError, match="billing mode"):
        await run("krea", "clients-video", "krea", {"duration": 5}, ports(prompt="p"))
    with pytest.raises(ValueError, match="No bundled Krea catalog model"):
        await run("krea", "clients-video", "krea", {"_kreaAuth": "api-token"}, ports(prompt="p"),
                  endpoint="/generate/video/nobody/nothing")
    with pytest.raises(MissingCredentialError):
        await run("krea", "clients-video", "krea", {"_kreaAuth": "api-token"}, ports(prompt="p"), keys={})
    assert not hosts.requests
    from handlers.krea_gateway import catalog_key_for

    assert catalog_key_for("/generate/video/black-forest-labs/flux-3-video") == "krea-video-black-forest-labs-flux-3-video"


# -- End to end through multi_route ----------------------------------------------


def registry_handler(definition_id: str):
    registry: dict[str, Any] = {}
    route_clients.register_route_nodes(registry, DEFINITIONS)
    return registry[definition_id]


def test_the_fixture_nodes_are_sound_route_tables():
    from services import node_route

    for definition in DEFINITIONS.values():
        assert node_route.routes_problems(definition) == []
    assert set(route_clients.ROUTE_CLIENTS) == set(node_route.ROUTE_HANDLERS)


@pytest.mark.asyncio
@pytest.mark.parametrize("definition_id, provider, params, wired, hosts_for, request_pattern, check", [
    ("clients-image", "bfl", {"resolution": "4k"}, {"images": ["https://e.com/a.png"]}, "bfl",
     r"https://api\.bfl\.ai/v1/flux-3-image",
     lambda body: body == {"prompt": "p", "aspect_ratio": "auto", "resolution": "4k", "safety_tolerance": 2,
                           "grounding": False, "images": ["https://e.com/a.png"]}),
    ("clients-image", "fal", {"resolution": "768sq"}, {"images": ["https://e.com/a.png"]}, "fal",
     FAL + r"blackforestlabs/flux-3/edit-image",
     lambda body: body == {"prompt": "p", "aspect_ratio": "auto", "resolution": "768sq", "safety_tolerance": 2,
                           "image_urls": ["https://e.com/a.png"]}),
    ("clients-video", "replicate", {"duration": 7, "resolution": "fhd"}, {}, "replicate",
     REP + r"models/black-forest-labs/flux-3/predictions",
     lambda body: body == {"input": {"prompt": "p", "duration": "7", "resolution": "1080p", "aspect_ratio": "16:9",
                                     "generate_audio": True}}),
    ("clients-image", "openrouter", {"resolution": "1.5k"}, {}, "openrouter-images", OR + "images",
     lambda body: body == {"model": "black-forest-labs/flux-3-image", "prompt": "p", "resolution": "1.5K",
                           "aspect_ratio": "auto", "provider": {"options": {"black-forest-labs": {"safety_tolerance": 2}}}}),
    ("clients-video", "openrouter", {"resolution": "fhd"}, {"start_image": "https://e.com/s.png"}, "openrouter-videos",
     OR + "videos",
     lambda body: body["resolution"] == "1080p" and body["frame_images"][0]["frame_type"] == "first_frame"
     and "_provider" not in json.dumps(body)),
    ("clients-video", "krea", {"resolution": "fhd"}, {}, "krea",
     KREA + "/generate/video/black-forest-labs/flux-3-video",
     lambda body: body == {"prompt": "p", "duration": 5, "resolution": "1080p", "aspect_ratio": "16:9",
                           "generate_audio": True}),
])
async def test_each_client_runs_end_to_end_through_multi_route(monkeypatch, definition_id, provider, params, wired,
                                                               hosts_for, request_pattern, check):
    definition = DEFINITIONS[definition_id]
    defaults = {p["key"]: p["default"] for group in ("params", "sharedParams") for p in definition[group]}
    defaults.update({p["key"]: p["default"] for r in definition["routes"] for p in r.get("params") or []})
    or_content = "https://openrouter.ai/api/v1/videos/job-1/content?index=0"
    rep_out = "https://replicate.delivery/x/out.mp4"
    hosts = {
        "bfl": lambda: bfl_hosts(monkeypatch),
        "fal": lambda: fal_hosts(monkeypatch, {"images": [{"url": "https://fal.media/x.png"}]}),
        "replicate": lambda: replicate_hosts(monkeypatch, [{"id": "p1", "status": "succeeded", "output": rep_out}],
                                             rep_out, MP4),
        "openrouter-images": lambda: FakeHosts(monkeypatch, [("POST", OR + "images", httpx.Response(200, json={
            "data": [{"b64_json": base64.b64encode(PNG).decode()}]}))]),
        "openrouter-videos": lambda: FakeHosts(monkeypatch, [
            ("POST", OR + "videos", httpx.Response(202, json={"id": "job-1", "status": "pending"})),
            ("GET", OR + "videos/job-1", httpx.Response(200, json={"id": "job-1", "status": "completed",
                                                                   "unsigned_urls": [or_content]})),
            ("GET", re.escape(or_content), httpx.Response(200, content=MP4))]),
        "krea": lambda: krea_hosts(monkeypatch),
    }[hosts_for]()
    graph_node = node(definition_id, **{**defaults, **params, "_provider": provider})
    out = await registry_handler(definition_id)(graph_node, ports(prompt="p", **wired), dict(KEYS))
    assert check(hosts.json("POST", request_pattern))
    port, data_type = route_clients.output_port(definition)
    assert out[port]["type"] == data_type
    # One provider per run: no other provider's host saw a request.
    hosts_seen = {httpx.URL(str(r.url)).host for r in hosts.requests}
    assert not hosts_seen & ({"api.bfl.ai", "queue.fal.run", "api.replicate.com", "openrouter.ai", "api.krea.ai"}
                             - {httpx.URL(request_pattern.replace("\\", "")).host})


# -- From the switcher's click to the client (fixtures/switch_cases.json) --------
# The frontend half (frontend/tests/lib/switchToClient.test.ts) checks that
# each case's click writes `writes`; this half saves those values and checks
# the router sends them to the right client, endpoint and body.

SWITCH_CASES = json.loads((FIXTURES / "switch_cases.json").read_text())["cases"]
SWITCH_HOSTS: dict[str, Callable[[pytest.MonkeyPatch, bool], FakeHosts]] = {
    "bfl": lambda mp, video: bfl_hosts(mp, MP4 if video else PNG),
    "fal": lambda mp, video: fal_hosts(mp, {"video": {"url": "https://fal.media/x.mp4"}} if video
                                       else {"images": [{"url": "https://fal.media/x.png"}]}),
    "replicate": lambda mp, video: replicate_hosts(mp, [{"id": "p1", "status": "succeeded",
                                                  "output": "https://replicate.delivery/x/out.mp4"}],
                                            "https://replicate.delivery/x/out.mp4", MP4),
    "openrouter": lambda mp, video: FakeHosts(mp, [("POST", OR + "images", httpx.Response(200, json={
        "data": [{"b64_json": base64.b64encode(PNG).decode()}]}))]),
    "krea": lambda mp, video: krea_hosts(mp),
}


def switch_node(case: dict[str, Any]) -> GraphNode:
    """The node as the switcher leaves it: defaults, the saved values, then what the click wrote."""
    definition = DEFINITIONS[case["definition"]]
    defaults = {p["key"]: p["default"] for group in ("params", "sharedParams") for p in definition[group]}
    defaults.update({p["key"]: p["default"] for r in definition["routes"] for p in r.get("params") or []})
    return node(case["definition"], **{**defaults, **case["saved"], **case["writes"]})


@pytest.mark.parametrize("case", SWITCH_CASES, ids=[c["name"] for c in SWITCH_CASES])
def test_switch_cases_pick_the_route_the_switcher_shows(case):
    from services import node_route

    definition = DEFINITIONS[case["definition"]]
    graph_node = switch_node(case)
    keys = {key: KEYS[key] for key in case["keys"]}
    routed = node_route.with_wired_blockers(definition, graph_node.params,
                                            {port: 1 for port in case["wired"]})
    picked = node_route.select_route(definition, routed, keys)
    if case["run"]["route"] is None:
        assert picked.kind == node_route.UNSET
        unavailable = node_route.route_unavailable(definition, routed, keys) or {}
        assert list(unavailable.get("alternatives") or []) == case["switcher"]["alternatives"]
        return
    assert picked.route_id == case["run"]["route"]
    # What the click saved, the route takes: no stop after a person's pick.
    assert node_route.route_block(definition, node_route.route_by_id(definition, picked.route_id), routed) is None


@pytest.mark.asyncio
@pytest.mark.parametrize("case", SWITCH_CASES, ids=[c["name"] for c in SWITCH_CASES])
async def test_switch_cases_reach_the_right_client(monkeypatch, case):
    from services import krea_mcp_generation

    run_ = case["run"]
    seen: dict[str, Any] = {}

    async def plan_generate(node, body, model, assets, map_body, validate_, emit, **kwargs):
        seen.update(body=body, endpoint=model["endpoint"])
        return {"status": "completed", "result": {"urls": [KREA_RESULT]}}

    monkeypatch.setattr(krea_mcp_generation, "generate", plan_generate)
    video = route_clients.output_port(DEFINITIONS[case["definition"]])[1] == "Video"
    hosts = (FakeHosts(monkeypatch, []) if run_["route"] is None
             else SWITCH_HOSTS[run_["route"]](monkeypatch, video))
    keys = {key: KEYS[key] for key in case["keys"]}
    handler = registry_handler(case["definition"])
    inputs = ports(prompt="p", **case["wired"])
    if "refused" in run_:
        with pytest.raises(MissingCredentialError, match=re.escape(run_["refused"])):
            await handler(switch_node(case), inputs, keys)
        assert not hosts.requests and not seen
        return
    out = await handler(switch_node(case), inputs, keys)
    port, data_type = route_clients.output_port(DEFINITIONS[case["definition"]])
    assert out[port]["type"] == data_type
    if "plan" in run_:
        assert seen == run_["plan"]
        assert not [r for r in hosts.requests if r.method == "POST"]  # only the result's download
        return
    request = run_["request"]
    body = hosts.json(request["method"], re.escape(request["url"]))
    assert body == request["body"]
    if "schema" in request:
        provider, key = request["schema"]
        validate(SCHEMAS[provider][key], body["input"] if provider == "replicate" else body)
    # One provider per run: every request went to the picked provider's hosts.
    first = httpx.URL(request["url"]).host
    assert {httpx.URL(str(r.url)).host for r in hosts.requests} <= {first, "api.us1.bfl.ai", "delivery-us1.bfl.ai",
                                                                     "replicate.delivery", "gen.krea.ai"}
