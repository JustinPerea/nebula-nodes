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
from execution.person_line import missing_file_line, with_api_status, with_person_line

RouteRun = Callable[..., Awaitable[dict[str, Any]]]


class RouteClient(NamedTuple):
    """``run(node, inputs, api_keys, *, route, emit, endpoint)`` makes the call."""
    run: RouteRun


# -- Shared structure ----------------------------------------------------------

class Where(str):
    """Who refuses a run, twice over: the text (``Replicate's
    black-forest-labs/flux-3``) names the provider's model or endpoint id
    for agents, MCP and the run record, and ``person`` (``FLUX 3 Video on
    Replicate``) is how the card's line names it, by the node's name on its
    provider (execution/person_line.py: no ids on the card)."""

    person: str

    def __new__(cls, text: str, person: str) -> "Where":
        where = super().__new__(cls, text)
        where.person = person
        return where


def _person(where: str) -> str:
    """``where`` as the card names it; a plain string may carry an id, so the
    card says "This node" for it."""
    return where.person if isinstance(where, Where) else "This node"


def refuse(where: str, text: str, person: str | None = None) -> ValueError:
    """A run refused before any request: ``{where} {text}`` for agents, and
    ``{where.person} {person or text}`` on the card. ``person`` is the tail
    in words when ``text`` names a field key or a value."""
    return with_person_line(ValueError(f"{where} {text}"), f"{_person(where)} {person or text}")


def refuse_needs(where: str, what: str, *, longer: bool = False) -> ValueError:
    """A run stopped before any request because a required input isn't
    connected (GM r118): agents read ``{where} needs {what}``; the card says
    "Nebula couldn\u2019t run \u201cX\u201d because it needs {what}. Connect
    one, then run it again." with the node's own name, never the provider's."""
    node = _person(where).rpartition(" on ")[0] or _person(where)
    named = "this node" if node == "This node" else f"\u201c{node}\u201d"
    if longer:
        line = f"Nebula couldn\u2019t run {named} because it needs {what}. Use a longer audio track, then run it again."
    else:
        line = f"Nebula couldn\u2019t run {named} because it needs {what}. Connect one, then run it again."
    return with_person_line(ValueError(f"{where} needs {what}"), line)


def where_for(node: GraphNode, route: Mapping[str, Any], text: str) -> Where:
    """``text`` for agents, and the node's name on the route's provider."""
    from services import node_route

    return Where(text, f"{_node_name(_definition(node))} on {node_route.provider_label(route.get('provider'))}")

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
        raise refuse(where, f"takes one {port}, but {len(values)} are connected",
                     f"takes one {port.replace('_', ' ')}, but {len(values)} are connected. Disconnect the extra ones.")
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
        raise refuse(where, f"can't take the connected {', '.join(extra)}. Disconnect it or choose another provider.",
                     f"can't take the connected {', '.join(port.replace('_', ' ') for port in extra)}. "
                     "Disconnect it or choose another provider.")


def refuse_end_alone(inputs: Mapping[str, Any], where: str) -> None:
    """A video node's end image needs a start image or keyframes before it,
    or the provider would open the clip on the frame meant to close it. Every
    video client checks this before its first request, so the recipe stops
    the same way on every route (and none bills it)."""
    if port_values(inputs, "end_image") and not (port_values(inputs, "start_image") or port_values(inputs, "keyframes")):
        raise refuse(where, "needs a start image (or keyframes) to end on an end image",
                     "needs a start image or keyframes to end on an end image.")


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
        raise refuse(where, f"takes at most {VIDEO_MAX_FRAMES} images in all (start image, keyframes and end "
                     f"image), but {len(frames)} are connected. Disconnect {len(frames) - VIDEO_MAX_FRAMES}.",
                     f"takes at most {VIDEO_MAX_FRAMES} images in all, counting the start image, keyframes and "
                     f"end image, but {len(frames)} are connected. Disconnect {len(frames) - VIDEO_MAX_FRAMES}.")
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
        raise with_person_line(
            ValueError(f"A connected input isn't a readable file: {Path(ref).name}"),
            missing_file_line("file", ref))
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


