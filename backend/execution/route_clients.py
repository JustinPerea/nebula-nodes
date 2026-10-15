"""The provider clients route-table nodes run on (definition ``routes``).

A route names its client in ``handler`` (services/node_route.py RouteSpec).
:data:`ROUTE_CLIENTS` maps that name to a :class:`RouteClient`, and
:func:`register_route_nodes` gives every route-table node in the registry an
``execution/maker_routes.py`` ``multi_route`` handler over those clients.

What a client gets, per run: a ``model_copy`` of the node holding only the
route's params (``sharedParams`` plus that route's own), already renamed and
value-mapped into the provider's names (maker_routes.translate_params), the
run's inputs and keys, its ``route`` spec and the ``endpoint`` the router
resolved from ``endpointWhen``. A Krea route's copy carries ``_kreaAuth`` set
to how this run bills, plan or API token.

The client does what is structural, the part a table can't say: it puts the
wired media where the provider takes it (``images`` into ``image_urls`` on
fal, ``input_references`` on OpenRouter, ``images`` on BFL and Replicate), a
video node's mode from its wired ports (BFL ``mode``, fal's keyframe
timing), and it saves the result under the node's own output port, typed by
that port (not by the provider's URL). A wired input the chosen endpoint
can't take stops the run before any request, rather than being dropped.

The port names are the route-table nodes' (DESIGN section 7): ``prompt``;
``images`` (an image node's references); ``start_image``, ``keyframes``,
``end_image`` and ``start_video`` (a video node); ``video`` (a video tool's
source). A client meeting a provider path it has no shape for refuses it:
add the shape here, pinned to that provider's schema, when the node lands.
"""
from __future__ import annotations

import base64
import mimetypes
from functools import partial
from pathlib import Path
from typing import Any, Awaitable, Callable, Mapping, NamedTuple

from models.graph import GraphNode, PortValueDict

RouteRun = Callable[..., Awaitable[dict[str, Any]]]


class RouteClient(NamedTuple):
    """``run(node, inputs, api_keys, *, route, emit, endpoint)`` makes the call."""
    run: RouteRun


# -- Shared structure ----------------------------------------------------------

def port_values(inputs: Mapping[str, Any], port: str) -> list[Any]:
    """A port's values as a list (a list port's items, else its one value),
    without the empty ones (the router counts the same way, filled_counts)."""
    value = getattr(inputs.get(port), "value", None)
    if value is None or value == "" or value == []:
        return []
    items = value if isinstance(value, list) else [value]
    return [item for item in items if item is not None and item != ""]


def one_value(inputs: Mapping[str, Any], port: str, where: str) -> Any:
    values = port_values(inputs, port)
    if len(values) > 1:
        raise ValueError(f"{where} takes one {port}, but {len(values)} are wired")
    return values[0] if values else None


def prompt_of(inputs: Mapping[str, Any]) -> str | None:
    value = one_value(inputs, "prompt", "This node")
    return None if value is None else str(value)


def wired(inputs: Mapping[str, Any]) -> set[str]:
    return {port for port in inputs if port_values(inputs, port)}


def refuse_unwired(inputs: Mapping[str, Any], takes: set[str], where: str) -> None:
    """Stop before any request when a port with a value isn't one ``where``
    takes, so a wired input is never silently left out."""
    extra = sorted(wired(inputs) - takes)
    if extra:
        raise ValueError(f"{where} can't take the wired {', '.join(extra)}. Disconnect it or choose another provider.")


def refuse_end_alone(inputs: Mapping[str, Any], where: str) -> None:
    """A video node's end image needs a start image or keyframes before it,
    or the provider would open the clip on the frame meant to close it. Every
    video client checks this before its first request, so the recipe stops
    the same way on every route (and none bills it)."""
    if port_values(inputs, "end_image") and not (port_values(inputs, "start_image") or port_values(inputs, "keyframes")):
        raise ValueError(f"{where} needs a start image (or keyframes) to end on an end image")


