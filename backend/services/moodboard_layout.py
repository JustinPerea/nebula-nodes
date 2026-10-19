"""Where a moodboard's cards sit (the moodboard canvas, item 6).

Each image carries ``placements``: one card per placement, at absolute flow
pixels (docs/moodboard-canvas-plan.md section 4.2). A card's area is its
weight: ``w * h = weight * FULL_AREA``, rounded to whole pixels, with the
image's aspect ratio. The server writes ``w`` and ``h`` from the weight and
never recomputes them on read.

Nothing here reads or writes files except image headers (for aspect
ratios), and nothing here changes what a board steers: ``image.weight``,
``source_hash`` and the brief never read a placement.

- ``legacy_layout`` lays out a board saved before layouts existed: a grid in
  number order, the same on every read, so saving it moves nothing.
- ``place`` finds room for new cards: after the last-added card, in its row
  if there is room, else in a new row under the board. (Placing next to the
  person's view, ``--at`` and ``--in`` come later, with the view report.)
- ``normalize_placements`` checks the placements a client asks for on a new
  image; ``check_board_layout`` checks a saved board's frames, suggestions
  and readings (section 4.10).
"""
from __future__ import annotations

import functools
import hashlib
import json
import math
import os
import re
from typing import Any, Iterable
from uuid import uuid4

# Full weight is a 480x270 card (Q1). Weight is area / FULL_AREA, capped at 1.
FULL_AREA = 129_600
# The smallest card: weight 0.05, today's slider step (Q3). Below that is Set aside.
MIN_WEIGHT = 0.05
# Cards with no header to read: 4:3.
DEFAULT_ASPECT = 4 / 3
# The grid old boards read with: 6 columns, 40 px between cells.
GRID_COLUMNS = 6
GRID_GAP = 40
# place(): the space kept around a new card, and how wide a row may grow
# before a new card starts a row of its own (six full-weight 16:9 cards).
PLACE_GAP = 24
ROW_LIMIT = GRID_COLUMNS * 480 + (GRID_COLUMNS - 1) * GRID_GAP
COORD_LIMIT = 1_000_000
PLACEMENTS_PER_IMAGE = 8
PLACED_BY = ("person", "agent", "analyze")
PLACEMENT_KEYS = ("id", "frameId", "x", "y", "w", "h", "weight", "placedBy", "placedAt")
# Frames, suggestions and readings (section 4.1, 4.10).
FRAME_LIMIT = 100
FRAME_NAME_LIMIT = 60
FRAME_MIN_SIDE = 160
FRAME_KINDS = ("look", "unsorted")
SUGGESTION_LIMIT = 200
SUGGESTION_KINDS = ("alsoIn", "hybrid")
SUGGESTION_BY = ("analyze", "agent")
SUGGESTION_STATUS = ("open", "dismissed")
SUGGESTION_REASON_LIMIT = 200
READING_BYTES = 2048

_ID_RE = re.compile(r"^[A-Za-z0-9_-]{1,64}$")
_FRAME_ID_RE = re.compile(r"^[0-9a-f]{12}$")
_EXIF_ORIENTATION = 0x0112
# EXIF orientations that turn the picture a quarter turn: its upright width is its stored height.
_QUARTER_TURNS = {5, 6, 7, 8}


# -- weight and size -----------------------------------------------------------

def clamp_weight(weight: float) -> float:
    """A card weight: MIN_WEIGHT to 1."""
    return max(MIN_WEIGHT, min(1.0, float(weight)))


def weight_of(w: float, h: float) -> float:
    """The weight a card of ``w`` x ``h`` pixels shows: its area over FULL_AREA, capped at 1."""
    return min(1.0, max(0.0, float(w) * float(h) / FULL_AREA))


def size_for(weight: float, aspect: float) -> tuple[int, int]:
    """The card size for ``weight`` (clamped to MIN_WEIGHT..1) at ``aspect`` (width / height)."""
    if not math.isfinite(aspect) or aspect <= 0:
        aspect = DEFAULT_ASPECT
    area = clamp_weight(weight) * FULL_AREA
    return max(1, round(math.sqrt(area * aspect))), max(1, round(math.sqrt(area / aspect)))


