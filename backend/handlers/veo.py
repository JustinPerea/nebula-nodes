from __future__ import annotations

import asyncio
import base64
import sys
from pathlib import Path
from typing import Any, Awaitable, Callable
from uuid import uuid4

import httpx

from models.graph import GraphNode, PortValueDict
from models.events import ExecutionEvent, ProgressEvent
from services.output import get_run_dir

VEO_BASE_URL = "https://generativelanguage.googleapis.com/v1beta/models"


def _log(msg: str) -> None:
    print(f"[veo] {msg}", file=sys.stderr, flush=True)


async def _image_to_veo_payload(img_str: str) -> dict[str, Any]:
    """Convert an image path/URL/data URI to Veo's inline data format."""
    if img_str.startswith(("http://", "https://")):
        async with httpx.AsyncClient(timeout=60.0) as dl_client:
            resp = await dl_client.get(img_str)
            resp.raise_for_status()
            b64_data = base64.b64encode(resp.content).decode("ascii")
            return {"bytesBase64Encoded": b64_data, "mimeType": "image/png"}
    elif img_str.startswith("data:"):
        header, b64_data = img_str.split(",", 1)
        mime_type = header.split(":")[1].split(";")[0]
        return {"bytesBase64Encoded": b64_data, "mimeType": mime_type}
    else:
        img_path = Path(img_str)
        if img_path.exists():
            b64_data = base64.b64encode(img_path.read_bytes()).decode("ascii")
            suffix = img_path.suffix.lstrip(".").lower()
            mime_map = {"png": "image/png", "jpg": "image/jpeg", "jpeg": "image/jpeg", "webp": "image/webp"}
            return {"bytesBase64Encoded": b64_data, "mimeType": mime_map.get(suffix, "image/png")}
    raise ValueError(f"Image not found: {img_str}")


async def handle_veo(
    node: GraphNode,
    inputs: dict[str, PortValueDict],
    api_keys: dict[str, str],
    emit: Callable[[ExecutionEvent], Awaitable[None]] | None = None,
) -> dict[str, Any]:
    api_key = api_keys.get("GOOGLE_API_KEY")
    if not api_key:
        raise ValueError("GOOGLE_API_KEY is required")

    prompt_input = inputs.get("prompt")
    prompt_text = str(prompt_input.value) if prompt_input and prompt_input.value else ""

    model = node.params.get("model", "veo-3.1-generate-preview")

    instance: dict[str, Any] = {}
    if prompt_text:
        instance["prompt"] = prompt_text

    # First frame (image-to-video)
    image_input = inputs.get("image")
    if image_input and image_input.value:
        instance["image"] = await _image_to_veo_payload(str(image_input.value))

    # Last frame (interpolation)
    last_frame_input = inputs.get("last_frame")
    if last_frame_input and last_frame_input.value:
        instance["lastFrame"] = await _image_to_veo_payload(str(last_frame_input.value))

    parameters: dict[str, Any] = {}
    aspect_ratio = node.params.get("aspectRatio")
    if aspect_ratio:
        parameters["aspectRatio"] = str(aspect_ratio)
    duration = node.params.get("duration")
    if duration:
        parameters["durationSeconds"] = str(duration).replace("s", "")
    resolution = node.params.get("resolution")
    if resolution:
        parameters["resolution"] = str(resolution)
    generate_audio = node.params.get("generateAudio")
    if generate_audio is not None:
        parameters["generateAudio"] = bool(generate_audio)

    request_body: dict[str, Any] = {
        "instances": [instance],
        "parameters": parameters,
    }

    async def noop_emit(event: ExecutionEvent) -> None:
        pass

    _emit = emit or noop_emit

    _log(f"submitting to {model}")
    async with httpx.AsyncClient(timeout=120.0) as client:
        # Submit long-running operation
        url = f"{VEO_BASE_URL}/{model}:predictLongRunning?key={api_key}"
        resp = await client.post(url, json=request_body, headers={"Content-Type": "application/json"})
        _log(f"submit response: {resp.status_code}")
        if resp.status_code != 200:
            raise RuntimeError(f"Veo submit failed ({resp.status_code}): {resp.text}")

        op_data = resp.json()
        op_name = op_data.get("name")
        if not op_name:
            raise RuntimeError(f"Veo did not return operation name: {op_data}")

        _log(f"polling operation {op_name}")

        # Poll for completion
        poll_url = f"https://generativelanguage.googleapis.com/v1beta/{op_name}?key={api_key}"
        max_polls = 300
        poll_interval = 3.0

        for poll_num in range(1, max_polls + 1):
            await asyncio.sleep(poll_interval)

            poll_resp = await client.get(poll_url)
            if poll_resp.status_code != 200:
                _log(f"poll FAILED: {poll_resp.status_code}")
                raise RuntimeError(f"Veo poll failed ({poll_resp.status_code}): {poll_resp.text}")

            poll_data = poll_resp.json()
            done = poll_data.get("done", False)

            progress = min(poll_num / max_polls, 0.99)
            await _emit(ProgressEvent(node_id=node.id, value=progress))

            if poll_num % 10 == 1:
                _log(f"poll #{poll_num}: done={done}")

            if done:
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
                        dl_resp = await client.get(f"{video_uri}?key={api_key}", timeout=120.0)
                        dl_resp.raise_for_status()
                        file_path.write_bytes(dl_resp.content)
                        _log(f"saved to {file_path}")
                        return {"video": {"type": "Video", "value": str(file_path)}}

                # Fallback: check for error
                error = poll_data.get("error")
                if error:
                    raise RuntimeError(f"Veo failed: {error}")

                raise RuntimeError(f"Veo completed but no video found: {list(poll_data.keys())}")

        _log("TIMED OUT")
        raise RuntimeError(f"Veo timed out after {max_polls} polls")
