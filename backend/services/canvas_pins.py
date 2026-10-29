"""Pins: short notes the person leaves on the canvas for agents.

The person pins "warmer" or "redo this one" to a node (or to a spot on the
canvas). Agents read open pins in ``nebula look`` and in watch events, act on
them, and answer with a one-line reply that resolves the pin.

Pins are the person's content, so they persist with the project. They live on
the project record in the catalog, ``catalog["projects"][id]["pins"]``, next
to ``snapshot`` rather than inside it. The browser's autosave
(``PUT /api/projects/{id}``) only replaces ``snapshot``, so it can never
overwrite or drop a pin, and switching projects brings each project's pins
with it.

Only the person creates and deletes pins (the routes check that); agents only
resolve them. Text is plain text: whitespace is collapsed, control characters
are stripped, and length is capped. It is never interpreted.
"""
from __future__ import annotations

import bisect
import copy
import json
import secrets
import time
import re
import unicodedata
from datetime import datetime, timezone
from pathlib import Path
from typing import Any, Callable, Iterator, Mapping

from services.agent_presence import AgentIdentity
from services.project_store import ProjectStore

MAX_PIN_TEXT = 280
MAX_REPLY = 280
MAX_OPEN_PINS = 100
MAX_PINS = 200
RECENT_RESOLVED_SECONDS = 600
MAX_AGENT_PINS = 20
_COORD_LIMIT = 1e7


class PinError(Exception):
    def __init__(self, status: int, detail: str, extra: Mapping[str, Any] | None = None) -> None:
        super().__init__(detail)
        self.status = status
        self.detail = detail
        # Beside `detail` in the answer, for agents (code, byte counts); the
        # person reads only `detail` (GM r12 answer 3).
        self.extra = dict(extra or {})


def _iso(timestamp: float) -> str:
    return datetime.fromtimestamp(timestamp, timezone.utc).isoformat()


def _epoch(value: Any) -> float | None:
    if not isinstance(value, str):
        return None
    try:
        return datetime.fromisoformat(value).timestamp()
    except ValueError:
        return None


# Terminal escape sequences, each dropped whole (review 7 N-3, review 8
# NIT-3), so no "Pq#0;2;0;0;0" or "_Gf=24;AAAA" is left: CSI (7- and 8-bit),
# then the string sequences: OSC, DCS, APC, PM and SOS
# (ESC ] P _ ^ X, or 8-bit 0x9d 0x90 0x9f 0x9e 0x98), each dropped whole with
# its payload up to its end: ST (ESC \ or 0x9c) or BEL, even past an inner
# ESC (review 8 NIT-3). One left unterminated goes to the end of its line,
# so the person's next lines stay.
_ANSI = re.compile(
    r"\x1b\[[0-?]*[ -/]*[@-~]"
    r"|\x9b[0-?]*[ -/]*[@-~]"
    r"|(?:\x1b[\]P_^X]|[\x90\x98\x9d\x9e\x9f])[^\r\n]*?(?:\x1b\\|\x9c|\x07|(?=[\r\n])|\Z)"
)


# Review 11 MEDIUM-1 of PR #200 and GM r19 answer 1: what draws nothing is
# hidden text, dropped from the shown form; only real emoji and real
# variants keep their invisible parts. One rule for the variation selectors
# (GM r21, PR #200 fix round 13): at most one selector stays, and only when
# Unicode lists it for the character before it:
# - E0100-E01EF only for a pair the Ideographic Variation Database
#   registers (GM r23; IVD_Sequences.txt);
# - 180B-180D and 180F after a Mongolian letter;
# - FE00-FE0F after a base StandardizedVariants.txt or
#   emoji-variation-sequences.txt lists for that selector (an emoji's
#   FE0E/FE0F, a keycap's digit, a CJK compatibility variant).
# Every other selector, and every one past the first, is hidden; so are the
# combining grapheme joiner and Khmer's inherent vowels. A zero-width joiner
# stays inside an emoji ZWJ sequence; tag characters stay only as one of the
# three RGI subdivision flags after U+1F3F4, England, Scotland and Wales
# (review 12 M-1: any other tag run carried 7 hidden ASCII characters a
# flag). The data is generated from Unicode's own files
# (scripts/generate-pin-text-unicode.py), the same bytes the frontend's
# pinDisplayText (lib/canvasPins.ts) reads, so the two never disagree.
_UNICODE_DATA = json.loads((Path(__file__).resolve().parent.parent / "data" / "pin_text_unicode.json").read_text(encoding="utf-8"))


def _within(spans: list[list[int]]) -> Callable[[int], bool]:
    lows = [low for low, _high in spans]

    def inside(code: int) -> bool:
        at = bisect.bisect_right(lows, code) - 1
        return at >= 0 and code <= spans[at][1]
    return inside


def _ivd_pairs(text: str) -> dict[int, frozenset[int]]:
    """The Ideographic Variation Database's registered pairs (GM r23): base
    code point to the selector offsets from E0100 it registers. Decodes
    scripts/generate-pin-text-unicode.py's ivd_text."""
    pairs: dict[int, frozenset[int]] = {}
    base = 0
    for entry in filter(None, text.split(",")):
        delta, runs = entry.split(":")
        base += int(delta, 36)
        offsets: set[int] = set()
        for run in runs.split("."):
            low, _, high = run.partition("-")
            offsets.update(range(int(low, 36), int(high or low, 36) + 1))
        pairs[base] = frozenset(offsets)
    return pairs


