"""Every route-table node's routes send only what their provider takes.

PR 5 (hide what the provider doesn't offer): a route declares the settings
it doesn't offer (``paramVisibleWhen``), and ``node_route.route_sent_keys``
stops sending them. This test keeps those declarations honest. For every
node with a ``routes`` table, every route, every combination of the values
that control what is shown (a ``visibleWhen`` or ``paramVisibleWhen``
controller, or an ``endpointWhen`` key) and two port fillings (the required
ports only, then every port), it runs the real handler against fake hosts
and checks:

- the request body validates against the provider's pinned schema with
  unknown fields refused (fixtures/provider_schemas/, or the Krea catalog's
  requestSchema), after rename, valueMap and the client step;
- every setting shown with a value is one the route sends (shown keys are a
  subset of ``route_sent_keys``).

Combinations a route stops on before any request (route_block) are skipped,
but every route must run at least once. No real request is made.
"""

from __future__ import annotations

import itertools
import json
import re
from typing import Any

import httpx
import pytest

from execution import route_clients
from services import node_route
from tests.test_flux3_nodes import CATALOG, CLIP, P, REF, REGISTRY, defaults, hosts_for
from tests.test_route_clients import (  # noqa: F401  (quick is an autouse fixture)
    KEYS, SCHEMAS, node, ports, quick, registry_handler, validate,
)

NODES = sorted(node_id for node_id, definition in REGISTRY.items() if node_route.has_routes(definition))
SAMPLE = {"string": "x", "text": "x", "integer": 7, "number": 7}


def _controllers(definition: dict[str, Any], route: dict[str, Any]) -> list[str]:
    """Keys whose value changes what this route shows or calls."""
    found: list[str] = []
    for param in node_route.all_param_definitions(definition):
        found += list((param.get("visibleWhen") or {}).keys())
    for condition in (route.get("paramVisibleWhen") or {}).values():
        if isinstance(condition, dict):
            found += list(condition.keys())
    for option in route.get("endpointWhen") or []:
        found += list((option.get("when") or {}).keys())
    params = {p["key"] for p in node_route.all_param_definitions(definition)}
    return sorted({key for key in found if key in params})


def _values(definition: dict[str, Any], route: dict[str, Any], key: str) -> list[Any]:
    offered = {p["key"]: p for p in node_route.route_param_definitions(definition, route["id"])}
    param = offered.get(key) or node_route.param_definition(definition, key) or {}
    if param.get("options"):
        return [option["value"] for option in param["options"]]
    if param.get("type") == "boolean":
        return [True, False]
    return [param.get("default")]


def _sample(param: dict[str, Any]) -> Any:
    if param.get("options"):
        return param["options"][0]["value"]
    if param.get("type") == "boolean":
        return True
    if "min" in param and param.get("type") in ("integer", "number"):
        return param["min"]
    return SAMPLE.get(param.get("type"))


def _port_value(port: dict[str, Any]) -> Any:
    value = {"Image": REF, "Video": CLIP, "Text": P}.get(port["dataType"])
    return [value] if port.get("multiple") and port["dataType"] != "Text" else value


def _fillings(definition: dict[str, Any]) -> list[dict[str, Any]]:
    inputs = definition.get("inputPorts") or []
    required = {p["id"]: _port_value(p) for p in inputs if p.get("required") or p["id"] == "prompt"}
    every = {p["id"]: _port_value(p) for p in inputs}
    return [required] if every == required else [required, every]


def _schema_for(provider: str, url: str, sent: dict[str, Any]) -> list[dict[str, Any]]:
    parsed = httpx.URL(url)
    if provider == "bfl":
        return [SCHEMAS["bfl"][parsed.path.removeprefix("/v1/")]]
    if provider == "fal":
        return [SCHEMAS["fal"][parsed.path.removeprefix("/")]]
    if provider == "replicate":
        match = re.fullmatch(r"/v1/models/([^/]+/[^/]+)/predictions", parsed.path)
        assert match, url
        return [SCHEMAS["replicate"][match.group(1)]]
    if provider == "openrouter":
        return [SCHEMAS["openrouter"][parsed.path.removeprefix("/api/v1/") + "/" + sent["model"]]]
    return [entry["requestSchema"] for entry in CATALOG.values() if entry["endpoint"] == parsed.path]


def _cases() -> list[tuple[str, str, dict[str, Any], dict[str, Any]]]:
    cases = []
    for node_id in NODES:
        definition = REGISTRY[node_id]
        for route in definition["routes"]:
            offered = node_route.route_param_definitions(definition, route["id"])
            base = {**defaults(definition)}
            # A value for every offered setting that has none, so a hidden one
            # that leaked into the body would show up.
            for param in offered:
                if base.get(param["key"]) is None and _sample(param) is not None:
                    base[param["key"]] = _sample(param)
            keys = _controllers(definition, route)
            for combo in itertools.product(*(_values(definition, route, key) for key in keys)):
                for wired in _fillings(definition):
                    params = {**base, **dict(zip(keys, combo)), "_provider": route["id"]}
                    cases.append((node_id, route["id"], params, wired))
    return cases


CASES = _cases()


def test_every_route_table_node_is_covered():
    assert {"flux-2-pro", "flux-3-video", "krea-3"} <= set(NODES)
    assert len(CASES) < 2000


@pytest.mark.asyncio
@pytest.mark.parametrize("node_id", NODES)
async def test_each_route_sends_only_fields_its_provider_takes(monkeypatch, node_id):
    definition = REGISTRY[node_id]
    video = route_clients.output_port(definition)[1] == "Video"
    ran: dict[str, int] = {route["id"]: 0 for route in definition["routes"]}
    for case_node, route_id, params, wired in CASES:
        if case_node != node_id:
            continue
        route = node_route.route_by_id(definition, route_id)
        routed = node_route.with_wired_blockers(
            definition, params, {port: len(v) if isinstance(v, list) else 1 for port, v in wired.items()})
        if node_route.route_block(definition, route, routed) is not None:
            continue
        hosts = hosts_for(monkeypatch, route["provider"], video)
        await registry_handler(node_id)(node(node_id, **params), ports(**wired), dict(KEYS))
        posts = [r for r in hosts.requests if r.method == "POST" and "/uploads" not in str(r.url)
                 and "/files" not in str(r.url)]
        assert posts, (node_id, route_id, params)
        request = posts[-1] if route["provider"] != "replicate" else posts[0]
        sent = json.loads(request.content)
        schemas = _schema_for(route["provider"], str(request.url), sent)
        assert schemas, (node_id, route_id, str(request.url))
        body = sent["input"] if route["provider"] == "replicate" else sent
        validate(schemas[0], body)
        # Shown with a value implies sent.
        sent_keys = node_route.route_sent_keys(definition, route_id, params)
        values = node_route.effective_values(definition, params)
        route_keys = node_route.route_param_keys(definition, route_id)
        shown = {p["key"] for p in node_route.route_param_definitions(definition, route_id)
                 if node_route.param_shown(p, values, route_keys) and params.get(p["key"]) not in (None, "")}
        assert shown <= sent_keys, (node_id, route_id, sorted(shown - sent_keys))
        ran[route_id] += 1
    assert all(ran.values()), (node_id, ran)
