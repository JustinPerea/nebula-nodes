"""A project deleted for good takes its moodboards, characters and styles with it.

"Deleted for good" means gone (Justin, 2026-11-04): when a canvas project
leaves Recently deleted for good (Delete forever, Empty, or the 30-day expiry
in services/project_store.purge_expired_trash), the moodboards, Characters and
Styles filed under it go too, live or in their store's own Recently deleted,
with their side files (a board's ``.notes``, its Updates). Before this, the
catalog entry went and the files stayed on disk, answering GET with a
projectId no project had; the next start then re-homed them to Global
(services/asset_project_rehome.py).

The three stores share one layout (services/asset_trash.py). Per store root,
for project ``P``:

    <root>/P/<id>.json                     each asset whose own projectId is P
    <root>/.trash/<id>.json (+ record)     each trashed asset deleted from P
    <root>/<side folder>/<id>.json         its side files, unless another copy
                                           of that id is still live or trashed

An asset file that doesn't say it is P's (unreadable, or another projectId)
is left where it is: only what provably belonged to P goes. Image files
(``/api/outputs/...``) are never deleted: the output folder is shared by the
canvas, run history, boards, Characters, Styles and Commons, and keeps no
record of who uses a file, so nothing here could prove an image is unused.

What else may still name a deleted asset by id: a Moodboard or Character node
in another project's graph (or the same node in run history). It fails as for
any asset deleted for good: the node card says "#id was deleted for good or
never existed", a run says "This node's character can't be found. It may have
been deleted for good. Pick another character for this node." (handlers/
character_node.py, handlers/moodboard.py), and edit_canvas refuses to point a
node at it. Nothing stores a Style's id (applying one copies its prompt and
settings), and an open asset proposal on a board is invalidated when the
board is gone (main._sweep_asset_proposals).

Crash safety (a journal in the catalog itself). The catalog commit that drops
the project from the trash also adds its id to ``catalog["assetPurges"]``, in
one atomic write. Only after that commit are the files deleted, and only
after they are all gone is the id taken off the list (a second commit). So:

- a failure before the commit changes nothing: the project is still in
  Recently deleted with everything filed under it;
- a failure after it leaves the id on the list, and the next purge, listing
  or start (``finish``) deletes what is left and then clears it;
- the start-up re-home treats an id on the list as a project's, never as an
  old-style folder to move to Global.

Already-orphaned assets (``sweep_orphans``): purges before this change left
files behind, and each start re-homed them to Global (those stay there:
Justin, 2026-11-04). Once per install, at start-up and before the re-home,
the assets whose project is in neither the catalog, its trash nor the list
above are deleted, under the same rules. Only when it is provable: the
catalog file exists and reads, it holds at least one project (live or
trashed), the store root sits beside the state folder the catalog is in (so a
backend pointed at another catalog never sweeps the person's files; checked
per store), the folder name is a catalog id (32 hex, what
project_store.make_project mints, so an old-style folder like
``nebula_nodes`` is left to the re-home) and the asset itself names that
project. The count is logged, never a name.
"""
from __future__ import annotations

import json
import logging
import re
from collections.abc import Callable, Container, Iterable
from contextlib import AbstractContextManager, nullcontext
from dataclasses import dataclass
from datetime import datetime, timezone
from pathlib import Path
from typing import Any

from services.asset_trash import RECORD_SUFFIX, TRASH_DIR

logger = logging.getLogger(__name__)

# The catalog key holding the ids of projects deleted for good whose
# moodboards, characters or styles may still be on disk.
PENDING_KEY = "assetPurges"
# A canvas project id as the catalog mints it (project_store._ID).
_PROJECT_ID = re.compile(r"^[a-f0-9]{32}$")
_ASSET_ID = re.compile(r"^[A-Za-z0-9_-]{1,64}$")
SWEEP_MARKER = "purged-project-assets.json"
# The kinds in the order every line names them: moodboards,
# characters, styles. The trash kind of each (asset_trash's record ``kind``).
KINDS = ("moodboard", "character", "style")
PLURAL = {"moodboard": "moodboards", "character": "characters", "style": "styles"}