# The most images BFL, fal and Replicate take for one FLUX 3 video, start
# image, keyframes and end image together: BFL "one to ten total"
# (api.bfl.ai/openapi.json Flux3VideoI2VInputs.keyframes), fal keyframes
# maxItems 10, Replicate images "up to 10" (all read 2026-10-15). The route
# rule (rules.ports "frames") stops it before the run; this keeps a list that
# arrives on one edge from reaching the provider.
VIDEO_MAX_FRAMES = 10


def video_frames(inputs: Mapping[str, Any], where: str) -> list[Any]:
    """A video node's images in time order: start, keyframes, end
    (refuse_end_alone), at most VIDEO_MAX_FRAMES of them."""
    refuse_end_alone(inputs, where)
    start = port_values(inputs, "start_image")[:1]
    frames = [*start, *port_values(inputs, "keyframes")]
    end = port_values(inputs, "end_image")[:1]
    frames = [*frames, *end]
    if len(frames) > VIDEO_MAX_FRAMES:
        raise ValueError(f"{where} takes at most {VIDEO_MAX_FRAMES} images in all (start image, keyframes and end "
                         f"image), but {len(frames)} are wired. Disconnect {len(frames) - VIDEO_MAX_FRAMES}.")
    return frames


def local_media_path(value: Any) -> Path | None:
    """The file behind one of Nebula's own outputs (an absolute path, a
    served ``/api/outputs`` reference or a loopback URL to it), checked by
    the allowed-path policy; None for an http(s) URL or a data: URI."""
    from services.file_access import require_allowed_path
    from services.output import local_media_ref

    text = str(value)
    ref = local_media_ref(text)
    if ref.startswith(("http://", "https://", "data:")):
        return None
    path = require_allowed_path(Path(ref))
    if not path.is_file():
        raise ValueError(f"A wired input isn't a readable file: {Path(ref).name}")
    return path


def media_url(value: Any) -> str:
    """A media value as a provider takes it inline: an http(s) URL or a
    data: URI as it is, a local output as a base64 data: URI."""
    path = local_media_path(value)
    if path is None:
        return str(value)
    mime = mimetypes.guess_type(path.name)[0] or "application/octet-stream"
    return f"data:{mime};base64,{base64.b64encode(path.read_bytes()).decode('ascii')}"


def output_port(definition: Mapping[str, Any]) -> tuple[str, str]:
    """The node's output port: its id and data type (Image, Video, ...)."""
    ports = [p for p in definition.get("outputPorts") or [] if isinstance(p, Mapping)]
    if not ports:
        raise ValueError(f"{definition.get('id')} has no output port")
    return str(ports[0]["id"]), str(ports[0].get("dataType"))


def as_output(definition: Mapping[str, Any], value: Any) -> dict[str, Any]:
    port, data_type = output_port(definition)
    return {port: {"type": data_type, "value": value}}


def rekey(definition: Mapping[str, Any], result: Mapping[str, Any], provider: str) -> dict[str, Any]:
    """A handler's result under the node's own output ports: a port the
    result names keeps its value, any other port takes the result's value of
    its type. A missing primary output is an error, not an empty node."""
    out: dict[str, Any] = {}
    for port in definition.get("outputPorts") or []:
        port_id, data_type = str(port["id"]), port.get("dataType")
        if port_id in result:
            out[port_id] = result[port_id]
            continue
        match = next((v for v in result.values() if isinstance(v, Mapping) and v.get("type") == data_type), None)
        if match is not None:
            out[port_id] = dict(match)
    primary, data_type = output_port(definition)
    if primary not in out:
        raise RuntimeError(f"{provider} finished without returning a {data_type.lower()}")
    return out


def _definition(node: GraphNode) -> dict[str, Any]:
    from execution import maker_routes

    return maker_routes.definition_for(node.definition_id)


def _set(params: Mapping[str, Any]) -> dict[str, Any]:
    return {key: value for key, value in params.items() if value is not None and value != ""}


