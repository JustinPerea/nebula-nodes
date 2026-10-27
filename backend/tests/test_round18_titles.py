"""Round 18: an unnamed node's canvas title drops the gateway its name names.

GM - Design (r18, item 1), verbatim: "Unnamed node: the default title drops
the route. "Grok Imagine 2.0" ... Only for nodes whose route depends on keys."
Follow-up: "build the canvas-title-only version. The library and search keep
the catalog names, nothing is migrated". "Unnamed = the saved label equals the
catalog name or the stripped name. New nodes are saved with the stripped
title." frontend/src/lib/directRoute.ts canvasTitle is the same rule.
"""
from __future__ import annotations

import main as main_module
from services import node_route

node_registry = main_module.node_registry

GROK = "krea-image-xai-grok-imagine-2"


def _definition(definition_id: str):
    return node_registry.get(definition_id) or {}


def test_canvas_title_strips_the_gateway_only_when_the_route_depends_on_keys():
    assert node_route.canvas_title(_definition(GROK)) == "Grok Imagine 2.0"
    assert node_route.canvas_title(_definition("nano-banana-fal")) == "Nano Banana"
    # The catalog keeps its names.
    assert _definition(GROK)["displayName"] == "Grok Imagine 2.0 (Krea)"
    single = [d for d in node_registry.get_all().values()
              if str(d.get("displayName", "")).endswith((" (Krea)", " (FAL)")) and not node_route.route_depends_on_keys(d)]
    assert single, "a suffixed node with one route exists"
    for definition in single:
        assert node_route.canvas_title(definition) == definition["displayName"]


def test_the_count_matches_the_frontend_rule():
    stripped = [d for d in node_registry.get_all().values() if node_route.canvas_title(d) != d.get("displayName")]
    assert len(stripped) == 44


def test_either_form_is_no_name_of_its_own():
    assert main_module._custom_node_label("Grok Imagine 2.0 (Krea)", GROK) is None
    assert main_module._custom_node_label("Grok Imagine 2.0", GROK) is None
    assert main_module._custom_node_label("  Grok   Imagine 2.0 ", GROK) is None
    assert main_module._custom_node_label("Alt still", GROK) == "Alt still"
    # Another node's stripped name is a name.
    assert main_module._custom_node_label("Nano Banana", GROK) == "Nano Banana"


def test_an_unnamed_node_syncs_with_its_canvas_title():
    all_defs = node_registry.get_all()
    rf = main_module._cli_node_to_rf({"id": "n1", "definitionId": GROK, "params": {}}, {"x": 0, "y": 0}, all_defs)
    assert rf["data"]["label"] == "Grok Imagine 2.0"
    named = main_module._cli_node_to_rf({"id": "n2", "definitionId": GROK, "params": {}, "label": "Alt still"},
                                        {"x": 0, "y": 0}, all_defs)
    assert named["data"]["label"] == "Alt still"
    other = main_module._cli_node_to_rf({"id": "n3", "definitionId": "gpt-image-1-5", "params": {}}, {"x": 0, "y": 0}, all_defs)
    assert other["data"]["label"] == all_defs["gpt-image-1-5"]["displayName"]
