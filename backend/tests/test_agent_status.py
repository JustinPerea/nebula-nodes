"""The Agents panel's backend (Q125 item 2): a status line per agent, and the
roster the panel and agents read.

Justin, 2026-10-24: "Yes, all four, in that order" (merge-oks Q125); this is
item 2. An identified agent sets one line about what it is working on,
optionally on a node (`set_status`, `nebula status`, `POST
/api/canvas/status`). It lasts until the agent replaces or clears it, or
until STATUS_IDLE_SECONDS pass with no sign of that agent (any identified
request). In memory only, scoped to the open project. The roster (`GET
/api/canvas/agents`, `list_agents`, `nebula agents`) lists every agent that is
around: a live cursor, a live status, or open questions or proposals, with
needs-you counts and never another agent's content.

These tests pin the book, the routes and the roster. The agent surfaces (MCP,
CLI, docs) are in test_agent_status_agents.py.
"""
from __future__ import annotations

import asyncio
import json

import pytest

from services.agent_presence import AgentIdentity, AgentPresence
from services.agent_status import (
    MAX_STATUS_CHARS,
    STATUS_IDLE_SECONDS,
    AgentStatusBook,
    StatusError,
    Waiting,
    build_roster,
)
from services.asset_proposals import AssetChange, AssetProposalBook
from tests.conftest import PERSON
from tests.test_agent_questions import GOOD_ANSWERS, SECRET_ANSWER, TWO, _answer, asked  # noqa: F401 - fixture
from tests.test_canvas_proposals import CLAUDE, CODEX, Clock, api  # noqa: F401 - fixture

ME = AgentIdentity(id="ext:claude-code", name="Claude Code", color="#3FC1A5", verified=False)
OTHER = AgentIdentity(id="ext:codex", name="Codex", color="#F2C14E", verified=False)
GEMINI_ID = AgentIdentity(id="ext:gemini", name="Gemini", color="#5B9DFF", verified=False)

# Words that belong to one agent's exchange with the person: never in the roster.
QUESTION_TEXT = "Which crop for the hero?"
PROPOSAL_NOTE = "Secret plan for the hero grade"
ASSET_NOTE = "Secret cover idea for the dusk card"


# -- the book --------------------------------------------------------------------------

def test_set_replace_and_clear():
    clock = Clock()
    book = AgentStatusBook(clock)
    (event,) = book.set(ME, "Rendering the hero shots", node_id="n4", project_id="p1")
    assert event["type"] == "agentStatus" and event["change"] == "set"
    assert event["agent"] == ME.as_dict()
    assert event["status"]["text"] == "Rendering the hero shots" and event["status"]["nodeId"] == "n4"
    assert event["status"]["projectId"] == "p1"
    first_rev = event["rev"]

    clock.now += 5
    (event,) = book.set(ME, "Trying a warmer grade", node_id=None, project_id="p1")
    assert event["change"] == "set" and event["status"]["text"] == "Trying a warmer grade"
    assert event["status"]["nodeId"] is None and event["rev"] > first_rev
    assert book.get(ME.id).text == "Trying a warmer grade"

    (event,) = book.set(ME, "   ", node_id="n4", project_id="p1")
    assert event["change"] == "cleared" and event["status"] is None
    assert book.get(ME.id) is None
    # Clearing what isn't there says nothing.
    assert book.set(ME, "", node_id=None, project_id="p1") == []


def test_text_is_cleaned_like_say():
    book = AgentStatusBook(Clock())
    (event,) = book.set(ME, "  Rendering\n the   hero\tshots ", node_id=None, project_id=None)
    assert event["status"]["text"] == "Rendering the hero shots"
    (event,) = book.set(ME, "x" * (MAX_STATUS_CHARS + 40), node_id=None, project_id=None)
    assert len(event["status"]["text"]) == MAX_STATUS_CHARS == 140
    with pytest.raises(StatusError):
        book.set(ME, 42, node_id=None, project_id=None)


