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

from services.text_cut import ZWJ, safe_cut

ACTIONS = ("move", "look", "think", "type", "click", "drag", "run", "propose", "wait", "error")
ACTIONS_TEXT = ", ".join(ACTIONS)
ACTIONS_LIST_TEXT = ", ".join(ACTIONS[:-1]) + " or " + ACTIONS[-1]
_ECHO_CHARS = 40
# A cursor session id: up to 64 of [A-Za-z0-9_.:-] (services/agent_presence
# presence_session). Anything else is ignored for the cursor, as if unset; the
# CLI and the MCP server check it here so "as if unset" holds for them too.
SESSION_RE = re.compile(r"^[A-Za-z0-9_.:\-]{1,64}$")


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
# the Moodboard panel and Studio are one surface, `moodboard`. The anchor is
# {"surface": "moodboard", "itemId": "<board>" | "<board>/<image>", "part"?}.
SURFACES = ("moodboard",)
BOARD_PARTS = ("name", "direction", "avoid", "colors")
IMAGE_PARTS = ("note", "weight")
# The words a part goes by (the labels the Studio shows for each control;
# the frontend's AGENT_SURFACE_PART_LABELS holds the same, pinned by a test).
PART_LABELS = {"name": "Name", "direction": "Direction", "avoid": "Avoid", "colors": "Colors",
               "note": "Note", "weight": "Weight"}