def card_weight(image_weight: Any) -> float:
    """The card weight an image is laid out at when nothing says otherwise:
    its own weight, at least MIN_WEIGHT. Weight 0 (set aside) shows at full
    size (Q8), so it doesn't shrink to nothing."""
    try:
        weight = float(image_weight)
    except (TypeError, ValueError):
        return 1.0
    if not math.isfinite(weight) or weight <= 0:
        return 1.0
    return clamp_weight(weight)


# -- aspect ratios -------------------------------------------------------------

@functools.lru_cache(maxsize=4096)
def _header_size(path: str, mtime_ns: int, size: int) -> tuple[int, int] | None:
    """An image file's upright size from its header (the pixels aren't
    decoded). Keyed by mtime and size, so a changed file is read again."""
    from PIL import Image

    try:
        with Image.open(path) as image:
            width, height = image.size
            try:
                orientation = int(image.getexif().get(_EXIF_ORIENTATION, 1) or 1)
            except Exception:  # a broken EXIF block still has a size
                orientation = 1
    except (OSError, ValueError, SyntaxError, Image.DecompressionBombError):
        return None
    if orientation in _QUARTER_TURNS:
        width, height = height, width
    return (width, height) if width > 0 and height > 0 else None


# url and agent workspace -> (resolved path, device, inode, mtime_ns, size, aspect).
_ASPECTS: dict[tuple[str, str], tuple[str, int, int, int, int, float | None]] = {}
_ASPECT_CACHE_LIMIT = 8192


def clear_aspect_cache() -> None:
    _ASPECTS.clear()
    _header_size.cache_clear()


def file_aspect(url: str) -> float | None:
    """Width / height of a Nebula-local image, upright as thumbnails show
    it (EXIF orientation applied), or None when it can't be read.

    Resolving a URL runs the protected-path check (services/file_access.py),
    about 2 ms an image, so an old board of 300 images took half a second on
    every read. The answer is kept per URL and agent workspace (the check
    depends on it) together with the resolved file's identity; a later read
    reuses it only while one stat shows that same file, unchanged and with
    one link. Anything else runs the full check again. Only the ratio is
    kept, never a path handed out."""
    from services.file_access import access_scope
    from services.moodboard_analysis import resolve_moodboard_image_path

    key = (url, access_scope())
    hit = _ASPECTS.get(key)
    if hit is not None:
        try:
            info = os.stat(hit[0])
        except OSError:
            info = None
        if info is not None and info.st_nlink <= 1 and (
                info.st_dev, info.st_ino, info.st_mtime_ns, info.st_size) == hit[1:5]:
            return hit[5]
    path = resolve_moodboard_image_path(url)
    if path is None:
        return None
    try:
        info = path.stat()
    except OSError:
        return None
    size = _header_size(str(path), info.st_mtime_ns, info.st_size)
    aspect = size[0] / size[1] if size else None
    if len(_ASPECTS) >= _ASPECT_CACHE_LIMIT:
        _ASPECTS.clear()
    _ASPECTS[key] = (str(path), info.st_dev, info.st_ino, info.st_mtime_ns, info.st_size, aspect)
    return aspect


def analysis_sizes(analysis: Any) -> dict[str, tuple[float, float]]:
    """Sizes the saved analysis measured, by image id and by url."""
    sizes: dict[str, tuple[float, float]] = {}
    items = analysis.get("images") if isinstance(analysis, dict) else None
    for item in items if isinstance(items, list) else []:
        if not isinstance(item, dict):
            continue
        try:
            width, height = float(item.get("width") or 0), float(item.get("height") or 0)
        except (TypeError, ValueError):
            continue
        if width > 0 and height > 0:
            for key in (f"id:{item.get('id')}", f"url:{item.get('url')}"):
                sizes.setdefault(key, (width, height))
    return sizes


def image_aspect(image: dict[str, Any], measured: dict[str, tuple[float, float]] | None = None) -> float:
    """An image's aspect ratio: its file's header, upright; else the size the
    saved analysis measured (``measured``, from ``analysis_sizes``); else 4:3.

    The header comes first because the analysis measures stored pixels, which
    for a phone photo with an EXIF turn are sideways from what a card shows."""
    aspect = file_aspect(str(image.get("url") or ""))
    if aspect:
        return aspect
    for key in (f"id:{image.get('id')}", f"url:{image.get('url')}"):
        if measured and key in measured:
            width, height = measured[key]
            return width / height
    return DEFAULT_ASPECT


# -- placements ----------------------------------------------------------------

def new_placement_id() -> str:
    return uuid4().hex[:12]


