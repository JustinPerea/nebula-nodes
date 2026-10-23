"""OpenRouter's media APIs: images (``POST /api/v1/images``) and videos
(``POST /api/v1/videos``, then poll and download).

The route-table clients ``openrouter-images`` and ``openrouter-videos``
(execution/route_clients.py). handlers/openrouter.py stays the chat client.

Vendor facts, read on 2026-10-15 from openrouter.ai/docs/features/multimodal/
image-generation.md and video-generation.md, the per-model endpoint records
(GET /api/v1/images/models/{model}/endpoints, GET /api/v1/videos/models) and
the Python SDK's VideoGeneration reference
(openrouter.ai/docs/client-sdks/python/sdks/videogeneration/README.md):

- Auth: ``Authorization: Bearer <OPENROUTER_API_KEY>``.
- Images: the body takes ``model``, ``prompt``, ``n``, ``resolution``,
  ``aspect_ratio``, ``size``, ``quality``, ``output_format``, ``background``,
  ``output_compression``, ``seed``, ``user`` and ``input_references``
  (``[{type: "image_url", image_url: {url}}]``, "HTTP(S) URLs or base64 data
  URLs"). Anything else is provider-specific and goes under
  ``provider.options[<provider slug>]``, limited to the endpoint's
  ``allowed_passthrough_parameters`` (FLUX 3: ``safety_tolerance``).
  The answer is ``{data: [{b64_json, media_type}], usage: {cost}}``. Billing
  is "all-or-nothing": a generation that doesn't finish answers 502 and
  isn't billed.
- Videos: the body takes ``model``, ``prompt``, ``duration``,
  ``resolution``, ``aspect_ratio``, ``size``, ``frame_images`` (entries
  ``{type: "image_url", image_url: {url}, frame_type: "first_frame" |
  "last_frame"}``; only https URLs are shown, and unlike ``/images`` no
  data URL is mentioned, so route_clients.py sends frames only as public
  http(s) URLs), ``input_references``, ``generate_audio``, ``seed`` and
  ``provider``. Submit answers 202 ``{id, polling_url, status}``; poll
  ``GET /api/v1/videos/{id}`` until ``completed``, then download
  ``unsigned_urls[0]`` "with your API key in the Authorization header".
  Statuses: ``pending``, ``in_progress``, ``completed``, ``failed`` (and
  ``cancelled``, ``expired`` in the webhook events).
- Not used: a source *video*. The documented ways in are
  ``previous_job_id`` (a completed OpenRouter job) and video entries in
  ``input_references``, whose shape isn't documented, so a wired video is
  refused before any request (route_clients.py).
- OpenRouter documents no way to cancel a video job: a stopped run stops
  polling, and the job may still finish and bill.
"""
from __future__ import annotations

import asyncio
import logging
from typing import Any, Awaitable, Callable
from urllib.parse import quote, urlsplit

import httpx

from execution.missing_credential import MissingCredentialError
from models.events import ExecutionEvent, ProgressEvent
from execution.person_line import with_person_line

OPENROUTER_KEY = "OPENROUTER_API_KEY"
OPENROUTER_API_BASE = "https://openrouter.ai/api/v1"
IMAGES_URL = f"{OPENROUTER_API_BASE}/images"
VIDEOS_URL = f"{OPENROUTER_API_BASE}/videos"
# The request fields each API documents; every other route param is the
# provider's own and goes under provider.options[slug].
IMAGE_FIELDS = frozenset({"n", "resolution", "aspect_ratio", "size", "quality", "output_format", "background",
                          "output_compression", "seed", "user"})
VIDEO_FIELDS = frozenset({"duration", "resolution", "aspect_ratio", "size", "generate_audio", "seed", "user"})
_TIMEOUT = httpx.Timeout(300.0, connect=30.0)
VIDEO_POLL_INTERVAL = 5.0
VIDEO_POLL_TIMEOUT = 3600.0
_VIDEO_PENDING = frozenset({"pending", "in_progress", "queued", "processing"})
_VIDEO_FAILED = frozenset({"failed", "cancelled", "canceled", "expired"})
_EXTENSIONS = {"image/png": "png", "image/jpeg": "jpg", "image/jpg": "jpg", "image/webp": "webp"}


