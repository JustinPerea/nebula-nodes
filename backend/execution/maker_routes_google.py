"""Google maker routes for more fal and Krea copies (the Google lane, 2026-10-14).

Same pattern as execution/maker_routes.py (Nano Banana's fal and Krea
copies): services/node_route.py picks the route, ``dual_route`` filters each
route's params, and the translators here turn the copy's params into what
Google's own API takes. Every model id, field and limit below was read on
Google's pages on 2026-10-14 (quotes inline).

- ``identity-edit`` (fal's Nano Banana 2 edit with Character bundles) ->
  gemini-3.1-flash-image on the Gemini API, the model fal's endpoint runs.
- ``krea-image-google-nano-banana-2-1`` -> gemini-nano-banana-2.1 (Gemini API,
  Interactions API only).
- ``krea-video-google-veo-3-1`` / ``-fast`` / ``-lite`` -> the Vertex AI GA
  ids on GOOGLE_VERTEX_CREDENTIALS. The Gemini API's Veo 3.1 previews shut
  down 2026-10-22 ("veo-3.1-generate-preview | October 15, 2025 | October 22,
  2026", https://ai.google.dev/gemini-api/docs/deprecations), so these copies
  use Vertex only.
- ``krea-video-google-gemini-omni-flash-1-1`` -> gemini-omni-1.1-flash (Gemini
  API GA, Interactions API).
"""
from __future__ import annotations

from typing import Any, Awaitable, Callable

from execution import maker_routes
from execution.missing_credential import MissingCredentialError
from models.events import ExecutionEvent
from models.graph import GraphNode, PortValueDict

Emit = Callable[[ExecutionEvent], Awaitable[None]] | None


# -- shared helpers ----------------------------------------------------------

def _port_or_param(inputs: dict[str, PortValueDict], params: dict[str, Any], key: str) -> str | None:
    """A Krea field's value: the wired port wins, else the saved param."""
    port = inputs.get(key)
    if port is not None and port.value not in (None, "", []):
        value = port.value[0] if isinstance(port.value, list) else port.value
        return str(value) if value not in (None, "") else None
    value = params.get(key)
    return str(value) if value not in (None, "") else None


def _port_or_param_list(inputs: dict[str, PortValueDict], params: dict[str, Any], key: str) -> list[str]:
    """A Krea list field (reference images/videos): the wired port, else the JSON param."""
    port = inputs.get(key)
    if port is not None and port.value not in (None, "", []):
        values = port.value if isinstance(port.value, list) else [port.value]
    else:
        values = maker_routes._json_list(params.get(key))
    return [str(value) for value in values if value not in (None, "")]


def _prompt(inputs: dict[str, PortValueDict], params: dict[str, Any]) -> PortValueDict | None:
    value = _port_or_param(inputs, params, "prompt")
    return PortValueDict(type="Text", value=value) if value else None


def _krea_video_result(result: dict[str, Any]) -> dict[str, Any]:
    """A direct video in a Krea node's ports: video, videos and artifacts (no Krea job)."""
    from services.output import portable_output_ref

    ref = portable_output_ref(str(result["video"]["value"]), require_file=True)
    return {
        "video": result["video"],
        "videos": {"type": "Array", "value": [ref]},
        "artifacts": {"type": "Array", "value": [{"type": "Video", "value": ref}]},
    }


# -- identity-edit -> Gemini API ---------------------------------------------
# fal-ai/nano-banana-2/edit is Nano Banana 2, which is gemini-3.1-flash-image
# on the Gemini API (https://ai.google.dev/gemini-api/docs/models). Its edit
# takes the base image plus references: "Up to 14 reference images"
# (https://ai.google.dev/gemini-api/docs/image-generation), the same cap
# cinema.identity uses for nano-banana-fal-edit.

