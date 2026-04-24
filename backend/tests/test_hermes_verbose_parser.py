"""Unit tests for HermesVerboseParser — the line-by-line state machine that
turns verbose-mode hermes stdout into thinking events + session id + final
prose-box content."""
from __future__ import annotations

import sys
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent.parent))

from services.hermes_verbose_parser import HermesVerboseParser, strip_ansi


# ---------- Fixture builder ----------

BOX_TOP = "╭──── ⚕ Hermes ────────────────────────────╮"
BOX_BOT = "╰──────────────────────────────────────────╯"
SEP = "─" * 40


def _verbose_stream(
    *,
    query: str,
    prose_boxes: list[list[str]],
    session_id: str = "20260424_120000_abcdef",
    tool_previews: list[list[str]] | None = None,
) -> list[str]:
    """Build a synthetic verbose-mode stdout line list.

    - `prose_boxes`: a list of prose-box contents (each item is a list of lines).
    - `tool_previews`: optional, one per gap between prose boxes; a list of
      tool-preview lines (already pre-formatted with the ┊ / ├ prefix).

    Banner is represented as a few inert lines that don't match the Query:
    terminator — the parser skips them.
    """
    tool_previews = tool_previews or []
    lines: list[str] = [
        # Banner chrome (parser skips until it sees "Query:")
        "╭─ banner ─╮",
        "│ Hermes Agent v0.10.0 │",
        "│ 28 tools · 73 skills │",
        "╰──────────╯",
        f"Query: {query}",
        "Initializing agent...",
        SEP,
        "",
    ]
    for i, box_lines in enumerate(prose_boxes):
        lines.append(BOX_TOP)
        # Hermes inserts box-vertical chars; we include them so the parser
        # exercises its chrome-strip logic.
        for bl in box_lines:
            lines.append(f"│    {bl}    │")
        lines.append(BOX_BOT)
        # Tool preview block (if any) between this box and the next.
        if i < len(tool_previews):
            for tl in tool_previews[i]:
                lines.append(tl)
        lines.append("")
    lines.extend([
        "Resume this session with:",
        f"  hermes --resume {session_id}",
        "",
        f"Session:        {session_id}",
        "Duration:       1m 2s",
        "Messages:       4 (1 user, 2 tool calls)",
    ])
    return lines


def _feed_all(p: HermesVerboseParser, lines: list[str]) -> list[str]:
    """Drive the parser with every line; return all thinking texts emitted."""
    thinking: list[str] = []
    for ln in lines:
        for evt in p.feed(ln):
            if evt.kind == "thinking":
                thinking.append(evt.text)
    p.finalize()
    return thinking


# ---------- Tests ----------


def test_strip_ansi_removes_csi_sequences():
    assert strip_ansi("\x1b[31mred\x1b[0m") == "red"
    assert strip_ansi("plain") == "plain"
    assert strip_ansi("\x1b[1;33;40mcolor\x1b[0m") == "color"


def test_happy_path_single_prose_box():
    """One prose box → one final_box_lines list, thinking events streamed."""
    lines = _verbose_stream(
        query="hi",
        prose_boxes=[["HELLO"]],
        session_id="sid-happy",
    )
    p = HermesVerboseParser()
    thinking = _feed_all(p, lines)

    assert thinking == ["HELLO"]
    assert p.session_id == "sid-happy"
    assert p.final_box_lines == ["HELLO"]


def test_banner_is_skipped_entirely():
    """No thinking events fire before the `Query:` echo."""
    lines = _verbose_stream(
        query="hi",
        prose_boxes=[["R"]],
    )
    p = HermesVerboseParser()
    # The banner contains a box (╭─ banner ─╮ / ╰──╯) — parser must NOT
    # emit its contents as thinking.
    thinking = _feed_all(p, lines)

    assert "Hermes Agent" not in " ".join(thinking)
    assert "28 tools" not in " ".join(thinking)


