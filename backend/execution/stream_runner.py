from __future__ import annotations

import asyncio
import json
import logging
from collections import deque
from dataclasses import dataclass, field
from pathlib import Path
from typing import Any, Awaitable, Callable, Literal

import httpx

from models.events import ExecutionEvent, StreamDeltaEvent, StreamPartialImageEvent
from services.output import save_base64_image_named

logger = logging.getLogger(__name__)


ReplicateStreamOutputMode = Literal["pending", "text", "buffer"]
ReplicateStreamOutputClassifier = Callable[[str], ReplicateStreamOutputMode]


@dataclass
class StreamConfig:
    url: str
    headers: dict[str, str]
    event_type_filter: str | None = None
    delta_path: str = "delta.text"
    timeout: float = 30.0
    extra_stop_events: set[str] = field(default_factory=lambda: {"message_stop"})


def _get_nested(data: dict[str, Any], path: str) -> Any:
    current: Any = data
    for key in path.split("."):
        if isinstance(current, dict):
            current = current.get(key)
            if current is None:
                return None
        elif isinstance(current, list):
            try:
                current = current[int(key)]
            except (ValueError, IndexError):
                return None
        else:
            return None
    return current


async def stream_execute(
    config: StreamConfig,
    request_body: dict[str, Any],
    node_id: str,
    emit: Callable[[ExecutionEvent], Awaitable[None]],
) -> str:
    accumulated = ""
    current_event_type: str | None = None

    async with httpx.AsyncClient(timeout=httpx.Timeout(config.timeout, read=None)) as client:
        async with client.stream("POST", config.url, headers=config.headers, json=request_body) as response:
            if response.status_code != 200:
                error_body = ""
                async for chunk in response.aiter_text():
                    error_body += chunk
                raise RuntimeError(f"Stream request failed ({response.status_code}): {error_body}")

            async for line in response.aiter_lines():
                line = line.strip()

                if not line:
                    current_event_type = None
                    continue

                if line.startswith("event:"):
                    current_event_type = line[len("event:"):].strip()
                    if current_event_type in config.extra_stop_events:
                        continue
                    continue

                if line.startswith("data:"):
                    data_str = line[len("data:"):].strip()
                    if data_str == "[DONE]":
                        break

                    if config.event_type_filter and current_event_type != config.event_type_filter:
                        continue

                    try:
                        data = json.loads(data_str)
                    except (ValueError, TypeError):
                        continue

                    delta_text = _get_nested(data, config.delta_path)
                    if delta_text and isinstance(delta_text, str):
                        accumulated += delta_text
                        await emit(StreamDeltaEvent(node_id=node_id, delta=delta_text, accumulated=accumulated))

    return accumulated


