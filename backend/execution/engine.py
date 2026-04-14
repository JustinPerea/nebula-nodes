from __future__ import annotations

import asyncio
import time
from graphlib import TopologicalSorter, CycleError as _GraphlibCycleError
from typing import Any, Callable, Awaitable

from models.graph import GraphNode, GraphEdge, PortValueDict
from services.cache import ExecutionCache
from models.events import (
    ExecutionEvent,
    QueuedEvent,
    ExecutingEvent,
    ExecutedEvent,
    ErrorEvent,
    ValidationErrorDetail,
    GraphCompleteEvent,
)

CycleError = _GraphlibCycleError

NODE_DEFS: dict[str, dict[str, Any]] = {
    "gpt-image-1-generate": {
        "inputPorts": [{"id": "prompt", "required": True}],
        "outputPorts": [{"id": "image"}],
        "envKeyName": "OPENAI_API_KEY",
    },
    "claude-chat": {
        "inputPorts": [
            {"id": "messages", "required": True},
            {"id": "images", "required": False},
        ],
        "outputPorts": [{"id": "text"}],
        "envKeyName": "ANTHROPIC_API_KEY",
    },
    "runway-gen4-turbo": {
        "inputPorts": [
            {"id": "image", "required": True},
            {"id": "prompt", "required": False},
        ],
        "outputPorts": [{"id": "video"}],
        "envKeyName": "RUNWAY_API_KEY",
    },
    "elevenlabs-tts": {
        "inputPorts": [{"id": "text", "required": True}],
        "outputPorts": [{"id": "audio"}],
        "envKeyName": "ELEVENLABS_API_KEY",
    },
    "flux-1-1-ultra": {
        "inputPorts": [
            {"id": "prompt", "required": True},
            {"id": "image", "required": False},
        ],
        "outputPorts": [{"id": "image"}],
        "envKeyName": ["FAL_KEY", "BFL_API_KEY"],
    },
    "text-input": {
        "inputPorts": [],
        "outputPorts": [{"id": "text"}],
        "envKeyName": [],
    },
    "image-input": {
        "inputPorts": [],
        "outputPorts": [{"id": "image"}],
        "envKeyName": [],
    },
    "preview": {
        "inputPorts": [{"id": "input", "required": True}],
        "outputPorts": [],
        "envKeyName": [],
    },
    "combine-text": {
        "inputPorts": [
            {"id": "text1", "required": True},
            {"id": "text2", "required": False},
            {"id": "text3", "required": False},
        ],
        "outputPorts": [{"id": "text"}],
        "envKeyName": [],
    },
    "router": {
        "inputPorts": [{"id": "input", "required": True}],
        "outputPorts": [{"id": "out1"}, {"id": "out2"}, {"id": "out3"}],
        "envKeyName": [],
    },
    "reroute": {
        "inputPorts": [{"id": "input", "required": True}],
        "outputPorts": [{"id": "output"}],
        "envKeyName": [],
    },
    "dalle-3-generate": {
        "inputPorts": [{"id": "prompt", "required": True}],
        "outputPorts": [{"id": "image"}],
        "envKeyName": "OPENAI_API_KEY",
    },
    "gpt-4o-chat": {
        "inputPorts": [
            {"id": "messages", "required": True},
            {"id": "images", "required": False},
        ],
        "outputPorts": [{"id": "text"}],
        "envKeyName": "OPENAI_API_KEY",
    },
    "gemini-chat": {
        "inputPorts": [
            {"id": "messages", "required": True},
            {"id": "images", "required": False},
        ],
        "outputPorts": [{"id": "text"}],
        "envKeyName": "GOOGLE_API_KEY",
    },
    "imagen-4-generate": {
        "inputPorts": [{"id": "prompt", "required": True}],
        "outputPorts": [{"id": "image"}],
        "envKeyName": "GOOGLE_API_KEY",
    },
    "kling-v2-1": {
        "inputPorts": [
            {"id": "image", "required": True},
            {"id": "prompt", "required": False},
        ],
        "outputPorts": [{"id": "video"}],
        "envKeyName": "FAL_KEY",
    },
    "sora-2": {
        "inputPorts": [{"id": "prompt", "required": True}],
        "outputPorts": [{"id": "video"}],
        "envKeyName": "FAL_KEY",
    },
    "nano-banana": {
        "inputPorts": [
            {"id": "prompt", "required": True},
            {"id": "images", "required": False},
        ],
        "outputPorts": [{"id": "image"}, {"id": "text"}],
        "envKeyName": "GOOGLE_API_KEY",
    },
    "veo-3": {
        "inputPorts": [{"id": "prompt", "required": True}],
        "outputPorts": [{"id": "video"}],
        "envKeyName": "FAL_KEY",
    },
    "flux-schnell": {
        "inputPorts": [{"id": "prompt", "required": True}],
        "outputPorts": [{"id": "image"}],
        "envKeyName": "FAL_KEY",
    },
    "fast-sdxl": {
        "inputPorts": [{"id": "prompt", "required": True}],
        "outputPorts": [{"id": "image"}],
        "envKeyName": "FAL_KEY",
    },
    "wan-2-6-t2v": {
        "inputPorts": [{"id": "prompt", "required": True}],
        "outputPorts": [{"id": "video"}],
        "envKeyName": "FAL_KEY",
    },
    "luma-ray2-t2v": {
        "inputPorts": [{"id": "prompt", "required": True}],
        "outputPorts": [{"id": "video"}],
        "envKeyName": "FAL_KEY",
    },
    "ltx-video-2": {
        "inputPorts": [
            {"id": "image", "required": True},
            {"id": "prompt", "required": True},
        ],
        "outputPorts": [{"id": "video"}],
        "envKeyName": "FAL_KEY",
    },
}


