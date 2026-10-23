"""Undo puts back everything a delete removed (GM - Design, 2026-10-23, item 1:
"Make undo complete ... Reopen a proposal only if it's still valid against
the restored graph. If one can't be reopened, the Undo notice says so").

A node's delete detaches the pins on it and closes the proposals that read
it. Each delete now has a removal record ({id: rm_..., nodeId, pins,
proposals}): the delete's answer carries it (and an edit's graphSync, for a
canvas that didn't send it), the canvas keeps it in its undo step, and the
restore that brings the node back names it again. The backend re-checks every
pin and proposal: a pin goes back on the node only if this very removal
detached it and it hasn't changed since; a proposal reopens only if this
removal closed it and the proposal system's own accept checks still pass.
"""
from __future__ import annotations

import copy

import pytest

from services.agent_notes import AgentNotes
from services.canvas_pins import CanvasPins
from services.canvas_proposals import PROPOSAL_TTL_SECONDS, ProposalBook
from tests.conftest import PERSON
from tests.test_canvas_proposals import (  # noqa: F401 - api is a fixture
    CLAUDE,
    KEY,
    _key,
    _propose,
    _upscale_body,
    api,
)

TAB_A = {**PERSON, "X-Nebula-Tab": "tab-aaaaaaaaaaaaaaaa"}
TAB_B = {**PERSON, "X-Nebula-Tab": "tab-bbbbbbbbbbbbbbbb"}


@pytest.fixture
def canvas(api, monkeypatch):
    monkeypatch.setattr(api.main, "agent_notes", AgentNotes(lambda: api.main.project_store))
    api.timers = []
    monkeypatch.setattr(api.main, "_call_later", lambda delay, fn, *args: api.timers.append((delay, fn, args)))
    return api


def _pin(api, node_id: str, text: str = "warmer") -> dict:
    created = api.client.post("/api/canvas/pins", headers=PERSON, json={"text": text, "nodeId": node_id})
    assert created.status_code == 201, created.text
    return created.json()["pin"]


def _pins(api) -> dict[str, dict]:
    return {pin["id"]: pin for pin in api.client.get("/api/canvas/pins").json()["pins"]}


def _whole(api, node_id: str) -> dict:
    """The restore item that brings a node back, as the canvas sends it."""
    node = api.graph.nodes[node_id]
    return {"id": node_id, "definitionId": node["definitionId"], "params": copy.deepcopy(node.get("params") or {}),
            "label": node.get("label") or "", "position": copy.deepcopy(node.get("position") or {"x": 0, "y": 0}),
            "outputs": copy.deepcopy(node.get("outputs") or {})}


def _delete(api, node_id: str, headers=PERSON) -> dict:
    response = api.client.delete(f"/api/graph/node/{node_id}", headers=headers)
    assert response.status_code == 200, response.text
    return response.json()


def _restore(api, items, removals, *, action="undo", headers=PERSON, wire=()):
    body = {"action": action, "nodes": items, "remove": [], "wire": list(wire), "unwire": [], "removals": removals}
    return api.client.post("/api/graph/restore", headers=headers, json=body)


def _kinds(api, prefix: str) -> list[str]:
    return [event["kind"] for event in api.journal.read(after=0, limit=100)["events"] if event["kind"].startswith(prefix)]


def _setup(api):
    """n1 (a text input) with a pin, and Claude's open proposal that reads it."""
    n1 = api.graph.add_node("text-input", {"value": "a cat"}, position={"x": 120, "y": 80})
    pin = _pin(api, n1)
    proposal = _propose(api, _upscale_body(n1)).json()["proposal"]["id"]
    return n1, pin, proposal


# -- the delete names what it removed ---------------------------------------------------

def test_the_delete_answer_names_the_pins_it_detached_and_the_proposals_it_closed(canvas):
    n1, pin, proposal = _setup(canvas)
    answer = _delete(canvas, n1)
    removal = answer["removal"]
    assert removal["id"].startswith("rm_") and len(removal["id"]) == 19
    assert removal["nodeId"] == n1
    assert removal["pins"] == [pin["id"]] and removal["proposals"] == [proposal]
    stored = _pins(canvas)[pin["id"]]
    assert stored["detached"] is True and stored["detachedFrom"] == n1 and stored["detachedBy"] == removal["id"]


