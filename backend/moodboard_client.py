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
        if "://" in source and not lowered.startswith("file://"):
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
        raise MoodboardError(f"no board '{ref}' (`nebula moodboard list` shows them)")
    if len(matches) > 1:
        ids = ", ".join(str(board.get("id")) for board in matches)
        raise MoodboardError(f"{len(matches)} boards are named '{ref}' ({ids}); use the id")
    return matches[0]


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


def add_to_board(api: NebulaAPI, ref: str, sources: Iterable[str], *, headers: dict[str, str] | None = None,
                 transport: httpx.AsyncBaseTransport | None = None) -> tuple[dict[str, Any], int, int]:
    """Append `sources`; returns (board, images added, duplicates skipped)."""
    board = get_board(api, ref, headers)  # fail on a wrong board before downloading anything
    urls = source_urls(api, sources, headers=headers, transport=transport)
    # Downloads can take a while; read the board again so an edit made in
    # Moodboard Studio meanwhile isn't overwritten by the old image list.
    board = api.request("GET", f"/api/moodboards/{board['id']}", headers=headers)
    images = list(board.get("images") or [])
    fresh, skipped = _unique_new(images, urls)
    if not fresh:
        return board, 0, skipped
    body = {"images": images + [_image_entry(url) for url in fresh], "analysis": None}
    updated = api.request("PUT", f"/api/moodboards/{board['id']}", json=body, headers=headers)
    return updated, len(fresh), skipped


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
    from services.moodboard_store import PERSON_BRIEF_REFUSED

    try:
        return api.request(method, path, **kwargs)
    except NebulaAPIError as exc:
        if exc.status == 403:
            if person_brief and str(exc.detail).startswith(PERSON_BRIEF_REFUSED):
                raise MoodboardError(person_brief) from exc
            raise _refusal(exc) from exc
        raise


def update_board(api: NebulaAPI, ref: str, *, name: str | None = None, notes: str | None = None,
                 mode: str | None = None, strength: float | None = None,
                 images: list[dict[str, Any]] | None = None, remove: list[Any] | None = None,
                 direction: str | None = None, avoid: list[str] | None = None,
                 avoid_add: list[str] | None = None, avoid_remove: list[str] | None = None,
                 pinned_colors: dict[str, Any] | None = None, pin_colors: list[str] | None = None,
                 keep_out_colors: list[str] | None = None, unpin_colors: list[str] | None = None,
                 brief_override: str | None = None, keep_brief: bool = False,
                 headers: dict[str, str] | None = None) -> tuple[dict[str, Any], list[str], dict[str, Any]]:
    """Change a board. `images` is a list of {"image": number or id, "weight",
    "notes", "privateNote", "excluded"}; `remove` takes images off the board (their files
    stay, and the returned URLs can be added back). Returns (board, removed
    URLs, the settings before the change), so any change can be put back.

    The brief fields: `direction` ("" clears it); `avoid` replaces the Avoid
    list, `avoid_remove` then `avoid_add` take items off and add them;
    `pinned_colors` ({"include", "exclude"}) replaces the pinned colours,
    `unpin_colors` takes a colour off either list, `pin_colors` adds colours
    that must appear and `keep_out_colors` colours to keep out;
    `brief_override` sets the hand-written brief ("" goes back to the
    generated one); `keep_brief` keeps a hand-written brief that is marked
    stale. Only the person may change or keep the person's own brief: that,
    or a Keep with no hand-written brief, stops the whole call before
    anything is saved, as a MoodboardError (the backend refuses it too)."""
    board = get_board(api, ref, headers)
    original = [dict(image) for image in board.get("images") or []]
    current = [dict(image) for image in original]
    body: dict[str, Any] = {}
    content_changed = False
    if name is not None:
        if not name.strip():
            raise MoodboardError("a board needs a name")
        body["name"] = name.strip()
    if notes is not None:
        body["notes"] = notes
        content_changed |= notes != board.get("notes")
    if mode is not None:
        if mode not in MODES:
            raise MoodboardError(f"mode must be one of {', '.join(MODES)}")
        body["mode"] = mode
        content_changed |= mode != board.get("mode")
    if strength is not None:
        body["strength"] = _check_unit("strength", strength)
        content_changed |= body["strength"] != board.get("strength")
    images_changed = False
    for edit in images or []:
        if not isinstance(edit, dict) or "image" not in edit:
            raise MoodboardError('each image change needs "image": its number or id')
        target = current[find_image(current, edit["image"])]
        unknown = set(edit) - {"image", "weight", "notes", "privateNote", "excluded"}
        if unknown:
            raise MoodboardError(f"unknown image setting: {', '.join(sorted(unknown))}")
        if edit.get("privateNote") is not None:
            if "privateNote" not in target:
                raise MoodboardError("this version of Nebula has no private notes on images. Nothing was changed.")
            note = str(edit["privateNote"])
            if len(note) > PRIVATE_NOTE_LIMIT:
                raise MoodboardError(f"a private note holds at most {PRIVATE_NOTE_LIMIT} characters")
            target["privateNote"] = note
        if "weight" in edit and edit["weight"] is not None:
            target["weight"] = _check_unit("weight", edit["weight"])
        if "notes" in edit and edit["notes"] is not None:
            target["notes"] = str(edit["notes"])
        if "excluded" in edit and edit["excluded"] is not None:
            target["excluded"] = bool(edit["excluded"])
        images_changed = True
    removed: list[str] = []
    if remove:
        drop = {find_image(current, item) for item in remove}
        removed = [str(current[index]["url"]) for index in sorted(drop)]
        current = [image for index, image in enumerate(current) if index not in drop]
        images_changed = True
    if images_changed:
        body["images"] = current
        # A private note isn't an analysis input, so changing only that keeps it.
        content_changed |= _steering(current) != _steering(original)
    # The brief fields aren't analysis inputs, so they keep the analysis
    # (as in Moodboard Studio).
    rules = _brief_rules()
    if direction is not None:
        try:
            body["direction"] = rules.normalize_direction(direction)
        except ValueError as exc:
            raise MoodboardError(f"Direction: {exc}") from exc
    if avoid is not None or avoid_add or avoid_remove:
        body["avoid"] = _new_avoid(list(board.get("avoid") or []), avoid, avoid_add, avoid_remove)
    if pinned_colors is not None or pin_colors or keep_out_colors or unpin_colors:
        body["pinnedColors"] = _new_pinned(board.get("pinnedColors") or {}, pinned_colors, pin_colors,
                                           keep_out_colors, unpin_colors)
    saved_override = _override(board)
    refused_put: str | None = None
    if brief_override is not None:
        try:
            text = rules.normalize_override_text(brief_override)
        except ValueError as exc:
            raise MoodboardError(f"the hand-written brief: {exc}") from exc
        if text != str((saved_override or {}).get("text") or "").strip():
            refused_put = _PERSON_BRIEF.format(action="replace" if text else "remove")
            if saved_override and saved_override["by"] == "person":
                raise MoodboardError(refused_put)
            body["briefOverride"] = {"text": text} if text else None
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
    if not body and not keep_brief:
        raise MoodboardError("nothing to change")
    if content_changed:
        body["analysis"] = None
    updated = board
    previous = previous_settings(board, brief="briefOverride" in body,
                                 skip={str(image.get("id")) for image in original} - {
                                     str(image.get("id")) for image in current})
    if body:
        updated = _send(api, "PUT", f"/api/moodboards/{board['id']}", json=body, headers=headers,
                        person_brief=refused_put)
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


