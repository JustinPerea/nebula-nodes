from __future__ import annotations

import asyncio
import base64
import io
import sys
from datetime import date
from pathlib import Path
from urllib.parse import quote
from typing import Any, Awaitable, Callable
from uuid import uuid4

import httpx

from models.graph import GraphNode, PortValueDict
from models.events import ExecutionEvent, ProgressEvent
from services.cancellation import schedule_detached_cancel
from services.google_vertex import VERTEX_REGION, access_token, model_url
from services.output import get_run_dir
from services.media_input import read_local_media
from services.public_url import fetch_public_media
from execution.missing_credential import MissingCredentialError
from execution.poll_retry import UpstreamTask, poll_request
from execution.person_line import as_person_line, missing_file_line, with_person_line

VEO_BASE_URL = "https://generativelanguage.googleapis.com/v1beta/models"

# Google shuts down the Veo 3.1 previews on the Gemini API (and fal's Veo 3.1,
# which runs on them) on 2026-10-22, "the earliest possible date", and names no
# GA Veo on the Gemini API (https://ai.google.dev/gemini-api/docs/deprecations,
# checked 2026-10-14). Vertex AI (Gemini Enterprise Agent Platform) serves the
# GA models: veo-3.1-generate-001 and veo-3.1-fast-generate-001 retire
# "November 17, 2026 or later"; veo-3.1-lite-generate-001 is still Preview
# (https://docs.cloud.google.com/gemini-enterprise-agent-platform/models/veo/3-1-generate,
# checked 2026-10-14). The node stores the Vertex IDs; the Gemini API route
# translates them back to the preview IDs until the previews end.
GEMINI_PREVIEWS_END = date(2026, 10, 22)
STANDARD_MODEL = "veo-3.1-generate-001"
FAST_MODEL = "veo-3.1-fast-generate-001"
LITE_MODEL = "veo-3.1-lite-generate-001"
VEO_MODELS = (STANDARD_MODEL, FAST_MODEL, LITE_MODEL)
GEMINI_API_MODELS = {
    STANDARD_MODEL: "veo-3.1-generate-preview",
    FAST_MODEL: "veo-3.1-fast-generate-preview",
    LITE_MODEL: "veo-3.1-lite-generate-preview",
}
# Graphs saved before 2026-10-14 store the preview IDs. retired_nodes migrates
# them on load; this covers any path that skips the migration.
LEGACY_MODELS = {preview: model for model, preview in GEMINI_API_MODELS.items()}
VERTEX_DEFAULT_MODEL = STANDARD_MODEL
MAX_FRAME_BYTES = 20_000_000
MAX_CLIP_BYTES = 100_000_000


def previews_retired(today: date | None = None) -> bool:
    return (today or date.today()) >= GEMINI_PREVIEWS_END


VERTEX_ONLY_MESSAGE = (
    "Google retired the Veo 3.1 previews on the Gemini API on 2026-10-22, so a GOOGLE_API_KEY "
    "can no longer run Veo. Add a Google Vertex AI service-account key (GOOGLE_VERTEX_CREDENTIALS) "
    "in Settings to run Veo 3.1 on Vertex."
)


def canonical_model(value: Any) -> str:
    """The node's Vertex model ID, mapping a saved Gemini API preview ID."""
    model = str(value or STANDARD_MODEL)
    return LEGACY_MODELS.get(model, model)


def with_vertex_hint(message: str, today: date | None = None) -> str:
    """After the previews end, point a failed Gemini API or fal run at Vertex."""
    if not previews_retired(today):
        return message
    return (
        f"{message} — Google retired the Veo 3.1 previews on 2026-10-22. Add a Google Vertex AI "
        "service-account key (GOOGLE_VERTEX_CREDENTIALS) in Settings to run Veo 3.1 on Vertex."
    )


def _log(msg: str) -> None:
    print(f"[veo] {msg}", file=sys.stderr, flush=True)


async def _cancel_veo_operation(op_name: str, api_key: str) -> None:
    """Best-effort upstream cancel via the standard google.longrunning Operations
    interface (POST {op_name}:cancel). The server may return UNIMPLEMENTED."""
    try:
        async with httpx.AsyncClient(timeout=15.0) as client:
            await client.post(
                f"https://generativelanguage.googleapis.com/v1beta/{op_name}:cancel",
                headers={"x-goog-api-key": api_key},
                json={},
            )
        _log(f"requested upstream cancel for {op_name}")
    except Exception:
        pass