async def stream_execute_replicate(
    stream_url: str,
    headers: dict[str, str],
    node_id: str,
    emit: Callable[[ExecutionEvent], Awaitable[None]],
    timeout: float = 600.0,
    *,
    classify_output_prefix: ReplicateStreamOutputClassifier | None = None,
) -> str:
    """Consume Replicate's per-prediction SSE token stream (``prediction.urls.stream``).

    Replicate's SSE differs from the OpenAI/Anthropic chat streams this module's
    ``stream_execute`` handles, so it can't reuse that path:
    - ``output`` events carry RAW TEXT in ``data:`` (a token delta) — NOT JSON. Multiple
      ``data:`` lines in one event are joined with ``\\n`` per the SSE spec.
    - ``error`` events carry JSON (e.g. ``{"detail": "..."}``).
    - ``done`` ends the stream (``{}`` on success).

    Docs: https://replicate.com/docs/topics/predictions/streaming
    Returns the full concatenated output. By default, emits one StreamDeltaEvent per
    ``output`` event. Callers that can receive a non-text stream may provide a tri-state
    ``classify_output_prefix`` hook:

    - ``pending`` keeps the initial events private until their type is known.
    - ``text`` flushes those events with their original delta boundaries and streams the rest.
    - ``buffer`` suppresses every StreamDeltaEvent while retaining the full returned output.

    This lets a caller recognize an inline media artifact before its base64 payload reaches
    text telemetry, without teaching generic UI code about provider-specific output shapes.

    A buffered event is flushed at every boundary — a blank line, the next ``event:`` line,
    OR end-of-stream — so a missing blank-line separator can't drop the final token. If the
    stream closes before a ``done`` event (idle timeout / dropped connection), this fails loud
    rather than returning truncated text as a success.
    """
    output_chunks: list[str] = []
    text_accumulated = ""
    emitted_chunk_count = 0
    output_mode: ReplicateStreamOutputMode = (
        "pending" if classify_output_prefix is not None else "text"
    )
    classification_prefix = ""
    saw_done = False
    current_event_type: str | None = None
    data_lines: list[str] = []

    req_headers = {**headers, "Accept": "text/event-stream"}

    async def _emit_unreported_text_chunks() -> None:
        """Emit buffered text events in their original event-sized chunks."""
        nonlocal emitted_chunk_count, text_accumulated
        while emitted_chunk_count < len(output_chunks):
            delta = output_chunks[emitted_chunk_count]
            emitted_chunk_count += 1
            text_accumulated += delta
            await emit(
                StreamDeltaEvent(
                    node_id=node_id,
                    delta=delta,
                    accumulated=text_accumulated,
                )
            )

    async def _dispatch() -> None:
        """Flush the buffered SSE event: output -> emit a delta; error -> raise; done -> mark."""
        nonlocal classification_prefix, output_mode, saw_done
        if current_event_type == "output":
            delta = "\n".join(data_lines)
            if delta:
                output_chunks.append(delta)
                if output_mode == "text":
                    await _emit_unreported_text_chunks()
                elif output_mode == "pending":
                    # Only the undecided prefix is copied. A media classifier should decide
                    # as soon as the data-URI header reaches its comma; subsequent base64
                    # chunks then remain solely in ``output_chunks`` for the final result.
                    classification_prefix += delta
                    assert classify_output_prefix is not None
                    output_mode = classify_output_prefix(classification_prefix)
                    if output_mode == "text":
                        await _emit_unreported_text_chunks()
        elif current_event_type == "error":
            # An `error` event terminates the stream as a failure, with or without a detail.
            raw = "\n".join(data_lines)
            detail = raw
            try:
                parsed = json.loads(raw) if raw else {}
                if isinstance(parsed, dict):
                    detail = parsed.get("detail", raw)
            except (ValueError, TypeError):
                pass
            raise RuntimeError(f"Replicate stream error: {detail or '(no detail)'}")
        elif current_event_type == "done":
            saw_done = True

    async with httpx.AsyncClient(timeout=httpx.Timeout(timeout, read=None)) as client:
        async with client.stream("GET", stream_url, headers=req_headers) as response:
            if response.status_code != 200:
                error_body = ""
                async for chunk in response.aiter_text():
                    error_body += chunk
                raise RuntimeError(f"Replicate stream failed ({response.status_code}): {error_body}")

            async for line in response.aiter_lines():
                # A blank line OR a new `event:` line ends the previous event — flush first.
                if not line:
                    await _dispatch()
                    if saw_done:
                        break
                    current_event_type, data_lines = None, []
                    continue

                if line.startswith("event:"):
                    await _dispatch()
                    if saw_done:
                        break
                    current_event_type, data_lines = line[len("event:"):].strip(), []
                    continue

                if line.startswith("data:"):
                    # SSE: a single leading space after the colon is part of the syntax, not data.
                    value = line[len("data:"):]
                    if value.startswith(" "):
                        value = value[1:]
                    data_lines.append(value)
                    continue

                # ``id:`` (reconnection cursor) and ``:`` comments (e.g. the 30s ``:408``
                # idle keepalive) carry no payload — ignore.

            # Stream ended: flush an event left un-terminated by a trailing blank line, then
            # fail loud on a premature close so truncated text isn't reported as success.
            if not saw_done:
                await _dispatch()
            # A still-pending prefix never became a recognized buffered artifact. Preserve
            # ordinary text behavior by releasing its original deltas before returning or
            # reporting a premature-close failure.
            if output_mode == "pending":
                output_mode = "text"
                await _emit_unreported_text_chunks()
            if not saw_done:
                raise RuntimeError(
                    "Replicate stream closed without a 'done' event "
                    "(connection dropped or timed out before completion)"
                )

    return "".join(output_chunks)


