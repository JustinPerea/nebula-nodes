"""Re-home of project-scoped assets saved under an old-style project id.

Until 2026-10-19 the Studios, the Assets panel and Create filed "project"
Characters, Moodboards and Styles under one install-wide id: the backend's
working-folder name (``nebula_nodes`` on a source checkout) or
``NEBULA_PROJECT_ID``. "Project" now means the canvas project (the catalog's
``activeProjectId``, services/project_store.py), so those folders belong to no
project, and their assets would vanish from every Project tab (a node that
points at one still finds it by id, which would hide the loss).

At every startup this moves each such asset, by the rule in ``decide_home``:

    <root>/<old folder>/<id>.json  ->  <root>/<canvas project id>/<id>.json
                                   or  <root>/_global/<id>.json

and updates its ``projectId`` (and a style's ``scope``). Nothing else in the
file changes: not ``id``, ``version`` or ``updatedAt``, since a re-home isn't
an edit. A board or character in Recently deleted (``.trash``) stays there;
its file and its record (``projectId``, ``scopeDir``) are pointed at the new
home, so Restore puts it there.

Which folders count as old: any project folder (not ``_global``, not a dot
folder such as ``.trash``) whose name isn't the id of a canvas project in the
catalog. A folder named for a project in the catalog's Recently deleted is a
canvas project's folder too and is left alone (restoring the project brings
its assets back with it).

Safety:
- Every file it changes is copied first to ``<root>/../<kind>-backups/
  project-rehome-<time>/`` (same relative path as under the root), and
  ``migration-log.json`` there lists each asset: kind, id, name, from, to and
  why. Copying the backups back over the root (and deleting the moved copy
  named in the log) undoes it; implementation-notes.md has the steps.
- A file already at the target with the same id is never overwritten: that
  asset is skipped and logged.
- It runs on every start, not once: an older build or the desktop app on the
  same ``~/.nebula`` can still write an old-style folder later, and those
  assets would vanish from every Project tab. Finding them is a listing of
  each root (and its ``.trash``); a start with nothing to move writes no
  backup or log.
- A skip that hasn't changed since (same file, size and mtime) is logged
  once: the state file (``<state dir>/migrations/asset-project-rehome.json``)
  remembers it. The move is still tried each start, so it happens once the
  collision is gone.
- If the catalog can't be read, nothing changes. While there are old-style
  assets and an open canvas but no projects yet, it waits for the canvas to
  become a project.
"""
from __future__ import annotations

import json
import logging
import os
import re
import shutil
from dataclasses import dataclass
from datetime import datetime, timezone
from pathlib import Path
from typing import Any, Callable, Iterable, Mapping
from uuid import uuid4

logger = logging.getLogger(__name__)

GLOBAL_DIR = "_global"
TRASH_DIR = ".trash"
RECORD_SUFFIX = ".trash.json"
MARKER_NAME = "asset-project-rehome.json"
_SAFE = re.compile(r"^[A-Za-z0-9_-]{1,64}$")

# Node params that hold a saved board's or character's id. The ``_`` keys are
# where nodes saved before 2026-10-18 kept it (services/agent_params.py).
REFERENCE_KEYS: dict[str, tuple[str, ...]] = {
    "moodboard": ("moodboard", "_moodboardId"),
    "character": ("character", "_characterId"),
}


@dataclass(frozen=True)
class AssetRoot:
    kind: str            # "moodboard" | "character" | "preset"
    root: Path
    has_trash: bool


def default_roots() -> list[AssetRoot]:
    """The three stores' roots, from each store's own resolver."""
    from services import character_store, moodboard_store, preset_store

    return [
        AssetRoot("moodboard", moodboard_store.store_root(), True),
        AssetRoot("character", character_store.store_root(), True),
        AssetRoot("preset", preset_store.store_root(), False),
    ]


# -- the rule ---------------------------------------------------------------------