def test_undo_puts_the_pin_back_at_its_anchor_and_reopens_the_proposal(canvas):
    n1, pin, proposal = _setup(canvas)
    item = _whole(canvas, n1)
    removal = _delete(canvas, n1)["removal"]
    assert canvas.book.get(proposal).status == "invalidated"
    canvas.browser.clear()

    restored = _restore(canvas, [item], [removal])
    assert restored.status_code == 200, restored.text
    body = restored.json()
    assert body["reattached"] == [pin["id"]]
    assert body["reopened"] == [proposal] and body["notReopened"] == [] and body["pinsLeft"] == []

    back = _pins(canvas)[pin["id"]]
    # As if the delete never happened.
    assert back["anchor"] == pin["anchor"] == {"nodeId": n1}
    assert back["position"] == pin["position"] and back["detached"] is False
    assert "detachedFrom" not in back and "detachedBy" not in back
    assert canvas.book.get(proposal).status == "open" and canvas.book.get(proposal).reason is None
    # The person's canvas gets it as open again, with its key; agents read the journal.
    opened = [m for m in canvas.browser if m.get("type") == "proposalOpened"]
    assert opened and opened[-1]["proposal"]["id"] == proposal and opened[-1]["acceptKey"]
    assert "pin.reattached" in _kinds(canvas, "pin.") and "proposal.reopened" in _kinds(canvas, "proposal.")
    reopened = [e for e in canvas.journal.read(after=0, limit=100)["events"] if e["kind"] == "proposal.reopened"][0]
    assert reopened["data"]["proposalId"] == proposal and reopened["actor"]["kind"] == "person"
    reattached = [e for e in canvas.journal.read(after=0, limit=100)["events"] if e["kind"] == "pin.reattached"][0]
    assert reattached["data"]["pinId"] == pin["id"] and reattached["nodeId"] == n1
    # Agents see it open in the list they already read.
    assert [p["id"] for p in canvas.client.get("/api/canvas/proposals").json()["proposals"]] == [proposal]
    # Its Update has its Review again.
    updates = [n for n in canvas.main.project_store.read()["projects"][canvas.project_id]["agentNotes"]
               if n.get("about") == "proposal"]
    assert updates and not updates[0].get("resolvedAt") and not updates[0].get("outcome")
    # Accept works on the reopened proposal.
    accepted = canvas.client.post(f"/api/canvas/proposals/{proposal}/accept",
                                  headers={**PERSON, KEY: _key(canvas, proposal)}, json={})
    assert accepted.status_code == 200, accepted.text


def test_redo_deletes_again_and_a_second_undo_still_restores(canvas):
    n1, pin, proposal = _setup(canvas)
    item = _whole(canvas, n1)
    first = _delete(canvas, n1)["removal"]
    assert _restore(canvas, [item], [first]).json()["reopened"] == [proposal]

    redo = canvas.client.post("/api/graph/restore", headers=PERSON, json={
        "action": "redo", "nodes": [], "remove": [n1], "wire": [], "unwire": []})
    assert redo.status_code == 200, redo.text
    (second,) = redo.json()["removals"]
    assert second["id"] != first["id"] and second["pins"] == [pin["id"]] and second["proposals"] == [proposal]
    assert _pins(canvas)[pin["id"]]["detachedBy"] == second["id"]
    assert canvas.book.get(proposal).status == "invalidated"

    # The first removal is spent: naming it again does nothing.
    stale = _restore(canvas, [item], [first]).json()
    assert stale["reattached"] == [] and stale["reopened"] == []
    assert _pins(canvas)[pin["id"]]["detached"] is True
    canvas.client.post("/api/graph/restore", headers=PERSON, json={
        "action": "redo", "nodes": [], "remove": [n1], "wire": [], "unwire": []})
    third = canvas.client.get("/api/canvas/pins").json()["pins"][0]["detachedBy"]
    again = _restore(canvas, [item], [{"id": third, "nodeId": n1, "pins": [pin["id"]], "proposals": [proposal]}])
    assert again.json()["reattached"] == [pin["id"]] and again.json()["reopened"] == [proposal]


