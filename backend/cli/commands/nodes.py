from __future__ import annotations

from ..client import NebulaClient
from ..formatter import format_node_table, format_node_detail


def run_list(client: NebulaClient, query: str | None = None, category: str | None = None) -> None:
    data = client.get_nodes()
    nodes = data["nodes"]

    if category:
        nodes = [n for n in nodes if n.get("category") == category]

    if query:
        q = query.lower()
        nodes = [
            n for n in nodes
            if q in n["id"].lower() or q in n.get("displayName", "").lower()
        ]

    if not nodes:
        print("No matching nodes found.")
        return

    print(format_node_table(nodes))


def run_info(client: NebulaClient, node_id: str) -> None:
    node = client.get_node(node_id)
    print(format_node_detail(node))
