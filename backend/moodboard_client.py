"""Moodboards for agents: the client side `nebula moodboard` and the MCP server share.

Gap 3 in the design-canvas log: Moodboard Studio had no CLI or MCP, so an agent
uploaded each image and wrote the board JSON by hand. This module turns
sources into board images and edits boards through the routes Moodboard
Studio uses (`/api/uploads`, `/api/moodboards`). Nothing here runs in the
backend.

A source is one of:

- a local image file, read by this process with its own permissions
  (`require_allowed_path`). With an in-app chat's turn token, only files in
  that turn's workspace. The check runs again when the file is read, and the
  read follows no links, so a link swapped in between can't leave it.
- a folder: the images directly inside it, sorted by name the way a person
  reads them ("2.png" before "10.png"). Hidden files and subfolders are
  skipped. Each image is checked like a single file, so a link inside the
  folder can't reach past the workspace.
- an http(s) URL. This process downloads it (decision D6: the backend never
  fetches URLs for boards) through Commons' guarded fetcher (commons/net.py):
  public internet addresses only, checked on every redirect and connected to
  the address that was checked (so neither this computer, its network, nor a
  cloud metadata address), ports 80 and 443, no user name or password in the
  link, at most MAX_IMAGE_BYTES, an image content type only, and a time
  limit. The bytes then go through `/api/uploads` like a local file.
- a Nebula output URL (`/api/outputs/...`), such as a node's result, used as is.

Board edits follow Moodboard Studio: any change to images, notes, mode or
strength clears the saved analysis (it described the old board); a rename
keeps it, and so do the brief fields (Direction, Avoid, pinned colours, the
hand-written brief), which aren't analysis inputs, and so does an image's
private note (`privateNote`, the person's own label, which nothing that
generates ever sees). The brief generators get
is the backend's `brief` (services/moodboard_brief.compose), passed on as it
came, never rebuilt here from the analysis.
"""
from __future__ import annotations

import asyncio
import contextvars
import errno
import json
import math
import os
import re
import stat
from concurrent.futures import ThreadPoolExecutor
from pathlib import Path, PurePosixPath
from typing import Any, Callable, Coroutine, Iterable
from urllib.parse import quote, unquote, urlsplit

import httpx

from commons import net
from nebula_api import NebulaAPI, NebulaAPIError

# The backend's own cap for an uploaded image (MAX_CHAT_UPLOAD_BYTES).
MAX_IMAGE_BYTES = 20 * 1024 * 1024
# One download may take this long in all, redirects included.
DOWNLOAD_SECONDS = 60.0
MODES = ("look", "world", "subject")
# The image types /api/uploads accepts, by content type and by file name.
IMAGE_TYPES = {"image/png": ".png", "image/jpeg": ".jpg", "image/gif": ".gif", "image/webp": ".webp"}
IMAGE_SUFFIXES = {".png", ".jpg", ".jpeg", ".gif", ".webp"}
_ACCEPT = ",".join(IMAGE_TYPES)
_BOARD_ID = re.compile(r"^[A-Za-z0-9_-]{1,64}$")


class MoodboardError(ValueError):
    """Something the caller asked for that can't be done, said as the next step.

    `previous` is set when part of the call was saved before it failed: the
    settings that put the board back, as update_board returns them, for the
    board `board_id`."""

    def __init__(self, message: str, *, previous: dict[str, Any] | None = None,
                 board_id: str | None = None) -> None:
        super().__init__(message)
        self.previous = previous
        self.board_id = board_id


def sniff_image(data: bytes) -> str | None:
    """The content type of PNG, JPEG, GIF or WebP bytes, else None."""
    if data.startswith(b"\x89PNG\r\n\x1a\n"):
        return "image/png"
    if data.startswith(b"\xff\xd8\xff"):
        return "image/jpeg"
    if data.startswith((b"GIF87a", b"GIF89a")):
        return "image/gif"
    if len(data) >= 12 and data[:4] == b"RIFF" and data[8:12] == b"WEBP":
        return "image/webp"
    return None


def _natural_key(name: str) -> list[Any]:
    return [int(part) if part.isdigit() else part for part in re.split(r"(\d+)", name.casefold())]


def folder_images(folder: Path) -> list[Path]:
    """The image files directly inside `folder`, in name order ("2" before "10")."""
    files = [
        child for child in folder.iterdir()
        if not child.name.startswith(".") and child.suffix.lower() in IMAGE_SUFFIXES and child.is_file()
    ]
    return sorted(files, key=lambda child: _natural_key(child.name))


# -- downloads -----------------------------------------------------------------

def _check_web_url(url: str) -> None:
    parts = urlsplit(url)
    if parts.scheme not in ("http", "https") or not parts.hostname:
        raise MoodboardError(f"{url}: only http and https links can be added")


def _run(coroutine: Coroutine[Any, Any, Any]) -> Any:
    """Run a coroutine from sync code, also when this thread already runs an
    event loop (FastMCP calls sync tools on its loop)."""
    try:
        asyncio.get_running_loop()
    except RuntimeError:
        return asyncio.run(coroutine)
    with ThreadPoolExecutor(max_workers=1) as pool:
        return pool.submit(contextvars.copy_context().run, asyncio.run, coroutine).result()


def download_image(url: str, *, transport: httpx.AsyncBaseTransport | None = None,
                   resolver: Callable[[str, int], Any] | None = None) -> tuple[str, bytes, str]:
    """Download one image: (file name, bytes, content type), through
    `commons.net.safe_fetch`, the fetcher Commons uses for links. It refuses
    any address off the public internet (this computer, its local network,
    link-local addresses such as cloud metadata) on every redirect, connects
    to the address it checked, and allows ports 80 and 443 only. Here we add:
    an image content type and image bytes, at most MAX_IMAGE_BYTES, and
    DOWNLOAD_SECONDS for the whole download. `transport` and `resolver` are
    for tests."""
    _check_web_url(url)
    mb = MAX_IMAGE_BYTES // (1024 * 1024)
    fetch = net.safe_fetch(url, max_bytes=MAX_IMAGE_BYTES, accept=_ACCEPT,
                           resolver=resolver or net.resolve_pinned, transport=transport)
    try:
        fetched = _run(asyncio.wait_for(fetch, DOWNLOAD_SECONDS))
    except net.BlockedAddress as exc:
        raise MoodboardError(f"{url}: the link leads to this computer or a private network ({exc}), which "
                             "Nebula never downloads from. Save the image and add the file instead.") from exc
    except net.FetchBlocked as exc:
        raise MoodboardError(f"{url}: Nebula won't download this link ({exc}). Only public http and https "
                             "links on ports 80 and 443 work; for anything else, save the image and add "
                             "the file.") from exc
    except net.FetchTooLarge as exc:
        raise MoodboardError(f"{url}: the image is over {mb} MB") from exc
    except net.FetchStatus as exc:
        raise MoodboardError(f"{url}: the server answered {exc.status}") from exc
    except net.FetchError as exc:
        raise MoodboardError(f"{url}: the download failed ({exc})") from exc
    except TimeoutError as exc:  # asyncio.wait_for
        raise MoodboardError(f"{url}: the download took over {DOWNLOAD_SECONDS:.0f} seconds") from exc
    except httpx.TimeoutException as exc:
        raise MoodboardError(f"{url}: the download timed out") from exc
    except httpx.HTTPError as exc:
        raise MoodboardError(f"{url}: the download failed ({exc})") from exc
    content_type = fetched.content_type.split(";")[0].strip().lower()
    if content_type not in IMAGE_TYPES:
        shown = content_type or "no content type"
        raise MoodboardError(f"{url}: not an image ({shown}). Link to the image itself, not the page it's on.")
    sniffed = sniff_image(fetched.data)
    if sniffed is None:
        raise MoodboardError(f"{url}: the file isn't a PNG, JPEG, GIF or WebP image")
    stem = PurePosixPath(unquote(urlsplit(fetched.final_url).path)).stem or "image"
    name = re.sub(r"[^A-Za-z0-9._-]", "-", stem)[:80] + IMAGE_TYPES[sniffed]
    return name, fetched.data, sniffed


# -- sources -> board image urls ---------------------------------------------

def _local_path(source: str) -> Path:
    from services.agent_workspaces import active_workspace
    from services.file_access import ProtectedPathError, require_allowed_path

    workspace = active_workspace()
    raw = source
    if raw.lower().startswith("file:"):
        parts = urlsplit(raw)
        if parts.netloc not in ("", "localhost") or parts.query or parts.fragment:
            raise MoodboardError(f"{source}: not a local file link")
        raw = unquote(parts.path)
    path = Path(raw).expanduser()
    if workspace is not None and not path.is_absolute():
        # An in-app agent's relative path means its workspace, not this process's cwd.
        path = workspace / path
    try:
        resolved = require_allowed_path(path)
    except ProtectedPathError as exc:
        raise MoodboardError(f"{source}: {exc}") from exc
    if workspace is not None:
        # Same rule as Commons: a chat's turn (the only caller with a
        # workspace scope) reads only its own files.
        if not resolved.is_relative_to(workspace.resolve()):
            raise MoodboardError(f"{source}: outside this chat's workspace. Copy the image there first, "
                                 "or add it by URL.")
    return resolved


_NO_FOLLOW = getattr(os, "O_NOFOLLOW", 0)
_CLOEXEC = getattr(os, "O_CLOEXEC", 0)


def _open_no_follow(path: Path) -> int:
    """Open a resolved path for reading, one folder at a time, following no
    links: a link put in place since the path was checked fails the open
    instead of leading somewhere else. Where the OS can't do this (no
    O_NOFOLLOW or dir_fd), a plain open of the path just checked."""
    if not _NO_FOLLOW or os.open not in os.supports_dir_fd:
        return os.open(path, os.O_RDONLY | _CLOEXEC)
    folder = os.open(path.anchor, os.O_RDONLY | os.O_DIRECTORY | _CLOEXEC)
    try:
        for part in path.parts[1:-1]:
            inner = os.open(part, os.O_RDONLY | os.O_DIRECTORY | _NO_FOLLOW | _CLOEXEC, dir_fd=folder)
            os.close(folder)
            folder = inner
        return os.open(path.name, os.O_RDONLY | _NO_FOLLOW | _CLOEXEC, dir_fd=folder)
    finally:
        os.close(folder)


def _read_local_image(path: Path, shown: str) -> tuple[str, bytes, str]:
    # Check again at read time: the same rules as when the source was named
    # (protected storage, and an in-app turn's workspace), on the path as it
    # resolves now.
    path = _local_path(str(path))
    mb = MAX_IMAGE_BYTES // (1024 * 1024)
    try:
        descriptor = _open_no_follow(path)
    except OSError as exc:
        if exc.errno in (errno.ELOOP, errno.ENOTDIR):
            raise MoodboardError(f"{shown}: the file changed while it was being read (a link took its place). "
                                 "Add it again.") from exc
        raise MoodboardError(f"{shown}: can't read the file ({exc.strerror})") from exc
    with os.fdopen(descriptor, "rb") as handle:
        info = os.fstat(handle.fileno())
        if not stat.S_ISREG(info.st_mode):
            raise MoodboardError(f"{shown}: not a file")
        if info.st_size > MAX_IMAGE_BYTES:
            raise MoodboardError(f"{shown}: the image is over {mb} MB")
        data = handle.read(MAX_IMAGE_BYTES + 1)
    if len(data) > MAX_IMAGE_BYTES:
        raise MoodboardError(f"{shown}: the image is over {mb} MB")
    content_type = sniff_image(data)
    if content_type is None:
        raise MoodboardError(f"{shown}: not a PNG, JPEG, GIF or WebP image")
    return path.name, data, content_type


