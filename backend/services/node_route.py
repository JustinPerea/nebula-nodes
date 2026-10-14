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
3. otherwise the first other key that is set (``FAL_KEY``, ``KREA_API_TOKEN``,
   or ``RUNWAY_API_KEY`` for the ElevenLabs models Runway resells): the copy.

Stdlib only, so the engine and the scripts can import it cheaply.
"""
from __future__ import annotations

import math
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
    # BytePlus ModelArk, ByteDance's own international API (Seedream, Seedance).
    "BYTEPLUS_API_KEY": "bytedance",
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
    """Who runs a dual-route node without its maker key: the provider of its
    first non-direct key ("fal", "krea", or "runway" for Runway's resold
    ElevenLabs models)."""
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
    values = params or {}
    node_id = str(definition.get("id") or "")
    needed = DIRECT_REQUIRES.get(node_id)
    if needed and not _has_value(values.get(needed)):
        return DirectBlock(REQUIRES, needed)
    spec = definition.get("directRoute")
    spec = spec if isinstance(spec, Mapping) else {}
    for key in spec.get("blockedBy") or []:
        if _has_value(values.get(key)):
            return DirectBlock(BLOCKED, str(key))
    block = _unsupported(definition, values, spec) or _size_block(definition, values, spec.get("size"))
    if block is not None:
        return block
    retires = DIRECT_RETIRES.get(node_id)
    if retires and _today() >= retires["on"]:
        param = retires.get("param")
        if not param or _effective(definition, values, param) in retires.get("values", []):
            return DirectBlock(RETIRED, param, retires["on"])
    return None


def wired_rule_params(definition: Mapping[str, Any]) -> set[str]:
    """The params a rule counts as set when they arrive by wire: ``blockedBy``
    and every ``rejectsWhen`` entry matching ``"(set)"`` or ``"(unset)"`` (a
    wired port isn't unset)."""
    spec = definition.get("directRoute")
    if not isinstance(spec, Mapping):
        return set()
    named = {str(key) for key in spec.get("blockedBy") or []}
    for rule in spec.get("rejectsWhen") or []:
        match = rule.get("match") if isinstance(rule, Mapping) else None
        entries = match.items() if isinstance(match, Mapping) else []
        named |= {str(key) for key, want in entries if want in (SET, NOT_SET)}
    return named


def with_wired_blockers(
    definition: Mapping[str, Any], params: Mapping[str, Any] | None, wired: Any,
) -> dict[str, Any]:
    """``params`` plus a WIRED marker for each param a rule reads as set
    (wired_rule_params) that arrives on a wired input port, so
    :func:`direct_block` treats it as the saved param. ``wired`` are the
    input ports with a value (the router and the cache key, filled_ports) or
    with an edge into them (the run estimate, before any value exists).
    Other params are unchanged."""
    values = dict(params or {})
    ports = set(wired or ())
    for key in wired_rule_params(definition):
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
