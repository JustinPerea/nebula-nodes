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
        self.after: Callable[[], None] | None = None
        self.armed = False
        monkeypatch.setattr(main_module, "canvas_proposals", ProposalBook())
        monkeypatch.setattr(main_module, "run_approvals", RunApprovals())
        monkeypatch.setattr(main_module.manager, "broadcast_raw", self._hooked(self.sent))
        monkeypatch.setattr(main_module.manager, "broadcast_browser", self._hooked(self.browser))
        monkeypatch.setattr(main_module.manager, "broadcast_others", self._hooked(self.sent))

    async def switch(self) -> None:
        """The person opens the other project and pins a note there."""
        from services.agent_presence import _request_headers

        self.done["pin"] = None
        held = _request_headers.set(PERSON)
        try:
            revision = self.store.read()["workspaceRevision"]
            await self.main.open_saved_project(self.other, {"workspaceRevision": revision})
            made = await self.main.create_canvas_pin({"text": "on B", "position": {"x": 1, "y": 1}})
            self.done["pin"] = made["pin"]
        finally:
            _request_headers.reset(held)

    def _hooked(self, into: list[dict]):
        async def hook(data: dict, **_kw: object) -> None:
            into.append(data)
            if self.armed and "pin" not in self.done and self.when(data):
                self.done["at"] = data.get("type")
                await self.switch()
                if self.after is not None:
                    self.after()
        return hook

    def key(self, proposal_id: str) -> str:
        for message in self.browser:
            if message.get("type") == "proposalOpened" and message["proposal"]["id"] == proposal_id:
                return message["acceptKey"]
        raise AssertionError("no proposalOpened message for the browser")

    def run(self, call: Callable[[], Any], *, when: Callable[[dict], bool] | None = None,
            after: Callable[[], None] | None = None) -> Any:
        """``after``: runs right after the switch, inside the broadcast (it may raise)."""
        self.done.clear()
        self.when = when or (lambda data: True)
        self.after = after
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


# -- review 8 (round 9) ---------------------------------------------------------------
# Item 1: an undo's link keeps every event it journaled. Round 8 took the
# link's events in journal_done, before _undo_removals journaled pin.reattached
# and proposal.reopened under the same link, so the link (and the person's
# later Cmd+Z of that undo, edit.undone.data.events) missed them. Now the pins
# go back before edit.undone, proposal.reopened may follow it (its fit check
# awaits), and the link's events are taken again once the restore returns.

def _pinned_and_proposed(race: Race, *, pin: bool, proposal: bool) -> tuple[str, str | None, str | None]:
    keep = race.graph.add_node("text-input", {"value": "a lighthouse"}, position={"x": 0, "y": 0})
    pin_id = _pin_on(race, keep) if pin else None
    proposal_id = None
    if proposal:
        made = race.client.post("/api/canvas/proposals", headers=CLAUDE, json={
            "note": "change it", "params": [{"nodeId": keep, "params": {"value": "a castle"}}]})
        assert made.status_code == 201, made.text
        proposal_id = made.json()["proposal"]["id"]
    return keep, pin_id, proposal_id


def _link_events(race: Race, link_id: str) -> list[tuple[int, str]]:
    return [(e["seq"], e["kind"]) for e in race.events() if (e.get("edit") or {}).get("id") == link_id]


def _check_link(race: Race, link_id: str, *, pin: bool, proposal: bool) -> dict[str, int]:
    """The link's events are every event journaled under it but its own
    closing edit.undone; pins come back before edit.undone, and only
    proposal.reopened may follow it."""
    tagged = _link_events(race, link_id)
    seqs = {kind: seq for seq, kind in tagged}
    closing = seqs["edit.undone"]
    assert ("pin.reattached" in seqs) == pin and ("proposal.reopened" in seqs) == proposal, tagged
    if pin:
        assert seqs["pin.reattached"] < closing, tagged
    assert {kind for seq, kind in tagged if seq > closing} <= {"proposal.reopened"}, tagged
    link = race.main.canvas_undo_book.link_of(link_id)
    assert link is not None
    assert sorted(link.events) == sorted(seq for seq, kind in tagged if seq != closing), (link.events, tagged)
    return seqs


