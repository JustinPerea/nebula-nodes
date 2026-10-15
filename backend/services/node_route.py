"""Which route one run of a node takes, and so which provider it bills.

Some nodes can run on more than one provider: a fal or Krea copy of a model
can also run on its maker's own API with the person's key (``directKeyName``),
and Krea nodes can bill the signed-in Krea plan (``_kreaAuth``). Every place
that has to know where a run goes asks :func:`select_route`: the execution
router (execution/maker_routes.py), pricing and the spend gate
(services/model_pricing.py), readiness and describe_node, the engine's
preflight and its cache key. frontend/src/lib/directRoute.ts ``selectRoute``
is the same rule, and both are tested against
tests/fixtures/route_cases.json.

A node can instead list its providers as a route table (``routes``, see
:class:`RouteSpec` and docs/PROVIDER-ROUTES.md): one node per model, the
maker's API first, then each aggregator. Its saved ``_provider`` names the
route (or "auto"), and who bills depends only on that choice and the keys
set, never on a param edit (see :func:`select_route`). Nodes without
``routes`` keep the rule below unchanged.

Precedence for nodes without ``routes``, the same everywhere:

1. ``_kreaAuth == "mcp"`` (or an account-only Krea node): the Krea plan. It's
   the person's explicit choice, so a maker key never overrides it.
2. a direct (maker) key is set, and the direct route can take this run
   (:func:`direct_block`): the maker's API.
3. otherwise the first other key that is set (``FAL_KEY``, ``KREA_API_TOKEN``,
   or ``RUNWAY_API_KEY`` for the ElevenLabs models Runway resells): the copy.

Stdlib only, so the engine and the scripts can import it cheaply.
"""
from __future__ import annotations

import math
from datetime import date
from typing import Any, Iterable, Mapping, NamedTuple, TypedDict

# Which provider bills a run that uses this key. Vertex bills Veo at the same
# listed amounts as the Gemini API.
KEY_PROVIDERS: dict[str, str] = {
    "OPENAI_API_KEY": "openai", "ANTHROPIC_API_KEY": "anthropic", "GOOGLE_API_KEY": "google",
    "OPENROUTER_API_KEY": "openrouter", "REPLICATE_API_TOKEN": "replicate", "FAL_KEY": "fal",
    "MESHY_API_KEY": "meshy", "RUNWAY_API_KEY": "runway", "ELEVENLABS_API_KEY": "elevenlabs",
    "MINIMAX_API_KEY": "minimax", "XAI_API_KEY": "xai", "HIGGSFIELD_API_KEY": "higgsfield",
    "QUIVER_API_KEY": "quiver", "KREA_API_TOKEN": "krea", "IDEOGRAM_API_KEY": "ideogram",
    "WORLDLABS_API_KEY": "worldlabs", "TYPESAFE_API_KEY": "typesafe",
    "GOOGLE_VERTEX_CREDENTIALS": "google",
    # BytePlus ModelArk, ByteDance's own international API (Seedream, Seedance).
    "BYTEPLUS_API_KEY": "bytedance",
    # Black Forest Labs' own API (api.bfl.ai), the maker of FLUX.
    "BFL_API_KEY": "bfl",
}

# How errors and readiness name a provider. frontend/src/lib/directRoute.ts
# PROVIDER_LABELS is the same table (tests/fixtures/route_tables.json pins both).
PROVIDER_LABELS: dict[str, str] = {
    "openai": "OpenAI", "anthropic": "Anthropic", "google": "Google", "runway": "Runway",
    "kling": "Kling", "elevenlabs": "ElevenLabs", "replicate": "Replicate", "fal": "fal.ai",
    "bytedance": "ByteDance", "minimax": "MiniMax", "luma": "Luma", "xai": "xAI",
    "recraft": "Recraft", "ideogram": "Ideogram", "openrouter": "OpenRouter", "bfl": "Black Forest Labs",
    "higgsfield": "Higgsfield", "meshy": "Meshy", "quiver": "QuiverAI", "krea": "Krea",
    "worldlabs": "World Labs", "nous": "Nous", "typesafe": "TypeSafe", "utility": "Local tools",
}

# A direct route that also needs a param set, else the run takes the fallback.
# Ideogram's direct reframe sizes by `resolution`; a saved recipe with only
# fal's `image_size` stays on fal (execution/sync_runner.py _ideogram_router).
# Runway's TTS and speech-to-speech voices are Runway presets with no
# documented ElevenLabs voice id, so their ElevenLabs route needs the
# recipe's own ElevenLabs `voice_id` (execution/maker_routes_elevenlabs.py).
DIRECT_REQUIRES: dict[str, str] = {
    "ideogram-reframe": "resolution",
    "runway-tts": "voice_id",
    "runway-sts": "voice_id",
}

# A direct route the maker shuts down on a date: from that day on the run takes
# the fal or Krea copy instead, and pricing, the spend gate, readiness and the
# cache key move with it (they all ask select_route). ``param``/``values``
# narrow it to the saved model choices that call the retiring model.
# gemini-2.5-flash-image: Google's deprecations table lists "March 15, 2027"
# as its earliest shutdown (https://ai.google.dev/gemini-api/docs/deprecations,
# checked 2026-10-14; the page tracks the announced dates). The pricing page
# banner says "October 2, 2026", already past, with no shutdown in the
# changelog and the model still listed as stable, so the table's date is the
# one gated; a 404 before then names the replacement (maker_routes.py).
_GEMINI_25_FLASH_IMAGE_SHUTDOWN = "2027-03-15"
_GPT_IMAGE_15_SHUTDOWN = "2026-12-01"
DIRECT_RETIRES: dict[str, dict[str, Any]] = {
    "nano-banana-fal": {"on": _GEMINI_25_FLASH_IMAGE_SHUTDOWN, "param": "model",
                        "values": ["nano-banana", "gemini-25-flash-image"]},
    "nano-banana-fal-edit": {"on": _GEMINI_25_FLASH_IMAGE_SHUTDOWN, "param": "model",
                             "values": ["nano-banana", "gemini-25-flash-image"]},
    "krea-image-google-nano-banana": {"on": _GEMINI_25_FLASH_IMAGE_SHUTDOWN},
    # gpt-image-1.5: "Dec 1, 2026 | `gpt-image-1.5` | `gpt-image-2.5-sunburst` or
    # `gpt-image-2.5-flare`" (https://developers.openai.com/api/docs/deprecations,
    # checked 2026-10-14). From that day the fal copies run it.
    "gpt-image-1-5": {"on": _GPT_IMAGE_15_SHUTDOWN},
    "gpt-image-1-5-edit": {"on": _GPT_IMAGE_15_SHUTDOWN},
}

