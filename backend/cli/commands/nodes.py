from __future__ import annotations

from services import node_categories

from ..client import NebulaClient
from ..formatter import format_node_detail, format_node_table
from ..parser import START_LINE


def run_list(client: NebulaClient, query: str | None = None, category: str | None = None) -> None:
    """`nebula nodes [WORD ...] [--category C]`: every word must be in the id
    or name; the category is an id (image-gen) or its short name (image)."""
    data = client.get_nodes()
    nodes = data["nodes"]
    print(START_LINE)

    known = sorted({str(n.get("category")) for n in nodes if n.get("category")})
    if category:
        wanted = node_categories.resolve(category, known) or category
        nodes = [n for n in nodes if n.get("category") == wanted]

    words = [word for word in (query or "").lower().split() if word]
    if words:
        nodes = [
            n for n in nodes
            if all(word in f"{n['id']} {n.get('displayName', '')}".lower() for word in words)
        ]

    if not nodes:
        asked = " ".join(part for part in (query or "", f"--category {category}" if category else "") if part)
        print(f"No nodes match {asked or 'that'}. Categories: "
              + ", ".join(f"{cat} ({node_categories.label(cat)})" if node_categories.label(cat) != cat else cat
                          for cat in node_categories.ordered(known)))
        return

    print(format_node_table(nodes))


def run_info(client: NebulaClient, node_id: str) -> None:
    node = client.get_node(node_id)
    print(START_LINE)
    print(format_node_detail(node))
