"""Every canvas proposal posts an Update (Justin's Q112 a, 2026-10-21).

"a) Yes, every one: "Claude Code proposes 3 changes on the canvas", with
Review taking you to the canvas and its bar. It settles like the others
(Accepted, Rejected, Expired, Closed: Nebula restarted)."

Asset proposals have posted an Update since Q92 a (#149), and the Updates
corner is on every screen since Q107 a. A canvas proposal (MCP
propose_change, `nebula propose`, POST /api/canvas/proposals) now posts one
too, from one place in the backend (the create route every surface calls):
attributed to the agent, Nebula's own template words (never the agent's
note), one Review action that takes the person to the canvas with that
proposal in the bar. Every proposal gets its own Update (no "one per agent
and target" here: each canvas proposal is its own ask). It settles in place
when the proposal ends, however it ends, and Nebula writes it on the agent's
behalf, so it never counts against the agent's post_note budget.
"""
from __future__ import annotations

import io
import json

import pytest

from services.agent_notes import RATE_LIMIT, AgentNotes
from services.canvas_proposals import PROPOSAL_TTL_SECONDS, ProposalBook
from tests.conftest import PERSON
from tests.test_canvas_proposals import (  # noqa: F401 - api is a fixture
    CLAUDE,
    CODEX,
    KEY,
    _key,
    _propose,
    _propose_args,
    _upscale_body,
    api,
)


@pytest.fixture
def canvas(api, monkeypatch):
    """The canvas proposal app, with its own Updates service (a fresh rate
    limiter) and every one-shot timer recorded instead of left on a loop."""
    monkeypatch.setattr(api.main, "agent_notes", AgentNotes(lambda: api.main.project_store))
    api.timers = []
    monkeypatch.setattr(api.main, "_call_later", lambda delay, fn, *args: api.timers.append((delay, fn, args)))
    return api


def _notes(api) -> list[dict]:
    return list(api.main.project_store.read()["projects"][api.project_id].get("agentNotes") or [])


def _updates(api) -> list[dict]:
    return [note for note in _notes(api) if note.get("about") == "proposal"]


def _note_messages(api, op=None) -> list[dict]:
    return [m for m in api.sent if m.get("type") == "agentNotes" and (op is None or m["op"] == op)]


def _review(note: dict) -> dict:
    (action,) = note["actions"]
    assert action["label"] == "Review"
    return action["op"]


def _three_changes(api) -> dict:
    """One new node, one wire into it and one param change on an existing node."""
    n1 = api.graph.add_node("text-input", {"value": "a cat"})
    return {**_upscale_body(n1), "note": "Make the hero image from the cat line",
            "params": [{"nodeId": n1, "params": {"value": "a cat at dusk"}}]}


# -- posting --------------------------------------------------------------------------

def test_an_mcp_proposal_posts_one_update_with_review(canvas, monkeypatch):
    import mcp_server
    from nebula_api import NebulaAPI

    monkeypatch.delenv("NEBULA_AGENT_TOKEN", raising=False)
    monkeypatch.setenv("NEBULA_AGENT_NAME", "Claude Code")
    monkeypatch.setattr(mcp_server, "_api", lambda: NebulaAPI("http://testserver", client=canvas.client))
    body = _three_changes(canvas)
    response = mcp_server.propose_change(note=body["note"], nodes=body["nodes"], edges=body["edges"],
                                         params=body["params"], run=body["run"])
    view = response["proposal"]
    (note,) = _updates(canvas)
    assert note["text"] == "Claude Code proposes 3 changes on the canvas"
    assert note["source"] == "nebula" and note["about"] == "proposal"
    assert note["author"]["kind"] == "agent" and note["author"]["name"] == "Claude Code"
    assert note["author"]["color"] == view["agent"]["color"]
    assert note["proposal"] == {"id": view["id"], "kind": "canvas", "targetId": canvas.project_id}
    assert _review(note) == {"kind": "proposal.review", "proposalId": view["id"], "target": "canvas",
                             "targetId": canvas.project_id}
    # Template words only: the agent's note is the bar's, not the Update's.
    assert "cat" not in json.dumps(note)
    assert not note.get("readAt") and not note.get("resolvedAt")
    assert note["refs"] == []

    (added,) = _note_messages(canvas, "added")
    assert added["surface"] == "canvas" and added["projectId"] == canvas.project_id
    assert added["note"]["id"] == note["id"] and added["unread"] == 1
    # The view names it, as an asset proposal's does.
    assert view["update"] == {"id": note["id"], "projectId": canvas.project_id}
    read = canvas.client.get(f"/api/canvas/proposals/{view['id']}", headers=CLAUDE).json()["proposal"]
    assert read["update"] == {"id": note["id"], "projectId": canvas.project_id}
    posted = [e for e in canvas.journal.read(after=0, limit=100)["events"] if e["kind"] == "note.posted"]
    assert len(posted) == 1 and posted[0]["actor"]["name"] == "Claude Code"


