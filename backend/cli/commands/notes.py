"""`nebula note` and `nebula notes`: Updates, from the terminal.

What an agent noticed, a report or a suggestion goes in an update, which the
person reads in the Updates list in the top right of Nebula. The cursor's
`say` (`nebula point --say`) is for the agent's own action only. On screen
they are "Updates"; the commands keep the code name (plan section 10.6).
"""
from __future__ import annotations

import argparse
import json
import sys
from datetime import datetime
from typing import Any, TextIO

from ..client import NebulaClient

MAX_TEXT = 240

_ABOUT_LABELS = {
    "sinceLastTurn": "since its last turn",
    "analyze": "Analyze · run done",
    "suggestion": "Analyze",
    "removedLook": "Restore",
    "changedWords": "Restore",
    "proposal": "waiting for your OK",
}


def _clock(at: Any) -> str:
    try:
        moment = datetime.fromisoformat(str(at)).astimezone()
    except ValueError:
        return "--:--"
    if moment.date() == datetime.now().astimezone().date():
        return moment.strftime("%H:%M")
    return moment.strftime("%b %d, %H:%M").replace(" 0", " ")


def format_note(note: dict[str, Any]) -> str:
    """`12:14  Codex · since its last turn  You moved n2 (n2, n4)`."""
    author = (note.get("author") or {}).get("name") or "Agent"
    # A resolved proposal's Update waits for nothing any more.
    label = None if note.get("resolvedAt") else _ABOUT_LABELS.get(str(note.get("about") or ""))
    who = f"{author} · {label}" if label else author
    state = ""
    if note.get("outcome"):
        # An asset proposal's Update once the proposal closed (Q92 a): how it ended.
        state = f" [{note['outcome']}]"
    elif note.get("dismissedAt"):
        state = " [dismissed]"
    elif not note.get("readAt"):
        state = " [unread]"
    refs = note.get("refs") or []
    on = f"  ({', '.join(str(ref) for ref in refs)})" if refs else ""
    return f"{_clock(note.get('at'))}  {who}{state}  {note.get('text', '')}{on}"


def run_note(client: NebulaClient, args: argparse.Namespace, *, out: TextIO | None = None) -> int:
    out = out or sys.stdout
    text = " ".join((args.text or "").split())
    if not text:
        print("error: an update needs a line of text", file=sys.stderr)
        return 1
    if len(text) > MAX_TEXT:
        print(f"error: keep an update to {MAX_TEXT} characters (it is {len(text)})", file=sys.stderr)
        return 1
    if args.refs and not args.board:
        print("error: --ref names a board's images (with --board); use --node for nodes on the canvas",
              file=sys.stderr)
        return 1
    if args.nodes and args.board:
        print("error: --node names nodes on the canvas; on a board use --ref with image numbers or ids",
              file=sys.stderr)
        return 1
    body: dict[str, Any] = {"text": text}
    refs = list(args.refs or []) if args.board else list(args.nodes or [])
    if refs:
        body["refs"] = refs
    if args.since_last_turn:
        body["about"] = "sinceLastTurn"
    board_id = client.board_id(args.board) if args.board else None
    result = client.post_note(body, board_id=board_id, agent_name=args.agent_name)
    if getattr(args, "json", False):
        print(json.dumps(result, indent=2, ensure_ascii=False), file=out)
        return 0
    note = result.get("note") or {}
    # A board's Updates show in Moodboard Studio on that board (Q113 c), the
    # project's in the top right of every screen.
    where = ("this board's Updates (the person reads it in Moodboard Studio on that board, under This board)"
             if board_id else "the canvas's Updates (the person reads it in the top right)")
    print(f"Posted to {where}: {note.get('text', text)}", file=out)
    dropped = result.get("dropped") or []
    if dropped:
        print(f"Not on {'the board' if board_id else 'the canvas'}, left out: {', '.join(map(str, dropped))}",
              file=out)
    return 0


def run_notes(client: NebulaClient, args: argparse.Namespace, *, out: TextIO | None = None) -> int:
    out = out or sys.stdout
    board_id = client.board_id(args.board) if args.board else None
    listing = client.list_notes(board_id=board_id, unread=args.unread)
    if args.json:
        print(json.dumps(listing, indent=2, ensure_ascii=False), file=out)
        return 0
    notes = listing.get("notes") or []
    kept = "this board" if board_id else "this project"
    if not notes:
        print(f"No {'unread ' if args.unread else ''}updates (kept with {kept}).", file=out)
        return 0
    print(f"UPDATES ({listing.get('unread', 0)} unread, kept with {kept}), newest first:", file=out)
    for note in notes:
        print(f"  {format_note(note)}", file=out)
    return 0