# -- Black Forest Labs (handlers/bfl.py) ---------------------------------------
# Request bodies from api.bfl.ai/openapi.json, read 2026-10-15: Flux3ImageInputs
# and Flux3ImageKleinInputs take ``images`` (1-10, "each is an http(s) URL or
# base64"); Flux3VideoInputsBody is one of t2v, i2v (``keyframes``, "one
# starts the video, two start and end it, with more the first starts it, the
# last ends it"), v2v (``start_video``) or draft_enhance, keyed by ``mode``;
# Flux3VideoVE2VNamedInputs takes ``video``; Flux3VideoUpscaleInputs takes
# ``input_video`` and an optional ``prompt``. Every body is
# additionalProperties false. Data URIs are what BFL's own examples send
# ("keyframes": "data:image/png;base64,...", docs.bfl.ai/flux_3/flux3_overview).
# draft_enhance isn't wired (a draft's cache bundle isn't a Nebula port yet).

BFL_IMAGE_PATHS = frozenset({"flux-3-image", "flux-3-image-klein"})
BFL_VIDEO_PATH = "flux-3-video"
BFL_VIDEO_EDIT_PATH = "flux-tools/video-edit-v1"
BFL_VIDEO_UPSCALE_PATH = "flux-tools/video-upscale-v1"


def bfl_path(endpoint: Any) -> str:
    """``/v1/flux-3-image`` -> ``flux-3-image`` (bfl.submit adds the base)."""
    path = str(endpoint or "").strip("/")
    return path[len("v1/"):] if path.startswith("v1/") else path


def bfl_body(path: str, params: Mapping[str, Any], inputs: Mapping[str, Any]) -> dict[str, Any]:
    where = f"Black Forest Labs' {path}"
    body = _set(params)
    prompt = prompt_of(inputs)
    if path in BFL_IMAGE_PATHS:
        refuse_unwired(inputs, {"prompt", "images"}, where)
        images = [media_url(v) for v in port_values(inputs, "images")]
        if images:
            body["images"] = images
    elif path == BFL_VIDEO_PATH:
        refuse_unwired(inputs, {"prompt", "start_image", "keyframes", "end_image", "start_video"}, where)
        start_video = one_value(inputs, "start_video", where)
        frames = video_frames(inputs, where)
        if start_video is not None and frames:
            raise ValueError(f"{where} continues a video or animates images, not both. Disconnect one.")
        if start_video is not None:
            body.update(mode="v2v", start_video=media_url(start_video))
        elif frames:
            body.update(mode="i2v", keyframes=[media_url(v) for v in frames])
        else:
            body["mode"] = "t2v"
    elif path == BFL_VIDEO_EDIT_PATH:
        refuse_unwired(inputs, {"prompt", "start_video", "video"}, where)
        source = one_value(inputs, "start_video", where) or one_value(inputs, "video", where)
        if source is None:
            raise ValueError(f"{where} needs a video to edit")
        body["video"] = media_url(source)
    elif path == BFL_VIDEO_UPSCALE_PATH:
        refuse_unwired(inputs, {"prompt", "video", "start_video"}, where)
        source = one_value(inputs, "video", where) or one_value(inputs, "start_video", where)
        if source is None:
            raise ValueError(f"{where} needs a video to upscale")
        body["input_video"] = media_url(source)
    else:
        raise ValueError(f"Nebula has no request shape for Black Forest Labs' {path or '(no path)'} yet")
    if prompt is not None:
        body["prompt"] = prompt
    elif path != BFL_VIDEO_UPSCALE_PATH:
        raise ValueError(f"{where} needs a prompt")
    return body


async def run_bfl(node: GraphNode, inputs: dict[str, PortValueDict], api_keys: dict[str, str], *,
                  route: Mapping[str, Any], emit: Any = None, endpoint: Any = None) -> dict[str, Any]:
    from handlers import bfl

    definition = _definition(node)
    _, data_type = output_port(definition)
    path = bfl_path(endpoint if endpoint is not None else route.get("endpoint"))
    body = bfl_body(path, node.params, inputs)
    result = await bfl.run_task(bfl.api_key(api_keys), path, body, media_type=data_type, node_id=node.id, emit=emit)
    return as_output(definition, result.path)


