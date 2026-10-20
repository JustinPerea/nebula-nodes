"""nebula moodboard list|show|new|add|set|edit|analyze [--dry-run]|move|delete.

The boards Moodboard Studio edits, from the terminal. The work is in
moodboard_client.py, which the MCP server's moodboard tools share; this file
parses arguments and prints.
"""
from __future__ import annotations

import json
import shlex
import sys
from pathlib import Path
from typing import Any

import moodboard_client as boards
from nebula_api import NebulaAPIError
from services.moodboard_brief import board_is_off

from ..client import NebulaClient


def _fail(message: str) -> None:
    print(f"error: {message}", file=sys.stderr)
    sys.exit(1)


def _print_json(data: Any) -> None:
    print(json.dumps(data, indent=2, ensure_ascii=False))


def _changes_flags(args) -> bool:
    """Whether `set` was given any change besides the image edits."""
    values = (args.name, args.notes, args.mode, args.strength, args.direction, args.brief, args.clash_mode,
              args.send_notes)
    lists = (args.avoid, args.unavoid, args.pin_color, args.keep_out_color, args.unpin_color, args.keep_anyway,
             args.leave_out, args.reset_color)
    return (any(value is not None for value in values) or any(lists)
            or args.clear_avoid or args.clear_brief or args.keep_brief or args.leave_out_flagged)


def _read_previous(source: str) -> dict[str, Any]:
    """The `previous` an earlier `set --json` printed, from a file or stdin
    (-): the object itself, or that whole output."""
    try:
        text = sys.stdin.read() if source == "-" else Path(source).expanduser().read_text(encoding="utf-8")
        data = json.loads(text)
    except (OSError, ValueError) as exc:
        _fail(f"--restore: can't read {source}: {exc}")
    if isinstance(data, dict) and isinstance(data.get("previous"), dict):
        data = data["previous"]
    if not isinstance(data, dict) or not data:
        _fail("--restore takes the `previous` object that `nebula moodboard set --json` printed")
    unknown = sorted(set(data) - set(boards.RESTORE_KEYS))
    if unknown:
        _fail(f"--restore: `previous` has no setting called {', '.join(unknown)}")
    return data


def _read_json(source: str, flag: str) -> Any:
    """JSON from a file, or from stdin for -."""
    try:
        text = sys.stdin.read() if source == "-" else Path(source).expanduser().read_text(encoding="utf-8")
        return json.loads(text)
    except (OSError, ValueError) as exc:
        _fail(f"{flag}: can't read {source}: {exc}")


def _edit_flags(args) -> bool:
    return any((args.place, args.resize, args.into, args.link, args.set_aside, args.use, args.note,
                args.private_note, args.ops is not None))


def _print_edit(result: dict[str, Any], *, undoing: bool) -> None:
    board = result.get("board") or {}
    applied = [entry for entry in result.get("applied") or [] if isinstance(entry, dict)]
    changed = sum(1 for entry in applied if entry.get("status") == "applied")
    same = len(applied) - changed
    label = f"{board.get('name')} ({board.get('id')})"
    if undoing:
        print(f"Put {label} back." if changed else f"Nothing on {label} was put back:")
    else:
        line = f"Edited {label}: {changed} change{'' if changed == 1 else 's'}"
        print(line + (f", {same} already so." if same else "."))
    for message in boards.skipped_messages(result):
        print(f"  {message}.")
    undo = result.get("undo") or {}
    if undo.get("ops"):
        text = json.dumps(undo, ensure_ascii=False, separators=(",", ":"))
        print(f"{'Redo it' if undoing else 'Undo it'}: echo {shlex.quote(text)} | "
              f"nebula moodboard edit {board.get('id')} --undo -")
    if not board.get("analysis") and changed:
        print(f"Its analysis is out of date now: `nebula moodboard analyze {board.get('id')}`")


def _pairs(items: list[str], flag: str) -> list[tuple[str, str]]:
    pairs = []
    for item in items:
        image, sep, value = item.partition("=")
        if not sep or not image.strip():
            _fail(f"{flag} takes IMAGE=VALUE, e.g. {flag} 2=0.5 (IMAGE is its number or id)")
        pairs.append((image.strip(), value))
    return pairs