def test_a_status_expires_after_the_idle_time_with_no_sign():
    clock = Clock()
    book = AgentStatusBook(clock)
    book.set(ME, "Rendering", node_id=None, project_id="p1")
    assert book.next_deadline() == clock.now + STATUS_IDLE_SECONDS == clock.now + 600
    clock.now += STATUS_IDLE_SECONDS - 1
    assert book.sweep() == []
    clock.now += 2
    (event,) = book.sweep()
    assert event["change"] == "expired" and event["status"] is None and event["agent"]["id"] == ME.id
    assert book.get(ME.id) is None and book.next_deadline() is None


def test_any_sign_from_the_agent_keeps_its_status_alive():
    clock = Clock()
    book = AgentStatusBook(clock)
    start = clock.now
    book.set(ME, "Rendering", node_id=None, project_id="p1")
    clock.now = start + 500
    book.saw(ME)
    book.saw(OTHER)  # another agent's sign is not this one's
    clock.now = start + 601
    assert book.sweep() == []
    assert book.next_deadline() == start + 500 + STATUS_IDLE_SECONDS
    clock.now = start + 1101
    (event,) = book.sweep()
    assert event["change"] == "expired"


def test_node_delete_and_graph_replace_drop_the_anchor_and_keep_the_text():
    book = AgentStatusBook(Clock())
    book.set(ME, "On the hero", node_id="n4", project_id="p1")
    book.set(OTHER, "On the grade", node_id="n7", project_id="p1")
    (event,) = book.forget_node("n4")
    assert event["change"] == "unanchored" and event["status"]["nodeId"] is None
    assert event["status"]["text"] == "On the hero"
    assert book.forget_node("n4") == []
    (event,) = book.forget_graph()
    assert event["agent"]["id"] == OTHER.id and event["status"]["nodeId"] is None
    assert book.forget_graph() == []
    assert book.get(ME.id).text == "On the hero"


def test_statuses_are_kept_per_project():
    book = AgentStatusBook(Clock())
    book.set(ME, "In the first project", node_id=None, project_id="p1")
    book.set(OTHER, "In the second", node_id=None, project_id="p2")
    assert [s.agent.id for s in book.for_project("p1")] == [ME.id]
    assert [s.agent.id for s in book.for_project("p2")] == [OTHER.id]
    assert book.for_project("p3") == []


# -- the routes ------------------------------------------------------------------------

@pytest.fixture
def roster(asked, monkeypatch):  # noqa: F811 - the imported fixture
    """The canvas app with its own status book, cursors and asset proposals on one clock."""
    statuses = AgentStatusBook(asked.clock)
    monkeypatch.setattr(asked.main, "agent_status", statuses)
    monkeypatch.setattr(asked.main, "agent_presence", AgentPresence(asked.clock))
    assets = AssetProposalBook(asked.clock)
    monkeypatch.setattr(asked.main, "asset_proposals", assets)

    async def fits(_proposal, _exported):
        return None  # the test's asset proposals stand for any that still fit their target

    monkeypatch.setattr(asked.main, "_asset_proposal_misfit", fits)
    asked.statuses = statuses
    asked.assets = assets
    return asked


def _set(api, body, headers=CLAUDE):
    return api.client.post("/api/canvas/status", headers=headers, json=body)


def _roster(api, headers=CLAUDE) -> dict:
    response = api.client.get("/api/canvas/agents", headers=headers)
    assert response.status_code == 200, response.text
    return response.json()


def _entry(roster_json: dict, name: str) -> dict:
    (found,) = [entry for entry in roster_json["agents"] if entry["agent"]["name"] == name]
    return found


def _status_events(api) -> list[dict]:
    return [message for message in api.sent if message.get("type") == "agentStatus"]


def test_an_agent_sets_its_status_and_every_canvas_hears_it(roster):
    n1 = roster.graph.add_node("text-input", {"value": "a cat"})
    response = _set(roster, {"text": "Rendering the hero shots", "nodeId": n1})
    assert response.status_code == 200, response.text
    body = response.json()
    assert body["status"]["text"] == "Rendering the hero shots" and body["status"]["nodeId"] == n1
    assert body["agent"]["name"] == "Claude Code"
    (event,) = _status_events(roster)
    assert event["change"] == "set" and event["status"]["projectId"] == roster.project_id

    entry = _entry(_roster(roster), "Claude Code")
    assert entry["status"]["text"] == "Rendering the hero shots" and entry["status"]["nodeId"] == n1
    assert entry["group"] == "working"

    cleared = _set(roster, {"text": ""})
    assert cleared.status_code == 200 and cleared.json()["status"] is None
    assert _status_events(roster)[-1]["change"] == "cleared"


