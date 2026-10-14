"""BytePlus ModelArk: ByteDance's own international API for Seedream and Seedance.

One client for every ModelArk call Nebula makes, with the person's
``BYTEPLUS_API_KEY``. Today it serves Seedream image generation (a direct route
for the fal and Krea Seedream copies, execution/maker_routes_byteplus.py). The
video task API (Seedance) builds on :func:`request` too:
``POST {base}/contents/generations/tasks`` creates a task, ``GET`` and
``DELETE {base}/contents/generations/tasks/{id}`` poll and cancel it
(docs.byteplus.com/en/docs/ModelArk/create-video-generation-task-api).

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