async def _image_to_veo_payload(img_str: str) -> dict[str, Any]:
    """Convert an image path/URL/data URI to Veo's inline data format.

    A URL is fetched only from a public https host, so a graph can't make the
    backend read from this machine or a private network."""
    if img_str.startswith(("http://", "https://")):
        content, content_type = await fetch_public_media(img_str, label="Veo frame", max_bytes=MAX_FRAME_BYTES)
        mime_type = content_type.split(";")[0].strip()
        if mime_type not in {"image/png", "image/jpeg", "image/webp"}:
            mime_type = "image/png"
        return {"bytesBase64Encoded": base64.b64encode(content).decode("ascii"), "mimeType": mime_type}
    elif img_str.startswith("data:"):
        header, b64_data = img_str.split(",", 1)
        mime_type = header.split(":")[1].split(";")[0]
        return {"bytesBase64Encoded": b64_data, "mimeType": mime_type}
    else:
        img_path = Path(img_str)
        if img_path.exists():
            b64_data = base64.b64encode(
                read_local_media(img_path, label="Veo frame", max_bytes=MAX_FRAME_BYTES)[1]).decode("ascii")
            suffix = img_path.suffix.lstrip(".").lower()
            mime_map = {"png": "image/png", "jpg": "image/jpeg", "jpeg": "image/jpeg", "webp": "image/webp"}
            return {"bytesBase64Encoded": b64_data, "mimeType": mime_map.get(suffix, "image/png")}
    raise with_person_line(ValueError(f"Image not found: {img_str}"), missing_file_line("image file"))


# Veo video extension (https://ai.google.dev/gemini-api/docs/video) continues an existing
# Veo-generated clip. Works on the 3.1 generate + fast models (NOT 3.1-lite).
# NOTE: Veo's reference-image ("ingredients to video") mode is documented but the live Gemini
# API rejects it ("Your use case is currently not supported") on BOTH veo-3.1-generate-preview
# and veo-3.1-fast-generate-preview with an AI Studio GOOGLE_API_KEY (verified live 2026-06-08),
# so reference images are not exposed. Re-add a `referenceImages` instance field (bytesBase64Encoded
# shape, referenceType "asset") if/when Google enables the use case on the public API.
VEO_EXTEND_MODELS = {STANDARD_MODEL, FAST_MODEL}
# Vertex also extends with Lite, and doesn't lock the output to 720p
# (https://docs.cloud.google.com/gemini-enterprise-agent-platform/models/video/extend-videos,
# checked 2026-10-11).
VERTEX_EXTEND_MODELS = VEO_EXTEND_MODELS | {LITE_MODEL}
# Only Standard renders 4K on Vertex; Fast and Lite stop at 1080p
# (https://docs.cloud.google.com/gemini-enterprise-agent-platform/models/veo/3-1-generate,
# checked 2026-10-11). The Gemini API also renders Fast at 4K.
VERTEX_4K_MODELS = {STANDARD_MODEL}
# Vertex frames must be JPEG or PNG (VideoGenerationModelInstance.Image).
VERTEX_FRAME_TYPES = {"image/jpeg", "image/png"}


