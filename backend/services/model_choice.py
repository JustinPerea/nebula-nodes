"""A Krea node with a required field that has nothing chosen.

GM - Design, round 12 addendum (b), 2026-10-26: Topaz Standard with no model
chosen can't run (Krea's schema requires ``model``, and the gateway refuses
it before calling Krea), so Nebula refuses the run up front instead of asking
anyone to approve a run that can't go out, and the refusal names the node and
the field: "Nothing ran. Choose a model for “Clean plate” first."

Review 12, L-7, and GM's round-13 rule: the same holds for every required
field a Krea node has with no default (Krea 2's Aspect ratio and Resolution, a
Flux 1.1 Pro's Width and Height, a node app's Version, a style training's
Name). The canvas fills no value in (a new node keeps nothing, and its field
reads "Choose…"), so a run can reach the gateway without it. The line follows
the pattern: "Choose an aspect ratio for “X” first." When a node misses more
than one, only the first in the card's field order is named, so the notice
stays one line (GM, round 13: the same for the model and version lines).

The canvas shows that line itself before any dialog (frontend
lib/placeholderRunConfirm.ts ``modelNotChosenText``); here is the run's own
check, which every run path reads (execution.engine.validate_graph, the
person's direct run before its paid-placeholder confirmation, and /api/quick):
agents' run_nodes and ``nebula run`` read "Choose an aspect ratio for “X”
first." in the refusal.

The fields: a Krea definition's params (in the card's order, the definition's)
that are required, have no default, aren't hidden, and have no input port of
the same id (a wire could fill those). Nothing here adds a default: which
value to use is the person's choice.

Review 13, M-1 and L-6 (round 14): the refusal follows the route the run
takes (:func:`unchosen`), as node_route.select_route picks it for the router,
pricing and the spend gate. The Krea gateway (an API token, or the plan)
needs every field above. A Krea copy that runs on its maker's own API with
the person's key needs only what that API sizes by (directRoute.size: Seedream
on BytePlus takes width x height); OpenAI picks GPT Image 2.5's size itself
and xAI leaves Grok's out, so those run. With no usable route (no key, the
plan not signed in) no field is named: the key or sign-in refusal comes
first. frontend lib/placeholderRunConfirm.ts reads the same rule, and both
are pinned by tests/fixtures/required_field_cases.json.

GM - Design, round 14, item 1: a typed value is "Set" ("Set a width for “X”
first."), a picker keeps "Choose" (model, version, aspect ratio).
"""
from __future__ import annotations

from functools import lru_cache
from typing import Any, Iterable, Mapping, NamedTuple

from services import node_route
from services.node_registry import NodeRegistry

# The frontend's KREA_SETTING_KEYS (lib/placeholderRunConfirm.ts): the
# settings that choose which model runs (the dialog's rows name them).
_SETTING_KEYS = ("variant", "engine", "model", "enhancement_model", "frame_interpolation_model", "grain_model",
                 "node_app_version_id")
# The word a field goes by in the line; else its card label, lowercased.
_FIELD_WORDS = {"node_app_version_id": "version"}
# Fields the person picks rather than types, besides every enum: a node app's
# Version (GM, round 14: "Choose stays for pickers (model, version, aspect ratio)").
_PICKED = frozenset({"node_app_version_id"})


def _unset(value: Any) -> bool:
    return value is None or (isinstance(value, str) and not value.strip())


def _specs(definition: Mapping[str, Any]) -> list[Mapping[str, Any]]:
    """The definition's params in the card's order, each key once."""
    seen: set[str] = set()
    specs: list[Mapping[str, Any]] = []
    for spec in [*(definition.get("params") or []), *(definition.get("sharedParams") or [])]:
        key = spec.get("key") if isinstance(spec, Mapping) else None
        if not isinstance(key, str) or key in seen:
            continue
        seen.add(key)
        specs.append(spec)
    return specs


def _word(spec: Mapping[str, Any]) -> str:
    key = str(spec.get("key"))
    return _FIELD_WORDS.get(key) or str(spec.get("label") or key).lower()


@lru_cache(maxsize=1)
def required_fields() -> dict[str, list[tuple[str, str]]]:
    """Every Krea definition with a required field that has no default:
    {definition id: [(param key, field word), ...]} in the card's order."""
    found: dict[str, list[tuple[str, str]]] = {}
    for definition_id, definition in sorted(NodeRegistry().get_all().items()):
        if definition.get("apiProvider") != "krea":
            continue
        ports = {port.get("id") for port in definition.get("inputPorts") or [] if isinstance(port, Mapping)}
        fields = [(str(spec["key"]), _word(spec)) for spec in _specs(definition)
                  if spec.get("required") and _unset(spec.get("default")) and not spec.get("hidden")
                  and spec["key"] not in ports]
        if fields:
            found[definition_id] = fields
    return found


