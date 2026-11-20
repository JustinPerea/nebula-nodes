"""A node saved before the copy sweep carries a Title Case default label ("Video
Edit"). It no longer equals the definition's name, but it is still the default
title, not a name the person chose (final). The table lives in
node_route.FORMER_DEFAULT_TITLES; contracts/fixtures/former-default-titles.json
pins it to the frontend's (frontend/tests/lib/formerDefaultTitles.test.ts)."""
from __future__ import annotations

import json
from pathlib import Path

import pytest

from execution.engine import _renamed
from models.graph import GraphNode
from services import node_route
from services.node_registry import NodeRegistry
from services.project_view import _node

ROOT = Path(__file__).resolve().parents[2]
FIXTURE = json.loads((ROOT / "contracts/fixtures/former-default-titles.json").read_text())["titles"]


def test_the_table_equals_the_shared_fixture():
    assert node_route.FORMER_DEFAULT_TITLES == FIXTURE


@pytest.mark.parametrize("definition_id,old", sorted(FIXTURE.items()))
def test_each_former_default_is_the_default_and_not_a_rename(definition_id, old):
    definition = NodeRegistry().get_all()[definition_id]
    assert old != definition["displayName"], "the sweep renamed it, so the old label differs"
    assert node_route.is_default_title(definition, old)
    assert node_route.is_default_title(definition, definition["displayName"])
    assert node_route.node_name(definition, old, definition_id) == node_route.canvas_title(definition)
    assert not node_route.is_default_title(definition, "My own name")


def test_a_label_of_another_node_s_old_name_is_still_a_name():
    video_edit = NodeRegistry().get_all()["video-edit"]
    assert not node_route.is_default_title(video_edit, "Camera Rig")


def test_a_video_edit_node_labelled_video_edit_is_not_reported_as_renamed():
    definitions = NodeRegistry().get_all()
    definition = definitions["video-edit"]
    rf = {"id": "n1", "position": {"x": 0, "y": 0},
          "data": {"definitionId": "video-edit", "label": "Video Edit", "params": {}, "outputs": {}}}
    view = _node(rf, definitions, {}, [])
    assert view["name"] == node_route.canvas_title(definition)
    assert "model" not in view, "agents read a model beside the name only when the name is the person's"
    # The run's refusal quotes the node by its type, as for an unnamed node.
    node = GraphNode(id="n1", definition_id="video-edit", params={})
    assert _renamed(node, definition, lambda _id: node_route.node_name(definition, "Video Edit", "n1")) is None


# Design flag D: a saved canvas read from disk shows the new default name where it holds the old default.
def _saved(tmp_path, nodes):
    path = tmp_path / "saved.json"
    path.write_text(json.dumps({"nodes": nodes, "edges": [], "counter": len(nodes)}))
    return path


def test_a_saved_former_default_label_loads_as_the_new_default_and_the_file_is_not_rewritten(tmp_path):
    from services.cli_graph import CLIGraph

    path = _saved(tmp_path, [
        {"id": "n1", "definitionId": "remotion-node", "label": "Remotion Composition", "params": {}},
        {"id": "n2", "definitionId": "remotion-node", "label": "My comp", "params": {}},
        {"id": "n3", "definitionId": "camera-rig", "label": "Video Edit", "params": {}},
        {"id": "n4", "definitionId": "video-edit", "label": "Video Edit", "params": {}},
    ])
    before = path.read_text()
    graph = CLIGraph()
    graph.load(path)
    labels = {node_id: node.get("label") for node_id, node in graph.nodes.items()}
    assert labels == {"n1": "Remotion composition", "n2": "My comp", "n3": "Video Edit", "n4": "Video edit"}
    assert path.read_text() == before, "the load itself never rewrites the file"
    graph.save(tmp_path / "next.json")
    assert json.loads((tmp_path / "next.json").read_text())["nodes"][0]["label"] == "Remotion composition"


@pytest.mark.parametrize("definition_id,old", sorted(FIXTURE.items()))
def test_every_former_default_loads_as_its_definitions_name(definition_id, old, tmp_path):
    from services.cli_graph import CLIGraph

    graph = CLIGraph()
    graph.load(_saved(tmp_path, [{"id": "n1", "definitionId": definition_id, "label": old, "params": {}}]))
    assert graph.nodes["n1"]["label"] == NodeRegistry().get_all()[definition_id]["displayName"]


def test_many_nodes_with_a_former_default_read_the_definitions_file_once(tmp_path, monkeypatch):
    from services import cli_graph
    from services import node_registry

    cli_graph._current_default_labels.cache_clear()
    built = []
    real = node_registry.NodeRegistry

    class Counting(real):
        def __init__(self, *args, **kwargs):
            built.append(1)
            super().__init__(*args, **kwargs)

    monkeypatch.setattr(node_registry, "NodeRegistry", Counting)
    nodes = [{"id": f"n{i}", "definitionId": "remotion-node", "label": "Remotion Composition", "params": {}} for i in range(30)]
    graph = cli_graph.CLIGraph()
    graph.load(_saved(tmp_path, nodes))
    assert {node["label"] for node in graph.nodes.values()} == {"Remotion composition"}
    assert len(built) == 1
    cli_graph._current_default_labels.cache_clear()