def topological_sort(nodes: list[GraphNode], edges: list[GraphEdge]) -> list[str]:
    graph: dict[str, set[str]] = {node.id: set() for node in nodes}
    for edge in edges:
        if edge.target in graph:
            graph[edge.target].add(edge.source)

    sorter = TopologicalSorter(graph)
    try:
        return list(sorter.static_order())
    except _GraphlibCycleError as exc:
        raise CycleError(str(exc)) from exc


def get_subgraph(
    nodes: list[GraphNode],
    edges: list[GraphEdge],
    target_node_id: str,
) -> tuple[list[GraphNode], list[GraphEdge]]:
    """Return the subgraph of all ancestors of target_node_id (inclusive).

    Traverses edges in reverse (target -> source) to find every node that
    feeds into the target. Returns filtered lists of nodes and edges that
    belong to this subgraph.
    """
    # Build reverse adjacency: node_id -> set of upstream node_ids
    reverse_adj: dict[str, set[str]] = {n.id: set() for n in nodes}
    for edge in edges:
        if edge.target in reverse_adj:
            reverse_adj[edge.target].add(edge.source)

    # BFS from target node to find all ancestors
    needed: set[str] = set()
    queue = [target_node_id]
    while queue:
        nid = queue.pop()
        if nid in needed:
            continue
        needed.add(nid)
        for upstream in reverse_adj.get(nid, set()):
            if upstream not in needed:
                queue.append(upstream)

    node_map = {n.id: n for n in nodes}
    sub_nodes = [node_map[nid] for nid in needed if nid in node_map]
    sub_edges = [e for e in edges if e.source in needed and e.target in needed]
    return sub_nodes, sub_edges


def validate_graph(
    nodes: list[GraphNode],
    edges: list[GraphEdge],
    api_keys: dict[str, str],
) -> list[ValidationErrorDetail]:
    errors: list[ValidationErrorDetail] = []

    connected_ports: set[tuple[str, str]] = set()
    for edge in edges:
        if edge.target_handle:
            connected_ports.add((edge.target, edge.target_handle))

    for node in nodes:
        node_def = NODE_DEFS.get(node.definition_id)
        if not node_def:
            # Dynamic node — still validate API key if definition_id is recognized
            DYNAMIC_ENV_KEYS: dict[str, str] = {
                "openrouter-universal": "OPENROUTER_API_KEY",
                "replicate-universal": "REPLICATE_API_TOKEN",
                "fal-universal": "FAL_KEY",
            }
            env_key = DYNAMIC_ENV_KEYS.get(node.definition_id)
            if env_key and not api_keys.get(env_key):
                errors.append(
                    ValidationErrorDetail(
                        node_id=node.id,
                        port_id="",
                        message=f"Missing API key: {env_key}",
                    )
                )
            continue

        for port in node_def["inputPorts"]:
            if port.get("required", False):
                if (node.id, port["id"]) not in connected_ports:
                    errors.append(
                        ValidationErrorDetail(
                            node_id=node.id,
                            port_id=port["id"],
                            message=f"Required input port '{port['id']}' is not connected",
                        )
                    )

        env_key = node_def.get("envKeyName", [])
        if isinstance(env_key, str) and env_key:
            key_names = [env_key]
        elif isinstance(env_key, list):
            key_names = env_key
        else:
            key_names = []

        if key_names and not any(api_keys.get(k) for k in key_names):
            key_display = " or ".join(key_names)
            errors.append(
                ValidationErrorDetail(
                    node_id=node.id,
                    port_id="",
                    message=f"Missing API key: {key_display}",
                )
            )

    return errors