# Why a direct route can't take a run (direct_block). The rules live on the
# definition's ``directRoute`` (see direct_block); Python and
# frontend/src/lib/directRoute.ts read them the same way.
REQUIRES = "requires"        # DIRECT_REQUIRES: the direct route needs a param that isn't set
BLOCKED = "blocked"          # a copy-only param is set or wired (directRoute.blockedBy)
UNSUPPORTED = "unsupported"  # a value the maker doesn't take (directRoute.accepts, rejects, rejectsWhen)
SIZE = "size"                # a size the maker can't render exactly (directRoute.size)
RETIRED = "retired"          # DIRECT_RETIRES: the maker shut this model down on its API
# Route-table nodes only (RouteSpec.rules.ports, and a saved _provider):
PORTS = "ports"              # more inputs wired into a port than the route takes (rules.ports)
UNKNOWN_PROVIDER = "unknown-provider"  # _provider names a route the node doesn't have

LOCAL = "local"        # a utility node: no provider
PLAN = "plan"          # the signed-in Krea plan
ONLY = "only"          # a node with one route
DIRECT = "direct"      # the maker's API, with the person's key
FALLBACK = "fallback"  # the fal or Krea copy
UNSET = "unset"        # a multi-route node with none of its keys set


class Route(NamedTuple):
    """Where one run goes. ``route_id``, ``block`` and ``missing`` are only
    set for route-table nodes (``routes``): the route chosen or resolved,
    why it can't take this run (a :class:`DirectBlock`), and the keys it
    would need. Nodes without ``routes`` leave the defaults, so a Route built
    from three fields still compares equal."""
    kind: str
    provider: str | None
    key: str | None
    route_id: str | None = None
    block: "DirectBlock | None" = None
    missing: tuple[str, ...] = ()


# The params that decide who bills a run: the provider choice and the Krea
# billing mode. Only the person changes them; agents propose (main.py
# _refuse_agent_billing_change), run write-backs never copy them, and the
# switcher, not the generic param list, edits them.
PROVIDER_PARAM = "_provider"
BILLING_PARAMS: tuple[str, ...] = (PROVIDER_PARAM, "_kreaAuth")
AUTO = "auto"


class RouteSpec(TypedDict, total=False):
    """One provider route of a route-table node (definition ``routes``,
    frontend/src/types RouteSpec). Auto tries them in this order.

    - ``id``: unique in the node; the saved ``_provider`` names it. It equals
      ``provider`` unless a node has two routes on one provider.
    - ``provider``: who bills a run on this route (KEY_PROVIDERS of
      ``keys[0]``, except a plan-only route).
    - ``maker``: the model maker's own API; at most one, and it is routes[0].
    - ``keys``: any of them runs it, tried in order.
    - ``plan``: a Krea route that can bill the signed-in plan ("optional":
      when ``_kreaAuth`` is "mcp"; "only": always).
    - ``handler``: the client that runs it (execution/route_clients.py).
    - ``endpoint`` / ``endpointWhen``: the provider's model or path; the first
      ``endpointWhen`` entry whose ``when`` matches wins (route_endpoint).
    - ``params``: params only this route takes. ``rename`` maps a param to
      the provider's name, and ``valueMap`` a param's values to the
      provider's; a value it doesn't list is one the route doesn't take.
    - ``rules``: the directRoute rule grammar (blockedBy, accepts, rejects,
      rejectsWhen, size) plus ``ports`` ``{port: {max}}``, the most inputs
      the route takes on a wired port.
    - ``pricing``: its key under model_pricing.json ``routes`` (default id).
    - ``note``: readiness copy for this route.

    Nodes without ``routes`` get computed specs from :func:`routes_of`,
    whose ``rules`` also carry ``requires`` (DIRECT_REQUIRES) and
    ``retires`` (DIRECT_RETIRES)."""
    id: str
    provider: str
    maker: bool
    keys: list[str]
    plan: str
    handler: str
    endpoint: str
    endpointWhen: list[dict[str, Any]]
    params: list[dict[str, Any]]
    rename: dict[str, str]
    valueMap: dict[str, dict[str, Any]]
    rules: dict[str, Any]
    pricing: str
    note: str


def keys(value: Any) -> list[str]:
    return [k for k in (value if isinstance(value, list) else [value]) if isinstance(k, str) and k]


def env_keys(definition: Mapping[str, Any]) -> list[str]:
    return keys(definition.get("envKeyName"))


def direct_keys(definition: Mapping[str, Any]) -> list[str]:
    return keys(definition.get("directKeyName"))


def fallback_keys(definition: Mapping[str, Any]) -> list[str]:
    direct = direct_keys(definition)
    return [key for key in env_keys(definition) if key not in direct]


def is_multi_route(definition: Mapping[str, Any]) -> bool:
    return len(env_keys(definition)) > 1


def fallback_provider(definition: Mapping[str, Any]) -> str | None:
    """Who runs a dual-route node without its maker key: the provider of its
    first non-direct key ("fal", "krea", or "runway" for Runway's resold
    ElevenLabs models)."""
    if not direct_keys(definition):
        return None
    for key in fallback_keys(definition):
        if key in KEY_PROVIDERS:
            return KEY_PROVIDERS[key]
    return None


def has_routes(definition: Mapping[str, Any]) -> bool:
    """A route-table node: its definition lists ``routes`` (RouteSpec)."""
    routes = definition.get("routes")
    return isinstance(routes, list) and bool(routes)


def _group_keys(keys_: list[str], provider: Any) -> list[tuple[str, list[str]]]:
    """``keys_`` grouped by the provider that bills them, in first-seen order."""
    grouped: dict[str, list[str]] = {}
    for key in keys_:
        grouped.setdefault(str(KEY_PROVIDERS.get(key, provider)), []).append(key)
    return list(grouped.items())


# The directRoute fields that are rules (route_block reads them); the others
# (translation, model, snap, setup, startShape) tell the maker router how to
# call the maker, not whether it can.
_RULE_KEYS = ("blockedBy", "accepts", "rejects", "rejectsWhen", "size")


def _legacy_rules(definition: Mapping[str, Any]) -> dict[str, Any]:
    """A dual-route node's maker rules in RouteSpec ``rules`` form:
    ``directRoute``'s rules plus ``requires`` (DIRECT_REQUIRES) and
    ``retires`` (DIRECT_RETIRES)."""
    spec = definition.get("directRoute")
    spec = spec if isinstance(spec, Mapping) else {}
    rules: dict[str, Any] = {key: spec[key] for key in _RULE_KEYS if key in spec}
    node_id = str(definition.get("id") or "")
    if node_id in DIRECT_REQUIRES:
        rules["requires"] = DIRECT_REQUIRES[node_id]
    if node_id in DIRECT_RETIRES:
        rules["retires"] = dict(DIRECT_RETIRES[node_id])
    return rules