_IVD = _ivd_pairs(_UNICODE_DATA["ivd"])
_MONGOLIAN_LETTER = _within(_UNICODE_DATA["mongolianLetters"])
_VARIATION_BASES = {int(selector, 16): _within(spans) for selector, spans in _UNICODE_DATA["variationBases"].items()}
_RGI_ZWJ = frozenset(_UNICODE_DATA["rgiZwj"])
_RGI_ZWJ_LONGEST = int(_UNICODE_DATA["rgiZwjLongest"])
_TAG_FLAGS = frozenset(_UNICODE_DATA["tagFlags"])
_PICTOGRAPHIC = (
    (0x00A9, 0x00A9), (0x00AE, 0x00AE), (0x203C, 0x203C), (0x2049, 0x2049), (0x2122, 0x2122),
    (0x2139, 0x2139), (0x2194, 0x21AA), (0x231A, 0x23FF), (0x24C2, 0x24C2), (0x25AA, 0x25FE),
    (0x2600, 0x27BF), (0x2934, 0x2935), (0x2B05, 0x2B55), (0x3030, 0x3030), (0x303D, 0x303D),
    (0x3297, 0x3297), (0x3299, 0x3299), (0x1F000, 0x1F1E5), (0x1F200, 0x1F3FA), (0x1F400, 0x1FAFF),
    (0x1FC00, 0x1FFFD),
)
ZWJ = "\u200d"
BLACK_FLAG = "\U0001F3F4"
CANCEL_TAG = "\U000E007F"


def _pictographic(char: str | None) -> bool:
    if not char:
        return False
    code = ord(char)
    return any(low <= code <= high for low, high in _PICTOGRAPHIC)


def _skin_tone(char: str) -> bool:
    return "\U0001F3FB" <= char <= "\U0001F3FF"


def _variation_selector(code: int) -> bool:
    return 0xFE00 <= code <= 0xFE0F or 0xE0100 <= code <= 0xE01EF or 0x180B <= code <= 0x180D or code == 0x180F


def _selector_fits(base: str | None, code: int) -> bool:
    """GM r21: this selector is listed for this base."""
    if base is None:
        return False
    if 0xFE00 <= code <= 0xFE0F:
        listed = _VARIATION_BASES.get(code)
        return listed is not None and listed(ord(base))
    if 0xE0100 <= code <= 0xE01EF:
        return (code - 0xE0100) in _IVD.get(ord(base), ())
    return _MONGOLIAN_LETTER(ord(base))


def _never_shown_mark(code: int) -> bool:
    """The combining grapheme joiner and Khmer's inherent vowels draw nothing."""
    return code == 0x034F or code in (0x17B4, 0x17B5)


def _ends_in_emoji(out: list[str]) -> bool:
    """The kept text ends in an emoji, maybe with its selector and skin tone."""
    index = len(out) - 1
    if index >= 0 and _skin_tone(out[index]):
        index -= 1
    if index >= 0 and out[index] == "\ufe0f":
        index -= 1
    return index >= 0 and _pictographic(out[index])


def _plain(line: str) -> str:
    """One line without control bytes, format characters or marks that draw
    nothing (the guards above aside); a tab, CR or LF reads as a space."""
    out: list[str] = []
    index = 0
    size = len(line)
    while index < size:
        char = line[index]
        if char in "\t\n\r":
            out.append(" ")
            index += 1
            continue
        if char == BLACK_FLAG:
            end = index + 1
            while end < size and "\U000E0020" <= line[end] <= "\U000E007E":
                end += 1
            # Only England, Scotland and Wales (review 12 M-1).
            spec = "".join(chr(ord(tag) - 0xE0000) for tag in line[index + 1:end])
            if spec in _TAG_FLAGS and end < size and line[end] == CANCEL_TAG:
                out.extend(line[index:end + 1])
                index = end + 1
                continue
        if char == ZWJ:
            if _ends_in_emoji(out) and index + 1 < size and _pictographic(line[index + 1]):
                out.append(char)
            index += 1
            continue
        code = ord(char)
        if unicodedata.category(char) in {"Cc", "Cf"}:
            index += 1
            continue
        if _variation_selector(code):
            # One, valid for its base (GM r21); a second finds a selector before it.
            if out and _selector_fits(out[-1], code):
                out.append(char)
            index += 1
            continue
        if _never_shown_mark(code):
            index += 1
            continue
        out.append(char)
        index += 1
    return "".join(out)


def _shown(raw: str, multiline: bool) -> str:
    """The text with every control byte gone (see clean_text), never raising."""
    # A terminal colour code pasted with the text goes whole, never as a
    # stray "[31m" once its ESC is dropped (fix round 6 of PR #200, review 6
    # N-4, and NIT-3 of review 8: every string sequence too).
    raw = _ANSI.sub("", raw)
    # GM r19 answer 1 (whitespace): leading and trailing whitespace goes
    # (stored that way too: typed_text), and the spaces and blank lines
    # inside count as typed, so they are never hidden text.
    if multiline:
        # str.splitlines knows every line break: \r\n, \r, \v, \f, NEL and
        # U+2028/U+2029 (review 3 LOW-5), so each reads as \n on every surface.
        return "\n".join(_plain(line) for line in raw.splitlines()).strip()
    # One line: each line break reads as one space, never glued.
    return _plain(" ".join(raw.splitlines())).strip()


