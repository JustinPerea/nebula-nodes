"""Curated list prices for paid nodes, and the run-cost estimate built on them.

``data/model_pricing.json`` is hand-maintained: every entry names the vendor
page it was read from, a short quote of the price line, and the date it was
checked. Nothing here is fetched or inferred at runtime. A node with no entry,
or whose settings match no row, is *unpriced*: callers must say so rather than
count it as free.

Shape of one entry (keyed by node definition id)::

    {
      "currency": "usd" | "krea_cu",
      "per": "image" | "video" | "second" | "request",
      "priceParams": ["model", "quality"],          # documentation only
      "rows": [{"match": {"quality": "low"}, "price": 0.011},
               {"match": {"quality": "auto"}, "price": [0.011, 0.167]}],
      "extras": [{"match": {"web_search": true}, "price": 0.015}],  # added per unit
      "multiplyBy": ["num_images"],                  # numeric params
      "provider": "google",                          # dual-route nodes: whose price this is
      "plus": "input images",                        # a known cost the vendor doesn't publish
      "defaults": {"duration": 8},                   # what the handler sends when unset
      "notes": "...",
      "sources": [{"url": "https://...", "quote": "..."}],
      "checked": "2026-10-10"
    }

Rows are tried in order; the first whose every ``match`` key equals the
node's effective value wins, so list specific rows before general ones. A
price is a number or a ``[low, high]`` range for settings (like ``auto``) that
only resolve at run time.

``frontend/src/lib/pricing.ts`` implements the same estimate; both are tested
against ``tests/fixtures/pricing_cases.json`` so they cannot drift.
"""
from __future__ import annotations

import json
import math
import re
from datetime import date
from pathlib import Path
from typing import Any, Mapping

PRICING_PATH = Path(__file__).resolve().parent.parent / "data" / "model_pricing.json"
CURRENCIES = ("usd", "krea_cu")
PER_UNITS = ("image", "video", "second", "request")
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
    params: list[Mapping[str, Any]] = []
    for key in ("params", "directParams", "falParams"):
        value = definition.get(key)
        if isinstance(value, list):
            params.extend(p for p in value if isinstance(p, Mapping))
    return params


def validate_pricing(pricing: Mapping[str, Any], definitions: Mapping[str, Mapping[str, Any]]) -> list[str]:
    """Every problem with the file, as readable strings. Empty means valid."""
    problems: list[str] = []
    currencies = pricing.get("currencies") or {}
    for node_id, entry in (pricing.get("nodes") or {}).items():
        where = f"{node_id}:"
        definition = definitions.get(node_id)
        if definition is None:
            problems.append(f"{where} no such node definition")
            continue
        if definition.get("apiProvider") == "utility":
            problems.append(f"{where} local utility nodes are free and must not be priced")
        if not isinstance(entry, Mapping):
            problems.append(f"{where} entry must be an object")
            continue
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
        known_keys = set(params) | set((entry.get("defaults") or {}).keys())
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
            for key, value in (row.get("match") or {}).items():
                if key not in known_keys:
                    problems.append(f"{where} row {index} matches unknown param '{key}'")
                    continue
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
        if isinstance(env_keys, list) and len([k for k in env_keys if k]) > 1 and not entry.get("provider"):
            problems.append(f"{where} can run on more than one provider, so it must name whose price this is")
        for key in entry.get("multiplyBy") or []:
            if key not in known_keys:
                problems.append(f"{where} multiplyBy names unknown param '{key}'")
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


def estimate_node(
    entry: Mapping[str, Any] | None,
    definition: Mapping[str, Any],
    params: Mapping[str, Any] | None,
    route_provider: str | None = None,
) -> dict[str, Any] | None:
    """{currency, low, high} for one run of this node, or None if unpriced.

    ``route_provider`` is the provider the run will actually bill; when the
    entry names a different one, the run is unpriced."""
    if not entry:
        return None
    if entry.get("provider") and route_provider and entry["provider"] != route_provider:
        return None
    values = effective_params(entry, definition, params)
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
                try:
                    amount = float(values.get(key))
                except (TypeError, ValueError):
                    amount = 1.0
                factor *= amount if math.isfinite(amount) and amount > 0 else 1.0
            result = {"currency": entry["currency"], "low": bounds[0] * factor, "high": bounds[1] * factor}
            if entry.get("plus"):
                result["plus"] = str(entry["plus"])
            return result
    return None


