"""MoodboardStore - project-scoped & global native Nebula moodboards.

On-disk layout mirrors CharacterStore:
    MOODBOARD_ROOT/<projectId>/<id>.json
    MOODBOARD_ROOT/_global/<id>.json
    MOODBOARD_ROOT/.trash/          deleted boards (services/asset_trash.py)

Moodboards are provider-neutral creative-direction assets. They can later be
adapted to Krea, GPT Image, Gemini, Seedream, etc. without changing the saved
resource shape.

The person's brief fields (``direction``, ``avoid``, ``pinnedColors``,
``briefOverride``) sit on the board beside ``analysis``, so analyzing again
never drops them; services/moodboard_brief.py describes them. A board saved
before they existed is migrated once (``briefVersion``).

Each image may carry a ``privateNote``: the person's own label ("PAINTERLY
(liked)"). It is for whoever looks at the board, the person or an agent, and
nothing else: it isn't an analysis input (``source_hash`` leaves it out), and
it never reaches the brief, a generator or the Moodboard node's outputs
(``without_private``). The image's ``notes`` are the ones that steer.
"""
from __future__ import annotations

import json
import logging
import os
import re
from datetime import datetime, timezone
from pathlib import Path
from typing import Any
from uuid import uuid4

from services import asset_trash
from services.asset_trash import is_trash_folder

_PROJECT_ID_RE = re.compile(r"^[A-Za-z0-9_-]{1,64}$")
_MOODBOARD_ID_RE = re.compile(r"^[A-Za-z0-9_-]{1,64}$")
_VALID_MODES = {"look", "world", "subject"}
# The longest private note an image keeps (Moodboard Studio stops typing there).
PRIVATE_NOTE_LIMIT = 2000
# Image fields that are the person's alone: never sent to the analysis, the
# brief, a generator or a node's outputs.
PRIVATE_IMAGE_KEYS = ("privateNote",)


def without_private(image: dict[str, Any]) -> dict[str, Any]:
    """An image as anything that steers or generates may see it."""
    return {key: value for key, value in image.items() if key not in PRIVATE_IMAGE_KEYS}


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


def _now_iso() -> str:
    return datetime.now(timezone.utc).isoformat()


def _write_json(path: Path, data: dict[str, Any]) -> None:
    tmp = path.with_suffix(".json.tmp")
    tmp.write_text(json.dumps(data, ensure_ascii=False, indent=2), encoding="utf-8")
    tmp.replace(path)


def _normalize_images(images: list[dict[str, Any]] | None) -> list[dict[str, Any]]:
    """Images as saved. Only writes call this, so a bad image is refused rather
    than dropped (a board that silently lost its images looked like a success)."""
    normalized: list[dict[str, Any]] = []
    for index, raw in enumerate(images or []):
        if not isinstance(raw, dict):
            raise ValueError(f"images[{index}] must be an object")
        url = str(raw.get("url") or "").strip()
        if not url:
            raise ValueError(f"images[{index}].url is empty")
        image_id = str(raw.get("id") or uuid4().hex[:12])
        weight_raw = raw.get("weight", 1.0)
        try:
            weight = max(0.0, min(1.0, float(weight_raw)))
        except (TypeError, ValueError):
            weight = 1.0
        normalized.append({
            "id": image_id,
            "url": url,
            "weight": weight,
            "notes": str(raw.get("notes") or ""),
            "privateNote": _private_note(raw.get("privateNote"), index),
            "excluded": bool(raw.get("excluded", False)),
        })
    return normalized


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


def _migrated(board: dict[str, Any]) -> dict[str, Any]:
    """A board read from disk, with its brief fields (migrated in memory if
    the startup migration hasn't written them yet)."""
    board = _with_image_defaults(board)
    try:
        result = _brief().migrate_board(board)
    except Exception:  # an odd old board still opens, without its migrated fields
        logging.getLogger(__name__).exception("Moodboard %s: brief fields not migrated", board.get("id"))
        return board
    return board if result is None else result[0]


OVERRIDE_AUTHORS = ("person", "agent")


class NotesOptInProtected(Exception):
    """An agent tried to send the board's notes to generators (gap 18, P4).

    Notes are the person's words about the board, for them, their team and
    agents; whether generators get them is the person's call. An agent may
    turn sending off, never on. Same 403 as ``BriefOverrideProtected``."""


