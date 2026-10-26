"""Cutting an agent's line of text short without splitting a character.

Python indexes code points, so a plain ``text[:n]`` can still cut through
what a person reads as one character: a letter and its combining accent,
an emoji ZWJ sequence (a family), an emoji and its variation selector or
skin tone, a flag's two regional indicators, a Hangul syllable's jamo.
``safe_cut`` moves a cut back to the start of that character instead
(review 7, L5: "the hard cut must never split a character"). It covers the
grapheme rules that matter for one line of agent text; it is not a full
UAX #29 segmenter (no third-party package for one line).
"""
from __future__ import annotations

import unicodedata

ZWJ = "‍"


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
        if _regional(text[end]) and _regional(text[end - 1]):
            start = end - 1
            while start > 0 and _regional(text[start - 1]):
                start -= 1
            if (end - start) % 2 == 1:  # the cut falls inside a pair
                end -= 1
                continue
        break
    return end
