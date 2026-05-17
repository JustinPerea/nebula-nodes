from __future__ import annotations

import asyncio
import sys
from typing import Any, Awaitable, Callable
from uuid import uuid4

import httpx

from models.graph import GraphNode, PortValueDict
from models.events import ExecutionEvent, ProgressEvent
from services.output import get_run_dir


def _log(msg: str) -> None:
    print(f"[higgsfield] {msg}", file=sys.stderr, flush=True)


HIGGSFIELD_BASE = "https://platform.higgsfield.ai"

# Model ID → platform path mapping.
# Paths sourced from https://docs.higgsfield.ai/docs/guides/video.md (2026-05-16).
# Higgsfield native (DoP) model also supports text-to-video; others are I2V.
_MODEL_PATHS: dict[str, str] = {
    "higgsfield-ai/dop/standard": "higgsfield-ai/dop/standard",
    "higgsfield-ai/dop/preview": "higgsfield-ai/dop/preview",
    "kling-video/v2.1/pro/image-to-video": "kling-video/v2.1/pro/image-to-video",
    "bytedance/seedance/v1/pro/image-to-video": "bytedance/seedance/v1/pro/image-to-video",
}
_DEFAULT_MODEL = "higgsfield-ai/dop/standard"


async def handle_higgsfield(
    node: GraphNode,
    inputs: dict[str, PortValueDict],
    api_keys: dict[str, str],
    emit: Callable[[ExecutionEvent], Awaitable[None]] | None = None,
) -> dict[str, Any]:
    api_key = api_keys.get("HIGGSFIELD_API_KEY")
    if not api_key:
        raise ValueError("HIGGSFIELD_API_KEY is required")

    prompt_input = inputs.get("prompt")
    if not prompt_input or not prompt_input.value:
        raise ValueError("Prompt is required")

    # Higgsfield auth: "Key {api_key}" (single-key form — key:secret pairs also accepted
    # but HIGGSFIELD_API_KEY stores the combined credential or the key alone).
    headers = {
        "Authorization": f"Key {api_key}",
        "Content-Type": "application/json",
        "Accept": "application/json",
    }

    model_id = node.params.get("model", _DEFAULT_MODEL)
    if model_id not in _MODEL_PATHS:
        raise ValueError(
            f"Unknown Higgsfield model: {model_id!r}. Known models: {sorted(_MODEL_PATHS)}"
        )

    body: dict[str, Any] = {
        "prompt": str(prompt_input.value),
    }

    duration = node.params.get("duration")
    if duration is not None:
        body["duration"] = int(duration)

    aspect = node.params.get("aspect_ratio")
    if aspect:
        body["aspect_ratio"] = str(aspect)

    # Optional image input for image-to-video models
    image_input = inputs.get("image")
    if image_input and image_input.value:
        img_str = str(image_input.value)
        if img_str.startswith(("http://", "https://")):
            body["image_url"] = img_str

    async def noop_emit(event: ExecutionEvent) -> None:
        pass
    _emit = emit or noop_emit

    # Endpoint is model-specific: POST {base}/{model_id}
    submit_url = f"{HIGGSFIELD_BASE}/{model_id}"
    _log(f"submitting to {submit_url}")
    async with httpx.AsyncClient(timeout=120.0) as client:
        resp = await client.post(
            submit_url,
            headers=headers,
            json=body,
        )
        _log(f"submit response: {resp.status_code}")
        if resp.status_code not in (200, 201, 202):
            raise RuntimeError(f"Higgsfield submit failed ({resp.status_code}): {resp.text}")

        result = resp.json()
        # Submission returns {"request_id": "...", "status": "queued", ...}
        gen_id = result.get("request_id")
        if not gen_id:
            raise RuntimeError(f"Higgsfield returned unexpected response: {result}")

        _log(f"polling request {gen_id}")
        max_polls = 300
        for poll_num in range(1, max_polls + 1):
            await asyncio.sleep(3.0)
            poll_resp = await client.get(
                f"{HIGGSFIELD_BASE}/requests/{gen_id}/status",
                headers=headers,
            )
            if poll_resp.status_code != 200:
                raise RuntimeError(f"Higgsfield poll failed ({poll_resp.status_code}): {poll_resp.text}")

            poll_data = poll_resp.json()
            status = poll_data.get("status", "")

            await _emit(ProgressEvent(node_id=node.id, value=min(poll_num / max_polls, 0.99)))

            if status == "completed":
                # Completed response: {"status": "completed", "video": {"url": "..."}}
                video_url = poll_data.get("video", {}).get("url", "")
                if video_url:
                    run_dir = get_run_dir()
                    filename = f"{uuid4().hex[:12]}.mp4"
                    file_path = run_dir / filename
                    dl = await client.get(video_url, timeout=120.0)
                    dl.raise_for_status()
                    file_path.write_bytes(dl.content)
                    _log(f"saved to {file_path}")
                    return {"video": {"type": "Video", "value": str(file_path)}}
                raise RuntimeError(f"Higgsfield completed but no video URL: {poll_data}")
            elif status in ("failed", "error"):
                raise RuntimeError(f"Higgsfield failed: {poll_data.get('error', status)}")
            elif status == "nsfw":
                raise RuntimeError("Higgsfield rejected generation: content policy violation")
            elif status == "cancelled":
                raise RuntimeError("Higgsfield generation was cancelled")
            # "queued" and "in_progress" → continue polling

        raise RuntimeError("Higgsfield timed out")
