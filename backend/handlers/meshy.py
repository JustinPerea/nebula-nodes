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

    # Map node params — skip phantom params not in the API
    SKIP_KEYS = {"endpoint_id", "enable_rigging"}
    for k, v in node.params.items():
        if k in SKIP_KEYS or v is None or v == "":
            continue
        if k == "target_formats" and isinstance(v, str):
            body[k] = [f.strip() for f in v.split(",") if f.strip()]
        else:
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

    # Preview-only params
    PREVIEW_KEYS = {"prompt", "model_type", "ai_model", "should_remesh", "topology",
                    "target_polycount", "symmetry_mode", "pose_mode", "target_formats",
                    "moderation", "auto_size", "origin_at"}
    # Refine-only params
    REFINE_KEYS = {"enable_pbr", "topology", "target_polycount", "ai_model",
                   "remove_lighting", "target_formats"}
    SKIP_KEYS = {"endpoint_id", "mode", "enable_rigging", "seed"}

    body: dict[str, Any] = {
        "mode": "preview",
        "prompt": str(prompt_input.value),
    }

    for k, v in node.params.items():
        if k in SKIP_KEYS or v is None or v == "":
            continue
        if k in PREVIEW_KEYS:
            # Convert target_formats string to array
            if k == "target_formats" and isinstance(v, str):
                body[k] = [f.strip() for f in v.split(",") if f.strip()]
            else:
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
            for k, v in node.params.items():
                if k in REFINE_KEYS and v is not None and v != "":
                    if k == "target_formats" and isinstance(v, str):
                        refine_body[k] = [f.strip() for f in v.split(",") if f.strip()]
                    else:
                        refine_body[k] = v

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
            from services.output import save_mesh_from_url, get_run_dir
            run_dir = get_run_dir()
            local_path = await save_mesh_from_url(glb_url, run_dir)
            return {"mesh": {"type": "Mesh", "value": str(local_path)}}
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


async def handle_meshy_multi_image_to_3d(
    node: GraphNode,
    inputs: dict[str, PortValueDict],
    api_keys: dict[str, str],
    emit: Callable[[ExecutionEvent], Awaitable[None]] | None = None,
) -> dict[str, Any]:
    api_key = api_keys.get("MESHY_API_KEY")
    if not api_key:
        raise ValueError("MESHY_API_KEY is required")

    images_input = inputs.get("images")
    if not images_input or not images_input.value:
        raise ValueError("At least one image input is required")

    image_values = images_input.value if isinstance(images_input.value, list) else [images_input.value]
    image_urls: list[str] = []
    for img in image_values:
        img_str = str(img)
        if not img_str.startswith(("http://", "https://", "data:")):
            img_path = Path(img_str)
            if not img_path.exists():
                raise ValueError(f"Image file not found: {img_str}")
            img_str = image_to_data_uri(img_path)
        image_urls.append(img_str)

    headers = {
        "Authorization": f"Bearer {api_key}",
        "Content-Type": "application/json",
    }

    body: dict[str, Any] = {"image_urls": image_urls}

    INTERNAL_KEYS = {"endpoint_id"}
    for k, v in node.params.items():
        if k not in INTERNAL_KEYS and v is not None and v != "":
            body[k] = v

    async def noop_emit(event: ExecutionEvent) -> None:
        pass

    _emit = emit or noop_emit

    async with httpx.AsyncClient(timeout=120.0) as client:
        resp = await client.post(
            f"{MESHY_API_BASE}/v1/multi-image-to-3d",
            headers=headers,
            json=body,
        )
        if resp.status_code not in (200, 201, 202):
            raise RuntimeError(f"Meshy multi-image submit failed ({resp.status_code}): {resp.text}")

        task_data = resp.json()
        task_id = task_data.get("result") or task_data.get("id") or task_data.get("task_id")
        if not task_id:
            raise RuntimeError(f"Meshy did not return task ID: {task_data}")

        result_data = await _poll_meshy_task(
            client, api_key, f"{MESHY_API_BASE}/v1/multi-image-to-3d/{task_id}", _emit, node.id
        )

        model_urls = result_data.get("model_urls", {})
        glb_url = model_urls.get("glb", "")
        if glb_url:
            from services.output import save_mesh_from_url, get_run_dir
            run_dir = get_run_dir()
            local_path = await save_mesh_from_url(glb_url, run_dir)
            return {"mesh": {"type": "Mesh", "value": str(local_path)}}
        return {"mesh": {"type": "Mesh", "value": str(result_data)}}


