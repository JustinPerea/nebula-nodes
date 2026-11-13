"""PR #199 fix round 20 (GM r29), the backend's part.

- GM r29 2: copy names. Nebula never reads a number in someone else's
  name: "Recovered <name>" when it is free, else " copy", " copy 2"; the
  only number Nebula raises is its own "copy N". Names in Recently deleted
  and names promised to copies not filed yet are taken, so two recoveries
  at once get two names.
- GM r29 2: the recover answer names the copy's true source
  (``sourceName``, from the copy's ``recoveredFrom``), never one read from
  the copy's name.
- GM r29 3: open proposals survive a reopen of the project already open
  (the person's, an agent's, the boot's), with the same ids; opening
  another project still closes them.
"""
from __future__ import annotations

import asyncio
import json
import sys
from pathlib import Path

import pytest

sys.path.insert(0, str(Path(__file__).resolve().parent.parent))

import main as main_module  # noqa: E402
from services import project_store as store_module  # noqa: E402
from services.canvas_proposals import ProposalBook  # noqa: E402
from tests.conftest import PERSON  # noqa: E402
from tests.test_canvas_proposal_updates import canvas  # noqa: E402,F401 - a fixture
from tests.test_canvas_proposals import CLAUDE, CODEX, KEY, _key, _propose, api  # noqa: E402,F401
from tests.test_project_catalog_restore_fix2 import _add_text, _create, app  # noqa: E402,F401
from tests.test_project_catalog_restore_fix17 import _on_disk, _rev  # noqa: E402
from tests.test_project_catalog_restore_fix18 import (  # noqa: E402,F401
    TAB, _boot, _legacy_state, _no_boot_renumbering)

ROOT = Path(__file__).resolve().parent.parent.parent
CASES = json.loads((Path(__file__).resolve().parent / "data" / "copy_name_cases.json").read_text(encoding="utf-8"))


# -- GM r29 2: copy names ---------------------------------------------------------------------

def _listed(names, trash=()) -> dict:
    return {"projects": {f"{index:032x}": {"name": name} for index, name in enumerate(names)},
            "trash": {f"{index + 500:032x}": {"name": name} for index, name in enumerate(trash)}}


def _made(case: dict, catalog: dict, taken=()) -> str:
    if case["family"] == "copy":
        return store_module.duplicate_name(case["source"], catalog, taken)
    if case["family"] == "recovered":
        return store_module.recovered_name(case["source"], catalog, taken)
    return store_module.recovered_canvas_name(catalog, taken)


def _source(case: dict) -> list[str]:
    return [case["source"]] if case["source"] else []


_IDS = [f"{case['family']}:{case['source']}:{'+'.join(case['taken'])}" for case in CASES]


@pytest.mark.parametrize("case", CASES, ids=_IDS)
def test_gm_r29_2_the_shared_cases(case):
    got = _made(case, _listed([*_source(case), *case["taken"]]))
    assert got == case["expect"]
    assert not got.startswith("Recovered Recovered ") and "copy copy" not in got


@pytest.mark.parametrize("case", CASES, ids=_IDS)
def test_gm_r29_2_names_in_recently_deleted_are_taken(case):
    """The same cases with every other name in Recently deleted, and again
    as names promised to copies not filed yet (``taken``)."""
    assert _made(case, _listed(_source(case), trash=case["taken"])) == case["expect"]
    assert _made(case, _listed(_source(case)), taken=case["taken"]) == case["expect"]


