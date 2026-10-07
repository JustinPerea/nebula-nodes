"""Where the commons keeps its database and blobs.

Defaults to ~/.nebula/commons (inside NEBULA_STATE_DIR). Tests point
NEBULA_COMMONS_ROOT at a temp dir (see tests/conftest.py). Because the store
sits inside the state dir, the state dir must never be granted to an agent;
`services.agent_profiles.agent_read_grants` enforces that.
"""
from __future__ import annotations

import os
from pathlib import Path


def commons_root() -> Path:
    raw = os.environ.get("NEBULA_COMMONS_ROOT", "")
    if raw:
        return Path(raw)
    state = os.environ.get("NEBULA_STATE_DIR", "")
    return (Path(state) if state else Path.home() / ".nebula") / "commons"


def blobs_dir() -> Path:
    return commons_root() / "blobs"


def db_path() -> Path:
    return commons_root() / "commons.db"
