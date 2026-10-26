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
"""
from __future__ import annotations

from functools import lru_cache
from typing import Any, Mapping

from services.node_registry import NodeRegistry

# The frontend's KREA_SETTING_KEYS (lib/placeholderRunConfirm.ts): the
# settings that choose which model runs (the dialog's rows name them).
_SETTING_KEYS = ("variant", "engine", "model", "enhancement_model", "frame_interpolation_model", "grain_model",
                 "node_app_version_id")
# The word a field goes by in the line; else its card label, lowercased.
_FIELD_WORDS = {"node_app_version_id": "version"}


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


def unchosen_field(definition_id: str, params: Mapping[str, Any] | None) -> str | None:
    """The word for the first required field (in the card's order) with
    nothing chosen ("aspect ratio", "model", "version"); else None."""
    for key, word in required_fields().get(definition_id, ()):
        if _unset((params or {}).get(key)):
            return word
    return None


def not_chosen_line(name: str, field: str) -> str:
    """GM's refusal for the node, without the "Nothing ran." that the run's
    own refusal already says ("Nothing ran, so nothing was spent. …")."""
    article = "an" if field[:1].lower() in "aeiou" else "a"
    return f"Choose {article} {field} for “{name}” first."
