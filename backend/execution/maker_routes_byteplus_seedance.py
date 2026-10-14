"""Seedance's fal and Krea copies on BytePlus ModelArk, with the person's own key.

The dual-route plumbing (route choice, per-route param filtering, never
mutating the node) is execution/maker_routes.py ``dual_route``; the HTTP
client, the task poller and BytePlus's error messages are handlers/byteplus.py.
This module holds what is Seedance's: which ModelArk model each copy calls,
the translations from the copies' params to a ModelArk video task, the
handlers, and the token-rate tables the prices in data/model_pricing.json are
computed from (tests/test_byteplus_seedance.py recomputes every row).

Which runs come here is decided by services/node_route.py ``select_route``:

- fal: ``seedance-2-t2v`` / ``-i2v`` / ``-r2v``, ``seedance-2-fast-t2v`` /
  ``-i2v``, ``seedance-v1-5`` (its 1.5 and 1.0 options) and
  ``seedance-1-0-t2v``, with BYTEPLUS_API_KEY set. On the 2.x nodes a saved
  ``seed`` keeps the run on fal (``directRoute.blockedBy``): BytePlus lists
  seed for Seedance 1.5 pro, 1.0 pro and 1.0 pro fast only.
- Krea: ``krea-video-bytedance-seedance-1-0-pro`` / ``-1-0-pro-fast`` /
  ``-2`` / ``-2-fast`` / ``-2-mini`` / ``-2-5``, unless the node bills the
  Krea plan or sets something only Krea takes (seed on 2.x, effects, a start
  video, reference images on 1.0 pro, upscale / prompt enhancer / draft
  switched on, the 9:21 ratio, a fractional duration: ``blockedBy`` and
  ``accepts`` from scripts/sync-krea-catalog.py DIRECT_ROUTES).

Facts from docs.byteplus.com/en/docs/ModelArk/create-video-generation-task-api
(read 2026-10-14), quoted where they decide a mapping:

- content[]: {type: text}, {type: image_url, role: first_frame | last_frame |
  reference_image}, {type: video_url, role: reference_video} ("Video URL or
  asset ID", no Base64), {type: audio_url, role: reference_audio} ("URL,
  Base64-encoded string or asset ID"). Images take "image URL, Base64-encoded
  image, or asset ID", as "data:image/<image format>;base64,<Base64 encoding>".
- "Image-to-video (first frame), image-to-video (first and last frames), and
  omni reference-to-video (including reference images, videos, and audio) are
  mutually exclusive scenarios and cannot be mixed." First and last frames:
  "Two image_url objects must be provided, and the role field is required";
  supported by 2.5, the 2.0 series, 1.5 pro and 1.0 pro (not 1.0 pro fast).
  Reference images: "Dreamina Seedance 2.5 (1-30 images) and Dreamina
  Seedance 2.0 series (1-9 images)".
- ratio: "16:9, 4:3, 1:1, 3:4, 9:16, 21:9, and adaptive"; Seedance 1.0
  text-to-video "Does not support adaptive"; Seedance 2.5 first-frame /
  first-and-last-frame "Defaults to and only supports adaptive".
- duration: 2.5 "[4, 30] or -1"; 2.0 series "[4, 15] or -1"; 1.5 pro "[4, 12]
  or -1"; 1.0 pro and pro fast "[2, 12]". -1: "The model selects an
  appropriate whole-second video length within the valid duration range."
- resolution: 2.5 480p/720p/1080p; 2.0 adds 4k; 2.0 fast and mini 480p/720p;
  1.5 pro 480p/720p/1080p; 1.0 pro and pro fast 480p/720p/1080p.
- generate_audio: 2.5, the 2.0 series and 1.5 pro. seed and camera_fixed:
  "Seedance 1.5 pro, Seedance 1.0 pro, Seedance 1.0 pro fast".
- watermark "Default value: false"; every request still sends false.
"""
from __future__ import annotations

