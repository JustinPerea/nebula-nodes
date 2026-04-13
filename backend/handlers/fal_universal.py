from __future__ import annotations

import asyncio
import json
from typing import Any, Awaitable, Callable

import httpx

from models.graph import GraphNode, PortValueDict
from models.events import ExecutionEvent, ProgressEvent
from services.output import get_run_dir, save_base64_image

FAL_QUEUE_BASE = "https://queue.fal.run"


async def handle_fal_universal(
    node: GraphNode,
    inputs: dict[str, PortValueDict],
    api_keys: dict[str, str],
    emit: Callable[[ExecutionEvent], Awaitable[None]] | None = None,
) -> dict[str, Any]:
    api_key = api_keys.get("FAL_KEY")
    if not api_key:
        raise ValueError("FAL_KEY is required")

    endpoint_id = node.params.get("endpoint_id", "")
    if not endpoint_id:
        raise ValueError("FAL endpoint ID is required (e.g. fal-ai/flux-pro/v1.1-ultra)")

    endpoint_id = str(endpoint_id).strip("/")

    # Build input payload
    fal_input: dict[str, Any] = {}

    # Map connected inputs
    prompt_input = inputs.get("prompt")
    if prompt_input and prompt_input.value:
        fal_input["prompt"] = str(prompt_input.value)

    image_input = inputs.get("image")
    if image_input and image_input.value:
        fal_input["image_url"] = str(image_input.value)

    # Map node params (excluding our internal keys)
    INTERNAL_KEYS = {"endpoint_id"}
    for param_key, param_val in node.params.items():
        if param_key not in INTERNAL_KEYS and param_val is not None and param_val != "":
            fal_input[param_key] = param_val

    headers = {
        "Authorization": f"Key {api_key}",
        "Content-Type": "application/json",
    }

    async def noop_emit(event: ExecutionEvent) -> None:
        pass

    _emit = emit or noop_emit

    async with httpx.AsyncClient(timeout=30.0) as client:
        # Step 1: Submit to queue
        submit_resp = await client.post(
            f"{FAL_QUEUE_BASE}/{endpoint_id}",
            headers=headers,
            json=fal_input,
        )
        if submit_resp.status_code not in (200, 201):
            raise RuntimeError(f"FAL submit failed ({submit_resp.status_code}): {submit_resp.text}")

        submit_data = submit_resp.json()
        request_id = submit_data.get("request_id")
        if not request_id:
            raise RuntimeError(f"FAL did not return request_id: {submit_data}")

        # Step 2: Poll for status
        status_url = f"{FAL_QUEUE_BASE}/{endpoint_id}/requests/{request_id}/status"
        result_url = f"{FAL_QUEUE_BASE}/{endpoint_id}/requests/{request_id}"

        max_polls = 300
        poll_interval = 2.0

        for poll_num in range(1, max_polls + 1):
            await asyncio.sleep(poll_interval)

            status_resp = await client.get(status_url, headers=headers)
            if status_resp.status_code != 200:
                raise RuntimeError(f"FAL status poll failed ({status_resp.status_code}): {status_resp.text}")

            status_data = status_resp.json()
            status = status_data.get("status", "")

            progress = min(poll_num / max_polls, 0.99)
            await _emit(ProgressEvent(node_id=node.id, value=progress))

            if status == "COMPLETED":
                break
            elif status in ("FAILED", "CANCELLED"):
                error_msg = status_data.get("error", f"FAL job failed with status: {status}")
                raise RuntimeError(f"FAL job failed: {error_msg}")
            # IN_QUEUE or IN_PROGRESS — keep polling
        else:
            raise RuntimeError(f"FAL job timed out after {max_polls} polls")

        # Step 3: Fetch result
        result_resp = await client.get(result_url, headers=headers)
        if result_resp.status_code != 200:
            raise RuntimeError(f"FAL result fetch failed ({result_resp.status_code}): {result_resp.text}")

        result_data = result_resp.json()

    # Parse output — FAL endpoints vary, but common patterns:
    # Image endpoints: {"images": [{"url": "...", "content_type": "image/png"}]}
    # Audio endpoints: {"audio_url": "..."}
    # Text endpoints: {"text": "..."}
    return _parse_fal_output(result_data)


def _parse_fal_output(data: dict[str, Any]) -> dict[str, Any]:
    """Parse FAL output into our standard port format."""
    # Image output (most common)
    images = data.get("images", [])
    if images and isinstance(images, list) and len(images) > 0:
        first_image = images[0]
        if isinstance(first_image, dict):
            url = first_image.get("url", "")
        else:
            url = str(first_image)
        if url:
            return {"image": {"type": "Image", "value": url}}

    # Single image URL
    image_url = data.get("image", {})
    if isinstance(image_url, dict) and image_url.get("url"):
        return {"image": {"type": "Image", "value": image_url["url"]}}
    if isinstance(image_url, str) and image_url:
        return {"image": {"type": "Image", "value": image_url}}

    # Audio output
    audio_url = data.get("audio_url") or data.get("audio", {}).get("url", "")
    if audio_url:
        return {"audio": {"type": "Audio", "value": audio_url}}

    # Video output
    video_url = data.get("video", {}).get("url", "") or data.get("video_url", "")
    if video_url:
        return {"video": {"type": "Video", "value": video_url}}

    # Text fallback
    text = data.get("text", data.get("output", ""))
    if text:
        return {"text": {"type": "Text", "value": str(text)}}

    # Last resort — return the raw JSON as text
    return {"text": {"type": "Text", "value": json.dumps(data, indent=2)}}