def test_the_browser_and_anonymous_callers_cannot_set_a_status(roster):
    person = _set(roster, {"text": "I'm the person"}, headers=PERSON)
    assert person.status_code == 403
    assert "agent" in person.json()["detail"].lower()
    anonymous = _set(roster, {"text": "Who am I"}, headers={})
    assert anonymous.status_code == 400
    assert "NEBULA_AGENT_NAME" in anonymous.json()["detail"]
    assert roster.statuses.for_project(roster.project_id) == []
    assert _status_events(roster) == []


def test_an_agent_sets_only_its_own(roster):
    assert _set(roster, {"text": "Mine"}).status_code == 200
    assert _set(roster, {"text": "Codex's"}, headers=CODEX).status_code == 200
    # Clearing as Codex clears Codex's only.
    assert _set(roster, {"text": ""}, headers=CODEX).status_code == 200
    listed = _roster(roster)
    assert _entry(listed, "Claude Code")["status"]["text"] == "Mine"
    assert not [e for e in listed["agents"] if e["agent"]["name"] == "Codex"]
    # There is no way to name another agent.
    refused = _set(roster, {"text": "Theirs", "agent": "Codex"})
    assert refused.status_code == 422 and "agent" in refused.json()["detail"]


@pytest.mark.parametrize("body, words", [
    ({"text": "On it", "nodeId": "n404"}, "not on the canvas"),
    ({"text": "On it", "nodeId": 4}, "nodeId"),
    ({"text": 7}, "text"),
    ({}, "text"),
    ([], "object"),
])
def test_bad_status_bodies_are_refused(roster, body, words):
    response = _set(roster, body)
    assert response.status_code == 422, response.text
    assert words in response.json()["detail"]


def test_deleting_its_node_or_replacing_the_graph_drops_the_anchor(roster):
    n1 = roster.graph.add_node("text-input", {"value": "a cat"})
    n2 = roster.graph.add_node("text-input", {"value": "a dog"})
    _set(roster, {"text": "On the cat", "nodeId": n1})
    _set(roster, {"text": "On the dog", "nodeId": n2}, headers=CODEX)
    roster.sent.clear()
    assert roster.client.delete(f"/api/graph/node/{n1}", headers=PERSON).status_code == 200
    (event,) = _status_events(roster)
    assert event["change"] == "unanchored" and event["agent"]["name"] == "Claude Code"
    listed = _roster(roster)
    assert _entry(listed, "Claude Code")["status"] == {**_entry(listed, "Claude Code")["status"], "nodeId": None,
                                                      "text": "On the cat"}
    assert _entry(listed, "Codex")["status"]["nodeId"] == n2

    roster.sent.clear()
    assert roster.client.delete("/api/graph?force=true", headers=PERSON).status_code == 200
    (event,) = _status_events(roster)
    assert event["agent"]["name"] == "Codex" and event["status"]["nodeId"] is None
    assert _entry(_roster(roster), "Codex")["status"]["text"] == "On the dog"


def test_a_status_from_one_project_never_shows_in_another(roster):
    from services.project_store import make_project

    store = roster.main.project_store
    with store.transaction() as catalog:
        other = make_project("Other")
        catalog["projects"][other["id"]] = other
        store.commit(catalog)
    n1 = roster.graph.add_node("text-input", {"value": "a cat"})
    _set(roster, {"text": "On the cat", "nodeId": n1})
    revision = store.read()["workspaceRevision"]
    opened = roster.client.post(f"/api/projects/{other['id']}/open", json={"workspaceRevision": revision},
                                headers=PERSON)
    assert opened.status_code == 200, opened.text
    listed = _roster(roster, headers=CODEX)
    assert listed["projectId"] == other["id"]
    assert not [e for e in listed["agents"] if e["agent"]["name"] == "Claude Code" and e["status"]]
    # Back in the first project: the line is there, without its node (ids restart per graph).
    back = roster.client.post(f"/api/projects/{roster.project_id}/open",
                              json={"workspaceRevision": opened.json()["workspaceRevision"]}, headers=PERSON)
    assert back.status_code == 200, back.text
    status = _entry(_roster(roster, headers=CODEX), "Claude Code")["status"]
    assert status["text"] == "On the cat" and status["nodeId"] is None


