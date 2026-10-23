from __future__ import annotations

from pathlib import Path
from typing import Any, Awaitable, Callable

from models.graph import GraphNode, PortValueDict
from models.events import ExecutionEvent
from execution.async_poll_runner import AsyncPollConfig, async_poll_execute
from services.file_access import require_allowed_path
from services.maker_sizes import RUNWAY_GEN4_IMAGE_RATIOS
from services.output import get_run_dir, save_video_from_url, save_base64_image, image_to_data_uri

import base64
import math
import httpx
from execution.missing_credential import MissingCredentialError
from execution.person_line import as_person_line, missing_file_line, option_label, or_list, with_person_line

RUNWAY_API_BASE = "https://api.dev.runwayml.com/v1"
RUNWAY_HEADERS_BASE = {
    "Content-Type": "application/json",
    "X-Runway-Version": "2024-11-06",
}

# Per-model request limits, read from Runway's OpenAPI request schema
# (https://docs.dev.runwayml.com/openapi.json) on 2026-10-14. Runway rejects any
# field a model doesn't list ("Only the fields listed under a given model are
# valid"), so the handler only sends what the model takes and checks every
# value here, before the billed submit.
#
# Retired on Runway: gen3a_turbo and gen4_aleph ("no longer available on Runway
# Dev" since 2026-07-30, llms-full.txt changelog); veo3 is gone from the
# image_to_video / text_to_video request schema. Saved graphs move off them in
# services/retired_nodes.py; these messages catch anything that still sends them.
RETIRED_RUNWAY_MODELS: dict[str, str] = {
    "gen3a_turbo": "Runway retired Gen-3a Turbo (gen3a_turbo) on 2026-07-30. Use Gen-4 Turbo (needs an image) or Gen-4.5.",
    "veo3": "Runway no longer offers Veo 3 (veo3). Use Veo 3.1 or Veo 3.1 Fast.",
    "gen4_aleph": "Runway retired Gen-4 Aleph (gen4_aleph) on 2026-07-30. Use Aleph 2.0 (aleph2).",
}

_GEN4_VIDEO_RATIOS = ("1280:720", "720:1280", "1104:832", "960:960", "832:1104", "1584:672")
_VEO_RATIOS = ("1280:720", "720:1280", "1080:1920", "1920:1080")
_HAPPYHORSE_T2V_RATIOS = (
    "1280:720", "720:1280", "960:960", "1108:832", "832:1108",
    "1920:1080", "1080:1920", "1440:1440", "1662:1248", "1248:1662",
)
_SEEDANCE_SD_RATIOS = (  # 480p and 720p
    "992:432", "864:496", "752:560", "640:640", "560:752", "496:864",
    "1470:630", "1280:720", "1112:834", "960:960", "834:1112", "720:1280",
)
_SEEDANCE2_RATIOS = _SEEDANCE_SD_RATIOS + (
    "2206:946", "1920:1080", "1664:1248", "1440:1440", "1248:1664", "1080:1920",
    "3840:1646", "3840:2160", "3840:2880", "3840:3840", "2880:3840", "2160:3840",
)
_SEEDANCE25_RATIOS = (
    "992:432", "854:480", "752:560", "640:640", "560:752", "480:854",
    "1470:630", "1280:720", "1112:834", "960:960", "834:1112", "720:1280",
    "2206:946", "1920:1080", "1664:1248", "1440:1440", "1248:1664", "1080:1920",
)


def _video_spec(
    label: str, *, i2v_ratios: tuple[str, ...] | None, t2v_ratios: tuple[str, ...] | None,
    durations: tuple[int, ...], auto: bool = False, prompt_max: int = 1000, prompt_min: int = 1,
    i2v_prompt_required: bool = False, audio: bool = False, seed: bool = True,
    resolution: tuple[str, ...] | None = None,
) -> dict[str, Any]:
    return {
        "label": label, "i2v_ratios": i2v_ratios, "t2v_ratios": t2v_ratios, "durations": durations,
        "auto": auto, "prompt_max": prompt_max, "prompt_min": prompt_min,
        "i2v_prompt_required": i2v_prompt_required, "audio": audio, "seed": seed, "resolution": resolution,
    }


