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
      "whitespaceUnset": ["moodboard_id"],           # params the handler strips: a value of
                                                     # only whitespace sends nothing, so it
                                                     # prices as unset
      "unconfirmed": true,                           # the page doesn't state this price exactly
                                                     # (also on one row: that row's price only)
      "sizing": {"port": "image", "output": "upscale",   # measured quantities, see below
                 "megapixel": 1000000, "roundUp": ["(larger megapixels)"],
                 "say": "$0.001 per megapixel of ..."},
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
- ``(wired PORT)`` (WIRED_PREFIX) is ``yes`` when input port PORT has an
  edge in, else ``no``. Krea 2 prices by billing tier (text to image, style
  references, moodboard), and the tier's inputs can arrive by wire or be
  typed in the param of the same id. A row that reads param X and also
  ``(wired X)`` stays priced with X wired: the wire is accounted for (the
  wired-port rule above skips X when every row and extra naming X names
  ``(wired X)`` too).
- RUN_TIME_VARIABLES depend on the input a run is given (an image's size, a
  clip's length and frame size), which only exists once that file does. An
  entry that reads one keeps the provider's real formula. The ones in
  SIZED_VARIABLES are measured from the input file when the run is checked
  (``size``, services/input_sizes.py), for an entry with ``sizing``:

  - ``port``: the input port whose file is measured.
  - ``output``: how the output frame follows from the input and the params.
    Left out, the output is the input's size. ``upscale``: ``upscale_mode``
    factor (the default) multiplies both sides by ``upscale_factor``;
    target sets one side to ``target_resolution`` (720p, 1080p...) and,
    since the vendors don't say which, both ways are computed (short side =
    target, long side = target) and the larger counts.
  - ``megapixel``: pixels per megapixel, 1,000,000 unless the vendor says
    otherwise (BFL: 1,048,576). Where the vendor doesn't say, 1,000,000 is
    the side that costs more.
  - ``roundUp``: quantities rounded up to a whole number, as Nebula's
    conservative reading where the vendor doesn't say how it rounds.
  - ``say``: one line for agents, "$0.001 per megapixel of ...".

  The quantities: ``(input megapixels)``, ``(output megapixels)`` (one
  frame), ``(larger megapixels)`` (the larger of the two), ``(source
  seconds)`` and ``(source frames)`` (the clip's). Without a size, or with
  one that lacks what the entry reads, the node is unpriced (``awaiting
  input`` in estimate_run). ``(output tier)`` is never measured: fal doesn't
  say where its tiers split, so an entry reading it stays unpriced.

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
# megapixel: one megapixel of image (SeedVR2); megapixel-frame: one megapixel
# of one output video frame (SeedVR2 Video).
PER_UNITS = ("image", "video", "second", "request", "megapixel-second", "megapixel", "megapixel-frame")
# The wired-port price variable (see the module docstring) and its values.
VIDEO_MODE = "(mode)"
VIDEO_MODES = ("t2v", "i2v", "v2v")
_IMAGE_PORTS = ("start_image", "keyframes", "end_image")
REFERENCES = "(references)"
REFERENCE_VALUES = ("none", "some")
_REFERENCE_PORTS = ("images",)
# (wired PORT): whether that input port has an edge in.
WIRED_PREFIX = "(wired "
WIRED_VALUES = ("yes", "no")
# Price variables known only once the run's source clip is: FLUX Video Edit [fast]
# bills the source's length, Upscale its output frame size too (source size
# times upscale_factor squared), and fal's upscale tiers by that output size.
SIZED_VARIABLES = ("(input megapixels)", "(output megapixels)", "(larger megapixels)", "(source seconds)",
                   "(source frames)")
RUN_TIME_VARIABLES = (*SIZED_VARIABLES, "(output tier)")
SIZING_OUTPUTS = ("upscale",)
DEFAULT_MEGAPIXEL = 1_000_000
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
    blank = entry.get("whitespaceUnset")
    if blank is not None and (not isinstance(blank, list)
                              or not all(isinstance(key, str) for key in blank)):
        problems.append(f"{where} whitespaceUnset must be a list of param keys")
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
    ports = {str(port.get("id")) for port in definition.get("inputPorts") or [] if isinstance(port, Mapping)}
    known_keys = (set(params) | set((entry.get("defaults") or {}).keys()) | {VIDEO_MODE, REFERENCES, *RUN_TIME_VARIABLES}
                  | {wired_key(port) for port in ports})
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
            if wired_port(key) is not None and value not in WIRED_VALUES:
                problems.append(f"{where} row {index} {key} must be one of {WIRED_VALUES}")
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
    for key in blank if isinstance(blank, list) else []:
        if key not in params:
            problems.append(f"{where} whitespaceUnset names unknown param '{key}'")
    problems += _sizing_problems(where, entry, definition, ports)


def _sizing_problems(where: str, entry: Mapping[str, Any], definition: Mapping[str, Any],
                     ports: set[str]) -> list[str]:
    sizing = entry.get("sizing")
    measured = priced_keys(entry) & set(SIZED_VARIABLES)
    never = priced_keys(entry) & (set(RUN_TIME_VARIABLES) - set(SIZED_VARIABLES))
    if sizing is None:
        # An entry that also reads a quantity Nebula can't measure stays unpriced anyway.
        return [f"{where} reads {sorted(measured)}, so it needs sizing (the input port they are measured from)"] \
            if measured and not never else []
    if not isinstance(sizing, Mapping):
        return [f"{where} sizing must be an object"]
    problems = []
    if sizing.get("port") not in ports:
        problems.append(f"{where} sizing.port must be one of the node's input ports {sorted(ports)}")
    if sizing.get("output") is not None and sizing.get("output") not in SIZING_OUTPUTS:
        problems.append(f"{where} sizing.output must be one of {SIZING_OUTPUTS} or left out")
    megapixel = sizing.get("megapixel", DEFAULT_MEGAPIXEL)
    if isinstance(megapixel, bool) or not isinstance(megapixel, int) or megapixel <= 0:
        problems.append(f"{where} sizing.megapixel must be a whole number of pixels")
    rounded = sizing.get("roundUp", [])
    if not isinstance(rounded, list) or any(key not in SIZED_VARIABLES for key in rounded):
        problems.append(f"{where} sizing.roundUp must list quantities from {SIZED_VARIABLES}")
    if not isinstance(sizing.get("say"), str) or not sizing["say"].strip():
        problems.append(f"{where} sizing.say must say the price in one line")
    if not measured:
        problems.append(f"{where} has sizing but reads none of {SIZED_VARIABLES}")
    return problems


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


def wired_key(port: str) -> str:
    """The price variable for whether ``port`` has an edge in."""
    return f"{WIRED_PREFIX}{port})"


def wired_port(key: Any) -> str | None:
    """The port a ``(wired PORT)`` price variable reads, else None."""
    text = str(key)
    return text[len(WIRED_PREFIX):-1] if text.startswith(WIRED_PREFIX) and text.endswith(")") else None


def wire_aware_keys(entry: Mapping[str, Any]) -> set[str]:
    """Params the entry reads only alongside ``(wired X)`` for the port of the
    same id: every row and extra that matches X also matches ``(wired X)``,
    and X isn't a multiplier. A wire into X is then priced, not unknown."""
    matched = [item.get("match") or {} for item in [*(entry.get("rows") or []), *(entry.get("extras") or [])]
               if isinstance(item, Mapping)]
    candidates = {wired_port(key) for match in matched for key in match} - {None}
    return {str(port) for port in candidates
            if port not in {str(key) for key in entry.get("multiplyBy") or []}
            and all(wired_key(str(port)) in match for match in matched if port in match)}


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
    # A param the handler strips sends nothing when it's only whitespace.
    for key in entry.get("whitespaceUnset") or []:
        if isinstance(params.get(key), str) and not params[key].strip():
            params[key] = ""
    values = effective_params(entry, definition, params)
    if VIDEO_MODE in priced:
        values[VIDEO_MODE] = video_mode(wired)
    if REFERENCES in priced:
        values[REFERENCES] = references(wired)
    ports = {str(port) for port in wired}
    for key in priced:
        port = wired_port(key)
        if port is not None:
            values[key] = "yes" if port in ports else "no"
    return values


def _positive(value: Any) -> float | None:
    if isinstance(value, bool) or not isinstance(value, (int, float)):
        return None
    amount = float(value)
    return amount if math.isfinite(amount) and amount > 0 else None


def _target_side(value: Any) -> float | None:
    """720 from "720p" (a target_resolution option)."""
    text = str(value or "").strip().lower()
    return _multiplier(text[:-1]) if text.endswith("p") else None


def _output_pixels(sizing: Mapping[str, Any], values: Mapping[str, Any], width: float, height: float) -> float | None:
    """Pixels in one output frame, by the entry's ``sizing.output`` rule."""
    rule = sizing.get("output")
    if rule is None:
        return width * height
    if rule != "upscale":
        return None
    mode = _as_match_value(values.get("upscale_mode") or "factor")
    if mode == "factor":
        factor = _multiplier(values.get("upscale_factor"))
        return None if factor is None else width * factor * height * factor
    if mode == "target":
        side = _target_side(values.get("target_resolution"))
        if side is None:
            return None
        short, long = min(width, height), max(width, height)
        # Which side the target sets isn't said: price both and take the larger.
        return max(side * side * long / short, side * side * short / long)
    return None


def sized_quantities(entry: Mapping[str, Any], values: Mapping[str, Any],
                     size: Mapping[str, Any] | None) -> dict[str, float] | None:
    """The SIZED_VARIABLES an entry reads, measured from its input's ``size``
    ({width, height, seconds, frames}); None when any of them can't be."""
    sizing = entry.get("sizing")
    wanted = priced_keys(entry) & set(SIZED_VARIABLES)
    if not isinstance(sizing, Mapping) or not isinstance(size, Mapping):
        return None
    megapixel = sizing.get("megapixel", DEFAULT_MEGAPIXEL)
    if isinstance(megapixel, bool) or not isinstance(megapixel, int) or megapixel <= 0:
        return None
    quantities: dict[str, float] = {}
    if wanted & {"(input megapixels)", "(output megapixels)", "(larger megapixels)"}:
        width, height = _positive(size.get("width")), _positive(size.get("height"))
        if width is None or height is None:
            return None
        output = _output_pixels(sizing, values, width, height)
        if output is None or not math.isfinite(output) or output <= 0:
            return None
        quantities["(input megapixels)"] = width * height / megapixel
        quantities["(output megapixels)"] = output / megapixel
        quantities["(larger megapixels)"] = max(quantities["(input megapixels)"], quantities["(output megapixels)"])
    for key, field in (("(source seconds)", "seconds"), ("(source frames)", "frames")):
        if key in wanted:
            amount = _positive(size.get(field))
            if amount is None:
                return None
            quantities[key] = amount
    for key in sizing.get("roundUp") or []:
        if key in quantities:
            # A hair over a whole number from float noise isn't another unit.
            quantities[key] = float(math.ceil(quantities[key] - 1e-9))
    return {key: quantities[key] for key in wanted}


def awaits_input(entry: Mapping[str, Any] | None) -> bool:
    """Whether this single-route entry is priced from its input's size, so a
    run without a measured input is unpriced only until the input exists."""
    if not entry or not isinstance(entry.get("sizing"), Mapping):
        return False
    priced = priced_keys(entry)
    return bool(priced & set(SIZED_VARIABLES)) and not priced & (set(RUN_TIME_VARIABLES) - set(SIZED_VARIABLES))


def sizing_ports(entry: Mapping[str, Any] | None) -> set[str]:
    """The input ports an entry (or any of its routes) measures."""
    if not isinstance(entry, Mapping):
        return set()
    entries = list((entry.get("routes") or {}).values()) if isinstance(entry.get("routes"), Mapping) else [entry]
    return {str(item["sizing"]["port"]) for item in entries
            if isinstance(item, Mapping) and isinstance(item.get("sizing"), Mapping) and item["sizing"].get("port")}


def size_note(entry: Mapping[str, Any] | None, definition: Mapping[str, Any]) -> str | None:
    """One line for agents: the entry's ``sizing.say`` and when it's priced,
    e.g. "...; priced from your image's size when you run it"."""
    if not awaits_input(entry):
        return None
    sizing = entry["sizing"]  # type: ignore[index]
    port = next((p for p in definition.get("inputPorts") or []
                 if isinstance(p, Mapping) and p.get("id") == sizing.get("port")), {})
    kind = "video" if str(port.get("dataType") or "").lower() == "video" else "image"
    return f"{str(sizing.get('say') or '').strip()}; priced from your {kind}'s size when you run it"


def estimate_node(
    entry: Mapping[str, Any] | None,
    definition: Mapping[str, Any],
    params: Mapping[str, Any] | None,
    route_provider: str | None = None,
    wired: Iterable[str] = (),
    size: Mapping[str, Any] | None = None,
) -> dict[str, Any] | None:
    """{currency, low, high} for one run of this node, or None if unpriced.

    ``route_provider`` is the provider the run will actually bill; when the
    entry names a different one, the run is unpriced. ``wired`` are the
    node's input ports that have an edge into them: a priced setting among
    them is only known at run time (the wire's value replaces the param), so
    the run is unpriced. Not just the rows that name it: a more general row
    or a skipped extra would price it wrong. The wired ports also give the
    VIDEO_MODE and REFERENCES an entry may match. An entry reading a
    RUN_TIME_VARIABLES quantity is priced only from ``size``, the measured
    input of its ``sizing`` port ({width, height, seconds, frames}), and is
    unpriced without one. A ``routes`` entry prices the route
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
    # The sizing port is measured, not read as a setting.
    if (priced - wire_aware_keys(entry)) & wired:
        return None
    values = _price_values(entry, definition, params, wired)
    if priced & set(RUN_TIME_VARIABLES):
        measured = sized_quantities(entry, values, size) if awaits_input(entry) else None
        if measured is None:
            return None
        values.update(measured)
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


# The cost classes of a node that calls a provider: what every cost surface
# counts it as. "paid" is the only one in "N paid", the paid lead and the
# figure; "plan" runs on the person's Krea plan ("1 on Krea plan"; GM, PR
# #203 r19 item 1); "mayCost" may bill the person's own account with their
# key (Idol with a Hugging Face token); "free" is a key-billing route with no
# key, or a sourced $0 (GM, PR #203 r18 item 1).
PAID = "paid"
PLAN = "plan"
MAY_COST = "mayCost"
FREE = "free"

# Each class as an agent reads it in a proposal's cost: the entry's `label`
# (canvas_proposals.cost_for), the count it is in (summarize_cost) and what
# it means. propose_change's tool description is written from this table
# (mcp_server), so a class added here is in what an MCP agent reads (review
# 10 of PR #203, LOW-2); tests/test_idol_round11.py checks it holds every
# class cost_class returns.
CLASS_ENTRIES: dict[str, dict[str, str]] = {
    PAID: {"label": '"paid · <provider>"', "count": "paidRuns",
           "means": "a provider call billed per run, summed in `cost.estimate` at its list price when it has one"},
    PLAN: {"label": '"on Krea plan"', "count": "planRuns",
           "means": "a run on the person's Krea plan, never paid and never in the estimate; its `reason` is "
                    '{"kind": "plan"}'},
    MAY_COST: {"label": '"may cost · <account>"', "count": "mayCostRuns",
               "means": "may bill the person's own account with their key (Idol on Hugging Face with a token)"},
    FREE: {"label": '"free · runs locally" or "free · <provider>"', "count": "freeRuns",
           "means": "costs nothing: a local node, a key-billing route without its key (\"free · Hugging Face\"), "
                    "or a provider call whose list price is $0 (`price` {\"low\": 0, \"high\": 0})"},
}


def class_entries_doc(indent: str = "    ") -> str:
    """CLASS_ENTRIES as the lines of a tool description."""
    return "\n".join(f"{indent}- `{kind}`, {entry['label']}, counted in `cost.{entry['count']}`: {entry['means']}."
                     for kind, entry in CLASS_ENTRIES.items())


def sourced_zero(estimate: Mapping[str, Any] | None) -> bool:
    """A node's own estimate (estimate_node) that is a sourced $0: priced in
    USD at exactly 0, with nothing its price leaves out."""
    return bool(estimate) and estimate.get("currency") == "usd" and estimate.get("high") == 0 \
        and estimate.get("low") == 0 and not estimate.get("plus")


def cost_class(definition: Mapping[str, Any], params: Mapping[str, Any] | None, api_keys: Mapping[str, Any],
               estimate: Mapping[str, Any] | None = None) -> str:
    """The one cost class of a node that calls a provider (callers leave out
    local nodes first: is_local), with ``params`` routed
    (node_route.with_wired_blockers) and the person's keys: a key-billing
    route's own class (node_route.key_billing), else "plan" for a run on the
    Krea plan, else "free" when ``estimate``, the node's own price, is a
    sourced $0, else "paid". frontend lib/costClass.ts costClass is the twin
    (pricing_cases.json classCases pins both); estimate_run, cost_for, the
    billing note and the placeholder gate read it, and nothing else reads
    key_billing or uses_krea_account to count a node (tests/test_idol_round10.py
    CLASS_PARTS)."""
    from services import node_route

    billing = node_route.key_billing(definition, params, api_keys)
    if billing is not None:
        return billing
    if uses_krea_account(definition, params or {}):
        return PLAN
    if sourced_zero(estimate):
        return FREE
    return PAID


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
    sizes: Mapping[str, Mapping[str, Any]] | None = None,
) -> dict[str, Any]:
    """USD estimate for a set of nodes, each {id, definitionId, params, name}.

    ``sizes`` maps a node id to the measured input of its entry's sizing
    port (services/input_sizes.run_input_sizes). A node priced by its input's
    size without one is unpriced and listed in ``awaitingInput`` too.

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
    reason (node_route.route_unavailable), never to another route's price.

    ``reasons`` maps each node that leaves the total open to why, in the
    kinds the Run chip's tooltip uses (runScope UnpricedReason): noPrice,
    cantRun, awaitingInput, missingKey with the ``keys`` it needs, and
    leftOut with the ``plus`` its price leaves out, and plan for a run on
    the Krea plan, so the proposal bar's Accept chip writes the same reason
    lines (GM, PR #203 r17 item 4, r19 item 1).

    ``classes`` maps every node that calls a provider to its cost class
    (cost_class: paid, plan, mayCost or free); ``free`` lists the sourced $0
    nodes, which are neither priced nor paid (GM, PR #203 r18 item 1), and
    ``sourcedZero`` is whether they are the run's only provider calls."""
    from services import node_route

    nodes_pricing = pricing.get("nodes") or {}
    low = high = 0.0
    priced: dict[str, dict[str, float]] = {}
    unpriced: list[str] = []
    plan: list[str] = []
    plan_runs: dict[str, dict[str, Any]] = {}
    plus: list[str] = []
    unavailable: dict[str, str] = {}
    awaiting: list[str] = []
    reasons: dict[str, dict[str, Any]] = {}
    classes: dict[str, str] = {}
    free: list[str] = []
    for item in items:
        node_id = str(item["id"])
        definition = definitions.get(str(item.get("definitionId") or "")) or {}
        params = item.get("params") or {}
        calls = 1
        if definition and str(item.get("definitionId")) == CINEMA_SCENE:
            nested = cinema_scene_base(params)
            if nested is None or not definitions.get(nested[0]):
                unpriced.append(node_id)
                reasons[node_id] = {"kind": "noPrice"}
                classes[node_id] = PAID
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
                reasons[node_id] = {"kind": "noPrice"}
                classes[node_id] = PAID
                continue
        elif not definition or definition.get("apiProvider") == "utility":
            continue
        # A Krea-only setting that arrives by wire keeps the run on Krea
        # (node_route.with_wired_blockers), as the router does, and a wired
        # input can block or unblock a route-table node's plan route.
        routed = node_route.with_wired_blockers(definition, params, ports)
        # The one cost class (cost_class). A route that is free unless the
        # person's key is set, and then may bill their own account
        # (mayBillWithKey: Idol), adds nothing to any estimate: not "$0",
        # since past the allowance the cost is real, and not unpriced (GM, PR
        # #203 r11 item 2: "Estimate line: show nothing for Idol"). One place
        # for every caller: a proposal's estimate, the run's, and the
        # placeholder confirm's (review 8, LOW-2).
        cls = cost_class(definition, routed, api_keys)
        if cls in (MAY_COST, FREE):
            classes[node_id] = cls
            continue
        if cls == PLAN:
            # On the person's Krea plan: never paid, never in the figure, and
            # its own reason line (GM, PR #203 r19 item 1; review 9, MEDIUM-1).
            classes[node_id] = PLAN
            plan.append(node_id)
            plan_runs[node_id] = {"model": str(definition.get("id") or item.get("definitionId") or ""),
                                  "runs": (multipliers or {}).get(node_id, (1, 1))[1] * calls}
            reasons[node_id] = {"kind": "plan"}
            continue
        classes[node_id] = PAID
        # No key for any of the node's providers: a missing key, never "no
        # listed price" (runScope keyUnset).
        key_unset = False
        if node_route.has_routes(definition):
            missing = node_route.route_unavailable(definition, routed, api_keys)
            if missing is not None:
                unpriced.append(node_id)
                unavailable[node_id] = missing["message"]
                reasons[node_id] = ({"kind": "cantRun"} if missing.get("block")
                                    else {"kind": "missingKey", "keys": list(missing.get("missing") or [])})
                continue
            price_key = route_price_key(definition, node_route.select_route(definition, routed, api_keys))
        else:
            route = node_route.select_route(definition, routed, api_keys)
            price_key = route.provider
            key_unset = route.kind == node_route.UNSET
        entry = nodes_pricing.get(definition.get("id") or item.get("definitionId"))
        size = (sizes or {}).get(node_id) if str(item.get("definitionId")) != CINEMA_SCENE else None
        estimate = estimate_node(entry, definition, params, price_key, ports, size)
        if estimate is None or estimate["currency"] != "usd":
            unpriced.append(node_id)
            if size is None and awaits_input(entry_for_route(entry, price_key)):
                awaiting.append(node_id)
                reasons[node_id] = {"kind": "awaitingInput"}
            elif key_unset and node_route.env_keys(definition):
                reasons[node_id] = {"kind": "missingKey", "keys": node_route.env_keys(definition)}
            else:
                reasons[node_id] = {"kind": "noPrice"}
            continue
        if cost_class(definition, routed, api_keys, estimate) == FREE:
            # A sourced $0 is free (GM, PR #203 r18 item 1): never paid, never
            # in the figure; a run of only these is a sourced "$0".
            classes[node_id] = FREE
            free.append(node_id)
            continue
        run_low, run_high = (multipliers or {}).get(node_id, (1, 1))
        line = {"low": estimate["low"] * run_low * calls, "high": estimate["high"] * run_high * calls,
                "model": str(definition.get("id") or item.get("definitionId") or "")}
        priced[node_id] = line
        low += line["low"]
        high += line["high"]
        if estimate.get("plus") and estimate["plus"] not in plus:
            plus.append(estimate["plus"])
        if estimate.get("plus"):
            reasons[node_id] = {"kind": "leftOut", "plus": estimate["plus"]}
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
        "awaitingInput": awaiting,
        "reasons": reasons,
        "classes": classes,
        "free": free,
        # Every provider call in the run is a sourced $0, so it is exact, not
        # an estimate that rounds to zero: GM, PR #203 r11 item 4, "$0"
        # against "~$0" (r18 item 1: such a node is free, never paid).
        "sourcedZero": bool(free) and not priced and not unpriced and not plan and not any(
            cls == MAY_COST for cls in classes.values()),
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
    pricing: Mapping[str, Any] | None = None, size: Mapping[str, Any] | None = None,
) -> dict[str, dict[str, Any] | None]:
    """{route id: the estimate on that route, or None} for a route-table
    node: what each row of the provider switcher shows at these params. None
    when the route can't take the run (route_block) or has no list price.
    ``ports`` are the wired input ports (or a port -> count map); ``size``
    the measured input, for a route priced by it. Keys don't matter here: a
    row shows its price whether or not its key is set."""
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
        estimates[str(route["id"])] = estimate_node(entry, definition, params, key, wired, size)
    return estimates
