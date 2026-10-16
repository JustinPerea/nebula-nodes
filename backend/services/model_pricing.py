"""Curated list prices for paid nodes, and the run-cost estimate built on them.

``data/model_pricing.json`` is hand-maintained: every entry names the vendor
page it was read from, a short quote of the price line, and the date it was
checked. Nothing here is fetched or inferred at runtime. A node with no entry,
or whose settings match no row, is *unpriced*: callers must say so rather than
count it as free.

Shape of one entry (keyed by node definition id)::

    {
      "currency": "usd" | "krea_cu",
      "per": "image" | "video" | "second" | "request" | "megapixel-second",
      "priceParams": ["model", "quality"],          # documentation only
      "rows": [{"match": {"quality": "low"}, "price": 0.011},
               {"match": {"quality": "auto"}, "price": [0.011, 0.167]}],
      "extras": [{"match": {"web_search": true}, "price": 0.015}],  # added per unit
      "multiplyBy": ["num_images"],                  # numeric params
      "provider": "google",                          # dual-route nodes: whose price this is
      "plus": "input images",                        # a known cost the vendor doesn't publish
      "defaults": {"duration": 8},                   # what the handler sends when unset
      "unconfirmed": true,                           # the page doesn't state this price exactly
                                                     # (also on one row: that row's price only)
      "notes": "...",
      "sources": [{"url": "https://...", "quote": "..."}],
      "checked": "2026-10-10"
    }

A node that runs on more than one provider (a fal or Krea copy that can also
run on its maker's API, or a route-table node, services/node_route.py) can
price each route instead::

    {
      "routes": {"fal": {...one entry as above...},
                 "google": {...one entry as above...}},
      "generatedBy": "..."                           # optional, as above
    }

Each route is a complete entry, keyed by the provider that bills it (the
``provider`` field inside is implied and, when given, must match). The run is
priced by the route it takes (``route_provider``); a route without an entry is
unpriced. An entry without ``routes`` is a single-route entry, unchanged. A
route-table node keys each route by its ``pricing`` (default its route id),
so two routes on one provider can each have a price (``route_price_key``);
a run that can't start is not priced but ``unavailable``, with the reason.
Price rows always match the node's own params (fal's or Krea's names), since
those are what is saved, whichever route translates them.

Rows are tried in order; the first whose every ``match`` key equals the
node's effective value wins, so list specific rows before general ones. A
price is a number or a ``[low, high]`` range for settings (like ``auto``) that
only resolve at run time.

A priced setting that arrives by wire (an input port with the same id as a
param the entry reads, like Krea Kling 3.0's ``multi_prompt``) is only known
at run time, so a node with one wired is unpriced (``wired``).

Two kinds of price variable aren't saved params, so their names are in
parentheses and can never be a param's key:

- ``(mode)`` (VIDEO_MODE) is a FLUX 3 Video run's mode, read from the wired
  ports: ``v2v`` with ``start_video`` wired, ``i2v`` with ``start_image``,
  ``keyframes`` or ``end_image``, else ``t2v``. It is the rule the route
  clients use to pick BFL's ``mode`` (execution/route_clients.py bfl_body).
- ``(references)`` (REFERENCES) is ``some`` when the reference-image port
  (``images``) has an edge in, else ``none``. Krea 3 prices by it: a run with
  no references costs exactly the base price on Krea and fal, and only a run
  with references wired gets the range up to the most references a route
  takes (their number and size are only known at run time).
- RUN_TIME_VARIABLES depend on the source clip a run is given (its length,
  its frame size), which only exists once the upstream node has run. An entry
  that reads one keeps the provider's real formula, and is unpriced before
  the run: never priced as one unit.

``frontend/src/lib/pricing.ts`` implements the same estimate; both are tested
against ``tests/fixtures/pricing_cases.json`` so they cannot drift.
"""
from __future__ import annotations

import json
import math
import re
from datetime import date
from pathlib import Path
from typing import Any, Iterable, Mapping

from services.retired_nodes import migrate_params