# i2v_ratios None with resolution set: the model takes `resolution`, not
# `ratio`, on image_to_video (the output follows the image's aspect).
# t2v_ratios None: no text_to_video for this model.
RUNWAY_VIDEO_MODELS: dict[str, dict[str, Any]] = {
    "gen4.5": _video_spec("Gen-4.5", i2v_ratios=_GEN4_VIDEO_RATIOS, t2v_ratios=("1280:720", "720:1280"),
                          durations=tuple(range(2, 11)), i2v_prompt_required=True),
    "gen4_turbo": _video_spec("Gen-4 Turbo", i2v_ratios=_GEN4_VIDEO_RATIOS, t2v_ratios=None,
                              durations=tuple(range(2, 11))),
    "veo3.1": _video_spec("Veo 3.1", i2v_ratios=_VEO_RATIOS, t2v_ratios=_VEO_RATIOS,
                          durations=(4, 6, 8), audio=True),
    "veo3.1_fast": _video_spec("Veo 3.1 Fast", i2v_ratios=_VEO_RATIOS, t2v_ratios=_VEO_RATIOS,
                               durations=(4, 6, 8), audio=True),
    "happyhorse_1_0": _video_spec("HappyHorse 1.0", i2v_ratios=None, t2v_ratios=_HAPPYHORSE_T2V_RATIOS,
                                  durations=tuple(range(3, 16)), prompt_max=2500, prompt_min=2,
                                  seed=False, resolution=("720p", "1080p")),
    "seedance2": _video_spec("Seedance 2.0", i2v_ratios=_SEEDANCE2_RATIOS, t2v_ratios=_SEEDANCE2_RATIOS,
                             durations=tuple(range(4, 16)), auto=True, prompt_max=3500, audio=True),
    "seedance2_fast": _video_spec("Seedance 2.0 Fast", i2v_ratios=_SEEDANCE_SD_RATIOS,
                                  t2v_ratios=_SEEDANCE_SD_RATIOS, durations=tuple(range(4, 16)),
                                  auto=True, prompt_max=3500, audio=True),
    "seedance2_mini": _video_spec("Seedance 2.0 Mini", i2v_ratios=_SEEDANCE_SD_RATIOS,
                                  t2v_ratios=_SEEDANCE_SD_RATIOS, durations=tuple(range(4, 16)),
                                  auto=True, prompt_max=3500, audio=True),
    "seedance2_5": _video_spec("Seedance 2.5", i2v_ratios=_SEEDANCE25_RATIOS, t2v_ratios=_SEEDANCE25_RATIOS,
                               durations=tuple(range(4, 31)), auto=True, prompt_max=15000, audio=True),
}

# Models that support text-to-video (no image required)
TEXT_TO_VIDEO_MODELS = {m for m, spec in RUNWAY_VIDEO_MODELS.items() if spec["t2v_ratios"]}

# gen4_image's sizes live in services/maker_sizes.py (the Krea copy's maker
# route snaps to the same list).
_GEN4_IMAGE_RATIOS = RUNWAY_GEN4_IMAGE_RATIOS
_GEMINI_FLASH_RATIOS = (
    "1344:768", "768:1344", "1024:1024", "1184:864", "864:1184", "1536:672", "832:1248", "1248:832",
    "896:1152", "1152:896",
)


def _image_spec(label: str, ratios: tuple[str, ...], *, refs_max: int, refs_min: int = 0,
                prompt_max: int, prompt_min: int = 1, seed: bool = False, grounding: bool = False) -> dict[str, Any]:
    return {"label": label, "ratios": ratios, "refs_max": refs_max, "refs_min": refs_min,
            "prompt_max": prompt_max, "prompt_min": prompt_min, "seed": seed, "grounding": grounding}


RUNWAY_IMAGE_MODELS: dict[str, dict[str, Any]] = {
    "gen4_image": _image_spec("Gen-4 Image", _GEN4_IMAGE_RATIOS, refs_max=3, prompt_max=1000, seed=True),
    "gen4_image_turbo": _image_spec("Gen-4 Image Turbo", _GEN4_IMAGE_RATIOS, refs_max=3, refs_min=1,
                                    prompt_max=1000, seed=True),
    "gemini_image3_pro": _image_spec("Nano Banana Pro", _GEMINI_FLASH_RATIOS + (
        "2048:2048", "1696:2528", "2528:1696", "1792:2400", "2400:1792", "1856:2304", "2304:1856",
        "1536:2752", "2752:1536", "3168:1344", "4096:4096", "3392:5056", "5056:3392", "3584:4800",
        "4800:3584", "3712:4608", "4608:3712", "3072:5504", "5504:3072", "6336:2688",
    ), refs_max=14, prompt_max=5500, prompt_min=3),
    "gpt_image_2": _image_spec("GPT Image 2", (
        "2048:880", "1920:1088", "1920:1280", "1920:1440", "1920:1536", "1920:1920", "1536:1920",
        "1440:1920", "1280:1920", "1088:1920", "2912:1248", "2560:1440", "2560:1712", "2560:1920",
        "2560:2048", "2560:2560", "2048:2560", "1920:2560", "1712:2560", "1440:2560", "3840:1648",
        "3840:2160", "3504:2336", "3264:2448", "3200:2560", "2880:2880", "2560:3200", "2448:3264",
        "2336:3504", "2160:3840", "auto",
    ), refs_max=16, prompt_max=32000),
    "gemini_2.5_flash": _image_spec("Gemini 2.5 Flash", _GEMINI_FLASH_RATIOS, refs_max=3, prompt_max=5500),
    "seedream5_pro": _image_spec("Seedream 5.0 Pro", (
        "1024:1024", "1184:896", "896:1184", "1376:768", "768:1376", "1296:864", "864:1296", "2048:2048",
        "2304:1728", "1728:2304", "2720:1530", "1530:2720", "2496:1664", "1664:2496", "auto_1k", "auto_2k",
    ), refs_max=10, prompt_max=4000, grounding=True),
    # Lite also takes freeform sizes (3,686,400-16,777,216 px); the node offers the fixed list.
    "seedream5_lite": _image_spec("Seedream 5.0 Lite", (
        "2048:2048", "2304:1728", "1728:2304", "2848:1600", "1600:2848", "2496:1664", "1664:2496",
        "3136:1344", "3072:3072", "3456:2592", "2592:3456", "4096:2304", "2304:4096", "3744:2496",
        "2496:3744", "4704:2016",
    ), refs_max=14, prompt_max=4000, grounding=True),
}

