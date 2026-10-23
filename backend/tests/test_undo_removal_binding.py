"""A removal record undoes exactly one delete of exactly one node (second review, 2026-10-23).

Node ids are not unique over time: an import or a clear starts CLIGraph's
counter at n1 again, a restore may put any id back, and every project has its
own n1. So nothing may match a removal record, a proposal's tag or a pin by
the bare node id:

- renewal swaps only the record a later delete of the same node supersedes
  (the delete names it in ``replaces``; the restore that brought the node back
  remembered which removal it consumed);
- a record carries the project it was made in, and only that project's
  undo uses it;
- a proposal is tagged only by deletes in its own project, and a clear, an
  import or a project switch drops the earlier deletes' tags;
- a proposal's tag is a (removal, node) pair, and only a matching pair counts;
- a pin goes back only onto the same model it was detached from, and agents
  never see the removal ids on the person's pins;
- only the person's restore carries removal records: an agent's undo uses
  the records the backend keeps.
"""
from __future__ import annotations

import pytest

from services.canvas_pins import CanvasPins
from services.canvas_proposals import ProposalBook
from services.project_store import make_project
from tests.conftest import PERSON
from tests.test_canvas_proposals import CLAUDE, _propose, _upscale_body, api  # noqa: F401 - api is a fixture
from tests.test_undo_restores_deletes import TAB_A, _delete, _pin, _restore, _setup, _whole, canvas  # noqa: F401


@pytest.fixture
def bound(canvas, monkeypatch):
    """The canvas fixture with a fresh removal ledger (when this code has one)."""
    try:
        from services.node_removals import RemovalLedger
    except ImportError:  # the code before this round: the tests say what fails
        return canvas
    monkeypatch.setattr(canvas.main, "node_removals", RemovalLedger())
    return canvas


def _stored_pins(api) -> dict[str, dict]:
    """The pins as the catalog keeps them (with the fields no reader is shown)."""
    catalog = api.main.project_store.read()
    project = catalog["projects"][catalog["activeProjectId"]]
    return {pin["id"]: pin for pin in project.get("pins") or []}


def _restart(api, monkeypatch) -> None:
    """Pins persist with the project; proposals, the removal ledger and the undo book live in memory."""
    monkeypatch.setattr(api.main, "canvas_pins", CanvasPins(lambda: api.main.project_store))
    monkeypatch.setattr(api.main, "canvas_proposals", ProposalBook(api.clock))
    api.book = api.main.canvas_proposals
    try:
        from services.node_removals import RemovalLedger
    except ImportError:
        return
    monkeypatch.setattr(api.main, "node_removals", RemovalLedger())


def _import_one(api, value: str) -> str:
    """An import (nebula graph load) of one text node: ids start again at n1."""
    response = api.client.post("/api/graph/import", headers=PERSON, json={
        "nodes": [{"id": "u1", "definitionId": "text-input", "params": {"value": value},
                   "position": {"x": 400, "y": 400}}], "edges": []})
    assert response.status_code == 200, response.text
    return response.json()["idMap"]["u1"]


def _undo_add(api, node_id: str, headers=TAB_A) -> dict:
    """The person's Cmd+Z of a step that added ``node_id`` (an import, an add): the restore removes it."""
    response = api.client.post("/api/graph/restore", headers=headers, json={
        "action": "undo", "nodes": [], "remove": [node_id], "wire": [], "unwire": []})
    assert response.status_code == 200, response.text
    return response.json()


def _second_project(api) -> str:
    store = api.main.project_store
    with store.transaction() as catalog:
        other = make_project("Other")
        catalog["projects"][other["id"]] = other
        store.commit(catalog)
    return other["id"]


def _open(api, project_id: str) -> None:
    revision = api.main.project_store.read()["workspaceRevision"]
    opened = api.client.post(f"/api/projects/{project_id}/open", json={"workspaceRevision": revision},
                             headers=PERSON)
    assert opened.status_code == 200, opened.text


# -- 1. renewal swaps only the record the new delete supersedes ------------------------------

