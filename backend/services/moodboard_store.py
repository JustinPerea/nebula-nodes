"""MoodboardStore - project-scoped & global native Nebula moodboards.

On-disk layout mirrors CharacterStore:
    MOODBOARD_ROOT/<projectId>/<id>.json
    MOODBOARD_ROOT/_global/<id>.json
    MOODBOARD_ROOT/.trash/          deleted boards (services/asset_trash.py)

Moodboards are provider-neutral creative-direction assets. They can later be
adapted to Krea, GPT Image, Gemini, Seedream, etc. without changing the saved
resource shape.

Each image may also carry ``placements``: its cards on the board canvas
(services/moodboard_layout.py). Writes keep them: a PUT merges images by id,
so a key a client leaves out keeps its saved value, and an image already on
the board keeps its cards whatever the client sends. A new image gets the
cards it asks for, else the server places it. The board-level layout
(``frames``, ``suggestions``, ``readings``, ``layoutVersion``) is never set
through ``create`` or ``update``. A board saved before layouts existed reads
with one (``get``, ``update``; ``list`` skips it) and its file is left alone
until the next edit, which saves that layout and stamps ``layoutVersion``.

The person's brief fields (``direction``, ``avoid``, ``pinnedColors``,
``briefOverride``) sit on the board beside ``analysis``, so analyzing again
never drops them; services/moodboard_brief.py describes them. A board saved
before they existed is migrated once (``briefVersion``).

The board's ``coverImageId`` is the id of the image it opens on (the
picture its card, the Studio's rail and lists show): ``thumbnail`` is that
image's url, else image #1's, as before covers. It is presentation only: it
never reorders ``images`` (an image's number is its place there), and no
generator, reader or node output reads it. A board saved before covers reads
with ``coverImageId: None`` and its file is left alone; removing the cover
image falls back to #1 (the store clears it), and a cover that names an
image no longer on the board (a file an older Nebula edited) reads as none.

Each image may carry a ``privateNote``: the person's own label ("PAINTERLY
(liked)"). It is for whoever looks at the board, the person or an agent, and
nothing else: it isn't an analysis input (``source_hash`` leaves it out), and
it never reaches the brief, a generator or the Moodboard node's outputs
(``output_image``). The image's ``notes`` are the ones that steer.
"""
from __future__ import annotations

import json
import logging
import os
import re
import threading
from collections import deque
from contextlib import contextmanager
from datetime import datetime, timezone
from pathlib import Path
from typing import Any
from uuid import uuid4

from services import asset_trash
from services import moodboard_layout as layout
from services.asset_trash import is_trash_folder

_PROJECT_ID_RE = re.compile(r"^[A-Za-z0-9_-]{1,64}$")
_MOODBOARD_ID_RE = re.compile(r"^[A-Za-z0-9_-]{1,64}$")
_VALID_MODES = {"look", "world", "subject"}
# The longest private note an image keeps (Moodboard Studio stops typing there).
PRIVATE_NOTE_LIMIT = 2000
# The image fields a client sets; anything else on a saved image (a later
# Nebula's) is kept as it is.
IMAGE_KEYS = ("id", "url", "weight", "notes", "privateNote", "excluded")
# The image fields generators and the Moodboard node's outputs get
# (handlers/moodboard.py): never the private note (the person's alone) or
# the layout.
OUTPUT_IMAGE_KEYS = ("id", "url", "weight", "notes", "excluded")
# The board's layout, saved beside its images. Only board edits and the
# server's own placement of new images write it, never a PUT or a create.
LAYOUT_VERSION = 1
LAYOUT_BOARD_KEYS = ("frames", "suggestions", "readings", "layoutVersion", "lastRead")
LAYOUT_REFUSED = ("can't be set with PUT or when making a board: a board's layout is written only by board "
                  "edits (POST /api/moodboards/{id}/edits), and new images are placed by Nebula (or where "
                  "their placements ask)")

# The board's cover: the id of the image it opens on (``thumbnail``).
COVER_REFUSED = ("coverImageId names no image on this board: use an image's id "
                 "(GET /api/moodboards/{id} lists them), or null for no cover")

# One lock per board: a write reads the file, changes it and writes it back
# as one step, whichever thread it runs on.
_LOCKS: dict[str, threading.RLock] = {}
_LOCKS_GUARD = threading.Lock()


@contextmanager
def _board_lock(moodboard_id: str):
    with _LOCKS_GUARD:
        lock = _LOCKS.setdefault(moodboard_id, threading.RLock())
    with lock:
        yield


class VersionConflict(Exception):
    """A write sent ``baseVersion`` and the board has moved on since: someone
    else saved it. ``board`` is the board as it is now (laid out), so the
    caller can rebase its change on it and send it again."""

    def __init__(self, board: dict[str, Any]) -> None:
        super().__init__(f"the board changed since you read it (it is at version {board.get('version')})")
        self.board = board


def _read_for_write(path: Path, moodboard_id: str) -> dict[str, Any]:
    """The board a write starts from, laid out. KeyError when its file went
    (moved to Recently deleted) after it was found."""
    try:
        text = path.read_text(encoding="utf-8")
    except FileNotFoundError:
        raise KeyError(f"Moodboard {moodboard_id} not found") from None
    return _migrated(json.loads(text), layout_board=True)


def _check_base_version(moodboard: dict[str, Any], base_version: Any) -> None:
    if base_version is None:
        return
    if isinstance(base_version, bool) or not isinstance(base_version, int):
        raise ValueError("baseVersion must be a whole number: the board's version you read")
    if int(moodboard.get("version", 1)) != base_version:
        raise VersionConflict(moodboard)