@dataclass(frozen=True)
class AssetStore:
    kind: str                                   # "moodboard" | "character" | "style"
    root: Path
    side_folders: tuple[str, ...] = ()
    lock: Callable[[str], AbstractContextManager[Any]] = lambda _asset_id: nullcontext()


def default_stores() -> list[AssetStore]:
    """The three stores, from each one's own root resolver (read now)."""
    from services import character_store, moodboard_store, preset_store

    return [
        AssetStore("moodboard", moodboard_store.store_root(), moodboard_store.BOARD_SIDE_FOLDERS,
                   moodboard_store._board_lock),
        AssetStore("character", character_store.store_root(), (), character_store._char_lock),
        AssetStore("style", preset_store.store_root()),
    ]


# -- the journal (in the catalog) --------------------------------------------------

def note_purged(catalog: dict[str, Any], project_ids: Iterable[str]) -> None:
    """Record, in the catalog about to be committed, that these projects were
    deleted for good and what is filed under them is to go."""
    ids = set(pending(catalog)) | {pid for pid in project_ids if _PROJECT_ID.fullmatch(str(pid))}
    if ids:
        catalog[PENDING_KEY] = sorted(ids)


def pending(catalog: dict[str, Any]) -> list[str]:
    raw = catalog.get(PENDING_KEY)
    if not isinstance(raw, list):
        return []
    return sorted({pid for pid in raw if isinstance(pid, str) and _PROJECT_ID.fullmatch(pid)})


def clear(catalog: dict[str, Any], project_ids: Iterable[str]) -> None:
    done = set(project_ids)
    left = [pid for pid in pending(catalog) if pid not in done]
    if left:
        catalog[PENDING_KEY] = left
    else:
        catalog.pop(PENDING_KEY, None)


def known_projects(catalog: dict[str, Any]) -> set[str]:
    """Every project the catalog still has, open or in Recently deleted."""
    return set(catalog.get("projects") or {}) | set(catalog.get("trash") or {})


# -- one project's assets -------------------------------------------------------------

def _read(path: Path) -> dict[str, Any] | None:
    try:
        value = json.loads(path.read_text(encoding="utf-8"))
    except (OSError, ValueError):
        return None
    return value if isinstance(value, dict) else None


def _trashed_of(store: AssetStore, project_id: str) -> list[tuple[str, Path, dict[str, Any]]]:
    """(id, record path, record) for each trashed asset deleted from the project."""
    trash = store.root / TRASH_DIR
    if not trash.is_dir():
        return []
    found = []
    for record_path in sorted(trash.glob(f"*{RECORD_SUFFIX}")):
        asset_id = record_path.name[: -len(RECORD_SUFFIX)]
        if not _ASSET_ID.fullmatch(asset_id) or not (trash / f"{asset_id}.json").is_file():
            continue
        record = _read(record_path)
        if record is None or record.get("projectId") != project_id or record.get("scopeDir") != project_id:
            continue
        found.append((asset_id, record_path, record))
    return found


def _live_of(store: AssetStore, project_id: str) -> list[tuple[str, Path, dict[str, Any]]]:
    """(id, path, asset) for each live asset in the project's folder that names it."""
    folder = store.root / project_id
    if not folder.is_dir() or folder.is_symlink():
        return []
    found = []
    for path in sorted(folder.glob("*.json")):
        asset = _read(path)
        if _ASSET_ID.fullmatch(path.stem) and asset is not None and asset.get("projectId") == project_id:
            found.append((path.stem, path, asset))
    return found


