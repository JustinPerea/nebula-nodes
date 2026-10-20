"""Reading a Gemini answer as it streams, for the moodboard reader.

The reader asks for one JSON object with a list of items, ``{"readings":
[{ref, ...}, ...]}``, through a response schema. Google streams it as
``streamGenerateContent?alt=sse`` chunks whose text concatenates to that
object ("The streamed chunks are valid partial JSON strings that can be
concatenated to form the final JSON object", structured-output guide, checked
2026-10-20), but sends no event per item. This module cuts each item out as it
closes (docs/moodboard-canvas-plan.md section 5.6.1):

- ``SSEDecoder`` turns bytes into event payloads, wherever the chunks split
  (inside a UTF-8 character, a CRLF or a ``data:`` line).
- ``read_payload`` joins the text of every part of the first candidate, not
  only ``parts[0]`` (``handlers/google_gemini.py``'s stream keeps only that
  one), and keeps parts marked ``thought: true`` apart: their text goes to the
  thought stream and never reaches the JSON buffer.
- ``ItemScanner`` scans the answer as it arrives and calls ``focus(ref)``
  when an item's ``ref`` string closes and ``item(obj)`` when the item closes.
  It never relies on key order: with ``ref`` first (the schema asks for it),
  ``focus`` comes early; with ``ref`` anywhere else it still comes before
  ``item``.
- ``GeminiStreamParser`` ties them together for one request, streaming or
  not: a reader that can't stream hands it the whole response at once and
  gets the same calls, in the same order, at the end.

``clean_model_text`` and ``trim_reason`` are the rules for text the model
wrote that a person reads: no batch label or ``#n`` (board numbers shift when
an image is removed, and labels mean nothing outside their batch), and a
reason of at most 120 characters, cut at a word.
"""
from __future__ import annotations

import codecs
import json
import re
import unicodedata
from dataclasses import dataclass, field
from typing import Any, Callable

REASON_LIMIT = 120