def test_multi_box_streams_all_narration_but_final_is_last_box_only():
    """Earlier prose boxes stream as thinking; only LAST becomes final text."""
    lines = _verbose_stream(
        query="hi",
        prose_boxes=[
            ["Plan: I'll do A then B.", "Step 1 — doing A."],
            ["Step 2 — B succeeded. Summary: done."],
        ],
        tool_previews=[
            ["  ┊ 💻 preparing terminal…", "  ┊ 💻 $ nebula nodes 0.5s"],
        ],
    )
    p = HermesVerboseParser()
    thinking = _feed_all(p, lines)

    # All prose lines streamed as thinking, in order.
    assert thinking == [
        "Plan: I'll do A then B.",
        "Step 1 — doing A.",
        "Step 2 — B succeeded. Summary: done.",
    ]
    # Only the LAST prose box contributes to final_box_lines.
    assert p.final_box_lines == ["Step 2 — B succeeded. Summary: done."]


def test_tool_preview_lines_are_dropped():
    """Lines like `┊ 💻 $ nebula ...` between boxes don't become thinking."""
    lines = _verbose_stream(
        query="hi",
        prose_boxes=[["A"], ["B"]],
        tool_previews=[[
            "  ┊ 💻 preparing terminal…",
            "  ┊ 💻 $ nebula nodes 0.5s",
            "  ┊ 📚 skills list all 0.0s",
        ]],
    )
    p = HermesVerboseParser()
    thinking = _feed_all(p, lines)

    assert thinking == ["A", "B"]
    assert all("nebula nodes" not in t for t in thinking)
    assert all("preparing terminal" not in t for t in thinking)


def test_empty_prose_box_is_skipped_for_final_text():
    """An empty spinner-placeholder box does NOT overwrite a prior real box."""
    # A box whose lines are all blank after chrome-strip — simulates a
    # spinner placeholder that hermes sometimes emits.
    p = HermesVerboseParser()
    # Feed: banner, query, prose box with real content, then empty box, footer.
    script = [
        f"Query: go",
        BOX_TOP,
        "│    Final answer is 42.    │",
        BOX_BOT,
        "",
        BOX_TOP,
        "│                           │",  # whitespace-only content line
        BOX_BOT,
        "Resume this session with:",
        "Session: sid-empty",
    ]
    _feed_all(p, script)
    assert p.final_box_lines == ["Final answer is 42."]
    assert p.session_id == "sid-empty"


def test_session_id_from_footer():
    lines = _verbose_stream(
        query="hi",
        prose_boxes=[["ok"]],
        session_id="20260424_123456_xyz",
    )
    p = HermesVerboseParser()
    _feed_all(p, lines)
    assert p.session_id == "20260424_123456_xyz"


def test_ansi_escapes_are_stripped_from_streamed_thinking():
    """If hermes colours a prose line, we emit it clean."""
    p = HermesVerboseParser()
    script = [
        "Query: q",
        BOX_TOP,
        "│    \x1b[1;33mColored plan text\x1b[0m    │",
        BOX_BOT,
        "Resume this session with:",
        "Session: sid-ansi",
    ]
    thinking = _feed_all(p, script)
    assert thinking == ["Colored plan text"]


def test_no_boxes_at_all_produces_empty_final():
    """Malformed stream (query but no prose box) → empty final, no crash."""
    p = HermesVerboseParser()
    _feed_all(p, [
        "Query: q",
        "",
        "Resume this session with:",
        "Session: sid-empty2",
    ])
    assert p.final_box_lines == []
    assert p.session_id == "sid-empty2"


def test_feed_before_query_yields_nothing():
    """Pre-query banner content can't leak into thinking events."""
    p = HermesVerboseParser()
    emitted = []
    # Feed a bunch of banner-ish lines, verify no thinking events fire.
    for ln in [BOX_TOP, "│ Hermes Agent │", BOX_BOT, "some banner text"]:
        for evt in p.feed(ln):
            emitted.append(evt)
    assert emitted == []