def _private_note(raw: Any, index: int) -> str:
    text = str(raw or "")
    if len(text) > PRIVATE_NOTE_LIMIT:
        raise ValueError(f"images[{index}].privateNote is longer than {PRIVATE_NOTE_LIMIT} characters")
    return text


def _validate_project_id(project_id: str) -> str:
    if not _PROJECT_ID_RE.fullmatch(project_id):
        raise ValueError(f"invalid projectId: {project_id!r}")
    return project_id


def _validate_moodboard_id(moodboard_id: str) -> str:
    if not _MOODBOARD_ID_RE.fullmatch(moodboard_id):
        raise ValueError(f"invalid moodboard id: {moodboard_id!r}")
    return moodboard_id


def _moodboard_root() -> Path:
    raw = os.environ.get("NEBULA_MOODBOARD_ROOT", "")
    if raw:
        return Path(raw)
    return Path.home() / ".nebula" / "moodboards"


def store_root() -> Path:
    """This store's root folder, resolved now (env var, else ~/.nebula/...).
    Public so other code (services/asset_project_rehome.py) finds the same
    folder this store writes to."""
    return _moodboard_root()


def _scope_dir(root: Path, project_id: str | None) -> Path:
    if project_id:
        _validate_project_id(project_id)
        scope = root / project_id
        if not scope.resolve().is_relative_to(root.resolve()):
            raise ValueError(f"invalid projectId: {project_id!r}")
        return scope
    return root / "_global"


def _find_moodboard_file(root: Path, moodboard_id: str) -> Path | None:
    _validate_moodboard_id(moodboard_id)
    if not root.exists():
        return None
    for sub in root.iterdir():
        # Skip the trash (``.trash``): a deleted board isn't found until restored.
        if not sub.is_dir() or is_trash_folder(sub):
            continue
        candidate = sub / f"{moodboard_id}.json"
        if candidate.exists():
            return candidate
    return None


def board_scopes(root: Path) -> list[Path]:
    """The folders under the moodboard root that hold boards: each scope
    (``_global`` and every project's) and the trash (``.trash``), whose
    boards a restore brings back. Other dot folders are side files kept
    beside the boards (``.notes``: Updates, services/agent_notes.py; later
    ``.history`` and ``.runs``), never boards, so the start-up scans
    (``migrate_store``, ``save_colour_checks``) never rewrite them."""
    from services.asset_trash import TRASH_DIR

    if not root.exists():
        return []
    return sorted(path for path in root.iterdir()
                  if path.is_dir() and (not is_trash_folder(path) or path.name == TRASH_DIR))


def _now_iso() -> str:
    return datetime.now(timezone.utc).isoformat()


def _write_json(path: Path, data: dict[str, Any]) -> None:
    tmp = path.with_suffix(".json.tmp")
    tmp.write_text(json.dumps(data, ensure_ascii=False, indent=2), encoding="utf-8")
    tmp.replace(path)


def _weight(raw: Any, default: float = 1.0) -> float:
    try:
        weight = float(raw)
    except (TypeError, ValueError, OverflowError):
        return default
    return max(0.0, min(1.0, weight)) if weight == weight else default


def _normalize_images(images: list[dict[str, Any]] | None, *, stored: list[Any] | None = None,
                      board: dict[str, Any] | None = None, by: str = "agent") -> list[dict[str, Any]]:
    """Images as saved. Only writes call this, so a bad image is refused rather
    than dropped (a board that silently lost its images looked like a success).

    ``stored`` is the board's images as saved (laid out). Each image is merged
    with the saved image of the same id: a key the client left out keeps its
    saved value, and the saved image's ``placements`` (and any key this
    version doesn't know) are kept whatever the client sent, so a stale tab
    or an echoing CLI can't undo a layout edit. A weight changed here scales
    its cards (section 4.3). An image left out of ``images`` is removed.

    A new image takes the ``placements`` it asks for (checked; ``placedBy``
    is ``by``), else Nebula places it after the last-added card. ``board``
    gives the frames and the saved analysis (for aspect ratios)."""
    from services.stored_image_refs import StoredImageError, board_image_problem

    board = board or {}
    saved: dict[str, deque[dict[str, Any]]] = {}
    # The urls the board holds: not checked again, so a board saved before
    # writes were checked keeps saving (services/stored_image_refs.py).
    held = {str(image.get("url") or "").strip() for image in stored or [] if isinstance(image, dict)}
    for image in stored or []:
        if isinstance(image, dict) and image.get("id"):
            saved.setdefault(str(image["id"]), deque()).append(image)
    measured = layout.analysis_sizes(board.get("analysis"))
    frame_ids = {f.get("id") for f in layout.frames_of(board)}
    now = _now_iso()

    normalized: list[dict[str, Any]] = []
    asked: dict[int, Any] = {}  # index -> the placements a new image asked for
    for index, raw in enumerate(images or []):
        if not isinstance(raw, dict):
            raise ValueError(f"images[{index}] must be an object")
        raw_id = raw.get("id")
        queue = saved.get(str(raw_id)) if raw_id else None
        before = queue.popleft() if queue else None
        sent = {key: raw[key] for key in IMAGE_KEYS if key in raw}
        merged = {**(before or {}), **sent}
        url = str(merged.get("url") or "").strip()
        if not url:
            raise ValueError(f"images[{index}].url is empty")
        # Only Nebula's own files (an upload or an output): the app loads a
        # board's images, so an outside link would make it fetch that site.
        refused = None if url in held else board_image_problem(url, f"images[{index}].url")
        if refused:
            raise StoredImageError(refused)
        image: dict[str, Any] = {
            **(before or {}),
            "id": str(merged.get("id") or uuid4().hex[:12]),
            "url": url,
            "weight": _weight(merged.get("weight", 1.0)),
            "notes": str(merged.get("notes") or ""),
            "privateNote": _private_note(merged.get("privateNote"), index),
            "excluded": bool(merged.get("excluded", False)),
        }
        if before is not None and layout.has_card(before):
            cards = before["placements"]
            if "weight" in sent and image["weight"] != _weight(before.get("weight", 1.0)):
                cards = layout.rescale(cards, image["weight"], layout.image_aspect(image, measured))
            image["placements"] = cards
        elif before is not None:
            # Saved with no card that can be drawn (only a hand-edited or
            # foreign file): Nebula places it, as for a new image.
            image.pop("placements", None)
        elif raw.get("placements"):
            asked[index] = raw["placements"]
        normalized.append(image)

    taken = {str(p.get("id")) for image in normalized for p in layout.cards_of(image)}
    for index, cards in asked.items():
        image = normalized[index]
        aspect = layout.image_aspect(image, measured)
        made = layout.normalize_placements(cards, label=f"images[{index}].placements", aspect=aspect,
                                           frame_ids=frame_ids, taken=taken, placed_by=by, placed_at=now)
        sent_weight = "weight" in (images or [])[index]
        fill = layout.card_weight(image["weight"]) if sent_weight else 1.0
        made = [p if p["weight"] is not None else layout.resized(p, fill, aspect) for p in made]
        if sent_weight:
            made = layout.rescale(made, image["weight"], aspect)
        else:
            # No weight sent: the image weighs what its largest card shows.
            image["weight"] = max(p["weight"] for p in made)
        image["placements"] = made

    unplaced = [i for i, image in enumerate(normalized) if "placements" not in image]
    if unplaced:
        sizes = [layout.size_for(layout.card_weight(normalized[i]["weight"]),
                                 layout.image_aspect(normalized[i], measured)) for i in unplaced]
        # In order, each after the one before: images placed so far, then these.
        corners = layout.place({**board, "images": normalized}, sizes)
        for i, (w, h), (x, y) in zip(unplaced, sizes, corners):
            pid = layout.new_placement_id()
            while pid in taken:
                pid = layout.new_placement_id()
            taken.add(pid)
            normalized[i]["placements"] = [{
                "id": pid, "frameId": None, "x": x, "y": y, "w": w, "h": h,
                "weight": layout.card_weight(normalized[i]["weight"]), "placedBy": by, "placedAt": now}]
    return normalized


