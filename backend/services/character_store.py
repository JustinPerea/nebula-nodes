"""CharacterStore — project-scoped & global character persistence over JSON files.

On-disk layout:
    CHAR_ROOT/<projectId>/<id>.json   — project-scoped characters
    CHAR_ROOT/_global/<id>.json       — global characters (no projectId)

CHAR_ROOT defaults to ~/.nebula/characters; override via NEBULA_CHARACTER_ROOT
(the test suite sets this env var so tests never touch the real home directory).

The root is resolved DYNAMICALLY on each call (via _char_root()) so per-test
monkeypatch.setenv() works cleanly regardless of import order.

Identity-correctness contract:
  - referenceViews order is stored and returned verbatim (never sorted/reordered)
  - frozenTraitString is stored and returned byte-identical (never normalized)
  - version is bumped deterministically on every update call

No external dependencies — stdlib only (json, uuid, pathlib, datetime).
"""
from __future__ import annotations

import json
import os
import re
from datetime import datetime, timezone
from pathlib import Path
from uuid import uuid4

# ---------------------------------------------------------------------------
# projectId / charId validation (path-traversal defence)
# ---------------------------------------------------------------------------

_PROJECT_ID_RE = re.compile(r"^[A-Za-z0-9_-]{1,64}$")
_CHAR_ID_RE = re.compile(r"^[A-Za-z0-9_-]{1,64}$")


def _validate_project_id(project_id: str) -> str:
    """Validate a client-supplied projectId and return it unchanged.

    Raises ValueError for any value that contains path-traversal sequences,
    directory separators, or characters outside the safe alphanumeric/dash/
    underscore set so that no caller can escape CHAR_ROOT on the filesystem.
    """
    if not _PROJECT_ID_RE.fullmatch(project_id):
        raise ValueError(f"invalid projectId: {project_id!r}")
    return project_id


def _validate_char_id(char_id: str) -> str:
    """Validate a client-supplied char_id and return it unchanged.

    Raises ValueError for any value that contains path-traversal sequences,
    directory separators, or characters outside the safe alphanumeric/dash/
    underscore set so that no caller can escape CHAR_ROOT on the filesystem.
    Store-generated ids are always uuid4().hex[:12] (12 lowercase hex chars),
    which are a strict subset of the allowed pattern.
    """
    if not _CHAR_ID_RE.fullmatch(char_id):
        raise ValueError(f"invalid character id: {char_id!r}")
    return char_id


# ---------------------------------------------------------------------------
# Root resolution (dynamic — reads env on every call for test isolation)
# ---------------------------------------------------------------------------

def _char_root() -> Path:
    """Return the character store root, resolved fresh on each call.

    Reading the env var here (not at import time) ensures that
    monkeypatch.setenv("NEBULA_CHARACTER_ROOT", ...) in tests takes effect
    even when the module was already imported before the test runs.
    """
    raw = os.environ.get("NEBULA_CHARACTER_ROOT", "")
    if raw:
        return Path(raw)
    return Path.home() / ".nebula" / "characters"


def _scope_dir(char_root: Path, project_id: str | None) -> Path:
    """Return the directory for a given scope.

    Raises ValueError (via _validate_project_id) if project_id is unsafe.
    """
    if project_id:
        _validate_project_id(project_id)
        scope = char_root / project_id
        # Belt-and-suspenders: confirm the resolved path stays inside char_root.
        if not scope.resolve().is_relative_to(char_root.resolve()):
            raise ValueError(f"invalid projectId: {project_id!r}")
        return scope
    return char_root / "_global"


def _find_char_file(char_root: Path, char_id: str) -> Path | None:
    """Search all subdirectories of char_root for <char_id>.json.

    Characters can live under any project dir or _global; this avoids
    requiring the caller to know the scope when they only have an id.

    Raises ValueError (via _validate_char_id) if char_id contains path
    separators or other unsafe characters before any filesystem access.
    """
    _validate_char_id(char_id)
    if not char_root.exists():
        return None
    for sub in char_root.iterdir():
        if not sub.is_dir():
            continue
        candidate = sub / f"{char_id}.json"
        if candidate.exists():
            return candidate
    return None


def _now_iso() -> str:
    return datetime.now(timezone.utc).isoformat()


def _write_json(path: Path, data: dict) -> None:
    """Write *data* as JSON to *path* atomically via a temp file + rename.

    A crash or disk-full mid-write leaves a .json.tmp file rather than
    truncating the live .json, so a previously-valid character is never
    destroyed by a partial write.
    """
    tmp = path.with_suffix(".json.tmp")
    tmp.write_text(json.dumps(data, ensure_ascii=False, indent=2), encoding="utf-8")
    tmp.replace(path)  # atomic on same filesystem


