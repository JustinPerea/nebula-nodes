"""BytePlus ModelArk: ByteDance's own international API for Seedream and Seedance.

One client for every ModelArk call Nebula makes, with the person's
``BYTEPLUS_API_KEY``: Seedream image generation (a direct route for the fal
and Krea Seedream copies, execution/maker_routes_byteplus.py) and Seedance
video tasks (execution/maker_routes_byteplus_seedance.py):
``POST {base}/contents/generations/tasks`` creates a task, ``GET`` and
``DELETE {base}/contents/generations/tasks/{id}`` poll and cancel it
(:func:`run_video_task`).

Vendor facts, read from BytePlus's own docs on 2026-10-14:

- Base URL, Asia Pacific (Johor, ap-southeast-1):
  "Data plane API: https://ark.ap-southeast.bytepluses.com/api/v3"
  (ModelArk/base-url-and-authentication). Only this region is wired: every
  Seedance model is AP-only, and "Platform-level resources, such as API keys
  and model activation status, are isolated by region" (region-availability),
  so a key from the EU console won't work here.
- Auth: "Authorization: Bearer $ARK_API_KEY"; the image API "only supports API
  Key authentication" (image-generation-api).
- Availability: "The BytePlus Model Services are not available in the United
  States." (BytePlus Service Specific Terms, Model Services, current version
  after the Sep 30, 2026 one; docs.byteplus.com/en/docs/legal/docs-service-
  specific-terms).
- Models must be activated first: 404 ModelNotOpen "Your account %s has not
  activated the model %s. Please activate the model service in the Ark
  Console." Seedance 2.x activation needs "Credits reach USD 30" (or a USD 30
  AI Savings Plan or resource pack; seedance-model-activation-usage-and-refund).
- Error bodies carry ``error {code, message}`` (image-generation-api: "Top-level
  error information returned when the request fails"); the full envelope of a
  synchronous HTTP error isn't shown in the docs, so parsing is defensive and
  falls back to the raw text.
"""
from __future__ import annotations

import base64
from typing import Any
from urllib.parse import quote

import httpx

from execution.missing_credential import MissingCredentialError

BYTEPLUS_KEY = "BYTEPLUS_API_KEY"
BYTEPLUS_BASE_URL = "https://ark.ap-southeast.bytepluses.com/api/v3"
# Linked from BytePlus's docs ("Model activation", image-generation-api) and the
# Seedance activation rules page.
ACTIVATION_URL = "https://ai.byteplus.com/ark/region:ap-southeast-1/openManagement"
SEEDANCE_ACTIVATION_DOC = "https://docs.byteplus.com/en/docs/ModelArk/seedance-model-activation-usage-and-refund"
API_KEYS_URL = "https://ai.byteplus.com/ark/region:ap-southeast-1/apiKey"
_TIMEOUT = httpx.Timeout(300.0, connect=30.0)


class BytePlusError(RuntimeError):
    """A ModelArk request that failed, with BytePlus's code and a readable fix."""

    def __init__(self, status: int, code: str, message: str, text: str):
        self.status = status
        self.code = code
        self.vendor_message = message
        super().__init__(text)


def api_key(api_keys: dict[str, str]) -> str:
    key = (api_keys.get(BYTEPLUS_KEY) or "").strip()
    if not key:
        raise MissingCredentialError(f"{BYTEPLUS_KEY} is required")
    return key


def _error_fields(response: httpx.Response) -> tuple[str, str]:
    try:
        body = response.json()
    except ValueError:
        return "", response.text.strip()[:500]
    error = body.get("error") if isinstance(body, dict) else None
    if isinstance(error, dict):
        return str(error.get("code") or ""), str(error.get("message") or "")
    if isinstance(body, dict) and (body.get("code") or body.get("message")):
        return str(body.get("code") or ""), str(body.get("message") or "")
    return "", response.text.strip()[:500]


