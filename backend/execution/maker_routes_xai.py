"""Grok Imagine's fal and Krea copies on xAI's own API (XAI_API_KEY).

Registered through execution/maker_routes.py (``dual_route`` for the fal
nodes in sync_runner.py, ``KREA_TRANSLATIONS`` for the generated Krea nodes),
so the route rule is the shared one (services/node_route.py): the Krea plan
when chosen, else the person's xAI key, else the fal or Krea copy.

Model ids (https://docs.x.ai/developers/models/<id>, checked 2026-10-14):
``grok-imagine-image`` ("Aliases: `grok-imagine-image-2026-03-02`"),
``grok-imagine-image-2.0``, ``grok-imagine-video`` and
``grok-imagine-video-1.5`` ("Aliases: `grok-imagine-video-1.5-preview`,
`grok-imagine-video-1.5-2026-05-30`").

fal's xai/grok-imagine-image(/edit) is xAI's 1.0 model: fal bills "$0.02 for
image output + $0.002 for image input" on the edit endpoint
(https://fal.ai/models/xai/grok-imagine-image/edit/llms.txt), exactly xAI's
grok-imagine-image rates on https://docs.x.ai/developers/pricing.

Each translator says what it drops. Request fields and limits are quoted in
handlers/xai_image.py and handlers/grok_video.py.
"""
from __future__ import annotations

import json
from typing import Any, Awaitable, Callable

from models.events import ExecutionEvent
from models.graph import GraphNode, PortValueDict

Emit = Callable[[ExecutionEvent], Awaitable[None]]
Translate = Callable[
    [GraphNode, dict[str, PortValueDict]], tuple[GraphNode, dict[str, PortValueDict]]
]

GROK_IMAGE_1 = "grok-imagine-image"
GROK_IMAGE_2 = "grok-imagine-image-2.0"
GROK_VIDEO = "grok-imagine-video"
GROK_VIDEO_15 = "grok-imagine-video-1.5"
# Krea's 1K/2K -> xAI's "1k" | "2k" (images REST reference).
_KREA_RESOLUTION = {"1K": "1k", "2K": "2k"}
# Krea's Grok 2.0 edit node takes 1 to 3 image_urls (its request schema and
# port maxConnections); xAI takes up to 5. The direct route keeps the node's
# own limit, which is also what its price assumes.
KREA_EDIT_MAX_IMAGES = 3
# Reference-to-video on grok-imagine-video: "Up to 7 images, 10 s, 720p"
# (https://docs.x.ai/developers/model-capabilities/video/overview).
GROK_VIDEO_MAX_REFERENCES = 7
GROK_VIDEO_R2V_MAX_SECONDS = 10
# Video extension: "Extension length (`duration`) | 2-10 seconds"
# (https://docs.x.ai/developers/model-capabilities/video/extension).
EXTENSION_SECONDS = (2, 10)


def _present(value: Any) -> bool:
    return value not in (None, "", [])


def _port_or_param(inputs: dict[str, PortValueDict], params: dict[str, Any], key: str) -> Any:
    port = inputs.get(key)
    if port is not None and _present(port.value):
        return port.value
    return params.get(key)


def _list(value: Any, field: str) -> list[Any]:
    """A port list, a single value, or a Krea JSON param (a JSON array string)."""
    if not _present(value):
        return []
    if isinstance(value, str):
        text = value.strip()
        if text.startswith("["):
            try:
                value = json.loads(text)
            except ValueError as exc:
                raise ValueError(f"{field} must be a JSON list of URLs") from exc
    values = value if isinstance(value, list) else [value]
    return [item for item in values if _present(item)]


def _prompt(inputs: dict[str, PortValueDict], params: dict[str, Any]) -> dict[str, PortValueDict]:
    value = _port_or_param(inputs, params, "prompt")
    return {"prompt": PortValueDict(type="Text", value=str(value))} if _present(value) else {}


# -- fal copies -> grok-imagine-image -------------------------------------------

def fal_grok_image_to_xai(node: GraphNode, inputs: dict[str, PortValueDict]) -> tuple[GraphNode, dict[str, PortValueDict]]:
    """fal's Grok Imagine (and Edit) params -> handle_xai_image's.

    num_images -> n (fal's node caps it at 4 / 10; xAI takes 1-10);
    aspect_ratio and resolution keep their values (fal's 1:1 ... 1:2 and
    1k/2k are all in xAI's enums). The edit node's ``images`` port reaches xAI
    as the edit's source images. Dropped: output_format (fal-only, falParams;
    xAI has no output-format field and returns JPEG unless the quality
    produces PNG)."""
    params = node.params
    out: dict[str, Any] = {"model": GROK_IMAGE_1, "n": params.get("num_images", 1)}
    for key in ("aspect_ratio", "resolution"):
        if _present(params.get(key)):
            out[key] = str(params[key])
    return node.model_copy(update={"params": out}), inputs


