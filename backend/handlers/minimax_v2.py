"""MiniMax video generation V2 (MiniMax H3) on the person's MINIMAX_API_KEY.

Contract, read 2026-10-14 from MiniMax's own reference:
- POST /v2/video_generation {model, content, resolution, duration, ratio}
  (platform.minimax.io/docs/api-reference/video-generation-v2-create.md).
  "Every request must include one non-empty `text` item"; images carry a
  ``role`` of first_frame / last_frame / reference_image, videos
  reference_video, audio reference_audio. "Image-to-video and
  reference-to-video are mutually exclusive". Counts: "first frame <= 1, last
  frame <= 1, reference images <= 9"; video "Count <= 3"; audio "Count <= 3".
  Text-to-video ratio "is required and cannot be `adaptive`"; image-to-video
  ratio "is always `adaptive`".
- GET /v2/query/video_generation/{task_id}: task.status queued / running /
  succeeded / failed / cancelled; the video is task.content.url
  (video-generation-v2-query.md).
- DELETE /v2/video_generation/{task_id} cancels a queued task, "no charge";
  a running task can't be cancelled (video-generation-v2-delete.md).
- "To use MiniMax H3 or MiniMax H3 Max, please select the Pay-as-you-go API";
  Video Packages: "MiniMax H3 is not supported yet" (pricing/overview.md).
  M Plan Explore/Build include H3 on a Subscription Key (m-plan/faq.md).
"""
from __future__ import annotations

import asyncio
import base64
import mimetypes
import sys
from pathlib import Path
from typing import Any, Awaitable, Callable
from urllib.parse import quote

import httpx

from execution.missing_credential import MissingCredentialError
from execution.poll_retry import UpstreamTask, poll_request
from handlers.minimax import submit_task
from models.events import ExecutionEvent, ProgressEvent
from models.graph import GraphNode, PortValueDict
from services.cancellation import schedule_detached_cancel
from services.output import get_run_dir, save_video_from_url

MAX_REFERENCE_IMAGES = 9
MAX_REFERENCE_VIDEOS = 3
MAX_REFERENCE_AUDIOS = 3
RATIOS = ("21:9", "16:9", "4:3", "1:1", "3:4", "9:16")
POLL_INTERVAL = 5.0
MAX_POLLS = 360
PLAN_HINT = (
    "MiniMax says H3 needs the pay-as-you-go API (a standard API key with account balance) or an M Plan "
    "Explore/Build Subscription Key; Video Packages don't cover H3 yet "
    "(https://platform.minimax.io/docs/pricing/overview#models/video)."
)
# MiniMax's per-file and body limits (video-generation-v2-create.md, read
# 2026-10-14): image "≤ 30 MB", video "≤ 50 MB", audio "≤ 15 MB", and "total
# request body ≤ 64 MB; use public URLs for large files, avoid Base64".
MAX_FILE_BYTES = {"image": 30_000_000, "video": 50_000_000, "audio": 15_000_000}
MAX_BODY_BYTES = 64_000_000
_MEDIA_KINDS = {"image": "image_url", "video": "video_url", "audio": "audio_url"}


def _log(msg: str) -> None:
    print(f"[minimax-v2] {msg}", file=sys.stderr, flush=True)


def media_url(value: str, kind: str) -> str:
    """A URL MiniMax can read: a public URL, an mm_file:// id or a data URI.
    Owned outputs (/api/outputs refs, or loopback URLs to them) and local
    files become data URIs, after the file policy and MiniMax's per-file cap
    (MAX_FILE_BYTES) are checked and before any byte is read."""
    from services.media_input import owned_output_value, read_local_media

    value = owned_output_value(str(value))
    if value.startswith(("https://", "http://", "data:", "mm_file://")):
        return value
    path, data = read_local_media(Path(value), label=f"MiniMax H3 {kind} input", max_bytes=MAX_FILE_BYTES[kind])
    mime = (mimetypes.guess_type(path.name)[0] or {"image": "image/png", "video": "video/mp4",
                                                  "audio": "audio/mpeg"}[kind]).lower()
    return f"data:{mime};base64,{base64.b64encode(data).decode('ascii')}"


def _values(port: PortValueDict | None) -> list[str]:
    if port is None or port.value in (None, ""):
        return []
    values = port.value if isinstance(port.value, list) else [port.value]
    return [str(value) for value in values if value not in (None, "")]