def api_key(api_keys: dict[str, str]) -> str:
    key = (api_keys.get(OPENROUTER_KEY) or "").strip()
    if not key:
        raise MissingCredentialError(f"{OPENROUTER_KEY} is required")
    return key


def _headers(key: str) -> dict[str, str]:
    return {"Authorization": f"Bearer {key}", "Content-Type": "application/json"}


def provider_slug(model: str) -> str:
    """The provider slug a model's passthrough options are keyed by. FLUX on
    OpenRouter is served only by Black Forest Labs, slug ``black-forest-labs``,
    the model's own owner prefix; a route whose model is served under another
    slug needs its own entry here."""
    return str(model).split("/", 1)[0]


def request_body(model: str, prompt: str, params: dict[str, Any], fields: frozenset[str]) -> dict[str, Any]:
    """``model``, ``prompt`` and the documented fields at the top; the rest
    under ``provider.options[slug]``. Unset values are left out."""
    body: dict[str, Any] = {"model": model, "prompt": prompt}
    passthrough: dict[str, Any] = {}
    for key, value in params.items():
        if value is None or value == "":
            continue
        (body if key in fields else passthrough)[key] = value
    if passthrough:
        body["provider"] = {"options": {provider_slug(model): passthrough}}
    return body


def image_url(url: str) -> dict[str, Any]:
    return {"type": "image_url", "image_url": {"url": url}}


def _error(response: httpx.Response, what: str) -> RuntimeError:
    try:
        body = response.json()
    except ValueError:
        body = None
    error = body.get("error") if isinstance(body, dict) else None
    said = str((error.get("message") if isinstance(error, dict) else error) or response.text.strip())[:400]
    status = response.status_code
    if status == 401:
        return RuntimeError(f"OpenRouter rejected the API key ({status}): check {OPENROUTER_KEY} in Settings.")
    if status == 402:
        return RuntimeError(f"OpenRouter credits ran out ({status}: {said}). Add credits at openrouter.ai/settings/credits, "
                            "then run again.")
    if status == 429:
        return RuntimeError(f"OpenRouter is rate-limiting this key ({status}: {said}). Wait a moment, then run again.")
    if status == 502:
        return RuntimeError(f"OpenRouter's provider didn't finish the {what} ({status}: {said}). It wasn't billed; run again.")
    return RuntimeError(f"OpenRouter {what} failed ({status}): {said or 'no detail'}")


async def _post(client: httpx.AsyncClient, url: str, key: str, body: dict[str, Any], what: str) -> dict[str, Any]:
    try:
        response = await client.post(url, headers=_headers(key), json=body)
    except httpx.TransportError as exc:
        raise RuntimeError(f"Couldn't reach OpenRouter to start the {what}: {type(exc).__name__}: {exc}") from exc
    if response.status_code not in (200, 201, 202):
        raise _error(response, what)
    try:
        data = response.json()
    except ValueError as exc:
        raise RuntimeError(f"OpenRouter returned non-JSON for the {what} ({response.status_code})") from exc
    if not isinstance(data, dict):
        raise RuntimeError(f"OpenRouter returned an unexpected {what} answer")
    return data


async def generate_image(key: str, body: dict[str, Any]) -> str:
    """POST one image request and save the first image; returns its path."""
    from services.output import get_run_dir, save_base64_image

    async with httpx.AsyncClient(timeout=_TIMEOUT) as client:
        data = await _post(client, IMAGES_URL, key, body, "image")
    images = data.get("data") if isinstance(data.get("data"), list) else []
    first = images[0] if images and isinstance(images[0], dict) else {}
    b64 = first.get("b64_json")
    if not isinstance(b64, str) or not b64:
        raise RuntimeError("OpenRouter finished the image but returned no image data")
    extension = _EXTENSIONS.get(str(first.get("media_type") or "").lower(), "png")
    path = save_base64_image(b64, get_run_dir(), extension)
    logging.getLogger(__name__).info("OpenRouter image %s: usage cost %s", body.get("model"),
                                     (data.get("usage") or {}).get("cost"))
    return str(path)