@pytest.mark.parametrize("what", ["pin", "proposal", "both"])
def test_an_agents_undo_keeps_the_pins_and_proposals_it_put_back_in_its_link(race, what):
    pin, proposal = what in ("pin", "both"), what in ("proposal", "both")
    keep, pin_id, proposal_id = _pinned_and_proposed(race, pin=pin, proposal=proposal)
    made = race.client.post("/api/graph/apply", headers=AGENT, json={"remove": [keep]})
    assert made.status_code == 200, made.text
    undo = race.client.post("/api/graph/apply/undo", headers=AGENT, json={"token": made.json()["undo"]["token"]})
    assert undo.status_code == 200, undo.text
    assert undo.json()["reattached"] == ([pin_id] if pin else [])
    assert undo.json()["reopened"] == ([proposal_id] if proposal else [])
    _check_link(race, undo.json()["undoId"], pin=pin, proposal=proposal)


def test_the_persons_cmd_z_of_an_agents_undo_lists_the_undos_pins_and_proposals(race):
    keep, _pin_id, _proposal_id = _pinned_and_proposed(race, pin=True, proposal=True)
    made = race.client.post("/api/graph/apply", headers=AGENT, json={"remove": [keep]})
    assert made.status_code == 200, made.text
    undo = race.client.post("/api/graph/apply/undo", headers=AGENT, json={"token": made.json()["undo"]["token"]})
    assert undo.status_code == 200, undo.text
    undo_id = undo.json()["undoId"]
    seqs = _check_link(race, undo_id, pin=True, proposal=True)
    again = race.client.post("/api/graph/restore", headers=PERSON, json={
        "action": "undo", "edit": undo_id, "remove": [keep], "nodes": []})
    assert again.status_code == 200, again.text
    undone = [e for e in race.events() if e["kind"] == "edit.undone"][-1]
    assert undone["data"]["editId"] == undo_id
    events = undone["data"]["events"]
    assert seqs["pin.reattached"] in events and seqs["proposal.reopened"] in events, (events, seqs)
    assert events == race.main.canvas_undo_book.link_of(undo_id).events


def test_the_persons_linked_cmd_z_keeps_the_pins_and_proposals_it_put_back_in_its_link(race):
    keep, pin_id, proposal_id = _pinned_and_proposed(race, pin=True, proposal=True)
    made = race.client.post("/api/graph/apply", headers=AGENT, json={"remove": [keep]})
    assert made.status_code == 200, made.text
    sync = next(m for m in reversed(race.sent) if m.get("type") == "graphSync" and m.get("edit"))
    answer = race.client.post("/api/graph/restore", headers=PERSON, json={
        "action": "undo", "edit": sync["edit"]["id"], "removals": sync["edit"]["removals"],
        "nodes": [{"id": keep, "definitionId": "text-input", "params": {"value": "a lighthouse"},
                   "position": {"x": 0, "y": 0}}]})
    assert answer.status_code == 200, answer.text
    assert answer.json()["reattached"] == [pin_id] and answer.json()["reopened"] == [proposal_id]
    undone = [e for e in race.events() if e["kind"] == "edit.undone"][-1]
    _check_link(race, undone["data"]["undoId"], pin=True, proposal=True)


# Item 2: an upload whose sync fails rolls its node back in the project it was
# written to. Node ids restart per project, so the rollback by id on whatever
# graph was live deleted B's n1 after a switch (review 8, P2).

def _png() -> bytes:
    import io

    from PIL import Image

    buf = io.BytesIO()
    Image.new("RGB", (64, 64), (200, 20, 20)).save(buf, format="PNG")
    return buf.getvalue()


def test_a_failed_upload_sync_after_a_switch_never_touches_the_project_open(race):
    def b_node() -> None:
        race.done["b_node"] = race.graph.add_node("text-input", {"value": "B's own"}, position={"x": 5, "y": 5})
        raise RuntimeError("socket gone")

    answer = race.run(lambda: race.client.post("/api/uploads", headers=PERSON, data={"create_node": "true"},
                                               files={"file": ("red.png", _png(), "image/png")}),
                      when=lambda data: data.get("type") == "graphSync", after=b_node)
    assert answer.status_code == 500, answer.text
    assert "nodeId" not in answer.json()
    b_node_id = race.done["b_node"]
    # B's own node, which has the id the upload's node had on A, is untouched.
    assert race.graph.nodes[b_node_id]["params"]["value"] == "B's own", race.graph.nodes
    # A no longer holds the upload's node: rolled back in A's stored graph.
    stored = race.store.read()["projects"][race.active]["snapshot"]
    assert [node for node in stored["nodes"] if (node.get("data") or {}).get("definitionId") == "image-input"] == []
    assert not [e for e in race.events() if e["kind"] == "node.added"], race.events()