def _upload(api: NebulaAPI, headers: dict[str, str], name: str, data: bytes, content_type: str) -> str:
    result = api.request("POST", "/api/uploads", headers=headers, timeout=120.0,
                         files={"file": (name, data, content_type)}, data={"create_node": "false"})
    url = result.get("url") if isinstance(result, dict) else None
    if not isinstance(url, str) or not url:
        raise MoodboardError(f"{name}: Nebula didn't return a URL for the upload")
    return url


def _check_output_url(api: NebulaAPI, headers: dict[str, str], url: str) -> str:
    path = urlsplit(url).path
    try:
        response = api.send("GET", quote(path, safe="/%"), headers=headers, timeout=60.0)
    except NebulaAPIError as exc:
        if exc.status is None:
            raise
        raise MoodboardError(f"{url}: Nebula has no such output ({exc.status})") from exc
    if sniff_image(response.content[:16]) is None:
        raise MoodboardError(f"{url}: that output isn't an image")
    return path


def expand_sources(sources: Iterable[str]) -> list[tuple[str, str]]:
    """Each source as (kind, value): ("file", path), ("url", url) or ("output", url).
    Folders expand to their images here, so a bad source fails before any upload."""
    expanded: list[tuple[str, str]] = []
    for raw in sources:
        source = str(raw).strip()
        if not source:
            continue
        lowered = source.lower()
        if lowered.startswith(("http://", "https://")):
            if urlsplit(source).path.startswith("/api/outputs/") and urlsplit(source).hostname in (
                "localhost", "127.0.0.1", "::1",
            ):
                expanded.append(("output", source))
            else:
                expanded.append(("url", source))
            continue
        if source.startswith("/api/outputs/"):
            expanded.append(("output", source))
            continue
        if ("://" in source and not lowered.startswith("file://")) or lowered.startswith(("data:", "blob:", "javascript:")):
            raise MoodboardError(f"{source}: only http and https links can be added")
        path = _local_path(source)
        if path.is_dir():
            images = folder_images(path)
            if not images:
                raise MoodboardError(f"{source}: no PNG, JPEG, GIF or WebP images in this folder")
            # Each image passes the same checks as a file named on its own:
            # a link in the folder can't lead past protected storage or the
            # chat's workspace.
            expanded.extend(("file", str(_local_path(str(image)))) for image in images)
        elif path.is_file():
            expanded.append(("file", str(path)))
        else:
            raise MoodboardError(f"{source}: no such file or folder")
    return expanded


def source_urls(api: NebulaAPI, sources: Iterable[str], *, headers: dict[str, str] | None = None,
                transport: httpx.AsyncBaseTransport | None = None) -> list[str]:
    """Board image URLs for `sources`, in order. Downloads and reads everything
    first, then uploads, so one bad source leaves Nebula untouched."""
    headers = dict(headers or {})
    expanded = expand_sources(sources)
    if not expanded:
        return []
    staged: list[tuple[str, Any]] = []
    for kind, value in expanded:
        if kind == "file":
            staged.append(("bytes", _read_local_image(Path(value), value)))
        elif kind == "url":
            staged.append(("bytes", download_image(value, transport=transport)))
        else:
            staged.append(("output", _check_output_url(api, headers, value)))
    urls: list[str] = []
    for kind, item in staged:
        urls.append(_upload(api, headers, *item) if kind == "bytes" else item)
    return urls


# -- boards ----------------------------------------------------------------------

def list_boards(api: NebulaAPI, *, project: str | None = None, include_global: bool = True,
                headers: dict[str, str] | None = None) -> list[dict[str, Any]]:
    boards: list[dict[str, Any]] = []
    if include_global:
        boards.extend(api.request("GET", "/api/moodboards", params={"scope": "global"}, headers=headers))
    if project:
        boards.extend(api.request("GET", "/api/moodboards", params={"scope": "project", "projectId": project},
                                  headers=headers))
    return boards


def active_project(api: NebulaAPI, headers: dict[str, str] | None = None) -> str | None:
    listing = api.request("GET", "/api/projects", headers=headers)
    active = listing.get("activeProjectId") if isinstance(listing, dict) else None
    return active if isinstance(active, str) and active else None


def project_names(api: NebulaAPI, headers: dict[str, str] | None = None) -> dict[str, tuple[str, bool]]:
    """Canvas project id -> (name, in Recently deleted), for labels. Empty
    when the listing can't be read: callers fall back to the id."""
    try:
        listing = api.request("GET", "/api/projects", headers=headers)
    except NebulaAPIError:
        return {}
    names: dict[str, tuple[str, bool]] = {}
    if not isinstance(listing, dict):
        return names
    for key, trashed in (("projects", False), ("trash", True)):
        for project in listing.get(key) or []:
            if isinstance(project, dict) and isinstance(project.get("id"), str):
                names[project["id"]] = (str(project.get("name") or "Untitled project"), trashed)
    return names


def resolve_project(api: NebulaAPI, project: str | None, headers: dict[str, str] | None = None) -> str | None:
    """None for a board in no project; "current" means the project open on the canvas."""
    if project is None or project == "":
        return None
    if project == "current":
        active = active_project(api, headers)
        if active is None:
            raise MoodboardError("no project is open on the canvas")
        return active
    return project


MOVE_UNSUPPORTED = ("this version of Nebula can't move {noun}s between projects, so nothing was moved. "
                    "Update Nebula to use it.")


def resolve_move_target(api: NebulaAPI, to: str | None,
                        headers: dict[str, str] | None = None) -> tuple[str | None, str]:
    """Where `--to` / `to` points: ``(project id, its name)``, or ``(None,
    "Global")``. "global" is Global and "current" the project open on the
    canvas; anything else is a canvas project's id, else its exact name
    (case-insensitive). Refuses, saying what to do: no project open, a project
    in Recently deleted, an unknown one, or a name two projects share."""
    ref = str(to or "").strip()
    if not ref:
        raise MoodboardError("say where to move it: global, current, or a project's id or exact name "
                             "(`nebula projects`)")
    if ref.casefold() == "global":
        return None, "Global"
    listing = api.request("GET", "/api/projects", headers=headers)
    listing = listing if isinstance(listing, dict) else {}
    live = [p for p in listing.get("projects") or [] if isinstance(p, dict) and isinstance(p.get("id"), str)]
    trashed = [p for p in listing.get("trash") or [] if isinstance(p, dict) and isinstance(p.get("id"), str)]

    def named(project: dict[str, Any]) -> str:
        return str(project.get("name") or "Untitled project")

    if ref.casefold() == "current":
        active = listing.get("activeProjectId")
        for project in live:
            if project["id"] == active:
                return project["id"], named(project)
        raise MoodboardError("no project is open on the canvas, so there is no current project. Open one "
                             "(`nebula project open <id>`), or name one with --to <id or name>")
    for project in live:
        if project["id"] == ref:
            return project["id"], named(project)
    gone = [p for p in trashed if p["id"] == ref or named(p).casefold() == ref.casefold()]
    matches = [p for p in live if named(p).casefold() == ref.casefold()]
    if len(matches) == 1:
        return matches[0]["id"], named(matches[0])
    if len(matches) > 1:
        ids = ", ".join(p["id"] for p in matches)
        raise MoodboardError(f"{len(matches)} projects are named “{named(matches[0])}” ({ids}); use the id")
    if gone:
        raise MoodboardError(f"the project “{named(gone[0])}” is in Recently deleted. Restore it first "
                             f"(`nebula trash restore project {gone[0]['id']}`), or move it to global")
    raise MoodboardError(f"no project “{ref}” (`nebula projects` lists them; or use global or current)")


def move_asset(api: NebulaAPI, kind: str, asset: dict[str, Any], to: str | None,
               headers: dict[str, str] | None = None) -> dict[str, Any]:
    """POST /api/{kind}s/{id}/move for an asset already looked up. Returns
    the backend's answer: ``status`` ("moved" or "unchanged"), ``from`` /
    ``to`` (project ids, None for Global) with ``fromName`` / ``toName``,
    ``movedBy`` and ``asset``."""
    target, _name = resolve_move_target(api, to, headers)
    noun = "board" if kind == "moodboard" else "Character"
    try:
        result = api.request("POST", f"/api/{kind}s/{asset['id']}/move", json={"projectId": target},
                             headers=headers)
    except NebulaAPIError as exc:
        if exc.status == 405 or (exc.status == 404 and str(exc.detail).strip() == "Not Found"):
            raise MoodboardError(MOVE_UNSUPPORTED.format(noun=noun)) from exc
        if exc.status in (400, 404, 409, 422):
            raise MoodboardError(str(exc.detail)) from exc
        raise
    return result if isinstance(result, dict) else {}


def asset_for_move(api: NebulaAPI, kind: str, ref: str, find_by_name: Any,
                   headers: dict[str, str] | None = None) -> dict[str, Any]:
    """The live asset `ref` names (id, else exact name via `find_by_name`).
    An id in Recently deleted is refused with the backend's own restore
    advice, rather than "no such board"."""
    ref = str(ref or "").strip()
    if _BOARD_ID.fullmatch(ref):
        try:
            return api.request("GET", f"/api/{kind}s/{ref}", headers=headers)
        except NebulaAPIError as exc:
            if exc.status != 404:
                raise
            if "Recently deleted" in str(exc.detail):
                raise MoodboardError(f"{exc.detail} Then move it.") from exc
    return find_by_name(api, ref, headers)


def move_board(api: NebulaAPI, ref: str, to: str | None,
               headers: dict[str, str] | None = None) -> dict[str, Any]:
    """Move a board (id or exact name) to Global or a canvas project (see
    resolve_move_target). Anyone may, agents included: moving it back undoes
    it. Nodes that use the board keep working in every project."""
    return move_asset(api, "moodboard", asset_for_move(api, "moodboard", ref, get_board, headers), to, headers)


def get_board(api: NebulaAPI, ref: str, headers: dict[str, str] | None = None) -> dict[str, Any]:
    """A board by id, else by exact name (case-insensitive) across all boards."""
    ref = str(ref or "").strip()
    if not ref:
        raise MoodboardError("name a board by its id or name (`nebula moodboard list`)")
    if _BOARD_ID.fullmatch(ref):
        try:
            return api.request("GET", f"/api/moodboards/{ref}", headers=headers)
        except NebulaAPIError as exc:
            if exc.status != 404:
                raise
    listing = api.request("GET", "/api/projects", headers=headers)
    projects = [p.get("id") for p in (listing.get("projects") or []) if isinstance(p, dict) and p.get("id")]
    candidates = list_boards(api, headers=headers)
    for project_id in projects:
        candidates.extend(list_boards(api, project=project_id, include_global=False, headers=headers))
    matches = [board for board in candidates if str(board.get("name", "")).casefold() == ref.casefold()]
    if not matches:
        raise MoodboardError(f"no board “{ref}” (`nebula moodboard list` shows them)")
    if len(matches) > 1:
        ids = ", ".join(str(board.get("id")) for board in matches)
        raise MoodboardError(f"{len(matches)} boards are named “{ref}” ({ids}); use the id")
    # A list leaves out what only a board read gives (an old board's layout),
    # so read the one that matched.
    return api.request("GET", f"/api/moodboards/{matches[0]['id']}", headers=headers)