IDENTITY_EDIT_MODEL = "gemini-3.1-flash-image"
# The node's UI enums -> fal's and Google's dialect. Google: "Gemini 3.1 Flash
# Image | minimal, high | minimal" (image-generation, thinking levels), so
# medium rounds up to high, as on fal.
IDENTITY_EDIT_RESOLUTION_MAP: dict[str, str] = {"1024": "1K", "2048": "2K"}
IDENTITY_EDIT_THINKING_MAP: dict[str, str] = {"low": "minimal", "medium": "high", "high": "high"}


def identity_edit_request(
    node: GraphNode, inputs: dict[str, PortValueDict],
) -> tuple[dict[str, Any], dict[str, PortValueDict]]:
    """What both routes of identity-edit send: (params, inputs).

    Refuses a wired mask (neither route has a mask control). With a Character
    wired in, the bundle's verbatim trait string leads the prompt and its
    reference views ride behind the base (edit-target) image; the bundle's
    seed fills an unset seed (fal reads it; the Gemini API documents no image
    seed). resolution and thinking_level come back in fal's dialect
    (1K/2K, minimal/high); identity_strength and input_fidelity are dropped."""
    from cinema.identity import expand_character, max_refs_for

    image_input = inputs.get("image")
    base_image = str(image_input.value).strip() if image_input and image_input.value else ""
    if not base_image:
        raise ValueError("identity-edit requires a base image on the 'image' port")

    mask_input = inputs.get("mask")
    if mask_input and mask_input.value:
        # Retain old graph ports/edges, but never bill an unsupported
        # masked edit or quietly generate a different, unmasked image.
        raise ValueError(
            "Identity Edit does not support masks on the Nano Banana 2 endpoint; "
            "disconnect Mask before running this node"
        )

    prompt_input = inputs.get("prompt")
    base_prompt = str(prompt_input.value) if prompt_input and prompt_input.value else ""
    character_input = inputs.get("character")
    bundle = character_input.value if character_input and character_input.value else None

    params = dict(node.params)
    # Neither endpoint has an identity-adherence field. Keep saved strength
    # metadata on the source node, but never translate it into an invented
    # provider parameter. input_fidelity (older recipes) is another API's field.
    params.pop("identity_strength", None)
    params.pop("input_fidelity", None)

    # The multi-image `images` port carries base + refs; the `character` port
    # is consumed here, never forwarded.
    routed_inputs = {k: v for k, v in inputs.items() if k not in ("image", "character")}
    if bundle:
        expanded = expand_character(
            bundle, base_prompt, [base_image], model_max_refs=max_refs_for("nano-banana-fal-edit"),
        )
        # expand_character appends override_refs last: move the edit target
        # back to the front, identity refs (stored order) after.
        image_urls = [base_image] + list(expanded["image_urls"])[:-1]
        routed_inputs["prompt"] = PortValueDict(type="Text", value=expanded["prompt"])
        if expanded.get("seed") is not None and not params.get("seed"):
            params["seed"] = expanded["seed"]
    else:
        image_urls = [base_image]
    routed_inputs["images"] = PortValueDict(type="Image", value=image_urls)

    resolution = str(params.get("resolution") or "")
    if resolution in IDENTITY_EDIT_RESOLUTION_MAP:
        params["resolution"] = IDENTITY_EDIT_RESOLUTION_MAP[resolution]
    thinking = str(params.get("thinking_level") or "")
    if thinking in IDENTITY_EDIT_THINKING_MAP:
        params["thinking_level"] = IDENTITY_EDIT_THINKING_MAP[thinking]
    return params, routed_inputs


def identity_edit_to_google(
    node: GraphNode, inputs: dict[str, PortValueDict],
) -> tuple[GraphNode, dict[str, PortValueDict]]:
    """identity-edit -> handle_nano_banana on gemini-3.1-flash-image:
    resolution 1K/2K -> imageSize, thinking minimal/high -> thinkingLevel
    (generationConfig.thinkingConfig). Dropped: the bundle seed (no image seed
    on the Gemini API) and identity_strength (no equivalent anywhere)."""
    params, routed_inputs = identity_edit_request(node, inputs)
    out: dict[str, Any] = {"model": IDENTITY_EDIT_MODEL}
    if params.get("resolution") in {"1K", "2K"}:
        out["imageSize"] = params["resolution"]
    if params.get("thinking_level") in {"minimal", "high"}:
        out["thinkingLevel"] = params["thinking_level"]
    return node.model_copy(update={"params": out}), routed_inputs


