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
# Inline route-table nodes (definition `routes`): none ship in the registry yet.
FIXTURE_DEFINITIONS = CASES["definitions"]


def _definition(node_id):
    return FIXTURE_DEFINITIONS.get(node_id) or DEFINITIONS[node_id]


def _as_case(route):
    """A Route as route_cases.json spells it (block as its set fields)."""
    return {"kind": route.kind, "provider": route.provider, "key": route.key, "routeId": route.route_id,
            "block": node_route.block_dict(route.block), "missing": list(route.missing)}


@pytest.mark.parametrize("case", CASES["cases"], ids=[case["name"] for case in CASES["cases"]])
def test_route_matches_shared_cases(case, monkeypatch):
    monkeypatch.setattr(node_route, "_today", lambda: case.get("today", CASES["defaultToday"]))
    definition = _definition(case["nodeId"])
    params = node_route.with_wired_blockers(definition, case["params"],
                                            case.get("wiredCounts") or case.get("wired", ()))
    route = node_route.select_route(definition, params, case["apiKeys"])
    if node_route.has_routes(definition):
        assert _as_case(route) == case["expected"]
        assert node_route.route_unavailable(definition, params, case["apiKeys"]) == case["unavailable"]
        # Plan billing (the preflight's sign-in check, the estimate's plan
        # runs) reads the same routed values the router does.
        assert node_route.uses_krea_plan(definition, params) == (route.kind == node_route.PLAN)
    else:
        assert {k: route._asdict()[k] for k in ("kind", "provider", "key")} == case["expected"]
        # A node without routes never names a route id, so its Route equals
        # the three-field one it always was.
        assert route == node_route.Route(route.kind, route.provider, route.key)
    # Pricing and the spend gate bill the same provider.
    assert model_pricing.route_provider(definition, case["apiKeys"], params) == case["expected"]["provider"]
    if "block" in case:
        block = node_route.direct_block(definition, params)
        got = None if block is None else {k: v for k, v in block._asdict().items() if v is not None}
        assert got == case["block"]
    if "paramKeys" in case:
        assert sorted(node_route.route_param_keys(definition, route.route_id or route.kind)) == case["paramKeys"]


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


def test_no_direct_route_rule_blocks_a_new_nodes_defaults(monkeypatch):
    """A rule that refused a param's default would send every new node to the
    copy. Only REQUIRES may (the direct route needs an opt-in param), and a
    rule's params must be ones the node has."""
    monkeypatch.setattr(node_route, "_today", lambda: CASES["defaultToday"])
    checked = 0
    for node_id, definition in DEFINITIONS.items():
        if not node_route.direct_keys(definition):
            continue
        block = node_route.direct_block(definition, {})
        assert block is None or block.reason == node_route.REQUIRES, (node_id, block)
        spec = definition.get("directRoute") or {}
        named = set(spec.get("blockedBy") or []) | set(spec.get("accepts") or {}) | set(spec.get("rejects") or {})
        named |= {key for rule in spec.get("rejectsWhen") or [] for key in rule["match"]}
        keys = {p["key"] for group in ("params", "sharedParams", "falParams", "directParams")
                for p in definition.get(group) or []} | {port["id"] for port in definition.get("inputPorts") or []}
        assert named <= keys, (node_id, named - keys)
        checked += 1
    assert checked > 40


def test_cache_tag_names_the_route_only_for_multi_route_nodes():
    nano = DEFINITIONS["nano-banana-fal"]
    assert node_route.cache_tag(nano, {}, {"FAL_KEY": "k"}) == "fallback:fal"
    assert node_route.cache_tag(nano, {}, {"FAL_KEY": "k", "GOOGLE_API_KEY": "g"}) == "direct:google"
    krea = DEFINITIONS["krea-image-google-nano-banana-2"]
    assert node_route.cache_tag(krea, {"_kreaAuth": "mcp"}, {"GOOGLE_API_KEY": "g"}) == "plan:krea"
    # Single-route nodes keep the cache keys they had.
    assert node_route.cache_tag(DEFINITIONS["nano-banana"], {}, {"GOOGLE_API_KEY": "g"}) is None
    assert node_route.cache_tag(DEFINITIONS["krea-image-openai-gpt-image"], {}, {"KREA_API_TOKEN": "k"}) is None


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


# -- route-table nodes ----------------------------------------------------------


