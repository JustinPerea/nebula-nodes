"""`nebula apply`: edit the canvas directly, all of it or none of it.

The CLI twin of the MCP server's edit_canvas (POST /api/graph/apply). The
plan is the one `nebula propose` takes, minus `run`, plus rename, move,
remove, unwire and arrange (cli/plan.py). Nothing runs; `nebula run` does
that after.

A plan of steps ({"steps": [plan, ...]}) is sent one step at a time. Each
step is a normal edit that lands whole or not at all, and later steps use
the node ids earlier steps returned for their +refs. If a step is refused,
the command stops there, says which step and why, and lists what the
earlier steps applied, with the ids their +refs became, so the agent
can fix the refused step and send the rest on their own.
"""
from __future__ import annotations

import argparse
import json
import sys
from typing import Any, TextIO

from nebula_api import NebulaAPIError

from ..client import NebulaClient
from ..formatter import format_applied, format_step_stop
from ..plan import BuildError, body_from_args, resolve_step


def run_apply(client: NebulaClient, args: argparse.Namespace, *, out: TextIO | None = None) -> int:
    out = out or sys.stdout
    try:
        body = body_from_args(args, command="apply")
    except BuildError as exc:
        print(f"error: {exc}", file=sys.stderr)
        return 1
    if "steps" in body:
        return _run_steps(client, body["steps"], args, out)
    result = client.apply(body, agent_name=args.agent_name)
    if args.json:
        print(json.dumps(result, ensure_ascii=False, indent=2), file=out)
    else:
        print(format_applied(result), file=out)
    return 0


def _run_steps(client: NebulaClient, steps: list[dict[str, Any]], args: argparse.Namespace, out: TextIO) -> int:
    id_map: dict[str, str] = {}
    applied: list[dict[str, Any]] = []
    total = len(steps)
    for number, step in enumerate(steps, start=1):
        try:
            result = client.apply_step(resolve_step(step, id_map), agent_name=args.agent_name)
        except NebulaAPIError as exc:
            if exc.kind == "connect":
                reason = f"cannot connect to Nebula backend at {client.base_url}"
            elif exc.kind == "timeout":
                reason = "Nebula didn't answer in time; `nebula graph` shows whether it landed"
            else:
                reason = exc.detail
            if args.json:
                print(json.dumps({"status": "stopped", "failedStep": number, "steps": total, "error": reason,
                                  "applied": applied, "idMap": id_map}, ensure_ascii=False, indent=2), file=out)
            print(format_step_stop(number, total, reason, applied), file=sys.stderr)
            return 1
        applied.append(result)
        id_map.update(result.get("idMap") or {})
        if not args.json:
            print(f"Step {number} of {total}. {format_applied(result)}", file=out)
    if args.json:
        print(json.dumps({"status": "applied", "steps": applied, "idMap": id_map}, ensure_ascii=False, indent=2),
              file=out)
    return 0