def test_any_identified_request_is_a_sign_that_keeps_the_status(roster):
    _set(roster, {"text": "Rendering"})
    start = roster.clock.now
    roster.clock.now = start + 500
    # Not a status call: any request the agent makes (here a read of the canvas).
    assert roster.client.get("/api/canvas/snapshot", headers=CLAUDE).status_code == 200
    # The browser's own requests are no one's sign.
    roster.client.get("/api/canvas/snapshot", headers=PERSON)
    roster.clock.now = start + 700
    assert _entry(_roster(roster, headers=PERSON), "Claude Code")["status"]["text"] == "Rendering"
    roster.clock.now = start + 500 + STATUS_IDLE_SECONDS + 1
    roster.sent.clear()
    listed = _roster(roster, headers=PERSON)
    assert not [e for e in listed["agents"] if e["agent"]["name"] == "Claude Code"]
    (event,) = _status_events(roster)
    assert event["change"] == "expired"


def test_the_expiry_sweep_tells_every_canvas(roster):
    _set(roster, {"text": "Rendering"})
    roster.sent.clear()
    roster.clock.now += STATUS_IDLE_SECONDS + 1
    asyncio.run(roster.main._sweep_agent_statuses())
    (event,) = _status_events(roster)
    assert event["change"] == "expired" and event["agent"]["name"] == "Claude Code"


def _canvas_proposal(api, headers):
    n1 = next(iter(api.graph.nodes), None) or api.graph.add_node("text-input", {"value": "a cat"})
    body = {
        "note": PROPOSAL_NOTE,
        "nodes": [{"ref": "+img", "definitionId": "nano-banana", "params": {"aspect_ratio": "16:9"}}],
        "edges": [{"source": n1, "sourceHandle": "text", "target": "+img", "targetHandle": "prompt"}],
    }
    response = api.client.post("/api/canvas/proposals", headers=headers, json=body)
    assert response.status_code == 201, response.text
    return response.json()["proposal"]


def _asset_proposal(api, identity, project_id):
    proposal = api.assets.create_asset(
        agent=identity, spec=AssetChange(kind="project", target_id=project_id, change={"cover": None},
                                         note=ASSET_NOTE),
        target_name="Active", before={"cover": "/api/outputs/a.png", "coverBy": None})
    proposal.update = {"id": "note_x", "projectId": project_id}
    return proposal


def test_the_roster_counts_what_needs_the_person(roster):
    # Claude asks (2 questions in one set) and has an asset proposal; Codex proposes on the canvas.
    asked_set = roster.client.post("/api/canvas/questions", headers=CLAUDE, json=TWO)
    assert asked_set.status_code == 201, asked_set.text
    roster.clock.now += 10
    _canvas_proposal(roster, CODEX)
    roster.clock.now += 10
    claude = asked_set.json()["questions"]["agent"]
    _asset_proposal(roster, AgentIdentity(**claude), roster.project_id)
    # A third agent only works.
    roster.clock.now += 10
    assert _set(roster, {"text": "Sorting the references"}, headers={"X-Nebula-Agent": "Gemini"}).status_code == 200

    listed = _roster(roster, headers=PERSON)
    names = [entry["agent"]["name"] for entry in listed["agents"]]
    # Needs you first, longest wait first; then Working.
    assert names == ["Claude Code", "Codex", "Gemini"]
    # Questions, not sets: the TWO set is 2, as its Update says ("has 2 questions").
    assert _entry(listed, "Claude Code")["needsYou"] == {"questions": 2, "proposals": 1}
    assert _entry(listed, "Claude Code")["group"] == "needsYou"
    assert _entry(listed, "Codex")["needsYou"] == {"questions": 0, "proposals": 1}
    assert _entry(listed, "Gemini")["needsYou"] == {"questions": 0, "proposals": 0}
    assert _entry(listed, "Gemini")["group"] == "working"
    assert _entry(listed, "Claude Code")["waitingSeconds"] == pytest.approx(30)