# Item 3: a proposal an undo would reopen, while another project opened during
# its fit check's await: it stays closed (review 8, P3).

@pytest.mark.parametrize("b_has_n1", [False, True])
def test_an_undo_never_reopens_a_proposal_after_another_project_opened(race, monkeypatch, b_has_n1):
    main = race.main
    a = race.graph.add_node("text-input", {"value": "a lighthouse"}, position={"x": 0, "y": 0})
    made = race.client.post("/api/canvas/proposals", headers=CLAUDE, json={
        "note": "change it", "params": [{"nodeId": a, "params": {"value": "a castle"}}]})
    assert made.status_code == 201, made.text
    proposal_id = made.json()["proposal"]["id"]
    gone = race.client.delete(f"/api/graph/node/{a}", headers=PERSON)
    assert gone.status_code == 200, gone.text
    assert main.canvas_proposals.get(proposal_id).status == "invalidated"
    since = race.events()[-1]["seq"]
    real = main._look_up_models

    async def look_up(wanted):
        if "pin" not in race.done:
            await race.switch()
            if b_has_n1:  # B has a node with the id the proposal reads, of the same model
                race.graph.add_node("text-input", {"value": "a lighthouse"}, position={"x": 0, "y": 0})
        return await real(wanted)

    monkeypatch.setattr(main, "_look_up_models", look_up)
    race.done.clear()
    browser_before = len(race.browser)
    answer = race.client.post("/api/graph/restore", headers=PERSON, json={
        "action": "undo", "removals": [gone.json()["removal"]],
        "nodes": [{"id": a, "definitionId": "text-input", "params": {"value": "a lighthouse"},
                   "position": {"x": 0, "y": 0}}]})
    assert answer.status_code == 200, answer.text
    assert race.store.read()["activeProjectId"] == race.other
    assert answer.json()["reopened"] == []
    assert [row["id"] for row in answer.json()["notReopened"]] == [proposal_id]
    assert main.canvas_proposals.get(proposal_id).status == "invalidated"
    assert not [e for e in race.events() if e["seq"] > since and e["kind"] == "proposal.reopened"]
    assert not [m for m in race.browser[browser_before:] if m.get("type") == "proposalOpened"]


# -- review 9 (round 10) ---------------------------------------------------------------
# Item 2: a timer armed inside an undo ran with the undo's request context
# (loop.call_later copies it), so a reopened proposal's later proposal.expired,
# and every other proposal swept with it, carried the undo's edit tag and could
# land in the link's events (review 9, Q1). Timers now run in a fresh context.

def _propose_value(race: Race, headers: dict, node_id: str, value: str) -> str:
    made = race.client.post("/api/canvas/proposals", headers=headers, json={
        "note": f"set {value}", "params": [{"nodeId": node_id, "params": {"value": value}}]})
    assert made.status_code == 201, made.text
    return made.json()["proposal"]["id"]


def _two_proposals_deleted(race: Race) -> tuple[str, str, str, str, str, str]:
    """k1, k2 each with a proposal; another agent's proposal on a third node;
    then an agent deletes k1 and k2. Returns k1, k2, p1, p2, p3 and the undo token."""
    k1 = race.graph.add_node("text-input", {"value": "one"}, position={"x": 0, "y": 0})
    k2 = race.graph.add_node("text-input", {"value": "two"}, position={"x": 0, "y": 200})
    other = race.graph.add_node("text-input", {"value": "other"}, position={"x": 0, "y": 400})
    p1 = _propose_value(race, AGENT, k1, "uno")
    p2 = _propose_value(race, AGENT, k2, "dos")
    p3 = _propose_value(race, {"X-Nebula-Agent": "Codex"}, other, "unrelated")
    made = race.client.post("/api/graph/apply", headers=AGENT, json={"remove": [k1, k2]})
    assert made.status_code == 200, made.text
    return k1, k2, p1, p2, p3, made.json()["undo"]["token"]


def _async_client(race: Race):
    import httpx

    return httpx.AsyncClient(transport=httpx.ASGITransport(app=race.main.app), base_url="http://testserver")