def test_gm_r29_2_the_cases_cover_gms_list():
    """GM r29's cases, each in the shared file with its answer."""
    def answer(family: str, source: str, *taken: str) -> str:
        (case,) = [case for case in CASES if (case["family"], case["source"], tuple(case["taken"])) ==
                   (family, source, taken)]
        return case["expect"]

    assert answer("recovered", "Shot", "Recovered Shot 7") == "Recovered Shot"
    assert answer("recovered", "Shot 7", "Recovered Shot 7") == "Recovered Shot 7 copy"
    assert answer("recovered", "Shot 7 copy") == "Recovered Shot 7 copy"
    assert answer("recovered", "Shot 7 copy", "Recovered Shot 7 copy") == "Recovered Shot 7 copy 2"
    assert answer("recovered", "Delta 1") == "Recovered Delta 1"
    assert answer("recovered", "Delta 1", "Recovered Delta 1") == "Recovered Delta 1 copy"
    assert answer("recovered", "Alpha", "Recovered Alpha", "Recovered Alpha copy",
                  "Recovered Alpha copy 2") == "Recovered Alpha copy 3"
    assert answer("recovered", "Recovered Alpha") == "Recovered Alpha copy"
    assert answer("recovered", "Recovered Alpha copy 2") == "Recovered Alpha copy 3"
    assert answer("recovered", "Recovered X 2") == "Recovered X 2 copy"
    assert answer("recovered", "X (recovered)") == "Recovered X"
    assert answer("recovered", "X (recovered 2)") == "Recovered X"
    assert answer("copy", "X") == "X copy"
    assert answer("copy", "X copy 2") == "X copy 3"
    assert answer("canvas", "", "Recovered canvas") == "Recovered canvas 2"
    # Two at once: the second sees the first's name taken.
    assert answer("recovered", "Shot", "Recovered Shot") == "Recovered Shot copy"


@pytest.mark.parametrize("number", [1, 2, 7, 8, 10, 99])
def test_gm_r29_2_no_number_in_a_name_is_read(number):
    """Whatever number a name carries, the recovered copy only adds Nebula's
    words: never a raised or a dropped number."""
    names = _listed([f"Shot {number}", f"Recovered Shot {number + 1}", f"Recovered Shot {number - 1}"])
    assert store_module.recovered_name(f"Shot {number}", names) == f"Recovered Shot {number}"
    names = _listed([f"Shot {number}", f"Recovered Shot {number}"])
    assert store_module.recovered_name(f"Shot {number}", names) == f"Recovered Shot {number} copy"
    assert store_module.recovered_name(f"Recovered Shot {number}", names) == f"Recovered Shot {number} copy"
    assert store_module.lost_row_name(f"Recovered Shot {number}", names) == f"Recovered Shot {number} copy"


def test_gm_r29_2_every_backend_copy_names_by_the_rule(app):
    assert main_module._recovered_copy_name("Shot 7", _listed(["Shot 7"])) == "Recovered Shot 7"
    catalog = _listed(["Shot 7", "Recovered Shot 7"], trash=["Recovered Shot 7 copy"])
    assert main_module._recovered_copy_name("Shot 7", catalog) == "Recovered Shot 7 copy 2"
    assert main_module._canvas_copy_name("Shot 7", catalog) == "Shot 7 copy"
    assert store_module.lost_row_name("Shot", _listed(["Shot", "Recovered Shot 7"])) == "Recovered Shot"
    owner = "b" * 32
    gone = {"projects": {"a" * 32: {"name": "Recovered Delta 1"}}, "trash": {owner: {"name": "Delta 1"}}}
    assert main_module._filed_canvas_name(gone, owner) == "Recovered Delta 1 copy"
    gone = {"projects": {"a" * 32: {"name": "Recovered Delta"}}, "trash": {owner: {"name": "Delta"}}}
    assert main_module._filed_canvas_name(gone, owner) == "Recovered Delta copy"
    assert main_module._filed_canvas_name({"projects": {"a" * 32: {"name": "Recovered canvas"}}, "trash": {}},
                                          None) == "Recovered canvas 2"


def _recover(client, source_id: str, snapshot: dict, recovery: str, **more):
    reply = client.post("/api/projects/recover", headers=PERSON, json={
        "sourceProjectId": source_id, "snapshot": snapshot, "recoveryId": recovery,
        "paramsVersion": main_module.PARAMS_VERSION, **more})
    assert reply.status_code == 200, reply.text
    return reply.json()


