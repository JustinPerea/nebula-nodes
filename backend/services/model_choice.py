"""A Krea node whose model-choosing setting is required and not chosen.

GM - Design, round 12 addendum (b), 2026-10-26: Topaz Standard with no model
chosen can't run (Krea's schema requires ``model``, and the gateway refuses
it before calling Krea), so Nebula refuses the run up front instead of asking
anyone to approve a run that can't go out, and the refusal names the node and
the field: "Nothing ran. Choose a model for “Clean plate” first." The canvas
shows that line itself before any dialog (frontend
lib/placeholderRunConfirm.ts ``modelNotChosenText``); here is the run's own
check, which every run path reads (execution.engine.validate_graph, and the
person's direct run before its paid-placeholder confirmation): agents'
run_nodes and ``nebula run`` read "Choose a model for “Clean plate” first."
in the refusal.

The settings are a Krea node's sub-model settings, as the dialog's rows name
them (frontend KREA_SETTING_KEYS): the ones that are required and have no
default. Today: Topaz Standard's Model and a node app's Version.
"""
from __future__ import annotations

from functools import lru_cache
from typing import Any, Mapping

from services.node_registry import NodeRegistry

# The frontend's KREA_SETTING_KEYS (lib/placeholderRunConfirm.ts).
_SETTING_KEYS = ("variant", "engine", "model", "enhancement_model", "frame_interpolation_model", "grain_model",
                 "node_app_version_id")
# The word a setting goes by in the line; else its card label, lowercased.
_FIELD_WORDS = {"node_app_version_id": "version"}


def _unset(value: Any) -> bool:
    return value is None or (isinstance(value, str) and not value.strip())


@lru_cache(maxsize=1)
def required_model_settings() -> dict[str, tuple[str, str]]:
    """Every Krea definition with a required model-choosing setting that has
    no default: {definition id: (param key, field word)}."""
    found: dict[str, tuple[str, str]] = {}
    for definition_id, definition in NodeRegistry().get_all().items():
        if definition.get("apiProvider") != "krea":
            continue
        params = [*(definition.get("params") or []), *(definition.get("sharedParams") or [])]
        for spec in params:
            key = spec.get("key") if isinstance(spec, Mapping) else None
            if key not in _SETTING_KEYS or not spec.get("required") or not _unset(spec.get("default")):
                continue
            if spec.get("type") != "enum" and key != "node_app_version_id":
                continue
            found[definition_id] = (key, _FIELD_WORDS.get(key) or str(spec.get("label") or key).lower())
            break
    return found


def unchosen_field(definition_id: str, params: Mapping[str, Any] | None) -> str | None:
    """The field word ("model", "version") when the node's required
    model-choosing setting has nothing chosen; else None."""
    setting = required_model_settings().get(definition_id)
    if setting is None:
        return None
    key, field = setting
    return field if _unset((params or {}).get(key)) else None


def not_chosen_line(name: str, field: str) -> str:
    """GM's refusal for the node, without the "Nothing ran." that the run's
    own refusal already says ("Nothing ran, so nothing was spent. …")."""
    return f"Choose a {field} for “{name}” first."