def _node_name(definition: Mapping[str, Any]) -> str:
    return str(definition.get("displayName") or "This node")


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
# FLUX.2 (PR 4), from the same OpenAPI, read 2026-10-15: /v1/flux-2-pro and
# /v1/flux-2-max take Flux2Inputs, /v1/flux-2-flex Flux2FlexInputs (plus
# ``steps`` 1-50 and ``guidance`` 1.5-10), /v1/flux-2-klein-9b and
# /v1/flux-2-klein-4b Flux2KleinInputs. None takes an aspect ratio or a size
# preset: the size is ``width`` and ``height`` ("integer, minimum 64"), so
# the route's valueMap turns fal's ``image_size`` preset into
# {width, height} and the body spreads it. ``model`` only picks the path
# (endpointWhen) and isn't a field. References would be input_image ..
# input_image_8 (Klein: 4); the node has no image port, so none are sent.
# These schemas aren't additionalProperties false; the pinned copies are
# checked with unknown fields refused anyway.
BFL_FLUX2_PATHS = frozenset({"flux-2-pro", "flux-2-max", "flux-2-flex", "flux-2-klein-9b", "flux-2-klein-4b"})
BFL_FLUX2_SWITCHES = frozenset({"model"})
# Flux2FlexInputs is the only FLUX.2 body with ``steps`` and ``guidance``.
# The node shows them on Flex only (visibleWhen), so on any other path a
# value saved under Flex is hidden, and the router never sends a hidden
# setting (maker_routes.multi_route, node_route.route_sent_keys).
BFL_VIDEO_PATH = "flux-3-video"
BFL_VIDEO_EDIT_PATH = "flux-tools/video-edit-v1"
BFL_VIDEO_UPSCALE_PATH = "flux-tools/video-upscale-v1"


def bfl_path(endpoint: Any) -> str:
    """``/v1/flux-3-image`` -> ``flux-3-image`` (bfl.submit adds the base)."""
    path = str(endpoint or "").strip("/")
    return path[len("v1/"):] if path.startswith("v1/") else path


def bfl_body(path: str, params: Mapping[str, Any], inputs: Mapping[str, Any],
             node_name: str = "This node") -> dict[str, Any]:
    where = Where(f"Black Forest Labs' {path}", f"{node_name} on Black Forest Labs")
    body = _set(params)
    prompt = prompt_of(inputs)
    if path in BFL_IMAGE_PATHS:
        refuse_unwired(inputs, {"prompt", "images"}, where)
        images = [media_url(v) for v in port_values(inputs, "images")]
        if images:
            body["images"] = images
    elif path in BFL_FLUX2_PATHS:
        refuse_unwired(inputs, {"prompt"}, where)
        for key in BFL_FLUX2_SWITCHES:
            body.pop(key, None)
        size = body.pop("image_size", None)
        if size is not None:
            if not isinstance(size, Mapping) or set(size) != {"width", "height"}:
                raise refuse(where, f"takes a size as width and height, not {size!r}",
                             "can't use the saved size. Pick one in “Size”, then run it again.")
            body.update(width=size["width"], height=size["height"])
    elif path == BFL_VIDEO_PATH:
        refuse_unwired(inputs, {"prompt", "start_image", "keyframes", "end_image", "start_video"}, where)
        start_video = one_value(inputs, "start_video", where)
        frames = video_frames(inputs, where)
        if start_video is not None and frames:
            raise refuse(where, "continues a video or animates images, not both. Disconnect one.")
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
            raise refuse(where, "needs a video to edit", "needs a video to edit. Connect one, then run the node again.")
        body["video"] = media_url(source)
    elif path == BFL_VIDEO_UPSCALE_PATH:
        refuse_unwired(inputs, {"prompt", "video", "start_video"}, where)
        source = one_value(inputs, "video", where) or one_value(inputs, "start_video", where)
        if source is None:
            raise refuse(where, "needs a video to upscale", "needs a video to upscale. Connect one, then run the node again.")
        body["input_video"] = media_url(source)
    else:
        raise ValueError(f"Nebula has no request shape for Black Forest Labs' {path or '(no path)'} yet")
    if prompt is not None:
        body["prompt"] = prompt
    elif path != BFL_VIDEO_UPSCALE_PATH:
        raise refuse(where, "needs a prompt", "needs a prompt. Connect one, then run the node again.")
    return body


