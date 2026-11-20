"""A personal agent's name inside a sentence is lower case ("your Claude"), at the
start of a sentence or label it keeps the capital (design, copy sweep 2026-11-14).
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
    """The agent that asked and closed it is the Update's header: no "by". Anyone else keeps it."""
    other = {"kind": "agent", "name": name}
    assert canvas_proposals.update_outcome(_Item("Someone else"), other) == f"Withdrawn by {said}"
    assert agent_questions.update_outcome(_Item("Someone else"), other) == f"Withdrawn by {said}."
    assert asset_proposals.outcome_line(_Item("Someone else"), other) == f"Withdrawn by {said}"
    assert canvas_proposals.update_outcome(_Item(name), other) == "Withdrawn"
    assert agent_questions.update_outcome(_Item(name)) == "Withdrawn."
    assert asset_proposals.outcome_line(_Item(name), {"kind": "agent", "name": name}) == "Withdrawn"


@pytest.mark.parametrize("name,said", NAMES)
def test_withdrawn_by_the_person_says_you(name, said):
    person = {"kind": "person"}
    assert canvas_proposals.update_outcome(_Item(name), person) == "Withdrawn by you"
    assert agent_questions.update_outcome(_Item(name), person) == "Withdrawn by you."
    assert asset_proposals.outcome_line(_Item(name), person) == "Withdrawn by you"


def test_every_other_outcome_line_has_no_by_phrase():
    """Rejected, accepted, expired, no longer fits and the kept/applied lines never carried one."""
    for status, line in (("accepted", "Accepted"), ("rejected", "Rejected"), ("expired", "Expired"),
                         ("invalidated", "No longer fits")):
        assert canvas_proposals.update_outcome(_Item("Claude Code", status), {"kind": "person"}) == line
    for status in ("answered", "dismissed"):
        assert " by " not in agent_questions.update_outcome(_Item("Claude Code", status), {"kind": "person"})


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


def test_the_author_sits_beside_the_outcome_in_nebula_notes():
    """`nebula notes` and `list_notes` print the Update's author beside the line, so a withdraw by the author
    reads "Claude Code · Proposes 1 change on the canvas [Withdrawn]", and one by anyone else still says who."""
    from cli.commands.notes import format_note
    base = {"id": "n1", "at": "2026-11-20T12:00:00+00:00", "author": {"kind": "agent", "name": "Claude Code"},
            "about": "proposal", "text": "Proposes 1 change on the canvas", "resolvedAt": "2026-11-20T12:05:00+00:00"}
    mine = canvas_proposals.update_outcome(_Item("Claude Code"), {"kind": "agent", "name": "Claude Code"})
    assert "Claude Code [Withdrawn]  Proposes 1 change" in format_note({**base, "outcome": mine})
    yours = canvas_proposals.update_outcome(_Item("Claude Code"), {"kind": "person"})
    assert "Claude Code [Withdrawn by you]" in format_note({**base, "outcome": yours})
    other = canvas_proposals.update_outcome(_Item("Claude Code"), {"kind": "agent", "name": "Codex"})
    assert "Claude Code [Withdrawn by Codex]" in format_note({**base, "outcome": other})
