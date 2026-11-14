"""`nebula character list|show|move`: Characters (the ones in Character Studio).

`move` moves one between Global and a canvas project (Justin's call P4,
2026-10-19), shaped like `nebula moodboard move` so the two read alike. A
kind-generic `nebula move` was out: `nebula move` already moves canvas nodes.
`list` and `show` read them, shaped like `nebula style list|show`, so an agent
can name one for `nebula point --character`. There is no write but the move.
The work is in character_client.py, which the MCP's character_* tools share.
"""
from __future__ import annotations

import json
import sys

import character_client as characters
import moodboard_client as boards
from moodboard_client import MoodboardError
from nebula_api import NebulaAPIError

from ..client import NebulaClient, connect_failure
from .moodboard import print_move


def _fail(message: str) -> None:
    print(f"error: {message}", file=sys.stderr)
    sys.exit(1)


def _views(character: dict) -> str:
    count = int(character.get("viewCount") or 0)
    return f"{count} view" + ("" if count == 1 else "s")


def _where(character: dict, names: dict) -> str:
    project = character.get("projectId")
    if not project:
        return "Global"
    name, trashed = names.get(project, (project, False))
    return f"project {name}" + (" (in Recently deleted)" if trashed else "")


def run(client: NebulaClient, args) -> None:
    headers = client._identity_headers()
    try:
        if args.character_cmd == "list":
            if args.global_only:
                project = None
            elif args.project:
                project = boards.resolve_project(client.api, args.project, headers)
            else:
                project = boards.active_project(client.api, headers)
            listing = characters.list_characters(client.api, project=project, headers=headers)
            if args.json:
                print(json.dumps(listing, indent=2, ensure_ascii=False))
                return
            if not listing:
                print("No Characters yet. Character Studio makes them.")
                return
            names = boards.project_names(client.api, headers) if any(c.get("projectId") for c in listing) else {}
            for character in listing:
                print(f"{character.get('id')}  {character.get('name')}  ({character.get('subjectType')}, "
                      f"{_views(character)}, {_where(character, names)})")
            return
        if args.character_cmd == "show":
            character = characters.get_character(client.api, args.character, headers)
            if args.json:
                print(json.dumps(character, indent=2, ensure_ascii=False))
                return
            names = boards.project_names(client.api, headers) if character.get("projectId") else {}
            print(f"{character.get('id')}  {character.get('name')}  ({character.get('subjectType')}, "
                  f"{_where(character, names)}, version {character.get('version')})")
            print(f"  frozen trait string: {character.get('frozenTraitString') or '(none)'}")
            print(f"  seed: {character.get('seed') if character.get('seed') is not None else '(none)'}")
            print(f"  reference views ({character.get('viewCount')}; `nebula point --character ... --view N` "
                  "names one by its number, 1 is the cover):")
            for number, url in enumerate(character.get("referenceViews") or [], start=1):
                print(f"    {number}. {url}")
            return
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
            _fail(connect_failure(client.base_url, exc))
        _fail(exc.detail)


def add_parser(sub) -> None:
    """`nebula character ...` on the top-level parser."""
    character_p = sub.add_parser("character", help="Characters (the ones in Character Studio): list, show, move")
    csub = character_p.add_subparsers(dest="character_cmd", required=True)
    list_p = csub.add_parser("list", help="List Characters: the Global ones, plus the open project's")
    list_p.add_argument("--project", help="A canvas project id (from `nebula projects`) or 'current' "
                                          "instead of the open project")
    list_p.add_argument("--global", dest="global_only", action="store_true", help="Only the Global Characters")
    list_p.add_argument("--json", action="store_true", help="Print JSON")
    show_p = csub.add_parser("show", help="Show a Character: trait string, seed and reference views")
    show_p.add_argument("character", help="Character id or exact name (`nebula character list`)")
    show_p.add_argument("--json", action="store_true", help="Print JSON")
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
