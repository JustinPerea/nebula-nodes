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

# Dropped outright: the bidi embeddings, overrides (U+202A-U+202E) and
# isolates (U+2066-U+2069), which reorder the text around them on screen.
_BIDI_CONTROLS = frozenset("\u202a\u202b\u202c\u202d\u202e\u2066\u2067\u2068\u2069")


def clean_name(value: object, limit: int | None = None, *, fallback: str = "", ellipsis: bool = False) -> str:
    """A stored item's name (a moodboard's, a Character's, a Style's) as it
    may be put into a line that an agent or a person reads: the journal, the
    Agent log, a cursor's say and label, a refusal, MCP and CLI text.

    Names are free text and an agent can set one, so a name must not be able
    to repaint a terminal, forge a second log line or reorder the words
    around it. What changes:

    - Whitespace-like characters (TAB, CR, LF, VT, FF, the C0 separators
      U+001C-U+001F, NEL, U+2028 and U+2029 which forge a line break, and the
      Unicode spaces) each become one space, so two words never fuse
      ("Dusk\\nGrain" is "Dusk Grain"). Runs of spaces collapse to one and the
      ends are stripped, as the cursor's names always were.
    - Every other category Cc character (ESC and its terminal sequences, NUL,
      backspace, DEL, the rest of C1), the nine bidi controls above and lone
      surrogates (so the result always encodes as UTF-8) are dropped: they
      carry no word, so a space for them would split "Du\\x1bsk" in two.
    - Everything else stays: ZWJ and ZWNJ (emoji families, Persian and Indic
      names), LRM, RLM and ALM (marks that don't reorder the text around
      them), variation selectors, emoji tag characters, combining marks and
      every letter. This is why it is not ``cursor_actions._shown``, which
      replaces every category C* code point.

    ``limit`` cuts the cleaned name to that many characters through
    ``safe_cut`` (after the cleaning, so a cut never lands inside a removed
    sequence); ``ellipsis`` ends a cut name with U+2026 inside the limit. A
    value that is empty once cleaned gives ``fallback`` (what the caller
    shows for an unnamed item). Pure, never raises on any str, linear: with a
    ``limit`` only the first ``16 * limit + 256`` characters are read, so a
    100 KB name is not walked whole. Cleaning twice gives what once does."""
    if value is None:
        return fallback
    text = value if isinstance(value, str) else str(value)
    if limit is not None:
        text = text[:16 * limit + 256]
    out: list[str] = []
    for char in text:
        if char.isspace():
            if out and out[-1] != " ":
                out.append(" ")
        elif char in _BIDI_CONTROLS or 0xD800 <= ord(char) <= 0xDFFF or unicodedata.category(char) == "Cc":
            continue
        else:
            out.append(char)
    shown = "".join(out).strip()
    if limit is not None and len(shown) > limit:
        if ellipsis:
            shown = shown[:safe_cut(shown, limit - 1)].rstrip() + "…"
        else:
            # A name that is one long character (a letter under many marks)
            # has no safe cut: it is cut plainly rather than shown as no name.
            shown = shown[:safe_cut(shown, limit) or limit].rstrip()
    return shown or fallback
