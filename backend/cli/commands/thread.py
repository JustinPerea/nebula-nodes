"""`nebula reply "<text>" [--node nX]`, `nebula thread` and `nebula channel`: the Message box, from the terminal.

The person messages a Claude Code session listening through the Nebula
channel from the canvas's Message box (the thread in the Agent log). The
session answers there: `nebula reply` is MCP reply_to_person, `nebula thread`
is MCP read_thread (services/person_thread.py), `nebula channel` is MCP
channel_status's view of your listeners. Only the person sends messages;
agents only reply, and only with a Settings agent token (J1, Justin
2026-11-04): the CLI reads it from NEBULA_APP_TOKEN_FILE, which the launch
command `nebula mcp connect claude-code --channel` prints sets for the
session, so a reply from Claude's own shell is the listening session's
(J2). Every connected agent reads the thread, as pins; a question's text
only its asker reads. Replies are paced (5 in a row, then one every 2 s):
past that Nebula says when you can reply again.
"""
from __future__ import annotations

import argparse
import json
import sys
from datetime import datetime
from typing import Any, TextIO

from nebula_api import has_token
from services.canvas_pins import shown_text, text_length

from ..client import NebulaClient

MAX_TEXT = 2000
# Review 2 live L3: an unnamed CLI with no token sends no agent marker, so
# Nebula would answer with the person-only line; say how to name yourself.
UNNAMED_THREAD_LINE = ("error: Nebula couldn’t show the thread because this agent has no name. Set NEBULA_AGENT_NAME "
                       "or pass --as with a name, then read the thread again.")
# J1/J2: only a Settings token listens, so with none Nebula can't tell
# whose listeners to show (it used to say "no listener" to a listening
# session's tokenless shell: review 2, live M1).
NO_TOKEN_CHANNEL_LINE = ("This terminal has no agent token, so Nebula can’t tell which listeners are yours. Run this "
                         "command, then start Claude Code as it says.\nnebula mcp connect claude-code --channel\n"
                         "The nebula CLI in that session reads its token file.")


def _named(args: argparse.Namespace) -> bool:
    import os

    return bool(has_token() or getattr(args, "agent_name", None) or os.environ.get("NEBULA_AGENT_NAME"))

_KIND_LABELS = {
    "question": "asked",
    "proposal": "proposed",
    "note": "posted an Update",
    "pinReply": "replied on a note",
    "pin": "pinned a note",
}


def _clock(at: Any) -> str:
    try:
        return datetime.fromtimestamp(float(at) / 1000).strftime("%H:%M")
    except (TypeError, ValueError, OverflowError, OSError):
        return "--:--"


def format_row(row: dict[str, Any]) -> str:
    """`12:14  person [accepted]  Make the sky warmer (n7)`."""
    kind = str(row.get("kind") or "")
    when = _clock(row.get("at"))
    if kind == "message":
        nodes = row.get("nodeIds") or []
        about = f"  ({', '.join(str(n) for n in nodes)})" if nodes else ""
        to = (row.get("toAgent") or {}).get("name")
        who = f"person to {to}" if to else "person"
        return f"{when}  {who} [{row.get('state', 'sent')}]  {row.get('text', '')}{about}"
    if kind == "reply":
        on = f"  ({row['nodeId']})" if row.get("nodeId") else ""
        name = (row.get("agent") or {}).get("name") or "agent"
        return f"{when}  {name}  {row.get('text', '')}{on}"
    name = "person" if kind == "pin" else (row.get("agent") or {}).get("name") or "agent"
    label = f"{name} {_KIND_LABELS.get(kind, kind)}"
    ref = row.get("questionId") or row.get("proposalId") or row.get("noteId") or row.get("pinId") or ""
    text = f"  {row['text']}" if row.get("text") else ""
    return f"{when}  {label} {ref}{text}".rstrip()


def run_reply(client: NebulaClient, args: argparse.Namespace, *, out: TextIO | None = None) -> int:
    out = out or sys.stdout
    text = (args.text or "").strip()
    if not text:
        print("error: Nebula couldn’t send this reply because it has no text. Put the text in quotes, like this.\n"
              'nebula reply "<text>" [--node nX]', file=sys.stderr)
        return 2
    # Counted as Nebula counts it (review 2, parity NIT-3): characters as
    # a person sees them, so an emoji family or an accent is one.
    length = text_length(shown_text(text, multiline=True).strip())
    if length > MAX_TEXT:
        print(f"error: Nebula couldn’t send this reply because it’s {length:,} characters and the limit is "
              f"{MAX_TEXT:,}. Shorten it, then run this command again.", file=sys.stderr)
        return 1
    body: dict[str, Any] = {"text": text}
    if args.node:
        body["nodeId"] = args.node
    response = client.reply_to_person(body, agent_name=args.agent_name)
    if args.json:
        print(json.dumps(response, ensure_ascii=False, indent=2), file=out)
        return 0
    # Round 5c (NIT-1): say what happened. The cursor went only when the
    # saved reply kept its node; a reply that went to another project's
    # thread ignored it, and the server's note says so.
    note = str(response.get("note") or "")
    kept = (response.get("reply") or {}).get("nodeId")
    if args.node and kept:
        where = f" Your cursor went to {kept}."
    elif args.node and note:
        where = f" {note}"
        note = ""
    else:
        where = ""
    print(f"Replied in the person’s Message box.{where}", file=out)
    if note:
        # Round 5 (D2): Nebula saved it but couldn't tell which message it answers.
        print(note, file=sys.stderr)
    return 0


def run_thread(client: NebulaClient, args: argparse.Namespace, *, out: TextIO | None = None) -> int:
    out = out or sys.stdout
    if not _named(args):
        print(UNNAMED_THREAD_LINE, file=sys.stderr)
        return 1
    response = client.get_thread(limit=args.limit, agent_name=args.agent_name)
    if args.json:
        print(json.dumps(response, ensure_ascii=False, indent=2), file=out)
        return 0
    rows = response.get("rows") or []
    if not rows:
        print("No messages in this project’s thread yet.", file=out)
        return 0
    for row in rows:
        print(format_row(row), file=out)
    return 0


def run_channel(client: NebulaClient, args: argparse.Namespace, *, out: TextIO | None = None) -> int:
    """`nebula channel`: your listener entries (GET /api/canvas/channel, your own only)."""
    out = out or sys.stdout
    if not has_token():
        if args.json:
            print(json.dumps({"listeners": None, "token": False}, indent=2), file=out)
        else:
            print(NO_TOKEN_CHANNEL_LINE, file=out)
        return 0
    response = client.get_channel(agent_name=args.agent_name)
    if args.json:
        print(json.dumps(response, ensure_ascii=False, indent=2), file=out)
        return 0
    listeners = response.get("listeners") or []
    if not listeners:
        print("You have no listener, so Nebula doesn’t count you as connected to the canvas. Run this command, "
              "then start Claude Code as it says.\nnebula mcp connect claude-code --channel", file=out)
        return 0
    for entry in listeners:
        state = str(entry.get("state") or "")
        reason = f" · {entry['reason']}" if entry.get("reason") else ""
        print(f"{entry.get('listenerId', '')}  {state}{reason}  since {_clock(entry.get('since'))}  "
              f"last heard {_clock(entry.get('seenAt'))}", file=out)
    return 0