def flux2_default_size(definition: Mapping[str, Any], route: Mapping[str, Any]) -> Any:
    """FLUX.2's size when the node has none saved: its ``image_size``
    default through the route's valueMap. BFL documents no FLUX.2 default
    size (width and height "default 0"), so the run takes the size its price
    is read at (model_pricing reads the default too), as fal does by its own
    default (landscape_4_3)."""
    from services import node_route

    param = node_route.param_definition(definition, "image_size") or {}
    sizes = (route.get("valueMap") or {}).get("image_size") or {}
    return sizes.get(str(param.get("default")))


async def run_bfl(node: GraphNode, inputs: dict[str, PortValueDict], api_keys: dict[str, str], *,
                  route: Mapping[str, Any], emit: Any = None, endpoint: Any = None) -> dict[str, Any]:
    from handlers import bfl

    definition = _definition(node)
    _, data_type = output_port(definition)
    path = bfl_path(endpoint if endpoint is not None else route.get("endpoint"))
    params = node.params
    if path in BFL_FLUX2_PATHS and "image_size" not in _set(params):
        params = {**params, "image_size": flux2_default_size(definition, route)}
    body = bfl_body(path, params, inputs, _node_name(definition))
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
    # FLUX.2 (PR 4), text only: Flux2ProInput, Flux2MaxInput, Flux2FlashInput,
    # Flux2FlexInput, Flux2Klein9bInput and Flux2Klein4bInput (read
    # 2026-10-15). Keyed by whole id: "flash", "9b" and "4b" say nothing.
    "fal-ai/flux-2-pro": {},
    "fal-ai/flux-2-max": {},
    "fal-ai/flux-2/flash": {},
    "fal-ai/flux-2-flex": {},
    "fal-ai/flux-2/klein/9b": {},
    "fal-ai/flux-2/klein/4b": {},
    # Talking heads (read 2026-11-04 from fal's per-endpoint queue OpenAPI):
    # BytedanceOmnihumanV15Input, BytedanceOmnihumanV2Input and
    # KlingVideoAiAvatarV2{Standard,Pro}Input all take ``image_url`` and
    # ``audio_url`` (both required) and an optional ``prompt``. Keyed by
    # whole id: the last segments ("v1.5", "v2", "standard", "pro") say
    # nothing about the shape.
    "fal-ai/bytedance/omnihuman/v1.5": {"image": ("image_url", False), "audio": ("audio_url", False)},
    "fal-ai/bytedance/omnihuman/v2": {"image": ("image_url", False), "audio": ("audio_url", False)},
    "fal-ai/kling-video/ai-avatar/v2/standard": {"image": ("image_url", False), "audio": ("audio_url", False)},
    "fal-ai/kling-video/ai-avatar/v2/pro": {"image": ("image_url", False), "audio": ("audio_url", False)},
}
FAL_KEYFRAMES = "keyframes-to-video"
# A route param that picks the endpoint (endpointWhen) and isn't a request
# field: FLUX 3 Video's ``draft`` chooses fal's /draft endpoint, and none of
# fal's FLUX 3 video schemas has a draft field.
FAL_ENDPOINT_SWITCHES = frozenset({"draft"})
# Params that aren't request fields on one endpoint, by endpoint id. FLUX.2's
# ``model`` only picks the endpoint (endpointWhen), as the fal-only handler
# before PR 4 dropped it (sync_runner _fal_wrapper_node internal_params):
# that's a switch, not a hidden setting. Settings an endpoint doesn't have
# are hidden on the route instead (``paramVisibleWhen``: Safety only on Pro,
# Max and Flex, as Flux2FlashInput, Flux2Klein9bInput and Flux2Klein4bInput
# have no safety_tolerance; FLUX 3 Video's resolution only off Draft, as
# fal's /draft endpoints have none), and the router never sends a hidden
# setting (node_route.route_sent_keys). Flex-only steps and guidance are
# hidden by their own visibleWhen the same way.
_FLUX2_SWITCHES = frozenset({"model"})
FAL_ENDPOINT_DROPS: dict[str, frozenset[str]] = {
    "fal-ai/flux-2-pro": _FLUX2_SWITCHES,
    "fal-ai/flux-2-max": _FLUX2_SWITCHES,
    "fal-ai/flux-2/flash": _FLUX2_SWITCHES,
    "fal-ai/flux-2-flex": _FLUX2_SWITCHES,
    "fal-ai/flux-2/klein/9b": _FLUX2_SWITCHES,
    "fal-ai/flux-2/klein/4b": _FLUX2_SWITCHES,
    # Kling AI Avatar v2: ``mode`` (std or pro) picks fal's endpoint; neither
    # schema has a mode field (Replicate's does, and gets it).
    "fal-ai/kling-video/ai-avatar/v2/standard": frozenset({"mode"}),
    "fal-ai/kling-video/ai-avatar/v2/pro": frozenset({"mode"}),
}


