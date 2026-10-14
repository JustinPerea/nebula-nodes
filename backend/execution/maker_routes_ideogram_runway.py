"""Krea's Ideogram and Runway copies on the makers' own APIs, with the person's key.

The direct halves of six generated Krea nodes (scripts/sync-krea-catalog.py
``IDEOGRAM_RUNWAY_DIRECT_ROUTES``), registered in
execution/maker_routes.py ``KREA_TRANSLATIONS``. maker_routes.dual_route picks
the route (services/node_route.py: the Krea plan when chosen, else the maker
key, else KREA_API_TOKEN) and hands these handlers a copy of the node with
only the params both routes share.

Each handler first builds the request Krea itself would get
(handlers/krea_gateway.py ``_request_body``: params, then wired ports over
them, JSON params decoded), so the two routes read a recipe the same way,
then maps that request onto the maker's. Krea's schema defaults are applied
where a value is missing, as Krea's server would.

Vendor facts, read 2026-10-14 from the makers' own pages:

- Ideogram, https://developer.ideogram.ai (v2 reference pages and the v1
  Ideogram 3.0 page). Every endpoint is a synchronous POST with an
  ``Api-Key`` header that returns ``data[].url`` links that expire, so the
  first image is saved at once (handlers/ideogram.py ``_save_first_image``).
- Runway, https://docs.dev.runwayml.com/openapi.json and api.md: tasks are
  polled on /v1/tasks/{id}; data URIs are capped at 5MB, larger local files go
  through Runway's ephemeral uploads (handlers/runway.py helpers).
"""
from __future__ import annotations

import math
from typing import Any, Callable, Mapping
from urllib.parse import urlsplit

from models.graph import GraphNode, PortValueDict

# -- shared -------------------------------------------------------------------

_LOOPBACK = {"localhost", "127.0.0.1", "::1"}


async def krea_request(node: GraphNode, inputs: dict[str, PortValueDict]) -> dict[str, Any]:
    """The request body the Krea gateway would build for this run."""
    from handlers.krea_gateway import _model, _request_body

    return await _request_body(node, inputs, _model(node.definition_id))


def media_ref(value: Any, what: str) -> str:
    """A media value a maker handler can read: an owned output (served
    ``/api/outputs/...`` ref or a loopback URL to one) becomes its file path;
    https/data URIs and local paths pass through. A maker can't fetch a URL
    on this machine, so any other loopback URL is refused."""
    from services.output import resolve_output_ref

    if not isinstance(value, str) or not value.strip():
        raise ValueError(f"{what} is required")
    value = value.strip()
    try:
        parts = urlsplit(value)
    except ValueError as exc:
        raise ValueError(f"{what} is not a valid URL") from exc
    if parts.scheme in {"http", "https"} and (parts.hostname or "").lower().rstrip(".") in _LOOPBACK:
        if not parts.path.startswith("/api/outputs/") or parts.query or parts.fragment:
            raise ValueError(f"{what} points at this machine; connect the output itself or use a public URL")
        value = parts.path
    return resolve_output_ref(value)


def _number(value: Any, label: str) -> float:
    if isinstance(value, bool):
        raise ValueError(f"{label} must be a number (received {value!r})")
    try:
        number = float(value)
    except (TypeError, ValueError):
        raise ValueError(f"{label} must be a number (received {value!r})") from None
    if not math.isfinite(number):
        raise ValueError(f"{label} must be a finite number (received {value!r})")
    return number


def whole_seed(value: Any, maximum: int) -> int | None:
    """Krea's seed (a float on several of these copies) as the maker's integer seed."""
    if value is None or value == "":
        return None
    number = _number(value, "Seed")
    seed = int(round(number))
    if not 0 <= seed <= maximum:
        raise ValueError(f"Seed must be from 0 to {maximum} (received {value!r})")
    return seed