NOTES_OPT_IN_REFUSED = ("Only the person can send this board's notes to generators. Notes stay with "
                        "the person, their team and agents unless the person turns sending on in Studio. "
                        "Leave sendNotes out of the request, or ask the person (propose it).")


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
        by: str = "agent",
    ) -> dict[str, Any]:
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

        moodboard_id = uuid4().hex[:12]
        now = _now_iso()
        normalized_images = _normalize_images(images)
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
            "thumbnail": normalized_images[0]["url"] if normalized_images else "",
            "projectId": projectId,
            "createdAt": now,
            "updatedAt": now,
        }
        _set_color_choices(moodboard, colorChoices, sent=True)
        _set_override(moodboard, briefOverride, previous=None, by=by)
        brief.refresh_colour_check(moodboard)

        root = _moodboard_root()
        scope_dir = _scope_dir(root, projectId)
        scope_dir.mkdir(parents=True, exist_ok=True)
        _write_json(scope_dir / f"{moodboard_id}.json", moodboard)
        return moodboard

    def get(self, moodboard_id: str) -> dict[str, Any] | None:
        path = _find_moodboard_file(_moodboard_root(), moodboard_id)
        if path is None:
            return None
        return _migrated(json.loads(path.read_text(encoding="utf-8")))

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

    def update(self, moodboard_id: str, *, by: str = "agent", **fields: Any) -> dict[str, Any]:
        """Change a board's fields. ``by`` is who asked ("person" only when the
        route's person gate says so); it matters for ``briefOverride`` and for
        turning ``sendNotes`` on (NotesOptInProtected, before anything is
        written). The saved colour check (``colorCheck``) is the store's: a
        sent one is ignored, and it is refreshed when what it reads moved."""
        path = _find_moodboard_file(_moodboard_root(), moodboard_id)
        if path is None:
            raise KeyError(f"Moodboard '{moodboard_id}' not found")
        moodboard = _migrated(json.loads(path.read_text(encoding="utf-8")))
        brief = _brief()

        immutable = {"id", "createdAt", "projectId"}
        override_sent = "briefOverride" in fields
        override_value = fields.pop("briefOverride", None)
        if "sendNotes" in fields:
            _guard_send_notes(moodboard.get("sendNotes") is True, fields["sendNotes"], by)
        choices_sent = fields.get("colorChoices") is not None
        choices_value = fields.pop("colorChoices", None)
        for key, value in fields.items():
            if key in immutable:
                if value is not None and value != moodboard.get(key):
                    if key == "projectId":
                        raise ValueError("projectId can't change in an edit: move the board with "
                                         f"POST /api/moodboards/{moodboard_id}/move")
                    raise ValueError(f"{key} can't change")
                continue
            if key == "images":
                moodboard[key] = _normalize_images(value)
                moodboard["thumbnail"] = moodboard[key][0]["url"] if moodboard[key] else ""
            elif key == "mode":
                if value not in _VALID_MODES:
                    raise ValueError(f"invalid moodboard mode: {value!r}")
                moodboard[key] = value
            elif key == "strength":
                moodboard[key] = max(0.0, min(1.0, float(value)))
            elif key == "analysis":
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
        # After the pins, so a Keep anyway colour is checked against them.
        _set_color_choices(moodboard, choices_value, sent=choices_sent)
        # Last, so new override text is stamped with the board as updated.
        if override_sent:
            _set_override(moodboard, override_value, previous=moodboard.get("briefOverride"), by=by)
        brief.refresh_colour_check(moodboard)

        moodboard["version"] = int(moodboard.get("version", 1)) + 1
        moodboard["updatedAt"] = _now_iso()
        _write_json(path, moodboard)
        return moodboard

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
            raise KeyError(f"Moodboard '{moodboard_id}' not found") from None
        if path is None:
            raise KeyError(f"Moodboard '{moodboard_id}' not found")
        moodboard = _migrated(json.loads(path.read_text(encoding="utf-8")))
        override = moodboard.get("briefOverride")
        if not isinstance(override, dict) or not str(override.get("text") or "").strip():
            raise ValueError("This board has no hand-written brief to keep. To write one, send "
                             "briefOverride: {\"text\": ...} with PUT /api/moodboards/{id}.")
        _guard_override(override, by, "keep")
        moodboard["briefOverride"] = {**override, "basis": _brief().brief_basis(moodboard), "updatedAt": _now_iso()}
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
            raise KeyError(f"Moodboard '{moodboard_id}' not found")
        target = projectId or None
        _scope_dir(root, target)  # refuses an unsafe id before any path is built from it
        # Two live copies (a re-home that skipped a collision leaves one in an
        # old folder): which one is "the" asset isn't ours to guess.
        copies = sorted(sub.name for sub in root.iterdir()
                        if sub.is_dir() and not is_trash_folder(sub) and (sub / f"{moodboard_id}.json").is_file())
        if len(copies) > 1:
            raise FileExistsError(f"there is a copy with this id in each of {', '.join(copies)}")
        before = _migrated(json.loads(path.read_text(encoding="utf-8")))
        if (before.get("projectId") or None) == target and path.parent.name == (target or GLOBAL_DIR):
            return before, before, False
        moved_to = move_asset("moodboard", root, path, target)
        return before, _migrated(json.loads(moved_to.read_text(encoding="utf-8"))), True

    def delete(self, moodboard_id: str, deleted_by: dict[str, Any] | None = None) -> dict[str, Any]:
        """Move the board to Recently deleted (services/asset_trash.py) and
        return the trash record. ``deleted_by`` is who asked, as
        services/canvas_events.actor_record gives it."""
        root = _moodboard_root()
        path = _find_moodboard_file(root, moodboard_id)
        if path is None:
            raise KeyError(f"Moodboard '{moodboard_id}' not found")
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


def migrate_brief_fields() -> dict[str, Any]:
    """Give every saved board its brief fields, once (decision B7).

    Each board file is backed up to ``<moodboards>/../moodboard-backups/
    brief-fields-<time>/`` before it changes, with ``migration-log.json``
    saying what moved. Already-migrated boards are skipped.
    """
    root = _moodboard_root()
    return _brief().migrate_store(root, root.parent / "moodboard-backups")
