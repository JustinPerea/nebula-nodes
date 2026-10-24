from __future__ import annotations

import json
import os
import sys
from typing import Any
from uuid import uuid4

from services.file_access import ProtectedPathError, require_allowed_path, validate_file_references

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


# A saved graph past this isn't one `nebula save` wrote.
_MAX_SAVED_GRAPH_BYTES = 64 * 1024 * 1024


def _is_saved_graph(path) -> bool:
    """Whether the file at ``path`` is a graph export (`nebula save`'s JSON)."""
    try:
        if not path.is_file() or path.stat().st_size > _MAX_SAVED_GRAPH_BYTES:
            return False
        data = json.loads(path.read_text(encoding="utf-8"))
    except (OSError, ValueError, UnicodeDecodeError, RecursionError):
        return False
    return isinstance(data, dict) and isinstance(data.get("nodes"), list)


def run_save(client: NebulaClient, filepath: str) -> None:
    try:
        path = require_allowed_path(filepath)
    except ProtectedPathError as exc:
        print(f"error: {exc}", file=sys.stderr)
        sys.exit(1)
    if path.exists() and not _is_saved_graph(path):
        # It replaces only an earlier export. Anything else (an image or clip
        # in Nebula's output folder, which the spending check prices runs
        # from because nothing an agent runs changes it: services/input_sizes.py)
        # is left as it is.
        print(f"error: {filepath} already exists and isn't a saved graph, so it was left as it is. "
              "Save to a new file name.", file=sys.stderr)
        sys.exit(1)
    state = client.get_graph()
    # Keep the previous export intact until the complete replacement is ready.
    temporary = path.with_name(f".{path.name}.{uuid4().hex}.tmp")
    try:
        with temporary.open("x", encoding="utf-8") as handle:
            json.dump(state, handle, indent=2, allow_nan=False)
            handle.flush()
            os.fsync(handle.fileno())
        temporary.replace(path)
    finally:
        temporary.unlink(missing_ok=True)
    node_count = len(state.get("nodes", []))
    edge_count = len(state.get("edges", []))
    print(f"Saved graph ({node_count} nodes, {edge_count} connections) to {filepath}")


def run_load(client: NebulaClient, filepath: str) -> None:
    try:
        path = require_allowed_path(filepath)
    except ProtectedPathError as exc:
        print(f"error: {exc}", file=sys.stderr)
        sys.exit(1)
    if not path.exists():
        print(f"error: file not found: {filepath}", file=sys.stderr)
        sys.exit(1)

    with path.open("rb") as handle:
        signature = handle.read(4)
    if signature == b"PK\x03\x04":
        # A .nebula.zip bundle (Save graph's graph plus its files). Its files
        # are restored by the canvas's Load graph, which then opens the graph
        # (as a new project when it's over the save limit, Q120/Q121 a).
        print(f"error: {filepath} is a .nebula.zip bundle, and `nebula load` reads plain .nebula files. "
              "Ask the person to open it with Load graph on the canvas.", file=sys.stderr)
        sys.exit(1)

    data = json.loads(path.read_text())
    try:
        validate_file_references(data)
    except ProtectedPathError as exc:
        print(f"error: {exc}", file=sys.stderr)
        sys.exit(1)

    # One atomic replace through the route the canvas uses for .nebula files:
    # the saved params (the canvas's own _ bookkeeping included) arrive as
    # saved, retired nodes are migrated, and a refusal leaves the graph as it was.
    body: dict[str, Any] = {"nodes": data.get("nodes", []), "edges": data.get("edges", [])}
    if "paramsVersion" in data:
        body["paramsVersion"] = data["paramsVersion"]
    result = client.import_graph(body)
    for warning in result.get("warnings") or []:
        print(f"note: {warning}", file=sys.stderr)
    print(f"Loaded graph ({result.get('nodeCount', 0)} nodes, {result.get('edgeCount', 0)} connections) from {filepath}")


def run_clear(client: NebulaClient, force: bool = False) -> None:
    count = len(client.get_graph().get("nodes") or [])
    if count and not force:
        print(
            f"error: the open project has {count} node{'s' if count != 1 else ''}, and clearing removes all of them.\n"
            "To start fresh, make a new project instead (this one keeps its work):\n"
            "  nebula project new \"<name>\"\n"
            "To clear it anyway, run `nebula clear --force`.",
            file=sys.stderr,
        )
        sys.exit(1)
    client.clear_graph(force=force)
    if count:
        print(f"Canvas cleared ({count} node{'s' if count != 1 else ''} removed). "
              "The person can undo it on an open canvas (Undo, or Cmd-Z).")
    else:
        print("Canvas cleared (it was already empty).")


def _port_ref(value: str, role: str) -> tuple[str, str]:
    if ":" not in value:
        print(f"error: {role} must be node:port (e.g. n1:image), got '{value}'", file=sys.stderr)
        sys.exit(1)
    node, port = value.split(":", 1)
    return node, port


def run_delete(client: NebulaClient, node_refs: list[str]) -> None:
    for node_ref in node_refs:
        client.delete_node(node_ref)
        print(f"Deleted {node_ref} and its wires")


def run_disconnect(client: NebulaClient, src: str, dst: str) -> None:
    src_node, src_port = _port_ref(src, "source")
    dst_node, dst_port = _port_ref(dst, "destination")
    result = client.disconnect(src_node, src_port, dst_node, dst_port)
    if result.get("status") != "deleted":
        print(f"error: no wire {src} → {dst} (`nebula graph` lists them)", file=sys.stderr)
        sys.exit(1)
    print(f"Disconnected {src} → {dst}")


def run_rename(client: NebulaClient, node_ref: str, label: str) -> None:
    result = client.rename_node(node_ref, label)
    print(f"Renamed {node_ref} to {result.get('label', label)}")


def run_move(client: NebulaClient, moves: list[str]) -> None:
    """Each move is node=x,y in canvas (flow) coordinates."""
    positions: dict[str, dict[str, float]] = {}
    for move in moves:
        node, _, at = move.partition("=")
        x, _, y = at.partition(",")
        try:
            positions[node] = {"x": float(x), "y": float(y)}
        except ValueError:
            print(f"error: a move is node=x,y (e.g. n2=400,120), got '{move}'", file=sys.stderr)
            sys.exit(1)
    client.move_nodes(positions)
    print("Moved " + ", ".join(f"{node} to {int(p['x'])},{int(p['y'])}" for node, p in positions.items()))