def routes_of(definition: Mapping[str, Any]) -> list[RouteSpec]:
    """Every route a node can run on, in Auto order, as RouteSpecs.

    A route-table node returns its ``routes``. Every other node gets computed
    specs, so pricing, readiness, describe_node and discovery read one shape:
    a dual-route node's maker route (``directKeyName``, ``directParams``, its
    directRoute rules) and then one copy route per other provider in
    ``envKeyName`` order (``falParams``); a single-route node one route on its
    ``apiProvider``. :func:`select_route` doesn't use the computed specs: a
    node without ``routes`` keeps its own rule."""
    if has_routes(definition):
        return [route for route in definition["routes"] if isinstance(route, Mapping)]  # type: ignore[misc]
    provider = definition.get("apiProvider")
    direct = direct_keys(definition)
    if len(env_keys(definition)) < 2:
        return [RouteSpec(id=str(provider or ""), provider=str(provider or ""), keys=env_keys(definition),
                          params=[])]
    specs: list[RouteSpec] = []
    if direct:
        maker = str(KEY_PROVIDERS.get(direct[0], provider))
        specs.append(RouteSpec(id=maker, provider=maker, maker=True, keys=direct,
                               params=list(definition.get("directParams") or []),
                               rules=_legacy_rules(definition)))
    for copy_provider, copy_keys in _group_keys(fallback_keys(definition), provider):
        specs.append(RouteSpec(id=copy_provider, provider=copy_provider, keys=copy_keys,
                               params=list(definition.get("falParams") or [])))
    return specs


def route_by_id(definition: Mapping[str, Any], route_id: Any) -> RouteSpec | None:
    return next((route for route in routes_of(definition) if route.get("id") == route_id), None)


def maker_route(definition: Mapping[str, Any]) -> RouteSpec | None:
    return next((route for route in routes_of(definition) if route.get("maker")), None)


_PARAM_GROUPS = ("params", "sharedParams", "directParams", "falParams")


def all_param_definitions(definition: Mapping[str, Any]) -> list[Mapping[str, Any]]:
    """Every param a node declares, once per key: ``params``, ``sharedParams``,
    ``directParams``, ``falParams``, then each route's own ``params``; the
    first definition of a key wins. The one place that list is written
    (tests/test_node_route.py pins it to every hand-written order it
    replaced). frontend/src/lib/directRoute.ts allParamDefinitions is the same."""
    seen: dict[str, Mapping[str, Any]] = {}
    groups = [definition.get(group) or [] for group in _PARAM_GROUPS]
    if has_routes(definition):
        groups += [route.get("params") or [] for route in routes_of(definition)]
    for group in groups:
        for param in group if isinstance(group, list) else []:
            if isinstance(param, Mapping) and param.get("key") and param["key"] not in seen:
                seen[str(param["key"])] = param
    return list(seen.values())


def param_definition(definition: Mapping[str, Any], key: str) -> Mapping[str, Any] | None:
    return next((param for param in all_param_definitions(definition) if param.get("key") == key), None)


def krea_auth_param(definition: Mapping[str, Any]) -> Mapping[str, Any] | None:
    """The node's ``_kreaAuth`` param: on a Krea node, or on a route-table
    node with a Krea route that can bill the plan (RouteSpec ``plan``)."""
    if definition.get("apiProvider") != "krea" and not any(
            route.get("plan") for route in (routes_of(definition) if has_routes(definition) else [])):
        return None
    return next((p for p in definition.get("params") or []
                 if isinstance(p, Mapping) and p.get("key") == "_kreaAuth"), None)


def uses_krea_plan(definition: Mapping[str, Any], params: Mapping[str, Any] | None) -> bool:
    """A run billed to the signed-in Krea plan: an account-only Krea node, or
    one whose saved `_kreaAuth` is "mcp". Nodes saved before the choice
    existed keep API-token billing. On a route-table node, exactly when
    :func:`select_route` returns PLAN (its Krea route, chosen or the maker
    under Auto, with the plan picked, and able to take the run), so
    ``params`` are routed (with_wired_blockers) as the router reads them: a
    wired input can block the plan route or unblock it."""
    if has_routes(definition):
        values = params or {}
        route = _plan_route(definition, values)
        return route is not None and route_block(definition, route, values) is None
    param = krea_auth_param(definition)
    if param is None:
        return False
    options = [o.get("value") if isinstance(o, Mapping) else o for o in param.get("options") or []]
    if options == ["mcp"]:
        return True
    return (params or {}).get("_kreaAuth", "api-token") == "mcp"


def _is_set(api_keys: Mapping[str, Any], key: str) -> bool:
    value = api_keys.get(key)
    return isinstance(value, str) and bool(value.strip())


def _today() -> str:
    """Today's date as YYYY-MM-DD (tests patch this; directRoute.ts reads the clock)."""
    return date.today().isoformat()


def _has_value(value: Any) -> bool:
    """A param counts as set when it isn't None, "" or only whitespace (a
    voice_id of "  " is unset, as the translators read it). directRoute.ts
    hasValue is the same."""
    if isinstance(value, str):
        return value.strip() != ""
    return value is not None


class DirectBlock(NamedTuple):
    reason: str
    param: str | None = None
    on: str | None = None
    # UNSUPPORTED: what the maker doesn't take, for readiness and errors: the
    # param and its value ("resolution 4K"), or a rejectsWhen rule's label.
    detail: str | None = None


# A rejectsWhen value that matches a param that is set: saved non-empty, or
# wired into its port (with_wired_blockers).
SET = "(set)"
# A rejectsWhen value that matches a param that is NOT set: not saved (or
# blank) and not wired. Gen-4.5's text-to-video ratios need it: a ratio is
# refused only when no start image comes with it.
NOT_SET = "(unset)"
# A param that arrives by wire rather than saved (with_wired_blockers).
WIRED = "(wired)"


def match_value(value: Any) -> str:
    """One spelling for a param value, as pricing compares them: 6 == 6.0 and
    True == "true", but 0 is not False. directRoute.ts matchValue is the same."""
    if value is None:
        return ""
    if isinstance(value, bool):
        return "true" if value else "false"
    if isinstance(value, float) and value.is_integer():
        return str(int(value))
    return str(value)


