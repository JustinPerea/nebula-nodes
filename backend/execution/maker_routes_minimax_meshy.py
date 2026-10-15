"""Krea's MiniMax and Meshy copies on the makers' own APIs (MINIMAX_API_KEY, MESHY_API_KEY).

Registered in execution/maker_routes.py ``KREA_TRANSLATIONS``; the generated
node names its translation and maker model in ``directRoute``
(scripts/sync-krea-catalog.py ``MINIMAX_MESHY_ROUTES``). Route choice,
param filtering and the never-mutate rule are maker_routes.dual_route's; this
module only translates Krea's request fields into the maker handler's and
puts the result in the Krea node's ports.

Read 2026-10-14 from the makers' own references:

- MiniMax V1, POST /v1/video_generation (platform.minimax.io/docs/api-reference/
  video-generation-{t2v,i2v,fl2v}.md): T2V models "MiniMax-Hailuo-2.3,
  MiniMax-Hailuo-02, T2V-01-Director, T2V-01" (no 2.3 Fast); I2V adds
  "MiniMax-Hailuo-2.3-Fast"; first & last frame is "`MiniMax-Hailuo-02`" only
  and "does not support 512P". Durations "`6` or `10`" at 768P, "`6`" at
  1080P; 512P is Hailuo 02 image-to-video only. ``prompt_optimizer``
  "Defaults to `true`".
- MiniMax V2 (H3): see handlers/minimax_v2.py.
- Meshy (docs.meshy.ai/openapi.yaml): ai_model "`meshy-7` is deprecated,
  superseded by `meshy-7.1` (same parameters, same cost)", and "`meshy-7`,
  `meshy-7.1`, and `meshy-t2` require account entitlement"; the changelog says
  "`meshy-7` is deprecated but keeps working unchanged". Text to 3D is a
  preview (geometry, 20 credits) then a refine (texture, 10 credits);
  ``should_texture`` on text-to-3D is "Not generally available yet". Image to 3D
  takes one ``image_url``; Multi-Image to 3D "1-4 images of the same object".
  Only Text to 3D documents a ``seed``.
"""
from __future__ import annotations

import json
from typing import Any, Awaitable, Callable

from models.graph import GraphNode, PortValueDict

Handler = Callable[..., Awaitable[dict[str, Any]]]
Translate = Callable[
    [GraphNode, dict[str, PortValueDict]], tuple[GraphNode, dict[str, PortValueDict]]
]

KREA_ONLY_HINT = ("To run it on Krea instead, choose the Krea account connection or remove the MiniMax key "
                  "in Settings.")
MESHY_KREA_HINT = ("To run it on Krea instead, choose the Krea account connection or remove the Meshy key "
                   "in Settings.")


def _values(inputs: dict[str, PortValueDict], params: dict[str, Any], key: str) -> list[Any]:
    """A field's values from its wired port, else its param (a JSON list param is parsed)."""
    port = inputs.get(key)
    if port is not None and port.value not in (None, "", []):
        value = port.value
    else:
        value = params.get(key)
        if isinstance(value, str):
            text = value.strip()
            if not text:
                return []
            if text.startswith("["):
                try:
                    value = json.loads(text)
                except ValueError as exc:
                    raise ValueError(f"{key} must be a JSON list of URLs") from exc
    if value in (None, "", []):
        return []
    return [item for item in (value if isinstance(value, list) else [value]) if item not in (None, "")]


def _one(inputs: dict[str, PortValueDict], params: dict[str, Any], key: str) -> str | None:
    values = _values(inputs, params, key)
    return str(values[0]) if values else None


def _text(value: str, type_: str = "Text") -> PortValueDict:
    return PortValueDict(type=type_, value=value)


def _whole(value: Any, name: str) -> int | None:
    """Krea sends numbers as floats; the makers take integers."""
    if value in (None, ""):
        return None
    if isinstance(value, bool) or not isinstance(value, (int, float)) or float(value) != int(value):
        raise ValueError(f"{name} must be a whole number (received {value!r})")
    return int(value)


# -- MiniMax Hailuo (V1) ---------------------------------------------------------

HAILUO_RESOLUTIONS = {"512p": "512P", "768p": "768P", "1080p": "1080P"}
FIRST_LAST_FRAME_MODELS = {"MiniMax-Hailuo-02"}
IMAGE_ONLY_MODELS = {"MiniMax-Hailuo-2.3-Fast"}