def _size(body: Mapping[str, Any]) -> tuple[float, float]:
    # Krea's schema: width/height "default": 1024, "minimum": 512, "maximum": 8192.
    width = _number(body.get("width", 1024), "Width")
    height = _number(body.get("height", 1024), "Height")
    if width <= 0 or height <= 0:
        raise ValueError("Width and height must be positive")
    return width, height


def nearest_ratio(width: float, height: float, choices: tuple[str, ...], sep: str) -> str:
    """The choice closest in shape to width x height, then closest in pixel count.

    The makers take a fixed list of shapes, not free sizes, so Krea (which
    resells these same models) has to snap too; this keeps the aspect."""
    target_shape = math.log(width / height)
    target_area = math.log(width * height)

    def distance(choice: str) -> tuple[float, float]:
        a, b = (float(part) for part in choice.split(sep))
        return (round(abs(math.log(a / b) - target_shape), 9), abs(math.log(a * b) - target_area))

    return min(choices, key=distance)


def _as_list(value: Any) -> list[Any]:
    if value in (None, ""):
        return []
    return [item for item in (value if isinstance(value, list) else [value]) if item not in (None, "")]


def _required_prompt(body: Mapping[str, Any]) -> str:
    prompt = body.get("prompt")
    if not isinstance(prompt, str) or not prompt.strip():
        raise ValueError("Prompt is required")
    return prompt


def krea_outputs(media_type: str, value: str) -> dict[str, Any]:
    """A direct result in a Krea node's ports (no Krea job on this route)."""
    from services.output import portable_output_ref

    ref = portable_output_ref(str(value), require_file=True)
    plural = {"Image": "images", "Video": "videos"}[media_type]
    return {
        media_type.lower(): {"type": media_type, "value": str(value)},
        plural: {"type": "Array", "value": [ref]},
        "artifacts": {"type": "Array", "value": [{"type": media_type, "value": ref}]},
    }


def fixed_model(expected: str) -> Callable[[str], Callable[..., Any]]:
    """KREA_TRANSLATIONS' per-model translator for a handler that serves one
    model: it checks the overlay names that model and leaves the node as is
    (the handler maps Krea's request itself, since reading JSON params and
    ports is async)."""

    def make(model: str):
        if model != expected:
            raise ValueError(f"direct route model {model!r} isn't {expected!r}")

        def translate(node: GraphNode, inputs: dict[str, PortValueDict]):
            return node, inputs

        return translate

    return make


# -- Ideogram -----------------------------------------------------------------
# Ideogram's seed field is an integer; Krea's own Ideogram 4.5 schema bounds it
# at 2147483647, and no Ideogram page names a different bound.
IDEOGRAM_SEED_MAX = 2147483647
# "The aspect ratio for an Ideogram 3.x or 2.x generation ... Allowed values:
# `auto`, `1x3`, `3x1`, `1x2`, `2x1`, `9x16`, `16x9`, `10x16`, `16x10`, `2x3`,
# `3x2`, `3x4`, `4x3`, `4x5`, `5x4`, `1x1`"
# (https://developer.ideogram.ai/v2/api-reference/images/generate/ideogram-2a.md).
IDEOGRAM_ASPECT_RATIOS = (
    "1x1", "1x3", "3x1", "1x2", "2x1", "9x16", "16x9", "10x16", "16x10",
    "2x3", "3x2", "3x4", "4x3", "4x5", "5x4",
)
# Precise edit: "reference_images ... (max 4 ...) A request with a `mask` can
# include at most three" (v2 precise-edit/ideogram-4-5).
PRECISE_EDIT_MAX_REFS = 4
PRECISE_EDIT_MAX_REFS_WITH_MASK = 3
PRECISE_EDIT_QUALITIES = ("very_low", "low", "medium", "high")


