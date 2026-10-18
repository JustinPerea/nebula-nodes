"""nebula moodboard list|show|new|add|set|analyze|delete.

The boards Moodboard Studio edits, from the terminal. The work is in
moodboard_client.py, which the MCP server's moodboard tools share; this file
parses arguments and prints.
"""
from __future__ import annotations

import json
import os
import sys
from typing import Any

import moodboard_client as boards
from nebula_api import NebulaAPIError

from ..client import NebulaClient


def _fail(message: str) -> None:
    print(f"error: {message}", file=sys.stderr)
    sys.exit(1)


def _print_json(data: Any) -> None:
    print(json.dumps(data, indent=2, ensure_ascii=False))


def _pairs(items: list[str], flag: str) -> list[tuple[str, str]]:
    pairs = []
    for item in items:
        image, sep, value = item.partition("=")
        if not sep or not image.strip():
            _fail(f"{flag} takes IMAGE=VALUE, e.g. {flag} 2=0.5 (IMAGE is its number or id)")
        pairs.append((image.strip(), value))
    return pairs


def _scope_label(board: dict[str, Any]) -> str:
    project = board.get("projectId")
    return f"project {project}" if project else "all projects"


def _print_board(board: dict[str, Any]) -> None:
    images = board.get("images") or []
    strength = board.get("strength")
    strength_text = f"{float(strength):.2f}" if isinstance(strength, (int, float)) else "?"
    print(f"{board.get('name')}  ({board.get('id')})")
    print(f"  {board.get('mode')} · strength {strength_text} · {_scope_label(board)}")
    if board.get("notes"):
        print(f"  Notes: {board['notes']}")
    print(f"  Images ({len(images)}):")
    for index, image in enumerate(images, start=1):
        flags = "  excluded" if image.get("excluded") else ""
        note = f'  "{image["notes"]}"' if image.get("notes") else ""
        print(f"    {index:>2}  {image.get('id')}  weight {float(image.get('weight', 1)):.2f}{flags}  "
              f"{image.get('url')}{note}")
    analysis = board.get("analysis")
    if not analysis:
        print(f"  Not analyzed since its last change. `nebula moodboard analyze {board.get('id')}`")
        return
    print("  Analysis:")
    if analysis.get("summary"):
        print(f"    {analysis['summary']}")
    for label, key in (("Palette", "palette"), ("Accents", "accents"), ("Keywords", "keywords")):
        values = analysis.get(key) or []
        if values:
            print(f"    {label}: {' '.join(str(value) for value in values)}")
    for label, key in (("Brief", "styleBrief"), ("Avoid", "negativePrompt")):
        if analysis.get(key):
            print(f"    {label}: {analysis[key]}")


def _added_line(count: int, skipped: int) -> str:
    line = f"{count} image{'' if count == 1 else 's'}"
    if skipped:
        line += f" ({skipped} already on the board, skipped)"
    return line


def _person_confirms_permanent_delete(board: dict[str, Any]) -> bool:
    """On a Nebula that deletes boards for good, only the person may, and
    only by typing the board's name at their own terminal. A command run by
    an agent (an agent name or token set, or no terminal to type in) is
    refused with what it can do instead."""
    if os.environ.get("NEBULA_AGENT_NAME") or os.environ.get("NEBULA_AGENT_TOKEN"):
        return False
    if not (sys.stdin.isatty() and sys.stdout.isatty()):
        print("This delete can't be undone. If you're the person, run it in your own terminal to confirm.",
              file=sys.stderr)
        return False
    name = str(board.get("name") or "")
    print(f"Deleting {name} ({board.get('id')}) can't be undone in this version of Nebula.")
    try:
        typed = input("Type the board's name to delete it for good: ")
    except EOFError:
        return False
    if typed.strip() != name.strip():
        _fail("the name didn't match, so nothing was deleted")
    return True


