"""Black Forest Labs: FLUX on BFL's own API, with the person's ``BFL_API_KEY``.

One client for every BFL call Nebula makes. Every FLUX 3 endpoint (and FLUX.2)
works the same way: ``POST https://api.bfl.ai/v1/<path>`` with a JSON body
submits a task, the answer's ``polling_url`` is polled until the task is
``Ready``, and ``result.sample`` is downloaded (:func:`run_task`). No node uses
this client yet; the FLUX 3 nodes wire it as their maker route.

Vendor facts, read from api.bfl.ai/openapi.json and docs.bfl.ai on 2026-10-15:

- Auth: an ``x-key`` header (OpenAPI securityScheme APIKeyHeader). Keys come
  from dashboard.bfl.ai (API -> Keys), scoped to a project; credits belong to
  the organization (account_management/credits_billing).
- Submit answers AsyncResponse ``{id, polling_url, cost, input_mp, output_mp}``
  (cost in credits; "1 credit = $0.01 USD", quick_start/pricing). The client
  "**must** use the ``polling_url`` returned in the initial request response"
  (integration_guidelines); it is absolute, so the key would go wherever it
  points: :func:`polling_url_allowed` only lets it reach an https ``*.bfl.ai``
  host.
- Poll answers ``{id, status, result, progress, details, preview}`` and, once
  settled, ``cost`` (SettledCostResultResponse). Status is one of "Task not
  found", "Pending", "Reasoning", "Generating", "Request Moderated", "Content
  Moderated", "No Card Generated", "Ready", "Error". "A failed task can come
  back as HTTP ``503`` with a normal JSON body. Read ``status`` from the body
  before treating a ``503`` as a retryable outage" (flux3_image_generate).
- Moderated results carry ``details["Moderation Reasons"]``, a list of
  categories (api_integration/errors).
- ``result.sample`` is a signed URL that expires (10 minutes in the general
  guide, 1 hour for FLUX 3 Image, "about 2 hours" for FLUX 3 video), so a run
  downloads it at once, and "don't send your ``x-key`` header to it"
  (flux3_image_generate).
- HTTP errors: 400, 402 ("insufficient credits"), 403, 422 (``detail`` names
  the field), 429, 500, 503 (api_integration/errors). FLUX 3 video allows "5
  per org on the API. Going over returns ``429 (too many active tasks)``"
  (cookbook/video_quickstart).
- BFL documents no cancel endpoint. A stopped run only stops polling; the task
  finishes on BFL's side and is billed.
"""
from __future__ import annotations

import asyncio
import logging
from dataclasses import dataclass, field
from typing import Any
from urllib.parse import urlsplit

import httpx

from execution.missing_credential import MissingCredentialError
from execution.person_line import as_job_failure, slow_job_line, with_api_status, with_person_line

BFL_KEY = "BFL_API_KEY"
BFL_BASE_URL = "https://api.bfl.ai/v1"
CREDITS_URL = "https://dashboard.bfl.ai"
# "1 credit = $0.01 USD" (docs.bfl.ai/quick_start/pricing.md).
USD_PER_CREDIT = 0.01
_TIMEOUT = httpx.Timeout(300.0, connect=30.0)

STATUS_READY = "Ready"
STATUS_PENDING = frozenset({"Pending", "Reasoning", "Generating"})
STATUS_MODERATED = frozenset({"Request Moderated", "Content Moderated", "No Card Generated"})
STATUS_FAILED = frozenset({"Error", "Task not found"})

# Waits before resubmitting a request BFL refused with 429 (seconds). A 429 is
# "a signal to wait for a running task, not something to retry in a loop"
# (cookbook/video_quickstart), so the retry is short and bounded; a refused
# submit isn't billed, so it is safe to send again.
SUBMIT_RETRY_DELAYS: tuple[float, ...] = (5.0, 15.0, 30.0)
# Seconds between polls. BFL's own examples poll every 0.5 s; images finish in
# seconds and video takes "several minutes per generation".
POLL_INTERVAL = {"Image": 1.0, "Video": 5.0}
# Polling stops after this long; the task keeps running (and billing) on BFL.
POLL_TIMEOUT = 3600.0