# Runway's request schema caps every data URI at 5MB ("A data URI containing
# encoded media, up to 5MB", maxLength 5242880, openapi.json 2026-10-14). The
# inputs guide lists 16MB for video/audio data URIs; the schema is the stricter
# of the two and is what validates the request, so it wins. Larger local files
# go up through Runway's ephemeral uploads instead
# (https://docs.dev.runwayml.com/assets/uploads): 200MB max, 512 bytes min,
# runway:// URIs valid for 24 hours.
DATA_URI_LIMIT = 5 * 1024 * 1024
UPLOAD_LIMIT = 200 * 1024 * 1024


def _runway_headers(api_key: str) -> dict[str, str]:
    return {**RUNWAY_HEADERS_BASE, "Authorization": f"Bearer {api_key}"}


def _runway_poll_config(api_key: str, submit_url: str) -> AsyncPollConfig:
    return AsyncPollConfig(
        submit_url=submit_url,
        poll_url_template=f"{RUNWAY_API_BASE}/tasks/{{task_id}}",
        headers=_runway_headers(api_key),
        terminal_success={"SUCCEEDED"},
        terminal_failure={"FAILED"},
        status_path="status",
        task_id_path="id",
        poll_interval=2.0,
        max_polls=300,
        provider="Runway",
    )


def _data_uri_length(size: int, mime: str) -> int:
    return len(f"data:{mime};base64,") + 4 * math.ceil(size / 3)


async def _upload_ephemeral(path: Path, api_key: str, mime: str) -> str:
    """Upload a local file with Runway's ephemeral upload flow; return its runway:// URI.

    POST /v1/uploads {filename, type: ephemeral} returns a presigned form
    (uploadUrl + fields); the file goes there as the multipart ``file`` field.
    The upload URL is storage, not Runway's API, so it gets no API key."""
    size = path.stat().st_size
    if size > UPLOAD_LIMIT:
        raise with_person_line(ValueError(
            f"{path.name} is {size / 1024 / 1024:.0f}MB; Runway accepts files up to 200MB."
        ),
            "A connected file is over Runway's 200 MB limit. Connect a smaller one.")
    async with httpx.AsyncClient(timeout=httpx.Timeout(60.0, write=600.0)) as client:
        start = await client.post(
            f"{RUNWAY_API_BASE}/uploads",
            headers=_runway_headers(api_key),
            json={"filename": path.name, "type": "ephemeral"},
        )
        if start.status_code >= 400:
            raise RuntimeError(f"Runway upload could not start ({start.status_code}): {start.text[:300]}")
        ticket = start.json()
        upload_url, fields, runway_uri = ticket.get("uploadUrl"), ticket.get("fields") or {}, ticket.get("runwayUri")
        if not upload_url or not isinstance(runway_uri, str) or not runway_uri.startswith("runway://"):
            raise RuntimeError("Runway upload response had no uploadUrl or runway:// URI")
        with path.open("rb") as handle:
            sent = await client.post(upload_url, data=fields, files={"file": (path.name, handle, mime)})
        if sent.status_code >= 400:
            raise RuntimeError(f"Runway upload failed ({sent.status_code}): {sent.text[:300]}")
    return runway_uri


async def _local_media_uri(value: str, mime: str, api_key: str | None, what: str = "File") -> str:
    """A Runway-ready URI for a media value.

    https/data/runway URIs pass through. A local file becomes a data URI when
    the encoded URI fits Runway's 5MB cap, else an ephemeral upload."""
    if value.startswith(("http://", "https://", "data:", "runway://")):
        return value
    path = Path(value)
    if not path.exists():
        raise with_person_line(ValueError(f"{what} not found: {value}"), missing_file_line(what))
    path = require_allowed_path(path)
    if _data_uri_length(path.stat().st_size, mime) <= DATA_URI_LIMIT:
        return f"data:{mime};base64,{base64.b64encode(path.read_bytes()).decode('ascii')}"
    if not api_key:
        raise with_person_line(
            ValueError(f"{path.name} is over Runway's 5MB data URI limit and needs an upload"),
            "A connected file is too large to send to Runway this way. Connect one under 5 MB.")
    return await _upload_ephemeral(path, api_key, mime)


