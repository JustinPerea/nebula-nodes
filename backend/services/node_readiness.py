"""Can a node run here, and if not, what's missing? One rule for every agent surface.

Mirrors the canvas (frontend/src/lib/kreaConnection.ts nodeKeyStatus). Used by
`nebula context` and GET /api/agent/nodes (the MCP server's find_nodes).
"""
from __future__ import annotations

from typing import Any, Iterable, Mapping

# How a node runs here. None means it can't yet; missing() says why.
KEY = "key"          # a configured API key (or a direct-route key)
FREE = "free"        # runs locally, no key
KREA = "krea"        # on the signed-in Krea account (workspace compute)
NOUS = "nous"        # a local Nous (Hermes) sign-in, which Nebula doesn't check up front


def _keys(value: Any) -> list[str]:
    return [k for k in (value if isinstance(value, list) else [value]) if k]


def krea_modes(definition: Mapping[str, Any]) -> list[str]:
    """The Krea billing modes a node offers ("api-token", "mcp"), or [] for non-Krea nodes."""
    for param in definition.get("params") or []:
        if param.get("key") == "_kreaAuth":
            return [str(option.get("value") if isinstance(option, Mapping) else option)
                    for option in param.get("options") or []]
    return []


def node_access(definition: Mapping[str, Any], configured_keys: Iterable[str], krea_signed_in: bool) -> str | None:
    """How a node can run here (KEY, FREE, KREA, NOUS), or None."""
    configured = set(configured_keys)
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


def missing(definition: Mapping[str, Any], krea_signed_in: bool) -> str:
    """What the person would need to set up, for a node node_access says can't run."""
    keys = _keys(definition.get("envKeyName")) + _keys(definition.get("directKeyName"))
    modes = krea_modes(definition)
    if modes == ["mcp"] or ("mcp" in modes and not krea_signed_in and not keys):
        return "needs the Krea account signed in (Settings > Providers)"
    if keys:
        options = " or ".join(dict.fromkeys(keys))
        also = " (or a Krea sign-in)" if "mcp" in modes else ""
        return f"needs {options} in Settings > Providers{also}"
    return "needs setup in Settings > Providers"


def configured_keys(settings: Mapping[str, Any]) -> set[str]:
    return {key for key, value in (settings.get("apiKeys") or {}).items() if value}
