"""`nebula propose`, `nebula proposal <id>`, `nebula proposals`.

Agents propose; only the person accepts or rejects, on the canvas. There is
deliberately no accept or reject command here.
"""
from __future__ import annotations

import argparse
import json
import sys
import time
from pathlib import Path
from typing import Any, Callable, TextIO

import httpx

from ..client import NebulaClient
from ..formatter import format_proposal, format_proposal_outcome

POLL_SECONDS = 25.0

# Exit codes for --wait.
EXIT_ACCEPTED = 0
EXIT_TIMEOUT = 2
EXIT_REJECTED = 3
EXIT_CLOSED = 4


class BuildError(ValueError):
    """A builder flag the CLI can't turn into a proposal."""


def _flatten(items: list) -> list[str]:
    out: list[str] = []
    for item in items or []:
        if isinstance(item, list):
            out.extend(item)
        else:
            out.append(item)
    return out


def _endpoint(text: str, flag: str) -> tuple[str, str]:
    """`n4:image` or `+up:image` → ("n4", "image")."""
    node, sep, port = (text or "").partition(":")
    if not sep or not node or not port:
        raise BuildError(f"{flag} needs node:port (e.g. n4:image or +up:image), got '{text}'")
    return node, port


def build_body(
    *,
    note: str | None = None,
    add: list[str] | None = None,
    param: list | None = None,
    set_params: list[str] | None = None,
    wire: list[list[str]] | None = None,
    run: list[str] | None = None,
    at: list[str] | None = None,
) -> dict[str, Any]:
    """Turn builder flags into a proposal body. Values stay strings; the backend coerces them."""
    nodes: dict[str, dict[str, Any]] = {}
    for item in add or []:
        ref, sep, definition_id = item.partition("=")
        if not sep or not ref.startswith("+") or not definition_id:
            raise BuildError(f"--add needs +ref=definitionId (e.g. +up=topaz-image-upscale), got '{item}'")
        if ref in nodes:
            raise BuildError(f"--add uses {ref} twice")
        nodes[ref] = {"ref": ref, "definitionId": definition_id, "params": {}}
    for item in _flatten(param or []):
        target, sep, value = item.partition("=")
        ref, dot, key = target.partition(".")
        if not sep or not dot or not key:
            raise BuildError(f"--param needs +ref.key=value (e.g. +up.upscale_factor=2), got '{item}'")
        if ref not in nodes:
            raise BuildError(f"--param names {ref}, which no --add created")
        nodes[ref]["params"][key] = value
    for item in at or []:
        ref, sep, coords = item.partition("=")
        x, comma, y = coords.partition(",")
        if not sep or not comma or ref not in nodes:
            raise BuildError(f"--at needs +ref=x,y for a node from --add, got '{item}'")
        try:
            nodes[ref]["position"] = {"x": float(x), "y": float(y)}
        except ValueError as exc:
            raise BuildError(f"--at needs numbers, got '{coords}'") from exc

    changes: dict[str, dict[str, Any]] = {}
    for item in set_params or []:
        target, sep, value = item.partition("=")
        node_id, dot, key = target.partition(".")
        if not sep or not dot or not key or node_id.startswith("+"):
            raise BuildError(f"--set needs nX.key=value for an existing node (e.g. n4.prompt=warmer), got '{item}'")
        changes.setdefault(node_id, {})[key] = value

    edges = []
    for pair in wire or []:
        if len(pair) != 2:
            raise BuildError("--wire takes two arguments: SRC:port DST:port")
        source, source_handle = _endpoint(pair[0], "--wire")
        target, target_handle = _endpoint(pair[1], "--wire")
        edges.append({"source": source, "sourceHandle": source_handle,
                      "target": target, "targetHandle": target_handle})

    body: dict[str, Any] = {"note": note or ""}
    if nodes:
        body["nodes"] = [
            {key: value for key, value in node.items() if key != "params" or value}
            for node in nodes.values()
        ]
    if edges:
        body["edges"] = edges
    if changes:
        body["params"] = [{"nodeId": node_id, "params": params} for node_id, params in changes.items()]
    if run:
        body["run"] = list(run)
    return body


def _body_from_args(args: argparse.Namespace) -> dict[str, Any]:
    builder_used = any([args.add, _flatten(args.param), args.set_params, args.wire, args.run, args.at])
    if args.file:
        if builder_used:
            raise BuildError("use --file or the builder flags, not both")
        try:
            body = json.loads(Path(args.file).read_text(encoding="utf-8"))
        except (OSError, ValueError) as exc:
            raise BuildError(f"can't read {args.file}: {exc}") from exc
        if not isinstance(body, dict):
            raise BuildError(f"{args.file} must hold a JSON object")
        if args.note:
            body["note"] = args.note
        return body
    if not args.note:
        raise BuildError("--note is required: one line telling the person what this does")
    return build_body(note=args.note, add=args.add, param=args.param, set_params=args.set_params,
                      wire=args.wire, run=args.run, at=args.at)


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


def _report(view: dict[str, Any], timed_out: bool, timeout: float, *, as_json: bool, out: TextIO) -> int:
    if as_json:
        print(json.dumps({"proposal": view, "timedOut": timed_out}, ensure_ascii=False), file=out)
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
        body = _body_from_args(args)
    except BuildError as exc:
        print(f"error: {exc}", file=sys.stderr)
        return 1
    view = client.propose(body, agent_name=args.agent_name).get("proposal") or {}
    if args.json and not args.wait:
        print(json.dumps({"proposal": view}, ensure_ascii=False, indent=2), file=out)
        return 0
    if not args.json:
        print(format_proposal(view, created=True), file=out, flush=True)
    if not args.wait:
        return 0
    view, timed_out = wait_for_decision(client, view, timeout=args.timeout,
                                        agent_name=args.agent_name, clock=clock)
    return _report(view, timed_out, args.timeout, as_json=args.json, out=out)


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