def ideogram_2a_request(body: Mapping[str, Any]) -> dict[str, Any]:
    """Krea "Ideogram 2.0A Turbo" -> POST /v2/image/generate/ideogram-2a (JSON).

    rendering_speed "turbo"; width/height -> the nearest aspect_ratio (the
    field is "not `auto`: it uses `1x1`" when omitted, so it's always sent);
    seed -> integer; one image. Nothing Krea takes is dropped."""
    request: dict[str, Any] = {
        "prompt": _required_prompt(body),
        "aspect_ratio": nearest_ratio(*_size(body), IDEOGRAM_ASPECT_RATIOS, "x"),
        "rendering_speed": "turbo",
        "num_images": 1,
    }
    seed = whole_seed(body.get("seed"), IDEOGRAM_SEED_MAX)
    if seed is not None:
        request["seed"] = seed
    return request


def ideogram_3_request(body: Mapping[str, Any]) -> tuple[dict[str, Any], list[str]]:
    """Krea Ideogram 3 -> POST /v1/ideogram-v3/generate (multipart): the
    fields, and the character reference to upload.

    The v1 endpoint is the one Nebula's own ideogram-character node uses,
    whose request enums the v1 page shows (aspect_ratio "1x1",
    rendering_speed "TURBO"); the v2 ideogram-3 page lists no values for
    them. v1 takes the character reference in the same call ("Generations
    with character reference are subject to the character reference
    pricing ... currently only supports 1 character reference image").
    rendering_speed DEFAULT (Krea exposes none); width/height -> aspect_ratio;
    seed -> integer. style_images never reach here: their per-image
    strength has no Ideogram field, so a recipe with them stays on Krea
    (directRoute.blockedBy), and a wired one is refused."""
    if _as_list(body.get("style_images")):
        raise ValueError(
            "Ideogram's own API has no per-image style strength, so Krea's style images can't run on your "
            "Ideogram key. Disconnect them, or choose the Krea connection (or remove the Ideogram key) to "
            "run this node on Krea."
        )
    characters = [str(item) for item in _as_list(body.get("character_reference_images"))]
    if len(characters) > 1:
        raise ValueError(
            f"Ideogram's API takes one character reference image per request ({len(characters)} connected)."
        )
    fields: dict[str, Any] = {
        "prompt": _required_prompt(body),
        "aspect_ratio": nearest_ratio(*_size(body), IDEOGRAM_ASPECT_RATIOS, "x"),
        "rendering_speed": "DEFAULT",
        "num_images": 1,
    }
    seed = whole_seed(body.get("seed"), IDEOGRAM_SEED_MAX)
    if seed is not None:
        fields["seed"] = seed
    return fields, characters


def ideogram_precise_edit_request(body: Mapping[str, Any]) -> tuple[dict[str, Any], str, str | None, list[str]]:
    """Krea Ideogram 4.5 Precise -> POST /v2/image/precise-edit/ideogram-4-5
    (multipart): fields, image, mask, reference images.

    Krea's fields map one to one: image_url -> image, mask_url -> mask
    ("Black marks the area to edit"; Krea's convention too), reference_images
    -> reference_images (4, or 3 with a mask), quality (Krea default high),
    seed. The output keeps the image's own size, on both routes."""
    image = body.get("image_url")
    if not image:
        raise ValueError("Image is required for Ideogram 4.5 Precise Edit")
    mask = body.get("mask_url") or None
    references = [str(item) for item in _as_list(body.get("reference_images"))]
    limit = PRECISE_EDIT_MAX_REFS_WITH_MASK if mask else PRECISE_EDIT_MAX_REFS
    if len(references) > limit:
        raise ValueError(
            f"Ideogram 4.5 Precise Edit takes up to {limit} reference images"
            f"{' with a mask' if mask else ''} ({len(references)} given)."
        )
    quality = str(body.get("quality") or "high")
    if quality not in PRECISE_EDIT_QUALITIES:
        raise ValueError(f"Quality must be one of {', '.join(PRECISE_EDIT_QUALITIES)} (received {quality!r})")
    fields: dict[str, Any] = {"prompt": _required_prompt(body), "quality": quality, "num_images": 1}
    seed = whole_seed(body.get("seed"), IDEOGRAM_SEED_MAX)
    if seed is not None:
        fields["seed"] = seed
    return fields, str(image), (str(mask) if mask else None), references