def names(project_id: str, stores: list[AssetStore] | None = None) -> dict[str, list[str]]:
    """What deleting the project for good would delete, by kind
    (``moodboards``, ``characters``, ``styles``): each asset's name, live and
    trashed, sorted. For the Projects screen's confirmation lines."""
    result: dict[str, list[str]] = {PLURAL[kind]: [] for kind in KINDS}
    if not _PROJECT_ID.fullmatch(str(project_id)):
        return result
    for store in stores if stores is not None else default_stores():
        if not store.root.is_dir():
            continue
        found = [str(asset.get("name") or "") for _id, _path, asset in _live_of(store, project_id)]
        found += [str(record.get("name") or "") for _id, _path, record in _trashed_of(store, project_id)]
        result[PLURAL[store.kind]] = sorted(found, key=lambda name: (name.casefold(), name))
    return result


def _copies(store: AssetStore, asset_id: str) -> int:
    """How many copies of ``asset_id`` this store holds: live in any scope
    folder, or in the trash."""
    count = 0
    for sub in store.root.iterdir():
        if not sub.is_dir() or (sub.name.startswith(".") and sub.name != TRASH_DIR):
            continue
        if (sub / f"{asset_id}.json").is_file():
            count += 1
    return count


def _drop_side_files(store: AssetStore, asset_id: str) -> None:
    """The asset's side files (a board's Updates), unless another copy of
    its id is still on disk: they are kept by id, so a copy filed elsewhere
    (a re-home that met a collision) shares them."""
    if not store.side_folders or _copies(store, asset_id):
        return
    for folder in store.side_folders:
        (store.root / folder / f"{asset_id}.json").unlink(missing_ok=True)


def delete_store_assets(store: AssetStore, project_id: str, *, keep: Container[str]) -> list[dict[str, Any]]:
    """Delete project ``project_id``'s assets in one store (live and trashed)
    and return ``{id, name, projectId}`` for each. ``keep`` is every project
    the catalog still has: one of those is never touched (ValueError). OSError
    propagates; what was deleted stays deleted and the caller retries the rest."""
    if not _PROJECT_ID.fullmatch(project_id):
        raise ValueError(f"invalid project id: {project_id!r}")
    if project_id in keep:
        raise ValueError(f"project {project_id} is still in the catalog; what is filed under it stays")
    if not store.root.is_dir():
        return []
    removed: list[dict[str, Any]] = []
    # Trashed first: the file, then its record (a record without its file is
    # ignored by the trash, services/asset_trash.py).
    trash = store.root / TRASH_DIR
    for asset_id, record_path, record in _trashed_of(store, project_id):
        with store.lock(asset_id):
            (trash / f"{asset_id}.json").unlink(missing_ok=True)
            record_path.unlink(missing_ok=True)
        _drop_side_files(store, asset_id)
        removed.append({"id": asset_id, "name": str(record.get("name") or ""), "projectId": project_id})
    folder = store.root / project_id
    for asset_id, path, _asset in _live_of(store, project_id):
        with store.lock(asset_id):
            # Read again under the lock: a write since may have changed it.
            asset = _read(path)
            if asset is None or asset.get("projectId") != project_id:
                continue  # not provably this project's: left for the re-home
            path.unlink(missing_ok=True)
        _drop_side_files(store, asset_id)
        removed.append({"id": asset_id, "name": str(asset.get("name") or ""), "projectId": project_id})
    if folder.is_dir() and not folder.is_symlink():
        for partial in folder.glob("*.json.tmp"):  # a write a crash cut short
            partial.unlink(missing_ok=True)
        try:
            folder.rmdir()  # only when nothing is left in it
        except OSError:
            pass
    return removed


Removed = dict[str, list[dict[str, Any]]]


def _empty_removed() -> Removed:
    return {kind: [] for kind in KINDS}


def delete_project_assets(project_id: str, *, keep: Container[str],
                          stores: list[AssetStore] | None = None) -> Removed:
    """``delete_store_assets`` in every store: what went, by kind."""
    removed = _empty_removed()
    for store in stores if stores is not None else default_stores():
        removed[store.kind].extend(delete_store_assets(store, project_id, keep=keep))
    return removed


