"""Schema-checked Krea generation routes from the bundled public API catalog.

Graphs choose a first-class definition ID, never a URL or arbitrary endpoint.
Provider credentials are attached only to Krea requests, not artifact downloads.
"""
from __future__ import annotations

import asyncio
import base64
import copy
import ipaddress
import json
import mimetypes
import re
from functools import lru_cache
from pathlib import Path
from typing import Any, Awaitable, Callable
from urllib.parse import SplitResult, unquote, urlsplit

import httpx
from jsonschema import Draft202012Validator, FormatChecker
from PIL import Image

from handlers.krea import (
    KREA_BASE_URL,
    KREA_STATUS_PENDING,
    _api_key,
    _auth_headers,
    _cancel_krea_job,
    _json_headers,
    _raise_for_krea_response,
    _resolve_local_path,
)
from models.events import ExecutionEvent, ProgressEvent
from models.graph import GraphNode, PortValueDict
from services.cancellation import schedule_detached_cancel
from services.file_access import require_allowed_path
from services.output import _MEDIA_EXTENSIONS, get_run_dir, materialize_media_value, portable_output_ref


CATALOG_PATH = Path(__file__).resolve().parents[1] / "data" / "krea_gateway_models.json"
MAX_ASSET_BYTES = 75_000_000
MAX_POLLS = 300
POLL_INTERVAL = 2.0
_RUNTIME_PARAMS = {"_sourceDuration", "_sourceFps", "_sourceIsVfr", "_variant", "_kreaAuth"}
_PLACEHOLDER_URL = "https://assets.krea.ai/validated-local-input"
_ENDPOINT = re.compile(r"^/generate/(?:image|video|audio|enhance|3d)/[A-Za-z0-9_./-]+$")
_PLURALS = {"Image": "images", "Video": "videos", "Audio": "audios", "Mesh": "meshes"}
_JOB_ID = re.compile(r"^[A-Za-z0-9_-]{1,128}$")


@lru_cache(maxsize=1)
def catalog_models() -> dict[str, dict[str, Any]]:
    """Load only the reviewed, checked-in catalog, with no runtime discovery."""
    models = json.loads(CATALOG_PATH.read_text())["models"]
    if not isinstance(models, dict):
        raise ValueError("Invalid bundled Krea catalog")
    return models


def _model(definition_id: str) -> dict[str, Any]:
    model = catalog_models().get(definition_id)
    if not model:
        raise ValueError("Unknown bundled Krea model")
    endpoint = model.get("endpoint", "")
    if not isinstance(endpoint, str) or not _ENDPOINT.fullmatch(endpoint) or ".." in endpoint:
        raise ValueError("Invalid bundled Krea endpoint")
    if model.get("mediaType") not in _PLURALS:
        raise ValueError("Unsupported bundled Krea media type")
    return model


def _variant(schema: dict, value: Any) -> dict:
    """Choose the structural branch for traversal; validation retains all rules."""
    branches = schema.get("anyOf", schema.get("oneOf", []))
    expected = "object" if isinstance(value, dict) else "array" if isinstance(value, list) else "string" if isinstance(value, str) else "null" if value is None else None
    for branch in branches:
        branch_type = branch.get("type")
        if branch_type == expected or isinstance(branch_type, list) and expected in branch_type:
            return {**schema, **branch}
    merged = dict(schema)
    for branch in schema.get("allOf", []):
        properties = {**merged.get("properties", {}), **branch.get("properties", {})}
        merged.update(branch)
        merged["properties"] = properties
    return merged


def _types(schema: dict) -> set[str]:
    types = schema.get("type", [])
    result = {types} if isinstance(types, str) else set(types)
    for key in ("anyOf", "oneOf", "allOf"):
        for branch in schema.get(key, []):
            result.update(_types(branch))
    return result


def _has_choices(schema: dict) -> bool:
    return "enum" in schema or "const" in schema or any(
        _has_choices(branch)
        for key in ("anyOf", "oneOf", "allOf")
        for branch in schema.get(key, [])
    )


