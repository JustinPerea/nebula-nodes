from __future__ import annotations

import json
from dataclasses import dataclass, field
from pathlib import Path
from typing import Any, Awaitable, Callable, Literal

import httpx

from models.events import ExecutionEvent, StreamDeltaEvent, StreamPartialImageEvent
from services.output import save_base64_image_named


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
) -> str:
    """Consume Replicate's per-prediction SSE token stream (``prediction.urls.stream``).

    Replicate's SSE differs from the OpenAI/Anthropic chat streams this module's
    ``stream_execute`` handles, so it can't reuse that path:
    - ``output`` events carry RAW TEXT in ``data:`` (a token delta) — NOT JSON. Multiple
      ``data:`` lines in one event are joined with ``\\n`` per the SSE spec.
    - ``error`` events carry JSON (e.g. ``{"detail": "..."}``).
    - ``done`` ends the stream (``{}`` on success).

    Docs: https://replicate.com/docs/topics/predictions/streaming
    Returns the full concatenated text. Emits one StreamDeltaEvent per ``output`` event.

    A buffered event is flushed at every boundary — a blank line, the next ``event:`` line,
    OR end-of-stream — so a missing blank-line separator can't drop the final token. If the
    stream closes before a ``done`` event (idle timeout / dropped connection), this fails loud
    rather than returning truncated text as a success.
    """
    accumulated = ""
    saw_done = False
    current_event_type: str | None = None
    data_lines: list[str] = []

    req_headers = {**headers, "Accept": "text/event-stream"}

    async def _dispatch() -> None:
        """Flush the buffered SSE event: output -> emit a delta; error -> raise; done -> mark."""
        nonlocal accumulated, saw_done
        if current_event_type == "output":
            delta = "\n".join(data_lines)
            if delta:
                accumulated += delta
                await emit(StreamDeltaEvent(node_id=node_id, delta=delta, accumulated=accumulated))
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
            if not saw_done:
                raise RuntimeError(
                    "Replicate stream closed without a 'done' event "
                    "(connection dropped or timed out before completion)"
                )

    return accumulated


async def stream_execute_image(
    config: StreamConfig,
    request_body: dict[str, Any],
    node_id: str,
    emit: Callable[[ExecutionEvent], Awaitable[None]],
    run_dir: Path,
    provider: Literal["openai", "fal"],
) -> str:
    """Stream image-generation SSE, save each partial + final to disk, emit events.

    Returns the final image's absolute file path as a string.
    """
    final_path: Path | None = None
    current_event_type: str | None = None

    async with httpx.AsyncClient(timeout=httpx.Timeout(config.timeout, read=None)) as client:
        async with client.stream("POST", config.url, headers=config.headers, json=request_body) as response:
            if response.status_code != 200:
                error_body = ""
                async for chunk in response.aiter_text():
                    error_body += chunk
                raise RuntimeError(f"Image stream request failed ({response.status_code}): {error_body}")

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
                try:
                    data = json.loads(data_str)
                except (ValueError, TypeError):
                    continue

                parsed = _parse_image_event(provider, current_event_type, data)
                if parsed is None:
                    continue
                kind, index, b64 = parsed
                if kind == "partial":
                    path = save_base64_image_named(
                        b64, run_dir, name=f"{node_id}_partial_{index}"
                    )
                    await emit(StreamPartialImageEvent(
                        node_id=node_id, partial_index=index, src=str(path), is_final=False,
                    ))
                elif kind == "final":
                    final_path = save_base64_image_named(b64, run_dir, name=f"{node_id}_final")

    if final_path is None:
        raise RuntimeError("Image stream ended without a final image event")
    return str(final_path)


_OPENAI_PARTIAL_EVENTS = {"image_generation.partial_image", "image_edit.partial_image"}
_OPENAI_COMPLETED_EVENTS = {"image_generation.completed", "image_edit.completed"}


def _parse_image_event(
    provider: str, event_type: str | None, data: dict[str, Any]
) -> tuple[str, int, str] | None:
    """Return (kind, index, b64_json) or None. kind = 'partial' | 'final'.

    OpenAI uses image_generation.* for the generate endpoint and image_edit.*
    for the edit endpoint. Accept both namespaces since they're structurally
    identical (same b64_json + partial_image_index fields).
    """
    if provider == "openai":
        if event_type in _OPENAI_PARTIAL_EVENTS:
            idx = data.get("partial_image_index", 0)
            b64 = data.get("b64_json")
            if isinstance(b64, str):
                return ("partial", int(idx), b64)
        elif event_type in _OPENAI_COMPLETED_EVENTS:
            b64 = data.get("b64_json")
            if isinstance(b64, str):
                return ("final", 0, b64)
    elif provider == "fal":
        ev_type = data.get("type")
        image = data.get("image") or {}
        b64 = image.get("b64_json")
        if not isinstance(b64, str):
            return None
        # Speculative — also accept image_edit.* variants in case FAL mirrors
        # OpenAI's namespace split for its /edit/stream endpoint. Real format
        # will be confirmed during FAL UAT via the debug log below.
        if ev_type in {"image.partial", "image_edit.partial", "image_edit.partial_image"}:
            idx = image.get("partial_index", 0)
            return ("partial", int(idx), b64)
        if ev_type in {"image.completed", "image_edit.completed"}:
            return ("final", 0, b64)
        import logging
        logging.getLogger(__name__).debug(
            "Unrecognized FAL image stream event: type=%r, has_b64=%r",
            data.get("type"),
            isinstance((data.get("image") or {}).get("b64_json"), str),
        )
    return None
