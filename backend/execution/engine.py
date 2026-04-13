from __future__ import annotations

import asyncio
import time
from graphlib import TopologicalSorter, CycleError as _GraphlibCycleError
from typing import Any, Callable, Awaitable

from models.graph import GraphNode, GraphEdge, PortValueDict
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
            handler = handler_registry.get(node.definition_id)
            if handler is None:
                if node.definition_id == "text-input":
                    text_value = node.params.get("value", "")
                    node_outputs = {"text": {"type": "Text", "value": str(text_value)}}
                elif node.definition_id == "image-input":
                    file_path = node.params.get("filePath", "")
                    node_outputs = {"image": {"type": "Image", "value": str(file_path)}}
                elif node.definition_id == "preview":
                    node_outputs = {}
                    if "input" in resolved_inputs:
                        node_outputs["input"] = {
                            "type": resolved_inputs["input"].type,
                            "value": resolved_inputs["input"].value,
                        }
                else:
                    raise RuntimeError(f"No handler registered for '{node.definition_id}'")
            else:
                node_outputs = await handler(node, resolved_inputs, api_keys)

            outputs_cache[nid] = {
                k: PortValueDict(type=v.get("type", "Any"), value=v.get("value"))
                for k, v in node_outputs.items()
            }

            await emit(ExecutedEvent(node_id=nid, outputs=node_outputs))
            nodes_executed += 1

        except Exception as exc:
            await emit(ErrorEvent(node_id=nid, error=str(exc), retryable=False))
            break

    duration = time.monotonic() - start_time
    await emit(GraphCompleteEvent(duration=round(duration, 3), nodes_executed=nodes_executed))