def _http_url(value: str) -> SplitResult:
    """Validate media HTTP URLs even without jsonschema's optional URI extras."""
    if not isinstance(value, str) or any(character.isspace() or ord(character) < 32 or ord(character) == 127
                                         for character in value) or "\\" in value:
        raise ValueError("Invalid Krea media HTTP URL")
    try:
        parsed = urlsplit(value)
        usable = httpx.URL(value)
        port = parsed.port
    except (ValueError, httpx.InvalidURL) as exc:
        raise ValueError("Invalid Krea media HTTP URL") from exc
    if parsed.scheme not in {"http", "https"} or not parsed.netloc or not parsed.hostname or not usable.host or port == 0:
        raise ValueError("Invalid Krea media HTTP URL")
    return parsed


def _asset_data(value: str) -> tuple[str, bytes, str] | None:
    try:
        parsed = urlsplit(value)
    except ValueError as exc:
        raise ValueError("Invalid Krea media HTTP URL") from exc
    if parsed.scheme in {"http", "https"}:
        parsed = _http_url(value)
        hostname = parsed.hostname or ""
        try:
            loopback = ipaddress.ip_address(hostname).is_loopback
        except ValueError:
            loopback = hostname.lower().rstrip(".") == "localhost"
        if not loopback:
            return None
        if not parsed.path.startswith("/api/outputs/") or parsed.query or parsed.fragment:
            raise ValueError("Krea cannot access a local URL; upload the media or use an owned output reference")
        value = unquote(parsed.path)
        parsed = urlsplit(value)
    if value.startswith("data:"):
        header, separator, data = value.partition(",")
        if not separator or ";base64" not in header.lower():
            raise ValueError("Krea media data URI must contain base64 data")
        mime = header[5:].split(";", 1)[0]
        try:
            raw = base64.b64decode(data, validate=True)
        except (ValueError, base64.binascii.Error) as exc:
            raise ValueError("Invalid Krea media data URI") from exc
        extension = mimetypes.guess_extension(mime) or ".bin"
        filename = f"krea-input{extension}"
    else:
        if parsed.scheme:
            raise ValueError("Krea media must be an HTTP URL, base64 data URI, or local file")
        path = _resolve_local_path(value)
        if path is None:
            raise ValueError("Krea media input is not a readable local file")
        # Nested JSON fields are decoded here, after generic graph validation.
        # Enforce the protected-store/workspace boundary at the actual reader.
        path = require_allowed_path(path)
        if not path.is_file():
            raise ValueError("Krea media input is not a readable local file")
        if path.stat().st_size > MAX_ASSET_BYTES:
            raise ValueError("Krea media input exceeds the 75 MB asset limit")
        raw = path.read_bytes()
        mime = mimetypes.guess_type(path.name)[0] or "application/octet-stream"
        filename = path.name
    if not raw or len(raw) > MAX_ASSET_BYTES:
        raise ValueError("Krea media input is empty or exceeds the 75 MB asset limit")
    return filename, raw, mime


async def _walk_media(value: Any, schema: dict, convert, *, media: bool = False) -> Any:
    schema = _variant(schema, value)
    if value is None:
        return None
    if isinstance(value, list):
        item_schema = schema.get("items", {})
        return [await _walk_media(item, item_schema, convert, media=media) for item in value]
    if isinstance(value, dict):
        properties = schema.get("properties", {})
        extra = schema.get("additionalProperties", {})
        return {key: await _walk_media(item, properties.get(key, extra if isinstance(extra, dict) else {}), convert)
                for key, item in value.items()}
    if isinstance(value, str) and (media or schema.get("format") == "uri"):
        return await convert(value)
    return value


def _validate(body: dict, schema: dict) -> None:
    # The public request schemas use additionalProperties:false. Enforce it
    # here too so future accidental catalog changes cannot forward graph metadata.
    schema = {**schema, "additionalProperties": False}
    errors = sorted(Draft202012Validator(schema, format_checker=FormatChecker()).iter_errors(body),
                    key=lambda error: tuple(str(part) for part in error.path))
    if errors:
        error = errors[0]
        field = ".".join(str(part) for part in error.path) or "request"
        raise ValueError(f"Invalid Krea {field}: {error.message}")


