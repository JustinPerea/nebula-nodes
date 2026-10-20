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
from services.canvas_proposals import READY_NODES_CLI, readiness_warning

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


def _report(view: dict[str, Any], timed_out: bool, timeout: float, *, as_json: bool, out: TextIO,
            warning: str | None = None) -> int:
    if as_json:
        # `propose --json --wait` prints only this: it keeps the readiness
        # warning, so the agent learns why an accepted run failed.
        print(json.dumps({"proposal": view, "timedOut": timed_out, **({"warning": warning} if warning else {})},
                         ensure_ascii=False), file=out)
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
    view = response.get("proposal") or {}
    warning = response.get("warning")
    if warning:
        # The backend names its HTTP route; a CLI user finds nodes with `nebula context`.
        warning = readiness_warning(view.get("cost") or {}, lister=READY_NODES_CLI) or warning
    if args.json and not args.wait:
        print(json.dumps({"proposal": view, **({"warning": warning} if warning else {})},
                         ensure_ascii=False, indent=2), file=out)
        return 0
    if not args.json:
        print(format_proposal(view, created=True), file=out, flush=True)
        if warning:
            print(f"warning: {warning}", file=out, flush=True)
    if not args.wait:
        return 0
    view, timed_out = wait_for_decision(client, view, timeout=args.timeout,
                                        agent_name=args.agent_name, clock=clock)
    return _report(view, timed_out, args.timeout, as_json=args.json, out=out, warning=warning)


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
