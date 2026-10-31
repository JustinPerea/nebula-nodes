"""PR #199 fix round 19 (review 17; GM r27 and r28), the backend's part.

- MEDIUM-1 (two lenses): after a reopen or boot that renumbers a tab-local
  node, the tab's handoff counts as unsent only what differs from the node
  as the open (or boot) loaded it, so an agent's edit to the new id stands.
- reopen LOW-1: the tab's real handoff shape (remapped, no unsent lists).
- reopen LOW-2: a duplicate the person deleted before the handoff stays
  deleted; a node an agent added after the open survives.
- reopen NIT-1: the boot's replacement ends only at the person's read of
  its own project.
- drops-locks-ui MEDIUM-2: the person's own reopen in place renumbers.
- drops-locks-ui MEDIUM-1, agents-docs LOW-1, LOW-2, NIT-1: the tab-only
  count in every selection surface and in the selection event.
- agents-docs NIT-3: which errors mean the kept marker's folder can't be
  written.
- GM r27 2: copy names number only after "copy".
"""
from __future__ import annotations

import errno
import io
import json
import sys
from contextlib import redirect_stdout
from pathlib import Path

import pytest

sys.path.insert(0, str(Path(__file__).resolve().parent.parent))

import main as main_module  # noqa: E402
from cli.client import NebulaClient  # noqa: E402
from cli.commands import canvas as canvas_cmd  # noqa: E402
from cli.commands import context as context_cmd  # noqa: E402
from cli.commands import selection as selection_cmd  # noqa: E402
from cli.formatter import format_snapshot, format_start  # noqa: E402
from services import project_store as store_module  # noqa: E402
from services.selection_context import selection_prompt_context  # noqa: E402
from tests.conftest import PERSON  # noqa: E402
from tests.test_project_catalog_restore_fix2 import _add_text, _create, app  # noqa: E402,F401
from tests.test_project_catalog_restore_fix12 import CODEX  # noqa: E402
from tests.test_project_catalog_restore_fix16 import _node  # noqa: E402
from tests.test_project_catalog_restore_fix17 import (  # noqa: E402
    DUP, P1, _agent_read_and_listing, _autosave, _export_ids, _on_disk, _open, _rev, _stored, _value)
from tests.test_project_catalog_restore_fix18 import (  # noqa: E402,F401
    TAB, _boot, _delta_with_a_duplicate, _handoff, _held, _legacy_state, _live, _no_boot_renumbering, _vals)

ROOT = Path(__file__).resolve().parent.parent.parent
DUP2 = "2a62f9bb-0c3d-4e5f-8a9b-0c1d2e3f4a5c"
CASES = json.loads((Path(__file__).resolve().parent / "data" / "copy_name_cases.json").read_text(encoding="utf-8"))


def _agent(client) -> dict:
    return {**CODEX, "X-Nebula-Workspace-Revision": _rev(client)}


def _events(kind: str, since: int = 0) -> list[dict]:
    return [event for event in main_module.canvas_events.read(after=since, limit=100)["events"]
            if event["kind"] == kind]


def _move_n1(held: dict, by: float = 30) -> dict:
    next(node for node in held["nodes"] if node["id"] == "n1")["position"]["x"] += by
    return held


def _disk_rev(store) -> str:
    """The revision before a boot, read from disk: a listing then would lay a
    live graph that never held the uuid over the project (a test artefact)."""
    return store_module.ProjectStore(store.root).read()["workspaceRevision"]


def _disk_node(store, project_id: str, node_id: str) -> dict:
    return next(node for node in _on_disk(store, project_id)["snapshot"]["nodes"] if node["id"] == node_id)


# -- MEDIUM-1: the agent's edit to the renumbered node stands -----------------------------

def test_medium1_p1_an_agents_edit_by_the_id_it_was_told_survives_the_tabs_handoff(app):
    """Review 17 reopen-renumber's P1: the tab's only unsaved change is n1
    moved; the duplicate is as the open loaded it."""
    client, store, *_ = app
    delta, tab, old_rev = _delta_with_a_duplicate(client)
    new = _open(client, delta, headers=CODEX).json()["renumbered"][DUP]
    since = main_module.canvas_events.latest
    edit = client.put(f"/api/graph/node/{new}", headers=_agent(client), json={"params": {"value": "agent wrote this"}})
    assert edit.status_code == 200, edit.text
    answer = _handoff(client, delta, old_rev, _move_n1(_held(tab)))
    assert answer.status_code == 200 and answer.json()["handoff"] is True, answer.text
    assert _live(client)[new]["data"]["params"]["value"] == "agent wrote this"
    _agent_read_and_listing(client, delta)
    assert _value(_on_disk(store, delta)["snapshot"], new) == "agent wrote this"
    # Nothing journaled as the person's change to n2.
    assert not [event for event in _events("node.params", since)
                if event.get("nodeId") == new and event["actor"].get("kind") == "person"]