async def _request_body(node: GraphNode, inputs: dict[str, PortValueDict], model: dict) -> dict:
    schema = model["requestSchema"]
    properties = schema.get("properties", {})
    required = set(schema.get("required", []))
    body = {key: copy.deepcopy(value) for key, value in node.params.items() if key not in _RUNTIME_PARAMS}
    unknown = (set(body) | set(inputs)) - set(properties)
    if unknown:
        raise ValueError(f"Unknown Krea request fields: {', '.join(sorted(unknown))}")
    for field, port in inputs.items():
        if port.value is not None:
            value = copy.deepcopy(port.value)
            if "array" in _types(properties.get(field, {})) and not isinstance(value, list):
                value = [value]
            body[field] = value
    for field in model.get("jsonParams", []):
        if field in body and isinstance(body[field], str):
            if not body[field].strip() and field not in required:
                body.pop(field)
                continue
            try:
                body[field] = json.loads(body[field])
            except (ValueError, TypeError) as exc:
                raise ValueError(f"Invalid Krea {field}: expected JSON") from exc
    # Unset optional numeric/JSON controls are not values. Keep string fields
    # intact, including empty strings when the provider schema allows them.
    for field in list(body):
        if body[field] == "" and field not in required:
            field_schema = _variant(properties.get(field, {}), body[field])
            media = any(port["id"] == field and port.get("dataType") in {"Image", "Video", "Audio", "Mask"}
                        for port in model.get("inputPorts", []))
            unset_choice = _has_choices(field_schema) and not Draft202012Validator(field_schema).is_valid("")
            if "string" not in _types(field_schema) or field_schema.get("format") == "uri" or media or unset_choice:
                body.pop(field)
    return body


async def _map_body(body: dict, model: dict, convert) -> dict:
    properties = model["requestSchema"].get("properties", {})
    media_fields = {port["id"] for port in model.get("inputPorts", []) if port.get("dataType") in {"Image", "Video", "Audio", "Mask"}}
    return {field: await _walk_media(value, properties.get(field, {}), convert, media=field in media_fields)
            for field, value in body.items()}


async def _poll_job(client, api_key, job_id, node_id, emit) -> dict:
    try:
        for index in range(MAX_POLLS):
            await asyncio.sleep(POLL_INTERVAL)
            try:
                response = await client.get(f"{KREA_BASE_URL}/jobs/{job_id}", headers=_auth_headers(api_key))
                _raise_for_krea_response(response, "job poll")
                job = response.json()
            except Exception:
                # Once the provider has accepted a job, losing the poll does
                # not stop it. Request cancellation without resubmitting it.
                schedule_detached_cancel(lambda: _cancel_krea_job(job_id, api_key))
                raise
            status = str(job.get("status", "")).lower()
            if emit:
                await emit(ProgressEvent(node_id=node_id, value=min((index + 1) / MAX_POLLS, 0.99)))
            if status == "completed":
                return job
            if status in {"failed", "cancelled"}:
                raise RuntimeError(f"Krea job {status}: {job.get('error') or job.get('message') or status}")
            if status not in KREA_STATUS_PENDING:
                schedule_detached_cancel(lambda: _cancel_krea_job(job_id, api_key))
                raise RuntimeError(f"Krea job returned unknown status: {status}")
    except asyncio.CancelledError:
        schedule_detached_cancel(lambda: _cancel_krea_job(job_id, api_key))
        raise
    schedule_detached_cancel(lambda: _cancel_krea_job(job_id, api_key))
    raise RuntimeError(f"Krea job timed out after {MAX_POLLS} polls")


def _result_artifacts(job: dict, media_type: str) -> list[tuple[str, str]]:
    result = job.get("result")
    if not isinstance(result, dict):
        raise RuntimeError("Krea completed without media URLs")
    values = result.get("urls")
    if isinstance(values, dict):
        values = list(values.items())
    elif isinstance(values, list):
        values = [("", value) for value in values]
    else:
        raise RuntimeError("Krea completed without media URLs")
    if not values:
        raise RuntimeError("Krea completed without media URLs")
    artifacts = []
    for key, value in values:
        hint = str(value.get("type") or key).lower() if isinstance(value, dict) else str(key).lower()
        url = value.get("url") if isinstance(value, dict) else value
        try:
            _http_url(url)
        except ValueError as exc:
            raise RuntimeError("Krea returned an invalid media URL") from exc
        artifact_type = "Image" if hint in {"image", "preview", "preview_url", "thumbnail", "poster"} else "Video" if hint == "video" else "Audio" if hint == "audio" else media_type
        artifacts.append((artifact_type, url))
    return artifacts