# -- every proposal re-checked ------------------------------------------------------------

def test_a_proposal_that_expired_meanwhile_stays_closed_and_is_counted(canvas):
    n1, pin, proposal = _setup(canvas)
    item = _whole(canvas, n1)
    removal = _delete(canvas, n1)["removal"]
    canvas.clock.now += PROPOSAL_TTL_SECONDS + 1
    body = _restore(canvas, [item], [removal]).json()
    assert body["reattached"] == [pin["id"]] and body["reopened"] == []
    assert [row["id"] for row in body["notReopened"]] == [proposal]
    assert "expired" in body["notReopened"][0]["reason"]
    assert canvas.book.get(proposal).status == "invalidated"


def test_after_a_restart_pins_come_back_and_lost_proposals_are_counted(canvas, monkeypatch):
    n1, pin, proposal = _setup(canvas)
    item = _whole(canvas, n1)
    removal = _delete(canvas, n1)["removal"]
    # A restart: pins persist with the project; proposals live in memory.
    monkeypatch.setattr(canvas.main, "canvas_pins", CanvasPins(lambda: canvas.main.project_store))
    monkeypatch.setattr(canvas.main, "canvas_proposals", ProposalBook(canvas.clock))
    body = _restore(canvas, [item], [removal]).json()
    assert body["reattached"] == [pin["id"]]
    assert body["reopened"] == [] and [row["id"] for row in body["notReopened"]] == [proposal]
    assert _pins(canvas)[pin["id"]]["anchor"] == {"nodeId": n1}


def test_a_proposal_that_no_longer_fits_stays_closed(canvas):
    """The person changed what the proposal sets while its node was gone:
    accept would refuse it, so undo doesn't reopen it."""
    n1 = canvas.graph.add_node("text-input", {"value": "a cat"})
    n2 = canvas.graph.add_node("text-input", {"value": "a dog"})
    body = {**_upscale_body(n1), "params": [{"nodeId": n2, "params": {"value": "a dog at dusk"}}]}
    proposal = _propose(canvas, body).json()["proposal"]["id"]
    item = _whole(canvas, n1)
    removal = _delete(canvas, n1)["removal"]
    assert canvas.client.put(f"/api/graph/node/{n2}", headers=PERSON,
                             json={"params": {"value": "a horse"}}).status_code == 200
    answer = _restore(canvas, [item], [removal]).json()
    assert answer["reopened"] == [] and [row["id"] for row in answer["notReopened"]] == [proposal]
    assert "changed after it was proposed" in answer["notReopened"][0]["reason"]


def test_deciding_another_proposal_in_between_doesnt_stop_the_reopen(canvas):
    n1, pin, first = _setup(canvas)
    n2 = canvas.graph.add_node("text-input", {"value": "a dog"})
    second = _propose(canvas, _upscale_body(n2)).json()["proposal"]["id"]
    item = _whole(canvas, n1)
    removal = _delete(canvas, n1)["removal"]
    rejected = canvas.client.post(f"/api/canvas/proposals/{second}/reject",
                                  headers={**PERSON, KEY: _key(canvas, second)}, json={})
    assert rejected.status_code == 200, rejected.text
    answer = _restore(canvas, [item], [{**removal, "proposals": [first, second]}]).json()
    # The rejected one wasn't closed by this delete: it stays rejected and isn't counted.
    assert answer["reopened"] == [first] and answer["notReopened"] == []
    assert canvas.book.get(second).status == "rejected"