async def handle_meshy_retexture(
    node: GraphNode,
    inputs: dict[str, PortValueDict],
    api_keys: dict[str, str],
    emit: Callable[[ExecutionEvent], Awaitable[None]] | None = None,
) -> dict[str, Any]:
    api_key = api_keys.get("MESHY_API_KEY")
    if not api_key:
        raise ValueError("MESHY_API_KEY is required")

    model_url_input = inputs.get("model_url")
    if not model_url_input or not model_url_input.value:
        raise ValueError("Model URL input is required for retexturing")

    prompt_input = inputs.get("prompt")

    headers = {
        "Authorization": f"Bearer {api_key}",
        "Content-Type": "application/json",
    }

    body: dict[str, Any] = {
        "model_url": str(model_url_input.value),
    }

    if prompt_input and prompt_input.value:
        body["text_style_prompt"] = str(prompt_input.value)

    INTERNAL_KEYS = {"endpoint_id"}
    for k, v in node.params.items():
        if k not in INTERNAL_KEYS and v is not None and v != "":
            body[k] = v

    async def noop_emit(event: ExecutionEvent) -> None:
        pass

    _emit = emit or noop_emit

    async with httpx.AsyncClient(timeout=120.0) as client:
        resp = await client.post(
            f"{MESHY_API_BASE}/v1/retexture",
            headers=headers,
            json=body,
        )
        if resp.status_code not in (200, 201, 202):
            raise RuntimeError(f"Meshy retexture submit failed ({resp.status_code}): {resp.text}")

        task_data = resp.json()
        task_id = task_data.get("result") or task_data.get("id") or task_data.get("task_id")
        if not task_id:
            raise RuntimeError(f"Meshy did not return task ID: {task_data}")

        result_data = await _poll_meshy_task(
            client, api_key, f"{MESHY_API_BASE}/v1/retexture/{task_id}", _emit, node.id
        )

        model_urls = result_data.get("model_urls", {})
        glb_url = model_urls.get("glb", "")
        if glb_url:
            from services.output import save_mesh_from_url, get_run_dir
            run_dir = get_run_dir()
            local_path = await save_mesh_from_url(glb_url, run_dir)
            return {"mesh": {"type": "Mesh", "value": str(local_path)}}
        return {"mesh": {"type": "Mesh", "value": str(result_data)}}


async def handle_meshy_rigging(
    node: GraphNode,
    inputs: dict[str, PortValueDict],
    api_keys: dict[str, str],
    emit: Callable[[ExecutionEvent], Awaitable[None]] | None = None,
) -> dict[str, Any]:
    api_key = api_keys.get("MESHY_API_KEY")
    if not api_key:
        raise ValueError("MESHY_API_KEY is required")

    model_url_input = inputs.get("model_url")
    if not model_url_input or not model_url_input.value:
        raise ValueError("Model URL input is required for rigging")

    headers = {
        "Authorization": f"Bearer {api_key}",
        "Content-Type": "application/json",
    }

    body: dict[str, Any] = {
        "model_url": str(model_url_input.value),
    }

    INTERNAL_KEYS = {"endpoint_id"}
    for k, v in node.params.items():
        if k not in INTERNAL_KEYS and v is not None and v != "":
            body[k] = v

    async def noop_emit(event: ExecutionEvent) -> None:
        pass

    _emit = emit or noop_emit

    async with httpx.AsyncClient(timeout=120.0) as client:
        resp = await client.post(
            f"{MESHY_API_BASE}/v1/rigging",
            headers=headers,
            json=body,
        )
        if resp.status_code not in (200, 201, 202):
            raise RuntimeError(f"Meshy rigging submit failed ({resp.status_code}): {resp.text}")

        task_data = resp.json()
        task_id = task_data.get("result") or task_data.get("id") or task_data.get("task_id")
        if not task_id:
            raise RuntimeError(f"Meshy did not return task ID: {task_data}")

        result_data = await _poll_meshy_task(
            client, api_key, f"{MESHY_API_BASE}/v1/rigging/{task_id}", _emit, node.id
        )

        # Rigging response uses result.rigged_character_glb_url
        result_obj = result_data.get("result", {})
        glb_url = result_obj.get("rigged_character_glb_url", "")
        output: dict[str, Any] = {
            "task_id": {"type": "Text", "value": str(task_id)},
        }
        if glb_url:
            from services.output import save_mesh_from_url, get_run_dir
            run_dir = get_run_dir()
            local_path = await save_mesh_from_url(glb_url, run_dir)
            output["mesh"] = {"type": "Mesh", "value": str(local_path)}
        return output