async def _ideogram_file(field: str, value: str, what: str):
    from handlers.ideogram import _file_part

    return await _file_part(field, media_ref(value, what))


async def krea_ideogram_2a(node: GraphNode, inputs: dict[str, PortValueDict], api_keys: dict[str, str]) -> dict[str, Any]:
    from handlers.ideogram import _post_json, _require_key, _save_first_image

    api_key = _require_key(api_keys)
    request = ideogram_2a_request(await krea_request(node, inputs))
    result = await _post_json("/v2/image/generate/ideogram-2a", api_key, request)
    return krea_outputs("Image", (await _save_first_image(result))["image"]["value"])


async def krea_ideogram_3(node: GraphNode, inputs: dict[str, PortValueDict], api_keys: dict[str, str]) -> dict[str, Any]:
    from handlers.ideogram import _post_multipart, _require_key, _save_first_image

    api_key = _require_key(api_keys)
    fields, characters = ideogram_3_request(await krea_request(node, inputs))
    files = [await _ideogram_file("character_reference_images", value, "Character reference image")
             for value in characters]
    result = await _post_multipart("/v1/ideogram-v3/generate", api_key, fields, files)
    return krea_outputs("Image", (await _save_first_image(result))["image"]["value"])


async def krea_ideogram_precise_edit(node: GraphNode, inputs: dict[str, PortValueDict], api_keys: dict[str, str]) -> dict[str, Any]:
    from handlers.ideogram import _post_multipart, _require_key, _save_first_image

    api_key = _require_key(api_keys)
    fields, image, mask, references = ideogram_precise_edit_request(await krea_request(node, inputs))
    files = [await _ideogram_file("image", image, "Image")]
    if mask:
        files.append(await _ideogram_file("mask", mask, "Mask"))
    files += [await _ideogram_file("reference_images", value, "Reference image") for value in references]
    result = await _post_multipart("/v2/image/precise-edit/ideogram-4-5", api_key, fields, files)
    return krea_outputs("Image", (await _save_first_image(result))["image"]["value"])


# -- Runway -------------------------------------------------------------------
# Runway seeds: "seed (integer) - 0-4294967295" (api.md, gen4_image and gen4.5).
RUNWAY_SEED_MAX = 4294967295
RUBY_OUTPUT_FORMATS = ("hdr10", "hlg", "hdr_prores")  # the three Krea offers, of Runway's six
RUBY_PRORES_PROFILES = ("422", "4444", "422 HQ")


async def _runway_media(value: str, what: str, api_key: str, *, video: bool = False) -> str:
    """A Runway-ready URI: https/data/runway pass, a local file becomes a data
    URI under 5MB or an ephemeral upload (handlers/runway.py)."""
    from handlers.runway import _local_media_uri, _resolve_image

    value = media_ref(value, what)
    if value.startswith("http://"):
        raise ValueError(f"{what} must be an https URL for Runway (received an http URL)")
    if video:
        return await _local_media_uri(value, "video/mp4", api_key, what)
    return await _resolve_image(value, api_key)