def fal_shape(endpoint: str) -> str:
    segments = [s for s in str(endpoint).strip("/").split("/") if s]
    if segments and segments[-1] == "draft":
        segments = segments[:-1]
    whole = "/".join(segments)
    if whole in _FAL_FIELDS:
        return whole
    return segments[-1] if segments else ""


def keyframe_indexes(count: int, duration: int) -> list[int]:
    """``count`` frames spread evenly over a ``duration``-second clip at 24
    fps, first on frame 0 and last on the final one (BFL's own spacing for
    plain images: "the rest fall evenly in between")."""
    last = duration * FAL_FPS
    if count == 1:
        return [0]
    return [round(i * last / (count - 1)) for i in range(count)]


_FAL_AUDIO_DRIVEN = frozenset({"fal-ai/bytedance/omnihuman/v1.5", "fal-ai/bytedance/omnihuman/v2",
                               "fal-ai/kling-video/ai-avatar/v2/standard", "fal-ai/kling-video/ai-avatar/v2/pro"})


# A local file goes to fal as one base64 data URI held in memory (media_url),
# so a talking head's image and audio are checked before they are read. fal's
# own page for OmniHuman 2.0 gives the limits (read 2026-11-04): image "Max
# size: 30 MB", audio "Max size: 15 MB". The other three pages publish none,
# so they get a fixed cap that keeps the request a sane size.
FAL_DATA_URI_MAX_BYTES = 20 * 1024 * 1024
FAL_MEDIA_MAX_BYTES: dict[tuple[str, str], int] = {
    ("fal-ai/bytedance/omnihuman/v2", "image"): 30 * 1024 * 1024,
    ("fal-ai/bytedance/omnihuman/v2", "audio"): 15 * 1024 * 1024,
}


def _megabytes(size: int) -> str:
    return f"{size / (1024 * 1024):.1f}".removesuffix(".0")


def _data_uri_bytes(value: Any) -> int:
    """The decoded size of a base64 data: URI (0 for anything else), from its
    length alone, so a large one is refused before it is decoded."""
    if not isinstance(value, str) or not value.startswith("data:"):
        return 0
    head, _, body = value.partition(",")
    return len(body) * 3 // 4 if head.endswith(";base64") else len(body)


def _split_data_uri(value: str) -> tuple[bytes, str] | None:
    """(bytes, mime) of a base64 data: URI; None when it isn't one or can't be decoded."""
    head, sep, body = value.partition(",")
    if not sep or not head.startswith("data:") or not head.endswith(";base64"):
        return None
    try:
        data = base64.b64decode(body, validate=True)
    except ValueError:
        return None
    return data, (head[len("data:"):-len(";base64")].split(";")[0] or "application/octet-stream")