def test_a_cli_proposal_posts_the_same_update(canvas):
    """`nebula propose` reaches the same create route, so the same Update: one change, singular."""
    from cli.client import NebulaClient
    from cli.commands import proposals as proposals_cmd

    client = NebulaClient("http://testserver")
    client._client = canvas.client
    out = io.StringIO()
    code = proposals_cmd.run_propose(client, _propose_args(wait=False, agent_name="Codex"), out=out)
    assert code == 0, out.getvalue()
    (note,) = _updates(canvas)
    assert note["text"] == "Codex proposes 1 change on the canvas"
    assert note["author"]["name"] == "Codex"
    (proposal,) = canvas.book.open_list()
    assert _review(note)["proposalId"] == proposal.id


def test_what_counts_as_a_change(canvas):
    """Each new node, each wire and each existing node whose params change
    is one change (the bar's own groups); a run and a new node's name are not."""
    n1 = canvas.graph.add_node("text-input", {"value": "a"})
    n2 = canvas.graph.add_node("text-input", {"value": "b"})
    _propose(canvas, {"note": "Two settings", "params": [{"nodeId": n1, "params": {"value": "x"}},
                                                          {"nodeId": n2, "params": {"value": "y"}}], "run": [n1]})
    _propose(canvas, {"note": "Name it", "nodes": [{"ref": "+t", "definitionId": "text-input"}],
                      "rename": {"+t": "Hero line"}})
    _propose(canvas, {"note": "Just run it", "run": [n1]}, headers=CODEX)
    texts = [note["text"] for note in _updates(canvas)]
    assert texts == ["Claude Code proposes 2 changes on the canvas", "Claude Code proposes 1 change on the canvas",
                     "Codex proposes a run on the canvas"]


def test_every_proposal_gets_its_own_update(canvas):
    """Q112: "every one". Unlike an asset proposal's, a second canvas proposal
    from the same agent doesn't replace the first one's Update."""
    n1 = canvas.graph.add_node("text-input", {"value": "a cat"})
    first = _propose(canvas, _upscale_body(n1)).json()["proposal"]["id"]
    second = _propose(canvas, _upscale_body(n1)).json()["proposal"]["id"]
    assert [_review(note)["proposalId"] for note in _updates(canvas)] == [first, second]
    assert all(m["removed"] == [] for m in _note_messages(canvas, "added"))


def test_no_open_project_means_no_update_but_the_proposal_opens(canvas):
    store = canvas.main.project_store
    catalog = store.read()
    catalog["activeProjectId"] = None
    store.commit(catalog)
    canvas.graph.add_node("text-input", {"value": "a cat"})
    made = _propose(canvas, _upscale_body("n1"))
    assert made.status_code == 201, made.text
    assert made.json()["proposal"]["update"] is None
    assert not _note_messages(canvas, "added")


