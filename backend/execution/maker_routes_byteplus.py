"""Seedream's fal and Krea copies on BytePlus ModelArk, with the person's own key.

The dual-route plumbing (route choice, per-route param filtering, never
mutating the node) is execution/maker_routes.py ``dual_route``; this module
holds only what is BytePlus's: the translations from the copies' params to a
ModelArk image request, and the direct handlers. The HTTP client and its
error messages are handlers/byteplus.py.

Which runs come here is decided by services/node_route.py ``select_route``,
so pricing, the spend gate, readiness and the cache key agree:

- ``seedream-4-5`` (fal): with BYTEPLUS_API_KEY set, unless the recipe sets a
  ``seed`` (ModelArk has none; ``directRoute.blockedBy``) or a size ModelArk
  can't render exactly (``directRoute.size``: fal's 512x512 "square", or an
  explicit ``{width, height}`` outside the limits). cinema-scene calls this
  node's handler for its default base, so a scene inherits the route.
- ``krea-image-bytedance-seedream-4`` / ``-5-lite`` / ``-5-pro`` (Krea):
  with BYTEPLUS_API_KEY set, unless the node bills the Krea plan, sets
  ``style_images`` (Krea's per-image ``strength`` has no ModelArk
  equivalent), or sets a width x height outside the model's limits.

Facts from docs.byteplus.com/en/docs/ModelArk/image-generation-api, read
2026-10-14 (quoted where they decide a mapping):

- ``size`` is a tier or "WxH" ("Two methods are available, but they cannot be
  used at the same time"). 4.5: "Optional values: 2K, 4K"; 5.0 lite: "2K,
  3K, 4K"; WxH for both "Total pixels range: [2560x1440 (3,686,400),
  4096x4096 (16,777,216)]", "Aspect ratio range: [1/16, 16]".
- ``image``: "Seedream 5.0 lite, 4.5, and 4.0 support up to 14 reference
  images", as a URL or "data:image/<image format>;base64,<Base64 encoding>".
- ``sequential_image_generation`` "auto: The model determines whether to
  return multiple images and how many", with
  ``sequential_image_generation_options.max_images`` "[1, 15]" and "Number of
  input reference images + number of generated images <= 15".
- ``watermark`` "Default: true" (an "AI-generated" mark), so every request
  sends ``false``, matching the fal and Krea copies.
- No seed, negative prompt, guidance or image-count parameter is documented.
"""
from __future__ import annotations

import base64
from typing import Any

from models.graph import GraphNode, PortValueDict
from services import node_route

# The fal node's model choice -> ModelArk model id (image-generation-api and
# model-list, 2026-10-14). 5.0 lite: the model list names "seedream-5-0-260128
# (also supports: seedream-5-0-lite-260128)"; the pricing page lists
# seedream-5-0-lite-260128, the id whose price Nebula quotes, so it's the one
# called.
FAL_SEEDREAM_MODELS: dict[str, str] = {
    "4.5": "seedream-4-5-251128",
    "5.0-lite": "seedream-5-0-lite-260128",
}
# fal's size tiers -> ModelArk's ("auto" = the model picks the shape within the
# tier, as ModelArk's tier method does). 3K is 5.0 lite only, as on fal.
_TIERS: dict[str, str] = {"auto_2K": "2K", "auto_3K": "3K", "auto_4K": "4K"}
# fal's shaped presets -> ModelArk's own size for that shape in its 2K table
# (image-generation-api, Seedream 4.5 / 5.0 lite: "2K | 1:1 | 2048x2048",
# "4:3 | 2304x1728", "3:4 | 1728x2304", "16:9 | 2848x1600", "9:16 |
# 1600x2848"). fal doesn't publish its presets' pixel sizes (its schema only
# says sizes are scaled into the same 2560x1440..4096x4096 window), so the
# shape is kept exactly and the pixels are ModelArk's for that shape; Nebula's
# own label already calls square_hd 2048x2048. "square" (labelled 512x512)
# has no ModelArk size and keeps the run on fal (directRoute.size).
_SHAPED: dict[str, str] = {
    "square_hd": "2048x2048",
    "portrait_4_3": "1728x2304",
    "portrait_16_9": "1600x2848",
    "landscape_4_3": "2304x1728",
    "landscape_16_9": "2848x1600",
}
MAX_REFERENCES = 10        # the node's References port (ModelArk takes 14 on these models)
MAX_IMAGES_PER_REQUEST = 15  # ModelArk: references + generated images <= 15