import base64
import json
from typing import Any, Mapping
from urllib.parse import urlparse

from execution.byteplus_seedance_prices import (
    CHECKED, PRICING_URL, RATE_QUOTES, SIZES_QUOTE, SIZES_URL, TOKEN_FORMULA_QUOTE, video_price,
    DURATIONS, RATIOS, SEEDANCE_1_0_PRO, SEEDANCE_1_0_PRO_FAST, SEEDANCE_1_5_PRO, SEEDANCE_2_0, SEEDANCE_2_0_FAST,
    SEEDANCE_2_0_MINI, SEEDANCE_2_5,
)
from models.graph import GraphNode, PortValueDict

# The fal nodes -> their ModelArk model. seedance-v1-5 picks by its model param.
FAL_NODE_MODELS: dict[str, str] = {
    "seedance-2-t2v": SEEDANCE_2_0, "seedance-2-i2v": SEEDANCE_2_0, "seedance-2-r2v": SEEDANCE_2_0,
    "seedance-2-fast-t2v": SEEDANCE_2_0_FAST, "seedance-2-fast-i2v": SEEDANCE_2_0_FAST,
    "seedance-1-0-t2v": SEEDANCE_1_0_PRO,
}
FAL_V1_5_MODELS: dict[str, str] = {"1.5": SEEDANCE_1_5_PRO, "1.0": SEEDANCE_1_0_PRO}

_SERIES_2 = {SEEDANCE_2_5, SEEDANCE_2_0, SEEDANCE_2_0_FAST, SEEDANCE_2_0_MINI}
_SERIES_1 = {SEEDANCE_1_5_PRO, SEEDANCE_1_0_PRO, SEEDANCE_1_0_PRO_FAST}
_AUDIO_MODELS = _SERIES_2 | {SEEDANCE_1_5_PRO}
_LAST_FRAME_MODELS = _SERIES_2 | {SEEDANCE_1_5_PRO, SEEDANCE_1_0_PRO}
_REFERENCE_LIMITS = {SEEDANCE_2_5: (30, 10, 10), SEEDANCE_2_0: (9, 3, 3), SEEDANCE_2_0_FAST: (9, 3, 3),
                     SEEDANCE_2_0_MINI: (9, 3, 3)}  # (images, videos, audios)
RESOLUTIONS: dict[str, tuple[str, ...]] = {
    SEEDANCE_2_5: ("480p", "720p", "1080p"), SEEDANCE_2_0: ("480p", "720p", "1080p", "4k"),
    SEEDANCE_2_0_FAST: ("480p", "720p"), SEEDANCE_2_0_MINI: ("480p", "720p"),
    SEEDANCE_1_5_PRO: ("480p", "720p", "1080p"), SEEDANCE_1_0_PRO: ("480p", "720p", "1080p"),
    SEEDANCE_1_0_PRO_FAST: ("480p", "720p", "1080p"),
}
# -- prices for the fal copies --------------------------------------------------

def _options(definition: Mapping[str, Any], key: str) -> list[str]:
    for group in ("sharedParams", "falParams", "directParams", "params"):
        for param in definition.get(group) or []:
            if param.get("key") == key:
                return [str(o.get("value") if isinstance(o, Mapping) else o) for o in param.get("options") or []]
    return []


