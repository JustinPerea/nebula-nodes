"""GPT Image's fal and Krea copies on OpenAI's own Images API with the person's key.

The routing itself is execution/maker_routes.py ``dual_route`` (and
``krea_router`` for the generated Krea copies); this module holds the OpenAI
lane's translators and direct handlers. The requests go out through the
existing direct handlers in handlers/openai_image_v2.py (streamed
``/v1/images/generations`` and multipart ``/v1/images/edits``), with a body
builder per model.

Vendor facts, read on 2026-10-14 from OpenAI's own pages:

- Model ids ``gpt-image-1.5``, ``gpt-image-2``, ``gpt-image-2.5-flare``,
  ``gpt-image-2.5-sunburst``; each model page lists "Image generation |
  `v1/images/generations` | Supported" and "Image edit | `v1/images/edits` |
  Supported" (https://developers.openai.com/api/docs/models/<id>).
- gpt-image-1.5 shuts down "Dec 1, 2026"
  (https://developers.openai.com/api/docs/deprecations); node_route.DIRECT_RETIRES
  sends its runs back to fal from that day.
- Sizes (https://developers.openai.com/api/reference/resources/images): "The
  standard sizes `1024x1024`, `1536x1024`, and `1024x1536` are supported by
  the GPT image models"; for gpt-image-2 and 2.5 "arbitrary resolutions are
  supported as `WIDTHxHEIGHT` strings ... Width and height must both be
  divisible by 16 and the requested aspect ratio must be between 1:3 and
  3:1", and the image guide adds "neither edge may exceed 3840 pixels. The
  total pixel count must be between 655,360 and 8,294,400 (4K). Resolutions
  above `2560x1440` are experimental."
- Quality: "`high`, `medium` and `low` are supported for the GPT image models.
  `gpt-image-2.5-sunburst` and `gpt-image-2.5-flare` ... also support `xhigh`
  and `max`"; ``auto`` is the default.
- Background: "When using `transparent`, set the output format to `png` or
  `webp`"; for gpt-image-2 transparency "is in preview".
- input_fidelity: "Supports `high` and `low` on `gpt-image-1` and
  `gpt-image-1.5` ... For `gpt-image-2`, omit this parameter."
- Edits: "For GPT image models, you can provide up to 16 images"; the guide's
  curl example sends them as multipart ``image[]`` fields.
- partial_images: "Value must be between 0 and 3", and "each partial image will
  incur an additional 100 image output tokens" (image guide, priced as an
  extra in data/model_pricing.json).

``num_images`` (fal's count) becomes that many streamed calls: the handlers
stream, and the node's one Image port shows the first, as on fal (which also
makes and bills every image it was asked for).
"""
from __future__ import annotations

import json
from pathlib import Path
from typing import Any, Awaitable, Callable

from execution.missing_credential import MissingCredentialError
from models.events import ExecutionEvent
from models.graph import GraphNode, PortValueDict
from execution.person_line import as_person_line, with_person_line

Emit = Callable[[ExecutionEvent], Awaitable[None]] | None

GPT_IMAGE_15 = "gpt-image-1.5"
GPT_IMAGE_2 = "gpt-image-2"
GPT_IMAGE_25_MODELS = ("gpt-image-2.5-flare", "gpt-image-2.5-sunburst")
OPENAI_MODELS = (GPT_IMAGE_15, GPT_IMAGE_2, *GPT_IMAGE_25_MODELS)

# The image sizes every GPT image model takes (fal's gpt-image-1.5 offers
# exactly these, plus 'auto' on edit).
STANDARD_SIZES = ("1024x1024", "1536x1024", "1024x1536")
# fal's gpt-image-2 presets that OpenAI can render exactly, by the pixel size
# the node's own option labels promise ("Square HD (1024x1024)", ...). The
# others (Square 512x512, Portrait/Landscape 16:9 576x1024 / 1024x576) are
# under OpenAI's "total pixels between 655,360 and 8,294,400"
# (https://developers.openai.com/api/docs/guides/image-generation, checked
# 2026-10-14); the nodes' directRoute.rejects keeps those runs on fal, so
# they never reach the translator.
FAL_GPT_IMAGE_2_SIZES: dict[str, str] = {
    "square_hd": "1024x1024",
    "portrait_4_3": "768x1024",
    "landscape_4_3": "1024x768",
}