async def handle_veo(
    node: GraphNode,
    inputs: dict[str, PortValueDict],
    api_keys: dict[str, str],
    emit: Callable[[ExecutionEvent], Awaitable[None]] | None = None,
) -> dict[str, Any]:
    vertex_credentials = api_keys.get("GOOGLE_VERTEX_CREDENTIALS")
    api_key = api_keys.get("GOOGLE_API_KEY")
    if not vertex_credentials and not api_key:
        raise with_person_line(
            MissingCredentialError("Veo needs GOOGLE_VERTEX_CREDENTIALS (Vertex AI) or GOOGLE_API_KEY"),
            "Add your Google Vertex AI credentials or Gemini API key in Settings, then run the node again.")

    prompt_input = inputs.get("prompt")
    prompt_text = str(prompt_input.value) if prompt_input and prompt_input.value else ""

    model = canonical_model(node.params.get("model"))
    if model not in VEO_MODELS:
        # The model id is for agents; the card names the field.
        raise with_person_line(ValueError(f"'{model}' isn't a Veo 3.1 model"),
                               "Pick a Veo 3.1 model in the node's Model field, then run it again.")

    has_image = bool(inputs.get("image") and inputs["image"].value)
    has_last = bool(inputs.get("last_frame") and inputs["last_frame"].value)
    has_video = bool(inputs.get("video") and inputs["video"].value)

    # Capability + mutual-exclusion guards — run before any byte/network work so a
    # misconfigured node fails fast and cheaply (no generation spend).
    if has_video:
        if has_image or has_last:
            raise as_person_line(ValueError(
                "Veo video extension cannot be combined with a first or last frame"
            ))
        allowed = VERTEX_EXTEND_MODELS if vertex_credentials else VEO_EXTEND_MODELS
        if model not in allowed:
            raise with_person_line(
                ValueError(f"Video extension requires Veo 3.1 or 3.1 Fast (got '{model}')"),
                "Extending a video takes Veo 3.1 or Veo 3.1 Fast. Pick one in the node's Model field, "
                "or disconnect Extend Video.")

    if vertex_credentials:
        return await _handle_veo_vertex(
            node, inputs, vertex_credentials, model, prompt_text,
            has_image=has_image, has_last=has_last, has_video=has_video, emit=emit,
        )
    assert api_key is not None
    if previews_retired():
        # Checked before any request, so the run never reaches Google.
        raise MissingCredentialError(VERTEX_ONLY_MESSAGE)
    gemini_model = GEMINI_API_MODELS[model]

    instance: dict[str, Any] = {}
    if prompt_text:
        instance["prompt"] = prompt_text

    # First frame (image-to-video) — Vertex-style bytesBase64Encoded payload.
    if has_image:
        instance["image"] = await _image_to_veo_payload(str(inputs["image"].value))

    # Last frame (interpolation).
    if has_last:
        instance["lastFrame"] = await _image_to_veo_payload(str(inputs["last_frame"].value))

    # Video extension — continue an existing clip. Veo only accepts the SOURCE URI of a clip
    # it generated ("must be a video that was generated by VEO that has been processed" —
    # re-uploaded/external bytes are rejected, verified live 2026-06-08). So the input must be
    # a Gemini ``files/...`` URI; wire the upstream Veo node's "Source URI" output into this
    # node's "Extend Video" input.
    if has_video:
        video_ref = str(inputs["video"].value)
        if "generativelanguage.googleapis.com" in video_ref and "/files/" in video_ref:
            instance["video"] = {"uri": video_ref}
        else:
            raise as_person_line(ValueError(
                "Veo extension needs a Veo-generated clip's source URI (a Gemini files/... URI). "
                "Wire the upstream Veo node's 'Source URI' output into 'Extend Video' — Veo "
                "rejects re-uploaded or external video files."
            ))

    parameters = _veo_parameters(node.params)

    # Veo extension output is locked to 720p by the API — override any higher request.
    if has_video:
        parameters["resolution"] = "720p"

    request_body: dict[str, Any] = {
        "instances": [instance],
    }
    if parameters:
        request_body["parameters"] = parameters

    async def noop_emit(event: ExecutionEvent) -> None:
        pass

    _emit = emit or noop_emit

    _log(f"submitting to {gemini_model}")
    auth_headers = {
        "x-goog-api-key": api_key,
        "Content-Type": "application/json",
    }
    async with httpx.AsyncClient(timeout=120.0) as client:
        # Submit long-running operation
        url = f"{VEO_BASE_URL}/{gemini_model}:predictLongRunning"
        resp = await client.post(url, json=request_body, headers=auth_headers)
        _log(f"submit response: {resp.status_code}")
        if resp.status_code != 200:
            raise RuntimeError(with_vertex_hint(f"Veo submit failed ({resp.status_code}): {resp.text}"))

        op_data = resp.json()
        op_name = op_data.get("name")
        if not op_name:
            raise RuntimeError(f"Veo did not return operation name: {op_data}")

        _log(f"polling operation {op_name}")

        # Poll for completion
        poll_url = f"https://generativelanguage.googleapis.com/v1beta/{op_name}"
        max_polls = 300
        poll_interval = 3.0

        # If polling stops before the operation is done (a cancelled run, a
        # poll error that outlasted the retries, a timeout), fire a best-effort
        # upstream cancel on a detached task (this task's client is being torn
        # down), then re-raise (execution/poll_retry.py).
        with UpstreamTask(lambda: _cancel_veo_operation(op_name, api_key), schedule_detached_cancel) as upstream:
            return await _poll_veo_operation(
                client, node, poll_url, api_key, max_polls, poll_interval, _emit, upstream
            )


