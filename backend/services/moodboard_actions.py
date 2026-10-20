"""What an agent did to a moodboard, in the words the Agent log shows.

Graph edits narrate themselves through the agent's cursor ("Added Moodboard",
"Running Krea 2"). A board write has no place on the canvas, so main.py sends
the same ``agentPresence`` event without a target (``_say_agent_action``) and
these helpers write its ``say``. Only the agent's own action is named, never
what the person wrote: a private note is "private note changed", not its text.

One set of words, the journal's (``services/moodboard_edits``). A change to a
board (an edit batch or a ``PUT``) is said in ``journal_entry``'s summary, so
the Agent log and the journal never describe one change two ways. The journal
leaves the board's fields out (a Direction change, a rename); those are named
by the labels ``moodboard_edits.FIELD_LABELS`` already gives them. Every line
names the board as the journal does (``moodboard_edits.board_where``: "board
Dusk"), the lines for writes the journal has no event for (make, Analyze,
Keep, move, delete, restore) too.
"""
from __future__ import annotations

from typing import Any, Mapping

from services.moodboard_edits import FIELD_LABELS, board_where, journal_entry


def _images(n: int) -> str:
    return f"{n} image{'' if n == 1 else 's'}"


def _label(key: str) -> str:
    label = FIELD_LABELS.get(key, key)
    return "the " + label[4:] if label.startswith("The ") else label


def _listed(words: list[str]) -> str:
    return words[0] if len(words) == 1 else ", ".join(words[:-1]) + " and " + words[-1]


def _field_words(changes: Mapping[str, Any], entry: Mapping[str, Any] | None) -> list[str]:
    """The board fields the change set, from its ``fields`` slice. The board's
    notes are left out only when the journal's summary is the one about them
    ("changed the notes of board Dusk")."""
    fields = next((item for item in changes.get("slices") or [] if item.get("part") == "fields"), None)
    if not fields:
        return []
    keys = list((fields.get("expect") or {}).keys())
    board_notes_said = (entry is not None and entry.get("kind") == "board.noted"
                        and not (changes.get("kinds") or {}).get("noted"))
    if board_notes_said:
        keys = [key for key in keys if key != "notes"]
    words: list[str] = []
    changed = [key for key in keys if key != "sendNotes"]
    if changed:
        words.append("changed " + _listed([_label(key) for key in changed]))
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
    fields = _field_words(changes, entry)
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
