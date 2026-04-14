from __future__ import annotations

import asyncio
from typing import Any, Awaitable, Callable

import httpx

from models.graph import GraphNode, PortValueDict
from models.events import ExecutionEvent, ProgressEvent
from services.output import image_to_data_uri
from pathlib import Path

import sys

MESHY_API_BASE = "https://api.meshy.ai/openapi"


def _log(msg: str) -> None:
    print(f"[meshy] {msg}", file=sys.stderr, flush=True)


async def handle_meshy_image_to_3d(
    node: GraphNode,
    inputs: dict[str, PortValueDict],
    api_keys: dict[str, str],
    emit: Callable[[ExecutionEvent], Awaitable[None]] | None = None,
) -> dict[str, Any]:
    _log(f"handle_meshy_image_to_3d called, node={node.id}")
    api_key = api_keys.get("MESHY_API_KEY")
    if not api_key:
        raise ValueError("MESHY_API_KEY is required")

    image_input = inputs.get("image")
    if not image_input or not image_input.value:
        raise ValueError("Image input is required")

    image_value = str(image_input.value)
    _log(f"image_value starts with: {image_value[:80]}...")
    # Convert local file paths to data URIs for the API
    if not image_value.startswith(("http://", "https://", "data:")):
        image_path = Path(image_value)
        if not image_path.exists():
            raise ValueError(f"Image file not found: {image_value}")
        image_value = image_to_data_uri(image_path)
        _log(f"converted to data URI, length={len(image_value)}")

    headers = {
        "Authorization": f"Bearer {api_key}",
        "Content-Type": "application/json",
    }

    body: dict[str, Any] = {"image_url": image_value}

    # Map node params
    INTERNAL_KEYS = {"endpoint_id"}
    for k, v in node.params.items():
        if k not in INTERNAL_KEYS and v is not None and v != "":
            body[k] = v

    async def noop_emit(event: ExecutionEvent) -> None:
        pass

    _emit = emit or noop_emit

    async with httpx.AsyncClient(timeout=120.0) as client:
        # Submit task
        _log(f"submitting to {MESHY_API_BASE}/v1/image-to-3d, body keys: {list(body.keys())}")
        resp = await client.post(
            f"{MESHY_API_BASE}/v1/image-to-3d",
            headers=headers,
            json=body,
        )
        _log(f"submit response: {resp.status_code}")
        if resp.status_code not in (200, 201, 202):
            raise RuntimeError(f"Meshy submit failed ({resp.status_code}): {resp.text}")

        task_data = resp.json()
        _log(f"task_data: {task_data}")
        task_id = task_data.get("result") or task_data.get("id") or task_data.get("task_id")
        if not task_id:
            raise RuntimeError(f"Meshy did not return task ID: {task_data}")

        _log(f"polling task {task_id}")
        # Poll for completion
        poll_url = f"{MESHY_API_BASE}/v1/image-to-3d/{task_id}"
        max_polls = 300
        poll_interval = 3.0

        for poll_num in range(1, max_polls + 1):
            await asyncio.sleep(poll_interval)

            poll_resp = await client.get(poll_url, headers={"Authorization": f"Bearer {api_key}"})
            if poll_resp.status_code != 200:
                _log(f"poll FAILED: {poll_resp.status_code} {poll_resp.text}")
                raise RuntimeError(f"Meshy poll failed ({poll_resp.status_code}): {poll_resp.text}")

            poll_data = poll_resp.json()
            status = poll_data.get("status", "")
            if poll_num % 10 == 1:
                _log(f"poll #{poll_num}: status={status}")

            progress = min(poll_num / max_polls, 0.99)
            await _emit(ProgressEvent(node_id=node.id, value=progress))

            if status == "SUCCEEDED":
                model_urls = poll_data.get("model_urls", {})
                glb_url = model_urls.get("glb", "")
                _log(f"SUCCEEDED! glb_url={glb_url[:100] if glb_url else 'NONE'}")
                if glb_url:
                    # Download GLB locally to avoid CORS issues
                    from services.output import save_mesh_from_url, get_run_dir
                    run_dir = get_run_dir()
                    local_path = await save_mesh_from_url(glb_url, run_dir)
                    _log(f"downloaded to {local_path}")
                    return {"mesh": {"type": "Mesh", "value": str(local_path)}}
                _log(f"no glb_url found, full data keys: {list(poll_data.keys())}")
                return {"mesh": {"type": "Mesh", "value": str(poll_data)}}

            elif status == "FAILED":
                error = poll_data.get("task_error", {}).get("message", "Unknown error")
                _log(f"FAILED: {error}")
                raise RuntimeError(f"Meshy task failed: {error}")

        _log("TIMED OUT")
        raise RuntimeError(f"Meshy task timed out after {max_polls} polls")