PRICING_PATH = Path(__file__).resolve().parent.parent / "data" / "model_pricing.json"
CURRENCIES = ("usd", "krea_cu")
# megapixel-second: one megapixel of output frame for one second of output
# video (BFL and Replicate price FLUX Video Upscale this way).
PER_UNITS = ("image", "video", "second", "request", "megapixel-second")
# The wired-port price variable (see the module docstring) and its values.
VIDEO_MODE = "(mode)"
VIDEO_MODES = ("t2v", "i2v", "v2v")
_IMAGE_PORTS = ("start_image", "keyframes", "end_image")
REFERENCES = "(references)"
REFERENCE_VALUES = ("none", "some")
_REFERENCE_PORTS = ("images",)
# Price variables known only once the run's source clip is: FLUX Video Edit [fast]
# bills the source's length, Upscale its output frame size too (source size
# times upscale_factor squared), and fal's upscale tiers by that output size.
RUN_TIME_VARIABLES = ("(source seconds)", "(output megapixels)", "(output tier)")
_DATE_RE = re.compile(r"^\d{4}-\d{2}-\d{2}$")


class PricingError(ValueError):
    """The pricing file is malformed or disagrees with the node registry."""


def load_pricing(path: Path | None = None) -> dict[str, Any]:
    with open(path or PRICING_PATH) as handle:
        data = json.load(handle)
    if not isinstance(data, dict) or not isinstance(data.get("nodes"), dict):
        raise PricingError("model_pricing.json must be an object with a 'nodes' object")
    return data


def _price_bounds(price: Any) -> tuple[float, float] | None:
    if isinstance(price, bool):
        return None
    if isinstance(price, (int, float)):
        value = float(price)
        return (value, value) if math.isfinite(value) and value >= 0 else None
    if isinstance(price, list) and len(price) == 2 and all(
        isinstance(v, (int, float)) and not isinstance(v, bool) for v in price
    ):
        low, high = float(price[0]), float(price[1])
        if math.isfinite(low) and math.isfinite(high) and 0 <= low <= high:
            return (low, high)
    return None


def _definition_params(definition: Mapping[str, Any]) -> list[Mapping[str, Any]]:
    from services import node_route

    return node_route.all_param_definitions(definition)


def route_providers(definition: Mapping[str, Any]) -> set[str]:
    """Every provider a run of this node can bill (node_route.routes_of)."""
    from services import node_route

    return {str(route["provider"]) for route in node_route.routes_of(definition) if route.get("provider")}


def route_price_keys(definition: Mapping[str, Any]) -> dict[str, str]:
    """The keys a ``routes`` entry may price, each with the provider that
    bills it: a route-table node's route ``pricing`` (default its id), every
    other node's providers."""
    from services import node_route

    return {str(route.get("pricing") or route.get("id")): str(route.get("provider") or "")
            for route in node_route.routes_of(definition) if route.get("provider")}


def route_price_key(definition: Mapping[str, Any], route: Any) -> str | None:
    """The key under ``routes`` that prices this run's route (a
    node_route.Route): the route's ``pricing`` or id on a route-table node,
    the billed provider on every other node. directRoute.ts routePriceKey is
    the same."""
    from services import node_route

    if not node_route.has_routes(definition):
        return route.provider
    spec = node_route.route_by_id(definition, route.route_id) if route.route_id else None
    return str(spec.get("pricing") or spec.get("id")) if spec else None


def entry_for_route(entry: Mapping[str, Any] | None, provider: str | None) -> Mapping[str, Any] | None:
    """The single-route entry that prices a run billed to ``provider``.

    A ``routes`` entry gives that route's entry (None when the route has no
    price, or when the route isn't known); a plain entry is returned as is,
    and ``estimate_node`` still checks its ``provider``."""
    if not entry:
        return None
    routes = entry.get("routes")
    if routes is None:
        return entry
    if not isinstance(routes, Mapping) or not provider:
        return None
    routed = routes.get(provider)
    return routed if isinstance(routed, Mapping) else None