def test_needs_you_counts_only_the_open_project(roster):
    from services.project_store import make_project

    store = roster.main.project_store
    with store.transaction() as catalog:
        other = make_project("Other")
        catalog["projects"][other["id"]] = other
        store.commit(catalog)
    _asset_proposal(roster, OTHER, other["id"])
    assert not [e for e in _roster(roster)["agents"] if e["agent"]["name"] == "Codex"]


def test_an_asset_proposal_with_no_update_counts_in_the_open_project(roster):
    # Made while no project was open, so it has no Update: it waits for the person
    # wherever they are, as the panel counts it (agentRosterModel), whatever its target.
    cover = _asset_proposal(roster, OTHER, "prj_elsewhere")
    cover.update = None
    board = roster.assets.create_asset(
        agent=GEMINI_ID, spec=AssetChange(kind="moodboard", target_id="mb_1", change={"sendNotes": True},
                                          note=ASSET_NOTE),
        target_name="Dusk", before={"sendNotes": False})
    assert board.update is None
    listed = _roster(roster, headers=PERSON)
    assert _entry(listed, "Codex")["needsYou"] == {"questions": 0, "proposals": 1}
    assert _entry(listed, "Gemini")["needsYou"] == {"questions": 0, "proposals": 1}


def test_needs_you_sorts_on_the_exact_wait():
    # Gem waits 30 ms longer: first, though the rounded waits tie and its name sorts later.
    gem = AgentIdentity(id="ext:gem", name="Gem", color="#F2C14E", verified=False)
    claude = AgentIdentity(id="ext:claude-code", name="Claude Code", color="#3FC1A5", verified=False)
    agents = build_roster(project_id="p1", now=200.0, cursors=[], statuses=[], status_view=lambda s: {},
                          waiting=[Waiting(agent=claude, kind="question", created_at=100.03),
                                   Waiting(agent=gem, kind="proposal", created_at=100.0)])
    assert [entry["agent"]["name"] for entry in agents] == ["Gem", "Claude Code"]
    assert all("_waitingSince" not in entry for entry in agents)
    assert agents[0]["waitingSeconds"] == pytest.approx(100.0)


def test_a_question_set_counts_its_questions():
    claude = AgentIdentity(id="ext:claude-code", name="Claude Code", color="#3FC1A5", verified=False)
    (entry,) = build_roster(project_id="p1", now=10.0, cursors=[], statuses=[], status_view=lambda s: {},
                            waiting=[Waiting(agent=claude, kind="question", created_at=1.0, count=2),
                                     Waiting(agent=claude, kind="question", created_at=2.0)])
    assert entry["needsYou"] == {"questions": 3, "proposals": 0}


def test_working_agents_sort_by_most_recent_activity(roster):
    _set(roster, {"text": "First"}, headers={"X-Nebula-Agent": "Gemini"})
    roster.clock.now += 30
    n1 = roster.graph.add_node("text-input", {"value": "a cat"})
    assert roster.client.post("/api/canvas/cursor", headers=CODEX,
                              json={"target": {"nodeId": n1}}).status_code == 200
    names = [entry["agent"]["name"] for entry in _roster(roster)["agents"]]
    assert names == ["Codex", "Gemini"]


def test_the_roster_names_the_last_action_from_the_cursor(roster):
    created = roster.client.post("/api/graph/node", headers=CODEX,
                                 json={"definitionId": "text-input", "params": {"value": "a cat"}})
    assert created.status_code == 200, created.text
    node_id = created.json()["id"]
    roster.clock.now += 90
    entry = _entry(_roster(roster), "Codex")
    assert entry["status"] is None
    assert entry["lastAction"]["verb"] == "Added"
    assert entry["lastAction"]["nodeId"] == node_id
    assert entry["lastAction"]["label"] == "Text Input"
    assert entry["lastAction"]["secondsAgo"] == pytest.approx(90)
    assert entry["cursor"]["nodeId"] == node_id


