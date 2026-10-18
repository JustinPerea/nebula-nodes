"""FLUX.2 (PR 4 of the provider-switcher series): ``flux-2-pro`` is a
route-table node, Black Forest Labs' own API first, then the fal route it
always ran on.

Only the transport is mocked: no provider is contacted and nothing is
billed. Each route's cheapest run and each model's default run go through
the registry's multi_route handler, and the one request is checked exactly
and against the provider's schema (fixtures/provider_schemas/). The fal
route is held to what the fal-only handler sent before PR 4, for every
saved param combination (fixtures/flux2_legacy_fal_requests.json).
"""
from __future__ import annotations

import hashlib
import itertools
import json
import re
from pathlib import Path
from typing import Any
from unittest.mock import AsyncMock, MagicMock, patch

import pytest

from execution.missing_credential import MissingCredentialError
from models.graph import GraphNode, PortValueDict
from services import model_pricing, node_route
from services.node_registry import NodeRegistry
from tests.test_route_clients import (  # noqa: F401  (quick is an autouse fixture)
    KEYS, SCHEMAS, FakeHosts, bfl_hosts, node, ports, quick, registry_handler, validate,
)
from tests.test_flux3_nodes import defaults, fal_hosts

FIXTURES = Path(__file__).parent / "fixtures"
REGISTRY = NodeRegistry().get_all()
DEFINITION = REGISTRY["flux-2-pro"]
PRICING = json.loads((Path(__file__).resolve().parents[2] / "backend/data/model_pricing.json").read_text())
LEGACY = json.loads((FIXTURES / "flux2_legacy_fal_requests.json").read_text())
P = "a fox"
BFL_ONLY = {"BFL_API_KEY": "fixture-bfl"}
FAL_ONLY = {"FAL_KEY": "fixture-fal"}


def test_flux2_is_a_sound_route_table_with_a_schema_for_every_endpoint():
    assert node_route.routes_problems(DEFINITION) == []
    assert [route["id"] for route in DEFINITION["routes"]] == ["bfl", "fal"]
    assert DEFINITION["routes"][0]["maker"] is True
    for route in DEFINITION["routes"]:
        for endpoint in [route["endpoint"], *(rule["endpoint"] for rule in route.get("endpointWhen") or [])]:
            assert endpoint.removeprefix("/v1/") in SCHEMAS[route["provider"]], (route["id"], endpoint)


def test_the_hand_written_fal_handler_is_gone():
    """One router picks the provider: the registry's flux-2-pro handler is
    the route-table router, not the fal-only one."""
    from execution.sync_runner import get_handler_registry

    assert getattr(get_handler_registry(emit=AsyncMock())["flux-2-pro"], "multi_route", False) is True


# (route, model, params over the defaults, request url, schema key, body exactly)
DEFAULT_BFL = {"prompt": P, "width": 1024, "height": 768, "output_format": "jpeg", "safety_tolerance": 2}
DEFAULT_FAL = {"prompt": P, "image_size": "landscape_4_3", "output_format": "jpeg", "safety_tolerance": "2",
               "enable_safety_checker": True}
