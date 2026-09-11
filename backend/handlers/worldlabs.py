from __future__ import annotations

import asyncio
import base64
import binascii
import gzip
import hashlib
import ipaddress
import json
import logging
import math
import mimetypes
import re
import socket
import struct
from pathlib import Path
from typing import Any, AsyncIterator, Awaitable, Callable, Literal
from urllib.parse import quote, unquote, unquote_to_bytes, urljoin, urlsplit

import httpx

from models.events import (
    ExecutionEvent,
    ProgressEvent,
    ProviderRecoveryEvent,
    ProviderStartAmbiguousEvent,
)
from models.graph import GraphNode, PortValueDict
from services.output import get_run_dir, resolve_output_ref
from services.provider_start_guard import AMBIGUITY_MESSAGE

logger = logging.getLogger(__name__)

WORLDLABS_API_BASE = "https://api.worldlabs.ai/marble/v1"
WORLDLABS_MODELS = frozenset(
    {
        "marble-1.0-draft",
        "marble-1.0",
        "marble-1.1",
        "marble-1.1-plus",
    }
)
WORLD_SCHEMA_VERSION = 1
WORLD_COORDINATE_FRAME = "marble_raw_opencv"

_MAX_INLINE_BYTES = 10 * 1024 * 1024
_MAX_VIDEO_BYTES = 100 * 1024 * 1024
_MAX_UPLOAD_BYTES = 1024 * 1024 * 1024
_MAX_ASSET_DOWNLOAD_BYTES = 2 * 1024 * 1024 * 1024
_MAX_WORLD_ASSET_BYTES = 4 * 1024 * 1024 * 1024
_MAX_SPZ_VARIANTS = 16
_MAX_SPZ_UNCOMPRESSED_BYTES = 2 * 1024 * 1024 * 1024
_MAX_PROVIDER_ID_CHARS = 256
_MAX_PLY_HEADER_BYTES = 1024 * 1024
_MAX_IMAGE_HEADER_BYTES = 1024 * 1024
_MAX_IMAGE_DIMENSION = 32_768
_MAX_IMAGE_PIXELS = 134_217_728  # permits a 16K x 8K panorama
_MAX_ASSET_FILENAME_CHARS = 240
_MAX_EXTERNAL_REDIRECTS = 3
_SAFE_NAME_RE = re.compile(r"[^A-Za-z0-9._-]+")


async def _noop_emit(_event: ExecutionEvent) -> None:
    return None


async def _await_settled(task: asyncio.Task[Any]) -> tuple[Any, bool]:
    """Finish a critical handshake even if the caller requests cancellation.

    ``asyncio.shield`` keeps the inner provider request/event alive, while the
    loop records Stop and consumes any repeated cancellation requests. The
    caller propagates cancellation only after it has captured and published
    the operation identifier.
    """
    cancellation_requested = False
    while True:
        try:
            return await asyncio.shield(task), cancellation_requested
        except asyncio.CancelledError:
            if task.cancelled():
                raise
            cancellation_requested = True
        except Exception as exc:
            # If Stop arrived while the non-idempotent request was in flight,
            # cancellation remains the authoritative terminal even when the
            # settled handshake ends in a transport failure.
            if cancellation_requested:
                raise asyncio.CancelledError from exc
            raise


async def _paid_post(
    client: httpx.AsyncClient,
    url: str,
    *,
    headers: dict[str, str],
    body: dict[str, Any],
) -> tuple[httpx.Response | None, Exception | None, bool]:
    """Send a non-idempotent paid POST without losing its response on Stop."""
    task = asyncio.create_task(client.post(url, headers=headers, json=body))
    cancellation_requested = False
    while True:
        try:
            return await asyncio.shield(task), None, cancellation_requested
        except asyncio.CancelledError:
            if task.cancelled():
                raise
            cancellation_requested = True
        except Exception as exc:
            # Return the settled failure so the caller can publish a durable
            # ambiguity hold before honoring a concurrent Stop request.
            return None, exc, cancellation_requested


def _paid_start_response_is_ambiguous(response: httpx.Response) -> bool:
    """Whether a settled paid-start response cannot prove non-acceptance.

    A 408 may be generated after an upstream accepted the request. Ordinary
    client denials such as 402/429 are definite and remain safe to correct and
    retry. Any success response that cannot yield a trustworthy ID is also
    ambiguous.
    """
    return (
        300 <= response.status_code < 400
        or response.status_code == 408
        or response.status_code >= 500
        or 200 <= response.status_code < 300
    )


def _api_headers(api_key: str) -> dict[str, str]:
    return {
        "WLT-Api-Key": api_key,
        "Content-Type": "application/json",
        "Accept": "application/json",
    }


async def _resolve_host_addresses(hostname: str, port: int) -> set[ipaddress._BaseAddress]:
    try:
        records = await asyncio.to_thread(
            socket.getaddrinfo,
            hostname,
            port,
            type=socket.SOCK_STREAM,
        )
    except socket.gaierror as exc:
        raise RuntimeError(f"Could not resolve provider URL host {hostname!r}") from exc

    addresses: set[ipaddress._BaseAddress] = set()
    for _family, _kind, _protocol, _canonical, sockaddr in records:
        raw_address = str(sockaddr[0]).split("%", 1)[0]
        try:
            addresses.add(ipaddress.ip_address(raw_address))
        except ValueError as exc:
            raise RuntimeError(
                f"Provider URL host {hostname!r} resolved to an invalid address"
            ) from exc
    if not addresses:
        raise RuntimeError(f"Provider URL host {hostname!r} did not resolve")
    return addresses


async def _validated_public_https_url(url: str, *, label: str) -> str:
    """Reject provider URLs that could reach local or privileged networks.

    DNS is checked immediately before each request/redirect hop. httpx still
    performs its own resolution for TLS, so this closes ordinary SSRF targets
    but cannot cryptographically pin the checked address against DNS rebinding.
    """
    if not isinstance(url, str) or url != url.strip() or len(url) > 8192:
        raise RuntimeError(f"World Labs returned an invalid {label} URL")
    parsed = urlsplit(url)
    try:
        port = parsed.port
    except ValueError as exc:
        raise RuntimeError(f"World Labs returned an invalid {label} URL") from exc
    if (
        parsed.scheme.lower() != "https"
        or not parsed.hostname
        or parsed.username is not None
        or parsed.password is not None
        or parsed.fragment
        or port not in {None, 443}
    ):
        raise RuntimeError(f"World Labs returned an unsafe {label} URL")

    hostname = parsed.hostname.rstrip(".").lower()
    if not hostname or hostname == "localhost" or hostname.endswith(".localhost"):
        raise RuntimeError(f"World Labs returned a non-public {label} URL")
    try:
        literal = ipaddress.ip_address(hostname)
    except ValueError:
        addresses = await _resolve_host_addresses(hostname, port or 443)
    else:
        addresses = {literal}
    if any(not address.is_global for address in addresses):
        raise RuntimeError(f"World Labs returned a non-public {label} URL")
    return url


def _response_excerpt(response: httpx.Response) -> str:
    """Return a bounded error excerpt without assuming a streamed body was read."""
    try:
        text = response.text.strip()
    except httpx.ResponseNotRead:
        return "unread response body"
    return text[:1000] if text else "no response body"


def _raise_api_error(
    action: str,
    response: httpx.Response,
    *,
    excerpt: str | None = None,
) -> None:
    if 200 <= response.status_code < 300:
        return
    status = response.status_code
    if status == 401:
        detail = "the WORLDLABS_API_KEY was rejected"
    elif status == 402:
        detail = "the World Labs account has insufficient API credits"
    elif status == 429:
        retry_after = response.headers.get("retry-after")
        detail = "World Labs rate-limited the request"
        if retry_after:
            detail += f"; retry after {retry_after} seconds"
    else:
        detail = excerpt if excerpt is not None else _response_excerpt(response)
    raise RuntimeError(f"World Labs {action} failed ({status}): {detail}")