# -- fal (handlers/fal_universal.py) -------------------------------------------
# Input fields per endpoint, from fal's queue OpenAPI for each endpoint id
# (fal.ai/api/openapi/queue/openapi.json?endpoint_id=blackforestlabs/flux-3/...),
# read 2026-10-15: edit-image ``image_urls`` (1-10); image-to-video
# ``image_url``; first-last-frame-to-video ``start_image_url`` and
# ``end_image_url``; keyframes-to-video ``keyframes`` [{image_url,
# frame_index}] ("Frame position of this keyframe in the generated 24 fps
# video. Must be unique and at most ``duration * 24``"; duration an integer
# 5-20, default 5); extend-video and edit-video ``video_url``. The /draft
# variants take the same media. Keyed by the endpoint's last path segment
# (the FLUX 3 family, Klein and Klein Base included), or by the whole id for
# an endpoint outside it, whose last segment says nothing about its shape:
# blackforestlabs/flux-video-upscale ``video_url`` (FluxVideoUpscaleInput)
# and krea/v3/edit ``image_urls`` (V3EditInput, 1-8), read 2026-10-15.

FAL_FPS = 24
FAL_DEFAULT_KEYFRAME_DURATION = 5
_FAL_FIELDS: dict[str, dict[str, tuple[str, bool]]] = {
    # segment, or endpoint id -> {port: (fal field, a list)}
    "text-to-image": {},
    "edit-image": {"images": ("image_urls", True)},
    "text-to-video": {},
    "image-to-video": {"start_image": ("image_url", False)},
    "first-last-frame-to-video": {"start_image": ("start_image_url", False), "end_image": ("end_image_url", False)},
    "extend-video": {"start_video": ("video_url", False)},
    "edit-video": {"start_video": ("video_url", False), "video": ("video_url", False)},
    "blackforestlabs/flux-video-upscale": {"video": ("video_url", False)},
    "krea/v3/edit": {"images": ("image_urls", True)},
}
FAL_KEYFRAMES = "keyframes-to-video"
# A route param that picks the endpoint (endpointWhen) and isn't a request
# field: FLUX 3 Video's ``draft`` chooses fal's /draft endpoint, and none of
# fal's FLUX 3 video schemas has a draft field.
FAL_ENDPOINT_SWITCHES = frozenset({"draft"})
# Fields fal's /draft endpoints don't have: drafts are 720p, so the
# resolution (a draft is blocked anywhere but hd) isn't sent.
FAL_DRAFT_DROPS = frozenset({"resolution"})


def fal_shape(endpoint: str) -> str:
    segments = [s for s in str(endpoint).strip("/").split("/") if s]
    if segments and segments[-1] == "draft":
        segments = segments[:-1]
    whole = "/".join(segments)
    if whole in _FAL_FIELDS:
        return whole
    return segments[-1] if segments else ""


def fal_draft(endpoint: str) -> bool:
    return str(endpoint).strip("/").endswith("/draft")


def keyframe_indexes(count: int, duration: int) -> list[int]:
    """``count`` frames spread evenly over a ``duration``-second clip at 24
    fps, first on frame 0 and last on the final one (BFL's own spacing for
    plain images: "the rest fall evenly in between")."""
    last = duration * FAL_FPS
    if count == 1:
        return [0]
    return [round(i * last / (count - 1)) for i in range(count)]


def fal_fields(endpoint: str, params: Mapping[str, Any], inputs: Mapping[str, Any]) -> dict[str, Any]:
    """The media fields for ``endpoint`` from the wired ports."""
    shape = fal_shape(endpoint)
    where = f"fal.ai's {endpoint}"
    if shape == FAL_KEYFRAMES:
        refuse_unwired(inputs, {"prompt", "start_image", "keyframes", "end_image"}, where)
        frames = video_frames(inputs, where)
        if not frames:
            raise ValueError(f"{where} needs at least one keyframe image")
        duration = params.get("duration", FAL_DEFAULT_KEYFRAME_DURATION)
        if isinstance(duration, bool) or not isinstance(duration, int):
            raise ValueError(f"{where} needs a set duration in seconds to place its keyframes (got {duration!r})")
        return {"keyframes": [{"image_url": media_url(value), "frame_index": index}
                              for value, index in zip(frames, keyframe_indexes(len(frames), duration))]}
    if shape not in _FAL_FIELDS:
        raise ValueError(f"Nebula has no request shape for fal.ai's {endpoint or '(no endpoint)'} yet")
    fields: dict[str, Any] = {}
    table = _FAL_FIELDS[shape]
    refuse_unwired(inputs, {"prompt", *table}, where)
    refuse_end_alone(inputs, where)
    for port, (field, many) in table.items():
        values = port_values(inputs, port)
        if not values:
            continue
        if field in fields:
            raise ValueError(f"{where} takes one source for {field}; disconnect one of the wired inputs")
        fields[field] = [media_url(v) for v in values] if many else media_url(one_value(inputs, port, where))
    return fields