def refuse_too_large(where: str, endpoint: str, port: str, values: list[Any]) -> None:
    """Stop before reading a local file over the route's limit into memory."""
    limit = FAL_MEDIA_MAX_BYTES.get((endpoint, port), FAL_DATA_URI_MAX_BYTES)
    for value in values:
        path = local_media_path(value)
        size = path.stat().st_size if path is not None else _data_uri_bytes(value)
        if size > limit:
            what = "audio" if port == "audio" else port.replace("_", " ")
            node = _person(where).rpartition(" on ")[0] or _person(where)
            named = "this node" if node == "This node" else f"\u201c{node}\u201d"
            raise with_person_line(
                ValueError(f"{where} takes {what} up to {_megabytes(limit)} MB, and this file is {_megabytes(size)} MB"),
                f"Nebula couldn\u2019t run {named} because its {what} file is too large at {_megabytes(size)} MB, "
                f"and fal.ai takes up to {_megabytes(limit)} MB. Use a smaller file, then run it again.")


# fal's page for OmniHuman 2.0 gives the audio's length as "Duration between
# 4 and 300 seconds" and bills "Duration of audio input/video output" (read
# 2026-11-04): it says nothing of padding or billing a shorter clip, so a
# shorter one is refused here instead of priced.
FAL_MIN_AUDIO_SECONDS: dict[str, float] = {"fal-ai/bytedance/omnihuman/v2": 4.0}


def fal_fields(endpoint: str, params: Mapping[str, Any], inputs: Mapping[str, Any],
               node_name: str = "This node", *, upload: bool = False) -> dict[str, Any]:
    """The media fields for ``endpoint`` from the wired ports. A local file goes
    as a base64 data URI, except with ``upload`` on a talking-head endpoint:
    fal refuses data: URLs there (HTTP 422 "Failed to download the file", seen
    in a real run 2026-11-04), so the local path is kept for ``upload_local_media``
    to replace with the URL fal's storage gives it."""
    shape = fal_shape(endpoint)
    where = Where(f"fal.ai's {endpoint}", f"{node_name} on fal.ai")
    if shape == FAL_KEYFRAMES:
        refuse_unwired(inputs, {"prompt", "start_image", "keyframes", "end_image"}, where)
        frames = video_frames(inputs, where)
        if not frames:
            raise refuse(where, "needs at least one keyframe image", "needs at least one keyframe image. Connect one, then run the node again.")
        duration = params.get("duration", FAL_DEFAULT_KEYFRAME_DURATION)
        if isinstance(duration, bool) or not isinstance(duration, int):
            raise refuse(where, f"needs a set duration in seconds to place its keyframes (got {duration!r})",
                         "needs a number of seconds to place its keyframes. Set “Duration”, "
                         "then run it again.")
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
            both = [p.replace("_", " ") for p, (f, _many) in table.items() if f == field and port_values(inputs, p)]
            kind = "video" if "video" in field else "image" if "image" in field else "file"
            raise refuse(where, f"takes one source for {field}; disconnect one of the connected inputs",
                         f"takes one source {kind}, but the {' and the '.join(both)} are both connected. "
                         "Disconnect one.")
        if shape in _FAL_AUDIO_DRIVEN:
            refuse_too_large(where, shape, port, values)
        as_field = media_url
        if upload and shape in _FAL_AUDIO_DRIVEN:
            # a local file stays a path (media_url keeps a data: URI as it is); upload_local_media
            # sends both to fal's storage
            as_field = lambda v: str(v) if local_media_path(v) is not None else media_url(v)  # noqa: E731
        fields[field] = [as_field(v) for v in values] if many else as_field(one_value(inputs, port, where))
    # The talking heads need both media; fal would answer a missing one with a
    # raw 422, so stop here in the same words as the Replicate route.
    if shape in _FAL_AUDIO_DRIVEN:
        for field, what in (("image_url", "an image"), ("audio_url", "an audio track")):
            if field not in fields:
                raise refuse_needs(where, what)
    return fields


# fal's default budget (handle_fal_universal) is 300 polls x 2 s, 10 minutes.
# A FLUX 3 video takes "several minutes per generation" (BFL) and may wait in
# fal's queue first, so a video job gets 600 polls x 3 s, 30 minutes, between
# Replicate's 15 and BFL's 60. When it runs out, the job is cancelled upstream.
FAL_VIDEO_POLLS: tuple[int, float] = (600, 3.0)


