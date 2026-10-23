"""Can a node run here, and if not, what's missing? One rule for every agent surface.

Mirrors the canvas (frontend/src/lib/nodeKeys.ts, behind kreaConnection.ts
nodeKeyStatus). Used by `nebula context` and GET /api/agent/nodes (the MCP
server's find_nodes and describe_node).

`apiProvider: utility` only means a node has no top-level key. A utility node
that still calls a provider says how in its definition's ``providerVia``:

- ``kind: model``: it runs another node's handler (cinema-scene runs its base
  image model, scene.base.model). It needs that model's key. It can run when
  any of its models can; ``detail`` says which.
- ``kind: param``: one param picks local or provider work (the QC nodes' mode).
  It is FREE at its defaults when the default runs locally; ``detail`` and
  ``keys_needed`` name the keys the other values need. ``byValue`` gives a
  value its own keys and provider (QC ``mode: jev`` needs TYPESAFE_API_KEY,
  the other paid modes a vision key); ``param_route`` reads it.

A route-table node (services/node_route.py ``routes``) is ready, as a
definition, when any route is (``node_access``). One node on the canvas runs
on its saved ``_provider`` choice, or Auto's, and nothing else
(``instance_access``, ``keys_needed``): a key for another route doesn't make
it ready.
"""
from __future__ import annotations

from typing import Any, Iterable, Mapping

# How a node runs here. None means it can't yet; missing() says why.
KEY = "key"          # a configured API key (or a direct-route key)
FREE = "free"        # runs locally, no key
KREA = "krea"        # on the signed-in Krea account (workspace compute)
NOUS = "nous"        # a local Nous (Hermes) sign-in, which Nebula doesn't check up front

# Where every agent surface sends the person to set a key.
_WHERE = "in Settings > Providers"


def _keys(value: Any) -> list[str]:
    return [k for k in (value if isinstance(value, list) else [value]) if k]


def krea_modes(definition: Mapping[str, Any]) -> list[str]:
    """The Krea billing modes a node offers ("api-token", "mcp"), or [] for non-Krea nodes."""
    for param in definition.get("params") or []:
        if param.get("key") == "_kreaAuth":
            return [str(option.get("value") if isinstance(option, Mapping) else option)
                    for option in param.get("options") or []]
    return []


def provider_via(definition: Mapping[str, Any]) -> Mapping[str, Any] | None:
    via = definition.get("providerVia")
    return via if isinstance(via, Mapping) else None


def _param_default(definition: Mapping[str, Any], key: str) -> Any:
    from services.node_route import param_definition
    param = param_definition(definition, key)
    return param.get("default") if param is not None else None


def param_calls_provider(definition: Mapping[str, Any], params: Mapping[str, Any] | None) -> bool:
    """For a ``kind: param`` node: whether these params pick the provider work.

    Matches what the handler runs: an absent param means the definition's
    default (the handler's own default); any present value that isn't exactly
    one of ``freeWhen``, including '' and None, counts as calling the
    provider. Fail closed: such a value is refused by the handler anyway."""
    via = provider_via(definition) or {}
    key = str(via.get("param") or "")
    free = [value for value in via.get("freeWhen") or [] if isinstance(value, str)]
    given = params or {}
    value = given[key] if key in given else _param_default(definition, key)
    return not (isinstance(value, str) and value in free)


def param_value(definition: Mapping[str, Any], params: Mapping[str, Any] | None) -> Any:
    """The value a ``kind: param`` node's params pick: the param, or its default."""
    via = provider_via(definition) or {}
    key = str(via.get("param") or "")
    given = params or {}
    return given[key] if key in given else _param_default(definition, key)


def param_route(via: Mapping[str, Any], value: Any) -> tuple[list[str], str]:
    """(keys, provider) one value of a ``kind: param`` node calls: its
    ``byValue`` entry, else the node's ``anyKey`` and ``provider``."""
    own = via.get("byValue") if isinstance(via.get("byValue"), Mapping) else {}
    route = own.get(value) if isinstance(value, str) else None
    if isinstance(route, Mapping):
        return _keys(route.get("anyKey")), str(route.get("provider") or "provider")
    return _keys(via.get("anyKey")), str(via.get("provider") or "provider")


