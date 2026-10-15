"""Nodes whose provider models were shut down, and what saved graphs become.

A retired definition is removed from the catalog, so a saved graph that still
names it would fail to load. Every path that brings nodes into the graph
(boot restore, project snapshots, graph-file import, proposals) runs
``migrate_node`` first. The replacement is the one the provider names, and
the node's title says what happened, so the change is visible on the canvas.

Imagen 4 (all three models) was shut down by Google on 2026-08-17; Google
names Nano Banana 2.1 as the replacement
(https://ai.google.dev/gemini-api/docs/deprecations, checked 2026-10-10).

OpenAI shut down the Sora 2 API on 2026-09-24 and says "There is no one-to-one
replacement API" (https://developers.openai.com/api/docs/models/sora-2,
checked 2026-10-14); fal's sora-2 endpoints ran on it. Saved Sora 2 nodes
become Veo 3.1 Fast, the closest maker-direct match: text or first frame to
video with sound, at the same $0.10/s at 720p that Sora 2 listed. Sora 2 Pro
becomes Veo 3.1. Veo stops at 8 s, so a longer Sora clip becomes 8 s. The title
says what happened, and the retirement message names the other choices.

Some nodes stay but lose a model option (``RETIRED_PARAMS``):

- Veo 3.0, 3.0 Fast and 2.0 were shut down on 2026-06-30, so a saved ``veo-3``
  node on one of them moves to the matching Veo 3.1 model.
- The Gemini API shuts down its Veo 3.1 previews on 2026-10-22 and offers no
  GA Veo; Vertex AI serves the same models as ``veo-3.1-*-001``
  (https://ai.google.dev/gemini-api/docs/deprecations, checked 2026-10-14).
  The node now stores the Vertex IDs, so a saved preview ID is renamed. The
  model doesn't change, so this rename isn't date-gated.
- OpenAI shuts down ``gpt-image-1`` on 2026-10-23 and names
  ``gpt-image-2.5-sunburst`` or ``gpt-image-2.5-flare`` as the replacement
  (https://developers.openai.com/api/docs/deprecations, checked 2026-10-14).
  From that date a saved GPT Image node on it moves to Flare ("our fastest
  model for high-quality, everyday image generation") on the generate node and
  Sunburst ("for workflows where editing precision matters most") on the edit
  node. Its sizes and qualities all exist on 2.5.
- Meshy no longer lists ``meshy-5`` (``ai_model`` enums in
  https://docs.meshy.ai/openapi.yaml, checked 2026-10-14), so a saved Meshy
  node on it moves to ``meshy-6``, "the previous generation".
- Meshy retires ``model_type: lowpoly`` on 2026-10-30 ("after that date it
  returns an error. Use ``smart-topology`` (Meshy T2) instead"). From that date
  a saved lowpoly node moves to smart-topology. Smart topology makes triangles
  only, at most 15,000 faces, so quad becomes triangle and a larger polycount
  becomes 15,000.
- The Gemini API shuts down ``gemini-2.5-flash-preview-tts``,
  ``gemini-2.5-pro-preview-tts`` and ``gemini-3.1-flash-tts-preview`` on
  2026-11-17 and names "gemini-3.8-flash-tts or gemini-3.8-flash-lite-tts"
  (https://ai.google.dev/gemini-api/docs/deprecations, checked 2026-10-14).
  From that date the 2.5 models move to 3.8 Flash TTS and 3.1 Flash moves to
  3.8 Flash-Lite TTS, which Google calls the "recommended replacement for
  gemini-3.1-flash-tts-preview". Voices are the same 30.

A migration for a shutdown that is still ahead is date-gated (``_today``):
until the shutdown the saved value keeps working and stays as it is. The
``RETIRED_PARAMS`` fixes also run on every run request and in the engine,
on node create/update, and in price estimates (``migrate_params``), so a
canvas opened before a shutdown and run after it sends the replacement.

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


SORA_2_LABEL = "Veo 3.1 Fast (was Sora 2)"
SORA_2_I2V_LABEL = "Veo 3.1 Fast (was Sora 2 Image-to-Video)"
_SORA_ALTERNATIVES = ("grok-imagine-video", "runway-video")


def _from_sora_2(params: dict[str, Any]) -> dict[str, Any]:
    pro = str(params.get("model") or "").lower() == "pro"
    migrated: dict[str, Any] = {"model": "veo-3.1-generate-001" if pro else "veo-3.1-fast-generate-001"}
    if params.get("aspect_ratio") in ("16:9", "9:16"):
        migrated["aspectRatio"] = params["aspect_ratio"]
    if params.get("resolution") in ("720p", "1080p"):
        migrated["resolution"] = params["resolution"]
    try:
        seconds = int(str(params.get("duration")).rstrip("s"))
    except ValueError:
        seconds = None
    if seconds is not None:
        migrated["duration"] = "4" if seconds <= 4 else "6" if seconds <= 6 else "8"
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
    "sora-2": {
        "replacement": "veo-3",
        "label": SORA_2_LABEL,
        "displayName": "Sora 2 (sunsets Sep '26)",
        "params": _from_sora_2,
        "reason": "OpenAI shut down the Sora 2 API on 2026-09-24 and names no replacement",
        "alternatives": _SORA_ALTERNATIVES,
    },
    "sora-2-i2v": {
        "replacement": "veo-3",
        "label": SORA_2_I2V_LABEL,
        "displayName": "Sora 2 Image-to-Video",
        "params": _from_sora_2,
        "reason": "OpenAI shut down the Sora 2 API on 2026-09-24 and names no replacement",
        "alternatives": _SORA_ALTERNATIVES,
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


def _model_after(shutdown: date, models: dict[str, str]):
    """Move a saved ``model`` to its replacement once ``shutdown`` has passed."""
    def fix(params: dict[str, Any]) -> dict[str, Any]:
        if params.get("model") not in models or _today() < shutdown:
            return params
        return {**params, "model": models[params["model"]]}
    return fix


GPT_IMAGE_1_SHUTDOWN = date(2026, 10, 23)
MESHY_LOWPOLY_SHUTDOWN = date(2026, 10, 30)
MESHY_SMART_TOPOLOGY_MAX_POLYCOUNT = 15000


def _meshy_params(params: dict[str, Any]) -> dict[str, Any]:
    migrated = dict(params)
    if migrated.get("ai_model") == "meshy-5":
        migrated["ai_model"] = "meshy-6"
    if migrated.get("model_type") == "lowpoly" and _today() >= MESHY_LOWPOLY_SHUTDOWN:
        migrated["model_type"] = "smart-topology"
        if migrated.get("topology") == "quad":
            migrated["topology"] = "triangle"
        try:
            polycount = int(migrated.get("target_polycount"))
        except (TypeError, ValueError):
            polycount = None
        if polycount is None or polycount > MESHY_SMART_TOPOLOGY_MAX_POLYCOUNT:
            migrated["target_polycount"] = MESHY_SMART_TOPOLOGY_MAX_POLYCOUNT
    return migrated

GEMINI_TTS_PREVIEWS_SHUTDOWN = date(2026, 11, 17)
_GEMINI_TTS_MODELS = {
    "gemini-2.5-flash-preview-tts": "gemini-3.8-flash-tts",
    "gemini-2.5-pro-preview-tts": "gemini-3.8-flash-tts",
    "gemini-3.1-flash-tts-preview": "gemini-3.8-flash-lite-tts",
}

RETIRED_PARAMS: dict[str, Any] = {
    "veo-3": _veo_params,
    "gpt-image-1-generate": _model_after(GPT_IMAGE_1_SHUTDOWN, {"gpt-image-1": "gpt-image-2.5-flare"}),
    "gpt-image-1-edit": _model_after(GPT_IMAGE_1_SHUTDOWN, {"gpt-image-1": "gpt-image-2.5-sunburst"}),
    "meshy-text-to-3d": _meshy_params,
    "meshy-image-to-3d": _meshy_params,
    "meshy-multi-image-to-3d": _meshy_params,
    "meshy-retexture": _meshy_params,
    "gemini-tts": _model_after(GEMINI_TTS_PREVIEWS_SHUTDOWN, _GEMINI_TTS_MODELS),
    "runway-video": _runway_video_params,
    "runway-aleph": _runway_aleph_params,
}


def migrate_params(definition_id: str, params: dict[str, Any] | None) -> dict[str, Any]:
    """``params`` with any retired option values replaced (``RETIRED_PARAMS``).

    Staging runs this through ``migrate_node``; run requests, node creation and
    param updates, and price estimates run it too, so a canvas opened before a
    shutdown date and run after it sends the replacement, not the dead value."""
    fix = RETIRED_PARAMS.get(definition_id)
    return fix(dict(params or {})) if fix else dict(params or {})


def migrate_param_update(
    definition_id: str, before: dict[str, Any] | None, update: dict[str, Any],
) -> dict[str, Any]:
    """A partial param update with retired values replaced.

    Migrates the merged params, so a fix that depends on other params (Meshy
    lowpoly clamps the polycount) sees the stored ones, and returns the
    updated keys plus any stored key the fix changed."""
    before = dict(before or {})
    merged = migrate_params(definition_id, {**before, **update})
    return {k: v for k, v in merged.items() if k in update or before.get(k, _MISSING) != v}


_MISSING = object()


def default_until(shutdown: date, old: str, new: str) -> str:
    """A handler's fallback model for a node with no stored ``model``: the old
    default until ``shutdown``, so the default doesn't change before the date."""
    return old if _today() < shutdown else new


def migrate_node(
    definition_id: str, params: dict[str, Any] | None, label: str | None = None,
) -> tuple[str, dict[str, Any], str | None]:
    """(definitionId, params, label) for a node, replaced if its definition is retired.

    A node the person renamed keeps its own title; any other takes the
    retirement title, so the canvas says what changed."""
    retired = RETIRED.get(definition_id)
    if retired is None:
        return definition_id, migrate_params(definition_id, params), label
    custom = label if isinstance(label, str) and label.strip() and label.strip() != retired["displayName"] else None
    return retired["replacement"], retired["params"](dict(params or {})), custom or retired["label"]


def retired_message(definition_id: str) -> str | None:
    """Why a definition is gone and what to use instead, for error messages."""
    retired = RETIRED.get(definition_id)
    if retired is None:
        return None
    message = f"'{definition_id}' was retired ({retired['reason']}). Use '{retired['replacement']}' instead"
    alternatives = retired.get("alternatives")
    if alternatives:
        message += " (or " + " or ".join(f"'{a}'" for a in alternatives) + ")"
    return message + "."
