"""A project deleted for good takes its moodboards with it.

"Deleted for good" means gone (Justin, 2026-11-04): when a canvas project
leaves Recently deleted for good (Delete forever, Empty, or the 30-day expiry
in services/project_store.purge_expired_trash), the boards filed under it go
too, live or in the boards' own Recently deleted, with their side files
(``.notes``, Updates). Before this, the catalog entry went and the boards
stayed on disk, answering GET with a projectId no project had; the next start
then re-homed them to Global (services/asset_project_rehome.py).

What goes, per project ``P``:

    <board root>/P/<id>.json                     each board whose own projectId is P
    <board root>/.trash/<id>.json (+ record)     each trashed board deleted from P
    <board root>/.notes/<id>.json                its Updates, unless another copy of
                                                 that board id is still live or trashed

A board file that doesn't say it is P's (unreadable, or another projectId) is
left where it is: only what provably belonged to P goes. The board images
(``/api/outputs/...``) are never deleted: the output folder is shared by the
canvas, run history, other boards, Characters, Styles and Commons, and keeps
no record of who uses a file, so nothing here could prove an image is unused.
The Projects screen already says generated files stay either way.

Crash safety (a journal in the catalog itself). The catalog commit that drops
the project from the trash also adds its id to ``catalog["boardPurges"]``, in
one atomic write. Only after that commit are the boards deleted, and only
after they are gone is the id taken off the list (a second commit). So:

- a failure before the commit changes nothing: the project is still in
  Recently deleted with every board;
- a failure after it leaves the id on the list, and the next purge or the
  next start (``finish``) deletes what is left and then clears it;
- the start-up re-home treats an id on the list as a project's, never as an
  old-style folder to move to Global.

Already-orphaned boards (``sweep_orphans``): purges before this change left
boards behind. Once per install, at start-up, the boards whose project is in
neither the catalog, its trash nor the list above are deleted, under the same
rules. Only when it is provable: the catalog file exists and reads, it holds
at least one project (live or trashed), the board root sits beside the state
folder the catalog is in (so a backend pointed at another catalog never
sweeps the person's boards), the folder name is a catalog id (32 hex, what
project_store.make_project mints, so an old-style folder like
``nebula_nodes`` is left to the re-home) and the board itself names that
project. The count is logged, never a name.
"""
from __future__ import annotations

import json
import logging
import re
from collections.abc import Container, Iterable
from datetime import datetime, timezone
from pathlib import Path
from typing import Any

from services.asset_trash import RECORD_SUFFIX, TRASH_DIR

logger = logging.getLogger(__name__)

# The catalog key holding the ids of projects deleted for good whose boards
# may still be on disk.
PENDING_KEY = "boardPurges"
# A canvas project id as the catalog mints it (project_store._ID).
_PROJECT_ID = re.compile(r"^[a-f0-9]{32}$")
_BOARD_ID = re.compile(r"^[A-Za-z0-9_-]{1,64}$")
GLOBAL_DIR = "_global"
SWEEP_MARKER = "purged-project-boards.json"


# -- the journal (in the catalog) --------------------------------------------------

def note_purged(catalog: dict[str, Any], project_ids: Iterable[str]) -> None:
    """Record, in the catalog about to be committed, that these projects were
    deleted for good and their boards are to go."""
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


# -- deleting one project's boards ------------------------------------------------

def _read(path: Path) -> dict[str, Any] | None:
    try:
        value = json.loads(path.read_text(encoding="utf-8"))
    except (OSError, ValueError):
        return None
    return value if isinstance(value, dict) else None


def _board_copies(root: Path, board_id: str) -> int:
    """How many copies of board ``board_id`` are on disk: live in any scope
    folder, or in the trash."""
    count = 0
    for sub in root.iterdir():
        if not sub.is_dir():
            continue
        if sub.name.startswith(".") and sub.name != TRASH_DIR:
            continue
        if (sub / f"{board_id}.json").is_file():
            count += 1
    return count


def _drop_side_files(root: Path, board_id: str) -> None:
    """The board's side files (its Updates), unless another copy of the
    board id is still on disk: they are kept by id, so a copy filed elsewhere
    (a re-home that met a collision) shares them."""
    from services.moodboard_store import BOARD_SIDE_FOLDERS

    if _board_copies(root, board_id):
        return
    for folder in BOARD_SIDE_FOLDERS:
        (root / folder / f"{board_id}.json").unlink(missing_ok=True)