# fal's default budget (handle_fal_universal) is 300 polls x 2 s, 10 minutes.
# A FLUX 3 video takes "several minutes per generation" (BFL) and may wait in
# fal's queue first, so a video job gets 600 polls x 3 s, 30 minutes, between
# Replicate's 15 and BFL's 60. When it runs out, the job is cancelled upstream.
FAL_VIDEO_POLLS: tuple[int, float] = (600, 3.0)


async def run_fal(node: GraphNode, inputs: dict[str, PortValueDict], api_keys: dict[str, str], *,
                  route: Mapping[str, Any], emit: Any = None, endpoint: Any = None) -> dict[str, Any]:
    """fal forwards every param it is given (handle_fal_universal), so the
    copy it gets holds only this route's translated params, the media fields
    and ``endpoint_id``: never ``_provider`` or another route's params, nor
    a param that only picks the endpoint (FAL_ENDPOINT_SWITCHES) or one a
    /draft endpoint doesn't have (FAL_DRAFT_DROPS)."""
    from execution.sync_runner import _fal_wrapper_node
    from handlers.fal_universal import handle_fal_universal

    definition = _definition(node)
    endpoint_id = str(endpoint if endpoint is not None else route.get("endpoint") or "").strip("/")
    dropped = FAL_ENDPOINT_SWITCHES | (FAL_DRAFT_DROPS if fal_draft(endpoint_id) else frozenset())
    sent = {key: value for key, value in _set(node.params).items() if key not in dropped}
    params = {**sent, **fal_fields(endpoint_id, node.params, inputs)}
    fal_node = _fal_wrapper_node(node.model_copy(update={"params": params}), endpoint_id)
    prompt = prompt_of(inputs)
    fal_inputs = {"prompt": PortValueDict(type="Text", value=prompt)} if prompt is not None else {}
    budget = {}
    if output_port(definition)[1] == "Video":
        budget = dict(zip(("max_polls", "poll_interval"), FAL_VIDEO_POLLS))
    result = await handle_fal_universal(fal_node, fal_inputs, api_keys, emit=emit, **budget)
    return rekey(definition, result, "fal.ai")


# -- Replicate official models (handlers/replicate_model.py) -------------------
# Inputs from replicate.com/black-forest-labs/flux-3-image/api/schema and
# .../flux-3/api/schema, read 2026-10-15: flux-3-image takes ``images`` (up
# to 10; "presence switches to edit"); flux-3 (video) takes ``images`` ("One
# image opens the clip ... Two images start and end it. Three or more (up to
# 10) become a storyboard") and ``start_video`` ("Can't be combined with
# images"). black-forest-labs/flux-video-upscale/api/schema (read
# 2026-10-15) takes its source as ``input_video`` (required) and an optional
# ``prompt`` (default "").

# Models whose one media input is a source video, under its field name.
REPLICATE_SOURCE_VIDEO: dict[str, str] = {"black-forest-labs/flux-video-upscale": "input_video"}