async def xai_image_for_fal(node: GraphNode, inputs: dict[str, PortValueDict], api_keys: dict[str, str]) -> dict[str, Any]:
    """The direct result in the fal node's one Image port (the first image,
    as on fal; every image xAI returns is saved)."""
    from handlers.xai_image import handle_xai_image

    result = await handle_xai_image(node, inputs, api_keys)
    return {"image": result["image"]}


# -- Krea copies -> grok-imagine-image-2.0 ---------------------------------------

def krea_grok_image_to_xai(model: str) -> Translate:
    """Krea's Grok Imagine 2.0 (and Edit) params -> handle_xai_image's.

    prompt (port, else param) -> prompt; quality low/medium -> quality;
    aspect_ratio -> aspect_ratio (all 13 of Krea's ratios are in xAI's enum);
    resolution 1K/2K -> "1k"/"2k"; image_urls (port, else the JSON param,
    1 to 3) -> the edit's source images. Krea's style_images (with a
    strength) have no xAI equivalent: they are Krea-only, and a run that sets
    or wires them stays on Krea (directRoute.blockedBy)."""

    def translate(node: GraphNode, inputs: dict[str, PortValueDict]) -> tuple[GraphNode, dict[str, PortValueDict]]:
        params = node.params
        if _present(_port_or_param(inputs, params, "style_images")):
            raise ValueError("Style images are a Krea feature; xAI's API has no style references")
        out: dict[str, Any] = {"model": model}
        if _present(params.get("quality")):
            out["quality"] = str(params["quality"])
        if _present(params.get("aspect_ratio")):
            out["aspect_ratio"] = str(params["aspect_ratio"])
        resolution = params.get("resolution")
        if _present(resolution):
            if resolution not in _KREA_RESOLUTION:
                raise ValueError(f"xAI takes resolution 1K or 2K (received {resolution!r})")
            out["resolution"] = _KREA_RESOLUTION[resolution]
        routed = _prompt(inputs, params)
        images = _list(_port_or_param(inputs, params, "image_urls"), "image_urls")
        if node.definition_id.endswith("-edit") and not images:
            raise ValueError("Grok Imagine 2.0 Edit needs at least one image in Image URLs")
        if len(images) > KREA_EDIT_MAX_IMAGES:
            raise ValueError(f"This node takes up to {KREA_EDIT_MAX_IMAGES} images (received {len(images)})")
        if images:
            routed["images"] = PortValueDict(type="Image", value=images)
        return node.model_copy(update={"params": out}), routed

    return translate


def _krea_outputs(port: str, media: str, value: str) -> dict[str, Any]:
    """A Krea node's output ports for one local file (no Krea job on this route)."""
    from services.output import portable_output_ref

    ref = portable_output_ref(value, require_file=True)
    return {
        port: {"type": media, "value": value},
        f"{port}s": {"type": "Array", "value": [ref]},
        "artifacts": {"type": "Array", "value": [{"type": media, "value": ref}]},
    }


async def krea_xai_image(node: GraphNode, inputs: dict[str, PortValueDict], api_keys: dict[str, str]) -> dict[str, Any]:
    from handlers.xai_image import handle_xai_image

    result = await handle_xai_image(node, inputs, api_keys)
    out = _krea_outputs("image", "Image", str(result["image"]["value"]))
    from services.output import portable_output_ref

    refs = [portable_output_ref(str(path), require_file=True) for path in result["images"]["value"]]
    out["images"] = {"type": "Array", "value": refs}
    out["artifacts"] = {"type": "Array", "value": [{"type": "Image", "value": ref} for ref in refs]}
    return out


# -- Krea copies -> grok-imagine-video / -1.5 -----------------------------------

def _effective(node: GraphNode, key: str) -> Any:
    """The saved value, else the Krea node's default (the price assumes it,
    and xAI's own defaults differ: 8 s and 480p)."""
    from execution.maker_routes import definition_for

    if _present(node.params.get(key)):
        return node.params[key]
    for group in ("sharedParams", "falParams", "params"):
        for param in definition_for(node.definition_id).get(group) or []:
            if param.get("key") == key:
                return param.get("default")
    return None


def _whole_seconds(value: Any) -> int:
    if isinstance(value, bool) or not isinstance(value, (int, float)) or float(value) != int(value):
        raise ValueError(f"xAI takes a whole number of seconds (received duration {value!r})")
    return int(value)