# Look-alikes of the characters the label and link checks match, from other
# scripts: Unicode's confusables data (UTS #39, "Unicode Security
# Mechanisms", confusables.txt version 18.0.0, 2026-08-06,
# https://www.unicode.org/Public/security/latest/confusables.txt), each
# prototype with every source that maps to it alone, kept only where the
# source is a letter or decimal digit (anything else fails the look-name
# check's character list first), is unchanged by NFKC (else the
# compatibility check refuses it first) and isn't ASCII. The prototypes are
# the batch labels A to F, the sort label's R and digits, and the letters of
# the label nouns and of "https"/"www". UTS #39 gives I no prototype of its
# own: Cyrillic І, Greek Ι and the like map to "l", so the nouns take an "l"
# where "Image" has its I. Examples: Cyrillic А В С Е and Greek Α Β Ε are A B
# C E; Cyrillic Р and Greek Ρ are P (not R); Cyrillic г is r, З is 3, һ is h,
# ԝ is w. "@" and "#" have no entry: their look-alikes (＠ ﹫ ＃ ﹟) are
# compatibility characters. ``skeleton`` applies this map one character for
# one, so a match in the skeleton is a match at the same place in the text;
# it is only ever used to look, never stored or shown.
_CONFUSABLES = {
    "2": "\u01a7\u03e8\u10c7\u14bf\u1616\u1cb7\ua644\ua75a",
    "3": "\u01b7\u021c\u0417\u04e0\u0545\u0969\u0ae9\u1702\u1c95\u2c9c\u2cc4\u2ccc\ua76a\ua7ab\U000118ca\U00016f3b",
    "4": "\u13ce\uab9e\U000118af",
    "5": "\u01bc\U000118bb",
    "6": "\u03ec\u0431\u13ee\u2cd2\u2cd3\u2cdc\ua543\uabbe\U000118d5",
    "7": "\u172a\u1c84\U000104d2\U000118c6",
    "8": "\u0222\u0223\u09ea\u0a6a\ua589\U0001031a\U000169fe",
    "9": "\u09ed\u0a67\u0b68\u0d6d\u2cca\u2ccb\ua76e\ua76f\U000118ac\U000118cc\U000118d6\U000169c1\U0001e2f2",
    "A": "\u0391\u0410\u13aa\u15c5\ua4ee\U000102a0\U00016f40",
    "B": "\u0392\u0412\u13f4\u15f7\u2c82\ua4d0\ua557\ua7b4\U00010282\U000102a1\U00010301",
    "C": "\u0421\u13df\u2ca4\ua4da\U000102a2\U00010302\U00010415\U0001051b\U000118e9",
    "D": "\u13a0\u15de\u15ea\ua4d3",
    "E": "\u0395\u0415\u13ac\u2d39\ua4f0\ua5cb\U00010286\U000118a6\U000118ae",
    "F": "\u03dc\u07d3\u15b4\ua4dd\ua798\U00010287\U000102a5\U00010525\U000118a2\U000118c2",
    "G": "\u050c\u13c0\u13f3\ua4d6",
    "H": "\u0397\u041d\u13bb\u157c\u2c8e\ua4e7\U000102cf",
    "M": "\u039c\u03fa\u041c\u13b7\u15f0\u16d6\u2c98\ua4df\U000102b0\U00010311\U00010c21",
    "N": "\u039d\u2c9a\ua4e0\U00010513\U00011abe",
    "O": "\u039f\u041e\u0555\u07c0\u0b20\u0ce6\u12d0\u1cbf\u2c9e\u2d54\ua4f3\U00010292\U000102ab\U0001030f\U00010404\U000104c2\U00010516\U00010c17\U000118b5\U000118e0\U00016ae9\U0001e140\U0001e2f0",
    "P": "\u03a1\u0420\u13e2\u146d\u2ca2\u2cce\ua4d1\U00010295",
    "R": "\u01a6\u024c\u13a1\u13d2\u1587\ua4e3\U000104b4\U00016f35",
    "S": "\u0405\u054f\u10bd\u10fd\u13d5\u13da\u1cbd\ua4e2\ua576\U00010296\U00010420\U00016ad6\U00016f3a",
    "T": "\u03a4\u0422\u07e0\u13a2\u2ca6\u3112\u4e05\ua4d4\ua50b\U00010297\U000102b1\U00010315\U000118bc\U00016f0a",
    "U": "\u054d\u1200\u144c\ua4f4\U000104ce\U000118b8\U00016f42",
    "W": "\u051c\u13b3\u13d4\ua4ea\U000118e6",
    "a": "\u0251\u03b1\u0430\uab64",
    "b": "\u0184\u042c\u07d5\u13cf\u1472\u15af\U0001031c",
    "c": "\u0441\u1004\u105a\u1c83\u1d04\u2ca5\uabaf\U0001043d",
    "d": "\u0501\u13e7\u146f\ua4d2",
    "e": "\u0435\u04bd\uab32",
    "f": "\u0192\u0284\u0584\u1e9d\ua799\uab35",
    "g": "\u018d\u0261\u0581\u1d83",
    "h": "\u04ba\u04bb\u0570\u10b9\u13c2",
    "i": "\u0131\u0269\u026a\u03b9\u0456\u0582\u13a5\u2c93\ua647\uab75\U000118c3",
    "l": "\u0196\u01c0\u0399\u0406\u04c0\u04cf\u05d5\u05df\u0627\u0661\u06f1\u07ca\u16c1\u16d0\u2c92\u2d4a\u2d4f\ua4f2\ua56f\ua781\ua7ae\ua7fe\U0001028a\U00010309\U0001050e\U00010926\U00010c3e\U00010ca5\U00016d63\U00016f28\U0001e141",
    "n": "\u0578\u057c",
    "o": "\u03bf\u03c3\u03ed\u043e\u0585\u05e1\u0647\u0665\u06be\u06c1\u06d5\u06f5\u07cb\u0840\u0966\u09e6\u0a66\u0ae6\u0b66\u0be6\u0c66\u0d20\u0d66\u0e50\u0ed0\u101d\u1040\u10ff\u110b\u11bc\u17e0\u1a45\u1a80\u1a90\u1c82\u1d0f\u1d11\u2c9f\uab3d\U0001042c\U000104ea\U0001092c\U00010d07\U00011124\U000114d0\U000118c8\U000118d7",
    "p": "\u00fe\u01bf\u03c1\u03f8\u0440\u2ca3\u2ccf",
    "r": "\u0433\u1d26\u2c85\uab47\uab48\uab81\U00016a19",
    "s": "\u01bd\u0455\u0d1f\ua731\uabaa\U00010448\U000118c1",
    "u": "\u028b\u03c5\u057d\u1d1c\ua79f\uab4e\uab52\U000104f6\U000118d8",
    "w": "\u026f\u0448\u0461\u051d\u0561\u1d21\u2cbd\ua7fa\uab83\uaba4\U0001170a\U0001170e\U0001170f",
}
_SKELETON = str.maketrans({source: prototype for prototype, sources in _CONFUSABLES.items() for source in sources})
# The same text read for digits, for the ``#n`` and sort-label checks. UTS #39
# reads some decimal digits as letters (Arabic-Indic ١ as "l", ٥ and Devanagari
# ० as "o"), which suits the noun and link checks but would hide "R١" and
# "#١٨"; here every decimal digit is its own value. And since UTS #39 reads 1
# as "l" and 0 as "O", a look-alike of those two from another script (Cyrillic
# Ӏ, Greek Ι; Cyrillic О, Greek Ο) is a 1 or a 0 here, as Cyrillic З is a 3.
_DIGIT_SKELETON = str.maketrans({
    source: (str(unicodedata.decimal(source)) if source.isdecimal()
             else {"l": "1", "O": "0"}.get(prototype, prototype))
    for prototype, sources in _CONFUSABLES.items() for source in sources
})


