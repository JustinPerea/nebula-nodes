from __future__ import annotations

import hashlib
import json
import time
from pathlib import Path
from typing import Any

from services.output import OUTPUT_ROOT, resolve_output_ref


def _cached_artifacts_exist(value: Any) -> bool:
    """Return False when a cached value references a missing Nebula artifact.

    Remote/data/blob values and ordinary text are not local artifacts. Served
    output URLs are always checked. Absolute paths are checked only when they
    are contained by OUTPUT_ROOT, avoiding false invalidation of text that
    happens to look path-like or caller-owned input files outside the output
    tree.
    """
    if isinstance(value, dict):
        return all(_cached_artifacts_exist(item) for item in value.values())
    if isinstance(value, (list, tuple)):
        return all(_cached_artifacts_exist(item) for item in value)
    if not isinstance(value, str) or not value:
        return True
    if value.startswith(("http://", "https://", "data:", "blob:")):
        return True
    if value.startswith("/api/outputs/"):
        resolved = resolve_output_ref(value)
        return resolved != value and Path(resolved).is_file()
    path = Path(value)
    if not path.is_absolute():
        return True
    try:
        path.resolve().relative_to(OUTPUT_ROOT.resolve())
    except (OSError, ValueError):
        return True
    return path.is_file()


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
        if not _cached_artifacts_exist(outputs):
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
