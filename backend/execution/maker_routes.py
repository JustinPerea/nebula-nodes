"""Run a fal or Krea copy of a model on its maker's API with the person's own key.

A dual-route node lists the maker's key first in ``envKeyName`` and names it
in ``directKeyName``. :func:`dual_route` builds the registry handler for such
a node. Each run:

1. picks its route with services/node_route.py ``select_route``, the same
   rule pricing, the spend gate, readiness and the cache key use (Krea plan
   when chosen, else the maker key, else the fal/Krea copy);
2. works on a ``model_copy`` of the node, never the persisted node;
3. keeps only the params that route takes (``sharedParams`` plus its own
   group: ``directParams`` or ``falParams``; for a Krea copy the fallback
   group is its Krea request schema). The graph seeds defaults from every
   group, and fal forwards every param it gets (a direct-only default would
   be a billed 422) while Krea refuses unknown fields;
4. on the direct route, translates the copy's params (fal's or Krea's names)
   into the maker handler's.

A route-table node (definition ``routes``) gets :func:`multi_route` instead:
the same rule picks one of its N routes (the saved ``_provider``, or Auto),
and that route's client runs it (execution/route_clients.py).

The translators here are pinned to the maker's documentation; each says what
it drops. Prices are written in the node's own param names
(data/model_pricing.json ``routes``), so they don't depend on the translation.
"""
from __future__ import annotations

import copy
import json
from functools import lru_cache, partial
from typing import Any, Awaitable, Callable, Mapping

from execution import maker_routes_elevenlabs
from execution.missing_credential import MissingCredentialError
from models.graph import GraphNode, PortValueDict
from services import node_route
from execution.person_line import as_person_line, count_field, key_line, key_phrase, with_call_facts, with_person_line

Handler = Callable[[GraphNode, dict[str, PortValueDict], dict[str, str]], Awaitable[dict[str, Any]]]
Translate = Callable[
    [GraphNode, dict[str, PortValueDict]], tuple[GraphNode, dict[str, PortValueDict]]
]


@lru_cache(maxsize=1)
def _definitions() -> dict[str, dict[str, Any]]:
    from services.node_registry import NodeRegistry

    return NodeRegistry().get_all()


def definition_for(definition_id: str) -> dict[str, Any]:
    definition = _definitions().get(definition_id)
    if not definition:
        raise ValueError(f"Unknown node definition {definition_id}")
    return definition


def route_node(node: GraphNode, allowed: set[str], extra: Mapping[str, Any] | None = None) -> GraphNode:
    """A per-run copy of ``node`` with only ``allowed`` params (deep-copied)."""
    params = {key: copy.deepcopy(value) for key, value in node.params.items() if key in allowed}
    params.update(extra or {})
    return node.model_copy(update={"params": params})


def _blocked_reason(definition: Mapping[str, Any], block: node_route.DirectBlock, direct_key: str) -> str:
    """Why a run can't use the saved maker key, for the missing-key error."""
    if block.reason == node_route.BLOCKED:
        return f"{block.param} is only supported on the {node_route.fallback_provider(definition) or 'copy'} route"
    if block.reason == node_route.REQUIRES:
        return f"this recipe can't run on {direct_key} because it needs {block.param} set"
    if block.reason == node_route.RETIRED:
        return f"this recipe can't run on {direct_key} because the maker retired this model on {block.on}"
    if block.reason == node_route.SIZE:
        return f"this recipe can't run on {direct_key} because the maker can't render its {block.param} exactly"
    return f"this recipe can't run on {direct_key} because the maker doesn't take {block.detail}"


def _blocked_key_line(definition: Mapping[str, Any], direct_key: str,
                      block: node_route.DirectBlock | None = None) -> str:
    """The person's line for a run the saved maker key can't take (error copy
    3c-2; GM's words since round 3f: "These settings need your {other
    provider} {key kind}. Add it in Settings, then run the node again.", and
    for several keys "... Add one in Settings, ..."). A BLOCKED setting is one
    only the copy route takes, so it names the copy's own key (the
    fallback provider's), not every other key."""
    keys = node_route.fallback_keys(definition)
    if block is not None and block.reason == node_route.BLOCKED and len(keys) > 1:
        keys = keys[:1]
    phrase = key_phrase(keys)
    if phrase is None:
        return "These settings need another provider's key. Add it in Settings, then run the node again."
    it = "one" if len(keys) > 1 else "it"
    return f"These settings need your {phrase}. Add {it} in Settings, then run the node again."