def skeleton(text: str) -> str:
    """``text`` with each look-alike in ``_CONFUSABLES`` read as the
    character it copies, one for one (same length, same positions)."""
    return text.translate(_SKELETON)


def skeletons(text: str) -> tuple[str, str]:
    """``text`` as the label and link checks read it: ``skeleton`` for
    letters, and the digit reading (``_DIGIT_SKELETON``) for ``#n`` and sort
    labels. Both are one for one with ``text``, so a match in either is a
    match at the same place in it."""
    return text.translate(_SKELETON), text.translate(_DIGIT_SKELETON)


# "Image B", "images A and C", "Image B and #18", "ref D's", "#18", "# 18",
# and ranges: "images A–C", "B-D", "Image A to C", "#3 through #5".
# The noun is matched in any case, the label only as a capital A to F, so
# "image a bit" stays. A letter glued to &, /, -, ' or ’ and then more of a word
# is part of that word, not a label ("B&W", "B/W", "B-movie", "D'Arcy"), unless
# what follows is itself a label ("A&B", "A/B", "A-C") or a possessive ("B's").
# A join between a stripped label and such a word goes with the label
# ("Images A & B-movie glow" is "B-movie glow").
_LABEL_NOUN = r"\b(?i:[il]mages?|[il]mgs?|pictures?|photos?|references?|refs?)"
_LABEL_JOIN = r"(?:,|/|&|-|–|—|\b(?i:and|or|to|through|thru)\b)"


def _label_letter(letters: str) -> str:
    """One label letter of ``letters``, standing alone: not glued to a
    joiner and then a word that isn't a label or ``'s``."""
    lone = letters + r"\b"
    return lone + r"(?!" + _glued(lone) + r")"