def validate_pricing(pricing: Mapping[str, Any], definitions: Mapping[str, Mapping[str, Any]]) -> list[str]:
    """Every problem with the file, as readable strings. Empty means valid."""
    from services import node_route

    problems: list[str] = []
    currencies = pricing.get("currencies") or {}
    for node_id, entry in (pricing.get("nodes") or {}).items():
        where = f"{node_id}:"
        definition = definitions.get(node_id)
        if definition is None:
            problems.append(f"{where} no such node definition")
            continue
        if not isinstance(entry, Mapping):
            problems.append(f"{where} entry must be an object")
            continue
        if definition.get("apiProvider") == "utility":
            problems += _utility_entry_problems(where, entry, definition)
        if "routes" in entry:
            routes = entry.get("routes")
            stray = sorted(set(entry) - {"routes", "generatedBy", "notes"})
            if stray:
                problems.append(f"{where} a routes entry keeps its prices inside each route, not {stray}")
            if not isinstance(routes, Mapping) or not routes:
                problems.append(f"{where} routes must be an object with at least one provider")
                continue
            allowed = route_price_keys(definition)
            for provider, routed in routes.items():
                route_where = f"{node_id} ({provider} route):"
                if provider not in allowed:
                    problems.append(f"{route_where} the node can't bill {provider!r}; it bills {sorted(allowed)}")
                if not isinstance(routed, Mapping):
                    problems.append(f"{route_where} entry must be an object")
                    continue
                if "routes" in routed:
                    problems.append(f"{route_where} routes don't nest")
                billed = allowed.get(provider) or provider
                if routed.get("provider") not in (None, billed):
                    problems.append(f"{route_where} provider must be {billed!r} or left out")
                _validate_entry(route_where, routed, definition, currencies, problems, multi_route_ok=True)
                # A price never reads a setting the route hides (paramVisibleWhen).
                problems += node_route.price_row_problems(definition, str(provider), routed.get("rows"),
                                                        routed.get("extras"), routed.get("multiplyBy"))
            continue
        _validate_entry(where, entry, definition, currencies, problems)
    return problems


def _validate_entry(
    where: str, entry: Mapping[str, Any], definition: Mapping[str, Any], currencies: Mapping[str, Any],
    problems: list[str], *, multi_route_ok: bool = False,
) -> None:
    currency = entry.get("currency")
    if currency not in CURRENCIES:
        problems.append(f"{where} currency must be one of {CURRENCIES}")
    elif currency != "usd" and currency not in currencies:
        problems.append(f"{where} currency {currency} is not described under 'currencies'")
    if entry.get("per") not in PER_UNITS:
        problems.append(f"{where} per must be one of {PER_UNITS}")
    checked = entry.get("checked")
    if not isinstance(checked, str) or not _DATE_RE.match(checked):
        problems.append(f"{where} checked must be an ISO date")
    else:
        try:
            date.fromisoformat(checked)
        except ValueError:
            problems.append(f"{where} checked is not a real date")
    if "unconfirmed" in entry and not isinstance(entry.get("unconfirmed"), bool):
        problems.append(f"{where} unconfirmed must be true or false")
    sources = entry.get("sources")
    if not isinstance(sources, list) or not sources:
        problems.append(f"{where} needs at least one source")
    else:
        for source in sources:
            url = source.get("url") if isinstance(source, Mapping) else None
            quote = source.get("quote") if isinstance(source, Mapping) else None
            if not isinstance(url, str) or not url.startswith("https://"):
                problems.append(f"{where} every source needs an https url")
            if not isinstance(quote, str) or not quote.strip():
                problems.append(f"{where} every source needs the quoted price line")

    params = {p.get("key"): p for p in _definition_params(definition)}
    known_keys = set(params) | set((entry.get("defaults") or {}).keys()) | {VIDEO_MODE, REFERENCES, *RUN_TIME_VARIABLES}
    rows = entry.get("rows")
    if not isinstance(rows, list) or not rows:
        problems.append(f"{where} needs at least one row")
        rows = []
    for index, row in enumerate(rows):
        if not isinstance(row, Mapping) or not isinstance(row.get("match", {}), Mapping):
            problems.append(f"{where} row {index} must be an object with a 'match' object")
            continue
        if _price_bounds(row.get("price")) is None:
            problems.append(f"{where} row {index} price must be a non-negative number or [low, high]")
        if "unconfirmed" in row and not isinstance(row.get("unconfirmed"), bool):
            problems.append(f"{where} row {index} unconfirmed must be true or false")
        for key, value in (row.get("match") or {}).items():
            if key not in known_keys:
                problems.append(f"{where} row {index} matches unknown param '{key}'")
                continue
            if key == VIDEO_MODE and value not in VIDEO_MODES:
                problems.append(f"{where} row {index} {VIDEO_MODE} must be one of {VIDEO_MODES}")
            if key == REFERENCES and value not in REFERENCE_VALUES:
                problems.append(f"{where} row {index} {REFERENCES} must be one of {REFERENCE_VALUES}")
            options = (params.get(key) or {}).get("options")
            if isinstance(options, list) and options:
                allowed = {str(o.get("value") if isinstance(o, Mapping) else o) for o in options}
                if str(value) not in allowed:
                    problems.append(f"{where} row {index} value {key}={value!r} is not an option of the node")
    for index, extra in enumerate(entry.get("extras") or []):
        if not isinstance(extra, Mapping) or _price_bounds(extra.get("price")) is None:
            problems.append(f"{where} extra {index} needs a 'match' object and a price")
            continue
        for key in (extra.get("match") or {}):
            if key not in known_keys:
                problems.append(f"{where} extra {index} matches unknown param '{key}'")
    env_keys = definition.get("envKeyName")
    if (not multi_route_ok and isinstance(env_keys, list) and len([k for k in env_keys if k]) > 1
            and not entry.get("provider")):
        problems.append(f"{where} can run on more than one provider, so it must name whose price this is "
                        "(provider) or price each route (routes)")
    elif entry.get("provider") and entry["provider"] not in route_providers(definition):
        problems.append(f"{where} provider {entry['provider']!r} isn't a route this node can bill")
    for key in entry.get("multiplyBy") or []:
        if key not in known_keys:
            problems.append(f"{where} multiplyBy names unknown param '{key}'")