# fal's storage, as fal's own client (fal-client 1.0.3, client.py
# `_upload_via_storage`, read 2026-11-04) uploads a file: POST
# https://rest.fal.ai/storage/upload/initiate?storage_type=gcs with the fal key,
# JSON {file_name, content_type}, answered with {upload_url, file_url}; then PUT
# the bytes to upload_url with the same Content-Type. file_url is what the model
# takes. fal's page "fal CDN" (fal.ai/docs/documentation/model-apis/fal-cdn)
# says a model's input is a URL and a data URI is "not recommended".
FAL_REST_URL = "https://rest.fal.ai"
FAL_UPLOAD_TIMEOUT = 300.0


async def upload_local_media(fields: dict[str, Any], api_key: str, where: Where) -> dict[str, Any]:
    """``fields`` with each local file path or base64 data: URI (see
    ``fal_fields(upload=True)``) replaced by the https URL of that file uploaded
    to fal's storage. Every input is checked before anything is uploaded, and a
    file is uploaded once."""
    from execution.missing_credential import MissingCredentialError

    sources: dict[str, tuple[Path | bytes, str, str, str]] = {}  # value -> (source, file name, mime, what)
    for field, value in fields.items():
        if not isinstance(value, str) or field not in ("image_url", "audio_url") or value in sources:
            continue
        what = "audio" if field == "audio_url" else "image"
        path = local_media_path(value)
        if path is not None:
            sources[value] = (path, path.name, mimetypes.guess_type(path.name)[0] or "application/octet-stream", what)
        elif value.startswith("data:"):
            inline = _split_data_uri(value)
            if inline is None:
                node = _person(where).rpartition(" on ")[0] or _person(where)
                named = "this node" if node == "This node" else f"\u201c{node}\u201d"
                raise with_person_line(
                    ValueError(f"{where} got an {what} data: URI that isn't base64"),
                    f"Nebula couldn\u2019t run {named} because its {what} file couldn\u2019t be read. "
                    "Connect it again, then run it again.")
            data, mime = inline
            sources[value] = (data, f"{what}{mimetypes.guess_extension(mime) or ''}", mime, what)
    if sources and not api_key:
        raise MissingCredentialError("FAL_KEY is required")
    uploaded = {value: await _upload_to_fal(source, name, mime, api_key, where, what)
                for value, (source, name, mime, what) in sources.items()}
    return {field: uploaded.get(value, value) if field in ("image_url", "audio_url") and isinstance(value, str)
            else value for field, value in fields.items()}


async def _upload_to_fal(source: Path | bytes, file_name: str, mime: str, api_key: str, where: Where,
                         what: str) -> str:
    import asyncio

    import httpx

    node = _person(where).rpartition(" on ")[0] or _person(where)
    named = "this node" if node == "This node" else f"\u201c{node}\u201d"
    cannot = f"{where} could not upload its {what} file to fal.ai's storage"
    try:
        data = source if isinstance(source, bytes) else await asyncio.to_thread(source.read_bytes)
        headers = {"Authorization": f"Key {api_key}", "Accept": "application/json", "Content-Type": "application/json"}
        async with httpx.AsyncClient(timeout=FAL_UPLOAD_TIMEOUT) as client:
            start = await client.post(f"{FAL_REST_URL}/storage/upload/initiate?storage_type=gcs", headers=headers,
                                      json={"file_name": file_name, "content_type": mime})
            if start.status_code not in (200, 201):
                raise with_person_line(
                    with_api_status(RuntimeError(f"{cannot}: HTTP {start.status_code}"), start.status_code),
                    f"Nebula couldn\u2019t run {named} because fal.ai wouldn\u2019t store its {what} file. "
                    "Check your fal.ai API key in Settings, then run it again.")
            try:
                info = start.json()
            except ValueError:
                info = {}
            upload_url, file_url = info.get("upload_url"), info.get("file_url")
            # Both https: the file's bytes go to upload_url, and the provider fetches file_url.
            if not (isinstance(upload_url, str) and upload_url.startswith("https://")
                    and isinstance(file_url, str) and file_url.startswith("https://")):
                raise with_person_line(
                    RuntimeError(f"{cannot}: no upload_url or file_url in the answer"),
                    f"Nebula couldn\u2019t run {named} because fal.ai wouldn\u2019t store its {what} file. Run it again.")
            put = await client.put(upload_url, content=data, headers={"Content-Type": mime})
            # 2xx only: httpx doesn't follow redirects, so a 3xx means nothing was stored
            if not 200 <= put.status_code < 300:
                raise with_person_line(
                    # no API status: a presigned storage upload, not fal's API with the person's key
                    RuntimeError(f"{cannot}: HTTP {put.status_code} on the upload"),
                    f"Nebula couldn\u2019t run {named} because fal.ai wouldn\u2019t store its {what} file. Run it again.")
            return file_url
    except (httpx.HTTPError, OSError) as exc:
        raise with_person_line(
            RuntimeError(f"{cannot}: the connection failed"),
            f"Nebula couldn\u2019t run {named} because fal.ai couldn\u2019t be reached to upload its {what} file. "
            "Check your connection, then run it again.") from exc