def runway_gen4_image_request(body: Mapping[str, Any]) -> tuple[dict[str, Any], list[dict[str, str]]]:
    """Krea Runway Gen-4 Image -> gen4_image on POST /v1/text_to_image: the
    body without its references, and the references ({url, tag}) to resolve.

    prompt -> promptText (Runway: "A non-empty string up to 1000 characters");
    width/height -> the nearest gen4_image ``ratio`` (Runway takes a fixed
    list); seed -> integer; reference_images [{url, tag}] ->
    referenceImages [{uri, tag}] (both max 3; the tag is how the prompt names
    an image, so it is kept)."""
    from handlers.runway import RUNWAY_IMAGE_MODELS

    spec = RUNWAY_IMAGE_MODELS["gen4_image"]
    prompt = _required_prompt(body)
    if len(prompt) > spec["prompt_max"]:
        raise ValueError(f"Runway Gen-4 Image takes a prompt of up to {spec['prompt_max']} characters.")
    references = []
    for item in _as_list(body.get("reference_images")):
        if not isinstance(item, Mapping) or not item.get("url"):
            raise ValueError("Each reference image needs a url (and a tag), as Krea takes them")
        reference = {"url": str(item["url"])}
        if item.get("tag"):
            reference["tag"] = str(item["tag"])
        references.append(reference)
    if len(references) > spec["refs_max"]:
        raise ValueError(f"Runway Gen-4 Image takes up to {spec['refs_max']} reference images ({len(references)} given).")
    request: dict[str, Any] = {
        "model": "gen4_image",
        "promptText": prompt,
        "ratio": nearest_ratio(*_size(body), spec["ratios"], ":"),
    }
    seed = whole_seed(body.get("seed"), RUNWAY_SEED_MAX)
    if seed is not None:
        request["seed"] = seed
    return request, references


def runway_gen4_5_params(body: Mapping[str, Any]) -> tuple[dict[str, Any], str, str | None]:
    """Krea Runway Gen-4.5 -> handlers/runway.py handle_runway_video's params
    (model gen4.5), prompt and start image.

    aspect_ratio -> ratio (handle_runway_video checks it against gen4.5's
    image-to-video or text-to-video list: Krea's 672:1584 isn't Runway's, and
    text-to-video takes only 1280:720 and 720:1280); duration -> whole
    seconds (Runway: "Must be an integer from 2 to 10"; a fractional Krea
    duration is rounded); seed -> integer."""
    duration = _number(body.get("duration", 5), "Duration")
    params: dict[str, Any] = {
        "model": "gen4.5",
        "ratio": str(body.get("aspect_ratio") or "1280:720"),
        "duration": int(math.floor(duration + 0.5)),
    }
    seed = whole_seed(body.get("seed"), RUNWAY_SEED_MAX)
    if seed is not None:
        params["seed"] = seed
    start = body.get("start_image") or None
    return params, _required_prompt(body), (str(start) if start else None)


def runway_ruby_request(body: Mapping[str, Any]) -> tuple[dict[str, Any], str]:
    """Krea Runway Ruby -> ruby on POST /v1/video_to_hdr: the body without its
    video, and the video to resolve.

    output_format -> outputFormat (Krea's three of Runway's six; default
    hdr10, as on both); prores_profile -> proresProfile only with hdr_prores
    (Runway: "Only valid when `outputFormat` is `hdr_prores`")."""
    video = body.get("video_url")
    if not video:
        raise ValueError("Video is required for Runway Ruby")
    output_format = str(body.get("output_format") or "hdr10")
    if output_format not in RUBY_OUTPUT_FORMATS:
        raise ValueError(f"Output format must be one of {', '.join(RUBY_OUTPUT_FORMATS)} (received {output_format!r})")
    request: dict[str, Any] = {"model": "ruby", "outputFormat": output_format}
    profile = body.get("prores_profile")
    if output_format == "hdr_prores" and profile:
        if str(profile) not in RUBY_PRORES_PROFILES:
            raise ValueError(f"ProRes profile must be one of {', '.join(RUBY_PRORES_PROFILES)} (received {profile!r})")
        request["proresProfile"] = str(profile)
    return request, str(video)


