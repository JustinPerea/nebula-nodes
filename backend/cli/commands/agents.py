"""`nebula status "<text>" [--node nX]`, `nebula status --clear`, `nebula agents`.

The Agents panel (Q125 item 2): an agent says what it is working on, and
reads who else is around. The MCP twins are set_status and list_agents; the
person's panel (the top of Updates) reads the same roster. Counts only:
nobody reads another agent's questions, answers or proposals here.

A bare `nebula status`, with no text, still prints the canvas's run state
(execute.run_status), as it did before statuses existed.
"""
from __future__ import annotations

import argparse
import json
import sys
from typing import Any, TextIO

from ..client import NebulaClient
from ..formatter import format_agents


def wants_status_line(args: argparse.Namespace) -> bool:
    """Whether `nebula status` is about the agent's line (text, --clear or --node),
    not the canvas's run state."""
    return args.text is not None or bool(args.clear) or args.node is not None


def run_status(client: NebulaClient, args: argparse.Namespace, *, out: TextIO | None = None) -> int:
    out = out or sys.stdout
    if args.clear and args.text is not None:
        print('error: give a line or --clear, not both: nebula status "<text>" [--node nX], or nebula status --clear',
              file=sys.stderr)
        return 2
    if args.text is None and not args.clear:
        print('error: --node goes with a line: nebula status "<text>" --node nX', file=sys.stderr)
        return 2
    body: dict[str, Any] = {"text": "" if args.clear else args.text}
    if args.node and not args.clear:
        body["nodeId"] = args.node
    response = client.set_status(body, agent_name=args.agent_name)
    if args.json:
        print(json.dumps(response, ensure_ascii=False, indent=2), file=out)
        return 0
    status = response.get("status")
    if status is None:
        print("Cleared your status.", file=out)
        return 0
    where = f" (on {status['nodeId']})" if status.get("nodeId") else ""
    print(f"Your status: {status.get('text')}{where}", file=out)
    print("It lasts until you change or clear it (nebula status --clear), or after 10 minutes with no call "
          "to Nebula.", file=out)
    return 0


def run_agents(client: NebulaClient, args: argparse.Namespace, *, out: TextIO | None = None) -> int:
    out = out or sys.stdout
    roster = client.get_agents()
    if args.json:
        print(json.dumps(roster, ensure_ascii=False, indent=2), file=out)
    else:
        print(format_agents(roster), file=out)
    return 0