def value_accepted(value: Any, rule: Mapping[str, Any]) -> bool:
    """A value the maker takes (one ``directRoute.accepts`` rule): one of
    ``values``, and/or a number (``integer``: whole) within ``min``..``max``."""
    if "values" in rule and match_value(value) not in {match_value(v) for v in rule.get("values") or []}:
        return False
    if any(key in rule for key in ("min", "max", "integer")):
        if isinstance(value, bool) or not isinstance(value, (int, float)) or not math.isfinite(value):
            return False
        if rule.get("integer") and not float(value).is_integer():
            return False
        if "min" in rule and value < rule["min"]:
            return False
        if "max" in rule and value > rule["max"]:
            return False
    return True


def size_fits(width: Any, height: Any, limits: Mapping[str, Any]) -> bool:
    """A whole-pixel width x height inside ``limits`` (minPixels, maxPixels,
    maxAspect), the way the maker documents its "WxH" size."""
    for value in (width, height):
        if isinstance(value, bool) or not isinstance(value, (int, float)):
            return False
        if not float(value).is_integer() or value <= 0:
            return False
    pixels = width * height
    if pixels < limits.get("minPixels", 0) or pixels > limits.get("maxPixels", float("inf")):
        return False
    return max(width / height, height / width) <= limits.get("maxAspect", float("inf"))


def _size_block(definition: Mapping[str, Any], params: Mapping[str, Any], limits: Any) -> DirectBlock | None:
    """SIZE when the recipe's size is outside ``directRoute.size``.

    ``widthParam``/``heightParam`` name an explicit size (a Krea copy's
    width/height; unset leaves it to the route's own required-field check).
    ``param`` names a size choice (fal's ``image_size``): a value listed in
    ``unsupported`` blocks, and a ``{width, height}`` value must fit."""
    if not isinstance(limits, Mapping):
        return None
    width_key, height_key = limits.get("widthParam"), limits.get("heightParam")
    if width_key and height_key:
        width, height = params.get(width_key), params.get(height_key)
        if (_has_value(width) or _has_value(height)) and not size_fits(width, height, limits):
            return DirectBlock(SIZE, str(width_key))
    key = limits.get("param")
    if key:
        value = _effective(definition, params, str(key))
        if isinstance(value, str) and value in (limits.get("unsupported") or []):
            return DirectBlock(SIZE, str(key))
        if isinstance(value, Mapping) and not size_fits(value.get("width"), value.get("height"), limits):
            return DirectBlock(SIZE, str(key))
    return None


def _matches(definition: Mapping[str, Any], params: Mapping[str, Any], key: str, want: Any) -> bool:
    """One entry of a rejectsWhen ``match``: SET means saved non-empty or
    wired, NOT_SET ("(unset)") neither; any other value is compared with the run's value
    (saved, else the definition default)."""
    if want == SET:
        return _has_value(params.get(key))
    if want == NOT_SET:
        return not _has_value(params.get(key))
    return match_value(_effective(definition, params, key)) == match_value(want)


def _unsupported(definition: Mapping[str, Any], params: Mapping[str, Any], spec: Mapping[str, Any]) -> DirectBlock | None:
    """UNSUPPORTED from the value rules, read against the run's values (saved,
    else the definition default):

    - ``accepts`` ``{param: {values?, min?, max?, integer?}}``: the values
      the maker takes; any other set value blocks.
    - ``rejects`` ``{param: [values]}``: values the maker doesn't take.
    - ``rejectsWhen`` ``[{match: {param: value | "(set)" | "(unset)"}, label}]``:
      a combination the maker doesn't take; every entry must match."""
    accepts = spec.get("accepts")
    for key, rule in (accepts.items() if isinstance(accepts, Mapping) else []):
        value = _effective(definition, params, str(key))
        if _has_value(value) and isinstance(rule, Mapping) and not value_accepted(value, rule):
            return DirectBlock(UNSUPPORTED, str(key), None, f"{key} {match_value(value)}")
    rejects = spec.get("rejects")
    for key, refused in (rejects.items() if isinstance(rejects, Mapping) else []):
        value = _effective(definition, params, str(key))
        if _has_value(value) and match_value(value) in {match_value(v) for v in refused or []}:
            return DirectBlock(UNSUPPORTED, str(key), None, f"{key} {match_value(value)}")
    for rule in spec.get("rejectsWhen") or []:
        match = rule.get("match") if isinstance(rule, Mapping) else None
        if isinstance(match, Mapping) and match and all(
                _matches(definition, params, str(key), want) for key, want in match.items()):
            return DirectBlock(UNSUPPORTED, str(next(iter(match))), None, str(rule.get("label") or ""))
    return None


def direct_block(definition: Mapping[str, Any], params: Mapping[str, Any] | None) -> DirectBlock | None:
    """Why the direct route can't take a run with these params, or None when it can.

    ``params`` are the run's saved params; the router, the estimate and the
    cache key first add the wired ports a rule reads (with_wired_blockers).
    The rules, in the order they are checked:

    - REQUIRES: the direct route needs a param the recipe doesn't set
      (DIRECT_REQUIRES: Ideogram Reframe's ``resolution``, an ElevenLabs
      ``voice_id`` on Runway TTS/STS).
    - BLOCKED: ``directRoute.blockedBy`` names copy-only params the maker
      can't honor (a Krea copy's explicit width/height, style images); a
      recipe that sets or wires one stays on the copy.
    - UNSUPPORTED: ``directRoute.accepts`` / ``rejects`` / ``rejectsWhen``
      (see _unsupported): a value or combination the maker doesn't take (Veo
      3.1 Fast at 4K on Vertex, GPT Image 2's small fal presets, MiniMax's 6
      or 10 seconds, Seedance's ratios and whole-second durations).
    - SIZE: ``directRoute.size`` holds the maker's documented output size
      limits; a size it can't render exactly stays on the copy instead of
      being silently resized (Seedream on BytePlus).
    - RETIRED: on and after a DIRECT_RETIRES date the maker no longer serves
      the model, so the fal or Krea copy runs it.

    A rule never blocks a param's default (scripts/sync-krea-catalog.py and
    tests/test_node_route.py check), so a new node can always take the
    maker route."""
    return _rules_block(definition, params or {}, _legacy_rules(definition))