async def handle_meshy_text_to_3d(
    node: GraphNode,
    inputs: dict[str, PortValueDict],
    api_keys: dict[str, str],
    emit: Callable[[ExecutionEvent], Awaitable[None]] | None = None,
) -> dict[str, Any]:
    api_key = api_keys.get("MESHY_API_KEY")
    if not api_key:
        raise ValueError("MESHY_API_KEY is required")

    prompt_input = inputs.get("prompt")
    if not prompt_input or not prompt_input.value:
        raise ValueError("Prompt input is required")

    headers = {
        "Authorization": f"Bearer {api_key}",
        "Content-Type": "application/json",
    }

    mode = node.params.get("mode", "preview")

    body: dict[str, Any] = {
        "mode": "preview",
        "prompt": str(prompt_input.value),
    }

    # Map node params (except mode which we handle specially)
    INTERNAL_KEYS = {"endpoint_id", "mode"}
    for k, v in node.params.items():
        if k not in INTERNAL_KEYS and v is not None and v != "":
            body[k] = v

    async def noop_emit(event: ExecutionEvent) -> None:
        pass

    _emit = emit or noop_emit

    async with httpx.AsyncClient(timeout=30.0) as client:
        # Step 1: Submit preview task
        resp = await client.post(
            f"{MESHY_API_BASE}/v2/text-to-3d",
            headers=headers,
            json=body,
        )
        if resp.status_code not in (200, 201, 202):
            raise RuntimeError(f"Meshy submit failed ({resp.status_code}): {resp.text}")

        task_data = resp.json()
        task_id = task_data.get("result") or task_data.get("id") or task_data.get("task_id")
        if not task_id:
            raise RuntimeError(f"Meshy did not return task ID: {task_data}")

        # Poll preview
        result_data = await _poll_meshy_task(
            client, api_key, f"{MESHY_API_BASE}/v2/text-to-3d/{task_id}", _emit, node.id
        )

        # Step 2: If mode is "full", submit refine task
        if mode == "full":
            refine_body: dict[str, Any] = {
                "mode": "refine",
                "preview_task_id": task_id,
            }
            # Pass through relevant params for refine
            for k in ("topology", "target_polycount"):
                if k in node.params and node.params[k] is not None:
                    refine_body[k] = node.params[k]

            resp2 = await client.post(
                f"{MESHY_API_BASE}/v2/text-to-3d",
                headers=headers,
                json=refine_body,
            )
            if resp2.status_code not in (200, 201, 202):
                raise RuntimeError(f"Meshy refine submit failed ({resp2.status_code}): {resp2.text}")

            refine_data = resp2.json()
            refine_id = refine_data.get("result") or refine_data.get("id") or refine_data.get("task_id")
            if not refine_id:
                raise RuntimeError(f"Meshy refine did not return task ID: {refine_data}")

            result_data = await _poll_meshy_task(
                client, api_key, f"{MESHY_API_BASE}/v2/text-to-3d/{refine_id}", _emit, node.id
            )

        model_urls = result_data.get("model_urls", {})
        glb_url = model_urls.get("glb", "")
        if glb_url:
            return {"mesh": {"type": "Mesh", "value": glb_url}}
        return {"mesh": {"type": "Mesh", "value": str(result_data)}}


async def _poll_meshy_task(
    client: httpx.AsyncClient,
    api_key: str,
    poll_url: str,
    emit: Callable[[ExecutionEvent], Awaitable[None]],
    node_id: str,
    max_polls: int = 300,
    poll_interval: float = 3.0,
) -> dict[str, Any]:
    """Poll a Meshy task until completion."""
    for poll_num in range(1, max_polls + 1):
        await asyncio.sleep(poll_interval)

        resp = await client.get(poll_url, headers={"Authorization": f"Bearer {api_key}"})
        if resp.status_code != 200:
            raise RuntimeError(f"Meshy poll failed ({resp.status_code}): {resp.text}")

        data = resp.json()
        status = data.get("status", "")

        progress = min(poll_num / max_polls, 0.99)
        await emit(ProgressEvent(node_id=node_id, value=progress))

        if status == "SUCCEEDED":
            return data
        elif status == "FAILED":
            error = data.get("task_error", {}).get("message", "Unknown error")
            raise RuntimeError(f"Meshy task failed: {error}")

    raise RuntimeError(f"Meshy task timed out after {max_polls} polls")
