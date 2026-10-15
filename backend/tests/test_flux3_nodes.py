"""The real route-table nodes (PR 3 of the provider-switcher series): FLUX 3
Image, Image Klein, Image Klein Base, FLUX 3 Video, FLUX Video Edit, FLUX
Video Upscale and Krea 3.

Each route's cheapest run goes through the registry's multi_route handler,
as a saved node would, with only the transport mocked (test_route_clients
FakeHosts): no provider is contacted and nothing is billed. The one request
it makes is checked exactly and against the provider's own schema
(fixtures/provider_schemas/, or a Krea route's catalog request schema), so a
param a provider doesn't take fails here, not on a billed call.
"""
from __future__ import annotations

import json
import re
from pathlib import Path
from typing import Any

import httpx
import pytest

from execution import route_clients
from services import model_pricing, node_route
from services.node_registry import NodeRegistry
from tests.test_route_clients import (  # noqa: F401  (quick is an autouse fixture)
    FAL, KEYS, KREA, MP4, OR, PNG, REP, SCHEMAS, FakeHosts, bfl_hosts, node, ports, quick, registry_handler,
    replicate_hosts, validate,
)

ROOT = Path(__file__).resolve().parents[2]
REGISTRY = NodeRegistry().get_all()
CATALOG = json.loads((ROOT / "backend/data/krea_gateway_models.json").read_text())["models"]
PRICING = json.loads((ROOT / "backend/data/model_pricing.json").read_text())
NODES = ["flux-3-image", "flux-3-image-klein", "flux-3-image-klein-base", "flux-3-video", "flux-video-edit",
         "flux-video-upscale", "krea-3"]
CLIP = "https://example.com/clip.mp4"
REF = "https://example.com/ref.png"


def defaults(definition: dict[str, Any]) -> dict[str, Any]:
    """Every param's default, as the graph seeds a new node."""
    return {p["key"]: p["default"] for p in node_route.all_param_definitions(definition) if "default" in p}


def fal_hosts(monkeypatch, video: bool) -> FakeHosts:
    queue = "https://queue.fal.run/q/requests/r1"
    result = {"video": {"url": "https://fal.media/x.mp4"}} if video else {
        "images": [{"url": "https://fal.media/x.png", "content_type": "image/png"}]}
    return FakeHosts(monkeypatch, [
        ("POST", FAL + r".*", httpx.Response(200, json={
            "request_id": "r1", "status_url": f"{queue}/status", "response_url": queue, "cancel_url": f"{queue}/cancel"})),
        ("GET", re.escape(f"{queue}/status"), httpx.Response(200, json={"status": "COMPLETED"})),
        ("GET", re.escape(queue), httpx.Response(200, json=result)),
    ])


def krea_hosts(monkeypatch, video: bool) -> FakeHosts:
    out = "https://gen.krea.ai/out/result." + ("mp4" if video else "png")
    return FakeHosts(monkeypatch, [
        ("POST", KREA + r"/generate/.*", httpx.Response(200, json={"job_id": "job1", "status": "queued"})),
        ("GET", KREA + "/jobs/job1", httpx.Response(200, json={"job_id": "job1", "status": "completed",
                                                                 "result": {"urls": [out]}})),
        ("GET", re.escape(out), httpx.Response(200, content=MP4 if video else PNG,
                                               headers={"content-type": "video/mp4" if video else "image/png"})),
    ])


def openrouter_hosts(monkeypatch, video: bool) -> FakeHosts:
    content = "https://openrouter.ai/api/v1/videos/job-1/content?index=0"
    if not video:
        import base64
        return FakeHosts(monkeypatch, [("POST", OR + "images", httpx.Response(200, json={
            "data": [{"b64_json": base64.b64encode(PNG).decode()}]}))])
    return FakeHosts(monkeypatch, [
        ("POST", OR + "videos", httpx.Response(202, json={"id": "job-1", "status": "pending"})),
        ("GET", OR + "videos/job-1", httpx.Response(200, json={"id": "job-1", "status": "completed",
                                                               "unsigned_urls": [content]})),
        ("GET", re.escape(content), httpx.Response(200, content=MP4))])