async def _poll_veo_operation(
    client: httpx.AsyncClient,
    node: GraphNode,
    poll_url: str,
    api_key: str,
    max_polls: int,
    poll_interval: float,
    _emit: Callable[[ExecutionEvent], Awaitable[None]],
    upstream: UpstreamTask | None = None,
) -> dict[str, Any]:
    for poll_num in range(1, max_polls + 1):
        await asyncio.sleep(poll_interval)

        poll_resp = await poll_request(lambda: client.get(poll_url, headers={"x-goog-api-key": api_key}))
        if poll_resp.status_code != 200:
            _log(f"poll FAILED: {poll_resp.status_code}")
            raise RuntimeError(with_vertex_hint(f"Veo poll failed ({poll_resp.status_code}): {poll_resp.text}"))

        poll_data = poll_resp.json()
        done = poll_data.get("done", False)

        progress = min(poll_num / max_polls, 0.99)
        await _emit(ProgressEvent(node_id=node.id, value=progress))

        if poll_num % 10 == 1:
            _log(f"poll #{poll_num}: done={done}")

        if done:
            if upstream is not None:
                upstream.finished = True
            response = poll_data.get("response", {})
            videos = response.get("generateVideoResponse", {}).get("generatedSamples", [])
            if not videos:
                # Try alternate response format
                videos = response.get("generatedVideos", [])

            if videos:
                video_info = videos[0]
                # Video might be a file reference or direct data
                video_uri = video_info.get("video", {}).get("uri", "")
                if video_uri:
                    # Download the video
                    _log(f"downloading video from {video_uri[:80]}...")
                    run_dir = get_run_dir()
                    filename = f"{uuid4().hex[:12]}.mp4"
                    file_path = run_dir / filename
                    dl_resp = await client.get(
                        video_uri,
                        headers={"x-goog-api-key": api_key},
                        timeout=120.0,
                        follow_redirects=True,
                    )
                    dl_resp.raise_for_status()
                    file_path.write_bytes(dl_resp.content)
                    _log(f"saved to {file_path}")
                    # Expose the Veo source URI so a downstream Veo node can extend this
                    # clip (extension only accepts a Veo-generated files/... URI, not the
                    # downloaded file). The URI is valid for ~2 days.
                    return {
                        "video": {"type": "Video", "value": str(file_path)},
                        "source_uri": {"type": "Video", "value": video_uri},
                    }

            # Fallback: check for error
            error = poll_data.get("error")
            if error:
                raise RuntimeError(f"Veo failed: {error}")

            raise RuntimeError(f"Veo completed but no video found: {list(poll_data.keys())}")

    _log("TIMED OUT")
    raise RuntimeError(f"Veo timed out after {max_polls} polls")


# -- Vertex AI ---------------------------------------------------------------
# predictLongRunning + fetchPredictOperation on us-central1
# (https://cloud.google.com/vertex-ai/generative-ai/docs/model-reference/veo-video-generation,
# checked 2026-10-10). No storageUri is sent, so videos come back inline.


async def _cancel_vertex_operation(op_name: str, credentials: str) -> None:
    try:
        token, _project = await access_token(credentials)
        async with httpx.AsyncClient(timeout=15.0) as client:
            await client.post(
                f"https://{VERTEX_REGION}-aiplatform.googleapis.com/v1/{op_name}:cancel",
                headers={"Authorization": f"Bearer {token}"},
                json={},
            )
        _log(f"requested upstream cancel for {op_name}")
    except Exception:
        pass


