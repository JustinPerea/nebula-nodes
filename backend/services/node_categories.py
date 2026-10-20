"""Node categories by id and by their short names.

A definition's `category` is an id such as `image-gen`. People and agents say
"image" (the CLI's own `nebula context` printed "Image:"), so the CLI's
`--category` and MCP `find_nodes(category=...)` take either: the id, its
short name, or the name `nebula context` shows, in any case.
"""
from __future__ import annotations

from typing import Iterable

# id -> the short name the CLI shows (formatter.format_start, `nebula context`).
SHORT_NAMES: dict[str, str] = {
    "image-gen": "Image",
    "video-gen": "Video",
    "text-gen": "Text/Chat",
    "audio-gen": "Audio",
    "3d-gen": "3D",
    "transform": "Transform",
    "analyzer": "Analyzer",
    "utility": "Utility",
    "universal": "Universal",
    "cinematic": "Cinema",
    "character": "Character",
    "moodboard": "Moodboard",
}

# The order categories are listed in when a list has to be cut (start_here's
# node list): the free building blocks every pipeline needs first (prompts,
# previews, the board), then the generators.
ORDER: tuple[str, ...] = (
    "utility", "moodboard", "character", "image-gen", "video-gen", "audio-gen", "text-gen", "3d-gen",
    "transform", "analyzer", "universal", "cinematic",
)


def _names(category: str) -> set[str]:
    """Every name `category` answers to, lower case."""
    names = {category.lower()}
    if category.endswith("-gen"):
        names.add(category[: -len("-gen")])
    short = SHORT_NAMES.get(category)
    if short:
        names.add(short.lower())
        names.update(part.strip().lower() for part in short.split("/"))
    return names


def resolve(raw: str | None, known: Iterable[str] = ()) -> str | None:
    """The category id `raw` names (an id, a short name or a shown name), or
    None when it names none. `known` adds categories the definitions use that
    this module doesn't list."""
    text = " ".join(str(raw or "").split()).lower()
    if not text:
        return None
    for category in [*SHORT_NAMES, *[c for c in known if c not in SHORT_NAMES]]:
        if text in _names(category):
            return category
    return None


def ordered(categories: Iterable[str]) -> list[str]:
    """`categories` in ORDER, any others after them by name."""
    present = list(dict.fromkeys(categories))
    first = [category for category in ORDER if category in present]
    return first + sorted(category for category in present if category not in ORDER)


def label(category: str) -> str:
    return SHORT_NAMES.get(category, category)