def test_nodes_that_share_a_proposal_reopen_it_only_when_both_are_back(canvas):
    n1 = canvas.graph.add_node("text-input", {"value": "a cat"})
    n2 = canvas.graph.add_node("text-input", {"value": "a dog"})
    pins = [_pin(canvas, n1, "one"), _pin(canvas, n2, "two")]
    body = {"note": "Two prompts", "nodes": [
        {"ref": "+a", "definitionId": "nano-banana", "params": {}},
        {"ref": "+b", "definitionId": "nano-banana", "params": {}}],
        "edges": [{"source": n1, "sourceHandle": "text", "target": "+a", "targetHandle": "prompt"},
                  {"source": n2, "sourceHandle": "text", "target": "+b", "targetHandle": "prompt"}]}
    proposal = _propose(canvas, body).json()["proposal"]["id"]
    items = [_whole(canvas, n1), _whole(canvas, n2)]
    removals = [_delete(canvas, n1)["removal"], _delete(canvas, n2)["removal"]]
    assert removals[0]["proposals"] == [proposal] and removals[1]["proposals"] == []

    # Only n1 back: the proposal still needs n2, which undoing n2's delete
    # brings back, so it waits, closed, and isn't counted yet.
    partial = _restore(canvas, items[:1], removals[:1]).json()
    assert partial["reattached"] == [pins[0]["id"]] and partial["reopened"] == []
    assert partial["notReopened"] == []
    assert canvas.book.get(proposal).status == "invalidated"

    rest = _restore(canvas, items[1:], removals[1:]).json()
    assert rest["reattached"] == [pins[1]["id"]]
    assert rest["reopened"] == [proposal] and rest["notReopened"] == []


def test_nodes_deleted_together_come_back_together(canvas):
    n1 = canvas.graph.add_node("text-input", {"value": "a cat"})
    n2 = canvas.graph.add_node("text-input", {"value": "a dog"})
    body = {"note": "Two prompts", "nodes": [{"ref": "+a", "definitionId": "nano-banana", "params": {}}],
            "edges": [{"source": n1, "sourceHandle": "text", "target": "+a", "targetHandle": "prompt"}],
            "params": [{"nodeId": n2, "params": {"value": "a dog at dusk"}}]}
    proposal = _propose(canvas, body).json()["proposal"]["id"]
    items = [_whole(canvas, n1), _whole(canvas, n2)]
    applied = canvas.client.post("/api/graph/apply", headers=CLAUDE, json={"remove": [n1, n2]}).json()
    both = _restore(canvas, items, applied["removals"], headers=TAB_B).json()
    assert both["reopened"] == [proposal] and both["notReopened"] == []


# -- a stale or forged list ----------------------------------------------------------------

def test_a_forged_or_stale_list_attaches_nothing_and_reopens_nothing(canvas):
    n1, pin, proposal = _setup(canvas)
    n2 = canvas.graph.add_node("text-input", {"value": "a dog"})
    other_pin = _pin(canvas, n2, "other")
    item = _whole(canvas, n1)
    removal = _delete(canvas, n1)["removal"]
    _delete(canvas, n2)

    # A made-up removal id, and someone else's pin and proposal under the real one.
    forged = _restore(canvas, [item], [{"id": "rm_0000000000000000", "nodeId": n1, "pins": [pin["id"]],
                                         "proposals": [proposal]}]).json()
    assert forged["reattached"] == [] and forged["reopened"] == [] and forged["notReopened"] == []
    assert [row["id"] for row in forged["pinsLeft"]] == [pin["id"]]
    assert _pins(canvas)[pin["id"]]["detached"] is True
    canvas.client.post("/api/graph/restore", headers=PERSON, json={
        "action": "redo", "nodes": [], "remove": [n1], "wire": [], "unwire": []})
    current = _pins(canvas)[pin["id"]]["detachedBy"]
    wrong_node = _restore(canvas, [item], [{"id": current, "nodeId": n2, "pins": [other_pin["id"]]}]).json()
    # n2 isn't what this restore brings back; the named pin belongs to another removal.
    assert wrong_node["reattached"] == []
    assert _pins(canvas)[other_pin["id"]]["detached"] is True
    # A removal for a node that is already on the canvas does nothing.
    noop = _restore(canvas, [item], [{"id": current, "nodeId": n1}]).json()
    assert noop["reattached"] == [] and noop["reopened"] == []