class BFLError(RuntimeError):
    """A BFL request that failed, with its HTTP status and a readable fix.

    ``status`` lets poll_retry.poll_request retry a 5xx poll."""

    def __init__(self, status: int, text: str, *, detail: str = ""):
        self.status = status
        self.detail = detail
        super().__init__(text)


@dataclass(frozen=True)
class BFLResult:
    """A finished task: the saved file and what BFL billed for it.

    ``cost_credits`` is the settled cost from the poll when BFL reports one
    and the submit's cost otherwise (``cost_settled`` says which)."""

    task_id: str
    path: str
    media_type: str
    cost_credits: float | None
    cost_settled: bool
    result: dict[str, Any] = field(default_factory=dict)

    @property
    def cost_usd(self) -> float | None:
        return None if self.cost_credits is None else round(self.cost_credits * USD_PER_CREDIT, 6)


def api_key(api_keys: dict[str, str]) -> str:
    key = (api_keys.get(BFL_KEY) or "").strip()
    if not key:
        raise MissingCredentialError(f"{BFL_KEY} is required")
    return key


def polling_url_allowed(url: Any) -> bool:
    """True only for an https URL on api.bfl.ai or another ``*.bfl.ai`` host.

    The key is sent to the polling URL, which comes from the submit answer;
    anything else (http, another host, ``bfl.ai.evil.com``, credentials or an
    odd port in the URL) is refused before a request is made."""
    if not isinstance(url, str):
        return False
    try:
        parts = urlsplit(url)
        port = parts.port
    except ValueError:
        return False
    host = (parts.hostname or "").lower()
    if parts.scheme != "https" or parts.username is not None or parts.password is not None:
        return False
    if port not in (None, 443):
        return False
    return host == "api.bfl.ai" or host.endswith(".bfl.ai")


def _detail(response: httpx.Response) -> str:
    """BFL's ``detail``: a string, or FastAPI's validation list."""
    try:
        body = response.json()
    except ValueError:
        return response.text.strip()[:500]
    detail = body.get("detail") if isinstance(body, dict) else None
    if isinstance(detail, str):
        return detail[:500]
    if isinstance(detail, list):
        parts = []
        for item in detail[:5]:
            if isinstance(item, dict):
                where = ".".join(str(p) for p in item.get("loc") or [] if p != "body")
                parts.append(f"{where}: {item.get('msg')}" if where else str(item.get("msg")))
        if parts:
            return "; ".join(parts)[:500]
    return response.text.strip()[:500]


def explain(status: int, detail: str) -> str:
    """BFL's HTTP error, plus what the person can do about it."""
    what = f"Black Forest Labs error {status}: {detail or 'no detail'}"
    if status == 402:
        return (f"Black Forest Labs credits ran out ({status}). Add credits on the BFL dashboard "
                f"({CREDITS_URL}, API -> Credits), then run again.")
    if status in (401, 403):
        return f"{what}. BFL rejected the API key: check {BFL_KEY} in Settings."
    if status == 422 and "api key" in detail.lower():
        return f"{what}. {BFL_KEY} isn't in the format BFL issues; copy it again from {CREDITS_URL}."
    if status == 429:
        return (f"{what}. Black Forest Labs is limiting this organization's requests: it runs at most 5 FLUX 3 "
                "videos at once (24 requests for most other endpoints). Wait for a running task to finish, "
                "then run again.")
    if status in (400, 422):
        return f"{what}. BFL refused the request's values; change the setting it names."
    return what


def _transport_error(what: str, exc: httpx.TransportError) -> RuntimeError:
    # Catches only httpx.TransportError, as the handlers on main do today.
    # TODO(#56): use the shared TRANSPORT_ERRORS tuple once that PR lands.
    return RuntimeError(f"Couldn't reach Black Forest Labs to {what}: {type(exc).__name__}: {exc}")


