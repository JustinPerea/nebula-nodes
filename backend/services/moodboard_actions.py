"""What an agent did to a moodboard, in the words the Agent log shows.

Graph edits narrate themselves through the agent's cursor ("Added Moodboard",
"Running Krea 2"). A board write has no place on the canvas, so main.py sends
the same ``agentPresence`` event without a target (``_say_agent_action``) and
these helpers write its ``say``. Only the agent's own action is named, never
what the person wrote: a private note is "private note changed", not its text.

One set of words, the journal's (``services/moodboard_edits``). A change to a
board (an edit batch or a ``PUT``) is said in ``journal_entry``'s summary, so
the Agent log and the journal never describe one change two ways. The board's
own fields (a Direction change, a rename) are named as the ``board.fields``
event names them (``moodboard_edits.field_label``): "Changed Direction and
the Avoid list on board Dusk"; only Send notes says which way it went here
("turned ... off"), since the journal names fields, never values. Every line
names the board as the journal does (``moodboard_edits.board_where``: "board
Dusk"), the lines for writes the journal has no event for (make, Analyze,
Keep, move, delete, restore) too.
"""
from __future__ import annotations

from typing import Any, Mapping

from services.moodboard_edits import FIELD_LABELS, board_where, cover_words, field_label, journal_entry, listed_words


def _images(n: int) -> str:
    return f"{n} image{'' if n == 1 else 's'}"


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
        words.append(f"turned {FIELD_LABELS['sendNotes']} " + ("on" if fields["expect"]["sendNotes"] else "off"))
    return words


def _sentence(said: str) -> str:
    return said[0].upper() + said[1:]


def describe_change(changes: Mapping[str, Any], before: Mapping[str, Any], after: Mapping[str, Any], *,
                    undo: bool = False) -> str:
    """One line for a board change (``moodboard_edits.diff``'s): the journal's
    summary, "Set aside #1 on board Dusk", with the fields it doesn't name.
    ``undo``: the change was an undo (a batch of ``restore`` ops), which
    otherwise reads like the change it undid: "Undo: Removed #3 from board
    Dusk"."""
    entry = journal_entry(dict(changes), dict(before), dict(after))
    fields = _field_words(changes, entry, after)
    where = board_where(after, before)
    if entry is not None:
        said = "; ".join([entry["summary"], *fields])
    elif fields:
        said = f"{'; '.join(fields)} on {where}"
    else:  # a nudge under 8 px, a card's own change
        said = f"edited {where}"
    said = _sentence(said)
    return f"Undo: {said}" if undo else said


def describe_create(board: Mapping[str, Any]) -> str:
    count = len(board.get("images") or [])
    return f"Made {board_where(board)}" + (f" with {_images(count)}" if count else "")


def describe_write(verb: str, board: Mapping[str, Any] | None, rest: str = "") -> str:
    """A board write the journal has no event for: "Analyzed board Dusk",
    "Kept the brief on board Dusk", "Moved board Dusk to Global"."""
    return _sentence(" ".join(part for part in (verb, board_where(board), rest) if part))