def _count(value: Any, name: str, maximum: int) -> int:
    if value in (None, ""):
        return 1
    if isinstance(value, bool) or not isinstance(value, (int, float)) or not float(value).is_integer():
        raise ValueError(f"{name} must be a whole number from 1 to {maximum} (received {value!r})")
    count = int(value)
    if not 1 <= count <= maximum:
        raise ValueError(f"{name} must be a whole number from 1 to {maximum} (received {value!r})")
    return count


def _limits(definition_id: str) -> dict[str, Any]:
    from execution.maker_routes import definition_for

    spec = definition_for(definition_id).get("directRoute") or {}
    return dict(spec.get("size") or {})


def _wxh(width: Any, height: Any, limits: dict[str, Any], what: str) -> str:
    if not node_route.size_fits(width, height, limits):
        raise ValueError(
            f"BytePlus can't render {what} {width!r}x{height!r} exactly: it takes whole-pixel sizes with "
            f"{limits.get('minPixels', 0):,} to {limits.get('maxPixels', 0):,} pixels and a ratio up to "
            f"1:{limits.get('maxAspect', 16)}. Choose a size in that range, or run it on the copy."
        )
    return f"{int(width)}x{int(height)}"


def _port_values(inputs: dict[str, PortValueDict], *ports: str) -> list[str]:
    for port in ports:
        entry = inputs.get(port)
        if entry is not None and entry.value not in (None, "", []):
            raw = entry.value if isinstance(entry.value, list) else [entry.value]
            return [str(value) for value in raw if value]
    return []


def seedream_fal_to_byteplus(
    node: GraphNode, inputs: dict[str, PortValueDict],
) -> tuple[GraphNode, dict[str, PortValueDict]]:
    """fal's Seedream 4.5 / 5.0 Lite params -> a ModelArk image request.

    - model '4.5' / '5.0-lite' -> FAL_SEEDREAM_MODELS.
    - image_size: auto_2K/3K/4K -> the 2K/3K/4K tier; a shaped preset ->
      ModelArk's 2K size for that shape (_SHAPED); ``{width, height}`` (a
      cinema scene's custom ratio) -> "WxH" when it fits. auto_3K on 4.5 is
      refused, as the fal route refuses it.
    - images (or a single image) -> image[], at most 10 (the port's limit).
    - num_images -> that many requests (fal: "Number of separate model
      generations"); max_images > 1 -> sequential generation of up to that
      many per request (fal: "will potentially return up to max_images
      images every generation").
    - Never reach here: seed (blocks this route when set) and
      enable_safety_checker switched off (directRoute.accepts; left on it's
      fal-only and not sent, as ModelArk always runs its own content
      filter)."""
    params = node.params
    model_choice = str(params.get("model") or "4.5")
    model = FAL_SEEDREAM_MODELS.get(model_choice)
    if model is None:
        raise ValueError(f"Seedream model {model_choice!r} has no BytePlus route")
    size_value = params.get("image_size") or "square_hd"
    if isinstance(size_value, dict):
        size = _wxh(size_value.get("width"), size_value.get("height"), _limits(node.definition_id), "the size")
    elif size_value == "auto_3K" and model_choice != "5.0-lite":
        raise ValueError("Seedream 4.5 does not support image_size auto_3K; choose a supported size or Seedream 5.0 Lite")
    elif size_value in _TIERS:
        size = _TIERS[str(size_value)]
    elif size_value in _SHAPED:
        size = _SHAPED[str(size_value)]
    else:
        raise ValueError(f"BytePlus has no size for Seedream image_size {size_value!r}; it runs on fal")
    refs = _port_values(inputs, "images", "image")
    if len(refs) > MAX_REFERENCES:
        raise ValueError(f"Seedream accepts at most {MAX_REFERENCES} reference images (received {len(refs)})")
    max_images = _count(params.get("max_images"), "max_images", 6)
    if len(refs) + max_images > MAX_IMAGES_PER_REQUEST:
        raise ValueError(
            f"BytePlus takes at most {MAX_IMAGES_PER_REQUEST} images per request, references plus outputs "
            f"({len(refs)} references + max_images {max_images})")
    out = {"model": model, "size": size, "num_images": _count(params.get("num_images"), "num_images", 6),
           "max_images": max_images}
    routed: dict[str, PortValueDict] = {}
    if "prompt" in inputs:
        routed["prompt"] = inputs["prompt"]
    if refs:
        routed["images"] = PortValueDict(type="Image", value=refs)
    return node.model_copy(update={"params": out}), routed


