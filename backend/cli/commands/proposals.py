"""`nebula propose`, `nebula proposal <id>`, `nebula proposals`.

Agents propose; only the person accepts or rejects, on the canvas. There is
deliberately no accept or reject command here.
"""
from __future__ import annotations

import argparse
import json
import sys
import time
from typing import Any, Callable, TextIO

import httpx

from ..client import NebulaClient
from ..formatter import format_proposal, format_proposal_outcome
# The plan builder is shared with `nebula apply` (cli/plan.py); re-exported here.
from ..plan import BuildError, body_from_args, build_body  # noqa: F401
from services.canvas_proposals import (READY_NODES_CLI, agent_wording, cli_withdraw_form, readiness_warning,
                                       still_open_reminder)

POLL_SECONDS = 25.0

# Exit codes for --wait.
EXIT_ACCEPTED = 0
EXIT_TIMEOUT = 2
EXIT_REJECTED = 3
EXIT_CLOSED = 4


def wait_for_decision(
    client: NebulaClient,
    proposal: dict[str, Any],
    *,
    timeout: float,
    agent_name: str | None = None,
    clock: Callable[[], float] = time.monotonic,
) -> tuple[dict[str, Any], bool]:
    """Poll until the person decides. Returns (latest view, timed_out)."""
    deadline = clock() + max(0.0, timeout)
    view = proposal
    while view.get("status") == "open":
        remaining = deadline - clock()
        if remaining <= 0:
            return view, True
        try:
            view = client.get_proposal(view["id"], wait=min(POLL_SECONDS, remaining),
                                       agent_name=agent_name).get("proposal") or view
        except httpx.TimeoutException:
            continue
    return view, False


def outcome_code(view: dict[str, Any]) -> int:
    status = view.get("status")
    if status == "accepted":
        return EXIT_ACCEPTED
    if status == "rejected":
        return EXIT_REJECTED
    return EXIT_CLOSED


# The agent lines of a propose answer (agent_wording), in the order JSON prints them.
_AGENT_LINES = ("warning", "withdrawWith", "stillOpen", "reminder")


def _lines_after_wait(client: NebulaClient, lines: dict[str, Any], view: dict[str, Any], *,
                     cost: dict[str, Any], withdraw: str) -> dict[str, Any]:
    """The agent lines `propose --json --wait` prints with the outcome, as they
    stand after the wait. A proposal the person closed has nothing left to
    withdraw (that call would get a 409), so withdrawWith and the warning's
    "withdraw this one first" go; the warning still says why an accepted run
    fails. On a timeout the proposal is still open and its call still right.
    stillOpen was read before a wait that can last minutes, so it keeps only
    the proposals that are still open now."""
    lines = dict(lines)
    if view.get("status") != "open":
        lines.pop("withdrawWith", None)
        if lines.get("warning"):
            lines["warning"] = readiness_warning(cost, lister=READY_NODES_CLI) or lines["warning"]
    if lines.get("stillOpen"):
        open_ids = {p.get("id") for p in client.list_proposals().get("proposals") or [] if isinstance(p, dict)}
        rows = [row for row in lines["stillOpen"] if row.get("id") in open_ids]
        lines.pop("stillOpen")
        lines.pop("reminder", None)
        if rows:
            lines["stillOpen"] = rows
            lines["reminder"] = still_open_reminder(rows, withdraw=withdraw)
    return lines


def _report(view: dict[str, Any], timed_out: bool, timeout: float, *, as_json: bool, out: TextIO,
            lines: dict[str, Any] | None = None) -> int:
    if as_json:
        # `propose --json --wait` prints only this: it keeps the readiness
        # warning, so the agent learns why an accepted run failed.
        print(json.dumps({"proposal": view, "timedOut": timed_out, **(lines or {})}, ensure_ascii=False), file=out)
    elif timed_out:
        print(f"No decision yet after {timeout:g}s. Check again: nebula proposal {view.get('id')} --wait --timeout {timeout:g}", file=out)
    else:
        print(format_proposal_outcome(view), file=out)
    return EXIT_TIMEOUT if timed_out else outcome_code(view)


def run_propose(
    client: NebulaClient,
    args: argparse.Namespace,
    *,
    out: TextIO | None = None,
    clock: Callable[[], float] = time.monotonic,
) -> int:
    out = out or sys.stdout
    try:
        body = body_from_args(args, command="propose")
    except BuildError as exc:
        print(f"error: {exc}", file=sys.stderr)
        return 1
    response = client.propose(body, agent_name=args.agent_name)
    # The backend names its HTTP routes; a CLI user finds nodes with `nebula
    # context` and withdraws with `nebula proposal withdraw` (with --as if it named itself so).
    withdraw = cli_withdraw_form(args.agent_name)
    worded = agent_wording(response if isinstance(response, dict) else {}, lister=READY_NODES_CLI,
                           withdraw=withdraw)
    view = worded.get("proposal") or {}
    cost = view.get("cost") or {}
    lines = {key: worded[key] for key in _AGENT_LINES if worded.get(key)}
    if args.json and not args.wait:
        print(json.dumps({"proposal": view, **lines}, ensure_ascii=False, indent=2), file=out)
        return 0
    if not args.json:
        print(format_proposal(view, created=True), file=out, flush=True)
        if lines.get("warning"):
            print(f"warning: {lines['warning']}", file=out, flush=True)
        if lines.get("reminder"):
            print(f"reminder: {lines['reminder']}", file=out, flush=True)
    if not args.wait:
        return 0
    view, timed_out = wait_for_decision(client, view, timeout=args.timeout,
                                        agent_name=args.agent_name, clock=clock)
    if args.json:
        lines = _lines_after_wait(client, lines, view, cost=cost, withdraw=withdraw)
    return _report(view, timed_out, args.timeout, as_json=args.json, out=out, lines=lines)


def run_proposal(
    client: NebulaClient,
    args: argparse.Namespace,
    *,
    out: TextIO | None = None,
    clock: Callable[[], float] = time.monotonic,
) -> int:
    out = out or sys.stdout
    if args.id_or_action == "withdraw":
        if not args.proposal_id:
            print("error: nebula proposal withdraw <id>", file=sys.stderr)
            return 1
        view = client.withdraw_proposal(args.proposal_id, agent_name=args.agent_name).get("proposal") or {}
        print(f"Withdrew {view.get('id', args.proposal_id)}.", file=out)
        return 0
    if args.proposal_id:
        print(f"error: unknown proposal action '{args.id_or_action}' (try: nebula proposal <id> or nebula proposal withdraw <id>)",
              file=sys.stderr)
        return 1
    view = client.get_proposal(args.id_or_action, agent_name=args.agent_name).get("proposal") or {}
    if not args.wait:
        if args.json:
            print(json.dumps({"proposal": view}, ensure_ascii=False, indent=2), file=out)
        else:
            print(format_proposal(view), file=out)
        return 0
    view, timed_out = wait_for_decision(client, view, timeout=args.timeout,
                                        agent_name=args.agent_name, clock=clock)
    return _report(view, timed_out, args.timeout, as_json=args.json, out=out)


def run_list(client: NebulaClient, *, out: TextIO | None = None) -> int:
    out = out or sys.stdout
    proposals = client.list_proposals().get("proposals") or []
    if not proposals:
        print("No proposals are waiting for the person.", file=out)
        return 0
    print(f"PROPOSALS ({len(proposals)} waiting for the person):", file=out)
    for view in proposals:
        print(format_proposal(view), file=out)
    return 0