def test_a_delete_after_its_undo_names_the_removal_it_replaces(bound):
    n1, pin, _proposal = _setup(bound)
    item = _whole(bound, n1)
    first = _delete(bound, n1)["removal"]
    assert "replaces" not in first  # a node nothing brought back replaces nothing
    assert first["projectId"] == bound.project_id and first["definitionId"] == "text-input"
    assert _restore(bound, [item], [first]).json()["reattached"] == [pin["id"]]
    again = _delete(bound, n1)["removal"]
    assert again["replaces"] == first["id"]


def test_a_node_an_import_put_under_the_id_replaces_nothing(bound):
    x = bound.graph.add_node("text-input", {"value": "X"})
    item = _whole(bound, x)
    removal = _delete(bound, x)["removal"]
    assert _restore(bound, [item], [removal]).json()["status"] == "restored"
    assert _import_one(bound, "Y, a different node") == x
    # The person's Cmd+Z of the import removes Y: X's removal isn't Y's to replace.
    (y_removal,) = _undo_add(bound, x)["removals"]
    assert "replaces" not in y_removal


def test_an_import_reusing_the_id_doesnt_hand_ys_removal_to_xs_agent_edit(bound):
    """Review finding 1, backend side: CanvasUndoBook.renew_removals keyed on
    the node id, so a later delete of X rewrote the agent's kept edit (which
    deleted Y, an imported node under the same id) to X's removal."""
    x = bound.graph.add_node("text-input", {"value": "X"}, position={"x": 120, "y": 80})
    x_item = _whole(bound, x)
    x_removal = _delete(bound, x)["removal"]
    y = _import_one(bound, "Y, a different node")
    assert y == x == "n1"
    pin_y = _pin(bound, y, "about Y")
    y_item = _whole(bound, y)
    applied = bound.client.post("/api/graph/apply", headers=CLAUDE, json={"remove": [y]})
    assert applied.status_code == 200, applied.text
    token = applied.json()["undo"]["token"]
    (rm_b,) = applied.json()["removals"]
    # The person: Cmd+Z of the agent's delete (Y back), of the import (Y gone
    # again, so the agent's edit now names that delete), of X's delete (X back).
    assert _restore(bound, [y_item], [rm_b], headers=TAB_A).json()["reattached"] == [pin_y["id"]]
    (rm_c,) = _undo_add(bound, y)["removals"]
    assert rm_c["replaces"] == rm_b["id"]
    record = bound.main.canvas_undo_book.by_edit(next(r.edit_id for r in bound.main.canvas_undo_book._records.values()
                                                      if r.token == token))
    assert [item["id"] for item in record.removals] == [rm_c["id"]]
    _restore(bound, [x_item], [x_removal], headers=TAB_A)
    assert bound.graph.nodes[x]["params"]["value"] == "X"
    pin_x = _pin(bound, x, "the person's note on X")
    rm_d = _delete(bound, x)["removal"]
    assert rm_d["replaces"] == x_removal["id"]
    # X's delete supersedes nothing the agent's edit names: it still names Y's latest delete.
    assert [item["id"] for item in record.removals] == [rm_c["id"]]
    agent = bound.client.post("/api/graph/apply/undo", headers=CLAUDE, json={"token": token})
    assert agent.status_code == 200, agent.text
    body = agent.json()
    pins = _stored_pins(bound)
    assert bound.graph.nodes[y]["params"]["value"] == "Y, a different node"
    assert body["reattached"] == [pin_y["id"]]
    assert pins[pin_y["id"]]["anchor"] == {"nodeId": y} and pins[pin_x["id"]]["detached"] is True


def test_after_a_restart_a_pin_that_went_back_still_lets_the_next_delete_replace(bound, monkeypatch):
    n1, pin, _proposal = _setup(bound)
    item = _whole(bound, n1)
    first = _delete(bound, n1)["removal"]
    _restart(bound, monkeypatch)
    assert _restore(bound, [item], [first]).json()["reattached"] == [pin["id"]]
    assert _delete(bound, n1)["removal"]["replaces"] == first["id"]


# -- 2. a record belongs to the project it was made in ---------------------------------------

