"""CharacterStore — project-scoped & global character persistence over JSON files.

On-disk layout:
    CHAR_ROOT/<projectId>/<id>.json   — project-scoped characters
    CHAR_ROOT/_global/<id>.json       — global characters (no projectId)
    CHAR_ROOT/.trash/                 — deleted characters (services/asset_trash.py)

CHAR_ROOT defaults to ~/.nebula/characters; override via NEBULA_CHARACTER_ROOT
(the test suite sets this env var so tests never touch the real home directory).

The root is resolved DYNAMICALLY on each call (via _char_root()) so per-test
monkeypatch.setenv() works cleanly regardless of import order.

Identity-correctness contract:
  - referenceViews order is stored and returned verbatim (never sorted/reordered)
  - frozenTraitString is stored and returned byte-identical (never normalized)
  - version is bumped deterministically on every update call
  - an update given ``base_version`` (the version the caller read) is
    refused with CharacterVersionConflict when the Character has moved on,
    so a Studio can't overwrite an edit made elsewhere since it read it

No external dependencies: stdlib plus services/asset_trash.py (Recently deleted).
"""
from __future__ import annotations

import json
import os
import re
import threading
from contextlib import contextmanager
from datetime import datetime, timezone
from pathlib import Path
from uuid import uuid4

from services import asset_trash
from services.asset_trash import is_trash_folder

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


def store_root() -> Path:
    """This store's root folder, resolved now (env var, else ~/.nebula/...).
    Public so other code (services/asset_project_rehome.py) finds the same
    folder this store writes to."""
    return _char_root()


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
        # Skip the trash (``.trash``): a deleted character isn't found until restored.
        if not sub.is_dir() or is_trash_folder(sub):
            continue
        candidate = sub / f"{char_id}.json"
        if candidate.exists():
            return candidate
    return None


# One lock per Character: an update reads the file, checks its version,
# changes it and writes it back as one step, whichever thread it runs on.
_LOCKS: dict[str, threading.RLock] = {}
_LOCKS_GUARD = threading.Lock()


@contextmanager
def _char_lock(char_id: str):
    with _LOCKS_GUARD:
        lock = _LOCKS.setdefault(char_id, threading.RLock())
    with lock:
        yield


class CharacterVersionConflict(Exception):
    """An update sent ``base_version`` and the Character has moved on since:
    someone else saved it. ``character`` is the Character as it is now, so
    the caller can rebase its change on it and send it again."""

    def __init__(self, character: dict) -> None:
        super().__init__(f"the Character changed since you read it (it is at version {character.get('version')})")
        self.character = character


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

    def update(self, char_id: str, *, base_version: int | None = None, **fields) -> dict:
        """Update mutable fields on a Character, bump version, refresh updatedAt.

        Raises KeyError if the character doesn't exist.
        Immutable fields (id, createdAt, projectId) are silently ignored
        in *fields* even if passed — they cannot be changed after creation.
        ``base_version``: the version the caller read; any other raises
        CharacterVersionConflict and writes nothing. None skips the check.

        Returns the updated Character dict.
        """
        with _char_lock(_validate_char_id(char_id)):
            return self._update(char_id, base_version, fields)

    def _update(self, char_id: str, base_version: int | None, fields: dict) -> dict:
        root = _char_root()
        path = _find_char_file(root, char_id)
        if path is None:
            raise KeyError(f"Character '{char_id}' not found")

        try:
            char = json.loads(path.read_text(encoding="utf-8"))
        except FileNotFoundError:  # moved to Recently deleted after it was found
            raise KeyError(f"Character '{char_id}' not found") from None
        if base_version is not None and int(char.get("version", 1)) != base_version:
            raise CharacterVersionConflict(char)

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
    # move (Global <-> a canvas project)
    # ------------------------------------------------------------------

    def move(self, char_id: str, projectId: str | None) -> tuple[dict, dict, bool]:
        """File a Character under canvas project ``projectId`` (None: Global)
        and return ``(before, after, moved)``. Only ``projectId`` changes:
        ``id``, ``version`` and ``updatedAt`` stay, since a move isn't an edit
        (services/asset_project_rehome.move_asset). ``moved`` is False when it
        was already there. The caller checks ``projectId`` is a live canvas
        project (main.py). KeyError: no live Character with that id (one in
        Recently deleted isn't live); FileExistsError: a different file with
        this id is already in the target folder."""
        from services.asset_project_rehome import GLOBAL_DIR, move_asset

        root = _char_root()
        path = _find_char_file(root, char_id)
        if path is None:
            raise KeyError(f"Character '{char_id}' not found")
        target = projectId or None
        _scope_dir(root, target)  # refuses an unsafe id before any path is built from it
        # Two live copies (a re-home that skipped a collision leaves one in an
        # old folder): which one is "the" asset isn't ours to guess.
        copies = sorted(sub.name for sub in root.iterdir()
                        if sub.is_dir() and not is_trash_folder(sub) and (sub / f"{char_id}.json").is_file())
        if len(copies) > 1:
            raise FileExistsError(f"there is a copy with this id in each of {', '.join(copies)}")
        before = json.loads(path.read_text(encoding="utf-8"))
        if (before.get("projectId") or None) == target and path.parent.name == (target or GLOBAL_DIR):
            return before, before, False
        moved_to = move_asset("character", root, path, target)
        return before, json.loads(moved_to.read_text(encoding="utf-8")), True

    # ------------------------------------------------------------------
    # delete
    # ------------------------------------------------------------------

    def delete(self, char_id: str, deleted_by: dict | None = None) -> dict:
        """Move a Character to Recently deleted (services/asset_trash.py) and
        return the trash record. ``deleted_by`` is who asked, as
        services/canvas_events.actor_record gives it.

        Raises KeyError if not found.
        """
        root = _char_root()
        path = _find_char_file(root, char_id)
        if path is None:
            raise KeyError(f"Character '{char_id}' not found")
        return asset_trash.move_to_trash(root, path, kind="character", deleted_by=deleted_by)

    # ------------------------------------------------------------------
    # Recently deleted
    # ------------------------------------------------------------------

    def trashed(self, char_id: str) -> dict | None:
        """The trash record when this Character is in Recently deleted, else None."""
        _validate_char_id(char_id)
        return asset_trash.trashed(_char_root(), char_id)

    def list_trash(self, scope: str | None = None, projectId: str | None = None) -> list[dict]:
        if projectId is not None:
            _validate_project_id(projectId)
        return asset_trash.list_trashed(_char_root(), scope=scope, project_id=projectId)

    def restore(self, char_id: str) -> dict:
        """Bring a trashed Character back with the same id and contents."""
        _validate_char_id(char_id)
        return asset_trash.restore(_char_root(), char_id)

    def purge(self, char_id: str) -> None:
        """Delete a trashed Character for good. Only the person may (main.py)."""
        _validate_char_id(char_id)
        asset_trash.purge(_char_root(), char_id)
