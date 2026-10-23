"""Replicate official models: ``POST /v1/models/{owner}/{name}/predictions``.

The route-table client for Replicate (execution/route_clients.py
``replicate-model``). Unlike handle_replicate_universal it never resolves a
version: an official model is called by its name, and the input is what the
route built (the node's own params plus its wired media), nothing else.

Vendor facts, read on 2026-10-15 from Replicate's HTTP API reference
(replicate.com/docs/reference/http#models.predictions.create) and its OpenAPI
schema (https://api.replicate.com/openapi.json):

- Create: ``POST https://api.replicate.com/v1/models/{model_owner}/{model_name}/predictions``
  with ``{"input": {...}}`` and ``Authorization: Bearer <token>``. The answer
  is a prediction ``{id, status, output, error, urls: {get, cancel}}``.
- Status: ``starting``, ``processing``, ``succeeded``, ``failed``,
  ``canceled``. Poll ``GET /v1/predictions/{id}``; cancel with
  ``POST /v1/predictions/{id}/cancel`` (the shared poll loop does both,
  execution/async_poll_runner.py).
- File inputs are "HTTP URLs or data URLs"; a data URL is for a file of
  "<= 256kb". A larger local file is uploaded first: ``POST /v1/files``,
  multipart ``content`` (with its filename and type), answering a file whose
  ``urls.get`` is passed as the input. That is what Replicate's own client
  does (replicate-javascript 1.4.0, lib/util.js
  transformFileInputsToReplicateFileURLs); the OpenAPI caps a file at 100MB
  (413 "Files must be less than 100MB in size").
- Output files "are HTTPS URLs, and you must pass the ``Authorization``
  header to request them"; they are "served from ``replicate.delivery`` and
  its subdomains". The token goes only to those hosts. The output is saved
  as the route's port type, not guessed from the URL's extension.
- Inputs and outputs are deleted an hour after the prediction, so the result
  is saved at once.
"""
from __future__ import annotations

import logging
import mimetypes
import re
from pathlib import Path
from typing import Any, Awaitable, Callable
from urllib.parse import quote, urlsplit

import httpx

from execution.async_poll_runner import AsyncPollConfig, poll_until_terminal
from execution.missing_credential import MissingCredentialError
from models.events import ExecutionEvent
from execution.person_line import with_api_status, with_person_line

REPLICATE_KEY = "REPLICATE_API_TOKEN"
REPLICATE_API_BASE = "https://api.replicate.com/v1"
MAX_UPLOAD_BYTES = 100_000_000
_SEGMENT = re.compile(r"^[A-Za-z0-9][A-Za-z0-9_.-]*$")
_TIMEOUT = httpx.Timeout(120.0, connect=30.0)
# A FLUX 3 video takes several minutes; 300 polls x 3 s is 15 minutes.
POLL_INTERVAL = 3.0
MAX_POLLS = 300


def api_key(api_keys: dict[str, str]) -> str:
    key = (api_keys.get(REPLICATE_KEY) or "").strip()
    if not key:
        raise MissingCredentialError(f"{REPLICATE_KEY} is required")
    return key


def model_path(model: Any) -> str:
    """``owner/name`` as a URL path, refusing anything else (a version hash,
    a query, a ``..``)."""
    parts = str(model or "").split("/")
    if len(parts) != 2 or not all(_SEGMENT.fullmatch(part) and part not in (".", "..") for part in parts):
        # The model comes from Nebula's route table (route_clients), never
        # from the person: a developer-only state keeps the general line.
        raise ValueError(f"Replicate model must be owner/name (got {model!r})")
    return f"{quote(parts[0], safe='')}/{quote(parts[1], safe='')}"


def delivery_host(url: str) -> bool:
    """True for an https URL on replicate.delivery or one of its subdomains."""
    try:
        parts = urlsplit(url)
        port = parts.port
    except ValueError:
        return False
    host = (parts.hostname or "").lower()
    return (parts.scheme == "https" and parts.username is None and port in (None, 443)
            and (host == "replicate.delivery" or host.endswith(".replicate.delivery")))


def _error(response: httpx.Response, what: str) -> RuntimeError:
    try:
        body = response.json()
    except ValueError:
        body = None
    detail = (body.get("detail") or body.get("title")) if isinstance(body, dict) else None
    said = str(detail or response.text.strip())[:400] or "no detail"
    status = response.status_code
    if status in (401, 403):
        return with_api_status(
            RuntimeError(f"Replicate rejected the token ({status}): check {REPLICATE_KEY} in Settings."), status)
    if status == 402:
        return with_api_status(
            RuntimeError(f"Replicate needs billing set up or more credit ({status}: {said}). "
                         "Add it at replicate.com/account/billing, then run again."), status)
    if status == 404:
        return with_api_status(RuntimeError(f"Replicate doesn't have that model ({status}: {said})."), status)
    if status == 429:
        return with_api_status(
            RuntimeError(f"Replicate is rate-limiting this account ({status}: {said}). Wait a moment, then run again."),
            status)
    return with_api_status(RuntimeError(f"Replicate {what} failed ({status}): {said}"), status)