def _scope_label(board: dict[str, Any], names: dict[str, tuple[str, bool]] | None = None) -> str:
    """"all projects", or the board's canvas project by name with a short id
    ("project Shoot A (5f3c1a2b…)"); just the id when the name isn't known."""
    project = board.get("projectId")
    if not project:
        return "all projects"
    known = (names or {}).get(project)
    if not known:
        return f"project {project}"
    name, trashed = known
    short = project if len(project) <= 12 else f"{project[:8]}…"
    return f"project {name} ({short}{', in Recently deleted' if trashed else ''})"


_OVERRIDE_AUTHOR = {"person": "written by the person", "agent": "written by an agent"}


def _print_brief(board: dict[str, Any]) -> None:
    """The brief generators get, as the backend composed it. Never the
    analysis's own styleBrief: that leaves out Direction, pinned colours and
    a hand-written brief."""
    summary = boards.brief(board)
    composed, override, board_id = summary["brief"], summary["briefOverride"], board.get("id")
    if composed is None:
        print("  Brief sent to generators: this version of Nebula doesn't say which brief generators get. "
              "Open the board in Moodboard Studio to see it.")
        return
    source = _OVERRIDE_AUTHOR[override["by"]] if override else "generated"
    if board_is_off(board):
        # Q36 a: at 0 no node it's wired into gets any of it.
        print(f"  Brief ({source}), not sent: board strength is 0, so no node it's wired into gets the board:")
    else:
        print(f"  Brief sent to generators ({source}):")
    if composed.get("styleBrief"):
        print(f"    {composed['styleBrief']}")
    else:
        print(f"    Not built yet: `nebula moodboard analyze {board_id}`")
    if override and override.get("stale"):
        if override["by"] == "agent":
            print(f"    The board changed since this was written. Keep it with `nebula moodboard set {board_id} "
                  "--keep-brief`, or go back to the generated brief with `--clear-brief`.")
        else:
            print("    The board changed since the person wrote this. Only they can keep or replace it, "
                  "in Moodboard Studio.")
    if composed.get("negativePrompt"):
        print(f"  Negative prompt: {composed['negativePrompt']}")
    if composed.get("avoidPrompt"):
        print(f"  Added to the prompt for GPT Image, Nano Banana and Krea 2: {composed['avoidPrompt']}")
    _print_clashes(composed, board_id)


def _clash_line(item: dict[str, Any]) -> str:
    role = "pinned" if item.get("role") == "pinned" else ("accent" if item.get("role") == "accent" else "palette")
    # Every reason: a colour off because the board sends no measured colours
    # may also clash with the words.
    reasons = [str(reason) for reason in item.get("reasons") or [] if reason] or [str(item.get("reason") or "")]
    return f"    {item.get('hex') or 'the whole palette'} ({role}): {'; '.join(reasons)}".rstrip()


def _print_clashes(composed: dict[str, Any], board_id: Any) -> None:
    """Where the board's words and its measured colours disagree, and what
    went (gap 18). Nothing on a Nebula that doesn't check."""
    if "leftOut" not in composed:
        return
    target = shlex.quote(str(board_id))
    mode = composed.get("clashMode")
    if mode and mode != "leave-out":
        print(f"  Clash check: {mode}")
    for label, key, flag in (("Left out of the brief:", "leftOut", "--keep-anyway"),
                             ("Kept anyway (your choice):", "kept", "--reset-color"),
                             ("May clash (still sent):", "mayClash", "--leave-out")):
        items = [item for item in composed.get(key) or [] if isinstance(item, dict)]
        if not items:
            continue
        print(f"  {label}")
        for item in items:
            print(_clash_line(item))
            hex_value = item.get("hex")
            if not hex_value:
                continue
            verb = {"--keep-anyway": "Keep it", "--reset-color": "Undo", "--leave-out": "Leave it out"}[flag]
            # A colour the person left out goes back with --reset-color.
            use = "--reset-color" if key == "leftOut" and item.get("why") == "choice" else flag
            print(f'      {verb}: nebula moodboard set {target} {use} "{hex_value}"')
    for label, key in (("Pinned colors that clash (still sent):", "pinnedClashes"),
                       ("The whole palette:", "paletteClashes")):
        items = [item for item in composed.get(key) or [] if isinstance(item, dict)]
        if items:
            print(f"  {label}")
            for item in items:
                print(_clash_line(item))
    if "notesSent" in composed:
        print(f"  Notes: {'sent to generators' if composed['notesSent'] else 'not sent to generators'}")


