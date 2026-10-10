from __future__ import annotations

import json
import sys

from ..client import NebulaClient
from ..formatter import format_snapshot


def _target(text: str) -> dict:
    text = (text or "").strip()
    if "," in text:
        x, _, y = text.partition(",")
        try:
            return {"x": float(x), "y": float(y)}
        except ValueError:
            print(f"error: '{text}' is not x,y", file=sys.stderr)
            sys.exit(1)
    node_id, dot, handle = text.partition(".")
    if not node_id:
        print("error: target needs a node id, node.port, or x,y", file=sys.stderr)
        sys.exit(1)
    return {"nodeId": node_id, "handle": handle} if dot else {"nodeId": node_id}


def run_look(client: NebulaClient, *, as_json: bool = False) -> None:
    snapshot = client.get_canvas_snapshot()
    print(json.dumps(snapshot, indent=2, ensure_ascii=False) if as_json else format_snapshot(snapshot))


def run_point(
    client: NebulaClient,
    target: str,
    *,
    say: str = "",
    origin: str | None = None,
    action: str | None = None,
    agent_name: str | None = None,
) -> None:
    body: dict = {"target": _target(target), "say": say}
    if origin:
        body["from"] = _target(origin)
    body["action"] = action or ("drag" if origin else "move")
    result = client.point_cursor(body, agent_name=agent_name)
    agent = result.get("agent", {}).get("name", "agent")
    where = target + (f" (from {origin})" if origin else "")
    print(f"{agent} → {where}" + (f": {result.get('say')}" if result.get("say") else ""))