@pytest.mark.parametrize("node_id", sorted(FIXTURE_DEFINITIONS))
def test_fixture_route_tables_follow_the_routes_contract(node_id):
    """The rules test_node_contracts.py and scripts/check-node-contracts.mjs
    hold every route-table node to: envKeyName is the ordered union of the
    routes' keys, the maker is routes[0], ids are unique, no param is both
    shared and a route's own, and _provider sits only in `params`."""
    assert node_route.routes_problems(FIXTURE_DEFINITIONS[node_id]) == []


def test_routes_problems_names_each_broken_rule():
    good = FIXTURE_DEFINITIONS["routes-image"]
    broken = json.loads(json.dumps(good))
    broken["envKeyName"] = ["FAL_KEY", "BFL_API_KEY"]
    broken["routes"][1]["maker"] = True
    broken["routes"][2]["id"] = "fal"
    broken["routes"][3]["params"] = [{"key": "resolution", "label": "R", "type": "string", "required": False}]
    broken["routes"][4]["params"] = [{"key": "_provider", "label": "P", "type": "string", "required": False}]
    broken["falParams"] = []
    problems = "\n".join(node_route.routes_problems(broken))
    for expected in ("envKeyName must be", "only routes[0] may be the maker", "duplicate route id fal",
                     "resolution is both shared", "_provider must sit in params", "falParams can't sit next to routes"):
        assert expected in problems, (expected, problems)


@pytest.mark.parametrize("node_id", sorted(FIXTURE_DEFINITIONS))
def test_every_route_takes_every_default(node_id, monkeypatch):
    """A switch is always one click from runnable: no route's rules refuse
    the node's defaults (an empty recipe, or one holding every default)."""
    monkeypatch.setattr(node_route, "_today", lambda: CASES["defaultToday"])
    definition = FIXTURE_DEFINITIONS[node_id]
    defaults = {p["key"]: p["default"] for p in node_route.all_param_definitions(definition) if "default" in p}
    for route in node_route.routes_of(definition):
        assert node_route.route_block(definition, route, {}) is None, (node_id, route["id"])
        assert node_route.route_block(definition, route, defaults) is None, (node_id, route["id"])


def test_a_legacy_maker_route_blocks_exactly_as_direct_block(monkeypatch):
    """routes_of's computed maker route carries directRoute's rules plus
    DIRECT_REQUIRES / DIRECT_RETIRES, so route_block on it is direct_block for
    every shared case; copy routes have no rules."""
    for case in CASES["cases"]:
        definition = _definition(case["nodeId"])
        if node_route.has_routes(definition) or not node_route.direct_keys(definition):
            continue
        monkeypatch.setattr(node_route, "_today", lambda case=case: case.get("today", CASES["defaultToday"]))
        params = node_route.with_wired_blockers(definition, case["params"], case.get("wired", ()))
        maker, *copies = node_route.routes_of(definition)
        assert maker.get("maker") and maker["keys"] == node_route.direct_keys(definition)
        assert node_route.route_block(definition, maker, params) == node_route.direct_block(definition, params), case["name"]
        assert all(node_route.route_block(definition, route, params) is None for route in copies)


def test_routes_of_lists_every_provider_a_legacy_node_bills_in_key_order():
    for node_id, definition in DEFINITIONS.items():
        routes = node_route.routes_of(definition)
        assert [key for route in routes for key in route["keys"]] == (
            node_route.direct_keys(definition) + node_route.fallback_keys(definition)
            if node_route.is_multi_route(definition) else node_route.env_keys(definition)), node_id
        assert len({route["id"] for route in routes}) == len(routes), node_id
        if not node_route.is_multi_route(definition):
            assert [route["provider"] for route in routes] == [definition["apiProvider"]], node_id


def test_cache_tags_of_every_node_without_routes_keep_their_old_spelling():
    """"kind:provider" for multi-route nodes, None for the rest, whatever
    stray _provider a recipe carries: the cache keys saved before route
    tables existed still hit."""
    key_sets = [{}, {"FAL_KEY": "k"}, {"KREA_API_TOKEN": "k"},
                {key: "k" for key in node_route.KEY_PROVIDERS}]
    for node_id, definition in DEFINITIONS.items():
        for keys in key_sets:
            for params in ({}, {"_kreaAuth": "mcp"}, {"_provider": "fal"}):
                route = node_route.select_route(definition, params, keys)
                expected = f"{route.kind}:{route.provider or ''}" if node_route.is_multi_route(definition) else None
                assert node_route.cache_tag(definition, params, keys) == expected, (node_id, keys, params)
                assert route.route_id is None and route.block is None and route.missing == ()