def _rules_block(definition: Mapping[str, Any], values: Mapping[str, Any],
                 rules: Mapping[str, Any]) -> DirectBlock | None:
    """direct_block's checks, in its order, over one rule set (RouteSpec
    ``rules``; a dual-route node's comes from _legacy_rules), then the
    ``ports`` rule, which only route-table nodes use."""
    needed = rules.get("requires")
    if needed and not _has_value(values.get(needed)):
        return DirectBlock(REQUIRES, str(needed))
    for key in rules.get("blockedBy") or []:
        if _has_value(values.get(key)):
            return DirectBlock(BLOCKED, str(key))
    block = _unsupported(definition, values, rules) or _size_block(definition, values, rules.get("size"))
    if block is not None:
        return block
    retires = rules.get("retires")
    if isinstance(retires, Mapping) and _today() >= retires["on"]:
        param = retires.get("param")
        if not param or _effective(definition, values, param) in retires.get("values", []):
            return DirectBlock(RETIRED, param, retires["on"])
    ports = rules.get("ports")
    counts = values.get(PORT_COUNTS)
    for port, limit in (ports.items() if isinstance(ports, Mapping) else []):
        count = counts.get(port, 0) if isinstance(counts, Mapping) else 0
        most = limit.get("max") if isinstance(limit, Mapping) else None
        if isinstance(most, int) and count > most:
            return DirectBlock(PORTS, str(port), None, f"{port} {count}")
    return None


def _route_rules(route: Mapping[str, Any]) -> dict[str, Any]:
    """A route's ``rules`` plus the ``accepts`` its ``valueMap`` implies: a
    value the map doesn't list is one the provider doesn't take. A param with
    its own ``accepts`` rule keeps that rule."""
    rules = dict(route.get("rules") or {}) if isinstance(route.get("rules"), Mapping) else {}
    value_map = route.get("valueMap")
    if isinstance(value_map, Mapping) and value_map:
        accepts = dict(rules.get("accepts") or {})
        for key, mapped in value_map.items():
            if key not in accepts and isinstance(mapped, Mapping):
                accepts[str(key)] = {"values": list(mapped)}
        rules["accepts"] = accepts
    return rules


def route_block(definition: Mapping[str, Any], route: Mapping[str, Any] | None,
                params: Mapping[str, Any] | None) -> DirectBlock | None:
    """Why ``route`` can't take a run with these params, or None when it can:
    :func:`direct_block`'s rules read from the route's ``rules`` (plus what
    its ``valueMap`` implies, and the ``ports`` rule). For a dual-route
    node's computed maker route (routes_of) it is direct_block, and its copy
    routes have no rules. ``params`` are routed as for direct_block
    (with_wired_blockers)."""
    if route is None:
        return None
    return _rules_block(definition, params or {}, _route_rules(route))


def _rule_sets(definition: Mapping[str, Any]) -> list[Mapping[str, Any]]:
    if has_routes(definition):
        return [_route_rules(route) for route in routes_of(definition)]
    spec = definition.get("directRoute")
    return [spec] if isinstance(spec, Mapping) else []


def wired_rule_params(definition: Mapping[str, Any]) -> set[str]:
    """The params a rule counts as set when they arrive by wire: ``blockedBy``
    and every ``rejectsWhen`` entry matching ``"(set)"`` or ``"(unset)"`` (a
    wired port isn't unset). On a route-table node, over every route, and
    its ``endpointWhen`` entries too (fal's edit endpoint when images are
    wired)."""
    named: set[str] = set()
    for spec in _rule_sets(definition):
        named |= {str(key) for key in spec.get("blockedBy") or []}
        for rule in spec.get("rejectsWhen") or []:
            match = rule.get("match") if isinstance(rule, Mapping) else None
            entries = match.items() if isinstance(match, Mapping) else []
            named |= {str(key) for key, want in entries if want in (SET, NOT_SET)}
    for route in routes_of(definition) if has_routes(definition) else []:
        for option in route.get("endpointWhen") or []:
            when = option.get("when") if isinstance(option, Mapping) else None
            entries = when.items() if isinstance(when, Mapping) else []
            named |= {str(key) for key, want in entries if want in (SET, NOT_SET)}
    return named


def counted_ports(definition: Mapping[str, Any]) -> set[str]:
    """The ports a route's ``ports`` rule counts (route-table nodes only)."""
    return {str(port) for rules in (_rule_sets(definition) if has_routes(definition) else [])
            for port in (rules.get("ports") or {})}


# Where with_wired_blockers puts the wired-input counts the ``ports`` rule
# reads. Not a param name a definition can have, so it never reaches a
# provider: the router only sends a route's own params.
PORT_COUNTS = "(wired ports)"


def with_wired_blockers(
    definition: Mapping[str, Any], params: Mapping[str, Any] | None, wired: Any,
) -> dict[str, Any]:
    """``params`` plus a WIRED marker for each param a rule reads as set
    (wired_rule_params) that arrives on a wired input port, so
    :func:`direct_block` treats it as the saved param. ``wired`` are the
    input ports with a value (the router and the cache key, filled_ports) or
    with an edge into them (the run estimate, before any value exists).
    Other params are unchanged.

    ``wired`` may also map each port to how many inputs it carries
    (filled_counts); a route-table node with a ``ports`` rule then gets those
    counts under PORT_COUNTS. A plain set counts one per port."""
    values = dict(params or {})
    counts = ({str(port): int(count) for port, count in wired.items()} if isinstance(wired, Mapping)
              else {str(port): 1 for port in (wired or ())})
    for key in wired_rule_params(definition):
        if key in counts and not _has_value(values.get(key)):
            values[key] = WIRED
    counted = counted_ports(definition)
    if counted:
        values[PORT_COUNTS] = {port: count for port, count in counts.items() if port in counted and count > 0}
    return values


def filled_ports(inputs: Mapping[str, Any] | None) -> set[str]:
    """The input ports of a run that carry a value (PortValueDict-like objects
    with ``.value``), as the router and the engine's cache key read wired
    blockers: the same set in both, so the cache key names the route that ran."""
    return set(filled_counts(inputs))


def filled_counts(inputs: Mapping[str, Any] | None) -> dict[str, int]:
    """filled_ports with how many values each carries (a list port counts its
    items), for the ``ports`` rule in the router and the cache key."""
    filled: dict[str, int] = {}
    for port, item in (inputs or {}).items():
        value = getattr(item, "value", None)
        if value is not None and value != "" and value != []:
            filled[str(port)] = len(value) if isinstance(value, list) else 1
    return filled


def _effective(definition: Mapping[str, Any], params: Mapping[str, Any], key: str) -> Any:
    """A param's value as a run reads it: the saved value, else the definition default."""
    if _has_value(params.get(key)):
        return params[key]
    param = param_definition(definition, key)
    return param.get("default") if param is not None else None


def direct_allowed(definition: Mapping[str, Any], params: Mapping[str, Any] | None) -> bool:
    return direct_block(definition, params) is None


def provider_choice(params: Mapping[str, Any] | None) -> str:
    """The saved ``_provider``: a route id, or "auto" when it isn't set."""
    value = (params or {}).get(PROVIDER_PARAM)
    return AUTO if value is None or value == "" else str(value)


