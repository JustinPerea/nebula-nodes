"""Records as plain files in a folder the person names.

Layout: ``<folder>/<id>/record.json``, ``rendering.png`` and ``source.<ext>``.

The folder must already exist and be a directory. It can't be, or sit inside,
the Nebula state folder (``~/.nebula``, or ``NEBULA_STATE_DIR`` when set) or
this repo's own tree. A record directory or file that is a symlink is refused,
and every path read or written is checked to stay inside the folder's real
path. Files are written to a temporary name in the same directory and moved
into place with ``os.replace``, with ``record.json`` last, so a record whose
``record.json`` exists is complete.
"""
from __future__ import annotations

import copy
import json
import os
import re
import stat
import tempfile
from pathlib import Path
from typing import Any, Iterable

from extraction import record as rec
from extraction.errors import StoreRefused

SOURCE_EXTS = ("jpg", "png", "gif", "webp", "heic")
MAX_RECORD_BYTES = 5 * 1024 * 1024
_PNG = b"\x89PNG\r\n\x1a\n"
_DIR_NAME = re.compile(r"^ex_[0-9a-f]{16}$")
REPO_ROOT = Path(__file__).resolve().parents[2]


# -- folder safety ----------------------------------------------------------------------------


def _forbidden_roots() -> list[tuple[str, Path]]:
    roots: list[tuple[str, Path]] = []
    homes = {Path.home()}
    try:
        import pwd
        homes.add(Path(pwd.getpwuid(os.getuid()).pw_dir))
    except (ImportError, KeyError, OSError):
        pass
    for home in homes:
        roots.append(("Nebula's own state folder", (home / ".nebula").resolve()))
    state = os.environ.get("NEBULA_STATE_DIR")
    if state:
        roots.append(("Nebula's own state folder", Path(state).resolve()))
    roots.append(("the Nebula source folder", REPO_ROOT.resolve()))
    return roots


def _inside(path: str, root: Path) -> bool:
    try:
        return os.path.commonpath([path, str(root)]) == str(root)
    except ValueError:
        return False


def resolve_folder(folder: str | os.PathLike[str]) -> str:
    """The folder's real path, or ``StoreRefused`` saying why it can't be used."""
    raw = os.path.expanduser(os.fspath(folder))
    if not raw or "\0" in raw:
        raise StoreRefused("Name a folder for the records.")
    real = os.path.realpath(raw)
    if not os.path.exists(real):
        raise StoreRefused("That folder doesn't exist. Create it first, then try again.")
    if not os.path.isdir(real):
        raise StoreRefused("That path is a file, not a folder.")
    for label, root in _forbidden_roots():
        if _inside(real, root):
            raise StoreRefused(f"That folder is inside {label}. Pick a folder of your own.")
    return real


def _contained(path: str, root: str) -> str:
    real = os.path.realpath(path)
    if not _inside(real, Path(root)):
        raise StoreRefused("That path leads outside the records folder.")
    return real


def _record_dir(folder_real: str, record_id: str) -> str:
    if not _DIR_NAME.match(record_id):
        raise StoreRefused("That isn't a record id.")
    path = os.path.join(folder_real, record_id)
    if os.path.islink(path):
        raise StoreRefused("That record's folder is a symlink, so it won't be used.")
    return path


def _atomic_write(directory: str, name: str, data: bytes) -> None:
    final = os.path.join(directory, name)
    if os.path.islink(final):
        raise StoreRefused(f"{name} is a symlink, so it won't be overwritten.")
    _contained(final, directory)
    fd, tmp = tempfile.mkstemp(dir=directory, prefix=".tmp-")
    try:
        with os.fdopen(fd, "wb") as handle:
            handle.write(data)
            handle.flush()
            os.fsync(handle.fileno())
        os.chmod(tmp, 0o644)
        os.replace(tmp, final)
    except BaseException:
        try:
            os.unlink(tmp)
        except OSError:
            pass
        raise


def _dump(record: dict[str, Any]) -> bytes:
    return (json.dumps(record, indent=2, ensure_ascii=False, sort_keys=False) + "\n").encode("utf-8")


# -- reading ----------------------------------------------------------------------------------


def _read_record_file(directory: str) -> dict[str, Any]:
    path = os.path.join(directory, "record.json")
    try:
        info = os.lstat(path)
    except FileNotFoundError:
        raise StoreRefused("There's no record.json there.") from None
    if stat.S_ISLNK(info.st_mode):
        raise StoreRefused("That record.json is a symlink, so it won't be read.")
    if not stat.S_ISREG(info.st_mode):
        raise StoreRefused("That record.json isn't a regular file.")
    if info.st_size > MAX_RECORD_BYTES:
        raise StoreRefused("That record.json is too large to read.")
    _contained(path, directory)
    try:
        with open(path, "rb") as handle:
            record = json.loads(handle.read(MAX_RECORD_BYTES + 1))
    except (OSError, ValueError):
        raise StoreRefused("That record.json couldn't be read as JSON.") from None
    try:
        rec.validate(record)
    except rec.RecordInvalid as exc:
        raise StoreRefused(str(exc)) from None
    if os.path.basename(directory) != record["id"]:
        raise StoreRefused("That record's folder name doesn't match its id.")
    return record