def test_the_update_skips_the_agents_post_note_budget(canvas):
    """Nebula writes it on the agent's behalf: an agent that used its six
    updates this minute still gets its proposal's Update, and a proposal
    leaves all six for post_note."""
    n1 = canvas.graph.add_node("text-input", {"value": "a cat"})
    assert _propose(canvas, _upscale_body(n1)).status_code == 201
    for index in range(RATE_LIMIT):
        posted = canvas.client.post("/api/canvas/agent-notes", headers=CLAUDE, json={"text": f"noticed {index}"})
        assert posted.status_code == 201, (index, posted.text)
    refused = canvas.client.post("/api/canvas/agent-notes", headers=CLAUDE, json={"text": "one too many"})
    assert refused.status_code == 429
    assert _propose(canvas, _upscale_body(n1)).status_code == 201
    assert len(_updates(canvas)) == 2


def test_the_project_cap_prunes_as_before(canvas, monkeypatch):
    from services import agent_notes

    monkeypatch.setattr(agent_notes, "MAX_PROJECT_NOTES", 3)
    n1 = canvas.graph.add_node("text-input", {"value": "a cat"})
    for index in range(3):
        canvas.client.post("/api/canvas/agent-notes", headers=CODEX, json={"text": f"noticed {index}"})
    _propose(canvas, _upscale_body(n1))
    notes = _notes(canvas)
    assert len(notes) == 3 and notes[-1]["about"] == "proposal"
    assert len(_note_messages(canvas, "added")[-1]["removed"]) == 1


# -- it settles in place, however the proposal ends ---------------------------------------

def _settled(api) -> dict:
    (note,) = _updates(api)
    assert note["resolvedAt"] and note["readAt"], note
    return note


def _proposed(api, headers=CLAUDE) -> dict:
    n1 = api.graph.nodes and next(iter(api.graph.nodes)) or api.graph.add_node("text-input", {"value": "a cat"})
    response = _propose(api, _upscale_body(n1), headers=headers)
    assert response.status_code == 201, response.text
    return response.json()["proposal"]


def test_accepting_settles_it_as_accepted(canvas):
    view = _proposed(canvas)
    accepted = canvas.client.post(f"/api/canvas/proposals/{view['id']}/accept",
                                  headers={**PERSON, KEY: _key(canvas, view["id"])}, json={})
    assert accepted.status_code == 200, accepted.text
    note = _settled(canvas)
    assert note["outcome"] == "Accepted" and note["resolvedBy"] == {"kind": "person"}
    (resolved,) = _note_messages(canvas, "resolved")
    assert resolved["note"]["id"] == note["id"] and resolved["unread"] == 0
    assert resolved["projectId"] == canvas.project_id
    # The agent reads the outcome in list_notes.
    listed = canvas.client.get("/api/canvas/agent-notes", headers=CLAUDE).json()["notes"]
    assert next(n for n in listed if n["id"] == note["id"])["outcome"] == "Accepted"


def test_rejecting_settles_it_as_rejected_without_the_persons_reason(canvas):
    view = _proposed(canvas)
    canvas.client.post(f"/api/canvas/proposals/{view['id']}/reject", json={"reason": "Too wide a crop"},
                       headers={**PERSON, KEY: _key(canvas, view["id"])})
    note = _settled(canvas)
    assert note["outcome"] == "Rejected" and note["resolvedBy"] == {"kind": "person"}
    assert "wide a crop" not in json.dumps(note)


def test_withdrawing_settles_it_as_withdrawn_by_the_agent(canvas):
    view = _proposed(canvas)
    assert canvas.client.delete(f"/api/canvas/proposals/{view['id']}", headers=CLAUDE).status_code == 200
    note = _settled(canvas)
    assert note["outcome"] == "Withdrawn by Claude Code"
    assert note["resolvedBy"] == {"kind": "agent", "name": "Claude Code"}


