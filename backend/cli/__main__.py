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
    parser.add_argument("--url", default=os.environ.get("NEBULA_URL", "http://localhost:8000"),
                        help="Backend URL (default: $NEBULA_URL or http://localhost:8000)")
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

    sub.add_parser("graph", help="Show current graph state")
    sub.add_parser("selection", help="Show nodes currently selected on the canvas")

    save_p = sub.add_parser("save", help="Save graph to file")
    save_p.add_argument("file", help="Output file path (JSON)")

    load_p = sub.add_parser("load", help="Load graph from file")
    load_p.add_argument("file", help="Input file path (JSON)")

    sub.add_parser("clear", help="Clear the current graph")

    path_p = sub.add_parser("path", help="Print local file path of a node's primary image")
    path_p.add_argument("node_ref", help="Node reference (e.g. n1)")

    # -- Execution --
    run_p = sub.add_parser("run", help="Execute a node and its dependencies")
    run_p.add_argument("node_ref", help="Node reference (e.g. n2)")

    sub.add_parser("run-all", help="Execute the entire graph")

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


def main() -> None:
    parser = build_parser()
    args = parser.parse_args()

    if not args.command:
        parser.print_help()
        sys.exit(0)

    client = NebulaClient(args.url)

    from .commands import commons, context, nodes, keys, graph, execute, quick, path, selection

    dispatch = {
        "commons": lambda: commons.run(client, args),
        "context": lambda: context.run(client),
        "nodes": lambda: nodes.run_list(client, query=args.query, category=args.category),
        "info": lambda: nodes.run_info(client, args.node_id),
        "keys": lambda: keys.run(client),
        "create": lambda: graph.run_create(client, args.node_id, parse_kv_list(args.param)),
        "connect": lambda: graph.run_connect(client, args.src, args.dst),
        "set": lambda: graph.run_set(client, args.node_ref, parse_kv_list(args.params)),
        "graph": lambda: graph.run_show(client),
        "selection": lambda: selection.run(client),
        "save": lambda: graph.run_save(client, args.file),
        "load": lambda: graph.run_load(client, args.file),
        "clear": lambda: graph.run_clear(client),
        "path": lambda: path.run(client, args.node_ref),
        "run": lambda: execute.run_node(client, args.node_ref),
        "run-all": lambda: execute.run_all(client),
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
            handler()
    else:
        parser.print_help()


if __name__ == "__main__":
    main()