def test_medium1_a1_the_agents_value_name_and_place_all_stand(app):
    """Review 17 agents-docs' a1, with the place too."""
    client, store, *_ = app
    delta, tab, old_rev = _delta_with_a_duplicate(client)
    new = _open(client, delta, headers=CODEX).json()["renumbered"][DUP]
    assert client.put(f"/api/graph/node/{new}", headers=_agent(client),
                      json={"params": {"value": "agent wrote"}}).status_code == 200
    assert client.put(f"/api/graph/node/{new}/label", headers=_agent(client),
                      json={"label": "Agent name"}).status_code == 200
    moved = client.put("/api/graph/layout", headers=_agent(client), json={"positions": {new: {"x": 900, "y": 40}}})
    assert moved.status_code == 200, moved.text
    assert _handoff(client, delta, old_rev, _move_n1(_held(tab))).status_code == 200
    node = _live(client)[new]
    assert node["data"]["params"]["value"] == "agent wrote"
    assert node["data"].get("label") == "Agent name"
    assert node["position"] == {"x": 900, "y": 40}
    _agent_read_and_listing(client, delta)
    stored = _disk_node(store, delta, new)
    assert stored["data"]["params"]["value"] == "agent wrote" and stored["data"].get("label") == "Agent name"
    assert stored["position"] == {"x": 900, "y": 40}


def test_medium1_a1_control_an_agents_edit_to_n1_stands_as_before(app):
    client, store, *_ = app
    delta, tab, old_rev = _delta_with_a_duplicate(client)
    _open(client, delta, headers=CODEX)
    assert client.put("/api/graph/node/n1", headers=_agent(client),
                      json={"params": {"value": "agent wrote"}}).status_code == 200
    assert _handoff(client, delta, old_rev, _move_n1(_held(tab))).status_code == 200
    assert _live(client)["n1"]["data"]["params"]["value"] == "agent wrote"


def test_medium1_p6_after_a_boot_an_agents_edit_survives_the_old_tabs_handoff(app):
    """Review 17 reopen-renumber's P6: the tab from before the boot typed
    into n1 while offline; the duplicate is as the boot loaded it."""
    client, store, _graph, state = app
    delta = _legacy_state(client, store, state, live_value="dup-first", project_value="dup-first dup-second")
    before = _disk_rev(store)
    _boot(state)
    new = main_module._boot_renumbered[DUP]
    held = json.loads(json.dumps(_on_disk(store, delta)["snapshot"]))
    assert client.put(f"/api/graph/node/{new}", headers=_agent(client),
                      json={"params": {"value": "agent after boot"}}).status_code == 200
    main_module._apply_node_renumbering(held, {new: DUP})
    next(node for node in held["nodes"] if node["id"] == "n1")["data"]["params"]["value"] = "delta-1 offline"
    answer = _handoff(client, delta, before, held, pendingParams={"n1": {"value": "delta-1 offline"}})
    assert answer.status_code == 200, answer.text
    assert _live(client)[new]["data"]["params"]["value"] == "agent after boot"
    assert _live(client)["n1"]["data"]["params"]["value"] == "delta-1 offline"


def test_medium1_a3_boot_variant_with_the_persons_read_between(app):
    """Review 17 agents-docs' a3: the person's read (it overlays the live
    graph onto the stored copy) comes between the agent's edit and the
    handoff, so the stored copy can't be the baseline."""
    client, store, _graph, state = app
    delta = _legacy_state(client, store, state, live_value="dup-first", project_value="dup-saved")
    before = _disk_rev(store)
    _boot(state)
    new = main_module._boot_renumbered[DUP]
    assert client.put(f"/api/graph/node/{new}", headers=_agent(client),
                      json={"params": {"value": "agent after boot"}}).status_code == 200
    snap = _stored(client, delta)
    assert _value(snap, new) == "agent after boot"  # the read laid the live graph over it
    main_module._apply_node_renumbering(snap, {new: DUP})
    next(node for node in snap["nodes"] if node["id"] == DUP)["data"]["params"]["value"] = "dup-saved"
    assert _handoff(client, delta, before, _move_n1(snap)).status_code == 200
    assert _live(client)[new]["data"]["params"]["value"] == "agent after boot"