def shown_text(raw: Any, *, multiline: bool = True) -> str:
    """Note or reply text as every output shows it (GM r15 and r16, PR #200
    fix round 10): the store keeps what was typed, and each output strips it,
    the API's pins, the journal and its summaries, the CLI, the channel push
    and the canvas display (frontend lib/canvasPins.ts pinDisplayText). No C0
    but \n, no C1, no ESC, no format characters. A note keeps its lines; a
    reply is one line."""
    if raw is None:
        return ""
    return _shown(raw if isinstance(raw, str) else str(raw), multiline)


# GM r12 answer 3 (PR #200 fix round 11): only what shows counts against the
# cap, in characters as a person sees them (grapheme clusters) of the shown
# text, the same strip every output uses; the composer counts the same way
# (frontend lib/canvasPins.ts noteLength), so the two never disagree. What the
# shown form drops (escape codes, control and format characters, marks that
# draw nothing past the one a base may take) is the hidden text: up to
# HIDDEN_TEXT_CHARACTERS of it (code points: GM r22 Q3, counted in
# characters, never bytes) is stored as typed.
HIDDEN_TEXT_CHARACTERS = 1120
HIDDEN_TOO_LONG = "This note has too much hidden text to save. Paste it as plain text, then try again."
HIDDEN_TOO_LONG_CODE = "note_hidden_too_long"
TOO_LONG_CODE = "note_too_long"
# GM r23 lines: a code each so the canvas can say them (and, for a removed
# node, hold Send note); agents read the detail.
OPEN_NOTES_FULL_CODE = "open_notes_full"
NODE_GONE_CODE = "pin_node_gone"
# A cluster takes at most this many marks; past it each mark counts as a
# character of its own, so 280 characters bound what is stored too.
MAX_MARKS_PER_CHARACTER = 32


def _extends(char: str) -> bool:
    """A code point that joins the character before it: a combining mark
    (Mn, Mc, Me, which covers the variation selectors), an emoji skin tone,
    or a tag character (the strip keeps only a real flag's)."""
    return (unicodedata.category(char) in {"Mn", "Mc", "Me"} or "\U0001F3FB" <= char <= "\U0001F3FF"
            or "\U000E0020" <= char <= "\U000E007F")


def _regional(char: str) -> bool:
    return "\U0001F1E6" <= char <= "\U0001F1FF"


def _hangul(char: str) -> str:
    """A Hangul jamo or syllable's part in a syllable (UAX #29): L, V, T, LV,
    LVT, or "" for anything else."""
    code = ord(char)
    if 0x1100 <= code <= 0x115F or 0xA960 <= code <= 0xA97C:
        return "L"
    if 0x1160 <= code <= 0x11A7 or 0xD7B0 <= code <= 0xD7C6:
        return "V"
    if 0x11A8 <= code <= 0x11FF or 0xD7CB <= code <= 0xD7FB:
        return "T"
    if 0xAC00 <= code <= 0xD7A3:
        return "LV" if (code - 0xAC00) % 28 == 0 else "LVT"
    return ""


# Hangul parts that join the one before (UAX #29 GB6-GB8): a leading consonant
# takes any syllable start; a vowel continues with a vowel or a final; a final
# with a final.
_HANGUL_JOINS = {"L": {"L", "V", "LV", "LVT"}, "V": {"V", "T"}, "LV": {"V", "T"}, "T": {"T"}, "LVT": {"T"}}


def _marks_end(shown: str, end: int) -> int:
    """Past the marks that join the character before ``end``, up to 32."""
    marks = 0
    while end < len(shown) and marks < MAX_MARKS_PER_CHARACTER and _extends(shown[end]):
        end += 1
        marks += 1
    return end


def _zwj_key(part: str) -> str:
    """An emoji in a ZWJ chain as the RGI list keys it: no FE0E/FE0F, no skin tone."""
    return " ".join("%X" % ord(char) for char in part if char not in "\ufe0e\ufe0f" and not _skin_tone(char))


def _zwj_groups(parts: list[str]) -> list[int]:
    """How many emoji of a ZWJ chain each character takes (review 12 L-2,
    GM r21): each RGI ZWJ sequence in it is one, longest first from the
    left; every other emoji is one on its own, so 11 thumbs joined are 11."""
    keys = [_zwj_key(part) for part in parts]
    groups: list[int] = []
    at = 0
    while at < len(keys):
        step = 1
        for size in range(min(_RGI_ZWJ_LONGEST, len(keys) - at), 1, -1):
            if "|".join(keys[at:at + size]) in _RGI_ZWJ:
                step = size
                break
        groups.append(step)
        at += step
    return groups