async def _runway_task(api_key: str, path: str, body: dict[str, Any], node_id: str) -> str:
    """Submit a Runway task, poll it, and return its first output URL."""
    from execution.async_poll_runner import async_poll_execute
    from handlers.runway import RUNWAY_API_BASE, _runway_poll_config

    async def noop_emit(event: Any) -> None:
        pass

    result = await async_poll_execute(config=_runway_poll_config(api_key, f"{RUNWAY_API_BASE}{path}"),
                                      submit_body=body, node_id=node_id, emit=noop_emit)
    outputs = result.get("output") or []
    url = outputs[0] if isinstance(outputs, list) and outputs else outputs if isinstance(outputs, str) else None
    if not url:
        raise RuntimeError("Runway returned no output URLs")
    return str(url)


def _runway_key(api_keys: Mapping[str, str]) -> str:
    from execution.missing_credential import MissingCredentialError

    key = api_keys.get("RUNWAY_API_KEY")
    if not key:
        raise MissingCredentialError("RUNWAY_API_KEY is required")
    return key


async def krea_runway_gen4_image(node: GraphNode, inputs: dict[str, PortValueDict], api_keys: dict[str, str]) -> dict[str, Any]:
    from services.output import get_run_dir, materialize_media_value

    api_key = _runway_key(api_keys)
    request, references = runway_gen4_image_request(await krea_request(node, inputs))
    if references:
        request["referenceImages"] = [
            {"uri": await _runway_media(item["url"], "Reference image", api_key),
             **({"tag": item["tag"]} if "tag" in item else {})}
            for item in references
        ]
    url = await _runway_task(api_key, "/text_to_image", request, node.id)
    path = await materialize_media_value(url, "Image", get_run_dir())
    return krea_outputs("Image", str(path))


async def krea_runway_gen4_5(node: GraphNode, inputs: dict[str, PortValueDict], api_keys: dict[str, str]) -> dict[str, Any]:
    from handlers.runway import handle_runway_video

    api_key = _runway_key(api_keys)
    params, prompt, start = runway_gen4_5_params(await krea_request(node, inputs))
    routed = {"prompt": PortValueDict(type="Text", value=prompt)}
    if start:
        routed["image"] = PortValueDict(type="Image", value=await _runway_media(start, "Start image", api_key))
    result = await handle_runway_video(node.model_copy(update={"params": params}), routed, api_keys)
    return krea_outputs("Video", result["video"]["value"])


async def krea_runway_ruby(node: GraphNode, inputs: dict[str, PortValueDict], api_keys: dict[str, str]) -> dict[str, Any]:
    from services.output import get_run_dir, save_video_from_url

    api_key = _runway_key(api_keys)
    request, video = runway_ruby_request(await krea_request(node, inputs))
    request["videoUri"] = await _runway_media(video, "Video", api_key, video=True)
    url = await _runway_task(api_key, "/video_to_hdr", request, node.id)
    # hdr10/hlg come back as .mp4, hdr_prores as a ProRes .mov (Runway's outputFormat docs).
    extension = "mov" if request["outputFormat"] == "hdr_prores" else "mp4"
    path = await save_video_from_url(url, get_run_dir(), extension=extension)
    return krea_outputs("Video", str(path))


# Translation ids the sync overlay names -> (direct handler, translator for a model).
TRANSLATIONS: dict[str, tuple[Callable[..., Any], Callable[[str], Callable[..., Any]]]] = {
    "krea-ideogram-precise-edit": (krea_ideogram_precise_edit, fixed_model("ideogram-4-5")),
    "krea-ideogram-3": (krea_ideogram_3, fixed_model("ideogram-v3")),
    "krea-ideogram-2a": (krea_ideogram_2a, fixed_model("ideogram-2a")),
    "krea-runway-gen4-image": (krea_runway_gen4_image, fixed_model("gen4_image")),
    "krea-runway-gen4-5": (krea_runway_gen4_5, fixed_model("gen4.5")),
    "krea-runway-ruby": (krea_runway_ruby, fixed_model("ruby")),
}
