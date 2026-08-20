from __future__ import annotations

import asyncio
import base64
import sys
from pathlib import Path
from typing import Any, Awaitable, Callable
from uuid import uuid4

import httpx

from models.events import ExecutionEvent, ProgressEvent
from models.graph import GraphNode, PortValueDict
from services.cancellation import schedule_detached_cancel
from services.output import get_run_dir
from services.provider_capabilities import enforce_gemini_omni_capabilities

INTERACTIONS_URL = "https://generativelanguage.googleapis.com/v1beta/interactions"
FILES_URL = "https://generativelanguage.googleapis.com/v1beta/files"
MODEL_ID = "gemini-omni-flash-preview"


def _log(msg: str) -> None:
    print(f"[gemini-omni] {msg}", file=sys.stderr, flush=True)


async def _cancel_interaction(interaction_id: str, api_key: str) -> None:
    """Best-effort provider cancellation for a background Interaction.

    Google exposes POST /interactions/{id}/cancel for interactions that are
    still running. Use a fresh client because the handler's client is exiting
    while the cancelled execution task unwinds.
    """
    try:
        async with httpx.AsyncClient(timeout=15.0) as client:
            await client.post(
                f"{INTERACTIONS_URL}/{interaction_id}/cancel",
                headers={"x-goog-api-key": api_key},
            )
    except Exception:
        pass


def _mime_for_path(path: Path) -> str:
    suffix = path.suffix.lstrip(".").lower()
    return {
        "png": "image/png",
        "jpg": "image/jpeg",
        "jpeg": "image/jpeg",
        "webp": "image/webp",
        "gif": "image/gif",
        "mp4": "video/mp4",
        "webm": "video/webm",
        "mov": "video/quicktime",
    }.get(suffix, "application/octet-stream")


async def _load_bytes(value: str) -> tuple[bytes, str]:
    if value.startswith(("http://", "https://")):
        async with httpx.AsyncClient(timeout=120.0) as client:
            resp = await client.get(value)
            resp.raise_for_status()
            mime = resp.headers.get("content-type", "application/octet-stream").split(";")[0]
            return resp.content, mime
    if value.startswith("data:"):
        header, b64_data = value.split(",", 1)
        mime = header.split(":")[1].split(";")[0]
        return base64.b64decode(b64_data), mime
    path = Path(value)
    if not path.exists():
        raise ValueError(f"Media not found: {value}")
    return path.read_bytes(), _mime_for_path(path)


async def _build_input_parts(
    prompt: str,
    image_values: list[str],
    video_value: str | None,
) -> str | list[dict[str, Any]]:
    parts: list[dict[str, Any]] = []

    if video_value:
        if "generativelanguage.googleapis.com" in video_value and "/files/" in video_value:
            parts.append({"type": "document", "uri": video_value})
        else:
            data, mime = await _load_bytes(video_value)
            parts.append({
                "type": "video",
                "mime_type": mime,
                "data": base64.b64encode(data).decode("ascii"),
            })

    for img in image_values:
        data, mime = await _load_bytes(img)
        parts.append({
            "type": "image",
            "mime_type": mime,
            "data": base64.b64encode(data).decode("ascii"),
        })

    if prompt:
        parts.append({"type": "text", "text": prompt})

    if not parts:
        raise ValueError("Prompt, images, or video input is required")

    if len(parts) == 1 and parts[0]["type"] == "text":
        return str(parts[0]["text"])
    return parts


def _video_from_interaction(data: dict[str, Any]) -> tuple[bytes | None, str | None]:
    """Return inline video bytes or a Google-hosted download URI."""
    for step in data.get("steps", []):
        if step.get("type") != "model_output":
            continue
        for content in step.get("content", []):
            if content.get("type") != "video":
                continue
            if content.get("data"):
                return base64.b64decode(str(content["data"])), None
            if content.get("uri"):
                return None, str(content["uri"])
    out = data.get("output_video") or {}
    if out.get("data"):
        return base64.b64decode(str(out["data"])), None
    if out.get("uri"):
        return None, str(out["uri"])
    return None, None


async def _wait_for_file_active(
    client: httpx.AsyncClient,
    file_uri: str,
    api_key: str,
    *,
    max_polls: int = 120,
    poll_interval: float = 5.0,
) -> None:
    file_id = file_uri.rstrip("/").split("/files/")[-1].split(":")[0]
    poll_url = f"{FILES_URL}/{file_id}"
    for _ in range(max_polls):
        resp = await client.get(poll_url, headers={"x-goog-api-key": api_key})
        if resp.status_code != 200:
            raise RuntimeError(f"Gemini file poll failed ({resp.status_code}): {resp.text}")
        state = str(resp.json().get("state", "")).upper()
        if state == "ACTIVE":
            return
        if state == "FAILED":
            raise RuntimeError("Gemini Omni video file processing failed")
        await asyncio.sleep(poll_interval)
    raise RuntimeError("Timed out waiting for Gemini Omni video file to become ACTIVE")


