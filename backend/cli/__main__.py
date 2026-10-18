from __future__ import annotations

import argparse
import os
import sys
from contextlib import nullcontext
from pathlib import Path

from .client import NebulaClient


def build_parser() -> argparse.ArgumentParser:
    parser = argparse.ArgumentParser(
        prog="nebula",
        description="Nebula Nodes CLI — build and run media generation pipelines",
    )
    parser.add_argument("--url", default=None,
                        help="Backend URL (default: $NEBULA_URL, else the address in $NEBULA_URL_FILE, "
                             "else http://localhost:8000)")
    sub = parser.add_subparsers(dest="command")

    # -- Discovery --
    sub.add_parser("context", help="Compact summary of available nodes and keys")

    nodes_p = sub.add_parser("nodes", help="List node definitions")
    nodes_p.add_argument("--filter", dest="query", help="Filter nodes by name")
    nodes_p.add_argument("--category", help="Filter by category")

    info_p = sub.add_parser("info", help="Show full detail for a node")
    info_p.add_argument("node_id", help="Node definition ID")

    sub.add_parser("keys", help="Show configured API keys")

    # -- Graph --
    create_p = sub.add_parser("create", help="Create a node in the graph")
    create_p.add_argument("node_id", help="Node definition ID")
    # action='append' + nargs='*' lets the user combine styles:
    #   --param a=1 --param b=2 --param c=3       (one k=v per flag, repeated)
    #   --param a=1 b=2 c=3                       (multiple k=v per flag, single use)
    # We flatten the list-of-lists downstream. With bare nargs='*' alone, each
    # subsequent --param OVERWROTE the previous one — so only the last k=v made
    # it through. That silently dropped model= and aspect_ratio= when callers
    # followed the documented `--param k=v --param k=v` style.
    create_p.add_argument("--param", action="append", nargs="*", default=[], metavar="key=value",
                          help="Set params (repeat flag or pass multiple k=v per flag)")

    connect_p = sub.add_parser("connect", help="Connect two ports")
    connect_p.add_argument("src", help="Source (e.g. n1:image)")
    connect_p.add_argument("dst", help="Destination (e.g. n2:image)")

    set_p = sub.add_parser("set", help="Update params on a node")
    set_p.add_argument("node_ref", help="Node reference (e.g. n1)")
    set_p.add_argument("params", nargs="+", metavar="key=value",
                       help="Params to set (e.g. aspect_ratio=9:16)")

    delete_p = sub.add_parser("delete", help="Delete nodes and their wires")
    delete_p.add_argument("node_refs", nargs="+", metavar="node", help="Node references (e.g. n3)")

    disconnect_p = sub.add_parser("disconnect", help="Remove a wire")
    disconnect_p.add_argument("src", help="Source (e.g. n1:image)")
    disconnect_p.add_argument("dst", help="Destination (e.g. n2:image)")

    rename_p = sub.add_parser("rename", help="Rename a node on the canvas (empty name restores the model's)")
    rename_p.add_argument("node_ref", help="Node reference (e.g. n2)")
    rename_p.add_argument("label", nargs="*", help="New name")

    move_p = sub.add_parser("move", help="Move nodes on the canvas")
    move_p.add_argument("moves", nargs="+", metavar="node=x,y",
                        help="Where to put each node, in canvas coordinates (e.g. n2=400,120)")

    sub.add_parser("projects", help="List saved projects")
    project_p = sub.add_parser("project", help="Open a saved project on the canvas")
    project_sub = project_p.add_subparsers(dest="project_command", required=True)
    project_open_p = project_sub.add_parser("open", help="Switch the canvas to a saved project")
    project_open_p.add_argument("project_id", help="Project id (from `nebula projects`)")

    sub.add_parser("graph", help="Show current graph state")
    sub.add_parser("selection", help="Show nodes currently selected on the canvas")

    look_p = sub.add_parser("look", help="Read the canvas as data: what's on screen, states, wires, agent cursors")
    look_p.add_argument("--json", action="store_true", help="Print the raw snapshot JSON")

    point_p = sub.add_parser("point", help="Move your cursor on the canvas so the user sees where you are working")
    point_p.add_argument("target", help="Node (n2), port (n2.prompt) or flow coordinates (120,-40)")
    point_p.add_argument("--say", default="", help="Short line shown next to your cursor")
    point_p.add_argument("--from", dest="origin", help="Start of a drag gesture (same forms as target)")
    point_p.add_argument("--action", choices=["move", "click", "drag", "look"], default=None,
                         help="Gesture to show (default: move, or drag with --from)")
    point_p.add_argument("--as", dest="agent_name",
                         help="Cursor name (default: $NEBULA_AGENT_NAME; in-app agents are named automatically)")

    watch_p = sub.add_parser("watch", help="Wait for canvas changes and print what changed and who did it")
    watch_p.add_argument("--once", action="store_true",
                         help="Block until the next batch of changes, print it, and exit")
    watch_p.add_argument("--timeout", type=float, default=None,
                         help="Give up after this many seconds (default: 600 with --once, none otherwise)")
    watch_p.add_argument("--json", action="store_true",
                         help="JSON Lines (one event per line); with --once, the whole response")
    watch_p.add_argument("--since", type=int, default=None,
                         help="Start after this event cursor (from `nebula look` or a previous watch)")
    watch_p.add_argument("--journal", default=None, help="Journal id the --since cursor belongs to")
    watch_p.add_argument("--kinds", default=None,
                         help="Only these kinds, e.g. node,pin,proposal or node.params")
    watch_p.add_argument("--include-self", dest="include_self", action="store_true",
                         help="Also show changes you made yourself")
    watch_p.add_argument("--as", dest="agent_name",
                         help="Your agent name, used to skip your own changes (default: $NEBULA_AGENT_NAME)")

    sub.add_parser("pins", help="List the notes the person pinned on the canvas for agents")

    pin_p = sub.add_parser("pin", help="Answer a note the person pinned for agents")
    pin_sub = pin_p.add_subparsers(dest="pin_cmd", required=True)
    resolve_p = pin_sub.add_parser("resolve", help="Reply in one line and mark the note done")
    resolve_p.add_argument("pin_id", help="Pin id from `nebula look` or `nebula pins` (e.g. pin_8c41d2aa)")
    resolve_p.add_argument("--say", required=True, help="Your one-line reply (280 characters max)")
    resolve_p.add_argument("--as", dest="agent_name",
                           help="Your agent name (default: $NEBULA_AGENT_NAME; in-app agents are named automatically)")

    propose_p = sub.add_parser(
        "propose",
        help="Propose a change for the person to accept or reject on the canvas (use before paid runs)",
        description=(
            "Builder: nebula propose --note \"Widen the take and upscale it\" --add +up=topaz-image-upscale "
            "--param +up.upscale_factor=2 --wire n4:image +up:image --set n4.aspect_ratio=16:9 --run +up "
            "--wait --timeout 100. "
            "New nodes use refs like +up; existing nodes use their ids (n4). Or pass --file plan.json "
            "with {note, nodes, edges, params, run}."
        ),
    )
    propose_p.add_argument("--file", help="JSON file with {note, nodes, edges, params, run}")
    propose_p.add_argument("--note", help="One line the person reads (160 characters max)")
    propose_p.add_argument("--add", action="append", default=[], metavar="+ref=definitionId",
                           help="A new node, e.g. --add +up=topaz-image-upscale (repeatable)")
    propose_p.add_argument("--param", action="append", nargs="*", default=[], metavar="+ref.key=value",
                           help="A param on a new node, e.g. --param +up.upscale_factor=2 (repeatable)")
    propose_p.add_argument("--set", dest="set_params", action="append", default=[], metavar="nX.key=value",
                           help="Change a param on an existing node, e.g. --set n4.aspect_ratio=16:9 (repeatable)")
    propose_p.add_argument("--wire", action="append", nargs=2, default=[], metavar=("SRC:port", "DST:port"),
                           help="A wire, e.g. --wire n4:image +up:image (repeatable)")
    propose_p.add_argument("--run", action="append", default=[], metavar="REF",
                           help="Run this node after the person accepts (repeatable)")
    propose_p.add_argument("--at", action="append", default=[], metavar="+ref=x,y",
                           help="Where a new node goes, e.g. --at +up=820,140")
    propose_p.add_argument("--wait", action="store_true", help="Wait for the person to accept or reject")
    propose_p.add_argument("--timeout", type=float, default=600.0, help="With --wait, give up after this many seconds")
    propose_p.add_argument("--json", action="store_true", help="Print the raw proposal JSON")
    propose_p.add_argument("--as", dest="agent_name",
                           help="Your agent name (default: $NEBULA_AGENT_NAME; in-app agents are named automatically)")

    apply_p = sub.add_parser(
        "apply",
        help="Edit the canvas directly in one step, all or nothing (never runs anything)",
        description=(
            "Builder: nebula apply --add +p=text-input --param +p.value=\"a lighthouse\" "
            "--add +img=nano-banana --wire +p:text +img:prompt --rename +img=\"Hero shot\" "
            "--move n3=400,120 --remove n7 --unwire n1:text n2:prompt. "
            "New nodes use refs like +img; existing nodes use their ids (n4). Or pass --file plan.json "
            "(- reads standard input) with {note, nodes, edges, params, rename, move, remove, unwire}: "
            "the plan `nebula propose` takes, without run. If any part is refused, nothing changes. "
            "It prints each new node's id; run them with `nebula run` after."
        ),
    )
    apply_p.add_argument("--file", help="JSON plan file, or - for standard input")
    apply_p.add_argument("--note", help="One line saying what this does (shown with your cursor)")
    apply_p.add_argument("--add", action="append", default=[], metavar="+ref=definitionId",
                         help="A new node, e.g. --add +img=nano-banana (repeatable)")
    apply_p.add_argument("--param", action="append", nargs="*", default=[], metavar="+ref.key=value",
                         help="A param on a new node, e.g. --param +img.aspect_ratio=16:9 (repeatable)")
    apply_p.add_argument("--set", dest="set_params", action="append", default=[], metavar="nX.key=value",
                         help="Change a param on an existing node, e.g. --set n4.prompt=warmer (repeatable)")
    apply_p.add_argument("--wire", action="append", nargs=2, default=[], metavar=("SRC:port", "DST:port"),
                         help="A wire, e.g. --wire +p:text +img:prompt (repeatable)")
    apply_p.add_argument("--at", action="append", default=[], metavar="+ref=x,y",
                         help="Where a new node goes, e.g. --at +img=820,140")
    apply_p.add_argument("--rename", action="append", default=[], metavar="REF=name",
                         help="Name a node, e.g. --rename n4=\"Hero shot\" (empty restores the model's name)")
    apply_p.add_argument("--move", action="append", default=[], metavar="REF=x,y",
                         help="Move a node, e.g. --move n4=400,120 (repeatable)")
    apply_p.add_argument("--remove", action="append", default=[], metavar="nX",
                         help="Delete a node and its wires (repeatable)")
    apply_p.add_argument("--unwire", action="append", nargs=2, default=[], metavar=("SRC:port", "DST:port"),
                         help="Remove a wire, e.g. --unwire n1:text n2:prompt (repeatable)")
    apply_p.add_argument("--json", action="store_true", help="Print the raw result JSON")
    apply_p.add_argument("--as", dest="agent_name",
                         help="Your agent name (default: $NEBULA_AGENT_NAME; in-app agents are named automatically)")

    proposal_p = sub.add_parser("proposal", help="Check (or withdraw) one of your proposals")
    proposal_p.add_argument("id_or_action", help="A proposal id (p_9a1c3e02), or 'withdraw'")
    proposal_p.add_argument("proposal_id", nargs="?", help="With 'withdraw': the proposal id")
    proposal_p.add_argument("--wait", action="store_true", help="Wait for the person to accept or reject")
    proposal_p.add_argument("--timeout", type=float, default=600.0, help="With --wait, give up after this many seconds")
    proposal_p.add_argument("--json", action="store_true", help="Print the raw proposal JSON")
    proposal_p.add_argument("--as", dest="agent_name", help="Your agent name (needed to withdraw)")

    sub.add_parser("proposals", help="List proposals waiting for the person")

    save_p = sub.add_parser("save", help="Save graph to file")
    save_p.add_argument("file", help="Output file path (JSON)")

    load_p = sub.add_parser("load", help="Load graph from file")
    load_p.add_argument("file", help="Input file path (JSON)")

    sub.add_parser("clear", help="Clear the current graph")

    path_p = sub.add_parser("path", help="Print local file path of a node's primary image")
    path_p.add_argument("node_ref", help="Node reference (e.g. n1)")

    # -- Execution --
    wait_help = ("Seconds to wait before returning 'still running' (default 100). "
                 "The run keeps going either way; exit code 2 means it was still running.")
    run_p = sub.add_parser("run", help="Execute a node and its dependencies")
    run_p.add_argument("node_ref", help="Node reference (e.g. n2)")
    run_p.add_argument("--wait", type=float, default=100.0, help=wait_help)

    run_all_p = sub.add_parser("run-all", help="Execute the entire graph")
    run_all_p.add_argument("--wait", type=float, default=100.0, help=wait_help)

    result_p = sub.add_parser("result", help="Results of a run that was still running")
    result_p.add_argument("run_id", help="Run id (printed by `nebula run`)")
    result_p.add_argument("--wait", type=float, default=0.0,
                          help="Wait up to this many seconds for it to finish (max 300)")

    cancel_p = sub.add_parser("cancel", help="Stop a run")
    cancel_p.add_argument("run_id", help="Run id (printed by `nebula run`)")

    sub.add_parser("spend", help="Show the spending limits agents work under, and what this session used")

    sub.add_parser("status", help="Show execution state of graph nodes")

    # -- Quick --
    quick_p = sub.add_parser("quick", help="One-shot: create, execute, output")
    quick_p.add_argument("node_id", help="Node definition ID")
    quick_p.add_argument("--input", action="append", nargs="*", default=[], metavar="key=value",
                         help="Input values (e.g. --input prompt='a cat')")
    quick_p.add_argument("--param", action="append", nargs="*", default=[], metavar="key=value",
                         help="Params (e.g. --param aspect_ratio=9:16)")

    # -- Commons --
    commons_p = sub.add_parser("commons", help="Search, read, add to and borrow from the commons")
    csub = commons_p.add_subparsers(dest="commons_cmd", required=True)
    s = csub.add_parser("search", help="Search analyzed references")
    s.add_argument("query", nargs="?", default="")
    s.add_argument("--brand")
    s.add_argument("--filters", help="JSON object of filters")
    s.add_argument("--limit", type=int, default=10)
    g = csub.add_parser("get", help="Read one reference")
    g.add_argument("id")
    g.add_argument("--fields", help="Comma-separated field names")
    g.add_argument("--brand")
    f = csub.add_parser("fetch", help="Download reference pixels into the turn workdir")
    f.add_argument("id")
    f.add_argument("--out", help="Destination directory (default: current workdir)")
    f.add_argument("--brand")
    a = csub.add_parser("add", help="Add a reference to a collection's inbox")
    a.add_argument("source", help="A URL or local file path")
    a.add_argument("--collection", required=True)
    a.add_argument("--why", required=True)
    a.add_argument("--made-by", dest="made_by", default="unknown", choices=["human", "ai", "unknown"])
    c = csub.add_parser("comment", help="Comment on a reference")
    c.add_argument("id")
    c.add_argument("text")
    c.add_argument("--region")
    c.add_argument("--brand")
    b = csub.add_parser("borrow", help="Record an attribute borrowed from a reference")
    b.add_argument("id")
    b.add_argument("--attribute", required=True)
    b.add_argument("--value", required=True)
    b.add_argument("--used-in", dest="used_in", required=True, help='JSON, e.g. {"kind":"external","ref":"..."}')
    b.add_argument("--why", required=True)
    b.add_argument("--region")
    b.add_argument("--brand")
    csub.add_parser("status", help="Worker, meter and queue status")

    # -- Moodboards --
    from .commands import moodboard as moodboard_cmd
    moodboard_cmd.add_parser(sub)

    # -- Outside apps --
    from .commands import skill as skill_cmd
    skill_cmd.add_parser(sub)

    mcp_p = sub.add_parser("mcp", help="Connect an outside agent app (Hermes, Claude Code, Codex...) to Nebula's MCP server")
    mcp_sub = mcp_p.add_subparsers(dest="mcp_cmd", required=True)
    from services.agent_connect import CLIENTS

    mcp_connect_p = mcp_sub.add_parser(
        "connect", help="Add Nebula's MCP server to an app, with a token made in Settings > Connect your agent",
        description=("The token comes from Settings > Connect your agent, which saves it to a private file and "
                     "shows this command with --token-file: only the Nebula canvas you opened from the launch link "
                     "can make one. The config names that file, never the token."))
    mcp_connect_p.add_argument("client", choices=list(CLIENTS))
    mcp_connect_p.add_argument("--token-file", dest="token_file", default=None,
                               help="The token file Settings shows (default: $NEBULA_APP_TOKEN_FILE)")
    mcp_connect_p.add_argument("--paste-token", dest="paste_token", action="store_true",
                               help="Paste a token made before token files at a hidden prompt (or set "
                                    "$NEBULA_APP_TOKEN); the config then holds the token itself")
    mcp_connect_p.add_argument("--name", help="The name you gave the app in Settings (checked against the token)")
    mcp_connect_p.add_argument("--daily-usd", dest="daily_usd", type=float, default=None,
                               help="The daily limit you set in Settings (used in the steps when there's no token yet)")
    mcp_connect_p.add_argument("--print", dest="print_only", action="store_true",
                               help="Only print the config; change nothing")
    mcp_connect_p.add_argument("--yes", action="store_true", help="Apply without asking")
    mcp_disconnect_p = mcp_sub.add_parser("disconnect", help="Remove Nebula's MCP server from an app")
    mcp_disconnect_p.add_argument("client", choices=list(CLIENTS))
    mcp_disconnect_p.add_argument("--yes", action="store_true", help="Apply without asking")

    return parser