def _krea_mode(params: Mapping[str, Any]) -> str:
    return str(params.get("_kreaAuth") or "api-token")


def _takes_plan(route: Mapping[str, Any], params: Mapping[str, Any]) -> bool:
    """A Krea route billed to the plan for this run: plan-only, or the plan
    picked (``_kreaAuth`` "mcp")."""
    plan = route.get("plan")
    return plan == "only" or (plan == "optional" and _krea_mode(params) == "mcp")


def _plan_route(definition: Mapping[str, Any], params: Mapping[str, Any]) -> RouteSpec | None:
    """The Krea route a route-table run bills to the plan, before its rules
    are checked: the chosen route (select_route 4a), or under Auto the maker
    route when it is Krea's (5a). A plan on another maker's node is used only
    when the person picks that Krea row, never by the global default."""
    choice = provider_choice(params)
    route = maker_route(definition) if choice == AUTO else route_by_id(definition, choice)
    if route is not None and route.get("plan") and _takes_plan(route, params):
        return route
    return None


def _set_keys(route: Mapping[str, Any], api_keys: Mapping[str, Any]) -> list[str]:
    return [key for key in keys(route.get("keys")) if _is_set(api_keys, key)]


def _union_keys(definition: Mapping[str, Any]) -> tuple[str, ...]:
    return tuple(dict.fromkeys(key for route in routes_of(definition) for key in keys(route.get("keys"))))


def _keyed(route: Mapping[str, Any], api_keys: Mapping[str, Any]) -> Route:
    """A route that can take the run, with the first of its keys that is set."""
    kind = DIRECT if route.get("maker") else FALLBACK
    return Route(kind, route.get("provider"), _set_keys(route, api_keys)[0], route.get("id"))


def _select_from_routes(
    definition: Mapping[str, Any], params: Mapping[str, Any], api_keys: Mapping[str, Any],
) -> Route:
    """select_route for a route-table node (precedence 3-5 in its docstring)."""
    routes = routes_of(definition)
    first = routes[0].get("provider") if routes else definition.get("apiProvider")
    choice = provider_choice(params)
    plan = _plan_route(definition, params)
    if plan is not None:
        block = route_block(definition, plan, params)
        if block is not None:
            return Route(UNSET, plan.get("provider"), None, plan.get("id"), block)
        return Route(PLAN, "krea", None, plan.get("id"))
    if choice != AUTO:
        route = route_by_id(definition, choice)
        if route is None:
            return Route(UNSET, first, None, None, DirectBlock(UNKNOWN_PROVIDER, PROVIDER_PARAM, None, choice))
        if not _set_keys(route, api_keys):
            return Route(UNSET, route.get("provider"), None, route.get("id"), None, tuple(keys(route.get("keys"))))
        block = route_block(definition, route, params)
        if block is not None:
            return Route(UNSET, route.get("provider"), None, route.get("id"), block)
        return _keyed(route, api_keys)
    route = next((r for r in routes if r.get("plan") != "only" and _set_keys(r, api_keys)), None)
    if route is None:
        return Route(UNSET, first, None, None, None, _union_keys(definition))
    block = route_block(definition, route, params)
    if block is not None:
        # Auto never moves on: who bills depends on the choice and the keys,
        # not on a param (route_unavailable lists the routes that can take it).
        return Route(UNSET, route.get("provider"), None, route.get("id"), block)
    return _keyed(route, api_keys)


def select_route(
    definition: Mapping[str, Any], params: Mapping[str, Any] | None, api_keys: Mapping[str, Any],
) -> Route:
    """The route a run of this node takes with these params and keys.

    1. A utility node runs locally.
    2. A node without ``routes``: the rule in this module's docstring
       (``_provider`` is ignored).
    3. A route-table node reads ``_provider`` ("auto" when unset); a value
       that isn't a route id is UNSET with an UNKNOWN_PROVIDER block.
    4. A chosen route: its Krea plan when it bills the plan (UNSET if its
       rules block the run), else UNSET with ``missing`` when none of its keys
       is set, else UNSET with the ``block`` its rules give, else that route.
    5. Auto: the Krea plan on a Krea-maker node when picked (as 4); else the
       first route, in table order, with a key set (plan-only routes are
       skipped); UNSET with every key ``missing`` when none is; UNSET with
       the ``block`` when that route can't take the run. Auto never moves on
       to another provider because of a param."""
    provider = definition.get("apiProvider")
    if provider == "utility":
        return Route(LOCAL, None, None)
    if has_routes(definition):
        return _select_from_routes(definition, params or {}, api_keys)
    if uses_krea_plan(definition, params):
        return Route(PLAN, "krea", None)
    env = env_keys(definition)
    if len(env) < 2:
        return Route(ONLY, provider, env[0] if env else None)
    if direct_allowed(definition, params):
        key = next((k for k in direct_keys(definition) if _is_set(api_keys, k)), None)
        if key:
            return Route(DIRECT, KEY_PROVIDERS.get(key, provider), key)
    key = next((k for k in fallback_keys(definition) if _is_set(api_keys, k)), None)
    if key:
        return Route(FALLBACK, KEY_PROVIDERS.get(key, provider), key)
    return Route(UNSET, provider, None)


def route_param_keys(definition: Mapping[str, Any], route: str | None) -> set[str]:
    """The params a route may send: sharedParams plus that route's own group.

    ``route`` is a route kind (DIRECT, FALLBACK, ...) or, for a route-table
    node, a route id (Route.route_id): its ``sharedParams`` plus that route's
    ``params``. ``_provider`` and ``_kreaAuth`` live in ``params`` and are
    never sent (the Krea client gets the billing mode explicitly).

    The graph stores defaults for every route of a dual-route node, so each
    route must drop the others' params (a direct-only default reaching fal is
    a billed 422; Krea refuses unknown fields)."""
    if has_routes(definition):
        spec = route_by_id(definition, route)
        groups = [definition.get("sharedParams") or [], (spec or {}).get("params") or []]
        return {str(p.get("key")) for group in groups for p in group if isinstance(p, Mapping) and p.get("key")}
    if not definition.get("sharedParams") and not definition.get("directParams"):
        return {str(p.get("key")) for p in definition.get("params") or [] if isinstance(p, Mapping)}
    maker = maker_route(definition) if route not in (DIRECT, FALLBACK, PLAN, ONLY, UNSET, LOCAL) else None
    direct = route == DIRECT or (maker is not None and route == maker.get("id"))
    group = "directParams" if direct else "falParams"
    return {str(p.get("key")) for name in ("sharedParams", group)
            for p in definition.get(name) or [] if isinstance(p, Mapping) and p.get("key")}