def test_it_expires_on_time_without_any_read(canvas):
    """Nobody reads proposals (the agent stopped, the person is on Projects):
    only a timer can close it when it's due, so the corner loses its Review."""
    import asyncio

    view = _proposed(canvas)
    (timer,) = canvas.timers
    assert PROPOSAL_TTL_SECONDS <= timer[0] <= PROPOSAL_TTL_SECONDS + 2
    canvas.clock.now += PROPOSAL_TTL_SECONDS + 1
    canvas.sent.clear()
    _, fn, args = timer

    async def fire():
        fn(*args)
        await asyncio.gather(*list(canvas.main._proposal_expiry_tasks))

    asyncio.run(fire())
    note = _settled(canvas)
    assert note["outcome"] == "Expired" and note["resolvedBy"] == {"kind": "system"}
    assert [m["note"]["id"] for m in _note_messages(canvas, "resolved")] == [note["id"]]
    assert canvas.book.get(view["id"]).status == "expired"


def test_it_expires_on_the_next_read_too(canvas):
    _proposed(canvas)
    canvas.clock.now += PROPOSAL_TTL_SECONDS + 1
    listed = canvas.client.get("/api/canvas/agent-notes", headers=CLAUDE).json()["notes"]
    (note,) = [n for n in listed if n["about"] == "proposal"]
    assert note["outcome"] == "Expired"


def test_deleting_a_node_it_needs_settles_it_as_no_longer_fits(canvas):
    view = _proposed(canvas)
    (reference,) = view["references"]
    assert canvas.client.delete(f"/api/graph/node/{reference}", headers=PERSON).status_code == 200
    note = _settled(canvas)
    assert note["outcome"] == "No longer fits" and note["resolvedBy"] == {"kind": "system"}


def test_clearing_or_replacing_the_canvas_settles_it_as_no_longer_fits(canvas):
    _proposed(canvas)
    assert canvas.client.delete("/api/graph?force=true", headers=PERSON).status_code == 200
    assert _settled(canvas)["outcome"] == "No longer fits"
    canvas.graph.add_node("text-input", {"value": "again"})
    second = _proposed(canvas)
    imported = canvas.client.post("/api/graph/import", headers=PERSON, json={"nodes": [], "edges": []})
    assert imported.status_code == 200, imported.text
    note = next(n for n in _updates(canvas) if _review(n)["proposalId"] == second["id"])
    assert note["outcome"] == "No longer fits"


def test_the_persons_later_edit_settles_it_at_accept(canvas):
    """The person changed a value the proposal sets: Accept is refused (409)
    and the proposal is invalidated, so its Update no longer fits either."""
    n1 = canvas.graph.add_node("text-input", {"value": "old"})
    view = _propose(canvas, {"note": "Retitle", "params": [{"nodeId": n1, "params": {"value": "agent's"}}]}).json()[
        "proposal"]
    canvas.graph.update_params(n1, {"value": "person's"})
    refused = canvas.client.post(f"/api/canvas/proposals/{view['id']}/accept",
                                 headers={**PERSON, KEY: _key(canvas, view["id"])}, json={})
    assert refused.status_code == 409
    note = _settled(canvas)
    assert note["outcome"] == "No longer fits" and note["resolvedBy"] == {"kind": "person"}


def test_opening_another_project_settles_it_in_its_own_project(canvas):
    from services.project_store import make_project

    store = canvas.main.project_store
    with store.transaction() as catalog:
        other = make_project("Other")
        catalog["projects"][other["id"]] = other
        store.commit(catalog)
    _proposed(canvas)
    canvas.sent.clear()
    revision = store.read()["workspaceRevision"]
    opened = canvas.client.post(f"/api/projects/{other['id']}/open", json={"workspaceRevision": revision},
                                headers=PERSON)
    assert opened.status_code == 200, opened.text
    note = _settled(canvas)  # still on the first project's list
    assert note["outcome"] == "No longer fits"
    # Not the open project's list: no "resolved" message lands on the wrong one.
    assert not _note_messages(canvas, "resolved")