async def _raise_streamed_api_error(action: str, response: httpx.Response) -> None:
    """Raise for a streaming response while buffering at most 1 KiB of error text."""
    if 200 <= response.status_code < 300:
        return
    excerpt = bytearray()
    async for chunk in response.aiter_bytes():
        if not chunk:
            continue
        remaining = 1000 - len(excerpt)
        if remaining > 0:
            excerpt.extend(chunk[:remaining])
        if len(excerpt) >= 1000:
            break
    detail = bytes(excerpt).decode("utf-8", errors="replace").strip()
    _raise_api_error(action, response, excerpt=detail or "no response body")


def _json_object(response: httpx.Response, action: str) -> dict[str, Any]:
    try:
        value = response.json()
    except ValueError as exc:
        raise RuntimeError(f"World Labs {action} returned invalid JSON") from exc
    if not isinstance(value, dict):
        raise RuntimeError(f"World Labs {action} returned a malformed response")
    return value


def _required_string(value: Any, label: str) -> str:
    if not isinstance(value, str) or not value.strip():
        raise ValueError(f"{label} is required")
    return value.strip()


def _provider_id(value: Any, label: str) -> str:
    """Validate an opaque provider identifier before using it in a URL path."""
    identifier = _required_string(value, label)
    if len(identifier) > _MAX_PROVIDER_ID_CHARS or any(
        ord(character) < 0x20 or ord(character) == 0x7F
        for character in identifier
    ):
        raise ValueError(f"{label} is invalid")
    return identifier


def _api_path_id(identifier: str) -> str:
    """Encode an already-validated opaque identifier as one URL segment."""
    return quote(identifier, safe="")


def _safe_asset_name(value: str, fallback: str) -> str:
    cleaned = _SAFE_NAME_RE.sub("-", value).strip("-._")
    return (cleaned or fallback)[:80]


def _stable_asset_component(
    value: str,
    fallback: str,
    *,
    readable_chars: int = 32,
) -> str:
    """Create a short readable component that remains collision-resistant."""
    readable = _SAFE_NAME_RE.sub("-", value).strip("-._")
    readable = (readable or fallback)[:readable_chars].rstrip("-._") or fallback
    digest = hashlib.sha256(value.encode("utf-8")).hexdigest()[:8]
    return f"{readable}-{digest}"


def _bounded_asset_path(run_dir: Path, filename: str) -> Path:
    if len(filename) > _MAX_ASSET_FILENAME_CHARS or len(filename.encode("utf-8")) > _MAX_ASSET_FILENAME_CHARS:
        raise RuntimeError("World Labs asset filename exceeds Nebula's safe limit")
    return run_dir / filename


