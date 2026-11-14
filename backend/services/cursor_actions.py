"""What an agent can be doing at its cursor (GM - Design's cursor spec, §2).

One list, in this order everywhere: POST /api/canvas/cursor
(services/agent_presence.py), MCP point_at, the CLI's `nebula point
--action`, the docs, and the frontend's AGENT_CURSOR_ACTIONS (wsClient.ts).
Its only import is services/text_cut (stdlib only), so the CLI can read it
without loading the backend.
"""
from __future__ import annotations

import re
import unicodedata
from typing import NamedTuple

from services.text_cut import ZWJ, safe_cut

ACTIONS = ("move", "look", "think", "type", "click", "drag", "run", "propose", "wait", "error")
ACTIONS_TEXT = ", ".join(ACTIONS)
ACTIONS_LIST_TEXT = ", ".join(ACTIONS[:-1]) + " or " + ACTIONS[-1]
_ECHO_CHARS = 40
# A cursor session id: up to 64 of [A-Za-z0-9_.:-] (services/agent_presence
# presence_session). Anything else is ignored for the cursor, as if unset; the
# CLI and the MCP server check it here so "as if unset" holds for them too.
SESSION_RE = re.compile(r"^[A-Za-z0-9_.:\-]{1,64}$")


def surface_clash(**given: object) -> list[str]:
    """Which of a surface target's forbidden companions were given (a node,
    a port, a spot, a drag's start): a surface item (a moodboard, a character,
    a style) is a target of its own. The one check for the route, MCP
    point_at and the CLI's `nebula point`; an empty string or None counts as
    not given."""
    return [name for name, value in given.items() if value is not None and value != ""]


moodboard_clash = surface_clash  # the name the moodboard code has always used


def surface_clash_refusal(names: list[str], surface: str = "moodboard") -> str:
    """The refusal for ``surface_clash``'s result, in one wording everywhere."""
    return (f"{surface} can't be combined with {', '.join(names)}. "
            f"Point at a {surface}, or at a node or a spot, in one call.")


def moodboard_clash_refusal(names: list[str]) -> str:
    """``surface_clash_refusal`` for a moodboard."""
    return surface_clash_refusal(names, "moodboard")


def surface_exclusive(**given: object) -> list[str]:
    """Which surface arguments were given (moodboard, character, style):
    more than one is refused, since a cursor is at one thing. An empty string
    or None counts as not given."""
    return [name for name, value in given.items() if value is not None and value != ""]


def surface_exclusive_refusal(names: list[str]) -> str:
    """The refusal for ``surface_exclusive`` when it names more than one."""
    return (f"{' and '.join(names)} can't be given together. "
            "Point at a moodboard, a character or a style in one call.")


def session_ok(raw: object) -> bool:
    """Whether ``raw`` is a cursor session id the backend keeps."""
    return isinstance(raw, str) and SESSION_RE.fullmatch(raw) is not None


def _shown(text: str) -> str:
    """The value as it may be echoed (review 2, LOW-1): a lone surrogate,
    a control character (ESC and its terminal sequences), a format
    character (zero-width, the bidi overrides such as RLO) or any other
    Unicode category C* code point becomes U+FFFD, so the line can't
    reorder or repaint the text around it and always encodes as UTF-8.
    ZWJ stays: it joins an emoji sequence, and the cut keeps that whole."""
    out = []
    for char in text:
        if char == ZWJ:
            out.append(char)
        elif 0xD800 <= ord(char) <= 0xDFFF or unicodedata.category(char).startswith("C"):
            out.append("\ufffd")
        else:
            out.append(char)
    return "".join(out)


def echoed(value: object) -> str:
    """A value as a refusal may echo it: cleaned (``_shown``) and cut to 40
    characters without splitting one (services/text_cut.safe_cut)."""
    if isinstance(value, str):
        shown = value[: _ECHO_CHARS * 4]  # a 100 KB value is never walked whole
    else:
        import json
        shown = json.dumps(value, default=str)[: _ECHO_CHARS * 4]
    shown = _shown(shown)
    if len(shown) > _ECHO_CHARS:
        shown = shown[: safe_cut(shown, _ECHO_CHARS - 1)] + "\u2026"
    return shown


def refusal(value: object) -> str:
    """The line an unknown action gets, everywhere (GM - Design, PR #211 r2):
    it echoes the value given, cleaned and cut (``echoed``)."""
    return f"\u201c{echoed(value)}\u201d isn\u2019t an action Nebula knows. Use one of {ACTIONS_LIST_TEXT}."


# Surfaces a cursor can point at besides the canvas (Phase 3, "Anywhere"):
# the Moodboard panel and Studio are one surface, `moodboard`; the Character
# Studio and the Assets dock's Characters list are `character`; the Assets
# dock's Styles list is `style`. The anchor is {"surface": <surface>, "itemId":
# "<item>" | "<item>/<sub>", "part"?}: a board's sub is an image's id, a
# character's a reference view's 1-based position, a style has none.
SURFACES = ("moodboard", "character", "style")
SURFACES_TEXT = ", ".join(SURFACES[:-1]) + " or " + SURFACES[-1]
# `colors` is the "Colors that must appear" row, `colors-out` the "Colors to keep out" row.
BOARD_PARTS = ("name", "direction", "avoid", "colors", "colors-out")
IMAGE_PARTS = ("note", "weight")
# The words a part goes by (the labels the Studio shows for each control;
# the frontend's AGENT_SURFACE_PART_LABELS holds the same, pinned by a test).
PART_LABELS = {"name": "Name", "direction": "Direction", "avoid": "Avoid", "colors": "Colors",
               "colors-out": "Colors to keep out", "note": "Note", "weight": "Weight"}
# A character's controls, labelled as the Character Studio's definition panel
# labels them (pinned by a test). `consistency` is accepted from an agent and
# dropped: that control reads "unavailable", so it is not pointable.
CHARACTER_PARTS = ("name", "subject-type", "views", "traits", "seed")
CHARACTER_DROPPED_PARTS = ("consistency",)
CHARACTER_LABELS = {"name": "Name", "subject-type": "Subject type", "views": "Reference views",
                    "traits": "Frozen trait string", "seed": "Seed"}
# No screen draws a style's fields; the part only chooses the default line.
STYLE_PARTS = ("name", "category", "prompt", "settings", "model", "references", "thumbnail")


class SurfaceInfo(NamedTuple):
    """What one surface is, in one place: the key its names are stored under,
    the key of its sub-item (None when it has none), the words for the thing
    and its sub-item, its parts and (when it has them) their labels."""
    name_key: str
    sub_key: str | None
    noun: str          # "moodboard"
    plural: str        # "moodboards"
    group: str         # "boards": the list a refusal names ("The boards here:")
    item_of: str       # "a board": the item in "isn't a part of a board"
    sub_of: str        # "an image": its sub-item there ("" when it has none)
    parts: tuple[str, ...]
    sub_parts: tuple[str, ...]
    labels: dict[str, str] | None  # None: names keep the part id


SURFACE_TABLE: dict[str, SurfaceInfo] = {
    "moodboard": SurfaceInfo("board", "image", "moodboard", "moodboards", "boards", "a board", "an image",
                             BOARD_PARTS, IMAGE_PARTS, PART_LABELS),
    "character": SurfaceInfo("character", "view", "character", "characters", "characters", "a character", "a view",
                             CHARACTER_PARTS, (), CHARACTER_LABELS),
    "style": SurfaceInfo("style", None, "style", "styles", "styles", "a style", "", STYLE_PARTS, (), None),
}