async def submit(
    key: str, path: str, body: dict[str, Any], *, client: httpx.AsyncClient,
    retry_delays: tuple[float, ...] | None = None,
) -> dict[str, Any]:
    """POST one task; returns BFL's ``{id, polling_url, cost, ...}``.

    A 429 is retried after each of ``retry_delays`` and then raises. Nothing
    else is retried: a submit that may have reached BFL could bill twice."""
    url = f"{BFL_BASE_URL}/{path.strip('/')}"
    headers = {"x-key": key, "Content-Type": "application/json", "accept": "application/json"}
    waits = SUBMIT_RETRY_DELAYS if retry_delays is None else retry_delays
    for attempt in range(len(waits) + 1):
        try:
            response = await client.post(url, headers=headers, json=body)
        except httpx.TransportError as exc:
            raise _transport_error("submit the task", exc) from exc
        if response.status_code == 429 and attempt < len(waits):
            await asyncio.sleep(waits[attempt])
            continue
        break
    if response.status_code >= 400:
        detail = _detail(response)
        raise BFLError(response.status_code, explain(response.status_code, detail), detail=detail)
    try:
        data = response.json()
    except ValueError as exc:
        raise with_api_status(
            RuntimeError(f"Black Forest Labs returned non-JSON ({response.status_code})"),
            response.status_code) from exc
    if not isinstance(data, dict) or not isinstance(data.get("id"), str) or not data["id"]:
        raise RuntimeError("Black Forest Labs accepted the task but returned no task id")
    return data


async def get_result(key: str, polling_url: str, *, client: httpx.AsyncClient) -> dict[str, Any]:
    """GET the polling URL once. A body with a ``status`` is the answer, whatever
    the HTTP code (BFL sends a failed task as a 503 with a normal body, and an
    unknown id as a 404 "Task not found"); any other error raises BFLError."""
    if not polling_url_allowed(polling_url):
        raise with_person_line(RuntimeError(
            "Black Forest Labs returned a polling URL outside https://*.bfl.ai; Nebula didn't send the key "
            "to it and stopped the run."), "Black Forest Labs sent a status link from outside its own site, so Nebula didn't send your key there and stopped. "
            "The job may still run and be billed on Black Forest Labs.")
    response = await client.get(polling_url, headers={"x-key": key, "accept": "application/json"})
    try:
        data = response.json()
    except ValueError:
        data = None
    if isinstance(data, dict) and isinstance(data.get("status"), str):
        return data
    detail = _detail(response) if response.status_code >= 400 else "no status in the answer"
    raise BFLError(response.status_code, explain(response.status_code, detail), detail=detail)


def _moderation_message(task: dict[str, Any]) -> str:
    status = str(task.get("status"))
    details = task.get("details") if isinstance(task.get("details"), dict) else {}
    reasons = details.get("Moderation Reasons")
    named = ", ".join(str(r) for r in reasons) if isinstance(reasons, list) and reasons else ""
    because = f" ({named})" if named else ""
    if status == "Request Moderated":
        return (f"Black Forest Labs' moderation blocked the prompt or an input image before it ran{because}. "
                "Change the prompt or inputs; the same request will be blocked again.")
    if status == "Content Moderated":
        return (f"Black Forest Labs' moderation blocked the generated result{because}. "
                "Change the prompt or inputs and run again.")
    return (f"Black Forest Labs returned no result (No Card Generated){because}. "
            "Change the prompt or inputs and run again.")


def _failure_message(task: dict[str, Any]) -> str:
    status = str(task.get("status"))
    if status == "Task not found":
        return ("Black Forest Labs no longer knows this task (Task not found: the id is unknown or has expired). "
                "Run again to submit a new one.")
    details = task.get("details")
    said = f": {str(details)[:300]}" if details else ""
    return f"Black Forest Labs reported an error for this task{said}. Run again; if it keeps failing, change the inputs."


async def _download(url: Any, media_type: str, *, client: httpx.AsyncClient) -> str:
    """Save ``result.sample`` to the run directory right away (the signed URL
    expires). The key is never sent to the delivery host."""
    from services.output import get_run_dir, write_media_bytes

    if not isinstance(url, str) or not url.startswith(("https://", "http://")):
        raise RuntimeError("Black Forest Labs reported the task Ready but returned no result URL")
    try:
        response = await client.get(url, follow_redirects=True)
    except httpx.TransportError as exc:
        raise _transport_error("download the result", exc) from exc
    if response.status_code >= 400:
        # no API status: a download of the result from its signed URL, not BFL's API.
        raise with_person_line(RuntimeError(f"Black Forest Labs' result download failed (HTTP {response.status_code}); "
                           "the signed URL may have expired. Run again."),
            "Couldn't download the result from Black Forest Labs. Its download link may have expired. Run the node again.")
    path = await write_media_bytes(response.content, response.headers.get("content-type", ""),
                                   media_type, get_run_dir(), url)
    return str(path)