def _utility_entry_problems(where: str, entry: Mapping[str, Any], definition: Mapping[str, Any]) -> list[str]:
    """A local utility node is free, so it has no entry, unless one param
    picks provider work (``providerVia`` kind param). Then every row must
    match that param on a value that calls the provider (QC ``mode: jev``),
    so the local values stay free and the unpriced ones (vision-llm) stay
    unpriced."""
    from services import node_readiness

    via = node_readiness.provider_via(definition)
    if not via or via.get("kind") != "param":
        return [f"{where} local utility nodes are free and must not be priced"]
    param = str(via.get("param") or "")
    free = {str(value) for value in via.get("freeWhen") or []}
    problems = []
    for index, row in enumerate(entry.get("rows") or []):
        match = row.get("match") if isinstance(row, Mapping) else None
        if not isinstance(match, Mapping) or param not in match or _as_match_value(match[param]) in free:
            problems.append(f"{where} row {index} must match a {param} value that calls a provider")
    return problems


def _as_match_value(value: Any) -> str:
    if value is None:
        return ""
    if isinstance(value, bool):
        return "true" if value else "false"
    if isinstance(value, float) and value.is_integer():
        return str(int(value))
    return str(value)


def effective_params(
    entry: Mapping[str, Any], definition: Mapping[str, Any], params: Mapping[str, Any] | None
) -> dict[str, Any]:
    """Node params over the definition's defaults over the entry's handler defaults."""
    merged: dict[str, Any] = dict(entry.get("defaults") or {})
    for param in _definition_params(definition):
        key = param.get("key")
        if key is not None and param.get("default") is not None and key not in merged:
            merged[key] = param["default"]
    for key, value in (params or {}).items():
        if value is not None and value != "":
            merged[key] = value
    return merged


def _matches(values: Mapping[str, Any], match: Mapping[str, Any]) -> bool:
    return all(_as_match_value(values.get(key)) == _as_match_value(want) for key, want in match.items())


def video_mode(wired: Iterable[str]) -> str:
    """A video run's mode from its wired ports (VIDEO_MODE). A source video
    wins, as in the clients, which refuse a video and images together."""
    ports = {str(port) for port in wired}
    if "start_video" in ports:
        return "v2v"
    return "i2v" if ports & set(_IMAGE_PORTS) else "t2v"


def references(wired: Iterable[str]) -> str:
    """Whether a run has reference images wired (REFERENCES)."""
    return "some" if {str(port) for port in wired} & set(_REFERENCE_PORTS) else "none"


def priced_keys(entry: Mapping[str, Any]) -> set[str]:
    """Every setting an entry's price reads: row and extra matches, multiplyBy."""
    keys = {str(key) for row in entry.get("rows") or [] if isinstance(row, Mapping)
            for key in (row.get("match") or {})}
    keys |= {str(key) for extra in entry.get("extras") or [] if isinstance(extra, Mapping)
             for key in (extra.get("match") or {})}
    return keys | {str(key) for key in entry.get("multiplyBy") or []}