def cache_tag(
    definition: Mapping[str, Any], params: Mapping[str, Any] | None, api_keys: Mapping[str, Any],
) -> str | None:
    """What the execution cache key adds for a multi-route node, so a result
    from one route is never reused once the run would take another (adding a
    maker key must not replay a fal or Krea result). None for single-route
    nodes, whose keys stay as they were. A route-table node names its route
    id ("fallback:fal"); every other node keeps "kind:provider"."""
    if has_routes(definition):
        route = select_route(definition, params, api_keys)
        return f"{route.kind}:{route.route_id or route.provider or ''}"
    if not is_multi_route(definition):
        return None
    route = select_route(definition, params, api_keys)
    return f"{route.kind}:{route.provider or ''}"


def route_endpoint(definition: Mapping[str, Any], route: Mapping[str, Any], params: Mapping[str, Any] | None) -> Any:
    """The provider model or path a run on ``route`` calls: the first
    ``endpointWhen`` entry whose ``when`` matches (the rejectsWhen grammar:
    a value, or "(set)"/"(unset)" for a saved or wired param), else
    ``endpoint``."""
    values = params or {}
    for option in route.get("endpointWhen") or []:
        when = option.get("when") if isinstance(option, Mapping) else None
        if isinstance(when, Mapping) and when and all(
                _matches(definition, values, str(key), want) for key, want in when.items()):
            return option.get("endpoint")
    return route.get("endpoint")


def block_dict(block: DirectBlock | None) -> dict[str, Any] | None:
    """A block as JSON (its non-None fields), as route_cases.json and the
    agent surfaces spell it."""
    return None if block is None else {k: v for k, v in block._asdict().items() if v is not None}


def provider_label(provider: Any) -> str:
    return PROVIDER_LABELS.get(str(provider or ""), str(provider or "provider"))


def _or_list(items: Iterable[str]) -> str:
    listed = list(items)
    return listed[0] if len(listed) == 1 else f"{', '.join(listed[:-1])} or {listed[-1]}"


def _why(route: Mapping[str, Any], block: DirectBlock) -> str:
    if block.reason == UNSUPPORTED:
        return f"it doesn't take {block.detail}"
    if block.reason == BLOCKED:
        return f"it doesn't take {block.param}"
    if block.reason == REQUIRES:
        return f"it needs {block.param} set"
    if block.reason == SIZE:
        return f"it can't render that {block.param} exactly"
    if block.reason == RETIRED:
        return f"the maker retired this model on {block.on}"
    if block.reason == PORTS:
        limit = ((route.get("rules") or {}).get("ports") or {}).get(block.param) or {}
        if not limit.get("max"):
            return f"it doesn't take wired {block.param}"
        return f"it takes at most {limit.get('max')} wired {block.param}"
    return str(block.detail or block.reason)


def _accepted_values(route: Mapping[str, Any], block: DirectBlock) -> list[str]:
    """The values a route takes for the param that blocked it, when its rule lists them."""
    if block.reason != UNSUPPORTED or not block.param:
        return []
    rule = (_route_rules(route).get("accepts") or {}).get(block.param)
    return [match_value(v) for v in rule.get("values") or []] if isinstance(rule, Mapping) else []


def route_unavailable_message(
    definition: Mapping[str, Any], route: Route, alternatives: Iterable[str] = (),
) -> str:
    """Why a route-table run can't start, in the words the router, the
    engine's preflight, the estimate and the switcher all use
    (directRoute.ts routeUnavailableMessage is the same)."""
    name = str(definition.get("displayName") or definition.get("id") or "This node")
    spec = route_by_id(definition, route.route_id) if route.route_id else None
    others = [provider_label((route_by_id(definition, alt) or {}).get("provider")) for alt in alternatives]
    also = f" {_or_list(others)} can take it." if others else ""
    block = route.block
    if block is not None and block.reason == UNKNOWN_PROVIDER:
        ids = [AUTO] + [str(r.get("id")) for r in routes_of(definition)]
        return f"{name} is set to provider '{block.detail}', which it doesn't have. Choose {_or_list(ids)}."
    if block is not None and spec is not None:
        values = _accepted_values(spec, block)
        fix = (f"Pick {_or_list(values)}, or switch provider." if values
               else "Disconnect the extra inputs, or switch provider." if block.reason == PORTS
               else "Change that setting, or switch provider.")
        return f"{name} can't run on {provider_label(spec.get('provider'))}: {_why(spec, block)}. {fix}{also}"
    needed = _or_list(route.missing) if route.missing else "a provider key"
    if spec is not None:
        return (f"{name} is set to {provider_label(spec.get('provider'))}, which needs {needed}. "
                f"Add it in Settings > Providers or choose another provider.{also}")
    return f"{name} needs {needed} in Settings > Providers."


def route_unavailable(
    definition: Mapping[str, Any], params: Mapping[str, Any] | None, api_keys: Mapping[str, Any],
) -> dict[str, Any] | None:
    """Why a route-table node can't run with these params and keys, or None
    when it can (and for every node without ``routes``):
    {routeId, missing, block, alternatives, message}. ``alternatives`` are
    the other routes with a key set that can take the run, the one-click
    switches the switcher offers; Auto never takes one by itself. ``params``
    are routed (with_wired_blockers). directRoute.ts routeUnavailable is the same."""
    if not has_routes(definition):
        return None
    values = params or {}
    route = select_route(definition, values, api_keys)
    if route.kind != UNSET:
        return None
    alternatives = [str(r.get("id")) for r in routes_of(definition)
                    if r.get("id") != route.route_id and r.get("plan") != "only" and _set_keys(r, api_keys)
                    and route_block(definition, r, values) is None]
    return {
        "routeId": route.route_id,
        "missing": list(route.missing),
        "block": block_dict(route.block),
        "alternatives": alternatives,
        "message": route_unavailable_message(definition, route, alternatives),
    }


# -- the routes contract --------------------------------------------------------

# The clients a route can name (execution/route_clients.py ROUTE_CLIENTS).
ROUTE_HANDLERS = ("bfl", "fal", "replicate-model", "openrouter-images", "openrouter-videos", "krea")
_ROUTE_FIELDS = {"id", "provider", "maker", "keys", "plan", "handler", "endpoint", "endpointWhen", "params",
                 "rename", "valueMap", "rules", "pricing", "note"}
_ROUTE_RULE_KEYS = set(_RULE_KEYS) | {"ports"}


