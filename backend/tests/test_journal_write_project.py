"""Every journal event names the project its write went to (review 7 of PR #114, round 8).

Review 7's T3: a node deleted on project A while the person opened project B
and pinned there during the delete's graphSync await. node.removed and
pin.detached were journaled after the await, tagged with B: an agent on B read
A's change as B's. The same held for every route that awaited between its
write and its journal (graph edits, removals, clear, undo, proposals, notes,
project changes).

Each test runs one route while, at the route's first broadcast (or the one
named), the person opens the other project and pins a note there. Then:
the route's events are journaled before the switch, tagged with the project
the route wrote to; nothing after the switch names it; and the --channel
listener still wakes for the pin on the project now open (no lost wake).
"""
from __future__ import annotations

from typing import Any, Callable

import pytest

from services.canvas_proposals import ProposalBook
from services.run_approvals import RunApprovals
from tests.conftest import PERSON
from tests.test_canvas_pins import AGENT, _channel_decides, api  # noqa: F401  (fixture)

CLAUDE = {"X-Nebula-Agent": "Claude Code"}
KEY = "X-Nebula-Proposal-Key"


class Race:
    """The api fixture, its broadcasts hooked: at the first one ``when``
    matches, the person opens the other project and pins a note there."""

    def __init__(self, fixture, monkeypatch) -> None:
        import main as main_module

        self.main = main_module
        self.client, self.graph, self.journal, self.sent, self.store, (self.active, self.other) = fixture
        self.browser: list[dict] = []
        self.done: dict[str, Any] = {}
        self.when: Callable[[dict], bool] = lambda data: True
        self.armed = False
        monkeypatch.setattr(main_module, "canvas_proposals", ProposalBook())
        monkeypatch.setattr(main_module, "run_approvals", RunApprovals())
        monkeypatch.setattr(main_module.manager, "broadcast_raw", self._hooked(self.sent))
        monkeypatch.setattr(main_module.manager, "broadcast_browser", self._hooked(self.browser))
        monkeypatch.setattr(main_module.manager, "broadcast_others", self._hooked(self.sent))

    def _hooked(self, into: list[dict]):
        async def hook(data: dict) -> None:
            into.append(data)
            if self.armed and "pin" not in self.done and self.when(data):
                from services.agent_presence import _request_headers

                self.done["pin"] = None
                self.done["at"] = data.get("type")
                held = _request_headers.set(PERSON)
                try:
                    revision = self.store.read()["workspaceRevision"]
                    await self.main.open_saved_project(self.other, {"workspaceRevision": revision})
                    made = await self.main.create_canvas_pin({"text": "on B", "position": {"x": 1, "y": 1}})
                    self.done["pin"] = made["pin"]
                finally:
                    _request_headers.reset(held)
        return hook

    def key(self, proposal_id: str) -> str:
        for message in self.browser:
            if message.get("type") == "proposalOpened" and message["proposal"]["id"] == proposal_id:
                return message["acceptKey"]
        raise AssertionError("no proposalOpened message for the browser")

    def run(self, call: Callable[[], Any], *, when: Callable[[dict], bool] | None = None) -> Any:
        self.done.clear()
        self.when = when or (lambda data: True)
        self.armed = True
        try:
            answer = call()
        finally:
            self.armed = False
        assert self.done.get("pin"), ("the switch never ran", self.done)
        assert self.store.read()["activeProjectId"] == self.other
        return answer

    def events(self) -> list[dict]:
        return self.journal.read(after=0, limit=200)["events"]

    def check(self, kinds: set[str], *, since: int = 0, person_pin_a: str | None = None) -> list[dict]:
        """The route's events (``kinds``, after seq ``since``) all come before
        the switch, tagged with A; every event after it names B; and the
        listener keeps B's pin and wakes for it."""
        events = [e for e in self.events() if e["seq"] > since]
        rows = [(e["kind"], e["projectId"], (e.get("data") or {}).get("pinId")) for e in events]
        switched = next(i for i, e in enumerate(events)
                        if e["kind"] == "canvas.replaced" and (e.get("data") or {}).get("reason") == "project-open"
                        and e["projectId"] == self.other)
        before = {e["kind"] for e in events[:switched] if e["projectId"] == self.active}
        assert kinds <= before, ("not journaled before the switch, tagged with A", kinds - before, rows)
        # After the switch: only the project open, or what the switch itself
        # did to the project left (its proposals closed, tagged with theirs).
        late = [row for row, e in zip(rows[switched:], events[switched:]) if e["projectId"] != self.other
                and not (e["kind"] == "proposal.invalidated" and e["data"].get("reason") == "the canvas was replaced")]
        assert not late, ("events after the switch that don't name the project open", late, rows)
        assert not kinds & {e["kind"] for e in events[switched + 1:] if e["projectId"] == self.other} - {"pin.added"}, rows
        answer, checked, dropped, push = _channel_decides(self.client, self.journal)
        pin_b = self.done["pin"]["id"]
        assert answer["projectId"] == self.other
        assert checked == [pin_b] and dropped == 0, (checked, dropped, rows)
        assert push is not None and (push.wake, push.gate) == ("pin", False), push and (push.wake, push.gate)
        assert f'pin id="{pin_b}"' in push.content
        if person_pin_a:
            assert person_pin_a not in push.content
        return events


