from __future__ import annotations

import pytest

from execution.engine import topological_sort, validate_graph, CycleError
from models.graph import GraphNode, GraphEdge


def _node(nid: str, def_id: str = "gpt-image-1-generate") -> GraphNode:
    return GraphNode(id=nid, definitionId=def_id, params={}, outputs={})


def _edge(src: str, tgt: str, src_handle: str = "image", tgt_handle: str = "prompt") -> GraphEdge:
    return GraphEdge(
        id=f"{src}->{tgt}",
        source=src,
        sourceHandle=src_handle,
        target=tgt,
        targetHandle=tgt_handle,
    )


class TestTopologicalSort:
    def test_single_node(self) -> None:
        nodes = [_node("a")]
        order = topological_sort(nodes, [])
        assert order == ["a"]

    def test_linear_chain(self) -> None:
        nodes = [_node("a", "text-input"), _node("b"), _node("c", "preview")]
        edges = [_edge("a", "b", "text", "prompt"), _edge("b", "c", "image", "input")]
        order = topological_sort(nodes, edges)
        assert order == ["a", "b", "c"]

    def test_diamond_graph(self) -> None:
        nodes = [_node("a", "text-input"), _node("b"), _node("c"), _node("d", "preview")]
        edges = [
            _edge("a", "b", "text", "prompt"),
            _edge("a", "c", "text", "prompt"),
            _edge("b", "d", "image", "input"),
            _edge("c", "d", "image", "input"),
        ]
        order = topological_sort(nodes, edges)
        assert order[0] == "a"
        assert order[-1] == "d"
        assert set(order) == {"a", "b", "c", "d"}

    def test_disconnected_subgraphs(self) -> None:
        nodes = [_node("a"), _node("b")]
        order = topological_sort(nodes, [])
        assert set(order) == {"a", "b"}

    def test_cycle_raises(self) -> None:
        nodes = [_node("a"), _node("b")]
        edges = [_edge("a", "b"), _edge("b", "a")]
        with pytest.raises(CycleError):
            topological_sort(nodes, edges)


class TestValidateGraph:
    def test_valid_graph_passes(self) -> None:
        nodes = [_node("a", "text-input"), _node("b", "gpt-image-1-generate")]
        edges = [_edge("a", "b", "text", "prompt")]
        api_keys = {"OPENAI_API_KEY": "sk-test"}
        errors = validate_graph(nodes, edges, api_keys)
        assert errors == []

    def test_missing_required_port(self) -> None:
        nodes = [_node("b", "gpt-image-1-generate")]
        errors = validate_graph(nodes, [], {})
        port_errors = [e for e in errors if e.port_id == "prompt"]
        assert len(port_errors) == 1
        assert "required" in port_errors[0].message.lower()

    def test_missing_api_key(self) -> None:
        nodes = [_node("a", "text-input"), _node("b", "gpt-image-1-generate")]
        edges = [_edge("a", "b", "text", "prompt")]
        errors = validate_graph(nodes, edges, {})
        key_errors = [e for e in errors if "api key" in e.message.lower()]
        assert len(key_errors) == 1

    def test_utility_node_no_key_needed(self) -> None:
        nodes = [_node("a", "text-input")]
        errors = validate_graph(nodes, [], {})
        key_errors = [e for e in errors if "api key" in e.message.lower()]
        assert len(key_errors) == 0