# Krea's aspect_ratio x resolution -> an OpenAI size. Krea documents only "Resolution
# scale. One of: 1K, 2K, 4K" (api.krea.ai/openapi.json), not the pixels it renders, so
# this table is Nebula's: every size keeps the exact ratio, has edges that are multiples
# of 16 and fits OpenAI's pixel and edge limits. 1K is OpenAI's standard size where one
# exists (1024x1024, 1536x1024, 1024x1536; Krea's own ChatGPT Image page lists the same
# three as "3:2 (1536x1024) / 1:1 (1024x1024) / 2:3 (1024x1536)"), else a 1,024-pixel
# long edge, raised to the 655,360-pixel minimum. 2K is a 2,048-pixel long edge (OpenAI's
# "2048x2048 (2K square)", "2048x1152 (2K landscape)"). 4K is OpenAI's largest: a
# 3,840-pixel long edge ("3840x2160 (4K landscape)") or less where 8,294,400 pixels cap
# it (2880x2880 square). 4K is above 2560x1440, which OpenAI calls experimental.
KREA_OPENAI_SIZES: dict[str, dict[str, str]] = {
    "16:9": {"1K": "1280x720", "2K": "2048x1152", "4K": "3840x2160"},
    "2:1": {"1K": "1152x576", "2K": "2048x1024", "4K": "3840x1920"},
    "3:2": {"1K": "1536x1024", "2K": "2016x1344", "4K": "3504x2336"},
    "4:3": {"1K": "1024x768", "2K": "2048x1536", "4K": "3264x2448"},
    "1:1": {"1K": "1024x1024", "2K": "2048x2048", "4K": "2880x2880"},
    "3:4": {"1K": "768x1024", "2K": "1536x2048", "4K": "2448x3264"},
    "2:3": {"1K": "1024x1536", "2K": "1344x2016", "4K": "2336x3504"},
    "1:2": {"1K": "576x1152", "2K": "1024x2048", "4K": "1920x3840"},
    "9:16": {"1K": "720x1280", "2K": "1152x2048", "4K": "2160x3840"},
}
# What a Krea GPT Image 2 recipe that sets only one of the two means (Krea's
# GPT Image 2 makes both optional; the 2.5 copies require both).
KREA_DEFAULT_ASPECT = "1:1"
KREA_DEFAULT_RESOLUTION = "1K"
MAX_REFERENCE_IMAGES = 16
# "The image to edit and mask must be of the same format and size (less than 50MB in size)."
MAX_REFERENCE_BYTES = 50_000_000


def _set(value: Any) -> bool:
    return value is not None and value != ""


def _copy(out: dict[str, Any], params: dict[str, Any], *keys: str) -> None:
    for key in keys:
        if _set(params.get(key)):
            out[key] = params[key]


# -- fal copies ------------------------------------------------------------------

def fal_gpt_image_to_openai(model: str) -> Callable[[GraphNode, dict[str, PortValueDict]], tuple[GraphNode, dict[str, PortValueDict]]]:
    """fal's GPT Image params -> the OpenAI handler's, for one model.

    - image_size -> size: gpt-image-1.5's values are OpenAI's standard sizes;
      gpt-image-2's fal presets map by FAL_GPT_IMAGE_2_SIZES; 'auto' is left
      to OpenAI.
    - quality, background, input_fidelity, output_format, partial_images pass
      through under OpenAI's own names (the body builder drops what a model
      doesn't take, and refuses a transparent JPEG).
    - num_images -> that many calls (openai_image_direct).
    Nothing is dropped: every param of these fal nodes has an OpenAI field."""

    def translate(node: GraphNode, inputs: dict[str, PortValueDict]) -> tuple[GraphNode, dict[str, PortValueDict]]:
        params = node.params
        out: dict[str, Any] = {"model": model}
        size = str(params.get("image_size") or "auto")
        if size != "auto":
            if model == GPT_IMAGE_15:
                if size not in STANDARD_SIZES:
                    raise ValueError(f"GPT Image 1.5 size {size!r} has no OpenAI equivalent")
                out["size"] = size
            elif size in FAL_GPT_IMAGE_2_SIZES:
                out["size"] = FAL_GPT_IMAGE_2_SIZES[size]
            else:
                raise ValueError(f"GPT Image 2 size {size!r} has no OpenAI equivalent; it runs on fal")
        _copy(out, params, "quality", "background", "output_format", "partial_images", "num_images")
        if model == GPT_IMAGE_15:
            _copy(out, params, "input_fidelity")
        return node.model_copy(update={"params": out}), inputs

    return translate


# -- Krea copies -----------------------------------------------------------------