def dual_route(*, direct: Handler, fallback: Handler, translate: Translate | None = None) -> Handler:
    """The registry handler for a dual-route node (see the module docstring).

    ``fallback`` gets the route-filtered copy and the inputs; it adds its own
    endpoint or account handling. ``direct`` gets the translated copy."""

    async def _route(node: GraphNode, inputs: dict[str, PortValueDict], api_keys: dict[str, str]) -> dict[str, Any]:
        definition = definition_for(node.definition_id)
        routed_params = node_route.with_wired_blockers(definition, node.params, node_route.filled_ports(inputs))
        route = node_route.select_route(definition, routed_params, api_keys)
        if route.kind == node_route.UNSET:
            block = node_route.direct_block(definition, routed_params)
            set_direct = [k for k in node_route.direct_keys(definition) if str(api_keys.get(k) or "").strip()]
            if block is not None and set_direct:
                # The maker key is saved, but this run can only go to the copy
                # (a Krea-only field, Runway TTS without an ElevenLabs voice_id):
                # name the key that would run it, and why.
                raise with_person_line(MissingCredentialError(
                    f"{' or '.join(node_route.fallback_keys(definition))} is required: "
                    f"{_blocked_reason(definition, block, set_direct[0])}"), _blocked_key_line(definition, set_direct[0], block))
            raise MissingCredentialError(f"{' or '.join(node_route.env_keys(definition))} is required")
        if route.kind == node_route.DIRECT:
            routed = route_node(node, node_route.route_param_keys(definition, node_route.DIRECT))
            routed_inputs = dict(inputs)
            if translate is not None:
                routed, routed_inputs = translate(routed, routed_inputs)
            return await direct(routed, routed_inputs, api_keys)
        routed = route_node(node, node_route.route_param_keys(definition, node_route.FALLBACK))
        return await fallback(routed, dict(inputs), api_keys)

    _route.dual_route = True  # type: ignore[attr-defined]  # lets tests find every router
    return _route


def translate_params(route: Mapping[str, Any], params: Mapping[str, Any]) -> dict[str, Any]:
    """A route-table run's params in the provider's names and values: first
    ``rename`` (our key -> theirs), then ``valueMap`` (our value -> theirs,
    looked up by our key). A value the map doesn't list never gets here:
    route_block refuses it (the map is the route's ``accepts``)."""
    rename = route.get("rename") if isinstance(route.get("rename"), Mapping) else {}
    value_map = route.get("valueMap") if isinstance(route.get("valueMap"), Mapping) else {}
    translated: dict[str, Any] = {}
    for key, value in params.items():
        mapped = value_map.get(key)
        if isinstance(mapped, Mapping) and node_route.match_value(value) in {str(k) for k in mapped}:
            value = copy.deepcopy(next(v for k, v in mapped.items() if str(k) == node_route.match_value(value)))
        translated[str(rename.get(key, key))] = value
    return translated


def multi_route(clients: Mapping[str, Handler]) -> Handler:
    """The registry handler for a route-table node (definition ``routes``):
    one handler, many providers. ``clients`` maps a route id to the handler
    that runs it (execution/route_clients.py clients_for).

    Each run picks its route with node_route.select_route, as pricing, the
    spend gate, readiness, the engine's preflight and the cache key do (the
    saved ``_provider``, or Auto). A run that can't start (UNSET: the chosen
    route's key isn't set, or the route can't take these params) raises
    before any provider is called, with route_unavailable's message, and no
    other client runs. Otherwise the client gets a copy of the node with only
    the params that route shows with these values (node_route.route_sent_keys:
    a setting it hides is never sent), translated into the provider's names
    (translate_params); a Krea route's copy carries ``_kreaAuth`` set to how
    the run bills. The client is also told the route's ``endpoint``,
    resolved here from ``endpointWhen`` on the routed values (our names, the
    wired ports marked), since its copy only has the provider's names."""

    async def _route(node: GraphNode, inputs: dict[str, PortValueDict], api_keys: dict[str, str]) -> dict[str, Any]:
        definition = definition_for(node.definition_id)
        routed_params = node_route.with_wired_blockers(definition, node.params, node_route.filled_counts(inputs))
        route = node_route.select_route(definition, routed_params, api_keys)
        if route.kind == node_route.UNSET:
            unavailable = node_route.route_unavailable(definition, routed_params, api_keys) or {}
            message = str(unavailable.get("message") or "This node has no route it can run on")
            # The chosen route needs a key that isn't saved: GM's key line
            # (error copy round 3d). A route its params block keeps the
            # pre-run check's own words.
            line = (node_route.missing_key_line_for(definition, route)
                    or (key_line(route.missing) if route.missing and route.block is None else None))
            if line:
                raise with_person_line(MissingCredentialError(message), line)
            raise MissingCredentialError(message)
        spec = node_route.route_by_id(definition, route.route_id) or {}
        client = clients.get(str(route.route_id))
        if client is None:
            name = definition.get("displayName") or node.definition_id
            raise as_person_line(MissingCredentialError(
                f"{name} can't run on {node_route.provider_label(spec.get('provider'))} in this version of Nebula yet. "
                "Choose another provider."))
        extra = ({"_kreaAuth": "mcp" if route.kind == node_route.PLAN else "api-token"}
                 if spec.get("provider") == "krea" else None)
        # Only the settings this route shows with these values: one it hides
        # (paramVisibleWhen, or a param's own visibleWhen) is never sent.
        routed = route_node(node, node_route.route_sent_keys(definition, route.route_id, routed_params))
        routed = routed.model_copy(update={"params": {**translate_params(spec, routed.params), **(extra or {})}})
        endpoint = node_route.route_endpoint(definition, spec, routed_params)
        return await client(routed, dict(inputs), api_keys, endpoint=endpoint)

    _route.multi_route = True  # type: ignore[attr-defined]  # a route-table node's router
    _route.dual_route = True  # type: ignore[attr-defined]  # so the router walks in tests find it too
    return _route