def explain(status: int, code: str, message: str, model: str | None = None) -> str:
    """BytePlus's error, plus what the person can do about it.

    Codes and meanings from docs.byteplus.com/en/docs/ModelArk/error-codes
    (checked 2026-10-14)."""
    what = f"BytePlus ModelArk error {status}{f' {code}' if code else ''}: {message or 'no message'}"
    model_name = model or "this model"
    if status == 401 or code == "AuthenticationError":
        return (f"{what}. BytePlus rejected the API key: check {BYTEPLUS_KEY} in Settings. It must be a ModelArk "
                f"API key from the Asia Pacific (ap-southeast-1) console ({API_KEYS_URL}); keys are region-scoped.")
    if code == "ModelNotOpen" or code.startswith("InvalidEndpointOrModel") or code == "OperationDenied.ServiceNotOpen":
        return (f"{what}. Your BytePlus account hasn't activated {model_name}. Activate it on the ModelArk console's "
                f"Model activation page ({ACTIVATION_URL}), then run again. Seedance 2.x models need USD 30 of "
                f"credits, a USD 30 AI Savings Plan or a USD 30 resource pack before they can be activated "
                f"({SEEDANCE_ACTIVATION_DOC}).")
    if code in ("AccountOverdueError", "OperationDenied.ServiceOverdue"):
        return f"{what}. The BytePlus account has an overdue balance: top it up in the BytePlus Billing Center."
    if code == "QuotaExceeded":
        return (f"{what}. BytePlus uses this code for an exhausted free-trial quota (activate {model_name} on the "
                f"Model activation page, {ACTIVATION_URL}) and for too many queued tasks (wait for some to finish).")
    if status == 429:
        return f"{what}. BytePlus rate limit; wait a moment and run again."
    if "SensitiveContentDetected" in code:
        return f"{what}. BytePlus's sensitive content filter rejected this request; change the prompt or inputs."
    return what


async def request(
    method: str, path: str, key: str, *, json: dict[str, Any] | None = None, model: str | None = None,
    client: httpx.AsyncClient | None = None,
) -> dict[str, Any]:
    """One ModelArk data-plane call; a non-2xx answer raises BytePlusError."""
    url = f"{BYTEPLUS_BASE_URL}{path}"
    headers = {"Authorization": f"Bearer {key}", "Content-Type": "application/json"}
    if client is None:
        async with httpx.AsyncClient(timeout=_TIMEOUT) as owned:
            response = await owned.request(method, url, headers=headers, json=json)
    else:
        response = await client.request(method, url, headers=headers, json=json)
    if response.status_code >= 400:
        code, message = _error_fields(response)
        raise BytePlusError(response.status_code, code, message, explain(response.status_code, code, message, model))
    if not response.content:
        return {}
    try:
        data = response.json()
    except ValueError as exc:
        raise RuntimeError(f"BytePlus ModelArk returned non-JSON ({response.status_code})") from exc
    if not isinstance(data, dict):
        raise RuntimeError("BytePlus ModelArk returned an unexpected response")
    return data


async def generate_images(key: str, body: dict[str, Any]) -> list[tuple[bytes, str]]:
    """POST /images/generations (synchronous) and return each image as (bytes, extension).

    ``body`` must ask for ``response_format: b64_json``, so the images come back
    inline instead of as 24-hour URLs. A request that made no image raises with
    BytePlus's top-level ``error``; in a sequential batch, images that failed
    (``data[].error``) are skipped and aren't billed ("Billing is based only on
    successfully generated images", image-generation-api)."""
    model = str(body.get("model") or "")
    data = await request("POST", "/images/generations", key, json=body, model=model)
    error = data.get("error")
    if isinstance(error, dict) and (error.get("code") or error.get("message")):
        code, message = str(error.get("code") or ""), str(error.get("message") or "")
        raise BytePlusError(200, code, message, explain(200, code, message, model))
    images: list[tuple[bytes, str]] = []
    failures: list[str] = []
    for item in data.get("data") or []:
        if not isinstance(item, dict):
            continue
        if item.get("b64_json"):
            raw = base64.b64decode(item["b64_json"])
            # The file's own bytes decide the extension (4.x answers jpeg and
            # takes no output_format; the 5.0 models default to jpeg).
            fmt = str(item.get("output_format") or "jpeg").lower()
            extension = "png" if raw.startswith(b"\x89PNG") else "jpeg" if raw.startswith(b"\xff\xd8") else (
                "png" if fmt == "png" else "jpeg")
            images.append((raw, extension))
        elif isinstance(item.get("error"), dict):
            failures.append(str(item["error"].get("code") or item["error"].get("message") or "error"))
    if not images:
        detail = f" ({', '.join(failures)})" if failures else ""
        raise RuntimeError(f"BytePlus ModelArk returned no image for {model or 'the request'}{detail}")
    return images