def test_a_reopened_proposals_expiry_never_carries_the_undos_edit_link(race, monkeypatch):
    """Driven by the proposals' clock and by events, never a real-time
    budget (review 16 of PR #203, tests LOW-2: on a loaded runner more than
    the old 0.4 s passed before the undo reached p1, which was then already
    past due and stayed closed). The clock stands still until the undo is
    inside p2's slow Update write, so p1 reopens whatever the load; then p1
    and p3 fall due and the undo waits there until p1's timer, armed in the
    undo, has expired them."""
    import asyncio
    import time

    main = race.main
    _k1, _k2, p1, p2, p3, token = _two_proposals_deleted(race)
    clock = {"now": main.canvas_proposals.now()}
    monkeypatch.setattr(main.canvas_proposals, "_clock", lambda: clock["now"])
    # Due a moment after the clock's now: p1's timer, armed when it reopens,
    # fires about half a second later in real time.
    main.canvas_proposals.get(p1).expires_at = clock["now"] + 0.01
    main.canvas_proposals.get(p3).expires_at = clock["now"] + 0.01
    real = main._reopen_update

    def expired() -> list[dict]:
        return [e for e in race.events() if e["kind"] == "proposal.expired"]

    async def until(done, what: str) -> None:
        deadline = time.monotonic() + 15  # a hang guard only
        while not done():
            assert time.monotonic() < deadline, what
            await asyncio.sleep(0.01)

    async def slow_reopen_update(ref, proposal_id):
        # p2's Update write is slow (disk I/O under load): p1's timer, armed
        # in the undo, fires while the undo is still inside its link.
        if proposal_id == p2:
            clock["now"] += 1.0
            await until(lambda: {e["data"]["proposalId"] for e in expired()} >= {p1},
                        "p1's timer never expired it")
        return await real(ref, proposal_id)

    monkeypatch.setattr(main, "_reopen_update", slow_reopen_update)

    async def go():
        async with _async_client(race) as client:
            undo = await client.post("/api/graph/apply/undo", headers=AGENT, json={"token": token})
            await until(lambda: len(expired()) >= 2, "p1 and p3 never both expired")
            return undo

    undo = asyncio.run(go())
    assert undo.status_code == 200, undo.text
    assert undo.json()["reopened"] == [p1, p2]
    undo_id = undo.json()["undoId"]
    assert {e["data"]["proposalId"] for e in expired()} == {p1, p3}, [e["data"] for e in expired()]
    assert [e.get("edit") for e in expired()] == [None, None], expired()
    link = main.canvas_undo_book.link_of(undo_id)
    assert not {e["seq"] for e in expired()} & set(link.events), (link.events, expired())


# Item 4: the person's Cmd+Z of an agent's undo, while that undo still awaits a
# later proposal's fit check, lists the proposals it reopened before then
# (review 9, Q2): the link takes each proposal.reopened as it is journaled.

def test_the_persons_cmd_z_during_a_later_proposals_check_lists_an_earlier_reopen(race, monkeypatch):
    import asyncio

    main = race.main
    k1, k2, p1, _p2, _p3, token = _two_proposals_deleted(race)
    real = main._look_up_models
    state: dict[str, Any] = {}

    async def look_up(wanted):
        state["n"] = state.get("n", 0) + 1
        if state["n"] == 2:  # p2's check: the person's Cmd+Z lands here
            state["entered"].set()
            await state["release"].wait()
        return await real(wanted)

    monkeypatch.setattr(main, "_look_up_models", look_up)

    async def go():
        state["entered"], state["release"] = asyncio.Event(), asyncio.Event()
        async with _async_client(race) as client:
            undo_task = asyncio.create_task(client.post("/api/graph/apply/undo", headers=AGENT,
                                                        json={"token": token}))
            await asyncio.wait_for(state["entered"].wait(), 10)
            undo_id = next(e for e in race.events() if e["kind"] == "edit.undone")["data"]["undoId"]
            again = await client.post("/api/graph/restore", headers=PERSON, json={
                "action": "undo", "edit": undo_id, "remove": [k1, k2], "nodes": []})
            state["release"].set()
            return await undo_task, again, undo_id

    undo, again, undo_id = asyncio.run(go())
    assert undo.status_code == 200 and again.status_code == 200, (undo.text, again.text)
    reopened = [e for e in race.events() if e["kind"] == "proposal.reopened" and e["data"]["proposalId"] == p1]
    assert len(reopened) == 1 and (reopened[0].get("edit") or {}).get("id") == undo_id, reopened
    persons = [e for e in race.events() if e["kind"] == "edit.undone" and e["data"].get("editId") == undo_id][-1]
    assert reopened[0]["seq"] in persons["data"]["events"], (persons["data"]["events"], reopened[0]["seq"])


