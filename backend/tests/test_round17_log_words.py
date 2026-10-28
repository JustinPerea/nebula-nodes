"""Round 17 (GM, item 2): the Agent log line for an agent setting fields.

GM, verbatim: "Mixed labelled and unlabelled fields: labelled first in card
order, then raw keys, no serial comma. "Set “Aspect ratio”, “Seed” and
seed_mode". Cap at 4 names then "and N more": "Set “Aspect ratio”, “Seed”,
seed_mode, cfg and 2 more"."

The cursor's bubble is unchanged (round 16): labels only, counted from three.
"""
from __future__ import annotations

import pytest

import main as main_module
from services.cli_graph import CLIGraph

DEFINITION = {"params": [
    {"key": "aspect_ratio", "label": "Aspect ratio"},
    {"key": "seed_mode", "label": "Seed mode", "hidden": True},
    {"key": "seed", "label": "Seed"},
    {"key": "cfg", "label": "", "hidden": True},
    {"key": "steps", "label": "Steps"},
    {"key": "style", "label": "Style"},
]}


@pytest.fixture
def node(monkeypatch):
    graph = CLIGraph()
    monkeypatch.setattr(main_module, "cli_graph", graph)
    monkeypatch.setattr(main_module.node_registry, "get", lambda definition_id: DEFINITION)
    monkeypatch.setattr(main_module.node_route, "all_param_definitions", lambda definition: definition.get("params") or [])
    return graph.add_node("text-input", {})


def log(node_id: str, keys: list[str]) -> str:
    return main_module._set_words(node_id, keys)[1]


def test_labelled_fields_come_first_then_raw_keys_no_serial_comma(node):
    # Sent in any order: the labels lead in card order, then the raw keys.
    assert log(node, ["seed_mode", "seed", "aspect_ratio"]) == "Set “Aspect ratio”, “Seed” and seed_mode"


def test_raw_keys_keep_the_card_order_among_themselves(node):
    assert log(node, ["cfg", "seed_mode", "aspect_ratio"]) == "Set “Aspect ratio”, seed_mode and cfg"


def test_a_key_no_card_names_follows_the_card_keys(node):
    assert log(node, ["zeta", "seed_mode", "seed"]) == "Set “Seed”, seed_mode and zeta"


def test_capped_at_four_names_then_and_n_more(node):
    keys = ["cfg", "seed_mode", "seed", "aspect_ratio", "zeta", "omega"]
    assert log(node, keys) == "Set “Aspect ratio”, “Seed”, seed_mode, cfg and 2 more"


def test_labelled_beyond_four_are_counted_in_the_more(node):
    keys = ["aspect_ratio", "seed", "steps", "style", "seed_mode"]
    assert log(node, keys) == "Set “Aspect ratio”, “Seed”, “Steps”, “Style” and 1 more"


def test_four_names_are_all_named(node):
    assert log(node, ["aspect_ratio", "seed", "seed_mode", "cfg"]) == "Set “Aspect ratio”, “Seed”, seed_mode and cfg"


def test_the_bubble_is_unchanged(node):
    say, _ = main_module._set_words(node, ["seed_mode", "seed", "aspect_ratio"])
    assert say == "Set “Aspect ratio” and “Seed”"