def fal_price_entry(definition: Mapping[str, Any]) -> dict[str, Any]:
    """The ``bytedance`` route entry in data/model_pricing.json for a fal Seedance
    node: one row per resolution and duration choice (and model, and audio on
    1.5 pro), each the price of one video from BytePlus's token formula. The
    price is the range over every documented ratio's size (a set ratio sits
    inside it; 'auto' lets the model pick), and a duration of 'auto' spans
    the model's shortest to longest video."""
    node_id = str(definition.get("id"))
    choices = ([(choice, model) for choice, model in FAL_V1_5_MODELS.items()] if node_id == "seedance-v1-5"
               else [(None, FAL_NODE_MODELS[node_id])])
    rows: list[dict[str, Any]] = []
    for choice, model in choices:
        for resolution in _options(definition, "resolution"):
            for duration in _options(definition, "duration"):
                match: dict[str, Any] = {"model": choice} if choice else {}
                match.update({"resolution": resolution, "duration": duration})
                if model == SEEDANCE_1_5_PRO:
                    for audio in (True, False):
                        rows.append({"match": {**match, "generate_audio": audio},
                                     "price": video_price(model, resolution, duration, audio=audio)})
                else:
                    rows.append({"match": match, "price": video_price(model, resolution, duration)})
    models = [model for _, model in choices]
    return {
        "currency": "usd", "per": "video",
        "priceParams": sorted({key for row in rows for key in row["match"]}),
        "rows": rows,
        "notes": ("BytePlus ModelArk online price for runs on the person's BYTEPLUS_API_KEY (" + ", ".join(models)
                  + "), from BytePlus's token estimate at 24 fps: width x height x 24 / 1024 tokens a second, "
                  "times the duration. Each price spans the documented output sizes for that resolution (a set "
                  "ratio sits inside it); a duration of auto spans the model's shortest to longest video. "
                  "BytePlus bills the usage.completion_tokens it reports, which can differ a little, and doesn't "
                  "bill failed runs."),
        "sources": [*({"url": PRICING_URL, "quote": RATE_QUOTES[model]} for model in models),
                    {"url": PRICING_URL, "quote": TOKEN_FORMULA_QUOTE},
                    {"url": SIZES_URL, "quote": SIZES_QUOTE}],
        "checked": CHECKED,
    }


# -- translation ----------------------------------------------------------------

def _port_values(inputs: Mapping[str, PortValueDict], *ports: str) -> list[str]:
    for port in ports:
        entry = inputs.get(port)
        if entry is not None and entry.value not in (None, "", []):
            raw = entry.value if isinstance(entry.value, list) else [entry.value]
            return [str(value) for value in raw if value]
    return []


def _json_list(value: Any, name: str) -> list[str]:
    if value in (None, ""):
        return []
    if isinstance(value, str):
        text = value.strip()
        if not text.startswith("["):
            return [text] if text else []
        try:
            value = json.loads(text)
        except ValueError as exc:
            raise ValueError(f"{name} must be a JSON list of URLs") from exc
    values = value if isinstance(value, list) else [value]
    return [str(item) for item in values if item]


def _port_or_param(inputs: Mapping[str, PortValueDict], params: Mapping[str, Any], key: str) -> list[str]:
    """A Krea field's values: the wired port wins, else the saved param."""
    wired = _port_values(inputs, key)
    return wired if wired else _json_list(params.get(key), key)


def _prompt(inputs: Mapping[str, PortValueDict], params: Mapping[str, Any]) -> dict[str, PortValueDict]:
    prompt = inputs.get("prompt")
    if prompt is not None and prompt.value not in (None, ""):
        return {"prompt": prompt}
    if params.get("prompt"):
        return {"prompt": PortValueDict(type="Text", value=str(params["prompt"]))}
    return {}


def _setting(node: GraphNode, key: str) -> Any:
    """A param as the run's price reads it (model_pricing.effective_params):
    the saved value, else the node definition's default. A node added by the
    CLI or an agent may save only some params; reading BytePlus's own default
    instead (duration -1, ratio adaptive) would bill a longer video than the
    estimate, or send a ratio Seedance 1.0 text-to-video refuses."""
    value = node.params.get(key)
    if value not in (None, ""):
        return value
    from execution.maker_routes import definition_for

    definition = definition_for(node.definition_id)
    for group in ("sharedParams", "falParams", "directParams", "params"):
        for param in definition.get(group) or []:
            if isinstance(param, Mapping) and param.get("key") == key:
                return param.get("default")
    return None