def replicate_input(params: Mapping[str, Any], inputs: Mapping[str, Any], where: str,
                    model: str = "") -> tuple[dict[str, Any], set[str]]:
    """The prediction input and which of its fields are media."""
    if model in REPLICATE_SOURCE_VIDEO:
        field = REPLICATE_SOURCE_VIDEO[model]
        refuse_unwired(inputs, {"prompt", "video"}, where)
        source = one_value(inputs, "video", where)
        if source is None:
            raise ValueError(f"{where} needs a video")
        body = _set(params)
        prompt = prompt_of(inputs)
        if prompt is not None:
            body["prompt"] = prompt
        body[field] = source
        return body, {field}
    refuse_unwired(inputs, {"prompt", "images", "start_image", "keyframes", "end_image", "start_video"}, where)
    body = _set(params)
    prompt = prompt_of(inputs)
    if prompt is None:
        raise ValueError(f"{where} needs a prompt")
    body["prompt"] = prompt
    images = [*port_values(inputs, "images"), *video_frames(inputs, where)]
    start_video = one_value(inputs, "start_video", where)
    if start_video is not None and images:
        raise ValueError(f"{where} continues a video or uses images, not both. Disconnect one.")
    if images:
        body["images"] = images
    if start_video is not None:
        body["start_video"] = start_video
    return body, {"images", "start_video"} & set(body)


async def run_replicate_model(node: GraphNode, inputs: dict[str, PortValueDict], api_keys: dict[str, str], *,
                              route: Mapping[str, Any], emit: Any = None, endpoint: Any = None) -> dict[str, Any]:
    from handlers import replicate_model

    definition = _definition(node)
    _, data_type = output_port(definition)
    model = str(endpoint if endpoint is not None else route.get("endpoint") or "")
    body, media = replicate_input(node.params, inputs, f"Replicate's {model}", model)
    path = await replicate_model.run_model(model, body, replicate_model.api_key(api_keys), media_type=data_type,
                                           media_fields=media, node_id=node.id, emit=emit)
    return as_output(definition, path)


# -- OpenRouter images and videos (handlers/openrouter_media.py) ---------------
# /images input_references take "base64 data URLs or HTTP(S) URLs" (OpenAPI
# ImageGenerationRequest). /videos frame_images say nothing about data URLs:
# openrouter.ai/docs/features/multimodal/video-generation.md and
# openrouter.ai/openapi.json FrameImage (both read 2026-10-15) only show
# https URLs. So a video frame goes only as a public http(s) URL.


def public_frame_url(value: Any, where: str) -> str:
    """A video frame as OpenRouter is documented to take it: an http(s) URL.
    A local output or a data: URI stops before any request."""
    from services.output import local_media_ref

    ref = local_media_ref(str(value))
    if not ref.startswith(("http://", "https://")):
        raise ValueError(f"{where} takes frame images only as public http(s) URLs, not a Nebula output or an "
                         "inline image. Choose another provider for it, or wire an image from a public URL.")
    return ref


async def run_openrouter_images(node: GraphNode, inputs: dict[str, PortValueDict], api_keys: dict[str, str], *,
                                route: Mapping[str, Any], emit: Any = None, endpoint: Any = None) -> dict[str, Any]:
    from handlers import openrouter_media as media

    definition = _definition(node)
    model = str(endpoint if endpoint is not None else route.get("endpoint") or "")
    where = f"OpenRouter's {model}"
    refuse_unwired(inputs, {"prompt", "images"}, where)
    prompt = prompt_of(inputs)
    if prompt is None:
        raise ValueError(f"{where} needs a prompt")
    body = media.request_body(model, prompt, dict(node.params), media.IMAGE_FIELDS)
    references = [media.image_url(media_url(v)) for v in port_values(inputs, "images")]
    if references:
        body["input_references"] = references
    path = await media.generate_image(media.api_key(api_keys), body)
    return as_output(definition, path)