async def handle_krea_gateway(
    node: GraphNode,
    inputs: dict[str, PortValueDict],
    api_keys: dict[str, str],
    emit: Callable[[ExecutionEvent], Awaitable[None]] | None = None,
) -> dict[str, Any]:
    model = _model(node.definition_id)
    auth_mode = node.params.get("_kreaAuth", "api-token")
    if auth_mode not in {"api-token", "mcp"}:
        raise ValueError("Unknown Krea connection; choose API token or Krea account")
    api_key = _api_key(api_keys) if auth_mode == "api-token" else None
    body = await _request_body(node, inputs, model)
    return await run_gateway(node, model, body, auth_mode, api_key, emit)


async def run_gateway(node: GraphNode, model: dict, body: dict, auth_mode: str, api_key: str | None,
                      emit: Callable[[ExecutionEvent], Awaitable[None]] | None = None) -> dict[str, Any]:
    """Submit one prepared request body for a catalog route and save its media.

    Media values in ``body`` may still be local files or owned output refs; they
    are uploaded through the chosen billing path after the body validates."""
    assets: dict[str, tuple[str, bytes, str] | None] = {}

    async def preview(value):
        assets[value] = _asset_data(value)
        return _PLACEHOLDER_URL if assets[value] else value

    _validate(await _map_body(body, model, preview), model["requestSchema"])
    if auth_mode == "mcp":
        from services.krea_mcp_generation import generate
        job = await generate(node, body, model, assets, _map_body, _validate, emit,
                             max_polls=MAX_POLLS, poll_interval=POLL_INTERVAL)
    else:
        async with httpx.AsyncClient(timeout=120.0) as client:
            uploaded: dict[str, str] = {}

            async def upload(value):
                asset = assets[value]
                if asset is None:
                    return value
                if value not in uploaded:
                    response = await client.post(f"{KREA_BASE_URL}/assets", headers=_auth_headers(api_key), files={"file": asset})
                    _raise_for_krea_response(response, "asset upload")
                    asset_url = response.json().get("image_url")
                    try:
                        _http_url(asset_url)
                    except ValueError as exc:
                        raise RuntimeError("Krea asset upload returned no valid image_url") from exc
                    uploaded[value] = asset_url
                return uploaded[value]

            body = await _map_body(body, model, upload)
            _validate(body, model["requestSchema"])
            response = await client.post(f"{KREA_BASE_URL}{model['endpoint']}", headers=_json_headers(api_key), json=body)
            _raise_for_krea_response(response, "generate submit")
            submitted = response.json()
            job_id = str(submitted.get("job_id") or "")
            if not _JOB_ID.fullmatch(job_id):
                raise RuntimeError("Krea submit returned no valid job_id")
            job = submitted if submitted.get("status") == "completed" else await _poll_job(client, api_key, job_id, node.id, emit)

    media_type = model["mediaType"]
    run_dir = get_run_dir()
    paths = []
    artifacts = []
    for artifact_type, url in _result_artifacts(job, media_type):
        # This helper opens a separate client with no credential headers.
        path = await materialize_media_value(url, artifact_type, run_dir)
        if artifact_type == "Image":
            try:
                with Image.open(path) as image:
                    image.verify()
            except (OSError, ValueError) as exc:
                raise RuntimeError("Krea returned invalid image artwork") from exc
        elif path.suffix.lstrip(".").lower() not in _MEDIA_EXTENSIONS[artifact_type]:
            raise RuntimeError(f"Krea returned an image rather than the requested {artifact_type.lower()}")
        artifacts.append({"type": artifact_type, "value": portable_output_ref(str(path), require_file=True)})
        if artifact_type == media_type:
            paths.append(str(path))
    if not paths:
        raise RuntimeError(f"Krea completed without a {media_type.lower()} result")
    primary = media_type.lower()
    return {primary: {"type": media_type, "value": paths[0]},
            _PLURALS[media_type]: {"type": "Array", "value": [portable_output_ref(path, require_file=True) for path in paths]},
            "artifacts": {"type": "Array", "value": artifacts},
            "job": {"type": "Any", "value": job}}