def krea_hailuo_to_minimax(model: str) -> Translate:
    """Krea Hailuo params -> handle_minimax_video's.

    prompt (port, else param) -> prompt; start_image -> first_frame_image;
    end_image -> last_frame_image (Hailuo 02 only); expand_prompt ->
    prompt_optimizer; resolution 512p/768p/1080p -> 512P/768P/1080P; duration
    -> 6 or 10. What route selection can see (duration, 1080p at 10 s, an end
    image on 2.3, saved or wired) keeps the run on Krea (directRoute.accepts /
    rejectsWhen / blockedBy); the rules that depend on whether a start image
    is wired (2.3 Fast, 512P) are refused here, before any call."""

    def translate(node: GraphNode, inputs: dict[str, PortValueDict]) -> tuple[GraphNode, dict[str, PortValueDict]]:
        params = node.params
        prompt = " ".join(str(v) for v in _values(inputs, params, "prompt")).strip()
        if not prompt:
            raise ValueError("Prompt input is required")
        first = _one(inputs, params, "start_image")
        last = _one(inputs, params, "end_image")
        resolution = HAILUO_RESOLUTIONS.get(str(params.get("resolution") or "768p"))
        if resolution is None:
            raise ValueError(f"MiniMax has no resolution {params.get('resolution')!r}")
        duration = _whole(params.get("duration", 6), "Duration")
        if duration not in (6, 10):
            raise ValueError(f"MiniMax makes 6 or 10 second clips (received {params.get('duration')!r}).")
        if resolution == "1080P" and duration != 6:
            raise ValueError("MiniMax makes 1080P clips at 6 seconds only.")
        if last and model not in FIRST_LAST_FRAME_MODELS:
            raise ValueError(f"MiniMax's first-and-last-frame mode is Hailuo 02 only, so {model} can't take an "
                             f"end image on your MiniMax key. Disconnect End image. {KREA_ONLY_HINT}")
        if model in IMAGE_ONLY_MODELS and not first:
            raise ValueError(f"{model} is image-to-video only on MiniMax's API. Connect a start image. "
                             f"{KREA_ONLY_HINT}")
        if resolution == "512P" and (not first or last):
            raise ValueError("MiniMax renders 512P only from a start image, without an end image. Connect a start "
                             f"image or pick 768p. {KREA_ONLY_HINT}")
        out: dict[str, Any] = {"model": model, "duration": duration, "resolution": resolution}
        if isinstance(params.get("expand_prompt"), bool):
            out["prompt_optimizer"] = params["expand_prompt"]
        routed = {"prompt": _text(prompt)}
        if first:
            routed["first_frame_image"] = _text(first, "Image")
        if last:
            routed["last_frame_image"] = _text(last, "Image")
        return node.model_copy(update={"params": out}), routed

    return translate


def _krea_ports(media_type: str, result: dict[str, Any]) -> dict[str, Any]:
    """A maker result in a Krea node's ports (no Krea job on this route)."""
    from services.output import portable_output_ref

    key = media_type.lower()
    ref = portable_output_ref(str(result[key]["value"]), require_file=True)
    plural = {"Video": "videos", "Mesh": "meshes"}[media_type]
    return {key: result[key], plural: {"type": "Array", "value": [ref]},
            "artifacts": {"type": "Array", "value": [{"type": media_type, "value": ref}]}}


async def krea_minimax_hailuo(node: GraphNode, inputs: dict[str, PortValueDict], api_keys: dict[str, str],
                              emit: Callable[..., Awaitable[None]] | None = None) -> dict[str, Any]:
    from handlers.minimax import handle_minimax_video

    return _krea_ports("Video", await handle_minimax_video(node, inputs, api_keys, emit=emit))


# -- MiniMax H3 (V2) -------------------------------------------------------------


def krea_h3_to_minimax(model: str) -> Translate:
    """Krea H3 params -> handle_minimax_video_v2's.

    prompt -> the text item; start_image / end_image -> first_frame /
    last_frame images; reference_images / _videos / _audios (ports, else the
    JSON params) -> reference items; aspect_ratio -> ratio; duration ->
    duration; resolution (the direct-only param; V2 requires it) -> resolution.
    reference_video_seconds has no V2 field: a recipe that sets it stays on
    Krea (directRoute.blockedBy)."""

    def translate(node: GraphNode, inputs: dict[str, PortValueDict]) -> tuple[GraphNode, dict[str, PortValueDict]]:
        params = node.params
        out = {"model": model, "resolution": str(params.get("resolution") or "2K"),
               "duration": _whole(params.get("duration", 5), "Duration") or 5,
               "ratio": str(params.get("aspect_ratio") or "16:9")}
        routed: dict[str, PortValueDict] = {}
        prompt = " ".join(str(v) for v in _values(inputs, params, "prompt")).strip()
        if prompt:
            routed["prompt"] = _text(prompt)
        for source, target, kind in (("start_image", "first_frame", "Image"), ("end_image", "last_frame", "Image"),
                                     ("reference_images", "reference_images", "Image"),
                                     ("reference_videos", "reference_videos", "Video"),
                                     ("reference_audios", "reference_audios", "Audio")):
            values = [str(value) for value in _values(inputs, params, source)]
            if values:
                routed[target] = PortValueDict(type=kind, value=values)
        return node.model_copy(update={"params": out}), routed

    return translate


async def krea_minimax_h3(node: GraphNode, inputs: dict[str, PortValueDict], api_keys: dict[str, str],
                          emit: Callable[..., Awaitable[None]] | None = None) -> dict[str, Any]:
    from handlers.minimax_v2 import handle_minimax_video_v2

    return _krea_ports("Video", await handle_minimax_video_v2(node, inputs, api_keys, emit=emit))