def _combine_delta(client) -> tuple[str, dict, str]:
    delta = _create(client, "Delta")
    _add_text(client, "delta-1")
    tab = _stored(client, delta)
    tab["nodes"].append(_node(DUP, "combine-text", {"separator": " ", "template": "t-old"}, 300))
    _autosave(client, delta, tab)
    return delta, tab, _rev(client)


def test_medium1_the_person_and_an_agent_change_different_keys_and_both_stand(app):
    client, store, *_ = app
    delta, tab, old_rev = _combine_delta(client)
    new = _open(client, delta, headers=CODEX).json()["renumbered"][DUP]
    since = main_module.canvas_events.latest
    assert client.put(f"/api/graph/node/{new}", headers=_agent(client),
                      json={"params": {"separator": " | "}}).status_code == 200
    held = _held(tab)
    next(node for node in held["nodes"] if node["id"] == DUP)["data"]["params"]["template"] = "t-late"
    main_module._apply_node_renumbering(held, {DUP: new})  # the tab remaps; no unsent lists
    assert _handoff(client, delta, old_rev, held).status_code == 200
    params = _live(client)[new]["data"]["params"]
    assert params["separator"] == " | " and params["template"] == "t-late"
    _agent_read_and_listing(client, delta)
    stored = _disk_node(store, delta, new)["data"]["params"]
    assert stored["separator"] == " | " and stored["template"] == "t-late"
    # Only the person's own change is journaled as theirs.
    persons = [event for event in _events("node.params", since)
               if event.get("nodeId") == new and event["actor"].get("kind") == "person"]
    assert [event["data"]["keys"] for event in persons] == [["template"]]


def test_medium1_the_same_key_the_persons_late_value_wins(app):
    client, store, *_ = app
    delta, tab, old_rev = _delta_with_a_duplicate(client)
    new = _open(client, delta, headers=CODEX).json()["renumbered"][DUP]
    assert client.put(f"/api/graph/node/{new}", headers=_agent(client),
                      json={"params": {"value": "agent wrote"}}).status_code == 200
    assert _handoff(client, delta, old_rev, _held(tab, **{DUP: "person typed late"})).status_code == 200
    assert _live(client)[new]["data"]["params"]["value"] == "person typed late"
    _agent_read_and_listing(client, delta)
    assert _value(_on_disk(store, delta)["snapshot"], new) == "person typed late"


def test_medium1_a_later_handoff_counts_only_what_changed_since_the_last(app):
    """An autosave in flight at the open lands first; an agent then edits the
    node; the tab's last save holds the same value the first one landed.
    The baseline moved on with the first, so the agent's edit stands."""
    client, store, *_ = app
    delta, tab, old_rev = _delta_with_a_duplicate(client)
    new = _open(client, delta, headers=CODEX).json()["renumbered"][DUP]
    assert _handoff(client, delta, old_rev, _held(tab, **{DUP: "dup a"})).status_code == 200
    assert _live(client)[new]["data"]["params"]["value"] == "dup a"
    assert client.put(f"/api/graph/node/{new}", headers=_agent(client),
                      json={"params": {"value": "agent wrote"}}).status_code == 200
    assert _handoff(client, delta, old_rev, _move_n1(_held(tab, **{DUP: "dup a"}))).status_code == 200
    assert _live(client)[new]["data"]["params"]["value"] == "agent wrote"


def test_medium1_the_late_name_and_place_still_land_against_the_baseline(app):
    """HIGH-1 still holds through the baseline: what the person changed
    since the autosave lands, value, name and place."""
    client, store, *_ = app
    delta, tab, old_rev = _delta_with_a_duplicate(client)
    held = _held(tab, **{DUP: "dup-new"})
    late = next(node for node in held["nodes"] if node["id"] == DUP)
    late["data"]["label"] = "Late name"
    late["position"] = {"x": 640, "y": 80}
    new = _open(client, delta, headers=CODEX).json()["renumbered"][DUP]
    assert _handoff(client, delta, old_rev, held).status_code == 200
    node = _live(client)[new]
    assert node["data"]["params"]["value"] == "dup-new" and node["data"].get("label") == "Late name"
    assert node["position"] == {"x": 640, "y": 80}