# -- a whole run ---------------------------------------------------------------
# These mirror frontend/src/lib/runScope.ts and modelDiscovery.runRouteProvider.

CREDENTIAL_PROVIDERS: dict[str, str] = {
    "OPENAI_API_KEY": "openai", "ANTHROPIC_API_KEY": "anthropic", "GOOGLE_API_KEY": "google",
    "OPENROUTER_API_KEY": "openrouter", "REPLICATE_API_TOKEN": "replicate", "FAL_KEY": "fal",
    "MESHY_API_KEY": "meshy", "RUNWAY_API_KEY": "runway", "ELEVENLABS_API_KEY": "elevenlabs",
    "MINIMAX_API_KEY": "minimax", "XAI_API_KEY": "xai", "HIGGSFIELD_API_KEY": "higgsfield",
    "QUIVER_API_KEY": "quiver", "KREA_API_TOKEN": "krea", "IDEOGRAM_API_KEY": "ideogram",
    "WORLDLABS_API_KEY": "worldlabs",
}
FANOUT_IDS = frozenset({"batch", "iterator-image", "iterator-text"})


def route_provider(definition: Mapping[str, Any], api_keys: Mapping[str, Any]) -> str | None:
    """The provider a run of this node bills: the direct key when it is set,
    else the first other configured key (dual-route nodes fall back to FAL)."""
    provider = definition.get("apiProvider")
    if provider == "utility":
        return None
    env = definition.get("envKeyName")
    keys = [k for k in (env if isinstance(env, list) else [env]) if k]
    if len(keys) < 2:
        return provider
    direct = definition.get("directKeyName")
    if direct and api_keys.get(direct):
        route_key = direct
    else:
        route_key = next((k for k in keys if k != direct and api_keys.get(k)), None)
    return CREDENTIAL_PROVIDERS.get(route_key or "", provider)


def uses_krea_account(definition: Mapping[str, Any], params: Mapping[str, Any]) -> bool:
    """Krea runs billed to a signed-in account's plan rather than per call."""
    if definition.get("apiProvider") != "krea":
        return False
    auth = next((p for p in definition.get("params") or [] if p.get("key") == "_kreaAuth"), None)
    if auth is None:
        return False
    options = [o.get("value") if isinstance(o, Mapping) else o for o in auth.get("options") or []]
    if options == ["mcp"]:
        return True
    return params.get("_kreaAuth") == "mcp"


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


def estimate_run(
    items: list[Mapping[str, Any]],
    pricing: Mapping[str, Any],
    definitions: Mapping[str, Mapping[str, Any]],
    api_keys: Mapping[str, Any],
    multipliers: Mapping[str, tuple[int, int]] | None = None,
) -> dict[str, Any]:
    """USD estimate for a set of nodes, each {id, definitionId, params, name}.

    ``priced`` maps node id to {low, high}; paid nodes without a list price go
    in ``unpriced``, Krea-account runs in ``plan``. ``low``/``high`` are None
    when nothing is priced."""
    nodes_pricing = pricing.get("nodes") or {}
    low = high = 0.0
    priced: dict[str, dict[str, float]] = {}
    unpriced: list[str] = []
    plan: list[str] = []
    plus: list[str] = []
    for item in items:
        node_id = str(item["id"])
        definition = definitions.get(str(item.get("definitionId") or "")) or {}
        if not definition or definition.get("apiProvider") == "utility":
            continue
        params = item.get("params") or {}
        if uses_krea_account(definition, params):
            plan.append(node_id)
            continue
        estimate = estimate_node(
            nodes_pricing.get(definition.get("id") or item.get("definitionId")),
            definition, params, route_provider(definition, api_keys),
        )
        if estimate is None or estimate["currency"] != "usd":
            unpriced.append(node_id)
            continue
        run_low, run_high = (multipliers or {}).get(node_id, (1, 1))
        line = {"low": estimate["low"] * run_low, "high": estimate["high"] * run_high}
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
        "plus": plus,
    }