def decide_home(kind: str, users: list[tuple[str, str]]) -> tuple[str | None, str]:
    """Where one old-folder asset goes: ``(canvas project id, reason)``, or
    ``(None, reason)`` for Global. ``users`` are the live canvas projects
    (id, name) whose saved or open graph points at it.

    R1, "by use, else Global" (Justin picked R1 on 2026-10-19): used by
    exactly one live project -> that project; by none or by several -> Global.
    Styles aren't referenced by graphs, so they go to Global (his P3). A
    different rule is a change to this function only."""
    if kind == "preset":
        return None, "styles go to Global"
    if len(users) == 1:
        project_id, name = users[0]
        return project_id, f"used only in {name}"
    if not users:
        return None, "not used in any project"
    return None, f"used in {len(users)} projects"


# -- graph references ---------------------------------------------------------------

def _node_params(node: Any) -> Mapping[str, Any] | None:
    """A node's params, from a saved snapshot (``{data: {params}}``) or the
    live graph (``{params}``)."""
    if not isinstance(node, dict):
        return None
    data = node.get("data")
    params = data.get("params") if isinstance(data, dict) else node.get("params")
    return params if isinstance(params, dict) else None


def referenced_ids(nodes: Iterable[Any], kind: str) -> set[str]:
    found: set[str] = set()
    for node in nodes or ():
        params = _node_params(node)
        if not params:
            continue
        for key in REFERENCE_KEYS.get(kind, ()):
            value = params.get(key)
            if isinstance(value, str) and value.strip():
                found.add(value.strip())
    return found


def project_users(catalog: Mapping[str, Any], live_nodes: Iterable[Any], kind: str) -> dict[str, list[tuple[str, str]]]:
    """For each asset id, the live canvas projects (id, name) whose graph uses
    it. The open project counts its live graph as well as its saved snapshot,
    in case the snapshot is behind."""
    users: dict[str, list[tuple[str, str]]] = {}
    projects = catalog.get("projects") or {}
    active = catalog.get("activeProjectId")
    live = list(live_nodes or ())
    for project_id, project in projects.items():
        snapshot = project.get("snapshot") if isinstance(project, dict) else None
        nodes = snapshot.get("nodes") if isinstance(snapshot, dict) else None
        ids = referenced_ids(nodes or [], kind)
        if project_id == active:
            ids |= referenced_ids(live, kind)
        name = str(project.get("name") or "Untitled project") if isinstance(project, dict) else "Untitled project"
        for asset_id in ids:
            users.setdefault(asset_id, []).append((project_id, name))
    return users


# -- files ------------------------------------------------------------------------

def _read_json(path: Path) -> dict[str, Any]:
    value = json.loads(path.read_text(encoding="utf-8"))
    if not isinstance(value, dict):
        raise ValueError("not a JSON object")
    return value


def _write_json_atomic(path: Path, data: dict[str, Any]) -> None:
    path.parent.mkdir(parents=True, exist_ok=True)
    tmp = path.with_name(f".{path.name}.{uuid4().hex}.tmp")
    try:
        tmp.write_text(json.dumps(data, ensure_ascii=False, indent=2), encoding="utf-8")
        os.replace(tmp, path)
    finally:
        tmp.unlink(missing_ok=True)


def _rehomed(kind: str, asset: dict[str, Any], target: str | None) -> dict[str, Any]:
    """``asset`` filed under ``target`` (None = Global), the way its store
    writes that scope. Only the scope fields change."""
    moved = dict(asset)
    moved["projectId"] = target
    if kind == "preset":
        moved["scope"] = "project" if target else "global"
    return moved