def hosts_for(monkeypatch, provider: str, video: bool) -> FakeHosts:
    if provider == "bfl":
        return bfl_hosts(monkeypatch, MP4 if video else PNG)
    if provider == "replicate":
        out = "https://replicate.delivery/x/out." + ("mp4" if video else "webp")
        return replicate_hosts(monkeypatch, [{"id": "p1", "status": "succeeded", "output": out}], out,
                               MP4 if video else PNG)
    return {"fal": fal_hosts, "krea": krea_hosts, "openrouter": openrouter_hosts}[provider](monkeypatch, video)


# (node, route, params over the defaults, wired ports (a prompt is, unless
# None), request url, schema (provider, key), the body exactly)
P = "a fox"
CHEAPEST = [
    ("flux-3-image", "bfl", {"resolution": "768sq"}, {}, "https://api.bfl.ai/v1/flux-3-image", ("bfl", "flux-3-image"),
     {"prompt": P, "aspect_ratio": "auto", "resolution": "768sq", "safety_tolerance": 2, "grounding": True}),
    ("flux-3-image", "fal", {"resolution": "768sq"}, {}, "https://queue.fal.run/blackforestlabs/flux-3/text-to-image",
     ("fal", "blackforestlabs/flux-3/text-to-image"),
     {"prompt": P, "aspect_ratio": "auto", "resolution": "768sq", "safety_tolerance": 2,
      "enable_prompt_expansion": False}),
    ("flux-3-image", "fal", {"resolution": "768sq"}, {"images": [REF]},
     "https://queue.fal.run/blackforestlabs/flux-3/edit-image", ("fal", "blackforestlabs/flux-3/edit-image"),
     {"prompt": P, "aspect_ratio": "auto", "resolution": "768sq", "safety_tolerance": 2,
      "enable_prompt_expansion": False, "image_urls": [REF]}),
    ("flux-3-image", "replicate", {"resolution": "768sq"}, {},
     "https://api.replicate.com/v1/models/black-forest-labs/flux-3-image/predictions",
     ("replicate", "black-forest-labs/flux-3-image"),
     {"input": {"prompt": P, "aspect_ratio": "auto", "resolution": "768sq", "safety_tolerance": 2, "grounding": True}}),
    ("flux-3-image", "openrouter", {"resolution": "768sq"}, {}, "https://openrouter.ai/api/v1/images",
     ("openrouter", "images/black-forest-labs/flux-3-image"),
     {"model": "black-forest-labs/flux-3-image", "prompt": P, "aspect_ratio": "auto", "resolution": "768",
      "provider": {"options": {"black-forest-labs": {"safety_tolerance": 2}}}}),
    ("flux-3-image-klein", "bfl", {"resolution": "768sq"}, {}, "https://api.bfl.ai/v1/flux-3-image-klein",
     ("bfl", "flux-3-image-klein"),
     {"prompt": P, "aspect_ratio": "auto", "resolution": "768sq", "safety_tolerance": 2, "steps": 16,
      "output_format": "jpeg"}),
    ("flux-3-image-klein", "openrouter", {"resolution": "768sq"}, {}, "https://openrouter.ai/api/v1/images",
     ("openrouter", "images/black-forest-labs/flux-3-image-klein"),
     {"model": "black-forest-labs/flux-3-image-klein", "prompt": P, "aspect_ratio": "auto", "resolution": "768",
      "provider": {"options": {"black-forest-labs": {"safety_tolerance": 2}}}}),
    ("flux-3-image-klein-base", "fal", {"image_size": "square"}, {},
     "https://queue.fal.run/blackforestlabs/flux-3/klein/base/text-to-image",
     ("fal", "blackforestlabs/flux-3/klein/base/text-to-image"),
     {"prompt": P, "image_size": "square", "output_format": "png", "enable_prompt_expansion": True,
      "enable_safety_checker": True}),
    ("flux-3-image-klein-base", "fal", {}, {"images": [REF]},
     "https://queue.fal.run/blackforestlabs/flux-3/klein/base/edit-image",
     ("fal", "blackforestlabs/flux-3/klein/base/edit-image"),
     {"prompt": P, "image_size": "square_hd", "output_format": "png", "enable_prompt_expansion": True,
      "enable_safety_checker": True, "image_urls": [REF]}),
    ("flux-3-video", "bfl", {"draft": True}, {}, "https://api.bfl.ai/v1/flux-3-video", ("bfl", "flux-3-video"),
     {"mode": "t2v", "prompt": P, "duration": 5, "resolution": "hd", "aspect_ratio": "16:9", "generate_audio": True,
      "draft": True}),
    ("flux-3-video", "fal", {"draft": True}, {}, "https://queue.fal.run/blackforestlabs/flux-3/text-to-video/draft",
     ("fal", "blackforestlabs/flux-3/text-to-video/draft"),
     {"prompt": P, "duration": 5, "aspect_ratio": "16:9", "generate_audio": True}),
    ("flux-3-video", "replicate", {"draft": True}, {},
     "https://api.replicate.com/v1/models/black-forest-labs/flux-3/predictions",
     ("replicate", "black-forest-labs/flux-3"),
     {"input": {"prompt": P, "duration": "5", "resolution": "720p", "aspect_ratio": "16:9", "generate_audio": True,
                "draft": True}}),
    ("flux-3-video", "openrouter", {}, {}, "https://openrouter.ai/api/v1/videos",
     ("openrouter", "videos/black-forest-labs/flux-3-video"),
     {"model": "black-forest-labs/flux-3-video", "prompt": P, "duration": 5, "resolution": "720p",
      "aspect_ratio": "16:9", "generate_audio": True}),
    ("flux-3-video", "krea", {}, {}, "https://api.krea.ai/generate/video/black-forest-labs/flux-3-video",
     ("krea", "krea-video-black-forest-labs-flux-3-video"),
     {"prompt": P, "duration": 5, "resolution": "720p", "aspect_ratio": "16:9", "generate_audio": True}),
    ("flux-video-edit", "bfl", {}, {"start_video": CLIP}, "https://api.bfl.ai/v1/flux-tools/video-edit-v1",
     ("bfl", "flux-tools/video-edit-v1"), {"prompt": P, "video": CLIP}),
    ("flux-video-edit", "fal", {}, {"start_video": CLIP}, "https://queue.fal.run/blackforestlabs/flux-3/edit-video",
     ("fal", "blackforestlabs/flux-3/edit-video"), {"prompt": P, "video_url": CLIP}),
    ("flux-video-edit", "krea", {}, {"start_video": CLIP},
     "https://api.krea.ai/generate/video/black-forest-labs/flux-video-edit",
     ("krea", "krea-video-black-forest-labs-flux-video-edit"), {"prompt": P, "start_video": CLIP}),
    ("flux-video-upscale", "bfl", {"creativity": 0, "upscale_factor": 1.5}, {"video": CLIP, "prompt": None},
     "https://api.bfl.ai/v1/flux-tools/video-upscale-v1", ("bfl", "flux-tools/video-upscale-v1"),
     {"input_video": CLIP, "creativity": 0, "upscale_factor": 1.5}),
    ("flux-video-upscale", "fal", {"creativity": 0, "upscale_factor": 1.5}, {"video": CLIP, "prompt": None},
     "https://queue.fal.run/blackforestlabs/flux-video-upscale", ("fal", "blackforestlabs/flux-video-upscale"),
     {"video_url": CLIP, "creativity": 0, "upscale_factor": 1.5}),
    ("flux-video-upscale", "replicate", {"creativity": 0, "upscale_factor": 1.5}, {"video": CLIP, "prompt": None},
     "https://api.replicate.com/v1/models/black-forest-labs/flux-video-upscale/predictions",
     ("replicate", "black-forest-labs/flux-video-upscale"),
     {"input": {"input_video": CLIP, "creativity": 0, "upscale_factor": 1.5}}),
    ("flux-video-upscale", "krea", {"creativity": 0, "upscale_factor": 1.5}, {"video": CLIP},
     "https://api.krea.ai/generate/enhance/black-forest-labs/flux-video-upscale",
     ("krea", "krea-enhance-black-forest-labs-flux-video-upscale"),
     {"video_url": CLIP, "creativity": "precise", "upscale_factor": 1.5, "prompt": P}),
    ("krea-3", "krea", {}, {}, "https://api.krea.ai/generate/image/krea/krea-3", ("krea", "krea-image-krea-krea-3"),
     {"prompt": P, "thinking_mode": "fast", "resolution": "1K", "regional_edit": False}),
    ("krea-3", "krea", {}, {"images": [REF]}, "https://api.krea.ai/generate/image/krea/krea-3",
     ("krea", "krea-image-krea-krea-3"),
     {"prompt": P, "thinking_mode": "fast", "resolution": "1K", "regional_edit": False, "image_urls": [REF]}),
    ("krea-3", "fal", {}, {}, "https://queue.fal.run/krea/v3/text-to-image", ("fal", "krea/v3/text-to-image"),
     {"prompt": P, "model": "berry", "reasoning_level": "low", "image_size": "auto",
      "output_format": "png"}),
    ("krea-3", "fal", {}, {"images": [REF]}, "https://queue.fal.run/krea/v3/edit", ("fal", "krea/v3/edit"),
     {"prompt": P, "model": "berry", "reasoning_level": "low", "image_size": "auto",
      "output_format": "png", "image_urls": [REF]}),
]