# The backend's cap on an image's private note (services/moodboard_store.py).
PRIVATE_NOTE_LIMIT = 2000


def _steering(images: list[dict[str, Any]]) -> list[dict[str, Any]]:
    """Images without their private notes: what the analysis reads."""
    return [{key: value for key, value in image.items() if key != "privateNote"} for image in images]


# Every key previous_settings can return: update_board's arguments that put
# a board back (`nebula moodboard set --restore` checks against it). Each
# image in `images` carries its weight, notes, private note and excluded.
RESTORE_KEYS = ("name", "notes", "mode", "strength", "images", "direction", "avoid", "pinned_colors",
                "brief_override")


def previous_settings(board: dict[str, Any], *, brief: bool = False,
                      skip: Iterable[str] = ()) -> dict[str, Any]:
    """What `update_board` takes to put a board back the way it was: its
    settings, each image's weight, notes, private note and excluded, by image
    id, and the brief fields (pass them as update_board's keyword arguments).
    A Nebula without private notes sends none, and `previous` has none.

    `skip` names images the change took off the board. They aren't in
    `images`, which only sets images that are there: they come back from
    the change's `removed` URLs (`nebula moodboard add`, moodboard_add).

    `brief_override` (the agent's own text, "" for none) is there only when
    the change touched the hand-written brief (`brief`), so undoing anything
    else never touches a brief the person wrote since. An agent can only
    change its own text, so it is never the person's."""
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


def brief(board: dict[str, Any]) -> dict[str, Any]:
    """A board as an agent needs it: settings, the brief fields, the brief
    generators get, numbered images, and the analysis.

    An image's `privateNote` is the person's own label for it, shown to
    whoever inspects the board; nothing that generates gets it, so don't put
    it in a prompt. Its `notes` are the ones that steer.

    `brief` is the backend's composed brief as it sent it (`styleBrief` is
    the text generators get, `negativePrompt` their negatives); None when
    this Nebula doesn't send one. The analysis's own `styleBrief` leaves out
    Direction, pinned colours and any hand-written brief, so it is not it."""
    analysis = board.get("analysis") or None
    composed = board.get("brief")
    return {
        "id": board.get("id"),
        "name": board.get("name"),
        "projectId": board.get("projectId"),
        "mode": board.get("mode"),
        "strength": board.get("strength"),
        "notes": board.get("notes"),
        "direction": board.get("direction"),
        "avoid": board.get("avoid"),
        "pinnedColors": board.get("pinnedColors"),
        "briefOverride": _override(board),
        "brief": composed if isinstance(composed, dict) else None,
        "images": [
            {"number": index + 1, **{key: image.get(key) for key in ("id", "url", "weight", "notes", "excluded")},
             **({"privateNote": image.get("privateNote") or ""} if "privateNote" in image else {})}
            for index, image in enumerate(board.get("images") or [])
        ],
        "analysis": analysis,
        "updatedAt": board.get("updatedAt"),
    }
