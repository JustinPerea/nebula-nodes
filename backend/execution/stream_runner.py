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


def _parse_image_event(
    provider: str, event_type: str | None, data: dict[str, Any]
) -> tuple[str, int, str] | None:
    """Return (kind, index, b64_json) or None. kind = 'partial' | 'final'."""
    if provider == "openai":
        if event_type == "image_generation.partial_image":
            idx = data.get("partial_image_index", 0)
            b64 = data.get("b64_json")
            if isinstance(b64, str):
                return ("partial", int(idx), b64)
        elif event_type == "image_generation.completed":
            b64 = data.get("b64_json")
            if isinstance(b64, str):
                return ("final", 0, b64)
    elif provider == "fal":
        # FAL dialect wired up in Task 13.
        pass
    return None
