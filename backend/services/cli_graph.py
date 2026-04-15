from __future__ import annotations

import json
from pathlib import Path
from typing import Any


class CLIGraph:
    """In-memory graph state for CLI operations.

    Nodes use short sequential IDs (n1, n2, ...) for easy terminal reference.
    The graph has no dependency on the node registry — it is pure data and
    stores definition IDs, params, and edges. It can export to the format
    expected by the existing execution engine via to_execute_format().
    """

    def __init__(self) -> None:
        self.nodes: dict[str, dict[str, Any]] = {}
        self.edges: list[dict[str, str]] = []
        self._counter: int = 0

    # ------------------------------------------------------------------
    # Mutation

    def add_node(self, definition_id: str, params: dict[str, Any]) -> str:
        """Add a node and return its short sequential ID (e.g. 'n1')."""
        self._counter += 1
        short_id = f"n{self._counter}"
        self.nodes[short_id] = {
            "id": short_id,
            "definitionId": definition_id,
            "params": dict(params),
            "outputs": {},
        }
        return short_id

    def connect(
        self, src_id: str, src_port: str, dst_id: str, dst_port: str
    ) -> dict[str, str]:
        """Connect two nodes by port. Returns the created edge dict."""
        if src_id not in self.nodes:
            raise ValueError(f"Source node '{src_id}' not found")
        if dst_id not in self.nodes:
            raise ValueError(f"Target node '{dst_id}' not found")

        edge: dict[str, str] = {
            "id": f"e{len(self.edges) + 1}",
            "source": src_id,
            "sourceHandle": src_port,
            "target": dst_id,
            "targetHandle": dst_port,
        }
        self.edges.append(edge)
        return edge

    def update_params(self, node_id: str, params: dict[str, Any]) -> None:
        """Merge *params* into the node's existing params dict."""
        if node_id not in self.nodes:
            raise ValueError(f"Node '{node_id}' not found")
        self.nodes[node_id]["params"].update(params)

    def clear(self) -> None:
        """Remove all nodes and edges and reset the ID counter."""
        self.nodes.clear()
        self.edges.clear()
        self._counter = 0

    # ------------------------------------------------------------------
    # Read / export

    def get_state(self) -> dict[str, Any]:
        """Return a snapshot of the graph as plain dicts."""
        return {
            "nodes": list(self.nodes.values()),
            "edges": list(self.edges),
        }

    def to_execute_format(
        self,
    ) -> tuple[list[dict[str, Any]], list[dict[str, str]]]:
        """Convert to the format expected by execute_graph / ExecuteRequest."""
        nodes = [
            {
                "id": n["id"],
                "definitionId": n["definitionId"],
                "params": n["params"],
                "outputs": {},
            }
            for n in self.nodes.values()
        ]
        edges = [
            {
                "id": e["id"],
                "source": e["source"],
                "sourceHandle": e["sourceHandle"],
                "target": e["target"],
                "targetHandle": e["targetHandle"],
            }
            for e in self.edges
        ]
        return nodes, edges

    # ------------------------------------------------------------------
    # Persistence

    def save(self, path: Path) -> None:
        """Persist the graph (including counter) to a JSON file."""
        data = {
            "nodes": list(self.nodes.values()),
            "edges": list(self.edges),
            "counter": self._counter,
        }
        Path(path).write_text(json.dumps(data, indent=2))

    def load(self, path: Path) -> None:
        """Replace current graph state with contents of a JSON file."""
        data = json.loads(Path(path).read_text())
        self.nodes = {n["id"]: n for n in data["nodes"]}
        self.edges = data["edges"]
        self._counter = data.get("counter", len(self.nodes))
