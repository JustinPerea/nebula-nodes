from __future__ import annotations

import argparse
import sys

from .client import NebulaClient


def build_parser() -> argparse.ArgumentParser:
    parser = argparse.ArgumentParser(
        prog="nebula",
        description="Nebula Nodes CLI — build and run media generation pipelines",
    )
    parser.add_argument("--url", default="http://localhost:8000",
                        help="Backend URL (default: http://localhost:8000)")
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
    create_p.add_argument("--param", nargs="*", default=[], metavar="key=value",
                          help="Set params (e.g. --param model=v1 size=1024x1024)")

    connect_p = sub.add_parser("connect", help="Connect two ports")
    connect_p.add_argument("src", help="Source (e.g. n1:image)")
    connect_p.add_argument("dst", help="Destination (e.g. n2:image)")

    set_p = sub.add_parser("set", help="Update params on a node")
    set_p.add_argument("node_ref", help="Node reference (e.g. n1)")
    set_p.add_argument("params", nargs="+", metavar="key=value",
                       help="Params to set (e.g. aspectRatio=16:9)")

    sub.add_parser("graph", help="Show current graph state")

    save_p = sub.add_parser("save", help="Save graph to file")
    save_p.add_argument("file", help="Output file path (JSON)")

    load_p = sub.add_parser("load", help="Load graph from file")
    load_p.add_argument("file", help="Input file path (JSON)")

    sub.add_parser("clear", help="Clear the current graph")

    # -- Execution --
    run_p = sub.add_parser("run", help="Execute a node and its dependencies")
    run_p.add_argument("node_ref", help="Node reference (e.g. n2)")

    sub.add_parser("run-all", help="Execute the entire graph")

    sub.add_parser("status", help="Show execution state of graph nodes")

    # -- Quick --
    quick_p = sub.add_parser("quick", help="One-shot: create, execute, output")
    quick_p.add_argument("node_id", help="Node definition ID")
    quick_p.add_argument("--input", nargs="*", default=[], metavar="key=value",
                         help="Input values (e.g. --input prompt='a cat')")
    quick_p.add_argument("--param", nargs="*", default=[], metavar="key=value",
                         help="Params (e.g. --param aspectRatio=16:9)")

    return parser


def parse_kv_list(items: list[str]) -> dict[str, str]:
    """Parse ['key=value', ...] into a dict."""
    result: dict[str, str] = {}
    for item in items:
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

    from .commands import context, nodes, keys, graph, execute, quick

    dispatch = {
        "context": lambda: context.run(client),
        "nodes": lambda: nodes.run_list(client, query=args.query, category=args.category),
        "info": lambda: nodes.run_info(client, args.node_id),
        "keys": lambda: keys.run(client),
        "create": lambda: graph.run_create(client, args.node_id, parse_kv_list(args.param)),
        "connect": lambda: graph.run_connect(client, args.src, args.dst),
        "set": lambda: graph.run_set(client, args.node_ref, parse_kv_list(args.params)),
        "graph": lambda: graph.run_show(client),
        "save": lambda: graph.run_save(client, args.file),
        "load": lambda: graph.run_load(client, args.file),
        "clear": lambda: graph.run_clear(client),
        "run": lambda: execute.run_node(client, args.node_ref),
        "run-all": lambda: execute.run_all(client),
        "status": lambda: execute.run_status(client),
        "quick": lambda: quick.run(client, args.node_id,
                                   parse_kv_list(args.input), parse_kv_list(args.param)),
    }

    handler = dispatch.get(args.command)
    if handler:
        handler()
    else:
        parser.print_help()


if __name__ == "__main__":
    main()