async def refuse_short_audio(endpoint: str, inputs: Mapping[str, Any], node_name: str) -> None:
    """Refuse audio under the endpoint's minimum before the request, when its
    length is known (a file in Nebula's output folder); one that can't be
    measured goes to fal, which checks it."""
    minimum = FAL_MIN_AUDIO_SECONDS.get(endpoint)
    if minimum is None:
        return
    import asyncio
    from services import input_sizes

    measured = await asyncio.to_thread(input_sizes.measure, one_value(inputs, "audio", Where("", "")), "Audio")
    seconds = (measured or {}).get("seconds")
    if isinstance(seconds, (int, float)) and seconds < minimum:
        raise refuse_needs(Where(f"fal.ai's {endpoint}", f"{node_name} on fal.ai"),
                           f"audio of at least {minimum:g} s", longer=True)


async def run_fal(node: GraphNode, inputs: dict[str, PortValueDict], api_keys: dict[str, str], *,
                  route: Mapping[str, Any], emit: Any = None, endpoint: Any = None) -> dict[str, Any]:
    """fal forwards every param it is given (handle_fal_universal), so the
    copy it gets holds only this route's translated params, the media fields
    and ``endpoint_id``: never ``_provider`` or another route's params, nor
    a param that only picks the endpoint (FAL_ENDPOINT_SWITCHES,
    FAL_ENDPOINT_DROPS). A setting the endpoint doesn't have is hidden on
    the route and never reaches here (node_route.route_sent_keys)."""
    from execution.sync_runner import _fal_wrapper_node
    from handlers.fal_universal import handle_fal_universal

    definition = _definition(node)
    endpoint_id = str(endpoint if endpoint is not None else route.get("endpoint") or "").strip("/")
    dropped = FAL_ENDPOINT_SWITCHES | FAL_ENDPOINT_DROPS.get(endpoint_id, frozenset())
    sent = {key: value for key, value in _set(node.params).items() if key not in dropped}
    fields = fal_fields(endpoint_id, node.params, inputs, _node_name(definition), upload=True)
    await refuse_short_audio(endpoint_id, inputs, _node_name(definition))
    if fal_shape(endpoint_id) in _FAL_AUDIO_DRIVEN:
        # The size cap above ran before any file was read; now each local file goes to fal's storage.
        fields = await upload_local_media(fields, api_keys.get("FAL_KEY", ""), Where(
            f"fal.ai's {endpoint_id}", f"{_node_name(definition)} on fal.ai"))
    params = {**sent, **fields}
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


