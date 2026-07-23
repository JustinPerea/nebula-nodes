"""Handler for the remotion-node node type.

Preview happens client-side via @remotion/player. Running the node renders the
same manifest to a real H.264 MP4 via @remotion/renderer.
"""
from __future__ import annotations

from typing import Any, Awaitable, Callable

from models.events import ExecutionEvent, ProgressEvent
from models.graph import GraphNode, PortValueDict
from services.remotion_render import render_remotion_manifest

REQUIRED_TOP_LEVEL_KEYS = {"graph", "timeline"}
REQUIRED_GRAPH_KEYS = {"nodes", "edges"}


def _empty_manifest() -> dict[str, Any]:
    return {"graph": {"nodes": [], "edges": []}, "timeline": []}


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
        manifest = _empty_manifest()
    _validate_manifest(manifest)
    def _on_progress(value: float) -> None:
        if emit is None:
            return
        import asyncio as _asyncio
        _asyncio.create_task(emit(ProgressEvent(node_id=node.id, value=value)))

    output_path = await render_remotion_manifest(manifest, on_progress=_on_progress)
    return {
        "video": {"type": "Video", "value": str(output_path)},
        "manifest": {"type": "Any", "value": manifest},
    }