def model_choice(definition: Mapping[str, Any], params: Mapping[str, Any] | None) -> str | None:
    """For a ``kind: model`` node: the model these params run, normalized the way
    cinema's handler guard does it (empty or a fallback value runs the default),
    or None when the value can't be read or isn't one of its models."""
    via = provider_via(definition) or {}
    path = [str(part) for part in via.get("path") or []]
    node: Any = params or {}
    for depth, part in enumerate(path):
        if not isinstance(node, Mapping):
            return None
        node = node.get(part)
        # As the handler reads it (`params.get("scene") or {}`): an empty or
        # missing level reads as empty, so a fresh node runs the default; a
        # level that is there but not an object can't be read.
        if depth < len(path) - 1 and not node:
            node = {}
    if not path:
        return None
    chosen = str(node or "").strip().lower()
    if not chosen or chosen in {str(v).lower() for v in via.get("fallbackFor") or []}:
        chosen = str(via.get("default") or "")
    return chosen if chosen in [str(m) for m in via.get("models") or []] else None


def keys_needed(
    definition: Mapping[str, Any], params: Mapping[str, Any] | None,
    definitions: Mapping[str, Mapping[str, Any]] | None,
) -> list[Mapping[str, Any]] | None:
    """What one node, with these params, needs to run: a list of definitions
    whose keys it uses (the node itself, or the model a ``kind: model`` node
    runs, or a stand-in carrying a ``kind: param`` node's keys, or the chosen
    route's keys on a route-table node); [] when it runs locally; None when it
    can't be read (fail closed)."""
    from services import node_route

    if node_route.has_routes(definition):
        choice = node_route.provider_choice(params)
        if choice == node_route.AUTO:
            return [definition]
        route = node_route.route_by_id(definition, choice)
        if route is None:
            return None
        stand_in: dict[str, Any] = {"id": definition.get("id"), "apiProvider": route.get("provider"),
                                    "envKeyName": list(route.get("keys") or [])}
        if route.get("plan"):
            # The route's plan is reached through the node's _kreaAuth (krea_modes).
            stand_in["params"] = [param for param in definition.get("params") or []
                                  if isinstance(param, Mapping) and param.get("key") in node_route.BILLING_PARAMS]
        return [stand_in]
    via = provider_via(definition)
    if via is None:
        local = (definition.get("apiProvider") == "utility" and not krea_modes(definition)
                 and not _keys(definition.get("envKeyName")) + _keys(definition.get("directKeyName")))
        return [] if local else [definition]
    if via.get("kind") == "param":
        if not param_calls_provider(definition, params):
            return []
        keys, provider = param_route(via, param_value(definition, params))
        return [{"id": definition.get("id"), "apiProvider": provider, "envKeyName": keys}]
    if via.get("kind") == "model":
        chosen = model_choice(definition, params)
        target = (definitions or {}).get(chosen or "")
        return [target] if target else None
    return None


def _plain_access(definition: Mapping[str, Any], configured: set[str], krea_signed_in: bool) -> str | None:
    if definition.get("apiProvider") == "nous":
        return NOUS
    modes = krea_modes(definition)
    keys = _keys(definition.get("envKeyName")) + _keys(definition.get("directKeyName"))
    if modes == ["mcp"]:
        return KREA if krea_signed_in else None
    if any(key in configured for key in keys):
        return KEY
    if "mcp" in modes and krea_signed_in:
        return KREA
    return FREE if not keys and not modes else None


def node_access(
    definition: Mapping[str, Any], configured_keys: Iterable[str], krea_signed_in: bool,
    definitions: Mapping[str, Mapping[str, Any]] | None = None,
) -> str | None:
    """How a node can run here (KEY, FREE, KREA, NOUS), or None.

    A ``kind: model`` node runs the way the best of its models can (KEY over
    KREA), never FREE; without ``definitions`` to look them up it is None. A
    ``kind: param`` node answers for its defaults (detail() has the rest)."""
    configured = set(configured_keys)
    via = provider_via(definition)
    if via is None:
        return _plain_access(definition, configured, krea_signed_in)
    if via.get("kind") == "param":
        if not param_calls_provider(definition, {}):
            return FREE
        keys, _ = param_route(via, param_value(definition, {}))
        return KEY if any(key in configured for key in keys) else None
    if via.get("kind") == "model" and definitions is not None:
        options = [_plain_access(definitions[m], configured, krea_signed_in)
                   for m in via.get("models") or [] if m in definitions]
        for best in (KEY, KREA, NOUS):
            if best in options:
                return best
    return None


def instance_access(
    definition: Mapping[str, Any], params: Mapping[str, Any] | None, configured_keys: Iterable[str],
    krea_signed_in: bool = False, definitions: Mapping[str, Mapping[str, Any]] | None = None,
) -> str | None:
    """How this node, with these params, can run here (KEY, KREA, ...), or None.

    A route-table node answers for the route it would take: its explicit
    ``_provider`` route, or Auto's (node_route.select_route), so a key for
    another route doesn't count, and a setting that route can't take makes
    it None (node_route.route_unavailable says why). The Krea route on the
    plan needs the sign-in. Every other node answers as ``node_access``."""
    from services import node_route

    if not node_route.has_routes(definition):
        return node_access(definition, configured_keys, krea_signed_in, definitions)
    if node_route.uses_krea_plan(definition, params):
        return KREA if krea_signed_in else None
    keys = {key: "set" for key in configured_keys}
    route = node_route.select_route(definition, params, keys)
    return None if route.kind == node_route.UNSET else KEY