# -- Meshy 7 ---------------------------------------------------------------------

MESHY_MAX_IMAGES = 4
_MESHY_TASK = "_meshy_task"


def krea_meshy_to_meshy(model: str) -> Translate:
    """Krea Meshy params -> the Meshy handler for the run's input.

    input_mode text -> Text to 3D (prompt; seed; target_polycount; a refine
    with enable_pbr when generate_texture, else the preview alone). input_mode
    image -> Image to 3D for one image, Multi-Image to 3D for 2-4
    (should_texture = generate_texture, enable_pbr, target_polycount).
    ai_model is ``model`` ("meshy-7", the model this Krea node is named for;
    Meshy keeps it working at 7.1's price). Dropped on the image routes, which
    document no such field: seed, and prompt (what Krea does with a prompt in
    image mode isn't documented, so it isn't guessed into texture_prompt)."""

    def translate(node: GraphNode, inputs: dict[str, PortValueDict]) -> tuple[GraphNode, dict[str, PortValueDict]]:
        params = node.params
        mode = str(params.get("input_mode") or "image")
        texture = params.get("generate_texture", True) is not False
        out: dict[str, Any] = {"ai_model": model}
        polycount = _whole(params.get("target_polycount"), "Target polycount")
        if polycount is not None:
            out["target_polycount"] = polycount
        if isinstance(params.get("enable_pbr"), bool):
            out["enable_pbr"] = params["enable_pbr"]
        if mode == "text":
            prompt = " ".join(str(v) for v in _values(inputs, params, "prompt")).strip()
            if not prompt:
                raise ValueError("Meshy text-to-3D needs a prompt")
            seed = _whole(params.get("seed"), "Seed")
            if seed is not None:
                out["seed"] = seed
            out.update({_MESHY_TASK: "text", "mode": "full" if texture else "preview"})
            return node.model_copy(update={"params": out}), {"prompt": _text(prompt)}
        if mode != "image":
            raise ValueError(f"Unknown Meshy input mode {mode!r}")
        from services.output import resolve_output_ref

        # A saved graph's /api/outputs/... refs become local paths, which the Meshy handlers send as data
        # URIs (as the Krea route uploads them); Meshy can't fetch Nebula's served URLs.
        images = [resolve_output_ref(str(value)) for value in _values(inputs, params, "image_urls")]
        if not images:
            raise ValueError("Meshy image-to-3D needs an image. Connect one, or set Input mode to text.")
        if len(images) > MESHY_MAX_IMAGES:
            raise ValueError(f"Meshy's own API takes 1 to {MESHY_MAX_IMAGES} images of one object "
                             f"(got {len(images)}). {MESHY_KREA_HINT}")
        out["should_texture"] = texture
        if len(images) == 1:
            out[_MESHY_TASK] = "image"
            return node.model_copy(update={"params": out}), {"image": _text(images[0], "Image")}
        out[_MESHY_TASK] = "multi"
        return node.model_copy(update={"params": out}), {"images": PortValueDict(type="Image", value=images)}

    return translate


async def krea_meshy(node: GraphNode, inputs: dict[str, PortValueDict], api_keys: dict[str, str],
                     emit: Callable[..., Awaitable[None]] | None = None) -> dict[str, Any]:
    from handlers.meshy import (
        handle_meshy_image_to_3d, handle_meshy_multi_image_to_3d, handle_meshy_text_to_3d,
    )

    params = dict(node.params)
    task = params.pop(_MESHY_TASK, None)
    handler = {"text": handle_meshy_text_to_3d, "image": handle_meshy_image_to_3d,
               "multi": handle_meshy_multi_image_to_3d}.get(str(task))
    if handler is None:
        raise ValueError("Meshy route has no task")
    call = node.model_copy(update={"params": params})
    try:
        result = await handler(call, inputs, api_keys, emit=emit)
    except RuntimeError as exc:
        if any(f"submit failed ({code})" in str(exc) for code in (401, 402, 403)):
            raise RuntimeError(f"{exc}. Meshy documents that {params.get('ai_model')} \"require[s] account "
                               f"entitlement\" (https://docs.meshy.ai/openapi.yaml), and API access comes with "
                               f"Pro and above (https://www.meshy.ai/pricing). {MESHY_KREA_HINT}") from exc
        raise
    return _krea_ports("Mesh", result)


for _handler in (krea_minimax_hailuo, krea_minimax_h3, krea_meshy):
    _handler.takes_emit = True  # type: ignore[attr-defined]  # maker_routes.krea_router binds the run's emit

# Translation ids (sync-krea-catalog.py MINIMAX_MESHY_ROUTES): (direct handler, translator for a model).
TRANSLATIONS: dict[str, tuple[Handler, Callable[[str], Translate]]] = {
    "krea-minimax-hailuo": (krea_minimax_hailuo, krea_hailuo_to_minimax),
    "krea-minimax-h3": (krea_minimax_h3, krea_h3_to_minimax),
    "krea-meshy": (krea_meshy, krea_meshy_to_meshy),
}