def test_gm_r29_2_two_recoveries_back_to_back_get_two_names(app):
    """Two kept tabs saving at once: each recover commits its copy in its own
    transaction, so the second finds the first's name taken. "Recovered
    Shot 7" is a different name, so the first is just "Recovered Shot"."""
    client, store, *_ = app
    _create(client, "Recovered Shot 7")
    shot = _create(client, "Shot")
    _add_text(client, "shot-1")
    snapshot = client.get(f"/api/projects/{shot}", headers=PERSON).json()["snapshot"]
    first = _recover(client, shot, snapshot, "1" * 32, sourceName="Shot")
    second = _recover(client, shot, snapshot, "2" * 32, sourceName="Shot")
    assert [first["project"]["name"], second["project"]["name"]] == ["Recovered Shot", "Recovered Shot copy"]
    # A retry of the first answers its own name, never a third.
    assert _recover(client, shot, snapshot, "1" * 32, sourceName="Shot")["project"]["name"] == "Recovered Shot"
    names = sorted(project["name"] for project in store.read()["projects"].values())
    assert names == ["Recovered Shot", "Recovered Shot 7", "Recovered Shot copy", "Shot"]


def test_gm_r29_2_a_name_in_recently_deleted_is_taken_by_the_route(app):
    client, store, *_ = app
    gone = _create(client, "Recovered Delta")
    delta = _create(client, "Delta")
    deleted = client.request("DELETE", f"/api/projects/{gone}", headers=PERSON,
                             json={"workspaceRevision": _rev(client)})
    assert deleted.status_code == 200, deleted.text
    snapshot = client.get(f"/api/projects/{delta}", headers=PERSON).json()["snapshot"]
    assert _recover(client, delta, snapshot, "3" * 32)["project"]["name"] == "Recovered Delta copy"


# -- GM r29 2: the recover answer names its true source ----------------------------------------

def test_gm_r29_2_each_answer_names_its_own_source(app):
    """Two copies named "Recovered Shot 7 copy": one made from "Shot 7 copy",
    one from "Shot 7" while "Recovered Shot 7" was taken. Each answer, its
    retry and the copy's record name the project it was made from."""
    client, store, *_ = app
    shot_copy = _create(client, "Shot 7 copy")
    snapshot = client.get(f"/api/projects/{shot_copy}", headers=PERSON).json()["snapshot"]
    made = _recover(client, shot_copy, snapshot, "4" * 32, sourceName="Shot 7 copy")
    assert (made["project"]["name"], made["sourceName"]) == ("Recovered Shot 7 copy", "Shot 7 copy")
    # Rename that copy away, so the same name is free for the second one.
    renamed = client.put(f"/api/projects/{'4' * 32}", headers=PERSON, json={"name": "Kept aside"})
    assert renamed.status_code == 200, renamed.text
    _create(client, "Recovered Shot 7")
    shot = _create(client, "Shot 7")
    snapshot = client.get(f"/api/projects/{shot}", headers=PERSON).json()["snapshot"]
    other = _recover(client, shot, snapshot, "5" * 32, sourceName="Shot 7")
    assert (other["project"]["name"], other["sourceName"]) == ("Recovered Shot 7 copy", "Shot 7")
    again = _recover(client, shot, snapshot, "5" * 32, sourceName="Shot 7")
    assert again["sourceName"] == "Shot 7"
    assert _recover(client, shot_copy, client.get(f"/api/projects/{shot_copy}", headers=PERSON).json()["snapshot"],
                    "4" * 32, sourceName="Shot 7 copy")["sourceName"] == "Shot 7 copy"
    records = store.read()["projects"]
    assert records["4" * 32]["recoveredFrom"] == {"id": shot_copy, "name": "Shot 7 copy"}
    assert records["5" * 32]["recoveredFrom"] == {"id": shot, "name": "Shot 7"}