def _character_ends(shown: str) -> Iterator[int]:
    """Where each character a person sees ends in already-shown text (see
    text_length), so a count and a cut agree on what a character is."""
    size = len(shown)
    at = 0
    while at < size:
        char = shown[at]
        end = at + 1
        if char != "\n":
            if _regional(char) and end < size and _regional(shown[end]):
                end += 1
            else:
                part = _hangul(char)
                while part and end < size and _hangul(shown[end]) in _HANGUL_JOINS.get(part, ()):
                    part = _hangul(shown[end])
                    end += 1
            end = _marks_end(shown, end)
        if _pictographic(char):
            spans = [(at, end)]
            while end + 1 < size and shown[end] == ZWJ and _pictographic(shown[end + 1]):
                start = end + 1
                end = _marks_end(shown, start + 1)
                spans.append((start, end))
            taken = 0
            for group in _zwj_groups([shown[low:high] for low, high in spans]):
                taken += group
                yield spans[taken - 1][1]
        else:
            yield end
        at = end


def text_length(shown: str) -> int:
    """Characters as a person sees them in already-shown text: a base and its
    marks are one, up to 32 (a mark after a line break is its own), two
    regional indicators (a flag) are one, Hangul jamo that make one syllable
    are one (review 11 NIT-3, UAX #29 GB6-GB8), a subdivision flag is one,
    and a chain of emoji joined by ZWJ counts each RGI ZWJ sequence in it as
    one and every other emoji on its own (review 12 L-2). No segmentation
    package. The frontend's textLength is the same rule, code point for code
    point."""
    return sum(1 for _end in _character_ends(shown))


def clip_characters(shown: str, max_points: int) -> str:
    """The longest start of ``shown`` in whole characters that fits
    ``max_points`` code points with an ellipsis, never cutting a family or a
    letter's accents (PR #200 fix round 14: an event's preview); ``shown``
    itself when it fits."""
    if len(shown) <= max_points:
        return shown
    kept = 0
    for end in _character_ends(shown):
        if end > max_points - 1:
            break
        kept = end
    return shown[:kept] + "…"


# The events feed cuts a string past canvas_events.MAX_VALUE_CHARS (160) code
# points wherever that falls (mid-family too); a pin's text and reply arrive
# already cut on a character's edge within it, so the feed leaves them whole.
EVENT_TEXT_POINTS = 160


def event_text(text: Any, *, multiline: bool = True) -> str:
    """A pin's text (or reply) as an event carries it: in agents' form
    (agent_text, GM r23), then cut on a
    character's edge to fit the events feed."""
    return clip_characters(agent_text(text, multiline=multiline), EVENT_TEXT_POINTS)


def _agent_form(shown: str) -> str:
    """Already-shown text as agents read it (GM r23, review 13 M-1): every
    variation selector gone (FE00-FE0F, E0100-E01EF, 180B-180F), so a
    registered ideographic variant reads as its base ideograph and an emoji's
    FE0F as the bare emoji, and a zero-width joiner kept only inside an RGI
    ZWJ sequence (a family stays one family). 280 selectors that spell
    something in their low bits reach no agent."""
    out: list[str] = []
    size = len(shown)
    at = 0
    while at < size:
        char = shown[at]
        if not _pictographic(char):
            if char != ZWJ:
                out.append(char)
            at += 1
            continue
        end = _marks_end(shown, at + 1)
        spans = [(at, end)]
        while end + 1 < size and shown[end] == ZWJ and _pictographic(shown[end + 1]):
            start = end + 1
            end = _marks_end(shown, start + 1)
            spans.append((start, end))
        taken = 0
        for group in _zwj_groups([shown[low:high] for low, high in spans]):
            out.append(ZWJ.join(shown[low:high] for low, high in spans[taken:taken + group]))
            taken += group
        at = end
    return "".join(char for char in "".join(out) if not _variation_selector(ord(char)))


def agent_text(raw: Any, *, multiline: bool = True) -> str:
    """Note or reply text as every agent-facing output carries it (GM r23):
    the shown form (shown_text) without variation selectors, and with a ZWJ
    only inside an RGI sequence. The pins list for agents, `nebula pins`,
    MCP, the events feed, agent start and the channel push all use it; only
    the person's canvas (their GET, the WebSocket, their create) keeps the
    shown form with its registered variants."""
    return _agent_form(shown_text(raw, multiline=multiline))


def _trimmed(raw: str) -> str:
    """Whitespace and byte order marks off both ends (GM r19 answer 1; review
    12 NIT-5: str.strip keeps a leading U+FEFF, the canvas's trim doesn't)."""
    while True:
        trimmed = raw.strip().strip("\ufeff")
        if trimmed == raw:
            return trimmed
        raw = trimmed