# A plain decimal, as both this file and frontend/src/lib/pricing.ts read it,
# so "0x10", "1_000" or non-ASCII digits never price on one side only.
_DECIMAL = re.compile(r"[ \t\n\r]*[+-]?(?:[0-9]+(?:\.[0-9]*)?|\.[0-9]+)(?:[eE][+-]?[0-9]+)?[ \t\n\r]*")


def _multiplier(value: Any) -> float | None:
    """A positive, finite count or duration; None for anything else."""
    if isinstance(value, bool) or not isinstance(value, (int, float, str)):
        return None
    if isinstance(value, str) and not _DECIMAL.fullmatch(value):
        return None
    amount = float(value)
    return amount if math.isfinite(amount) and amount > 0 else None


def _price_values(entry: Mapping[str, Any], definition: Mapping[str, Any], params: Mapping[str, Any] | None,
                  wired: Iterable[str]) -> dict[str, Any]:
    """The values an entry's rows are matched against: the effective params
    plus the price variables read from the wired ports."""
    priced = priced_keys(entry)
    # Price what will run: a retired value is replaced before the run (retired_nodes).
    params = migrate_params(str(definition.get("id") or ""), dict(params or {}))
    values = effective_params(entry, definition, params)
    if VIDEO_MODE in priced:
        values[VIDEO_MODE] = video_mode(wired)
    if REFERENCES in priced:
        values[REFERENCES] = references(wired)
    return values


def estimate_node(
    entry: Mapping[str, Any] | None,
    definition: Mapping[str, Any],
    params: Mapping[str, Any] | None,
    route_provider: str | None = None,
    wired: Iterable[str] = (),
) -> dict[str, Any] | None:
    """{currency, low, high} for one run of this node, or None if unpriced.

    ``route_provider`` is the provider the run will actually bill; when the
    entry names a different one, the run is unpriced. ``wired`` are the
    node's input ports that have an edge into them: a priced setting among
    them is only known at run time (the wire's value replaces the param), so
    the run is unpriced. Not just the rows that name it: a more general row
    or a skipped extra would price it wrong. The wired ports also give the
    VIDEO_MODE and REFERENCES an entry may match, and an entry reading a RUN_TIME_VARIABLES
    quantity is unpriced. A ``routes`` entry prices the route
    ``route_provider`` names, or nothing when it isn't given."""
    routed = entry_for_route(entry, route_provider)
    if not routed:
        return None
    # A route's entry was picked by its key, which validate_pricing ties to
    # the provider that bills it (a route-table node keys by route id).
    if routed is entry and entry.get("provider") and route_provider and entry["provider"] != route_provider:
        return None
    entry = routed
    wired = {str(port) for port in wired}
    priced = priced_keys(entry)
    if priced & wired or priced & set(RUN_TIME_VARIABLES):
        return None
    values = _price_values(entry, definition, params, wired)
    for row in entry.get("rows") or []:
        if _matches(values, row.get("match") or {}):
            bounds = _price_bounds(row.get("price"))
            if bounds is None:
                return None
            low, high = bounds
            for extra in entry.get("extras") or []:
                extra_bounds = _price_bounds(extra.get("price"))
                if extra_bounds and _matches(values, extra.get("match") or {}):
                    low, high = low + extra_bounds[0], high + extra_bounds[1]
            bounds = (low, high)
            factor = 1.0
            for key in entry.get("multiplyBy") or []:
                # Absent (no param, no default) counts once. A value that is
                # there but unreadable leaves the run unpriced, never one unit.
                if key not in values:
                    continue
                amount = _multiplier(values[key])
                if amount is None:
                    return None
                factor *= amount
            result = {"currency": entry["currency"], "low": bounds[0] * factor, "high": bounds[1] * factor}
            if entry.get("plus"):
                result["plus"] = str(entry["plus"])
            return result
    return None


# -- a whole run ---------------------------------------------------------------
# These mirror frontend/src/lib/runScope.ts and lib/directRoute.selectRoute.

from services.node_route import KEY_PROVIDERS as CREDENTIAL_PROVIDERS  # noqa: E402  (kept for callers)

