"""Nodes whose provider models were shut down, and what saved graphs become.

A retired definition is removed from the catalog, so a saved graph that still
names it would fail to load. Every path that brings nodes into the graph
(boot restore, project snapshots, graph-file import, proposals) runs
``migrate_node`` first. The replacement is the one the provider names, and
the node's title says what happened, so the change is visible on the canvas.

Imagen 4 (all three models) was shut down by Google on 2026-08-17; Google
names Nano Banana 2.1 as the replacement
(https://ai.google.dev/gemini-api/docs/deprecations, checked 2026-10-10).

Some nodes stay but lose a model option (``RETIRED_PARAMS``):

- Veo 3.0, 3.0 Fast and 2.0 were shut down on 2026-06-30, so a saved ``veo-3``
  node on one of them moves to the matching Veo 3.1 model.
- The Gemini API shuts down its Veo 3.1 previews on 2026-10-22 and offers no
  GA Veo; Vertex AI serves the same models as ``veo-3.1-*-001``
  (https://ai.google.dev/gemini-api/docs/deprecations, checked 2026-10-14).
  The node now stores the Vertex IDs, so a saved preview ID is renamed. The
  model doesn't change, so this rename isn't date-gated.

A migration for a shutdown that is still ahead is date-gated (``_today``):
until the shutdown the saved value keeps working and stays as it is.
"""
from __future__ import annotations

from datetime import date
from typing import Any


def _today() -> date:
    """Today, for date-gated migrations. Tests patch it."""
    return date.today()

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


# Veo 2 offered 5 s, which 3.1 doesn't; 6 s is the nearest without cutting the clip short.
_VEO_MODELS = {
    "veo-3.0-generate-001": "veo-3.1-generate-001",
    "veo-3.0-fast-generate-001": "veo-3.1-fast-generate-001",
    "veo-2.0-generate-001": "veo-3.1-generate-001",
    "veo-3.1-generate-preview": "veo-3.1-generate-001",
    "veo-3.1-fast-generate-preview": "veo-3.1-fast-generate-001",
    "veo-3.1-lite-generate-preview": "veo-3.1-lite-generate-001",
}


def _veo_params(params: dict[str, Any]) -> dict[str, Any]:
    if params.get("model") not in _VEO_MODELS:
        return params
    migrated = {**params, "model": _VEO_MODELS[params["model"]]}
    if str(migrated.get("duration")) == "5":
        migrated["duration"] = "6"
    return migrated


RETIRED_PARAMS: dict[str, Any] = {
    "veo-3": _veo_params,
}


def migrate_node(
    definition_id: str, params: dict[str, Any] | None, label: str | None = None,
) -> tuple[str, dict[str, Any], str | None]:
    """(definitionId, params, label) for a node, replaced if its definition is retired.

    A node the person renamed keeps its own title; any other takes the
    retirement title, so the canvas says what changed."""
    retired = RETIRED.get(definition_id)
    if retired is None:
        fix = RETIRED_PARAMS.get(definition_id)
        return definition_id, fix(dict(params or {})) if fix else dict(params or {}), label
    custom = label if isinstance(label, str) and label.strip() and label.strip() != retired["displayName"] else None
    return retired["replacement"], retired["params"](dict(params or {})), custom or retired["label"]


def retired_message(definition_id: str) -> str | None:
    """Why a definition is gone and what to use instead, for error messages."""
    retired = RETIRED.get(definition_id)
    if retired is None:
        return None
    return f"'{definition_id}' was retired ({retired['reason']}). Use '{retired['replacement']}' instead."