def routes_problems(definition: Mapping[str, Any]) -> list[str]:
    """Everything a route-table definition gets wrong, as readable strings
    (empty for a sound one, and for every node without ``routes``).
    tests/test_node_contracts.py runs it over the registry, and
    scripts/check-node-contracts.mjs validateRoutes is the same check.

    The rules keep the key-based readers right (``nebula keys``, the
    definition-level readiness, Settings counts): ``envKeyName`` is the
    ordered union of the routes' keys, and ``directKeyName`` is the maker
    route's keys. ``directParams``, ``falParams`` and ``directRoute`` don't
    sit next to ``routes``. ``params`` holds only the billing params, so the
    router (which sends ``sharedParams`` plus the route's own) never sends
    them; a route's own param defined on two routes must be identical."""
    if "routes" not in definition:
        return []
    node_id = str(definition.get("id") or "?")
    routes = definition.get("routes")
    if not isinstance(routes, list) or not routes:
        return [f"{node_id}.routes must be a non-empty list"]
    problems = [f"{node_id}.{field} can't sit next to routes"
                for field in ("directParams", "falParams", "directRoute") if field in definition]
    ids: list[str] = []
    own: dict[str, Mapping[str, Any]] = {}
    shared = {str(p.get("key")) for p in definition.get("sharedParams") or [] if isinstance(p, Mapping)}
    for index, route in enumerate(routes):
        where = f"{node_id}.routes[{index}]"
        if not isinstance(route, Mapping):
            problems.append(f"{where} must be an object")
            continue
        stray = sorted(set(route) - _ROUTE_FIELDS)
        if stray:
            problems.append(f"{where} has unknown fields {stray}")
        route_id = route.get("id")
        if not isinstance(route_id, str) or not route_id:
            problems.append(f"{where} needs an id")
        elif route_id == AUTO:
            problems.append(f"{where} id 'auto' is the Auto choice, not a route")
        elif route_id in ids:
            problems.append(f"{node_id} has duplicate route id {route_id}")
        ids.append(str(route_id))
        route_keys = route.get("keys")
        if not isinstance(route_keys, list) or not all(isinstance(k, str) and k for k in route_keys):
            problems.append(f"{where}.keys must be a list of key names")
            route_keys = []
        plan = route.get("plan")
        if plan not in (None, "optional", "only"):
            problems.append(f"{where}.plan must be 'optional' or 'only'")
        if plan and route.get("provider") != "krea":
            problems.append(f"{where} only a Krea route can bill the plan")
        if plan != "only" and not route_keys:
            problems.append(f"{where} needs keys (only a plan-only route runs without one)")
        if route_keys and KEY_PROVIDERS.get(route_keys[0]) != route.get("provider"):
            problems.append(f"{where}.provider must be {KEY_PROVIDERS.get(route_keys[0])!r}, who bills {route_keys[0]}")
        if route.get("handler") not in ROUTE_HANDLERS:
            problems.append(f"{where}.handler must be one of {', '.join(ROUTE_HANDLERS)}")
        if route.get("maker") not in (None, True):
            problems.append(f"{where}.maker must be true or left out")
        if route.get("maker") and index != 0:
            problems.append(f"{where} only routes[0] may be the maker")
        rules = route.get("rules")
        if rules is not None and not isinstance(rules, Mapping):
            problems.append(f"{where}.rules must be an object")
        elif isinstance(rules, Mapping):
            unknown = sorted(set(rules) - _ROUTE_RULE_KEYS)
            if unknown:
                problems.append(f"{where}.rules has unknown rules {unknown}")
            for port, limit in (rules.get("ports") or {}).items():
                most = limit.get("max") if isinstance(limit, Mapping) else None
                if isinstance(most, bool) or not isinstance(most, int) or most < 0:
                    problems.append(f"{where}.rules.ports.{port}.max must be a whole number of inputs")
        for param in route.get("params") or []:
            key = str(param.get("key")) if isinstance(param, Mapping) else "?"
            if key in BILLING_PARAMS:
                problems.append(f"{where}.params: {key} must sit in params, never in a route")
            elif key in shared:
                problems.append(f"{where}.params: {key} is both shared and this route's own")
            elif key in own and own[key] != param:
                problems.append(f"{where}.params: {key} differs from another route's; use a route-prefixed key "
                                "and rename")
            own.setdefault(key, param)
        for field in ("rename", "valueMap"):
            for key in (route.get(field) or {}):
                route_params = {str(p.get("key")) for p in route.get("params") or [] if isinstance(p, Mapping)}
                if key not in shared | route_params:
                    problems.append(f"{where}.{field} names {key}, which isn't one of its params")
    union = list(dict.fromkeys(key for route in routes if isinstance(route, Mapping)
                               for key in keys(route.get("keys"))))
    if env_keys(definition) != union:
        problems.append(f"{node_id}.envKeyName must be {union}, the routes' keys in order")
    first = routes[0] if isinstance(routes[0], Mapping) else {}
    if first.get("maker") and direct_keys(definition) != keys(first.get("keys")):
        problems.append(f"{node_id}.directKeyName must be the maker route's keys {keys(first.get('keys'))}")
    if not first.get("maker") and direct_keys(definition):
        problems.append(f"{node_id}.directKeyName is only for a node whose routes[0] is the maker")
    for param in definition.get("sharedParams") or []:
        if isinstance(param, Mapping) and param.get("key") in BILLING_PARAMS:
            problems.append(f"{node_id}.sharedParams: {param.get('key')} must sit in params")
    top = {str(p.get("key")): p for p in definition.get("params") or [] if isinstance(p, Mapping)}
    for key in sorted(set(top) - set(BILLING_PARAMS)):
        problems.append(f"{node_id}.params: {key} belongs in sharedParams or a route (params holds only "
                        f"{', '.join(BILLING_PARAMS)})")
    choice = top.get(PROVIDER_PARAM)
    if choice is None:
        problems.append(f"{node_id}: {PROVIDER_PARAM} must sit in params")
    else:
        values = [o.get("value") if isinstance(o, Mapping) else o for o in choice.get("options") or []]
        if values != [AUTO, *ids]:
            problems.append(f"{node_id}.{PROVIDER_PARAM} options must be {[AUTO, *ids]}")
        if choice.get("default") != AUTO or not choice.get("hidden"):
            problems.append(f"{node_id}.{PROVIDER_PARAM} must default to 'auto' and be hidden (the switcher shows it)")
    plans = any(isinstance(route, Mapping) and route.get("plan") for route in routes)
    if plans and "_kreaAuth" not in top:
        problems.append(f"{node_id}: a Krea route that bills the plan needs _kreaAuth in params")
    if not plans and "_kreaAuth" in top and definition.get("apiProvider") != "krea":
        problems.append(f"{node_id}._kreaAuth is only for a node with a Krea plan route")
    return problems
