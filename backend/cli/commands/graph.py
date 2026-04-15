from __future__ import annotations

import json
import sys
from pathlib import Path
from typing import Any

from ..client import NebulaClient
from ..formatter import format_graph


def run_create(client: NebulaClient, node_id: str, params: dict[str, Any]) -> None:
    result = client.create_node(node_id, params)
    short_id = result["id"]
    node_def = client.get_node(node_id)
    name = node_def.get("displayName", node_id) if node_def else node_id
    print(f"Created node {short_id} ({name})")


def run_connect(client: NebulaClient, src: str, dst: str) -> None:
    if ":" not in src:
        print(f"error: source must be node:port (e.g. n1:image), got '{src}'", file=sys.stderr)
        sys.exit(1)
    if ":" not in dst:
        print(f"error: destination must be node:port (e.g. n2:image), got '{dst}'", file=sys.stderr)
        sys.exit(1)

    src_node, src_port = src.split(":", 1)
    dst_node, dst_port = dst.split(":", 1)

    result = client.connect(src_node, src_port, dst_node, dst_port)
    print(f"Connected {result['connection']}")


def run_set(client: NebulaClient, node_ref: str, params: dict[str, Any]) -> None:
    client.update_node(node_ref, params)
    params_str = ", ".join(f"{k}={v}" for k, v in params.items())
    print(f"Updated {node_ref}: {params_str}")


def run_show(client: NebulaClient) -> None:
    state = client.get_graph()
    nodes_data = client.get_nodes()
    node_defs = {n["id"]: n for n in nodes_data["nodes"]}
    print(format_graph(state, node_defs))


def run_save(client: NebulaClient, filepath: str) -> None:
    state = client.get_graph()
    path = Path(filepath)
    path.write_text(json.dumps(state, indent=2))
    node_count = len(state.get("nodes", []))
    edge_count = len(state.get("edges", []))
    print(f"Saved graph ({node_count} nodes, {edge_count} connections) to {filepath}")


def run_load(client: NebulaClient, filepath: str) -> None:
    path = Path(filepath)
    if not path.exists():
        print(f"error: file not found: {filepath}", file=sys.stderr)
        sys.exit(1)

    data = json.loads(path.read_text())
    client.clear_graph()

    nodes = data.get("nodes", [])
    edges = data.get("edges", [])

    id_map: dict[str, str] = {}
    for n in nodes:
        result = client.create_node(n["definitionId"], n.get("params", {}))
        id_map[n["id"]] = result["id"]

    for e in edges:
        src = id_map.get(e["source"], e["source"])
        dst = id_map.get(e["target"], e["target"])
        client.connect(src, e["sourceHandle"], dst, e["targetHandle"])

    print(f"Loaded graph ({len(nodes)} nodes, {len(edges)} connections) from {filepath}")


def run_clear(client: NebulaClient) -> None:
    client.clear_graph()
    print("Graph cleared.")