@pytest.fixture
def race(api, monkeypatch):  # noqa: F811
    return Race(api, monkeypatch)


def _pin_on(race: Race, node_id: str) -> str:
    made = race.client.post("/api/canvas/pins", headers=PERSON, json={"text": "redo this", "nodeId": node_id})
    assert made.status_code == 201, made.text
    return made.json()["pin"]["id"]


def _project_pins(race: Race, project_id: str) -> dict[str, dict]:
    return {pin["id"]: pin for pin in race.store.read()["projects"][project_id].get("pins") or []}


# -- a graph write, then its graphSync -------------------------------------------

def _two_nodes(race: Race) -> tuple[str, str]:
    prompt = race.graph.add_node("text-input", {"value": "a lighthouse"}, position={"x": 0, "y": 0})
    image = race.graph.add_node("nano-banana", {}, position={"x": 400, "y": 0})
    return prompt, image


GRAPH_ROUTES = {
    "add": (lambda r, a, b: r.client.post("/api/graph/node", headers=PERSON,
                                          json={"definitionId": "text-input", "params": {"value": "x"}}),
            {"node.added"}),
    "connect": (lambda r, a, b: r.client.post("/api/graph/connect", headers=PERSON, json={
        "source": a, "sourceHandle": "text", "target": b, "targetHandle": "prompt"}), {"edge.added"}),
    "add-and-connect": (lambda r, a, b: r.client.post("/api/graph/node-and-connect", headers=AGENT, json={
        "definitionId": "text-input", "params": {"value": "y"},
        "connect": {"source": "", "sourceHandle": "text", "target": b, "targetHandle": "prompt",
                    "newNodeIs": "source"}}), {"node.added", "edge.added"}),
    "params": (lambda r, a, b: r.client.put(f"/api/graph/node/{a}", headers=PERSON,
                                            json={"params": {"value": "a castle"}}), {"node.params"}),
    "rename": (lambda r, a, b: r.client.put(f"/api/graph/node/{a}/label", headers=PERSON,
                                            json={"label": "Hero prompt"}), {"node.renamed"}),
    "move": (lambda r, a, b: r.client.put("/api/graph/layout", headers=PERSON,
                                          json={"positions": {a: {"x": 900, "y": 300}}}), {"node.moved"}),
    "cluster": (lambda r, a, b: r.client.post("/api/graph/cluster", headers=PERSON, json={
        "nodes": [{"tempId": "t1", "definitionId": "text-input", "params": {"value": "z"}}], "edges": []}),
        {"node.added"}),
}


@pytest.mark.parametrize("route", sorted(GRAPH_ROUTES))
def test_a_graph_edit_is_journaled_with_its_project_before_a_switch(race, route):
    a, b = _two_nodes(race)
    call, kinds = GRAPH_ROUTES[route]
    answer = race.run(lambda: call(race, a, b))
    assert answer.status_code == 200, answer.text
    race.check(kinds)


def test_a_disconnect_is_journaled_with_its_project_before_a_switch(race):
    a, b = _two_nodes(race)
    race.graph.connect(a, "text", b, "prompt")
    answer = race.run(lambda: race.client.request("DELETE", "/api/graph/edge", headers=PERSON, json={
        "source": a, "sourceHandle": "text", "target": b, "targetHandle": "prompt"}))
    assert answer.status_code == 200, answer.text
    race.check({"edge.removed"})


# -- a delete and what it removed (review 7's T3) --------------------------------

