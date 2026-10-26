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
can fix the refused step and send the rest on their own. The checks and
that rule live in backend/apply_steps.py, shared with MCP edit_canvas.

Every apply that changes something prints its undo: `nebula undo TOKEN`
(MCP undo_canvas_edit) puts the parts nobody changed or ran since back
(a node only you ran since still goes).
"""
from __future__ import annotations

import argparse
import json
import sys
from typing import Any, TextIO

from nebula_api import NebulaAPIError

from ..client import NebulaClient
import apply_steps

from ..formatter import format_applied, format_step_stop, format_undone
from ..plan import BuildError, body_from_args


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
    def progress(number: int, total: int, result: dict[str, Any]) -> None:
        if not args.json:
            print(f"Step {number} of {total}. {format_applied(result, undo=False)}", file=out)

    outcome = apply_steps.run_steps(
        steps, lambda step: client.apply_step(step, agent_name=args.agent_name),
        reason=lambda exc: apply_steps.stop_reason(exc, client.base_url), on_applied=progress)
    if args.json:
        print(json.dumps(outcome.as_json(), ensure_ascii=False, indent=2), file=out)
    if outcome.failed_step is not None:
        print(format_step_stop(outcome.failed_step, outcome.total, outcome.error or "", outcome.applied),
              file=sys.stderr)
        return 1
    if not args.json and outcome.undo_tokens:
        count = len(outcome.undo_tokens)
        what = "this step" if count == 1 else f"these {count} steps"
        print(f"Undo {what}: nebula undo {' '.join(outcome.undo_tokens)}", file=out)
    return 0


def run_undo(client: NebulaClient, args: argparse.Namespace, *, out: TextIO | None = None) -> int:
    """`nebula undo TOKEN...`: undo your own applies (POST /api/graph/apply/undo),
    one token at a time in the order given (newest first for a steps plan),
    stopping at the first one refused."""
    out = out or sys.stdout
    results: list[dict[str, Any]] = []
    total = len(args.tokens)
    for number, token in enumerate(args.tokens, start=1):
        try:
            result = client.undo_edit(token, agent_name=args.agent_name)
        except NebulaAPIError as exc:
            reason = apply_steps.stop_reason(exc, client.base_url)
            if args.json:
                print(json.dumps({"status": "stopped", "failedToken": number, "tokens": total, "error": reason,
                                  "undone": results}, ensure_ascii=False, indent=2), file=out)
            done = ("Nothing was undone." if not results else
                    "Token 1 was undone." if len(results) == 1 else f"Tokens 1-{len(results)} were undone.")
            print(f"error: token {number} of {total} was refused, so it and the tokens after it weren't used: "
                  f"{reason}\n{done}", file=sys.stderr)
            return 1
        results.append(result)
        if not args.json:
            print(format_undone(result), file=out)
    if args.json:
        print(json.dumps(results[0] if total == 1 else {"status": "undone", "undone": results},
                         ensure_ascii=False, indent=2), file=out)
    return 0