def _image_entry(url: str) -> dict[str, Any]:
    return {"url": url, "weight": 1.0, "notes": "", "excluded": False}


def _unique_new(existing: list[dict[str, Any]], urls: list[str]) -> tuple[list[str], int]:
    seen = {str(image.get("url")) for image in existing}
    fresh: list[str] = []
    for url in urls:
        if url not in seen:
            seen.add(url)
            fresh.append(url)
    return fresh, len(urls) - len(fresh)


def create_board(api: NebulaAPI, name: str, sources: Iterable[str] = (), *, project: str | None = None,
                 mode: str = "look", strength: float = 0.7, notes: str = "",
                 headers: dict[str, str] | None = None,
                 transport: httpx.AsyncBaseTransport | None = None) -> tuple[dict[str, Any], int]:
    """A new board with `sources`; returns (board, duplicates skipped)."""
    name = str(name or "").strip()
    if not name:
        raise MoodboardError("a board needs a name")
    if mode not in MODES:
        raise MoodboardError(f"mode must be one of {', '.join(MODES)}")
    _check_unit("strength", strength)
    project_id = resolve_project(api, project, headers)
    urls, skipped = _unique_new([], source_urls(api, sources, headers=headers, transport=transport))
    body = {"name": name, "images": [_image_entry(url) for url in urls], "notes": notes, "mode": mode,
            "strength": strength, "projectId": project_id}
    board = api.request("POST", "/api/moodboards", json=body, headers=headers)
    if len(board.get("images") or []) != len(urls):
        # Gap 7: a board once came back empty. Say so instead of reporting success.
        raise MoodboardError(f"Nebula saved {len(board.get('images') or [])} of {len(urls)} images on board "
                             f"{board.get('id')}; run `nebula moodboard add {board.get('id')} ...` again")
    return board, skipped


EDITS_UNSUPPORTED = ("this version of Nebula has no board edits (POST /api/moodboards/{id}/edits), so nothing "
                     "was changed. Update Nebula.")


def _edits_missing(exc: NebulaAPIError) -> bool:
    """Whether a refusal means the backend has no edits route at all (an
    older Nebula), as opposed to no such board."""
    return exc.status in (404, 405) and str(exc.detail).strip() in ("Not Found", "Method Not Allowed")


def edit_board(api: NebulaAPI, ref: str, ops: list[dict[str, Any]], *, base_version: int | None = None,
               say: str | None = None, headers: dict[str, str] | None = None) -> dict[str, Any]:
    """Send checked board edits (POST /api/moodboards/{id}/edits): the ops land
    together, or none do. Returns the route's answer: `board`, `version`,
    `applied` (one entry per op: applied or unchanged, and what a `restore`
    skipped) and `undo`, the ops that put the board back (pass them to this
    function again; a part that changed since is skipped and reported).

    `base_version` refuses the edit when the board was saved since that
    version (MoodboardError naming the version it is at); without it the
    ops apply to the board as it is, which suits absolute ops like these.
    `say` is your own words for what you did ("Moved #12 into Dither")."""
    board = get_board(api, ref, headers)
    body: dict[str, Any] = {"ops": ops}
    if base_version is not None:
        body["baseVersion"] = base_version
    if say:
        body["say"] = say
    try:
        return _send(api, "POST", f"/api/moodboards/{board['id']}/edits", json=body, headers=headers)
    except NebulaAPIError as exc:
        if exc.status == 409:
            current = re.search(r"at version (\d+)", str(exc.detail))
            at = f" (it is at version {current.group(1)})" if current else ""
            raise MoodboardError(f"the board changed since you read it{at}: read it again "
                                 f"(`nebula moodboard show {board['id']}`) and redo the change") from exc
        if _edits_missing(exc):
            raise MoodboardError(EDITS_UNSUPPORTED) from exc
        raise


CARD_HELP = "CARD is an image's number or id (when it has one card), a card id, or 12@<look>"


def _coordinate(text: str) -> int | float:
    value = float(text)
    if not math.isfinite(value):
        raise ValueError(text)
    return int(value) if value.is_integer() else value


def _place_op(item: str) -> dict[str, Any]:
    card, sep, at = item.partition("=")
    x, comma, y = at.partition(",")
    try:
        if not sep or not comma or not card.strip():
            raise ValueError(item)
        return {"op": "place", "placement": card.strip(), "x": _coordinate(x), "y": _coordinate(y)}
    except ValueError:
        raise MoodboardError(f"--place takes CARD=X,Y in board pixels, e.g. --place 12=200,40 ({CARD_HELP})") from None


def _resize_op(item: str) -> dict[str, Any]:
    card, sep, size = item.partition("=")
    width, by, height = size.strip().lower().partition("x")
    try:
        if not sep or not card.strip():
            raise ValueError(item)
        if by:
            w, h = _coordinate(width), _coordinate(height)
            return {"op": "resize", "placement": card.strip(), "w": w, "h": h}
        return {"op": "resize", "placement": card.strip(), "weight": float(size)}
    except ValueError:
        raise MoodboardError("--resize takes CARD=WEIGHT or CARD=WxH, e.g. --resize 12=0.6 or --resize 12=480x270 "
                             f"(the card keeps its aspect; {CARD_HELP})") from None


def _named_pair(item: str, flag: str, example: str) -> tuple[str, str]:
    left, sep, right = item.partition("=")
    if not sep or not left.strip() or not right.strip():
        raise MoodboardError(f"{flag} takes {example}")
    return left.strip(), right.strip()


def _card_of(board: dict[str, Any], ref: str) -> tuple[dict[str, Any], dict[str, Any]]:
    """The (image, card) `ref` names, as the edits route names a card: a card
    id, image@look, or an image (number or id) that has one card."""
    images = [image for image in board.get("images") or [] if isinstance(image, dict)]
    for image in images:
        for card in image.get("placements") or []:
            if isinstance(card, dict) and card.get("id") == ref:
                return image, card
    image_ref, at, frame_ref = ref.rpartition("@")
    image = images[find_image(images, image_ref if at else ref)]
    cards = [card for card in image.get("placements") or [] if isinstance(card, dict)]
    number = images.index(image) + 1
    if at:
        frames = [frame for frame in board.get("frames") or [] if isinstance(frame, dict)]
        frame = next((f for f in frames if f.get("id") == frame_ref), None) or next(
            (f for f in frames if str(f.get("name", "")).casefold() == frame_ref.casefold()), None)
        if frame is None:
            raise MoodboardError(f"no look “{frame_ref}” on this board")
        card = next((c for c in cards if c.get("frameId") == frame.get("id")), None)
        if card is None:
            raise MoodboardError(f"#{number} has no card in {frame.get('name')}")
        return image, card
    if len(cards) != 1:
        raise MoodboardError(f"#{number} has {len(cards)} cards: name one as {number}@<look>")
    return image, cards[0]


def edit_ops(board: dict[str, Any], *, place: Iterable[str] = (), resize: Iterable[str] = (),
             into: Iterable[str] = (), link: Iterable[str] = (), set_aside: Iterable[str] = (),
             use: Iterable[str] = (), note: Iterable[str] = (), private_note: Iterable[str] = ()
             ) -> list[dict[str, Any]]:
    """`nebula moodboard edit`'s flags as board-edit ops (contract 07, 1.12),
    the same ops moodboard_edit takes. `board` is the board as read: only
    `into` needs it, to know whether the card is loose (it joins the look)
    or in another look (a copy goes into the new one with the card's weight,
    and the old card goes, in the same batch)."""
    ops: list[dict[str, Any]] = [_place_op(item) for item in place]
    ops += [_resize_op(item) for item in resize]
    for item in into:
        card_ref, frame = _named_pair(item, "--in", f"CARD=LOOK, e.g. --in 12=Dither ({CARD_HELP})")
        image, card = _card_of(board, card_ref)
        if card.get("frameId") is None:
            ops.append({"op": "link", "image": str(image.get("id")), "frameId": frame})
        else:
            ops += [{"op": "link", "image": str(image.get("id")), "frameId": frame,
                     "weight": card.get("weight") or 1.0},
                    {"op": "unlink", "placement": str(card.get("id"))}]
    for item in link:
        image_ref, frame = _named_pair(item, "--link", "IMAGE=LOOK, e.g. --link 12=Glass (a copy in that look)")
        ops.append({"op": "link", "image": image_ref, "frameId": frame})
    both = sorted(set(set_aside) & set(use))
    if both:
        raise MoodboardError(f"--set-aside and --use both name image {', '.join(both)}: pick one")
    ops += [{"op": "setAside", "image": str(ref).strip(), "value": True} for ref in set_aside]
    ops += [{"op": "setAside", "image": str(ref).strip(), "value": False} for ref in use]
    for flag, key, items in (("--note", "notes", note), ("--private-note", "privateNote", private_note)):
        for item in items:
            image_ref, sep, text = item.partition("=")
            if not sep or not image_ref.strip():
                raise MoodboardError(f"{flag} takes IMAGE=TEXT, e.g. {flag} 3=\"the orange accent\"")
            ops.append({"op": "note", "image": image_ref.strip(), key: text})
    return ops


def undo_ops(data: Any) -> list[dict[str, Any]]:
    """The ops of an undo, from what an edit printed or returned: its whole
    answer (`edit --json`, `add --json`, moodboard_edit), its `undo`, or the
    ops themselves."""
    if isinstance(data, dict) and isinstance(data.get("undo"), dict):
        data = data["undo"]
    if isinstance(data, dict) and "ops" in data:
        data = data["ops"]
    if isinstance(data, list) and not data:
        raise MoodboardError("that edit changed nothing, so there is nothing to undo")
    if not isinstance(data, list) or not all(isinstance(op, dict) for op in data):
        raise MoodboardError("--undo takes what `nebula moodboard edit --json` (or `add --json`) printed, "
                             "or its `undo`")
    return data


def skipped_messages(result: dict[str, Any]) -> list[str]:
    """What a restore left as it was, in the route's words ("#2 changed since, left as is")."""
    return [str(item.get("message")) for entry in result.get("applied") or [] if isinstance(entry, dict)
            for item in entry.get("skipped") or [] if isinstance(item, dict) and item.get("message")]