def _data_uri_reference(value: str, kind: str) -> dict[str, Any]:
    header, separator, body = value.partition(",")
    if not separator:
        raise ValueError(f"Malformed {kind} data URI")

    media_type = header[5:].split(";", 1)[0].strip().lower()
    is_base64 = ";base64" in header.lower()
    # Bound the encoded representation before allocating decoded bytes. Strict
    # base64 needs at most four characters per three bytes; percent-encoded
    # data needs at most three source characters per decoded byte.
    encoded_limit = (
        4 * ((_MAX_INLINE_BYTES + 2) // 3)
        if is_base64
        else 3 * _MAX_INLINE_BYTES
    )
    if len(body) > encoded_limit:
        raise ValueError(
            f"Inline {kind} exceeds World Labs' 10 MB data_base64 limit; "
            "connect a local file so Nebula can use the media-asset upload flow"
        )
    try:
        if is_base64:
            payload = base64.b64decode(body, validate=True)
        else:
            payload = unquote_to_bytes(body)
    except (binascii.Error, ValueError) as exc:
        raise ValueError(f"Malformed {kind} data URI") from exc

    if not payload:
        raise ValueError(f"{kind.capitalize()} data URI is empty")
    if len(payload) > _MAX_INLINE_BYTES:
        raise ValueError(
            f"Inline {kind} exceeds World Labs' 10 MB data_base64 limit; "
            "connect a local file so Nebula can use the media-asset upload flow"
        )

    extension = mimetypes.guess_extension(media_type or "") or ""
    extension = extension.lstrip(".") or ("png" if kind == "image" else "mp4")
    return {
        "source": "data_base64",
        "data_base64": base64.b64encode(payload).decode("ascii"),
        "extension": extension,
    }


async def _file_chunks(path: Path, chunk_size: int = 1024 * 1024) -> AsyncIterator[bytes]:
    with path.open("rb") as stream:
        while chunk := stream.read(chunk_size):
            yield chunk
            await asyncio.sleep(0)


async def _upload_to_signed_url(
    client: httpx.AsyncClient,
    *,
    method: str,
    url: str,
    headers: dict[str, str],
    path: Path,
) -> httpx.Response:
    current_url = url
    for redirect_count in range(_MAX_EXTERNAL_REDIRECTS + 1):
        current_url = await _validated_public_https_url(
            current_url, label="media upload"
        )
        response = await client.request(
            method,
            current_url,
            headers=headers,
            content=_file_chunks(path),
            follow_redirects=False,
        )
        if response.status_code not in {301, 302, 303, 307, 308}:
            return response
        if response.status_code not in {307, 308}:
            raise RuntimeError(
                "World Labs media upload returned a method-changing redirect"
            )
        if redirect_count == _MAX_EXTERNAL_REDIRECTS:
            raise RuntimeError("World Labs media upload exceeded the redirect limit")
        location = response.headers.get("location")
        if not location:
            raise RuntimeError("World Labs media upload redirect had no Location")
        current_url = urljoin(current_url, location)
    raise RuntimeError("World Labs media upload exceeded the redirect limit")


async def _upload_local_media(
    client: httpx.AsyncClient,
    path: Path,
    kind: str,
    headers: dict[str, str],
) -> dict[str, str]:
    size = path.stat().st_size
    if size <= 0:
        raise ValueError(f"{kind.capitalize()} file is empty: {path}")
    limit = _MAX_VIDEO_BYTES if kind == "video" else _MAX_UPLOAD_BYTES
    if size > limit:
        label = "100 MB video" if kind == "video" else "1 GB media upload"
        raise ValueError(f"{kind.capitalize()} file exceeds World Labs' {label} limit: {path}")

    suffix = path.suffix.lstrip(".").lower()
    extension = suffix if re.fullmatch(r"[a-z0-9]{1,10}", suffix) else None
    file_name = path.name
    if len(file_name) > 64:
        retained_suffix = path.suffix[:11]
        file_name = f"{path.stem[:64 - len(retained_suffix)]}{retained_suffix}"

    prepare_body: dict[str, Any] = {"file_name": file_name, "kind": kind}
    if extension:
        prepare_body["extension"] = extension
    response = await client.post(
        f"{WORLDLABS_API_BASE}/media-assets:prepare_upload",
        headers=headers,
        json=prepare_body,
    )
    _raise_api_error("media upload preparation", response)
    prepared = _json_object(response, "media upload preparation")
    media_asset = prepared.get("media_asset") or {}
    media_asset_id = media_asset.get("media_asset_id") or media_asset.get("id")
    upload_info = prepared.get("upload_info") or {}
    upload_url = upload_info.get("upload_url")
    if not media_asset_id or not upload_url:
        raise RuntimeError("World Labs media upload preparation returned no asset ID or upload URL")

    method = str(upload_info.get("upload_method") or "PUT").upper()
    if method not in {"PUT", "POST"}:
        raise RuntimeError(f"World Labs returned unsupported upload method: {method}")
    required_headers = upload_info.get("required_headers") or {}
    if not isinstance(required_headers, dict):
        raise RuntimeError("World Labs returned malformed required upload headers")
    upload_headers = {str(key): str(value) for key, value in required_headers.items()}
    for key in tuple(upload_headers):
        if key.lower() == "content-length":
            del upload_headers[key]
    # Supplying an explicit size keeps httpx from switching the signed upload
    # to Transfer-Encoding: chunked, which GCS signed URLs can reject.
    upload_headers["Content-Length"] = str(size)

    upload_response = await _upload_to_signed_url(
        client,
        method=method,
        url=str(upload_url),
        headers=upload_headers,
        path=path,
    )
    _raise_api_error("media upload", upload_response)
    return {"source": "media_asset", "media_asset_id": str(media_asset_id)}


async def _content_reference(
    client: httpx.AsyncClient,
    value: Any,
    kind: str,
    headers: dict[str, str],
) -> dict[str, Any]:
    raw = _required_string(value, f"{kind.capitalize()} input")
    if raw.startswith("data:"):
        return _data_uri_reference(raw, kind)
    if raw.startswith(("http://", "https://")):
        parsed = urlsplit(raw)
        if not parsed.netloc:
            raise ValueError(f"Malformed remote {kind} URL")
        # URLs served by Nebula/Vite are only reachable on this workstation;
        # World Labs cannot fetch loopback. Resolve output URLs back to their
        # run-owned file and use the media-asset upload flow instead.
        if (parsed.hostname or "").lower() in {
            "localhost",
            "127.0.0.1",
            "0.0.0.0",
            "::1",
        }:
            if parsed.path.startswith("/api/outputs/"):
                resolved = Path(resolve_output_ref(unquote(parsed.path))).expanduser()
                if not resolved.is_file():
                    raise ValueError(f"{kind.capitalize()} file not found: {raw}")
                return await _upload_local_media(client, resolved, kind, headers)
            raise ValueError(
                f"Localhost {kind} URLs are not reachable by World Labs; "
                "connect a Nebula output or local file"
            )
        return {"source": "uri", "uri": raw}
    if raw.startswith("blob:"):
        raise ValueError(
            f"Browser blob URLs cannot be read by the backend; upload the {kind} first"
        )

    resolved = Path(resolve_output_ref(raw)).expanduser()
    if not resolved.is_file():
        raise ValueError(f"{kind.capitalize()} file not found: {raw}")
    return await _upload_local_media(client, resolved, kind, headers)


def _parse_azimuths(raw: Any, count: int) -> list[float | None]:
    if raw in (None, "", []):
        return [None] * count
    values: Any = raw
    if isinstance(raw, str):
        stripped = raw.strip()
        if not stripped:
            return [None] * count
        if stripped.startswith("["):
            try:
                values = json.loads(stripped)
            except json.JSONDecodeError as exc:
                raise ValueError("Azimuths must be comma-separated numbers or a JSON array") from exc
        else:
            values = [item.strip() for item in stripped.split(",")]
    if not isinstance(values, list) or len(values) != count:
        raise ValueError(f"Azimuth count must match the {count} connected images")

    result: list[float | None] = []
    for value in values:
        if value in (None, ""):
            result.append(None)
            continue
        try:
            number = float(value)
        except (TypeError, ValueError) as exc:
            raise ValueError(f"Invalid azimuth: {value!r}") from exc
        if not math.isfinite(number):
            raise ValueError(f"Invalid azimuth: {value!r}")
        result.append(number)
    return result


def _generation_options(node: GraphNode) -> dict[str, Any]:
    model = str(node.params.get("model") or "marble-1.1")
    if model not in WORLDLABS_MODELS:
        raise ValueError(
            f"Unknown World Labs model {model!r}; public API models are {sorted(WORLDLABS_MODELS)}"
        )

    body: dict[str, Any] = {
        "model": model,
        "permission": {
            "public": False,
            "allow_id_access": False,
            "allowed_readers": [],
            "allowed_writers": [],
        },
    }
    display_name = str(node.params.get("display_name") or "").strip()
    if display_name:
        if len(display_name) > 64:
            raise ValueError("World Labs display name must be 64 characters or fewer")
        body["display_name"] = display_name

    seed = node.params.get("seed")
    if seed not in (None, ""):
        if isinstance(seed, bool):
            raise ValueError("World Labs seed must be an integer from 0 to 4294967295")
        try:
            parsed_seed = int(seed)
        except (TypeError, ValueError) as exc:
            raise ValueError("World Labs seed must be an integer from 0 to 4294967295") from exc
        if str(parsed_seed) != str(seed).strip() and not isinstance(seed, int):
            raise ValueError("World Labs seed must be an integer from 0 to 4294967295")
        if not 0 <= parsed_seed <= 4_294_967_295:
            raise ValueError("World Labs seed must be an integer from 0 to 4294967295")
        body["seed"] = parsed_seed

    tags_raw = node.params.get("tags")
    if tags_raw:
        if isinstance(tags_raw, str):
            tags = [item.strip() for item in tags_raw.split(",") if item.strip()]
        elif isinstance(tags_raw, list):
            tags = [str(item).strip() for item in tags_raw if str(item).strip()]
        else:
            raise ValueError("World Labs tags must be a comma-separated string or list")
        if len(tags) > 10 or any(len(tag) > 32 for tag in tags):
            raise ValueError("World Labs accepts at most 10 tags of 32 characters each")
        body["tags"] = tags
    return body


async def _build_world_prompt(
    client: httpx.AsyncClient,
    node: GraphNode,
    inputs: dict[str, PortValueDict],
    headers: dict[str, str],
) -> tuple[dict[str, Any], str]:
    prompt_value = inputs.get("prompt")
    prompt = str(prompt_value.value).strip() if prompt_value and prompt_value.value else ""

    images_value = inputs.get("images")
    raw_images: list[Any] = []
    if images_value and images_value.value:
        raw_images = (
            list(images_value.value)
            if isinstance(images_value.value, list)
            else [images_value.value]
        )
        raw_images = [value for value in raw_images if value not in (None, "")]

    video_value = inputs.get("video")
    video = video_value.value if video_value and video_value.value else None
    if raw_images and video:
        raise ValueError("Connect images or a video to World Labs Environment, not both")

    disable_recaption = node.params.get("disable_recaption") is True
    if video:
        reference = await _content_reference(client, video, "video", headers)
        world_prompt: dict[str, Any] = {"type": "video", "video_prompt": reference}
        prompt_type = "video"
    elif len(raw_images) == 1:
        reference = await _content_reference(client, raw_images[0], "image", headers)
        pano_raw = node.params.get("is_pano", "auto")
        if pano_raw in (True, "true"):
            is_pano: str | bool = True
        elif pano_raw in (False, "false"):
            is_pano = False
        elif pano_raw in (None, "", "auto"):
            is_pano = "auto"
        else:
            raise ValueError("is_pano must be auto, true, or false")
        world_prompt = {
            "type": "image",
            "image_prompt": reference,
            "is_pano": is_pano,
        }
        prompt_type = "image"
    elif raw_images:
        reconstruct = node.params.get("reconstruct_images") is True
        max_images = 8 if reconstruct else 4
        if len(raw_images) > max_images:
            raise ValueError(
                f"World Labs accepts at most {max_images} images when "
                f"reconstruct_images is {'enabled' if reconstruct else 'disabled'}"
            )
        upload_tasks = [
            asyncio.create_task(_content_reference(client, value, "image", headers))
            for value in raw_images
        ]
        try:
            references = await asyncio.gather(*upload_tasks)
        except BaseException:
            for task in upload_tasks:
                if not task.done():
                    task.cancel()
            await asyncio.gather(*upload_tasks, return_exceptions=True)
            raise
        azimuths = _parse_azimuths(node.params.get("azimuths"), len(references))
        located: list[dict[str, Any]] = []
        for reference, azimuth in zip(references, azimuths, strict=True):
            item: dict[str, Any] = {"content": reference}
            if azimuth is not None:
                item["azimuth"] = azimuth
            located.append(item)
        world_prompt = {
            "type": "multi-image",
            "multi_image_prompt": located,
            "reconstruct_images": reconstruct,
        }
        prompt_type = "multi-image"
    else:
        if not prompt:
            raise ValueError("Connect a prompt, one or more images, or a video")
        world_prompt = {"type": "text", "text_prompt": prompt}
        prompt_type = "text"

    if prompt and prompt_type != "text":
        world_prompt["text_prompt"] = prompt
    if disable_recaption:
        world_prompt["disable_recaption"] = True
    return world_prompt, prompt_type


def _operation_error(operation: dict[str, Any]) -> RuntimeError | None:
    error = operation.get("error")
    if not error:
        return None
    if isinstance(error, dict):
        message = error.get("message") or error.get("detail") or json.dumps(error, default=str)
    else:
        message = str(error)
    return RuntimeError(f"World Labs operation failed: {message}")


def _operation_progress(operation: dict[str, Any], fallback: float) -> float:
    metadata = operation.get("metadata")
    candidates: list[Any] = []
    if isinstance(metadata, dict):
        candidates.extend(
            [metadata.get("progress_percent"), metadata.get("progressPercentage")]
        )
        nested = metadata.get("progress")
        if isinstance(nested, dict):
            candidates.extend([nested.get("percent"), nested.get("percentage")])
    for value in candidates:
        if isinstance(value, (int, float)) and not isinstance(value, bool):
            normalized = float(value) / 100 if value > 1 else float(value)
            return max(0.0, min(normalized, 0.99))
    return fallback


async def _poll_operation(
    client: httpx.AsyncClient,
    operation: dict[str, Any],
    headers: dict[str, str],
    node_id: str,
    emit: Callable[[ExecutionEvent], Awaitable[None]],
    *,
    poll_interval: float,
    max_polls: int,
) -> dict[str, Any]:
    operation_id = _provider_id(operation.get("operation_id"), "World Labs operation ID")
    current = operation
    for poll_number in range(max_polls + 1):
        error = _operation_error(current)
        if error:
            raise error
        if current.get("done") is True:
            response = current.get("response")
            if not isinstance(response, dict):
                raise RuntimeError("World Labs operation completed without a result")
            return current
        if poll_number == max_polls:
            break

        await emit(
            ProgressEvent(
                node_id=node_id,
                value=_operation_progress(
                    current,
                    min((poll_number + 1) / max_polls, 0.99),
                ),
            )
        )
        # The public World API has no cancellation endpoint. CancelledError is
        # deliberately allowed to propagate here: Nebula stops polling, while
        # the accepted provider operation may continue and remain billable.
        await asyncio.sleep(poll_interval)
        response = await client.get(
            f"{WORLDLABS_API_BASE}/operations/{_api_path_id(operation_id)}",
            headers=headers,
        )
        _raise_api_error("operation poll", response)
        current = _json_object(response, "operation poll")

    raise RuntimeError(
        f"World Labs operation {operation_id} timed out after "
        f"{max_polls * poll_interval:.0f} seconds"
    )


def _unwrap_world(value: Any) -> dict[str, Any]:
    if not isinstance(value, dict):
        raise RuntimeError("World Labs returned a malformed world")
    wrapped = value.get("world")
    return wrapped if isinstance(wrapped, dict) else value


def _world_id_from_operation(operation: dict[str, Any]) -> str:
    response = _unwrap_world(operation.get("response"))
    world_id = response.get("world_id") or response.get("id")
    if not world_id:
        metadata = operation.get("metadata")
        if isinstance(metadata, dict):
            world_id = metadata.get("world_id")
    return _provider_id(world_id, "World Labs world ID")


def _detected_image_suffix(header: bytes) -> str | None:
    if header.startswith(b"\x89PNG\r\n\x1a\n"):
        return ".png"
    if header.startswith(b"\xff\xd8\xff"):
        return ".jpg"
    if header.startswith((b"GIF87a", b"GIF89a")):
        return ".gif"
    if len(header) >= 12 and header[:4] == b"RIFF" and header[8:12] == b"WEBP":
        return ".webp"
    return None


def _validate_image_extent(path: Path, width: int, height: int) -> None:
    if (
        width <= 0
        or height <= 0
        or width > _MAX_IMAGE_DIMENSION
        or height > _MAX_IMAGE_DIMENSION
        or width * height > _MAX_IMAGE_PIXELS
    ):
        raise RuntimeError(
            f"World Labs returned unsafe image dimensions for {path.name}: "
            f"{width}x{height}"
        )


def _jpeg_dimensions(header: bytes, path: Path) -> tuple[int, int]:
    if not header.startswith(b"\xff\xd8"):
        raise RuntimeError(f"World Labs returned a malformed JPEG for {path.name}")
    offset = 2
    sof_markers = {
        *range(0xC0, 0xC4),
        *range(0xC5, 0xC8),
        *range(0xC9, 0xCC),
        *range(0xCD, 0xD0),
    }
    while offset < len(header):
        while offset < len(header) and header[offset] != 0xFF:
            offset += 1
        while offset < len(header) and header[offset] == 0xFF:
            offset += 1
        if offset >= len(header):
            break
        marker = header[offset]
        offset += 1
        if marker in {0x00, 0x01, *range(0xD0, 0xD9)}:
            continue
        if offset + 2 > len(header):
            break
        segment_size = int.from_bytes(header[offset : offset + 2], "big")
        if segment_size < 2 or offset + segment_size > len(header):
            break
        if marker in sof_markers:
            if segment_size < 8:
                break
            height = int.from_bytes(header[offset + 3 : offset + 5], "big")
            width = int.from_bytes(header[offset + 5 : offset + 7], "big")
            return width, height
        if marker in {0xD9, 0xDA}:
            break
        offset += segment_size
    raise RuntimeError(f"World Labs returned a malformed JPEG for {path.name}")


def _validate_image_dimensions(path: Path, suffix: str) -> None:
    with path.open("rb") as asset:
        header = asset.read(_MAX_IMAGE_HEADER_BYTES + 1)

    width = height = 0
    if suffix == ".png":
        if len(header) < 24 or header[12:16] != b"IHDR":
            raise RuntimeError(f"World Labs returned a malformed PNG for {path.name}")
        width, height = struct.unpack_from(">II", header, 16)
    elif suffix == ".gif":
        if len(header) < 10:
            raise RuntimeError(f"World Labs returned a malformed GIF for {path.name}")
        width, height = struct.unpack_from("<HH", header, 6)
    elif suffix == ".webp":
        if len(header) < 25:
            raise RuntimeError(f"World Labs returned a malformed WebP for {path.name}")
        chunk_type = header[12:16]
        if chunk_type == b"VP8X" and len(header) >= 30:
            width = 1 + int.from_bytes(header[24:27], "little")
            height = 1 + int.from_bytes(header[27:30], "little")
        elif chunk_type == b"VP8 " and len(header) >= 30 and header[23:26] == b"\x9d\x01\x2a":
            width = int.from_bytes(header[26:28], "little") & 0x3FFF
            height = int.from_bytes(header[28:30], "little") & 0x3FFF
        elif chunk_type == b"VP8L" and header[20] == 0x2F:
            dimensions = int.from_bytes(header[21:25], "little")
            width = 1 + (dimensions & 0x3FFF)
            height = 1 + ((dimensions >> 14) & 0x3FFF)
        else:
            raise RuntimeError(f"World Labs returned a malformed WebP for {path.name}")
    elif suffix == ".jpg":
        width, height = _jpeg_dimensions(header, path)
    else:
        raise RuntimeError(f"World Labs returned an unsupported image for {path.name}")

    _validate_image_extent(path, width, height)


def _validate_glb(path: Path) -> None:
    size = path.stat().st_size
    with path.open("rb") as asset:
        header = asset.read(20)
    if len(header) < 20 or header[:4] != b"glTF":
        raise RuntimeError(f"World Labs returned invalid GLB bytes for {path.name}")
    version, declared_size = struct.unpack_from("<II", header, 4)
    first_chunk_size, first_chunk_type = struct.unpack_from("<I4s", header, 12)
    if (
        version != 2
        or declared_size != size
        or first_chunk_type != b"JSON"
        or first_chunk_size == 0
        or first_chunk_size > size - 20
    ):
        raise RuntimeError(f"World Labs returned a malformed GLB for {path.name}")


def _validate_ply(path: Path) -> None:
    with path.open("rb") as asset:
        prefix = asset.read(_MAX_PLY_HEADER_BYTES + 1)
    if len(prefix) > _MAX_PLY_HEADER_BYTES:
        prefix = prefix[:_MAX_PLY_HEADER_BYTES]
    header_match = re.search(br"(?:^|\n)end_header\r?\n", prefix)
    if header_match is None:
        raise RuntimeError(f"World Labs returned a malformed PLY header for {path.name}")
    header = prefix[: header_match.end()]
    try:
        lines = [line.rstrip(b"\r") for line in header.splitlines()]
        header.decode("ascii")
    except UnicodeDecodeError as exc:
        raise RuntimeError(
            f"World Labs returned a non-ASCII PLY header for {path.name}"
        ) from exc
    formats = {
        b"format ascii 1.0",
        b"format binary_little_endian 1.0",
        b"format binary_big_endian 1.0",
    }
    vertex_counts = []
    for line in lines:
        match = re.fullmatch(br"element vertex ([0-9]+)", line)
        if match:
            vertex_counts.append(int(match.group(1)))
    if (
        not lines
        or lines[0] != b"ply"
        or not any(line in formats for line in lines)
        or len(vertex_counts) != 1
        or vertex_counts[0] <= 0
        or path.stat().st_size <= len(header)
    ):
        raise RuntimeError(f"World Labs returned a malformed PLY for {path.name}")


def _validate_spz(path: Path) -> None:
    size = path.stat().st_size
    with path.open("rb") as asset:
        header = asset.read(2)
        if size >= 4:
            asset.seek(-4, 2)
            trailer = asset.read(4)
        else:
            trailer = b""

    # Nebula's pinned Spark 2.1 reader accepts gzip-wrapped SPZ versions 1-3.
    # It does not decode the newer raw NGSP/v4 container, so accepting v4 here
    # would persist a World that Nebula itself cannot render.
    if header != b"\x1f\x8b" or len(trailer) != 4:
        raise RuntimeError(f"World Labs returned invalid SPZ bytes for {path.name}")
    try:
        with gzip.open(path, "rb") as asset:
            legacy = asset.read(16)
            if len(legacy) != 16 or legacy[:4] != b"NGSP":
                raise RuntimeError(
                    f"World Labs returned a malformed SPZ header for {path.name}"
                )

            _magic, version, point_count, sh_degree, fractional_bits, flags, reserved = (
                struct.unpack("<III4B", legacy)
            )
            if (
                version not in {1, 2, 3}
                or point_count <= 0
                or sh_degree > 3
                or fractional_bits > 23
                or flags & ~0x81
                or reserved != 0
            ):
                raise RuntimeError(
                    f"World Labs returned a malformed SPZ header for {path.name}"
                )

            position_bytes = 6 if version == 1 else 9
            rotation_bytes = 4 if version == 3 else 3
            sh_bytes = {0: 0, 1: 9, 2: 24, 3: 45}[sh_degree]
            lod_bytes = 6 if flags & 0x80 else 0
            expected_size = 16 + point_count * (
                position_bytes
                + 1  # alpha
                + 3  # color
                + 3  # scale
                + rotation_bytes
                + sh_bytes
                + lod_bytes
            )
            if expected_size > _MAX_SPZ_UNCOMPRESSED_BYTES:
                raise RuntimeError(
                    f"World Labs SPZ expands beyond Nebula's safe limit: {path.name}"
                )
            gzip_size = struct.unpack("<I", trailer)[0]
            if gzip_size != expected_size:
                raise RuntimeError(
                    f"World Labs returned inconsistent SPZ size metadata for {path.name}"
                )

            # Finish the stream in fixed-size chunks. This validates both the
            # exact payload length and gzip CRC without allocating the expanded
            # splat in memory, and rejects a forged header/trailer pair whose
            # compressed body is truncated or corrupt.
            decompressed_size = len(legacy)
            while chunk := asset.read(4 * 1024 * 1024):
                decompressed_size += len(chunk)
                if decompressed_size > expected_size:
                    raise RuntimeError(
                        f"World Labs returned oversized SPZ payload data for {path.name}"
                    )
            if decompressed_size != expected_size:
                raise RuntimeError(
                    f"World Labs returned truncated SPZ payload data for {path.name}"
                )
    except (EOFError, OSError) as exc:
        raise RuntimeError(
            f"World Labs returned a malformed SPZ gzip for {path.name}"
        ) from exc


def _validated_asset_destination(partial: Path, destination: Path) -> Path:
    """Strictly validate downloaded provider bytes before installing them."""
    expected = destination.suffix.lower()
    if expected in {".png", ".jpg", ".jpeg", ".gif", ".webp"}:
        with partial.open("rb") as asset:
            detected = _detected_image_suffix(asset.read(16))
        if detected is None:
            raise RuntimeError(
                f"World Labs returned non-image bytes for {destination.name}"
            )
        _validate_image_dimensions(partial, detected)
        return destination.with_suffix(detected)
    if expected == ".glb":
        _validate_glb(partial)
        return destination
    if expected == ".ply":
        _validate_ply(partial)
        return destination
    if expected == ".spz":
        _validate_spz(partial)
        return destination
    raise RuntimeError(f"Nebula has no validator for World Labs asset {destination.name}")


async def _download_asset(
    client: httpx.AsyncClient,
    url: str,
    destination: Path,
    *,
    max_bytes: int | None = None,
) -> Path:
    byte_limit = _MAX_ASSET_DOWNLOAD_BYTES
    if max_bytes is not None:
        byte_limit = min(byte_limit, max(0, max_bytes))
    if byte_limit <= 0:
        raise RuntimeError("World Labs assets exceed Nebula's aggregate download limit")

    partial = destination.with_name(f".{destination.name}.part")
    try:
        current_url = url
        for redirect_count in range(_MAX_EXTERNAL_REDIRECTS + 1):
            current_url = await _validated_public_https_url(
                current_url, label="asset"
            )
            async with client.stream(
                "GET", current_url, follow_redirects=False
            ) as response:
                if response.status_code in {301, 302, 303, 307, 308}:
                    if redirect_count == _MAX_EXTERNAL_REDIRECTS:
                        raise RuntimeError(
                            "World Labs asset download exceeded the redirect limit"
                        )
                    location = response.headers.get("location")
                    if not location:
                        raise RuntimeError(
                            "World Labs asset redirect had no Location"
                        )
                    current_url = urljoin(current_url, location)
                    continue

                await _raise_streamed_api_error(
                    f"asset download ({destination.name})", response
                )
                declared_size = response.headers.get("content-length")
                if declared_size is not None:
                    try:
                        declared_bytes = int(declared_size)
                    except ValueError as exc:
                        raise RuntimeError(
                            f"World Labs returned an invalid Content-Length for {destination.name}"
                        ) from exc
                    if declared_bytes < 0:
                        raise RuntimeError(
                            f"World Labs returned an invalid Content-Length for {destination.name}"
                        )
                    if declared_bytes > byte_limit:
                        raise RuntimeError(
                            f"World Labs asset exceeds Nebula's download limit: "
                            f"{destination.name}"
                        )
                size = 0
                with partial.open("wb") as output:
                    async for chunk in response.aiter_bytes():
                        if chunk:
                            size += len(chunk)
                            if size > byte_limit:
                                raise RuntimeError(
                                    f"World Labs asset exceeds Nebula's download limit: "
                                    f"{destination.name}"
                                )
                            output.write(chunk)
                if size == 0:
                    raise RuntimeError(
                        f"World Labs returned an empty asset: {destination.name}"
                    )
                break
        else:
            raise RuntimeError("World Labs asset download exceeded the redirect limit")
        final_destination = _validated_asset_destination(partial, destination)
        partial.replace(final_destination)
        return final_destination
    except BaseException:
        partial.unlink(missing_ok=True)
        raise


def _cleanup_world_asset_paths(
    specs: list[tuple[str, str, Path]],
    completed: list[Any] | tuple[Any, ...] = (),
) -> None:
    """Remove original, partial, and magic-byte-renamed World artifacts."""
    cleanup_paths = {destination for _key, _url, destination in specs}
    cleanup_paths.update(path for path in completed if isinstance(path, Path))
    for destination in cleanup_paths:
        destination.unlink(missing_ok=True)
        destination.with_name(f".{destination.name}.part").unlink(missing_ok=True)
        for alternative in destination.parent.glob(f"{destination.stem}.*"):
            if alternative.is_file():
                alternative.unlink(missing_ok=True)


async def _materialize_world(
    client: httpx.AsyncClient,
    world: dict[str, Any],
    prompt_type: str,
    operation: dict[str, Any],
    run_dir: Path,
    requested_model: str,
    node_id: str,
) -> tuple[dict[str, Any], dict[str, Path]]:
    world_id = _provider_id(
        world.get("world_id") or world.get("id"), "World Labs world ID"
    )
    world_component = _stable_asset_component(
        world_id, "world", readable_chars=40
    )
    node_component = _stable_asset_component(node_id, "node")
    stem = f"worldlabs-{world_component}-{node_component}"
    assets = world.get("assets") or {}
    if not isinstance(assets, dict):
        raise RuntimeError("World Labs returned malformed world assets")

    splats = assets.get("splats") or {}
    spz_urls = splats.get("spz_urls") if isinstance(splats, dict) else {}
    if spz_urls is None:
        spz_urls = {}
    if not isinstance(spz_urls, dict):
        raise RuntimeError("World Labs returned malformed SPZ asset URLs")
    populated_spz_urls = [value for value in spz_urls.values() if value]
    if len(populated_spz_urls) > _MAX_SPZ_VARIANTS:
        raise RuntimeError(
            f"World Labs returned too many SPZ variants ({len(populated_spz_urls)}; "
            f"maximum {_MAX_SPZ_VARIANTS})"
        )

    specs: list[tuple[str, str, Path]] = []
    for raw_variant, raw_url in sorted(spz_urls.items(), key=lambda item: str(item[0])):
        if raw_url:
            if not isinstance(raw_url, str):
                raise RuntimeError(
                    f"World Labs returned a malformed SPZ URL for {raw_variant!r}"
                )
            variant = str(raw_variant)
            # Provider-controlled future variant labels may sanitize to the
            # same stem (for example ``a/b`` and ``a?b``). Include a stable
            # digest so concurrent downloads never share a destination/.part.
            variant_name = _stable_asset_component(
                variant, "variant", readable_chars=48
            )
            specs.append(
                (
                    f"splat:{variant}",
                    str(raw_url),
                    _bounded_asset_path(
                        run_dir, f"{stem}-splat-{variant_name}.spz"
                    ),
                )
            )

    imagery = assets.get("imagery") or {}
    mesh = assets.get("mesh") or {}
    panorama_url = imagery.get("pano_url") if isinstance(imagery, dict) else None
    collider_url = mesh.get("collider_mesh_url") if isinstance(mesh, dict) else None
    thumbnail_url = assets.get("thumbnail_url")
    if panorama_url:
        specs.append(
            (
                "panorama",
                str(panorama_url),
                _bounded_asset_path(run_dir, f"{stem}-panorama.png"),
            )
        )
    if collider_url:
        specs.append(
            (
                "collider",
                str(collider_url),
                _bounded_asset_path(run_dir, f"{stem}-collider.glb"),
            )
        )
    if thumbnail_url:
        specs.append(
            (
                "thumbnail",
                str(thumbnail_url),
                _bounded_asset_path(run_dir, f"{stem}-thumbnail.png"),
            )
        )

    downloaded: list[Path] = []
    remaining_bytes = _MAX_WORLD_ASSET_BYTES
    try:
        # Sequential transfer bounds both concurrency and aggregate disk use.
        # Every returned asset is still preserved; exceeding the budget fails
        # the World atomically instead of silently dropping full_res/future data.
        for _key, url, destination in specs:
            path = await _download_asset(
                client,
                url,
                destination,
                max_bytes=remaining_bytes,
            )
            size = path.stat().st_size
            if size > remaining_bytes:
                raise RuntimeError("World Labs assets exceed Nebula's aggregate download limit")
            downloaded.append(path)
            remaining_bytes -= size
    except BaseException:
        _cleanup_world_asset_paths(specs, downloaded)
        raise

    materialized = {
        key: path for (key, _url, _destination), path in zip(specs, downloaded, strict=True)
    }
    local_splats = {
        key.split(":", 1)[1]: str(path)
        for key, path in materialized.items()
        if key.startswith("splat:")
    }
    if not local_splats:
        _cleanup_world_asset_paths(specs, downloaded)
        raise RuntimeError("World Labs world completed without any SPZ assets")

    semantics_raw = splats.get("semantics_metadata") if isinstance(splats, dict) else {}
    semantics_raw = semantics_raw if isinstance(semantics_raw, dict) else {}
    metric_scale = semantics_raw.get("metric_scale_factor")
    ground_offset = semantics_raw.get("ground_plane_offset")
    metric_scale_value = (
        float(metric_scale)
        if isinstance(metric_scale, (int, float))
        and not isinstance(metric_scale, bool)
        and math.isfinite(float(metric_scale))
        and float(metric_scale) > 0
        else None
    )
    ground_offset_value = (
        float(ground_offset)
        if isinstance(ground_offset, (int, float))
        and not isinstance(ground_offset, bool)
        and math.isfinite(float(ground_offset))
        else None
    )
    semantics = {
        "metricScaleFactor": metric_scale_value,
        "groundPlaneOffset": ground_offset_value,
        "coordinateFrame": WORLD_COORDINATE_FRAME,
    }

    local_assets = {
        "splats": local_splats,
        "panorama": str(materialized["panorama"]) if "panorama" in materialized else None,
        "colliderMesh": str(materialized["collider"]) if "collider" in materialized else None,
        "thumbnail": str(materialized["thumbnail"]) if "thumbnail" in materialized else None,
    }
    world_value: dict[str, Any] = {
        "schemaVersion": WORLD_SCHEMA_VERSION,
        "provider": "worldlabs",
        "worldId": world_id,
        "model": world.get("model") or requested_model,
        "displayName": world.get("display_name"),
        "marbleUrl": world.get("world_marble_url")
        or f"https://marble.worldlabs.ai/world/{_api_path_id(world_id)}",
        "promptType": prompt_type,
        "assets": local_assets,
        "semantics": semantics,
        "caption": assets.get("caption"),
    }
    if isinstance(operation.get("cost"), dict):
        world_value["cost"] = operation["cost"]
    return world_value, materialized


def _optional_recovery_id(node: GraphNode, key: str, label: str) -> str | None:
    value = node.params.get(key)
    if value is None or (isinstance(value, str) and not value.strip()):
        return None
    return _provider_id(value, label)


def _remember_generation_operation(node: GraphNode, operation_id: str) -> None:
    """Persist the paid operation before any fallible poll/retrieval work."""
    node.params["resume_operation_id"] = operation_id
    node.params.pop("existing_world_id", None)


def _remember_generation_world(node: GraphNode, world_id: str) -> None:
    """Advance recovery from an operation poll to the resulting World."""
    node.params["existing_world_id"] = world_id
    node.params.pop("resume_operation_id", None)


async def _publish_recovery_state(
    node: GraphNode,
    emit: Callable[[ExecutionEvent], Awaitable[None]],
) -> None:
    """Publish the full recovery checkpoint, settling it before cancellation.

    The event is deliberately emitted at each state transition rather than at
    node completion. A browser can therefore preserve an accepted paid
    operation even when Stop interrupts polling or local materialization.
    """
    event = ProviderRecoveryEvent(
        node_id=node.id,
        resume_operation_id=_optional_recovery_id(
            node, "resume_operation_id", "World Labs resume operation ID"
        ),
        existing_world_id=_optional_recovery_id(
            node, "existing_world_id", "World Labs existing world ID"
        ),
    )
    task = asyncio.create_task(emit(event))
    _, cancellation_requested = await _await_settled(task)
    if cancellation_requested:
        raise asyncio.CancelledError


async def _publish_start_ambiguity(
    node: GraphNode,
    kind: Literal["worldlabs-environment", "worldlabs-world-export"],
    emit: Callable[[ExecutionEvent], Awaitable[None]],
) -> None:
    """Install a fail-closed hold when a paid start has no trustworthy ID."""
    event = ProviderStartAmbiguousEvent(
        node_id=node.id,
        kind=kind,
        message=AMBIGUITY_MESSAGE,
    )
    task = asyncio.create_task(emit(event))
    _, cancellation_requested = await _await_settled(task)
    if cancellation_requested:
        raise asyncio.CancelledError


def _prompt_type_from_world(world: dict[str, Any], fallback: str) -> str:
    world_prompt = world.get("world_prompt")
    prompt_type = world_prompt.get("type") if isinstance(world_prompt, dict) else None
    return prompt_type.strip() if isinstance(prompt_type, str) and prompt_type.strip() else fallback


def _post_accept_failure(
    action: str,
    error: Exception,
    *,
    operation_id: str | None,
    world_id: str | None,
    recovery_param: str,
) -> RuntimeError:
    identifiers: list[str] = []
    if operation_id:
        identifiers.append(f"operationId={operation_id}")
    if world_id:
        identifiers.append(f"worldId={world_id}")
    identifier_text = ", ".join(identifiers) or "provider identifiers unavailable"
    recovery_value = world_id if recovery_param == "existing_world_id" else operation_id
    recovery_hint = (
        f" Recover with {recovery_param}={recovery_value};"
        if recovery_value
        else " Recover from the operation/world identifier shown in Marble;"
    )
    return RuntimeError(
        f"World Labs {action} was already accepted or is being recovered "
        f"({identifier_text}), but Nebula could not finish locally. Provider work may "
        "have completed and may be billable. Check World Labs Marble before taking "
        f"action; do not blindly rerun this node.{recovery_hint} cause: {error}"
    )


def _validated_world_input(inputs: dict[str, PortValueDict]) -> tuple[dict[str, Any], str]:
    world_input = inputs.get("world")
    if not world_input or world_input.type != "World" or not isinstance(world_input.value, dict):
        raise ValueError("World input is required")
    world_value = world_input.value
    schema_version = world_value.get("schemaVersion")
    if schema_version == WORLD_SCHEMA_VERSION:
        if world_value.get("provider") != "worldlabs":
            raise ValueError("World Labs Export requires a World Labs World value")
        raw_world_id = world_value.get("worldId") or world_value.get("world_id")
    elif schema_version == 2:
        # Session provenance is user-importable descriptive metadata. It cannot
        # authorize a provider request against an arbitrary World-v2 id. A
        # future adapter must supply a backend-verified resource binding.
        raise ValueError(
            "World Labs Export requires a verified provider-resource binding "
            "for World v2; use the original Marble World v1 output"
        )
    else:
        raise ValueError("World Labs Export requires World schemaVersion 1 or 2")
    world_id = _provider_id(raw_world_id, "World Labs world ID")
    return world_value, world_id


async def handle_worldlabs_environment(
    node: GraphNode,
    inputs: dict[str, PortValueDict],
    api_keys: dict[str, str],
    emit: Callable[[ExecutionEvent], Awaitable[None]] | None = None,
) -> dict[str, Any]:
    api_key = api_keys.get("WORLDLABS_API_KEY")
    if not api_key:
        raise ValueError("WORLDLABS_API_KEY is required")
    headers = _api_headers(api_key)
    resume_operation_id = _optional_recovery_id(
        node, "resume_operation_id", "World Labs resume operation ID"
    )
    existing_world_id = _optional_recovery_id(
        node, "existing_world_id", "World Labs existing world ID"
    )
    if resume_operation_id and existing_world_id:
        raise ValueError(
            "Set either resume_operation_id or existing_world_id, not both"
        )

    operation_id: str | None = None
    world_id: str | None = existing_world_id
    recovery_started = False
    event_emit = emit or _noop_emit

    timeout = httpx.Timeout(connect=30.0, read=300.0, write=300.0, pool=30.0)
    async with httpx.AsyncClient(timeout=timeout) as client:
        try:
            if existing_world_id:
                _remember_generation_world(node, existing_world_id)
                await _publish_recovery_state(node, event_emit)
                recovery_started = True
                operation = {
                    "done": True,
                    "response": {"world_id": existing_world_id},
                }
                requested_model = str(node.params.get("model") or "marble-1.1")
                prompt_type = "existing-world"
            else:
                if resume_operation_id:
                    _remember_generation_operation(node, resume_operation_id)
                    await _publish_recovery_state(node, event_emit)
                    recovery_started = True
                    operation_id = resume_operation_id
                    operation = {
                        "operation_id": resume_operation_id,
                        "done": False,
                    }
                    prompt_type = "resumed-operation"
                    requested_model = str(node.params.get("model") or "marble-1.1")
                else:
                    body = _generation_options(node)
                    world_prompt, prompt_type = await _build_world_prompt(
                        client, node, inputs, headers
                    )
                    body["world_prompt"] = world_prompt
                    requested_model = str(body["model"])
                    response, start_error, stop_requested = await _paid_post(
                        client,
                        f"{WORLDLABS_API_BASE}/worlds:generate",
                        headers=headers,
                        body=body,
                    )
                    if start_error is not None:
                        await _publish_start_ambiguity(
                            node, "worldlabs-environment", event_emit
                        )
                        if stop_requested:
                            raise asyncio.CancelledError from start_error
                        raise RuntimeError(
                            "World Labs generation start response was not received. Nebula "
                            "safety-locked this node because the public API has no "
                            "idempotency key and a retry could create a second paid world; "
                            "check World Labs Marble before explicitly unlocking it."
                        ) from start_error
                    if response is None:
                        raise RuntimeError("World Labs generation start did not settle")
                    try:
                        _raise_api_error("generation start", response)
                        operation = _json_object(response, "generation start")
                        operation_id = _provider_id(
                            operation.get("operation_id"), "World Labs operation ID"
                        )
                        recovery_started = True
                        _remember_generation_operation(node, operation_id)
                        await _publish_recovery_state(node, event_emit)
                    except asyncio.CancelledError:
                        raise
                    except Exception as exc:
                        if _paid_start_response_is_ambiguous(response):
                            await _publish_start_ambiguity(
                                node, "worldlabs-environment", event_emit
                            )
                        if stop_requested:
                            raise asyncio.CancelledError from exc
                        raise
                    if stop_requested:
                        raise asyncio.CancelledError

                operation = await _poll_operation(
                    client,
                    operation,
                    headers,
                    node.id,
                    event_emit,
                    poll_interval=2.0,
                    max_polls=600,
                )
                world_id = _world_id_from_operation(operation)
                _remember_generation_world(node, world_id)
                await _publish_recovery_state(node, event_emit)

            world_response = await client.get(
                f"{WORLDLABS_API_BASE}/worlds/{_api_path_id(world_id)}",
                headers=headers,
            )
            _raise_api_error("world retrieval", world_response)
            world = _unwrap_world(_json_object(world_response, "world retrieval"))
            prompt_type = _prompt_type_from_world(world, prompt_type)
            world_value, materialized = await _materialize_world(
                client,
                world,
                prompt_type,
                operation,
                get_run_dir(),
                requested_model=requested_model,
                node_id=node.id,
            )
        except asyncio.CancelledError:
            if operation_id:
                logger.warning(
                    "Nebula stopped polling World Labs operation %s; the public API has no "
                    "cancellation endpoint, so provider work may continue and remain billable",
                    operation_id,
                )
            raise
        except Exception as exc:
            if recovery_started:
                recovery_param = (
                    "existing_world_id" if world_id else "resume_operation_id"
                )
                raise _post_accept_failure(
                    "generation/recovery",
                    exc,
                    operation_id=operation_id,
                    world_id=world_id,
                    recovery_param=recovery_param,
                ) from exc
            raise

    outputs: dict[str, Any] = {"world": {"type": "World", "value": world_value}}
    if "panorama" in materialized:
        outputs["panorama"] = {"type": "Image", "value": str(materialized["panorama"])}
    if "collider" in materialized:
        outputs["collider"] = {"type": "Mesh", "value": str(materialized["collider"])}
    if "thumbnail" in materialized:
        outputs["thumbnail"] = {"type": "Image", "value": str(materialized["thumbnail"])}
    if world_value.get("caption"):
        outputs["caption"] = {"type": "Text", "value": str(world_value["caption"])}
    return outputs


async def handle_worldlabs_export(
    node: GraphNode,
    inputs: dict[str, PortValueDict],
    api_keys: dict[str, str],
    emit: Callable[[ExecutionEvent], Awaitable[None]] | None = None,
) -> dict[str, Any]:
    api_key = api_keys.get("WORLDLABS_API_KEY")
    if not api_key:
        raise ValueError("WORLDLABS_API_KEY is required")
    _world_value, world_id = _validated_world_input(inputs)
    resume_operation_id = _optional_recovery_id(
        node, "resume_operation_id", "World Labs resume export operation ID"
    )

    output_format = str(node.params.get("format") or "ply").lower()
    if output_format not in {"ply", "glb"}:
        raise ValueError("World Labs export format must be ply or glb")
    if output_format == "ply":
        resolution = str(node.params.get("resolution") or "full_res")
        if resolution not in {"full_res", "500k", "150k", "100k"}:
            raise ValueError("World Labs PLY resolution must be full_res, 500k, 150k, or 100k")
        body = {"asset_type": "splats", "format": "ply", "resolution": resolution}
    else:
        mesh_variant = str(node.params.get("mesh_variant") or "textured")
        if mesh_variant not in {"textured", "vertex_colored"}:
            raise ValueError("World Labs GLB mesh variant must be textured or vertex_colored")
        body = {"asset_type": "mesh", "format": "glb", "mesh_variant": mesh_variant}

    headers = _api_headers(api_key)
    operation_id: str | None = None
    recovery_started = False
    event_emit = emit or _noop_emit
    timeout = httpx.Timeout(connect=30.0, read=300.0, write=300.0, pool=30.0)
    async with httpx.AsyncClient(timeout=timeout) as client:
        try:
            if resume_operation_id:
                node.params["resume_operation_id"] = resume_operation_id
                await _publish_recovery_state(node, event_emit)
                recovery_started = True
                operation_id = resume_operation_id
                operation = {
                    "operation_id": resume_operation_id,
                    "done": False,
                }
            else:
                response, start_error, stop_requested = await _paid_post(
                    client,
                    f"{WORLDLABS_API_BASE}/worlds/{_api_path_id(world_id)}:export",
                    headers=headers,
                    body=body,
                )
                if start_error is not None:
                    if output_format == "glb":
                        await _publish_start_ambiguity(
                            node, "worldlabs-world-export", event_emit
                        )
                    if stop_requested:
                        raise asyncio.CancelledError from start_error
                    if output_format == "glb":
                        raise RuntimeError(
                            "World Labs export start response was not received. Nebula "
                            "safety-locked this node because a retry could duplicate a paid "
                            "HQ mesh operation; check World Labs Marble before explicitly "
                            "unlocking it."
                        ) from start_error
                    raise RuntimeError(
                        "World Labs free PLY export start response was not received; no "
                        "paid-start safety hold was created."
                    ) from start_error
                if response is None:
                    raise RuntimeError("World Labs export start did not settle")
                try:
                    _raise_api_error("export start", response)
                    operation = _json_object(response, "export start")
                    operation_id = _provider_id(
                        operation.get("operation_id"), "World Labs operation ID"
                    )
                    recovery_started = True
                    node.params["resume_operation_id"] = operation_id
                    await _publish_recovery_state(node, event_emit)
                except asyncio.CancelledError:
                    raise
                except Exception as exc:
                    if output_format == "glb" and _paid_start_response_is_ambiguous(
                        response
                    ):
                        await _publish_start_ambiguity(
                            node, "worldlabs-world-export", event_emit
                        )
                    if stop_requested:
                        raise asyncio.CancelledError from exc
                    raise
                if stop_requested:
                    raise asyncio.CancelledError

            operation = await _poll_operation(
                client,
                operation,
                headers,
                node.id,
                event_emit,
                poll_interval=5.0,
                max_polls=900,
            )
            result = operation.get("response")
            if not isinstance(result, dict) or not result.get("url"):
                raise RuntimeError("World Labs export completed without a download URL")
            returned_format = result.get("format")
            returned_asset_type = result.get("asset_type")
            if returned_format is not None and returned_format != output_format:
                raise RuntimeError(
                    "World Labs export result format does not match this node; set the node "
                    "to the original export format before resuming"
                )
            if returned_asset_type is not None and returned_asset_type != body["asset_type"]:
                raise RuntimeError(
                    "World Labs export result asset type does not match this node; set the "
                    "node to the original export settings before resuming"
                )
            setting_key = "resolution" if output_format == "ply" else "mesh_variant"
            expected_setting = body[setting_key]
            returned_setting = result.get(setting_key)
            if returned_setting is not None and returned_setting != expected_setting:
                setting_label = setting_key.replace("_", " ")
                raise RuntimeError(
                    f"World Labs export result {setting_label} does not match this node; "
                    "set the node to the original export settings before resuming"
                )
            setting = str(expected_setting)
            filename = (
                f"worldlabs-{_stable_asset_component(world_id, 'world', readable_chars=40)}-"
                f"{_stable_asset_component(node.id, 'node')}-"
                f"{_stable_asset_component(setting, 'export')}.{output_format}"
            )
            path = await _download_asset(
                client,
                str(result["url"]),
                _bounded_asset_path(get_run_dir(), filename),
            )
        except asyncio.CancelledError:
            if operation_id:
                logger.warning(
                    "Nebula stopped polling World Labs export operation %s; the public API "
                    "has no cancellation endpoint, so provider work may continue and remain billable",
                    operation_id,
                )
            raise
        except Exception as exc:
            if recovery_started:
                raise _post_accept_failure(
                    "export/recovery",
                    exc,
                    operation_id=operation_id,
                    world_id=world_id,
                    recovery_param="resume_operation_id",
                ) from exc
            raise

    outputs = {
        "file": {"type": "Mesh", "value": str(path)},
        "format": {"type": "Text", "value": output_format},
    }
    return outputs
