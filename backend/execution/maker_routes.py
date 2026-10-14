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

The translators here are pinned to the maker's documentation; each says what
it drops. Prices are written in the node's own param names
(data/model_pricing.json ``routes``), so they don't depend on the translation.
"""
from __future__ import annotations

import copy
import json
from functools import lru_cache
from typing import Any, Awaitable, Callable, Mapping

from execution.missing_credential import MissingCredentialError
from models.graph import GraphNode, PortValueDict
from services import node_route

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
        raise ValueError(f"Unknown node definition {definition_id!r}")
    return definition


def route_node(node: GraphNode, allowed: set[str], extra: Mapping[str, Any] | None = None) -> GraphNode:
    """A per-run copy of ``node`` with only ``allowed`` params (deep-copied)."""
    params = {key: copy.deepcopy(value) for key, value in node.params.items() if key in allowed}
    params.update(extra or {})
    return node.model_copy(update={"params": params})


def dual_route(*, direct: Handler, fallback: Handler, translate: Translate | None = None) -> Handler:
    """The registry handler for a dual-route node (see the module docstring).

    ``fallback`` gets the route-filtered copy and the inputs; it adds its own
    endpoint or account handling. ``direct`` gets the translated copy."""

    async def _route(node: GraphNode, inputs: dict[str, PortValueDict], api_keys: dict[str, str]) -> dict[str, Any]:
        definition = definition_for(node.definition_id)
        route = node_route.select_route(definition, node.params, api_keys)
        if route.kind == node_route.UNSET:
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


def _image_count(value: Any) -> int:
    if value in (None, ""):
        return 1
    if isinstance(value, bool) or not isinstance(value, int) or not 1 <= value <= 4:
        raise ValueError(f"num_images must be an integer from 1 to 4 (received {value!r})")
    return value


async def google_nano_banana(node: GraphNode, inputs: dict[str, PortValueDict], api_keys: dict[str, str]) -> dict[str, Any]:
    """handle_nano_banana for a translated copy: ``num_images`` calls (fal
    bills and makes that many too); the node's one Image port shows the first,
    as on fal. A 404 on the deprecated 2.5 model names Google's replacement."""
    from handlers.google_gemini import handle_nano_banana

    count = _image_count(node.params.get("num_images"))
    call = node.model_copy(update={"params": {k: v for k, v in node.params.items() if k != "num_images"}})
    first: dict[str, Any] | None = None
    for _ in range(count):
        try:
            result = await handle_nano_banana(call, inputs, api_keys)
        except RuntimeError as exc:
            if call.params.get("model") == GEMINI_25_FLASH_IMAGE and "404" in str(exc):
                raise RuntimeError(
                    f"{exc}. Google lists gemini-2.5-flash-image as deprecated; its named replacement is "
                    "gemini-3.1-flash-lite-image (https://ai.google.dev/gemini-api/docs/deprecations)."
                ) from exc
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
            raise ValueError("image_urls must be a JSON list of image URLs") from exc
    return value if isinstance(value, list) else [value]


def krea_nano_banana_to_google(model: str) -> Translate:
    """Krea's Nano Banana params -> handle_nano_banana's, for one Gemini model.

    prompt (port, else param) -> prompt; image_urls (port, else the JSON
    param) -> images; aspect_ratio -> aspect_ratio (Krea's choices are
    Google's); resolution 1K/2K/4K -> imageSize. width/height are Krea-only
    (falParams) and never reach here."""

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
}


def krea_router(definition_id: str, fallback: Handler) -> Handler | None:
    """The dual-route handler for a generated Krea node with a maker route, or
    None when it has none (it stays on the Krea gateway alone)."""
    definition = _definitions().get(definition_id) or {}
    spec = definition.get("directRoute")
    if not isinstance(spec, Mapping) or not node_route.direct_keys(definition):
        return None
    translation = KREA_TRANSLATIONS.get(str(spec.get("translation")))
    if translation is None:
        raise ValueError(f"{definition_id}: unknown direct translation {spec.get('translation')!r}")
    direct, make_translate = translation
    return dual_route(direct=direct, fallback=fallback, translate=make_translate(str(spec.get("model"))))