def test_a_restart_closes_an_open_ones_update(canvas, monkeypatch):
    """Proposals live in memory and Updates with the project: after a restart
    the Update reads "Closed: Nebula restarted" (Q108 a's outcome), the next
    time its list is read."""
    from services.asset_proposals import RESTART_OUTCOME

    _proposed(canvas)
    monkeypatch.setattr(canvas.main, "canvas_proposals", ProposalBook(canvas.clock))
    listed = canvas.client.get("/api/canvas/agent-notes", headers=CLAUDE).json()["notes"]
    (note,) = [n for n in listed if n["about"] == "proposal"]
    assert RESTART_OUTCOME == "Closed: Nebula restarted"
    assert note["outcome"] == RESTART_OUTCOME and note["resolvedBy"] == {"kind": "system"}


def test_a_restart_closes_it_when_the_persons_tab_reconnects(canvas, monkeypatch):
    _proposed(canvas)
    monkeypatch.setattr(canvas.main, "canvas_proposals", ProposalBook(canvas.clock))
    with canvas.client.websocket_connect("/ws", headers=PERSON) as ws:
        kinds = [ws.receive_json()["type"] for _ in range(3)]
    assert kinds == ["graphSync", "canvasPins", "agentNotes"]
    assert _settled(canvas)["outcome"] == "Closed: Nebula restarted"


def test_an_open_proposals_update_is_left_alone(canvas):
    _proposed(canvas)
    listed = canvas.client.get("/api/canvas/agent-notes", headers=CLAUDE).json()["notes"]
    (note,) = [n for n in listed if n["about"] == "proposal"]
    assert not note.get("resolvedAt") and not note.get("outcome")


# -- agents read it ---------------------------------------------------------------------

def test_mcp_list_notes_shows_the_outcome(canvas, monkeypatch):
    import mcp_server
    from nebula_api import NebulaAPI

    monkeypatch.setenv("NEBULA_AGENT_NAME", "Claude Code")
    monkeypatch.setattr(mcp_server, "_api", lambda: NebulaAPI("http://testserver", client=canvas.client))
    view = _proposed(canvas)
    mcp_server.withdraw_proposal(view["id"])
    (note,) = [n for n in mcp_server.list_notes()["notes"] if n["about"] == "proposal"]
    assert note["outcome"] == "Withdrawn by Claude Code"


def test_nebula_notes_prints_the_outcome(canvas):
    from cli.commands.notes import format_note

    view = _proposed(canvas)
    (note,) = _updates(canvas)
    assert "waiting for your OK" in format_note(note) and "proposes 2 changes on the canvas" in format_note(note)
    canvas.client.post(f"/api/canvas/proposals/{view['id']}/reject", headers={**PERSON, KEY: _key(canvas, view["id"])})
    line = format_note(_settled(canvas))
    assert "[Rejected]" in line and "waiting for your OK" not in line


def test_agents_are_told_the_person_sees_an_update_so_they_dont_post_one():
    """propose_change, `nebula propose`, MCP-SETUP and the skill say every
    proposal posts an Update with Review wherever the person is, and that a
    post_note announcing it would be a second notice."""
    from pathlib import Path

    import mcp_server
    from cli.__main__ import build_parser

    root = Path(__file__).resolve().parents[2]
    doc = " ".join((mcp_server.propose_change.__doc__ or "").split())
    assert "Update" in doc and "Review" in doc and "every screen" in doc
    assert "don't also post_note" in doc
    assert "Withdrawn by" in doc and "Closed: Nebula restarted" in doc
    listing = " ".join((mcp_server.list_notes.__doc__ or "").split())
    assert "propose_change" in listing

    parser = build_parser()
    propose = parser._subparsers._group_actions[0].choices["propose"]
    description = " ".join((propose.description or "").split())
    assert "Update" in description and "nebula note" in description

    setup = (root / "docs" / "MCP-SETUP.md").read_text(encoding="utf-8")
    section = setup.split("### Proposals\n", 1)[1].split("\n### ", 1)[0]
    flat = " ".join(section.split())
    assert "Claude Code proposes 3 changes on the canvas" in flat and "Review" in flat
    assert "post_note" in flat and "Closed: Nebula restarted" in flat
    skill = " ".join((root / "skills" / "nebula" / "SKILL.md").read_text(encoding="utf-8").split())
    assert "proposes 3 changes on the canvas" in skill and "don't also post a `nebula note`" in skill