def test_a_project_switch_during_the_deletes_graphsync_leaves_the_other_projects_edit(bound, monkeypatch):
    main = bound.main
    store = main.project_store
    b = _second_project(bound)
    b_removal = {"id": "rm_00000000000000bb", "nodeId": "n1", "projectId": b, "pins": ["pin_b"], "proposals": []}
    main.canvas_undo_book.keep(edit_id="ed_00000000000000b1", actor={"kind": "agent", "id": "claude", "name": "Claude"},
                               agent_id="claude", project_id=b, project_name="Other",
                               inverse={"added": [], "removed": [], "changed": [], "renamed": [], "moved": [],
                                        "addedWires": [], "removedWires": []},
                               removals=[b_removal])
    record = main.canvas_undo_book.by_edit("ed_00000000000000b1")
    bound.graph.add_node("text-input", {"value": "A's node"})
    real = main.manager.broadcast_raw

    async def switching(data):
        await real(data)
        if data.get("type") == "graphSync" and data.get("edit"):
            with store.transaction() as catalog:
                catalog["activeProjectId"] = b
                store.commit(catalog)

    monkeypatch.setattr(main.manager, "broadcast_raw", switching)
    a_removal = _delete(bound, "n1")["removal"]
    assert a_removal["projectId"] == bound.project_id
    assert record.removals == [b_removal]


def test_a_record_from_another_project_puts_nothing_back(bound):
    n1, pin, proposal = _setup(bound)
    item = _whole(bound, n1)
    removal = _delete(bound, n1)["removal"]
    body = _restore(bound, [item], [{**removal, "projectId": "prj_elsewhere"}]).json()
    assert body["reattached"] == [] and body["reopened"] == []
    assert _stored_pins(bound)[pin["id"]]["detachedBy"] == removal["id"]
    assert bound.book.get(proposal).status == "invalidated"


# -- 3. proposals are tagged by their own project's deletes, until the canvas is replaced ----

@pytest.mark.parametrize("value", ["a cat", "something else"])
def test_after_a_clear_a_new_node_under_the_old_id_doesnt_revive_the_old_proposal(bound, value):
    n1, _pin_, proposal = _setup(bound)
    _delete(bound, n1)
    assert bound.client.delete("/api/graph?force=true", headers=PERSON).status_code == 200
    assert bound.book.get(proposal).closed_by == {}
    fresh = bound.graph.add_node("text-input", {"value": value}, position={"x": 120, "y": 80})
    assert fresh == n1
    item = _whole(bound, fresh)
    removal = _delete(bound, fresh)["removal"]
    assert proposal not in removal["proposals"]
    body = _restore(bound, [item], [removal]).json()
    assert body["reopened"] == [] and body["notReopened"] == []
    assert bound.book.get(proposal).status == "invalidated"


def test_another_projects_proposal_isnt_tagged_or_counted(bound):
    n1, _pin_, proposal = _setup(bound)
    _delete(bound, n1)
    _open(bound, _second_project(bound))
    b1 = bound.graph.add_node("text-input", {"value": "project B"})
    assert b1 == n1
    item = _whole(bound, b1)
    removal = _delete(bound, b1)["removal"]
    assert removal["id"] not in bound.book.get(proposal).closed_by
    body = _restore(bound, [item], [removal]).json()
    assert body["reopened"] == [] and body["notReopened"] == []


def test_undo_past_a_clear_counts_the_proposal_the_clear_spent(bound):
    """A clear drops the earlier deletes' tags (ids start again), so the undo
    of a delete from before it can't reopen the proposal; the notice says so."""
    n1, pin, proposal = _setup(bound)
    item = _whole(bound, n1)
    removal = _delete(bound, n1)["removal"]
    assert bound.client.delete("/api/graph?force=true", headers=PERSON).status_code == 200
    body = _restore(bound, [item], [removal]).json()
    assert body["reattached"] == [pin["id"]]
    assert body["reopened"] == [] and [row["id"] for row in body["notReopened"]] == [proposal]
    assert "cleared" in body["notReopened"][0]["reason"] or "replaced" in body["notReopened"][0]["reason"]


def test_a_cover_proposals_tag_goes_with_a_clear_too(bound, monkeypatch):
    from tests.test_undo_restores_deletes import _cover_setup

    book, c, cover = _cover_setup(bound, monkeypatch)
    item = _whole(bound, c)
    removal = _delete(bound, c)["removal"]
    assert book.get(cover).status == "invalidated" and book.get(cover).closed_by
    assert bound.client.delete("/api/graph?force=true", headers=PERSON).status_code == 200
    assert book.get(cover).closed_by == {}
    body = _restore(bound, [item], [removal]).json()
    assert body["reopened"] == [] and [row["id"] for row in body["notReopened"]] == [cover]
    assert book.get(cover).status == "invalidated"