def _flatten(items: list) -> list[str]:
    """Flatten the list-of-lists argparse produces with action='append' nargs='*'."""
    out: list[str] = []
    for item in items:
        if isinstance(item, list):
            out.extend(item)
        else:
            out.append(item)
    return out


def parse_kv_list(items: list) -> dict[str, str]:
    """Parse ['key=value', ...] into a dict. Accepts list-of-lists from argparse."""
    result: dict[str, str] = {}
    for item in _flatten(items):
        if "=" not in item:
            print(f"error: invalid key=value pair: {item}", file=sys.stderr)
            sys.exit(1)
        key, _, value = item.partition("=")
        result[key] = value
    return result


def default_url(environ: dict[str, str] | None = None, *, strict: bool = True) -> str | None:
    """$NEBULA_URL; else the address the desktop app wrote to $NEBULA_URL_FILE
    (its port changes every launch; services/backend_address.py), once the
    backend there proves it wrote the file; else :8000.

    When that check fails, exit 1, or with ``strict=False`` warn and return
    None: `nebula mcp connect` can still print a config that names the file."""
    env = os.environ if environ is None else environ
    url = env.get("NEBULA_URL", "").strip()
    if url:
        return url
    url_file = env.get("NEBULA_URL_FILE", "").strip()
    if url_file:
        from services import backend_address

        try:
            return backend_address.verified_url(url_file)
        except ValueError as exc:
            if not strict:
                print(f"warning: {exc}", file=sys.stderr)
                return None
            print(f"error: {exc}", file=sys.stderr)
            sys.exit(1)
    return "http://localhost:8000"