def placement(*, pid: str, x: float, y: float, weight: float, aspect: float, placed_by: str,
              placed_at: str, frame_id: str | None = None) -> dict[str, Any]:
    w, h = size_for(weight, aspect)
    return {"id": pid, "frameId": frame_id, "x": round(x), "y": round(y), "w": w, "h": h,
            "weight": clamp_weight(weight), "placedBy": placed_by, "placedAt": placed_at}


def resized(p: dict[str, Any], weight: float, aspect: float) -> dict[str, Any]:
    """``p`` at card weight ``weight``: ``w`` and ``h`` written from it and ``aspect``."""
    w, h = size_for(weight, aspect)
    return {**p, "weight": clamp_weight(weight), "w": w, "h": h}


def rescale(placements: list[dict[str, Any]], image_weight: float, aspect: float) -> list[dict[str, Any]]:
    """Placements after the image's weight was set to ``image_weight`` by
    something other than a resize (the CLI, MCP, the List view slider):
    every copy scales by the same factor so the largest equals it, smaller
    ones stopping at MIN_WEIGHT (section 4.3). Each keeps its top-left
    corner; ``aspect`` is the image's. Weight 0 (set aside) keeps the cards
    as they are."""
    if image_weight <= 0 or not placements:
        return placements
    largest = max(float(p.get("weight") or 0) for p in placements)
    target = clamp_weight(image_weight)
    if largest <= 0 or abs(largest - target) < 1e-9:
        return placements
    return [resized(p, float(p.get("weight") or 0) * target / largest, aspect) for p in placements]


def _number(value: Any, label: str) -> float:
    if isinstance(value, bool) or not isinstance(value, (int, float)):
        raise ValueError(f"{label} must be a number")
    number = float(value)
    if not math.isfinite(number):
        raise ValueError(f"{label} must be a finite number")
    return number


def _coordinate(value: Any, label: str) -> float:
    number = _number(value, label)
    if abs(number) > COORD_LIMIT:
        raise ValueError(f"{label} must be within {COORD_LIMIT:,} px of the origin")
    return number


def normalize_placements(raw: Any, *, label: str, aspect: float, frame_ids: Iterable[str], taken: set[str],
                         placed_by: str, placed_at: str) -> list[dict[str, Any]]:
    """The placements a client asks for on a new image, checked and written
    the server's way: ``w`` and ``h`` from the weight and the image's aspect,
    ``placedBy`` from who asked (never from the client), ``placedAt`` now.

    A placement's weight is its ``weight``, else its ``w`` x ``h`` area, else
    left as None for the caller to fill from the image's weight. ``taken``
    holds the board's placement ids and gains these. Raises ValueError."""
    if not isinstance(raw, list) or not 1 <= len(raw) <= PLACEMENTS_PER_IMAGE:
        raise ValueError(f"{label} must be a list of 1 to {PLACEMENTS_PER_IMAGE} placements")
    frames = set(frame_ids)
    seen_frames: set[Any] = set()
    out: list[dict[str, Any]] = []
    for index, item in enumerate(raw):
        where = f"{label}[{index}]"
        if not isinstance(item, dict):
            raise ValueError(f"{where} must be an object")
        unknown = set(item) - set(PLACEMENT_KEYS)
        if unknown:
            raise ValueError(f"{where} has unknown keys: {', '.join(sorted(unknown))}")
        frame_id = item.get("frameId")
        if frame_id is not None and (not isinstance(frame_id, str) or frame_id not in frames):
            raise ValueError(f"{where}.frameId names no frame on this board")
        if frame_id in seen_frames:
            raise ValueError(f"{label}: an image has at most one card per frame"
                             if frame_id is not None else f"{label}: an image has at most one loose card")
        seen_frames.add(frame_id)
        pid = item.get("id")
        if pid is None or pid == "":
            pid = new_placement_id()
            while pid in taken:
                pid = new_placement_id()
        elif not isinstance(pid, str) or not _ID_RE.fullmatch(pid):
            raise ValueError(f"{where}.id must be 1 to 64 letters, digits, - or _")
        elif pid in taken:
            raise ValueError(f"{where}.id {pid!r} is already a card on this board")
        taken.add(pid)
        x = _coordinate(item.get("x"), f"{where}.x")
        y = _coordinate(item.get("y"), f"{where}.y")
        weight: float | None = None
        if item.get("weight") is not None:
            weight = clamp_weight(_number(item["weight"], f"{where}.weight"))
        elif item.get("w") is not None and item.get("h") is not None:
            w, h = _number(item["w"], f"{where}.w"), _number(item["h"], f"{where}.h")
            if w <= 0 or h <= 0:
                raise ValueError(f"{where}: w and h must be more than 0")
            weight = clamp_weight(weight_of(w, h))
        made = placement(pid=pid, x=x, y=y, weight=weight or 1.0, aspect=aspect, placed_by=placed_by,
                         placed_at=placed_at, frame_id=frame_id)
        if weight is None:
            made["weight"] = None  # the caller fills it from the image's weight
        out.append(made)
    if len(out) > 1 and None in seen_frames:
        raise ValueError(f"{label}: a loose card (frameId null) must be the image's only card")
    return out