@pytest.mark.parametrize("bad", [
    "nope", [{"id": "rm_x", "nodeId": "n1"}], [{"id": "rm_0000000000000000", "nodeId": "x"}],
    [{"id": "rm_0000000000000000", "nodeId": "n1", "pins": "pin_1"}],
])
def test_bad_removals_are_refused(canvas, bad):
    response = canvas.client.post("/api/graph/restore", headers=PERSON, json={
        "action": "undo", "nodes": [], "remove": [], "wire": [], "unwire": [], "removals": bad})
    assert response.status_code == 400


def test_a_pin_deleted_since_is_left_and_reported(canvas):
    n1, pin, _proposal = _setup(canvas)
    item = _whole(canvas, n1)
    removal = _delete(canvas, n1)["removal"]
    assert canvas.client.delete(f"/api/canvas/pins/{pin['id']}", headers=PERSON).status_code == 200
    body = _restore(canvas, [item], [removal]).json()
    assert body["reattached"] == [] and body["pinsLeft"] == [{"id": pin["id"], "reason": "deleted since"}]


def test_a_pin_detached_before_this_delete_stays_where_it_is(canvas):
    """A pin an import or clear detached from an earlier node with the same id
    isn't this delete's: undo leaves it."""
    n1 = canvas.graph.add_node("text-input", {"value": "a cat"})
    old = _pin(canvas, n1, "old")
    assert canvas.client.delete("/api/graph?force=true", headers=PERSON).status_code == 200
    again = canvas.graph.add_node("text-input", {"value": "new"})
    assert again == n1  # ids start again after a clear
    item = _whole(canvas, again)
    removal = _delete(canvas, again)["removal"]
    assert removal["pins"] == []
    body = _restore(canvas, [item], [{**removal, "pins": [old["id"]]}]).json()
    assert body["reattached"] == [] and [row["id"] for row in body["pinsLeft"]] == [old["id"]]
    assert _pins(canvas)[old["id"]]["detached"] is True


# -- every path ------------------------------------------------------------------------------

def test_an_agents_delete_undone_by_the_person_restores_everything(canvas):
    n1, pin, proposal = _setup(canvas)
    item = _whole(canvas, n1)
    canvas.sent.clear()
    applied = canvas.client.post("/api/graph/apply", headers=CLAUDE, json={"remove": [n1]})
    assert applied.status_code == 200, applied.text
    # The canvas that didn't send it reads the removal on the edit's graphSync.
    sync = next(m for m in canvas.sent if m.get("type") == "graphSync" and m.get("edit"))
    (removal,) = sync["edit"]["removals"]
    assert removal["nodeId"] == n1 and removal["pins"] == [pin["id"]] and removal["proposals"] == [proposal]
    assert applied.json()["removals"] == [removal]

    body = _restore(canvas, [item], [removal], headers=TAB_B).json()
    assert body["reattached"] == [pin["id"]] and body["reopened"] == [proposal]


def test_an_agents_own_undo_restores_pins_and_proposals(canvas):
    n1, pin, proposal = _setup(canvas)
    applied = canvas.client.post("/api/graph/apply", headers=CLAUDE, json={"remove": [n1]}).json()
    undone = canvas.client.post("/api/graph/apply/undo", headers=CLAUDE, json={"token": applied["undo"]["token"]})
    assert undone.status_code == 200, undone.text
    body = undone.json()
    assert body["reattached"] == [pin["id"]] and body["reopened"] == [proposal] and body["notReopened"] == []
    assert "1 pin back on its node" in body["message"] and "reopened 1 proposal" in body["message"]
    assert _pins(canvas)[pin["id"]]["anchor"] == {"nodeId": n1}
    assert canvas.book.get(proposal).status == "open"