def output_image(image: dict[str, Any]) -> dict[str, Any]:
    """An image as generators and the Moodboard node's outputs see it: only
    ``OUTPUT_IMAGE_KEYS`` (never the private note or the layout)."""
    return {key: image[key] for key in OUTPUT_IMAGE_KEYS if key in image}


def cover_image(board: dict[str, Any]) -> dict[str, Any] | None:
    """The image the board opens on: its chosen cover (``coverImageId``)
    when that image is on the board, else image #1; None with no images."""
    images = [img for img in board.get("images") or [] if isinstance(img, dict)]
    chosen = board.get("coverImageId")
    if chosen:
        found = next((img for img in images if str(img.get("id")) == str(chosen)), None)
        if found is not None:
            return found
    return images[0] if images else None


def board_thumbnail(board: dict[str, Any]) -> str:
    """The board's ``thumbnail``: the cover image's url, else #1's, else ""."""
    image = cover_image(board)
    return str(image.get("url") or "") if image else ""


def set_cover(board: dict[str, Any], value: Any) -> None:
    """Set ``coverImageId`` in place (an image id on the board, or None or ""
    for no cover) and the ``thumbnail`` that follows from it. ValueError
    (COVER_REFUSED) for anything else."""
    if value is None or value == "":
        board["coverImageId"] = None
    elif isinstance(value, str) and any(isinstance(img, dict) and str(img.get("id")) == value
                                        for img in board.get("images") or []):
        board["coverImageId"] = value
    else:
        raise ValueError(COVER_REFUSED)
    board["thumbnail"] = board_thumbnail(board)


def follow_cover(board: dict[str, Any]) -> None:
    """After the board's images changed: a cover whose image left the board
    goes (the board opens on #1 again), and ``thumbnail`` follows."""
    chosen = board.get("coverImageId")
    if chosen and not any(isinstance(img, dict) and str(img.get("id")) == str(chosen)
                          for img in board.get("images") or []):
        board["coverImageId"] = None
    board["thumbnail"] = board_thumbnail(board)


def _with_cover(board: dict[str, Any]) -> dict[str, Any]:
    """A board read from disk with ``coverImageId`` (None when it has none, or
    when it names an image no longer on the board) and, when it has a cover,
    that image's ``thumbnail``. A board without a cover keeps its saved
    thumbnail, exactly as before covers."""
    chosen = board.get("coverImageId")
    images = board.get("images") if isinstance(board.get("images"), list) else []
    found = next((img for img in images if isinstance(img, dict) and chosen and str(img.get("id")) == str(chosen)),
                 None)
    if found is not None:
        url = str(found.get("url") or "")
        return board if board.get("thumbnail") == url else {**board, "thumbnail": url}
    if chosen is None and "coverImageId" in board:
        return board
    fixed = {**board, "coverImageId": None}
    if chosen:  # an image an older Nebula took off: the board opens on #1
        first = next((img for img in images if isinstance(img, dict)), None)
        fixed["thumbnail"] = str(first.get("url") or "") if first else ""
    return fixed


