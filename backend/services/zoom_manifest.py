"""Zoom manifest writer — captures canvas-mutation events with DOM bounds
and timestamps for the demo-video editing chain.

The frontend POSTs an entry every time a canvas action fires (node added,
wired, run). Each entry records the node's screen-space bounding box at
that moment plus a timestamp relative to manifest start. The editing chain
reads the resulting JSON to apply auto-zoom on the right pixel region at
the right timestamp — no transcript heuristics needed, just structured
agent telemetry.

Single active manifest at a time. `init` creates a collision-proof session
directory under the configured output root and resets the in-memory pointer.
`append_entry` is a no-op
when no manifest is active, so frontend retries on race-conditions are safe.
"""
from __future__ import annotations

import json
import time
from pathlib import Path
from typing import Any

from services.output import create_run_dir

_active_manifest_path: Path | None = None
_started_at: float = 0.0


def init_manifest() -> dict[str, Any]:
    """Start a new manifest file. Returns {session_id, started_at, path}."""
    global _active_manifest_path, _started_at
    from uuid import uuid4

    session_id = uuid4().hex
    session_dir = create_run_dir(f"zoom-{session_id}")
    _active_manifest_path = session_dir / "zoom-manifest.json"
    _started_at = time.time()
    data = {
        "session_id": session_id,
        "started_at": _started_at,
        "entries": [],
    }
    _active_manifest_path.write_text(json.dumps(data, indent=2))
    return {
        "session_id": session_id,
        "started_at": _started_at,
        "path": str(_active_manifest_path),
    }


def append_entry(entry: dict[str, Any]) -> bool:
    """Append an entry to the active manifest. Adds a `ts` field (seconds
    since manifest start). Returns True if appended, False if no active
    manifest or write failed.
    """
    if _active_manifest_path is None or not _active_manifest_path.exists():
        return False
    try:
        data = json.loads(_active_manifest_path.read_text())
    except Exception:
        return False
    enriched = {"ts": time.time() - _started_at, **entry}
    data["entries"].append(enriched)
    try:
        _active_manifest_path.write_text(json.dumps(data, indent=2))
    except Exception:
        return False
    return True