def _print_board(board: dict[str, Any], names: dict[str, tuple[str, bool]] | None = None) -> None:
    images = board.get("images") or []
    strength = board.get("strength")
    strength_text = f"{float(strength):.2f}" if isinstance(strength, (int, float)) else "?"
    print(f"{board.get('name')}  ({board.get('id')})")
    print(f"  {board.get('mode')} · strength {strength_text} · {_scope_label(board, names)}")
    if board.get("notes"):
        print(f"  Notes: {board['notes']}")
    if board.get("direction"):
        print(f"  Direction: {board['direction']}")
    if board.get("avoid"):
        print(f"  Avoid: {', '.join(board['avoid'])}")
    pinned = board.get("pinnedColors") if isinstance(board.get("pinnedColors"), dict) else {}
    for label, key in (("Colors that must appear", "include"), ("Colors to keep out", "exclude")):
        if pinned.get(key):
            print(f"  {label}: {' '.join(pinned[key])}")
    print(f"  Images ({len(images)}):")
    for index, image in enumerate(images, start=1):
        flags = ("  set aside" if image.get("excluded")
                 else "  set aside (weight 0)" if boards.is_set_aside(image) else "")
        note = f'  "{image["notes"]}"' if image.get("notes") else ""
        print(f"    {index:>2}  {image.get('id')}  weight {float(image.get('weight', 1)):.2f}{flags}  "
              f"{image.get('url')}{note}")
        if image.get("privateNote"):
            print(f'        Private note (not sent anywhere): "{image["privateNote"]}"')
    _print_brief(board)
    analysis = board.get("analysis")
    if not analysis:
        print(f"  Not analyzed since its last change. `nebula moodboard analyze {board.get('id')}`")
        return
    print("  Analysis:")
    if analysis.get("summary"):
        print(f"    {analysis['summary']}")
    _print_colours(analysis, board.get("id"))
    if analysis.get("keywords"):
        print(f"    Keywords: {' '.join(str(value) for value in analysis['keywords'])}")


def _pct(share: Any) -> str:
    """A share (0 to 1) as a percentage, with a decimal or two for small ones."""
    try:
        value = float(share) * 100
    except (TypeError, ValueError):
        return "?"
    if value >= 10 or value == 0:
        return f"{value:.0f}%"
    return f"{value:.1f}%" if value >= 1 else f"{value:.2f}%"


def _sources_text(colour: dict[str, Any]) -> str:
    """The images a board colour comes from: "#2 44%, #5 3%" (its share of each)."""
    return ", ".join(f"#{source.get('number')} {_pct(source.get('share'))}" for source in colour.get("sources") or [])


def _print_colours(analysis: dict[str, Any], board_id: Any, indent: str = "    ") -> None:
    """Palette and accents, each colour with its share of the board and the
    images it comes from. An analysis saved before sources existed lists the
    colours alone and says how to see them."""
    colours = [c for c in analysis.get("colors") or [] if isinstance(c, dict)]
    with_sources = bool(colours) and all("sources" in c for c in colours)
    for label, key, role in (("Palette", "palette", "dominant"), ("Accents", "accents", "accent")):
        hexes = analysis.get(key) or []
        if not hexes:
            continue
        if not with_sources:
            print(f"{indent}{label}: {' '.join(str(value) for value in hexes)}")
            continue
        print(f"{indent}{label} (share of the board · images it comes from, with its share of each):")
        for colour in (c for c in colours if c.get("role") == role):
            print(f"{indent}  {colour.get('hex')}  {_pct(colour.get('share')):>6}  {_sources_text(colour)}")
    if (analysis.get("palette") or analysis.get("accents")) and not with_sources:
        print(f"{indent}Analyze again to see which images each colour comes from: "
              f"`nebula moodboard analyze {board_id}`")


def _print_list_change(label: str, change: dict[str, Any]) -> None:
    if not change.get("changed"):
        print(f"    {label}: unchanged")
        return
    print(f"    {label}: changed")
    parts = []
    if change.get("added"):
        parts.append(f"added {' '.join(change['added'])}")
    if change.get("removed"):
        parts.append(f"removed {' '.join(change['removed'])}")
    if change.get("nudged"):
        parts.append("nudged " + ", ".join(f"{pair['from']} → {pair['to']}" for pair in change["nudged"]))
    if change.get("reordered"):
        parts.append("order changed")
    print(f"      {'; '.join(parts)}")
    print(f"      was: {' '.join(change.get('before') or []) or '(none)'}")