# -- Nano Banana on the Gemini API ---------------------------------------------
# Model ids: https://ai.google.dev/gemini-api/docs/models (checked 2026-10-14):
# Nano Banana 2 = gemini-3.1-flash-image, Nano Banana Pro = gemini-3-pro-image
# (GA; the -preview id fal still names shut down 2026-06-25), Nano Banana =
# gemini-2.5-flash-image, Nano Banana 2 Lite = gemini-3.1-flash-lite-image.

NANO_BANANA_FAL_GOOGLE_MODELS: dict[str, str] = {
    "nano-banana-2": "gemini-3.1-flash-image",
    "nano-banana-pro": "gemini-3-pro-image",
    "gemini-3-pro-image": "gemini-3-pro-image",
    "nano-banana": "gemini-2.5-flash-image",
    "gemini-25-flash-image": "gemini-2.5-flash-image",
}
# Gemini models with an image size (imageConfig.imageSize); Flash-Lite is 1K only.
_KREA_SIZED_MODELS = {"gemini-3.1-flash-image", "gemini-3-pro-image"}
# fal's resolution names -> Gemini imageConfig.imageSize ("512", "1K", "2K",
# "4K"; https://ai.google.dev/api/generate-content#ImageConfig). The handler
# renders a size a model lacks at 1K (512 on Pro), as fal's Pro does.
FAL_RESOLUTION_IMAGE_SIZE: dict[str, str] = {"0.5K": "512", "1K": "1K", "2K": "2K", "4K": "4K"}
# Which fal model values honor which settings: the same rule as the fal
# wrapper (sync_runner._nano_banana_fal_node) and the params' visibleWhen, so a
# hidden, stale value (resolution saved under Pro, then the model changed)
# changes nothing on either route.
_SIZED = {"nano-banana-2", "nano-banana-pro"}       # resolution, web search, 'auto'
_THINKING = {"nano-banana-2"}                        # thinking level, extreme ratios
_EXTREME_ASPECTS = {"1:4", "4:1", "1:8", "8:1"}
GEMINI_25_FLASH_IMAGE = "gemini-2.5-flash-image"