# -- free space ------------------------------------------------------------------

Rect = tuple[float, float, float, float]  # x, y, w, h


def _rect(p: Any) -> Rect | None:
    if not isinstance(p, dict):
        return None
    try:
        x, y, w, h = (float(p[key]) for key in ("x", "y", "w", "h"))
    except (KeyError, TypeError, ValueError):
        return None
    if not all(math.isfinite(v) for v in (x, y, w, h)) or w <= 0 or h <= 0:
        return None
    return x, y, w, h


def _too_close(a: Rect, b: Rect, gap: float) -> bool:
    return (a[0] < b[0] + b[2] + gap and b[0] < a[0] + a[2] + gap
            and a[1] < b[1] + b[3] + gap and b[1] < a[1] + a[3] + gap)


def _card_rects(images: Iterable[Any]) -> list[Rect]:
    rects = []
    for image in images:
        for p in (image.get("placements") or []) if isinstance(image, dict) else []:
            rect = _rect(p)
            if rect:
                rects.append(rect)
    return rects


def _last_card(images: list[Any]) -> Rect | None:
    """The last-added card: the newest placement of the highest-numbered
    image that has one."""
    for image in reversed(images):
        cards = [p for p in (image.get("placements") or []) if _rect(p)] if isinstance(image, dict) else []
        if cards:
            newest = max(range(len(cards)), key=lambda i: (str(cards[i].get("placedAt") or ""), i))
            return _rect(cards[newest])
    return None


def place(board: dict[str, Any], sizes: list[tuple[int, int]]) -> list[tuple[int, int]]:
    """Top-left corners for new cards of ``sizes``, in order, each after the
    one before: the first after the board's last-added card. A card goes in
    that card's row when it fits (PLACE_GAP from every card and frame, and
    within the row's width), else at the start of a new row under the whole
    board. Never on top of anything. An empty board starts at 0, 0."""
    images = list(board.get("images") or [])
    rects = _card_rects(images)
    for frame in board.get("frames") or []:
        rect = _rect(frame)
        if rect:
            rects.append(rect)
    anchor = _last_card(images)
    out: list[tuple[int, int]] = []
    for w, h in sizes:
        spot: tuple[float, float] | None = None
        if not rects:
            spot = (0, 0)
        else:
            left = min(r[0] for r in rects)
            right = max(r[0] + r[2] for r in rects)
            bottom = max(r[1] + r[3] for r in rects)
            if anchor is not None:
                x, y = anchor[0] + anchor[2] + PLACE_GAP, anchor[1]
                fits = x + w <= max(right, left + ROW_LIMIT)
                if fits and not any(_too_close((x, y, w, h), r, PLACE_GAP) for r in rects):
                    spot = (x, y)
            if spot is None:
                spot = (left, bottom + PLACE_GAP)
        corner = (round(spot[0]), round(spot[1]))
        rect = (corner[0], corner[1], w, h)
        rects.append(rect)
        anchor = rect
        out.append(corner)
    return out


# -- old boards ------------------------------------------------------------------

def _legacy_id(board_id: Any, image_id: Any, index: int) -> str:
    """A laid-out card's id, the same on every read of the same file, so an
    agent that read it can name it after the first write saves it."""
    return hashlib.sha256(f"{board_id}\0{image_id}\0{index}".encode("utf-8")).hexdigest()[:12]


