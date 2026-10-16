"""Per-value param defaults (a param's ``defaultBy`` in node_definitions.json).

A param such as Max Tokens can default differently for some models::

    "default": 4096,
    "defaultBy": {"model": {"claude-opus-5-5": 64000}}

``default`` covers every value not listed, including the model param's own
default (scripts/check-node-contracts.mjs checks that). The canvas writes
defaults into node.params when it makes a node and moves them when the model
changes (frontend/src/lib/paramDefaults.ts).

Only a handler whose API requires the value calls :func:`listed_default` for a
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