def run(client: NebulaClient, args) -> None:
    api = client.api
    headers = client._identity_headers()
    verb = args.moodboard_cmd
    try:
        if verb == "list":
            if args.global_only:
                project = None
            elif args.project:
                project = boards.resolve_project(api, args.project, headers)
            else:
                # Default: boards for every project plus the open project's own.
                project = boards.active_project(api, headers)
            listing = boards.list_boards(api, project=project, include_global=True, headers=headers)
            if args.json:
                _print_json([boards.brief(board) for board in listing])
                return
            if not listing:
                print("No moodboards yet. `nebula moodboard new \"Name\" <images...>` makes one.")
                return
            for board in listing:
                analyzed = "analyzed" if board.get("analysis") else "not analyzed"
                print(f"{board.get('id')}  {board.get('name')}  ({len(board.get('images') or [])} images, "
                      f"{board.get('mode')}, {analyzed}, {_scope_label(board)})")
        elif verb == "show":
            board = boards.get_board(api, args.board, headers)
            if args.json:
                _print_json(boards.brief(board))
            else:
                _print_board(board)
        elif verb == "new":
            board, skipped = boards.create_board(
                api, args.name, args.sources, project=args.project, mode=args.mode, strength=args.strength,
                notes=args.notes or "", headers=headers)
            if args.json:
                _print_json(boards.brief(board))
                return
            print(f"Made {board.get('name')} ({board.get('id')}) with "
                  f"{_added_line(len(board.get('images') or []), skipped)}. It's in Moodboard Studio.")
        elif verb == "add":
            board, added, skipped = boards.add_to_board(api, args.board, args.sources, headers=headers)
            if args.json:
                _print_json(boards.brief(board))
                return
            print(f"Added {_added_line(added, skipped)} to {board.get('name')} "
                  f"({len(board.get('images') or [])} in all).")
            if added:
                print(f"Its analysis is out of date now: `nebula moodboard analyze {board.get('id')}`")
        elif verb == "set":
            edits: dict[str, dict[str, Any]] = {}
            for image, value in _pairs(args.weight, "--weight"):
                edits.setdefault(image, {"image": image})["weight"] = value
            for image, value in _pairs(args.image_note, "--image-note"):
                edits.setdefault(image, {"image": image})["notes"] = value
            for image in args.exclude:
                edits.setdefault(image, {"image": image})["excluded"] = True
            for image in args.include:
                edits.setdefault(image, {"image": image})["excluded"] = False
            board, removed, previous = boards.update_board(
                api, args.board, name=args.name, notes=args.notes, mode=args.mode, strength=args.strength,
                images=list(edits.values()), remove=args.remove, headers=headers)
            if args.json:
                _print_json({**boards.brief(board), "removed": removed, "previous": previous})
                return
            print(f"Updated {board.get('name')} ({board.get('id')}).")
            for url in removed:
                print(f"  Took {url} off the board. Put it back with `nebula moodboard add {board.get('id')} {url}`.")
            if not board.get("analysis"):
                print(f"Its analysis is out of date now: `nebula moodboard analyze {board.get('id')}`")
        elif verb == "analyze":
            board = boards.analyze_board(api, args.board, headers)
            if args.json:
                _print_json(boards.brief(board))
            else:
                _print_board(board)
        elif verb == "delete":
            board = boards.get_board(api, args.board, headers)
            allow_permanent = False
            if not boards.deletes_are_restorable(api, headers):
                allow_permanent = _person_confirms_permanent_delete(board)
            result = boards.delete_board(api, board["id"], headers, allow_permanent=allow_permanent)
            if result.get("restorable"):
                print(f"Deleted {result.get('name')} ({result.get('id')}). It's in Recently deleted: "
                      f"`nebula trash restore moodboard {result.get('id')}` brings it back.")
            else:
                print(f"Deleted {result.get('name')} ({result.get('id')}) for good.")
    except boards.MoodboardError as exc:
        _fail(str(exc))
    except NebulaAPIError as exc:
        if exc.kind == "connect":
            _fail(f"cannot connect to Nebula backend at {client.base_url} — is the server running?")
        _fail(exc.detail)