async def run_openrouter_videos(node: GraphNode, inputs: dict[str, PortValueDict], api_keys: dict[str, str], *,
                                route: Mapping[str, Any], emit: Any = None, endpoint: Any = None) -> dict[str, Any]:
    from handlers import openrouter_media as media

    definition = _definition(node)
    model = str(endpoint if endpoint is not None else route.get("endpoint") or "")
    where = f"OpenRouter's {model}"
    # frame_images takes only a first and a last frame; a source video has no
    # documented request shape (handlers/openrouter_media.py).
    refuse_unwired(inputs, {"prompt", "start_image", "end_image"}, where)
    refuse_end_alone(inputs, where)
    prompt = prompt_of(inputs)
    if prompt is None:
        raise ValueError(f"{where} needs a prompt")
    body = media.request_body(model, prompt, dict(node.params), media.VIDEO_FIELDS)
    frames = []
    for port, frame_type in (("start_image", "first_frame"), ("end_image", "last_frame")):
        value = one_value(inputs, port, where)
        if value is not None:
            frames.append({**media.image_url(public_frame_url(value, where)), "frame_type": frame_type})
    if frames:
        body["frame_images"] = frames
    path = await media.generate_video(media.api_key(api_keys), body, node_id=node.id, emit=emit)
    return as_output(definition, path)


# -- Krea catalog (handlers/krea_gateway.py) -----------------------------------


def krea_inputs(model: Mapping[str, Any], inputs: Mapping[str, Any]) -> dict[str, Any]:
    """The wired ports under the catalog model's request fields. A catalog
    entry folded into a route-table node (scripts/sync-krea-catalog.py
    FOLDED) names the fields whose port has another id in ``portFields``
    (Krea 3's ``images`` -> ``image_urls``, FLUX Video Upscale's ``video``
    -> ``video_url``; the script's --check ties each to the request schema).
    Every other port goes by name; a name the schema lacks stops the run
    (krea_gateway._request_body)."""
    fields = model.get("portFields") if isinstance(model.get("portFields"), Mapping) else {}
    return {str(fields.get(port, port)): value for port, value in inputs.items()}


async def run_krea(node: GraphNode, inputs: dict[str, PortValueDict], api_keys: dict[str, str], *,
                   route: Mapping[str, Any], emit: Any = None, endpoint: Any = None) -> dict[str, Any]:
    """Krea's catalog models name their request fields after their ports
    (the gateway checks each body against the catalog's request schema), so
    the wired ports go through by name, or by the folded entry's
    ``portFields`` (krea_inputs). ``_kreaAuth`` is the router's."""
    from handlers.krea_gateway import catalog_key_for, catalog_models, handle_krea_catalog

    definition = _definition(node)
    key = catalog_key_for(endpoint if endpoint is not None else route.get("endpoint"))
    if output_port(definition)[1] == "Video":
        # Krea's catalog schema leaves end_image optional on its own.
        refuse_end_alone(inputs, f"Krea's {key}")
    result = await handle_krea_catalog(key, node, krea_inputs(catalog_models()[key], inputs), api_keys, emit=emit)
    return rekey(definition, result, "Krea")


# handler name (node_route.ROUTE_HANDLERS) -> client.
ROUTE_CLIENTS: dict[str, RouteClient] = {
    "bfl": RouteClient(run_bfl),
    "fal": RouteClient(run_fal),
    "replicate-model": RouteClient(run_replicate_model),
    "openrouter-images": RouteClient(run_openrouter_images),
    "openrouter-videos": RouteClient(run_openrouter_videos),
    "krea": RouteClient(run_krea),
}


def clients_for(definition: Mapping[str, Any], emit: Any = None) -> dict[str, Callable[
        ..., Awaitable[dict[str, Any]]]]:
    """Route id -> a registry-shaped handler for each route whose client exists."""
    from services import node_route

    clients = {}
    for route in node_route.routes_of(definition):
        client = ROUTE_CLIENTS.get(str(route.get("handler") or ""))
        if client is not None:
            clients[str(route["id"])] = partial(client.run, route=route, emit=emit)
    return clients


def register_route_nodes(registry: dict[str, Any], definitions: Mapping[str, Mapping[str, Any]], emit: Any = None) -> None:
    """A ``multi_route`` handler for every route-table node in ``definitions``
    (execution/sync_runner.py get_handler_registry calls it). It replaces any
    handler registered for that id, so one rule picks the provider."""
    from execution import maker_routes
    from services import node_route

    for node_id, definition in definitions.items():
        if node_route.has_routes(definition):
            registry[node_id] = maker_routes.multi_route(clients_for(definition, emit))