_IMAGE_MIME = {"png": "image/png", "jpg": "image/jpeg", "jpeg": "image/jpeg", "webp": "image/webp"}


async def _resolve_image(image_value: str, api_key: str | None = None) -> str:
    """Convert a local image path to a data URI (or an upload when it's over 5MB)."""
    if image_value.startswith(("http://", "https://", "data:", "runway://")):
        return image_value
    image_path = Path(image_value)
    if not image_path.exists():
        raise with_person_line(ValueError(f"Image file not found: {image_value}"), missing_file_line("image file"))
    image_path = require_allowed_path(image_path)
    mime = _IMAGE_MIME.get(image_path.suffix.lstrip(".").lower(), "image/png")
    if _data_uri_length(image_path.stat().st_size, mime) <= DATA_URI_LIMIT:
        return image_to_data_uri(image_path)
    if not api_key:
        raise with_person_line(
            ValueError(f"{image_path.name} is over Runway's 5MB data URI limit and needs an upload"),
            "A connected file is too large to send to Runway this way. Connect one under 5 MB.")
    return await _upload_ephemeral(image_path, api_key, mime)


def _choices(values: Any) -> str:
    return ", ".join(str(v) for v in values)


def _video_duration(spec: dict[str, Any], raw: Any) -> int | str:
    if isinstance(raw, str) and raw.strip().lower() == "auto":
        if spec["auto"]:
            return "auto"
        raise as_person_line(ValueError(f"{spec['label']} has no automatic duration. Pick one of: {_choices(spec['durations'])} s."))
    try:
        duration = int(float(raw))
    except (TypeError, ValueError):
        raise as_person_line(ValueError(f"Duration must be a number of seconds, got {raw!r}"))
    if duration not in spec["durations"]:
        allowed = spec["durations"]
        span = (f"{allowed[0]}-{allowed[-1]}" if len(allowed) > 3 and allowed == tuple(range(allowed[0], allowed[-1] + 1))
                else _choices(allowed))
        extra = " or auto" if spec["auto"] else ""
        raise as_person_line(ValueError(f"{spec['label']} takes a duration of {span} s{extra}; got {duration} s."))
    return duration


def _prompt_for(spec: dict[str, Any], text: str) -> str:
    text = text[: spec["prompt_max"]]
    if text and len(text) < spec["prompt_min"]:
        raise as_person_line(ValueError(f"{spec['label']} needs a prompt of at least {spec['prompt_min']} characters."))
    return text


