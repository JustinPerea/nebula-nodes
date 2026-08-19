"""Resolve the local Nebula project identity used by project-scoped assets.

Nebula currently serves one local project per backend process. Project-scoped
Characters, Moodboards, and Presets therefore share one backend-owned identity
instead of asking every frontend surface to invent an id.
"""
from __future__ import annotations

import hashlib
import os
import re
from pathlib import Path


PROJECT_ROOT = Path(__file__).resolve().parents[2]
_SAFE_PROJECT_ID = re.compile(r"^[A-Za-z0-9_-]{1,64}$")


def _normalise_project_id(value: str) -> str:
    """Return a safe, stable id while retaining a readable project slug."""
    stripped = value.strip()
    if _SAFE_PROJECT_ID.fullmatch(stripped):
        return stripped

    slug = re.sub(r"[^A-Za-z0-9_-]+", "-", stripped).strip("-_") or "nebula-project"
    if len(slug) <= 64:
        return slug

    digest = hashlib.sha256(stripped.encode("utf-8")).hexdigest()[:8]
    return f"{slug[:55].rstrip('-_')}-{digest}"


def get_current_project() -> dict[str, str]:
    """Return non-sensitive identity metadata for the active local project."""
    raw_id = os.environ.get("NEBULA_PROJECT_ID", PROJECT_ROOT.name)
    raw_name = os.environ.get("NEBULA_PROJECT_NAME", PROJECT_ROOT.name)
    return {
        "id": _normalise_project_id(raw_id),
        "name": raw_name.strip() or PROJECT_ROOT.name,
    }