def move_asset(kind: str, root: Path, source: Path, target: str | None, *,
               before_change: Callable[[Path], Any] | None = None) -> Path:
    """Move one live asset file (``<root>/<folder>/<id>.json``) to project
    ``target`` (None: Global) and return its new path. Only ``projectId``
    (and a style's ``scope``) change; ``id``, ``version`` and ``updatedAt``
    stay. Raises FileExistsError, changing nothing, when a different file with
    that id is already there; one this move wrote before it was stopped is
    finished instead. ``before_change(source)`` runs first (a backup).

    The migration below uses it, and so does a person's or agent's "Move to
    Global / Move to <project>" (the stores' ``move``, called by main.py
    ``_move_stored_asset``, which checks ``target`` against the catalog and
    broadcasts storedAssetChanged; contract 07, 1.10)."""
    asset = _read_json(source)
    new = _rehomed(kind, asset, target)
    destination = root / (target or GLOBAL_DIR) / source.name
    if destination == source:
        if new != asset:
            if before_change:
                before_change(source)
            _write_json_atomic(source, new)
        return source
    if destination.exists():
        try:
            finished = _read_json(destination) == new
        except (OSError, ValueError):
            finished = False
        if not finished:
            raise FileExistsError(f"{destination.parent.name}/{source.name} already exists")
        if before_change:
            before_change(source)
        source.unlink()
        return destination
    if before_change:
        before_change(source)
    _write_json_atomic(destination, new)
    source.unlink()
    return destination


def _legacy_folders(root: Path, canvas_ids: set[str]) -> list[Path]:
    if not root.is_dir():
        return []
    return sorted(
        sub for sub in root.iterdir()
        if sub.is_dir() and not sub.is_symlink() and not sub.name.startswith(".")
        and sub.name != GLOBAL_DIR and _SAFE.fullmatch(sub.name) and sub.name not in canvas_ids
    )


def _legacy_trash(root: Path, canvas_ids: set[str]) -> list[tuple[Path, Path, dict[str, Any]]]:
    """(asset file, record file, record) for each trashed asset deleted from an
    old folder. A record without its file is ignored, as the trash does."""
    folder = root / TRASH_DIR
    if not folder.is_dir():
        return []
    found = []
    for record_path in sorted(folder.glob(f"*{RECORD_SUFFIX}")):
        asset_id = record_path.name[: -len(RECORD_SUFFIX)]
        asset_path = folder / f"{asset_id}.json"
        if not _SAFE.fullmatch(asset_id) or not asset_path.is_file():
            continue
        try:
            record = _read_json(record_path)
        except (OSError, ValueError):
            continue
        scope_dir = str(record.get("scopeDir") or GLOBAL_DIR)
        if scope_dir == GLOBAL_DIR or scope_dir.startswith(".") or scope_dir in canvas_ids:
            continue
        found.append((asset_path, record_path, record))
    return found


class _Run:
    """One root's re-home: backs up, moves and logs."""

    def __init__(self, spec: AssetRoot, stamp: str, names: Mapping[str, str]) -> None:
        self.spec = spec
        self.names = names
        self.backup_dir = spec.root.parent / f"{spec.kind}-backups" / f"project-rehome-{stamp}"
        self.moved: list[dict[str, Any]] = []
        self.skipped: list[dict[str, Any]] = []

    def backup(self, path: Path) -> Path:
        target = self.backup_dir / path.relative_to(self.spec.root)
        target.parent.mkdir(parents=True, exist_ok=True)
        shutil.copy2(path, target)
        return target

    def to_label(self, target: str | None) -> dict[str, Any] | str:
        return {"projectId": target, "projectName": self.names.get(target, target)} if target else "Global"

    def entry(self, asset_id: str, asset: Mapping[str, Any], from_folder: str, target: str | None,
              reason: str, **extra: Any) -> dict[str, Any]:
        return {"kind": self.spec.kind, "id": asset_id, "name": str(asset.get("name") or ""),
                "from": from_folder, "to": self.to_label(target), "reason": reason, **extra}


def _fingerprint(path: Path) -> str:
    """Which version of a skipped file this is: path, size and mtime."""
    try:
        stat = path.stat()
    except OSError:
        return f"{path}:gone"
    return f"{path}:{stat.st_size}:{stat.st_mtime_ns}"