async def upload_file(client: httpx.AsyncClient, key: str, path: Path) -> str:
    """Upload a local file with the files API; returns its ``urls.get``."""
    size = path.stat().st_size
    if not size or size > MAX_UPLOAD_BYTES:
        raise with_person_line(
            ValueError(f"{path.name} is empty or over Replicate's 100MB file limit"),
            "A connected file is empty or over Replicate's 100 MB limit. Connect another one.")
    mime = mimetypes.guess_type(path.name)[0] or "application/octet-stream"
    try:
        response = await client.post(f"{REPLICATE_API_BASE}/files", headers={"Authorization": f"Bearer {key}"},
                                     files={"content": (path.name, path.read_bytes(), mime)})
    except httpx.TransportError as exc:
        raise RuntimeError(f"Couldn't reach Replicate to upload {path.name}: {type(exc).__name__}: {exc}") from exc
    if response.status_code not in (200, 201):
        raise _error(response, "file upload")
    url = ((response.json() or {}).get("urls") or {}).get("get")
    if not isinstance(url, str) or not url.startswith("https://"):
        raise RuntimeError("Replicate accepted the upload but returned no file URL")
    return url


async def _resolve_media(client: httpx.AsyncClient, key: str, value: Any,
                         uploaded: dict[str, str]) -> Any:
    """An http(s) or data URL passes through; a Nebula output (a path or an
    /api/outputs reference) is uploaded once per run."""
    if isinstance(value, list):
        return [await _resolve_media(client, key, item, uploaded) for item in value]
    from execution.route_clients import local_media_path

    path = local_media_path(value)
    if path is None:
        return value
    if str(path) not in uploaded:
        uploaded[str(path)] = await upload_file(client, key, path)
    return uploaded[str(path)]


async def _save_output(client: httpx.AsyncClient, key: str, output: Any, media_type: str) -> str:
    from services.output import get_run_dir, write_media_bytes

    url = output[0] if isinstance(output, list) and output else output
    if not isinstance(url, str) or not url.startswith(("https://", "http://")):
        raise RuntimeError(f"Replicate finished but returned no {media_type.lower()} URL")
    headers = {"Authorization": f"Bearer {key}"} if delivery_host(url) else {}
    try:
        response = await client.get(url, headers=headers, follow_redirects=True)
    except httpx.TransportError as exc:
        raise RuntimeError(f"Couldn't download Replicate's result: {type(exc).__name__}: {exc}") from exc
    if response.status_code >= 400:
        # no API status: a download of the result file, not Replicate's API.
        raise with_person_line(
            RuntimeError(f"Replicate's result download failed (HTTP {response.status_code}). Run again."),
            "Couldn't download the result from Replicate. Its download link may have expired. Run the node again.")
    path = await write_media_bytes(response.content, response.headers.get("content-type", ""), media_type,
                                   get_run_dir(), url)
    return str(path)


async def run_model(
    model: str, prediction_input: dict[str, Any], key: str, *, media_type: str, media_fields: set[str],
    node_id: str = "", emit: Callable[[ExecutionEvent], Awaitable[None]] | None = None,
    poll_interval: float | None = None,
) -> str:
    """Run one official-model prediction and save its output as ``media_type``.

    Values under ``media_fields`` are media: local ones are uploaded first.
    A run stopped while polling (cancelled, a poll error, the poll limit)
    cancels the prediction upstream."""
    path = model_path(model)
    headers = {"Authorization": f"Bearer {key}", "Content-Type": "application/json"}

    async def _quiet(event: ExecutionEvent) -> None:
        pass

    async with httpx.AsyncClient(timeout=_TIMEOUT) as client:
        uploaded: dict[str, str] = {}
        body = {field: (await _resolve_media(client, key, value, uploaded) if field in media_fields else value)
                for field, value in prediction_input.items()}
        try:
            response = await client.post(f"{REPLICATE_API_BASE}/models/{path}/predictions", headers=headers,
                                         json={"input": body})
        except httpx.TransportError as exc:
            raise RuntimeError(f"Couldn't reach Replicate to start {model}: {type(exc).__name__}: {exc}") from exc
        if response.status_code not in (200, 201, 202):
            raise _error(response, "prediction")
        prediction = response.json()
        task_id = str(prediction.get("id") or "")
        if not task_id:
            raise RuntimeError("Replicate accepted the prediction but returned no id")
        if prediction.get("status") != "succeeded":
            config = AsyncPollConfig(
                submit_url="",
                poll_url_template=f"{REPLICATE_API_BASE}/predictions/{{task_id}}",
                headers=headers,
                terminal_success={"succeeded"},
                terminal_failure={"failed", "canceled"},
                poll_interval=POLL_INTERVAL if poll_interval is None else poll_interval,
                max_polls=MAX_POLLS,
                cancel_url_template=f"{REPLICATE_API_BASE}/predictions/{{task_id}}/cancel",
                cancel_method="POST",
                provider="Replicate",
            )
            prediction = await poll_until_terminal(client, config, task_id, node_id, emit or _quiet)
        logging.getLogger(__name__).info("Replicate %s prediction %s: %s", model, task_id,
                                         (prediction.get("metrics") or {}).get("predict_time"))
        return await _save_output(client, key, prediction.get("output"), media_type)