def clean_text(raw: Any, *, limit: int, label: str = "Note", multiline: bool = False) -> str:
    """Checks text for the store, and answers its shown form: plain text,
    1..limit chars, control characters dropped. The store keeps ``raw``
    itself (``typed_text``); this is the form every output shows.

    One line by default (a reply): each line break reads as a space.
    ``multiline`` (the person's note: Shift+Enter in the dialog makes lines,
    fix round 2 of PR #200, GM 2026-10-28 answer 5): agents get it as
    written. Its newlines stay (every line break, ``\r\n``, ``\r``, U+2028
    and the rest, reads as ``\n``), a tab reads as a space, a terminal colour
    code goes whole, and every other control character is dropped. Either
    way, whitespace at the ends goes (the first line's indent too) and the
    spaces and blank lines inside stay as typed and count (GM r19 answer 1,
    PR #200 fix round 12; only the canvas display folds a run of blank lines).
    """
    if not isinstance(raw, str):
        raise PinError(422, f"{label} must be text")
    # GM r19 answer 1: the note is kept trimmed (typed_text), so what is
    # saved is what was counted; its hidden text is what the trimmed note
    # holds past what shows.
    raw = _trimmed(raw)
    text = _shown(raw, multiline)
    if not text:
        raise PinError(422, f"{label} can't be empty")
    if text_length(text) > limit:
        # The person's line comes from its code (GM r20 Q1, PR #200 fix round
        # 13), never from these words.
        raise PinError(422, f"{label} must be {limit} characters or fewer", {"code": TOO_LONG_CODE, "limit": limit})
    # GM r22 Q3 (fix round 14): hidden characters, never bytes. What shows
    # can be any length in bytes (280 families are about 7 KB) and still save.
    hidden = len(raw) - len(text)
    if hidden > HIDDEN_TEXT_CHARACTERS:
        raise PinError(422, HIDDEN_TOO_LONG, {"code": HIDDEN_TOO_LONG_CODE, "hiddenCharacters": hidden,
                                              "limitCharacters": HIDDEN_TEXT_CHARACTERS})
    return text


def typed_text(raw: Any, *, limit: int, label: str = "Note", multiline: bool = False) -> str:
    """What the store keeps: the text as typed, once clean_text has checked
    it (GM r15 condition 1, r16 answer 3: notes and replies alike), trimmed
    at both ends (GM r19 answer 1)."""
    clean_text(raw, limit=limit, label=label, multiline=multiline)
    # Trimmed at both ends (GM r19 answer 1, the one change to "as typed").
    return _trimmed(raw)


def note_block(text: Any, indent: str) -> str:
    """A note of several lines, each on its own line under ``indent``.

    Every line is indented the same, so a list or an indented line keeps its
    shape, and a blank line stays empty (fix round 5 of PR #200, review 5
    LOW-4). The CLI (`nebula pins`, `nebula look`, `nebula start`) and the
    channel push both print a note this way, so a line the person typed never
    starts where a line of the surrounding output does.
    """
    return "\n".join(f"{indent}{line}" if line.strip() else "" for line in agent_text(text).split("\n"))


def _point(raw: Any, label: str = "position") -> dict[str, float]:
    if not isinstance(raw, Mapping):
        raise PinError(422, f"{label} must be an object with x and y")
    result: dict[str, float] = {}
    for axis in ("x", "y"):
        value = raw.get(axis)
        if isinstance(value, bool) or not isinstance(value, (int, float)):
            raise PinError(422, f"{label}.{axis} must be a number")
        number = float(value)
        if number != number or abs(number) >= _COORD_LIMIT:
            raise PinError(422, f"{label}.{axis} must be a finite canvas coordinate")
        result[axis] = round(number, 2)
    return result


def _stored_position(node: Mapping[str, Any] | None) -> dict[str, float] | None:
    position = (node or {}).get("position")
    try:
        return _point(position) if position is not None else None
    except PinError:
        return None


# What a delete's undo needs to put a pin back (canvas_pins._detach): kept
# with the pin, never shown to anyone (agents could otherwise name the
# person's removal ids in a restore of their own).
_UNDO_KEYS = ("detachedBy", "detachedDefinition", "attachedPosition")
_ANY_PROJECT = object()
ANOTHER_PROJECT = "another project is open now"
CHANGED_SINCE = "changed since"
ANOTHER_MODEL = "its node came back as another model"
DELETED_SINCE = "deleted since"
# A pin an undo left as it is says why twice: ``reason`` for agents to read,
# ``code`` for the canvas to count by. Only "another-model" is said in the
# person's notice (GM, 2026-10-23: "1 pin couldn't be re-attached."); a pin
# they deleted or changed since is their own doing and stays quiet.
PIN_LEFT_CODES = {
    CHANGED_SINCE: "changed",
    ANOTHER_MODEL: "another-model",
    DELETED_SINCE: "deleted",
    ANOTHER_PROJECT: "another-project",
}


def pin_left(pin_id: str, reason: str) -> dict[str, str]:
    """A pin an undo left as it is: ``{id, reason, code}``."""
    return {"id": pin_id, "reason": reason, "code": PIN_LEFT_CODES[reason]}


def public_pin(pin: Mapping[str, Any], *, person: bool = False) -> dict[str, Any]:
    """A pin as it is read: its note and reply in agents' form (agent_text)
    unless ``person`` (the person's own canvas: the shown form, which keeps
    a registered variant, GM r23). The store keeps them as typed."""
    form = shown_text if person else agent_text
    out = {key: copy.deepcopy(value) for key, value in pin.items() if key not in _UNDO_KEYS}
    if "text" in out:
        out["text"] = form(out["text"])
    reply = out.get("reply")
    if isinstance(reply, dict) and "text" in reply:
        reply["text"] = form(reply["text"], multiline=False)
    return out