def krea_openai_size(params: dict[str, Any]) -> str | None:
    """The OpenAI size for a Krea recipe's aspect_ratio + resolution, or None
    (OpenAI's 'auto') when it sets neither."""
    aspect, resolution = params.get("aspect_ratio"), params.get("resolution")
    if not _set(aspect) and not _set(resolution):
        return None
    aspect = str(aspect) if _set(aspect) else KREA_DEFAULT_ASPECT
    resolution = str(resolution) if _set(resolution) else KREA_DEFAULT_RESOLUTION
    size = KREA_OPENAI_SIZES.get(aspect, {}).get(resolution)
    if size is None:
        raise as_person_line(ValueError(f"Krea size {aspect} at {resolution} has no OpenAI equivalent"))
    return size


def _json_list(value: Any) -> list[Any]:
    if value in (None, ""):
        return []
    if isinstance(value, str):
        try:
            value = json.loads(value)
        except ValueError as exc:
            raise with_person_line(
                ValueError("image_urls must be a JSON list of image URLs"),
                "Write the node's image URLs as a JSON list of links.") from exc
    return value if isinstance(value, list) else [value]


def krea_openai_image_to_openai(model: str) -> Callable[[GraphNode, dict[str, PortValueDict]], tuple[GraphNode, dict[str, PortValueDict]]]:
    """Krea's GPT Image params -> the OpenAI handler's, for one model.

    prompt (port, else param) -> prompt; image_urls (port, else the JSON
    param) -> images, which send the run to /v1/images/edits; quality and
    background (Flare) pass through; aspect_ratio + resolution -> size
    (KREA_OPENAI_SIZES). width/height are Krea-only (falParams): a run that
    sets either stays on Krea (directRoute.blockedBy)."""

    def translate(node: GraphNode, inputs: dict[str, PortValueDict]) -> tuple[GraphNode, dict[str, PortValueDict]]:
        params = node.params
        out: dict[str, Any] = {"model": model}
        size = krea_openai_size(params)
        if size:
            out["size"] = size
        _copy(out, params, "quality", "background")
        routed: dict[str, PortValueDict] = {}
        prompt = inputs.get("prompt")
        if prompt is not None and prompt.value not in (None, ""):
            routed["prompt"] = prompt
        elif _set(params.get("prompt")):
            routed["prompt"] = PortValueDict(type="Text", value=str(params["prompt"]))
        refs = inputs.get("image_urls")
        if refs is not None and refs.value:
            images = refs.value if isinstance(refs.value, list) else [refs.value]
        else:
            images = _json_list(params.get("image_urls"))
        images = [value for value in images if value]
        if images:
            routed["images"] = PortValueDict(type="Image", value=images)
        return node.model_copy(update={"params": out}), routed

    return translate


# -- the request ------------------------------------------------------------------

def build_body(node: GraphNode, prompt: str) -> dict[str, Any]:
    """The Images API body for a translated node, by model (see the module docstring)."""
    from handlers.openai_image_v2 import build_25_body, build_generate_body

    params = node.params or {}
    model = params.get("model")
    if model not in OPENAI_MODELS:
        raise ValueError(f"No OpenAI route for model {model!r}")
    if model in GPT_IMAGE_25_MODELS:
        return build_25_body(node, prompt)
    quality = params.get("quality") or "auto"
    if quality not in {"auto", "low", "medium", "high"}:
        raise with_person_line(ValueError(f"{model} quality must be auto, low, medium or high"), "Set Quality to Auto, Low, Medium or High, then run the node again.")
    body = build_generate_body(node, prompt, model=model)
    background = params.get("background") or "auto"
    if background not in {"auto", "opaque", "transparent"}:
        raise as_person_line(ValueError("Background must be auto, opaque or transparent"))
    if background == "transparent" and body.get("output_format", "png") not in {"png", "webp"}:
        raise as_person_line(ValueError("A transparent background needs PNG or WebP output, not JPEG"))
    if background != "auto":
        body["background"] = background
    if model == GPT_IMAGE_15 and params.get("input_fidelity") in {"low", "high"}:
        body["input_fidelity"] = params["input_fidelity"]
    return body


def image_count(value: Any) -> int:
    if value in (None, ""):
        return 1
    if isinstance(value, bool) or not isinstance(value, int) or not 1 <= value <= 4:
        raise with_person_line(
            ValueError(f"num_images must be an integer from 1 to 4 (received {value!r})"),
            "Set the number of images to a whole number from 1 to 4.")
    return value