def test_mcp_remove_then_undo_over_the_tools(canvas, monkeypatch):
    import mcp_server
    from nebula_api import NebulaAPI

    monkeypatch.delenv("NEBULA_AGENT_TOKEN", raising=False)
    monkeypatch.setenv("NEBULA_AGENT_NAME", "Claude Code")
    monkeypatch.setattr(mcp_server, "_api", lambda: NebulaAPI("http://testserver", client=canvas.client))
    n1, pin, proposal = _setup(canvas)
    removed = mcp_server.remove_from_canvas(node_ids=[n1])
    assert removed["removals"][0]["pins"] == [pin["id"]]
    undone = mcp_server.undo_canvas_edit(token=removed["undo"]["token"])
    assert undone["reattached"] == [pin["id"]] and undone["reopened"] == [proposal]


def test_undo_in_a_second_tab_then_the_first_changes_nothing_twice(canvas):
    n1, pin, proposal = _setup(canvas)
    item = _whole(canvas, n1)
    canvas.sent.clear()
    removal = _delete(canvas, n1, headers=TAB_A)["removal"]
    sync = next(m for m in canvas.sent if m.get("type") == "graphSync" and m.get("edit"))
    assert sync["edit"]["removals"] == [removal]
    assert _restore(canvas, [item], [removal], headers=TAB_B).json()["reopened"] == [proposal]
    # Tab A's own undo now finds the node there already: nothing more happens.
    late = _restore(canvas, [item], [removal], headers=TAB_A).json()
    assert late["reattached"] == [] and late["reopened"] == [] and late["notReopened"] == []
    assert _kinds(canvas, "proposal.reopened").count("proposal.reopened") == 1


def test_an_agent_edit_after_the_undo_leaves_the_reattached_pin_alone(canvas):
    n1, pin, proposal = _setup(canvas)
    item = _whole(canvas, n1)
    removal = _delete(canvas, n1)["removal"]
    _restore(canvas, [item], [removal])
    edited = canvas.client.post("/api/graph/apply", headers=CLAUDE,
                                json={"params": [{"nodeId": n1, "params": {"value": "a cat at dusk"}}]})
    assert edited.status_code == 200, edited.text
    undone = canvas.client.post("/api/graph/apply/undo", headers=CLAUDE, json={"token": edited.json()["undo"]["token"]})
    assert undone.status_code == 200 and undone.json()["reattached"] == []
    assert _pins(canvas)[pin["id"]]["anchor"] == {"nodeId": n1}
    assert canvas.book.get(proposal).status == "open"


# -- asset proposals the same delete closed --------------------------------------------------

def test_a_cover_proposal_the_delete_closed_reopens_with_its_image(canvas, monkeypatch):
    from services import asset_proposals

    book = asset_proposals.AssetProposalBook(canvas.clock)
    monkeypatch.setattr(canvas.main, "asset_proposals", book)
    a = canvas.graph.add_node("nano-banana", {}, outputs={"image": {"type": "Image", "value": "/api/outputs/a.png"}})
    c = canvas.graph.add_node("nano-banana", {}, outputs={"image": {"type": "Image", "value": "/api/outputs/c.png"}})
    assert canvas.client.put(f"/api/projects/{canvas.project_id}/cover", headers=PERSON,
                             json={"url": "/api/outputs/a.png"}).status_code == 200
    proposed = canvas.client.post("/api/asset-proposals", headers=CLAUDE, json={
        "kind": "project", "id": canvas.project_id, "change": {"cover": "/api/outputs/c.png"}, "note": "Dusk"})
    assert proposed.status_code in (200, 201), proposed.text
    cover = proposed.json()["proposal"]["id"]
    item = _whole(canvas, c)
    removal = _delete(canvas, c)["removal"]
    assert book.get(cover).status == "invalidated"
    body = _restore(canvas, [item], [removal]).json()
    assert body["reopened"] == [cover] and book.get(cover).status == "open"
    assert a in canvas.graph.nodes