# -- 4. a tag is a (removal, node) pair ------------------------------------------------------

def test_a_real_removal_id_under_the_wrong_node_changes_nothing(bound):
    n1, pin, proposal = _setup(bound)
    item = _whole(bound, n1)
    removal = _delete(bound, n1)["removal"]
    tags = dict(bound.book.get(proposal).closed_by)
    # A stale or forged list from a person's tab (an agent's restore names no records at all).
    forged = _restore(bound, [{"id": "n9", "definitionId": "text-input", "params": {"value": "x"},
                               "position": {"x": 0, "y": 0}, "outputs": {}}],
                      [{"id": removal["id"], "nodeId": "n9"}])
    assert forged.status_code == 200, forged.text
    assert forged.json()["reattached"] == [] and forged.json()["reopened"] == []
    assert forged.json()["notReopened"] == []
    assert bound.book.get(proposal).closed_by == tags
    real = _restore(bound, [item], [removal]).json()
    assert real["reattached"] == [pin["id"]] and real["reopened"] == [proposal]


def test_a_cover_proposal_needs_the_matching_pair_too(bound, monkeypatch):
    from tests.test_undo_restores_deletes import _cover_setup

    book, c, cover = _cover_setup(bound, monkeypatch)
    item = _whole(bound, c)
    removal = _delete(bound, c)["removal"]
    tags = dict(book.get(cover).closed_by)
    forged = _restore(bound, [{"id": "n9", "definitionId": "nano-banana", "params": {},
                               "position": {"x": 0, "y": 0}, "outputs": {}}],
                      [{"id": removal["id"], "nodeId": "n9"}]).json()
    assert forged["reopened"] == [] and forged["notReopened"] == [] and book.get(cover).closed_by == tags
    assert _restore(bound, [item], [removal]).json()["reopened"] == [cover]


# -- 5. a pin goes back only onto the model it came from ------------------------------------

def test_a_stale_record_cant_put_the_pin_on_another_model(bound):
    """A tab's list names the person's real record over another model under
    the same id. (Agents' restores name no records at all, see the gate below.)"""
    n1, pin, _proposal = _setup(bound)
    item = _whole(bound, n1)
    removal = _delete(bound, n1)["removal"]
    assert _stored_pins(bound)[pin["id"]]["detachedDefinition"] == "text-input"
    fake = _restore(bound, [{"id": n1, "definitionId": "nano-banana", "params": {},
                             "position": {"x": 900, "y": 900}, "outputs": {}}],
                    [{"id": removal["id"], "nodeId": n1}])
    assert fake.status_code == 200, fake.text
    assert fake.json()["reattached"] == []
    # The canvas counts it by ``code`` (GM: "1 pin couldn't be re-attached."); agents read ``reason``.
    assert fake.json()["pinsLeft"] == [{"id": pin["id"], "reason": "its node came back as another model",
                                        "code": "another-model"}]
    stored = _stored_pins(bound)[pin["id"]]
    assert stored["detached"] is True and stored["detachedBy"] == removal["id"]
    # An agent takes that node away again; the person's own undo still puts the pin back.
    assert bound.client.post("/api/graph/apply", headers=CLAUDE, json={"remove": [n1]}).status_code == 200
    real = _restore(bound, [item], [removal]).json()
    assert real["reattached"] == [pin["id"]]


def test_after_a_restart_the_model_check_still_holds(bound, monkeypatch):
    n1, pin, _proposal = _setup(bound)
    removal = _delete(bound, n1)["removal"]
    _restart(bound, monkeypatch)
    fake = _restore(bound, [{"id": n1, "definitionId": "nano-banana", "params": {},
                             "position": {"x": 900, "y": 900}, "outputs": {}}],
                    [{"id": removal["id"], "nodeId": n1}]).json()
    assert fake["reattached"] == [] and _stored_pins(bound)[pin["id"]]["detached"] is True