def test_a_single_rename_or_move_names_itself_in_the_roster(roster):
    """`nebula rename` and `nebula move` (the label and layout routes) are
    actions too: GM's line reads Moved “Hero shots” · 2 min ago."""
    created = roster.client.post("/api/graph/node", headers=CODEX,
                                 json={"definitionId": "text-input", "params": {"value": "a cat"}})
    node_id = created.json()["id"]
    renamed = roster.client.put(f"/api/graph/node/{node_id}/label", headers=CODEX, json={"label": "Hero shots"})
    assert renamed.status_code == 200, renamed.text
    assert _entry(_roster(roster), "Codex")["lastAction"] == {
        "verb": "Renamed", "nodeId": node_id, "label": "Hero shots", "secondsAgo": 0.0}
    moved = roster.client.put("/api/graph/layout", headers=CODEX,
                              json={"positions": {node_id: {"x": 900, "y": 640}}})
    assert moved.status_code == 200, moved.text
    assert _entry(_roster(roster), "Codex")["lastAction"]["verb"] == "Moved"
    # The person's own moves and renames move no agent's cursor.
    before = len([m for m in roster.sent if m.get("type") == "agentPresence"])
    roster.client.put("/api/graph/layout", json={"positions": {node_id: {"x": 10, "y": 10}}})
    roster.client.put(f"/api/graph/node/{node_id}/label", json={"label": "Wide"})
    assert len([m for m in roster.sent if m.get("type") == "agentPresence"]) == before


# -- GM's review of the verbs (PR #193, Q125 item 2) ------------------------------------------
#
# GM - Design: "Wired" / "Unwired" become "Connected" / "Disconnected" (Nebula
# says connected, never wired). Of the pointer gestures only "Pointed at “X”"
# and "Looked at “X”" on a node and "Looked around" at a spot stay; "Clicked",
# "Dragged to" and a bare "Moved", "Clicked" or "Dragged" at a spot are cut
# ("'Moved · just now' reads like the agent moved a node, and the rest is
# noise"). A cut gesture leaves the agent's previous kept action, with that
# action's own time; with none, there is no action.

def _wire(api) -> dict:
    text = api.graph.add_node("text-input", {"value": "x"})
    image = api.graph.add_node("gpt-image-2-5-generate", {})
    return {"source": text, "sourceHandle": "text", "target": image, "targetHandle": "prompt"}


def test_connecting_and_disconnecting_say_connected_never_wired(roster):
    wire = _wire(roster)
    assert roster.client.post("/api/graph/connect", headers=CODEX, json=wire).status_code == 200
    action = _entry(_roster(roster), "Codex")["lastAction"]
    assert action["verb"] == "Connected" and action["nodeId"] == wire["target"]
    assert roster.client.request("DELETE", "/api/graph/edge", headers=CODEX, json=wire).status_code == 200
    assert _entry(_roster(roster), "Codex")["lastAction"]["verb"] == "Disconnected"
    for message in roster.sent:
        if message.get("type") == "agentPresence" and message.get("did"):
            assert "Wired" not in message["did"]["verb"] and "Unwired" not in message["did"]["verb"]


def _point(api, body, headers=CODEX):
    response = api.client.post("/api/canvas/cursor", headers=headers, json=body)
    assert response.status_code == 200, response.text
    return response.json()


@pytest.mark.parametrize(("target", "action", "verb"), [
    ("node", "move", "Pointed at"),
    ("node", "look", "Looked at"),
    ("spot", "look", "Looked around"),
])
def test_the_kept_pointer_gestures_name_themselves(roster, target, action, verb):
    n1 = roster.graph.add_node("text-input", {"value": "a cat"})
    place = {"nodeId": n1} if target == "node" else {"x": 40, "y": 80}
    _point(roster, {"target": place, "action": action})
    last = _entry(_roster(roster), "Codex")["lastAction"]
    assert last["verb"] == verb
    assert last["nodeId"] == (n1 if target == "node" else None)