async def stream_execute_image(
    config: StreamConfig,
    request_body: dict[str, Any],
    node_id: str,
    emit: Callable[[ExecutionEvent], Awaitable[None]],
    run_dir: Path,
    provider: Literal["openai", "fal"],
    *,
    recovery_max_polls: int = 60,
    recovery_poll_interval: float = 2.0,
) -> str:
    """Stream image-generation SSE, save each partial + final to disk, emit events.

    Returns the final image's absolute file path as a string (or the hosted URL
    when the final image arrived as a URL that could not be downloaded).

    FAL recovery path (``provider="fal"``): the request ID is captured from the
    ``x-fal-request-id`` response header or any SSE event payload, and the last
    ``_RAW_EVENT_BUFFER`` raw events are kept in a bounded ring buffer. If the
    stream ends without a recognized final image event, the persisted request ID
    is used to poll ``{base}/requests/{request_id}/status`` and fetch the result
    before declaring failure. The raised error always carries the request ID
    (when known) and a summary of the buffered raw events.
    """
    final_path: Path | None = None
    final_ref: str | None = None  # URL/data-URI final, persisted after the stream closes
    request_id: str | None = None
    raw_events: deque[str] = deque(maxlen=_RAW_EVENT_BUFFER)
    current_event_type: str | None = None

    async with httpx.AsyncClient(timeout=httpx.Timeout(config.timeout, read=None)) as client:
        async with client.stream("POST", config.url, headers=config.headers, json=request_body) as response:
            if response.status_code != 200:
                error_body = ""
                async for chunk in response.aiter_text():
                    error_body += chunk
                raise RuntimeError(f"Image stream request failed ({response.status_code}): {error_body}")

            if provider == "fal":
                header_request_id = response.headers.get("x-fal-request-id")
                if header_request_id:
                    request_id = header_request_id

            async for line in response.aiter_lines():
                line = line.strip()
                if not line:
                    current_event_type = None
                    continue
                if line.startswith("event:"):
                    current_event_type = line[len("event:"):].strip()
                    continue
                if not line.startswith("data:"):
                    continue
                data_str = line[len("data:"):].strip()
                if data_str == "[DONE]":
                    break

                raw_events.append(_summarize_raw_event(current_event_type, data_str))
                try:
                    data = json.loads(data_str)
                except (ValueError, TypeError):
                    continue

                if provider == "fal" and request_id is None:
                    rid = data.get("request_id") or data.get("gateway_request_id")
                    if isinstance(rid, str) and rid:
                        request_id = rid
                        logger.debug("FAL image stream: captured request_id %s", request_id)

                parsed = _parse_image_event(provider, current_event_type, data)
                if parsed is None:
                    continue
                if parsed.kind == "partial" and parsed.b64:
                    path = save_base64_image_named(
                        parsed.b64, run_dir, name=f"{node_id}_partial_{parsed.index}"
                    )
                    await emit(StreamPartialImageEvent(
                        node_id=node_id, partial_index=parsed.index, src=str(path), is_final=False,
                    ))
                elif parsed.kind == "final":
                    if parsed.b64:
                        final_path = save_base64_image_named(parsed.b64, run_dir, name=f"{node_id}_final")
                    elif parsed.url:
                        final_ref = parsed.url

        if final_path is not None:
            return str(final_path)
        if final_ref is not None:
            return await _persist_final_image(client, final_ref, run_dir, node_id)

        recovery_note = ""
        if provider == "fal" and request_id:
            recovered, note = await _recover_fal_image(
                client,
                config,
                request_id,
                run_dir,
                node_id,
                max_polls=recovery_max_polls,
                poll_interval=recovery_poll_interval,
            )
            if recovered is not None:
                logger.info(
                    "FAL image stream ended without a final event; recovered the "
                    "result via request %s",
                    request_id,
                )
                return recovered
            recovery_note = f" Retrieval by request ID failed: {note}."

        summary = "; ".join(raw_events) if raw_events else "(no events received)"
        raise RuntimeError(
            f"Image stream ended without a final image event "
            f"(provider={provider}, fal_request_id={request_id or 'unavailable'})."
            f"{recovery_note} Last {len(raw_events)} raw events: {summary}"
        )