def _credits(value: Any) -> float | None:
    return float(value) if isinstance(value, (int, float)) and not isinstance(value, bool) else None


async def run_task(
    key: str, path: str, body: dict[str, Any], *, media_type: str, node_id: str = "", emit: Any = None,
    poll_interval: float | None = None, timeout: float | None = None,
    retry_delays: tuple[float, ...] | None = None,
) -> BFLResult:
    """Submit a task, poll it to Ready and save its image or video.

    ``media_type`` is "Image" (jpeg or png) or "Video" (mp4). A moderated or
    failed task raises with BFL's reasons and what to do. A transient poll
    error (a 5xx without a status body, or a network failure) is retried with
    bounded backoff (execution/poll_retry.py). There is nothing to cancel
    upstream: BFL has no cancel endpoint, so a stopped run (cancellation, a
    poll error that outlasts the retries, the timeout) just stops polling."""
    from execution.poll_retry import poll_request

    if media_type not in POLL_INTERVAL:
        raise ValueError(f"unsupported BFL output type: {media_type}")
    interval = POLL_INTERVAL[media_type] if poll_interval is None else poll_interval
    timeout = POLL_TIMEOUT if timeout is None else timeout
    async with httpx.AsyncClient(timeout=_TIMEOUT) as client:
        submitted = await submit(key, path, body, client=client, retry_delays=retry_delays)
        task_id = submitted["id"]
        polling_url = submitted.get("polling_url")
        if not polling_url_allowed(polling_url):
            raise with_person_line(RuntimeError(
                f"Black Forest Labs accepted task {task_id} but returned a polling URL outside https://*.bfl.ai; "
                "Nebula didn't send the key to it. The task may still run and bill on BFL."),
                "Black Forest Labs sent a status link from outside its own site, so Nebula didn't send your key there and stopped. The job may still run and be billed on Black Forest Labs.")
        loop = asyncio.get_running_loop()
        started = loop.time()
        polls = 0
        while True:
            await asyncio.sleep(interval)
            try:
                task = await poll_request(lambda: get_result(key, polling_url, client=client))
            except httpx.TransportError as exc:
                raise _transport_error(f"check task {task_id}", exc) from exc
            except BFLError as exc:
                # A rate-limited poll says nothing about the task; poll again
                # later (the timeout still bounds the wait).
                if exc.status != 429:
                    raise
                task = {"status": "Pending"}
            polls += 1
            status = str(task.get("status") or "")
            if status == STATUS_READY:
                result = task.get("result") if isinstance(task.get("result"), dict) else {}
                saved = await _download(result.get("sample"), media_type, client=client)
                settled = _credits(task.get("cost"))
                cost = settled if settled is not None else _credits(submitted.get("cost"))
                logging.getLogger(__name__).info(
                    "BFL %s task %s: %s credits (%s)", path, task_id, cost, "settled" if settled is not None else "quoted")
                return BFLResult(task_id=task_id, path=saved, media_type=media_type, cost_credits=cost,
                                 cost_settled=settled is not None, result=result)
            if status in STATUS_MODERATED:
                raise RuntimeError(_moderation_message(task))
            if status in STATUS_FAILED:
                raise as_job_failure(RuntimeError(_failure_message(task)))
            if status not in STATUS_PENDING:
                logging.getLogger(__name__).warning("BFL task %s: unknown status %r, still polling", task_id, status)
            if emit is not None:
                from models.events import ProgressEvent

                # BFL's ``progress`` field has no documented scale; creep toward done.
                await emit(ProgressEvent(node_id=node_id, value=min(0.95, polls / (polls + 20))))
            if loop.time() - started > timeout:
                raise with_person_line(RuntimeError(
                    f"Black Forest Labs task {task_id} was still {status or 'pending'} after "
                    f"{int(timeout // 60)} minutes; Nebula stopped waiting. BFL has no cancel endpoint, so the "
                    "task may still finish and bill on BFL."),
                    slow_job_line("Black Forest Labs"))