# Talking-head models: a still ``image`` and an ``audio`` track, both
# required, and an optional ``prompt``; the output is the video's URL.
# bytedance/omni-human-1.5 (image, audio, prompt, fast_mode, seed) and
# kwaivgi/kling-avatar-v2 (image, audio, prompt, mode), from each model's
# Input schema (replicate.com/<model>/api/schema), read 2026-11-04.
REPLICATE_AUDIO_DRIVEN = frozenset({"bytedance/omni-human-1.5", "kwaivgi/kling-avatar-v2"})
# 600 polls at Replicate's 3 s interval (handlers/replicate_model.py POLL_INTERVAL): 30 minutes.
REPLICATE_AUDIO_DRIVEN_POLLS = 600


def replicate_input(params: Mapping[str, Any], inputs: Mapping[str, Any], where: str,
                    model: str = "") -> tuple[dict[str, Any], set[str]]:
    """The prediction input and which of its fields are media."""
    if model in REPLICATE_AUDIO_DRIVEN:
        refuse_unwired(inputs, {"prompt", "image", "audio"}, where)
        body = _set(params)
        prompt = prompt_of(inputs)
        if prompt is not None:
            body["prompt"] = prompt
        image = one_value(inputs, "image", where)
        if image is None:
            raise refuse_needs(where, "an image")
        audio = one_value(inputs, "audio", where)
        if audio is None:
            raise refuse_needs(where, "an audio track")
        body["image"], body["audio"] = image, audio
        return body, {"image", "audio"}
    if model in REPLICATE_SOURCE_VIDEO:
        field = REPLICATE_SOURCE_VIDEO[model]
        refuse_unwired(inputs, {"prompt", "video"}, where)
        source = one_value(inputs, "video", where)
        if source is None:
            raise refuse(where, "needs a video", "needs a video. Connect one, then run the node again.")
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
        raise refuse(where, "needs a prompt", "needs a prompt. Connect one, then run the node again.")
    body["prompt"] = prompt
    images = [*port_values(inputs, "images"), *video_frames(inputs, where)]
    start_video = one_value(inputs, "start_video", where)
    if start_video is not None and images:
        raise refuse(where, "continues a video or uses images, not both. Disconnect one.")
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
    body, media = replicate_input(node.params, inputs, where_for(node, route, f"Replicate's {model}"), model)
    # A talking head took 3.5 to 6.6 min on fal (Kling) and over 15 min (OmniHuman 2.0) in a real run
    # (2026-11-04); Replicate's default of 300 polls x 3 s is 15 min, so these models get 30 min.
    budget = {"max_polls": REPLICATE_AUDIO_DRIVEN_POLLS} if model in REPLICATE_AUDIO_DRIVEN else {}
    path = await replicate_model.run_model(model, body, replicate_model.api_key(api_keys), media_type=data_type,
                                           media_fields=media, node_id=node.id, emit=emit, **budget)
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
        raise refuse(where, "takes frame images only as public http(s) URLs, not a Nebula output or an "
                     "inline image. Choose another provider for it, or connect an image from a public URL.",
                     "takes frame images only from a public web address, not a Nebula output or an inline image. "
                     "Choose another provider, or connect an image from a public web address.")
    return ref


async def run_openrouter_images(node: GraphNode, inputs: dict[str, PortValueDict], api_keys: dict[str, str], *,
                                route: Mapping[str, Any], emit: Any = None, endpoint: Any = None) -> dict[str, Any]:
    from handlers import openrouter_media as media

    definition = _definition(node)
    model = str(endpoint if endpoint is not None else route.get("endpoint") or "")
    where = where_for(node, route, f"OpenRouter's {model}")
    refuse_unwired(inputs, {"prompt", "images"}, where)
    prompt = prompt_of(inputs)
    if prompt is None:
        raise refuse(where, "needs a prompt", "needs a prompt. Connect one, then run the node again.")
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
    where = where_for(node, route, f"OpenRouter's {model}")
    # frame_images takes only a first and a last frame; a source video has no
    # documented request shape (handlers/openrouter_media.py).
    refuse_unwired(inputs, {"prompt", "start_image", "end_image"}, where)
    refuse_end_alone(inputs, where)
    prompt = prompt_of(inputs)
    if prompt is None:
        raise refuse(where, "needs a prompt", "needs a prompt. Connect one, then run the node again.")
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
        refuse_end_alone(inputs, where_for(node, route, f"Krea's {key}"))
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
