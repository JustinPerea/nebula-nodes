from __future__ import annotations

import asyncio
import sys
from pathlib import Path
from typing import Any, Awaitable, Callable
from uuid import uuid4

import httpx

from models.graph import GraphNode, PortValueDict
from models.events import ExecutionEvent, ProgressEvent
from services.output import get_run_dir, image_to_data_uri, save_video_from_url

MINIMAX_API_BASE = "https://api.minimaxi.chat"


def _log(msg: str) -> None:
    print(f"[minimax] {msg}", file=sys.stderr, flush=True)


def _resolve_image_url(value: str) -> str:
    """Return the value as-is if it's a URL/data URI, otherwise convert local path to data URI."""
    if value.startswith(("http://", "https://", "data:")):
        return value
    image_path = Path(value)
    if not image_path.exists():
        raise ValueError(f"Image file not found: {value}")
    return image_to_data_uri(image_path)


async def handle_minimax_video(
    node: GraphNode,
    inputs: dict[str, PortValueDict],
    api_keys: dict[str, str],
    emit: Callable[[ExecutionEvent], Awaitable[None]] | None = None,
) -> dict[str, Any]:
    """
    Handle MiniMax video generation — T2V, I2V, or S2V — via 3-step async pattern:
      1. POST /v1/video_generation → task_id
      2. Poll GET /v1/query/video_generation?task_id={id} until Success/Fail
      3. GET /v1/files/retrieve/{file_id} → download_url, then save locally
    """
    _log(f"handle_minimax_video called, node={node.id}")

    api_key = api_keys.get("MINIMAX_API_KEY")
    if not api_key:
        raise ValueError("MINIMAX_API_KEY is required")

    # Determine variant from connected inputs
    prompt_input = inputs.get("prompt")
    first_frame_input = inputs.get("first_frame_image") or inputs.get("first_frame")
    last_frame_input = inputs.get("last_frame_image") or inputs.get("last_frame")
    subject_input = inputs.get("subject_reference") or inputs.get("subject")

    prompt = str(prompt_input.value) if prompt_input and prompt_input.value else ""

    # Build request body based on variant
    body: dict[str, Any] = {
        "prompt": prompt,
        "duration": node.params.get("duration", 6),
        "resolution": node.params.get("resolution", "1080P"),
    }

    # S2V — subject reference video
    if subject_input and subject_input.value:
        _log("variant=S2V")
        body["model"] = node.params.get("model", "S2V-01")
        subject_url = _resolve_image_url(str(subject_input.value))
        body["subject_reference"] = [{"type": "character", "image": [subject_url]}]

    # I2V — image to video (first frame required, last frame optional)
    elif first_frame_input and first_frame_input.value:
        _log("variant=I2V")
        body["model"] = node.params.get("model", "MiniMax-Hailuo-2.3")
        body["first_frame_image"] = _resolve_image_url(str(first_frame_input.value))
        if last_frame_input and last_frame_input.value:
            body["last_frame_image"] = _resolve_image_url(str(last_frame_input.value))

    # T2V — text to video (default)
    else:
        _log("variant=T2V")
        body["model"] = node.params.get("model", "MiniMax-Hailuo-2.3")

    if not prompt:
        raise ValueError("Prompt input is required")

    _log(f"model={body['model']}, body keys: {list(body.keys())}")

    headers = {
        "Authorization": f"Bearer {api_key}",
        "Content-Type": "application/json",
    }

    async def noop_emit(event: ExecutionEvent) -> None:
        pass

    _emit = emit or noop_emit

    async with httpx.AsyncClient(timeout=60.0) as client:
        # Step 1: Submit generation task
        _log(f"submitting to {MINIMAX_API_BASE}/v1/video_generation")
        resp = await client.post(
            f"{MINIMAX_API_BASE}/v1/video_generation",
            headers=headers,
            json=body,
        )
        _log(f"submit response: {resp.status_code}")
        if resp.status_code not in (200, 201, 202):
            raise RuntimeError(f"MiniMax submit failed ({resp.status_code}): {resp.text}")

        submit_data = resp.json()
        _log(f"submit_data: {submit_data}")
        task_id = submit_data.get("task_id")
        if not task_id:
            raise RuntimeError(f"MiniMax did not return task_id: {submit_data}")

        # Step 2: Poll for completion
        _log(f"polling task_id={task_id}")
        poll_url = f"{MINIMAX_API_BASE}/v1/query/video_generation"
        max_polls = 300
        poll_interval = 5.0

        for poll_num in range(1, max_polls + 1):
            await asyncio.sleep(poll_interval)

            poll_resp = await client.get(
                poll_url,
                headers={"Authorization": f"Bearer {api_key}"},
                params={"task_id": task_id},
            )
            if poll_resp.status_code != 200:
                _log(f"poll FAILED: {poll_resp.status_code} {poll_resp.text}")
                raise RuntimeError(f"MiniMax poll failed ({poll_resp.status_code}): {poll_resp.text}")

            poll_data = poll_resp.json()
            status = poll_data.get("status", "")
            if poll_num % 5 == 1:
                _log(f"poll #{poll_num}: status={status}")

            progress = min(poll_num / max_polls, 0.99)
            await _emit(ProgressEvent(node_id=node.id, value=progress))

            if status == "Success":
                file_id = poll_data.get("file_id")
                _log(f"Success! file_id={file_id}")
                if not file_id:
                    raise RuntimeError(f"MiniMax returned Success but no file_id: {poll_data}")

                # Step 3: Retrieve download URL
                retrieve_resp = await client.get(
                    f"{MINIMAX_API_BASE}/v1/files/retrieve/{file_id}",
                    headers={"Authorization": f"Bearer {api_key}"},
                )
                if retrieve_resp.status_code != 200:
                    raise RuntimeError(
                        f"MiniMax file retrieve failed ({retrieve_resp.status_code}): {retrieve_resp.text}"
                    )

                retrieve_data = retrieve_resp.json()
                download_url = retrieve_data.get("file", {}).get("download_url", "")
                _log(f"download_url={download_url[:100] if download_url else 'NONE'}")
                if not download_url:
                    raise RuntimeError(f"MiniMax did not return download_url: {retrieve_data}")

                # Download video locally
                run_dir = get_run_dir()
                local_path = await save_video_from_url(download_url, run_dir)
                _log(f"downloaded to {local_path}")
                return {"video": {"type": "Video", "value": str(local_path)}}

            elif status == "Fail":
                error = poll_data.get("message") or poll_data.get("err_msg") or "Unknown error"
                _log(f"Fail: {error}")
                raise RuntimeError(f"MiniMax task failed: {error}")

            # Queueing / Processing — keep polling

        _log("TIMED OUT")
        raise RuntimeError(f"MiniMax task timed out after {max_polls} polls")