def test_gm_r29_2_the_source_name_is_nebulas_then_the_tabs_then_none(app):
    """The name Nebula held for the source wins over the tab's; a source
    row that is gone takes the name the tab showed; with neither, none."""
    client, store, *_ = app
    alpha = _create(client, "Alpha")
    snapshot = client.get(f"/api/projects/{alpha}", headers=PERSON).json()["snapshot"]
    held = _recover(client, alpha, snapshot, "6" * 32, sourceName="What the tab showed")
    assert held["sourceName"] == "Alpha"
    gone = "f" * 32
    shown = _recover(client, gone, snapshot, "7" * 32, sourceName="  Delta  ")
    assert (shown["project"]["name"], shown["sourceName"]) == ("Recovered Delta", "Delta")
    nameless = _recover(client, gone, snapshot, "8" * 32)
    assert nameless["sourceName"] is None and nameless["project"]["name"] == "Recovered Deleted project"
    assert store.read()["projects"]["8" * 32]["recoveredFrom"] == {"id": gone, "name": None}
    # A copy from before the field: no source is said.
    assert main_module._recovered_source_name({"name": "Recovered Shot 7 copy"}) is None


def test_gm_r29_2_a_source_in_recently_deleted_is_named(app):
    client, store, *_ = app
    beta = _create(client, "Beta")
    _create(client, "Other")
    snapshot = client.get(f"/api/projects/{beta}", headers=PERSON).json()["snapshot"]
    deleted = client.request("DELETE", f"/api/projects/{beta}", headers=PERSON,
                             json={"workspaceRevision": _rev(client)})
    assert deleted.status_code == 200, deleted.text
    made = _recover(client, beta, snapshot, "9" * 32, sourceName="Beta")
    assert (made["project"]["name"], made["sourceName"]) == ("Recovered Beta", "Beta")


# -- GM r29 3: open proposals survive a reopen of the same project -----------------------------

def _retitle(api, node_id: str, value: str = "agent's", headers=CLAUDE) -> str:
    made = _propose(api, {"note": "Retitle", "params": [{"nodeId": node_id, "params": {"value": value}}]},
                    headers=headers)
    assert made.status_code == 201, made.text
    return made.json()["proposal"]["id"]


def _workspace(api) -> str:
    return api.main.project_store.read()["workspaceRevision"]


def _reopen(api, project_id: str | None = None, headers=PERSON):
    project_id = project_id or api.project_id
    opened = api.client.post(f"/api/projects/{project_id}/open", headers=headers,
                             json={"workspaceRevision": _workspace(api)})
    assert opened.status_code == 200, opened.text
    return opened.json()


def _replaced_syncs(api) -> list[dict]:
    return [m for m in api.sent if m.get("type") == "graphSync" and m.get("graphReplaced")]


def _replaced_events(api) -> list[dict]:
    return [e for e in api.journal.read(after=0, limit=200)["events"] if e["kind"] == "canvas.replaced"]


def _other_project(api, name: str = "Other") -> str:
    store = api.main.project_store
    with store.transaction() as catalog:
        other = store_module.make_project(name)
        catalog["projects"][other["id"]] = other
        store.commit(catalog)
    return other["id"]


def _accept(api, proposal_id: str):
    return api.client.post(f"/api/canvas/proposals/{proposal_id}/accept",
                           headers={**PERSON, KEY: _key(api, proposal_id)}, json={})


def _agents_see(api, proposal_id: str) -> None:
    """What MCP and the CLI read: the list, the proposal by id, start_here's snapshot."""
    listed = api.client.get("/api/canvas/proposals", headers=CODEX).json()["proposals"]
    assert [p["id"] for p in listed if p["status"] == "open"] == [proposal_id]
    assert api.client.get(f"/api/canvas/proposals/{proposal_id}", headers=CODEX).json()["proposal"]["status"] == "open"
    snapshot = api.client.get("/api/canvas/snapshot", headers=CODEX).json()
    assert [p["id"] for p in snapshot["proposals"]] == [proposal_id]