def _rehome_root(spec: AssetRoot, run: _Run, canvas_ids: set[str],
                 users: dict[str, list[tuple[str, str]]]) -> None:
    root = spec.root
    for folder in _legacy_folders(root, canvas_ids):
        for path in sorted(folder.glob("*.json")):
            asset_id = path.stem
            if not _SAFE.fullmatch(asset_id):
                continue
            try:
                asset = _read_json(path)
            except (OSError, ValueError) as exc:
                run.skipped.append({"kind": spec.kind, "id": asset_id, "from": folder.name,
                                    "reason": f"could not read it: {exc}", "file": str(path)})
                continue
            target, reason = decide_home(spec.kind, users.get(asset_id, []))
            try:
                destination = move_asset(spec.kind, root, path, target, before_change=run.backup)
            except FileExistsError as exc:
                run.skipped.append(run.entry(asset_id, asset, folder.name, target,
                                             f"not moved: {exc}", file=str(path)))
                continue
            backup = run.backup_dir / path.relative_to(root)
            run.moved.append(run.entry(asset_id, asset, folder.name, target, reason,
                                       file=str(destination), backup=str(backup)))
        try:
            folder.rmdir()  # only when nothing is left in it
        except OSError:
            pass
    if not spec.has_trash:
        return
    for asset_path, record_path, record in _legacy_trash(root, canvas_ids):
        asset_id = asset_path.stem
        try:
            asset = _read_json(asset_path)
        except (OSError, ValueError) as exc:
            run.skipped.append({"kind": spec.kind, "id": asset_id, "from": str(record.get("scopeDir")),
                                "reason": f"could not read it: {exc}", "file": str(asset_path), "trashed": True})
            continue
        target, reason = decide_home(spec.kind, users.get(asset_id, []))
        backups = [str(run.backup(asset_path)), str(run.backup(record_path))]
        _write_json_atomic(asset_path, _rehomed(spec.kind, asset, target))
        _write_json_atomic(record_path, {**record, "projectId": target, "scopeDir": target or GLOBAL_DIR})
        run.moved.append(run.entry(asset_id, asset, str(record.get("scopeDir")), target, reason,
                                   file=str(asset_path), backup=backups, trashed=True))


# -- state ------------------------------------------------------------------------

def _state_path(state_dir: Path) -> Path:
    return state_dir / "migrations" / MARKER_NAME


def _read_state(state_dir: Path) -> dict[str, Any]:
    """``{"version": 2, "knownSkips": {kind: {file: fingerprint}}}``. A
    version-1 marker (runs once per root) reads as no known skips."""
    try:
        state = _read_json(_state_path(state_dir))
    except (OSError, ValueError):
        state = {}
    skips = state.get("knownSkips") if state.get("version") == 2 else None
    if not isinstance(skips, dict):
        skips = {}
    return {"version": 2, "knownSkips": {kind: dict(value) for kind, value in skips.items() if isinstance(value, dict)}}


# -- entry point --------------------------------------------------------------------