# -- Seedance video tasks --------------------------------------------------------
# docs.byteplus.com/en/docs/ModelArk/{create-video-generation-task-api,
# get-video-generation-task-api, cancel-or-delete-video-generation-tasks-api},
# read 2026-10-14:
# - POST /contents/generations/tasks returns {"id": ...}; "The video generation
#   task creation is an asynchronous API".
# - GET /contents/generations/tasks/{id}: status "queued", "running",
#   "cancelled", "succeeded" or "failed" (callbacks add "expired": "the task
#   has been in the running or queued state for longer than the expiration
#   time"); content.video_url "is valid for 24 hours" (Seedance 2.5 URLs "can be
#   downloaded up to 100 times"), so a run saves it at once; error {code,
#   message} on failure; usage.completion_tokens is what BytePlus bills.
# - DELETE on a queued task: "The task is removed from the queue and its status
#   is updated to cancelled". A running task "can't" be cancelled, so a
#   cancelled run whose task already started still finishes on BytePlus.
VIDEO_TASKS_PATH = "/contents/generations/tasks"
TASK_SUCCEEDED = "succeeded"
TASK_FAILED = frozenset({"failed", "cancelled", "expired"})
POLL_INTERVAL = 5.0
# Polling stops after this long. Requests also send execution_expires_after
# 3600 (the documented minimum), so BytePlus expires a task Nebula stopped
# waiting for instead of finishing (and billing) it later.
POLL_TIMEOUT = 3900.0
TASK_EXPIRES_AFTER = 3600


async def create_video_task(key: str, body: dict[str, Any], *, client: httpx.AsyncClient | None = None) -> str:
    model = str(body.get("model") or "")
    data = await request("POST", VIDEO_TASKS_PATH, key, json=body, model=model, client=client)
    task_id = data.get("id")
    if not isinstance(task_id, str) or not task_id:
        raise RuntimeError(f"BytePlus ModelArk accepted the {model or 'video'} task but returned no task id")
    return task_id


async def get_video_task(key: str, task_id: str, *, client: httpx.AsyncClient | None = None) -> dict[str, Any]:
    return await request("GET", f"{VIDEO_TASKS_PATH}/{quote(task_id, safe='')}", key, client=client)


async def cancel_video_task(key: str, task_id: str) -> None:
    """Best effort: DELETE a task Nebula no longer waits for (only a queued task
    can be cancelled). Runs on a detached task with its own client."""
    try:
        await request("DELETE", f"{VIDEO_TASKS_PATH}/{quote(task_id, safe='')}", key)
    except Exception:  # noqa: BLE001 - fire and forget
        pass


def _schedule_cancel(key: str, task_id: str) -> None:
    from services.cancellation import schedule_detached_cancel

    schedule_detached_cancel(lambda: cancel_video_task(key, task_id))


async def run_video_task(
    key: str, body: dict[str, Any], *, node_id: str = "", emit: Any = None,
    poll_interval: float | None = None, timeout: float | None = None,
) -> dict[str, Any]:
    """Create a Seedance task and poll it to ``succeeded``; returns the task.

    A failed, cancelled or expired task raises with BytePlus's error and what
    to do about it. If the run is cancelled (or polling times out), the task
    is DELETEd so a queued one never starts."""
    import asyncio

    model = str(body.get("model") or "")
    poll_interval = POLL_INTERVAL if poll_interval is None else poll_interval
    timeout = POLL_TIMEOUT if timeout is None else timeout
    async with httpx.AsyncClient(timeout=_TIMEOUT) as client:
        task_id = await create_video_task(key, body, client=client)
        loop = asyncio.get_running_loop()
        started = loop.time()
        polls = 0
        while True:
            try:
                await asyncio.sleep(poll_interval)
                task = await get_video_task(key, task_id, client=client)
            except asyncio.CancelledError:
                _schedule_cancel(key, task_id)
                raise
            polls += 1
            status = str(task.get("status") or "")
            if status == TASK_SUCCEEDED:
                return task
            if status in TASK_FAILED:
                error = task.get("error") if isinstance(task.get("error"), dict) else {}
                code, message = str(error.get("code") or ""), str(error.get("message") or f"task {status}")
                raise BytePlusError(200, code, message, explain(200, code, message, model))
            if emit is not None:
                from models.events import ProgressEvent

                # BytePlus reports no percentage; creep toward done.
                await emit(ProgressEvent(node_id=node_id, value=min(0.95, polls / (polls + 20))))
            if loop.time() - started > timeout:
                _schedule_cancel(key, task_id)
                raise RuntimeError(
                    f"BytePlus ModelArk task {task_id} ({model}) was still {status or 'pending'} after "
                    f"{int(timeout // 60)} minutes; Nebula stopped waiting and asked BytePlus to cancel it "
                    f"(a task that has started can't be cancelled; it expires {TASK_EXPIRES_AFTER // 60} minutes "
                    "after creation).")
