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
import re
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
    # A Hugging Face access token, for a maker's Space route (handler
    # hf-space: Idol's needs it; a keyless one lists it in ``optionalKeys``).
    # It gives the run the person's own ZeroGPU quota, which Hugging Face may
    # bill PRO accounts for past it (https://huggingface.co/docs/hub/spaces-zerogpu).
    "HF_TOKEN": "huggingface",
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
    "speridlabs": "Speridlabs", "huggingface": "Hugging Face",
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
HIDDEN = "hidden"            # a saved value of a setting this route doesn't show, that another route honors (rule H)
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
    - ``optionalKeys``: a route that runs with no key at all (a maker's free
      Hugging Face Space). The keys listed here are used when set (the
      person's own quota) but never needed, and stay out of ``envKeyName``,
      so the node reads as free, not as missing a key. ``keys`` is then [].
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
      the route takes on a wired port. An entry with ``of`` caps several
      ports together (``{"frames": {"max": 10, "of": ["start_image",
      "keyframes", "end_image"], "label": "images (...)"}}``): its key names
      the group, ``label`` is how messages name it (port_limit_count).
    - ``paramVisibleWhen``: which settings this route offers, by param key:
      ``false`` (never: the param leaves the route's list) or
      ``{controller: [values]}`` (only while every controller holds one of
      the values), ANDed with the param's own ``visibleWhen``
      (route_param_definitions merges them). A setting a route doesn't
      show is never sent (route_sent_keys); a saved non-default value of it
      stops the run only when another route would honor it (hidden_block,
      rule H in docs/PROVIDER-ROUTES.md).
    - ``pricing``: its key under model_pricing.json ``routes`` (default id).
    - ``note``: readiness copy for this route.
    - ``mayBillWithKey``: a keyless route whose run, with one of its
      ``optionalKeys`` set, can bill the key owner's account past a free
      allowance (Idol: a Hugging Face PRO, Team or Enterprise account's
      prepaid credits past its daily ZeroGPU time). Its price stays the
      sourced one (Nebula bills nothing); an agent can't start such a run
      itself and must propose it (agent_spend.may_bill_nodes).

    Nodes without ``routes`` get computed specs from :func:`routes_of`,
    whose ``rules`` also carry ``requires`` (DIRECT_REQUIRES) and
    ``retires`` (DIRECT_RETIRES)."""
    id: str
    provider: str
    maker: bool
    keys: list[str]
    optionalKeys: list[str]
    plan: str
    handler: str
    endpoint: str
    endpointWhen: list[dict[str, Any]]
    params: list[dict[str, Any]]
    rename: dict[str, str]
    valueMap: dict[str, dict[str, Any]]
    rules: dict[str, Any]
    paramVisibleWhen: dict[str, Any]
    pricing: str
    note: str
    missingKeyLine: str
    mayBillWithKey: bool


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


# What a pasted key can carry at its ends that is no part of it: whitespace,
# a byte-order mark, zero-width spaces and joiners. The same characters, by
# code point, as frontend directRoute KEY_EDGE (Python's str.strip and JS's
# String.trim differ: JS strips a BOM, Python doesn't; neither strips a
# zero-width space). Review 7 of PR #203, NIT-4.
KEY_EDGE = ("\t\n\v\f\r \u0085\u00a0\u1680\u2000\u2001\u2002\u2003\u2004\u2005\u2006\u2007"
            "\u2008\u2009\u200a\u2028\u2029\u202f\u205f\u3000\u200b\u200c\u200d\u2060\ufeff")


def key_text(value: Any) -> str:
    """A key as Nebula reads it: the text without KEY_EDGE characters at
    either end, "" when nothing is left (or it isn't text). Whether a key
    is set is whether this is non-empty, for every surface: the agent spend
    gate (may_bill, key_billing), the run's handler (an Idol token,
    handlers/speridlabs_idol.clean_token), describe_node's ``set`` and
    Settings (frontend directRoute keyText, its twin; both read
    tests/fixtures/key_text_cases.json)."""
    return value.strip(KEY_EDGE) if isinstance(value, str) else ""


def key_set(api_keys: Mapping[str, Any], key: str) -> bool:
    """Whether ``key`` is set in ``api_keys`` (key_text non-empty)."""
    return bool(key_text(api_keys.get(key)))


def _is_set(api_keys: Mapping[str, Any], key: str) -> bool:
    return key_set(api_keys, key)


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
    # RETIRED: the shutdown date. HIDDEN: the route that would honor the value.
    on: str | None = None
    # UNSUPPORTED: what the maker doesn't take, for readiness and errors: the
    # param and its value ("resolution 4K"), or a rejectsWhen rule's label.
    # HIDDEN: the setting and its value as the card shows them ("Safety 5").
    detail: str | None = None
    # HIDDEN: the settings that hide it on this route, as the card shows them
    # ("Model FLUX.2 [klein] 9B"); None when the route never offers it.
    when: str | None = None


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
        count = port_limit_count(port, limit, counts)
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
    its ``valueMap`` implies, and the ``ports`` rule), then, on a
    route-table node, :func:`hidden_block` (rule H), so a rule's own reason
    always wins. For a dual-route
    node's computed maker route (routes_of) it is direct_block, and its copy
    routes have no rules. ``params`` are routed as for direct_block
    (with_wired_blockers)."""
    if route is None:
        return None
    values = params or {}
    if not has_routes(definition) or route.get("id") is None:
        return _rules_block(definition, values, _route_rules(route))
    return _shown_rules_block(definition, route, values) or hidden_block(definition, route, values)


def _shown_rules_block(definition: Mapping[str, Any], route: Mapping[str, Any], values: Mapping[str, Any]) -> DirectBlock | None:
    """A route-table route's rules over the values it would send: a setting
    in its list that it hides with these values (route_sent_keys) is read at
    its default, since it is never sent. A hidden 4K under Draft on
    Replicate is then no stop; hidden_block decides what such a value does."""
    listed = route_param_keys(definition, route.get("id"))
    hidden = listed - route_sent_keys(definition, route.get("id"), values)
    shown = {key: value for key, value in values.items() if key not in hidden} if hidden else values
    return _rules_block(definition, shown, _route_rules(route))


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


def _limit_ports(port: Any, limit: Any) -> list[str]:
    """The input ports one ``ports`` entry counts: its ``of`` list for a
    group, else the port it is keyed by."""
    group = limit.get("of") if isinstance(limit, Mapping) else None
    return [str(item) for item in group] if isinstance(group, list) else [str(port)]


def port_limit_count(port: Any, limit: Any, counts: Any) -> int:
    """How many inputs one ``ports`` entry counts: the sum over its ports.
    FLUX 3 Video's providers take at most ten images in all, start image,
    keyframes and end image together, so that cap is a group."""
    if not isinstance(counts, Mapping):
        return 0
    return sum(int(counts.get(name, 0) or 0) for name in _limit_ports(port, limit))


def port_limit_name(port: Any, limit: Any) -> str:
    """How a message names one ``ports`` entry: its ``label``, else its key."""
    label = limit.get("label") if isinstance(limit, Mapping) else None
    return str(label) if isinstance(label, str) and label else str(port)


def counted_ports(definition: Mapping[str, Any]) -> set[str]:
    """The ports a route's ``ports`` rule counts (route-table nodes only)."""
    return {name for rules in (_rule_sets(definition) if has_routes(definition) else [])
            for port, limit in (rules.get("ports") or {}).items() for name in _limit_ports(port, limit)}


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
    counts under PORT_COUNTS. A plain set counts one per port. The router
    and the cache key count items (a list counts its length), which is what
    the provider receives; the preflight, the estimate and the switcher
    count edges, all that is known before upstream nodes run, so they can
    only under-count."""
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


def is_keyless(route: Mapping[str, Any]) -> bool:
    """A route that runs without any key (``optionalKeys`` declared)."""
    return isinstance(route.get("optionalKeys"), list)


def _can_run_keyed(route: Mapping[str, Any], api_keys: Mapping[str, Any]) -> bool:
    """The route's key condition holds: one of its keys is set, or it needs none."""
    return is_keyless(route) or bool(_set_keys(route, api_keys))


def route_key(route: Mapping[str, Any], api_keys: Mapping[str, Any]) -> str | None:
    """The key a run on this route uses: the first of its keys that is set,
    else the first of its optional keys that is set, else None (a keyless
    route run anonymously)."""
    for key in [*keys(route.get("keys")), *keys(route.get("optionalKeys"))]:
        if _is_set(api_keys, key):
            return key
    return None


# key_billing's two classes, as the cost entries and the canvas name them.
MAY_COST = "mayCost"
FREE_WITHOUT_KEY = "free"


def may_bill(definition: Mapping[str, Any] | None, params: Mapping[str, Any] | None,
             api_keys: Mapping[str, Any]) -> bool:
    """Whether a run of this node with these params and keys can bill the key
    owner's own provider account: key_billing's "mayCost", the one cost class
    every surface reads (GM, PR #203 r15 item 2; review 8, LOW-3). Its list
    price is unchanged."""
    return key_billing(definition, params, api_keys) == MAY_COST


def key_billing(definition: Mapping[str, Any] | None, params: Mapping[str, Any] | None,
                api_keys: Mapping[str, Any]) -> str | None:
    """How a run on a ``mayBillWithKey`` route is counted (GM, PR #203 r11
    and r12): "mayCost" with one of its optional keys set (may_bill), "free"
    without one. None for any other route or node: it is counted as before
    (paid when it calls a provider). Never "paid": such a route has no list
    price beyond its sourced $0. frontend directRoute.keyBilling is the twin."""
    if not definition or not has_routes(definition):
        return None
    route = select_route(definition, params, api_keys)
    spec = route_by_id(definition, route.route_id) if route.route_id else None
    if not spec or spec.get("mayBillWithKey") is not True:
        return None
    return MAY_COST if route.key and route.key in keys(spec.get("optionalKeys")) else FREE_WITHOUT_KEY


def key_billing_account(definition: Mapping[str, Any] | None, params: Mapping[str, Any] | None,
                        api_keys: Mapping[str, Any]) -> str | None:
    """The account a key-billing run (key_billing not None) runs on and may
    bill, as every surface names it ("Hugging Face"): a Space route's host,
    else its provider's PROVIDER_LABELS name. None for any other node.
    frontend directRoute.keyBillingAccount is the twin, from the same table
    (tests/fixtures/key_billing_cases.json pins both)."""
    host = key_billing_host(definition, params, api_keys)
    return None if host is None else PROVIDER_LABELS.get(host, host or "provider")


def key_billing_host(definition: Mapping[str, Any] | None, params: Mapping[str, Any] | None,
                     api_keys: Mapping[str, Any]) -> str | None:
    """Where a key-billing run runs, as a provider id: "huggingface" for a
    Space route, else its route's provider. The CLI tags a free run with it,
    in the paid part's id style ("1 paid run (openai) and 1 free
    (huggingface)"; GM, PR #203 r24 item 1), and key_billing_account names
    it. None for any other node."""
    if key_billing(definition, params, api_keys) is None:
        return None
    route = select_route(definition or {}, params, api_keys)
    spec = route_by_id(definition or {}, route.route_id) if route.route_id else None
    if spec and spec.get("handler") == "hf-space":
        return "huggingface"
    return str(route.provider or "")


def key_billing_label(cost_class: str, account: str) -> str:
    """A key-billing node's cost label, by the ghost-card convention ("free ·
    runs locally"): "may cost · Hugging Face" or "free · Hugging Face" (GM,
    PR #203 r15 item 1). frontend directRoute.keyBillingLabel is the twin."""
    return f"{'may cost' if cost_class == MAY_COST else 'free'} · {account}"


def _union_keys(definition: Mapping[str, Any]) -> tuple[str, ...]:
    return tuple(dict.fromkeys(key for route in routes_of(definition) for key in keys(route.get("keys"))))


def _keyed(route: Mapping[str, Any], api_keys: Mapping[str, Any]) -> Route:
    """A route that can take the run, with the first of its keys that is set."""
    kind = DIRECT if route.get("maker") else FALLBACK
    return Route(kind, route.get("provider"), route_key(route, api_keys), route.get("id"))


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
        if not _can_run_keyed(route, api_keys):
            return Route(UNSET, route.get("provider"), None, route.get("id"), None, tuple(keys(route.get("keys"))))
        block = route_block(definition, route, params)
        if block is not None:
            return Route(UNSET, route.get("provider"), None, route.get("id"), block)
        return _keyed(route, api_keys)
    route = next((r for r in routes if r.get("plan") != "only" and _can_run_keyed(r, api_keys)), None)
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
    ``params``, less any its ``paramVisibleWhen`` marks ``false``. Which of
    them a run sends also depends on the values (route_sent_keys).
    ``_provider`` and ``_kreaAuth`` live in ``params`` and are never sent
    (the Krea client gets the billing mode explicitly).

    The graph stores defaults for every route of a dual-route node, so each
    route must drop the others' params (a direct-only default reaching fal is
    a billed 422; Krea refuses unknown fields)."""
    if has_routes(definition):
        spec = route_by_id(definition, route)
        groups = [definition.get("sharedParams") or [], (spec or {}).get("params") or []]
        never = _never_offered(spec)
        return {str(p.get("key")) for group in groups for p in group
                if isinstance(p, Mapping) and p.get("key") and str(p.get("key")) not in never}
    if not definition.get("sharedParams") and not definition.get("directParams"):
        return {str(p.get("key")) for p in definition.get("params") or [] if isinstance(p, Mapping)}
    maker = maker_route(definition) if route not in (DIRECT, FALLBACK, PLAN, ONLY, UNSET, LOCAL) else None
    direct = route == DIRECT or (maker is not None and route == maker.get("id"))
    group = "directParams" if direct else "falParams"
    return {str(p.get("key")) for name in ("sharedParams", group)
            for p in definition.get(name) or [] if isinstance(p, Mapping) and p.get("key")}


def _narrowed(param: Mapping[str, Any], rules: Mapping[str, Any]) -> Mapping[str, Any]:
    """``param`` as one route offers it: an enum's options cut to the values
    the route takes (its ``accepts``, which a ``valueMap`` implies, and its
    ``rejects``), a number's ``min``/``max`` narrowed to the route's
    ``accepts`` range. A param the rules don't name comes back as it is.
    ``rejectsWhen`` combinations stay a run-time block: no single value is
    always refused."""
    key = str(param.get("key") or "")
    accepts = (rules.get("accepts") or {}).get(key) if isinstance(rules.get("accepts"), Mapping) else None
    refused = (rules.get("rejects") or {}).get(key) if isinstance(rules.get("rejects"), Mapping) else None
    accepts = accepts if isinstance(accepts, Mapping) else None
    refused = {match_value(value) for value in refused} if isinstance(refused, list) else None
    if accepts is None and refused is None:
        return param
    narrowed = dict(param)
    options = param.get("options")
    if isinstance(options, list) and options:
        def takes(option: Any) -> bool:
            value = option.get("value") if isinstance(option, Mapping) else option
            return ((accepts is None or value_accepted(value, accepts))
                    and (refused is None or match_value(value) not in refused))
        narrowed["options"] = [option for option in options if takes(option)]
    elif accepts is not None:
        if isinstance(accepts.get("min"), (int, float)) and not isinstance(accepts.get("min"), bool):
            low = param.get("min")
            narrowed["min"] = accepts["min"] if not isinstance(low, (int, float)) else max(low, accepts["min"])
        if isinstance(accepts.get("max"), (int, float)) and not isinstance(accepts.get("max"), bool):
            high = param.get("max")
            narrowed["max"] = accepts["max"] if not isinstance(high, (int, float)) else min(high, accepts["max"])
    return narrowed


def route_param_definitions(definition: Mapping[str, Any], route: str | None) -> list[Mapping[str, Any]]:
    """The params one route shows: :func:`route_param_keys`, as definitions.

    On a route-table node ``route`` is a route id: ``sharedParams`` plus
    that route's own ``params``, each as the route offers it (_narrowed: an
    enum cut to the values the route takes, a number range narrowed to the
    route's). Other routes' own params are left out, and so is a param the
    route's ``paramVisibleWhen`` marks ``false``; a condition there is
    merged into the param's own ``visibleWhen`` (merge_visible_when), so
    every reader hides it the same way (param_shown). The Inspector, Create's
    pills and describe_node read this list, so a provider switch changes
    which options can be picked. directRoute.ts routeParamDefinitions is the
    same rule (tests/fixtures/route_cases.json ``routeParams`` and
    route_tables.json pin both).

    Saved values stay flat in ``node.params``, so a save takes any value some
    route takes (main.py _valid_param_keys reads all_param_definitions), and
    route_block stays the run-time authority.

    For every other node ``route`` is a route kind or a computed route id
    (routes_of): ``params`` when the node declares no ``sharedParams``, else
    ``sharedParams`` plus ``directParams`` on the maker's route or
    ``falParams`` on any other, unchanged, a later definition of a key
    winning. That is the list directRoute.ts shows for a dual-route node
    (route_tables.json ``routeParams`` pins every multi-route node)."""
    if has_routes(definition):
        spec = route_by_id(definition, route)
        rules = _route_rules(spec) if spec is not None else {}
        groups = [definition.get("sharedParams") or [], (spec or {}).get("params") or []]
        conditions = route_visible_when(spec)
        by_key: dict[str, Mapping[str, Any]] = {}
        for group in groups:
            for param in group if isinstance(group, list) else []:
                if isinstance(param, Mapping) and param.get("key"):
                    key = str(param["key"])
                    condition = conditions.get(key)
                    if condition is False:
                        continue
                    offered = _narrowed(param, rules)
                    if isinstance(condition, Mapping):
                        offered = {**offered, "visibleWhen": merge_visible_when(offered.get("visibleWhen"), condition)}
                    by_key[key] = offered
        return list(by_key.values())
    if definition.get("sharedParams") is None:  # an empty list still picks a group, as in TS
        return [param for param in definition.get("params") or [] if isinstance(param, Mapping)]
    maker = maker_route(definition) if route not in (DIRECT, FALLBACK, PLAN, ONLY, UNSET, LOCAL) else None
    direct = route == DIRECT or (maker is not None and route == maker.get("id"))
    by_key: dict[str, Mapping[str, Any]] = {}
    for param in [*definition["sharedParams"], *(definition.get("directParams" if direct else "falParams") or [])]:
        if isinstance(param, Mapping) and param.get("key"):
            by_key[str(param["key"])] = param
    return list(by_key.values())


def route_visible_when(route: Mapping[str, Any] | None) -> dict[str, Any]:
    """A route's ``paramVisibleWhen`` (empty when it has none)."""
    value = (route or {}).get("paramVisibleWhen")
    return dict(value) if isinstance(value, Mapping) else {}


def _never_offered(route: Mapping[str, Any] | None) -> set[str]:
    return {str(key) for key, condition in route_visible_when(route).items() if condition is False}


def merge_visible_when(own: Any, route: Any) -> dict[str, list[Any]]:
    """A param's ``visibleWhen`` ANDed with a route's condition for it: the
    controllers unioned, and where both name one, the values both allow (in
    the param's order). directRoute.ts mergeVisibleWhen is the same."""
    merged: dict[str, list[Any]] = {str(k): list(v) for k, v in (own or {}).items()} if isinstance(own, Mapping) else {}
    for key, values in (route.items() if isinstance(route, Mapping) else []):
        values = list(values or [])
        if key in merged:
            allowed = {match_value(value) for value in values}
            merged[key] = [value for value in merged[key] if match_value(value) in allowed]
        else:
            merged[str(key)] = values
    return merged


def visible_when_holds(visible_when: Any, values: Mapping[str, Any], route_keys: Iterable[str] | None = None) -> bool:
    """Whether a ``visibleWhen`` holds for these values (saved over defaults,
    effective_values). A controller with no value passes, and on a
    route-table node (``route_keys`` given) so does a controller that only
    another route takes: it counts as absent whatever is still saved for it.
    Values compare by match_value. directRoute.ts visibleWhenHolds is the same."""
    if not isinstance(visible_when, Mapping):
        return True
    listed = set(route_keys) if route_keys is not None else None
    for key, allowed in visible_when.items():
        if listed is not None and key not in listed:
            continue
        value = values.get(key)
        if value is None:
            continue
        if match_value(value) not in {match_value(item) for item in allowed or []}:
            return False
    return True


def param_shown(param: Mapping[str, Any], values: Mapping[str, Any], route_keys: Iterable[str] | None = None) -> bool:
    """Whether a param is shown (and so sent) for these values: its
    ``visibleWhen`` (on a route-table node, merged with the route's
    ``paramVisibleWhen`` by route_param_definitions) holds. The one
    predicate the Inspector, Create's pills, route_sent_keys and rule H read
    (directRoute.ts paramShown). ``hidden`` (editor-managed) params are a
    separate matter: they are sent, never edited."""
    return visible_when_holds(param.get("visibleWhen"), values, route_keys)


def effective_values(definition: Mapping[str, Any], params: Mapping[str, Any] | None) -> dict[str, Any]:
    """``params`` with every unset param (None, "" or blank) at its default,
    as a run reads them (_effective). Other keys (wired markers) are kept."""
    values = dict(params or {})
    for param in all_param_definitions(definition):
        key = str(param.get("key"))
        if not _has_value(values.get(key)) and param.get("default") is not None:
            values[key] = param["default"]
    return values


def route_sent_keys(definition: Mapping[str, Any], route: str | None, params: Mapping[str, Any] | None) -> set[str]:
    """The params a run on ``route`` sends with these values: route_param_keys
    less each one param_shown hides (its own ``visibleWhen``, or the route's
    ``paramVisibleWhen``). A setting the provider doesn't offer is never
    sent. Nodes without ``routes`` send route_param_keys, unchanged.
    maker_routes.multi_route filters by it before translate_params, so it
    works on our names. directRoute.ts routeSentKeys is the same."""
    if not has_routes(definition):
        return route_param_keys(definition, route)
    offered = route_param_definitions(definition, route)
    listed = {str(param.get("key")) for param in offered}
    values = effective_values(definition, params)
    return {str(param.get("key")) for param in offered if param_shown(param, values, listed)}


def _values_text(param: Mapping[str, Any] | None, key: str, values: Iterable[Any]) -> str:
    """A controller and the values a condition needs, as the card names them:
    "Model FLUX.2 [pro], FLUX.2 [max] or FLUX.2 [flex]", "Draft (fast preview) off"."""
    listed = list(values)
    label = _param_label(param, key)
    if listed and all(isinstance(value, bool) for value in listed):
        return f"{label} {_or_list(['on' if value else 'off' for value in listed])}"
    return f"{label} {_or_list([_option_label(param, value) for value in listed])}" if listed else label


def route_hides(definition: Mapping[str, Any], route: str | None) -> list[str]:
    """What a route-table node's route doesn't show of the params it lists,
    in the card's words, one entry per param its ``paramVisibleWhen`` names:
    "no Seed" (never offered there) or "Safety only with Model FLUX.2 [pro],
    FLUX.2 [max] or FLUX.2 [flex]" (offered under those values). `nebula
    info` prints it under each route and describe_node gives it as the
    route's ``hides``; the param list itself (route_param_definitions)
    already leaves the first out and carries the second as ``visibleWhen``."""
    if not has_routes(definition):
        return []
    spec = route_by_id(definition, route)
    lines: list[str] = []
    for key, condition in route_visible_when(spec).items():
        param = param_definition(definition, str(key))
        if param is None:
            continue
        label = _param_label(param, str(key))
        if condition is False:
            lines.append(f"no {label}")
        elif isinstance(condition, Mapping) and condition:
            lines.append(f"{label} only with " + " and ".join(
                _values_text(param_definition(definition, str(ctrl)), str(ctrl), values or [])
                for ctrl, values in condition.items()))
    return lines


def route_takes_value(route: Mapping[str, Any], key: str, value: Any) -> bool:
    """Whether ``route`` takes this one value of ``key`` on its own: its
    ``accepts`` rule (which a ``valueMap`` implies) holds and its ``rejects``
    doesn't list it. directRoute.ts routeTakesValue is the same."""
    rules = _route_rules(route)
    accepts = (rules.get("accepts") or {}).get(key) if isinstance(rules.get("accepts"), Mapping) else None
    if isinstance(accepts, Mapping) and not value_accepted(value, accepts):
        return False
    refused = (rules.get("rejects") or {}).get(key) if isinstance(rules.get("rejects"), Mapping) else None
    return not (isinstance(refused, list) and match_value(value) in {match_value(v) for v in refused})


def _option_label(param: Mapping[str, Any] | None, value: Any) -> str:
    """How the card shows one value of ``param``: its option's label, else the value."""
    for option in (param or {}).get("options") or []:
        option_value = option.get("value") if isinstance(option, Mapping) else option
        if match_value(option_value) == match_value(value):
            return str(option.get("label") if isinstance(option, Mapping) and option.get("label") else option_value)
    return match_value(value)


def _param_label(param: Mapping[str, Any] | None, key: str) -> str:
    return str((param or {}).get("label") or key)


def _setting_text(param: Mapping[str, Any] | None, key: str, value: Any) -> str:
    """A setting and its value as the card shows them: "Safety 5", "Seed 42",
    "Grounding off", "Draft (fast preview)" (a switch that is on), or just
    the label for text."""
    label = _param_label(param, key)
    if isinstance((param or {}).get("options"), list) and (param or {}).get("options"):
        return f"{label} {_option_label(param, value)}"
    if isinstance(value, bool):
        return label if value else f"{label} off"
    if isinstance(value, (int, float)):
        return f"{label} {match_value(value)}"
    return label


class HiddenStop(NamedTuple):
    """One saved value rule H stops a route on: the param, the route that
    would honor it, and the controllers that hide it here (key -> value)."""
    param: str
    honored_by: str
    controllers: tuple[tuple[str, Any], ...]


def hidden_stops(definition: Mapping[str, Any], route: Mapping[str, Any], params: Mapping[str, Any] | None,
                 _depth: int = 0) -> list[HiddenStop]:
    """Every saved value rule H stops ``route`` on (docs/PROVIDER-ROUTES.md):
    a param the route doesn't show with these values (route_sent_keys) whose
    saved value is set and isn't its default, and that some other route R'
    would honor: R' shows it with these values, takes it on its own
    (route_takes_value), its rules don't block these values (_rules_block;
    keys don't matter), and it wouldn't itself stop, one level down, on
    one of the settings that hide this param on ``route`` (there only R''s
    rules are read, so this never recurses further). Any other stop of R'
    doesn't count: then both routes stop, each with its own reset.
    That check keeps a Draft run on fal at Full HD running at 720p:
    OpenRouter shows Resolution but would stop on the Draft that hides
    Resolution on fal, so it honors nothing. It keeps a Draft on OpenRouter
    a stop: BFL's own stop (Resolution) isn't what hides Draft there. And
    two routes that each hide a value the other takes (fal's Safety under
    Klein, BFL's Safety Checker) both stop instead of each dropping the
    other's value. Any other hidden value is ignored: no provider of this
    node would use it with these settings.
    directRoute.ts hiddenStops is the same."""
    if not has_routes(definition):
        return []
    values = params or {}
    route_id = route.get("id")
    sent = route_sent_keys(definition, route_id, values)
    others = [spec for spec in routes_of(definition) if spec.get("id") != route_id]
    offered = {str(p.get("key")): p for p in route_param_definitions(definition, route_id)}
    effective = effective_values(definition, values)
    stops: list[HiddenStop] = []
    for param in all_param_definitions(definition):
        key = str(param.get("key"))
        if key in BILLING_PARAMS or key in sent:
            continue
        value = values.get(key)
        if not _has_value(value) or value in (WIRED,):
            continue
        if param.get("default") is not None and match_value(value) == match_value(param.get("default")):
            continue
        condition = (offered.get(key) or {}).get("visibleWhen") if key in offered else None
        failing = tuple((str(ctrl), effective.get(ctrl)) for ctrl in (condition or {})
                        if ctrl in offered and not visible_when_holds({ctrl: condition[ctrl]}, effective))
        hiders = {ctrl for ctrl, _ in failing}
        honored = next((spec for spec in others
                        if key in route_sent_keys(definition, spec.get("id"), values)
                        and route_takes_value(spec, key, value)
                        and _shown_rules_block(definition, spec, values) is None
                        and (_depth > 0 or not [stop for stop in hidden_stops(definition, spec, values, _depth + 1)
                                                if stop.param in hiders])), None)
        if honored is None:
            continue
        stops.append(HiddenStop(key, str(honored.get("id")), failing))
    return stops


def hidden_block(definition: Mapping[str, Any], route: Mapping[str, Any], params: Mapping[str, Any] | None) -> DirectBlock | None:
    """The first of :func:`hidden_stops` as a HIDDEN block: param, the route
    that would honor it (``on``), the setting as the card shows it
    (``detail``, "Safety 5") and what hides it here (``when``)."""
    stops = hidden_stops(definition, route, params)
    if not stops:
        return None
    stop = stops[0]
    values = params or {}
    effective = effective_values(definition, values)
    when = " and ".join(_setting_text(param_definition(definition, ctrl), ctrl, effective.get(ctrl))
                        for ctrl, _ in stop.controllers) or None
    return DirectBlock(HIDDEN, stop.param, stop.honored_by,
                       _setting_text(param_definition(definition, stop.param), stop.param, values.get(stop.param)), when)


def hidden_fix(definition: Mapping[str, Any], param: str) -> dict[str, Any]:
    """The one-click fix for a HIDDEN stop: the param back to its default
    (``value`` None: cleared when it has none)."""
    default = (param_definition(definition, param) or {}).get("default")
    return {"param": param, "value": default}


# -- what a person's click writes (frontend/src/lib/providerSwitch.ts) ---------


def _closest_value(route: Mapping[str, Any], offered: Mapping[str, Any], whole: Mapping[str, Any] | None,
                   value: Any) -> Any:
    """The value of ``offered`` on ``route`` closest to ``value``: an enum's
    nearest option the route takes by its place in the full option list (a
    tie takes the later, larger one); a number clamped into the route's
    range; else the param's default. providerSwitch.ts closestValue."""
    options = (whole or {}).get("options") or offered.get("options")
    offered_options = offered.get("options")
    if isinstance(options, list) and options and isinstance(offered_options, list) and offered_options:
        order = [match_value(o.get("value") if isinstance(o, Mapping) else o) for o in options]
        if match_value(value) in order:
            at = order.index(match_value(value))
            best: tuple[Any, int, int] | None = None
            for option in offered_options:
                option_value = option.get("value") if isinstance(option, Mapping) else option
                if match_value(option_value) not in order:
                    continue
                index = order.index(match_value(option_value))
                distance = abs(index - at)
                if best is None or distance < best[1] or (distance == best[1] and index > best[2]):
                    best = (option_value, distance, index)
            if best is not None:
                return best[0]
    rules = _route_rules(route)
    rule = (rules.get("accepts") or {}).get(str(offered.get("key"))) if isinstance(rules.get("accepts"), Mapping) else None
    if isinstance(value, (int, float)) and not isinstance(value, bool) and math.isfinite(value) and isinstance(rule, Mapping):
        nxt = value
        if isinstance(rule.get("min"), (int, float)):
            nxt = max(nxt, rule["min"])
        if isinstance(rule.get("max"), (int, float)):
            nxt = min(nxt, rule["max"])
        if rule.get("integer") or offered.get("type") == "integer":
            # Halves round up, as JS Math.round does (Python's round() goes to even).
            nxt = math.floor(nxt + 0.5)
        if route_takes_value(route, str(offered.get("key")), nxt):
            return nxt
    return offered.get("default")


def _default_note(param: Mapping[str, Any]) -> str:
    default = param.get("default")
    if default is None:
        return "cleared"
    if isinstance(default, bool):
        return "turned off" if default is False else "back to its default"
    return f"back to {_option_label(param, default)}"


def _snap_stops(definition: Mapping[str, Any], route: Mapping[str, Any], values: dict[str, Any],
                stops: list[HiddenStop], notes: list[str]) -> None:
    """Each rule-H stop back to its default (cleared when it has none), one note each."""
    label = provider_label(route.get("provider"))
    effective = effective_values(definition, values)
    for stop in stops:
        param = param_definition(definition, stop.param) or {}
        if stop.controllers:
            was = _setting_text(param, stop.param, values.get(stop.param))
            hides = " and ".join(_option_label(param_definition(definition, ctrl), effective.get(ctrl))
                                 for ctrl, _ in stop.controllers)
            notes.append(f"{was} isn't on {label} with {hides}: {_default_note(param)}")
        else:
            notes.append(f"{_param_label(param, stop.param)} isn't on {label}: {_default_note(param)}")
        if param.get("default") is None:
            values.pop(stop.param, None)
        else:
            values[stop.param] = param["default"]


def snap_for_route(definition: Mapping[str, Any], params: Mapping[str, Any],
                   route_id: str | None) -> tuple[dict[str, Any], list[str]]:
    """A person's switch to ``route_id`` (providerSwitch.ts snapForRoute):
    each saved value that route doesn't take moves to its closest value there
    ("1.5k isn't on fal.ai: set to 2k"), then every value rule H would stop
    the run on (hidden_stops) goes back to its default, or is cleared, with
    one note each ("Seed isn't on OpenRouter: cleared"). Only an explicit
    click does this; a route change without one keeps every value, and the
    run stops instead."""
    route = route_by_id(definition, route_id) if route_id else None
    values = dict(params)
    notes: list[str] = []
    if route is None:
        return values, notes
    whole = {str(p.get("key")): p for p in all_param_definitions(definition)}
    label = provider_label(route.get("provider"))
    sent = route_sent_keys(definition, route.get("id"), params)
    for offered in route_param_definitions(definition, route.get("id")):
        key = str(offered.get("key"))
        value = params.get(key)
        # A setting the route hides with these values is never sent, so it
        # keeps its value (rule H below decides whether it stops).
        if key not in sent or not _has_value(value) or route_takes_value(route, key, value):
            continue
        snapped = _closest_value(route, offered, whole.get(key), value)
        was = _option_label(whole.get(key), value)
        if snapped is None:
            values.pop(key, None)
            notes.append(f"{was} isn't on {label}: back to its default")
        else:
            values[key] = snapped
            notes.append(f"{was} isn't on {label}: set to {_option_label(whole.get(key), snapped)}")
    _snap_stops(definition, route, values, hidden_stops(definition, route, values), notes)
    return values, notes


def snap_hidden(definition: Mapping[str, Any], params: Mapping[str, Any], route_id: str | None,
                changed: str) -> tuple[dict[str, Any], list[str]]:
    """A person's edit of ``changed`` (Inspector or a pill) on the shown
    route: each value it now hides there that rule H would stop on goes back
    to its default, or is cleared, with one note each ("Safety 5 isn't on
    fal.ai with FLUX.2 [klein] 9B: back to 2"). Only the params ``changed``
    controls on that route; nothing else is reset. providerSwitch.ts snapHidden."""
    route = route_by_id(definition, route_id) if route_id else None
    values = dict(params)
    notes: list[str] = []
    if route is None or not has_routes(definition):
        return values, notes
    stops = [stop for stop in hidden_stops(definition, route, values) if changed in dict(stop.controllers)]
    _snap_stops(definition, route, values, stops, notes)
    return values, notes


def shown_route_id(
    definition: Mapping[str, Any], params: Mapping[str, Any] | None, api_keys: Mapping[str, Any],
) -> str | None:
    """Whose options a route-table node shows (route_param_definitions): the
    chosen route; under Auto, the route Auto resolves to with these keys
    (even when that route can't take the run yet, so its settings stay
    editable); with no key set, the maker's (else the first route). None for
    nodes without ``routes``. directRoute.ts shownRouteId is the same."""
    if not has_routes(definition):
        return None
    choice = provider_choice(params)
    if choice != AUTO and route_by_id(definition, choice) is not None:
        return choice
    route = select_route(definition, params or {}, api_keys)
    if route.route_id:
        return route.route_id
    first = maker_route(definition) or next(iter(routes_of(definition)), None)
    return str(first.get("id")) if first is not None else None


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


_OWN_GATEWAY = re.compile(r"^(.*\S)\s+\(([^()]+)\)$")


def name_on_route(definition: Mapping[str, Any], provider: Any) -> str:
    """A node's model as a run on ``provider`` names it (GM - Design, round 15
    item 3; round 16 (b), verbatim: "when the dialog builds the label, no
    parens: "Grok Imagine 2.0 via xAI""). A display name that ends by naming
    its own gateway ("Grok Imagine 2.0 (Krea)", "Nano Banana (FAL)") names the
    route the run actually takes instead, by the card's label for it. On the
    gateway itself, or a name that names no provider, it is the display name;
    except (GM - Design, round 19, review 18 L-A: "“Alt still” · Grok Imagine
    2.0 via Krea · price not listed") a node whose route depends on keys
    (:func:`canvas_title` strips its gateway) names the gateway route the same
    way, "Grok Imagine 2.0 via Krea", with no route given too (the gateway's,
    as the canvas's nameOnRoute reads ``provider ?? apiProvider``). Only the
    canvas drops the route, when it couldn't read the keys (GM, round 19:
    "“Grok Imagine 2.0” · $0.06"); Nebula always reads them.
    frontend/src/lib/directRoute.ts nameOnRoute is the same."""
    name = str(definition.get("displayName") or "")
    gateway = definition.get("apiProvider")
    title = canvas_title(definition)
    if title != name:
        return f"{title} via {provider_label(provider or gateway)}"
    if not provider or provider == gateway:
        return name
    own = _OWN_GATEWAY.match(name)
    if not own:
        return name
    said = own.group(2).strip().lower()
    if said not in {str(gateway).lower(), provider_label(gateway).lower()}:
        return name
    return f"{own.group(1)} via {provider_label(provider)}"


def _gateway_stripped(definition: Mapping[str, Any]) -> str | None:
    """The model part of a display name that ends by naming its own gateway
    ("Grok Imagine 2.0" for "Grok Imagine 2.0 (Krea)"); None otherwise."""
    name = str(definition.get("displayName") or "")
    gateway = definition.get("apiProvider")
    own = _OWN_GATEWAY.match(name)
    if not own:
        return None
    said = own.group(2).strip().lower()
    return own.group(1) if said in {str(gateway).lower(), provider_label(gateway).lower()} else None


def route_depends_on_keys(definition: Mapping[str, Any]) -> bool:
    """Whether the provider a node runs on depends on the keys set: its routes
    name more than one provider (:func:`routes_of`)."""
    return len({str(route.get("provider") or "") for route in routes_of(definition)}) > 1


def canvas_title(definition: Mapping[str, Any]) -> str:
    """A node's default title on the canvas (GM - Design, round 18, item 1,
    verbatim: "Unnamed node: the default title drops the route", "Only for
    nodes whose route depends on keys"; canvas only, the library and search
    keep the catalog names): the display name without the gateway it names
    when the route depends on keys, else the display name.
    frontend/src/lib/directRoute.ts canvasTitle is the same."""
    stripped = _gateway_stripped(definition)
    if stripped and route_depends_on_keys(definition):
        return stripped
    return str(definition.get("displayName") or "")


def is_default_title(definition: Mapping[str, Any], label: Any) -> bool:
    """A label that is either form of the definition's default title (its
    display name or :func:`canvas_title`): the node is unnamed."""
    return isinstance(label, str) and label in {str(definition.get("displayName") or ""), canvas_title(definition)}


def node_name(definition: Mapping[str, Any] | None, label: Any, fallback: str = "") -> str:
    """A canvas node's name wherever Nebula names it (MCP results, the
    cursor bubble, the Agent log, run refusals): ``label`` when it is a name
    of its own, else the node's :func:`canvas_title` (an unnamed node: no
    label, or either form of the default title, :func:`is_default_title`),
    else ``fallback`` (the node's id or type when its definition is gone).
    Review 18 M-D: agents see the same names as the canvas; the catalog
    (find_nodes, describe_node, search) keeps the catalog names."""
    if isinstance(label, str) and label.strip() and not (definition and is_default_title(definition, label)):
        return label
    return (canvas_title(definition) if definition else "") or fallback


def _or_list(items: Iterable[str]) -> str:
    listed = list(items)
    return listed[0] if len(listed) == 1 else f"{', '.join(listed[:-1])} or {listed[-1]}"


def _why(route: Mapping[str, Any], block: DirectBlock) -> str:
    if block.reason == HIDDEN:
        return f"it doesn't offer {block.detail}" + (f" with {block.when}" if block.when else "")
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
        name = port_limit_name(block.param, limit)
        if not limit.get("max"):
            return f"it doesn't take connected {name}"
        return f"it takes at most {limit.get('max')} connected {name}"
    return str(block.detail or block.reason)


def _accepted_values(route: Mapping[str, Any], block: DirectBlock) -> list[str]:
    """The values a route takes for the param that blocked it, when its rule lists them."""
    if block.reason != UNSUPPORTED or not block.param:
        return []
    rule = (_route_rules(route).get("accepts") or {}).get(block.param)
    return [match_value(v) for v in rule.get("values") or []] if isinstance(rule, Mapping) else []


def _hidden_fix_sentence(definition: Mapping[str, Any], param: str) -> str:
    """How a HIDDEN stop is fixed without a switch: the setting back to its
    default ("Set Safety back to 2", "Turn Draft (fast preview) off"), or
    cleared when it has none ("Clear Seed")."""
    spec = param_definition(definition, param)
    label = _param_label(spec, param)
    default = (spec or {}).get("default")
    if default is None:
        return f"Clear {label}, or switch provider."
    if isinstance(default, bool):
        return f"Turn {label} {'on' if default else 'off'}, or switch provider."
    return f"Set {label} back to {_option_label(spec, default)}, or switch provider."


def missing_key_line_for(definition: Mapping[str, Any], route: Route) -> str | None:
    """The route's own line for a run stopped only by a missing key
    (RouteSpec.missingKeyLine: Idol without a Hugging Face token), or None.
    Auto with no key set names no route: then every route must have one."""
    if not route.missing or route.block is not None:
        return None
    spec = route_by_id(definition, route.route_id) if route.route_id else None
    candidates = [spec] if spec is not None else [r for r in routes_of(definition) if r.get("plan") != "only"]
    lines = [str(r.get("missingKeyLine") or "") for r in candidates]
    return lines[0] if lines and all(lines) else None


def route_unavailable_message(
    definition: Mapping[str, Any], route: Route, alternatives: Iterable[str] = (),
    keyless: Iterable[str] = (),
) -> str:
    """Why a route-table run can't start, in the words the router, the
    engine's preflight, the estimate and the switcher all use
    (directRoute.ts routeUnavailableMessage is the same). ``keyless`` are
    routes that would take the run but have no key set: a HIDDEN stop with
    no alternative names them, so the message never ends at a dead end."""
    name = str(definition.get("displayName") or definition.get("id") or "This node")
    spec = route_by_id(definition, route.route_id) if route.route_id else None
    others = [provider_label((route_by_id(definition, alt) or {}).get("provider")) for alt in alternatives]
    keyless_labels = [provider_label((route_by_id(definition, alt) or {}).get("provider")) for alt in keyless]
    also = (f" {_or_list(others)} can take it." if others
            else f" {_or_list(keyless_labels)} can take it (add its key in Settings > Providers)." if keyless_labels
            else "")
    block = route.block
    if block is not None and block.reason == UNKNOWN_PROVIDER:
        ids = [AUTO] + [str(r.get("id")) for r in routes_of(definition)]
        return f"{name} is set to provider '{block.detail}', which it doesn't have. Choose {_or_list(ids)}."
    if block is not None and spec is not None:
        values = _accepted_values(spec, block)
        fix = (_hidden_fix_sentence(definition, str(block.param)) if block.reason == HIDDEN
               else f"Pick {_or_list(values)}, or switch provider." if values
               else "Disconnect the extra inputs, or switch provider." if block.reason == PORTS
               else "Change that setting, or switch provider.")
        return f"{name} can't run on {provider_label(spec.get('provider'))}: {_why(spec, block)}. {fix}{also}"
    needed = _or_list(route.missing) if route.missing else "a provider key"
    own = missing_key_line_for(definition, route)
    if own:
        # The route's own words (Idol's token): agents and the card read the same.
        return own
    if spec is not None:
        return (f"{name} is set to {provider_label(spec.get('provider'))}, which needs {needed}. "
                f"Add it in Settings > Providers or choose another provider.{also}")
    return f"{name} needs {needed} in Settings > Providers."


def _unavailable_route(
    definition: Mapping[str, Any], params: Mapping[str, Any] | None, api_keys: Mapping[str, Any],
) -> tuple[Route, list[str], list[str]] | None:
    """The route a run can't start on, its alternatives and its keyless
    routes (route_unavailable's reading), or None when it can start."""
    if not has_routes(definition):
        return None
    values = params or {}
    route = select_route(definition, values, api_keys)
    if route.kind != UNSET:
        return None
    alternatives = [str(r.get("id")) for r in routes_of(definition)
                    if r.get("id") != route.route_id and r.get("plan") != "only" and _can_run_keyed(r, api_keys)
                    and route_block(definition, r, values) is None]
    hidden = route.block is not None and route.block.reason == HIDDEN
    keyless = ([str(route.block.on)] if hidden and not alternatives and route.block.on
               and not _can_run_keyed(route_by_id(definition, route.block.on) or {}, api_keys) else [])
    return route, alternatives, keyless


def route_unavailable(
    definition: Mapping[str, Any], params: Mapping[str, Any] | None, api_keys: Mapping[str, Any],
) -> dict[str, Any] | None:
    """Why a route-table node can't run with these params and keys, or None
    when it can (and for every node without ``routes``):
    {routeId, missing, block, alternatives, fixes, message}. ``alternatives``
    are the other routes with a key set that can take the run, the one-click
    switches the switcher offers; Auto never takes one by itself. ``fixes``
    are the one-click param edits that let it run where it is
    ([{param, value}], ``value`` None meaning clear): a HIDDEN stop's
    setting back to its default (hidden_fix), else none. An agent applies
    one as an ordinary param edit. ``params`` are routed
    (with_wired_blockers). directRoute.ts routeUnavailable is the same."""
    found = _unavailable_route(definition, params, api_keys)
    if found is None:
        return None
    route, alternatives, keyless = found
    hidden = route.block is not None and route.block.reason == HIDDEN
    return {
        "routeId": route.route_id,
        "missing": list(route.missing),
        "block": block_dict(route.block),
        "alternatives": alternatives,
        "fixes": [hidden_fix(definition, str(route.block.param))] if hidden else [],
        "message": route_unavailable_message(definition, route, alternatives, keyless),
    }


# The card's words for a route stop (error copy round 3f, GM: "A switch reads
# "{Node} can't run on {Provider} with “{Label}” on." Never "Draft true".
# Listed values use the option's label as the field shows it, never its
# value."): a setting by its label in quotes, a value by its option's label
# less any note in parentheses, no parentheses, "seconds" for "s".
# directRoute.ts routeUnavailableMessage is the same, word for word.


def _plain(text: str) -> str:
    return re.sub(r"\s*\([^)]*\)", "", str(text)).strip()


def _person_words(text: str) -> str:
    """A rule's own label ("a video continuation longer than 15 s") in GM's rules."""
    words = _plain(text)
    words = re.sub(r"\b(\d+(?:\.\d+)?) ?s\b", r"\1 seconds", words)
    return re.sub(r"\bwired\b", "connected", words)


def _person_setting(param: Mapping[str, Any] | None, key: str, value: Any) -> str:
    """“Draft (fast preview)” on, “Safety” set to 5, “Resolution” set to 1.5K."""
    label = f"“{_param_label(param, key)}”"
    if isinstance((param or {}).get("options"), list) and (param or {}).get("options") and _has_value(value):
        return f"{label} set to {_plain(_option_label(param, value))}"
    if isinstance(value, bool) or (param or {}).get("type") == "boolean":
        on = value if isinstance(value, bool) else match_value(value) in {"true", WIRED}
        return f"{label} {'on' if on else 'off'}"
    if isinstance(value, (int, float)):
        return f"{label} set to {match_value(value)}"
    return f"{label} set"


def _hidden_fix_person(definition: Mapping[str, Any], param: str) -> str:
    """_hidden_fix_sentence in GM's rules, as the action's first clause (no
    period: person_line.route_action adds who can take the run): the label in
    quotes, the default by its option's label."""
    spec = param_definition(definition, param)
    label = f"“{_param_label(spec, param)}”"
    default = (spec or {}).get("default")
    if default is None:
        return f"Clear {label}"
    if isinstance(default, bool):
        return f"Turn {label} {'on' if default else 'off'}"
    return f"Set {label} back to {_plain(_option_label(spec, default))}"


def _why_person(definition: Mapping[str, Any], route: Mapping[str, Any], block: DirectBlock,
                params: Mapping[str, Any] | None = None) -> str:
    """Why a route stops, as the clause after "{Node} can't run on {Provider}"."""
    values = params or {}
    param = str(block.param or "")
    spec = param_definition(definition, param) if param else None
    label = f"“{_param_label(spec, param)}”" if param else ""
    if block.reason == HIDDEN:
        setting = _person_setting(spec, param, values.get(param))
        stops = [stop for stop in hidden_stops(definition, route, values) if stop.param == param]
        if stops and stops[0].controllers:
            effective = effective_values(definition, values)
            setting += "".join(f" and {_person_setting(param_definition(definition, ctrl), ctrl, effective.get(ctrl))}"
                               for ctrl, _ in stops[0].controllers)
        return f" with {setting}"
    if block.reason == UNSUPPORTED:
        if param and block.detail and block.detail.startswith(f"{param} "):
            value = values.get(param) if _has_value(values.get(param)) else block.detail[len(param) + 1:]
            return f" with {_person_setting(spec, param, value)}"
        return f" with {_person_words(block.detail or '')}"
    if block.reason == BLOCKED:
        return f" with {_person_setting(spec, param, values.get(param))}"
    if block.reason == REQUIRES:
        return f" without {label}"
    if block.reason == SIZE:
        return f", because it can’t render this {label} exactly"
    if block.reason == RETIRED:
        return f", because the maker retired this model on {block.on}"
    if block.reason == PORTS:
        limit = ((route.get("rules") or {}).get("ports") or {}).get(block.param) or {}
        name = _person_words(port_limit_name(block.param, limit))
        if not limit.get("max"):
            return f" with {name} connected"
        return f" with more than {limit.get('max')} {name} connected"
    return f", because {_person_words(_why(route, block))}"


def _fix_person(definition: Mapping[str, Any], route: Mapping[str, Any], block: DirectBlock,
                params: Mapping[str, Any] | None = None) -> Any:
    """What the person can change where the node is, as the action's first
    clause (person_line.route_action names who else can take the run; GM, PR
    #203 r31 item 3: never "or switch provider"), a person_line.Fix that says
    how many options it lists (r32 item 1: "Pick A, B or C, or switch to …")."""
    from execution.person_line import Fix

    param = str(block.param or "")
    spec = param_definition(definition, param) if param else None
    if block.reason == HIDDEN:
        return Fix(_hidden_fix_person(definition, param))
    values = _accepted_values(route, block)
    label = f"“{_param_label(spec, param)}”"
    if (spec or {}).get("type") == "boolean" and block.reason in (UNSUPPORTED, BLOCKED):
        on = match_value((params or {}).get(param)) in {"true", WIRED}
        return Fix(f"Turn {label} {'off' if on or block.reason == BLOCKED else 'on'}")
    if block.reason == BLOCKED:
        return Fix(f"Clear {label}")
    if values:
        return Fix(f"Pick {_or_list([_plain(_option_label(spec, value)) for value in values])}", len(values))
    if block.reason == PORTS:
        return Fix("Disconnect the extra inputs")
    if block.reason == REQUIRES:
        return Fix(f"Set “{_param_label(spec, param)}”")
    return Fix("Change that setting")


def route_unavailable_line(
    definition: Mapping[str, Any], params: Mapping[str, Any] | None, api_keys: Mapping[str, Any],
    *, title: str | None = None,
) -> str | None:
    """route_unavailable's message as the canvas card says it (error copy
    round 3e, GM: no keys, ids or env-var names in what the person reads; a
    key by its provider, a setting by its label; round 3f: GM's rules for
    every card line). The message itself stays the agents' text. None when
    the run can start. ``title`` names the node as the line's reader sees it
    (the proposal bar's “Name”, node_readiness.instance_missing_line); the
    card names it by its type, in quotes (card_subject), and on Auto with no key set keeps its run
    line, ", then run the node again" (GM, PR #203 r29 item 1)."""
    from execution.person_line import missing_key_line

    found = _unavailable_route(definition, params, api_keys)
    if found is None:
        return None
    reason = _route_reason(definition, params, found)
    if reason is None:
        return missing_key_line(found[0].missing) if title is None else None
    return reason.line(title or card_subject(definition))


def card_subject(definition: Mapping[str, Any]) -> str:
    """How a card's route line names its node: the type's name in quotes, as
    the bar and the Agent log quote every name (GM, PR #203 r32: "“FLUX 3
    Image” is set to Replicate…"), or "This node" when it has none. A run's
    node carries no label, so the card names it by its type."""
    name = str(definition.get("displayName") or "").strip()
    return f"“{name}”" if name else "This node"


def route_unavailable_reason(
    definition: Mapping[str, Any], params: Mapping[str, Any] | None, api_keys: Mapping[str, Any],
) -> Any:
    """Why a route-table run can't start, for a list that names the node
    (person_line.NotReadyReason: the proposal bar, the Agent Log), or None
    when it can start. On Auto with no key set: "needs your Black Forest
    Labs or fal.ai API key. Add one in Settings." (GM, PR #203 r29 item 1;
    review 14, copy MEDIUM-1: the line named no node)."""
    from execution.person_line import NotReadyReason, key_phrase

    found = _unavailable_route(definition, params, api_keys)
    if found is None:
        return None
    reason = _route_reason(definition, params, found)
    if reason is not None:
        return reason
    route = found[0]
    phrase = key_phrase(route.missing) if route.missing else None
    if not phrase:
        return NotReadyReason.of("not_set_up")
    return NotReadyReason.of("key", phrase=phrase, it="one" if len(route.missing) > 1 else "it")


def _route_reason(definition: Mapping[str, Any], params: Mapping[str, Any] | None, found: Any) -> Any:
    """The NotReadyReason for a stop route_unavailable_line and
    route_unavailable_reason say alike, or None for Auto with no key set
    (each says that one its own way)."""
    from execution.person_line import NotReadyReason, key_phrase, route_action

    route, alternatives, keyless = found
    spec = route_by_id(definition, route.route_id) if route.route_id else None
    others = [provider_label((route_by_id(definition, alt) or {}).get("provider")) for alt in alternatives]
    keyless_specs = [route_by_id(definition, alt) or {} for alt in keyless]
    keyless_labels = [provider_label(spec_.get("provider")) for spec_ in keyless_specs]
    # GM, PR #203 r29 item 2: the key by its name, never "its key" (it read
    # as the node's); r31 item 3: who can take the run is named in the
    # action ("… or switch to fal.ai"; "…, or add your fal.ai API key in
    # Settings and switch to fal.ai"), with no separate "can take it".
    keyless_phrase = key_phrase([key for spec_ in keyless_specs for key in keys(spec_.get("keys"))])
    block = route.block
    if block is not None and block.reason == UNKNOWN_PROVIDER:
        return NotReadyReason.of("unknown_provider")
    if block is not None and spec is not None:
        action, after_clause = route_action(_fix_person(definition, spec, block, params), others,
                                            keyless_labels, keyless_phrase)
        return NotReadyReason.of("route_block", after_clause=after_clause, provider=provider_label(spec.get("provider")),
                                 why=_why_person(definition, spec, block, params), action=action)
    own = missing_key_line_for(definition, route)
    if own:
        return NotReadyReason(own=own)
    if spec is not None:
        phrase = key_phrase(route.missing) if route.missing else None
        action, after_clause = route_action("Add it in Settings", others, keyless_labels, keyless_phrase)
        return NotReadyReason.of("route_key", after_clause=after_clause, provider=provider_label(spec.get("provider")),
                                 needed=f"your {phrase}" if phrase else "a provider key", action=action)
    return None


# -- the routes contract --------------------------------------------------------

def _literal_values(param: Mapping[str, Any] | None) -> set[str] | None:
    """The values a controller can hold, when they are a closed list: an
    enum's option values, or true/false for a switch. None for free values."""
    if not isinstance(param, Mapping):
        return None
    options = param.get("options")
    if isinstance(options, list) and options:
        return {match_value(o.get("value") if isinstance(o, Mapping) else o) for o in options}
    if param.get("type") == "boolean":
        return {"true", "false"}
    return None


def _visible_when_problems(definition: Mapping[str, Any], route: Mapping[str, Any], where: str) -> list[str]:
    """``paramVisibleWhen`` names this route's own params (shared or its
    own); each is ``false`` or ``{controller: [values]}`` with controllers
    from the same list and literal values ("(set)"/"(unset)" never: what a
    route offers doesn't depend on wired ports)."""
    if "paramVisibleWhen" not in route:
        return []
    conditions = route.get("paramVisibleWhen")
    if not isinstance(conditions, Mapping) or not conditions:
        return [f"{where}.paramVisibleWhen must be a non-empty object"]
    listed = {str(p.get("key")): p for group in (definition.get("sharedParams") or [], route.get("params") or [])
              for p in group if isinstance(p, Mapping) and p.get("key")}
    problems: list[str] = []
    for key, condition in conditions.items():
        at = f"{where}.paramVisibleWhen.{key}"
        if key not in listed:
            problems.append(f"{at} isn't one of this route's params")
            continue
        if condition is False:
            continue
        if not isinstance(condition, Mapping) or not condition:
            problems.append(f"{at} must be false or {{controller: [values]}}")
            continue
        for controller, allowed in condition.items():
            if controller == key or controller not in listed:
                problems.append(f"{at} names {controller}, which isn't another of this route's params")
                continue
            if conditions.get(controller) is False:
                problems.append(f"{at} names {controller}, which this route never offers")
            if not isinstance(allowed, list) or not allowed:
                problems.append(f"{at}.{controller} must list one or more values")
                continue
            if any(value in (SET, NOT_SET) for value in allowed):
                problems.append(f"{at}.{controller} can't use (set)/(unset): visibility never reads connected ports")
                continue
            literal = _literal_values(listed[controller])
            stray = [value for value in allowed if literal is not None and match_value(value) not in literal]
            if literal is None or stray:
                problems.append(f"{at}.{controller} values must be options of {controller}")
    return problems


def _hideable_problems(definition: Mapping[str, Any], route: Mapping[str, Any], where: str) -> list[str]:
    """What a route can hide must not pick its endpoint or hide itself:
    an ``endpointWhen`` key that is a param must be one the route always
    shows (no ``paramVisibleWhen`` and no ``visibleWhen`` of its own), since
    the endpoint would otherwise follow a value that is never sent; and the
    route's visibility conditions (``paramVisibleWhen`` plus its params' own
    ``visibleWhen``) may not depend on each other in a circle.
    check-node-contracts.mjs validateHideable is the same."""
    listed = {str(p.get("key")): p for group in (definition.get("sharedParams") or [], route.get("params") or [])
              for p in group if isinstance(p, Mapping) and p.get("key")}
    conditions = route.get("paramVisibleWhen") if isinstance(route.get("paramVisibleWhen"), Mapping) else {}
    every = {str(p.get("key")) for p in all_param_definitions(definition)}
    problems: list[str] = []
    for index, option in enumerate(route.get("endpointWhen") or []):
        for key in ((option.get("when") if isinstance(option, Mapping) else None) or {}):
            if key not in every:
                continue  # a wired port
            own = (listed.get(key) or {}).get("visibleWhen")
            if key not in listed or conditions.get(key) is not None or own:
                problem = f"{where}.endpointWhen[{index}] reads {key}, which the route can hide"
                if problem not in problems:
                    problems.append(problem)
    edges: dict[str, set[str]] = {}
    for key, param in listed.items():
        edges.setdefault(key, set()).update(str(c) for c in (param.get("visibleWhen") or {}) if str(c) in listed)
    for key, condition in conditions.items():
        if isinstance(condition, Mapping):
            edges.setdefault(str(key), set()).update(str(c) for c in condition if str(c) in listed)
    state: dict[str, int] = {}
    cycles: list[str] = []

    def visit(key: str, path: list[str]) -> None:
        state[key] = 1
        for nxt in sorted(edges.get(key, ())):
            if state.get(nxt) == 1:
                loop = path[path.index(nxt):] + [nxt] if nxt in path else [key, nxt]
                cycles.append(" -> ".join(loop))
            elif not state.get(nxt):
                visit(nxt, path + [nxt])
        state[key] = 2

    for key in sorted(edges):
        if not state.get(key):
            visit(key, [key])
    problems += [f"{where} visibility conditions go in a circle: {cycle}" for cycle in cycles]
    return problems


def _price_combinations(definition: Mapping[str, Any], rows: list[Mapping[str, Any]],
                        keys: list[str]) -> list[dict[str, Any]]:
    """Every combination of ``keys``' values a price row can tell apart: a
    controller's or a matched param's literal values (_literal_values), the
    values rows list for anything else, plus one value no row lists."""
    import itertools

    choices: list[list[Any]] = []
    for key in keys:
        listed = [row.get("match", {}).get(key) for row in rows if key in (row.get("match") or {})]
        literal = _literal_values(param_definition(definition, key))
        values = sorted(literal) if literal is not None else sorted({match_value(v) for v in listed}) + ["(other)"]
        choices.append(values)
    return [dict(zip(keys, combo)) for combo in itertools.product(*choices)]


def price_row_problems(definition: Mapping[str, Any], route_key: str, rows: Any,
                       extras: Any = None, multiply_by: Any = None) -> list[str]:
    """A route's price may not read a setting where the route hides it: for
    every combination of the values its rows, extras and its params'
    conditions can tell apart, the first row that matches, every extra that
    matches, and every ``multiplyBy`` param must not name a param the route
    doesn't show with those values (route_sent_keys). Otherwise the price
    would depend on a value that isn't sent. Route-table nodes only;
    model_pricing.validate_pricing calls it, and check-node-contracts.mjs
    checks the same."""
    route = next((spec for spec in routes_of(definition) if (spec.get("pricing") or spec.get("id")) == route_key), None)
    if not has_routes(definition) or route is None or not isinstance(rows, list):
        return []
    rows = [row for row in rows if isinstance(row, Mapping)]
    extras = [extra for extra in extras or [] if isinstance(extra, Mapping)]
    factors = [str(key) for key in multiply_by or [] if not str(key).startswith("(")]
    offered = route_param_definitions(definition, route.get("id"))
    matched = rows + extras
    named = {str(key) for row in matched for key in (row.get("match") or {}) if not str(key).startswith("(")}
    named |= set(factors)
    controllers = {str(ctrl) for param in offered if str(param.get("key")) in named
                   for ctrl in (param.get("visibleWhen") or {})}
    keys = sorted(named | controllers | {str(key) for row in matched for key in (row.get("match") or {})})
    problems: list[str] = []

    def matches(row: Mapping[str, Any], literal: Mapping[str, Any]) -> bool:
        return all(match_value(literal.get(k)) == match_value(want) for k, want in (row.get("match") or {}).items())

    for combo in _price_combinations(definition, matched, keys):
        values = {key: (None if value == "(other)" else value) for key, value in combo.items()}
        literal = {key: (value == "true" if _literal_values(param_definition(definition, key)) == {"true", "false"}
                         else value) for key, value in values.items()}
        row_index = next((index for index, row in enumerate(rows) if matches(row, literal)), None)
        if row_index is None:
            continue
        sent = route_sent_keys(definition, route.get("id"), {k: v for k, v in literal.items() if not k.startswith("(")})
        reads = [(f"price row {row_index}", list(rows[row_index].get("match") or {}))]
        reads += [(f"price extra {index}", list(extra.get("match") or {}))
                  for index, extra in enumerate(extras) if matches(extra, literal)]
        reads += [("multiplyBy", factors)]
        for what, read in reads:
            for key in read:
                if not str(key).startswith("(") and key not in sent:
                    problem = (f"{definition.get('id')} ({route_key} route): {what} reads {key}, which the "
                               f"route doesn't show with {', '.join(f'{k}={match_value(v)}' for k, v in combo.items())}")
                    if problem not in problems:
                        problems.append(problem)
    return problems[:5]

# The clients a route can name (execution/route_clients.py ROUTE_CLIENTS).
ROUTE_HANDLERS = ("bfl", "fal", "replicate-model", "openrouter-images", "openrouter-videos", "krea", "hf-space")
_ROUTE_FIELDS = {"id", "provider", "maker", "keys", "optionalKeys", "plan", "handler", "endpoint", "endpointWhen",
                 "params", "rename", "valueMap", "rules", "paramVisibleWhen", "pricing", "note", "missingKeyLine",
                 "mayBillWithKey"}
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
        optional = route.get("optionalKeys")
        if optional is not None:
            if not isinstance(optional, list) or not all(isinstance(k, str) and k for k in optional):
                problems.append(f"{where}.optionalKeys must be a list of key names")
                optional = []
            if route_keys:
                problems.append(f"{where} lists keys and optionalKeys; a keyless route's keys must be []")
            for key in optional:
                if key not in KEY_PROVIDERS:
                    problems.append(f"{where}.optionalKeys names {key}, which Settings doesn't store")
            if plan:
                problems.append(f"{where} a keyless route can't bill a plan")
        may_bill = route.get("mayBillWithKey")
        if may_bill is not None:
            if may_bill is not True:
                problems.append(f"{where}.mayBillWithKey must be true when present")
            if not optional:
                problems.append(f"{where}.mayBillWithKey needs optionalKeys: it says a run with one of them may bill")
        if plan != "only" and not route_keys and optional is None:
            problems.append(f"{where} needs keys (only a plan-only or keyless route runs without one)")
        # A maker's Hugging Face Space (handler hf-space) names the maker as
        # its provider; its key is the Hugging Face token, which meters it.
        space_token = route.get("handler") == "hf-space" and route_keys[:1] == ["HF_TOKEN"]
        if route_keys and KEY_PROVIDERS.get(route_keys[0]) != route.get("provider") and not space_token:
            problems.append(f"{where}.provider must be {KEY_PROVIDERS.get(route_keys[0])!r}, who bills {route_keys[0]}")
        missing_line = route.get("missingKeyLine")
        if missing_line is not None:
            if not isinstance(missing_line, str) or not missing_line.strip():
                problems.append(f"{where}.missingKeyLine must be a sentence")
            if not route_keys:
                problems.append(f"{where}.missingKeyLine needs keys to be missing")
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
            input_ids = {str(p.get("id")) for p in definition.get("inputPorts") or [] if isinstance(p, Mapping)}
            for port, limit in (rules.get("ports") or {}).items():
                most = limit.get("max") if isinstance(limit, Mapping) else None
                if isinstance(most, bool) or not isinstance(most, int) or most < 0:
                    problems.append(f"{where}.rules.ports.{port}.max must be a whole number of inputs")
                if not isinstance(limit, Mapping):
                    continue
                stray_limit = sorted(set(limit) - {"max", "of", "label"})
                if stray_limit:
                    problems.append(f"{where}.rules.ports.{port} has unknown fields {stray_limit}")
                group = limit.get("of")
                if group is not None and (not isinstance(group, list) or len(group) < 2
                                          or not all(isinstance(name, str) and name in input_ids for name in group)):
                    problems.append(f"{where}.rules.ports.{port}.of must list two or more of the node's input ports")
                if group is not None and port in input_ids:
                    problems.append(f"{where}.rules.ports.{port} groups ports, so its key must not be an input port")
                if "label" in limit and (not isinstance(limit["label"], str) or not limit["label"].strip()):
                    problems.append(f"{where}.rules.ports.{port}.label must be text")
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
        problems += _visible_when_problems(definition, route, where)
        problems += _hideable_problems(definition, route, where)
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