CUT_GESTURES = [("node", "click"), ("node", "drag"), ("spot", "move"), ("spot", "click"), ("spot", "drag")]


@pytest.mark.parametrize(("target", "action"), CUT_GESTURES)
def test_a_cut_gesture_keeps_the_previous_action_and_its_time(roster, target, action):
    created = roster.client.post("/api/graph/node", headers=CODEX,
                                 json={"definitionId": "text-input", "params": {"value": "a cat"}})
    node_id = created.json()["id"]
    assert roster.client.put(f"/api/graph/node/{node_id}/label", headers=CODEX,
                             json={"label": "Hero shots"}).status_code == 200
    other = roster.graph.add_node("text-input", {"value": "dusk"})
    roster.clock.now += 60
    place = {"nodeId": other} if target == "node" else {"x": 900, "y": 640}
    _point(roster, {"target": place, "action": action})
    entry = _entry(_roster(roster), "Codex")
    assert entry["lastAction"] == {"verb": "Renamed", "nodeId": node_id, "label": "Hero shots",
                                   "secondsAgo": pytest.approx(60)}
    # The cursor itself moved, and is active now.
    assert entry["cursor"]["nodeId"] == (other if target == "node" else None)
    assert entry["cursor"]["secondsAgo"] == pytest.approx(0)
    # The live event carries the same action and how long ago it was.
    (event,) = [m for m in roster.sent if m.get("type") == "agentPresence"][-1:]
    assert event["did"]["verb"] == "Renamed" and event["did"]["secondsAgo"] == pytest.approx(60)


@pytest.mark.parametrize(("target", "action"), CUT_GESTURES)
def test_a_cut_gesture_with_nothing_before_it_names_no_action(roster, target, action):
    other = roster.graph.add_node("text-input", {"value": "dusk"})
    place = {"nodeId": other} if target == "node" else {"x": 900, "y": 640}
    _point(roster, {"target": place, "action": action})
    entry = _entry(_roster(roster), "Codex")
    assert entry["lastAction"] is None
    (event,) = [m for m in roster.sent if m.get("type") == "agentPresence"][-1:]
    assert "did" not in event


def test_no_cut_verb_is_ever_sent(roster):
    other = roster.graph.add_node("text-input", {"value": "dusk"})
    for target, action in CUT_GESTURES:
        place = {"nodeId": other} if target == "node" else {"x": 1, "y": 2}
        _point(roster, {"target": place, "action": action})
    verbs = {m["did"]["verb"] for m in roster.sent if m.get("type") == "agentPresence" and m.get("did")}
    assert not verbs & {"Clicked", "Dragged to", "Dragged", "Moved"}


def test_a_real_node_move_still_says_moved(roster):
    n1 = roster.graph.add_node("text-input", {"value": "a cat"})
    assert roster.client.put("/api/graph/layout", headers=CODEX,
                             json={"positions": {n1: {"x": 900, "y": 640}}}).status_code == 200
    assert _entry(_roster(roster), "Codex")["lastAction"]["verb"] == "Moved"


def test_the_roster_never_carries_another_agents_questions_answers_or_proposals(roster):
    asked_set = roster.client.post("/api/canvas/questions", headers=CLAUDE, json=TWO).json()["questions"]
    # One answered set too: its answers are the person's message to Claude alone.
    answered = roster.client.post("/api/canvas/questions", headers=CLAUDE,
                                  json={"questions": [{"text": "Anything else?"}]}).json()["questions"]
    assert _answer(roster, answered["id"], {"answers": [{"questionId": "q1", "text": SECRET_ANSWER}]}
                   ).status_code == 200
    _canvas_proposal(roster, CODEX)
    _asset_proposal(roster, OTHER, roster.project_id)
    for headers in (CLAUDE, CODEX, PERSON, {}):
        text = json.dumps(_roster(roster, headers=headers))
        for secret in (QUESTION_TEXT, "Anything to avoid?", SECRET_ANSWER, PROPOSAL_NOTE, ASSET_NOTE,
                       TWO["note"], asked_set["id"]):
            assert secret not in text, (headers, secret)
    assert not [entry for entry in _roster(roster)["agents"] if "say" in json.dumps(entry)]