# Item 3: a link kept only its oldest 50 events, so a big undo's
# pin.reattached / proposal.reopened fell off silently (review 9, Q6, a
# 55-node delete). Every pin.* and proposal.* event is kept; only the bulk
# node and wire events are capped, and a cut says so (eventsTruncated, eventsTotal).

def _all_events(race: Race) -> list[dict]:
    out: list[dict] = []
    after = 0
    while True:
        page = race.journal.read(after=after, limit=200)["events"]
        if not page:
            return out
        out += page
        after = page[-1]["seq"]


def test_a_big_undos_link_keeps_its_pins_and_proposals_and_says_it_was_cut(race):
    from services.canvas_undo import MAX_LINK_EVENTS

    main = race.main
    nodes = [race.graph.add_node("text-input", {"value": f"v{i}"}, position={"x": 0, "y": 60 * i})
             for i in range(MAX_LINK_EVENTS + 5)]
    pin_id = _pin_on(race, nodes[-1])
    proposal_id = _propose_value(race, CLAUDE, nodes[-1], "changed")
    made = race.client.post("/api/graph/apply", headers=AGENT, json={"remove": nodes})
    assert made.status_code == 200, made.text
    edit_id = made.json()["undo"]["editId"]
    undo = race.client.post("/api/graph/apply/undo", headers=AGENT, json={"token": made.json()["undo"]["token"]})
    assert undo.status_code == 200, undo.text
    assert undo.json()["reattached"] == [pin_id] and undo.json()["reopened"] == [proposal_id]
    undo_id = undo.json()["undoId"]
    events = _all_events(race)

    def tagged(link_id: str, *skip: str) -> list[tuple[int, str]]:
        return [(e["seq"], e["kind"]) for e in events if (e.get("edit") or {}).get("id") == link_id
                and e["kind"] not in skip]

    # The undo's own link.
    mine = tagged(undo_id, "edit.undone")
    link = main.canvas_undo_book.link_of(undo_id)
    special = [seq for seq, kind in mine if kind.startswith(("pin.", "proposal."))]
    assert len(special) == 2, mine
    assert set(special) <= set(link.events), (special, link.events)
    assert len([seq for seq in link.events if seq not in special]) == MAX_LINK_EVENTS
    assert link.truncated is True and link.total == len(mine), (link.total, len(mine))
    # The edit.undone of the agent's undo lists the edit's link, cut the same way.
    undone = next(e for e in events if e["kind"] == "edit.undone" and e["data"].get("undoId") == undo_id)
    edits = tagged(edit_id)
    detached = [seq for seq, kind in edits if kind.startswith(("pin.", "proposal."))]
    assert len(detached) == 2, edits
    assert set(detached) <= set(undone["data"]["events"])
    assert undone["data"]["eventsTruncated"] is True and undone["data"]["eventsTotal"] == len(edits)
    # The person's Cmd+Z of that undo lists the undo's link, its pin and proposal included.
    again = race.client.post("/api/graph/restore", headers=PERSON, json={
        "action": "undo", "edit": undo_id, "remove": nodes, "nodes": []})
    assert again.status_code == 200, again.text
    last = [e for e in _all_events(race) if e["kind"] == "edit.undone"][-1]
    assert last["data"]["editId"] == undo_id
    assert set(special) <= set(last["data"]["events"])
    assert last["data"]["eventsTruncated"] is True and last["data"]["eventsTotal"] == len(mine)


def test_a_small_undo_lists_every_event_and_no_cut(race):
    keep, _pin_id, _proposal_id = _pinned_and_proposed(race, pin=True, proposal=True)
    made = race.client.post("/api/graph/apply", headers=AGENT, json={"remove": [keep]})
    undo = race.client.post("/api/graph/apply/undo", headers=AGENT, json={"token": made.json()["undo"]["token"]})
    assert undo.status_code == 200, undo.text
    undone = next(e for e in race.events() if e["kind"] == "edit.undone")
    assert "eventsTruncated" not in undone["data"] and "eventsTotal" not in undone["data"]
    link = race.main.canvas_undo_book.link_of(undo.json()["undoId"])
    assert link.truncated is False
