from __future__ import annotations

import asyncio
import sys
from pathlib import Path
from typing import Any, Awaitable, Callable
from urllib.parse import quote

import httpx

from models.graph import GraphNode, PortValueDict
from models.events import ExecutionEvent, ProgressEvent
from services.output import get_run_dir, image_to_data_uri, resolve_output_ref, save_video_from_url
from execution.missing_credential import MissingCredentialError
from execution.person_line import (as_person_line, missing_file_line, slow_job_line, status_line, with_person_line,
                                   with_provider_line)

MINIMAX_API_BASE = "https://api.minimaxi.com"
# MiniMax keys belong to one region: "The API host and key vary by region and
# must match; otherwise, you'll encounter an `Invalid API key` error" (Global
# https://api.minimax.io, Mainland https://api.minimaxi.com;
# github.com/MiniMax-AI/MiniMax-MCP README, read 2026-10-14). Nebula has always
# called Mainland, so that stays first; a key Mainland rejects as unknown is
# tried on Global. A rejected key is never billed, and a key is valid on only
# one platform, so the order never changes who bills a run.
MINIMAX_GLOBAL_API_BASE = "https://api.minimax.io"
MINIMAX_API_BASES = (MINIMAX_API_BASE, MINIMAX_GLOBAL_API_BASE)
# "1004, Account authentication failed", "2049, Invalid API Key"
# (platform.minimax.io/docs/api-reference/errorcode).
_AUTH_ERROR_CODES = {1004, 2049}
# "1008, insufficient balance", "2053, insufficient credit" (same page, read
# 2026-10-22).
_NO_BALANCE_CODES = {1008, 2053}


def _log(msg: str) -> None:
    print(f"[minimax] {msg}", file=sys.stderr, flush=True)


def _rejected_key(response: httpx.Response) -> bool:
    """True when MiniMax refused the key itself (wrong region or unknown key).

    V1 answers HTTP 200 with ``base_resp.status_code``; V2 answers 401 with
    an OpenAI-style error whose message ends in the code, e.g. "... (1004)"."""
    if response.status_code == 401:
        return True
    try:
        data = response.json()
    except ValueError:
        return False
    if not isinstance(data, dict):
        return False
    base = data.get("base_resp")
    if isinstance(base, dict) and base.get("status_code") in _AUTH_ERROR_CODES:
        return True
    error = data.get("error")
    message = str(error.get("message") or "") if isinstance(error, dict) else ""
    return any(message.rstrip().endswith(f"({code})") for code in _AUTH_ERROR_CODES)


async def submit_task(
    client: httpx.AsyncClient, path: str, headers: dict[str, str], body: dict[str, Any],
) -> tuple[str, httpx.Response]:
    """POST a generation task on the key's region: (base URL that took it, response).

    The next host is tried when this one refused the key, or answered 404
    because it doesn't serve the path. MiniMax documents H3's
    /v2/video_generation on api.minimax.io and, for Mainland, on
    api.minimax.cn (platform.minimax.cn/docs/api-reference/
    video-generation-v2-create.md, read 2026-10-14), not on api.minimaxi.com.
    Neither answer creates a task, so neither is billed."""
    response: httpx.Response | None = None
    for base in MINIMAX_API_BASES:
        _log(f"submitting to {base}{path}")
        response = await client.post(f"{base}{path}", headers=headers, json=body)
        if not _rejected_key(response) and response.status_code != 404:
            return base, response
    assert response is not None
    return MINIMAX_API_BASES[-1], response