RUNS = [
    ("bfl", "pro", {}, "https://api.bfl.ai/v1/flux-2-pro", "flux-2-pro", DEFAULT_BFL),
    ("bfl", "max", {}, "https://api.bfl.ai/v1/flux-2-max", "flux-2-max", DEFAULT_BFL),
    ("bfl", "flex", {}, "https://api.bfl.ai/v1/flux-2-flex", "flux-2-flex", DEFAULT_BFL),
    ("bfl", "flex", {"num_inference_steps": 30, "guidance_scale": 4.5, "seed": 7, "image_size": "portrait_16_9",
                     "output_format": "png", "safety_tolerance": "5"},
     "https://api.bfl.ai/v1/flux-2-flex", "flux-2-flex",
     {"prompt": P, "width": 576, "height": 1024, "output_format": "png", "safety_tolerance": 5, "seed": 7,
      "steps": 30, "guidance": 4.5}),
    ("bfl", "klein-9b", {}, "https://api.bfl.ai/v1/flux-2-klein-9b", "flux-2-klein-9b", DEFAULT_BFL),
    # The cheapest BFL run ($0.014).
    ("bfl", "klein-4b", {}, "https://api.bfl.ai/v1/flux-2-klein-4b", "flux-2-klein-4b", DEFAULT_BFL),
    ("fal", "pro", {}, "https://queue.fal.run/fal-ai/flux-2-pro", "fal-ai/flux-2-pro", DEFAULT_FAL),
    ("fal", "max", {}, "https://queue.fal.run/fal-ai/flux-2-max", "fal-ai/flux-2-max", DEFAULT_FAL),
    ("fal", "flex", {"num_inference_steps": 28, "guidance_scale": 3.5}, "https://queue.fal.run/fal-ai/flux-2-flex",
     "fal-ai/flux-2-flex", {**DEFAULT_FAL, "num_inference_steps": 28, "guidance_scale": 3.5}),
    ("fal", "klein-9b", {}, "https://queue.fal.run/fal-ai/flux-2/klein/9b", "fal-ai/flux-2/klein/9b",
     {k: v for k, v in DEFAULT_FAL.items() if k != "safety_tolerance"}),
    ("fal", "klein-4b", {"enable_safety_checker": False}, "https://queue.fal.run/fal-ai/flux-2/klein/4b",
     "fal-ai/flux-2/klein/4b",
     {**{k: v for k, v in DEFAULT_FAL.items() if k != "safety_tolerance"}, "enable_safety_checker": False}),
    # The cheapest fal run ($0.005 or less). Flash has no safety_tolerance
    # (Flux2FlashInput), so the route hides Safety there and doesn't send it
    # (PR 5, D3).
    ("fal", "flash", {}, "https://queue.fal.run/fal-ai/flux-2/flash", "fal-ai/flux-2/flash",
     {k: v for k, v in DEFAULT_FAL.items() if k != "safety_tolerance"}),
]
# The one approved change to what the fal route sends against the fal-only
# handler's capture (fixtures/flux2_legacy_fal_requests.json, unchanged):
# Flash no longer gets safety_tolerance, a field its schema doesn't have.
# Justin, 2026-10-16, on the hide-params design: "Yes to all 4" (D3: drop
# Flash's safety_tolerance). Exact: {endpoint: fields}.
APPROVED_LEGACY_DELTA = {"https://queue.fal.run/fal-ai/flux-2/flash": {"safety_tolerance"}}


@pytest.mark.asyncio
@pytest.mark.parametrize("route_id, model, params, url, schema, body", RUNS,
                         ids=[f"{r[0]}-{r[1]}{'-set' if r[2] else ''}" for r in RUNS])
async def test_each_route_and_model_sends_a_body_its_provider_takes(monkeypatch, route_id, model, params, url,
                                                                   schema, body):
    hosts = bfl_hosts(monkeypatch) if route_id == "bfl" else fal_hosts(monkeypatch, video=False)
    saved = {**defaults(DEFINITION), "model": model, **params, "_provider": route_id}
    out = await registry_handler("flux-2-pro")(node("flux-2-pro", **saved), ports(prompt=P), dict(KEYS))
    sent = hosts.json("POST", re.escape(url))
    assert sent == body
    validate(SCHEMAS[route_id][schema], sent)
    assert out["image"]["type"] == "Image"
    assert len([r for r in hosts.requests if r.method == "POST"]) == 1


@pytest.mark.asyncio
async def test_a_node_saved_without_a_size_runs_on_bfl_at_its_default_size(monkeypatch):
    """BFL documents no FLUX.2 default size (width/height "default 0"), so
    the run sends the default the price is read at."""
    hosts = bfl_hosts(monkeypatch)
    await registry_handler("flux-2-pro")(node("flux-2-pro", _provider="bfl"), ports(prompt=P), dict(BFL_ONLY))
    sent = hosts.json("POST", re.escape("https://api.bfl.ai/v1/flux-2-pro"))
    assert sent == {"prompt": P, "width": 1024, "height": 768}
    validate(SCHEMAS["bfl"]["flux-2-pro"], sent)