def add_to_board(api: NebulaAPI, ref: str, sources: Iterable[str], *, headers: dict[str, str] | None = None,
                 transport: httpx.AsyncBaseTransport | None = None
                 ) -> tuple[dict[str, Any], int, int, dict[str, Any] | None]:
    """Append `sources`; returns (board, images added, duplicates skipped,
    undo). `undo` is the board edit that takes them off again (`ops` for
    `edit_board`), from the route's own answer; None when nothing was added
    or the backend is older and the images went on with a PUT.

    The images go on as one `add` op with `unique`, so the backend skips a
    URL already on the board at the moment it saves, and an edit made in
    Moodboard Studio meanwhile (or another add) is never overwritten."""
    board = get_board(api, ref, headers)  # fail on a wrong board before downloading anything
    urls = source_urls(api, sources, headers=headers, transport=transport)
    # Downloads can take a while; read the board again, so what is skipped
    # as a duplicate is counted against the board as it is now.
    board = api.request("GET", f"/api/moodboards/{board['id']}", headers=headers)
    images = list(board.get("images") or [])
    fresh, skipped = _unique_new(images, urls)
    if not fresh:
        return board, 0, skipped, None
    try:
        result = api.request("POST", f"/api/moodboards/{board['id']}/edits",
                             json={"ops": [{"op": "add", "urls": fresh, "unique": True}]}, headers=headers)
    except NebulaAPIError as exc:
        if not _edits_missing(exc):
            raise
        # An older Nebula: the whole list goes back with a PUT, as before.
        body = {"images": images + [_image_entry(url) for url in fresh], "analysis": None}
        updated = api.request("PUT", f"/api/moodboards/{board['id']}", json=body, headers=headers)
        return updated, len(fresh), skipped, None
    entry = (result.get("applied") or [{}])[0]
    added = list(entry.get("added") or [])
    return result["board"], len(added), skipped + int(entry.get("skipped") or 0), (
        result.get("undo") if added else None)


def added_ids(board: dict[str, Any], undo: dict[str, Any] | None) -> list[str]:
    """The ids of the images an add put on the board, from its `undo`."""
    ids = []
    for op in (undo or {}).get("ops") or []:
        for item in op.get("slices") or []:
            if item.get("part") == "image" and item.get("before") is None:
                ids.append(str(item.get("image")))
    on_board = {str(image.get("id")) for image in board.get("images") or []}
    return [image_id for image_id in ids if image_id in on_board]


def _check_unit(label: str, value: Any) -> float:
    try:
        number = float(value)
    except (TypeError, ValueError) as exc:
        raise MoodboardError(f"{label} must be a number from 0 to 1") from exc
    if not 0.0 <= number <= 1.0:
        raise MoodboardError(f"{label} must be from 0 to 1 (got {value})")
    return number


def find_image(images: list[dict[str, Any]], ref: Any) -> int:
    """The list index of an image named by its 1-based position or its id."""
    text = str(ref).strip()
    for index, image in enumerate(images):
        if str(image.get("id")) == text:
            return index
    if text.isdigit() and 1 <= int(text) <= len(images):
        return int(text) - 1
    if not images:
        raise MoodboardError(f"no image '{text}': this board has no images now")
    raise MoodboardError(f"no image '{text}' on this board: use its number (1-{len(images)}) or id "
                         "from `nebula moodboard show`")


def _brief_rules():
    # The backend's own limits and normalising, so a refused value fails here
    # with its reason, before anything is sent.
    from services import moodboard_brief
    return moodboard_brief


def _avoid_key(text: str) -> str:
    return " ".join(str(text).split()).strip(" ,.").casefold()


def _new_avoid(current: list[str], avoid: list[str] | None, add: list[str] | None,
               drop: list[str] | None) -> list[str]:
    rules = _brief_rules()
    if any(isinstance(value, str) for value in (avoid, add, drop)):
        raise MoodboardError("Avoid items go in a list, one item each")
    items = list(current if avoid is None else avoid)
    for item in drop or []:
        keys = [_avoid_key(existing) for existing in items]
        if _avoid_key(item) not in keys:
            raise MoodboardError(f"'{item}' isn't on the Avoid list ({', '.join(items) or 'it is empty'})")
        items.pop(keys.index(_avoid_key(item)))
    for item in add or []:
        if len(_avoid_key(item)) > rules.AVOID_ITEM_LIMIT:
            raise MoodboardError(f"an Avoid item can be at most {rules.AVOID_ITEM_LIMIT} characters: "
                                 f"'{str(item)[:60]}...'")
        items.append(item)
    try:
        return rules.normalize_avoid(items)
    except ValueError as exc:
        raise MoodboardError(f"Avoid: {exc}; take some off first") from exc


def _new_pinned(current: dict[str, Any], pinned: dict[str, Any] | None, include: list[str] | None,
                exclude: list[str] | None, drop: list[str] | None) -> dict[str, list[str]]:
    rules = _brief_rules()
    base = current if pinned is None else pinned
    if not isinstance(base, dict):
        raise MoodboardError('pinned colours are {"include": [...], "exclude": [...]}')
    lists = {key: list(base.get(key) or []) for key in ("include", "exclude")}
    try:
        lists = {key: [rules.normalize_hex(colour) for colour in colours] for key, colours in lists.items()}
        for colour in drop or []:
            hex_value = rules.normalize_hex(colour)
            if hex_value not in lists["include"] + lists["exclude"]:
                raise MoodboardError(f"{colour} isn't a pinned or kept-out colour on this board")
            lists = {key: [c for c in colours if c != hex_value] for key, colours in lists.items()}
        for key, added in (("include", include), ("exclude", exclude)):
            lists[key].extend(rules.normalize_hex(colour) for colour in added or [])
        unknown = set(base) - {"include", "exclude"}
        return rules.normalize_pinned_colors({**{key: base[key] for key in unknown}, **lists})
    except MoodboardError:
        raise
    except ValueError as exc:
        hint = " (unpin it from the other list first)" if "both" in str(exc) else ""
        raise MoodboardError(f"pinned colours: {exc}{hint}") from exc


def _matching_choice(choices: list[str], hex_value: str) -> str | None:
    """The choice in ``choices`` that names ``hex_value``: the same hex, or
    the nearest within dE00 5 (how the backend matches a choice to a
    measured colour, so the hex `show` lists finds its choice)."""
    if hex_value in choices:
        return hex_value
    from commons.colour import delta_e00, hex_to_lab
    from commons.measure import MERGE_DELTA_E

    near = sorted((float(delta_e00(hex_to_lab(hex_value), hex_to_lab(choice))), choice) for choice in choices)
    return near[0][1] if near and near[0][0] < MERGE_DELTA_E else None


def _new_choices(board: dict[str, Any], replace: dict[str, Any] | None, keep: list[str] | None,
                 leave_out: list[str] | None, leave_out_flagged: bool, reset: list[str] | None,
                 kept_out: list[str]) -> dict[str, list[str]]:
    """The board's Keep anyway / Leave out lists after this call: `replace`
    (or the board's own), then `reset` takes colours off, then `keep` and
    `leave_out` (and the flagged colours) go on, each taken off the other
    list. A colour pinned to keep out leaves Keep anyway (the pin is the
    stronger choice); asking to keep one is an error."""
    rules = _brief_rules()
    if any(isinstance(value, str) for value in (keep, leave_out, reset)):
        raise MoodboardError("colours go in a list, one hex each")
    base = replace if replace is not None else board.get("colorChoices")
    try:
        lists = rules.normalize_color_choices(base if isinstance(base, dict) else None)
        for colour in reset or []:
            hex_value = rules.normalize_hex(colour)
            found = [(key, _matching_choice(lists[key], hex_value)) for key in ("keep", "leaveOut")]
            found = [(key, match) for key, match in found if match]
            if not found:
                raise MoodboardError(f"{colour} isn't kept anyway or left out on this board")
            for key, match in found:
                lists[key].remove(match)
        flagged: list[str] = []
        if leave_out_flagged:
            composed = board.get("brief") if isinstance(board.get("brief"), dict) else {}
            flagged = [item["hex"] for item in composed.get("mayClash") or []
                       if isinstance(item, dict) and isinstance(item.get("hex"), str)]
            if not flagged:
                raise MoodboardError("no colour on this board is flagged as a possible clash")
        for key, other, added in (("keep", "leaveOut", keep), ("leaveOut", "keep", [*(leave_out or []), *flagged])):
            for colour in added or []:
                hex_value = rules.normalize_hex(colour)
                match = _matching_choice(lists[other], hex_value)
                if match:
                    lists[other].remove(match)
                if hex_value not in lists[key]:
                    lists[key].append(hex_value)
        asked = {rules.normalize_hex(colour) for colour in keep or []}
        lists["keep"] = [c for c in lists["keep"] if c not in kept_out or c in asked]
        return rules.normalize_color_choices(lists, kept_out)
    except MoodboardError:
        raise
    except ValueError as exc:
        raise MoodboardError(f"colour choices: {exc}") from exc


def _refusal(exc: NebulaAPIError) -> MoodboardError:
    """The backend's 403 for an agent touching the person's brief, as one
    plain sentence. The person gate adds how a canvas tab connects as the
    person, which is no help to a CLI or MCP caller, so that part is dropped."""
    from services.person_gate import PERSON_REQUIRED_DETAIL

    detail = str(exc.detail).replace(PERSON_REQUIRED_DETAIL, "").strip()
    return MoodboardError(detail)


def _send(api: NebulaAPI, method: str, path: str, *, person_brief: str | None = None,
          **kwargs: Any) -> dict[str, Any]:
    """`person_brief` is what to say when the backend refuses because the
    person wrote the brief (they wrote it after this call read the board):
    the backend's own words are for API callers ("Leave briefOverride out
    of the request")."""
    from services.moodboard_store import NOTES_OPT_IN_REFUSED, PERSON_BRIEF_REFUSED

    try:
        return api.request(method, path, **kwargs)
    except NebulaAPIError as exc:
        if exc.status == 403:
            if person_brief and str(exc.detail).startswith(PERSON_BRIEF_REFUSED):
                raise MoodboardError(person_brief) from exc
            if str(exc.detail).startswith(NOTES_OPT_IN_REFUSED):
                raise MoodboardError(_PERSON_NOTES) from exc
            raise _refusal(exc) from exc
        raise


# How many times update_board sends the board's fields when someone else
# keeps saving the board between its read and its write.
BOARD_WRITE_TRIES = 3

_FIELD_LABELS = {
    "name": "The name", "notes": "Notes", "mode": "Mode", "strength": "Strength", "direction": "Direction",
    "avoid": "The Avoid list", "pinnedColors": "The pinned colours", "clashMode": "The clash mode",
    "colorChoices": "The colour choices", "sendNotes": "Send notes to generators",
    "briefOverride": "The hand-written brief",
}


def _field_value(board: dict[str, Any], key: str) -> Any:
    """A board field as the backend reads it, to tell whether it changed
    (the same reading a `restore` checks its `expect` with)."""
    from services.moodboard_edits import field_value

    return field_value(board, key)


def _changed_under(read: dict[str, Any], at: dict[str, Any], body: dict[str, Any],
                   outright: list[str]) -> str | None:
    """The first field this call gives outright that someone else changed
    since `read`, to something other than what the call sets. Such a field
    is never sent over theirs: the caller hasn't seen their value, so it
    reads the board again and runs the change again (the later explicit
    write wins, through a fresh read). A field they set to the same value
    is no conflict."""
    for key in outright:
        if key not in body or _field_value(at, key) == _field_value(read, key):
            continue
        if _sends_change(at, body, key):
            return key
    return None


def _sends_change(at: dict[str, Any], body: dict[str, Any], key: str) -> bool:
    """Whether the PUT body's `key` changes the field from what `at` holds,
    both read as the backend reads them."""
    sending = body[key]
    if key == "briefOverride":
        sending = str((sending or {}).get("text") or "").strip()
    elif key in ("direction", "avoid", "pinnedColors", "clashMode", "colorChoices"):
        sending = _field_value({**at, key: sending}, key)
    return sending != _field_value(at, key)


