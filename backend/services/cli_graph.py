from __future__ import annotations

import json
import copy
import math
import os
from pathlib import Path
from typing import Any
from uuid import uuid4


class CLIGraph:
    """In-memory graph state for CLI operations.

    Nodes use short sequential IDs (n1, n2, ...) for easy terminal reference.
    The graph has no dependency on the node registry — it is pure data and
    stores definition IDs, params, and edges. It can export to the format
    expected by the existing execution engine via to_execute_format().

    Optional persistence: pass *persist_path* to persist state to disk on every
    mutation. If the write fails (missing parent dir, permission denied, etc.)
    the in-memory mutation still succeeds — persistence is best-effort, never
    authoritative. Load the persisted state at boot via `load(persist_path)`.
    """

    def __init__(self, persist_path: Path | None = None) -> None:
        self.nodes: dict[str, dict[str, Any]] = {}
        self.edges: list[dict[str, str]] = []
        self._counter: int = 0
        self._persist_path: Path | None = persist_path

    def _maybe_persist(self) -> None:
        """Best-effort save — swallow errors so a hostile filesystem never
        breaks an otherwise-valid mutation. Errors get surfaced via print so
        server operators can diagnose, but the API call succeeds regardless."""
        if self._persist_path is None:
            return
        try:
            self.save(self._persist_path)
        except Exception as exc:
            print(f"[cli_graph] persist failed: {exc}", flush=True)

    # ------------------------------------------------------------------
    # Mutation

    def add_node(
        self,
        definition_id: str,
        params: dict[str, Any],
        position: dict[str, float] | None = None,
        outputs: dict[str, Any] | None = None,
    ) -> str:
        """Add a node and return its short sequential ID (e.g. 'n1').

        *position* and *outputs* are optional carry-ins used by the /api/graph/import
        path so loaded graphs preserve their layout and any previously-generated
        results. Nodes created through `nebula create` omit both and get
        auto-laid-out by the export function.
        """
        self._counter += 1
        short_id = f"n{self._counter}"
        node: dict[str, Any] = {
            "id": short_id,
            "definitionId": definition_id,
            "params": dict(params),
            "outputs": dict(outputs) if outputs else {},
        }
        if position is not None:
            x = float(position.get("x", 0))
            y = float(position.get("y", 0))
            if not math.isfinite(x) or not math.isfinite(y):
                raise ValueError("node position requires finite x and y")
            node["position"] = {
                "x": x,
                "y": y,
            }
        self.nodes[short_id] = node
        self._maybe_persist()
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
        self._maybe_persist()
        return edge

    def update_params(self, node_id: str, params: dict[str, Any]) -> None:
        """Merge *params* into the node's existing params dict."""
        if node_id not in self.nodes:
            raise ValueError(f"Node '{node_id}' not found")
        self.nodes[node_id]["params"].update(params)
        self._maybe_persist()

    def update_positions(self, positions: dict[str, dict[str, float]]) -> None:
        """Atomically replace stored positions for existing nodes.

        Callers validate numeric coordinates before this boundary. Unknown
        nodes fail before any mutation so a stale frontend cannot partially
        apply a layout.
        """
        unknown = [node_id for node_id in positions if node_id not in self.nodes]
        if unknown:
            raise ValueError(f"Node '{unknown[0]}' not found")
        for node_id, position in positions.items():
            x = float(position["x"])
            y = float(position["y"])
            if not math.isfinite(x) or not math.isfinite(y):
                raise ValueError("node position requires finite x and y")
            self.nodes[node_id]["position"] = {
                "x": x,
                "y": y,
            }
        self._maybe_persist()

    def remove_node(self, node_id: str) -> None:
        """Remove a node and any edges touching it. Raises if node_id is unknown."""
        if node_id not in self.nodes:
            raise ValueError(f"Node '{node_id}' not found")
        del self.nodes[node_id]
        self.edges = [
            e for e in self.edges if e["source"] != node_id and e["target"] != node_id
        ]
        self._maybe_persist()

    def remove_edge(
        self, source: str, source_handle: str, target: str, target_handle: str
    ) -> bool:
        """Remove the edge matching all four endpoints. Returns True if one was removed."""
        for i, e in enumerate(self.edges):
            if (
                e["source"] == source
                and e["sourceHandle"] == source_handle
                and e["target"] == target
                and e["targetHandle"] == target_handle
            ):
                self.edges.pop(i)
                self._maybe_persist()
                return True
        return False

    def clear(self) -> None:
        """Remove all nodes and edges and reset the ID counter."""
        self.nodes.clear()
        self.edges.clear()
        self._counter = 0
        self._maybe_persist()

    def replace_with(self, candidate: "CLIGraph") -> None:
        """Durably persist, then adopt, a fully validated candidate.

        Building imports/clusters against a persistence-free candidate keeps a
        malformed request from partially mutating either memory or disk. When
        persistence is configured, a failed write propagates before live memory
        changes so an API cannot report a graph that restart would discard.
        """
        replacement_nodes = copy.deepcopy(candidate.nodes)
        replacement_edges = copy.deepcopy(candidate.edges)
        replacement_counter = candidate._counter
        if self._persist_path is not None:
            self._save_state(
                self._persist_path,
                replacement_nodes,
                replacement_edges,
                replacement_counter,
            )
        self.nodes = replacement_nodes
        self.edges = replacement_edges
        self._counter = replacement_counter

    def clone(self) -> "CLIGraph":
        """Return a persistence-free deep copy suitable for staged mutation."""
        candidate = CLIGraph()
        candidate.nodes = copy.deepcopy(self.nodes)
        candidate.edges = copy.deepcopy(self.edges)
        candidate._counter = self._counter
        return candidate

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
        """Atomically persist the graph (including counter) to a JSON file."""
        self._save_state(path, self.nodes, self.edges, self._counter)

    @staticmethod
    def _save_state(
        path: Path,
        nodes: dict[str, dict[str, Any]],
        edges: list[dict[str, str]],
        counter: int,
    ) -> None:
        target = Path(path)
        data = {
            "nodes": list(nodes.values()),
            "edges": list(edges),
            "counter": counter,
        }
        temporary = target.with_name(f".{target.name}.{uuid4().hex}.tmp")
        try:
            with temporary.open("x", encoding="utf-8") as handle:
                json.dump(data, handle, indent=2, allow_nan=False)
                handle.flush()
                os.fsync(handle.fileno())
            temporary.replace(target)
            try:
                directory_fd = os.open(target.parent, os.O_RDONLY | os.O_DIRECTORY)
            except (AttributeError, OSError):
                directory_fd = None
            if directory_fd is not None:
                try:
                    try:
                        os.fsync(directory_fd)
                    except OSError as exc:
                        # The atomic rename already committed the exact state
                        # now adopted in memory. A directory-sync failure lowers
                        # crash-durability, but raising here would falsely leave
                        # memory on the old graph while disk contains the new
                        # one. Surface the durability warning without creating
                        # that split-brain state.
                        print(
                            f"[cli_graph] directory fsync failed after commit: {exc}",
                            flush=True,
                        )
                finally:
                    os.close(directory_fd)
        finally:
            temporary.unlink(missing_ok=True)

    def load(self, path: Path) -> None:
        """Replace current graph state with contents of a JSON file."""
        data = json.loads(Path(path).read_text())
        self.nodes = {n["id"]: n for n in data["nodes"]}
        self.edges = data["edges"]
        self._counter = data.get("counter", len(self.nodes))
