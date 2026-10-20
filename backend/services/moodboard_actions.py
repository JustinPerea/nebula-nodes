"""What an agent did to a moodboard, in the words the Agent log shows.

Graph edits narrate themselves through the agent's cursor ("Added Moodboard",
"Running Krea 2"). A board write has no place on the canvas, so main.py sends
the same ``agentPresence`` event without a target (``_say_agent_action``) and
these helpers write its ``say``. Only the agent's own action is named, never
what the person wrote: a private note is "Edited private notes", not its text.
"""
from __future__ import annotations

from typing import Any, Mapping

MAX_NAME_CHARS = 60

# Board fields an agent may set, and what changing one says. Lists and
# objects compare whole; `analysis`, `colorCheck` and the layout are Nebula's.
_FIELD_WORDS: tuple[tuple[str, str], ...] = (
    ("notes", "edited notes"),
    ("direction", "set Direction"),
    ("avoid", "set Avoid"),
    ("pinnedColors", "set pinned colors"),
    ("colorChoices", "changed color choices"),
    ("clashMode", "set clash mode"),
    ("mode", "set mode"),
    ("strength", "set strength"),
)


def board_name(board: Mapping[str, Any] | None) -> str:
    """“Dusk dunes”, cut to ``MAX_NAME_CHARS``."""
    name = " ".join(str((board or {}).get("name") or "Untitled board").split())
    if len(name) > MAX_NAME_CHARS:
        name = name[: MAX_NAME_CHARS - 1].rstrip() + "…"
    return f"“{name}”"


def _images(n: int) -> str:
    return f"{n} image{'' if n == 1 else 's'}"


def _weight(image: Mapping[str, Any]) -> Any:
    # An image saved before weights were written reads without one and is
    # saved at the store's default on its next write: not the agent's change.
    return image.get("weight", 1.0)


def _changed(before: Mapping[str, Any], after: Mapping[str, Any], key: str) -> bool:
    return before.get(key) != after.get(key)


def describe_update(before: Mapping[str, Any], after: Mapping[str, Any]) -> str:
    """One line for a board update: "Set aside 1 image in “Dusk”"."""
    old = {img.get("id"): img for img in before.get("images") or [] if img.get("id")}
    new = {img.get("id"): img for img in after.get("images") or [] if img.get("id")}
    kept = [image_id for image_id in new if image_id in old]

    def count(test) -> int:
        return sum(1 for image_id in kept if test(old[image_id], new[image_id]))

    parts: list[str] = []
    aside = count(lambda a, b: not a.get("excluded") and bool(b.get("excluded")))
    used = count(lambda a, b: bool(a.get("excluded")) and not b.get("excluded"))
    added = sum(1 for image_id in new if image_id not in old)
    removed = sum(1 for image_id in old if image_id not in new)
    weighted = count(lambda a, b: _weight(a) != _weight(b))
    noted = count(lambda a, b: (a.get("notes") or "") != (b.get("notes") or ""))
    private = count(lambda a, b: (a.get("privateNote") or "") != (b.get("privateNote") or ""))
    for n, words in ((aside, "set aside {}"), (used, "used {} again"), (added, "added {}"),
                     (removed, "removed {}"), (weighted, "set the weight of {}"),
                     (noted, "edited notes on {}"), (private, "edited private notes on {}")):
        if n:
            parts.append(words.format(_images(n)))
    parts.extend(words for key, words in _FIELD_WORDS if _changed(before, after, key))
    if _changed(before, after, "briefOverride"):
        parts.append("wrote the brief" if after.get("briefOverride") else "removed the hand-written brief")
    if _changed(before, after, "sendNotes"):
        parts.append("turned notes for generators " + ("on" if after.get("sendNotes") else "off"))

    renamed = _changed(before, after, "name")
    said = ", ".join(parts)
    if said:
        said = f"{said} in {board_name(after)}"
    if renamed:
        rename = f"renamed {board_name(before)} to {board_name(after)}"
        said = f"{rename}; {said}" if said else rename
    if not said:
        return f"Updated {board_name(after)}"
    return said[0].upper() + said[1:]


def describe_create(board: Mapping[str, Any]) -> str:
    count = len(board.get("images") or [])
    return f"Made moodboard {board_name(board)}" + (f" with {_images(count)}" if count else "")