# The PUT's board fields and the update_board arguments that set them.
_RESTORE_NAMES = {"name": "name", "notes": "notes", "mode": "mode", "strength": "strength",
                  "direction": "direction", "avoid": "avoid", "pinnedColors": "pinned_colors",
                  "clashMode": "clash_mode", "colorChoices": "color_choices", "sendNotes": "send_notes",
                  "briefOverride": "brief_override"}


def _fields_undo(at: dict[str, Any], body: dict[str, Any]) -> dict[str, Any]:
    """What puts back the board fields a PUT of `body` over `at` changed:
    only those, as `at` held them, so undoing it leaves alone every field
    the call didn't change, whoever changed it since."""
    was = previous_settings(at, brief=True, notes=True)
    return {name: was[name] for key, name in _RESTORE_NAMES.items()
            if key in body and name in was and _sends_change(at, body, key)}


def _fields_slice(at: dict[str, Any], updated: dict[str, Any]) -> dict[str, Any] | None:
    """The `restore` slice that puts back the fields a PUT changed: each as
    `at` held it, expecting what the PUT saved, so a field someone changes
    after it is left as they set it. The PUT carried `baseVersion` (over
    `at`), so every field that differs is this PUT's, the ones it changed
    along the way included (a colour pinned out leaves Keep anyway)."""
    from services.moodboard_edits import fields_slice

    return fields_slice(at, updated)


def _images_undo(original: list[dict[str, Any]], current: list[dict[str, Any]]) -> list[dict[str, Any]]:
    """What puts back the image settings this call changed: each image it
    changed (by id), with only the settings it changed, as read. An image
    or setting the call didn't touch isn't there, so undoing it never puts
    back over a later edit someone else made to it."""
    read = {str(image.get("id")): image for image in original}
    undo = []
    for image in current:
        before = read.get(str(image.get("id")))
        if before is None:
            continue
        keys = [key for key in ("weight", "notes", "privateNote", "excluded")
                if (key != "privateNote" or key in before) and image.get(key) != before.get(key)]
        if keys:
            undo.append({"image": before.get("id"),
                         **{key: (before.get(key) or "") if key == "privateNote" else before.get(key)
                            for key in keys}})
    return undo


_NO_IMAGE_RE = re.compile(r"no image '([^']+)' on this board")


def _image_taken(exc: NebulaAPIError, original: list[dict[str, Any]], board_id: str) -> MoodboardError | None:
    """The edits route refuses an op on an image that isn't on the board: it
    was there when this call read the board, so someone else took it off
    since. Says so, by the number the caller used."""
    found = _NO_IMAGE_RE.search(str(exc.detail)) if exc.status == 422 else None
    if found is None:
        return None
    ids = [str(image.get("id")) for image in original]
    label = f"Image {ids.index(found.group(1)) + 1}" if found.group(1) in ids else "An image this change names"
    return MoodboardError(f"{label} was taken off the board by someone else after this call read it, so nothing "
                          f"was changed. Read the board again (`nebula moodboard show {board_id}`) and redo the "
                          "change.")


def _base_version_unknown(exc: NebulaAPIError) -> bool:
    """An older Nebula's PUT refuses keys it doesn't know (baseVersion)."""
    detail = str(exc.detail)
    return exc.status == 422 and "baseVersion" in detail and "extra_forbidden" in detail


def _put_board(api: NebulaAPI, board_id: str, body: dict[str, Any], headers: dict[str, str] | None,
               person_brief: str | None) -> tuple[dict[str, Any], bool]:
    """PUT the board's fields; on an older Nebula, which has no baseVersion,
    the same body again without it (unchecked, as before). Returns the
    board and whether this Nebula took baseVersion (so it has checked
    edits, and an undo can go as a `restore`)."""
    path = f"/api/moodboards/{board_id}"
    try:
        return _send(api, "PUT", path, json=body, headers=headers, person_brief=person_brief), "baseVersion" in body
    except NebulaAPIError as exc:
        if "baseVersion" not in body or not _base_version_unknown(exc):
            raise
    unchecked = {key: value for key, value in body.items() if key != "baseVersion"}
    return _send(api, "PUT", path, json=unchecked, headers=headers, person_brief=person_brief), False


def _undo_token(slices: list[dict[str, Any]]) -> dict[str, Any]:
    return {"ops": [{"op": "restore", "slices": slices}]}


def undo_board(api: NebulaAPI, ref: str, undo: Any, *, fallback: dict[str, Any] | None = None,
               headers: dict[str, str] | None = None) -> tuple[dict[str, Any], list[str], dict[str, Any], list[str]]:
    """Undo a change from the `undo` in its `previous`: one checked `restore`
    (POST /api/moodboards/{id}/edits) that puts back what the change
    changed, image settings, cards, images it took off and the board's own
    fields alike, in one write. A part someone changed since the change is
    left as they set it, and said so: "Direction changed since, left as
    is", "#2's weight changed since, left as is".

    Returns (board, the URLs the undo took off the board, `previous` for
    undoing the undo, what was left as is). `fallback` is the rest of
    `previous` (update_board's arguments): on a Nebula without board edits
    it is put back with update_board instead, unchecked, as before."""
    board = get_board(api, ref, headers)
    ops = undo.get("ops") if isinstance(undo, dict) else None
    if not isinstance(ops, list) or not all(isinstance(op, dict) and op.get("op") == "restore" for op in ops):
        raise MoodboardError("`undo` must be the `undo` a change handed back in its `previous`. Nothing was changed.")
    if not ops:
        return board, [], {}, []
    try:
        answer = _send(api, "POST", f"/api/moodboards/{board['id']}/edits", json={"ops": ops}, headers=headers)
    except NebulaAPIError as exc:
        if not _edits_missing(exc):
            if exc.status == 422:
                raise MoodboardError(f"the undo can't be put back: {exc.detail}. Nothing was changed.") from exc
            raise
        if not fallback:
            raise MoodboardError(EDITS_UNSUPPORTED) from exc
        updated, removed, previous = update_board(api, ref, **fallback, headers=headers)
        return updated, removed, previous, []
    updated = answer["board"]
    # Only the images the restore itself took off: one someone else took off
    # since is "unchanged" there, and not this undo's to report.
    taken = {str(image_id) for entry in answer.get("applied") or [] for image_id in entry.get("removed") or []}
    removed = [str(item["expect"].get("url")) for op in ops for item in op.get("slices") or []
               if isinstance(item, dict) and item.get("part") == "image" and item.get("before") is None
               and isinstance(item.get("expect"), dict) and str(item.get("image")) in taken]
    skipped = [str(report.get("message")) for entry in answer.get("applied") or []
               for report in entry.get("skipped") or []]
    redo = answer.get("undo") or {}
    return updated, removed, ({"undo": redo} if redo.get("ops") else {}), skipped