def _glued(lone: str) -> str:
    """A joiner and then more of a word: not a label (``lone``) or ``'s``."""
    return r"(?:[&/\-–—](?!" + lone + r")|['’](?!" + lone + r"|s\b))\w"


def _label_token(letters: str) -> re.Pattern[str]:
    letter = _label_letter(letters)
    unit = r"(?:" + _LABEL_NOUN + r"\s+" + letter + r"|#\s?\d+\b)"
    # The join before a glued word ("Images A & B-movie"), not a comma.
    before_word = r"(?:\s*(?:&|/|-|–|—|\b(?i:and|or)\b)\s*(?=" + letters + r"\b" + _glued(letters + r"\b") + r"))?"
    return re.compile(unit + r"(?:\s*" + _LABEL_JOIN + r"\s*(?:" + unit + r"|" + letter + r"))*(?:['’]s\b)?"
                      + before_word)


_LABEL_TOKEN = _label_token("[A-F]")
# The same in any case, for look names: ``names_a_label_any_case``.
_LABEL_TOKEN_ANY_CASE = _label_token("[A-Fa-f]")
_LABEL_NOUN_RE = re.compile(_LABEL_NOUN)
_LONE_LETTER = re.compile(r"(?<![^\W\d_])[A-Za-z](?![^\W\d_])")
# A bare label in brackets, with no noun: "(B)", "(B, C)", "[A–C]".
_BRACKET_LABELS = re.compile(
    r"[(\[]\s*[A-F](?:\s*" + _LABEL_JOIN + r"\s*[A-F])*\s*[)\]]"
)
# An "and"/"or" left with nothing after it once a label went: "in and", "in and,".
_DANGLING_JOIN = re.compile(r"\s+\b(?i:and|or)\b(?=\s*(?:[,.;:!?)\]]|$))")
_SPACE_BEFORE_PUNCT = re.compile(r"\s+([,.;:!?)\]])")
_EMPTY_BRACKETS = re.compile(r"\(\s*\)|\[\s*\]")
_DOUBLE_PUNCT = re.compile(r"([,;:])\s*(?=[,;:.!?])")
_SPACES = re.compile(r"\s+")


def _cut(pattern: re.Pattern[str], text: str) -> str:
    """``pattern.sub(" ", text)``, matched on both ``skeletons(text)``: a
    label spelled with look-alikes goes too, and the rest keeps its own
    letters. Where the two readings' matches overlap, their union goes."""
    spans = sorted(match.span() for view in skeletons(text) for match in pattern.finditer(view))
    merged: list[list[int]] = []
    for start, end in spans:
        if merged and start <= merged[-1][1]:
            merged[-1][1] = max(merged[-1][1], end)
        else:
            merged.append([start, end])
    out, last = [], 0
    for start, end in merged:
        out += [text[last:start], " "]
        last = end
    return "".join(out) + text[last:] if out else text


def clean_model_text(text: Any) -> str:
    """Model-written text with every batch label and ``#n`` token taken out,
    and the punctuation they leave behind tidied."""
    if not isinstance(text, str):
        return ""
    cleaned = _cut(_BRACKET_LABELS, _cut(_LABEL_TOKEN, text))
    stripped = cleaned != text
    cleaned = _EMPTY_BRACKETS.sub(" ", cleaned)
    cleaned = _SPACES.sub(" ", cleaned)
    if stripped:  # only tidy an "and" a removed label left behind
        cleaned = _DANGLING_JOIN.sub("", cleaned)
    cleaned = _SPACE_BEFORE_PUNCT.sub(r"\1", cleaned)
    cleaned = _DOUBLE_PUNCT.sub("", cleaned)
    return cleaned.strip(" ,;:-–—").strip()


def names_a_label(text: str) -> bool:
    """Whether ``text`` names a batch label or a ``#n`` ("Image B", "ref C",
    "#18", "(B)"), as ``clean_model_text`` would strip."""
    return any(_LABEL_TOKEN.search(view) or _BRACKET_LABELS.search(view) for view in skeletons(text))


