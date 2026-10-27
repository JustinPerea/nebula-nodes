"""`nebula style list|show|new|set|delete`: Styles (presets), the saved looks
in Create and the Assets panel's Styles tab.

Shaped like `nebula moodboard`, so the two read alike. The work is in
style_client.py, which the MCP's style_* tools share; every command goes
through /api/presets, the routes the app uses. `delete` moves a Style to
Recently deleted (`nebula trash restore style <id>` brings it back);
deleting for good is the person's, in the app.
"""
from __future__ import annotations

import json
import sys
from pathlib import Path
from typing import Any

import moodboard_client as boards
import style_client as styles
from moodboard_client import MoodboardError
from nebula_api import NebulaAPIError
from style_client import StyleError

from ..client import NebulaClient, connect_failure

style_help = "Style id or exact name (`nebula style list`)"


def _fail(message: str) -> None:
    print(f"error: {message}", file=sys.stderr)
    sys.exit(1)


def _print_json(data: Any) -> None:
    print(json.dumps(data, indent=2, ensure_ascii=False))


def _params(raw: str | None) -> dict[str, Any] | None:
    if raw is None:
        return None
    try:
        value = json.loads(raw)
    except json.JSONDecodeError as exc:
        raise StyleError(f"--params must be a JSON object, e.g. '{{\"aspect_ratio\": \"3:4\"}}' ({exc.msg})") from exc
    if not isinstance(value, dict):
        raise StyleError("--params must be a JSON object of setting keys and values")
    return value


def _where(style: dict[str, Any], names: dict[str, tuple[str, bool]]) -> str:
    project = style.get("projectId")
    if not project:
        return "Global"
    name, trashed = names.get(project, (project, False))
    return f"project {name}" + (" (in Recently deleted)" if trashed else "")


def _print_style(style: dict[str, Any], names: dict[str, tuple[str, bool]]) -> None:
    print(f"{style.get('id')}  {style.get('name')}  ({style.get('category')}, {_where(style, names)}, "
          f"version {style.get('version')})")
    print(f"  prompt: {style.get('prompt') or '(none)'}")
    print(f"  model: {style.get('modelId') or '(any: a style-only Style)'}")
    params = style.get("params") or {}
    if params:
        print(f"  settings: {json.dumps(params, ensure_ascii=False)}")
    refs = style.get("refImages") or []
    if refs:
        print(f"  references: {', '.join(str(ref) for ref in refs)}")


def _restore_args(path: str) -> dict[str, Any]:
    text = sys.stdin.read() if path == "-" else Path(path).read_text(encoding="utf-8")
    data = json.loads(text)
    previous = data.get("previous") if isinstance(data, dict) and "previous" in data else data
    if not isinstance(previous, dict):
        raise StyleError("--restore takes the `previous` from `nebula style set --json` (or its whole output)")
    return previous


def run(client: NebulaClient, args) -> None:
    api = client.api
    headers = client._identity_headers()
    verb = args.style_cmd
    try:
        if verb == "list":
            if args.global_only:
                project = None
            elif args.project:
                project = boards.resolve_project(api, args.project, headers)
            else:
                project = boards.active_project(api, headers)
            listing = styles.list_styles(api, project=project, headers=headers)
            if args.json:
                _print_json(listing)
                return
            if not listing:
                print("No Styles yet. `nebula style new \"Name\" --prompt \"...\"` saves one.")
                return
            names = boards.project_names(api, headers) if any(s.get("projectId") for s in listing) else {}
            for style in listing:
                print(f"{style.get('id')}  {style.get('name')}  ({style.get('category')}, "
                      f"{style.get('modelId') or 'any model'}, {_where(style, names)})")
        elif verb == "show":
            style = styles.find_style(api, args.style, headers)
            if args.json:
                _print_json(style)
            else:
                _print_style(style, boards.project_names(api, headers) if style.get("projectId") else {})
        elif verb == "new":
            style = styles.create_style(
                api, args.name, prompt=args.prompt or "", category=args.category or styles.DEFAULT_CATEGORY,
                params=_params(args.params), model_id=args.model, ref_images=args.ref or [],
                project=args.project, headers=headers)
            if args.json:
                _print_json(style)
                return
            print(f"Saved Style {style.get('name')} ({style.get('id')}).")
            print(f"Take it back off: nebula style delete {style.get('id')}")
        elif verb == "set":
            if args.restore:
                changes = _restore_args(args.restore)
                base_version = changes.pop("base_version", None)
            else:
                changes = {"name": args.name, "category": args.category, "prompt": args.prompt,
                           "params": _params(args.params), "model_id": args.model,
                           "ref_images": args.ref if args.ref else None}
                base_version = args.base_version
            result = styles.update_style(api, args.style, base_version=base_version, headers=headers, **changes)
            if args.json:
                _print_json(result)
                return
            style = result["style"]
            changed = ", ".join(key for key in result["previous"] if key != "base_version") or "nothing"
            print(f"Changed {changed} on Style {style.get('name')} ({style.get('id')}), now version "
                  f"{style.get('version')}.")
            if result["previous"]:
                print("Undo it: save `--json` output and run "
                      f"nebula style set {style.get('id')} --restore <file>")
        elif verb == "delete":
            result = styles.delete_style(api, args.style, headers)
            if args.json:
                _print_json(result)
                return
            print(f"Moved Style {result.get('name')} ({result.get('id')}) to Recently deleted.")
            print(f"Bring it back: nebula trash restore style {result.get('id')}")
        else:
            _fail(f"unknown style command {verb}")
    except (StyleError, MoodboardError) as exc:
        _fail(str(exc))
    except (OSError, json.JSONDecodeError) as exc:
        _fail(f"can't read --restore: {exc}")
    except NebulaAPIError as exc:
        if exc.kind == "connect":
            _fail(connect_failure(client.base_url, exc))
        _fail(exc.detail)


