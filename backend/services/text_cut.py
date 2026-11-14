"""Cutting an agent's line of text short without splitting a character.

Python indexes code points, so a plain ``text[:n]`` can still cut through
what a person reads as one character: a letter and its combining accent,
an emoji ZWJ sequence (a family), an emoji and its variation selector or
skin tone, a flag's two regional indicators, a Hangul syllable's jamo,
an Indic conjunct (क्ष: a consonant, a virama and the consonant after it).
``safe_cut`` moves a cut back to the start of that character instead
(review 7, L5: "the hard cut must never split a character"). It covers the
grapheme rules that matter for one line of agent text; it is not a full
UAX #29 segmenter (no third-party package for one line).
"""
from __future__ import annotations

import re
import unicodedata

ZWJ = "\u200d"


def _extends(char: str) -> bool:
    """A code point that belongs to the character before it."""
    code = ord(char)
    if char == ZWJ:
        return True
    if 0xFE00 <= code <= 0xFE0F or 0xE0100 <= code <= 0xE01EF:  # variation selectors
        return True
    if 0x1F3FB <= code <= 0x1F3FF:  # emoji skin tones
        return True
    if 0xE0020 <= code <= 0xE007F:  # emoji tag sequences (subdivision flags)
        return True
    if 0x1160 <= code <= 0x11FF or 0xD7B0 <= code <= 0xD7FF:  # Hangul medial vowels and finals
        return True
    return unicodedata.category(char) in ("Mn", "Me", "Mc")


def _regional(char: str) -> bool:
    return 0x1F1E6 <= ord(char) <= 0x1F1FF


def safe_cut(text: str, end: int) -> int:
    """The largest index <= ``end`` where ``text`` can be cut without
    splitting a character: ``text[:safe_cut(text, end)]``."""
    end = max(0, min(end, len(text)))
    while 0 < end < len(text):
        if _extends(text[end]) or text[end - 1] == ZWJ:
            end -= 1
            continue
        # An Indic conjunct (क्ष: a consonant, a virama, the consonant after
        # it) is one character: a cut after its virama backs off to its start
        # (review 8, nit; UAX #29 GB9c, read through the virama's combining class).
        if unicodedata.combining(text[end - 1]) == 9 and unicodedata.category(text[end]) == "Lo":
            end -= 1
            continue
        if _regional(text[end]) and _regional(text[end - 1]):
            start = end - 1
            while start > 0 and _regional(text[start - 1]):
                start -= 1
            if (end - start) % 2 == 1:  # the cut falls inside a pair
                end -= 1
                continue
        break
    return end


# -- an item's name, as it is put into text another reader reads -------------------------

# Terminal escape sequences, each dropped whole (PR #200 review 7 N-3 and
# review 8 NIT-3), so no "Pq#0;2;0;0;0" or "[31m" is left behind: CSI (7- and
# 8-bit), then the string sequences OSC, DCS, APC, PM and SOS
# (ESC ] P _ ^ X, or 8-bit 0x9d 0x90 0x9f 0x9e 0x98), each with its payload up
# to its end: ST (ESC \ or 0x9c) or BEL, even past an inner ESC. One left
# unterminated goes to the end of its line. services/canvas_pins uses the
# same pattern for a pin's text.
ANSI_SEQUENCE = re.compile(
    r"\x1b\[[0-?]*[ -/]*[@-~]"
    r"|\x9b[0-?]*[ -/]*[@-~]"
    r"|(?:\x1b[\]P_^X]|[\x90\x98\x9d\x9e\x9f])[^\r\n]*?(?:\x1b\\|\x9c|\x07|(?=[\r\n])|\Z)"
)

# Format characters (category Cf) a name keeps: ZWNJ and ZWJ (Persian and
# Indic names, emoji families) and the marks LRM, RLM and ALM, which only
# settle the direction of the neutral characters beside them.
_KEPT_FORMAT = frozenset(map(chr, (0x200C, 0x200D, 0x200E, 0x200F, 0x061C)))
# The only emoji that are spelled with tag characters: the flags of England,
# Scotland and Wales (a black flag, the tags, a cancel tag). The same three
# as services/canvas_pins keeps; a test holds the two sets equal.
TAG_FLAGS = frozenset({"gbeng", "gbsct", "gbwls"})
_BLACK_FLAG = chr(0x1F3F4)
_CANCEL_TAG = chr(0xE007F)
# With no ``limit``, a name is read this far and no further.
_UNLIMITED_READ = 4096


