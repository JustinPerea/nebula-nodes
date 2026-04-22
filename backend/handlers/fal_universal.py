from __future__ import annotations

import asyncio
import json
from typing import Any, Awaitable, Callable

import httpx

from models.graph import GraphNode, PortValueDict
from models.events import ExecutionEvent, ProgressEvent
from services.output import get_run_dir, save_base64_image

FAL_QUEUE_BASE = "https://queue.fal.run"
STREAMING_FAL_ENDPOINTS = {"openai/gpt-image-2", "openai/gpt-image-2/edit"}


def _to_fal_url(value: str) -> str:
    """Convert a local file path to a data URI, or pass URLs through."""
    if value.startswith(("http://", "https://", "data:")):
        return value
    # Local file path — convert to data URI
    import base64
    from pathlib import Path
    p = Path(value)
    if not p.exists():
        return value  # Let FAL handle the error
    suffix = p.suffix.lstrip(".").lower()
    mime_map = {
        "png": "image/png", "jpg": "image/jpeg", "jpeg": "image/jpeg",
        "webp": "image/webp", "gif": "image/gif", "mp4": "video/mp4",
        "mp3": "audio/mpeg", "wav": "audio/wav",
    }
    mime = mime_map.get(suffix, "application/octet-stream")
    b64 = base64.b64encode(p.read_bytes()).decode()
    return f"data:{mime};base64,{b64}"


def _build_fal_stream_body(node: GraphNode, inputs: dict[str, PortValueDict]) -> dict[str, Any]:
    """Build the JSON request body for FAL streaming gpt-image-2 endpoints."""
    body: dict[str, Any] = {}

    prompt_input = inputs.get("prompt")
    if prompt_input and prompt_input.value:
        body["prompt"] = str(prompt_input.value)

    # Edit endpoint: accept multiple images via the "images" input port
    images_input = inputs.get("images")
    if images_input and images_input.value:
        raw = images_input.value
        if isinstance(raw, list):
            body["image_urls"] = [_to_fal_url(str(v)) for v in raw if v]
        else:
            body["image_urls"] = [_to_fal_url(str(raw))]

    INTERNAL_KEYS = {"endpoint_id"}
    for param_key, param_val in node.params.items():
        if param_key not in INTERNAL_KEYS and param_val is not None and param_val != "":
            body[param_key] = param_val

    return body


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

    # Route gpt-image-2 endpoints through the SSE streaming path
    if endpoint_id in STREAMING_FAL_ENDPOINTS and emit is not None:
        from execution.stream_runner import StreamConfig, stream_execute_image
        from services.output import get_run_dir

        request_body = _build_fal_stream_body(node, inputs)
        run_dir = get_run_dir()
        config = StreamConfig(
            url=f"{FAL_QUEUE_BASE}/{endpoint_id}/stream",
            headers={
                "Authorization": f"Key {api_key}",
                "Accept": "text/event-stream",
                "Content-Type": "application/json",
            },
            timeout=180.0,
        )
        final = await stream_execute_image(
            config=config,
            request_body=request_body,
            node_id=node.id,
            emit=emit,
            run_dir=run_dir,
            provider="fal",
        )
        return {"image": {"type": "Image", "value": final}}

    # Build input payload
    fal_input: dict[str, Any] = {}

    # Map connected inputs
    prompt_input = inputs.get("prompt")
    if prompt_input and prompt_input.value:
        fal_input["prompt"] = str(prompt_input.value)

    image_input = inputs.get("image")
    if image_input and image_input.value:
        fal_input["image_url"] = _to_fal_url(str(image_input.value))

    texture_image_input = inputs.get("texture_image")
    if texture_image_input and texture_image_input.value:
        fal_input["texture_image_url"] = _to_fal_url(str(texture_image_input.value))

    end_image_input = inputs.get("end_image")
    if end_image_input and end_image_input.value:
        fal_input["end_image_url"] = _to_fal_url(str(end_image_input.value))

    tail_image_input = inputs.get("tail_image")
    if tail_image_input and tail_image_input.value:
        fal_input["tail_image_url"] = _to_fal_url(str(tail_image_input.value))

    # Multi-image inputs for 3D models (Hunyuan3D V3 Image-to-3D)
    # Hunyuan3D uses "input_image_url" for the primary image
    front_image = inputs.get("front_image")
    if front_image and front_image.value:
        fal_input["input_image_url"] = _to_fal_url(str(front_image.value))

    back_image = inputs.get("back_image")
    if back_image and back_image.value:
        fal_input["back_image_url"] = _to_fal_url(str(back_image.value))

    left_image = inputs.get("left_image")
    if left_image and left_image.value:
        fal_input["left_image_url"] = _to_fal_url(str(left_image.value))

    right_image = inputs.get("right_image")
    if right_image and right_image.value:
        fal_input["right_image_url"] = _to_fal_url(str(right_image.value))

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
            # Some FAL endpoints return the result directly (no queue)
            return _parse_fal_output(submit_data)

        # Step 2: Poll for status
        # Use URLs from FAL response (canonical), fall back to constructed URLs
        status_url = submit_data.get("status_url") or f"{FAL_QUEUE_BASE}/{endpoint_id}/requests/{request_id}/status"
        result_url = submit_data.get("response_url") or f"{FAL_QUEUE_BASE}/{endpoint_id}/requests/{request_id}"

        max_polls = 300
        poll_interval = 2.0

        for poll_num in range(1, max_polls + 1):
            await asyncio.sleep(poll_interval)

            status_resp = await client.get(status_url, headers=headers)
            if status_resp.status_code not in (200, 202):
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
    # 3D mesh output — check before images since some 3D endpoints also return preview images
    # Meshy pattern: {"model_urls": {"glb": "url", "fbx": "url"}}
    model_urls = data.get("model_urls", {})
    if isinstance(model_urls, dict) and model_urls.get("glb"):
        return {"mesh": {"type": "Mesh", "value": model_urls["glb"]}}

    # Hunyuan/generic pattern: {"glb": {"url": "..."}} or {"glb": "url"}
    glb = data.get("glb")
    if isinstance(glb, dict) and glb.get("url"):
        return {"mesh": {"type": "Mesh", "value": glb["url"]}}
    if isinstance(glb, str) and glb:
        return {"mesh": {"type": "Mesh", "value": glb}}

    # model_glb pattern: {"model_glb": {"url": "..."}} or {"model_glb": "url"}
    model_glb = data.get("model_glb")
    if isinstance(model_glb, dict) and model_glb.get("url"):
        return {"mesh": {"type": "Mesh", "value": model_glb["url"]}}
    if isinstance(model_glb, str) and model_glb:
        return {"mesh": {"type": "Mesh", "value": model_glb}}

    # model_mesh pattern: {"model_mesh": {"url": "..."}}
    model_mesh = data.get("model_mesh")
    if isinstance(model_mesh, dict) and model_mesh.get("url"):
        return {"mesh": {"type": "Mesh", "value": model_mesh["url"]}}
    if isinstance(model_mesh, str) and model_mesh:
        return {"mesh": {"type": "Mesh", "value": model_mesh}}

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
