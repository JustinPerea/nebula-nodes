"""Per-value param defaults (a param's ``defaultBy`` in node_definitions.json).

A param such as Max Tokens can default differently for some models::

    "default": 64000,
    "defaultBy": {"model": {"claude-sonnet-4-6": 4096}}

``default`` covers every value not listed, including the model param's own
default (scripts/check-node-contracts.mjs checks that), so every path that
copies ``default`` into a new node is right for the model it starts on. The canvas writes
defaults into node.params when it makes a node and moves them when the model
changes (frontend/src/lib/paramDefaults.ts).

Only a handler whose API requires the value calls :func:`param_default` for a
missing one (anthropic_chat.py: Messages needs max_tokens). Where the API takes
the param as optional (OpenAI max_completion_tokens, Gemini maxOutputTokens), a
missing value sends nothing, because the provider's own limit is larger than any
listed default and a fallback would cut answers shorter than before.
"""
from __future__ import annotations

from functools import lru_cache
from typing import Any, Mapping


@lru_cache(maxsize=1)
def _definitions() -> dict[str, dict[str, Any]]:
    from services.node_registry import NodeRegistry

    return NodeRegistry().get_all()


def _params(definition: Mapping[str, Any]) -> list[dict[str, Any]]:
    if "sharedParams" in definition:
        return [*definition["sharedParams"], *definition.get("falParams", []), *definition.get("directParams", [])]
    return list(definition.get("params", []))


def _missing(value: Any) -> bool:
    return value is None or value == ""


def listed_default(definition_id: str, key: str, params: Mapping[str, Any]) -> Any | None:
    """The ``defaultBy`` entry for ``key`` under the node's current values, or
    None when the current value isn't listed (the caller keeps its own rule)."""
    definition = _definitions().get(definition_id) or {}
    sources = _params(definition)
    param = next((p for p in sources if p.get("key") == key), None)
    rule = (param or {}).get("defaultBy") or {}
    if len(rule) != 1:
        return None
    (controller, table), = rule.items()
    value = params.get(controller)
    if _missing(value):
        value = next((p.get("default") for p in sources if p.get("key") == controller), None)
    if _missing(value):
        return None
    return table.get(str(value))


def param_default(definition_id: str, key: str, params: Mapping[str, Any]) -> Any | None:
    """The default ``key`` has under the node's current values: its
    ``defaultBy`` entry when the value is listed, otherwise its ``default``.
    None when the controlling value isn't on the menu (a retired or mistyped
    model): ``default`` is the newest models' value, which needn't fit it."""
    listed = listed_default(definition_id, key, params)
    if listed is not None:
        return listed
    sources = _params(_definitions().get(definition_id) or {})
    param = next((p for p in sources if p.get("key") == key), None)
    if param is None:
        return None
    for controller in (param.get("defaultBy") or {}):
        value = params.get(controller)
        options = next((p.get("options") for p in sources if p.get("key") == controller), None) or []
        if not _missing(value) and not any(str(o.get("value")) == str(value) for o in options):
            return None
    return param.get("default")
