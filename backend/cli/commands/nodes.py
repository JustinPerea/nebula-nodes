from __future__ import annotations

import json
import shlex

from services import node_categories, node_readiness

from ..client import NebulaClient
from ..formatter import format_agent_nodes, format_billing_line, format_node_detail, format_price_line
from ..parser import START_LINE


def run_list(client: NebulaClient, query: str | None = None, category: str | None = None, *,
             show_all: bool = False, limit: int | None = None, as_json: bool = False) -> None:
    """`nebula nodes [WORD ...] [--category C] [--all] [--limit N] [--json]`:
    MCP find_nodes' twin, on the same route (GET /api/agent/nodes), so the
    ranking, what runs here and the prices come from one place.

    Every word must be in the id, name or description; the category is an id
    (image-gen) or its short name (image). By default only node types that
    run here, each with how (key, free, krea, nous) and its list price at
    default settings, then one line saying how many more need a key; `--all`
    lists those too, each with what it's missing. No limit by default: a
    terminal table is read whole or piped (find_nodes keeps 20 for a tool
    result). `--json` prints the route's answer as find_nodes returns it."""
    query = " ".join((query or "").split())
    category = (category or "").strip()
    if as_json:
        found = client.find_nodes(query, category, ready_only=not show_all, limit=limit)
        print(json.dumps(found, ensure_ascii=False, indent=2))
        return

    found = client.find_nodes(query, category, ready_only=False)
    rows = [row for row in found.get("nodes") or [] if isinstance(row, dict)]
    print(START_LINE)
    if not rows:
        known = sorted({str(n.get("category")) for n in client.get_nodes().get("nodes") or [] if n.get("category")})
        asked = " ".join(part for part in (query, f"--category {category}" if category else "") if part)
        print(f"No nodes match {asked or 'that'}. Categories: "
              + ", ".join(f"{cat} ({node_categories.label(cat)})" if node_categories.label(cat) != cat else cat
                          for cat in node_categories.ordered(known)))
        return

    ready = [row for row in rows if row.get("runsWith")]
    hidden = [row for row in rows if not row.get("runsWith")]
    listed = rows if show_all else ready
    counts: dict[str, tuple[int, int]] = {}
    for row in rows:
        cat = str(row.get("category") or "other")
        here, matched = counts.get(cat, (0, 0))
        counts[cat] = (here + (1 if row.get("runsWith") else 0), matched + 1)
    shown = listed[:limit] if limit is not None else listed
    command = shlex.join(["nebula", "nodes", *query.split(), *(["--category", category] if category else []),
                          "--all"])

    if shown:
        print(("Every matching node type" if show_all else "Node types that run here")
              + ": how each runs (key, free, krea, nous) and its price per run at default settings"
              + (", or what it needs" if show_all else "") + (". Best matches first" if query else "")
              + ". `nebula info <id>` has its ports and params.")
        print()
        print(format_agent_nodes(shown, ranked=bool(query), counts=counts))
    else:
        print(f"Nothing that matches {_asked(query, category)}runs here yet.")
    tail: list[str] = []
    if len(shown) < len(listed):
        tail.append(f"Showing {len(shown)} of {len(listed)}: drop --limit to list them all.")
    if hidden and not show_all:
        tail.append(f"{len(hidden)} {'more ' if ready else ''}{_need(hidden)}: `{command}` lists them "
                    "with what each needs.")
    total = int(found.get("total") or 0)
    if total > len(rows):
        tail.append(f"{total - len(rows)} more match than one call lists: add words or --category.")
    if tail:
        print()
        print("\n".join(tail))


def _asked(query: str, category: str) -> str:
    parts = [f"'{query}'" if query else "", f"--category {category}" if category else ""]
    text = " ".join(part for part in parts if part)
    return f"{text} " if text else ""


def _need(rows: list[dict]) -> str:
    """What the node types left out need, in a few words: "need a key",
    "need a key or a Krea sign-in" (node_readiness.missing's words)."""
    kinds = []
    for row in rows:
        missing = str(row.get("missing") or "")
        kind = ("a Krea sign-in" if missing == node_readiness.KREA_SIGN_IN
                else "other setup" if not missing or missing.startswith("needs setup") else "a key")
        if kind not in kinds:
            kinds.append(kind)
    order = [kind for kind in ("a key", "a Krea sign-in", "other setup") if kind in kinds]
    return ("needs " if len(rows) == 1 else "need ") + (" or ".join(order) if len(order) <= 2 else f"{order[0]}, {order[1]} or {order[2]}")


def run_info(client: NebulaClient, node_id: str) -> None:
    """`nebula info <id or name>`: an id, or a node type's exact display name
    when one node has it; then the first line after the start line says which
    id it used ("moodboard is the Moodboard node: nebula-moodboard")."""
    node = client.get_node(node_id)
    print(START_LINE)
    if isinstance(node.get("lookup"), str):
        print(node["lookup"])
    print(format_node_detail(node))
    try:
        detail = client.get_agent_node(node_id)
        price, billing = format_price_line(detail), format_billing_line(detail)
    except Exception:  # noqa: BLE001 - an older backend has no price to add; the rest stands
        price = billing = None
    if price:
        print(price)
    if billing:
        print(billing)