def _whole_seconds(value: Any, model: str) -> int:
    shortest, longest = DURATIONS[model]
    if isinstance(value, bool) or not isinstance(value, (int, float, str)):
        raise ValueError(f"duration must be whole seconds from {shortest} to {longest} (received {value!r})")
    try:
        seconds = float(value)
    except ValueError:
        raise ValueError(f"duration must be whole seconds from {shortest} to {longest} (received {value!r})") from None
    if not seconds.is_integer() or not shortest <= seconds <= longest:
        raise ValueError(
            f"BytePlus takes whole seconds from {shortest} to {longest} for this model (received {value!r}). "
            "Change the duration, or run it on the copy.")
    return int(seconds)


def _resolution(value: Any, model: str) -> str:
    resolution = str(value or "720p")
    if resolution not in RESOLUTIONS[model]:
        raise ValueError(f"BytePlus's {model} renders {', '.join(RESOLUTIONS[model])}, not {resolution!r}")
    return resolution


def _task(model: str, *, ratio: str | None, duration: int, resolution: str, audio: Any = None,
          camera_fixed: Any = None, seed: Any = None) -> dict[str, Any]:
    out: dict[str, Any] = {"model": model, "duration": duration, "resolution": resolution}
    if ratio is not None:
        out["ratio"] = ratio
    if model in _AUDIO_MODELS and isinstance(audio, bool):
        out["generate_audio"] = audio
    if model in _SERIES_1:
        if isinstance(camera_fixed, bool):
            out["camera_fixed"] = camera_fixed
        if seed not in (None, ""):
            if isinstance(seed, bool) or not isinstance(seed, int) or not -1 <= seed <= 2147483647:
                raise ValueError(f"BytePlus takes a seed from -1 to 2147483647 (received {seed!r})")
            out["seed"] = seed
    return out


def _frames(model: str, first: list[str], last: list[str]) -> dict[str, PortValueDict]:
    if len(first) > 1 or len(last) > 1:
        raise ValueError("Seedance takes one start image and one end image")
    if last and not first:
        raise ValueError("BytePlus needs a start image to use an end image (first and last frames)")
    if last and model not in _LAST_FRAME_MODELS:
        raise ValueError(f"BytePlus's {model} takes a start image only, not an end image")
    routed: dict[str, PortValueDict] = {}
    if first:
        routed["first_frame"] = PortValueDict(type="Image", value=first[0])
    if last:
        routed["last_frame"] = PortValueDict(type="Image", value=last[0])
    return routed


