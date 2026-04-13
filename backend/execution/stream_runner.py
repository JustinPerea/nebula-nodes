from __future__ import annotations

import json
from dataclasses import dataclass, field
from typing import Any, Awaitable, Callable

import httpx

from models.events import ExecutionEvent, StreamDeltaEvent


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
