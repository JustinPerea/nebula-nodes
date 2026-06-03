"""File-backed preset ("style") store. Mirrors moodboard_store / character_store.

Presets live in ~/.nebula/presets/_global/<id>.json (global) or
~/.nebula/presets/<projectId>/<id>.json (project). Override the root with
NEBULA_PRESET_ROOT (read on every call so tests can monkeypatch it).
"""
from __future__ import annotations

import json
import os
import re
import uuid
from datetime import datetime, timezone
from pathlib import Path
from typing import Any

_ID_RE = re.compile(r"^[A-Za-z0-9_-]{1,64}$")
_GLOBAL_DIR = "_global"


def _root() -> Path:
    return Path(os.environ.get("NEBULA_PRESET_ROOT", str(Path.home() / ".nebula" / "presets")))


def _now() -> str:
    return datetime.now(timezone.utc).isoformat()


def _write_json(path: Path, data: dict[str, Any]) -> None:
    path.parent.mkdir(parents=True, exist_ok=True)
    tmp = path.with_suffix(".json.tmp")
    tmp.write_text(json.dumps(data, ensure_ascii=False, indent=2), encoding="utf-8")
    tmp.replace(path)


def _scope_dir(scope: str, projectId: str | None) -> Path:
    if scope == "project" and projectId:
        if not _ID_RE.fullmatch(projectId):
            raise ValueError("invalid projectId")
        candidate = _root() / projectId
        if not candidate.resolve().is_relative_to(_root().resolve()):
            raise ValueError("invalid projectId")
        return candidate
    return _root() / _GLOBAL_DIR


def _find_file(preset_id: str) -> Path | None:
    if not _ID_RE.fullmatch(preset_id):
        return None
    root = _root()
    if not root.exists():
        return None
    for sub in root.iterdir():
        if sub.is_dir():
            candidate = sub / f"{preset_id}.json"
            if candidate.exists():
                return candidate
    return None


class PresetStore:
    _IMMUTABLE = {"id", "createdAt", "projectId"}

    def create(self, *, name: str, category: str, prompt: str, params: dict[str, Any],
               modelId: str | None, refImages: list[str], scope: str, projectId: str | None) -> dict[str, Any]:
        preset_id = uuid.uuid4().hex[:12]
        now = _now()
        preset = {
            "id": preset_id,
            "name": name,
            "category": category,
            "prompt": prompt,
            "params": dict(params or {}),
            "modelId": modelId,
            "refImages": list(refImages or []),
            "thumbnail": "",
            "version": 1,
            "scope": "project" if (scope == "project" and projectId) else "global",
            "projectId": projectId if scope == "project" else None,
            "createdAt": now,
            "updatedAt": now,
        }
        _write_json(_scope_dir(scope, projectId) / f"{preset_id}.json", preset)
        return preset

    def get(self, preset_id: str) -> dict[str, Any] | None:
        path = _find_file(preset_id)
        if not path:
            return None
        return json.loads(path.read_text(encoding="utf-8"))

    def list(self, scope: str, projectId: str | None = None) -> list[dict[str, Any]]:
        directory = _scope_dir(scope, projectId)
        if not directory.exists():
            return []
        items: list[dict[str, Any]] = []
        for p in directory.glob("*.json"):
            try:
                items.append(json.loads(p.read_text(encoding="utf-8")))
            except (json.JSONDecodeError, OSError):
                continue
        items.sort(key=lambda x: x.get("createdAt", ""))
        return items

    def update(self, preset_id: str, **fields: Any) -> dict[str, Any]:
        path = _find_file(preset_id)
        if not path:
            raise KeyError(preset_id)
        preset = json.loads(path.read_text(encoding="utf-8"))
        for key, value in fields.items():
            if key in self._IMMUTABLE or value is None:
                continue
            preset[key] = value
        preset["version"] = int(preset.get("version", 1)) + 1
        preset["updatedAt"] = _now()
        _write_json(path, preset)
        return preset

    def delete(self, preset_id: str) -> None:
        path = _find_file(preset_id)
        if not path:
            raise KeyError(preset_id)
        path.unlink()


preset_store = PresetStore()
