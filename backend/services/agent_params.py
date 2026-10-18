"""Which params an agent may write, and the params that point at saved assets.

Internal params. A key that starts with ``_`` is the canvas's own bookkeeping
(``_previewUrl``, ``_maskData``, ``_paperSource``, ...): the canvas writes it,
agents don't. Every agent path refuses one with the same message:

- proposals and direct edits (``canvas_proposals.parse_spec``, used by
  ``POST /api/canvas/proposals`` and ``POST /api/graph/apply``);
- the node routes (create, create-and-connect, update) when the request
  carries an agent marker (``main._refuse_agent_internal_params``);
- the CLI's create and set, before sending (``cli/client.py``), since a CLI
  run without ``NEBULA_AGENT_NAME`` or a token carries no marker.

The billing params (``node_route.BILLING_PARAMS``) pass this check and meet
their own rule: only the person, or a proposal the person accepts, changes
who bills a run.

Asset references. A node that stands for a saved asset names it in a public
param whose ``type`` is the asset kind (``nebula-moodboard``'s ``moodboard``,
``character``'s ``character``), so agents read and set it like any other
param. These nodes kept the id in ``_moodboardId`` / ``_characterId`` until
2026-10-18; ``retired_nodes.migrate_params`` moves a saved one over.
"""
from __future__ import annotations

from typing import Any, Iterable, Mapping

from services.node_route import BILLING_PARAMS

# Param type -> where its ids come from, for agents (describe) and errors.
ASSET_PARAM_TYPES: dict[str, dict[str, str]] = {
    "moodboard": {"noun": "moodboard", "list": "GET /api/moodboards"},
    "character": {"noun": "character", "list": "GET /api/characters"},
}

# Internal keys that became a public param, named in the refusal.
PUBLIC_INSTEAD = {"_moodboardId": "moodboard", "_characterId": "character"}


def internal_keys(params: Mapping[str, Any] | Iterable[str]) -> list[str]:
    """The keys in ``params`` an agent may not write."""
    return [key for key in params
            if isinstance(key, str) and key.startswith("_") and key not in BILLING_PARAMS]


def internal_refusal(label: str, key: str) -> str:
    """The message for an agent that tried to write internal ``key``."""
    public = PUBLIC_INSTEAD.get(key)
    hint = (f"set {public} instead" if public
            else "`nebula info <definition>` or describe_node lists the params you can set")
    return f"{label}.{key[:40]} is internal (the canvas keeps it); {hint}"


def asset_params(definition: Mapping[str, Any] | None) -> list[tuple[str, str]]:
    """(param key, asset kind) for each asset-reference param of a definition."""
    found: list[tuple[str, str]] = []
    for group in ("params", "sharedParams", "falParams", "directParams"):
        for param in (definition or {}).get(group) or []:
            kind = param.get("type") if isinstance(param, dict) else None
            if kind in ASSET_PARAM_TYPES:
                found.append((str(param.get("key")), str(kind)))
    return found