def _with_layout_fields(board: dict[str, Any]) -> dict[str, Any]:
    """A board read from disk with its layout fields: ``frames``,
    ``suggestions`` and ``readings`` read as empty when absent. Saved ones are
    checked (section 4.10); a board that fails still opens as saved, and the
    problem is logged."""
    defaults = {"frames": [], "suggestions": [], "readings": {}}
    missing = {key: value for key, value in defaults.items() if key not in board}
    if missing:
        board = {**board, **missing}
    images = board.get("images")
    if len(missing) < len(defaults) or any(isinstance(img, dict) and "placements" in img
                                           for img in (images if isinstance(images, list) else [])):
        try:
            layout.check_board_layout(board)
        except Exception as exc:  # noqa: BLE001 - only logged: whatever a file holds, the board opens
            logging.getLogger(__name__).warning("Moodboard %s: its saved layout is out of bounds: %s",
                                                board.get("id"), exc)
    return board


def _with_image_defaults(board: dict[str, Any]) -> dict[str, Any]:
    """A board read from disk, each image with every field (a board saved
    before private notes reads with an empty one), so a client can tell this
    Nebula keeps them."""
    images = board.get("images")
    if isinstance(images, list) and any(isinstance(img, dict) and "privateNote" not in img for img in images):
        board = {**board, "images": [{**img, "privateNote": ""} if isinstance(img, dict) and "privateNote" not in img
                                     else img for img in images]}
    return board


def _brief():
    from services import moodboard_brief
    return moodboard_brief


def _migrated(board: dict[str, Any], *, layout_board: bool = False) -> dict[str, Any]:
    """A board read from disk, with its brief fields (migrated in memory if
    the startup migration hasn't written them yet), its layout fields and its
    saved summary counting only the images that steer.
    ``layout_board``: also lay it out in memory (an old board gets the grid;
    services/moodboard_layout.ensure_layout). Nothing is written here."""
    board = _with_cover(_with_layout_fields(_with_image_defaults(board)))
    try:
        result = _brief().migrate_board(board)
    except Exception:  # an odd old board still opens, without its migrated fields
        logging.getLogger(__name__).exception("Moodboard %s: brief fields not migrated", board.get("id"))
        result = None
    board = board if result is None else result[0]
    try:
        # A summary saved before weight 0 left the count reads with today's.
        from services.moodboard_analysis import with_steering_count
        board = with_steering_count(board)
    except Exception:  # an odd old analysis still opens, as it was saved
        logging.getLogger(__name__).exception("Moodboard %s: summary not recounted", board.get("id"))
    if layout_board:
        try:
            board = layout.ensure_layout(board)
        except Exception:  # an odd old board still opens, without a layout
            logging.getLogger(__name__).exception("Moodboard %s: not laid out", board.get("id"))
    return board


OVERRIDE_AUTHORS = ("person", "agent")


class NotesOptInProtected(Exception):
    """An agent tried to send the board's notes to generators (gap 18, P4).

    Notes are the person's words about the board, for them, their team and
    agents; whether generators get them is the person's call. An agent may
    turn sending off, never on. Same 403 as ``BriefOverrideProtected``."""


NOTES_OPT_IN_REFUSED = ("Only the person can send this board's notes to generators. Notes stay with "
                        "the person, their team and agents unless the person turns sending on in Studio. "
                        "Leave sendNotes out of the request, or ask the person: propose it with "
                        "propose_asset_change(kind=\"moodboard\", id=<board id>, change={\"sendNotes\": true}, "
                        "note=...) (POST /api/asset-proposals), and they decide in Moodboard Studio.")


def _guard_send_notes(previous: bool, value: Any, by: str) -> None:
    if by != "person" and value is True and not previous:
        raise NotesOptInProtected(NOTES_OPT_IN_REFUSED)


def _set_color_choices(moodboard: dict[str, Any], value: Any, *, sent: bool) -> None:
    """Store ``colorChoices``. Sent with the request, it is checked against
    the board's colours pinned to keep out (an error names the clash); not
    sent, a colour pinned out since just leaves the Keep anyway list (the
    pin is the stronger choice)."""
    brief = _brief()
    kept_out = moodboard["pinnedColors"]["exclude"]
    if sent:
        moodboard["colorChoices"] = brief.normalize_color_choices(value, kept_out)
        return
    _mode, choices, _notes = brief.board_options(moodboard)
    if "colorChoices" in moodboard or choices["keep"] or choices["leaveOut"]:
        choices["keep"] = [hex_value for hex_value in choices["keep"] if hex_value not in kept_out]
        moodboard["colorChoices"] = choices


class BriefOverrideProtected(Exception):
    """An agent tried to replace, clear or Keep the person's hand-written brief.

    The board keeps no history, so the person's text would be gone for good;
    that is the person's call (services/person_gate.py decides who that is)."""


def person_wrote(override: Any) -> bool:
    """Whether a saved override is the person's: anything not stamped
    ``by: "agent"``, including overrides the migration moved from an edited
    brief, which predate the stamp."""
    return (isinstance(override, dict) and bool(str(override.get("text") or "").strip())
            and override.get("by") != "agent")


# How every refusal of the person's brief starts, so the CLI and MCP client
# (moodboard_client.py) can tell it from other 403s and say it in their words.
PERSON_BRIEF_REFUSED = "The person wrote this board's brief by hand"


def _guard_override(previous: Any, by: str, action: str) -> None:
    if by != "person" and person_wrote(previous):
        if action == "keep":
            # Keeping loses nothing; it answers the person's "changed since
            # you edited this" notice, which is theirs to answer.
            raise BriefOverrideProtected(
                f"{PERSON_BRIEF_REFUSED}, so only they can keep it: keeping it clears their notice that the "
                "board changed since they wrote it. Ask the person to keep or regenerate it in Moodboard Studio.")
        raise BriefOverrideProtected(
            f"{PERSON_BRIEF_REFUSED}, so an agent can't {action} it: the board keeps no "
            "history, and their text would be lost. Leave briefOverride out of the request, or ask the person "
            "to change it in Moodboard Studio.")