def build_content(inputs: dict[str, PortValueDict]) -> tuple[list[dict[str, Any]], str]:
    """The V2 ``content`` array from the inputs, and the scenario (t2v, i2v, r2v)."""
    prompt = " ".join(_values(inputs.get("prompt"))).strip()
    if not prompt:
        raise ValueError("MiniMax H3 needs a prompt")
    content: list[dict[str, Any]] = [{"type": "text", "text": prompt}]
    frames = [(role, _values(inputs.get(role))) for role in ("first_frame", "last_frame")]
    refs = [("reference_image", "image", _values(inputs.get("reference_images")), MAX_REFERENCE_IMAGES),
            ("reference_video", "video", _values(inputs.get("reference_videos")), MAX_REFERENCE_VIDEOS),
            ("reference_audio", "audio", _values(inputs.get("reference_audios")), MAX_REFERENCE_AUDIOS)]
    has_frames = any(values for _, values in frames)
    has_refs = any(values for _, _, values, _ in refs)
    if has_frames and has_refs:
        raise ValueError("MiniMax H3 takes either a start/end image or references (images, videos, audio), "
                         "not both in one run.")
    for role, values in frames:
        if len(values) > 1:
            raise ValueError(f"MiniMax H3 takes one {role.replace('_', ' ')} image")
        for value in values:
            content.append({"type": "image_url", "image_url": {"url": media_url(value, "image")}, "role": role})
    for role, kind, values, limit in refs:
        if len(values) > limit:
            raise ValueError(f"MiniMax H3 takes at most {limit} reference {kind}s (got {len(values)})")
        for value in values:
            field = _MEDIA_KINDS[kind]
            content.append({"type": field, field: {"url": media_url(value, kind)}, "role": role})
    inline = sum(len(item[item["type"]]["url"]) for item in content[1:] if item[item["type"]]["url"].startswith("data:"))
    if inline > MAX_BODY_BYTES:
        raise ValueError(f"MiniMax H3 takes a request of up to {MAX_BODY_BYTES // 1_000_000} MB, and these local "
                         f"files make it about {inline // 1_000_000} MB once encoded. Use public URLs for the "
                         "larger files.")
    return content, "i2v" if has_frames else "r2v" if has_refs else "t2v"


def _error_text(response: httpx.Response) -> str:
    try:
        data = response.json()
    except ValueError:
        return response.text
    error = data.get("error") if isinstance(data, dict) else None
    if isinstance(error, dict) and error.get("message"):
        return str(error["message"])
    return response.text


async def _cancel(url: str, api_key: str) -> None:
    """Best effort: MiniMax cancels a queued task at no charge; a running one can't be stopped."""
    try:
        async with httpx.AsyncClient(timeout=10.0) as client:
            await client.delete(url, headers={"Authorization": f"Bearer {api_key}"})
    except Exception:
        pass


async def handle_minimax_video_v2(
    node: GraphNode,
    inputs: dict[str, PortValueDict],
    api_keys: dict[str, str],
    emit: Callable[[ExecutionEvent], Awaitable[None]] | None = None,
) -> dict[str, Any]:
    api_key = api_keys.get("MINIMAX_API_KEY")
    if not api_key or not api_key.strip():
        raise MissingCredentialError("MINIMAX_API_KEY is required")
    params = node.params
    model = str(params.get("model") or "MiniMax-H3")
    content, scenario = build_content(inputs)
    ratio = str(params.get("ratio") or "")
    if scenario == "t2v" and ratio not in RATIOS:
        raise ValueError("MiniMax H3 text-to-video needs a set aspect ratio (not adaptive). Pick one, or connect "
                         "a start image.")
    body: dict[str, Any] = {"model": model, "content": content,
                            "resolution": str(params.get("resolution") or "2K"),
                            "duration": int(params.get("duration") or 5)}
    # Image-to-video: "the aspect ratio is determined by the input image".
    body["ratio"] = "adaptive" if scenario == "i2v" else ratio or "adaptive"
    headers = {"Authorization": f"Bearer {api_key}", "Content-Type": "application/json"}

    async def noop(_event: ExecutionEvent) -> None:
        pass

    _emit = emit or noop
    async with httpx.AsyncClient(timeout=120.0) as client:
        base, response = await submit_task(client, "/v2/video_generation", headers, body)
        if response.status_code not in (200, 201, 202):
            detail = _error_text(response)
            hint = f" {PLAN_HINT}" if response.status_code in (401, 402, 403) else ""
            raise RuntimeError(f"MiniMax H3 submit failed ({response.status_code}): {detail}.{hint}")
        task_id = str((response.json() or {}).get("task_id") or "")
        if not task_id:
            raise RuntimeError(f"MiniMax H3 returned no task_id: {response.text}")
        _log(f"task {task_id} on {base}")
        query = f"{base}/v2/query/video_generation/{quote(task_id, safe='')}"
        cancel_url = f"{base}/v2/video_generation/{quote(task_id, safe='')}"
        poll_headers = {"Authorization": f"Bearer {api_key}"}
        # Transient poll errors are retried; polling that stops before a
        # terminal state cancels the task (execution/poll_retry.py).
        with UpstreamTask(lambda: _cancel(cancel_url, api_key), schedule_detached_cancel) as upstream:
            for poll in range(1, MAX_POLLS + 1):
                await asyncio.sleep(POLL_INTERVAL)
                polled = await poll_request(lambda: client.get(query, headers=poll_headers))
                if polled.status_code != 200:
                    raise RuntimeError(f"MiniMax H3 poll failed ({polled.status_code}): {_error_text(polled)}")
                task = (polled.json() or {}).get("task") or {}
                status = task.get("status")
                await _emit(ProgressEvent(node_id=node.id, value=min(poll / MAX_POLLS, 0.99)))
                if status == "succeeded":
                    upstream.finished = True
                    url = str((task.get("content") or {}).get("url") or "")
                    if not url:
                        raise RuntimeError("MiniMax H3 succeeded without a video URL")
                    path = await save_video_from_url(url, get_run_dir())
                    return {"video": {"type": "Video", "value": str(path)}}
                if status in ("failed", "cancelled"):
                    upstream.finished = True
                    error = task.get("error") or {}
                    code = f" ({error['code']})" if error.get("code") else ""
                    raise RuntimeError(f"MiniMax H3 task {status}: {error.get('message') or 'no reason given'}{code}")
            raise RuntimeError(f"MiniMax H3 task timed out after {MAX_POLLS} polls")