@pytest.mark.parametrize("headers", [PERSON, CODEX], ids=["persons-open", "agents-open"])
def test_gm_r29_3_a_reopen_in_place_keeps_open_proposals(canvas, headers):
    n1 = canvas.graph.add_node("text-input", {"value": "old"})
    proposal_id = _retitle(canvas, n1)
    canvas.sent.clear()
    _reopen(canvas, headers=headers)
    proposal = canvas.book.get(proposal_id)
    assert proposal.status == "open" and canvas.book.open_list() == [proposal]
    _agents_see(canvas, proposal_id)
    (sync,) = _replaced_syncs(canvas)
    assert sync["proposalsKept"] is True
    assert not [m for m in canvas.sent if m.get("type") == "proposalClosed"]
    event = _replaced_events(canvas)[-1]
    assert event["data"]["proposalsKept"] is True and "1 open proposal stayed open" in event["summary"]
    # Its Update is still waiting for the person.
    (note,) = [n for n in canvas.main.project_store.read()["projects"][canvas.project_id]["agentNotes"]
               if n.get("about") == "proposal"]
    assert not note.get("resolvedAt")
    # And it is still the person's to accept, against the reopened canvas.
    accepted = _accept(canvas, proposal_id)
    assert accepted.status_code == 200, accepted.text
    assert canvas.graph.nodes[n1]["params"]["value"] == "agent's"


def test_gm_r29_3_the_boots_reopen_keeps_them(app, monkeypatch):
    """The boot's quiet reopen of the open project (round 18's system reopen)
    closes no proposal, and each socket's first sync says so."""
    client, store, _graph, state = app
    book = ProposalBook()
    monkeypatch.setattr(main_module, "canvas_proposals", book)
    _legacy_state(client, store, state, live_value="a", project_value="b")
    made = client.post("/api/canvas/proposals", headers=CLAUDE,
                       json={"note": "Retitle", "params": [{"nodeId": "n1", "params": {"value": "agent's"}}]})
    assert made.status_code == 201, made.text
    proposal_id = made.json()["proposal"]["id"]
    _boot(state)
    assert main_module._boot_replacement, "the boot reopened the project"
    assert book.get(proposal_id).status == "open" and [p.id for p in book.open_list()] == [proposal_id]
    first = main_module._boot_first_sync()
    assert first["graphReplaced"] is True and first["proposalsKept"] is True


def test_gm_r29_3_without_a_boot_reopen_the_first_sync_says_nothing():
    main_module._boot_replacement.clear()
    main_module._boot_renumbered.clear()
    assert "proposalsKept" not in main_module._boot_first_sync()


def test_gm_r29_3_opening_another_project_still_closes_them(canvas):
    n1 = canvas.graph.add_node("text-input", {"value": "old"})
    proposal_id = _retitle(canvas, n1)
    other = _other_project(canvas)
    canvas.sent.clear()
    _reopen(canvas, other)
    proposal = canvas.book.get(proposal_id)
    assert proposal.status == "invalidated" and "replaced" in proposal.reason
    (sync,) = _replaced_syncs(canvas)
    assert "proposalsKept" not in sync
    assert "proposalsKept" not in _replaced_events(canvas)[-1]["data"]


def test_gm_r29_3_an_import_still_closes_them(canvas):
    n1 = canvas.graph.add_node("text-input", {"value": "old"})
    proposal_id = _retitle(canvas, n1)
    canvas.sent.clear()
    imported = canvas.client.post("/api/graph/import", headers=PERSON, json={"nodes": [], "edges": []})
    assert imported.status_code == 200, imported.text
    assert canvas.book.get(proposal_id).status == "invalidated"
    assert all("proposalsKept" not in sync for sync in _replaced_syncs(canvas))


def test_gm_r29_3_a_node_the_save_before_the_open_changed_keeps_the_rule_of_any_edit(canvas):
    """The person edited a value the proposal sets, the tab autosaved and
    reopened in place: the proposal stays open with the same id (an edit
    never closes it), and Accept applies the edit rule (#160): "changed
    after it was proposed", No longer fits. Another proposal stays acceptable."""
    n1 = canvas.graph.add_node("text-input", {"value": "old"})
    n2 = canvas.graph.add_node("text-input", {"value": "other"})
    touched = _retitle(canvas, n1)
    untouched = _retitle(canvas, n2, "agent's other")
    edited = canvas.client.put(f"/api/graph/node/{n1}", headers=PERSON, json={"params": {"value": "person's"}})
    assert edited.status_code == 200, edited.text
    snapshot = canvas.client.get(f"/api/projects/{canvas.project_id}", headers=PERSON).json()["snapshot"]
    saved = canvas.client.put(f"/api/projects/{canvas.project_id}", headers=PERSON,
                              json={"workspaceRevision": _workspace(canvas), "snapshot": snapshot})
    assert saved.status_code == 200, saved.text
    _reopen(canvas)
    assert {p.id for p in canvas.book.open_list()} == {touched, untouched}
    assert canvas.graph.nodes[n1]["params"]["value"] == "person's"
    refused = _accept(canvas, touched)
    assert refused.status_code == 409 and "changed after it was proposed" in refused.text
    assert canvas.book.get(touched).status == "invalidated"
    assert _accept(canvas, untouched).status_code == 200


