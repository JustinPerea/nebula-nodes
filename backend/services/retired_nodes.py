"""Nodes whose provider models were shut down, and what saved graphs become.

A retired definition is removed from the catalog, so a saved graph that still
names it would fail to load. Every path that brings nodes into the graph
(boot restore, project snapshots, graph-file import, proposals) runs
``migrate_node`` first. The replacement is the one the provider names, and
the node's title says what happened, so the change is visible on the canvas.

Imagen 4 (all three models) was shut down by Google on 2026-08-17; Google
names Nano Banana 2.1 as the replacement
(https://ai.google.dev/gemini-api/docs/deprecations, checked 2026-10-10).

Some nodes stay but lose a model option: Veo 3.0, 3.0 Fast and 2.0 were shut
down on 2026-06-30, so a saved ``veo-3`` node on one of them moves to the
matching Veo 3.1 model (``RETIRED_PARAMS``).

Runway retired Gen-3 Alpha Turbo (``gen3a_turbo``) and Gen-4 Aleph
(``gen4_aleph``) on 2026-07-30 ("Requests that use these model identifiers
will fail", https://docs.dev.runwayml.com/llms-full.txt changelog, read
2026-10-14). Runway names Gen-4.5 or Gen-4 Turbo for Gen-3a and Aleph 2.0
(``aleph2``) for Gen-4 Aleph. ``veo3`` is no longer in Runway's
image_to_video / text_to_video request schema (openapi.json, same date; no
dated changelog entry). Saved ``runway-video`` nodes move gen3a_turbo to
gen4_turbo (both image-to-video only, same 2-10 s range, so a saved
image-to-video node keeps working; a text-only one gets the handler's "needs
an image" error) and veo3 to veo3.1. Saved ``runway-aleph`` nodes move to
aleph2. All of these shutdowns are past, so nothing is date-gated.
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


# Veo 2 offered 5 s, which 3.1 doesn't; 6 s is the nearest without cutting the clip short.
_VEO_MODELS = {
    "veo-3.0-generate-001": "veo-3.1-generate-preview",
    "veo-3.0-fast-generate-001": "veo-3.1-fast-generate-preview",
    "veo-2.0-generate-001": "veo-3.1-generate-preview",
}


def _veo_params(params: dict[str, Any]) -> dict[str, Any]:
    if params.get("model") not in _VEO_MODELS:
        return params
    migrated = {**params, "model": _VEO_MODELS[params["model"]]}
    if str(migrated.get("duration")) == "5":
        migrated["duration"] = "6"
    return migrated


# Veo 3.1 on Runway takes 4, 6 or 8 s; a saved duration rounds up to the
# nearest of those (never shorter than what was saved, capped at 8).
def _veo31_duration(value: Any) -> Any:
    try:
        seconds = float(value)
    except (TypeError, ValueError):
        return value
    return next((d for d in (4, 6, 8) if seconds <= d), 8)


def _runway_video_params(params: dict[str, Any]) -> dict[str, Any]:
    model = params.get("model")
    if model == "gen3a_turbo":
        return {**params, "model": "gen4_turbo"}
    if model == "veo3":
        # No saved duration means the node ran at the 5 s default, which Veo 3.1
        # doesn't take; round that up to 6 like an explicit 5.
        saved = params.get("duration")
        duration = 5 if saved is None or saved == "" else saved
        return {**params, "model": "veo3.1", "duration": _veo31_duration(duration)}
    return params


def _runway_aleph_params(params: dict[str, Any]) -> dict[str, Any]:
    if params.get("model") == "gen4_aleph":
        return {**params, "model": "aleph2"}
    return params


RETIRED_PARAMS: dict[str, Any] = {
    "veo-3": _veo_params,
    "runway-video": _runway_video_params,
    "runway-aleph": _runway_aleph_params,
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
