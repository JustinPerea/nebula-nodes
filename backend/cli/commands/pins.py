from __future__ import annotations

import argparse
import sys
from typing import TextIO

from ..client import NebulaClient
from ..formatter import format_pin

MAX_REPLY = 280


def run_list(client: NebulaClient, *, out: TextIO | None = None) -> int:
    """`nebula pins`: the person's open notes for agents (resolved ones after)."""
    out = out or sys.stdout
    listing = client.list_pins()
    pins = listing.get("pins") or []
    open_pins = [pin for pin in pins if pin.get("status") == "open"]
    if not pins:
        print("No notes on this canvas.", file=out)
        return 0
    print(f"PINS ({len(open_pins)} open) — notes from the person:", file=out)
    for pin in pins:
        print(f"  {format_pin(pin)}", file=out)
    if open_pins:
        print(f'Answer one: nebula pin resolve {open_pins[0]["id"]} --say "..."', file=out)
    return 0


def run_resolve(
    client: NebulaClient,
    pin_id: str,
    *,
    say: str,
    agent_name: str | None = None,
    out: TextIO | None = None,
) -> int:
    out = out or sys.stdout
    reply = " ".join((say or "").split())
    if not reply:
        print("error: --say needs a one-line reply", file=sys.stderr)
        return 1
    if len(reply) > MAX_REPLY:
        print(f"error: keep the reply to {MAX_REPLY} characters (it is {len(reply)})", file=sys.stderr)
        return 1
    result = client.resolve_pin(pin_id, reply, agent_name=agent_name)
    pin = result.get("pin") or {}
    print(f"Resolved {pin.get('id', pin_id)}: {format_pin(pin)}", file=out)
    return 0


def run_pin(client: NebulaClient, args: argparse.Namespace) -> int:
    if args.pin_cmd == "resolve":
        return run_resolve(client, args.pin_id, say=args.say, agent_name=args.agent_name)
    print(f"error: unknown pin command {args.pin_cmd}", file=sys.stderr)
    return 1