class CanvasPins:
    """Pins of the active project, stored on its catalog record."""

    def __init__(
        self,
        store: ProjectStore | Callable[[], ProjectStore],
        clock: Callable[[], float] = time.time,
    ) -> None:
        # A getter lets main.py follow `main.project_store` when tests swap it.
        self._store_source = store
        self._clock = clock

    @property
    def store(self) -> ProjectStore:
        source = self._store_source
        return source if isinstance(source, ProjectStore) else source()

    def forget_cache(self) -> None:
        """Nothing is kept here: the store's projection follows catalog.json."""

    # -- reading ---------------------------------------------------------
    def _active(self) -> tuple[str | None, list[dict[str, Any]]]:
        """The open project and its pins, as catalog.json holds them now
        (a copy: callers may change it).

        From ProjectStore.projection, which follows the file itself (every
        commit replaces catalog.json, whichever route or process makes it),
        so nothing has to remember to clear anything. Clearing a cache only
        after a project switch's broadcast let a listing taken meanwhile
        answer with the project open before (review 4 of PR #114, H1); and
        re-reading the whole catalog after every unrelated commit (an
        autosave) cost a parse, an upgrade and a deep copy per listing
        (review 5, M2). The store shares one projection per file with the
        workspace and the journal's project tag."""
        view = self.store.projection()
        return view.project_id, copy.deepcopy(list(view.pins))

    @staticmethod
    def _ordered(pins: list[dict[str, Any]]) -> list[dict[str, Any]]:
        # Open first, newest first inside each group.
        newest = sorted(pins, key=lambda pin: str(pin.get("createdAt") or ""), reverse=True)
        return [pin for pin in newest if pin.get("status") == "open"] + [
            pin for pin in newest if pin.get("status") != "open"
        ]

    def list(self, *, person: bool = False) -> dict[str, Any]:
        """The open project's pins; in the shown form for the person's canvas
        (``person``), in agents' form otherwise (GM r23)."""
        project_id, pins = self._active()
        return {"projectId": project_id, "pins": [public_pin(pin, person=person) for pin in self._ordered(pins)]}

    def get(self, pin_id: str) -> dict[str, Any] | None:
        return next((pin for pin in self._active()[1] if pin.get("id") == pin_id), None)

    def for_agents(self, limit: int = MAX_AGENT_PINS) -> dict[str, Any]:
        """Open pins, plus pins resolved in the last ten minutes (so agents see the replies)."""
        project_id, pins = self._active()
        now = self._clock()
        shown = []
        for pin in self._ordered(pins):
            if pin.get("status") == "open":
                shown.append(pin)
                continue
            resolved_at = _epoch((pin.get("reply") or {}).get("at"))
            if resolved_at is not None and now - resolved_at <= RECENT_RESOLVED_SECONDS:
                shown.append(pin)
        open_count = sum(1 for pin in pins if pin.get("status") == "open")
        return {"projectId": project_id, "pins": [public_pin(pin) for pin in shown[:limit]], "openCount": open_count}

    # -- writing ---------------------------------------------------------
    def _write(self, mutate: Callable[[list[dict[str, Any]]], Any], *,
               project: str | None | object = _ANY_PROJECT) -> tuple[str, Any]:
        """Run ``mutate(pins)`` on the active project's list inside one catalog
        transaction. With ``project``, only while that project is the open one."""
        store = self.store
        with store.transaction() as catalog:
            project_id = catalog.get("activeProjectId")
            if project is not _ANY_PROJECT and project_id != project:
                raise PinError(409, ANOTHER_PROJECT)
            if not project_id or project_id not in catalog["projects"]:
                raise PinError(409, "Open or create a project before leaving notes")
            project = catalog["projects"][project_id]
            pins = project.setdefault("pins", [])
            if not isinstance(pins, list):
                pins = project["pins"] = []
            before = copy.deepcopy(pins)
            result = mutate(pins)
            if pins != before:
                store.commit(catalog)
        return project_id, result

    # add, remove and resolve answer the pin; their ``*_in`` twins answer
    # (project_id, pin): the project the write itself went to, for the
    # route's journal tag. A second read of the catalog after the write could
    # name a project opened since (review 6 of PR #114, LOW-1).
    def add(
        self,
        text: Any,
        *,
        node_id: str | None = None,
        position: Any = None,
        graph_nodes: Mapping[str, Any],
    ) -> dict[str, Any]:
        return self.add_in(text, node_id=node_id, position=position, graph_nodes=graph_nodes)[1]

    def add_in(
        self,
        text: Any,
        *,
        node_id: str | None = None,
        position: Any = None,
        graph_nodes: Mapping[str, Any],
    ) -> tuple[str, dict[str, Any]]:
        typed = typed_text(text, limit=MAX_PIN_TEXT, multiline=True)
        if (node_id is None) == (position is None):
            raise PinError(422, "Pin a note to a node (nodeId) or to a canvas spot (position), not both")
        if node_id is not None:
            if not isinstance(node_id, str) or node_id not in graph_nodes:
                raise PinError(404, "That node isn't on the canvas anymore.", {"code": NODE_GONE_CODE})
            anchor: dict[str, Any] = {"nodeId": node_id}
            spot = _stored_position(graph_nodes.get(node_id))
        else:
            spot = _point(position)
            anchor = dict(spot)
        pin = {
            "id": "pin_" + secrets.token_hex(4),
            "text": typed,
            "anchor": anchor,
            "position": spot,
            "status": "open",
            "createdAt": _iso(self._clock()),
            "detached": False,
            "reply": None,
        }

        def mutate(pins: list[dict[str, Any]]) -> dict[str, Any]:
            if sum(1 for p in pins if p.get("status") == "open") >= MAX_OPEN_PINS:
                raise PinError(409, f"There are already {MAX_OPEN_PINS} open notes; delete some first",
                               {"code": OPEN_NOTES_FULL_CODE, "limit": MAX_OPEN_PINS})
            pins.append(pin)
            # Keep the list bounded: drop the oldest resolved pins first.
            while len(pins) > MAX_PINS:
                resolved = [p for p in pins if p.get("status") != "open"]
                if not resolved:
                    break
                oldest = min(resolved, key=lambda p: str(p.get("createdAt") or ""))
                pins.remove(oldest)
            return public_pin(pin, person=True)  # the person's own create (GM r23)

        return self._write(mutate)

    def remove(self, pin_id: str) -> dict[str, Any]:
        return self.remove_in(pin_id)[1]

    def remove_in(self, pin_id: str) -> tuple[str, dict[str, Any]]:
        def mutate(pins: list[dict[str, Any]]) -> dict[str, Any]:
            for index, pin in enumerate(pins):
                if pin.get("id") == pin_id:
                    return public_pin(pins.pop(index))
            raise PinError(404, "That note isn't there anymore. Reload to get the latest notes.")

        return self._write(mutate)

    def resolve(self, pin_id: str, reply: Any, identity: AgentIdentity) -> dict[str, Any]:
        return self.resolve_in(pin_id, reply, identity)[1]

    def resolve_in(self, pin_id: str, reply: Any, identity: AgentIdentity) -> tuple[str, dict[str, Any]]:
        text = typed_text(reply, limit=MAX_REPLY, label="Reply")

        def mutate(pins: list[dict[str, Any]]) -> dict[str, Any]:
            for pin in pins:
                if pin.get("id") == pin_id:
                    # Resolving again replaces the reply: the latest answer wins.
                    pin["status"] = "resolved"
                    pin["reply"] = {"agent": identity.as_dict(), "text": text, "at": _iso(self._clock())}
                    return public_pin(pin)
            # Round 23 (review 22, M-1): pins belong to a project, and an agent
            # that read them before a switch holds another project's ids.
            raise PinError(404, f"No note {pin_id[:40]} on this canvas: that note isn't in the open project "
                                "(it may have changed since you read it). Read the canvas again (look_at_canvas, "
                                "or nebula pins) and answer a note listed there.")

        return self._write(mutate)

    def _detach(self, pins: list[dict[str, Any]], node_ids: Callable[[str], bool],
                positions: Mapping[str, Any], removals: Mapping[str, Mapping[str, Any]] | None = None,
                ) -> list[dict[str, Any]]:
        """Keep each pin of a gone node where the node stood, marked detached.

        ``removals`` maps a deleted node to its removal ({id, definitionId}):
        the pin then keeps that id (``detachedBy``), the model it was on
        (``detachedDefinition``) and the position it had (``attachedPosition``),
        so the undo of that very delete, and only that, can put it back as it
        was (``reattach``). A pin an import or a clear detached gets none of
        them: no undo of a delete brings it back. None of the three is ever
        shown (``public_pin``)."""
        changed = []
        for pin in pins:
            anchored = (pin.get("anchor") or {}).get("nodeId")
            if not isinstance(anchored, str) or not node_ids(anchored):
                continue
            was = copy.deepcopy(pin.get("position"))
            spot = _stored_position({"position": positions.get(anchored)}) or _stored_position(pin)
            spot = spot or {"x": 0.0, "y": 0.0}
            pin["anchor"] = dict(spot)
            pin["position"] = dict(spot)
            pin["detached"] = True
            pin["detachedFrom"] = anchored
            removal = (removals or {}).get(anchored) or {}
            if removal.get("id"):
                pin["detachedBy"] = str(removal["id"])
                pin["detachedDefinition"] = str(removal.get("definitionId") or "")
                pin["attachedPosition"] = was
            else:
                for key in _UNDO_KEYS:
                    pin.pop(key, None)
            # Its public form (review 10 MEDIUM-1): the journal's pin.detached
            # reads it, so its note is the shown text; the store keeps it as typed.
            changed.append(public_pin(pin))
        return changed

    def detach_node(self, node_id: str, position: Any = None, removal: str | None = None,
                    definition_id: str = "") -> list[dict[str, Any]]:
        """The node is gone: keep its pins where it stood, marked detached.
        ``removal`` is the delete's removal id and ``definition_id`` the
        node's model, for its undo (``reattach``)."""
        if not any((pin.get("anchor") or {}).get("nodeId") == node_id for pin in self._active()[1]):
            return []
        removals = {node_id: {"id": removal, "definitionId": definition_id}} if removal else None
        return self._write(lambda pins: self._detach(pins, lambda nid: nid == node_id,
                                                     {node_id: position}, removals))[1]

    def reattach(self, removals: list[Mapping[str, Any]], back: Mapping[str, str],
                 project_id: str | None) -> dict[str, list[dict[str, Any]]]:
        """The undo of a delete brought nodes back: put each pin that delete
        detached on its node again, as if the delete never happened.

        ``removals`` are the removal records the restore names ({id, nodeId,
        pins?}); ``back`` maps each node this restore brought back to its
        model, in ``project_id``. A pin goes back only if it is still
        detached by that very removal (``detachedBy``) from that node
        (``detachedFrom``), and the node came back as the model it was on
        (``detachedDefinition``), in the project it is in. So a stale or
        forged list attaches nothing: a pin someone deleted since, one another
        delete, an import or a clear detached, or one whose node came back as
        another model is left as it is and reported in ``left`` ({id,
        reason, code}, see ``pin_left``). Pins the record doesn't name but the removal detached go
        back too (the record may come from a canvas that never saw the
        delete's answer)."""
        wanted = {str(r["id"]): str(r["nodeId"]) for r in removals if r.get("nodeId") in back}
        if not wanted:
            return {"reattached": [], "left": []}
        named = {str(pin_id): str(r["id"]) for r in removals if r.get("nodeId") in back
                 for pin_id in r.get("pins") or []}

        def mutate(pins: list[dict[str, Any]]) -> dict[str, list[dict[str, Any]]]:
            back_on: list[dict[str, Any]] = []
            left: list[dict[str, Any]] = []
            seen: set[str] = set()
            for pin in pins:
                pin_id = str(pin.get("id") or "")
                removal = pin.get("detachedBy")
                if not (pin.get("detached") and isinstance(removal, str) and removal in wanted
                        and pin.get("detachedFrom") == wanted[removal]):
                    if pin_id in named:
                        seen.add(pin_id)
                        left.append(pin_left(pin_id, CHANGED_SINCE))
                    continue
                seen.add(pin_id)
                node_id = wanted[removal]
                if pin.get("detachedDefinition") != back[node_id]:
                    # The node under that id now is another model: not the one it was on.
                    left.append(pin_left(pin_id, ANOTHER_MODEL))
                    continue
                spot = _stored_position({"position": pin.get("attachedPosition")})
                pin["anchor"] = {"nodeId": node_id}
                pin["position"] = spot
                pin["detached"] = False
                for key in ("detachedFrom", *_UNDO_KEYS):
                    pin.pop(key, None)
                back_on.append(public_pin(pin))  # pin.reattached journals it: shown text (review 10 MEDIUM-1)
            left.extend(pin_left(pin_id, DELETED_SINCE) for pin_id in named if pin_id not in seen)
            return {"reattached": back_on, "left": left}

        try:
            return self._write(mutate, project=project_id)[1]
        except PinError as exc:
            if exc.detail != ANOTHER_PROJECT:
                raise
            return {"reattached": [], "left": [pin_left(pin_id, ANOTHER_PROJECT) for pin_id in named]}

    def reanchor_missing(self, live_node_ids: set[str], positions: Mapping[str, Any] | None = None) -> list[dict[str, Any]]:
        """Detach every pin whose node is no longer on the canvas (after an import or a clear)."""
        stale = [
            pin for pin in self._active()[1]
            if isinstance((pin.get("anchor") or {}).get("nodeId"), str)
            and pin["anchor"]["nodeId"] not in live_node_ids
        ]
        if not stale:
            return []
        try:
            return self._write(lambda pins: self._detach(pins, lambda nid: nid not in live_node_ids,
                                                         positions or {}))[1]
        except PinError:
            return []