def test_the_real_nodes_are_sound_route_tables_with_a_schema_for_every_endpoint():
    for node_id in NODES:
        definition = REGISTRY[node_id]
        assert node_route.has_routes(definition) and node_route.routes_problems(definition) == [], node_id
        for route in definition["routes"]:
            endpoints = [route["endpoint"], *(rule["endpoint"] for rule in route.get("endpointWhen") or [])]
            for endpoint in endpoints:
                if route["provider"] == "krea":
                    assert [m for m in CATALOG.values() if m["endpoint"] == endpoint], (node_id, endpoint)
                    continue
                folder = {"openrouter": "images/" if route["handler"] == "openrouter-images" else "videos/"}
                key = folder.get(route["provider"], "") + endpoint.removeprefix("/v1/")
                assert key in SCHEMAS[route["provider"]], (node_id, route["id"], key)
    # Every route with a request case here: the cheapest run of each one is pinned.
    covered = {(case[0], case[1]) for case in CHEAPEST}
    assert covered == {(node_id, route["id"]) for node_id in NODES for route in REGISTRY[node_id]["routes"]}


@pytest.mark.asyncio
@pytest.mark.parametrize("node_id, route_id, params, wired, url, schema, body", CHEAPEST,
                         ids=[f"{c[0]}-{c[1]}{'-wired' if c[3] else ''}" for c in CHEAPEST])