def names_a_label_any_case(text: str) -> bool:
    """``names_a_label`` with the label letter in either case ("image b",
    "Images b and c"), as a look name is checked, except that a lone
    lowercase "a" is the article ("Photo a day", "Image a bit"): a run of
    labels after a noun counts only when one of its letters isn't "a"
    ("Images a and b" counts; "Image A" does too)."""
    for match in (found for view in skeletons(text) for found in _LABEL_TOKEN_ANY_CASE.finditer(view)):
        found = match.group()
        if "#" in found or any(letter != "a" for letter in _LONE_LETTER.findall(_LABEL_NOUN_RE.sub(" ", found))):
            return True
    return False


def trim_reason(text: str, limit: int = REASON_LIMIT) -> str:
    """At most ``limit`` characters, cut at a word boundary with an ellipsis.
    Google's schema can't cap a string's length (``maxLength`` is ignored),
    so the prompt asks and this enforces; an item is never failed for it."""
    text = text.strip()
    if len(text) <= limit:
        return text
    cut = text[: limit - 1]
    if " " in cut:
        cut = cut[: cut.rfind(" ")]
    return cut.rstrip(" ,;:-–—.") + "…"


def split_text(text: str, limit: int) -> list[str]:
    """``text`` in pieces of at most ``limit`` characters, split at spaces."""
    pieces: list[str] = []
    rest = text.strip()
    while len(rest) > limit:
        cut = rest.rfind(" ", 0, limit + 1)
        if cut <= 0:
            cut = limit
        pieces.append(rest[:cut].rstrip())
        rest = rest[cut:].lstrip()
    if rest:
        pieces.append(rest)
    return pieces


# -- server-sent events -------------------------------------------------------

class SSEDecoder:
    """Bytes in, the ``data`` of each finished event out.

    A chunk may end anywhere: inside a multi-byte character, between the CR
    and LF of a line end, or in the middle of a ``data:`` line. ``close``
    gives the last event of a stream that ended without a blank line."""

    def __init__(self) -> None:
        self._decoder = codecs.getincrementaldecoder("utf-8")("replace")
        self._buffer = ""
        self._data: list[str] = []

    def feed(self, chunk: bytes) -> list[str]:
        self._buffer += self._decoder.decode(chunk)
        return self._drain(final=False)

    def close(self) -> list[str]:
        self._buffer += self._decoder.decode(b"", final=True)
        events = self._drain(final=True)
        if self._buffer:
            self._line(self._buffer, events)
            self._buffer = ""
        if self._data:
            events.append("\n".join(self._data))
            self._data = []
        return events

    def _drain(self, *, final: bool) -> list[str]:
        events: list[str] = []
        while True:
            newline = self._buffer.find("\n")
            carriage = self._buffer.find("\r")
            ends = [i for i in (newline, carriage) if i >= 0]
            if not ends:
                return events
            end = min(ends)
            width = 1
            if self._buffer[end] == "\r":
                if end + 1 == len(self._buffer) and not final:
                    return events  # the LF of a CRLF may be in the next chunk
                if self._buffer[end + 1: end + 2] == "\n":
                    width = 2
            line, self._buffer = self._buffer[:end], self._buffer[end + width:]
            self._line(line, events)

    def _line(self, line: str, events: list[str]) -> None:
        if line == "":
            if self._data:
                events.append("\n".join(self._data))
                self._data = []
            return
        if line.startswith(":"):
            return
        name, _, value = line.partition(":")
        if name == "data":
            self._data.append(value[1:] if value.startswith(" ") else value)


# -- one chunk of a Gemini answer ----------------------------------------------

@dataclass
class ChunkParts:
    answer: list[str] = field(default_factory=list)
    thoughts: list[str] = field(default_factory=list)
    finish_reason: str | None = None
    usage: dict[str, Any] | None = None
    error: str | None = None
    block_reason: str | None = None


