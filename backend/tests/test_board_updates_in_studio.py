"""A board's own Updates show in Moodboard Studio (Justin's Q113 c, 2026-10-21).

"c) Two sections in one list: "This board" first, then the project. One chip
with one count (both added), opening it reads both, and an empty board
section is hidden."

Before this, an Update posted with `board` was kept with the board but shown
on no screen, and the agent-facing words said so ("not on screen yet": post
without `board` to reach the person). Now the person sees a board's Updates
in Moodboard Studio's corner, under "This board", while they have that board
open; every other screen still shows only the open project's list. The words
agents read say exactly that, and no longer say "not on screen yet".
"""
from __future__ import annotations

from pathlib import Path

REPO = Path(__file__).resolve().parents[2]
OLD = "not on screen yet"


def _flat(text: str | None) -> str:
    return " ".join((text or "").split())


def test_post_note_says_where_a_boards_update_shows():
    import mcp_server

    doc = _flat(mcp_server.post_note.__doc__)
    assert OLD not in doc
    assert "Moodboard Studio" in doc and '"This board"' in doc
    assert "has that board open" in doc
    # Elsewhere the corner shows only the project's list: say how to reach them anywhere.
    assert "without `board`" in doc


def test_list_notes_says_where_a_boards_update_shows():
    import mcp_server

    doc = _flat(mcp_server.list_notes.__doc__)
    assert OLD not in doc
    assert "Moodboard Studio" in doc and '"This board"' in doc


def test_mcp_setup_skill_and_cli_say_the_same():
    setup = _flat((REPO / "docs/MCP-SETUP.md").read_text(encoding="utf-8"))
    skill = _flat((REPO / "skills/nebula/SKILL.md").read_text(encoding="utf-8"))
    cli = _flat((REPO / "backend/cli/__main__.py").read_text(encoding="utf-8"))
    for name, text in (("MCP-SETUP", setup), ("SKILL", skill), ("cli", cli)):
        assert OLD not in text, name
        assert "Moodboard Studio" in text and "This board" in text, name
    # The tool list and the Updates section both say it.
    assert setup.count('under "This board"') >= 2


def test_the_first_turn_instructions_are_unchanged_and_under_the_cap():
    """No new tool and no new first-turn words: INSTRUCTIONS stay as they were."""
    import mcp_server

    assert len(mcp_server.INSTRUCTIONS) <= 3000
    assert OLD not in mcp_server.INSTRUCTIONS


def test_the_plan_records_q113():
    plan = (REPO / "docs/moodboard-canvas-plan.md").read_text(encoding="utf-8")
    assert "Q113 c" in plan and "This board" in plan


def test_nebula_note_with_a_board_says_where_the_person_reads_it():
    """`nebula note --board` confirms with where the person sees it: Moodboard
    Studio on that board, not "the top right" of any screen."""
    import argparse
    import io

    from cli.commands import notes as notes_cmd

    class Client:
        def board_id(self, name):
            return "b1"

        def post_note(self, body, board_id=None, agent_name=None):
            return {"note": {"id": "an_1", "text": body["text"]}, "dropped": [], "unread": 1}

    out = io.StringIO()
    args = argparse.Namespace(text="#2 is heavy", board="Dusk", refs=["2"], nodes=[], since_last_turn=False,
                              agent_name="Codex", json=False)
    assert notes_cmd.run_note(Client(), args, out=out) == 0
    printed = out.getvalue()
    assert "Moodboard Studio" in printed and "This board" in printed, printed
    out = io.StringIO()
    canvas = argparse.Namespace(text="Two seeds", board=None, refs=[], nodes=[], since_last_turn=False,
                                agent_name="Codex", json=False)
    assert notes_cmd.run_note(Client(), canvas, out=out) == 0
    assert "top right" in out.getvalue()