async def _download(client: httpx.AsyncClient, key: str, url: Any) -> str:
    from services.output import get_run_dir, write_media_bytes

    if not isinstance(url, str) or not url.startswith("https://"):
        raise RuntimeError("OpenRouter reported the video completed but returned no download URL")
    try:
        host = (urlsplit(url).hostname or "").lower()
    except ValueError:
        host = ""
    # The content endpoint needs the key; any other host never gets it.
    headers = {"Authorization": f"Bearer {key}"} if host == "openrouter.ai" else {}
    try:
        response = await client.get(url, headers=headers, follow_redirects=True)
    except httpx.TransportError as exc:
        raise RuntimeError(f"Couldn't download OpenRouter's video: {type(exc).__name__}: {exc}") from exc
    if response.status_code >= 400:
        raise with_person_line(
            RuntimeError(f"OpenRouter's video download failed (HTTP {response.status_code}). Run again."),
            "OpenRouter's video couldn't be downloaded. Run the node again.")
    path = await write_media_bytes(response.content, response.headers.get("content-type", ""), "Video",
                                   get_run_dir(), url)
    return str(path)


async def generate_video(
    key: str, body: dict[str, Any], *, node_id: str = "",
    emit: Callable[[ExecutionEvent], Awaitable[None]] | None = None,
    poll_interval: float | None = None, timeout: float | None = None,
) -> str:
    """Submit a video job, poll it to ``completed`` and save the video."""
    from execution.poll_retry import poll_request

    interval = VIDEO_POLL_INTERVAL if poll_interval is None else poll_interval
    limit = VIDEO_POLL_TIMEOUT if timeout is None else timeout
    async with httpx.AsyncClient(timeout=_TIMEOUT) as client:
        submitted = await _post(client, VIDEOS_URL, key, body, "video")
        job_id = str(submitted.get("id") or "")
        if not job_id:
            raise RuntimeError("OpenRouter accepted the video but returned no job id")
        # Polled at the documented path, never at a URL from the answer, so
        # the key only goes to openrouter.ai.
        poll_url = f"{VIDEOS_URL}/{quote(job_id, safe='')}"
        loop = asyncio.get_running_loop()
        started = loop.time()
        polls = 0
        while True:
            await asyncio.sleep(interval)
            try:
                response = await poll_request(lambda: client.get(poll_url, headers=_headers(key)))
            except httpx.TransportError as exc:
                raise RuntimeError(f"Couldn't reach OpenRouter to check video {job_id}: {type(exc).__name__}: {exc}") from exc
            if response.status_code != 200:
                raise _error(response, "video status check")
            job = response.json()
            status = str(job.get("status") or "").lower()
            polls += 1
            if status == "completed":
                urls = job.get("unsigned_urls") if isinstance(job.get("unsigned_urls"), list) else []
                saved = await _download(client, key, urls[0] if urls else None)
                logging.getLogger(__name__).info("OpenRouter video %s job %s: usage cost %s", body.get("model"),
                                                 job_id, (job.get("usage") or {}).get("cost"))
                return saved
            if status in _VIDEO_FAILED:
                raise RuntimeError(f"OpenRouter video {status}: {job.get('error') or 'no reason given'}")
            if status not in _VIDEO_PENDING:
                logging.getLogger(__name__).warning("OpenRouter video %s: unknown status %r, still polling", job_id, status)
            if emit is not None:
                await emit(ProgressEvent(node_id=node_id, value=min(0.95, polls / (polls + 20))))
            if loop.time() - started > limit:
                raise with_person_line(RuntimeError(
                    f"OpenRouter video {job_id} was still {status or 'pending'} after {int(limit // 60)} minutes; "
                    "Nebula stopped waiting. OpenRouter has no cancel for video jobs, so it may still finish and bill."),
                    f"OpenRouter didn't finish this video in {int(limit // 60)} minutes, so Nebula stopped waiting. OpenRouter can't cancel video jobs, so it may still finish and be billed there.")