def nano_banana_fal_to_google(node: GraphNode, inputs: dict[str, PortValueDict]) -> tuple[GraphNode, dict[str, PortValueDict]]:
    """fal's Nano Banana params -> handle_nano_banana's.

    - model -> the Google id (NANO_BANANA_FAL_GOOGLE_MODELS).
    - aspect_ratio 'auto' -> omitted: Google "matches the output image size to
      that of your input image, or otherwise generates 1:1 squares"
      (image-generation guide). An extreme ratio (1:4, 4:1, 1:8, 8:1) is Nano
      Banana 2 only: omitted on Pro (fal sends 'auto'), 1:1 on the others (as
      fal's wrapper does).
    - resolution -> imageSize (0.5K -> 512) on Nano Banana 2 and Pro; the
      handler renders 512 on Pro at 1K, as fal's Pro does.
    - thinking_level minimal/high -> thinkingLevel on Nano Banana 2 (Google:
      "Gemini 3.1 Flash Image | minimal, high"); '' leaves Google's default.
    - enable_web_search -> the googleSearch tool on Nano Banana 2 and Pro.
    - num_images -> that many calls (google_nano_banana).
    - Dropped: output_format and seed (falParams, never reach here); the
      Gemini API documents no image seed and the handler saves what Google
      returns."""
    params = node.params
    fal_model = str(params.get("model") or "nano-banana-2")
    model = NANO_BANANA_FAL_GOOGLE_MODELS.get(fal_model)
    if model is None:
        raise ValueError(f"Nano Banana model {fal_model!r} has no Gemini API route")
    out: dict[str, Any] = {"model": model}
    aspect = str(params.get("aspect_ratio") or "")
    if aspect and aspect != "auto":
        if aspect not in _EXTREME_ASPECTS or fal_model in _THINKING:
            out["aspect_ratio"] = aspect
        elif fal_model not in _SIZED:
            out["aspect_ratio"] = "1:1"
    size = FAL_RESOLUTION_IMAGE_SIZE.get(str(params.get("resolution") or ""))
    if size and fal_model in _SIZED:
        out["imageSize"] = size
    thinking = str(params.get("thinking_level") or "")
    if thinking in {"minimal", "high"} and fal_model in _THINKING:
        out["thinkingLevel"] = thinking
    if params.get("enable_web_search") is True and fal_model in _SIZED:
        out["googleSearch"] = True
    out["num_images"] = params.get("num_images", 1)
    return node.model_copy(update={"params": out}), inputs


def _image_count(value: Any, definition_id: str = "") -> int:
    if value in (None, ""):
        return 1
    if isinstance(value, bool) or not isinstance(value, int) or not 1 <= value <= 4:
        raise with_person_line(
            ValueError(f"num_images must be an integer from 1 to 4 (received {value!r})"),
            f"Set {count_field(definition_id)} to a whole number from 1 to 4.")
    return value


async def google_nano_banana(node: GraphNode, inputs: dict[str, PortValueDict], api_keys: dict[str, str]) -> dict[str, Any]:
    """handle_nano_banana for a translated copy: ``num_images`` calls (fal
    bills and makes that many too); the node's one Image port shows the first,
    as on fal. A 404 on the deprecated 2.5 model names Google's replacement
    (from its shutdown date, node_route.DIRECT_RETIRES sends those runs to the
    fal or Krea copy instead)."""
    from handlers.google_gemini import handle_nano_banana

    count = _image_count(node.params.get("num_images"), node.definition_id)
    call = node.model_copy(update={"params": {k: v for k, v in node.params.items() if k != "num_images"}})
    first: dict[str, Any] | None = None
    for _ in range(count):
        try:
            result = await handle_nano_banana(call, inputs, api_keys)
        except RuntimeError as exc:
            if call.params.get("model") == GEMINI_25_FLASH_IMAGE and "404" in str(exc):
                raise with_call_facts(RuntimeError(
                    f"{exc}. Google lists gemini-2.5-flash-image as deprecated; its named replacement is "
                    "gemini-3.1-flash-lite-image (https://ai.google.dev/gemini-api/docs/deprecations)."
                ), exc) from exc
            raise
        if "image" not in result:
            raise RuntimeError("Gemini returned no image")
        first = first or result
    assert first is not None
    return {"image": first["image"]}


def _json_list(value: Any) -> list[Any]:
    if value in (None, ""):
        return []
    if isinstance(value, str):
        try:
            value = json.loads(value)
        except ValueError as exc:
            raise with_person_line(
                ValueError("image_urls must be a JSON list of image URLs"),
                "Write “Image URLs (JSON)” as a JSON list of links.") from exc
    return value if isinstance(value, list) else [value]


def krea_nano_banana_to_google(model: str) -> Translate:
    """Krea's Nano Banana params -> handle_nano_banana's, for one Gemini model.

    prompt (port, else param) -> prompt; image_urls (port, else the JSON
    param) -> images; aspect_ratio -> aspect_ratio (Krea's choices are
    Google's); resolution 1K/2K/4K -> imageSize. width/height are Krea-only
    (falParams): a run that sets either stays on Krea (directRoute.blockedBy,
    node_route.direct_block), since Google can't render an exact size."""

    def translate(node: GraphNode, inputs: dict[str, PortValueDict]) -> tuple[GraphNode, dict[str, PortValueDict]]:
        params = node.params
        out: dict[str, Any] = {"model": model}
        if params.get("aspect_ratio"):
            out["aspect_ratio"] = str(params["aspect_ratio"])
        if params.get("resolution") and model in _KREA_SIZED_MODELS:
            out["imageSize"] = str(params["resolution"])
        routed: dict[str, PortValueDict] = {}
        prompt = inputs.get("prompt")
        if prompt is not None and prompt.value not in (None, ""):
            routed["prompt"] = prompt
        elif params.get("prompt"):
            routed["prompt"] = PortValueDict(type="Text", value=str(params["prompt"]))
        refs = inputs.get("image_urls")
        images = (refs.value if isinstance(refs.value, list) else [refs.value]) if refs and refs.value else _json_list(params.get("image_urls"))
        images = [value for value in images if value]
        if images:
            routed["images"] = PortValueDict(type="Image", value=images)
        return node.model_copy(update={"params": out}), routed

    return translate