def test_agents_never_read_the_removal_ids_on_the_persons_pins(bound):
    n1, pin, _proposal = _setup(bound)
    _delete(bound, n1)
    hidden = ("detachedBy", "attachedPosition", "detachedDefinition")
    listed = {p["id"]: p for p in bound.client.get("/api/canvas/pins", headers=CLAUDE).json()["pins"]}
    assert listed[pin["id"]]["detached"] is True
    assert not any(key in listed[pin["id"]] for key in hidden)
    look = bound.client.get("/api/canvas/snapshot", headers=CLAUDE)
    assert look.status_code == 200, look.text
    assert not any(key in look.text for key in hidden)
    start = bound.client.get("/api/agent/start", headers=CLAUDE)
    assert start.status_code == 200, start.text
    assert not any(key in start.text for key in hidden)
    # Nor do the person's tabs: undo needs only the backend's own copy.
    assert not any(key in str(m) for m in bound.sent if m.get("type") == "canvasPins" for key in hidden)


@pytest.mark.parametrize("extra", [
    {"replaces": "nope"}, {"replaces": 7}, {"projectId": 3}, {"projectId": ""}, {"definitionId": ["text-input"]},
])
def test_a_records_binding_fields_are_checked_too(bound, extra):
    response = bound.client.post("/api/graph/restore", headers=PERSON, json={
        "action": "undo", "nodes": [], "remove": [], "wire": [], "unwire": [],
        "removals": [{"id": "rm_0000000000000000", "nodeId": "n1", **extra}]})
    assert response.status_code == 400, response.text


def test_the_restore_keeps_a_records_binding_fields(bound):
    """A record comes back from the restore body as the delete answered it,
    so an agent's kept edit and the canvas's next step can name it again."""
    n1, pin, _proposal = _setup(bound)
    item = _whole(bound, n1)
    removal = _delete(bound, n1)["removal"]
    parsed = bound.main._restore_removals([{**removal, "replaces": "rm_00000000000000aa"}])
    assert parsed == [{**removal, "replaces": "rm_00000000000000aa"}]
    assert _restore(bound, [item], [removal]).json()["reattached"] == [pin["id"]]


def test_another_node_under_the_id_doesnt_tag_a_closed_proposal(bound):
    """Live check, second review: a proposal closed by the person's delete of
    X picked up a tag from the delete of another node an agent put under X's
    id (the "needs this node too" rule matched the bare id), so the person's
    undo found it still waiting on that other node and left it closed."""
    n1, pin, proposal = _setup(bound)
    item = _whole(bound, n1)
    removal = _delete(bound, n1)["removal"]
    tags = dict(bound.book.get(proposal).closed_by)
    # An agent puts a node of another model under n1 (no record of its own), then takes it away.
    made = _restore(bound, [{"id": n1, "definitionId": "nano-banana", "params": {},
                             "position": {"x": 900, "y": 900}, "outputs": {}}], [], headers=CLAUDE)
    assert made.status_code == 200, made.text
    applied = bound.client.post("/api/graph/apply", headers=CLAUDE, json={"remove": [n1]})
    assert applied.status_code == 200, applied.text
    assert bound.book.get(proposal).closed_by == tags
    real = _restore(bound, [item], [removal]).json()
    assert real["reattached"] == [pin["id"]] and real["reopened"] == [proposal]


def test_the_same_node_brought_back_still_tags_a_shared_proposal(bound):
    """The rule it narrows still holds for the very node: undo of n2's delete
    and a redo of it re-tag the proposal that needs both."""
    n1 = bound.graph.add_node("text-input", {"value": "a cat"})
    n2 = bound.graph.add_node("text-input", {"value": "a dog"})
    body = {"note": "Two prompts", "nodes": [
        {"ref": "+a", "definitionId": "nano-banana", "params": {}},
        {"ref": "+b", "definitionId": "nano-banana", "params": {}}],
        "edges": [{"source": n1, "sourceHandle": "text", "target": "+a", "targetHandle": "prompt"},
                  {"source": n2, "sourceHandle": "text", "target": "+b", "targetHandle": "prompt"}]}
    proposal = _propose(bound, body).json()["proposal"]["id"]
    items = {n1: _whole(bound, n1), n2: _whole(bound, n2)}
    r1 = _delete(bound, n1)["removal"]
    r2 = _delete(bound, n2)["removal"]
    assert _restore(bound, [items[n2]], [r2]).json()["reopened"] == []
    r2b = _delete(bound, n2)["removal"]
    assert r2b["id"] in bound.book.get(proposal).closed_by
    assert _restore(bound, [items[n1]], [r1]).json()["reopened"] == []
    assert _restore(bound, [items[n2]], [r2b]).json()["reopened"] == [proposal]


