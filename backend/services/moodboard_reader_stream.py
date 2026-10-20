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
from dataclasses import dataclass, field
from typing import Any, Callable

REASON_LIMIT = 120

# "Image B", "images A and C", "Image B and #18", "ref D's", "#18", "# 18",
# and ranges: "images A–C", "B-D", "Image A to C", "#3 through #5".
# The noun is matched in any case, the label only as a capital A to F, so
# "image a bit" stays.
_LABEL_UNIT = r"(?:\b(?i:images?|imgs?|pictures?|photos?|references?|refs?)\s+[A-F]\b|#\s?\d+\b)"
_LABEL_JOIN = r"(?:,|/|&|-|–|—|\b(?i:and|or|to|through|thru)\b)"
_LABEL_TOKEN = re.compile(
    _LABEL_UNIT + r"(?:\s*" + _LABEL_JOIN + r"\s*(?:" + _LABEL_UNIT + r"|[A-F]\b))*"
    r"(?:['’]s\b)?"
)
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


def clean_model_text(text: Any) -> str:
    """Model-written text with every batch label and ``#n`` token taken out,
    and the punctuation they leave behind tidied."""
    if not isinstance(text, str):
        return ""
    cleaned = _BRACKET_LABELS.sub(" ", _LABEL_TOKEN.sub(" ", text))
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
    return bool(_LABEL_TOKEN.search(text) or _BRACKET_LABELS.search(text))


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