def read_payload(payload: Any) -> ChunkParts:
    """The answer text and thought text of one ``GenerateContentResponse``
    (a streamed chunk or a whole non-streaming answer), from every part of
    the first candidate."""
    out = ChunkParts()
    if not isinstance(payload, dict):
        out.error = "Google sent something that isn't a response"
        return out
    error = payload.get("error")
    if isinstance(error, dict):
        out.error = str(error.get("message") or error.get("status") or "Google returned an error")[:300]
        return out
    feedback = payload.get("promptFeedback")
    if isinstance(feedback, dict) and feedback.get("blockReason"):
        out.block_reason = str(feedback["blockReason"])
    usage = payload.get("usageMetadata")
    if isinstance(usage, dict):
        out.usage = usage
    candidates = payload.get("candidates")
    if not isinstance(candidates, list) or not candidates or not isinstance(candidates[0], dict):
        return out
    candidate = candidates[0]
    if candidate.get("finishReason"):
        out.finish_reason = str(candidate["finishReason"])
    content = candidate.get("content")
    parts = content.get("parts") if isinstance(content, dict) else None
    for part in parts if isinstance(parts, list) else []:
        if not isinstance(part, dict):
            continue
        text = part.get("text")
        if not isinstance(text, str) or not text:
            continue
        (out.thoughts if part.get("thought") is True else out.answer).append(text)
    return out


# -- items as they close ---------------------------------------------------------

@dataclass
class _Frame:
    kind: str                  # "{" or "["
    start: int
    after_colon: bool = False  # objects: the next string is a value
    key: str | None = None     # objects: the key whose value comes next
    items: bool = False        # arrays: the root key's item list
    item: bool = False         # objects: one item of that list


class ItemScanner:
    """Finds each finished item of ``{"<items_key>": [{...}, ...]}`` as the
    text arrives, in any number of pieces.

    ``on_focus(ref)`` is called when an item's ``ref_key`` string closes, and
    ``on_item(obj)`` when the item closes (``obj`` is the parsed item, or None
    when its text isn't JSON). Only items directly in that list count; text
    outside the root object (a code fence, say) is ignored."""

    def __init__(self, items_key: str, *, ref_key: str = "ref",
                 on_focus: Callable[[str], None] | None = None,
                 on_item: Callable[[Any], None] | None = None) -> None:
        self.items_key = items_key
        self.ref_key = ref_key
        self._on_focus = on_focus
        self._on_item = on_item
        self.text = ""
        self._stack: list[_Frame] = []
        self._in_string = False
        self._escape = False
        self._string_start = 0
        self._root_closed = False
        self.items_seen = 0

    def feed(self, piece: str) -> None:
        start = len(self.text)
        self.text += piece
        for offset, char in enumerate(piece):
            self._char(char, start + offset)

    def _char(self, char: str, at: int) -> None:
        if self._in_string:
            if self._escape:
                self._escape = False
            elif char == "\\":
                self._escape = True
            elif char == '"':
                self._in_string = False
                self._string_closed(at)
            return
        if self._root_closed:
            return
        if not self._stack:
            if char == "{":
                self._stack.append(_Frame("{", at))
            return
        top = self._stack[-1]
        if char == '"':
            self._in_string = True
            self._string_start = at
        elif char in "{[":
            frame = _Frame(char, at)
            if char == "[" and len(self._stack) == 1 and top.after_colon and top.key == self.items_key:
                frame.items = True
            elif char == "{" and top.kind == "[" and top.items:
                frame.item = True
            self._stack.append(frame)
        elif char in "}]":
            frame = self._stack.pop()
            if not self._stack:
                self._root_closed = True
            elif frame.item:
                self._item_closed(frame, at)
        elif char == ":" and top.kind == "{":
            top.after_colon = True
        elif char == "," and top.kind == "{":
            top.after_colon = False
            top.key = None

    def _string_closed(self, at: int) -> None:
        if not self._stack:
            return
        top = self._stack[-1]
        if top.kind != "{":
            return
        try:
            value = json.loads(self.text[self._string_start: at + 1])
        except ValueError:
            return
        if not top.after_colon:
            top.key = value
        elif top.item and top.key == self.ref_key and self._on_focus is not None:
            self._on_focus(value)

    def _item_closed(self, frame: _Frame, at: int) -> None:
        self.items_seen += 1
        try:
            item = json.loads(self.text[frame.start: at + 1])
        except ValueError:
            item = None
        if self._on_item is not None:
            self._on_item(item)

    @property
    def complete(self) -> bool:
        """Whether the root object closed."""
        return self._root_closed

    def value(self) -> Any:
        """The whole answer parsed, or None when it isn't one JSON value."""
        text = self.text.strip()
        if text.startswith("```"):
            text = text.removeprefix("```json").removeprefix("```").removesuffix("```").strip()
        try:
            return json.loads(text)
        except ValueError:
            return None