def _cover_setup(canvas, monkeypatch):
    """A project cover proposal that uses node c's image (a's image is the cover now)."""
    from services import asset_proposals

    book = asset_proposals.AssetProposalBook(canvas.clock)
    monkeypatch.setattr(canvas.main, "asset_proposals", book)
    canvas.graph.add_node("nano-banana", {}, outputs={"image": {"type": "Image", "value": "/api/outputs/a.png"}})
    c = canvas.graph.add_node("nano-banana", {}, outputs={"image": {"type": "Image", "value": "/api/outputs/c.png"}})
    assert canvas.client.put(f"/api/projects/{canvas.project_id}/cover", headers=PERSON,
                             json={"url": "/api/outputs/a.png"}).status_code == 200
    proposed = canvas.client.post("/api/asset-proposals", headers=CLAUDE, json={
        "kind": "project", "id": canvas.project_id, "change": {"cover": "/api/outputs/c.png"}, "note": "Dusk"})
    assert proposed.status_code in (200, 201), proposed.text
    return book, c, proposed.json()["proposal"]["id"]


def _autosave(canvas):
    """What the canvas's autosave (and GET /api/projects) does: the live graph
    written over the stored snapshot, so the snapshot no longer has a deleted
    node's image."""
    import asyncio

    main = canvas.main
    exported = asyncio.run(main.export_graph_for_frontend())
    with main.project_store.transaction() as catalog:
        main._overlay_live_project(catalog["projects"][canvas.project_id], exported)
        main.project_store.commit(catalog)


def test_a_cover_proposal_reopens_after_the_canvas_autosaved_the_delete(canvas, monkeypatch):
    # Review: the reopen check read the stored snapshot, not the restored live
    # graph as Accept does, so after an autosave it said the image was gone.
    book, c, cover = _cover_setup(canvas, monkeypatch)
    item = _whole(canvas, c)
    removal = _delete(canvas, c)["removal"]
    assert book.get(cover).status == "invalidated"
    _autosave(canvas)
    body = _restore(canvas, [item], [removal]).json()
    assert body["reopened"] == [cover], body["notReopened"]
    assert book.get(cover).status == "open"


def test_a_cover_proposal_lost_to_a_restart_is_counted(canvas, monkeypatch):
    # Review: a cover proposal closes during the delete's graphSync, after the
    # record was made, so a restart lost it without the notice counting it.
    from services import asset_proposals

    book, c, cover = _cover_setup(canvas, monkeypatch)
    item = _whole(canvas, c)
    canvas.sent.clear()
    removal = _delete(canvas, c, headers=TAB_A)["removal"]
    assert cover in removal["proposals"]
    sync = next(m for m in canvas.sent if m.get("type") == "graphSync" and m.get("edit"))
    assert cover in sync["edit"]["removals"][0]["proposals"]
    # Without a restart it reopens once and isn't counted as lost too.
    first = _restore(canvas, [item], [removal]).json()
    assert first["reopened"] == [cover] and first["notReopened"] == []
    removal = _delete(canvas, c)["removal"]
    assert cover in removal["proposals"]
    monkeypatch.setattr(canvas.main, "asset_proposals", asset_proposals.AssetProposalBook(canvas.clock))
    body = _restore(canvas, [item], [removal]).json()
    assert body["reopened"] == [] and [row["id"] for row in body["notReopened"]] == [cover]


def test_an_agents_cover_loss_after_a_restart_is_counted_in_its_undo(canvas, monkeypatch):
    from services import asset_proposals

    book, c, cover = _cover_setup(canvas, monkeypatch)
    applied = canvas.client.post("/api/graph/apply", headers=CLAUDE, json={"remove": [c]})
    assert applied.status_code == 200, applied.text
    assert cover in applied.json()["removals"][0]["proposals"]
    monkeypatch.setattr(canvas.main, "asset_proposals", asset_proposals.AssetProposalBook(canvas.clock))
    undone = canvas.client.post("/api/graph/apply/undo", headers=CLAUDE,
                                json={"token": applied.json()["undo"]["token"]}).json()
    assert c in undone["added"] and [row["id"] for row in undone["notReopened"]] == [cover]