def legacy_layout(board: dict[str, Any]) -> dict[str, Any]:
    """``board`` with a placement on every image, as a grid in number order:
    6 columns, 40 px between cells, each column as wide as its widest card
    and each row as tall as its tallest, every card centred in its cell.

    A card's size is ``max(weight, MIN_WEIGHT) * FULL_AREA`` at the image's
    aspect (weight 0 shows at full size). The result depends only on the
    board and its image files, so every read gives the same layout and the
    first write saves exactly what was shown. ``placedBy`` is "person": the
    order was theirs. The input isn't changed."""
    images = board.get("images") if isinstance(board.get("images"), list) else []
    measured = analysis_sizes(board.get("analysis"))
    placed_at = str(board.get("updatedAt") or board.get("createdAt") or "")
    cells: list[tuple[int, int, int, float, tuple[int, int]]] = []  # index, row, column, weight, size
    slot = 0
    for index, image in enumerate(images):
        if not isinstance(image, dict):
            continue
        weight = card_weight(image.get("weight"))
        cells.append((index, slot // GRID_COLUMNS, slot % GRID_COLUMNS, weight,
                      size_for(weight, image_aspect(image, measured))))
        slot += 1
    widths = [0] * GRID_COLUMNS
    heights = [0] * (max((row for _, row, _, _, _ in cells), default=-1) + 1)
    for _, row, column, _, (w, h) in cells:
        widths[column] = max(widths[column], w)
        heights[row] = max(heights[row], h)
    xs = [sum(widths[:c]) + c * GRID_GAP for c in range(GRID_COLUMNS)]
    ys = [sum(heights[:r]) + r * GRID_GAP for r in range(len(heights))]
    laid = list(images)
    for index, row, column, weight, (w, h) in cells:
        image = images[index]
        p = {"id": _legacy_id(board.get("id"), image.get("id"), index), "frameId": None,
             "x": xs[column] + (widths[column] - w) // 2, "y": ys[row] + (heights[row] - h) // 2,
             "w": w, "h": h, "weight": weight, "placedBy": "person", "placedAt": placed_at}
        laid[index] = {**image, "placements": [p]}
    return {**board, "images": laid}


def ensure_layout(board: dict[str, Any]) -> dict[str, Any]:
    """``board`` with a placement on every image, in memory: an old board
    (no ``layoutVersion``) gets ``legacy_layout``; a laid-out board's image
    that somehow has none gets a spot from ``place``. Never stamps
    ``layoutVersion``: only a write does."""
    if not isinstance(board.get("images"), list):
        return board
    if board.get("layoutVersion") is None:
        return legacy_layout(board)
    missing = [i for i, image in enumerate(board["images"])
               if isinstance(image, dict) and not image.get("placements")]
    if not missing:
        return board
    measured = analysis_sizes(board.get("analysis"))
    images = list(board["images"])
    placed_at = str(board.get("updatedAt") or "")
    for index in missing:
        image = images[index]
        weight = card_weight(image.get("weight"))
        size = size_for(weight, image_aspect(image, measured))
        # Images still without a card are skipped by place(), so each lands
        # after the highest-numbered card placed so far.
        (x, y), = place({**board, "images": images}, [size])
        images[index] = {**image, "placements": [{
            "id": _legacy_id(board.get("id"), image.get("id"), index), "frameId": None, "x": x, "y": y,
            "w": size[0], "h": size[1], "weight": weight, "placedBy": "person", "placedAt": placed_at}]}
    return {**board, "images": images}


# -- checking a saved board's layout --------------------------------------------

def _text(value: Any, label: str, *, limit: int | None = None, empty: bool = False) -> str:
    if not isinstance(value, str) or (not empty and not value.strip()):
        raise ValueError(f"{label} must be text")
    if limit is not None and len(value) > limit:
        raise ValueError(f"{label} is longer than {limit} characters")
    return value


def _one_of(value: Any, choices: tuple[str, ...], label: str) -> str:
    if value not in choices:
        raise ValueError(f"{label} must be one of {', '.join(choices)}")
    return value


