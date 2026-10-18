"""`nebula apply`: edit the canvas directly, all of it or none of it.

The CLI twin of the MCP server's edit_canvas (POST /api/graph/apply). The
plan is the one `nebula propose` takes, minus `run`, plus rename, move,
remove and unwire (cli/plan.py). Nothing runs; `nebula run` does that after.
"""
from __future__ import annotations

import argparse
import json
import sys
from typing import TextIO

from ..client import NebulaClient
from ..formatter import format_applied
from ..plan import BuildError, body_from_args


def run_apply(client: NebulaClient, args: argparse.Namespace, *, out: TextIO | None = None) -> int:
    out = out or sys.stdout
    try:
        body = body_from_args(args, command="apply")
    except BuildError as exc:
        print(f"error: {exc}", file=sys.stderr)
        return 1
    result = client.apply(body, agent_name=args.agent_name)
    if args.json:
        print(json.dumps(result, ensure_ascii=False, indent=2), file=out)
    else:
        print(format_applied(result), file=out)
    return 0