def add_parser(sub) -> None:
    """`nebula style ...` on the top-level parser."""
    style_p = sub.add_parser(
        "style", help="Styles (the saved looks in Create and the Assets panel): list, show, new, set, delete",
        description=("A Style is a prompt fragment, optionally with a model and its settings, that Create applies. "
                     "Global Styles show in every project; a project's in its Project tab. Who bills a Style's "
                     "model (_provider, _kreaAuth) is the person's call."))
    ssub = style_p.add_subparsers(dest="style_cmd", required=True)

    list_p = ssub.add_parser("list", help="List Styles: the Global ones, plus the open project's")
    list_p.add_argument("--project", help="A canvas project id (from `nebula projects`) or 'current' "
                                          "instead of the open project")
    list_p.add_argument("--global", dest="global_only", action="store_true", help="Only the Global Styles")
    list_p.add_argument("--json", action="store_true", help="Print JSON")

    show_p = ssub.add_parser("show", help="Show a Style: prompt, model and settings")
    show_p.add_argument("style", help=style_help)
    show_p.add_argument("--json", action="store_true", help="Print JSON")

    new_p = ssub.add_parser("new", help="Save a new Style")
    new_p.add_argument("name", help="Style name")
    new_p.add_argument("--prompt", help="The fragment Create adds to the prompt")
    new_p.add_argument("--category", help=f"Its category in the Styles list (default: {styles.DEFAULT_CATEGORY})")
    new_p.add_argument("--model", metavar="NODE", help="A node id (`nebula nodes`): a Style for that model. "
                                                       "Without it the Style styles any model")
    new_p.add_argument("--params", metavar="JSON", help="The model's settings as a JSON object")
    new_p.add_argument("--ref", action="append", metavar="URL", help="A reference image (a Nebula output URL; "
                                                                      "repeatable)")
    new_p.add_argument("--project", help="Keep it in this canvas project: 'current' or an id from "
                                         "`nebula projects`. Default: Global")
    new_p.add_argument("--json", action="store_true", help="Print JSON")

    set_p = ssub.add_parser("set", help="Change a Style; --json prints `previous`, which --restore puts back")
    set_p.add_argument("style", help=style_help)
    set_p.add_argument("--name", help="Rename it")
    set_p.add_argument("--prompt", help="Its prompt fragment")
    set_p.add_argument("--category", help="Its category")
    set_p.add_argument("--model", metavar="NODE", help='A node id, or "" for a style-only Style')
    set_p.add_argument("--params", metavar="JSON", help="Its settings as a JSON object (replaces them whole)")
    set_p.add_argument("--ref", action="append", metavar="URL", help="Reference images (replace them; repeatable)")
    set_p.add_argument("--base-version", dest="base_version", type=int, metavar="N",
                       help="Only write if the Style is still at this version")
    set_p.add_argument("--restore", metavar="FILE",
                       help="Undo a change: the `previous` from `set --json` (or its whole output), as a file "
                            "or - for stdin. Refused if someone changed the Style since")
    set_p.add_argument("--json", action="store_true", help="Print JSON")

    delete_p = ssub.add_parser("delete", help="Move a Style to Recently deleted (`nebula trash restore` brings it back)")
    delete_p.add_argument("style", help=style_help)
    delete_p.add_argument("--json", action="store_true", help="Print JSON")
