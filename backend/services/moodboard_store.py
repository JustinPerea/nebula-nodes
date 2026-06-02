"""MoodboardStore - project-scoped & global native Nebula moodboards.

On-disk layout mirrors CharacterStore:
    MOODBOARD_ROOT/<projectId>/<id>.json
    MOODBOARD_ROOT/_global/<id>.json

Moodboards are provider-neutral creative-direction assets. They can later be
adapted to Krea, GPT Image, Gemini, Seedream, etc. without changing the saved
resource shape.
"""
from __future__ import annotations

import json
import os
import re
from datetime import datetime, timezone
from pathlib import Path
from typing import Any
from uuid import uuid4

_PROJECT_ID_RE = re.compile(r"^[A-Za-z0-9_-]{1,64}$")
_MOODBOARD_ID_RE = re.compile(r"^[A-Za-z0-9_-]{1,64}$")
_VALID_MODES = {"look", "world", "subject"}


def _validate_project_id(project_id: str) -> str:
    if not _PROJECT_ID_RE.fullmatch(project_id):
        raise ValueError(f"invalid projectId: {project_id!r}")
    return project_id


def _validate_moodboard_id(moodboard_id: str) -> str:
    if not _MOODBOARD_ID_RE.fullmatch(moodboard_id):
        raise ValueError(f"invalid moodboard id: {moodboard_id!r}")
    return moodboard_id


def _moodboard_root() -> Path:
    raw = os.environ.get("NEBULA_MOODBOARD_ROOT", "")
    if raw:
        return Path(raw)
    return Path.home() / ".nebula" / "moodboards"


def _scope_dir(root: Path, project_id: str | None) -> Path:
    if project_id:
        _validate_project_id(project_id)
        scope = root / project_id
        if not scope.resolve().is_relative_to(root.resolve()):
            raise ValueError(f"invalid projectId: {project_id!r}")
        return scope
    return root / "_global"


def _find_moodboard_file(root: Path, moodboard_id: str) -> Path | None:
    _validate_moodboard_id(moodboard_id)
    if not root.exists():
        return None
    for sub in root.iterdir():
        if not sub.is_dir():
            continue
        candidate = sub / f"{moodboard_id}.json"
        if candidate.exists():
            return candidate
    return None


def _now_iso() -> str:
    return datetime.now(timezone.utc).isoformat()


def _write_json(path: Path, data: dict[str, Any]) -> None:
    tmp = path.with_suffix(".json.tmp")
    tmp.write_text(json.dumps(data, ensure_ascii=False, indent=2), encoding="utf-8")
    tmp.replace(path)


def _normalize_images(images: list[dict[str, Any]] | None) -> list[dict[str, Any]]:
    normalized: list[dict[str, Any]] = []
    for raw in images or []:
        if not isinstance(raw, dict):
            continue
        url = str(raw.get("url") or "").strip()
        if not url:
            continue
        image_id = str(raw.get("id") or uuid4().hex[:12])
        weight_raw = raw.get("weight", 1.0)
        try:
            weight = max(0.0, min(1.0, float(weight_raw)))
        except (TypeError, ValueError):
            weight = 1.0
        normalized.append({
            "id": image_id,
            "url": url,
            "weight": weight,
            "notes": str(raw.get("notes") or ""),
            "excluded": bool(raw.get("excluded", False)),
        })
    return normalized


def _normalize_analysis(analysis: dict[str, Any] | None) -> dict[str, Any] | None:
    if analysis is None:
        return None
    if not isinstance(analysis, dict):
        raise ValueError("analysis must be an object")
    return dict(analysis)


class MoodboardStore:
    """CRUD store for native Nebula moodboards backed by JSON files."""

    def create(
        self,
        name: str,
        images: list[dict[str, Any]] | None = None,
        notes: str = "",
        mode: str = "look",
        strength: float = 0.7,
        analysis: dict[str, Any] | None = None,
        projectId: str | None = None,
    ) -> dict[str, Any]:
        name = str(name or "").strip()
        if not name:
            raise ValueError("name is required")
        if mode not in _VALID_MODES:
            raise ValueError(f"invalid moodboard mode: {mode!r}")
        try:
            strength_value = max(0.0, min(1.0, float(strength)))
        except (TypeError, ValueError):
            strength_value = 0.7

        moodboard_id = uuid4().hex[:12]
        now = _now_iso()
        normalized_images = _normalize_images(images)
        moodboard: dict[str, Any] = {
            "id": moodboard_id,
            "name": name,
            "version": 1,
            "images": normalized_images,
            "notes": str(notes or ""),
            "mode": mode,
            "strength": strength_value,
            "analysis": _normalize_analysis(analysis),
            "thumbnail": normalized_images[0]["url"] if normalized_images else "",
            "projectId": projectId,
            "createdAt": now,
            "updatedAt": now,
        }

        root = _moodboard_root()
        scope_dir = _scope_dir(root, projectId)
        scope_dir.mkdir(parents=True, exist_ok=True)
        _write_json(scope_dir / f"{moodboard_id}.json", moodboard)
        return moodboard

    def get(self, moodboard_id: str) -> dict[str, Any] | None:
        path = _find_moodboard_file(_moodboard_root(), moodboard_id)
        if path is None:
            return None
        return json.loads(path.read_text(encoding="utf-8"))

    def list(self, scope: str, projectId: str | None = None) -> list[dict[str, Any]]:
        root = _moodboard_root()
        if scope == "project":
            if not projectId:
                raise ValueError("projectId is required for scope='project'")
            _validate_project_id(projectId)
            target_dir = root / projectId
        else:
            target_dir = root / "_global"

        if not target_dir.exists():
            return []

        results: list[dict[str, Any]] = []
        for path in sorted(target_dir.glob("*.json")):
            try:
                results.append(json.loads(path.read_text(encoding="utf-8")))
            except (json.JSONDecodeError, OSError):
                continue
        return results

    def update(self, moodboard_id: str, **fields: Any) -> dict[str, Any]:
        path = _find_moodboard_file(_moodboard_root(), moodboard_id)
        if path is None:
            raise KeyError(f"Moodboard '{moodboard_id}' not found")
        moodboard = json.loads(path.read_text(encoding="utf-8"))

        immutable = {"id", "createdAt", "projectId"}
        for key, value in fields.items():
            if key in immutable:
                continue
            if key == "images":
                moodboard[key] = _normalize_images(value)
                moodboard["thumbnail"] = moodboard[key][0]["url"] if moodboard[key] else ""
            elif key == "mode":
                if value not in _VALID_MODES:
                    raise ValueError(f"invalid moodboard mode: {value!r}")
                moodboard[key] = value
            elif key == "strength":
                moodboard[key] = max(0.0, min(1.0, float(value)))
            elif key == "analysis":
                moodboard[key] = _normalize_analysis(value)
            elif value is not None:
                moodboard[key] = value

        moodboard["version"] = int(moodboard.get("version", 1)) + 1
        moodboard["updatedAt"] = _now_iso()
        _write_json(path, moodboard)
        return moodboard

    def delete(self, moodboard_id: str) -> None:
        path = _find_moodboard_file(_moodboard_root(), moodboard_id)
        if path is None:
            raise KeyError(f"Moodboard '{moodboard_id}' not found")
        path.unlink()