async def google_identity_edit(node: GraphNode, inputs: dict[str, PortValueDict], api_keys: dict[str, str]) -> dict[str, Any]:
    return await maker_routes.google_nano_banana(node, inputs, api_keys)


# -- Krea Nano Banana 2.1 -> Gemini API (Interactions) ------------------------
# "Configurable Thinking levels (minimal, medium default, and high)" and
# "1K, 2K, and 4K output resolutions (default 1K)"
# (https://ai.google.dev/gemini-api/docs/models/gemini-nano-banana-2.1).

NANO_BANANA_21_SIZES = {"1K", "2K", "4K"}
NANO_BANANA_21_THINKING = {"minimal", "medium", "high"}


def krea_nano_banana_21_to_google(model: str) -> maker_routes.Translate:
    """Krea's Nano Banana 2.1 params -> handle_nano_banana's: the Krea Nano
    Banana translation (prompt, image_urls, aspect_ratio), plus resolution ->
    imageSize and thinking_level -> thinkingLevel (Interactions
    generation_config.thinking_level). width/height stay Krea-only and keep
    a run on Krea when set (directRoute.blockedBy)."""
    base = maker_routes.krea_nano_banana_to_google(model)

    def translate(node: GraphNode, inputs: dict[str, PortValueDict]) -> tuple[GraphNode, dict[str, PortValueDict]]:
        routed, routed_inputs = base(node, inputs)
        out = dict(routed.params)
        if str(node.params.get("resolution") or "") in NANO_BANANA_21_SIZES:
            out["imageSize"] = str(node.params["resolution"])
        if str(node.params.get("thinking_level") or "") in NANO_BANANA_21_THINKING:
            out["thinkingLevel"] = str(node.params["thinking_level"])
        return routed.model_copy(update={"params": out}), routed_inputs

    return translate


# -- Krea Veo 3.1 -> Vertex AI -----------------------------------------------
# Vertex model card (https://docs.cloud.google.com/gemini-enterprise-agent-platform/models/veo/3-1-generate):
# "Video lengths: 4, 6, or 8 seconds; reference image to video only supports
# 8 seconds", "Supported aspect ratios: 9:16, 16:9"; Standard outputs "720p,
# 1080p, 4K", Fast and Lite "720p, 1080p"; Lite: "Use reference images Not
# supported". API reference
# (https://docs.cloud.google.com/vertex-ai/generative-ai/docs/model-reference/veo-video-generation):
# "generateAudio | boolean Required for Veo 3 models", "lastFrame ... An image
# of the last frame of a video to fill the space between", referenceImages
# "A list of up to three asset images", referenceType "asset"; and for
# reference images "4k (Veo 3.1 Preview models only)" (references page).

VERTEX_REFERENCE_MODELS = {"veo-3.1-generate-001", "veo-3.1-fast-generate-001"}
MAX_VEO_REFERENCES = 3


def krea_veo_to_vertex(model: str) -> maker_routes.Translate:
    """Krea's Veo 3.1 params -> the Vertex request fields (vertex_krea_veo):

    - aspect_ratio -> aspectRatio; duration 4/6/8 -> durationSeconds;
      resolution 720p/1080p/4K -> "720p"/"1080p"/"4k".
    - generate_audio -> generateAudio (Lite's Krea copy has no such field and
      is priced at Google's video-only rate, so it sends false).
    - start_image -> image, end_image -> lastFrame, reference_images ->
      referenceImages (asset): port first, else the saved param."""

    def translate(node: GraphNode, inputs: dict[str, PortValueDict]) -> tuple[GraphNode, dict[str, PortValueDict]]:
        params = node.params
        out: dict[str, Any] = {"model": model, "generateAudio": params.get("generate_audio") is True}
        if params.get("aspect_ratio"):
            out["aspectRatio"] = str(params["aspect_ratio"])
        if params.get("duration") not in (None, ""):
            out["duration"] = str(params["duration"])
        if params.get("resolution"):
            out["resolution"] = str(params["resolution"]).lower()
        routed: dict[str, PortValueDict] = {}
        prompt = _prompt(inputs, params)
        if prompt:
            routed["prompt"] = prompt
        for source, target in (("start_image", "image"), ("end_image", "last_frame")):
            value = _port_or_param(inputs, params, source)
            if value:
                routed[target] = PortValueDict(type="Image", value=value)
        references = _port_or_param_list(inputs, params, "reference_images")
        if references:
            routed["reference_images"] = PortValueDict(type="Image", value=references)
        return node.model_copy(update={"params": out}), routed

    return translate


