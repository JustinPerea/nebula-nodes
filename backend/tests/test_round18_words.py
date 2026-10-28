"""Round 18: the cursor bubble and the Agent log words for an agent setting fields.

GM - Design (r18, item 3), verbatim: "Cursor bubble for 3 or more labels:
"Changed N settings" (was "Set N settings"). Keep "Set “Aspect ratio”" for
one or two labels."

Review 17 (nit): a universal node's configured model brings its own fields
(``dynamicParams``); the Agent log listed their labels in key order, not in
the order the card shows them. They now follow the card.
"""
from __future__ import annotations

import pytest

import main as main_module
from services.cli_graph import CLIGraph

DEFINITION = {"params": [
    {"key": "aspect_ratio", "label": "Aspect ratio"},
    {"key": "resolution", "label": "Resolution"},
    {"key": "quality", "label": "Quality"},
    {"key": "seed_mode", "label": "Seed mode", "hidden": True},
]}


@pytest.fixture
def graph(monkeypatch):
    graph = CLIGraph()
    monkeypatch.setattr(main_module, "cli_graph", graph)
    monkeypatch.setattr(main_module.node_registry, "get", lambda definition_id: DEFINITION if definition_id == "text-input" else {"params": []})
    monkeypatch.setattr(main_module.node_route, "all_param_definitions", lambda definition: definition.get("params") or [])
    return graph


def test_three_labels_say_changed_n_settings(graph):
    node = graph.add_node("text-input", {})
    say, log = main_module._set_words(node, ["quality", "resolution", "aspect_ratio"])
    assert say == "Changed 3 settings"
    # The Agent log keeps naming them (round 17).
    assert log == "Set “Aspect ratio”, “Resolution” and “Quality”"


def test_one_and_two_labels_keep_set(graph):
    node = graph.add_node("text-input", {})
    assert main_module._set_words(node, ["aspect_ratio"])[0] == "Set “Aspect ratio”"
    assert main_module._set_words(node, ["resolution", "aspect_ratio"])[0] == "Set “Aspect ratio” and “Resolution”"


def test_an_unlabelled_field_is_not_counted(graph):
    node = graph.add_node("text-input", {})
    assert main_module._set_words(node, ["seed_mode", "resolution", "aspect_ratio"])[0] == "Set “Aspect ratio” and “Resolution”"


def test_a_universal_nodes_fields_follow_the_card_order(graph):
    node = graph.add_node("openrouter-universal", {})
    graph.nodes[node]["dynamicParams"] = [
        {"key": "zeta_steps", "label": "Steps"},
        {"key": "alpha_guidance", "label": "Guidance"},
        {"key": "mid_seed", "label": "Seed"},
    ]
    _, log = main_module._set_words(node, ["alpha_guidance", "mid_seed", "zeta_steps"])
    assert log == "Set “Steps”, “Guidance” and “Seed”"
    say, _ = main_module._set_words(node, ["alpha_guidance", "zeta_steps"])
    assert say == "Set “Steps” and “Guidance”"