# -- third review: ids start again before the replacement's sync awaits --------------------

def _during_the_replacements_sync(api, monkeypatch, step) -> dict:
    """Run ``step`` (a coroutine function) once, inside the first graphReplaced
    sync's await on broadcast_raw: another writer's request landing while an
    import or a project delete is still announcing itself."""
    main = api.main
    real = main.manager.broadcast_raw
    seen: dict = {}

    async def broadcasting(data):
        await real(data)
        if data.get("type") == "graphSync" and data.get("graphReplaced") and "ran" not in seen:
            seen["ran"] = True
            seen["result"] = await step()

    monkeypatch.setattr(main.manager, "broadcast_raw", broadcasting)
    return seen


def test_a_delete_during_an_imports_sync_replaces_nothing(bound, monkeypatch):
    """Third review: the import cleared the ledger only after its sync's
    awaits, so a delete of the imported n1 in that window was minted with the
    old node's consumed removal as ``replaces`` and its lineage."""
    x = bound.graph.add_node("text-input", {"value": "X"})
    item = _whole(bound, x)
    rm_a = _delete(bound, x)["removal"]
    assert _restore(bound, [item], [rm_a]).status_code == 200  # X back: the ledger holds (project, n1) -> rm_a
    x_lineage = bound.main.node_removals.lineage(bound.project_id, x)
    seen = _during_the_replacements_sync(bound, monkeypatch, lambda: bound.main.delete_graph_node(x))
    assert _import_one(bound, "Y, a different node") == x
    assert seen.get("ran"), "the hook never ran"
    y_removal = seen["result"]["removal"]
    assert "replaces" not in y_removal, "Y's delete claims to supersede X's removal"
    assert bound.main.node_removals._minted[y_removal["id"]]["lineage"] != x_lineage


def test_an_undo_during_an_imports_sync_is_still_remembered(bound, monkeypatch):
    """Clearing once, before the sync, not again after it: a delete and its
    undo that land during the sync leave the ledger knowing the node came back,
    so the next delete of it names that removal."""
    x = bound.graph.add_node("text-input", {"value": "X"})
    _delete(bound, x)
    main = bound.main

    async def delete_and_undo():
        y_item = _whole(bound, x)
        y_removal = (await main.delete_graph_node(x))["removal"]
        restored = await main.restore_graph_state({"action": "undo", "nodes": [y_item], "remove": [], "wire": [],
                                                   "unwire": [], "removals": [y_removal]})
        return y_removal, restored

    seen = _during_the_replacements_sync(bound, monkeypatch, delete_and_undo)
    assert _import_one(bound, "Y") == x
    y_removal, _restored = seen["result"]
    assert x in bound.graph.nodes
    again = _delete(bound, x)["removal"]
    assert again.get("replaces") == y_removal["id"]


def test_deleting_the_open_project_starts_the_unfiled_ids_again(bound):
    """Deleting the open project leaves an empty canvas with no project, whose
    ids start again at n1: a node a restore brought back there before is gone."""
    catalog = bound.main.project_store.read()
    first = catalog["activeProjectId"]
    revision = catalog["workspaceRevision"]
    deleted = bound.client.request("DELETE", f"/api/projects/{first}", headers=PERSON,
                                   json={"workspaceRevision": revision})
    assert deleted.status_code == 200, deleted.text
    assert bound.main.project_store.read()["activeProjectId"] is None
    x = bound.graph.add_node("text-input", {"value": "X"})
    item = _whole(bound, x)
    rm_a = _delete(bound, x)["removal"]
    assert rm_a["projectId"] is None
    assert _restore(bound, [item], [rm_a]).status_code == 200
    # Into a project and back out: deleting it empties the unfiled canvas again.
    made = bound.client.post("/api/projects", headers=PERSON, json={"name": "Second"})
    assert made.status_code in (200, 201), made.text
    catalog = bound.main.project_store.read()
    second, revision = catalog["activeProjectId"], catalog["workspaceRevision"]
    deleted = bound.client.request("DELETE", f"/api/projects/{second}", headers=PERSON,
                                   json={"workspaceRevision": revision})
    assert deleted.status_code == 200, deleted.text
    y = bound.graph.add_node("text-input", {"value": "Y"})
    assert y == x
    assert "replaces" not in _delete(bound, y)["removal"], "Y's delete claims to supersede X's removal"