def test_cache_tag_names_the_route_id_on_a_route_table_node():
    image = FIXTURE_DEFINITIONS["routes-image"]
    keys = {"BFL_API_KEY": "b", "FAL_KEY": "f"}
    assert node_route.cache_tag(image, {}, keys) == "direct:bfl"
    assert node_route.cache_tag(image, {"_provider": "fal"}, keys) == "fallback:fal"
    assert node_route.cache_tag(image, {"_provider": "krea", "_kreaAuth": "mcp"}, keys) == "plan:krea"
    assert node_route.cache_tag(image, {"_provider": "replicate"}, keys) == "unset:replicate"
    video = FIXTURE_DEFINITIONS["routes-video"]
    assert node_route.cache_tag(video, {"_provider": "krea-plan"}, {}) == "plan:krea-plan"
    # The engine's cache key reads the same wired counts as the router.
    from execution.engine import _cache_route_tag
    from models.graph import GraphNode, PortValueDict

    node = GraphNode(id="n", definitionId="routes-video", params={})
    wired = {"keyframes": PortValueDict(type="Image", value=["a.png", "b.png"])}
    assert _cache_route_tag(node, video, {"OPENROUTER_API_KEY": "o"}) == "fallback:openrouter"
    assert _cache_route_tag(node, video, {"OPENROUTER_API_KEY": "o"}, wired) == "unset:openrouter"
    # One input carrying a list counts its items, as the router counts them.
    five = {"images": PortValueDict(type="Image", value=[f"{i}.png" for i in range(5)])}
    on_openrouter = GraphNode(id="n", definitionId="routes-image", params={"_provider": "openrouter"})
    assert _cache_route_tag(on_openrouter, image, {"OPENROUTER_API_KEY": "o"}, five) == "unset:openrouter"


def test_filled_counts_counts_list_items():
    from models.graph import PortValueDict

    inputs = {"keyframes": PortValueDict(type="Image", value=["a", "b", "c"]),
              "prompt": PortValueDict(type="Text", value="p"), "empty": PortValueDict(type="Image", value=[])}
    assert node_route.filled_counts(inputs) == {"keyframes": 3, "prompt": 1}
    assert node_route.filled_ports(inputs) == {"keyframes", "prompt"}


def test_ports_counts_only_reach_route_table_nodes():
    """A node without routes gets the params it always got."""
    nano = DEFINITIONS["nano-banana-fal"]
    assert node_route.with_wired_blockers(nano, {"a": 1}, {"image_urls": 3}) == {"a": 1}
    video = FIXTURE_DEFINITIONS["routes-video"]
    routed = node_route.with_wired_blockers(video, {}, {"keyframes": 2, "prompt": 1})
    assert routed == {node_route.PORT_COUNTS: {"keyframes": 2}}
    assert node_route.with_wired_blockers(video, {}, ["keyframes"]) == {node_route.PORT_COUNTS: {"keyframes": 1}}


def test_route_endpoint_follows_endpoint_when():
    image = FIXTURE_DEFINITIONS["routes-image"]
    fal = node_route.route_by_id(image, "fal")
    assert node_route.route_endpoint(image, fal, {}) == "blackforestlabs/flux-3/text-to-image"
    wired = node_route.with_wired_blockers(image, {}, ["images"])
    assert node_route.route_endpoint(image, fal, wired) == "blackforestlabs/flux-3/edit-image"
    assert node_route.route_endpoint(image, node_route.route_by_id(image, "bfl"), wired) == "/v1/flux-3-image"


def test_the_krea_plan_follows_the_route_rule_on_route_table_nodes():
    """uses_krea_plan, krea_auth_param and krea_account agree with
    select_route: the plan on a BFL-maker node only through its Krea row."""
    from models.graph import GraphNode
    from services import krea_account

    image = FIXTURE_DEFINITIONS["routes-image"]
    assert node_route.krea_auth_param(image)["key"] == "_kreaAuth"
    assert krea_account.account_param(image)["key"] == "_kreaAuth"
    assert not krea_account.is_account_only(image)
    assert not node_route.uses_krea_plan(image, {"_kreaAuth": "mcp"})
    assert node_route.uses_krea_plan(image, {"_kreaAuth": "mcp", "_provider": "krea"})
    assert not node_route.uses_krea_plan(image, {"_kreaAuth": "mcp", "_provider": "krea", "resolution": "4k"})
    node = GraphNode(id="n", definitionId="routes-image", params={"_kreaAuth": "mcp", "_provider": "krea"})
    assert krea_account.uses_account(node, image)
    assert node_route.uses_krea_plan(FIXTURE_DEFINITIONS["routes-krea"], {"_kreaAuth": "mcp"})
    assert node_route.uses_krea_plan(FIXTURE_DEFINITIONS["routes-video"], {"_provider": "krea-plan"})
    # A route-table node without a plan route offers no Krea billing choice.
    plain = {**image, "routes": [r for r in image["routes"] if not r.get("plan")]}
    assert node_route.krea_auth_param(plain) is None