KREA_SIGN_IN = "needs the Krea account signed in (Settings > Providers)"


def instance_missing(
    definition: Mapping[str, Any], params: Mapping[str, Any] | None, configured_keys: Iterable[str],
    krea_signed_in: bool = False, definitions: Mapping[str, Mapping[str, Any]] | None = None,
    wired: Any = (),
) -> str | None:
    """What this node, with these params, needs before it can run here, in
    the words `missing` uses (find_nodes, describe_node); None when it can run.

    For one node on a canvas or in a proposal, where its own choices count:
    a Krea node bills its saved `_kreaAuth` (the API token unless "mcp"), so
    a Krea sign-in doesn't make an API-token node ready; a route-table node
    runs its chosen route or Auto's (``wired`` as the router reads it, so a
    wired input can block a route), in node_route's own words; a ``kind:
    param`` or ``kind: model`` node needs the keys its value picks."""
    from services import node_route

    configured = set(configured_keys)
    if node_route.has_routes(definition):
        routed = node_route.with_wired_blockers(definition, params, wired)
        if node_route.uses_krea_plan(definition, routed):
            return None if krea_signed_in else KREA_SIGN_IN
        why = node_route.route_unavailable(definition, routed, {key: "set" for key in configured})
        return str(why.get("message") or "can't run on its chosen provider") if why else None
    if krea_modes(definition):
        if node_route.uses_krea_plan(definition, params):
            return None if krea_signed_in else KREA_SIGN_IN
        keys = _keys(definition.get("envKeyName")) + _keys(definition.get("directKeyName"))
        if not keys or any(key in configured for key in keys):
            return None
        return f"needs {' or '.join(dict.fromkeys(keys))} {_WHERE}"
    needs = keys_needed(definition, params, definitions)
    if needs is None:
        return missing(definition, krea_signed_in, definitions)
    for need in needs:
        if _plain_access(need, configured, krea_signed_in) is None:
            return missing(need, krea_signed_in, definitions)
    return None


def instance_missing_line(
    definition: Mapping[str, Any], params: Mapping[str, Any] | None, configured_keys: Iterable[str],
    krea_signed_in: bool = False, definitions: Mapping[str, Mapping[str, Any]] | None = None,
    wired: Any = (), name: str | None = None,
) -> str | None:
    """instance_missing in words for the person (error copy round 3f): the
    node by its name, a key by its provider, never an env-var name or a ref
    ("GPT Image 2 needs your OpenAI API key. Add it in Settings."). The
    proposal bar and layer show it; agents keep instance_missing's text.
    None when the node can run."""
    from execution.person_line import key_phrase
    from services import node_route

    need = instance_missing(definition, params, configured_keys, krea_signed_in, definitions, wired)
    if need is None:
        return None
    title = name or str(definition.get("displayName") or "This node")
    sign_in = f"{title} needs your Krea account. Connect it in Settings."
    configured = set(configured_keys)
    if node_route.has_routes(definition):
        routed = node_route.with_wired_blockers(definition, params, wired)
        if node_route.uses_krea_plan(definition, routed):
            return sign_in
        line = node_route.route_unavailable_line(definition, routed, {key: "set" for key in configured})
        if line:
            return line
    if need == KREA_SIGN_IN:
        return sign_in
    needs = keys_needed(definition, params, definitions) or []
    target = next((item for item in needs if _plain_access(item, configured, krea_signed_in) is None), definition)
    via = provider_via(target)
    if via is not None and via.get("kind") == "param":
        keys, _ = param_route(via, param_value(target, params or {}))
    else:
        keys = _keys(target.get("envKeyName")) + _keys(target.get("directKeyName"))
    keys = list(dict.fromkeys(keys))
    phrase = key_phrase(keys) if keys else None
    if phrase:
        return f"{title} needs your {phrase}. Add {'one' if len(keys) > 1 else 'it'} in Settings."
    return f"{title} isn't set up to run here yet. Check its provider in Settings."


