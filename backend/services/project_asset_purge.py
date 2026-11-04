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

Which stores (one pairing rule for every purge and replay). A store's
files are deleted only when its real folder sits beside the catalog's own
folder (``roots_paired``): ``~/.nebula`` holds the catalog's ``projects/``
and ``moodboards/``; or, only when the store's root was set explicitly (its
``NEBULA_*_ROOT``, as the desktop app sets all three, desktop/paths.mjs),
the app's data folder holds ``state/`` and ``moodboards/`` side by side.
"Real" means resolved: the store folder itself is followed to where it
really is. So a backend on a copy of a catalog never deletes the person's
files, whether its store roots are still the person's (``NEBULA_STATE_DIR``
set, even to ``~/.nebula/state``, with ``HOME`` left real), or its own
store folder is a link to the person's store. And a folder where another
catalog sits (``projects/catalog.json`` or ``state/projects/catalog.json``
that isn't this one) is never paired, whatever the env says. A store root
that is a link to nothing (a disk that isn't mounted) or a loop, or a path
that can't be resolved, is unpaired too.

What that costs: a store folder linked on its own to another disk or a
synced folder is unpaired, so a project deleted for good keeps its files
there (in no tab, and never moved to Global) and the id stays on the list.
Linking the whole ``~/.nebula`` or the desktop app's data folder still
purges: the store and the catalog are then both followed to the same place.

An unpaired store is left alone: the id stays on the list (the re-home
keeps skipping it, so nothing is hidden or moved: the project's files stay
where they were, and the count is logged once per start, never a name).
There is no fallback to Global: a copy's purge would otherwise move the real
project's files. ``goesWith`` lists only what a paired store holds, so a
line never promises more than goes. Inside a paired store a ``.trash`` or
side folder (a board's ``.notes``) that is itself a symlink is never
followed, as a symlinked ``<root>/P`` isn't.

A project merely absent from the catalog is never a reason to delete: only
ids this catalog put on its own list are purged. Assets filed under an id
the catalog doesn't know (a lost or replaced catalog, a desktop migration
that copied the stores but not ``projects/``) are left to the start-up
re-home, which moves them to Global with a backup.

Locks. Each delete takes the asset's own store lock (the lock its store
holds while it updates, moves, trashes, restores or purges that id) and
reads the file or trash record again under it, so it only ever removes what
still names the project at that moment. Live files and the trash are each
passed over until a pass finds nothing (a board moved to Recently deleted,
or restored, between two passes is still caught), at most a few times. If
anything of the project's is still there after the last pass, the id stays
on the list and the next purge, listing or start goes on.
"""
from __future__ import annotations

import json
import logging
import os
import re
from collections.abc import Callable, Container, Iterable
from contextlib import AbstractContextManager, nullcontext
from dataclasses import dataclass
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
# The kinds in the order every line names them: moodboards,
# characters, styles. The trash kind of each (asset_trash's record ``kind``).
KINDS = ("moodboard", "character", "style")
PLURAL = {"moodboard": "moodboards", "character": "characters", "style": "styles"}
# Live, then trash, again until a round finds nothing (an asset trashed or
# restored between two passes); a bound, never a loop on a busy store.
_ROUNDS = 3


@dataclass(frozen=True)
class AssetStore:
    kind: str                                   # "moodboard" | "character" | "style"
    root: Path
    side_folders: tuple[str, ...] = ()
    lock: Callable[[str], AbstractContextManager[Any]] = lambda _asset_id: nullcontext()
    # The root came from its NEBULA_*_ROOT (ROOT_ENV), not the ~/.nebula default.
    explicit: bool = False


# Each store's root setting (the desktop app sets all three, desktop/paths.mjs).
ROOT_ENV = {"moodboard": "NEBULA_MOODBOARD_ROOT", "character": "NEBULA_CHARACTER_ROOT",
            "style": "NEBULA_PRESET_ROOT"}


def _explicit(kind: str) -> bool:
    return bool(os.environ.get(ROOT_ENV[kind]))


def default_stores() -> list[AssetStore]:
    """The three stores, from each one's own root resolver (read now)."""
    from services import character_store, moodboard_store, preset_store

    return [
        AssetStore("moodboard", moodboard_store.store_root(), moodboard_store.BOARD_SIDE_FOLDERS,
                   moodboard_store._board_lock, _explicit("moodboard")),
        AssetStore("character", character_store.store_root(), (), character_store._char_lock,
                   _explicit("character")),
        AssetStore("style", preset_store.store_root(), (), preset_store._preset_lock, _explicit("style")),
    ]


# -- which stores are this catalog's ----------------------------------------------

# Once per start: a store path that can't be resolved is logged the first time.
_UNRESOLVED_LOGGED: set[str] = set()


def _logged_once(exc: BaseException) -> None:
    if "unresolved" not in _UNRESOLVED_LOGGED:
        _UNRESOLVED_LOGGED.add("unresolved")
        logger.warning("A moodboard, character or style folder can't be resolved (%s): nothing in it "
                       "is deleted with a project", type(exc).__name__)


def roots_paired(state_dir: Path, store_root: Path, *, explicit: bool = False) -> bool:
    """Whether a store root belongs with the catalog under ``state_dir`` (the
    folder holding the catalog's ``projects/``). The store is followed to
    its real folder, and that folder's parent (``home``) must be the
    catalog's real folder (``~/.nebula`` holds both), or, for a root set
    explicitly (``explicit``: its NEBULA_*_ROOT), the desktop app's data
    folder holding ``state/`` (the catalog's) beside it. Never paired: a
    store root that is a link to nothing (an unmounted disk) or a loop, a
    path that can't be resolved, or a ``home`` that holds another catalog
    (``projects/catalog.json`` or ``state/projects/catalog.json`` that
    isn't this one's)."""
    try:
        if store_root.is_symlink() and not store_root.is_dir():
            return False  # dangling, a disk that isn't mounted, or a loop
        state = state_dir.resolve()
        home = store_root.resolve().parent
        if not (home == state or (explicit and state.name == "state" and home == state.parent)):
            return False
        own = (state / "projects" / "catalog.json").resolve()
        for catalog in (home / "projects" / "catalog.json", home / "state" / "projects" / "catalog.json"):
            if catalog.exists() and catalog.resolve() != own:
                return False  # another catalog's stores
        return True
    except (OSError, RuntimeError) as exc:  # RuntimeError: a symlink loop (Python 3.12)
        _logged_once(exc)
        return False


def paired_stores(state_dir: Path, stores: list[AssetStore] | None = None) -> tuple[list[AssetStore], list[AssetStore]]:
    """``(paired, unpaired)``: the stores whose files this catalog may delete,
    and the rest (left alone, see the module docstring)."""
    stores = stores if stores is not None else default_stores()
    paired = [store for store in stores if roots_paired(state_dir, store.root, explicit=store.explicit)]
    return paired, [store for store in stores if store not in paired]


# Once per start (per process): the unpaired-store line is logged the first
# time it applies, then not again.
_UNPAIRED_LOGGED: set[str] = set()


def _log_unpaired(unpaired: list[AssetStore], waiting: int) -> None:
    kinds = [PLURAL[store.kind] for store in unpaired if store.kind not in _UNPAIRED_LOGGED]
    if not kinds:
        return
    _UNPAIRED_LOGGED.update(store.kind for store in unpaired)
    logger.warning("%d project(s) deleted for good keep their %s for now: that folder isn't beside "
                   "this project catalog, so nothing in it is deleted", waiting, ", ".join(kinds))


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


def _record_names(record: dict[str, Any] | None, project_id: str) -> bool:
    """A trash record of an asset deleted from the project's own folder."""
    return record is not None and record.get("projectId") == project_id and record.get("scopeDir") == project_id


def _trash_records(store: AssetStore) -> list[tuple[str, Path, dict[str, Any]]]:
    """(id, record path, record) for every trashed asset whose file is there."""
    trash = store.root / TRASH_DIR
    if not trash.is_dir() or trash.is_symlink():
        return []  # a linked trash may be another store's
    found = []
    for record_path in sorted(trash.glob(f"*{RECORD_SUFFIX}")):
        asset_id = record_path.name[: -len(RECORD_SUFFIX)]
        if not _ASSET_ID.fullmatch(asset_id) or not (trash / f"{asset_id}.json").is_file():
            continue
        record = _read(record_path)
        if record is not None:
            found.append((asset_id, record_path, record))
    return found


def _trashed_of(store: AssetStore, project_id: str) -> list[tuple[str, Path, dict[str, Any]]]:
    """(id, record path, record) for each trashed asset deleted from the project."""
    return [entry for entry in _trash_records(store) if _record_names(entry[2], project_id)]


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


def _sorted_names(found: list[str]) -> list[str]:
    return sorted(found, key=lambda name: (name.casefold(), name))


def goes_with(project_ids: Iterable[str], *, state_dir: Path,
              stores: list[AssetStore] | None = None) -> dict[str, dict[str, list[str]]]:
    """What deleting each project for good would delete, by kind
    (``moodboards``, ``characters``, ``styles``): each asset's name, live and
    trashed, sorted. For the Projects screen's confirmation lines. One pass
    over each store's trash for all of them, and only the stores this catalog
    may delete from (``paired_stores``)."""
    ids = list(dict.fromkeys(str(pid) for pid in project_ids))
    result = {pid: {PLURAL[kind]: [] for kind in KINDS} for pid in ids}
    wanted = {pid for pid in ids if _PROJECT_ID.fullmatch(pid)}
    if not wanted:
        return result
    paired, _unpaired = paired_stores(state_dir, stores)
    for store in paired:
        if not store.root.is_dir():
            continue
        found: dict[str, list[str]] = {pid: [] for pid in wanted}
        for pid in wanted:
            found[pid] += [str(asset.get("name") or "") for _id, _path, asset in _live_of(store, pid)]
        for _id, _path, record in _trash_records(store):
            pid = record.get("projectId")
            if pid in wanted and _record_names(record, pid):
                found[pid].append(str(record.get("name") or ""))
        for pid, names_found in found.items():
            result[pid][PLURAL[store.kind]] = _sorted_names(names_found)
    return result


def names(project_id: str, *, state_dir: Path, stores: list[AssetStore] | None = None) -> dict[str, list[str]]:
    """``goes_with`` for one project."""
    return goes_with([project_id], state_dir=state_dir, stores=stores)[str(project_id)]


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
        if (store.root / folder).is_symlink():
            continue  # a linked side folder may be another store's
        (store.root / folder / f"{asset_id}.json").unlink(missing_ok=True)


def _delete_live(store: AssetStore, project_id: str) -> list[dict[str, Any]]:
    removed: list[dict[str, Any]] = []
    for asset_id, path, _asset in _live_of(store, project_id):
        with store.lock(asset_id):
            # Read again under the lock: an update, move or delete since may
            # have changed or moved it.
            asset = _read(path)
            if asset is None or asset.get("projectId") != project_id:
                continue  # not provably this project's: left for the re-home
            path.unlink(missing_ok=True)
        _drop_side_files(store, asset_id)
        removed.append({"id": asset_id, "name": str(asset.get("name") or ""), "projectId": project_id})
    return removed


def _delete_trashed(store: AssetStore, project_id: str) -> list[dict[str, Any]]:
    trash = store.root / TRASH_DIR
    removed: list[dict[str, Any]] = []
    for asset_id, record_path, _record in _trashed_of(store, project_id):
        with store.lock(asset_id):
            # Read again under the lock: a restore (and a new delete of the
            # same id from elsewhere) may have replaced the record since.
            record = _read(record_path)
            if not _record_names(record, project_id) or not (trash / f"{asset_id}.json").is_file():
                continue
            # The file, then its record (a record without its file is
            # ignored by the trash, services/asset_trash.py).
            (trash / f"{asset_id}.json").unlink(missing_ok=True)
            record_path.unlink(missing_ok=True)
        _drop_side_files(store, asset_id)
        removed.append({"id": asset_id, "name": str(record.get("name") or ""), "projectId": project_id})
    return removed


def delete_store_assets(store: AssetStore, project_id: str, *, keep: Container[str]) -> list[dict[str, Any]]:
    """Delete project ``project_id``'s assets in one store (live and trashed)
    and return ``{id, name, projectId}`` for each. ``keep`` is every project
    the catalog still has: one of those is never touched (ValueError). OSError
    propagates; what was deleted stays deleted and the caller retries the rest.
    The caller decides the store is the catalog's (``paired_stores``)."""
    if not _PROJECT_ID.fullmatch(project_id):
        raise ValueError(f"invalid project id: {project_id!r}")
    if project_id in keep:
        raise ValueError(f"project {project_id} is still in the catalog; what is filed under it stays")
    if not store.root.is_dir():
        return []
    removed: list[dict[str, Any]] = []
    for _round in range(_ROUNDS):
        went = _delete_live(store, project_id) + _delete_trashed(store, project_id)
        removed += went
        if not went:
            break
    folder = store.root / project_id
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


def _left(store: AssetStore, project_id: str) -> bool:
    """Whether the store still holds anything of the project's (live or trashed)."""
    return store.root.is_dir() and bool(_live_of(store, project_id) or _trashed_of(store, project_id))


def delete_project_assets(project_id: str, *, keep: Container[str], state_dir: Path,
                          stores: list[AssetStore] | None = None) -> tuple[bool, Removed]:
    """``delete_store_assets`` in every store that is the catalog's. Returns
    ``(complete, removed)``: ``complete`` is False when a store was skipped
    as not the catalog's, or when anything of the project's is still there
    after the last pass (a store busy the whole time); the id then stays on
    the list and the next purge, listing or start goes on. And what went, by kind."""
    paired, unpaired = paired_stores(state_dir, stores)
    removed = _empty_removed()
    for store in paired:
        removed[store.kind].extend(delete_store_assets(store, project_id, keep=keep))
    left = any(_left(store, project_id) for store in paired)
    return not unpaired and not left, removed


def finish(catalog: dict[str, Any], *, state_dir: Path,
           stores: list[AssetStore] | None = None) -> tuple[list[str], Removed]:
    """Delete what is filed under every project on the catalog's list, in the
    stores that are this catalog's (``state_dir`` is the folder holding the
    catalog's ``projects/``). Returns ``(done, removed)``: the project ids now
    finished (the caller takes them off the list and commits) and what went,
    by kind. A project whose files couldn't all be deleted, or that a store
    not beside this catalog may still hold, stays on the list."""
    keep = known_projects(catalog)
    stores = stores if stores is not None else default_stores()
    done: list[str] = []
    removed = _empty_removed()
    waiting = 0
    unpaired: list[AssetStore] = []
    for project_id in pending(catalog):
        if project_id in keep:
            done.append(project_id)  # back in the catalog: its files are its own again
            continue
        try:
            complete, went = delete_project_assets(project_id, keep=keep, state_dir=state_dir, stores=stores)
        except OSError as exc:
            logger.warning("A deleted project's moodboards, characters or styles weren't all removed (%s); "
                           "trying again later", type(exc).__name__)
            continue
        for kind, items in went.items():
            removed[kind].extend(items)
        if complete:
            done.append(project_id)
        else:
            waiting += 1
            unpaired = paired_stores(state_dir, stores)[1]
    if waiting:
        _log_unpaired(unpaired, waiting)
    return done, removed
