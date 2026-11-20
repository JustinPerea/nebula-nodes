"""An Update's line never starts with its author's name (design).

Every surface that draws an Update (the card, the Updates list) puts the
agent's header beside the line, so a line that repeats the name reads twice:
"Proposes 1 change on the canvas", not "Codex proposes 1 change on the
canvas". Covers every template Nebula writes for an agent: canvas proposals
(a change, a run, a held run), asset proposals (a cover, a moodboard, a
Commons ask) and question sets, open and closed.
"""
from __future__ import annotations

import pytest

from services import asset_proposals
from services.agent_presence import AgentIdentity
from services.agent_questions import QuestionBook, closed_update_text, parse_questions, update_text as question_text
from services.canvas_proposals import Proposal, ProposalSpec, update_text as canvas_text
from tests.test_canvas_proposals import Clock

NAMES = ("Codex", "Claude Code", "Claude Desktop", "Mallory")


def _agent(name: str) -> AgentIdentity:
    return AgentIdentity(id=f"ext:{name}", name=name, color="#7AD3FF", verified=False)


def _canvas(name: str, *, run=(), nodes=(), wait=None) -> Proposal:
    spec = ProposalSpec(note="", run=tuple(run), nodes=list(nodes))
    return Proposal(id="p_1", agent=_agent(name), project_id="pr", spec=spec, positions={}, created_at=0,
                    expires_at=1, cost={}, wait=wait)


def _asset(name: str, kind: str, change: dict, target_name: str = "Harbour") -> asset_proposals.AssetProposal:
    return asset_proposals.AssetProposal(id="pa_x", agent=_agent(name), kind=kind, target_id="t_1",
                                         target_name=target_name, change=change, before={}, note="",
                                         created_at=1.0, expires_at=2.0)


@pytest.mark.parametrize("name", NAMES)
def test_no_template_line_starts_with_its_authors_name(name):
    lines = [
        canvas_text(_canvas(name, run=("n1",))),
        canvas_text(_canvas(name, nodes=[{"id": "n1"}])),
        canvas_text(_canvas(name, run=("n1",), wait={"barLine": "This would pass the total.", "names": ["Writer"]})),
        asset_proposals.update_text(_asset(name, "project", {"cover": "x"})),
        asset_proposals.update_text(_asset(name, "project", {"cover": None})),
        asset_proposals.update_text(_asset(name, "moodboard", {"sendNotes": True})),
        asset_proposals.update_text(_asset(name, "commons", {"edits": [{}]})),
        asset_proposals.update_text(_asset(name, "commons", {"edits": [{}, {}]})),
        asset_proposals.update_text(_asset(name, "commons", {"edits": [{"membership": {"id": "m", "accept": True}}]})),
    ]
    book = QuestionBook(Clock())
    for body in ({"questions": [{"text": "Crop?"}]}, {"questions": [{"text": "Crop?"}, {"text": "Size?"}]}):
        made = book.create(agent=_agent(name), project_id="p", spec=parse_questions(body))
        lines += [question_text(made), closed_update_text(question_text(made))]
    for line in lines:
        assert line and not line.lower().startswith(name.lower()), line


def test_the_three_lines_design_named_and_the_moodboard_name_quoted():
    assert canvas_text(_canvas("Codex", nodes=[{"id": "n1"}])) == "Proposes 1 change on the canvas"
    assert asset_proposals.update_text(_asset("Codex", "moodboard", {"sendNotes": True})) == (
        "Asks to turn on “Moodboard notes to generators” for “Harbour”")
    book = QuestionBook(Clock())
    made = book.create(agent=_agent("Codex"), project_id="p", spec=parse_questions({"questions": [{"text": "Crop?"}]}))
    assert question_text(made) == "Has a question"