async def handle_runway_video(
    node: GraphNode,
    inputs: dict[str, PortValueDict],
    api_keys: dict[str, str],
    emit: Callable[[ExecutionEvent], Awaitable[None]] | None = None,
) -> dict[str, Any]:
    api_key = api_keys.get("RUNWAY_API_KEY")
    if not api_key:
        raise MissingCredentialError("RUNWAY_API_KEY is required")

    model = str(node.params.get("model") or "gen4.5")
    if model in RETIRED_RUNWAY_MODELS:
        raise ValueError(RETIRED_RUNWAY_MODELS[model])
    spec = RUNWAY_VIDEO_MODELS.get(model)
    if spec is None:
        raise with_person_line(ValueError(f"Unknown Runway video model '{model}'. Choose one of: {_choices(RUNWAY_VIDEO_MODELS)}."), "Pick a model in the node's Model field, then run the node again.")
    duration = _video_duration(spec, node.params.get("duration", 5))
    ratio = str(node.params.get("ratio") or "1280:720")

    prompt_input = inputs.get("prompt")
    prompt_text = _prompt_for(spec, str(prompt_input.value) if prompt_input and prompt_input.value else "")

    image_input = inputs.get("image")
    has_image = image_input and image_input.value

    submit_body: dict[str, Any] = {"model": model}
    if has_image:
        if spec["i2v_prompt_required"] and not prompt_text:
            raise as_person_line(ValueError(f"{spec['label']} image-to-video needs a text prompt too."))
        if spec["i2v_ratios"] is None:
            resolution = str(node.params.get("resolution") or spec["resolution"][0])
            if resolution not in spec["resolution"]:
                raise as_person_line(ValueError(f"{spec['label']} resolution must be one of {_choices(spec['resolution'])}; got '{resolution}'."))
            submit_body["resolution"] = resolution
        elif ratio not in spec["i2v_ratios"]:
            raise as_person_line(ValueError(
                f"Ratio '{ratio}' isn't available for {spec['label']} image-to-video. "
                f"Pick one of: {_choices(spec['i2v_ratios'])}."
            ))
        else:
            submit_body["ratio"] = ratio
        submit_body["promptImage"] = await _resolve_image(str(image_input.value), api_key)
        if prompt_text:
            submit_body["promptText"] = prompt_text
        endpoint = f"{RUNWAY_API_BASE}/image_to_video"
    else:
        if not prompt_text:
            raise as_person_line(ValueError("Either an image or a text prompt is required"))
        if spec["t2v_ratios"] is None:
            text_capable = ", ".join(sorted(TEXT_TO_VIDEO_MODELS))
            raise with_person_line(ValueError(
                f"Model '{model}' requires an image input ({spec['label']} has no text-to-video). "
                f"Connect an image, or use a text-to-video model: {text_capable}. "
                "Nodes saved with the retired Gen-3a Turbo now use Gen-4 Turbo."
            ), f"{spec['label']} has no text-to-video, so it needs an image. Connect one, or pick a text-to-video "
                f"model: {or_list(sorted(RUNWAY_VIDEO_MODELS[name]['label'] for name in TEXT_TO_VIDEO_MODELS))}. "
                "Nodes saved with the retired Gen-3a Turbo now use Gen-4 Turbo.")
        if ratio not in spec["t2v_ratios"]:
            raise as_person_line(ValueError(
                f"Ratio '{ratio}' isn't available for {spec['label']} text-to-video. "
                f"Pick one of: {_choices(spec['t2v_ratios'])}, or connect an image."
            ))
        submit_body["promptText"] = prompt_text
        submit_body["ratio"] = ratio
        endpoint = f"{RUNWAY_API_BASE}/text_to_video"
    submit_body["duration"] = duration

    if spec["audio"]:
        audio = node.params.get("audio")
        if audio is not None and audio != "":
            submit_body["audio"] = audio if isinstance(audio, bool) else str(audio).strip().lower() in ("true", "1", "yes", "on")

    seed = node.params.get("seed")
    if spec["seed"] and seed is not None and seed != "":
        submit_body["seed"] = int(seed)

    config = _runway_poll_config(api_key, endpoint)

    async def noop_emit(event: ExecutionEvent) -> None:
        pass

    result = await async_poll_execute(
        config=config,
        submit_body=submit_body,
        node_id=node.id,
        emit=emit or noop_emit,
    )

    output_urls = result.get("output", [])
    if not output_urls:
        raise RuntimeError("Runway returned no output URLs")

    video_url = output_urls[0] if isinstance(output_urls, list) else str(output_urls)

    run_dir = get_run_dir()
    video_path = await save_video_from_url(video_url, run_dir)

    return {"video": {"type": "Video", "value": str(video_path)}}


async def handle_runway_aleph(
    node: GraphNode,
    inputs: dict[str, PortValueDict],
    api_keys: dict[str, str],
    emit: Callable[[ExecutionEvent], Awaitable[None]] | None = None,
) -> dict[str, Any]:
    api_key = api_keys.get("RUNWAY_API_KEY")
    if not api_key:
        raise MissingCredentialError("RUNWAY_API_KEY is required")

    model = str(node.params.get("model") or "aleph2")
    if model in RETIRED_RUNWAY_MODELS:
        raise ValueError(RETIRED_RUNWAY_MODELS[model])
    if model != "aleph2":
        raise with_person_line(ValueError(f"Unknown Runway Aleph model '{model}'. Use aleph2."), f"Pick {option_label(node.definition_id, 'model', 'aleph2') or 'Aleph 2.0'} in the node's Model field, "
            "then run the node again.")

    video_input = inputs.get("video")
    if not video_input or not video_input.value:
        raise as_person_line(ValueError("Video input is required for Aleph"))

    prompt_input = inputs.get("prompt")
    if not prompt_input or not prompt_input.value:
        raise as_person_line(ValueError("Text prompt is required for Aleph"))

    # Public https URLs pass through; local files go as a data URI under 5MB,
    # else through Runway's upload flow.
    video_value = await _local_media_uri(str(video_input.value), "video/mp4", api_key, "Video file")

    submit_body: dict[str, Any] = {
        "model": model,
        "videoUri": video_value,
        "promptText": str(prompt_input.value)[:1000],
    }

    # Optional reference image. Aleph 2.0 has no `references` field; its image
    # guidance is `keyframes` ({uri, at: 0-1 of the input's length}). The
    # reference goes in at the start, as in Runway's own aleph2 example.
    ref_image_input = inputs.get("reference")
    if ref_image_input and ref_image_input.value:
        ref_uri = await _resolve_image(str(ref_image_input.value), api_key)
        submit_body["keyframes"] = [{"uri": ref_uri, "at": 0}]

    seed = node.params.get("seed")
    if seed is not None and seed != "":
        submit_body["seed"] = int(seed)

    config = _runway_poll_config(api_key, f"{RUNWAY_API_BASE}/video_to_video")

    async def noop_emit(event: ExecutionEvent) -> None:
        pass

    result = await async_poll_execute(
        config=config,
        submit_body=submit_body,
        node_id=node.id,
        emit=emit or noop_emit,
    )

    output_urls = result.get("output", [])
    if not output_urls:
        raise RuntimeError("Runway Aleph returned no output URLs")

    video_url = output_urls[0] if isinstance(output_urls, list) else str(output_urls)

    run_dir = get_run_dir()
    video_path = await save_video_from_url(video_url, run_dir)

    return {"video": {"type": "Video", "value": str(video_path)}}