def delete_project_boards(root: Path, project_id: str, *, keep: Container[str]) -> list[str]:
    """Delete project ``project_id``'s boards (live and trashed) and return
    their ids. ``keep`` is every project the catalog still has: one of those
    is never touched (ValueError), whatever asked. OSError propagates; what
    was deleted before it stays deleted and the caller retries the rest."""
    from services.moodboard_store import _board_lock

    if not _PROJECT_ID.fullmatch(project_id):
        raise ValueError(f"not a project id: {project_id!r}")
    if project_id in keep:
        raise ValueError(f"project {project_id} is still in the catalog; its boards stay")
    if not root.is_dir():
        return []
    removed: list[str] = []
    # Trashed boards deleted from this project: the file, then its record (a
    # record without its file is ignored by the trash, services/asset_trash.py).
    trash = root / TRASH_DIR
    if trash.is_dir():
        for record_path in sorted(trash.glob(f"*{RECORD_SUFFIX}")):
            board_id = record_path.name[: -len(RECORD_SUFFIX)]
            if not _BOARD_ID.fullmatch(board_id):
                continue
            record = _read(record_path)
            if record is None or record.get("projectId") != project_id or record.get("scopeDir") != project_id:
                continue
            with _board_lock(board_id):
                (trash / f"{board_id}.json").unlink(missing_ok=True)
                record_path.unlink(missing_ok=True)
            _drop_side_files(root, board_id)
            removed.append(board_id)
    folder = root / project_id
    if folder.is_dir() and not folder.is_symlink():
        for path in sorted(folder.glob("*.json")):
            board_id = path.stem
            if not _BOARD_ID.fullmatch(board_id):
                continue
            with _board_lock(board_id):
                board = _read(path)
                if board is None or board.get("projectId") != project_id:
                    continue  # not provably this project's: left for the re-home
                path.unlink(missing_ok=True)
            _drop_side_files(root, board_id)
            removed.append(board_id)
        for partial in folder.glob("*.json.tmp"):  # a board write a crash cut short
            partial.unlink(missing_ok=True)
        try:
            folder.rmdir()  # only when nothing is left in it
        except OSError:
            pass
    return removed


def finish(root: Path, catalog: dict[str, Any]) -> tuple[list[str], list[str]]:
    """Delete the boards of every project on the catalog's list. Returns
    ``(done, removed)``: the project ids now finished (the caller takes them
    off the list and commits) and the board ids deleted. A project whose
    boards couldn't all be deleted stays on the list, logged, for next time."""
    keep = known_projects(catalog)
    done: list[str] = []
    removed: list[str] = []
    for project_id in pending(catalog):
        if project_id in keep:
            done.append(project_id)  # back in the catalog: its boards are its own again
            continue
        try:
            removed.extend(delete_project_boards(root, project_id, keep=keep))
        except OSError as exc:
            logger.warning("A deleted project's boards weren't all removed (%s); trying again later",
                           type(exc).__name__)
            continue
        done.append(project_id)
    return done, removed


# -- boards already orphaned -------------------------------------------------------

def roots_paired(state_dir: Path, board_root: Path) -> bool:
    """Whether the board root belongs with the catalog under ``state_dir``:
    ``~/.nebula`` holds both (``~/.nebula/moodboards``), or the desktop app's
    data folder holds them side by side (``<data>/state``, ``<data>/moodboards``)."""
    try:
        state = state_dir.resolve()
        parent = board_root.resolve().parent
    except OSError:
        return False
    return parent == state or (state.name == "state" and parent == state.parent)


def orphaned_project_ids(root: Path, catalog: dict[str, Any]) -> list[str]:
    """Catalog-shaped project ids that boards are filed under (live, or in the
    trash) and that the catalog no longer has, open, trashed or on its list."""
    known = known_projects(catalog) | set(pending(catalog))
    found: set[str] = set()
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


def sweep_orphans(root: Path, catalog: dict[str, Any] | None, *, state_dir: Path) -> dict[str, Any]:
    """Once per install: delete the boards of projects deleted for good before
    boards went with them. ``catalog`` is None when there is no catalog file.
    Returns ``{status, boards}``; writes the marker only once it has run."""
    marker = state_dir / "migrations" / SWEEP_MARKER
    if marker.exists():
        return {"status": "done before", "boards": 0}
    if catalog is None:
        return {"status": "skipped: no project catalog yet", "boards": 0}
    if not known_projects(catalog):
        return {"status": "skipped: the catalog has no projects", "boards": 0}
    if not roots_paired(state_dir, root):
        return {"status": "skipped: the board folder isn't this catalog's", "boards": 0}
    keep = known_projects(catalog)
    removed: list[str] = []
    for project_id in orphaned_project_ids(root, catalog):
        removed.extend(delete_project_boards(root, project_id, keep=keep))
    marker.parent.mkdir(parents=True, exist_ok=True)
    tmp = marker.with_name(marker.name + ".tmp")
    tmp.write_text(json.dumps({"version": 1, "sweptAt": datetime.now(timezone.utc).isoformat(),
                               "boards": len(removed)}), encoding="utf-8")
    tmp.replace(marker)
    logger.info("Boards left by projects deleted for good earlier: %d removed", len(removed))
    return {"status": "done", "boards": len(removed)}