async def handle_meshy_animate(
    node: GraphNode,
    inputs: dict[str, PortValueDict],
    api_keys: dict[str, str],
    emit: Callable[[ExecutionEvent], Awaitable[None]] | None = None,
) -> dict[str, Any]:
    api_key = api_keys.get("MESHY_API_KEY")
    if not api_key:
        raise ValueError("MESHY_API_KEY is required")

    rig_task_id_input = inputs.get("rig_task_id")
    if not rig_task_id_input or not rig_task_id_input.value:
        raise ValueError("Rig Task ID is required — connect from a Meshy Auto-Rig node")

    action_id = node.params.get("action_id")
    if not action_id:
        raise ValueError("Action ID is required — pick an animation from the library")

    headers = {
        "Authorization": f"Bearer {api_key}",
        "Content-Type": "application/json",
    }

    body: dict[str, Any] = {
        "rig_task_id": str(rig_task_id_input.value),
        "action_id": int(action_id),
    }

    # Optional post-processing
    fps = node.params.get("fps")
    if fps:
        body["post_process"] = {
            "operation_type": "change_fps",
            "fps": int(fps),
        }

    async def noop_emit(event: ExecutionEvent) -> None:
        pass

    _emit = emit or noop_emit

    async with httpx.AsyncClient(timeout=120.0) as client:
        resp = await client.post(
            f"{MESHY_API_BASE}/v1/animations",
            headers=headers,
            json=body,
        )
        if resp.status_code not in (200, 201, 202):
            raise RuntimeError(f"Meshy animation submit failed ({resp.status_code}): {resp.text}")

        task_data = resp.json()
        task_id = task_data.get("result") or task_data.get("id") or task_data.get("task_id")
        if not task_id:
            raise RuntimeError(f"Meshy did not return task ID: {task_data}")

        result_data = await _poll_meshy_task(
            client, api_key, f"{MESHY_API_BASE}/v1/animations/{task_id}", _emit, node.id
        )

        result_obj = result_data.get("result", {})
        glb_url = result_obj.get("animation_glb_url", "")
        if glb_url:
            from services.output import save_mesh_from_url, get_run_dir
            run_dir = get_run_dir()
            local_path = await save_mesh_from_url(glb_url, run_dir)
            return {"mesh": {"type": "Mesh", "value": str(local_path)}}
        return {"mesh": {"type": "Mesh", "value": str(result_data)}}