# -- reopen LOW-1: the tab's real handoff ------------------------------------------------------

def test_low1_p8_the_tabs_real_handoff_remapped_with_no_unsent_lists(app):
    """What the tab sends after a reopen (remapSnapshotIds; handoffPending
    lists only nN ids): the late value, name and place land on n2 (mutant
    B2: renamed only by the old id)."""
    client, store, *_ = app
    delta, tab, old_rev = _delta_with_a_duplicate(client)
    new = _open(client, delta, headers=CODEX).json()["renumbered"][DUP]
    held = _held(tab, **{DUP: "dup-new"})
    late = next(node for node in held["nodes"] if node["id"] == DUP)
    late["data"]["label"] = "Late name"
    late["position"] = {"x": 640, "y": 80}
    main_module._apply_node_renumbering(held, {DUP: new})
    answer = _handoff(client, delta, old_rev, held)
    assert answer.status_code == 200, answer.text
    node = _live(client)[new]
    assert node["data"]["params"]["value"] == "dup-new"
    assert node["data"].get("label") == "Late name" and node["position"] == {"x": 640, "y": 80}
    stored = _disk_node(store, delta, new)
    assert stored["data"]["params"]["value"] == "dup-new" and stored["position"] == {"x": 640, "y": 80}
    assert sorted(_export_ids(client)) == ["n1", new]


# -- reopen LOW-2: an unsaved delete stays a delete ---------------------------------------------

def test_low2_p4_a_duplicate_the_person_deleted_before_the_handoff_stays_deleted(app):
    """Round 20 (review 18 MEDIUM-1): the window that saved the duplicate
    says the delete (``deletedNodeIds``, by the id it had)."""
    client, store, *_ = app
    delta, tab, _old = _delta_with_a_duplicate(client)
    assert client.put(f"/api/projects/{delta}", headers=TAB,
                      json={"workspaceRevision": _rev(client), "snapshot": tab}).status_code == 200
    old_rev = _rev(client)
    new = _open(client, delta, headers=CODEX).json()["renumbered"][DUP]
    assert new in _export_ids(client)
    since = main_module.canvas_events.latest
    held = _held(tab)
    held["nodes"] = [node for node in held["nodes"] if node["id"] != DUP]
    answer = _handoff(client, delta, old_rev, held, deletedNodeIds=[DUP])
    assert answer.status_code == 200, answer.text
    assert _export_ids(client) == ["n1"]
    _agent_read_and_listing(client, delta)
    assert [node["id"] for node in _on_disk(store, delta)["snapshot"]["nodes"]] == ["n1"]
    assert [node["id"] for node in _stored(client, delta)["nodes"]] == ["n1"]
    removed = _events("node.removed", since)
    assert [(event["nodeId"], event["actor"]["kind"]) for event in removed] == [(new, "person")]


def test_low2_only_the_persons_tab_says_a_delete_by_leaving_it_out(app):
    """A save at the old revision from anyone else (the agent that switched)
    leaving the node out deletes nothing."""
    client, store, *_ = app
    delta, tab, old_rev = _delta_with_a_duplicate(client)
    new = _open(client, delta, headers=CODEX).json()["renumbered"][DUP]
    held = _held(tab)
    held["nodes"] = [node for node in held["nodes"] if node["id"] != DUP]
    assert _handoff(client, delta, old_rev, held, headers=CODEX).status_code == 200
    assert sorted(_export_ids(client)) == ["n1", new]
    assert sorted(node["id"] for node in _on_disk(store, delta)["snapshot"]["nodes"]) == ["n1", new]