# -- one request -------------------------------------------------------------------

@dataclass
class StreamOutcome:
    text: str
    value: Any                 # the parsed answer, or None
    complete: bool             # the answer's root object closed
    finish_reason: str | None
    usage: dict[str, Any]
    error: str | None
    block_reason: str | None
    events: int
    malformed_events: int


class GeminiStreamParser:
    """One request's answer: bytes (``feed_bytes``) or whole payloads
    (``feed_payload``, for a non-streaming reader) in; the item calls, the
    thought text and the finish reason and usage out.

    With ``items_key`` the answer is scanned for items; without it, the text
    is only collected (the text-call helper)."""

    def __init__(self, *, items_key: str | None = None, ref_key: str = "ref",
                 on_focus: Callable[[str], None] | None = None,
                 on_item: Callable[[Any], None] | None = None,
                 on_thought: Callable[[str], None] | None = None) -> None:
        self._sse = SSEDecoder()
        self._scanner = ItemScanner(items_key or "\0", ref_key=ref_key, on_focus=on_focus, on_item=on_item)
        self._on_thought = on_thought
        self.finish_reason: str | None = None
        self.usage: dict[str, Any] = {}
        self.error: str | None = None
        self.block_reason: str | None = None
        self.events = 0
        self.malformed_events = 0
        self.bytes_seen = 0

    def feed_bytes(self, chunk: bytes) -> None:
        self.bytes_seen += len(chunk)
        for data in self._sse.feed(chunk):
            self._event(data)

    def feed_payload(self, payload: Any) -> None:
        self._payload(payload)

    def _event(self, data: str) -> None:
        if data.strip() in ("", "[DONE]"):
            return
        try:
            payload = json.loads(data)
        except ValueError:
            self.malformed_events += 1
            return
        self._payload(payload)

    def _payload(self, payload: Any) -> None:
        self.events += 1
        # A streamed chunk is one response; a non-streaming answer read as
        # SSE-less JSON can also arrive as a list of them.
        for one in payload if isinstance(payload, list) else [payload]:
            parts = read_payload(one)
            if parts.error:
                self.error = parts.error
            if parts.block_reason:
                self.block_reason = parts.block_reason
            if parts.usage:
                self.usage = parts.usage  # each chunk carries the running total
            if parts.finish_reason:
                self.finish_reason = parts.finish_reason
            for text in parts.thoughts:
                if self._on_thought is not None:
                    self._on_thought(text)
            for text in parts.answer:
                self._scanner.feed(text)

    def close(self) -> StreamOutcome:
        for data in self._sse.close():
            self._event(data)
        return StreamOutcome(
            text=self._scanner.text, value=self._scanner.value(), complete=self._scanner.complete,
            finish_reason=self.finish_reason, usage=dict(self.usage), error=self.error,
            block_reason=self.block_reason, events=self.events, malformed_events=self.malformed_events)