@pytest.mark.parametrize("trigger", ["graphSync", "canvasPins"])
def test_a_delete_and_the_pin_it_detached_are_journaled_with_its_project(race, trigger):
    node = race.graph.add_node("text-input", {}, position={"x": 300, "y": 40})
    pin_a = _pin_on(race, node)
    answer = race.run(lambda: race.client.delete(f"/api/graph/node/{node}", headers=PERSON),
                      when=lambda data: data.get("type") == trigger)
    assert answer.status_code == 200, answer.text
    events = race.check({"node.removed", "pin.detached"}, person_pin_a=pin_a)
    detached = [e for e in events if e["kind"] == "pin.detached"]
    assert [(e["data"]["pinId"], e["projectId"]) for e in detached] == [(pin_a, race.active)]
    assert _project_pins(race, race.active)[pin_a]["detached"]


def test_an_agents_edit_is_journaled_with_its_project_before_a_switch(race):
    a, b = _two_nodes(race)
    race.graph.connect(a, "text", b, "prompt")
    spare = race.graph.add_node("text-input", {"value": "spare"}, position={"x": 0, "y": 300})
    pin_a = _pin_on(race, spare)
    answer = race.run(lambda: race.client.post("/api/graph/apply", headers=AGENT, json={
        "nodes": [{"ref": "+t", "definitionId": "text-input", "params": {"value": "new"}}],
        "params": [{"nodeId": a, "params": {"value": "a castle"}}],
        "rename": {a: "Hero prompt"},
        "move": {b: {"x": 900, "y": 300}},
        "remove": [spare],
        "unwire": [{"source": a, "sourceHandle": "text", "target": b, "targetHandle": "prompt"}],
    }))
    assert answer.status_code == 200, answer.text
    race.check({"node.added", "node.params", "node.renamed", "node.moved", "node.removed", "edge.removed",
                "pin.detached"}, person_pin_a=pin_a)


def test_an_agents_undo_is_journaled_with_its_project_before_a_switch(race):
    a, _b = _two_nodes(race)
    made = race.client.post("/api/graph/apply", headers=AGENT, json={
        "nodes": [{"ref": "+t", "definitionId": "text-input", "params": {"value": "new"}}],
        "params": [{"nodeId": a, "params": {"value": "a castle"}}]})
    assert made.status_code == 200, made.text
    since = race.events()[-1]["seq"]
    answer = race.run(lambda: race.client.post("/api/graph/apply/undo", headers=AGENT,
                                               json={"token": made.json()["undo"]["token"]}))
    assert answer.status_code == 200, answer.text
    race.check({"node.removed", "node.params", "edit.undone"}, since=since)


def test_the_persons_linked_undo_is_journaled_with_its_project_before_a_switch(race):
    a, _b = _two_nodes(race)
    made = race.client.post("/api/graph/apply", headers=AGENT, json={
        "params": [{"nodeId": a, "params": {"value": "a castle"}}]})
    assert made.status_code == 200, made.text
    edit_id = next(m["edit"]["id"] for m in reversed(race.sent) if m.get("type") == "graphSync" and m.get("edit"))
    since = race.events()[-1]["seq"]
    node = race.graph.nodes[a]
    answer = race.run(lambda: race.client.post("/api/graph/restore", headers=PERSON, json={
        "action": "undo", "edit": edit_id,
        "nodes": [{"id": a, "definitionId": node["definitionId"], "params": {"value": "a lighthouse"}}]}))
    assert answer.status_code == 200, answer.text
    race.check({"node.params", "edit.undone"}, since=since)


def test_an_undo_that_puts_a_pin_back_journals_it_with_its_project(race):
    node = race.graph.add_node("text-input", {"value": "keep"}, position={"x": 300, "y": 40})
    pin_a = _pin_on(race, node)
    gone = race.client.delete(f"/api/graph/node/{node}", headers=PERSON)
    assert gone.status_code == 200, gone.text
    since = race.events()[-1]["seq"]
    answer = race.run(lambda: race.client.post("/api/graph/restore", headers=PERSON, json={
        "action": "undo", "removals": [gone.json()["removal"]],
        "nodes": [{"id": node, "definitionId": "text-input", "params": {"value": "keep"},
                   "position": {"x": 300, "y": 40}}]}),
        when=lambda data: data.get("type") == "canvasPins")
    assert answer.status_code == 200, answer.text
    assert answer.json()["reattached"] == [pin_a]
    events = race.check({"node.added", "pin.reattached"}, since=since, person_pin_a=pin_a)
    assert [(e["data"]["pinId"], e["projectId"]) for e in events if e["kind"] == "pin.reattached"] == [
        (pin_a, race.active)]


# -- a clear, an import: the pins they detach are the project's they changed -----