def fal_to_byteplus(node: GraphNode, inputs: dict[str, PortValueDict]) -> tuple[GraphNode, dict[str, PortValueDict]]:
    """A fal Seedance node's params -> one ModelArk video task.

    - model: FAL_NODE_MODELS by node; seedance-v1-5 by its model param
      ('1.5' -> 1.5 pro, '1.0' -> 1.0 pro).
    - aspect_ratio 'auto' -> ratio 'adaptive' (BytePlus: "automatically
      selects an aspect ratio based on the task type and input"); others as is.
    - duration 'auto' -> -1 (the model picks a whole-second length in its
      range); '4'..'15' -> that many seconds.
    - resolution as is. generate_audio on 2.x and 1.5 pro (1.0 pro makes
      silent video, as fal's v1 endpoints do). camera_fixed and seed on 1.x.
    - image -> first_frame, end_image -> last_frame; images (r2v) ->
      reference_image, 1 to 9.
    - Never reach here: seed on 2.x (blocks this route) and
      enable_safety_checker switched off on 1.0 T2V (directRoute.accepts; left
      on it's fal-only and not sent, as ModelArk always runs its own filter)."""
    if node.definition_id == "seedance-v1-5":
        choice = str(_setting(node, "model") or "1.5")
        model = FAL_V1_5_MODELS.get(choice)
        if model is None:
            raise ValueError(f"Seedance model {choice!r} has no BytePlus route")
    else:
        model = FAL_NODE_MODELS[node.definition_id]
    aspect = str(_setting(node, "aspect_ratio") or "auto")
    ratio = "adaptive" if aspect == "auto" else aspect
    if ratio != "adaptive" and ratio not in RATIOS:
        raise ValueError(f"BytePlus has no {aspect!r} ratio")
    raw_duration = _setting(node, "duration")
    duration = -1 if raw_duration in (None, "", "auto") else _whole_seconds(raw_duration, model)
    task = _task(model, ratio=ratio, duration=duration, resolution=_resolution(_setting(node, "resolution"), model),
                 audio=_setting(node, "generate_audio"), camera_fixed=_setting(node, "camera_fixed"),
                 seed=_setting(node, "seed") if model in _SERIES_1 else None)
    routed = _prompt(inputs, {})
    routed.update(_frames(model, _port_values(inputs, "image"), _port_values(inputs, "end_image")))
    refs = _port_values(inputs, "images")
    if refs:
        limit = _REFERENCE_LIMITS[model][0]
        if len(refs) > limit:
            raise ValueError(f"BytePlus's Seedance 2.0 takes 1 to {limit} reference images (received {len(refs)})")
        routed["reference_images"] = PortValueDict(type="Image", value=refs)
    return node.model_copy(update={"params": task}), routed


def krea_to_byteplus(model: str):
    """Krea's Seedance params -> a ModelArk video task, for one model.

    prompt (port, else param); start_image / end_image (port, else param) ->
    first_frame / last_frame; reference_images / reference_videos /
    reference_audios (port, else the JSON param) -> reference_image /
    reference_video / reference_audio; aspect_ratio -> ratio (Seedance 2.5
    frame runs send adaptive, the only ratio BytePlus takes there: it keeps
    the start image's shape); duration -> whole seconds; resolution as is;
    generate_audio when set. A start video or reference images on 1.0 pro
    keep the run on Krea, saved or wired (directRoute.blockedBy), and are
    refused here if one ever arrives; wired effects are refused, and so is a
    frame run that also has references (BytePlus "cannot be mixed")."""

    def translate(node: GraphNode, inputs: dict[str, PortValueDict]) -> tuple[GraphNode, dict[str, PortValueDict]]:
        params = node.params
        for port in ("start_video", "effects"):
            if _port_values(inputs, port):
                raise ValueError(
                    f"Krea's {port.replace('_', ' ')} has no BytePlus equivalent. Remove it, or remove the "
                    "BytePlus key (or choose the Krea plan) to run this on Krea.")
        images = _port_or_param(inputs, params, "reference_images")
        videos = _port_or_param(inputs, params, "reference_videos")
        audios = _port_or_param(inputs, params, "reference_audios")
        if model not in _REFERENCE_LIMITS and (images or videos or audios):
            raise ValueError(
                f"BytePlus's {model} takes no reference images. Remove them, or remove the BytePlus key (or "
                "choose the Krea plan) to run this on Krea.")
        first = _port_or_param(inputs, params, "start_image")
        last = _port_or_param(inputs, params, "end_image")
        if (first or last) and (images or videos or audios):
            raise ValueError(
                "BytePlus can't mix start/end frames with reference images, videos or audio (they are "
                "\"mutually exclusive scenarios\"). Use one or the other, or run this on Krea.")
        if model in _REFERENCE_LIMITS:
            max_images, max_videos, max_audios = _REFERENCE_LIMITS[model]
            for what, values, limit in (("reference images", images, max_images),
                                        ("reference videos", videos, max_videos),
                                        ("reference audio clips", audios, max_audios)):
                if len(values) > limit:
                    raise ValueError(f"BytePlus's {model} takes at most {limit} {what} (received {len(values)})")
            if audios and not (images or videos) and model != SEEDANCE_2_5:
                raise ValueError("Seedance 2.0 needs a reference image or video with reference audio "
                                 "(audio-only input is a Seedance 2.5 feature)")
        aspect = str(_setting(node, "aspect_ratio") or "16:9")
        if aspect not in RATIOS:
            raise ValueError(f"BytePlus has no {aspect!r} ratio; run this on Krea")
        ratio = "adaptive" if model == SEEDANCE_2_5 and first else aspect
        task = _task(model, ratio=ratio, duration=_whole_seconds(_setting(node, "duration"), model),
                     resolution=_resolution(_setting(node, "resolution"), model),
                     audio=_setting(node, "generate_audio"))
        routed = _prompt(inputs, params)
        routed.update(_frames(model, first, last))
        for port, values, kind in (("reference_images", images, "Image"), ("reference_videos", videos, "Video"),
                                   ("reference_audios", audios, "Audio")):
            if values:
                routed[port] = PortValueDict(type=kind, value=values)
        return node.model_copy(update={"params": task}), routed

    return translate


