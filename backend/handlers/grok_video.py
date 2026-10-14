"""Grok Imagine video on xAI's own API (XAI_API_KEY).

xAI's videos REST reference (https://docs.x.ai/developers/rest-api-reference/inference/videos,
checked 2026-10-14):

- POST /v1/videos/generations: ``model``, ``prompt`` ("Required for
  text-to-video (T2V) and reference-to-video (R2V). Optional for
  image-to-video"), ``duration`` ("Range: [1, 15]. Default: 8"),
  ``aspect_ratio``, ``resolution`` ("480p" | "720p" | "1080p"), ``image``
  (an object: "`url` (string) - Public URL or base64-encoded data URL of the
  image"), ``reference_images`` (array of the same objects).
- POST /v1/videos/edits: ``model``, ``prompt`` (required), ``video`` {url}.
- All return ``request_id``; poll GET /v1/videos/{request_id} until
  ``status`` is "done" (``video.url``) or "failed" (``error.message``).

``handle_grok_video`` runs the grok-imagine-video node. ``run_xai_video`` is
the shared submit-and-poll used by it and by the Krea Grok copies' direct
route (execution/maker_routes_xai.py).
"""
from __future__ import annotations

import asyncio
import sys
from typing import Any, Awaitable, Callable
from uuid import uuid4

import httpx

from execution.missing_credential import MissingCredentialError
from handlers.xai_image import XAI_API_BASE, xai_image_url
from models.events import ExecutionEvent, ProgressEvent
from models.graph import GraphNode, PortValueDict
from services.output import get_run_dir

# Canonical xAI model id for the grok-imagine-video node
# (https://docs.x.ai/developers/models/grok-imagine-video: "Model name: `grok-imagine-video`").
DEFAULT_MODEL = "grok-imagine-video"
ENDPOINTS = {
    "generations": f"{XAI_API_BASE}/videos/generations",
    "edits": f"{XAI_API_BASE}/videos/edits",
}
POLL_INTERVAL = 3.0
MAX_POLLS = 300

Emit = Callable[[ExecutionEvent], Awaitable[None]]


def _log(msg: str) -> None:
    print(f"[grok] {msg}", file=sys.stderr, flush=True)


async def run_xai_video(
    *,
    node_id: str,
    api_key: str,
    endpoint: str,
    body: dict[str, Any],
    emit: Emit | None = None,
) -> str:
    """Submit one xAI video request (``endpoint`` is a key of ENDPOINTS),
    poll it, save the clip, and return its local path."""
    if endpoint not in ENDPOINTS:
        raise ValueError(f"Unknown xAI video endpoint {endpoint!r}")
    headers = {"Authorization": f"Bearer {api_key}", "Content-Type": "application/json"}

    async def noop_emit(event: ExecutionEvent) -> None:
        pass
    _emit = emit or noop_emit

    _log(f"submitting video {endpoint} ({body.get('model')})")
    async with httpx.AsyncClient(timeout=120.0) as client:
        resp = await client.post(ENDPOINTS[endpoint], headers=headers, json=body)
        _log(f"submit response: {resp.status_code}")
        if resp.status_code not in (200, 201, 202):
            raise RuntimeError(f"Grok submit failed ({resp.status_code}): {resp.text}")

        result = resp.json()
        gen_id = result.get("request_id")
        if not gen_id:
            raise RuntimeError(f"Grok returned unexpected response: {result}")

        _log(f"polling generation {gen_id}")
        # xAI exposes no documented cancel endpoint: a cancel stops here only
        # (CancelledError propagates at the awaits; the upstream job runs on).
        for poll_num in range(1, MAX_POLLS + 1):
            await asyncio.sleep(POLL_INTERVAL)
            poll_resp = await client.get(f"{XAI_API_BASE}/videos/{gen_id}", headers=headers)
            if poll_resp.status_code not in (200, 202):
                raise RuntimeError(f"Grok poll failed ({poll_resp.status_code}): {poll_resp.text}")

            poll_data = poll_resp.json()
            status = poll_data.get("status", "")
            await _emit(ProgressEvent(node_id=node_id, value=min(poll_num / MAX_POLLS, 0.99)))

            if status == "done":
                video = poll_data.get("video") or {}
                video_url = video.get("url") or ""
                if video_url:
                    file_path = get_run_dir() / f"{uuid4().hex[:12]}.mp4"
                    dl = await client.get(video_url, timeout=120.0)
                    dl.raise_for_status()
                    file_path.write_bytes(dl.content)
                    _log(f"saved to {file_path}")
                    return str(file_path)
                if video.get("respect_moderation") is False:
                    # xAI: "Otherwise the field will be false and the video url field will be empty."
                    raise RuntimeError("Grok filtered this video for moderation; no video was returned")
                raise RuntimeError(f"Grok completed but no video URL: {poll_data}")
            if status in ("failed", "expired"):
                err = poll_data.get("error") or {}
                raise RuntimeError(f"Grok failed: {err.get('message', status)}")

        raise RuntimeError("Grok timed out")


async def handle_grok_video(
    node: GraphNode,
    inputs: dict[str, PortValueDict],
    api_keys: dict[str, str],
    emit: Emit | None = None,
) -> dict[str, Any]:
    api_key = (api_keys.get("XAI_API_KEY") or "").strip()
    if not api_key:
        raise MissingCredentialError("XAI_API_KEY is required")

    prompt_input = inputs.get("prompt")
    if not prompt_input or not prompt_input.value:
        raise ValueError("Prompt is required")

    body: dict[str, Any] = {"model": DEFAULT_MODEL, "prompt": str(prompt_input.value)}
    duration = node.params.get("duration")
    if duration is not None:
        body["duration"] = int(duration)
    aspect = node.params.get("aspect_ratio")
    if aspect:
        body["aspect_ratio"] = str(aspect)
    resolution = node.params.get("resolution")
    if resolution:
        body["resolution"] = str(resolution)

    # Image-to-video: xAI's `image` is an object {"url": ...} (a public URL or
    # a base64 data URL). A local file is sent as a data URL; a missing or
    # unreadable one fails the node (services.image_input) instead of making
    # a video that silently ignored the wired start frame.
    image_input = inputs.get("image")
    if image_input and image_input.value:
        body["image"] = {"url": xai_image_url(image_input.value)}

    path = await run_xai_video(node_id=node.id, api_key=api_key, endpoint="generations", body=body, emit=emit)
    return {"video": {"type": "Video", "value": path}}