_OPENAI_PARTIAL_EVENTS = {"image_generation.partial_image", "image_edit.partial_image"}
_OPENAI_COMPLETED_EVENTS = {"image_generation.completed", "image_edit.completed"}

# FAL's gpt-image-2 passthrough may emit the nested ``image.*`` schema (contract
# fixtures), OpenAI's flat event types verbatim in the data payload, or plain
# result objects (``images`` array / ``image`` / ``output`` / ``result`` / ``url``).
_FAL_PARTIAL_TYPES = {
    "image.partial",
    "image_edit.partial",
    "image_edit.partial_image",
    "image_generation.partial_image",
}
_FAL_FINAL_TYPES = {
    "image.completed",
    "image_edit.completed",
    "image_generation.completed",
}

_RAW_EVENT_BUFFER = 20
_RAW_EVENT_SNIPPET = 160
_IMAGE_EXTENSIONS = {"png", "jpg", "jpeg", "webp"}


@dataclass
class _ParsedImageEvent:
    kind: Literal["partial", "final"]
    index: int
    b64: str | None = None
    url: str | None = None


def _summarize_raw_event(event_type: str | None, data_str: str) -> str:
    """One-line, length-capped summary of a raw SSE data payload for the bounded
    ring buffer that feeds debug logs and failure error messages."""
    snippet = data_str if len(data_str) <= _RAW_EVENT_SNIPPET else data_str[:_RAW_EVENT_SNIPPET] + "…"
    return f"event={event_type} {snippet}" if event_type else snippet


def _extract_fal_image(data: Any, _depth: int = 0) -> tuple[str | None, str | None] | None:
    """Pull an image payload out of a FAL result-ish dict.

    Returns ``(b64, url)`` — exactly one set — or None. Recognizes the schemas
    FAL image endpoints actually return: ``images`` arrays, ``image``
    objects/strings, ``output`` / ``result`` wrappers, and bare ``url`` fields.
    """
    if _depth > 3 or not isinstance(data, dict):
        return None

    images = data.get("images")
    if isinstance(images, list) and images:
        first = images[0]
        if isinstance(first, dict):
            b64 = first.get("b64_json")
            if isinstance(b64, str) and b64:
                return (b64, None)
            url = first.get("url")
            if isinstance(url, str) and url:
                return (None, url)
        elif isinstance(first, str) and first:
            return (None, first)

    image = data.get("image")
    if isinstance(image, dict):
        b64 = image.get("b64_json")
        if isinstance(b64, str) and b64:
            return (b64, None)
        url = image.get("url")
        if isinstance(url, str) and url:
            return (None, url)
    elif isinstance(image, str) and image:
        return (None, image)

    for key in ("output", "result"):
        nested = data.get(key)
        if isinstance(nested, dict):
            found = _extract_fal_image(nested, _depth + 1)
            if found:
                return found
        elif isinstance(nested, list) and nested:
            item = nested[0]
            if isinstance(item, dict):
                found = _extract_fal_image(item, _depth + 1)
                if found:
                    return found
            elif isinstance(item, str) and item:
                return (None, item)
        elif isinstance(nested, str) and nested:
            return (None, nested)

    url = data.get("url")
    if isinstance(url, str) and url:
        return (None, url)
    return None