async def vertex_krea_veo(
    node: GraphNode, inputs: dict[str, PortValueDict], api_keys: dict[str, str], emit: Emit = None,
) -> dict[str, Any]:
    """One Veo 3.1 run on Vertex for a translated Krea copy. Every check runs
    before any request, so a refused run never reaches Google."""
    from handlers import veo

    credentials = (api_keys.get("GOOGLE_VERTEX_CREDENTIALS") or "").strip()
    if not credentials:
        raise MissingCredentialError("GOOGLE_VERTEX_CREDENTIALS is required")
    params = node.params
    model = str(params.get("model") or "")
    if model not in veo.VEO_MODELS:
        raise ValueError(f"'{model}' isn't a Veo 3.1 model on Vertex")
    prompt = inputs.get("prompt")
    image, last = inputs.get("image"), inputs.get("last_frame")
    references = list((inputs.get("reference_images") or PortValueDict(type="Image", value=[])).value or [])
    if last and not image:
        # Gemini API Veo reference: lastFrame "Must be used in combination with the image parameter."
        raise ValueError("An end image needs a start image too")
    if not (prompt and prompt.value) and not image:
        raise ValueError("Veo needs a prompt or a start image")
    resolution = str(params.get("resolution") or "")
    if resolution == "4k" and model not in veo.VERTEX_4K_MODELS:
        raise ValueError("On Vertex only Veo 3.1 (Standard) renders 4K; pick 1080p")
    if references:
        if model not in VERTEX_REFERENCE_MODELS:
            raise ValueError("Veo 3.1 Lite takes no reference images on Vertex")
        if len(references) > MAX_VEO_REFERENCES:
            raise ValueError(f"Vertex takes up to {MAX_VEO_REFERENCES} reference images (got {len(references)})")
        if str(params.get("duration") or "8") != "8":
            raise ValueError("On Vertex, reference images only make 8-second videos; set duration to 8")
        if resolution == "4k":
            raise ValueError("Google documents 4K with reference images only on the Veo previews; pick 720p or 1080p")
        if image or last:
            raise ValueError("Vertex documents reference images as their own mode; remove the start/end image")

    instance: dict[str, Any] = {}
    if prompt and prompt.value:
        instance["prompt"] = str(prompt.value)
    if image:
        instance["image"] = veo._vertex_frame(await veo._image_to_veo_payload(str(image.value)))
    if last:
        instance["lastFrame"] = veo._vertex_frame(await veo._image_to_veo_payload(str(last.value)))
    if references:
        instance["referenceImages"] = [
            {"image": veo._vertex_frame(await veo._image_to_veo_payload(str(value))), "referenceType": "asset"}
            for value in references
        ]
    parameters = veo._veo_parameters({
        "aspectRatio": params.get("aspectRatio"), "duration": params.get("duration"), "resolution": resolution,
    })
    parameters["generateAudio"] = params.get("generateAudio") is True
    result = await veo.run_vertex_veo(node, credentials, model, instance, parameters, emit)
    return _krea_video_result(result)


vertex_krea_veo.takes_emit = True  # type: ignore[attr-defined]