@pytest.mark.parametrize("read_between", [False, True])
def test_low2_a_node_an_agent_added_after_the_open_survives_the_handoff(app, read_between):
    """The opposite: in no map, and not in the tab's snapshot, it stays,
    on disk (after a read laid it over the stored copy, or not) and live."""
    client, store, *_ = app
    delta, tab, old_rev = _delta_with_a_duplicate(client)
    new = _open(client, delta, headers=CODEX).json()["renumbered"][DUP]
    added = client.post("/api/graph/node", headers=_agent(client),
                        json={"definitionId": "text-input", "params": {"value": "agent's node"}})
    assert added.status_code == 200, added.text
    agents = added.json().get("id") or added.json().get("nodeId") or added.json()["node"]["id"]
    if read_between:
        _agent_read_and_listing(client, delta)
        assert agents in _on_disk(store, delta)["_backendNodeIds"]
    assert _handoff(client, delta, old_rev, _move_n1(_held(tab))).status_code == 200
    assert sorted(_export_ids(client)) == sorted(["n1", new, agents])
    _agent_read_and_listing(client, delta)
    assert sorted(node["id"] for node in _on_disk(store, delta)["snapshot"]["nodes"]) == sorted(["n1", new, agents])


# -- reopen NIT-1: the boot replacement's project scoping ---------------------------------------

def test_nit1_the_persons_read_of_another_project_doesnt_end_the_boot_replacement(app):
    """Mutant B19: any project's read ended it."""
    client, store, _graph, state = app
    alpha = _create(client, "Alpha")
    delta = _legacy_state(client, store, state, live_value="a", project_value="b")
    _boot(state)
    assert client.get(f"/api/projects/{alpha}", headers=PERSON).status_code == 200
    with client.websocket_connect("/ws", headers=PERSON) as socket:
        first = socket.receive_json()
    assert first["graphReplaced"] is True and first["renumbered"] == {DUP: main_module._boot_renumbered[DUP]}
    assert first["projectSwitch"]["projectId"] == delta
    # Its own project's read still ends it.
    _stored(client, delta)
    assert main_module._boot_first_sync() == {}


# -- drops-locks-ui MEDIUM-2: the person's own reopen in place ----------------------------------

def test_medium2_the_persons_reopen_in_place_renumbers_and_nothing_doubles(app):
    """The tab saves first (activate's flush: the late typing), then sends
    POST /api/projects/{id}/open for the project it shows. Round 20 (review
    18 LOW-1): a handoff is kept for this project, for the person's other
    windows, and the sync says the person reopened it in place."""
    client, store, *_ = app
    delta, tab, _old = _delta_with_a_duplicate(client)
    _autosave(client, delta, _held(tab, **{DUP: "dup typed late"}))  # the flush
    since = main_module.canvas_events.latest
    main_module.manager.broadcast_raw.reset_mock()
    opened = _open(client, delta)  # the person's tab
    assert opened.status_code == 200, opened.text
    answer = opened.json()
    new = answer["renumbered"][DUP]
    assert main_module._BACKEND_NODE_ID.fullmatch(new)
    assert sorted(node["id"] for node in answer["project"]["snapshot"]["nodes"]) == sorted(["n1", new])
    assert _value(answer["project"]["snapshot"], new) == "dup typed late"
    assert answer["workspaceRevision"] == _rev(client)
    assert _live(client)[new]["data"]["params"]["value"] == "dup typed late"
    assert sorted(_export_ids(client)) == ["n1", new]
    # The sync every tab gets: a replacement with the ids, and the person's
    # reopen in place (round 20; no X-Nebula-Tab here, so no tab).
    syncs = [call.args[0] for call in main_module.manager.broadcast_raw.call_args_list
             if call.args and call.args[0].get("type") == "graphSync"]
    assert syncs and syncs[0]["graphReplaced"] is True and syncs[0]["renumbered"] == {DUP: new}
    switch = syncs[0]["projectSwitch"]
    assert switch["actor"] == {"kind": "person"} and switch["projectId"] == switch["previousProjectId"] == delta
    # Agents see it: canvas.replaced in the person's name, with the ids.
    replaced = _events("canvas.replaced", since)
    assert replaced[-1]["actor"]["kind"] == "person" and replaced[-1]["data"]["renumbered"] == {DUP: new}
    assert _on_disk(store, delta)[main_module._HANDOFF_RENUMBERED]["map"] == {DUP: new}
    # The tab's next autosave is at the new revision, by the new id.
    loaded = answer["project"]["snapshot"]
    next(node for node in loaded["nodes"] if node["id"] == new)["data"]["params"]["value"] = "after"
    _autosave(client, delta, loaded)
    assert _vals(_on_disk(store, delta)["snapshot"]) == sorted([("n1", "delta-1"), (new, "after")])
    assert _open(client, delta).json()["renumbered"] == {}