# -- one param list -------------------------------------------------------------

# Every hand-written group order all_param_definitions replaced, and the
# nodes each one serves (None: every node). A site that left groups out
# only ever reads nodes where those groups add nothing.
_LEGACY_ORDERS = {
    "node_route._effective / maker_sizes._effective / maker_routes_elevenlabs._default":
        (("sharedParams", "directParams", "falParams", "params"), None),
    "node_readiness._param_default / model_pricing._definition_params / main._valid_param_keys":
        (("params", "sharedParams", "directParams", "falParams"), None),
    "main._coerce_params (last one wins)": (("params", "sharedParams", "falParams", "directParams"), None),
    "maker_routes_byteplus_seedance._options / _value":
        (("sharedParams", "falParams", "directParams", "params"), "BYTEPLUS_API_KEY"),
    "maker_routes_xai._effective": (("sharedParams", "falParams", "params"), "XAI_API_KEY"),
}


def _legacy_lookup(definition, order, last_wins=False):
    found = {}
    for group in order:
        for param in definition.get(group) or []:
            if last_wins or param["key"] not in found:
                found[param["key"]] = param
    return found


@pytest.mark.parametrize("site", sorted(_LEGACY_ORDERS))
def test_all_param_definitions_matches_every_list_it_replaced(site):
    order, maker_key = _LEGACY_ORDERS[site]
    checked = 0
    for node_id, definition in DEFINITIONS.items():
        if maker_key and maker_key not in node_route.direct_keys(definition):
            continue
        new = {p["key"]: p for p in node_route.all_param_definitions(definition)}
        old = _legacy_lookup(definition, order, last_wins="last one wins" in site)
        if "last one wins" in site:
            # _coerce_params keeps (type, required): the one place the
            # winner differs (Ideogram's rendering_speed) has equal ones.
            assert {k: (p.get("type"), bool(p.get("required"))) for k, p in old.items()} == {
                k: (p.get("type"), bool(p.get("required"))) for k, p in new.items()}, node_id
        else:
            assert old == new, (site, node_id, set(old) ^ set(new))
        checked += 1
    assert checked > (5 if maker_key else 300)


def test_all_param_definitions_keeps_the_graph_defaults_and_create_lists():
    """graphStore.buildDefaultParams / defHasParam and main's veo-3 seeding
    read sharedParams + falParams + directParams when there are shared
    params (else `params`), the last one winning: the same keys and defaults."""
    for node_id, definition in DEFINITIONS.items():
        sources = ([*definition["sharedParams"], *(definition.get("falParams") or []),
                    *(definition.get("directParams") or [])] if "sharedParams" in definition
                   else definition.get("params") or [])
        old = {p["key"]: p.get("default") for p in sources if "default" in p}
        new = {p["key"]: p.get("default") for p in node_route.all_param_definitions(definition) if "default" in p}
        assert old == new, node_id


def test_all_param_definitions_adds_each_routes_params_once():
    image = FIXTURE_DEFINITIONS["routes-image"]
    keys = [p["key"] for p in node_route.all_param_definitions(image)]
    assert keys == ["_provider", "_kreaAuth", "aspect_ratio", "resolution", "safety_tolerance", "grounding"]


def test_route_tables_snapshot_is_current():
    """frontend/tests/lib/routeTables.test.ts deep-equals directRoute.ts
    routesOf against this snapshot; regenerate it when routes_of, the
    registry or the inline route-table nodes change."""
    import importlib.util

    root = Path(__file__).resolve().parents[2]
    spec = importlib.util.spec_from_file_location("generate_route_tables", root / "scripts" / "generate-route-tables.py")
    module = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(module)
    assert (Path(__file__).parent / "fixtures" / "route_tables.json").read_text() == module.build(), (
        "run scripts/generate-route-tables.py")
