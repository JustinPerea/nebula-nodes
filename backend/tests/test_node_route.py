"""Route selection: one rule for the router, pricing, readiness and the cache key.

tests/fixtures/route_cases.json is shared with frontend/tests/lib/directRoute.test.ts,
so the backend and the frontend pick the same route for the same node, params
and keys.
"""
from __future__ import annotations

import json
from pathlib import Path

import pytest

from services import model_pricing, node_route
from services.node_registry import NodeRegistry

CASES = json.loads((Path(__file__).parent / "fixtures" / "route_cases.json").read_text())
DEFINITIONS = NodeRegistry().get_all()


@pytest.mark.parametrize("case", CASES["cases"], ids=[case["name"] for case in CASES["cases"]])
def test_route_matches_shared_cases(case, monkeypatch):
    monkeypatch.setattr(node_route, "_today", lambda: case.get("today", CASES["defaultToday"]))
    definition = DEFINITIONS[case["nodeId"]]
    route = node_route.select_route(definition, case["params"], case["apiKeys"])
    assert route._asdict() == case["expected"]
    # Pricing and the spend gate bill the same provider.
    assert model_pricing.route_provider(definition, case["apiKeys"], case["params"]) == case["expected"]["provider"]
    if "paramKeys" in case:
        assert sorted(node_route.route_param_keys(definition, route.kind)) == case["paramKeys"]


def test_every_dual_route_node_lists_its_maker_key_first_and_splits_params_cleanly():
    for node_id, definition in DEFINITIONS.items():
        direct = node_route.direct_keys(definition)
        if not direct:
            continue
        env = node_route.env_keys(definition)
        assert env[: len(direct)] == direct, node_id
        # Runway resells ElevenLabs' TTS, speech-to-speech and dubbing.
        assert node_route.fallback_provider(definition) in {"fal", "krea", "runway"}, node_id
        if not definition.get("sharedParams"):
            continue
        groups = {name: {p["key"] for p in definition.get(name) or []}
                  for name in ("sharedParams", "falParams", "directParams")}
        assert not groups["sharedParams"] & groups["falParams"], node_id
        assert not groups["sharedParams"] & groups["directParams"], node_id


def test_cache_tag_names_the_route_only_for_multi_route_nodes():
    nano = DEFINITIONS["nano-banana-fal"]
    assert node_route.cache_tag(nano, {}, {"FAL_KEY": "k"}) == "fallback:fal"
    assert node_route.cache_tag(nano, {}, {"FAL_KEY": "k", "GOOGLE_API_KEY": "g"}) == "direct:google"
    krea = DEFINITIONS["krea-image-google-nano-banana-2"]
    assert node_route.cache_tag(krea, {"_kreaAuth": "mcp"}, {"GOOGLE_API_KEY": "g"}) == "plan:krea"
    # Single-route nodes keep the cache keys they had.
    assert node_route.cache_tag(DEFINITIONS["nano-banana"], {}, {"GOOGLE_API_KEY": "g"}) is None
    assert node_route.cache_tag(DEFINITIONS["krea-image-openai-gpt-image-2"], {}, {"KREA_API_TOKEN": "k"}) is None


def test_engine_cache_key_changes_when_a_maker_key_is_added():
    """A fal result must not replay once the run would go to Google."""
    from execution.engine import _cache_route_tag
    from models.graph import GraphNode

    node = GraphNode(id="n", definitionId="nano-banana-fal", params={"model": "nano-banana-2"})
    definition = DEFINITIONS["nano-banana-fal"]
    on_fal = _cache_route_tag(node, definition, {"FAL_KEY": "k"})
    on_google = _cache_route_tag(node, definition, {"FAL_KEY": "k", "GOOGLE_API_KEY": "g"})
    assert on_fal == "fallback:fal" and on_google == "direct:google"
    assert _cache_route_tag(GraphNode(id="t", definitionId="nano-banana", params={}),
                            DEFINITIONS["nano-banana"], {"GOOGLE_API_KEY": "g"}) is None


@pytest.mark.parametrize("keys,route,provider,billed,at_defaults", [
    ({"GOOGLE_API_KEY": "g", "FAL_KEY": "k"}, "direct", "google", "google", 0.067),
    ({"FAL_KEY": "k"}, "fal", "fal", "fal", 0.08),
    # Nothing set: no route yet; the price shown is the node's own (fal) copy.
    ({}, None, None, "fal", 0.08),
])
def test_describe_node_names_the_route_and_its_price(monkeypatch, keys, route, provider, billed, at_defaults):
    from fastapi.testclient import TestClient
    import main

    monkeypatch.setattr(main, "load_settings", lambda: {"apiKeys": keys})
    body = TestClient(main.app).get("/api/agent/nodes/nano-banana-fal").json()
    assert body["route"] == route and body["fallback"] == "fal"
    assert body["routeProvider"] == provider
    assert {p["key"] for p in body["paramsFallback"]} == {"output_format", "seed"}
    assert body["paramsDirect"] == []
    assert "seed" not in {p["key"] for p in body["params"]}
    assert set(body["price"]["routes"]) == {"fal", "google"}
    assert body["price"]["billedBy"] == billed
    assert body["price"]["atDefaultsUsd"] == [at_defaults, at_defaults]


@pytest.mark.asyncio
async def test_engine_reruns_on_google_once_a_maker_key_is_added_and_caches_per_route():
    """End to end through execute_graph: a fal result is cached under its
    route, the same keys hit that cache, and adding GOOGLE_API_KEY misses it
    and runs the Google handler (never a replay of fal's image)."""
    from unittest.mock import AsyncMock
    from uuid import uuid4

    from execution.engine import execute_graph
    from execution.maker_routes import dual_route
    from models.graph import GraphNode
    from services.cache import ExecutionCache
    from services.output import OUTPUT_ROOT

    image = OUTPUT_ROOT / f"{uuid4().hex}.png"
    image.parent.mkdir(parents=True, exist_ok=True)
    image.write_bytes(b"\x89PNG fixture")
    output = {"image": {"type": "Image", "value": str(image)}}
    direct = AsyncMock(return_value=output)
    fallback = AsyncMock(return_value=output)
    registry = {"nano-banana-fal": dual_route(direct=direct, fallback=fallback)}
    cache = ExecutionCache()

    async def emit(_event):
        pass

    async def run(keys):
        node = GraphNode(id="n", definitionId="nano-banana-fal", params={"model": "nano-banana-2"})
        await execute_graph([node], [], keys, registry, emit, cache=cache)

    try:
        await run({"FAL_KEY": "k"})
        await run({"FAL_KEY": "k"})
        assert (fallback.await_count, direct.await_count) == (1, 0)  # the second run hit the cache
        await run({"FAL_KEY": "k", "GOOGLE_API_KEY": "g"})
        assert (fallback.await_count, direct.await_count) == (1, 1)  # a new route misses it
        await run({"FAL_KEY": "k", "GOOGLE_API_KEY": "g"})
        assert direct.await_count == 1
    finally:
        image.unlink(missing_ok=True)