def check_frames(frames: Any) -> None:
    if not isinstance(frames, list) or len(frames) > FRAME_LIMIT:
        raise ValueError(f"frames must be a list of at most {FRAME_LIMIT}")
    names: set[str] = set()
    ids: set[str] = set()
    unsorted = 0
    for index, frame in enumerate(frames):
        where = f"frames[{index}]"
        if not isinstance(frame, dict):
            raise ValueError(f"{where} must be an object")
        if not isinstance(frame.get("id"), str) or not _FRAME_ID_RE.fullmatch(frame["id"]) or frame["id"] in ids:
            raise ValueError(f"{where}.id must be 12 hex characters, unique on the board")
        ids.add(frame["id"])
        name = _text(frame.get("name"), f"{where}.name", limit=FRAME_NAME_LIMIT).strip()
        if name.casefold() in names:
            raise ValueError(f"{where}.name {name!r} is already a frame on this board")
        names.add(name.casefold())
        if _one_of(frame.get("kind"), FRAME_KINDS, f"{where}.kind") == "unsorted":
            unsorted += 1
        for key in ("x", "y"):
            _coordinate(frame.get(key), f"{where}.{key}")
        for key in ("w", "h"):
            if _number(frame.get(key), f"{where}.{key}") < FRAME_MIN_SIDE:
                raise ValueError(f"{where}.{key} must be at least {FRAME_MIN_SIDE}")
        _one_of(frame.get("namedBy"), PLACED_BY, f"{where}.namedBy")
    if unsorted > 1:
        raise ValueError("a board has at most one Unsorted frame")


def check_suggestions(suggestions: Any) -> None:
    if not isinstance(suggestions, list) or len(suggestions) > SUGGESTION_LIMIT:
        raise ValueError(f"suggestions must be a list of at most {SUGGESTION_LIMIT}")
    for index, item in enumerate(suggestions):
        where = f"suggestions[{index}]"
        if not isinstance(item, dict):
            raise ValueError(f"{where} must be an object")
        _one_of(item.get("kind"), SUGGESTION_KINDS, f"{where}.kind")
        _one_of(item.get("by"), SUGGESTION_BY, f"{where}.by")
        _one_of(item.get("status"), SUGGESTION_STATUS, f"{where}.status")
        for key in ("imageIds", "frameIds"):
            if not isinstance(item.get(key), list) or not all(isinstance(v, str) for v in item[key]):
                raise ValueError(f"{where}.{key} must be a list of ids")
        _text(item.get("reason", ""), f"{where}.reason", limit=SUGGESTION_REASON_LIMIT, empty=True)


def check_readings(readings: Any) -> None:
    if not isinstance(readings, dict):
        raise ValueError("readings must be an object keyed by image id")
    for image_id, reading in readings.items():
        if not isinstance(reading, dict):
            raise ValueError(f"readings[{image_id!r}] must be an object")
        if len(json.dumps(reading, ensure_ascii=False).encode("utf-8")) > READING_BYTES:
            raise ValueError(f"readings[{image_id!r}] is larger than {READING_BYTES} bytes")


def check_image_placements(images: Any, frame_ids: set[str]) -> None:
    """A saved board's placements: 1 to 8 per image, one per frame, a loose
    card only when it is the only one, ids unique on the board."""
    seen: set[str] = set()
    for index, image in enumerate(images if isinstance(images, list) else []):
        cards = image.get("placements") if isinstance(image, dict) else None
        if cards is None:
            continue
        label = f"images[{index}].placements"
        if not isinstance(cards, list) or not 1 <= len(cards) <= PLACEMENTS_PER_IMAGE:
            raise ValueError(f"{label} must be a list of 1 to {PLACEMENTS_PER_IMAGE} placements")
        frames_used: list[Any] = []
        for i, p in enumerate(cards):
            if _rect(p) is None:
                raise ValueError(f"{label}[{i}] needs x, y, w and h")
            pid = p.get("id")
            if not isinstance(pid, str) or not _ID_RE.fullmatch(pid) or pid in seen:
                raise ValueError(f"{label}[{i}].id must be an id unique on the board")
            seen.add(pid)
            frame_id = p.get("frameId")
            if frame_id is not None and frame_id not in frame_ids:
                raise ValueError(f"{label}[{i}].frameId names no frame on this board")
            frames_used.append(frame_id)
        if len(set(frames_used)) != len(frames_used):
            raise ValueError(f"{label}: an image has at most one card per frame")
        if len(frames_used) > 1 and None in frames_used:
            raise ValueError(f"{label}: a loose card must be the image's only card")


def check_board_layout(board: dict[str, Any]) -> None:
    """Section 4.10's limits on a saved board's layout. Raises ValueError."""
    frames = board.get("frames", [])
    check_frames(frames)
    check_suggestions(board.get("suggestions", []))
    check_readings(board.get("readings", {}))
    check_image_placements(board.get("images"), {f["id"] for f in frames})
