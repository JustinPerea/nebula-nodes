"""A personal agent's name inside a sentence is lower case ("your Claude"), at the
start of a sentence or label it keeps the capital (GM, copy sweep 2026-11-14).
An outside agent ("Claude Code") and a stored older name ("Claude (your setup)")
come out unchanged. One row per sentence family built outside a route."""
from __future__ import annotations

import pytest

from services import agent_questions, asset_proposals, canvas_proposals, pending_nodes

NAMES = [("Your Claude", "your Claude"), ("Claude Code", "Claude Code"),
         ("Claude (your setup)", "Claude (your setup)")]


class _Agent:
    def __init__(self, name):
        self.name = name


class _Item:
    def __init__(self, name, status="withdrawn"):
        self.agent = _Agent(name)
        self.status = status


@pytest.mark.parametrize("name,said", NAMES)
def test_withdrawn_by_names_the_agent_inside_the_sentence(name, said):
    assert canvas_proposals.update_outcome(_Item(name)) == f"Withdrawn by {said}"
    assert agent_questions.update_outcome(_Item(name)) == f"Withdrawn by {said}."
    assert asset_proposals.outcome_line(_Item(name)) == f"Withdrawn by {said}"


@pytest.mark.parametrize("name,said", NAMES)
def test_a_placeholders_downstream_reason_and_skip_line(name, said):
    assert pending_nodes.downstream_reason("Hero prompt", name) == f"needs “Hero prompt”, which {said} is still setting up."
    assert pending_nodes.skip_line({"count": 2, "agents": [name]}) == f"Skipped 2 nodes {said} is still setting up."
    # The label-start line keeps the capital.
    assert pending_nodes.pending_reason(name) == f"{name} is still setting this up."


@pytest.mark.parametrize("name,said", NAMES)
def test_an_undo_summary_names_whose_edit_it_reverted(name, said):
    import main

    owner = main._undo_owner_text({"kind": "agent", "id": "a1", "name": name}, by={"kind": "agent", "id": "b2"})
    assert owner == f"{said}’s edit"
