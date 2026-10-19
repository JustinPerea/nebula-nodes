"""`nebula character move`: move a Character between Global and a canvas project.

Characters had no CLI group; this one has only `move` (Justin's call P4,
2026-10-19), shaped like `nebula moodboard move` so the two read alike. A
kind-generic `nebula move` was out: `nebula move` already moves canvas nodes.
The work is in character_client.py, which the MCP's character_move shares.
"""
from __future__ import annotations

import json
import sys

import character_client as characters
from moodboard_client import MoodboardError
from nebula_api import NebulaAPIError

from ..client import NebulaClient
from .moodboard import print_move


def _fail(message: str) -> None:
    print(f"error: {message}", file=sys.stderr)
    sys.exit(1)


def run(client: NebulaClient, args) -> None:
    headers = client._identity_headers()
    try:
        if args.character_cmd == "move":
            result = characters.move_character(client.api, args.character, args.to, headers)
            if args.json:
                print(json.dumps(result, indent=2, ensure_ascii=False))
                return
            print_move(result, "character")
            return
        _fail(f"unknown character command {args.character_cmd}")
    except MoodboardError as exc:
        _fail(str(exc))
    except NebulaAPIError as exc:
        if exc.kind == "connect":
            _fail(f"cannot connect to Nebula backend at {client.base_url} — is the server running?")
        _fail(exc.detail)


def add_parser(sub) -> None:
    """`nebula character ...` on the top-level parser."""
    character_p = sub.add_parser("character", help="Characters (the ones in Character Studio): move one")
    csub = character_p.add_subparsers(dest="character_cmd", required=True)
    move_p = csub.add_parser(
        "move", help="Move a Character to Global or to a canvas project",
        description=("Global Characters show in every project's Global tab; a project's in its Project tab. "
                     "Only where it's listed changes: nodes that use the Character keep working in every "
                     "project. Moving it back undoes it."))
    move_p.add_argument("character", help="Character id or exact name")
    move_p.add_argument("--to", required=True, metavar="WHERE",
                        help="global, current (the project open on the canvas), or a project's id or exact "
                             "name from `nebula projects`")
    move_p.add_argument("--json", action="store_true", help="Print JSON")