# -- request ---------------------------------------------------------------------

# Create-video-generation-task reference (docs.byteplus.com/en/docs/ModelArk/
# create-video-generation-task-api, read 2026-10-14): "Single image must be
# less than 30 MB", "Each audio file must not exceed 15 MB", "Request body
# size does not exceed 64 MB".
MAX_IMAGE_BYTES = 30_000_000
MAX_AUDIO_BYTES = 15_000_000
MAX_BODY_BYTES = 64_000_000


def _image(value: str) -> str:
    """An image as ModelArk takes it: a URL, an asset URI or a data URI.
    Owned outputs and local files are read (file policy, then the 30 MB cap)."""
    from services.media_input import owned_output_value

    value = owned_output_value(value)
    if value.startswith(("http://", "https://", "data:", "asset://")):
        return value
    from services.image_input import load_local_image

    mime, b64 = load_local_image(value, max_bytes=MAX_IMAGE_BYTES)
    return f"data:{mime.lower()};base64,{b64}"


_LOCAL_HOSTS = {"localhost", "127.0.0.1", "0.0.0.0", "::1"}


def _video(value: str) -> str:
    """A reference video: BytePlus takes only a public URL or an asset URI ("Video
    URL or asset ID"; no Base64 is documented), so a local file can't go."""
    if value.startswith("asset://"):
        return value
    if value.startswith(("http://", "https://")):
        from services.media_input import is_loopback_host

        try:
            host = urlparse(value).hostname or ""
        except ValueError:
            host = ""
        if host and host not in _LOCAL_HOSTS and not is_loopback_host(host):
            return value
    raise ValueError(
        "BytePlus takes reference videos only as a public URL (or a ModelArk asset ID), and this one is a local "
        "file. Use a video at a public URL, or remove the BytePlus key (or choose the Krea plan) to run this on "
        "Krea.")


_AUDIO_FORMATS = {"wav": "wav", "mp3": "mp3"}


def _audio(value: str) -> str:
    """Reference audio: a URL, an asset URI, or a local wav/mp3 as
    "data:audio/<audio format>;base64,<Base64 encoding>"."""
    from services.media_input import owned_output_value, read_local_media

    value = owned_output_value(value)
    if value.startswith(("http://", "https://", "data:", "asset://")):
        return value
    from pathlib import Path

    fmt = _AUDIO_FORMATS.get(Path(value).suffix.lstrip(".").lower())
    if fmt is None:
        raise ValueError(f"BytePlus takes reference audio as wav or mp3 (received {Path(value).name!r})")
    _path, data = read_local_media(value, label="BytePlus reference audio", max_bytes=MAX_AUDIO_BYTES)
    return f"data:audio/{fmt};base64,{base64.b64encode(data).decode('ascii')}"


