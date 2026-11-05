"""What an agent did to a moodboard, in the words the Agent log shows.

Graph edits narrate themselves through the agent's cursor ("Added Moodboard",
"Running Krea 2"). A board write has no place on the canvas, so main.py sends
the same ``agentPresence`` event without a target (``_say_agent_action``) and
these helpers write its ``say``. Only the agent's own action is named, never
what the person wrote: a private note is "private note changed", not its text.

One set of words for the Agent log, the cursor's say and the journal, written
once in ``services/moodboard_edits`` (GM - Design, PR #233): a board or a
project is its curly name ("Added image 3 to “Dusk”", never "board Dusk"), an
image is "image 3" in a sentence ("#3" is for badges and chips), clauses join
with "and", a field is a quoted label ("Changed “Direction” on “Dusk” and
turned off “Send notes”"), and an undo is "Undid a change to “Dusk”". A say
has no period. The journal's summary is the same phrase, lower-case, since
the actor's name leads it.

A change to a board (an edit batch or a ``PUT``) is said in ``journal_entry``'s
summary, so the Agent log and the journal never describe one change two
ways. Only Send notes says which way it went here ("turned off"), since the
journal names fields, never values. The lines for writes the journal has no
event for (make, Analyze, Keep, move, delete, restore) name the board through
the same ``board_where``.
"""
from __future__ import annotations

from typing import Any, Mapping

from services.cursor_actions import PART_LABELS
from services.moodboard_edits import (board_where, cover_words, field_label, image_count_words, journal_entry,
                                      listed_words, quoted)


def _field_words(changes: Mapping[str, Any], entry: Mapping[str, Any] | None,
                 after: Mapping[str, Any]) -> list[str]:
    """The board fields the change set, from its ``fields`` slice, in the
    words of the ``board.fields`` journal event (moodboard_edits.fields_entry),
    except that the Agent log line also says which way Send notes went (an
    agent can only turn it off)."""
    fields = next((item for item in changes.get("slices") or [] if item.get("part") == "fields"), None)
    if not fields:
        return []
    keys = list((fields.get("expect") or {}).keys())
    words: list[str] = []
    if "coverImageId" in keys:
        # Said with the image's number, not as a field: "made #3 the cover",
        # or after a removal took it, "the cover is #1 again". The journal's
        # own summary already says it when the cover is all that changed.
        keys = [key for key in keys if key != "coverImageId"]
        if entry is None or entry.get("kind") != "board.cover":
            words.append(cover_words(after))
    changed = [key for key in keys if key != "sendNotes"]
    if changed:
        words.append("changed " + listed_words([field_label(key) for key in changed]))
    if "sendNotes" in keys:
        words.append(f"turned {'on' if fields['expect']['sendNotes'] else 'off'} {field_label('sendNotes')}")
    return words


def _sentence(said: str) -> str:
    return said[0].upper() + said[1:]


def describe_change(changes: Mapping[str, Any], before: Mapping[str, Any], after: Mapping[str, Any], *,
                    undo: bool = False) -> str:
    """One line for a board change (``moodboard_edits.diff``'s): the journal's
    summary, "Set aside image 1 on “Dusk”", with the fields it doesn't name,
    joined with "and". ``undo``: the change was an undo (a batch of
    ``restore`` ops), which otherwise reads like the change it undid, so it
    says only "Undid a change to “Dusk”"."""
    where = board_where(after, before)
    if undo:
        return f"Undid a change to {where}"
    entry = journal_entry(dict(changes), dict(before), dict(after))
    fields = _field_words(changes, entry, after)
    if entry is not None:
        said = _joined([entry["summary"], *fields])
    elif fields:  # the board named once, on the first clause
        said = _joined([f"{fields[0]} on {where}", *fields[1:]])
    else:  # a nudge under 8 px, a card's own change
        said = f"edited {where}"
    return _sentence(said)


def _joined(clauses: list[str]) -> str:
    """Clauses of one line, joined with "and" (never a semicolon)."""
    return " and ".join(clauses)


def describe_create(board: Mapping[str, Any]) -> str:
    count = len(board.get("images") or [])
    return f"Made {board_where(board)}" + (f" with {image_count_words(count)}" if count else "")