def _resolve_image_url(value: str) -> str:
    """Return the value as-is if it's a URL/data URI, otherwise convert local path to data URI."""
    # A saved graph carries /api/outputs/... refs; MiniMax can't fetch those.
    value = resolve_output_ref(value)
    if value.startswith(("http://", "https://", "data:")):
        return value
    image_path = Path(value)
    if not image_path.exists():
        raise with_person_line(ValueError(f"Image file not found: {value}"), missing_file_line("image file"))
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
        raise MissingCredentialError("MINIMAX_API_KEY is required")

    # Determine variant from connected inputs.
    # Port ids in the registry: T2V="prompt", I2V="first_frame_image", S2V="subject_reference".
    prompt_input = inputs.get("prompt")
    first_frame_input = inputs.get("first_frame_image")
    last_frame_input = inputs.get("last_frame_image")
    subject_input = inputs.get("subject_reference")

    prompt = str(prompt_input.value) if prompt_input and prompt_input.value else ""

    # S2V — subject reference video (no duration/resolution params accepted by API)
    if subject_input and subject_input.value:
        _log("variant=S2V")
        body: dict[str, Any] = {
            "prompt": prompt,
            "model": node.params.get("model", "S2V-01"),
        }
        subject_url = _resolve_image_url(str(subject_input.value))
        body["subject_reference"] = [{"type": "character", "image": [subject_url]}]

    # FL2V — first & last frame (MiniMax-Hailuo-02 only; the first frame is optional)
    elif last_frame_input and last_frame_input.value:
        _log("variant=FL2V")
        body = {
            "prompt": prompt,
            "model": node.params.get("model", "MiniMax-Hailuo-02"),
            "last_frame_image": _resolve_image_url(str(last_frame_input.value)),
            "duration": node.params.get("duration", 6),
            "resolution": node.params.get("resolution", "768P"),
        }
        if first_frame_input and first_frame_input.value:
            body["first_frame_image"] = _resolve_image_url(str(first_frame_input.value))

    # I2V — image to video (first frame required)
    elif first_frame_input and first_frame_input.value:
        _log("variant=I2V")
        body = {
            "prompt": prompt,
            "model": node.params.get("model", "MiniMax-Hailuo-2.3"),
            "first_frame_image": _resolve_image_url(str(first_frame_input.value)),
            "duration": node.params.get("duration", 6),
            "resolution": node.params.get("resolution", "768P"),
        }

    # T2V — text to video (default)
    else:
        _log("variant=T2V")
        body = {
            "prompt": prompt,
            "model": node.params.get("model", "MiniMax-Hailuo-2.3"),
            "duration": node.params.get("duration", 6),
            "resolution": node.params.get("resolution", "768P"),
        }

    if not prompt:
        raise as_person_line(ValueError("Prompt input is required"))
    # "Whether to automatically optimize the `prompt`. Defaults to `true`." Sent
    # only when a node sets it (the Krea copies' expand_prompt).
    if isinstance(node.params.get("prompt_optimizer"), bool):
        body["prompt_optimizer"] = node.params["prompt_optimizer"]

    _log(f"model={body['model']}, body keys: {list(body.keys())}")

    headers = {
        "Authorization": f"Bearer {api_key}",
        "Content-Type": "application/json",
    }

    async def noop_emit(event: ExecutionEvent) -> None:
        pass

    _emit = emit or noop_emit

    async with httpx.AsyncClient(timeout=60.0) as client:
        # Step 1: Submit generation task (on the key's region)
        api_base, resp = await submit_task(client, "/v1/video_generation", headers, body)
        _log(f"submit response: {resp.status_code}")
        if resp.status_code not in (200, 201, 202):
            raise RuntimeError(f"MiniMax submit failed ({resp.status_code}): {resp.text}")

        submit_data = resp.json()
        _log(f"submit_data: {submit_data}")
        task_id = submit_data.get("task_id")
        if not task_id:
            # V1 says a refused key (after every region) or an empty balance
            # with its own code in an HTTP 200, so the card reads the code,
            # not the missing task id (error copy 3d review).
            base_resp = submit_data.get("base_resp") if isinstance(submit_data, dict) else None
            code = base_resp.get("status_code") if isinstance(base_resp, dict) else None
            exc = RuntimeError(f"MiniMax did not return task_id: {submit_data}")
            if code in _AUTH_ERROR_CODES:
                raise with_provider_line(exc, status_line("key", "MiniMax"))
            if code in _NO_BALANCE_CODES:
                raise with_provider_line(exc, status_line("credits", "MiniMax"))
            raise exc

        # Step 2: Poll for completion
        _log(f"polling task_id={task_id}")
        poll_url = f"{api_base}/v1/query/video_generation"
        max_polls = 300
        poll_interval = 5.0

        # MiniMax exposes no documented cancel endpoint — task cancels locally only.
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
                    f"{api_base}/v1/files/retrieve/{quote(str(file_id), safe='')}",
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
        raise with_person_line(RuntimeError(f"MiniMax task timed out after {max_polls} polls"), slow_job_line("MiniMax"))