def add_parser(sub) -> None:
    """`nebula moodboard ...` on the top-level parser."""
    board_help = "Board id or exact name"
    moodboard_p = sub.add_parser(
        "moodboard", help="Make and change moodboards (the boards in Moodboard Studio)",
        description=(
            "Images can be files, folders (their images, in name order), http(s) links or Nebula outputs "
            "(/api/outputs/...). Links are downloaded here, on this machine, then uploaded to Nebula; "
            "only public web links work (not this computer or its network; ports 80 and 443). "
            "Name an image on a board by its number or id from `nebula moodboard show`."))
    msub = moodboard_p.add_subparsers(dest="moodboard_cmd", required=True)

    list_p = msub.add_parser("list", help="List boards: those for every project, plus the open project's")
    list_p.add_argument("--project", help="A project id (or 'current') instead of the open project")
    list_p.add_argument("--global", dest="global_only", action="store_true",
                        help="Only boards that belong to no project")
    list_p.add_argument("--json", action="store_true", help="Print JSON")

    show_p = msub.add_parser("show", help="Show a board: settings, numbered images and analysis")
    show_p.add_argument("board", help=board_help)
    show_p.add_argument("--json", action="store_true", help="Print JSON")

    new_p = msub.add_parser("new", help="Make a board from files, folders and links")
    new_p.add_argument("name", help="Board name")
    new_p.add_argument("sources", nargs="*", metavar="image", help="Files, folders, http(s) links or Nebula outputs")
    new_p.add_argument("--project", help="Keep the board in this project ('current' = the open one). "
                                         "Default: no project, so every project can use it")
    new_p.add_argument("--mode", choices=boards.MODES, default="look",
                       help="look (style), world (setting) or subject (default: look)")
    new_p.add_argument("--strength", type=float, default=0.7, help="How strongly it steers, 0 to 1 (default 0.7)")
    new_p.add_argument("--notes", help="Notes for the whole board")
    new_p.add_argument("--json", action="store_true", help="Print JSON")

    add_p = msub.add_parser("add", help="Add files, folders and links to a board")
    add_p.add_argument("board", help=board_help)
    add_p.add_argument("sources", nargs="+", metavar="image", help="Files, folders, http(s) links or Nebula outputs")
    add_p.add_argument("--json", action="store_true", help="Print JSON")

    set_p = msub.add_parser("set", help="Change a board's images and settings")
    set_p.add_argument("board", help=board_help)
    set_p.add_argument("--weight", action="append", default=[], metavar="IMAGE=W",
                       help="How much one image counts, 0 to 1, e.g. --weight 2=0.5 (repeatable)")
    set_p.add_argument("--image-note", dest="image_note", action="append", default=[], metavar="IMAGE=TEXT",
                       help="A note on one image, e.g. --image-note 3=\"the orange accent\" (repeatable)")
    set_p.add_argument("--exclude", action="append", default=[], metavar="IMAGE",
                       help="Keep an image on the board but stop it steering (repeatable)")
    set_p.add_argument("--include", action="append", default=[], metavar="IMAGE",
                       help="Let an excluded image steer again (repeatable)")
    set_p.add_argument("--remove", action="append", default=[], metavar="IMAGE",
                       help="Take an image off the board (its file stays; repeatable)")
    set_p.add_argument("--name", help="Rename the board")
    set_p.add_argument("--notes", help="Notes for the whole board")
    set_p.add_argument("--mode", choices=boards.MODES)
    set_p.add_argument("--strength", type=float, help="How strongly it steers, 0 to 1")
    set_p.add_argument("--json", action="store_true", help="Print JSON")

    analyze_p = msub.add_parser("analyze", help="Analyze a board (palette, accents, brief)")
    analyze_p.add_argument("board", help=board_help)
    analyze_p.add_argument("--json", action="store_true", help="Print JSON")

    delete_p = msub.add_parser(
        "delete", help="Delete a board (it goes to Recently deleted where Nebula has it)",
        description=("Where Nebula keeps deleted boards in Recently deleted, anyone may delete one, and "
                     "`nebula trash restore moodboard <id>` brings it back. Where a delete is for good, only "
                     "the person can, by typing the board's name in their own terminal; agents are refused."))
    delete_p.add_argument("board", help=board_help)