def _set_override(moodboard: dict[str, Any], value: Any, *, previous: Any, by: str) -> None:
    """Store ``briefOverride`` from ``{"text": ...}`` or None.

    The server keeps ``basis``: new text is stamped with the board as it is
    now; the same text sent again (Moodboard Studio saves the whole draft)
    keeps the basis it had, so "changed since you edited this" survives
    autosave. ``keep_brief_override`` restamps it on purpose.

    ``by`` ("person" or "agent", decided by the route through the person
    gate) is stamped on new text. Only the person may replace or clear text
    the person wrote (BriefOverrideProtected).
    """
    brief = _brief()
    if by not in OVERRIDE_AUTHORS:
        raise ValueError(f"briefOverride author must be one of {OVERRIDE_AUTHORS}")
    if value is None:
        _guard_override(previous, by, "remove")
        moodboard["briefOverride"] = None
        return
    if not isinstance(value, dict):
        raise ValueError("briefOverride must be an object with text, or null")
    unknown = set(value) - {"text"}
    if unknown:
        raise ValueError(f"briefOverride has unknown keys: {', '.join(sorted(unknown))}")
    text = brief.normalize_override_text(value.get("text"))
    if not text:
        _guard_override(previous, by, "remove")
        moodboard["briefOverride"] = None
        return
    if isinstance(previous, dict) and str(previous.get("text") or "").strip() == text:
        moodboard["briefOverride"] = previous
        return
    _guard_override(previous, by, "replace")
    moodboard["briefOverride"] = {"text": text, "basis": brief.brief_basis(moodboard), "updatedAt": _now_iso(),
                                  "by": by}


def apply_fields(moodboard: dict[str, Any], fields: dict[str, Any], *, by: str) -> None:
    """Set a board's own fields (a PUT's, and a ``restore``'s ``fields``
    slice, services/moodboard_edits.py) on ``moodboard`` in place, checked
    and normalized. ``by`` matters for ``briefOverride`` and for turning
    ``sendNotes`` on (BriefOverrideProtected, NotesOptInProtected); other
    bad values are a ValueError. The caller refreshes the colour check and
    stamps the version."""
    from services.stored_image_refs import board_held_urls, check_board_analysis

    brief = _brief()
    fields = dict(fields)
    immutable = {"id", "createdAt", "projectId"}
    # What the board holds before this write (its images and its analysis's):
    # an analysis sent back as it was read isn't checked again.
    held = board_held_urls(moodboard)
    override_sent = "briefOverride" in fields
    override_value = fields.pop("briefOverride", None)
    if "sendNotes" in fields:
        _guard_send_notes(moodboard.get("sendNotes") is True, fields["sendNotes"], by)
    choices_sent = fields.get("colorChoices") is not None
    choices_value = fields.pop("colorChoices", None)
    cover_sent = "coverImageId" in fields
    cover_value = fields.pop("coverImageId", None)
    for key, value in fields.items():
        if key in immutable:
            if value is not None and value != moodboard.get(key):
                if key == "projectId":
                    raise ValueError("projectId can't change in an edit: move the board with "
                                     f"POST /api/moodboards/{moodboard.get('id')}/move")
                raise ValueError(f"{key} can't change")
            continue
        if key == "images":
            moodboard[key] = _normalize_images(value, stored=moodboard.get("images"), board=moodboard, by=by)
            follow_cover(moodboard)
        elif key == "mode":
            if value not in _VALID_MODES:
                raise ValueError(f"invalid moodboard mode: {value!r}")
            moodboard[key] = value
        elif key == "strength":
            moodboard[key] = max(0.0, min(1.0, float(value)))
        elif key == "analysis":
            check_board_analysis(value, held)
            moodboard[key] = _normalize_analysis(value)
        elif key == "direction":
            moodboard[key] = brief.normalize_direction(value)
        elif key == "avoid":
            moodboard[key] = brief.normalize_avoid(value)
        elif key == "pinnedColors":
            moodboard[key] = brief.normalize_pinned_colors(value)
        elif key == "clashMode":
            if value is not None:
                moodboard[key] = brief.normalize_clash_mode(value)
        elif key == "sendNotes":
            if value is not None:
                moodboard[key] = brief.normalize_send_notes(value)
        elif key in {"brief", "briefVersion", "colorCheck"}:
            continue  # computed / owned by the store
        elif value is not None:
            moodboard[key] = value
    # After the images, so a cover is checked against the board's new list.
    if cover_sent:
        set_cover(moodboard, cover_value)
    # After the pins, so a Keep anyway colour is checked against them.
    _set_color_choices(moodboard, choices_value, sent=choices_sent)
    # Last, so new override text is stamped with the board as updated.
    if override_sent:
        _set_override(moodboard, override_value, previous=moodboard.get("briefOverride"), by=by)


def _stamp_layout(moodboard: dict[str, Any]) -> None:
    """Stamp ``layoutVersion`` on a board a write is about to save, but only
    when every image has a card: if laying the board out failed in memory,
    stamping would make the next read take the cards as saved (none) rather
    than lay the board out again."""
    if layout.is_laid_out(moodboard):
        moodboard["layoutVersion"] = LAYOUT_VERSION


def _refuse_layout_fields(fields: dict[str, Any]) -> None:
    sent = [key for key in LAYOUT_BOARD_KEYS if key in fields]
    if sent:
        raise ValueError(f"{', '.join(sent)} {LAYOUT_REFUSED}")