# -- Krea Gemini Omni Flash 1.1 -> Gemini API (Interactions) ------------------
# https://ai.google.dev/gemini-api/docs/omni: task values "text_to_video,
# image_to_video, reference_to_video, edit, extend"; "Video references
# support a maximum of 3 clips, up to 3 seconds each". The Interactions API
# reference (https://ai.google.dev/api/interactions-api) VideoResponseFormat:
# "duration string (optional) The duration for the video output",
# "resolution ... Defaults to 720p"; model card "Output video 3s-10s".
# The duration string's format ("integers between 3 and 10, followed by "s"")
# is from the Vertex page for the same Interactions API
# (https://docs.cloud.google.com/gemini-enterprise-agent-platform/models/video/generate-videos-from-references).

MAX_OMNI_VIDEO_REFERENCES = 3


def krea_omni_to_google(model: str) -> maker_routes.Translate:
    """Krea's Gemini Omni Flash 1.1 params -> handle_gemini_omni's:

    - start_image -> images, task image_to_video ("The first image defines the
      starting frame").
    - reference_images -> images and reference_videos -> video parts, task
      reference_to_video.
    - aspect_ratio -> response_format.aspect_ratio; duration -> response_format.duration.
    - A start image together with references is refused: Google only tells
      them apart by tags written into the prompt."""

    def translate(node: GraphNode, inputs: dict[str, PortValueDict]) -> tuple[GraphNode, dict[str, PortValueDict]]:
        params = node.params
        out: dict[str, Any] = {"model": model, "delivery": "uri"}
        if params.get("aspect_ratio"):
            out["aspect_ratio"] = str(params["aspect_ratio"])
        if params.get("duration") not in (None, ""):
            out["duration"] = params["duration"]
        routed: dict[str, PortValueDict] = {}
        prompt = _prompt(inputs, params)
        if prompt:
            routed["prompt"] = prompt
        start = _port_or_param(inputs, params, "start_image")
        images = _port_or_param_list(inputs, params, "reference_images")
        videos = _port_or_param_list(inputs, params, "reference_videos")
        if len(videos) > MAX_OMNI_VIDEO_REFERENCES:
            raise ValueError(f"Gemini Omni takes up to {MAX_OMNI_VIDEO_REFERENCES} reference videos (got {len(videos)})")
        if start and (images or videos):
            raise ValueError(
                "Gemini Omni on Google's API can't take a start image and references together "
                "(Google tells them apart only by tags in the prompt); use one or the other"
            )
        if start:
            out["task"] = "image_to_video"
            routed["images"] = PortValueDict(type="Image", value=[start])
        elif images or videos:
            out["task"] = "reference_to_video"
            if images:
                routed["images"] = PortValueDict(type="Image", value=images)
            if videos:
                routed["video"] = PortValueDict(type="Video", value=videos)
        return node.model_copy(update={"params": out}), routed

    return translate


async def google_krea_omni(
    node: GraphNode, inputs: dict[str, PortValueDict], api_keys: dict[str, str], emit: Emit = None,
) -> dict[str, Any]:
    from handlers.gemini_omni import handle_gemini_omni

    if str(node.params.get("model") or "") != "gemini-omni-1.1-flash":
        raise ValueError(f"No Gemini API route for {node.params.get('model')!r}")
    return _krea_video_result(await handle_gemini_omni(node, inputs, api_keys, emit=emit))


google_krea_omni.takes_emit = True  # type: ignore[attr-defined]


# Translation ids the generated Krea nodes name (scripts/sync-krea-catalog.py
# GOOGLE_LANE_ROUTES), registered into maker_routes.KREA_TRANSLATIONS.
KREA_TRANSLATIONS: dict[str, tuple[maker_routes.Handler, Callable[[str], maker_routes.Translate]]] = {
    "krea-nano-banana-2-1": (maker_routes.krea_google_nano_banana, krea_nano_banana_21_to_google),
    "krea-veo-vertex": (vertex_krea_veo, krea_veo_to_vertex),
    "krea-gemini-omni": (google_krea_omni, krea_omni_to_google),
}
maker_routes.KREA_TRANSLATIONS.update(KREA_TRANSLATIONS)