FANOUT_IDS = frozenset({"batch", "iterator-image", "iterator-text"})


def route_provider(
    definition: Mapping[str, Any], api_keys: Mapping[str, Any], params: Mapping[str, Any] | None = None,
) -> str | None:
    """The provider a run of this node bills (services/node_route.py): the
    Krea plan when chosen, else the maker key when it is set, else the first
    other configured key (the fal or Krea copy). With nothing set, the node's
    own apiProvider."""
    from services import node_route

    return node_route.select_route(definition, params, api_keys).provider


def uses_krea_account(definition: Mapping[str, Any], params: Mapping[str, Any]) -> bool:
    """Krea runs billed to a signed-in account's plan rather than per call.
    ``params`` are routed (node_route.with_wired_blockers)."""
    from services import node_route

    return node_route.uses_krea_plan(definition, params)


def _batch_item_count(params: Mapping[str, Any]) -> int:
    text = params.get("items_text") if isinstance(params.get("items_text"), str) else ""
    if params.get("split_mode") == "none":
        return 1 if text else 0
    return sum(1 for line in text.split("\n") if line.strip())


def _batch_cap(params: Mapping[str, Any]) -> int:
    cap = params.get("batch_size_cap")
    return cap if isinstance(cap, int) and not isinstance(cap, bool) and 1 <= cap <= 25 else 10


def run_multipliers(
    nodes: list[Mapping[str, Any]], edges: list[tuple[str, str]]
) -> dict[str, tuple[int, int]]:
    """How many times each node runs, as (low, high). Below a Batch: once per
    item. Below an Iterator: up to its cap, since the array is only known at
    run time. The nearest fan-out above a node decides (the engine rejects
    joins of independent batches and caps nested expansion)."""
    by_id = {str(node["id"]): node for node in nodes}
    parents: dict[str, list[str]] = {}
    for source, target in edges:
        if source in by_id and target in by_id:
            parents.setdefault(target, []).append(source)
    runs: dict[str, tuple[int, int]] = {}
    outs: dict[str, tuple[int, int]] = {}
    visiting: set[str] = set()

    def out(node_id: str) -> tuple[int, int]:
        if node_id in outs:
            return outs[node_id]
        if node_id in visiting:
            return (1, 1)
        visiting.add(node_id)
        result = run(node_id)
        node = by_id[node_id]
        params = node.get("params") or {}
        if node.get("definitionId") == "batch":
            count = _batch_item_count(params)
            result = (count, count)
        elif node.get("definitionId") in FANOUT_IDS:
            result = (1, _batch_cap(params))
        visiting.discard(node_id)
        outs[node_id] = result
        return result

    def run(node_id: str) -> tuple[int, int]:
        if node_id in runs:
            return runs[node_id]
        result = (1, 1)
        for parent in parents.get(node_id, []):
            candidate = out(parent)
            if candidate[1] > result[1] or (candidate[1] == result[1] and candidate[0] < result[0]):
                result = candidate
        runs[node_id] = result
        return result

    for node_id in by_id:
        run(node_id)
    return runs


def wired_ports(
    nodes: list[Mapping[str, Any]], edges: Iterable[tuple[str, str, str | None]]
) -> dict[str, set[str]]:
    """Each run node's input ports with an edge into them, from (source,
    target, target handle) edges. The source needn't be in the run: its
    value still arrives (from outputs it already has)."""
    ids = {str(node["id"]) for node in nodes}
    wired: dict[str, set[str]] = {}
    for _source, target, handle in edges:
        if str(target) in ids and handle:
            wired.setdefault(str(target), set()).add(str(handle))
    return wired


def wired_counts(
    nodes: list[Mapping[str, Any]], edges: Iterable[tuple[str, str, str | None]]
) -> dict[str, dict[str, int]]:
    """wired_ports with how many edges reach each port, which a route-table
    node's ``ports`` rule reads (at most N wired images); the engine's
    preflight counts the same edges. estimate_run takes either shape."""
    ids = {str(node["id"]) for node in nodes}
    wired: dict[str, dict[str, int]] = {}
    for _source, target, handle in edges:
        if str(target) in ids and handle:
            ports = wired.setdefault(str(target), {})
            ports[str(handle)] = ports.get(str(handle), 0) + 1
    return wired


CINEMA_SCENE = "cinema-scene"