async def local_images(values: list[Any], run_dir: Path) -> list[str]:
    """Each reference as a local file the multipart edit can read: a served
    /api/outputs/ ref resolves to its file, a public https URL or a data: URI
    is saved into the run (fetched without credentials, SSRF-checked), a
    local path is checked by the edit handler."""
    from services.media_input import decode_data_uri, owned_output_value
    from services.output import write_media_bytes
    from services.public_url import fetch_public_media

    if len(values) > MAX_REFERENCE_IMAGES:
        raise as_person_line(ValueError(f"OpenAI image edits take up to {MAX_REFERENCE_IMAGES} images; got {len(values)}"))
    paths: list[str] = []
    for value in values:
        text = owned_output_value(str(value))
        if text.startswith(("http://", "https://")):
            payload, content_type = await fetch_public_media(
                text, label="Reference image", max_bytes=MAX_REFERENCE_BYTES)
            paths.append(str(await write_media_bytes(payload, content_type, "Image", run_dir, text)))
        elif text.startswith("data:"):
            payload, content_type = decode_data_uri(text, label="Reference image", max_bytes=MAX_REFERENCE_BYTES)
            paths.append(str(await write_media_bytes(payload, content_type, "Image", run_dir)))
        else:
            paths.append(text)
    return paths


def openai_image_direct(*, emit: Emit = None) -> Callable[[GraphNode, dict[str, PortValueDict], dict[str, str]], Awaitable[dict[str, Any]]]:
    """The direct handler for a translated GPT Image node: /v1/images/edits
    when reference images are wired, else /v1/images/generations, once per
    ``num_images``. Returns the first image on ``image`` (the fal nodes' one
    output) and every image on ``images``."""

    async def run(node: GraphNode, inputs: dict[str, PortValueDict], api_keys: dict[str, str]) -> dict[str, Any]:
        from handlers.openai_image_v2 import handle_gpt_image_2_edit, handle_gpt_image_2_generate
        from services.output import get_run_dir

        if not api_keys.get("OPENAI_API_KEY"):
            raise MissingCredentialError("OPENAI_API_KEY is required")
        count = image_count(node.params.get("num_images"))
        call = node.model_copy(update={"params": {k: v for k, v in node.params.items() if k != "num_images"}})
        run_dir = get_run_dir()
        build_body(call, "check")  # refuse what OpenAI would reject before any request or download
        routed = dict(inputs)
        refs = inputs.get("images")
        values = (refs.value if isinstance(refs.value, list) else [refs.value]) if refs and refs.value else []
        values = [value for value in values if value]
        if values:
            routed["images"] = PortValueDict(type="Image", value=await local_images(values, run_dir))
        paths: list[str] = []
        for index in range(count):
            if values:
                result = await handle_gpt_image_2_edit(call, routed, api_keys, emit, run_dir, build_body=build_body)
            else:
                result = await handle_gpt_image_2_generate(call, routed, api_keys, emit, run_dir, build_body=build_body)
            path = Path(str(result["image"]["value"]))
            if count > 1:
                # The handlers save every call as "<node id>_final"; give each
                # paid image its own file so the next call doesn't overwrite it.
                kept = path.with_name(f"{path.stem}_{index + 1}{path.suffix}")
                path.replace(kept)
                path = kept
            paths.append(str(path))
        return {"image": {"type": "Image", "value": paths[0]}, "paths": paths}

    return run


def fal_direct(*, emit: Emit = None) -> Callable[[GraphNode, dict[str, PortValueDict], dict[str, str]], Awaitable[dict[str, Any]]]:
    """The direct handler for the fal copies: the one Image port, as on fal."""
    direct = openai_image_direct(emit=emit)

    async def run(node: GraphNode, inputs: dict[str, PortValueDict], api_keys: dict[str, str]) -> dict[str, Any]:
        result = await direct(node, inputs, api_keys)
        return {"image": result["image"]}

    return run


async def krea_openai_image(node: GraphNode, inputs: dict[str, PortValueDict], api_keys: dict[str, str]) -> dict[str, Any]:
    """The direct result in a Krea node's ports: image, images and artifacts
    (no Krea job on this route)."""
    from services.output import portable_output_ref

    result = await openai_image_direct()(node, inputs, api_keys)
    refs = [portable_output_ref(path, require_file=True) for path in result["paths"]]
    return {
        "image": result["image"],
        "images": {"type": "Array", "value": refs},
        "artifacts": {"type": "Array", "value": [{"type": "Image", "value": ref} for ref in refs]},
    }