def _vertex_frame(payload: dict[str, Any]) -> dict[str, Any]:
    """A frame Vertex accepts: JPEG and PNG pass through, anything else becomes PNG."""
    if payload.get("mimeType") in VERTEX_FRAME_TYPES:
        return payload
    from PIL import Image, UnidentifiedImageError

    try:
        with Image.open(io.BytesIO(base64.b64decode(payload["bytesBase64Encoded"]))) as image:
            out = io.BytesIO()
            image.convert("RGBA" if image.mode in ("RGBA", "LA", "P") else "RGB").save(out, format="PNG")
    except (UnidentifiedImageError, ValueError, OSError):
        raise with_person_line(
            ValueError(f"Vertex needs a JPEG or PNG frame and couldn't convert a {payload.get('mimeType')} image"),
            "Vertex AI takes JPEG or PNG frames, and Nebula couldn't convert this one. Connect a JPEG or PNG image.") from None
    return {"bytesBase64Encoded": base64.b64encode(out.getvalue()).decode("ascii"), "mimeType": "image/png"}


async def _vertex_video_payload(value: str) -> dict[str, Any]:
    """A clip to extend: a gs:// URI, a public https MP4, or a file saved here.

    Vertex extends any 1–30 s, 24 fps MP4, not only clips Veo made."""
    if value.startswith("gs://"):
        return {"gcsUri": value, "mimeType": "video/mp4"}
    if "generativelanguage.googleapis.com" in value:
        raise as_person_line(ValueError(
            "Vertex can't read a Gemini API file URI. Wire the upstream node's 'Video' output "
            "(the saved clip) into 'Extend Video' instead."
        ))
    if value.startswith(("http://", "https://")):
        data, _type = await fetch_public_media(value, label="Veo clip", max_bytes=MAX_CLIP_BYTES)
    elif value.startswith("data:"):
        raise as_person_line(ValueError("Extend Video needs a file, a gs:// URI or an https URL"))
    else:
        path = Path(value)
        if not path.exists():
            raise with_person_line(ValueError(f"Video not found: {value}"), missing_file_line("video file"))
        data = read_local_media(path, label="Veo clip", max_bytes=MAX_CLIP_BYTES)[1]
    return {"bytesBase64Encoded": base64.b64encode(data).decode("ascii"), "mimeType": "video/mp4"}


async def run_vertex_veo(
    node: GraphNode,
    credentials: str,
    model: str,
    instance: dict[str, Any],
    parameters: dict[str, Any],
    emit: Callable[[ExecutionEvent], Awaitable[None]] | None = None,
) -> dict[str, Any]:
    """Submit one Veo request to Vertex, wait for it, and save the video."""
    async def noop_emit(event: ExecutionEvent) -> None:
        pass

    _emit = emit or noop_emit
    token, project_id = await access_token(credentials)
    headers = {"Authorization": f"Bearer {token}", "Content-Type": "application/json"}
    body = {"instances": [instance], "parameters": {**parameters, "sampleCount": 1}}
    _log(f"submitting to Vertex {model}")
    async with httpx.AsyncClient(timeout=120.0) as client:
        resp = await client.post(model_url(project_id, model, "predictLongRunning"), json=body, headers=headers)
        if resp.status_code != 200:
            raise RuntimeError(f"Veo (Vertex) submit failed ({resp.status_code}): {resp.text}")
        op_name = resp.json().get("name")
        if not op_name:
            raise RuntimeError(f"Veo (Vertex) did not return an operation name: {resp.text[:300]}")
        with UpstreamTask(lambda: _cancel_vertex_operation(op_name, credentials), schedule_detached_cancel) as upstream:
            return await _poll_vertex_operation(
                client, node, project_id, model, op_name, headers, _emit, upstream=upstream,
            )


