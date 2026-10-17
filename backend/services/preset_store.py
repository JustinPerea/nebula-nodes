"""File-backed preset ("style") store. Mirrors moodboard_store / character_store.

Presets live in ~/.nebula/presets/_global/<id>.json (global) or
~/.nebula/presets/<projectId>/<id>.json (project). Override the root with
NEBULA_PRESET_ROOT (read on every call so tests can monkeypatch it).

Each file records the params version its ``params`` were saved at
(``paramsVersion``; a file without it predates the marker: version 0). The
version is separate from ``version``, which counts edits. Reads upgrade a copy
of an older preset's params (services/saved_graph_upgrades.py) without writing,
and every write stores the upgraded params with the current version, so a
value saved after an upgrade is never upgraded again.
"""
from __future__ import annotations

import json
import os
import re
import uuid
from datetime import datetime, timezone
from pathlib import Path
from typing import Any

from services.saved_graph_upgrades import PARAMS_VERSION, stored_version, upgrade_params

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
    if scope == "project":
        if not projectId:
            raise ValueError("projectId is required for scope='project'")
        if not _ID_RE.fullmatch(projectId):
            raise ValueError("invalid projectId")
        candidate = _root() / projectId
        if not candidate.resolve().is_relative_to(_root().resolve()):
            raise ValueError("invalid projectId")
        return candidate
    return _root() / _GLOBAL_DIR


def slug_for_preset(name: str) -> str:
    """Stable slug from a preset name.

    Shared single source of truth for the shipped-thumbnail filename
    (``backend/data/presets/thumbnails/<slug>.webp``, written by
    ``scripts/generate_preset_thumbnails.py``) and the seeded
    ``Preset.thumbnail`` URL (``/api/presets/thumbnails/<slug>``). Keeping one
    implementation means the generator and the seeder can never drift.
    """
    slug = re.sub(r"[^a-z0-9]+", "-", name.lower()).strip("-")
    return slug or "preset"


def _upgraded(preset: Any) -> Any:
    """``preset`` as read from disk, with its params upgraded from the version
    it was saved at. Changes only the in-memory dict, never the file. A partial
    preset (no model, no Extended Thinking, or not a claude-chat preset) is
    left as stored: ``upgrade_params`` only matches the full saved shape."""
    if not isinstance(preset, dict):
        return preset
    version = stored_version(preset.get("paramsVersion"))
    upgraded = upgrade_params(preset.get("modelId"), preset.get("params"), version)
    if upgraded is not None:
        preset["params"] = upgraded
    # A file written by a newer backend keeps its own (higher) version.
    preset["paramsVersion"] = max(version, PARAMS_VERSION)
    return preset


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
               modelId: str | None, refImages: list[str], scope: str, projectId: str | None,
               params_version: int, thumbnail: str = "") -> dict[str, Any]:
        """``params_version`` is the version the caller's ``params`` were made
        at (``PARAMS_VERSION`` for current code); older params are upgraded
        before they are stored."""
        params = dict(params or {})
        upgraded = upgrade_params(modelId, params, params_version)
        if upgraded is not None:
            params = upgraded
        preset_id = uuid.uuid4().hex[:12]
        now = _now()
        preset = {
            "id": preset_id,
            "name": name,
            "category": category,
            "prompt": prompt,
            "params": params,
            "modelId": modelId,
            "refImages": list(refImages or []),
            "thumbnail": thumbnail,
            "version": 1,
            # A caller newer than this backend keeps its own version, so a later
            # backend doesn't upgrade params that are already past its upgrade.
            "paramsVersion": max(params_version, PARAMS_VERSION),
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
        return _upgraded(json.loads(path.read_text(encoding="utf-8")))

    def list(self, scope: str, projectId: str | None = None) -> list[dict[str, Any]]:
        directory = _scope_dir(scope, projectId)
        if not directory.exists():
            return []
        items: list[dict[str, Any]] = []
        for p in directory.glob("*.json"):
            try:
                items.append(_upgraded(json.loads(p.read_text(encoding="utf-8"))))
            except (json.JSONDecodeError, OSError):
                continue
        items.sort(key=lambda x: x.get("createdAt", ""))
        return items

    def update(self, preset_id: str, *, params_version: int = PARAMS_VERSION,
               **fields: Any) -> dict[str, Any]:
        """``params_version`` is the version of ``params`` in ``fields`` (current
        unless the caller says otherwise). Without new params, the stored params
        keep the version they were saved at. Either way the merged params are
        upgraded once against the merged ``modelId`` and the file is stamped,
        so a thumbnail-only update also stores an older preset upgraded."""
        path = _find_file(preset_id)
        if not path:
            raise KeyError(preset_id)
        preset = json.loads(path.read_text(encoding="utf-8"))
        stored = stored_version(preset.get("paramsVersion"))
        new_params = fields.get("params") is not None
        for key, value in fields.items():
            if key in self._IMMUTABLE or key == "paramsVersion" or value is None:
                continue
            preset[key] = value
        version = params_version if new_params else stored
        upgraded = upgrade_params(preset.get("modelId"), preset.get("params"), version)
        if upgraded is not None:
            preset["params"] = upgraded
        preset["paramsVersion"] = max(version, PARAMS_VERSION)
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