def _parse_image_event(
    provider: str, event_type: str | None, data: dict[str, Any]
) -> _ParsedImageEvent | None:
    """Return a parsed partial/final image event, or None when the event carries
    no image payload (queue status updates, logs, keepalives, …).

    OpenAI uses image_generation.* for the generate endpoint and image_edit.*
    for the edit endpoint. Accept both namespaces since they're structurally
    identical (same b64_json + partial_image_index fields).
    """
    if provider == "openai":
        if event_type in _OPENAI_PARTIAL_EVENTS:
            idx = data.get("partial_image_index", 0)
            b64 = data.get("b64_json")
            if isinstance(b64, str):
                return _ParsedImageEvent("partial", int(idx), b64=b64)
        elif event_type in _OPENAI_COMPLETED_EVENTS:
            b64 = data.get("b64_json")
            if isinstance(b64, str):
                return _ParsedImageEvent("final", 0, b64=b64)
    elif provider == "fal":
        return _parse_fal_image_event(data)
    return None


def _parse_fal_image_event(data: dict[str, Any]) -> _ParsedImageEvent | None:
    ev_type = data.get("type")
    image_dict = data.get("image") if isinstance(data.get("image"), dict) else {}

    if ev_type in _FAL_PARTIAL_TYPES:
        # Nested (image.b64_json) or flat OpenAI-passthrough (top-level b64_json).
        b64 = image_dict.get("b64_json") or data.get("b64_json")
        if not isinstance(b64, str):
            return None
        idx = image_dict.get("partial_index", data.get("partial_image_index", 0))
        return _ParsedImageEvent("partial", int(idx), b64=b64)

    if ev_type in _FAL_FINAL_TYPES:
        b64 = image_dict.get("b64_json") or data.get("b64_json")
        if isinstance(b64, str):
            return _ParsedImageEvent("final", 0, b64=b64)
        url = image_dict.get("url") or data.get("url")
        if isinstance(url, str) and url:
            return _ParsedImageEvent("final", 0, url=url)
        # Declared final but no payload in the usual spots — fall through to the
        # generic extraction below before giving up on the event.

    # Untyped partial frame — partial_index marker without a recognized type.
    elif "partial_index" in image_dict or "partial_image_index" in data:
        b64 = image_dict.get("b64_json") or data.get("b64_json")
        if not isinstance(b64, str):
            return None
        idx = image_dict.get("partial_index", data.get("partial_image_index", 0))
        return _ParsedImageEvent("partial", int(idx), b64=b64)

    # Generic final-result schemas. Queue status events (IN_QUEUE/IN_PROGRESS/…)
    # carry none of these fields and fall through to the debug log.
    extracted = _extract_fal_image(data)
    if extracted is not None:
        b64, url = extracted
        return _ParsedImageEvent("final", 0, b64=b64, url=url)

    logger.debug(
        "Unrecognized FAL image stream event: type=%r keys=%s",
        data.get("type"),
        list(data.keys())[:8],
    )
    return None