def test_gm_r29_3_the_tabs_handoff_after_an_agents_reopen_keeps_the_rule_of_any_edit(canvas):
    """An agent reopened the open project; the person's tab hands off its
    unsent typing on a node the proposal sets: the live node changes, the
    proposal stays open with the same id, and Accept refuses it as for any edit."""
    n1 = canvas.graph.add_node("text-input", {"value": "old"})
    proposal_id = _retitle(canvas, n1)
    before = _workspace(canvas)
    snapshot = canvas.client.get(f"/api/projects/{canvas.project_id}", headers=PERSON).json()["snapshot"]
    _reopen(canvas, headers=CODEX)
    assert canvas.book.get(proposal_id).status == "open"
    for node in snapshot["nodes"]:
        if node["id"] == n1:
            node["data"]["params"]["value"] = "typed"
    handed = canvas.client.put(f"/api/projects/{canvas.project_id}", headers=TAB, json={
        "workspaceRevision": before, "snapshot": snapshot, "pendingParams": {n1: {"value": "typed"}}})
    assert handed.status_code == 200, handed.text
    assert canvas.graph.nodes[n1]["params"]["value"] == "typed"
    assert canvas.book.get(proposal_id).status == "open"
    refused = _accept(canvas, proposal_id)
    assert refused.status_code == 409 and "changed after it was proposed" in refused.text


def test_gm_r29_3_a_kept_proposal_whose_node_is_gone_closes_as_for_a_delete(canvas):
    """_proposals_after_reopen: a node a proposal reads that the reopened
    canvas doesn't hold closes it (no removal: nothing undoes an open), and
    one of another project closes as for a switch; the rest stay."""
    n1 = canvas.graph.add_node("text-input", {"value": "a"})
    n2 = canvas.graph.add_node("text-input", {"value": "b"})
    n3 = canvas.graph.add_node("text-input", {"value": "c"})
    gone = _retitle(canvas, n1)
    elsewhere = _retitle(canvas, n2)
    stays = _retitle(canvas, n3, headers=CODEX)
    del canvas.graph.nodes[n1]
    canvas.book.get(elsewhere).project_id = "e" * 32
    closed = canvas.main._proposals_after_reopen()
    assert {p.id for p in closed} == {gone, elsewhere}
    assert canvas.book.get(gone).status == "invalidated" and n1 in canvas.book.get(gone).reason
    assert not canvas.book.get(gone).closed_by
    assert "replaced" in canvas.book.get(elsewhere).reason
    assert [p.id for p in canvas.book.open_list()] == [stays]


def test_gm_r29_3_approved_runs_stay_across_a_reopen_in_place_only(canvas):
    """A run the person approved on Accept and hasn't started: its nodes keep
    their ids, so it stays (the run still has to match it value for value);
    another project's open ends it, as before."""
    n1 = canvas.graph.add_node("text-input", {"value": "a"})
    approval = canvas.approvals.grant(proposal_id="p_test", agent_name="Claude Code", run_node_ids=[n1],
                                      fingerprint={}, shape={})
    _reopen(canvas)
    assert [a.id for a in canvas.approvals.open_list()] == [approval.id]
    _reopen(canvas, headers=CODEX)
    assert [a.id for a in canvas.approvals.open_list()] == [approval.id]
    _reopen(canvas, _other_project(canvas))
    assert canvas.approvals.open_list() == []


