"""Streaming parser for `hermes chat` verbose-mode (non-`-Q`) stdout.

Verbose mode prints:

    <banner block — ~50 lines of ASCII logo, tool list, skill list, session id>
    Query: <the user's prompt>
    Initializing agent...
    ─────────────────────────

    ╭─ ⚕ Hermes ──────────────────────╮
         Plan: <pre-tool narration text, possibly multi-line>
    ╰──────────────────────────────────╯
      ┊ 💻 preparing terminal…
      ┊ 💻 $ <command>  <elapsed>

    ╭─ ⚕ Hermes ──────────────────────╮
         <post-tool narration / final response>
    ╰──────────────────────────────────╯

    Resume this session with:
      hermes --resume <session_id>

    Session: <session_id>
    Duration: <human-readable>
    Messages: <count>

We turn prose-box content into `thinking` events for live streaming, skip tool
preview lines (Path C already surfaces nebula-canvas actions via HTTP taps),
and extract the session_id from the footer.

Only the LAST prose box's content becomes the turn's "final response" — earlier
prose boxes are mid-turn narration and live only in the thinking stream.
"""
from __future__ import annotations

import re
from dataclasses import dataclass, field

# ANSI CSI escape sequences (colors, cursor moves, etc.).
_ANSI_RE = re.compile(r"\x1b\[[0-9;?]*[a-zA-Z]")
# Less-common ANSI forms: OSC, single-char CSI shortcuts.
_ANSI_OSC_RE = re.compile(r"\x1b\][^\x07]*\x07")

# Unicode characters used in hermes's box drawing.
#
# Hermes's verbose-mode prose box has two render forms:
#
#   1. TTY (corner-style):
#        ╭─ ⚕ Hermes ──────────────────────╮
#        │     Plan: I'm going to ...      │
#        ╰──────────────────────────────────╯
#
#   2. Non-TTY (rule-only — emitted when stdout is a pipe):
#         ─  ⚕ Hermes  ─────────────────────
#             Plan: I'm going to ...
#         ──────────────────────────────────
#
# Form 1 is detectable via the corner glyphs alone. Form 2 has no corners,
# so we identify open by the "⚕ Hermes" header text and close by a line
# made entirely of horizontal-rule characters (whitespace-trimmed). Both
# forms coexist in the wild — Hermes picks based on isatty() at startup.
_BOX_OPEN_CHAR = "╭"
_BOX_CLOSE_CHAR = "╰"
_BOX_HEADER_TEXT = "⚕ Hermes"
_HORIZONTAL_RULE_CHARS = "─━═-"
_BOX_VERTICAL_CHARS = "│┃"
# Hermes tool-preview lines start with one of these icons after their indent.
# Examples seen in practice: "┊ 💻 $ nebula ...", "├ 🔲 preparing terminal",
# "┊ 📚 skills list all 0.0s".
_TOOL_PREVIEW_PREFIX_RE = re.compile(r"^\s*[┊├│╵]\s")

# Lines to treat as banner/footer delimiters.
_BANNER_END_MARKER = "Query:"
_FOOTER_START_MARKER = "Resume this session with:"
_SESSION_LINE_RE = re.compile(r"^\s*Session:\s*(\S+)\s*$")


def strip_ansi(line: str) -> str:
    """Remove ANSI CSI and OSC escape sequences from a line."""
    return _ANSI_OSC_RE.sub("", _ANSI_RE.sub("", line))


def strip_box_chrome(line: str) -> str:
    """Remove leading/trailing box-drawing characters and their adjacent padding
    from a prose-box line so the prose content comes out clean.

    Hermes emits inside-box content roughly as:
        ``"│     Plan: I'm going to...                             │"``
    (with ANSI colour around the bars). After `strip_ansi` the bars remain.
    This trims them and the padding so we emit just the prose.
    """
    # Trim trailing whitespace first so trailing box-verticals are reachable.
    s = line.rstrip()
    # Trim leading/trailing box-verticals, then trim padding.
    while s and s[0] in _BOX_VERTICAL_CHARS:
        s = s[1:]
    while s and s[-1] in _BOX_VERTICAL_CHARS:
        s = s[:-1]
    return s.strip()


def _is_box_open(line: str) -> bool:
    # TTY form has the corner glyph; non-TTY form just carries the header text.
    return _BOX_OPEN_CHAR in line or _BOX_HEADER_TEXT in line