async def handle_runway_image(
    node: GraphNode,
    inputs: dict[str, PortValueDict],
    api_keys: dict[str, str],
    emit: Callable[[ExecutionEvent], Awaitable[None]] | None = None,
) -> dict[str, Any]:
    api_key = api_keys.get("RUNWAY_API_KEY")
    if not api_key:
        raise MissingCredentialError("RUNWAY_API_KEY is required")

    prompt_input = inputs.get("prompt")
    if not prompt_input or not prompt_input.value:
        raise as_person_line(ValueError("Text prompt is required for Runway Image"))

    model = str(node.params.get("model") or "gen4_image")
    spec = RUNWAY_IMAGE_MODELS.get(model)
    if spec is None:
        raise with_person_line(ValueError(f"Unknown Runway image model '{model}'. Choose one of: {_choices(RUNWAY_IMAGE_MODELS)}."), "Pick a model in the node's Model field, then run the node again.")
    ratio = str(node.params.get("ratio") or "1360:768")
    if ratio not in spec["ratios"]:
        raise as_person_line(ValueError(f"Ratio '{ratio}' isn't available for {spec['label']}. Pick one of: {_choices(spec['ratios'])}."))

    prompt_text = str(prompt_input.value)[: spec["prompt_max"]]
    if len(prompt_text) < spec["prompt_min"]:
        raise as_person_line(ValueError(f"{spec['label']} needs a prompt of at least {spec['prompt_min']} characters."))

    submit_body: dict[str, Any] = {
        "model": model,
        "promptText": prompt_text,
        "ratio": ratio,
    }

    images_input = inputs.get("images")
    image_values: list[Any] = []
    if images_input and images_input.value:
        image_values = images_input.value if isinstance(images_input.value, list) else [images_input.value]
        image_values = [img for img in image_values if img]
    if len(image_values) > spec["refs_max"]:
        raise as_person_line(ValueError(f"{spec['label']} takes up to {spec['refs_max']} reference images; {len(image_values)} are connected."))
    if len(image_values) < spec["refs_min"]:
        raise as_person_line(ValueError(f"{spec['label']} needs at least {spec['refs_min']} reference image. Connect one, or use Gen-4 Image."))
    if image_values:
        submit_body["referenceImages"] = [{"uri": await _resolve_image(str(img), api_key)} for img in image_values]

    # Only Gen-4 Image takes a seed; the other models reject the field, and the
    # Inspector hides it for them, so a stale saved seed is left out.
    seed = node.params.get("seed")
    if spec["seed"] and seed is not None and seed != "":
        submit_body["seed"] = int(seed)
    grounding = node.params.get("grounding")
    if spec["grounding"] and (grounding is True or str(grounding).strip().lower() == "true"):
        submit_body["grounding"] = True

    config = _runway_poll_config(api_key, f"{RUNWAY_API_BASE}/text_to_image")

    async def noop_emit(event: ExecutionEvent) -> None:
        pass

    result = await async_poll_execute(
        config=config,
        submit_body=submit_body,
        node_id=node.id,
        emit=emit or noop_emit,
    )

    output_urls = result.get("output", [])
    if not output_urls:
        raise RuntimeError("Runway Image returned no output URLs")

    image_url = output_urls[0] if isinstance(output_urls, list) else str(output_urls)

    # Download image
    run_dir = get_run_dir()
    async with httpx.AsyncClient(timeout=60.0) as client:
        resp = await client.get(image_url, follow_redirects=True)
        resp.raise_for_status()
    b64_data = base64.b64encode(resp.content).decode("ascii")
    file_path = save_base64_image(b64_data, run_dir, extension="png")

    return {"image": {"type": "Image", "value": str(file_path)}}