# -- only the person's restore carries removal records ----------------------------------------

def test_an_agents_restore_cant_use_the_persons_removal_record(bound):
    """graphSync's ``edit.removals`` reaches every socket, agents' too, so an
    agent could name the person's real record with the same model under the
    same id and re-attach the person's pin (pins are person-only) or reopen
    the proposal. Only the person's restore carries removal records; an agent
    undoes its own edits through POST /api/graph/apply/undo, whose records
    the backend keeps."""
    n1, pin, proposal = _setup(bound)
    item = _whole(bound, n1)
    removal = _delete(bound, n1)["removal"]
    tags = dict(bound.book.get(proposal).closed_by)
    agent = _restore(bound, [item], [removal], headers=CLAUDE)
    assert agent.status_code == 200, agent.text
    body = agent.json()
    assert (body["reattached"], body["pinsLeft"], body["reopened"], body["notReopened"]) == ([], [], [], [])
    stored = _stored_pins(bound)[pin["id"]]
    assert stored["detached"] is True and stored["detachedBy"] == removal["id"]
    assert bound.book.get(proposal).status == "invalidated" and bound.book.get(proposal).closed_by == tags
    # The node itself is back (anyone may restore); the agent takes it away again, and the
    # person's own undo still puts back the pin and the proposal.
    assert bound.client.post("/api/graph/apply", headers=CLAUDE, json={"remove": [n1]}).status_code == 200
    real = _restore(bound, [item], [removal]).json()
    assert real["reattached"] == [pin["id"]] and real["reopened"] == [proposal]


def test_an_agents_own_undo_still_puts_back_what_its_delete_removed(bound):
    """The gate leaves the agent's undo alone: its records come from the backend."""
    n1, pin, proposal = _setup(bound)
    applied = bound.client.post("/api/graph/apply", headers=CLAUDE, json={"remove": [n1]})
    assert applied.status_code == 200, applied.text
    undone = bound.client.post("/api/graph/apply/undo", headers=CLAUDE,
                               json={"token": applied.json()["undo"]["token"]})
    assert undone.status_code == 200, undone.text
    assert undone.json()["reattached"] == [pin["id"]] and undone.json()["reopened"] == [proposal]


def test_a_stale_record_for_a_pin_a_later_delete_detached_says_changed(bound):
    """Every pin left carries a ``code`` the canvas counts by (GM, 2026-10-23:
    "1 pin couldn't be re-attached." only for another model; a pin the
    person deleted or changed since stays silent), never the English ``reason``."""
    n1, pin, _proposal = _setup(bound)
    item = _whole(bound, n1)
    first = _delete(bound, n1)["removal"]
    assert _restore(bound, [item], [first]).json()["reattached"] == [pin["id"]]
    again = _delete(bound, n1)["removal"]
    # A stale step still names the first removal: the pin is the later delete's now.
    stale = _restore(bound, [item], [first]).json()
    assert stale["reattached"] == []
    assert stale["pinsLeft"] == [{"id": pin["id"], "reason": "changed since", "code": "changed"}]
    assert bound.client.post("/api/graph/apply", headers=CLAUDE, json={"remove": [n1]}).status_code == 200
    assert _restore(bound, [item], [again]).json()["reattached"] == [pin["id"]]


def test_a_pin_in_another_project_is_left_with_its_code(bound):
    from services import canvas_pins

    n1, pin, _proposal = _setup(bound)
    removal = _delete(bound, n1)["removal"]
    left = bound.main.canvas_pins.reattach([removal], {n1: "text-input"}, "prj_elsewhere")
    assert left == {"reattached": [], "left": [{"id": pin["id"], "reason": canvas_pins.ANOTHER_PROJECT,
                                                 "code": "another-project"}]}
