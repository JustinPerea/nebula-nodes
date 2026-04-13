from __future__ import annotations

import time
from typing import Any


class ModelCache:
    """Simple in-memory TTL cache for model lists and schemas."""

    def __init__(self) -> None:
        self._store: dict[str, tuple[Any, float, float]] = {}  # key -> (value, timestamp, ttl)

    def get(self, key: str) -> Any | None:
        entry = self._store.get(key)
        if entry is None:
            return None
        value, timestamp, ttl = entry
        if time.monotonic() - timestamp > ttl:
            del self._store[key]
            return None
        return value

    def set(self, key: str, value: Any, ttl: float = 300.0) -> None:
        self._store[key] = (value, time.monotonic(), ttl)

    def clear(self) -> None:
        self._store.clear()


model_cache = ModelCache()