async def test_each_routes_cheapest_run_sends_a_body_its_provider_takes(monkeypatch, node_id, route_id, params, wired,
                                                                       url, schema, body):
    definition = REGISTRY[node_id]
    spec = node_route.route_by_id(definition, route_id)
    video = route_clients.output_port(definition)[1] == "Video"
    hosts = hosts_for(monkeypatch, spec["provider"], video)
    saved = {**defaults(definition), **params, "_provider": route_id}
    # A case's wired ports go on top of a wired prompt; None leaves one unwired.
    inputs = {port: value for port, value in {"prompt": P, **wired}.items() if value is not None}
    out = await registry_handler(node_id)(node(node_id, **saved), ports(**inputs), dict(KEYS))
    sent = hosts.json("POST", re.escape(url))
    assert sent == body
    provider, key = schema
    if provider == "krea":
        validate(CATALOG[key]["requestSchema"], sent)
    else:
        validate(SCHEMAS[provider][key], sent["input"] if provider == "replicate" else sent)
    port, data_type = route_clients.output_port(definition)
    assert out[port]["type"] == data_type
    # One provider per run.
    host = httpx.URL(url).host
    assert {httpx.URL(str(r.url)).host for r in hosts.requests if r.method == "POST"} <= {host, "api.replicate.com"}