def update_board(api: NebulaAPI, ref: str, *, name: str | None = None, notes: str | None = None,
                 mode: str | None = None, strength: float | None = None,
                 images: list[dict[str, Any]] | None = None, remove: list[Any] | None = None,
                 direction: str | None = None, avoid: list[str] | None = None,
                 avoid_add: list[str] | None = None, avoid_remove: list[str] | None = None,
                 pinned_colors: dict[str, Any] | None = None, pin_colors: list[str] | None = None,
                 keep_out_colors: list[str] | None = None, unpin_colors: list[str] | None = None,
                 brief_override: str | None = None, keep_brief: bool = False,
                 keep_anyway: list[str] | None = None, leave_out: list[str] | None = None,
                 leave_out_flagged: bool = False, reset_colors: list[str] | None = None,
                 color_choices: dict[str, Any] | None = None, clash_mode: str | None = None,
                 send_notes: bool | None = None, cover: Any = None, undo: dict[str, Any] | None = None,
                 headers: dict[str, str] | None = None) -> tuple[dict[str, Any], list[str], dict[str, Any]]:
    """Change a board. `images` is a list of {"image": number or id, "weight",
    "notes", "privateNote", "excluded"}; `remove` takes images off the board (their files
    stay, and the returned URLs can be added back). Returns (board, removed
    URLs, the settings before the change), so any change can be put back.
    Image changes and removals go as one checked board edit (absolute ops by
    image id), so an edit saved by someone else since this read is kept; the
    board's own fields then go with a PUT that sends only the fields this
    call sets, with `baseVersion`. If someone else saved the board in
    between (409), it reads the board again and sends them again (changes
    to a list, like `avoid_add`, go on the list as it is now), up to
    BOARD_WRITE_TRIES times. A field given outright that they changed too
    is never sent over their value: the call stops there with a
    MoodboardError naming it, and nothing more is written (run it again to
    set it over theirs). `previous` undoes only what this call changed: the
    image settings it changed and the fields its PUT changed, as they were
    before, so undoing it leaves alone what someone else changed since in
    anything else; its `undo` (undo_board) also leaves a setting the call
    changed and they changed again since as they set it. An image op on an image someone else took off
    the board since this read stops the call, nothing saved, as a
    MoodboardError naming its number.

    `excluded` is the Set aside switch (`setAside` is the same key): a
    set-aside image is still read for its colours but never steers. True
    keeps its weight and card. False uses it again; an image at weight 0
    (which shows as set aside too) then takes the weight its card shows,
    unless the same change sets a weight.

    The brief fields: `direction` ("" clears it); `avoid` replaces the Avoid
    list, `avoid_remove` then `avoid_add` take items off and add them;
    `pinned_colors` ({"include", "exclude"}) replaces the pinned colours,
    `unpin_colors` takes a colour off either list, `pin_colors` adds colours
    that must appear and `keep_out_colors` colours to keep out;
    `brief_override` sets the hand-written brief ("" goes back to the
    generated one); `keep_brief` keeps a hand-written brief that is marked
    stale. Only the person may change or keep the person's own brief: that,
    or a Keep with no hand-written brief, stops the whole call before
    anything is saved, as a MoodboardError (the backend refuses it too).

    Clashes between the words and the measured colours (the brief's
    `leftOut` and `mayClash`): `keep_anyway` puts a left-out colour back
    (without pinning it), `leave_out` takes a colour out,
    `leave_out_flagged` takes out every colour flagged as a possible clash,
    `reset_colors` drops either choice, `color_choices` ({"keep",
    "leaveOut"}) replaces both lists; `clash_mode` is leave-out (default),
    flag, no-measured or keep-all. `send_notes` False stops the board's
    notes reaching generators; True is the person's call (refused for an
    agent, before anything is saved).

    `cover` picks the image the board opens on (its thumbnail on the canvas
    card and in lists), by number ("#3" or 3) or id; "" opens it on #1
    again. A pick, not a reorder: no image changes number, and no notes,
    weights or analysis change. It goes in the same checked batch as the
    image changes; an image can't be the cover and come off the board in
    one call.

    `undo` (from a `previous`) makes the call an undo: see undo_board,
    which also says what it left as is. The other arguments are then what
    an older Nebula, without board edits, puts back instead."""
    if undo is not None:
        arguments = dict(locals())
        given = {key: value for key, value in arguments.items()
                 if key not in ("api", "ref", "undo", "headers") and value is not None
                 and not (key in ("keep_brief", "leave_out_flagged") and value is False)}
        return undo_board(api, ref, undo, fallback=given, headers=headers)[:3]
    board = get_board(api, ref, headers)
    original = [dict(image) for image in board.get("images") or []]
    current = [dict(image) for image in original]
    # The board fields given as values, the same whatever the board holds.
    fixed: dict[str, Any] = {}
    if name is not None:
        if not name.strip():
            raise MoodboardError("a board needs a name")
        fixed["name"] = name.strip()
    if notes is not None:
        fixed["notes"] = notes
    if mode is not None:
        if mode not in MODES:
            raise MoodboardError(f"mode must be one of {', '.join(MODES)}")
        fixed["mode"] = mode
    if strength is not None:
        fixed["strength"] = _check_unit("strength", strength)
    # Image changes go as checked board edits (absolute ops by id), so an
    # edit someone else saves between this read and the write is kept.
    ops: list[dict[str, Any]] = []
    # Two changes can name one image (by number and by id); they mustn't
    # pull its switch both ways, or the later one would quietly win.
    switches: dict[int, bool] = {}
    for edit in images or []:
        if not isinstance(edit, dict) or "image" not in edit:
            raise MoodboardError('each image change needs "image": its number or id')
        index = find_image(current, edit["image"])
        target = current[index]
        unknown = set(edit) - {"image", "weight", "notes", "privateNote", "excluded", "setAside"}
        if unknown:
            raise MoodboardError(f"unknown image setting: {', '.join(sorted(unknown))}")
        switch = _set_aside_switch(edit)
        if switch is not None and switches.setdefault(index, switch) != switch:
            raise MoodboardError(f"image {index + 1} is both set aside and used in this change: pick one. "
                                 "Nothing was changed.")
        image_id = str(target.get("id"))
        note_op: dict[str, Any] = {}
        if edit.get("privateNote") is not None:
            if "privateNote" not in target:
                raise MoodboardError("this version of Nebula has no private notes on images. Nothing was changed.")
            note = str(edit["privateNote"])
            if len(note) > PRIVATE_NOTE_LIMIT:
                raise MoodboardError(f"a private note holds at most {PRIVATE_NOTE_LIMIT} characters")
            target["privateNote"] = note_op["privateNote"] = note
        # The switch goes first: used again from weight 0, the backend gives
        # the image its card's weight, and a weight in the same change wins.
        if switch is not None:
            target["excluded"] = switch
            if not switch and edit.get("weight") is None and _weight_is_zero(target.get("weight")):
                target["weight"] = card_weight(target)
            ops.append({"op": "setAside", "image": image_id, "value": switch})
        if "weight" in edit and edit["weight"] is not None:
            target["weight"] = _check_unit("weight", edit["weight"])
            ops.append({"op": "weight", "image": image_id, "value": target["weight"]})
        if "notes" in edit and edit["notes"] is not None:
            target["notes"] = note_op["notes"] = str(edit["notes"])
        if note_op:
            ops.append({"op": "note", "image": image_id, **note_op})
    # The cover, by its id (numbers as read), in the same batch as the image changes.
    cover_id: str | None = None
    if cover is not None:
        if "coverImageId" not in board:
            raise MoodboardError("this version of Nebula has no board cover: a board always opens on image #1. "
                                 "Nothing was changed.")
        text = str(cover).strip()
        if text:
            cover_id = str(current[find_image(current, text[1:] if text.startswith("#") else text)]["id"])
        ops.append({"op": "cover", "image": cover_id})
    removed: list[str] = []
    if remove:
        drop = {find_image(current, item) for item in remove}
        if cover_id is not None and cover_id in {str(current[index]["id"]) for index in drop}:
            number = next(i for i, image in enumerate(current) if str(image["id"]) == cover_id) + 1
            raise MoodboardError(f"image {number} can't be the cover and come off the board in one change: pick "
                                 "one. Nothing was changed.")
        removed = [str(current[index]["url"]) for index in sorted(drop)]
        ops.append({"op": "remove", "images": [str(current[index]["id"]) for index in sorted(drop)]})
        current = [image for index, image in enumerate(current) if index not in drop]
    # The brief fields aren't analysis inputs, so they keep the analysis
    # (as in Moodboard Studio).
    rules = _brief_rules()
    if direction is not None:
        try:
            fixed["direction"] = rules.normalize_direction(direction)
        except ValueError as exc:
            raise MoodboardError(f"Direction: {exc}") from exc
    if clash_mode is not None:
        if clash_mode not in rules.CLASH_MODES:
            raise MoodboardError(f"clash mode must be one of {', '.join(rules.CLASH_MODES)}")
        fixed["clashMode"] = clash_mode
    choosing = color_choices is not None or keep_anyway or leave_out or leave_out_flagged or reset_colors
    if choosing and "clashMode" not in board:
        raise MoodboardError("this version of Nebula doesn't check colours against the board's words. "
                             "Nothing was changed.")
    if send_notes is not None and "sendNotes" not in board:
        raise MoodboardError("this version of Nebula always sends the board's notes to generators. "
                             "Nothing was changed.")
    override_text: str | None = None
    if brief_override is not None:
        try:
            override_text = rules.normalize_override_text(brief_override)
        except ValueError as exc:
            raise MoodboardError(f"the hand-written brief: {exc}") from exc

    def fields_for(at: dict[str, Any]) -> tuple[dict[str, Any], bool, str | None]:
        """The PUT body for the board as `at` holds it, whether it clears the
        analysis, and what to say if the backend refuses the brief. Values
        given outright go as given; a change to a list (`avoid_add`,
        `pin_colors`, `keep_anyway`...) goes on the list as `at` has it."""
        body = dict(fixed)
        changed = any(key in fixed and fixed[key] != at.get(key) for key in ("notes", "mode", "strength"))
        if avoid is not None or avoid_add or avoid_remove:
            body["avoid"] = _new_avoid(list(at.get("avoid") or []), avoid, avoid_add, avoid_remove)
        if pinned_colors is not None or pin_colors or keep_out_colors or unpin_colors:
            body["pinnedColors"] = _new_pinned(at.get("pinnedColors") or {}, pinned_colors, pin_colors,
                                               keep_out_colors, unpin_colors)
        if choosing:
            kept_out = (body.get("pinnedColors") or rules.board_fields(at)[2])["exclude"]
            choices = _new_choices(at, color_choices, keep_anyway, leave_out, leave_out_flagged, reset_colors,
                                   kept_out)
            if choices != rules.board_options(at)[1]:
                body["colorChoices"] = choices
        if send_notes is not None and bool(send_notes) != (at.get("sendNotes") is True):
            body["sendNotes"] = bool(send_notes)
        refused: str | None = None
        if override_text is not None:
            saved = _override(at)
            if override_text != str((saved or {}).get("text") or "").strip():
                refused = _PERSON_BRIEF.format(action="replace" if override_text else "remove")
                if saved and saved["by"] == "person":
                    raise MoodboardError(refused)
                body["briefOverride"] = {"text": override_text} if override_text else None
        return body, changed, refused

    body, _changed, _refused = fields_for(board)
    saved_override = _override(board)
    # Keep runs after the PUT (it keeps the brief for the board as it ends
    # up), so one the backend would refuse stops here, before anything is
    # saved. New text is already written against the board as it ends up.
    if keep_brief:
        if "briefOverride" in body:
            if body["briefOverride"] is None:
                raise MoodboardError("This change clears the hand-written brief, so it leaves no hand-written "
                                     "brief to keep. Nothing was changed.")
            keep_brief = False
        elif saved_override is None:
            raise MoodboardError("This board has no hand-written brief to keep. Nothing was changed.")
        elif saved_override["by"] == "person":
            raise MoodboardError(_PERSON_KEEP.format(outcome=_NOTHING_KEPT))
    if not body and not ops and not keep_brief:
        raise MoodboardError("nothing to change")
    updated = board
    # `previous` undoes only what this call changes: the image settings it
    # changes, then (once the PUT is saved) the fields that PUT changed.
    previous: dict[str, Any] = {}
    images_undo = _images_undo(original, current)
    if images_undo:
        previous["images"] = images_undo
    # Fields given outright: re-sent after a conflict only while the board
    # still holds what this call read for them (see _changed_under).
    outright = [key for key, given in (("name", name), ("notes", notes), ("mode", mode), ("strength", strength),
                                       ("direction", direction), ("avoid", avoid), ("pinnedColors", pinned_colors),
                                       ("clashMode", clash_mode), ("colorChoices", color_choices),
                                       ("sendNotes", send_notes), ("briefOverride", brief_override))
                if given is not None]
    edited = False
    # The way back as one checked `restore`: the batch's own undo, then the
    # fields the PUT changed (expecting what it wrote), so undoing it skips
    # whatever someone else has changed since (undo_board).
    undo_slices: list[dict[str, Any]] = []
    steering_changed = False
    checked = True  # the PUT carries baseVersion (an older Nebula refuses the key)
    if ops:
        try:
            # The backend clears the analysis itself when what it reads changed.
            answer = _send(api, "POST", f"/api/moodboards/{board['id']}/edits", json={"ops": ops},
                           headers=headers)
            updated = answer["board"]
            edited = True
            if (updated.get("coverImageId") or None) != (board.get("coverImageId") or None):
                previous["cover"] = board.get("coverImageId") or ""
            for op in (answer.get("undo") or {}).get("ops") or []:
                undo_slices.extend(op.get("slices") or [])
            if undo_slices:
                previous["undo"] = _undo_token(list(undo_slices))
        except NebulaAPIError as exc:
            taken = _image_taken(exc, original, str(board["id"]))
            if taken is not None:
                raise taken from exc
            if not _edits_missing(exc):
                raise
            # An older Nebula: the whole image list goes with the PUT, as before,
            # without baseVersion, which it doesn't know.
            checked = False
            # A private note isn't an analysis input, so changing only that keeps it.
            steering_changed = _steering(current) != _steering(original)
    try:
        at = updated
        for attempt in range(1, BOARD_WRITE_TRIES + 1):
            body, changed, refused_put = fields_for(at)
            moved = _changed_under(board, at, body, outright)
            if moved:
                raise MoodboardError(
                    f"{_FIELD_LABELS[moved]} was changed by someone else after this call read the board, so it "
                    f"wasn't set. Nothing more was written: read the board again (`nebula moodboard show "
                    f"{board['id']}`) and run the change again to set it over theirs.")
            if not checked:
                body["images"] = current
            if changed or steering_changed:
                body["analysis"] = None
            if not body:
                updated = at  # nothing left to send: the board as last read is the board
                break
            fields_undo = _fields_undo(at, body)
            if checked and isinstance(at.get("version"), int):
                body["baseVersion"] = at["version"]
            try:
                updated, took_base = _put_board(api, str(board["id"]), body, headers, refused_put)
                previous.update(fields_undo)
                # The PUT answers with its own undo (the server's diff of the
                # board it replaced); a Nebula from before that is read here
                # the same way, from the board this call sent the PUT over.
                answered = updated.pop("undo", None)
                if not took_base:
                    put_slices: list[dict[str, Any]] = []
                elif isinstance(answered, dict) and isinstance(answered.get("ops"), list):
                    put_slices = [item for op in answered["ops"] for item in op.get("slices") or []]
                else:
                    fields = _fields_slice(at, updated)
                    put_slices = [fields] if fields is not None else []
                if put_slices:
                    undo_slices.extend(put_slices)
                    previous["undo"] = _undo_token(list(undo_slices))
                break
            except NebulaAPIError as exc:
                if not (exc.status == 409 and "baseVersion" in body):
                    raise
                if attempt == BOARD_WRITE_TRIES:
                    raise MoodboardError(
                        f"The board kept changing while this ran ({BOARD_WRITE_TRIES} tries), so its settings "
                        f"weren't saved. Nothing more was written: read it again (`nebula moodboard show "
                        f"{board['id']}`) and redo the change.") from exc
                at = get_board(api, str(board["id"]), headers)
    except (MoodboardError, NebulaAPIError) as exc:
        if not edited:
            raise
        # The image changes are saved: hand back what undoes them.
        reason = (str(exc) if isinstance(exc, MoodboardError)
                  else f"Saving the board's settings failed: {exc.detail}")
        if not previous:  # the image ops landed but set what the board already held
            raise MoodboardError(f"{reason} The image changes were saved, and changed nothing.") from exc
        raise MoodboardError(f"{reason} The image changes were saved; `previous` puts them back.",
                             previous=previous, board_id=str(board["id"])) from exc
    if keep_brief:
        keep_path = f"/api/moodboards/{board['id']}/brief-override/keep"
        if not body:
            updated = _send(api, "POST", keep_path, headers=headers,
                            person_brief=_PERSON_KEEP.format(outcome=_NOTHING_KEPT))
        else:
            # Only a race gets here (the person wrote or removed the brief
            # since it was read): the PUT is saved, so hand back what undoes it.
            try:
                updated = _send(api, "POST", keep_path, headers=headers,
                                person_brief=_PERSON_KEEP.format(outcome="").strip())
            except (MoodboardError, NebulaAPIError) as exc:
                if isinstance(exc, MoodboardError):
                    reason = f"{exc} Ask the person to keep or regenerate it in Moodboard Studio."
                elif exc.kind in ("connect", "timeout"):
                    reason = ("Nebula didn't answer the Keep, so the brief may or may not have been kept "
                              f"(`nebula moodboard show {board['id']}` says which).")
                elif exc.status == 409:
                    reason = "The board's hand-written brief was removed while this ran, so there is none to keep."
                else:
                    reason = f"Keeping the brief failed: {exc.detail}"
                if not previous:  # the PUT set what the board already held
                    raise MoodboardError(f"{reason} The other changes were saved, and changed nothing.") from exc
                raise MoodboardError(f"{reason} {_OTHERS_SAVED}", previous=previous,
                                     board_id=str(board["id"])) from exc
    return updated, removed, previous


