from __future__ import annotations

import json
import copy
import math
import os
import re
from pathlib import Path
from typing import Any
from uuid import uuid4

from services.cinema_scene_spec import (
    claim_stray_ports,
    normalize_params as normalize_scene_params,
    rekeyed_outputs,
    shot_port_ids,
)
from services.file_access import require_allowed_path, validate_file_references
from services.retired_nodes import migrate_graph, migrate_node
from services.saved_graph_upgrades import PARAMS_VERSION, stored_version, upgrade_flat_nodes


SHORT_ID_RE = re.compile(r"n([0-9]{1,9})")
# How far an explicit id (add_node's node_id) may sit above the counter. The
# counter moves past a restored id, so an unbounded one (n999999999) would
# make every later id too long for SHORT_ID_RE, and undo could never put
# those nodes back. Ids above the counter are legitimate after an import or
# Clear resets it (undoing them brings the old ids back), so this is a
# ceiling, not "no higher than the counter".
MAX_ID_JUMP = 1_000_000


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
        # Nodes whose params ``load`` upgraded (services/saved_graph_upgrades.py),
        # and whether the file was saved before ``PARAMS_VERSION`` (true even
        # when no value changed: main's boot step writes the marker and makes
        # tabs loaded before the restart reload).
        self.upgraded_on_load = 0
        self.params_advanced_on_load = False

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
        node_id: str | None = None,
    ) -> str:
        """Add a node and return its short sequential ID (e.g. 'n1').

        *position* and *outputs* are optional carry-ins used by the /api/graph/import
        path so loaded graphs preserve their layout and any previously-generated
        results. Nodes created through `nebula create` omit both and get
        auto-laid-out by the export function.

        *node_id* puts a removed node back under its old id (undo on the
        canvas, POST /api/graph/restore). It must be a short id that isn't in
        use, and no higher than the counter or MAX_ID_JUMP; the counter moves
        past it so no later node can reuse it.
        """
        if node_id is None:
            self._counter += 1
            short_id = f"n{self._counter}"
        else:
            match = SHORT_ID_RE.fullmatch(node_id)
            if match is None:
                raise ValueError(f"'{node_id}' is not a short node id like n3")
            if node_id in self.nodes:
                raise ValueError(f"Node '{node_id}' already exists")
            if int(match.group(1)) > max(self._counter, MAX_ID_JUMP):
                raise ValueError(f"'{node_id}' is higher than any id this graph has handed out")
            short_id = node_id
            self._counter = max(self._counter, int(match.group(1)))
        node: dict[str, Any] = {
            "id": short_id,
            "definitionId": definition_id,
            # A Cinema scene's missing fields filled in, a transient run status
            # settled (services/cinema_scene_spec.py). Routes refuse what can't
            # be filled before they get here; this is the backstop.
            "params": dict(normalize_scene_params(definition_id, params, strict=False,
                                                  reserved=shot_port_ids(outputs))),
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

        # len+1 alone can land on a live edge's id after a removal.
        taken = {str(e.get("id")) for e in self.edges}
        number = len(self.edges) + 1
        while f"e{number}" in taken:
            number += 1
        edge: dict[str, str] = {
            "id": f"e{number}",
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

    def set_params(self, node_id: str, params: dict[str, Any]) -> None:
        """Replace the node's params (``update_params`` merges)."""
        if node_id not in self.nodes:
            raise ValueError(f"Node '{node_id}' not found")
        self.nodes[node_id]["params"] = dict(params)
        self._maybe_persist()

    def set_label(self, node_id: str, label: str | None) -> None:
        """Give a node a custom name, or clear it (None) to show the model's name."""
        if node_id not in self.nodes:
            raise ValueError(f"Node '{node_id}' not found")
        if label is None:
            self.nodes[node_id].pop("label", None)
        else:
            self.nodes[node_id]["label"] = label
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
        target = require_allowed_path(path)
        data = {
            "nodes": list(nodes.values()),
            "edges": list(edges),
            "counter": counter,
            # Everything this code writes already holds upgraded params.
            "paramsVersion": PARAMS_VERSION,
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
        source = require_allowed_path(path)
        data = json.loads(source.read_text())
        validate_file_references(data)
        counter = data.get("counter", len(data["nodes"]))
        taken = {str(n.get("id")) for n in data["nodes"] if isinstance(n, dict)}

        def next_id(_hint: str) -> str:
            nonlocal counter
            counter += 1
            while f"n{counter}" in taken:
                counter += 1
            taken.add(f"n{counter}")
            return f"n{counter}"

        # Folded Krea nodes move onto their new node first (with any typed
        # prompt or media on an input node), then retired ones.
        migrated, edges, warnings = migrate_graph(data["nodes"], data["edges"], new_id=next_id)
        for warning in warnings:
            print(f"[cli_graph] {warning}", flush=True)
        edge_ids = {str(e.get("id")) for e in edges if isinstance(e, dict) and e.get("id")}
        for edge in edges if migrated is not data["nodes"] else ():
            if isinstance(edge, dict) and not edge.get("id"):
                n = len(edge_ids) + 1
                while f"e{n}" in edge_ids:
                    n += 1
                edge["id"] = f"e{n}"
                edge_ids.add(edge["id"])
        # Build everything first and assign together, so a file that fails
        # part way leaves the previous graph whole (main keeps it on failure,
        # and the next save would write new nodes with old edges otherwise).
        nodes = {n["id"]: _normalized_scene(_migrate_retired(n)) for n in migrated}
        # A shot that lost its id in the file was given a new one: the port
        # it owned (its image) moves to its new id, with its wires (PR #198
        # review 5, L3). A port no shot owns stays: a removed shot's late
        # image, which an undo that brings the shot back takes.
        raw_params = {n["id"]: n.get("params") for n in migrated}
        for node_id, node in nodes.items():
            claimed = claim_stray_ports(raw_params.get(node_id), node.get("params"), node.get("outputs")) \
                if node.get("definitionId") == "cinema-scene" else {}
            if not claimed:
                continue
            nodes[node_id] = {**node, "outputs": rekeyed_outputs(node["outputs"], claimed)}
            for edge in edges:
                if isinstance(edge, dict) and edge.get("source") == node_id and edge.get("sourceHandle") in claimed:
                    edge["sourceHandle"] = claimed[edge["sourceHandle"]]
        # A file written before an upgrade existed gets it once; the next save
        # records the current version, so a value set afterwards is kept.
        version = stored_version(data.get("paramsVersion"))
        upgraded = upgrade_flat_nodes(nodes.values(), version)
        self.nodes, self.edges, self._counter = nodes, edges, counter
        self.upgraded_on_load = upgraded
        self.params_advanced_on_load = version < PARAMS_VERSION


def _normalized_scene(node: dict[str, Any]) -> dict[str, Any]:
    """A saved Cinema scene with its missing fields filled in and no shot
    left rendering (nothing renders across a load); every other node as is."""
    params = node.get("params")
    if not isinstance(params, dict):
        return node
    normalized = normalize_scene_params(str(node.get("definitionId", "")), params, strict=False,
                                        reserved=shot_port_ids(node.get("outputs")))
    return node if normalized is params else {**node, "params": normalized}


def _migrate_retired(node: dict[str, Any]) -> dict[str, Any]:
    """A saved node whose definition was retired, as its replacement."""
    definition_id, params, label = migrate_node(
        str(node.get("definitionId", "")), node.get("params"), node.get("label"),
    )
    if definition_id == node.get("definitionId"):
        # Same node, maybe on a retired model option (Veo 3.0 → 3.1).
        return node if params == (node.get("params") or {}) else {**node, "params": params}
    migrated = {**node, "definitionId": definition_id, "params": params}
    if label:
        migrated["label"] = label
    return migrated