LINE_BREAK_MARK = " ⏎ "


def one_line(text: Any) -> str:
    """A note on a one-line surface (an event summary, `nebula watch`): each
    line break shows as " ⏎ " (fix round 3 of PR #200, review 3 LOW-5), so
    the note's second line never reads as the next event, and no two words
    are glued together."""
    return LINE_BREAK_MARK.join(line.strip() for line in agent_text(text).splitlines() if line.strip())


def _clip(text: str, limit: int, max_points: int) -> str:
    """The first ``limit`` characters a person sees, in at most
    ``max_points`` code points with the ellipsis, never half a family (PR
    #200 fix round 14: the events feed cuts a summary past 200 code points
    wherever that falls)."""
    ends = list(_character_ends(text))
    if len(ends) <= limit and len(text) <= max_points:
        return text
    kept = 0
    for index, end in enumerate(ends):
        if index >= limit or end > max_points - 1:
            break
        kept = end
    return text[:kept] + "…"


# canvas_events.MAX_SUMMARY_CHARS: a summary past it is cut mid-character.
SUMMARY_POINTS = 200


def pin_summary(pin: Mapping[str, Any]) -> str:
    anchor = pin.get("anchor") or {}
    where = f"on {anchor['nodeId']}" if "nodeId" in anchor else "on the canvas"
    return f'pinned "{_clip(one_line(pin.get("text")), 60, 120)}" {where}'


def pin_resolved_summary(pin_id: str, pin: Mapping[str, Any], reply: Any) -> str:
    """The pin.resolved event's summary: one line, the note cut at 40
    characters, the reply cut to fit the feed's 200, each on a character's edge."""
    head = f'answered the note {pin_id} ("{_clip(one_line(pin.get("text")), 40, 80)}"): '
    return head + clip_characters(one_line(reply), max(SUMMARY_POINTS - len(head), 2))