_PERSON_BRIEF = ("The person wrote this board's brief by hand, so an agent can't {action} it: the board keeps no "
                 "history, and their text would be lost. Nothing was changed: leave brief_override (--brief, "
                 "--clear-brief) out to make the other changes, or ask the person to change it in Moodboard "
                 "Studio.")
# Keeping loses nothing: it answers the person's "changed since you edited
# this" notice, which is theirs to answer.
_PERSON_KEEP = ("The person wrote this board's brief by hand, so only they can keep it: keeping it clears their "
                "notice that the board changed since they wrote it. {outcome}")
_NOTHING_KEPT = ("Nothing was changed: leave keep_brief (--keep-brief) out to make the other changes, or ask the "
                 "person to keep or regenerate it in Moodboard Studio.")
_OTHERS_SAVED = "The other changes were saved; `previous` puts them back."
# Notes are the person's words about the board; sending them to generators
# is theirs to turn on (moodboard_store.NotesOptInProtected).
_PERSON_NOTES = ("Only the person can send this board's notes to generators: the notes are their words about "
                 "the board, for them, their team and agents. Nothing was changed: leave send_notes "
                 "(--send-notes) out to make the other changes, or ask the person to turn on \"Send these notes "
                 "to generators\" in Moodboard Studio: propose it with propose_asset_change(kind=\"moodboard\", "
                 "id=<board id>, change={\"sendNotes\": true}, note=...) over MCP, or POST /api/asset-proposals, "
                 "and they accept it there.")


# The backend's cap on an image's private note (services/moodboard_store.py).
PRIVATE_NOTE_LIMIT = 2000


def _set_aside_switch(edit: dict[str, Any]) -> bool | None:
    """What an image change does with the Set aside switch: True sets it
    aside, False uses it again, None leaves it. `setAside` and `excluded`
    are the same switch, so they must agree when both are given."""
    given = {bool(edit[key]) for key in ("excluded", "setAside") if edit.get(key) is not None}
    if len(given) > 1:
        raise MoodboardError('"excluded" and "setAside" are the same switch: give one, or the same value')
    return given.pop() if given else None


def _weight_is_zero(weight: Any) -> bool:
    try:
        return float(weight) <= 0
    except (TypeError, ValueError):
        return False


def card_weight(image: dict[str, Any]) -> float:
    """The weight an image's card shows: its largest card's (the board's
    weight is its largest copy's, section 4.3 of the canvas plan), or full
    weight when it has no card yet (a weight-0 card is laid out at full
    size)."""
    weights = []
    for placement in image.get("placements") or []:
        try:
            weight = float(placement.get("weight")) if isinstance(placement, dict) else 0.0
        except (TypeError, ValueError):
            continue
        if weight > 0 and weight == weight:
            weights.append(min(1.0, weight))
    return max(weights) if weights else 1.0


def is_set_aside(image: dict[str, Any]) -> bool:
    """Whether an image shows as set aside: switched aside (`excluded`), or
    at weight 0, which steers nothing either."""
    return bool(image.get("excluded")) or _weight_is_zero(image.get("weight"))


# The image keys the analysis reads (services/moodboard_analysis.source_hash).
# Not the private note, and not the layout: moving or resizing a card keeps
# the analysis.
STEERING_KEYS = ("url", "weight", "notes", "excluded")


def _steering(images: list[dict[str, Any]]) -> list[dict[str, Any]]:
    """What the analysis reads of each image (``STEERING_KEYS``)."""
    return [{key: image.get(key) for key in STEERING_KEYS} for image in images]


# Every key previous_settings can return: update_board's arguments that put
# a board back (`nebula moodboard set --restore` checks against it). Each
# image in `images` carries its weight, notes, private note and excluded.
# `undo` is the checked way back a change hands over too (undo_board).
RESTORE_KEYS = ("name", "notes", "mode", "strength", "images", "direction", "avoid", "pinned_colors",
                "brief_override", "clash_mode", "color_choices", "send_notes", "cover", "undo")


def previous_settings(board: dict[str, Any], *, brief: bool = False, notes: bool = False,
                      skip: Iterable[str] = ()) -> dict[str, Any]:
    """What `update_board` takes to put a whole board back the way it was:
    its settings, each image's weight, notes, private note and excluded, by
    image id, and the brief fields (pass them as update_board's keyword
    arguments). update_board's own `previous` is the part of this its change
    touched (_fields_undo, _images_undo).
    A Nebula without private notes sends none, and `previous` has none.

    `skip` names images the change took off the board. They aren't in
    `images`, which only sets images that are there: they come back from
    the change's `removed` URLs (`nebula moodboard add`, moodboard_add).

    `brief_override` (the agent's own text, "" for none) is there only when
    the change touched the hand-written brief (`brief`), so undoing anything
    else never touches a brief the person wrote since. An agent can only
    change its own text, so it is never the person's.

    `clash_mode` and `color_choices` are there on a Nebula that has them;
    `send_notes` only when the change touched it (`notes`), so undoing
    anything else never asks to send notes the person has since turned on."""
    gone = set(skip)
    previous: dict[str, Any] = {
        "name": board.get("name"), "notes": board.get("notes"), "mode": board.get("mode"),
        "strength": board.get("strength"),
        "images": [{"image": image.get("id"), "weight": image.get("weight"), "notes": image.get("notes"),
                    **({"privateNote": image.get("privateNote") or ""} if "privateNote" in image else {}),
                    "excluded": image.get("excluded")}
                   for image in board.get("images") or [] if str(image.get("id")) not in gone],
    }
    if "direction" not in board:
        return previous  # an older Nebula: no brief fields to put back
    pinned = board.get("pinnedColors") if isinstance(board.get("pinnedColors"), dict) else {}
    previous.update({
        "direction": board.get("direction") or "",
        "avoid": list(board.get("avoid") or []),
        "pinned_colors": {"include": list(pinned.get("include") or []),
                          "exclude": list(pinned.get("exclude") or [])},
    })
    if brief:
        override = _override(board)
        previous["brief_override"] = override["text"] if override else ""
    if "clashMode" in board:
        mode, choices, send = _brief_rules().board_options(board)
        previous.update({"clash_mode": mode, "color_choices": choices})
        if notes:
            previous["send_notes"] = send
    return previous


def analyze_board(api: NebulaAPI, ref: str, headers: dict[str, str] | None = None) -> dict[str, Any]:
    board = get_board(api, ref, headers)
    return api.request("POST", f"/api/moodboards/{board['id']}/analyze", headers=headers, timeout=300.0)


# The dry run's threshold names, as `nebula moodboard analyze --dry-run` and
# moodboard_analyze take them, and the API's names for them.
THRESHOLD_FIELDS = {"accent_min_chroma": "accentMinChroma", "accent_separation": "accentSeparation",
                    "merge_delta_e": "mergeDeltaE"}

DRY_RUN_UNSUPPORTED = ("this version of Nebula has no dry run for moodboard analysis, so nothing was analyzed "
                       "or saved. Update Nebula to use it.")


def dry_run_board(api: NebulaAPI, ref: str, *, thresholds: dict[str, float | None] | None = None,
                  headers: dict[str, str] | None = None) -> dict[str, Any]:
    """What analyzing the board would give, saving nothing: the analysis, the
    brief generators would get, and what changed from the saved ones.

    `thresholds` ({accent_min_chroma, accent_separation, merge_delta_e}; None
    keeps the default) apply to this dry run only. The backend checks their
    ranges. On a Nebula without the dry-run route this raises rather than
    falling back to a saving analyze."""
    board = get_board(api, ref, headers)
    sent = {THRESHOLD_FIELDS[key]: value for key, value in (thresholds or {}).items() if value is not None}
    body: dict[str, Any] = {"thresholds": sent} if sent else {}
    try:
        return api.request("POST", f"/api/moodboards/{board['id']}/analyze/dry-run", json=body,
                           headers=headers, timeout=300.0)
    except NebulaAPIError as exc:
        # FastAPI's own "Not Found" means no such route; a missing board says
        # "Moodboard '<id>' not found".
        if exc.status == 405 or (exc.status == 404 and str(exc.detail).strip() == "Not Found"):
            raise MoodboardError(DRY_RUN_UNSUPPORTED) from exc
        if exc.status == 422:
            raise MoodboardError(f"thresholds: {exc.detail}") from exc
        raise


# -- reading references with a vision model (PR4: a dry run) -------------------------------------

READ_UNSUPPORTED = ("this version of Nebula can't read references with a model, so nothing was sent or charged. "
                    "Update Nebula to use --read-with.")
# A read is bounded on the backend (every request has its time bounds), so
# the client waits as long as it takes.
READ_TIMEOUT = httpx.Timeout(30.0, read=None)