def test_medium2_a_save_at_the_revision_before_the_persons_reopen_lands_as_a_handoff(app):
    """Round 20 (review 18 LOW-1): the person's reopen in place keeps a
    handoff as an agent's does, so a save at the old revision (another
    window's) lands in the project under the handoff's rules, once."""
    client, store, *_ = app
    delta, tab, old_rev = _delta_with_a_duplicate(client)
    new = _open(client, delta).json()["renumbered"][DUP]
    late = _handoff(client, delta, old_rev, _held(tab, **{DUP: "too late"}))
    assert late.status_code == 200 and late.json()["handoff"] is True, late.text
    assert sorted(_export_ids(client)) == ["n1", new]
    assert _live(client)[new]["data"]["params"]["value"] == "too late"


def test_medium2_a_reload_reads_the_project_and_renumbers_nothing(app):
    """What a page reload loads (GET /api/projects/{id}, the stored project
    with the live graph laid over it) keeps the tab-local id: a read never
    replaces the live graph."""
    client, store, *_ = app
    delta, _tab, revision = _delta_with_a_duplicate(client)
    loaded = _stored(client, delta)
    assert sorted(node["id"] for node in loaded["nodes"]) == sorted(["n1", DUP])
    assert _rev(client) == revision and _export_ids(client) == ["n1"]


# -- the tab-only count in every selection surface ----------------------------------------------

def _cli(client) -> NebulaClient:
    cli = NebulaClient("http://testserver")
    cli._client = client
    return cli


def _printed(run) -> str:
    out = io.StringIO()
    with redirect_stdout(out):
        run()
    return out.getvalue()


ONLY_DUP_NOTE = ("The person selected 1 node only their tab has (a duplicate or a paste): "
                 "it has no id agents can use until the project is opened again.")


def test_dlu_medium1_nebula_selection_with_only_the_duplicate_selected(app):
    client, *_ = app
    _create(client, "Delta")
    _add_text(client, "delta-1")
    assert client.post("/api/canvas/selection", headers=PERSON, json={"nodeIds": [DUP]}).status_code == 200
    read = client.get("/api/canvas/selection", headers=CODEX).json()
    assert read["tabOnlyNote"] == ONLY_DUP_NOTE
    printed = _printed(lambda: selection_cmd.run(_cli(client)))
    print(printed)
    assert printed == "No live canvas nodes selected.\n\n" + ONLY_DUP_NOTE + "\n"
    assert DUP not in printed
    assert ONLY_DUP_NOTE in selection_prompt_context(read)  # the chat and ACP prompt's context
    # With a node agents can see, "also" stays.
    client.post("/api/canvas/selection", headers=PERSON, json={"nodeIds": ["n1", DUP]})
    printed = _printed(lambda: selection_cmd.run(_cli(client)))
    assert "SELECTED NODES (1):" in printed and "The person also selected 1 node only their tab has" in printed
    assert "The person also selected" in selection_prompt_context(client.get("/api/canvas/selection").json())


def test_dlu_medium1_and_agents_docs_low2_look_shows_the_count(app):
    client, *_ = app
    _create(client, "Delta")
    _add_text(client, "delta-1")
    client.post("/api/canvas/selection", headers=PERSON, json={"nodeIds": [DUP, P1]})
    look = client.get("/api/canvas/snapshot", headers=CODEX).json()
    assert look["selection"] == [] and look["tabOnlyCount"] == 2
    assert look["tabOnlyNote"].startswith("The person selected 2 nodes only their tab has")
    assert DUP not in json.dumps(look) and P1 not in json.dumps(look)
    printed = _printed(lambda: canvas_cmd.run_look(_cli(client)))
    assert "SELECTED: nothing\n  The person selected 2 nodes only their tab has" in printed
    assert format_snapshot(look) in printed


