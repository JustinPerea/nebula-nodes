from __future__ import annotations

import hashlib
import json
import time
from typing import Any


class ExecutionCache:
    def __init__(self, ttl: int = 3600) -> None:
        self._store: dict[str, tuple[dict[str, Any], float]] = {}
        self._ttl = ttl

    @staticmethod
    def get_key(node_type: str, params: dict[str, Any], inputs: dict[str, Any]) -> str:
        raw = json.dumps(
            {"nodeType": node_type, "params": params, "inputs": inputs},
            sort_keys=True,
            default=str,
        )
        return hashlib.sha256(raw.encode()).hexdigest()

    def get(self, key: str) -> dict[str, Any] | None:
        entry = self._store.get(key)
        if entry is None:
            return None
        outputs, timestamp = entry
        if time.monotonic() - timestamp > self._ttl:
            del self._store[key]
            return None
        return outputs

    def set(self, key: str, outputs: dict[str, Any]) -> None:
        self._store[key] = (outputs, time.monotonic())

    def clear(self) -> None:
        self._store.clear()

    @property
    def size(self) -> int:
        return len(self._store)