NodeHandler = Callable[
    [GraphNode, dict[str, PortValueDict], dict[str, str]],
    Awaitable[dict[str, Any]],
]


async def execute_graph(
    nodes: list[GraphNode],
    edges: list[GraphEdge],
    api_keys: dict[str, str],
    handler_registry: dict[str, NodeHandler],
    emit: Callable[[ExecutionEvent], Awaitable[None]],
    cache: ExecutionCache | None = None,
) -> None:
    start_time = time.monotonic()
    nodes_executed = 0
    node_map: dict[str, GraphNode] = {n.id: n for n in nodes}
    outputs_cache: dict[str, dict[str, PortValueDict]] = {}
    order = topological_sort(nodes, edges)

    for nid in order:
        await emit(QueuedEvent(node_id=nid))

    for nid in order:
        node = node_map[nid]
        await emit(ExecutingEvent(node_id=nid))

        resolved_inputs: dict[str, PortValueDict] = {}
        for edge in edges:
            if edge.target == nid and edge.source_handle and edge.target_handle:
                upstream_outputs = outputs_cache.get(edge.source, {})
                if edge.source_handle in upstream_outputs:
                    resolved_inputs[edge.target_handle] = upstream_outputs[edge.source_handle]

        try:
            cache_key: str | None = None
            if cache is not None:
                inputs_for_key = {
                    k: {"type": v.type, "value": v.value}
                    for k, v in resolved_inputs.items()
                }
                cache_key = ExecutionCache.get_key(
                    node.definition_id, dict(node.params), inputs_for_key
                )
                cached_outputs = cache.get(cache_key)
                if cached_outputs is not None:
                    outputs_cache[nid] = {
                        k: PortValueDict(type=v.get("type", "Any"), value=v.get("value"))
                        for k, v in cached_outputs.items()
                    }
                    await emit(ExecutedEvent(node_id=nid, outputs=cached_outputs))
                    nodes_executed += 1
                    continue

            handler = handler_registry.get(node.definition_id)
            if handler is None:
                if node.definition_id == "text-input":
                    text_value = node.params.get("value", "")
                    node_outputs = {"text": {"type": "Text", "value": str(text_value)}}
                elif node.definition_id == "image-input":
                    file_path = node.params.get("filePath", "")
                    node_outputs = {"image": {"type": "Image", "value": str(file_path)}}
                elif node.definition_id == "video-input":
                    file_path = node.params.get("filePath", "")
                    node_outputs = {"video": {"type": "Video", "value": str(file_path)}}
                elif node.definition_id == "audio-input":
                    file_path = node.params.get("filePath", "")
                    node_outputs = {"audio": {"type": "Audio", "value": str(file_path)}}
                elif node.definition_id == "sticky-note":
                    node_outputs = {}
                elif node.definition_id == "frame-extractor":
                    # Placeholder — frame extraction requires ffmpeg
                    video_input = resolved_inputs.get("video")
                    if video_input and video_input.value:
                        node_outputs = {"image": {"type": "Image", "value": str(video_input.value)}}
                    else:
                        node_outputs = {}
                elif node.definition_id == "array-builder":
                    items = []
                    for port_id in ("item1", "item2", "item3", "item4"):
                        if port_id in resolved_inputs and resolved_inputs[port_id].value is not None:
                            items.append(resolved_inputs[port_id].value)
                    node_outputs = {"array": {"type": "Array", "value": items}}
                elif node.definition_id == "array-selector":
                    array_input = resolved_inputs.get("array")
                    if array_input and isinstance(array_input.value, list) and len(array_input.value) > 0:
                        mode = node.params.get("mode", "first")
                        arr = array_input.value
                        if mode == "first":
                            selected = arr[0]
                        elif mode == "last":
                            selected = arr[-1]
                        elif mode == "random":
                            import random
                            selected = random.choice(arr)
                        else:  # index
                            idx = int(node.params.get("index", 0))
                            selected = arr[min(idx, len(arr) - 1)]
                        node_outputs = {"item": {"type": "Any", "value": selected}}
                    else:
                        node_outputs = {}
                elif node.definition_id == "image-compare":
                    node_outputs = {}
                    if "imageA" in resolved_inputs:
                        node_outputs["imageA"] = {"type": resolved_inputs["imageA"].type, "value": resolved_inputs["imageA"].value}
                    if "imageB" in resolved_inputs:
                        node_outputs["imageB"] = {"type": resolved_inputs["imageB"].type, "value": resolved_inputs["imageB"].value}
                elif node.definition_id == "svg-rasterize":
                    # Placeholder — SVG rasterization requires sharp or cairosvg
                    svg_input = resolved_inputs.get("svg")
                    if svg_input and svg_input.value:
                        node_outputs = {"image": {"type": "Image", "value": str(svg_input.value)}}
                    else:
                        node_outputs = {}
                elif node.definition_id in ("iterator-image", "iterator-text"):
                    # Simplified iterator — emits first item only
                    # Full iteration (trigger downstream per item) requires engine refactor
                    array_input = resolved_inputs.get("array")
                    if array_input and isinstance(array_input.value, list) and len(array_input.value) > 0:
                        first_item = array_input.value[0]
                        out_type = "Image" if node.definition_id == "iterator-image" else "Text"
                        out_key = "image" if node.definition_id == "iterator-image" else "text"
                        node_outputs = {out_key: {"type": out_type, "value": first_item}}
                    else:
                        node_outputs = {}
                elif node.definition_id == "preview":
                    node_outputs = {}
                    if "input" in resolved_inputs:
                        node_outputs["input"] = {
                            "type": resolved_inputs["input"].type,
                            "value": resolved_inputs["input"].value,
                        }
                elif node.definition_id == "combine-text":
                    texts = []
                    for port_id in ("text1", "text2", "text3"):
                        if port_id in resolved_inputs and resolved_inputs[port_id].value:
                            texts.append(str(resolved_inputs[port_id].value))

                    template = node.params.get("template", "")
                    if template:
                        # Template mode: replace {text1}, {text2}, {text3}
                        result = str(template)
                        for port_id in ("text1", "text2", "text3"):
                            val = ""
                            if port_id in resolved_inputs and resolved_inputs[port_id].value:
                                val = str(resolved_inputs[port_id].value)
                            result = result.replace(f"{{{port_id}}}", val)
                        node_outputs = {"text": {"type": "Text", "value": result}}
                    else:
                        # Separator mode: join non-empty texts
                        separator = node.params.get("separator", "\n")
                        separator = str(separator).replace("\\n", "\n").replace("\\t", "\t")
                        node_outputs = {"text": {"type": "Text", "value": separator.join(texts)}}
                elif node.definition_id == "router":
                    input_val = resolved_inputs.get("input")
                    if input_val and input_val.value is not None:
                        port_val = {"type": input_val.type, "value": input_val.value}
                        node_outputs = {
                            "out1": port_val,
                            "out2": port_val,
                            "out3": port_val,
                        }
                    else:
                        node_outputs = {}
                elif node.definition_id == "reroute":
                    input_val = resolved_inputs.get("input")
                    if input_val and input_val.value is not None:
                        node_outputs = {"output": {"type": input_val.type, "value": input_val.value}}
                    else:
                        node_outputs = {}
                else:
                    raise RuntimeError(f"No handler registered for '{node.definition_id}'")
            else:
                node_outputs = await handler(node, resolved_inputs, api_keys)

            outputs_cache[nid] = {
                k: PortValueDict(type=v.get("type", "Any"), value=v.get("value"))
                for k, v in node_outputs.items()
            }

            if cache is not None and cache_key is not None and handler is not None:
                cache.set(cache_key, node_outputs)

            await emit(ExecutedEvent(node_id=nid, outputs=node_outputs))
            nodes_executed += 1

        except Exception as exc:
            await emit(ErrorEvent(node_id=nid, error=str(exc), retryable=False))
            break

    duration = time.monotonic() - start_time
    await emit(GraphCompleteEvent(duration=round(duration, 3), nodes_executed=nodes_executed))