# ---------------------------------------------------------------------------
# CharacterStore
# ---------------------------------------------------------------------------

class CharacterStore:
    """CRUD store for Character objects backed by JSON files."""

    # ------------------------------------------------------------------
    # create
    # ------------------------------------------------------------------

    def create(
        self,
        name: str,
        subjectType: str,
        referenceViews: list[str],
        frozenTraitString: str,
        seed: int,
        consistencyStrength: float,
        projectId: str | None = None,
    ) -> dict:
        """Create a new Character and persist it.

        Validates that referenceViews has at least 3 entries (fewer breaks
        multi-view consistency). Assigns id, version, thumbnail, and
        timestamps — callers supply only the user-visible fields.

        Returns the full Character dict as stored.
        """
        if not referenceViews or len(referenceViews) < 3:
            raise ValueError(
                f"referenceViews must contain at least 3 entries "
                f"(got {len(referenceViews) if referenceViews else 0})"
            )

        char_id = uuid4().hex[:12]
        now = _now_iso()

        char: dict = {
            "id": char_id,
            "name": name,
            "version": 1,
            "subjectType": subjectType,
            # Store verbatim — order is part of the identity contract
            "referenceViews": list(referenceViews),
            # Store byte-identical — normalization breaks identity
            "frozenTraitString": frozenTraitString,
            "seed": seed,
            "consistencyStrength": consistencyStrength,
            # Auto-derive thumbnail from the first reference view
            "thumbnail": referenceViews[0],
            "projectId": projectId,
            "createdAt": now,
            "updatedAt": now,
        }

        root = _char_root()
        scope_dir = _scope_dir(root, projectId)
        scope_dir.mkdir(parents=True, exist_ok=True)
        _write_json(scope_dir / f"{char_id}.json", char)
        return char

    # ------------------------------------------------------------------
    # get
    # ------------------------------------------------------------------

    def get(self, char_id: str) -> dict | None:
        """Return the Character dict for *char_id*, or None if not found."""
        path = _find_char_file(_char_root(), char_id)
        if path is None:
            return None
        return json.loads(path.read_text(encoding="utf-8"))

    # ------------------------------------------------------------------
    # list
    # ------------------------------------------------------------------

    def list(self, scope: str, projectId: str | None = None) -> list[dict]:
        """List Characters by scope.

        scope='project' + projectId=X  → characters under CHAR_ROOT/X/
        scope='global'                 → characters under CHAR_ROOT/_global/
        """
        root = _char_root()
        if scope == "project":
            if not projectId:
                raise ValueError("projectId is required for scope='project'")
            _validate_project_id(projectId)
            target_dir = root / projectId
        else:
            target_dir = root / "_global"

        if not target_dir.exists():
            return []

        results: list[dict] = []
        for path in sorted(target_dir.glob("*.json")):
            try:
                char = json.loads(path.read_text(encoding="utf-8"))
                results.append(char)
            except (json.JSONDecodeError, OSError):
                continue
        return results

    # ------------------------------------------------------------------
    # update
    # ------------------------------------------------------------------

    def update(self, char_id: str, **fields) -> dict:
        """Update mutable fields on a Character, bump version, refresh updatedAt.

        Raises KeyError if the character doesn't exist.
        Immutable fields (id, createdAt, projectId) are silently ignored
        in *fields* even if passed — they cannot be changed after creation.

        Returns the updated Character dict.
        """
        root = _char_root()
        path = _find_char_file(root, char_id)
        if path is None:
            raise KeyError(f"Character '{char_id}' not found")

        char = json.loads(path.read_text(encoding="utf-8"))

        # Immutable fields — never allow update
        _immutable = {"id", "createdAt", "projectId"}

        for key, value in fields.items():
            if key in _immutable:
                continue
            char[key] = value

        char["version"] = char.get("version", 1) + 1
        char["updatedAt"] = _now_iso()

        _write_json(path, char)
        return char

    # ------------------------------------------------------------------
    # delete
    # ------------------------------------------------------------------

    def delete(self, char_id: str) -> None:
        """Delete a Character by id.

        Raises KeyError if not found.
        """
        root = _char_root()
        path = _find_char_file(root, char_id)
        if path is None:
            raise KeyError(f"Character '{char_id}' not found")
        path.unlink()
