from __future__ import annotations

import pytest

from execution.engine import validate_graph
from models.graph import GraphEdge, GraphNode
from services.port_contracts import cinema_output_ports


@pytest.mark.parametrize("scene", [None, {}, {"shots": {}}, {"shots": [None, {}, {"id": 4}]}])
def test_cinema_ports_ignore_malformed_or_missing_shot_ids(scene):
    assert cinema_output_ports({"scene": scene}) == []


def test_execution_preflight_accepts_real_shot_outputs_but_rejects_removed_or_incompatible_handles():
    nodes = [
        GraphNode(id="scene", definition_id="cinema-scene", params={"scene": {
            "version": 1, "base": {"model": "nano-banana"}, "aspectRatio": "1:1",
            "shots": [{"id": "opening", "prompt": "A logo"}],
        }}),
        GraphNode(id="model", definition_id="nano-banana", params={}),
        GraphNode(id="prompt", definition_id="text-input", params={"value": "Animate the logo"}),
    ]
    prompt_edge = GraphEdge(id="prompt-wire", source="prompt", source_handle="text",
                            target="model", target_handle="prompt")
    image_edge = GraphEdge(id="shot-wire", source="scene", source_handle="shot_opening",
                           target="model", target_handle="images")
    assert validate_graph(nodes, [prompt_edge, image_edge], {"GOOGLE_API_KEY": "fixture"}) == []

    removed = image_edge.model_copy(update={"source_handle": "shot_removed"})
    errors = validate_graph(nodes, [prompt_edge, removed], {"GOOGLE_API_KEY": "fixture"})
    assert any("Invalid source handle 'shot_removed'" in error.message for error in errors)
    assert not any("Missing required input" in error.message for error in errors)

    incompatible = image_edge.model_copy(update={"target_handle": "prompt"})
    errors = validate_graph(nodes, [incompatible], {"GOOGLE_API_KEY": "fixture"})
    assert any("Incompatible port types" in error.message for error in errors)