def finish(catalog: dict[str, Any], stores: list[AssetStore] | None = None) -> tuple[list[str], Removed]:
    """Delete what is filed under every project on the catalog's list.
    Returns ``(done, removed)``: the project ids now finished (the caller
    takes them off the list and commits) and what went, by kind. A project
    whose files couldn't all be deleted stays on the list, logged, for next time."""
    keep = known_projects(catalog)
    stores = stores if stores is not None else default_stores()
    done: list[str] = []
    removed = _empty_removed()
    for project_id in pending(catalog):
        if project_id in keep:
            done.append(project_id)  # back in the catalog: its files are its own again
            continue
        try:
            went = delete_project_assets(project_id, keep=keep, stores=stores)
        except OSError as exc:
            logger.warning("A deleted project's moodboards, characters or styles weren't all removed (%s); "
                           "trying again later", type(exc).__name__)
            continue
        for kind, items in went.items():
            removed[kind].extend(items)
        done.append(project_id)
    return done, removed


# -- assets already orphaned ----------------------------------------------------------

def roots_paired(state_dir: Path, store_root: Path) -> bool:
    """Whether a store root belongs with the catalog under ``state_dir``:
    ``~/.nebula`` holds both (``~/.nebula/moodboards``), or the desktop app's
    data folder holds them side by side (``<data>/state``, ``<data>/moodboards``)."""
    try:
        state = state_dir.resolve()
        parent = store_root.resolve().parent
    except OSError:
        return False
    return parent == state or (state.name == "state" and parent == state.parent)


def orphaned_project_ids(store: AssetStore, catalog: dict[str, Any]) -> list[str]:
    """Catalog-shaped project ids that this store files assets under (live,
    or in the trash) and that the catalog no longer has, open, trashed or on
    its list."""
    known = known_projects(catalog) | set(pending(catalog))
    found: set[str] = set()
    root = store.root
    if not root.is_dir():
        return []
    for sub in root.iterdir():
        if sub.is_dir() and not sub.is_symlink() and _PROJECT_ID.fullmatch(sub.name) and sub.name not in known:
            found.add(sub.name)
    trash = root / TRASH_DIR
    if trash.is_dir():
        for record_path in trash.glob(f"*{RECORD_SUFFIX}"):
            record = _read(record_path)
            scope = str((record or {}).get("scopeDir") or "")
            if _PROJECT_ID.fullmatch(scope) and scope not in known:
                found.add(scope)
    return sorted(found)


def sweep_orphans(catalog: dict[str, Any] | None, *, state_dir: Path,
                  stores: list[AssetStore] | None = None) -> dict[str, Any]:
    """Once per install: delete what projects deleted for good before this
    change left behind. ``catalog`` is None when there is no catalog file.
    Returns ``{status, removed}`` (a count per kind); writes the marker only
    once it has run. A store whose root isn't paired with the catalog is
    skipped."""
    marker = state_dir / "migrations" / SWEEP_MARKER
    counts = {kind: 0 for kind in KINDS}
    if marker.exists():
        return {"status": "done before", "removed": counts}
    if catalog is None:
        return {"status": "skipped: no project catalog yet", "removed": counts}
    if not known_projects(catalog):
        return {"status": "skipped: the catalog has no projects", "removed": counts}
    stores = stores if stores is not None else default_stores()
    paired = [store for store in stores if roots_paired(state_dir, store.root)]
    if not paired:
        return {"status": "skipped: no store folder is this catalog's", "removed": counts}
    keep = known_projects(catalog)
    for store in paired:
        for project_id in orphaned_project_ids(store, catalog):
            counts[store.kind] += len(delete_store_assets(store, project_id, keep=keep))
    marker.parent.mkdir(parents=True, exist_ok=True)
    tmp = marker.with_name(marker.name + ".tmp")
    tmp.write_text(json.dumps({"version": 1, "sweptAt": datetime.now(timezone.utc).isoformat(),
                               "removed": counts, "stores": [store.kind for store in paired]}), encoding="utf-8")
    tmp.replace(marker)
    logger.info("Left by projects deleted for good earlier: %d moodboards, %d characters, %d styles removed",
                counts["moodboard"], counts["character"], counts["style"])
    return {"status": "done", "removed": counts}