async def _poll_interaction(
    client: httpx.AsyncClient,
    interaction_id: str,
    api_key: str,
    node_id: str,
    emit: Callable[[ExecutionEvent], Awaitable[None]],
    *,
    max_polls: int = 300,
    poll_interval: float = 3.0,
) -> dict[str, Any]:
    poll_url = f"{INTERACTIONS_URL}/{interaction_id}"
    for poll_num in range(1, max_polls + 1):
        await asyncio.sleep(poll_interval)
        resp = await client.get(poll_url, headers={"x-goog-api-key": api_key})
        if resp.status_code != 200:
            raise RuntimeError(f"Gemini Omni poll failed ({resp.status_code}): {resp.text}")
        data = resp.json()
        status = str(data.get("status", "")).lower()
        await emit(ProgressEvent(node_id=node_id, value=min(poll_num / max_polls, 0.99)))
        if status == "completed":
            return data
        if status in {"failed", "cancelled", "canceled"}:
            raise RuntimeError(f"Gemini Omni interaction {status}: {data.get('error', data)}")
    raise RuntimeError(f"Gemini Omni timed out after {max_polls} polls")


async def handle_gemini_omni(
    node: GraphNode,
    inputs: dict[str, PortValueDict],
    api_keys: dict[str, str],
    emit: Callable[[ExecutionEvent], Awaitable[None]] | None = None,
) -> dict[str, Any]:
    api_key = api_keys.get("GOOGLE_API_KEY")
    if not api_key:
        raise ValueError("GOOGLE_API_KEY is required")

    prompt_input = inputs.get("prompt")
    prompt_text = str(prompt_input.value).strip() if prompt_input and prompt_input.value else ""

    image_values: list[str] = []
    images_input = inputs.get("images")
    if images_input and images_input.value:
        raw = images_input.value
        image_values = [str(v) for v in raw if v] if isinstance(raw, list) else [str(raw)]

    video_value = None
    video_input = inputs.get("video")
    if video_input and video_input.value:
        video_value = str(video_input.value)

    previous_input = inputs.get("previous_interaction_id")
    previous_id = (
        previous_input.value
        if previous_input and previous_input.value
        else node.params.get("previous_interaction_id")
    )
    task = node.params.get("task")
    enforce_gemini_omni_capabilities(
        prompt_text,
        has_previous_interaction=bool(previous_id),
        has_video_input=bool(video_value),
        task=str(task) if task else None,
    )

    input_payload = await _build_input_parts(prompt_text, image_values, video_value)

    delivery = str(node.params.get("delivery") or "uri")
    request_body: dict[str, Any] = {
        "model": MODEL_ID,
        "input": input_payload,
        # Google only guarantees a URI in the initial creation response or SSE
        # stream. A synchronous unary request preserves that response; polling a
        # background interaction currently converts URI delivery to inline data.
        "background": delivery != "uri",
        "response_format": {
            "type": "video",
            "delivery": delivery,
        },
    }

    aspect_ratio = node.params.get("aspect_ratio") or node.params.get("aspectRatio")
    if aspect_ratio:
        request_body["response_format"]["aspect_ratio"] = str(aspect_ratio)

    if task:
        request_body["generation_config"] = {"video_config": {"task": str(task)}}

    if previous_id:
        request_body["previous_interaction_id"] = str(previous_id)

    async def noop_emit(event: ExecutionEvent) -> None:
        pass

    _emit = emit or noop_emit
    headers = {"x-goog-api-key": api_key, "Content-Type": "application/json"}

    _log("submitting interaction")
    async with httpx.AsyncClient(timeout=900.0) as client:
        resp = await client.post(INTERACTIONS_URL, json=request_body, headers=headers)
        if resp.status_code != 200:
            raise RuntimeError(f"Gemini Omni submit failed ({resp.status_code}): {resp.text}")

        data = resp.json()
        interaction_id = str(data.get("id") or "")
        status = str(data.get("status", "")).lower()
        if status not in {"completed", "succeeded"}:
            if not interaction_id:
                raise RuntimeError(f"Gemini Omni did not return interaction id: {data}")
            try:
                data = await _poll_interaction(
                    client, interaction_id, api_key, node.id, _emit
                )
            except asyncio.CancelledError:
                schedule_detached_cancel(
                    lambda: _cancel_interaction(interaction_id, api_key)
                )
                raise
            interaction_id = str(data.get("id") or interaction_id)

        video_bytes, video_uri = _video_from_interaction(data)
        if video_uri:
            await _wait_for_file_active(client, video_uri, api_key)
            dl_resp = await client.get(
                video_uri,
                headers={"x-goog-api-key": api_key},
                timeout=180.0,
                follow_redirects=True,
            )
            dl_resp.raise_for_status()
            video_bytes = dl_resp.content

        if not video_bytes:
            raise RuntimeError("Gemini Omni completed but returned no video")

        run_dir = get_run_dir()
        out_path = run_dir / f"{uuid4().hex[:12]}.mp4"
        out_path.write_bytes(video_bytes)
        _log(f"saved video to {out_path}")

        result: dict[str, Any] = {
            "video": {"type": "Video", "value": str(out_path)},
        }
        if interaction_id:
            result["interaction_id"] = {"type": "Text", "value": interaction_id}
        return result