def _locate(target: str | os.PathLike[str]) -> str:
    """The record directory (real path, checked) for a record dir or a record.json path."""
    raw = os.path.expanduser(os.fspath(target))
    if os.path.basename(raw) == "record.json":
        raw = os.path.dirname(raw) or "."
    raw = raw.rstrip("/") or "/"
    if os.path.islink(raw):
        raise StoreRefused("That record's folder is a symlink, so it won't be used.")
    parent = resolve_folder(os.path.dirname(os.path.abspath(raw)))
    name = os.path.basename(os.path.abspath(raw))
    directory = _record_dir(parent, name)
    if not os.path.isdir(directory):
        raise StoreRefused("That isn't a record folder.")
    return directory


def load(target: str | os.PathLike[str]) -> dict[str, Any]:
    """Read a record from its folder or its record.json."""
    return _read_record_file(_locate(target))


def list_records(folder: str | os.PathLike[str]) -> list[dict[str, Any]]:
    """One summary per record in ``folder``, newest read first. A record folder that can't
    be read is listed with an ``error`` instead of being skipped."""
    real = resolve_folder(folder)
    rows: list[dict[str, Any]] = []
    with os.scandir(real) as entries:
        names = sorted(e.name for e in entries if _DIR_NAME.match(e.name))
    for name in names:
        directory = os.path.join(real, name)
        try:
            if os.path.islink(directory):
                raise StoreRefused("That record's folder is a symlink, so it won't be used.")
            record = _read_record_file(directory)
        except StoreRefused as exc:
            rows.append({"id": name, "error": str(exc)})
            continue
        rows.append(summary(record))
    rows.sort(key=lambda r: (r.get("read_at") or "", r["id"]), reverse=True)
    return rows


def summary(record: dict[str, Any]) -> dict[str, Any]:
    palette = record["structure"]["measured"].get("palette") or []
    return {
        "id": record["id"], "status": record["status"], "name": record["source"].get("name"),
        "width": record["rendering"]["width"], "height": record["rendering"]["height"],
        "colors": len(palette), "accents": sum(1 for p in palette if p.get("is_accent")),
        "corrections": len(record["corrections"]), "read_at": record["source"]["read_at"],
    }


# -- writing ----------------------------------------------------------------------------------


def save(record: dict[str, Any], rendering_png: bytes, source_bytes: bytes, source_ext: str,
         folder: str | os.PathLike[str], *, replace: bool = False) -> dict[str, Any]:
    """Write a record to ``<folder>/<id>/``.

    Saving an id that is already there keeps the existing record and its
    corrections and returns it with ``existed: True``. ``replace=True``
    writes the new measurement instead, keeping the corrections.

    Returns ``{"record", "dir", "existed"}``.
    """
    rec.validate(record)
    if source_ext not in SOURCE_EXTS:
        raise StoreRefused("The original's file type isn't one the store keeps.")
    if not rendering_png.startswith(_PNG):
        raise StoreRefused("The rendering isn't a PNG.")
    real = resolve_folder(folder)
    directory = _record_dir(real, record["id"])
    existing: dict[str, Any] | None = None
    if os.path.lexists(directory):
        if not os.path.isdir(directory):
            raise StoreRefused("A file with that record's name is in the way.")
        if os.path.lexists(os.path.join(directory, "record.json")):
            existing = _read_record_file(directory)
    if existing is not None and not replace:
        return {"record": existing, "dir": directory, "existed": True}
    to_write = copy.deepcopy(record)
    if existing is not None:
        if existing["status"] != "proposal":
            raise StoreRefused("That record is approved, so it won't be replaced.")
        to_write["corrections"] = existing["corrections"]
    if not os.path.isdir(directory):
        os.mkdir(directory)
    _contained(directory, real)
    if os.path.islink(directory):
        raise StoreRefused("That record's folder is a symlink, so it won't be used.")
    _atomic_write(directory, "rendering.png", rendering_png)
    _atomic_write(directory, f"source.{source_ext}", source_bytes)
    _atomic_write(directory, "record.json", _dump(to_write))
    return {"record": to_write, "dir": directory, "existed": existing is not None}


def write(target: str | os.PathLike[str], record: dict[str, Any]) -> None:
    """Rewrite an existing record's record.json atomically (after its corrections change)."""
    directory = _locate(target)
    rec.validate(record)
    if os.path.basename(directory) != record["id"]:
        raise StoreRefused("That record's folder name doesn't match its id.")
    _read_record_file(directory)  # the one there must be a good record
    _atomic_write(directory, "record.json", _dump(record))


def correct(target: str | os.PathLike[str], corrections: Iterable[dict[str, Any]], actor: str, *,
            clock: rec.Clock | None = None) -> dict[str, Any]:
    """Load a record, add corrections and save it. Returns the updated record.

    Not safe against two writers at once: the last rewrite wins.
    """
    directory = _locate(target)
    updated = rec.add_corrections(_read_record_file(directory), corrections, actor, clock=clock)
    write(directory, updated)
    return updated