def is_local(definition: Mapping[str, Any], params: Mapping[str, Any] | None = None) -> bool:
    """A node that runs here and bills nobody, with these params (default:
    its defaults). ``utility`` alone isn't enough: a ``providerVia`` node
    calls a provider (services/node_readiness.py)."""
    from services import node_readiness

    if definition.get("apiProvider") != "utility":
        return False
    via = node_readiness.provider_via(definition)
    if via is None:
        return True
    return via.get("kind") == "param" and not node_readiness.param_calls_provider(definition, params or {})


def cinema_scene_base(params: Mapping[str, Any]) -> tuple[str, dict[str, Any], int] | None:
    """The paid model a cinema-scene node calls once per shot, the params it
    sends, and how many shots it runs; None when the scene can't be read.

    cinema-scene is a utility node that calls its base image model through
    that model's own handler (handlers/cinema_scene.py), so it is priced as
    that model, once per shot. This uses the handler's own base guard and
    request builder, so the price follows what the handler actually calls."""
    from handlers.cinema_scene import _build_base_node, _guard_base_model

    scene = params.get("scene")
    if not isinstance(scene, dict) or not isinstance(scene.get("base") or {}, dict):
        return None
    base = scene.get("base") or {}
    try:
        model = _guard_base_model(base)
        node, _ = _build_base_node(model, "", [], str(scene.get("aspectRatio") or "16:9"),
                                   dict(base.get("params") or {}), "price")
    except (ValueError, TypeError):
        return None
    shots = sum(1 for shot in scene.get("shots") or [] if isinstance(shot, dict))
    return model, dict(node.params), shots


def estimate_run(
    items: list[Mapping[str, Any]],
    pricing: Mapping[str, Any],
    definitions: Mapping[str, Mapping[str, Any]],
    api_keys: Mapping[str, Any],
    multipliers: Mapping[str, tuple[int, int]] | None = None,
    wired: Mapping[str, Iterable[str] | Mapping[str, int]] | None = None,
) -> dict[str, Any]:
    """USD estimate for a set of nodes, each {id, definitionId, params, name}.

    ``wired`` maps a node id to its input ports that have an edge into them
    (``wired_ports``); a priced setting that arrives by wire leaves the node
    unpriced. A utility node whose ``providerVia`` param picks provider work
    is priced by its own entry's rows for that value (QC Jev mode), and is
    unpriced without one (vision-llm QC).

    ``priced`` maps node id to {low, high, model}, ``model`` being the
    definition billed (a cinema scene's base model); paid nodes without a list
    price go in ``unpriced``, Krea-account runs in ``plan``. ``planRuns`` maps
    each of those to {model, runs}: how many runs it bills to the Krea plan
    (batch runs times a cinema scene's shots). ``low``/``high`` are None when
    nothing is priced. A route-table node whose chosen route (or Auto's)
    can't run is in ``unpriced`` too, and ``unavailable`` maps it to the
    reason (node_route.route_unavailable), never to another route's price."""
    from services import node_route

    nodes_pricing = pricing.get("nodes") or {}
    low = high = 0.0
    priced: dict[str, dict[str, float]] = {}
    unpriced: list[str] = []
    plan: list[str] = []
    plan_runs: dict[str, dict[str, Any]] = {}
    plus: list[str] = []
    unavailable: dict[str, str] = {}
    for item in items:
        node_id = str(item["id"])
        definition = definitions.get(str(item.get("definitionId") or "")) or {}
        params = item.get("params") or {}
        calls = 1
        if definition and str(item.get("definitionId")) == CINEMA_SCENE:
            nested = cinema_scene_base(params)
            if nested is None or not definitions.get(nested[0]):
                unpriced.append(node_id)
                continue
            billed, params, calls = nested
            definition = definitions[billed]
            ports: Iterable[str] | Mapping[str, int] = ()  # the scene's ports aren't its base model's params
        else:
            ports = (wired or {}).get(node_id, ())
        if definition and definition.get("apiProvider") == "utility" and not is_local(definition, params):
            # Priced only by its own rows for the value it runs (QC Jev mode);
            # with none (vision-llm QC) it is unpriced.
            if not nodes_pricing.get(str(definition.get("id") or "")):
                unpriced.append(node_id)
                continue
        elif not definition or definition.get("apiProvider") == "utility":
            continue
        # A Krea-only setting that arrives by wire keeps the run on Krea
        # (node_route.with_wired_blockers), as the router does, and a wired
        # input can block or unblock a route-table node's plan route.
        routed = node_route.with_wired_blockers(definition, params, ports)
        if uses_krea_account(definition, routed):
            plan.append(node_id)
            plan_runs[node_id] = {"model": str(definition.get("id") or item.get("definitionId") or ""),
                                  "runs": (multipliers or {}).get(node_id, (1, 1))[1] * calls}
            continue
        if node_route.has_routes(definition):
            missing = node_route.route_unavailable(definition, routed, api_keys)
            if missing is not None:
                unpriced.append(node_id)
                unavailable[node_id] = missing["message"]
                continue
            price_key = route_price_key(definition, node_route.select_route(definition, routed, api_keys))
        else:
            price_key = route_provider(definition, api_keys, routed)
        estimate = estimate_node(
            nodes_pricing.get(definition.get("id") or item.get("definitionId")),
            definition, params, price_key, ports,
        )
        if estimate is None or estimate["currency"] != "usd":
            unpriced.append(node_id)
            continue
        run_low, run_high = (multipliers or {}).get(node_id, (1, 1))
        line = {"low": estimate["low"] * run_low * calls, "high": estimate["high"] * run_high * calls,
                "model": str(definition.get("id") or item.get("definitionId") or "")}
        priced[node_id] = line
        low += line["low"]
        high += line["high"]
        if estimate.get("plus") and estimate["plus"] not in plus:
            plus.append(estimate["plus"])
    return {
        "currency": "usd",
        "low": round(low, 6) if priced else None,
        "high": round(high, 6) if priced else None,
        "priced": priced,
        "unpriced": unpriced,
        "plan": plan,
        "planRuns": plan_runs,
        "plus": plus,
        "unavailable": unavailable,
    }