def krea_seedream_to_byteplus(model: str):
    """Krea's Seedream params -> a ModelArk image request for one model.

    prompt (port, else param) -> prompt; width x height -> "WxH" (both are
    required by Krea's schema; a size outside the model's limits never gets
    here, node_route.direct_block keeps it on Krea). Krea-only and dropped:
    seed (no ModelArk seed). style_images keep a run on Krea when set as a
    param; wired in by a port, they're refused here rather than sent without
    their strength."""

    def translate(node: GraphNode, inputs: dict[str, PortValueDict]) -> tuple[GraphNode, dict[str, PortValueDict]]:
        params = node.params
        if _port_values(inputs, "style_images"):
            raise ValueError(
                "Krea's style images (with their strength) have no BytePlus equivalent. Remove the style "
                "images, or remove the BytePlus key to run this on Krea.")
        width, height = params.get("width"), params.get("height")
        if width in (None, "") or height in (None, ""):
            raise ValueError("Seedream needs a width and a height")
        size = _wxh(width, height, _limits(node.definition_id), "width x height")
        routed: dict[str, PortValueDict] = {}
        prompt = inputs.get("prompt")
        if prompt is not None and prompt.value not in (None, ""):
            routed["prompt"] = prompt
        elif params.get("prompt"):
            routed["prompt"] = PortValueDict(type="Text", value=str(params["prompt"]))
        out = {"model": model, "size": size, "num_images": 1, "max_images": 1}
        return node.model_copy(update={"params": out}), routed

    return translate


def _reference(value: str) -> str:
    """A reference image as ModelArk takes it: a URL or a data URI."""
    if value.startswith(("http://", "https://", "data:")):
        return value
    from services.image_input import load_local_image
    from services.output import resolve_output_ref

    mime, b64 = load_local_image(resolve_output_ref(value))
    return f"data:{mime};base64,{b64}"


def request_body(node: GraphNode, inputs: dict[str, PortValueDict]) -> dict[str, Any]:
    """One POST /images/generations body for a translated node."""
    prompt = inputs.get("prompt")
    text = str(prompt.value).strip() if prompt is not None and prompt.value not in (None, "") else ""
    if not text:
        raise ValueError("Seedream needs a prompt")
    params = node.params
    body: dict[str, Any] = {"model": params["model"], "prompt": text, "size": params["size"],
                            "response_format": "b64_json", "watermark": False}
    refs = _port_values(inputs, "images")
    if refs:
        body["image"] = [_reference(ref) for ref in refs]
    # One image is BytePlus's default ("sequential_image_generation ...
    # Default: disabled"), so the field goes only with a batch. Seedream 5.0
    # pro doesn't take it at all ("Single image generation:
    # sequential_image_generation is not supported"; its supported models are
    # "Seedream 5.0 lite, Seedream 4.5, Seedream 4.0"), and the Krea 5.0 pro
    # copy always asks for one image.
    max_images = int(params.get("max_images") or 1)
    if max_images > 1:
        body["sequential_image_generation"] = "auto"
        body["sequential_image_generation_options"] = {"max_images": max_images}
    return body


async def _generate(node: GraphNode, inputs: dict[str, PortValueDict], api_keys: dict[str, str]) -> list[str]:
    """Every image of ``num_images`` requests, saved to the run dir (paths)."""
    from handlers import byteplus
    from services.output import get_run_dir, save_base64_image

    key = byteplus.api_key(api_keys)
    body = request_body(node, inputs)
    paths: list[str] = []
    for _ in range(int(node.params.get("num_images") or 1)):
        for raw, extension in await byteplus.generate_images(key, body):
            path = save_base64_image(base64.b64encode(raw).decode("ascii"), get_run_dir(), extension=extension)
            paths.append(str(path))
    return paths


async def byteplus_seedream(node: GraphNode, inputs: dict[str, PortValueDict], api_keys: dict[str, str]) -> dict[str, Any]:
    """The fal node's result on BytePlus: its one Image port shows the first
    image, as the fal route does (every image is saved to the run folder)."""
    paths = await _generate(node, inputs, api_keys)
    return {"image": {"type": "Image", "value": paths[0]}}


async def krea_byteplus_seedream(node: GraphNode, inputs: dict[str, PortValueDict], api_keys: dict[str, str]) -> dict[str, Any]:
    """A Krea node's result on BytePlus: image, images and artifacts (no Krea job)."""
    from services.output import portable_output_ref

    paths = await _generate(node, inputs, api_keys)
    refs = [portable_output_ref(path, require_file=True) for path in paths]
    return {
        "image": {"type": "Image", "value": paths[0]},
        "images": {"type": "Array", "value": refs},
        "artifacts": {"type": "Array", "value": [{"type": "Image", "value": ref} for ref in refs]},
    }