def _print_dry_run(result: dict[str, Any]) -> None:
    thresholds, defaults = result.get("thresholds") or {}, result.get("defaults") or {}
    print(f"Dry run for {result.get('name')} ({result.get('id')}). Nothing was saved.")
    names = (("accentMinChroma", "accent min chroma"), ("accentSeparation", "accent separation"),
             ("mergeDeltaE", "merge dE"))
    parts = []
    for key, name in names:
        value = thresholds.get(key)
        tried = f"{value:g}" if isinstance(value, (int, float)) else "?"
        if value != defaults.get(key) and isinstance(defaults.get(key), (int, float)):
            tried += f" (default {defaults[key]:g})"
        parts.append(f"{name} {tried}")
    print(f"  Thresholds: {' · '.join(parts)}")
    saved = result.get("saved") or {}
    if not saved.get("analyzed"):
        print("  The board has no saved analysis, so everything below is new.")
    elif not saved.get("current"):
        print("  The saved analysis is out of date, so the changes include edits to the board.")
    analysis = result.get("analysis") or {}
    print("  Would give:")
    _print_colours(analysis, result.get("id"))
    changes = result.get("changes") or {}
    print("  Compared with what's saved:")
    _print_list_change("Palette", changes.get("palette") or {})
    _print_list_change("Accents", changes.get("accents") or {})
    brief_change, generated = changes.get("brief") or {}, changes.get("generatedBrief") or {}
    if brief_change.get("changed"):
        print("    Brief generators get: changed")
        print(f"      was: {brief_change.get('before') or '(none)'}")
        print(f"      now: {brief_change.get('after') or '(none)'}")
    elif generated.get("changed"):
        print("    Brief generators get: unchanged (a hand-written brief stays); the generated brief would change")
    else:
        print("    Brief generators get: unchanged")
    negatives = changes.get("negativePrompt") or {}
    if negatives.get("changed"):
        print(f"    Negative prompt: changed\n      was: {negatives.get('before')}\n      now: {negatives.get('after')}")
    else:
        print(f"    Negative prompt: unchanged ({negatives.get('after') or 'none'})")


def _added_line(count: int, skipped: int) -> str:
    line = f"{count} image{'' if count == 1 else 's'}"
    if skipped:
        line += f" ({skipped} already on the board, skipped)"
    return line