def route_price_unconfirmed(entry: Mapping[str, Any] | None, definition: Mapping[str, Any], route_id: str,
                            params: Mapping[str, Any] | None = None, wired: Iterable[str] = ()) -> bool:
    """A route's price that its provider's page doesn't state exactly (its
    entry's ``unconfirmed``, e.g. a higher page price kept when the exact
    one isn't published), or, at these params (the defaults when None), the
    row they price at says so: one fal route can sell some models at a
    stated price and others not (FLUX.2's Flash and Klein). The switcher
    marks it with "*"; pricing.ts routePriceUnconfirmed is the same."""
    from services import node_route

    spec = node_route.route_by_id(definition, route_id)
    if spec is None:
        return False
    routed = entry_for_route(entry, str(spec.get("pricing") or spec.get("id")))
    if not routed:
        return False
    if routed.get("unconfirmed") is True:
        return True
    wired = [str(port) for port in wired]
    values = _price_values(routed, definition, params, wired)
    row = next((row for row in routed.get("rows") or [] if _matches(values, row.get("match") or {})), None)
    return bool(row and row.get("unconfirmed") is True)


def estimate_routes(
    definition: Mapping[str, Any], params: Mapping[str, Any] | None, ports: Iterable[str] | Mapping[str, int] = (),
    pricing: Mapping[str, Any] | None = None,
) -> dict[str, dict[str, Any] | None]:
    """{route id: the estimate on that route, or None} for a route-table
    node: what each row of the provider switcher shows at these params. None
    when the route can't take the run (route_block) or has no list price.
    ``ports`` are the wired input ports (or a port -> count map). Keys don't
    matter here: a row shows its price whether or not its key is set."""
    from services import node_route

    if not node_route.has_routes(definition):
        return {}
    table = pricing if pricing is not None else load_pricing()
    entry = (table.get("nodes") or {}).get(str(definition.get("id") or ""))
    routed = node_route.with_wired_blockers(definition, params, ports)
    wired = list(ports.keys()) if isinstance(ports, Mapping) else list(ports)
    estimates: dict[str, dict[str, Any] | None] = {}
    for route in node_route.routes_of(definition):
        if node_route.route_block(definition, route, routed) is not None:
            estimates[str(route["id"])] = None
            continue
        key = str(route.get("pricing") or route["id"])
        estimates[str(route["id"])] = estimate_node(entry, definition, params, key, wired)
    return estimates