@lru_cache(maxsize=1)
def required_model_settings() -> dict[str, tuple[str, str]]:
    """The fields above that choose which model runs (the dialog's rows read
    "Model: not chosen" for them): {definition id: (param key, field word)}."""
    found: dict[str, tuple[str, str]] = {}
    for definition_id, fields in required_fields().items():
        for key, word in fields:
            if key in _SETTING_KEYS:
                found[definition_id] = (key, word)
                break
    return found


def field_verb(definition_id: str, key: str) -> str:
    """GM - Design, round 14, item 1: "Choose" for a picker (an enum, a node
    app's version), "Set" for a value the person types (width, height, name)."""
    definition = NodeRegistry().get_all().get(definition_id) or {}
    spec = next((spec for spec in _specs(definition) if spec.get("key") == key), {})
    return "Choose" if key in _PICKED or spec.get("type") == "enum" or spec.get("options") else "Set"


class Unchosen(NamedTuple):
    """The first field a run can't go without: the line's verb and word."""
    verb: str
    field: str


def _maker_sizes_by(definition: Mapping[str, Any], route: node_route.Route) -> set[str]:
    """The params a maker's own API sizes by (its ``size`` rule: Seedream on
    BytePlus takes width x height, maker_routes_byteplus refuses a run
    without them). Any other maker field here is Krea's alone."""
    if node_route.has_routes(definition):
        spec = node_route.route_by_id(definition, route.route_id) or {}
        rules = spec.get("rules") if isinstance(spec.get("rules"), Mapping) else {}
    else:
        rules = definition.get("directRoute") if isinstance(definition.get("directRoute"), Mapping) else {}
    size = rules.get("size") if isinstance(rules, Mapping) else None
    if not isinstance(size, Mapping):
        return set()
    return {str(size[name]) for name in ("widthParam", "heightParam") if size.get(name)}


def _whole_sizes(definition: Mapping[str, Any], params: Mapping[str, Any] | None) -> dict[str, Any]:
    """``params`` for choosing the route: a size with one of its two fields
    empty (a width and no height) is a missing field, named as such, not a
    size the maker can't render (node_route._size_block would send the run
    to the copy), so it is left out of the choice."""
    values = dict(params or {})
    for rules in [definition.get("directRoute"), *[(route or {}).get("rules") for route in definition.get("routes") or []]]:
        size = rules.get("size") if isinstance(rules, Mapping) else None
        if not isinstance(size, Mapping) or not size.get("widthParam") or not size.get("heightParam"):
            continue
        pair = (str(size["widthParam"]), str(size["heightParam"]))
        if sum(_unset(values.get(key)) for key in pair) == 1:
            for key in pair:
                values.pop(key, None)
    return values


def route_fields(definition_id: str, params: Mapping[str, Any] | None, api_keys: Mapping[str, Any],
                 *, wired: Iterable[str] | Mapping[str, int] = (), plan_ready: bool = True) -> list[tuple[str, str]]:
    """The required fields (required_fields) the run's route needs, in the
    card's order. The route is the one the run takes: select_route over the
    params with what is wired in (with_wired_blockers), as the router reads
    them. ``plan_ready``: the person's Krea plan is signed in."""
    fields = required_fields().get(definition_id)
    if not fields:
        return []
    definition = NodeRegistry().get_all().get(definition_id) or {}
    routed = node_route.with_wired_blockers(definition, _whole_sizes(definition, params), wired)
    route = node_route.select_route(definition, routed, api_keys)
    if route.kind == node_route.PLAN:
        return list(fields) if plan_ready else []
    if route.kind == node_route.UNSET or not route.key or not str(api_keys.get(route.key) or "").strip():
        return []
    if route.provider == "krea":
        return list(fields)
    needs = _maker_sizes_by(definition, route)
    return [field for field in fields if field[0] in needs]


def unchosen(definition_id: str, params: Mapping[str, Any] | None, api_keys: Mapping[str, Any],
             *, wired: Iterable[str] | Mapping[str, int] = (), plan_ready: bool = True) -> Unchosen | None:
    """The first field (card order) the run's route needs with nothing in it."""
    for key, word in route_fields(definition_id, params, api_keys, wired=wired, plan_ready=plan_ready):
        if _unset((params or {}).get(key)):
            return Unchosen(field_verb(definition_id, key), word)
    return None


def unchosen_field(definition_id: str, params: Mapping[str, Any] | None) -> str | None:
    """The word for the first required field (in the card's order) with
    nothing chosen, on the Krea gateway ("aspect ratio", "model", "version");
    else None. Run paths ask :func:`unchosen`, which follows the route."""
    for key, word in required_fields().get(definition_id, ()):
        if _unset((params or {}).get(key)):
            return word
    return None


def not_chosen_line(name: str, field: str, verb: str = "Choose") -> str:
    """GM's refusal for the node, without the "Nothing ran." that the run's
    own refusal already says ("Nothing ran, so nothing was spent. …"):
    "Choose an aspect ratio for “X” first.", "Set a width for “X” first."."""
    article = "an" if field[:1].lower() in "aeiou" else "a"
    return f"{verb} {article} {field} for “{name}” first."