# -- the agent's own undo after the person undid and redid -----------------------------------

def test_an_agents_undo_after_the_person_undid_and_redid_its_delete(canvas):
    # Review: the redo deleted again under a new removal, but the agent's
    # record kept the first one, so its undo left the pin and the proposal.
    n1, pin, proposal = _setup(canvas)
    item = _whole(canvas, n1)
    canvas.sent.clear()
    applied = canvas.client.post("/api/graph/apply", headers=CLAUDE, json={"remove": [n1]}).json()
    sync = next(m for m in canvas.sent if m.get("type") == "graphSync" and m.get("edit"))
    edit_id = sync["edit"]["id"]
    (removal,) = sync["edit"]["removals"]
    undo = canvas.client.post("/api/graph/restore", headers=TAB_B, json={
        "action": "undo", "nodes": [item], "remove": [], "wire": [], "unwire": [], "edit": edit_id,
        "removals": [removal]}).json()
    assert undo["reattached"] == [pin["id"]] and undo["reopened"] == [proposal]
    redo = canvas.client.post("/api/graph/restore", headers=TAB_B, json={
        "action": "redo", "nodes": [], "remove": [n1], "wire": [], "unwire": [], "edit": edit_id})
    assert redo.status_code == 200, redo.text
    assert canvas.book.get(proposal).status == "invalidated"
    agent = canvas.client.post("/api/graph/apply/undo", headers=CLAUDE, json={"token": applied["undo"]["token"]})
    assert agent.status_code == 200, agent.text
    body = agent.json()
    assert n1 in canvas.graph.nodes
    assert body["reattached"] == [pin["id"]] and body["reopened"] == [proposal] and body["pinsLeft"] == []
    assert _pins(canvas)[pin["id"]]["anchor"] == {"nodeId": n1}
    assert canvas.book.get(proposal).status == "open"


def test_an_agents_undo_again_after_the_person_undid_its_undo(canvas):
    # The person's Cmd+Z of the agent's undo deletes again, with new records:
    # the agent's next undo of its edit names those.
    n1, pin, proposal = _setup(canvas)
    applied = canvas.client.post("/api/graph/apply", headers=CLAUDE, json={"remove": [n1]}).json()
    canvas.sent.clear()
    first = canvas.client.post("/api/graph/apply/undo", headers=CLAUDE, json={"token": applied["undo"]["token"]})
    assert first.json()["reopened"] == [proposal]
    sync = next(m for m in canvas.sent if m.get("type") == "graphSync" and m.get("edit"))
    person = canvas.client.post("/api/graph/restore", headers=TAB_B, json={
        "action": "undo", "nodes": [], "remove": [n1], "wire": [], "unwire": [], "edit": sync["edit"]["id"]})
    assert person.status_code == 200, person.text
    assert n1 not in canvas.graph.nodes and canvas.book.get(proposal).status == "invalidated"
    again = canvas.client.post("/api/graph/apply/undo", headers=CLAUDE, json={"token": applied["undo"]["token"]})
    assert again.status_code == 200, again.text
    body = again.json()
    assert body["status"] == "undone" and n1 in body["added"]
    assert body["reattached"] == [pin["id"]] and body["reopened"] == [proposal]


# -- the CLI twin ----------------------------------------------------------------------------

def test_nebula_undo_and_watch_say_what_came_back():
    from cli.formatter import format_event, format_undone

    text = format_undone({"status": "undone", "added": ["n1"], "reattached": ["pin_1"], "reopened": ["p_1"],
                          "notReopened": [{"id": "p_2", "reason": "it expired"}], "skipped": []})
    assert "Back on its node: pin_1" in text and "Reopened: p_1" in text
    assert "Couldn't reopen p_2: it expired" in text
    line = format_event({"kind": "proposal.reopened", "seq": 3, "data": {"proposalId": "p_1"},
                         "summary": "reopened Claude's proposal p_1", "actor": {"kind": "person"}})
    assert "nebula proposal p_1 --wait" in line
