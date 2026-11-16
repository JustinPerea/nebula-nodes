"""A node saved before the copy sweep carries a Title Case default label ("Video
Edit"). It no longer equals the definition's name, but it is still the default
title, not a name the person chose (final review LOW-4). The table lives in
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