def _read_body(board: dict[str, Any], model: str, only: Iterable[Any] | None,
               thinking_level: str | None) -> dict[str, Any]:
    body: dict[str, Any] = {"model": str(model)}
    if only:
        images = board.get("images") or []
        refs = [part.strip() for item in only for part in str(item).split(",") if part.strip()]
        if not refs:
            raise MoodboardError("--only takes image numbers or ids, e.g. --only 3,5")
        body["imageIds"] = list(dict.fromkeys(str(images[find_image(images, ref)].get("id")) for ref in refs))
    if thinking_level:
        body["thinkingLevel"] = thinking_level
    return body


def _read_refusal(exc: NebulaAPIError) -> Exception:
    if exc.status == 405 or (exc.status == 404 and str(exc.detail).strip() == "Not Found"):
        return MoodboardError(READ_UNSUPPORTED)
    if exc.status in (400, 422):
        return MoodboardError(exc.detail)
    return exc


def estimate_read(api: NebulaAPI, ref: str, model: str, *, only: Iterable[Any] | None = None,
                  thinking_level: str | None = None, headers: dict[str, str] | None = None) -> dict[str, Any]:
    """What reading the board's references with ``model`` would cost, sending
    nothing (contract 07 section 1.13)."""
    board = get_board(api, ref, headers)
    try:
        return api.request("POST", f"/api/moodboards/{board['id']}/read/estimate",
                           json=_read_body(board, model, only, thinking_level), headers=headers)
    except NebulaAPIError as exc:
        raise _read_refusal(exc) from exc


def dry_read(api: NebulaAPI, ref: str, model: str, *, only: Iterable[Any] | None = None,
             thinking_level: str | None = None, headers: dict[str, str] | None = None,
             on_line: Callable[[dict[str, Any]], None] | None = None) -> dict[str, Any]:
    """Read the references with ``model`` and say how Analyze would sort them,
    moving nothing. It is paid: agents go through the spending limits.

    With ``on_line`` the trace streams (each ``moodboardReadTrace`` line as it
    is written); the result is returned either way, with ``trace``."""
    board = get_board(api, ref, headers)
    body = _read_body(board, model, only, thinking_level)
    path = f"/api/moodboards/{board['id']}/read"
    try:
        if on_line is None:
            return api.request("POST", path, params={"dryRun": 1}, json=body, headers=headers, timeout=READ_TIMEOUT)
        trace: list[dict[str, Any]] = []
        result: dict[str, Any] | None = None
        for raw in api.stream_lines("POST", path, params={"dryRun": 1, "stream": 1}, json=body, headers=headers,
                                    timeout=READ_TIMEOUT):
            row = json.loads(raw)
            if row.get("type") == "moodboardReadError":
                raise MoodboardError(f"{row.get('detail') or 'the read stopped'}; nothing was saved")
            if row.get("type") == "moodboardReadResult":
                result = row
            else:
                trace.append(row)
                on_line(row)
    except NebulaAPIError as exc:
        raise _read_refusal(exc) from exc
    if result is None:
        raise MoodboardError("the read stopped before it finished; nothing was saved")
    return {**result, "trace": trace}


def deletes_are_restorable(api: NebulaAPI, headers: dict[str, str] | None = None) -> bool:
    """True when this Nebula moves a deleted board to Recently deleted
    (`/api/trash` exists), so a delete can be undone. Older backends delete
    boards for good."""
    try:
        api.request("GET", "/api/trash", params={"kind": "moodboard"}, headers=headers)
    except NebulaAPIError as exc:
        if exc.status in (404, 405):
            return False
        raise
    return True


PERMANENT_DELETE_REFUSED = (
    "this version of Nebula deletes boards for good, so `nebula moodboard delete` and moodboard_delete "
    "don't: the person can delete it in Moodboard Studio. You can still take images off it or rename it "
    "(`nebula moodboard set {id} --remove N`, or moodboard_update), or ask the person to delete it."
)


def delete_board(api: NebulaAPI, ref: str, headers: dict[str, str] | None = None) -> dict[str, Any]:
    """Move a board to Recently deleted, where a restore brings it back with
    the same id. Anyone may, agents included. On a Nebula without Recently
    deleted the DELETE route is for good, and this never calls it, for
    anyone: there the person deletes in Moodboard Studio. Deciding here who
    the caller is would be a check any client could skip; who may empty
    Recently deleted is the backend's call (services/person_gate.py)."""
    board = get_board(api, ref, headers)
    if not deletes_are_restorable(api, headers):
        raise MoodboardError(PERMANENT_DELETE_REFUSED.format(id=board.get("id")))
    result = api.request("DELETE", f"/api/moodboards/{board['id']}", headers=headers)
    result = result if isinstance(result, dict) else {}
    trashed = result.get("status") == "trashed"
    return {**result, "name": board.get("name"), "restorable": trashed,
            "previous": brief(board) if not trashed else None}


def _override(board: dict[str, Any]) -> dict[str, Any] | None:
    """The board's hand-written brief, if any: its text, who wrote it, when,
    and whether the board changed since (from the backend's `brief`; None
    when this Nebula doesn't say). Anything not stamped "agent" is the
    person's, as the backend counts it (moodboard_store.person_wrote)."""
    saved = board.get("briefOverride")
    if not isinstance(saved, dict) or not str(saved.get("text") or "").strip():
        return None
    composed = board.get("brief") if isinstance(board.get("brief"), dict) else None
    flags = composed.get("override") if composed and isinstance(composed.get("override"), dict) else None
    return {
        "text": saved.get("text"),
        "by": "agent" if saved.get("by") == "agent" else "person",
        "updatedAt": saved.get("updatedAt"),
        "stale": bool(flags.get("stale")) if flags is not None else None,
    }


def cover_of(board: dict[str, Any]) -> dict[str, Any] | None:
    """The image the board opens on: `{number, id, chosen}`. `chosen` is
    False when nobody picked one and it opens on #1; None for a board with
    no images."""
    images = [image for image in board.get("images") or [] if isinstance(image, dict)]
    chosen = board.get("coverImageId")
    for index, image in enumerate(images):
        if chosen and str(image.get("id")) == str(chosen):
            return {"number": index + 1, "id": image.get("id"), "chosen": True}
    return {"number": 1, "id": images[0].get("id"), "chosen": False} if images else None


# What an agent is told about a board image that links to another site.
# Anyone who could reach the board routes could have saved the link, so an
# agent never fetches it on its own: that would tell the host the person's
# address, the leak the check closes.
OUTSIDE_NOTE = ("Images marked `outside` are image links from outside Nebula, saved before board images were "
                "checked: the app shows a placeholder for them, and no run or analysis uses them. Don't fetch "
                "these links yourself: ask the person whether the link is theirs and they want it used. Only if "
                "they say yes, add it with moodboard_add (`nebula moodboard add`), which downloads and uploads "
                "it, then remove the old one. Otherwise they can replace it with an upload in Moodboard Studio.")
OUTSIDE_PLACEHOLDER = "Image link from outside Nebula (not loaded)"
# The same for `nebula moodboard show`, which marks such an image with the placeholder.
OUTSIDE_NOTE_CLI = ("An image link from outside Nebula was saved before board images were checked: the app shows "
                    "a placeholder for it, and no run or analysis uses it. Ask the person before fetching it; if "
                    "they want it used, `nebula moodboard add <board> <its link>` (downloads and uploads it), then "
                    "remove the old one, or they can replace it with an upload in Moodboard Studio.")


def brief(board: dict[str, Any], *, layout: bool = False) -> dict[str, Any]:
    """A board as an agent needs it: settings, the brief fields, the brief
    generators get, numbered images, and the analysis.

    `layout` adds where the cards sit: each image's `placements` (one card
    each: x, y, w, h in board pixels, its weight, and `frameId`, the frame it
    is in, null for none), the board's `frames` and its `version`. `nebula moodboard show
    --json`, `nebula moodboard edit --json`, moodboard_get and moodboard_edit
    ask for it; lists and the other edits leave it out.

    An image's `privateNote` is the person's own label for it, shown to
    whoever inspects the board; nothing that generates gets it, so don't put
    it in a prompt. Its `notes` are the ones that steer. `setAside` says it
    doesn't steer: `excluded` (the switch) or weight 0. Either way it is
    still read for its colours and nothing that generates gets it. The
    analysis marks only the switched ones with `setAside: true`; a weight-0
    image keeps its ordinary entry there.

    `brief` is the backend's composed brief as it sent it (`styleBrief` is
    the text generators get, `negativePrompt` their negatives); None when
    this Nebula doesn't send one. The analysis's own `styleBrief` leaves out
    Direction, pinned colours and any hand-written brief, so it is not it.

    `cover` ({number, id}) is the image chosen to open the board on, its
    picture on the canvas card and in lists; with none chosen (or on a
    Nebula without covers) there is no `cover` and the board opens on #1.
    It is only what the board shows: no generator gets it.

    `outside: true` marks an image that is a link to another site, which a
    board saved before board writes were checked can hold (the backend's
    `outsideImages`). It stays on the board, but nothing in Nebula loads it:
    the app shows a placeholder, and runs and the analysis leave it out.
    `outsideNote` says what to do, once, when there are any."""
    analysis = board.get("analysis") or None
    composed = board.get("brief")
    outside = {str(image_id) for image_id in board.get("outsideImages") or []}
    view = {
        "id": board.get("id"),
        "name": board.get("name"),
        "projectId": board.get("projectId"),
        "mode": board.get("mode"),
        "strength": board.get("strength"),
        "notes": board.get("notes"),
        "direction": board.get("direction"),
        "avoid": board.get("avoid"),
        "pinnedColors": board.get("pinnedColors"),
        # Gap 18 (absent on an older Nebula): what a clash does, the person's
        # Keep anyway / Leave out, whether notes reach generators, and the
        # colour check the brief used (its findings say what clashed and why).
        **{key: board.get(key) for key in ("clashMode", "colorChoices", "sendNotes", "colorCheck") if key in board},
        "briefOverride": _override(board),
        "brief": composed if isinstance(composed, dict) else None,
        "images": [
            {"number": index + 1, **{key: image.get(key) for key in ("id", "url", "weight", "notes", "excluded")},
             "setAside": is_set_aside(image),
             **({"privateNote": image.get("privateNote") or ""} if "privateNote" in image else {}),
             **({"outside": True} if str(image.get("id")) in outside else {})}
            for index, image in enumerate(board.get("images") or [])
        ],
        **({"outsideNote": OUTSIDE_NOTE} if outside else {}),
        # Only when one is chosen, so an old board's view is as it was (the
        # golden file pins it): no `cover` means it opens on #1.
        **({"cover": {key: chosen[key] for key in ("number", "id")}}
           if (chosen := cover_of(board)) and chosen["chosen"] else {}),
        "analysis": analysis,
        "updatedAt": board.get("updatedAt"),
    }
    if layout:
        # The write counter: moodboard_edit's base_version (`--base-version`)
        # refuses an edit when the board was saved since this version.
        view["version"] = board.get("version")
        for image, shown in zip(board.get("images") or [], view["images"]):
            if isinstance(image, dict) and isinstance(image.get("placements"), list):
                shown["placements"] = image["placements"]
        view["frames"] = board.get("frames") if isinstance(board.get("frames"), list) else []
    return view