@pytest.mark.parametrize("preset, size", [
    ("square_hd", (1024, 1024)), ("square", (512, 512)), ("portrait_4_3", (768, 1024)),
    ("portrait_16_9", (576, 1024)), ("landscape_4_3", (1024, 768)), ("landscape_16_9", (1024, 576)),
])
def test_bfl_takes_each_fal_preset_at_fals_documented_size(preset, size):
    """fal.ai/docs/documentation/model-apis/model-arguments (read 2026-10-15)
    gives each preset's pixel size; BFL takes exact width and height."""
    from execution import maker_routes, route_clients

    bfl = node_route.route_by_id(DEFINITION, "bfl")
    translated = maker_routes.translate_params(bfl, {"image_size": preset, "model": "pro"})
    body = route_clients.bfl_body("flux-2-pro", translated, ports(prompt=P))
    assert (body["width"], body["height"]) == size and "model" not in body and "image_size" not in body


# -- saved graphs ---------------------------------------------------------------


@pytest.mark.asyncio
async def test_a_saved_node_keeps_running_on_fal_until_a_bfl_key_is_added(monkeypatch):
    """No _provider is Auto. Without BFL_API_KEY Auto takes fal, as the node
    always ran; once the key is added Auto takes BFL, the maker (route_cases.json
    pins the same in both languages)."""
    saved = {"model": "pro", "image_size": "square_hd", "output_format": "png", "safety_tolerance": "3",
             "enable_safety_checker": True, "seed": 11}
    fal = fal_hosts(monkeypatch, video=False)
    await registry_handler("flux-2-pro")(node("flux-2-pro", **saved), ports(prompt=P), dict(FAL_ONLY))
    assert [str(r.url) for r in fal.requests if r.method == "POST"] == ["https://queue.fal.run/fal-ai/flux-2-pro"]
    assert fal.json("POST", ".*") == {"prompt": P, **{k: v for k, v in saved.items() if k != "model"}}

    bfl = bfl_hosts(monkeypatch)
    await registry_handler("flux-2-pro")(node("flux-2-pro", **saved), ports(prompt=P), {**FAL_ONLY, **BFL_ONLY})
    assert bfl.json("POST", re.escape("https://api.bfl.ai/v1/flux-2-pro")) == {
        "prompt": P, "width": 1024, "height": 1024, "output_format": "png", "safety_tolerance": 3, "seed": 11}


@pytest.mark.asyncio
@pytest.mark.parametrize("saved, why", [
    ({"model": "flash"}, "it doesn't take model flash"),
    # BFL has no safety-checker switch; fal offers one, so a saved "off" stops
    # with a reset (rule H, PR 5) instead of BFL's old rejects rule.
    ({"enable_safety_checker": False},
     "it doesn't offer Safety Checker off. Turn Safety Checker on, or switch provider."),
])
async def test_a_saved_value_bfl_cant_take_stops_before_any_request_and_offers_fal(monkeypatch, saved, why):
    """Auto with both keys lands on BFL; a saved value it can't take stops the
    run (Stop and offer a switch), never a silent move to fal."""
    hosts = FakeHosts(monkeypatch, [])
    keys = {**FAL_ONLY, **BFL_ONLY}
    params = {**defaults(DEFINITION), **saved}
    with pytest.raises(MissingCredentialError, match=re.escape(f"FLUX.2 can't run on Black Forest Labs: {why}")):
        await registry_handler("flux-2-pro")(node("flux-2-pro", **params), ports(prompt=P), keys)
    assert hosts.requests == []
    unavailable = node_route.route_unavailable(DEFINITION, params, keys)
    assert unavailable["routeId"] == "bfl" and unavailable["alternatives"] == ["fal"]


@pytest.mark.asyncio
@pytest.mark.parametrize("saved, why", [
    # fal's Klein endpoints have no safety_tolerance: Safety is hidden there,
    # and a saved non-default value BFL would honor stops with a reset (rule H).
    ({"model": "klein-4b", "safety_tolerance": "4"},
     "it doesn't offer Safety 4 with Model FLUX.2 [klein] 4B. Set Safety back to 2, or switch provider."),
    ({"model": "flex", "num_inference_steps": 1}, "it doesn't take num_inference_steps 1"),
])
async def test_fal_stops_what_its_endpoint_cant_take(monkeypatch, saved, why):
    hosts = FakeHosts(monkeypatch, [])
    params = {**defaults(DEFINITION), **saved, "_provider": "fal"}
    with pytest.raises(MissingCredentialError, match=re.escape(f"can't run on fal.ai: {why}")):
        await registry_handler("flux-2-pro")(node("flux-2-pro", **params), ports(prompt=P), dict(KEYS))
    assert hosts.requests == []