async def handle_runway_image_upscale(
    node: GraphNode,
    inputs: dict[str, PortValueDict],
    api_keys: dict[str, str],
    emit: Callable[[ExecutionEvent], Awaitable[None]] | None = None,
) -> dict[str, Any]:
    api_key = api_keys.get("RUNWAY_API_KEY")
    if not api_key:
        raise MissingCredentialError("RUNWAY_API_KEY is required")

    image_input = inputs.get("image")
    if not image_input or not image_input.value:
        raise as_person_line(ValueError("Image input is required for Runway Upscale"))

    image_uri = await _resolve_image(str(image_input.value), api_key)

    submit_body: dict[str, Any] = {
        "model": "magnific_precision_upscaler_v2",
        "imageUri": image_uri,
        "scaleFactor": int(node.params.get("scaleFactor", 2)),
    }

    flavor = node.params.get("flavor")
    if flavor:
        submit_body["flavor"] = flavor

    for key in ("sharpen", "smartGrain", "ultraDetail"):
        value = node.params.get(key)
        if value is not None and value != "":
            submit_body[key] = int(value)

    config = _runway_poll_config(api_key, f"{RUNWAY_API_BASE}/image_upscale")

    async def noop_emit(event: ExecutionEvent) -> None:
        pass

    result = await async_poll_execute(
        config=config,
        submit_body=submit_body,
        node_id=node.id,
        emit=emit or noop_emit,
    )

    output_urls = result.get("output", [])
    if not output_urls:
        raise RuntimeError("Runway Upscale returned no output URLs")

    image_url = output_urls[0] if isinstance(output_urls, list) else str(output_urls)

    run_dir = get_run_dir()
    async with httpx.AsyncClient(timeout=120.0) as client:
        resp = await client.get(image_url, follow_redirects=True)
        resp.raise_for_status()
    b64_data = base64.b64encode(resp.content).decode("ascii")
    file_path = save_base64_image(b64_data, run_dir, extension="png")

    return {"image": {"type": "Image", "value": str(file_path)}}


async def handle_runway_act_two(
    node: GraphNode,
    inputs: dict[str, PortValueDict],
    api_keys: dict[str, str],
    emit: Callable[[ExecutionEvent], Awaitable[None]] | None = None,
) -> dict[str, Any]:
    api_key = api_keys.get("RUNWAY_API_KEY")
    if not api_key:
        raise MissingCredentialError("RUNWAY_API_KEY is required")

    # Character: image or video
    char_image_input = inputs.get("character_image")
    char_video_input = inputs.get("character_video")

    if char_image_input and char_image_input.value:
        char_uri = await _resolve_image(str(char_image_input.value), api_key)
        character = {"type": "image", "uri": char_uri}
    elif char_video_input and char_video_input.value:
        v = await _local_media_uri(str(char_video_input.value), "video/mp4", api_key, "Video file")
        character = {"type": "video", "uri": v}
    else:
        raise as_person_line(ValueError("Character image or video is required"))

    # Reference performance video
    ref_input = inputs.get("reference")
    if not ref_input or not ref_input.value:
        raise as_person_line(ValueError("Reference performance video is required"))

    ref_value = await _local_media_uri(str(ref_input.value), "video/mp4", api_key, "Reference video")

    submit_body: dict[str, Any] = {
        "model": "act_two",
        "character": character,
        "reference": {"type": "video", "uri": ref_value},
    }

    ratio = node.params.get("ratio")
    if ratio:
        submit_body["ratio"] = ratio

    body_control = node.params.get("bodyControl")
    if body_control is not None:
        submit_body["bodyControl"] = bool(body_control)

    expression = node.params.get("expressionIntensity")
    if expression is not None and expression != "":
        submit_body["expressionIntensity"] = int(expression)

    seed = node.params.get("seed")
    if seed is not None and seed != "":
        submit_body["seed"] = int(seed)

    config = _runway_poll_config(api_key, f"{RUNWAY_API_BASE}/character_performance")

    async def noop_emit(event: ExecutionEvent) -> None:
        pass

    result = await async_poll_execute(
        config=config,
        submit_body=submit_body,
        node_id=node.id,
        emit=emit or noop_emit,
    )

    output_urls = result.get("output", [])
    if not output_urls:
        raise RuntimeError("Runway Act-Two returned no output URLs")

    video_url = output_urls[0] if isinstance(output_urls, list) else str(output_urls)
    run_dir = get_run_dir()
    video_path = await save_video_from_url(video_url, run_dir)

    return {"video": {"type": "Video", "value": str(video_path)}}


async def _save_audio_from_url(url: str) -> str:
    """Download audio from URL and save locally."""
    from uuid import uuid4
    run_dir = get_run_dir()
    async with httpx.AsyncClient(timeout=60.0) as client:
        resp = await client.get(url, follow_redirects=True)
        resp.raise_for_status()
    filename = f"{uuid4().hex[:12]}.mp3"
    file_path = run_dir / filename
    file_path.write_bytes(resp.content)
    return str(file_path)