def test_agents_docs_low2_start_here_and_nebula_context_show_the_count(app):
    client, *_ = app
    _create(client, "Delta")
    _add_text(client, "delta-1")
    client.post("/api/canvas/selection", headers=PERSON, json={"nodeIds": ["n1", DUP]})
    start = client.get("/api/agent/start", headers=CODEX).json()
    canvas = start["canvas"]
    assert canvas["selection"] == ["n1"] and canvas["tabOnlyCount"] == 1
    assert canvas["tabOnlyNote"].startswith("The person also selected 1 node only their tab has")
    assert DUP not in json.dumps(start)
    printed = _printed(lambda: context_cmd.run(_cli(client)))
    assert "  selected: n1\n  The person also selected 1 node only their tab has" in printed
    assert "The person also selected" in format_start(start)
    # Nothing tab-only: no field, no line.
    client.post("/api/canvas/selection", headers=PERSON, json={"nodeIds": ["n1"]})
    start = client.get("/api/agent/start", headers=CODEX).json()
    assert "tabOnlyCount" not in start["canvas"] and "only their tab has" not in format_start(start)
    look = client.get("/api/canvas/snapshot", headers=CODEX).json()
    assert "tabOnlyCount" not in look and "only their tab has" not in format_snapshot(look)


def _selection_events(since: int) -> list[tuple[str, dict]]:
    return [(event["summary"], event["data"]) for event in _events("selection.changed", since)]


def test_agents_docs_low1_selecting_only_a_duplicate_is_a_selection_not_a_clear(app):
    client, *_ = app
    _create(client, "Delta")
    _add_text(client, "delta-1")
    since = main_module.canvas_events.latest
    client.post("/api/canvas/selection", headers=PERSON, json={"nodeIds": ["n1"]})
    client.post("/api/canvas/selection", headers=PERSON, json={"nodeIds": [DUP]})  # [n1] -> [DUP]
    events = _selection_events(since)
    assert [summary for summary, _ in events] == ["selected n1", "selected 1 node only their tab has"]
    data = events[-1][1]
    assert data["nodeIds"] == [] and data["count"] == 0 and data["tabOnlyCount"] == 1
    assert data["tabOnlyNote"] == ONLY_DUP_NOTE
    assert DUP not in json.dumps(events)


def test_agents_docs_low1_from_nothing_to_a_duplicate_and_back(app):
    client, *_ = app
    _create(client, "Delta")
    _add_text(client, "delta-1")
    client.post("/api/canvas/selection", headers=PERSON, json={"nodeIds": []})
    since = main_module.canvas_events.latest
    client.post("/api/canvas/selection", headers=PERSON, json={"nodeIds": [DUP]})  # [] -> [DUP]
    client.post("/api/canvas/selection", headers=PERSON, json={"nodeIds": ["n1", DUP, P1]})
    client.post("/api/canvas/selection", headers=PERSON, json={"nodeIds": []})
    assert [summary for summary, _ in _selection_events(since)] == [
        "selected 1 node only their tab has", "selected n1 and 2 nodes only their tab has",
        "cleared the selection"]
    assert "tabOnlyCount" not in _selection_events(since)[-1][1]


def test_agents_docs_low1_one_duplicate_for_another_reads_the_same_so_no_event(app):
    """[DUP] -> [DUP2]: agents are given neither id, only the count, and it
    is 1 both times, so what they can see didn't change."""
    client, *_ = app
    _create(client, "Delta")
    _add_text(client, "delta-1")
    client.post("/api/canvas/selection", headers=PERSON, json={"nodeIds": [DUP]})
    since = main_module.canvas_events.latest
    client.post("/api/canvas/selection", headers=PERSON, json={"nodeIds": [DUP2]})
    assert _selection_events(since) == []
    client.post("/api/canvas/selection", headers=PERSON, json={"nodeIds": [DUP, DUP2]})
    assert [summary for summary, _ in _selection_events(since)] == ["selected 2 nodes only their tab has"]


def test_agents_docs_nit1_a_switch_forgets_the_tab_only_count(app):
    """Mutant M18: clear() keeping the count."""
    client, *_ = app
    _create(client, "Delta")
    _add_text(client, "delta-1")
    client.post("/api/canvas/selection", headers=PERSON, json={"nodeIds": [DUP]})
    assert client.get("/api/canvas/selection", headers=CODEX).json()["tabOnlyCount"] == 1
    _create(client, "Alpha")  # the person's switch clears the selection
    read = client.get("/api/canvas/selection", headers=CODEX).json()
    assert "tabOnlyCount" not in read and "tabOnlyNote" not in read
    assert main_module.selection_context.tab_only() == 0


# -- agents-docs NIT-3: which errors mean "can't write" -----------------------------------------