def _is_box_close(line: str) -> bool:
    if _BOX_CLOSE_CHAR in line:
        return True
    # Non-TTY form: a line made entirely of horizontal-rule chars (and
    # whitespace) acts as the close. Only consulted from the in_box state,
    # so banner separators and inter-box rules don't cause false closes.
    # Min length 4 keeps stray "---" markers in prose from triggering.
    stripped = line.strip()
    if len(stripped) < 4:
        return False
    return all(ch in _HORIZONTAL_RULE_CHARS for ch in stripped)


def _is_tool_preview(line: str) -> bool:
    return bool(_TOOL_PREVIEW_PREFIX_RE.match(line))


@dataclass
class ParseEvent:
    """One emission from the parser — either a `thinking` line or a session id.

    `kind` is one of:
      - "thinking"  : prose text to stream to the user (already stripped clean)
      - "session"   : session_id recovered from the footer
    """

    kind: str
    text: str = ""


@dataclass
class HermesVerboseParser:
    """Line-by-line streaming parser for hermes verbose stdout.

    Usage:
        parser = HermesVerboseParser()
        for event in parser.feed(line):
            ...handle...
        # At stream end, parser.final_box_lines is the last prose box's lines.

    State machine:
        banner   → (on "Query:") pre_content
        pre_content → (on "╭") in_box
        in_box   → (on "╰") content
                 → (prose line) emit thinking
        content  → (on "╭") in_box
                 → (on "Resume this session with:") footer
        footer   → (on "Session: <id>") emit session, stay in footer
    """

    state: str = "banner"
    # Accumulated lines of the currently-open prose box (if any).
    _current_box_lines: list[str] = field(default_factory=list)
    # Lines from the most recently CLOSED prose box — treated as the turn's
    # final response text. Updated on each box close, so the last-closed box
    # wins by the time the stream ends.
    final_box_lines: list[str] = field(default_factory=list)
    # Set once the footer's `Session: <id>` line is seen.
    session_id: str | None = None

    def feed(self, raw_line: str) -> list[ParseEvent]:
        """Consume one line of stdout. Returns zero or more events to emit.

        `raw_line` may contain ANSI escapes and box-drawing chars; this method
        strips them. The line should NOT include a trailing newline.
        """
        line = strip_ansi(raw_line)
        out: list[ParseEvent] = []

        if self.state == "banner":
            # Skip everything until the user's query echoes — that's the
            # reliable marker that the banner has ended.
            if line.lstrip().startswith(_BANNER_END_MARKER):
                self.state = "pre_content"
            return out

        if self.state == "pre_content":
            # Between the query echo and the first Hermes box: skip the
            # "Initializing agent..." spinner and the separator. Transition to
            # `in_box` as soon as we see a box open, OR straight to `footer`
            # if the turn produced no boxes (defensive — malformed or empty
            # turn).
            if _is_box_open(line):
                self.state = "in_box"
                self._current_box_lines = []
            elif line.lstrip().startswith(_FOOTER_START_MARKER):
                self.state = "footer"
            return out

        if self.state == "in_box":
            if _is_box_close(line):
                # Box closed. Save its lines as the (possibly) final prose box.
                # Empty boxes (spinner placeholders) don't overwrite a prior
                # real box — only non-empty closes become the "final response".
                if self._current_box_lines:
                    self.final_box_lines = list(self._current_box_lines)
                self._current_box_lines = []
                self.state = "content"
                return out
            # Strip box chrome and emit non-empty prose lines.
            prose = strip_box_chrome(line)
            if prose:
                self._current_box_lines.append(prose)
                out.append(ParseEvent(kind="thinking", text=prose))
            return out

        if self.state == "content":
            # Between boxes: tool previews and whitespace.
            if _is_box_open(line):
                self.state = "in_box"
                self._current_box_lines = []
                return out
            if line.lstrip().startswith(_FOOTER_START_MARKER):
                self.state = "footer"
                return out
            # Tool preview lines would be emitted here too, but Path C already
            # surfaces nebula-canvas mutations with cleaner prose. Drop them.
            if _is_tool_preview(line):
                return out
            # Anything else between boxes is whitespace / ignored.
            return out

        if self.state == "footer":
            m = _SESSION_LINE_RE.match(line)
            if m:
                self.session_id = m.group(1)
                out.append(ParseEvent(kind="session", text=m.group(1)))
            # Footer is the last section — stay here and swallow the rest.
            return out

        return out

    def finalize(self) -> None:
        """Call once the stream ends. Ensures any in-flight box content is
        promoted into `final_box_lines` if the footer was reached before a
        `╰` (defensive — well-formed streams should always see box close)."""
        if self._current_box_lines:
            self.final_box_lines = list(self._current_box_lines)
            self._current_box_lines = []