def print_move(result: dict[str, Any], kind: str) -> None:
    """A move's answer in words, with the command that moves it back."""
    asset = result.get("asset") if isinstance(result.get("asset"), dict) else {}
    label = f"{asset.get('name') or result.get('id')} ({result.get('id')})"
    if result.get("status") != "moved":
        where = "Global" if not result.get("to") else f"in {result.get('toName') or result.get('to')}"
        print(f"{label} is already {where}. Nothing changed.")
        return
    source, target = result.get("fromName") or "Global", result.get("toName") or "Global"
    if result.get("to"):
        print(f"Moved {label} from {source} to {target}. It's in {target}'s Project tab now.")
    else:
        print(f"Moved {label} from {source} to Global. Every project's Global tab lists it now.")
    print("Nodes that use it keep working in every project.")
    back = result.get("from") or "global"
    print(f"Move it back: nebula {kind} move {result.get('id')} --to {back}")


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
            names = boards.project_names(api, headers) if any(b.get("projectId") for b in listing) else {}
            for board in listing:
                analyzed = "analyzed" if board.get("analysis") else "not analyzed"
                images = [image for image in board.get("images") or [] if isinstance(image, dict)]
                # Set-aside images still count; the Studio and the node card name them beside it.
                aside = sum(1 for image in images if boards.is_set_aside(image))
                counted = f"{len(images)} {'image' if len(images) == 1 else 'images'}" + (
                    f", {aside} set aside" if aside else "")
                print(f"{board.get('id')}  {board.get('name')}  ({counted}, "
                      f"{board.get('mode')}, {analyzed}, {_scope_label(board, names)})")
        elif verb == "show":
            board = boards.get_board(api, args.board, headers)
            if args.json:
                _print_json(boards.brief(board, layout=True))
            else:
                _print_board(board, boards.project_names(api, headers) if board.get("projectId") else None)
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
            board, added, skipped, undo = boards.add_to_board(api, args.board, args.sources, headers=headers)
            ids = boards.added_ids(board, undo)
            if args.json:
                _print_json({**boards.brief(board), "added": added, "duplicatesSkipped": skipped, "addedIds": ids,
                             "undo": undo})
                return
            print(f"Added {_added_line(added, skipped)} to {board.get('name')} "
                  f"({len(board.get('images') or [])} in all).")
            if ids:
                removes = " ".join(f"--remove {image_id}" for image_id in ids)
                print(f"Take them off again: nebula moodboard set {board.get('id')} {removes}")
            if added:
                print(f"Its analysis is out of date now: `nebula moodboard analyze {board.get('id')}`")
        elif verb == "set":
            skipped: list[str] = []  # what an undo left as is
            edits: dict[str, dict[str, Any]] = {}
            for image, value in _pairs(args.weight, "--weight"):
                edits.setdefault(image, {"image": image})["weight"] = value
            for image, value in _pairs(args.image_note, "--image-note"):
                edits.setdefault(image, {"image": image})["notes"] = value
            for image, value in _pairs(args.private_note, "--private-note"):
                edits.setdefault(image, {"image": image})["privateNote"] = value
            both = sorted(set(args.set_aside) & set(args.use))
            if both:
                _fail(f"--set-aside and --use both name image {', '.join(both)}: pick one")
            for image in args.set_aside:
                edits.setdefault(image, {"image": image})["excluded"] = True
            for image in args.use:
                edits.setdefault(image, {"image": image})["excluded"] = False
            if args.brief is not None and args.clear_brief:
                _fail("--brief and --clear-brief can't go together")
            if args.clear_avoid and args.unavoid:
                _fail("--clear-avoid empties the Avoid list, so --unavoid has nothing to take off")
            if args.restore is not None:
                if edits or args.remove or _changes_flags(args):
                    _fail("--restore puts back a whole `previous`, so it can't go with other changes")
                restore = _read_previous(args.restore)
                if "undo" in restore:
                    # One checked restore: what changed since is left as it is, and said.
                    rest = {key: value for key, value in restore.items() if key != "undo"}
                    board, removed, previous, skipped = boards.undo_board(api, args.board, restore["undo"],
                                                                          fallback=rest, headers=headers)
                else:  # a `previous` from before checked undo
                    board, removed, previous = boards.update_board(api, args.board, **restore, headers=headers)
            else:
                board, removed, previous = boards.update_board(
                    api, args.board, name=args.name, notes=args.notes, mode=args.mode, strength=args.strength,
                    images=list(edits.values()), remove=args.remove, direction=args.direction,
                    avoid=[] if args.clear_avoid else None, avoid_add=args.avoid, avoid_remove=args.unavoid,
                    pin_colors=args.pin_color, keep_out_colors=args.keep_out_color,
                    unpin_colors=args.unpin_color, brief_override="" if args.clear_brief else args.brief,
                    keep_brief=args.keep_brief, keep_anyway=args.keep_anyway, leave_out=args.leave_out,
                    leave_out_flagged=args.leave_out_flagged, reset_colors=args.reset_color,
                    clash_mode=args.clash_mode, send_notes=args.send_notes, headers=headers)
            if args.json:
                _print_json({**boards.brief(board), "removed": removed, "previous": previous,
                             **({"skipped": skipped} if args.restore is not None else {})})
                return
            print(f"Updated {board.get('name')} ({board.get('id')}).")
            for message in skipped:
                print(f"  {message}.")
            for url in removed:
                print(f"  Took {url} off the board. Put it back with `nebula moodboard add {board.get('id')} {url}`.")
            if not board.get("analysis"):
                print(f"Its analysis is out of date now: `nebula moodboard analyze {board.get('id')}`")
        elif verb == "edit":
            if args.undo is not None:
                if _edit_flags(args) or args.base_version is not None:
                    _fail("--undo puts back a whole edit, so it can't go with other changes or --base-version")
                ops = boards.undo_ops(_read_json(args.undo, "--undo"))
            else:
                board = boards.get_board(api, args.board, headers)
                ops = []
                if args.ops is not None:
                    raw = _read_json(args.ops, "--ops")
                    raw = raw.get("ops") if isinstance(raw, dict) else raw
                    if not isinstance(raw, list) or not all(isinstance(op, dict) for op in raw):
                        _fail("--ops takes a JSON list of ops, or {\"ops\": [...]} (contract 07, section 1.12)")
                    ops += raw
                ops += boards.edit_ops(board, place=args.place, resize=args.resize, into=args.into, link=args.link,
                                       set_aside=args.set_aside, use=args.use, note=args.note,
                                       private_note=args.private_note)
                if not ops:
                    _fail("nothing to change: give --place, --resize, --in, --link, --set-aside, --use, --note, "
                          "--private-note, --ops or --undo")
            result = boards.edit_board(api, args.board, ops, base_version=args.base_version, say=args.say,
                                       headers=headers)
            if args.json:
                _print_json({**boards.brief(result["board"], layout=True), "version": result.get("version"),
                             "applied": result.get("applied") or [], "undo": result.get("undo") or {"ops": []}})
                return
            _print_edit(result, undoing=args.undo is not None)
        elif verb == "analyze":
            thresholds = {key: getattr(args, key) for key in boards.THRESHOLD_FIELDS}
            if not args.dry_run:
                if any(value is not None for value in thresholds.values()):
                    _fail("thresholds work only with --dry-run: nothing saves custom thresholds")
            else:
                result = boards.dry_run_board(api, args.board, thresholds=thresholds, headers=headers)
                if args.json:
                    _print_json(result)
                else:
                    _print_dry_run(result)
                return
            board = boards.analyze_board(api, args.board, headers)
            if args.json:
                _print_json(boards.brief(board))
            else:
                _print_board(board, boards.project_names(api, headers) if board.get("projectId") else None)
        elif verb == "move":
            result = boards.move_board(api, args.board, args.to, headers)
            if args.json:
                asset = result.get("asset")
                _print_json({**result, "asset": boards.brief(asset) if isinstance(asset, dict) else asset})
                return
            print_move(result, "moodboard")
        elif verb == "delete":
            result = boards.delete_board(api, args.board, headers)
            if result.get("restorable"):
                print(f"Deleted {result.get('name')} ({result.get('id')}). It's in Recently deleted: "
                      f"`nebula trash restore moodboard {result.get('id')}` brings it back.")
            else:
                print(f"Deleted {result.get('name')} ({result.get('id')}).")
    except boards.MoodboardError as exc:
        if exc.previous is not None:
            # Part of the change was saved: say how to put it back.
            print(f"error: {exc}", file=sys.stderr)
            board_ref = shlex.quote(exc.board_id or getattr(args, "board", "<board>"))
            print(f"To put the board back, save this as a file and run "
                  f"`nebula moodboard set {board_ref} --restore <file>`:", file=sys.stderr)
            print(json.dumps({"previous": exc.previous}, indent=2, ensure_ascii=False), file=sys.stderr)
            sys.exit(1)
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
    list_p.add_argument("--project", help="A canvas project id (from `nebula projects`) or 'current' "
                                          "instead of the open project")
    list_p.add_argument("--global", dest="global_only", action="store_true",
                        help="Only boards that belong to no project")
    list_p.add_argument("--json", action="store_true", help="Print JSON")

    show_p = msub.add_parser(
        "show", help="Show a board: settings, the brief generators get, numbered images and analysis")
    show_p.add_argument("board", help=board_help)
    show_p.add_argument("--json", action="store_true", help="Print JSON")

    new_p = msub.add_parser("new", help="Make a board from files, folders and links")
    new_p.add_argument("name", help="Board name")
    new_p.add_argument("sources", nargs="*", metavar="image", help="Files, folders, http(s) links or Nebula outputs")
    new_p.add_argument("--project", help="Keep the board in this canvas project: 'current' = the one open "
                                         "on the canvas, or an id from `nebula projects`. "
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

    set_p = msub.add_parser("set", help="Change a board's images, settings and brief")
    set_p.add_argument("board", help=board_help)
    set_p.add_argument("--weight", action="append", default=[], metavar="IMAGE=W",
                       help="How much one image counts, 0 to 1, e.g. --weight 2=0.5 (repeatable)")
    set_p.add_argument("--image-note", dest="image_note", action="append", default=[], metavar="IMAGE=TEXT",
                       help="A note on one image, e.g. --image-note 3=\"the orange accent\" (repeatable)")
    set_p.add_argument("--private-note", dest="private_note", action="append", default=[], metavar="IMAGE=TEXT",
                       help="The person's own label for one image, e.g. --private-note 2=\"PAINTERLY (liked)\". "
                            "Not sent anywhere: no analysis, brief or generator gets it, so it keeps the "
                            "analysis (repeatable)")
    set_p.add_argument("--set-aside", "--exclude", dest="set_aside", action="append", default=[], metavar="IMAGE",
                       help="Set an image aside: it stays on the board, keeps its weight and is still read "
                            "for its colours, but never steers (repeatable; --exclude is the old name)")
    set_p.add_argument("--use", "--include", dest="use", action="append", default=[], metavar="IMAGE",
                       help="Use a set-aside image again; one at weight 0 takes the weight its card shows "
                            "unless --weight sets one (repeatable; --include is the old name)")
    set_p.add_argument("--remove", action="append", default=[], metavar="IMAGE",
                       help="Take an image off the board (its file stays; repeatable)")
    set_p.add_argument("--name", help="Rename the board")
    set_p.add_argument("--notes", help="Notes for the whole board")
    set_p.add_argument("--mode", choices=boards.MODES)
    set_p.add_argument("--strength", type=float, help="How strongly it steers, 0 to 1 (0 turns the board off)")
    brief_g = set_p.add_argument_group(
        "the brief", "What generators get from the board. These keep the analysis.")
    brief_g.add_argument("--direction", metavar="TEXT",
                         help='What the board is for, in positive words ("" clears it)')
    brief_g.add_argument("--avoid", action="append", default=[], metavar="TEXT",
                         help="Add something to keep out of the image (repeatable)")
    brief_g.add_argument("--unavoid", action="append", default=[], metavar="TEXT",
                         help="Take something off the Avoid list (repeatable)")
    brief_g.add_argument("--clear-avoid", dest="clear_avoid", action="store_true",
                         help="Empty the Avoid list first (with --avoid, replaces it)")
    brief_g.add_argument("--pin-color", dest="pin_color", action="append", default=[], metavar="HEX",
                         help="A colour that must appear, e.g. --pin-color \"#E8593C\" (repeatable)")
    brief_g.add_argument("--keep-out-color", dest="keep_out_color", action="append", default=[], metavar="HEX",
                         help="A colour to keep out (repeatable)")
    brief_g.add_argument("--unpin-color", dest="unpin_color", action="append", default=[], metavar="HEX",
                         help="Take a colour off either list (repeatable)")
    brief_g.add_argument("--brief", metavar="TEXT",
                         help="Write the brief by hand; generators get it instead of the generated one")
    brief_g.add_argument("--clear-brief", dest="clear_brief", action="store_true",
                         help="Go back to the generated brief")
    brief_g.add_argument("--keep-brief", dest="keep_brief", action="store_true",
                         help="Keep a hand-written brief after the board changed (clears \"changed since\")")
    clash_g = set_p.add_argument_group(
        "clashes", "When the board's words clash with a colour Nebula measured. `show` lists them.")
    clash_g.add_argument("--keep-anyway", dest="keep_anyway", action="append", default=[], metavar="HEX",
                         help="Put a left-out colour back in the brief (it isn't pinned; repeatable)")
    clash_g.add_argument("--leave-out", dest="leave_out", action="append", default=[], metavar="HEX",
                         help="Take a measured colour out of the brief (repeatable)")
    clash_g.add_argument("--leave-out-flagged", dest="leave_out_flagged", action="store_true",
                         help="Take every colour flagged as a possible clash out of the brief")
    clash_g.add_argument("--reset-color", dest="reset_color", action="append", default=[], metavar="HEX",
                         help="Drop a Keep anyway or Leave out choice (repeatable)")
    clash_g.add_argument("--clash-mode", dest="clash_mode", choices=("leave-out", "flag", "no-measured", "keep-all"),
                         help="leave-out (default): clashing colours leave the brief; flag: list them, leave "
                              "nothing out; no-measured: with a Direction, send no measured colour; keep-all: "
                              "send every measured colour")
    notes_g = clash_g.add_mutually_exclusive_group()
    notes_g.add_argument("--send-notes", dest="send_notes", action="store_const", const=True, default=None,
                         help="Send the board's notes to generators (only the person can turn this on)")
    notes_g.add_argument("--no-send-notes", dest="send_notes", action="store_const", const=False,
                         help="Keep the board's notes for people and agents only (the default)")
    set_p.add_argument("--restore", metavar="FILE",
                       help="Undo a change: the `previous` from `set --json` (or its whole output), "
                            "as a file or - for stdin. What someone changed since is left as they set it, "
                            "and said")
    set_p.add_argument("--json", action="store_true", help="Print JSON")

    edit_p = msub.add_parser(
        "edit", help="Move, resize and group a board's cards in one checked edit",
        description=("The ops Moodboard Studio sends when the person drags a card (contract 07, section 1.12): "
                     "they land together or not at all, an open Studio shows them at once, and each edit "
                     "prints how to undo it. A CARD is an image's number or id (when it has one card), a card "
                     "id from `show --json`, or 12@<look>. Coordinates are board pixels, the card's top-left."))
    edit_p.add_argument("board", help=board_help)
    edit_p.add_argument("--place", action="append", default=[], metavar="CARD=X,Y",
                        help="Move a card, e.g. --place 12=200,40 (repeatable)")
    edit_p.add_argument("--resize", action="append", default=[], metavar="CARD=SIZE",
                        help="Resize a card to a weight (0.05 to 1) or WxH, keeping its aspect; the image "
                             "weighs its largest card, e.g. --resize 12=0.6 (repeatable)")
    edit_p.add_argument("--in", dest="into", action="append", default=[], metavar="CARD=LOOK",
                        help="Put a card in a look (a frame), by its id or name; a card in another look "
                             "moves there, e.g. --in 12=Dither (repeatable)")
    edit_p.add_argument("--link", action="append", default=[], metavar="IMAGE=LOOK",
                        help="Add a copy of an image to another look, e.g. --link 12=Glass (repeatable)")
    edit_p.add_argument("--set-aside", dest="set_aside", action="append", default=[], metavar="IMAGE",
                        help="Set an image aside: still read for its colours, never steers (repeatable)")
    edit_p.add_argument("--use", action="append", default=[], metavar="IMAGE",
                        help="Use a set-aside image again (repeatable)")
    edit_p.add_argument("--note", action="append", default=[], metavar="IMAGE=TEXT",
                        help="An image's note, which steers (repeatable)")
    edit_p.add_argument("--private-note", dest="private_note", action="append", default=[], metavar="IMAGE=TEXT",
                        help="The person's own label for an image; never sent anywhere (repeatable)")
    edit_p.add_argument("--ops", metavar="FILE",
                        help="More ops as JSON (a list, or {\"ops\": [...]}), from a file or - for stdin; "
                             "they go before the flags' ops")
    edit_p.add_argument("--undo", metavar="FILE",
                        help="Undo an edit: what `edit --json` (or `add --json`) printed, or its `undo`, as a "
                             "file or - for stdin. What someone changed since is left as they set it, and said")
    edit_p.add_argument("--base-version", dest="base_version", type=int, metavar="N",
                        help="Refuse the edit if the board was saved since version N (`show --json` gives it)")
    edit_p.add_argument("--say", metavar="TEXT",
                        help="What you did, in your words, for the person's Agent log (up to 140 characters)")
    edit_p.add_argument("--json", action="store_true", help="Print JSON (the board with its cards, applied, undo)")

    analyze_p = msub.add_parser(
        "analyze", help="Analyze a board (palette, accents, brief)",
        description=("--dry-run shows what analyzing would give and what would change, saving nothing. "
                     "With it, the threshold flags try other colour settings for that run only."))
    analyze_p.add_argument("board", help=board_help)
    analyze_p.add_argument("--dry-run", dest="dry_run", action="store_true",
                           help="Show the analysis, the brief and what would change; save nothing")
    analyze_p.add_argument("--accent-min-chroma", dest="accent_min_chroma", type=float, metavar="N",
                           help="How saturated an accent must be, CIELAB chroma 0 to 150 (default 40; dry run only)")
    analyze_p.add_argument("--accent-separation", dest="accent_separation", type=float, metavar="N",
                           help="How far an accent must sit from the main colours, dE00 0 to 100 "
                                "(default 10; dry run only)")
    analyze_p.add_argument("--merge-delta-e", dest="merge_delta_e", type=float, metavar="N",
                           help="Colours closer than this merge, dE00 0 to 50 (default 5; dry run only)")
    analyze_p.add_argument("--json", action="store_true", help="Print JSON")

    move_p = msub.add_parser(
        "move", help="Move a board to Global or to a canvas project",
        description=("Global boards show in every project's Global tab; a project's boards in its Project tab. "
                     "Only where it's listed changes: nodes that use the board keep working in every project, "
                     "and its settings, brief and analysis stay. Moving it back undoes it."))
    move_p.add_argument("board", help=board_help)
    move_p.add_argument("--to", required=True, metavar="WHERE",
                        help="global, current (the project open on the canvas), or a project's id or exact "
                             "name from `nebula projects`")
    move_p.add_argument("--json", action="store_true", help="Print JSON")

    delete_p = msub.add_parser(
        "delete", help="Delete a board (it goes to Recently deleted where Nebula has it)",
        description=("The board goes to Recently deleted, and `nebula trash restore moodboard <id>` brings it "
                     "back. On a Nebula without Recently deleted a delete would be for good, so this refuses: "
                     "delete the board in Moodboard Studio instead."))
    delete_p.add_argument("board", help=board_help)
