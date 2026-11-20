"""A node type's former default title still finds it by name (nebula info / describe, MCP describe_node).

"Jev Box (experimental)" became "Jev Box · experimental" (design); an agent that learned the old
name, or a doc that still carries it, resolves to the same definition id.
"""
from __future__ import annotations

from services import node_lookup
from services.node_route import FORMER_DEFAULT_TITLES

DEFINITIONS = {
    "jev-box": {"id": "jev-box", "displayName": "Jev Box · experimental"},
    "camera-rig": {"id": "camera-rig", "displayName": "Camera rig"},
    "text-input": {"id": "text-input", "displayName": "Text"},
}


def test_former_title_resolves_to_its_definition():
    found = node_lookup.resolve("Jev Box (experimental)", DEFINITIONS)
    assert found.definition_id == "jev-box"
    assert found.note == "Jev Box (experimental) is the Jev Box · experimental node: jev-box"


def test_every_former_title_resolves_ignoring_case_and_outer_spaces():
    for definition_id, former in FORMER_DEFAULT_TITLES.items():
        defs = {definition_id: {"id": definition_id, "displayName": "Renamed"}}
        assert node_lookup.resolve(f"  {former.upper()} ", defs).definition_id == definition_id


def test_current_name_and_id_still_win():
    assert node_lookup.resolve("jev-box", DEFINITIONS).definition_id == "jev-box"
    assert node_lookup.resolve("Jev Box · experimental", DEFINITIONS).definition_id == "jev-box"
    assert node_lookup.resolve("camera rig", DEFINITIONS).definition_id == "camera-rig"


def test_a_former_title_shared_with_another_current_name_refuses_and_lists_both():
    defs = dict(DEFINITIONS)
    defs["zz-twin"] = {"id": "zz-twin", "displayName": "Jev Box (experimental)"}
    found = node_lookup.resolve("Jev Box (experimental)", defs)
    assert found.definition_id is None
    assert found.named == ("jev-box", "zz-twin")


def test_a_write_refusal_names_the_node_the_former_title_was():
    assert node_lookup.write_hint("Jev Box (experimental)", DEFINITIONS) == \
        ": did you mean jev-box (Jev Box · experimental)?"