async def _poll_vertex_operation(
    client: httpx.AsyncClient,
    node: GraphNode,
    project_id: str,
    model: str,
    op_name: str,
    headers: dict[str, str],
    _emit: Callable[[ExecutionEvent], Awaitable[None]],
    max_polls: int = 300,
    poll_interval: float = 3.0,
    upstream: UpstreamTask | None = None,
) -> dict[str, Any]:
    poll_url = model_url(project_id, model, "fetchPredictOperation")
    for poll_num in range(1, max_polls + 1):
        await asyncio.sleep(poll_interval)
        poll_resp = await poll_request(
            lambda: client.post(poll_url, json={"operationName": op_name}, headers=headers))
        if poll_resp.status_code != 200:
            raise RuntimeError(f"Veo (Vertex) poll failed ({poll_resp.status_code}): {poll_resp.text}")
        data = poll_resp.json()
        await _emit(ProgressEvent(node_id=node.id, value=min(poll_num / max_polls, 0.99)))
        if not data.get("done"):
            continue
        if upstream is not None:
            upstream.finished = True
        if data.get("error"):
            raise RuntimeError(f"Veo (Vertex) failed: {data['error']}")
        response = data.get("response") or {}
        videos = response.get("videos") or []
        if not videos:
            filtered = response.get("raiMediaFilteredReasons") or []
            if filtered:
                raise RuntimeError(f"Veo (Vertex) filtered the video: {'; '.join(map(str, filtered))}")
            raise RuntimeError(f"Veo (Vertex) completed but returned no video: {list(response.keys())}")
        video = videos[0]
        file_path = get_run_dir() / f"{uuid4().hex[:12]}.mp4"
        gcs_uri = video.get("gcsUri")
        if video.get("bytesBase64Encoded"):
            file_path.write_bytes(base64.b64decode(video["bytesBase64Encoded"]))
        elif isinstance(gcs_uri, str) and gcs_uri.startswith("gs://"):
            bucket, _, obj = gcs_uri[len("gs://"):].partition("/")
            dl = await client.get(
                f"https://storage.googleapis.com/storage/v1/b/{quote(bucket, safe='')}/o/{quote(obj, safe='')}?alt=media",
                headers={"Authorization": headers["Authorization"]},
                timeout=180.0,
            )
            dl.raise_for_status()
            file_path.write_bytes(dl.content)
        else:
            raise RuntimeError("Veo (Vertex) returned a video with no data")
        _log(f"saved to {file_path}")
        # Vertex can extend a clip from its bytes, so the saved file is the
        # source to wire into a downstream Veo node's "Extend Video".
        return {
            "video": {"type": "Video", "value": str(file_path)},
            "source_uri": {"type": "Video", "value": gcs_uri or str(file_path)},
        }
    raise RuntimeError(f"Veo (Vertex) timed out after {max_polls} polls")


def _veo_parameters(params: dict[str, Any]) -> dict[str, Any]:
    parameters: dict[str, Any] = {}
    if params.get("aspectRatio"):
        parameters["aspectRatio"] = str(params["aspectRatio"])
    if params.get("duration"):
        parameters["durationSeconds"] = int(str(params["duration"]).replace("s", ""))
    if params.get("resolution"):
        parameters["resolution"] = str(params["resolution"])
    if params.get("personGeneration"):
        parameters["personGeneration"] = str(params["personGeneration"])
    seed = params.get("seed")
    if seed is not None and seed != "":
        parameters["seed"] = int(seed)
    return parameters


async def _handle_veo_vertex(
    node: GraphNode,
    inputs: dict[str, PortValueDict],
    credentials: str,
    model: str,
    prompt_text: str,
    *,
    has_image: bool,
    has_last: bool,
    has_video: bool,
    emit: Callable[[ExecutionEvent], Awaitable[None]] | None,
) -> dict[str, Any]:
    vertex_model = model
    # Lite's model card is contradictory about frames (modalities say no image
    # input, capabilities list image-to-video), so they're sent and Google decides.
    if str(node.params.get("resolution")) == "4k" and model not in VERTEX_4K_MODELS:
        raise as_person_line(ValueError("On Vertex only Veo 3.1 (Standard) renders 4K; pick 1080p or Veo 3.1"))
    instance: dict[str, Any] = {}
    if prompt_text:
        instance["prompt"] = prompt_text
    if has_image:
        instance["image"] = _vertex_frame(await _image_to_veo_payload(str(inputs["image"].value)))
    if has_last:
        instance["lastFrame"] = _vertex_frame(await _image_to_veo_payload(str(inputs["last_frame"].value)))
    if has_video:
        instance["video"] = await _vertex_video_payload(str(inputs["video"].value))
    parameters = _veo_parameters(node.params)
    parameters["generateAudio"] = True
    return await run_vertex_veo(node, credentials, vertex_model, instance, parameters, emit)


