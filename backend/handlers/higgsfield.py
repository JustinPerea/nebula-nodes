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

    headers = {
        "Authorization": f"Bearer {api_key}",
        "Content-Type": "application/json",
    }

    body: dict[str, Any] = {
        "model": node.params.get("model", "higgsfield-native"),
        "prompt": str(prompt_input.value),
    }

    duration = node.params.get("duration")
    if duration is not None:
        body["duration"] = int(duration)

    async def noop_emit(event: ExecutionEvent) -> None:
        pass
    _emit = emit or noop_emit

    _log(f"submitting video generation")
    async with httpx.AsyncClient(timeout=120.0) as client:
        resp = await client.post(
            "https://api.higgsfield.ai/v1/video/generate",
            headers=headers,
            json=body,
        )
        _log(f"submit response: {resp.status_code}")
        if resp.status_code not in (200, 201, 202):
            raise RuntimeError(f"Higgsfield submit failed ({resp.status_code}): {resp.text}")

        result = resp.json()
        gen_id = result.get("id") or result.get("job_id") or result.get("generation_id")
        if not gen_id:
            raise RuntimeError(f"Higgsfield returned unexpected response: {result}")

        _log(f"polling generation {gen_id}")
        max_polls = 300
        for poll_num in range(1, max_polls + 1):
            await asyncio.sleep(3.0)
            poll_resp = await client.get(
                f"https://api.higgsfield.ai/v1/video/{gen_id}",
                headers=headers,
            )
            if poll_resp.status_code != 200:
                raise RuntimeError(f"Higgsfield poll failed ({poll_resp.status_code}): {poll_resp.text}")

            poll_data = poll_resp.json()
            status = poll_data.get("status", "")

            await _emit(ProgressEvent(node_id=node.id, value=min(poll_num / max_polls, 0.99)))

            if status in ("completed", "succeeded", "complete", "done"):
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
                raise RuntimeError(f"Higgsfield completed but no video URL: {poll_data}")
            elif status in ("failed", "error"):
                raise RuntimeError(f"Higgsfield failed: {poll_data.get('error', status)}")

        raise RuntimeError("Higgsfield timed out")