@pytest.mark.parametrize(("code", "holds"), [
    (errno.EACCES, False), (errno.EPERM, False), (errno.EROFS, False),
    (errno.ENOSPC, True), (errno.EDQUOT, True), (errno.EIO, True), (errno.EMFILE, True),
])
def test_nit3_only_a_folder_no_run_could_write_ignores_the_marker(tmp_path, monkeypatch, code, holds):
    marker = tmp_path / main_module.KEPT_MARKER_NAME
    marker.write_text(json.dumps({"keptTabs": 2, "at": 0}), encoding="utf-8")
    real = main_module.Path.open

    def refused(self, *args, **kwargs):
        if self.name.startswith(".kept-probe."):
            raise OSError(code, "refused")
        return real(self, *args, **kwargs)

    monkeypatch.setattr(main_module.Path, "open", refused)
    monkeypatch.setattr(main_module, "KEPT_GRACE_SECONDS", 0.0)
    monkeypatch.setattr(main_module, "KEPT_BOOT_SLACK_SECONDS", 0.0)
    manager = main_module.ConnectionManager(marker)
    assert manager.start_boot_grace() == (2 if holds else 0)


# -- GM r27 2: copy names number only after "copy" ----------------------------------------------

def _catalog(source: str, taken: list[str]) -> dict:
    names = [source, *taken] if source else list(taken)
    return {"projects": {f"{index:032x}": {"name": name} for index, name in enumerate(names)}, "trash": {}}


def _made(case: dict) -> str:
    catalog = _catalog(case["source"], case["taken"])
    if case["family"] == "copy":
        return store_module.duplicate_name(case["source"], catalog)
    if case["family"] == "recovered":
        return store_module.recovered_name(case["source"], catalog)
    assert case["family"] == "canvas"
    return store_module.recovered_canvas_name(catalog)


@pytest.mark.parametrize("case", CASES, ids=[f"{case['family']}:{case['source']}:{len(case['taken'])}" for case in CASES])
def test_gm_r27_2_copy_names(case):
    got = _made(case)
    assert got == case["expect"]
    assert not got.startswith("Recovered Recovered ") and "copy copy" not in got


def test_gm_r27_2_the_cases_cover_every_shape():
    shapes = {(case["family"], case["source"]) for case in CASES}
    for shape in [("copy", "X copy"), ("copy", "X copy 2"), ("recovered", "Recovered X"),
                  ("recovered", "Recovered X 2"), ("recovered", "Recovered Alpha copy 2"),
                  ("copy", "Recovered Alpha copy 2"), ("recovered", "Shot 7"), ("copy", "Shot 7"),
                  ("recovered", "Recovered canvas"), ("recovered", "Recovered canvas 2"),
                  ("recovered", "X (recovered)"), ("recovered", "Delta")]:
        assert shape in shapes, shape
    shot = [case["expect"] for case in CASES if case["family"] == "recovered" and case["source"] == "Shot 7"]
    # GM r29, 2: the name's own 7 is never read.
    assert shot[:4] == ["Recovered Shot 7", "Recovered Shot 7 copy", "Recovered Shot 7 copy 2",
                        "Recovered Shot 7 copy 3"]


def test_gm_r27_2_every_backend_copy_follows_the_rule(app):
    assert main_module._recovered_copy_name("Shot 7", _catalog("Shot 7", [])) == "Recovered Shot 7"
    assert main_module._recovered_copy_name("Shot 7", _catalog("Shot 7", ["Recovered Shot 7"])) == \
        "Recovered Shot 7 copy"
    assert store_module.lost_row_name("Shot 7", _catalog("Shot 7", [])) == "Recovered Shot 7"
    assert main_module._canvas_copy_name("Shot 7", _catalog("Shot 7", ["Shot 7 copy"])) == "Shot 7 copy 2"


# -- Docs ---------------------------------------------------------------------------------------

def test_agent_docs_describe_round_19():
    setup = (ROOT / "docs/MCP-SETUP.md").read_text()
    skill = (ROOT / "skills/nebula/SKILL.md").read_text()
    mcp = (ROOT / "backend/mcp_server.py").read_text()
    for text in (setup, skill):
        assert "tabOnlyCount" in text and "Recovered Shot 7 copy" in text
        assert "selected 1 node only their tab has" in text
    for text in (setup, mcp):
        assert "differs from" in text  # the handoff rule, said exactly
    assert "is safe for those nodes" not in mcp and "is safe for those nodes" not in setup
    assert "the person's own" in setup and "renumbered" in setup