async def handle_veo_flf_vertex(
    node: GraphNode,
    inputs: dict[str, PortValueDict],
    api_keys: dict[str, str],
    emit: Callable[[ExecutionEvent], Awaitable[None]] | None = None,
) -> dict[str, Any]:
    """Veo 3.1 First-Last Frame on Vertex. The node's params are fal-shaped
    (``aspect_ratio``, ``"8s"``, ``generate_audio``), so they're mapped here."""
    credentials = api_keys.get("GOOGLE_VERTEX_CREDENTIALS")
    if not credentials:
        raise MissingCredentialError("GOOGLE_VERTEX_CREDENTIALS is required")
    first, last = inputs.get("image"), inputs.get("end_image")
    if not (first and first.value and last and last.value):
        raise as_person_line(ValueError("Veo First-Last Frame needs both a first and a last frame"))
    prompt = inputs.get("prompt")
    instance: dict[str, Any] = {
        "image": _vertex_frame(await _image_to_veo_payload(str(first.value))),
        "lastFrame": _vertex_frame(await _image_to_veo_payload(str(last.value))),
    }
    if prompt and prompt.value:
        instance["prompt"] = str(prompt.value)
    params = node.params
    parameters = _veo_parameters({
        "aspectRatio": params.get("aspect_ratio") if params.get("aspect_ratio") != "auto" else None,
        "duration": params.get("duration"),
        "resolution": params.get("resolution"),
        "seed": params.get("seed"),
    })
    parameters["generateAudio"] = params.get("generate_audio") is not False
    if params.get("negative_prompt"):
        parameters["negativePrompt"] = str(params["negative_prompt"])
    return await run_vertex_veo(node, credentials, VERTEX_DEFAULT_MODEL, instance, parameters, emit)


# -- fal ---------------------------------------------------------------------

FAL_VEO_PARAMS = ("negative_prompt", "seed", "safety_tolerance")


def fal_veo_route(
    node: GraphNode, inputs: dict[str, PortValueDict],
) -> tuple[GraphNode, dict[str, PortValueDict]]:
    """The fal-ai/veo3.1 endpoint, params and inputs for a veo-3 node.

    fal names params differently from Google (``aspect_ratio``, ``"8s"``) and
    splits Veo 3.1 into text-, image- and first-last-frame endpoints. Lite
    isn't on fal, so it runs as Fast, the nearest price."""
    if inputs.get("video") and inputs["video"].value:
        raise as_person_line(ValueError("Extending a clip needs the Google route: add a Vertex or Gemini API key in Settings"))
    params = node.params
    fast = canonical_model(params.get("model")) in (FAST_MODEL, LITE_MODEL)
    base = "fal-ai/veo3.1/fast" if fast else "fal-ai/veo3.1"
    fal_params: dict[str, Any] = {k: params[k] for k in FAL_VEO_PARAMS if params.get(k) not in (None, "")}
    if params.get("aspectRatio"):
        fal_params["aspect_ratio"] = str(params["aspectRatio"])
    if params.get("duration"):
        fal_params["duration"] = f"{int(str(params['duration']).replace('s', ''))}s"
    if params.get("resolution"):
        fal_params["resolution"] = str(params["resolution"])

    from handlers.fal_universal import _to_fal_url

    image, last = inputs.get("image"), inputs.get("last_frame")
    routed_inputs = {k: v for k, v in inputs.items() if k not in ("image", "last_frame")}
    if image and image.value and last and last.value:
        endpoint = f"{base}/first-last-frame-to-video"
        fal_params["first_frame_url"] = _to_fal_url(str(image.value))
        fal_params["last_frame_url"] = _to_fal_url(str(last.value))
    elif last and last.value:
        raise as_person_line(ValueError("A last frame needs a first frame too"))
    elif image and image.value:
        endpoint = f"{base}/image-to-video"
        fal_params["image_url"] = _to_fal_url(str(image.value))
    else:
        endpoint = base
    fal_params["endpoint_id"] = endpoint
    return node.model_copy(update={"params": fal_params}), routed_inputs