# -- PR 4 review follow-up ---------------------------------------------------------


@pytest.mark.asyncio
@pytest.mark.parametrize("model", ["MAX", "Flash", "flux-2-max", "dev"])
@pytest.mark.parametrize("keys", [FAL_ONLY, {**FAL_ONLY, **BFL_ONLY}], ids=["fal-key", "both-keys"])
async def test_a_model_no_route_lists_stops_unbilled_instead_of_running_pro(monkeypatch, model, keys):
    """A saved ``model`` that isn't one of the enum's lowercase values (the
    CLI or an agent can save one) used to fall through endpointWhen to Pro on
    either route, unpriced. Each route's ``accepts`` lists the models it
    serves, so the run stops before any request and nothing is offered."""
    hosts = FakeHosts(monkeypatch, [])
    params = {**defaults(DEFINITION), "model": model}
    with pytest.raises(MissingCredentialError, match=re.escape(f"it doesn't take model {model}")):
        await registry_handler("flux-2-pro")(node("flux-2-pro", **params), ports(prompt=P), dict(keys))
    assert hosts.requests == []
    unavailable = node_route.route_unavailable(DEFINITION, params, keys)
    assert unavailable["block"] == {"reason": "unsupported", "param": "model", "detail": f"model {model}"}
    assert unavailable["alternatives"] == []
    assert all(node_route.route_block(DEFINITION, route, params) is not None for route in DEFINITION["routes"])


def test_each_route_offers_exactly_the_models_it_accepts():
    for route_id, models in (("bfl", ["pro", "max", "flex", "klein-9b", "klein-4b"]),
                             ("fal", ["pro", "max", "flash", "flex", "klein-9b", "klein-4b"])):
        shown = {p["key"]: p for p in node_route.route_param_definitions(DEFINITION, route_id)}
        assert [o["value"] for o in shown["model"]["options"]] == models
        assert node_route.route_by_id(DEFINITION, route_id)["rules"]["accepts"]["model"] == {"values": models}


def test_steps_and_guidance_show_on_flex_only():
    for key in ("num_inference_steps", "guidance_scale"):
        assert node_route.param_definition(DEFINITION, key)["visibleWhen"] == {"model": ["flex"]}


STALE_FLEX = {"num_inference_steps": 30, "guidance_scale": 4.5}


@pytest.mark.asyncio
@pytest.mark.parametrize("route_id, model, url, body", [
    ("bfl", "pro", "https://api.bfl.ai/v1/flux-2-pro", DEFAULT_BFL),
    ("bfl", "max", "https://api.bfl.ai/v1/flux-2-max", DEFAULT_BFL),
    ("bfl", "klein-4b", "https://api.bfl.ai/v1/flux-2-klein-4b", DEFAULT_BFL),
    ("fal", "pro", "https://queue.fal.run/fal-ai/flux-2-pro", DEFAULT_FAL),
    ("fal", "flash", "https://queue.fal.run/fal-ai/flux-2/flash",
     {k: v for k, v in DEFAULT_FAL.items() if k != "safety_tolerance"}),
    ("fal", "klein-9b", "https://queue.fal.run/fal-ai/flux-2/klein/9b",
     {k: v for k, v in DEFAULT_FAL.items() if k != "safety_tolerance"}),
])
async def test_steps_and_guidance_left_from_flex_are_hidden_and_not_sent(monkeypatch, route_id, model, url, body):
    """Set on Flex, then the model changed: the fields are hidden and change
    nothing, on either route. Before the follow-up they stopped both routes
    with nothing to switch to."""
    params = {**defaults(DEFINITION), "model": model, **STALE_FLEX, "_provider": route_id}
    assert node_route.route_block(DEFINITION, node_route.route_by_id(DEFINITION, route_id), params) is None
    hosts = bfl_hosts(monkeypatch) if route_id == "bfl" else fal_hosts(monkeypatch, video=False)
    await registry_handler("flux-2-pro")(node("flux-2-pro", **params), ports(prompt=P), dict(KEYS))
    assert hosts.json("POST", re.escape(url)) == body