def describe_write(verb: str, board: Mapping[str, Any] | None, rest: str = "") -> str:
    """A board write the journal has no event for: "Analyzed “Dusk”", "Kept
    the brief for “Dusk”", "Restored “Dusk”". ``rest`` follows the board."""
    return _sentence(" ".join(part for part in (verb, board_where(board), rest) if part))


def describe_move(board: Mapping[str, Any] | None, to: str) -> str:
    """"Moved “Dusk” to “Global”": ``to`` is the project's name, or "Global"."""
    return describe_write("moved", board, f"to {quoted(to)}")


# -- where a board write puts the agent's cursor (Phase 3, "Anywhere") --------------
#
# A board write shows on the person's screen as the agent's cursor on the
# board, the image or the control it touched, with the line above as its say.
# GM - Design's table (PR #233 r4):
#
#   create, move, restore ......... the board, click
#   add, place, set aside ......... the one image touched, else the board, click
#   remove ........................ the image, click (the cursor holds that spot)
#   weight ........................ image:weight, click
#   note .......................... image:note, type
#   name, direction, avoid ........ board:name, :direction, :avoid, type
#   pins (a toggle) ............... board:colors, click
#   analyze ....................... board:colors, look
#   keep the brief ................ board:direction, click
#   delete ........................ no target; the board's cursors leave
#
# Anything else (the cover, frames, mode, strength, notes) is the board or
# the one image, click; a write that touches several things is the board.

# A board field's part and action (the rest have none: the board itself).
FIELD_PARTS: dict[str, tuple[str, str]] = {
    "name": ("name", "type"),
    "direction": ("direction", "type"),
    "avoid": ("avoid", "type"),
    "pinnedColors": ("colors", "click"),
}
_IMAGE_KINDS = ("added", "removed", "grouped", "setAside", "resized", "noted", "moved", "cover")


def board_anchor(board: Mapping[str, Any] | None, image_id: str | None = None, part: str | None = None, *,
                 also: Mapping[str, Any] | None = None) -> tuple[dict[str, Any], dict[str, Any]]:
    """The anchor for a board item and the names to show for it
    (``agent_presence.parse_surface_target``'s two results). ``also`` is the
    board as it was, for the number of an image that is no longer on it."""
    board_id = str((board or also or {}).get("id") or "")
    name = " ".join(str((board or {}).get("name") or (also or {}).get("name") or board_id).split())[:80]
    target: dict[str, Any] = {"surface": "moodboard", "itemId": f"{board_id}/{image_id}" if image_id else board_id}
    names: dict[str, Any] = {"board": name}
    if image_id:
        for source in (board, also):
            ids = [str(image.get("id")) for image in (source or {}).get("images") or [] if isinstance(image, Mapping)]
            if image_id in ids:
                names["image"] = ids.index(image_id) + 1
                break
    if part:
        target["part"] = part
        names["part"] = PART_LABELS[part]
    return target, names


def write_point(changes: Mapping[str, Any]) -> tuple[str | None, str | None, str]:
    """Where a board change (``moodboard_edits.diff``'s) puts the cursor:
    (image id or None, part or None, action). One image touched is that
    image, one kind of field is its control; anything wider is the board."""
    kinds = changes.get("kinds") or {}
    images = list((changes.get("touched") or {}).get("images") or [])
    frames = (changes.get("touched") or {}).get("frames") or []
    fields = [key for key in changes.get("fields") or ()]
    slices = changes.get("slices") or []
    image_kinds = [kind for kind in _IMAGE_KINDS if kinds.get(kind)]
    if fields and not (image_kinds or frames):
        parts = {FIELD_PARTS[key] for key in fields if key in FIELD_PARTS}
        if len(fields) == 1 and len(parts) == 1:
            part, action = next(iter(parts))
            return None, part, action
        return None, None, "type" if any(action == "type" for _, action in parts) else "click"
    if image_kinds and not (fields or frames) and len(set(images)) == 1:
        image_id = images[0]
        settings = [item for item in slices if item.get("part") == "settings" and item.get("image") == image_id]
        changed = {key for item in settings for key in (item.get("expect") or {})}
        cards = [item for item in slices if item.get("part") == "card" and item.get("image") == image_id]
        if len(settings) + len(cards) == len(slices) and changed:
            if changed <= {"notes", "privateNote"} and not cards:
                return image_id, "note", "type"
            if changed == {"weight"}:
                return image_id, "weight", "click"  # a weight also rescales the image's cards
        return image_id, None, "click"
    return None, None, "click"
