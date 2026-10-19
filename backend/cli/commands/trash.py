"""`nebula trash list|restore`: Recently deleted moodboards, characters and projects.

Anyone may restore, agents included: a restore undoes a delete. Deleting for
good can't be undone, so it is the person's alone and has no CLI command; the
person does it in Nebula (Moodboard Studio, Character Studio or Projects).
"""
from __future__ import annotations

import argparse
import json
import sys
from typing import Any, TextIO

from ..client import NebulaClient

KINDS = ("moodboard", "character", "project")


def _who(item: dict[str, Any]) -> str:
    """Who deleted it, from ``kind`` alone: an agent picks its own name, so a
    name never reads as the person (services/canvas_events.actor_record)."""
    by = item.get("deletedBy")
    if not isinstance(by, dict):
        return "unknown"
    kind = by.get("kind")
    if kind == "person":
        return "you"
    if kind == "agent":
        return f"{by.get('name') or 'Agent'} (agent)"
    if kind == "system":
        return "Nebula"
    return "an unnamed client"


def _when(item: dict[str, Any]) -> str:
    return str(item.get("deletedAt") or "")[:16].replace("T", " ")


def run_list(client: NebulaClient, *, kind: str | None = None, as_json: bool = False,
             out: TextIO | None = None) -> int:
    out = out or sys.stdout
    listing = client.list_trash(kind)
    items = listing.get("items") or []
    if as_json:
        print(json.dumps(listing, indent=2), file=out)
        return 0
    if not items:
        print("Recently deleted is empty.", file=out)
        return 0
    print(f"RECENTLY DELETED ({len(items)}):", file=out)
    for item in items:
        scope = ""
        if item.get("kind") in ("moodboard", "character"):
            scope = f"  [project {item['projectId']}]" if item.get("projectId") else "  [global]"
        expiry = f", removed for good after {str(item['purgeAt'])[:10]}" if item.get("purgeAt") else ""
        print(f"  {item.get('kind', '?'):<9} {item.get('id')}  {item.get('name') or 'Untitled'}{scope}"
              f"  (deleted {_when(item)} by {_who(item)}{expiry})", file=out)
    first = items[0]
    print(f"Restore one: nebula trash restore {first.get('kind')} {first.get('id')}", file=out)
    return 0


def run_restore(client: NebulaClient, target: list[str], *, out: TextIO | None = None) -> int:
    out = out or sys.stdout
    if len(target) == 2:
        kind, item_id = target
        if kind not in KINDS:
            print(f"error: kind must be one of {', '.join(KINDS)}", file=sys.stderr)
            return 1
    elif len(target) == 1:
        item_id = target[0]
        matches = [item for item in client.list_trash().get("items") or [] if item.get("id") == item_id]
        if not matches:
            print(f"error: {item_id} isn't in Recently deleted (`nebula trash list` shows what is)", file=sys.stderr)
            return 1
        kind = str(matches[0].get("kind"))
    else:
        print("error: give the id, optionally after its kind: nebula trash restore [kind] <id>", file=sys.stderr)
        return 1
    result = client.restore_trashed(kind, item_id)
    asset = result.get("asset") or result.get("project") or {}
    name = asset.get("name") or item_id
    print(f"Restored {kind} {item_id} ({name}).", file=out)
    if kind == "project":
        print(f"It is back in the project list, closed. `nebula project open {item_id}` opens it.", file=out)
    else:
        print("Nodes that point at it work again.", file=out)
    return 0


def run(client: NebulaClient, args: argparse.Namespace) -> int:
    if args.trash_cmd == "list":
        return run_list(client, kind=args.kind, as_json=args.json)
    if args.trash_cmd == "restore":
        return run_restore(client, args.target)
    print(f"error: unknown trash command {args.trash_cmd}", file=sys.stderr)
    return 1
