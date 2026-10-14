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

Precedence, the same everywhere:

1. ``_kreaAuth == "mcp"`` (or an account-only Krea node): the Krea plan. It's
   the person's explicit choice, so a maker key never overrides it.
2. a direct (maker) key is set, and the direct route can take this run
   (:func:`direct_block`): the maker's API.
3. otherwise the first other key that is set (``FAL_KEY``, ``KREA_API_TOKEN``):
   the aggregator copy.

Stdlib only, so the engine and the scripts can import it cheaply.
"""
from __future__ import annotations

from datetime import date
from typing import Any, Mapping, NamedTuple

# Which provider bills a run that uses this key. Vertex bills Veo at the same
# listed amounts as the Gemini API.
KEY_PROVIDERS: dict[str, str] = {
    "OPENAI_API_KEY": "openai", "ANTHROPIC_API_KEY": "anthropic", "GOOGLE_API_KEY": "google",
    "OPENROUTER_API_KEY": "openrouter", "REPLICATE_API_TOKEN": "replicate", "FAL_KEY": "fal",
    "MESHY_API_KEY": "meshy", "RUNWAY_API_KEY": "runway", "ELEVENLABS_API_KEY": "elevenlabs",
    "MINIMAX_API_KEY": "minimax", "XAI_API_KEY": "xai", "HIGGSFIELD_API_KEY": "higgsfield",
    "QUIVER_API_KEY": "quiver", "KREA_API_TOKEN": "krea", "IDEOGRAM_API_KEY": "ideogram",
    "WORLDLABS_API_KEY": "worldlabs",
    "GOOGLE_VERTEX_CREDENTIALS": "google",
}

# A direct route that also needs a param set, else the run takes the fallback.
# Ideogram's direct reframe sizes by `resolution`; a saved recipe with only
# fal's `image_size` stays on fal (execution/sync_runner.py _ideogram_router).
DIRECT_REQUIRES: dict[str, str] = {"ideogram-reframe": "resolution"}

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

# Values of a param both routes read that the maker can't render as set: a run
# saved with one stays on the fal or Krea copy (reason BLOCKED) instead of
# silently changing shape. The defaults are never listed (they'd send every new
# node to the copy). gpt-image-2's fal presets: OpenAI needs "total pixels
# between 655,360 and 8,294,400", so Square (512x512) and the 16:9 presets
# (576x1024, 1024x576) have no OpenAI size
# (https://developers.openai.com/api/docs/guides/image-generation, checked
# 2026-10-14; execution/maker_routes_openai.py maps the rest exactly).
_GPT_IMAGE_2_FAL_UNSIZED = ["square", "portrait_16_9", "landscape_16_9"]
DIRECT_BLOCKED_VALUES: dict[str, dict[str, list[Any]]] = {
    "gpt-image-2-fal-generate": {"image_size": _GPT_IMAGE_2_FAL_UNSIZED},
    "gpt-image-2-fal-edit": {"image_size": _GPT_IMAGE_2_FAL_UNSIZED},
}

# Why a direct route can't take a run (direct_block).
REQUIRES = "requires"  # DIRECT_REQUIRES: the direct route needs a param that isn't set
BLOCKED = "blocked"    # a copy-only param is set (directRoute.blockedBy), or a value the maker can't render (DIRECT_BLOCKED_VALUES)
RETIRED = "retired"    # DIRECT_RETIRES: the maker shut this model down on its API
UNSUPPORTED = "unsupported"  # a shared param has a value the maker can't render (directRoute.blockedWhen)

LOCAL = "local"        # a utility node: no provider
PLAN = "plan"          # the signed-in Krea plan
ONLY = "only"          # a node with one route
DIRECT = "direct"      # the maker's API, with the person's key
FALLBACK = "fallback"  # the fal or Krea copy
UNSET = "unset"        # a multi-route node with none of its keys set


class Route(NamedTuple):
    kind: str
    provider: str | None
    key: str | None


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
    """Who runs a dual-route node without its maker key: "fal" or "krea"."""
    if not direct_keys(definition):
        return None
    for key in fallback_keys(definition):
        if key in KEY_PROVIDERS:
            return KEY_PROVIDERS[key]
    return None


def krea_auth_param(definition: Mapping[str, Any]) -> Mapping[str, Any] | None:
    if definition.get("apiProvider") != "krea":
        return None
    return next((p for p in definition.get("params") or []
                 if isinstance(p, Mapping) and p.get("key") == "_kreaAuth"), None)


def uses_krea_plan(definition: Mapping[str, Any], params: Mapping[str, Any] | None) -> bool:
    """A run billed to the signed-in Krea plan: an account-only Krea node, or
    one whose saved `_kreaAuth` is "mcp". Nodes saved before the choice
    existed keep API-token billing."""
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
    return value is not None and value != ""


class DirectBlock(NamedTuple):
    reason: str
    param: str | None = None
    on: str | None = None


def direct_block(definition: Mapping[str, Any], params: Mapping[str, Any] | None) -> DirectBlock | None:
    """Why the direct route can't take a run with these params, or None when it can.

    - REQUIRES: Ideogram's direct reframe sizes by ``resolution``; a recipe
      with only fal's ``image_size`` stays on fal.
    - BLOCKED: a generated Krea copy names, in ``directRoute.blockedBy``, the
      Krea-only params (explicit width/height) the maker can't honor; a
      recipe that sets one stays on Krea instead of silently changing shape.
    - UNSUPPORTED: ``directRoute.blockedWhen`` maps a shared param to the
      values the maker can't render (Veo 3.1 Fast at 4K on Vertex); a run
      with one of them, saved or default, stays on the copy.
      DIRECT_BLOCKED_VALUES does the same for a shared param's values the
      maker can't render (gpt-image-2's small fal size presets).
    - RETIRED: on and after a DIRECT_RETIRES date the maker no longer serves
      the model, so the fal or Krea copy runs it."""
    values = params or {}
    node_id = str(definition.get("id") or "")
    needed = DIRECT_REQUIRES.get(node_id)
    if needed and not values.get(needed):
        return DirectBlock(REQUIRES, needed)
    spec = definition.get("directRoute")
    for key in (spec.get("blockedBy") or []) if isinstance(spec, Mapping) else []:
        if _has_value(values.get(key)):
            return DirectBlock(BLOCKED, str(key))
    blocked_when = spec.get("blockedWhen") if isinstance(spec, Mapping) else None
    for key, unsupported in (blocked_when or {}).items():
        if _effective(definition, values, str(key)) in unsupported:
            return DirectBlock(UNSUPPORTED, str(key))
    for key, unsupported in DIRECT_BLOCKED_VALUES.get(node_id, {}).items():
        if _effective(definition, values, key) in unsupported:
            return DirectBlock(BLOCKED, key)
    retires = DIRECT_RETIRES.get(node_id)
    if retires and _today() >= retires["on"]:
        param = retires.get("param")
        if not param or _effective(definition, values, param) in retires.get("values", []):
            return DirectBlock(RETIRED, param, retires["on"])
    return None


# A blocker that arrives by wire rather than as a saved param.
WIRED = "(wired)"


def with_wired_blockers(
    definition: Mapping[str, Any], params: Mapping[str, Any] | None, wired: Any,
) -> dict[str, Any]:
    """``params`` plus a marker for each ``directRoute.blockedBy`` field that
    arrives on a wired input port (a Krea copy's style images), so
    :func:`direct_block` keeps that run on the copy just as it would for the
    saved param. ``wired`` are the input port ids with a value (the router)
    or with an edge into them (the run estimate). Other params are unchanged."""
    values = dict(params or {})
    spec = definition.get("directRoute")
    ports = set(wired or ())
    for key in (spec.get("blockedBy") or []) if isinstance(spec, Mapping) else []:
        if key in ports and not _has_value(values.get(key)):
            values[key] = WIRED
    return values


def filled_ports(inputs: Mapping[str, Any] | None) -> set[str]:
    """The input ports of a run that carry a value (PortValueDict-like objects
    with ``.value``), as the router and the engine's cache key read wired
    blockers: the same set in both, so the cache key names the route that ran."""
    filled: set[str] = set()
    for port, item in (inputs or {}).items():
        value = getattr(item, "value", None)
        if value is not None and value != "" and value != []:
            filled.add(str(port))
    return filled


def _effective(definition: Mapping[str, Any], params: Mapping[str, Any], key: str) -> Any:
    """A param's value as a run reads it: the saved value, else the definition default."""
    if _has_value(params.get(key)):
        return params[key]
    for group in ("sharedParams", "directParams", "falParams", "params"):
        for param in definition.get(group) or []:
            if isinstance(param, Mapping) and param.get("key") == key:
                return param.get("default")
    return None


def direct_allowed(definition: Mapping[str, Any], params: Mapping[str, Any] | None) -> bool:
    return direct_block(definition, params) is None


def select_route(
    definition: Mapping[str, Any], params: Mapping[str, Any] | None, api_keys: Mapping[str, Any],
) -> Route:
    """The route a run of this node takes with these params and keys."""
    provider = definition.get("apiProvider")
    if provider == "utility":
        return Route(LOCAL, None, None)
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


def route_param_keys(definition: Mapping[str, Any], kind: str) -> set[str]:
    """The params a route may send: sharedParams plus that route's own group.

    The graph stores defaults for every route of a dual-route node, so each
    route must drop the others' params (a direct-only default reaching fal is
    a billed 422; Krea refuses unknown fields)."""
    if not definition.get("sharedParams") and not definition.get("directParams"):
        return {str(p.get("key")) for p in definition.get("params") or [] if isinstance(p, Mapping)}
    group = "directParams" if kind == DIRECT else "falParams"
    return {str(p.get("key")) for name in ("sharedParams", group)
            for p in definition.get(name) or [] if isinstance(p, Mapping) and p.get("key")}


def cache_tag(
    definition: Mapping[str, Any], params: Mapping[str, Any] | None, api_keys: Mapping[str, Any],
) -> str | None:
    """What the execution cache key adds for a multi-route node, so a result
    from one route is never reused once the run would take another (adding a
    maker key must not replay a fal or Krea result). None for single-route
    nodes, whose keys stay as they were."""
    if not is_multi_route(definition):
        return None
    route = select_route(definition, params, api_keys)
    return f"{route.kind}:{route.provider or ''}"