def clean_name(value: object, limit: int | None = None, *, fallback: str = "", ellipsis: bool = False) -> str:
    """A stored item's name (a moodboard's, a Character's, a Style's, a
    look's) as it may be put into a line that an agent or a person reads: the
    journal, the Agent log, a cursor's say and label, a refusal, MCP and CLI
    text.

    Names are free text and an agent can set one, so a name must not be able
    to repaint a terminal, forge a second log line, reorder the words around
    it, or carry text the person cannot see. What changes:

    - A terminal escape sequence goes whole (``ANSI_SEQUENCE``), so
      "Dusk\\x1b[31m" is "Dusk" and not "Dusk[31m".
    - Whitespace-like characters (TAB, CR, LF, VT, FF, the C0 separators
      U+001C-U+001F, NEL, U+2028 and U+2029 which forge a line break, and the
      Unicode spaces) each become one space, so two words never fuse
      ("Dusk\\nGrain" is "Dusk Grain"). Runs of spaces collapse to one and the
      ends are stripped, as the cursor's names always were.
    - Every other category Cc character (a lone ESC, NUL, backspace, DEL, the
      rest of C1) and lone surrogates (so the result always encodes as UTF-8)
      are dropped: they carry no word, so a space for them would split
      "Du\\x1bsk" in two.
    - Category Cf, the format characters that draw nothing, is dropped: the
      bidi embeddings, overrides and isolates (U+202A-U+202E, U+2066-U+2069),
      which reorder the text around them; the zero-width space, word joiner,
      BOM, interlinear annotation marks and the rest, which make two names
      look the same; and tag characters (U+E0000-U+E007F), which can spell a
      sentence a model reads and a person never sees. Kept: ZWNJ and ZWJ, the
      marks LRM, RLM and ALM, and the tags inside the flags of England,
      Scotland and Wales.
    - Everything else stays: variation selectors, combining marks, every
      letter and emoji. This is why it is not ``cursor_actions._shown``,
      which replaces every category C* code point.

    ``limit`` cuts the cleaned name to that many characters through
    ``safe_cut`` (after the cleaning, so a cut never lands inside a removed
    sequence); ``ellipsis`` ends a cut name with U+2026 inside the limit. A
    value that is empty once cleaned gives ``fallback`` (what the caller
    shows for an unnamed item). Pure, never raises on any str, linear and
    bounded: with a ``limit`` only the first ``16 * limit + 256`` characters
    are read, and without one the first 4,096, so a 100 KB name is not walked
    whole. Cleaning twice gives what once does."""
    if value is None:
        return fallback
    text = value if isinstance(value, str) else str(value)
    text = text[:16 * limit + 256] if limit is not None else text[:_UNLIMITED_READ]
    text = ANSI_SEQUENCE.sub("", text)
    out: list[str] = []
    index, size = 0, len(text)
    while index < size:
        char = text[index]
        if char == _BLACK_FLAG:
            end = index + 1
            while end < size and 0xE0020 <= ord(text[end]) <= 0xE007E:
                end += 1
            spec = "".join(chr(ord(tag) - 0xE0000) for tag in text[index + 1:end])
            if spec in TAG_FLAGS and end < size and text[end] == _CANCEL_TAG:
                out.extend(text[index:end + 1])
                index = end + 1
                continue
        index += 1
        if char.isspace():
            if out and out[-1] != " ":
                out.append(" ")
        elif char in _KEPT_FORMAT:
            out.append(char)
        elif (0xD800 <= ord(char) <= 0xDFFF or 0xE0000 <= ord(char) <= 0xE007F
              or unicodedata.category(char) in ("Cc", "Cf")):
            # The whole tag block goes, its unassigned code points included.
            continue
        else:
            out.append(char)
    shown = "".join(out).strip()
    if limit is not None and len(shown) > limit:
        # A name that is one long character (a letter under many marks) has
        # no safe cut: it is cut plainly rather than shown as no name.
        if ellipsis:
            shown = shown[:safe_cut(shown, limit - 1) or max(limit - 1, 0)].rstrip() + chr(0x2026)
        else:
            shown = shown[:safe_cut(shown, limit) or limit].rstrip()
    return shown or fallback