# -- review follow-ups ------------------------------------------------------------------

def test_a_proposal_that_closes_while_its_update_is_written_settles_at_once(canvas, monkeypatch):
    """The Update is written off the event loop, after the proposal is in the
    book. A close that lands in that gap (the person deletes a node it needs,
    clears the canvas, opens another project) finds no Update yet to settle.
    So once the Update exists it settles at once, with the real outcome; no
    timer is left for it, and the canvas never gets the dead proposal as
    open (Accept would only fail)."""
    real = canvas.main.agent_notes.post_proposal

    def closes_meanwhile(**kwargs):
        canvas.main.canvas_proposals.invalidate_all("the canvas was cleared")
        return real(**kwargs)

    monkeypatch.setattr(canvas.main.agent_notes, "post_proposal", closes_meanwhile)
    n1 = canvas.graph.add_node("text-input", {"value": "a cat"})
    canvas.sent.clear()
    made = _propose(canvas, _upscale_body(n1))
    assert made.status_code == 201, made.text
    view = made.json()["proposal"]
    assert view["status"] == "invalidated"
    note = _settled(canvas)
    assert note["outcome"] == "No longer fits" and note["resolvedBy"] == {"kind": "system"}
    assert [m["note"]["id"] for m in _note_messages(canvas, "resolved")] == [note["id"]]
    assert not [m for m in canvas.sent if m.get("type") == "proposalOpened"]
    assert canvas.timers == []
    assert "warning" not in made.json() and "withdrawWith" not in made.json()


def test_a_new_proposal_folds_away_the_same_agents_withdrawn_update(canvas):
    """Q109's "withdraw it first, then propose again": the withdrawn one's
    Update leaves the list when the same agent proposes again (the socket's
    `removed`), so a propose/withdraw loop can't flood the list or push the
    person's older Updates past the cap. Only the agent's own withdrawn
    ones: another agent's, and anything the person decided, expired or
    still open, stay ("every one")."""
    n1 = canvas.graph.add_node("text-input", {"value": "a cat"})
    first = _propose(canvas, _upscale_body(n1)).json()["proposal"]
    canvas.client.delete(f"/api/canvas/proposals/{first['id']}", headers=CLAUDE)
    other = _propose(canvas, _upscale_body(n1), headers=CODEX).json()["proposal"]
    canvas.client.delete(f"/api/canvas/proposals/{other['id']}", headers=CODEX)
    rejected = _propose(canvas, _upscale_body(n1)).json()["proposal"]
    canvas.client.post(f"/api/canvas/proposals/{rejected['id']}/reject",
                       headers={**PERSON, KEY: _key(canvas, rejected["id"])})
    still_open = _propose(canvas, _upscale_body(n1)).json()["proposal"]
    withdrawn_note = first["update"]["id"]
    assert withdrawn_note not in {n["id"] for n in _updates(canvas)}
    assert [_review(n)["proposalId"] for n in _updates(canvas)] == [other["id"], rejected["id"], still_open["id"]]
    added = _note_messages(canvas, "added")
    assert added[2]["removed"] == [withdrawn_note]  # the reject's proposal folded it away
    assert added[3]["removed"] == []
