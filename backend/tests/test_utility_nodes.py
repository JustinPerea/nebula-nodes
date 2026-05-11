from __future__ import annotations

import json
from pathlib import Path
from typing import Any

import pytest

from execution.engine import execute_graph
from models.events import ExecutedEvent
from models.graph import GraphEdge, GraphNode, PortValueDict

ROOT = Path(__file__).resolve().parents[2]
MANIFEST_PATH = ROOT / "docs" / "utility-node-test-manifest.json"
NODE_DEFS_PATH = ROOT / "backend" / "data" / "node_definitions.json"


def _manifest_node_ids() -> list[str]:
    data = json.loads(MANIFEST_PATH.read_text())
    return [node["id"] for node in data["nodes"]]


def _utility_node_ids() -> list[str]:
    definitions = json.loads(NODE_DEFS_PATH.read_text())
    return [
        definition_id
        for definition_id, definition in definitions.items()
        if definition.get("category") == "utility"
    ]


def _node(
    node_id: str,
    definition_id: str,
    params: dict[str, Any] | None = None,
) -> GraphNode:
    return GraphNode(id=node_id, definitionId=definition_id, params=params or {}, outputs={})


def _edge(
    source: str,
    target: str,
    source_handle: str,
    target_handle: str,
) -> GraphEdge:
    return GraphEdge(
        id=f"{source}:{source_handle}->{target}:{target_handle}",
        source=source,
        sourceHandle=source_handle,
        target=target,
        targetHandle=target_handle,
    )


async def _execute(
    nodes: list[GraphNode],
    edges: list[GraphEdge],
    handlers: dict[str, Any] | None = None,
) -> dict[str, list[dict[str, Any]]]:
    executed: dict[str, list[dict[str, Any]]] = {}

    async def emit(event) -> None:
        if isinstance(event, ExecutedEvent):
            executed.setdefault(event.node_id, []).append(event.outputs)

    await execute_graph(nodes, edges, {}, handlers or {}, emit)
    return executed


def _latest(executed: dict[str, list[dict[str, Any]]], node_id: str) -> dict[str, Any]:
    return executed[node_id][-1]


def test_manifest_covers_every_utility_node() -> None:
    assert sorted(_manifest_node_ids()) == sorted(_utility_node_ids())


@pytest.mark.asyncio
async def test_text_combine_router_reroute_and_preview() -> None:
    nodes = [
        _node("text-a", "text-input", {"value": "A cat playing drums"}),
        _node("text-b", "text-input", {"value": "forest scene"}),
        _node("combine", "combine-text", {"separator": " | ", "template": ""}),
        _node("template", "combine-text", {"template": "{text2} then {text1}"}),
        _node("router", "router"),
        _node("reroute", "reroute"),
        _node("preview", "preview"),
    ]
    edges = [
        _edge("text-a", "combine", "text", "text1"),
        _edge("text-b", "combine", "text", "text2"),
        _edge("text-a", "template", "text", "text1"),
        _edge("text-b", "template", "text", "text2"),
        _edge("text-a", "router", "text", "input"),
        _edge("router", "reroute", "out1", "input"),
        _edge("reroute", "preview", "output", "input"),
    ]

    executed = await _execute(nodes, edges)

    assert _latest(executed, "text-a")["text"]["value"] == "A cat playing drums"
    assert _latest(executed, "combine")["text"]["value"] == "A cat playing drums | forest scene"
    assert _latest(executed, "template")["text"]["value"] == "forest scene then A cat playing drums"
    assert _latest(executed, "router") == {
        "out1": {"type": "Text", "value": "A cat playing drums"},
        "out2": {"type": "Text", "value": "A cat playing drums"},
        "out3": {"type": "Text", "value": "A cat playing drums"},
    }
    assert _latest(executed, "reroute")["output"]["value"] == "A cat playing drums"
    assert _latest(executed, "preview")["input"]["value"] == "A cat playing drums"