def task_body(node: GraphNode, inputs: Mapping[str, PortValueDict]) -> dict[str, Any]:
    """One POST /contents/generations/tasks body for a translated node."""
    params = dict(node.params)
    content: list[dict[str, Any]] = []
    prompt = inputs.get("prompt")
    text = str(prompt.value).strip() if prompt is not None and prompt.value not in (None, "") else ""
    if text:
        content.append({"type": "text", "text": text})
    for port, role in (("first_frame", "first_frame"), ("last_frame", "last_frame")):
        for value in _port_values(inputs, port):
            content.append({"type": "image_url", "image_url": {"url": _image(value)}, "role": role})
    for value in _port_values(inputs, "reference_images"):
        content.append({"type": "image_url", "image_url": {"url": _image(value)}, "role": "reference_image"})
    for value in _port_values(inputs, "reference_videos"):
        content.append({"type": "video_url", "video_url": {"url": _video(value)}, "role": "reference_video"})
    for value in _port_values(inputs, "reference_audios"):
        content.append({"type": "audio_url", "audio_url": {"url": _audio(value)}, "role": "reference_audio"})
    if not content:
        raise ValueError("Seedance needs a prompt or an image")
    from handlers.byteplus import TASK_EXPIRES_AFTER

    inline = sum(len(item[item["type"]]["url"]) for item in content
                 if item["type"] != "text" and item[item["type"]]["url"].startswith("data:"))
    if inline > MAX_BODY_BYTES:
        raise ValueError(f"BytePlus takes a request of up to {MAX_BODY_BYTES // 1_000_000} MB, and these local "
                         f"files make it about {inline // 1_000_000} MB once encoded. Use public URLs for the "
                         "larger files.")
    return {**params, "content": content, "watermark": False, "execution_expires_after": TASK_EXPIRES_AFTER}


async def _generate(node: GraphNode, inputs: dict[str, PortValueDict], api_keys: dict[str, str],
                    emit: Any = None) -> str:
    """Run the task and save its video to the run dir right away (the URL
    lasts 24 hours); returns the saved path."""
    import logging

    from handlers import byteplus
    from services.output import get_run_dir, materialize_media_value

    key = byteplus.api_key(api_keys)
    body = task_body(node, inputs)
    task = await byteplus.run_video_task(key, body, node_id=node.id, emit=emit)
    content = task.get("content") if isinstance(task.get("content"), dict) else {}
    url = content.get("video_url")
    if not isinstance(url, str) or not url:
        raise RuntimeError(f"BytePlus ModelArk task {task.get('id')} succeeded but returned no video_url")
    usage = task.get("usage") if isinstance(task.get("usage"), dict) else {}
    logging.getLogger(__name__).info(
        "BytePlus %s task %s: %s completion tokens", body.get("model"), task.get("id"), usage.get("completion_tokens"))
    path = await materialize_media_value(url, "Video", get_run_dir())
    return str(path)


async def byteplus_seedance(node: GraphNode, inputs: dict[str, PortValueDict], api_keys: dict[str, str],
                            emit: Any = None) -> dict[str, Any]:
    """A fal Seedance node's result on BytePlus: its Video port."""
    return {"video": {"type": "Video", "value": await _generate(node, inputs, api_keys, emit)}}


async def krea_byteplus_seedance(node: GraphNode, inputs: dict[str, PortValueDict], api_keys: dict[str, str],
                                 emit: Any = None) -> dict[str, Any]:
    """A Krea node's result on BytePlus: video, videos and artifacts (no Krea job)."""
    from services.output import portable_output_ref

    path = await _generate(node, inputs, api_keys, emit)
    ref = portable_output_ref(path, require_file=True)
    return {
        "video": {"type": "Video", "value": path},
        "videos": {"type": "Array", "value": [ref]},
        "artifacts": {"type": "Array", "value": [{"type": "Video", "value": ref}]},
    }


krea_byteplus_seedance.takes_emit = True  # type: ignore[attr-defined]  # maker_routes.krea_router