def test_a_clear_detaches_its_own_projects_pins_and_journals_them_there(race):
    node = race.graph.add_node("text-input", {}, position={"x": 300, "y": 40})
    pin_a = _pin_on(race, node)
    answer = race.run(lambda: race.client.delete("/api/graph?force=true", headers=PERSON))
    assert answer.status_code == 200, answer.text
    race.check({"canvas.cleared", "pin.detached"}, person_pin_a=pin_a)
    # The write went to A: its pin lost its node; B's pin is as the person left it.
    assert _project_pins(race, race.active)[pin_a]["detached"]
    assert not _project_pins(race, race.other)[race.done["pin"]["id"]].get("detached")


def test_an_import_detaches_its_own_projects_pins_and_journals_them_there(race):
    node = race.graph.add_node("text-input", {}, position={"x": 300, "y": 40})
    pin_a = _pin_on(race, node)
    answer = race.run(lambda: race.client.post("/api/graph/import", headers=PERSON, json={"nodes": [], "edges": []}))
    assert answer.status_code == 200, answer.text
    events = race.check({"canvas.replaced", "pin.detached"}, person_pin_a=pin_a)
    imported = [e for e in events if e["kind"] == "canvas.replaced" and e["data"].get("reason") == "import"]
    assert [e["projectId"] for e in imported] == [race.active]
    assert _project_pins(race, race.active)[pin_a]["detached"]


def test_a_switch_overtaken_by_another_names_the_project_it_opened(race):
    # The person opens B; during that open's graphSync, they open C and pin there.
    with race.store.transaction() as catalog:
        from services.project_store import make_project

        third = make_project("Third")
        catalog["projects"][third["id"]] = third
        race.store.commit(catalog)
    target, race.other = race.other, third["id"]
    revision = race.store.read()["workspaceRevision"]
    answer = race.run(lambda: race.client.post(f"/api/projects/{target}/open", headers=PERSON,
                                               json={"workspaceRevision": revision}),
                      when=lambda data: data.get("type") == "graphSync")
    assert answer.status_code == 200, answer.text
    events = race.events()
    opened = [e["projectId"] for e in events if e["kind"] == "canvas.replaced"]
    assert opened == [target, third["id"]], opened
    answer_, checked, dropped, push = _channel_decides(race.client, race.journal)
    assert checked == [race.done["pin"]["id"]] and dropped == 0
    assert push is not None and push.wake == "pin"


# -- what agents post and propose ---------------------------------------------------

def test_an_update_is_journaled_with_its_project_before_a_switch(race):
    answer = race.run(lambda: race.client.post("/api/canvas/agent-notes", headers=CLAUDE,
                                               json={"text": "The sky is too dark"}))
    assert answer.status_code == 201, answer.text
    race.check({"note.posted"})


def test_a_proposal_is_journaled_with_its_project_before_a_switch(race):
    answer = race.run(lambda: race.client.post("/api/canvas/proposals", headers=CLAUDE, json={
        "note": "A prompt", "nodes": [{"ref": "+t", "definitionId": "text-input", "params": {"value": "x"}}]}))
    assert answer.status_code == 201, answer.text
    race.check({"proposal.created", "note.posted"})


@pytest.mark.parametrize("decision", ["accept", "reject"])
def test_a_decided_proposal_is_journaled_with_its_project_before_a_switch(race, decision):
    made = race.client.post("/api/canvas/proposals", headers=CLAUDE, json={
        "note": "A prompt", "nodes": [{"ref": "+t", "definitionId": "text-input", "params": {"value": "x"}}]})
    assert made.status_code == 201, made.text
    proposal_id = made.json()["proposal"]["id"]
    key = race.key(proposal_id)
    since = race.events()[-1]["seq"]
    answer = race.run(lambda: race.client.post(f"/api/canvas/proposals/{proposal_id}/{decision}",
                                               headers={**PERSON, KEY: key}, json={}))
    assert answer.status_code == 200, answer.text
    race.check({"proposal.accepted", "node.added"} if decision == "accept" else {"proposal.rejected"}, since=since)


def test_questions_are_journaled_with_their_project_before_a_switch(race):
    answer = race.run(lambda: race.client.post("/api/canvas/questions", headers=CLAUDE, json={
        "questions": [{"text": "Warmer or cooler?", "options": ["Warmer", "Cooler"]}]}))
    assert answer.status_code == 201, answer.text
    race.check({"question.asked", "note.posted"})


# -- projects -------------------------------------------------------------------------

def test_a_rename_is_journaled_before_a_switch(race):
    answer = race.run(lambda: race.client.put(f"/api/projects/{race.active}", headers=PERSON,
                                              json={"name": "Renamed"}))
    assert answer.status_code == 200, answer.text
    race.check({"project.renamed"})