def krea_grok_video_to_xai(model: str) -> Translate:
    """Krea's Grok Imagine (and 1.5) params -> run_xai_video's.

    - edit_video -> POST /v1/videos/edits {video, prompt} (grok-imagine-video
      only; "Video editing does not support custom `duration`", nor
      resolution or aspect ratio, so those are not sent).
    - start_video -> POST /v1/videos/extensions {video, prompt, duration}
      (grok-imagine-video only: the 1.5 copy is blockedBy start_video and
      stays on Krea; "Model | `grok-imagine-video`" in the extension guide).
      duration is the added segment, 2-10 s.
    - otherwise POST /v1/videos/generations: prompt, duration (whole seconds,
      1-15), resolution, aspect_ratio, start_image -> image {url},
      reference_images -> reference_images [{url}] (up to 7, at most 10 s).
    - duration and resolution default to the Krea node's (6 s, 720p), not
      xAI's (8 s, 480p), so the run matches what the node shows and its price.
    - Combinations xAI doesn't document on one request (an edit or extension
      plus frames or references, a start image plus references) are refused
      rather than silently dropping one."""

    def translate(node: GraphNode, inputs: dict[str, PortValueDict]) -> tuple[GraphNode, dict[str, PortValueDict]]:
        params = node.params
        routed = _prompt(inputs, params)
        start_image = _port_or_param(inputs, params, "start_image")
        start_video = _port_or_param(inputs, params, "start_video")
        edit_video = _port_or_param(inputs, params, "edit_video")
        references = _list(_port_or_param(inputs, params, "reference_images"), "reference_images")
        frames = [name for name, value in (("start_image", start_image), ("start_video", start_video),
                                           ("edit_video", edit_video), ("reference_images", references))
                  if _present(value)]
        out: dict[str, Any] = {"model": model}
        if _present(edit_video) or _present(start_video):
            if model != GROK_VIDEO:
                raise ValueError(f"xAI edits and extends videos on {GROK_VIDEO} only, not {model}")
            if len(frames) > 1:
                raise ValueError(f"xAI takes {frames[0]} on its own; this run also sets {', '.join(frames[1:])}")
            if "prompt" not in routed:
                raise ValueError("xAI needs a prompt to edit or extend a video")
            if _present(edit_video):
                out["endpoint"] = "edits"
                routed["video"] = PortValueDict(type="Video", value=edit_video)
            else:
                seconds = _whole_seconds(_effective(node, "duration"))
                low, high = EXTENSION_SECONDS
                if not low <= seconds <= high:
                    raise ValueError(f"xAI extends a video by {low} to {high} seconds (received {seconds})")
                out.update(endpoint="extensions", duration=seconds)
                routed["video"] = PortValueDict(type="Video", value=start_video)
            return node.model_copy(update={"params": out}), routed

        if _present(start_image) and references:
            raise ValueError("xAI's grok-imagine-video takes a start image or reference images, not both")
        seconds = _whole_seconds(_effective(node, "duration"))
        if not 1 <= seconds <= 15:
            raise ValueError(f"xAI makes videos of 1 to 15 seconds (received {seconds})")
        out.update(endpoint="generations", duration=seconds)
        if references:
            if len(references) > GROK_VIDEO_MAX_REFERENCES:
                raise ValueError(f"{model} takes up to {GROK_VIDEO_MAX_REFERENCES} reference images "
                                 f"(received {len(references)})")
            if seconds > GROK_VIDEO_R2V_MAX_SECONDS:
                raise ValueError(f"Reference-to-video on {model} runs up to {GROK_VIDEO_R2V_MAX_SECONDS} seconds "
                                 f"(received {seconds})")
            routed["reference_images"] = PortValueDict(type="Image", value=references)
        if _present(start_image):
            routed["image"] = PortValueDict(type="Image", value=start_image)
        if "prompt" not in routed and "image" not in routed:
            raise ValueError("xAI needs a prompt unless a start image is set")
        for key in ("resolution", "aspect_ratio"):
            value = _effective(node, key)
            if _present(value):
                out[key] = str(value)
        return node.model_copy(update={"params": out}), routed

    return translate


async def krea_xai_video(
    node: GraphNode, inputs: dict[str, PortValueDict], api_keys: dict[str, str], emit: Emit | None = None,
) -> dict[str, Any]:
    """Build the xAI body from a translated copy, run it, and return the
    clip in the Krea node's ports."""
    from execution.missing_credential import MissingCredentialError
    from handlers.grok_video import run_xai_video
    from handlers.xai_image import xai_image_url, xai_video_url

    api_key = (api_keys.get("XAI_API_KEY") or "").strip()
    if not api_key:
        raise MissingCredentialError("XAI_API_KEY is required")
    params = dict(node.params)
    endpoint = params.pop("endpoint")
    body: dict[str, Any] = dict(params)
    prompt = inputs.get("prompt")
    if prompt is not None and _present(prompt.value):
        body["prompt"] = str(prompt.value)
    if "video" in inputs:
        body["video"] = {"url": xai_video_url(inputs["video"].value)}
    if "image" in inputs:
        body["image"] = {"url": xai_image_url(inputs["image"].value)}
    if "reference_images" in inputs:
        body["reference_images"] = [{"url": xai_image_url(value)} for value in inputs["reference_images"].value]
    path = await run_xai_video(node_id=node.id, api_key=api_key, endpoint=endpoint, body=body, emit=emit)
    return _krea_outputs("video", "Video", path)


krea_xai_video.takes_emit = True  # type: ignore[attr-defined]  # maker_routes.krea_router passes the run's emit