async def handle_meshy_remesh(
    node: GraphNode,
    inputs: dict[str, PortValueDict],
    api_keys: dict[str, str],
    emit: Callable[[ExecutionEvent], Awaitable[None]] | None = None,
) -> dict[str, Any]:
    api_key = api_keys.get("MESHY_API_KEY")
    if not api_key:
        raise ValueError("MESHY_API_KEY is required")

    model_url_input = inputs.get("model_url")
    if not model_url_input or not model_url_input.value:
        raise ValueError("Model URL input is required for remeshing")

    headers = {
        "Authorization": f"Bearer {api_key}",
        "Content-Type": "application/json",
    }

    body: dict[str, Any] = {
        "model_url": str(model_url_input.value),
    }

    SKIP_KEYS = {"endpoint_id"}
    for k, v in node.params.items():
        if k in SKIP_KEYS or v is None or v == "":
            continue
        if k == "target_formats" and isinstance(v, str):
            body[k] = [f.strip() for f in v.split(",") if f.strip()]
        else:
            body[k] = v

    async def noop_emit(event: ExecutionEvent) -> None:
        pass

    _emit = emit or noop_emit

    async with httpx.AsyncClient(timeout=120.0) as client:
        resp = await client.post(
            f"{MESHY_API_BASE}/v1/remesh",
            headers=headers,
            json=body,
        )
        if resp.status_code not in (200, 201, 202):
            raise RuntimeError(f"Meshy remesh submit failed ({resp.status_code}): {resp.text}")

        task_data = resp.json()
        task_id = task_data.get("result") or task_data.get("id") or task_data.get("task_id")
        if not task_id:
            raise RuntimeError(f"Meshy did not return task ID: {task_data}")

        result_data = await _poll_meshy_task(
            client, api_key, f"{MESHY_API_BASE}/v1/remesh/{task_id}", _emit, node.id
        )

        model_urls = result_data.get("model_urls", {})
        glb_url = model_urls.get("glb", "")
        if glb_url:
            from services.output import save_mesh_from_url, get_run_dir
            run_dir = get_run_dir()
            local_path = await save_mesh_from_url(glb_url, run_dir)
            return {"mesh": {"type": "Mesh", "value": str(local_path)}}
        return {"mesh": {"type": "Mesh", "value": str(result_data)}}