def main() -> None:
    parser = build_parser()
    args = parser.parse_args()
    if args.command == "skill":
        # Installs files on this machine; needs no backend.
        from .commands import skill

        sys.exit(skill.run_install(args))
    if args.url is None and args.command:
        # mcp connect sends the token only to an address that passed the check.
        args.url = default_url(strict=args.command != "mcp")

    if not args.command:
        parser.print_help()
        sys.exit(0)

    if args.command == "mcp":
        # Edits this machine's app configs; never acts as an agent's session.
        from .commands import mcp_connect

        run = mcp_connect.run_connect if args.mcp_cmd == "connect" else mcp_connect.run_disconnect
        sys.exit(run(args))

    client = NebulaClient(args.url)

    from .commands import (
        apply, canvas, commons, context, nodes, keys, graph, execute, moodboard, quick, path, pins, projects,
        proposals, selection, spend,
    )

    dispatch = {
        "commons": lambda: commons.run(client, args),
        "moodboard": lambda: moodboard.run(client, args),
        "context": lambda: context.run(client),
        "nodes": lambda: nodes.run_list(client, query=args.query, category=args.category),
        "info": lambda: nodes.run_info(client, args.node_id),
        "keys": lambda: keys.run(client),
        "create": lambda: graph.run_create(client, args.node_id, parse_kv_list(args.param)),
        "connect": lambda: graph.run_connect(client, args.src, args.dst),
        "set": lambda: graph.run_set(client, args.node_ref, parse_kv_list(args.params)),
        "delete": lambda: graph.run_delete(client, args.node_refs),
        "disconnect": lambda: graph.run_disconnect(client, args.src, args.dst),
        "rename": lambda: graph.run_rename(client, args.node_ref, " ".join(args.label)),
        "move": lambda: graph.run_move(client, args.moves),
        "projects": lambda: projects.run_list(client),
        "project": lambda: projects.run_open(client, args.project_id),
        "graph": lambda: graph.run_show(client),
        "selection": lambda: selection.run(client),
        "look": lambda: canvas.run_look(client, as_json=args.json),
        "point": lambda: canvas.run_point(client, args.target, say=args.say, origin=args.origin,
                                          action=args.action, agent_name=args.agent_name),
        "watch": lambda: canvas.run_watch(
            client, once=args.once, timeout=args.timeout, as_json=args.json, since=args.since,
            journal=args.journal, kinds=args.kinds, include_self=args.include_self,
            agent_name=args.agent_name,
        ),
        "pins": lambda: pins.run_list(client),
        "pin": lambda: pins.run_pin(client, args),
        "propose": lambda: proposals.run_propose(client, args),
        "apply": lambda: apply.run_apply(client, args),
        "proposal": lambda: proposals.run_proposal(client, args),
        "proposals": lambda: proposals.run_list(client),
        "save": lambda: graph.run_save(client, args.file),
        "load": lambda: graph.run_load(client, args.file),
        "clear": lambda: graph.run_clear(client),
        "path": lambda: path.run(client, args.node_ref),
        "run": lambda: execute.run_node(client, args.node_ref, wait=args.wait),
        "run-all": lambda: execute.run_all(client, wait=args.wait),
        "result": lambda: execute.run_result(client, args.run_id, wait=args.wait),
        "cancel": lambda: execute.run_cancel(client, args.run_id),
        "spend": lambda: spend.run(client),
        "status": lambda: execute.run_status(client),
        "quick": lambda: quick.run(client, args.node_id,
                                   parse_kv_list(args.input), parse_kv_list(args.param)),
    }

    handler = dispatch.get(args.command)
    if handler:
        scope = nullcontext()
        if os.environ.get("NEBULA_AGENT_TOKEN"):
            # The backend registry is authoritative; caller-controlled directory
            # environment variables never select an agent's workspace.
            context = client.get_agent_context()
            workspace = context.get("workspace") if isinstance(context, dict) else None
            if not isinstance(workspace, str) or not workspace or not Path(workspace).is_absolute():
                print("error: backend did not return a valid agent workspace", file=sys.stderr)
                sys.exit(1)
            from services.agent_workspaces import workspace_scope
            scope = workspace_scope(Path(workspace))
        with scope:
            code = handler()
        # Handlers that return an exit code (watch, proposals) end the process with it.
        if isinstance(code, int) and not isinstance(code, bool) and code:
            sys.exit(code)
    else:
        parser.print_help()


if __name__ == "__main__":
    main()
