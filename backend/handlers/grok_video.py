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
    print(f"[grok] {msg}", file=sys.stderr, flush=True)


async def handle_grok_video(
    node: GraphNode,
    inputs: dict[str, PortValueDict],
    api_keys: dict[str, str],
    emit: Callable[[ExecutionEvent], Awaitable[None]] | None = None,
) -> dict[str, Any]:
    api_key = api_keys.get("XAI_API_KEY")
    if not api_key:
        raise ValueError("XAI_API_KEY is required")

    prompt_input = inputs.get("prompt")
    if not prompt_input or not prompt_input.value:
        raise ValueError("Prompt is required")

    headers = {
        "Authorization": f"Bearer {api_key}",
        "Content-Type": "application/json",
    }

    body: dict[str, Any] = {
        "model": "grok-2-video",
        "prompt": str(prompt_input.value),
    }

    duration = node.params.get("duration")
    if duration is not None:
        body["duration"] = int(duration)
    aspect = node.params.get("aspect_ratio")
    if aspect:
        body["aspect_ratio"] = str(aspect)

    # Image input for I2V
    image_input = inputs.get("image")
    if image_input and image_input.value:
        import base64
        from pathlib import Path
        img_str = str(image_input.value)
        if img_str.startswith(("http://", "https://")):
            body["image_url"] = img_str
        else:
            img_path = Path(img_str)
            if img_path.exists():
                b64 = base64.b64encode(img_path.read_bytes()).decode("ascii")
                suffix = img_path.suffix.lstrip(".").lower()
                mime = {"png": "image/png", "jpg": "image/jpeg", "jpeg": "image/jpeg"}.get(suffix, "image/png")
                body["image_url"] = f"data:{mime};base64,{b64}"

    async def noop_emit(event: ExecutionEvent) -> None:
        pass
    _emit = emit or noop_emit

    _log(f"submitting video generation")
    async with httpx.AsyncClient(timeout=120.0) as client:
        resp = await client.post(
            "https://api.x.ai/v1/video/generations",
            headers=headers,
            json=body,
        )
        _log(f"submit response: {resp.status_code}")
        if resp.status_code not in (200, 201, 202):
            raise RuntimeError(f"Grok submit failed ({resp.status_code}): {resp.text}")

        result = resp.json()
        gen_id = result.get("id") or result.get("generation_id")
        if not gen_id:
            # Some APIs return result directly
            video_url = result.get("url") or result.get("video_url")
            if video_url:
                run_dir = get_run_dir()
                filename = f"{uuid4().hex[:12]}.mp4"
                file_path = run_dir / filename
                dl = await client.get(video_url, timeout=120.0)
                dl.raise_for_status()
                file_path.write_bytes(dl.content)
                return {"video": {"type": "Video", "value": str(file_path)}}
            raise RuntimeError(f"Grok returned unexpected response: {result}")

        _log(f"polling generation {gen_id}")
        # Poll
        max_polls = 300
        for poll_num in range(1, max_polls + 1):
            await asyncio.sleep(3.0)
            poll_resp = await client.get(
                f"https://api.x.ai/v1/video/generations/{gen_id}",
                headers=headers,
            )
            if poll_resp.status_code != 200:
                raise RuntimeError(f"Grok poll failed ({poll_resp.status_code}): {poll_resp.text}")

            poll_data = poll_resp.json()
            status = poll_data.get("status", "")

            await _emit(ProgressEvent(node_id=node.id, value=min(poll_num / max_polls, 0.99)))

            if status in ("completed", "succeeded", "complete"):
                video_url = poll_data.get("url") or poll_data.get("video_url") or poll_data.get("output", {}).get("url", "")
                if video_url:
                    run_dir = get_run_dir()
                    filename = f"{uuid4().hex[:12]}.mp4"
                    file_path = run_dir / filename
                    dl = await client.get(video_url, timeout=120.0)
                    dl.raise_for_status()
                    file_path.write_bytes(dl.content)
                    _log(f"saved to {file_path}")
                    return {"video": {"type": "Video", "value": str(file_path)}}
                raise RuntimeError(f"Grok completed but no video URL: {poll_data}")
            elif status in ("failed", "error"):
                raise RuntimeError(f"Grok failed: {poll_data.get('error', status)}")

        raise RuntimeError("Grok timed out")