async def _persist_final_image(
    client: httpx.AsyncClient, ref: str, run_dir: Path, node_id: str
) -> str:
    """Persist a URL/data-URI final image into the run dir; return its path.

    Falls back to returning the URL itself when the download fails — a hosted
    FAL URL is still a valid Image port value (the async-poll path returns URLs
    directly), so a CDN hiccup must not lose the artifact reference.
    """
    if ref.startswith("data:") and ";base64," in ref:
        header, b64 = ref.split(",", 1)
        mime = header[len("data:"):].split(";")[0]
        ext = mime.rsplit("/", 1)[-1] if "/" in mime else "png"
        if ext not in _IMAGE_EXTENSIONS:
            ext = "png"
        return str(save_base64_image_named(b64, run_dir, name=f"{node_id}_final", extension=ext))

    try:
        resp = await client.get(ref)
        resp.raise_for_status()
    except Exception:
        logger.warning("Could not download final image %s — returning URL as-is", ref)
        return ref

    suffix = Path(httpx.URL(ref).path).suffix.lstrip(".").lower()
    if suffix not in _IMAGE_EXTENSIONS:
        content_type = resp.headers.get("content-type", "")
        suffix = content_type.rsplit("/", 1)[-1].split(";")[0].strip().lower()
    if suffix not in _IMAGE_EXTENSIONS:
        suffix = "png"
    path = run_dir / f"{node_id}_final.{suffix}"
    path.write_bytes(resp.content)
    return str(path)


async def _recover_fal_image(
    client: httpx.AsyncClient,
    config: StreamConfig,
    request_id: str,
    run_dir: Path,
    node_id: str,
    *,
    max_polls: int,
    poll_interval: float,
) -> tuple[str | None, str]:
    """Retrieve a completed FAL result by request ID after the SSE stream ended
    without a recognized final event (dropped connection, schema drift, …).

    Polls ``GET {base}/requests/{request_id}/status`` (base = stream URL minus
    the ``/stream`` suffix) until COMPLETED/FAILED, then reads the image from
    the status payload itself or the canonical result URL. Returns
    ``(image_ref, note)`` — ``image_ref`` is None when recovery failed, with
    ``note`` describing the outcome for the caller's error message.
    """
    base = config.url.rstrip("/")
    if base.endswith("/stream"):
        base = base[: -len("/stream")]
    status_url = f"{base}/requests/{request_id}/status"
    last_status = "unknown"

    for attempt in range(1, max_polls + 1):
        try:
            status_resp = await client.get(status_url, headers=config.headers)
        except httpx.HTTPError as exc:
            return None, f"status request error: {exc}"
        if status_resp.status_code == 404:
            return None, f"no request found with ID {request_id} (404)"
        if status_resp.status_code not in (200, 202):
            return None, f"status endpoint returned {status_resp.status_code}"
        try:
            payload = status_resp.json()
        except ValueError:
            return None, "status endpoint returned a non-JSON body"

        status = payload.get("status")
        if isinstance(status, str) and status:
            last_status = status
        if status in ("FAILED", "CANCELLED"):
            return None, f"job {status}: {payload.get('error', 'no error detail')}"

        if status is None or status == "COMPLETED":
            extracted = _extract_fal_image(payload)
            if extracted is None:
                result_url = payload.get("response_url") or f"{base}/requests/{request_id}"
                try:
                    result_resp = await client.get(str(result_url), headers=config.headers)
                except httpx.HTTPError as exc:
                    return None, f"result request error: {exc}"
                if result_resp.status_code != 200:
                    return None, f"result endpoint returned {result_resp.status_code}"
                try:
                    result_payload = result_resp.json()
                except ValueError:
                    return None, "result endpoint returned a non-JSON body"
                extracted = _extract_fal_image(result_payload)
            if extracted is None:
                return None, "job completed but no image found in the result payload"
            b64, url = extracted
            if b64:
                path = save_base64_image_named(b64, run_dir, name=f"{node_id}_final")
                return str(path), "recovered from status/result payload"
            assert url is not None
            ref = await _persist_final_image(client, url, run_dir, node_id)
            return ref, "recovered from status/result payload"

        # IN_QUEUE / IN_PROGRESS — the stream dropped but the job is still running.
        if attempt < max_polls:
            await asyncio.sleep(poll_interval)

    return None, f"job still {last_status} after {max_polls} status polls"
