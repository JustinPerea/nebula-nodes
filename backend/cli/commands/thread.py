"""`nebula reply "<text>" [--node nX]`, `nebula thread` and `nebula channel`: the Message box, from the terminal.

The person messages a Claude Code session listening through the Nebula
channel from the canvas's Message box (the thread in the Agent log). The
session answers there: `nebula reply` is MCP reply_to_person, `nebula thread`
is MCP read_thread (services/person_thread.py), `nebula channel` is MCP
channel_status's view of your listeners. Only the person sends messages;
agents only reply. Every connected agent reads the thread, as pins; a
question's text only its asker reads. Replies are paced (5 in a row, then
one every 2 s): past that Nebula says when you can reply again.
"""
from __future__ import annotations

import argparse
import json
import sys
from datetime import datetime
from typing import Any, TextIO

from ..client import NebulaClient

MAX_TEXT = 2000

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
    if len(text) > MAX_TEXT:
        print(f"error: Nebula couldn’t send this reply because it’s {len(text):,} characters and the limit is "
              f"{MAX_TEXT:,}. Shorten it, then run this command again.", file=sys.stderr)
        return 1
    body: dict[str, Any] = {"text": text}
    if args.node:
        body["nodeId"] = args.node
    response = client.reply_to_person(body, agent_name=args.agent_name)
    if args.json:
        print(json.dumps(response, ensure_ascii=False, indent=2), file=out)
        return 0
    where = f" Your cursor went to {args.node}." if args.node else ""
    print(f"Replied in the person’s Message box.{where}", file=out)
    return 0


def run_thread(client: NebulaClient, args: argparse.Namespace, *, out: TextIO | None = None) -> int:
    out = out or sys.stdout
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