def missing(
    definition: Mapping[str, Any], krea_signed_in: bool,
    definitions: Mapping[str, Mapping[str, Any]] | None = None,
) -> str:
    """What the person would need to set up, for a node node_access says can't run."""
    via = provider_via(definition)
    if via is not None and via.get("kind") == "param":
        keys, _ = param_route(via, param_value(definition, {}))
        options = " or ".join(dict.fromkeys(keys))
        return f"needs {options} {_WHERE}"
    if via is not None and via.get("kind") == "model":
        by_key: dict[str, list[str]] = {}
        for model in via.get("models") or []:
            target = (definitions or {}).get(model)
            if not target:
                continue
            need = " or ".join(dict.fromkeys(_keys(target.get("envKeyName")) + _keys(target.get("directKeyName"))))
            label = f"{model} default" if model == via.get("default") else str(model)
            by_key.setdefault(need or "a Krea sign-in", []).append(label)
        if not by_key:
            return f"needs setup {_WHERE}"
        options = " or ".join(f"{need} ({', '.join(models)})" for need, models in by_key.items())
        return f"needs {options} {_WHERE}"
    keys = _keys(definition.get("envKeyName")) + _keys(definition.get("directKeyName"))
    modes = krea_modes(definition)
    if modes == ["mcp"] or ("mcp" in modes and not krea_signed_in and not keys):
        return KREA_SIGN_IN
    if keys:
        options = " or ".join(dict.fromkeys(keys))
        also = " (or a Krea sign-in)" if "mcp" in modes else ""
        return f"needs {options} {_WHERE}{also}"
    return f"needs setup {_WHERE}"


def detail(
    definition: Mapping[str, Any], configured_keys: Iterable[str], krea_signed_in: bool,
    definitions: Mapping[str, Mapping[str, Any]] | None,
) -> dict[str, Any] | None:
    """Readiness per option of a ``providerVia`` node, or None for other nodes.

    {"param": ..., "default": ..., "options": {value: runsWith or None},
     "note": ..., "missing": ...}"""
    via = provider_via(definition)
    if via is None:
        return None
    configured = set(configured_keys)
    if via.get("kind") == "param":
        key = str(via.get("param") or "")
        values = [option.get("value") if isinstance(option, Mapping) else option
                  for group in ("params", "sharedParams") for param in definition.get(group) or []
                  if isinstance(param, Mapping) and param.get("key") == key
                  for option in param.get("options") or []]
        free = set(via.get("freeWhen") or [])
        own = via.get("byValue") if isinstance(via.get("byValue"), Mapping) else {}
        options: dict[str, str | None] = {}
        missing_by_value: dict[str, str] = {}
        for value in values:
            if value in free:
                options[str(value)] = FREE
                continue
            keys, _ = param_route(via, value)
            keyed = any(k in configured for k in keys)
            options[str(value)] = KEY if keyed else None
            if not keyed:
                missing_by_value[str(value)] = f"needs {' or '.join(dict.fromkeys(keys))} {_WHERE}"
        shared = [value for value in options if value not in free and value not in own]
        notes = []
        if shared:
            notes.append(f"{key}={'/'.join(shared)} calls a {via.get('provider') or 'provider'} model with the first of "
                         f"{', '.join(_keys(via.get('anyKey')))} that is set; Nebula has no list price for it, so agent "
                         "runs in that mode must be proposed (propose_change) whenever a spending limit is set.")
        for value in own:
            if value in options:
                keys, provider = param_route(via, value)
                notes.append(f"{key}={value} calls {provider} with {' or '.join(keys)}; its price is the node's "
                             "price rows for that value (describe_node price).")
        result: dict[str, Any] = {
            "param": key, "default": _param_default(definition, key), "options": options,
            "note": " ".join(notes),
        }
        if missing_by_value:
            result["missing"] = missing_by_value
        return result
    if via.get("kind") == "model":
        path = ".".join(str(part) for part in via.get("path") or [])
        default = str(via.get("default") or "")
        options: dict[str, str | None] = {}
        for model in via.get("models") or []:
            target = (definitions or {}).get(model)
            options[str(model)] = _plain_access(target, configured, krea_signed_in) if target else None
        result = {"param": path, "default": default, "options": options}
        ready = [model for model, access in options.items() if access]
        if options.get(default) is None and ready:
            target = (definitions or {}).get(default) or {}
            needs = " or ".join(dict.fromkeys(_keys(target.get("envKeyName")))) or "setup"
            result["note"] = (f"default {default} needs {needs}; set {path} to "
                              f"{' or '.join(ready)} to run with the keys set here.")
        elif not ready:
            result["missing"] = missing(definition, krea_signed_in, definitions)
        return result
    return None


def configured_keys(settings: Mapping[str, Any]) -> set[str]:
    return {key for key, value in (settings.get("apiKeys") or {}).items() if value}