@pytest.mark.asyncio
async def test_media_inputs_sticky_note_and_image_compare() -> None:
    nodes = [
        _node("image-a", "image-input", {"filePath": "/tmp/image-a.png"}),
        _node("image-b", "image-input", {"filePath": "/tmp/image-b.png"}),
        _node("video", "video-input", {"filePath": "/tmp/source.mp4"}),
        _node("audio", "audio-input", {"filePath": "/tmp/source.wav"}),
        _node("note", "sticky-note", {"content": "manual note", "color": "grey"}),
        _node("compare", "image-compare"),
    ]
    edges = [
        _edge("image-a", "compare", "image", "imageA"),
        _edge("image-b", "compare", "image", "imageB"),
    ]

    executed = await _execute(nodes, edges)

    assert _latest(executed, "image-a")["image"]["value"] == "/tmp/image-a.png"
    assert _latest(executed, "image-b")["image"]["value"] == "/tmp/image-b.png"
    assert _latest(executed, "video")["video"]["value"] == "/tmp/source.mp4"
    assert _latest(executed, "audio")["audio"]["value"] == "/tmp/source.wav"
    assert _latest(executed, "note") == {}
    assert _latest(executed, "compare") == {
        "imageA": {"type": "Image", "value": "/tmp/image-a.png"},
        "imageB": {"type": "Image", "value": "/tmp/image-b.png"},
    }


@pytest.mark.asyncio
async def test_array_builder_selector_and_iterators() -> None:
    nodes = [
        _node("text-a", "text-input", {"value": "first"}),
        _node("text-b", "text-input", {"value": "second"}),
        _node("image-a", "image-input", {"filePath": "/tmp/image-a.png"}),
        _node("image-b", "image-input", {"filePath": "/tmp/image-b.png"}),
        _node("text-array", "array-builder"),
        _node("image-array", "array-builder"),
        _node("selector", "array-selector", {"mode": "index", "index": 1}),
        _node("text-iterator", "iterator-text", {"batch_size_cap": 10}),
        _node("image-iterator", "iterator-image", {"batch_size_cap": 10}),
    ]
    edges = [
        _edge("text-a", "text-array", "text", "item1"),
        _edge("text-b", "text-array", "text", "item2"),
        _edge("image-a", "image-array", "image", "item1"),
        _edge("image-b", "image-array", "image", "item2"),
        _edge("text-array", "selector", "array", "array"),
        _edge("text-array", "text-iterator", "array", "array"),
        _edge("image-array", "image-iterator", "array", "array"),
    ]

    executed = await _execute(nodes, edges)

    assert _latest(executed, "text-array")["array"]["value"] == ["first", "second"]
    assert _latest(executed, "image-array")["array"]["value"] == ["/tmp/image-a.png", "/tmp/image-b.png"]
    assert _latest(executed, "selector")["item"]["value"] == "second"
    assert [output["text"]["value"] for output in executed["text-iterator"]] == ["first", "second"]
    assert [output["image"]["value"] for output in executed["image-iterator"]] == [
        "/tmp/image-a.png",
        "/tmp/image-b.png",
    ]


@pytest.mark.asyncio
async def test_gemini_embeddings_contract_with_mocked_handler() -> None:
    captured: dict[str, PortValueDict] = {}

    async def fake_embeddings(
        _node: GraphNode,
        inputs: dict[str, PortValueDict],
        _api_keys: dict[str, str],
    ) -> dict[str, Any]:
        captured.update(inputs)
        return {
            "embedding": {"type": "Text", "value": "[0.1, 0.2, 0.3]"},
            "dimensions": {"type": "Text", "value": "3"},
        }

    nodes = [
        _node("text", "text-input", {"value": "embed me"}),
        _node("embeddings", "gemini-embeddings", {"model": "gemini-embedding-001"}),
    ]
    edges = [_edge("text", "embeddings", "text", "text")]

    executed = await _execute(nodes, edges, {"gemini-embeddings": fake_embeddings})

    assert captured["text"].value == "embed me"
    assert _latest(executed, "embeddings") == {
        "embedding": {"type": "Text", "value": "[0.1, 0.2, 0.3]"},
        "dimensions": {"type": "Text", "value": "3"},
    }
