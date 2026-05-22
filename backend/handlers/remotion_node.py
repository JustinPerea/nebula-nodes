"""Handler for the remotion-node node type.

No-op for Phase 2.1 — Remotion preview happens client-side via @remotion/player.
The handler validates the manifest shape and echoes it through as the node's
output so downstream consumers receive a typed value.
"""
from __future__ import annotations

from typing import Any, Awaitable, Callable

from models.events import ExecutionEvent
from models.graph import GraphNode, PortValueDict

REQUIRED_TOP_LEVEL_KEYS = {"graph", "timeline"}
REQUIRED_GRAPH_KEYS = {"nodes", "edges"}
EMPTY_MANIFEST = {"graph": {"nodes": [], "edges": []}, "timeline": []}


def _validate_manifest(manifest: Any) -> None:
    if not isinstance(manifest, dict):
        raise ValueError("manifest must be an object")
    missing = REQUIRED_TOP_LEVEL_KEYS - set(manifest.keys())
    if missing:
        raise ValueError(f"manifest missing top-level keys: {missing}")
    graph = manifest.get("graph")
    if not isinstance(graph, dict):
        raise ValueError("manifest.graph must be an object")
    missing_graph = REQUIRED_GRAPH_KEYS - set(graph.keys())
    if missing_graph:
        raise ValueError(f"manifest.graph missing keys: {missing_graph}")
    if not isinstance(manifest.get("timeline"), list):
        raise ValueError("manifest.timeline must be a list")


async def handle_remotion_node(
    node: GraphNode,
    inputs: dict[str, PortValueDict],
    api_keys: dict[str, str],
    emit: Callable[[ExecutionEvent], Awaitable[None]] | None = None,
) -> dict[str, Any]:
    params = node.params
    manifest = params.get("manifest")
    if manifest is None:
        manifest = EMPTY_MANIFEST
    _validate_manifest(manifest)
    return {"video": None, "manifest": manifest}