def rehome_legacy_assets(
    read_catalog: Callable[[], Mapping[str, Any] | None],
    state_dir: Path,
    *,
    live_nodes: Iterable[Any] = (),
    roots: list[AssetRoot] | None = None,
) -> dict[str, Any]:
    """Re-home every old-style asset in every root. Runs on each start.

    ``read_catalog`` returns the project catalog, or None when there is none
    yet; it raises when the catalog can't be read, and then nothing changes.
    ``live_nodes`` is the open project's live graph. Returns ``{status, moved,
    global, skipped, logs}``, where ``skipped`` counts only skips not seen
    before; status is ``nothing to do`` when there was nothing old-style."""
    report: dict[str, Any] = {"status": "done", "moved": 0, "global": 0, "skipped": 0, "logs": []}
    roots = roots if roots is not None else default_roots()
    try:
        catalog = read_catalog() or {"projects": {}, "trash": {}, "activeProjectId": None}
    except Exception as exc:  # noqa: BLE001 - any unreadable catalog: change nothing, retry next start
        report["status"] = f"skipped: the project catalog could not be read ({type(exc).__name__}: {exc})"
        return report
    projects = catalog.get("projects") or {}
    trash = catalog.get("trash") or {}
    canvas_ids = set(projects) | set(trash)
    pending = [spec for spec in roots
               if _legacy_folders(spec.root, canvas_ids) or (spec.has_trash and _legacy_trash(spec.root, canvas_ids))]
    state = _read_state(state_dir)
    if not pending:
        report["status"] = "nothing to do"
        # Forget remembered skips once nothing old-style is left.
        if any(state["knownSkips"].values()):
            _write_json_atomic(_state_path(state_dir), {"version": 2, "knownSkips": {}})
        return report
    live = list(live_nodes or ())
    if not projects and not trash and live:
        # The open canvas hasn't become a project yet (GET /api/projects makes
        # "Recovered canvas" from it). Wait for that, so its assets can go there.
        report["status"] = "skipped: the open canvas isn't a project yet"
        return report
    names = {pid: str(project.get("name") or "Untitled project") for pid, project in projects.items()}
    stamp = datetime.now(timezone.utc).strftime("%Y%m%dT%H%M%S%fZ")
    known_after: dict[str, dict[str, str]] = {}
    for spec in roots:
        if spec not in pending:
            continue
        run = _Run(spec, stamp, names)
        users = project_users(catalog, live, spec.kind) if spec.kind in REFERENCE_KEYS else {}
        stopped: OSError | None = None
        try:
            _rehome_root(spec, run, canvas_ids, users)
        except OSError as exc:
            # The next start carries on: a moved file is no longer in the old
            # folder, and one written but not yet removed there is recognised.
            logger.exception("Project re-home: %s store stopped part way", spec.kind)
            report["status"] = f"partial: {spec.kind} store: {type(exc).__name__}: {exc}"
            stopped = exc
        known = state["knownSkips"].get(spec.kind, {})
        seen: dict[str, str] = {}
        new_skips = []
        for item in run.skipped:
            fingerprint = _fingerprint(Path(item["file"]))
            seen[item["file"]] = fingerprint
            if known.get(item["file"]) != fingerprint:
                new_skips.append(item)
        known_after[spec.kind] = seen
        run.skipped = new_skips
        log_path = _write_log(spec, run, stopped) if run.moved or run.skipped or stopped else None
        if log_path:
            report["logs"].append(str(log_path))
        report["moved"] += len(run.moved)
        report["global"] += sum(1 for item in run.moved if item["to"] == "Global")
        report["skipped"] += len(run.skipped)
    # Remember this start's skips (a root with nothing old-style left has none).
    known_after = {kind: value for kind, value in known_after.items() if value}
    if known_after != {kind: value for kind, value in state["knownSkips"].items() if value}:
        _write_json_atomic(_state_path(state_dir), {"version": 2, "knownSkips": known_after})
    return report


def _write_log(spec: AssetRoot, run: _Run, stopped: OSError | None) -> Path:
    run.backup_dir.mkdir(parents=True, exist_ok=True)
    log_path = run.backup_dir / "migration-log.json"
    log = {"migration": "asset-project-rehome", "rule": "R1: by use, else Global", "kind": spec.kind,
           "root": str(spec.root), "ranAt": datetime.now(timezone.utc).isoformat(),
           **({"stoppedPartWay": f"{type(stopped).__name__}: {stopped}"} if stopped else {}),
           "moved": run.moved, "skipped": run.skipped, "backupDir": str(run.backup_dir)}
    log_path.write_text(json.dumps(log, ensure_ascii=False, indent=2), encoding="utf-8")
    return log_path