def test_every_route_is_priced_or_said_to_be_unpriced():
    """Each route has a price entry, except the two Krea routes Krea gives no
    list price (Video Edit and Upscale; the switcher shows '-')."""
    unpriced = {("flux-video-edit", "krea"), ("flux-video-upscale", "krea")}
    for node_id in NODES:
        routes = PRICING["nodes"][node_id]["routes"]
        for route in REGISTRY[node_id]["routes"]:
            assert (route["id"] in routes) != ((node_id, route["id"]) in unpriced), (node_id, route["id"])
    assert model_pricing.validate_pricing(PRICING, REGISTRY) == []


SHIPPED_ROUTE_CASES = json.loads((Path(__file__).parent / "fixtures" / "pricing_cases.json").read_text())[
    "shippedRouteCases"]
SHIPPED_RUN_CASES = json.loads((Path(__file__).parent / "fixtures" / "pricing_cases.json").read_text())[
    "shippedRunCases"]


@pytest.mark.parametrize("case", SHIPPED_RUN_CASES, ids=[c["name"] for c in SHIPPED_RUN_CASES])
def test_a_whole_run_is_priced_on_the_route_it_bills(case):
    """runScope.test.ts runs the same cases (pricing_cases.json shippedRunCases).
    A Krea route's rows don't read _kreaAuth: a plan run goes to the plan
    first, so an API-token run is priced whatever mode is left saved."""
    item = {"id": "n1", "definitionId": case["nodeId"], "params": case["params"], "name": "Node"}
    wired = {"n1": {port: 1 for port in case["wired"]}} if case["wired"] else None
    result = model_pricing.estimate_run([item], PRICING, REGISTRY, case["apiKeys"], None, wired)
    expected = case["expected"]
    if expected["low"] is None:
        assert "n1" not in result["priced"]
    else:
        assert result["priced"]["n1"]["low"] == pytest.approx(expected["low"])
        assert result["priced"]["n1"]["high"] == pytest.approx(expected["high"])
    assert ("n1" in result["unavailable"]) is expected["unavailable"]
    assert ("n1" in result["plan"]) is expected["plan"]


@pytest.mark.parametrize("case", SHIPPED_ROUTE_CASES, ids=[c["name"] for c in SHIPPED_ROUTE_CASES])
def test_each_route_shows_its_own_price(case):
    """pricing.test.ts runs the same cases (pricing_cases.json shippedRouteCases)."""
    shown = model_pricing.estimate_routes(REGISTRY[case["nodeId"]], case["params"], case["wired"], PRICING)
    got = {}
    for route_id, estimate in shown.items():
        if estimate is None:
            got[route_id] = None
        else:
            low, high = round(estimate["low"], 6), round(estimate["high"], 6)
            got[route_id] = low if low == high else [low, high]
    assert got == case["expected"]


def test_unconfirmed_prices_are_marked_on_the_routes_whose_pages_dont_state_them():
    marked = {(node_id, route_id) for node_id in NODES for route_id in PRICING["nodes"][node_id]["routes"]
              if model_pricing.route_price_unconfirmed(PRICING["nodes"][node_id], REGISTRY[node_id], route_id)}
    assert marked == {("flux-3-image", "fal"), ("flux-3-image-klein-base", "fal"), ("flux-3-video", "fal"),
                      ("flux-video-upscale", "fal"), ("flux-video-upscale", "replicate"), ("krea-3", "fal")}