async def handle_runway_tts(
    node: GraphNode,
    inputs: dict[str, PortValueDict],
    api_keys: dict[str, str],
    emit: Callable[[ExecutionEvent], Awaitable[None]] | None = None,
) -> dict[str, Any]:
    api_key = api_keys.get("RUNWAY_API_KEY")
    if not api_key:
        raise MissingCredentialError("RUNWAY_API_KEY is required")

    prompt_input = inputs.get("text")
    if not prompt_input or not prompt_input.value:
        raise as_person_line(ValueError("Text input is required"))

    voice_id = node.params.get("voiceId", "Maya")

    submit_body: dict[str, Any] = {
        "model": "eleven_multilingual_v2",
        "promptText": str(prompt_input.value)[:1000],
        "voice": {
            "type": "runway-preset",
            "presetId": voice_id,
        },
    }

    config = _runway_poll_config(api_key, f"{RUNWAY_API_BASE}/text_to_speech")

    async def noop_emit(event: ExecutionEvent) -> None:
        pass

    result = await async_poll_execute(
        config=config,
        submit_body=submit_body,
        node_id=node.id,
        emit=emit or noop_emit,
    )

    output_urls = result.get("output", [])
    if not output_urls:
        raise RuntimeError("Runway TTS returned no output URLs")

    audio_url = output_urls[0] if isinstance(output_urls, list) else str(output_urls)
    file_path = await _save_audio_from_url(audio_url)

    return {"audio": {"type": "Audio", "value": file_path}}


async def handle_runway_speech_to_speech(
    node: GraphNode,
    inputs: dict[str, PortValueDict],
    api_keys: dict[str, str],
    emit: Callable[[ExecutionEvent], Awaitable[None]] | None = None,
) -> dict[str, Any]:
    api_key = api_keys.get("RUNWAY_API_KEY")
    if not api_key:
        raise MissingCredentialError("RUNWAY_API_KEY is required")

    audio_input = inputs.get("audio")
    video_input = inputs.get("video")

    if audio_input and audio_input.value:
        media_value = await _local_media_uri(str(audio_input.value), "audio/mpeg", api_key, "Audio file")
        media = {"type": "audio", "uri": media_value}
    elif video_input and video_input.value:
        media_value = await _local_media_uri(str(video_input.value), "video/mp4", api_key, "Video file")
        media = {"type": "video", "uri": media_value}
    else:
        raise as_person_line(ValueError("Audio or video input is required"))

    voice_id = node.params.get("voiceId", "Maya")

    submit_body: dict[str, Any] = {
        "model": "eleven_multilingual_sts_v2",
        "media": media,
        "voice": {
            "type": "runway-preset",
            "presetId": voice_id,
        },
    }

    remove_noise = node.params.get("removeBackgroundNoise")
    if remove_noise is not None:
        submit_body["removeBackgroundNoise"] = bool(remove_noise)

    config = _runway_poll_config(api_key, f"{RUNWAY_API_BASE}/speech_to_speech")

    async def noop_emit(event: ExecutionEvent) -> None:
        pass

    result = await async_poll_execute(
        config=config,
        submit_body=submit_body,
        node_id=node.id,
        emit=emit or noop_emit,
    )

    output_urls = result.get("output", [])
    if not output_urls:
        raise RuntimeError("Runway STS returned no output URLs")

    audio_url = output_urls[0] if isinstance(output_urls, list) else str(output_urls)
    file_path = await _save_audio_from_url(audio_url)

    return {"audio": {"type": "Audio", "value": file_path}}


async def handle_runway_voice_dubbing(
    node: GraphNode,
    inputs: dict[str, PortValueDict],
    api_keys: dict[str, str],
    emit: Callable[[ExecutionEvent], Awaitable[None]] | None = None,
) -> dict[str, Any]:
    api_key = api_keys.get("RUNWAY_API_KEY")
    if not api_key:
        raise MissingCredentialError("RUNWAY_API_KEY is required")

    audio_input = inputs.get("audio")
    if not audio_input or not audio_input.value:
        raise as_person_line(ValueError("Audio input is required for voice dubbing"))

    audio_value = await _local_media_uri(str(audio_input.value), "audio/mpeg", api_key, "Audio file")

    target_lang = node.params.get("targetLang", "es")

    submit_body: dict[str, Any] = {
        "model": "eleven_voice_dubbing",
        "audioUri": audio_value,
        "targetLang": target_lang,
    }

    disable_cloning = node.params.get("disableVoiceCloning")
    if disable_cloning is not None:
        submit_body["disableVoiceCloning"] = bool(disable_cloning)

    drop_bg = node.params.get("dropBackgroundAudio")
    if drop_bg is not None:
        submit_body["dropBackgroundAudio"] = bool(drop_bg)

    num_speakers = node.params.get("numSpeakers")
    if num_speakers is not None and num_speakers != "":
        submit_body["numSpeakers"] = int(num_speakers)

    config = _runway_poll_config(api_key, f"{RUNWAY_API_BASE}/voice_dubbing")

    async def noop_emit(event: ExecutionEvent) -> None:
        pass

    result = await async_poll_execute(
        config=config,
        submit_body=submit_body,
        node_id=node.id,
        emit=emit or noop_emit,
    )

    output_urls = result.get("output", [])
    if not output_urls:
        raise RuntimeError("Runway Voice Dubbing returned no output URLs")

    audio_url = output_urls[0] if isinstance(output_urls, list) else str(output_urls)
    file_path = await _save_audio_from_url(audio_url)

    return {"audio": {"type": "Audio", "value": file_path}}