async def handle_meshy_text_to_image(
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
        raise ValueError("Prompt is required")

    headers = {
        "Authorization": f"Bearer {api_key}",
        "Content-Type": "application/json",
    }

    body: dict[str, Any] = {
        "ai_model": node.params.get("ai_model", "nano-banana"),
        "prompt": str(prompt_input.value),
    }

    for k in ("generate_multi_view", "pose_mode", "aspect_ratio"):
        v = node.params.get(k)
        if v is not None and v != "":
            body[k] = v

    async def noop_emit(event: ExecutionEvent) -> None:
        pass

    _emit = emit or noop_emit

    async with httpx.AsyncClient(timeout=120.0) as client:
        resp = await client.post(
            f"{MESHY_API_BASE}/v1/text-to-image",
            headers=headers,
            json=body,
        )
        if resp.status_code not in (200, 201, 202):
            raise RuntimeError(f"Meshy text-to-image submit failed ({resp.status_code}): {resp.text}")

        task_data = resp.json()
        task_id = task_data.get("result") or task_data.get("id") or task_data.get("task_id")
        if not task_id:
            raise RuntimeError(f"Meshy did not return task ID: {task_data}")

        result_data = await _poll_meshy_task(
            client, api_key, f"{MESHY_API_BASE}/v1/text-to-image/{task_id}", _emit, node.id
        )

        image_urls = result_data.get("image_urls", [])
        if not image_urls:
            raise RuntimeError(f"Meshy text-to-image returned no images: {result_data}")

        # Download the first image
        import base64 as _b64
        from services.output import save_base64_image, get_run_dir
        import httpx as _httpx

        async with _httpx.AsyncClient(timeout=60.0) as dl:
            img_resp = await dl.get(image_urls[0], follow_redirects=True)
            img_resp.raise_for_status()

        run_dir = get_run_dir()
        b64_data = _b64.b64encode(img_resp.content).decode("ascii")
        file_path = save_base64_image(b64_data, run_dir, extension="png")
        return {"image": {"type": "Image", "value": str(file_path)}}


async def handle_meshy_image_to_image(
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
        raise ValueError("Prompt is required")

    images_input = inputs.get("images")
    if not images_input or not images_input.value:
        raise ValueError("At least one reference image is required")

    image_values = images_input.value if isinstance(images_input.value, list) else [images_input.value]
    image_urls: list[str] = []
    for img in image_values[:5]:
        img_str = str(img)
        if not img_str.startswith(("http://", "https://", "data:")):
            img_path = Path(img_str)
            if not img_path.exists():
                raise ValueError(f"Image file not found: {img_str}")
            img_str = image_to_data_uri(img_path)
        image_urls.append(img_str)

    headers = {
        "Authorization": f"Bearer {api_key}",
        "Content-Type": "application/json",
    }

    body: dict[str, Any] = {
        "ai_model": node.params.get("ai_model", "nano-banana"),
        "prompt": str(prompt_input.value),
        "reference_image_urls": image_urls,
    }

    multi_view = node.params.get("generate_multi_view")
    if multi_view is not None:
        body["generate_multi_view"] = bool(multi_view)

    async def noop_emit(event: ExecutionEvent) -> None:
        pass

    _emit = emit or noop_emit

    async with httpx.AsyncClient(timeout=120.0) as client:
        resp = await client.post(
            f"{MESHY_API_BASE}/v1/image-to-image",
            headers=headers,
            json=body,
        )
        if resp.status_code not in (200, 201, 202):
            raise RuntimeError(f"Meshy image-to-image submit failed ({resp.status_code}): {resp.text}")

        task_data = resp.json()
        task_id = task_data.get("result") or task_data.get("id") or task_data.get("task_id")
        if not task_id:
            raise RuntimeError(f"Meshy did not return task ID: {task_data}")

        result_data = await _poll_meshy_task(
            client, api_key, f"{MESHY_API_BASE}/v1/image-to-image/{task_id}", _emit, node.id
        )

        image_result_urls = result_data.get("image_urls", [])
        if not image_result_urls:
            raise RuntimeError(f"Meshy image-to-image returned no images: {result_data}")

        import base64 as _b64
        from services.output import save_base64_image, get_run_dir
        import httpx as _httpx

        async with _httpx.AsyncClient(timeout=60.0) as dl:
            img_resp = await dl.get(image_result_urls[0], follow_redirects=True)
            img_resp.raise_for_status()

        run_dir = get_run_dir()
        b64_data = _b64.b64encode(img_resp.content).decode("ascii")
        file_path = save_base64_image(b64_data, run_dir, extension="png")
        return {"image": {"type": "Image", "value": str(file_path)}}


async def handle_meshy_3d_print(
    node: GraphNode,
    inputs: dict[str, PortValueDict],
    api_keys: dict[str, str],
    emit: Callable[[ExecutionEvent], Awaitable[None]] | None = None,
) -> dict[str, Any]:
    api_key = api_keys.get("MESHY_API_KEY")
    if not api_key:
        raise ValueError("MESHY_API_KEY is required")

    task_id_input = inputs.get("task_id")
    if not task_id_input or not task_id_input.value:
        raise ValueError("Task ID from a completed 3D generation is required")

    headers = {
        "Authorization": f"Bearer {api_key}",
        "Content-Type": "application/json",
    }

    body: dict[str, Any] = {
        "input_task_id": str(task_id_input.value),
    }

    max_colors = node.params.get("max_colors")
    if max_colors is not None and max_colors != "":
        body["max_colors"] = int(max_colors)

    max_depth = node.params.get("max_depth")
    if max_depth is not None and max_depth != "":
        body["max_depth"] = int(max_depth)

    async def noop_emit(event: ExecutionEvent) -> None:
        pass

    _emit = emit or noop_emit

    async with httpx.AsyncClient(timeout=120.0) as client:
        resp = await client.post(
            f"{MESHY_API_BASE}/v1/print/multi-color",
            headers=headers,
            json=body,
        )
        if resp.status_code not in (200, 201, 202):
            raise RuntimeError(f"Meshy 3D print submit failed ({resp.status_code}): {resp.text}")

        task_data = resp.json()
        task_id = task_data.get("result") or task_data.get("id") or task_data.get("task_id")
        if not task_id:
            raise RuntimeError(f"Meshy did not return task ID: {task_data}")

        result_data = await _poll_meshy_task(
            client, api_key, f"{MESHY_API_BASE}/v1/print/multi-color/{task_id}", _emit, node.id
        )

        model_urls = result_data.get("model_urls", {})
        # 3D print outputs 3MF format
        print_url = model_urls.get("3mf", "") or model_urls.get("glb", "")
        if print_url:
            from services.output import save_mesh_from_url, get_run_dir
            run_dir = get_run_dir()
            local_path = await save_mesh_from_url(print_url, run_dir)
            return {"mesh": {"type": "Mesh", "value": str(local_path)}}
        return {"mesh": {"type": "Mesh", "value": str(result_data)}}