async def krea_google_nano_banana(node: GraphNode, inputs: dict[str, PortValueDict], api_keys: dict[str, str]) -> dict[str, Any]:
    """The direct result in a Krea node's ports: image, images and artifacts
    (no Krea job on this route)."""
    from services.output import portable_output_ref

    result = await google_nano_banana(node, inputs, api_keys)
    ref = portable_output_ref(str(result["image"]["value"]), require_file=True)
    return {
        "image": result["image"],
        "images": {"type": "Array", "value": [ref]},
        "artifacts": {"type": "Array", "value": [{"type": "Image", "value": ref}]},
    }


# Translation ids a generated Krea node names in its ``directRoute``
# (scripts/sync-krea-catalog.py DIRECT_ROUTES): (direct handler, translator for a model).
KREA_TRANSLATIONS: dict[str, tuple[Handler, Callable[[str], Translate]]] = {
    "krea-nano-banana": (krea_google_nano_banana, krea_nano_banana_to_google),
    **maker_routes_elevenlabs.KREA_TRANSLATIONS,
}
# Krea's Ideogram and Runway copies (execution/maker_routes_ideogram_runway.py).
from execution.maker_routes_ideogram_runway import TRANSLATIONS as _IDEOGRAM_RUNWAY  # noqa: E402

KREA_TRANSLATIONS.update(_IDEOGRAM_RUNWAY)

from execution import maker_routes_openai  # noqa: E402  (stdlib + models only; no cycle)

KREA_TRANSLATIONS["krea-openai-image"] = (
    maker_routes_openai.krea_openai_image, maker_routes_openai.krea_openai_image_to_openai,
)

from execution import maker_routes_xai  # noqa: E402  (registers below; imports nothing from here at load)

KREA_TRANSLATIONS.update({
    "krea-xai-image": (maker_routes_xai.krea_xai_image, maker_routes_xai.krea_grok_image_to_xai),
    "krea-xai-video": (maker_routes_xai.krea_xai_video, maker_routes_xai.krea_grok_video_to_xai),
})

from execution.maker_routes_minimax_meshy import TRANSLATIONS as _MINIMAX_MESHY  # noqa: E402

KREA_TRANSLATIONS.update(_MINIMAX_MESHY)

# Seedream on BytePlus ModelArk (execution/maker_routes_byteplus.py).
from execution import maker_routes_byteplus as _byteplus  # noqa: E402

KREA_TRANSLATIONS["krea-seedream"] = (_byteplus.krea_byteplus_seedream, _byteplus.krea_seedream_to_byteplus)
# Seedance on BytePlus ModelArk (execution/maker_routes_byteplus_seedance.py).
from execution import maker_routes_byteplus_seedance as _seedance  # noqa: E402

KREA_TRANSLATIONS["krea-seedance"] = (_seedance.krea_byteplus_seedance, _seedance.krea_to_byteplus)


def krea_router(definition_id: str, fallback: Handler, emit: Any = None) -> Handler | None:
    """The dual-route handler for a generated Krea node with a maker route, or
    None when it has none (it stays on the Krea gateway alone). A direct
    handler marked ``takes_emit`` (a long video job) gets the run's progress
    ``emit``."""
    from execution import maker_routes_google  # noqa: F401  (adds its translations)

    definition = _definitions().get(definition_id) or {}
    spec = definition.get("directRoute")
    if not isinstance(spec, Mapping) or not node_route.direct_keys(definition):
        return None
    translation = KREA_TRANSLATIONS.get(str(spec.get("translation")))
    if translation is None:
        raise ValueError(f"{definition_id}: unknown direct translation {spec.get('translation')!r}")
    direct, make_translate = translation
    if emit is not None and getattr(direct, "takes_emit", False):
        # A long maker job (video, 3D) reports progress like the Krea gateway does.
        direct = partial(direct, emit=emit)
    return dual_route(direct=direct, fallback=fallback, translate=make_translate(str(spec.get("model"))))