def _normalize_analysis(analysis: dict[str, Any] | None) -> dict[str, Any] | None:
    if analysis is None:
        return None
    if not isinstance(analysis, dict):
        raise ValueError("analysis must be an object")
    return dict(analysis)


class MoodboardStore:
    """CRUD store for native Nebula moodboards backed by JSON files."""

    def create(
        self,
        name: str,
        images: list[dict[str, Any]] | None = None,
        notes: str = "",
        mode: str = "look",
        strength: float = 0.7,
        analysis: dict[str, Any] | None = None,
        projectId: str | None = None,
        direction: str = "",
        avoid: list[str] | None = None,
        pinnedColors: dict[str, Any] | None = None,
        briefOverride: dict[str, Any] | None = None,
        clashMode: str | None = None,
        colorChoices: dict[str, Any] | None = None,
        sendNotes: bool | None = None,
        coverImageId: str | None = None,
        by: str = "agent",
        **extra: Any,
    ) -> dict[str, Any]:
        """A new board. Its images are laid out from the start (the cards
        they ask for, else placed by Nebula), so it is saved with
        ``layoutVersion``. ``by`` ("person" or "agent") stamps the cards and
        any hand-written brief. ``coverImageId`` names one of ``images`` by
        id (the board opens on it); left out, it opens on #1."""
        brief = _brief()
        _guard_send_notes(False, sendNotes, by)
        name = str(name or "").strip()
        if not name:
            raise ValueError("name is required")
        if mode not in _VALID_MODES:
            raise ValueError(f"invalid moodboard mode: {mode!r}")
        try:
            strength_value = max(0.0, min(1.0, float(strength)))
        except (TypeError, ValueError):
            strength_value = 0.7

        _refuse_layout_fields(extra)
        if extra:
            raise TypeError(f"create() got unexpected keyword arguments: {', '.join(sorted(extra))}")
        if by not in OVERRIDE_AUTHORS:
            raise ValueError(f"author must be one of {OVERRIDE_AUTHORS}")
        moodboard_id = uuid4().hex[:12]
        now = _now_iso()
        normalized_images = _normalize_images(images, by=by)
        from services.stored_image_refs import check_board_analysis
        check_board_analysis(analysis)
        moodboard: dict[str, Any] = {
            "id": moodboard_id,
            "name": name,
            "version": 1,
            "images": normalized_images,
            "notes": str(notes or ""),
            "mode": mode,
            "strength": strength_value,
            "analysis": _normalize_analysis(analysis),
            "direction": brief.normalize_direction(direction),
            "avoid": brief.normalize_avoid(avoid),
            "pinnedColors": brief.normalize_pinned_colors(pinnedColors),
            "briefOverride": None,
            "briefVersion": brief.BRIEF_FIELDS_VERSION,
            "clashMode": brief.normalize_clash_mode(clashMode),
            "sendNotes": brief.normalize_send_notes(sendNotes),
            "layoutVersion": LAYOUT_VERSION,
            "frames": [],
            "suggestions": [],
            "readings": {},
            "coverImageId": None,
            "thumbnail": normalized_images[0]["url"] if normalized_images else "",
            "projectId": projectId,
            "createdAt": now,
            "updatedAt": now,
        }
        set_cover(moodboard, coverImageId)
        _set_color_choices(moodboard, colorChoices, sent=True)
        _set_override(moodboard, briefOverride, previous=None, by=by)
        brief.refresh_colour_check(moodboard)

        root = _moodboard_root()
        scope_dir = _scope_dir(root, projectId)
        scope_dir.mkdir(parents=True, exist_ok=True)
        _write_json(scope_dir / f"{moodboard_id}.json", moodboard)
        return moodboard

    def get(self, moodboard_id: str, *, laid_out: bool = True) -> dict[str, Any] | None:
        """A board as saved, laid out in memory (an old board reads with
        the grid it will be saved with on its next edit). ``laid_out=False``
        skips that, for readers that never look at the layout (the
        Moodboard node). Reading writes nothing."""
        path = _find_moodboard_file(_moodboard_root(), moodboard_id)
        if path is None:
            return None
        return _migrated(json.loads(path.read_text(encoding="utf-8")), layout_board=laid_out)

    def list(self, scope: str, projectId: str | None = None) -> list[dict[str, Any]]:
        root = _moodboard_root()
        if scope == "project":
            if not projectId:
                raise ValueError("projectId is required for scope='project'")
            _validate_project_id(projectId)
            target_dir = root / projectId
        else:
            target_dir = root / "_global"

        if not target_dir.exists():
            return []

        results: list[dict[str, Any]] = []
        for path in sorted(target_dir.glob("*.json")):
            try:
                results.append(_migrated(json.loads(path.read_text(encoding="utf-8"))))
            except (json.JSONDecodeError, OSError):
                continue
        return results

    def summaries(self) -> list[dict[str, Any]]:
        """Every board in every scope as one short row, newest edit first.

        For an agent's first call (GET /api/agent/start): `id`, `name`,
        `projectId` (the folder it is listed in; None for Global), `images`
        (how many), `analyzed` (it has an analysis; changing the images
        clears it) and `direction`, plus `updatedAt`. It reads each board's
        file and nothing else: never an image, and no notes or private
        notes leave here. Dot folders (`.trash`, side files) are skipped, so
        a board in Recently deleted isn't listed."""
        root = _moodboard_root()
        if not root.exists():
            return []
        rows: list[dict[str, Any]] = []
        for scope in sorted(root.iterdir()):
            if not scope.is_dir() or is_trash_folder(scope):
                continue
            project_id = None if scope.name == "_global" else scope.name
            if project_id is not None and not _PROJECT_ID_RE.fullmatch(project_id):
                continue
            for path in sorted(scope.glob("*.json")):
                try:
                    board = json.loads(path.read_text(encoding="utf-8"))
                except (OSError, ValueError):
                    continue
                if not isinstance(board, dict) or not isinstance(board.get("id"), str):
                    continue
                images = board.get("images")
                rows.append({
                    "id": board["id"],
                    "name": str(board.get("name") or board["id"]),
                    "projectId": project_id,
                    "images": sum(1 for image in images if isinstance(image, dict)) if isinstance(images, list) else 0,
                    "analyzed": bool(board.get("analysis")),
                    "direction": str(board.get("direction") or ""),
                    "updatedAt": board.get("updatedAt") if isinstance(board.get("updatedAt"), str) else None,
                })
        rows.sort(key=lambda row: row["updatedAt"] or "", reverse=True)
        return rows

    def update(self, moodboard_id: str, *, by: str = "agent", base_version: int | None = None,
               **fields: Any) -> dict[str, Any]:
        """Change a board's fields. ``by`` is who asked ("person" only when the
        route's person gate says so); it matters for ``briefOverride``, for
        turning ``sendNotes`` on (NotesOptInProtected, before anything is
        written), and it stamps the cards of new images (``placedBy``).
        ``base_version``: the version the caller read; any other refuses the
        write (VersionConflict).

        ``images`` merges by id (see ``_normalize_images``). The board is
        laid out before the change, so an old board's first write saves the
        grid it read with and stamps ``layoutVersion``: nothing moves. The
        saved colour check (``colorCheck``) is the store's: a sent one is
        ignored, and it is refreshed when what it reads moved."""
        return self.update_with_before(moodboard_id, by=by, base_version=base_version, **fields)[1]

    def update_with_before(self, moodboard_id: str, *, by: str = "agent", base_version: int | None = None,
                           **fields: Any) -> tuple[dict[str, Any], dict[str, Any]]:
        """``update``, returning the board before the change too (laid out,
        as it was read), so the route can journal what changed."""
        if by not in OVERRIDE_AUTHORS:
            raise ValueError(f"author must be one of {OVERRIDE_AUTHORS}")
        _refuse_layout_fields(fields)
        path = _find_moodboard_file(_moodboard_root(), moodboard_id)
        if path is None:
            raise KeyError(f"Moodboard {moodboard_id} not found")
        with _board_lock(moodboard_id):
            return self._update(path, by=by, base_version=base_version, fields=fields)

    def _update(self, path: Path, *, by: str, base_version: int | None,
                fields: dict[str, Any]) -> tuple[dict[str, Any], dict[str, Any]]:
        moodboard_id = path.stem
        moodboard = _read_for_write(path, moodboard_id)
        _check_base_version(moodboard, base_version)
        before = json.loads(json.dumps(moodboard))
        apply_fields(moodboard, fields, by=by)
        _brief().refresh_colour_check(moodboard)

        _stamp_layout(moodboard)
        moodboard["version"] = int(moodboard.get("version", 1)) + 1
        moodboard["updatedAt"] = _now_iso()
        _write_json(path, moodboard)
        return before, moodboard

    def apply_edits(self, moodboard_id: str, ops: Any, *, by: str = "agent",
                    base_version: int | None = None) -> tuple[dict[str, Any], dict[str, Any], Any]:
        """Apply a batch of board edits (services/moodboard_edits.py) and save
        it once with ``version + 1``: every op lands, or none does
        (moodboard_edits.EditError, nothing written). Returns ``(before,
        after, result)``; ``result`` has ``applied``, ``undo``, ``touched``
        and the journal's ``changes``.

        A batch that changes nothing (sent again, or a ``restore`` of
        slices that all changed since) writes nothing and keeps the
        version, so an old board's file keeps its bytes. ``by`` ("person",
        "agent" or "analyze") stamps new cards and frames. KeyError: no live
        board; VersionConflict: ``base_version`` isn't the board's."""
        from services import moodboard_edits

        if by not in (*OVERRIDE_AUTHORS, "analyze"):
            raise ValueError(f"author must be one of {OVERRIDE_AUTHORS} or analyze")
        moodboard_edits.parse_ops(ops)  # a bad batch is refused before the board is read
        path = _find_moodboard_file(_moodboard_root(), moodboard_id)
        if path is None:
            raise KeyError(f"Moodboard {moodboard_id} not found")
        with _board_lock(moodboard_id):
            moodboard = _read_for_write(path, moodboard_id)
            _check_base_version(moodboard, base_version)
            try:
                result = moodboard_edits.apply_edits(moodboard, ops, by=by)
            except KeyError as exc:
                # A bug in an op, not a missing board: the route mustn't say "not found".
                raise RuntimeError(f"a board edit failed: {exc!r}") from exc
            if not result.changed:
                return moodboard, moodboard, result
            board = result.board
            # The colour check reads the analysis, which a steering edit cleared.
            _brief().refresh_colour_check(board)
            _stamp_layout(board)
            board["version"] = int(moodboard.get("version", 1)) + 1
            board["updatedAt"] = _now_iso()
            _write_json(path, board)
            result.board = board
            return moodboard, board, result

    def keep_brief_override(self, moodboard_id: str, *, by: str = "agent") -> dict[str, Any]:
        """Keep the hand-written brief for the board as it is now: the
        "changed since you edited this" notice goes until the board changes again.

        KeyError when there is no such board (or the id isn't one a board can
        have); ValueError when the board has no hand-written brief;
        BriefOverrideProtected when an agent asks to keep the person's text
        (Keep or Regenerate is the person's answer to that notice)."""
        try:
            path = _find_moodboard_file(_moodboard_root(), moodboard_id)
        except ValueError:
            raise KeyError(f"Moodboard {moodboard_id} not found") from None
        if path is None:
            raise KeyError(f"Moodboard {moodboard_id} not found")
        with _board_lock(moodboard_id):
            return self._keep_brief_override(path, by=by)

    def _keep_brief_override(self, path: Path, *, by: str) -> dict[str, Any]:
        moodboard = _migrated(json.loads(path.read_text(encoding="utf-8")), layout_board=True)
        override = moodboard.get("briefOverride")
        if not isinstance(override, dict) or not str(override.get("text") or "").strip():
            raise ValueError("This board has no hand-written brief to keep. To write one, send "
                             "briefOverride: {\"text\": ...} with PUT /api/moodboards/{id}.")
        _guard_override(override, by, "keep")
        moodboard["briefOverride"] = {**override, "basis": _brief().brief_basis(moodboard), "updatedAt": _now_iso()}
        _stamp_layout(moodboard)
        moodboard["version"] = int(moodboard.get("version", 1)) + 1
        moodboard["updatedAt"] = _now_iso()
        _write_json(path, moodboard)
        return moodboard

    def move(self, moodboard_id: str, projectId: str | None) -> tuple[dict[str, Any], dict[str, Any], bool]:
        """File a board under canvas project ``projectId`` (None: Global) and
        return ``(before, after, moved)``. Only ``projectId`` changes: ``id``,
        ``version`` and ``updatedAt`` stay, since a move isn't an edit
        (services/asset_project_rehome.move_asset). ``moved`` is False when it
        was already there. The caller checks ``projectId`` is a live canvas
        project (main.py). KeyError: no live board with that id (one in
        Recently deleted isn't live); FileExistsError: a different file with
        this id is already in the target folder."""
        from services.asset_project_rehome import GLOBAL_DIR, move_asset

        root = _moodboard_root()
        path = _find_moodboard_file(root, moodboard_id)
        if path is None:
            raise KeyError(f"Moodboard {moodboard_id} not found")
        target = projectId or None
        _scope_dir(root, target)  # refuses an unsafe id before any path is built from it
        # Two live copies (a re-home that skipped a collision leaves one in an
        # old folder): which one is "the" asset isn't ours to guess.
        copies = sorted(sub.name for sub in root.iterdir()
                        if sub.is_dir() and not is_trash_folder(sub) and (sub / f"{moodboard_id}.json").is_file())
        if len(copies) > 1:
            raise FileExistsError(f"there is a copy with this id in each of {', '.join(copies)}")
        # The file moves as saved (move_asset changes only projectId), so an
        # old board stays unlaid-out on disk; the board returned is laid out
        # in memory, as get() reads it.
        before = _migrated(json.loads(path.read_text(encoding="utf-8")))
        if (before.get("projectId") or None) == target and path.parent.name == (target or GLOBAL_DIR):
            return before, _migrated(json.loads(path.read_text(encoding="utf-8")), layout_board=True), False
        moved_to = move_asset("moodboard", root, path, target)
        return before, _migrated(json.loads(moved_to.read_text(encoding="utf-8")), layout_board=True), True

    def delete(self, moodboard_id: str, deleted_by: dict[str, Any] | None = None) -> dict[str, Any]:
        """Move the board to Recently deleted (services/asset_trash.py) and
        return the trash record. ``deleted_by`` is who asked, as
        services/canvas_events.actor_record gives it."""
        root = _moodboard_root()
        path = _find_moodboard_file(root, moodboard_id)
        if path is None:
            raise KeyError(f"Moodboard {moodboard_id} not found")
        return asset_trash.move_to_trash(root, path, kind="moodboard", deleted_by=deleted_by)

    # -- Recently deleted --------------------------------------------------

    def trashed(self, moodboard_id: str) -> dict[str, Any] | None:
        """The trash record when this board is in Recently deleted, else None."""
        _validate_moodboard_id(moodboard_id)
        return asset_trash.trashed(_moodboard_root(), moodboard_id)

    def list_trash(self, scope: str | None = None, projectId: str | None = None) -> list[dict[str, Any]]:
        if projectId is not None:
            _validate_project_id(projectId)
        return asset_trash.list_trashed(_moodboard_root(), scope=scope, project_id=projectId)

    def restore(self, moodboard_id: str) -> dict[str, Any]:
        """Bring a trashed board back with the same id and contents."""
        _validate_moodboard_id(moodboard_id)
        return asset_trash.restore(_moodboard_root(), moodboard_id)

    def purge(self, moodboard_id: str) -> None:
        """Delete a trashed board for good. Only the person may (main.py)."""
        _validate_moodboard_id(moodboard_id)
        asset_trash.purge(_moodboard_root(), moodboard_id)
        # Its Updates go with it (services/agent_notes.py); Recently deleted
        # kept them, since a restore brings the same id back.
        (_moodboard_root() / ".notes" / f"{moodboard_id}.json").unlink(missing_ok=True)


def migrate_brief_fields() -> dict[str, Any]:
    """Give every saved board its brief fields, once (decision B7).

    Each board file is backed up to ``<moodboards>/../moodboard-backups/
    brief-fields-<time>/`` before it changes, with ``migration-log.json``
    saying what moved. Already-migrated boards are skipped.
    """
    root = _moodboard_root()
    return _brief().migrate_store(root, root.parent / "moodboard-backups")


def save_colour_checks() -> dict[str, Any]:
    """Save the colour check on boards that lack a current one (gap 18):
    boards saved before it, or after a lexicon change. Run at startup after
    ``migrate_brief_fields``."""
    return _brief().save_colour_checks(_moodboard_root())