def test_gm_r29_3_removal_tags_stay_across_a_reopen_in_place_only(canvas, monkeypatch):
    """A proposal a node delete closed keeps its tag (the delete's undo can
    still reopen it) and cover proposals keep theirs; another project's open
    drops both, as before."""
    dropped: list[str] = []
    monkeypatch.setattr(canvas.main.asset_proposals, "drop_removal_tags", lambda reason: dropped.append(reason))
    n1 = canvas.graph.add_node("text-input", {"value": "a"})
    proposal_id = _retitle(canvas, n1)
    deleted = canvas.client.delete(f"/api/graph/node/{n1}", headers=PERSON)
    assert deleted.status_code == 200, deleted.text
    tags = dict(canvas.book.get(proposal_id).closed_by)
    assert tags
    _reopen(canvas)
    assert canvas.book.get(proposal_id).closed_by == tags and dropped == []
    _reopen(canvas, _other_project(canvas))
    assert canvas.book.get(proposal_id).closed_by == {} and dropped == ["the canvas was replaced"]


def test_gm_r29_3_opening_the_project_the_live_canvas_is_but_the_list_didnt_have_open_closes_them(canvas):
    """The live canvas is another project than the list has open (after a
    restore, or a crash between the two files): opening it is no reopen in
    place, even though it ends up the open one."""
    n1 = canvas.graph.add_node("text-input", {"value": "a"})
    proposal_id = _retitle(canvas, n1)
    other = _other_project(canvas)
    canvas.graph.owner = other
    canvas.sent.clear()
    _reopen(canvas, other)
    assert canvas.book.get(proposal_id).status == "invalidated"
    assert all("proposalsKept" not in sync for sync in _replaced_syncs(canvas))


def test_gm_r29_3_a_canvas_that_isnt_the_open_projects_closes_them(canvas):
    """The open project's id, but the live canvas is another (an agent's
    copy, a canvas filed after a restore): not a reopen in place."""
    n1 = canvas.graph.add_node("text-input", {"value": "a"})
    proposal_id = _retitle(canvas, n1)
    canvas.graph.owner = "c" * 32  # a canvas no project in the list is
    canvas.sent.clear()
    opened = canvas.client.post(f"/api/projects/{canvas.project_id}/open", headers=PERSON,
                                json={"workspaceRevision": _workspace(canvas)})
    assert opened.status_code == 200, opened.text
    assert canvas.book.get(proposal_id).status == "invalidated"
    assert all("proposalsKept" not in sync for sync in _replaced_syncs(canvas))


def test_gm_r29_3_nebula_watch_says_the_reopen_kept_them(canvas):
    from cli.formatter import format_event

    n1 = canvas.graph.add_node("text-input", {"value": "a"})
    _retitle(canvas, n1)
    _reopen(canvas)
    line = format_event(_replaced_events(canvas)[-1])
    assert "node ids kept, open proposals still open" in line and "restarted" not in line
    _reopen(canvas, _other_project(canvas))
    assert "node ids restarted" in format_event(_replaced_events(canvas)[-1])


# -- Docs ---------------------------------------------------------------------------------------

def test_agent_docs_describe_round_20():
    import mcp_server

    def flat(text: str) -> str:
        return " ".join(text.split())

    setup = flat((ROOT / "docs/MCP-SETUP.md").read_text())
    skill = flat((ROOT / "skills/nebula/SKILL.md").read_text())
    tool = flat(mcp_server.open_project.__doc__ or "")
    for text in (setup, skill, tool):
        assert "Recovered <project left> copy" in text
        assert "Recovered <project left> 2" not in text and "Recovered <project> 2" not in text
        assert "stay open with the same ids" in text
    for text in (setup, skill):
        assert '"Recovered Shot" even' in text and '"Recovered Shot 7 copy"' in text
        assert "Recovered Delta 2" not in text and 'gives "Recovered X 3"' not in text
    assert "`sourceName`" in setup and "recoveredFrom" in setup and "`proposalsKept: true`" in setup
    assert "Recovered <project left> copy" in flat(mcp_server.new_project.__doc__ or "")