# -- the fal route sends what the fal-only handler sent ---------------------------


def _legacy_space() -> list[dict[str, Any]]:
    """LEGACY["space"]: null is a key left out, "(null)" a saved null."""
    space = LEGACY["space"]
    keys = list(space)
    combos = []
    for values in itertools.product(*(space[key] for key in keys)):
        combos.append({key: (None if value == "(null)" else value)
                       for key, value in zip(keys, values) if value is not None})
    return combos


async def _fal_request(handler: Any, params: dict[str, Any]) -> dict[str, Any]:
    """The one fal request a run makes, recorded the way the legacy capture
    recorded it (fal_universal's httpx client)."""
    submit = MagicMock(status_code=200)
    submit.json.return_value = {"images": [{"url": "https://fal.media/x.png", "content_type": "image/png"}]}
    with patch("handlers.fal_universal.httpx.AsyncClient") as client_cls:
        client = AsyncMock()
        client.post.return_value = submit
        client.__aenter__ = AsyncMock(return_value=client)
        client.__aexit__ = AsyncMock(return_value=False)
        client_cls.return_value = client
        node_ = GraphNode(id="n1", definitionId="flux-2-pro", params=dict(params))
        await handler(node_, {"prompt": PortValueDict(type="Text", value=P)}, dict(FAL_ONLY))
    assert client.post.call_count == 1
    call = client.post.call_args
    return {"params": params, "url": call.args[0], "body": call.kwargs["json"]}


@pytest.mark.asyncio
async def test_the_fal_route_sends_exactly_what_the_fal_only_handler_sent_for_every_saved_combination():
    from execution.sync_runner import get_handler_registry

    handler = get_handler_registry(emit=AsyncMock())["flux-2-pro"]
    rows = [await _fal_request(handler, params) for params in _legacy_space()]
    assert len(rows) == LEGACY["count"]
    # The approved delta, exactly: those fields are never sent there now, and
    # put back as the old handler sent them (the saved value, when set), every
    # row matches the capture byte for byte.
    restored = []
    for row in rows:
        dropped = APPROVED_LEGACY_DELTA.get(row["url"], set())
        assert not dropped & set(row["body"]), row
        body = dict(row["body"])
        for key in dropped:
            if row["params"].get(key) is not None:
                body[key] = row["params"][key]
        restored.append({**row, "body": body})
    by_params = {json.dumps(row["params"], sort_keys=True): row for row in restored}
    for case in LEGACY["cases"]:
        assert by_params[json.dumps(case["params"], sort_keys=True)] == case
    text = json.dumps(restored, sort_keys=True, separators=(",", ":"))
    assert hashlib.sha256(text.encode()).hexdigest() == LEGACY["sha256"]


# -- prices -----------------------------------------------------------------------


@pytest.mark.parametrize("route_id, model, price, unconfirmed", [
    ("bfl", "pro", 0.03, False), ("bfl", "max", 0.07, False), ("bfl", "flex", 0.05, False),
    ("bfl", "klein-9b", 0.015, False), ("bfl", "klein-4b", 0.014, False), ("bfl", "flash", None, False),
    ("fal", "pro", 0.03, False), ("fal", "max", 0.07, False), ("fal", "flex", 0.05, False),
    ("fal", "flash", 0.005, True), ("fal", "klein-9b", 0.011, True), ("fal", "klein-4b", 0.009, True),
])
def test_each_route_prices_each_model_and_marks_what_fal_doesnt_state(route_id, model, price, unconfirmed):
    params = {**defaults(DEFINITION), "model": model}
    shown = model_pricing.estimate_routes(DEFINITION, params, (), PRICING)[route_id]
    assert (None if shown is None else round(shown["low"], 6)) == price
    if shown is not None:
        assert shown["low"] == shown["high"]
    entry = PRICING["nodes"]["flux-2-pro"]
    assert model_pricing.route_price_unconfirmed(entry, DEFINITION, route_id, params) is unconfirmed


def test_flux2_prices_validate():
    assert model_pricing.validate_pricing(PRICING, REGISTRY) == []
    assert set(PRICING["nodes"]["flux-2-pro"]["routes"]) == {"bfl", "fal"}
