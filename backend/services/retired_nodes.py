"""Nodes whose provider models were shut down, and what saved graphs become.

A retired definition is removed from the catalog, so a saved graph that still
names it would fail to load. Every path that brings nodes into the graph
(boot restore, project snapshots, graph-file import, proposals) runs
``migrate_node`` first. The replacement is the one the provider names, and
the node's title says what happened, so the change is visible on the canvas.

Imagen 4 (all three models) was shut down by Google on 2026-08-17; Google
names Nano Banana 2.1 as the replacement
(https://ai.google.dev/gemini-api/docs/deprecations, checked 2026-10-10).
"""
from __future__ import annotations

from typing import Any

IMAGEN_4_LABEL = "Nano Banana (was Imagen 4)"

# Imagen 4 aspect ratios all exist on Nano Banana 2.1. Its 1K/2K sizes too.
_IMAGEN_ASPECTS = {"1:1", "4:3", "3:4", "16:9", "9:16"}
_IMAGEN_SIZES = {"1K", "2K"}


def _from_imagen_4(params: dict[str, Any]) -> dict[str, Any]:
    migrated: dict[str, Any] = {"model": "gemini-nano-banana-2.1"}
    aspect = params.get("aspectRatio")
    if aspect in _IMAGEN_ASPECTS:
        migrated["aspect_ratio"] = aspect
    size = params.get("imageSize")
    if size in _IMAGEN_SIZES:
        migrated["imageSize"] = size
    # Frontend-internal keys (previews, notes) carry over unchanged.
    migrated.update({k: v for k, v in params.items() if k.startswith("_")})
    return migrated


RETIRED: dict[str, dict[str, Any]] = {
    "imagen-4-generate": {
        "replacement": "nano-banana",
        "label": IMAGEN_4_LABEL,
        "displayName": "Imagen 4",
        "params": _from_imagen_4,
        "reason": "Google shut down Imagen 4 on 2026-08-17",
    },
}


def migrate_node(
    definition_id: str, params: dict[str, Any] | None, label: str | None = None,
) -> tuple[str, dict[str, Any], str | None]:
    """(definitionId, params, label) for a node, replaced if its definition is retired.

    A node the person renamed keeps its own title; any other takes the
    retirement title, so the canvas says what changed."""
    retired = RETIRED.get(definition_id)
    if retired is None:
        return definition_id, dict(params or {}), label
    custom = label if isinstance(label, str) and label.strip() and label.strip() != retired["displayName"] else None
    return retired["replacement"], retired["params"](dict(params or {})), custom or retired["label"]


def retired_message(definition_id: str) -> str | None:
    """Why a definition is gone and what to use instead, for error messages."""
    retired = RETIRED.get(definition_id)
    if retired is None:
        return None
    return f"'{definition_id}' was retired ({retired['reason']}). Use '{retired['replacement']}' instead."
