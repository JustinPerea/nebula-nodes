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

Some nodes weren't shut down but folded into a one-node-per-model node with
a provider switcher (``MERGED``, docs/PROVIDER-ROUTES.md). Nebula's three
synced Krea FLUX nodes (FLUX 3 Video, FLUX Video Edit, FLUX Video Upscale on
Krea's gateway) became Krea routes on ``flux-3-video``, ``flux-video-edit``
and ``flux-video-upscale`` on 2026-10-15. A saved one loads as the new node
set to the Krea route (``_provider: "krea"``) with its ``_kreaAuth`` kept, so
the same provider bills it the same way (API token or plan) as before. The
person's title stays; values are renamed where the new node spells them
differently (``720p`` is ``hd``). The new nodes read the prompt and media
only from ports, so a value typed on the old node moves into a Text, Image or
Video Input node wired to that port (``migrate_graph``). The old nodes' Krea
job outputs (All videos, All artifacts, Job) have no counterpart; a
connection from one is dropped, and the load says which.
"""
from __future__ import annotations

from datetime import date
from typing import Any, Callable


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


# -- folded nodes (MERGED) ------------------------------------------------------

# node_route.PROVIDER_PARAM; spelled out so this module imports nothing.
PROVIDER_PARAM = "_provider"
MERGED_ROUTE = "krea"
# The old Krea handler's billing mode when a node saved none
# (handlers/krea_gateway.py: params.get("_kreaAuth", "api-token")).
_KREA_DEFAULT_AUTH = "api-token"

# Values typed on an old Krea node that the new node reads only from a port:
# param key -> (input node, its value param, its output port). The old Krea
# handler sent a wired port's value instead of the typed one, so a typed value
# under a wired port was never used and is dropped.
_TEXT_INPUT = ("text-input", "value", "text")
_IMAGE_INPUT = ("image-input", "filePath", "image")
_VIDEO_INPUT = ("video-input", "filePath", "video")


def _folded(kept: tuple[str, ...], value_maps: dict[str, dict[Any, Any]] | None = None):
    """Params for a folded Krea node: the kept keys (renamed values where
    ``value_maps`` says), set to the Krea route with the saved billing mode.
    A saved value outside the old options is kept as it is; the run then
    stops before billing (node_route.route_block), never a silent rewrite."""
    value_maps = value_maps or {}

    def migrate(params: dict[str, Any]) -> dict[str, Any]:
        migrated: dict[str, Any] = {}
        for key in kept:
            if key in params:
                value = params[key]
                mapping = value_maps.get(key, {})
                migrated[key] = mapping.get(value, value) if isinstance(value, (str, int, float)) else value
        # Frontend-internal keys (previews, notes, _kreaAuth) carry over.
        migrated.update({k: v for k, v in params.items() if k.startswith("_")})
        migrated[PROVIDER_PARAM] = MERGED_ROUTE
        migrated["_kreaAuth"] = params.get("_kreaAuth") or _KREA_DEFAULT_AUTH
        return migrated
    return migrate


_FOLD_REASON = "it is now one node with a provider switcher, set to Krea"

# Old id -> the node it folded into. ``inputs`` and ``outputs`` map the old
# port ids to the new ones (None: no counterpart). ``typed`` lists the old
# params whose value moves to an input node wired to that new port. Old ports
# and params from backend/data/node_definitions.json and the Krea catalog at
# ab436602 (pr3-spec/migration-map.json, 2026-10-15).
_KREA_JOB_OUTPUTS = {"video": "video", "videos": None, "artifacts": None, "job": None}
MERGED: dict[str, dict[str, Any]] = {
    "krea-video-black-forest-labs-flux-3-video": {
        "into": "flux-3-video",
        "displayName": "Flux 3 Video (Krea)",
        "params": _folded(("duration", "resolution", "aspect_ratio", "generate_audio"),
                          {"resolution": {"720p": "hd", "1080p": "fhd"}}),
        "inputs": {"prompt": "prompt", "start_image": "start_image", "start_video": "start_video",
                   "end_image": "end_image"},
        "outputs": _KREA_JOB_OUTPUTS,
        "typed": {"prompt": _TEXT_INPUT, "start_image": _IMAGE_INPUT, "start_video": _VIDEO_INPUT,
                  "end_image": _IMAGE_INPUT},
        "reason": _FOLD_REASON,
    },
    "krea-video-black-forest-labs-flux-video-edit": {
        "into": "flux-video-edit",
        "displayName": "Flux Video Edit (Krea)",
        "params": _folded(()),
        "inputs": {"prompt": "prompt", "start_video": "start_video"},
        "outputs": _KREA_JOB_OUTPUTS,
        "typed": {"prompt": _TEXT_INPUT, "start_video": _VIDEO_INPUT},
        "reason": _FOLD_REASON,
    },
    "krea-enhance-black-forest-labs-flux-video-upscale": {
        "into": "flux-video-upscale",
        "displayName": "Flux Video Upscale (Krea)",
        "params": _folded(("creativity", "upscale_factor"), {"creativity": {"precise": 0, "creative": 1}}),
        "inputs": {"prompt": "prompt", "video_url": "video"},
        "outputs": _KREA_JOB_OUTPUTS,
        "typed": {"prompt": _TEXT_INPUT, "video_url": _VIDEO_INPUT},
        "reason": _FOLD_REASON,
    },
}


def merged_into(definition_id: str) -> str:
    """The node a folded definition became, or the id itself."""
    merged = MERGED.get(definition_id)
    return merged["into"] if merged else definition_id


def migrate_node(
    definition_id: str, params: dict[str, Any] | None, label: str | None = None,
) -> tuple[str, dict[str, Any], str | None]:
    """(definitionId, params, label) for a node, replaced if its definition is
    retired or folded into another.

    A node the person renamed keeps its own title. Any other retired node
    takes the retirement title, so the canvas says what changed; a folded one
    takes the new node's own name (it is the same model, on the same
    provider). Values typed into a folded node's ports are dropped here;
    ``migrate_graph`` moves them to input nodes first."""
    merged = MERGED.get(definition_id)
    if merged is not None:
        custom = label if isinstance(label, str) and label.strip() and label.strip() != merged["displayName"] else None
        return merged["into"], merged["params"](dict(params or {})), custom
    retired = RETIRED.get(definition_id)
    if retired is None:
        return definition_id, migrate_params(definition_id, params), label
    custom = label if isinstance(label, str) and label.strip() and label.strip() != retired["displayName"] else None
    return retired["replacement"], retired["params"](dict(params or {})), custom or retired["label"]


_OUTPUT_LABELS = {"videos": "All videos", "artifacts": "All artifacts", "job": "Job"}


def migrate_graph(
    nodes: list[dict[str, Any]],
    edges: list[dict[str, Any]],
    *,
    key: str = "id",
    new_id: Callable[[str], str] | None = None,
) -> tuple[list[dict[str, Any]], list[dict[str, Any]], list[str]]:
    """A saved graph with its folded nodes (``MERGED``) moved onto the new
    nodes: (nodes, edges, warnings). Other nodes are left for ``migrate_node``.

    ``nodes`` carry ``key`` (their reference), ``definitionId``, ``params``
    and optionally ``label``, ``position`` and ``outputs``; ``edges`` carry
    source/sourceHandle/target/targetHandle by reference. Other fields pass
    through. On a folded node:

    - the node becomes its new definition (``migrate_node``) and its saved
      outputs keep only the ports the new node has;
    - connections into it and out of it use the new port ids; one from a
      Krea job output with no counterpart is dropped, with a warning;
    - a prompt or media value typed on it, with nothing wired to that port,
      becomes a Text, Image or Video Input node wired to it (the new nodes
      read these only from ports). ``new_id(hint)`` names the added node;
      by default ``<ref>-<port>``. It goes 360 px to the left of the node,
      moved down past any positioned node it would cover (``_free_spot``).

    Added nodes have no ``label``; added edges have no ``id``."""
    if not any(node.get("definitionId") in MERGED for node in nodes):
        return nodes, edges, []
    taken = {str(node.get(key)) for node in nodes}

    def fresh(hint: str) -> str:
        if new_id is not None:
            return new_id(hint)
        candidate, n = hint, 2
        while candidate in taken:
            candidate, n = f"{hint}-{n}", n + 1
        taken.add(candidate)
        return candidate

    folded: dict[str, dict[str, Any]] = {}
    names: dict[str, str] = {}
    for node in nodes:
        ref = str(node.get(key))
        names[ref] = node.get("label") if isinstance(node.get("label"), str) and node["label"].strip() else ref
        if node.get("definitionId") in MERGED:
            folded[ref] = MERGED[node["definitionId"]]
            merged = folded[ref]
            if not (isinstance(node.get("label"), str) and node["label"].strip()):
                names[ref] = merged["displayName"]

    warnings: list[str] = []
    out_edges: list[dict[str, Any]] = []
    wired: set[tuple[str, str]] = set()
    for edge in edges:
        edge = dict(edge)
        source, target = str(edge.get("source")), str(edge.get("target"))
        if source in folded and edge.get("sourceHandle") in folded[source]["outputs"]:
            handle = folded[source]["outputs"][edge["sourceHandle"]]
            if handle is None:
                warnings.append(
                    f"'{names[source]}' no longer has its Krea '{_OUTPUT_LABELS.get(edge['sourceHandle'], edge['sourceHandle'])}' "
                    f"output, so its connection to '{names.get(target, target)}' was removed.")
                continue
            edge["sourceHandle"] = handle
        if target in folded and edge.get("targetHandle") in folded[target]["inputs"]:
            edge["targetHandle"] = folded[target]["inputs"][edge["targetHandle"]]
        if target in folded:
            wired.add((target, str(edge.get("targetHandle"))))
        out_edges.append(edge)

    occupied = [spot for spot in (_spot(node) for node in nodes) if spot is not None]
    out_nodes: list[dict[str, Any]] = []
    for node in nodes:
        ref = str(node.get(key))
        merged = folded.get(ref)
        if merged is None:
            out_nodes.append(node)
            continue
        params = node.get("params") if isinstance(node.get("params"), dict) else {}
        definition_id, new_params, label = migrate_node(str(node["definitionId"]), params, node.get("label"))
        migrated = {**node, "definitionId": definition_id, "params": new_params}
        if label is None:
            migrated.pop("label", None)
        else:
            migrated["label"] = label
        if isinstance(node.get("outputs"), dict):
            migrated["outputs"] = {
                merged["outputs"][handle]: value for handle, value in node["outputs"].items()
                if merged["outputs"].get(handle)
            }
        out_nodes.append(migrated)
        position = _spot(node)
        for param, (input_id, value_key, output_port) in merged["typed"].items():
            value = params.get(param)
            port = merged["inputs"][param]
            if not isinstance(value, str) or not value.strip() or (ref, port) in wired:
                continue
            added: dict[str, Any] = {key: fresh(f"{ref}-{port}"), "definitionId": input_id, "params": {value_key: value}}
            if position is not None:
                spot = _free_spot(position[0] - 360.0, position[1], occupied)
                occupied.append(spot)
                added["position"] = {"x": spot[0], "y": spot[1]}
            out_nodes.append(added)
            out_edges.append({"source": added[key], "sourceHandle": output_port, "target": ref, "targetHandle": port})
            wired.add((ref, port))
    return out_nodes, out_edges, warnings


# The room an added input node keeps clear around a saved node: wider than a
# card (route-table cards reach 300 px) and taller than a video card with its
# preview (about 380 px with five ports) or a text input (about 240 px).
_NODE_W, _NODE_H, _STEP = 320.0, 400.0, 40.0


def _spot(node: dict[str, Any]) -> tuple[float, float] | None:
    position = node.get("position")
    if not isinstance(position, dict):
        return None
    try:
        return float(position["x"]), float(position["y"])
    except (KeyError, TypeError, ValueError):
        return None


def _free_spot(x: float, y: float, occupied: list[tuple[float, float]]) -> tuple[float, float]:
    """(x, y), or the first spot below it that covers no positioned node."""
    def covers(top: float) -> bool:
        return any(abs(x - ox) < _NODE_W and abs(top - oy) < _NODE_H for ox, oy in occupied)

    while covers(y):
        y += _STEP
    return x, y


def retired_message(definition_id: str) -> str | None:
    """Why a definition is gone and what to use instead, for error messages."""
    merged = MERGED.get(definition_id)
    if merged is not None:
        return f"'{definition_id}' is now part of '{merged['into']}' (provider: Krea). Use '{merged['into']}' instead."
    retired = RETIRED.get(definition_id)
    if retired is None:
        return None
    message = f"'{definition_id}' was retired ({retired['reason']}). Use '{retired['replacement']}' instead"
    alternatives = retired.get("alternatives")
    if alternatives:
        message += " (or " + " or ".join(f"'{a}'" for a in alternatives) + ")"
    return message + "."
